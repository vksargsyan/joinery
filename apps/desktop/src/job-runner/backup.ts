import {
  ArchiveReader,
  createDatabase,
  currentDatabase,
  detectNativeTools,
  inspectBackup,
  isArchive,
  nativeBackup,
  nativeRestore,
  planRestore,
  resolveSelection,
  runBackup,
  runRestore,
  type BackupProgress,
  type BackupSummary,
  type RestoreProgress,
  type RestoreSummary,
} from '@joinery/backup';
import {
  JoineryError,
  fromErrorData,
  isSqlEngine,
  type ResolvedProfile,
  type Session,
} from '@joinery/core';
import type {
  BackupInspection,
  BackupJob,
  JobProgress,
  JobRowError,
  NativeToolInfo,
  RestoreJob,
  RestorePlan,
} from '@joinery/ipc';
import { fileSink } from '@joinery/transfer';
import { open } from 'node:fs/promises';

import type { BackupRunnerRequest } from '../shared/backup-protocol';
import type { JobSession } from './runner';
import type { JobContext, JobOutcome } from './tasks';

/**
 * Backups and restores in the job runner (spec §14, ADR 0006): the @joinery/backup engine with
 * the job's progress events, log and summary, so they share the job list, history and
 * notifications with imports and exports. The restore write rules are enforced here too: a
 * read-only profile refuses, and the engine refuses to drop or overwrite anything the user did
 * not confirm after seeing the plan.
 */

/** What backup and restore jobs need besides the common job context. */
export interface BackupJobContext extends JobContext {
  /** The profile the session was opened with (a tunnel's local end included): native tools. */
  readonly resolved: ResolvedProfile;
  /** Opens another session on the same server, in `database` (a restore into a new one). */
  readonly connect: (database: string) => Promise<JobSession>;
}

function invalid(message: string): JoineryError {
  return new JoineryError({ code: 'VALIDATION_FAILED', message });
}

function jobProgress(
  progress: BackupProgress | RestoreProgress,
  restoring: boolean,
): Omit<JobProgress, 'elapsedMs'> {
  const phase =
    progress.object !== undefined ? `${progress.phase}: ${progress.object}` : progress.phase;
  return {
    // The job list's phase line is short; a long object name is cut.
    phase: phase.length > 300 ? `${phase.slice(0, 299)}…` : phase,
    rowsRead: progress.rows,
    rowsWritten: progress.rows,
    bytes: progress.bytes,
    ...('totalBytes' in progress && progress.totalBytes !== undefined
      ? { totalBytes: progress.totalBytes }
      : {}),
    ...(restoring && 'statements' in progress
      ? { statements: progress.statements, failed: progress.failed }
      : {}),
    ...(progress.object !== undefined ? { table: progress.object } : {}),
  };
}

/** Checks the options that only make sense together, before anything runs. */
export function checkBackupJob(job: BackupJob, engine: string): void {
  const native = job.method === 'native';
  if (native && !isSqlEngine(engine as never)) {
    throw invalid('The native tools back up MySQL, MariaDB and PostgreSQL only');
  }
  if (native && job.format === 'jbak')
    throw invalid('The native tools do not write .jbak archives');
  if (!native && job.format === 'custom') throw invalid('The custom format needs pg_dump');
  if (job.format === 'custom' && engine !== 'postgres') {
    throw invalid('The custom format is PostgreSQL only');
  }
  if (job.encryption !== undefined && (job.format !== 'jbak' || native)) {
    throw invalid('Encryption needs the Joinery archive format (.jbak)');
  }
  if (!isSqlEngine(engine as never) && job.format !== 'jbak') {
    throw invalid('MongoDB and Redis backups use the Joinery archive format (.jbak)');
  }
}

