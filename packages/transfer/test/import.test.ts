import { tableDefSchema, type TableDef } from '@joinery/core';
import { describe, expect, it } from 'vitest';

import {
  MAX_PARAMETERS,
  importRows,
  type ImportOptions,
  type RowBatch,
  type RowError,
  type SourceCell,
  type TransferProgress,
} from '../src';
import { columnFromError } from '../src/import';
import { FakeSession } from './fake-session';

const table: TableDef = tableDefSchema.parse({
  name: 'items',
  columns: [
    { name: 'id', ordinal: 1, dataType: 'integer', nullable: false },
    { name: 'name', ordinal: 2, dataType: 'text', nullable: true },
  ],
  primaryKey: { name: 'items_pkey', columns: ['id'] },
});

/** Batches of `[id, name]` rows, `size` rows per batch, with rows and lines numbered. */
async function* batches(
  rows: readonly (readonly SourceCell[])[],
  size = 250,
  rejected: RowError[] = [],
): AsyncGenerator<RowBatch> {
  for (let at = 0; at < rows.length; at += size) {
    const slice = rows.slice(at, at + size);
    yield {
      columns: ['id', 'name'],
      rows: slice,
      rowNumbers: slice.map((_, i) => at + i + 1),
      lines: slice.map((_, i) => at + i + 2),
      rejected: at === 0 ? rejected : [],
      bytesRead: at * 10,
    };
  }
}

function rowsOf(count: number): SourceCell[][] {
  return Array.from({ length: count }, (_, i) => [String(i + 1), `name ${i + 1}`]);
}

function options(
  session: FakeSession,
  rows: SourceCell[][],
  extra: Partial<ImportOptions> = {},
): ImportOptions {
  session.width = 2;
  return {
    session,
    table,
    rows: batches(rows),
    mapping: [
      { source: 'id', target: 'id' },
      { source: 'name', target: 'name' },
    ],
    ...extra,
  };
}

