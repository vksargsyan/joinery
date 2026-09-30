import { describe, expect, it } from 'vitest';

import { converterFor, globMatch, isSafeDataType, safeColumnName } from '../src';
import { UniqueNames, fitIdentifier } from '../src/db/names';
import { hexText, sqlCellAdapter } from '../src/db/values';

/** Cell adapters between SQL engines, identifier rules and Redis glob matching. */

describe('sqlCellAdapter', () => {
  it('sends bytes as \\x hex, which the binary converter reads back', () => {
    const adapt = sqlCellAdapter('postgres', 'bytea', 'mysql', 'longblob');
    const cell = adapt(Uint8Array.from([0xde, 0xad, 0, 0xff]));
    expect(cell).toBe('\\xdead00ff');
    expect(converterFor({ name: 'b', dataType: 'longblob' }, 'mysql')(cell)).toEqual(
      Uint8Array.from([0xde, 0xad, 0, 0xff]),
    );
    expect(adapt(new Uint8Array())).toBe('\\x');
  });

  it('encodes text going into a binary column as its UTF-8 bytes', () => {
    const adapt = sqlCellAdapter('mysql', 'text', 'postgres', 'bytea');
    const cell = adapt('abcd');
    // Plain text is never mistaken for base64.
    expect(converterFor({ name: 'b', dataType: 'bytea' }, 'postgres')(cell)).toEqual(
      new TextEncoder().encode('abcd'),
    );
  });

  it('reads any non-zero integer as true for a boolean column', () => {
    const adapt = sqlCellAdapter('mysql', 'tinyint(1)', 'postgres', 'boolean');
    expect([adapt(0), adapt(1), adapt(5), adapt(0n), adapt(-1n), adapt(null)]).toEqual([
      false,
      true,
      true,
      false,
      true,
      null,
    ]);
  });

  it("turns MySQL's zero dates into NULL for PostgreSQL only", () => {
    expect(sqlCellAdapter('mysql', 'date', 'postgres', 'date')('0000-00-00')).toBeNull();
    expect(
      sqlCellAdapter(
        'mariadb',
        'datetime',
        'postgres',
        'timestamp without time zone',
      )('0000-00-00 00:00:00'),
    ).toBeNull();
    expect(sqlCellAdapter('mysql', 'date', 'mariadb', 'date')('0000-00-00')).toBe('0000-00-00');
    expect(sqlCellAdapter('mysql', 'date', 'postgres', 'date')('2024-02-29')).toBe('2024-02-29');
  });

  it("drops a PostgreSQL time's offset for MySQL", () => {
    const adapt = sqlCellAdapter('postgres', 'time with time zone', 'mysql', 'time(6)');
    expect(adapt('10:11:12+02')).toBe('10:11:12');
    expect(adapt('10:11:12.5-05:30')).toBe('10:11:12.5');
  });

  it('passes everything else through, and refuses a preview handle', () => {
    const adapt = sqlCellAdapter('postgres', 'text', 'mysql', 'longtext');
    expect([adapt('x'), adapt(1.5), adapt(9007199254740993n), adapt(true)]).toEqual([
      'x',
      1.5,
      9007199254740993n,
      true,
    ]);
    expect(() => adapt({ $handle: 'h', preview: '', byteLength: 10, kind: 'text' })).toThrow(
      /previewed/,
    );
  });

  it('writes hex for every byte value', () => {
    expect(hexText(Uint8Array.from([0, 1, 15, 16, 255]))).toBe('\\x00010f10ff');
  });
});

describe('names', () => {
  it('makes safe column names from MongoDB field paths', () => {
    expect(safeColumnName('address.city', 'postgres')).toBe('address_city');
    expect(safeColumnName('items[].sku', 'mysql')).toBe('items_sku');
    expect(safeColumnName('$weird key!', 'postgres')).toBe('_weird_key_');
    expect(safeColumnName('_id', 'postgres')).toBe('_id');
    expect(safeColumnName('Grüße', 'postgres')).toBe('Grüße');
    expect(safeColumnName('...', 'postgres')).toBe('field');
    expect(safeColumnName('x'.repeat(100), 'mysql')).toHaveLength(64);
  });

  it('cuts PostgreSQL names by bytes and never splits a character', () => {
    const name = fitIdentifier('é'.repeat(40), 'postgres');
    expect(Buffer.byteLength(name, 'utf8')).toBeLessThanOrEqual(63);
    expect(name).toBe('é'.repeat(31));
  });

  it('hands out unique names, case-insensitively, within the length limit', () => {
    const names = new UniqueNames('mysql', ['Taken']);
    expect(names.claim('taken')).toBe('taken_2');
    expect(names.claim('taken')).toBe('taken_3');
    const long = 'y'.repeat(64);
    expect(names.claim(long)).toBe(long);
    expect(names.claim(long)).toBe(`${'y'.repeat(62)}_2`);
  });

  it('accepts column types and nothing that could reach DDL otherwise', () => {
    for (const ok of [
      'varchar(255)',
      'numeric(10,2)',
      'timestamp(3) with time zone',
      'int unsigned',
      'text[]',
      'public.mood',
      "enum('a','b''c')",
      "set('x', 'y')",
    ]) {
      expect(isSafeDataType(ok)).toBe(true);
    }
    for (const bad of [
      '',
      'int; DROP TABLE x',
      'varchar(1), evil int',
      "enum('a'), evil int, e enum('b')",
      'int -- comment',
      'int /* x */',
      'x'.repeat(201),
    ]) {
      expect(isSafeDataType(bad)).toBe(false);
    }
  });
});

describe('globMatch', () => {
  it.each([
    ['*', 'anything', true],
    ['user:*', 'user:1', true],
    ['user:*', 'order:1', false],
    ['h?llo', 'hello', true],
    ['h?llo', 'hllo', false],
    ['h[ae]llo', 'hallo', true],
    ['h[^e]llo', 'hello', false],
    ['h[a-c]llo', 'hbllo', true],
    ['h[a-c]llo', 'hdllo', false],
    ['a\\*b', 'a*b', true],
    ['a\\*b', 'axb', false],
    ['*:*:end', 'a:b:end', true],
    ['**x', 'yyx', true],
    ['', '', true],
  ])('%s matches %s: %s', (pattern, key, expected) => {
    expect(globMatch(pattern, key)).toBe(expected);
  });

  it('matches bytes that are not UTF-8', () => {
    expect(globMatch('k:*', Uint8Array.from([0x6b, 0x3a, 0xff, 0x00]))).toBe(true);
  });
});
