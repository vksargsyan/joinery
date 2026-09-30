import type { CellValue, ColumnKind, LargeValueHandle } from '@joinery/core';

/**
 * Value canonicalisation for data compare (spec §13, "Cross-engine data compare canonicalises
 * values first"). Two cells are equal when their canonical forms are equal (floats: within the
 * tolerance). Forms are strings so they hash and sort the same everywhere:
 *
 * - timestamps → UTC ISO 8601 (`2024-05-01T10:00:00.5Z`), keeping microseconds; values
 *   without a zone are read in `assumeTimeZone` (UTC by default);
 * - decimals and integers → plain decimal text without leading/trailing zeros (`1.50` → `1.5`);
 * - JSON → re-serialised with sorted object keys;
 * - booleans → `1` / `0`, so MySQL TINYINT(1) matches PostgreSQL boolean;
 * - binary → lower-case hex; UUIDs → lower-case, hyphenated;
 * - strings → optionally trimmed and case-folded.
 */
export interface CanonicalOptions {
  /** Absolute tolerance for floating-point columns (default 0: exact). */
  readonly floatTolerance?: number;
  /** Trim strings: 'none' (default), 'trailing' (CHAR padding) or 'both'. */
  readonly trim?: 'none' | 'trailing' | 'both';
  /** Compare strings case-insensitively. */
  readonly caseInsensitive?: boolean;
  /** Offset for timestamps without a zone, e.g. '+02:00' (default 'Z'). */
  readonly assumeTimeZone?: string;
}

function isHandle(value: CellValue): value is LargeValueHandle {
  return typeof value === 'object' && value !== null && !(value instanceof Uint8Array);
}

function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

function textOf(value: Exclude<CellValue, null>): string {
  if (value instanceof Uint8Array) return new TextDecoder().decode(value);
  if (isHandle(value)) return value.preview;
  return String(value);
}

// ---------------------------------------------------------------------------------------------
// Numbers

/** Canonical decimal text, or null when the text is not a finite decimal number. */
export function canonicalDecimal(text: string): string | null {
  const match = /^\s*([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?\s*$/.exec(text);
  if (!match || (match[2] === '' && (match[3] ?? '') === '')) return null;
  const negative = match[1] === '-';
  let digits = `${match[2]}${match[3] ?? ''}`;
  let point = match[2]!.length + Number(match[4] ?? 0);
  if (point < 0) {
    digits = '0'.repeat(-point) + digits;
    point = 0;
  }
  if (point > digits.length) digits += '0'.repeat(point - digits.length);
  const integer = digits.slice(0, point).replace(/^0+/, '') || '0';
  const fraction = digits.slice(point).replace(/0+$/, '');
  if (integer === '0' && fraction === '') return '0';
  return `${negative ? '-' : ''}${integer}${fraction !== '' ? `.${fraction}` : ''}`;
}

/** Compares two canonical decimal strings numerically. */
export function compareDecimals(a: string, b: string): number {
  const negA = a.startsWith('-');
  const negB = b.startsWith('-');
  if (negA !== negB) return negA ? -1 : 1;
  const [ia = '', fa = ''] = (negA ? a.slice(1) : a).split('.');
  const [ib = '', fb = ''] = (negB ? b.slice(1) : b).split('.');
  let result = ia.length - ib.length;
  if (result === 0) result = ia < ib ? -1 : ia > ib ? 1 : 0;
  if (result === 0) {
    const width = Math.max(fa.length, fb.length);
    const pa = fa.padEnd(width, '0');
    const pb = fb.padEnd(width, '0');
    result = pa < pb ? -1 : pa > pb ? 1 : 0;
  }
  return negA ? -Math.sign(result) : Math.sign(result);
}

function canonicalNumberText(value: Exclude<CellValue, null>): string {
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return 'NaN';
    if (!Number.isFinite(value)) return value > 0 ? 'Infinity' : '-Infinity';
    return canonicalDecimal(value.toString()) ?? value.toString();
  }
  if (typeof value === 'boolean') return value ? '1' : '0';
  const text = textOf(value).trim();
  if (/^[+-]?(nan|infinity|inf)$/i.test(text)) {
    return /nan/i.test(text) ? 'NaN' : text.startsWith('-') ? '-Infinity' : 'Infinity';
  }
  return canonicalDecimal(text) ?? text;
}

function floatValue(value: Exclude<CellValue, null>): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'boolean') return value ? 1 : 0;
  return Number(textOf(value).trim());
}

// ---------------------------------------------------------------------------------------------
// Time

const TIMESTAMP_RE =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?)?\s*(Z|[+-]\d{2}(?::?\d{2})?)?$/i;

function offsetMinutes(zone: string | undefined): number {
  if (zone === undefined || zone.toUpperCase() === 'Z') return 0;
  const sign = zone.startsWith('-') ? -1 : 1;
  const digits = zone.slice(1).replace(':', '');
  return sign * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2, 4) || '0'));
}

