import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

import type { CellValue, ColumnMeta } from '@querybara/core';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  bytesSource,
  exportRows,
  exportTables,
  fileSource,
  formatKind,
  jsonText,
  memorySink,
  openWorkbook,
  previewSource,
  readRows,
  serialToText,
  sheetName,
  type ByteSource,
  type ExportOptions,
} from '../src';
import { FakeSession } from './fake-session';
import { col, partText, rawWorkbook, readAll } from './xlsx-helpers';

async function exportXlsx(
  columns: ColumnMeta[],
  rows: CellValue[][],
  options: Partial<ExportOptions> = {},
): Promise<Uint8Array> {
  const session = new FakeSession('postgres');
  session.result = { columns, rows };
  const sink = memorySink();
  const summary = await exportRows({
    session,
    query: 'SELECT * FROM t',
    format: 'xlsx',
    sink,
    ...options,
  });
  expect(summary.status).toBe('completed');
  expect(summary.bytesWritten).toBe(sink.bytes().length);
  return sink.bytes();
}

const TYPED: ColumnMeta[] = [
  col('id', 'integer'),
  col('big', 'bigint'),
  col('price', 'decimal'),
  col('ratio', 'float'),
  col('ok', 'boolean'),
  col('name', 'string'),
  col('day', 'date'),
  col('at', 'timestamp'),
  col('clock', 'time'),
  col('bin', 'binary'),
];

