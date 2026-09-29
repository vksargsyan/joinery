import { randomBytes } from 'node:crypto';

import {
  newId,
  rowAt,
  type CellValue,
  type ResolvedProfile,
  type Session,
  type SqlDialect,
} from '@joinery/core';
import { redisProfileFromUrl } from '@joinery/driver-redis';
import { resolvedProfileFromUrl } from '@joinery/driver-sql-base';
import type { TransferInspection, TransferJob, TransferPlanInfo } from '@joinery/ipc';
import { quoteIdent } from '@joinery/sql-tools';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadAdapter } from '../../src/connection-host/adapters';
import { JobRunner } from '../../src/job-runner/runner';
import type { MainToRunner, RunnerToMain } from '../../src/shared/job-protocol';

/**
 * The job runner's data transfer against the real servers (spec §12): the wizard's inspection
 * and plan, a PostgreSQL → MySQL (or MariaDB) transfer job with its progress and summary, and
 * the write rules applied in the runner: a read-only target and an unconfirmed drop refuse
 * before anything is written.
 */

const PG_URL = process.env['JOINERY_TEST_POSTGRES_URL'];
const MY_URL = process.env['JOINERY_TEST_MYSQL_URL'] ?? process.env['JOINERY_TEST_MARIADB_URL'];
const MY_ENGINE: SqlDialect = process.env['JOINERY_TEST_MYSQL_URL'] ? 'mysql' : 'mariadb';
const REDIS_URL = process.env['JOINERY_TEST_REDIS_URL'];

async function rows(session: Session, sql: string): Promise<CellValue[][]> {
  const out: CellValue[][] = [];
  for await (const chunk of session.execute(sql, { executionId: newId() })) {
    if (chunk.type === 'rows' && chunk.resultIndex === 0) {
      for (let r = 0; r < chunk.rowCount; r++) out.push(rowAt(chunk, r));
    }
  }
  return out;
}

