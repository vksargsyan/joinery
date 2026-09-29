import {
  Binary,
  Decimal128,
  Double,
  Int32,
  Long,
  ObjectId,
  Timestamp,
  UUID,
  analyzeSchema,
  type BsonDocument,
} from '@joinery/mongo-tools';
import { describe, expect, it } from 'vitest';

import {
  bsonCell,
  flattenCollection,
  isJsonText,
  mongoFieldType,
  sqlTypeForBson,
  toBsonValue,
  type FlatTable,
} from '../src';
import { valueAtPath } from '../src/db/mongo-map';

/** The document ↔ row mapping: flattening, child tables, typed values both ways. */

const id = new ObjectId('65a1b2c3d4e5f60718293a4b');
const SAMPLE: BsonDocument[] = [
  {
    _id: id,
    name: 'Ada',
    age: new Int32(36),
    address: { city: 'London', geo: { lat: new Double(51.5), lng: new Double(-0.1) } },
    tags: ['a', 'b'],
    items: [
      { sku: 'x1', qty: new Int32(2) },
      { sku: 'x2', qty: new Int32(1), note: 'gift' },
    ],
    scores: [new Int32(1), new Int32(2)],
    mixed: 'text',
  },
  {
    _id: new ObjectId(),
    name: 'Grace',
    age: Long.fromNumber(5_000_000_000),
    items: [],
    mixed: { a: 1 },
  },
];

function columns(table: FlatTable): Record<string, string> {
  return Object.fromEntries(table.columns.map((c) => [c.name, c.dataType]));
}

describe('flattenCollection', () => {
  const analysis = analyzeSchema(SAMPLE);

  it('flattens sub-documents to columns and arrays of documents to a child table', () => {
    const [main, items, ...rest] = flattenCollection(analysis, {
      collection: 'people',
      table: 'people',
      dialect: 'postgres',
    });
    expect(rest).toEqual([]);
    expect(columns(main!)).toEqual({
      _id: 'character(24)',
      name: 'text',
      age: 'bigint',
      address_city: 'text',
      address_geo_lat: 'double precision',
      address_geo_lng: 'double precision',
      tags: 'jsonb',
      scores: 'jsonb',
      mixed: 'jsonb',
    });
    expect(main!.primaryKey).toEqual(['_id']);
    expect(main!.columns.find((c) => c.name === 'address_geo_lat')!.path).toEqual([
      'address',
      'geo',
      'lat',
    ]);
    expect(main!.planned.find((p) => p.source === 'mixed')!.note).toMatch(/Mixed/);
    expect(main!.planned.find((p) => p.source === 'address')!.shape).toBe('columns');
    expect(main!.planned.find((p) => p.source === 'items')!.shape).toBe('child');
    expect(items).toMatchObject({
      name: 'people_items',
      source: 'people.items',
      arrayPath: ['items'],
      parentKey: 'people_id',
      position: 'position',
      primaryKey: ['people_id', 'position'],
      scalarElements: false,
    });
    expect(columns(items!)).toEqual({
      people_id: 'character(24)',
      position: 'integer',
      sku: 'text',
      qty: 'integer',
      note: 'text',
    });
  });

  it('follows the user: arrays as JSON or child tables, sub-documents whole, fields renamed or skipped', () => {
    const tables = flattenCollection(analysis, {
      collection: 'people',
      table: 'persons',
      dialect: 'mysql',
      overrides: [
        { source: 'items', shape: 'json' },
        { source: 'scores', shape: 'child', target: 'person_scores' },
        { source: 'address', shape: 'json' },
        { source: 'name', target: 'full_name', dataType: 'varchar(80)' },
        { source: 'tags', skip: true },
      ],
    });
    expect(tables.map((t) => t.name)).toEqual(['persons', 'person_scores']);
    expect(columns(tables[0]!)).toEqual({
      _id: 'char(24)',
      full_name: 'varchar(80)',
      age: 'bigint',
      address: 'json',
      items: 'json',
      mixed: 'json',
    });
    expect(tables[0]!.planned.find((p) => p.source === 'tags')).toMatchObject({ skipped: true });
    expect(tables[1]).toMatchObject({ scalarElements: true, parentKey: 'persons_id' });
    expect(columns(tables[1]!)).toEqual({ persons_id: 'char(24)', position: 'int', value: 'int' });
  });

  it('keys an empty collection on an ObjectId _id', () => {
    const [main] = flattenCollection(analyzeSchema([]), {
      collection: 'c',
      table: 'c',
      dialect: 'postgres',
    });
    expect(columns(main!)).toEqual({ _id: 'character(24)' });
  });
});

