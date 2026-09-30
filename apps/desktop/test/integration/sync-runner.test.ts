import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  newId,
  rowAt,
  type CellValue,
  type ResolvedProfile,
  type Session,
  type SqlDialect,
} from '@joinery/core';
import { resolvedProfileFromUrl } from '@joinery/driver-sql-base';
import type { DataScriptPreview, StructureScript } from '@joinery/ipc';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadAdapter } from '../../src/connection-host/adapters';
import { JobRunner } from '../../src/job-runner/runner';
import type { RunnerToMain } from '../../src/shared/job-protocol';
import {
  dataJobResultSchema,
  structureJobResultSchema,
  type SyncJobSpec,
} from '../../src/shared/sync-jobs';
import { rowPageFile, rowPageFileSchema } from '../../src/shared/sync-spool';

/**
 * Structure and data sync in the job runner against the real servers (spec §13): two
 * databases with differences are compared, one operation is left unticked, the rest applied,
 * and the re-compare shows only that one; a data compare finds an insert, an update and a
 * delete, applies them in batched transactions and compares clean. The write rules hold in the
 * runner whatever main sent.
 */

const ENGINES = [
  ['postgres', process.env['JOINERY_TEST_POSTGRES_URL']],
  ['mysql', process.env['JOINERY_TEST_MYSQL_URL']],
  ['mariadb', process.env['JOINERY_TEST_MARIADB_URL']],
] as const;

let work = '';

beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), 'joinery-sync-it-'));
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

function schemaSql(dialect: SqlDialect, side: 'source' | 'target'): string[] {
  const pg = dialect === 'postgres';
  const text = pg ? 'text' : 'varchar(200)';
  const fk = pg
    ? 'customer_id integer NOT NULL REFERENCES customers (id)'
    : 'customer_id integer NOT NULL, CONSTRAINT orders_customer_fk FOREIGN KEY (customer_id) REFERENCES customers (id)';
  const common = [
    `CREATE TABLE items (id integer PRIMARY KEY, name ${text} NOT NULL, price ${pg ? 'numeric' : 'decimal'}(8,2))`,
    'CREATE TABLE nokey (a integer)',
  ];
  if (side === 'source') {
    return [
      `CREATE TABLE customers (id integer PRIMARY KEY, name ${text} NOT NULL, email ${text})`,
      `CREATE TABLE orders (id integer PRIMARY KEY, total ${pg ? 'numeric' : 'decimal'}(10,2) NOT NULL, note varchar(100), ${fk})`,
      'CREATE VIEW big_orders AS SELECT id, total FROM orders WHERE total > 100',
      ...common,
      "INSERT INTO items VALUES (1, 'one', 1.00), (2, 'two', 2.00), (3, 'three', 3.00), (4, 'four', 4.00), (5, 'five', 5.00)",
    ];
  }
  return [
    `CREATE TABLE customers (id integer PRIMARY KEY, name ${text} NOT NULL)`,
    `CREATE TABLE orders (id integer PRIMARY KEY, total ${pg ? 'numeric' : 'decimal'}(10,2) NOT NULL, ${fk})`,
    'CREATE TABLE legacy (id integer PRIMARY KEY)',
    ...common,
    "INSERT INTO items VALUES (1, 'one', 1.00), (2, 'TWO', 2.50), (3, 'three', 3.00), (4, 'four', 4.00), (6, 'six', 6.00)",
  ];
}

