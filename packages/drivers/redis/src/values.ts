import { JoineryError } from '@joinery/core';
import { toBytes, type RedisBytes } from '@joinery/redis-tools';

import type { Arg } from './client';
import type { RedisContext } from './context';
import { exists, tombstone } from './keys';
import { asArray, asBytes, asNumber, asRecord, asText } from './replies';
import type {
  ClaimOptions,
  CursorOptions,
  CursorPage,
  GeoMember,
  GeoSearchOptions,
  HashEntry,
  NewKeyValue,
  PendingEntry,
  PendingRangeOptions,
  PendingSummary,
  SetStringOptions,
  StreamAddOptions,
  StreamConsumer,
  StreamEntry,
  StreamGroup,
  StreamInfo,
  StreamRangeOptions,
  StreamTrimOptions,
  StringReadOptions,
  StringValue,
  ZRangeOptions,
  ZSetEntry,
} from './types';

/**
 * Reads and writes per value type, for the value editors (spec §10). Collections are read in
 * pages (SCAN cursors or index windows), strings in byte ranges, so large values stay cheap.
 */

const MiB = 1024 * 1024;

function cursorArgs(options: CursorOptions): Arg[] {
  const args: Arg[] = [options.cursor ?? '0'];
  if (options.match !== undefined) args.push('MATCH', toBytes(options.match));
  args.push('COUNT', options.count ?? 200);
  return args;
}

function pairs(raw: unknown): [Uint8Array, Uint8Array][] {
  const items = asArray(raw);
  const out: [Uint8Array, Uint8Array][] = [];
  for (let i = 0; i + 1 < items.length; i += 2)
    out.push([asBytes(items[i])!, asBytes(items[i + 1])!]);
  return out;
}

function zsetEntry(member: unknown, score: unknown): ZSetEntry {
  const scoreText = asText(score) ?? '0';
  return { member: asBytes(member)!, score: asNumber(score) ?? Number.NaN, scoreText };
}

function streamEntry(raw: unknown): StreamEntry {
  const [id, fields] = asArray(raw);
  return { id: asText(id) ?? '', fields: pairs(fields) };
}

function streamEntries(raw: unknown): StreamEntry[] {
  return asArray(raw)
    .filter((e) => Array.isArray(e))
    .map(streamEntry);
}

// ---------------------------------------------------------------------------------------------
// Strings

/** A string value, or a byte range of a large one (GETRANGE); null when the key is missing. */
export async function getString(
  ctx: RedisContext,
  key: RedisBytes,
  options: StringReadOptions = {},
): Promise<StringValue | null> {
  const k = toBytes(key);
  const offset = Math.max(0, options.offset ?? 0);
  const maxBytes = Math.max(1, options.maxBytes ?? MiB);
  const size = asNumber(await ctx.call(['strlen', k])) ?? 0;
  if (size === 0 && (await exists(ctx, [k])) === 0) return null;
  if (offset === 0 && size <= maxBytes) {
    const bytes = asBytes(await ctx.call(['get', k]));
    return bytes === null ? null : { bytes, size: bytes.length, offset: 0, truncated: false };
  }
  const bytes =
    asBytes(await ctx.call(['getrange', k, offset, offset + maxBytes - 1])) ?? new Uint8Array(0);
  return { bytes, size, offset, truncated: offset > 0 || offset + bytes.length < size };
}

export async function setString(
  ctx: RedisContext,
  key: RedisBytes,
  value: RedisBytes,
  options: SetStringOptions = {},
): Promise<boolean> {
  const args: Arg[] = ['set', toBytes(key), toBytes(value)];
  if (options.condition) args.push(options.condition.toUpperCase());
  if (options.ttlMs !== undefined) args.push('PX', Math.max(1, Math.round(options.ttlMs)));
  else if (options.keepTtl) args.push('KEEPTTL');
  return (await ctx.call(args)) !== null;
}

// ---------------------------------------------------------------------------------------------
// Hashes, lists, sets

export async function hashScan(
  ctx: RedisContext,
  key: RedisBytes,
  options: CursorOptions = {},
): Promise<CursorPage<HashEntry>> {
  const [cursor, items] = asArray(await ctx.call(['hscan', toBytes(key), ...cursorArgs(options)]));
  const next = asText(cursor) ?? '0';
  return {
    items: pairs(items).map(([field, value]) => ({ field, value })),
    cursor: next,
    done: next === '0',
  };
}

