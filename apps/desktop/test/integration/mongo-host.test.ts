import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MessageChannel } from 'node:worker_threads';

import {
  QuerybaraError,
  connectionProfileSchema,
  newId,
  type ConnectionProfileInput,
  type ResolvedProfile,
} from '@querybara/core';
import { connectionHostContract, createClient, fromNodePort, type Client } from '@querybara/ipc';
import { fromEjson, toEjson, type BsonDocument } from '@querybara/mongo-tools';
import { parseConnectionUri } from '@querybara/storage';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadAdapter } from '../../src/connection-host/adapters';
import { ConnectionHost } from '../../src/connection-host/host';

/**
 * The connection host's `mongo.*` services against the real replica set (spec §9): the adapter
 * the app loads, a profile parsed from the test URI as "Fill from URI" does, and the renderer's
 * RPC client on a port. One database per run, dropped afterwards.
 */

const MONGO_URL = process.env['QUERYBARA_TEST_MONGODB_URL'];
const DB = `querybara_host_${randomBytes(4).toString('hex')}`;
const ns = { db: DB, collection: 'orders' };

type HostClient = Client<(typeof connectionHostContract)['shape']>;

function resolvedFromUrl(
  presentation: ConnectionProfileInput['presentation'] = {},
): ResolvedProfile {
  const url = new URL(MONGO_URL!);
  url.searchParams.set('tls', 'false');
  const parsed = parseConnectionUri(url.toString());
  const now = new Date().toISOString();
  const profile = connectionProfileSchema.parse({
    ...parsed.profile,
    id: newId(),
    presentation,
    createdAt: now,
    updatedAt: now,
  });
  const ref = profile.auth.method === 'password' ? profile.auth.password : undefined;
  return {
    profile,
    secrets: ref && parsed.password !== undefined ? { [ref.id]: parsed.password } : {},
  };
}

const hosts: ConnectionHost[] = [];
const channels: MessageChannel[] = [];

async function start(
  presentation: ConnectionProfileInput['presentation'] = {},
): Promise<{ host: ConnectionHost; client: HostClient; sessionId: string }> {
  const resolved = resolvedFromUrl(presentation);
  const host = new ConnectionHost(await loadAdapter('mongodb'), resolved);
  await host.start();
  hosts.push(host);
  const channel = new MessageChannel();
  channels.push(channel);
  host.attach(fromNodePort(channel.port2));
  const client = createClient(fromNodePort(channel.port1), connectionHostContract);
  const { sessionId } = await client.openSession({ database: DB });
  return { host, client, sessionId };
}

async function documents(
  client: HostClient,
  sessionId: string,
  filter = '{}',
): Promise<BsonDocument[]> {
  const out: BsonDocument[] = [];
  for await (const page of client.mongo.find({
    sessionId,
    ns,
    query: { filter, sort: '{"_id":1}' },
  })) {
    for (const doc of page.documents) out.push(fromEjson(doc) as BsonDocument);
  }
  return out;
}

let main: Awaited<ReturnType<typeof start>>;
const dirs: string[] = [];

beforeAll(async () => {
  if (!MONGO_URL) return;
  main = await start();
  await main.client.mongo.insertMany({
    sessionId: main.sessionId,
    ns,
    documents: toEjson(
      Array.from({ length: 250 }, (_, i) => ({
        _id: i + 1,
        status: i % 2 === 0 ? 'open' : 'shipped',
        total: i * 3,
        items: [{ sku: `s${i}`, qty: 1 }],
      })),
    ),
  });
});

