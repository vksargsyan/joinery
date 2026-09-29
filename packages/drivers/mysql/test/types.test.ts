import type { FieldPacket } from 'mysql2';
import { describe, expect, it } from 'vitest';

import { toMysqlParams } from '../src/session';
import {
  bitsToInteger,
  columnMeta,
  describeField,
  float32Value,
  mysqlTypeCast,
  toCellValue,
} from '../src/types';

type FieldInput = Omit<Partial<FieldPacket>, 'constructor'>;

function field(columnType: number, extra: FieldInput = {}): FieldPacket {
  return {
    name: 'c',
    orgName: 'c',
    table: '',
    orgTable: '',
    catalog: 'def',
    decimals: 0,
    flags: 0,
    columnType,
    characterSet: 224,
    encoding: 'utf8',
    columnLength: 0,
    ...extra,
  } as unknown as FieldPacket;
}

describe('toCellValue', () => {
  it('turns BIGINT text into number or bigint', () => {
    expect(toCellValue('LONGLONG', '42')).toBe(42);
    expect(toCellValue('LONGLONG', '18446744073709551615')).toBe(18446744073709551615n);
    expect(toCellValue('LONGLONG', -5)).toBe(-5);
  });

  it('turns BIT bytes into integers and other bytes into standalone Uint8Arrays', () => {
    expect(toCellValue('BIT', Buffer.from([0x02, 0x01]))).toBe(513);
    const pool = Buffer.from([9, 8, 7, 6]);
    const bytes = toCellValue('BLOB', pool.subarray(1, 3));
    expect(bytes).toEqual(new Uint8Array([8, 7]));
    expect(Buffer.isBuffer(bytes)).toBe(false);
  });

  it('keeps text, numbers and null as they are', () => {
    expect(toCellValue('NEWDECIMAL', '1.50')).toBe('1.50');
    expect(toCellValue('DATETIME', '2024-02-29 13:14:15')).toBe('2024-02-29 13:14:15');
    expect(toCellValue('TINY', 1)).toBe(1);
    expect(toCellValue('JSON', '{"a":1}')).toBe('{"a":1}');
    expect(toCellValue('VAR_STRING', null)).toBeNull();
  });

  it('reads FLOAT as the shortest decimal of its single-precision value, whatever the protocol', () => {
    // Binary protocol: the double expansion of the 4-byte value.
    expect(toCellValue('FLOAT', 0.10000000149011612)).toBe(0.1);
    expect(toCellValue('FLOAT', -0.30000001192092896)).toBe(-0.3);
    expect(toCellValue('FLOAT', 33.29999923706055)).toBe(33.3);
    expect(toCellValue('FLOAT', 1.2345677614212036)).toBe(1.2345678);
    // Text protocol: the server's own (six-digit) text, which stays as it is.
    expect(toCellValue('FLOAT', 0.1)).toBe(0.1);
    expect(toCellValue('FLOAT', 1.23457)).toBe(1.23457);
    expect(toCellValue('FLOAT', 16777200)).toBe(16777200);
    expect(toCellValue('FLOAT', 3.4e38)).toBe(3.4e38);
    // DOUBLE is already exact.
    expect(toCellValue('DOUBLE', 0.10000000149011612)).toBe(0.10000000149011612);
  });

  it('finds the shortest round-trip decimal across the float32 range', () => {
    expect(float32Value(16777217)).toBe(16777216);
    expect(float32Value(3.4028234663852886e38)).toBe(3.4028235e38);
    expect(float32Value(1.401298464324817e-45)).toBe(1e-45);
    expect(float32Value(1.1754943508222875e-38)).toBe(1.1754944e-38);
    expect(float32Value(0)).toBe(0);
    expect(float32Value(Number.NaN)).toBeNaN();
    expect(float32Value(Infinity)).toBe(Infinity);
    for (let i = 0; i < 2000; i++) {
      const bits = new Uint32Array([(Math.random() * 0xffffffff) >>> 0]);
      const single = new Float32Array(bits.buffer)[0]!;
      if (!Number.isFinite(single)) continue;
      const value = float32Value(single);
      expect(Math.fround(value)).toBe(single);
      const digits = String(value)
        .replace(/^-|e.*$|\./g, '')
        .replace(/^0+|0+$/g, '');
      expect(digits.length).toBeLessThanOrEqual(9);
    }
  });

  it('reads BIT(64) values beyond 2^53 as bigint', () => {
    expect(bitsToInteger(new Uint8Array([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]))).toBe(
      18446744073709551615n,
    );
  });

  it('takes raw bytes for GEOMETRY in the type cast', () => {
    const cast = mysqlTypeCast as (field: unknown, next: () => unknown) => unknown;
    const geometry = {
      type: 'GEOMETRY',
      buffer: () => Buffer.from([0, 0, 0, 0, 1]),
    };
    expect(cast(geometry, () => ({ x: 1, y: 2 }))).toEqual(new Uint8Array([0, 0, 0, 0, 1]));
    expect(cast({ type: 'LONGLONG' }, () => '7')).toBe(7);
  });
});

