import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

import type { CellValue, ColumnMeta } from '@joinery/core';
import { parquetMetadata, parquetSchema } from 'hyparquet';
import { describe, expect, it } from 'vitest';

import {
  bytesSource,
  exportRows,
  fileSource,
  exportTables,
  lz4Block,
  memorySink,
  openParquet,
  previewSource,
  readRows,
  sqlTypeFor,
  type ExportOptions,
  type ParquetCompression,
} from '../src';
import { FakeSession } from './fake-session';
import { col, readAll } from './xlsx-helpers';

async function exportParquet(
  columns: ColumnMeta[],
  rows: CellValue[][],
  options: Partial<ExportOptions> = {},
  engine: 'postgres' | 'mysql' = 'postgres',
): Promise<Uint8Array> {
  const session = new FakeSession(engine);
  session.result = { columns, rows };
  const sink = memorySink();
  const summary = await exportRows({
    session,
    query: 'SELECT * FROM t',
    format: 'parquet',
    sink,
    ...options,
  });
  expect(summary.errors).toEqual([]);
  expect(summary.status).toBe('completed');
  expect(summary.bytesWritten).toBe(sink.bytes().length);
  return sink.bytes();
}

function schemaOf(bytes: Uint8Array) {
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const metadata = parquetMetadata(buffer as ArrayBuffer);
  return { metadata, elements: parquetSchema(metadata).children.map((c) => c.element) };
}

/** PostgreSQL's types, as its driver describes result columns. */
const PG: ColumnMeta[] = [
  col('id', 'integer', 'int4'),
  col('big', 'bigint', 'int8'),
  col('price', 'decimal', 'numeric(10,2)'),
  col('wide', 'decimal', 'numeric(30,4)'),
  col('free', 'decimal', 'numeric'),
  col('ratio', 'float', 'float8'),
  col('single', 'float', 'float4'),
  col('ok', 'boolean', 'bool'),
  col('name', 'string', 'text'),
  col('day', 'date', 'date'),
  col('at', 'datetime', 'timestamp'),
  col('stamp', 'timestamp', 'timestamptz'),
  col('clock', 'time', 'time'),
  col('zoned', 'time', 'timetz'),
  col('span', 'interval', 'interval'),
  col('doc', 'json', 'jsonb'),
  col('key', 'uuid', 'uuid'),
  col('bin', 'binary', 'bytea'),
  col('tags', 'array', 'text[]'),
];

const PG_ROW: CellValue[] = [
  1,
  9007199254740993n,
  '12.50',
  '-12345678901234567890123456.0001',
  '3.14159265358979323846264338327950288',
  0.1,
  1.5,
  true,
  'plain',
  '2024-01-02',
  '2024-01-02 03:04:05.123456',
  '2024-01-02 03:04:05.5+02',
  '13:14:15.000001',
  '13:14:15+02',
  '1 year 2 mons',
  '{"a": [1, 2.50, 12345678901234567890]}',
  'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
  new Uint8Array([0xde, 0xad, 0xbe, 0xef]),
  '{x,"y z"}',
];

