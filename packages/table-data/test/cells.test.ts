import { tableDefSchema, type CellValue, type SqlDialect } from '@joinery/core';
import { describe, expect, it } from 'vitest';

import {
  DEFAULT,
  describeColumns,
  formatCell,
  integerBounds,
  parseCellInput,
  type ColumnInfo,
} from '../src';

function column(
  dialect: SqlDialect,
  dataType: string,
  extra: Record<string, unknown> = {},
): ColumnInfo {
  const table = tableDefSchema.parse({
    name: 't',
    columns: [{ name: 'c', ordinal: 1, dataType, nullable: true, ...extra }],
  });
  return describeColumns(table, { dialect })[0]!;
}

type Case = [SqlDialect, string, string, CellValue | { error: RegExp }];

const cases: Case[] = [
  // integers and their bounds
  ['postgres', 'integer', '42', 42],
  ['postgres', 'integer', ' -7 ', -7],
  ['postgres', 'integer', '2147483648', { error: /between -2147483648 and 2147483647/ }],
  ['postgres', 'smallint', '40000', { error: /between -32768 and 32767/ }],
  ['postgres', 'bigint', '9007199254740993', 9007199254740993n],
  ['postgres', 'bigint', '9007199254740991', 9007199254740991],
  ['postgres', 'bigint', '9223372036854775808', { error: /between/ }],
  ['postgres', 'integer', '1.5', { error: /^Expected a whole number$/ }],
  ['mysql', 'tinyint unsigned', '255', 255],
  ['mysql', 'tinyint unsigned', '-1', { error: /between 0 and 255/ }],
  ['mysql', 'mediumint', '8388608', { error: /between -8388608 and 8388607/ }],
  ['mysql', 'bigint unsigned', '18446744073709551615', 18446744073709551615n],
  ['mysql', 'bit(4)', '15', 15],
  ['mysql', 'bit(4)', '16', { error: /between 0 and 15/ }],
  ['mysql', 'year', '2026', 2026],
  ['mysql', 'year', '1800', { error: /year from 1901/ }],
  // booleans
  ['postgres', 'boolean', 'yes', true],
  ['postgres', 'boolean', 'F', false],
  ['postgres', 'boolean', 'maybe', { error: /Expected true or false/ }],
  ['mysql', 'tinyint(1)', 'true', 1],
  ['mysql', 'tinyint(1)', 'off', 0],
  ['mysql', 'tinyint(1)', '5', 5],
  ['mysql', 'bit(1)', 'true', 1],
  // decimals
  ['postgres', 'numeric(10,2)', '1.5', '1.50'],
  ['postgres', 'numeric(10,2)', '-0012.345e1', '-123.45'],
  ['postgres', 'numeric(10,2)', '1.234', { error: /At most 2 digits after the decimal point/ }],
  ['postgres', 'numeric(5,2)', '1234', { error: /At most 3 digits before the decimal point/ }],
  ['postgres', 'numeric(5,2)', '1.500', '1.50'],
  ['postgres', 'numeric', '0.000100', '0.000100'],
  ['postgres', 'numeric', 'NaN', 'NaN'],
  ['postgres', 'numeric', '12345678901234567890.123456789', '12345678901234567890.123456789'],
  ['mysql', 'decimal(10,0)', '7.0', '7'],
  ['mysql', 'decimal(10,2) unsigned', '-1', { error: /negative/ }],
  ['mysql', 'decimal(10,2)', 'NaN', { error: /cannot be NaN/ }],
  ['mysql', 'decimal(10,2)', '1,5', { error: /Expected a number like 1234.56/ }],
  // floats
  ['postgres', 'double precision', '3.14', 3.14],
  ['postgres', 'double precision', '-Infinity', -Infinity],
  ['postgres', 'real', '1e39', { error: /out of range/ }],
  ['mysql', 'double', 'NaN', { error: /cannot store NaN/ }],
  ['mysql', 'float', '.5', 0.5],
  // dates and times
  ['postgres', 'date', '2026-9-29', '2026-09-29'],
  ['postgres', 'date', '2024-02-29', '2024-02-29'],
  ['postgres', 'date', '2026-02-29', { error: /2026-02-29 is not a valid date/ }],
  ['postgres', 'date', '29/09/2026', { error: /^Expected a date like 2026-09-29$/ }],
  ['postgres', 'date', 'infinity', 'infinity'],
  ['postgres', 'date', '0044-03-15 BC', '0044-03-15 BC'],
  ['mysql', 'date', '0999-01-01', { error: /between 1000 and 9999/ }],
  ['postgres', 'time without time zone', '9:5', '09:05:00'],
  ['postgres', 'time without time zone', '24:00:00', '24:00:00'],
  ['postgres', 'time without time zone', '25:00', { error: /Expected a time like 14:30:00/ }],
  ['postgres', 'time with time zone', '14:30:00+02', '14:30:00+02'],
  ['postgres', 'time with time zone', '14:30Z', '14:30:00+00'],
  ['mysql', 'time(3)', '-838:59:59', '-838:59:59'],
  ['mysql', 'time', '839:00:00', { error: /Expected a time/ }],
  ['postgres', 'timestamp without time zone', '2026-09-29T14:30', '2026-09-29 14:30:00'],
  ['postgres', 'timestamp without time zone', '2026-09-29', '2026-09-29 00:00:00'],
  ['postgres', 'timestamp without time zone', '2026-09-29 14:30:00+02', { error: /no time zone/ }],
  [
    'postgres',
    'timestamp with time zone',
    '2026-09-29 14:30:00.123456-05:30',
    '2026-09-29 14:30:00.123456-05:30',
  ],
  ['postgres', 'timestamp with time zone', '2026-09-29 14:30:00Z', '2026-09-29 14:30:00+00'],
  [
    'postgres',
    'timestamp with time zone',
    'yesterday',
    { error: /Expected a date and time like 2026-09-29 14:30:00\+02/ },
  ],
  ['mysql', 'datetime(6)', '2026-09-29 14:30:00.5', '2026-09-29 14:30:00.5'],
  ['mysql', 'datetime', '2026-09-29 24:00:00', { error: /Expected a date and time/ }],
  [
    'mysql',
    'timestamp',
    '2040-01-01 00:00:00',
    { error: /TIMESTAMP must be between 1970-01-01 and 2038-01-19/ },
  ],
  ['mariadb', 'timestamp', '2026-09-29 10:00:00+02:00', { error: /offset/ }],
  // intervals
  ['postgres', 'interval', '1 day 02:00:00', '1 day 02:00:00'],
  ['postgres', 'interval', '3 hours ago', '3 hours ago'],
  ['postgres', 'interval', 'P1Y2M3DT4H', 'P1Y2M3DT4H'],
  ['postgres', 'interval', '1-2', '1-2'],
  ['postgres', 'interval', '5 fortnights', { error: /Expected an interval/ }],
  // JSON, UUID, binary
  ['postgres', 'jsonb', '{"a": [1, 2]}', '{"a": [1, 2]}'],
  ['postgres', 'jsonb', '{a: 1}', { error: /^Invalid JSON/ }],
  [
    'postgres',
    'uuid',
    '{123E4567E89B12D3A456426614174000}',
    '123e4567-e89b-12d3-a456-426614174000',
  ],
  ['postgres', 'uuid', '123', { error: /Expected a UUID/ }],
  ['postgres', 'bytea', '\\x48656c6c6f', new Uint8Array([0x48, 0x65, 0x6c, 0x6c, 0x6f])],
  ['mysql', 'varbinary(2)', '0xCAFE', new Uint8Array([0xca, 0xfe])],
  ['mysql', 'varbinary(2)', '0xCAFEBA', { error: /At most 2 bytes/ }],
  ['mysql', 'blob', "X'01'", new Uint8Array([1])],
  ['mysql', 'blob', '0x1', { error: /Expected hex bytes/ }],
  // enums, sets, arrays
  ['mysql', "enum('sad','ok','happy')", 'OK', 'ok'],
  ['mysql', "enum('sad','ok','happy')", 'meh', { error: /Expected one of: sad, ok, happy/ }],
  ['mysql', "set('a','b','c')", 'c, a,a', 'a,c'],
  ['mysql', "set('a','b','c')", '', ''],
  ['mysql', "set('a','b','c')", 'd', { error: /"d" is not one of/ }],
  ['postgres', 'integer[]', '{1, 2 ,NULL}', '{1,2,NULL}'],
  ['postgres', 'integer[]', '[1, 2, null]', '{1,2,NULL}'],
  ['postgres', 'integer[]', '{1,x}', { error: /Element 2: Expected a whole number/ }],
  ['postgres', 'text[]', '{"a b","q\\"x",null,""}', '{"a b","q\\"x",NULL,""}'],
  ['postgres', 'text[]', '["NULL", "{"]', '{"NULL","{"}'],
  ['postgres', 'boolean[]', '{true,no}', '{t,f}'],
  ['postgres', 'integer[][]', '{{1,2},{3,4}}', '{{1,2},{3,4}}'],
  ['postgres', 'integer[]', '{1,2', { error: /Missing "}"/ }],
  // strings
  ['postgres', 'character varying(3)', 'abc', 'abc'],
  ['postgres', 'character varying(3)', 'abcd', { error: /At most 3 characters/ }],
  ['mysql', 'varchar(2)', '😀😀', '😀😀'],
  ['postgres', 'text', '  keep spaces  ', '  keep spaces  '],
  ['postgres', 'bit(4)', '0101', '0101'],
  ['postgres', 'bit(4)', '01', { error: /exactly 4 bits/ }],
  ['postgres', 'bit varying(4)', '012', { error: /Expected bits/ }],
];

