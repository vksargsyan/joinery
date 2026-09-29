import { gzipSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';

import {
  bytesSource,
  detectCsvOptions,
  detectDelimiter,
  detectEncoding,
  detectHeader,
  formatFromFileName,
  inferColumns,
  parseCsv,
  previewSource,
  sniffFormat,
  type InferredColumn,
} from '../src';

describe('encoding detection', () => {
  it('uses the byte order mark first', () => {
    expect(detectEncoding(new Uint8Array([0xef, 0xbb, 0xbf, 0x61]))).toEqual({
      encoding: 'utf-8',
      bom: true,
    });
    expect(detectEncoding(new Uint8Array([0xff, 0xfe, 0x61, 0]))).toEqual({
      encoding: 'utf-16le',
      bom: true,
    });
    expect(detectEncoding(new Uint8Array([0xfe, 0xff, 0, 0x61]))).toEqual({
      encoding: 'utf-16be',
      bom: true,
    });
  });

  it('recognises UTF-16 without a BOM by its zero bytes', () => {
    expect(detectEncoding(Buffer.from('id,name\n1,a\n', 'utf16le')).encoding).toBe('utf-16le');
    const be = Buffer.from('id,name\n1,a\n', 'utf16le');
    for (let i = 0; i < be.length; i += 2) [be[i], be[i + 1]] = [be[i + 1]!, be[i]!];
    expect(detectEncoding(be).encoding).toBe('utf-16be');
  });

  it('takes valid UTF-8 as UTF-8, even cut mid-character, and anything else as windows-1252', () => {
    const utf8 = Buffer.from('naïve café 😀');
    expect(detectEncoding(utf8).encoding).toBe('utf-8');
    expect(detectEncoding(utf8.subarray(0, utf8.length - 1), false).encoding).toBe('utf-8');
    expect(detectEncoding(utf8.subarray(0, utf8.length - 1), true).encoding).toBe('windows-1252');
    expect(detectEncoding(Buffer.from('café crème', 'latin1')).encoding).toBe('windows-1252');
  });
});

describe('format detection', () => {
  it('reads the format from the file name, ignoring .gz', () => {
    expect(formatFromFileName('/tmp/Data.CSV')).toBe('csv');
    expect(formatFromFileName('rows.jsonl.gz')).toBe('jsonl');
    expect(formatFromFileName('a.ndjson')).toBe('jsonl');
    expect(formatFromFileName('dump.sql')).toBe('sql');
    expect(formatFromFileName('x.tab')).toBe('tsv');
    expect(formatFromFileName('notes.txt')).toBeUndefined();
    expect(formatFromFileName('README')).toBeUndefined();
  });

  it('sniffs JSON, JSON Lines, SQL, TSV and CSV from content', () => {
    expect(sniffFormat('  [{"a":1}]')).toBe('json');
    expect(sniffFormat('{"a":1}\n{"a":2}\n')).toBe('jsonl');
    expect(sniffFormat('{\n  "a": 1\n}')).toBe('json');
    expect(sniffFormat('-- dump\nCREATE TABLE t (id int);\n')).toBe('sql');
    expect(sniffFormat('INSERT INTO t VALUES (1);')).toBe('sql');
    expect(sniffFormat('DELIMITER $$\nCREATE PROCEDURE p() BEGIN END $$\n')).toBe('sql');
    expect(sniffFormat('update,delete\n1,2\n')).toBe('csv');
    expect(sniffFormat('a\tb\n1\t2\n')).toBe('tsv');
    expect(sniffFormat('a;b\n1;2\n')).toBe('csv');
  });
});

describe('delimiter detection', () => {
  it('scores consistency across records and honours quotes', () => {
    expect(detectDelimiter('a,b,c\n1,2,3\n4,5,6\n')).toBe(',');
    expect(detectDelimiter('a;b;c\n1,5;2;3\n4;5,5;6\n')).toBe(';');
    expect(detectDelimiter('a\tb\n"x,y,z"\t2\n')).toBe('\t');
    expect(detectDelimiter('a|b\n1|2\n')).toBe('|');
    expect(detectDelimiter('"q;w",e,r\n1,2,3\n')).toBe(',');
    expect(detectDelimiter('single\ncolumn\n')).toBe(',');
  });

  it('detects the quote and escape characters', () => {
    expect(detectCsvOptions("a,b\n'x,y',2\n").quote).toBe("'");
    expect(detectCsvOptions('a,b\n"x\\"y",2\n').escape).toBe('\\');
    expect(detectCsvOptions('a,b\n"x""y",2\n').escape).toBe('"');
  });
});

describe('header detection', () => {
  const records = (text: string): (string | null)[][] => parseCsv(text, { nullMarker: null });

  it('finds a header by type contrast', () => {
    expect(detectHeader(records('id,price,when\n1,2.5,2024-01-01\n2,3,2024-01-02\n'))).toBe(true);
    expect(detectHeader(records('1,2.5,2024-01-01\n2,3,2024-01-02\n'))).toBe(false);
    expect(detectHeader(records('true,1\nfalse,2\n'))).toBe(false);
  });

  it('uses length contrast and uniqueness for text-only files', () => {
    expect(detectHeader(records('code,country\nAB,France\nCD,Spain\n'))).toBe(true);
    expect(detectHeader(records('name,city\nAlice,Paris\nBob,Rome\n'))).toBe(true);
    expect(detectHeader(records('x,y\nx,z\n'))).toBe(false);
  });

  it('decides single-record samples by whether they look like names', () => {
    expect(detectHeader(records('id,name\n'))).toBe(true);
    expect(detectHeader(records('1,Alice\n'))).toBe(false);
  });
});

describe('type inference', () => {
  const infer = (values: (string | null)[]): InferredColumn =>
    inferColumns(
      ['c'],
      values.map((v) => [v]),
    )[0]!;

  it('infers numbers, from integer to float', () => {
    expect(infer(['1', '-20', null]).type).toBe('integer');
    expect(infer(['1', '3000000000']).type).toBe('bigint');
    expect(infer(['1', '9223372036854775808'])).toMatchObject({
      type: 'decimal',
      precision: 19,
      scale: 0,
    });
    expect(infer(['1.5', '-22.25', '3'])).toMatchObject({
      type: 'decimal',
      precision: 4,
      scale: 2,
    });
    expect(infer(['0.001'])).toMatchObject({ type: 'decimal', precision: 3, scale: 3 });
    expect(infer(['1.5', '1e-300']).type).toBe('float');
    expect(infer(['NaN', '1']).type).toBe('float');
    expect(infer(['007']).type).toBe('text');
  });

  it('infers booleans, dates, timestamps, uuids and JSON', () => {
    expect(infer(['true', 'False', 'yes']).type).toBe('boolean');
    expect(infer(['0', '1']).type).toBe('integer');
    expect(infer(['2024-02-29', '2023-12-31'])).toMatchObject({ type: 'date', dateOrder: 'ymd' });
    expect(infer(['2023-02-29']).type).toBe('text');
    expect(infer(['31/12/2024', '01/02/2024'])).toMatchObject({ type: 'date', dateOrder: 'dmy' });
    expect(infer(['12/31/2024'])).toMatchObject({ type: 'date', dateOrder: 'mdy' });
    expect(infer(['2024-01-02 03:04:05', '2024-01-02'])).toMatchObject({
      type: 'timestamp',
      fractionalDigits: 0,
      withTimeZone: false,
    });
    expect(infer(['2024-01-02T03:04:05.123Z', '2024-01-02 03:04:05+02:00'])).toMatchObject({
      type: 'timestamp',
      fractionalDigits: 3,
      withTimeZone: true,
    });
    expect(infer(['2024-01-02 25:00:00']).type).toBe('text');
    expect(infer(['0b5e4b9c-6f1e-4c8e-9d7a-2a1c3e4f5a6b']).type).toBe('uuid');
    expect(infer(['{"a":1}', '[1,2]']).type).toBe('json');
    expect(infer(['{not json']).type).toBe('text');
  });

  it('tracks nulls, empties and the longest value', () => {
    expect(infer([null, '', 'abc', 'abcdef'])).toMatchObject({
      type: 'text',
      nullable: true,
      maxLength: 6,
      samples: 2,
    });
    expect(infer([null, null])).toMatchObject({ type: 'text', nullable: true, samples: 0 });
  });

  it('infers JSON-source values the same way as their text', () => {
    const [ints, decs, nested, bools] = inferColumns(
      ['i', 'd', 'n', 'b'],
      [
        [1, { $json: '1.50' }, { $json: '{"a":1}' }, true],
        [9007199254740993n, 2.25, { $json: '[1]' }, false],
      ],
    );
    expect(ints!.type).toBe('bigint');
    expect(decs).toMatchObject({ type: 'decimal', scale: 2 });
    expect(nested!.type).toBe('json');
    expect(bools!.type).toBe('boolean');
  });
});

describe('previewSource', () => {
  it('detects everything about a CSV and samples its rows', async () => {
    const csv = 'id;price;name\n1;2,5;"a;b"\n2;3;\n';
    const preview = await previewSource(bytesSource(csv), { sampleRows: 10 });
    expect(preview).toMatchObject({
      format: 'csv',
      compression: 'none',
      encoding: 'utf-8',
      bom: false,
      complete: true,
    });
    expect(preview.read?.csv).toMatchObject({
      delimiter: ';',
      header: true,
      quote: '"',
      nullMarker: '',
    });
    expect(preview.columns.map((c) => [c.name, c.type])).toEqual([
      ['id', 'integer'],
      ['price', 'text'],
      ['name', 'text'],
    ]);
    expect(preview.rows).toEqual([
      ['1', '2,5', 'a;b'],
      ['2', '3', null],
    ]);
  });

  it('previews a gzipped TSV from a sample that cuts a record', async () => {
    const lines = ['id\tamount\twhen'];
    for (let i = 1; i <= 5000; i++) lines.push(`${i}\t${i}.25\t2024-01-0${(i % 9) + 1} 10:00:00`);
    const preview = await previewSource(bytesSource(gzipSync(lines.join('\n')), 1000), {
      sampleRows: 50,
      sampleBytes: 4096,
    });
    expect(preview).toMatchObject({ format: 'tsv', compression: 'gzip', complete: false });
    expect(preview.rows).toHaveLength(50);
    expect(preview.columns.map((c) => c.type)).toEqual(['integer', 'decimal', 'timestamp']);
  });

  it('previews JSON and JSON Lines, and SQL statements', async () => {
    const json = await previewSource(bytesSource('[{"a":1,"b":{"x":[1]}},{"a":2.5}]'));
    expect(json.format).toBe('json');
    expect(json.columns.map((c) => [c.name, c.type])).toEqual([
      ['a', 'decimal'],
      ['b', 'json'],
    ]);
    const lines = await previewSource(bytesSource('{"a":"2024-01-01"}\n{"a":"2024-01-02"}\n'));
    expect(lines.format).toBe('jsonl');
    expect(lines.columns[0]!.type).toBe('date');
    const sql = await previewSource(
      bytesSource('CREATE TABLE t (a int);\nINSERT INTO t VALUES (1);'),
    );
    expect(sql.format).toBe('sql');
    expect(sql.statements).toEqual(['CREATE TABLE t (a int)', 'INSERT INTO t VALUES (1)']);
  });

  it('stops reading when cancelled', async () => {
    const controller = new AbortController();
    let chunks = 0;
    const source = {
      async *[Symbol.asyncIterator]() {
        for (;;) {
          if (++chunks === 3) controller.abort();
          yield new TextEncoder().encode('a,b\n1,2\n');
        }
      },
    };
    await expect(previewSource(source, { signal: controller.signal })).rejects.toThrow(/cancelled/);
    expect(chunks).toBe(3);
  });

  it('keeps the options the caller fixed', async () => {
    const preview = await previewSource(bytesSource('1,2\n3,4\n'), {
      format: 'csv',
      csv: { header: true, nullMarker: 'NULL' },
    });
    expect(preview.columns.map((c) => c.name)).toEqual(['1', '2']);
    expect(preview.read?.csv).toMatchObject({ header: true, nullMarker: 'NULL' });
  });
});
