import { JoineryError, fromErrorData, newId, type ResolvedProfile } from '@joinery/core';
import type { JobEvent, JobInfo, JobLogEntry, JobState } from '@joinery/ipc';

import {
  runnerToMainSchema,
  type MainToRunner,
  type RunnerJobSpec,
  type RunnerRequest,
  type RunnerToMain,
} from '../shared/job-protocol';
import type { HostKeyVerification } from './host-keys';

/**
 * Main's side of the job runner (spec §3, §14). The runner is one Electron utility process,
 * started on demand when a job starts or a wizard asks for a preview, and shut down after it
 * has sat idle for a while. Jobs run in it side by side, each on its own driver session.
 *
 * The manager keeps each job's record (state, progress, log, summary, failed rows) and
 * publishes every change to its subscribers, which relay them to the renderer. The resolved
 * profile with its secrets goes to the runner in `start` and nowhere else: job records hold
 * none. A runner that crashes fails the jobs it was running; the next job starts a new one.
 * Finished jobs go to a short history in the local store, and a job that ran for a while
 * raises a desktop notification when it ends.
 */

/** The job runner process as main sees it: a utilityProcess in the app, a fake in tests. */
export interface JobRunnerProcess {
  send(message: MainToRunner): void;
  /** Raw messages from the runner; the manager validates them. */
  onMessage(listener: (message: unknown) => void): void;
  onExit(listener: (code: number | null) => void): void;
  kill(): void;
}

export type JobRunnerFactory = (label: string) => JobRunnerProcess;

/** Where finished jobs are kept between app runs. */
export interface JobHistoryStore {
  load(): JobInfo[];
  save(jobs: readonly JobInfo[]): void;
}

export interface JobManagerOptions {
  readonly spawn: JobRunnerFactory;
  readonly history?: JobHistoryStore;
  /** Answers the SSH host key questions of jobs' tunnels; without it every key is refused. */
  readonly hostKeys?: HostKeyVerification;
  /** Called when a job that ran at least `notifyAfterMs` finishes. */
  readonly notify?: (job: JobInfo) => void;
  readonly notifyAfterMs?: number;
  /** An idle runner (no jobs, no requests) is shut down after this long. */
  readonly idleShutdownMs?: number;
  /** How long a wizard request (preview, plan) may take. */
  readonly requestTimeoutMs?: number;
  /** Grace period for `shutdown` before the process is killed. */
  readonly shutdownGraceMs?: number;
  /** Finished jobs kept. */
  readonly historyLimit?: number;
  readonly now?: () => number;
}

/** What the job list shows about a job besides its spec. */
export interface JobDescription {
  readonly title: string;
  readonly target: JobInfo['target'];
}

/** What a sync job adds when it starts (spec §13). */
export interface JobStartExtras {
  /** A comparison's source connection; its secrets travel to the runner only. */
  readonly source?: ResolvedProfile;
  /**
   * Called once when the job ends, however it ends, with the result the runner sent with
   * `done` (sync jobs), unchecked.
   */
  readonly onDone?: (job: JobInfo, result: unknown) => void;
}

interface LiveJob {
  info: JobInfo;
  readonly startedAt: number;
  readonly onDone?: ((job: JobInfo, result: unknown) => void) | undefined;
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: JoineryError): void;
  readonly timer: ReturnType<typeof setTimeout>;
}

const MAX_LOG = 500;
const MAX_ERRORS = 1000;
/** Kept per job in the stored history. */
const HISTORY_LOG = 100;
const HISTORY_ERRORS = 200;

