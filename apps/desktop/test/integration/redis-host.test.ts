import { randomBytes } from 'node:crypto';
import { MessageChannel } from 'node:worker_threads';

import {
  connectionProfileSchema,
  type ConnectionProfileInput,
  type ResolvedProfile,
} from '@joinery/core';
import { createRedisAdapter, redisProfileFromUrl } from '@joinery/driver-redis';
import { connectionHostContract, createClient, fromNodePort, type Client } from '@joinery/ipc';
import { keySlot, utf8Text } from '@joinery/redis-tools';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ConnectionHost } from '../../src/connection-host/host';

/**
 * The connection host's Redis services against the real servers (spec §10): the key browser's
 * scan stream, value editors, key actions, bulk delete, the CLI (with cancel), Pub/Sub and the
 * server tools, on the standalone server and on the Cluster. Keys live under a random prefix
 * that is deleted afterwards.
 */

const REDIS_URL = process.env['JOINERY_TEST_REDIS_URL'];
const REDIS_CLUSTER = process.env['JOINERY_TEST_REDIS_CLUSTER'];

type HostClient = Client<(typeof connectionHostContract)['shape']>;

const channels: MessageChannel[] = [];
const hosts: ConnectionHost[] = [];

async function open(resolved: ResolvedProfile): Promise<HostClient> {
  const host = new ConnectionHost(createRedisAdapter(), resolved);
  await host.start();
  hosts.push(host);
  const channel = new MessageChannel();
  channels.push(channel);
  host.attach(fromNodePort(channel.port2));
  return createClient(fromNodePort(channel.port1), connectionHostContract);
}

afterAll(async () => {
  await Promise.all(hosts.map((h) => h.shutdown()));
  for (const channel of channels) {
    channel.port1.close();
    channel.port2.close();
  }
});

function clusterProfile(): ResolvedProfile {
  const password = decodeURIComponent(new URL(REDIS_URL ?? 'redis://x').password) || undefined;
  const now = new Date().toISOString();
  const input: ConnectionProfileInput = {
    id: 'cluster',
    name: 'Cluster',
    engine: 'redis',
    endpoint: {
      kind: 'cluster',
      seeds: REDIS_CLUSTER!.split(',').map((seed) => {
        const [host, port] = seed.trim().split(':') as [string, string];
        return { host, port: Number(port) };
      }),
    },
    auth: password ? { method: 'password', password: { id: 'password' } } : { method: 'none' },
    tls: { mode: 'disable' },
    createdAt: now,
    updatedAt: now,
  };
  return { profile: connectionProfileSchema.parse(input), secrets: password ? { password } : {} };
}

const prefix = `joinery:e2h:${randomBytes(5).toString('hex')}:`;

