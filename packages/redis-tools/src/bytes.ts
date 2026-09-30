/**
 * Byte strings. Redis keys and values are arbitrary bytes, so they cross process boundaries as
 * Uint8Array (structured-clone safe) and are only turned into text for display. Text the user
 * types is UTF-8.
 */

/** Bytes, or text that stands for its UTF-8 encoding. */
export type RedisBytes = Uint8Array | string;

const encoder = new TextEncoder();
const strictDecoder = new TextDecoder('utf-8', { fatal: true });
const lenientDecoder = new TextDecoder('utf-8');

/** UTF-8 encoding of `text` (lone surrogates become U+FFFD). */
export function utf8Bytes(text: string): Uint8Array {
  return encoder.encode(text);
}

/** `value` as bytes: strings are UTF-8 encoded, byte arrays are returned as they are. */
export function toBytes(value: RedisBytes): Uint8Array {
  return typeof value === 'string' ? encoder.encode(value) : value;
}

/** Decodes UTF-8, replacing invalid sequences with U+FFFD. For display only: it can lose bytes. */
export function utf8Text(bytes: Uint8Array): string {
  return lenientDecoder.decode(bytes);
}

/** Decodes UTF-8, or returns undefined when the bytes are not valid UTF-8. */
export function tryUtf8(bytes: Uint8Array): string | undefined {
  try {
    return strictDecoder.decode(bytes);
  } catch {
    return undefined;
  }
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Byte-wise comparison, as Redis orders strings (memcmp, then length). */
export function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const d = a[i]! - b[i]!;
    if (d !== 0) return d;
  }
  return a.length - b.length;
}

