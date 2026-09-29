import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as bson from 'bson';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  CODE_EXPORT_LANGUAGES,
  exportQueryCode,
  parseShell,
  sqlToMql,
  toEjson,
  type BsonValue,
  type CodeLanguage,
} from '../src';
import { CSharpValues } from '../src/codegen/csharp';
import { GoValues } from '../src/codegen/go';
import { JavaValues } from '../src/codegen/java';
import { NodeValues } from '../src/codegen/node';
import { PhpValues } from '../src/codegen/php';
import { PythonValues } from '../src/codegen/python';
import { AGGREGATE, FIND, TYPES, bsonValue } from './codegen-fixtures';

/**
 * Code export (spec §9): goldens per language and BSON type, whole-program goldens, and a
 * property test that evaluates the Node.js values with the bson classes the `mongodb` driver
 * re-exports and checks they serialise to exactly the exported value.
 */

const GOLDEN = fileURLToPath(new URL('./golden/code-export', import.meta.url));
const UPDATE = process.env['JOINERY_UPDATE_GOLDEN'] === '1';

// [type, shell literal, Node.js, Python, Java, C#, Go, PHP]
const TYPE_GOLDENS: readonly (readonly [string, string, ...string[]])[] = [
  ['null', 'null', 'null', 'None', 'null', 'BsonNull.Value', 'nil', 'null'],
  ['bool', 'true', 'true', 'True', 'true', 'true', 'true', 'true'],
  [
    'string',
    `'it\\'s "q" \\\\ $x\\n\\u0001é'`,
    `'it\\'s "q" \\\\ $x\\n\\u0001é'`,
    `"it's \\"q\\" \\\\ $x\\n\\x01é"`,
    `"it's \\"q\\" \\\\ $x\\n\\u0001é"`,
    `"it's \\"q\\" \\\\ $x\\n\\u0001é"`,
    `"it's \\"q\\" \\\\ $x\\n\\u0001é"`,
    `"it's \\"q\\" \\\\ \\$x\\n\\u{1}é"`,
  ],
  ['int32', '42', '42', '42', '42', '42', '42', '42'],
  [
    'int32 min',
    '-2147483648',
    '-2147483648',
    '-2147483648',
    '-2147483648',
    '-2147483648',
    '-2147483648',
    '-2147483648',
  ],
  [
    'int64',
    'NumberLong(5)',
    "Long.fromString('5')",
    'Int64(5)',
    '5L',
    '5L',
    'int64(5)',
    'new Int64(5)',
  ],
  [
    'int64 min',
    "NumberLong('-9223372036854775808')",
    "Long.fromString('-9223372036854775808')",
    'Int64(-9223372036854775808)',
    '-9223372036854775808L',
    '-9223372036854775808L',
    'int64(-9223372036854775808)',
    'new Int64(PHP_INT_MIN)',
  ],
  ['double integral', '1.0', 'new Double(1)', '1.0', '1.0', '1.0', '1.0', '1.0'],
  ['double', '2.5', '2.5', '2.5', '2.5', '2.5', '2.5', '2.5'],
  ['NaN', 'NaN', 'NaN', 'float("nan")', 'Double.NaN', 'double.NaN', 'math.NaN()', 'NAN'],
  [
    'Infinity',
    'Infinity',
    'Infinity',
    'float("inf")',
    'Double.POSITIVE_INFINITY',
    'double.PositiveInfinity',
    'math.Inf(1)',
    'INF',
  ],
  [
    '-Infinity',
    '-Infinity',
    '-Infinity',
    'float("-inf")',
    'Double.NEGATIVE_INFINITY',
    'double.NegativeInfinity',
    'math.Inf(-1)',
    '-INF',
  ],
  [
    '-0',
    '-0.0',
    'new Double(-0)',
    '-0.0',
    '-0.0',
    'new BsonDouble(-0.0)',
    'math.Copysign(0, -1)',
    '-0.0',
  ],
  ['1e300', '1e300', 'new Double(1e+300)', '1e+300', '1e+300', '1e+300', '1e+300', '1e+300'],
  [
    'decimal',
    "NumberDecimal('1.50')",
    "Decimal128.fromString('1.50')",
    'Decimal128("1.50")',
    'Decimal128.parse("1.50")',
    'new BsonDecimal128(Decimal128.Parse("1.50"))',
    'decimal128("1.50")',
    "new Decimal128('1.50')",
  ],
  [
    'objectId',
    "ObjectId('65a1b2c3d4e5f60718293a4b')",
    "new ObjectId('65a1b2c3d4e5f60718293a4b')",
    'ObjectId("65a1b2c3d4e5f60718293a4b")',
    'new ObjectId("65a1b2c3d4e5f60718293a4b")',
    'new ObjectId("65a1b2c3d4e5f60718293a4b")',
    'objectID("65a1b2c3d4e5f60718293a4b")',
    "new ObjectId('65a1b2c3d4e5f60718293a4b')",
  ],
  [
    'date',
    "ISODate('2024-01-02T03:04:05.678Z')",
    "new Date('2024-01-02T03:04:05.678Z')",
    'datetime(2024, 1, 2, 3, 4, 5, 678000, tzinfo=timezone.utc)',
    'Date.from(Instant.parse("2024-01-02T03:04:05.678Z"))',
    'new DateTime(2024, 1, 2, 3, 4, 5, 678, DateTimeKind.Utc)',
    'time.Date(2024, time.January, 2, 3, 4, 5, 678000000, time.UTC)',
    "new UTCDateTime(new DateTimeImmutable('2024-01-02T03:04:05.678Z'))",
  ],
  [
    'date at midnight',
    "ISODate('2024-01-01T00:00:00Z')",
    "new Date('2024-01-01T00:00:00.000Z')",
    'datetime(2024, 1, 1, tzinfo=timezone.utc)',
    'Date.from(Instant.parse("2024-01-01T00:00:00.000Z"))',
    'new DateTime(2024, 1, 1, 0, 0, 0, DateTimeKind.Utc)',
    'time.Date(2024, time.January, 1, 0, 0, 0, 0, time.UTC)',
    "new UTCDateTime(new DateTimeImmutable('2024-01-01T00:00:00.000Z'))",
  ],
  [
    'date past year 9999',
    "ISODate('+010000-01-01T00:00:00Z')",
    "new Date('+010000-01-01T00:00:00.000Z')",
    'DatetimeMS(253402300800000)',
    'new Date(253402300800000L)',
    'new BsonDateTime(253402300800000)',
    'time.Date(10000, time.January, 1, 0, 0, 0, 0, time.UTC)',
    'new UTCDateTime(253402300800000)',
  ],
  [
    'binary',
    "BinData(0, 'AQI=')",
    "Binary.createFromBase64('AQI=', 0)",
    'Binary(bytes.fromhex("0102"), 0)',
    'new Binary((byte) 0x00, Base64.getDecoder().decode("AQI="))',
    'new BsonBinaryData(Convert.FromBase64String("AQI="), BsonBinarySubType.Binary)',
    'bson.Binary{Subtype: 0x00, Data: []byte{0x01, 0x02}}',
    "new Binary(base64_decode('AQI='), 0)",
  ],
  [
    'binary user subtype',
    "BinData(128, 'AA==')",
    "Binary.createFromBase64('AA==', 128)",
    'Binary(bytes.fromhex("00"), 128)',
    'new Binary((byte) 0x80, Base64.getDecoder().decode("AA=="))',
    'new BsonBinaryData(Convert.FromBase64String("AA=="), (BsonBinarySubType)0x80)',
    'bson.Binary{Subtype: 0x80, Data: []byte{0x00}}',
    "new Binary(base64_decode('AA=='), 128)",
  ],
  [
    'uuid',
    "UUID('a8098c1a-f86e-11da-bd1a-00112444be1e')",
    "new UUID('a8098c1a-f86e-11da-bd1a-00112444be1e')",
    'Binary.from_uuid(UUID("a8098c1a-f86e-11da-bd1a-00112444be1e"))',
    'new BsonBinary(UUID.fromString("a8098c1a-f86e-11da-bd1a-00112444be1e"))',
    'new BsonBinaryData(Guid.Parse("a8098c1a-f86e-11da-bd1a-00112444be1e"), GuidRepresentation.Standard)',
    'uuidBinary("a8098c1a-f86e-11da-bd1a-00112444be1e")',
    "new Binary(hex2bin('a8098c1af86e11dabd1a00112444be1e'), Binary::TYPE_UUID)",
  ],
  [
    'regex',
    '/^ab/i',
    '/^ab/i',
    'Regex("^ab", "i")',
    'new BsonRegularExpression("^ab", "i")',
    'new BsonRegularExpression("^ab", "i")',
    'bson.Regex{Pattern: "^ab", Options: "i"}',
    "new Regex('^ab', 'i')",
  ],
  [
    // The Node.js driver only carries the i and m flags of a RegExp literal.
    'regex with the s flag',
    "BSONRegExp('a.b', 's')",
    "new BSONRegExp('a.b', 's')",
    'Regex("a.b", "s")',
    'new BsonRegularExpression("a.b", "s")',
    'new BsonRegularExpression("a.b", "s")',
    'bson.Regex{Pattern: "a.b", Options: "s"}',
    "new Regex('a.b', 's')",
  ],
  [
    'timestamp',
    'Timestamp({ t: 1700000000, i: 7 })',
    'new Timestamp({ t: 1700000000, i: 7 })',
    'Timestamp(1700000000, 7)',
    'new BsonTimestamp(1700000000, 7)',
    'new BsonTimestamp(1700000000, 7)',
    'bson.Timestamp{T: 1700000000, I: 7}',
    'new Timestamp(7, 1700000000)',
  ],
  [
    'timestamp past int32',
    'Timestamp({ t: 4294967295, i: 1 })',
    'new Timestamp({ t: 4294967295, i: 1 })',
    'Timestamp(4294967295, 1)',
    'new BsonTimestamp(-4294967295L)',
    'new BsonTimestamp(-4294967295L)',
    'bson.Timestamp{T: 4294967295, I: 1}',
    'new Timestamp(1, 4294967295)',
  ],
  [
    'minKey',
    'MinKey()',
    'new MinKey()',
    'MinKey()',
    'new MinKey()',
    'BsonMinKey.Value',
    'bson.MinKey{}',
    'new MinKey()',
  ],
  [
    'maxKey',
    'MaxKey()',
    'new MaxKey()',
    'MaxKey()',
    'new MaxKey()',
    'BsonMaxKey.Value',
    'bson.MaxKey{}',
    'new MaxKey()',
  ],
  [
    'code',
    "Code('return 1')",
    "new Code('return 1')",
    'Code("return 1")',
    'new Code("return 1")',
    'new BsonJavaScript("return 1")',
    'bson.JavaScript("return 1")',
    "new Javascript('return 1')",
  ],
  [
    'dbref',
    "DBRef('things', 5, 'other')",
    "new DBRef('things', 5, 'other')",
    'DBRef("things", 5, "other")',
    'new DBRef("other", "things", 5)',
    'new BsonDocument { { "$ref", "things" }, { "$id", 5 }, { "$db", "other" } }',
    'bson.D{{"$ref", "things"}, {"$id", 5}, {"$db", "other"}}',
    "['$ref' => 'things', '$id' => 5, '$db' => 'other']",
  ],
  [
    'document',
    "{ a: 1, 'b c': [1, 'x'], d: {} }",
    "{ a: 1, 'b c': [1, 'x'], d: {} }",
    '{"a": 1, "b c": [1, "x"], "d": {}}',
    'new Document("a", 1).append("b c", Arrays.asList(1, "x")).append("d", new Document())',
    'new BsonDocument\n{\n    { "a", 1 },\n    { "b c", new BsonArray { 1, "x" } },\n    { "d", new BsonDocument() },\n}',
    'bson.D{{"a", 1}, {"b c", bson.A{1, "x"}}, {"d", bson.D{}}}',
    "['a' => 1, 'b c' => [1, 'x'], 'd' => (object) []]",
  ],
  [
    // PHP encodes an array with keys 0..n-1 as a BSON array unless it is cast to an object.
    'document with list-like keys',
    "{ '0': 'a', '1': 'b' }",
    "{ '0': 'a', '1': 'b' }",
    '{"0": "a", "1": "b"}',
    'new Document("0", "a").append("1", "b")',
    'new BsonDocument { { "0", "a" }, { "1", "b" } }',
    'bson.D{{"0", "a"}, {"1", "b"}}',
    "(object) ['0' => 'a', '1' => 'b']",
  ],
  [
    'array',
    '[1, null, []]',
    '[1, null, []]',
    '[1, None, []]',
    'Arrays.asList(1, null, Arrays.asList())',
    'new BsonArray { 1, BsonNull.Value, new BsonArray() }',
    'bson.A{1, nil, bson.A{}}',
    '[1, null, []]',
  ],
  [
    'array of one null',
    '[null]',
    '[null]',
    '[None]',
    'Arrays.asList((Object) null)',
    'new BsonArray { BsonNull.Value }',
    'bson.A{nil}',
    '[null]',
  ],
];

