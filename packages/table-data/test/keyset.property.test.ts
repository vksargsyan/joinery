import type { CellValue } from '@querybara/core';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  keysetPredicate,
  reverseTerms,
  type KeysetPredicate,
  type KeysetTerm,
} from '../src/keyset';

/**
 * Keyset correctness as a property: for random rows, random sorts (mixed directions, NULL
 * placement, nullable and NOT NULL columns) and page sizes, reading page after page (and
 * backwards, page before page) with the generated predicate reproduces the full sort exactly.
 * The predicate is evaluated with SQL's three-valued logic, as a WHERE clause would.
 */

type Row = readonly CellValue[];

/** Column 0 is the unique id; 1–2 are nullable, 3 is NOT NULL. */
const NULLABLE = [false, true, true, false];

function compareValues(a: CellValue, b: CellValue): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  const x = String(a);
  const y = String(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

interface Term extends KeysetTerm {
  readonly column: number;
}

function compareRows(terms: readonly Term[], a: Row, b: Row): number {
  for (const term of terms) {
    const x = a[term.column] ?? null;
    const y = b[term.column] ?? null;
    if (x === null && y === null) continue;
    if (x === null) return term.nullsFirst ? -1 : 1;
    if (y === null) return term.nullsFirst ? 1 : -1;
    const c = compareValues(x, y);
    if (c !== 0) return term.descending ? -c : c;
  }
  return 0;
}

function evaluate(p: KeysetPredicate, row: Row, terms: readonly Term[]): boolean | null {
  switch (p.type) {
    case 'false':
      return false;
    case 'null':
      return (row[terms[p.term]!.column] === null) !== p.negate;
    case 'compare': {
      const value = row[terms[p.term]!.column] ?? null;
      if (value === null || p.value === null) return null;
      const c = compareValues(value, p.value);
      switch (p.op) {
        case '=':
          return c === 0;
        case '<':
          return c < 0;
        case '>':
          return c > 0;
        case '<=':
          return c <= 0;
        case '>=':
          return c >= 0;
      }
      return null;
    }
    case 'row': {
      for (let i = 0; i < terms.length; i++) {
        const value = row[terms[i]!.column] ?? null;
        const bound = p.values[i] ?? null;
        if (value === null || bound === null) return null;
        const c = compareValues(value, bound);
        if (c !== 0) return p.op === '>' ? c > 0 : c < 0;
      }
      return false;
    }
    case 'and': {
      let unknown = false;
      for (const item of p.items) {
        const v = evaluate(item, row, terms);
        if (v === false) return false;
        if (v === null) unknown = true;
      }
      return unknown ? null : true;
    }
    case 'or': {
      let unknown = false;
      for (const item of p.items) {
        const v = evaluate(item, row, terms);
        if (v === true) return true;
        if (v === null) unknown = true;
      }
      return unknown ? null : false;
    }
  }
}

/** ORDER BY terms LIMIT size, with the keyset WHERE when there is a key. */
function readPage(
  rows: readonly Row[],
  terms: readonly Term[],
  key: readonly CellValue[] | undefined,
  size: number,
  rowCompare: boolean,
): Row[] {
  const predicate = key === undefined ? undefined : keysetPredicate(terms, key, { rowCompare });
  return rows
    .filter((row) => predicate === undefined || evaluate(predicate, row, terms) === true)
    .sort((a, b) => compareRows(terms, a, b))
    .slice(0, size);
}

const keyOf = (terms: readonly Term[], row: Row): CellValue[] =>
  terms.map((t) => row[t.column] ?? null);

const value = fc.oneof(fc.integer({ min: 0, max: 3 }), fc.constantFrom('a', 'B', 'b', ''));

const rowsArbitrary = fc
  .array(
    fc.tuple(
      fc.option(value, { nil: null }),
      fc.option(value, { nil: null }),
      fc.integer({ min: 0, max: 2 }),
    ),
    {
      maxLength: 40,
    },
  )
  .map((cells) => cells.map(([a, b, c], id): Row => [id, a, b, c]));

const termsArbitrary = fc
  .tuple(
    fc.shuffledSubarray([1, 2, 3]),
    fc.array(fc.boolean(), { minLength: 3, maxLength: 3 }),
    fc.array(fc.boolean(), { minLength: 3, maxLength: 3 }),
    fc.boolean(),
  )
  .map(([columns, descending, nullsFirst, idDescending]): Term[] => [
    ...columns.map((column, i) => ({
      column,
      descending: descending[i]!,
      nullsFirst: nullsFirst[i]!,
      nullable: NULLABLE[column]!,
    })),
    { column: 0, descending: idDescending, nullsFirst: false, nullable: false },
  ]);

describe('keyset paging', () => {
  it('pages forward through exactly the full sort', () => {
    fc.assert(
      fc.property(
        rowsArbitrary,
        termsArbitrary,
        fc.integer({ min: 1, max: 7 }),
        fc.boolean(),
        (rows, terms, size, rowCompare) => {
          const full = [...rows].sort((a, b) => compareRows(terms, a, b));
          const seen: Row[] = [];
          let page = readPage(rows, terms, undefined, size, rowCompare);
          while (page.length > 0) {
            seen.push(...page);
            if (page.length < size || seen.length > rows.length) break;
            page = readPage(rows, terms, keyOf(terms, page[page.length - 1]!), size, rowCompare);
          }
          expect(seen).toEqual(full);
        },
      ),
      { numRuns: 400 },
    );
  });

  it('pages backward from the last page through exactly the full sort', () => {
    fc.assert(
      fc.property(
        rowsArbitrary,
        termsArbitrary,
        fc.integer({ min: 1, max: 7 }),
        (rows, terms, size) => {
          const full = [...rows].sort((a, b) => compareRows(terms, a, b));
          const reversed = reverseTerms(terms).map((t, i) => ({ ...t, column: terms[i]!.column }));
          const seen: Row[] = [];
          let page = readPage(rows, reversed, undefined, size, true).reverse();
          while (page.length > 0) {
            seen.unshift(...page);
            if (page.length < size || seen.length > rows.length) break;
            page = readPage(rows, reversed, keyOf(terms, page[0]!), size, true).reverse();
          }
          expect(seen).toEqual(full);
        },
      ),
      { numRuns: 400 },
    );
  });

  it('never returns the key row itself or anything before it', () => {
    fc.assert(
      fc.property(rowsArbitrary, termsArbitrary, (rows, terms) => {
        for (const row of rows) {
          const predicate = keysetPredicate(terms, keyOf(terms, row));
          for (const other of rows) {
            const after = evaluate(predicate, other, terms) === true;
            expect(after).toBe(compareRows(terms, other, row) > 0);
          }
        }
      }),
      { numRuns: 200 },
    );
  });
});
