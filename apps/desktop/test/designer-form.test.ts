import { schemaSnapshotSchema, tableDefSchema, type TableDef } from '@joinery/core';
import { designTable, type TableDesign } from '@joinery/sync';
import { describe, expect, it } from 'vitest';

import {
  addColumn,
  addListRow,
  formFromTable,
  freshName,
  isDirty,
  issuesAt,
  moveColumn,
  newTableForm,
  removeColumn,
  renameColumn,
  renameTable,
  renamesOf,
  tableFromForm,
  togglePrimaryKey,
  updateColumn,
  updateListRow,
  type DesignerForm,
} from '../src/renderer/src/state/designer/form';
import {
  countFrom,
  describeScriptFailure,
  hasRisks,
  reviewGroups,
} from '../src/renderer/src/state/designer/review';

const orders: TableDef = tableDefSchema.parse({
  name: 'orders',
  columns: [
    {
      name: 'id',
      ordinal: 1,
      dataType: 'bigint',
      nullable: false,
      identity: { generation: 'by-default' },
    },
    { name: 'code', ordinal: 2, dataType: 'character varying(20)', nullable: false },
    { name: 'qty', ordinal: 3, dataType: 'integer', nullable: false, default: '1' },
    { name: 'note', ordinal: 4, dataType: 'text', nullable: true },
  ],
  primaryKey: { name: 'orders_pkey', columns: ['id'] },
  indexes: [
    { name: 'orders_code_qty_idx', columns: [{ name: 'code' }, { name: 'qty', order: 'desc' }] },
  ],
  checks: [{ name: 'orders_qty_check', expression: '(qty > 0)' }],
});

const snapshot = schemaSnapshotSchema.parse({
  engine: 'postgres',
  serverVersion: '16.4',
  database: 'app',
  capturedAt: '2026-09-29T00:00:00Z',
  schemas: [{ name: 'public', tables: [orders] }],
});

function design(form: DesignerForm, live: TableDef | null = orders): TableDesign {
  return designTable(live, tableFromForm(form), {
    engine: 'postgres',
    serverVersion: '16.4',
    schema: 'public',
    snapshot,
    renames: renamesOf(form),
  });
}

const idOf = (form: DesignerForm, name: string): string =>
  form.columns.find((c) => c.def.name === name)!.id;