export async function hashGet(
  ctx: RedisContext,
  key: RedisBytes,
  fields: readonly RedisBytes[],
): Promise<(Uint8Array | null)[]> {
  if (fields.length === 0) return [];
  return asArray(await ctx.call(['hmget', toBytes(key), ...fields.map(toBytes)])).map(asBytes);
}

export async function listRange(
  ctx: RedisContext,
  key: RedisBytes,
  start: number,
  stop: number,
): Promise<Uint8Array[]> {
  return asArray(await ctx.call(['lrange', toBytes(key), start, stop])).map((v) => asBytes(v)!);
}

/**
 * Removes the element at `index` if it still equals `expected`: a Lua script swaps it for a
 * unique tombstone and removes that, atomically. False when the element changed.
 */
export async function listRemoveAt(
  ctx: RedisContext,
  key: RedisBytes,
  index: number,
  expected: RedisBytes,
): Promise<boolean> {
  const script = `local v = redis.call('LINDEX', KEYS[1], ARGV[1])
if v ~= ARGV[2] then return 0 end
redis.call('LSET', KEYS[1], ARGV[1], ARGV[3])
redis.call('LREM', KEYS[1], 1, ARGV[3])
return 1`;
  const reply = await ctx.call([
    'eval',
    script,
    1,
    toBytes(key),
    index,
    toBytes(expected),
    tombstone(),
  ]);
  return asNumber(reply) === 1;
}

export async function setScan(
  ctx: RedisContext,
  key: RedisBytes,
  options: CursorOptions = {},
): Promise<CursorPage<Uint8Array>> {
  const [cursor, items] = asArray(await ctx.call(['sscan', toBytes(key), ...cursorArgs(options)]));
  const next = asText(cursor) ?? '0';
  return { items: asArray(items).map((m) => asBytes(m)!), cursor: next, done: next === '0' };
}

// ---------------------------------------------------------------------------------------------
// Sorted sets

export async function zsetRange(
  ctx: RedisContext,
  key: RedisBytes,
  options: ZRangeOptions,
): Promise<ZSetEntry[]> {
  const args: Arg[] = ['zrange', toBytes(key)];
  if (options.by === 'index') {
    args.push(options.start, options.stop);
    if (options.reverse) args.push('REV');
  } else {
    // With REV the bounds are given high first.
    args.push(
      options.reverse ? options.max : options.min,
      options.reverse ? options.min : options.max,
      'BYSCORE',
    );
    if (options.reverse) args.push('REV');
    if (options.count !== undefined) args.push('LIMIT', options.offset ?? 0, options.count);
  }
  args.push('WITHSCORES');
  const items = asArray(await ctx.call(args));
  const out: ZSetEntry[] = [];
  for (let i = 0; i + 1 < items.length; i += 2) out.push(zsetEntry(items[i], items[i + 1]));
  return out;
}

export async function zsetScan(
  ctx: RedisContext,
  key: RedisBytes,
  options: CursorOptions = {},
): Promise<CursorPage<ZSetEntry>> {
  const [cursor, items] = asArray(await ctx.call(['zscan', toBytes(key), ...cursorArgs(options)]));
  const next = asText(cursor) ?? '0';
  const flat = asArray(items);
  const entries: ZSetEntry[] = [];
  for (let i = 0; i + 1 < flat.length; i += 2) entries.push(zsetEntry(flat[i], flat[i + 1]));
  return { items: entries, cursor: next, done: next === '0' };
}

export async function zsetScore(
  ctx: RedisContext,
  key: RedisBytes,
  member: RedisBytes,
): Promise<ZSetEntry | null> {
  const score = await ctx.call(['zscore', toBytes(key), toBytes(member)]);
  return score === null ? null : zsetEntry(toBytes(member), score);
}

export async function zsetAdd(
  ctx: RedisContext,
  key: RedisBytes,
  entries: readonly (readonly [RedisBytes, number | string])[],
  options: { readonly condition?: 'nx' | 'xx'; readonly compare?: 'gt' | 'lt' } = {},
): Promise<number> {
  if (entries.length === 0) return 0;
  const args: Arg[] = ['zadd', toBytes(key)];
  if (options.condition) args.push(options.condition.toUpperCase());
  if (options.compare) args.push(options.compare.toUpperCase());
  for (const [member, score] of entries) args.push(String(score), toBytes(member));
  return asNumber(await ctx.call(args)) ?? 0;
}

export async function zsetIncrement(
  ctx: RedisContext,
  key: RedisBytes,
  member: RedisBytes,
  by: number | string,
): Promise<ZSetEntry> {
  const score = await ctx.call(['zincrby', toBytes(key), String(by), toBytes(member)]);
  return zsetEntry(toBytes(member), score);
}

