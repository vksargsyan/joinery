import { JoineryError } from '@joinery/core';

import { CsvParser, type CsvDialect, type CsvField, type CsvParseOptions } from './csv';
import { openInput, peekSource, type ByteSource } from './io';
import { JsonLinesParser, JsonStreamParser, type JsonElements } from './json';
import { decodeSource, detectEncoding } from './text';
import type { RowBatch, RowError, SourceCell } from './types';

/**
 * Readers (spec §12): bytes in, batches of rows out. `readRows` detects gzip and the text
 * encoding when not told, decodes incrementally and parses with the incremental CSV or JSON
 * parser, so memory stays flat whatever the file size. Batches follow the source's chunks.
 */

export type RowFormat = 'csv' | 'tsv' | 'json' | 'jsonl';

export interface CsvReadOptions extends Partial<CsvDialect> {
  /** The first record holds column names (default true). */
  readonly header?: boolean;
  readonly emptyLines?: CsvParseOptions['emptyLines'];
  readonly maxFieldLength?: number;
}

export interface ReadOptions {
  readonly format: RowFormat;
  /** WHATWG encoding name; detected from a byte order mark or UTF-8 validity when absent. */
  readonly encoding?: string;
  /** Gzip handling: detected by magic number (default), forced, or off. */
  readonly decompress?: 'auto' | 'gzip' | 'none';
  /** CSV and TSV options; TSV defaults the delimiter to a tab. */
  readonly csv?: CsvReadOptions;
}

/** Column names from a header record: trimmed, blanks named `columnN`, duplicates suffixed. */
export function headerNames(record: readonly CsvField[]): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  record.forEach((cell, i) => {
    let name = (cell ?? '').trim();
    if (name === '') name = `column${i + 1}`;
    let unique = name;
    for (let n = 2; seen.has(unique.toLowerCase()); n++) unique = `${name}_${n}`;
    seen.add(unique.toLowerCase());
    names.push(unique);
  });
  return names;
}

/** Appends generated names so that `columns` has at least `width` entries. */
function widen(columns: string[], width: number): string[] {
  if (columns.length >= width) return columns;
  const next = [...columns];
  const taken = new Set(next.map((c) => c.toLowerCase()));
  for (let i = next.length; i < width; i++) {
    let name = `column${i + 1}`;
    for (let n = 2; taken.has(name.toLowerCase()); n++) name = `column${i + 1}_${n}`;
    taken.add(name.toLowerCase());
    next.push(name);
  }
  return next;
}

/** Rows being collected for one batch. */
export interface BatchParts {
  rows: SourceCell[][];
  rowNumbers: number[];
  lines: number[];
  rejected: RowError[];
}

export const emptyParts = (): BatchParts => ({ rows: [], rowNumbers: [], lines: [], rejected: [] });

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

function toBatch(
  columns: readonly string[],
  parts: BatchParts,
  bytesRead: number,
  json = false,
): RowBatch {
  return {
    columns,
    rows: parts.rows,
    rowNumbers: parts.rowNumbers,
    lines: parts.lines,
    rejected: parts.rejected,
    bytesRead,
    ...(json ? { json } : {}),
  };
}

/** Resolves the CSV options for a format: TSV defaults to a tab delimiter. */
export function csvReadOptions(format: RowFormat, csv: CsvReadOptions = {}): CsvReadOptions {
  return format === 'tsv' && csv.delimiter === undefined ? { ...csv, delimiter: '\t' } : csv;
}

/**
 * Reads rows from a byte source. Stopping the iteration early closes the source. Syntax
 * errors that make the rest unreadable (an unterminated quote at the end, malformed JSON in an
 * array) are thrown as VALIDATION_FAILED with the line; a malformed JSON Lines line is
 * reported in `rejected` and reading continues.
 */
export async function* readRows(
  source: ByteSource,
  options: ReadOptions,
): AsyncGenerator<RowBatch> {
  const input = await openInput(source, options.decompress ?? 'auto');
  let bytes = input.source;
  let encoding = options.encoding;
  if (encoding === undefined) {
    const peeked = await peekSource(bytes, 64 * 1024);
    encoding = detectEncoding(peeked.head, peeked.ended).encoding;
    bytes = peeked.source;
  }
  const text = decodeSource(bytes, encoding);

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

  throw new JoineryError({
    code: 'VALIDATION_FAILED',
    message: `Cannot read rows from the "${String(options.format)}" format`,
    hint: 'SQL files are run with runSqlFile',
  });
}