describe('xlsx export and import', () => {
  it('round-trips typed cells', async () => {
    const book = await exportXlsx(TYPED, [
      [
        1,
        9007199254740993n,
        '12.50',
        0.1,
        true,
        'plain',
        '2024-01-02',
        '2024-01-02 03:04:05.678+00',
        '13:14:15',
        new Uint8Array([0xde, 0xad]),
      ],
      [2, -5n, '-0.001', -1e-300, false, '', '1999-12-31', '2024-12-31 23:59:59', '00:00:00', null],
      [3, null, null, null, null, null, null, null, null, null],
    ]);
    const { columns, rows, lines } = await readAll(book, { format: 'xlsx' });
    expect(columns).toEqual(TYPED.map((c) => c.name));
    expect(rows).toEqual([
      [
        1,
        '9007199254740993',
        '12.50',
        0.1,
        true,
        'plain',
        '2024-01-02',
        '2024-01-02 03:04:05.678',
        '13:14:15',
        '\\xdead',
      ],
      // NULL is no cell; the empty string is an empty text cell.
      [2, -5, '-0.001', -1e-300, false, '', '1999-12-31', '2024-12-31 23:59:59', '00:00:00', null],
      [3, null, null, null, null, null, null, null, null, null],
    ]);
    // Lines are worksheet rows: the header is row 1.
    expect(lines).toEqual([2, 3, 4]);
  });

  it('writes dates, timestamps and times as real Excel dates with date formats', async () => {
    const book = await exportXlsx(
      [col('day', 'date'), col('at', 'timestamp'), col('clock', 'time'), col('old', 'date')],
      [['2024-01-02', '2024-01-02 12:00:00', '06:00:00', '1899-12-31']],
    );
    const sheet = await partText(book, 'xl/worksheets/sheet1.xml');
    expect(sheet).toContain('<c r="A2" s="2"><v>45293</v></c>');
    expect(sheet).toContain('<c r="B2" s="3"><v>45293.5</v></c>');
    expect(sheet).toContain('<c r="C2" s="5"><v>0.25</v></c>');
    // Before 1900-03-01 Excel has no dates: the text is kept.
    expect(sheet).toContain('<c r="D2" t="inlineStr"><is><t>1899-12-31</t></is></c>');
    const styles = await partText(book, 'xl/styles.xml');
    expect(styles).toContain('formatCode="yyyy-mm-dd"');
    expect(styles).toContain('formatCode="yyyy-mm-dd hh:mm:ss"');
  });

  it('keeps integers beyond 2^53 and decimals exact as text, or exact decimals as numbers', async () => {
    const rows: CellValue[][] = [
      ['12345678901234567890', '0.1'],
      ['9007199254740991', '123456789012345.6'],
      ['1', '1.50'],
    ];
    const columns = [col('n', 'bigint'), col('d', 'decimal')];
    const asText = await exportXlsx(columns, rows);
    expect((await readAll(asText, { format: 'xlsx' })).rows).toEqual([
      ['12345678901234567890', '0.1'],
      [9007199254740991, '123456789012345.6'],
      [1, '1.50'],
    ]);
    const asNumbers = await exportXlsx(columns, rows, { xlsx: { decimals: 'number' } });
    expect((await readAll(asNumbers, { format: 'xlsx' })).rows).toEqual([
      ['12345678901234567890', 0.1],
      // 16 significant digits do not fit a double exactly: text.
      [9007199254740991, '123456789012345.6'],
      [1, 1.5],
    ]);
  });

  it('escapes text: markup, characters XML cannot hold, _x sequences and spaces', async () => {
    const texts = [
      '<b>&amp;</b> "q" \'s\'',
      'bell\u{7} and nul\u{0}',
      '_x0041_ stays literal',
      '  padded  ',
      'two\nlines\r\nand CR',
      'emoji 😀 and lone \u{D800}',
    ];
    const book = await exportXlsx(
      [col('t', 'string')],
      texts.map((t) => [t]),
    );
    const sheet = await partText(book, 'xl/worksheets/sheet1.xml');
    expect(sheet).toContain('&lt;b&gt;&amp;amp;&lt;/b&gt;');
    expect(sheet).toContain('bell_x0007_ and nul_x0000_');
    expect(sheet).toContain('_x005F_x0041_ stays literal');
    expect(sheet).toContain('<t xml:space="preserve">  padded  </t>');
    const { rows } = await readAll(book, { format: 'xlsx' });
    expect(rows.map((r) => r[0])).toEqual([
      texts[0],
      texts[1],
      texts[2],
      texts[3],
      texts[4],
      // A lone surrogate is not text XML can carry; it comes back as its escape decoded.
      texts[5],
    ]);
  });

  it('styles, freezes and filters the header row and sizes the columns', async () => {
    const book = await exportXlsx(
      [col('id', 'integer'), col('a rather long column name', 'string')],
      [[1, 'x']],
    );
    const sheet = await partText(book, 'xl/worksheets/sheet1.xml');
    expect(sheet).toContain(
      '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>',
    );
    expect(sheet).toContain('<c r="A1" s="1" t="inlineStr"><is><t>id</t></is></c>');
    expect(sheet).toContain('<col min="2" max="2" width="29" customWidth="1"/>');
    expect(sheet).toContain('<autoFilter ref="A1:B2"/>');
    const workbook = await partText(book, 'xl/workbook.xml');
    expect(workbook).toContain(
      `<definedName name="_xlnm._FilterDatabase" localSheetId="0" hidden="1">'query_result'!$A$1:$B$2</definedName>`,
    );
    const styles = await partText(book, 'xl/styles.xml');
    expect(styles).toContain('<font><b/>');
    const plain = await exportXlsx([col('id', 'integer')], [[1]], { xlsx: { header: false } });
    const plainSheet = await partText(plain, 'xl/worksheets/sheet1.xml');
    expect(plainSheet).not.toContain('pane');
    expect(plainSheet).not.toContain('autoFilter');
    expect((await readAll(plain, { format: 'xlsx', xlsx: { headerRow: 0 } })).rows).toEqual([[1]]);
  });

  it('writes an empty result as a sheet with its header', async () => {
    const book = await exportXlsx([col('id', 'integer'), col('name', 'string')], []);
    const { columns, rows } = await readAll(book, { format: 'xlsx' });
    expect(columns).toEqual(['id', 'name']);
    expect(rows).toEqual([]);
  });

  it('puts each table on its own worksheet in a combined workbook', async () => {
    const session = new FakeSession('postgres');
    session.result = { columns: [col('id', 'integer')], rows: [[1], [2]] };
    const sink = memorySink();
    const summary = await exportTables({
      session,
      tables: [{ name: 'orders' }, { name: 'Orders' }, { name: 'a/b:c' }],
      format: 'xlsx',
      output: { kind: 'combined', sink },
    });
    expect(summary).toMatchObject({ status: 'completed', rowsWritten: 6 });
    const workbook = await openWorkbook(bytesSource(sink.bytes()));
    expect(workbook.sheets.map((s) => s.name)).toEqual(['orders', 'Orders (2)', 'a_b_c']);
    await workbook.close();
    const second = await readAll(sink.bytes(), { format: 'xlsx', xlsx: { sheet: 'Orders (2)' } });
    expect(second.rows).toEqual([[1], [2]]);
  });

  it('continues a result longer than a worksheet on further sheets', async () => {
    const rows = Array.from({ length: 7 }, (_, i) => [i + 1]);
    const book = await exportXlsx([col('n', 'integer')], rows, {
      xlsx: { rowsPerSheet: 3 },
      pageSize: 2,
    });
    const workbook = await openWorkbook(bytesSource(book));
    expect(workbook.sheets.map((s) => s.name)).toEqual([
      'query_result',
      'query_result (2)',
      'query_result (3)',
      'query_result (4)',
    ]);
    await workbook.close();
    const parts = await Promise.all(
      ['query_result', 'query_result (2)', 'query_result (3)', 'query_result (4)'].map(
        async (sheet) => (await readAll(book, { format: 'xlsx', xlsx: { sheet } })).rows,
      ),
    );
    expect(parts).toEqual([[[1], [2]], [[3], [4]], [[5], [6]], [[7]]]);
  });

  it('makes worksheet names Excel accepts', () => {
    const taken = new Set<string>();
    expect(sheetName("'quoted'", taken)).toBe('quoted');
    expect(sheetName('History', taken)).toBe('History_');
    expect(sheetName('x'.repeat(40), taken)).toBe('x'.repeat(31));
    expect(sheetName('x'.repeat(40), new Set(['x'.repeat(31)]))).toBe(`${'x'.repeat(27)} (2)`);
    expect(sheetName('[a]*?', taken)).toBe('_a___');
    expect(sheetName('', taken)).toBe('Sheet');
  });
});

