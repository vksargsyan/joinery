import { QuerybaraError, type SqlDialect } from '@querybara/core';
import { describe, expect, it } from 'vitest';

import {
  ChangeSet,
  applyChanges,
  countRows,
  estimateRows,
  fetchPage,
  buildBrowseQuery,
  planChanges,
  rowIdentity,
  rowKeyOf,
  type ExistingRow,
} from '../src';
import { FakeSession } from './fake-session';
import { itemsFor } from './fixtures';

function setup(dialect: SqlDialect) {
  const { table, columns } = itemsFor(dialect);
  const identity = rowIdentity(table);
  const values = { region: 'eu', id: 5, name: 'a' } as ExistingRow['values'];
  const row: ExistingRow = { key: rowKeyOf(identity, values)!, values };
  const changes = ChangeSet.empty().edit(row, 'name', 'b').insert({ region: 'eu', id: 6 });
  const plan = planChanges(changes, { dialect, table: { name: 'items' }, columns, identity });
  return { plan, row, columns, identity };
}

const names = itemsFor('postgres').columns.map((c) => c.name);
const fullRow = (id: number, name: string) =>
  names.map((n) => (n === 'id' ? id : n === 'region' ? 'eu' : n === 'name' ? name : null));

describe('applyChanges', () => {
  it('runs the plan in one transaction and returns the rows as written', async () => {
    const { plan, row } = setup('postgres');
    const session = new FakeSession('postgres', (sql) =>
      sql.startsWith('UPDATE')
        ? { columns: names, rows: [fullRow(5, 'b')], rowsAffected: 1 }
        : { columns: names, rows: [fullRow(6, 'trigger')], rowsAffected: 1 },
    );
    const result = await applyChanges(session, plan);
    expect(session.log.map((s) => s.split(' ')[0])).toEqual([
      '<begin>',
      'UPDATE',
      'INSERT',
      '<commit>',
    ]);
    expect(result.rows).toEqual([
      { kind: 'update', key: row.key, newKey: row.key, row: fullRow(5, 'b') },
      { kind: 'insert', key: '+1', newKey: 's2:eu|n6', row: fullRow(6, 'trigger') },
    ]);
  });

  it('rolls back with CONFLICT when a row was changed by someone else', async () => {
    const { plan } = setup('postgres');
    const session = new FakeSession('postgres', (sql) =>
      sql.startsWith('UPDATE')
        ? { columns: names, rows: [], rowsAffected: 0 }
        : { rowsAffected: 1 },
    );
    const error = await applyChanges(session, plan).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(QuerybaraError);
    expect(error).toMatchObject({
      code: 'CONFLICT',
      message:
        "Row region = 'eu', id = 5 was changed or deleted by someone else since it was loaded; nothing was saved",
    });
    expect(session.log.map((s) => s.split(' ')[0])).toEqual(['<begin>', 'UPDATE', '<rollback>']);
  });

  it('names the row when a statement fails, and rolls back', async () => {
    const { plan } = setup('mysql');
    const session = new FakeSession('mysql', (sql) =>
      sql.startsWith('INSERT')
        ? new QuerybaraError({
            code: 'SQL_ERROR',
            message: "Duplicate entry 'eu-6' for key 'PRIMARY'",
          })
        : { rowsAffected: 1, columns: ['id'], rows: [] },
    );
    const error = await applyChanges(session, plan).catch((e: unknown) => e);
    expect(error).toMatchObject({
      code: 'SQL_ERROR',
      message: "Could not insert new row 1: Duplicate entry 'eu-6' for key 'PRIMARY'",
    });
    expect((error as QuerybaraError).detail).toBe(
      "INSERT INTO `items` (`region`, `id`) VALUES ('eu', 6)",
    );
    expect(session.log.at(-1)).toBe('<rollback>');
  });

  it('reads rows back on MySQL and falls back to known values for the new key', async () => {
    const { plan, row } = setup('mysql');
    const session = new FakeSession('mysql', (sql) =>
      sql.startsWith('SELECT') && sql.includes('`id` = ?')
        ? { columns: ['region'], rows: [] }
        : { rowsAffected: 1 },
    );
    const result = await applyChanges(session, plan);
    expect(session.log.filter((s) => s.startsWith('SELECT'))).toHaveLength(2);
    expect(result.rows).toEqual([
      { kind: 'update', key: row.key, newKey: row.key, row: null },
      { kind: 'insert', key: '+1', newKey: 's2:eu|n6', row: null },
    ]);
  });

  it('counts RETURNING rows when the server reports no affected count (MariaDB)', async () => {
    const { plan } = setup('mariadb');
    const session = new FakeSession('mariadb', (sql) =>
      sql.startsWith('INSERT')
        ? { columns: ['region', 'id'], rows: [['eu', 6]], rowsAffected: null }
        : { rowsAffected: 1 },
    );
    const result = await applyChanges(session, plan);
    expect(result.rows[1]!.row).toEqual(['eu', 6]);
  });

  it('uses a savepoint inside an open transaction and leaves it open', async () => {
    const { plan } = setup('postgres');
    const ok = new FakeSession('postgres', () => ({
      columns: names,
      rows: [fullRow(5, 'b')],
      rowsAffected: 1,
    }));
    ok.inTransaction = true;
    await applyChanges(ok, plan);
    expect(ok.log.map((s) => s.split(' ').slice(0, 2).join(' '))).toEqual([
      'SAVEPOINT querybara_apply',
      'UPDATE "items"',
      'INSERT INTO',
      'RELEASE SAVEPOINT',
    ]);
    expect(ok.inTransaction).toBe(true);
    const failing = new FakeSession('postgres', (sql) =>
      sql.startsWith('INSERT')
        ? new QuerybaraError({ code: 'SQL_ERROR', message: 'boom' })
        : { columns: names, rows: [fullRow(5, 'b')], rowsAffected: 1 },
    );
    failing.inTransaction = true;
    await expect(applyChanges(failing, plan)).rejects.toThrow(/boom/);
    expect(failing.log.slice(-2)).toEqual([
      'ROLLBACK TO SAVEPOINT querybara_apply',
      'RELEASE SAVEPOINT querybara_apply',
    ]);
  });

  it('falls back to SQL transaction statements when the session has no transaction methods', async () => {
    const { plan } = setup('mysql');
    const session = new FakeSession('mysql', () => ({ rowsAffected: 1 }), false);
    await applyChanges(session, plan);
    expect(session.log[0]).toBe('START TRANSACTION');
    expect(session.log.at(-1)).toBe('COMMIT');
  });

  it('stops and rolls back when cancelled', async () => {
    const { plan } = setup('postgres');
    const controller = new AbortController();
    const session = new FakeSession('postgres', () => {
      controller.abort();
      return { columns: names, rows: [fullRow(5, 'b')], rowsAffected: 1 };
    });
    await expect(applyChanges(session, plan, { signal: controller.signal })).rejects.toMatchObject({
      code: 'CANCELLED',
    });
    expect(session.log.at(-1)).toBe('<rollback>');
    const aborted = new FakeSession('postgres');
    await expect(
      applyChanges(aborted, plan, { signal: AbortSignal.abort() }),
    ).rejects.toMatchObject({
      code: 'CANCELLED',
    });
    expect(aborted.log).toEqual([]);
  });

  it('does nothing for an empty plan', async () => {
    const { columns, identity } = setup('postgres');
    const session = new FakeSession('postgres');
    const plan = planChanges(ChangeSet.empty(), {
      dialect: 'postgres',
      table: { name: 'items' },
      columns,
      identity,
    });
    expect(await applyChanges(session, plan)).toEqual({ rows: [] });
    expect(session.log).toEqual([]);
  });
});

