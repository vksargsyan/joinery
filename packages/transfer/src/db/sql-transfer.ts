import {
  isSqlEngine,
  newId,
  rowAt,
  type CellValue,
  type Session,
  type SqlDialect,
} from '@querybara/core';
import { quoteIdent, quoteString } from '@querybara/sql-tools';

import { importRows } from '../import';
import { runStatement } from '../session';
import { qualifiedTable } from '../statements';
import type { RowBatch, RowError, SourceCell } from '../types';
import type {
  Execution,
  ExecutionContext,
  TransferUnit,
  UnitContext,
  UnitResult,
} from './pipeline';
import { planSqlTransfer, qualifiedName, type SqlPlan, type SqlTableLoad } from './sql-plan';
import type { DbTransferError, DbTransferOptions, DbTransferSpec, TransferPlan } from './spec';
import type { CellAdapter } from './values';

/**
 * SQL → SQL transfers (spec §12): the planner's tables loaded through the import pipeline
 * (`importRows`: multi-row parameterised INSERTs, a transaction per batch, failing rows
 * retried one by one and logged), each table read by a streaming SELECT whose pages are
 * fetched only as the target takes them. Every session runs in UTC, so timestamps with a
 * time zone move as instants.
 */

/** Runs one statement and returns the first column of its first row. */
async function scalar(session: Session, sql: string): Promise<CellValue> {
  for await (const chunk of session.execute(sql, { executionId: newId() })) {
    if (chunk.type === 'rows' && chunk.rowCount > 0) return rowAt(chunk, 0)[0] ?? null;
  }
  return null;
}

/** Puts a SQL session in UTC for the transfer. */
export async function utcSession(session: Session): Promise<void> {
  if (!isSqlEngine(session.engine)) return;
  await runStatement(
    session,
    session.engine === 'postgres' ? "SET TIME ZONE 'UTC'" : "SET time_zone = '+00:00'",
  );
}

/**
 * Switches foreign key checks (and on PostgreSQL triggers) off on a target session, and
 * returns how to switch them back. PostgreSQL needs a superuser for it: without one, the
 * checks stay on and a warning says so.
 */
export async function relaxConstraints(
  session: Session,
  context: Pick<ExecutionContext, 'log'>,
): Promise<() => Promise<void>> {
  if (session.engine === 'postgres') {
    const previous = await scalar(session, 'SHOW session_replication_role');
    try {
      await runStatement(session, "SET session_replication_role = 'replica'");
    } catch (error) {
      context.log(
        'warning',
        `Foreign key checks and triggers stay on: ${error instanceof Error ? error.message : String(error)}`,
      );
      return async () => undefined;
    }
    const role = previous === 'local' || previous === 'replica' ? previous : 'origin';
    return async () => {
      await runStatement(session, `SET session_replication_role = '${role}'`);
    };
  }
  const previous = await scalar(session, 'SELECT @@foreign_key_checks');
  await runStatement(session, 'SET foreign_key_checks = 0');
  return async () => {
    await runStatement(session, `SET foreign_key_checks = ${Number(previous ?? 1) === 0 ? 0 : 1}`);
  };
}

/** Streams a SELECT as row batches, each cell adapted for the target column. */
export async function* readSqlRows(
  session: Session,
  text: string,
  columns: readonly string[],
  adapters: readonly CellAdapter[],
  pageSize: number,
  signal: AbortSignal,
): AsyncGenerator<RowBatch> {
  let row = 0;
  const width = adapters.length;
  for await (const chunk of session.execute(text, { executionId: newId(), pageSize, signal })) {
    if (chunk.type !== 'rows' || chunk.resultIndex !== 0) continue;
    const rows: SourceCell[][] = [];
    const numbers: number[] = [];
    const rejected: RowError[] = [];
    for (let r = 0; r < chunk.rowCount; r++) {
      row++;
      const cells = new Array<SourceCell>(width);
      try {
        for (let c = 0; c < width; c++) cells[c] = adapters[c]!(chunk.data[c]![r] ?? null);
      } catch (error) {
        rejected.push({ row, message: error instanceof Error ? error.message : String(error) });
        continue;
      }
      rows.push(cells);
      numbers.push(row);
    }
    yield { columns, rows, rowNumbers: numbers, lines: numbers, rejected, bytesRead: 0 };
  }
}

