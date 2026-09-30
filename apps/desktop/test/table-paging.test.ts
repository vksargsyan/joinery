import { JoineryError, tableDefSchema, type CellValue } from '@joinery/core';
import {
  allColumnsIdentity,
  and,
  condition,
  describeColumns,
  rowIdentity,
  type BrowseQuery,
} from '@joinery/table-data';
import { describe, expect, it } from 'vitest';

import { PagingController, type PagingOptions } from '../src/renderer/src/state/table/paging';

const table = tableDefSchema.parse({
  name: 'items',
  columns: [
    { name: 'id', ordinal: 1, dataType: 'integer', nullable: false },
    { name: 'name', ordinal: 2, dataType: 'text', nullable: true },
  ],
  primaryKey: { name: 'items_pkey', columns: ['id'] },
});
const columns = describeColumns(table, { dialect: 'postgres' });

function options(overrides: Partial<PagingOptions> = {}): PagingOptions {
  return {
    dialect: 'postgres',
    table: { schema: 'public', name: 'items' },
    columns,
    identity: rowIdentity(table),
    ...overrides,
  };
}

/** A server over `count` rows ordered by id that answers key-ordered keyset and offset pages. */
function server(count: number) {
  const data: CellValue[][] = Array.from({ length: count }, (_, i) => [i + 1, `row ${i + 1}`]);
  const queries: BrowseQuery[] = [];
  const fetch = async (query: BrowseQuery): Promise<CellValue[][]> => {
    queries.push(query);
    const offset = /OFFSET (\d+)/.exec(query.sql)?.[1];
    let rows = data;
    if (query.paging === 'keyset' && query.params.length > 0) {
      const after = query.params[0] as number;
      rows = data.filter((row) => (row[0] as number) > after);
    } else if (offset !== undefined) rows = data.slice(Number(offset));
    return rows.slice(0, query.limit).map((row) => [...row]);
  };
  return { data, queries, fetch };
}

describe('table paging', () => {
  it('pages by key after the last row read until a short page', async () => {
    const { queries, fetch } = server(25);
    let changes = 0;
    const paging = new PagingController(fetch, () => changes++, 10);
    await paging.reset(options());
    expect(paging.state).toMatchObject({ paging: 'keyset', hasMore: true, loading: false });
    expect(paging.state.rows).toHaveLength(10);
    expect(paging.state.keys.slice(0, 2)).toEqual(['n1', 'n2']);
    expect(queries[0]!.sql).toBe(
      'SELECT "id", "name" FROM "public"."items" ORDER BY "id" ASC LIMIT 10',
    );
    await paging.loadMore();
    expect(queries[1]!.sql).toBe(
      'SELECT "id", "name" FROM "public"."items" WHERE "id" > $1 ORDER BY "id" ASC LIMIT 10',
    );
    expect(queries[1]!.params).toEqual([10]);
    await paging.loadMore();
    expect(paging.state.rows.map((row) => row[0])).toEqual(
      Array.from({ length: 25 }, (_, i) => i + 1),
    );
    expect(paging.state.hasMore).toBe(false);
    await paging.loadMore();
    expect(queries).toHaveLength(3);
    expect(changes).toBeGreaterThan(3);
  });

  it('asks for the next page only near the end of what is loaded', async () => {
    const { fetch } = server(1000);
    const paging = new PagingController(fetch, () => undefined, 200);
    await paging.reset(options());
    expect(paging.shouldLoadMore(20)).toBe(false);
    expect(paging.shouldLoadMore(60)).toBe(true);
  });

  it('pages by offset without a key, and moves the offset back after deletes', async () => {
    const { queries, fetch } = server(25);
    const paging = new PagingController(fetch, () => undefined, 10);
    const identity = allColumnsIdentity(table, { dialect: 'postgres' });
    await paging.reset(options({ identity }));
    expect(paging.state.paging).toBe('offset');
    expect(paging.state.offsetReason).toBe('Rows are matched on every column, which is not unique');
    const state = paging.state;
    paging.replaceRows(
      state.rows.slice(2).map((row) => [...row]),
      state.keys.slice(2),
      2,
    );
    await paging.loadMore();
    expect(queries[1]!.sql).toMatch(/LIMIT 10 OFFSET 8$/);
  });

  it('keeps filter and sort in every page query', async () => {
    const queries: BrowseQuery[] = [];
    const fetch = async (query: BrowseQuery): Promise<CellValue[][]> => {
      queries.push(query);
      return [
        [queries.length * 2 - 1, 'row b'],
        [queries.length * 2, 'row a'],
      ];
    };
    const paging = new PagingController(fetch, () => undefined, 2);
    await paging.reset(
      options({
        filter: and(condition('name', 'contains', 'row')),
        sort: [{ column: 'name', direction: 'desc' }],
      }),
    );
    await paging.loadMore();
    expect(queries[1]!.sql).toContain(`WHERE "name" ILIKE $1 ESCAPE '!' AND (`);
    expect(queries[1]!.sql).toContain('ORDER BY "name" DESC, "id" ASC LIMIT 2');
    // Continues after the last row read: (name, id) past ('row a', 2) in that order.
    expect(queries[1]!.params).toEqual(['%row%', 'row a', 'row a', 2]);
  });

  it('drops a page that arrives after the query changed', async () => {
    const gates: ((rows: CellValue[][]) => void)[] = [];
    const fetch = (): Promise<CellValue[][]> =>
      new Promise((resolve) => {
        gates.push(resolve);
      });
    const paging = new PagingController(fetch, () => undefined, 10);
    const first = paging.reset(options());
    const second = paging.reset(options({ sort: [{ column: 'name', direction: 'asc' }] }));
    gates[0]!([[1, 'stale']]);
    gates[1]!([[2, 'fresh']]);
    await Promise.all([first, second]);
    expect(paging.state.rows).toEqual([[2, 'fresh']]);
  });

  it('keeps a failed fetch as the error and rejects options that make no query', async () => {
    const failing = new PagingController(
      () => Promise.reject(new JoineryError({ code: 'SQL_ERROR', message: 'boom' })),
      () => undefined,
    );
    await failing.reset(options());
    expect(failing.state.error).toMatchObject({ message: 'boom' });
    expect(failing.shouldLoadMore(0)).toBe(false);
    const invalid = new PagingController(
      () => Promise.resolve([]),
      () => undefined,
    );
    await expect(
      invalid.reset(options({ rawWhere: 'id = 1; drop table items' })),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });
});