describe('sqlTypeForBson', () => {
  it.each([
    [['int'], 'integer', 'int'],
    [['int', 'long'], 'bigint', 'bigint'],
    [['int', 'double'], 'double precision', 'double'],
    [['decimal', 'int'], 'numeric', 'decimal(65,30)'],
    [['bool'], 'boolean', 'tinyint(1)'],
    [['date'], 'timestamp(3) with time zone', 'datetime(3)'],
    [['objectId'], 'character(24)', 'char(24)'],
    [['uuid'], 'uuid', 'char(36)'],
    [['binData'], 'bytea', 'longblob'],
    [['string'], 'text', 'longtext'],
    [['object'], 'jsonb', 'json'],
    [['string', 'int'], 'text', 'longtext'],
    [[], 'text', 'longtext'],
  ] as const)('%j → %s / %s', (types, pg, mysql) => {
    expect(sqlTypeForBson(types, 'postgres').dataType).toBe(pg);
    expect(sqlTypeForBson(types, 'mysql').dataType).toBe(mysql);
  });

  it('shortens string keys for MySQL', () => {
    expect(sqlTypeForBson(['string'], 'mysql', { key: true }).dataType).toBe('varchar(255)');
  });
});

describe('bsonCell', () => {
  it('turns BSON values into cells the SQL converters take', () => {
    expect(bsonCell(new Int32(5), false)).toBe(5);
    expect(bsonCell(new Double(1.5), false)).toBe(1.5);
    expect(bsonCell(Long.fromString('9007199254740993'), false)).toBe(9007199254740993n);
    expect(bsonCell(Long.fromNumber(42), false)).toBe(42);
    expect(bsonCell(Decimal128.fromString('12.50'), false)).toBe('12.50');
    expect(bsonCell(new Date('2024-01-02T03:04:05.123Z'), false)).toBe('2024-01-02T03:04:05.123Z');
    expect(bsonCell(id, false)).toBe('65a1b2c3d4e5f60718293a4b');
    expect(bsonCell(new UUID('0b5e4b9c-6f1e-4c8e-9d7a-2a1c3e4f5a6b'), false)).toBe(
      '0b5e4b9c-6f1e-4c8e-9d7a-2a1c3e4f5a6b',
    );
    expect(bsonCell(new Binary(Uint8Array.from([1, 255])), false)).toBe('\\x01ff');
    expect(bsonCell(null, false)).toBeNull();
    expect(bsonCell(undefined, false)).toBeNull();
    expect(bsonCell(true, false)).toBe(true);
  });

  it('keeps documents, arrays and exotic types as relaxed Extended JSON', () => {
    const doc = bsonCell({ a: new Int32(1), when: new Date('2024-01-01T00:00:00Z') }, false);
    expect(isJsonText(doc) && JSON.parse(doc.$json)).toEqual({
      a: 1,
      when: { $date: '2024-01-01T00:00:00Z' },
    });
    const array = bsonCell([1, 'x'], true);
    expect(isJsonText(array) && array.$json).toBe('[1,"x"]');
    expect(bsonCell('text', true)).toEqual({ $json: '"text"' });
    expect(bsonCell(new Timestamp({ t: 1, i: 2 }), false)).toBe('{"$timestamp":{"t":1,"i":2}}');
    expect(() => bsonCell(new Date(Number.NaN), false)).toThrow(/invalid date/);
  });

  it('reads values at a path, and nothing through non-documents', () => {
    const doc = { a: { b: { c: 1 } }, s: 'x' };
    expect(valueAtPath(doc, ['a', 'b', 'c'])).toBe(1);
    expect(valueAtPath(doc, ['s', 'length'])).toBeUndefined();
    expect(valueAtPath(doc, ['missing'])).toBeUndefined();
    expect(valueAtPath('scalar', [])).toBe('scalar');
  });
});

