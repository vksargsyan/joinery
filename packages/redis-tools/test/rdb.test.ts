import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  RdbError,
  analyzeRdb,
  listpackCount,
  lzfDecompress,
  moduleTypeName,
  readRdb,
  ziplistCount,
  zipmapCount,
  type RdbKey,
  type RdbSummary,
} from '../src';

const FIXTURES = join(import.meta.dirname, 'fixtures/rdb');

async function* chunks(bytes: Uint8Array, size: number): AsyncGenerator<Uint8Array> {
  for (let at = 0; at < bytes.length; at += size) yield bytes.subarray(at, at + size);
}

async function readAll(
  bytes: Uint8Array,
  size = 1000,
): Promise<{
  keys: RdbKey[];
  aux: Record<string, string>;
  summary: RdbSummary;
  functions: number;
}> {
  const keys: RdbKey[] = [];
  const aux: Record<string, string> = {};
  let functions = 0;
  const summary = await readRdb(chunks(bytes, size), {
    onKey: (key) => keys.push(key),
    onAux: (name, value) => (aux[name] = value),
    onFunction: () => functions++,
  });
  return { keys, aux, summary, functions };
}

const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

function byName(keys: readonly RdbKey[]): Map<string, RdbKey> {
  return new Map(keys.map((key) => [`${key.db}/${text(key.key)}`, key]));
}

// ---------------------------------------------------------------------------------------------
// A small RDB writer for the formats no current server writes.

const enc = new TextEncoder();

