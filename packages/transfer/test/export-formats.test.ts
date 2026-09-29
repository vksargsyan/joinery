import type { CellValue, ColumnMeta } from '@joinery/core';
import { describe, expect, it } from 'vitest';

import {
  ZipReader,
  exportFileName,
  exportRows,
  exportTables,
  markdownCell,
  memoryReader,
  memorySink,
  type ExportFormat,
  type Sink,
} from '../src';
import { FakeSession } from './fake-session';
import { col, readAll } from './xlsx-helpers';

const COLUMNS: ColumnMeta[] = [
  col('id', 'integer'),
  col('Name | Title', 'string'),
  col('price', 'decimal'),
  col('bin', 'binary'),
];

const ROWS: CellValue[][] = [
  [
    1,
    '<script>alert("x")</script> & *bold* _i_ `code` [link](u) ~s~ \\',
    '12.50',
    new Uint8Array([0xab]),
  ],
  [2, 'two\r\nlines | pipe', null, null],
];

function session(rows: CellValue[][] = ROWS): FakeSession {
  const s = new FakeSession('postgres');
  s.result = { columns: COLUMNS, rows };
  return s;
}

async function text(format: ExportFormat, rows?: CellValue[][]): Promise<string> {
  const sink = memorySink();
  const summary = await exportRows({ session: session(rows), query: 'SELECT 1', format, sink });
  expect(summary.status).toBe('completed');
  return sink.text();
}

describe('XML export', () => {
  it('writes the documented shape with escaped names and values', async () => {
    expect(await text('xml')).toBe(
      [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<export xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">',
        '  <table name="query_result">',
        '    <row>',
        '      <id>1</id>',
        '      <Name_x0020__x007C__x0020_Title>&lt;script&gt;alert("x")&lt;/script&gt; &amp; *bold* _i_ `code` [link](u) ~s~ \\</Name_x0020__x007C__x0020_Title>',
        '      <price>12.50</price>',
        '      <bin>\\xab</bin>',
        '    </row>',
        '    <row>',
        '      <id>2</id>',
        '      <Name_x0020__x007C__x0020_Title>two&#13;',
        'lines | pipe</Name_x0020__x007C__x0020_Title>',
        '      <price xsi:nil="true"/>',
        '      <bin xsi:nil="true"/>',
        '    </row>',
        '  </table>',
        '</export>',
        '',
      ].join('\n'),
    );
  });

  it('writes UTF-16 with its byte order mark and declaration', async () => {
    const sink = memorySink();
    await exportRows({
      session: session(),
      query: 'SELECT 1',
      format: 'xml',
      encoding: 'utf-16le',
      sink,
    });
    const bytes = sink.bytes();
    expect([bytes[0], bytes[1]]).toEqual([0xff, 0xfe]);
    expect(sink.text('utf-16le')).toContain('encoding="UTF-16"');
    expect((await readAll(bytes, { format: 'xml' })).rows).toHaveLength(2);
  });
});

describe('HTML export', () => {
  it('writes a self-contained page with escaped text, numbers right-aligned and NULL marked', async () => {
    const html = await text('html');
    expect(
      html.startsWith('<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="utf-8">'),
    ).toBe(true);
    expect(html).toContain('<title>query_result</title>');
    expect(html).not.toMatch(/<(?:script|link|img)\b/);
    expect(html).toContain(
      '<thead><tr><th class="num">id</th><th>Name | Title</th><th class="num">price</th><th>bin</th></tr></thead>',
    );
    expect(html).toContain(
      '<td>&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; *bold* _i_ `code` [link](u) ~s~ \\</td>',
    );
    expect(html).toContain('<td class="null">NULL</td>');
    expect(html).toContain('<p class="count">2 rows</p>');
    expect(html.endsWith('</body>\n</html>\n')).toBe(true);
  });
});

describe('Markdown export', () => {
  it('writes a pipe table with Markdown syntax escaped', async () => {
    expect(await text('markdown')).toBe(
      [
        '| id | Name \\| Title | price | bin |',
        '| ---: | --- | ---: | --- |',
        '| 1 | \\<script\\>alert("x")\\</script\\> \\& \\*bold\\* \\_i\\_ \\`code\\` \\[link\\](u) \\~s\\~ \\\\ | 12.50 | \\\\xab |',
        '| 2 | two<br>lines \\| pipe | NULL | NULL |',
        '',
      ].join('\n'),
    );
    expect(markdownCell('a\nb\r\nc\rd')).toBe('a<br>b<br>c<br>d');
    // An underscore inside a word cannot start emphasis, so it stays readable.
    expect(markdownCell('full_name _x_ snake_')).toBe('full_name \\_x\\_ snake\\_');
  });

  it('writes the header of an empty result', async () => {
    expect(await text('markdown', [])).toBe(
      '| id | Name \\| Title | price | bin |\n| ---: | --- | ---: | --- |\n',
    );
  });
});

