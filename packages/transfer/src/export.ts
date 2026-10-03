import {
  QuerybaraError,
  newId,
  type CellValue,
  type ColumnKind,
  type ColumnMeta,
  type QueryParams,
  type ResultChunk,
  type SequenceDef,
  type Session,
  type SqlDialect,
  type TableDef,
} from '@querybara/core';
import { quoteIdent, quoteQualified, quoteString } from '@querybara/sql-tools';
import {
  renderForeignKey,
  renderSequence,
  renderTableStatements,
  sqlLiteral,
} from '@querybara/sync';

import { CsvFormatter, type CsvDialect, type CsvQuoting } from './csv';
import type { Sink } from './io';
import { ParquetFileWriter, type ParquetExportOptions } from './parquet';
import { dialectOf } from './session';
import { qualifiedTable } from './statements';
import { TextOutput, type OutputEncoding } from './text';
import type {
  ExportFormat,
  RowError,
  TransferProgress,
  TransferStatus,
  TransferSummary,
} from './types';
import { XlsxWorkbookWriter, type XlsxExportOptions } from './xlsx-write';
import { escapeXmlAttribute, escapeXmlText, xmlName } from './xml';
import { ZipWriter } from './zip';

/**
 * Export (spec §12): the driver's pages stream straight into a format writer and on to the
 * sink. Each page is written (and the sink's backpressure awaited) before the next is fetched,
 * so the database cursor, not memory, holds the rest of the result.
 */

type RowsChunk = Extract<ResultChunk, { type: 'rows' }>;

export interface CsvExportOptions extends Partial<CsvDialect> {
  /** Write a header line with the column names (default true). */
  readonly header?: boolean;
  readonly quoting?: CsvQuoting;
  /** Default CRLF, as RFC 4180 has it. */
  readonly lineEnding?: '\n' | '\r\n';
  /** Binary cells: `hex` (`\x0102`, the default, as PostgreSQL prints bytea) or `base64`. */
  readonly binary?: 'hex' | 'base64';
}

export interface JsonExportOptions {
  /** Indent objects over several lines (default false: one object per line). */
  readonly pretty?: boolean;
  readonly indent?: number;
  /** Binary cells: `base64` (default) or `hex` (`\x0102`). */
  readonly binary?: 'hex' | 'base64';
  /** Write decimals and bigints as JSON strings instead of exact JSON numbers. */
  readonly numbersAsStrings?: boolean;
}

export interface SqlExportOptions {
  /** Dialect of the generated SQL (default the session's; `sql-ddl` needs the same one). */
  readonly dialect?: SqlDialect;
  /** Table name in the INSERTs (default the exported table, or `query_result`). */
  readonly table?: string;
  /** PostgreSQL schema to qualify names with (default: the exported table's schema). */
  readonly schema?: string | null;
  /** Rows per INSERT statement (default 100). */
  readonly rowsPerStatement?: number;
  /** Longest INSERT statement in characters (default 1 MiB, well under max_allowed_packet). */
  readonly maxStatementLength?: number;
  /** `sql-ddl`: DROP TABLE IF EXISTS before CREATE TABLE (default false). */
  readonly dropTable?: boolean;
  /** `sql-ddl`: add foreign keys after the data (default true). */
  readonly foreignKeys?: boolean;
}

/** A table to export. */
export interface ExportTable {
  readonly name: string;
  /** PostgreSQL schema (default `public`); ignored for MySQL and MariaDB. */
  readonly schema?: string;
  /** Columns to export (default all). */
  readonly columns?: readonly string[];
}

export interface ExportCommonOptions {
  readonly session: Session;
  readonly format: ExportFormat;
  readonly csv?: CsvExportOptions;
  readonly json?: JsonExportOptions;
  readonly sql?: SqlExportOptions;
  readonly xlsx?: XlsxExportOptions;
  readonly parquet?: ParquetExportOptions;
  /** Output encoding of the text formats (default UTF-8; workbooks are always Unicode). */
  readonly encoding?: OutputEncoding;
  /** Start with a byte order mark (default false). */
  readonly bom?: boolean;
  /** Rows fetched per page (default 1000). */
  readonly pageSize?: number;
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: TransferProgress) => void;
  readonly progressIntervalMs?: number;
}

export interface ExportOptions extends ExportCommonOptions {
  /** A query to export (one statement)... */
  readonly query?: string | { readonly text: string; readonly params?: QueryParams };
  /** ...or a table. */
  readonly table?: ExportTable;
  readonly sink: Sink;
  /** Close the sink when done (default true). A failed or cancelled export aborts it. */
  readonly closeSink?: boolean;
  /** Write the export as this file inside a ZIP archive written to `sink`. */
  readonly zipEntry?: string;
}

export interface ExportSummary extends TransferSummary {
  readonly bytesWritten: number;
}

// ---------------------------------------------------------------------------------------------
// Cell text

const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));

function hexText(bytes: Uint8Array): string {
  let out = '\\x';
  for (let i = 0; i < bytes.length; i++) out += HEX[bytes[i]!];
  return out;
}

function base64Text(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
}

function handleError(): QuerybaraError {
  return new QuerybaraError({
    code: 'NOT_SUPPORTED',
    message: 'A large value was only previewed; fetch it in full before exporting',
  });
}

