import { mkdir } from 'node:fs/promises';

import { ENGINES, JoineryError, isSqlEngine, type ConnectionProfile } from '@joinery/core';
import {
  scheduleTaskSchema,
  type JobInfo,
  type JobSpec,
  type ScheduleOutput,
  type ScheduleTask,
} from '@joinery/ipc';
import type { ScheduleRecord, Store } from '@joinery/storage';

import type { JobManager } from './jobs';
import { checkJobSafety, describeJob, notificationFor } from './jobs-api';
import { pruneOutputs, renderOutputName, uniqueOutputPath } from './schedule-output';
import type { TaskOutcome } from './scheduler';
import { resolveProfile } from './secrets';
import { toSavedComparison } from './sync-api';
import type { SyncService } from './sync';

/**
 * What a scheduled run does, by kind (spec: scheduler and automation). Backups, SQL files and
 * exports run as jobs in the job runner, after the same checks as a job the page starts: the
 * connection must exist (a SQL one for SQL and exports), its write rules must allow it (a
 * schedule on a production connection is confirmed when it is saved), and every secret it needs
 * must be saved, since no one is there to type one. Each run writes a new file named from the
 * schedule's template, and older ones are pruned when the schedule keeps only some. A saved
 * comparison runs as the Compare button runs it and writes its report (structure: HTML; data: the
 * sync script) when it finds differences, which make the run worth a notification.
 */

export interface TaskServices {
  readonly store: Store;
  readonly jobs: JobManager;
  readonly sync?: SyncService | undefined;
  readonly now?: () => Date;
}

/** The secret store id of an encrypted backup schedule's passphrase. */
export function passphraseRef(scheduleId: string): { id: string; policy: 'save' } {
  return { id: `schedule-passphrase-${scheduleId}`, policy: 'save' };
}

function failed(message: string, jobId: string | null = null): TaskOutcome {
  return { status: 'failed', message, outputs: [], jobId };
}

function messageOf(error: unknown): string {
  if (error instanceof JoineryError) {
    return error.hint ? `${error.message}. ${error.hint}` : error.message;
  }
  return error instanceof Error ? error.message : String(error);
}

/** A profile's secrets for an unattended run; the failure says what to do. */
function resolveSaved(store: Store, profile: ConnectionProfile) {
  try {
    return resolveProfile(store, profile, {}, { requireAll: true });
  } catch (error) {
    if (error instanceof JoineryError && error.code === 'AUTH_FAILED') {
      throw new JoineryError({
        code: 'AUTH_FAILED',
        message: `The password of ${profile.name} is not saved, and a scheduled run cannot ask for it`,
        hint: 'Save it in the connection settings ("Save" as the password storage).',
      });
    }
    throw error;
  }
}

export async function executeSchedule(
  services: TaskServices,
  schedule: ScheduleRecord,
): Promise<TaskOutcome> {
  const parsed = scheduleTaskSchema.safeParse(schedule.task);
  if (!parsed.success) {
    return failed('The schedule cannot be read by this version of Joinery; edit and save it again');
  }
  try {
    return parsed.data.kind === 'comparison'
      ? await runComparison(services, schedule, parsed.data.output)
      : await runJob(services, schedule, parsed.data);
  } catch (error) {
    return failed(messageOf(error));
  }
}

/** The path of this run's output in the schedule's folder. */
async function outputPath(
  services: TaskServices,
  schedule: ScheduleRecord,
  output: ScheduleOutput,
  folder: boolean,
): Promise<string> {
  const now = services.now?.() ?? new Date();
  await mkdir(output.folder, { recursive: true });
  const path = uniqueOutputPath(
    output.folder,
    renderOutputName(output.fileName, schedule.name, now),
  );
  if (folder) await mkdir(path, { recursive: true });
  return path;
}

async function prune(schedule: ScheduleRecord, output: ScheduleOutput): Promise<void> {
  if (output.keep !== null) {
    await pruneOutputs(output.folder, output.fileName, schedule.name, output.keep);
  }
}

/** Starts a job and waits for it to end, however it ends. */
function runToEnd(
  services: TaskServices,
  spec: JobSpec,
  resolved: ReturnType<typeof resolveSaved>,
) {
  return new Promise<JobInfo>((resolve) => {
    services.jobs.start(spec, resolved, describeJob(spec), { silent: true, onDone: resolve });
  });
}

async function runJob(
  services: TaskServices,
  schedule: ScheduleRecord,
  task: Exclude<ScheduleTask, { kind: 'comparison' }>,
): Promise<TaskOutcome> {
  const { store } = services;
  const profile = schedule.profileId === null ? undefined : store.profiles.get(schedule.profileId);
  if (!profile) return failed('The connection was deleted');
  if (task.kind !== 'backup' && !isSqlEngine(profile.engine)) {
    return failed(
      `${ENGINES[profile.engine].displayName} connections do not run SQL files or exports`,
    );
  }

  let spec: JobSpec;
  let written: string | undefined;
  if (task.kind === 'backup') {
    let passphrase: string | undefined;
    if (task.encrypted) {
      passphrase = store.secrets.get(passphraseRef(schedule.id));
      if (passphrase === undefined) {
        return failed('The backup passphrase is not saved; edit the schedule and enter it again');
      }
    }
    written = await outputPath(services, schedule, task.output, false);
    spec = {
      ...task.job,
      output: { path: written },
      ...(passphrase !== undefined ? { encryption: { passphrase } } : {}),
    };
  } else if (task.kind === 'export') {
    written = await outputPath(services, schedule, task.output, task.outputKind === 'directory');
    spec = { ...task.job, output: { kind: task.outputKind, path: written } };
  } else {
    spec = task.job;
  }

  checkJobSafety(spec, profile);
  const resolved = resolveSaved(store, profile);
  const job = await runToEnd(services, spec, resolved);
  const summary = notificationFor(job).body || null;
  if (job.state !== 'completed') {
    return {
      status: job.state === 'cancelled' ? 'cancelled' : 'failed',
      message: job.error?.message ?? summary ?? `The ${task.kind} did not finish`,
      outputs: [],
      jobId: job.id,
    };
  }
  const outputs = job.summary?.files?.length ? [...job.summary.files] : written ? [written] : [];
  if (task.kind !== 'sql') await prune(schedule, task.output);
  return { status: 'success', message: summary, outputs, jobId: job.id };
}

