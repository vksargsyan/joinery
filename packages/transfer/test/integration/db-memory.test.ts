import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';

import { afterAll, describe, expect, it } from 'vitest';

import { runDbTransfer } from '../../src';
import { opener, scratch, server, type Scratch } from './db-helpers';
import { query } from './helpers';

/**
 * Backpressure keeps memory flat (spec §12): a PostgreSQL table far larger than the heap
 * growth allowed is transferred into MySQL (or another PostgreSQL database), and the live heap
 * is sampled throughout. Pages are only fetched as the target takes them, so the heap holds a
 * few batches whatever the table's size.
 */

const PG = server('postgres');
const TARGET = server('mysql') ?? server('mariadb') ?? PG;
const ROWS = 400_000;
/** 256 characters of text per row: about 100 MB of text in all. */
const BODY_CHARS = 256;
const MAX_HEAP_GROWTH = 48 * 1024 * 1024;

setFlagsFromString('--expose-gc');
const gc = runInNewContext('gc') as () => void;

describe.skipIf(!PG || !TARGET)('memory', () => {
  const made: Scratch[] = [];
  afterAll(async () => {
    for (const db of made) await db.drop().catch(() => undefined);
  });

  it(`moves ${ROWS.toLocaleString('en-US')} rows (${Math.round((ROWS * BODY_CHARS) / 1e6)} MB of text) with the heap flat`, async () => {
    const source = await scratch(PG!, 'big_src');
    made.push(source);
    const target = await scratch(TARGET!, 'big_dst');
    made.push(target);
    const session = await source.connect();
    try {
      await query(
        session,
        `CREATE TABLE big AS SELECT g AS id, repeat(md5(g::text), ${BODY_CHARS / 32}) AS body, (g * 1.5)::numeric(12,2) AS amount, timestamp '2024-01-01' + g * interval '1 second' AS at FROM generate_series(1, ${ROWS}) g`,
      );
      await query(session, 'ALTER TABLE big ADD PRIMARY KEY (id)');
    } finally {
      await session.close();
    }

    gc();
    const baseline = process.memoryUsage().heapUsed;
    let peak = baseline;
    let samples = 0;
    let last = 0;
    const summary = await runDbTransfer({
      spec: {
        source: {},
        target: {},
        objects: [{ name: 'big' }],
        options: { batchSize: 2000 },
      },
      source: opener(() => source.connect()),
      target: opener(() => target.connect()),
      progressIntervalMs: 100,
      onProgress: () => {
        const now = performance.now();
        if (now - last < 500) return;
        last = now;
        gc();
        samples++;
        peak = Math.max(peak, process.memoryUsage().heapUsed);
      },
    });
    expect(summary.errors).toEqual([]);
    expect(summary.status).toBe('completed');
    expect(summary.rowsWritten).toBe(ROWS);
    expect(samples).toBeGreaterThan(3);
    const growth = peak - baseline;
    console.info(
      `db transfer ${ROWS} rows in ${summary.durationMs} ms (${Math.round((ROWS * 1000) / summary.durationMs)} rows/s); heap grew ${(growth / 1024 / 1024).toFixed(1)} MB at most over ${samples} samples`,
    );
    expect(growth).toBeLessThan(MAX_HEAP_GROWTH);
    const check = await target.connect();
    try {
      expect(await query(check, 'SELECT COUNT(*), MAX(id) FROM big')).toEqual([[ROWS, ROWS]]);
    } finally {
      await check.close();
    }
  });
});