describe.each(ENGINES)('%s', (dialect: SqlDialect, url: string | undefined) => {
  const sourceDb = `joinery_sy_${randomBytes(4).toString('hex')}`;
  const targetDb = `joinery_sy_${randomBytes(4).toString('hex')}`;
  const posted: RunnerToMain[] = [];
  let admin: Session | undefined;
  let checkTarget: Session | undefined;
  const pg = dialect === 'postgres';
  const profile = (
    database: string,
    overrides: Parameters<typeof resolvedProfileFromUrl>[1] = {},
  ): ResolvedProfile =>
    resolvedProfileFromUrl(url!, { ...overrides, options: { defaultDatabase: database } });
  const runner = new JobRunner({
    post: (message) => posted.push(message),
    connect: async (resolved) => {
      const session = await (await loadAdapter(resolved.profile.engine)).connect(resolved);
      return { session, close: () => session.close() };
    },
  });
  const side = (database: string) => ({ database, ...(pg ? { schemas: ['public'] } : {}) });

  async function job(
    spec: SyncJobSpec,
    resolved: ResolvedProfile,
    source?: ResolvedProfile,
  ): Promise<Extract<RunnerToMain, { type: 'done' }>> {
    const jobId = newId();
    runner.handle({ type: 'start', jobId, job: spec, resolved, ...(source ? { source } : {}) });
    for (;;) {
      const done = posted.find((m) => m.type === 'done' && m.jobId === jobId);
      if (done?.type === 'done') return done;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

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

  async function compareStructure() {
    const done = await job(
      {
        kind: 'structure-compare',
        profileId: 'target',
        sourceProfileId: 'source',
        source: side(sourceDb),
        target: side(targetDb),
        options: {},
      },
      profile(targetDb),
      profile(sourceDb),
    );
    expect(done.error).toBeUndefined();
    return { done, result: structureJobResultSchema.parse(done.result) };
  }

  beforeAll(async () => {
    if (!url) return;
    admin = await (await loadAdapter(dialect)).connect(resolvedProfileFromUrl(url));
    for (const [database, which] of [
      [sourceDb, 'source'],
      [targetDb, 'target'],
    ] as const) {
      await rows(admin, `CREATE DATABASE ${database}`);
      const session = await (await loadAdapter(dialect)).connect(profile(database));
      try {
        for (const sql of schemaSql(dialect, which)) await rows(session, sql);
      } finally {
        await session.close();
      }
    }
    checkTarget = await (await loadAdapter(dialect)).connect(profile(targetDb));
  });

  afterAll(async () => {
    await checkTarget?.close();
    if (admin) {
      for (const name of [sourceDb, targetDb]) {
        await rows(
          admin,
          pg ? `DROP DATABASE IF EXISTS ${name} WITH (FORCE)` : `DROP DATABASE IF EXISTS ${name}`,
        ).catch(() => undefined);
      }
      await admin.close();
    }
  });

  it.skipIf(!url)(
    'compares, applies all but one operation, and re-compares to only that one',
    async () => {
      const { done, result } = await compareStructure();
      expect(done.summary).toMatchObject({ status: 'completed' });
      const ops = result.diff.operations;
      const find = (kind: string, name: string) =>
        ops.find((op) => op.objectKind === kind && op.qualifiedName.endsWith(name));
      const email = find('column', 'customers.email');
      const note = find('column', 'orders.note');
      const view = find('view', 'big_orders');
      const legacy = find('table', 'legacy');
      expect(email).toMatchObject({ kind: 'create', selected: true });
      expect(note).toMatchObject({ kind: 'create', selected: true });
      expect(view).toMatchObject({ kind: 'create', selected: true });
      expect(legacy).toMatchObject({ kind: 'drop', destructive: true, selected: false });
      expect(result.source).toMatchObject({ profileName: expect.any(String), database: sourceDb });
      expect(result.summary.total).toBe(ops.length);
      expect(result.script.transactional).toBe(pg);

      const selected = ops.filter((op) => op.selected && op.id !== email!.id).map((op) => op.id);
      const script = await request<StructureScript>({
        kind: 'sync-script',
        input: { diff: result.diff, selected },
      });
      expect(script.text).toContain('note');
      expect(script.text).not.toMatch(/\bemail\b/);

      // Write rules hold in the runner: read-only refuses, production needs confirmation.
      const applySpec = (
        overrides: Partial<Extract<SyncJobSpec, { kind: 'structure-apply' }>> = {},
      ): SyncJobSpec => ({
        kind: 'structure-apply',
        profileId: 'target',
        target: side(targetDb),
        diff: result.diff,
        selected,
        sourceSnapshot: result.sourceSnapshot!,
        scriptSha256: script.sha256,
        confirmed: false,
        ...overrides,
      });
      const readOnly = await job(
        applySpec(),
        profile(targetDb, {
          presentation: { environment: 'dev', readOnly: true, confirmWrites: false },
        }),
      );
      expect(readOnly.error).toMatchObject({ code: 'READ_ONLY' });
      const production = await job(
        applySpec(),
        profile(targetDb, {
          presentation: { environment: 'production', readOnly: false, confirmWrites: false },
        }),
      );
      expect(production.error).toMatchObject({ code: 'CONFIRMATION_REQUIRED' });
      const tampered = await job(applySpec({ scriptSha256: 'f'.repeat(64) }), profile(targetDb));
      expect(tampered.error).toMatchObject({ code: 'VALIDATION_FAILED' });
      // None of the refused applies ran anything.
      await expect(rows(checkTarget!, 'SELECT note FROM orders')).rejects.toThrow();

      const applied = await job(applySpec(), profile(targetDb));
      expect(applied.error).toBeUndefined();
      expect(applied.summary).toMatchObject({ status: 'completed', failed: 0 });
      const after = structureJobResultSchema.parse(applied.result);
      expect(after.applied?.unconverged).toEqual([]);
      expect(after.applied?.operations).toEqual(expect.arrayContaining([note!.id, view!.id]));
      expect(after.diff.operations.map((op) => op.id).sort()).toEqual(
        [email!.id, legacy!.id].sort(),
      );
      const progress = posted.filter(
        (m) => m.type === 'progress' && m.progress.phase.startsWith('Applying'),
      );
      expect(progress.length).toBeGreaterThan(0);
    },
  );

  it.skipIf(!url)('stops at the first failing statement', async () => {
    const { result } = await compareStructure();
    const email = result.diff.operations.find((op) =>
      op.qualifiedName.endsWith('customers.email'),
    )!;
    // The column appears behind the comparison's back, so creating it fails.
    await rows(
      checkTarget!,
      `ALTER TABLE customers ADD COLUMN email ${pg ? 'text' : 'varchar(200)'}`,
    );
    try {
      const script = await request<StructureScript>({
        kind: 'sync-script',
        input: { diff: result.diff, selected: [email.id] },
      });
      const failed = await job(
        {
          kind: 'structure-apply',
          profileId: 'target',
          target: side(targetDb),
          diff: result.diff,
          selected: [email.id],
          sourceSnapshot: result.sourceSnapshot!,
          scriptSha256: script.sha256,
          confirmed: false,
        },
        profile(targetDb),
      );
      expect(failed.summary).toMatchObject({ status: 'failed', failed: 1 });
      expect(failed.errors[0]).toMatchObject({ statement: expect.any(Number) });
      expect(failed.summary?.outcome).toMatch(pg ? /rolled back/ : /stay applied/);
    } finally {
      await rows(checkTarget!, 'ALTER TABLE customers DROP COLUMN email');
    }
  });

  it.skipIf(!url)('compares data, applies the differences and compares clean', async () => {
    const spoolDir = mkdtempSync(join(work, `spool-${dialect}-`));
    const compare = (dir: string) =>
      job(
        {
          kind: 'data-compare',
          profileId: 'target',
          sourceProfileId: 'source',
          source: side(sourceDb),
          target: side(targetDb),
          options: { actions: { insert: true, update: true, delete: true } },
          spoolDir: dir,
        },
        profile(targetDb),
        profile(sourceDb),
      );
    const done = await compare(spoolDir);
    expect(done.error).toBeUndefined();
    const result = dataJobResultSchema.parse(done.result);
    const items = result.tables.find((t) => t.name.endsWith('items'))!;
    expect(items).toMatchObject({
      keyColumns: ['id'],
      compared: ['name', 'price'],
      counts: { inserts: 1, updates: 1, deletes: 1, equal: 3 },
      stored: { insert: 1, update: 1, delete: 1 },
    });
    expect(result.skipped).toEqual(
      expect.arrayContaining([
        {
          name: pg ? 'public.nokey' : 'nokey',
          reason: 'The source table has no primary or unique NOT NULL key',
        },
      ]),
    );
    const updates = rowPageFileSchema.parse(
      JSON.parse(readFileSync(join(spoolDir, rowPageFile(items.index, 'update', 0)), 'utf8')),
    );
    expect(updates).toEqual([
      {
        action: 'update',
        key: ['2'],
        source: ['2', 'two', '2.00'],
        target: ['2', 'TWO', '2.50'],
        changed: ['name', 'price'],
      },
    ]);

    const preview = await request<DataScriptPreview>({
      kind: 'sync-data-script',
      input: {
        spoolDir,
        tables: [items.index],
        actions: { insert: true, update: true, delete: true },
      },
    });
    expect(preview.statements[0]).toBe(pg ? 'BEGIN' : 'START TRANSACTION');
    expect(preview.statements.some((s) => s.startsWith('DELETE FROM'))).toBe(true);
    const scriptPath = join(work, `data-${dialect}.sql`);
    await request({
      kind: 'sync-data-script',
      input: {
        spoolDir,
        tables: [items.index],
        actions: { insert: true, update: true, delete: true },
        path: scriptPath,
      },
    });
    expect(readFileSync(scriptPath, 'utf8')).toMatch(/INSERT INTO[\s\S]*five/);

    const applied = await job(
      {
        kind: 'data-apply',
        profileId: 'target',
        target: side(targetDb),
        spoolDir,
        tables: [items.index],
        actions: { insert: true, update: true, delete: true },
        confirmed: false,
      },
      profile(targetDb),
    );
    expect(applied.error).toBeUndefined();
    expect(applied.summary).toMatchObject({ status: 'completed', rowsWritten: 3 });
    expect(await rows(checkTarget!, 'SELECT id, name FROM items ORDER BY id')).toEqual([
      [1, 'one'],
      [2, 'two'],
      [3, 'three'],
      [4, 'four'],
      [5, 'five'],
    ]);
    const again = dataJobResultSchema.parse(
      (await compare(mkdtempSync(join(work, `spool-${dialect}-`)))).result,
    );
    expect(again.tables.find((t) => t.name.endsWith('items'))?.counts).toMatchObject({
      inserts: 0,
      updates: 0,
      deletes: 0,
      equal: 5,
    });
  });
});