describe('xlsx reader', () => {
  it('reads shared, rich and inline strings, numbers, booleans, errors and formulas', async () => {
    const book = await rawWorkbook({
      sharedStrings:
        '<si><t>name</t></si><si><t>qty</t></si><si><r><rPr><b/></rPr><t>Ri</t></r><r><t xml:space="preserve">ch </t></r><rPh sb="0" eb="1"><t>ignored</t></rPh></si><si><t>line_x000D_break</t></si>',
      sheets: [
        {
          name: 'Data',
          xml: [
            '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="inlineStr"><is><t>flag</t></is></c><c r="D1" t="inlineStr"><is><t>calc</t></is></c></row>',
            '<row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>42</v></c><c r="C2" t="b"><v>1</v></c><c r="D2"><f>B2*2</f><v>84</v></c></row>',
            '<row r="3"><c r="A3" t="s"><v>3</v></c><c r="B3"><v>1.5E-3</v></c><c r="C3" t="b"><v>0</v></c><c r="D3" t="e"><v>#DIV/0!</v></c></row>',
            '<row r="4"><c r="A4" t="str"><f>A1&amp;"!"</f><v>name!</v></c><c r="B4"><v>123456789012345678901</v></c><c r="C4"/><c r="D4"><f>1/0</f></c></row>',
          ].join(''),
        },
      ],
    });
    const { columns, rows } = await readAll(book, { format: 'xlsx' });
    expect(columns).toEqual(['name', 'qty', 'flag', 'calc']);
    expect(rows).toEqual([
      ['Rich ', 42, true, 84],
      ['line\rbreak', jsonText('1.5E-3'), false, null],
      ['name!', 123456789012345678901n, null, null],
    ]);
  });

  it('reads built-in and custom date formats, times, durations and the 1904 system', async () => {
    const styles = `<?xml version="1.0"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="3"><numFmt numFmtId="200" formatCode="dd/mm/yyyy;@"/><numFmt numFmtId="201" formatCode="[h]:mm:ss"/><numFmt numFmtId="202" formatCode="#,##0.00 &quot;days&quot;"/></numFmts><cellStyleXfs count="1"><xf numFmtId="14"/></cellStyleXfs><cellXfs count="7"><xf numFmtId="0"/><xf numFmtId="14"/><xf numFmtId="22"/><xf numFmtId="21"/><xf numFmtId="200"/><xf numFmtId="201"/><xf numFmtId="202"/></cellXfs></styleSheet>`;
    const row = (r: number, cells: string): string => `<row r="${r}">${cells}</row>`;
    const sheet = [
      row(1, '<c r="A1" s="1"><v>45293</v></c>'),
      row(2, '<c r="A2" s="2"><v>45293.5</v></c>'),
      row(3, '<c r="A3" s="3"><v>0.5</v></c>'),
      row(4, '<c r="A4" s="4"><v>1</v></c>'),
      row(5, '<c r="A5" s="5"><v>1.25</v></c>'),
      row(6, '<c r="A6" s="6"><v>45293</v></c>'),
      row(7, '<c r="A7" s="1"><v>45293.75</v></c>'),
      row(8, '<c r="A8" s="2"><v>45293.123456789</v></c>'),
      row(9, '<c r="A9" s="1"><v>59</v></c>'),
    ].join('');
    const book = await rawWorkbook({ styles, sheets: [{ name: 'D', xml: sheet }] });
    const { rows } = await readAll(book, { format: 'xlsx', xlsx: { headerRow: 0 } });
    expect(rows.map((r) => r[0])).toEqual([
      '2024-01-02',
      '2024-01-02 12:00:00',
      '12:00:00',
      '1900-01-01',
      '30:00:00',
      45293,
      '2024-01-02 18:00:00',
      '2024-01-02 02:57:46.667',
      '1900-02-28',
    ]);
    const book1904 = await rawWorkbook({
      styles,
      date1904: true,
      sheets: [{ name: 'D', xml: row(1, '<c r="A1" s="1"><v>0</v></c>') }],
    });
    expect((await readAll(book1904, { format: 'xlsx', xlsx: { headerRow: 0 } })).rows).toEqual([
      ['1904-01-01'],
    ]);
  });

  it('reads sparse cells, rows without references and skips empty rows', async () => {
    const book = await rawWorkbook({
      sheets: [
        {
          name: 'S',
          xml: [
            '<row r="2"><c r="B2" t="inlineStr"><is><t>b</t></is></c><c r="D2" t="inlineStr"><is><t>d</t></is></c></row>',
            '<row r="3" spans="1:4"><c r="D3"><v>4</v></c></row>',
            '<row r="5"><c r="A5" s="0"/></row>',
            '<row><c><v>1</v></c><c><v>2</v></c></row>',
          ].join(''),
        },
      ],
    });
    const { columns, rows, lines } = await readAll(book, { format: 'xlsx' });
    expect(columns).toEqual(['column1', 'b', 'column3', 'd']);
    expect(rows).toEqual([
      [null, null, null, 4],
      [1, 2, null, null],
    ]);
    expect(lines).toEqual([3, 6]);
  });

  it('takes the header from a given row, skipping the rows above it, or has none', async () => {
    const book = await rawWorkbook({
      sheets: [
        {
          name: 'S',
          xml: [
            '<row r="1"><c r="A1" t="inlineStr"><is><t>Quarterly report</t></is></c></row>',
            '<row r="3"><c r="A3" t="inlineStr"><is><t>id</t></is></c><c r="B3" t="inlineStr"><is><t>id</t></is></c></row>',
            '<row r="4"><c r="A4"><v>1</v></c><c r="B4"><v>2</v></c></row>',
          ].join(''),
        },
      ],
    });
    const fromRow3 = await readAll(book, { format: 'xlsx', xlsx: { headerRow: 3 } });
    expect(fromRow3.columns).toEqual(['id', 'id_2']);
    expect(fromRow3.rows).toEqual([[1, 2]]);
    const none = await readAll(book, { format: 'xlsx', xlsx: { headerRow: 0 } });
    expect(none.columns).toEqual(['column1', 'column2']);
    expect(none.rows).toHaveLength(3);
  });

  it('picks a worksheet by name, by default the first visible one', async () => {
    const book = await rawWorkbook({
      sheets: [
        { name: 'Hidden', state: 'hidden', xml: '<row r="1"><c r="A1"><v>0</v></c></row>' },
        { name: 'First', xml: '<row r="1"><c r="A1"><v>1</v></c></row>' },
        { name: 'Second & more', xml: '<row r="1"><c r="A1"><v>2</v></c></row>' },
      ],
    });
    const preview = await previewSource(bytesSource(book), { fileName: 'book.xlsx' });
    expect(preview.format).toBe('xlsx');
    expect(preview.sheets).toEqual(['Hidden', 'First', 'Second & more']);
    expect(preview.read?.xlsx?.sheet).toBe('First');
    expect(
      (await readAll(book, { format: 'xlsx', xlsx: { sheet: 'Second & more', headerRow: 0 } }))
        .rows,
    ).toEqual([[2]]);
    await expect(readAll(book, { format: 'xlsx', xlsx: { sheet: 'Nope' } })).rejects.toThrow(
      /no worksheet "Nope"/,
    );
  });

  it('detects the header row in a preview and infers the column types', async () => {
    const book = await exportXlsx(
      [col('id', 'integer'), col('day', 'date'), col('name', 'string')],
      [
        [1, '2024-01-02', 'Ada'],
        [2, '2024-02-03', 'Grace'],
      ],
    );
    const preview = await previewSource(bytesSource(book), {});
    expect(preview.format).toBe('xlsx');
    expect(preview.read?.xlsx).toEqual({ sheet: 'query_result', headerRow: 1 });
    expect(preview.columns.map((c) => [c.name, c.type])).toEqual([
      ['id', 'integer'],
      ['day', 'date'],
      ['name', 'text'],
    ]);
    expect(preview.complete).toBe(true);
    const headless = await exportXlsx([col('id', 'integer')], [[1], [2]], {
      xlsx: { header: false },
    });
    const noHeader = await previewSource(bytesSource(headless), { fileName: 'x.xlsx' });
    expect(noHeader.read?.xlsx?.headerRow).toBe(0);
    expect(noHeader.rows).toEqual([[1], [2]]);
  });

  it('reads a workbook from a stream without positioned reads, gzip-compressed too', async () => {
    const book = await exportXlsx([col('id', 'integer')], [[1], [2]]);
    const stream = (bytes: Uint8Array): ByteSource => {
      const all = bytesSource(bytes, 100);
      return { [Symbol.asyncIterator]: () => all[Symbol.asyncIterator]() };
    };
    const read = async (source: ByteSource): Promise<unknown[]> => {
      const out: unknown[] = [];
      for await (const batch of readRows(source, { format: 'xlsx' })) out.push(...batch.rows);
      return out;
    };
    expect(await read(stream(book))).toEqual([[1], [2]]);
    expect(await read(stream(gzipSync(book)))).toEqual([[1], [2]]);
    const preview = await previewSource(stream(book), {});
    expect(preview.format).toBe('xlsx');
    expect(preview.rows).toEqual([[1], [2]]);
  });

  it('refuses what is not a workbook, legacy .xls and encrypted workbooks', async () => {
    await expect(readAll('id,name\n1,x\n', { format: 'xlsx' })).rejects.toThrow(
      /not an Excel .xlsx workbook/,
    );
    const compound = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0]);
    await expect(readAll(compound, { format: 'xlsx' })).rejects.toThrow(
      /encrypted, or in the old .xls/,
    );
    const book = await exportXlsx([col('id', 'integer')], [[1]]);
    await expect(readAll(book.subarray(0, book.length - 30), { format: 'xlsx' })).rejects.toThrow(
      /Not a valid ZIP file/,
    );
  });

  it('reports a shared string that does not exist, with the cell', async () => {
    const book = await rawWorkbook({
      sharedStrings: '<si><t>only</t></si>',
      sheets: [{ name: 'S', xml: '<row r="1"><c r="B1" t="s"><v>7</v></c></row>' }],
    });
    await expect(readAll(book, { format: 'xlsx' })).rejects.toThrow(
      /Cell B1 points to shared string 7/,
    );
  });

  it('reads a workbook another program wrote (openpyxl: styles, hidden and merged sheets)', async () => {
    // test/fixtures/openpyxl.xlsx was written by openpyxl 3.1: a bold header, dates before
    // 1900 as negative serials, times, a text-formatted cell, a hidden sheet, merged cells.
    const book = readFileSync(join(import.meta.dirname, 'fixtures/openpyxl.xlsx'));
    const preview = await previewSource(
      fileSource(join(import.meta.dirname, 'fixtures/openpyxl.xlsx')),
      {
        fileName: 'openpyxl.xlsx',
      },
    );
    expect(preview.sheets).toEqual(['People', 'Secret', 'Totals']);
    expect(preview.read?.xlsx).toEqual({ sheet: 'People', headerRow: 1 });
    expect(preview.columns.map((c) => [c.name, c.type])).toEqual([
      ['id', 'integer'],
      ['name', 'text'],
      ['born', 'date'],
      ['last seen', 'timestamp'],
      ['alarm', 'text'],
      ['score', 'decimal'],
      ['active', 'boolean'],
    ]);
    const { rows } = await readAll(book, { format: 'xlsx' });
    expect(rows).toEqual([
      [1, 'Ada Lovelace', '1815-12-10', '2024-01-02 03:04:05', '06:30:00', 9.5, true],
      [
        2,
        'Grace "Amazing" Hopper',
        '1906-12-09',
        '2023-06-07 08:09:10.500',
        '23:59:59',
        8.25,
        false,
      ],
      [3, 'Ünïcödé & <markup>', null, null, null, null, null],
      [4, '  padded  ', '2000-02-29', '1999-12-31 23:59:59', '00:00:01', -0.001, true],
    ]);
    const totals = await readAll(book, { format: 'xlsx', xlsx: { sheet: 'Totals' } });
    expect(totals.rows).toEqual([
      ['sum', 12345678.9],
      ['merged', null],
    ]);
  });

  it('refuses a cell past the last column instead of growing a row without bound', async () => {
    const book = await rawWorkbook({
      sheets: [{ name: 'S', xml: '<row r="4"><c r="ZZZZZZ4"><v>1</v></c></row>' }],
    });
    await expect(readAll(book, { format: 'xlsx' })).rejects.toThrow(
      /Row 4 has a cell past Excel's last column/,
    );
  });

  it('reads malformed worksheet XML as an error with its line', async () => {
    const book = await rawWorkbook({
      sheets: [{ name: 'S', xml: '<row r="1"><c r="A1"><v>1</v></row>' }],
    });
    await expect(readAll(book, { format: 'xlsx' })).rejects.toThrow(/Invalid XML on line 1/);
  });
});

