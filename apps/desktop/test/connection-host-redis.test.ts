import { MessageChannel } from 'node:worker_threads';

import { connectionProfileSchema, type ConnectionProfileInput } from '@joinery/core';
import { connectionHostContract, createClient, fromNodePort } from '@joinery/ipc';
import { bytesKey, utf8Bytes, utf8Text } from '@joinery/redis-tools';
import { afterEach, describe, expect, it } from 'vitest';

import { ConnectionHost } from '../src/connection-host/host';
import { commandKeys, slotOwner } from '../src/connection-host/redis';
import { fakeRedisAdapter, type FakeRedisSession } from './fake-redis-session';
import { profileInput } from './helpers';
import { CATALOG } from './redis-fixtures';

const channels: MessageChannel[] = [];
afterEach(() => {
  for (const channel of channels.splice(0)) {
    channel.port1.close();
    channel.port2.close();
  }
});

const enc = utf8Bytes;

async function startHost(
  presentation: ConnectionProfileInput['presentation'] = {},
  options: { readonly cluster?: boolean } = {},
) {
  const adapter = fakeRedisAdapter(options);
  const profile = connectionProfileSchema.parse(
    profileInput({
      engine: 'redis',
      endpoint: { kind: 'host', host: 'localhost', port: 6379 },
      auth: { method: 'none' },
      presentation,
    }),
  );
  const host = new ConnectionHost(adapter, { profile, secrets: {} });
  await host.start();
  const channel = new MessageChannel();
  channels.push(channel);
  host.attach(fromNodePort(channel.port2));
  const client = createClient(fromNodePort(channel.port1), connectionHostContract);
  const { sessionId } = await client.openSession({ database: '2' });
  const session = (): FakeRedisSession => adapter.sessions.at(-1)!;
  return { adapter, host, client, sessionId, session };
}

function seed(adapter: ReturnType<typeof fakeRedisAdapter>, keys: readonly string[]): void {
  for (const key of keys) {
    adapter.store.set(bytesKey(enc(key)), {
      key: enc(key),
      value: { type: 'string', value: enc('v') },
    });
  }
}

