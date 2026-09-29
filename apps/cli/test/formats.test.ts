import type { CellValue, ColumnMeta, LargeValueHandle } from '@joinery/core';
import { describe, expect, it } from 'vitest';

import { bytesToHex, cellJson, cellText, uniqueKeys } from '../src/output/cells';
import {
  TableWriter,
  createResultWriter,
  csvField,
  tsvField,
  type OutputFormat,
} from '../src/output/formats';
import { Sink } from '../src/output/sink';
import { displayWidth, singleLine, truncateToWidth } from '../src/output/width';
import { MemoryStream, column } from './helpers';

const handle: LargeValueHandle = {
  $handle: 'h1',
  preview: 'long te',
  byteLength: 9000,
  kind: 'text',
};

/** Writes one result set through a writer; rows arrive in pages of `page`. */
async function render(
  format: OutputFormat,
  columns: readonly ColumnMeta[],
  rows: readonly (readonly CellValue[])[],
  options: { width?: number; maxColumnWidth?: number; page?: number } = {},
): Promise<string> {
  const stream = new MemoryStream();
  const writer = createResultWriter(format, new Sink(stream), options);
  await writer.begin(columns);
  const page = options.page ?? 1000;
  for (let i = 0; i < rows.length; i += page) {
    const slice = rows.slice(i, i + page);
    await writer.rows(
      columns.map((_c, c) => slice.map((row) => row[c] ?? null)),
      slice.length,
    );
  }
  await writer.end();
  return stream.text();
}

describe('CSV', () => {
  it('quotes every CellValue kind exactly', () => {
    expect(csvField(null)).toBe('');
    expect(csvField('')).toBe('""');
    expect(csvField('plain')).toBe('plain');
    expect(csvField('a,b')).toBe('"a,b"');
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
    expect(csvField('line\nbreak')).toBe('"line\nbreak"');
    expect(csvField('cr\rreturn')).toBe('"cr\rreturn"');
    expect(csvField(true)).toBe('true');
    expect(csvField(false)).toBe('false');
    expect(csvField(42)).toBe('42');
    expect(csvField(-1.5)).toBe('-1.5');
    expect(csvField(12345678901234567890n)).toBe('12345678901234567890');
    expect(csvField(new Uint8Array([0xde, 0xad, 0x00, 0x0f]))).toBe('\\xdead000f');
    expect(csvField(handle)).toBe('long te');
  });

  it('writes a header and one line per row, and separates result sets', async () => {
    const stream = new MemoryStream();
    const writer = createResultWriter('csv', new Sink(stream));
    await writer.begin([column('id', 'integer'), column('note')]);
    await writer.rows(
      [
        [1, 2],
        ['x', null],
      ],
      2,
    );
    await writer.end();
    await writer.begin([column('n')]);
    await writer.rows([[3n]], 1);
    await writer.end();
    expect(stream.text()).toBe('id,note\n1,x\n2,\n\nn\n3\n');
  });
});

describe('TSV', () => {
  it('escapes like PostgreSQL COPY text and writes NULL as \\N', () => {
    expect(tsvField(null)).toBe('\\N');
    expect(tsvField('')).toBe('');
    expect(tsvField('a\tb')).toBe('a\\tb');
    expect(tsvField('a\nb\r')).toBe('a\\nb\\r');
    expect(tsvField('back\\slash')).toBe('back\\\\slash');
    expect(tsvField(new Uint8Array([1, 255]))).toBe('\\\\x01ff');
    expect(tsvField(9007199254740993n)).toBe('9007199254740993');
  });
});

