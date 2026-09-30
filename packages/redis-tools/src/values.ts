import { decode as msgpackDecode, encode as msgpackEncode, ExtData } from '@msgpack/msgpack';

import { toHex, tryUtf8 } from './bytes';

/**
 * Helpers for the value editors (spec §10): MessagePack, hex, JSON detection, bitmaps,
 * HyperLogLog and geo scores. Everything works on Uint8Array, with no Node built-ins.
 */

// ---------------------------------------------------------------------------------------------
// MessagePack

/** Decodes one MessagePack value. 64-bit integers decode as bigint. Throws on invalid input. */
export function decodeMessagePack(bytes: Uint8Array): unknown {
  return msgpackDecode(bytes, {
    useBigInt64: true,
    mapKeyConverter: (key) =>
      typeof key === 'string' || typeof key === 'number' ? key : JSON.stringify(toJsonValue(key)),
  });
}

/** Encodes a value (typically parsed from the editor's JSON view) as MessagePack. */
export function encodeMessagePack(value: unknown): Uint8Array {
  return msgpackEncode(fromJsonValue(value), { useBigInt64: true, ignoreUndefined: true });
}

const CONTAINER_MARKERS = (b: number): boolean =>
  (b >= 0x80 && b <= 0x9f) || b === 0xdc || b === 0xdd || b === 0xde || b === 0xdf;

/**
 * True when the bytes are one complete MessagePack map or array. Scalars are not claimed: most
 * short ASCII strings would decode as a positive fixint.
 */
export function looksLikeMessagePack(bytes: Uint8Array): boolean {
  if (bytes.length === 0 || !CONTAINER_MARKERS(bytes[0]!)) return false;
  try {
    decodeMessagePack(bytes);
    return true;
  } catch {
    return false;
  }
}

/** A JSON-compatible form of a decoded value: bytes as {"$binary": hex}, bigint as text... */
export type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export function toJsonValue(value: unknown): JsonValue {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (typeof value === 'bigint') {
    return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)
      ? Number(value)
      : { $bigint: value.toString() };
  }
  if (value instanceof Uint8Array) return { $binary: toHex(value) };
  if (value instanceof Date) return { $date: value.toISOString() };
  if (value instanceof ExtData) {
    const data = value.data instanceof Uint8Array ? value.data : new Uint8Array(0);
    return { $ext: value.type, data: toHex(data) };
  }
  if (Array.isArray(value)) return value.map(toJsonValue);
  if (value instanceof Map) {
    const out: { [key: string]: JsonValue } = {};
    for (const [k, v] of value)
      out[typeof k === 'string' ? k : JSON.stringify(toJsonValue(k))] = toJsonValue(v);
    return out;
  }
  if (typeof value === 'object') {
    const out: { [key: string]: JsonValue } = {};
    for (const [k, v] of Object.entries(value)) out[k] = toJsonValue(v);
    return out;
  }
  return String(value);
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(2 * i, 2 * i + 2), 16);
  return out;
}

/** Reverses `toJsonValue`'s wrappers ($binary, $bigint, $date, $ext) before encoding. */
function fromJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(fromJsonValue);
  if (value && typeof value === 'object' && !(value instanceof Uint8Array)) {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record);
    if (keys.length === 1 && typeof record['$binary'] === 'string')
      return hexToBytes(record['$binary']);
    if (keys.length === 1 && typeof record['$bigint'] === 'string')
      return BigInt(record['$bigint']);
    if (keys.length === 1 && typeof record['$date'] === 'string') return new Date(record['$date']);
    if (
      keys.length === 2 &&
      typeof record['$ext'] === 'number' &&
      typeof record['data'] === 'string'
    ) {
      return new ExtData(record['$ext'], hexToBytes(record['data']));
    }
    const out: Record<string, unknown> = {};
    for (const k of keys) {
      // An assignment would set the prototype and drop the key; the decoder refuses it anyway.
      if (k === '__proto__') throw new Error('A MessagePack map key cannot be "__proto__"');
      out[k] = fromJsonValue(record[k]);
    }
    return out;
  }
  return value;
}

/** MessagePack bytes as pretty JSON text for the editor; throws on invalid MessagePack. */
export function messagePackToJsonText(bytes: Uint8Array): string {
  return JSON.stringify(toJsonValue(decodeMessagePack(bytes)), null, 2);
}

/** JSON text from the editor back to MessagePack bytes. Throws on invalid JSON. */
export function jsonTextToMessagePack(text: string): Uint8Array {
  return encodeMessagePack(JSON.parse(text));
}

// ---------------------------------------------------------------------------------------------
// Hex and text

