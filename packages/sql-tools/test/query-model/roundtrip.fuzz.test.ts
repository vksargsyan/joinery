import type { SqlDialect } from '@querybara/core';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  AGGREGATE_FUNCTIONS,
  COMPARISON_OPERATORS,
  generateQuery,
  operatorsFor,
  parseQuery,
  type Criterion,
  type CriteriaGroup,
  type GroupItem,
  type OrderItem,
  type QueryExpr,
  type QueryJoin,
  type QueryModel,
  type QueryTable,
  type SelectItem,
} from '../../src';

/**
 * Property tests of the query model (spec §8, §20; ADR 0014): for random models in every dialect,
 * generating, parsing the SQL and generating again gives the same SQL, without errors; and
 * parsing never throws on noise.
 */

const DIALECTS: SqlDialect[] = ['postgres', 'mysql', 'mariadb'];

/** Names with quotes, backticks, spaces, dots, keywords and non-ASCII text. */
const name = fc
  .oneof(
    fc.constantFrom(
      'id',
      'name',
      'select',
      'from',
      'Order',
      'a b',
      'x.y',
      'q"t',
      'b`t',
      'é',
      'ÆØÅ',
      '-',
      'user',
      'offset',
    ),
    fc.string({ minLength: 1, maxLength: 8, unit: 'grapheme' }),
  )
  .filter((value) => !value.includes('\0'));

/** Strings of any text, NUL excepted (PostgreSQL text cannot hold it). */
const text = fc
  .oneof(
    fc.constantFrom(
      '',
      "it's",
      '\\',
      '\\%',
      "\\'",
      '\n\r\t',
      '\x1a',
      '--',
      '/*',
      '$$',
      '?',
      ':x',
      '"',
    ),
    fc.string({ maxLength: 12, unit: 'grapheme' }),
  )
  .filter((value) => !value.includes('\0'));

const numberText = fc.oneof(
  fc.integer({ min: -1_000_000, max: 1_000_000 }).map(String),
  fc.constantFrom('0.5', '-1.25', '1e3', '2.5E-4', '.5', '10.'),
);

/** Hand-written expressions that stay hand-written when parsed back. */
const RAW = [
  "lower('x')",
  '1 + 2',
  'COALESCE(1, 2)',
  '(1 + 2) * 3',
  "CASE WHEN 1 = 1 THEN 'a' ELSE 'b' END",
  'abs(-3)',
];

/** Hand-written conditions that stay hand-written. */
const CUSTOM = [
  'is_valid(1)',
  "starts_with('a', 'b')",
  'f(1) IS DISTINCT FROM f(2)',
  "g('x') OR h(1)",
];

interface Tables {
  readonly tables: readonly QueryTable[];
}

function parameter(dialect: SqlDialect): fc.Arbitrary<QueryExpr> {
  const texts = dialect === 'postgres' ? ['$1', '$2', ':name'] : ['?', '$1', ':name'];
  return fc.constantFrom(...texts).map((value) => ({ kind: 'parameter', text: value }));
}

function column({ tables }: Tables): fc.Arbitrary<QueryExpr> {
  const table =
    tables.length === 0
      ? fc.constant(undefined)
      : fc.option(fc.constantFrom(...tables.map((t) => t.id)), { nil: undefined });
  return fc.record({ table, column: name }).map(({ table: id, column: col }) => ({
    kind: 'column',
    column: col,
    ...(id === undefined ? {} : { table: id }),
  }));
}

function value(dialect: SqlDialect): fc.Arbitrary<QueryExpr> {
  return fc.oneof(
    text.map((v): QueryExpr => ({ kind: 'string', value: v })),
    numberText.map((v): QueryExpr => ({ kind: 'number', value: v })),
    fc.boolean().map((v): QueryExpr => ({ kind: 'boolean', value: v })),
    parameter(dialect),
    fc.constantFrom(...RAW).map((sql): QueryExpr => ({ kind: 'raw', sql })),
  );
}

function expression(dialect: SqlDialect, scope: Tables): fc.Arbitrary<QueryExpr> {
  const aggregate = fc
    .record({
      fn: fc.constantFrom(...AGGREGATE_FUNCTIONS),
      distinct: fc.boolean(),
      arg: fc.oneof(
        column(scope),
        fc.constantFrom(...RAW).map((sql): QueryExpr => ({ kind: 'raw', sql })),
      ),
      star: fc.boolean(),
    })
    .map(({ fn, distinct, arg, star }): QueryExpr =>
      fn === 'count' && star
        ? { kind: 'aggregate', fn }
        : { kind: 'aggregate', fn, arg, ...(distinct ? { distinct } : {}) },
    );
  return fc.oneof({ weight: 3, arbitrary: column(scope) }, aggregate, value(dialect));
}

