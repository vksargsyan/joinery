import type { NewKeyValue } from '@querybara/driver-redis';
import {
  bytesEqual,
  detectJson,
  detectValueFormat,
  displayBytes,
  fromHex,
  hexDump,
  jsonTextToMessagePack,
  messagePackToJsonText,
  parseDisplayBytes,
  toBytes,
  toHex,
  tryUtf8,
  utf8Bytes,
  type RedisBytes,
} from '@querybara/redis-tools';

/**
 * The value editors' edit models (spec §10): how each type's value is shown and how an edit
 * turns into the Redis operations that make it, validated before anything is sent. Everything
 * is bytes: text typed in a cell is the display form (`parseDisplayBytes`), so any byte string
 * can be entered and round-trips.
 */

// ---------------------------------------------------------------------------------------------
// Strings

export type StringView = 'text' | 'json' | 'hex' | 'msgpack';

export const STRING_VIEWS: readonly { readonly view: StringView; readonly label: string }[] = [
  { view: 'text', label: 'Text' },
  { view: 'json', label: 'JSON' },
  { view: 'hex', label: 'Hex' },
  { view: 'msgpack', label: 'MessagePack' },
];

/** The view a value opens in: JSON for JSON, MessagePack for MessagePack, hex for binary. */
export function defaultStringView(bytes: Uint8Array): StringView {
  switch (detectValueFormat(bytes)) {
    case 'json':
      return 'json';
    case 'messagepack':
      return 'msgpack';
    case 'binary':
    case 'hyperloglog':
      return 'hex';
    default:
      return 'text';
  }
}

export interface DecodedValue {
  /** The editor text for the view. */
  readonly text: string;
  /** Why the value cannot be shown in this view (not JSON, not MessagePack...). */
  readonly error?: string;
}

/**
 * The value as editor text in a view: text is the display form (binary-safe escapes), JSON is
 * pretty-printed, hex is two digits per byte, MessagePack is shown as JSON.
 */
export function decodeString(bytes: Uint8Array, view: StringView): DecodedValue {
  switch (view) {
    case 'text':
      return { text: displayBytes(bytes) };
    case 'json': {
      const json = detectJson(bytes);
      if (json) return { text: json.pretty };
      const text = tryUtf8(bytes);
      if (text !== undefined) {
        try {
          return { text: JSON.stringify(JSON.parse(text), null, 2) };
        } catch {
          // Falls through to the error below.
        }
      }
      return { text: displayBytes(bytes), error: 'The value is not JSON' };
    }
    case 'hex':
      return { text: toHex(bytes).replace(/(.{2})(?=.)/g, '$1 ') };
    case 'msgpack':
      try {
        return { text: messagePackToJsonText(bytes) };
      } catch {
        return { text: displayBytes(bytes), error: 'The value is not MessagePack' };
      }
  }
}

/**
 * The bytes the editor text stands for in a view. JSON is stored compact when the original was
 * compact (one line), pretty otherwise; MessagePack is re-encoded from the JSON. Throws with a
 * message fit for the editor when the text is invalid for the view.
 */
export function encodeString(text: string, view: StringView, original?: Uint8Array): Uint8Array {
  switch (view) {
    case 'text':
      return parseDisplayBytes(text);
    case 'json': {
      let value: unknown;
      try {
        value = JSON.parse(text);
      } catch (error) {
        throw new Error(`Invalid JSON: ${error instanceof Error ? error.message : String(error)}`, {
          cause: error,
        });
      }
      const compact = original !== undefined && !(tryUtf8(original) ?? '').includes('\n');
      return utf8Bytes(compact ? JSON.stringify(value) : JSON.stringify(value, null, 2));
    }
    case 'hex':
      return fromHex(text);
    case 'msgpack':
      try {
        return jsonTextToMessagePack(text);
      } catch (error) {
        throw new Error(`Invalid JSON: ${error instanceof Error ? error.message : String(error)}`, {
          cause: error,
        });
      }
  }
}

/** A read-only hex dump of a byte range (for large values read in pieces). */
export function hexPreview(bytes: Uint8Array, offset: number): string {
  return hexDump(bytes, { offset });
}

// ---------------------------------------------------------------------------------------------
// Collections

