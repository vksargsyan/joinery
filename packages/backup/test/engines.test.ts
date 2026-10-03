import type { Capabilities, ResultChunk } from '@querybara/core';
import { memorySink } from '@querybara/transfer';
import { EJSON } from 'bson';
import { describe, expect, it } from 'vitest';

import {
  ArchiveReader,
  backupRedis,
  createCommand,
  indexesToCreate,
  memoryArchiveSource,
  planRedisRestore,
  restoreRedisArchive,
  type DumpedKeyRecord,
  type RedisBackupSession,
} from '../src';

/**
 * MongoDB and Redis pieces without a server: the create and createIndexes commands built from
 * listCollections and listIndexes output, and the whole Redis backup and restore flow against
 * an in-memory fake that behaves like SCAN, DUMP, RESTORE and EXISTS.
 */

describe('MongoDB metadata', () => {
  it('rebuilds create commands from listCollections options', () => {
    const clustered = createCommand(
      'events',
      EJSON.stringify(
        { clusteredIndex: { v: 2, key: { _id: 1 }, name: 'by_id', unique: true } },
        { relaxed: false },
      ),
    );
    expect(Object.keys(clustered)[0]).toBe('create');
    expect(EJSON.stringify(clustered)).toBe(
      '{"create":"events","clusteredIndex":{"key":{"_id":1},"name":"by_id","unique":true}}',
    );
    const view = createCommand(
      'adults',
      '{"viewOn":"people","pipeline":[{"$match":{"age":{"$gte":{"$numberInt":"18"}}}}]}',
    );
    expect(view['viewOn']).toBe('people');
  });

  it('recreates every index but _id_ and the clustered one, without v and ns', () => {
    const specs = [
      { v: 2, key: { _id: 1 }, name: '_id_' },
      { v: 2, key: { _id: 1 }, name: 'by_id', unique: true, clustered: true },
      { v: 2, key: { a: 1 }, name: 'a_1', unique: true, ns: 'db.c' },
      { v: 2, key: { _fts: 'text', _ftsx: 1 }, name: 't', weights: { t: 5 } },
    ].map((spec) => EJSON.stringify(spec, { relaxed: false }));
    expect(indexesToCreate(specs).map((s) => EJSON.stringify(s))).toEqual([
      '{"key":{"a":1},"name":"a_1","unique":true}',
      '{"key":{"_fts":"text","_ftsx":1},"name":"t","weights":{"t":5}}',
    ]);
  });
});

/** An in-memory Redis with just what backups use. */
class FakeRedis implements RedisBackupSession {
  readonly engine = 'redis' as const;
  readonly serverVersion = '7.2.4';
  readonly database = 0;
  readonly server = { clusterMode: false };
  readonly inTransaction = false;
  readonly data = new Map<string, { payload: Uint8Array; ttlMs: number }>();

  set(key: string, value: string, ttlMs = -1): void {
    this.data.set(Buffer.from(key).toString('latin1'), {
      payload: Buffer.from(`v:${value}`),
      ttlMs,
    });
  }

  get(key: string): string | undefined {
    const entry = this.data.get(Buffer.from(key).toString('latin1'));
    return entry ? Buffer.from(entry.payload).toString().slice(2) : undefined;
  }

  capabilities(): Capabilities {
    throw new Error('not used');
  }
  execute(): AsyncIterable<ResultChunk> {
    throw new Error('not used');
  }
  async cancel(): Promise<void> {}
  introspect(): never {
    throw new Error('not used');
  }
  async browse(): Promise<never[]> {
    return [];
  }
  async ping(): Promise<void> {}
  async close(): Promise<void> {}

  async scan(options: { cursor?: string; match?: Uint8Array | string; count?: number } = {}) {
    const keys = [...this.data.keys()].sort();
    const match = String(options.match ?? '*');
    const prefix = match.endsWith('*') ? match.slice(0, -1) : match;
    const start = Number(options.cursor ?? '0');
    const count = options.count ?? 10;
    const page = keys.slice(start, start + count).filter((k) => k.startsWith(prefix));
    const next = start + count >= keys.length ? '0' : String(start + count);
    // SCAN may repeat a key; repeat the first one of each page.
    const withRepeat = page.length > 0 ? [...page, page[0]!] : page;
    return {
      keys: withRepeat.map((k) => Buffer.from(k, 'latin1')),
      cursor: next,
      done: next === '0',
    };
  }

