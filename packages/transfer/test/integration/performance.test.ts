import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';

import type { Session } from '@joinery/core';
import { quoteIdent } from '@joinery/sql-tools';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  autoMatch,
  exportRows,
  fileSink,
  fileSource,
  importRows,
  loadTable,
  previewSource,
  readRows,
  type TransferProgress,
} from '../../src';
import { ScratchDatabases, configuredServers, query } from './helpers';

/**
 * Throughput and memory (spec §18: import into a local server at 50,000 rows/s or more). A
 * 200,000-row CSV file is imported and the rate reported; the floor asserted is loose so a
 * busy CI machine does not flake. Memory must stay flat: the heap may not grow with the file.
 */

const SERVERS = configuredServers();
const ROWS = 200_000;
/**
 * Loose floor for CI (hosted runners have measured from about 8,700 to 12,800 rows/s); the
 * target is 50,000 rows/s on a developer machine.
 */
const MIN_ROWS_PER_SECOND = 5_000;
/** Live heap growth allowed while streaming 20 MB: a few batches, never the file. */
const MAX_HEAP_GROWTH = 32 * 1024 * 1024;

// A real GC between samples, so the heap measured is what is live, not garbage not yet swept.
setFlagsFromString('--expose-gc');
const gc = runInNewContext('gc') as () => void;

/** Samples the live heap at most every `everyMs`, tracking the peak above the baseline. */
function heapMeter(everyMs = 1000): { sample(): void; growth(): number } {
  gc();
  const baseline = process.memoryUsage().heapUsed;
  let peak = baseline;
  let last = 0;
  return {
    sample() {
      const now = performance.now();
      if (now - last < everyMs) return;
      last = now;
      gc();
      peak = Math.max(peak, process.memoryUsage().heapUsed);
    },
    growth: () => peak - baseline,
  };
}

describe.skipIf(SERVERS.length === 0)('performance', () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'joinery-transfer-perf-'));
    const sink = fileSink(join(dir, 'rows.csv'));
    const encoder = new TextEncoder();
    await sink.write(encoder.encode('id,code,qty,price,created_at,active,note,ratio\n'));
    for (let block = 0; block < ROWS / 1000; block++) {
      let text = '';
      for (let i = 0; i < 1000; i++) {
        const id = block * 1000 + i + 1;
        const day = String((id % 28) + 1).padStart(2, '0');
        text += `${id},C-${id},${id % 1000},${(id % 100000) / 100},2024-03-${day} 12:34:56,${id % 2 === 0},"note ${id}, with ""quotes""",${id / 7}\n`;
      }
      await sink.write(encoder.encode(text));
    }
    await sink.close();
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  for (const server of SERVERS) {
    describe(server.engine, () => {
      const dialect = server.dialect;
      let dbs: ScratchDatabases;
      let session: Session;

      beforeAll(async () => {
        dbs = new ScratchDatabases(server);
        session = await dbs.create('perf');
        await query(
          session,
          `CREATE TABLE ${quoteIdent('rows', dialect)} (id int PRIMARY KEY, code varchar(20) NOT NULL, qty int, price decimal(10,2), created_at ${dialect === 'postgres' ? 'timestamp' : 'datetime'}, active boolean, note varchar(100), ratio double precision)`,
        );
      });

      afterAll(async () => {
        await dbs?.dropAll();
      });

      it(`imports ${ROWS} CSV rows at a steady rate with flat memory`, async () => {
        const path = join(dir, 'rows.csv');
        const preview = await previewSource(fileSource(path), { fileName: path });
        const table = await loadTable(session, 'rows');
        const heap = heapMeter();
        const samples: TransferProgress[] = [];
        const summary = await importRows({
          session,
          table,
          rows: readRows(fileSource(path), preview.read!),
          mapping: autoMatch(
            preview.columns.map((c) => c.name),
            table,
          ),
          progressIntervalMs: 100,
          onProgress: (p) => {
            samples.push(p);
            heap.sample();
          },
        });
        expect(summary.errors).toEqual([]);
        expect(summary).toMatchObject({ status: 'completed', rowsRead: ROWS, rowsWritten: ROWS });
        const rate = Math.round((ROWS * 1000) / summary.durationMs);
        const size = (await stat(path)).size;
        console.log(
          `${server.engine}: imported ${ROWS} rows (${(size / 1e6).toFixed(1)} MB CSV) in ${summary.durationMs} ms = ${rate} rows/s; live heap +${(heap.growth() / 1e6).toFixed(1)} MB`,
        );
        expect(rate).toBeGreaterThan(MIN_ROWS_PER_SECOND);
        expect(samples.at(-1)!.bytes).toBe(size);
        expect(samples.length).toBeGreaterThan(3);
        expect(heap.growth()).toBeLessThan(MAX_HEAP_GROWTH);
        expect(await query(session, `SELECT count(*) FROM ${quoteIdent('rows', dialect)}`)).toEqual(
          [[ROWS]],
        );
      });

      it(`exports ${ROWS} rows to CSV with backpressure and flat memory`, async () => {
        const path = join(dir, `${server.engine}.csv`);
        const heap = heapMeter(200);
        let ahead = 0;
        const summary = await exportRows({
          session,
          query: `SELECT * FROM ${quoteIdent('rows', dialect)} ORDER BY id`,
          format: 'csv',
          sink: fileSink(path),
          progressIntervalMs: 50,
          onProgress: (p) => {
            ahead = Math.max(ahead, p.rowsRead - p.rowsWritten);
            heap.sample();
          },
        });
        expect(summary).toMatchObject({ status: 'completed', rowsWritten: ROWS });
        const rate = Math.round((ROWS * 1000) / summary.durationMs);
        console.log(
          `${server.engine}: exported ${ROWS} rows in ${summary.durationMs} ms = ${rate} rows/s; live heap +${(heap.growth() / 1e6).toFixed(1)} MB`,
        );
        expect(ahead).toBe(0);
        expect(heap.growth()).toBeLessThan(MAX_HEAP_GROWTH);
        expect((await stat(path)).size).toBe(summary.bytesWritten);
      });
    });
  }
});
