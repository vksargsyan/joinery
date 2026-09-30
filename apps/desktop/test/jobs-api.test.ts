import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MessageChannel } from 'node:worker_threads';

import type { ConnectionProfileInput } from '@joinery/core';
import {
  createClient,
  fromNodePort,
  mainContract,
  serve,
  type Client,
  type JobEvent,
  type JobSpec,
  type MainContract,
  type PortLike,
  type TransferPreview,
} from '@joinery/ipc';
import { openStore, type SecretSealer, type Store } from '@joinery/storage';
import { afterEach, describe, expect, it } from 'vitest';

import { createMainHandlers } from '../src/main/api';
import { JobManager, type JobRunnerProcess } from '../src/main/jobs';
import { describeJob, notificationFor, settingsJobHistory } from '../src/main/jobs-api';
import { ConnectionSupervisor } from '../src/main/supervisor';
import type { MainToRunner } from '../src/shared/job-protocol';
import { fakeHosts, profileInput } from './helpers';

/**
 * The jobs, transfer and dialog methods of the main contract behind a real RPC server, with an
 * in-memory store and a fake job runner that answers like the real one. Everything that
 * reaches the renderer is recorded to prove no secret travels towards it (spec §3, §18), while
 * the job runner gets the resolved profile. Jobs may only use files the window's dialogs
 * returned, and the write rules hold whatever the page sends.
 */

const SECRET = 'hunter2-jobs-Sup3r';
const ASKED = 'typed-for-a-job-7d2e';

const sealer: SecretSealer = {
  id: 'test-xor',
  isAvailable: () => true,
  seal: (plain) => new TextEncoder().encode(plain).map((b) => b ^ 0x2a),
  unseal: (sealed) => new TextDecoder().decode(sealed.map((b) => b ^ 0x2a)),
};

const PREVIEW: TransferPreview = {
  format: 'csv',
  compression: 'none',
  encoding: 'utf-8',
  bom: false,
  complete: true,
  csv: { delimiter: ',', quote: '"', escape: '"', nullMarker: '', header: true },
  columns: [{ name: 'id', type: 'integer', nullable: false, maxLength: 1, samples: 1 }],
  rows: [['1']],
  size: 5,
};

const open: { store: Store; channel: MessageChannel }[] = [];

afterEach(() => {
  for (const { store, channel } of open.splice(0)) {
    channel.port1.close();
    channel.port2.close();
    store.close();
  }
});

/** A job runner that finishes every job at once and answers previews. */
class AnsweringRunner implements JobRunnerProcess {
  readonly sent: MainToRunner[] = [];
  #listener: (message: unknown) => void = () => undefined;

