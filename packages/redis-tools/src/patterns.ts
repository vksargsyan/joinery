import { displayBytes } from './bytes';

/**
 * Key patterns for the big-key report: `user:42:profile` and `user:77:profile` both become
 * `user:*:profile`, so memory can be summed per kind of key. Segments that look like ids —
 * numbers, UUIDs, hex strings, ULIDs, binary data — become `*`.
 */

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const NUMBER = /^[+-]?\d+(\.\d+)?$/;
const HEX = /^(0x)?[0-9a-f]{8,}$/i;
const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/i;
const SEPARATORS = new Set([':', '/', '|', '#', '.', '-', '_', '=', '@', ',', ';', ' ']);

function idLike(segment: string): boolean {
  if (segment === '*') return true;
  if (NUMBER.test(segment)) return true;
  if (HEX.test(segment) && /\d/.test(segment)) return true;
  if (ULID.test(segment) && /\d/.test(segment) && /[a-z]/i.test(segment)) return true;
  // Binary bytes shown as \xNN escapes.
  return segment.includes('\\x');
}

/**
 * The pattern of a key name. Splits on `delimiter` and on common separators (`: / | # . - _ =
 * @ , ;` and space), keeping them, and replaces id-like segments with `*`. UUIDs are replaced
 * before splitting, since they contain `-`.
 */
export function keyPattern(key: Uint8Array | string, delimiter = ':'): string {
  const text = (typeof key === 'string' ? key : displayBytes(key)).replace(UUID, '*');
  let out = '';
  let segment = '';
  const flush = (): void => {
    out += segment !== '' && idLike(segment) ? '*' : segment;
    segment = '';
  };
  for (let i = 0; i < text.length;) {
    if (delimiter && text.startsWith(delimiter, i)) {
      flush();
      out += delimiter;
      i += delimiter.length;
      continue;
    }
    const ch = text[i]!;
    // A decimal point inside a number is part of the number.
    const decimal = ch === '.' && /^\d+$/.test(segment) && /\d/.test(text[i + 1] ?? '');
    if (SEPARATORS.has(ch) && !decimal) {
      flush();
      out += ch;
    } else {
      segment += ch;
    }
    i += 1;
  }
  flush();
  return out;
}

/** One sampled key for the big-key report. */
export interface KeySample {
  readonly key: Uint8Array;
  /** TYPE of the key (string, hash, list, set, zset, stream, ReJSON-RL...). */
  readonly type: string;
  /** MEMORY USAGE in bytes; null when the server refused it or the key vanished. */
  readonly bytes: number | null;
  /** Elements (hash fields, list items...) or string length, when known. */
  readonly length?: number | null;
  /** Remaining time to live in milliseconds; -1 without expiry. */
  readonly ttlMs?: number | null;
}

export interface PatternStats {
  readonly pattern: string;
  readonly count: number;
  /** Sum of MEMORY USAGE over the sampled keys with a known size. */
  readonly totalBytes: number;
  readonly maxBytes: number;
  readonly avgBytes: number;
  /** The largest sampled key of the pattern. */
  readonly largestKey: Uint8Array | null;
  /** Keys per type. */
  readonly types: Readonly<Record<string, number>>;
  /** Sampled keys that have an expiry. */
  readonly withTtl: number;
  /** Share of the sampled memory, 0..1. */
  readonly share: number;
}

interface PatternAcc {
  count: number;
  total: number;
  max: number;
  known: number;
  largest: Uint8Array | null;
  types: Record<string, number>;
  withTtl: number;
}

/** The row every pattern past `maxPatterns` is counted in. */
export const OTHER_PATTERNS = '(other)';

/**
 * Sums samples by key pattern as they arrive, so millions of keys (a whole RDB file) never have
 * to be held. `maxPatterns` bounds memory: keys of patterns first seen after that many are
 * counted in one `(other)` row.
 */
export class PatternAggregator {
  readonly #groups = new Map<string, PatternAcc>();
  readonly #delimiter: string;
  readonly #maxPatterns: number;
  #grand = 0;