describe.skipIf(!REDIS_URL)('redis host services on a standalone server', () => {
  let client: HostClient;
  let sessionId: string;

  beforeAll(async () => {
    client = await open(redisProfileFromUrl(REDIS_URL!));
    ({ sessionId } = await client.openSession({ database: '0' }));
    await client.redis.command({ sessionId, args: ['SET', `${prefix}str`, 'hello'] });
    await client.redis.hash.set({
      sessionId,
      key: `${prefix}user:1`,
      entries: [
        ['name', 'Ada'],
        ['lang', 'en'],
      ],
    });
    await client.redis.zset.add({
      sessionId,
      key: `${prefix}board`,
      entries: [
        ['alice', 10],
        ['bob', 20],
      ],
    });
  });

  afterAll(async () => {
    if (!client) return;
    await client.redis.bulkDelete({ sessionId, match: `${prefix}*`, confirmed: true });
    const other = await client.openSession({ database: '1' });
    await client.redis.bulkDelete({
      sessionId: other.sessionId,
      match: `${prefix}*`,
      confirmed: true,
    });
  });

  it('describes the server and serves the command docs', async () => {
    const info = await client.redis.session({ sessionId });
    expect(info.server.clusterMode).toBe(false);
    expect(info.server.databases).toBeGreaterThan(1);
    expect(info.database).toBe(0);
    const catalog = await client.redis.commandDocs({ sessionId });
    expect(catalog.commands['SET']?.write).toBe(true);
  });

  it('pages SCAN results with their types and fetches memory for them', async () => {
    const pages = [];
    for await (const page of client.redis.scan({ sessionId, match: `${prefix}*`, pageSize: 2 })) {
      pages.push(page);
    }
    const keys = pages.flatMap((p) => p.keys);
    expect(keys.map((k) => [utf8Text(k.key), k.type]).sort()).toEqual([
      [`${prefix}board`, 'zset'],
      [`${prefix}str`, 'string'],
      [`${prefix}user:1`, 'hash'],
    ]);
    expect(pages.at(-1)?.done).toBe(true);
    const memory = await client.redis.memoryUsage({ sessionId, keys: keys.map((k) => k.key) });
    expect(memory.every((m) => typeof m === 'number' && m > 0)).toBe(true);
  });

  it('edits hashes and sorted sets, and reads strings by range', async () => {
    await client.redis.hash.set({
      sessionId,
      key: `${prefix}user:1`,
      entries: [['name', 'Grace']],
    });
    await client.redis.hash.delete({ sessionId, key: `${prefix}user:1`, fields: ['lang'] });
    const page = await client.redis.hash.scan({ sessionId, key: `${prefix}user:1` });
    expect(page.items.map((e) => [utf8Text(e.field), utf8Text(e.value)])).toEqual([
      ['name', 'Grace'],
    ]);
    await client.redis.zset.add({
      sessionId,
      key: `${prefix}board`,
      entries: [['alice', '30']],
      condition: 'xx',
    });
    const range = await client.redis.zset.range({
      sessionId,
      key: `${prefix}board`,
      options: { by: 'index', start: 0, stop: -1 },
    });
    expect(range.map((e) => [utf8Text(e.member), e.score])).toEqual([
      ['bob', 20],
      ['alice', 30],
    ]);
    const part = await client.redis.string.get({
      sessionId,
      key: `${prefix}str`,
      offset: 1,
      maxBytes: 3,
    });
    expect(part).toMatchObject({ size: 5, offset: 1, truncated: true });
    expect(utf8Text(part!.bytes)).toBe('ell');
  });

  it('sets a TTL, renames and copies to another database', async () => {
    await client.redis.key.expire({ sessionId, key: `${prefix}str`, ttlMs: 60_000 });
    const [withTtl] = await client.redis.keyInfo({ sessionId, keys: [`${prefix}str`] });
    expect(withTtl!.ttlMs).toBeGreaterThan(50_000);
    await client.redis.key.expire({ sessionId, key: `${prefix}str`, ttlMs: null });
    expect((await client.redis.keyInfo({ sessionId, keys: [`${prefix}str`] }))[0]!.ttlMs).toBe(-1);
    await expect(
      client.redis.key.rename({ sessionId, key: `${prefix}str`, newKey: `${prefix}board` }),
    ).rejects.toMatchObject({ code: 'CONFIRMATION_REQUIRED' });
    expect(
      await client.redis.key.rename({
        sessionId,
        key: `${prefix}str`,
        newKey: `${prefix}greeting`,
        onlyIfNew: true,
      }),
    ).toEqual({ renamed: true });
    const copy = await client.redis.key.copy({
      sessionId,
      key: `${prefix}greeting`,
      destination: `${prefix}copied`,
      db: 1,
    });
    expect(copy.copied).toBe(true);
    const other = await client.openSession({ database: '1' });
    const read = await client.redis.string.get({
      sessionId: other.sessionId,
      key: `${prefix}copied`,
    });
    expect(utf8Text(read!.bytes)).toBe('hello');
    await client.closeSession(other);
  });

  it('counts, then deletes by pattern with progress', async () => {
    for (let i = 0; i < 25; i++) {
      await client.redis.command({ sessionId, args: ['SET', `${prefix}tmp:${i}`, 'x'] });
    }
    const dry = await client.redis.bulkDelete({ sessionId, match: `${prefix}tmp:*`, dryRun: true });
    expect(dry).toMatchObject({ matched: 25, deleted: 0 });
    const progress: number[] = [];
    const done = await client.redis.bulkDelete(
      { sessionId, match: `${prefix}tmp:*`, batchSize: 10, confirmed: true },
      { onProgress: (p) => progress.push(p.deleted) },
    );
    expect(done.deleted).toBe(25);
    expect(progress.at(-1)).toBe(25);
  });

  it('runs CLI commands, tracks SELECT and cancels a blocking one', async () => {
    const cli = await client.openSession({});
    const selected = await client.redis.command({
      sessionId: cli.sessionId,
      args: ['SELECT', '1'],
    });
    expect(selected).toMatchObject({ reply: { type: 'status', value: 'OK' }, database: 1 });
    await expect(
      client.redis.command({ sessionId: cli.sessionId, args: ['SUBSCRIBE', 'x'] }),
    ).rejects.toMatchObject({ code: 'NOT_SUPPORTED' });
    const abort = new AbortController();
    const blocked = client.redis.command(
      { sessionId: cli.sessionId, args: ['BLPOP', `${prefix}never`, '20'] },
      { signal: abort.signal },
    );
    setTimeout(() => abort.abort(), 300);
    await expect(blocked).rejects.toMatchObject({ code: 'CANCELLED' });
    // The session came back on a new connection, still in database 1.
    await expect
      .poll(async () => {
        try {
          const r = await client.redis.command({
            sessionId: cli.sessionId,
            args: ['CLIENT', 'INFO'],
          });
          return r.reply.type === 'bulk' && /db=1/.test(utf8Text(r.reply.value));
        } catch {
          return false;
        }
      })
      .toBe(true);
    const copied = await client.redis.command({
      sessionId: cli.sessionId,
      args: ['EXISTS', `${prefix}copied`],
    });
    expect(copied.reply).toEqual({ type: 'integer', value: 1 });
  });

  it('delivers published messages to a subscription stream', async () => {
    const channel = `${prefix}news`;
    const stream = client.redis.subscribe({ sessionId, channels: [channel] });
    const first = stream.next();
    await expect
      .poll(
        async () =>
          (await client.redis.publish({ sessionId, channel, message: 'hello' })).receivers,
      )
      .toBeGreaterThan(0);
    const message = await first;
    expect(utf8Text(message.value!.channel)).toBe(channel);
    expect(utf8Text(message.value!.message)).toBe('hello');
    await stream.return();
  });

  it('serves the server tools', async () => {
    const info = await client.redis.info({ sessionId });
    expect(info['server']?.['redis_version']).toBeDefined();
    const clients = await client.redis.clients.list({ sessionId });
    expect(clients.some((c) => c.name.startsWith('Joinery'))).toBe(true);
    expect(Array.isArray(await client.redis.slowlog.get({ sessionId, count: 5 }))).toBe(true);
    expect(Array.isArray(await client.redis.latency.latest({ sessionId }))).toBe(true);
    const topology = await client.redis.topology({ sessionId });
    expect(topology.topology).toBe('standalone');
    expect(topology.nodes.some((n) => n.myself)).toBe(true);
    const report = await client.redis.bigKeys({ sessionId, match: `${prefix}*`, sampleSize: 100 });
    expect(report.sampled).toBeGreaterThan(0);
    expect(await client.redis.acl.whoAmI({ sessionId })).toEqual({ user: 'default' });
  });

  it('refuses writes on a read-only profile', async () => {
    const readOnly = await open(
      redisProfileFromUrl(REDIS_URL!, { presentation: { readOnly: true } }),
    );
    const { sessionId: ro } = await readOnly.openSession({});
    await expect(
      readOnly.redis.command({ sessionId: ro, args: ['SET', `${prefix}ro`, 'x'] }),
    ).rejects.toMatchObject({
      code: 'READ_ONLY',
    });
    const read = await readOnly.redis.command({ sessionId: ro, args: ['EXISTS', `${prefix}ro`] });
    expect(read.reply).toEqual({ type: 'integer', value: 0 });
  });
});

