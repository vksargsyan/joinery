import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { CsvFormatter, CsvParser, parseCsv, type CsvField, type CsvParseOptions } from '../src';

/** Parses `text` pushed in the given chunk sizes (cycled), with lines. */
function parseChunked(
  text: string,
  sizes: readonly number[],
  options: CsvParseOptions = {},
): { records: CsvField[][]; lines: number[] } {
  const parser = new CsvParser(options);
  const records: CsvField[][] = [];
  const lines: number[] = [];
  let at = 0;
  let i = 0;
  while (at < text.length) {
    const size = Math.max(1, sizes[i++ % sizes.length] ?? 1);
    const out = parser.push(text.slice(at, at + size));
    records.push(...out.records);
    lines.push(...out.lines);
    at += size;
  }
  const out = parser.end();
  records.push(...out.records);
  lines.push(...out.lines);
  return { records, lines };
}

describe('CSV parser (RFC 4180)', () => {
  it('parses plain records with CRLF, LF and lone CR line breaks', () => {
    expect(parseCsv('a,b\r\nc,d\ne,f\rg,h')).toEqual([
      ['a', 'b'],
      ['c', 'd'],
      ['e', 'f'],
      ['g', 'h'],
    ]);
  });

  it('handles quoted delimiters, doubled quotes and quoted line breaks', () => {
    const text = '"a,1","say ""hi""","line\r\nbreak",plain\n"x\ny",z,"",\n';
    expect(parseCsv(text, { nullMarker: null })).toEqual([
      ['a,1', 'say "hi"', 'line\r\nbreak', 'plain'],
      ['x\ny', 'z', '', ''],
    ]);
  });

  it('tells NULL (unquoted empty) from an empty string (quoted)', () => {
    expect(parseCsv('1,,""\n')).toEqual([['1', null, '']]);
    expect(parseCsv('1,NULL,"NULL"\n', { nullMarker: 'NULL' })).toEqual([['1', null, 'NULL']]);
    expect(parseCsv('1,,x\n', { nullMarker: null })).toEqual([['1', '', 'x']]);
  });

  it('supports backslash escapes inside and outside quotes, and \\N as NULL', () => {
    const options = { escape: '\\', nullMarker: '\\N' };
    expect(parseCsv('"a\\"b",c\\,d,\\N,"\\\\"\n', options)).toEqual([['a"b', 'c,d', null, '\\']]);
    expect(parseCsv('x\\\ny,2\n', options)).toEqual([['x\ny', '2']]);
    // A literal backslash-N is escaped on the way out, so it is not the marker.
    expect(parseCsv('\\\\N\n', options)).toEqual([['\\N']]);
  });

  it('supports other delimiters and quote characters, or no quoting at all', () => {
    expect(parseCsv("a;'b;c';'it''s'\n", { delimiter: ';', quote: "'" })).toEqual([
      ['a', 'b;c', "it's"],
    ]);
    expect(parseCsv('a\t"b\tc\n', { delimiter: '\t', quote: null })).toEqual([['a', '"b', 'c']]);
  });

  it('is lenient with text after a closing quote and quotes inside unquoted fields', () => {
    expect(parseCsv('"ab"c,d"e\n')).toEqual([['abc', 'd"e']]);
  });

  it('keeps a last record without a line break and a trailing empty field', () => {
    expect(parseCsv('a,b\nc,')).toEqual([
      ['a', 'b'],
      ['c', null],
    ]);
  });

  it('skips empty lines except in single-column files', () => {
    expect(parseCsv('\n\na,b\n\nc,d\n\n')).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ]);
    expect(parseCsv('a\n\nb\n')).toEqual([['a'], [null], ['b']]);
    expect(parseCsv('a,b\n\nc,d\n', { emptyLines: 'keep' })).toEqual([
      ['a', 'b'],
      [null],
      ['c', 'd'],
    ]);
  });

  it('reports the line each record starts on, counting quoted line breaks once', () => {
    const text = 'h1,h2\r\n"multi\r\nline",x\r\n\r\nlast,y\r\n';
    const { records, lines } = parseChunked(text, [1000]);
    expect(records).toHaveLength(3);
    expect(lines).toEqual([1, 2, 5]);
  });

  it('fails clearly on an unterminated quote', () => {
    expect(() => parseCsv('a,"open\nstill open')).toThrow(/Unterminated quoted field.*line 1/);
  });

  it('guards against one field swallowing the file', () => {
    const parser = new CsvParser({ maxFieldLength: 10 });
    expect(() => parser.push('"' + 'x'.repeat(20))).toThrow(/longer than 10/);
  });

  it('rejects ambiguous dialects', () => {
    expect(() => new CsvParser({ delimiter: '"' })).toThrow(/must differ/);
    expect(() => new CsvParser({ delimiter: ',,' })).toThrow(/single character/);
  });

  it('gives the same result however the text is chunked, even between CR and LF', () => {
    const text = 'a,"b\r\n""c""",\\N\r\n"x",y\r\n\r\nz,"",w\r';
    const whole = parseChunked(text, [text.length], { escape: '\\', nullMarker: '\\N' });
    for (let size = 1; size <= 7; size++) {
      expect(parseChunked(text, [size], { escape: '\\', nullMarker: '\\N' })).toEqual(whole);
    }
    const doubled = parseChunked(text, [text.length]);
    for (let size = 1; size <= 7; size++) expect(parseChunked(text, [size])).toEqual(doubled);
  });
});