  async dumpKeys(keys: readonly Uint8Array[]): Promise<DumpedKeyRecord[]> {
    return keys.map((key) => {
      const entry = this.data.get(Buffer.from(key).toString('latin1'));
      return {
        key,
        payload: entry?.payload ?? null,
        ttlMs: entry?.ttlMs ?? -1,
        expireAtMs: entry && entry.ttlMs >= 0 ? Date.now() + entry.ttlMs : null,
      };
    });
  }

  async restoreKeys(
    keys: readonly DumpedKeyRecord[],
    options: { replace?: boolean } = {},
  ): Promise<number> {
    for (const key of keys) {
      const id = Buffer.from(key.key).toString('latin1');
      if (this.data.has(id) && !options.replace)
        throw new Error('BUSYKEY Target key name already exists.');
    }
    for (const key of keys) {
      this.data.set(Buffer.from(key.key).toString('latin1'), {
        payload: key.payload!,
        ttlMs: key.ttlMs,
      });
    }
    return keys.length;
  }

  async exists(keys: readonly Uint8Array[]): Promise<number> {
    return keys.filter((k) => this.data.has(Buffer.from(k).toString('latin1'))).length;
  }
}

describe('Redis backup and restore', () => {
  async function backup(source: FakeRedis, pattern?: string): Promise<ArchiveReader> {
    const sink = memorySink();
    const summary = await backupRedis({
      session: source,
      output: sink,
      format: 'qbak',
      ...(pattern !== undefined ? { pattern } : {}),
      scanCount: 3,
    });
    expect(summary.status).toBe('completed');
    return ArchiveReader.open(memoryArchiveSource(sink.bytes()));
  }

  it('backs up matching keys with TTLs and restores them once each', async () => {
    const source = new FakeRedis();
    for (let i = 0; i < 20; i++) source.set(`app:${i}`, String(i), i % 2 === 0 ? 60_000 : -1);
    source.set('other:1', 'x');
    const archive = await backup(source, 'app:*');
    expect(archive.manifest.objects[0]).toMatchObject({ kind: 'keys', data: { count: 27 } });

    const target = new FakeRedis();
    const summary = await restoreRedisArchive({ session: target, archive });
    expect(summary.status).toBe('completed');
    expect(summary.rows).toBe(20);
    expect(target.data.size).toBe(20);
    expect(target.get('app:4')).toBe('4');
    expect(target.data.get('app:4')?.ttlMs).toBe(60_000);
    expect(target.data.get('app:5')?.ttlMs).toBe(-1);
    expect(target.get('other:1')).toBeUndefined();
  });

  it('keeps existing keys, or replaces them after confirmation', async () => {
    const source = new FakeRedis();
    for (let i = 0; i < 5; i++) source.set(`k${i}`, `new${i}`);
    const archive = await backup(source);
    const target = new FakeRedis();
    target.set('k1', 'old');

    const kept = await restoreRedisArchive({ session: target, archive });
    expect(kept.rows).toBe(4);
    expect(target.get('k1')).toBe('old');
    expect(kept.warnings[0]).toMatch(/1 key already existed/);

    const plan = await planRedisRestore({ session: target, archive, replace: true });
    expect(plan.existing).toBe(5);
    expect(plan.conflicts[0]).toMatchObject({ action: 'overwrite' });
    const refused = await restoreRedisArchive({ session: target, archive, replace: true });
    expect(refused.error?.code).toBe('CONFIRMATION_REQUIRED');
    expect(target.get('k1')).toBe('old');
    const replaced = await restoreRedisArchive({
      session: target,
      archive,
      replace: true,
      confirmedConflicts: plan.conflicts.map((c) => c.id),
    });
    expect(replaced.rows).toBe(5);
    expect(target.get('k1')).toBe('new1');
  });

  it('refuses archives of other engines and plain scripts', async () => {
    await expect(
      backupRedis({ session: new FakeRedis(), output: memorySink(), format: 'sql' }),
    ).rejects.toThrow(/Querybara archive format/);
  });
});
