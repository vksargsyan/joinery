import type { CellValue, SqlDialect } from '@joinery/core';
import { describe, expect, it } from 'vitest';

import {
  and,
  buildCountQuery,
  condition,
  operatorsFor,
  or,
  validateFilter,
  type FilterNode,
} from '../src';
import { itemsFor } from './fixtures';

function where(
  dialect: SqlDialect,
  filter: FilterNode,
): { sql: string; params: readonly CellValue[] } {
  const { columns } = itemsFor(dialect);
  const query = buildCountQuery({ dialect, table: { name: 'items' }, columns, filter });
  const at = query.sql.indexOf(' WHERE ');
  return { sql: at < 0 ? '' : query.sql.slice(at + 7), params: query.params };
}

describe('filter SQL, PostgreSQL', () => {
  const cases: [FilterNode, string, CellValue[]][] = [
    [condition('qty', '=', 5), '"qty" = $1', [5]],
    [condition('qty', '!=', 5), '"qty" <> $1', [5]],
    [condition('name', '=', null), '"name" IS NULL', []],
    [condition('name', '!=', null), '"name" IS NOT NULL', []],
    [condition('price', '>=', '1.50'), '"price" >= $1', ['1.50']],
    [condition('name', 'contains', '50%_off!'), `"name" ILIKE $1 ESCAPE '!'`, ['%50!%!_off!!%']],
    [
      condition('name', 'contains', 'Ab', { caseSensitive: true }),
      `"name" LIKE $1 ESCAPE '!'`,
      ['%Ab%'],
    ],
    [condition('name', 'not-contains', 'x'), `"name" NOT ILIKE $1 ESCAPE '!'`, ['%x%']],
    [condition('name', 'starts-with', 'x'), `"name" ILIKE $1 ESCAPE '!'`, ['x%']],
    [condition('name', 'ends-with', 'x'), `"name" ILIKE $1 ESCAPE '!'`, ['%x']],
    [condition('name', 'like', 'a_b%'), '"name" ILIKE $1', ['a_b%']],
    [condition('name', 'not-like', 'a%', { caseSensitive: true }), '"name" NOT LIKE $1', ['a%']],
    [condition('born', 'starts-with', '2026-09'), `"born"::text ILIKE $1 ESCAPE '!'`, ['2026-09%']],
    [condition('qty', 'in', [1, 2, 3]), '"qty" IN ($1, $2, $3)', [1, 2, 3]],
    [condition('name', 'in', ['a', null]), '("name" IN ($1) OR "name" IS NULL)', ['a']],
    [
      condition('name', 'not-in', ['a', null]),
      '("name" NOT IN ($1) AND "name" IS NOT NULL)',
      ['a'],
    ],
    [condition('qty', 'in', []), 'FALSE', []],
    [condition('qty', 'not-in', []), 'TRUE', []],
    [condition('qty', 'between', [1, 9]), '"qty" BETWEEN $1 AND $2', [1, 9]],
    [condition('name', 'is-null'), '"name" IS NULL', []],
    [condition('name', 'is-not-null'), '"name" IS NOT NULL', []],
    [condition('name', 'is-empty'), `"name" = ''`, []],
    [condition('name', 'is-not-empty'), `"name" <> ''`, []],
    [condition('data', 'is-empty'), 'octet_length("data") = 0', []],
    [condition('tags', 'is-empty'), 'cardinality("tags") = 0', []],
    [condition('active', 'is-true'), '"active" IS TRUE', []],
    [condition('active', 'is-false'), '"active" IS FALSE', []],
    [condition('doc', 'json-contains', '{"a":1}'), '"doc" @> CAST($1 AS jsonb)', ['{"a":1}']],
    [condition('raw', 'json-contains', '[1]'), '"raw"::jsonb @> CAST($1 AS jsonb)', ['[1]']],
    [condition('raw', '=', '{"a": 1}'), '"raw"::text = $1', ['{"a": 1}']],
    [condition('tags', 'contains', 'x'), `"tags"::text ILIKE $1 ESCAPE '!'`, ['%x%']],
  ];
  for (const [filter, sql, params] of cases) {
    it(sql, () => expect(where('postgres', filter)).toEqual({ sql, params }));
  }
});