// ---------------------------------------------------------------------------------------------
// Streams

export async function streamRange(
  ctx: RedisContext,
  key: RedisBytes,
  options: StreamRangeOptions = {},
): Promise<StreamEntry[]> {
  const start = options.start ?? '-';
  const end = options.end ?? '+';
  const args: Arg[] = options.reverse
    ? ['xrevrange', toBytes(key), end === '-' ? '+' : end, start === '+' ? '-' : start]
    : ['xrange', toBytes(key), start, end];
  if (options.count !== undefined) args.push('COUNT', options.count);
  return streamEntries(await ctx.call(args));
}

export async function streamInfo(ctx: RedisContext, key: RedisBytes): Promise<StreamInfo> {
  const record = asRecord(await ctx.call(['xinfo', 'stream', toBytes(key)]));
  const fields: Record<string, string> = {};
  for (const [name, value] of Object.entries(record)) {
    if (!Array.isArray(value)) fields[name] = asText(value) ?? '';
  }
  const entry = (raw: unknown): StreamEntry | null =>
    Array.isArray(raw) ? streamEntry(raw) : null;
  return {
    length: asNumber(record['length']) ?? 0,
    radixTreeKeys: asNumber(record['radix-tree-keys']) ?? 0,
    radixTreeNodes: asNumber(record['radix-tree-nodes']) ?? 0,
    groups: asNumber(record['groups']) ?? 0,
    lastGeneratedId: asText(record['last-generated-id']) ?? '',
    firstEntry: entry(record['first-entry']),
    lastEntry: entry(record['last-entry']),
    fields,
  };
}

export async function streamGroups(ctx: RedisContext, key: RedisBytes): Promise<StreamGroup[]> {
  return asArray(await ctx.call(['xinfo', 'groups', toBytes(key)])).map((raw) => {
    const g = asRecord(raw);
    return {
      name: asText(g['name']) ?? '',
      consumers: asNumber(g['consumers']) ?? 0,
      pending: asNumber(g['pending']) ?? 0,
      lastDeliveredId: asText(g['last-delivered-id']) ?? '',
      ...('entries-read' in g ? { entriesRead: asNumber(g['entries-read']) } : {}),
      ...('lag' in g ? { lag: asNumber(g['lag']) } : {}),
    };
  });
}

export async function streamConsumers(
  ctx: RedisContext,
  key: RedisBytes,
  group: RedisBytes,
): Promise<StreamConsumer[]> {
  return asArray(await ctx.call(['xinfo', 'consumers', toBytes(key), toBytes(group)])).map(
    (raw) => {
      const c = asRecord(raw);
      const inactive = asNumber(c['inactive']);
      return {
        name: asText(c['name']) ?? '',
        pending: asNumber(c['pending']) ?? 0,
        idleMs: asNumber(c['idle']) ?? 0,
        ...(inactive !== null ? { inactiveMs: inactive } : {}),
      };
    },
  );
}

export async function streamPending(
  ctx: RedisContext,
  key: RedisBytes,
  group: RedisBytes,
): Promise<PendingSummary> {
  const [count, smallest, largest, consumers] = asArray(
    await ctx.call(['xpending', toBytes(key), toBytes(group)]),
  );
  return {
    count: asNumber(count) ?? 0,
    smallestId: asText(smallest),
    largestId: asText(largest),
    consumers: asArray(consumers).map((raw) => {
      const [name, pending] = asArray(raw);
      return { name: asText(name) ?? '', pending: asNumber(pending) ?? 0 };
    }),
  };
}

export async function streamPendingRange(
  ctx: RedisContext,
  key: RedisBytes,
  group: RedisBytes,
  options: PendingRangeOptions = {},
): Promise<PendingEntry[]> {
  const args: Arg[] = ['xpending', toBytes(key), toBytes(group)];
  if (options.minIdleMs !== undefined) args.push('IDLE', options.minIdleMs);
  args.push(options.start ?? '-', options.end ?? '+', options.count ?? 100);
  if (options.consumer !== undefined) args.push(toBytes(options.consumer));
  return asArray(await ctx.call(args)).map((raw) => {
    const [id, consumer, idle, deliveries] = asArray(raw);
    return {
      id: asText(id) ?? '',
      consumer: asText(consumer) ?? '',
      idleMs: asNumber(idle) ?? 0,
      deliveries: asNumber(deliveries) ?? 0,
    };
  });
}