  constructor(options: { readonly delimiter?: string; readonly maxPatterns?: number } = {}) {
    this.#delimiter = options.delimiter ?? ':';
    this.#maxPatterns = options.maxPatterns ?? Infinity;
  }

  add(sample: KeySample): void {
    let pattern = keyPattern(sample.key, this.#delimiter);
    let acc = this.#groups.get(pattern);
    if (!acc && this.#groups.size >= this.#maxPatterns) {
      pattern = OTHER_PATTERNS;
      acc = this.#groups.get(pattern);
    }
    if (!acc) {
      acc = { count: 0, total: 0, max: 0, known: 0, largest: null, types: {}, withTtl: 0 };
      this.#groups.set(pattern, acc);
    }
    acc.count += 1;
    acc.types[sample.type] = (acc.types[sample.type] ?? 0) + 1;
    if (sample.ttlMs !== undefined && sample.ttlMs !== null && sample.ttlMs >= 0) acc.withTtl += 1;
    if (sample.bytes !== null) {
      acc.known += 1;
      acc.total += sample.bytes;
      this.#grand += sample.bytes;
      if (sample.bytes >= acc.max) {
        acc.max = sample.bytes;
        acc.largest = sample.key;
      }
    }
  }

  /**
   * Patterns, largest total first. `limit` caps the rows: the rest are merged into one
   * `(other)` row, with any keys already counted there.
   */
  result(limit?: number): PatternStats[] {
    const grand = this.#grand;
    const stats = [...this.#groups.entries()]
      .map(([pattern, acc]): PatternStats => ({
        pattern,
        count: acc.count,
        totalBytes: acc.total,
        maxBytes: acc.max,
        avgBytes: acc.known > 0 ? Math.round(acc.total / acc.known) : 0,
        largestKey: acc.largest,
        types: acc.types,
        withTtl: acc.withTtl,
        share: grand > 0 ? acc.total / grand : 0,
      }))
      .sort(
        (a, b) =>
          b.totalBytes - a.totalBytes || b.count - a.count || a.pattern.localeCompare(b.pattern),
      );
    const other = stats.findIndex((s) => s.pattern === OTHER_PATTERNS);
    const overflow = other >= 0 ? stats.splice(other, 1)[0] : undefined;
    const keep = limit === undefined ? stats.length : Math.max(0, limit - 1);
    if (stats.length <= keep && overflow === undefined) return stats;
    const kept = stats.slice(0, keep);
    const rest = [...stats.slice(kept.length), ...(overflow ? [overflow] : [])];
    if (rest.length === 0) return kept;
    const types: Record<string, number> = {};
    let largest: PatternStats | undefined;
    for (const s of rest) {
      for (const [type, n] of Object.entries(s.types)) types[type] = (types[type] ?? 0) + n;
      if (!largest || s.maxBytes > largest.maxBytes) largest = s;
    }
    const total = rest.reduce((sum, s) => sum + s.totalBytes, 0);
    const count = rest.reduce((sum, s) => sum + s.count, 0);
    kept.push({
      pattern: OTHER_PATTERNS,
      count,
      totalBytes: total,
      maxBytes: largest?.maxBytes ?? 0,
      avgBytes: count > 0 ? Math.round(total / count) : 0,
      largestKey: largest?.largestKey ?? null,
      types,
      withTtl: rest.reduce((sum, s) => sum + s.withTtl, 0),
      share: grand > 0 ? total / grand : 0,
    });
    return kept;
  }
}

/**
 * Aggregates samples by key pattern, largest total memory first. `limit` caps the number of
 * patterns (the rest are merged into one `(other)` row).
 */
export function aggregateByPattern(
  samples: Iterable<KeySample>,
  options: { readonly delimiter?: string; readonly limit?: number } = {},
): PatternStats[] {
  const aggregator = new PatternAggregator(
    options.delimiter !== undefined ? { delimiter: options.delimiter } : {},
  );
  for (const sample of samples) aggregator.add(sample);
  return aggregator.result(options.limit);
}
