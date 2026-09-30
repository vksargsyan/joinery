import { randomBytes } from 'node:crypto';

import type { RedisSession } from '@joinery/driver-redis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { planDbTransfer, runDbTransfer, type DbTransferSpec } from '../../src';
import { REDIS_CLUSTER, REDIS_URL, connectCluster, connectRedis, opener } from './db-helpers';

/**
 * Redis → Redis with DUMP and RESTORE against the real servers (spec §12): every value type,
 * time to live kept, existing keys skipped or replaced, overlapping patterns copied once, and
 * standalone ↔ Cluster with per-slot routing. Keys live under a random prefix and are deleted
 * afterwards; nothing is flushed.
 */

const text = (bytes: Uint8Array | null | undefined): string | null =>
  bytes == null ? null : new TextDecoder().decode(bytes);

async function keysUnder(session: RedisSession, prefix: string): Promise<string[]> {
  const found: string[] = [];
  let cursor = '0';
  for (;;) {
    const step = await session.scan({ cursor, match: `${prefix}*`, count: 1000 });
    found.push(...step.keys.map((k) => text(k)!));
    cursor = step.cursor;
    if (step.done) break;
  }
  return found.sort();
}

async function cleanup(session: RedisSession | undefined, prefix: string): Promise<void> {
  if (session === undefined) return;
  const keys = await keysUnder(session, prefix);
  if (keys.length > 0) await session.deleteKeys(keys);
}

async function seed(session: RedisSession, prefix: string): Promise<void> {
  await session.createKey(`${prefix}str`, { type: 'string', value: 'Grüße 😀' }, { ttlMs: 60_000 });
  await session.createKey(`${prefix}bin`, { type: 'string', value: Uint8Array.from([0, 255, 10]) });
  await session.createKey(
    `${prefix}hash`,
    {
      type: 'hash',
      entries: [
        ['f', 'v'],
        ['n', '1'],
      ],
    },
    { ttlMs: 120_000 },
  );
  await session.createKey(`${prefix}list`, { type: 'list', items: ['a', 'b', 'c'] });
  await session.createKey(`${prefix}set`, { type: 'set', members: ['x', 'y'] });
  await session.createKey(`${prefix}zset`, {
    type: 'zset',
    entries: [
      ['m', 1.5],
      ['n', '-inf'],
    ],
  });
  await session.createKey(`${prefix}stream`, { type: 'stream', fields: [['k', 'v']] });
  for (let i = 0; i < 250; i++) await session.setString(`${prefix}many:${i}`, String(i));
}

type Reply = Awaited<ReturnType<RedisSession['command']>>;

/** A reply as plain data; set members sorted, since servers may store them in another order. */
function plain(reply: Reply, sort = false): unknown {
  switch (reply.type) {
    case 'bulk':
    case 'verbatim':
      return Buffer.from(reply.value).toString('hex');
    case 'array':
    case 'set':
    case 'push': {
      const items = reply.items.map((item) => plain(item));
      return sort ? items.map((item) => JSON.stringify(item)).sort() : items;
    }
    case 'map':
      return reply.entries.map(([k, v]) => [plain(k), plain(v)]);
    case 'nil':
      return null;
    default:
      return String(reply.value);
  }
}

/** A key's type and value, read the way each type reads. */
async function valueOf(session: RedisSession, key: string): Promise<unknown> {
  const type = plain(await session.command(['TYPE', key]));
  const read: Record<string, [string[], boolean]> = {
    string: [['GET', key], false],
    hash: [['HGETALL', key], true],
    list: [['LRANGE', key, '0', '-1'], false],
    set: [['SMEMBERS', key], true],
    zset: [['ZRANGE', key, '0', '-1', 'WITHSCORES'], false],
    stream: [['XRANGE', key, '-', '+'], false],
  };
  const [args, sort] = read[String(type)] ?? [['TYPE', key], false];
  return [type, plain(await session.command(args), sort)];
}

async function expectCopied(from: RedisSession, to: RedisSession, prefix: string): Promise<void> {
  const keys = await keysUnder(from, prefix);
  expect(await keysUnder(to, prefix)).toEqual(keys);
  const source = await from.keyInfo(keys);
  const copied = await to.keyInfo(keys);
  for (const [i, key] of keys.entries()) {
    expect(await valueOf(to, key)).toEqual(await valueOf(from, key));
    // The same time to live, give or take the time the copy took.
    if (source[i]!.ttlMs < 0) expect(copied[i]!.ttlMs).toBe(-1);
    else expect(Math.abs(copied[i]!.ttlMs - source[i]!.ttlMs)).toBeLessThan(10_000);
  }
}