/** What an edit of a hash, set, sorted set or list does, as Redis operations. */
export type ValueEdit =
  | { readonly op: 'hset'; readonly entries: readonly (readonly [Uint8Array, Uint8Array])[] }
  | { readonly op: 'hdel'; readonly fields: readonly Uint8Array[] }
  | { readonly op: 'sadd'; readonly members: readonly Uint8Array[] }
  | { readonly op: 'srem'; readonly members: readonly Uint8Array[] }
  | {
      readonly op: 'zadd';
      readonly entries: readonly (readonly [Uint8Array, string])[];
      readonly condition?: 'nx' | 'xx';
    }
  | { readonly op: 'zrem'; readonly members: readonly Uint8Array[] }
  | { readonly op: 'lset'; readonly index: number; readonly value: Uint8Array }
  | { readonly op: 'lrem-at'; readonly index: number; readonly expected: Uint8Array }
  | {
      readonly op: 'push';
      readonly side: 'left' | 'right';
      readonly values: readonly Uint8Array[];
    };

/** An edit that cannot be made, with what to tell the user. */
export class EditError extends Error {
  override readonly name = 'EditError';
}

/**
 * Edits a hash field: a new value is one HSET; a renamed field is HSET of the new field then
 * HDEL of the old one (refused when the new name is taken, which would overwrite it).
 */
export function editHashField(
  field: Uint8Array,
  value: Uint8Array,
  next: { readonly field: string; readonly value: string },
  existing: (field: Uint8Array) => boolean,
): ValueEdit[] {
  const newField = parseDisplayBytes(next.field);
  const newValue = parseDisplayBytes(next.value);
  if (bytesEqual(newField, field)) {
    return bytesEqual(newValue, value) ? [] : [{ op: 'hset', entries: [[field, newValue]] }];
  }
  if (existing(newField)) throw new EditError(`The field "${next.field}" already exists`);
  return [
    { op: 'hset', entries: [[newField, newValue]] },
    { op: 'hdel', fields: [field] },
  ];
}

/** Adds a hash field (HSET); refused when it exists (use the row's edit to change it). */
export function addHashField(
  next: { readonly field: string; readonly value: string },
  existing: (field: Uint8Array) => boolean,
): ValueEdit[] {
  const field = parseDisplayBytes(next.field);
  if (existing(field)) throw new EditError(`The field "${next.field}" already exists`);
  return [{ op: 'hset', entries: [[field, parseDisplayBytes(next.value)]] }];
}

/** Replaces a set member: SADD of the new one, then SREM of the old one. */
export function editSetMember(
  member: Uint8Array,
  next: string,
  existing: (member: Uint8Array) => boolean,
): ValueEdit[] {
  const value = parseDisplayBytes(next);
  if (bytesEqual(value, member)) return [];
  if (existing(value)) throw new EditError(`"${next}" is already a member`);
  return [
    { op: 'sadd', members: [value] },
    { op: 'srem', members: [member] },
  ];
}

const SCORE_RE = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i;

/**
 * A sorted-set score as ZADD takes it: a decimal or exponent number, or +inf / -inf. Throws for
 * anything else (NaN is not a score).
 */
export function parseScore(text: string): string {
  const score = text.trim();
  if (/^[+-]?inf(inity)?$/i.test(score)) return score.startsWith('-') ? '-inf' : '+inf';
  if (!SCORE_RE.test(score)) throw new EditError(`"${text}" is not a score`);
  return score;
}

/**
 * Edits a sorted-set entry: a new score is ZADD XX (the member must still exist); a renamed
 * member is ZADD NX of the new member with the score, then ZREM of the old one.
 */
export function editZSetEntry(
  member: Uint8Array,
  scoreText: string,
  next: { readonly member: string; readonly score: string },
  existing: (member: Uint8Array) => boolean,
): ValueEdit[] {
  const newMember = parseDisplayBytes(next.member);
  const score = parseScore(next.score);
  if (bytesEqual(newMember, member)) {
    if (sameScore(score, scoreText)) return [];
    return [{ op: 'zadd', entries: [[member, score]], condition: 'xx' }];
  }
  if (existing(newMember)) throw new EditError(`"${next.member}" is already a member`);
  return [
    { op: 'zadd', entries: [[newMember, score]], condition: 'nx' },
    { op: 'zrem', members: [member] },
  ];
}

