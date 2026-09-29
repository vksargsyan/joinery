import { stat } from 'node:fs/promises';
import { join } from 'node:path';

import {
  JoineryError,
  isSqlEngine,
  newId,
  tableDefSchema,
  type Session,
  type SqlDialect,
  type TableDef,
} from '@joinery/core';
import type {
  ExportJob,
  ImportJob,
  JobProgress,
  JobRowError,
  JobSummary,
  NewTableColumn,
  NewTablePlan,
  NewTablePlanInput,
  RunSqlFileJob,
  TransferPreview,
  TransferPreviewInput,
} from '@joinery/ipc';
import { analyzeStatement, quoteIdent, quoteQualified } from '@joinery/sql-tools';
import { renderTableStatements } from '@joinery/sync';
import {
  autoMatch,
  createTable,
  exportFileName,
  exportRows,
  exportTables,
  fileSink,
  fileSource,
  importRows,
  isJsonText,
  loadTable,
  previewSource,
  readRows,
  runSqlFile,
  tableFromColumns,
  type ColumnMapping,
  type CsvExportOptions,
  type ExportCommonOptions,
  type ExportSummary,
  type ExportTablesSummary,
  type SourceCell,
  type TransferProgress,
} from '@joinery/transfer';

export { exportFileName } from '@joinery/transfer';

/**
 * What the job runner does with the @joinery/transfer engine (spec §12): the three job kinds
 * (import, export, Run SQL File), and the quick requests the wizards make before a job starts
 * (file preview, auto-match, the new table plan). Everything here takes a driver session and
 * plain data, so the tests drive it with a fake session and temporary files.
 */

/** What a running job reports through. */
export interface JobContext {
  readonly session: Session;
  readonly signal: AbortSignal;
  /** The profile is locked read-only (spec §4). */
  readonly readOnly: boolean;
  progress(progress: Omit<JobProgress, 'elapsedMs'>): void;
  log(level: 'info' | 'warning' | 'error', message: string): void;
}

/** A job's outcome: the summary and the rows or statements that failed. */
export interface JobOutcome {
  readonly summary: JobSummary;
  readonly errors: readonly JobRowError[];
}

const MAX_PREVIEW_CELL = 500;

function dialectOf(session: Session): SqlDialect {
  if (isSqlEngine(session.engine)) return session.engine;
  throw new JoineryError({
    code: 'NOT_SUPPORTED',
    message: `Data transfer with ${session.engine} is not supported yet`,
  });
}

function plural(count: number, word: string): string {
  return `${count.toLocaleString('en-US')} ${word}${count === 1 ? '' : 's'}`;
}

async function fileSize(path: string): Promise<number> {
  try {
    const info = await stat(path);
    if (info.isDirectory()) {
      throw new JoineryError({ code: 'VALIDATION_FAILED', message: `${path} is a folder` });
    }
    return info.size;
  } catch (error) {
    if (error instanceof JoineryError) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    throw new JoineryError({
      code: code === 'ENOENT' ? 'NOT_FOUND' : 'VALIDATION_FAILED',
      message: code === 'ENOENT' ? `${path} does not exist` : `${path} cannot be read (${code})`,
    });
  }
}

// ---------------------------------------------------------------------------------------------
// Wizard requests

/** A preview cell as display text: JSON values as their source text, long values cut. */
export function displayCell(cell: SourceCell): string | null {
  if (cell === null) return null;
  const text = isJsonText(cell) ? cell.$json : String(cell);
  return text.length > MAX_PREVIEW_CELL ? `${text.slice(0, MAX_PREVIEW_CELL)}…` : text;
}

