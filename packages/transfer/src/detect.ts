import { JoineryError, cancelledError, type SqlDialect } from '@joinery/core';
import { StatementSplitter } from '@joinery/sql-tools';

import { CsvParser, type CsvField } from './csv';
import { concatBytes, openInput, type ByteSource } from './io';
import { fitsType, inferColumns, type InferredColumn } from './infer';
import { JsonLinesParser, JsonStreamParser, parseJsonElement } from './json';
import { isParquet, openParquet, parquetColumns } from './parquet';
import {
  CsvRowBuilder,
  JsonRowBuilder,
  csvReadOptions,
  emptyParts,
  type CsvReadOptions,
  type ReadOptions,
  type RowFormat,
} from './readers';
import { decoderFor, detectEncoding } from './text';
import type { FileFormat, SourceCell, SourceRow } from './types';
import {
  XlsxRowBuilder,
  cellText,
  openWorkbook,
  readSheet,
  type SheetRow,
  type XlsxReadOptions,
} from './xlsx-read';
import { XmlParser } from './xml';
import {
  XmlRowBuilder,
  detectRowPaths,
  normalizeRowPath,
  xmlEncoding,
  type XmlPathCandidate,
  type XmlReadOptions,
} from './xml-read';
import { isCompoundFile, isZip } from './zip';

/**
 * Preview and detection (spec §12): read the start of a source and work out its format,
 * encoding, CSV dialect, header, columns and column types, so the wizard can show a preview
 * and pre-fill its options. Detection only fills in what the caller did not fix.
 */

export interface PreviewOptions {
  /** Known format; otherwise taken from `fileName`'s extension, then sniffed from the content. */
  readonly format?: FileFormat;
  readonly fileName?: string;
  /** Known encoding; otherwise detected from a byte order mark or UTF-8 validity. */
  readonly encoding?: string;
  /** CSV settings to keep; the rest (delimiter, quote, escape, header) are detected. */
  readonly csv?: CsvReadOptions;
  /** Excel: the worksheet (default the first visible one) and header row (default detected). */
  readonly xlsx?: XlsxReadOptions;
  /** XML: the row path (default detected). */
  readonly xml?: XmlReadOptions;
  readonly decompress?: 'auto' | 'gzip' | 'none';
  /** Rows to sample (default 100). */
  readonly sampleRows?: number;
  /** Most bytes to read (default 1 MiB of decompressed text). */
  readonly sampleBytes?: number;
  /** Dialect for splitting SQL sources (default postgres). */
  readonly sqlDialect?: SqlDialect;
  /** Stops reading; the preview then rejects with CANCELLED. */
  readonly signal?: AbortSignal;
}

export interface SourcePreview {
  readonly format: FileFormat;
  readonly compression: 'gzip' | 'none';
  readonly encoding: string;
  /** The source starts with a byte order mark. */
  readonly bom: boolean;
  /** Everything needed to read the whole source as previewed; pass it to `readRows`. */
  readonly read: ReadOptions | null;
  readonly columns: readonly InferredColumn[];
  readonly rows: readonly SourceRow[];
  /** The sample is the whole source. */
  readonly complete: boolean;
  /** SQL sources: the first statements. */
  readonly statements?: readonly string[];
  /** Excel: every worksheet's name; `read.xlsx.sheet` is the one previewed. */
  readonly sheets?: readonly string[];
  /** XML: paths that could hold the rows, best first; `read.xml.rowPath` is the one previewed. */
  readonly rowPaths?: readonly XmlPathCandidate[];
  /** Parquet: what the footer says about the whole file. */
  readonly parquet?: ParquetSummary;
}

/** A Parquet file at a glance. */
export interface ParquetSummary {
  readonly rows: number;
  readonly rowGroups: number;
  /** The writer, as the file names it (`parquet-cpp-arrow version 17.0.0`). */
  readonly createdBy?: string;
  /** Page codecs used (`SNAPPY`, `ZSTD`...). */
  readonly compressions: readonly string[];
}

const EXTENSIONS: Readonly<Record<string, FileFormat>> = {
  csv: 'csv',
  tsv: 'tsv',
  tab: 'tsv',
  json: 'json',
  jsonl: 'jsonl',
  ndjson: 'jsonl',
  jsonlines: 'jsonl',
  xlsx: 'xlsx',
  xlsm: 'xlsx',
  xml: 'xml',
  parquet: 'parquet',
  parq: 'parquet',
  pq: 'parquet',
  sql: 'sql',
};