function sameScore(a: string, b: string): boolean {
  const x = Number(a.replace(/^\+?inf$/i, 'Infinity').replace(/^-inf$/i, '-Infinity'));
  const y = Number(b.replace(/^\+?inf$/i, 'Infinity').replace(/^-inf$/i, '-Infinity'));
  return x === y;
}

/** Adds a sorted-set member (ZADD NX): refused when it is already a member. */
export function addZSetEntry(
  next: { readonly member: string; readonly score: string },
  existing: (member: Uint8Array) => boolean,
): ValueEdit[] {
  const member = parseDisplayBytes(next.member);
  if (existing(member)) throw new EditError(`"${next.member}" is already a member`);
  return [{ op: 'zadd', entries: [[member, parseScore(next.score)]], condition: 'nx' }];
}

/** Sets a list element (LSET); nothing when unchanged. */
export function editListItem(index: number, value: Uint8Array, next: string): ValueEdit[] {
  const bytes = parseDisplayBytes(next);
  return bytesEqual(bytes, value) ? [] : [{ op: 'lset', index, value: bytes }];
}

/**
 * The Redis commands an edit sends, for confirmations: `HSET key field value`. Removing a list
 * element by index is a script that checks the element, then LSET to a marker and LREM of it.
 */
export function editCommands(key: Uint8Array, edit: ValueEdit): Uint8Array[][] {
  const word = (text: string): Uint8Array => utf8Bytes(text);
  switch (edit.op) {
    case 'hset':
      return [[word('HSET'), key, ...edit.entries.flat()]];
    case 'hdel':
      return [[word('HDEL'), key, ...edit.fields]];
    case 'sadd':
      return [[word('SADD'), key, ...edit.members]];
    case 'srem':
      return [[word('SREM'), key, ...edit.members]];
    case 'zadd':
      return [
        [
          word('ZADD'),
          key,
          ...(edit.condition ? [word(edit.condition.toUpperCase())] : []),
          ...edit.entries.flatMap(([member, score]) => [word(score), member]),
        ],
      ];
    case 'zrem':
      return [[word('ZREM'), key, ...edit.members]];
    case 'lset':
      return [[word('LSET'), key, word(String(edit.index)), edit.value]];
    case 'lrem-at':
      return [
        [word('LSET'), key, word(String(edit.index)), word('<marker>')],
        [word('LREM'), key, word('1'), word('<marker>')],
      ];
    case 'push':
      return [[word(edit.side === 'left' ? 'LPUSH' : 'RPUSH'), key, ...edit.values]];
  }
}

// ---------------------------------------------------------------------------------------------
// Streams

const STREAM_ID_RE = /^(?:\d+(?:-(?:\d+|\*))?|\*)$/;

/** Validates an XADD id ("*", "<ms>", "<ms>-<seq>" or "<ms>-*"). */
export function parseStreamId(text: string): string {
  const id = text.trim() === '' ? '*' : text.trim();
  if (!STREAM_ID_RE.test(id)) throw new EditError(`"${text}" is not a stream entry id`);
  return id;
}

/** A range bound for XRANGE: "-", "+", an id, or "(" + id for an exclusive bound. */
export function parseStreamBound(text: string, fallback: '-' | '+'): string {
  const bound = text.trim();
  if (bound === '') return fallback;
  if (bound === '-' || bound === '+') return bound;
  const id = bound.startsWith('(') ? bound.slice(1) : bound;
  if (!/^\d+(?:-\d+)?$/.test(id)) throw new EditError(`"${text}" is not a stream id or bound`);
  return bound;
}

/** The fields of a new stream entry, from editor rows; empty rows are skipped. */
export function streamFields(
  rows: readonly { readonly field: string; readonly value: string }[],
): [Uint8Array, Uint8Array][] {
  const fields = rows
    .filter((row) => row.field !== '' || row.value !== '')
    .map((row): [Uint8Array, Uint8Array] => [
      parseDisplayBytes(row.field),
      parseDisplayBytes(row.value),
    ]);
  if (fields.length === 0) throw new EditError('A stream entry needs at least one field');
  return fields;
}

/** The time a stream id's milliseconds part stands for, e.g. "2026-09-29 10:00:00.123". */
export function streamIdTime(id: string): string | undefined {
  const ms = Number(id.split('-')[0]);
  if (!Number.isFinite(ms) || ms <= 0) return undefined;
  return new Date(ms).toISOString().replace('T', ' ').replace('Z', '');
}

