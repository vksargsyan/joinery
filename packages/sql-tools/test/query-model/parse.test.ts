import type { SqlDialect } from '@querybara/core';
import { describe, expect, it } from 'vitest';

import { generateQuery, parseQuery, type QueryModel, type QueryParseOptions } from '../../src';
import { shape } from './helpers';

/** parseQuery (spec §8, ADR 0014): the SELECT subset the builder shows, and what it refuses. */

const DIALECTS: SqlDialect[] = ['postgres', 'mysql', 'mariadb'];

function parsed(
  sql: string,
  dialect: SqlDialect = 'postgres',
  options?: QueryParseOptions,
): QueryModel {
  const result = parseQuery(sql, dialect, options);
  if (result.status !== 'ok') throw new Error(`${result.status}: ${result.message}`);
  return result.model;
}

/** SQL → model → SQL. */
function again(sql: string, dialect: SqlDialect = 'postgres', options?: QueryParseOptions): string {
  return generateQuery(parsed(sql, dialect, options), dialect).sql;
}

describe('parseQuery', () => {
  it('reads tables, joins, columns, criteria, grouping, sort and paging', () => {
    const m = parsed(
      `select distinct c.name as customer, count(*) n
         from public.customers c
         left outer join orders as o on o.customer_id = c.id and c.region = o.region
        where o.total > 10.5 and (c.name like 'A%' or c.name is null)
        group by c.name
       having count(*) >= 2
        order by n desc nulls last, customer
        limit 5 offset 10`,
    );
    expect(shape(m)).toEqual({
      distinct: true,
      tables: [
        { name: 'customers', schema: 'public', alias: 'c' },
        { name: 'orders', alias: 'o' },
      ],
      joins: [
        {
          type: 'left',
          left: 't1',
          right: 't2',
          conditions: [
            { left: 'id', operator: '=', right: 'customer_id' },
            { left: 'region', operator: '=', right: 'region' },
          ],
        },
      ],
      columns: [
        { kind: 'expr', expr: { kind: 'column', table: 't1', column: 'name' }, alias: 'customer' },
        { kind: 'expr', expr: { kind: 'aggregate', fn: 'count' }, alias: 'n' },
      ],
      where: {
        kind: 'group',
        op: 'and',
        items: [
          {
            kind: 'condition',
            left: { kind: 'column', table: 't2', column: 'total' },
            operator: '>',
            values: [{ kind: 'number', value: '10.5' }],
          },
          {
            kind: 'group',
            op: 'or',
            items: [
              {
                kind: 'condition',
                left: { kind: 'column', table: 't1', column: 'name' },
                operator: 'like',
                values: [{ kind: 'string', value: 'A%' }],
              },
              {
                kind: 'condition',
                left: { kind: 'column', table: 't1', column: 'name' },
                operator: 'is null',
                values: [],
              },
            ],
          },
        ],
      },
      groupBy: [{ expr: { kind: 'column', table: 't1', column: 'name' } }],
      having: {
        kind: 'group',
        op: 'and',
        items: [
          {
            kind: 'condition',
            left: { kind: 'aggregate', fn: 'count' },
            operator: '>=',
            values: [{ kind: 'number', value: '2' }],
          },
        ],
      },
      orderBy: [
        { expr: { kind: 'column', column: 'n' }, direction: 'desc', nulls: 'last' },
        { expr: { kind: 'column', column: 'customer' }, direction: 'asc' },
      ],
      limit: 5,
      offset: 10,
    });
    expect(m.where.id).toBe('where');
    expect(m.having.id).toBe('having');
  });

  it('names what it cannot show', () => {
    const cases: [string, string, SqlDialect?][] = [
      ['WITH t AS (SELECT 1) SELECT * FROM t', 'a WITH clause (common table expression)'],
      ['SELECT a FROM t UNION SELECT a FROM u', 'a UNION'],
      ['SELECT a FROM t INTERSECT SELECT a FROM u', 'an INTERSECT'],
      ['SELECT a FROM t EXCEPT SELECT a FROM u', 'an EXCEPT'],
      ['SELECT (SELECT max(x) FROM u) FROM t', 'a subquery'],
      ['SELECT * FROM t WHERE id IN (SELECT id FROM u)', 'a subquery'],
      ['SELECT * FROM t WHERE EXISTS (SELECT 1)', 'a subquery'],
      ['SELECT * FROM (SELECT 1) s', 'a subquery'],
      ['SELECT rank() OVER (ORDER BY x) FROM t', 'a window function (OVER)'],
      ['SELECT sum(x) OVER w FROM t WINDOW w AS ()', 'a window function (OVER)'],
      ['SELECT DISTINCT ON (a) a FROM t', 'DISTINCT ON'],
      ['SELECT * FROM t FOR UPDATE', 'a locking clause (FOR UPDATE / FOR SHARE)'],
      ['SELECT * FROM t LOCK IN SHARE MODE', 'LOCK IN SHARE MODE', 'mysql'],
      ['SELECT a INTO x FROM t', 'SELECT … INTO'],
      ['SELECT a FROM t GROUP BY ROLLUP (a)', 'ROLLUP'],
      ['SELECT a FROM t GROUP BY a WITH ROLLUP', 'WITH ROLLUP', 'mysql'],
      ['SELECT a FROM t GROUP BY GROUPING SETS ((a))', 'GROUPING SETS'],
      ['SELECT * FROM t JOIN u USING (id)', 'JOIN … USING'],
      ['SELECT * FROM t NATURAL JOIN u', 'NATURAL JOIN'],
      ['SELECT * FROM t, LATERAL f(t.x)', 'LATERAL'],
      ['SELECT * FROM generate_series(1, 3)', 'a function in FROM'],
      ['SELECT * FROM (t JOIN u ON t.a = u.a)', 'a parenthesised join or subquery in FROM'],
      ['SELECT * FROM t AS x (a, b)', 'a column alias list'],
      ['SELECT * FROM db.s.t', 'a three-part table name'],
      ['SELECT * FROM ONLY t', 'ONLY'],
      ['SELECT * FROM t TABLESAMPLE SYSTEM (10)', 'TABLESAMPLE'],
      ['SELECT * FROM t USE INDEX (i)', 'an index hint', 'mysql'],
      ['SELECT * FROM t PARTITION (p0)', 'PARTITION', 'mysql'],
      ['SELECT * FROM t FETCH FIRST 3 ROWS ONLY', 'FETCH FIRST'],
      ['SELECT SQL_CALC_FOUND_ROWS * FROM t', 'SQL_CALC_FOUND_ROWS', 'mysql'],
      ['SELECT * FROM t LIMIT $1', 'a LIMIT that is not a number'],
      [
        'SELECT * FROM t JOIN u ON t.a = u.a OR t.b = u.b',
        'a join condition other than column comparisons joined by AND',
      ],
      [
        'SELECT * FROM t JOIN u ON t.a = 1',
        'a join condition other than column comparisons joined by AND',
      ],
      [
        'SELECT * FROM t JOIN u ON t.a = t.b',
        'a join condition that does not compare "u" with an earlier table',
      ],
      ['SELECT * FROM t FULL JOIN u ON t.a = u.a', 'FULL JOIN (MySQL has no FULL JOIN)', 'mysql'],
      [
        'SELECT * FROM t FULL OUTER JOIN u ON t.a = u.a',
        'FULL JOIN (MariaDB has no FULL JOIN)',
        'mariadb',
      ],
      ['SELECT 1; SELECT 2', 'more than one statement'],
      ['INSERT INTO t VALUES (1)', 'an INSERT statement'],
      ['UPDATE t SET a = 1', 'an UPDATE statement'],
      ['(SELECT 1)', 'a query in parentheses'],
      ['SELECT /*!40001 SQL_NO_CACHE */ * FROM t', 'an executable comment (/*! … */)', 'mysql'],
    ];
    for (const [sql, construct, dialect] of cases) {
      const result = parseQuery(sql, dialect ?? 'postgres');
      expect({ sql, result: result.status }).toEqual({ sql, result: 'unsupported' });
      if (result.status === 'unsupported') {
        expect({ sql, construct: result.construct }).toEqual({ sql, construct });
        expect(result.message).toBe(`The query builder cannot show ${construct}.`);
      }
    }
  });

  it('points at the construct it cannot show', () => {
    const sql = 'SELECT a\nFROM t\nWHERE a IN (SELECT b FROM u)';
    const result = parseQuery(sql, 'postgres');
    expect(result.status).toBe('unsupported');
    if (result.status === 'unsupported') {
      expect(sql.slice(result.start, result.end)).toBe('SELECT');
      expect(result.start).toBe(sql.lastIndexOf('SELECT'));
    }
  });

  it('calls unfinished or broken SQL invalid', () => {
    const cases = [
      '',
      '-- nothing',
      'SELECT',
      'SELECT a FROM',
      'SELECT a FROM t WHERE',
      'SELECT a FROM t WHERE a =',
      "SELECT a FROM t WHERE b = 'open",
      'SELECT a FROM t WHERE a AND',
      'SELECT a FROM t ORDER BY',
      'SELECT a FROM t JOIN u',
      'SELECT a FROM t LEFT JOIN u',
      'SELECT a FROM t CROSS JOIN u ON t.a = u.a',
      'SELECT a FROM t WHERE a = 1 WHERE b = 2',
      'SELECT a FROM t ORDER BY a WHERE b = 2',
      'SELECT a FROM t LIMIT x',
      'SELECT a FROM t, t',
      'SELECT a, FROM t',
      'SELECT a FROM t x y',
      'SELECT a FROM t WHERE a BETWEEN 1',
      'SELECT a FROM t WHERE a IN ()',
    ];
    for (const sql of cases) {
      expect({ sql, status: parseQuery(sql, 'postgres').status }).toEqual({
        sql,
        status: 'invalid',
      });
    }
  });

  it('folds unquoted PostgreSQL names and keeps quoted ones exactly', () => {
    const m = parsed('SELECT Name, "Mixed""Case" FROM Public.Users U');
    expect(shape(m.tables)).toEqual([{ name: 'users', schema: 'public', alias: 'u' }]);
    expect(shape(m.columns)).toEqual([
      { kind: 'expr', expr: { kind: 'column', table: 't1', column: 'name' } },
      { kind: 'expr', expr: { kind: 'column', table: 't1', column: 'Mixed"Case' } },
    ]);
    const my = parsed('SELECT Name, `a``b` FROM Shop.Users U', 'mysql');
    expect(shape(my.tables)).toEqual([{ name: 'Users', schema: 'Shop', alias: 'U' }]);
    expect(shape(my.columns)).toEqual([
      { kind: 'expr', expr: { kind: 'column', table: 't1', column: 'Name' } },
      { kind: 'expr', expr: { kind: 'column', table: 't1', column: 'a`b' } },
    ]);
  });

  it('decodes string literals per dialect', () => {
    const value = (sql: string, dialect: SqlDialect): unknown => {
      const condition = parsed(sql, dialect).where.items[0];
      return condition?.kind === 'condition' ? condition.values[0] : undefined;
    };
    expect(value("SELECT * FROM t WHERE a = 'it''s \\n'", 'postgres')).toEqual({
      kind: 'string',
      value: "it's \\n",
    });
    expect(value("SELECT * FROM t WHERE a = E'tab\\there\\\\'", 'postgres')).toEqual({
      kind: 'string',
      value: 'tab\there\\',
    });
    expect(value("SELECT * FROM t WHERE a = 'it\\'s ''x'' \\n \\% \\\\'", 'mysql')).toEqual({
      kind: 'string',
      value: "it's 'x' \n \\% \\",
    });
    expect(value('SELECT * FROM t WHERE a = "dq ""x"""', 'mariadb')).toEqual({
      kind: 'string',
      value: 'dq "x"',
    });
    expect(value("SELECT * FROM t WHERE a = X'ff'", 'postgres')).toEqual({
      kind: 'raw',
      sql: "X'ff'",
    });
  });

  it('attaches unqualified columns: one table, the metadata, or ORDER BY aliases', () => {
    const sql =
      'SELECT name, total AS amount FROM customers c JOIN orders o ON c.id = o.customer_id ORDER BY amount, total';
    expect(shape(parsed(sql).columns)).toEqual([
      { kind: 'expr', expr: { kind: 'column', column: 'name' } },
      { kind: 'expr', expr: { kind: 'column', column: 'total' }, alias: 'amount' },
    ]);
    const columnsOf: QueryParseOptions['columnsOf'] = (table) =>
      table.name === 'customers' ? ['id', 'name'] : ['id', 'customer_id', 'total'];
    const resolved = parsed(sql, 'postgres', { columnsOf });
    expect(shape(resolved.columns)).toEqual([
      { kind: 'expr', expr: { kind: 'column', table: 't1', column: 'name' } },
      { kind: 'expr', expr: { kind: 'column', table: 't2', column: 'total' }, alias: 'amount' },
    ]);
    expect(shape(resolved.orderBy)).toEqual([
      { expr: { kind: 'column', column: 'amount' }, direction: 'asc' },
      { expr: { kind: 'column', table: 't2', column: 'total' }, direction: 'asc' },
    ]);
    expect(again(sql, 'postgres', { columnsOf })).toBe(
      [
        'SELECT',
        '  "c"."name",',
        '  "o"."total" AS "amount"',
        'FROM "customers" AS "c"',
        '  INNER JOIN "orders" AS "o" ON "c"."id" = "o"."customer_id"',
        'ORDER BY "amount", "o"."total"',
      ].join('\n'),
    );
  });

  it('reads schema-qualified column references of tables without an alias', () => {
    const m = parsed('SELECT public.t.a, t.b, x.c FROM public.t');
    expect(shape(m.columns)).toEqual([
      { kind: 'expr', expr: { kind: 'column', table: 't1', column: 'a' } },
      { kind: 'expr', expr: { kind: 'column', table: 't1', column: 'b' } },
      { kind: 'expr', expr: { kind: 'raw', sql: 'x.c' } },
    ]);
  });

  it('writes join conditions from the earlier table, whichever way they were typed', () => {
    expect(
      again(
        'SELECT * FROM a JOIN b ON b.a_id = a.id AND b.n >= a.m RIGHT JOIN c ON c.b_id = b.id AND a.k = c.k',
      ),
    ).toBe(
      [
        'SELECT *',
        'FROM "a"',
        '  INNER JOIN "b" ON "a"."id" = "b"."a_id" AND "a"."m" <= "b"."n"',
        '  RIGHT JOIN "c" ON "b"."id" = "c"."b_id" AND "a"."k" = "c"."k"',
      ].join('\n'),
    );
    const m = parsed(
      'SELECT * FROM a JOIN b ON b.a_id = a.id RIGHT JOIN c ON c.b_id = b.id AND a.k = c.k',
    );
    expect(shape(m.joins)).toEqual([
      {
        type: 'inner',
        left: 't1',
        right: 't2',
        conditions: [{ left: 'id', operator: '=', right: 'a_id' }],
      },
      {
        type: 'right',
        left: 't2',
        right: 't3',
        conditions: [{ left: 'id', operator: '=', right: 'b_id' }],
      },
      {
        type: 'right',
        left: 't1',
        right: 't3',
        conditions: [{ left: 'k', operator: '=', right: 'k' }],
      },
    ]);
  });

  it('reads comma lists and MySQL joins without ON as cross joins', () => {
    expect(again('SELECT * FROM a, b WHERE a.id = b.id')).toBe(
      'SELECT *\nFROM "a"\n  CROSS JOIN "b"\nWHERE "a"."id" = "b"."id"',
    );
    expect(again('SELECT * FROM a JOIN b', 'mysql')).toBe('SELECT *\nFROM `a`\n  CROSS JOIN `b`');
  });

  it('keeps expressions it cannot break down as written', () => {
    expect(
      again(
        "SELECT lower(name) AS n, price * qty total, CASE WHEN a THEN 1 END, now() FROM t WHERE coalesce(x, 0) + 1 > 2 AND x::text = '1'",
      ),
    ).toBe(
      [
        'SELECT',
        '  lower(name) AS "n",',
        '  price * qty AS "total",',
        '  (CASE WHEN a THEN 1 END),',
        '  now()',
        'FROM "t"',
        'WHERE coalesce(x, 0) + 1 > 2',
        `  AND x::text = '1'`,
      ].join('\n'),
    );
  });

  it('keeps conditions it cannot show as rows as SQL', () => {
    const m = parsed(
      "SELECT * FROM t WHERE active AND a IS DISTINCT FROM b AND c = ANY (d) AND e LIKE 'x!%' ESCAPE '!' AND f IS TRUE AND g BETWEEN SYMMETRIC 1 AND 2",
    );
    expect(m.where.items.map((item) => (item.kind === 'custom' ? item.sql : item.kind))).toEqual([
      'active',
      'a IS DISTINCT FROM b',
      'c = ANY (d)',
      "e LIKE 'x!%' ESCAPE '!'",
      'f IS TRUE',
      'g BETWEEN SYMMETRIC 1 AND 2',
    ]);
  });

  it('reads operators, negation, precedence and parentheses', () => {
    expect(
      again(
        "SELECT * FROM t WHERE a != 1 OR b NOT LIKE 'x' AND NOT c IN (1, -2) OR (d NOT BETWEEN 1 AND 2 AND e IS NOT NULL) OR NOT (f ILIKE 'y' OR g <= :p)",
      ),
    ).toBe(
      [
        'SELECT *',
        'FROM "t"',
        'WHERE "a" <> 1',
        `  OR ("b" NOT LIKE 'x' AND NOT ("c" IN (1, -2)))`,
        '  OR ("d" NOT BETWEEN 1 AND 2 AND "e" IS NOT NULL)',
        `  OR NOT ("f" ILIKE 'y' OR "g" <= :p)`,
      ].join('\n'),
    );
  });

  it('reads aggregates', () => {
    const m = parsed(
      'SELECT count(*), COUNT(DISTINCT t.a), sum(price * qty), max(x), avg(t.y), count(a, b), string_agg(a, b) FROM t',
    );
    expect(shape(m.columns.map((item) => (item.kind === 'expr' ? item.expr : item)))).toEqual([
      { kind: 'aggregate', fn: 'count' },
      {
        kind: 'aggregate',
        fn: 'count',
        distinct: true,
        arg: { kind: 'column', table: 't1', column: 'a' },
      },
      { kind: 'aggregate', fn: 'sum', arg: { kind: 'raw', sql: 'price * qty' } },
      { kind: 'aggregate', fn: 'max', arg: { kind: 'column', table: 't1', column: 'x' } },
      { kind: 'aggregate', fn: 'avg', arg: { kind: 'column', table: 't1', column: 'y' } },
      { kind: 'raw', sql: 'count(a, b)' },
      { kind: 'raw', sql: 'string_agg(a, b)' },
    ]);
  });

  it('reads paging in every form', () => {
    expect(shape(parsed('SELECT * FROM t OFFSET 5 LIMIT 10'))).toMatchObject({
      limit: 10,
      offset: 5,
    });
    expect(parsed('SELECT * FROM t LIMIT ALL').limit).toBeUndefined();
    expect(parsed('SELECT * FROM t OFFSET 3 ROWS').offset).toBe(3);
    expect(shape(parsed('SELECT * FROM t LIMIT 5, 10', 'mysql'))).toMatchObject({
      limit: 10,
      offset: 5,
    });
    const noLimit = parsed('SELECT * FROM t LIMIT 18446744073709551615 OFFSET 4', 'mariadb');
    expect(noLimit.limit).toBeUndefined();
    expect(noLimit.offset).toBe(4);
    // MySQL's OFFSET is an ordinary name outside LIMIT.
    expect(shape(parsed('SELECT offset FROM t', 'mysql').columns)).toEqual([
      { kind: 'expr', expr: { kind: 'column', table: 't1', column: 'offset' } },
    ]);
  });

  it('keeps keywords and functions without parentheses out of column names', () => {
    const m = parsed('SELECT current_date, NULL, true, user FROM t');
    expect(shape(m.columns.map((item) => (item.kind === 'expr' ? item.expr : item)))).toEqual([
      { kind: 'raw', sql: 'current_date' },
      { kind: 'raw', sql: 'NULL' },
      { kind: 'boolean', value: true },
      { kind: 'raw', sql: 'user' },
    ]);
    // MySQL's USER is an ordinary name.
    const my = parsed('SELECT user FROM t', 'mysql');
    expect(shape(my.columns[0])).toEqual({
      kind: 'expr',
      expr: { kind: 'column', table: 't1', column: 'user' },
    });
  });

  it('ignores comments and a trailing delimiter, and reports offsets in the whole text', () => {
    for (const dialect of DIALECTS) {
      expect(again('-- the lot\nSELECT /* all */ a FROM t -- done\n;', dialect)).toBe(
        dialect === 'postgres' ? 'SELECT "a"\nFROM "t"' : 'SELECT `a`\nFROM `t`',
      );
    }
    const sql = '-- intro\nSELECT a FROM t WHERE';
    const result = parseQuery(sql, 'postgres');
    expect(result.status).toBe('invalid');
    if (result.status === 'invalid') expect(sql.slice(result.start, result.end)).toBe('WHERE');
  });

  it('reads MySQL placeholders and PostgreSQL numbered ones', () => {
    expect(again('SELECT * FROM t WHERE a = ? AND b = :name', 'mysql')).toBe(
      'SELECT *\nFROM `t`\nWHERE `a` = ?\n  AND `b` = :name',
    );
    expect(again('SELECT * FROM t WHERE a = $1', 'postgres')).toBe(
      'SELECT *\nFROM "t"\nWHERE "a" = $1',
    );
  });

  it('refuses a table named twice', () => {
    const result = parseQuery('SELECT * FROM t JOIN u AS t ON t.a = t.b', 'postgres');
    expect(result).toMatchObject({ status: 'invalid', message: 'Two tables are called "t".' });
  });
});
