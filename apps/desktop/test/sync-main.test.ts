import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MessageChannel } from 'node:worker_threads';

import {
  schemaSnapshotSchema,
  type ConnectionProfileInput,
  type SchemaSnapshot,
} from '@joinery/core';
import {
  createClient,
  fromNodePort,
  mainContract,
  serve,
  type Client,
  type DataRowDiff,
  type JobInfo,
  type MainContract,
  type PortLike,
  type SyncSideInfo,
} from '@joinery/ipc';
import { openStore, type SecretSealer, type Store } from '@joinery/storage';
import { compareSchemas, summarizeDiff } from '@joinery/sync';
import { afterEach, describe, expect, it } from 'vitest';

import { defaultSelection, structureScript } from '../src/job-runner/sync-structure';
import { createMainHandlers } from '../src/main/api';
import { JobManager, type JobRunnerProcess } from '../src/main/jobs';
import { notificationFor } from '../src/main/jobs-api';
import { ConnectionSupervisor } from '../src/main/supervisor';
import { SyncService } from '../src/main/sync';
import type { MainToRunner } from '../src/shared/job-protocol';
import type { SyncJobResult } from '../src/shared/sync-jobs';
import { rowPageFile } from '../src/shared/sync-spool';
import { fakeHosts, profileInput } from './helpers';

/**
 * The `sync.*` methods of the main contract behind a real RPC server, with an in-memory store
 * and a fake job runner that answers sync jobs like the real one (spec §13). Main keeps each
 * comparison for the page, pages spooled rows, checks the write rules and file grants whatever
 * the page sends, and never hands a secret to the renderer.
 */

const SECRET = 'hunter2-sync-Sup3r';

const sealer: SecretSealer = {
  id: 'test-xor',
  isAvailable: () => true,
  seal: (plain) => new TextEncoder().encode(plain).map((b) => b ^ 0x2a),
  unseal: (sealed) => new TextDecoder().decode(sealed.map((b) => b ^ 0x2a)),
};

function snapshot(tables: unknown[]): SchemaSnapshot {
  return schemaSnapshotSchema.parse({
    engine: 'postgres',
    database: 'shop',
    capturedAt: '2026-09-29T10:00:00.000Z',
    schemas: [{ name: 'public', tables }],
  });
}

const SOURCE = snapshot([
  {
    name: 'users',
    columns: [
      { name: 'id', ordinal: 1, dataType: 'integer', nullable: false },
      { name: 'email', ordinal: 2, dataType: 'text', nullable: true },
    ],
    primaryKey: { name: 'users_pkey', columns: ['id'] },
  },
]);
const TARGET = snapshot([
  {
    name: 'users',
    columns: [{ name: 'id', ordinal: 1, dataType: 'integer', nullable: false }],
    primaryKey: { name: 'users_pkey', columns: ['id'] },
  },
  { name: 'old', columns: [{ name: 'id', ordinal: 1, dataType: 'integer', nullable: true }] },
]);

const info = (profileId: string, name: string): SyncSideInfo => ({
  profileId,
  profileName: name,
  engine: 'postgres',
  serverVersion: '16.4',
  database: 'shop',
});

const open: { store: Store; channel: MessageChannel }[] = [];
const temp: string[] = [];

