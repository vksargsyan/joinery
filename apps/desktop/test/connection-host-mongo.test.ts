import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MessageChannel } from 'node:worker_threads';

import {
  capabilitiesFor,
  connectionProfileSchema,
  type ConnectionProfileInput,
  type DriverAdapter,
  type ResolvedProfile,
  type Session,
} from '@querybara/core';
import { connectionHostContract, createClient, fromNodePort } from '@querybara/ipc';
import { toEjson } from '@querybara/mongo-tools';
import type { SshStepCheckAdapter } from '@querybara/tunnel';
import { afterEach, describe, expect, it } from 'vitest';

import { loadAdapter } from '../src/connection-host/adapters';
import { ConnectionHost } from '../src/connection-host/host';
import { pipelineWrites } from '../src/shared/mongo-writes';
import { fakeMongoAdapter, fakeMongoSession } from './fake-mongo-session';
import { profileInput } from './helpers';

/** The connection host's `mongo.*` handlers and GridFS file requests (spec §9), on a fake session. */

const channels: MessageChannel[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const channel of channels.splice(0)) {
    channel.port1.close();
    channel.port2.close();
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const ns = { db: 'shop', collection: 'orders' };
const ORDERS = [
  { _id: 1, total: 120 },
  { _id: 2, total: 80 },
  { _id: 3, total: 300 },
];

function mongoProfile(presentation: ConnectionProfileInput['presentation'] = {}): ResolvedProfile {
  return {
    profile: connectionProfileSchema.parse(
      profileInput({
        name: 'Orders',
        engine: 'mongodb',
        endpoint: { kind: 'host', host: 'localhost', port: 27017 },
        presentation,
      }),
    ),
    secrets: {},
  };
}

async function startHost(presentation: ConnectionProfileInput['presentation'] = {}) {
  const adapter = fakeMongoAdapter(ORDERS);
  const host = new ConnectionHost(adapter, mongoProfile(presentation));
  await host.start();
  const channel = new MessageChannel();
  channels.push(channel);
  host.attach(fromNodePort(channel.port2));
  const client = createClient(fromNodePort(channel.port1), connectionHostContract);
  const { sessionId } = await client.openSession({});
  return { adapter, host, client, sessionId, session: adapter.sessions[1]! };
}

describe('mongo handlers', () => {
  it('streams find pages and counts through the session', async () => {
    const { client, sessionId, session } = await startHost();
    const query = { filter: toEjson({ total: { $gt: 100 } }), sort: toEjson({ total: -1 }) };
    const pages: string[][] = [];
    for await (const page of client.mongo.find({ sessionId, ns, query, pageSize: 2 })) {
      pages.push([...page.documents]);
    }
    expect(pages.map((p) => p.length)).toEqual([2, 1]);
    expect(session.calls[0]).toMatchObject({
      method: 'find',
      args: [ns, query, { pageSize: 2, signal: expect.any(AbortSignal) }],
    });
    expect(await client.mongo.count({ sessionId, ns, filter: '{}' })).toEqual({ count: 3 });
    expect(await client.mongo.estimatedCount({ sessionId, ns })).toEqual({ count: 3 });
    expect((await client.mongo.serverInfo({ sessionId })).topology).toBe('replicaSet');
    await client.mongo.useDatabase({ sessionId, database: 'shop' });
    expect(session.currentDatabase).toBe('shop');
  });

  it('refuses destructive operations until the page confirms them', async () => {
    const { client, sessionId, session } = await startHost();
    await expect(
      client.mongo.deleteMany({ sessionId, ns, filter: '{}', dryRun: true }),
    ).resolves.toMatchObject({ dryRun: true, matchedCount: 3 });
    await expect(client.mongo.deleteMany({ sessionId, ns, filter: '{}' })).rejects.toMatchObject({
      code: 'CONFIRMATION_REQUIRED',
      message: 'Deleting documents from shop.orders needs confirmation',
    });
    await expect(
      client.mongo.updateMany({ sessionId, ns, filter: '{}', update: '{"$set":{"a":1}}' }),
    ).rejects.toMatchObject({ code: 'CONFIRMATION_REQUIRED' });
    await expect(
      client.mongo.indexes.drop({ sessionId, ns, name: 'total_1' }),
    ).rejects.toMatchObject({ code: 'CONFIRMATION_REQUIRED' });
    await expect(client.mongo.collections.drop({ sessionId, ns })).rejects.toMatchObject({
      code: 'CONFIRMATION_REQUIRED',
    });
    expect(session.calls.map((c) => c.method)).toEqual(['deleteMany']);
    await client.mongo.collections.drop({ sessionId, ns, confirmed: true });
    await client.mongo.indexes.drop({ sessionId, ns, name: 'total_1', confirmed: true });
    await expect(
      client.mongo.deleteMany({ sessionId, ns, filter: '{}', confirmed: true }),
    ).resolves.toMatchObject({ deletedCount: 3 });
    // A plain write on a development profile needs no confirmation.
    await expect(
      client.mongo.insertOne({ sessionId, ns, document: toEjson({ _id: 4 }) }),
    ).resolves.toEqual({ insertedId: '"new"' });
  });

  it('keeps a read-only profile read-only, dry runs aside', async () => {
    const { client, sessionId, session } = await startHost({ readOnly: true });
    await expect(
      client.mongo.insertOne({ sessionId, ns, document: '{}', confirmed: true }),
    ).rejects.toMatchObject({ code: 'READ_ONLY', message: expect.stringContaining('"Orders"') });
    await expect(
      client.mongo.collections.dropDatabase({ sessionId, db: 'shop', confirmed: true }),
    ).rejects.toMatchObject({ code: 'READ_ONLY' });
    await expect(
      client.mongo.updateMany({ sessionId, ns, filter: '{}', update: '{}', dryRun: true }),
    ).resolves.toMatchObject({ dryRun: true, matchedCount: 3 });
    // Reads and explains still run.
    for await (const _page of client.mongo.find({ sessionId, ns, query: {} })) break;
    await expect(
      client.mongo.explain({ sessionId, ns, target: { kind: 'find', query: {} } }),
    ).resolves.toMatchObject({ summary: { collectionScan: true } });
    expect(session.calls.map((c) => c.method)).toEqual(['updateMany', 'find', 'explainQuery']);
  });

  it('asks for every write on a production profile', async () => {
    const { client, sessionId } = await startHost({ environment: 'production' });
    await expect(client.mongo.insertOne({ sessionId, ns, document: '{}' })).rejects.toMatchObject({
      code: 'CONFIRMATION_REQUIRED',
      message:
        'Inserting a document into shop.orders needs confirmation on a production connection',
    });
    await expect(
      client.mongo.replaceOne({
        sessionId,
        ns,
        original: toEjson(ORDERS[0]),
        replacement: toEjson({ ...ORDERS[0], total: 1 }),
        confirmed: true,
      }),
    ).resolves.toMatchObject({ matchedCount: 1 });
    // A pipeline that writes ($out) is a write; one that only reads is not.
    const out = client.mongo.aggregate({
      sessionId,
      ns,
      pipeline: toEjson([{ $match: {} }, { $out: 'copy' }]),
    });
    await expect(out.next()).rejects.toMatchObject({ code: 'CONFIRMATION_REQUIRED' });
    const read = client.mongo.aggregate({ sessionId, ns, pipeline: toEjson([{ $match: {} }]) });
    expect((await read.next()).value?.documents).toHaveLength(1);
    await read.return();
  });

  it('passes a conflict through with the current document', async () => {
    const { client, sessionId } = await startHost();
    await expect(
      client.mongo.replaceOne({
        sessionId,
        ns,
        original: toEjson({ _id: 1, total: 999 }),
        replacement: toEjson({ _id: 1, total: 5 }),
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT', detail: toEjson(ORDERS[0]) });
  });

  it('reads the start of a GridFS file and says when it stopped early', async () => {
    const { client, sessionId } = await startHost();
    const read = await client.mongo.gridfs.read({
      sessionId,
      bucket: { db: 'shop', bucket: 'fs' },
      id: toEjson('f1'),
      maxBytes: 400_000,
    });
    expect(read.bytes.length).toBe(400_000);
    expect(read.truncated).toBe(true);
    expect(read.bytes[299_999]).toBe(1);
    expect(read.bytes[300_000]).toBe(2);
  });

  it('refuses MongoDB services on another engine', async () => {
    const adapter: DriverAdapter = {
      engine: 'postgres',
      capabilities: () => capabilitiesFor('postgres'),
      connect: async () => {
        // A plain session of another engine: only `engine` matters here.
        const session = fakeMongoSession();
        return Object.assign(Object.create(null) as object, session, {
          engine: 'postgres' as const,
        }) as unknown as Session;
      },
    };
    const host = new ConnectionHost(adapter, {
      profile: connectionProfileSchema.parse(profileInput()),
      secrets: {},
    });
    await host.start();
    const channel = new MessageChannel();
    channels.push(channel);
    host.attach(fromNodePort(channel.port2));
    const client = createClient(fromNodePort(channel.port1), connectionHostContract);
    const { sessionId } = await client.openSession({});
    await expect(client.mongo.count({ sessionId, ns })).rejects.toMatchObject({
      code: 'NOT_SUPPORTED',
      message: 'MongoDB services need a MongoDB connection',
    });
  });
});

describe('GridFS files by path', () => {
  function tempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'querybara-gridfs-'));
    dirs.push(dir);
    return dir;
  }

  it('uploads a file from disk and downloads one to disk with progress', async () => {
    const { host, adapter } = await startHost();
    const meta = adapter.sessions[0]!;
    const dir = tempDir();
    const source = join(dir, 'in.bin');
    writeFileSync(source, Buffer.alloc(700_000, 7));
    const progress: number[] = [];
    const uploaded = await host.request(
      {
        kind: 'gridfs-upload',
        bucket: { db: 'shop', bucket: 'fs' },
        path: source,
        filename: 'in.bin',
        contentType: 'application/octet-stream',
      },
      { signal: new AbortController().signal, progress: (p) => progress.push(p.bytes) },
    );
    expect(uploaded).toEqual({ id: '"f2"' });
    expect(meta.calls.find((c) => c.method === 'uploaded')?.args).toEqual([700_000]);
    expect(meta.calls.find((c) => c.method === 'uploadFile')?.args[2]).toMatchObject({
      filename: 'in.bin',
      contentType: 'application/octet-stream',
    });
    expect(progress.at(-1)).toBe(700_000);

    const target = join(dir, 'out.bin');
    const downloaded = await host.request(
      { kind: 'gridfs-download', bucket: { db: 'shop', bucket: 'fs' }, id: '"f1"', path: target },
      { signal: new AbortController().signal, progress: () => undefined },
    );
    expect(downloaded).toEqual({ bytes: 600_000 });
    expect(readFileSync(target).length).toBe(600_000);
  });

  it('loads the MongoDB adapter with the check that runs through a tunnel', async () => {
    const adapter = await loadAdapter('mongodb');
    expect(adapter.engine).toBe('mongodb');
    expect(typeof (adapter as Partial<SshStepCheckAdapter>).checkWithSshStep).toBe('function');
  });

  it('marks $out and $merge pipelines as writes', () => {
    expect(pipelineWrites(toEjson([{ $match: {} }, { $merge: { into: 'x' } }]))).toBe(true);
    expect(pipelineWrites(toEjson([{ $out: 'x' }, { $match: {} }]))).toBe(false);
    expect(pipelineWrites('not json')).toBe(false);
  });
});