describe('Parquet export', () => {
  it('types columns from the result and keeps every value exact', async () => {
    const bytes = await exportParquet(PG, [PG_ROW, PG.map(() => null)]);
    const { elements, metadata } = schemaOf(bytes);
    expect(Number(metadata.num_rows)).toBe(2);
    const byName = Object.fromEntries(elements.map((e) => [e.name, e]));
    expect(byName['id']).toMatchObject({ type: 'INT32', repetition_type: 'OPTIONAL' });
    expect(byName['big']).toMatchObject({ type: 'INT64' });
    expect(byName['price']).toMatchObject({
      type: 'INT64',
      logical_type: { type: 'DECIMAL', precision: 10, scale: 2 },
    });
    expect(byName['wide']).toMatchObject({
      type: 'FIXED_LEN_BYTE_ARRAY',
      type_length: 13,
      logical_type: { type: 'DECIMAL', precision: 30, scale: 4 },
    });
    expect(byName['free']).toMatchObject({ type: 'BYTE_ARRAY', logical_type: { type: 'STRING' } });
    expect(byName['ratio']?.type).toBe('DOUBLE');
    expect(byName['single']?.type).toBe('FLOAT');
    expect(byName['day']).toMatchObject({ type: 'INT32', logical_type: { type: 'DATE' } });
    expect(byName['at']).toMatchObject({
      type: 'INT64',
      logical_type: { type: 'TIMESTAMP', isAdjustedToUTC: false, unit: 'MICROS' },
    });
    expect(byName['stamp']).toMatchObject({
      logical_type: { type: 'TIMESTAMP', isAdjustedToUTC: true, unit: 'MICROS' },
    });
    expect(byName['clock']).toMatchObject({
      logical_type: { type: 'TIME', isAdjustedToUTC: false, unit: 'MICROS' },
    });
    expect(byName['zoned']?.logical_type).toEqual({ type: 'STRING' });
    expect(byName['doc']).toMatchObject({
      type: 'BYTE_ARRAY',
      converted_type: 'JSON',
      logical_type: { type: 'JSON' },
    });
    expect(byName['key']).toMatchObject({ type: 'FIXED_LEN_BYTE_ARRAY', type_length: 16 });
    expect(byName['bin']).toEqual({ name: 'bin', type: 'BYTE_ARRAY', repetition_type: 'OPTIONAL' });

    const { columns, rows, lines } = await readAll(bytes, { format: 'parquet' });
    expect(columns).toEqual(PG.map((c) => c.name));
    expect(rows).toEqual([
      [
        1,
        9007199254740993n,
        '12.50',
        '-12345678901234567890123456.0001',
        '3.14159265358979323846264338327950288',
        0.1,
        1.5,
        true,
        'plain',
        '2024-01-02',
        '2024-01-02 03:04:05.123456',
        // Instants come back in UTC.
        '2024-01-02 01:04:05.5Z',
        '13:14:15.000001',
        '13:14:15+02',
        '1 year 2 mons',
        '{"a": [1, 2.50, 12345678901234567890]}',
        'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
        '\\xdeadbeef',
        '{x,"y z"}',
      ],
      PG.map(() => null),
    ]);
    expect(lines).toEqual([1, 2]);
  });

  it('maps MySQL types: unsigned integers, decimals, TIMESTAMP as wall-clock time, TIME as text', async () => {
    const columns = [
      col('tiny', 'integer', 'tinyint unsigned'),
      col('n', 'integer', 'int unsigned'),
      col('huge', 'bigint', 'bigint unsigned'),
      col('amount', 'decimal', 'decimal(5,2) unsigned'),
      col('f', 'float', 'float'),
      col('seen', 'timestamp', 'timestamp(3)'),
      col('kind', 'enum', 'enum'),
      col('elapsed', 'time', 'time'),
    ];
    const bytes = await exportParquet(
      columns,
      [
        [
          255,
          4294967295,
          18446744073709551615n,
          '999.99',
          0.5,
          '2024-06-01 10:00:00.250',
          'b',
          '-838:59:59',
        ],
      ],
      {},
      'mysql',
    );
    const byName = Object.fromEntries(schemaOf(bytes).elements.map((e) => [e.name, e]));
    expect(byName['tiny']?.type).toBe('INT32');
    expect(byName['n']?.type).toBe('INT64');
    expect(byName['huge']).toMatchObject({ type: 'INT64', converted_type: 'UINT_64' });
    expect(byName['amount']).toMatchObject({ type: 'INT32', precision: 5, scale: 2 });
    expect(byName['f']?.type).toBe('FLOAT');
    expect(byName['seen']?.logical_type).toMatchObject({ isAdjustedToUTC: false });
    expect(byName['elapsed']?.logical_type).toEqual({ type: 'STRING' });
    const { rows } = await readAll(bytes, { format: 'parquet' });
    expect(rows).toEqual([
      [
        255,
        4294967295,
        18446744073709551615n,
        '999.99',
        0.5,
        '2024-06-01 10:00:00.25',
        'b',
        '-838:59:59',
      ],
    ]);
  });

  it('writes BC dates and timestamps and far-future years', async () => {
    const bytes = await exportParquet(
      [col('d', 'date', 'date'), col('t', 'datetime', 'timestamp')],
      [
        ['0044-03-15 BC', '0044-03-15 12:30:00 BC'],
        ['0001-01-01', '1969-12-31 23:59:59.999999'],
        ['9999-12-31', '2262-04-12 00:00:00'],
        ['12345-06-07', '1900-02-28 00:00:00'],
      ],
    );
    expect((await readAll(bytes, { format: 'parquet' })).rows).toEqual([
      ['0044-03-15 BC', '0044-03-15 12:30:00 BC'],
      ['0001-01-01', '1969-12-31 23:59:59.999999'],
      ['9999-12-31', '2262-04-12 00:00:00'],
      ['12345-06-07', '1900-02-28 00:00:00'],
    ]);
  });

  it('fails with the column and row for a value the column type cannot hold', async () => {
    const session = new FakeSession('postgres');
    session.result = {
      columns: [col('id', 'integer', 'int4'), col('price', 'decimal', 'numeric(4,2)')],
      rows: [
        [1, '10.00'],
        [2, '100.00'],
      ],
    };
    const sink = memorySink();
    const summary = await exportRows({ session, query: 'SELECT', format: 'parquet', sink });
    expect(summary.status).toBe('failed');
    expect(summary.errors[0]?.message).toBe('Column "price", row 2: 100.00 has more than 4 digits');

    session.result = { columns: [col('d', 'date', 'date')], rows: [['infinity']] };
    const infinite = await exportRows({
      session,
      query: 'SELECT',
      format: 'parquet',
      sink: memorySink(),
    });
    expect(infinite.errors[0]?.message).toBe(
      'Column "d", row 1: "infinity" cannot be written as a Parquet DATE',
    );
  });

  it('splits rows into row groups and reads them back in order', async () => {
    const rows = Array.from({ length: 10 }, (_, i): CellValue[] => [i + 1, `row ${i + 1}`]);
    const bytes = await exportParquet(
      [col('id', 'integer', 'int4'), col('label', 'string', 'text')],
      rows,
      { parquet: { rowGroupRows: 3 } },
    );
    expect(schemaOf(bytes).metadata.row_groups.map((g) => Number(g.num_rows))).toEqual([
      3, 3, 3, 1,
    ]);
    const { rows: back, lines, batches } = await readAll(bytes, { format: 'parquet' });
    expect(back).toEqual(rows);
    expect(lines).toEqual(rows.map((_, i) => i + 1));
    // Progress runs through the file and ends at its size.
    const read = batches.map((b) => b.bytesRead);
    expect(read).toEqual([...read].sort((a, b) => a - b));
    expect(read.at(-1)).toBe(bytes.length);
  });

  it('reads large row groups in slices', async () => {
    const count = 40_000;
    const ids = Array.from({ length: count }, (_, i): CellValue[] => [
      i,
      i % 7 === 0 ? null : `v${i % 100}`,
    ]);
    const bytes = await exportParquet(
      [col('id', 'integer', 'int4'), col('v', 'string', 'text')],
      ids,
    );
    expect(schemaOf(bytes).metadata.row_groups).toHaveLength(1);
    const { rows, batches } = await readAll(bytes, { format: 'parquet' });
    expect(rows).toEqual(ids);
    expect(batches.filter((b) => b.rows.length > 0).map((b) => b.rows.length)).toEqual([
      16_384, 16_384, 7_232,
    ]);
  });

  it.each(['snappy', 'zstd', 'gzip', 'none'] satisfies ParquetCompression[])(
    'compresses pages with %s',
    async (compression) => {
      const rows = Array.from({ length: 500 }, (_, i): CellValue[] => [i, 'repeated text value']);
      const bytes = await exportParquet(
        [col('id', 'integer', 'int4'), col('text', 'string', 'text')],
        rows,
        { parquet: { compression } },
      );
      const codecs = schemaOf(bytes).metadata.row_groups[0]!.columns.map((c) => c.meta_data?.codec);
      expect(new Set(codecs)).toEqual(
        new Set([
          { snappy: 'SNAPPY', zstd: 'ZSTD', gzip: 'GZIP', none: 'UNCOMPRESSED' }[compression],
        ]),
      );
      expect((await readAll(bytes, { format: 'parquet' })).rows).toEqual(rows);
    },
  );

  it('writes an empty result as a valid file with its schema', async () => {
    const bytes = await exportParquet([col('id', 'integer', 'int4')], []);
    expect(Number(schemaOf(bytes).metadata.num_rows)).toBe(0);
    const { columns, rows } = await readAll(bytes, { format: 'parquet' });
    expect(columns).toEqual(['id']);
    expect(rows).toEqual([]);
  });

  it('makes duplicate result column names unique and marks NOT NULL columns required', async () => {
    const bytes = await exportParquet(
      [{ ...col('id', 'integer', 'int4'), nullable: false }, col('id', 'string', 'text')],
      [[1, 'a']],
    );
    expect(schemaOf(bytes).elements.map((e) => [e.name, e.repetition_type])).toEqual([
      ['id', 'REQUIRED'],
      ['id_2', 'OPTIONAL'],
    ]);
  });

  it('exports one file per table, not a combined file', async () => {
    const session = new FakeSession('postgres');
    session.result = { columns: [col('id', 'integer', 'int4')], rows: [[1]] };
    await expect(
      exportTables({
        session,
        format: 'parquet',
        tables: [{ name: 'a' }, { name: 'b' }],
        output: { kind: 'combined', sink: memorySink() },
      }),
    ).rejects.toThrow('A combined file is not available for PARQUET');
    const zip = memorySink();
    const summary = await exportTables({
      session,
      format: 'parquet',
      tables: [{ name: 'a' }, { name: 'b' }],
      output: { kind: 'zip', sink: zip },
    });
    expect(summary.status).toBe('completed');
    expect(summary.files).toEqual(['a.parquet', 'b.parquet']);
  });
});