function criterion(dialect: SqlDialect, scope: Tables, depth: number): fc.Arbitrary<Criterion> {
  const expr = expression(dialect, scope);
  const condition = fc
    .record({
      left: expr,
      info: fc.constantFrom(...operatorsFor(dialect)),
      values: fc.array(expr, { minLength: 1, maxLength: 3 }),
    })
    .map(({ left, info, values }): Criterion => {
      const count = info.arity === 'list' ? values.length : info.arity;
      const padded = [...values, ...values, ...values].slice(0, count);
      return { kind: 'condition', id: 'c', left, operator: info.operator, values: padded };
    });
  const custom = fc
    .constantFrom(...CUSTOM)
    .map((sql): Criterion => ({ kind: 'custom', id: 'x', sql }));
  if (depth <= 0) return fc.oneof({ weight: 4, arbitrary: condition }, custom);
  return fc.oneof(
    { weight: 4, arbitrary: condition },
    { weight: 1, arbitrary: custom },
    { weight: 2, arbitrary: group(dialect, scope, depth - 1) },
  );
}

function group(dialect: SqlDialect, scope: Tables, depth: number): fc.Arbitrary<CriteriaGroup> {
  return fc
    .record({
      op: fc.constantFrom('and' as const, 'or' as const),
      negated: fc.boolean(),
      items: fc.array(criterion(dialect, scope, depth), { maxLength: 3 }),
    })
    .map(({ op, negated, items }) => ({
      kind: 'group',
      id: 'g',
      op,
      items,
      ...(negated ? { negated } : {}),
    }));
}

function tables(): fc.Arbitrary<QueryTable[]> {
  return fc
    .uniqueArray(
      fc.record({
        name,
        schema: fc.option(name, { nil: undefined }),
        alias: fc.option(name, { nil: undefined }),
      }),
      {
        maxLength: 4,
        selector: (t) => (t.alias ?? t.name).toLowerCase(),
      },
    )
    .map((list) =>
      list.map((t, index) => ({
        id: `t${index}`,
        name: t.name,
        ...(t.schema === undefined ? {} : { schema: t.schema }),
        ...(t.alias === undefined ? {} : { alias: t.alias }),
      })),
    );
}

function joins(dialect: SqlDialect, list: readonly QueryTable[]): fc.Arbitrary<QueryJoin[]> {
  if (list.length < 2) return fc.constant([]);
  const ids = list.map((t) => t.id);
  const types =
    dialect === 'postgres'
      ? (['inner', 'left', 'right', 'full'] as const)
      : (['inner', 'left', 'right'] as const);
  return fc
    .uniqueArray(
      fc.record({
        pair: fc
          .tuple(fc.constantFrom(...ids), fc.constantFrom(...ids))
          .filter(([a, b]) => a !== b),
        type: fc.constantFrom(...types),
        conditions: fc.array(
          fc.record({
            left: name,
            operator: fc.constantFrom(...COMPARISON_OPERATORS),
            right: name,
          }),
          { minLength: 1, maxLength: 3 },
        ),
      }),
      { maxLength: 4, selector: ({ pair }) => [...pair].sort().join('\u0000') },
    )
    .map((list2) =>
      list2.map(({ pair, type, conditions }, index) => ({
        id: `j${index}`,
        type,
        left: pair[0],
        right: pair[1],
        conditions,
      })),
    );
}

function queryModel(dialect: SqlDialect): fc.Arbitrary<QueryModel> {
  return tables().chain((list) => {
    const scope: Tables = { tables: list };
    const expr = expression(dialect, scope);
    const selectItem: fc.Arbitrary<SelectItem> = fc.oneof(
      {
        weight: 1,
        arbitrary: fc
          .option(fc.constantFrom(...(list.length > 0 ? list.map((t) => t.id) : ['none'])), {
            nil: undefined,
          })
          .filter((id) => id !== 'none')
          .map((id): SelectItem => ({
            kind: 'star',
            id: 's',
            ...(id === undefined ? {} : { table: id }),
          })),
      },
      {
        weight: 4,
        arbitrary: fc
          .record({ expr, alias: fc.option(name, { nil: undefined }) })
          .map(({ expr: e, alias }): SelectItem => ({
            kind: 'expr',
            id: 's',
            expr: e,
            ...(alias === undefined ? {} : { alias }),
          })),
      },
    );
    const orderItem: fc.Arbitrary<OrderItem> = fc
      .record({
        expr,
        direction: fc.constantFrom('asc' as const, 'desc' as const),
        nulls:
          dialect === 'postgres'
            ? fc.option(fc.constantFrom('first' as const, 'last' as const), { nil: undefined })
            : fc.constant(undefined),
      })
      .map(({ expr: e, direction, nulls }) => ({
        id: 'o',
        expr: e,
        direction,
        ...(nulls === undefined ? {} : { nulls }),
      }));
    return fc.record({
      distinct: fc.boolean(),
      tables: fc.constant(list),
      joins: joins(dialect, list),
      columns: fc.array(selectItem, { maxLength: 4 }),
      where: group(dialect, scope, 2).map((g) => ({ ...g, id: 'where' })),
      groupBy: fc.array(
        expr.map((e): GroupItem => ({ id: 'g', expr: e })),
        { maxLength: 3 },
      ),
      having: group(dialect, scope, 1).map((g) => ({ ...g, id: 'having' })),
      orderBy: fc.array(orderItem, { maxLength: 3 }),
      limit: fc.option(fc.integer({ min: 0, max: 1_000_000_000 }), { nil: undefined }),
      offset: fc.option(fc.integer({ min: 0, max: 1_000_000_000 }), { nil: undefined }),
    });
  });
}