export function concatBytes(...parts: readonly Uint8Array[]): Uint8Array {
  let length = 0;
  for (const part of parts) length += part.length;
  const out = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export function startsWithBytes(bytes: Uint8Array, prefix: Uint8Array): boolean {
  if (prefix.length > bytes.length) return false;
  for (let i = 0; i < prefix.length; i++) if (bytes[i] !== prefix[i]) return false;
  return true;
}

/** Index of `needle` in `haystack` at or after `from`, or -1. An empty needle matches at `from`. */
export function indexOfBytes(haystack: Uint8Array, needle: Uint8Array, from = 0): number {
  if (needle.length === 0) return from <= haystack.length ? from : -1;
  const first = needle[0]!;
  const last = haystack.length - needle.length;
  outer: for (let i = from; i <= last; i++) {
    if (haystack[i] !== first) continue;
    for (let j = 1; j < needle.length; j++) if (haystack[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

/**
 * A binary-safe string form of bytes (one UTF-16 unit per byte), usable as a Map key. Not for
 * display.
 */
export function bytesKey(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 4096) {
    out += String.fromCharCode(...bytes.subarray(i, i + 4096));
  }
  return out;
}

const HEX = '0123456789abcdef';

function hexByte(byte: number): string {
  return `\\x${HEX[byte >> 4]}${HEX[byte & 15]}`;
}

/** Length of the valid UTF-8 sequence starting at `i`, or 0 when the byte there starts none. */
function utf8SequenceLength(bytes: Uint8Array, i: number): number {
  const b0 = bytes[i]!;
  const cont = (k: number): boolean => {
    const b = bytes[i + k];
    return b !== undefined && (b & 0xc0) === 0x80;
  };
  if (b0 >= 0xc2 && b0 <= 0xdf) return cont(1) ? 2 : 0;
  if (b0 >= 0xe0 && b0 <= 0xef) {
    const b1 = bytes[i + 1];
    if (b1 === undefined) return 0;
    if (b0 === 0xe0 && b1 < 0xa0) return 0; // overlong
    if (b0 === 0xed && b1 >= 0xa0) return 0; // surrogates
    return cont(1) && cont(2) ? 3 : 0;
  }
  if (b0 >= 0xf0 && b0 <= 0xf4) {
    const b1 = bytes[i + 1];
    if (b1 === undefined) return 0;
    if (b0 === 0xf0 && b1 < 0x90) return 0; // overlong
    if (b0 === 0xf4 && b1 >= 0x90) return 0; // above U+10FFFF
    return cont(1) && cont(2) && cont(3) ? 4 : 0;
  }
  return 0;
}

/**
 * Text for showing any key or value: valid UTF-8 is shown as text, anything else byte by byte
 * as redis-cli-style `\xNN` escapes. Backslashes and control characters are escaped too (`\\`,
 * `\n`, `\r`, `\t`, `\xNN`), so the form is unambiguous and `parseDisplayBytes` reverses it
 * exactly. Plain text without backslashes or control characters is shown unchanged.
 */
export function displayBytes(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  while (i < bytes.length) {
    const b = bytes[i]!;
    if (b < 0x80) {
      if (b === 0x5c) out += '\\\\';
      else if (b === 0x0a) out += '\\n';
      else if (b === 0x0d) out += '\\r';
      else if (b === 0x09) out += '\\t';
      else if (b < 0x20 || b === 0x7f) out += hexByte(b);
      else out += String.fromCharCode(b);
      i += 1;
      continue;
    }
    const length = utf8SequenceLength(bytes, i);
    // C1 controls (U+0080..U+009F, encoded C2 80..C2 9F) are invisible: escape them.
    if (length === 0 || (length === 2 && b === 0xc2 && bytes[i + 1]! < 0xa0)) {
      out += hexByte(b);
      i += 1;
      continue;
    }
    out += strictDecoder.decode(bytes.subarray(i, i + length));
    i += length;
  }
  return out;
}

function hexValue(code: number | undefined): number {
  if (code === undefined) return -1;
  if (code >= 48 && code <= 57) return code - 48;
  if (code >= 97 && code <= 102) return code - 87;
  if (code >= 65 && code <= 70) return code - 55;
  return -1;
}

const SIMPLE_ESCAPES: Readonly<Record<string, number>> = {
  n: 0x0a,
  r: 0x0d,
  t: 0x09,
  a: 0x07,
  b: 0x08,
  '0': 0x00,
};

/**
 * Bytes from text typed or shown in the display form of `displayBytes`: `\xNN` is a byte,
 * `\\` a backslash, `\n` `\r` `\t` `\a` `\b` `\0` control characters, and a backslash before
 * any other character stands for that character. Everything else is UTF-8, so plain text
 * becomes its UTF-8 bytes.
 */
export function parseDisplayBytes(text: string): Uint8Array {
  const out: number[] = [];
  let run = '';
  const flush = (): void => {
    if (run) {
      for (const byte of encoder.encode(run)) out.push(byte);
      run = '';
    }
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch !== '\\' || i + 1 >= text.length) {
      run += ch;
      continue;
    }
    const next = text[i + 1]!;
    if (next === 'x') {
      const hi = hexValue(text.charCodeAt(i + 2));
      const lo = hexValue(text.charCodeAt(i + 3));
      if (hi >= 0 && lo >= 0) {
        flush();
        out.push(hi * 16 + lo);
        i += 3;
        continue;
      }
    }
    const simple = SIMPLE_ESCAPES[next];
    if (simple !== undefined) {
      flush();
      out.push(simple);
      i += 1;
      continue;
    }
    run += next;
    i += 1;
  }
  flush();
  return Uint8Array.from(out);
}

const GLOB_SPECIAL = new Set([0x2a, 0x3f, 0x5b, 0x5d, 0x5c]); // * ? [ ] \

/** Escapes glob metacharacters so the bytes match literally in SCAN MATCH / KEYS patterns. */
export function escapeGlob(bytes: Uint8Array): Uint8Array {
  let special = 0;
  for (const b of bytes) if (GLOB_SPECIAL.has(b)) special += 1;
  if (special === 0) return bytes;
  const out = new Uint8Array(bytes.length + special);
  let j = 0;
  for (const b of bytes) {
    if (GLOB_SPECIAL.has(b)) out[j++] = 0x5c;
    out[j++] = b;
  }
  return out;
}

/** Lower-case hex of the bytes, e.g. "0aff". */
export function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += HEX[b >> 4]! + HEX[b & 15]!;
  return out;
}

/** Bytes from hex text; whitespace is ignored. Throws on odd length or a non-hex character. */
export function fromHex(text: string): Uint8Array {
  const clean = text.replace(/\s+/g, '');
  if (clean.length % 2 !== 0) throw new Error('Hex text must have an even number of digits');
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    const hi = hexValue(clean.charCodeAt(2 * i));
    const lo = hexValue(clean.charCodeAt(2 * i + 1));
    if (hi < 0 || lo < 0) throw new Error(`"${clean.slice(2 * i, 2 * i + 2)}" is not a hex byte`);
    out[i] = hi * 16 + lo;
  }
  return out;
}
