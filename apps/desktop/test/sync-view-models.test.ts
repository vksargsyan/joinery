import { schemaSnapshotSchema, type SchemaSnapshot } from '@querybara/core';
import type {
  DataCompareInput,
  DataResult,
  DataRowPage,
  JobInfo,
  SavedComparisonSave,
  StructureApplyInput,
  StructureCompareInput,
  StructureResult,
} from '@querybara/ipc';
import { compareSchemas, summarizeDiff, type SchemaDiff } from '@querybara/sync';
import { describe, expect, it } from 'vitest';

import { defaultSelection, structureScript } from '../src/job-runner/sync-structure';
import type { SyncApi } from '../src/renderer/src/state/sync/api';
import { DataCompare, pendingChanges } from '../src/renderer/src/state/sync/data';
import {
  jobFailure,
  pairProblem,
  pairWarnings,
  parseNames,
  sideInput,
  type SideProfile,
} from '../src/renderer/src/state/sync/sides';
import { StructureCompare, groupOperations } from '../src/renderer/src/state/sync/structure';

/**
 * The compare panels' view models (spec §13) against a fake app: setup checks, a compare job
 * followed to its result, ticking with the engine's dependency rules, the script for the
 * selection, apply with its re-compare, exports and saving; and the data compare's counts, row
 * pages, apply and compare again.
 */

const PROFILES: Readonly<Record<string, SideProfile>> = {
  dev: {
    id: 'dev',
    name: 'Dev',
    engine: 'postgres',
    defaultDatabase: 'shop',
    readOnly: false,
    production: false,
    confirmWrites: false,
  },
  prod: {
    id: 'prod',
    name: 'Prod',
    engine: 'postgres',
    defaultDatabase: 'shop',
    readOnly: false,
    production: true,
    confirmWrites: true,
  },
  my: {
    id: 'my',
    name: 'My',
    engine: 'mysql',
    defaultDatabase: undefined,
    readOnly: false,
    production: false,
    confirmWrites: false,
  },
  maria: {
    id: 'maria',
    name: 'Maria',
    engine: 'mariadb',
    defaultDatabase: 'shop',
    readOnly: false,
    production: false,
    confirmWrites: false,
  },
  mongo: {
    id: 'mongo',
    name: 'Mongo',
    engine: 'mongodb',
    defaultDatabase: undefined,
    readOnly: false,
    production: false,
    confirmWrites: false,
  },
};

const lookup = (id: string): SideProfile | undefined => PROFILES[id];

function snapshot(tables: unknown[]): SchemaSnapshot {
  return schemaSnapshotSchema.parse({
    engine: 'postgres',
    database: 'shop',
    capturedAt: '2026-09-29T10:00:00.000Z',
    schemas: [{ name: 'public', tables }],
  });
}

const id = (name: string, ordinal: number, extra: object = {}) => ({
  name,
  ordinal,
  dataType: 'integer',
  nullable: true,
  ...extra,
});

/** Full diffs by job, as main keeps them for script generation. */
const fullDiffs = new Map<string, SchemaDiff>();

/** Source: users(id, email) and orders(id, user_id → users); target: users(id) and old(id). */
function comparison(jobId: string): StructureResult {
  const source = snapshot([
    {
      name: 'users',
      columns: [id('id', 1, { nullable: false }), { ...id('email', 2), dataType: 'text' }],
      primaryKey: { name: 'users_pkey', columns: ['id'] },
    },
    {
      name: 'orders',
      columns: [id('id', 1, { nullable: false }), id('user_id', 2)],
      primaryKey: { name: 'orders_pkey', columns: ['id'] },
      foreignKeys: [
        { name: 'orders_user_fk', columns: ['user_id'], refTable: 'users', refColumns: ['id'] },
      ],
    },
  ]);
  const target = snapshot([
    {
      name: 'users',
      columns: [id('id', 1, { nullable: false })],
      primaryKey: { name: 'users_pkey', columns: ['id'] },
    },
    { name: 'old', columns: [id('id', 1)] },
  ]);
  const { diff } = compareSchemas(source, target);
  fullDiffs.set(jobId, diff);
  const { order: _order, ...view } = diff;
  return {
    jobId,
    source: {
      profileId: 'dev',
      profileName: 'Dev',
      engine: 'postgres',
      serverVersion: '16',
      database: 'shop_dev',
    },
    target: {
      profileId: 'prod',
      profileName: 'Prod',
      engine: 'postgres',
      serverVersion: '16',
      database: 'shop',
    },
    diff: JSON.parse(JSON.stringify(view)) as StructureResult['diff'],
    summary: summarizeDiff(diff),
    script: structureScript(diff, defaultSelection(diff)),
  };
}