afterEach(() => {
  for (const { store, channel } of open.splice(0)) {
    channel.port1.close();
    channel.port2.close();
    store.close();
  }
  for (const dir of temp.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A job runner answering sync jobs and requests the way the real one does. */
class SyncRunner implements JobRunnerProcess {
  readonly sent: MainToRunner[] = [];
  /** Set to make the next data compare fail. */
  failNext = false;
  #listener: (message: unknown) => void = () => undefined;

  send(message: MainToRunner): void {
    this.sent.push(message);
    setImmediate(() => this.#answer(message));
  }

  #answer(message: MainToRunner): void {
    if (message.type === 'request') {
      const request = message.request;
      const result =
        request.kind === 'sync-script'
          ? structureScript(request.input.diff, request.input.selected)
          : request.kind === 'sync-data-script' && request.input.path === undefined
            ? { statements: ['BEGIN', 'DELETE FROM x', 'COMMIT'], total: 3, truncated: false }
            : { bytes: 42, statements: [], total: 3, truncated: false };
      this.#listener({ type: 'response', requestId: message.requestId, result });
      return;
    }
    if (message.type !== 'start') return;
    const { job, jobId } = message;
    const done = (result: SyncJobResult | undefined, outcome = 'Done') =>
      this.#listener({
        type: 'done',
        jobId,
        summary: {
          status: 'completed',
          rowsRead: 0,
          rowsWritten: 0,
          rowsSkipped: 0,
          durationMs: 3,
          outcome,
        },
        errors: [],
        ...(result ? { result } : {}),
      });
    if (job.kind === 'structure-compare') {
      const { diff } = compareSchemas(SOURCE, TARGET);
      done({
        kind: 'structure',
        source: info(job.sourceProfileId, 'Dev'),
        target: info(job.profileId, 'Prod'),
        diff,
        summary: summarizeDiff(diff),
        sourceSnapshot: SOURCE,
        script: structureScript(diff, defaultSelection(diff)),
      });
    } else if (job.kind === 'structure-apply') {
      const { diff } = compareSchemas(
        SOURCE,
        snapshot([SOURCE.schemas[0]!.tables[0]!, TARGET.schemas[0]!.tables[1]!]),
      );
      done({
        kind: 'structure',
        target: info(job.profileId, 'Prod'),
        diff,
        summary: summarizeDiff(diff),
        script: structureScript(diff, defaultSelection(diff)),
        applied: { statements: 3, operations: job.selected, durationMs: 2, unconverged: [] },
      });
    } else if (job.kind === 'data-compare') {
      if (this.failNext) {
        this.failNext = false;
        this.#listener({
          type: 'done',
          jobId,
          errors: [],
          error: { code: 'CONNECTION_FAILED', message: 'The source is down' },
        });
        return;
      }
      const rows: DataRowDiff[] = Array.from({ length: 3 }, (_, i) => ({
        action: 'insert',
        key: [String(i + 1)],
        source: [String(i + 1), `name ${i + 1}`],
      }));
      writeFileSync(
        join(job.spoolDir, rowPageFile(0, 'insert', 0)),
        JSON.stringify(rows.slice(0, 2)),
      );
      writeFileSync(join(job.spoolDir, rowPageFile(0, 'insert', 1)), JSON.stringify(rows.slice(2)));
      done({
        kind: 'data',
        source: info(job.sourceProfileId, 'Dev'),
        target: info(job.profileId, 'Prod'),
        tables: [
          {
            index: 0,
            name: 'public.users',
            source: { schema: 'public', name: 'users' },
            target: { schema: 'public', name: 'users' },
            keyColumns: ['id'],
            commonColumns: ['id', 'name'],
            compared: ['name'],
            columns: ['id', 'name'],
            counts: { inserts: 3, updates: 0, deletes: 0, equal: 1, sourceRows: 4, targetRows: 1 },
            checksums: true,
            ranges: 1,
            matchedRanges: 0,
            stored: { insert: 3, update: 0, delete: 0 },
            statements: { insert: 1, update: 0, delete: 0 },
            durationMs: 5,
          },
        ],
        skipped: [{ name: 'public.logs', reason: 'Only in the source' }],
        pageSize: 2,
      });
    } else {
      done(undefined, 'Applied 3 row changes to 1 table');
    }
  }

  onMessage(listener: (message: unknown) => void): void {
    this.#listener = listener;
  }
  onExit(): void {}
  kill(): void {}
}

function setup(dialogs: { save?: string } = {}) {
  const store = openStore(':memory:', { sealer });
  const runner = new SyncRunner();
  const jobs = new JobManager({ spawn: () => runner });
  const spoolRoot = mkdtempSync(join(tmpdir(), 'joinery-sync-main-'));
  temp.push(spoolRoot);
  const sync = new SyncService({ jobs, spoolRoot });
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
      sync,
    },
    {
      sendPort: () => undefined,
      openFile: async () => null,
      saveFile: async () => dialogs.save ?? null,
      openDirectory: async () => null,
    },
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
  const leaked = (): boolean => JSON.stringify(received).includes(SECRET);
  return { store, jobs, runner, sync, spoolRoot, main, leaked };
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
  return { saved, passwordId };
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

/** Waits for the job to finish (the fake runner answers on the next turn). */
async function finished(jobs: JobManager, jobId: string): Promise<JobInfo> {
  for (;;) {
    const job = jobs.get(jobId);
    if (job && job.state !== 'running') return job;
    await new Promise((resolve) => setImmediate(resolve));
  }
}