describe('Parquet import', () => {
  it('previews a file by name or by its bytes, typed from the schema', async () => {
    const bytes = await exportParquet(PG, [PG_ROW, PG_ROW]);
    for (const options of [{ fileName: 'orders.parquet' }, {}]) {
      const preview = await previewSource(bytesSource(bytes), options);
      expect(preview.format).toBe('parquet');
      expect(preview.read).toEqual({ format: 'parquet', decompress: 'auto' });
      expect(preview.complete).toBe(true);
      expect(preview.parquet).toEqual({
        rows: 2,
        rowGroups: 1,
        createdBy: 'hyparquet',
        compressions: ['SNAPPY'],
      });
      expect(preview.rows).toHaveLength(2);
      const types = Object.fromEntries(preview.columns.map((c) => [c.name, c]));
      expect(types['id']?.type).toBe('integer');
      expect(types['big']?.type).toBe('bigint');
      expect(types['price']).toMatchObject({ type: 'decimal', precision: 10, scale: 2 });
      expect(types['free']?.type).toBe('text');
      expect(types['ratio']?.type).toBe('float');
      expect(types['day']?.type).toBe('date');
      expect(types['at']).toMatchObject({ type: 'timestamp', withTimeZone: false });
      expect(types['stamp']).toMatchObject({ type: 'timestamp', withTimeZone: true });
      expect(types['clock']).toMatchObject({ type: 'time', fractionalDigits: 6 });
      expect(types['doc']?.type).toBe('json');
      expect(types['key']?.type).toBe('uuid');
      expect(types['bin']?.type).toBe('binary');
      expect(types['name']).toMatchObject({ type: 'text', maxLength: 5, samples: 2 });
      expect(sqlTypeFor(types['clock']!, 'postgres')).toBe('time(6)');
      expect(sqlTypeFor(types['bin']!, 'postgres')).toBe('bytea');
      expect(sqlTypeFor(types['bin']!, 'mysql')).toBe('longblob');
    }
  });

  it('reads a gzip-wrapped file', async () => {
    const bytes = await exportParquet([col('id', 'integer', 'int4')], [[1], [2]]);
    const { rows } = await readAll(gzipSync(bytes), { format: 'parquet' });
    expect(rows).toEqual([[1], [2]]);
    const preview = await previewSource(bytesSource(gzipSync(bytes)), {});
    expect(preview.format).toBe('parquet');
    expect(preview.rows).toEqual([[1], [2]]);
  });

  it('refuses files that are not Parquet, and encrypted ones', async () => {
    await expect(readAll('id,name\n1,a\n', { format: 'parquet' })).rejects.toThrow(
      'This is not a Parquet file',
    );
    const bytes = await exportParquet([col('id', 'integer', 'int4')], [[1]]);
    const encrypted = bytes.slice();
    encrypted.set([0x50, 0x41, 0x52, 0x45], encrypted.length - 4);
    await expect(openParquet(bytesSource(encrypted))).rejects.toThrow(
      'This Parquet file is encrypted',
    );
    const cut = bytes.slice(0, bytes.length - 20);
    await expect(readAll(cut, { format: 'parquet' })).rejects.toThrow(/Parquet/);
  });

  it('stops reading when the consumer stops', async () => {
    const rows = Array.from({ length: 40_000 }, (_, i): CellValue[] => [i]);
    const bytes = await exportParquet([col('id', 'integer', 'int4')], rows);
    let seen = 0;
    for await (const batch of readRows(bytesSource(bytes), { format: 'parquet' })) {
      seen += batch.rows.length;
      if (seen > 0) break;
    }
    expect(seen).toBe(16_384);
  });
});