function trimArgs(trim: StreamTrimOptions): Arg[] {
  const args: Arg[] = [trim.strategy.toUpperCase()];
  if (trim.approximate) args.push('~');
  args.push(String(trim.threshold));
  if (trim.limit !== undefined) args.push('LIMIT', trim.limit);
  return args;
}

export async function streamAdd(
  ctx: RedisContext,
  key: RedisBytes,
  fields: readonly (readonly [RedisBytes, RedisBytes])[],
  options: StreamAddOptions = {},
): Promise<string | null> {
  if (fields.length === 0) {
    throw new JoineryError({
      code: 'VALIDATION_FAILED',
      message: 'A stream entry needs at least one field',
    });
  }
  const args: Arg[] = ['xadd', toBytes(key)];
  if (options.noMkStream) args.push('NOMKSTREAM');
  if (options.trim) args.push(...trimArgs(options.trim));
  args.push(options.id ?? '*');
  for (const [f, v] of fields) args.push(toBytes(f), toBytes(v));
  return asText(await ctx.call(args));
}

export async function streamTrim(
  ctx: RedisContext,
  key: RedisBytes,
  options: StreamTrimOptions,
): Promise<number> {
  return asNumber(await ctx.call(['xtrim', toBytes(key), ...trimArgs(options)])) ?? 0;
}

export async function streamClaim(
  ctx: RedisContext,
  key: RedisBytes,
  group: RedisBytes,
  consumer: RedisBytes,
  minIdleMs: number,
  ids: readonly string[],
  options: ClaimOptions = {},
): Promise<StreamEntry[] | string[]> {
  const args: Arg[] = [
    'xclaim',
    toBytes(key),
    toBytes(group),
    toBytes(consumer),
    minIdleMs,
    ...ids,
  ];
  if (options.idleMs !== undefined) args.push('IDLE', options.idleMs);
  if (options.retryCount !== undefined) args.push('RETRYCOUNT', options.retryCount);
  if (options.force) args.push('FORCE');
  if (options.justId) args.push('JUSTID');
  const reply = await ctx.call(args);
  return options.justId ? asArray(reply).map((id) => asText(id) ?? '') : streamEntries(reply);
}

export async function streamAutoClaim(
  ctx: RedisContext,
  key: RedisBytes,
  group: RedisBytes,
  consumer: RedisBytes,
  minIdleMs: number,
  start = '0-0',
  options: { readonly count?: number; readonly justId?: boolean } = {},
): Promise<{ next: string; claimed: StreamEntry[] | string[]; deleted: string[] }> {
  const args: Arg[] = [
    'xautoclaim',
    toBytes(key),
    toBytes(group),
    toBytes(consumer),
    minIdleMs,
    start,
  ];
  if (options.count !== undefined) args.push('COUNT', options.count);
  if (options.justId) args.push('JUSTID');
  const [next, claimed, deleted] = asArray(await ctx.call(args));
  return {
    next: asText(next) ?? '0-0',
    claimed: options.justId
      ? asArray(claimed).map((id) => asText(id) ?? '')
      : streamEntries(claimed),
    deleted: asArray(deleted).map((id) => asText(id) ?? ''),
  };
}

// ---------------------------------------------------------------------------------------------
// RedisJSON, HyperLogLog, bitmaps, geo

function jsonNotLoaded(error: unknown): never {
  if (error instanceof JoineryError && /unknown command/i.test(error.message)) {
    throw new JoineryError(
      {
        code: 'NOT_SUPPORTED',
        message: 'The RedisJSON module is not loaded on this server',
        hint: 'Load RedisJSON (Redis Stack, Redis 8 or valkey-json) to edit JSON documents',
      },
      { cause: error },
    );
  }
  throw error;
}

export async function jsonGet(
  ctx: RedisContext,
  key: RedisBytes,
  path = '$',
): Promise<string | null> {
  try {
    return asText(await ctx.call(['json.get', toBytes(key), path]));
  } catch (error) {
    return jsonNotLoaded(error);
  }
}

export async function jsonType(ctx: RedisContext, key: RedisBytes, path = '$'): Promise<string[]> {
  try {
    const reply = await ctx.call(['json.type', toBytes(key), path]);
    if (reply === null) return [];
    return Array.isArray(reply) ? reply.flat().map((t) => asText(t) ?? '') : [asText(reply) ?? ''];
  } catch (error) {
    return jsonNotLoaded(error);
  }
}

