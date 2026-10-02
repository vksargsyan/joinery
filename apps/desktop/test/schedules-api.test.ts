import { MessageChannel } from 'node:worker_threads';

import {
  createClient,
  fromNodePort,
  mainContract,
  serve,
  type Client,
  type MainContract,
  type ScheduleSaveInput,
} from '@joinery/ipc';
import { openStore, type SecretSealer, type Store } from '@joinery/storage';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createMainHandlers } from '../src/main/api';
import { passphraseRef } from '../src/main/schedule-tasks';
import { Scheduler } from '../src/main/scheduler';
import { ScheduleEvents } from '../src/main/schedules-api';
import { ConnectionSupervisor } from '../src/main/supervisor';
import { fakeHosts, profileInput } from './helpers';

/**
 * The `schedules.*` methods of the main contract behind a real RPC server: what saving checks
 * whatever the page sends (a folder or file picked in this window, the connection, the write
 * rules, an encrypted backup's passphrase), where the passphrase goes (the secret store, never
 * the schedule), what the list warns about, and enabling, running and deleting.
 */

const sealer: SecretSealer = {
  id: 'test-xor',
  isAvailable: () => true,
  seal: (plain) => new TextEncoder().encode(plain).map((b) => b ^ 0x2a),
  unseal: (sealed) => new TextDecoder().decode(sealed.map((b) => b ^ 0x2a)),
};

const open: { store: Store; channel: MessageChannel }[] = [];
afterEach(() => {
  for (const { store, channel } of open.splice(0)) {
    channel.port1.close();
    channel.port2.close();
    store.close();
  }
});

function setup(dialogs: { folder?: string; open?: string } = {}) {
  const store = openStore(':memory:', { sealer });
  const execute = vi.fn(async () => ({
    status: 'success' as const,
    message: 'Done',
    outputs: [],
    jobId: null,
  }));
  const scheduler = new Scheduler({
    store: store.schedules,
    execute,
    setTimer: () => 0,
    clearTimer: () => undefined,
  });
  const scheduleEvents = new ScheduleEvents();
  const hosts = fakeHosts();
  const handlers = createMainHandlers<string>(
    {
      store,
      supervisor: new ConnectionSupervisor<string>({ spawn: hosts.spawn }),
      spawnHost: hosts.spawn,
      createChannel: () => ({ local: 'l', remote: 'r' }),
      appInfo: () => ({
        name: 'Joinery',
        version: '0.1.0',
        platform: 'linux',
        arch: 'x64',
        versions: { node: '24' },
      }),
      openExternal: async () => {},
      scheduler,
      scheduleEvents,
    },
    {
      sendPort: () => undefined,
      openFile: async () => dialogs.open ?? null,
      saveFile: async () => null,
      openDirectory: async () => dialogs.folder ?? null,
    },
  );
  const channel = new MessageChannel();
  open.push({ store, channel });
  serve(fromNodePort(channel.port2), mainContract, handlers);
  const main: Client<MainContract['shape']> = createClient(
    fromNodePort(channel.port1),
    mainContract,
  );
  const profile = store.profiles.save(profileInput());
  if (profile.auth.method === 'password' && profile.auth.password) {
    store.secrets.set(profile.auth.password, 'secret');
  }
  scheduler.start();
  return { store, main, scheduler, execute, profile };
}

function backup(profileId: string, folder = '/backups'): ScheduleSaveInput {
  return {
    name: 'Nightly',
    enabled: true,
    profileId,
    comparisonId: null,
    task: {
      kind: 'backup',
      job: { kind: 'backup', profileId, database: 'shop', format: 'jbak' },
      encrypted: false,
      output: { folder, fileName: '{name}-{date}-{time}.jbak', keep: 7 },
    },
    rule: { kind: 'weekly', days: [0, 1, 2, 3, 4, 5, 6], times: ['02:00'] },
    missed: 'run-once',
    notify: 'failures',
  };
}

