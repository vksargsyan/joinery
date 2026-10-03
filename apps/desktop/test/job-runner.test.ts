import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  QuerybaraError,
  connectionProfileSchema,
  tableDefSchema,
  type ConnectionProfileInput,
  type ResolvedProfile,
} from '@querybara/core';
import {
  rdbReportSchema,
  type ExportJob,
  type ImportJob,
  type RunSqlFileJob,
  type TransferPreview,
} from '@querybara/ipc';
import {
  EXPORT_FORMATS,
  FILE_FORMATS,
  INFERRED_TYPES,
  PARQUET_COMPRESSIONS,
  ZipReader,
  openFileReader,
} from '@querybara/transfer';
import {
  INFERRED_COLUMN_TYPES,
  PARQUET_COMPRESSIONS as IPC_PARQUET_COMPRESSIONS,
  TRANSFER_EXPORT_FORMATS,
  TRANSFER_FILE_FORMATS,
} from '@querybara/ipc';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { JobRunner } from '../src/job-runner/runner';
import { exportFileName } from '../src/job-runner/tasks';
import type { RunnerToMain } from '../src/shared/job-protocol';
import { FakeJobSession } from './fake-job-session';
import { profileInput } from './helpers';

/**
 * The job runner's message handling with a fake driver session and real temporary files:
 * imports, exports and SQL files end in a `done` with the transfer summary after progress and
 * log messages; cancel rolls back; failures and the read-only rule end the job with a reason;
 * the wizards' requests are answered; nothing the runner sends holds a secret.
 */

const SECRET = 'hunter2-runner';
let dir = '';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'querybara-runner-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function resolved(overrides: Partial<ConnectionProfileInput> = {}): ResolvedProfile {
  return {
    profile: connectionProfileSchema.parse(profileInput({ id: 'p1', ...overrides })),
    secrets: { s1: SECRET },
  };
}

function setup(options: { connect?: () => Promise<never> } = {}) {
  const posted: RunnerToMain[] = [];
  const session = new FakeJobSession();
  const connects: ResolvedProfile[] = [];
  const runner = new JobRunner({
    post: (message) => posted.push(structuredClone(message)),
    connect: async (profile) => {
      connects.push(profile);
      if (options.connect) return options.connect();
      return { session, close: () => session.close() };
    },
  });
  const done = async (jobId: string) =>
    vi.waitFor(() => {
      const message = posted.find((m) => m.type === 'done' && m.jobId === jobId);
      if (!message || message.type !== 'done') throw new Error('not done yet');
      return message;
    });
  const response = async (requestId: string) =>
    vi.waitFor(() => {
      const message = posted.find((m) => m.type === 'response' && m.requestId === requestId);
      if (!message || message.type !== 'response') throw new Error('no response yet');
      return message;
    });
  return { runner, posted, session, connects, done, response };
}

function file(name: string, text: string): string {
  const path = join(dir, name);
  writeFileSync(path, text);
  return path;
}

function importJob(path: string, overrides: Partial<ImportJob> = {}): ImportJob {
  return {
    kind: 'import',
    profileId: 'p1',
    file: { path, format: 'csv', csv: { header: true } },
    table: { schema: 'public', name: 'people' },
    mapping: [
      { source: 'id', target: 'id' },
      { source: 'name', target: 'name' },
    ],
    mode: 'append',
    ...overrides,
  };
}

