import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { connectionProfileSchema, type ConnectionProfileInput } from '@joinery/core';
import { openStore, type SecretSealer } from '@joinery/storage';
import { describe, expect, it, vi } from 'vitest';

import { FileGrants } from '../src/main/jobs-api';
import { mongoMainHandlers } from '../src/main/mongo-api';
import { ConnectionSupervisor } from '../src/main/supervisor';
import type { MainToHost } from '../src/shared/host-protocol';
import { SERVER_INFO, fakeHosts, profileInput, type FakeHostProcess } from './helpers';

/**
 * GridFS files moved by path (spec §9): main checks the window's file grants and the write
 * rules, then the connection's host runs the transfer and answers over the parent port.
 */

const bucket = { db: 'shop', bucket: 'fs' };

const sealer: SecretSealer = {
  id: 'test-xor',
  isAvailable: () => true,
  seal: (plain) => new TextEncoder().encode(plain).map((b) => b ^ 0x2a),
  unseal: (sealed) => new TextDecoder().decode(sealed.map((b) => b ^ 0x2a)),
};

function memoryStore() {
  return openStore(':memory:', { sealer });
}

function mongoProfile(overrides: Partial<ConnectionProfileInput> = {}) {
  return {
    profile: connectionProfileSchema.parse(
      profileInput({
        id: 'm1',
        name: 'Files',
        engine: 'mongodb',
        endpoint: { kind: 'host', host: 'localhost', port: 27017 },
        ...overrides,
      }),
    ),
    secrets: {},
  };
}

/** A host that answers `request` messages with `answer`, reporting progress first. */
function answering(answer: (message: Extract<MainToHost, { type: 'request' }>) => unknown) {
  return (process: FakeHostProcess, message: MainToHost): void => {
    if (message.type !== 'request') return;
    setImmediate(() => {
      process.emit({
        type: 'request-progress',
        requestId: message.requestId,
        progress: { bytes: 5, total: 10 },
      });
      process.emit({ type: 'response', requestId: message.requestId, result: answer(message) });
    });
  };
}

async function openConnection(
  onSend?: (process: FakeHostProcess, message: MainToHost) => void,
  overrides: Partial<ConnectionProfileInput> = {},
) {
  const hosts = fakeHosts(onSend);
  const supervisor = new ConnectionSupervisor<string>({ spawn: hosts.spawn, backoffMs: [10] });
  const opening = supervisor.open('m1', () => mongoProfile(overrides));
  await vi.waitFor(() => expect(hosts.processes).toHaveLength(1));
  hosts.processes[0]!.emit({ type: 'ready', info: { ...SERVER_INFO, engine: 'mongodb' } });
  const { connectionId } = await opening;
  const grants = new FileGrants();
  const handlers = mongoMainHandlers({ supervisor, store: memoryStore() }, grants);
  return { supervisor, hosts, connectionId, grants, handlers };
}

function context(signal = new AbortController().signal) {
  const progress: unknown[] = [];
  return { signal, progress: (value: unknown) => void progress.push(value), seen: progress };
}

