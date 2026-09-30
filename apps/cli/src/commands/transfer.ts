import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

import { JoineryError, newId, type Session, type SqlDialect, type TableDef } from '@joinery/core';
import { analyzeStatement, decideSafety, quoteIdent, quoteQualified } from '@joinery/sql-tools';
import {
  autoMatch,
  combinableFormat,
  createTable,
  exportFileName,
  exportRows,
  exportTables,
  fileSink,
  fileSource,
  importRows,
  isCompoundFile,
  isParquet,
  isZip,
  loadTable,
  previewSource,
  readRows,
  runSqlFile,
  spoolToFile,
  tableFromColumns,
  type ByteSource,
  type ColumnMapping,
  type CsvReadOptions,
  type ExportCommonOptions,
  type ExportFormat,
  type ExportSummary,
  type ExportTable,
  type ImportMode,
  type ParquetCompression,
  type RowError,
  type RowFormat,
  type Sink,
  type SpooledSource,
  type SqlStatementError,
  type TransferProgress,
} from '@joinery/transfer';

import { closeQuietly, type Connection } from '../connect';
import type { InputStream, Prompter } from '../context';
import { CliError, EXIT, InterruptedError, type ExitCode } from '../errors';
import { formatDuration, openTarget, plural, type Runtime } from '../runtime';
import { confirmOperation, confirmStatement, excerpt, type ConfirmState } from '../safety';
import type { TargetOverrides } from '../target';

/**
 * `joinery import`, `joinery export` and `joinery run-file` (spec §12, §6 Run SQL File): the
 * desktop job runner's @joinery/transfer engine on the command line. Progress goes to stderr
 * (a terminal gets a live line), then the summary; exports to `-` write the data to stdout.
 * Exit codes: 0 done, 1 done but rows were skipped or statements failed, 2 failed, 130
 * interrupted (Ctrl+C cancels and rolls the import back). The write rules are `query`'s:
 * read-only targets refuse, production and "confirm writes" profiles (and replace or delete
 * imports) need --yes or a confirmation in a terminal.
 */

/** Errors printed on stderr; the rest only go to --error-log. */
const SHOWN_ERRORS = 10;

export interface ImportDataOptions extends TargetOverrides {
  /** `schema.table` on PostgreSQL. */
  readonly table: string;
  /** A file, or '-' for stdin. */
  readonly file: string;
  readonly format?: RowFormat;
  readonly delimiter?: string;
  /** --no-header: the first row is data. */
  readonly header: boolean;
  readonly encoding?: string;
  /** Unquoted text that means NULL (default: an empty field). */
  readonly nullMarker?: string;
  /** Excel: the worksheet (default the first visible one). */
  readonly sheet?: string;
  /** Excel: the row holding the column names, 0 for none (default detected). */
  readonly headerRow?: number;
  /** XML: the path of the row elements (default detected). */
  readonly rowPath?: string;
  readonly mode: ImportMode;
  readonly key?: readonly string[];
  /** Create the table from the file's columns and inferred types. */
  readonly create: boolean;
  readonly batchSize?: number;
  readonly onError: 'stop' | 'skip';
  readonly transaction?: 'single' | 'per-batch';
  readonly disableForeignKeyChecks: boolean;
  /** --map file=column; without it columns are matched by name. */
  readonly map: readonly (readonly [string, string])[];
  readonly yes: boolean;
  readonly errorLog?: string;
}

export interface ExportDataOptions extends TargetOverrides {
  readonly tables: readonly string[];
  readonly query?: string;
  readonly format: ExportFormat;
  /** A file, a folder (several tables, one file each), or '-' for stdout. */
  readonly out: string;
  readonly gzip: boolean;
  /** A file per table (or the query's file) inside one ZIP archive at `out`. */
  readonly zip: boolean;
  /** Several tables into one file (every format but CSV, TSV and JSON Lines). */
  readonly oneFile: boolean;
  readonly header: boolean;
  readonly delimiter?: string;
  readonly nullMarker?: string;
  readonly pretty: boolean;
  readonly rowsPerInsert?: number;
  readonly dropTable: boolean;
  /** Excel: decimals as exact text (default) or as numbers where a double holds them. */
  readonly decimals?: 'text' | 'number';
  /** Parquet: the page codec (default Snappy). */
  readonly codec?: ParquetCompression;
  readonly bom: boolean;
  /** --yes: run a --query that needs confirmation without asking. */
  readonly yes: boolean;
}

