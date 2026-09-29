import {
  JoineryError,
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
} from '@joinery/core';
import { quoteIdent, quoteQualified, quoteString } from '@joinery/sql-tools';
import { renderForeignKey, renderSequence, renderTableStatements, sqlLiteral } from '@joinery/sync';

import { CsvFormatter, type CsvDialect, type CsvQuoting } from './csv';
import type { Sink } from './io';
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
  /** Output encoding (default UTF-8). */
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

function handleError(): JoineryError {
  return new JoineryError({
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
    const bytes = this.text.encode(text);
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
  /** Label for progress events. */
  readonly label?: string;
  readonly table?: TableDef;
}

function writerFor(
  format: ExportFormat,
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
    default: {
      const overriding =
        dialect === 'postgres' &&
        source.table?.columns.some((c) => c.identity?.generation === 'always') === true;
      return new SqlWriter(dialect, source.target, options.sql ?? {}, overriding);
    }
  }
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

/** Streams one source through a writer into the output. */
async function streamSource(
  options: ExportCommonOptions,
  source: ExportSource,
  writer: FormatWriter,
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
      await output.write(writer.begin(chunk.columns));
    } else if (chunk.type === 'rows' && chunk.resultIndex === 0) {
      counters.rowsRead += chunk.rowCount;
      await output.write(writer.page(chunk));
      counters.rowsWritten += chunk.rowCount;
      emit(false);
    }
  }
  if (signal?.aborted === true) throw new JoineryError({ code: 'CANCELLED', message: 'Cancelled' });
  if (!begun) {
    throw new JoineryError({
      code: 'VALIDATION_FAILED',
      message: 'The statement returned no result set to export',
    });
  }
  await output.write(writer.end());
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
    return {
      source: {
        text,
        ...(params !== undefined ? { params } : {}),
        target: qualifiedTable(sqlOptions.table ?? 'query_result', outDialect, schema),
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
    return { source: { text, target, label: table.name } };
  }
  const snapshot = await options.session.introspect({
    ...(pg ? { schemas: [schema!] } : {}),
    include: ['table', 'sequence'],
  });
  const schemaDef = pg ? snapshot.schemas.find((s) => s.name === schema) : snapshot.schemas[0];
  const def = schemaDef?.tables.find((t) => t.name === table.name);
  if (def === undefined) {
    throw new JoineryError({ code: 'NOT_FOUND', message: `Table "${table.name}" was not found` });
  }
  const renamed = sqlOptions.table !== undefined ? { ...def, name: sqlOptions.table } : def;
  return {
    source: { text, target, label: table.name, table: def },
    ddl: ddlFor(renamed, def.name, dialect, outSchema, schemaDef?.sequences ?? [], sqlOptions),
  };
}

function invalidExport(message: string): JoineryError {
  return new JoineryError({ code: 'VALIDATION_FAILED', message });
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
  return signal?.aborted === true || (error instanceof JoineryError && error.code === 'CANCELLED');
}

/**
 * Exports a query's result or a table to a sink. Resolves with a summary for every runtime
 * outcome; a failed or cancelled export aborts the sink (a file sink removes its file).
 * Throws VALIDATION_FAILED only for option combinations that can never work.
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
  const counters: Counters = {
    rowsRead: 0,
    rowsWritten: 0,
    lastProgress: 0,
    started: performance.now(),
  };
  const output = new Output(options.sink, options.encoding, options.bom);
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
    const writer = writerFor(options.format, options, outDialect, source);
    if (ddl !== undefined) await output.write(`${statementsText(ddl.before)}\n`);
    await streamSource(options, source, writer, output, counters);
    if (ddl !== undefined) await output.write(statementsText([...ddl.after, ...ddl.constraints]));
    if (options.closeSink !== false) await options.sink.close();
  } catch (error) {
    status = isCancel(error, options.signal) ? 'cancelled' : 'failed';
    if (status === 'failed') errors.push(failureOf(error));
    await options.sink.abort(error).catch(() => undefined);
  }
  return {
    status,
    rowsRead: counters.rowsRead,
    rowsWritten: counters.rowsWritten,
    rowsSkipped: 0,
    errors,
    bytesWritten: output.bytes,
    durationMs: Math.round(performance.now() - counters.started),
  };
}

export interface ExportTablesOptions extends ExportCommonOptions {
  readonly tables: readonly ExportTable[];
  /**
   * `combined`: every table into one sink (SQL formats, and JSON as an object keyed by table
   * name). `per-table`: a sink per table from `sinkFor` (every format).
   */
  readonly output:
    | { readonly kind: 'combined'; readonly sink: Sink }
    | { readonly kind: 'per-table'; sinkFor(table: ExportTable): Sink | Promise<Sink> };
}

export interface ExportTablesSummary extends ExportSummary {
  readonly tables: readonly (ExportSummary & { readonly table: string })[];
}

/**
 * Exports several tables, one file per table or one combined file. A combined SQL file holds
 * each table in turn (CREATE, INSERTs) and adds every foreign key at the end, so the order of
 * the tables never matters on import. Stops at the first table that fails.
 */
export async function exportTables(options: ExportTablesOptions): Promise<ExportTablesSummary> {
  const started = performance.now();
  const results: (ExportSummary & { table: string })[] = [];
  const out = options.output;
  if (out.kind === 'per-table') {
    for (const table of options.tables) {
      const sink = await out.sinkFor(table);
      const { tables: _tables, output: _output, ...common } = options;
      const summary = await exportRows({ ...common, table, sink });
      results.push({ ...summary, table: table.name });
      if (summary.status !== 'completed') break;
    }
    return summarize(
      results,
      started,
      results.reduce((sum, r) => sum + r.bytesWritten, 0),
    );
  }

  const format = options.format;
  if (format !== 'sql' && format !== 'sql-ddl' && format !== 'json') {
    throw new JoineryError({
      code: 'VALIDATION_FAILED',
      message: `A combined file is not available for ${format.toUpperCase()}; export one file per table`,
    });
  }
  const dialect = dialectOf(options.session);
  const outDialect = options.sql?.dialect ?? dialect;
  validateExport(options, dialect, outDialect, false, true);
  const output = new Output(out.sink, options.encoding, options.bom);
  const constraints: string[] = [];
  let failed: { status: TransferStatus; error?: RowError } | undefined;
  if (format === 'json') await output.write('{');
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
      const writer = writerFor(format, options, outDialect, source);
      if (format === 'json')
        await output.write(`${index === 0 ? '\n' : ',\n'}${JSON.stringify(table.name)}: `);
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
      if (format === 'json') await output.write(options.tables.length > 0 ? '\n}\n' : '}\n');
      await out.sink.close();
    } else {
      await out.sink.abort().catch(() => undefined);
    }
  } catch (error) {
    failed = { status: 'failed', error: failureOf(error) };
    await out.sink.abort(error).catch(() => undefined);
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
