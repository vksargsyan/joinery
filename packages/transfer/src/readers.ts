import { JoineryError } from '@joinery/core';

import { CsvParser, type CsvDialect, type CsvField, type CsvParseOptions } from './csv';
import { openInput, peekSource, type ByteSource } from './io';
import { JsonLinesParser, JsonStreamParser, type JsonElements } from './json';
import { readParquet } from './parquet';
import { emptyParts, toBatch, widen, headerNames, type BatchParts } from './rows';
import { decodeSource, detectEncoding } from './text';
import type { RowBatch, SourceCell } from './types';
import { XlsxRowBuilder, openWorkbook, readSheet, type XlsxReadOptions } from './xlsx-read';
import { XmlParser } from './xml';
import { XmlRowBuilder, detectRowPaths, xmlEncoding, type XmlReadOptions } from './xml-read';

export { emptyParts, headerNames, widen, type BatchParts } from './rows';

/**
 * Readers (spec §12): bytes in, batches of rows out. `readRows` detects gzip and the text
 * encoding when not told, decodes incrementally and parses with the incremental CSV, JSON or
 * XML parser, or streams the worksheet of an xlsx workbook or the row groups of a Parquet file,
 * so memory stays flat whatever the file size. Batches follow the source's chunks.
 */

export type RowFormat = 'csv' | 'tsv' | 'json' | 'jsonl' | 'xlsx' | 'xml' | 'parquet';

export interface CsvReadOptions extends Partial<CsvDialect> {
  /** The first record holds column names (default true). */
  readonly header?: boolean;
  readonly emptyLines?: CsvParseOptions['emptyLines'];
  readonly maxFieldLength?: number;
}

export interface ReadOptions {
  readonly format: RowFormat;
  /**
   * WHATWG encoding name; detected from a byte order mark or UTF-8 validity when absent (XML:
   * also from its declaration). Workbooks are always Unicode.
   */
  readonly encoding?: string;
  /** Gzip handling: detected by magic number (default), forced, or off. */
  readonly decompress?: 'auto' | 'gzip' | 'none';
  /** CSV and TSV options; TSV defaults the delimiter to a tab. */
  readonly csv?: CsvReadOptions;
  /** Excel: the worksheet and its header row. */
  readonly xlsx?: XlsxReadOptions;
  /** XML: the path of the row elements. */
  readonly xml?: XmlReadOptions;
}

/** Turns CSV records into rows: the header, column growth and row numbering. */
export class CsvRowBuilder {
  columns: string[] = [];
  private needHeader: boolean;
  private row = 0;

  constructor(header: boolean) {
    this.needHeader = header;
  }

  add(records: readonly CsvField[][], lines: readonly number[], parts: BatchParts): void {
    for (let r = 0; r < records.length; r++) {
      const record = records[r]!;
      if (this.needHeader) {
        this.needHeader = false;
        this.columns = headerNames(record);
        continue;
      }
      if (record.length > this.columns.length) this.columns = widen(this.columns, record.length);
      parts.rows.push(record);
      parts.rowNumbers.push(++this.row);
      parts.lines.push(lines[r]!);
    }
  }
}

/** Turns JSON elements into rows: object keys become columns in order of first appearance. */
export class JsonRowBuilder {
  columns: string[] = [];
  private readonly index = new Map<string, number>();
  private row = 0;

  private columnFor(name: string): number {
    let at = this.index.get(name);
    if (at === undefined) {
      at = this.columns.length;
      this.columns = [...this.columns, name];
      this.index.set(name, at);
    }
    return at;
  }

  add(parsed: JsonElements, parts: BatchParts): void {
    const { elements, lines, errors } = parsed;
    let e = 0;
    let x = 0;
    // Rejected lines keep their place in the row numbering.
    while (e < elements.length || x < errors.length) {
      if (x < errors.length && (e >= elements.length || errors[x]!.line < lines[e]!)) {
        const error = errors[x++]!;
        parts.rejected.push({ row: ++this.row, line: error.line, message: error.message });
        continue;
      }
      const element = elements[e]!;
      const line = lines[e++]!;
      let row: SourceCell[];
      if (element.kind === 'object') {
        const at = element.keys.map((key) => this.columnFor(key));
        row = new Array<SourceCell>(this.columns.length).fill(null);
        at.forEach((c, k) => (row[c] = element.values[k]!));
      } else if (element.kind === 'array') {
        const width = element.values.length;
        if (width > this.columns.length) {
          const wider = widen(this.columns, width);
          for (let c = this.columns.length; c < width; c++) this.columnFor(wider[c]!);
        }
        row = element.values;
      } else {
        const c = this.columnFor('value');
        row = new Array<SourceCell>(this.columns.length).fill(null);
        row[c] = element.value;
      }
      parts.rows.push(row);
      parts.rowNumbers.push(++this.row);
      parts.lines.push(line);
    }
  }
}

/** Resolves the CSV options for a format: TSV defaults to a tab delimiter. */
export function csvReadOptions(format: RowFormat, csv: CsvReadOptions = {}): CsvReadOptions {
  return format === 'tsv' && csv.delimiter === undefined ? { ...csv, delimiter: '\t' } : csv;
}