/**
 * UTC ISO form of a date-time value. `fractionWidth` pads the fraction (for ordering); by
 * default trailing zeros are trimmed (for equality).
 */
export function canonicalTimestamp(
  text: string,
  assumeTimeZone = 'Z',
  fractionWidth?: number,
): string {
  const trimmed = text.trim();
  const match = TIMESTAMP_RE.exec(trimmed);
  if (!match) return trimmed.toLowerCase();
  const [, y, mo, d, h = '00', mi = '00', s = '00', frac = '', zone] = match;
  const offset = offsetMinutes(zone ?? assumeTimeZone);
  const date = new Date(
    Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)),
  );
  if (Number(y) < 100) date.setUTCFullYear(Number(y));
  date.setUTCMinutes(date.getUTCMinutes() - offset);
  const iso = date.toISOString().slice(0, 19);
  const fraction =
    fractionWidth !== undefined ? frac.padEnd(fractionWidth, '0') : frac.replace(/0+$/, '');
  return `${iso}${fraction !== '' ? `.${fraction}` : ''}Z`;
}

function canonicalTime(text: string, fractionWidth?: number): string {
  const match = /^(\d{1,3}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?(.*)$/.exec(text.trim());
  if (!match) return text.trim();
  const [, h, mi, s = '00', frac = '', rest] = match;
  const fraction =
    fractionWidth !== undefined ? frac.padEnd(fractionWidth, '0') : frac.replace(/0+$/, '');
  return `${h!.padStart(2, '0')}:${mi}:${s}${fraction !== '' ? `.${fraction}` : ''}${rest!.trim()}`;
}

// ---------------------------------------------------------------------------------------------
// JSON, UUID, strings

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort())
      out[key] = sortKeys((value as Record<string, unknown>)[key]);
    return out;
  }
  return value;
}

/** JSON re-serialised with sorted object keys; text that is not JSON is only trimmed. */
export function canonicalJson(text: string): string {
  try {
    return JSON.stringify(sortKeys(JSON.parse(text)));
  } catch {
    return text.trim();
  }
}

function canonicalUuid(text: string): string {
  const bare = text
    .trim()
    .replace(/^\{|\}$/g, '')
    .toLowerCase();
  if (/^[0-9a-f]{32}$/.test(bare)) {
    return `${bare.slice(0, 8)}-${bare.slice(8, 12)}-${bare.slice(12, 16)}-${bare.slice(16, 20)}-${bare.slice(20)}`;
  }
  return bare;
}

function canonicalString(text: string, options: CanonicalOptions): string {
  let out = text;
  if (options.trim === 'both') out = out.trim();
  else if (options.trim === 'trailing') out = out.replace(/\s+$/, '');
  if (options.caseInsensitive) out = out.toLowerCase();
  return out;
}

// ---------------------------------------------------------------------------------------------
// Kinds

const NUMERIC_KINDS: ReadonlySet<ColumnKind> = new Set(['integer', 'bigint', 'decimal', 'float']);
const TEMPORAL_KINDS: ReadonlySet<ColumnKind> = new Set(['datetime', 'timestamp']);

/**
 * The kind two columns are compared as when the engines report different kinds, e.g. a
 * PostgreSQL boolean against a MySQL TINYINT(1) (boolean), a numeric against a float (float),
 * json against text (json).
 */
export function compareKind(a: ColumnKind, b: ColumnKind = a): ColumnKind {
  if (a === b) return a;
  const pair = new Set([a, b]);
  const has = (kind: ColumnKind): boolean => pair.has(kind);
  if (has('float') && [...pair].every((k) => NUMERIC_KINDS.has(k) || k === 'boolean'))
    return 'float';
  if ([...pair].every((k) => NUMERIC_KINDS.has(k))) return 'decimal';
  if (
    has('boolean') &&
    [...pair].every((k) => k === 'boolean' || NUMERIC_KINDS.has(k) || k === 'string')
  ) {
    return 'boolean';
  }
  if (has('json')) return 'json';
  if ([...pair].some((k) => TEMPORAL_KINDS.has(k))) return 'timestamp';
  if (has('uuid')) return 'uuid';
  if (has('binary')) return 'binary';
  return 'string';
}

/**
 * The canonical form of one cell for the given kind; null stays null (distinct from '' and
 * from the string 'NULL'). Large-value handles compare by length and preview only: fetch the
 * full value when that matters.
 */
