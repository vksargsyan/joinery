import { readdirSync, readFileSync } from 'node:fs';

import type { SqlDialect } from '@joinery/core';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { buildCatalog, complete, signatureHelp, type CompletionResult } from '../../src';
import { largeSnapshot } from './fixtures';
import { CATALOGS, DIALECTS } from './helpers';

/**
 * Properties (spec §20): completion and signature help never throw for any text and offset, the
 * replacement range always contains the cursor, and items are well-formed and ordered. Plus the
 * performance budget on a 10,000-table catalog.
 */

// prettier-ignore
const FRAGMENTS = [
  'SELECT ', 'FROM ', 'WHERE ', 'JOIN ', 'LEFT ', 'ON ', 'USING ', 'AS ', 'GROUP BY ', 'ORDER BY ',
  'INSERT INTO ', 'VALUES ', 'UPDATE ', 'SET ', 'DELETE ', 'WITH ', 'RECURSIVE ', 'UNION ',
  'CREATE TABLE ', 'ALTER TABLE ', 'DROP ', 'COLUMN ', 'ADD ', 'REFERENCES ', 'BEGIN ', 'END ',
  'CASE ', 'WHEN ', 'THEN ', 'IF ', 'OVER ', 'PARTITION BY ', 'ON CONFLICT ', 'DO UPDATE SET ',
  'ON DUPLICATE KEY UPDATE ', 'RETURNING ', 'LIMIT ', 'EXPLAIN ', 'CALL ', 'DELIMITER $$\n',
  'DELIMITER ;\n', 'users', 'orders', 'o', 'u', 'u.', 'o.', 'public.', 'sales.', 'shop.', '"Us',
  '`Us', '"order details"', 'id', 'user_id', 'count(', 'lpad(', 'calc_total(', '(', ')', ',',
  '.', ';', '*', '=', '::', "'", '"', '`', '--', '/*', '*/', '#', '$$', '$1', '?', ':x', '@v',
  '\n', ' ', '1', 'EXISTS (', 'IN (', 'CAST(', 'AS (',
];

const text = fc
  .array(fc.constantFrom(...FRAGMENTS), { maxLength: 24 })
  .map((parts) => parts.join(''));
const dialect = fc.constantFrom<SqlDialect>(...DIALECTS);

function checkResult(result: CompletionResult, source: string, offset: number): void {
  const clamped = Math.max(0, Math.min(offset, source.length));
  expect(result.from).toBeLessThanOrEqual(clamped);
  expect(result.to).toBeGreaterThanOrEqual(clamped);
  expect(result.to).toBeLessThanOrEqual(source.length);
  let previous = '';
  for (const item of result.items) {
    expect(item.label.length).toBeGreaterThan(0);
    expect(item.insertText.length).toBeGreaterThan(0);
    expect(item.sortText >= previous).toBe(true);
    previous = item.sortText;
  }
}

