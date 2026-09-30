import { encodeMessagePack, utf8Bytes, utf8Text } from '@joinery/redis-tools';
import { describe, expect, it } from 'vitest';

import { formatCommandLine } from '../src/shared/redis-safety';
import {
  EditError,
  addHashField,
  addZSetEntry,
  createCommands,
  decodeString,
  defaultStringView,
  editCommands,
  editHashField,
  editListItem,
  editSetMember,
  editZSetEntry,
  encodeString,
  formatBytes,
  formatTtl,
  parseScore,
  parseStreamBound,
  parseStreamId,
  parseTtl,
  streamFields,
  typeBadge,
} from '../src/renderer/src/state/redis/value-model';

const enc = utf8Bytes;
const never = (): boolean => false;
const lines = (commands: Uint8Array[][]): string[] => commands.map((c) => formatCommandLine(c));

describe('string views', () => {
  it('opens JSON, MessagePack, binary and text in their own view', () => {
    expect(defaultStringView(enc('{"a":1}'))).toBe('json');
    expect(defaultStringView(encodeMessagePack({ a: 1 }))).toBe('msgpack');
    expect(defaultStringView(new Uint8Array([0, 1, 2, 0xff]))).toBe('hex');
    expect(defaultStringView(enc('hello'))).toBe('text');
  });

  it('round-trips any bytes through the text view', () => {
    const bytes = new Uint8Array([0x61, 0x0a, 0xff, 0x5c, 0x00, 0xe2, 0x82, 0xac]);
    const { text } = decodeString(bytes, 'text');
    expect(text).toBe('a\\n\\xff\\\\\\x00€');
    expect([...encodeString(text, 'text')]).toEqual([...bytes]);
  });

  it('pretty-prints JSON and keeps a compact value compact when saved', () => {
    const compact = enc('{"a":[1,2]}');
    const { text } = decodeString(compact, 'json');
    expect(text).toBe('{\n  "a": [\n    1,\n    2\n  ]\n}');
    expect(utf8Text(encodeString(text.replace('2', '3'), 'json', compact))).toBe('{"a":[1,3]}');
    const pretty = enc('{\n  "a": 1\n}');
    expect(utf8Text(encodeString('{"a": 2}', 'json', pretty))).toBe('{\n  "a": 2\n}');
    expect(() => encodeString('{nope', 'json')).toThrow(/Invalid JSON/);
    expect(decodeString(enc('plain'), 'json').error).toBe('The value is not JSON');
  });

  it('shows and parses hex, and MessagePack as JSON', () => {
    expect(decodeString(new Uint8Array([0, 0xab, 0x10]), 'hex').text).toBe('00 ab 10');
    expect([...encodeString('00ab 10', 'hex')]).toEqual([0, 0xab, 0x10]);
    expect(() => encodeString('abc', 'hex')).toThrow();
    const packed = encodeMessagePack({ name: 'x', n: 2 });
    const { text } = decodeString(packed, 'msgpack');
    expect(JSON.parse(text)).toEqual({ name: 'x', n: 2 });
    expect([...encodeString(text, 'msgpack')]).toEqual([...packed]);
    expect(decodeString(enc('text'), 'msgpack').error).toBeDefined();
  });
});

