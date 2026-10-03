import type { CellValue, ColumnMeta } from '@querybara/core';
import { describe, expect, it } from 'vitest';

import { compareTableData, generateDataSyncScript } from '../src';
import type {
  DataCompareEvent,
  DataCompareOptions,
  DataCompareSummary,
  RowDiff,
  TablePair,
} from '../src';
import { FakeSession } from './fake-session';

const columns: ColumnMeta[] = [
  { name: 'id', nativeType: 'int4', kind: 'integer' },
  { name: 'name', nativeType: 'text', kind: 'string' },
  { name: 'price', nativeType: 'numeric', kind: 'decimal' },
];

function rows(
  n: number,
  edit: (id: number) => CellValue[] | null = (id) => [id, `item ${id}`, `${id}.50`],
): CellValue[][] {
  const out: CellValue[][] = [];
  for (let id = 1; id <= n; id++) {
    const row = edit(id);
    if (row !== null) out.push(row);
  }
  return out;
}

const pair: TablePair = {
  source: { schema: 'public', name: 'items' },
  target: { schema: 'public', name: 'items' },
  keyColumns: ['id'],
};

async function run(
  source: FakeSession,
  target: FakeSession,
  options: DataCompareOptions = {},
  tablePair: TablePair = pair,
): Promise<{ events: DataCompareEvent[]; diffs: RowDiff[]; summary: DataCompareSummary }> {
  const events: DataCompareEvent[] = [];
  const generator = compareTableData(source, target, tablePair, options);
  for (;;) {
    const next = await generator.next();
    if (next.done) {
      return {
        events,
        diffs: events.flatMap((e) => (e.type === 'diff' ? [e.diff] : [])),
        summary: next.value,
      };
    }
    events.push(next.value);
  }
}

const isRowsQuery = (text: string): boolean =>
  text.includes('ORDER BY') && !text.includes('LIMIT') && !text.includes('row_count');
const rowQueries = (session: FakeSession): number =>
  session.executed.filter((q) => isRowsQuery(q.text)).length;

