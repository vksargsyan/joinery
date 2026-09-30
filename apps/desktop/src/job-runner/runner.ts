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
  type RunnerJobSpec,
  type RunnerRequest,
  type RunnerToMain,
} from '../shared/job-protocol';
import type { SyncJobSpec } from '../shared/sync-jobs';
import type { SyncJobOutcome } from './sync-common';
import { answerSyncRequest, isSyncRequest, runSyncJob } from './sync-tasks';
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
import { inspectConnection, planTransferJob, runTransferJob, type Connector } from './transfer-db';
import { answerBackupRequest, connectDatabase, isBackupRequest, runBackupTask } from './backup';
import { analyzeRdbFile } from './rdb';

/**
 * The job runner's core (spec §3): runs jobs side by side, each on its own driver session,
 * and answers the wizards' quick requests. Main talks to it with the validated messages of
 * shared/job-protocol; the process entry (index.ts) only wires the parent port and the
 * session opener, so the tests drive this class directly.
 */

/** A driver session opened for one job, and how to close it (and its tunnel). */
export interface JobSession {
  readonly session: Session;
  /** The profile the session connected with, a tunnel's local end included (native tools). */
  readonly resolved?: ResolvedProfile;
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

function isSyncJob(job: RunnerJobSpec): job is SyncJobSpec {
  return (
    job.kind === 'structure-compare' ||
    job.kind === 'structure-apply' ||
    job.kind === 'data-compare' ||
    job.kind === 'data-apply'
  );
}

export class JobRunner {
  readonly #deps: JobRunnerDeps;
  readonly #jobs = new Map<string, RunningJob>();
  /** Long requests that can be cancelled (RDB analyses), by request id. */
  readonly #requestControllers = new Map<string, AbortController>();

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
        this.#start(
          message.jobId,
          message.job,
          message.resolved,
          message.source,
          message.resolvedTarget,
        );
        return;
      case 'cancel':
        this.#jobs.get(message.jobId)?.controller.abort();
        return;
      case 'request':
        void this.#answer(message.requestId, message.request);
        return;
      case 'cancel-request':
        this.#requestControllers.get(message.requestId)?.abort();
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
    // The transfer wizard's requests connect; host key questions carry the request's id.
    const connect: Connector = (resolved) => this.#deps.connect(resolved, requestId);
    try {
      if (request.kind === 'rdb-analyze') {
        const controller = new AbortController();
        this.#requestControllers.set(requestId, controller);
        try {
          const result = await analyzeRdbFile(request.input, {
            signal: controller.signal,
            onProgress: (progress) => this.#post({ type: 'request-progress', requestId, progress }),
          });
          this.#post({ type: 'response', requestId, result });
        } finally {
          this.#requestControllers.delete(requestId);
        }
        return;
      }
      if (isBackupRequest(request)) {
        const result = await answerBackupRequest(request, { connect });
        this.#post({ type: 'response', requestId, result });
        return;
      }
      const result = isSyncRequest(request)
        ? await answerSyncRequest(request)
        : request.kind === 'preview'
          ? await previewFile(request.input)
          : request.kind === 'auto-match'
            ? matchColumns(request.input.sources, request.input.targets)
            : request.kind === 'plan-table'
              ? planNewTable(request.input)
              : request.kind === 'transfer-inspect'
                ? await inspectConnection(connect, request.resolved, request.input)
                : await planTransferJob(
                    connect,
                    request.job,
                    request.resolved,
                    request.resolvedTarget,
                  );
      this.#post({ type: 'response', requestId, result });
    } catch (error) {
      this.#post({ type: 'response', requestId, error: toErrorData(error) });
    }
  }

  #start(
    jobId: string,
    job: RunnerJobSpec,
    resolved: ResolvedProfile,
    source: ResolvedProfile | undefined,
    resolvedTarget: ResolvedProfile | undefined,
  ): void {
    if (this.#jobs.has(jobId)) return;
    const controller = new AbortController();
    const run = isSyncJob(job)
      ? this.#runSync(jobId, job, resolved, source, controller.signal)
      : job.kind === 'transfer'
        ? this.#runTransfer(jobId, job, resolved, resolvedTarget, controller.signal)
        : this.#run(jobId, job, resolved, controller.signal);
    const done = run.finally(() => {
      this.#jobs.delete(jobId);
    });
    this.#jobs.set(jobId, { controller, done });
  }

  /** Progress (with the elapsed time) and log lines of one job. */
  #reporter(jobId: string, started: number): Pick<JobContext, 'progress' | 'log'> {
    return {
      progress: (progress: Omit<JobProgress, 'elapsedMs'>) =>
        this.#post({
          type: 'progress',
          jobId,
          progress: { ...progress, elapsedMs: Math.round(performance.now() - started) },
        }),
      log: (level, message) => this.#post({ type: 'log', jobId, level, message }),
    };
  }

  /**
   * A structure or data sync job (spec §13): the target session, and the source session for
   * a compare, each through its own tunnel when the profile has one. The result travels back
   * with `done` for main to keep.
   */
  async #runSync(
    jobId: string,
    job: SyncJobSpec,
    resolved: ResolvedProfile,
    source: ResolvedProfile | undefined,
    signal: AbortSignal,
  ): Promise<void> {
    const reporter = this.#reporter(jobId, performance.now());
    const opened: JobSession[] = [];
    let outcome: SyncJobOutcome | { error: ErrorData };
    try {
      this.#post({ type: 'progress', jobId, progress: { phase: 'Connecting', elapsedMs: 0 } });
      const target = await this.#deps.connect(withDatabase(resolved, job.target.database), jobId);
      opened.push(target);
      let sourceSession: JobSession | undefined;
      if (job.kind === 'structure-compare' || job.kind === 'data-compare') {
        if (!source) {
          throw new JoineryError({ code: 'INTERNAL', message: 'The source connection is missing' });
        }
        sourceSession = await this.#deps.connect(withDatabase(source, job.source.database), jobId);
        opened.push(sourceSession);
      }
      if (signal.aborted) throw new JoineryError({ code: 'CANCELLED', message: 'Cancelled' });
      for (const [profile, session] of [
        ...(sourceSession && source ? [[source.profile, sourceSession.session] as const] : []),
        [resolved.profile, target.session] as const,
      ]) {
        reporter.log(
          'info',
          `Connected to ${profile.name} (${session.engine} ${session.serverVersion})`,
        );
      }
      outcome = await runSyncJob(job, {
        target: target.session,
        targetProfile: resolved.profile,
        source: sourceSession?.session,
        sourceProfile: source?.profile,
        signal,
        ...reporter,
      });
    } catch (error) {
      const data: ErrorData =
        signal.aborted || cancelled(error)
          ? { code: 'CANCELLED', message: 'Cancelled' }
          : toErrorData(error);
      if (data.code !== 'CANCELLED') reporter.log('error', data.message);
      outcome = { error: data };
    }
    for (const session of opened.reverse()) await session.close().catch(() => undefined);
    this.#post(
      'error' in outcome
        ? { type: 'done', jobId, errors: [], error: outcome.error }
        : {
            type: 'done',
            jobId,
            summary: outcome.summary,
            errors: [...outcome.errors],
            ...(outcome.result !== undefined ? { result: outcome.result } : {}),
          },
    );
  }

  /**
   * A transfer between databases (spec §12): its sessions are opened by the pipeline, one pair
   * per table running at once, each through its profile's tunnel.
   */
  async #runTransfer(
    jobId: string,
    job: Extract<JobSpec, { kind: 'transfer' }>,
    resolved: ResolvedProfile,
    resolvedTarget: ResolvedProfile | undefined,
    signal: AbortSignal,
  ): Promise<void> {
    const started = performance.now();
    let result: JobOutcome | { error: ErrorData };
    try {
      if (resolvedTarget === undefined) {
        throw new JoineryError({
          code: 'VALIDATION_FAILED',
          message: 'The transfer has no target',
        });
      }
      this.#post({ type: 'progress', jobId, progress: { phase: 'Connecting', elapsedMs: 0 } });
      result = await runTransferJob(job, resolved, resolvedTarget, {
        connect: (profile) => this.#deps.connect(profile, jobId),
        signal,
        progress: (progress) =>
          this.#post({
            type: 'progress',
            jobId,
            progress: { ...progress, elapsedMs: Math.round(performance.now() - started) },
          }),
        log: (level, message) => this.#post({ type: 'log', jobId, level, message }),
      });
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
    this.#post(
      'error' in result
        ? { type: 'done', jobId, errors: [], error: result.error }
        : { type: 'done', jobId, summary: result.summary, errors: [...result.errors] },
    );
  }

  async #run(
    jobId: string,
    job: Exclude<JobSpec, { kind: 'transfer' }>,
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
      opened = await this.#deps.connect(withDatabase(resolved, connectDatabase(job)), jobId);
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
        job.kind === 'backup' || job.kind === 'restore'
          ? await runBackupTask(job, {
              ...run,
              resolved: opened.resolved ?? withDatabase(resolved, job.database),
              connect: (database) => this.#deps.connect(withDatabase(resolved, database), jobId),
            })
          : job.kind === 'import'
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
