import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  EJSON,
  SqlTranslationError,
  parseFindText,
  parseShellPipeline,
  sqlToMql,
  toEjson,
  toFindQuery,
  type SqlTranslation,
} from '../src';

/**
 * Fuzz tests for the SQL to MQL translator (spec §20): random token soup and random text only
 * ever fail with a located SqlTranslationError; random well-formed queries always translate, to
 * data that serialises as canonical Extended JSON and to mongosh text that parses back to it.
 */

const RUNS = Number(process.env['QUERYBARA_FUZZ_RUNS'] ?? 300);

function checkTranslation(sql: string, translation: SqlTranslation): void {
  const data = translation.kind === 'find' ? translation.query : translation.pipeline;
  const ejson = toEjson(data);
  // Canonical Extended JSON: parsing and printing again gives the same text.
  expect(toEjson(EJSON.parse(ejson, { relaxed: false }))).toBe(ejson);
  if (translation.kind === 'find') {
    const parsed = parseFindText(translation.text);
    expect(parsed.collection).toBe(translation.collection);
    expect(toFindQuery(parsed.query)).toEqual(toFindQuery(translation.query));
  } else {
    const open = translation.text.indexOf('.aggregate(');
    const body = translation.text.slice(open + '.aggregate('.length, -1);
    expect(toEjson(parseShellPipeline(body)), sql).toBe(ejson);
  }
}

/** Runs the translator; anything thrown must be a located, expected SqlTranslationError. */
function translateOrFail(sql: string): SqlTranslation | undefined {
  try {
    return sqlToMql(sql);
  } catch (error) {
    if (!(error instanceof SqlTranslationError)) throw error;
    expect(['VALIDATION_FAILED', 'NOT_SUPPORTED'], `${sql}: ${error.message}`).toContain(
      error.code,
    );
    expect(error.offset).toBeGreaterThanOrEqual(0);
    expect(error.end).toBeGreaterThanOrEqual(error.offset);
    expect(error.end).toBeLessThanOrEqual(sql.length);
    return undefined;
  }
}

const TOKENS = [
  'SELECT',
  'select',
  'DISTINCT',
  'FROM',
  'WHERE',
  'GROUP',
  'BY',
  'HAVING',
  'ORDER',
  'LIMIT',
  'OFFSET',
  'JOIN',
  'LEFT',
  'INNER',
  'RIGHT',
  'ON',
  'AS',
  'AND',
  'OR',
  'NOT',
  'IN',
  'IS',
  'NULL',
  'LIKE',
  'ILIKE',
  'ESCAPE',
  'BETWEEN',
  'TRUE',
  'FALSE',
  'ASC',
  'DESC',
  'NULLS',
  'FIRST',
  'UNION',
  'CASE',
  'EXISTS',
  'OVER',
  'COUNT',
  'SUM',
  'AVG',
  'MIN',
  'MAX',
  'ObjectId',
  'DATE',
  'TIMESTAMP',
  'a',
  'b',
  'c.d',
  't',
  'u',
  '_id',
  '`x y`',
  '"q"',
  '"',
  '`',
  "'",
  "'s'",
  "'%a_'",
  "'2024-01-01'",
  "'65a1b2c3d4e5f60718293a4b'",
  '0',
  '1',
  '-1',
  '2.5',
  '1e3',
  '99999999999999999999',
  '.',
  ',',
  '(',
  ')',
  '*',
  ';',
  '=',
  '<>',
  '!=',
  '<',
  '<=',
  '>',
  '>=',
  '==',
  '+',
  '-',
  '/',
  '%',
  '||',
  '::',
  '?',
  '$',
  '@',
  '--',
  '/*',
  '*/',
  '\\',
  '\n',
  '😀',
];

const tokenSoup = fc
  .array(fc.constantFrom(...TOKENS), { maxLength: 30 })
  .chain((tokens) =>
    fc
      .array(fc.constantFrom(' ', '', '\t'), { minLength: tokens.length, maxLength: tokens.length })
      .map((gaps) => tokens.map((token, i) => token + gaps[i]!).join('')),
  );