describe('JobRunner imports', () => {
  it('imports a CSV file with progress, a log and the summary, on its own session', async () => {
    const { runner, posted, session, connects, done } = setup();
    const path = file('people.csv', 'id,name\n1,Ada\n2,Grace\n');
    runner.handle({
      type: 'start',
      jobId: 'j1',
      job: { ...importJob(path), database: 'shop' },
      resolved: resolved(),
    });
    const message = await done('j1');
    expect(message.summary).toMatchObject({ status: 'completed', rowsRead: 2, rowsWritten: 2 });
    expect(message.errors).toEqual([]);
    expect(session.committed).toEqual([
      [1, 'Ada'],
      [2, 'Grace'],
    ]);
    expect(connects[0]?.profile.options.defaultDatabase).toBe('shop');
    expect(session.closed).toBe(true);
    const phases = posted.flatMap((m) => (m.type === 'progress' ? [m.progress.phase] : []));
    expect(phases[0]).toBe('Connecting');
    expect(phases).toContain('Importing');
    const importing = posted.findLast((m) => m.type === 'progress');
    expect(importing?.type === 'progress' && importing.progress.totalBytes).toBe(
      'id,name\n1,Ada\n2,Grace\n'.length,
    );
    const logs = posted.flatMap((m) => (m.type === 'log' ? [m.message] : []));
    expect(logs.some((line) => line.startsWith('Connected to'))).toBe(true);
    expect(logs.some((line) => line.startsWith('Imported 2 rows'))).toBe(true);
    expect(runner.running).toBe(0);
    expect(JSON.stringify(posted)).not.toContain(SECRET);
  });

  it('creates the new table first when asked to', async () => {
    const { runner, session, done } = setup();
    const path = file('new.csv', 'code,label\nA,Alpha\n');
    runner.handle({
      type: 'start',
      jobId: 'j2',
      job: importJob(path, {
        table: { schema: 'public', name: 'codes' },
        create: {
          columns: [
            { source: 'code', name: 'code', dataType: 'text', nullable: false },
            { source: 'label', name: 'label', dataType: 'varchar(40)', nullable: true },
          ],
          primaryKey: ['code'],
        },
        mapping: [
          { source: 'code', target: 'code' },
          { source: 'label', target: 'label' },
        ],
      }),
      resolved: resolved(),
    });
    const message = await done('j2');
    expect(message.summary?.status).toBe('completed');
    const create = session.statements.find((s) => s.text.startsWith('CREATE TABLE'))?.text;
    expect(create).toContain('"public"."codes"');
    expect(create).toContain('varchar(40)');
    expect(session.committed).toEqual([['A', 'Alpha']]);
  });

  it('skips failing rows and reports their row, line and column', async () => {
    const { runner, done } = setup();
    const path = file('bad.csv', 'id,name\n1,Ada\nx,Grace\n3,Linus\n');
    runner.handle({
      type: 'start',
      jobId: 'j3',
      job: importJob(path, { onError: 'skip' }),
      resolved: resolved(),
    });
    const message = await done('j3');
    expect(message.summary).toMatchObject({
      status: 'completed',
      rowsWritten: 2,
      rowsSkipped: 1,
    });
    expect(message.errors).toEqual([expect.objectContaining({ row: 2, line: 3, column: 'id' })]);
  });

  it('refuses an import on a read-only profile', async () => {
    const { runner, session, done } = setup();
    const path = file('people.csv', 'id,name\n1,Ada\n');
    runner.handle({
      type: 'start',
      jobId: 'j4',
      job: importJob(path),
      resolved: resolved({
        presentation: {
          folderId: null,
          tags: [],
          environment: 'dev',
          readOnly: true,
          confirmWrites: false,
        },
      }),
    });
    const message = await done('j4');
    expect(message.summary).toBeUndefined();
    expect(message.error?.code).toBe('READ_ONLY');
    expect(session.statements.some((s) => s.text.startsWith('INSERT'))).toBe(false);
  });

  it('cancels a running import and rolls it back', async () => {
    const { runner, posted, session, done } = setup();
    session.writeDelayMs = 15;
    const lines = Array.from({ length: 200 }, (_, i) => `${i + 1},name ${i + 1}`);
    const path = file('many.csv', `id,name\n${lines.join('\n')}\n`);
    runner.handle({
      type: 'start',
      jobId: 'j5',
      job: importJob(path, { batchSize: 1 }),
      resolved: resolved(),
    });
    await vi.waitFor(() =>
      expect(session.statements.some((s) => s.text.startsWith('INSERT'))).toBe(true),
    );
    runner.handle({ type: 'cancel', jobId: 'j5' });
    const message = await done('j5');
    expect(message.summary?.status).toBe('cancelled');
    expect(session.committed).toEqual([]);
    expect(session.statements.map((s) => s.text)).toContain('ROLLBACK');
    expect(posted.filter((m) => m.type === 'done')).toHaveLength(1);
  });

  it('ends the job with the connection error when it cannot connect', async () => {
    const { runner, done } = setup({
      connect: () =>
        Promise.reject(new QuerybaraError({ code: 'AUTH_FAILED', message: 'password refused' })),
    });
    runner.handle({
      type: 'start',
      jobId: 'j6',
      job: importJob(file('x.csv', 'id\n1\n')),
      resolved: resolved(),
    });
    const message = await done('j6');
    expect(message.error).toEqual({ code: 'AUTH_FAILED', message: 'password refused' });
    expect(message.summary).toBeUndefined();
  });
});