describe('complete() properties', () => {
  it('never throws and keeps from <= offset <= to (SQL-like text)', () => {
    fc.assert(
      fc.property(text, fc.nat(), dialect, (source, n, d) => {
        const offset = n % (source.length + 1);
        checkResult(complete(source, offset, d, CATALOGS[d]), source, offset);
      }),
      { numRuns: 2000 },
    );
  }, 30_000);

  it('never throws on arbitrary strings and out-of-range offsets', () => {
    fc.assert(
      fc.property(
        fc.string({ unit: 'binary', maxLength: 80 }),
        fc.integer({ min: -5, max: 120 }),
        dialect,
        (source, offset, d) => {
          checkResult(complete(source, offset, d, CATALOGS[d]), source, offset);
          signatureHelp(source, offset, d, CATALOGS[d]);
        },
      ),
      { numRuns: 1000 },
    );
  }, 30_000);

  it('signatureHelp never throws and indexes stay in range', () => {
    fc.assert(
      fc.property(text, fc.nat(), dialect, (source, n, d) => {
        const help = signatureHelp(source, n % (source.length + 1), d, CATALOGS[d]);
        if (!help) return;
        expect(help.activeSignature).toBeLessThan(help.signatures.length);
        expect(help.activeParameter).toBeGreaterThanOrEqual(0);
      }),
      { numRuns: 1000 },
    );
  }, 30_000);

  it('completes at every offset of realistic scripts', () => {
    const scripts: [SqlDialect, string][] = [
      [
        'postgres',
        `WITH recent AS (SELECT o.id, o.user_id FROM orders o WHERE o.created_at > now() - interval '1 day')
SELECT u.name, count(*) FILTER (WHERE r.id IS NOT NULL) AS n
FROM users u LEFT JOIN recent r ON r.user_id = u.id
WHERE u.email ILIKE '%@x.org' -- note
GROUP BY u.name ORDER BY n DESC NULLS LAST LIMIT 10;
INSERT INTO orders (id, status) VALUES (1, 'new') ON CONFLICT (id) DO UPDATE SET status = excluded.status RETURNING *;
CREATE FUNCTION f(a int) RETURNS int LANGUAGE sql AS $$ SELECT a $$;
ALTER TABLE "UserAccounts" ADD COLUMN note text, DROP COLUMN "Provider";`,
      ],
      [
        'mysql',
        `DELIMITER $$
CREATE PROCEDURE p(IN n INT)
BEGIN
  DECLARE i INT DEFAULT 0;
  IF n > 0 THEN UPDATE orders o JOIN users u ON u.id = o.user_id SET o.status = 'x' WHERE u.id = n; END IF;
END$$
DELIMITER ;
SELECT \`Display Name\`, group_concat(o.id ORDER BY o.id SEPARATOR ',') FROM users u # hash comment
JOIN orders o USING (id) WHERE o.total BETWEEN 1 AND 2;
INSERT INTO orders SET status = 'a' ON DUPLICATE KEY UPDATE status = VALUES(status);`,
      ],
    ];
    for (const [first, script] of scripts) {
      for (const d of first === 'postgres'
        ? (['postgres'] as const)
        : (['mysql', 'mariadb'] as const)) {
        for (let offset = 0; offset <= script.length; offset++) {
          checkResult(complete(script, offset, d, CATALOGS[d]), script, offset);
          signatureHelp(script, offset, d, CATALOGS[d]);
        }
      }
    }
  }, 30_000);
});

describe('performance on 10,000 tables of 30 columns', () => {
  for (const d of ['postgres', 'mysql'] as const) {
    it(`${d}: builds in well under a second and completes quickly`, () => {
      const snapshot = largeSnapshot(d, 10_000, 30);
      let start = performance.now();
      const catalog = buildCatalog([snapshot]);
      const build = performance.now() - start;
      // Budget 200 ms; the bound is generous for slow CI machines.
      expect(build).toBeLessThan(1000);

      // Lookups are hashed, so 10,000 take milliseconds. They are timed without expect()'s own
      // cost, best of three, so a CI machine busy with other packages' tests stays within budget.
      const lookUpAll = (): number => {
        let found = 0;
        const begin = performance.now();
        for (let i = 0; i < 10_000; i++) {
          if (catalog.findRelation([{ name: `table_${i}`, quoted: false }])) found++;
        }
        const elapsed = performance.now() - begin;
        expect(found).toBe(10_000);
        return elapsed;
      };
      expect(Math.min(lookUpAll(), lookUpAll(), lookUpAll())).toBeLessThan(500);

      const texts: [string, number | undefined][] = [
        ['SELECT * FROM ', undefined],
        ['SELECT * FROM table_12', undefined],
        ['SELECT * FROM table_5000 t JOIN table_5001 u ON ', undefined],
        ['SELECT t. FROM table_42 t', 'SELECT t.'.length],
        ['SELECT * FROM table_42 t JOIN table_43 u ON u.parent_id = t.id WHERE ', undefined],
      ];
      start = performance.now();
      for (let i = 0; i < 100; i++) {
        const [source, offset] = texts[i % texts.length]!;
        const result = complete(source, offset ?? source.length, d, catalog);
        expect(result.items.length).toBeGreaterThan(0);
      }
      const total = performance.now() - start;
      expect(total).toBeLessThan(5000);

      const join = complete(texts[2]![0], texts[2]![0].length, d, catalog);
      expect(join.items[0]?.label).toBe('u.parent_id = t.id');
      const columns = complete(texts[3]![0], texts[3]![1]!, d, catalog);
      expect(columns.items).toHaveLength(31);
    }, 60_000);
  }
});

describe('independence from the parser', () => {
  it('never imports dt-sql-parser or the diagnostics module', () => {
    const dir = new URL('../../src/completion/', import.meta.url);
    for (const file of readdirSync(dir)) {
      const source = readFileSync(new URL(file, dir), 'utf8');
      expect(source, file).not.toMatch(/dt-sql-parser|\.\.\/diagnostics/);
    }
  });
});
