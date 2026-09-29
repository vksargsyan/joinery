import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';

import type { Session } from '@joinery/core';
import { quoteIdent } from '@joinery/sql-tools';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  ZipReader,
  bytesSource,
  createTable,
  exportTables,
  fileSource,
  importRows,
  loadTable,
  memoryReader,
  memorySink,
  previewSource,
  readRows,
  tableFromColumns,
} from '../../src';
import { rawWorkbook, readAll, writeLargeWorkbook } from '../xlsx-helpers';
import { ScratchDatabases, configuredServers, query, runAll } from './helpers';

/**
 * Excel and XML against real servers (spec §12): a workbook written the way Excel writes one
 * becomes a new table with the right column types; XML rows load; several tables export to a
 * workbook, an XML, HTML or Markdown file, or a ZIP; and a 200,000-row workbook imports with
 * bounded memory at a useful speed.
 */

const SERVERS = configuredServers();
const LARGE_ROWS = 200_000;

setFlagsFromString('--expose-gc');
const gc = runInNewContext('gc') as () => void;

const STYLES = `<?xml version="1.0"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><cellXfs count="3"><xf numFmtId="0"/><xf numFmtId="14"/><xf numFmtId="22"/></cellXfs></styleSheet>`;

describe.skipIf(SERVERS.length === 0)('Excel and XML', () => {
  let dir = '';
  let large = '';

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'joinery-formats-'));
    large = join(dir, 'large.xlsx');
    await writeLargeWorkbook(large, LARGE_ROWS);
  }, 120_000);

  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  for (const server of SERVERS) {
    describe(server.engine, () => {
      const dialect = server.dialect;
      const q = (name: string): string => quoteIdent(name, dialect);
      let dbs: ScratchDatabases;
      let session: Session;

      beforeAll(async () => {
        dbs = new ScratchDatabases(server);
        session = await dbs.create('formats');
      });

      afterAll(async () => {
        await dbs?.dropAll();
      });

      it('creates a table from a workbook with typed columns and loads it', async () => {
        const book = await rawWorkbook({
          styles: STYLES,
          sharedStrings:
            '<si><t>Order ID</t></si><si><t>Customer</t></si><si><t>Placed</t></si><si><t>Total</t></si><si><t>Paid</t></si><si><t>Seen</t></si><si><t>Ada &amp; Co</t></si><si><t>Grace</t></si>',
          sheets: [
            {
              name: 'Orders',
              xml: [
                '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c><c r="D1" t="s"><v>3</v></c><c r="E1" t="s"><v>4</v></c><c r="F1" t="s"><v>5</v></c></row>',
                '<row r="2"><c r="A2"><v>1001</v></c><c r="B2" t="s"><v>6</v></c><c r="C2" s="1"><v>45293</v></c><c r="D2"><v>12.5</v></c><c r="E2" t="b"><v>1</v></c><c r="F2" s="2"><v>45293.75</v></c></row>',
                '<row r="3"><c r="A3"><v>1002</v></c><c r="B3" t="s"><v>7</v></c><c r="C3" s="1"><v>45324</v></c><c r="D3"><v>7.25</v></c><c r="E3" t="b"><v>0</v></c></row>',
              ].join(''),
            },
          ],
        });
        const preview = await previewSource(bytesSource(book), { fileName: 'orders.xlsx' });
        expect(preview.columns.map((c) => [c.name, c.type])).toEqual([
          ['Order ID', 'integer'],
          ['Customer', 'text'],
          ['Placed', 'date'],
          ['Total', 'decimal'],
          ['Paid', 'boolean'],
          ['Seen', 'timestamp'],
        ]);
        const { table, mapping } = tableFromColumns(preview.columns, {
          name: 'orders_from_xlsx',
          dialect,
          primaryKey: ['Order ID'],
        });
        await createTable(session, table);
        const summary = await importRows({
          session,
          table,
          rows: readRows(bytesSource(book), preview.read!),
          mapping,
        });
        expect(summary.errors).toEqual([]);
        expect(summary.rowsWritten).toBe(2);
        const cast = dialect === 'postgres' ? '::text' : '';
        const rows = await query(
          session,
          `SELECT ${q('Order ID')}, ${q('Customer')}, ${q('Placed')}${cast}, ${q('Total')}${cast}, ${q('Seen')}${cast} FROM ${q('orders_from_xlsx')} ORDER BY 1`,
        );
        expect(rows.map((r) => r.map(String))).toEqual([
          ['1001', 'Ada & Co', '2024-01-02', '12.50', '2024-01-02 18:00:00'],
          ['1002', 'Grace', '2024-02-02', '7.25', 'null'],
        ]);
      });

      it('loads XML rows into an existing table, reporting a bad row by its line', async () => {
        await runAll(session, [
          `CREATE TABLE ${q('xml_people')} (id int PRIMARY KEY, name varchar(40), born date)`,
        ]);
        const xml = [
          '<?xml version="1.0" encoding="UTF-8"?>',
          '<people>',
          '  <person id="1"><name>Ada &amp; Lovelace</name><born>1815-12-10</born></person>',
          '  <person id="2"><name>Grace</name><born>not a date</born></person>',
          '  <person id="3"><name xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:nil="true"/></person>',
          '</people>',
        ].join('\n');
        const preview = await previewSource(bytesSource(xml), {});
        expect(preview.read?.xml?.rowPath).toBe('/people/person');
        const table = await loadTable(session, 'xml_people');
        const summary = await importRows({
          session,
          table,
          rows: readRows(bytesSource(xml, 17), preview.read!),
          mapping: [
            { source: 'id', target: 'id' },
            { source: 'name', target: 'name' },
            { source: 'born', target: 'born' },
          ],
          onError: 'skip',
        });
        expect(summary.rowsWritten).toBe(2);
        expect(summary.errors).toHaveLength(1);
        expect(summary.errors[0]).toMatchObject({ row: 2, line: 4 });
        const rows = await query(session, `SELECT id, name FROM ${q('xml_people')} ORDER BY id`);
        expect(rows).toEqual([
          [1, 'Ada & Lovelace'],
          [3, null],
        ]);
      });

      it('exports several tables to a workbook, XML, HTML, Markdown and a ZIP', async () => {
        await runAll(session, [
          `CREATE TABLE ${q('ex_a')} (id int PRIMARY KEY, amount decimal(12,2), day date)`,
          `CREATE TABLE ${q('ex_b')} (id int PRIMARY KEY, note varchar(40))`,
          `INSERT INTO ${q('ex_a')} VALUES (1, 10.50, '2024-03-04'), (2, NULL, NULL)`,
          `INSERT INTO ${q('ex_b')} VALUES (1, '<b> | *x*')`,
        ]);
        const tables = [{ name: 'ex_a' }, { name: 'ex_b' }];
        const book = memorySink();
        const summary = await exportTables({
          session,
          tables,
          format: 'xlsx',
          output: { kind: 'combined', sink: book },
        });
        expect(summary).toMatchObject({ status: 'completed', rowsWritten: 3 });
        expect(
          (await readAll(book.bytes(), { format: 'xlsx', xlsx: { sheet: 'ex_a' } })).rows,
        ).toEqual([
          [1, '10.50', '2024-03-04'],
          [2, null, null],
        ]);
        expect(
          (await readAll(book.bytes(), { format: 'xlsx', xlsx: { sheet: 'ex_b' } })).rows,
        ).toEqual([[1, '<b> | *x*']]);

        const texts = new Map<string, string>();
        for (const format of ['xml', 'html', 'markdown'] as const) {
          const sink = memorySink();
          await exportTables({ session, tables, format, output: { kind: 'combined', sink } });
          texts.set(format, sink.text());
        }
        expect((await readAll(texts.get('xml')!, { format: 'xml' })).rows).toHaveLength(3);
        expect(texts.get('html')).toContain('<td>&lt;b&gt; | *x*</td>');
        expect(texts.get('markdown')).toContain('| 1 | \\<b\\> \\| \\*x\\* |');

        const zip = memorySink();
        const zipped = await exportTables({
          session,
          tables,
          format: 'jsonl',
          output: { kind: 'zip', sink: zip },
        });
        expect(zipped.files).toEqual(['ex_a.jsonl', 'ex_b.jsonl']);
        const archive = await ZipReader.open(memoryReader(zip.bytes()));
        expect(await archive.text(archive.entry('ex_b.jsonl')!)).toBe(
          '{"id":1,"note":"<b> | *x*"}\n',
        );
        await archive.close();
      });

      it(`imports a ${LARGE_ROWS.toLocaleString('en-US')}-row workbook with bounded memory`, async () => {
        const preview = await previewSource(fileSource(large), { fileName: large });
        const { table, mapping } = tableFromColumns(preview.columns, {
          name: 'large_xlsx',
          dialect,
          primaryKey: ['id'],
          // The sample's amounts are small; later ones need more digits.
          types: { amount: 'decimal(12,2)' },
        });
        await createTable(session, table);
        gc();
        const baseline = process.memoryUsage.rss();
        let peak = baseline;
        const sampler = setInterval(() => {
          peak = Math.max(peak, process.memoryUsage.rss());
        }, 50);
        const started = performance.now();
        try {
          const summary = await importRows({
            session,
            table,
            rows: readRows(fileSource(large), preview.read!),
            mapping,
            batchSize: 2000,
          });
          expect(summary.errors).toEqual([]);
          expect(summary).toMatchObject({ status: 'completed', rowsWritten: LARGE_ROWS });
        } finally {
          clearInterval(sampler);
        }
        peak = Math.max(peak, process.memoryUsage.rss());
        const seconds = (performance.now() - started) / 1000;
        const growth = (peak - baseline) / 1024 / 1024;
        console.info(
          `${server.engine}: ${LARGE_ROWS} xlsx rows in ${seconds.toFixed(1)} s (${Math.round(LARGE_ROWS / seconds)} rows/s), RSS growth ${growth.toFixed(1)} MB`,
        );
        expect(growth).toBeLessThan(200);
        const [[count]] = (await query(session, `SELECT count(*) FROM ${q('large_xlsx')}`)) as [
          [unknown],
        ];
        expect(Number(count)).toBe(LARGE_ROWS);
        const last = await query(
          session,
          `SELECT ${q('name')}, ${q('city')} FROM ${q('large_xlsx')} WHERE ${q('id')} = ${LARGE_ROWS}`,
        );
        expect(last).toEqual([[`Customer ${LARGE_ROWS - 1} & Sons`, 'Riga']]);
      }, 300_000);
    });
  }
});