describe('JobRunner exports', () => {
  function exportJob(overrides: Partial<ExportJob> = {}): ExportJob {
    return {
      kind: 'export',
      profileId: 'p1',
      source: { kind: 'tables', schema: 'public', tables: ['people'] },
      format: 'csv',
      output: { kind: 'file', path: join(dir, 'people.csv') },
      ...overrides,
    };
  }

  it('exports a table to a CSV file', async () => {
    const { runner, session, done } = setup();
    session.result = {
      columns: [
        { name: 'id', nativeType: 'int4', kind: 'integer' },
        { name: 'name', nativeType: 'text', kind: 'string' },
      ],
      rows: [
        [1, 'Ada'],
        [2, null],
      ],
    };
    runner.handle({
      type: 'start',
      jobId: 'e1',
      job: exportJob({ csv: { nullMarker: 'NULL', lineEnding: '\n' } }),
      resolved: resolved(),
    });
    const message = await done('e1');
    expect(message.summary).toMatchObject({ status: 'completed', rowsWritten: 2 });
    expect(message.summary?.files).toEqual([join(dir, 'people.csv')]);
    expect(readFileSync(join(dir, 'people.csv'), 'utf8')).toBe('id,name\n1,Ada\n2,NULL\n');
    expect(session.statements[0]?.text).toBe('SELECT * FROM "public"."people"');
  });

  it('writes one file per table into a folder, and re-runs a query result', async () => {
    const { runner, session, done } = setup();
    session.result = {
      columns: [{ name: 'n', nativeType: 'int4', kind: 'integer' }],
      rows: [[1], [2]],
    };
    runner.handle({
      type: 'start',
      jobId: 'e2',
      job: exportJob({
        source: { kind: 'tables', schema: 'public', tables: ['a', 'b/c'] },
        format: 'jsonl',
        output: { kind: 'directory', path: dir },
      }),
      resolved: resolved(),
    });
    expect((await done('e2')).summary?.tables?.map((t) => t.table)).toEqual(['a', 'b/c']);
    expect(readdirSync(dir).sort()).toEqual(['a.jsonl', 'b_c.jsonl']);
    expect(readFileSync(join(dir, 'a.jsonl'), 'utf8')).toBe('{"n":1}\n{"n":2}\n');

    runner.handle({
      type: 'start',
      jobId: 'e3',
      job: exportJob({
        source: { kind: 'query', text: 'SELECT n FROM t WHERE n > $1', params: [0] },
        format: 'json',
        output: { kind: 'file', path: join(dir, 'result.json') },
      }),
      resolved: resolved(),
    });
    expect((await done('e3')).summary?.status).toBe('completed');
    expect(JSON.parse(readFileSync(join(dir, 'result.json'), 'utf8'))).toEqual([
      { n: 1 },
      { n: 2 },
    ]);
    expect(session.statements.at(-1)).toEqual({
      text: 'SELECT n FROM t WHERE n > $1',
      params: [0],
    });
  });

  it('will not run a writing statement again to export its rows', async () => {
    const { runner, session, done } = setup();
    runner.handle({
      type: 'start',
      jobId: 'e4',
      job: exportJob({
        source: { kind: 'query', text: 'DELETE FROM people WHERE id = 1 RETURNING *' },
        output: { kind: 'file', path: join(dir, 'deleted.csv') },
      }),
      resolved: resolved(),
    });
    const message = await done('e4');
    expect(message.error).toMatchObject({
      code: 'VALIDATION_FAILED',
      message: 'The statement writes, so it is not run again to export its rows',
    });
    expect(session.statements.some((s) => s.text.startsWith('DELETE'))).toBe(false);
  });

  it('names per-table files so every file system takes them', () => {
    expect(exportFileName('orders', 'csv', false)).toBe('orders.csv');
    expect(exportFileName('a:b*c', 'sql-ddl', true)).toBe('a_b_c.sql.gz');
    expect(exportFileName('..', 'json', false)).toBe('_.json');
  });
});