describe('Parquet files other programs wrote', () => {
  const fixture = (name: string): string => join(import.meta.dirname, 'fixtures', name);

  it('reads every column type pyarrow writes, nested ones as JSON', async () => {
    // test/fixtures/pyarrow-types.parquet was written by pyarrow 25.0.1 (ZSTD, data pages v2,
    // row groups of 2): signed and unsigned integers, decimal128 and decimal256, float16, a
    // dictionary-encoded string, binary, dates, times and timestamps in every unit, UUID,
    // JSON, and a list, a struct and a map.
    const preview = await previewSource(fileSource(fixture('pyarrow-types.parquet')), {
      fileName: 'pyarrow-types.parquet',
    });
    expect(preview.parquet).toEqual({
      rows: 5,
      rowGroups: 3,
      createdBy: 'parquet-cpp-arrow version 25.0.1',
      compressions: ['ZSTD'],
    });
    expect(
      preview.columns.map((c) => [
        c.name,
        c.type,
        ...(c.precision !== undefined ? [c.precision, c.scale] : []),
        ...(c.withTimeZone === true ? ['tz'] : []),
      ]),
    ).toEqual([
      ['id', 'integer'],
      ['tiny', 'integer'],
      ['u32', 'bigint'],
      ['u64', 'decimal', 20, 0],
      ['big', 'bigint'],
      ['amount', 'decimal', 30, 10],
      ['huge', 'decimal', 50, 5],
      ['small', 'decimal', 4, 2],
      ['half', 'float'],
      ['single', 'float'],
      ['double', 'float'],
      ['flag', 'boolean'],
      ['city', 'text'],
      ['note', 'text'],
      ['blob', 'binary'],
      ['fixed', 'binary'],
      ['day', 'date'],
      ['alarm', 'time'],
      ['clock', 'time'],
      ['local', 'timestamp'],
      ['instant', 'timestamp', 'tz'],
      ['nanos', 'timestamp'],
      ['key', 'uuid'],
      ['doc', 'json'],
      ['tags', 'json'],
      ['point', 'json'],
      ['attrs', 'json'],
    ]);
    const { rows } = await readAll(readFileSync(fixture('pyarrow-types.parquet')), {
      format: 'parquet',
    });
    const j = (text: string) => ({ $json: text });
    expect(rows).toEqual([
      [
        1,
        -128,
        4294967295,
        18446744073709551615n,
        -9223372036854775808n,
        '12345678901234567890.1234567890',
        '1234567890123456789012345678901234567890.12345',
        '12.34',
        1.5,
        1.25,
        0.1,
        true,
        'Yerevan',
        '',
        '\\x00ff',
        '\\x616263',
        '2024-02-29',
        '06:30:00',
        '06:30:00.000001',
        '2024-01-02 03:04:05.678',
        '2024-01-02 03:04:05.123456Z',
        '2024-01-02 03:04:05.123456789',
        'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
        '{"a": [1, 2.50]}',
        j('[1,2]'),
        j('{"x":1,"label":"a"}'),
        j('{"k":1}'),
      ],
      [
        2,
        127,
        0,
        0,
        9223372036854775807n,
        '-0.0000000001',
        null,
        '-0.01',
        -2,
        -0.5,
        -1e-300,
        false,
        'Berlin',
        '  spaced  ',
        '\\x',
        '\\x000102',
        '0001-01-01',
        '23:59:59.999',
        '23:59:59.999999',
        '1969-12-31 23:59:59',
        null,
        null,
        null,
        null,
        j('[]'),
        null,
        j('{}'),
      ],
      [
        3,
        null,
        null,
        null,
        null,
        null,
        '-1.00000',
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        '1970-01-01 00:00:00Z',
        '1970-01-01 00:00:00',
        '00000000-0000-0000-0000-000000000000',
        '[]',
        null,
        j('{"x":null,"label":"b"}'),
        null,
      ],
      [
        4,
        0,
        1,
        1,
        0,
        '0.0000000000',
        '0.00001',
        '99.99',
        65504,
        3,
        Infinity,
        true,
        'Yerevan',
        'line\nbreak',
        '\\x616263',
        '\\x78797a',
        '9999-12-31',
        '00:00:00',
        '00:00:00',
        '2000-01-01 00:00:00',
        '2038-01-19 03:14:08Z',
        '1969-12-31 23:59:59.999999999',
        '00000000-0000-0000-0000-000000000001',
        '"text"',
        j('[null,3]'),
        j('{"x":3,"label":null}'),
        j('{"a":2,"b":null}'),
      ],
      [
        5,
        1,
        2,
        2,
        9007199254740993n,
        '1.5000000000',
        '7.00000',
        '0.00',
        0,
        0,
        NaN,
        false,
        'Ünïcödé',
        'x',
        '\\xdead',
        '\\x313233',
        '1969-12-31',
        '12:00:00.001',
        '12:00:00',
        '1900-01-01 00:00:00',
        '1999-12-31 23:59:59.999999Z',
        '1970-01-01 00:00:00.000000001',
        'ffffffff-ffff-ffff-ffff-ffffffffffff',
        '12345678901234567890',
        j('[4]'),
        j('{"x":5,"label":"e"}'),
        j('{"z":26}'),
      ],
    ]);
  });

  it('reads every codec, and Spark-style INT96 timestamps', async () => {
    // test/fixtures/pyarrow-codecs.parquet (pyarrow 25.0.1, data pages v1, row groups of 64):
    // one column per codec (Snappy, GZIP, Brotli, LZ4_RAW, ZSTD, none) and a timestamp written
    // as INT96, as Spark and Impala do.
    const preview = await previewSource(fileSource(fixture('pyarrow-codecs.parquet')), {});
    expect(preview.format).toBe('parquet');
    expect(preview.parquet?.compressions).toEqual([
      'SNAPPY',
      'GZIP',
      'BROTLI',
      'LZ4_RAW',
      'ZSTD',
      'UNCOMPRESSED',
    ]);
    const { rows } = await readAll(readFileSync(fixture('pyarrow-codecs.parquet')), {
      format: 'parquet',
    });
    expect(rows).toHaveLength(150);
    const codecs = ['snappy', 'gzip', 'brotli', 'lz4', 'zstd', 'none'];
    rows.forEach((row, i) => {
      const at = new Date(Date.UTC(2024, 0, 2, 3, 4, 5) + i * 1000).toISOString();
      expect(row).toEqual([
        ...codecs.map((codec) => `${codec} row ${i}`),
        `${at.slice(0, 10)} ${at.slice(11, 19)}.123456Z`,
      ]);
    });
  });
});

