import { gzipSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';

import {
  bytesSource,
  jsonText,
  readRows,
  type ByteSource,
  type ReadOptions,
  type RowBatch,
} from '../src';

async function readAll(
  source: ByteSource,
  options: ReadOptions,
): Promise<{
  columns: readonly string[];
  rows: unknown[][];
  numbers: number[];
  lines: number[];
  rejected: RowBatch['rejected'][number][];
}> {
  let columns: readonly string[] = [];
  const rows: unknown[][] = [];
  const numbers: number[] = [];
  const lines: number[] = [];
  const rejected: RowBatch['rejected'][number][] = [];
  for await (const batch of readRows(source, options)) {
    columns = batch.columns;
    rows.push(...batch.rows.map((r) => [...r]));
    numbers.push(...batch.rowNumbers);
    lines.push(...batch.lines);
    rejected.push(...batch.rejected);
  }
  return { columns, rows, numbers, lines, rejected };
}

function encode(
  text: string,
  encoding: 'utf16le' | 'utf16be' | 'latin1',
  bom: boolean,
): Uint8Array {
  if (encoding === 'utf16be') {
    const le = Buffer.from((bom ? '\ufeff' : '') + text, 'utf16le');
    for (let i = 0; i < le.length; i += 2) [le[i], le[i + 1]] = [le[i + 1]!, le[i]!];
    return le;
  }
  return Buffer.from((bom && encoding === 'utf16le' ? '\ufeff' : '') + text, encoding);
}

describe('readRows', () => {
  it('reads CSV with a header, numbering rows and lines', async () => {
    const csv = 'id,name\n1,"multi\nline"\n2,\n3,x,extra\n';
    const out = await readAll(bytesSource(csv, 5), { format: 'csv' });
    expect(out.columns).toEqual(['id', 'name', 'column3']);
    expect(out.rows).toEqual([
      ['1', 'multi\nline'],
      ['2', null],
      ['3', 'x', 'extra'],
    ]);
    expect(out.numbers).toEqual([1, 2, 3]);
    expect(out.lines).toEqual([2, 4, 5]);
  });

  it('names columns of a headerless file and dedupes header names', async () => {
    expect(
      (await readAll(bytesSource('1,2\n'), { format: 'csv', csv: { header: false } })).columns,
    ).toEqual(['column1', 'column2']);
    expect((await readAll(bytesSource('a, a ,A,\n'), { format: 'csv' })).columns).toEqual([
      'a',
      'a_2',
      'A_3',
      'column4',
    ]);
  });

  it('reads TSV with a tab delimiter by default', async () => {
    const out = await readAll(bytesSource('a\tb\n1\t"x\ty"\n'), { format: 'tsv' });
    expect(out.rows).toEqual([['1', 'x\ty']]);
  });

  it('decodes UTF-8 with a BOM, UTF-16 LE/BE and windows-1252', async () => {
    const text = 'name\nGrüße 😀\n';
    const bom = new Uint8Array([0xef, 0xbb, 0xbf, ...Buffer.from(text)]);
    expect((await readAll(bytesSource(bom, 2), { format: 'csv' })).rows).toEqual([['Grüße 😀']]);
    for (const encoding of ['utf16le', 'utf16be'] as const) {
      for (const withBom of [true, false]) {
        const out = await readAll(bytesSource(encode(text, encoding, withBom), 3), {
          format: 'csv',
        });
        expect(out.columns).toEqual(['name']);
        expect(out.rows).toEqual([['Grüße 😀']]);
      }
    }
    const latin = encode('name\ncafé\n', 'latin1', false);
    expect((await readAll(bytesSource(latin), { format: 'csv' })).rows).toEqual([['café']]);
    expect(
      (await readAll(bytesSource(latin), { format: 'csv', encoding: 'iso-8859-1' })).rows,
    ).toEqual([['café']]);
  });

  it('reads gzip transparently', async () => {
    const out = await readAll(bytesSource(gzipSync('a\n1\n2\n'), 4), { format: 'csv' });
    expect(out.rows).toEqual([['1'], ['2']]);
  });

  it('reads a JSON array of objects: columns by first appearance, missing keys NULL', async () => {
    const json = '[{"id":1,"tags":["a"]},\n{"name":"x","id":2}]';
    const out = await readAll(bytesSource(json, 3), { format: 'json' });
    expect(out.columns).toEqual(['id', 'tags', 'name']);
    expect(out.rows).toEqual([
      [1, jsonText('["a"]')],
      [2, null, 'x'],
    ]);
    expect(out.lines).toEqual([1, 2]);
  });

  it('reads arrays positionally and scalars into a value column', async () => {
    const out = await readAll(bytesSource('[[1,2],[3,4,5]]'), { format: 'json' });
    expect(out.columns).toEqual(['column1', 'column2', 'column3']);
    expect(out.rows).toEqual([
      [1, 2],
      [3, 4, 5],
    ]);
    expect((await readAll(bytesSource('[1,"a"]'), { format: 'json' })).rows).toEqual([[1], ['a']]);
  });

  it('reads JSON Lines and reports bad lines in row order', async () => {
    const out = await readAll(bytesSource('{"a":1}\n{bad\n{"a":3}\n', 4), { format: 'jsonl' });
    expect(out.rows).toEqual([[1], [3]]);
    expect(out.numbers).toEqual([1, 3]);
    expect(out.rejected).toHaveLength(1);
    expect(out.rejected[0]).toMatchObject({ row: 2, line: 2 });
  });

  it('throws on malformed JSON arrays and unterminated CSV quotes', async () => {
    await expect(readAll(bytesSource('[{"a":1},]x'), { format: 'json' })).rejects.toThrow(
      /Invalid JSON/,
    );
    await expect(readAll(bytesSource('a\n"x'), { format: 'csv' })).rejects.toThrow(/Unterminated/);
  });

  it('closes the source when the consumer stops early', async () => {
    let closed = false;
    const source: ByteSource = {
      async *[Symbol.asyncIterator]() {
        try {
          for (let i = 0; i < 1000; i++) yield new TextEncoder().encode(`${i}\n`);
        } finally {
          closed = true;
        }
      },
    };
    for await (const batch of readRows(source, { format: 'csv', csv: { header: false } })) {
      expect(batch.rows.length).toBeGreaterThan(0);
      break;
    }
    expect(closed).toBe(true);
  });
});
