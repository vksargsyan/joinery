import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  Binary,
  BSONRegExp,
  BSONSymbol,
  Code,
  DBRef,
  Decimal128,
  Double,
  EJSON,
  Int32,
  Long,
  MaxKey,
  MinKey,
  ObjectId,
  ShellParseError,
  Timestamp,
  UUID,
  formatShell,
  formatShellInline,
  parseFindText,
  parseShell,
  toEjson,
  type BsonDocument,
  type BsonValue,
} from '../src';

/**
 * Fuzz tests (spec §20): the parser never throws anything but a ShellParseError, printing then
 * parsing any BSON value gives the same value (compared as canonical Extended JSON), and
 * canonical Extended JSON text parses to the value it describes.
 */

const RUNS = Number(process.env['QUERYBARA_FUZZ_RUNS'] ?? 300);

const OPERATORS = ['$gt', '$in', '$and', '$set', '$ref', '$id', '$db', '$type', '$regex'];

const key = fc.oneof(
  { weight: 5, arbitrary: fc.string({ maxLength: 12 }).filter((k) => !k.startsWith('$')) },
  { weight: 1, arbitrary: fc.constantFrom(...OPERATORS) },
  { weight: 1, arbitrary: fc.constantFrom('__proto__', 'constructor', 'new', 'true', '1', 'a.b') },
);