function backupOutcome(summary: BackupSummary, path: string): JobOutcome {
  if (summary.status === 'failed') {
    throw summary.error ? fromErrorData(summary.error) : invalid('The backup failed');
  }
  return {
    summary: {
      status: summary.status,
      rowsRead: summary.rows,
      rowsWritten: summary.rows,
      rowsSkipped: 0,
      bytesWritten: summary.bytesWritten,
      durationMs: summary.durationMs,
      ...(summary.status === 'completed' ? { files: [path] } : {}),
    },
    errors: [],
  };
}

export async function runBackupJob(job: BackupJob, ctx: BackupJobContext): Promise<JobOutcome> {
  const { session } = ctx;
  checkBackupJob(job, session.engine);
  const path = job.output.path;
  const common = {
    signal: ctx.signal,
    onProgress: (p: BackupProgress) => ctx.progress(jobProgress(p, false)),
    onLog: ctx.log,
  };
  let summary: BackupSummary;
  if (job.method === 'native') {
    const database = job.database ?? (await currentDatabase(session));
    const tables = (job.selection?.include ?? [])
      .filter((ref) => ref.kind === 'table')
      .map((ref) => ({
        ...(ref.schema !== undefined ? { schema: ref.schema } : {}),
        name: ref.name,
      }));
    summary = await nativeBackup({
      ...common,
      resolved: ctx.resolved,
      engine: session.engine,
      serverVersion: session.serverVersion,
      database,
      output: fileSink(path),
      format: job.format === 'jbak' ? 'sql' : job.format,
      ...(job.selection?.schemas !== undefined ? { schemas: job.selection.schemas } : {}),
      ...(tables.length > 0 ? { tables } : {}),
      ...(job.structure !== undefined ? { structure: job.structure } : {}),
      ...(job.data !== undefined ? { data: job.data } : {}),
      ...(job.grants !== undefined ? { grants: job.grants } : {}),
      ...(job.ownership !== undefined ? { ownership: job.ownership } : {}),
      ...(job.deferrable !== undefined ? { deferrable: job.deferrable } : {}),
    });
  } else {
    summary = await runBackup({
      ...common,
      session,
      output: fileSink(path),
      format: job.format === 'custom' ? 'jbak' : job.format,
      producer: 'Joinery',
      ...(job.compress !== undefined ? { compress: job.compress } : {}),
      ...(job.encryption !== undefined
        ? { encryption: { passphrase: job.encryption.passphrase } }
        : {}),
      ...(job.selection !== undefined ? { selection: job.selection } : {}),
      ...(job.structure !== undefined ? { structure: job.structure } : {}),
      ...(job.data !== undefined ? { data: job.data } : {}),
      ...(job.grants !== undefined ? { grants: job.grants } : {}),
      ...(job.ownership !== undefined ? { ownership: job.ownership } : {}),
      ...(job.consistent !== undefined ? { consistent: job.consistent } : {}),
      ...(job.deferrable !== undefined ? { deferrable: job.deferrable } : {}),
      ...(job.rowsPerStatement !== undefined ? { rowsPerStatement: job.rowsPerStatement } : {}),
      ...(job.collections !== undefined ? { collections: job.collections } : {}),
      ...(job.documentFormat !== undefined ? { documentFormat: job.documentFormat } : {}),
      ...(job.pattern !== undefined ? { pattern: job.pattern } : {}),
    });
  }
  for (const warning of summary.warnings) ctx.log('warning', warning);
  return backupOutcome(summary, path);
}

function rowError(error: RestoreSummary['errors'][number]): JobRowError {
  return {
    ...(error.statement !== undefined ? { statement: error.statement } : {}),
    ...(error.line !== undefined ? { line: error.line } : {}),
    message: error.object !== undefined ? `${error.object}: ${error.message}` : error.message,
    ...(error.text !== undefined ? { text: error.text } : {}),
  };
}

async function databaseOptions(
  path: string,
  passphrase: string | undefined,
): Promise<Record<string, string>> {
  const handle = await open(path, 'r');
  const head = Buffer.alloc(8);
  try {
    await handle.read(head, 0, 8, 0);
  } finally {
    await handle.close();
  }
  if (!isArchive(head)) return {};
  const archive = await ArchiveReader.open(path, passphrase !== undefined ? { passphrase } : {});
  try {
    return { ...archive.manifest.databaseOptions };
  } finally {
    await archive.close();
  }
}

