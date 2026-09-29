import type { SqlDialect } from '@joinery/core';
import { describe, expect, it } from 'vitest';

import {
  buildBrowseQuery,
  buildCountQuery,
  buildEstimateQuery,
  condition,
  pageAfter,
  pageBefore,
  parseEstimate,
  rowIdentity,
  type BrowseOptions,
} from '../src';
import { itemsFor } from './fixtures';

function browse(dialect: SqlDialect, options: Partial<BrowseOptions>) {
  const { table, columns } = itemsFor(dialect);
  return buildBrowseQuery({
    dialect,
    table: { name: 'items' },
    columns,
    identity: rowIdentity(table),
    select: ['id', 'name', 'qty'],
    limit: 50,
    ...options,
  });
}

describe('buildBrowseQuery', () => {
  it('reads the first page ordered by sort then key, adding key columns to the select list', () => {
    const query = browse('postgres', { sort: [{ column: 'name', direction: 'asc' }] });
    expect(query.sql).toBe(
      'SELECT "id", "name", "qty", "region" FROM "items" ORDER BY "name" ASC, "region" ASC, "id" ASC LIMIT 50',
    );
    expect(query).toMatchObject({
      params: [],
      columns: ['id', 'name', 'qty', 'region'],
      paging: 'keyset',
      keyIndexes: [1, 3, 0],
      identityIndexes: [3, 0],
      reversed: false,
    });
  });

  it('continues after a row with NULL-aware keyset conditions per dialect', () => {
    const sort = [{ column: 'name', direction: 'asc' as const }];
    const pg = browse('postgres', { sort, page: { kind: 'after', key: ['m', 'eu', 5] } });
    // PostgreSQL: NULLs sort last ascending, so they come after every name.
    expect(pg.sql).toBe(
      'SELECT "id", "name", "qty", "region" FROM "items" WHERE (("name" > $1 OR "name" IS NULL) OR ("name" = $2 AND ("region" > $3 OR ("region" = $4 AND "id" > $5)))) ORDER BY "name" ASC, "region" ASC, "id" ASC LIMIT 50',
    );
    expect(pg.params).toEqual(['m', 'm', 'eu', 'eu', 5]);
    // MySQL: NULLs sort first ascending, so none come after a name.
    const my = browse('mysql', { sort, page: { kind: 'after', key: ['m', 'eu', 5] } });
    expect(my.sql).toBe(
      'SELECT `id`, `name`, `qty`, `region` FROM `items` WHERE (`name` > ? OR (`name` = ? AND (`region` > ? OR (`region` = ? AND `id` > ?)))) ORDER BY `name` ASC, `region` ASC, `id` ASC LIMIT 50',
    );
    // After a NULL name: PostgreSQL continues among NULLs only; MySQL moves on to non-NULL names.
    expect(
      browse('postgres', { sort, page: { kind: 'after', key: [null, 'eu', 5] } }).sql,
    ).toContain('WHERE ("name" IS NULL AND ("region" > $1 OR ("region" = $2 AND "id" > $3)))');
    expect(browse('mysql', { sort, page: { kind: 'after', key: [null, 'eu', 5] } }).sql).toContain(
      'WHERE (`name` IS NOT NULL OR (`name` IS NULL AND (`region` > ? OR (`region` = ? AND `id` > ?))))',
    );
  });

  it('guards the leading NOT NULL column and handles mixed directions', () => {
    const query = browse('mariadb', {
      sort: [{ column: 'qty', direction: 'desc' }],
      page: { kind: 'after', key: [3, 'eu', 7] },
    });
    expect(query.sql).toBe(
      'SELECT `id`, `name`, `qty`, `region` FROM `items` WHERE (`qty` <= ? AND (`qty` < ? OR (`qty` = ? AND (`region` > ? OR (`region` = ? AND `id` > ?))))) ORDER BY `qty` DESC, `region` ASC, `id` ASC LIMIT 50',
    );
    expect(query.params).toEqual([3, 3, 3, 'eu', 'eu', 7]);
  });

  it('uses a row comparison on PostgreSQL when every term is NOT NULL in one direction', () => {
    const query = browse('postgres', { page: { kind: 'after', key: ['eu', 7n] } });
    expect(query.sql).toBe(
      'SELECT "id", "name", "qty", "region" FROM "items" WHERE ("region", "id") > ($1, $2) ORDER BY "region" ASC, "id" ASC LIMIT 50',
    );
    expect(query.params).toEqual(['eu', 7n]);
    expect(browse('mysql', { page: { kind: 'after', key: ['eu', 7n] } }).sql).toContain(
      'WHERE (`region` >= ? AND (`region` > ? OR (`region` = ? AND `id` > CAST(? AS UNSIGNED))))',
    );
  });

  it('reads backwards for before and last pages', () => {
    const before = browse('postgres', {
      sort: [{ column: 'qty', direction: 'asc' }],
      page: { kind: 'before', key: [3, 'eu', 7] },
    });
    expect(before.sql).toBe(
      'SELECT "id", "name", "qty", "region" FROM "items" WHERE ("qty", "region", "id") < ($1, $2, $3) ORDER BY "qty" DESC, "region" DESC, "id" DESC LIMIT 50',
    );
    expect(before.reversed).toBe(true);
    const last = browse('mysql', {
      sort: [{ column: 'name', direction: 'asc' }],
      page: { kind: 'last' },
    });
    expect(last.sql).toBe(
      'SELECT `id`, `name`, `qty`, `region` FROM `items` ORDER BY `name` DESC, `region` DESC, `id` DESC LIMIT 50',
    );
    expect(last.reversed).toBe(true);
  });

  it('spells out non-default NULL placement', () => {
    expect(
      browse('postgres', { sort: [{ column: 'name', direction: 'asc', nulls: 'first' }] }).sql,
    ).toContain('ORDER BY "name" ASC NULLS FIRST, "region" ASC');
    expect(
      browse('mysql', { sort: [{ column: 'name', direction: 'asc', nulls: 'last' }] }).sql,
    ).toContain('ORDER BY `name` IS NULL ASC, `name` ASC, `region` ASC');
    expect(
      browse('mysql', { sort: [{ column: 'qty', direction: 'asc', nulls: 'last' }] }).sql,
    ).toContain('ORDER BY `qty` ASC, `region` ASC');
  });

  it('pages by offset without a key, or when a sort column cannot be compared', () => {
    const none = buildBrowseQuery({
      dialect: 'postgres',
      table: { schema: 'app', name: 'items' },
      columns: itemsFor('postgres').columns,
      identity: { kind: 'none', columns: [] },
      select: ['name'],
      sort: [{ column: 'name', direction: 'desc' }],
      page: { kind: 'offset', offset: 100 },
      limit: 25,
    });
    expect(none.sql).toBe(
      'SELECT "name" FROM "app"."items" ORDER BY "name" DESC LIMIT 25 OFFSET 100',
    );
    expect(none).toMatchObject({
      paging: 'offset',
      offsetReason: 'The table has no primary or unique key',
    });
    const enumSort = browse('mysql', { sort: [{ column: 'feeling', direction: 'asc' }] });
    expect(enumSort.paging).toBe('offset');
    expect(enumSort.offsetReason).toMatch(/ENUM/);
    expect(() =>
      browse('mysql', {
        sort: [{ column: 'feeling', direction: 'asc' }],
        page: { kind: 'after', key: ['ok', 'eu', 1] },
      }),
    ).toThrow(/Keyset pages are not available/);
    const all = browse('postgres', {
      identity: { kind: 'all-columns', columns: ['region', 'id', 'name'] },
      page: { kind: 'offset', offset: 0 },
    });
    expect(all.sql).toBe('SELECT "id", "name", "qty", "region" FROM "items" LIMIT 50');
    expect(all.identityIndexes).toEqual([3, 0, 1]);
  });

  it('builds the next and previous page from loaded rows', () => {
    const query = browse('postgres', { sort: [{ column: 'name', direction: 'asc' }] });
    expect(pageAfter(query, [5, 'x', 1, 'eu'])).toEqual({ kind: 'after', key: ['x', 'eu', 5] });
    expect(pageBefore(query, [5, null, 1, 'eu'])).toEqual({ kind: 'before', key: [null, 'eu', 5] });
  });

  it('rejects what it cannot build', () => {
    expect(() => browse('postgres', { sort: [{ column: 'raw', direction: 'asc' }] })).toThrow(
      /Cannot sort by raw/,
    );
    expect(() => browse('postgres', { sort: [{ column: 'nope', direction: 'asc' }] })).toThrow(
      /Unknown sort column nope/,
    );
    expect(() => browse('postgres', { limit: 0 })).toThrow(/page size/);
    expect(() => browse('postgres', { page: { kind: 'after', key: [1] } })).toThrow(
      /needs 2 key values/,
    );
    expect(() => browse('postgres', { page: { kind: 'offset', offset: -1 } })).toThrow(/offset/);
  });

  it('combines filter, raw condition and keyset with AND', () => {
    const query = browse('postgres', {
      filter: condition('qty', '>', 1),
      rawWhere: 'price IS NOT NULL',
      page: { kind: 'after', key: ['eu', 5] },
    });
    expect(query.sql).toContain(
      'WHERE "qty" > $1 AND (price IS NOT NULL) AND ("region", "id") > ($2, $3) ORDER BY',
    );
    expect(query.params).toEqual([1, 'eu', 5]);
  });
});