export interface RunFileOptions extends TargetOverrides {
  readonly file: string;
  readonly continueOnError: boolean;
  readonly encoding?: string;
  readonly yes: boolean;
  readonly errorLog?: string;
}

// ---------------------------------------------------------------------------------------------
// Shared

interface TableRef {
  readonly schema?: string;
  readonly name: string;
}

/** `schema.table` on PostgreSQL (default: the session's current schema); a plain name on MySQL. */
async function tableRef(connection: Connection, name: string): Promise<TableRef> {
  const dot = name.indexOf('.');
  if (connection.dialect !== 'postgres') {
    if (dot >= 0) {
      throw new CliError(
        `MySQL and MariaDB tables are named without a database prefix ("${name}")`,
        { hint: 'Put the database in the connection URI or pass --database' },
      );
    }
    return { name };
  }
  if (dot > 0) return { schema: name.slice(0, dot), name: name.slice(dot + 1) };
  let schema: string | undefined;
  for await (const chunk of connection.session.execute('SELECT current_schema()', {
    executionId: newId(),
  })) {
    if (chunk.type === 'rows' && chunk.rowCount > 0 && schema === undefined) {
      const value = chunk.data[0]?.[0];
      if (typeof value === 'string') schema = value;
    }
  }
  return { schema: schema ?? 'public', name };
}

function describeTable(table: TableRef): string {
  return table.schema !== undefined ? `${table.schema}.${table.name}` : table.name;
}

/** Runs `work` with Ctrl+C aborting its signal (the server-side statement is cancelled too). */
function withAbort<T>(runtime: Runtime, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  return runtime.interrupts.guard(
    () => controller.abort(),
    () => work(controller.signal),
  );
}

function fileSize(runtime: Runtime, file: string): number {
  try {
    const stat = statSync(resolve(runtime.ctx.cwd, file));
    if (stat.isDirectory()) throw new CliError(`${file} is a folder, not a file`);
    return stat.size;
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError(`Cannot read ${file}: ${(error as NodeJS.ErrnoException).code ?? 'error'}`, {
      code: 'NOT_FOUND',
    });
  }
}

/** " 45%" of a known size. */
function percent(bytes: number, total: number | undefined): string {
  return total ? ` ${Math.min(100, Math.floor((bytes / total) * 100))}%` : '';
}

function rate(progress: TransferProgress): string {
  return progress.rowsPerSecond > 0
    ? ` · ${progress.rowsPerSecond.toLocaleString('en-US')} rows/s`
    : '';
}

/** A row error as one line: `row 12 (line 13), column price: …`. */
export function describeRowError(error: RowError): string {
  const where = [
    error.row !== undefined ? `row ${error.row}` : undefined,
    error.line !== undefined ? `(line ${error.line})` : undefined,
  ]
    .filter(Boolean)
    .join(' ');
  const column = error.column !== undefined ? `${where ? ', ' : ''}column ${error.column}` : '';
  return `${where}${column}${where || column ? ': ' : ''}${error.message}`;
}

const refuse = (): Promise<never> =>
  Promise.reject(
    new JoineryError({
      code: 'CONFIRMATION_REQUIRED',
      message: 'Cannot prompt while reading the rows from stdin',
    }),
  );

const nonInteractive: Prompter = {
  interactive: false,
  secret: refuse,
  text: refuse,
  confirm: refuse,
};

/** Bytes from stdin (text chunks are UTF-8). */
async function* stdinBytes(stdin: InputStream): AsyncGenerator<Uint8Array> {
  for await (const chunk of stdin) {
    yield typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
  }
}

/**
 * A source that can be read twice: the first `limit` bytes are kept, so the preview reads them
 * and the import reads them again before the rest (stdin cannot be reopened). `start` holds
 * the first bytes, to recognise a workbook.
 */