afterAll(async () => {
  if (main) {
    await main.client.mongo.collections
      .dropDatabase({ sessionId: main.sessionId, db: DB, confirmed: true })
      .catch(() => undefined);
  }
  for (const channel of channels) {
    channel.port1.close();
    channel.port2.close();
  }
  await Promise.all(hosts.map((host) => host.shutdown()));
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(!MONGO_URL)('mongo services through the connection host', () => {
  it('pages a find, counts, and reports the server', async () => {
    const { client, sessionId } = main;
    const pages: number[] = [];
    for await (const page of client.mongo.find({
      sessionId,
      ns,
      query: { filter: toEjson({ status: 'open' }), sort: toEjson({ total: -1 }) },
      pageSize: 50,
    })) {
      pages.push(page.documents.length);
    }
    expect(pages).toEqual([50, 50, 25]);
    expect(
      await client.mongo.count({ sessionId, ns, filter: toEjson({ status: 'open' }) }),
    ).toEqual({ count: 125 });
    expect((await client.mongo.estimatedCount({ sessionId, ns })).count).toBe(250);
    const info = await client.mongo.serverInfo({ sessionId });
    expect(info).toMatchObject({ topology: 'replicaSet', setName: 'rs0' });
  });

  it('replaces optimistically and reports a conflict with the current document', async () => {
    const { client, sessionId } = main;
    const [first] = await documents(client, sessionId, toEjson({ _id: 1 }));
    const original = toEjson(first);
    await client.mongo.replaceOne({
      sessionId,
      ns,
      original,
      replacement: toEjson({ ...first, note: 'mine' }),
    });
    // The page still holds the old version: someone else's change wins until it reloads.
    await expect(
      client.mongo.replaceOne({
        sessionId,
        ns,
        original,
        replacement: toEjson({ ...first, note: 'late' }),
      }),
    ).rejects.toMatchObject({
      code: 'CONFLICT',
      detail: expect.stringContaining('"note":"mine"'),
    });
  });

  it('counts a bulk update first, then runs it once confirmed', async () => {
    const { client, sessionId } = main;
    const input = {
      sessionId,
      ns,
      filter: toEjson({ status: 'shipped' }),
      update: toEjson({ $set: { flagged: true } }),
    };
    await expect(client.mongo.updateMany({ ...input, dryRun: true })).resolves.toMatchObject({
      dryRun: true,
      matchedCount: 125,
      modifiedCount: 0,
    });
    await expect(client.mongo.updateMany(input)).rejects.toMatchObject({
      code: 'CONFIRMATION_REQUIRED',
    });
    await expect(client.mongo.updateMany({ ...input, confirmed: true })).resolves.toMatchObject({
      modifiedCount: 125,
    });
  });

  it('explains a collection scan, then an index scan once the index exists', async () => {
    const { client, sessionId } = main;
    const target = { kind: 'find' as const, query: { filter: toEjson({ total: { $gt: 600 } }) } };
    const scan = await client.mongo.explain({ sessionId, ns, target, verbosity: 'executionStats' });
    expect(scan.summary.collectionScan).toBe(true);
    const { name } = await client.mongo.indexes.create({
      sessionId,
      ns,
      spec: { keys: toEjson({ total: 1 }) },
    });
    const indexed = await client.mongo.explain({
      sessionId,
      ns,
      target,
      verbosity: 'executionStats',
    });
    expect(indexed.summary).toMatchObject({ collectionScan: false, indexes: [name] });
    expect((await client.mongo.indexes.list({ sessionId, ns })).map((i) => i.name)).toContain(name);
    await expect(client.mongo.indexes.drop({ sessionId, ns, name })).rejects.toMatchObject({
      code: 'CONFIRMATION_REQUIRED',
    });
    await client.mongo.indexes.drop({ sessionId, ns, name, confirmed: true });
  });

  it('analyses the schema, tails a change stream and describes the collection', async () => {
    const { client, sessionId } = main;
    const schema = await client.mongo.analyzeSchema({ sessionId, ns, options: { sampleSize: 50 } });
    expect(schema.fields.map((f) => f.name)).toEqual(
      expect.arrayContaining(['_id', 'status', 'items']),
    );
    const stream = client.mongo.watch({ sessionId, scope: { kind: 'collection', ns } });
    const next = stream.next();
    await new Promise((resolve) => setTimeout(resolve, 500));
    await client.mongo.insertOne({
      sessionId,
      ns,
      document: toEjson({ _id: 1000, status: 'new' }),
    });
    const event = await next;
    expect(event.value).toMatchObject({
      operationType: 'insert',
      documentKey: expect.stringContaining('1000'),
    });
    await stream.return();
    const info = await client.mongo.collections.info({ sessionId, ns });
    expect(info).toMatchObject({ name: 'orders', type: 'collection' });
    expect((await client.mongo.users.list({ sessionId, db: 'admin' })).length).toBeGreaterThan(0);
    expect((await client.mongo.admin.serverStatus({ sessionId })).version).toMatch(/^\d+\./);
  });

  it('moves GridFS files by path and reads a preview', async () => {
    const { client, sessionId, host } = main;
    const dir = mkdtempSync(join(tmpdir(), 'querybara-gridfs-it-'));
    dirs.push(dir);
    const source = join(dir, 'report.bin');
    const bytes = Buffer.alloc(600_000);
    for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251;
    writeFileSync(source, bytes);
    const bucket = { db: DB, bucket: 'fs' };
    const progress: number[] = [];
    const uploaded = (await host.request(
      { kind: 'gridfs-upload', bucket, path: source, filename: 'report.bin' },
      { signal: new AbortController().signal, progress: (p) => progress.push(p.bytes) },
    )) as { id: string };
    expect(progress.at(-1)).toBe(600_000);
    expect(await client.mongo.gridfs.buckets({ sessionId, db: DB })).toEqual(['fs']);
    const files = [];
    for await (const page of client.mongo.gridfs.list({ sessionId, bucket }))
      files.push(...page.files);
    expect(files).toMatchObject([{ id: uploaded.id, filename: 'report.bin', length: 600_000 }]);
    const preview = await client.mongo.gridfs.read({
      sessionId,
      bucket,
      id: uploaded.id,
      maxBytes: 1000,
    });
    expect(preview.truncated).toBe(true);
    expect(Buffer.from(preview.bytes).equals(bytes.subarray(0, 1000))).toBe(true);
    const target = join(dir, 'copy.bin');
    await host.request(
      { kind: 'gridfs-download', bucket, id: uploaded.id, path: target },
      { signal: new AbortController().signal, progress: () => undefined },
    );
    expect(readFileSync(target).equals(bytes)).toBe(true);
    await client.mongo.gridfs.delete({ sessionId, bucket, id: uploaded.id, confirmed: true });
  });

  it('reports the validator rules a document breaks, with their fields', async () => {
    const { client, sessionId } = main;
    const people = { db: DB, collection: 'people' };
    await client.mongo.collections.create({
      sessionId,
      ns: people,
      spec: {
        validator: toEjson({
          $jsonSchema: {
            required: ['name', 'email'],
            properties: { name: { bsonType: 'string' }, age: { bsonType: 'int', minimum: 0 } },
          },
        }),
      },
    });
    const refused = client.mongo.insertOne({
      sessionId,
      ns: people,
      document: toEjson({ name: 42, age: -1 }),
    });
    await expect(refused).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      message: expect.stringContaining('Document failed validation'),
    });
    const failure: unknown = await refused.then(
      () => undefined,
      (error: unknown) => error,
    );
    const detail = failure instanceof QuerybaraError ? (failure.detail ?? '') : '';
    expect(detail).toContain('name');
    expect(detail).toContain('email');
  });

  it('keeps a read-only profile read-only', async () => {
    const { client, sessionId } = await start({ readOnly: true });
    await expect(
      client.mongo.insertOne({ sessionId, ns, document: toEjson({ _id: 5000 }), confirmed: true }),
    ).rejects.toMatchObject({ code: 'READ_ONLY' });
    await expect(
      client.mongo.deleteMany({ sessionId, ns, filter: '{}', dryRun: true }),
    ).resolves.toMatchObject({ dryRun: true });
    expect((await client.mongo.count({ sessionId, ns })).count).toBeGreaterThan(0);
  });
});
