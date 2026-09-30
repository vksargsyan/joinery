import { MessageChannel } from 'node:worker_threads';

import type { ConnectionProfileInput } from '@joinery/core';
import {
  createClient,
  fromNodePort,
  mainContract,
  serve,
  type Client,
  type MainContract,
  type PortLike,
  type TransferInspection,
  type TransferJob,
  type TransferPlanInfo,
} from '@joinery/ipc';
import { openStore, type SecretSealer, type Store } from '@joinery/storage';
import { afterEach, describe, expect, it } from 'vitest';

import { createMainHandlers } from '../src/main/api';
import { JobManager, type JobRunnerProcess } from '../src/main/jobs';
import { notificationFor, settingsJobHistory } from '../src/main/jobs-api';
import { ConnectionSupervisor } from '../src/main/supervisor';
import { describeTransfer, destructiveChoices } from '../src/main/transfer-db-api';
import type { MainToRunner } from '../src/shared/job-protocol';
import { fakeHosts, profileInput } from './helpers';

/**
 * Main's side of data transfer (spec §12) behind a real RPC server with an in-memory store
 * and a fake job runner: the wizard's inspection and plan and the transfer job get both
 * resolved profiles in the runner and nowhere else, and the write rules hold whatever the
 * page sends.
 */

const SECRET = 'hunter2-transfer-9f3';
const TARGET_SECRET = 'target-secret-4b1c';

const sealer: SecretSealer = {
  id: 'test-xor',
  isAvailable: () => true,
  seal: (plain) => new TextEncoder().encode(plain).map((b) => b ^ 0x2a),
  unseal: (sealed) => new TextDecoder().decode(sealed.map((b) => b ^ 0x2a)),
};

const INSPECTION: TransferInspection = {
  engine: 'postgres',
  serverVersion: '16.4',
  databases: ['shop'],
  database: 'shop',
  schemas: ['public'],
  objects: [{ name: 'orders', kind: 'table', rows: 3 }],
};

const PLAN: TransferPlanInfo = {
  sourceEngine: 'postgres',
  targetEngine: 'mysql',
  sourceVersion: '16.4',
  targetVersion: '8.4.2',
  tables: [],
  before: [],
  after: [],
  destructive: [],
  creates: [],
  problems: [],
  warnings: [],
};

const open: { store: Store; channel: MessageChannel }[] = [];
afterEach(() => {
  for (const { store, channel } of open.splice(0)) {
    channel.port1.close();
    channel.port2.close();
    store.close();
  }
});

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
        this.#listener({
          type: 'response',
          requestId: message.requestId,
          result: message.request.kind === 'transfer-inspect' ? INSPECTION : PLAN,
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

function setup() {
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
        name: 'Joinery',
        version: '0.1.0',
        platform: 'linux',
        arch: 'x64',
        versions: { node: '24' },
      }),
      openExternal: async () => {},
      jobs,
    },
    { sendPort: () => undefined, openFile: async () => null },
  );
  const channel = new MessageChannel();
  open.push({ store, channel });
  serve(fromNodePort(channel.port2), mainContract, handlers);
  const received: unknown[] = [];
  const recorded: PortLike = fromNodePort(channel.port1);
  const renderer: PortLike = {
    ...recorded,
    onMessage: (listener) =>
      recorded.onMessage((data) => {
        received.push(data);
        listener(data);
      }),
  };
  const main: Client<MainContract['shape']> = createClient(renderer, mainContract);
  const leaked = (): boolean => {
    const text = JSON.stringify(received);
    return text.includes(SECRET) || text.includes(TARGET_SECRET);
  };
  return { main, runners, leaked };
}

async function saveProfile(
  main: Client<MainContract['shape']>,
  secret: string,
  overrides: Partial<ConnectionProfileInput> = {},
) {
  const passwordId = crypto.randomUUID();
  const saved = await main.profiles.save({
    profile: profileInput({
      auth: { method: 'password', user: 'app', password: { id: passwordId, policy: 'save' } },
      ...overrides,
    }),
  });
  await main.secrets.set({ profileId: saved.id, refId: passwordId, value: secret });
  return { saved, passwordId };
}

const presentation = (patch: object) =>
  ({
    presentation: {
      folderId: null,
      tags: [],
      environment: 'dev',
      readOnly: false,
      confirmWrites: false,
      ...patch,
    },
  }) as Partial<ConnectionProfileInput>;

function transferJob(
  source: string,
  target: string,
  patch: Partial<TransferJob> = {},
): TransferJob {
  return {
    kind: 'transfer',
    profileId: source,
    database: 'shop',
    objects: [{ name: 'orders' }],
    target: { profileId: target, database: 'archive' },
    ...patch,
  };
}