function len(n: number): number[] {
  if (n < 64) return [n];
  if (n < 16384) return [0x40 | (n >> 8), n & 0xff];
  return [0x80, (n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
}

function str(value: string | Uint8Array): number[] {
  const bytes = typeof value === 'string' ? enc.encode(value) : value;
  return [...len(bytes.length), ...bytes];
}

function rdb(version: number, ...body: number[][]): Uint8Array {
  return Uint8Array.from([
    ...enc.encode(`REDIS${String(version).padStart(4, '0')}`),
    ...body.flat(),
    0xff,
    ...(version >= 5 ? [0, 0, 0, 0, 0, 0, 0, 0] : []),
  ]);
}

const le32 = (n: number): number[] => [
  n & 0xff,
  (n >>> 8) & 0xff,
  (n >>> 16) & 0xff,
  (n >>> 24) & 0xff,
];
const le64 = (n: number): number[] => [...le32(n % 2 ** 32), ...le32(Math.floor(n / 2 ** 32))];

/** A ziplist of short strings. */
function ziplist(items: readonly string[], count = items.length): Uint8Array {
  const entries: number[] = [];
  let prev = 0;
  for (const item of items) {
    const bytes = enc.encode(item);
    const entry = [prev, bytes.length, ...bytes];
    entries.push(...entry);
    prev = entry.length;
  }
  const total = 10 + entries.length + 1;
  return Uint8Array.from([...le32(total), ...le32(0), count & 0xff, count >> 8, ...entries, 0xff]);
}

/** A listpack of short strings. */
function listpack(items: readonly string[], count = items.length): Uint8Array {
  const entries: number[] = [];
  for (const item of items) {
    const bytes = enc.encode(item);
    entries.push(0x80 | bytes.length, ...bytes, 1 + bytes.length);
  }
  const total = 6 + entries.length + 1;
  return Uint8Array.from([...le32(total), count & 0xff, count >> 8, ...entries, 0xff]);
}

// ---------------------------------------------------------------------------------------------

describe('readRdb on dumps written by Redis and Valkey', () => {
  const files = readdirSync(FIXTURES).filter((file) => file.endsWith('.rdb'));

  it('has a dump from every server generation', () => {
    expect(files.sort()).toEqual([
      'redis-6.2.rdb',
      'redis-7.0.rdb',
      'redis-7.2.rdb',
      'redis-7.4.rdb',
      'redis-8.2.rdb',
      'redis-8.6.rdb',
      'valkey-8.1.rdb',
      'valkey-9.0.rdb',
    ]);
  });

  it.each(files)('reads %s to its last byte, whatever the chunk size', async (file) => {
    const bytes = readFileSync(join(FIXTURES, file));
    const whole = await readAll(bytes, bytes.length);
    expect(whole.summary.bytes).toBe(bytes.length);
    expect(whole.summary.checksum).toMatch(/^[0-9a-f]{16}$/);
    for (const size of [1, 7, 4096]) {
      const again = await readAll(bytes, size);
      expect(again.keys).toEqual(whole.keys);
    }

    const keys = byName(whole.keys);
    const at = (name: string): RdbKey => {
      const key = keys.get(name);
      if (!key) throw new Error(`${file} has no key ${name}`);
      return key;
    };
    // Every server wrote the same keys, in its own encodings.
    expect(at('0/str:int')).toMatchObject({ type: 'string', encoding: 'int', elements: 5 });
    expect(at('0/str:small')).toMatchObject({ type: 'string', encoding: 'raw', elements: 5 });
    // 2,000 repeated bytes, LZF-compressed in the file.
    expect(at('0/str:big')).toMatchObject({ elements: 2000 });
    expect(at('0/str:big').bytes).toBeLessThan(100);
    expect(at('0/str:expiring').expiresAt).toBeGreaterThan(Date.UTC(2020, 0, 1));
    expect(at('0/str:expiring:ms').expiresAt).toBeGreaterThan(Date.UTC(2020, 0, 1));
    expect(at('0/str:small').expiresAt).toBeNull();
    expect(at('0/list:small')).toMatchObject({ type: 'list', encoding: 'quicklist', elements: 3 });
    expect(at('0/list:big')).toMatchObject({ type: 'list', encoding: 'quicklist', elements: 1000 });
    expect(at('0/set:ints')).toMatchObject({ type: 'set', encoding: 'intset', elements: 5 });
    expect(at('0/set:big')).toMatchObject({ type: 'set', encoding: 'hashtable', elements: 600 });
    expect(at('0/zset:small')).toMatchObject({ type: 'zset', elements: 3 });
    expect(at('0/zset:big')).toMatchObject({ type: 'zset', encoding: 'skiplist', elements: 300 });
    expect(at('0/hash:small')).toMatchObject({ type: 'hash', elements: 2 });
    expect(at('0/hash:big')).toMatchObject({ type: 'hash', encoding: 'hashtable', elements: 600 });
    expect(at('0/stream:events')).toMatchObject({
      type: 'stream',
      encoding: 'stream',
      elements: 3,
      groups: 1,
    });
    for (const n of [1, 2, 3]) {
      expect(at(`3/user:${n}:profile`)).toMatchObject({ db: 3, type: 'string', elements: 1 });
    }
    // Each key's bytes add up to the file, less the header, AUX fields and the rest.
    const total = whole.keys.reduce((sum, key) => sum + key.bytes, 0);
    expect(total).toBeLessThan(bytes.length);
    expect(total).toBeGreaterThan(bytes.length * 0.8);
  });

  it('knows each generation by its version and encodings', async () => {
    const read = async (file: string) => readAll(readFileSync(join(FIXTURES, file)));
    const redis62 = await read('redis-6.2.rdb');
    expect(redis62.summary.version).toBe(9);
    expect(redis62.aux['redis-ver']).toBe('6.2.24');
    expect(byName(redis62.keys).get('0/hash:small')).toMatchObject({
      encoding: 'ziplist',
      rdbType: 13,
    });
    expect(byName(redis62.keys).get('0/set:small')).toMatchObject({ encoding: 'hashtable' });

    const redis72 = await read('redis-7.2.rdb');
    expect(redis72.summary.version).toBe(11);
    expect(byName(redis72.keys).get('0/set:small')).toMatchObject({
      encoding: 'listpack',
      rdbType: 20,
    });

    // Redis 7.4: hashes with field expirations, as listpacks and as hash tables.
    const redis74 = byName((await read('redis-7.4.rdb')).keys);
    expect(redis74.get('0/hash:ttl')).toMatchObject({ rdbType: 25, elements: 3, fieldsWithTtl: 2 });
    expect(redis74.get('0/hash:ttlbig')).toMatchObject({
      rdbType: 24,
      encoding: 'hashtable',
      elements: 600,
      fieldsWithTtl: 1,
    });

    // Redis 8: the bundled modules' types, named by their module, and functions.
    const redis82 = await read('redis-8.2.rdb');
    const modules = byName(redis82.keys);
    expect(modules.get('0/json:doc')).toMatchObject({ type: 'ReJSON-RL', encoding: 'module' });
    expect(modules.get('0/ts:temp')).toMatchObject({ type: 'TSDB-TYPE' });
    expect(modules.get('0/bf:seen')).toMatchObject({ type: 'MBbloom--' });
    expect(redis82.functions).toBe(1);

    // Redis 8.6 (RDB 13): streams with idempotent producers.
    const redis86 = await read('redis-8.6.rdb');
    expect(redis86.summary.version).toBe(13);
    expect(byName(redis86.keys).get('0/stream:events')).toMatchObject({ rdbType: 26, elements: 3 });

    // Valkey 9 (VALKEY080): its own hash type with field expirations.
    const valkey9 = await read('valkey-9.0.rdb');
    expect(valkey9.summary.version).toBe(80);
    expect(valkey9.aux['valkey-ver']).toMatch(/^9\./);
    expect(byName(valkey9.keys).get('0/hash:ttl')).toMatchObject({
      rdbType: 22,
      elements: 3,
      fieldsWithTtl: 2,
    });
  });
});

describe('readRdb on formats no current server writes', () => {
  it('reads Redis 2.x linked lists, sets, sorted sets with text scores and zipmaps', async () => {
    const zipmap = Uint8Array.from([2, 1, 0x61, 1, 0, 0x31, 1, 0x62, 1, 0, 0x32, 0xff]);
    const file = rdb(
      4,
      [0xfe, 0],
      [1, ...str('list'), ...len(2), ...str('a'), ...str('b')],
      [2, ...str('set'), ...len(1), ...str('x')],
      [3, ...str('zset'), ...len(2), ...str('m'), 3, ...enc.encode('1.5'), ...str('n'), 254],
      [4, ...str('hash'), ...len(1), ...str('f'), ...str('v')],
      [9, ...str('zipmap'), ...str(zipmap)],
      [10, ...str('ziplist'), ...str(ziplist(['a', 'b', 'c']))],
      [12, ...str('zsetzl'), ...str(ziplist(['m', '1', 'n', '2']))],
      // An expiry in seconds (RDB 1-2).
      [0xfd, ...le32(2_000_000_000), 0, ...str('old'), ...str('v')],
    );
    const { keys, summary } = await readAll(file, 3);
    expect(summary).toEqual({ version: 4, bytes: file.length, checksum: null });
    expect(keys.map((k) => [text(k.key), k.type, k.encoding, k.elements])).toEqual([
      ['list', 'list', 'linkedlist', 2],
      ['set', 'set', 'hashtable', 1],
      ['zset', 'zset', 'skiplist', 2],
      ['hash', 'hash', 'hashtable', 1],
      ['zipmap', 'hash', 'zipmap', 2],
      ['ziplist', 'list', 'ziplist', 3],
      ['zsetzl', 'zset', 'ziplist', 2],
      ['old', 'string', 'raw', 1],
    ]);
    expect(keys.at(-1)!.expiresAt).toBe(2_000_000_000_000);
  });

  it('reads long lengths, integer and LZF strings, LRU and LFU data and key metadata', async () => {
    const long = 'x'.repeat(70_000);
    // "aaaaaaaaaa": one literal byte, then a back reference of 9 bytes at distance 1.
    const lzf = [0xc3, ...len(5), ...len(10), 0x00, 0x61, 0xe0, 0x00, 0x00];
    const file = rdb(
      13,
      [0xfa, ...str('redis-ver'), ...str('8.6.0')],
      [0xfa, ...str('ctime'), 0xc2, ...le32(1_790_000_000)],
      [0xfb, ...len(3), ...len(1)],
      [0xf4, ...len(12), ...len(3), ...len(1)],
      [0, ...str('long'), ...str(long)],
      [0, 0xc0, 42, 0xc1, 0x39, 0x30],
      [0, ...str('lzf'), ...lzf],
      [0xf8, ...len(300), 0, ...str('idle'), ...str('v')],
      [0xf9, 7, 0, ...str('freq'), ...str('v')],
      [
        0xfc,
        ...le64(1_800_000_000_000),
        0xf3,
        ...len(1),
        1,
        2,
        3,
        4,
        2,
        5,
        0,
        0,
        ...str('meta'),
        ...str('v'),
      ],
    );
    const { keys, aux } = await readAll(file, 64);
    expect(aux).toEqual({ 'redis-ver': '8.6.0', ctime: '1790000000' });
    expect(keys.map((k) => [text(k.key), k.encoding, k.elements])).toEqual([
      ['long', 'raw', 70_000],
      ['42', 'int', 5],
      ['lzf', 'raw', 10],
      ['idle', 'raw', 1],
      ['freq', 'raw', 1],
      ['meta', 'raw', 1],
    ]);
    expect(keys[3]!.idle).toBe(300);
    expect(keys[4]!.frequency).toBe(7);
    // The expiry and metadata before a key count in its size.
    expect(keys[5]!.expiresAt).toBe(1_800_000_000_000);
    expect(keys[5]!.bytes).toBe(1 + 8 + 1 + 1 + 4 + 3 + 1 + 5 + 2);
  });

  it('keeps the first 4 KiB of a long key name', async () => {
    const name = 'k'.repeat(10_000);
    const { keys } = await readAll(rdb(11, [0, ...str(name), ...str('v')]));
    expect(keys[0]!.key).toHaveLength(4096);
    expect(keys[0]!.keyLength).toBe(10_000);
  });
});

describe('readRdb on files it cannot read', () => {
  it('refuses what is not an RDB file', async () => {
    await expect(readAll(enc.encode('*1\r\n$4\r\nPING\r\n'))).rejects.toThrow(
      'This is not an RDB file',
    );
    await expect(readAll(enc.encode('REDIS0099'))).rejects.toThrow('RDB version 99 is newer');
  });

  it('stops where a file is cut short or holds an unknown type, with the offset', async () => {
    const whole = readFileSync(join(FIXTURES, 'redis-7.2.rdb'));
    const cut = whole.subarray(0, 5000);
    const error = await readAll(cut).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RdbError);
    expect((error as RdbError).message).toMatch(/The file ends in the middle/);
    expect((error as RdbError).offset).toBeLessThanOrEqual(5000);

    await expect(readAll(rdb(11, [40, ...str('k')]))).rejects.toThrow(
      'Value type 40 is not one Querybara reads (RDB version 11)',
    );
    await expect(readAll(rdb(11, [6, ...str('k')]))).rejects.toThrow(
      'Module values from Redis 4.0 release candidates cannot be read',
    );
  });

  it('stops when cancelled', async () => {
    const keys = Array.from({ length: 10_000 }, (_, i) => [0, ...str(`k${i}`), ...str('v')]);
    const controller = new AbortController();
    let seen = 0;
    const run = readRdb(
      chunks(rdb(11, ...keys), 100),
      {
        onKey: () => {
          if (++seen === 100) controller.abort();
        },
      },
      { signal: controller.signal },
    );
    await expect(run).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(seen).toBeLessThan(10_000);
  });
});

describe('encoded blobs', () => {
  it('counts listpack and ziplist entries past the 65,535 their header holds', () => {
    const items = Array.from({ length: 5 }, (_, i) => `item${i}`);
    expect(listpackCount(listpack(items))).toBe(5);
    expect(listpackCount(listpack(items, 0xffff))).toBe(5);
    expect(ziplistCount(ziplist(items))).toBe(5);
    expect(ziplistCount(ziplist(items, 0xffff))).toBe(5);
    expect(zipmapCount(Uint8Array.from([254, 1, 0x61, 1, 0, 0x31, 0xff]))).toBe(1);
  });

  it('decompresses LZF and refuses a damaged stream', () => {
    expect(text(lzfDecompress(Uint8Array.from([0x02, 0x61, 0x62, 0x63]), 3))).toBe('abc');
    expect(text(lzfDecompress(Uint8Array.from([0x00, 0x61, 0xe0, 0x00, 0x00]), 10))).toBe(
      'a'.repeat(10),
    );
    expect(() => lzfDecompress(Uint8Array.from([0x20, 0x05]), 4)).toThrow(/back reference/);
    expect(() => lzfDecompress(Uint8Array.from([0x00, 0x61]), 2)).toThrow(/shorter/);
  });

  it('names module types from their ids', () => {
    // ReJSON-RL with encoding version 3, as RedisJSON registers it.
    const charset = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    let id = 0n;
    for (const ch of 'ReJSON-RL') id = (id << 6n) | BigInt(charset.indexOf(ch));
    id = (id << 10n) | 3n;
    expect(moduleTypeName(id)).toBe('ReJSON-RL');
  });
});

describe('analyzeRdb', () => {
  it('sums a dump by database, type, encoding, expiry and pattern', async () => {
    const bytes = readFileSync(join(FIXTURES, 'redis-8.2.rdb'));
    const progress: number[] = [];
    const analysis = await analyzeRdb(chunks(bytes, 1000), {
      progressBytes: 1,
      onProgress: (at) => progress.push(at),
      top: 5,
    });
    expect(analysis).toMatchObject({
      version: 12,
      bytes: bytes.length,
      keys: 23,
      expiring: 2,
      functions: 1,
      // hash:ttl (a listpack) has two fields with a TTL, hash:ttlbig (a hash table) one.
      fieldsWithTtl: 3,
    });
    expect(analysis.stopped).toBeUndefined();
    expect(analysis.aux['redis-ver']).toMatch(/^8\.2\./);
    expect(analysis.createdAt).toBe(Number(analysis.aux['ctime']) * 1000);
    expect(analysis.databases.map((d) => [d.db, d.keys])).toEqual([
      [0, 20],
      [3, 3],
    ]);
    expect(analysis.keyBytes).toBe(analysis.databases.reduce((sum, d) => sum + d.bytes, 0));
    // Types, largest first, each with its encodings.
    expect(analysis.types[0]!.name).toBe('hash');
    const hash = analysis.types.find((t) => t.name === 'hash')!;
    expect(hash.encodings.map((e) => e.name).sort()).toEqual(['hashtable', 'listpack']);
    expect(analysis.types.map((t) => t.name)).toEqual(
      expect.arrayContaining(['ReJSON-RL', 'TSDB-TYPE', 'MBbloom--', 'stream', 'string']),
    );
    // Expiry measured from the dump's own time (whole seconds): an hour's and a day's TTL.
    const expiry = Object.fromEntries(analysis.expiry.map((e) => [e.name, e.keys]));
    expect(expiry['No expiry']).toBe(21);
    expect(analysis.expiry.map((e) => e.name)).toEqual(
      expect.arrayContaining([expect.stringMatching(/^Within an? (hour|day|week)$/)]),
    );
    expect(analysis.expiry.reduce((sum, e) => sum + e.keys, 0)).toBe(23);
    // Patterns: the three profiles in database 3 are one pattern.
    const profiles = analysis.patterns.find((p) => p.pattern === 'user:*:profile');
    expect(profiles).toMatchObject({ count: 3, types: { string: 3 } });
    // Largest keys by bytes, and collections by elements.
    expect(analysis.biggest.map((k) => text(k.key))).toHaveLength(5);
    expect(analysis.biggest[0]!.bytes).toBeGreaterThanOrEqual(analysis.biggest[4]!.bytes);
    expect(analysis.longest.map((k) => [text(k.key), k.elements])).toEqual([
      ['list:big', 1000],
      [expect.stringMatching(/^(hash:big|hash:ttlbig|set:big)$/), 600],
      [expect.stringMatching(/^(hash:big|hash:ttlbig|set:big)$/), 600],
      [expect.stringMatching(/^(hash:big|hash:ttlbig|set:big)$/), 600],
      ['zset:big', 300],
    ]);
    expect(analysis.biggest[0]).toMatchObject({ type: 'hash', encoding: 'hashtable' });
    expect(progress.at(-1)).toBe(bytes.length);
  });

  it('reports what it read before a damaged part', async () => {
    const whole = readFileSync(join(FIXTURES, 'redis-7.2.rdb'));
    const analysis = await analyzeRdb(chunks(whole.subarray(0, 9000), 1000));
    expect(analysis.stopped?.message).toMatch(/The file ends in the middle/);
    expect(analysis.keys).toBeGreaterThan(0);
    expect(analysis.keys).toBeLessThan(22);
  });

  it('bounds its patterns', async () => {
    const keys = Array.from({ length: 50 }, (_, i) => [0, ...str(`kind${i}:1`), ...str('v')]);
    const analysis = await analyzeRdb(chunks(rdb(11, ...keys), 64), {
      maxPatterns: 10,
      patternLimit: 5,
    });
    expect(analysis.patterns).toHaveLength(5);
    const other = analysis.patterns.at(-1)!;
    expect(other.pattern).toBe('(other)');
    expect(analysis.patterns.reduce((sum, p) => sum + p.count, 0)).toBe(50);
  });
});