describe('lz4Block', () => {
  it('decodes literals and overlapping matches', () => {
    // "abcabcabcabcX": 3 literals, a 9-byte match at offset 3, then the literal X.
    const block = Uint8Array.from([0x35, 0x61, 0x62, 0x63, 0x03, 0x00, 0x10, 0x58]);
    expect(new TextDecoder().decode(lz4Block(block, 13))).toBe('abcabcabcabcX');
  });

  it('decodes long literal and match lengths', () => {
    const literals = 'x'.repeat(20);
    // Token 0xF0: 15 + 5 more literals, no match.
    const block = Uint8Array.from([0xf0, 5, ...new TextEncoder().encode(literals)]);
    expect(new TextDecoder().decode(lz4Block(block, 20))).toBe(literals);
    // One literal, then a match of 4 + 15 + 281 at offset 1: 301 bytes of "a".
    const run = Uint8Array.from([0x1f, 0x61, 0x01, 0x00, 255, 26]);
    expect(new TextDecoder().decode(lz4Block(run, 301))).toBe('a'.repeat(301));
  });

  it('refuses a damaged block', () => {
    expect(() => lz4Block(Uint8Array.from([0x10, 0x61, 0x05, 0x00]), 10)).toThrow(
      'an LZ4 match points before the page',
    );
    expect(() => lz4Block(Uint8Array.from([0x30, 0x61]), 3)).toThrow(
      'LZ4 literals run past the page',
    );
    expect(() => lz4Block(Uint8Array.from([0x10, 0x61]), 2)).toThrow(
      'an LZ4 page is shorter than its header says',
    );
  });
});