describe('importRows', () => {
  it('appends in batches inside one transaction and converts values', async () => {
    const session = new FakeSession('postgres');
    const progress: TransferProgress[] = [];
    const summary = await importRows(
      options(session, rowsOf(2500), {
        batchSize: 1000,
        onProgress: (p) => progress.push(p),
        progressIntervalMs: 0,
      }),
    );
    expect(summary).toMatchObject({
      status: 'completed',
      rowsRead: 2500,
      rowsWritten: 2500,
      rowsSkipped: 0,
      errors: [],
    });
    expect(session.committed).toHaveLength(2500);
    expect(session.committed[0]).toEqual([1, 'name 1']);
    const inserts = session.log.filter((e) => e.text.startsWith('INSERT'));
    expect(inserts.map((e) => e.params.length / 2)).toEqual([1000, 1000, 500]);
    expect(session.statements[0]).toBe('BEGIN');
    expect(session.statements.at(-1)).toBe('COMMIT');
    expect(progress.at(-1)).toMatchObject({ rowsRead: 2500, rowsWritten: 2500 });
  });

  it('keeps every statement under the placeholder limit', async () => {
    const wide: TableDef = tableDefSchema.parse({
      name: 'wide',
      columns: Array.from({ length: 70 }, (_, i) => ({
        name: `c${i}`,
        ordinal: i + 1,
        dataType: 'text',
        nullable: true,
      })),
    });
    const session = new FakeSession('mysql');
    session.width = 70;
    const columns = wide.columns.map((c) => c.name);
    const rows = Array.from({ length: 2000 }, () => columns.map(() => 'x'));
    async function* source(): AsyncGenerator<RowBatch> {
      yield {
        columns,
        rows,
        rowNumbers: rows.map((_, i) => i + 1),
        lines: rows.map((_, i) => i + 2),
        rejected: [],
        bytesRead: 0,
      };
    }
    const summary = await importRows({
      session,
      table: wide,
      rows: source(),
      mapping: columns.map((c) => ({ source: c, target: c })),
      batchSize: 2000,
    });
    expect(summary.rowsWritten).toBe(2000);
    const sizes = session.log
      .filter((e) => e.text.startsWith('INSERT'))
      .map((e) => e.params.length);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(MAX_PARAMETERS);
    expect(sizes.reduce((a, b) => a + b, 0)).toBe(2000 * 70);
    expect(session.statements).toContain('SELECT @@max_allowed_packet');
  });

  it('stops at the first bad row, reports it and rolls everything back', async () => {
    const session = new FakeSession('postgres');
    session.failWhen = (row) =>
      row[0] === 1500 ? 'duplicate key value violates unique constraint' : undefined;
    const summary = await importRows(options(session, rowsOf(3000), { batchSize: 1000 }));
    expect(summary.status).toBe('failed');
    expect(summary.rowsWritten).toBe(0);
    expect(summary.errors).toEqual([
      { row: 1500, line: 1501, message: 'duplicate key value violates unique constraint' },
    ]);
    expect(session.committed).toHaveLength(0);
    expect(session.statements.at(-1)).toBe('ROLLBACK');
  });

  it('skips bad rows using savepoints on PostgreSQL and keeps the rest', async () => {
    const session = new FakeSession('postgres');
    session.failWhen = (row) =>
      row[0] === 7 || row[0] === 1200 ? `bad ${String(row[0])}` : undefined;
    const summary = await importRows(
      options(session, rowsOf(2000), { batchSize: 1000, onError: 'skip' }),
    );
    expect(summary).toMatchObject({ status: 'completed', rowsWritten: 1998, rowsSkipped: 2 });
    expect(summary.errors.map((e) => e.row)).toEqual([7, 1200]);
    expect(session.committed).toHaveLength(1998);
    expect(session.statements).toContain('ROLLBACK TO SAVEPOINT joinery_row');
  });

  it('skips bad rows on MySQL without savepoints (statement-level rollback)', async () => {
    const session = new FakeSession('mysql');
    session.failWhen = (row) => (row[0] === 3 ? "Column 'name' cannot be null" : undefined);
    const summary = await importRows(options(session, rowsOf(10), { onError: 'skip' }));
    expect(summary).toMatchObject({ status: 'completed', rowsWritten: 9, rowsSkipped: 1 });
    expect(summary.errors).toEqual([
      { row: 3, line: 4, column: 'name', message: "Column 'name' cannot be null" },
    ]);
    expect(session.statements.some((s) => s.startsWith('SAVEPOINT'))).toBe(false);
  });

  it('commits earlier batches with per-batch transactions when a later one fails', async () => {
    const session = new FakeSession('postgres');
    session.failWhen = (row) => (row[0] === 2500 ? 'boom' : undefined);
    const summary = await importRows(
      options(session, rowsOf(3000), { batchSize: 1000, transaction: 'per-batch' }),
    );
    expect(summary).toMatchObject({ status: 'failed', rowsWritten: 2000 });
    expect(session.committed).toHaveLength(2000);
  });

  it('writes up to the bad row without a transaction', async () => {
    const session = new FakeSession('postgres');
    session.failWhen = (row) => (row[0] === 5 ? 'boom' : undefined);
    const summary = await importRows(options(session, rowsOf(10), { transaction: 'none' }));
    expect(summary).toMatchObject({ status: 'failed', rowsWritten: 4 });
    expect(session.committed.map((r) => r[0])).toEqual([1, 2, 3, 4]);
  });

  it('reports conversion errors with the row, line and column', async () => {
    const session = new FakeSession('postgres');
    const rows = rowsOf(5);
    rows[2] = ['x3', 'name 3'];
    const summary = await importRows(options(session, rows, { onError: 'skip' }));
    expect(summary.rowsWritten).toBe(4);
    expect(summary.errors).toEqual([
      { row: 3, line: 4, column: 'id', message: 'id: "x3" is not an integer' },
    ]);
  });

  it('counts rows the reader rejected', async () => {
    const session = new FakeSession('postgres');
    session.width = 2;
    const summary = await importRows({
      ...options(session, []),
      rows: batches(rowsOf(3), 250, [{ row: 4, line: 5, message: 'Invalid JSON on line 5' }]),
      onError: 'skip',
    });
    expect(summary).toMatchObject({ rowsRead: 4, rowsWritten: 3, rowsSkipped: 1 });
  });

  it('cancels mid-import, rolls back without the aborted signal and stops reading', async () => {
    const session = new FakeSession('postgres');
    const controller = new AbortController();
    let writes = 0;
    session.beforeWrite = () => {
      if (++writes === 3) controller.abort();
    };
    let closed = false;
    async function* source(): AsyncGenerator<RowBatch> {
      try {
        yield* batches(rowsOf(10_000), 500);
      } finally {
        closed = true;
      }
    }
    const summary = await importRows({
      ...options(session, []),
      rows: source(),
      batchSize: 500,
      signal: controller.signal,
    });
    expect(summary.status).toBe('cancelled');
    expect(summary.rowsWritten).toBe(0);
    expect(session.committed).toHaveLength(0);
    expect(session.statements.at(-1)).toBe('ROLLBACK');
    expect(closed).toBe(true);
  });

  it('upserts, updates and deletes by key', async () => {
    for (const mode of ['upsert', 'update', 'delete'] as const) {
      const session = new FakeSession('postgres');
      const summary = await importRows(options(session, rowsOf(3), { mode }));
      expect(summary.status).toBe('completed');
      const write = session.statements.find((s) => /^(INSERT|UPDATE|DELETE)/.test(s))!;
      expect(write).toMatch(
        mode === 'upsert'
          ? /ON CONFLICT \("id"\) DO UPDATE/
          : mode === 'update'
            ? /^UPDATE/
            : /^DELETE FROM "items" WHERE "id" IN/,
      );
    }
  });

  it('replaces: TRUNCATE inside the transaction on PostgreSQL, before it on MySQL', async () => {
    const pg = new FakeSession('postgres');
    await importRows(options(pg, rowsOf(2), { mode: 'replace' }));
    expect(pg.statements.slice(0, 2)).toEqual(['BEGIN', 'TRUNCATE TABLE "items"']);
    expect(pg.committed).toHaveLength(2);
    const my = new FakeSession('mysql');
    await importRows(options(my, rowsOf(2), { mode: 'replace' }));
    expect(my.statements.slice(1, 3)).toEqual(['TRUNCATE TABLE `items`', 'START TRANSACTION']);
    const del = new FakeSession('mysql');
    await importRows(options(del, rowsOf(2), { mode: 'replace', replaceWith: 'delete' }));
    expect(del.statements.slice(1, 3)).toEqual(['START TRANSACTION', 'DELETE FROM `items`']);
  });

  it('turns foreign key checks off and back on', async () => {
    const session = new FakeSession('mysql');
    await importRows(options(session, rowsOf(1), { disableForeignKeys: true }));
    expect(session.statements).toContain('SET foreign_key_checks = 0');
    expect(session.statements.at(-1)).toMatch(/^SET foreign_key_checks = /);
  });

  it('refuses invalid options before touching the database', async () => {
    const session = new FakeSession('postgres');
    await expect(
      importRows(options(session, [], { mapping: [{ source: 'a', target: 'nope' }] })),
    ).rejects.toThrow(/not in table/);
    await expect(importRows(options(session, [], { mapping: [] }))).rejects.toThrow(/No columns/);
    await expect(
      importRows(
        options(session, [], { mode: 'upsert', mapping: [{ source: 'name', target: 'name' }] }),
      ),
    ).rejects.toThrow(/Key column "id" is not mapped/);
    await expect(
      importRows(
        options(session, [], { mode: 'update', mapping: [{ source: 'id', target: 'id' }] }),
      ),
    ).rejects.toThrow(/besides the key/);
    session.inTransaction = true;
    await expect(importRows(options(session, []))).rejects.toThrow(/open transaction/);
    expect(session.log).toHaveLength(0);
  });
});

describe('columnFromError', () => {
  it('reads pg error fields and MySQL messages', () => {
    const cols = ['id', 'qty', 'name'];
    const pg = (cause: object): Error => Object.assign(new Error('x'), { cause });
    expect(columnFromError(pg({ column: 'name' }), cols)).toBe('name');
    expect(columnFromError(pg({ where: "unnamed portal parameter $2 = '...'" }), cols)).toBe('qty');
    expect(
      columnFromError(new Error("Incorrect integer value: 'a' for column 'qty' at row 1"), cols),
    ).toBe('qty');
    expect(columnFromError(new Error('null value in column "id" of relation "t"'), cols)).toBe(
      'id',
    );
    expect(columnFromError(new Error('something else'), cols)).toBeUndefined();
  });
});
