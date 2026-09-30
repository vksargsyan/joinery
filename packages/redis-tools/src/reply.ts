import { displayBytes, toHex, tryUtf8, utf8Bytes, utf8Text, concatBytes } from './bytes';

/**
 * A Redis reply as a tree of plain objects. Every value survives structured clone, so replies
 * cross MessagePorts unchanged. Bulk strings stay bytes; integers that do not fit in 2^53 are
 * bigint. The RESP3 kinds are here for servers and tools that speak RESP3; the driver itself
 * talks RESP2.
 */
export type RedisReply =
  | { readonly type: 'status'; readonly value: string }
  | { readonly type: 'error'; readonly value: string }
  | { readonly type: 'integer'; readonly value: number | bigint }
  | { readonly type: 'bulk'; readonly value: Uint8Array }
  | { readonly type: 'nil' }
  | { readonly type: 'array'; readonly items: readonly RedisReply[] }
  | { readonly type: 'double'; readonly value: number }
  | { readonly type: 'boolean'; readonly value: boolean }
  | { readonly type: 'bignum'; readonly value: bigint }
  | { readonly type: 'verbatim'; readonly format: string; readonly value: Uint8Array }
  | {
      readonly type: 'map';
      readonly entries: readonly (readonly [RedisReply, RedisReply])[];
    }
  | { readonly type: 'set'; readonly items: readonly RedisReply[] }
  | { readonly type: 'push'; readonly items: readonly RedisReply[] };

export type RedisReplyType = RedisReply['type'];

/** How `formatReply` renders a reply. */
export type ReplyFormat = 'cli' | 'raw' | 'json';

export interface FormatOptions {
  /**
   * `cli` only: show bulk strings that are valid UTF-8 as text instead of redis-cli's `\xNN`
   * escapes for every non-ASCII byte. Off by default, which matches redis-cli exactly.
   */
  readonly utf8?: boolean;
}

// ---------------------------------------------------------------------------------------------
// Construction helpers

export const NIL: RedisReply = { type: 'nil' };

export function bulk(value: Uint8Array | string): RedisReply {
  return { type: 'bulk', value: typeof value === 'string' ? utf8Bytes(value) : value };
}

export function status(value: string): RedisReply {
  return { type: 'status', value };
}

export function integer(value: number | bigint): RedisReply {
  return { type: 'integer', value };
}

export function array(items: readonly RedisReply[]): RedisReply {
  return { type: 'array', items };
}

export function errorReply(value: string): RedisReply {
  return { type: 'error', value };
}

// ---------------------------------------------------------------------------------------------
// redis-cli formatting

/** sdscatrepr(): the quoted form redis-cli prints for bulk strings. */
export function quoteRepr(bytes: Uint8Array, utf8 = false): string {
  let out = '"';
  let text: string | undefined;
  if (utf8 && (text = tryUtf8(bytes)) !== undefined) {
    for (const ch of text) {
      const code = ch.codePointAt(0)!;
      if (code >= 0x80) out += ch;
      else out += reprByte(code);
    }
    return `${out}"`;
  }
  for (const b of bytes) out += reprByte(b);
  return `${out}"`;
}

function reprByte(b: number): string {
  switch (b) {
    case 0x5c:
      return '\\\\';
    case 0x22:
      return '\\"';
    case 0x0a:
      return '\\n';
    case 0x0d:
      return '\\r';
    case 0x09:
      return '\\t';
    case 0x07:
      return '\\a';
    case 0x08:
      return '\\b';
    default:
      return b >= 0x20 && b <= 0x7e ? String.fromCharCode(b) : `\\x${toHex(Uint8Array.of(b))}`;
  }
}

function formatDouble(value: number): string {
  if (Number.isNaN(value)) return 'nan';
  if (value === Infinity) return 'inf';
  if (value === -Infinity) return '-inf';
  return String(value);
}