// ---------------------------------------------------------------------------------------------
// Well-formed queries

const kw = (word: string) =>
  fc.constantFrom(word, word.toLowerCase(), word[0]! + word.slice(1).toLowerCase());

/** Fields whose output paths never overlap. */
const FIELDS = ['a', 'b', 'c.d', 'c.e', '`f g`', '"h"', 'i.j.k', 'items.0.sku'];
const field = fc.constantFrom(...FIELDS);

const literal = fc.oneof(
  fc.integer({ min: -2147483648, max: 2147483647 }).map(String),
  fc.bigInt({ min: 2n ** 31n, max: 2n ** 62n }).map(String),
  fc.double({ noNaN: true, noDefaultInfinity: true, min: -1e9, max: 1e9 }).map((n) => n.toFixed(3)),
  fc.string({ maxLength: 8 }).map((s) => `'${s.replace(/'/g, "''")}'`),
  fc.constantFrom('TRUE', 'FALSE', "DATE '2024-02-29'", "TIMESTAMP '2024-01-02 03:04:05'"),
  fc.constant("ObjectId('65a1b2c3d4e5f60718293a4b')"),
);

const likePattern = fc
  .array(fc.constantFrom('a', 'Z', '%', '_', '\\%', '\\_', '.', '*', '(', '/', ' ', "''", '😀'), {
    maxLength: 6,
  })
  .map((parts) => `'${parts.join('')}'`);

const compareOp = fc.constantFrom('=', '<>', '!=', '<', '<=', '>', '>=');

function condition(fieldArb: fc.Arbitrary<string>, depth: number): fc.Arbitrary<string> {
  const leaf = fc.oneof(
    fc.tuple(fieldArb, compareOp, literal).map(([f, op, v]) => `${f} ${op} ${v}`),
    fc.tuple(literal, compareOp, fieldArb).map(([v, op, f]) => `${v} ${op} ${f}`),
    fc.tuple(fieldArb, compareOp, fieldArb).map(([f, op, g]) => `${f} ${op} ${g}`),
    fc
      .tuple(fieldArb, fc.boolean(), fc.array(literal, { minLength: 1, maxLength: 3 }))
      .map(([f, not, list]) => `${f} ${not ? 'NOT ' : ''}IN (${list.join(', ')})`),
    fc
      .tuple(fieldArb, fc.boolean(), literal, literal)
      .map(([f, not, low, high]) => `${f} ${not ? 'NOT ' : ''}BETWEEN ${low} AND ${high}`),
    fc
      .tuple(fieldArb, fc.boolean(), fc.constantFrom('LIKE', 'ILIKE'), likePattern)
      .map(([f, not, op, p]) => `${f} ${not ? 'NOT ' : ''}${op} ${p}`),
    fc
      .tuple(fieldArb, fc.boolean(), fc.constantFrom('NULL', 'TRUE', 'FALSE'))
      .map(([f, not, what]) => `${f} IS ${not ? 'NOT ' : ''}${what}`),
    fieldArb,
    fc.constantFrom('TRUE', 'FALSE'),
  );
  if (depth <= 0) return leaf;
  const inner = condition(fieldArb, depth - 1);
  return fc.oneof(
    { weight: 3, arbitrary: leaf },
    { weight: 1, arbitrary: inner.map((c) => `NOT (${c})`) },
    {
      weight: 1,
      arbitrary: fc
        .tuple(inner, fc.constantFrom('AND', 'OR', 'and', 'or'), inner)
        .map(([l, op, r]) => `(${l} ${op} ${r})`),
    },
  );
}

const limit = fc.option(
  fc.oneof(
    fc.integer({ min: 1, max: 1000 }).map((n) => ` LIMIT ${n}`),
    fc
      .tuple(fc.integer({ min: 1, max: 1000 }), fc.integer({ min: 0, max: 1000 }))
      .map(([n, m]) => ` LIMIT ${n} OFFSET ${m}`),
    fc
      .tuple(fc.integer({ min: 0, max: 1000 }), fc.integer({ min: 1, max: 1000 }))
      .map(([m, n]) => ` LIMIT ${m}, ${n}`),
  ),
  { nil: '' },
);