describe('filter SQL, MySQL and MariaDB', () => {
  const cases: [FilterNode, string, CellValue[]][] = [
    [condition('qty', '=', 5), '`qty` = ?', [5]],
    [condition('id', '=', 9007199254740993n), '`id` = CAST(? AS UNSIGNED)', [9007199254740993n]],
    [condition('id', '<', -9007199254740993n), '`id` < CAST(? AS SIGNED)', [-9007199254740993n]],
    [condition('price', '=', '1.50'), '`price` = CAST(? AS DECIMAL(10,2))', ['1.50']],
    [condition('ratio', '>', 0.1), '`ratio` > CAST(? AS FLOAT)', [0.1]],
    [condition('name', 'contains', 'Ab'), "`name` LIKE ? ESCAPE '!'", ['%Ab%']],
    [
      condition('name', 'contains', 'Ab', { caseSensitive: true }),
      "`name` COLLATE utf8mb4_bin LIKE ? ESCAPE '!'",
      ['%Ab%'],
    ],
    [
      condition('born', 'starts-with', '2026'),
      "CONVERT(`born` USING utf8mb4) COLLATE utf8mb4_general_ci LIKE ? ESCAPE '!'",
      ['2026%'],
    ],
    [condition('name', 'like', 'a\\_%'), '`name` LIKE ?', ['a\\_%']],
    [
      condition('price', 'between', ['1', '2.5']),
      '`price` BETWEEN CAST(? AS DECIMAL(10,2)) AND CAST(? AS DECIMAL(10,2))',
      ['1', '2.5'],
    ],
    [condition('feeling', 'in', ['ok', 'sad']), '`feeling` IN (?, ?)', ['ok', 'sad']],
    [condition('name', 'is-empty'), 'LENGTH(`name`) = 0', []],
    [condition('data', 'is-not-empty'), 'LENGTH(`data`) > 0', []],
    [condition('active', 'is-true'), '`active` IS TRUE', []],
    [condition('doc', 'json-contains', '{"a":1}'), 'JSON_CONTAINS(`doc`, ?)', ['{"a":1}']],
    [condition('doc', '=', '{"a": 1}'), '`doc` = CAST(? AS JSON)', ['{"a": 1}']],
  ];
  for (const [filter, sql, params] of cases) {
    it(sql, () => {
      expect(where('mysql', filter)).toEqual({ sql, params });
      expect(where('mariadb', filter).params).toEqual(params);
    });
  }

  it('compares MariaDB JSON as text', () => {
    expect(where('mariadb', condition('doc', '=', '{}'))).toEqual({
      sql: '`doc` = ?',
      params: ['{}'],
    });
  });

  it('uses a case-insensitive collation when the column has none', () => {
    const { columns } = itemsFor('mysql');
    const binary = columns.map((c) => (c.name === 'name' ? { ...c, collation: 'utf8mb4_bin' } : c));
    const query = buildCountQuery({
      dialect: 'mysql',
      table: { name: 'items' },
      columns: binary,
      filter: condition('name', 'contains', 'x'),
    });
    expect(query.sql).toContain(
      "CONVERT(`name` USING utf8mb4) COLLATE utf8mb4_general_ci LIKE ? ESCAPE '!'",
    );
  });
});

describe('filter groups', () => {
  it('nests AND/OR groups in parentheses and skips disabled nodes', () => {
    const filter = or(
      and(condition('qty', '>', 1), condition('qty', '<', 9)),
      condition('name', '=', 'x'),
      { ...condition('name', '=', 'ignored'), disabled: true },
      and(),
      and(condition('price', 'is-null')),
    );
    expect(where('postgres', filter)).toEqual({
      sql: '(("qty" > $1 AND "qty" < $2) OR "name" = $3 OR "price" IS NULL)',
      params: [1, 9, 'x'],
    });
  });

  it('leaves out an empty or fully disabled filter', () => {
    expect(where('postgres', and())).toEqual({ sql: '', params: [] });
    expect(where('postgres', { ...condition('qty', '=', 1), disabled: true })).toEqual({
      sql: '',
      params: [],
    });
  });

  it('reports every problem with its path', () => {
    const { columns } = itemsFor('postgres');
    const issues = validateFilter(
      and(
        condition('nope', '=', 1),
        or(condition('qty', 'contains', 'x'), condition('qty', '<', null)),
        condition('doc', 'json-contains', '{bad'),
        condition('qty', 'between', [1]),
        condition('qty', '='),
      ),
      columns,
      'postgres',
    );
    expect(issues.map((i) => [i.path, i.message])).toEqual([
      [[0], 'Unknown column nope'],
      [[1, 0], '"contains" does not apply to integer column qty'],
      [[1, 1], 'qty < NULL never matches; use "is null"'],
      [[2], 'doc JSON contains needs a JSON value like {"key": 1}'],
      [[3], 'qty between needs two values'],
      [[4], 'qty = needs a value'],
    ]);
    expect(() =>
      buildCountQuery({
        dialect: 'postgres',
        table: { name: 'items' },
        columns,
        filter: condition('nope', '=', 1),
      }),
    ).toThrow(/Invalid filter: Unknown column nope/);
  });

  it('offers operators per column kind', () => {
    const { columns } = itemsFor('postgres');
    const col = (name: string) => columns.find((c) => c.name === name)!;
    expect(operatorsFor(col('active'), 'postgres')).toEqual([
      'is-true',
      'is-false',
      '=',
      '!=',
      'is-null',
      'is-not-null',
    ]);
    expect(operatorsFor(col('qty'), 'postgres')).toEqual([
      '=',
      '!=',
      '<',
      '<=',
      '>',
      '>=',
      'between',
      'in',
      'not-in',
    ]);
    expect(operatorsFor(col('doc'), 'postgres')).toContain('json-contains');
    expect(operatorsFor(col('name'), 'postgres')).toContain('is-empty');
  });
});