export async function jsonSet(
  ctx: RedisContext,
  key: RedisBytes,
  path: string,
  json: string,
  condition?: 'nx' | 'xx',
): Promise<boolean> {
  const args: Arg[] = ['json.set', toBytes(key), path, json];
  if (condition) args.push(condition.toUpperCase());
  try {
    return (await ctx.call(args)) !== null;
  } catch (error) {
    return jsonNotLoaded(error);
  }
}

export async function geoMembers(
  ctx: RedisContext,
  key: RedisBytes,
  start: number,
  stop: number,
): Promise<GeoMember[]> {
  const k = toBytes(key);
  const members = asArray(await ctx.call(['zrange', k, start, stop])).map((m) => asBytes(m)!);
  if (members.length === 0) return [];
  const positions = asArray(await ctx.call(['geopos', k, ...members]));
  return members.flatMap((member, i): GeoMember[] => {
    const [lon, lat] = asArray(positions[i]);
    const longitude = asNumber(lon);
    const latitude = asNumber(lat);
    return longitude === null || latitude === null ? [] : [{ member, longitude, latitude }];
  });
}

export async function geoSearch(
  ctx: RedisContext,
  key: RedisBytes,
  options: GeoSearchOptions,
): Promise<GeoMember[]> {
  const unit = options.unit ?? 'm';
  const args: Arg[] = ['geosearch', toBytes(key)];
  if ('member' in options.from) args.push('FROMMEMBER', toBytes(options.from.member));
  else args.push('FROMLONLAT', String(options.from.longitude), String(options.from.latitude));
  if ('radius' in options.by) args.push('BYRADIUS', String(options.by.radius), unit);
  else args.push('BYBOX', String(options.by.width), String(options.by.height), unit);
  if (options.sort) args.push(options.sort);
  if (options.count !== undefined) {
    args.push('COUNT', options.count);
    if (options.any) args.push('ANY');
  }
  args.push('WITHCOORD', 'WITHDIST');
  return asArray(await ctx.call(args)).map((raw) => {
    const [member, distance, coords] = asArray(raw);
    const [lon, lat] = asArray(coords);
    return {
      member: asBytes(member)!,
      longitude: asNumber(lon) ?? 0,
      latitude: asNumber(lat) ?? 0,
      distance: asNumber(distance) ?? 0,
    };
  });
}

// ---------------------------------------------------------------------------------------------
// Creating keys

function requireItems(count: number, what: string): void {
  if (count === 0) {
    throw new JoineryError({
      code: 'VALIDATION_FAILED',
      message: `A new ${what} needs at least one element (Redis does not store empty collections)`,
    });
  }
}

/**
 * Creates a key of any type with its first contents and an optional TTL, atomically (MULTI).
 * Fails CONFLICT when the key already exists.
 */
export async function createKey(
  ctx: RedisContext,
  key: RedisBytes,
  value: NewKeyValue,
  ttlMs?: number,
): Promise<void> {
  const k = toBytes(key);
  if ((await exists(ctx, [k])) > 0) {
    throw new JoineryError({
      code: 'CONFLICT',
      message: 'A key with this name already exists',
      hint: 'Pick another name, or open the existing key',
    });
  }
  let command: Arg[];
  switch (value.type) {
    case 'string':
      command = ['set', k, toBytes(value.value), 'NX'];
      break;
    case 'hash':
      requireItems(value.entries.length, 'hash');
      command = ['hset', k, ...value.entries.flatMap(([f, v]) => [toBytes(f), toBytes(v)])];
      break;
    case 'list':
      requireItems(value.items.length, 'list');
      command = ['rpush', k, ...value.items.map(toBytes)];
      break;
    case 'set':
      requireItems(value.members.length, 'set');
      command = ['sadd', k, ...value.members.map(toBytes)];
      break;
    case 'zset':
      requireItems(value.entries.length, 'sorted set');
      command = ['zadd', k, ...value.entries.flatMap(([m, s]) => [String(s), toBytes(m)])];
      break;
    case 'stream':
      requireItems(value.fields.length, 'stream entry');
      command = [
        'xadd',
        k,
        value.id ?? '*',
        ...value.fields.flatMap(([f, v]) => [toBytes(f), toBytes(v)]),
      ];
      break;
    case 'json':
      command = ['json.set', k, '$', value.json, 'NX'];
      break;
  }
  const commands: Arg[][] = [command];
  if (ttlMs !== undefined && ttlMs > 0) commands.push(['pexpire', k, Math.round(ttlMs)]);
  try {
    await ctx.transaction(commands);
  } catch (error) {
    if (value.type === 'json') jsonNotLoaded(error);
    throw error;
  }
}
