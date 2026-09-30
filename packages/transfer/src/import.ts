import {
  JoineryError,
  newId,
  rowAt,
  type CellValue,
  type ColumnDef,
  type Session,
  type SqlDialect,
  type TableDef,
} from '@joinery/core';

import {
  ConversionError,
  converterFor,
  type ColumnMapping,
  type ConversionOptions,
  type Converter,
} from './mapping';
import { dialectOf } from './session';
import {
  MAX_PARAMETERS,
  buildStatement,
  emptyTableStatement,
  supportsRowAlias,
  type ImportMode,
  type StatementPlan,
} from './statements';
import type { RowBatch, RowError, TransferProgress, TransferSummary } from './types';

/**
 * Batched, parameterised loads into one table (spec §12, §18: at least 50,000 rows/s into a
 * local server). Rows stream from a reader through per-column conversions into multi-row
 * statements sized under the engine's placeholder limit and packet size.
 *
 * Errors: with `onError: 'stop'` the first failing row ends the run and the open transaction
 * is rolled back; with `'skip'` failing rows are logged and the rest continue. A failed
 * multi-row statement is retried row by row to find the rows at fault (inside savepoints
 * where the engine needs them), so errors carry the source row number, its line and, when the
 * server or the conversion names it, the column.
 */

export type TransactionMode = 'single' | 'per-batch' | 'none';

export interface ImportOptions {
  readonly session: Session;
  /** Defaults to the session's engine. */
  readonly dialect?: SqlDialect;
  /** The target table (from `introspect`, `loadTable` or `tableFromColumns`). */
  readonly table: TableDef;
  /** PostgreSQL schema of the table; without one the search_path decides. */
  readonly schema?: string;
  readonly rows: AsyncIterable<RowBatch>;
  readonly mapping: readonly ColumnMapping[];
  /** Default `append`. */
  readonly mode?: ImportMode;
  /** Target key columns for update, upsert and delete; default the primary key. */
  readonly keyColumns?: readonly string[];
  /** Rows per batch: the unit of `per-batch` transactions and of statements (default 1000). */
  readonly batchSize?: number;
  /** Default `single`: everything commits or nothing does. */
  readonly transaction?: TransactionMode;
  /** Default `stop`. */
  readonly onError?: 'stop' | 'skip';
  /** With `skip`: give up after this many errors (default unlimited). */
  readonly maxErrors?: number;
  /** Errors kept in the summary (default 1000); `rowsSkipped` still counts them all. */
  readonly errorLogLimit?: number;
  /**
   * How `replace` empties the table: `truncate` (default; PostgreSQL inside the transaction,
   * MySQL/MariaDB before it, where TRUNCATE commits implicitly) or `delete` (always inside).
   */
  readonly replaceWith?: 'truncate' | 'delete';
  /**
   * Turn off foreign key checks during the load: MySQL `foreign_key_checks = 0`, PostgreSQL
   * `session_replication_role = replica` (which also skips triggers and needs superuser).
   */
  readonly disableForeignKeys?: boolean;
  readonly conversion?: ConversionOptions;
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: TransferProgress) => void;
  /** Least time between progress events (default 250 ms); the last one always comes. */
  readonly progressIntervalMs?: number;
}

export interface ImportSummary extends TransferSummary {
  /** Rows the server reported as inserted, updated or deleted. */
  readonly rowsAffected: number;
}

/** Why the run stopped early; carried out of the write loop. */
class Stop extends Error {
  constructor(readonly reason: 'failed' | 'cancelled') {
    super(reason);
  }
}

/** A converted row waiting to be written. */
interface PendingRow {
  readonly values: CellValue[];
  readonly row: number;
  readonly line: number;
  readonly bytes: number;
}

function invalid(message: string, hint?: string): JoineryError {
  return new JoineryError({ code: 'VALIDATION_FAILED', message, ...(hint ? { hint } : {}) });
}