/** cliFormatReplyTTY() from redis-cli: the human-readable output, one trailing newline. */
function formatCli(reply: RedisReply, prefix: string, utf8: boolean): string {
  switch (reply.type) {
    case 'error':
      return `(error) ${reply.value}\n`;
    case 'status':
      return `${reply.value}\n`;
    case 'integer':
      return `(integer) ${reply.value}\n`;
    case 'double':
      return `(double) ${formatDouble(reply.value)}\n`;
    case 'bignum':
      return `(big number) ${reply.value}\n`;
    case 'bulk':
      return `${quoteRepr(reply.value, utf8)}\n`;
    case 'verbatim':
      return `${utf8Text(reply.value)}\n`;
    case 'nil':
      return '(nil)\n';
    case 'boolean':
      return reply.value ? '(true)\n' : '(false)\n';
    case 'array':
    case 'set':
    case 'push':
    case 'map': {
      const elements: RedisReply[] =
        reply.type === 'map' ? reply.entries.flatMap(([k, v]) => [k, v]) : [...reply.items];
      if (elements.length === 0) {
        if (reply.type === 'array') return '(empty array)\n';
        if (reply.type === 'map') return '(empty hash)\n';
        if (reply.type === 'set') return '(empty set)\n';
        return '(empty push)\n';
      }
      const count = reply.type === 'map' ? elements.length / 2 : elements.length;
      const width = String(count).length;
      const childPrefix = prefix + ' '.repeat(width + 2);
      const sep = reply.type === 'set' ? '~' : reply.type === 'map' ? '#' : ')';
      let out = '';
      for (let i = 0; i < elements.length; i++) {
        const humanIndex = (reply.type === 'map' ? Math.floor(i / 2) : i) + 1;
        out += `${i === 0 ? '' : prefix}${String(humanIndex).padStart(width)}${sep} `;
        out += formatCli(elements[i]!, childPrefix, utf8);
        if (reply.type === 'map') {
          i += 1;
          out = `${out.slice(0, -1)} => `;
          out += formatCli(elements[i]!, childPrefix, utf8);
        }
      }
      return out;
    }
  }
}

// ---------------------------------------------------------------------------------------------
// RESP encoding and decoding

const CRLF = '\r\n';

/**
 * The RESP wire encoding of a reply (RESP2 types as RESP2; RESP3-only types as RESP3). `nil`
 * encodes as the RESP2 null bulk string.
 */
export function encodeResp(reply: RedisReply): Uint8Array {
  const parts: Uint8Array[] = [];
  const text = (s: string): void => {
    parts.push(utf8Bytes(s));
  };
  const walk = (r: RedisReply): void => {
    switch (r.type) {
      case 'status':
        text(`+${r.value}${CRLF}`);
        return;
      case 'error':
        text(`-${r.value}${CRLF}`);
        return;
      case 'integer':
        text(`:${r.value}${CRLF}`);
        return;
      case 'bulk':
        text(`$${r.value.length}${CRLF}`);
        parts.push(r.value);
        text(CRLF);
        return;
      case 'nil':
        text(`$-1${CRLF}`);
        return;
      case 'double':
        text(`,${formatDouble(r.value)}${CRLF}`);
        return;
      case 'boolean':
        text(`#${r.value ? 't' : 'f'}${CRLF}`);
        return;
      case 'bignum':
        text(`(${r.value}${CRLF}`);
        return;
      case 'verbatim': {
        const body = concatBytes(utf8Bytes(`${r.format.padEnd(3).slice(0, 3)}:`), r.value);
        text(`=${body.length}${CRLF}`);
        parts.push(body);
        text(CRLF);
        return;
      }
      case 'array':
      case 'set':
      case 'push':
        text(`${r.type === 'array' ? '*' : r.type === 'set' ? '~' : '>'}${r.items.length}${CRLF}`);
        r.items.forEach(walk);
        return;
      case 'map':
        text(`%${r.entries.length}${CRLF}`);
        for (const [k, v] of r.entries) {
          walk(k);
          walk(v);
        }
        return;
    }
  };
  walk(reply);
  return concatBytes(...parts);
}

export class RespError extends Error {
  constructor(
    message: string,
    readonly offset: number,
  ) {
    super(message);
    this.name = 'RespError';
  }
}

class Incomplete extends Error {}

/** Parses RESP2/RESP3 replies. Attributes (`|`) are read and dropped. */
class RespReader {
  offset = 0;

  constructor(private readonly bytes: Uint8Array) {}

  private line(): string {
    for (let i = this.offset; i + 1 < this.bytes.length; i++) {
      if (this.bytes[i] === 0x0d && this.bytes[i + 1] === 0x0a) {
        const text = utf8Text(this.bytes.subarray(this.offset, i));
        this.offset = i + 2;
        return text;
      }
    }
    throw new Incomplete();
  }

  private int(text: string, at: number): number {
    if (!/^-?\d+$/.test(text)) throw new RespError(`Expected an integer, got "${text}"`, at);
    return Number(text);
  }