describe('JSON', () => {
  it('keeps bigint digits exact and encodes the other kinds', () => {
    expect(cellJson(9007199254740993n)).toBe('9007199254740993');
    expect(cellJson(-12345678901234567890n)).toBe('-12345678901234567890');
    expect(cellJson(null)).toBe('null');
    expect(cellJson(true)).toBe('true');
    expect(cellJson(1.25)).toBe('1.25');
    expect(cellJson(Number.NaN)).toBe('"NaN"');
    expect(cellJson(Number.POSITIVE_INFINITY)).toBe('"Infinity"');
    expect(cellJson('a"b\n')).toBe('"a\\"b\\n"');
    expect(cellJson(new Uint8Array([0xde, 0xad, 0xbe, 0xef]))).toBe('"3q2+7w=="');
    expect(JSON.parse(cellJson(handle))).toEqual({
      $handle: 'h1',
      preview: 'long te',
      byteLength: 9000,
      kind: 'text',
    });
  });

  it('embeds JSON columns as JSON and falls back to a string when the text is not JSON', () => {
    expect(cellJson('{"a": [1, 2]}', 'json')).toBe('{"a": [1, 2]}');
    expect(cellJson('{broken', 'json')).toBe('"{broken"');
    expect(cellJson('{"a":1}', 'string')).toBe('"{\\"a\\":1}"');
  });

  it('streams a parseable array across pages, and [] for no rows', async () => {
    const columns = [column('id', 'bigint'), column('name'), column('bin', 'binary')];
    const rows: CellValue[][] = Array.from({ length: 7 }, (_, i) => [
      BigInt(i) + 9007199254740990n,
      `n${i}`,
      new Uint8Array([i]),
    ]);
    const text = await render('json', columns, rows, { page: 3 });
    const parsed = JSON.parse(text) as Record<string, unknown>[];
    expect(parsed).toHaveLength(7);
    expect(parsed[0]).toEqual({ id: 9007199254740990, name: 'n0', bin: 'AA==' });
    expect(text).toContain('"id":9007199254740996');
    expect(await render('json', columns, [])).toBe('[]\n');
  });

  it('writes one object per line for jsonl', async () => {
    const text = await render(
      'jsonl',
      [column('a'), column('a')],
      [
        ['x', 'y'],
        [null, ''],
      ],
    );
    expect(
      text
        .trimEnd()
        .split('\n')
        .map((line) => JSON.parse(line) as unknown),
    ).toEqual([
      { a: 'x', a_2: 'y' },
      { a: null, a_2: '' },
    ]);
  });

  it('makes repeated column names unique without clobbering real ones', () => {
    expect(uniqueKeys(['id', 'id', 'id_2', 'x'])).toEqual(['id', 'id_3', 'id_2', 'x']);
  });
});

describe('table', () => {
  it('aligns columns, right-aligns numbers and shows NULL', async () => {
    const text = await render(
      'table',
      [column('id', 'integer'), column('name')],
      [
        [1, 'alice'],
        [100, null],
      ],
    );
    expect(text).toBe(' id  | name\n-----+-------\n   1 | alice\n 100 | NULL\n');
  });

  it('truncates long cells with … at the column cap', async () => {
    const long = 'x'.repeat(80);
    const text = await render('table', [column('v')], [[long]], { maxColumnWidth: 10 });
    const [, , row] = text.split('\n');
    expect(row).toBe(` ${'x'.repeat(9)}…`);
  });

  it('shrinks the widest columns until the table fits the terminal width', async () => {
    const text = await render(
      'table',
      [column('a'), column('b'), column('c')],
      [['a'.repeat(30), 'b'.repeat(30), 'short']],
      { width: 40 },
    );
    for (const line of text.trimEnd().split('\n'))
      expect(displayWidth(line)).toBeLessThanOrEqual(40);
    expect(text).toContain('short');
    expect(text).toContain('…');
  });

  it('keeps the widths of the first page for later pages', async () => {
    const stream = new MemoryStream();
    const writer = new TableWriter(new Sink(stream));
    await writer.begin([column('v')]);
    await writer.rows([['ab']], 1);
    await writer.rows([['abcdef']], 1);
    await writer.end();
    expect(stream.text().split('\n')).toEqual([' v', '----', ' ab', ' a…', '']);
  });

  it('keeps each row on one line and escapes control characters', async () => {
    const text = await render('table', [column('v')], [['one\ntwo\tthree\x1b[31m']]);
    expect(text).toContain('one↵two⇥three\\x1b[31m');
    expect(text).not.toContain('\x1b');
  });

  it('measures wide characters', async () => {
    expect(displayWidth('日本語')).toBe(6);
    expect(displayWidth('é')).toBe(1);
    expect(displayWidth('😀')).toBe(2);
    expect(truncateToWidth('日本語テキスト', 7)).toBe('日本語…');
    const text = await render('table', [column('v'), column('w')], [['日本', 'x']]);
    const lines = text.split('\n');
    expect(displayWidth(lines[0]!.split('|')[0]!)).toBe(displayWidth(lines[2]!.split('|')[0]!));
  });
});

describe('cell text', () => {
  it('uses the server text form and PostgreSQL bytea hex', () => {
    expect(cellText('2024-01-01 10:00:00+00')).toBe('2024-01-01 10:00:00+00');
    expect(cellText(1n)).toBe('1');
    expect(bytesToHex(new Uint8Array([]))).toBe('\\x');
    expect(singleLine('a\r\nb')).toBe('a↵b');
  });
});