/** Text sampled for detecting an XML row path when none is given. */
const XML_SAMPLE = 1024 * 1024;

/** The rows of a workbook's worksheet; the worksheet row number is each row's line. */
async function* workbookRows(source: ByteSource, options: ReadOptions): AsyncGenerator<RowBatch> {
  const workbook = await openWorkbook(source, options.decompress ?? 'auto');
  try {
    const sheet = workbook.sheet(options.xlsx?.sheet);
    const builder = new XlsxRowBuilder(options.xlsx?.headerRow);
    let parts = emptyParts();
    let position = 0;
    const rows = readSheet(
      workbook,
      sheet,
      (row) => builder.add(row, parts),
      (at) => (position = at),
    );
    for await (const _chunk of rows) {
      if (parts.rows.length > 0) {
        yield toBatch(builder.columns, parts, position);
        parts = emptyParts();
      }
    }
    yield toBatch(builder.columns, parts, position);
  } finally {
    await workbook.close();
  }
}

/**
 * Reads rows from a byte source. Stopping the iteration early closes the source. Syntax
 * errors that make the rest unreadable (an unterminated quote at the end, malformed JSON in an
 * array, malformed XML) are thrown as VALIDATION_FAILED with the line; a malformed JSON Lines
 * line is reported in `rejected` and reading continues.
 */
export async function* readRows(
  source: ByteSource,
  options: ReadOptions,
): AsyncGenerator<RowBatch> {
  if (options.format === 'xlsx') {
    yield* workbookRows(source, options);
    return;
  }
  if (options.format === 'parquet') {
    yield* readParquet(source, options.decompress ?? 'auto');
    return;
  }
  const input = await openInput(source, options.decompress ?? 'auto');
  let bytes = input.source;
  let encoding = options.encoding;
  if (encoding === undefined) {
    const peeked = await peekSource(bytes, 64 * 1024);
    encoding =
      options.format === 'xml'
        ? xmlEncoding(peeked.head, peeked.ended)
        : detectEncoding(peeked.head, peeked.ended).encoding;
    bytes = peeked.source;
  }
  let text: AsyncIterable<string> = decodeSource(bytes, encoding);

  if (options.format === 'csv' || options.format === 'tsv') {
    const csv = csvReadOptions(options.format, options.csv);
    const parser = new CsvParser(csv);
    const builder = new CsvRowBuilder(csv.header ?? true);
    for await (const chunk of text) {
      const parts = emptyParts();
      const { records, lines } = parser.push(chunk);
      builder.add(records, lines, parts);
      if (parts.rows.length > 0) yield toBatch(builder.columns, parts, input.count());
    }
    const parts = emptyParts();
    const { records, lines } = parser.end();
    builder.add(records, lines, parts);
    yield toBatch(builder.columns, parts, input.count());
    return;
  }

  if (options.format === 'json' || options.format === 'jsonl') {
    const parser = options.format === 'json' ? new JsonStreamParser('auto') : new JsonLinesParser();
    const builder = new JsonRowBuilder();
    for await (const chunk of text) {
      const parts = emptyParts();
      builder.add(parser.push(chunk), parts);
      if (parts.rows.length > 0 || parts.rejected.length > 0) {
        yield toBatch(builder.columns, parts, input.count(), true);
      }
    }
    const parts = emptyParts();
    builder.add(parser.end(), parts);
    yield toBatch(builder.columns, parts, input.count(), true);
    return;
  }

  if (options.format === 'xml') {
    let rowPath = options.xml?.rowPath;
    if (rowPath === undefined) {
      const iterator = text[Symbol.asyncIterator]();
      const head: string[] = [];
      let length = 0;
      let ended = false;
      while (length < XML_SAMPLE) {
        const next = await iterator.next();
        if (next.done === true) {
          ended = true;
          break;
        }
        head.push(next.value);
        length += next.value.length;
      }
      rowPath = detectRowPaths(head.join(''), ended)[0]?.path;
      if (rowPath === undefined) {
        await iterator.return?.();
        throw new JoineryError({ code: 'VALIDATION_FAILED', message: 'The XML has no elements' });
      }
      text = {
        async *[Symbol.asyncIterator]() {
          try {
            yield* head;
            if (ended) return;
            for (;;) {
              const next = await iterator.next();
              if (next.done === true) return;
              yield next.value;
            }
          } finally {
            if (!ended) await iterator.return?.();
          }
        },
      };
    }
    const builder = new XmlRowBuilder(rowPath, {
      ...(options.xml?.maxFieldLength !== undefined
        ? { maxFieldLength: options.xml.maxFieldLength }
        : {}),
    });
    const parser = new XmlParser(builder);
    for await (const chunk of text) {
      const parts = emptyParts();
      builder.collect(parts);
      parser.push(chunk);
      if (parts.rows.length > 0) yield toBatch(builder.columns, parts, input.count());
    }
    const parts = emptyParts();
    builder.collect(parts);
    parser.end();
    yield toBatch(builder.columns, parts, input.count());
    return;
  }

  throw new JoineryError({
    code: 'VALIDATION_FAILED',
    message: `Cannot read rows from the "${String(options.format)}" format`,
    hint: 'SQL files are run with runSqlFile',
  });
}