/** Waits for a job the sync service started to end. */
function jobEnd(jobs: JobManager, jobId: string): Promise<JobInfo> {
  return new Promise((resolve) => {
    const done = (job: JobInfo | undefined): boolean => {
      if (!job || job.state === 'running') return false;
      resolve(job);
      return true;
    };
    const stop = jobs.subscribe((event) => {
      if (event.type === 'job' && event.job.id === jobId && done(event.job)) stop();
    });
    // It may have ended already (a runner that could not start).
    if (done(jobs.get(jobId))) stop();
  });
}

async function runComparison(
  services: TaskServices,
  schedule: ScheduleRecord,
  output: ScheduleOutput,
): Promise<TaskOutcome> {
  const { store, jobs, sync } = services;
  if (!sync) return failed('Comparisons are not available in this window');
  const record =
    schedule.comparisonId === null ? undefined : store.comparisons.get(schedule.comparisonId);
  if (!record) return failed('The saved comparison was deleted');
  const saved = toSavedComparison(record);
  const { profileId: sourceId, ...sourceSide } = saved.source;
  const { profileId: targetId, ...targetSide } = saved.target;
  const from = sourceId === null ? undefined : store.profiles.get(sourceId);
  const to = targetId === null ? undefined : store.profiles.get(targetId);
  if (!from || !to)
    return failed(`The comparison's ${from ? 'target' : 'source'} connection was deleted`);
  const resolved = { source: resolveSaved(store, from), target: resolveSaved(store, to) };
  const source = { profileId: from.id, ...sourceSide };
  const target = { profileId: to.id, ...targetSide };

  if (saved.kind === 'structure') {
    const jobId = sync.startStructureCompare(
      { source, target, options: saved.structure ?? {} },
      resolved,
      { silent: true },
    );
    const job = await jobEnd(jobs, jobId);
    if (job.state !== 'completed') {
      return failed(job.error?.message ?? 'The comparison did not finish', jobId);
    }
    try {
      const result = sync.structureResult(jobId);
      const { total, create, alter, drop, rename } = result.summary;
      if (total === 0) {
        return { status: 'success', message: 'No differences', outputs: [], jobId };
      }
      const path = await outputPath(services, schedule, output, false);
      await sync.exportStructure({
        jobId,
        selected: result.diff.operations.filter((op) => op.selected).map((op) => op.id),
        format: 'html',
        path,
      });
      await prune(schedule, output);
      const parts = [
        create && `${create} to create`,
        alter && `${alter} to alter`,
        rename && `${rename} to rename`,
        drop && `${drop} to drop`,
      ].filter(Boolean);
      return {
        status: 'success',
        message: `${total} ${total === 1 ? 'difference' : 'differences'}: ${parts.join(', ')}`,
        outputs: [path],
        jobId,
        attention: true,
      };
    } finally {
      sync.discard(jobId);
    }
  }

  const options = saved.data?.options;
  if (!options) return failed('The saved comparison has no data compare options');
  const jobId = sync.startDataCompare(
    { source, target, options, ...(saved.data?.tables ? { tables: saved.data.tables } : {}) },
    resolved,
    { silent: true },
  );
  const job = await jobEnd(jobs, jobId);
  if (job.state !== 'completed') {
    return failed(job.error?.message ?? 'The comparison did not finish', jobId);
  }
  try {
    const result = sync.dataResult(jobId);
    let inserts = 0;
    let updates = 0;
    let deletes = 0;
    const changed: number[] = [];
    const broken = result.tables.filter((t) => t.error !== undefined).length;
    for (const table of result.tables) {
      inserts += table.counts.inserts;
      updates += table.counts.updates;
      deletes += table.counts.deletes;
      if (table.counts.inserts + table.counts.updates + table.counts.deletes > 0) {
        changed.push(table.index);
      }
    }
    const rows = inserts + updates + deletes;
    const problems =
      broken > 0 ? ` (${broken} ${broken === 1 ? 'table' : 'tables'} could not be compared)` : '';
    if (rows === 0) {
      return {
        status: 'success',
        message: `No differences${problems}`,
        outputs: [],
        jobId,
        attention: broken > 0,
      };
    }
    const path = await outputPath(services, schedule, output, false);
    await sync.exportData({ jobId, tables: changed, actions: options.actions, path });
    await prune(schedule, output);
    return {
      status: 'success',
      message: `${rows} rows differ: ${inserts} missing, ${updates} changed, ${deletes} extra${problems}`,
      outputs: [path],
      jobId,
      attention: true,
    };
  } finally {
    sync.discard(jobId);
  }
}
