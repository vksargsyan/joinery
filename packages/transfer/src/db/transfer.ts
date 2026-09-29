import { ENGINES, JoineryError, isSqlEngine, type Session } from '@joinery/core';

import { mongoToSqlExecution, sqlToMongoExecution } from './mongo-transfer';
import { assertRunnable, runExecution, type Execution, type LogLevel } from './pipeline';
import { redisExecution } from './redis-transfer';
import {
  resolveOptions,
  type DbTransferProgress,
  type DbTransferSpec,
  type DbTransferSummary,
  type SessionOpener,
  type TransferPlan,
} from './spec';
import { sqlToSqlExecution } from './sql-transfer';

/**
 * Data transfer between databases (spec §12): `planDbTransfer` shows what a transfer will do
 * (the wizard's mapping and review steps, `joinery transfer --dry-run`), `runDbTransfer` does
 * it. Supported pairs: MySQL, MariaDB and PostgreSQL to any of the three; SQL engines to
 * MongoDB and back; Redis to Redis. Each pair builds an Execution for the one pipeline, so a
 * new target engine plugs in here.
 */

/** Whether a pair of engines can transfer, and why not. */
export function transferSupport(
  source: string,
  target: string,
): { readonly supported: boolean; readonly reason?: string } {
  const sql = (engine: string): boolean =>
    engine === 'postgres' || engine === 'mysql' || engine === 'mariadb';
  if (sql(source) && (sql(target) || target === 'mongodb')) return { supported: true };
  if (source === 'mongodb' && sql(target)) return { supported: true };
  if (source === 'redis' && target === 'redis') return { supported: true };
  const name = (engine: string): string =>
    engine in ENGINES ? ENGINES[engine as keyof typeof ENGINES].displayName : engine;
  return {
    supported: false,
    reason: `Data transfer from ${name(source)} to ${name(target)} is not supported`,
  };
}

async function executionFor(
  spec: DbTransferSpec,
  source: Session,
  target: Session,
  sameConnection: boolean,
): Promise<Execution> {
  const options = resolveOptions(spec.options);
  const support = transferSupport(source.engine, target.engine);
  if (!support.supported)
    throw new JoineryError({ code: 'NOT_SUPPORTED', message: support.reason! });
  let execution: Execution;
  if (isSqlEngine(source.engine) && isSqlEngine(target.engine)) {
    execution = await sqlToSqlExecution(spec, options, source, target);
  } else if (isSqlEngine(source.engine)) {
    execution = await sqlToMongoExecution(spec, options, source, target);
  } else if (source.engine === 'mongodb') {
    execution = await mongoToSqlExecution(spec, options, source, target);
  } else {
    execution = await redisExecution(spec, options, source, target, sameConnection);
  }
  return sameConnection && source.engine !== 'redis'
    ? withoutSelfCopies(execution, spec, source)
    : execution;
}

/** On one connection, a table cannot be transferred into itself. */
function withoutSelfCopies(execution: Execution, spec: DbTransferSpec, source: Session): Execution {
  const pg = source.engine === 'postgres';
  const sameSchema = !pg || (spec.source.schema || 'public') === (spec.target.schema || 'public');
  if (!sameSchema) return execution;
  const fold = (name: string): string => (pg ? name : name.toLowerCase());
  const self = new Set(
    execution.plan.tables
      .filter((t) => t.kind === 'table' && fold(t.source) === fold(t.target))
      .map((t) => t.source),
  );
  if (self.size === 0) return execution;
  const problem = (name: string): string =>
    `${name} would be written into itself: pick another target name, schema or connection`;
  return {
    ...execution,
    plan: {
      ...execution.plan,
      tables: execution.plan.tables.map((t) =>
        self.has(t.source) && t.kind === 'table'
          ? { ...t, problems: [...t.problems, problem(t.source)] }
          : t,
      ),
      problems: [...execution.plan.problems, ...[...self].map(problem)],
    },
    units: execution.units.filter((u) => !self.has(u.source)),
  };
}

export interface PlanDbTransferOptions {
  readonly spec: DbTransferSpec;
  readonly source: Session;
  readonly target: Session;
  /** The source and the target are the same connection and database. */
  readonly sameConnection?: boolean;
}

/**
 * What a transfer will do: every target table with its columns and types (the mapping table's
 * and the user's), the statements before and after the data, what is dropped, emptied or
 * created, and the problems that stop it. Reads both servers; writes nothing.
 */
export async function planDbTransfer(options: PlanDbTransferOptions): Promise<TransferPlan> {
  return (
    await executionFor(
      options.spec,
      options.source,
      options.target,
      options.sameConnection === true,
    )
  ).plan;
}

export interface RunDbTransferOptions {
  readonly spec: DbTransferSpec;
  /** Opens a session on the source (once for planning, then once per parallel table). */
  readonly source: SessionOpener;
  readonly target: SessionOpener;
  readonly sameConnection?: boolean;
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: DbTransferProgress) => void;
  readonly onLog?: (level: LogLevel, message: string) => void;
  /**
   * Sees the fresh plan before anything is written; throwing stops the transfer (the job
   * runner checks the write rules against what will really be dropped or emptied here).
   */
  readonly onPlan?: (plan: TransferPlan) => void | Promise<void>;
  readonly progressIntervalMs?: number;
  readonly errorLogLimit?: number;
}

/**
 * Plans the transfer again on fresh sessions and runs it. Throws before writing anything
 * when the plan has problems (VALIDATION_FAILED) or `onPlan` refuses; otherwise resolves with
 * a summary for every outcome (completed, failed, cancelled).
 */
export async function runDbTransfer(options: RunDbTransferOptions): Promise<DbTransferSummary> {
  const source = await options.source();
  let target;
  try {
    target = await options.target();
  } catch (error) {
    await source.close().catch(() => undefined);
    throw error;
  }
  try {
    options.onProgress?.({
      phase: 'Planning',
      tables: 0,
      tablesDone: 0,
      current: [],
      rowsRead: 0,
      rowsWritten: 0,
      rowsSkipped: 0,
      elapsedMs: 0,
      rowsPerSecond: 0,
    });
    const execution = await executionFor(
      options.spec,
      source.session,
      target.session,
      options.sameConnection === true,
    );
    assertRunnable(execution.plan);
    await options.onPlan?.(execution.plan);
    for (const warning of execution.plan.warnings) options.onLog?.('warning', warning);
    return await runExecution({
      execution,
      control: { source, target },
      openSource: options.source,
      openTarget: options.target,
      options: resolveOptions(options.spec.options),
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
      ...(options.onProgress !== undefined ? { onProgress: options.onProgress } : {}),
      ...(options.onLog !== undefined ? { onLog: options.onLog } : {}),
      ...(options.progressIntervalMs !== undefined
        ? { progressIntervalMs: options.progressIntervalMs }
        : {}),
      ...(options.errorLogLimit !== undefined ? { errorLogLimit: options.errorLogLimit } : {}),
    });
  } finally {
    await target.close().catch(() => undefined);
    await source.close().catch(() => undefined);
  }
}
