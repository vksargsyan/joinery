import type { CellValue, Session, TableDef } from '@querybara/core';
import { quoteIdent } from '@querybara/sql-tools';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  bytesSource,
  importRows,
  loadTable,
  readRows,
  type ImportOptions,
  type ImportSummary,
} from '../../src';
import { ScratchDatabases, configuredServers, query, runAll, tableRows } from './helpers';

/**
 * Import modes, error handling and cancellation against real servers: upsert, update,
 * delete matching and replace; a bad row with `skip` versus `stop` (rolled back); and a
 * cancelled import that leaves nothing behind.
 */

const SERVERS = configuredServers();

describe.skipIf(SERVERS.length === 0)('import modes and errors', () => {
  for (const server of SERVERS) {
    describe(server.engine, () => {
      const dialect = server.dialect;
      const q = (name: string): string => quoteIdent(name, dialect);
      let dbs: ScratchDatabases;
      let session: Session;
      let table: TableDef;
      let pair: TableDef;

      beforeAll(async () => {
        dbs = new ScratchDatabases(server);
        session = await dbs.create('modes');
        // A column collation other than the connection's, to catch collation clashes.
        const collate = dialect === 'postgres' ? '' : ' CHARACTER SET utf8mb4 COLLATE utf8mb4_bin';
        await runAll(session, [
          `CREATE TABLE ${q('items')} (id int PRIMARY KEY, code varchar(10)${collate} NOT NULL UNIQUE, qty int NOT NULL, note varchar(20)${collate})`,
          `CREATE TABLE ${q('pairs')} (a varchar(5)${collate} NOT NULL, b int NOT NULL, v int, PRIMARY KEY (a, b))`,
        ]);
        table = await loadTable(session, 'items');
        pair = await loadTable(session, 'pairs');
      });

      afterAll(async () => {
        await dbs?.dropAll();
      });

      beforeEach(async () => {
        await runAll(session, [
          `DELETE FROM ${q('items')}`,
          `INSERT INTO ${q('items')} VALUES (1, 'a', 10, 'one'), (2, 'b', 20, 'two'), (3, 'c', 30, NULL)`,
          `DELETE FROM ${q('pairs')}`,
          `INSERT INTO ${q('pairs')} VALUES ('x', 1, 1), ('x', 2, 2), ('y', 1, 3)`,
        ]);
      });

      const csv = (text: string): ImportOptions['rows'] =>
        readRows(bytesSource(text), { format: 'csv' });
      const run = (text: string, extra: Partial<ImportOptions>): Promise<ImportSummary> =>
        importRows({
          session,
          table,
          rows: csv(text),
          mapping: [
            { source: 'id', target: 'id' },
            { source: 'code', target: 'code' },
            { source: 'qty', target: 'qty' },
            { source: 'note', target: 'note' },
          ],
          ...extra,
        });
      const items = (): Promise<CellValue[][]> => tableRows(session, 'items', dialect);

      it('upsert inserts new rows and updates existing ones by key', async () => {
        const summary = await run('id,code,qty,note\n2,b,21,changed\n4,d,40,new\n2,b,22,twice\n', {
          mode: 'upsert',
        });
        expect(summary.errors).toEqual([]);
        expect(summary.rowsWritten).toBe(3);
        expect(await items()).toEqual([
          [1, 'a', 10, 'one'],
          [2, 'b', 22, 'twice'],
          [3, 'c', 30, null],
          [4, 'd', 40, 'new'],
        ]);
      });

      it('update changes matching rows only, and reports how many matched', async () => {
        const summary = await run('id,code,qty,note\n1,a,11,x\n3,c,33,\n9,z,99,missing\n', {
          mode: 'update',
        });
        expect(summary.errors).toEqual([]);
        expect(summary.rowsAffected).toBe(2);
        expect(await items()).toEqual([
          [1, 'a', 11, 'x'],
          [2, 'b', 20, 'two'],
          [3, 'c', 33, null],
        ]);
      });

      it('delete matching removes rows by key, composite keys included', async () => {
        const summary = await run('id,code,qty,note\n1,,0,\n3,,0,\n7,,0,\n', {
          mode: 'delete',
          mapping: [{ source: 'id', target: 'id' }],
        });
        expect(summary.rowsAffected).toBe(2);
        expect((await items()).map((r) => r[0])).toEqual([2]);
        const pairs = await importRows({
          session,
          table: pair,
          rows: csv('a,b\nx,2\ny,1\ny,2\n'),
          mapping: [
            { source: 'a', target: 'a' },
            { source: 'b', target: 'b' },
          ],
          mode: 'delete',
        });
        expect(pairs.rowsAffected).toBe(2);
        expect(await tableRows(session, 'pairs', dialect)).toEqual([['x', 1, 1]]);
      });

      it('update by a composite key', async () => {
        const summary = await importRows({
          session,
          table: pair,
          rows: csv('a,b,v\nx,2,20\ny,1,30\n'),
          mapping: [
            { source: 'a', target: 'a' },
            { source: 'b', target: 'b' },
            { source: 'v', target: 'v' },
          ],
          mode: 'update',
        });
        expect(summary.errors).toEqual([]);
        expect(await query(session, `SELECT v FROM ${q('pairs')} ORDER BY a, b`)).toEqual([
          [1],
          [20],
          [30],
        ]);
      });

      for (const replaceWith of ['truncate', 'delete'] as const) {
        it(`replace (${replaceWith}) empties the table, then loads the file`, async () => {
          const summary = await run('id,code,qty,note\n7,g,70,\n8,h,80,x\n', {
            mode: 'replace',
            replaceWith,
          });
          expect(summary.rowsWritten).toBe(2);
          expect(await items()).toEqual([
            [7, 'g', 70, null],
            [8, 'h', 80, 'x'],
          ]);
        });
      }

      it('replace with delete rolls back to the old rows when the load fails', async () => {
        const summary = await run('id,code,qty,note\n7,g,70,\n8,g,80,dup\n', {
          mode: 'replace',
          replaceWith: 'delete',
        });
        expect(summary.status).toBe('failed');
        expect((await items()).map((r) => r[0])).toEqual([1, 2, 3]);
      });

      it('skip: logs the bad rows with row, line and column, keeps the rest', async () => {
        const summary = await run(
          'id,code,qty,note\n4,d,40,ok\n5,e,oops,bad qty\n6,a,60,dup code\n7,f,,null qty\n8,g,80,this note is far too long for the column\n9,h,90,ok\n',
          { mode: 'append', onError: 'skip', batchSize: 3 },
        );
        expect(summary).toMatchObject({
          status: 'completed',
          rowsRead: 6,
          rowsWritten: 2,
          rowsSkipped: 4,
        });
        expect(summary.errors.map((e) => [e.row, e.line])).toEqual([
          [2, 3],
          [3, 4],
          [4, 5],
          [5, 6],
        ]);
        expect(summary.errors[0]).toMatchObject({ column: 'qty' });
        expect(summary.errors[0]!.message).toMatch(/not an integer/);
        expect(summary.errors[2]).toMatchObject({ column: 'qty' });
        if (dialect !== 'postgres') expect(summary.errors[3]).toMatchObject({ column: 'note' });
        expect((await items()).map((r) => r[0])).toEqual([1, 2, 3, 4, 9]);
      });

      it('stop: reports the first bad row and rolls the whole import back', async () => {
        const rows = ['id,code,qty,note'];
        for (let i = 10; i < 2010; i++) rows.push(`${i},c${i},${i},`);
        rows.push('2010,a,1,duplicate code');
        for (let i = 2011; i < 2100; i++) rows.push(`${i},c${i},${i},`);
        const summary = await run(rows.join('\n'), { batchSize: 500 });
        expect(summary.status).toBe('failed');
        expect(summary.rowsWritten).toBe(0);
        expect(summary.errors).toHaveLength(1);
        expect(summary.errors[0]).toMatchObject({ row: 2001, line: 2002 });
        expect(summary.errors[0]!.message).toMatch(/duplicate|unique/i);
        expect(session.inTransaction).toBe(false);
        expect((await items()).map((r) => r[0])).toEqual([1, 2, 3]);
      });

      it('per-batch transactions keep the batches before the failure', async () => {
        const rows = ['id,code,qty,note'];
        for (let i = 10; i < 25; i++) rows.push(`${i},c${i},${i},`);
        rows.push('25,a,1,duplicate code');
        const summary = await run(rows.join('\n'), { batchSize: 5, transaction: 'per-batch' });
        expect(summary).toMatchObject({ status: 'failed', rowsWritten: 15 });
        expect((await items()).length).toBe(18);
      });

      it('cancellation mid-import rolls everything back and leaves the session usable', async () => {
        const controller = new AbortController();
        async function* generate(): AsyncGenerator<Uint8Array> {
          yield new TextEncoder().encode('id,code,qty,note\n');
          for (let block = 0; block < 1000; block++) {
            let text = '';
            for (let i = 0; i < 100; i++) {
              const id = 100 + block * 100 + i;
              text += `${id},k${id},${id},note\n`;
            }
            yield new TextEncoder().encode(text);
          }
        }
        const summary = await importRows({
          session,
          table,
          rows: readRows(generate(), { format: 'csv' }),
          mapping: [
            { source: 'id', target: 'id' },
            { source: 'code', target: 'code' },
            { source: 'qty', target: 'qty' },
          ],
          batchSize: 1000,
          signal: controller.signal,
          progressIntervalMs: 0,
          onProgress: (p) => {
            if (p.rowsWritten >= 5000) controller.abort();
          },
        });
        expect(summary.status).toBe('cancelled');
        expect(summary.rowsWritten).toBe(0);
        expect(summary.rowsRead).toBeLessThan(100_000);
        expect(session.inTransaction).toBe(false);
        expect((await items()).map((r) => r[0])).toEqual([1, 2, 3]);
      });

      it('disables foreign key checks during the load when asked', async () => {
        if (dialect === 'postgres') return; // needs superuser semantics checked elsewhere
        await runAll(session, [
          `CREATE TABLE ${q('kids')} (id int PRIMARY KEY, item_id int, FOREIGN KEY (item_id) REFERENCES ${q('items')} (id))`,
        ]);
        const kids = await loadTable(session, 'kids');
        const mapping = [
          { source: 'id', target: 'id' },
          { source: 'item_id', target: 'item_id' },
        ];
        const refused = await importRows({
          session,
          table: kids,
          rows: csv('id,item_id\n1,999\n'),
          mapping,
        });
        expect(refused.status).toBe('failed');
        const loaded = await importRows({
          session,
          table: kids,
          rows: csv('id,item_id\n1,999\n'),
          mapping,
          disableForeignKeys: true,
        });
        expect(loaded.status).toBe('completed');
        expect(await query(session, 'SELECT @@foreign_key_checks')).toEqual([[1]]);
        await query(session, `DROP TABLE ${q('kids')}`);
      });
    });
  }
});
