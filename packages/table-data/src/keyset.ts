import type { CellValue, SqlDialect } from '@querybara/core';

import { comparedAsText, type ColumnInfo } from './columns';
import { compare, ident, joinFragments, param, type Fragment } from './sql';

/**
 * Keyset paging (spec §7). A page after (or before) a row is the rows whose order key comes
 * strictly after (before) that row's order key, where the order key is the sort columns
 * followed by the row identity, so it is total and every row is visited exactly once however
 * sort directions mix and wherever NULLs sit.
 *
 * NULL ordering is each engine's own unless a sort term asks otherwise: PostgreSQL sorts NULL
 * as larger than every value (last ascending, first descending); MySQL and MariaDB sort it as
 * smaller (first ascending, last descending). A term that asks for the other placement adds
 * NULLS FIRST/LAST (PostgreSQL) or an `IS NULL` sort key (MySQL, which has no such clause).
 *
 * The predicate is built as a small tree, so it can be rendered to SQL and evaluated in memory
 * by the property tests with the same three-valued logic the server uses.
 */

export interface KeysetTerm {
  readonly descending: boolean;
  /** NULLs come first in the output order of this term. */
  readonly nullsFirst: boolean;
  /** False when the column is NOT NULL, which drops the NULL branches. */
  readonly nullable: boolean;
}

export type KeysetPredicate =
  | { readonly type: 'and' | 'or'; readonly items: readonly KeysetPredicate[] }
  | {
      readonly type: 'compare';
      readonly term: number;
      readonly op: '=' | '<' | '>' | '<=' | '>=';
      readonly value: CellValue;
    }
  | { readonly type: 'null'; readonly term: number; readonly negate: boolean }
  /** Row-value comparison over every term: `(a, b) > ($1, $2)`. */
  | { readonly type: 'row'; readonly op: '<' | '>'; readonly values: readonly CellValue[] }
  | { readonly type: 'false' };

/** Whether NULLs come first by default for this direction. */
export function defaultNullsFirst(dialect: SqlDialect, descending: boolean): boolean {
  return dialect === 'postgres' ? descending : !descending;
}

function and(items: KeysetPredicate[]): KeysetPredicate {
  return items.length === 1 ? items[0]! : { type: 'and', items };
}

function or(items: KeysetPredicate[]): KeysetPredicate {
  return items.length === 1 ? items[0]! : { type: 'or', items };
}

/** Rows whose value of term `i` sorts strictly after `value`, or null when none can. */
function strictlyAfter(term: KeysetTerm, i: number, value: CellValue): KeysetPredicate | null {
  if (value === null) {
    return term.nullsFirst ? { type: 'null', term: i, negate: true } : null;
  }
  const cmp: KeysetPredicate = {
    type: 'compare',
    term: i,
    op: term.descending ? '<' : '>',
    value,
  };
  if (term.nullsFirst || !term.nullable) return cmp;
  return or([cmp, { type: 'null', term: i, negate: false }]);
}

function equal(i: number, value: CellValue): KeysetPredicate {
  return value === null
    ? { type: 'null', term: i, negate: false }
    : { type: 'compare', term: i, op: '=', value };
}

/**
 * Rows strictly after `key` in the order the terms define. Nested form:
 * `a > x OR (a = x AND (b > y OR (b = y AND c > z)))`, with NULL branches where a term is
 * nullable, plus a leading `a >= x` range guard when the first term is NOT NULL (it lets the
 * optimiser use an index on it). `rowCompare` (PostgreSQL, one direction, no NULLs anywhere)
 * collapses it to `(a, b, c) > (x, y, z)`, which PostgreSQL turns into one index range.
 */
export function keysetPredicate(
  terms: readonly KeysetTerm[],
  key: readonly CellValue[],
  options: { readonly rowCompare?: boolean } = {},
): KeysetPredicate {
  const n = terms.length;
  if (n === 0) return { type: 'false' };
  if (
    options.rowCompare &&
    n > 1 &&
    terms.every((t) => t.descending === terms[0]!.descending && !t.nullable) &&
    key.every((v) => v !== null)
  ) {
    return { type: 'row', op: terms[0]!.descending ? '<' : '>', values: [...key] };
  }
  const build = (i: number): KeysetPredicate | null => {
    const value = key[i] ?? null;
    const after = strictlyAfter(terms[i]!, i, value);
    if (i === n - 1) return after;
    const rest = build(i + 1);
    const branches: KeysetPredicate[] = [];
    if (after) branches.push(after);
    if (rest) branches.push(and([equal(i, value), rest]));
    return branches.length === 0 ? null : or(branches);
  };
  const body = build(0);
  if (body === null) return { type: 'false' };
  const first = terms[0]!;
  const firstValue = key[0] ?? null;
  if (n > 1 && !first.nullable && firstValue !== null) {
    return and([
      { type: 'compare', term: 0, op: first.descending ? '<=' : '>=', value: firstValue },
      body,
    ]);
  }
  return body;
}

/** The terms read backwards: `before(key)` in an order is `after(key)` in the reverse order. */
export function reverseTerms(terms: readonly KeysetTerm[]): KeysetTerm[] {
  return terms.map((t) => ({ ...t, descending: !t.descending, nullsFirst: !t.nullsFirst }));
}

/** Renders a predicate; `columns[i]` is term i's column. */
export function keysetSql(
  predicate: KeysetPredicate,
  columns: readonly ColumnInfo[],
  dialect: SqlDialect,
): Fragment[] {
  const render = (p: KeysetPredicate, nested: boolean): Fragment[] => {
    switch (p.type) {
      case 'false':
        return ['FALSE'];
      case 'null':
        return [`${ident(columns[p.term]!.name, dialect)} IS ${p.negate ? 'NOT ' : ''}NULL`];
      case 'compare':
        return compare(columns[p.term]!, p.op, p.value, dialect);
      case 'row':
        return [
          `(${columns.map((c) => ident(c.name, dialect)).join(', ')}) ${p.op} (`,
          ...joinFragments(
            p.values.map((v) => [param(v)]),
            ', ',
          ),
          ')',
        ];
      case 'and':
      case 'or': {
        const body = joinFragments(
          p.items.map((item) => render(item, true)),
          p.type === 'and' ? ' AND ' : ' OR ',
        );
        return nested ? ['(', ...body, ')'] : body;
      }
    }
  };
  return render(predicate, false);
}

/**
 * Why keyset paging cannot order by this column, or undefined when it can. MySQL compares an
 * ENUM or SET with a string by text but sorts it by declaration index, compares JSON only with
 * JSON documents, and cannot compare geometry; PostgreSQL types matched as text cannot be
 * sorted at all.
 */
export function keysetBlocker(column: ColumnInfo, dialect: SqlDialect): string | undefined {
  if (comparedAsText(column, dialect))
    return `${column.name} (${column.dataType}) cannot be sorted`;
  if (dialect === 'postgres') return undefined;
  if (column.kind === 'enum') return `${column.name} is an ENUM/SET, which MySQL sorts by index`;
  if (column.kind === 'json') return `${column.name} is JSON`;
  if (column.kind === 'geometry') return `${column.name} is a geometry column`;
  return undefined;
}