/** A cell as CSV text: server text for strings, exact digits, `true`/`false`, hex binary. */
function csvText(value: CellValue, binary: 'hex' | 'base64'): string | null {
  if (value === null) return null;
  switch (typeof value) {
    case 'string':
      return value;
    case 'number':
      return String(value);
    case 'bigint':
      return value.toString();
    case 'boolean':
      return value ? 'true' : 'false';
    default:
      if (value instanceof Uint8Array) return binary === 'hex' ? hexText(value) : base64Text(value);
      throw handleError();
  }
}

const JSON_NUMBER = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;

function isJson(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

/** A cell as JSON: JSON columns embedded, decimals as exact numbers, binary as base64. */
function jsonValue(value: CellValue, kind: ColumnKind, options: JsonExportOptions): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
      if (kind === 'json' && isJson(value)) return value.trim();
      if (kind === 'decimal' && options.numbersAsStrings !== true && JSON_NUMBER.test(value)) {
        return value;
      }
      return JSON.stringify(value);
    case 'number':
      return Number.isFinite(value) ? String(value) : JSON.stringify(String(value));
    case 'bigint':
      return options.numbersAsStrings === true ? `"${value}"` : value.toString();
    case 'boolean':
      return value ? 'true' : 'false';
    default:
      if (value instanceof Uint8Array) {
        return JSON.stringify(options.binary === 'hex' ? hexText(value) : base64Text(value));
      }
      throw handleError();
  }
}

const NUMERIC_KINDS = new Set<ColumnKind>(['integer', 'bigint', 'decimal', 'float']);

/** Result column names made unique (`id`, `id_2`), for headers and JSON keys. */
export function uniqueNames(names: readonly string[]): string[] {
  const seen = new Set<string>();
  return names.map((name) => {
    let unique = name;
    for (let n = 2; seen.has(unique); n++) unique = `${name}_${n}`;
    seen.add(unique);
    return unique;
  });
}

// ---------------------------------------------------------------------------------------------
// Format writers

/** Turns pages of one result into text. */
interface FormatWriter {
  begin(columns: readonly ColumnMeta[]): string;
  page(chunk: RowsChunk): string;
  end(): string;
}

class CsvWriter implements FormatWriter {
  private readonly formatter: CsvFormatter;
  private numeric: boolean[] = [];

  constructor(
    private readonly options: CsvExportOptions,
    delimiter: string,
  ) {
    this.formatter = new CsvFormatter({ ...options, delimiter: options.delimiter ?? delimiter });
  }

  begin(columns: readonly ColumnMeta[]): string {
    this.numeric = columns.map((c) => NUMERIC_KINDS.has(c.kind));
    if (this.options.header === false) return '';
    return this.formatter.record(uniqueNames(columns.map((c) => c.name)));
  }

  page(chunk: RowsChunk): string {
    const binary = this.options.binary ?? 'hex';
    const data = chunk.data;
    const width = data.length;
    const values = new Array<string | null>(width);
    let out = '';
    for (let r = 0; r < chunk.rowCount; r++) {
      for (let c = 0; c < width; c++) values[c] = csvText(data[c]![r] ?? null, binary);
      out += this.formatter.record(values, this.numeric);
    }
    return out;
  }

  end(): string {
    return '';
  }
}

class JsonWriter implements FormatWriter {
  private keys: string[] = [];
  private kinds: ColumnKind[] = [];
  private rows = 0;
  private readonly pretty: boolean;
  private readonly pad: string;

  constructor(
    private readonly options: JsonExportOptions,
    private readonly lines: boolean,
  ) {
    this.pretty = options.pretty === true && !lines;
    this.pad = ' '.repeat(Math.max(0, options.indent ?? 2));
  }

  begin(columns: readonly ColumnMeta[]): string {
    this.keys = uniqueNames(columns.map((c) => c.name)).map((name) => JSON.stringify(name));
    this.kinds = columns.map((c) => c.kind);
    return this.lines ? '' : '[';
  }

  page(chunk: RowsChunk): string {
    const data = chunk.data;
    const width = data.length;
    let out = '';
    for (let r = 0; r < chunk.rowCount; r++) {
      let object = '';
      if (this.pretty) {
        const inner = this.pad + this.pad;
        for (let c = 0; c < width; c++) {
          object += `${c === 0 ? '' : ','}\n${inner}${this.keys[c]!}: ${jsonValue(data[c]![r] ?? null, this.kinds[c]!, this.options)}`;
        }
        object = `${this.pad}{${object}${width > 0 ? `\n${this.pad}` : ''}}`;
      } else {
        for (let c = 0; c < width; c++) {
          object += `${c === 0 ? '' : ','}${this.keys[c]!}:${jsonValue(data[c]![r] ?? null, this.kinds[c]!, this.options)}`;
        }
        object = `{${object}}`;
      }
      if (this.lines) out += `${object}\n`;
      else out += `${this.rows === 0 ? '\n' : ',\n'}${object}`;
      this.rows++;
    }
    return out;
  }

  end(): string {
    if (this.lines) return '';
    return this.rows === 0 ? ']\n' : '\n]\n';
  }
}

class SqlWriter implements FormatWriter {
  private head = '';
  private kinds: ColumnKind[] = [];
  private open = false;
  private count = 0;
  private length = 0;
  private readonly rowsPerStatement: number;
  private readonly maxLength: number;

  constructor(
    private readonly dialect: SqlDialect,
    private readonly target: string,
    options: SqlExportOptions,
    private readonly overriding: boolean,
  ) {
    this.rowsPerStatement = Math.max(1, options.rowsPerStatement ?? 100);
    this.maxLength = Math.max(1024, options.maxStatementLength ?? 1024 * 1024);
  }