describe('combined files', () => {
  async function combined(format: ExportFormat): Promise<string> {
    const sink = memorySink();
    const summary = await exportTables({
      session: session(),
      tables: [{ name: 'orders' }, { name: 'items' }],
      format,
      output: { kind: 'combined', sink },
    });
    expect(summary).toMatchObject({ status: 'completed', rowsWritten: 4 });
    return sink.text();
  }

  it('puts each table in its own <table>, section or heading', async () => {
    const xml = await combined('xml');
    expect(xml.match(/<table name="(\w+)">/g)).toEqual([
      '<table name="orders">',
      '<table name="items">',
    ]);
    expect((await readAll(xml, { format: 'xml' })).rows).toHaveLength(4);
    const html = await combined('html');
    expect(html).toContain('<title>Exported tables</title>');
    expect(html.match(/<h2>\w+<\/h2>/g)).toEqual(['<h2>orders</h2>', '<h2>items</h2>']);
    const markdown = await combined('markdown');
    expect(markdown.startsWith('## orders\n\n| id |')).toBe(true);
    expect(markdown).toContain('\n\n## items\n\n| id |');
  });

  it('refuses a combined CSV, TSV or JSON Lines file', async () => {
    for (const format of ['csv', 'tsv', 'jsonl'] as const) {
      await expect(
        exportTables({
          session: session(),
          tables: [{ name: 'a' }],
          format,
          output: { kind: 'combined', sink: memorySink() },
        }),
      ).rejects.toThrow(/one file per table/);
    }
  });
});

describe('ZIP output', () => {
  it('writes a file per table into one archive, with unique names', async () => {
    const sink = memorySink();
    const summary = await exportTables({
      session: session(),
      tables: [{ name: 'orders' }, { name: 'Orders' }, { name: 'a/b' }],
      format: 'csv',
      output: { kind: 'zip', sink },
    });
    expect(summary).toMatchObject({ status: 'completed', rowsWritten: 6 });
    expect(summary.files).toEqual(['orders.csv', 'Orders_2.csv', 'a_b.csv']);
    expect(summary.bytesWritten).toBe(sink.bytes().length);
    const zip = await ZipReader.open(memoryReader(sink.bytes()));
    expect(zip.entries.map((e) => e.name)).toEqual(['orders.csv', 'Orders_2.csv', 'a_b.csv']);
    expect((await zip.text(zip.entry('a_b.csv')!)).split('\r\n')[0]).toBe(
      'id,Name | Title,price,bin',
    );
    await zip.close();
  });

  it('abandons the archive when a table fails', async () => {
    const failing = session();
    let calls = 0;
    const execute = failing.execute.bind(failing);
    failing.execute = (text, options) => {
      if (++calls === 2) throw new Error('table two is gone');
      return execute(text, options);
    };
    let aborted = false;
    const inner = memorySink();
    const sink: Sink = { ...inner, abort: async () => void (aborted = true) };
    const summary = await exportTables({
      session: failing,
      tables: [{ name: 'one' }, { name: 'two' }],
      format: 'json',
      output: { kind: 'zip', sink },
    });
    expect(summary.status).toBe('failed');
    expect(summary.errors[0]?.message).toBe('table two is gone');
    expect(aborted).toBe(true);
  });

  it('zips a single export as one entry', async () => {
    const sink = memorySink();
    const summary = await exportRows({
      session: session(),
      query: 'SELECT 1',
      format: 'markdown',
      sink,
      zipEntry: 'result.md',
    });
    expect(summary).toMatchObject({ status: 'completed', bytesWritten: sink.bytes().length });
    const zip = await ZipReader.open(memoryReader(sink.bytes()));
    expect(zip.entries.map((e) => e.name)).toEqual(['result.md']);
    expect((await zip.text(zip.entry('result.md')!)).startsWith('| id |')).toBe(true);
    await zip.close();
  });

  it('names files after tables with the format extension', () => {
    expect(exportFileName('orders', 'markdown')).toBe('orders.md');
    expect(exportFileName('orders', 'xlsx')).toBe('orders.xlsx');
    expect(exportFileName('a:b*c', 'html', true)).toBe('a_b_c.html.gz');
    expect(exportFileName('..hidden', 'xml')).toBe('_hidden.xml');
  });
});
