import { PatternAggregator, type PatternStats } from './patterns';
import { readRdb, RdbError, type RdbKey, type RdbReadOptions } from './rdb';

/**
 * The analysis of an RDB file (Redis's memory report, offline): totals, keys by database,
 * type, encoding and expiry, the largest keys by size in the file and by element count, and
 * keys grouped by pattern (`user:*:profile`). Sizes are bytes in the file: a key's name, value,
 * expiry and metadata as the dump encodes them. Memory in a running server differs (overheads,
 * uncompressed values), but its proportions follow. Everything is summed as the file streams,
 * so the file's size does not bound it: only the largest keys and up to `maxPatterns` patterns
 * are kept.
 */

/** One key in a "largest keys" list. */
export interface RdbKeyInfo {
  readonly db: number;
  /** The key's name (its first 4 KiB). */
  readonly key: Uint8Array;
  readonly keyLength: number;
  readonly type: string;
  readonly encoding: string;
  readonly bytes: number;
  readonly elements: number | null;
  readonly expiresAt: number | null;
}

export interface RdbGroupStats {
  readonly name: string;
  readonly keys: number;
  readonly bytes: number;
}

export interface RdbTypeStats extends RdbGroupStats {
  /** Elements over the keys whose count is known (string bytes for strings). */
  readonly elements: number;
  readonly encodings: readonly RdbGroupStats[];
}

export interface RdbDatabaseStats {
  readonly db: number;
  readonly keys: number;
  readonly bytes: number;
  readonly expiring: number;
}

/** Keys by how long they have left, measured from when the dump was written. */
export const EXPIRY_BUCKETS = [
  'No expiry',
  'Already expired',
  'Within an hour',
  'Within a day',
  'Within a week',
  'Within a month',
  'Later',
] as const;
export type ExpiryBucket = (typeof EXPIRY_BUCKETS)[number];

export interface RdbAnalysis {
  /** RDB format version (Valkey from 80). */
  readonly version: number;
  /** Bytes read: the whole file when the analysis completed. */
  readonly bytes: number;
  readonly checksum: string | null;
  /** AUX fields: redis-ver or valkey-ver, redis-bits, ctime, used-mem, aof-base... */
  readonly aux: Readonly<Record<string, string>>;
  /** When the dump was written (ctime), milliseconds since the epoch. */
  readonly createdAt: number | null;
  readonly keys: number;
  /** Bytes the keys take in the file. */
  readonly keyBytes: number;
  readonly expiring: number;
  readonly databases: readonly RdbDatabaseStats[];
  readonly types: readonly RdbTypeStats[];
  readonly expiry: readonly RdbGroupStats[];
  readonly patterns: readonly PatternStats[];
  /** Largest keys by bytes in the file. */
  readonly biggest: readonly RdbKeyInfo[];
  /** Collections with the most elements. */
  readonly longest: readonly RdbKeyInfo[];
  /** Hash fields with their own expiry, over all hashes. */
  readonly fieldsWithTtl: number;
  readonly functions: number;
  readonly moduleAux: readonly RdbGroupStats[];
  /** Where reading stopped early (a damaged file, a format this reader does not know). */
  readonly stopped?: { readonly message: string; readonly offset: number };
}

export interface RdbAnalysisOptions extends RdbReadOptions {
  /** Key name delimiter for patterns (default `:`). */
  readonly delimiter?: string;
  /** Keys in each "largest" list (default 100). */
  readonly top?: number;
  /** Patterns kept before the rest are counted as `(other)` (default 20,000). */
  readonly maxPatterns?: number;
  /** Patterns reported (default 500). */
  readonly patternLimit?: number;
  /** Bytes read so far, every `progressBytes`. */
  readonly onProgress?: (bytes: number) => void;
}

/** The `top` largest items by `score`, kept sorted, smallest last. */
class TopList {
  readonly #items: RdbKeyInfo[] = [];

  constructor(
    private readonly size: number,
    private readonly score: (item: RdbKeyInfo) => number,
  ) {}

  add(item: RdbKeyInfo): void {
    const items = this.#items;
    const value = this.score(item);
    if (items.length >= this.size && value <= this.score(items[items.length - 1]!)) return;
    let low = 0;
    let high = items.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (this.score(items[mid]!) >= value) low = mid + 1;
      else high = mid;
    }
    items.splice(low, 0, item);
    if (items.length > this.size) items.pop();
  }

  /** Whether an item scoring `value` would get in: saves copying keys that would not. */
  wants(value: number): boolean {
    return (
      this.#items.length < this.size || value > this.score(this.#items[this.#items.length - 1]!)
    );
  }

  get items(): readonly RdbKeyInfo[] {
    return this.#items;
  }
}

const HOUR = 3_600_000;

function expiryBucket(expiresAt: number | null, now: number): ExpiryBucket {
  if (expiresAt === null) return 'No expiry';
  const left = expiresAt - now;
  if (left <= 0) return 'Already expired';
  if (left <= HOUR) return 'Within an hour';
  if (left <= 24 * HOUR) return 'Within a day';
  if (left <= 7 * 24 * HOUR) return 'Within a week';
  if (left <= 30 * 24 * HOUR) return 'Within a month';
  return 'Later';
}

/**
 * Analyses an RDB file as it streams. A file that cannot be read to its end still yields the
 * analysis of what was read, with `stopped` saying where and why; only a file that is not an
 * RDB at all throws.
 */
