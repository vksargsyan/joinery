import { QuerybaraError } from '@querybara/core';
import { bytesKey, keySlot, toBytes, utf8Bytes, type RedisBytes } from '@querybara/redis-tools';
import type { Redis } from 'ioredis';

import { addressOf, type Arg } from './client';
import { throwIfAborted, type RedisContext } from './context';
import { asArray, asBytes, asNumber, asText } from './replies';
import type {
  BulkDeleteOptions,
  BulkDeleteResult,
  CopyOptions,
  CopyResult,
  DumpedKey,
  KeyInfo,
  RedisKeyKind,
  RestoreOptions,
  ScanOptions,
  ScanPageOptions,
  ScanPageResult,
  ScanResult,
} from './types';

/**
 * Key services (spec §10): SCAN-based listing (never KEYS), key metadata, deletes, TTLs,
 * renames, copies, bulk delete by pattern and DUMP/RESTORE for transfer and backup.
 */

const DEFAULT_SCAN_COUNT = 500;

function scanArgs(cursor: string, options: ScanOptions): Arg[] {
  const args: Arg[] = ['scan', cursor];
  if (options.match !== undefined) args.push('MATCH', toBytes(options.match));
  args.push('COUNT', options.count ?? DEFAULT_SCAN_COUNT);
  if (options.type) args.push('TYPE', options.type);
  return args;
}

async function scanNode(
  ctx: RedisContext,
  node: Redis | undefined,
  cursor: string,
  options: ScanOptions,
): Promise<{ cursor: string; keys: Uint8Array[] }> {
  const reply = asArray(await ctx.call(scanArgs(cursor, options), node));
  return {
    cursor: asText(reply[0]) ?? '0',
    keys: asArray(reply[1]).map((k) => asBytes(k)!),
  };
}

/**
 * One SCAN step. In Cluster mode (without `node`) every primary is scanned in parallel and the
 * cursor is composite ("host:port@cursor,..." for the nodes not finished yet); pass it back
 * unchanged. A topology change during a scan can repeat or skip keys, as SCAN itself can.
 */
export async function scan(ctx: RedisContext, options: ScanOptions = {}): Promise<ScanResult> {
  const cursor = options.cursor && options.cursor !== '' ? options.cursor : '0';
  if (!ctx.conn.isCluster || options.node !== undefined) {
    const node = options.node !== undefined ? ctx.nodeFor(options.node) : undefined;
    const step = await scanNode(ctx, node, cursor, options);
    return { keys: step.keys, cursor: step.cursor, done: step.cursor === '0' };
  }
  const positions: { node: Redis; cursor: string }[] = [];
  if (cursor === '0') {
    for (const node of ctx.conn.primaries()) positions.push({ node, cursor: '0' });
  } else {
    for (const part of cursor.split(',')) {
      const at = part.lastIndexOf('@');
      if (at <= 0) {
        throw new QuerybaraError({
          code: 'VALIDATION_FAILED',
          message: 'The cluster scan cursor is not valid',
          hint: 'Start the scan again from cursor "0"',
        });
      }
      positions.push({ node: ctx.nodeFor(part.slice(0, at)), cursor: part.slice(at + 1) });
    }
  }
  const steps = await Promise.all(positions.map((p) => scanNode(ctx, p.node, p.cursor, options)));
  const keys = steps.flatMap((s) => s.keys);
  const next = positions
    .map((p, i) => ({ address: addressOf(p.node), cursor: steps[i]!.cursor }))
    .filter((p) => p.cursor !== '0')
    .map((p) => `${p.address}@${p.cursor}`);
  return next.length === 0
    ? { keys, cursor: '0', done: true }
    : { keys, cursor: next.join(','), done: false };
}

/**
 * Fills a page of the key browser: SCAN until `limit` keys are found, the scan ends, or the
 * call / time budget runs out (SCAN with a selective MATCH can return nothing for many calls).
 */
export async function scanPage(
  ctx: RedisContext,
  options: ScanPageOptions,
): Promise<ScanPageResult> {
  const maxCalls = options.maxCalls ?? 50;
  const deadline = performance.now() + (options.timeBudgetMs ?? 2000);
  const keys: Uint8Array[] = [];
  let cursor = options.cursor ?? '0';
  let calls = 0;
  let done: boolean;
  do {
    throwIfAborted(options.signal);
    const step = await scan(ctx, { ...options, cursor });
    calls += 1;
    keys.push(...step.keys);
    cursor = step.cursor;
    done = step.done;
  } while (
    !done &&
    keys.length < options.limit &&
    calls < maxCalls &&
    performance.now() < deadline
  );
  return {
    keys,
    cursor,
    done,
    calls,
    budgetExhausted: !done && keys.length < options.limit,
  };
}