/** Reads the start of a file and reports what it holds (spec §12: preview with detection). */
export async function previewFile(input: TransferPreviewInput): Promise<TransferPreview> {
  const size = await fileSize(input.path);
  const preview = await previewSource(fileSource(input.path), {
    fileName: input.path,
    sampleRows: input.sampleRows ?? 100,
    ...(input.format !== undefined ? { format: input.format } : {}),
    ...(input.encoding !== undefined ? { encoding: input.encoding } : {}),
    ...(input.csv !== undefined ? { csv: input.csv } : {}),
    ...(input.xlsx !== undefined ? { xlsx: input.xlsx } : {}),
    ...(input.xml !== undefined ? { xml: input.xml } : {}),
    ...(input.dialect !== undefined ? { sqlDialect: input.dialect } : {}),
  });
  const csv = preview.read?.csv;
  const xlsx = preview.read?.xlsx;
  const xml = preview.read?.xml;
  return {
    format: preview.format,
    compression: preview.compression,
    encoding: preview.encoding,
    bom: preview.bom,
    complete: preview.complete,
    ...(csv !== undefined && (preview.format === 'csv' || preview.format === 'tsv')
      ? {
          csv: {
            delimiter: csv.delimiter ?? ',',
            quote: csv.quote === undefined ? '"' : csv.quote,
            escape: csv.escape === undefined ? '"' : csv.escape,
            nullMarker: csv.nullMarker === undefined ? '' : csv.nullMarker,
            header: csv.header ?? true,
          },
        }
      : {}),
    columns: preview.columns.map((column) => ({ ...column })),
    rows: preview.rows.map((row) => row.map(displayCell)),
    ...(preview.statements !== undefined ? { statements: [...preview.statements] } : {}),
    ...(preview.sheets !== undefined ? { sheets: [...preview.sheets] } : {}),
    ...(xlsx?.sheet !== undefined
      ? { xlsx: { sheet: xlsx.sheet, headerRow: xlsx.headerRow ?? 1 } }
      : {}),
    ...(xml?.rowPath !== undefined
      ? {
          xml: {
            rowPath: xml.rowPath,
            candidates: (preview.rowPaths ?? []).map((candidate) => ({ ...candidate })),
          },
        }
      : {}),
    size,
  };
}

/** Pairs file columns with table columns by name. */
export function matchColumns(
  sources: readonly string[],
  targets: readonly string[],
): ColumnMapping[] {
  return autoMatch(sources, targets);
}

/** The definition of a table created from a file: the given columns, primary key NOT NULL. */
export function newTableDef(
  name: string,
  dialect: SqlDialect,
  columns: readonly NewTableColumn[],
  primaryKey: readonly string[],
): TableDef {
  const missing = primaryKey.filter((key) => !columns.some((c) => c.name === key));
  if (missing.length > 0) {
    throw new JoineryError({
      code: 'VALIDATION_FAILED',
      message: `Primary key column "${missing[0]}" is not one of the new columns`,
    });
  }
  const seen = new Set<string>();
  for (const column of columns) {
    const key = dialect === 'postgres' ? column.name : column.name.toLowerCase();
    if (seen.has(key)) {
      throw new JoineryError({
        code: 'VALIDATION_FAILED',
        message: `Column "${column.name}" appears twice`,
      });
    }
    seen.add(key);
  }
  return tableDefSchema.parse({
    name,
    columns: columns.map((column, index) => ({
      name: column.name,
      ordinal: index + 1,
      dataType: column.dataType,
      nullable: column.nullable && !primaryKey.includes(column.name),
      default: null,
      autoIncrement: false,
    })),
    ...(primaryKey.length > 0
      ? {
          primaryKey: {
            name: dialect === 'postgres' ? `${name}_pkey` : 'PRIMARY',
            columns: [...primaryKey],
          },
        }
      : {}),
  });
}

/**
 * The new table for "import into a new table": `tableFromColumns` names and types the inferred
 * columns (the user's names and types win), and the CREATE TABLE script is rendered from it.
 */