describe('compareTableData', () => {
  it('matches identical tables through checksums without streaming rows', async () => {
    const source = new FakeSession('postgres', columns, rows(95), ['id']);
    const target = new FakeSession('postgres', columns, rows(95), ['id']);
    const { diffs, summary, events } = await run(source, target, { chunkRows: 20, streamRows: 5 });
    expect(diffs).toEqual([]);
    expect(summary).toMatchObject({
      equal: 95,
      sourceRows: 95,
      targetRows: 95,
      ranges: 5,
      matchedRanges: 5,
      streamedRanges: 0,
      checksums: true,
    });
    expect(rowQueries(source) + rowQueries(target)).toBe(0);
    expect(events[0]).toMatchObject({
      type: 'start',
      compared: ['name', 'price'],
      checksums: true,
    });
    expect(events.at(-1)).toMatchObject({ type: 'done' });
  });

  it('bisects mismatched ranges and streams only small ones', async () => {
    const source = new FakeSession('postgres', columns, rows(200), ['id']);
    const target = new FakeSession(
      'postgres',
      columns,
      rows(205, (id) =>
        id === 57 ? null : id === 130 ? [id, 'changed', '130.50'] : [id, `item ${id}`, `${id}.50`],
      ),
      ['id'],
    );
    const { diffs, summary } = await run(source, target, { chunkRows: 50, streamRows: 8 });
    expect(diffs.map((d) => [d.action, d.key[0], d.changedColumns])).toEqual([
      ['insert', 57, undefined],
      ['update', 130, ['name']],
      ['delete', 201, undefined],
      ['delete', 202, undefined],
      ['delete', 203, undefined],
      ['delete', 204, undefined],
      ['delete', 205, undefined],
    ]);
    expect(summary).toMatchObject({
      inserts: 1,
      updates: 1,
      deletes: 5,
      sourceRows: 200,
      targetRows: 204,
    });
    expect(summary.equal).toBe(198);
    // Only the neighbourhoods of the differences were streamed.
    expect(rowQueries(source)).toBeGreaterThan(0);
    expect(summary.streamedRanges).toBeLessThan(summary.ranges);
  });

  it('turns the differences into a sync script', async () => {
    const source = new FakeSession('postgres', columns, rows(10), ['id']);
    const target = new FakeSession(
      'postgres',
      columns,
      rows(10, (id) => (id === 3 ? [3, 'x', '3.50'] : [id, `item ${id}`, `${id}.50`])),
      ['id'],
    );
    const { diffs } = await run(source, target);
    const script = generateDataSyncScript(diffs, {
      dialect: 'postgres',
      table: pair.target,
      keyColumns: ['id'],
      sourceColumns: ['id', 'name', 'price'],
      targetColumns: ['id', 'name', 'price'],
    });
    expect(script.statements).toEqual([
      'BEGIN',
      `UPDATE "public"."items" SET "name" = 'item 3' WHERE "id" = 3`,
      'COMMIT',
    ]);
  });

  it('supports composite keys and MySQL-style predicates', async () => {
    const meta: ColumnMeta[] = [
      { name: 'region', nativeType: 'varchar(8)', kind: 'string' },
      { name: 'id', nativeType: 'int', kind: 'integer' },
      { name: 'total', nativeType: 'int', kind: 'integer' },
    ];
    const make = (skip: string): CellValue[][] => {
      const out: CellValue[][] = [];
      for (const region of ['eu', 'us', 'ap']) {
        for (let id = 1; id <= 30; id++)
          if (`${region}${id}` !== skip) out.push([region, id, id * 10]);
      }
      return out;
    };
    const source = new FakeSession('mysql', meta, make(''), ['region', 'id']);
    const target = new FakeSession('mysql', meta, make('us17'), ['region', 'id']);
    const { diffs, summary } = await run(
      source,
      target,
      { chunkRows: 16, streamRows: 4 },
      {
        source: { name: 'sales' },
        target: { name: 'sales' },
        keyColumns: ['region', 'id'],
      },
    );
    expect(diffs.map((d) => [d.action, ...d.key])).toEqual([['insert', 'us', 17]]);
    expect(summary.equal).toBe(89);
    const checksums = source.executed.filter((q) => q.text.includes('BIT_XOR')).map((q) => q.text);
    expect(
      checksums.some((t) =>
        t.includes(
          'WHERE (`region` > ? OR (`region` = ? AND `id` > ?)) AND (`region` < ? OR (`region` = ? AND `id` <= ?))',
        ),
      ),
    ).toBe(true);
    expect(
      source.executed.some((q) => q.text.includes('ORDER BY CAST(`region` AS BINARY), `id`')),
    ).toBe(true);
  });

  it('streams everything and canonicalises values across engines', async () => {
    const pgMeta: ColumnMeta[] = [
      { name: 'id', nativeType: 'int8', kind: 'bigint' },
      { name: 'active', nativeType: 'bool', kind: 'boolean' },
      { name: 'created', nativeType: 'timestamptz', kind: 'timestamp' },
    ];
    const myMeta: ColumnMeta[] = [
      { name: 'ID', nativeType: 'bigint', kind: 'bigint' },
      { name: 'active', nativeType: 'tinyint(1)', kind: 'integer' },
      { name: 'created', nativeType: 'datetime', kind: 'datetime' },
    ];
    const source = new FakeSession(
      'postgres',
      pgMeta,
      [
        [1n, true, '2024-01-01 12:00:00+01'],
        [2n, false, '2024-01-02 00:00:00+00'],
      ],
      ['id'],
    );
    const target = new FakeSession(
      'mysql',
      myMeta,
      [
        [1n, 1, '2024-01-01 11:00:00'],
        [2n, 1, '2024-01-02 00:00:00'],
      ],
      ['ID'],
    );
    const { diffs, summary } = await run(
      source,
      target,
      {},
      {
        source: { schema: 'public', name: 'users' },
        target: { name: 'users' },
        keyColumns: ['id'],
      },
    );
    expect(summary.checksums).toBe(false);
    expect(diffs.map((d) => [d.action, d.key[0], d.changedColumns])).toEqual([
      ['update', 2n, ['active']],
    ]);
    expect(source.executed.some((q) => q.text.includes('md5'))).toBe(false);
  });

  it('can be cancelled between ranges', async () => {
    const controller = new AbortController();
    const source = new FakeSession('postgres', columns, rows(100), ['id']);
    const target = new FakeSession('postgres', columns, rows(100), ['id']);
    const generator = compareTableData(source, target, pair, {
      chunkRows: 10,
      signal: controller.signal,
    });
    await generator.next();
    await generator.next();
    controller.abort();
    await expect(generator.next()).rejects.toMatchObject({ code: 'CANCELLED' });
  });

  it('requires a key present on both sides', async () => {
    const source = new FakeSession('postgres', columns, rows(1), ['id']);
    const target = new FakeSession('postgres', columns.slice(1), [['a', '1']], ['name']);
    await expect(run(source, target)).rejects.toThrow(/Key column id is missing/);
    await expect(run(source, source, {}, { ...pair, keyColumns: [] })).rejects.toThrow(
      /needs a primary or unique key/,
    );
  });
});