async function replayable(
  source: ByteSource,
  limit: number,
): Promise<{ head: ByteSource; all: ByteSource; start: Uint8Array }> {
  const iterator = source[Symbol.asyncIterator]();
  const chunks: Uint8Array[] = [];
  let length = 0;
  let ended = false;
  while (length < limit) {
    const next = await iterator.next();
    if (next.done === true) {
      ended = true;
      break;
    }
    chunks.push(next.value);
    length += next.value.length;
  }
  return {
    start: Buffer.concat(chunks.slice(0, 1)).subarray(0, 8),
    head: {
      async *[Symbol.asyncIterator]() {
        yield* chunks;
      },
    },
    all: {
      async *[Symbol.asyncIterator]() {
        yield* chunks;
        if (ended) return;
        for (;;) {
          const next = await iterator.next();
          if (next.done === true) return;
          yield next.value;
        }
      },
    },
  };
}

// ---------------------------------------------------------------------------------------------
// import

/**
 * `joinery import <target> --table <name> --file <path>`: reads CSV, TSV, JSON, JSON Lines
 * (gzip too), Excel or XML, detecting what the flags leave open, matches the file's columns to
 * the table's (or creates the table from the file with --create) and loads it in batches. A
 * workbook on stdin is spooled to a temporary file first: a ZIP is read from its end.
 */