const LENGTH_COMMANDS: Readonly<Record<string, string>> = {
  string: 'strlen',
  hash: 'hlen',
  list: 'llen',
  set: 'scard',
  zset: 'zcard',
  stream: 'xlen',
};

export function kindOf(type: string): RedisKeyKind {
  switch (type) {
    case 'string':
    case 'hash':
    case 'list':
    case 'set':
    case 'zset':
    case 'stream':
    case 'none':
      return type;
    case 'ReJSON-RL':
      return 'json';
    case '':
      return 'unknown';
    default:
      return 'module';
  }
}

/** True for an error the server answered with (as opposed to a closed connection or CONFLICT). */
export function isServerError(error: unknown): error is QuerybaraError {
  return error instanceof QuerybaraError && error.code === 'SQL_ERROR';
}

/** The value, or null when the server refused the command (NOPERM, unknown command...). */
async function orNull<T>(work: Promise<T>): Promise<T | null> {
  try {
    return await work;
  } catch (error) {
    if (isServerError(error)) return null;
    throw error;
  }
}

/** TYPE, PTTL, OBJECT ENCODING and the length by type for each key (NOPERM-tolerant). */
export async function keyInfo(ctx: RedisContext, keys: readonly RedisBytes[]): Promise<KeyInfo[]> {
  return Promise.all(
    keys.map(async (input): Promise<KeyInfo> => {
      const key = toBytes(input);
      let type: string;
      try {
        type = asText(await ctx.call(['type', key])) ?? 'none';
      } catch (error) {
        if (!isServerError(error)) throw error;
        const message = error.message;
        return {
          key,
          type: '',
          kind: 'unknown',
          ttlMs: -2,
          encoding: null,
          length: null,
          error: message,
        };
      }
      if (type === 'none') {
        return { key, type, kind: 'none', ttlMs: -2, encoding: null, length: null };
      }
      const lengthCommand = LENGTH_COMMANDS[type];
      const [ttl, encoding, length] = await Promise.all([
        orNull(ctx.call(['pttl', key])),
        orNull(ctx.call(['object', 'encoding', key])),
        lengthCommand ? orNull(ctx.call([lengthCommand, key])) : Promise.resolve(null),
      ]);
      return {
        key,
        type,
        kind: kindOf(type),
        ttlMs: asNumber(ttl) ?? -1,
        encoding: asText(encoding),
        length: asNumber(length),
      };
    }),
  );
}

/** MEMORY USAGE per key; null for a missing key, or when the server refuses (NOPERM, ACL). */
export async function memoryUsage(
  ctx: RedisContext,
  keys: readonly RedisBytes[],
  samples?: number,
): Promise<(number | null)[]> {
  return Promise.all(
    keys.map(async (key) => {
      const args: Arg[] = ['memory', 'usage', toBytes(key)];
      if (samples !== undefined) args.push('SAMPLES', samples);
      return asNumber(await orNull(ctx.call(args)));
    }),
  );
}

/** Groups keys by hash slot so multi-key commands stay within one slot in Cluster mode. */
function bySlot(ctx: RedisContext, keys: readonly Uint8Array[]): Uint8Array[][] {
  if (!ctx.conn.isCluster) return keys.length > 0 ? [[...keys]] : [];
  const groups = new Map<number, Uint8Array[]>();
  for (const key of keys) {
    const slot = keySlot(key);
    const group = groups.get(slot);
    if (group) group.push(key);
    else groups.set(slot, [key]);
  }
  return [...groups.values()];
}

export async function exists(ctx: RedisContext, keys: readonly RedisBytes[]): Promise<number> {
  const groups = bySlot(ctx, keys.map(toBytes));
  const counts = await Promise.all(groups.map((g) => ctx.call(['exists', ...g])));
  return counts.reduce<number>((sum, n) => sum + (asNumber(n) ?? 0), 0);
}

/** UNLINK (the server frees memory in the background); one command per slot in Cluster mode. */
export async function deleteKeys(ctx: RedisContext, keys: readonly RedisBytes[]): Promise<number> {
  const groups = bySlot(ctx, keys.map(toBytes));
  const counts = await Promise.all(groups.map((g) => ctx.call(['unlink', ...g])));
  return counts.reduce<number>((sum, n) => sum + (asNumber(n) ?? 0), 0);
}

