import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  newId,
  rowAt,
  type CellValue,
  type ResolvedProfile,
  type Session,
  type SqlDialect,
} from '@querybara/core';
import { resolvedProfileFromUrl } from '@querybara/driver-sql-base';
import type { JobSpec, NewTablePlan, TransferPreview } from '@querybara/ipc';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadAdapter } from '../../src/connection-host/adapters';
import { JobRunner } from '../../src/job-runner/runner';
import type { RunnerToMain } from '../../src/shared/job-protocol';

/**
 * The job runner against the real servers (spec §3, §12): the wizard's preview and new table
 * plan, an import into a new table and an upsert into it, a cancelled import that rolls back,
 * a failed import that takes its new table back out, an export to SQL with DDL run into another
 * database as a SQL file, and a read-only profile's SQL file stopped at its first write.
 */

const ENGINES = [
  ['postgres', process.env['QUERYBARA_TEST_POSTGRES_URL']],
  ['mysql', process.env['QUERYBARA_TEST_MYSQL_URL']],
  ['mariadb', process.env['QUERYBARA_TEST_MARIADB_URL']],
] as const;

let work = '';

beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), 'querybara-runner-it-'));
});

afterAll(() => {
  if (work) rmSync(work, { recursive: true, force: true });
});

async function rows(session: Session, sql: string): Promise<CellValue[][]> {
  const out: CellValue[][] = [];
  for await (const chunk of session.execute(sql, { executionId: newId() })) {
    if (chunk.type === 'rows' && chunk.resultIndex === 0) {
      for (let r = 0; r < chunk.rowCount; r++) out.push(rowAt(chunk, r));
    }
  }
  return out;
}