export async function runRestoreJob(job: RestoreJob, ctx: BackupJobContext): Promise<JobOutcome> {
  if (ctx.readOnly) {
    throw new JoineryError({
      code: 'READ_ONLY',
      message: 'This connection is read-only, so nothing can be restored into it',
    });
  }
  let session: Session = ctx.session;
  let extra: JobSession | undefined;
  let resolved = ctx.resolved;
  try {
    if (job.createDatabase === true) {
      if (!isSqlEngine(session.engine) || job.database === undefined) {
        throw invalid('Only MySQL, MariaDB and PostgreSQL databases are created by a restore');
      }
      await createDatabase(session, job.database, await databaseOptions(job.path, job.passphrase));
      ctx.log('info', `Created the database ${job.database}`);
      extra = await ctx.connect(job.database);
      session = extra.session;
      resolved = extra.resolved ?? resolved;
    }
    const common = {
      signal: ctx.signal,
      onProgress: (p: RestoreProgress) => ctx.progress(jobProgress(p, true)),
      onLog: ctx.log,
      onError: job.onError,
      ...(job.confirmedConflicts !== undefined
        ? { confirmedConflicts: job.confirmedConflicts }
        : {}),
    };
    let summary: RestoreSummary;
    if (job.method === 'native') {
      if (!isSqlEngine(session.engine)) {
        throw invalid('The native tools restore into MySQL, MariaDB and PostgreSQL only');
      }
      summary = await nativeRestore({
        ...common,
        session,
        resolved,
        engine: session.engine,
        serverVersion: session.serverVersion,
        database: job.database ?? (await currentDatabase(session)),
        path: job.path,
      });
    } else {
      summary = await runRestore({
        ...common,
        session,
        path: job.path,
        ...(job.passphrase !== undefined ? { passphrase: job.passphrase } : {}),
        ...(job.select !== undefined ? { select: job.select } : {}),
        ...(job.structure !== undefined ? { structure: job.structure } : {}),
        ...(job.data !== undefined ? { data: job.data } : {}),
        ...(job.replace !== undefined ? { replace: job.replace } : {}),
        ...(job.absoluteTtl !== undefined ? { absoluteTtl: job.absoluteTtl } : {}),
      });
    }
    for (const warning of summary.warnings) ctx.log('warning', warning);
    if (summary.status === 'failed' && summary.error) throw fromErrorData(summary.error);
    return {
      summary: {
        status: summary.status,
        rowsRead: summary.rows,
        rowsWritten: summary.rows,
        rowsSkipped: 0,
        statements: summary.statements,
        failed: summary.failed,
        durationMs: summary.durationMs,
      },
      errors: summary.errors.map(rowError),
    };
  } finally {
    await extra?.close().catch(() => undefined);
  }
}

/** Runs a backup or restore job. */
export function runBackupTask(
  job: BackupJob | RestoreJob,
  ctx: BackupJobContext,
): Promise<JobOutcome> {
  return job.kind === 'backup' ? runBackupJob(job, ctx) : runRestoreJob(job, ctx);
}

/** The database a job's first session opens: none yet when the restore creates it. */
export function connectDatabase(job: {
  readonly kind: string;
  readonly database?: string | undefined;
  readonly createDatabase?: boolean | undefined;
}): string | undefined {
  return job.kind === 'restore' && job.createDatabase === true ? undefined : job.database;
}

const BACKUP_REQUESTS: ReadonlySet<string> = new Set([
  'backup-inspect',
  'restore-plan',
  'native-tools',
]);

export function isBackupRequest(request: {
  readonly kind: string;
}): request is BackupRunnerRequest {
  return BACKUP_REQUESTS.has(request.kind);
}