const hex = (bytes: number) =>
  fc
    .uint8Array({ minLength: bytes, maxLength: bytes })
    .map((b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join(''));

const scalar: fc.Arbitrary<BsonValue> = fc.oneof(
  fc.constant(null),
  fc.boolean(),
  fc.string({ unit: 'binary', maxLength: 20 }),
  fc.string({ maxLength: 20 }),
  fc.integer({ min: -2147483648, max: 2147483647 }).map((n) => new Int32(n)),
  fc.integer({ min: -2147483648, max: 2147483647 }),
  fc.double().map((n) => new Double(n)),
  // A JS number's Extended JSON is only stable for Int32 values and fractions.
  fc.double().filter((n) => !Number.isInteger(n)),
  fc.bigInt({ min: -(2n ** 63n), max: 2n ** 63n - 1n }).map((n) => Long.fromBigInt(n)),
  fc
    .tuple(fc.bigInt({ min: -(10n ** 20n), max: 10n ** 20n }), fc.integer({ min: -60, max: 60 }))
    .map(([digits, exp]) => Decimal128.fromString(`${digits}E${exp}`)),
  fc
    .constantFrom('NaN', '-Infinity', '-0', '0E-6176', '1.000')
    .map((s) => Decimal128.fromString(s)),
  fc.date({ min: new Date(-8.64e15), max: new Date(8.64e15), noInvalidDate: true }),
  hex(12).map((h) => ObjectId.createFromHexString(h)),
  fc.uuid().map((u) => new UUID(u)),
  fc
    .tuple(fc.uint8Array({ maxLength: 24 }), fc.integer({ min: 0, max: 255 }))
    // Random bytes are no valid vector (bson validates its dtype and padding).
    .filter(([, subtype]) => subtype !== Binary.SUBTYPE_VECTOR)
    .map(([bytes, subtype]) => new Binary(bytes, subtype)),
  fc
    .tuple(fc.integer({ min: 0, max: 0xffffffff }), fc.integer({ min: 0, max: 0xffffffff }))
    .map(([t, i]) => new Timestamp({ t, i })),
  fc.constant(new MinKey()),
  fc.constant(new MaxKey()),
  fc
    .tuple(
      fc.string({ maxLength: 10 }).filter((s) => !s.includes('\0')),
      fc.subarray(['i', 'm', 'x', 's', 'l', 'u']),
    )
    .map(([pattern, flags]) => new BSONRegExp(pattern, flags.join(''))),
  fc.string({ maxLength: 10 }).map((s) => new BSONSymbol(s)),
  fc.string({ maxLength: 20 }).map((s) => new Code(s)),
  fc
    .tuple(
      fc.string({ minLength: 1, maxLength: 8 }).filter((s) => !s.includes('.')),
      hex(12),
      fc.option(fc.string({ minLength: 1, maxLength: 8 }), { nil: undefined }),
    )
    .map(([coll, id, db]) => new DBRef(coll, ObjectId.createFromHexString(id), db)),
);

function document(entries: readonly (readonly [string, BsonValue])[]): BsonDocument {
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
}

const { value } = fc.letrec<{ value: BsonValue; doc: BsonDocument }>((tie) => ({
  value: fc.oneof(
    { depthSize: 'small', withCrossShrink: true },
    scalar,
    fc.array(tie('value'), { maxLength: 5 }),
    tie('doc'),
  ),
  doc: fc
    .uniqueArray(fc.tuple(key, tie('value')), { maxLength: 6, selector: ([k]) => k })
    .map(document)
    // A document whose keys form an Extended JSON wrapper reads back as that type by design.
    .filter((doc) => !isWrapperLike(doc)),
}));

function isWrapperLike(doc: BsonDocument): boolean {
  const keys = Object.keys(doc);
  return keys.includes('$ref') && keys.includes('$id');
}

/** Fragments that open, close or confuse strings, comments, constructors and literals. */
const NOISE = [
  '{',
  '}',
  '[',
  ']',
  '(',
  ')',
  ',',
  ':',
  '.',
  ';',
  '-',
  '+',
  "'",
  '"',
  '`',
  '\\',
  '/',
  '//',
  '/*',
  '*/',
  '${',
  '\n',
  ' ',
  'a',
  '$gt',
  '0',
  '1.5',
  '1e',
  '0x',
  '9n',
  '_',
  'new',
  'ObjectId',
  'ISODate',
  'Date',
  'NumberLong',
  'UUID',
  'BinData',
  'Timestamp',
  'DBRef',
  'MinKey',
  'Code',
  '"2024-01-01"',
  '"507f1f77bcf86cd799439011"',
  '{"$oid":',
  '{"$date":',
  '{"$numberLong":',
  '{"$binary":',
  '{"$timestamp":',
  '\\u{',
  '\\x',
  ' ',
  '😀',
  'db.c.find(',
  '.sort(',
  '.limit(',
];

const noisy = fc.array(fc.constantFrom(...NOISE), { maxLength: 30 }).map((parts) => parts.join(''));

function onlyParseErrors(run: () => unknown): void {
  try {
    run();
  } catch (error) {
    if (!(error instanceof ShellParseError)) throw error;
    expect(error.line).toBeGreaterThanOrEqual(1);
    expect(error.column).toBeGreaterThanOrEqual(1);
    expect(error.message).toMatch(/\(line \d+, column \d+\)$/);
  }
}

describe('shell parser fuzzing', () => {
  it('throws nothing but parse errors on arbitrary text', () => {
    fc.assert(
      fc.property(fc.oneof(fc.string({ unit: 'binary', maxLength: 60 }), noisy), (text) => {
        onlyParseErrors(() => parseShell(text));
        onlyParseErrors(() => parseFindText(text));
      }),
      { numRuns: RUNS * 5 },
    );
  });

  it('parses formatted values back to the same value', () => {
    fc.assert(
      fc.property(value, fc.integer({ min: 20, max: 120 }), (v, lineWidth) => {
        const canonical = toEjson(v);
        expect(toEjson(parseShell(formatShell(v, { lineWidth })))).toBe(canonical);
        expect(toEjson(parseShell(formatShellInline(v)))).toBe(canonical);
      }),
      { numRuns: RUNS },
    );
  });

  it('reads canonical Extended JSON as the value it describes', () => {
    fc.assert(
      fc.property(value, (v) => {
        const canonical = toEjson(v);
        expect(toEjson(parseShell(canonical))).toBe(canonical);
        expect(toEjson(parseShell(EJSON.stringify(v, { relaxed: false }, 2)))).toBe(canonical);
      }),
      { numRuns: RUNS },
    );
  });
});
