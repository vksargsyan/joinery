import {
  QuerybaraError,
  isSqlEngine,
  newId,
  requiresWriteConfirmation,
  rowAt,
  type ResolvedProfile,
  type Session,
} from '@querybara/core';
import type {
  JobProgress,
  JobRowError,
  TransferInspection,
  TransferJob,
  TransferPlanInfo,
} from '@querybara/ipc';
import { transferPlanSchema } from '@querybara/ipc';
import { quoteString } from '@querybara/sql-tools';
import {
  planDbTransfer,
  runDbTransfer,
  transferSupport,
  type DbTransferProgress,
  type DbTransferSpec,
  type SessionOpener,
  type TransferPlan,
} from '@querybara/transfer';

import type { JobOutcome } from './tasks';

/**
 * Data transfer between databases in the job runner (spec §12, ADR 0006): the wizard's
 * inspection of a connection and plan of a transfer, and the `transfer` job itself, all on
 * @querybara/transfer's pipeline. The write rules are enforced here, in the process that writes:
 * a read-only target refuses, and a transfer that drops, empties or overwrites anything, or
 * writes to a production or confirm-every-write profile, runs only when confirmed.
 */

/** Opens a session for a profile (through its tunnel), as the runner's `connect` does. */
export type Connector = (
  resolved: ResolvedProfile,
) => Promise<{ readonly session: Session; close(): Promise<void> }>;

/** The profile with another default database: the session connects to (or uses) it. */
export function withDatabase(
  resolved: ResolvedProfile,
  database: string | undefined,
): ResolvedProfile {
  if (database === undefined || database === '') return resolved;
  const { profile } = resolved;
  return {
    ...resolved,
    profile: { ...profile, options: { ...profile.options, defaultDatabase: database } },
  };
}

/** The engine's spec from the job. */
export function transferSpecOf(job: TransferJob): DbTransferSpec {
  return {
    source: {
      ...(job.database !== undefined ? { database: job.database } : {}),
      ...(job.schema !== undefined ? { schema: job.schema } : {}),
    },
    target: {
      ...(job.target.database !== undefined ? { database: job.target.database } : {}),
      ...(job.target.schema !== undefined ? { schema: job.target.schema } : {}),
    },
    objects: job.objects,
    ...(job.keyPatterns !== undefined ? { keyPatterns: job.keyPatterns } : {}),
    ...(job.options !== undefined ? { options: job.options } : {}),
  };
}

/** The source and the target are one connection and database. */
export function sameConnection(job: TransferJob): boolean {
  return (
    job.profileId === job.target.profileId && (job.database ?? '') === (job.target.database ?? '')
  );
}

function refuse(
  code: 'READ_ONLY' | 'CONFIRMATION_REQUIRED' | 'NOT_SUPPORTED',
  message: string,
): QuerybaraError {
  return new QuerybaraError({ code, message });
}

/** Checks the engines can transfer, before anything connects. */
export function checkEngines(source: ResolvedProfile, target: ResolvedProfile): void {
  const support = transferSupport(source.profile.engine, target.profile.engine);
  if (!support.supported) throw refuse('NOT_SUPPORTED', support.reason!);
}

/**
 * The write rules against the plan as it will really run (spec §4): what it drops, empties or
 * overwrites needs confirmation on every profile; any write does on production and
 * confirm-every-write profiles.
 */
export function checkPlanRules(
  plan: TransferPlan,
  job: TransferJob,
  target: ResolvedProfile,
): void {
  const profile = target.profile;
  if (profile.presentation.readOnly) {
    throw refuse(
      'READ_ONLY',
      `"${profile.name}" is read-only, so nothing can be transferred into it`,
    );
  }
  if (job.confirmed === true) return;
  if (plan.destructive.length > 0) {
    throw refuse(
      'CONFIRMATION_REQUIRED',
      `The transfer needs confirmation: ${plan.destructive.join('; ')}`,
    );
  }
  if (requiresWriteConfirmation(profile)) {
    const where =
      profile.presentation.environment === 'production'
        ? 'a production connection'
        : `"${profile.name}"`;
    throw refuse('CONFIRMATION_REQUIRED', `Transferring into ${where} needs confirmation`);
  }
}

async function scalarList(session: Session, sql: string): Promise<string[]> {
  const out: string[] = [];
  for await (const chunk of session.execute(sql, { executionId: newId() })) {
    if (chunk.type !== 'rows') continue;
    for (let r = 0; r < chunk.rowCount; r++) {
      const value = rowAt(chunk, r)[0];
      if (typeof value === 'string') out.push(value);
    }
  }
  return out;
}