/** Key columns for a mode: given, else the primary key, else the first unique key. */
function resolveKeys(table: TableDef, given: readonly string[] | undefined): string[] {
  if (given !== undefined && given.length > 0) return [...given];
  if (table.primaryKey !== undefined) return [...table.primaryKey.columns];
  const unique =
    table.uniques[0]?.columns ??
    table.indexes
      .find((index) => index.unique && index.columns.every((c) => c.name !== null))
      ?.columns.map((c) => c.name!);
  return unique === undefined ? [] : [...unique];
}

/** Rough upper bound of a value's bytes on the wire, for the packet budget. */
function valueBytes(value: CellValue): number {
  if (value === null) return 1;
  if (typeof value === 'string') return value.length * 3 + 4;
  if (value instanceof Uint8Array) return value.byteLength + 4;
  return 24;
}

/** The column a server error names: pg's error fields, or the message's `column 'x'`. */
export function columnFromError(error: unknown, columns: readonly string[]): string | undefined {
  const cause = (error as { cause?: unknown } | null)?.cause as
    { column?: unknown; where?: unknown } | undefined;
  if (typeof cause?.column === 'string' && columns.includes(cause.column)) return cause.column;
  if (typeof cause?.where === 'string') {
    const parameter = /parameter \$(\d+)/.exec(cause.where);
    if (parameter) {
      const name = columns[(Number(parameter[1]) - 1) % Math.max(columns.length, 1)];
      if (name !== undefined) return name;
    }
  }
  const message = error instanceof Error ? error.message : String(error);
  const named = /column ['"`]([^'"`]+)['"`]/i.exec(message);
  if (named && columns.includes(named[1]!)) return named[1]!;
  return undefined;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isCancel(error: unknown, signal: AbortSignal | undefined): boolean {
  if (signal?.aborted === true) return true;
  return error instanceof JoineryError && error.code === 'CANCELLED';
}

/**
 * Imports rows into a table. Resolves with a summary for every runtime outcome (completed,
 * failed, cancelled); throws only for invalid options (VALIDATION_FAILED) before touching the
 * database.
 */
export async function importRows(options: ImportOptions): Promise<ImportSummary> {
  const { session, table, signal } = options;
  const dialect = dialectOf(session, options.dialect);
  const mode = options.mode ?? 'append';
  const txMode = options.transaction ?? 'single';
  const onError = options.onError ?? 'stop';
  const maxErrors = options.maxErrors ?? Number.POSITIVE_INFINITY;
  const errorLogLimit = options.errorLogLimit ?? 1000;
  const batchSize = Math.max(1, Math.floor(options.batchSize ?? 1000));
  const pg = dialect === 'postgres';

  // ------------------------------------------------------------------ validation
  const byName = new Map(table.columns.map((c) => [c.name, c]));
  const seenTargets = new Set<string>();
  for (const { source, target } of options.mapping) {
    const column = byName.get(target);
    if (column === undefined) throw invalid(`Column "${target}" is not in table "${table.name}"`);
    if (seenTargets.has(target)) throw invalid(`Column "${target}" is mapped more than once`);
    if (column.generated !== undefined)
      throw invalid(`Column "${target}" is generated and cannot be imported into`);
    if (source === '') throw invalid(`The mapping for "${target}" has no source column`);
    seenTargets.add(target);
  }
  if (options.mapping.length === 0) throw invalid('No columns are mapped');
  const keys =
    mode === 'append' || mode === 'replace' ? [] : resolveKeys(table, options.keyColumns);
  if (keys.length === 0 && mode !== 'append' && mode !== 'replace') {
    throw invalid(
      `Mode "${mode}" needs key columns, and "${table.name}" has no primary or unique key`,
      'Choose the key columns to match rows on',
    );
  }
  for (const key of keys) {
    if (!seenTargets.has(key)) throw invalid(`Key column "${key}" is not mapped`);
  }
  const mappedTargets = options.mapping.map((m) => m.target);
  const nonKeys = mappedTargets.filter((c) => !keys.includes(c));
  if (mode === 'update' && nonKeys.length === 0) {
    throw invalid('Update mode needs at least one mapped column besides the key');
  }
  if (txMode !== 'none' && session.inTransaction) {
    throw invalid(
      'The session already has an open transaction',
      'Commit or roll it back first, or import with transaction "none"',
    );
  }

  const columns =
    mode === 'update' ? [...keys, ...nonKeys] : mode === 'delete' ? [...keys] : mappedTargets;
  const sourceOf = new Map(options.mapping.map((m) => [m.target, m.source]));
  const sources = columns.map((c) => sourceOf.get(c)!);
  /** Built for the first batch: JSON sources convert strings as JSON strings. */
  let converters: Converter[] = [];
  const buildConverters = (json: boolean): Converter[] => {
    const conversion: ConversionOptions = {
      serverVersion: session.serverVersion,
      jsonSource: json,
      ...options.conversion,
    };
    return columns.map((c) => converterFor(byName.get(c) as ColumnDef, dialect, conversion));
  };
  const plan: StatementPlan = {
    dialect,
    table,
    ...(options.schema !== undefined ? { schema: options.schema } : {}),
    mode,
    columns,
    keys,
    rowAlias: supportsRowAlias(dialect, session.serverVersion),
  };

  // ------------------------------------------------------------------ state
  const started = performance.now();
  const errors: RowError[] = [];
  let errorCount = 0;
  let rowsRead = 0;
  let rowsSkipped = 0;
  let committed = 0;
  let pendingInTx = 0;
  let rowsAffected = 0;
  let bytesRead = 0;
  let lastProgress = 0;
  const interval = options.progressIntervalMs ?? 250;
  let inTx = false;
  const restore: string[] = [];
  const textCache = new Map<number, string>();

  const emit = (force: boolean): void => {
    if (options.onProgress === undefined) return;
    const now = performance.now();
    if (!force && now - lastProgress < interval) return;
    lastProgress = now;
    const elapsedMs = now - started;
    const written = committed + pendingInTx;
    options.onProgress({
      rowsRead,
      rowsWritten: written,
      rowsSkipped,
      bytes: bytesRead,
      elapsedMs: Math.round(elapsedMs),
      rowsPerSecond: elapsedMs > 0 ? Math.round((written * 1000) / elapsedMs) : 0,
    });
  };

  /** Runs a data statement; cancellation reaches the server through the signal. */
  const run = async (sql: string, params: readonly CellValue[] = []): Promise<number> => {
    let affected = 0;
    for await (const chunk of session.execute(sql, {
      executionId: newId(),
      ...(params.length > 0 ? { params } : {}),
      ...(signal !== undefined ? { signal } : {}),
    })) {
      if (chunk.type === 'status' && chunk.rowsAffected !== null) affected += chunk.rowsAffected;
    }
    return affected;
  };
  /** Runs transaction control and setup, which must work after a cancellation too. */
  const control = async (sql: string): Promise<void> => {
    for await (const _chunk of session.execute(sql, { executionId: newId() })) {
      // drained
    }
  };
  const scalar = async (sql: string): Promise<CellValue> => {
    for await (const chunk of session.execute(sql, { executionId: newId() })) {
      if (chunk.type === 'rows' && chunk.rowCount > 0) return rowAt(chunk, 0)[0] ?? null;
    }
    return null;
  };

  const record = (error: RowError): void => {
    errorCount++;
    if (errors.length < errorLogLimit) errors.push(error);
    if (onError === 'stop' || errorCount > maxErrors) throw new Stop('failed');
    rowsSkipped++;
  };

  const checkSignal = (): void => {
    if (signal?.aborted === true) throw new Stop('cancelled');
  };

  const begin = async (): Promise<void> => {
    await control(pg ? 'BEGIN' : 'START TRANSACTION');
    inTx = true;
  };
  const commit = async (): Promise<void> => {
    await control('COMMIT');
    inTx = false;
    committed += pendingInTx;
    pendingInTx = 0;
  };
  /** Rolls back our own transaction only: with `none`, a caller's transaction is theirs. */
  const rollback = async (): Promise<void> => {
    if (!inTx) return;
    inTx = false;
    pendingInTx = 0;
    await control('ROLLBACK').catch(() => undefined);
  };
  const wrote = (rows: number): void => {
    if (inTx) pendingInTx += rows;
    else committed += rows;
  };
  /** A failed statement inside our transaction must not have ended it (deadlock, fatal error). */
  const assertTxAlive = (cause: unknown): void => {
    if (inTx && !session.inTransaction) {
      inTx = false;
      pendingInTx = 0;
      throw cause;
    }
  };

  const textFor = (rows: number): string => {
    let text = textCache.get(rows);
    if (text === undefined) {
      text = buildStatement(plan, rows);
      if (textCache.size > 8) textCache.clear();
      textCache.set(rows, text);
    }
    return text;
  };

  const execRows = async (rows: readonly PendingRow[]): Promise<void> => {
    const params: CellValue[] = new Array<CellValue>(rows.length * columns.length);
    let p = 0;
    for (const row of rows) for (const value of row.values) params[p++] = value;
    rowsAffected += await run(textFor(rows.length), params);
  };

  const savepoints = (): boolean => pg && inTx;

  /** Writes one statement's rows; on failure finds the failing rows one by one. */
  const writeChunk = async (rows: readonly PendingRow[]): Promise<void> => {
    checkSignal();
    const guarded = savepoints();
    if (guarded) await control('SAVEPOINT joinery_import');
    try {
      await execRows(rows);
      if (guarded) await control('RELEASE SAVEPOINT joinery_import');
      wrote(rows.length);
      return;
    } catch (error) {
      if (isCancel(error, signal)) throw new Stop('cancelled');
      if (guarded) await control('ROLLBACK TO SAVEPOINT joinery_import');
      assertTxAlive(error);
      if (rows.length === 1) {
        if (guarded) await control('RELEASE SAVEPOINT joinery_import');
        const row = rows[0]!;
        const column = columnFromError(error, columns);
        record({
          row: row.row,
          line: row.line,
          ...(column !== undefined ? { column } : {}),
          message: messageOf(error),
        });
        return;
      }
    }
    // Retry row by row, each in its own savepoint where a failure would abort the transaction.
    for (const row of rows) {
      checkSignal();
      const rowGuard = savepoints();
      if (rowGuard) await control('SAVEPOINT joinery_row');
      try {
        await execRows([row]);
        if (rowGuard) await control('RELEASE SAVEPOINT joinery_row');
        wrote(1);
      } catch (error) {
        if (isCancel(error, signal)) throw new Stop('cancelled');
        if (rowGuard) {
          await control('ROLLBACK TO SAVEPOINT joinery_row');
          await control('RELEASE SAVEPOINT joinery_row');
        }
        assertTxAlive(error);
        const column = columnFromError(error, columns);
        record({
          row: row.row,
          line: row.line,
          ...(column !== undefined ? { column } : {}),
          message: messageOf(error),
        });
      }
    }
    if (guarded) await control('RELEASE SAVEPOINT joinery_import');
  };

  let packetBudget = 64 * 1024 * 1024;
  const perStatement = Math.max(1, Math.floor(MAX_PARAMETERS / Math.max(columns.length, 1)));

  const flush = async (rows: PendingRow[]): Promise<void> => {
    if (rows.length === 0) return;
    if (txMode === 'per-batch') await begin();
    let start = 0;
    while (start < rows.length) {
      let end = start;
      let bytes = 0;
      while (end < rows.length && end - start < perStatement) {
        const next = rows[end]!.bytes;
        if (end > start && bytes + next > packetBudget) break;
        bytes += next;
        end++;
      }
      await writeChunk(rows.slice(start, end));
      start = end;
      emit(false);
    }
    if (txMode === 'per-batch') await commit();
  };

  // ------------------------------------------------------------------ run
  let status: 'completed' | 'failed' | 'cancelled' = 'completed';
  const iterator = options.rows[Symbol.asyncIterator]();
  let prefetched: Promise<IteratorResult<RowBatch>> | undefined;
  const prefetch = (): Promise<IteratorResult<RowBatch>> => {
    const next = iterator.next();
    // Failures surface where the result is awaited; this only marks them handled meanwhile.
    next.catch(() => undefined);
    return next;
  };
  try {
    checkSignal();
    if (!pg) {
      const packet = await scalar('SELECT @@max_allowed_packet');
      const bytes = typeof packet === 'number' ? packet : Number(packet ?? 0);
      if (bytes > 0) packetBudget = Math.min(packetBudget, Math.floor(bytes / 2));
    }
    if (options.disableForeignKeys === true) {
      if (pg) {
        const previous = await scalar('SHOW session_replication_role');
        const role = previous === 'replica' || previous === 'local' ? previous : 'origin';
        await control("SET session_replication_role = 'replica'");
        restore.push(`SET session_replication_role = '${role}'`);
      } else {
        const previous = await scalar('SELECT @@foreign_key_checks');
        await control('SET foreign_key_checks = 0');
        restore.push(`SET foreign_key_checks = ${Number(previous ?? 1) === 0 ? 0 : 1}`);
      }
    }
    const replaceWith = options.replaceWith ?? 'truncate';
    if (mode === 'replace' && !pg && replaceWith === 'truncate') {
      await run(emptyTableStatement(table, dialect, options.schema, 'truncate'));
    }
    if (txMode === 'single') await begin();
    if (mode === 'replace' && (pg || replaceWith === 'delete')) {
      if (txMode === 'per-batch') await begin();
      await run(emptyTableStatement(table, dialect, options.schema, replaceWith));
      if (txMode === 'per-batch') await commit();
    }

    let pending: PendingRow[] = [];
    let sourceIndex: number[] = [];
    let indexedFor: readonly string[] | undefined;
    for (;;) {
      checkSignal();
      let next: IteratorResult<RowBatch>;
      try {
        next = await (prefetched ?? iterator.next());
        prefetched = undefined;
      } catch (error) {
        if (isCancel(error, signal)) throw new Stop('cancelled');
        errorCount++;
        errors.push({ message: messageOf(error) });
        throw new Stop('failed');
      }
      if (next.done === true) break;
      const batch = next.value;
      bytesRead = batch.bytesRead;
      if (converters.length === 0) converters = buildConverters(batch.json === true);
      for (const rejected of batch.rejected) {
        rowsRead++;
        record(rejected);
      }
      if (indexedFor !== batch.columns) {
        indexedFor = batch.columns;
        sourceIndex = sources.map((s) => batch.columns.indexOf(s));
      }
      for (let r = 0; r < batch.rows.length; r++) {
        const row = batch.rows[r]!;
        rowsRead++;
        const values = new Array<CellValue>(columns.length);
        let bytes = 0;
        let bad: RowError | undefined;
        for (let c = 0; c < columns.length; c++) {
          const at = sourceIndex[c]!;
          try {
            const value = converters[c]!(at < 0 ? null : row[at]);
            values[c] = value;
            bytes += valueBytes(value);
          } catch (error) {
            if (!(error instanceof ConversionError)) throw error;
            bad = {
              row: batch.rowNumbers[r]!,
              line: batch.lines[r]!,
              column: columns[c]!,
              message: `${columns[c]!}: ${error.message}`,
            };
            break;
          }
        }
        if (bad !== undefined) {
          record(bad);
          continue;
        }
        pending.push({ values, row: batch.rowNumbers[r]!, line: batch.lines[r]!, bytes });
        if (pending.length >= batchSize) {
          const rows = pending;
          pending = [];
          // Read and parse the next source chunk while the server writes this batch.
          prefetched ??= prefetch();
          await flush(rows);
        }
      }
      emit(false);
    }
    await flush(pending);
    if (txMode === 'single') await commit();
  } catch (error) {
    if (error instanceof Stop) {
      status = error.reason;
    } else if (isCancel(error, signal)) {
      status = 'cancelled';
    } else {
      status = 'failed';
      errorCount++;
      if (errors.length < errorLogLimit) errors.push({ message: messageOf(error) });
    }
    await rollback();
  } finally {
    await iterator.return?.().catch(() => undefined);
    for (const statement of restore) await control(statement).catch(() => undefined);
  }
  emit(true);
  return {
    status,
    rowsRead,
    rowsWritten: committed,
    rowsSkipped,
    rowsAffected,
    errors,
    durationMs: Math.round(performance.now() - started),
  };
}
