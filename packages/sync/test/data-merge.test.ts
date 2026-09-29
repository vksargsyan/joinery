import type { CellValue, ColumnKind } from '@joinery/core';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { compareKeys, mergeSortedRows } from '../src';
import type { MergeOptions, MergeSummary, Row, RowDiff } from '../src';

async function collect(
  source: Iterable<Row> | AsyncIterable<Row>,
  target: Iterable<Row> | AsyncIterable<Row>,
  options: MergeOptions,
): Promise<{ diffs: RowDiff[]; summary: MergeSummary }> {
  const merge = mergeSortedRows(source, target, options);
  const diffs: RowDiff[] = [];
  for (;;) {
    const next = await merge.next();
    if (next.done) return { diffs, summary: next.value };
    diffs.push(next.value);
  }
}

const simple: MergeOptions = {
  keyColumns: ['id'],
  sourceColumns: ['id', 'name', 'score'],
  targetColumns: ['id', 'name', 'score'],
  sourceKinds: { id: 'integer', name: 'string', score: 'float' },
  targetKinds: { id: 'integer', name: 'string', score: 'float' },
};

describe('mergeSortedRows', () => {
  it('classifies inserts, updates and deletes with the changed columns', async () => {
    const { diffs, summary } = await collect(
      [
        [1, 'a', 1.0],
        [2, 'b', 2.0],
        [4, 'd', 4.0],
      ],
      [
        [2, 'b', 2.5],
        [3, 'c', 3.0],
        [4, 'd', 4.0],
      ],
      simple,
    );
    expect(diffs.map((d) => [d.action, d.key[0], d.changedColumns])).toEqual([
      ['insert', 1, undefined],
      ['update', 2, ['score']],
      ['delete', 3, undefined],
    ]);
    expect(summary).toEqual({
      inserts: 1,
      updates: 1,
      deletes: 1,
      equal: 1,
      sourceRows: 3,
      targetRows: 3,
    });
  });

  it('merges composite keys and maps columns by name across different orders', async () => {
    const { diffs } = await collect(
      [
        [1, 'a', 'x'],
        [1, 'b', 'y'],
        [2, 'a', 'z'],
      ],
      [
        ['y2', 'b', 1],
        ['z', 'a', 2],
        ['w', 'c', 2],
      ],
      {
        keyColumns: ['k1', 'k2'],
        sourceColumns: ['k1', 'k2', 'v'],
        targetColumns: ['V', 'K2', 'K1'],
        sourceKinds: { k1: 'integer', k2: 'string', v: 'string' },
        targetKinds: { K1: 'integer', K2: 'string', V: 'string' },
      },
    );
    expect(diffs.map((d) => [d.action, ...d.key])).toEqual([
      ['insert', 1, 'a'],
      ['update', 1, 'b'],
      ['delete', 2, 'c'],
    ]);
  });

  it('skips an identical row repeated at a range boundary', async () => {
    const { diffs, summary } = await collect(
      [
        [1, 'a', 1],
        [2, 'b', 2],
        [2, 'b', 2],
        [3, 'c', 3],
      ],
      [
        [1, 'a', 1],
        [2, 'b', 2],
        [3, 'c', 3],
        [3, 'c', 3],
      ],
      simple,
    );
    expect(diffs).toEqual([]);
    expect(summary.equal).toBe(3);
    expect(summary.sourceRows).toBe(3);
  });

  it('rejects a key that is not unique or rows out of key order', async () => {
    await expect(
      collect(
        [
          [1, 'a', 1],
          [1, 'b', 1],
        ],
        [],
        simple,
      ),
    ).rejects.toThrow(/not unique in the source/);
    await expect(
      collect(
        [],
        [
          [2, 'a', 1],
          [1, 'b', 1],
        ],
        simple,
      ),
    ).rejects.toThrow(/not sorted by key/);
  });

  it('honours ignored columns, float tolerance and trim rules', async () => {
    const { diffs } = await collect([[1, 'a  ', 1.0000001]], [[1, 'a', 1.0]], {
      ...simple,
      ignoreColumns: [],
      canonical: { floatTolerance: 1e-3, trim: 'trailing' },
    });
    expect(diffs).toEqual([]);
    const ignored = await collect([[1, 'x', 1]], [[1, 'y', 1]], {
      ...simple,
      ignoreColumns: ['name'],
    });
    expect(ignored.diffs).toEqual([]);
  });

  it('compares across engine kinds (boolean vs tinyint, jsonb vs json text)', async () => {
    const { diffs } = await collect([[1, true, '{"a": 1, "b": 2}']], [[1, 1, '{"b":2,"a":1}']], {
      keyColumns: ['id'],
      sourceColumns: ['id', 'flag', 'doc'],
      targetColumns: ['id', 'flag', 'doc'],
      sourceKinds: { id: 'integer', flag: 'boolean', doc: 'json' },
      targetKinds: { id: 'integer', flag: 'integer', doc: 'string' },
    });
    expect(diffs).toEqual([]);
  });

  it('reads async streams lazily and closes them when stopped early', async () => {
    let closed = 0;
    async function* rows(n: number): AsyncGenerator<Row> {
      try {
        for (let i = 0; i < n; i++) yield [i, `r${i}`, i];
      } finally {
        closed++;
      }
    }
    const merge = mergeSortedRows(rows(1000), rows(0), simple);
    const first = await merge.next();
    expect(first.value).toMatchObject({ action: 'insert', key: [0] });
    await merge.return(undefined as never);
    expect(closed).toBe(2);
  });

  it('reproduces the source from the target (property)', async () => {
    const kinds: ColumnKind[] = ['integer', 'string'];
    const keyArb = fc.tuple(
      fc.integer({ min: 0, max: 30 }),
      fc.constantFrom('a', 'B', 'é', '\u{1F600}', ''),
    );
    const tableArb = fc
      .uniqueArray(fc.tuple(keyArb, fc.option(fc.integer({ min: 0, max: 3 }), { nil: null })), {
        selector: ([key]) => JSON.stringify(key),
        maxLength: 40,
      })
      .map((entries) =>
        entries
          .map(([key, value]): Row => [key[0], key[1], value])
          .sort((a, b) => compareKeys(a.slice(0, 2), b.slice(0, 2), kinds)),
      );
    await fc.assert(
      fc.asyncProperty(tableArb, tableArb, async (source, target) => {
        const options: MergeOptions = {
          keyColumns: ['k1', 'k2'],
          sourceColumns: ['k1', 'k2', 'v'],
          targetColumns: ['k1', 'k2', 'v'],
          sourceKinds: { k1: 'integer', k2: 'string', v: 'integer' },
          targetKinds: { k1: 'integer', k2: 'string', v: 'integer' },
        };
        const { diffs, summary } = await collect(source, target, options);
        const state = new Map<string, CellValue>(
          target.map((r) => [JSON.stringify(r.slice(0, 2)), r[2] ?? null]),
        );
        for (const diff of diffs) {
          const key = JSON.stringify(diff.key);
          if (diff.action === 'delete') state.delete(key);
          else state.set(key, diff.sourceRow![2] ?? null);
        }
        const expected = new Map(source.map((r) => [JSON.stringify(r.slice(0, 2)), r[2] ?? null]));
        expect(state).toEqual(expected);
        expect(summary.inserts + summary.updates + summary.equal).toBe(source.length);
        expect(summary.deletes + summary.updates + summary.equal).toBe(target.length);
      }),
      { numRuns: 200 },
    );
  });
});
