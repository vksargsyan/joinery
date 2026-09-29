import { JoineryError } from '@joinery/core';
import type { JobEvent, JobInfo, JobSpec } from '@joinery/ipc';
import { create } from 'zustand';

import { mainApi } from '../lib/main-client';
import { profileById } from './data';
import { askSecrets } from './dialogs';
import { invalidateMetadata } from './metadata';

/**
 * The job list (spec §14): running and finished jobs as main reports them, kept up to date by
 * main's job event stream. Jobs run in the job runner process; this page only starts them,
 * shows their progress, summaries, failed rows and logs, and cancels them.
 */

interface JobsState {
  /** jobId → job. */
  readonly jobs: Readonly<Record<string, JobInfo>>;
  /** Newest first. */
  readonly order: readonly string[];
  /** The jobs panel is showing. */
  readonly open: boolean;
  /** The job whose details are expanded. */
  readonly selected: string | undefined;
}

export const useJobs = create<JobsState>()(() => ({
  jobs: {},
  order: [],
  open: false,
  selected: undefined,
}));

/** Jobs started from this page that change structure (CREATE TABLE, a SQL file's DDL). */
const structural = new Set<string>();

/** Applies one event from main's job stream. */
export function applyJobEvent(event: JobEvent): void {
  if (event.type === 'job' && event.job.state !== 'running' && structural.delete(event.job.id)) {
    // The explorer, the designers and autocomplete read the structure again.
    invalidateMetadata(event.job.profileId);
  }
  useJobs.setState((state) => {
    switch (event.type) {
      case 'job': {
        const known = event.job.id in state.jobs;
        return {
          jobs: { ...state.jobs, [event.job.id]: event.job },
          order: known ? state.order : [event.job.id, ...state.order],
        };
      }
      case 'progress': {
        const job = state.jobs[event.jobId];
        if (!job || job.state !== 'running') return state;
        return { jobs: { ...state.jobs, [event.jobId]: { ...job, progress: event.progress } } };
      }
      case 'log': {
        const job = state.jobs[event.jobId];
        if (!job) return state;
        return {
          jobs: { ...state.jobs, [event.jobId]: { ...job, log: [...job.log, event.entry] } },
        };
      }
      case 'removed': {
        const { [event.jobId]: _gone, ...jobs } = state.jobs;
        return {
          jobs,
          order: state.order.filter((id) => id !== event.jobId),
          selected: state.selected === event.jobId ? undefined : state.selected,
        };
      }
    }
  });
}

/** Follows main's job events for the life of the page. */
export async function watchJobs(): Promise<void> {
  for (;;) {
    try {
      for await (const event of mainApi().jobs.events()) applyJobEvent(event);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
}

export function showJobs(open = true, selected?: string): void {
  useJobs.setState((state) => ({
    open,
    selected: selected ?? state.selected,
  }));
}

export function selectJob(jobId: string | undefined): void {
  useJobs.setState({ selected: jobId });
}

/**
 * Starts a job and shows it in the job list. Secrets main has no value for ("ask every time")
 * are asked for first; resolves undefined when the user dismisses that prompt.
 */
export async function startJob(job: JobSpec): Promise<string | undefined> {
  const profile = await profileById(job.profileId);
  if (!profile)
    throw new JoineryError({ code: 'NOT_FOUND', message: 'The connection was deleted' });
  const status = await mainApi().profiles.secretStatus({ profileId: job.profileId });
  let secrets: Record<string, string> | undefined;
  if (status.missing.length > 0) {
    const typed = await askSecrets(profile.name, status.missing);
    if (typed === null) return undefined;
    secrets = typed;
  }
  const { jobId } = await mainApi().jobs.start({ job, ...(secrets ? { secrets } : {}) });
  if (job.kind === 'run-sql-file' || (job.kind === 'import' && job.create !== undefined)) {
    structural.add(jobId);
    // It may have finished before this call returned.
    const known = useJobs.getState().jobs[jobId];
    if (known && known.state !== 'running' && structural.delete(jobId)) {
      invalidateMetadata(job.profileId);
    }
  }
  showJobs(true, jobId);
  return jobId;
}

export async function cancelJob(jobId: string): Promise<void> {
  await mainApi().jobs.cancel({ jobId });
}

export async function clearFinishedJobs(): Promise<void> {
  await mainApi().jobs.clear();
}

/** Jobs still running, for the header badge. */
export function runningCount(state: JobsState): number {
  let count = 0;
  for (const id of state.order) if (state.jobs[id]?.state === 'running') count++;
  return count;
}

/** How far along a job is, 0–1, when its size is known. */
export function jobFraction(job: JobInfo): number | undefined {
  if (job.state !== 'running') return job.state === 'completed' ? 1 : undefined;
  const progress = job.progress;
  if (!progress?.totalBytes || progress.bytes === undefined) return undefined;
  return Math.min(1, progress.bytes / progress.totalBytes);
}