function spec(patterns: string[], options: DbTransferSpec['options'] = {}): DbTransferSpec {
  return {
    source: {},
    target: {},
    objects: [],
    keyPatterns: patterns,
    options: { batchSize: 100, ...options },
  };
}

describe.skipIf(!REDIS_URL)('Redis → Redis', () => {
  const prefix = `jdt:${randomBytes(4).toString('hex')}:`;
  let db0: RedisSession;
  let db5: RedisSession;

  beforeAll(async () => {
    db0 = (await connectRedis(0)) as RedisSession;
    db5 = (await connectRedis(5)) as RedisSession;
    await seed(db0, prefix);
  });

  afterAll(async () => {
    await cleanup(db0, prefix);
    await cleanup(db5, prefix);
    await db0?.close();
    await db5?.close();
  });

  it('plans the patterns and says what REPLACE overwrites', async () => {
    const plan = await planDbTransfer({
      spec: spec([`${prefix}*`], { replace: true }),
      source: db0,
      target: db5,
    });
    expect(plan.problems).toEqual([]);
    expect(plan.tables).toEqual([
      expect.objectContaining({ source: `${prefix}*`, target: 'database 5', kind: 'keys' }),
    ]);
    expect(plan.destructive[0]).toMatch(/overwritten/);
    const same = await planDbTransfer({
      spec: spec(['*']),
      source: db0,
      target: db0,
      sameConnection: true,
    });
    expect(same.problems).toContain('The source and the target are the same database');
  });

  it('copies every type with its time to live into another database', async () => {
    const summary = await runDbTransfer({
      spec: spec([`${prefix}*`]),
      source: opener(() => connectRedis(0)),
      target: opener(() => connectRedis(5)),
    });
    expect(summary.errors).toEqual([]);
    expect(summary.status).toBe('completed');
    expect(summary.rowsWritten).toBe(257);
    await expectCopied(db0, db5, prefix);
    const [str] = await db5.keyInfo([`${prefix}str`]);
    expect(str!.ttlMs).toBeGreaterThan(50_000);
    expect(text((await db5.getString(`${prefix}str`))?.bytes)).toBe('Grüße 😀');
  });

  it('skips keys that exist unless REPLACE, and copies overlapping patterns once', async () => {
    await db5.setString(`${prefix}str`, 'changed');
    const kept = await runDbTransfer({
      spec: spec([`${prefix}s*`, `${prefix}*`]),
      source: opener(() => connectRedis(0)),
      target: opener(() => connectRedis(5)),
    });
    expect(kept.status).toBe('completed');
    expect(kept.errors).toEqual([]);
    expect(kept.rowsRead).toBe(257);
    expect(kept.rowsSkipped).toBe(257);
    expect(text((await db5.getString(`${prefix}str`))?.bytes)).toBe('changed');
    const replaced = await runDbTransfer({
      spec: spec([`${prefix}str`], { replace: true, keepTtl: false }),
      source: opener(() => connectRedis(0)),
      target: opener(() => connectRedis(5)),
    });
    expect(replaced.rowsWritten).toBe(1);
    expect(text((await db5.getString(`${prefix}str`))?.bytes)).toBe('Grüße 😀');
    const [str] = await db5.keyInfo([`${prefix}str`]);
    expect(str!.ttlMs).toBe(-1);
  });

  describe.skipIf(!REDIS_CLUSTER)('with Redis Cluster', () => {
    let cluster: RedisSession;
    let db6: RedisSession;

    beforeAll(async () => {
      cluster = (await connectCluster()) as RedisSession;
      db6 = (await connectRedis(6)) as RedisSession;
    });
    afterAll(async () => {
      await cleanup(cluster, prefix);
      await cleanup(db6, prefix);
      await cluster?.close();
      await db6?.close();
    });

    it('copies into the cluster, each key to its slot, and back out of it', async () => {
      const into = await runDbTransfer({
        spec: spec([`${prefix}*`], { parallel: 3 }),
        source: opener(() => connectRedis(0)),
        target: opener(connectCluster),
      });
      expect(into.errors).toEqual([]);
      expect(into.status).toBe('completed');
      await expectCopied(db0, cluster, prefix);
      const primaries = cluster.nodes().length;
      expect(primaries).toBeGreaterThan(1);

      const out = await runDbTransfer({
        spec: spec([`${prefix}*`]),
        source: opener(connectCluster),
        target: opener(() => connectRedis(6)),
      });
      expect(out.errors).toEqual([]);
      expect(out.rowsWritten).toBe(257);
      await expectCopied(cluster, db6, prefix);
    });
  });
});