const direction = fc.constantFrom(
  '',
  ' ASC',
  ' DESC',
  ' asc',
  ' DESC NULLS LAST',
  ' ASC NULLS FIRST',
);

/** SELECT columns FROM t [WHERE] [ORDER BY] [LIMIT]: a find(). */
const plainQuery = fc
  .tuple(
    kw('SELECT'),
    fc.oneof(
      fc.constant(['*']),
      fc
        .uniqueArray(field, { minLength: 1, maxLength: 4 })
        .chain((fields) =>
          fc
            .array(fc.boolean(), { minLength: fields.length, maxLength: fields.length })
            .map((aliased) => fields.map((f, i) => (aliased[i] ? `${f} AS x${i}` : f))),
        ),
    ),
    fc.boolean(),
    fc.option(condition(field, 3), { nil: undefined }),
    fc.array(fc.tuple(field, direction), { maxLength: 3 }),
    limit,
  )
  .map(([select, items, literalItem, where, order, page]) => {
    const list = items[0] === '*' ? items : [...items, ...(literalItem ? ["'k' AS kind"] : [])];
    let sql = `${select} ${list.join(', ')} FROM things`;
    if (where) sql += ` WHERE ${where}`;
    if (order.length > 0) sql += ` ORDER BY ${order.map(([f, d]) => f + d).join(', ')}`;
    return sql + page;
  });

const AGGREGATES = [
  'COUNT(*)',
  'COUNT(a)',
  'COUNT(DISTINCT b)',
  'SUM(a)',
  'AVG(c.d)',
  'MIN(b)',
  'MAX(`f g`)',
  'SUM(DISTINCT a)',
  'COUNT(1)',
];

/** SELECT keys, aggregates FROM t [WHERE] GROUP BY keys [HAVING] [ORDER BY] [LIMIT]. */
const groupedQuery = fc
  .tuple(
    fc.uniqueArray(field, { maxLength: 3 }),
    fc.uniqueArray(fc.constantFrom(...AGGREGATES), { minLength: 1, maxLength: 3 }),
    fc.option(condition(field, 2), { nil: undefined }),
    fc.boolean(),
    fc.boolean(),
    limit,
  )
  .chain(([keys, aggregates, where, byPosition, distinct, page]) => {
    const aliases = aggregates.map((_, i) => `agg${i}`);
    const havingOperand = fc.oneof(
      fc.constantFrom(...aggregates),
      fc.constantFrom(...aliases),
      ...(keys.length > 0 ? [fc.constantFrom(...keys)] : []),
    );
    const having = fc.option(condition(havingOperand, 1), { nil: undefined });
    const orderTarget = fc.oneof(
      fc.constantFrom(...aliases),
      fc.constantFrom(...aggregates),
      fc.integer({ min: 1, max: keys.length + aggregates.length }).map(String),
      ...(keys.length > 0 ? [fc.constantFrom(...keys)] : []),
    );
    return fc
      .tuple(having, fc.array(fc.tuple(orderTarget, direction), { maxLength: 2 }))
      .map(([havingText, order]) => {
        const items = [...keys, ...aggregates.map((a, i) => `${a} AS ${aliases[i]}`)];
        let sql = `SELECT ${distinct ? 'DISTINCT ' : ''}${items.join(', ')} FROM things`;
        if (where) sql += ` WHERE ${where}`;
        if (keys.length > 0) {
          sql += ` GROUP BY ${keys.map((k, i) => (byPosition ? String(i + 1) : k)).join(', ')}`;
        }
        if (havingText) sql += ` HAVING ${havingText}`;
        if (order.length > 0) sql += ` ORDER BY ${order.map(([t, d]) => t + d).join(', ')}`;
        return sql + page;
      });
  });

