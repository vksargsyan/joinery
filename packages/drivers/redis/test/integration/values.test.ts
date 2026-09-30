import { JoineryError } from '@joinery/core';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { RedisSession } from '../../src';
import { REDIS_URL, cleanup, connect, dec, enc, newPrefix, standaloneProfile } from './helpers';

/** Every value type through the typed services, on the standalone server. */
describe.skipIf(!REDIS_URL)('value types (standalone)', () => {
  let session: RedisSession;
  let p: string;

  beforeAll(async () => {
    session = await connect(standaloneProfile());
  });
  afterAll(async () => {
    await session?.close();
  });
  beforeEach(() => {
    p = newPrefix();
  });
  afterEach(async () => {
    await cleanup(session, p);
  });

  it('reads and writes strings byte for byte, in ranges when large', async () => {
    const binary = Uint8Array.of(0, 1, 0xff, 0x0a, 0x5c, 0x22, 0xc3);
    expect(await session.setString(`${p}bin`, binary)).toBe(true);
    const value = await session.getString(`${p}bin`);
    expect(value).toEqual({ bytes: binary, size: 7, offset: 0, truncated: false });
    expect(value!.bytes.constructor).toBe(Uint8Array);
    expect(await session.getString(`${p}missing`)).toBeNull();
    expect(await session.getString(`${p}bin`, { maxBytes: 3 })).toEqual({
      bytes: binary.subarray(0, 3),
      size: 7,
      offset: 0,
      truncated: true,
    });
    expect((await session.getString(`${p}bin`, { offset: 5, maxBytes: 10 }))!.bytes).toEqual(
      binary.subarray(5),
    );
    await session.setString(`${p}empty`, '');
    expect(await session.getString(`${p}empty`)).toEqual({
      bytes: new Uint8Array(0),
      size: 0,
      offset: 0,
      truncated: false,
    });

    // KEEPTTL keeps the expiry; a plain SET drops it.
    await session.setString(`${p}ttl`, 'a', { ttlMs: 60_000 });
    await session.setString(`${p}ttl`, 'b', { keepTtl: true });
    expect((await session.keyInfo([`${p}ttl`]))[0]!.ttlMs).toBeGreaterThan(50_000);
    await session.setString(`${p}ttl`, 'c');
    expect((await session.keyInfo([`${p}ttl`]))[0]!.ttlMs).toBe(-1);
    expect(await session.setString(`${p}ttl`, 'd', { condition: 'nx' })).toBe(false);
    expect(await session.setRange(`${p}ttl`, 1, 'xy')).toBe(3);
    expect(dec((await session.getString(`${p}ttl`))!.bytes)).toBe('cxy');
  });

  it('pages hashes with HSCAN and edits fields', async () => {
    const entries = Array.from({ length: 300 }, (_, i) => [`f${i}`, `v${i}`] as const);
    expect(await session.hashSet(`${p}h`, entries)).toBe(300);
    const seen = new Map<string, string>();
    let cursor = '0';
    do {
      const page = await session.hashScan(`${p}h`, { cursor, count: 50 });
      for (const e of page.items) seen.set(dec(e.field)!, dec(e.value)!);
      cursor = page.cursor;
    } while (cursor !== '0');
    expect(seen.size).toBe(300);
    const matched = await session.hashScan(`${p}h`, { match: 'f1?', count: 1000 });
    expect(matched.items.map((e) => dec(e.field)).sort()).toEqual([
      'f10',
      'f11',
      'f12',
      'f13',
      'f14',
      'f15',
      'f16',
      'f17',
      'f18',
      'f19',
    ]);
    expect((await session.hashGet(`${p}h`, ['f1', 'nope'])).map(dec)).toEqual(['v1', null]);
    expect(await session.hashDelete(`${p}h`, ['f1', 'f2', 'nope'])).toBe(2);
    expect((await session.keyInfo([`${p}h`]))[0]).toMatchObject({
      type: 'hash',
      kind: 'hash',
      length: 298,
    });
  });

  it('edits lists by index, push, insert and remove', async () => {
    expect(await session.listPush(`${p}l`, ['b', 'c'])).toBe(2);
    expect(await session.listPush(`${p}l`, ['a'], 'left')).toBe(3);
    await session.listSet(`${p}l`, 1, 'B');
    expect(await session.listInsert(`${p}l`, 'after', 'B', 'b2')).toBe(4);
    expect((await session.listRange(`${p}l`, 0, -1)).map(dec)).toEqual(['a', 'B', 'b2', 'c']);
    expect(await session.listRemoveAt(`${p}l`, 2, 'not-b2')).toBe(false);
    expect(await session.listRemoveAt(`${p}l`, 2, 'b2')).toBe(true);
    await session.listPush(`${p}l`, ['a', 'a']);
    expect(await session.listRemove(`${p}l`, 'a', 0)).toBe(3);
    expect((await session.listRange(`${p}l`, 0, -1)).map(dec)).toEqual(['B', 'c']);
  });

  it('pages sets with SSCAN', async () => {
    await session.setAdd(
      `${p}s`,
      Array.from({ length: 50 }, (_, i) => `m${i}`),
    );
    expect(await session.setRemove(`${p}s`, ['m0', 'nope'])).toBe(1);
    const members = new Set<string>();
    let cursor = '0';
    do {
      const page = await session.setScan(`${p}s`, { cursor, count: 10 });
      page.items.forEach((m) => members.add(dec(m)!));
      cursor = page.cursor;
    } while (cursor !== '0');
    expect(members.size).toBe(49);
  });

  it('reads sorted sets by index and score, and edits scores', async () => {
    expect(
      await session.zsetAdd(`${p}z`, [
        ['a', 1],
        ['b', 2.5],
        ['c', '3'],
        ['d', 'inf'],
      ]),
    ).toBe(4);
    expect(
      (await session.zsetRange(`${p}z`, { by: 'index', start: 0, stop: -1 })).map((e) => [
        dec(e.member),
        e.score,
        e.scoreText,
      ]),
    ).toEqual([
      ['a', 1, '1'],
      ['b', 2.5, '2.5'],
      ['c', 3, '3'],
      ['d', Infinity, 'inf'],
    ]);
    expect(
      (await session.zsetRange(`${p}z`, { by: 'index', start: 0, stop: 1, reverse: true })).map(
        (e) => dec(e.member),
      ),
    ).toEqual(['d', 'c']);
    expect(
      (await session.zsetRange(`${p}z`, { by: 'score', min: '(1', max: '3' })).map((e) =>
        dec(e.member),
      ),
    ).toEqual(['b', 'c']);
    expect(
      (
        await session.zsetRange(`${p}z`, {
          by: 'score',
          min: '-inf',
          max: '+inf',
          reverse: true,
          offset: 1,
          count: 2,
        })
      ).map((e) => dec(e.member)),
    ).toEqual(['c', 'b']);
    expect((await session.zsetIncrement(`${p}z`, 'a', 0.5)).score).toBe(1.5);
    expect(await session.zsetAdd(`${p}z`, [['a', 10]], { condition: 'xx' })).toBe(0);
    expect((await session.zsetScore(`${p}z`, 'a'))!.score).toBe(10);
    expect(await session.zsetScore(`${p}z`, 'nope')).toBeNull();
    expect(await session.zsetAdd(`${p}z`, [['a', 5]], { compare: 'gt' })).toBe(0);
    expect((await session.zsetScore(`${p}z`, 'a'))!.score).toBe(10);
    expect(await session.zsetRemove(`${p}z`, ['a'])).toBe(1);
    const page = await session.zsetScan(`${p}z`, { count: 100 });
    expect(page.items.map((e) => dec(e.member)).sort()).toEqual(['b', 'c', 'd']);
  });

  it('works with streams, consumer groups, pending entries, ack and claim', async () => {
    const k = `${p}x`;
    const ids: string[] = [];
    for (let i = 1; i <= 5; i++)
      ids.push(
        (await session.streamAdd(
          k,
          [
            ['n', String(i)],
            ['bin', Uint8Array.of(0xff)],
          ],
          { id: `${i}-0` },
        ))!,
      );
    expect(ids).toEqual(['1-0', '2-0', '3-0', '4-0', '5-0']);
    const all = await session.streamRange(k);
    expect(all).toHaveLength(5);
    expect(all[0]!.fields.map(([f, v]) => [dec(f), v])).toEqual([
      ['n', enc('1')],
      ['bin', Uint8Array.of(0xff)],
    ]);
    expect((await session.streamRange(k, { start: '2-0', end: '4-0' })).map((e) => e.id)).toEqual([
      '2-0',
      '3-0',
      '4-0',
    ]);
    expect((await session.streamRange(k, { reverse: true, count: 2 })).map((e) => e.id)).toEqual([
      '5-0',
      '4-0',
    ]);
    expect((await session.streamRange(k, { start: '(2-0', count: 1 })).map((e) => e.id)).toEqual([
      '3-0',
    ]);

    await session.streamGroupCreate(k, 'g1', '0');
    // Deliver three entries to consumer c1 through the CLI path.
    await session.command(['XREADGROUP', 'GROUP', 'g1', 'c1', 'COUNT', '3', 'STREAMS', k, '>']);
    const info = await session.streamInfo(k);
    expect(info).toMatchObject({ length: 5, groups: 1, lastGeneratedId: '5-0' });
    expect(info.firstEntry?.id).toBe('1-0');
    expect(info.lastEntry?.id).toBe('5-0');
    expect(await session.streamGroups(k)).toEqual([
      expect.objectContaining({ name: 'g1', consumers: 1, pending: 3, lastDeliveredId: '3-0' }),
    ]);
    expect((await session.streamConsumers(k, 'g1'))[0]).toMatchObject({ name: 'c1', pending: 3 });
    expect(await session.streamPending(k, 'g1')).toEqual({
      count: 3,
      smallestId: '1-0',
      largestId: '3-0',
      consumers: [{ name: 'c1', pending: 3 }],
    });
    const pending = await session.streamPendingRange(k, 'g1', { count: 10 });
    expect(pending.map((e) => [e.id, e.consumer, e.deliveries])).toEqual([
      ['1-0', 'c1', 1],
      ['2-0', 'c1', 1],
      ['3-0', 'c1', 1],
    ]);
    expect(await session.streamAck(k, 'g1', ['1-0'])).toBe(1);
    const claimed = await session.streamClaim(k, 'g1', 'c2', 0, ['2-0']);
    expect((claimed as { id: string }[]).map((e) => e.id)).toEqual(['2-0']);
    expect(await session.streamClaim(k, 'g1', 'c2', 0, ['3-0'], { justId: true })).toEqual(['3-0']);
    const auto = await session.streamAutoClaim(k, 'g1', 'c3', 0, '0-0', { count: 10 });
    expect((auto.claimed as { id: string }[]).map((e) => e.id)).toEqual(['2-0', '3-0']);
    expect(auto.next).toBe('0-0');
    expect((await session.streamPendingRange(k, 'g1', { consumer: 'c3' })).length).toBe(2);
    await session.streamGroupSetId(k, 'g1', '$');
    expect((await session.streamGroups(k))[0]!.lastDeliveredId).toBe('5-0');
    expect(await session.streamDelete(k, ['5-0'])).toBe(1);
    expect(await session.streamTrim(k, { strategy: 'maxlen', threshold: 2 })).toBe(2);
    expect((await session.streamRange(k)).map((e) => e.id)).toEqual(['3-0', '4-0']);
    await session.streamAdd(k, [['n', '6']], { trim: { strategy: 'maxlen', threshold: 1 } });
    expect(await session.streamRange(k)).toHaveLength(1);
    expect(await session.streamGroupDestroy(k, 'g1')).toBe(true);
  });

  it('reads HyperLogLogs, bitmaps and geo sets', async () => {
    await session.command(['PFADD', `${p}hll`, 'a', 'b', 'c']);
    await session.command(['PFADD', `${p}hll2`, 'c', 'd']);
    expect(await session.hllCount([`${p}hll`])).toBe(3);

    await session.command(['SETBIT', `${p}bits`, '0', '1']);
    await session.command(['SETBIT', `${p}bits`, '9', '1']);
    expect(await session.bitmapRange(`${p}bits`, 0, -1)).toEqual(
      Uint8Array.of(0b1000_0000, 0b0100_0000),
    );
    expect(await session.bitCount(`${p}bits`)).toBe(2);
    expect(await session.bitCount(`${p}bits`, { start: 1, end: 1 })).toBe(1);
    expect(await session.bitPos(`${p}bits`, 1, { start: 1 })).toBe(9);
    expect(await session.bitPos(`${p}bits`, 0)).toBe(1);

    await session.command([
      'GEOADD',
      `${p}geo`,
      '13.361389',
      '38.115556',
      'Palermo',
      '15.087269',
      '37.502669',
      'Catania',
    ]);
    const members = await session.geoMembers(`${p}geo`, 0, -1);
    expect(members.map((m) => dec(m.member))).toEqual(['Palermo', 'Catania']);
    expect(members[0]!.longitude).toBeCloseTo(13.361389, 5);
    const near = await session.geoSearch(`${p}geo`, {
      from: { longitude: 15, latitude: 37 },
      by: { radius: 200 },
      unit: 'km',
      sort: 'ASC',
    });
    expect(near.map((m) => dec(m.member))).toEqual(['Catania', 'Palermo']);
    expect(near[0]!.distance).toBeCloseTo(56.4413, 3);
    const box = await session.geoSearch(`${p}geo`, {
      from: { member: 'Palermo' },
      by: { width: 10, height: 10 },
      unit: 'km',
    });
    expect(box.map((m) => dec(m.member))).toEqual(['Palermo']);
  });

  it('edits RedisJSON documents, or refuses them when the module is not loaded', async () => {
    const created = await session
      .jsonSet(`${p}doc`, '$', '{"name":"a","tags":[1,2]}')
      .catch((e: unknown) => e);
    if (created instanceof JoineryError) {
      expect(created.code).toBe('NOT_SUPPORTED');
      expect(created.message).toMatch(/RedisJSON/);
      const read = await session.jsonGet(`${p}doc`).catch((e: unknown) => e);
      expect(read).toMatchObject({ code: 'NOT_SUPPORTED' });
      return;
    }
    // Redis 8 and Redis Stack ship RedisJSON.
    expect(created).toBe(true);
    expect(JSON.parse((await session.jsonGet(`${p}doc`))!)).toEqual([{ name: 'a', tags: [1, 2] }]);
    expect(await session.jsonSet(`${p}doc`, '$.name', '"b"', { condition: 'xx' })).toBe(true);
    expect(await session.jsonType(`${p}doc`, '$.tags')).toEqual(['array']);
    expect((await session.keyInfo([`${p}doc`]))[0]!.kind).toBe('json');
  });

  it('creates a key of each type with a TTL, atomically', async () => {
    await session.createKey(`${p}new:string`, { type: 'string', value: 'v' }, { ttlMs: 60_000 });
    await session.createKey(`${p}new:hash`, { type: 'hash', entries: [['f', 'v']] });
    await session.createKey(`${p}new:list`, { type: 'list', items: ['a', 'b'] });
    await session.createKey(`${p}new:set`, { type: 'set', members: ['a'] });
    await session.createKey(`${p}new:zset`, { type: 'zset', entries: [['a', 1]] });
    await session.createKey(`${p}new:stream`, { type: 'stream', fields: [['f', 'v']] });
    const info = await session.keyInfo(
      ['string', 'hash', 'list', 'set', 'zset', 'stream'].map((t) => `${p}new:${t}`),
    );
    expect(info.map((i) => [i.type, i.length])).toEqual([
      ['string', 1],
      ['hash', 1],
      ['list', 2],
      ['set', 1],
      ['zset', 1],
      ['stream', 1],
    ]);
    expect(info[0]!.ttlMs).toBeGreaterThan(50_000);
    expect(info[1]!.ttlMs).toBe(-1);
    expect(info[0]!.encoding).toBe('embstr');
    const conflict = await session
      .createKey(`${p}new:hash`, { type: 'string', value: 'x' })
      .catch((e: unknown) => e);
    expect((conflict as JoineryError).code).toBe('CONFLICT');
    const empty = await session
      .createKey(`${p}new:empty`, { type: 'list', items: [] })
      .catch((e: unknown) => e);
    expect((empty as JoineryError).code).toBe('VALIDATION_FAILED');
  });

  it('reports wrong-type access as a server error', async () => {
    await session.setString(`${p}str`, 'x');
    const error = await session.listRange(`${p}str`, 0, -1).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'SQL_ERROR', engineCode: 'WRONGTYPE' });
  });
});
