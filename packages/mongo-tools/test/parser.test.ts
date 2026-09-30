import { describe, expect, it } from 'vitest';

import {
  Binary,
  BSONRegExp,
  DBRef,
  Decimal128,
  Double,
  EJSON,
  Int32,
  Long,
  ObjectId,
  ShellParseError,
  Timestamp,
  UUID,
  bsonTypeOf,
  formatShell,
  formatShellInline,
  parseShell,
  parseShellDocument,
  parseShellPipeline,
  toEjson,
  type BsonDocument,
  type BsonValue,
} from '../src';

const NOW = new Date('2024-05-06T07:08:09.010Z');
const parse = (text: string): BsonValue => parseShell(text, { now: () => NOW });

/** Canonical Extended JSON of a parsed text, for exact type-preserving comparisons. */
const ejson = (text: string): unknown => JSON.parse(toEjson(parse(text)));

function parseError(text: string): ShellParseError {
  try {
    parseShell(text);
  } catch (error) {
    if (error instanceof ShellParseError) return error;
    throw error;
  }
  throw new Error(`"${text}" parsed without an error`);
}

describe('parseShell', () => {
  it('reads mongosh object literals: unquoted keys, quotes, trailing commas, comments', () => {
    const doc = parse(`{
      // a comment
      name: 'Ada', "quoted key": "x", 'single': 'it\\'s',
      /* block */ nested: { a: [1, 2, 3,], },
      $gt: true, _id: null, empty: {}, none: undefined,
    }`);
    expect(EJSON.serialize(doc, { relaxed: true })).toEqual({
      name: 'Ada',
      'quoted key': 'x',
      single: "it's",
      nested: { a: [1, 2, 3] },
      $gt: true,
      _id: null,
      empty: {},
      none: null,
    });
  });

  it('types numbers losslessly', () => {
    expect(ejson('1')).toEqual({ $numberInt: '1' });
    expect(ejson('-2147483648')).toEqual({ $numberInt: '-2147483648' });
    expect(ejson('2147483648')).toEqual({ $numberLong: '2147483648' });
    expect(ejson('9223372036854775807')).toEqual({ $numberLong: '9223372036854775807' });
    expect(ejson('9223372036854775808')).toEqual({ $numberDouble: '9223372036854775808.0' });
    expect(ejson('1.0')).toEqual({ $numberDouble: '1.0' });
    expect(ejson('1e3')).toEqual({ $numberDouble: '1000.0' });
    expect(ejson('.5')).toEqual({ $numberDouble: '0.5' });
    expect(ejson('-0.0')).toEqual({ $numberDouble: '-0.0' });
    expect(ejson('0x1F')).toEqual({ $numberInt: '31' });
    expect(ejson('0b101')).toEqual({ $numberInt: '5' });
    expect(ejson('1_000_000')).toEqual({ $numberInt: '1000000' });
    expect(ejson('12n')).toEqual({ $numberLong: '12' });
    expect(ejson('-Infinity')).toEqual({ $numberDouble: '-Infinity' });
    expect(ejson('NaN')).toEqual({ $numberDouble: 'NaN' });
  });

  it('reads the shell constructors', () => {
    const doc = parseShellDocument(
      `{
        a: ObjectId("507f1f77bcf86cd799439011"),
        b: ISODate("2024-01-31T12:00:00Z"),
        c: new Date("2024-01-31T12:00:00.123Z"),
        d: NumberInt("42"), e: NumberLong(5), f: NumberDecimal("1.50"), g: Double(3),
        h: UUID("3b241101-e2bb-4255-8caf-4136c566a962"),
        i: BinData(0, "AQID"), j: Timestamp(1700000000, 7), k: Timestamp({ t: 1, i: 2 }),
        l: MinKey, m: MaxKey(), n: /ab+c/i, o: DBRef("users", ObjectId("507f1f77bcf86cd799439011")),
        p: new NumberLong("9007199254740993"), q: Decimal128("1E+3"), r: Long('-1'),
        s: HexData(5, "00ff"), t: Binary.createFromBase64("AQID", 128), u: ISODate("2024-01-31"),
        v: ISODate("20240131T120000+0130"), w: new Date(0), x: RegExp('a/b', 'm'),
      }`,
    );
    expect(doc['a']).toBeInstanceOf(ObjectId);
    expect((doc['b'] as Date).toISOString()).toBe('2024-01-31T12:00:00.000Z');
    expect((doc['c'] as Date).toISOString()).toBe('2024-01-31T12:00:00.123Z');
    expect(doc['d']).toEqual(new Int32(42));
    expect(doc['e']).toEqual(Long.fromNumber(5));
    expect((doc['f'] as Decimal128).toString()).toBe('1.50');
    expect(doc['g']).toEqual(new Double(3));
    expect(bsonTypeOf(doc['h'])).toBe('uuid');
    expect((doc['h'] as UUID).toHexString()).toBe('3b241101-e2bb-4255-8caf-4136c566a962');
    expect((doc['i'] as Binary).toString('base64')).toBe('AQID');
    expect(doc['j']).toEqual(new Timestamp({ t: 1700000000, i: 7 }));
    expect(doc['k']).toEqual(new Timestamp({ t: 1, i: 2 }));
    expect(bsonTypeOf(doc['l'])).toBe('minKey');
    expect(bsonTypeOf(doc['m'])).toBe('maxKey');
    expect(doc['n']).toEqual(new BSONRegExp('ab+c', 'i'));
    expect(doc['o']).toBeInstanceOf(DBRef);
    expect((doc['p'] as Long).toString()).toBe('9007199254740993');
    expect((doc['q'] as Decimal128).toString()).toBe('1E+3');
    expect((doc['s'] as Binary).sub_type).toBe(5);
    expect((doc['t'] as Binary).sub_type).toBe(128);
    expect((doc['u'] as Date).toISOString()).toBe('2024-01-31T00:00:00.000Z');
    expect((doc['v'] as Date).toISOString()).toBe('2024-01-31T10:30:00.000Z');
    expect((doc['w'] as Date).getTime()).toBe(0);
    expect(doc['x']).toEqual(new BSONRegExp('a/b', 'm'));
  });

  it('uses the clock for argument-less constructors', () => {
    expect(parse('ISODate()')).toEqual(NOW);
    expect(parse('new Date()')).toEqual(NOW);
    expect(parse('ObjectId()')).toBeInstanceOf(ObjectId);
    expect(bsonTypeOf(parse('UUID()'))).toBe('uuid');
  });

  it('reads canonical and relaxed Extended JSON wrappers', () => {
    const canonical = EJSON.stringify(
      {
        id: new ObjectId('507f1f77bcf86cd799439011'),
        n: new Int32(1),
        l: Long.fromNumber(2),
        d: new Double(1.5),
        dec: Decimal128.fromString('3.14'),
        date: new Date('2024-01-01T00:00:00Z'),
        bin: new Binary(new Uint8Array([1, 2, 3]), 2),
        uuid: new UUID('3b241101-e2bb-4255-8caf-4136c566a962'),
        ts: new Timestamp({ t: 5, i: 6 }),
        re: new BSONRegExp('^a', 'i'),
        ref: new DBRef('c', new ObjectId('507f1f77bcf86cd799439011'), 'db'),
      },
      { relaxed: false },
    );
    expect(toEjson(parse(canonical))).toBe(canonical);
    const relaxed = `{ "when": { "$date": "2024-01-01T00:00:00Z" }, "n": { "$numberLong": "7" },
      "legacy": { "$binary": "AQID", "$type": "00" }, "u": { "$uuid": "3b241101-e2bb-4255-8caf-4136c566a962" } }`;
    const doc = parseShellDocument(relaxed);
    expect(doc['when']).toEqual(new Date('2024-01-01T00:00:00Z'));
    expect(doc['n']).toEqual(Long.fromNumber(7));
    expect((doc['legacy'] as Binary).toString('base64')).toBe('AQID');
    expect(bsonTypeOf(doc['u'])).toBe('uuid');
  });

  it('keeps $-operators that are not Extended JSON wrappers as documents', () => {
    const doc = parseShellDocument(
      `{ name: { $regex: 'abc', $options: 'i' }, n: { $gt: 5, $type: 'int' } }`,
    );
    expect(Object.keys(doc['name'] as BsonDocument)).toEqual(['$regex', '$options']);
    expect(Object.keys(doc['n'] as BsonDocument)).toEqual(['$gt', '$type']);
  });

  it('treats __proto__ as an ordinary field', () => {
    const doc = parseShellDocument('{ __proto__: { polluted: 1 }, a: 1 }');
    expect(Object.keys(doc)).toEqual(['__proto__', 'a']);
    expect(Object.getPrototypeOf(doc)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });

  it('reports errors with line, column and a message', () => {
    const error = parseError('{\n  a: 1,\n  b: [1, 2\n}');
    expect(error.code).toBe('VALIDATION_FAILED');
    expect(error.line).toBe(4);
    expect(error.column).toBe(1);
    expect(error.message).toBe("Expected ',' or ']' but found '}' (line 4, column 1)");
    expect(error.position).toBe(error.offset);

    expect(parseError('{ a: foo }').message).toContain('Unknown name "foo"');
    expect(parseError('{ a: foo }').hint).toContain('ObjectId');
    expect(parseError('{ a.b: 1 }').message).toContain('Field names with dots must be quoted');
    expect(parseError("{ a: 'x }").message).toContain('Unterminated string');
    expect(parseError('ObjectId("xyz")').message).toContain('24 hexadecimal digits');
    expect(parseError('ISODate("2024-13-01")').message).toContain('Invalid ISODate');
    expect(parseError('NumberInt(2147483648)').message).toContain('out of range');
    expect(parseError('/a/g').message).toContain('Unsupported regular expression flags');
    expect(parseError('{ "$oid": "zz" }').message).toContain('Invalid Extended JSON $oid');
    expect(parseError('[1,,2]').message).toContain('Empty array elements');
    expect(parseError('1 2').message).toContain('Expected the end of the text');
    expect(parseError('{ a: 1 + 2 }').message).toContain("Expected ',' or '}'");
    expect(parseError('eval("1")').message).toContain('Unknown function "eval"');
    expect(parseError('[[[[[[[[[[[[1]]]]]]]]]]]]'.replace(/\[/g, '[[')).code).toBe(
      'VALIDATION_FAILED',
    );
  });

  it('limits nesting depth', () => {
    const deep = `${'['.repeat(300)}${']'.repeat(300)}`;
    expect(() => parseShell(deep)).toThrow(/Nested more than 200 levels/);
    expect(() => parseShell(deep, { maxDepth: 400 })).not.toThrow();
  });

  it('parses documents and pipelines with checks', () => {
    expect(() => parseShellDocument('[1]', 'filter')).toThrow('The filter must be a document');
    expect(parseShellPipeline('[{ $match: {} }, { $limit: 5 }]')).toHaveLength(2);
    expect(() => parseShellPipeline('{ $match: {} }')).toThrow('must be an array');
    expect(() => parseShellPipeline('[1]')).toThrow('must be a document');
  });
});

describe('formatShell', () => {
  it('prints mongosh style, wrapping long documents', () => {
    const doc = parseShellDocument(
      `{ _id: ObjectId('507f1f77bcf86cd799439011'), n: 1, d: 1.0, l: NumberLong(5), s: "it's",
        when: ISODate('2024-01-31T12:00:00Z'), tags: ['a', 'b'], 'odd key': null,
        nested: { deep: { deeper: 'a long enough string to force wrapping of this document' } } }`,
    );
    expect(formatShell(doc)).toBe(`{
  _id: ObjectId('507f1f77bcf86cd799439011'),
  n: 1,
  d: 1.0,
  l: Long('5'),
  s: 'it\\'s',
  when: ISODate('2024-01-31T12:00:00.000Z'),
  tags: [ 'a', 'b' ],
  'odd key': null,
  nested: {
    deep: { deeper: 'a long enough string to force wrapping of this document' }
  }
}`);
    expect(formatShellInline({ a: new Int32(1), b: [] })).toBe('{ a: 1, b: [] }');
  });

  it('prints every BSON type so it parses back', () => {
    const text = formatShellInline(
      parseShellDocument(`{ u: UUID('3b241101-e2bb-4255-8caf-4136c566a962'), b: BinData(3, 'AQID'),
        t: Timestamp(1, 2), r: /a\\/b/, r2: RegExp('a/b'), r3: RegExp('', 'i'), x: MinKey,
        dec: NumberDecimal('-0'), inf: -Infinity, ref: DBRef('c', 1, 'db') }`),
    );
    expect(text).toBe(
      "{ u: UUID('3b241101-e2bb-4255-8caf-4136c566a962'), b: Binary.createFromBase64('AQID', 3), t: Timestamp({ t: 1, i: 2 }), r: /a\\/b/, r2: BSONRegExp('a/b', ''), r3: BSONRegExp('', 'i'), x: MinKey(), dec: Decimal128('-0'), inf: -Infinity, ref: DBRef('c', 1, 'db') }",
    );
    expect(toEjson(parseShell(text))).toBe(toEjson(parseShell(text.replace(/\s+/g, ' '))));
  });

  it('truncates long strings only when asked', () => {
    expect(formatShellInline('abcdef', { maxStringLength: 3 })).toBe("'abc'…");
  });
});
