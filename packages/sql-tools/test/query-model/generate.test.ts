import type { SqlDialect } from '@joinery/core';
import { describe, expect, it } from 'vitest';

import { emptyQueryModel, generateQuery, type QueryModel } from '../../src';
import {
  and,
  bool,
  col,
  cond,
  count,
  custom,
  item,
  join,
  model,
  not,
  num,
  or,
  param,
  raw,
  root,
  star,
  str,
  table,
} from './helpers';

/** generateQuery (spec §8, ADR 0014): formatted SQL, quoting, joins, criteria and issues. */

const sql = (m: QueryModel, dialect: SqlDialect = 'postgres'): string =>
  generateQuery(m, dialect).sql;

const errors = (m: QueryModel, dialect: SqlDialect = 'postgres'): string[] =>
  generateQuery(m, dialect)
    .issues.filter((issue) => issue.severity === 'error')
    .map((issue) => issue.message);

const shop = {
  customers: table('c', 'customers', { schema: 'public', alias: 'c' }),
  orders: table('o', 'orders', { schema: 'public', alias: 'o' }),
  items: table('i', 'items', { schema: 'public' }),
};

describe('generateQuery', () => {
  it('writes SELECT * for an empty model', () => {
    expect(sql(emptyQueryModel())).toBe('SELECT *');
    expect(generateQuery(emptyQueryModel(), 'mysql').issues).toEqual([]);
  });

  it('quotes names per dialect and leaves one table unqualified', () => {
    const m = model({
      distinct: true,
      tables: [table('t', 'Order "Lines"', { schema: 'sales' })],
      columns: [item(col('id', 't')), item(col('total`s', 't'), 'Total')],
    });
    expect(sql(m)).toBe(
      'SELECT DISTINCT\n  "id",\n  "total`s" AS "Total"\nFROM "sales"."Order ""Lines"""',
    );
    expect(sql(m, 'mysql')).toBe(
      'SELECT DISTINCT\n  `id`,\n  `total``s` AS `Total`\nFROM `sales`.`Order "Lines"`',
    );
    expect(sql(m, 'mariadb')).toBe(sql(m, 'mysql'));
  });

  it('joins tables in model order, the earlier table first in every condition', () => {
    const m = model({
      tables: [shop.customers, shop.orders, shop.items],
      joins: [
        join('o', 'c', [['customer_id', 'id']]),
        join('o', 'i', [
          ['id', 'order_id'],
          ['region', 'region'],
        ]),
      ],
      columns: [item(col('name', 'c')), star('o'), item(count(), 'lines')],
    });
    expect(sql(m)).toBe(
      [
        'SELECT',
        '  "c"."name",',
        '  "o".*,',
        '  COUNT(*) AS "lines"',
        'FROM "public"."customers" AS "c"',
        '  INNER JOIN "public"."orders" AS "o" ON "c"."id" = "o"."customer_id"',
        '  INNER JOIN "public"."items" ON "o"."id" = "items"."order_id" AND "o"."region" = "items"."region"',
      ].join('\n'),
    );
  });

  it('turns a LEFT join round when its right table comes first, and flips operators', () => {
    const m = model({
      tables: [shop.orders, shop.customers],
      joins: [
        {
          id: 'j',
          type: 'left',
          left: 'c',
          right: 'o',
          conditions: [
            { left: 'id', operator: '=', right: 'customer_id' },
            { left: 'since', operator: '<', right: 'placed_at' },
          ],
        },
      ],
    });
    expect(sql(m)).toContain(
      'RIGHT JOIN "public"."customers" AS "c" ON "o"."customer_id" = "c"."id" AND "o"."placed_at" > "c"."since"',
    );
  });

  it('cross joins a table without a join to the ones before it', () => {
    const m = model({
      tables: [shop.customers, shop.items, shop.orders],
      joins: [join('c', 'o', [['id', 'customer_id']], 'left')],
    });
    expect(sql(m)).toBe(
      [
        'SELECT *',
        'FROM "public"."customers" AS "c"',
        '  LEFT JOIN "public"."orders" AS "o" ON "c"."id" = "o"."customer_id"',
        '  CROSS JOIN "public"."items"',
      ].join('\n'),
    );
  });

  it('flags FULL JOIN on MySQL and MariaDB but not on PostgreSQL', () => {
    const m = model({
      tables: [shop.customers, shop.orders],
      joins: [join('c', 'o', [['id', 'customer_id']], 'full')],
    });
    expect(sql(m)).toContain('FULL JOIN');
    expect(errors(m)).toEqual([]);
    expect(errors(m, 'mysql')).toEqual(['MySQL has no FULL JOIN.']);
    expect(errors(m, 'mariadb')).toEqual(['MariaDB has no FULL JOIN.']);
  });

  it('reports joins it cannot write and joins of different types reaching one table', () => {
    const m = model({
      tables: [shop.customers, shop.orders, shop.items],
      joins: [
        join('c', 'o', [['id', 'customer_id']], 'left'),
        join('c', 'gone', [['id', 'x']]),
        join('c', 'c', [['id', 'id']]),
        { id: 'empty', type: 'inner', left: 'o', right: 'i', conditions: [] },
        join('i', 'o', [['order_id', 'id']], 'inner'),
        join('c', 'i', [['id', 'customer_id']], 'left'),
      ],
    });
    const result = generateQuery(m, 'postgres');
    expect(result.issues.map((issue) => issue.message)).toEqual([
      'A join refers to a table that is not in the query.',
      'A join must connect two different tables.',
      'A join needs a column on each side of every condition.',
      'The joins that reach "items" have different types; the first one is used.',
    ]);
    expect(result.sql).toContain(
      'INNER JOIN "public"."items" ON "o"."id" = "items"."order_id" AND "c"."id" = "items"."customer_id"',
    );
  });

  it('writes every operator with its values', () => {
    const t = [table('t', 't')];
    const where = root(
      cond(col('a', 't'), '=', num('1')),
      cond(col('a', 't'), '<>', num('-2.5')),
      cond(col('a', 't'), '<=', num('1e3')),
      cond(col('b', 't'), 'like', str('A%')),
      cond(col('b', 't'), 'not ilike', str('%z')),
      cond(col('c', 't'), 'in', num('1'), num('2'), num('3')),
      cond(col('c', 't'), 'not between', num('1'), num('9')),
      cond(col('d', 't'), 'is null'),
      cond(col('d', 't'), 'is not null'),
      cond(col('e', 't'), '=', bool(true)),
      cond(col('f', 't'), '>', param(':since')),
    );
    expect(sql(model({ tables: t, where }))).toBe(
      [
        'SELECT *',
        'FROM "t"',
        'WHERE "a" = 1',
        '  AND "a" <> -2.5',
        '  AND "a" <= 1e3',
        `  AND "b" LIKE 'A%'`,
        `  AND "b" NOT ILIKE '%z'`,
        '  AND "c" IN (1, 2, 3)',
        '  AND "c" NOT BETWEEN 1 AND 9',
        '  AND "d" IS NULL',
        '  AND "d" IS NOT NULL',
        '  AND "e" = TRUE',
        '  AND "f" > :since',
      ].join('\n'),
    );
  });

  it('nests groups in parentheses, negates with NOT and drops empty groups', () => {
    const where = {
      ...root(
        cond(col('a'), '=', num('1')),
        or(cond(col('b'), '=', num('2')), and(cond(col('c'), '=', num('3')), custom('ok()'))),
        not(and(cond(col('d'), '=', num('4')))),
        and(),
        or(cond(col('e'), '=', num('5'))),
      ),
      op: 'or' as const,
    };
    expect(sql(model({ where }))).toBe(
      [
        'SELECT *',
        'WHERE "a" = 1',
        '  OR ("b" = 2 OR ("c" = 3 AND ok()))',
        '  OR NOT ("d" = 4)',
        '  OR "e" = 5',
      ].join('\n'),
    );
    expect(sql(model({ where: not(root(custom('x'), custom('y'))) }))).toBe(
      'SELECT *\nWHERE NOT (x AND y)',
    );
  });

  it('wraps written conditions and expressions in parentheses when they need them', () => {
    const where = root(
      custom('a = 1 OR b = 2'),
      custom('x IS DISTINCT FROM y'),
      cond(raw('price * qty'), '>', num('100')),
      cond(raw('CASE WHEN a THEN 1 END'), '=', num('1')),
      cond(raw('a = b'), '=', bool(false)),
    );
    expect(sql(model({ where }))).toBe(
      [
        'SELECT *',
        'WHERE (a = 1 OR b = 2)',
        '  AND x IS DISTINCT FROM y',
        '  AND price * qty > 100',
        '  AND (CASE WHEN a THEN 1 END) = 1',
        '  AND (a = b) = FALSE',
      ].join('\n'),
    );
  });

  it('quotes string values with the dialect rules', () => {
    const where = root(cond(col('s'), '=', str("it's\\ok\n")));
    expect(sql(model({ where }))).toBe(`SELECT *\nWHERE "s" = 'it''s\\ok\n'`);
    expect(sql(model({ where }), 'mysql')).toBe("SELECT *\nWHERE `s` = 'it''s\\\\ok\\n'");
  });

  it('never writes a value that is not what it claims to be', () => {
    const where = root(
      cond(col('a'), '=', num('1; DROP TABLE t')),
      cond(col('b'), '=', param('$1; DROP')),
      cond(col('c'), '=', param('?')),
      cond(col('d'), '=', str('nul\0')),
    );
    const result = generateQuery(model({ where }), 'postgres');
    expect(result.sql).toBe(
      [
        'SELECT *',
        `WHERE "a" = '1; DROP TABLE t'`,
        `  AND "b" = '$1; DROP'`,
        `  AND "c" = '?'`,
        `  AND "d" = ''`,
      ].join('\n'),
    );
    expect(result.issues.map((issue) => issue.message)).toEqual([
      '"1; DROP TABLE t" is not a number.',
      '"$1; DROP" is not a parameter placeholder.',
      '"?" is not a parameter placeholder.',
      'PostgreSQL text cannot contain NUL bytes',
    ]);
    expect(sql(model({ where: root(cond(col('c'), '=', param('?'))) }), 'mysql')).toBe(
      'SELECT *\nWHERE `c` = ?',
    );
  });

  it('flags hand-written SQL that is not one expression', () => {
    const m = model({
      columns: [
        item(raw('1; DROP TABLE t')),
        item(raw('a -- comment')),
        item(raw('(SELECT 1)')),
        item(raw('lower(')),
        item(raw('a, b')),
        item(raw('sum(x) OVER ()')),
      ],
    });
    expect(errors(m)).toEqual([
      '"1; DROP TABLE t": It must be one expression, without a statement delimiter.',
      '"a -- comment": Comments cannot go into builder expressions.',
      '"(SELECT 1)": The builder cannot hold a subquery; edit the SQL instead.',
      '"lower(": A parenthesis is not closed.',
      '"a, b": It has a comma outside parentheses: write one expression.',
      '"sum(x) OVER ()": The builder cannot hold a window function (OVER); edit the SQL instead.',
    ]);
  });

  it('leaves out incomplete conditions with an error', () => {
    const where = root(
      cond(col('a'), '='),
      cond(col('b'), 'between', num('1')),
      cond(col('c'), 'in'),
      custom('  '),
      cond(col('d'), '>', num('0')),
    );
    const result = generateQuery(model({ where }), 'postgres');
    expect(result.sql).toBe('SELECT *\nWHERE "d" > 0');
    expect(result.issues.map((issue) => issue.message)).toEqual([
      '= needs a value; the condition is left out.',
      'BETWEEN needs two values; the condition is left out.',
      'IN needs at least one value; the condition is left out.',
      'A condition written as SQL is empty; it is left out.',
    ]);
  });

  it('writes aggregates, GROUP BY, HAVING and ORDER BY', () => {
    const m = model({
      tables: [shop.orders],
      columns: [
        item(col('status', 'o')),
        item(count(col('customer_id', 'o'), true), 'buyers'),
        item({ kind: 'aggregate', fn: 'sum', arg: raw('price * qty') }, 'revenue'),
      ],
      groupBy: [{ id: 'g', expr: col('status', 'o') }],
      having: root(cond(count(), '>', num('10'))),
      orderBy: [
        { id: 'o1', expr: col('revenue'), direction: 'desc', nulls: 'last' },
        { id: 'o2', expr: col('status', 'o'), direction: 'asc' },
      ],
      limit: 20,
      offset: 40,
    });
    expect(sql(m)).toBe(
      [
        'SELECT',
        '  "status",',
        '  COUNT(DISTINCT "customer_id") AS "buyers",',
        '  SUM(price * qty) AS "revenue"',
        'FROM "public"."orders" AS "o"',
        'GROUP BY "status"',
        'HAVING COUNT(*) > 10',
        'ORDER BY "revenue" DESC NULLS LAST, "status"',
        'LIMIT 20 OFFSET 40',
      ].join('\n'),
    );
    expect(errors(m, 'mysql')).toEqual(['MySQL has no NULLS FIRST / LAST.']);
  });

  it('pages per dialect, with the MySQL idiom for an OFFSET alone', () => {
    expect(sql(model({ offset: 5 }))).toBe('SELECT *\nOFFSET 5');
    expect(sql(model({ offset: 5 }), 'mysql')).toBe(
      'SELECT *\nLIMIT 18446744073709551615 OFFSET 5',
    );
    expect(sql(model({ limit: 0 }), 'mariadb')).toBe('SELECT *\nLIMIT 0');
    expect(errors(model({ limit: -1, offset: 1.5 }))).toEqual([
      'LIMIT must be a whole number of 0 or more.',
      'OFFSET must be a whole number of 0 or more.',
    ]);
  });

  it('reports tables that clash, unknown tables and dialect-only operators', () => {
    const m = model({
      tables: [table('a', 'Users'), table('b', 'users')],
      columns: [item(col('x', 'nope')), star('nope')],
      where: root(cond(col('name', 'a'), 'ilike', str('a%'))),
    });
    expect(errors(m)).toEqual([
      '"x" refers to a table that is not in the query.',
      'A column refers to a table that is not in the query.',
    ]);
    expect(errors(m, 'mysql')).toEqual([
      'Two tables are called "users": give one of them an alias.',
      '"x" refers to a table that is not in the query.',
      'A column refers to a table that is not in the query.',
      'MySQL has no ILIKE.',
    ]);
  });

  it('flags aggregates without a column', () => {
    const m = model({
      columns: [item({ kind: 'aggregate', fn: 'sum' }), item(count(undefined, true))],
    });
    expect(errors(m)).toEqual(['SUM needs a column.', 'COUNT needs a column.']);
  });
});