describe('designer form', () => {
  it('maps a live table to rows and back without changes', () => {
    const form = formFromTable(orders, 'postgres', { live: true });
    expect(form.columns.map((c) => c.liveName)).toEqual(['id', 'code', 'qty', 'note']);
    expect(tableFromForm(form)).toEqual(orders);
    expect(renamesOf(form)).toEqual({});
    expect(design(form).unchanged).toBe(true);
  });

  it('turns a renamed row into a RENAME, and the rename follows into the index', () => {
    const form = formFromTable(orders, 'postgres', { live: true });
    const renamed = renameColumn(form, idOf(form, 'qty'), 'quantity');
    expect(renamesOf(renamed)).toEqual({ columns: { qty: 'quantity' } });
    expect(renamed.indexes[0]!.def.columns.map((c) => c.name)).toEqual(['code', 'quantity']);
    expect(isDirty(renamed, form)).toBe(true);
    const result = design(renamed);
    expect(result.statements).toEqual([
      'BEGIN',
      'ALTER TABLE "public"."orders" RENAME COLUMN "qty" TO "quantity"',
      'COMMIT',
    ]);
    expect(result.dataLoss).toEqual([]);
  });

  it('drops and adds for a removed row and a new one, with a data-loss warning', () => {
    const form = formFromTable(orders, 'postgres', { live: true });
    const removed = removeColumn(form, idOf(form, 'note'));
    const { form: added, id } = addColumn(removed);
    const named = updateColumn(renameColumn(added, id, 'comment'), id, { dataType: 'text' });
    const result = design(named);
    expect(result.statements).toContain('ALTER TABLE "public"."orders" DROP COLUMN "note"');
    expect(result.statements).toContain('ALTER TABLE "public"."orders" ADD COLUMN "comment" text');
    expect(result.dataLoss).toEqual([
      expect.objectContaining({
        severity: 'data-loss',
        objectName: 'note',
        checkQuery: 'SELECT COUNT(*) FROM "public"."orders" WHERE "note" IS NOT NULL',
      }),
    ]);
    const groups = reviewGroups(result);
    expect(groups[0]).toMatchObject({ severity: 'data-loss', title: 'Data loss' });
    // The script's own "drops column" note is covered by the analysis, which can count rows.
    expect(groups[0]!.items.map((item) => item.checkQuery !== undefined)).toEqual([true]);
    expect(hasRisks(result)).toBe(true);
  });

  it('removes a dropped column from keys and indexes, dropping what is left empty', () => {
    const form = formFromTable(orders, 'postgres', { live: true });
    const once = removeColumn(form, idOf(form, 'code'));
    expect(once.indexes[0]!.def.columns.map((c) => c.name)).toEqual(['qty']);
    const twice = removeColumn(once, idOf(once, 'qty'));
    expect(twice.indexes).toEqual([]);
    expect(removeColumn(twice, idOf(twice, 'id')).primaryKey).toBeNull();
  });

  it('orders columns by row and keys by column order', () => {
    const form = formFromTable(orders, 'postgres', { live: true });
    const moved = moveColumn(form, idOf(form, 'note'), -1);
    expect(tableFromForm(moved).columns.map((c) => [c.name, c.ordinal])).toEqual([
      ['id', 1],
      ['code', 2],
      ['note', 3],
      ['qty', 4],
    ]);
    expect(moveColumn(form, idOf(form, 'id'), -1)).toBe(form);
    const keyed = togglePrimaryKey(togglePrimaryKey(form, 'qty'), 'code');
    expect(keyed.primaryKey!.def.columns).toEqual(['id', 'code', 'qty']);
    expect(togglePrimaryKey(form, 'id').primaryKey).toBeNull();
    const withNote = togglePrimaryKey(form, 'note');
    expect(withNote.primaryKey!.def.columns).toEqual(['id', 'note']);
    expect(withNote.columns.find((c) => c.def.name === 'note')!.def.nullable).toBe(false);
    const fresh = togglePrimaryKey({ ...form, primaryKey: null }, 'code');
    expect(fresh.primaryKey!.def).toEqual({ name: 'orders_pkey', columns: ['code'] });
  });

  it('renames indexes and constraints as rows, not as drop and create', () => {
    const form = formFromTable(orders, 'postgres', { live: true });
    const index = form.indexes[0]!;
    const check = form.checks[0]!;
    const renamed = updateListRow(
      updateListRow(form, 'indexes', index.id, { ...index.def, name: 'orders_lookup' }),
      'checks',
      check.id,
      { ...check.def, name: 'qty_positive' },
    );
    expect(renamesOf(renamed)).toEqual({
      indexes: { orders_code_qty_idx: 'orders_lookup' },
      constraints: { orders_qty_check: 'qty_positive' },
    });
    const statements = design(renamed).statements.join('\n');
    expect(statements).toContain('RENAME TO "orders_lookup"');
    expect(statements).toContain('RENAME CONSTRAINT "orders_qty_check" TO "qty_positive"');
    expect(freshName(renamed, 'indexes', 'idx')).toBe('orders_idx');
    const added = addListRow(renamed, 'indexes', {
      name: 'orders_idx',
      columns: [{ name: 'note', order: 'asc' }],
      unique: false,
      include: [],
      invisible: false,
    });
    expect(freshName(added, 'indexes', 'idx')).toBe('orders_idx2');
  });

  it('starts a new table with a numbered key and creates it', () => {
    const form = newTableForm('postgres', 'new_table');
    expect(form.liveName).toBeNull();
    const named = renameTable(form, 'notes');
    expect(named.primaryKey!.def.name).toBe('notes_pkey');
    const { form: withTitle, id } = addColumn(named);
    const result = design(renameColumn(withTitle, id, 'title'), null);
    expect(result.valid).toBe(true);
    expect(result.script).toContain('CREATE TABLE "public"."notes"');
    expect(result.script).toContain('"id" bigint GENERATED BY DEFAULT AS IDENTITY');
    expect(result.script).toContain('CONSTRAINT "notes_pkey" PRIMARY KEY ("id")');
    const mysql = newTableForm('mysql', 't', { charset: 'utf8mb4' });
    expect(mysql.options).toEqual({ engine: 'InnoDB', charset: 'utf8mb4' });
    expect(mysql.columns[0]!.def).toMatchObject({ autoIncrement: true, nullable: false });
    expect(mysql.primaryKey!.def.name).toBe('PRIMARY');
  });

  it('finds the issues of a row or field by path', () => {
    const form = formFromTable(orders, 'postgres', { live: true });
    const broken = updateColumn(form, idOf(form, 'code'), { dataType: 'varchar(abc' });
    const issues = design(broken).issues;
    expect(issuesAt(issues, 'columns[1]').length).toBeGreaterThan(0);
    expect(issuesAt(issues, 'columns[1].dataType')).not.toEqual([]);
    expect(issuesAt(issues, 'columns[0]')).toEqual([]);
    expect(
      issuesAt([{ path: 'columns[10]', code: 'x', message: 'm', severity: 'error' }], 'columns[1]'),
    ).toEqual([]);
  });
});

describe('save review', () => {
  it('reads the count a check query returns', () => {
    expect(countFrom([[3]])).toBe(3);
    expect(countFrom([[4n]])).toBe(4);
    expect(countFrom([['12']])).toBe(12);
    expect(countFrom([])).toBeNull();
  });

  it('says what a failed script left behind', () => {
    const error = { code: 'SQL_ERROR' as const, message: 'column "x" does not exist' };
    expect(describeScriptFailure(1, 3, true, error)).toBe(
      'Statement 2 of 3 failed: column "x" does not exist. The transaction was rolled back; the table was not changed.',
    );
    expect(describeScriptFailure(2, 3, false, error)).toContain(
      'The first 2 statements were applied and cannot be rolled back',
    );
    expect(describeScriptFailure(0, 1, false, error)).toBe(
      'column "x" does not exist. Nothing was changed.',
    );
  });
});
