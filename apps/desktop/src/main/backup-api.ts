import { basename } from 'node:path';

import { JoineryError, requiresWriteConfirmation, type ConnectionProfile } from '@joinery/core';
import {
  backupInspectionSchema,
  nativeToolSchema,
  restorePlanSchema,
  type BackupJob,
  type HandlersOf,
  type JobInfo,
  type RestoreJob,
  type mainContract,
} from '@joinery/ipc';
import type { Store } from '@joinery/storage';
import { z } from 'zod';

import type { JobDescription, JobManager } from './jobs';
import type { FileGrants } from './jobs-api';
import { resolveProfile } from './secrets';

/**
 * Main's side of backup and restore (spec §14): the `backup.*` handlers the wizards call before
 * a job starts, and the rules `jobs.start` applies to backup and restore jobs. A backup writes
 * only where this window's save dialog pointed, a restore reads only a file it picked (ADR 0006's
 * file grants). A restore into a read-only profile is refused, and one into a production or
 * confirm-writes profile needs the page's confirmation; dropping or overwriting existing objects
 * is confirmed object by object, and the job runner checks that list against what it finds.
 */

type BackupMainHandlers = HandlersOf<typeof mainContract>['backup'];

const FORMAT_LABELS: Readonly<Record<BackupJob['format'], string>> = {
  sql: 'SQL',
  'sql-gz': 'SQL (gzip)',
  jbak: 'Joinery archive',
  custom: 'pg_dump custom format',
};

/** What the job list shows for a backup or restore. */
export function describeBackupJob(spec: BackupJob | RestoreJob): JobDescription {
  const database = spec.database !== undefined ? { database: spec.database } : {};
  if (spec.kind === 'backup') {
    const native = spec.method === 'native' ? ' with the native tools' : '';
    return {
      title: `Back up ${spec.database ?? 'the database'} to ${basename(spec.output.path)}${native}`,
      target: { file: spec.output.path, format: FORMAT_LABELS[spec.format], ...database },
    };
  }
  const selected = spec.select !== undefined ? ` (${spec.select.length} selected)` : '';
  return {
    title: `Restore ${basename(spec.path)}${selected}${spec.database !== undefined ? ` into ${spec.database}` : ''}`,
    target: { file: spec.path, ...database },
  };
}

/** The write rules of a backup or restore job (spec §4, §14), before it starts. */
export function checkBackupJobSafety(
  spec: BackupJob | RestoreJob,
  profile: ConnectionProfile,
): void {
  if (spec.kind !== 'restore') return;
  if (profile.presentation.readOnly) {
    throw new JoineryError({
      code: 'READ_ONLY',
      message: `"${profile.name}" is read-only, so nothing can be restored into it`,
    });
  }
  if (requiresWriteConfirmation(profile) && spec.confirmed !== true) {
    throw new JoineryError({
      code: 'CONFIRMATION_REQUIRED',
      message: `Restoring into ${profile.presentation.environment === 'production' ? 'a production connection' : `"${profile.name}"`} needs confirmation`,
    });
  }
}

/** The file grants of a backup (write) or restore (read) job. */
export function checkBackupPaths(spec: BackupJob | RestoreJob, grants: FileGrants): void {
  if (spec.kind === 'backup') grants.checkWrite(spec.output.path);
  else grants.checkRead(spec.path);
}

/** The finished job's one-line summary for the desktop notification. */
export function backupNotification(job: JobInfo): { title: string; body: string } {
  const summary = job.summary;
  const what = job.kind === 'backup' ? 'Backup' : 'Restore';
  const title =
    job.state === 'completed'
      ? `${what} finished`
      : job.state === 'cancelled'
        ? `${what} cancelled`
        : `${what} failed`;
  const detail =
    job.state === 'failed' && job.error
      ? job.error.message
      : `${(summary?.rowsWritten ?? 0).toLocaleString('en-US')} rows${summary?.failed ? `, ${summary.failed} statements failed` : ''}`;
  return { title, body: `${job.title}: ${detail}` };
}

function unavailable(): JoineryError {
  return new JoineryError({ code: 'NOT_SUPPORTED', message: 'Jobs cannot run here' });
}

/** The `backup.*` namespace for one window. */
export function backupMainHandlers(
  services: { readonly store: Store; readonly jobs?: JobManager | undefined },
  grants: FileGrants,
): BackupMainHandlers {
  const manager = (): JobManager => {
    if (!services.jobs) throw unavailable();
    return services.jobs;
  };
  return {
    inspect: async (input) => {
      grants.checkRead(input.path);
      return backupInspectionSchema.parse(
        await manager().request({ kind: 'backup-inspect', input }),
      );
    },
    planRestore: async ({ job, secrets }) => {
      grants.checkRead(job.path);
      const profile = services.store.profiles.get(job.profileId);
      if (!profile) {
        throw new JoineryError({ code: 'NOT_FOUND', message: 'The connection was deleted' });
      }
      const resolved = resolveProfile(services.store, profile, secrets ?? {}, {
        requireAll: true,
      });
      return restorePlanSchema.parse(
        await manager().request({ kind: 'restore-plan', input: job, resolved }),
      );
    },
    nativeTools: async () =>
      z.array(nativeToolSchema).parse(await manager().request({ kind: 'native-tools' })),
  };
}
