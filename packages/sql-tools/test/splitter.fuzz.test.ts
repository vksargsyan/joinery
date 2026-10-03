import type { SqlDialect } from '@querybara/core';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  StatementSplitter,
  analyzeStatement,
  findParameters,
  isTrivia,
  splitStatements,
  tokenize,
  type SqlStatement,
} from '../src';

/**
 * Fuzz tests for the splitter (spec §20): it never throws, its output is consistent with the
 * input, generated statement lists round-trip, and chunking never changes the result.
 */

const DIALECTS: SqlDialect[] = ['mysql', 'mariadb', 'postgres'];

/** Fragments that open, close or confuse strings, comments, quotes and delimiters. */
const NOISE = [
  "'",
  '"',
  '`',
  ';',
  ';;',
  '\n',
  '\r\n',
  '\r',
  ' ',
  '\t',
  '--',
  '-- ',
  '#',
  '/*',
  '*/',
  '/*!',
  '/*M!40101 ',
  '/*+',
  '$',
  '$$',
  '$a$',
  '$1',
  '?',
  ':',
  '::',
  ':=',
  ':x',
  '@',
  '@@',
  '\\',
  "E'",
  "U&'",
  'U&"',
  "N'",
  'x',
  'SELECT',
  'BEGIN',
  'ATOMIC',
  'END',
  'CASE',
  'CREATE',
  'FUNCTION',
  'PROCEDURE',
  'OR',
  'REPLACE',
  'RULE',
  '(',
  ')',
  'DELIMITER $$\n',
  'DELIMITER ;\n',
  'DELIMITER //\n',
  'delimiter ;;\n',
  '//',
  '1',
  '1.5e',
  '0x',
  'é',
  '😀',
  '﻿',
  '\u0000',
  '\uD800',
];

const noise = fc.oneof(
  fc.array(fc.constantFrom(...NOISE), { maxLength: 60 }).map((parts) => parts.join('')),
  fc.string({ unit: 'binary', maxLength: 80 }),
);

const dialect = fc.constantFrom(...DIALECTS);

function lineBreaksBefore(text: string, offset: number): { line: number; column: number } {
  let line = 1;
  let lineStart = 0;
  for (let i = 0; i < offset; i++) {
    const code = text.charCodeAt(i);
    if (code === 13 && text.charCodeAt(i + 1) === 10 && i + 1 < offset) continue;
    if (code === 10 || code === 13) {
      line++;
      lineStart = i + 1;
    }
  }
  return { line, column: offset - lineStart + 1 };
}

function checkInvariants(text: string, dialect: SqlDialect, statements: SqlStatement[]): void {
  const tokens = tokenize(text, dialect);
  const starts = new Map(tokens.map((token) => [token.start, token]));
  const ends = new Map(tokens.map((token) => [token.end, token]));
  let previousEnd = 0;
  for (const statement of statements) {
    expect(statement.text.length).toBeGreaterThan(0);
    expect(statement.text).toBe(text.slice(statement.start, statement.end));
    expect(statement.start).toBeGreaterThanOrEqual(previousEnd);
    previousEnd = statement.end;
    const first = starts.get(statement.start);
    const last = ends.get(statement.end);
    expect(first && !isTrivia(first.kind) && first.kind !== 'client-command').toBe(true);
    expect(last && !isTrivia(last.kind) && last.kind !== 'client-command').toBe(true);
    expect({ line: statement.line, column: statement.column }).toEqual(
      lineBreaksBefore(text, statement.start),
    );
  }
}

function splitInChunks(text: string, dialect: SqlDialect, cuts: number[]): SqlStatement[] {
  const splitter = new StatementSplitter(dialect);
  const out: SqlStatement[] = [];
  let last = 0;
  for (const cut of [...new Set(cuts)].sort((a, b) => a - b)) {
    out.push(...splitter.push(text.slice(last, cut)));
    last = cut;
  }
  out.push(...splitter.push(text.slice(last)));
  out.push(...splitter.end());
  return out;
}

describe('splitter fuzz', () => {
  it('never throws, and its statements are consistent with the input', () => {
    fc.assert(
      fc.property(noise, dialect, (text, d) => {
        const statements = splitStatements(text, d);
        checkInvariants(text, d, statements);
      }),
      { numRuns: 3000 },
    );
  });

  it('tokenize covers every input exactly', () => {
    fc.assert(
      fc.property(noise, dialect, (text, d) => {
        expect(
          tokenize(text, d)
            .map((token) => token.text)
            .join(''),
        ).toBe(text);
      }),
      { numRuns: 2000 },
    );
  });

  it('gives the same result however the input is chunked', () => {
    fc.assert(
      fc.property(
        noise,
        dialect,
        fc.array(fc.nat({ max: 200 }), { maxLength: 12 }),
        (text, d, cuts) => {
          const bounded = cuts.map((cut) => Math.min(cut, text.length));
          expect(splitInChunks(text, d, bounded)).toEqual(splitStatements(text, d));
        },
      ),
      { numRuns: 3000 },
    );
  });

  it('never throws in the other token-based tools', () => {
    fc.assert(
      fc.property(noise, dialect, (text, d) => {
        findParameters(text, d);
        findParameters(text, d, { questionMarks: true });
        analyzeStatement(text, d);
      }),
      { numRuns: 1000 },
    );
  });
});