export async function importDataCommand(
  runtime: Runtime,
  spec: string,
  options: ImportDataOptions,
): Promise<ExitCode> {
  const { reporter, ctx } = runtime;
  const fromStdin = options.file === '-';
  const size = fromStdin ? undefined : fileSize(runtime, options.file);
  const path = fromStdin ? undefined : resolve(ctx.cwd, options.file);
  const name = fromStdin ? '(stdin)' : options.file;
  if (options.create && options.map.length > 0) {
    throw new CliError('--map applies to existing tables; --create takes every file column');
  }
  if (options.create && options.mode !== 'append') {
    throw new CliError('A new table (--create) is imported with --mode append');
  }
  const connection = await openTarget(runtime, spec, options);
  let spooled: SpooledSource | undefined;
  try {
    const { session, target, dialect } = connection;
    if (target.policy.readOnly) {
      throw new CliError(`"${target.label}" is read-only, so nothing was imported`, {
        code: 'READ_ONLY',
        hint:
          target.readOnlySource === 'flag'
            ? 'Writes are refused because --read-only was given'
            : 'The profile is locked read-only; unlock it in the app or use another profile',
      });
    }
    const ref = await tableRef(connection, options.table);
    // Rows on stdin leave no terminal to answer a confirmation: only --yes gets through.
    const prompter = fromStdin ? nonInteractive : ctx.prompter;
    const destructive = options.mode === 'replace' || options.mode === 'delete';
    if (destructive) {
      await confirmOperation(
        options.mode === 'replace'
          ? `Replace empties ${describeTable(ref)} before importing. Continue?`
          : `Delete the rows of ${describeTable(ref)} that match the file?`,
        { yes: options.yes, prompter, reporter },
      );
    } else if (target.policy.production || target.policy.confirmWrites === true) {
      await confirmOperation(
        `Import into ${describeTable(ref)} on ${target.policy.production ? 'the production connection ' : ''}"${target.label}"?`,
        { yes: options.yes, prompter, reporter },
      );
    }

    const csv: CsvReadOptions = {
      header: options.header,
      ...(options.delimiter !== undefined ? { delimiter: options.delimiter } : {}),
      ...(options.nullMarker !== undefined ? { nullMarker: options.nullMarker } : {}),
    };
    let input: { head: ByteSource; all: ByteSource };
    if (fromStdin) {
      const stdin = await replayable(stdinBytes(ctx.stdin), 1024 * 1024);
      input = stdin;
      if (
        options.format === 'xlsx' ||
        options.format === 'parquet' ||
        isZip(stdin.start) ||
        isCompoundFile(stdin.start) ||
        isParquet(stdin.start)
      ) {
        reporter.progress(`Reading ${name}…`, true);
        spooled = await spoolToFile(stdin.all);
        input = { head: spooled.source, all: spooled.source };
      }
    } else {
      input = { head: fileSource(path!), all: fileSource(path!) };
    }
    const headerRow = options.headerRow ?? (options.header ? undefined : 0);
    reporter.progress(`Reading ${name}…`, true);
    const preview = await previewSource(input.head, {
      ...(path !== undefined ? { fileName: path } : {}),
      ...(options.format !== undefined ? { format: options.format } : {}),
      ...(options.encoding !== undefined ? { encoding: options.encoding } : {}),
      csv,
      xlsx: {
        ...(options.sheet !== undefined ? { sheet: options.sheet } : {}),
        ...(headerRow !== undefined ? { headerRow } : {}),
      },
      ...(options.rowPath !== undefined ? { xml: { rowPath: options.rowPath } } : {}),
    });
    reporter.clearProgress();
    if (preview.read === null) {
      throw new CliError(`${name} is a SQL script`, { hint: `Run it with: joinery run-file` });
    }
    const read = preview.read;
    const columns = preview.columns.map((c) => c.name);
    const details = read.xlsx
      ? `sheet ${JSON.stringify(read.xlsx.sheet)}, header row ${read.xlsx.headerRow ?? 1}`
      : read.xml
        ? `${preview.encoding}, rows at ${read.xml.rowPath}`
        : `${preview.encoding}${read.csv ? `, delimiter ${JSON.stringify(read.csv.delimiter)}, header ${read.csv.header === false ? 'no' : 'yes'}` : ''}`;
    reporter.debug(`${name}: ${read.format}, ${details}; columns ${columns.join(', ')}`);

    let table: TableDef;
    let mapping: ColumnMapping[];
    let created = false;
    if (options.create) {
      const planned = tableFromColumns(preview.columns, {
        name: ref.name,
        dialect,
        ...(options.key !== undefined ? { primaryKey: options.key } : {}),
      });
      table = planned.table;
      mapping = planned.mapping;
      await createTable(session, table, ref.schema !== undefined ? { schema: ref.schema } : {});
      created = true;
      reporter.info(
        `Created table ${describeTable(ref)} (${table.columns.map((c) => `${c.name} ${c.dataType}`).join(', ')})`,
      );
    } else {
      table = await loadTable(session, ref.name, ref.schema);
      if (options.map.length > 0) {
        const missing = options.map.find(([source]) => !columns.includes(source));
        if (missing) {
          throw new CliError(`--map: the file has no column "${missing[0]}"`, {
            hint: `Its columns: ${columns.join(', ')}`,
          });
        }
        mapping = options.map.map(([source, target]) => ({ source, target }));
      } else {
        mapping = autoMatch(columns, table);
        if (mapping.length === 0) {
          throw new CliError(`No column of ${name} matches a column of ${describeTable(ref)}`, {
            hint: 'Pair them with --map file_column=table_column',
          });
        }
        const unmatched = columns.filter((c) => !mapping.some((m) => m.source === c));
        if (unmatched.length > 0)
          reporter.warn(`Not imported (no matching column): ${unmatched.join(', ')}`);
      }
    }
    reporter.debug(`mapping: ${mapping.map((m) => `${m.source} → ${m.target}`).join(', ')}`);

    const summary = await withAbort(runtime, (signal) =>
      importRows({
        session,
        table,
        ...(ref.schema !== undefined ? { schema: ref.schema } : {}),
        rows: readRows(input.all, read),
        mapping,
        mode: options.mode,
        ...(options.key !== undefined && !options.create ? { keyColumns: options.key } : {}),
        ...(options.batchSize !== undefined ? { batchSize: options.batchSize } : {}),
        ...(options.transaction !== undefined ? { transaction: options.transaction } : {}),
        onError: options.onError,
        ...(options.disableForeignKeyChecks ? { disableForeignKeys: true } : {}),
        signal,
        onProgress: (progress) =>
          reporter.progress(
            `${name}:${percent(progress.bytes, size)} · ${progress.rowsWritten.toLocaleString('en-US')} rows${
              progress.rowsSkipped > 0
                ? `, ${progress.rowsSkipped.toLocaleString('en-US')} skipped`
                : ''
            }${rate(progress)} · ${formatDuration(progress.elapsedMs)}`,
          ),
      }),
    );
    reporter.clearProgress();
    if (created && summary.status !== 'completed' && summary.rowsWritten === 0) {
      await dropQuietly(session, dialect, ref);
      reporter.info(`Dropped the new table ${describeTable(ref)} again`);
    }
    writeErrorLog(runtime, options.errorLog, summary.errors.map(describeRowError));
    for (const error of summary.errors.slice(0, SHOWN_ERRORS)) {
      reporter.print(
        `${summary.status === 'completed' ? 'skipped' : 'error'}: ${describeRowError(error)}`,
      );
    }
    if (summary.errors.length > SHOWN_ERRORS) {
      reporter.print(
        `… ${plural(summary.errors.length - SHOWN_ERRORS, 'more error')}${options.errorLog ? ` in ${options.errorLog}` : ' (write them all with --error-log)'}`,
      );
    }
    if (summary.status === 'cancelled') throw new InterruptedError();
    const rows = plural(summary.rowsWritten, 'row');
    const time = formatDuration(summary.durationMs);
    const perSecond =
      summary.durationMs > 0
        ? `, ${Math.round((summary.rowsWritten * 1000) / summary.durationMs).toLocaleString('en-US')} rows/s`
        : '';
    if (summary.status === 'failed') {
      reporter.print(
        `Import failed after ${plural(summary.rowsRead, 'row')} read; ${summary.rowsWritten > 0 ? `${rows} kept` : 'nothing was kept'}`,
      );
      return EXIT.error;
    }
    reporter.info(
      `Imported ${rows} into ${describeTable(ref)} in ${time}${perSecond}${
        summary.rowsSkipped > 0 ? `; ${plural(summary.rowsSkipped, 'row')} skipped` : ''
      }`,
    );
    return summary.rowsSkipped > 0 ? EXIT.partial : EXIT.ok;
  } finally {
    reporter.clearProgress();
    await spooled?.close().catch(() => undefined);
    await closeQuietly(connection);
  }
}

