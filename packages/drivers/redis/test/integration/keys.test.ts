import { JoineryError } from '@joinery/core';
import { displayBytes } from '@joinery/redis-tools';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { BulkDeleteProgress, RedisSession } from '../../src';
import type { RedisContext } from '../../src/context';
import { REDIS_URL, cleanup, connect, dec, enc, newPrefix, standaloneProfile } from './helpers';

/** Key browsing and key operations on the standalone server. */
describe.skipIf(!REDIS_URL)('keys (standalone)', () => {
  let session: RedisSession;
  let other: RedisSession;
  let p: string;

  beforeAll(async () => {
    session = await connect(standaloneProfile());
    other = await connect(standaloneProfile({ options: { defaultDatabase: '5' } }));
  });
  afterAll(async () => {
    await session?.close();
    await other?.close();
  });
  beforeEach(() => {
    p = newPrefix();
  });
  afterEach(async () => {
    await cleanup(session, p);
    await cleanup(other, p);
  });

  async function fill(count: number, name = 'k'): Promise<void> {
    for (let i = 0; i < count; i += 500) {
      const args = ['MSET'];
      for (let j = i; j < Math.min(count, i + 500); j++) args.push(`${p}${name}:${j}`, String(j));
      await session.command(args);
    }
  }

  it('scans with MATCH and TYPE, and fills pages within a budget', async () => {
    await fill(120);
    await session.hashSet(`${p}h:1`, [['f', 'v']]);
    const found = new Set<string>();
    let cursor = '0';
    do {
      const page = await session.scan({ cursor, match: `${p}*`, count: 1000 });
      page.keys.forEach((k) => found.add(dec(k)!));
      cursor = page.cursor;
    } while (cursor !== '0');
    expect(found.size).toBe(121);
    const hashes = await session.scanPage({ match: `${p}*`, type: 'hash', limit: 10 });
    expect(hashes.keys.map(dec)).toEqual([`${p}h:1`]);
    expect(hashes.done).toBe(true);
    const page = await session.scanPage({ match: `${p}k:*`, limit: 50, count: 20 });
    expect(page.keys.length).toBeGreaterThanOrEqual(50);
    expect(page.budgetExhausted).toBe(false);
    const starved = await session.scanPage({
      match: `${p}none:*`,
      limit: 10,
      count: 1,
      maxCalls: 3,
    });
    expect(starved).toMatchObject({ keys: [], calls: 3, done: false, budgetExhausted: true });
  });

  it('keeps binary key names byte for byte', async () => {
    const key = new Uint8Array([...enc(`${p}bin:`), 0x00, 0xff, 0x0a]);
    await session.setString(key, 'x');
    const page = await session.scanPage({ match: `${p}bin:*`, limit: 10 });
    expect(page.keys).toEqual([key]);
    const [info] = await session.keyInfo([key]);
    expect(info).toMatchObject({ type: 'string', kind: 'string', length: 1 });
    expect(displayBytes(page.keys[0]!)).toBe(`${p}bin:\\x00\\xff\\n`);
  });

  it('reports key info, memory usage and TTLs', async () => {
    await session.setString(`${p}a`, 'hello', { ttlMs: 30_000 });
    await session.listPush(`${p}b`, ['1', '2', '3']);
    const [a, b, missing] = await session.keyInfo([`${p}a`, `${p}b`, `${p}none`]);
    expect(a).toMatchObject({ type: 'string', kind: 'string', length: 5, encoding: 'embstr' });
    expect(a!.ttlMs).toBeGreaterThan(20_000);
    expect(b).toMatchObject({ type: 'list', kind: 'list', length: 3, ttlMs: -1 });
    expect(missing).toMatchObject({ type: 'none', kind: 'none', ttlMs: -2 });
    const memory = await session.memoryUsage([`${p}a`, `${p}none`]);
    expect(memory[0]).toBeGreaterThan(0);
    expect(memory[1]).toBeNull();
    expect(await session.expire(`${p}b`, 5000)).toBe(true);
    expect((await session.keyInfo([`${p}b`]))[0]!.ttlMs).toBeGreaterThan(0);
    expect(await session.expire(`${p}b`, null)).toBe(true);
    expect((await session.keyInfo([`${p}b`]))[0]!.ttlMs).toBe(-1);
    expect(await session.expire(`${p}none`, 1000)).toBe(false);
    expect(await session.exists([`${p}a`, `${p}b`, `${p}none`])).toBe(2);
  });

  it('renames, copies and deletes keys', async () => {
    await session.setString(`${p}src`, 'v', { ttlMs: 60_000 });
    await session.setString(`${p}taken`, 't');
    expect(await session.rename(`${p}src`, `${p}taken`, { onlyIfNew: true })).toBe(false);
    expect(await session.rename(`${p}src`, `${p}dst`)).toBe(true);
    expect(await session.copy(`${p}dst`, `${p}copy`)).toEqual({ copied: true, method: 'copy' });
    expect(await session.copy(`${p}dst`, `${p}taken`)).toEqual({ copied: false, method: 'copy' });
    expect(await session.copy(`${p}dst`, `${p}taken`, { replace: true })).toEqual({
      copied: true,
      method: 'copy',
    });
    expect((await session.keyInfo([`${p}copy`]))[0]!.ttlMs).toBeGreaterThan(50_000);
    // Into another database, keeping the session's own database.
    expect(await session.copy(`${p}dst`, `${p}elsewhere`, { db: 5 })).toEqual({
      copied: true,
      method: 'copy',
    });
    expect(session.database).toBe(0);
    expect(dec((await other.getString(`${p}elsewhere`))!.bytes)).toBe('v');
    expect(await session.getString(`${p}elsewhere`)).toBeNull();
    expect(await session.deleteKeys([`${p}dst`, `${p}copy`, `${p}none`])).toBe(2);
  });

  it('dumps and restores keys with their TTL, also into another database', async () => {
    await session.zsetAdd(`${p}z`, [
      ['a', 1],
      ['b', 2],
    ]);
    await session.expire(`${p}z`, 120_000);
    const [dump] = await session.dumpKeys([`${p}z`]);
    expect(dump!.payload!.length).toBeGreaterThan(5);
    expect(dump!.ttlMs).toBeGreaterThan(100_000);
    expect(await session.restoreKeys([{ ...dump!, key: enc(`${p}z2`) }])).toBe(1);
    expect((await session.keyInfo([`${p}z2`]))[0]).toMatchObject({ type: 'zset', length: 2 });
    expect((await session.keyInfo([`${p}z2`]))[0]!.ttlMs).toBeGreaterThan(100_000);
    const busy = await session
      .restoreKeys([{ ...dump!, key: enc(`${p}z2`) }])
      .catch((e: unknown) => e);
    expect(busy).toMatchObject({ code: 'SQL_ERROR', engineCode: 'BUSYKEY' });
    expect(
      await session.restoreKeys([{ ...dump!, key: enc(`${p}z2`) }], {
        replace: true,
        absoluteTtl: true,
      }),
    ).toBe(1);
    expect(await session.restoreKeys([{ ...dump!, key: enc(`${p}z3`) }], { db: 5 })).toBe(1);
    expect(await other.zsetRange(`${p}z3`, { by: 'index', start: 0, stop: -1 })).toHaveLength(2);
    expect(session.database).toBe(0);
    expect(await session.exists([`${p}z3`])).toBe(0);
  });

  it('bulk-deletes by pattern: dry run, progress, cancellation and the real run', async () => {
    await fill(1200, 'bulk');
    await session.setString(`${p}keep`, 'x');
    const dry = await session.bulkDelete({ match: `${p}bulk:*`, dryRun: true });
    expect(dry).toMatchObject({ dryRun: true, matched: 1200, deleted: 0, cancelled: false });
    expect(dry.sample.length).toBe(20);
    expect(await session.exists([`${p}bulk:0`])).toBe(1);

    const controller = new AbortController();
    const cancelled = await session.bulkDelete({
      match: `${p}bulk:*`,
      batchSize: 100,
      scanCount: 100,
      signal: controller.signal,
      onProgress: (progress) => {
        if (progress.deleted >= 100) controller.abort();
      },
    });
    expect(cancelled.cancelled).toBe(true);
    expect(cancelled.deleted).toBeGreaterThanOrEqual(100);
    expect(cancelled.deleted).toBeLessThan(1200);

    const progress: BulkDeleteProgress[] = [];
    const result = await session.bulkDelete({
      match: `${p}bulk:*`,
      batchSize: 100,
      scanCount: 200,
      onProgress: (e) => progress.push(e),
    });
    expect(result.deleted + cancelled.deleted).toBe(1200);
    expect(result.failed).toBe(0);
    expect(progress.length).toBeGreaterThan(1);
    expect(progress.at(-1)!.deleted).toBe(result.deleted);
    expect(await session.exists([`${p}keep`])).toBe(1);
    const left = await session.scanPage({ match: `${p}bulk:*`, limit: 1 });
    expect(left.keys).toEqual([]);
  });

  it('browses databases and the namespace tree lazily', async () => {
    await session.setString(`${p}user:1:name`, 'a');
    await session.setString(`${p}user:1:email`, 'b');
    await session.hashSet(`${p}user:2`, [['f', 'v']]);
    await session.setString(new Uint8Array([...enc(`${p}bin:`), 0xff, 0x3a, 0x41]), 'x');
    await other.setString(`${p}db5only`, 'x');

    const root = await session.browse([]);
    expect(root).toHaveLength(16);
    expect(root[0]).toMatchObject({
      kind: 'database',
      name: 'db0',
      path: ['db0'],
      hasChildren: true,
    });
    expect(root[0]!.detail!['current']).toBe(1);
    expect(root[5]!.detail!['keys']).toBeGreaterThanOrEqual(1);

    const segments = p.slice(0, -1).split(':');
    const base = await session.browse(['db0', ...segments]);
    expect(base.map((n) => [n.kind, n.name, n.detail?.['keys'] ?? n.detail?.['type']])).toEqual([
      ['namespace', 'bin', 1],
      ['namespace', 'user', 3],
    ]);
    const users = await session.browse(['db0', ...segments, 'user']);
    expect(users.map((n) => [n.kind, n.name, n.hasChildren])).toEqual([
      ['namespace', '1', true],
      ['key', '2', false],
    ]);
    expect(users[1]!.detail).toMatchObject({ type: 'hash', key: `${p}user:2` });
    const bin = await session.browse(['db0', ...segments, 'bin']);
    expect(bin.map((n) => [n.kind, n.name])).toEqual([['namespace', '\\xff']]);
    const binChild = await session.browse(bin[0]!.path);
    expect(binChild.map((n) => [n.kind, n.name, n.detail?.['key']])).toEqual([
      ['key', 'A', `${p}bin:\\xff:A`],
    ]);

    // Another database, without moving the session off its own.
    const db5 = await session.browse(['db5', ...segments]);
    expect(db5.map((n) => [n.kind, n.name])).toEqual([['key', 'db5only']]);
    expect(session.database).toBe(0);
    expect(await session.exists([`${p}db5only`])).toBe(0);
  });

  it('reports partial results when the browse budget runs out', async () => {
    const { browseRedis } = await import('../../src/browse');
    const context = session as unknown as RedisContext;
    await fill(300, 'many');
    const segments = p.slice(0, -1).split(':');
    const nodes = await browseRedis(context, ['db0', ...segments], {
      maxCalls: 1,
      count: 10,
      timeMs: 1000,
      maxLeaves: 10,
    });
    const marker = nodes.at(-1)!;
    expect(marker.kind).toBe('other');
    expect(marker.detail).toMatchObject({ partial: 1 });
  });

  it('refuses an unknown database path', async () => {
    const error = await session.browse(['nope']).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(JoineryError);
  });
});
