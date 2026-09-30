import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Session } from '@joinery/core';
import { quoteIdent } from '@joinery/sql-tools';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  autoMatch,
  bytesSource,
  createTable,
  exportRows,
  exportTables,
  fileSink,
  fileSource,
  importRows,
  loadTable,
  memorySink,
  previewSource,
  readRows,
  runSqlFile,
  tableFromColumns,
  type ExportFormat,
  type FileFormat,
} from '../../src';
import {
  ScratchDatabases,
  configuredServers,
  query,
  runAll,
  tableRows,
  typesTable,
} from './helpers';

/**
 * Export a table with every common column type to each format and import it back: into a
 * table with the same structure (contents compared value for value) and into a table created
 * from the file (re-exported to the same format and compared byte for byte; a workbook, whose
 * ZIP carries timestamps, is compared by its rows).
 */

const SERVERS = configuredServers();
const ROW_FORMATS: FileFormat[] = ['csv', 'tsv', 'json', 'jsonl', 'xlsx', 'xml', 'parquet'];
/** Formats whose export of a table created from the file is byte for byte the same. */
const TEXT_FORMATS: FileFormat[] = ['csv', 'tsv', 'json', 'jsonl', 'xml'];

async function exportTable(
  session: Session,
  table: string,
  format: ExportFormat,
): Promise<Uint8Array> {
  const sink = memorySink();
  const summary = await exportRows({ session, table: { name: table }, format, sink });
  expect(summary.errors).toEqual([]);
  expect(summary.status).toBe('completed');
  return sink.bytes();
}

