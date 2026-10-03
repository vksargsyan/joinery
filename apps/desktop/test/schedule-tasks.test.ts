import {
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { JobEvent, JobInfo, JobSpec, ScheduleTask } from '@querybara/ipc';
import { openStore, type ScheduleRecord, type SecretSealer, type Store } from '@querybara/storage';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { JobManager, JobStartExtras } from '../src/main/jobs';
import { executeSchedule, passphraseRef } from '../src/main/schedule-tasks';
import type { SyncService } from '../src/main/sync';
import { profileInput } from './helpers';

/**
 * What a scheduled run does, against a fake job manager and sync service: the job it starts
 * (output named from the template, a passphrase from the secret store), the checks before it (a
 * deleted connection, a password not saved, a production write not confirmed), what it reports,
 * and the pruning after it. Comparisons write their report only when they find differences.
 */

const sealer: SecretSealer = {
  id: 'test-xor',
  isAvailable: () => true,
  seal: (plain) => new TextEncoder().encode(plain).map((b) => b ^ 0x2a),
  unseal: (sealed) => new TextDecoder().decode(sealed.map((b) => b ^ 0x2a)),
};

const cleanup: (() => void)[] = [];
afterEach(() => cleanup.splice(0).forEach((fn) => fn()));

function folder(): string {
  const path = mkdtempSync(join(tmpdir(), 'querybara-scheduled-'));
  cleanup.push(() => rmSync(path, { recursive: true, force: true }));
  return path;
}

function storeWith(overrides: Parameters<typeof profileInput>[0] = {}) {
  const store = openStore(':memory:', { sealer });
  cleanup.push(() => store.close());
  const input = profileInput(overrides);
  const profile = store.profiles.save(input);
  const auth = input.auth;
  if (auth?.method === 'password' && auth.password?.policy === 'save') {
    store.secrets.set({ id: auth.password.id, policy: 'save' }, 'secret');
  }
  return { store, profile };
}

/** A job manager whose jobs end as told, a moment after they start. */
function fakeJobs(end: Partial<JobInfo> = {}) {
  const started: { spec: JobSpec; extras: JobStartExtras }[] = [];
  const listeners = new Set<(event: JobEvent) => void>();
  const jobs = {
    start: (
      spec: JobSpec,
      resolved: { profile: { name: string } },
      description: { title: string },
      extras: JobStartExtras = {},
    ) => {
      started.push({ spec, extras });
      const info: JobInfo = {
        id: `job-${started.length}`,
        kind: spec.kind,
        title: description.title,
        profileId: spec.profileId,
        profileName: resolved.profile.name,
        state: 'running',
        cancelling: false,
        createdAt: new Date().toISOString(),
        progress: { phase: 'Starting', elapsedMs: 0 },
        errors: [],
        log: [],
        target: {},
      };
      setImmediate(() => {
        const finished: JobInfo = {
          ...info,
          state: 'completed',
          finishedAt: new Date().toISOString(),
          summary: {
            status: 'completed',
            rowsRead: 10,
            rowsWritten: 10,
            rowsSkipped: 0,
            statements: 3,
            durationMs: 5,
          },
          ...end,
        };
        extras.onDone?.(finished, undefined);
        for (const listener of listeners) listener({ type: 'job', job: finished });
      });
      return info;
    },
    subscribe: (listener: (event: JobEvent) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    get: () => undefined,
  };
  return {
    jobs: jobs as unknown as JobManager,
    started,
    emit: (job: JobInfo) => listeners.forEach((l) => l({ type: 'job', job })),
  };
}

function schedule(
  store: Store,
  profileId: string | null,
  task: ScheduleTask,
  extra: Partial<Parameters<Store['schedules']['create']>[0]> = {},
): ScheduleRecord {
  return store.schedules.create({
    name: 'Nightly',
    kind: task.kind,
    profileId,
    task,
    rule: { kind: 'interval', every: 1, unit: 'hours' },
    ...extra,
  });
}

const at = new Date(2026, 8, 30, 2, 0);

describe('scheduled runs', () => {
  it('back up to a new file named from the template, encrypted, and prune the old ones', async () => {
    const { store, profile } = storeWith();
    const dir = folder();
    for (const [i, name] of [
      'Nightly-2026-09-27-02-00.qbak',
      'Nightly-2026-09-28-02-00.qbak',
      'Nightly-2026-09-29-02-00.qbak',
    ].entries()) {
      writeFileSync(join(dir, name), '');
      const time = new Date(2026, 8, 27 + i, 2, 0);
      utimesSync(join(dir, name), time, time);
    }
    const s = schedule(store, profile.id, {
      kind: 'backup',
      job: { kind: 'backup', profileId: profile.id, database: 'shop', format: 'qbak' },
      encrypted: true,
      output: { folder: dir, fileName: '{name}-{date}-{time}.qbak', keep: 2 },
    });
    store.secrets.set(passphraseRef(s.id), 'correct horse');
    const { jobs, started } = fakeJobs();
    const outcome = await executeSchedule({ store, jobs, now: () => at }, s);

    const path = join(dir, 'Nightly-2026-09-30-02-00.qbak');
    expect(started[0]!.spec).toEqual({
      kind: 'backup',
      profileId: profile.id,
      database: 'shop',
      format: 'qbak',
      output: { path },
      encryption: { passphrase: 'correct horse' },
    });
    expect(started[0]!.extras.silent).toBe(true);
    expect(outcome).toMatchObject({ status: 'success', outputs: [path], jobId: 'job-1' });
    // The backup job did not write the file here (the runner does), so two older ones stay.
    expect(readdirSync(dir).sort()).toEqual([
      'Nightly-2026-09-28-02-00.qbak',
      'Nightly-2026-09-29-02-00.qbak',
    ]);
  });

  it('refuse to run without what they need, saying what to do', async () => {
    const dir = folder();
    const task: ScheduleTask = {
      kind: 'backup',
      job: { kind: 'backup', profileId: 'p', format: 'qbak' },
      encrypted: true,
      output: { folder: dir, fileName: '{date}.qbak', keep: null },
    };
    const { store, profile } = storeWith();
    const { jobs, started } = fakeJobs();
    const encrypted = schedule(store, profile.id, {
      ...task,
      job: { ...task.job, profileId: profile.id },
    });
    expect(await executeSchedule({ store, jobs }, encrypted)).toMatchObject({
      status: 'failed',
      message: 'The backup passphrase is not saved; edit the schedule and enter it again',
    });

    // A password asked each time cannot be asked by a scheduled run.
    const asked = storeWith({
      auth: {
        method: 'password',
        user: 'app',
        password: { id: crypto.randomUUID(), policy: 'ask' },
      },
    });
    const noPassword = schedule(asked.store, asked.profile.id, {
      ...task,
      encrypted: false,
      job: { ...task.job, profileId: asked.profile.id },
    });
    const outcome = await executeSchedule({ store: asked.store, jobs }, noPassword);
    expect(outcome.status).toBe('failed');
    expect(outcome.message).toContain('The password of Local Postgres is not saved');
    expect(outcome.message).toContain('Save it in the connection settings');

    // A connection deleted meanwhile (the schedule would have gone with it; a race).
    expect(
      await executeSchedule({ store, jobs }, { ...encrypted, profileId: 'gone' }),
    ).toMatchObject({ status: 'failed', message: 'The connection was deleted' });
    expect(started).toHaveLength(0);
  });

  it('run a SQL file as confirmed on a production connection, and report the statements', async () => {
    const { store, profile } = storeWith({ presentation: { environment: 'production' } });
    const { jobs, started } = fakeJobs();
    const job = {
      kind: 'run-sql-file' as const,
      profileId: profile.id,
      path: '/sql/refresh.sql',
      onError: 'stop' as const,
    };
    const unconfirmed = schedule(store, profile.id, { kind: 'sql', job });
    const refused = await executeSchedule({ store, jobs }, unconfirmed);
    expect(refused.status).toBe('failed');
    expect(started).toHaveLength(0);

    const confirmed = schedule(store, profile.id, {
      kind: 'sql',
      job: { ...job, confirmed: true },
    });
    const outcome = await executeSchedule({ store, jobs }, confirmed);
    expect(started[0]!.spec).toEqual({ ...job, confirmed: true });
    expect(outcome).toMatchObject({ status: 'success', outputs: [] });
    expect(outcome.message).toContain('3 statements');
  });

  it('export into a new folder for several tables, and pass on a failure', async () => {
    const { store, profile } = storeWith();
    const dir = folder();
    const s = schedule(store, profile.id, {
      kind: 'export',
      job: {
        kind: 'export',
        profileId: profile.id,
        source: { kind: 'tables', tables: ['orders', 'customers'] },
        format: 'csv',
      },
      outputKind: 'directory',
      output: { folder: dir, fileName: 'shop-{date}', keep: null },
    });
    const files = [
      join(dir, 'shop-2026-09-30', 'orders.csv'),
      join(dir, 'shop-2026-09-30', 'customers.csv'),
    ];
    const { jobs, started } = fakeJobs({
      summary: {
        status: 'completed',
        rowsRead: 2,
        rowsWritten: 2,
        rowsSkipped: 0,
        durationMs: 1,
        files,
      },
    });
    const outcome = await executeSchedule({ store, jobs, now: () => at }, s);
    expect(started[0]!.spec).toMatchObject({
      output: { kind: 'directory', path: join(dir, 'shop-2026-09-30') },
    });
    expect(statSync(join(dir, 'shop-2026-09-30')).isDirectory()).toBe(true);
    expect(outcome).toMatchObject({ status: 'success', outputs: files });

    const failing = fakeJobs({
      state: 'failed',
      error: { code: 'SQL_ERROR', message: 'relation "orders" does not exist' },
    });
    expect(await executeSchedule({ store, jobs: failing.jobs, now: () => at }, s)).toMatchObject({
      status: 'failed',
      message: 'relation "orders" does not exist',
      jobId: 'job-1',
    });
  });

  it('compare structure, writing the report only when something differs', async () => {
    const { store, profile } = storeWith();
    const other = store.profiles.save(profileInput({ name: 'Prod' }));
    store.secrets.set((other.auth as { password: { id: string; policy: 'save' } }).password, 'x');
    const comparison = store.comparisons.create({
      name: 'Dev vs prod',
      kind: 'structure',
      sourceProfileId: profile.id,
      targetProfileId: other.id,
      definition: { source: { database: 'dev' }, target: { database: 'prod' } },
    });
    const dir = folder();
    const s = store.schedules.create({
      name: 'Drift',
      kind: 'comparison',
      comparisonId: comparison.id,
      task: { kind: 'comparison', output: { folder: dir, fileName: 'drift-{date}.html', keep: 5 } },
      rule: { kind: 'interval', every: 1, unit: 'hours' },
    });
    const { jobs, emit } = fakeJobs();
    let total = 3;
    const exported = vi.fn(async () => ({ bytes: 1 }));
    const discard = vi.fn();
    const sync = {
      startStructureCompare: vi.fn((input: unknown, _resolved: unknown, options: unknown) => {
        expect(input).toMatchObject({
          source: { profileId: profile.id, database: 'dev' },
          target: { profileId: other.id, database: 'prod' },
        });
        expect(options).toEqual({ silent: true });
        setImmediate(() => emit({ id: 'cmp', state: 'completed' } as JobInfo));
        return 'cmp';
      }),
      structureResult: () => ({
        summary: { total, create: 1, alter: 2, drop: 0, rename: 0 },
        diff: {
          operations: [
            { id: 'a', selected: true },
            { id: 'b', selected: false },
          ],
        },
      }),
      exportStructure: exported,
      discard,
    } as unknown as SyncService;

    const found = await executeSchedule({ store, jobs, sync, now: () => at }, s);
    expect(found).toMatchObject({
      status: 'success',
      message: '3 differences: 1 to create, 2 to alter',
      outputs: [join(dir, 'drift-2026-09-30.html')],
      attention: true,
    });
    expect(exported).toHaveBeenCalledWith({
      jobId: 'cmp',
      selected: ['a'],
      format: 'html',
      path: join(dir, 'drift-2026-09-30.html'),
    });
    expect(discard).toHaveBeenCalledWith('cmp');

    total = 0;
    exported.mockClear();
    expect(await executeSchedule({ store, jobs, sync, now: () => at }, s)).toMatchObject({
      status: 'success',
      message: 'No differences',
      outputs: [],
    });
    expect(exported).not.toHaveBeenCalled();
    expect(existsSync(join(dir, 'drift-2026-09-30-2.html'))).toBe(false);
  });
});