describe('structure compare in main', () => {
  it('runs the compare in the job runner and keeps the comparison for the page', async () => {
    const { main, jobs, runner, leaked } = setup();
    const dev = await saveProfile(main, { name: 'Dev' });
    const prod = await saveProfile(main, { name: 'Prod' });
    const { jobId } = await main.sync.structure.compare({
      source: { profileId: dev.saved.id, database: 'shop_dev', schemas: ['public'] },
      target: { profileId: prod.saved.id, database: 'shop' },
      options: { ignoreComments: true },
    });
    const start = runner.sent.find((m) => m.type === 'start');
    expect(start?.type === 'start' && start.job).toMatchObject({
      kind: 'structure-compare',
      profileId: prod.saved.id,
      sourceProfileId: dev.saved.id,
      source: { database: 'shop_dev', schemas: ['public'] },
      target: { database: 'shop' },
      options: { ignoreComments: true },
    });
    expect(start?.type === 'start' && start.source?.secrets[dev.passwordId]).toBe(SECRET);
    expect(start?.type === 'start' && start.resolved.secrets[prod.passwordId]).toBe(SECRET);
    const job = await finished(jobs, jobId);
    expect(job).toMatchObject({
      kind: 'structure-compare',
      title: 'Compare structure: Dev (shop_dev) → Prod (shop)',
      profileId: prod.saved.id,
    });
    const result = await main.sync.structure.result({ jobId });
    expect('order' in result.diff).toBe(false);
    expect(result.diff.operations.map((op) => op.kind)).toEqual(['drop', 'create']);
    expect(result.summary).toMatchObject({ total: 2, destructive: 1 });

    const all = result.diff.operations.map((op) => op.id);
    const script = await main.sync.structure.script({ jobId, selected: all });
    expect(script.text).toContain('DROP TABLE');
    const request = runner.sent.findLast((m) => m.type === 'request');
    // The page names the job; main sends the whole diff, step order included.
    expect(request?.type === 'request' && request.request.kind === 'sync-script').toBe(true);
    expect(
      request?.type === 'request' &&
        request.request.kind === 'sync-script' &&
        request.request.input.diff.order.length,
    ).toBeGreaterThan(0);
    expect(leaked()).toBe(false);

    await main.sync.discard({ jobId });
    await expect(main.sync.structure.result({ jobId })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('refuses what cannot be compared', async () => {
    const { main } = setup();
    const pg = await saveProfile(main, { name: 'PG' });
    const my = await saveProfile(main, {
      name: 'My',
      engine: 'mysql',
      endpoint: { kind: 'host', host: 'localhost', port: 3306 },
    });
    const mongo = await saveProfile(main, {
      name: 'Mongo',
      engine: 'mongodb',
      endpoint: { kind: 'host', host: 'localhost', port: 27017 },
    });
    await expect(
      main.sync.structure.compare({
        source: { profileId: pg.saved.id },
        target: { profileId: my.saved.id, database: 'shop' },
        options: {},
      }),
    ).rejects.toMatchObject({ code: 'NOT_SUPPORTED' });
    await expect(
      main.sync.data.compare({
        source: { profileId: mongo.saved.id },
        target: { profileId: pg.saved.id },
        options: { actions: { insert: true, update: true, delete: true } },
      }),
    ).rejects.toMatchObject({ code: 'NOT_SUPPORTED' });
    await expect(
      main.sync.structure.compare({
        source: { profileId: pg.saved.id },
        target: { profileId: 'gone' },
        options: {},
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND', message: 'The target connection was deleted' });
  });

  it('applies only within the target’s write rules, and keeps the re-compare', async () => {
    const { main, jobs, runner } = setup();
    const dev = await saveProfile(main, { name: 'Dev' });
    const compareTo = async (targetId: string) => {
      const { jobId } = await main.sync.structure.compare({
        source: { profileId: dev.saved.id },
        target: { profileId: targetId },
        options: {},
      });
      await finished(jobs, jobId);
      return { jobId, result: await main.sync.structure.result({ jobId }) };
    };
    const readOnly = await saveProfile(main, presentation({ readOnly: true }));
    const ro = await compareTo(readOnly.saved.id);
    const apply = (jobId: string, confirmed?: boolean) =>
      main.sync.structure.apply({
        jobId,
        selected: ro.result.diff.operations.map((op) => op.id),
        scriptSha256: 'a'.repeat(64),
        ...(confirmed !== undefined ? { confirmed } : {}),
      });
    await expect(apply(ro.jobId, true)).rejects.toMatchObject({ code: 'READ_ONLY' });

    const production = await saveProfile(main, presentation({ environment: 'production' }));
    const prod = await compareTo(production.saved.id);
    await expect(apply(prod.jobId)).rejects.toMatchObject({ code: 'CONFIRMATION_REQUIRED' });
    const { jobId: applyId } = await apply(prod.jobId, true);
    const start = runner.sent.findLast((m) => m.type === 'start');
    expect(start?.type === 'start' && start.job).toMatchObject({
      kind: 'structure-apply',
      profileId: production.saved.id,
      confirmed: true,
      scriptSha256: 'a'.repeat(64),
      sourceSnapshot: { database: 'shop' },
    });
    const job = await finished(jobs, applyId);
    expect(job.kind).toBe('structure-apply');
    const after = await main.sync.structure.result({ jobId: applyId });
    expect(after.applied).toMatchObject({ statements: 3, unconverged: [] });
    // The source side comes from the comparison the apply started from.
    expect(after.source.profileName).toBe('Dev');
    expect(after.diff.operations.map((op) => op.kind)).toEqual(['drop']);
  });

  it('writes exports only where the window’s save dialog pointed', async () => {
    const { main, jobs, runner } = setup({ save: '/out/report.html' });
    const dev = await saveProfile(main);
    const prod = await saveProfile(main);
    const { jobId } = await main.sync.structure.compare({
      source: { profileId: dev.saved.id },
      target: { profileId: prod.saved.id },
      options: {},
    });
    await finished(jobs, jobId);
    const input = { jobId, selected: [], format: 'html' as const, path: '/out/report.html' };
    await expect(main.sync.structure.export(input)).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    await main.dialogs.saveFile({ defaultName: 'report.html' });
    expect(await main.sync.structure.export(input)).toEqual({ bytes: 42 });
    const request = runner.sent.findLast((m) => m.type === 'request');
    expect(request?.type === 'request' && request.request).toMatchObject({
      kind: 'sync-export',
      input: { format: 'html', path: '/out/report.html', sourceLabel: 'Source: Dev (shop)' },
    });
  });
});

describe('data compare in main', () => {
  it('pages spooled rows, previews and applies, and removes the spool when discarded', async () => {
    const { main, jobs, runner, spoolRoot } = setup();
    const dev = await saveProfile(main, { name: 'Dev' });
    const prod = await saveProfile(main, { name: 'Prod' });
    const { jobId } = await main.sync.data.compare({
      source: { profileId: dev.saved.id },
      target: { profileId: prod.saved.id },
      options: { actions: { insert: true, update: true, delete: false } },
      tables: [{ name: 'public.users', columns: ['name'] }],
    });
    await finished(jobs, jobId);
    const start = runner.sent.find((m) => m.type === 'start');
    const spoolDir =
      start?.type === 'start' && start.job.kind === 'data-compare' ? start.job.spoolDir : '';
    expect(spoolDir.startsWith(spoolRoot)).toBe(true);
    const result = await main.sync.data.result({ jobId });
    expect(result).toMatchObject({
      options: { actions: { delete: false } },
      skipped: [{ name: 'public.logs' }],
      pageSize: 2,
    });
    const first = await main.sync.data.rows({ jobId, table: 0, action: 'insert', page: 0 });
    expect(first).toMatchObject({ page: 0, pageCount: 2, total: 3 });
    expect(first.rows.map((r) => r.key)).toEqual([['1'], ['2']]);
    const second = await main.sync.data.rows({ jobId, table: 0, action: 'insert', page: 1 });
    expect(second.rows.map((r) => r.key)).toEqual([['3']]);
    expect(
      (await main.sync.data.rows({ jobId, table: 0, action: 'update', page: 0 })).rows,
    ).toEqual([]);
    await expect(
      main.sync.data.rows({ jobId, table: 7, action: 'insert', page: 0 }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });

    const selection = {
      jobId,
      tables: [0],
      actions: { insert: true, update: true, delete: false },
    };
    expect(await main.sync.data.preview(selection)).toMatchObject({ total: 3 });
    const { jobId: applyId } = await main.sync.data.apply(selection);
    const applied = await finished(jobs, applyId);
    expect(applied).toMatchObject({
      kind: 'data-apply',
      title: 'Apply data changes to Prod',
      summary: { outcome: 'Applied 3 row changes to 1 table' },
    });
    const applyStart = runner.sent.findLast((m) => m.type === 'start');
    expect(applyStart?.type === 'start' && applyStart.job).toMatchObject({
      kind: 'data-apply',
      spoolDir,
      tables: [0],
      confirmed: false,
    });
    expect(notificationFor(applied)).toEqual({
      title: 'Data sync finished',
      body: 'Apply data changes to Prod: Applied 3 row changes to 1 table',
    });

    await main.sync.discard({ jobId });
    expect(existsSync(spoolDir)).toBe(false);
    await expect(main.sync.data.result({ jobId })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('leaves no spool behind when the compare fails', async () => {
    const { main, jobs, runner, spoolRoot } = setup();
    const dev = await saveProfile(main);
    const prod = await saveProfile(main);
    runner.failNext = true;
    const { jobId } = await main.sync.data.compare({
      source: { profileId: dev.saved.id },
      target: { profileId: prod.saved.id },
      options: { actions: { insert: true, update: true, delete: true } },
    });
    expect((await finished(jobs, jobId)).state).toBe('failed');
    const folders = readdirSync(spoolRoot).flatMap((dir) => readdirSync(join(spoolRoot, dir)));
    expect(folders).toEqual([]);
  });

  it('refuses a read-only target and an unconfirmed production one', async () => {
    const { main, jobs } = setup();
    const dev = await saveProfile(main);
    const readOnly = await saveProfile(main, presentation({ readOnly: true }));
    const { jobId } = await main.sync.data.compare({
      source: { profileId: dev.saved.id },
      target: { profileId: readOnly.saved.id },
      options: { actions: { insert: true, update: true, delete: true } },
    });
    await finished(jobs, jobId);
    await expect(
      main.sync.data.apply({
        jobId,
        tables: [0],
        actions: { insert: true, update: true, delete: true },
        confirmed: true,
      }),
    ).rejects.toMatchObject({ code: 'READ_ONLY' });
  });
});

describe('saved comparisons', () => {
  it('saves, lists, updates and deletes them', async () => {
    const { main } = setup();
    const dev = await saveProfile(main, { name: 'Dev' });
    const prod = await saveProfile(main, { name: 'Prod' });
    const saved = await main.sync.saved.save({
      name: 'Dev to prod',
      kind: 'structure',
      source: { profileId: dev.saved.id, database: 'shop_dev', schemas: ['public'] },
      target: { profileId: prod.saved.id, database: 'shop' },
      structure: {
        ignoreComments: true,
        renames: [{ objectKind: 'table', from: 'clients', to: 'customers' }],
      },
    });
    expect(saved).toMatchObject({
      name: 'Dev to prod',
      kind: 'structure',
      source: { profileId: dev.saved.id, database: 'shop_dev', schemas: ['public'] },
      target: { profileId: prod.saved.id, database: 'shop' },
      structure: { ignoreComments: true, renames: [{ from: 'clients', to: 'customers' }] },
      version: 1,
    });
    const data = await main.sync.saved.save({
      name: 'Nightly data',
      kind: 'data',
      source: { profileId: dev.saved.id },
      target: { profileId: prod.saved.id },
      data: {
        options: { actions: { insert: true, update: true, delete: false }, floatTolerance: 0.01 },
        tables: [{ name: 'public.users', columns: ['name'] }],
      },
    });
    expect((await main.sync.saved.list()).map((c) => c.name)).toEqual([
      'Dev to prod',
      'Nightly data',
    ]);
    const renamed = await main.sync.saved.save({
      id: saved.id,
      name: 'Dev → prod',
      kind: 'structure',
      source: { profileId: dev.saved.id },
      target: { profileId: prod.saved.id },
      expectedVersion: 1,
    });
    expect(renamed).toMatchObject({ id: saved.id, name: 'Dev → prod', version: 2 });
    await expect(
      main.sync.saved.save({
        id: data.id,
        name: 'x',
        kind: 'structure',
        source: { profileId: dev.saved.id },
        target: { profileId: prod.saved.id },
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await main.profiles.delete({ id: dev.saved.id });
    const [first] = await main.sync.saved.list();
    expect(first?.source.profileId).toBeNull();
    await main.sync.saved.delete({ id: saved.id });
    expect((await main.sync.saved.list()).map((c) => c.name)).toEqual(['Nightly data']);
  });
});