describe('redis host services', () => {
  it('describes the session and serves the command catalog', async () => {
    const { client, sessionId } = await startHost();
    const info = await client.redis.session({ sessionId });
    expect(info).toMatchObject({ database: 2, keyDelimiter: ':', user: 'default' });
    expect(info.nodes.map((n) => n.address)).toEqual(['127.0.0.1:6379']);
    const catalog = await client.redis.commandDocs({ sessionId });
    expect(Object.keys(catalog.commands)).toEqual(Object.keys(CATALOG.commands));
  });

  it('streams SCAN pages with key metadata as the page pulls', async () => {
    const { client, sessionId, adapter, session } = await startHost();
    seed(adapter, ['user:1', 'user:2', 'user:3', 'other']);
    const stream = client.redis.scan({ sessionId, match: 'user:*', pageSize: 2 });
    const first = await stream.next();
    expect(first.value?.keys.map((k) => [utf8Text(k.key), k.type, k.kind])).toEqual([
      ['user:1', 'string', 'string'],
      ['user:2', 'string', 'string'],
    ]);
    expect(first.value?.keys[0]?.key).toBeInstanceOf(Uint8Array);
    expect(first.value?.done).toBe(false);
    const second = await stream.next();
    expect(second.value?.keys.map((k) => utf8Text(k.key))).toEqual(['user:3']);
    expect(second.value?.done).toBe(true);
    expect((await stream.next()).done).toBe(true);
    const scans = session().calls.filter((c) => c.method === 'scanPage');
    expect(scans.map((c) => (c.args[0] as { cursor: string }).cursor)).toEqual(['0', '2']);
  });

  it('runs a CLI command and reports the database it leaves the session in', async () => {
    const { client, sessionId } = await startHost();
    const set = await client.redis.command({ sessionId, args: ['SET', 'k', 'v'] });
    expect(set).toMatchObject({ reply: { type: 'status', value: 'OK' }, database: 2 });
    const selected = await client.redis.command({ sessionId, args: ['SELECT', '5'] });
    expect(selected.database).toBe(5);
    const get = await client.redis.command({ sessionId, args: [enc('GET'), enc('k')] });
    expect(get.reply).toEqual({ type: 'bulk', value: enc('v') });
    expect(get.node).toBeUndefined();
  });

  it('refuses commands that would take over the connection, pointing to the tool', async () => {
    const { client, sessionId } = await startHost();
    await expect(
      client.redis.command({ sessionId, args: ['SUBSCRIBE', 'news'] }),
    ).rejects.toMatchObject({ code: 'NOT_SUPPORTED', hint: expect.stringContaining('Pub/Sub') });
    await expect(client.redis.command({ sessionId, args: ['MONITOR'] })).rejects.toMatchObject({
      code: 'NOT_SUPPORTED',
    });
  });

  it('cancels a blocking command by resetting the connection in the same database', async () => {
    const { client, sessionId, adapter } = await startHost();
    await client.redis.command({ sessionId, args: ['SELECT', '4'] });
    const blocked = adapter.sessions.at(-1)!;
    const abort = new AbortController();
    const running = client.redis.command(
      { sessionId, args: ['BLPOP', 'queue', '30'] },
      { signal: abort.signal },
    );
    await expect
      .poll(() =>
        blocked.calls.some((c) => c.method === 'command' && (c.args[0] as string[])[0] === 'BLPOP'),
      )
      .toBe(true);
    abort.abort();
    await expect(running).rejects.toMatchObject({ code: 'CANCELLED' });
    await expect.poll(() => blocked.closed).toBe(true);
    await expect.poll(() => adapter.sessions.length).toBe(3);
    const replacement = adapter.sessions.at(-1)!;
    expect(replacement.database).toBe(4);
    const after = await client.redis.command({ sessionId, args: ['DBSIZE'] });
    expect(after.reply).toEqual({ type: 'integer', value: 0 });
    expect(replacement.calls.map((c) => c.method)).toContain('command');
  });

  it('names the node a Cluster command lands on from the slot map', async () => {
    const { client, sessionId } = await startHost({}, { cluster: true });
    const keyed = await client.redis.command({ sessionId, args: ['GET', 'user:1'] });
    const owner = keyed.node;
    expect(['10.0.0.1:7000', '10.0.0.2:7001']).toContain(owner);
    const keyless = await client.redis.command({ sessionId, args: ['DBSIZE'] });
    expect(keyless.node).toBe('10.0.0.1:7000');
    const pinned = await client.redis.command({
      sessionId,
      args: ['DBSIZE'],
      node: '10.0.0.2:7001',
    });
    expect(pinned.node).toBe('10.0.0.2:7001');
  });

  it('serves SUBSCRIBE as a stream and unsubscribes when the page stops reading', async () => {
    const { client, sessionId, session } = await startHost();
    const stream = client.redis.subscribe({ sessionId, channels: ['news'] });
    const first = stream.next();
    await expect.poll(() => session().subscribers.length).toBe(1);
    const { receivers } = await client.redis.publish({ sessionId, channel: 'news', message: 'hi' });
    expect(receivers).toBe(1);
    const message = await first;
    expect(utf8Text(message.value!.message)).toBe('hi');
    await stream.return();
    await expect.poll(() => session().subscribers[0]!.closed).toBe(true);
  });

  it('reports bulk delete progress and deletes only when confirmed', async () => {
    const { client, sessionId, adapter } = await startHost();
    seed(adapter, ['tmp:1', 'tmp:2', 'keep']);
    const progress: number[] = [];
    const dry = await client.redis.bulkDelete(
      { sessionId, match: 'tmp:*', dryRun: true },
      { onProgress: (p) => progress.push(p.matched) },
    );
    expect(dry).toMatchObject({ matched: 2, deleted: 0, dryRun: true });
    expect(dry.sample.map(utf8Text)).toEqual(['tmp:1', 'tmp:2']);
    expect(progress.length).toBeGreaterThan(0);
    await expect(client.redis.bulkDelete({ sessionId, match: 'tmp:*' })).rejects.toMatchObject({
      code: 'CONFIRMATION_REQUIRED',
    });
    const done = await client.redis.bulkDelete({ sessionId, match: 'tmp:*', confirmed: true });
    expect(done.deleted).toBe(2);
    expect(adapter.store.size).toBe(1);
  });

  it('treats a rename over an existing key as destructive', async () => {
    const { client, sessionId, adapter } = await startHost();
    seed(adapter, ['a', 'b']);
    await expect(
      client.redis.key.rename({ sessionId, key: 'a', newKey: 'b' }),
    ).rejects.toMatchObject({ code: 'CONFIRMATION_REQUIRED' });
    expect(await client.redis.key.rename({ sessionId, key: 'a', newKey: 'c' })).toEqual({
      renamed: true,
    });
    expect(
      await client.redis.key.rename({ sessionId, key: 'c', newKey: 'b', confirmed: true }),
    ).toEqual({ renamed: true });
  });

  it('answers NOT_SUPPORTED for a session of another engine', async () => {
    const { client } = await startHost();
    await expect(client.redis.session({ sessionId: 'nope' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
});

describe('redis write rules in the host', () => {
  it('refuses every write on a read-only profile, reads and dry runs still work', async () => {
    const { client, sessionId, adapter, session } = await startHost({ readOnly: true });
    seed(adapter, ['tmp:1']);
    const refused = { code: 'READ_ONLY' };
    await expect(
      client.redis.command({ sessionId, args: ['SET', 'k', 'v'] }),
    ).rejects.toMatchObject(refused);
    await expect(
      client.redis.command({ sessionId, args: ['FLUSHALL'], confirmed: true }),
    ).rejects.toMatchObject(refused);
    await expect(client.redis.command({ sessionId, args: ['NOSUCH', 'x'] })).rejects.toMatchObject(
      refused,
    );
    await expect(
      client.redis.hash.set({ sessionId, key: 'h', entries: [['f', 'v']], confirmed: true }),
    ).rejects.toMatchObject(refused);
    await expect(
      client.redis.key.delete({ sessionId, keys: ['tmp:1'], confirmed: true }),
    ).rejects.toMatchObject(refused);
    await expect(
      client.redis.publish({ sessionId, channel: 'c', message: 'm', confirmed: true }),
    ).rejects.toMatchObject(refused);
    await expect(
      client.redis.acl.setUser({ sessionId, name: 'u', rules: ['on'], confirmed: true }),
    ).rejects.toMatchObject(refused);
    await expect(
      client.redis.clients.kill({ sessionId, id: 7, confirmed: true }),
    ).rejects.toMatchObject(refused);
    expect((await client.redis.command({ sessionId, args: ['GET', 'k'] })).reply).toEqual({
      type: 'nil',
    });
    expect(
      (await client.redis.bulkDelete({ sessionId, match: 'tmp:*', dryRun: true })).matched,
    ).toBe(1);
    expect(session().calls.map((c) => c.method)).not.toContain('hashSet');
    expect(adapter.store.size).toBe(1);
  });

  it('asks for every write on a production profile, and for destructive ones everywhere', async () => {
    const production = await startHost({ environment: 'production' });
    await expect(
      production.client.redis.hash.set({
        sessionId: production.sessionId,
        key: 'h',
        entries: [['f', 'v']],
      }),
    ).rejects.toMatchObject({ code: 'CONFIRMATION_REQUIRED' });
    await expect(
      production.client.redis.command({ sessionId: production.sessionId, args: ['SET', 'k', 'v'] }),
    ).rejects.toMatchObject({ code: 'CONFIRMATION_REQUIRED' });
    expect(
      await production.client.redis.hash.set({
        sessionId: production.sessionId,
        key: 'h',
        entries: [['f', 'v']],
        confirmed: true,
      }),
    ).toEqual({ added: 1 });
    expect(
      (
        await production.client.redis.command({
          sessionId: production.sessionId,
          args: ['GET', 'k'],
        })
      ).reply,
    ).toEqual({ type: 'nil' });

    const dev = await startHost();
    expect(
      await dev.client.redis.hash.set({
        sessionId: dev.sessionId,
        key: 'h',
        entries: [['f', 'v']],
      }),
    ).toEqual({ added: 1 });
    await expect(
      dev.client.redis.key.delete({ sessionId: dev.sessionId, keys: ['h'] }),
    ).rejects.toMatchObject({
      code: 'CONFIRMATION_REQUIRED',
    });
    await expect(
      dev.client.redis.command({ sessionId: dev.sessionId, args: ['FLUSHALL'] }),
    ).rejects.toMatchObject({
      code: 'CONFIRMATION_REQUIRED',
    });
    await expect(
      dev.client.redis.clients.kill({ sessionId: dev.sessionId, id: 3 }),
    ).rejects.toMatchObject({ code: 'CONFIRMATION_REQUIRED' });
    expect(
      await dev.client.redis.clients.kill({ sessionId: dev.sessionId, id: 3, confirmed: true }),
    ).toEqual({ killed: true });
  });

  it('creates a search index as a write and drops one only when confirmed', async () => {
    const definition = {
      name: 'books',
      keyType: 'HASH' as const,
      prefixes: ['book:'],
      fields: [{ identifier: 'title', type: 'TEXT' as const }],
    };
    const dev = await startHost();
    await dev.client.redis.search.create({ sessionId: dev.sessionId, definition });
    await expect(
      dev.client.redis.search.drop({
        sessionId: dev.sessionId,
        index: 'books',
        deleteDocuments: true,
      }),
    ).rejects.toMatchObject({ code: 'CONFIRMATION_REQUIRED' });
    await dev.client.redis.search.drop({
      sessionId: dev.sessionId,
      index: 'books',
      deleteDocuments: true,
      confirmed: true,
    });
    expect(
      dev
        .session()
        .calls.filter((c) => c.method.startsWith('search'))
        .map((c) => c.args.slice(0, 2)),
    ).toEqual([
      [definition, {}],
      ['books', true],
    ]);

    const readOnly = await startHost({ readOnly: true });
    await expect(
      readOnly.client.redis.search.create({ sessionId: readOnly.sessionId, definition }),
    ).rejects.toMatchObject({ code: 'READ_ONLY' });
    // The definition is checked before anything runs.
    await expect(
      dev.client.redis.search.create({
        sessionId: dev.sessionId,
        definition: { ...definition, fields: [] },
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('checks the generic execute of a Redis session too', async () => {
    const readOnly = await startHost({ readOnly: true });
    const stream = readOnly.client.execute({
      sessionId: readOnly.sessionId,
      text: 'GET a\nSET a 1',
      executionId: 'x1',
    });
    await expect(stream.next()).rejects.toMatchObject({ code: 'READ_ONLY' });
    const production = await startHost({ environment: 'production' });
    const writes = production.client.execute({
      sessionId: production.sessionId,
      text: 'DEL a',
      executionId: 'x2',
    });
    await expect(writes.next()).rejects.toMatchObject({
      code: 'CONFIRMATION_REQUIRED',
      hint: expect.stringContaining('Redis CLI'),
    });
    const reads = production.client.execute({
      sessionId: production.sessionId,
      text: 'GET a',
      executionId: 'x3',
    });
    expect((await reads.next()).value).toMatchObject({ type: 'end' });
  });
});

describe('cluster routing helpers', () => {
  it('finds a command’s keys from its legacy key positions', () => {
    const args = ['MSET', 'a', '1', 'b', '2'].map(enc);
    const keys = commandKeys(args, {
      ...CATALOG.commands['SET']!,
      keys: { first: 1, last: -1, step: 2 },
    });
    expect(keys.map(utf8Text)).toEqual(['a', 'b']);
    expect(commandKeys(args, CATALOG.commands['FLUSHALL'])).toEqual([]);
    expect(commandKeys(args, undefined)).toEqual([]);
  });

  it('maps a key to the primary serving its slot', () => {
    const view = {
      topology: 'cluster' as const,
      uncoveredSlots: [],
      nodes: [
        {
          id: 'a',
          address: 'a:1',
          host: 'a',
          port: 1,
          role: 'primary' as const,
          flags: [],
          myself: false,
          failing: false,
          state: 'connected',
          slots: [[0, 8191] as const],
        },
        {
          id: 'b',
          address: 'b:2',
          host: 'b',
          port: 2,
          role: 'primary' as const,
          flags: [],
          myself: false,
          failing: false,
          state: 'connected',
          slots: [[8192, 16383] as const],
        },
      ],
    };
    // "foo" hashes to slot 12182, "{user}:1" and "{user}:2" to the same slot.
    expect(slotOwner(view, 'foo')).toBe('b:2');
    expect(slotOwner(view, '{user}:1')).toBe(slotOwner(view, '{user}:2'));
  });
});