describe('parseCellInput', () => {
  for (const [dialect, type, input, expected] of cases) {
    const title = `${dialect} ${type}: ${JSON.stringify(input)}`;
    it(title, () => {
      const result = parseCellInput(input, column(dialect, type));
      if (expected !== null && typeof expected === 'object' && 'error' in expected) {
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error).toMatch(expected.error);
      } else {
        expect(result).toEqual({ ok: true, value: expected });
      }
    });
  }

  it('treats empty input as empty text for text columns and NULL otherwise', () => {
    expect(parseCellInput('', column('postgres', 'text'))).toEqual({ ok: true, value: '' });
    expect(parseCellInput('', column('postgres', 'text'), { emptyIsNull: true })).toEqual({
      ok: true,
      value: null,
    });
    expect(parseCellInput(' ', column('postgres', 'integer'))).toEqual({ ok: true, value: null });
    expect(parseCellInput('', column('postgres', 'integer', { nullable: false }))).toMatchObject({
      ok: false,
      error: expect.stringMatching(/cannot be NULL/),
    });
    expect(parseCellInput('NULL', column('postgres', 'text'), { nullText: 'NULL' })).toEqual({
      ok: true,
      value: null,
    });
    expect(parseCellInput('NULL', column('postgres', 'text'))).toEqual({ ok: true, value: 'NULL' });
  });

  it('refuses read-only columns', () => {
    const generated = column('postgres', 'integer', {
      generated: { expression: 'a + 1', stored: true },
    });
    expect(parseCellInput('1', generated)).toEqual({
      ok: false,
      error: 'The column is generated by the server',
    });
  });

  it('round-trips formatted values', () => {
    const values: [string, CellValue][] = [
      ['integer', -5],
      ['bigint', 9007199254740993n],
      ['numeric(10,2)', '12.30'],
      ['double precision', 0.1],
      ['double precision', -0],
      ['boolean', false],
      ['bytea', new Uint8Array([0, 255])],
      ['date', '2026-09-29'],
      ['jsonb', '{"a":1}'],
      ['text[]', '{"a b",c}'],
    ];
    for (const [type, value] of values) {
      const info = column('postgres', type);
      expect(parseCellInput(formatCell(value, info), info)).toEqual({ ok: true, value });
    }
  });
});

describe('formatCell', () => {
  it('formats each representation as editable text', () => {
    expect(formatCell(null)).toBe('');
    expect(formatCell(DEFAULT)).toBe('');
    expect(formatCell(true)).toBe('true');
    expect(formatCell(12345678901234567890n)).toBe('12345678901234567890');
    expect(formatCell(new Uint8Array([1, 171]))).toBe('0x01ab');
    expect(formatCell({ $handle: 'h', preview: 'long…', byteLength: 9, kind: 'text' })).toBe(
      'long…',
    );
  });

  it('knows integer bounds', () => {
    expect(integerBounds(column('mysql', 'int unsigned'))).toEqual([0n, 4294967295n]);
    expect(integerBounds(column('postgres', 'oid'))).toEqual([0n, 4294967295n]);
  });
});