describe('counts and estimates', () => {
  const { columns } = itemsFor('postgres');
  const mysqlColumns = itemsFor('mysql').columns;

  it('counts exactly with the same filter', () => {
    expect(
      buildCountQuery({
        dialect: 'mysql',
        table: { name: 'items' },
        columns: mysqlColumns,
        filter: condition('qty', '=', 1),
      }),
    ).toEqual({ sql: 'SELECT count(*) AS `count` FROM `items` WHERE `qty` = ?', params: [1] });
  });

  it('estimates from the catalog without a filter and from the planner with one', () => {
    const pg = buildEstimateQuery({
      dialect: 'postgres',
      table: { schema: 'app', name: 'Items' },
      columns,
    });
    expect(pg.source).toBe('pg-class');
    expect(pg.sql).toMatch(/FROM pg_catalog\.pg_class c WHERE c\.oid = CAST\(\$1 AS regclass\)$/);
    expect(pg.params).toEqual(['"app"."Items"']);
    const pgFiltered = buildEstimateQuery({
      dialect: 'postgres',
      table: { name: 'items' },
      columns,
      filter: condition('qty', '>', 5),
    });
    expect(pgFiltered).toEqual({
      sql: 'EXPLAIN (FORMAT JSON) SELECT 1 FROM "items" WHERE "qty" > $1',
      params: [5],
      source: 'pg-explain',
    });
    expect(
      buildEstimateQuery({ dialect: 'mysql', table: { name: 'items' }, columns: mysqlColumns }),
    ).toEqual({
      sql: 'SELECT TABLE_ROWS AS estimate FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?',
      params: ['items'],
      source: 'mysql-table-rows',
    });
    expect(
      buildEstimateQuery({
        dialect: 'mariadb',
        table: { name: 'items' },
        columns: mysqlColumns,
        rawWhere: 'qty > 1',
      }),
    ).toEqual({
      sql: 'EXPLAIN SELECT 1 FROM `items` WHERE (qty > 1)',
      params: [],
      source: 'mysql-explain',
    });
    expect(
      buildEstimateQuery({
        dialect: 'mysql',
        table: { name: 'items' },
        columns: mysqlColumns,
        rawWhere: 'qty > 1',
      }).sql,
    ).toBe('EXPLAIN FORMAT=TRADITIONAL SELECT 1 FROM `items` WHERE (qty > 1)');
  });

  it('parses each estimate source', () => {
    const q = (source: 'pg-class' | 'pg-explain' | 'mysql-table-rows' | 'mysql-explain') => ({
      sql: '',
      params: [],
      source,
    });
    expect(parseEstimate(q('pg-class'), ['estimate'], [[1234n]])).toBe(1234);
    expect(parseEstimate(q('pg-class'), ['estimate'], [[null]])).toBeNull();
    expect(
      parseEstimate(q('pg-explain'), ['QUERY PLAN'], [['[{"Plan": {"Plan Rows": 42}}]']]),
    ).toBe(42);
    expect(parseEstimate(q('mysql-table-rows'), ['estimate'], [[17]])).toBe(17);
    expect(parseEstimate(q('mysql-explain'), ['id', 'rows', 'filtered'], [[1, 200, 33.33]])).toBe(
      67,
    );
    expect(parseEstimate(q('mysql-explain'), ['id', 'rows'], [[1, '80']])).toBe(80);
    expect(parseEstimate(q('mysql-explain'), ['rows'], [])).toBeNull();
  });
});