describe.skipIf(SERVERS.length === 0)('round trips', () => {
  for (const server of SERVERS) {
    describe(server.engine, () => {
      const dialect = server.dialect;
      const q = (name: string): string => quoteIdent(name, dialect);
      let dbs: ScratchDatabases;
      let session: Session;
      let dir: string;

      beforeAll(async () => {
        dir = await mkdtemp(join(tmpdir(), 'joinery-transfer-'));
        dbs = new ScratchDatabases(server);
        session = await dbs.create('round_trip');
        const { create, insert } = typesTable(server.engine, 'src');
        await runAll(session, [create, ...insert]);
      });

      afterAll(async () => {
        await dbs?.dropAll();
        await rm(dir, { recursive: true, force: true });
      });

      /** A new empty table with the source's structure. */
      async function copyStructure(name: string): Promise<void> {
        await query(
          session,
          dialect === 'postgres'
            ? `CREATE TABLE ${q(name)} (LIKE ${q('src')} INCLUDING ALL)`
            : `CREATE TABLE ${q(name)} LIKE ${q('src')}`,
        );
      }

      for (const format of ROW_FORMATS) {
        it(`${format}: exports and imports into an existing table with identical contents`, async () => {
          const bytes = await exportTable(session, 'src', format);
          const target = `into_${format}`;
          await copyStructure(target);
          const table = await loadTable(session, target);
          const preview = await previewSource(bytesSource(bytes), { format });
          const summary = await importRows({
            session,
            table,
            rows: readRows(bytesSource(bytes, 1000), preview.read!),
            mapping: autoMatch(
              preview.columns.map((c) => c.name),
              table,
            ),
          });
          expect(summary.errors).toEqual([]);
          expect(summary).toMatchObject({ status: 'completed', rowsRead: 5, rowsWritten: 5 });
          expect(await tableRows(session, target, dialect)).toEqual(
            await tableRows(session, 'src', dialect),
          );
        });
      }

      for (const format of TEXT_FORMATS) {
        it(`${format}: creates a new table from the file that exports to the same bytes`, async () => {
          const bytes = await exportTable(session, 'src', format);
          const preview = await previewSource(bytesSource(bytes), { format, sampleRows: 1000 });
          expect(preview.complete).toBe(true);
          const name = `new_${format}`;
          const { table, mapping } = tableFromColumns(preview.columns, {
            name,
            dialect,
            primaryKey: ['id'],
          });
          await createTable(session, table);
          const summary = await importRows({
            session,
            table,
            rows: readRows(bytesSource(bytes, 777), preview.read!),
            mapping,
          });
          expect(summary.errors).toEqual([]);
          expect(summary.rowsWritten).toBe(5);
          const sink = memorySink();
          await exportRows({ session, query: `SELECT * FROM ${q(name)} ORDER BY 1`, format, sink });
          const original = memorySink();
          await exportRows({
            session,
            query: `SELECT * FROM ${q('src')} ORDER BY 1`,
            format,
            sink: original,
          });
          expect(sink.text()).toBe(original.text());
        });
      }

      it('parquet: creates a new table typed from the file with the same contents', async () => {
        const bytes = await exportTable(session, 'src', 'parquet');
        const preview = await previewSource(bytesSource(bytes), {});
        expect(preview.format).toBe('parquet');
        const { table, mapping } = tableFromColumns(preview.columns, {
          name: 'new_parquet',
          dialect,
          primaryKey: ['id'],
        });
        await createTable(session, table);
        const summary = await importRows({
          session,
          table,
          rows: readRows(bytesSource(bytes), preview.read!),
          mapping,
        });
        expect(summary.errors).toEqual([]);
        expect(summary.rowsWritten).toBe(5);
        const csv = async (name: string): Promise<string> => {
          const sink = memorySink();
          await exportRows({
            session,
            query: `SELECT * FROM ${q(name)} ORDER BY 1`,
            format: 'csv',
            sink,
          });
          return sink.text();
        };
        if (dialect === 'postgres') {
          // Every PostgreSQL type the file holds comes back as it was.
          expect(await csv('new_parquet')).toBe(await csv('src'));
        } else {
          // MySQL: DATETIME(6) and TIME(6) columns print their microseconds.
          const lines = (await csv('new_parquet')).split('\r\n');
          expect(lines[0]).toBe((await csv('src')).split('\r\n')[0]);
          expect(lines).toHaveLength(7);
        }
      });

      it('sql: INSERTs run back into an existing table', async () => {
        await copyStructure('into_sql');
        const sink = memorySink();
        const summary = await exportRows({
          session,
          table: { name: 'src' },
          format: 'sql',
          sql: { table: 'into_sql', rowsPerStatement: 2 },
          sink,
        });
        expect(summary.status).toBe('completed');
        const run = await runSqlFile({ session, source: bytesSource(sink.bytes(), 100) });
        expect(run.errors).toEqual([]);
        expect(run).toMatchObject({ status: 'completed', statements: 3, rowsAffected: 5 });
        expect(await tableRows(session, 'into_sql', dialect)).toEqual(
          await tableRows(session, 'src', dialect),
        );
      });

      it('sql-ddl: CREATE and INSERTs recreate the table in a fresh database', async () => {
        const sink = memorySink();
        const summary = await exportRows({
          session,
          table: { name: 'src' },
          format: 'sql-ddl',
          sink,
        });
        expect(summary.status).toBe('completed');
        const fresh = await dbs.create('ddl_target');
        const run = await runSqlFile({ session: fresh, source: bytesSource(sink.bytes()) });
        expect(run.errors).toEqual([]);
        expect(run.status).toBe('completed');
        expect(await tableRows(fresh, 'src', dialect)).toEqual(
          await tableRows(session, 'src', dialect),
        );
      });

      it('gzip: a compressed CSV file on disk round-trips', async () => {
        const path = join(dir, 'src.csv.gz');
        const summary = await exportRows({
          session,
          table: { name: 'src' },
          format: 'csv',
          sink: fileSink(path, { gzip: true }),
        });
        expect(summary.status).toBe('completed');
        const preview = await previewSource(fileSource(path), { fileName: path });
        expect(preview).toMatchObject({ format: 'csv', compression: 'gzip' });
        await copyStructure('into_gzip');
        const table = await loadTable(session, 'into_gzip');
        const result = await importRows({
          session,
          table,
          rows: readRows(fileSource(path), preview.read!),
          mapping: autoMatch(
            preview.columns.map((c) => c.name),
            table,
          ),
        });
        expect(result.rowsWritten).toBe(5);
        expect(await tableRows(session, 'into_gzip', dialect)).toEqual(
          await tableRows(session, 'src', dialect),
        );
      });

      it('exports several tables: a combined SQL file with foreign keys last, and one file per table', async () => {
        const multi = await dbs.create('multi');
        const serial = dialect === 'postgres' ? 'serial' : 'int AUTO_INCREMENT';
        await runAll(multi, [
          `CREATE TABLE ${q('parent')} (id ${serial} PRIMARY KEY, name varchar(20))`,
          `CREATE TABLE ${q('child')} (id ${serial} PRIMARY KEY, parent_id int NOT NULL, note text, CONSTRAINT ${q('child_parent_fk')} FOREIGN KEY (parent_id) REFERENCES ${q('parent')} (id))`,
          `INSERT INTO ${q('parent')} (name) VALUES ('a'), ('b')`,
          `INSERT INTO ${q('child')} (parent_id, note) VALUES (1, 'x'), (2, 'y'), (2, NULL)`,
        ]);
        const combined = memorySink();
        const summary = await exportTables({
          session: multi,
          // Children first: the foreign keys still load because they come last.
          tables: [{ name: 'child' }, { name: 'parent' }],
          format: 'sql-ddl',
          output: { kind: 'combined', sink: combined },
        });
        expect(summary).toMatchObject({ status: 'completed', rowsWritten: 5 });
        const text = combined.text();
        expect(text.lastIndexOf('FOREIGN KEY')).toBeGreaterThan(text.lastIndexOf('INSERT INTO'));
        const fresh = await dbs.create('multi_target');
        const run = await runSqlFile({ session: fresh, source: bytesSource(combined.bytes()) });
        expect(run.errors).toEqual([]);
        for (const table of ['parent', 'child']) {
          expect(await tableRows(fresh, table, dialect)).toEqual(
            await tableRows(multi, table, dialect),
          );
        }
        // The sequences moved past the copied ids.
        await query(fresh, `INSERT INTO ${q('parent')} (name) VALUES ('c')`);
        expect((await tableRows(fresh, 'parent', dialect)).map((r) => r[0])).toEqual([1, 2, 3]);

        const files = new Map<string, ReturnType<typeof memorySink>>();
        const perTable = await exportTables({
          session: multi,
          tables: [{ name: 'parent' }, { name: 'child', columns: ['id', 'note'] }],
          format: 'jsonl',
          output: {
            kind: 'per-table',
            sinkFor: (table) => {
              const sink = memorySink();
              files.set(table.name, sink);
              return sink;
            },
          },
        });
        expect(perTable.status).toBe('completed');
        expect(files.get('child')!.text().split('\n')[0]).toBe('{"id":1,"note":"x"}');
      });
    });
  }
});