describe('session helpers', () => {
  const { table, columns } = itemsFor('postgres');

  it('fetches pages in display order', async () => {
    const query = buildBrowseQuery({
      dialect: 'postgres',
      table: { name: 'items' },
      columns,
      identity: rowIdentity(table),
      select: ['id'],
      page: { kind: 'last' },
      limit: 3,
    });
    const session = new FakeSession('postgres', () => ({
      columns: ['id', 'region'],
      rows: [
        [3, 'eu'],
        [2, 'eu'],
      ],
    }));
    const page = await fetchPage(session, query);
    expect(page.rows).toEqual([
      [2, 'eu'],
      [3, 'eu'],
    ]);
    expect(page.complete).toBe(true);
  });

  it('counts and estimates, falling back to the planner when the catalog has no statistic', async () => {
    const session = new FakeSession('postgres', (sql) =>
      sql.startsWith('SELECT count')
        ? { columns: ['count'], rows: [[42n]] }
        : sql.startsWith('EXPLAIN')
          ? { columns: ['QUERY PLAN'], rows: [['[{"Plan": {"Plan Rows": 40}}]']] }
          : { columns: ['estimate'], rows: [[null]] },
    );
    const options = { dialect: 'postgres' as const, table: { name: 'items' }, columns };
    expect(await countRows(session, options)).toBe(42);
    expect(await estimateRows(session, options)).toBe(40);
    expect(session.log.at(-2)).toMatch(/pg_class/);
  });
});