// ---- Generated statement lists -------------------------------------------------------------

const TEXT_CHARS = [
  'a',
  'Z',
  ' ',
  ';',
  "'",
  '"',
  '`',
  '\\',
  '$',
  '*',
  '/',
  '-',
  '#',
  '\n',
  'é',
  '😀',
];
const content = fc.array(fc.constantFrom(...TEXT_CHARS), { maxLength: 12 }).map((c) => c.join(''));

const WORDS = [
  'SELECT',
  'FROM',
  't',
  'x1',
  'WHERE',
  'BEGIN',
  'END',
  'CASE',
  'ATOMIC',
  'é_col',
  '日本',
];
/**
 * Items that are significant tokens and never contain a top-level `;`. Inside a BEGIN ATOMIC
 * body (`body`), BEGIN / CASE / END and parentheses must balance, so they are left out.
 */
function significant(dialect: SqlDialect, body = false): fc.Arbitrary<string> {
  const words = body ? WORDS.filter((word) => !['BEGIN', 'END', 'CASE'].includes(word)) : WORDS;
  const symbols = ['1', '2.5', '0x1F', '=', '+', ',', '?', ':name', '$1'];
  const common = [
    fc.constantFrom(...words),
    fc.constantFrom(...(body ? symbols : [...symbols, '(', ')'])),
  ];
  if (dialect === 'postgres') {
    return fc.oneof(
      ...common,
      content.map((c) => `'${c.replaceAll("'", "''")}'`),
      content.map((c) => `E'${c.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`),
      content.map((c) => `"${c.replaceAll('"', '""')}"`),
      fc
        .tuple(fc.constantFrom('', 'q', 'body'), content)
        .map(([tag, c]) => `$${tag}$${c.replaceAll('$', '')}${tag ? '$$' : ''}$${tag}$`),
      fc.constant('::int'),
    );
  }
  return fc.oneof(
    ...common,
    content.map((c) => `'${c.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`),
    content.map((c) => `"${c.replaceAll('\\', '\\\\').replaceAll('"', '""')}"`),
    content.map((c) => `\`${c.replaceAll('`', '``')}\``),
    content.map((c) => `/*!40101 ${c.replaceAll('*', '')} */`),
    fc.constantFrom('@v', '@@session.sql_mode', ':='),
  );
}

/** Comments that may sit inside a statement; line comments end with their line break. */
function comment(dialect: SqlDialect): fc.Arbitrary<string> {
  const clean = content.map((c) => c.replaceAll('*', '').replaceAll('/', '').replaceAll('\n', ''));
  const arbitraries = [clean.map((c) => `/* ${c} */`), clean.map((c) => `-- ${c}\n`)];
  if (dialect === 'postgres') arbitraries.push(clean.map((c) => `/* a /* ${c} */ b */`));
  else arbitraries.push(clean.map((c) => `# ${c}\n`));
  return fc.oneof(...arbitraries);
}

function statement(dialect: SqlDialect, body = false): fc.Arbitrary<string> {
  const item = fc.oneof({ weight: 4, arbitrary: significant(dialect, body) }, comment(dialect));
  return fc
    .tuple(significant(dialect, body), fc.array(item, { maxLength: 8 }), significant(dialect, body))
    .map(([first, middle, last]) => [first, ...middle, last].join(' '));
}

/** PostgreSQL routines with SQL-standard bodies, whose inner statements end in `;`. */
const pgRoutine = fc
  .tuple(
    fc.constantFrom('CREATE FUNCTION', 'CREATE OR REPLACE PROCEDURE', 'create function'),
    fc.array(statement('postgres', true), { minLength: 1, maxLength: 3 }),
    fc.boolean(),
  )
  .map(
    ([head, inner, withCase]) =>
      `${head} f() LANGUAGE sql BEGIN ATOMIC ${inner.join('; ')};${withCase ? ' SELECT CASE WHEN 1 THEN 2 END;' : ''} END`,
  );

describe('generated statement lists', () => {
  for (const d of DIALECTS) {
    it(`${d}: joining with ";\\n" and splitting gives the statements back`, () => {
      const statements =
        d === 'postgres'
          ? fc.array(fc.oneof({ weight: 4, arbitrary: statement(d) }, pgRoutine), { maxLength: 8 })
          : fc.array(statement(d), { maxLength: 8 });
      fc.assert(
        fc.property(statements, fc.constantFrom(';\n', ';', ' ;\n\n', ';\r\n'), (list, join) => {
          const text = list.join(join);
          expect(splitStatements(text, d).map((s) => s.text)).toEqual(list);
        }),
        { numRuns: 1500 },
      );
    });
  }

  for (const d of ['mysql', 'mariadb'] as const) {
    it(`${d}: statements with inner semicolons survive DELIMITER $$`, () => {
      const body = fc
        .array(statement(d), { minLength: 1, maxLength: 4 })
        .map((parts) => parts.join('; '));
      fc.assert(
        fc.property(fc.array(body, { maxLength: 6 }), (list) => {
          const text = `DELIMITER $$\n${list.map((s) => `${s}$$\n`).join('')}DELIMITER ;\nSELECT 1;`;
          expect(splitStatements(text, d).map((s) => s.text)).toEqual([...list, 'SELECT 1']);
        }),
        { numRuns: 800 },
      );
    });
  }
});