export class JobManager {
  readonly #spawn: JobRunnerFactory;
  readonly #historyStore: JobHistoryStore | undefined;
  readonly #hostKeys: HostKeyVerification | undefined;
  readonly #notify: ((job: JobInfo) => void) | undefined;
  readonly #notifyAfterMs: number;
  readonly #idleShutdownMs: number;
  readonly #requestTimeoutMs: number;
  readonly #shutdownGraceMs: number;
  readonly #historyLimit: number;
  readonly #now: () => number;
  readonly #running = new Map<string, LiveJob>();
  readonly #requests = new Map<string, PendingRequest>();
  readonly #listeners = new Set<(event: JobEvent) => void>();
  #history: JobInfo[];
  #process: JobRunnerProcess | undefined;
  #idleTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(options: JobManagerOptions) {
    this.#spawn = options.spawn;
    this.#historyStore = options.history;
    this.#hostKeys = options.hostKeys;
    this.#notify = options.notify;
    this.#notifyAfterMs = options.notifyAfterMs ?? 10_000;
    this.#idleShutdownMs = options.idleShutdownMs ?? 30_000;
    this.#requestTimeoutMs = options.requestTimeoutMs ?? 60_000;
    this.#shutdownGraceMs = options.shutdownGraceMs ?? 5_000;
    this.#historyLimit = options.historyLimit ?? 50;
    this.#now = options.now ?? (() => Date.now());
    let stored: JobInfo[] = [];
    try {
      stored = options.history?.load() ?? [];
    } catch {
      // An unreadable history starts empty.
    }
    this.#history = stored.slice(0, this.#historyLimit);
  }

  /** Running jobs (newest first), then finished ones. */
  list(): JobInfo[] {
    const running = [...this.#running.values()].map((job) => job.info).reverse();
    return [...running, ...this.#history];
  }

  get(jobId: string): JobInfo | undefined {
    return this.#running.get(jobId)?.info ?? this.#history.find((job) => job.id === jobId);
  }

  /** True while the runner process is up. */
  get runnerStarted(): boolean {
    return this.#process !== undefined;
  }

  subscribe(listener: (event: JobEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /**
   * Starts a job in the runner with the resolved profile (its secrets travel to the runner
   * only). Returns the job's record.
   */
  start(
    spec: RunnerJobSpec,
    resolved: ResolvedProfile,
    description: JobDescription,
    extras: JobStartExtras = {},
  ): JobInfo {
    const id = newId();
    const info: JobInfo = {
      id,
      kind: spec.kind,
      title: description.title,
      profileId: spec.profileId,
      profileName: resolved.profile.name,
      state: 'running',
      cancelling: false,
      createdAt: new Date(this.#now()).toISOString(),
      progress: { phase: 'Starting', elapsedMs: 0 },
      errors: [],
      log: [],
      target: description.target,
    };
    const job: LiveJob = { info, startedAt: this.#now(), onDone: extras.onDone };
    this.#running.set(id, job);
    this.#publish({ type: 'job', job: info });
    let process: JobRunnerProcess;
    try {
      process = this.#ensureProcess();
      process.send({
        type: 'start',
        jobId: id,
        job: spec,
        resolved,
        ...(extras.source ? { source: extras.source } : {}),
      });
    } catch (error) {
      this.#finish(job, {
        state: 'failed',
        error: new JoineryError({
          code: 'INTERNAL',
          message: 'The job runner could not start',
          ...(error instanceof Error ? { detail: error.message } : {}),
        }).toJSON(),
      });
    }
    return this.get(id) ?? info;
  }

  /** Cancels a running job; its import rolls back. Unknown and finished jobs are ignored. */
  cancel(jobId: string): void {
    const job = this.#running.get(jobId);
    if (!job || job.info.cancelling) return;
    this.#update(job, { cancelling: true });
    this.#addLog(job, 'warning', 'Cancelling…');
    try {
      this.#process?.send({ type: 'cancel', jobId });
    } catch {
      // The runner is gone; its exit fails the job.
    }
  }

  /** Asks the runner for a wizard's quick work (preview, auto-match, new table plan). */
  request(request: RunnerRequest): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const requestId = newId();
      const timer = setTimeout(() => {
        this.#requests.delete(requestId);
        reject(new JoineryError({ code: 'TIMEOUT', message: 'The job runner did not answer' }));
        this.#scheduleIdle();
      }, this.#requestTimeoutMs);
      this.#requests.set(requestId, { resolve, reject, timer });
      try {
        this.#ensureProcess().send({ type: 'request', requestId, request });
      } catch (error) {
        clearTimeout(timer);
        this.#requests.delete(requestId);
        reject(
          new JoineryError({
            code: 'INTERNAL',
            message: 'The job runner could not start',
            ...(error instanceof Error ? { detail: error.message } : {}),
          }),
        );
      }
    });
  }

  /** Forgets finished jobs. */
  clearFinished(): void {
    const removed = this.#history.splice(0);
    this.#saveHistory();
    for (const job of removed) this.#publish({ type: 'removed', jobId: job.id });
  }

  /**
   * Stops the runner (app quit): running jobs are cancelled and recorded as interrupted, and
   * the process gets a grace period to roll back before it is killed.
   */
  shutdown(): void {
    for (const job of [...this.#running.values()]) {
      this.#finish(job, {
        state: 'cancelled',
        error: { code: 'CANCELLED', message: 'Joinery quit while the job was running' },
      });
    }
    for (const [id, pending] of [...this.#requests]) {
      clearTimeout(pending.timer);
      this.#requests.delete(id);
      pending.reject(new JoineryError({ code: 'CANCELLED', message: 'Joinery is quitting' }));
    }
    this.#stopProcess();
  }

  #ensureProcess(): JobRunnerProcess {
    if (this.#idleTimer) clearTimeout(this.#idleTimer);
    this.#idleTimer = undefined;
    if (this.#process) return this.#process;
    const process = this.#spawn('Joinery job runner');
    this.#process = process;
    process.onMessage((raw) => this.#onMessage(process, raw));
    process.onExit((code) => this.#onExit(process, code));
    return process;
  }

  #stopProcess(): void {
    const process = this.#process;
    this.#process = undefined;
    if (this.#idleTimer) clearTimeout(this.#idleTimer);
    this.#idleTimer = undefined;
    if (!process) return;
    try {
      process.send({ type: 'shutdown' });
    } catch {
      // Already gone.
    }
    setTimeout(() => process.kill(), this.#shutdownGraceMs).unref?.();
  }

  #scheduleIdle(): void {
    if (this.#running.size > 0 || this.#requests.size > 0 || !this.#process) return;
    if (this.#idleTimer) clearTimeout(this.#idleTimer);
    this.#idleTimer = setTimeout(() => {
      this.#idleTimer = undefined;
      if (this.#running.size === 0 && this.#requests.size === 0) this.#stopProcess();
    }, this.#idleShutdownMs);
    this.#idleTimer.unref?.();
  }

  #onMessage(process: JobRunnerProcess, raw: unknown): void {
    if (this.#process !== process) return;
    const parsed = runnerToMainSchema.safeParse(raw);
    if (!parsed.success) return;
    const message = parsed.data;
    switch (message.type) {
      case 'progress': {
        const job = this.#running.get(message.jobId);
        if (!job) return;
        job.info = { ...job.info, progress: message.progress };
        this.#publish({ type: 'progress', jobId: message.jobId, progress: message.progress });
        return;
      }
      case 'log': {
        const job = this.#running.get(message.jobId);
        if (job) this.#addLog(job, message.level, message.message);
        return;
      }
      case 'done':
        this.#done(message);
        return;
      case 'response': {
        const pending = this.#requests.get(message.requestId);
        if (!pending) return;
        this.#requests.delete(message.requestId);
        clearTimeout(pending.timer);
        if (message.error) pending.reject(fromErrorData(message.error));
        else pending.resolve(message.result);
        this.#scheduleIdle();
        return;
      }
      case 'host-key':
        void this.#answerHostKey(process, message);
        return;
    }
  }

  async #answerHostKey(
    process: JobRunnerProcess,
    request: Extract<RunnerToMain, { type: 'host-key' }>,
  ): Promise<void> {
    const job = this.#running.get(request.jobId);
    const { requestId, host, port, key } = request;
    const verdict = this.#hostKeys
      ? await this.#hostKeys.verify(
          { requestId, host, port, key },
          { profileName: job?.info.profileName ?? 'a job', purpose: 'connect' },
        )
      : {
          decision: 'reject' as const,
          error: { code: 'SSH_FAILED' as const, message: 'SSH host keys cannot be checked here' },
        };
    if (this.#process !== process) return;
    try {
      process.send({
        type: 'host-key-decision',
        requestId,
        decision: verdict.decision,
        ...(verdict.error ? { error: verdict.error } : {}),
      });
    } catch {
      // The runner is gone; its exit fails the job.
    }
  }

  #done(message: Extract<RunnerToMain, { type: 'done' }>): void {
    const job = this.#running.get(message.jobId);
    if (!job) return;
    const state: JobState =
      message.summary?.status ?? (message.error?.code === 'CANCELLED' ? 'cancelled' : 'failed');
    this.#finish(
      job,
      {
        state,
        ...(message.summary ? { summary: message.summary } : {}),
        ...(message.error ? { error: message.error } : {}),
        errors: message.errors.slice(0, MAX_ERRORS),
      },
      message.result,
    );
  }

  #onExit(process: JobRunnerProcess, code: number | null): void {
    if (this.#process !== process) return;
    this.#process = undefined;
    if (this.#idleTimer) clearTimeout(this.#idleTimer);
    this.#idleTimer = undefined;
    const message =
      code === null
        ? 'The job runner stopped unexpectedly'
        : `The job runner exited unexpectedly (code ${code})`;
    for (const job of [...this.#running.values()]) {
      this.#finish(job, { state: 'failed', error: { code: 'INTERNAL', message } });
    }
    for (const [id, pending] of [...this.#requests]) {
      clearTimeout(pending.timer);
      this.#requests.delete(id);
      pending.reject(new JoineryError({ code: 'INTERNAL', message }));
    }
  }

  #finish(
    job: LiveJob,
    outcome: Pick<JobInfo, 'state'> & Partial<Pick<JobInfo, 'summary' | 'error' | 'errors'>>,
    result?: unknown,
  ): void {
    if (!this.#running.delete(job.info.id)) return;
    if (outcome.state === 'failed' && outcome.error && job.info.log.at(-1)?.level !== 'error') {
      this.#addLog(job, 'error', outcome.error.message);
    }
    if (outcome.state === 'cancelled') this.#addLog(job, 'warning', 'Cancelled');
    const finished: JobInfo = {
      ...job.info,
      state: outcome.state,
      cancelling: false,
      finishedAt: new Date(this.#now()).toISOString(),
      ...(outcome.summary ? { summary: outcome.summary } : {}),
      ...(outcome.error ? { error: outcome.error } : {}),
      errors: outcome.errors ?? job.info.errors,
    };
    this.#history = [finished, ...this.#history].slice(0, this.#historyLimit);
    this.#saveHistory();
    // The result is in place before the page hears the job finished and asks for it.
    try {
      job.onDone?.(finished, result);
    } catch {
      // A result that cannot be kept fails its reader, not the job list.
    }
    this.#publish({ type: 'job', job: finished });
    if (this.#notify && this.#now() - job.startedAt >= this.#notifyAfterMs) {
      try {
        this.#notify(finished);
      } catch {
        // A notification that cannot show changes nothing.
      }
    }
    this.#scheduleIdle();
  }

  #update(job: LiveJob, patch: Partial<JobInfo>): void {
    job.info = { ...job.info, ...patch };
    this.#publish({ type: 'job', job: job.info });
  }

  #addLog(job: LiveJob, level: JobLogEntry['level'], message: string): void {
    const entry: JobLogEntry = { at: new Date(this.#now()).toISOString(), level, message };
    job.info = { ...job.info, log: [...job.info.log, entry].slice(-MAX_LOG) };
    this.#publish({ type: 'log', jobId: job.info.id, entry });
  }

  #saveHistory(): void {
    if (!this.#historyStore) return;
    try {
      this.#historyStore.save(
        this.#history.map((job) => ({
          ...job,
          log: job.log.slice(-HISTORY_LOG),
          errors: job.errors.slice(0, HISTORY_ERRORS),
        })),
      );
    } catch {
      // History is a convenience; a failed write must not fail the job.
    }
  }

  #publish(event: JobEvent): void {
    for (const listener of [...this.#listeners]) {
      try {
        listener(event);
      } catch {
        // A broken subscriber must not stop the others.
      }
    }
  }
}

/** Every job first, then each change, until the caller stops (the renderer's job list). */
export async function* jobEvents(
  manager: JobManager,
  signal: AbortSignal,
): AsyncGenerator<JobEvent> {
  const queue: JobEvent[] = manager
    .list()
    .reverse()
    .map((job) => ({ type: 'job', job }) as const);
  let wake: (() => void) | undefined;
  const unsubscribe = manager.subscribe((event) => {
    // Progress comes often; only the latest per job needs to wait in the queue.
    if (event.type === 'progress') {
      const at = queue.findIndex((e) => e.type === 'progress' && e.jobId === event.jobId);
      if (at >= 0) queue.splice(at, 1);
    }
    queue.push(event);
    wake?.();
  });
  const onAbort = (): void => wake?.();
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    while (!signal.aborted) {
      const next = queue.shift();
      if (next !== undefined) {
        yield next;
        continue;
      }
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
      wake = undefined;
    }
  } finally {
    unsubscribe();
    signal.removeEventListener('abort', onAbort);
  }
}
