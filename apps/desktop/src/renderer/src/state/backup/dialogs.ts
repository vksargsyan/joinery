import { isSqlEngine, requiresWriteConfirmation } from '@joinery/core';
import type { BackupJob, JobInfo, RestoreJob, RestorePlan, StoredProfile } from '@joinery/ipc';
import { replyText, utf8Bytes } from '@joinery/redis-tools';
import { create } from 'zustand';

import { destructive } from '../../../../shared/redis-safety';
import { mainApi } from '../../lib/main-client';
import { askSecrets } from '../dialogs';
import { loadChildren, pathKey, useExplorer } from '../explorer';
import { showJobs, useJobs } from '../jobs';
import { invalidateMetadata } from '../metadata';
import { redisWrite, withDatabaseSession } from '../redis/panels';
import type { BackupTarget } from './options';

/**
 * Which backup dialog is open (spec §14): the backup wizard or the restore wizard, opened from
 * the explorer on a connection, a database or a schema (a Redis namespace for backups). The
 * window renders whichever is set. The jobs themselves run in the job runner; this module
 * starts them with the connection's "ask every time" secrets and follows a restore to its end
 * so the explorer and the metadata read the new structure.
 */

export type BackupDialog =
  | { readonly kind: 'backup'; readonly target: BackupTarget }
  | { readonly kind: 'restore'; readonly target: BackupTarget };

interface BackupDialogsState {
  readonly dialog: BackupDialog | undefined;
}

export const useBackupDialogs = create<BackupDialogsState>()(() => ({ dialog: undefined }));

export function closeBackupDialog(): void {
  useBackupDialogs.setState({ dialog: undefined });
}

/** Where in the explorer a dialog was opened. */
export interface BackupLocation {
  readonly database?: string | undefined;
  readonly schema?: string | undefined;
  readonly pattern?: string | undefined;
  readonly node?: string | undefined;
}

/** The dialog target of a profile and an explorer location. */
export function backupTarget(profile: StoredProfile, location: BackupLocation = {}): BackupTarget {
  return {
    profileId: profile.id,
    profileName: profile.name,
    engine: profile.engine,
    database: location.database,
    schema: profile.engine === 'postgres' ? location.schema : undefined,
    pattern: location.pattern,
    node: location.node,
    readOnly: profile.presentation.readOnly,
    production: profile.presentation.environment === 'production',
    confirmWrites: requiresWriteConfirmation(profile),
  };
}

/** Engines Joinery backs up. */
export function backsUp(profile: StoredProfile): boolean {
  return isSqlEngine(profile.engine) || profile.engine === 'mongodb' || profile.engine === 'redis';
}

export function openBackupDialog(profile: StoredProfile, location?: BackupLocation): void {
  if (!backsUp(profile)) return;
  useBackupDialogs.setState({
    dialog: { kind: 'backup', target: backupTarget(profile, location) },
  });
}

export function openRestoreDialog(profile: StoredProfile, location?: BackupLocation): void {
  if (!backsUp(profile)) return;
  useBackupDialogs.setState({
    dialog: { kind: 'restore', target: backupTarget(profile, location) },
  });
}

/**
 * The connection's "ask every time" secrets, asked for once per wizard: undefined when main
 * has them all, null when the user dismissed the prompt. They stay in the wizard's memory
 * only, for its plan and its job.
 */
export async function wizardSecrets(
  target: BackupTarget,
): Promise<Record<string, string> | undefined | null> {
  const status = await mainApi().profiles.secretStatus({ profileId: target.profileId });
  if (status.missing.length === 0) return undefined;
  return askSecrets(target.profileName, status.missing);
}

/** What a restore would do on its target, for the review step. */
export function planRestore(
  job: RestoreJob,
  secrets: Record<string, string> | undefined,
): Promise<RestorePlan> {
  return mainApi().backup.planRestore({ job, ...(secrets ? { secrets } : {}) });
}

function finished(job: JobInfo | undefined): boolean {
  return job !== undefined && job.state !== 'running';
}

/** Runs `then` once the job has finished (at once when it has). */
function whenFinished(jobId: string, then: (job: JobInfo) => void): void {
  const known = useJobs.getState().jobs[jobId];
  if (known && finished(known)) {
    then(known);
    return;
  }
  const stop = useJobs.subscribe((state) => {
    const job = state.jobs[jobId];
    if (!job || !finished(job)) return;
    stop();
    then(job);
  });
}

/**
 * Starts a backup or restore job. After a restore the connection's metadata and explorer are
 * read again, the database list too when the restore created a database.
 */
export async function startBackupJob(
  target: BackupTarget,
  job: BackupJob | RestoreJob,
  secrets: Record<string, string> | undefined,
): Promise<string> {
  const { jobId } = await mainApi().jobs.start({ job, ...(secrets ? { secrets } : {}) });
  if (job.kind === 'restore') {
    whenFinished(jobId, () => {
      if (isSqlEngine(target.engine)) invalidateMetadata(target.profileId);
      void loadChildren(target.profileId, []);
    });
  }
  return jobId;
}

const MONGO_FOLDERS = ['collections', 'time-series', 'views', 'gridfs'] as const;

/**
 * A MongoDB database's collections, time series collections, views and GridFS bucket
 * collections, from the explorer's listing (which it fills on the way).
 */
export async function mongoCollections(
  profileId: string,
  database: string,
): Promise<{ readonly name: string; readonly kind: string }[]> {
  const found: { name: string; kind: string }[] = [];
  for (const folder of MONGO_FOLDERS) {
    const path = [database, folder];
    await loadChildren(profileId, path);
    const listed = useExplorer.getState().children[profileId]?.[pathKey(path)];
    if (listed?.error !== undefined) throw new Error(listed.error);
    for (const node of listed?.nodes ?? []) {
      if (node.kind === 'gridfs-bucket') {
        found.push({ name: `${node.name}.files`, kind: 'collection' });
        found.push({ name: `${node.name}.chunks`, kind: 'collection' });
      } else if (
        node.kind === 'collection' ||
        node.kind === 'time-series' ||
        node.kind === 'view'
      ) {
        found.push({ name: node.name, kind: node.kind });
      }
    }
  }
  return found;
}

/** Shows a job in the Jobs panel. */
export function showBackupJob(jobId: string): void {
  showJobs(true, jobId);
}

/**
 * BGSAVE (spec §14: a server snapshot with confirmation): the server forks and writes its own
 * RDB file. Always confirmed, since it loads the server; refused on a read-only connection.
 * Resolves the server's reply, or undefined when the user said no.
 */
export async function serverSnapshot(target: BackupTarget): Promise<string | undefined> {
  const database = target.database !== undefined ? Number(target.database) : undefined;
  const args = [utf8Bytes('BGSAVE')];
  const result = await redisWrite({
    profileId: target.profileId,
    operation: destructive(
      'forks the server to write its whole dataset to its own RDB file, which takes memory and disk',
    ),
    title: 'Save a snapshot on the server?',
    commands: [args],
    confirmLabel: 'Start BGSAVE',
    run: (confirmed) =>
      withDatabaseSession(target.profileId, database, (host, sessionId) =>
        host.redis.command({
          sessionId,
          args,
          confirmed,
          ...(target.node !== undefined ? { node: target.node } : {}),
        }),
      ),
  });
  if (!result) return undefined;
  return replyText(result.reply) ?? 'Done';
}