describe('JobRunner SQL files', () => {
  function runJob(path: string, overrides: Partial<RunSqlFileJob> = {}): RunSqlFileJob {
    return { kind: 'run-sql-file', profileId: 'p1', path, onError: 'continue', ...overrides };
  }

  it('logs a failing statement and continues', async () => {
    const { runner, posted, session, done } = setup();
    session.failWhen = (text) =>
      text.includes('missing_table') ? 'relation "missing_table" does not exist' : undefined;
    const path = file(
      'script.sql',
      'CREATE TABLE a (x int);\nINSERT INTO missing_table VALUES (1);\nINSERT INTO a (x) VALUES (2);\n',
    );
    runner.handle({ type: 'start', jobId: 's1', job: runJob(path), resolved: resolved() });
    const message = await done('s1');
    expect(message.summary).toMatchObject({ status: 'completed', statements: 3, failed: 1 });
    expect(message.errors).toEqual([
      expect.objectContaining({
        statement: 2,
        line: 2,
        message: 'relation "missing_table" does not exist',
      }),
    ]);
    const logs = posted.flatMap((m) => (m.type === 'log' ? [m.message] : []));
    expect(logs).toContain('Statement 2 (line 2): relation "missing_table" does not exist');
  });

  it('stops at the first statement that writes on a read-only profile', async () => {
    const { runner, session, done } = setup();
    const path = file('writes.sql', 'SELECT 1;\nINSERT INTO a (x) VALUES (1);\nSELECT 2;\n');
    runner.handle({
      type: 'start',
      jobId: 's2',
      job: runJob(path),
      resolved: resolved({
        presentation: {
          folderId: null,
          tags: [],
          environment: 'dev',
          readOnly: true,
          confirmWrites: false,
        },
      }),
    });
    const message = await done('s2');
    expect(message.summary?.status).toBe('failed');
    expect(message.errors.at(-1)).toMatchObject({
      statement: 2,
      message: 'This connection is read-only, so statement 2 was not run: it writes',
    });
    expect(session.statements.map((s) => s.text)).toEqual(['SELECT 1']);
  });
});