function job(jobId: string, patch: Partial<JobInfo> = {}): JobInfo {
  return {
    id: jobId,
    kind: 'structure-compare',
    title: 'Compare',
    profileId: 'prod',
    profileName: 'Prod',
    state: 'completed',
    cancelling: false,
    createdAt: '2026-09-29T10:00:00.000Z',
    errors: [],
    log: [],
    target: {},
    ...patch,
  };
}

const DATA_RESULT = (
  jobId: string,
  counts = { inserts: 2, updates: 1, deletes: 1 },
): DataResult => ({
  jobId,
  source: {
    profileId: 'dev',
    profileName: 'Dev',
    engine: 'postgres',
    serverVersion: '16',
    database: 'shop_dev',
  },
  target: {
    profileId: 'prod',
    profileName: 'Prod',
    engine: 'postgres',
    serverVersion: '16',
    database: 'shop',
  },
  options: { actions: { insert: true, update: true, delete: true } },
  tables: [
    {
      index: 0,
      name: 'public.items',
      source: { schema: 'public', name: 'items' },
      target: { schema: 'public', name: 'items' },
      keyColumns: ['id'],
      commonColumns: ['id', 'name', 'price'],
      compared: ['name', 'price'],
      columns: ['id', 'name', 'price'],
      counts: { ...counts, equal: 3, sourceRows: 6, targetRows: 5 },
      checksums: true,
      ranges: 1,
      matchedRanges: 0,
      stored: { insert: counts.inserts, update: counts.updates, delete: counts.deletes },
      statements: { insert: 1, update: counts.updates, delete: 1 },
      durationMs: 4,
    },
    {
      index: 1,
      name: 'public.codes',
      source: { schema: 'public', name: 'codes' },
      target: { schema: 'public', name: 'codes' },
      keyColumns: ['code'],
      commonColumns: ['code'],
      compared: [],
      columns: ['code'],
      counts: { inserts: 0, updates: 0, deletes: 0, equal: 2, sourceRows: 2, targetRows: 2 },
      checksums: true,
      ranges: 1,
      matchedRanges: 1,
      stored: { insert: 0, update: 0, delete: 0 },
      statements: { insert: 0, update: 0, delete: 0 },
      durationMs: 1,
    },
  ],
  skipped: [
    { name: 'public.logs', reason: 'The source table has no primary or unique NOT NULL key' },
  ],
  pageSize: 100,
});