async function rowCounts(
  session: Session,
  schema: string | undefined,
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  const sql =
    session.engine === 'postgres'
      ? `SELECT c.relname, GREATEST(c.reltuples, 0)::bigint FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = ${quoteString(schema ?? 'public', 'postgres')} AND c.relkind IN ('r', 'p')`
      : 'SELECT TABLE_NAME, TABLE_ROWS FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()';
  try {
    for await (const chunk of session.execute(sql, { executionId: newId() })) {
      if (chunk.type !== 'rows') continue;
      for (let r = 0; r < chunk.rowCount; r++) {
        const [name, rows] = rowAt(chunk, r);
        if (typeof name === 'string' && rows !== null) counts.set(name, Number(rows));
      }
    }
  } catch {
    // Estimates are a nicety.
  }
  return counts;
}

/** A connection's databases, schemas and objects, for the wizard's source and target steps. */
export async function inspectSession(
  session: Session,
  input: { readonly database?: string | undefined; readonly schema?: string | undefined },
): Promise<TransferInspection> {
  const base = { engine: session.engine, serverVersion: session.serverVersion };
  if (isSqlEngine(session.engine)) {
    const pg = session.engine === 'postgres';
    const [databases, schemas] = await Promise.all([
      session
        .browse([])
        .then((nodes) => nodes.filter((n) => n.kind === 'database').map((n) => n.name)),
      pg
        ? scalarList(
            session,
            "SELECT nspname FROM pg_catalog.pg_namespace WHERE nspname NOT LIKE 'pg\\_%' AND nspname <> 'information_schema' ORDER BY 1",
          )
        : Promise.resolve([]),
    ]);
    const schema = pg ? input.schema || 'public' : undefined;
    const [snapshot, counts] = await Promise.all([
      session.introspect({
        ...(schema !== undefined ? { schemas: [schema] } : {}),
        include: ['table'],
      }),
      rowCounts(session, schema),
    ]);
    const tables =
      (schema === undefined ? snapshot.schemas[0] : snapshot.schemas.find((s) => s.name === schema))
        ?.tables ?? [];
    return {
      ...base,
      databases,
      database: snapshot.database,
      schemas,
      objects: tables.map((table) => ({
        name: table.name,
        kind: 'table' as const,
        ...(counts.has(table.name) ? { rows: Math.max(0, counts.get(table.name)!) } : {}),
        foreignKeys: table.foreignKeys.map((fk) => ({
          name: fk.name,
          columns: [...fk.columns],
          refTable: fk.refTable,
        })),
      })),
    };
  }
  if (session.engine === 'mongodb') {
    const databases = (await session.browse([]))
      .filter((n) => n.kind === 'database')
      .map((n) => n.name);
    const database =
      input.database || (session as Session & { currentDatabase?: string }).currentDatabase;
    const collections =
      database === undefined || database === ''
        ? []
        : await session.browse([database, 'collections']).catch(() => []);
    return {
      ...base,
      databases,
      ...(database ? { database } : {}),
      schemas: [],
      objects: collections
        .filter((n) => n.kind === 'collection')
        .map((n) => {
          const count = n.detail?.['count'];
          return {
            name: n.name,
            kind: 'collection' as const,
            ...(typeof count === 'number' ? { rows: count } : {}),
          };
        }),
    };
  }
  if (session.engine === 'redis') {
    const redis = session as Session & {
      readonly database: number;
      readonly server: { readonly databases: number; readonly clusterMode: boolean };
      dbSize(): Promise<number>;
    };
    const count = redis.server.clusterMode ? 1 : Math.max(1, redis.server.databases);
    return {
      ...base,
      databases: Array.from({ length: count }, (_, i) => String(i)),
      database: String(redis.database),
      schemas: [],
      objects: [],
      keys: await redis.dbSize().catch(() => 0),
      cluster: redis.server.clusterMode,
    };
  }
  throw refuse('NOT_SUPPORTED', `${session.engine} connections cannot be transferred yet`);
}

/** Inspects a connection on a session of its own. */
export async function inspectConnection(
  connect: Connector,
  resolved: ResolvedProfile,
  input: { readonly database?: string | undefined; readonly schema?: string | undefined },
): Promise<TransferInspection> {
  const opened = await connect(withDatabase(resolved, input.database));
  try {
    return await inspectSession(opened.session, input);
  } finally {
    await opened.close().catch(() => undefined);
  }
}