describe('JobRunner requests', () => {
  it('previews a file, matches columns and plans a new table', async () => {
    const { runner, response } = setup();
    const path = file('people.csv', 'id;name;joined\n1;Ada;2024-01-02\n2;Grace;2024-03-04\n');
    runner.handle({
      type: 'request',
      requestId: 'r1',
      request: { kind: 'preview', input: { path } },
    });
    const preview = (await response('r1')).result as {
      format: string;
      csv: { delimiter: string; header: boolean };
      columns: { name: string; type: string }[];
      rows: (string | null)[][];
      size: number;
    };
    expect(preview.format).toBe('csv');
    expect(preview.csv).toMatchObject({ delimiter: ';', header: true });
    expect(preview.columns.map((c) => [c.name, c.type])).toEqual([
      ['id', 'integer'],
      ['name', 'text'],
      ['joined', 'date'],
    ]);
    expect(preview.rows[1]).toEqual(['2', 'Grace', '2024-03-04']);
    expect(preview.size).toBe(51);

    runner.handle({
      type: 'request',
      requestId: 'r2',
      request: {
        kind: 'auto-match',
        input: { sources: ['ID', 'Full Name'], targets: ['id', 'full_name'] },
      },
    });
    expect((await response('r2')).result).toEqual([
      { source: 'ID', target: 'id' },
      { source: 'Full Name', target: 'full_name' },
    ]);

    runner.handle({
      type: 'request',
      requestId: 'r3',
      request: {
        kind: 'plan-table',
        input: {
          dialect: 'postgres',
          name: 'people',
          schema: 'app',
          columns: [
            {
              inferred: { name: 'id', type: 'integer', nullable: false, maxLength: 1, samples: 2 },
            },
            {
              inferred: { name: 'name', type: 'text', nullable: false, maxLength: 5, samples: 2 },
              name: 'full_name',
              dataType: 'varchar(80)',
            },
          ],
          primaryKey: ['id'],
        },
      },
    });
    const plan = (await response('r3')).result as {
      columns: unknown[];
      primaryKey: string[];
      statements: string[];
    };
    expect(plan.columns).toEqual([
      { source: 'id', name: 'id', dataType: 'integer', nullable: false },
      { source: 'name', name: 'full_name', dataType: 'varchar(80)', nullable: true },
    ]);
    expect(plan.primaryKey).toEqual(['id']);
    expect(plan.statements[0]).toMatch(/^CREATE TABLE "app"\."people"/);
    expect(plan.statements[0]).toContain('"full_name" varchar(80)');
  });

  it('answers a request that fails with the error', async () => {
    const { runner, response } = setup();
    runner.handle({
      type: 'request',
      requestId: 'r4',
      request: { kind: 'preview', input: { path: join(dir, 'nope.csv') } },
    });
    expect((await response('r4')).error?.code).toBe('NOT_FOUND');
  });

  it('ignores messages that do not match the protocol', () => {
    const { runner, posted } = setup();
    runner.handle({ type: 'start', jobId: 'x' });
    runner.handle('shutdown');
    runner.handle({ type: 'request', requestId: 'r', request: { kind: 'rm -rf' } });
    expect(posted).toEqual([]);
    expect(runner.running).toBe(0);
  });

  it('shutdown cancels running jobs, then exits', async () => {
    const exit = vi.fn();
    const session = new FakeJobSession();
    session.writeDelayMs = 20;
    const posted: RunnerToMain[] = [];
    const runner = new JobRunner({
      post: (message) => posted.push(message),
      connect: async () => ({ session, close: () => session.close() }),
      exit,
    });
    const lines = Array.from({ length: 100 }, (_, i) => `${i + 1},n`);
    runner.handle({
      type: 'start',
      jobId: 'j9',
      job: importJob(file('many.csv', `id,name\n${lines.join('\n')}\n`), { batchSize: 1 }),
      resolved: resolved(),
    });
    await vi.waitFor(() =>
      expect(session.statements.some((s) => s.text.startsWith('INSERT'))).toBe(true),
    );
    runner.handle({ type: 'shutdown' });
    await vi.waitFor(() => expect(exit).toHaveBeenCalled());
    const done = posted.find((m) => m.type === 'done');
    expect(done?.type === 'done' && done.summary?.status).toBe('cancelled');
  });
});