/** A fake app: jobs finish as `finish` says, results come from `results`. */
function fakeApi() {
  const calls = {
    compareStructure: [] as Omit<StructureCompareInput, 'secrets'>[],
    applyStructure: [] as Omit<StructureApplyInput, 'secrets'>[],
    scripts: [] as string[][],
    compareData: [] as Omit<DataCompareInput, 'secrets'>[],
    applyData: [] as unknown[],
    rows: [] as unknown[],
    discarded: [] as string[],
    exported: [] as unknown[],
    saved: [] as SavedComparisonSave[],
    changed: [] as string[],
  };
  const finish = new Map<string, Partial<JobInfo>>();
  const results = new Map<string, StructureResult | DataResult>();
  let next = 0;
  const api: SyncApi = {
    compareStructure: async (input) => {
      calls.compareStructure.push(input);
      const jobId = `compare-${++next}`;
      results.set(jobId, comparison(jobId));
      return jobId;
    },
    structureResult: async (jobId) => results.get(jobId) as StructureResult,
    structureScript: async (jobId, selected) => {
      calls.scripts.push([...selected]);
      return structureScript(fullDiffs.get(jobId)!, selected);
    },
    applyStructure: async (input, targetProfileId) => {
      expect(targetProfileId).toBe('prod');
      calls.applyStructure.push(input);
      const jobId = `apply-${++next}`;
      const before = results.get(input.jobId) as StructureResult;
      const remaining = before.diff.operations.filter((op) => !input.selected.includes(op.id));
      fullDiffs.set(jobId, fullDiffs.get(input.jobId)!);
      results.set(jobId, {
        ...before,
        jobId,
        diff: { ...before.diff, operations: remaining },
        applied: {
          statements: 4,
          operations: [...input.selected],
          durationMs: 3,
          unconverged: [],
        },
      });
      return jobId;
    },
    exportStructure: async (input) => {
      calls.exported.push(input);
      return 1234;
    },
    compareData: async (input) => {
      calls.compareData.push(input);
      const jobId = `data-${++next}`;
      results.set(
        jobId,
        DATA_RESULT(
          jobId,
          calls.applyData.length > 0 ? { inserts: 0, updates: 0, deletes: 0 } : undefined,
        ),
      );
      return jobId;
    },
    dataResult: async (jobId) => results.get(jobId) as DataResult,
    dataRows: async (input): Promise<DataRowPage> => {
      calls.rows.push(input);
      return {
        rows: [{ action: input.action, key: ['1'], source: ['1', 'a', '1.00'] }],
        page: input.page,
        pageCount: 3,
        total: 250,
      };
    },
    dataPreview: async () => ({ statements: ['BEGIN', 'COMMIT'], total: 2, truncated: false }),
    applyData: async (input, targetProfileId) => {
      expect(targetProfileId).toBe('prod');
      calls.applyData.push(input);
      return `data-apply-${++next}`;
    },
    exportData: async (input) => {
      calls.exported.push(input);
      return 99;
    },
    discard: (jobId) => calls.discarded.push(jobId),
    waitForJob: async (jobId, onUpdate) => {
      onUpdate?.(job(jobId, { state: 'running', progress: { phase: 'Working', elapsedMs: 1 } }));
      return job(jobId, finish.get(jobId.replace(/-\d+$/, '')) ?? {});
    },
    cancel: async () => undefined,
    saveFile: async (options) => `/out/${options.defaultName}`,
    saveComparison: async (input) => {
      calls.saved.push(input);
      return {
        id: 'saved-1',
        name: input.name,
        kind: input.kind,
        source: { ...input.source },
        target: { ...input.target },
        version: 1,
        updatedAt: '2026-09-29T10:00:00.000Z',
      };
    },
    structureChanged: (profileId) => calls.changed.push(profileId),
  };
  return { api, calls, finish };
}

describe('comparison sides', () => {
  it('checks the pair before a compare starts', () => {
    const side = (profileId: string | undefined, database = '', schemas = '') => ({
      profileId,
      database,
      schemas,
    });
    expect(pairProblem(side(undefined), side('prod'), lookup, 'structure')).toBe(
      'Choose the source connection',
    );
    expect(pairProblem(side('dev'), side('gone'), lookup, 'structure')).toBe(
      'The target connection was deleted; choose another',
    );
    expect(pairProblem(side('mongo'), side('dev'), lookup, 'data')).toMatch(/cannot be compared/);
    expect(pairProblem(side('my'), side('maria'), lookup, 'structure')).toBe(
      'Choose the source database',
    );
    expect(pairProblem(side('dev'), side('dev'), lookup, 'structure')).toBe(
      'The source and the target are the same database',
    );
    expect(pairProblem(side('dev'), side('maria'), lookup, 'structure')).toMatch(
      /cannot be compared/,
    );
    expect(pairProblem(side('dev'), side('maria'), lookup, 'data')).toMatch(
      /one PostgreSQL schema/,
    );
    expect(pairProblem(side('dev', '', 'sales'), side('maria'), lookup, 'data')).toBeUndefined();
    expect(pairProblem(side('my', 'a'), side('maria'), lookup, 'structure')).toBeUndefined();
    expect(pairWarnings(side('my', 'a'), side('maria'), lookup)).toHaveLength(1);
    expect(parseNames(' public, sales ,,public')).toEqual(['public', 'sales']);
    expect(sideInput(side('dev', ' shop ', 'public'), PROFILES['dev'])).toEqual({
      profileId: 'dev',
      database: 'shop',
      schemas: ['public'],
    });
    expect(sideInput(side('maria', '', 'public'), PROFILES['maria'])).toEqual({
      profileId: 'maria',
    });
    expect(
      jobFailure(
        job('x', {
          state: 'failed',
          errors: [{ statement: 2, message: 'relation exists' }],
          summary: {
            status: 'failed',
            rowsRead: 0,
            rowsWritten: 0,
            rowsSkipped: 0,
            durationMs: 1,
            outcome: 'Stopped at statement 2 of 5.',
          },
        }),
      ),
    ).toBe('relation exists. Stopped at statement 2 of 5.');
  });
});