/** The format a file name implies (`.csv.gz` → csv), if any. */
export function formatFromFileName(fileName: string): FileFormat | undefined {
  const parts = fileName.toLowerCase().split(/[\\/]/).pop()!.split('.');
  if (parts[parts.length - 1] === 'gz') parts.pop();
  return parts.length > 1 ? EXTENSIONS[parts[parts.length - 1]!] : undefined;
}

const SQL_START =
  /^(?:insert|create|drop|alter|set|use|begin|start|delimiter|lock|unlock|update|delete|select|with|truncate|comment|grant|revoke|copy|do|call|replace|commit|savepoint)\b[\s(;]/i;

function looksLikeSql(text: string): boolean {
  let rest = text.trimStart();
  let commented = false;
  for (;;) {
    if (rest.startsWith('--') || rest.startsWith('#')) {
      const eol = rest.indexOf('\n');
      rest = eol < 0 ? '' : rest.slice(eol + 1).trimStart();
      commented = true;
    } else if (rest.startsWith('/*')) {
      const end = rest.indexOf('*/');
      rest = end < 0 ? '' : rest.slice(end + 2).trimStart();
      commented = true;
    } else break;
  }
  if (rest === '') return commented;
  return SQL_START.test(rest.slice(0, 64)) && (rest.includes(';') || /^delimiter\b/i.test(rest));
}

/** Sniffs the format of a text sample (workbooks are recognised by their bytes). */
export function sniffFormat(text: string): FileFormat {
  const start = text.replace(/^\ufeff/, '').trimStart();
  if (/^<[?!A-Za-z_:]/.test(start)) return 'xml';
  if (start.startsWith('[')) return 'json';
  if (start.startsWith('{')) {
    const eol = start.indexOf('\n');
    const first = eol < 0 ? start : start.slice(0, eol);
    try {
      parseJsonElement(first.trim());
      return 'jsonl';
    } catch {
      return 'json';
    }
  }
  if (looksLikeSql(start)) return 'sql';
  return detectDelimiter(start) === '\t' ? 'tsv' : 'csv';
}

const DELIMITERS = [',', '\t', ';', '|'] as const;
const DETECT_CHARS = 64 * 1024;

/** Complete records of a sample: the last one is dropped unless the sample is complete. */
function sampleRecords(
  text: string,
  options: CsvReadOptions,
  complete: boolean,
  limit: number,
): { records: CsvField[][]; lines: number[] } {
  const parser = new CsvParser({ ...options, emptyLines: options.emptyLines ?? 'auto' });
  const records: CsvField[][] = [];
  const lines: number[] = [];
  try {
    const parsed = parser.push(text);
    records.push(...parsed.records);
    lines.push(...parsed.lines);
    if (complete) {
      const rest = parser.end();
      records.push(...rest.records);
      lines.push(...rest.lines);
    }
  } catch {
    // A sample that does not parse with these options scores on what did.
  }
  return { records: records.slice(0, limit), lines: lines.slice(0, limit) };
}

/**
 * Picks the delimiter whose field counts are most consistent across the sample's records,
 * honouring quotes. Ties go to more fields, then to the order `, \t ; |`. A sample in which
 * no candidate splits records gives `,` (one column).
 */
export function detectDelimiter(
  sample: string,
  quote: string | null = '"',
  complete = false,
): string {
  // The first 64 KiB decide; a longer sample only costs time.
  const text = sample.length > DETECT_CHARS ? sample.slice(0, DETECT_CHARS) : sample;
  const whole = complete && text.length === sample.length;
  let best: { delimiter: string; score: number; fields: number } | undefined;
  for (const delimiter of DELIMITERS) {
    const { records } = sampleRecords(
      text,
      { delimiter, quote, escape: quote, nullMarker: null },
      whole,
      200,
    );
    if (records.length === 0) continue;
    const counts = new Map<number, number>();
    for (const record of records) counts.set(record.length, (counts.get(record.length) ?? 0) + 1);
    let mode = 0;
    let frequency = 0;
    for (const [fields, count] of counts) {
      if (count > frequency || (count === frequency && fields > mode)) {
        mode = fields;
        frequency = count;
      }
    }
    if (mode < 2) continue;
    const score = frequency / records.length;
    if (
      best === undefined ||
      score > best.score + 1e-9 ||
      (Math.abs(score - best.score) <= 1e-9 && mode > best.fields)
    ) {
      best = { delimiter, score, fields: mode };
    }
  }
  return best?.delimiter ?? ',';
}

/** Quote character: `'` only when fields start with it and never with `"`. */
function detectQuote(text: string, delimiter: string): string {
  const starts = (quote: string): number => {
    let count = 0;
    for (const prefix of [delimiter, '\n']) {
      for (
        let at = text.indexOf(prefix + quote);
        at >= 0;
        at = text.indexOf(prefix + quote, at + 1)
      )
        count++;
    }
    return count + (text.startsWith(quote) ? 1 : 0);
  };
  return starts('"') === 0 && starts("'") > 0 ? "'" : '"';
}

/** Escape character: backslash when quotes inside fields are written `\"` rather than `""`. */
function detectEscape(text: string, quote: string): string {
  const backslashed = text.split(`\\${quote}`).length - 1;
  const doubled = text.split(quote + quote).length - 1;
  return backslashed > 0 && doubled === 0 ? '\\' : quote;
}

/**
 * Whether the first record is a header, by type contrast: for columns whose other values have
 * a type (numbers, dates, booleans, uuids), a first value of that type votes "data" and any
 * other value votes "header". Text columns vote "header" when the first value's length
 * differs from the others' common length. Undecided samples (all text) count as having a
 * header when the first row's values are non-empty, distinct and do not recur below.
 */
export function detectHeader(records: readonly (readonly CsvField[])[]): boolean {
  const first = records[0];
  if (first === undefined) return true;
  const rest = records.slice(1);
  if (rest.length === 0) {
    return first.every((cell) => cell !== null && cell.trim() !== '' && fitsOnlyText(cell));
  }
  const width = first.length;
  const names = Array.from({ length: width }, (_, i) => `c${i}`);
  const inferred = inferColumns(names, rest as SourceRow[]);
  let votes = 0;
  for (let c = 0; c < width; c++) {
    const head = first[c] ?? null;
    const type = inferred[c]!.type;
    if (type !== 'text') {
      if (head === null || head.trim() === '') continue;
      votes += fitsType(head, type) ? -1 : 1;
      continue;
    }
    const lengths = new Set(rest.map((r) => (r[c] ?? '').length));
    if (lengths.size === 1 && head !== null && !lengths.has(head.length)) votes += 1;
  }
  if (votes !== 0) return votes > 0;
  const seen = new Set<string>();
  for (let c = 0; c < width; c++) {
    const head = first[c];
    if (head === null || head === undefined || head.trim() === '') return false;
    if (seen.has(head)) return false;
    seen.add(head);
    if (rest.some((r) => r[c] === head)) return false;
  }
  return true;
}

function fitsOnlyText(cell: string): boolean {
  return (
    !fitsType(cell, 'integer') &&
    !fitsType(cell, 'float') &&
    !fitsType(cell, 'boolean') &&
    !fitsType(cell, 'timestamp')
  );
}

/**
 * Detects the CSV dialect of a text sample: delimiter, quote, escape and header, keeping any
 * the caller fixed. The NULL marker defaults to the empty unquoted field.
 */
export function detectCsvOptions(
  text: string,
  fixed: CsvReadOptions = {},
  complete = false,
): Required<Pick<CsvReadOptions, 'delimiter' | 'quote' | 'escape' | 'nullMarker' | 'header'>> &
  CsvReadOptions {
  const delimiter =
    fixed.delimiter ??
    detectDelimiter(text, fixed.quote === undefined ? '"' : fixed.quote, complete);
  const quote = fixed.quote === undefined ? detectQuote(text, delimiter) : fixed.quote;
  const escape =
    fixed.escape === undefined ? (quote === null ? null : detectEscape(text, quote)) : fixed.escape;
  const nullMarker = fixed.nullMarker === undefined ? '' : fixed.nullMarker;
  const head = text.length > DETECT_CHARS ? text.slice(0, DETECT_CHARS) : text;
  const header =
    fixed.header ??
    detectHeader(
      sampleRecords(
        head,
        { delimiter, quote, escape, nullMarker: null },
        complete && head.length === text.length,
        50,
      ).records,
    );
  return { ...fixed, delimiter, quote, escape, nullMarker, header };
}

/** Pads sample rows to the column count. */
function padded(rows: readonly SourceRow[], width: number): SourceRow[] {
  return rows.map((row) =>
    row.length >= width ? row : [...row, ...new Array<SourceCell>(width - row.length).fill(null)],
  );
}

/**
 * The header row of a worksheet sample: the first row's number when it looks like column
 * names (by the same type contrast as CSV headers), else 0.
 */
export function detectHeaderRow(rows: readonly SheetRow[]): number {
  const first = rows[0];
  if (first === undefined) return 0;
  return detectHeader(rows.slice(0, 50).map((row) => row.cells.map(cellText))) ? first.row : 0;
}

/** Previews a worksheet: its rows, the header row as given or detected, the sheet list. */
async function previewWorkbook(
  source: ByteSource,
  options: PreviewOptions,
  sampleRows: number,
  decompress: 'auto' | 'gzip' | 'none',
): Promise<SourcePreview> {
  const workbook = await openWorkbook(source, decompress);
  try {
    const sheet = workbook.sheet(options.xlsx?.sheet);
    const fixed = options.xlsx?.headerRow;
    const limit = sampleRows + 51;
    const collected: SheetRow[] = [];
    let complete = true;
    const rows = readSheet(workbook, sheet, (row) => {
      if (row.row >= (fixed ?? 0)) collected.push(row);
    });
    for await (const _chunk of rows) {
      if (options.signal?.aborted === true) throw cancelledError('Preview cancelled');
      if (collected.length > limit) {
        complete = false;
        break;
      }
    }
    const headerRow = fixed ?? detectHeaderRow(collected);
    const builder = new XlsxRowBuilder(headerRow);
    const parts = emptyParts();
    for (const row of collected) builder.add(row, parts);
    if (parts.rows.length > sampleRows) complete = false;
    const sample = padded(parts.rows.slice(0, sampleRows), builder.columns.length);
    return {
      format: 'xlsx',
      compression: 'none',
      encoding: 'utf-8',
      bom: false,
      complete,
      read: { format: 'xlsx', decompress, xlsx: { sheet: sheet.name, headerRow } },
      columns: inferColumns(builder.columns, sample),
      rows: sample,
      sheets: workbook.sheets.map((s) => s.name),
    };
  } finally {
    await workbook.close();
  }
}

/** Previews a Parquet file: its first rows, typed by its schema, and the footer's summary. */
async function previewParquet(
  source: ByteSource,
  options: PreviewOptions,
  sampleRows: number,
  decompress: 'auto' | 'gzip' | 'none',
): Promise<SourcePreview> {
  const file = await openParquet(source, decompress);
  try {
    if (options.signal?.aborted === true) throw cancelledError('Preview cancelled');
    const rows = await file.read(0, Math.min(sampleRows, file.rows));
    const names = file.columns.map((c) => c.name);
    return {
      format: 'parquet',
      compression: 'none',
      encoding: 'utf-8',
      bom: false,
      complete: file.rows <= sampleRows,
      read: { format: 'parquet', decompress },
      columns: parquetColumns(file, inferColumns(names, rows)),
      rows,
      parquet: {
        rows: file.rows,
        rowGroups: file.metadata.row_groups.length,
        ...(file.createdBy !== undefined ? { createdBy: file.createdBy } : {}),
        compressions: file.compressions,
      },
    };
  } finally {
    await file.close();
  }
}

/**
 * Previews a source: reads up to `sampleBytes` (a workbook: its first rows), detects what the
 * options leave open and returns the columns with inferred types and the first `sampleRows`
 * rows. The source is consumed (and closed); open a fresh one to import.
 */
export async function previewSource(
  source: ByteSource,
  options: PreviewOptions = {},
): Promise<SourcePreview> {
  const sampleRows = Math.max(1, options.sampleRows ?? 100);
  const sampleBytes = Math.max(1024, options.sampleBytes ?? 1024 * 1024);
  const decompress = options.decompress ?? 'auto';
  const named =
    options.format ??
    (options.fileName !== undefined ? formatFromFileName(options.fileName) : undefined);
  if (named === 'xlsx') return previewWorkbook(source, options, sampleRows, decompress);
  if (named === 'parquet') return previewParquet(source, options, sampleRows, decompress);
  const input = await openInput(source, decompress);
  const chunks: Uint8Array[] = [];
  let length = 0;
  let complete = true;
  const iterator = input.source[Symbol.asyncIterator]();
  try {
    for (;;) {
      if (length >= sampleBytes || options.signal?.aborted === true) {
        complete = false;
        break;
      }
      const next = await iterator.next();
      if (next.done === true) break;
      chunks.push(next.value);
      length += next.value.length;
    }
  } catch (error) {
    await iterator.return?.();
    throw error;
  }
  const head = concatBytes(chunks, length);
  const parquet = isParquet(head);
  if (
    named === undefined &&
    options.signal?.aborted !== true &&
    (parquet || isZip(head) || isCompoundFile(head))
  ) {
    // A workbook or Parquet file without a telling name (stdin, no extension): read it whole.
    const preview = parquet ? previewParquet : previewWorkbook;
    if (input.compression === 'none' && source.randomAccess !== undefined) {
      if (!complete) await iterator.return?.();
      return preview(source, options, sampleRows, decompress);
    }
    const rest: ByteSource = {
      async *[Symbol.asyncIterator]() {
        try {
          yield* chunks;
          if (complete) return;
          for (;;) {
            const next = await iterator.next();
            if (next.done === true) return;
            yield next.value;
          }
        } finally {
          if (!complete) await iterator.return?.();
        }
      },
    };
    return preview(rest, options, sampleRows, 'none');
  }
  if (!complete) await iterator.return?.();
  if (options.signal?.aborted === true) throw cancelledError('Preview cancelled');
  const detected = detectEncoding(head, complete);
  let encoding = options.encoding ?? detected.encoding;
  let text = decoderFor(encoding).decode(head, { stream: !complete });
  const format = named ?? sniffFormat(text);
  if (format === 'xml' && options.encoding === undefined) {
    const declared = xmlEncoding(head, complete);
    if (declared !== encoding) {
      encoding = declared;
      text = decoderFor(encoding).decode(head, { stream: !complete });
    }
  }
  const bom = detected.bom && detected.encoding === decoderFor(encoding).encoding;
  const base = { format, compression: input.compression, encoding, bom, complete };

  if (format === 'sql') {
    const splitter = new StatementSplitter(options.sqlDialect ?? 'postgres');
    const statements = splitter.push(text);
    if (complete) statements.push(...splitter.end());
    return {
      ...base,
      read: null,
      columns: [],
      rows: [],
      statements: statements.slice(0, sampleRows).map((s) => s.text),
    };
  }

  let effective: RowFormat = format;
  let columns: readonly string[];
  let read: ReadOptions;
  let rowPaths: XmlPathCandidate[] | undefined;
  const parts = emptyParts();
  if (format === 'csv' || format === 'tsv') {
    const csv = detectCsvOptions(text, csvReadOptions(format, options.csv), complete);
    if (options.format === undefined && csv.delimiter === '\t') effective = 'tsv';
    const { records, lines } = sampleRecords(text, csv, complete, sampleRows + 1);
    const csvBuilder = new CsvRowBuilder(csv.header);
    csvBuilder.add(records, lines, parts);
    columns = csvBuilder.columns;
    read = { format: effective, encoding, decompress: input.compression, csv };
  } else if (format === 'xml') {
    rowPaths = detectRowPaths(text, complete);
    const given = options.xml?.rowPath;
    const rowPath = given !== undefined ? normalizeRowPath(given) : rowPaths[0]?.path;
    if (rowPath === undefined) {
      throw new JoineryError({ code: 'VALIDATION_FAILED', message: 'The XML has no elements' });
    }
    const xmlBuilder = new XmlRowBuilder(rowPath);
    xmlBuilder.collect(parts);
    const parser = new XmlParser(xmlBuilder);
    try {
      parser.push(text);
      if (complete) parser.end();
    } catch (error) {
      // A syntax error past the rows already sampled is the import's to report.
      if (parts.rows.length === 0) throw error;
    }
    columns = xmlBuilder.columns;
    read = { format: 'xml', encoding, decompress: input.compression, xml: { rowPath } };
  } else {
    const jsonBuilder = new JsonRowBuilder();
    const parser = format === 'json' ? new JsonStreamParser('auto') : new JsonLinesParser();
    try {
      jsonBuilder.add(parser.push(text), parts);
      if (complete) jsonBuilder.add(parser.end(), parts);
    } catch (error) {
      // A syntax error past the rows already sampled is the import's to report.
      if (parts.rows.length === 0) throw error;
    }
    columns = jsonBuilder.columns;
    read = { format: effective, encoding, decompress: input.compression };
  }
  const rows = padded(parts.rows.slice(0, sampleRows), columns.length);
  return {
    ...base,
    format: effective,
    read,
    columns: inferColumns(columns, rows),
    rows,
    ...(rowPaths !== undefined ? { rowPaths } : {}),
  };
}