describe('CSV writer', () => {
  it('quotes only what needs it and writes NULL as the unquoted marker', () => {
    const f = new CsvFormatter({ lineEnding: '\n' });
    expect(f.record(['a', 'b,c', 'say "hi"', 'x\ny', '', null])).toBe(
      'a,"b,c","say ""hi""","x\ny","",\n',
    );
  });

  it('supports the all, non-numeric and none policies', () => {
    expect(new CsvFormatter({ quoting: 'all', lineEnding: '\n' }).record(['1', 'a', null])).toBe(
      '"1","a",\n',
    );
    expect(
      new CsvFormatter({ quoting: 'non-numeric', lineEnding: '\r\n' }).record(
        ['1', 'a'],
        [true, false],
      ),
    ).toBe('1,"a"\r\n');
    expect(
      new CsvFormatter({ quoting: 'none', escape: '\\', delimiter: '\t' }).record(['a\tb', 'c\nd']),
    ).toBe('a\\\tb\tc\\\nd\r\n');
  });

  it('escapes with a backslash inside quotes when asked', () => {
    const f = new CsvFormatter({ escape: '\\', lineEnding: '\n' });
    expect(f.record(['a"b', 'c\\d'])).toBe('"a\\"b","c\\\\d"\n');
  });
});

describe('CSV round trip (fast-check)', () => {
  const text = fc.string({
    unit: fc.constantFrom(
      'a',
      'b',
      ' ',
      ',',
      ';',
      '\t',
      '|',
      '"',
      "'",
      '\\',
      '\r',
      '\n',
      'é',
      '😀',
      'N',
    ),
    maxLength: 12,
  });

  it('parses what the writer wrote, for any data, dialect and chunking', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 5 }).chain((width) =>
          fc.record({
            header: fc.array(fc.string({ minLength: 1, maxLength: 6 }), {
              minLength: width,
              maxLength: width,
            }),
            rows: fc.array(
              fc.array(fc.option(text, { nil: null }), { minLength: width, maxLength: width }),
              {
                maxLength: 20,
              },
            ),
          }),
        ),
        fc.record({
          delimiter: fc.constantFrom(',', ';', '\t', '|'),
          quote: fc.constantFrom('"', "'"),
          backslash: fc.boolean(),
          nullMarker: fc.constantFrom('', '\\N', 'NULL'),
          quoting: fc.constantFrom('minimal' as const, 'all' as const, 'non-numeric' as const),
          lineEnding: fc.constantFrom('\n' as const, '\r\n' as const),
        }),
        fc.array(fc.integer({ min: 1, max: 9 }), { minLength: 1, maxLength: 5 }),
        ({ header, rows }, d, sizes) => {
          const dialect = {
            delimiter: d.delimiter,
            quote: d.quote,
            escape: d.backslash ? '\\' : d.quote,
            nullMarker: d.nullMarker,
          };
          const formatter = new CsvFormatter({
            ...dialect,
            quoting: d.quoting,
            lineEnding: d.lineEnding,
          });
          const csv = [header, ...rows].map((r) => formatter.record(r)).join('');
          const { records } = parseChunked(csv, sizes, dialect);
          expect(records).toEqual([header, ...rows]);
        },
      ),
      { numRuns: 400 },
    );
  });
});