  begin(columns: readonly ColumnMeta[]): string {
    this.kinds = columns.map((c) => c.kind);
    const names = columns.map((c) => quoteIdent(c.name, this.dialect)).join(', ');
    const overriding = this.overriding ? ' OVERRIDING SYSTEM VALUE' : '';
    this.head = `INSERT INTO ${this.target} (${names})${overriding} VALUES\n`;
    return '';
  }

  page(chunk: RowsChunk): string {
    const data = chunk.data;
    const width = data.length;
    let out = '';
    for (let r = 0; r < chunk.rowCount; r++) {
      let tuple = '(';
      for (let c = 0; c < width; c++) {
        if (c > 0) tuple += ', ';
        tuple += sqlLiteral(data[c]![r] ?? null, this.dialect, this.kinds[c]);
      }
      tuple += ')';
      if (
        this.open &&
        (this.count >= this.rowsPerStatement || this.length + tuple.length > this.maxLength)
      ) {
        out += ';\n';
        this.open = false;
      }
      if (!this.open) {
        out += this.head;
        this.open = true;
        this.count = 0;
        this.length = this.head.length;
      } else {
        out += ',\n';
      }
      out += tuple;
      this.count++;
      this.length += tuple.length + 2;
    }
    return out;
  }

  end(): string {
    if (!this.open) return '';
    this.open = false;
    return ';\n';
  }
}

/**
 * XML rows (the documented, stable shape; see `exportRows`): one `<table name="…">` per
 * result, a `<row>` per row, and an element per column named by the SQL/XML mapping; NULL is
 * `xsi:nil="true"`, text is escaped, binary is hex.
 */
class XmlWriter implements FormatWriter {
  private names: string[] = [];

  constructor(private readonly name: string) {}

  begin(columns: readonly ColumnMeta[]): string {
    this.names = uniqueNames(columns.map((c) => c.name)).map(xmlName);
    return `  <table name="${escapeXmlAttribute(this.name)}">\n`;
  }

  page(chunk: RowsChunk): string {
    const data = chunk.data;
    const width = data.length;
    let out = '';
    for (let r = 0; r < chunk.rowCount; r++) {
      out += '    <row>\n';
      for (let c = 0; c < width; c++) {
        const name = this.names[c]!;
        const text = csvText(data[c]![r] ?? null, 'hex');
        out +=
          text === null
            ? `      <${name} xsi:nil="true"/>\n`
            : `      <${name}>${escapeXmlText(text)}</${name}>\n`;
      }
      out += '    </row>\n';
    }
    return out;
  }

  end(): string {
    return '  </table>\n';
  }
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** An HTML table: numbers right-aligned, NULL shown dimmed, the row count below. */
class HtmlWriter implements FormatWriter {
  private numeric: boolean[] = [];
  private rows = 0;

  begin(columns: readonly ColumnMeta[]): string {
    this.numeric = columns.map((c) => NUMERIC_KINDS.has(c.kind));
    const head = uniqueNames(columns.map((c) => c.name))
      .map((name, c) => `<th${this.numeric[c] ? ' class="num"' : ''}>${escapeHtml(name)}</th>`)
      .join('');
    return `<table>\n<thead><tr>${head}</tr></thead>\n<tbody>\n`;
  }

  page(chunk: RowsChunk): string {
    const data = chunk.data;
    const width = data.length;
    let out = '';
    for (let r = 0; r < chunk.rowCount; r++) {
      let row = '<tr>';
      for (let c = 0; c < width; c++) {
        const text = csvText(data[c]![r] ?? null, 'hex');
        row +=
          text === null
            ? '<td class="null">NULL</td>'
            : `<td${this.numeric[c] ? ' class="num"' : ''}>${escapeHtml(text)}</td>`;
      }
      out += `${row}</tr>\n`;
    }
    this.rows += chunk.rowCount;
    return out;
  }