function setup() {
  const posted: RunnerToMain[] = [];
  const runner = new JobRunner({
    post: (message) => posted.push(message),
    connect: async (resolved) => {
      const session = await (await loadAdapter(resolved.profile.engine)).connect(resolved);
      return { session, close: () => session.close() };
    },
  });
  const request = async <T>(request: Parameters<JobRunner['handle']>[0]): Promise<T> => {
    const requestId = newId();
    runner.handle({ type: 'request', requestId, request });
    for (;;) {
      const response = posted.find((m) => m.type === 'response' && m.requestId === requestId);
      if (response?.type === 'response') {
        if (response.error) throw Object.assign(new Error(response.error.message), response.error);
        return response.result as T;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };
  const job = async (message: Extract<MainToRunner, { type: 'start' }>) => {
    runner.handle(message);
    for (;;) {
      const done = posted.find((m) => m.type === 'done' && m.jobId === message.jobId);
      if (done?.type === 'done') return done;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };
  return { posted, request, job };
}

describe.skipIf(!PG_URL || !MY_URL)('transfer jobs', () => {
  const pgDb = `joinery_tdb_${randomBytes(4).toString('hex')}`;
  const myDb = `joinery_tdb_${randomBytes(4).toString('hex')}`;
  const pg = (overrides: Parameters<typeof resolvedProfileFromUrl>[1] = {}): ResolvedProfile =>
    resolvedProfileFromUrl(PG_URL!, overrides);
  const my = (overrides: Parameters<typeof resolvedProfileFromUrl>[1] = {}): ResolvedProfile =>
    resolvedProfileFromUrl(MY_URL!, { engine: MY_ENGINE, ...overrides });
  let check: Session | undefined;

  beforeAll(async () => {
    const admin = await (await loadAdapter('postgres')).connect(pg());
    try {
      await rows(admin, `CREATE DATABASE ${quoteIdent(pgDb, 'postgres')}`);
    } finally {
      await admin.close();
    }
    const source = await (
      await loadAdapter('postgres')
    ).connect(pg({ options: { defaultDatabase: pgDb } }));
    try {
      await rows(
        source,
        'CREATE TABLE orders (id serial PRIMARY KEY, total numeric(10,2), placed timestamptz)',
      );
      await rows(
        source,
        "INSERT INTO orders (total, placed) SELECT g * 1.25, timestamptz '2024-01-01 00:00:00+00' + g * interval '1 hour' FROM generate_series(1, 2500) g",
      );
    } finally {
      await source.close();
    }
    const myAdmin = await (await loadAdapter(MY_ENGINE)).connect(my());
    try {
      await rows(myAdmin, `CREATE DATABASE ${quoteIdent(myDb, 'mysql')}`);
    } finally {
      await myAdmin.close();
    }
    check = await (
      await loadAdapter(MY_ENGINE)
    ).connect(my({ options: { defaultDatabase: myDb } }));
  });

  afterAll(async () => {
    await check?.close();
    const admin = await (await loadAdapter('postgres')).connect(pg());
    await rows(admin, `DROP DATABASE IF EXISTS ${quoteIdent(pgDb, 'postgres')} WITH (FORCE)`).catch(
      () => undefined,
    );
    await admin.close();
    const myAdmin = await (await loadAdapter(MY_ENGINE)).connect(my());
    await rows(myAdmin, `DROP DATABASE IF EXISTS ${quoteIdent(myDb, 'mysql')}`).catch(
      () => undefined,
    );
    await myAdmin.close();
  });

  const job = (patch: Partial<TransferJob> = {}): TransferJob => ({
    kind: 'transfer',
    profileId: 'pg',
    database: pgDb,
    schema: 'public',
    objects: [{ name: 'orders' }],
    target: { profileId: 'my', database: myDb },
    options: { batchSize: 400 },
    ...patch,
  });

  it('inspects both connections and plans the transfer', async () => {
    const { request } = setup();
    const source = await request<TransferInspection>({
      kind: 'transfer-inspect',
      input: { database: pgDb, schema: 'public' },
      resolved: pg(),
    });
    expect(source.engine).toBe('postgres');
    expect(source.database).toBe(pgDb);
    expect(source.databases).toContain(pgDb);
    expect(source.schemas).toContain('public');
    expect(source.objects).toEqual([expect.objectContaining({ name: 'orders', kind: 'table' })]);
    const target = await request<TransferInspection>({
      kind: 'transfer-inspect',
      input: { database: myDb },
      resolved: my(),
    });
    expect(target.databases).toContain(myDb);
    const plan = await request<TransferPlanInfo>({
      kind: 'transfer-plan',
      job: job(),
      resolved: pg(),
      resolvedTarget: my(),
    });
    expect(plan.problems).toEqual([]);
    expect(plan.creates).toEqual(['Create table orders']);
    expect(plan.tables[0]?.columns.map((c) => c.targetType)).toEqual([
      'int',
      'decimal(10,2)',
      'datetime(6)',
    ]);
  });

  it('runs a transfer job with progress and a summary', async () => {
    const { posted, job: run } = setup();
    const done = await run({
      type: 'start',
      jobId: 'j1',
      job: job(),
      resolved: pg(),
      resolvedTarget: my(),
    });
    expect(done.error).toBeUndefined();
    expect(done.summary).toMatchObject({
      status: 'completed',
      rowsRead: 2500,
      rowsWritten: 2500,
      tables: [{ table: 'orders', status: 'completed', rowsWritten: 2500 }],
    });
    expect(
      posted.some((m) => m.type === 'progress' && m.progress.phase.startsWith('Transferring')),
    ).toBe(true);
    expect(await rows(check!, 'SELECT COUNT(*), SUM(total), MAX(placed) FROM orders')).toEqual([
      [2500, '3907812.50', '2024-04-14 04:00:00.000000'],
    ]);
  });

  it('refuses a read-only target and an unconfirmed drop in the runner', async () => {
    const { job: run } = setup();
    const locked = my({
      presentation: {
        folderId: null,
        tags: [],
        environment: 'dev',
        readOnly: true,
        confirmWrites: false,
      },
    });
    const readOnly = await run({
      type: 'start',
      jobId: 'j2',
      job: job(),
      resolved: pg(),
      resolvedTarget: locked,
    });
    expect(readOnly.error?.code).toBe('READ_ONLY');
    const unconfirmed = await run({
      type: 'start',
      jobId: 'j3',
      job: job({ options: { mode: 'drop-create' } }),
      resolved: pg(),
      resolvedTarget: my(),
    });
    expect(unconfirmed.error).toMatchObject({
      code: 'CONFIRMATION_REQUIRED',
      message: expect.stringMatching(/Drop table orders/),
    });
    // Nothing was dropped.
    expect(await rows(check!, 'SELECT COUNT(*) FROM orders')).toEqual([[2500]]);
    const confirmed = await run({
      type: 'start',
      jobId: 'j4',
      job: job({ options: { mode: 'drop-create' }, confirmed: true }),
      resolved: pg(),
      resolvedTarget: my(),
    });
    expect(confirmed.summary?.status).toBe('completed');
  });
});

describe.skipIf(!REDIS_URL)('Redis inspection', () => {
  it('reports the logical databases and the key count', async () => {
    const { request } = setup();
    const info = await request<TransferInspection>({
      kind: 'transfer-inspect',
      input: {},
      resolved: redisProfileFromUrl(REDIS_URL!),
    });
    expect(info.engine).toBe('redis');
    expect(info.databases.length).toBeGreaterThan(1);
    expect(info.keys).toBeGreaterThanOrEqual(0);
  });
});
