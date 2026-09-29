import {
  JoineryError,
  toErrorData,
  type ErrorData,
  type ResolvedProfile,
  type Session,
} from '@joinery/core';
import type { JobProgress, JobSpec } from '@joinery/ipc';

import {
  mainToRunnerSchema,
  type MainToRunner,
  type RunnerRequest,
  type RunnerToMain,
} from '../shared/job-protocol';
import {
  matchColumns,
  planNewTable,
  previewFile,
  runExport,
  runImport,
  runSqlFileJob,
  type JobContext,
  type JobOutcome,
} from './tasks';

/**
 * The job runner's core (spec §3): runs jobs side by side, each on its own driver session,
 * and answers the wizards' quick requests. Main talks to it with the validated messages of
 * shared/job-protocol; the process entry (index.ts) only wires the parent port and the
 * session opener, so the tests drive this class directly.
 */

/** A driver session opened for one job, and how to close it (and its tunnel). */
export interface JobSession {
  readonly session: Session;
  close(): Promise<void>;
}

export interface JobRunnerDeps {
  /** Sends a message to main. */
  readonly post: (message: RunnerToMain) => void;
  /** Opens a job's session, through the profile's SSH tunnel or proxy when it has one. */
  readonly connect: (resolved: ResolvedProfile, jobId: string) => Promise<JobSession>;
  /** Main's answer to a host key question of a job's tunnel. */
  readonly hostKeyDecision?: (
    message: Extract<MainToRunner, { type: 'host-key-decision' }>,
  ) => void;
  /** Ends the process once `shutdown` has cancelled every job. */
  readonly exit?: () => void;
}

interface RunningJob {
  readonly controller: AbortController;
  readonly done: Promise<void>;
}

/** The profile with another default database: the job's session connects to (or uses) it. */
function withDatabase(resolved: ResolvedProfile, database: string | undefined): ResolvedProfile {
  if (database === undefined) return resolved;
  const { profile } = resolved;
  return {
    ...resolved,
    profile: { ...profile, options: { ...profile.options, defaultDatabase: database } },
  };
}

function cancelled(error: unknown): boolean {
  return error instanceof JoineryError && error.code === 'CANCELLED';
}

export class JobRunner {
  readonly #deps: JobRunnerDeps;
  readonly #jobs = new Map<string, RunningJob>();

  constructor(deps: JobRunnerDeps) {
    this.#deps = deps;
  }

  /** Jobs still running. */
  get running(): number {
    return this.#jobs.size;
  }

  /** Handles one raw message from main; invalid messages are ignored. */
  handle(raw: unknown): void {
    const parsed = mainToRunnerSchema.safeParse(raw);
    if (!parsed.success) return;
    const message = parsed.data;
    switch (message.type) {
      case 'start':
        this.#start(message.jobId, message.job, message.resolved);
        return;
      case 'cancel':
        this.#jobs.get(message.jobId)?.controller.abort();
        return;
      case 'request':
        void this.#answer(message.requestId, message.request);
        return;
      case 'host-key-decision':
        this.#deps.hostKeyDecision?.(message);
        return;
      case 'shutdown':
        void this.shutdown().finally(() => this.#deps.exit?.());
        return;
    }
  }

  /** Cancels every job and waits (a little) for their rollbacks. */
  async shutdown(graceMs = 5_000): Promise<void> {
    const jobs = [...this.#jobs.values()];
    for (const job of jobs) job.controller.abort();
    await Promise.race([
      Promise.allSettled(jobs.map((job) => job.done)),
      new Promise((resolve) => setTimeout(resolve, graceMs).unref?.()),
    ]);
  }

  #post(message: RunnerToMain): void {
    try {
      this.#deps.post(message);
    } catch {
      // Main is gone; the process is about to end.
    }
  }

  async #answer(requestId: string, request: RunnerRequest): Promise<void> {
    try {
      const result =
        request.kind === 'preview'
          ? await previewFile(request.input)
          : request.kind === 'auto-match'
            ? matchColumns(request.input.sources, request.input.targets)
            : planNewTable(request.input);
      this.#post({ type: 'response', requestId, result });
    } catch (error) {
      this.#post({ type: 'response', requestId, error: toErrorData(error) });
    }
  }

  #start(jobId: string, job: JobSpec, resolved: ResolvedProfile): void {
    if (this.#jobs.has(jobId)) return;
    const controller = new AbortController();
    const done = this.#run(jobId, job, resolved, controller.signal).finally(() => {
      this.#jobs.delete(jobId);
    });
    this.#jobs.set(jobId, { controller, done });
  }

  async #run(
    jobId: string,
    job: JobSpec,
    resolved: ResolvedProfile,
    signal: AbortSignal,
  ): Promise<void> {
    const started = performance.now();
    const context = (session: Session): JobContext => ({
      session,
      signal,
      readOnly: resolved.profile.presentation.readOnly,
      progress: (progress: Omit<JobProgress, 'elapsedMs'>) =>
        this.#post({
          type: 'progress',
          jobId,
          progress: { ...progress, elapsedMs: Math.round(performance.now() - started) },
        }),
      log: (level, message) => this.#post({ type: 'log', jobId, level, message }),
    });
    const finish = (outcome: JobOutcome | { error: ErrorData }): void => {
      this.#post(
        'error' in outcome
          ? { type: 'done', jobId, errors: [], error: outcome.error }
          : { type: 'done', jobId, summary: outcome.summary, errors: [...outcome.errors] },
      );
    };
    let opened: JobSession | undefined;
    let result: JobOutcome | { error: ErrorData };
    try {
      this.#post({
        type: 'progress',
        jobId,
        progress: { phase: 'Connecting', elapsedMs: 0 },
      });
      opened = await this.#deps.connect(withDatabase(resolved, job.database), jobId);
      if (signal.aborted) throw new JoineryError({ code: 'CANCELLED', message: 'Cancelled' });
      const { session } = opened;
      this.#post({
        type: 'log',
        jobId,
        level: 'info',
        message: `Connected to ${resolved.profile.name} (${session.engine} ${session.serverVersion})`,
      });
      const run = context(session);
      result =
        job.kind === 'import'
          ? await runImport(job, run)
          : job.kind === 'export'
            ? await runExport(job, run)
            : await runSqlFileJob(job, run);
    } catch (error) {
      const data: ErrorData =
        signal.aborted || cancelled(error)
          ? { code: 'CANCELLED', message: 'Cancelled' }
          : toErrorData(error);
      if (data.code !== 'CANCELLED') {
        this.#post({ type: 'log', jobId, level: 'error', message: data.message });
      }
      result = { error: data };
    }
    // The session (and its tunnel) closes before main hears the job is done, so an idle runner
    // that main shuts down has nothing left open.
    await opened?.close().catch(() => undefined);
    finish(result);
  }
}