export async function dbSize(ctx: RedisContext, node?: string): Promise<number> {
  const nodes = ctx.scanNodes(node);
  const sizes = await Promise.all(nodes.map((n) => ctx.call(['dbsize'], n)));
  return sizes.reduce<number>((sum, n) => sum + (asNumber(n) ?? 0), 0);
}

/** PEXPIRE, or PERSIST for null; false when the key does not exist (or had no TTL to remove). */
export async function expire(
  ctx: RedisContext,
  key: RedisBytes,
  ttlMs: number | null,
): Promise<boolean> {
  const reply =
    ttlMs === null
      ? await ctx.call(['persist', toBytes(key)])
      : await ctx.call(['pexpire', toBytes(key), Math.max(0, Math.round(ttlMs))]);
  return asNumber(reply) === 1;
}

function sameSlot(ctx: RedisContext, a: Uint8Array, b: Uint8Array): boolean {
  return !ctx.conn.isCluster || keySlot(a) === keySlot(b);
}

/**
 * RENAME / RENAMENX. In Cluster mode a rename across hash slots is done as DUMP + RESTORE (with
 * the TTL) + DEL, which is not atomic.
 */
export async function rename(
  ctx: RedisContext,
  source: RedisBytes,
  destination: RedisBytes,
  onlyIfNew = false,
): Promise<boolean> {
  const src = toBytes(source);
  const dst = toBytes(destination);
  if (sameSlot(ctx, src, dst)) {
    try {
      const reply = await ctx.call([onlyIfNew ? 'renamenx' : 'rename', src, dst]);
      return onlyIfNew ? asNumber(reply) === 1 : true;
    } catch (error) {
      if (isServerError(error) && /no such key/i.test(error.message)) {
        throw new QuerybaraError(
          { code: 'NOT_FOUND', message: 'The key does not exist' },
          { cause: error },
        );
      }
      throw error;
    }
  }
  if ((await exists(ctx, [src])) === 0) {
    throw new QuerybaraError({ code: 'NOT_FOUND', message: 'The key does not exist' });
  }
  const moved = await dumpRestore(ctx, src, dst, !onlyIfNew, undefined);
  if (moved) await ctx.call(['unlink', src]);
  return moved;
}

async function dumpRestore(
  ctx: RedisContext,
  src: Uint8Array,
  dst: Uint8Array,
  replace: boolean,
  db: number | undefined,
): Promise<boolean> {
  const [dump] = await dumpKeys(ctx, [src]);
  if (!dump?.payload) return false;
  try {
    const restored = await restoreKeys(ctx, [{ ...dump, key: dst }], {
      replace,
      ...(db !== undefined ? { db } : {}),
    });
    return restored === 1;
  } catch (error) {
    if (error instanceof QuerybaraError && error.engineCode === 'BUSYKEY') return false;
    throw error;
  }
}

/**
 * Copies a key: COPY (Redis 6.2+, optionally into another database), else DUMP + RESTORE
 * keeping the TTL (older servers, other databases where COPY is refused, and across hash slots
 * in Cluster mode). `copied` is false when the destination exists and `replace` is off.
 */
export async function copy(
  ctx: RedisContext,
  source: RedisBytes,
  destination: RedisBytes,
  options: CopyOptions = {},
): Promise<CopyResult> {
  const src = toBytes(source);
  const dst = toBytes(destination);
  if (options.db !== undefined && ctx.conn.isCluster && options.db !== 0) {
    throw new QuerybaraError({
      code: 'NOT_SUPPORTED',
      message: 'A cluster has only database 0',
    });
  }
  if (sameSlot(ctx, src, dst)) {
    const args: Arg[] = ['copy', src, dst];
    if (options.db !== undefined && options.db !== ctx.database) args.push('DB', options.db);
    if (options.replace) args.push('REPLACE');
    try {
      return { copied: asNumber(await ctx.call(args)) === 1, method: 'copy' };
    } catch (error) {
      if (!(error instanceof QuerybaraError) || !/unknown command|NOPERM/i.test(error.message))
        throw error;
    }
  }
  const copied = await dumpRestore(ctx, src, dst, options.replace === true, options.db);
  return { copied, method: 'dump-restore' };
}