describe.skipIf(!REDIS_URL || !REDIS_CLUSTER)('redis host services on a Cluster', () => {
  let client: HostClient;
  let sessionId: string;

  beforeAll(async () => {
    client = await open(clusterProfile());
    ({ sessionId } = await client.openSession({}));
  });

  afterAll(async () => {
    if (client) await client.redis.bulkDelete({ sessionId, match: `${prefix}*`, confirmed: true });
  });

  it('scans every primary and names the node each command lands on', async () => {
    const topology = await client.redis.topology({ sessionId });
    const primaries = topology.nodes.filter((n) => n.role === 'primary');
    expect(primaries.length).toBeGreaterThanOrEqual(3);
    expect(topology.uncoveredSlots).toEqual([]);
    const keys = Array.from({ length: 12 }, (_, i) => `${prefix}c${i}`);
    for (const key of keys) await client.redis.command({ sessionId, args: ['SET', key, 'v'] });
    const found = [];
    for await (const page of client.redis.scan({ sessionId, match: `${prefix}*`, pageSize: 5 })) {
      found.push(...page.keys.map((k) => utf8Text(k.key)));
    }
    expect(found.sort()).toEqual([...keys].sort());
    for (const key of keys.slice(0, 4)) {
      const slot = keySlot(key);
      const owner = primaries.find((n) => n.slots.some(([a, b]) => slot >= a && slot <= b));
      const result = await client.redis.command({ sessionId, args: ['GET', key] });
      expect(result.node).toBe(owner?.address);
    }
    const nodes = await client.redis.infoAll({ sessionId });
    expect(nodes.length).toBe(primaries.length);
  });
});