describe('transfer between databases in main', () => {
  it('inspects and plans in the runner, which alone gets the secrets', async () => {
    const { main, runners, leaked } = setup();
    const { saved: source, passwordId } = await saveProfile(main, SECRET, { name: 'Shop' });
    const { saved: target, passwordId: targetRef } = await saveProfile(main, TARGET_SECRET, {
      name: 'Archive',
      engine: 'mysql',
      endpoint: { kind: 'host', host: 'db', port: 3306 },
    });
    expect(await main.transferDb.inspect({ profileId: source.id, database: 'shop' })).toEqual(
      INSPECTION,
    );
    expect(await main.transferDb.plan({ job: transferJob(source.id, target.id) })).toEqual(PLAN);
    const [inspect, plan] = runners[0]!.sent.filter((m) => m.type === 'request');
    expect(inspect?.type === 'request' && inspect.request).toMatchObject({
      kind: 'transfer-inspect',
      input: { database: 'shop' },
      resolved: { secrets: { [passwordId]: SECRET } },
    });
    expect(plan?.type === 'request' && plan.request).toMatchObject({
      kind: 'transfer-plan',
      resolved: { secrets: { [passwordId]: SECRET } },
      resolvedTarget: { secrets: { [targetRef]: TARGET_SECRET } },
    });
    expect(leaked()).toBe(false);
  });

  it('starts a transfer job with both profiles', async () => {
    const { main, runners, leaked } = setup();
    const { saved: source } = await saveProfile(main, SECRET, { name: 'Shop' });
    const { saved: target, passwordId: targetRef } = await saveProfile(main, TARGET_SECRET, {
      name: 'Archive',
      engine: 'mysql',
      endpoint: { kind: 'host', host: 'db', port: 3306 },
    });
    const { jobId } = await main.jobs.start({ job: transferJob(source.id, target.id) });
    const start = runners[0]!.sent.find((m) => m.type === 'start');
    expect(start?.type === 'start' && start.resolvedTarget?.secrets[targetRef]).toBe(TARGET_SECRET);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const [job] = await main.jobs.list();
    expect(job).toMatchObject({
      id: jobId,
      kind: 'transfer',
      title: 'Transfer orders from Shop to Archive',
      state: 'completed',
      target: { table: 'orders', database: 'shop', format: 'transfer' },
    });
    expect(notificationFor(job!).title).toBe('Transfer finished');
    expect(leaked()).toBe(false);
  });

  it('keeps the write rules whatever the page sends', async () => {
    const { main, runners } = setup();
    const { saved: source } = await saveProfile(main, SECRET);
    const my = {
      engine: 'mysql' as const,
      endpoint: { kind: 'host' as const, host: 'db', port: 3306 },
    };
    const { saved: locked } = await saveProfile(main, TARGET_SECRET, {
      ...my,
      ...presentation({ readOnly: true }),
    });
    const { saved: prod } = await saveProfile(main, TARGET_SECRET, {
      ...my,
      ...presentation({ environment: 'production' }),
    });
    const { saved: dev } = await saveProfile(main, TARGET_SECRET, my);
    const { saved: redis } = await saveProfile(main, TARGET_SECRET, {
      engine: 'redis',
      endpoint: { kind: 'host', host: 'r', port: 6379 },
    });
    await expect(
      main.jobs.start({ job: transferJob(source.id, locked.id, { confirmed: true }) }),
    ).rejects.toMatchObject({
      code: 'READ_ONLY',
    });
    await expect(main.jobs.start({ job: transferJob(source.id, prod.id) })).rejects.toMatchObject({
      code: 'CONFIRMATION_REQUIRED',
      message: 'Transferring into a production connection needs confirmation',
    });
    await expect(
      main.jobs.start({
        job: transferJob(source.id, dev.id, { options: { mode: 'drop-create' } }),
      }),
    ).rejects.toMatchObject({ code: 'CONFIRMATION_REQUIRED' });
    await expect(
      main.jobs.start({
        job: transferJob(source.id, dev.id, { objects: [{ name: 'orders', mode: 'truncate' }] }),
      }),
    ).rejects.toMatchObject({ code: 'CONFIRMATION_REQUIRED' });
    await expect(main.jobs.start({ job: transferJob(source.id, redis.id) })).rejects.toMatchObject({
      code: 'NOT_SUPPORTED',
    });
    expect(runners.flatMap((r) => r.sent.filter((m) => m.type === 'start'))).toEqual([]);
    await main.jobs.start({ job: transferJob(source.id, prod.id, { confirmed: true }) });
    await main.jobs.start({
      job: transferJob(source.id, dev.id, { options: { mode: 'drop-create' }, confirmed: true }),
    });
    expect(runners.flatMap((r) => r.sent.filter((m) => m.type === 'start'))).toHaveLength(2);
  });

  it('describes transfers for the job list', () => {
    expect(
      destructiveChoices(transferJob('a', 'b', { options: { mode: 'truncate', replace: true } })),
    ).toEqual(['empties tables that exist', 'overwrites keys that exist']);
    expect(
      describeTransfer(transferJob('a', 'b', { objects: [{ name: 'a' }, { name: 'b' }] })).title,
    ).toBe('Transfer 2 tables');
    expect(
      describeTransfer(transferJob('a', 'b', { objects: [], keyPatterns: ['user:*'] }), {
        source: 'Cache',
        target: 'Cache 2',
      }),
    ).toEqual({
      title: 'Transfer keys user:* from Cache to Cache 2',
      target: { table: 'user:*', database: 'shop', format: 'transfer' },
    });
  });
});