/**
 * A hex dump: `00000000  68 65 6c 6c 6f 20 77 6f  72 6c 64 0a              |hello world.|`.
 * `offset` numbers the first byte (for paged views of large values).
 */
export function hexDump(
  bytes: Uint8Array,
  options: { readonly offset?: number; readonly width?: number } = {},
): string {
  const width = options.width ?? 16;
  const base = options.offset ?? 0;
  const lines: string[] = [];
  for (let i = 0; i < bytes.length; i += width) {
    const row = bytes.subarray(i, i + width);
    const cells: string[] = [];
    for (let j = 0; j < width; j++) {
      cells.push(j < row.length ? toHex(row.subarray(j, j + 1)) : '  ');
      if (j === width / 2 - 1) cells.push('');
    }
    let ascii = '';
    for (const b of row) ascii += b >= 0x20 && b <= 0x7e ? String.fromCharCode(b) : '.';
    lines.push(`${(base + i).toString(16).padStart(8, '0')}  ${cells.join(' ')}  |${ascii}|`);
  }
  return lines.join('\n');
}

export interface JsonDetection {
  readonly value: unknown;
  /** Two-space indented. */
  readonly pretty: string;
}

/**
 * Parses the bytes as a JSON object or array (UTF-8), for the string editor's JSON view.
 * Undefined for anything else, including bare JSON scalars (every number would qualify).
 */
export function detectJson(bytes: Uint8Array): JsonDetection | undefined {
  const text = tryUtf8(bytes)?.trim();
  if (!text || (text[0] !== '{' && text[0] !== '[')) return undefined;
  try {
    const value: unknown = JSON.parse(text);
    return { value, pretty: JSON.stringify(value, null, 2) };
  } catch {
    return undefined;
  }
}

function hasControlCharacters(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if ((code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) || code === 0x7f)
      return true;
  }
  return false;
}

export type ValueFormat = 'empty' | 'hyperloglog' | 'json' | 'text' | 'messagepack' | 'binary';

/** The view a string value should open in by default. */
export function detectValueFormat(bytes: Uint8Array): ValueFormat {
  if (bytes.length === 0) return 'empty';
  if (detectHyperLogLog(bytes)) return 'hyperloglog';
  if (detectJson(bytes)) return 'json';
  const text = tryUtf8(bytes);
  // Text without control characters (tabs and line breaks are fine).
  if (text !== undefined && !hasControlCharacters(text)) return 'text';
  if (looksLikeMessagePack(bytes)) return 'messagepack';
  return 'binary';
}

// ---------------------------------------------------------------------------------------------
// Bitmaps

/** Bit `index` of a bitmap as GETBIT sees it (bit 0 is the most significant bit of byte 0). */
export function bitAt(bytes: Uint8Array, index: number): 0 | 1 {
  const byte = bytes[index >> 3];
  if (byte === undefined) return 0;
  return ((byte >> (7 - (index & 7))) & 1) as 0 | 1;
}

/** `count` bits starting at bit `start`, in GETBIT order. */
export function bitsView(
  bytes: Uint8Array,
  start = 0,
  count = bytes.length * 8 - start,
): (0 | 1)[] {
  const out: (0 | 1)[] = [];
  for (let i = start; i < start + count; i++) out.push(bitAt(bytes, i));
  return out;
}

/** Set bits, like BITCOUNT over the whole value. */
export function countBits(bytes: Uint8Array): number {
  let count = 0;
  for (let b of bytes) {
    while (b) {
      b &= b - 1;
      count += 1;
    }
  }
  return count;
}