describe('schedules over the main contract', () => {
  it('saves only into a folder picked in this window', async () => {
    const { main, profile } = setup({ folder: '/backups' });
    await expect(main.schedules.save(backup(profile.id))).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    await main.dialogs.openDirectory({ title: 'Back up to' });
    const saved = await main.schedules.save(backup(profile.id));
    expect(saved).toMatchObject({
      name: 'Nightly',
      kind: 'backup',
      enabled: true,
      description: 'Every day at 02:00',
      target: 'Local Postgres · shop',
      running: false,
      warnings: [],
      nextRunAt: expect.any(String),
    });
    // An edit that keeps the folder needs no new pick; another folder does.
    expect(
      await main.schedules.save({ ...backup(profile.id), id: saved.id, name: 'Nightly (all)' }),
    ).toMatchObject({ name: 'Nightly (all)', version: 2 });
    await expect(
      main.schedules.save({ ...backup(profile.id, '/elsewhere'), id: saved.id }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('keeps an encrypted backup’s passphrase in the secret store, never in the schedule', async () => {
    const { main, store, profile } = setup({ folder: '/backups' });
    await main.dialogs.openDirectory({});
    const input = backup(profile.id);
    const encrypted: ScheduleSaveInput = {
      ...input,
      task: { ...input.task, encrypted: true } as ScheduleSaveInput['task'],
    };
    await expect(main.schedules.save(encrypted)).rejects.toMatchObject({
      message: 'An encrypted backup needs its passphrase',
    });
    const saved = await main.schedules.save({ ...encrypted, passphrase: 'correct horse' });
    expect(store.secrets.get(passphraseRef(saved.id))).toBe('correct horse');
    expect(JSON.stringify(store.schedules.get(saved.id))).not.toContain('correct horse');
    // An edit without it keeps it; turning encryption off forgets it.
    await main.schedules.save({ ...encrypted, id: saved.id });
    expect(store.secrets.get(passphraseRef(saved.id))).toBe('correct horse');
    await main.schedules.save({ ...input, id: saved.id });
    expect(store.secrets.get(passphraseRef(saved.id))).toBeUndefined();
  });

  it('checks the connection, the engine and the write rules', async () => {
    const { main, store, profile } = setup({ folder: '/out', open: '/sql/refresh.sql' });
    await main.dialogs.openDirectory({});
    await main.dialogs.openFile({});
    const production = store.profiles.save(
      profileInput({ name: 'Prod', presentation: { environment: 'production' } }),
    );
    const sql = (
      profileId: string,
      confirmed?: boolean,
      path = '/sql/refresh.sql',
    ): ScheduleSaveInput => ({
      ...backup(profileId),
      task: {
        kind: 'sql',
        job: {
          kind: 'run-sql-file',
          profileId,
          path,
          onError: 'stop',
          ...(confirmed ? { confirmed } : {}),
        },
      },
    });
    await expect(main.schedules.save(sql(production.id))).rejects.toMatchObject({
      code: 'CONFIRMATION_REQUIRED',
    });
    expect(await main.schedules.save(sql(production.id, true))).toMatchObject({ kind: 'sql' });
    // A file not opened in this window.
    await expect(
      main.schedules.save(sql(profile.id, false, '/sql/other.sql')),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    // The job on another connection than the schedule.
    await expect(
      main.schedules.save({ ...sql(profile.id), profileId: production.id }),
    ).rejects.toMatchObject({ message: 'The job runs on another connection than the schedule' });
    const redis = store.profiles.save(
      profileInput({
        name: 'Cache',
        engine: 'redis',
        endpoint: { kind: 'host', host: 'localhost', port: 6379 },
      }),
    );
    await expect(main.schedules.save(sql(redis.id))).rejects.toMatchObject({
      code: 'NOT_SUPPORTED',
    });
  });

  it('warns when a run would fail as things stand', async () => {
    const { main, store } = setup({ folder: '/backups' });
    await main.dialogs.openDirectory({});
    const asked = store.profiles.save(
      profileInput({
        name: 'Asked',
        auth: {
          method: 'password',
          user: 'app',
          password: { id: crypto.randomUUID(), policy: 'ask' },
        },
      }),
    );
    const saved = await main.schedules.save(backup(asked.id));
    expect(saved.warnings).toEqual([
      'The password of Asked is not saved: runs will fail until it is saved in the connection settings',
    ]);
  });

  it('turns on and off, runs now, lists runs and deletes', async () => {
    const { main, store, profile, scheduler, execute } = setup({ folder: '/backups' });
    await main.dialogs.openDirectory({});
    const saved = await main.schedules.save(backup(profile.id));
    const off = await main.schedules.setEnabled({ id: saved.id, enabled: false });
    expect(off).toMatchObject({ enabled: false, nextRunAt: null });
    const on = await main.schedules.setEnabled({ id: saved.id, enabled: true });
    expect(on.nextRunAt).not.toBeNull();

    const { runId } = await main.schedules.runNow({ id: saved.id });
    await scheduler.settled();
    expect(execute).toHaveBeenCalledTimes(1);
    expect(await main.schedules.runs({ id: saved.id })).toEqual([
      expect.objectContaining({ id: runId, trigger: 'manual', status: 'success' }),
    ]);
    expect((await main.schedules.list())[0]).toMatchObject({ lastStatus: 'success' });

    store.secrets.set(passphraseRef(saved.id), 'left over');
    await main.schedules.delete({ id: saved.id });
    expect(await main.schedules.list()).toEqual([]);
    expect(store.secrets.get(passphraseRef(saved.id))).toBeUndefined();
    await expect(main.schedules.runNow({ id: saved.id })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
});
