import { randomBytes } from 'node:crypto';
import { join } from 'node:path';

import type { RedisSession } from '@querybara/driver-redis';
import { fileSink } from '@querybara/transfer';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ArchiveReader, backupRedis, planRedisRestore, restoreRedisArchive } from '../../src';
import { connectRedis, tempDir } from './helpers';

/**
 * Redis round trips (spec §14): keys of every type (binary names included) with and without
 * TTLs, backed up by pattern as DUMP payloads and restored into another database of a
 * standalone server and back into a Cluster: same payloads, TTLs kept, existing keys kept or
 * replaced (after confirmation).
 */

const URL = process.env['QUERYBARA_TEST_REDIS_URL'];
const CLUSTER = process.env['QUERYBARA_TEST_REDIS_CLUSTER'];
const FAST = { log2N: 10, r: 8, p: 1 };

const bytes = (text: string): Uint8Array => Buffer.from(text, 'utf8');

async function seed(session: RedisSession, prefix: string): Promise<Uint8Array[]> {
  const key = (suffix: string | Uint8Array): Uint8Array =>
    Buffer.concat([Buffer.from(prefix), Buffer.from(suffix)]);
  const run = (...args: (string | Uint8Array)[]) =>
    session.command(args.map((a) => (typeof a === 'string' ? bytes(a) : a)));
  const binary = key(Uint8Array.from([0xff, 0x00, 0x80]));
  await run('SET', key('string'), 'hello');
  await run('SET', key('ttl'), 'soon', 'PX', '3600000');
  await run('SET', binary, Uint8Array.from([0, 1, 2, 255]));
  await run('HSET', key('hash'), 'a', '1', 'b', 'Grüße');
  await run('PEXPIRE', key('hash'), '7200000');
  await run('RPUSH', key('list'), 'x', 'y', 'z');
  await run('SADD', key('set'), 'm1', 'm2');
  await run('ZADD', key('zset'), '1.5', 'a', '-2', 'b');
  await run('XADD', key('stream'), '1-1', 'f', 'v');
  await run('XGROUP', 'CREATE', key('stream'), 'g1', '0');
  const bulk = Array.from({ length: 1200 }, (_, i) => key(`bulk:${i}`));
  for (const [i, k] of bulk.entries()) await run('SET', k, String(i));
  return [...['string', 'ttl', 'hash', 'list', 'set', 'zset', 'stream'].map(key), binary, ...bulk];
}

async function snapshot(
  session: RedisSession,
  keys: readonly Uint8Array[],
): Promise<{ payload: string; ttl: number }[]> {
  const dumped = await session.dumpKeys(keys);
  return dumped.map((d) => ({
    payload: d.payload ? Buffer.from(d.payload).toString('hex') : 'missing',
    ttl: d.ttlMs,
  }));
}

function expectSameKeys(
  a: readonly { payload: string; ttl: number }[],
  b: readonly { payload: string; ttl: number }[],
): void {
  expect(b.map((k) => k.payload)).toEqual(a.map((k) => k.payload));
  // TTLs come back relative to the restore, so they can only have shrunk a little.
  b.forEach((k, i) => {
    const original = a[i]!.ttl;
    if (original < 0) expect(k.ttl).toBe(-1);
    else {
      expect(k.ttl).toBeGreaterThan(original - 60_000);
      expect(k.ttl).toBeLessThanOrEqual(original);
    }
  });
}

async function cleanup(session: RedisSession, prefix: string): Promise<void> {
  await session.bulkDelete({ match: `${prefix}*` });
}

describe.skipIf(!URL)('Redis backup and restore', () => {
  const dir = tempDir('redis');
  const prefix = `jbk:${randomBytes(4).toString('hex')}:`;
  let source: RedisSession;
  let target: RedisSession;
  let keys: Uint8Array[] = [];

  beforeAll(async () => {
    source = await connectRedis(URL!);
    target = await connectRedis(URL!.replace(/\/\d*$/, '/1'));
    expect(target.database).toBe(1);
    keys = await seed(source, prefix);
  });

  afterAll(async () => {
    await cleanup(source, prefix).catch(() => undefined);
    await cleanup(target, prefix).catch(() => undefined);
    await source.close();
    await target.close();
    dir.remove();
  });

  it('round-trips keys with their TTLs into another database', async () => {
    const path = join(dir.path, 'keys.qbak');
    const before = await snapshot(source, keys);
    const summary = await backupRedis({
      session: source,
      output: fileSink(path),
      format: 'qbak',
      pattern: `${prefix}*`,
      encryption: { passphrase: 'redis secret', cost: FAST },
    });
    expect(summary.error).toBeUndefined();
    expect(summary.rows).toBe(keys.length);
    const archive = await ArchiveReader.open(path, { passphrase: 'redis secret' });
    const restored = await restoreRedisArchive({ session: target, archive });
    expect(restored.errors).toEqual([]);
    expect(restored.rows).toBe(keys.length);
    expectSameKeys(before, await snapshot(target, keys));

    // Again: existing keys are kept, unless REPLACE is asked for and confirmed.
    await target.command([
      bytes('SET'),
      Buffer.concat([Buffer.from(prefix), Buffer.from('string')]),
      bytes('changed'),
    ]);
    const kept = await restoreRedisArchive({ session: target, archive });
    expect(kept.status).toBe('completed');
    expect(kept.rows).toBe(0);
    expect(kept.warnings.join()).toMatch(/already existed/);
    const plan = await planRedisRestore({ session: target, archive, replace: true });
    expect(plan.existing).toBe(keys.length);
    expect(plan.conflicts).toHaveLength(1);
    const refused = await restoreRedisArchive({ session: target, archive, replace: true });
    expect(refused.error?.code).toBe('CONFIRMATION_REQUIRED');
    const replaced = await restoreRedisArchive({
      session: target,
      archive,
      replace: true,
      confirmedConflicts: plan.conflicts.map((c) => c.id),
    });
    expect(replaced.rows).toBe(keys.length);
    expectSameKeys(before, await snapshot(target, keys));
    await archive.close();
  });
});

describe.skipIf(!URL || !CLUSTER)('Redis Cluster backup and restore', () => {
  const dir = tempDir('redis-cluster');
  const prefix = `jbk:${randomBytes(4).toString('hex')}:`;
  let cluster: RedisSession;
  let keys: Uint8Array[] = [];

  beforeAll(async () => {
    cluster = await connectRedis(URL!, CLUSTER);
    expect(cluster.server.clusterMode).toBe(true);
    keys = await seed(cluster, prefix);
  });

  afterAll(async () => {
    await cleanup(cluster, prefix).catch(() => undefined);
    await cluster.close();
    dir.remove();
  });

  it('backs up every primary and restores keys to the nodes owning their slots', async () => {
    const path = join(dir.path, 'cluster.qbak');
    const summary = await backupRedis({
      session: cluster,
      output: fileSink(path),
      format: 'qbak',
      pattern: `${prefix}*`,
    });
    expect(summary.rows).toBe(keys.length);
    const before = await snapshot(cluster, keys);
    await cleanup(cluster, prefix);
    expect(await cluster.exists([keys[0]!])).toBe(0);
    const archive = await ArchiveReader.open(path);
    expect(archive.manifest.options['cluster']).toBe(true);
    const restored = await restoreRedisArchive({ session: cluster, archive, absoluteTtl: true });
    await archive.close();
    expect(restored.errors).toEqual([]);
    expect(restored.rows).toBe(keys.length);
    expectSameKeys(before, await snapshot(cluster, keys));
  });
});