describe('JobRunner Excel, XML and ZIP', () => {
  const columns = [
    { name: 'id', nativeType: 'int4', kind: 'integer' as const },
    { name: 'name', nativeType: 'text', kind: 'string' as const },
  ];

  it('exports a table to a workbook, previews it and imports it back', async () => {
    const { runner, session, done, response } = setup();
    session.result = {
      columns,
      rows: [
        [1, 'Ada'],
        [2, null],
        [3, 'Grace & <co>'],
      ],
    };
    const path = join(dir, 'people.xlsx');
    runner.handle({
      type: 'start',
      jobId: 'x1',
      job: {
        kind: 'export',
        profileId: 'p1',
        source: { kind: 'tables', schema: 'public', tables: ['people'] },
        format: 'xlsx',
        xlsx: { header: true },
        output: { kind: 'file', path },
      },
      resolved: resolved(),
    });
    expect((await done('x1')).summary).toMatchObject({ status: 'completed', rowsWritten: 3 });

    runner.handle({
      type: 'request',
      requestId: 'p',
      request: { kind: 'preview', input: { path } },
    });
    const preview = (await response('p')).result as TransferPreview;
    expect(preview).toMatchObject({
      format: 'xlsx',
      sheets: ['people'],
      xlsx: { sheet: 'people', headerRow: 1 },
      rows: [
        ['1', 'Ada'],
        ['2', null],
        ['3', 'Grace & <co>'],
      ],
    });
    expect(preview.columns.map((c) => [c.name, c.type])).toEqual([
      ['id', 'integer'],
      ['name', 'text'],
    ]);

    runner.handle({
      type: 'start',
      jobId: 'x2',
      job: importJob(path, { file: { path, format: 'xlsx', xlsx: preview.xlsx } }),
      resolved: resolved(),
    });
    expect((await done('x2')).summary).toMatchObject({ status: 'completed', rowsWritten: 3 });
    expect(session.committed).toEqual([
      [1, 'Ada'],
      [2, null],
      [3, 'Grace & <co>'],
    ]);
  });

  it('exports a table to Parquet, previews it and imports it back', async () => {
    const { runner, session, done, response } = setup();
    session.result = {
      columns: [
        ...columns,
        { name: 'price', nativeType: 'numeric(8,2)', kind: 'decimal' as const },
      ],
      rows: [
        [1, 'Ada', '12.50'],
        [2, null, null],
        [3, 'Grace & <co>', '-0.01'],
      ],
    };
    const path = join(dir, 'people.parquet');
    runner.handle({
      type: 'start',
      jobId: 'q1',
      job: {
        kind: 'export',
        profileId: 'p1',
        source: { kind: 'tables', schema: 'public', tables: ['people'] },
        format: 'parquet',
        parquet: { compression: 'zstd' },
        output: { kind: 'file', path },
      },
      resolved: resolved(),
    });
    expect((await done('q1')).summary).toMatchObject({ status: 'completed', rowsWritten: 3 });
    expect(readFileSync(path).subarray(0, 4).toString()).toBe('PAR1');

    runner.handle({
      type: 'request',
      requestId: 'q',
      request: { kind: 'preview', input: { path } },
    });
    const preview = (await response('q')).result as TransferPreview;
    expect(preview).toMatchObject({
      format: 'parquet',
      parquet: { rows: 3, rowGroups: 1, compressions: ['ZSTD'] },
      rows: [
        ['1', 'Ada', '12.50'],
        ['2', null, null],
        ['3', 'Grace & <co>', '-0.01'],
      ],
    });
    expect(preview.columns.map((c) => [c.name, c.type, c.precision, c.scale])).toEqual([
      ['id', 'integer', undefined, undefined],
      ['name', 'text', undefined, undefined],
      ['price', 'decimal', 8, 2],
    ]);

    session.table = tableDefSchema.parse({
      ...session.table,
      columns: [
        ...session.table.columns,
        { name: 'price', ordinal: 3, dataType: 'numeric(8,2)', nullable: true },
      ],
    });
    runner.handle({
      type: 'start',
      jobId: 'q2',
      job: importJob(path, {
        file: { path, format: 'parquet' },
        mapping: [
          { source: 'id', target: 'id' },
          { source: 'name', target: 'name' },
          { source: 'price', target: 'price' },
        ],
      }),
      resolved: resolved(),
    });
    expect((await done('q2')).summary).toMatchObject({ status: 'completed', rowsWritten: 3 });
    expect(session.committed).toEqual([
      [1, 'Ada', '12.50'],
      [2, null, null],
      [3, 'Grace & <co>', '-0.01'],
    ]);
  });

  it('imports XML rows from the chosen path, reporting bad rows by row and line', async () => {
    const { runner, session, done } = setup();
    const path = file(
      'people.xml',
      '<people>\n  <person id="1"><name>Ada</name></person>\n  <person id="x"><name>Bad</name></person>\n</people>\n',
    );
    runner.handle({
      type: 'start',
      jobId: 'x3',
      job: importJob(path, {
        file: { path, format: 'xml', xml: { rowPath: '/people/person' } },
        onError: 'skip',
      }),
      resolved: resolved(),
    });
    const message = await done('x3');
    expect(message.summary).toMatchObject({ status: 'completed', rowsWritten: 1, rowsSkipped: 1 });
    expect(message.errors).toEqual([
      { row: 2, line: 3, column: 'id', message: 'id: "x" is not an integer' },
    ]);
    expect(session.committed).toEqual([[1, 'Ada']]);
  });

  it('zips a file per table, or a query result, into one archive', async () => {
    const { runner, session, done } = setup();
    session.result = { columns, rows: [[1, 'Ada']] };
    const path = join(dir, 'tables.zip');
    runner.handle({
      type: 'start',
      jobId: 'x4',
      job: {
        kind: 'export',
        profileId: 'p1',
        source: { kind: 'tables', schema: 'public', tables: ['a', 'b'] },
        format: 'markdown',
        zip: true,
        output: { kind: 'file', path },
      },
      resolved: resolved(),
    });
    expect((await done('x4')).summary).toMatchObject({ status: 'completed', files: [path] });
    const zip = await ZipReader.open(await openFileReader(path));
    expect(zip.entries.map((e) => e.name)).toEqual(['a.md', 'b.md']);
    expect(await zip.text(zip.entry('a.md')!)).toBe('| id | name |\n| ---: | --- |\n| 1 | Ada |\n');
    await zip.close();

    const queryZip = join(dir, 'query.zip');
    runner.handle({
      type: 'start',
      jobId: 'x5',
      job: {
        kind: 'export',
        profileId: 'p1',
        source: { kind: 'query', text: 'SELECT 1' },
        format: 'html',
        zip: true,
        output: { kind: 'file', path: queryZip },
      },
      resolved: resolved(),
    });
    expect((await done('x5')).summary?.status).toBe('completed');
    const single = await ZipReader.open(await openFileReader(queryZip));
    expect(single.entries.map((e) => e.name)).toEqual(['query_result.html']);
    await single.close();
    expect(readdirSync(dir).sort()).toEqual(['query.zip', 'tables.zip']);
  });
});

