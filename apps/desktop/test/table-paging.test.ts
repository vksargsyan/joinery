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

/**
 * A server over `count` rows ordered by id that answers key-ordered keyset pages (after and
 * before a key), the last page, and offset pages.
 */
function server(count: number) {
  const data: CellValue[][] = Array.from({ length: count }, (_, i) => [i + 1, `row ${i + 1}`]);
  const queries: BrowseQuery[] = [];
  const fetch = async (query: BrowseQuery): Promise<CellValue[][]> => {
    queries.push(query);
    const offset = /OFFSET (\d+)/.exec(query.sql)?.[1];
    let rows = data;
    if (query.paging === 'keyset' && query.params.length > 0) {
      const key = query.params[0] as number;
      rows = query.reversed
        ? data.filter((row) => (row[0] as number) < key).reverse()
        : data.filter((row) => (row[0] as number) > key);
    } else if (query.reversed) rows = [...data].reverse();
    else if (offset !== undefined) rows = data.slice(Number(offset));
    return rows.slice(0, query.limit).map((row) => [...row]);
  };
  return { data, queries, fetch };
}

const ids = (paging: PagingController): CellValue[] =>
  paging.state.rows.map((row) => row[0] ?? null);
const range = (from: number, to: number): number[] =>
  Array.from({ length: to - from + 1 }, (_, i) => from + i);

describe('table paging', () => {
  it('shows one page at a time and steps to the next by key until a short page', async () => {
    const { queries, fetch } = server(25);
    let changes = 0;
    const paging = new PagingController(fetch, () => changes++, 10);
    await paging.reset(options());
    expect(paging.state).toMatchObject({
      paging: 'keyset',
      page: 1,
      pageSize: 10,
      hasNext: true,
      loading: false,
    });
    expect(ids(paging)).toEqual(range(1, 10));
    expect(paging.state.keys.slice(0, 2)).toEqual(['n1', 'n2']);
    expect(queries[0]!.sql).toBe(
      'SELECT "id", "name" FROM "public"."items" ORDER BY "id" ASC LIMIT 10',
    );
    await paging.goTo('next');
    expect(queries[1]!.sql).toBe(
      'SELECT "id", "name" FROM "public"."items" WHERE "id" > $1 ORDER BY "id" ASC LIMIT 10',
    );
    expect(queries[1]!.params).toEqual([10]);
    expect(paging.state.page).toBe(2);
    expect(ids(paging)).toEqual(range(11, 20));
    await paging.goTo('next');
    expect(ids(paging)).toEqual(range(21, 25));
    expect(paging.state).toMatchObject({ page: 3, hasNext: false });
    await paging.goTo('next');
    expect(queries).toHaveLength(3);
    expect(changes).toBeGreaterThan(3);
  });

  it('steps back by key, and to the first page from the start', async () => {
    const { queries, fetch } = server(25);
    const paging = new PagingController(fetch, () => undefined, 10);
    await paging.reset(options());
    await paging.goTo('next');
    await paging.goTo('next');
    await paging.goTo('previous');
    expect(queries[3]!.sql).toBe(
      'SELECT "id", "name" FROM "public"."items" WHERE "id" < $1 ORDER BY "id" DESC LIMIT 10',
    );
    expect(queries[3]!.params).toEqual([21]);
    expect(ids(paging)).toEqual(range(11, 20));
    expect(paging.state).toMatchObject({ page: 2, hasNext: true });
    await paging.goTo('first');
    expect(queries[4]!.sql).toBe(
      'SELECT "id", "name" FROM "public"."items" ORDER BY "id" ASC LIMIT 10',
    );
    expect(paging.state.page).toBe(1);
    await paging.goTo('previous');
    expect(queries).toHaveLength(5);
  });

  it('goes to a page by number at its offset', async () => {
    const { queries, fetch } = server(25);
    const paging = new PagingController(fetch, () => undefined, 10);
    await paging.reset(options());
    await paging.goTo(3);
    expect(queries[1]!.sql).toMatch(/ORDER BY "id" ASC LIMIT 10 OFFSET 20$/);
    expect(ids(paging)).toEqual(range(21, 25));
    expect(paging.state).toMatchObject({ page: 3, hasNext: false });
    expect(paging.offset).toBe(20);
    // Past the end the server has no rows: an empty page.
    await paging.goTo(9);
    expect(paging.state).toMatchObject({ page: 9, rows: [], hasNext: false });
  });

  it('keeps the page shown when the next is empty: the last page was exactly full', async () => {
    const { fetch } = server(20);
    const paging = new PagingController(fetch, () => undefined, 10);
    await paging.reset(options());
    await paging.goTo('next');
    expect(paging.state).toMatchObject({ page: 2, hasNext: true });
    await paging.goTo('next');
    expect(paging.state).toMatchObject({ page: 2, hasNext: false });
    expect(ids(paging)).toEqual(range(11, 20));
  });

  it('pages by offset without a key', async () => {
    const { queries, fetch } = server(25);
    const paging = new PagingController(fetch, () => undefined, 10);
    const identity = allColumnsIdentity(table, { dialect: 'postgres' });
    await paging.reset(options({ identity }));
    expect(paging.state.paging).toBe('offset');
    expect(paging.state.offsetReason).toBe('Rows are matched on every column, which is not unique');
    await paging.goTo('next');
    await paging.goTo('next');
    await paging.goTo('previous');
    expect(queries.map((q) => /LIMIT 10( OFFSET \d+)?$/.exec(q.sql)?.[0])).toEqual([
      'LIMIT 10',
      'LIMIT 10 OFFSET 10',
      'LIMIT 10 OFFSET 20',
      'LIMIT 10 OFFSET 10',
    ]);
    expect(ids(paging)).toEqual(range(11, 20));
  });

  it('starts over on the first page with a new page size', async () => {
    const { queries, fetch } = server(25);
    const paging = new PagingController(fetch, () => undefined, 10);
    await paging.reset(options());
    await paging.goTo(2);
    await paging.reset(options(), 5);
    expect(queries.at(-1)!.sql).toMatch(/LIMIT 5$/);
    expect(paging.state).toMatchObject({ page: 1, pageSize: 5 });
    expect(ids(paging)).toEqual(range(1, 5));
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
    await paging.goTo('next');
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
    expect(failing.state.loading).toBe(false);
    const invalid = new PagingController(
      () => Promise.resolve([]),
      () => undefined,
    );
    await expect(
      invalid.reset(options({ rawWhere: 'id = 1; drop table items' })),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });
});