describe('SQL → BSON', () => {
  it('picks a BSON type per SQL type', () => {
    expect(mongoFieldType('integer', 'postgres')).toBe('int');
    expect(mongoFieldType('bigint', 'postgres')).toBe('long');
    expect(mongoFieldType('int unsigned', 'mysql')).toBe('long');
    expect(mongoFieldType('bigint unsigned', 'mysql')).toBe('decimal');
    expect(mongoFieldType('numeric(10,2)', 'postgres')).toBe('decimal');
    expect(mongoFieldType('double precision', 'postgres')).toBe('double');
    expect(mongoFieldType('tinyint(1)', 'mysql')).toBe('bool');
    expect(mongoFieldType('bit(1)', 'mariadb')).toBe('bool');
    expect(mongoFieldType('timestamp with time zone', 'postgres')).toBe('date');
    expect(mongoFieldType('date', 'mysql')).toBe('date');
    expect(mongoFieldType('time', 'mysql')).toBe('string');
    expect(mongoFieldType('jsonb', 'postgres')).toBe('json');
    expect(mongoFieldType('text[]', 'postgres')).toBe('json');
    expect(mongoFieldType('bytea', 'postgres')).toBe('binData');
    expect(mongoFieldType('uuid', 'postgres')).toBe('uuid');
    expect(mongoFieldType('varchar(10)', 'mysql')).toBe('string');
    expect(mongoFieldType('geometry', 'mysql')).toBe('string');
  });

  it('writes typed values', () => {
    expect(toBsonValue(5, 'int')).toEqual(new Int32(5));
    expect(toBsonValue(3_000_000_000, 'int')).toEqual(Long.fromNumber(3_000_000_000));
    expect(toBsonValue(9007199254740993n, 'long')).toEqual(Long.fromString('9007199254740993'));
    expect(() => toBsonValue(18446744073709551615n, 'long')).toThrow(/64-bit/);
    expect(toBsonValue('12.50', 'decimal')).toEqual(Decimal128.fromString('12.50'));
    expect(toBsonValue('0.1', 'double')).toBe(0.1);
    expect(toBsonValue(1, 'bool')).toBe(true);
    expect(toBsonValue('f', 'bool')).toBe(false);
    expect(toBsonValue(Uint8Array.from([1, 2]), 'binData')).toEqual(
      new Binary(Uint8Array.from([1, 2])),
    );
    expect(toBsonValue('0b5e4b9c-6f1e-4c8e-9d7a-2a1c3e4f5a6b', 'uuid')).toEqual(
      new UUID('0b5e4b9c-6f1e-4c8e-9d7a-2a1c3e4f5a6b'),
    );
    expect(toBsonValue('65a1b2c3d4e5f60718293a4b', 'objectId')).toEqual(id);
    expect(toBsonValue('{"a": [1, {"b": null}]}', 'json')).toEqual({ a: [1, { b: null }] });
    expect(toBsonValue(9, 'string')).toBe('9');
    expect(toBsonValue(null, 'int')).toBeNull();
    expect(() => toBsonValue('abc', 'int')).toThrow(/integer/);
    expect(() => toBsonValue('nope', 'uuid')).toThrow(/UUID/);
    expect(() => toBsonValue('{', 'json')).toThrow(/JSON/);
  });

  it('reads SQL dates and times (in UTC) as dates', () => {
    expect(toBsonValue('2024-02-29', 'date')).toEqual(new Date('2024-02-29T00:00:00Z'));
    expect(toBsonValue('2024-01-02 03:04:05.123', 'date')).toEqual(
      new Date('2024-01-02T03:04:05.123Z'),
    );
    expect(toBsonValue('2024-01-02 03:04:05.5+00', 'date')).toEqual(
      new Date('2024-01-02T03:04:05.500Z'),
    );
    expect(toBsonValue('2024-01-02 03:04:05+05:30', 'date')).toEqual(
      new Date('2024-01-01T21:34:05Z'),
    );
    expect(toBsonValue('0000-00-00 00:00:00', 'date')).toBeNull();
    expect(() => toBsonValue('not a date', 'date')).toThrow(/not a date/);
  });
});