  end(): string {
    const count = `${this.rows.toLocaleString('en-US')} row${this.rows === 1 ? '' : 's'}`;
    return `</tbody>\n</table>\n<p class="count">${count}</p>\n`;
  }
}

/**
 * A Markdown cell: characters Markdown reads as syntax (`\`, `|`, emphasis, code, links,
 * HTML) are backslash-escaped and line breaks become `<br>`, so the text renders as it is.
 * An `_` inside a word (`full_name`) cannot start emphasis and stays as it is.
 */
export function markdownCell(text: string): string {
  return text
    .replace(/[\\`*~[\]|<>&]/g, '\\$&')
    .replace(/(?<![\p{L}\p{N}])_|_(?![\p{L}\p{N}])/gu, '\\_')
    .replace(/\r\n|\r|\n/g, '<br>');
}

/** A GitHub-flavoured Markdown pipe table; numeric columns right-aligned, NULL as `NULL`. */
class MarkdownWriter implements FormatWriter {
  private width = 0;

  begin(columns: readonly ColumnMeta[]): string {
    this.width = columns.length;
    if (columns.length === 0) return '';
    const names = uniqueNames(columns.map((c) => c.name)).map(markdownCell);
    const align = columns.map((c) => (NUMERIC_KINDS.has(c.kind) ? '---:' : '---'));
    return `| ${names.join(' | ')} |\n| ${align.join(' | ')} |\n`;
  }

  page(chunk: RowsChunk): string {
    if (this.width === 0) return '';
    const data = chunk.data;
    let out = '';
    for (let r = 0; r < chunk.rowCount; r++) {
      const cells: string[] = [];
      for (let c = 0; c < this.width; c++) {
        const text = csvText(data[c]![r] ?? null, 'hex');
        cells.push(text === null ? 'NULL' : markdownCell(text));
      }
      out += `| ${cells.join(' | ')} |\n`;
    }
    return out;
  }

  end(): string {
    return '';
  }
}

// ---------------------------------------------------------------------------------------------
// Running an export

/** The sink plus its encoder and byte count. */
class Output {
  bytes = 0;
  private readonly text: TextOutput;

  constructor(
    readonly sink: Sink,
    encoding: OutputEncoding | undefined,
    bom: boolean | undefined,
  ) {
    this.text = new TextOutput(encoding ?? 'utf-8', bom === true);
  }

  async write(text: string): Promise<void> {
    if (text.length === 0) return;
    await this.writeBytes(this.text.encode(text));
  }

  async writeBytes(bytes: Uint8Array): Promise<void> {
    this.bytes += bytes.length;
    await this.sink.write(bytes);
  }
}

/** Counters shared by the tables of one run. */
interface Counters {
  rowsRead: number;
  rowsWritten: number;
  lastProgress: number;
  readonly started: number;
}

/** One table or query, resolved for the writers. */
interface ExportSource {
  readonly text: string;
  readonly params?: QueryParams;
  /** Quoted target name for INSERTs. */
  readonly target: string;
  /** What the result is called in the file: the table name, or `query_result`. */
  readonly name: string;
  /** Label for progress events. */
  readonly label?: string;
  readonly table?: TableDef;
}

function textWriterFor(
  format: Exclude<ExportFormat, 'xlsx' | 'parquet'>,
  options: ExportCommonOptions,
  dialect: SqlDialect,
  source: ExportSource,
): FormatWriter {
  switch (format) {
    case 'csv':
      return new CsvWriter(options.csv ?? {}, ',');
    case 'tsv':
      return new CsvWriter(options.csv ?? {}, '\t');
    case 'json':
      return new JsonWriter(options.json ?? {}, false);
    case 'jsonl':
      return new JsonWriter(options.json ?? {}, true);
    case 'xml':
      return new XmlWriter(source.name);
    case 'html':
      return new HtmlWriter();
    case 'markdown':
      return new MarkdownWriter();
    default: {
      const overriding =
        dialect === 'postgres' &&
        source.table?.columns.some((c) => c.identity?.generation === 'always') === true;
      return new SqlWriter(dialect, source.target, options.sql ?? {}, overriding);
    }
  }
}

/** Writes one result: its columns, its pages, its end. */
interface ResultWriter {
  begin(columns: readonly ColumnMeta[]): Promise<void>;
  page(chunk: RowsChunk): Promise<void>;
  end(): Promise<void>;
}

/**
 * One output file: what comes before, between and after the results it holds (a JSON object
 * of tables, the XML root, the HTML page, the workbook), and closing it.
 */
interface ExportDocument {
  readonly output: Output;
  /** Starts the next result and returns its writer. */
  result(source: ExportSource, index: number): Promise<ResultWriter>;
  /** Ends the file and closes the sink. */
  close(): Promise<void>;
  /** Abandons the file (a file sink removes it). */
  abort(reason?: unknown): Promise<void>;
}

/** Text around the results of a text document. */
interface Frame {
  prologue(first: string | undefined): string;
  before(index: number, name: string): string;
  after(): string;
  epilogue(count: number): string;
}

const NO_FRAME: Frame = {
  prologue: () => '',
  before: () => '',
  after: () => '',
  epilogue: () => '',
};

const HTML_STYLE = `:root { color-scheme: light dark; }
body { font: 14px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; margin: 24px; }
h1 { font-size: 20px; } h2 { font-size: 16px; margin-top: 32px; }
table { border-collapse: collapse; }
th, td { border: 1px solid #8886; padding: 4px 8px; text-align: left; vertical-align: top; white-space: pre-wrap; }
thead th { position: sticky; top: 0; background: Canvas; }
tbody tr:nth-child(even) { background: #8881; }
.num { text-align: right; font-variant-numeric: tabular-nums; }
.null { color: GrayText; font-style: italic; }
.count { color: GrayText; }`;

function frameFor(
  format: ExportFormat,
  combined: boolean,
  encoding: OutputEncoding,
  title: string | undefined,
): Frame {
  switch (format) {
    case 'json':
      return combined
        ? {
            prologue: () => '{',
            before: (index, name) => `${index === 0 ? '\n' : ',\n'}${JSON.stringify(name)}: `,
            after: () => '',
            epilogue: (count) => (count > 0 ? '\n}\n' : '}\n'),
          }
        : NO_FRAME;
    case 'xml':
      return {
        prologue: () =>
          `<?xml version="1.0" encoding="${encoding === 'utf-16le' ? 'UTF-16' : 'UTF-8'}"?>\n<export xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">\n`,
        before: () => '',
        after: () => '',
        epilogue: () => '</export>\n',
      };
    case 'html':
      return {
        prologue: (first) => {
          const heading = escapeHtml(title ?? (combined ? 'Exported tables' : (first ?? 'Export')));
          return `<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="${encoding === 'utf-16le' ? 'utf-16' : 'utf-8'}">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n<meta name="generator" content="Querybara">\n<title>${heading}</title>\n<style>\n${HTML_STYLE}\n</style>\n</head>\n<body>\n<h1>${heading}</h1>\n`;
        },
        before: (_index, name) =>
          combined ? `<section>\n<h2>${escapeHtml(name)}</h2>\n` : '<section>\n',
        after: () => '</section>\n',
        epilogue: () => '</body>\n</html>\n',
      };
    case 'markdown':
      return combined
        ? {
            prologue: () => '',
            before: (index, name) => `${index === 0 ? '' : '\n'}## ${markdownCell(name)}\n\n`,
            after: () => '',
            epilogue: () => '',
          }
        : NO_FRAME;
    default:
      return NO_FRAME;
  }
}

/** A sink whose `close` leaves the underlying sink open (`closeSink: false`). */
function keepOpen(sink: Sink): Sink {
  return {
    write: (chunk) => sink.write(chunk),
    close: async () => undefined,
    abort: (reason) => sink.abort(reason),
  };
}

function openDocument(
  options: ExportCommonOptions & { readonly title?: string },
  sink: Sink,
  dialect: SqlDialect,
  combined: boolean,
): ExportDocument {
  const format = options.format;
  if (format === 'xlsx') {
    const output = new Output(sink, 'utf-8', false);
    const book = new XlsxWorkbookWriter({
      write: (chunk) => output.writeBytes(chunk),
      close: () => sink.close(),
      abort: (reason) => sink.abort(reason),
    });
    return {
      output,
      result: async (source) => {
        const sheet = book.sheet(source.name, options.xlsx ?? {});
        return {
          begin: async (columns) => sheet.begin(columns),
          page: (chunk) => sheet.page(chunk.data, chunk.rowCount),
          end: () => sheet.end(),
        };
      },
      close: () => book.close(),
      abort: (reason) => book.abort(reason),
    };
  }
  if (format === 'parquet') {
    // One table per file (combinableFormat): the file is the result's row groups and footer.
    const output = new Output(sink, 'utf-8', false);
    const file = new ParquetFileWriter(
      {
        write: (chunk) => output.writeBytes(chunk),
        close: () => sink.close(),
        abort: (reason) => sink.abort(reason),
      },
      options.parquet ?? {},
      dialectOf(options.session),
    );
    return {
      output,
      result: async () => ({
        begin: async (columns) => file.begin(columns, uniqueNames(columns.map((c) => c.name))),
        page: (chunk) => file.page(chunk.data, chunk.rowCount),
        end: () => file.end(),
      }),
      close: () => file.close(),
      abort: (reason) => file.abort(reason),
    };
  }
  const encoding = options.encoding ?? 'utf-8';
  // UTF-16 markup needs its byte order mark: that is how parsers and browsers know.
  const markup = format === 'xml' || format === 'html';
  const output = new Output(
    sink,
    encoding,
    options.bom === true || (markup && encoding === 'utf-16le'),
  );
  const frame = frameFor(format, combined, encoding, options.title);
  let started = false;
  let count = 0;
  const start = async (first: string | undefined): Promise<void> => {
    if (started) return;
    started = true;
    await output.write(frame.prologue(first));
  };
  return {
    output,
    async result(source, index) {
      await start(source.name);
      await output.write(frame.before(index, source.name));
      count++;
      const writer = textWriterFor(format, options, dialect, source);
      return {
        begin: (columns) => output.write(writer.begin(columns)),
        page: (chunk) => output.write(writer.page(chunk)),
        end: async () => {
          await output.write(writer.end());
          await output.write(frame.after());
        },
      };
    },
    async close() {
      await start(undefined);
      await output.write(frame.epilogue(count));
      await sink.close();
    },
    abort: (reason) => sink.abort(reason),
  };
}

/** DDL around the INSERTs of one table for `sql-ddl`. */
interface Ddl {
  /** Sequences, CREATE TABLE, indexes and comments. */
  readonly before: string[];
  /** Sequence positions after the data. */
  readonly after: string[];
  /** Foreign keys, added last. */
  readonly constraints: string[];
}

function ddlFor(
  table: TableDef,
  sourceName: string,
  dialect: SqlDialect,
  schema: string | undefined,
  sequences: readonly SequenceDef[],
  options: SqlExportOptions,
): Ddl {
  const pg = dialect === 'postgres';
  const render = pg && schema !== undefined ? { schema } : {};
  const name = qualifiedTable(table.name, dialect, schema);
  const before: string[] = [];
  const after: string[] = [];
  if (options.dropTable === true) before.push(`DROP TABLE IF EXISTS ${name}`);
  // Sequences owned by serial columns must exist before CREATE TABLE refers to them.
  const owned = pg ? sequences.filter((s) => s.ownedBy?.split('.')[0] === sourceName) : [];
  for (const sequence of owned) before.push(...renderSequence(sequence, dialect, render));
  before.push(...renderTableStatements(table, dialect, { ...render, includeForeignKeys: false }));
  for (const sequence of owned) {
    const column = sequence.ownedBy!.split('.')[1]!;
    before.push(
      `ALTER SEQUENCE ${quoteQualified([schema, sequence.name], dialect)} OWNED BY ${name}.${quoteIdent(column, dialect)}`,
    );
  }
  if (pg) {
    // Explicit ids leave serial and identity sequences behind; move them past the data.
    for (const column of table.columns) {
      const serial = column.identity !== undefined || (column.default ?? '').startsWith('nextval(');
      if (!serial) continue;
      const ident = quoteIdent(column.name, dialect);
      after.push(
        `SELECT setval(pg_get_serial_sequence(${quoteString(name, dialect)}, ${quoteString(column.name, dialect)}), max(${ident})) FROM ${name}`,
      );
    }
  }
  const constraints =
    options.foreignKeys === false
      ? []
      : table.foreignKeys.map(
          (fk) =>
            `ALTER TABLE ${name} ADD ${renderForeignKey(fk, dialect, pg ? schema : undefined)}`,
        );
  return { before, after, constraints };
}

function statementsText(statements: readonly string[]): string {
  return statements.map((s) => `${s};\n`).join('');
}

/** Streams one source through a writer. */
async function streamSource(
  options: ExportCommonOptions,
  source: ExportSource,
  writer: ResultWriter,
  output: Output,
  counters: Counters,
): Promise<void> {
  const { session, signal } = options;
  const emit = (force: boolean): void => {
    if (options.onProgress === undefined) return;
    const now = performance.now();
    if (!force && now - counters.lastProgress < (options.progressIntervalMs ?? 250)) return;
    counters.lastProgress = now;
    const elapsedMs = now - counters.started;
    options.onProgress({
      rowsRead: counters.rowsRead,
      rowsWritten: counters.rowsWritten,
      rowsSkipped: 0,
      bytes: output.bytes,
      elapsedMs: Math.round(elapsedMs),
      rowsPerSecond: elapsedMs > 0 ? Math.round((counters.rowsWritten * 1000) / elapsedMs) : 0,
      ...(source.label !== undefined ? { table: source.label } : {}),
    });
  };
  let begun = false;
  for await (const chunk of session.execute(source.text, {
    executionId: newId(),
    pageSize: options.pageSize ?? 1000,
    ...(source.params !== undefined ? { params: source.params } : {}),
    ...(signal !== undefined ? { signal } : {}),
  })) {
    if (signal?.aborted === true) break;
    if (chunk.type === 'columns' && chunk.resultIndex === 0) {
      begun = true;
      await writer.begin(chunk.columns);
    } else if (chunk.type === 'rows' && chunk.resultIndex === 0) {
      counters.rowsRead += chunk.rowCount;
      await writer.page(chunk);
      counters.rowsWritten += chunk.rowCount;
      emit(false);
    }
  }
  if (signal?.aborted === true)
    throw new QuerybaraError({ code: 'CANCELLED', message: 'Cancelled' });
  if (!begun) {
    throw new QuerybaraError({
      code: 'VALIDATION_FAILED',
      message: 'The statement returned no result set to export',
    });
  }
  await writer.end();
  emit(true);
}

/** Resolves a table or query into what the writers need. */
async function resolveSource(
  options: ExportCommonOptions,
  dialect: SqlDialect,
  outDialect: SqlDialect,
  query: ExportOptions['query'],
  table: ExportTable | undefined,
): Promise<{ source: ExportSource; ddl?: Ddl }> {
  const sqlOptions = options.sql ?? {};
  const pg = dialect === 'postgres';
  if (table === undefined) {
    if (query === undefined) throw invalidExport('Export needs a query or a table');
    const text = typeof query === 'string' ? query : query.text;
    const params = typeof query === 'string' ? undefined : query.params;
    const schema = sqlOptions.schema ?? undefined;
    const name = sqlOptions.table ?? 'query_result';
    return {
      source: {
        text,
        ...(params !== undefined ? { params } : {}),
        target: qualifiedTable(name, outDialect, schema),
        name,
      },
    };
  }
  const schema = pg ? (table.schema ?? 'public') : undefined;
  const cols =
    table.columns === undefined || table.columns.length === 0
      ? '*'
      : table.columns.map((c) => quoteIdent(c, dialect)).join(', ');
  const text = `SELECT ${cols} FROM ${qualifiedTable(table.name, dialect, schema)}`;
  const outSchema =
    sqlOptions.schema === null
      ? undefined
      : (sqlOptions.schema ?? (outDialect === 'postgres' ? schema : undefined));
  const target = qualifiedTable(sqlOptions.table ?? table.name, outDialect, outSchema);
  if (options.format !== 'sql-ddl') {
    return { source: { text, target, name: table.name, label: table.name } };
  }
  const snapshot = await options.session.introspect({
    ...(pg ? { schemas: [schema!] } : {}),
    include: ['table', 'sequence'],
  });
  const schemaDef = pg ? snapshot.schemas.find((s) => s.name === schema) : snapshot.schemas[0];
  const def = schemaDef?.tables.find((t) => t.name === table.name);
  if (def === undefined) {
    throw new QuerybaraError({ code: 'NOT_FOUND', message: `Table "${table.name}" was not found` });
  }
  const renamed = sqlOptions.table !== undefined ? { ...def, name: sqlOptions.table } : def;
  return {
    source: { text, target, name: table.name, label: table.name, table: def },
    ddl: ddlFor(renamed, def.name, dialect, outSchema, schemaDef?.sequences ?? [], sqlOptions),
  };
}

function invalidExport(message: string): QuerybaraError {
  return new QuerybaraError({ code: 'VALIDATION_FAILED', message });
}

/** Formats that can hold several tables in one file. */
export function combinableFormat(format: ExportFormat): boolean {
  return format !== 'csv' && format !== 'tsv' && format !== 'jsonl' && format !== 'parquet';
}

/** Option combinations that can never work; checked before anything runs. */
function validateExport(
  options: ExportCommonOptions,
  dialect: SqlDialect,
  outDialect: SqlDialect,
  hasQuery: boolean,
  hasTable: boolean,
): void {
  if (hasQuery === hasTable) throw invalidExport('Export needs either a query or a table');
  if (options.format === 'sql-ddl' && hasQuery) {
    throw invalidExport('SQL with DDL exports a table, not a query');
  }
  if (options.format === 'sql-ddl' && outDialect !== dialect) {
    throw invalidExport('SQL with DDL is written in the source dialect only');
  }
}

function failureOf(error: unknown): RowError {
  return { message: error instanceof Error ? error.message : String(error) };
}

function isCancel(error: unknown, signal: AbortSignal | undefined): boolean {
  return (
    signal?.aborted === true || (error instanceof QuerybaraError && error.code === 'CANCELLED')
  );
}

/**
 * Exports a query's result or a table to a sink. Resolves with a summary for every runtime
 * outcome; a failed or cancelled export aborts the sink (a file sink removes its file).
 * Throws VALIDATION_FAILED only for option combinations that can never work.
 *
 * The XML shape is stable: `<export>` holds a `<table name="…">` per result, each row is a
 * `<row>` with one element per column, named by the SQL/XML mapping (`Order No` →
 * `Order_x0020_No`); values are the text CSV would hold, NULL is `xsi:nil="true"`, an empty
 * element is the empty string, and characters XML 1.0 cannot carry are written `_xHHHH_`.
 */
export async function exportRows(options: ExportOptions): Promise<ExportSummary> {
  const dialect = dialectOf(options.session);
  const outDialect = options.sql?.dialect ?? dialect;
  validateExport(
    options,
    dialect,
    outDialect,
    options.query !== undefined,
    options.table !== undefined,
  );
  if (options.zipEntry !== undefined) {
    const { zipEntry, ...rest } = options;
    const zip = new ZipWriter(options.closeSink === false ? keepOpen(options.sink) : options.sink);
    const summary = await exportRows({ ...rest, closeSink: true, sink: zip.entry(zipEntry) });
    if (summary.status !== 'completed') {
      await zip.abort().catch(() => undefined);
      return summary;
    }
    try {
      await zip.close();
      return { ...summary, bytesWritten: zip.bytes };
    } catch (error) {
      await zip.abort(error).catch(() => undefined);
      return { ...summary, status: 'failed', errors: [failureOf(error)] };
    }
  }
  const counters: Counters = {
    rowsRead: 0,
    rowsWritten: 0,
    lastProgress: 0,
    started: performance.now(),
  };
  const sink = options.closeSink === false ? keepOpen(options.sink) : options.sink;
  const document = openDocument(options, sink, outDialect, false);
  let status: TransferStatus = 'completed';
  const errors: RowError[] = [];
  try {
    const { source, ddl } = await resolveSource(
      options,
      dialect,
      outDialect,
      options.query,
      options.table,
    );
    const writer = await document.result(source, 0);
    if (ddl !== undefined) await document.output.write(`${statementsText(ddl.before)}\n`);
    await streamSource(options, source, writer, document.output, counters);
    if (ddl !== undefined) {
      await document.output.write(statementsText([...ddl.after, ...ddl.constraints]));
    }
    await document.close();
  } catch (error) {
    status = isCancel(error, options.signal) ? 'cancelled' : 'failed';
    if (status === 'failed') errors.push(failureOf(error));
    await document.abort(error).catch(() => undefined);
  }
  return {
    status,
    rowsRead: counters.rowsRead,
    rowsWritten: counters.rowsWritten,
    rowsSkipped: 0,
    errors,
    bytesWritten: document.output.bytes,
    durationMs: Math.round(performance.now() - counters.started),
  };
}

export const EXPORT_EXTENSIONS: Readonly<Record<ExportFormat, string>> = {
  csv: 'csv',
  tsv: 'tsv',
  json: 'json',
  jsonl: 'jsonl',
  xlsx: 'xlsx',
  xml: 'xml',
  parquet: 'parquet',
  sql: 'sql',
  'sql-ddl': 'sql',
  html: 'html',
  markdown: 'md',
};

/**
 * The file a table exports to: characters file systems refuse become `_`, then the format's
 * extension (and `.gz` when gzipped).
 */
export function exportFileName(table: string, format: ExportFormat, gzip = false): string {
  // eslint-disable-next-line no-control-regex
  const base = table.replace(/[\u{0}-\u{1f}<>:"/\\|?*]/gu, '_').replace(/^\.+/, '_') || 'table';
  return `${base}.${EXPORT_EXTENSIONS[format]}${gzip ? '.gz' : ''}`;
}

export interface ExportTablesOptions extends ExportCommonOptions {
  readonly tables: readonly ExportTable[];
  /**
   * `combined`: every table into one sink (every format but CSV, TSV, JSON Lines and Parquet: SQL one
   * table after another, JSON an object keyed by table name, XML a `<table>` each, HTML and
   * Markdown a section each, Excel a worksheet each). `per-table`: a sink per table from
   * `sinkFor`. `zip`: a file per table inside one ZIP archive written to `sink`.
   */
  readonly output:
    | { readonly kind: 'combined'; readonly sink: Sink }
    | { readonly kind: 'per-table'; sinkFor(table: ExportTable): Sink | Promise<Sink> }
    | {
        readonly kind: 'zip';
        readonly sink: Sink;
        /** Name of a table's file in the archive (default `exportFileName`, made unique). */
        fileName?(table: ExportTable): string;
      };
  /** HTML: the page title of a combined file (default "Exported tables"). */
  readonly title?: string;
}

export interface ExportTablesSummary extends ExportSummary {
  readonly tables: readonly (ExportSummary & { readonly table: string })[];
  /** `zip`: the file names in the archive, in table order. */
  readonly files?: readonly string[];
}

/** Exports each table to its own sink; `zip` puts each into one archive. */
async function exportEach(
  options: ExportTablesOptions,
  started: number,
): Promise<ExportTablesSummary> {
  const results: (ExportSummary & { table: string })[] = [];
  const out = options.output;
  const { tables: _tables, output: _output, title: _title, ...common } = options;
  const zip = out.kind === 'zip' ? new ZipWriter(out.sink) : undefined;
  const taken = new Set<string>();
  const files: string[] = [];
  const sinkFor = async (table: ExportTable): Promise<Sink> => {
    if (out.kind === 'per-table') return out.sinkFor(table);
    const base = out.kind === 'zip' && out.fileName ? out.fileName(table) : undefined;
    let name = base ?? exportFileName(table.name, options.format);
    for (let n = 2; taken.has(name.toLowerCase()); n++) {
      name =
        base !== undefined ? `${n}_${base}` : exportFileName(`${table.name}_${n}`, options.format);
    }
    taken.add(name.toLowerCase());
    files.push(name);
    return zip!.entry(name);
  };
  for (const table of options.tables) {
    const summary = await exportRows({ ...common, table, sink: await sinkFor(table) });
    results.push({ ...summary, table: table.name });
    if (summary.status !== 'completed') break;
  }
  let failure: RowError | undefined;
  if (zip !== undefined) {
    if (results.every((r) => r.status === 'completed')) {
      try {
        await zip.close();
      } catch (error) {
        failure = failureOf(error);
        await zip.abort(error).catch(() => undefined);
      }
    } else {
      await zip.abort().catch(() => undefined);
    }
  }
  const bytes = zip?.bytes ?? results.reduce((sum, r) => sum + r.bytesWritten, 0);
  const summary = {
    ...summarize(results, started, bytes),
    ...(zip !== undefined ? { files } : {}),
  };
  return failure === undefined ? summary : { ...summary, status: 'failed', errors: [failure] };
}

/**
 * Exports several tables, one file per table, a ZIP of them, or one combined file. A
 * combined SQL file holds each table in turn (CREATE, INSERTs) and adds every foreign key at
 * the end, so the order of the tables never matters on import. Stops at the first table that
 * fails.
 */
export async function exportTables(options: ExportTablesOptions): Promise<ExportTablesSummary> {
  const started = performance.now();
  const out = options.output;
  if (out.kind !== 'combined') return exportEach(options, started);

  const format = options.format;
  if (!combinableFormat(format)) {
    throw new QuerybaraError({
      code: 'VALIDATION_FAILED',
      message: `A combined file is not available for ${format.toUpperCase()}; export one file per table`,
    });
  }
  const dialect = dialectOf(options.session);
  const outDialect = options.sql?.dialect ?? dialect;
  validateExport(options, dialect, outDialect, false, true);
  const document = openDocument(options, out.sink, outDialect, true);
  const output = document.output;
  const results: (ExportSummary & { table: string })[] = [];
  const constraints: string[] = [];
  let failed: { status: TransferStatus; error?: RowError } | undefined;
  for (const [index, table] of options.tables.entries()) {
    const counters: Counters = {
      rowsRead: 0,
      rowsWritten: 0,
      lastProgress: 0,
      started: performance.now(),
    };
    const bytesBefore = output.bytes;
    try {
      const { source, ddl } = await resolveSource(options, dialect, outDialect, undefined, table);
      const writer = await document.result(source, index);
      if (ddl !== undefined) await output.write(`${statementsText(ddl.before)}\n`);
      await streamSource(options, source, writer, output, counters);
      if (ddl !== undefined) {
        await output.write(`${statementsText(ddl.after)}\n`);
        constraints.push(...ddl.constraints);
      }
      results.push({
        table: table.name,
        status: 'completed',
        rowsRead: counters.rowsRead,
        rowsWritten: counters.rowsWritten,
        rowsSkipped: 0,
        errors: [],
        bytesWritten: output.bytes - bytesBefore,
        durationMs: Math.round(performance.now() - counters.started),
      });
    } catch (error) {
      const status: TransferStatus = isCancel(error, options.signal) ? 'cancelled' : 'failed';
      failed = { status, ...(status === 'failed' ? { error: failureOf(error) } : {}) };
      results.push({
        table: table.name,
        status,
        rowsRead: counters.rowsRead,
        rowsWritten: counters.rowsWritten,
        rowsSkipped: 0,
        errors: failed.error !== undefined ? [failed.error] : [],
        bytesWritten: output.bytes - bytesBefore,
        durationMs: Math.round(performance.now() - counters.started),
      });
      break;
    }
  }
  try {
    if (failed === undefined) {
      if (constraints.length > 0) await output.write(statementsText(constraints));
      await document.close();
    } else {
      await document.abort().catch(() => undefined);
    }
  } catch (error) {
    failed = { status: 'failed', error: failureOf(error) };
    await document.abort(error).catch(() => undefined);
  }
  const summary = summarize(results, started, output.bytes);
  return failed === undefined
    ? summary
    : {
        ...summary,
        status: failed.status,
        errors: failed.error !== undefined ? [failed.error] : summary.errors,
      };
}

function summarize(
  results: readonly (ExportSummary & { table: string })[],
  started: number,
  bytes: number,
): ExportTablesSummary {
  const bad = results.find((r) => r.status !== 'completed');
  return {
    status: bad?.status ?? 'completed',
    rowsRead: results.reduce((sum, r) => sum + r.rowsRead, 0),
    rowsWritten: results.reduce((sum, r) => sum + r.rowsWritten, 0),
    rowsSkipped: 0,
    errors: results.flatMap((r) => r.errors),
    bytesWritten: bytes,
    durationMs: Math.round(performance.now() - started),
    tables: results,
  };
}