/** SELECT DISTINCT columns FROM t [ORDER BY columns]. */
const distinctQuery = fc
  .tuple(
    fc.uniqueArray(field, { minLength: 1, maxLength: 3 }),
    fc.option(condition(field, 1), { nil: undefined }),
  )
  .chain(([fields, where]) =>
    fc.array(fc.tuple(fc.constantFrom(...fields), direction), { maxLength: 2 }).map((order) => {
      let sql = `SELECT DISTINCT ${fields.join(', ')} FROM things`;
      if (where) sql += ` WHERE ${where}`;
      if (order.length > 0) sql += ` ORDER BY ${order.map(([f, d]) => f + d).join(', ')}`;
      return sql;
    }),
  );

const baseField = fc.constantFrom('t1.a', 't1.b', 'e', 't1.c.d', '`f g`');
const joinedField = fc.constantFrom('j1.x', 'j1.y', 'j1.z.w', 'j2.p');

/** Joins: equalities in ON, conditions on the joined collection, WHERE on both. */
const joinQuery = fc
  .tuple(
    fc.constantFrom('JOIN', 'INNER JOIN', 'LEFT JOIN', 'LEFT OUTER JOIN'),
    fc.uniqueArray(fc.constantFrom('x', 'y', 'z.w'), { minLength: 1, maxLength: 2 }),
    fc.option(fc.tuple(fc.constantFrom('j1.x', 'j1.y'), compareOp, literal), { nil: undefined }),
    fc.boolean(),
    fc.option(condition(fc.oneof(baseField, joinedField), 2), { nil: undefined }),
    fc.uniqueArray(fc.oneof(baseField, fc.constantFrom('j1.x', 'j1.y')), {
      minLength: 1,
      maxLength: 3,
    }),
    fc.boolean(),
    limit,
  )
  .map(([join, keys, extra, second, where, columns, group, page]) => {
    const on = keys.map((k, i) => `j1.${k} = ${['t1.a', 't1.b'][i]}`);
    if (extra) on.push(`${extra[0]} ${extra[1]} ${extra[2]}`);
    let sql = group
      ? `SELECT ${columns.join(', ')}, COUNT(*) AS n FROM things t1 ${join} others j1 ON ${on.join(' AND ')}`
      : `SELECT ${columns.join(', ')} FROM things t1 ${join} others j1 ON ${on.join(' AND ')}`;
    if (second) sql += ` LEFT JOIN more j2 ON j2.id = j1.x`;
    if (where && (second || !where.includes('j2.'))) sql += ` WHERE ${where}`;
    if (group) sql += ` GROUP BY ${columns.join(', ')} ORDER BY n DESC`;
    return sql + page;
  });

// Each property takes a second or two alone; a loaded CI machine running every package's tests
// at once needs far longer than vitest's 5 s default.
describe('SQL to MQL fuzzing', () => {
  it('never throws anything but a located SqlTranslationError on token soup', () => {
    fc.assert(
      fc.property(tokenSoup, (sql) => {
        const translation = translateOrFail(sql);
        if (translation) checkTranslation(sql, translation);
      }),
      { numRuns: RUNS * 10 },
    );
  }, 60_000);

  it('never throws anything but a located SqlTranslationError on arbitrary text', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary', maxLength: 60 }), (text) => {
        translateOrFail(text);
        translateOrFail(`SELECT ${text} FROM t`);
        translateOrFail(`SELECT * FROM t WHERE ${text}`);
      }),
      { numRuns: RUNS * 3 },
    );
  }, 60_000);

  it.each([
    ['plain', plainQuery, 'find'],
    ['grouped', groupedQuery, 'aggregate'],
    ['distinct', distinctQuery, 'aggregate'],
    ['join', joinQuery, 'aggregate'],
  ] as const)(
    'always translates well-formed %s queries',
    (_name, queries, kind) => {
      fc.assert(
        fc.property(queries, (sql) => {
          let translation: SqlTranslation;
          try {
            translation = sqlToMql(sql);
          } catch (error) {
            throw new Error(`${sql}\n${String(error)}`, { cause: error });
          }
          expect(translation.kind, sql).toBe(kind);
          checkTranslation(sql, translation);
          if (!sql.includes('*') || sql.includes('(*)')) {
            expect(translation.columns, sql).toBeDefined();
          }
        }),
        { numRuns: RUNS },
      );
    },
    60_000,
  );
});
