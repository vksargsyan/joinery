import type { CellValue } from '@querybara/core';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  bytesSource,
  detectRowPaths,
  exportRows,
  memorySink,
  previewSource,
  xmlEncoding,
} from '../src';
import { FakeSession } from './fake-session';
import { col, readAll } from './xlsx-helpers';

describe('XML rows', () => {
  it('reads attributes and child elements as columns, in order of first appearance', async () => {
    const xml = `<?xml version="1.0"?>
<orders xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <order id="1" status="new">
    <customer>Ada</customer>
    <total currency="EUR">12.50</total>
    <note xsi:nil="true"/>
  </order>
  <order id="2">
    <customer>Grace &amp; co</customer>
    <note></note>
    <gift>yes</gift>
  </order>
</orders>
`;
    const { columns, rows, lines } = await readAll(xml, {
      format: 'xml',
      xml: { rowPath: '/orders/order' },
    });
    expect(columns).toEqual([
      'id',
      'status',
      'customer',
      'total',
      'total@currency',
      'note',
      'gift',
    ]);
    expect(rows).toEqual([
      ['1', 'new', 'Ada', '12.50', 'EUR', null, null],
      ['2', null, 'Grace & co', null, null, '', 'yes'],
    ]);
    expect(lines).toEqual([3, 8]);
  });

  it('keeps nested elements as markup, numbers repeated names and reads a text-only row', async () => {
    const xml =
      '<people><person><name>Ada</name><address><city>London</city><zip a="1">N1</zip></address><tag>x</tag><tag>y &lt; z</tag></person><person>Grace</person></people>';
    const { columns, rows } = await readAll(xml, {
      format: 'xml',
      xml: { rowPath: 'people/person' },
    });
    expect(columns).toEqual(['name', 'address', 'tag', 'tag_2', 'person']);
    expect(rows).toEqual([
      ['Ada', '<city>London</city><zip a="1">N1</zip>', 'x', 'y < z', null],
      [null, null, null, null, 'Grace'],
    ]);
  });

  it('decodes SQL/XML escaped names and keeps prefixes', async () => {
    const xml =
      '<r xmlns:dc="urn:dc"><row><Order_x0020_No>7</Order_x0020_No><dc:title>T</dc:title></row></r>';
    const { columns, rows } = await readAll(xml, { format: 'xml', xml: { rowPath: '/r/row' } });
    expect(columns).toEqual(['Order No', 'dc:title']);
    expect(rows).toEqual([['7', 'T']]);
  });

  it('finds no rows at a path that is not there, and rejects malformed XML with its line', async () => {
    expect(
      (await readAll('<a><b/></a>', { format: 'xml', xml: { rowPath: '/a/c' } })).rows,
    ).toEqual([]);
    await expect(
      readAll('<a>\n<b>1</b>\n<b>2</c>\n</a>', { format: 'xml', xml: { rowPath: '/a/b' } }),
    ).rejects.toThrow(/Invalid XML on line 3: expected <\/b> but found <\/c>/);
  });

  it('stops at an unbounded number of columns (a wrong row path) instead of growing rows', async () => {
    const xml = `<r><row>${'<v>1</v>'.repeat(20_000)}</row></r>`;
    await expect(readAll(xml, { format: 'xml', xml: { rowPath: '/r/row' } })).rejects.toThrow(
      /more than 16384 columns/,
    );
  });

  it('detects the row path when none is given', async () => {
    const { columns, rows } = await readAll('<list><item a="1"/><item a="2"/></list>', {
      format: 'xml',
    });
    expect(columns).toEqual(['a']);
    expect(rows).toEqual([['1'], ['2']]);
  });

  it('reads the same rows however the file is chunked', async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?><d>${Array.from(
      { length: 40 },
      (_, i) => `<r n="${i}"><v>é${i}&amp;</v><w><![CDATA[<${i}>]]></w></r>`,
    ).join('\r\n')}</d>`;
    const whole = await readAll(xml, { format: 'xml', xml: { rowPath: '/d/r' } });
    expect(whole.rows).toHaveLength(40);
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 300 }), async (chunk) => {
        const read = await readAll(xml, { format: 'xml', xml: { rowPath: '/d/r' } }, chunk);
        expect(read.rows).toEqual(whole.rows);
        expect(read.lines).toEqual(whole.lines);
      }),
      { numRuns: 40 },
    );
  });
});

describe('XML row path detection', () => {
  it.each([
    [
      'repeated records',
      '<orders><order><id>1</id></order><order><id>2</id></order></orders>',
      '/orders/order',
    ],
    [
      'one record',
      '<export><table name="t"><row><a>1</a><b>2</b></row></table></export>',
      '/export/table/row',
    ],
    ['attribute rows', '<rows><r id="1"/><r id="2"/><r id="3"/></rows>', '/rows/r'],
    ['a list of values', '<ids><id>1</id><id>2</id><id>3</id></ids>', '/ids/id'],
    [
      'records with nested parts',
      '<p><person><name>A</name><address><city>X</city></address></person><person><name>B</name><address><city>Y</city></address></person></p>',
      '/p/person',
    ],
    ['a lone element', '<value>42</value>', '/value'],
  ])('finds %s', (_what, xml, path) => {
    expect(detectRowPaths(xml, true)[0]?.path).toBe(path);
  });

  it('ranks candidates by how often they occur', () => {
    const candidates = detectRowPaths(
      '<db><users><user id="1"/><user id="2"/></users><groups><group id="1"/></groups></db>',
      true,
    );
    expect(candidates.map((c) => [c.path, c.count])).toEqual([
      ['/db/users/user', 2],
      ['/db/groups/group', 1],
    ]);
  });
});

describe('XML preview', () => {
  it('detects the format, the row path and the column types', async () => {
    const xml =
      '<?xml version="1.0"?><products><product sku="A-1"><price>19.99</price><added>2024-01-02</added></product><product sku="B-2"><price>4.50</price><added>2024-02-03</added></product></products>';
    const preview = await previewSource(bytesSource(xml), { fileName: 'products.xml' });
    expect(preview.format).toBe('xml');
    expect(preview.read).toEqual({
      format: 'xml',
      encoding: 'utf-8',
      decompress: 'none',
      xml: { rowPath: '/products/product' },
    });
    expect(preview.rowPaths?.[0]).toEqual({ path: '/products/product', count: 2, fields: 3 });
    expect(preview.columns.map((c) => [c.name, c.type])).toEqual([
      ['sku', 'text'],
      ['price', 'decimal'],
      ['added', 'date'],
    ]);
    const sniffed = await previewSource(bytesSource(xml), {});
    expect(sniffed.format).toBe('xml');
    const chosen = await previewSource(bytesSource(xml), { xml: { rowPath: '/products' } });
    expect(chosen.columns.map((c) => c.name)).toEqual([
      'product',
      'product@sku',
      'product_2',
      'product_2@sku',
    ]);
  });

  it('takes the encoding from the declaration or the byte order mark', async () => {
    const latin1 = Buffer.from(
      '<?xml version="1.0" encoding="ISO-8859-1"?><r><v>café</v></r>',
      'latin1',
    );
    expect(xmlEncoding(latin1)).toBe('windows-1252');
    expect((await readAll(latin1, { format: 'xml' })).rows).toEqual([['café']]);
    const preview = await previewSource(bytesSource(latin1), {});
    expect(preview.encoding).toBe('windows-1252');
    expect(preview.rows).toEqual([['café']]);
    const utf16 = Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from('<?xml version="1.0" encoding="UTF-16"?><r><v>ü</v></r>', 'utf16le'),
    ]);
    expect(xmlEncoding(utf16)).toBe('utf-16le');
    expect((await readAll(utf16, { format: 'xml' })).rows).toEqual([['ü']]);
  });
});

describe('XML export round trip', () => {
  it('reads back what the XML export writes, names and values exact', async () => {
    const session = new FakeSession('postgres');
    const rows: CellValue[][] = [
      [1, 'plain', '12.50', true, null, new Uint8Array([1, 2])],
      [2, '<tag> & "quotes"\nline\r\nCR', '-0.001', false, '', new Uint8Array([])],
      [3, '  spaced  ', null, null, 'x', null],
    ];
    session.result = {
      columns: [
        col('id', 'integer'),
        col('Order Name', 'string'),
        col('amount', 'decimal'),
        col('ok', 'boolean'),
        col('xmlnote', 'string'),
        col('bin', 'binary'),
      ],
      rows,
    };
    const sink = memorySink();
    const summary = await exportRows({ session, query: 'SELECT 1', format: 'xml', sink });
    expect(summary.status).toBe('completed');
    const text = sink.text();
    expect(text).toContain(
      '<Order_x0020_Name>&lt;tag&gt; &amp; "quotes"\nline&#13;\nCR</Order_x0020_Name>',
    );
    expect(text).toContain('<_x0078_mlnote xsi:nil="true"/>');
    const read = await readAll(text, { format: 'xml' });
    expect(read.columns).toEqual(['id', 'Order Name', 'amount', 'ok', 'xmlnote', 'bin']);
    expect(read.rows).toEqual([
      ['1', 'plain', '12.50', 'true', null, '\\x0102'],
      ['2', '<tag> & "quotes"\nline\r\nCR', '-0.001', 'false', '', '\\x'],
      ['3', '  spaced  ', null, null, 'x', null],
    ]);
  });
});