async function dropQuietly(session: Session, dialect: SqlDialect, table: TableRef): Promise<void> {
  const name =
    dialect === 'postgres'
      ? quoteQualified([table.schema, table.name], dialect)
      : quoteIdent(table.name, dialect);
  try {
    for await (const _chunk of session.execute(`DROP TABLE ${name}`, { executionId: newId() })) {
      // drained
    }
  } catch {
    // The table stays; nothing else to do.
  }
}

function writeErrorLog(runtime: Runtime, file: string | undefined, lines: readonly string[]): void {
  if (file === undefined) return;
  writeFileSync(resolve(runtime.ctx.cwd, file), lines.map((line) => `${line}\n`).join(''));
}

// ---------------------------------------------------------------------------------------------
// export

/** stdout as an export sink: UTF-8 text through the CLI's backpressure-aware writer. */
function stdoutSink(runtime: Runtime): Sink {
  const decoder = new TextDecoder('utf-8');
  return {
    write: (chunk) => runtime.stdout.write(decoder.decode(chunk, { stream: true })),
    close: () => runtime.stdout.write(decoder.decode()),
    abort: async () => undefined,
  };
}

export { exportFileName } from '@joinery/transfer';

/**
 * `joinery export <target> (--table <name>... | --query <sql>) --format <f> --out <path|->`:
 * tables or a query result to CSV, TSV, JSON, JSON Lines, Excel, XML, SQL INSERTs, SQL with
 * DDL, HTML or Markdown. Several tables go one file per table into the --out folder, into one
 * file with --one-file, or into one ZIP archive with --zip.
 */
