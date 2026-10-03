import { connectionProfileSchema, type ResolvedProfile } from '@querybara/core';
import type { JobEvent, JobInfo, JobSpec } from '@querybara/ipc';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { HostKeyVerification } from '../src/main/host-keys';
import {
  JobManager,
  jobEvents,
  type JobHistoryStore,
  type JobManagerOptions,
  type JobRunnerProcess,
} from '../src/main/jobs';
import type { MainToRunner } from '../src/shared/job-protocol';
import { profileInput } from './helpers';

/**
 * The JobManager (spec §3, §14) with a fake job runner process: it starts the runner on demand
 * and hands it the resolved profile, relays progress and logs, records summaries in the
 * history, cancels, fails the jobs of a crashed runner, answers the wizards' requests, shuts an
 * idle runner down, and notifies about long jobs. Nothing it publishes holds a secret.
 */

const SECRET = 'hunter2-manager';

class FakeRunner implements JobRunnerProcess {
  readonly sent: MainToRunner[] = [];
  killed = false;
  readonly #message: ((message: unknown) => void)[] = [];
  readonly #exit: ((code: number | null) => void)[] = [];

  send(message: MainToRunner): void {
    this.sent.push(message);
  }
  onMessage(listener: (message: unknown) => void): void {
    this.#message.push(listener);
  }
  onExit(listener: (code: number | null) => void): void {
    this.#exit.push(listener);
  }
  kill(): void {
    if (this.killed) return;
    this.killed = true;
    this.exit(null);
  }
  emit(message: unknown): void {
    for (const listener of this.#message) listener(message);
  }
  exit(code: number | null): void {
    for (const listener of this.#exit.splice(0)) listener(code);
  }
  ofType<T extends MainToRunner['type']>(type: T): Extract<MainToRunner, { type: T }>[] {
    return this.sent.filter((m): m is Extract<MainToRunner, { type: T }> => m.type === type);
  }
}

const resolved: ResolvedProfile = {
  profile: connectionProfileSchema.parse(profileInput({ id: 'p1', name: 'Shop' })),
  secrets: { s1: SECRET },
};

const spec: JobSpec = {
  kind: 'import',
  profileId: 'p1',
  file: { path: '/data/people.csv', format: 'csv' },
  table: { schema: 'public', name: 'people' },
  mapping: [{ source: 'id', target: 'id' }],
  mode: 'append',
};

const description = { title: 'Import people.csv into public.people', target: { table: 'people' } };

function setup(options: Partial<JobManagerOptions> = {}) {
  const runners: FakeRunner[] = [];
  const saved: JobInfo[][] = [];
  const history: JobHistoryStore = {
    load: () => [],
    save: (jobs) => saved.push(structuredClone([...jobs])),
  };
  let now = 1_000_000;
  const manager = new JobManager({
    spawn: () => {
      const runner = new FakeRunner();
      runners.push(runner);
      return runner;
    },
    history,
    idleShutdownMs: 1_000,
    shutdownGraceMs: 50,
    requestTimeoutMs: 5_000,
    now: () => now,
    ...options,
  });
  const events: JobEvent[] = [];
  manager.subscribe((event) => events.push(event));
  return {
    manager,
    runners,
    saved,
    events,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('JobManager', () => {
  it('starts the runner on demand and sends it the job with the resolved profile', () => {
    const { manager, runners, events } = setup();
    expect(manager.runnerStarted).toBe(false);
    const job = manager.start(spec, resolved, description);
    expect(runners).toHaveLength(1);
    const start = runners[0]!.ofType('start')[0]!;
    expect(start).toMatchObject({ jobId: job.id, job: spec });
    expect(start.resolved.secrets).toEqual({ s1: SECRET });
    expect(job).toMatchObject({
      state: 'running',
      title: description.title,
      profileName: 'Shop',
      kind: 'import',
    });
    expect(events[0]).toEqual({ type: 'job', job });
    // A second job shares the running process.
    manager.start(spec, resolved, description);
    expect(runners).toHaveLength(1);
    expect(runners[0]!.ofType('start')).toHaveLength(2);
    expect(JSON.stringify(events)).not.toContain(SECRET);
    expect(JSON.stringify(manager.list())).not.toContain(SECRET);
  });

  it('relays progress and logs, then records the summary in the history', () => {
    const notify = vi.fn();
    const { manager, runners, events, saved, advance } = setup({ notify, notifyAfterMs: 5_000 });
    const job = manager.start(spec, resolved, description);
    const runner = runners[0]!;
    const progress = {
      phase: 'Importing',
      rowsWritten: 500,
      bytes: 10,
      totalBytes: 20,
      elapsedMs: 300,
    };
    runner.emit({ type: 'progress', jobId: job.id, progress });
    runner.emit({ type: 'log', jobId: job.id, level: 'info', message: 'Connected to Shop' });
    expect(events).toContainEqual({ type: 'progress', jobId: job.id, progress });
    expect(manager.get(job.id)?.progress).toEqual(progress);
    expect(manager.get(job.id)?.log.map((l) => l.message)).toEqual(['Connected to Shop']);

    advance(6_000);
    const summary = {
      status: 'completed' as const,
      rowsRead: 1000,
      rowsWritten: 999,
      rowsSkipped: 1,
      durationMs: 6000,
    };
    runner.emit({
      type: 'done',
      jobId: job.id,
      summary,
      errors: [{ row: 7, line: 8, column: 'id', message: 'id: not a number' }],
    });
    const finished = manager.get(job.id)!;
    expect(finished).toMatchObject({ state: 'completed', summary });
    expect(finished.errors).toEqual([
      { row: 7, line: 8, column: 'id', message: 'id: not a number' },
    ]);
    expect(finished.finishedAt).toBeDefined();
    expect(saved.at(-1)?.map((j) => j.id)).toEqual([job.id]);
    expect(events.at(-1)).toEqual({ type: 'job', job: finished });
    expect(notify).toHaveBeenCalledWith(finished);
  });

  it('does not notify about a quick job', () => {
    const notify = vi.fn();
    const { manager, runners } = setup({ notify, notifyAfterMs: 10_000 });
    const job = manager.start(spec, resolved, description);
    runners[0]!.emit({
      type: 'done',
      jobId: job.id,
      summary: { status: 'completed', rowsRead: 1, rowsWritten: 1, rowsSkipped: 0, durationMs: 5 },
      errors: [],
    });
    expect(notify).not.toHaveBeenCalled();
  });

  it('cancels a job through the runner and records it as cancelled', () => {
    const { manager, runners } = setup();
    const job = manager.start(spec, resolved, description);
    manager.cancel(job.id);
    expect(runners[0]!.ofType('cancel')).toEqual([{ type: 'cancel', jobId: job.id }]);
    expect(manager.get(job.id)?.cancelling).toBe(true);
    manager.cancel(job.id);
    expect(runners[0]!.ofType('cancel')).toHaveLength(1);
    runners[0]!.emit({
      type: 'done',
      jobId: job.id,
      summary: {
        status: 'cancelled',
        rowsRead: 10,
        rowsWritten: 0,
        rowsSkipped: 0,
        durationMs: 50,
      },
      errors: [],
    });
    expect(manager.get(job.id)).toMatchObject({ state: 'cancelled', cancelling: false });
    expect(manager.get(job.id)?.log.map((l) => l.message)).toEqual(['Cancelling…', 'Cancelled']);
  });

  it('fails the running jobs of a crashed runner and starts a new one for the next job', () => {
    const { manager, runners } = setup();
    const first = manager.start(spec, resolved, description);
    const second = manager.start(spec, resolved, description);
    runners[0]!.exit(null);
    for (const id of [first.id, second.id]) {
      expect(manager.get(id)).toMatchObject({
        state: 'failed',
        error: { code: 'INTERNAL', message: 'The job runner stopped unexpectedly' },
      });
    }
    expect(manager.runnerStarted).toBe(false);
    manager.start(spec, resolved, description);
    expect(runners).toHaveLength(2);
  });

  it('ends a job that failed before any work with its error', () => {
    const { manager, runners } = setup();
    const job = manager.start(spec, resolved, description);
    runners[0]!.emit({
      type: 'done',
      jobId: job.id,
      errors: [],
      error: { code: 'AUTH_FAILED', message: 'password authentication failed' },
    });
    expect(manager.get(job.id)).toMatchObject({
      state: 'failed',
      error: { code: 'AUTH_FAILED', message: 'password authentication failed' },
    });
    expect(manager.get(job.id)?.log.at(-1)?.message).toBe('password authentication failed');
  });

  it('answers requests through the runner and shuts an idle runner down', async () => {
    const { manager, runners } = setup();
    const answer = manager.request({
      kind: 'auto-match',
      input: { sources: ['a'], targets: ['a'] },
    });
    const runner = runners[0]!;
    const request = runner.ofType('request')[0]!;
    runner.emit({
      type: 'response',
      requestId: request.requestId,
      result: [{ source: 'a', target: 'a' }],
    });
    await expect(answer).resolves.toEqual([{ source: 'a', target: 'a' }]);

    const failing = manager.request({
      kind: 'preview',
      input: { path: '/nope.csv' },
    });
    runner.emit({
      type: 'response',
      requestId: runner.ofType('request')[1]!.requestId,
      error: { code: 'NOT_FOUND', message: '/nope.csv does not exist' },
    });
    await expect(failing).rejects.toMatchObject({ code: 'NOT_FOUND' });

    vi.advanceTimersByTime(999);
    expect(runner.ofType('shutdown')).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(runner.ofType('shutdown')).toHaveLength(1);
    vi.advanceTimersByTime(50);
    expect(runner.killed).toBe(true);
    expect(manager.runnerStarted).toBe(false);
  });

  it('keeps the runner while a job runs', () => {
    const { manager, runners } = setup();
    manager.start(spec, resolved, description);
    vi.advanceTimersByTime(60_000);
    expect(runners[0]!.ofType('shutdown')).toHaveLength(0);
  });

  it('times out a request the runner never answers', async () => {
    const { manager } = setup({ requestTimeoutMs: 100 });
    const answer = manager.request({ kind: 'preview', input: { path: '/slow.csv' } });
    vi.advanceTimersByTime(100);
    await expect(answer).rejects.toMatchObject({ code: 'TIMEOUT' });
  });

  it('runs a long request with progress, no time limit and cancel', async () => {
    const { manager, runners } = setup({ requestTimeoutMs: 100 });
    const controller = new AbortController();
    const progress: unknown[] = [];
    const answer = manager.request(
      { kind: 'rdb-analyze', input: { path: '/data/dump.rdb' } },
      { timeoutMs: null, signal: controller.signal, onProgress: (p) => progress.push(p) },
    );
    const runner = runners[0]!;
    const { requestId } = runner.ofType('request')[0]!;
    runner.emit({ type: 'request-progress', requestId, progress: { bytes: 10, total: 100 } });
    expect(progress).toEqual([{ bytes: 10, total: 100 }]);
    // Well past the usual limit, it still waits.
    vi.advanceTimersByTime(60_000);
    expect(runner.ofType('cancel-request')).toHaveLength(0);
    controller.abort();
    expect(runner.ofType('cancel-request')).toEqual([{ type: 'cancel-request', requestId }]);
    runner.emit({
      type: 'response',
      requestId,
      error: { code: 'CANCELLED', message: 'Analysis cancelled' },
    });
    await expect(answer).rejects.toMatchObject({ code: 'CANCELLED' });
    // The runner is idle again, so it shuts down.
    vi.advanceTimersByTime(1_000);
    expect(runner.ofType('shutdown')).toHaveLength(1);
  });

  it('asks about SSH host keys of a job with its profile name', async () => {
    const verify = vi.fn<HostKeyVerification['verify']>(async () => ({
      decision: 'trust' as const,
    }));
    const { manager, runners } = setup({ hostKeys: { verify } });
    const job = manager.start(spec, resolved, description);
    const key = { algorithm: 'ssh-ed25519', fingerprintSha256: 'SHA256:abc' };
    runners[0]!.emit({
      type: 'host-key',
      requestId: 'k1',
      jobId: job.id,
      host: 'bastion',
      port: 22,
      key,
    });
    await vi.waitFor(() => expect(runners[0]!.ofType('host-key-decision')).toHaveLength(1));
    expect(verify).toHaveBeenCalledWith(
      { requestId: 'k1', host: 'bastion', port: 22, key },
      { profileName: 'Shop', purpose: 'connect' },
    );
    expect(runners[0]!.ofType('host-key-decision')[0]).toEqual({
      type: 'host-key-decision',
      requestId: 'k1',
      decision: 'trust',
    });
  });

  it('ignores messages that do not match the protocol', () => {
    const { manager, runners, events } = setup();
    const job = manager.start(spec, resolved, description);
    const before = events.length;
    runners[0]!.emit({ type: 'done', jobId: job.id });
    runners[0]!.emit({ type: 'progress', jobId: job.id, progress: { phase: 1 } });
    runners[0]!.emit('nonsense');
    expect(events).toHaveLength(before);
    expect(manager.get(job.id)?.state).toBe('running');
  });

  it('clears the finished jobs and records interrupted ones when the app quits', () => {
    const history: JobInfo[] = [];
    const { manager, runners, events } = setup({
      history: { load: () => history, save: (jobs) => history.splice(0, history.length, ...jobs) },
    });
    const done = manager.start(spec, resolved, description);
    runners[0]!.emit({
      type: 'done',
      jobId: done.id,
      summary: { status: 'completed', rowsRead: 1, rowsWritten: 1, rowsSkipped: 0, durationMs: 1 },
      errors: [],
    });
    manager.clearFinished();
    expect(manager.list()).toEqual([]);
    expect(events.at(-1)).toEqual({ type: 'removed', jobId: done.id });
    const running = manager.start(spec, resolved, description);
    manager.shutdown();
    expect(manager.get(running.id)).toMatchObject({
      state: 'cancelled',
      error: { message: 'Querybara quit while the job was running' },
    });
    expect(runners[0]!.ofType('shutdown')).toHaveLength(1);
    expect(history.map((j) => j.id)).toEqual([running.id]);
  });

  it('loads the stored history and lists running jobs first', () => {
    const stored: JobInfo = {
      id: 'old',
      kind: 'export',
      title: 'Export people to CSV',
      profileId: 'p1',
      profileName: 'Shop',
      state: 'completed',
      cancelling: false,
      createdAt: '2026-09-28T10:00:00.000Z',
      finishedAt: '2026-09-28T10:01:00.000Z',
      errors: [],
      log: [],
      target: {},
    };
    const { manager } = setup({ history: { load: () => [stored], save: () => undefined } });
    const job = manager.start(spec, resolved, description);
    expect(manager.list().map((j) => j.id)).toEqual([job.id, 'old']);
  });
});

describe('jobEvents', () => {
  it('replays every job, then streams changes, keeping only the latest progress', async () => {
    vi.useRealTimers();
    const { manager, runners } = setup();
    const job = manager.start(spec, resolved, description);
    const controller = new AbortController();
    const stream = jobEvents(manager, controller.signal);
    expect((await stream.next()).value).toMatchObject({ type: 'job', job: { id: job.id } });
    for (const rows of [1, 2, 3]) {
      runners[0]!.emit({
        type: 'progress',
        jobId: job.id,
        progress: { phase: 'Importing', rowsWritten: rows, elapsedMs: rows },
      });
    }
    expect((await stream.next()).value).toMatchObject({
      type: 'progress',
      progress: { rowsWritten: 3 },
    });
    controller.abort();
    await stream.return(undefined);
  });
});