describe('JobRunner RDB analysis', () => {
  const fixture = join(
    import.meta.dirname,
    '../../../packages/redis-tools/test/fixtures/rdb/redis-7.4.rdb',
  );

  it('reads an RDB file with progress and answers with its report', async () => {
    const { runner, posted, response } = setup();
    runner.handle({
      type: 'request',
      requestId: 'r1',
      request: { kind: 'rdb-analyze', input: { path: fixture } },
    });
    const answer = await response('r1');
    expect(answer.error).toBeUndefined();
    const report = rdbReportSchema.parse(answer.result);
    expect(report).toMatchObject({
      file: 'redis-7.4.rdb',
      size: readFileSync(fixture).length,
      bytes: readFileSync(fixture).length,
      version: 12,
      keys: 20,
    });
    // Key names cross as display text.
    expect(report.patterns.some((p) => p.pattern === 'user:*:profile')).toBe(true);
    expect(report.biggest[0]!.key).toBe('hash:big');
    const progress = posted.filter((m) => m.type === 'request-progress');
    expect(progress[0]).toMatchObject({ requestId: 'r1', progress: { bytes: 0 } });
  });

  it('refuses a file that is not an RDB, and cancels on request', async () => {
    const { runner, response } = setup();
    runner.handle({
      type: 'request',
      requestId: 'r2',
      request: { kind: 'rdb-analyze', input: { path: file('notes.txt', 'hello, world') } },
    });
    expect((await response('r2')).error).toMatchObject({
      code: 'VALIDATION_FAILED',
      message: expect.stringContaining('This is not an RDB file'),
    });

    // A large synthetic dump, cancelled as soon as it starts.
    const keys = Array.from({ length: 200_000 }, (_, i) => `k${i}`);
    const body = keys.map((k) => `\x00${String.fromCharCode(k.length)}${k}\x01v`).join('');
    const big = join(dir, 'big.rdb');
    writeFileSync(
      big,
      Buffer.from(`REDIS0011\xfe\x00${body}\xff\x00\x00\x00\x00\x00\x00\x00\x00`, 'latin1'),
    );
    runner.handle({
      type: 'request',
      requestId: 'r3',
      request: { kind: 'rdb-analyze', input: { path: big } },
    });
    runner.handle({ type: 'cancel-request', requestId: 'r3' });
    expect((await response('r3')).error).toMatchObject({ code: 'CANCELLED' });
  });
});

describe('protocol mirrors', () => {
  it('lists the same inferred column types as @querybara/transfer', () => {
    expect([...INFERRED_COLUMN_TYPES]).toEqual([...INFERRED_TYPES]);
  });

  it('lists the same file and export formats as @querybara/transfer', () => {
    expect([...TRANSFER_FILE_FORMATS]).toEqual([...FILE_FORMATS]);
    expect([...TRANSFER_EXPORT_FORMATS]).toEqual([...EXPORT_FORMATS]);
  });

  it('lists the same Parquet codecs as @querybara/transfer', () => {
    expect([...IPC_PARQUET_COMPRESSIONS]).toEqual([...PARQUET_COMPRESSIONS]);
  });
});
