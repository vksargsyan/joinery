import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  NIL,
  array,
  bulk,
  decodeResp,
  decodeRespStream,
  encodeResp,
  errorReply,
  formatReply,
  integer,
  replyPairs,
  replyText,
  replyToJson,
  status,
  type RedisReply,
} from '../src';
import { enc } from './fixtures';

const cli = (reply: RedisReply): string => formatReply(reply, 'cli');

describe("formatReply('cli') matches redis-cli 7.0 output", () => {
  it('formats scalars', () => {
    expect(cli(status('OK'))).toBe('OK');
    expect(cli(bulk('hello world'))).toBe('"hello world"');
    expect(cli(NIL)).toBe('(nil)');
    expect(cli(integer(1))).toBe('(integer) 1');
    expect(cli(integer(-9223372036854775808n))).toBe('(integer) -9223372036854775808');
    expect(
      cli(errorReply('WRONGTYPE Operation against a key holding the wrong kind of value')),
    ).toBe('(error) WRONGTYPE Operation against a key holding the wrong kind of value');
    expect(cli(bulk('héllo ✓'))).toBe('"h\\xc3\\xa9llo \\xe2\\x9c\\x93"');
    expect(formatReply(bulk('héllo ✓'), 'cli', { utf8: true })).toBe('"héllo ✓"');
    expect(cli(bulk('a"b\\c'))).toBe('"a\\"b\\\\c"');
    expect(cli(bulk(Uint8Array.of(0x78, 0x01, 0x7f, 0x09, 0x79)))).toBe('"x\\x01\\x7f\\ty"');
  });

  it('numbers nested arrays with aligned indexes', () => {
    expect(cli(array([bulk('a'), bulk('b c'), bulk('')]))).toBe('1) "a"\n2) "b c"\n3) ""');
    expect(cli(array([]))).toBe('(empty array)');
    expect(cli(array([array([bulk('1-1'), array([bulk('f'), bulk('v')])])]))).toBe(
      '1) 1) "1-1"\n   2) 1) "f"\n      2) "v"',
    );
    const twelve = array([
      ...Array.from({ length: 10 }, (_, i) => integer(i + 1)),
      array([bulk('a'), array([bulk('b'), bulk('c')])]),
      integer(12),
    ]);
    expect(cli(twelve)).toBe(
      [
        ' 1) (integer) 1',
        ' 2) (integer) 2',
        ' 3) (integer) 3',
        ' 4) (integer) 4',
        ' 5) (integer) 5',
        ' 6) (integer) 6',
        ' 7) (integer) 7',
        ' 8) (integer) 8',
        ' 9) (integer) 9',
        '10) (integer) 10',
        '11) 1) "a"',
        '    2) 1) "b"',
        '       2) "c"',
        '12) (integer) 12',
      ].join('\n'),
    );
    expect(
      cli(
        array([
          integer(1),
          array([integer(2), array([integer(3), bulk('a')])]),
          array([]),
          status('OK'),
          errorReply('ERR boom'),
        ]),
      ),
    ).toBe(
      [
        '1) (integer) 1',
        '2) 1) (integer) 2',
        '   2) 1) (integer) 3',
        '      2) "a"',
        '3) (empty array)',
        '4) OK',
        '5) (error) ERR boom',
      ].join('\n'),
    );
  });

  it('formats RESP3 types like redis-cli -3', () => {
    expect(cli({ type: 'double', value: 1.5 })).toBe('(double) 1.5');
    expect(cli({ type: 'boolean', value: true })).toBe('(true)');
    expect(cli({ type: 'bignum', value: 12345678901234567890n })).toBe(
      '(big number) 12345678901234567890',
    );
    expect(cli({ type: 'verbatim', format: 'txt', value: enc('# Server\nx:1') })).toBe(
      '# Server\nx:1',
    );
    expect(
      cli({
        type: 'map',
        entries: [
          [bulk('f1'), bulk('v1')],
          [bulk('f2'), integer(2)],
        ],
      }),
    ).toBe('1# "f1" => "v1"\n2# "f2" => (integer) 2');
    expect(cli({ type: 'set', items: [bulk('a')] })).toBe('1~ "a"');
    expect(cli({ type: 'map', entries: [] })).toBe('(empty hash)');
    expect(cli({ type: 'set', items: [] })).toBe('(empty set)');
  });
});