export function planNewTable(input: NewTablePlanInput): NewTablePlan {
  const sources = input.columns.map((column) => column.inferred.name);
  const renamed = input.columns.map((column) => ({
    ...column.inferred,
    name: column.name?.trim() || column.inferred.name,
  }));
  const primarySources = new Set(input.primaryKey ?? []);
  const { table } = tableFromColumns(renamed, {
    name: input.name,
    dialect: input.dialect,
    primaryKey: renamed.filter((_, i) => primarySources.has(sources[i]!)).map((c) => c.name),
  });
  const columns: NewTableColumn[] = table.columns.map((column, i) => {
    const edit = input.columns[i]!;
    return {
      source: sources[i]!,
      name: column.name,
      dataType: edit.dataType?.trim() || column.dataType,
      nullable: primarySources.has(sources[i]!) ? false : (edit.nullable ?? column.nullable),
    };
  });
  const primaryKey = table.primaryKey ? [...table.primaryKey.columns] : [];
  const def = newTableDef(input.name, input.dialect, columns, primaryKey);
  const statements = renderTableStatements(
    def,
    input.dialect,
    input.dialect === 'postgres' && input.schema !== undefined ? { schema: input.schema } : {},
  );
  return { columns, primaryKey, statements };
}

// ---------------------------------------------------------------------------------------------
// Import

function transferProgress(
  phase: string,
  progress: TransferProgress,
  totalBytes?: number,
): Omit<JobProgress, 'elapsedMs'> {
  return {
    phase,
    rowsRead: progress.rowsRead,
    rowsWritten: progress.rowsWritten,
    rowsSkipped: progress.rowsSkipped,
    bytes: progress.bytes,
    rowsPerSecond: progress.rowsPerSecond,
    ...(totalBytes !== undefined ? { totalBytes } : {}),
    ...(progress.table !== undefined ? { table: progress.table } : {}),
  };
}