// ---------------------------------------------------------------------------------------------
// TTL

export type TtlUnit = 'ms' | 's' | 'min' | 'h' | 'd';

const UNIT_MS: Readonly<Record<TtlUnit, number>> = {
  ms: 1,
  s: 1000,
  min: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

/** A TTL typed in a unit, in milliseconds; throws unless it is a positive whole amount of ms. */
export function parseTtl(text: string, unit: TtlUnit): number {
  const value = Number(text.trim());
  const ms = Math.round(value * UNIT_MS[unit]);
  if (text.trim() === '' || !Number.isFinite(value) || ms < 1) {
    throw new EditError('Enter a positive time to live');
  }
  return ms;
}

/** "no expiry", "12 s", "3 min 20 s", "2 d 4 h" for a PTTL in milliseconds. */
export function formatTtl(ttlMs: number): string {
  if (ttlMs === -1) return 'no expiry';
  if (ttlMs === -2) return 'gone';
  if (ttlMs < 1000) return `${ttlMs} ms`;
  const seconds = Math.floor(ttlMs / 1000);
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min${seconds % 60 ? ` ${seconds % 60} s` : ''}`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h${minutes % 60 ? ` ${minutes % 60} min` : ''}`;
  const days = Math.floor(hours / 24);
  return `${days} d${hours % 24 ? ` ${hours % 24} h` : ''}`;
}

const byteFormat = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 });

/** "512 B", "1.5 KB", "3.2 MB". */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${byteFormat.format(value)} ${units[unit]}`;
}

/** A type's short badge text and its colour class. */
export function typeBadge(type: string): { readonly label: string; readonly tone: string } {
  switch (type) {
    case 'string':
      return { label: 'STR', tone: 'bg-accent/15 text-accent' };
    case 'hash':
      return { label: 'HASH', tone: 'bg-success/15 text-success' };
    case 'list':
      return { label: 'LIST', tone: 'bg-warning/15 text-warning' };
    case 'set':
      return { label: 'SET', tone: 'bg-env-staging/15 text-env-staging' };
    case 'zset':
      return { label: 'ZSET', tone: 'bg-danger/15 text-danger' };
    case 'stream':
      return { label: 'STREAM', tone: 'bg-env-test/15 text-env-test' };
    case 'ReJSON-RL':
    case 'json':
      return { label: 'JSON', tone: 'bg-env-dev/15 text-env-dev' };
    case '':
      return { label: '?', tone: 'bg-panel-2 text-muted' };
    default:
      return { label: type.slice(0, 8).toUpperCase(), tone: 'bg-panel-2 text-muted' };
  }
}

/** The commands creating a key sends (for its confirmation), as the driver's createKey does. */
export function createCommands(
  key: Uint8Array,
  value: NewKeyValue,
  ttlMs?: number,
): Uint8Array[][] {
  const word = (text: string): Uint8Array => utf8Bytes(text);
  const bytes = (v: RedisBytes): Uint8Array => toBytes(v);
  let command: Uint8Array[];
  switch (value.type) {
    case 'string':
      command = [word('SET'), key, bytes(value.value), word('NX')];
      break;
    case 'hash':
      command = [word('HSET'), key, ...value.entries.flatMap(([f, v]) => [bytes(f), bytes(v)])];
      break;
    case 'list':
      command = [word('RPUSH'), key, ...value.items.map(bytes)];
      break;
    case 'set':
      command = [word('SADD'), key, ...value.members.map(bytes)];
      break;
    case 'zset':
      command = [
        word('ZADD'),
        key,
        ...value.entries.flatMap(([m, s]) => [word(String(s)), bytes(m)]),
      ];
      break;
    case 'stream':
      command = [
        word('XADD'),
        key,
        word(value.id ?? '*'),
        ...value.fields.flatMap(([f, v]) => [bytes(f), bytes(v)]),
      ];
      break;
    case 'json':
      command = [word('JSON.SET'), key, word('$'), word(value.json), word('NX')];
      break;
  }
  return ttlMs === undefined ? [command] : [command, [word('PEXPIRE'), key, word(String(ttlMs))]];
}