describe('collection edits', () => {
  it('turns a hash value change into HSET and a rename into HSET + HDEL', () => {
    const field = enc('name');
    const value = enc('Ada');
    expect(editHashField(field, value, { field: 'name', value: 'Ada' }, never)).toEqual([]);
    const changed = editHashField(field, value, { field: 'name', value: 'Grace' }, never);
    expect(lines(changed.flatMap((e) => editCommands(enc('user:1'), e)))).toEqual([
      'HSET user:1 name Grace',
    ]);
    const renamed = editHashField(field, value, { field: 'full name', value: 'Ada' }, never);
    expect(lines(renamed.flatMap((e) => editCommands(enc('user:1'), e)))).toEqual([
      'HSET user:1 "full name" Ada',
      'HDEL user:1 name',
    ]);
    expect(() => editHashField(field, value, { field: 'taken', value: 'x' }, () => true)).toThrow(
      EditError,
    );
    expect(() => addHashField({ field: 'name', value: 'x' }, () => true)).toThrow(/exists/);
    expect(addHashField({ field: '\\x00k', value: 'v' }, never)).toEqual([
      { op: 'hset', entries: [[new Uint8Array([0, 0x6b]), enc('v')]] },
    ]);
  });

  it('replaces a set member with SADD then SREM', () => {
    const edits = editSetMember(enc('a'), 'b', never);
    expect(edits).toEqual([
      { op: 'sadd', members: [enc('b')] },
      { op: 'srem', members: [enc('a')] },
    ]);
    expect(editSetMember(enc('a'), 'a', never)).toEqual([]);
    expect(() => editSetMember(enc('a'), 'b', () => true)).toThrow(/already a member/);
  });

  it('parses scores as ZADD takes them', () => {
    expect(parseScore(' 1.5 ')).toBe('1.5');
    expect(parseScore('-2e3')).toBe('-2e3');
    expect(parseScore('inf')).toBe('+inf');
    expect(parseScore('-Infinity')).toBe('-inf');
    expect(() => parseScore('NaN')).toThrow(EditError);
    expect(() => parseScore('12abc')).toThrow(/not a score/);
  });

  it('edits a score with ZADD XX and renames a member with ZADD NX + ZREM', () => {
    const member = enc('alice');
    expect(editZSetEntry(member, '10', { member: 'alice', score: '10.0' }, never)).toEqual([]);
    const score = editZSetEntry(member, '10', { member: 'alice', score: '42' }, never);
    expect(lines(score.flatMap((e) => editCommands(enc('board'), e)))).toEqual([
      'ZADD board XX 42 alice',
    ]);
    const renamed = editZSetEntry(member, '10', { member: 'bob', score: '10' }, never);
    expect(lines(renamed.flatMap((e) => editCommands(enc('board'), e)))).toEqual([
      'ZADD board NX 10 bob',
      'ZREM board alice',
    ]);
    expect(() => editZSetEntry(member, '1', { member: 'x', score: '1' }, () => true)).toThrow();
    expect(addZSetEntry({ member: 'c', score: '-inf' }, never)).toEqual([
      { op: 'zadd', entries: [[enc('c'), '-inf']], condition: 'nx' },
    ]);
  });

  it('sets list elements by index and describes removal by index', () => {
    expect(editListItem(3, enc('x'), 'x')).toEqual([]);
    expect(editListItem(3, enc('x'), 'y')).toEqual([{ op: 'lset', index: 3, value: enc('y') }]);
    const removal = editCommands(enc('queue'), { op: 'lrem-at', index: 2, expected: enc('job') });
    expect(lines(removal)).toEqual(['LSET queue 2 <marker>', 'LREM queue 1 <marker>']);
    expect(
      lines(editCommands(enc('q'), { op: 'push', side: 'left', values: [enc('a b')] })),
    ).toEqual(['LPUSH q "a b"']);
  });
});

describe('streams', () => {
  it('validates XADD ids and range bounds', () => {
    expect(parseStreamId('')).toBe('*');
    expect(parseStreamId('1700000000000-1')).toBe('1700000000000-1');
    expect(parseStreamId('5-*')).toBe('5-*');
    expect(() => parseStreamId('abc')).toThrow(EditError);
    expect(parseStreamBound('', '-')).toBe('-');
    expect(parseStreamBound('(1-2', '+')).toBe('(1-2');
    expect(() => parseStreamBound('yesterday', '-')).toThrow();
  });

  it('collects entry fields and skips empty rows', () => {
    expect(
      streamFields([
        { field: 'a', value: '1' },
        { field: '', value: '' },
      ]),
    ).toEqual([[enc('a'), enc('1')]]);
    expect(() => streamFields([{ field: '', value: '' }])).toThrow(/at least one field/);
  });
});

describe('TTL, sizes and badges', () => {
  it('parses a TTL in a unit into milliseconds', () => {
    expect(parseTtl('90', 's')).toBe(90_000);
    expect(parseTtl('1.5', 'min')).toBe(90_000);
    expect(parseTtl('2', 'd')).toBe(172_800_000);
    expect(() => parseTtl('0', 's')).toThrow(EditError);
    expect(() => parseTtl('soon', 'h')).toThrow();
  });

  it('formats TTLs and sizes for the grids', () => {
    expect(formatTtl(-1)).toBe('no expiry');
    expect(formatTtl(-2)).toBe('gone');
    expect(formatTtl(450)).toBe('450 ms');
    expect(formatTtl(61_000)).toBe('1 min 1 s');
    expect(formatTtl(90_000_000)).toBe('1 d 1 h');
    expect(formatBytes(null)).toBe('—');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5 MB');
    expect(typeBadge('zset').label).toBe('ZSET');
    expect(typeBadge('ReJSON-RL').label).toBe('JSON');
  });

  it('describes the commands that create a key', () => {
    expect(lines(createCommands(enc('k'), { type: 'string', value: 'v' }))).toEqual(['SET k v NX']);
    expect(
      lines(createCommands(enc('z'), { type: 'zset', entries: [['m', '1.5']] }, 60_000)),
    ).toEqual(['ZADD z 1.5 m', 'PEXPIRE z 60000']);
    expect(lines(createCommands(enc('s'), { type: 'stream', fields: [['f', 'v']] }))).toEqual([
      'XADD s * f v',
    ]);
  });
});