  private blob(length: number): Uint8Array {
    if (this.offset + length + 2 > this.bytes.length) throw new Incomplete();
    const out = this.bytes.slice(this.offset, this.offset + length);
    this.offset += length + 2;
    return out;
  }

  read(): RedisReply {
    const at = this.offset;
    if (at >= this.bytes.length) throw new Incomplete();
    const marker = String.fromCharCode(this.bytes[at]!);
    this.offset += 1;
    const head = this.line();
    switch (marker) {
      case '+':
        return { type: 'status', value: head };
      case '-':
        return { type: 'error', value: head };
      case ':': {
        this.int(head, at);
        const big = BigInt(head);
        const safe =
          big >= BigInt(Number.MIN_SAFE_INTEGER) && big <= BigInt(Number.MAX_SAFE_INTEGER);
        return { type: 'integer', value: safe ? Number(big) : big };
      }
      case '$': {
        const length = this.int(head, at);
        if (length < 0) return NIL;
        return { type: 'bulk', value: this.blob(length) };
      }
      case '!':
        return { type: 'error', value: utf8Text(this.blob(this.int(head, at))) };
      case '=': {
        const body = this.blob(this.int(head, at));
        return { type: 'verbatim', format: utf8Text(body.subarray(0, 3)), value: body.slice(4) };
      }
      case '_':
        return NIL;
      case ',':
        return {
          type: 'double',
          value:
            head === 'inf'
              ? Infinity
              : head === '-inf'
                ? -Infinity
                : head === 'nan'
                  ? NaN
                  : Number(head),
        };
      case '#':
        return { type: 'boolean', value: head === 't' };
      case '(':
        return { type: 'bignum', value: BigInt(head) };
      case '*':
      case '~':
      case '>': {
        const count = this.int(head, at);
        if (count < 0) return NIL;
        const items: RedisReply[] = [];
        for (let i = 0; i < count; i++) items.push(this.read());
        return marker === '*'
          ? { type: 'array', items }
          : marker === '~'
            ? { type: 'set', items }
            : { type: 'push', items };
      }
      case '%': {
        const count = this.int(head, at);
        const entries: [RedisReply, RedisReply][] = [];
        for (let i = 0; i < count; i++) entries.push([this.read(), this.read()]);
        return { type: 'map', entries };
      }
      case '|': {
        const count = this.int(head, at);
        for (let i = 0; i < 2 * count; i++) this.read();
        return this.read();
      }
      default:
        throw new RespError(`Unknown RESP type marker "${marker}"`, at);
    }
  }
}

/**
 * Decodes every complete reply in `bytes`. `consumed` is where the first incomplete reply
 * starts (or the length), so a stream reader can keep the rest for the next chunk. Throws
 * RespError on malformed input.
 */
export function decodeRespStream(bytes: Uint8Array): { replies: RedisReply[]; consumed: number } {
  const reader = new RespReader(bytes);
  const replies: RedisReply[] = [];
  for (;;) {
    const start = reader.offset;
    if (start >= bytes.length) return { replies, consumed: start };
    try {
      replies.push(reader.read());
    } catch (error) {
      if (error instanceof Incomplete) return { replies, consumed: start };
      throw error;
    }
  }
}

/** Decodes exactly one reply. Throws RespError when the bytes hold anything else. */
export function decodeResp(bytes: Uint8Array): RedisReply {
  const { replies, consumed } = decodeRespStream(bytes);
  if (replies.length !== 1 || consumed !== bytes.length) {
    throw new RespError(
      `Expected exactly one complete reply, found ${replies.length} (${bytes.length - consumed} bytes left)`,
      consumed,
    );
  }
  return replies[0]!;
}

// ---------------------------------------------------------------------------------------------
// JSON form

/** A JSON-compatible value for a reply (bulk strings as display text, see `displayBytes`). */
export type ReplyJson =
  null | boolean | number | string | ReplyJson[] | { [key: string]: ReplyJson };