describe('structure compare', () => {
  function model() {
    const fake = fakeApi();
    const compare = new StructureCompare(
      { source: { profileId: 'dev', database: 'shop_dev' }, target: { profileId: 'prod' } },
      fake.api,
      lookup,
      { scriptDelayMs: 0 },
    );
    return { ...fake, compare };
  }

  it('compares, starting with destructive operations unticked', async () => {
    const { compare, calls } = model();
    compare.setOption('ignoreComments', true);
    compare.addRename({ objectKind: 'table', from: 'clients', to: 'customers' });
    await compare.compare();
    expect(calls.compareStructure).toEqual([
      {
        source: { profileId: 'dev', database: 'shop_dev' },
        target: { profileId: 'prod' },
        options: expect.objectContaining({
          ignoreComments: true,
          ignoreDefiner: true,
          renames: [{ objectKind: 'table', from: 'clients', to: 'customers' }],
        }),
      },
    ]);
    const { result, selected, running, focused } = compare.state;
    expect(running).toBeUndefined();
    const ops = result!.diff.operations;
    const drop = ops.find((op) => op.kind === 'drop')!;
    expect(drop.destructive).toBe(true);
    expect(selected).not.toContain(drop.id);
    expect(selected).toHaveLength(ops.length - 1);
    expect(focused).toBe(ops[0]!.id);
    expect(compare.scriptCurrent()).toBe(true);
    const groups = groupOperations(ops, new Set(selected));
    expect(groups.map((g) => [g.label, g.operations.length, g.counts, g.selected])).toEqual([
      ['Tables', 2, { create: 1, alter: 0, drop: 1, rename: 0 }, 1],
      ['Columns', 1, { create: 1, alter: 0, drop: 0, rename: 0 }, 1],
      ['Foreign keys', 1, { create: 1, alter: 0, drop: 0, rename: 0 }, 1],
    ]);
    // Changing the setup marks the results stale.
    compare.setOption('ignoreCollation', true);
    expect(compare.state.stale).toBe(true);
  });

  it('keeps dependencies consistent when ticking', async () => {
    const { compare, calls } = model();
    await compare.compare();
    const ops = compare.state.result!.diff.operations;
    const orders = 'table:public.orders:create';
    const fk = 'foreign-key:public.orders.orders_user_fk:create';
    compare.setAll(false);
    expect(compare.state.selected).toEqual([]);
    // Ticking the foreign key ticks the table it needs; unticking the table unticks the key.
    compare.toggle(fk, true);
    expect([...compare.state.selected].sort()).toEqual([fk, orders].sort());
    expect(compare.missing()).toEqual([]);
    expect(compare.scriptCurrent()).toBe(false);
    const script = await compare.refreshScript();
    expect(script?.text).toContain('CREATE TABLE "public"."orders"');
    expect(script?.text).toContain('orders_user_fk');
    expect(calls.scripts.at(-1)).toEqual(compare.state.selected);
    compare.toggle(orders, false);
    expect(compare.state.selected).toEqual([]);
    compare.setAll(true, (op) => !op.destructive);
    expect(compare.state.selected).toHaveLength(ops.length - 1);
    compare.setAll(true);
    expect(compare.state.selected).toHaveLength(ops.length);
  });

  it('applies the reviewed script and shows the re-compare', async () => {
    const { compare, calls } = model();
    await compare.compare();
    const ops = compare.state.result!.diff.operations;
    const keep = ops.find((op) => op.objectKind === 'column')!;
    compare.toggle(keep.id, false);
    const script = await compare.refreshScript();
    expect(await compare.apply(script!, true)).toBe(true);
    expect(calls.applyStructure).toEqual([
      {
        jobId: 'compare-1',
        selected: compare.state.result!.applied!.operations,
        scriptSha256: script!.sha256,
        confirmed: true,
      },
    ]);
    expect(calls.discarded).toEqual(['compare-1']);
    expect(calls.changed).toEqual(['prod']);
    const after = compare.state.result!;
    expect(after.jobId).toBe('apply-2');
    expect(after.diff.operations.map((op) => op.id)).toEqual(expect.arrayContaining([keep.id]));
    expect(compare.state.notice).toMatch(
      /^Applied 4 statements\. Compared again: \d+ differences? remains?/,
    );
    expect(compare.state.error).toBeUndefined();
  });

  it('reports a failed apply and asks to compare again', async () => {
    const { compare, finish } = model();
    await compare.compare();
    finish.set('apply', {
      state: 'failed',
      errors: [{ statement: 3, message: 'column "email" already exists' }],
      summary: {
        status: 'failed',
        rowsRead: 0,
        rowsWritten: 0,
        rowsSkipped: 0,
        durationMs: 1,
        outcome: 'Stopped at statement 3 of 4. The transaction was rolled back.',
      },
    });
    const script = await compare.refreshScript();
    expect(await compare.apply(script!, false)).toBe(false);
    expect(compare.state.error).toBe(
      'column "email" already exists. Stopped at statement 3 of 4. The transaction was rolled back. Compare again to see the target as it is now.',
    );
    expect(compare.state.result?.jobId).toBe('compare-1');
  });

  it('shows a cancelled compare without an error, and refuses an incomplete setup', async () => {
    const { compare, finish, calls } = model();
    finish.set('compare', { state: 'cancelled' });
    await compare.compare();
    expect(compare.state).toMatchObject({
      result: undefined,
      error: undefined,
      notice: 'The comparison was cancelled',
    });
    expect(calls.discarded).toEqual(['compare-1']);
    compare.setSide('target', { profileId: 'maria' });
    await compare.compare();
    expect(compare.state.error).toMatch(/cannot be compared/);
    compare.updateRename(0, { from: 'x' });
    compare.addRename({ objectKind: 'column', table: 'users', from: '', to: 'mail' });
    compare.setSide('target', { profileId: 'prod' });
    expect(compare.problem()).toBe('Each rename needs the target name and the source name');
    compare.removeRename(0);
    expect(compare.problem()).toBeUndefined();
  });

  it('exports the script and the report, saves the comparison and forgets it on close', async () => {
    const { compare, calls } = model();
    await compare.compare();
    await compare.export('html');
    expect(calls.exported).toEqual([
      {
        jobId: 'compare-1',
        selected: compare.state.selected,
        format: 'html',
        path: '/out/shop_dev-to-shop.html',
      },
    ]);
    expect(compare.state.notice).toBe('Wrote 1,234 bytes to /out/shop_dev-to-shop.html');
    expect(await compare.save('Dev to prod')).toBe(true);
    expect(calls.saved[0]).toMatchObject({
      name: 'Dev to prod',
      kind: 'structure',
      source: { profileId: 'dev', database: 'shop_dev' },
      target: { profileId: 'prod' },
      structure: { ignoreComments: false, ignoreDefiner: true },
    });
    expect(compare.state.saved).toEqual({ id: 'saved-1', name: 'Dev to prod' });
    expect(compare.savedInput('again')).toMatchObject({ id: 'saved-1' });
    compare.dispose();
    expect(calls.discarded).toEqual(['compare-1']);
  });
});