const PRINTERS: readonly ((value: BsonValue) => string)[] = [
  (v) => new NodeValues().value(v, 0),
  (v) => new PythonValues().value(v, 0),
  (v) => new JavaValues().value(v, 0),
  (v) => new CSharpValues().value(v, 0),
  (v) => new GoValues().value(v, 0),
  (v) => new PhpValues().value(v, 0),
];

describe('code export values', () => {
  it.each(TYPE_GOLDENS)('writes %s natively in each language', (_type, shell, ...expected) => {
    const value = parseShell(shell);
    expect(PRINTERS.map((print) => print(value))).toEqual(expected);
  });

  it('writes a JavaScript number as Extended JSON types it', () => {
    const print = (value: BsonValue) => PRINTERS.map((p) => p(value));
    expect(print(7)).toEqual(['7', '7', '7', '7', '7', '7']);
    expect(print(3_000_000_000)).toEqual([
      "Long.fromString('3000000000')",
      'Int64(3000000000)',
      '3000000000L',
      '3000000000L',
      'int64(3000000000)',
      'new Int64(3000000000)',
    ]);
    expect(print(0.5)[0]).toBe('0.5');
    expect(print(new RegExp('a/b', 'i'))).toEqual([
      '/a\\/b/i',
      'Regex("a\\\\/b", "i")',
      'new BsonRegularExpression("a\\\\/b", "i")',
      'new BsonRegularExpression("a\\\\/b", "i")',
      'bson.Regex{Pattern: "a\\\\/b", Options: "i"}',
      "new Regex('a\\\\/b', 'i')",
    ]);
  });

  it('escapes strings for each language, including lone surrogates and line separators', () => {
    const value = 'a b\ud800c\t"\'\\$';
    expect(PRINTERS.map((print) => print(value))).toEqual([
      "'a\\u2028b\\ud800c\\t\"\\'\\\\$'",
      '"a\\u2028b�c\\t\\"\'\\\\$"',
      '"a\\u2028b�c\\t\\"\'\\\\$"',
      '"a\\u2028b�c\\t\\"\'\\\\$"',
      '"a\\u2028b�c\\t\\"\'\\\\$"',
      '"a\\u{2028}b�c\\t\\"\'\\\\\\$"',
    ]);
    expect(new PhpValues().value('$gt', 0)).toBe("'$gt'");
  });
});

