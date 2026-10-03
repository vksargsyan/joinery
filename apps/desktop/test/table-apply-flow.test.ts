import { tableDefSchema } from '@querybara/core';
import { ChangeSet, describeColumns, rowIdentity, type ApplyResult } from '@querybara/table-data';
import { describe, expect, it } from 'vitest';

import {
  describeApplyFailure,
  mergeApplied,
  planApply,
  writeGate,
  type ApplyTarget,
} from '../src/renderer/src/state/table/apply-flow';
import type { LoadedRows } from '../src/renderer/src/state/table/grid-model';

const table = tableDefSchema.parse({
  name: 'items',
  columns: [
    { name: 'id', ordinal: 1, dataType: 'integer', nullable: false, default: "nextval('s')" },
    { name: 'name', ordinal: 2, dataType: 'text', nullable: true },
    { name: 'qty', ordinal: 3, dataType: 'integer', nullable: false, default: '0' },
  ],
  primaryKey: { name: 'items_pkey', columns: ['id'] },
});
const identity = rowIdentity(table);
const target: ApplyTarget = {
  dialect: 'postgres',
  table: { schema: 'public', name: 'items' },
  columns: describeColumns(table, { dialect: 'postgres' }),
  identity,
  returning: true,
};
const loaded: LoadedRows = {
  columns: ['id', 'name', 'qty'],
  rows: [
    [1, 'a', 1],
    [2, 'b', 2],
    [3, 'c', 3],
  ],
  keys: ['n1', 'n2', 'n3'],
};
const record = (i: number) => ({
  key: loaded.keys[i]!,
  values: { id: loaded.rows[i]![0]!, name: loaded.rows[i]![1]!, qty: loaded.rows[i]![2]! },
});

function staged(): ChangeSet {
  return ChangeSet.empty()
    .edit(record(0), 'name', 'renamed')
    .delete(record(1))
    .insert({ name: 'new' });
}

describe('apply flow', () => {
  it('plans deletes, updates and inserts with a preview of each', () => {
    const plan = planApply(staged(), target);
    expect(plan.statements.map((s) => s.kind)).toEqual(['delete', 'update', 'insert']);
    expect(plan.previewSql.split('\n')).toEqual([
      'DELETE FROM "public"."items" WHERE "id" = 2;',
      `UPDATE "public"."items" SET "name" = 'renamed' WHERE "id" = 1 AND "name" = 'a' RETURNING "id", "name", "qty";`,
      `INSERT INTO "public"."items" ("name") VALUES ('new') RETURNING "id", "name", "qty";`,
    ]);
  });

  it('refuses on a read-only profile and asks on production, after the review', () => {
    const statements = planApply(staged(), target).statements.map((s) => s.preview);
    expect(writeGate(statements, 'postgres', { readOnly: true, production: false })).toEqual({
      action: 'refuse',
      message: 'This connection is read-only, so nothing was written.',
    });
    expect(writeGate(statements, 'postgres', { readOnly: false, production: false })).toEqual({
      action: 'run',
    });
    const production = writeGate(statements, 'postgres', { readOnly: false, production: true });
    expect(production.action).toBe('confirm');
    expect(production.action === 'confirm' && production.statements.map((s) => s.reasons)).toEqual([
      ['write'],
      ['write'],
      ['write'],
    ]);
    expect(
      writeGate(['ALTER TABLE t DROP COLUMN c'], 'postgres', {
        readOnly: false,
        production: false,
        confirmWrites: true,
      }),
    ).toMatchObject({ action: 'confirm', statements: [{ reasons: ['drop', 'write'] }] });
  });

  it('merges the rows as written back into the loaded rows', () => {
    const plan = planApply(staged(), target);
    const result: ApplyResult = {
      rows: [
        { kind: 'delete', key: 'n2', row: null },
        { kind: 'update', key: 'n1', newKey: 'n1', row: [1, 'renamed', 1] },
        { kind: 'insert', key: '+1', newKey: 'n9', row: [9, 'new', 0] },
      ],
    };
    expect(mergeApplied(loaded, plan, result, identity)).toEqual({
      rows: [
        [1, 'renamed', 1],
        [3, 'c', 3],
        [9, 'new', 0],
      ],
      keys: ['n1', 'n3', 'n9'],
      removed: 1,
      unreadable: 0,
    });
  });

  it('keeps what is known of rows that could not be read back, and counts them', () => {
    const plan = planApply(ChangeSet.empty().edit(record(2), 'qty', 30), {
      ...target,
      returning: false,
    });
    const merged = mergeApplied(
      loaded,
      plan,
      { rows: [{ kind: 'update', key: 'n3', newKey: 'n3', row: null }] },
      identity,
    );
    expect(merged.rows[2]).toEqual([3, 'c', 30]);
    expect(merged.unreadable).toBe(1);
  });

  it('tells a conflict from other failures', () => {
    expect(
      describeApplyFailure({
        code: 'CONFLICT',
        message: 'Row id = 1 was changed',
        hint: 'Refresh',
      }),
    ).toEqual({ conflict: true, message: 'Row id = 1 was changed', hint: 'Refresh' });
    expect(describeApplyFailure({ code: 'SQL_ERROR', message: 'boom' })).toEqual({
      conflict: false,
      message: 'boom',
    });
  });
});