export async function analyzeRdb(
  source: AsyncIterable<Uint8Array>,
  options: RdbAnalysisOptions = {},
): Promise<RdbAnalysis> {
  const top = options.top ?? 100;
  const patterns = new PatternAggregator({
    ...(options.delimiter !== undefined ? { delimiter: options.delimiter } : {}),
    maxPatterns: options.maxPatterns ?? 20_000,
  });
  const biggest = new TopList(top, (item) => item.bytes);
  const longest = new TopList(top, (item) => item.elements ?? 0);
  const aux: Record<string, string> = {};
  const databases = new Map<number, { keys: number; bytes: number; expiring: number }>();
  const types = new Map<
    string,
    { keys: number; bytes: number; elements: number; encodings: Map<string, RdbGroupStats> }
  >();
  const expiry = new Map<ExpiryBucket, { keys: number; bytes: number }>();
  const moduleAux = new Map<string, { keys: number; bytes: number }>();
  let now: number | null = null;
  let keys = 0;
  let keyBytes = 0;
  let expiring = 0;
  let fieldsWithTtl = 0;
  let functions = 0;
  let version = 0;
  let bytesRead: number;

  const info = (key: RdbKey): RdbKeyInfo => ({
    db: key.db,
    key: new Uint8Array(key.key),
    keyLength: key.keyLength,
    type: key.type,
    encoding: key.encoding,
    bytes: key.bytes,
    elements: key.elements,
    expiresAt: key.expiresAt,
  });

  const onKey = (key: RdbKey): void => {
    keys++;
    keyBytes += key.bytes;
    if (key.expiresAt !== null) expiring++;
    fieldsWithTtl += key.fieldsWithTtl ?? 0;

    const db = databases.get(key.db) ?? { keys: 0, bytes: 0, expiring: 0 };
    db.keys++;
    db.bytes += key.bytes;
    if (key.expiresAt !== null) db.expiring++;
    databases.set(key.db, db);

    let type = types.get(key.type);
    if (!type) {
      type = { keys: 0, bytes: 0, elements: 0, encodings: new Map() };
      types.set(key.type, type);
    }
    type.keys++;
    type.bytes += key.bytes;
    type.elements += key.elements ?? 0;
    const encoding = type.encodings.get(key.encoding) ?? { name: key.encoding, keys: 0, bytes: 0 };
    type.encodings.set(key.encoding, {
      name: key.encoding,
      keys: encoding.keys + 1,
      bytes: encoding.bytes + key.bytes,
    });

    const bucket = expiryBucket(key.expiresAt, now ?? Date.now());
    const slot = expiry.get(bucket) ?? { keys: 0, bytes: 0 };
    slot.keys++;
    slot.bytes += key.bytes;
    expiry.set(bucket, slot);

    patterns.add({
      key: key.key,
      type: key.type,
      bytes: key.bytes,
      length: key.elements,
      ttlMs: key.expiresAt === null ? -1 : Math.max(0, key.expiresAt - (now ?? Date.now())),
    });
    if (biggest.wants(key.bytes)) biggest.add(info(key));
    if (key.type !== 'string' && key.elements !== null && longest.wants(key.elements)) {
      longest.add(info(key));
    }
  };

  let stopped: RdbAnalysis['stopped'];
  let checksum: string | null = null;
  try {
    const summary = await readRdb(
      source,
      {
        onHeader: (v) => (version = v),
        onAux: (name, value) => {
          aux[name] = value;
          if (name === 'ctime' && /^\d+$/.test(value)) now = Number(value) * 1000;
        },
        onKey,
        onFunction: () => functions++,
        onModuleAux: (module, bytes) => {
          const slot = moduleAux.get(module) ?? { keys: 0, bytes: 0 };
          slot.keys++;
          slot.bytes += bytes;
          moduleAux.set(module, slot);
        },
        ...(options.onProgress !== undefined ? { onProgress: options.onProgress } : {}),
      },
      options,
    );
    checksum = summary.checksum;
    bytesRead = summary.bytes;
  } catch (error) {
    if (!(error instanceof RdbError) || version === 0) throw error;
    stopped = { message: error.message, offset: error.offset };
    bytesRead = error.offset;
  }

  const byBytes = <T extends { bytes: number }>(a: T, b: T): number => b.bytes - a.bytes;
  return {
    version,
    bytes: bytesRead,
    checksum,
    aux,
    createdAt: now,
    keys,
    keyBytes,
    expiring,
    databases: [...databases.entries()]
      .map(([db, stats]) => ({ db, ...stats }))
      .sort((a, b) => a.db - b.db),
    types: [...types.entries()]
      .map(([name, stats]) => ({
        name,
        keys: stats.keys,
        bytes: stats.bytes,
        elements: stats.elements,
        encodings: [...stats.encodings.values()].sort(byBytes),
      }))
      .sort(byBytes),
    expiry: EXPIRY_BUCKETS.filter((bucket) => expiry.has(bucket)).map((bucket) => ({
      name: bucket,
      ...expiry.get(bucket)!,
    })),
    patterns: patterns.result(options.patternLimit ?? 500),
    biggest: biggest.items,
    longest: longest.items,
    fieldsWithTtl,
    functions,
    moduleAux: [...moduleAux.entries()].map(([name, stats]) => ({ name, ...stats })),
    ...(stopped !== undefined ? { stopped } : {}),
  };
}
