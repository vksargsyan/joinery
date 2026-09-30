import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { fileSource, readRows } from '../src';
import { writeLargeWorkbook } from './xlsx-helpers';

/**
 * The xlsx reader streams (spec §12, §18): a 200,000-row workbook written the way Excel
 * writes one (every text in the shared string table) reads with well under 200 MB of RSS
 * growth, less than the worksheet XML itself would take held as a string.
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
