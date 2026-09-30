import { schemaSnapshotSchema, type SchemaSnapshot } from '@joinery/core';
import {
  compareSchemas,
  type OperationKind,
  type RenameObjectKind,
  type SyncObjectKind,
  type WarningCode,
} from '@joinery/sync';
import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  SYNC_JOB_KINDS,
  comparedDiffSchema,
  dataCompareInputSchema,
  dataRowPageSchema,
  dataSelectionSchema,
  isSyncJobKind,
  jobInfoSchema,
  jobSummarySchema,
  mainContract,
  parseRequest,
  savedComparisonSaveSchema,
  schemaDiffSchema,
  structureApplyInputSchema,
  structureCompareInputSchema,
  structureResultSchema,
  type OPERATION_KINDS,
  type RENAME_OBJECT_KINDS,
  type SYNC_OBJECT_KINDS,
  type SYNC_WARNING_CODES,
} from '../src';

/**
 * The sync additions to the main contract (spec §13): the structure diff crosses in the
 * engine's own shape, options and selections are validated before a job starts, and data rows
 * cross as display text only.
 */

function snapshot(schemas: unknown[]): SchemaSnapshot {
  return schemaSnapshotSchema.parse({
    engine: 'postgres',
    database: 'shop',
    capturedAt: '2026-09-29T10:00:00.000Z',
    schemas,
  });
}

const source = snapshot([
  {
    name: 'public',
    tables: [
      {
        name: 'users',
        columns: [
          { name: 'id', ordinal: 1, dataType: 'integer', nullable: false },
          { name: 'email', ordinal: 2, dataType: 'text', nullable: true },
        ],
        primaryKey: { name: 'users_pkey', columns: ['id'] },
      },
    ],
  },
]);
const target = snapshot([
  {
    name: 'public',
    tables: [
      {
        name: 'users',
        columns: [{ name: 'id', ordinal: 1, dataType: 'integer', nullable: false }],
        primaryKey: { name: 'users_pkey', columns: ['id'] },
      },
      { name: 'old', columns: [{ name: 'id', ordinal: 1, dataType: 'integer', nullable: true }] },
    ],
  },
]);

const PROFILE = '0b8c5f3e-8e9a-4c61-9d7e-8d0cb4f0c001';
const SHA = 'a'.repeat(64);

describe('sync schemas', () => {
  it('mirror the engine’s kinds and codes exactly', () => {
    expectTypeOf<(typeof SYNC_OBJECT_KINDS)[number]>().toEqualTypeOf<SyncObjectKind>();
    expectTypeOf<(typeof OPERATION_KINDS)[number]>().toEqualTypeOf<OperationKind>();
    expectTypeOf<(typeof SYNC_WARNING_CODES)[number]>().toEqualTypeOf<WarningCode>();
    expectTypeOf<(typeof RENAME_OBJECT_KINDS)[number]>().toEqualTypeOf<RenameObjectKind>();
  });

  it('carries a real diff to the job runner and, without the step order, to the page', () => {
    const { diff, summary } = compareSchemas(source, target);
    expect(diff.operations.map((op) => [op.kind, op.objectKind, op.selected])).toEqual([
      ['drop', 'table', false],
      ['create', 'column', true],
    ]);
    expect(schemaDiffSchema.parse(JSON.parse(JSON.stringify(diff)))).toEqual(diff);
    const view = comparedDiffSchema.parse(diff);
    expect('order' in view).toBe(false);
    const result = structureResultSchema.parse({
      jobId: 'j1',
      source: {
        profileId: PROFILE,
        profileName: 'Dev',
        engine: 'postgres',
        serverVersion: '16.4',
        database: 'shop',
      },
      target: {
        profileId: PROFILE,
        profileName: 'Prod',
        engine: 'postgres',
        serverVersion: '16.4',
        database: 'shop',
        schemas: ['public'],
      },
      diff,
      summary,
      script: {
        text: 'BEGIN;\n',
        statementCount: 3,
        operationCount: 1,
        transactional: true,
        backupRecommended: false,
        warnings: [],
        missingDependencies: [],
        sha256: SHA,
      },
    });
    expect(result.summary.byObjectKind).toEqual({ table: 1, column: 1 });
  });

  it('validates what starts a job', () => {
    const side = { profileId: PROFILE, database: 'shop', schemas: ['public'] };
    expect(
      structureCompareInputSchema.safeParse({
        source: side,
        target: side,
        options: { ignoreComments: true, renames: [{ objectKind: 'table', from: 'a', to: 'b' }] },
      }).success,
    ).toBe(true);
    expect(
      structureCompareInputSchema.safeParse({
        source: side,
        target: side,
        options: { renames: [{ objectKind: 'schema', from: 'a', to: 'b' }] },
      }).success,
    ).toBe(false);
    expect(
      structureApplyInputSchema.safeParse({ jobId: 'j1', selected: [], scriptSha256: 'nope' })
        .success,
    ).toBe(false);
    expect(
      dataCompareInputSchema.safeParse({
        source: side,
        target: side,
        options: { actions: { insert: true, update: true, delete: false }, floatTolerance: -1 },
      }).success,
    ).toBe(false);
    expect(
      dataSelectionSchema.safeParse({
        jobId: 'j1',
        tables: [],
        actions: { insert: true, update: true, delete: true },
      }).success,
    ).toBe(false);
    expect(
      savedComparisonSaveSchema.parse({
        name: '  Nightly  ',
        kind: 'structure',
        source: side,
        target: side,
      }).name,
    ).toBe('Nightly');
    expect(() =>
      parseRequest(mainContract, 'sync.structure.apply', {
        jobId: 'j1',
        selected: ['table:public.users:create'],
        scriptSha256: SHA,
        confirmed: 'yes',
      }),
    ).toThrow(expect.objectContaining({ code: 'VALIDATION_FAILED' }));
  });

  it('pages data rows as display text', () => {
    const page = {
      rows: [
        { action: 'update', key: ['1'], source: ['1', 'b'], target: ['1', 'a'], changed: ['v'] },
        { action: 'delete', key: ['2'], target: ['2', null] },
      ],
      page: 0,
      pageCount: 1,
      total: 2,
    };
    expect(dataRowPageSchema.parse(page)).toEqual(page);
    expect(
      dataRowPageSchema.safeParse({ ...page, rows: [{ action: 'insert', key: [1n] }] }).success,
    ).toBe(false);
  });

  it('adds the sync job kinds and a one-line outcome to the job list', () => {
    expect(SYNC_JOB_KINDS.every((kind) => isSyncJobKind(kind))).toBe(true);
    expect(isSyncJobKind('import')).toBe(false);
    expect(jobInfoSchema.shape.kind.options).toEqual(
      expect.arrayContaining(['import', ...SYNC_JOB_KINDS]),
    );
    expect(
      jobSummarySchema.parse({
        status: 'completed',
        rowsRead: 0,
        rowsWritten: 0,
        rowsSkipped: 0,
        durationMs: 5,
        outcome: '2 differences',
      }).outcome,
    ).toBe('2 differences');
    const paths = [...mainContract.methods.keys()].filter((path) => path.startsWith('sync.'));
    expect(paths.sort()).toEqual([
      'sync.data.apply',
      'sync.data.compare',
      'sync.data.export',
      'sync.data.preview',
      'sync.data.result',
      'sync.data.rows',
      'sync.discard',
      'sync.saved.delete',
      'sync.saved.list',
      'sync.saved.save',
      'sync.structure.apply',
      'sync.structure.compare',
      'sync.structure.export',
      'sync.structure.result',
      'sync.structure.script',
    ]);
  });
});