describe('data compare', () => {
  function model() {
    const fake = fakeApi();
    const compare = new DataCompare(
      {
        source: { profileId: 'dev', database: 'shop_dev' },
        target: { profileId: 'prod' },
        settings: {
          options: { actions: { insert: true, update: true, delete: false }, floatTolerance: 0.5 },
          tables: [{ name: 'public.items', columns: ['price'] }],
        },
      },
      fake.api,
      lookup,
    );
    return { ...fake, compare };
  }

  it('compares with the options, ticks the tables that differ and shows their rows', async () => {
    const { compare, calls } = model();
    expect(compare.state.options).toMatchObject({
      floatTolerance: '0.5',
      actions: { delete: false },
    });
    compare.setOptions({ ignoreColumns: 'updated_at, version', trim: 'both' });
    expect(await compare.compare()).toBe(true);
    expect(calls.compareData[0]).toEqual({
      source: { profileId: 'dev', database: 'shop_dev' },
      target: { profileId: 'prod' },
      options: {
        actions: { insert: true, update: true, delete: false },
        ignoreColumns: ['updated_at', 'version'],
        floatTolerance: 0.5,
        trim: 'both',
      },
    });
    const state = compare.state;
    expect(state.checked).toEqual([0]);
    expect(state.focused).toBe(0);
    expect(state.rowAction).toBe('insert');
    expect(state.rows?.total).toBe(250);
    expect(compare.pendingTotal()).toBe(3);
    expect(
      pendingChanges(state.result!.tables[0]!, { insert: true, update: false, delete: true }),
    ).toBe(3);
    await compare.showRows('update', 2);
    expect(calls.rows.at(-1)).toEqual({ jobId: 'data-1', table: 0, action: 'update', page: 2 });
    // The actions apply to what is synced, without comparing again; other options need one.
    compare.setOptions({ actions: { insert: true, update: true, delete: true } });
    expect(compare.state.stale).toBe(false);
    expect(compare.pendingTotal()).toBe(4);
    compare.setTableColumns('public.items', ['name']);
    expect(compare.state.stale).toBe(true);
    await compare.compare();
    expect(calls.compareData[1]?.tables).toEqual([
      { name: 'public.items', columns: ['name'] },
      { name: 'public.codes' },
    ]);
    expect(calls.discarded).toEqual(['data-1']);
  });

  it('applies the ticked tables, then compares again', async () => {
    const { compare, calls, finish } = model();
    await compare.compare();
    expect(await compare.preview()).toMatchObject({ total: 2 });
    finish.set('data-apply', {
      state: 'completed',
      summary: {
        status: 'completed',
        rowsRead: 0,
        rowsWritten: 3,
        rowsSkipped: 0,
        durationMs: 2,
        outcome: 'Applied 3 row changes to 1 table',
      },
    });
    expect(await compare.apply(true)).toBe(true);
    expect(calls.applyData).toEqual([
      {
        jobId: 'data-1',
        tables: [0],
        actions: { insert: true, update: true, delete: false },
        confirmed: true,
      },
    ]);
    expect(calls.compareData).toHaveLength(2);
    expect(compare.state.notice).toBe(
      'Applied 3 row changes to 1 table. Compared again: no differences remain in the synced tables.',
    );
    expect(compare.state.checked).toEqual([]);
  });

  it('refuses a bad tolerance, exports the script and saves the settings', async () => {
    const { compare, calls } = model();
    compare.setOptions({ floatTolerance: 'abc' });
    expect(compare.problem()).toBe('The float tolerance is a number ≥ 0');
    compare.setOptions({ floatTolerance: '' });
    await compare.compare();
    await compare.exportScript();
    expect(calls.exported).toEqual([
      {
        jobId: 'data-1',
        tables: [0],
        actions: { insert: true, update: true, delete: false },
        path: '/out/shop_dev-to-shop-data.sql',
      },
    ]);
    await compare.save('Nightly');
    expect(calls.saved[0]).toMatchObject({
      name: 'Nightly',
      kind: 'data',
      data: {
        options: { actions: { insert: true, update: true, delete: false } },
        tables: [{ name: 'public.items', columns: ['price'] }],
      },
    });
    compare.dispose();
    expect(calls.discarded).toEqual(['data-1']);
  });
});