  send(message: MainToRunner): void {
    this.sent.push(message);
    setImmediate(() => {
      if (message.type === 'start') {
        this.#listener({
          type: 'progress',
          jobId: message.jobId,
          progress: { phase: 'Importing', rowsWritten: 1, elapsedMs: 3 },
        });
        this.#listener({
          type: 'done',
          jobId: message.jobId,
          summary: {
            status: 'completed',
            rowsRead: 1,
            rowsWritten: 1,
            rowsSkipped: 0,
            durationMs: 4,
          },
          errors: [],
        });
      } else if (message.type === 'request') {
        this.#listener({
          type: 'response',
          requestId: message.requestId,
          result: message.request.kind === 'preview' ? PREVIEW : [],
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

function setup(dialogs: { open?: string; save?: string; folder?: string } = {}) {
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
    {
      sendPort: () => undefined,
      openFile: async () => dialogs.open ?? null,
      saveFile: async () => dialogs.save ?? null,
      openDirectory: async () => dialogs.folder ?? null,
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
  const leaked = (): boolean => {
    const text = JSON.stringify(received, (_key, v: unknown) =>
      typeof v === 'bigint' ? v.toString() : v,
    );
    return text.includes(SECRET) || text.includes(ASKED);
  };
  return { store, jobs, runners, main, leaked };
}

async function saveProfile(
  main: Client<MainContract['shape']>,
  overrides: Partial<ConnectionProfileInput> = {},
  policy: 'save' | 'ask' = 'save',
) {
  const passwordId = crypto.randomUUID();
  const saved = await main.profiles.save({
    profile: profileInput({
      auth: { method: 'password', user: 'app', password: { id: passwordId, policy } },
      ...overrides,
    }),
  });
  if (policy === 'save') {
    await main.secrets.set({ profileId: saved.id, refId: passwordId, value: SECRET });
  }
  return { saved, passwordId };
}

function importSpec(
  profileId: string,
  overrides: Partial<Extract<JobSpec, { kind: 'import' }>> = {},
) {
  return {
    kind: 'import' as const,
    profileId,
    file: { path: '/data/people.csv', format: 'csv' as const },
    table: { schema: 'public', name: 'people' },
    mapping: [{ source: 'id', target: 'id' }],
    mode: 'append' as const,
    ...overrides,
  };
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

async function nextEvents(
  stream: AsyncIterator<JobEvent>,
  until: (event: JobEvent) => boolean,
): Promise<JobEvent[]> {
  const events: JobEvent[] = [];
  for (;;) {
    const next = await stream.next();
    if (next.done) return events;
    events.push(next.value);
    if (until(next.value)) return events;
  }
}

describe('jobs', () => {
  it('runs a job with the resolved profile in the runner; the renderer sees progress only', async () => {
    const { main, runners, leaked } = setup({ open: '/data/people.csv' });
    const { saved, passwordId } = await saveProfile(main);
    expect(await main.dialogs.openFile({})).toEqual({ path: '/data/people.csv' });
    const stream = main.jobs.events();
    const { jobId } = await main.jobs.start({ job: importSpec(saved.id) });
    const start = runners[0]!.sent.find((m) => m.type === 'start');
    expect(start?.type === 'start' && start.resolved.secrets[passwordId]).toBe(SECRET);
    const events = await nextEvents(
      stream,
      (event) => event.type === 'job' && event.job.state === 'completed',
    );
    expect(events.map((e) => e.type)).toContain('progress');
    const [listed] = await main.jobs.list();
    expect(listed).toMatchObject({
      id: jobId,
      state: 'completed',
      title: 'Import people.csv into public.people',
      summary: { rowsWritten: 1 },
    });
    await stream.return();
    expect(leaked()).toBe(false);
  });

  it('passes "ask every time" secrets to the runner and nowhere else', async () => {
    const { main, runners, leaked } = setup({ open: '/data/people.csv' });
    const { saved, passwordId } = await saveProfile(main, {}, 'ask');
    await main.dialogs.openFile({});
    await expect(main.jobs.start({ job: importSpec(saved.id) })).rejects.toMatchObject({
      code: 'AUTH_FAILED',
    });
    await main.jobs.start({ job: importSpec(saved.id), secrets: { [passwordId]: ASKED } });
    const start = runners[0]!.sent.find((m) => m.type === 'start');
    expect(start?.type === 'start' && start.resolved.secrets[passwordId]).toBe(ASKED);
    expect(leaked()).toBe(false);
  });

  it('refuses files the window did not pick in a dialog', async () => {
    const { main, runners } = setup({ open: '/data/people.csv', save: '/out/people.csv' });
    const { saved } = await saveProfile(main);
    await expect(main.jobs.start({ job: importSpec(saved.id) })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      message: 'people.csv was not chosen in a file dialog',
    });
    await expect(main.transfer.preview({ path: '/etc/passwd' })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    const exportJob: JobSpec = {
      kind: 'export',
      profileId: saved.id,
      source: { kind: 'tables', tables: ['people'] },
      format: 'csv',
      output: { kind: 'file', path: '/out/people.csv' },
    };
    await expect(main.jobs.start({ job: exportJob })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    // A path picked to read is not one to write.
    await main.dialogs.openFile({});
    await expect(
      main.jobs.start({
        job: { ...exportJob, output: { kind: 'file', path: '/data/people.csv' } },
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(await main.dialogs.saveFile({ defaultName: 'people.csv' })).toEqual({
      path: '/out/people.csv',
    });
    await main.jobs.start({ job: exportJob });
    await expect(
      main.jobs.start({ job: { ...exportJob, output: { kind: 'directory', path: '/out' } } }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(runners[0]!.sent.filter((m) => m.type === 'start')).toHaveLength(1);
  });

  it('writes text or bytes only to a path picked in the save dialog', async () => {
    const folder = mkdtempSync(join(tmpdir(), 'joinery-write-'));
    try {
      const svg = join(folder, 'shop-erd.svg');
      const { main } = setup({ save: svg });
      await expect(main.dialogs.writeFile({ path: svg, text: '<svg/>' })).rejects.toMatchObject({
        code: 'VALIDATION_FAILED',
      });
      await main.dialogs.saveFile({ defaultName: 'shop-erd.svg' });
      expect(await main.dialogs.writeFile({ path: svg, text: '<svg/>' })).toEqual({ bytes: 6 });
      expect(readFileSync(svg, 'utf8')).toBe('<svg/>');
      await main.dialogs.writeFile({
        path: svg,
        base64: Buffer.from([137, 80, 78, 71]).toString('base64'),
      });
      expect([...readFileSync(svg)]).toEqual([137, 80, 78, 71]);
      await expect(
        main.dialogs.writeFile({ path: join(folder, 'other.svg'), text: 'x' }),
      ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
      await expect(
        main.dialogs.writeFile({ path: svg, base64: 'not base64!' }),
      ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });

  it('writes one file per table only into a folder picked in the dialog', async () => {
    const { main, runners } = setup({ folder: '/exports' });
    const { saved } = await saveProfile(main);
    expect(await main.dialogs.openDirectory({ title: 'Export to' })).toEqual({ path: '/exports' });
    await main.jobs.start({
      job: {
        kind: 'export',
        profileId: saved.id,
        source: { kind: 'tables', tables: ['a', 'b'] },
        format: 'csv',
        output: { kind: 'directory', path: '/exports' },
      },
    });
    expect(runners[0]!.sent.some((m) => m.type === 'start')).toBe(true);
  });

  it('applies the write rules whatever the page sends', async () => {
    const { main } = setup({ open: '/data/people.csv' });
    await main.dialogs.openFile({});
    const readOnly = await saveProfile(main, presentation({ readOnly: true }));
    await expect(main.jobs.start({ job: importSpec(readOnly.saved.id) })).rejects.toMatchObject({
      code: 'READ_ONLY',
    });
    await expect(
      main.jobs.start({ job: importSpec(readOnly.saved.id, { confirmed: true }) }),
    ).rejects.toMatchObject({ code: 'READ_ONLY' });

    const production = await saveProfile(main, presentation({ environment: 'production' }));
    await expect(main.jobs.start({ job: importSpec(production.saved.id) })).rejects.toMatchObject({
      code: 'CONFIRMATION_REQUIRED',
    });
    await main.jobs.start({ job: importSpec(production.saved.id, { confirmed: true }) });
    const sqlFile: JobSpec = {
      kind: 'run-sql-file',
      profileId: production.saved.id,
      path: '/data/people.csv',
      onError: 'stop',
    };
    await expect(main.jobs.start({ job: sqlFile })).rejects.toMatchObject({
      code: 'CONFIRMATION_REQUIRED',
    });
    await main.jobs.start({ job: { ...sqlFile, confirmed: true } });

    const dev = await saveProfile(main);
    await expect(
      main.jobs.start({ job: importSpec(dev.saved.id, { mode: 'replace' }) }),
    ).rejects.toMatchObject({ code: 'CONFIRMATION_REQUIRED' });
    await main.jobs.start({ job: importSpec(dev.saved.id, { mode: 'replace', confirmed: true }) });
    // A SQL file on a read-only profile runs; the job runner refuses its writes.
    await main.jobs.start({ job: { ...sqlFile, profileId: readOnly.saved.id } });
  });

  it('keeps the job history in the local store across app runs', async () => {
    const { main, store } = setup({ open: '/data/people.csv' });
    const { saved } = await saveProfile(main);
    await main.dialogs.openFile({});
    const stream = main.jobs.events();
    const { jobId } = await main.jobs.start({ job: importSpec(saved.id) });
    await nextEvents(stream, (e) => e.type === 'job' && e.job.state !== 'running');
    await stream.return();
    const reloaded = new JobManager({
      spawn: () => new AnsweringRunner(),
      history: settingsJobHistory(store),
    });
    expect(reloaded.list().map((job) => job.id)).toEqual([jobId]);
    await main.jobs.clear();
    expect(await main.jobs.list()).toEqual([]);
  });
});

describe('transfer', () => {
  it('previews a picked file in the job runner', async () => {
    const { main, runners } = setup({ open: '/data/people.csv' });
    await main.dialogs.openFile({});
    expect(await main.transfer.preview({ path: '/data/people.csv' })).toEqual(PREVIEW);
    expect(runners[0]!.sent[0]).toMatchObject({
      type: 'request',
      request: { kind: 'preview', input: { path: '/data/people.csv' } },
    });
  });

  it('saves, lists and deletes wizard settings', async () => {
    const { main } = setup();
    const first = await main.transfer.profiles.save({
      kind: 'import',
      name: 'Semicolon CSV',
      settings: { format: 'csv', csv: { delimiter: ';' }, mode: 'upsert' },
    });
    await main.transfer.profiles.save({
      kind: 'export',
      name: 'Gzipped JSON',
      settings: { format: 'json', gzip: true },
    });
    // Saving under the same name replaces it.
    const again = await main.transfer.profiles.save({
      kind: 'import',
      name: 'Semicolon CSV',
      settings: { format: 'csv', csv: { delimiter: ';' }, mode: 'append' },
    });
    expect(again.id).toBe(first.id);
    const listed = await main.transfer.profiles.list();
    expect(listed.map((p) => [p.name, p.kind])).toEqual([
      ['Gzipped JSON', 'export'],
      ['Semicolon CSV', 'import'],
    ]);
    expect(listed[1]?.settings).toEqual({ format: 'csv', csv: { delimiter: ';' }, mode: 'append' });
    await main.transfer.profiles.delete({ id: first.id });
    expect((await main.transfer.profiles.list()).map((p) => p.name)).toEqual(['Gzipped JSON']);
  });

  it('refuses a new-table column type that is not a type', async () => {
    const { main } = setup();
    await expect(
      main.transfer.planTable({
        dialect: 'postgres',
        name: 't',
        columns: [
          {
            inferred: { name: 'a', type: 'text', nullable: true, maxLength: 1, samples: 1 },
            dataType: 'text); DROP TABLE users; --',
          },
        ],
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });
});

describe('job descriptions', () => {
  it('names what a job works on', () => {
    expect(
      describeJob({
        kind: 'export',
        profileId: 'p',
        database: 'shop',
        source: { kind: 'tables', schema: 'public', tables: ['a', 'b', 'c'] },
        format: 'sql-ddl',
        output: { kind: 'file', path: '/out/shop.sql' },
      }),
    ).toEqual({
      title: 'Export 3 tables to SQL with DDL',
      target: { file: '/out/shop.sql', table: 'a, b, c', format: 'sql-ddl', database: 'shop' },
    });
    expect(
      describeJob({ kind: 'run-sql-file', profileId: 'p', path: '/x/migrate.sql', onError: 'stop' })
        .title,
    ).toBe('Run migrate.sql');
  });

  it('words the desktop notification', () => {
    expect(
      notificationFor({
        id: 'j',
        kind: 'import',
        title: 'Import a.csv into a',
        profileId: 'p',
        profileName: 'Shop',
        state: 'completed',
        cancelling: false,
        createdAt: '2026-09-29T10:00:00.000Z',
        summary: {
          status: 'completed',
          rowsRead: 10,
          rowsWritten: 9,
          rowsSkipped: 1,
          durationMs: 1,
        },
        errors: [],
        log: [],
        target: {},
      }),
    ).toEqual({ title: 'Import finished', body: 'Import a.csv into a: 9 rows, 1 skipped' });
  });
});