describe('describeField', () => {
  it.each([
    [field(1, { columnLength: 1 }), 'tinyint(1)', 'integer'],
    [field(3, { flags: 32 }), 'int unsigned', 'integer'],
    [field(8, { flags: 32 }), 'bigint unsigned', 'bigint'],
    [field(246, { columnLength: 12, decimals: 2 }), 'decimal(10,2)', 'decimal'],
    [field(246, { columnLength: 11, decimals: 2, flags: 32 }), 'decimal(10,2) unsigned', 'decimal'],
    [field(12, { decimals: 3 }), 'datetime(3)', 'datetime'],
    [field(7), 'timestamp', 'timestamp'],
    [field(10), 'date', 'date'],
    [field(253, { columnLength: 1020 }), 'varchar(255)', 'string'],
    [field(253, { columnLength: 60, characterSet: 33 }), 'varchar(20)', 'string'],
    [
      field(253, { columnLength: 20, characterSet: 8, encoding: 'latin1' }),
      'varchar(20)',
      'string',
    ],
    [
      field(253, { columnLength: 16, characterSet: 63, encoding: 'binary' }),
      'varbinary(16)',
      'binary',
    ],
    [field(254, { columnLength: 8, flags: 256 }), 'enum', 'enum'],
    [
      field(254, { columnLength: 12, characterSet: 63, encoding: 'binary' }),
      'binary(12)',
      'binary',
    ],
    [field(252, { columnLength: 262140 }), 'text', 'string'],
    [field(252, { columnLength: 4294967295 }), 'longtext', 'string'],
    [field(252, { columnLength: 65535, characterSet: 63, encoding: 'binary' }), 'blob', 'binary'],
    [field(245), 'json', 'json'],
    [field(16, { columnLength: 10 }), 'bit(10)', 'integer'],
    [field(255), 'geometry', 'geometry'],
    [field(254, { extendedTypeName: 'uuid' }), 'uuid', 'uuid'],
    [field(252, { extendedFormat: 'json' }), 'json', 'json'],
  ])('%#: %s', (input, nativeType, kind) => {
    expect(describeField(input)).toEqual({ nativeType, kind });
  });
});

describe('columnMeta', () => {
  it('fills the source table and nullability for table columns only', () => {
    expect(
      columnMeta(field(3, { name: 'id', orgTable: 'orders', schema: 'shop', flags: 1 })),
    ).toEqual({
      name: 'id',
      nativeType: 'int',
      kind: 'integer',
      table: 'orders',
      schema: 'shop',
      nullable: false,
    });
    expect(columnMeta(field(8, { name: 'n' }))).toEqual({
      name: 'n',
      nativeType: 'bigint',
      kind: 'bigint',
    });
  });
});

describe('toMysqlParams', () => {
  it('sends bigint as text and bytes as a Buffer', () => {
    const params = toMysqlParams(['a', 1, 2n, false, null, new Uint8Array([7])]);
    expect(params.slice(0, 5)).toEqual(['a', 1, '2', false, null]);
    expect(Buffer.isBuffer(params[5])).toBe(true);
  });
});