/** The plan of a transfer job, on a session for each side. */
export async function planTransferJob(
  connect: Connector,
  job: TransferJob,
  source: ResolvedProfile,
  target: ResolvedProfile,
): Promise<TransferPlanInfo> {
  checkEngines(source, target);
  const from = await connect(withDatabase(source, job.database));
  try {
    const to = await connect(withDatabase(target, job.target.database));
    try {
      const plan = await planDbTransfer({
        spec: transferSpecOf(job),
        source: from.session,
        target: to.session,
        sameConnection: sameConnection(job),
      });
      return transferPlanSchema.parse(plan);
    } finally {
      await to.close().catch(() => undefined);
    }
  } finally {
    await from.close().catch(() => undefined);
  }
}

/** A job's view of a transfer's progress. */
export function jobProgressOf(progress: DbTransferProgress): Omit<JobProgress, 'elapsedMs'> {
  const current = progress.current.join(', ');
  const counted = progress.tables > 0 ? ` (${progress.tablesDone} of ${progress.tables})` : '';
  return {
    phase: `${progress.phase}${counted}`.slice(0, 300),
    rowsRead: progress.rowsRead,
    rowsWritten: progress.rowsWritten,
    rowsSkipped: progress.rowsSkipped,
    rowsPerSecond: progress.rowsPerSecond,
    ...(current !== ''
      ? { table: current.length > 200 ? `${current.slice(0, 199)}…` : current }
      : {}),
  };
}

export interface TransferJobContext {
  readonly connect: Connector;
  readonly signal: AbortSignal;
  progress(progress: Omit<JobProgress, 'elapsedMs'>): void;
  log(level: 'info' | 'warning' | 'error', message: string): void;
}

function plural(count: number, word: string): string {
  return `${count.toLocaleString('en-US')} ${word}${count === 1 ? '' : 's'}`;
}

/** Runs a transfer job: plans it again on fresh sessions, checks the write rules, moves the data. */
export async function runTransferJob(
  job: TransferJob,
  source: ResolvedProfile,
  target: ResolvedProfile,
  context: TransferJobContext,
): Promise<JobOutcome> {
  checkEngines(source, target);
  if (target.profile.presentation.readOnly) {
    throw refuse(
      'READ_ONLY',
      `"${target.profile.name}" is read-only, so nothing can be transferred into it`,
    );
  }
  const opener =
    (resolved: ResolvedProfile): SessionOpener =>
    async () =>
      context.connect(resolved);
  context.log(
    'info',
    `Transferring from ${source.profile.name} to ${target.profile.name}${
      job.objects.length > 0 ? ` (${plural(job.objects.length, 'object')})` : ''
    }`,
  );
  const summary = await runDbTransfer({
    spec: transferSpecOf(job),
    source: opener(withDatabase(source, job.database)),
    target: opener(withDatabase(target, job.target.database)),
    sameConnection: sameConnection(job),
    signal: context.signal,
    onPlan: (plan) => {
      checkPlanRules(plan, job, target);
      for (const line of plan.destructive) context.log('warning', line);
    },
    onProgress: (progress) => context.progress(jobProgressOf(progress)),
    onLog: (level, message) => context.log(level, message),
  });
  const errors: JobRowError[] = summary.errors.map((error) => ({
    ...(error.table !== undefined ? { table: error.table } : {}),
    ...(error.row !== undefined ? { row: error.row } : {}),
    ...(error.line !== undefined ? { line: error.line } : {}),
    ...(error.column !== undefined ? { column: error.column } : {}),
    message: error.message,
  }));
  context.log(
    summary.status === 'completed' ? 'info' : 'error',
    `${summary.status === 'completed' ? 'Transferred' : summary.status === 'cancelled' ? 'Cancelled after' : 'Failed after'} ${plural(
      summary.rowsWritten,
      'row',
    )} into ${plural(summary.tables.filter((t) => t.status === 'completed').length, 'table')}${
      summary.rowsSkipped > 0 ? `, ${plural(summary.rowsSkipped, 'row')} skipped` : ''
    }`,
  );
  return {
    summary: {
      status: summary.status,
      rowsRead: summary.rowsRead,
      rowsWritten: summary.rowsWritten,
      rowsSkipped: summary.rowsSkipped,
      durationMs: summary.durationMs,
      tables: summary.tables.map((t) => ({
        table: t.target,
        status: t.status,
        rowsWritten: t.rowsWritten,
      })),
    },
    errors,
  };
}
