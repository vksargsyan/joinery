import fc from 'fast-check';

import {
  Binary,
  BSONRegExp,
  BSONSymbol,
  Code,
  DBRef,
  Decimal128,
  Double,
  Int32,
  Long,
  MaxKey,
  MinKey,
  ObjectId,
  Timestamp,
  UUID,
  parseShellDocument,
  parseShellPipeline,
  type BsonDocument,
  type BsonValue,
  type ExportTarget,
} from '../src';

/** Queries the code export tests print in every language. */

export const FIND: ExportTarget = {
  kind: 'find',
  collection: 'orders',
  query: {
    filter: parseShellDocument(
      "{ status: { $in: ['A', 'D'] }, qty: { $gte: 5, $lt: NumberLong(100) }, 'item.sku': /^ab/i }",
    ),
    projection: parseShellDocument('{ status: 1, qty: 1, _id: 0 }'),
    sort: parseShellDocument('{ qty: -1, status: 1 }'),
    skip: 10,
    limit: 20,
    collation: parseShellDocument("{ locale: 'en', strength: 2, numericOrdering: true }"),
    hint: parseShellDocument('{ status: 1 }'),
    maxTimeMS: 5000,
  },
};

export const AGGREGATE: ExportTarget = {
  kind: 'aggregate',
  collection: 'order items',
  pipeline: parseShellPipeline(`[
    { $match: { status: 'A', at: { $gte: ISODate('2024-01-01T00:00:00Z') }, price: { $gt: NumberDecimal('9.99') } } },
    { $group: { _id: '$cust', total: { $sum: '$amount' }, n: { $sum: 1 }, avg: { $avg: 1.0 } } },
    { $match: {} },
    { $sort: { total: -1 } },
    { $limit: 5 },
  ]`),
};

/** A document holding every BSON type the exporters write. */
export const ALL_TYPES: BsonDocument = parseShellDocument(`{
  oid: ObjectId('65a1b2c3d4e5f60718293a4b'),
  date: ISODate('2024-01-02T03:04:05.678Z'),
  far: ISODate('+010000-01-01T00:00:00Z'),
  dec: NumberDecimal('1234.5600'),
  long: NumberLong('9007199254740993'),
  smallLong: NumberLong(5),
  int: 42,
  double: 1.0,
  frac: 2.5,
  nan: NaN,
  inf: Infinity,
  nzero: -0.0,
  bin: BinData(0, 'AQIDBA=='),
  userBin: BinData(128, 'AA=='),
  uuid: UUID('a8098c1a-f86e-11da-bd1a-00112444be1e'),
  re: /^ab+c/i,
  reX: BSONRegExp('a b # comment', 'xs'),
  ts: Timestamp({ t: 1700000000, i: 7 }),
  tsBig: Timestamp({ t: 4294967295, i: 4294967295 }),
  min: MinKey(),
  max: MaxKey(),
  nul: null,
  t: true,
  s: 'it\\'s "quoted" \\\\ $var\\n\\ttab \\u0001 é 😀',
  nested: { a: [1, 'x', { b: null }], 'a.b': 1 },
  list: { '0': 'a', '1': 'b' },
  emptyDoc: {},
  emptyArr: [],
  single: [null],
  code: Code('function() { return 1; }'),
  ref: DBRef('things', ObjectId('65a1b2c3d4e5f60718293a4c')),
}`);

export const TYPES: ExportTarget = {
  kind: 'find',
  collection: 'types',
  query: { filter: ALL_TYPES },
};

const hex = (bytes: number) =>
  fc
    .uint8Array({ minLength: bytes, maxLength: bytes })
    .map((b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join(''));

const key = fc.oneof(
  {
    weight: 5,
    arbitrary: fc.string({ maxLength: 10 }).filter((k) => k !== '' && !k.startsWith('$')),
  },
  {
    weight: 1,
    arbitrary: fc.constantFrom('$gt', '$in', '__proto__', '0', '1', 'a.b', 'x y', '"', "'"),
  },
);

const scalar: fc.Arbitrary<BsonValue> = fc.oneof(
  fc.constant(null),
  fc.boolean(),
  fc.string({ unit: 'binary', maxLength: 16 }).filter((s) => !s.includes('\0')),
  fc.integer({ min: -2147483648, max: 2147483647 }).map((n) => new Int32(n)),
  fc.integer({ min: -2147483648, max: 2147483647 }),
  fc.double().map((n) => new Double(n)),
  fc.double().filter((n) => !Number.isInteger(n)),
  fc.bigInt({ min: -(2n ** 63n), max: 2n ** 63n - 1n }).map((n) => Long.fromBigInt(n)),
  fc
    .tuple(fc.bigInt({ min: -(10n ** 20n), max: 10n ** 20n }), fc.integer({ min: -60, max: 60 }))
    .map(([digits, exp]) => Decimal128.fromString(`${digits}E${exp}`)),
  fc.constantFrom('NaN', '-Infinity', '-0', '1.000').map((s) => Decimal128.fromString(s)),
  fc.date({ min: new Date(-8.64e15), max: new Date(8.64e15), noInvalidDate: true }),
  hex(12).map((h) => ObjectId.createFromHexString(h)),
  fc.uuid().map((u) => new UUID(u)),
  fc
    .tuple(fc.uint8Array({ maxLength: 20 }), fc.constantFrom(0, 1, 2, 3, 5, 6, 7, 8, 0x80, 0xff))
    .map(([bytes, subtype]) => new Binary(bytes, subtype)),
  fc
    .tuple(fc.integer({ min: 0, max: 0xffffffff }), fc.integer({ min: 0, max: 0xffffffff }))
    .map(([t, i]) => new Timestamp({ t, i })),
  fc.constant(new MinKey()),
  fc.constant(new MaxKey()),
  fc
    .tuple(
      fc.string({ maxLength: 10 }).filter((s) => !s.includes('\0')),
      fc.subarray(['i', 'm', 's', 'u', 'x']),
    )
    .map(([pattern, flags]) => new BSONRegExp(pattern, flags.join(''))),
  fc.constantFrom('^ab+c', 'a|b', '\\d{2,3}', '[a-z]+$').map((p) => new RegExp(p, 'i')),
  fc.string({ maxLength: 10 }).map((s) => new BSONSymbol(s)),
  fc.string({ maxLength: 20 }).map((s) => new Code(s)),
  hex(12).map((h) => new DBRef('things', ObjectId.createFromHexString(h))),
  // DBRef ids may be any value; the class types them as ObjectIds.
  fc.integer().map((n) => new DBRef('things', new Int32(n) as unknown as ObjectId, 'other')),
);

function documentOf(values: fc.Arbitrary<BsonValue>): fc.Arbitrary<BsonDocument> {
  return fc
    .uniqueArray(fc.tuple(key, values), { maxLength: 4, selector: ([k]) => k })
    .map((entries) => {
      const doc: BsonDocument = {};
      for (const [k, v] of entries) {
        Object.defineProperty(doc, k, {
          value: v,
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
      return doc;
    });
}

/** Any BSON value, nested up to three levels. */
export const bsonValue: fc.Arbitrary<BsonValue> = fc.letrec<{ value: BsonValue }>((tie) => ({
  value: fc.oneof(
    { depthSize: 'small', withCrossShrink: true },
    { weight: 4, arbitrary: scalar },
    { weight: 1, arbitrary: fc.array(tie('value'), { maxLength: 4 }) },
    { weight: 1, arbitrary: documentOf(tie('value')) },
  ),
})).value;

/** A document of any values, for whole programs. */
export const bsonDocument: fc.Arbitrary<BsonDocument> = documentOf(bsonValue);