/** Statements that move a column's sequence or AUTO_INCREMENT counter past the data. */
async function resetCounter(
  session: Session,
  dialect: SqlDialect,
  table: string,
  column: string,
  schema: string | undefined,
): Promise<void> {
  const name = qualifiedTable(table, dialect, schema);
  const ident = quoteIdent(column, dialect);
  if (dialect === 'postgres') {
    await runStatement(session, counterStatement(dialect, table, column, schema));
    return;
  }
  const next = await scalar(session, `SELECT COALESCE(MAX(${ident}), 0) + 1 FROM ${name}`);
  const text =
    typeof next === 'string' || typeof next === 'number' || typeof next === 'bigint'
      ? String(next)
      : '';
  if (!/^\d+$/.test(text)) return;
  await runStatement(session, `ALTER TABLE ${name} AUTO_INCREMENT = ${text}`);
}

/** What the review shows for a counter reset. */
function counterStatement(
  dialect: SqlDialect,
  table: string,
  column: string,
  schema: string | undefined,
): string {
  const name = qualifiedTable(table, dialect, schema);
  const ident = quoteIdent(column, dialect);
  if (dialect === 'postgres') {
    return `SELECT setval(pg_get_serial_sequence(${quoteString(qualifiedName(table, dialect, schema), dialect)}, ${quoteString(column, dialect)}), COALESCE(MAX(${ident}), 0) + 1, false) FROM ${name}`;
  }
  return `ALTER TABLE ${name} AUTO_INCREMENT = (MAX(${ident}) + 1)`;
}

/** Source row estimates: PostgreSQL's statistics, MySQL's information_schema. */
export async function rowEstimates(
  session: Session,
  schema: string | undefined,
): Promise<Map<string, number>> {
  const estimates = new Map<string, number>();
  const sql =
    session.engine === 'postgres'
      ? `SELECT c.relname, c.reltuples::bigint FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = ${quoteString(schema ?? 'public', 'postgres')} AND c.relkind IN ('r', 'p')`
      : 'SELECT TABLE_NAME, TABLE_ROWS FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()';
  try {
    for await (const chunk of session.execute(sql, { executionId: newId() })) {
      if (chunk.type !== 'rows') continue;
      for (let r = 0; r < chunk.rowCount; r++) {
        const [name, rows] = rowAt(chunk, r);
        const count = Number(rows ?? -1);
        if (typeof name === 'string' && count >= 0) estimates.set(name, count);
      }
    }
  } catch {
    // Estimates only feed the progress bar.
  }
  return estimates;
}

/** The public plan of a SQL plan. */
function describe(
  plan: SqlPlan,
  source: Session,
  target: Session,
  targetSchema: string | undefined,
): TransferPlan {
  const to = target.engine as SqlDialect;
  const after: string[] = [];
  const destructive: string[] = [];
  const creates: string[] = [];
  for (const table of plan.tables) {
    if (table.planned.problems.length > 0) continue;
    after.push(...table.finish);
    for (const column of table.counters)
      after.push(counterStatement(to, table.planned.target, column, targetSchema));
    const { action, exists, target: name } = table.planned;
    if (exists && action === 'drop-create') {
      destructive.push(`Drop table ${name} (it exists) and create it again`);
    } else if (exists && action === 'truncate') {
      destructive.push(`Empty table ${name}: every row in it now is deleted`);
    }
    if (!exists || action === 'drop-create') creates.push(`Create table ${name}`);
  }
  after.push(...plan.foreignKeys.map((fk) => fk.sql));
  return {
    sourceEngine: source.engine,
    targetEngine: target.engine,
    sourceVersion: source.serverVersion,
    targetVersion: target.serverVersion,
    tables: plan.tables.map((t) => t.planned),
    before: plan.before,
    after,
    destructive,
    creates,
    problems: plan.problems,
    warnings: plan.warnings,
  };
}