describe('query model round trip', () => {
  for (const dialect of DIALECTS) {
    it(`generate(parse(generate(m))) equals generate(m) in ${dialect}`, () => {
      fc.assert(
        fc.property(queryModel(dialect), (m) => {
          const first = generateQuery(m, dialect);
          // Random joins may reach a table with different types: a warning, not an error.
          expect(first.issues.filter((issue) => issue.severity === 'error')).toEqual([]);
          const result = parseQuery(first.sql, dialect);
          if (result.status !== 'ok') {
            throw new Error(`${result.status}: ${result.message}\n${first.sql}`);
          }
          const second = generateQuery(result.model, dialect);
          expect(second.sql).toBe(first.sql);
          expect(second.issues).toEqual([]);
        }),
        { numRuns: 400 },
      );
    }, 60_000);
  }

  it('flags FULL JOIN on MySQL and MariaDB both ways', () => {
    const base: QueryModel = {
      distinct: false,
      tables: [
        { id: 'a', name: 'a' },
        { id: 'b', name: 'b' },
      ],
      joins: [
        {
          id: 'j',
          type: 'full',
          left: 'a',
          right: 'b',
          conditions: [{ left: 'x', operator: '=', right: 'y' }],
        },
      ],
      columns: [],
      where: { kind: 'group', id: 'where', op: 'and', items: [] },
      groupBy: [],
      having: { kind: 'group', id: 'having', op: 'and', items: [] },
      orderBy: [],
    };
    for (const dialect of ['mysql', 'mariadb'] as const) {
      const generated = generateQuery(base, dialect);
      expect(generated.issues.map((issue) => issue.severity)).toEqual(['error']);
      const parsed = parseQuery(generated.sql, dialect);
      expect(parsed.status).toBe('unsupported');
    }
    expect(generateQuery(base, 'postgres').issues).toEqual([]);
    expect(parseQuery(generateQuery(base, 'postgres').sql, 'postgres').status).toBe('ok');
  });

  it('never throws on noise, and every offset it reports is inside the text', () => {
    const noise = fc.array(
      fc.constantFrom(
        'SELECT',
        ' ',
        'a',
        ',',
        '(',
        ')',
        'FROM',
        't',
        'WHERE',
        '=',
        '1',
        "'",
        'AND',
        'OR',
        'NOT',
        'JOIN',
        'ON',
        '.',
        '*',
        'GROUP BY',
        'ORDER BY',
        'LIMIT',
        'IN',
        'BETWEEN',
        'IS',
        'NULL',
        'CASE',
        'END',
        'AS',
        '"',
        '`',
        ';',
        '--',
        '/*',
        '\n',
        'x',
      ),
      { maxLength: 30 },
    );
    fc.assert(
      fc.property(noise, fc.constantFrom(...DIALECTS), (parts, dialect) => {
        const sql = parts.join('');
        const result = parseQuery(sql, dialect);
        if (result.status !== 'ok') {
          expect(result.start).toBeGreaterThanOrEqual(0);
          expect(result.end).toBeLessThanOrEqual(sql.length);
          expect(result.start).toBeLessThanOrEqual(result.end);
        } else {
          // Whatever parses generates SQL that parses to the same SQL again.
          const first = generateQuery(result.model, dialect).sql;
          const reparsed = parseQuery(first, dialect);
          if (reparsed.status === 'ok')
            expect(generateQuery(reparsed.model, dialect).sql).toBe(first);
        }
      }),
      { numRuns: 2000 },
    );
  }, 60_000);
});