describe('RESP', () => {
  it('encodes the wire form', () => {
    const reply = array([
      status('OK'),
      integer(3),
      bulk('hi'),
      NIL,
      errorReply('ERR x'),
      array([]),
    ]);
    expect(formatReply(reply, 'raw')).toBe(
      '*6\r\n+OK\r\n:3\r\n$2\r\nhi\r\n$-1\r\n-ERR x\r\n*0\r\n',
    );
  });

  const leaf: fc.Arbitrary<RedisReply> = fc.oneof(
    fc.stringMatching(/^[a-zA-Z0-9 ]{0,10}$/).map(status),
    fc.stringMatching(/^[A-Z]+ [a-z ]{0,10}$/).map(errorReply),
    fc
      .bigInt({ min: -(2n ** 63n), max: 2n ** 63n - 1n })
      .map((v) =>
        integer(
          v >= BigInt(Number.MIN_SAFE_INTEGER) && v <= BigInt(Number.MAX_SAFE_INTEGER)
            ? Number(v)
            : v,
        ),
      ),
    fc.uint8Array({ maxLength: 20 }).map((v) => bulk(v)),
    fc.constant(NIL),
  );
  const tree = fc.letrec<{ reply: RedisReply }>((tie) => ({
    reply: fc.oneof(
      { depthSize: 'small' },
      leaf,
      fc.array(tie('reply'), { maxLength: 4 }).map(array),
    ),
  })).reply;

  it('decodes what it encodes', () => {
    fc.assert(
      fc.property(tree, (reply) => {
        expect(decodeResp(encodeResp(reply))).toEqual(reply);
      }),
      { numRuns: 1000 },
    );
  });

  it('decodes a stream in chunks', () => {
    const bytes = encodeResp(array([bulk('abc'), integer(1)]));
    const partial = decodeRespStream(bytes.subarray(0, 10));
    expect(partial.replies).toEqual([]);
    expect(partial.consumed).toBe(0);
    const both = decodeRespStream(new Uint8Array([...bytes, ...encodeResp(status('OK'))]));
    expect(both.replies).toHaveLength(2);
    expect(() => decodeResp(enc('?x\r\n'))).toThrow(/Unknown RESP type/);
  });

  it('decodes RESP3 types', () => {
    const reply = decodeResp(enc('%2\r\n+a\r\n,1.5\r\n+b\r\n#t\r\n'));
    expect(reply).toEqual({
      type: 'map',
      entries: [
        [status('a'), { type: 'double', value: 1.5 }],
        [status('b'), { type: 'boolean', value: true }],
      ],
    });
    expect(decodeResp(enc('=9\r\ntxt:hello\r\n'))).toEqual({
      type: 'verbatim',
      format: 'txt',
      value: enc('hello'),
    });
    expect(decodeResp(enc('_\r\n'))).toEqual(NIL);
    expect(decodeResp(enc('*-1\r\n'))).toEqual(NIL);
    expect(decodeResp(enc('|1\r\n+k\r\n+v\r\n:5\r\n'))).toEqual(integer(5));
  });
});

describe('JSON form and readers', () => {
  it('renders replies as JSON', () => {
    const reply = array([status('OK'), integer(2n ** 64n), bulk(Uint8Array.of(0xff, 0x41)), NIL]);
    expect(replyToJson(reply)).toEqual(['OK', '18446744073709551616', '\\xffA', null]);
    expect(
      JSON.parse(formatReply({ type: 'map', entries: [[bulk('k'), integer(1)]] }, 'json')),
    ).toEqual({ k: 1 });
    expect(replyToJson(errorReply('ERR x'))).toEqual({ error: 'ERR x' });
  });

  it('reads flat key/value arrays', () => {
    const pairs = replyPairs(array([bulk('a'), integer(1), bulk('b'), integer(2)]))!;
    expect(pairs.map(([k, v]) => [replyText(k), replyText(v)])).toEqual([
      ['a', '1'],
      ['b', '2'],
    ]);
  });
});