describe('code export programs', () => {
  const targets = { find: FIND, aggregate: AGGREGATE, types: TYPES } as const;

  it.each(
    Object.keys(targets).flatMap((name) =>
      CODE_EXPORT_LANGUAGES.map((language) => [name, language.id, language.fileName] as const),
    ),
  )('%s in %s matches its golden', (name, language, fileName) => {
    const code = exportQueryCode(targets[name as keyof typeof targets], language, {
      database: 'shop',
    });
    const file = join(GOLDEN, name, `${fileName}.golden`);
    if (UPDATE) {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, code);
    }
    expect(code).toBe(readFileSync(file, 'utf8'));
  });

  it('reads the connection string from MONGODB_URI and never embeds one', () => {
    for (const language of CODE_EXPORT_LANGUAGES) {
      const code = exportQueryCode(FIND, language.id, { database: 'shop' });
      expect(code, language.id).toContain('MONGODB_URI');
      expect(code, language.id).not.toMatch(/mongodb(\+srv)?:\/\/[^\s'"]*@/);
      expect(code, language.id).toContain(language.install.replace('Maven: ', ''));
    }
  });

  it('quotes database and collection names for each language', () => {
    const target = { kind: 'find', collection: `o'd "c"`, query: { filter: {} } } as const;
    const lines = (language: CodeLanguage) =>
      exportQueryCode(target, language, { database: 'db$1' })
        .split('\n')
        .filter((line) => line.includes("o\\'d") || line.includes("o'd"))
        .map((line) => line.trim());
    expect(lines('node')).toEqual([
      "const collection = client.db('db$1').collection('o\\'d \"c\"');",
    ]);
    expect(lines('python')).toEqual(['collection = client["db$1"]["o\'d \\"c\\""]']);
    expect(lines('go')).toEqual([
      'collection := client.Database("db$1").Collection("o\'d \\"c\\"")',
    ]);
    expect(lines('php')).toEqual([
      "$collection = $client->selectCollection('db$1', 'o\\'d \"c\"');",
    ]);
  });

  it('takes a SQL translation as it is', () => {
    const translation = sqlToMql("SELECT name FROM people WHERE name LIKE 'A%' LIMIT 3");
    const code = exportQueryCode(translation, 'python', { database: 'crm' });
    expect(code).toContain('query_filter = {"name": Regex("^A")}');
    expect(code).toContain('projection = {"name": 1, "_id": 0}');
    expect(code).toContain('for document in collection.find(query_filter, projection, limit=3):');
  });

  it('refuses an empty database or collection name', () => {
    expect(() => exportQueryCode(FIND, 'node', { database: '' })).toThrow(/database/);
    expect(() =>
      exportQueryCode({ ...FIND, collection: '' }, 'node', { database: 'shop' }),
    ).toThrow(/collection/);
  });
});

describe('Node.js values round trip', () => {
  const classes = {
    Binary: bson.Binary,
    BSONRegExp: bson.BSONRegExp,
    BSONSymbol: bson.BSONSymbol,
    Code: bson.Code,
    DBRef: bson.DBRef,
    Decimal128: bson.Decimal128,
    Double: bson.Double,
    Long: bson.Long,
    MaxKey: bson.MaxKey,
    MinKey: bson.MinKey,
    ObjectId: bson.ObjectId,
    Timestamp: bson.Timestamp,
    UUID: bson.UUID,
  };

  /** What the driver sends for a value: serialised as the driver does, then read back typed. */
  function sent(value: unknown): string {
    const bytes = bson.BSON.serialize({ v: value });
    return toEjson(bson.BSON.deserialize(bytes, { promoteValues: false, bsonRegExp: true }));
  }

  it('evaluates to exactly the exported value', () => {
    fc.assert(
      fc.property(bsonValue, (value) => {
        const text = new NodeValues().value(value, 0);
        // Evaluated in this realm, so Dates and RegExps are the ones bson knows.
        const evaluate = new Function(...Object.keys(classes), `return (${text});`) as (
          ...args: unknown[]
        ) => unknown;
        const evaluated = evaluate(...Object.values(classes));
        // Canonical Extended JSON is what the value means; the driver must send the same.
        expect(sent(evaluated), text).toBe(
          toEjson(bson.EJSON.parse(toEjson({ v: value }), { relaxed: false })),
        );
      }),
      { numRuns: Number(process.env['JOINERY_FUZZ_RUNS'] ?? 300) },
    );
  });
});