/** One table's load. */
function unitFor(
  table: SqlTableLoad,
  to: SqlDialect,
  targetSchema: string | undefined,
): TransferUnit {
  return {
    source: table.planned.source,
    target: table.planned.target,
    async load(context: UnitContext): Promise<UnitResult> {
      const { options, signal } = context;
      const summary = await importRows({
        session: context.target,
        dialect: to,
        table: table.target,
        ...(targetSchema !== undefined ? { schema: targetSchema } : {}),
        rows: readSqlRows(
          context.source,
          table.select,
          table.selectColumns,
          table.adapters,
          options.batchSize,
          signal,
        ),
        mapping: table.mapping,
        mode: 'append',
        batchSize: options.batchSize,
        transaction: options.transactionPerBatch ? 'per-batch' : 'none',
        onError: options.onError,
        conversion: { emptyAsNull: false, dateOrder: 'ymd' },
        signal,
        onProgress: (progress) =>
          context.progress({
            read: progress.rowsRead,
            written: progress.rowsWritten,
            skipped: progress.rowsSkipped,
          }),
      });
      return {
        status: summary.status,
        read: summary.rowsRead,
        written: summary.rowsWritten,
        skipped: summary.rowsSkipped,
        errors: summary.errors,
      };
    },
    async finish(context: UnitContext): Promise<void> {
      for (const statement of table.finish) await runStatement(context.target, statement);
      for (const column of table.counters) {
        await resetCounter(context.target, to, table.planned.target, column, targetSchema);
      }
    },
  };
}

/** Plans a SQL → SQL transfer on the two sessions and returns it ready to run. */
export async function sqlToSqlExecution(
  spec: DbTransferSpec,
  options: DbTransferOptions,
  source: Session,
  target: Session,
): Promise<Execution> {
  const from = source.engine as SqlDialect;
  const to = target.engine as SqlDialect;
  const sourceSchema = from === 'postgres' ? spec.source.schema || 'public' : undefined;
  const targetSchema = to === 'postgres' ? spec.target.schema || 'public' : undefined;
  const include =
    to === 'postgres' || from === 'postgres' ? (['table', 'type'] as const) : (['table'] as const);
  const [sourceSnapshot, targetSnapshot, rows] = await Promise.all([
    source.introspect({ ...(sourceSchema ? { schemas: [sourceSchema] } : {}), include }),
    target.introspect({ ...(targetSchema ? { schemas: [targetSchema] } : {}), include }),
    rowEstimates(source, sourceSchema),
  ]);
  const plan = planSqlTransfer({
    from,
    to,
    targetVersion: target.serverVersion,
    sourceSchema,
    targetSchema,
    source: sourceSnapshot,
    target: targetSnapshot,
    objects: spec.objects,
    options,
    rows,
  });
  const loads = plan.tables.filter((t) => t.planned.problems.length === 0);
  return {
    plan: describe(plan, source, target, targetSchema),
    setupSource: utcSession,
    async setupTarget(session, context) {
      await utcSession(session);
      return context.options.disableConstraints ? relaxConstraints(session, context) : undefined;
    },
    async prepare(session) {
      if (plan.before.length === 0) return;
      // Dropping or emptying a table other tables reference needs MySQL's checks off.
      const restore =
        to === 'postgres' ? undefined : await relaxConstraints(session, { log: () => undefined });
      try {
        for (const statement of plan.before) await runStatement(session, statement);
      } finally {
        await restore?.();
      }
    },
    units: loads.map((table) => unitFor(table, to, targetSchema)),
    async complete(session, completed): Promise<DbTransferError[]> {
      const errors: DbTransferError[] = [];
      for (const fk of plan.foreignKeys) {
        if (!completed.has(fk.table) || !completed.has(fk.refTable)) continue;
        try {
          await runStatement(session, fk.sql);
        } catch (error) {
          errors.push({
            table: fk.table,
            message: `A foreign key could not be added: ${error instanceof Error ? error.message : String(error)}`,
          });
        }
      }
      return errors;
    },
  };
}