describe('number formats and serial dates', () => {
  it('tells date, time and date-time formats from number formats', () => {
    expect(formatKind('yyyy-mm-dd')).toBe('date');
    expect(formatKind('[$-409]mmmm d, yyyy;@')).toBe('date');
    expect(formatKind('mmm')).toBe('date');
    expect(formatKind('h:mm AM/PM')).toBe('time');
    expect(formatKind('[h]:mm:ss')).toBe('duration');
    expect(formatKind('mm:ss.0')).toBe('time');
    expect(formatKind('d/m/yy h:mm')).toBe('datetime');
    expect(formatKind('General')).toBeUndefined();
    expect(formatKind('0.00E+00')).toBeUndefined();
    expect(formatKind('#,##0 "days"')).toBeUndefined();
    expect(formatKind('[Red][<=100]0;[Blue]0')).toBeUndefined();
    expect(formatKind('\\d0')).toBeUndefined();
    expect(formatKind('@')).toBeUndefined();
  });

  it('turns serials into ISO text, to the millisecond', () => {
    expect(serialToText(61, 'date')).toBe('1900-03-01');
    expect(serialToText(60, 'date')).toBe('1900-02-29');
    expect(serialToText(1, 'date')).toBe('1900-01-01');
    expect(serialToText(2958465, 'date')).toBe('9999-12-31');
    expect(serialToText(2958466, 'date')).toBe(2958466);
    expect(serialToText(45293.000011574, 'datetime')).toBe('2024-01-02 00:00:01');
    expect(serialToText(0.9999999, 'time')).toBe('23:59:59.991');
    expect(serialToText(1.25, 'duration')).toBe('30:00:00');
    // A time format on a date and time shows the time, but the value holds both.
    expect(serialToText(45293.5, 'time')).toBe('2024-01-02 12:00:00');
    expect(serialToText(-1, 'time')).toBe(-1);
  });
});