/** Offsets of set bits in `bytes` (at most `limit`), e.g. for a "set bits" list view. */
export function setBitOffsets(bytes: Uint8Array, limit = 10_000, baseByte = 0): number[] {
  const out: number[] = [];
  for (let i = 0; i < bytes.length && out.length < limit; i++) {
    const b = bytes[i]!;
    if (b === 0) continue;
    for (let bit = 0; bit < 8 && out.length < limit; bit++) {
      if ((b >> (7 - bit)) & 1) out.push((baseByte + i) * 8 + bit);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// HyperLogLog

export interface HyperLogLogHeader {
  readonly encoding: 'dense' | 'sparse';
  /** The cardinality cached in the header, or null when the cache is marked stale. */
  readonly cachedCardinality: number | null;
}

const HLL_DENSE_SIZE = 16 + 12288;

/**
 * Recognises Redis's HyperLogLog string format ("HYLL" magic, encoding byte, cached
 * cardinality). Undefined for any other string. PFCOUNT gives the exact estimate.
 */
export function detectHyperLogLog(bytes: Uint8Array): HyperLogLogHeader | undefined {
  if (bytes.length < 16) return undefined;
  if (bytes[0] !== 0x48 || bytes[1] !== 0x59 || bytes[2] !== 0x4c || bytes[3] !== 0x4c) {
    return undefined;
  }
  const encoding = bytes[4];
  if (encoding !== 0 && encoding !== 1) return undefined;
  if (encoding === 0 && bytes.length !== HLL_DENSE_SIZE) return undefined;
  const stale = (bytes[15]! & 0x80) !== 0;
  let card = 0;
  for (let i = 7; i >= 0; i--) card = card * 256 + bytes[8 + i]!;
  return { encoding: encoding === 0 ? 'dense' : 'sparse', cachedCardinality: stale ? null : card };
}

// ---------------------------------------------------------------------------------------------
// Geo

const GEO_STEP = 26;
const GEO_LAT_MIN = -85.05112878;
const GEO_LAT_MAX = 85.05112878;
const GEO_LON_MIN = -180;
const GEO_LON_MAX = 180;

function interleave(latBits: number, lonBits: number): bigint {
  let out = 0n;
  for (let i = 0; i < GEO_STEP; i++) {
    out |= BigInt((latBits >>> i) & 1) << BigInt(2 * i);
    out |= BigInt((lonBits >>> i) & 1) << BigInt(2 * i + 1);
  }
  return out;
}

function deinterleave(bits: bigint): { lat: number; lon: number } {
  let lat = 0;
  let lon = 0;
  for (let i = 0; i < GEO_STEP; i++) {
    lat += Number((bits >> BigInt(2 * i)) & 1n) * 2 ** i;
    lon += Number((bits >> BigInt(2 * i + 1)) & 1n) * 2 ** i;
  }
  return { lat, lon };
}

export interface GeoPoint {
  readonly longitude: number;
  readonly latitude: number;
}

/** The 52-bit sorted-set score Redis stores for a GEOADD position. */
export function encodeGeoScore(longitude: number, latitude: number): number {
  if (
    latitude < GEO_LAT_MIN ||
    latitude > GEO_LAT_MAX ||
    longitude < GEO_LON_MIN ||
    longitude > GEO_LON_MAX
  ) {
    throw new RangeError(
      'Position out of range for Redis geo (latitude ±85.05112878, longitude ±180)',
    );
  }
  const scale = 2 ** GEO_STEP;
  const lat = Math.min(
    scale - 1,
    Math.floor(((latitude - GEO_LAT_MIN) / (GEO_LAT_MAX - GEO_LAT_MIN)) * scale),
  );
  const lon = Math.min(
    scale - 1,
    Math.floor(((longitude - GEO_LON_MIN) / (GEO_LON_MAX - GEO_LON_MIN)) * scale),
  );
  return Number(interleave(lat, lon));
}

/** The position (cell centre) behind a geo sorted-set score, as GEOPOS returns it. */
export function decodeGeoScore(score: number): GeoPoint {
  const { lat, lon } = deinterleave(BigInt(Math.trunc(score)));
  const scale = 2 ** GEO_STEP;
  const latMin = GEO_LAT_MIN + (lat / scale) * (GEO_LAT_MAX - GEO_LAT_MIN);
  const latMax = GEO_LAT_MIN + ((lat + 1) / scale) * (GEO_LAT_MAX - GEO_LAT_MIN);
  const lonMin = GEO_LON_MIN + (lon / scale) * (GEO_LON_MAX - GEO_LON_MIN);
  const lonMax = GEO_LON_MIN + ((lon + 1) / scale) * (GEO_LON_MAX - GEO_LON_MIN);
  return {
    longitude: Math.max(GEO_LON_MIN, Math.min(GEO_LON_MAX, (lonMin + lonMax) / 2)),
    latitude: Math.max(GEO_LAT_MIN, Math.min(GEO_LAT_MAX, (latMin + latMax) / 2)),
  };
}

const GEO_ALPHABET = '0123456789bcdefghjkmnpqrstuvwxyz';

/** The 11-character standard geohash GEOHASH returns for a position. */
export function geohashString(longitude: number, latitude: number): string {
  const scale = 2 ** GEO_STEP;
  const lat = Math.min(scale - 1, Math.floor(((latitude + 90) / 180) * scale));
  const lon = Math.min(scale - 1, Math.floor(((longitude + 180) / 360) * scale));
  const bits = interleave(lat, lon);
  let out = '';
  for (let i = 0; i < 11; i++) {
    const idx = i === 10 ? 0 : Number((bits >> BigInt(52 - (i + 1) * 5)) & 31n);
    out += GEO_ALPHABET[idx];
  }
  return out;
}