/** The inspection of a backup file, as the restore wizard shows it. */
export async function inspectFile(path: string, passphrase?: string): Promise<BackupInspection> {
  const info = await inspectBackup(path, passphrase);
  const manifest = info.manifest;
  return {
    format: info.format,
    size: info.size,
    encrypted: info.encrypted,
    ...(info.engine !== undefined ? { engine: info.engine } : {}),
    ...(info.serverVersion !== undefined ? { serverVersion: info.serverVersion } : {}),
    ...(info.database !== undefined ? { database: info.database } : {}),
    ...(manifest
      ? {
          createdAt: manifest.createdAt,
          producer: manifest.producer,
          options: manifest.options,
          warnings: manifest.warnings,
          objects: manifest.objects.map((o) => ({
            id: o.id,
            kind: o.kind,
            ...(o.schema !== undefined ? { schema: o.schema } : {}),
            name: o.name,
            qualifiedName: o.qualifiedName,
            ...(o.parent !== undefined ? { parent: o.parent } : {}),
            dependsOn: o.dependsOn,
            ...(o.data !== undefined ? { rows: o.data.count } : {}),
            ...(o.detail !== undefined ? { detail: o.detail } : {}),
          })),
        }
      : {}),
  };
}

/** A plan for a restore into a database that does not exist yet: nothing there to clash with. */
async function planIntoNewDatabase(job: RestoreJob): Promise<RestorePlan> {
  const info = await inspectBackup(job.path, job.passphrase);
  if (!info.manifest) {
    return {
      format: info.format,
      objects: [],
      added: [],
      skipped: [],
      conflicts: [],
      warnings: [],
    };
  }
  const select = job.select !== undefined ? new Set(job.select) : undefined;
  const chosen = resolveSelection(info.manifest.objects, {
    ...(select ? { include: (o) => select.has(o.id) } : {}),
  });
  return {
    format: info.format,
    objects: [...chosen.ids],
    added: [...chosen.added],
    skipped: chosen.skipped.map((s) => ({ ...s })),
    conflicts: [],
    warnings: [],
  };
}

/** The profile with another default database. */
export function inDatabase(
  resolved: ResolvedProfile,
  database: string | undefined,
): ResolvedProfile {
  if (database === undefined) return resolved;
  const { profile } = resolved;
  return {
    ...resolved,
    profile: { ...profile, options: { ...profile.options, defaultDatabase: database } },
  };
}

/** Answers the backup and restore wizards' requests. */
export async function answerBackupRequest(
  request: BackupRunnerRequest,
  deps: { readonly connect: (resolved: ResolvedProfile) => Promise<JobSession> },
): Promise<BackupInspection | RestorePlan | NativeToolInfo[]> {
  switch (request.kind) {
    case 'backup-inspect':
      return inspectFile(request.input.path, request.input.passphrase);
    case 'native-tools':
      return (await detectNativeTools()).map((tool) => ({ ...tool }));
    case 'restore-plan': {
      const job = request.input;
      if (job.createDatabase === true) return planIntoNewDatabase(job);
      const opened = await deps.connect(inDatabase(request.resolved, job.database));
      try {
        const plan = await planRestore({
          session: opened.session,
          path: job.path,
          ...(job.passphrase !== undefined ? { passphrase: job.passphrase } : {}),
          ...(job.select !== undefined ? { select: job.select } : {}),
          ...(job.structure !== undefined ? { structure: job.structure } : {}),
          ...(job.data !== undefined ? { data: job.data } : {}),
          ...(job.replace !== undefined ? { replace: job.replace } : {}),
        });
        return {
          format: plan.format,
          objects: [...plan.objects],
          added: [...plan.added],
          skipped: plan.skipped.map((s) => ({ ...s })),
          conflicts: plan.conflicts.map((c) => ({ ...c })),
          warnings: [...plan.warnings],
        };
      } finally {
        await opened.close().catch(() => undefined);
      }
    }
  }
}
