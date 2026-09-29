import type { FieldDef } from 'pg';
import { describe, expect, it } from 'vitest';

import { parseCommandTag, toPgValues } from '../src/session';
import {
  columnMeta,
  kindForCategory,
  parseBytea,
  pgTypeParsers,
  type RelationInfo,
  type TypeInfo,
} from '../src/types';

const parse = (oid: number, text: string): unknown =>
  (pgTypeParsers.getTypeParser as unknown as (oid: number) => (text: string) => unknown)(oid)(text);

function field(dataTypeID: number, dataTypeModifier = -1, tableID = 0, columnID = 0): FieldDef {
  return {
    name: 'c',
    tableID,
    columnID,
    dataTypeID,
    dataTypeSize: -1,
    dataTypeModifier,
    format: 'text',
  };
}

describe('value parsing', () => {
  it('maps integers, floats and booleans onto JS values', () => {
    expect(parse(23, '-42')).toBe(-42);
    expect(parse(21, '7')).toBe(7);
    expect(parse(26, '4294967295')).toBe(4294967295);
    expect(parse(20, '9007199254740991')).toBe(9007199254740991);
    expect(parse(20, '9223372036854775807')).toBe(9223372036854775807n);
    expect(parse(20, '-9223372036854775808')).toBe(-9223372036854775808n);
    expect(parse(701, '1.5')).toBe(1.5);
    expect(parse(701, 'NaN')).toBeNaN();
    expect(parse(700, '-Infinity')).toBe(-Infinity);
    expect(parse(16, 't')).toBe(true);
    expect(parse(16, 'f')).toBe(false);
  });

  it('keeps decimals, dates, times, JSON and arrays as server text', () => {
    for (const [oid, text] of [
      [1700, '12345678901234567890.000001'],
      [1082, '2024-02-29'],
      [1114, '2024-02-29 13:14:15.123456'],
      [1184, '2024-02-29 13:14:15+01'],
      [1186, '1 day 02:00:00'],
      [3802, '{"a": 1}'],
      [1007, '{1,2,3}'],
      [2950, 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11'],
      [99999, 'custom type text'],
    ] as const) {
      expect(parse(oid, text)).toBe(text);
    }
  });

  it('decodes bytea in hex and escape format into standalone Uint8Arrays', () => {
    const hex = parseBytea('\\x00ff10');
    expect(hex).toEqual(new Uint8Array([0, 255, 16]));
    expect(Buffer.isBuffer(hex)).toBe(false);
    expect(parseBytea('a\\\\b\\001')).toEqual(new Uint8Array([97, 92, 98, 1]));
    expect(parse(17, '\\x')).toEqual(new Uint8Array([]));
  });
});

describe('column metadata', () => {
  const types = new Map<number, TypeInfo>([[70000, { name: 'mood', kind: 'enum' }]]);
  const relations = new Map<number, RelationInfo>([
    [16400, { schema: 'public', table: 'orders', notNull: new Set([1]) }],
  ]);

  it('names built-in types with their modifiers', () => {
    expect(columnMeta(field(1043, 259), types, relations)).toMatchObject({
      nativeType: 'varchar(255)',
      kind: 'string',
    });
    expect(columnMeta(field(1700, ((10 << 16) | 2) + 4), types, relations)).toMatchObject({
      nativeType: 'numeric(10,2)',
      kind: 'decimal',
    });
    expect(columnMeta(field(1184, 3), types, relations)).toMatchObject({
      nativeType: 'timestamptz(3)',
      kind: 'timestamp',
    });
    expect(columnMeta(field(1114), types, relations)).toMatchObject({
      nativeType: 'timestamp',
      kind: 'datetime',
    });
    expect(columnMeta(field(20), types, relations)).toMatchObject({
      nativeType: 'int8',
      kind: 'bigint',
    });
    expect(columnMeta(field(1015, 24), types, relations)).toMatchObject({
      nativeType: 'varchar(20)[]',
      kind: 'array',
    });
  });

  it('uses looked-up names for other types and degrades to unknown', () => {
    expect(columnMeta(field(70000), types, relations)).toMatchObject({
      nativeType: 'mood',
      kind: 'enum',
    });
    expect(columnMeta(field(70001), types, relations)).toMatchObject({
      nativeType: 'oid:70001',
      kind: 'unknown',
    });
  });

  it('fills table, schema and nullability from the relation lookup', () => {
    expect(columnMeta(field(23, -1, 16400, 1), types, relations)).toMatchObject({
      table: 'orders',
      schema: 'public',
      nullable: false,
    });
    expect(columnMeta(field(23, -1, 16400, 2), types, relations).nullable).toBe(true);
    expect(columnMeta(field(23), types, relations).table).toBeUndefined();
  });

  it('derives kinds from pg_type categories', () => {
    expect(kindForCategory('S', 'b', 'citext')).toBe('string');
    expect(kindForCategory('U', 'b', 'geometry')).toBe('geometry');
    expect(kindForCategory('E', 'e', 'mood')).toBe('enum');
    expect(kindForCategory('C', 'c', 'pair')).toBe('unknown');
    expect(kindForCategory('N', 'd', 'posint')).toBe('decimal');
  });
});

describe('statement helpers', () => {
  it('splits command tags into command and count', () => {
    expect(parseCommandTag('INSERT 0 5')).toEqual({ command: 'INSERT', count: 5 });
    expect(parseCommandTag('UPDATE 3')).toEqual({ command: 'UPDATE', count: 3 });
    expect(parseCommandTag('CREATE TABLE')).toEqual({ command: 'CREATE TABLE', count: null });
    expect(parseCommandTag('SELECT 0')).toEqual({ command: 'SELECT', count: 0 });
  });

  it('converts parameters for pg', () => {
    const values = toPgValues(['a', 1, 12n, true, null, new Uint8Array([1, 2])]);
    expect(values.slice(0, 5)).toEqual(['a', 1, '12', true, null]);
    expect(Buffer.isBuffer(values[5])).toBe(true);
    expect([...(values[5] as Buffer)]).toEqual([1, 2]);
  });
});