export async function exportDataCommand(
  runtime: Runtime,
  spec: string,
  options: ExportDataOptions,
): Promise<ExitCode> {
  const { reporter, ctx } = runtime;
  if ((options.query !== undefined) === options.tables.length > 0) {
    throw new CliError('Pass --table (one or more) or --query, not both');
  }
  if (options.query !== undefined && options.format === 'sql-ddl') {
    throw new CliError('SQL with DDL exports tables, not a query', { hint: 'Use --format sql' });
  }
  const toStdout = options.out === '-';
  if (toStdout && options.gzip) {
    throw new CliError('--gzip writes a file', { hint: 'Pipe stdout through gzip instead' });
  }
  if (options.gzip && options.zip) throw new CliError('Choose --gzip or --zip, not both');
  if (toStdout && (options.zip || options.format === 'xlsx' || options.format === 'parquet')) {
    const what = options.zip
      ? '--zip'
      : options.format === 'xlsx'
        ? 'An Excel workbook'
        : 'A Parquet file';
    throw new CliError(`${what} writes a file`, { hint: 'Give --out a file name' });
  }
  if (options.gzip && options.format === 'parquet') {
    throw new CliError('A gzipped Parquet file is one other tools cannot read', {
      hint: 'Parquet compresses its own pages: use --codec zstd for smaller files',
    });
  }
  if (options.codec !== undefined && options.format !== 'parquet') {
    throw new CliError('--codec is for --format parquet');
  }
  const several = options.tables.length > 1;
  if (options.zip && options.oneFile) {
    throw new CliError('--zip holds a file per table; leave out --one-file');
  }
  const combined = several && options.oneFile;
  if (combined && !combinableFormat(options.format)) {
    throw new CliError(
      `--one-file is available for every format but csv, tsv, jsonl and parquet, not ${options.format}`,
    );
  }
  if (several && !combined && !options.zip && toStdout) {
    throw new CliError('Several tables need a folder for --out, --one-file or --zip');
  }
  const connection = await openTarget(runtime, spec, options);
  try {
    const { session, target, dialect } = connection;
    if (options.query !== undefined) {
      // The query is run as given, so it passes `query`'s safety check.
      await confirmStatement(
        decideSafety(analyzeStatement(options.query, dialect), target.policy),
        { index: 1, text: options.query },
        target,
        { yes: options.yes, prompter: ctx.prompter, reporter, state: { yesToAll: false } },
      );
    }
    const common: ExportCommonOptions = {
      session,
      format: options.format,
      csv: {
        header: options.header,
        ...(options.delimiter !== undefined ? { delimiter: options.delimiter } : {}),
        ...(options.nullMarker !== undefined ? { nullMarker: options.nullMarker } : {}),
      },
      json: { pretty: options.pretty },
      sql: {
        ...(options.rowsPerInsert !== undefined ? { rowsPerStatement: options.rowsPerInsert } : {}),
        ...(options.dropTable ? { dropTable: true } : {}),
      },
      xlsx: {
        header: options.header,
        ...(options.decimals !== undefined ? { decimals: options.decimals } : {}),
      },
      parquet: options.codec !== undefined ? { compression: options.codec } : {},
      ...(options.bom ? { bom: true } : {}),
      onProgress: (progress) =>
        reporter.progress(
          `${progress.table ?? 'query'}: ${progress.rowsWritten.toLocaleString('en-US')} rows${rate(progress)} · ${formatDuration(progress.elapsedMs)}`,
        ),
    };
    const outPath = toStdout ? undefined : resolve(ctx.cwd, options.out);
    const sink = (): Sink =>
      outPath ? fileSink(outPath, { gzip: options.gzip }) : stdoutSink(runtime);
    const tables: ExportTable[] = [];
    for (const name of options.tables) {
      const ref = await tableRef(connection, name);
      tables.push({ name: ref.name, ...(ref.schema !== undefined ? { schema: ref.schema } : {}) });
    }
    const written: string[] = [];
    const summary = await withAbort(runtime, async (signal): Promise<ExportSummary> => {
      if (options.zip && options.query === undefined) {
        return exportTables({ ...common, signal, tables, output: { kind: 'zip', sink: sink() } });
      }
      if (options.query !== undefined) {
        return exportRows({
          ...common,
          signal,
          query: options.query,
          sink: sink(),
          ...(options.zip ? { zipEntry: exportFileName('query_result', options.format) } : {}),
        });
      }
      if (!several) return exportRows({ ...common, signal, table: tables[0]!, sink: sink() });
      if (combined) {
        return exportTables({
          ...common,
          signal,
          tables,
          output: { kind: 'combined', sink: sink() },
        });
      }
      mkdirSync(outPath!, { recursive: true });
      const taken = new Set<string>();
      return exportTables({
        ...common,
        signal,
        tables,
        output: {
          kind: 'per-table',
          sinkFor: (table) => {
            let file = exportFileName(table.name, options.format, options.gzip);
            for (let n = 2; taken.has(file.toLowerCase()); n++) {
              file = exportFileName(`${table.name}_${n}`, options.format, options.gzip);
            }
            taken.add(file.toLowerCase());
            written.push(join(options.out, file));
            return fileSink(join(outPath!, file), { gzip: options.gzip });
          },
        },
      });
    });
    reporter.clearProgress();
    if (summary.status === 'cancelled') throw new InterruptedError();
    if (summary.status === 'failed') {
      for (const error of summary.errors) reporter.print(`error: ${error.message}`);
      reporter.print(`Export failed after ${plural(summary.rowsWritten, 'row')}`);
      return EXIT.error;
    }
    const where = toStdout
      ? 'stdout'
      : several && !combined && !options.zip
        ? `${plural(written.length, 'file')} in ${options.out}`
        : options.out;
    reporter.info(
      `Exported ${plural(summary.rowsWritten, 'row')}${several ? ` from ${plural(tables.length, 'table')}` : ''} to ${where} (${plural(summary.bytesWritten, 'byte')}) in ${formatDuration(summary.durationMs)}`,
    );
    return EXIT.ok;
  } finally {
    reporter.clearProgress();
    await closeQuietly(connection);
  }
}