export function replyToJson(reply: RedisReply): ReplyJson {
  switch (reply.type) {
    case 'status':
      return reply.value;
    case 'error':
      return { error: reply.value };
    case 'integer':
      return typeof reply.value === 'bigint' ? reply.value.toString() : reply.value;
    case 'bignum':
      return reply.value.toString();
    case 'double':
      return Number.isFinite(reply.value) ? reply.value : formatDouble(reply.value);
    case 'boolean':
      return reply.value;
    case 'bulk':
    case 'verbatim':
      return displayBytes(reply.value);
    case 'nil':
      return null;
    case 'array':
    case 'set':
    case 'push':
      return reply.items.map(replyToJson);
    case 'map': {
      const keys = reply.entries.map(([k]) => replyText(k));
      if (keys.every((k): k is string => k !== undefined) && new Set(keys).size === keys.length) {
        const out: { [key: string]: ReplyJson } = {};
        reply.entries.forEach(([, v], i) => {
          out[keys[i]!] = replyToJson(v);
        });
        return out;
      }
      return reply.entries.map(([k, v]) => [replyToJson(k), replyToJson(v)]);
    }
  }
}

/**
 * Renders a reply:
 * - `cli`: exactly what redis-cli prints on a terminal (`(integer) 1`, `"text"`, `(nil)`,
 *   numbered nested arrays, `(error) ...`), without the final newline;
 * - `raw`: the RESP wire form, decoded as UTF-8 for display (invalid bytes become U+FFFD;
 *   use `encodeResp` for the exact bytes);
 * - `json`: pretty-printed JSON (see `replyToJson`).
 */
export function formatReply(
  reply: RedisReply,
  format: ReplyFormat,
  options: FormatOptions = {},
): string {
  switch (format) {
    case 'cli':
      return formatCli(reply, '', options.utf8 === true).replace(/\n$/, '');
    case 'raw':
      return utf8Text(encodeResp(reply));
    case 'json':
      return JSON.stringify(replyToJson(reply), null, 2);
  }
}

// ---------------------------------------------------------------------------------------------
// Readers for parsers

/** The text of a string-like reply (status, bulk, verbatim, integer, double); undefined otherwise. */
export function replyText(reply: RedisReply | undefined): string | undefined {
  if (!reply) return undefined;
  switch (reply.type) {
    case 'status':
    case 'error':
      return reply.value;
    case 'bulk':
    case 'verbatim':
      return utf8Text(reply.value);
    case 'integer':
    case 'bignum':
      return reply.value.toString();
    case 'double':
      return formatDouble(reply.value);
    case 'boolean':
      return reply.value ? '1' : '0';
    default:
      return undefined;
  }
}

/** The bytes of a string-like reply; undefined for nil and aggregates. */
export function replyBytes(reply: RedisReply | undefined): Uint8Array | undefined {
  if (!reply) return undefined;
  if (reply.type === 'bulk' || reply.type === 'verbatim') return reply.value;
  const text = replyText(reply);
  return text === undefined ? undefined : utf8Bytes(text);
}

/** A number from an integer, double or numeric string reply; undefined otherwise. */
export function replyNumber(reply: RedisReply | undefined): number | undefined {
  if (!reply) return undefined;
  if (reply.type === 'integer' || reply.type === 'bignum') return Number(reply.value);
  if (reply.type === 'double') return reply.value;
  const text = replyText(reply);
  if (text === undefined || text.trim() === '') return undefined;
  const value = Number(text);
  return Number.isNaN(value) && text !== 'nan' ? undefined : value;
}

/** The elements of an array, set or push reply; `[]` for nil; undefined for anything else. */
export function replyItems(reply: RedisReply | undefined): readonly RedisReply[] | undefined {
  if (!reply) return undefined;
  if (reply.type === 'array' || reply.type === 'set' || reply.type === 'push') return reply.items;
  if (reply.type === 'nil') return [];
  if (reply.type === 'map') return reply.entries.flatMap(([k, v]) => [k, v]);
  return undefined;
}

/** Key/value pairs from a RESP3 map or a RESP2 flat array of alternating keys and values. */
export function replyPairs(
  reply: RedisReply | undefined,
): readonly (readonly [RedisReply, RedisReply])[] | undefined {
  if (!reply) return undefined;
  if (reply.type === 'map') return reply.entries;
  const items = replyItems(reply);
  if (!items) return undefined;
  const pairs: [RedisReply, RedisReply][] = [];
  for (let i = 0; i + 1 < items.length; i += 2) pairs.push([items[i]!, items[i + 1]!]);
  return pairs;
}

/** A map or flat key/value array as a record keyed by the key text (later keys win). */
export function replyRecord(reply: RedisReply | undefined): Record<string, RedisReply> {
  const out: Record<string, RedisReply> = {};
  for (const [k, v] of replyPairs(reply) ?? []) {
    const key = replyText(k);
    if (key !== undefined) out[key] = v;
  }
  return out;
}
