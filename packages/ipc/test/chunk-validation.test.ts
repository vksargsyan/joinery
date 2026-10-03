import { toColumnChunk, type CellValue, type ResultChunk } from '@querybara/core';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { cellValueSchema, largeValueHandleSchema, resultChunkSchema } from '../src';

type RowsChunk = Extract<ResultChunk, { type: 'rows' }>;

function cellFor(column: number, row: number): CellValue {
  switch (column % 5) {
    case 0:
      return row * column;
    case 1:
      return `value ${row}`;
    case 2:
      return row % 3 === 0 ? null : row % 2 === 0;
    case 3:
      return BigInt(row) * 2n ** 60n;
    default:
      return new Uint8Array([row & 255, column & 255]);
  }
}

function makeChunk(rows = 1000, columns = 50): RowsChunk {
  const data = Array.from({ length: rows }, (_, r) =>
    Array.from({ length: columns }, (_, c) => cellFor(c, r)),
  );
  return toColumnChunk(0, columns, data);
}

/** Median milliseconds per call of `fn`, after a warm-up. */
function median(fn: () => void, runs = 9): number {
  for (let i = 0; i < 2; i++) fn();
  const times: number[] = [];
  for (let i = 0; i < runs; i++) {
    const start = performance.now();
    fn();
    times.push(performance.now() - start);
  }
  times.sort((a, b) => a - b);
  return times[Math.floor(runs / 2)] ?? Number.NaN;
}

describe('rows chunk validation', () => {
  it('accepts every CellValue kind and returns the chunk arrays without copying', () => {
    const chunk: RowsChunk = {
      type: 'rows',
      resultIndex: 0,
      rowCount: 2,
      data: [
        [null, true],
        [Number.NaN, Number.POSITIVE_INFINITY],
        [2n ** 64n, 'text'],
        [new Uint8Array([1]), { $handle: 'h1', preview: 'abc…', byteLength: 1e6, kind: 'text' }],
      ],
    };
    const parsed = resultChunkSchema.parse(chunk);
    expect(parsed).toEqual(chunk);
    expect(parsed.type === 'rows' && parsed.data).toBe(chunk.data);
  });

  it('rejects a column whose length is not rowCount', () => {
    const result = resultChunkSchema.safeParse({
      type: 'rows',
      resultIndex: 0,
      rowCount: 2,
      data: [[1, 2], [3]],
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(['data', 1]);
  });

  it('rejects cells outside the CellValue kinds, and holes', () => {
    for (const bad of [new Date(0), undefined, { not: 'a handle' }, [1], Symbol('s')]) {
      const result = resultChunkSchema.safeParse({
        type: 'rows',
        resultIndex: 0,
        rowCount: 2,
        data: [
          [1, 2],
          ['a', bad],
        ],
      });
      expect(result.success).toBe(false);
      expect(result.error?.issues[0]?.path).toEqual(['data', 1, 1]);
    }
    const holes: unknown[] = new Array(2);
    expect(
      resultChunkSchema.safeParse({ type: 'rows', resultIndex: 0, rowCount: 2, data: [holes] })
        .success,
    ).toBe(false);
  });

  it('rejects malformed chunk envelopes', () => {
    for (const bad of [
      { type: 'rows', resultIndex: -1, rowCount: 0, data: [] },
      { type: 'rows', resultIndex: 0, rowCount: 1.5, data: [] },
      { type: 'rows', resultIndex: 0, rowCount: 0, data: 'nope' },
      { type: 'rows', resultIndex: 0, rowCount: 1, data: [1] },
      { type: 'row', resultIndex: 0, rowCount: 0, data: [] },
      { type: 'end', durationMs: -1, rowCount: 0 },
    ]) {
      expect(resultChunkSchema.safeParse(bad).success).toBe(false);
    }
  });

  it('keeps per-chunk validation cheap for 1,000 rows × 50 columns', () => {
    const chunk = makeChunk();
    const naive = z.object({
      type: z.literal('rows'),
      resultIndex: z.number().int().nonnegative(),
      rowCount: z.number().int().nonnegative(),
      data: z.array(
        z.array(
          z.union([
            z.null(),
            z.boolean(),
            z.number(),
            z.bigint(),
            z.string(),
            z.instanceof(Uint8Array),
            largeValueHandleSchema,
          ]),
        ),
      ),
    });
    expect(naive.safeParse(chunk).success).toBe(true);
    expect(cellValueSchema.safeParse(chunk.data[0]?.[0]).success).toBe(true);

    const fast = median(() => resultChunkSchema.parse(chunk));
    const slow = median(() => naive.parse(chunk));
    const clone = median(() => structuredClone(chunk));
    console.info(
      `1,000×50 rows chunk: resultChunkSchema ${fast.toFixed(3)} ms, ` +
        `nested zod union ${slow.toFixed(3)} ms, structuredClone ${clone.toFixed(3)} ms`,
    );
    // Generous bounds so a loaded CI machine does not flake; typical figures are in results.ts.
    expect(fast).toBeLessThan(15);
    expect(fast).toBeLessThan(slow);
    // A benchmark: under a fully parallel workspace test run it can take seconds.
  }, 60_000);
});
