import { cancelledError } from '@joinery/core';

/**
 * A streaming reader of Redis and Valkey RDB snapshot files (dump.rdb), for analysing a dump
 * offline: every key with its type, encoding, size in the file, element count and expiry, plus
 * the file's AUX fields, databases and functions. Values are never kept: large ones are
 * skipped as they stream past, and only the small encoded blobs whose headers hold an element
 * count (listpacks, ziplists, intsets) are read.
 *
 * Covers RDB versions 1 to 13 (Redis up to 8.6) and Valkey's 80 and 81, including module
 * values (skipped through their annotations and named by their module type), streams with
 * consumer groups, hashes with field expirations, and key metadata. Pure TypeScript: the file
 * arrives as chunks from any source.
 */

// ---------------------------------------------------------------------------------------------
// Errors

export class RdbError extends Error {
  constructor(
    message: string,
    /** Byte offset in the file where reading stopped. */
    readonly offset: number,
  ) {
    super(message);
    this.name = 'RdbError';
  }
}

// ---------------------------------------------------------------------------------------------
// Chunked input

/** Reads bytes from a stream of chunks, keeping only what has not been consumed yet. */
class ByteReader {
  #buffer: Uint8Array = new Uint8Array(0);
  #at = 0;
  /** Bytes consumed before `#buffer`. */
  #base = 0;
  #ended = false;
  readonly #chunks: AsyncIterator<Uint8Array>;

  constructor(source: AsyncIterable<Uint8Array>) {
    this.#chunks = source[Symbol.asyncIterator]();
  }

  /** Bytes consumed so far: the file offset of the next byte. */
  get offset(): number {
    return this.#base + this.#at;
  }