describe('GridFS transfers in main', () => {
  it('uploads a picked file through the connection host, with progress', async () => {
    const { connectionId, grants, handlers, hosts } = await openConnection(
      answering(() => ({ id: '{"$oid":"650000000000000000000001"}' })),
    );
    const input = { connectionId, bucket, path: '/data/report.pdf' };
    await expect(handlers.gridfs.upload(input, context())).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      message: 'report.pdf was not chosen in a file dialog',
    });
    grants.grantRead('/data/report.pdf');
    const ctx = context();
    await expect(handlers.gridfs.upload(input, ctx)).resolves.toEqual({
      id: '{"$oid":"650000000000000000000001"}',
    });
    expect(ctx.seen).toEqual([{ bytes: 5, total: 10 }]);
    expect(hosts.processes[0]!.messagesOfType('request')[0]?.request).toEqual({
      kind: 'gridfs-upload',
      bucket,
      path: '/data/report.pdf',
      filename: 'report.pdf',
    });
  });

  it('downloads only where the save dialog pointed', async () => {
    const { connectionId, grants, handlers } = await openConnection(
      answering(() => ({ bytes: 10 })),
    );
    const input = { connectionId, bucket, id: '"f1"', path: '/tmp/out.bin' };
    await expect(handlers.gridfs.download(input, context())).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    grants.grantWrite('/tmp/out.bin');
    await expect(handlers.gridfs.download(input, context())).resolves.toEqual({ bytes: 10 });
  });

  it('applies the write rules to uploads', async () => {
    const readOnly = await openConnection(
      answering(() => ({ id: '"x"' })),
      {
        presentation: { readOnly: true },
      },
    );
    readOnly.grants.grantRead('/a.txt');
    const upload = { connectionId: readOnly.connectionId, bucket, path: '/a.txt' };
    await expect(
      readOnly.handlers.gridfs.upload({ ...upload, confirmed: true }, context()),
    ).rejects.toMatchObject({ code: 'READ_ONLY' });
    const production = await openConnection(
      answering(() => ({ id: '"x"' })),
      {
        presentation: { environment: 'production' },
      },
    );
    production.grants.grantRead('/a.txt');
    const onProduction = { ...upload, connectionId: production.connectionId };
    await expect(production.handlers.gridfs.upload(onProduction, context())).rejects.toMatchObject({
      code: 'CONFIRMATION_REQUIRED',
    });
    await expect(
      production.handlers.gridfs.upload({ ...onProduction, confirmed: true }, context()),
    ).resolves.toEqual({ id: '"x"' });
  });

  it('cancels on the host and fails when the host goes away', async () => {
    const { connectionId, grants, handlers, hosts } = await openConnection();
    grants.grantRead('/big.iso');
    const controller = new AbortController();
    const upload = handlers.gridfs.upload(
      { connectionId, bucket, path: '/big.iso' },
      context(controller.signal),
    );
    const host = hosts.processes[0]!;
    await vi.waitFor(() => expect(host.messagesOfType('request')).toHaveLength(1));
    controller.abort();
    const { requestId } = host.messagesOfType('request')[0]!;
    expect(host.messagesOfType('cancel-request')).toEqual([{ type: 'cancel-request', requestId }]);
    host.emit({
      type: 'response',
      requestId,
      error: { code: 'CANCELLED', message: 'Upload cancelled' },
    });
    await expect(upload).rejects.toMatchObject({ code: 'CANCELLED' });

    const second = handlers.gridfs.upload({ connectionId, bucket, path: '/big.iso' }, context());
    await vi.waitFor(() => expect(host.messagesOfType('request')).toHaveLength(2));
    host.exit(1);
    await expect(second).rejects.toMatchObject({ code: 'CONNECTION_FAILED' });
  });

  it('refuses a closed or non-MongoDB connection', async () => {
    const hosts = fakeHosts();
    const supervisor = new ConnectionSupervisor<string>({ spawn: hosts.spawn });
    const grants = new FileGrants();
    grants.grantRead('/a');
    const handlers = mongoMainHandlers({ supervisor, store: memoryStore() }, grants);
    await expect(
      handlers.gridfs.upload({ connectionId: 'gone', bucket, path: '/a' }, context()),
    ).rejects.toMatchObject({ code: 'CONNECTION_FAILED' });
    const opening = supervisor.open('pg', () => ({
      profile: connectionProfileSchema.parse(profileInput({ id: 'pg' })),
      secrets: {},
    }));
    await vi.waitFor(() => expect(hosts.processes).toHaveLength(1));
    hosts.processes[0]!.emit({ type: 'ready', info: SERVER_INFO });
    const { connectionId } = await opening;
    await expect(
      handlers.gridfs.upload({ connectionId, bucket, path: '/a' }, context()),
    ).rejects.toMatchObject({ code: 'NOT_SUPPORTED' });
  });
});

describe('saved pipelines and exported text in main', () => {
  function handlersWithProfile() {
    const store = memoryStore();
    store.profiles.save(
      connectionProfileSchema.parse(
        profileInput({
          id: 'm1',
          name: 'Files',
          engine: 'mongodb',
          endpoint: { kind: 'host', host: 'localhost', port: 27017 },
        }),
      ),
    );
    const supervisor = new ConnectionSupervisor<string>({ spawn: fakeHosts().spawn });
    const grants = new FileGrants();
    return { store, grants, handlers: mongoMainHandlers({ supervisor, store }, grants) };
  }

  it('keeps named pipelines per collection as saved queries', async () => {
    const { store, handlers } = handlersWithProfile();
    const orders = { profileId: 'm1', db: 'shop', collection: 'orders' };
    const saved = await handlers.pipelines.save(
      { ...orders, name: 'Open totals', text: '[{ $match: {} }]' },
      context(),
    );
    await handlers.pipelines.save(
      { ...orders, collection: 'users', name: 'Other', text: '[]' },
      context(),
    );
    expect(await handlers.pipelines.list(orders, context())).toEqual([
      { id: saved.id, name: 'Open totals', text: '[{ $match: {} }]', updatedAt: saved.updatedAt },
    ]);
    expect(store.savedQueries.get(saved.id)).toMatchObject({
      profileId: 'm1',
      database: 'shop',
      tags: ['mongodb:pipeline', 'collection:orders'],
    });
    const renamed = await handlers.pipelines.save(
      { ...orders, id: saved.id, name: 'Totals', text: '[]' },
      context(),
    );
    expect(renamed).toMatchObject({ id: saved.id, name: 'Totals', text: '[]' });
    await expect(
      handlers.pipelines.save(
        { ...orders, collection: 'users', id: saved.id, name: 'x', text: '[]' },
        context(),
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await handlers.pipelines.delete({ id: saved.id }, context());
    expect(await handlers.pipelines.list(orders, context())).toEqual([]);
  });

  it('writes exported text only where the save dialog pointed', async () => {
    const { grants, handlers } = handlersWithProfile();
    const dir = mkdtempSync(join(tmpdir(), 'joinery-mongo-'));
    try {
      const path = join(dir, 'orders.schema.json');
      await expect(handlers.writeText({ path, text: '{}' }, context())).rejects.toMatchObject({
        code: 'VALIDATION_FAILED',
      });
      grants.grantWrite(path);
      await expect(handlers.writeText({ path, text: '{ "é": 1 }' }, context())).resolves.toEqual({
        bytes: 11,
      });
      expect(readFileSync(path, 'utf8')).toBe('{ "é": 1 }');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
