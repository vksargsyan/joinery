import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { CellValue } from '@joinery/core';

import { exportRows, fileSink, fileSource, readRows } from '../src';
import { FakeSession } from './fake-session';
import { col, writeLargeWorkbook } from './xlsx-helpers';

/**
 * The xlsx reader streams (spec §12, §18): a 200,000-row workbook written the way Excel
 * writes one (every text in the shared string table) reads with well under 200 MB of RSS
 * growth, less than the worksheet XML itself would take held as a string. Parquet holds one
 * row group at a time, both ways: 200,000 rows export and import within the same bound.
 */

const ROWS = 200_000;
const LIMIT = 200 * 1024 * 1024;

setFlagsFromString('--expose-gc');
const gc = runInNewContext('gc') as () => void;

let dir = '';
let path = '';
let sheetBytes = 0;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'joinery-xlsx-memory-'));
  path = join(dir, 'large.xlsx');
  sheetBytes = await writeLargeWorkbook(path, ROWS);
}, 120_000);

afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe('xlsx streaming', () => {
  it(`reads ${ROWS.toLocaleString('en-US')} rows with bounded memory`, async () => {
    gc();
    const baseline = process.memoryUsage.rss();
    let peak = baseline;
    let rows = 0;
    let last: unknown[] = [];
    let batches = 0;
    for await (const batch of readRows(fileSource(path), { format: 'xlsx' })) {
      rows += batch.rows.length;
      if (batch.rows.length > 0) last = [...batch.rows[batch.rows.length - 1]!];
      if (++batches % 20 === 0) peak = Math.max(peak, process.memoryUsage.rss());
    }
    peak = Math.max(peak, process.memoryUsage.rss());
    const growth = peak - baseline;
    const mb = (bytes: number): string => `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    console.info(
      `xlsx ${mb(statSync(path).size)} on disk, worksheet XML ${mb(sheetBytes)}: ${rows} rows in ${batches} batches, RSS growth ${mb(growth)}`,
    );
    expect(rows).toBe(ROWS);
    expect(last).toEqual([
      ROWS,
      `Customer ${ROWS - 1} & Sons`,
      'Riga',
      (((ROWS - 1) * 7) % 100000) + 0.25,
      ((ROWS - 1) % 1000) / 1000,
      true,
      '2031-02-20',
      '2031-02-20 12:00:00',
    ]);
    // Rows go out in batches as the sheet streams, never all at once.
    expect(batches).toBeGreaterThan(100);
    expect(growth).toBeLessThan(LIMIT);
    expect(growth).toBeLessThan(sheetBytes * 2);
  }, 120_000);
});

describe('Parquet streaming', () => {
  const columns = [
    col('id', 'integer', 'int4'),
    col('name', 'string', 'text'),
    col('city', 'string', 'text'),
    col('amount', 'decimal', 'numeric(12,2)'),
    col('ratio', 'float', 'float8'),
    col('active', 'boolean', 'bool'),
    col('day', 'date', 'date'),
    col('stamp', 'timestamp', 'timestamptz'),
  ];
  const cities = ['Yerevan', 'Riga', 'Lisbon', 'Osaka'];
  const row = (i: number): CellValue[] => [
    i + 1,
    `Customer ${i} & Sons`,
    cities[i % cities.length]!,
    `${(i * 7) % 100000}.25`,
    (i % 1000) / 1000,
    i % 3 !== 0,
    '2031-02-20',
    `2031-02-20 12:00:${String(i % 60).padStart(2, '0')}+00`,
  ];
  const mb = (bytes: number): string => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

  it(`writes and reads ${ROWS.toLocaleString('en-US')} rows with bounded memory`, async () => {
    const parquet = join(dir, 'large.parquet');
    const session = new FakeSession('postgres');
    session.result = { columns, rows: Array.from({ length: ROWS }, (_, i) => row(i)) };

    gc();
    let baseline = process.memoryUsage.rss();
    let peak = baseline;
    const summary = await exportRows({
      session,
      query: 'SELECT * FROM customers',
      format: 'parquet',
      sink: fileSink(parquet),
      onProgress: () => (peak = Math.max(peak, process.memoryUsage.rss())),
      progressIntervalMs: 0,
    });
    const written = peak - baseline;
    expect(summary.status).toBe('completed');
    expect(summary.rowsWritten).toBe(ROWS);
    session.result = { columns, rows: [] };

    gc();
    baseline = process.memoryUsage.rss();
    peak = baseline;
    let rows = 0;
    let batches = 0;
    let last: unknown[] = [];
    for await (const batch of readRows(fileSource(parquet), { format: 'parquet' })) {
      rows += batch.rows.length;
      batches++;
      if (batch.rows.length > 0) last = [...batch.rows[batch.rows.length - 1]!];
      peak = Math.max(peak, process.memoryUsage.rss());
    }
    const read = peak - baseline;
    console.info(
      `parquet ${mb(statSync(parquet).size)} on disk: export RSS growth ${mb(written)}, ${rows} rows read in ${batches} batches, RSS growth ${mb(read)}`,
    );
    expect(rows).toBe(ROWS);
    expect(last).toEqual([
      ROWS,
      `Customer ${ROWS - 1} & Sons`,
      'Osaka',
      `${((ROWS - 1) * 7) % 100000}.25`,
      ((ROWS - 1) % 1000) / 1000,
      true,
      '2031-02-20',
      `2031-02-20 12:00:${String((ROWS - 1) % 60).padStart(2, '0')}Z`,
    ]);
    expect(batches).toBeGreaterThan(10);
    expect(written).toBeLessThan(LIMIT);
    expect(read).toBeLessThan(LIMIT);
  }, 120_000);
});