describe.each(ENGINES)('%s', (dialect: SqlDialect, url: string | undefined) => {
  const source = `querybara_jr_${randomBytes(4).toString('hex')}`;
  const target = `querybara_jr_${randomBytes(4).toString('hex')}`;
  const posted: RunnerToMain[] = [];
  let admin: Session | undefined;
  let check: Session | undefined;
  let checkTarget: Session | undefined;
  const profile = (overrides: Parameters<typeof resolvedProfileFromUrl>[1] = {}): ResolvedProfile =>
    resolvedProfileFromUrl(url!, overrides);
  const runner = new JobRunner({
    post: (message) => posted.push(message),
    connect: async (resolved) => {
      const session = await (await loadAdapter(resolved.profile.engine)).connect(resolved);
      return { session, close: () => session.close() };
    },
  });

  const connect = async (database?: string): Promise<Session> =>
    (await loadAdapter(dialect)).connect(
      profile(database === undefined ? {} : { options: { defaultDatabase: database } }),
    );

  async function request<T>(request: Parameters<JobRunner['handle']>[0]): Promise<T> {
    const requestId = newId();
    runner.handle({ type: 'request', requestId, request });
    for (;;) {
      const response = posted.find((m) => m.type === 'response' && m.requestId === requestId);
      if (response?.type === 'response') {
        if (response.error) throw new Error(response.error.message);
        return response.result as T;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  async function job(
    spec: JobSpec,
    resolved = profile(),
    whileRunning?: (jobId: string) => void,
  ): Promise<Extract<RunnerToMain, { type: 'done' }>> {
    const jobId = newId();
    runner.handle({ type: 'start', jobId, job: spec, resolved });
    whileRunning?.(jobId);
    for (;;) {
      const done = posted.find((m) => m.type === 'done' && m.jobId === jobId);
      if (done?.type === 'done') return done;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  const schema = dialect === 'postgres' ? { schema: 'public' } : {};

  beforeAll(async () => {
    if (!url) return;
    admin = await connect();
    await rows(admin, `CREATE DATABASE ${source}`);
    await rows(admin, `CREATE DATABASE ${target}`);
    check = await connect(source);
    checkTarget = await connect(target);
  });

  afterAll(async () => {
    await check?.close();
    await checkTarget?.close();
    if (admin) {
      for (const name of [source, target]) {
        await rows(
          admin,
          dialect === 'postgres'
            ? `DROP DATABASE IF EXISTS ${name} WITH (FORCE)`
            : `DROP DATABASE IF EXISTS ${name}`,
        ).catch(() => undefined);
      }
      await admin.close();
    }
  });

  it.skipIf(!url)(
    'plans a new table from the preview and imports into it, then upserts',
    async () => {
      const path = join(work, `people-${dialect}.csv`);
      writeFileSync(
        path,
        'id;name;joined;score\n1;Ada;2024-01-02;9.5\n2;"Grace; Hopper";2024-02-03;\n',
      );
      const preview = await request<TransferPreview>({ kind: 'preview', input: { path } });
      expect(preview.csv?.delimiter).toBe(';');
      const plan = await request<NewTablePlan>({
        kind: 'plan-table',
        input: {
          dialect,
          name: 'people',
          ...schema,
          columns: preview.columns.map((inferred) => ({ inferred })),
          primaryKey: ['id'],
        },
      });
      expect(plan.primaryKey).toEqual(['id']);
      const created = await job({
        kind: 'import',
        profileId: 'p',
        database: source,
        file: { path, format: 'csv', csv: preview.csv! },
        table: { ...schema, name: 'people' },
        create: { columns: plan.columns, primaryKey: plan.primaryKey },
        mapping: plan.columns.map((c) => ({ source: c.source, target: c.name })),
        mode: 'append',
      });
      expect(created.summary).toMatchObject({ status: 'completed', rowsWritten: 2 });

      const update = join(work, `update-${dialect}.csv`);
      writeFileSync(update, 'id,name\n2,Grace Hopper\n3,Linus\n');
      const upserted = await job({
        kind: 'import',
        profileId: 'p',
        database: source,
        file: { path: update, format: 'csv' },
        table: { ...schema, name: 'people' },
        mapping: [
          { source: 'id', target: 'id' },
          { source: 'name', target: 'name' },
        ],
        mode: 'upsert',
        keyColumns: ['id'],
      });
      expect(upserted.summary).toMatchObject({ status: 'completed', rowsWritten: 2 });
      expect(await rows(check!, 'SELECT id, name FROM people ORDER BY id')).toEqual([
        [1, 'Ada'],
        [2, 'Grace Hopper'],
        [3, 'Linus'],
      ]);
    },
  );

  it.skipIf(!url)('rolls a cancelled import back, and takes a failed new table out', async () => {
    await rows(check!, 'CREATE TABLE big (id INT PRIMARY KEY, label VARCHAR(20))');
    const path = join(work, `big-${dialect}.csv`);
    const lines = ['id,label'];
    for (let i = 1; i <= 50_000; i++) lines.push(`${i},row ${i}`);
    writeFileSync(path, `${lines.join('\n')}\n`);
    const cancelled = await job(
      {
        kind: 'import',
        profileId: 'p',
        database: source,
        file: { path, format: 'csv' },
        table: { ...schema, name: 'big' },
        mapping: [
          { source: 'id', target: 'id' },
          { source: 'label', target: 'label' },
        ],
        mode: 'append',
        batchSize: 50,
      },
      profile(),
      (jobId) => {
        const wait = (): void => {
          const importing = posted.some(
            (m) => m.type === 'progress' && m.jobId === jobId && (m.progress.rowsWritten ?? 0) > 0,
          );
          if (importing) runner.handle({ type: 'cancel', jobId });
          else setTimeout(wait, 5);
        };
        wait();
      },
    );
    expect(cancelled.summary?.status).toBe('cancelled');
    expect(await rows(check!, 'SELECT COUNT(*) FROM big')).toEqual([[0]]);

    const bad = join(work, `bad-${dialect}.csv`);
    writeFileSync(bad, 'n\n1\nnot a number\n');
    const failed = await job({
      kind: 'import',
      profileId: 'p',
      database: source,
      file: { path: bad, format: 'csv' },
      table: { ...schema, name: 'numbers' },
      create: {
        columns: [{ source: 'n', name: 'n', dataType: 'integer', nullable: true }],
        primaryKey: [],
      },
      mapping: [{ source: 'n', target: 'n' }],
      mode: 'append',
    });
    expect(failed.summary?.status).toBe('failed');
    expect(failed.errors[0]).toMatchObject({ row: 2, line: 3, column: 'n' });
    const logs = posted.flatMap((m) => (m.type === 'log' ? [m.message] : []));
    expect(logs).toContain('Dropped the new table numbers again');
  });

  it.skipIf(!url)('exports SQL with DDL and runs it into another database', async () => {
    const dump = join(work, `dump-${dialect}.sql`);
    const exported = await job({
      kind: 'export',
      profileId: 'p',
      database: source,
      source: { kind: 'tables', ...schema, tables: ['people'] },
      format: 'sql-ddl',
      output: { kind: 'file', path: dump },
    });
    expect(exported.summary).toMatchObject({ status: 'completed', rowsWritten: 3, files: [dump] });
    const ran = await job({
      kind: 'run-sql-file',
      profileId: 'p',
      database: target,
      path: dump,
      onError: 'stop',
    });
    expect(ran.summary).toMatchObject({ status: 'completed', failed: 0 });
    const query = 'SELECT id, name, joined FROM people ORDER BY id';
    expect(await rows(checkTarget!, query)).toEqual(await rows(check!, query));
  });

  it.skipIf(!url)(
    'exports a table to a workbook and imports it into a new table in another database',
    async () => {
      const book = join(work, `people-${dialect}.xlsx`);
      const exported = await job({
        kind: 'export',
        profileId: 'p',
        database: source,
        source: { kind: 'tables', ...schema, tables: ['people'] },
        format: 'xlsx',
        output: { kind: 'file', path: book },
      });
      expect(exported.summary).toMatchObject({ status: 'completed', rowsWritten: 3 });
      const preview = await request<TransferPreview>({ kind: 'preview', input: { path: book } });
      expect(preview).toMatchObject({ format: 'xlsx', xlsx: { sheet: 'people', headerRow: 1 } });
      const plan = await request<NewTablePlan>({
        kind: 'plan-table',
        input: {
          dialect,
          name: 'people_copy',
          ...schema,
          columns: preview.columns.map((inferred) => ({ inferred })),
          primaryKey: ['id'],
        },
      });
      const imported = await job({
        kind: 'import',
        profileId: 'p',
        database: target,
        file: { path: book, format: 'xlsx', xlsx: preview.xlsx! },
        table: { ...schema, name: 'people_copy' },
        create: { columns: plan.columns, primaryKey: plan.primaryKey },
        mapping: plan.columns.map((c) => ({ source: c.source, target: c.name })),
        mode: 'append',
      });
      expect(imported.summary).toMatchObject({ status: 'completed', rowsWritten: 3 });
      const cast = dialect === 'postgres' ? '::text' : '';
      expect(
        await rows(checkTarget!, `SELECT id, name, joined${cast} FROM people_copy ORDER BY id`),
      ).toEqual(await rows(check!, `SELECT id, name, joined${cast} FROM people ORDER BY id`));
    },
  );

  it.skipIf(!url)('stops a read-only profile at the first statement that writes', async () => {
    const script = join(work, `writes-${dialect}.sql`);
    writeFileSync(script, "SELECT 1;\nINSERT INTO people (id, name) VALUES (99, 'x');\n");
    const done = await job(
      { kind: 'run-sql-file', profileId: 'p', database: source, path: script, onError: 'continue' },
      profile({
        presentation: {
          folderId: null,
          tags: [],
          environment: 'dev',
          readOnly: true,
          confirmWrites: false,
        },
      }),
    );
    expect(done.summary?.status).toBe('failed');
    expect(done.errors.at(-1)?.message).toBe(
      'This connection is read-only, so statement 2 was not run: it writes',
    );
    expect(await rows(check!, 'SELECT COUNT(*) FROM people WHERE id = 99')).toEqual([[0]]);
  });
});
