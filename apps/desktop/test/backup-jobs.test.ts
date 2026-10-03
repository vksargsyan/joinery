import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MessageChannel } from 'node:worker_threads';

import { ArchiveWriter } from '@querybara/backup';
import {
  connectionProfileSchema,
  type ConnectionProfileInput,
  type ResolvedProfile,
} from '@querybara/core';
import {
  createClient,
  fromNodePort,
  mainContract,
  serve,
  type BackupJob,
  type Client,
  type JobInfo,
  type MainContract,
  type RestoreJob,
} from '@querybara/ipc';
import { openStore, type SecretSealer } from '@querybara/storage';
import { fileSink } from '@querybara/transfer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { checkBackupJob } from '../src/job-runner/backup';
import { JobRunner } from '../src/job-runner/runner';
import { createMainHandlers } from '../src/main/api';
import { JobManager, type JobRunnerProcess } from '../src/main/jobs';
import { describeJob, notificationFor, settingsJobHistory } from '../src/main/jobs-api';
import { ConnectionSupervisor } from '../src/main/supervisor';
import type { MainToRunner, RunnerToMain } from '../src/shared/job-protocol';
import { FakeJobSession } from './fake-job-session';
import { fakeHosts, profileInput } from './helpers';

/**
 * Backup and restore jobs in main and the job runner (spec §14): a backup writes only where
 * the save dialog pointed and a restore reads only a picked file; restores follow the write
 * rules whatever the page sends; the passphrase goes to the job runner and never comes back in
 * a job record, the history or an event; the runner reads a file's manifest (unlocking an
 * encrypted one with its passphrase) and checks the options that only work together.
 */

const SECRET = 'hunter2-backup-Sup3r';
const PASSPHRASE = 'correct horse battery';

const sealer: SecretSealer = {
  id: 'test-xor',
  isAvailable: () => true,
  seal: (plain) => new TextEncoder().encode(plain).map((b) => b ^ 0x2a),
  unseal: (sealed) => new TextDecoder().decode(sealed.map((b) => b ^ 0x2a)),
};

let dir = '';
const cleanup: (() => void)[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'querybara-backup-jobs-'));
});

afterEach(() => {
  for (const close of cleanup.splice(0)) close();
  rmSync(dir, { recursive: true, force: true });
});

/** A job runner that finishes every job at once and answers the wizards' requests. */
class AnsweringRunner implements JobRunnerProcess {
  readonly sent: MainToRunner[] = [];
  #listener: (message: unknown) => void = () => undefined;

  send(message: MainToRunner): void {
    this.sent.push(message);
    setImmediate(() => {
      if (message.type === 'start') {
        this.#listener({
          type: 'done',
          jobId: message.jobId,
          summary: {
            status: 'completed',
            rowsRead: 3,
            rowsWritten: 3,
            rowsSkipped: 0,
            durationMs: 4,
          },
          errors: [],
        });
      } else if (message.type === 'request') {
        const kind = message.request.kind;
        this.#listener({
          type: 'response',
          requestId: message.requestId,
          result:
            kind === 'restore-plan'
              ? {
                  format: 'qbak',
                  objects: ['table:public.orders'],
                  added: [],
                  skipped: [],
                  conflicts: [],
                  warnings: [],
                }
              : kind === 'backup-inspect'
                ? { format: 'qbak', size: 10, encrypted: true }
                : [],
        });
      }
    });
  }
  onMessage(listener: (message: unknown) => void): void {
    this.#listener = listener;
  }
  onExit(): void {}
  kill(): void {}
}

function setup(dialogs: { open?: string; save?: string } = {}) {
  const store = openStore(':memory:', { sealer });
  const runners: AnsweringRunner[] = [];
  const jobs = new JobManager({
    spawn: () => {
      const runner = new AnsweringRunner();
      runners.push(runner);
      return runner;
    },
    history: settingsJobHistory(store),
  });
  const hosts = fakeHosts();
  const handlers = createMainHandlers<string>(
    {
      store,
      supervisor: new ConnectionSupervisor<string>({ spawn: hosts.spawn }),
      spawnHost: hosts.spawn,
      createChannel: () => ({ local: 'l', remote: 'r' }),
      appInfo: () => ({
        name: 'Querybara',
        version: '0.1.0',
        platform: 'linux',
        arch: 'x64',
        versions: { node: '24' },
      }),
      openExternal: async () => {},
      jobs,
    },
    {
      sendPort: () => undefined,
      openFile: async () => dialogs.open ?? null,
      saveFile: async () => dialogs.save ?? null,
      openDirectory: async () => null,
    },
  );
  const channel = new MessageChannel();
  cleanup.push(() => {
    channel.port1.close();
    channel.port2.close();
    store.close();
  });
  serve(fromNodePort(channel.port2), mainContract, handlers);
  const received: unknown[] = [];
  const port = fromNodePort(channel.port1);
  const main: Client<MainContract['shape']> = createClient(
    {
      ...port,
      onMessage: (listener) =>
        port.onMessage((data) => {
          received.push(data);
          listener(data);
        }),
    },
    mainContract,
  );
  /** Whether the renderer ever received the connection secret or the archive passphrase. */
  const leaked = (): boolean => {
    const text = JSON.stringify(received);
    return text.includes(SECRET) || text.includes(PASSPHRASE);
  };
  return { store, main, runners, leaked };
}