/** DUMP + PTTL for each key, for transfer and backup (spec §12, §14). */
export async function dumpKeys(
  ctx: RedisContext,
  keys: readonly RedisBytes[],
): Promise<DumpedKey[]> {
  return Promise.all(
    keys.map(async (input): Promise<DumpedKey> => {
      const key = toBytes(input);
      const [payload, ttl] = await Promise.all([ctx.call(['dump', key]), ctx.call(['pttl', key])]);
      const ttlMs = asNumber(ttl) ?? -1;
      return {
        key,
        payload: asBytes(payload),
        ttlMs: ttlMs >= 0 ? ttlMs : -1,
        expireAtMs: ttlMs >= 0 ? Date.now() + ttlMs : null,
      };
    }),
  );
}

/**
 * RESTORE keys from `dumpKeys`, keeping their TTLs (relative, or absolute with ABSTTL). Keys
 * whose absolute expiry has passed are skipped. Returns how many were restored; an existing
 * key fails with BUSYKEY unless `replace`.
 */
export async function restoreKeys(
  ctx: RedisContext,
  keys: readonly DumpedKey[],
  options: RestoreOptions = {},
): Promise<number> {
  const commands: Arg[][] = [];
  const now = Date.now();
  for (const entry of keys) {
    if (!entry.payload) continue;
    const args: Arg[] = ['restore', entry.key];
    if (options.absoluteTtl && entry.expireAtMs !== null) {
      if (entry.expireAtMs <= now) continue;
      args.push(entry.expireAtMs, entry.payload, 'ABSTTL');
    } else {
      args.push(entry.ttlMs > 0 ? entry.ttlMs : 0, entry.payload);
    }
    if (options.replace) args.push('REPLACE');
    commands.push(args);
  }
  if (commands.length === 0) return 0;
  if (options.db !== undefined && !ctx.conn.isCluster && options.db !== ctx.database) {
    await ctx.inDatabase(options.db, commands);
  } else {
    await Promise.all(commands.map((c) => ctx.call(c)));
  }
  return commands.length;
}

/**
 * Bulk delete by pattern (spec §10): SCAN + UNLINK in batches, cluster-aware, with progress and
 * cancellation. A dry run only counts. Keys the ACL user may not delete are counted as `failed`.
 */
export async function bulkDelete(
  ctx: RedisContext,
  options: BulkDeleteOptions,
): Promise<BulkDeleteResult> {
  const batchSize = options.batchSize ?? 500;
  const dryRun = options.dryRun === true;
  const seen = new Set<string>();
  const sample: Uint8Array[] = [];
  let matched = 0;
  let deleted = 0;
  let failed = 0;
  let scanCalls = 0;
  let cursor = '0';
  let pending: Uint8Array[] = [];
  const flush = async (): Promise<void> => {
    if (dryRun || pending.length === 0) {
      pending = [];
      return;
    }
    const batch = pending;
    pending = [];
    try {
      deleted += await deleteKeys(ctx, batch);
    } catch (error) {
      if (!(error instanceof QuerybaraError) || error.engineCode !== 'NOPERM') throw error;
      // Some keys are outside the user's key patterns: delete the rest one by one.
      for (const key of batch) {
        try {
          deleted += await deleteKeys(ctx, [key]);
        } catch {
          failed += 1;
        }
      }
    }
  };
  const progress = (): void => options.onProgress?.({ matched, deleted, failed, scanCalls });
  let cancelled = false;
  for (;;) {
    if (options.signal?.aborted) {
      cancelled = true;
      break;
    }
    const step = await scan(ctx, {
      cursor,
      match: options.match,
      count: options.scanCount ?? 1000,
      ...(options.type ? { type: options.type } : {}),
    });
    scanCalls += 1;
    cursor = step.cursor;
    for (const key of step.keys) {
      // SCAN may return a key twice; count it once (bounded memory: ids of this run only).
      const id = bytesKey(key);
      if (seen.has(id)) continue;
      if (seen.size < 1_000_000) seen.add(id);
      matched += 1;
      if (sample.length < 20) sample.push(key);
      pending.push(key);
      if (pending.length >= batchSize) await flush();
    }
    progress();
    if (step.done) break;
  }
  if (!cancelled) await flush();
  progress();
  return { matched, deleted, failed, scanCalls, dryRun, cancelled, sample };
}

/** A tombstone for removing a list element by index (unlikely to collide with real data). */
export function tombstone(): Uint8Array {
  return utf8Bytes(`__querybara_removed__:${globalThis.crypto.randomUUID()}`);
}