/** Imports a file into a table (spec §12), creating the table first when asked to. */
export async function runImport(job: ImportJob, context: JobContext): Promise<JobOutcome> {
  const { session, signal } = context;
  if (context.readOnly) {
    throw new JoineryError({
      code: 'READ_ONLY',
      message: 'This connection is read-only, so nothing was imported',
    });
  }
  const dialect = dialectOf(session);
  const schema = dialect === 'postgres' ? (job.table.schema ?? 'public') : undefined;
  const totalBytes = await fileSize(job.file.path);
  let table: TableDef;
  let created = false;
  if (job.create !== undefined) {
    table = newTableDef(job.table.name, dialect, job.create.columns, job.create.primaryKey);
    context.progress({ phase: 'Creating the table' });
    await createTable(session, table, schema !== undefined ? { schema } : {});
    created = true;
    context.log('info', `Created table ${job.table.name}`);
  } else {
    context.progress({ phase: 'Reading the table definition' });
    table = await loadTable(session, job.table.name, schema);
  }
  context.progress({ phase: 'Importing', bytes: 0, totalBytes });
  context.log(
    'info',
    `Importing ${job.file.path} into ${job.table.name} (${job.mode}, ${job.file.format.toUpperCase()})`,
  );
  const summary = await importRows({
    session,
    table,
    ...(schema !== undefined ? { schema } : {}),
    rows: readRows(fileSource(job.file.path), {
      format: job.file.format,
      decompress: 'auto',
      ...(job.file.encoding !== undefined ? { encoding: job.file.encoding } : {}),
      ...(job.file.csv !== undefined ? { csv: job.file.csv } : {}),
      ...(job.file.xlsx !== undefined ? { xlsx: job.file.xlsx } : {}),
      ...(job.file.xml !== undefined ? { xml: job.file.xml } : {}),
    }),
    mapping: job.mapping,
    mode: job.mode,
    ...(job.keyColumns !== undefined && job.keyColumns.length > 0
      ? { keyColumns: job.keyColumns }
      : {}),
    ...(job.batchSize !== undefined ? { batchSize: job.batchSize } : {}),
    ...(job.transaction !== undefined ? { transaction: job.transaction } : {}),
    ...(job.onError !== undefined ? { onError: job.onError } : {}),
    ...(job.disableForeignKeys === true ? { disableForeignKeys: true } : {}),
    signal,
    onProgress: (progress) => context.progress(transferProgress('Importing', progress, totalBytes)),
  });
  if (created && summary.status !== 'completed' && summary.rowsWritten === 0) {
    // The job made the table for this import; an import that kept nothing takes it back out.
    try {
      const name =
        dialect === 'postgres'
          ? quoteQualified([schema, job.table.name], dialect)
          : quoteIdent(job.table.name, dialect);
      for await (const _chunk of session.execute(`DROP TABLE ${name}`, { executionId: newId() })) {
        // drained
      }
      context.log('info', `Dropped the new table ${job.table.name} again`);
    } catch (error) {
      context.log(
        'warning',
        `The new table ${job.table.name} stays: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  const verb =
    summary.status === 'completed'
      ? 'Imported'
      : summary.status === 'cancelled'
        ? 'Cancelled after'
        : 'Failed after';
  context.log(
    summary.status === 'completed' ? 'info' : 'error',
    `${verb} ${plural(summary.rowsWritten, 'row')} kept of ${plural(summary.rowsRead, 'row')} read${
      summary.rowsSkipped > 0 ? `, ${plural(summary.rowsSkipped, 'row')} skipped` : ''
    }`,
  );
  return {
    summary: {
      status: summary.status,
      rowsRead: summary.rowsRead,
      rowsWritten: summary.rowsWritten,
      rowsSkipped: summary.rowsSkipped,
      rowsAffected: summary.rowsAffected,
      durationMs: summary.durationMs,
    },
    errors: summary.errors.map((error) => ({
      ...(error.row !== undefined ? { row: error.row } : {}),
      ...(error.line !== undefined ? { line: error.line } : {}),
      ...(error.column !== undefined ? { column: error.column } : {}),
      message: error.message,
    })),
  };
}

// ---------------------------------------------------------------------------------------------
// Export

/**
 * Exports tables or a query result to one file, a file per table, or a ZIP archive of a file
 * per table (spec §12).
 */
export async function runExport(job: ExportJob, context: JobContext): Promise<JobOutcome> {
  const { session, signal } = context;
  const dialect = dialectOf(session);
  const zip = job.zip === true;
  const gzip = job.gzip === true && !zip;
  const csv: CsvExportOptions = {
    ...(job.csv?.header !== undefined ? { header: job.csv.header } : {}),
    ...(job.csv?.delimiter !== undefined ? { delimiter: job.csv.delimiter } : {}),
    ...(job.csv?.quote !== undefined ? { quote: job.csv.quote } : {}),
    ...(job.csv?.nullMarker !== undefined ? { nullMarker: job.csv.nullMarker } : {}),
    ...(job.csv?.lineEnding !== undefined ? { lineEnding: job.csv.lineEnding } : {}),
  };
  const files: string[] = [];
  const common: ExportCommonOptions = {
    session,
    format: job.format,
    csv,
    json: { pretty: job.json?.pretty === true },
    sql: {
      ...(job.sql?.rowsPerStatement !== undefined
        ? { rowsPerStatement: job.sql.rowsPerStatement }
        : {}),
      ...(job.sql?.dropTable === true ? { dropTable: true } : {}),
    },
    xlsx: {
      ...(job.xlsx?.header !== undefined ? { header: job.xlsx.header } : {}),
      ...(job.xlsx?.decimals !== undefined ? { decimals: job.xlsx.decimals } : {}),
    },
    ...(job.encoding !== undefined ? { encoding: job.encoding } : {}),
    ...(job.bom === true ? { bom: true } : {}),
    signal,
    onProgress: (progress) =>
      context.progress(
        transferProgress(
          progress.table !== undefined ? `Exporting ${progress.table}` : 'Exporting',
          progress,
        ),
      ),
  };
  const sinkAt = (path: string) => {
    files.push(path);
    return fileSink(path, { gzip });
  };
  const schema = dialect === 'postgres' && job.source.kind === 'tables' ? job.source.schema : '';
  let summary: ExportSummary | ExportTablesSummary;
  context.progress({ phase: 'Exporting', rowsWritten: 0, bytes: 0 });
  if (zip && job.output.kind !== 'file') {
    throw new JoineryError({
      code: 'VALIDATION_FAILED',
      message: 'A ZIP export writes one file',
    });
  }
  if (job.source.kind === 'query') {
    if (job.output.kind !== 'file') {
      throw new JoineryError({
        code: 'VALIDATION_FAILED',
        message: 'A query result exports to one file',
      });
    }
    if (analyzeStatement(job.source.text, dialect).isWrite) {
      // The export runs the statement again: a write would happen a second time.
      throw new JoineryError({
        code: 'VALIDATION_FAILED',
        message: 'The statement writes, so it is not run again to export its rows',
        hint: 'Export the rows with a SELECT instead.',
      });
    }
    context.log('info', `Exporting a query result to ${job.output.path}`);
    summary = await exportRows({
      ...common,
      query: {
        text: job.source.text,
        ...(job.source.params !== undefined ? { params: job.source.params } : {}),
      },
      sink: sinkAt(job.output.path),
      ...(zip ? { zipEntry: exportFileName('query_result', job.format) } : {}),
    });
  } else {
    const tables = job.source.tables.map((name) => ({
      name,
      ...(schema ? { schema } : {}),
    }));
    if (zip) {
      context.log(
        'info',
        `Exporting ${plural(tables.length, 'table')} into the ZIP archive ${job.output.path}`,
      );
      summary = await exportTables({
        ...common,
        tables,
        output: { kind: 'zip', sink: sinkAt(job.output.path) },
      });
    } else if (job.output.kind === 'file' && tables.length === 1) {
      context.log('info', `Exporting ${tables[0]!.name} to ${job.output.path}`);
      summary = await exportRows({ ...common, table: tables[0]!, sink: sinkAt(job.output.path) });
    } else if (job.output.kind === 'file') {
      context.log('info', `Exporting ${plural(tables.length, 'table')} to ${job.output.path}`);
      summary = await exportTables({
        ...common,
        tables,
        output: { kind: 'combined', sink: sinkAt(job.output.path) },
      });
    } else {
      const directory = job.output.path;
      const taken = new Set<string>();
      context.log('info', `Exporting ${plural(tables.length, 'table')} to ${directory}`);
      summary = await exportTables({
        ...common,
        tables,
        output: {
          kind: 'per-table',
          sinkFor: (table) => {
            let name = exportFileName(table.name, job.format, gzip);
            for (let n = 2; taken.has(name.toLowerCase()); n++) {
              name = exportFileName(`${table.name}_${n}`, job.format, gzip);
            }
            taken.add(name.toLowerCase());
            return sinkAt(join(directory, name));
          },
        },
      });
    }
  }
  const tables = 'tables' in summary ? summary.tables : undefined;
  context.log(
    summary.status === 'completed' ? 'info' : 'error',
    summary.status === 'completed'
      ? `Exported ${plural(summary.rowsWritten, 'row')} (${plural(summary.bytesWritten, 'byte')})`
      : `Export ${summary.status} after ${plural(summary.rowsWritten, 'row')}`,
  );
  return {
    summary: {
      status: summary.status,
      rowsRead: summary.rowsRead,
      rowsWritten: summary.rowsWritten,
      rowsSkipped: summary.rowsSkipped,
      bytesWritten: summary.bytesWritten,
      durationMs: summary.durationMs,
      ...(tables !== undefined
        ? {
            tables: tables.map((t) => ({
              table: t.table,
              status: t.status,
              rowsWritten: t.rowsWritten,
              bytesWritten: t.bytesWritten,
            })),
          }
        : {}),
      files: summary.status === 'completed' ? files : [],
    },
    errors: summary.errors.map((error) => ({ message: error.message })),
  };
}

// ---------------------------------------------------------------------------------------------
// Run SQL file

/**
 * The session a read-only profile runs a SQL file on: each statement is analysed as the file
 * streams (spec §6 safety), and the first one that writes stops the run before it reaches the
 * server.
 */
function readOnlySession(
  session: Session,
  dialect: SqlDialect,
  refuse: (text: string, statement: number) => void,
): Session {
  let statement = 0;
  return {
    engine: session.engine,
    serverVersion: session.serverVersion,
    capabilities: () => session.capabilities(),
    execute: (text, options) => {
      statement++;
      if (analyzeStatement(text, dialect).isWrite) {
        refuse(text, statement);
        throw new JoineryError({
          code: 'READ_ONLY',
          message: `This connection is read-only, so statement ${statement} was not run: it writes`,
        });
      }
      return session.execute(text, options);
    },
    cancel: (executionId) => session.cancel(executionId),
    introspect: (scope) => session.introspect(scope),
    browse: (path) => session.browse(path),
    get inTransaction() {
      return session.inTransaction;
    },
    ping: () => session.ping(),
    close: () => session.close(),
  };
}

/** Runs a .sql file statement by statement with progress and an error log (spec §6). */
export async function runSqlFileJob(job: RunSqlFileJob, context: JobContext): Promise<JobOutcome> {
  const dialect = dialectOf(context.session);
  const totalBytes = await fileSize(job.path);
  const stop = new AbortController();
  const signal = AbortSignal.any([context.signal, stop.signal]);
  let refused: JobRowError | undefined;
  const session = context.readOnly
    ? readOnlySession(context.session, dialect, (text, statement) => {
        refused = {
          statement,
          message: `This connection is read-only, so statement ${statement} was not run: it writes`,
          text: text.slice(0, 200),
        };
        stop.abort();
      })
    : context.session;
  context.log(
    'info',
    `Running ${job.path} (${job.onError === 'continue' ? 'continue on error' : 'stop on error'})`,
  );
  context.progress({ phase: 'Running statements', statements: 0, bytes: 0, totalBytes });
  const summary = await runSqlFile({
    session,
    source: fileSource(job.path),
    onError: job.onError,
    ...(job.encoding !== undefined ? { encoding: job.encoding } : {}),
    signal,
    onProgress: (progress) =>
      context.progress({
        phase: 'Running statements',
        statements: progress.statements,
        failed: progress.failed,
        bytes: progress.bytes,
        totalBytes,
        rowsWritten: progress.rowsAffected,
      }),
  });
  const errors: JobRowError[] = summary.errors.map((error) => ({
    statement: error.statement,
    ...(error.line > 0 ? { line: error.line, position: error.column } : {}),
    message: error.message,
    ...(error.text !== '' ? { text: error.text } : {}),
  }));
  for (const error of errors) {
    context.log(
      'error',
      `Statement ${error.statement ?? '?'}${error.line !== undefined ? ` (line ${error.line})` : ''}: ${error.message}`,
    );
  }
  let status = summary.status;
  let failed = summary.failed;
  if (refused !== undefined && !context.signal.aborted) {
    status = 'failed';
    failed += 1;
    errors.push(refused);
    context.log('error', refused.message);
  }
  context.log(
    status === 'completed' ? 'info' : 'error',
    `${status === 'completed' ? 'Ran' : status === 'cancelled' ? 'Cancelled after' : 'Stopped after'} ${plural(
      summary.statements,
      'statement',
    )}${failed > 0 ? `, ${failed} failed` : ''}`,
  );
  return {
    summary: {
      status,
      rowsRead: 0,
      rowsWritten: summary.rowsAffected,
      rowsSkipped: 0,
      rowsAffected: summary.rowsAffected,
      statements: summary.statements,
      failed,
      durationMs: summary.durationMs,
    },
    errors,
  };
}