async function saveProfile(
  main: Client<MainContract['shape']>,
  overrides: Partial<ConnectionProfileInput> = {},
) {
  const passwordId = crypto.randomUUID();
  const saved = await main.profiles.save({
    profile: profileInput({
      auth: { method: 'password', user: 'app', password: { id: passwordId, policy: 'save' } },
      ...overrides,
    }),
  });
  await main.secrets.set({ profileId: saved.id, refId: passwordId, value: SECRET });
  return saved;
}

const presentation = (patch: Partial<NonNullable<ConnectionProfileInput['presentation']>>) => ({
  presentation: {
    folderId: null,
    tags: [],
    environment: 'dev' as const,
    readOnly: false,
    confirmWrites: false,
    ...patch,
  },
});

function backupJob(profileId: string, overrides: Partial<BackupJob> = {}): BackupJob {
  return {
    kind: 'backup',
    profileId,
    database: 'shop',
    format: 'qbak',
    output: { path: '/backups/shop.qbak' },
    encryption: { passphrase: PASSPHRASE },
    ...overrides,
  };
}

function restoreJob(profileId: string, overrides: Partial<RestoreJob> = {}): RestoreJob {
  return {
    kind: 'restore',
    profileId,
    database: 'shop_copy',
    path: '/backups/shop.qbak',
    passphrase: PASSPHRASE,
    onError: 'stop',
    ...overrides,
  };
}

async function settled(main: Client<MainContract['shape']>, jobId: string): Promise<JobInfo> {
  return vi.waitFor(async () => {
    const job = (await main.jobs.list()).find((j) => j.id === jobId);
    if (!job || job.state === 'running') throw new Error('still running');
    return job;
  });
}