describe('xlsx fuzz', () => {
  const cell = fc.oneof(
    fc.constant(null),
    fc.integer(),
    fc.double({ noNaN: true, noDefaultInfinity: true }),
    fc.boolean(),
    fc.string({ unit: 'binary', maxLength: 30 }),
  );

  it('round-trips random typed cells through the writer and the reader', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.tuple(cell, cell, cell), { minLength: 1, maxLength: 30 }),
        async (rows) => {
          const columns = [col('a', 'unknown'), col('b', 'unknown'), col('c', 'unknown')];
          const book = await exportXlsx(columns, rows);
          const read = await readAll(book, { format: 'xlsx', xlsx: { headerRow: 1 } });
          const expected = rows
            .map((row) =>
              row.map((value) => (typeof value === 'number' && Object.is(value, -0) ? 0 : value)),
            )
            .filter((row) => row.some((value) => value !== null));
          expect(read.rows).toEqual(expected);
        },
      ),
      { numRuns: 60 },
    );
  });

  it('reads generated workbooks with shared strings and sparse cells, chunked anywhere', async () => {
    const text = fc.string({ maxLength: 12 });
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.array(fc.option(fc.oneof(text, fc.integer()), { nil: null }), {
            minLength: 1,
            maxLength: 5,
          }),
          {
            minLength: 1,
            maxLength: 20,
          },
        ),
        fc.integer({ min: 1, max: 97 }),
        async (grid, chunkSize) => {
          const strings: string[] = [];
          const escape = (s: string): string =>
            s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
          let xml = '';
          grid.forEach((row, r) => {
            let cells = '';
            row.forEach((value, c) => {
              const ref = `${String.fromCharCode(65 + c)}${r + 2}`;
              if (value === null) return;
              if (typeof value === 'number') cells += `<c r="${ref}"><v>${value}</v></c>`;
              else {
                strings.push(value);
                cells += `<c r="${ref}" t="s"><v>${strings.length - 1}</v></c>`;
              }
            });
            xml += `<row r="${r + 2}">${cells}</row>`;
          });
          const valid = strings.every(
            // eslint-disable-next-line no-control-regex
            (s) => !/[\u{0}-\u{1F}\u{D800}-\u{DFFF}\u{FFFE}\u{FFFF}]|_x[0-9A-Fa-f]{4}_/u.test(s),
          );
          fc.pre(valid);
          const book = await rawWorkbook({
            sharedStrings: strings
              .map((s) => `<si><t xml:space="preserve">${escape(s)}</t></si>`)
              .join(''),
            sheets: [{ name: 'S', xml }],
          });
          const read = await readAll(book, { format: 'xlsx', xlsx: { headerRow: 0 } }, chunkSize);
          const expected = grid.filter((row) => row.some((value) => value !== null));
          const used = (row: readonly unknown[]): number =>
            row.reduce<number>((last, value, i) => (value === null ? last : i + 1), 0);
          const width = Math.max(0, ...expected.map(used));
          expect(read.rows).toEqual(
            expected.map((row) => {
              const cut = row.slice(0, width);
              return [...cut, ...new Array<null>(width - cut.length).fill(null)];
            }),
          );
        },
      ),
      { numRuns: 60 },
    );
  });
});
