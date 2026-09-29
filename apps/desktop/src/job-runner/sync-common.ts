import { createHash } from 'node:crypto';

import {
  JoineryError,
  isSqlEngine,
  newId,
  requiresWriteConfirmation,
  type ConnectionProfile,
  type IntrospectScope,
  type SchemaObjectKind,
  type Session,
  type SqlDialect,
} from '@joinery/core';
import type { JobProgress, SyncSideInfo } from '@joinery/ipc';

import type { JobSide, SyncJobResult } from '../shared/sync-jobs';
import type { JobOutcome } from './tasks';

/**
 * What the job runner's structure and data sync tasks share (spec §13): the job context with
 * both sessions, the write rules checked again here whatever main decided, and running one
 * statement with cancel.
 */

/** A sync job's sessions and reporting. A compare has both sides; an apply the target only. */
export interface SyncJobContext {
  readonly target: Session;
  readonly targetProfile: ConnectionProfile;
  readonly source?: Session | undefined;
  readonly sourceProfile?: ConnectionProfile | undefined;
  readonly signal: AbortSignal;
  progress(progress: Omit<JobProgress, 'elapsedMs'>): void;
  log(level: 'info' | 'warning' | 'error', message: string): void;
}

/** A sync job's outcome: the job summary, and the result main keeps for the page. */
export interface SyncJobOutcome extends JobOutcome {
  readonly result?: SyncJobResult;
}

export function sqlDialect(session: Session): SqlDialect {
  if (isSqlEngine(session.engine)) return session.engine;
  throw new JoineryError({
    code: 'NOT_SUPPORTED',
    message: `Sync works with MySQL, MariaDB and PostgreSQL, not ${session.engine}`,
  });
}

/** PostgreSQL, or the MySQL family (MySQL and MariaDB). */
export function family(dialect: SqlDialect): 'postgres' | 'mysql' {
  return dialect === 'postgres' ? 'postgres' : 'mysql';
}

/** Both sessions of a compare; an apply job has no source. */
export function bothSides(context: SyncJobContext): { source: Session; target: Session } {
  if (!context.source || !context.sourceProfile) {
    throw new JoineryError({ code: 'INTERNAL', message: 'The source connection is missing' });
  }
  return { source: context.source, target: context.target };
}

/** Introspection scope for one side: PostgreSQL schemas when narrowed. */
export function scopeFor(
  side: JobSide,
  session: Session,
  include?: readonly SchemaObjectKind[],
): IntrospectScope {
  return {
    ...(sqlDialect(session) === 'postgres' && side.schemas !== undefined && side.schemas.length > 0
      ? { schemas: side.schemas }
      : {}),
    ...(include !== undefined ? { include } : {}),
  };
}

export function sideInfo(
  profile: ConnectionProfile,
  session: Session,
  database: string,
  side: JobSide,
): SyncSideInfo {
  return {
    profileId: profile.id,
    profileName: profile.name,
    engine: session.engine,
    serverVersion: session.serverVersion,
    database,
    ...(side.schemas !== undefined && side.schemas.length > 0 ? { schemas: side.schemas } : {}),
  };
}

/**
 * The write rules for applying to the target (spec §4), checked here as well as in main: a
 * read-only profile refuses, and a production profile or one that confirms every write needs
 * the user's confirmation.
 */
export function checkTargetWrite(profile: ConnectionProfile, confirmed: boolean): void {
  if (profile.presentation.readOnly) {
    throw new JoineryError({
      code: 'READ_ONLY',
      message: `"${profile.name}" is read-only, so nothing was applied`,
    });
  }
  if (requiresWriteConfirmation(profile) && !confirmed) {
    throw new JoineryError({
      code: 'CONFIRMATION_REQUIRED',
      message: `Applying to ${profile.presentation.environment === 'production' ? 'a production connection' : `"${profile.name}"`} needs confirmation`,
    });
  }
}

export function cancelledError(): JoineryError {
  return new JoineryError({ code: 'CANCELLED', message: 'Cancelled' });
}

export function isCancelled(error: unknown, signal: AbortSignal): boolean {
  return signal.aborted || (error instanceof JoineryError && error.code === 'CANCELLED');
}

/** Runs one statement to completion; returns the rows it affected, when the server said. */
export async function runStatement(
  session: Session,
  sql: string,
  signal: AbortSignal,
): Promise<number> {
  if (signal.aborted) throw cancelledError();
  let affected = 0;
  for await (const chunk of session.execute(sql, { executionId: newId(), signal })) {
    if (chunk.type === 'status' && chunk.rowsAffected !== null) affected += chunk.rowsAffected;
  }
  return affected;
}

/** Rolls back an open transaction after a failure, quietly. */
export async function rollbackQuietly(session: Session): Promise<void> {
  if (!session.inTransaction) return;
  try {
    for await (const _chunk of session.execute('ROLLBACK', { executionId: newId() })) {
      // drained
    }
  } catch {
    // The failure that led here is the one worth reporting.
  }
}

export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** The first line of a statement, for progress and logs. */
export function firstLine(sql: string, max = 100): string {
  const line = sql.trim().split(/\r?\n/)[0] ?? '';
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

export function plural(count: number, word: string, many = `${word}s`): string {
  return `${count.toLocaleString('en-US')} ${count === 1 ? word : many}`;
}