describe('backup and restore jobs in main', () => {
  it('backs up to the saved file only, and never hands the passphrase back', async () => {
    const { main, runners, store, leaked } = setup({ save: '/backups/shop.qbak' });
    const profile = await saveProfile(main);
    await expect(main.jobs.start({ job: backupJob(profile.id) })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      message: 'shop.qbak was not chosen in a file dialog',
    });
    await main.dialogs.saveFile({ defaultName: 'shop.qbak' });
    const { jobId } = await main.jobs.start({ job: backupJob(profile.id) });
    const job = await settled(main, jobId);
    expect(job).toMatchObject({
      kind: 'backup',
      title: 'Back up shop to shop.qbak',
      target: { file: '/backups/shop.qbak', format: 'Querybara archive', database: 'shop' },
    });
    const start = runners[0]!.sent.find((m) => m.type === 'start');
    expect(start?.type === 'start' && start.job).toMatchObject({
      encryption: { passphrase: PASSPHRASE },
    });
    expect(JSON.stringify(store.settings.get('jobs.history', z.unknown()))).not.toContain(
      PASSPHRASE,
    );
    expect(leaked()).toBe(false);
  });

  it('restores only a picked file and follows the write rules whatever the page sends', async () => {
    const { main, runners } = setup({ open: '/backups/shop.qbak' });
    const dev = await saveProfile(main);
    await expect(main.jobs.start({ job: restoreJob(dev.id) })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    await expect(main.backup.inspect({ path: '/backups/shop.qbak' })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    await main.dialogs.openFile({});
    expect(await main.backup.inspect({ path: '/backups/shop.qbak' })).toMatchObject({
      format: 'qbak',
      encrypted: true,
    });

    const readOnly = await saveProfile(main, presentation({ readOnly: true }));
    await expect(
      main.jobs.start({ job: restoreJob(readOnly.id, { confirmed: true }) }),
    ).rejects.toMatchObject({ code: 'READ_ONLY' });
    // Backing up a read-only connection reads only.
    const production = await saveProfile(
      main,
      presentation({ environment: 'production', readOnly: true }),
    );
    await expect(main.jobs.start({ job: restoreJob(production.id) })).rejects.toMatchObject({
      code: 'READ_ONLY',
    });

    const live = await saveProfile(main, presentation({ environment: 'production' }));
    await expect(main.jobs.start({ job: restoreJob(live.id) })).rejects.toMatchObject({
      code: 'CONFIRMATION_REQUIRED',
    });
    await main.jobs.start({ job: restoreJob(live.id, { confirmed: true }) });
    await main.jobs.start({ job: restoreJob(dev.id) });
    expect(runners.flatMap((r) => r.sent).filter((m) => m.type === 'start')).toHaveLength(2);
  });

  it('plans a restore in the job runner with the resolved profile', async () => {
    const { main, runners, leaked } = setup({ open: '/backups/shop.qbak' });
    const profile = await saveProfile(main);
    await main.dialogs.openFile({});
    const plan = await main.backup.planRestore({ job: restoreJob(profile.id) });
    expect(plan.objects).toEqual(['table:public.orders']);
    const request = runners[0]!.sent.find((m) => m.type === 'request');
    expect(request?.type === 'request' && request.request).toMatchObject({
      kind: 'restore-plan',
      input: { passphrase: PASSPHRASE },
    });
    expect(
      request?.type === 'request' &&
        request.request.kind === 'restore-plan' &&
        Object.values(request.request.resolved.secrets),
    ).toContain(SECRET);
    expect(await main.backup.nativeTools()).toEqual([]);
    expect(leaked()).toBe(false);
  });

  it('backs up MongoDB and Redis connections too', async () => {
    const { main } = setup({ save: '/backups/keys.qbak' });
    const redis = await saveProfile(main, {
      engine: 'redis',
      endpoint: { kind: 'host', host: 'localhost', port: 6379 },
    });
    await main.dialogs.saveFile({});
    const { jobId } = await main.jobs.start({
      job: backupJob(redis.id, { database: '2', output: { path: '/backups/keys.qbak' } }),
    });
    expect((await settled(main, jobId)).state).toBe('completed');
  });

  it('describes backups and restores for the job list and the notification', () => {
    const profileId = crypto.randomUUID();
    expect(describeJob(backupJob(profileId, { method: 'native', format: 'custom' }))).toEqual({
      title: 'Back up shop to shop.qbak with the native tools',
      target: { file: '/backups/shop.qbak', format: 'pg_dump custom format', database: 'shop' },
    });
    expect(describeJob(restoreJob(profileId, { select: ['a', 'b'] })).title).toBe(
      'Restore shop.qbak (2 selected) into shop_copy',
    );
    const job: JobInfo = {
      id: crypto.randomUUID(),
      kind: 'restore',
      title: 'Restore shop.qbak into shop_copy',
      profileId,
      profileName: 'Shop',
      state: 'completed',
      cancelling: false,
      createdAt: '2026-09-29T12:00:00.000Z',
      summary: {
        status: 'completed',
        rowsRead: 1200,
        rowsWritten: 1200,
        rowsSkipped: 0,
        failed: 2,
        durationMs: 10,
      },
      errors: [],
      log: [],
      target: {},
    };
    expect(notificationFor(job)).toEqual({
      title: 'Restore finished',
      body: 'Restore shop.qbak into shop_copy: 1,200 rows, 2 statements failed',
    });
  });
});

function resolvedProfile(overrides: Partial<ConnectionProfileInput> = {}): ResolvedProfile {
  return {
    profile: connectionProfileSchema.parse(profileInput({ id: 'p1', ...overrides })),
    secrets: { s1: SECRET },
  };
}

function runnerSetup() {
  const posted: RunnerToMain[] = [];
  const session = new FakeJobSession();
  const runner = new JobRunner({
    post: (message) => posted.push(structuredClone(message)),
    connect: async () => ({ session, close: () => session.close() }),
  });
  const find = <T extends RunnerToMain['type']>(type: T, id: string) =>
    vi.waitFor(() => {
      const message = posted.find(
        (m) =>
          m.type === type &&
          ((m.type === 'done' && m.jobId === id) || (m.type === 'response' && m.requestId === id)),
      );
      if (!message) throw new Error(`no ${type} yet`);
      return message as Extract<RunnerToMain, { type: T }>;
    });
  return { runner, posted, session, find };
}

describe('backup and restore in the job runner', () => {
  it('reads a backup file, unlocking an encrypted archive with its passphrase', async () => {
    const { runner, find, posted } = runnerSetup();
    const path = join(dir, 'shop.qbak');
    const writer = await ArchiveWriter.create({
      sink: fileSink(path),
      encryption: { passphrase: PASSPHRASE, cost: { log2N: 10, r: 8, p: 1 } },
    });
    await writer.add('data/0001-orders.sql', 'application/sql', 'INSERT INTO orders VALUES (1);');
    await writer.finish({
      createdAt: '2026-09-29T12:00:00.000Z',
      producer: 'Querybara',
      engine: 'postgres',
      serverVersion: '16.4',
      database: 'shop',
      objects: [
        {
          id: 'table:public.orders',
          kind: 'table',
          schema: 'public',
          name: 'orders',
          qualifiedName: 'public.orders',
          dependsOn: [],
          data: { entry: 'data/0001-orders.sql', count: 1 },
        },
      ],
    });

    runner.handle({
      type: 'request',
      requestId: 'r1',
      request: { kind: 'backup-inspect', input: { path } },
    });
    expect((await find('response', 'r1')).result).toMatchObject({
      format: 'qbak',
      encrypted: true,
    });
    expect((await find('response', 'r1')).result).not.toHaveProperty('objects');

    runner.handle({
      type: 'request',
      requestId: 'r2',
      request: { kind: 'backup-inspect', input: { path, passphrase: 'not it at all' } },
    });
    expect((await find('response', 'r2')).error?.message).toMatch(/passphrase/i);

    runner.handle({
      type: 'request',
      requestId: 'r3',
      request: { kind: 'backup-inspect', input: { path, passphrase: PASSPHRASE } },
    });
    expect((await find('response', 'r3')).result).toMatchObject({
      engine: 'postgres',
      database: 'shop',
      objects: [{ id: 'table:public.orders', rows: 1 }],
    });

    const script = join(dir, 'shop.sql');
    writeFileSync(script, '-- Querybara backup of shop (postgres 16.4)\nSELECT 1;\n');
    runner.handle({
      type: 'request',
      requestId: 'r4',
      request: { kind: 'backup-inspect', input: { path: script } },
    });
    expect((await find('response', 'r4')).result).toMatchObject({
      format: 'sql',
      encrypted: false,
    });
    expect(JSON.stringify(posted)).not.toContain(PASSPHRASE);
  });

  it('refuses a restore into a read-only profile before touching it', async () => {
    const { runner, session, find } = runnerSetup();
    runner.handle({
      type: 'start',
      jobId: 'j1',
      job: restoreJob('p1', { path: join(dir, 'missing.qbak') }),
      resolved: resolvedProfile(presentation({ readOnly: true })),
    });
    const done = await find('done', 'j1');
    expect(done.error?.code).toBe('READ_ONLY');
    // A production profile needs the confirmation here too, whatever main let through.
    runner.handle({
      type: 'start',
      jobId: 'j2',
      job: restoreJob('p1', { path: join(dir, 'missing.qbak') }),
      resolved: resolvedProfile(presentation({ environment: 'production' })),
    });
    expect((await find('done', 'j2')).error?.code).toBe('CONFIRMATION_REQUIRED');
    expect(session.statements).toEqual([]);
  });

  it('checks the options that only work together', () => {
    const job = backupJob('p1');
    const { encryption: _encryption, ...plain } = job;
    expect(() => checkBackupJob(job, 'postgres')).not.toThrow();
    expect(() => checkBackupJob({ ...job, method: 'native' }, 'postgres')).toThrow(/\.qbak/);
    expect(() =>
      checkBackupJob({ ...job, format: 'sql', output: { path: '/b/x.sql' } }, 'mysql'),
    ).toThrow(/Encryption/);
    expect(() => checkBackupJob({ ...plain, format: 'custom' }, 'postgres')).toThrow(/pg_dump/);
    expect(() => checkBackupJob({ ...plain, method: 'native', format: 'custom' }, 'mysql')).toThrow(
      /PostgreSQL only/,
    );
    expect(() => checkBackupJob({ ...plain, format: 'sql' }, 'mongodb')).toThrow(
      /Querybara archive/,
    );
    expect(() => checkBackupJob({ ...job, method: 'native' }, 'redis')).toThrow(/MySQL/);
  });
});