// ---------------------------------------------------------------------------------------------
// run-file

/**
 * `joinery run-file <target> <file.sql>`: streams a SQL file (gzip too) through the statement
 * splitter and runs it statement by statement, discarding result rows, with progress and an
 * error log. Stops at the first failing statement unless --continue.
 */
export async function runFileCommand(
  runtime: Runtime,
  spec: string,
  options: RunFileOptions,
): Promise<ExitCode> {
  const { reporter, ctx } = runtime;
  const size = fileSize(runtime, options.file);
  const path = resolve(ctx.cwd, options.file);
  const name = basename(options.file);
  const connection = await openTarget(runtime, spec, options);
  try {
    const { session, target, dialect } = connection;
    const confirm: ConfirmState = { yesToAll: false };
    let index = 0;
    // Each statement passes the safety check (`query`'s rules) as the file streams.
    const guarded: Session = {
      engine: session.engine,
      serverVersion: session.serverVersion,
      capabilities: () => session.capabilities(),
      execute: (text, execOptions) => {
        const statement = ++index;
        return (async function* () {
          await confirmStatement(
            decideSafety(analyzeStatement(text, dialect), target.policy),
            { index: statement, text },
            target,
            { yes: options.yes, prompter: ctx.prompter, reporter, state: confirm },
          );
          yield* session.execute(text, execOptions);
        })();
      },
      cancel: (executionId) => session.cancel(executionId),
      introspect: (scope) => session.introspect(scope),
      browse: (nodePath) => session.browse(nodePath),
      get inTransaction() {
        return session.inTransaction;
      },
      ping: () => session.ping(),
      close: () => session.close(),
    };
    const summary = await withAbort(runtime, (signal) =>
      runSqlFile({
        session: guarded,
        source: fileSource(path),
        onError: options.continueOnError ? 'continue' : 'stop',
        ...(options.encoding !== undefined ? { encoding: options.encoding } : {}),
        signal,
        onProgress: (progress) =>
          reporter.progress(
            `${name}:${percent(progress.bytes, size)} · statement ${progress.statements.toLocaleString('en-US')}${
              progress.failed > 0 ? `, ${progress.failed} failed` : ''
            } · ${formatDuration(progress.elapsedMs)}`,
          ),
      }),
    );
    reporter.clearProgress();
    writeErrorLog(
      runtime,
      options.errorLog,
      summary.errors.map((error) => statementLog(error, name)),
    );
    for (const error of summary.errors.slice(0, SHOWN_ERRORS)) {
      reporter.print(`error: ${error.message}`);
      reporter.print(`  at statement ${error.statement} (${name}:${error.line}:${error.column})`);
      if (error.text !== '') reporter.print(excerpt(error.text, 3));
    }
    if (summary.errors.length > SHOWN_ERRORS) {
      reporter.print(`… ${plural(summary.errors.length - SHOWN_ERRORS, 'more error')}`);
    }
    if (summary.status === 'cancelled') throw new InterruptedError();
    reporter.info(
      `Ran ${plural(summary.statements, 'statement')} in ${formatDuration(summary.durationMs)}${
        summary.failed > 0 ? `, ${summary.failed} failed` : ''
      }${summary.rowsAffected > 0 ? `; ${plural(summary.rowsAffected, 'row')} affected` : ''}`,
    );
    if (session.inTransaction) {
      reporter.warn('The file left a transaction open; it was rolled back');
    }
    if (summary.status === 'failed') return EXIT.error;
    return summary.failed > 0 ? EXIT.partial : EXIT.ok;
  } finally {
    reporter.clearProgress();
    await closeQuietly(connection);
  }
}

function statementLog(error: SqlStatementError, name: string): string {
  return `-- statement ${error.statement} (${name}:${error.line}:${error.column})\n-- error: ${error.message.replace(/\n/g, ' ')}\n${error.text}\n`;
}