  get #available(): number {
    return this.#buffer.length - this.#at;
  }

  /** Makes `n` bytes available; returns nothing when they already are (no await needed). */
  need(n: number): Promise<void> | undefined {
    return this.#available >= n ? undefined : this.#fill(n);
  }

  async #fill(n: number): Promise<void> {
    const rest = this.#buffer.subarray(this.#at);
    const parts: Uint8Array[] = rest.length > 0 ? [rest] : [];
    let length = rest.length;
    while (length < n) {
      if (this.#ended) throw new RdbError('The file ends in the middle of a record', this.offset);
      const next = await this.#chunks.next();
      if (next.done === true) {
        this.#ended = true;
        continue;
      }
      if (next.value.length === 0) continue;
      parts.push(next.value);
      length += next.value.length;
    }
    this.#base += this.#at;
    this.#at = 0;
    if (parts.length === 1) {
      this.#buffer = parts[0]!;
      return;
    }
    const joined = new Uint8Array(length);
    let at = 0;
    for (const part of parts) {
      joined.set(part, at);
      at += part.length;
    }
    this.#buffer = joined;
  }

  /** One byte; call `need(1)` first. */
  byte(): number {
    return this.#buffer[this.#at++]!;
  }

  /** `n` bytes as a view (valid until the next `need`); call `need(n)` first. */
  take(n: number): Uint8Array {
    const bytes = this.#buffer.subarray(this.#at, this.#at + n);
    this.#at += n;
    return bytes;
  }

  /**
   * Reads `n` bytes into a new array. Copied explicitly: a chunk may be a Node.js byte buffer, whose
   * `slice` is a view that would keep the whole chunk alive.
   */
  async bytes(n: number): Promise<Uint8Array> {
    const pending = this.need(n);
    if (pending) await pending;
    const copy = new Uint8Array(n);
    copy.set(this.take(n));
    return copy;
  }

  /** Discards `n` bytes without holding them. */
  async skip(n: number): Promise<void> {
    let left = n;
    for (;;) {
      const here = Math.min(left, this.#available);
      this.#at += here;
      left -= here;
      if (left === 0) return;
      if (this.#ended) throw new RdbError('The file ends in the middle of a value', this.offset);
      const next = await this.#chunks.next();
      this.#base += this.#buffer.length;
      this.#buffer = new Uint8Array(0);
      this.#at = 0;
      if (next.done === true) this.#ended = true;
      else this.#buffer = next.value;
    }
  }

  /** True once every byte has been consumed and the source is done. */
  async atEnd(): Promise<boolean> {
    if (this.#available > 0) return false;
    while (!this.#ended) {
      const next = await this.#chunks.next();
      if (next.done === true) {
        this.#ended = true;
        break;
      }
      if (next.value.length > 0) {
        this.#base += this.#buffer.length;
        this.#buffer = next.value;
        this.#at = 0;
        return false;
      }
    }
    return true;
  }

  async close(): Promise<void> {
    await this.#chunks.return?.();
  }
}

// ---------------------------------------------------------------------------------------------
// LZF

/** Decompresses Redis's LZF-compressed strings. */
export function lzfDecompress(input: Uint8Array, outputLength: number): Uint8Array {
  const out = new Uint8Array(outputLength);
  let i = 0;
  let o = 0;
  while (i < input.length) {
    const ctrl = input[i++]!;
    if (ctrl < 32) {
      const length = ctrl + 1;
      if (o + length > outputLength || i + length > input.length) {
        throw new Error('Corrupt LZF literal');
      }
      out.set(input.subarray(i, i + length), o);
      i += length;
      o += length;
      continue;
    }
    let length = ctrl >> 5;
    let ref = o - ((ctrl & 0x1f) << 8) - 1;
    if (length === 7) length += input[i++]!;
    ref -= input[i++]!;
    length += 2;
    if (ref < 0 || o + length > outputLength) throw new Error('Corrupt LZF back reference');
    for (let k = 0; k < length; k++) out[o++] = out[ref++]!;
  }
  if (o !== outputLength) throw new Error('LZF output is shorter than its header says');
  return out;
}

// ---------------------------------------------------------------------------------------------
// Encoded blobs: element counts

const le16 = (b: Uint8Array, at: number): number => b[at]! | (b[at + 1]! << 8);
const le32 = (b: Uint8Array, at: number): number =>
  (b[at]! | (b[at + 1]! << 8) | (b[at + 2]! << 16) | (b[at + 3]! << 24)) >>> 0;
const be32 = (b: Uint8Array, at: number): number =>
  ((b[at]! << 24) | (b[at + 1]! << 16) | (b[at + 2]! << 8) | b[at + 3]!) >>> 0;

/**
 * Walks a listpack's entries, calling `visit` with each one's index and its integer value (null
 * for strings). Returns the number of entries.
 */
function walkListpack(lp: Uint8Array, visit?: (index: number, int: number | null) => void): number {
  let count = 0;
  let at = 6;
  const view = new DataView(lp.buffer, lp.byteOffset, lp.byteLength);
  while (at < lp.length && lp[at] !== 0xff) {
    const b = lp[at]!;
    let size: number;
    let int: number | null = null;
    if ((b & 0x80) === 0) {
      size = 1;
      int = b;
    } else if ((b & 0xc0) === 0x80) size = 1 + (b & 0x3f);
    else if ((b & 0xe0) === 0xc0) {
      size = 2;
      const v = ((b & 0x1f) << 8) | lp[at + 1]!;
      int = v >= 4096 ? v - 8192 : v;
    } else if ((b & 0xf0) === 0xe0) size = 2 + (((b & 0x0f) << 8) | lp[at + 1]!);
    else if (b === 0xf0) size = 5 + le32(lp, at + 1);
    else if (b === 0xf1) {
      size = 3;
      int = view.getInt16(at + 1, true);
    } else if (b === 0xf2) {
      size = 4;
      int = ((lp[at + 1]! | (lp[at + 2]! << 8) | (lp[at + 3]! << 16)) << 8) >> 8;
    } else if (b === 0xf3) {
      size = 5;
      int = view.getInt32(at + 1, true);
    } else if (b === 0xf4) {
      size = 9;
      int = Number(view.getBigInt64(at + 1, true));
    } else throw new Error(`Unknown listpack encoding 0x${b.toString(16)}`);
    const backlen =
      size < 128 ? 1 : size < 16384 ? 2 : size < 2097152 ? 3 : size < 268435456 ? 4 : 5;
    visit?.(count, int);
    at += size + backlen;
    count++;
  }
  return count;
}

/** Entries of a listpack: the header's count, or a walk when it overflowed (65535). */
export function listpackCount(lp: Uint8Array): number {
  if (lp.length < 7) throw new Error('A listpack is shorter than its header');
  const header = le16(lp, 4);
  return header !== 0xffff ? header : walkListpack(lp);
}

/**
 * Fields with an expiry in a hash listpack of (field, value, expiry) triplets, as Redis 7.4
 * writes hashes with field expirations: an expiry of 0 means none.
 */
export function listpackFieldTtls(lp: Uint8Array): number {
  if (lp.length < 7) throw new Error('A listpack is shorter than its header');
  let withTtl = 0;
  walkListpack(lp, (index, int) => {
    if (index % 3 === 2 && int !== null && int !== 0) withTtl++;
  });
  return withTtl;
}

/** Entries of a ziplist: the header's count, or a walk when it overflowed (65535). */
export function ziplistCount(zl: Uint8Array): number {
  if (zl.length < 11) throw new Error('A ziplist is shorter than its header');
  const header = le16(zl, 8);
  if (header !== 0xffff) return header;
  let count = 0;
  let at = 10;
  while (at < zl.length && zl[at] !== 0xff) {
    at += zl[at] === 0xfe ? 5 : 1;
    const b = zl[at]!;
    const kind = b >> 6;
    if (kind === 0) at += 1 + (b & 0x3f);
    else if (kind === 1) at += 2 + (((b & 0x3f) << 8) | zl[at + 1]!);
    else if (kind === 2) at += 5 + be32(zl, at + 1);
    else if (b === 0xc0) at += 3;
    else if (b === 0xd0) at += 5;
    else if (b === 0xe0) at += 9;
    else if (b === 0xf0) at += 4;
    else if (b === 0xfe) at += 2;
    else if (b >= 0xf1 && b <= 0xfd) at += 1;
    else throw new Error(`Unknown ziplist encoding 0x${b.toString(16)}`);
    count++;
  }
  return count;
}

/** Entries of a zipmap (Redis 2.x hashes): the header's count, or a walk from 254. */
export function zipmapCount(zm: Uint8Array): number {
  if (zm.length < 2) throw new Error('A zipmap is shorter than its header');
  if (zm[0]! < 254) return zm[0]!;
  let count = 0;
  let at = 1;
  const length = (): number => {
    const b = zm[at]!;
    if (b < 254) {
      at += 1;
      return b;
    }
    const n = le32(zm, at + 1);
    at += 5;
    return n;
  };
  while (at < zm.length && zm[at] !== 0xff) {
    at += length(); // key
    const value = length();
    const free = zm[at++]!;
    at += value + free;
    count++;
  }
  return count;
}

/** Members of an intset. */
export function intsetCount(is: Uint8Array): number {
  if (is.length < 8) throw new Error('An intset is shorter than its header');
  return le32(is, 4);
}

// ---------------------------------------------------------------------------------------------
// Modules

const MODULE_CHARSET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** A module type's 9-character name from its 64-bit id (`ReJSON-RL`, `TSDB-TYPE`...). */
export function moduleTypeName(id: bigint): string {
  let name = '';
  for (let i = 0; i < 9; i++) {
    name += MODULE_CHARSET[Number((id >> BigInt(64 - 6 * (i + 1))) & 63n)]!;
  }
  return name;
}

// ---------------------------------------------------------------------------------------------
// Records

/** A key as the dump holds it. */
export interface RdbKey {
  readonly db: number;
  /** The key's name (its first 4 KiB when longer; see `keyLength`). */
  readonly key: Uint8Array;
  readonly keyLength: number;
  /** string, list, set, zset, hash, stream, or a module type's name (ReJSON-RL...). */
  readonly type: string;
  /** How the dump encodes it: int, raw, listpack, ziplist, quicklist, intset, hashtable... */
  readonly encoding: string;
  /** The RDB type byte. */
  readonly rdbType: number;
  /** Bytes the key takes in the file, its expiry and metadata included. */
  readonly bytes: number;
  /** A string's length in bytes, a collection's elements, a stream's entries; null if unknown. */
  readonly elements: number | null;
  /** Expiry, milliseconds since the epoch; null without one. */
  readonly expiresAt: number | null;
  /** Hash fields with their own expiry (Redis 7.4 hash field expiration, Valkey 9). */
  readonly fieldsWithTtl?: number;
  /** Streams: consumer groups. */
  readonly groups?: number;
  /** LRU idle seconds or LFU frequency, when the dump kept them. */
  readonly idle?: number;
  readonly frequency?: number;
}

export interface RdbHandlers {
  /** The version from the header (`REDIS0011` → 11). */
  readonly onHeader?: (version: number) => void;
  /** AUX fields: redis-ver, redis-bits, ctime, used-mem, aof-base, repl-id... */
  readonly onAux?: (name: string, value: string) => void;
  /** SELECTDB. */
  readonly onDatabase?: (db: number) => void;
  /** RESIZEDB hints: keys and keys with an expiry in the current database. */
  readonly onResize?: (db: number, keys: number, expires: number) => void;
  readonly onKey: (key: RdbKey) => void;
  /** A function library (FUNCTION LOAD) saved with the data. */
  readonly onFunction?: (bytes: number) => void;
  /** Module data outside the keyspace. */
  readonly onModuleAux?: (module: string, bytes: number) => void;
  /** Bytes read so far, at most every `progressBytes`. */
  readonly onProgress?: (bytes: number) => void;
}

export interface RdbReadOptions {
  readonly signal?: AbortSignal;
  /** Report progress this often (default 4 MiB). */
  readonly progressBytes?: number;
}

export interface RdbSummary {
  readonly version: number;
  readonly bytes: number;
  /** The CRC-64 at the end (RDB 5 and later); null when absent or zero (checksums off). */
  readonly checksum: string | null;
}

const KEY_KEEP = 4096;

/** Opcodes. */
const OP = {
  KEY_META: 243, // Redis 8.6; SLOT_IMPORT in Valkey 9
  SLOT_INFO: 244,
  FUNCTION2: 245,
  FUNCTION_PRE_GA: 246,
  MODULE_AUX: 247,
  IDLE: 248,
  FREQ: 249,
  AUX: 250,
  RESIZEDB: 251,
  EXPIRETIME_MS: 252,
  EXPIRETIME: 253,
  SELECTDB: 254,
  EOF: 255,
} as const;

interface TypeInfo {
  readonly type: string;
  readonly encoding: string;
}

/** RDB value types, before Valkey's own numbering (RDB 80 and later) takes over at 22. */
const TYPES: Readonly<Record<number, TypeInfo>> = {
  0: { type: 'string', encoding: 'raw' },
  1: { type: 'list', encoding: 'linkedlist' },
  2: { type: 'set', encoding: 'hashtable' },
  3: { type: 'zset', encoding: 'skiplist' },
  4: { type: 'hash', encoding: 'hashtable' },
  5: { type: 'zset', encoding: 'skiplist' },
  7: { type: 'module', encoding: 'module' },
  9: { type: 'hash', encoding: 'zipmap' },
  10: { type: 'list', encoding: 'ziplist' },
  11: { type: 'set', encoding: 'intset' },
  12: { type: 'zset', encoding: 'ziplist' },
  13: { type: 'hash', encoding: 'ziplist' },
  14: { type: 'list', encoding: 'quicklist' },
  15: { type: 'stream', encoding: 'stream' },
  16: { type: 'hash', encoding: 'listpack' },
  17: { type: 'zset', encoding: 'listpack' },
  18: { type: 'list', encoding: 'quicklist' },
  19: { type: 'stream', encoding: 'stream' },
  20: { type: 'set', encoding: 'listpack' },
  21: { type: 'stream', encoding: 'stream' },
  22: { type: 'hash', encoding: 'hashtable' },
  23: { type: 'hash', encoding: 'listpack' },
  24: { type: 'hash', encoding: 'hashtable' },
  25: { type: 'hash', encoding: 'listpack' },
  26: { type: 'stream', encoding: 'stream' },
};

const VALKEY_TYPES: Readonly<Record<number, TypeInfo>> = {
  22: { type: 'hash', encoding: 'hashtable' },
  23: { type: 'hash', encoding: 'pathhash' },
};

/** Valkey numbers RDB versions from 80 on its own; Redis stays below. */
const VALKEY_FIRST_VERSION = 80;

// ---------------------------------------------------------------------------------------------
// The reader

/** A length and whether it is a special string encoding (RDB_ENCVAL). */
interface Length {
  readonly value: number;
  readonly encoded: boolean;
}

class RdbParser {
  readonly #in: ByteReader;
  readonly #handlers: RdbHandlers;
  readonly #options: RdbReadOptions;
  version = 0;
  #db = 0;
  #lastProgress = 0;
  #keys = 0;

  constructor(source: AsyncIterable<Uint8Array>, handlers: RdbHandlers, options: RdbReadOptions) {
    this.#in = new ByteReader(source);
    this.#handlers = handlers;
    this.#options = options;
  }

  #fail(message: string): never {
    throw new RdbError(message, this.#in.offset);
  }

  async #byte(): Promise<number> {
    const pending = this.#in.need(1);
    if (pending) await pending;
    return this.#in.byte();
  }

  /** rdbLoadLen: a length, or a string's special encoding. */
  async #length(): Promise<Length> {
    const pending = this.#in.need(1);
    if (pending) await pending;
    const first = this.#in.byte();
    const kind = first >> 6;
    if (kind === 0) return { value: first & 0x3f, encoded: false };
    if (kind === 1) {
      const next = await this.#byte();
      return { value: ((first & 0x3f) << 8) | next, encoded: false };
    }
    if (kind === 3) return { value: first & 0x3f, encoded: true };
    if (first === 0x80) {
      const b = await this.#in.bytes(4);
      return { value: be32(b, 0), encoded: false };
    }
    if (first === 0x81) {
      const b = await this.#in.bytes(8);
      const value = be32(b, 0) * 2 ** 32 + be32(b, 4);
      if (!Number.isSafeInteger(value)) this.#fail('A length does not fit in 2^53');
      return { value, encoded: false };
    }
    return this.#fail(`Unknown length encoding 0x${first.toString(16)}`);
  }

  async #len(): Promise<number> {
    const length = await this.#length();
    if (length.encoded) this.#fail('A string encoding where a length was expected');
    return length.value;
  }

  /** A 64-bit length exactly (module ids). */
  async #len64(): Promise<bigint> {
    const pending = this.#in.need(1);
    if (pending) await pending;
    const first = this.#in.byte();
    if (first === 0x81) {
      const b = await this.#in.bytes(8);
      return (BigInt(be32(b, 0)) << 32n) | BigInt(be32(b, 4));
    }
    const kind = first >> 6;
    if (kind === 0) return BigInt(first & 0x3f);
    if (kind === 1) return BigInt(((first & 0x3f) << 8) | (await this.#byte()));
    if (first === 0x80) return BigInt(be32(await this.#in.bytes(4), 0));
    return this.#fail(`Unknown length encoding 0x${first.toString(16)}`);
  }

  /**
   * A string. `keep`: how many bytes to return (the rest is skipped); `Infinity` for all,
   * decompressed. Returns the bytes kept and the string's full length.
   */
  async #string(keep: number): Promise<{ bytes: Uint8Array; length: number; int: boolean }> {
    const length = await this.#length();
    if (length.encoded) {
      switch (length.value) {
        case 0:
        case 1:
        case 2: {
          const size = 1 << length.value;
          const b = await this.#in.bytes(size);
          const value =
            size === 1
              ? (b[0]! << 24) >> 24
              : size === 2
                ? (le16(b, 0) << 16) >> 16
                : le32(b, 0) | 0;
          const text = new TextEncoder().encode(String(value));
          return { bytes: text, length: text.length, int: true };
        }
        case 3: {
          const compressed = await this.#len();
          const plain = await this.#len();
          if (keep === 0) {
            await this.#in.skip(compressed);
            return { bytes: new Uint8Array(0), length: plain, int: false };
          }
          const data = await this.#in.bytes(compressed);
          let bytes: Uint8Array;
          try {
            bytes = lzfDecompress(data, plain);
          } catch (error) {
            this.#fail((error as Error).message);
          }
          return { bytes: keep < plain ? bytes.slice(0, keep) : bytes, length: plain, int: false };
        }
        default:
          this.#fail(`Unknown string encoding ${length.value}`);
      }
    }
    const size = length.value;
    if (keep >= size) return { bytes: await this.#in.bytes(size), length: size, int: false };
    const bytes = keep > 0 ? await this.#in.bytes(keep) : new Uint8Array(0);
    await this.#in.skip(size - keep);
    return { bytes, length: size, int: false };
  }

  async #skipString(): Promise<void> {
    await this.#string(0);
  }

  /** An encoded blob (listpack, ziplist...) in full. */
  async #blob(): Promise<Uint8Array> {
    return (await this.#string(Infinity)).bytes;
  }

  /** rdbLoadDoubleValue (the old ZSET format). */
  async #skipTextDouble(): Promise<void> {
    const size = await this.#byte();
    if (size < 253) await this.#in.skip(size);
  }

  /** Module annotated values up to their EOF (rdbLoadCheckModuleValue). */
  async #skipModuleValue(): Promise<void> {
    for (;;) {
      const opcode = await this.#len();
      switch (opcode) {
        case 0:
          return;
        case 1:
        case 2:
          // Module integers are full 64-bit values (hashes, seeds): read, never converted.
          await this.#len64();
          break;
        case 3:
          await this.#in.skip(4);
          break;
        case 4:
          await this.#in.skip(8);
          break;
        case 5:
          await this.#skipString();
          break;
        default:
          this.#fail(`Unknown module opcode ${opcode}`);
      }
    }
  }

  async #millis(): Promise<number> {
    const b = await this.#in.bytes(8);
    return le32(b, 0) + le32(b, 4) * 2 ** 32;
  }

  #count(read: () => number): number {
    try {
      return read();
    } catch (error) {
      return this.#fail((error as Error).message);
    }
  }

  /** Reads one value of `rdbType`; returns what the key record needs. */
  async #value(rdbType: number): Promise<{
    elements: number | null;
    type?: string;
    fieldsWithTtl?: number;
    groups?: number;
    int?: boolean;
  }> {
    const valkey = this.version >= VALKEY_FIRST_VERSION;
    switch (rdbType) {
      case 0: {
        const value = await this.#string(0);
        return { elements: value.length, int: value.int };
      }
      case 1:
      case 2: {
        const n = await this.#len();
        for (let i = 0; i < n; i++) await this.#skipString();
        return { elements: n };
      }
      case 3: {
        const n = await this.#len();
        for (let i = 0; i < n; i++) {
          await this.#skipString();
          await this.#skipTextDouble();
        }
        return { elements: n };
      }
      case 4: {
        const n = await this.#len();
        for (let i = 0; i < 2 * n; i++) await this.#skipString();
        return { elements: n };
      }
      case 5: {
        const n = await this.#len();
        for (let i = 0; i < n; i++) {
          await this.#skipString();
          await this.#in.skip(8);
        }
        return { elements: n };
      }
      case 6:
        return this.#fail('Module values from Redis 4.0 release candidates cannot be read');
      case 7: {
        const id = await this.#len64();
        await this.#skipModuleValue();
        return { elements: null, type: moduleTypeName(id) };
      }
      case 9: {
        const blob = await this.#blob();
        return { elements: this.#count(() => zipmapCount(blob)) };
      }
      case 10: {
        const blob = await this.#blob();
        return { elements: this.#count(() => ziplistCount(blob)) };
      }
      case 11: {
        const blob = await this.#blob();
        return { elements: this.#count(() => intsetCount(blob)) };
      }
      case 12:
      case 13: {
        const blob = await this.#blob();
        return { elements: this.#count(() => ziplistCount(blob) / 2) };
      }
      case 14: {
        const nodes = await this.#len();
        let elements = 0;
        for (let i = 0; i < nodes; i++) {
          const blob = await this.#blob();
          elements += this.#count(() => ziplistCount(blob));
        }
        return { elements };
      }
      case 18: {
        const nodes = await this.#len();
        let elements = 0;
        for (let i = 0; i < nodes; i++) {
          const container = await this.#len();
          if (container === 1) {
            await this.#skipString();
            elements += 1;
          } else {
            const blob = await this.#blob();
            elements += this.#count(() => listpackCount(blob));
          }
        }
        return { elements };
      }
      case 16:
      case 17: {
        const blob = await this.#blob();
        return { elements: this.#count(() => listpackCount(blob) / 2) };
      }
      case 20: {
        const blob = await this.#blob();
        return { elements: this.#count(() => listpackCount(blob)) };
      }
      case 15:
      case 19:
      case 21:
      case 26:
        return this.#stream(rdbType);
      case 22:
        if (valkey) {
          // Valkey 9 HASH_2: field, value, expiry (ms, or -1 for none).
          const n = await this.#len();
          let withTtl = 0;
          for (let i = 0; i < n; i++) {
            await this.#skipString();
            await this.#skipString();
            const b = await this.#in.bytes(8);
            if (!b.every((byte) => byte === 0xff)) withTtl++;
          }
          return { elements: n, fieldsWithTtl: withTtl };
        }
        return this.#hashWithTtls(false);
      case 23:
        if (valkey) {
          // Valkey 9.2 path hashes: paths, each with its fields and values.
          const paths = await this.#len();
          let elements = 0;
          for (let p = 0; p < paths; p++) {
            await this.#skipString();
            const fields = await this.#len();
            for (let i = 0; i < 2 * fields; i++) await this.#skipString();
            elements += fields;
          }
          return { elements };
        }
        return this.#listpackWithTtls(false);
      case 24:
        return this.#hashWithTtls(true);
      case 25:
        return this.#listpackWithTtls(true);
      default:
        return this.#fail(
          `Value type ${rdbType} is not one Joinery reads (RDB version ${this.version})`,
        );
    }
  }

  /** Redis 7.4 small hashes with field expirations: [min expiry], a listpack of triplets. */
  async #listpackWithTtls(
    minExpiry: boolean,
  ): Promise<{ elements: number; fieldsWithTtl: number }> {
    if (minExpiry) await this.#in.skip(8);
    const blob = await this.#blob();
    return {
      elements: this.#count(() => listpackCount(blob) / 3),
      fieldsWithTtl: this.#count(() => listpackFieldTtls(blob)),
    };
  }

  /** Redis 7.4 hashes with field expirations: [min expiry], then TTL, field, value per field. */
  async #hashWithTtls(minExpiry: boolean): Promise<{ elements: number; fieldsWithTtl: number }> {
    if (minExpiry) await this.#in.skip(8);
    const n = await this.#len();
    let withTtl = 0;
    for (let i = 0; i < n; i++) {
      if ((await this.#length()).value !== 0) withTtl++;
      await this.#skipString();
      await this.#skipString();
    }
    return { elements: n, fieldsWithTtl: withTtl };
  }

  async #stream(rdbType: number): Promise<{ elements: number; groups: number }> {
    const listpacks = await this.#len();
    for (let i = 0; i < listpacks; i++) {
      await this.#skipString(); // master ID
      await this.#skipString(); // listpack of entries
    }
    const length = await this.#len();
    await this.#len(); // last ID ms
    await this.#len(); // last ID seq
    if (rdbType >= 19) {
      for (let i = 0; i < 5; i++) await this.#len(); // first ID, max deleted ID, entries added
    }
    const groups = await this.#len();
    for (let g = 0; g < groups; g++) {
      await this.#skipString(); // name
      await this.#len();
      await this.#len(); // last delivered ID
      if (rdbType >= 19) await this.#len(); // entries read
      const pending = await this.#len();
      for (let i = 0; i < pending; i++) {
        await this.#in.skip(16 + 8); // entry ID, delivery time
        await this.#len(); // delivery count
      }
      const consumers = await this.#len();
      for (let c = 0; c < consumers; c++) {
        await this.#skipString(); // name
        await this.#in.skip(rdbType >= 21 ? 16 : 8); // seen time [, active time]
        const owned = await this.#len();
        await this.#in.skip(16 * owned);
      }
    }
    if (rdbType >= 26) {
      await this.#len(); // IDMP duration
      await this.#len(); // IDMP max entries
      const producers = await this.#len();
      for (let p = 0; p < producers; p++) {
        await this.#skipString();
        const entries = await this.#len();
        for (let e = 0; e < entries; e++) {
          await this.#skipString();
          await this.#len64();
          await this.#len64();
        }
      }
      await this.#len64(); // IIDs added
      await this.#len64(); // duplicate IIDs
    }
    return { elements: length, groups };
  }

  #progress(): void {
    const every = this.#options.progressBytes ?? 4 * 1024 * 1024;
    const at = this.#in.offset;
    if (at - this.#lastProgress >= every) {
      this.#lastProgress = at;
      this.#handlers.onProgress?.(at);
    }
  }

  async run(): Promise<RdbSummary> {
    try {
      return await this.#run();
    } finally {
      await this.#in.close();
    }
  }

  async #run(): Promise<RdbSummary> {
    const magic = await this.#in.bytes(9).catch(() => this.#fail('This is not an RDB file'));
    const text = new TextDecoder('latin1').decode(magic);
    // REDIS0 and three digits, or VALKEY and three from Valkey 9 (RDB 80) on.
    const header = /^(?:REDIS0|VALKEY)(\d{3})$/.exec(text);
    if (!header) {
      this.#fail('This is not an RDB file: it does not start with REDIS or VALKEY and a version');
    }
    this.version = Number(header[1]);
    if (
      this.version < 1 ||
      (this.version > 13 && this.version < VALKEY_FIRST_VERSION) ||
      this.version > 81
    ) {
      this.#fail(
        `RDB version ${this.version} is newer than Joinery reads (up to 13, and Valkey's 80 and 81)`,
      );
    }
    this.#handlers.onHeader?.(this.version);

    let expiresAt: number | null = null;
    let idle: number | undefined;
    let frequency: number | undefined;
    let keyStart = -1;
    const signal = this.#options.signal;

    for (;;) {
      const start = this.#in.offset;
      const opcode = await this.#byte();
      switch (opcode) {
        case OP.EOF: {
          let checksum: string | null = null;
          if (this.version >= 5) {
            const b = await this.#in.bytes(8).catch(() => new Uint8Array(0));
            if (b.length === 8 && b.some((byte) => byte !== 0)) {
              checksum = [...b]
                .reverse()
                .map((byte) => byte.toString(16).padStart(2, '0'))
                .join('');
            }
          }
          this.#handlers.onProgress?.(this.#in.offset);
          return { version: this.version, bytes: this.#in.offset, checksum };
        }
        case OP.SELECTDB:
          this.#db = await this.#len();
          this.#handlers.onDatabase?.(this.#db);
          continue;
        case OP.RESIZEDB: {
          const keys = await this.#len();
          const expires = await this.#len();
          this.#handlers.onResize?.(this.#db, keys, expires);
          continue;
        }
        case OP.AUX: {
          const decoder = new TextDecoder('utf-8', { fatal: false });
          const name = decoder.decode((await this.#string(1024)).bytes);
          const value = decoder.decode((await this.#string(1024)).bytes);
          this.#handlers.onAux?.(name, value);
          continue;
        }
        case OP.MODULE_AUX: {
          const id = await this.#len64();
          if ((await this.#len()) !== 2) this.#fail('Module AUX data without its "when"');
          await this.#len();
          await this.#skipModuleValue();
          this.#handlers.onModuleAux?.(moduleTypeName(id), this.#in.offset - start);
          continue;
        }
        case OP.FUNCTION2:
          await this.#skipString();
          this.#handlers.onFunction?.(this.#in.offset - start);
          continue;
        case OP.FUNCTION_PRE_GA:
          this.#fail('Functions from Redis 7.0 release candidates cannot be read');
          break;
        case OP.SLOT_INFO:
          await this.#len();
          await this.#len();
          await this.#len();
          continue;
        case OP.EXPIRETIME_MS:
          if (keyStart < 0) keyStart = start;
          expiresAt = await this.#millis();
          continue;
        case OP.EXPIRETIME: {
          if (keyStart < 0) keyStart = start;
          const b = await this.#in.bytes(4);
          expiresAt = le32(b, 0) * 1000;
          continue;
        }
        case OP.IDLE:
          if (keyStart < 0) keyStart = start;
          idle = await this.#len();
          continue;
        case OP.FREQ:
          if (keyStart < 0) keyStart = start;
          frequency = await this.#byte();
          continue;
        case OP.KEY_META: {
          if (this.version >= VALKEY_FIRST_VERSION) {
            this.#fail('Valkey slot import state cannot be read');
          }
          if (keyStart < 0) keyStart = start;
          const classes = await this.#len();
          for (let i = 0; i < classes; i++) {
            await this.#in.skip(4);
            await this.#skipModuleValue();
          }
          continue;
        }
        default:
          break;
      }

      // A key: its type, name and value.
      const info =
        this.version >= VALKEY_FIRST_VERSION && opcode >= 22 ? VALKEY_TYPES[opcode] : TYPES[opcode];
      if (info === undefined && opcode !== 6) {
        this.#fail(`Value type ${opcode} is not one Joinery reads (RDB version ${this.version})`);
      }
      const name = await this.#string(KEY_KEEP);
      const value = await this.#value(opcode);
      const record: RdbKey = {
        db: this.#db,
        key: name.bytes,
        keyLength: name.length,
        type: value.type ?? info!.type,
        encoding: opcode === 0 && value.int === true ? 'int' : info!.encoding,
        rdbType: opcode,
        bytes: this.#in.offset - (keyStart >= 0 ? keyStart : start),
        elements: value.elements,
        expiresAt,
        ...(value.fieldsWithTtl !== undefined ? { fieldsWithTtl: value.fieldsWithTtl } : {}),
        ...(value.groups !== undefined ? { groups: value.groups } : {}),
        ...(idle !== undefined ? { idle } : {}),
        ...(frequency !== undefined ? { frequency } : {}),
      };
      this.#handlers.onKey(record);
      expiresAt = null;
      idle = undefined;
      frequency = undefined;
      keyStart = -1;
      if (++this.#keys % 4096 === 0) {
        if (signal?.aborted === true) throw cancelledError('Analysis cancelled');
        this.#progress();
      }
    }
  }
}

/**
 * Reads an RDB file, calling `handlers` for its AUX fields, databases and every key, in file
 * order. Throws RdbError, with the offset, where the file is damaged or holds something this
 * reader does not know; keys before that point have been reported.
 */
export function readRdb(
  source: AsyncIterable<Uint8Array>,
  handlers: RdbHandlers,
  options: RdbReadOptions = {},
): Promise<RdbSummary> {
  return new RdbParser(source, handlers, options).run();
}