export function canonicalValue(
  value: CellValue,
  kind: ColumnKind,
  options: CanonicalOptions = {},
): string | null {
  if (value === null) return null;
  if (isHandle(value)) return `\u0000large:${value.kind}:${value.byteLength}:${value.preview}`;
  switch (kind) {
    case 'integer':
    case 'bigint':
    case 'decimal':
      return canonicalNumberText(value);
    case 'float': {
      const n = floatValue(value);
      return Number.isNaN(n) ? 'NaN' : canonicalNumberText(n);
    }
    case 'boolean': {
      if (typeof value === 'boolean') return value ? '1' : '0';
      const text = textOf(value).trim().toLowerCase();
      if (['t', 'true', 'y', 'yes', 'on'].includes(text)) return '1';
      if (['f', 'false', 'n', 'no', 'off'].includes(text)) return '0';
      const number = canonicalNumberText(value);
      return number === '0' ? '0' : number === '1' ? '1' : number;
    }
    case 'datetime':
    case 'timestamp':
      return canonicalTimestamp(textOf(value), options.assumeTimeZone);
    case 'date':
      return textOf(value).trim().slice(0, 10);
    case 'time':
      return canonicalTime(textOf(value));
    case 'json':
      return canonicalJson(textOf(value));
    case 'binary':
      if (value instanceof Uint8Array) return toHex(value);
      return textOf(value).trim().replace(/^\\x/i, '').toLowerCase();
    case 'uuid':
      return canonicalUuid(
        value instanceof Uint8Array && value.length === 16 ? toHex(value) : textOf(value),
      );
    default:
      return canonicalString(value instanceof Uint8Array ? toHex(value) : textOf(value), options);
  }
}

/** Equality of two cells after canonicalisation, with float tolerance. */
export function valuesEqual(
  a: CellValue,
  b: CellValue,
  kindA: ColumnKind,
  kindB: ColumnKind = kindA,
  options: CanonicalOptions = {},
): boolean {
  if (a === null || b === null) return a === b;
  const kind = compareKind(kindA, kindB);
  if (kind === 'float' && (options.floatTolerance ?? 0) > 0) {
    const x = floatValue(a);
    const y = floatValue(b);
    if (Number.isNaN(x) || Number.isNaN(y)) return Number.isNaN(x) && Number.isNaN(y);
    return Math.abs(x - y) <= (options.floatTolerance ?? 0);
  }
  return canonicalValue(a, kind, options) === canonicalValue(b, kind, options);
}

// ---------------------------------------------------------------------------------------------
// Key ordering

/** Compares strings by Unicode code point (the order of binary UTF-8 collations and "C"). */
export function compareCodePoints(a: string, b: string): number {
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i++) {
    const x = a.charCodeAt(i);
    const y = b.charCodeAt(i);
    if (x === y) continue;
    // Surrogates (supplementary characters) sort after the rest of the BMP in code point order.
    const surrogateX = x >= 0xd800 && x <= 0xdfff;
    const surrogateY = y >= 0xd800 && y <= 0xdfff;
    if (surrogateX !== surrogateY) return surrogateX ? 1 : -1;
    return x < y ? -1 : 1;
  }
  return a.length - b.length;
}

/**
 * Orders two key cells the way the key-ordered row queries sort them: numbers numerically,
 * temporal values chronologically, binary bytewise, and strings by code point (the queries sort
 * string keys with a binary collation: PostgreSQL COLLATE "C", MySQL CAST(... AS BINARY)).
 */
export function compareKeyValues(a: CellValue, b: CellValue, kind: ColumnKind): number {
  if (a === null || b === null) return a === b ? 0 : a === null ? -1 : 1;
  if (NUMERIC_KINDS.has(kind) || kind === 'boolean') {
    const x = canonicalValue(a, kind === 'boolean' ? 'boolean' : 'decimal');
    const y = canonicalValue(b, kind === 'boolean' ? 'boolean' : 'decimal');
    if (x !== null && y !== null && canonicalDecimal(x) !== null && canonicalDecimal(y) !== null) {
      return compareDecimals(x, y);
    }
    return compareCodePoints(String(x), String(y));
  }
  if (TEMPORAL_KINDS.has(kind)) {
    return compareCodePoints(
      canonicalTimestamp(textOf(a), 'Z', 9),
      canonicalTimestamp(textOf(b), 'Z', 9),
    );
  }
  if (kind === 'time')
    return compareCodePoints(canonicalTime(textOf(a), 9), canonicalTime(textOf(b), 9));
  if (kind === 'binary' || a instanceof Uint8Array || b instanceof Uint8Array) {
    const x = a instanceof Uint8Array ? toHex(a) : (canonicalValue(a, 'binary') ?? '');
    const y = b instanceof Uint8Array ? toHex(b) : (canonicalValue(b, 'binary') ?? '');
    return x < y ? -1 : x > y ? 1 : 0;
  }
  if (kind === 'uuid')
    return compareCodePoints(canonicalValue(a, 'uuid') ?? '', canonicalValue(b, 'uuid') ?? '');
  return compareCodePoints(textOf(a), textOf(b));
}

/** Lexicographic key comparison; `kinds[i]` is the comparison kind of key column i. */
export function compareKeys(
  a: readonly CellValue[],
  b: readonly CellValue[],
  kinds: readonly ColumnKind[],
): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const result = compareKeyValues(a[i] ?? null, b[i] ?? null, kinds[i] ?? 'string');
    if (result !== 0) return result;
  }
  return 0;
}
