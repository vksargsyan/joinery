import type { SqlDialect } from '@querybara/core';

import { isTrivia, tokenize, type Token } from './lexer';
import { splitStatements } from './splitter';

/**
 * Inline syntax errors (spec §6) from dt-sql-parser, chosen in the parser spike (ADR 0003).
 * Everything parser-specific stays in this file so the parser can be swapped.
 *
 * MariaDB is checked with the MySQL grammar; statements using MariaDB-only syntax get no
 * diagnostics rather than false errors. Known grammar gaps are masked before parsing.
 */

export interface SqlDiagnostic {
  readonly message: string;
  /** Offset into the text passed to diagnose. */
  readonly start: number;
  /** Exclusive; always greater than start. */
  readonly end: number;
  readonly severity: 'error';
}

/** Statements longer than this are not parsed (large INSERT dumps): diagnostics stay cheap. */
export const MAX_DIAGNOSED_STATEMENT_LENGTH = 200_000;

/**
 * Syntax errors in a script, at most one per statement (the first; ANTLR's recovery errors
 * after it are mostly noise). The parser loads lazily on first use, so only callers of diagnose
 * (the editor's language worker) pay for it. Never rejects for bad SQL; rejects only if the
 * parser itself cannot be loaded.
 */
export async function diagnose(text: string, dialect: SqlDialect): Promise<SqlDiagnostic[]> {
  const validate = await loadValidator(dialect);
  const diagnostics: SqlDiagnostic[] = [];
  for (const statement of splitStatements(text, dialect)) {
    if (statement.text.length > MAX_DIAGNOSED_STATEMENT_LENGTH) continue;
    const tokens = tokenize(statement.text, dialect).filter((token) => !isTrivia(token.kind));
    const prepared = prepare(statement.text, tokens, dialect);
    if (prepared === null) continue;
    let errors: readonly ParserError[];
    try {
      errors = validate(prepared);
    } catch {
      continue;
    }
    const error = errors[0];
    if (!error) continue;
    const length = statement.text.length;
    let start = offsetOf(prepared, error.startLine, error.startColumn);
    let end = offsetOf(prepared, error.endLine, error.endColumn);
    if (start >= length) {
      // "Statement is incomplete" points past the end: mark the last token instead.
      const last = tokens[tokens.length - 1];
      start = last ? last.start : Math.max(0, length - 1);
      end = length;
    }
    if (end <= start) end = Math.min(length, start + 1);
    if (end <= start) continue;
    diagnostics.push({
      message: error.message,
      start: statement.start + start,
      end: statement.start + end,
      severity: 'error',
    });
  }
  return diagnostics;
}

/** dt-sql-parser's ParseError: 1-based lines, 1-based code point columns, end exclusive. */
interface ParserError {
  readonly startLine: number;
  readonly endLine: number;
  readonly startColumn: number;
  readonly endColumn: number;
  readonly message: string;
}

type Validate = (text: string) => readonly ParserError[];

interface DtParser {
  validate(text: string): ParserError[];
}

/** The internals validate() uses, minus its fallback that re-splits the input on every ";". */
interface DtParserInternals {
  parseWithCache?: (input: string) => unknown;
  _parseErrors?: ParserError[];
}

const loaders = new Map<'mysql' | 'postgres', Promise<Validate>>();

function loadValidator(dialect: SqlDialect): Promise<Validate> {
  const grammar = dialect === 'postgres' ? 'postgres' : 'mysql';
  let loader = loaders.get(grammar);
  if (!loader) {
    // Per-dialect entry points keep the other grammars out of the worker bundle.
    loader = (
      grammar === 'postgres'
        ? import('dt-sql-parser/dist/parser/postgresql').then((m) => new m.PostgreSQL())
        : import('dt-sql-parser/dist/parser/mysql').then((m) => new m.MySQL())
    ).then(toValidate);
    loader.catch(() => loaders.delete(grammar));
    loaders.set(grammar, loader);
  }
  return loader;
}

function toValidate(parser: DtParser): Validate {
  const internals = parser as unknown as DtParserInternals;
  const validate: Validate = (text) =>
    quietly(() => {
      // Statements that legitimately contain ";" (routine bodies) would be re-split by
      // validate()'s fallback into fragments that each report bogus errors.
      if (typeof internals.parseWithCache === 'function') {
        internals.parseWithCache.call(parser, text);
        if (Array.isArray(internals._parseErrors)) return internals._parseErrors;
      }
      return parser.validate(text);
    });
  validate('SELECT 1'); // warm the ATN caches
  return validate;
}

/** ANTLR's default console listener fires on some internal re-parses; keep the console clean. */
function quietly<T>(fn: () => T): T {
  const original = console.error;
  console.error = () => {};
  try {
    return fn();
  } finally {
    console.error = original;
  }
}

/** Converts a dt-sql-parser line/column (code points, "\n" lines) to a UTF-16 offset. */
function offsetOf(text: string, line: number, column: number): number {
  let offset = 0;
  for (let l = 1; l < line; l++) {
    const newline = text.indexOf('\n', offset);
    if (newline < 0) return text.length;
    offset = newline + 1;
  }
  for (let c = 1; c < column && offset < text.length; c++) {
    const code = text.charCodeAt(offset);
    const pair =
      code >= 0xd800 && code <= 0xdbff && (text.charCodeAt(offset + 1) & 0xfc00) === 0xdc00;
    offset += pair ? 2 : 1;
  }
  return Math.min(offset, text.length);
}

/**
 * Same-length rewrites around grammar gaps found in the spike (so offsets map 1:1), or null to
 * skip a statement the grammar cannot judge.
 */
function prepare(text: string, tokens: readonly Token[], dialect: SqlDialect): string | null {
  if (dialect === 'mariadb' && usesMariadbOnlySyntax(tokens)) return null;
  const edits: { start: number; end: number; text: string }[] = [];
  const replace = (start: number, end: number, replacement: string): void => {
    edits.push({ start, end, text: replacement.padEnd(end - start, ' ') });
  };
  const upper = (i: number): string | undefined => {
    const token = tokens[i];
    return token?.kind === 'word' ? token.text.toUpperCase() : undefined;
  };
  const isPunct = (i: number, text: string): boolean =>
    tokens[i]?.kind === 'punctuation' && tokens[i]?.text === text;
  const postgres = dialect === 'postgres';

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    const word = upper(i);
    // Placeholders are not SQL; a literal of the same length parses anywhere a value does.
    if (token.kind === 'parameter' && !(postgres && token.text.startsWith('$'))) {
      replace(token.start, token.end, '0');
    } else if (postgres && (token.kind === 'string' || token.kind === 'quoted-identifier')) {
      // U&'...' / U&"...": the grammar lacks the Unicode escape prefix. E'...': its lexer
      // rejects whatever follows the literal. Blank same-length stand-ins parse the same way.
      if (/^u&/i.test(token.text)) replace(token.start, token.start + 2, '');
      else if (/^e'/i.test(token.text) && !token.unterminated) {
        replace(token.start, token.end, `'${' '.repeat(token.text.length - 2)}'`);
      }
    } else if (postgres && (word === 'TRUE' || word === 'FALSE' || word === 'UNKNOWN')) {
      // x IS [NOT] TRUE / FALSE / UNKNOWN.
      const previous = upper(i - 1) === 'NOT' ? upper(i - 2) : upper(i - 1);
      if (previous === 'IS') replace(token.start, token.end, 'NULL');
    } else if (
      postgres &&
      (word === 'ANY' || word === 'SOME' || word === 'ALL') &&
      isPunct(i + 1, '(')
    ) {
      // x = ANY (...), x LIKE ALL (...): the grammar rejects every quantified comparison.
      const operator = tokens[i - 1];
      const opWord = upper(i - 1);
      if (operator && (operator.kind === 'operator' || opWord === 'LIKE' || opWord === 'ILIKE')) {
        replace(operator.start, token.end, 'IN');
      }
    } else if (!postgres && word === 'MATCH' && isPunct(i + 1, '(')) {
      // MATCH (cols) AGAINST (...) full-text search.
      const close = closingParen(tokens, i + 1);
      if (close >= 0 && upper(close + 1) === 'AGAINST' && isPunct(close + 2, '(')) {
        const end = closingParen(tokens, close + 2);
        if (end >= 0) {
          replace(token.start, tokens[end]!.end, '0');
          i = end;
        }
      }
    } else if (!postgres && word === 'NOWAIT') {
      replace(token.start, token.end, '');
    } else if (
      !postgres &&
      upper(i - 1) === 'AS' &&
      (word === 'DOUBLE' ||
        word === 'FLOAT' ||
        word === 'REAL' ||
        (dialect === 'mariadb' && (word === 'INTEGER' || word === 'INT')))
    ) {
      // CAST(x AS DOUBLE) and friends (MySQL 8.0.17+).
      replace(token.start, token.end, 'CHAR');
    }
  }
  if (edits.length === 0) return text;
  edits.sort((a, b) => a.start - b.start);
  const out: string[] = [];
  let last = 0;
  for (const edit of edits) {
    if (edit.start < last) continue;
    out.push(text.slice(last, edit.start), edit.text);
    last = edit.end;
  }
  out.push(text.slice(last));
  return out.join('');
}

function closingParen(tokens: readonly Token[], open: number): number {
  let depth = 0;
  for (let i = open; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token.kind !== 'punctuation') continue;
    if (token.text === '(') depth++;
    else if (token.text === ')' && --depth === 0) return i;
  }
  return -1;
}

const MARIADB_ONLY_WORDS = new Set([
  'RETURNING',
  'SEQUENCE',
  'SYSTEM_TIME',
  'VERSIONING',
  'WAIT',
  'NOWAIT',
  'PERIOD',
  'OVERLAPS',
  'HISTORY',
  'PERSISTENT',
  'COMPRESSED',
  'PACKAGE',
  'EXAMINED',
  'IMMEDIATE',
  'FETCH',
]);

/** MariaDB syntax the MySQL grammar rejects, found in the spike. */
function usesMariadbOnlySyntax(tokens: readonly Token[]): boolean {
  const words = tokens.map((token) => (token.kind === 'word' ? token.text.toUpperCase() : ''));
  const first = words[0];
  if (first === 'VALUES' || first === 'KILL') return true;
  if (first === 'BEGIN' && words[1] === 'NOT') return true;
  if (first === 'SET' && words[1] === 'STATEMENT') return true;
  if (first === 'SHOW' && (words[1] === 'EXPLAIN' || words[1] === 'ANALYZE')) return true;
  if (
    first === 'ANALYZE' &&
    words[1] !== 'TABLE' &&
    words[1] !== 'NO_WRITE_TO_BINLOG' &&
    words[1] !== 'LOCAL'
  ) {
    return true;
  }
  for (let i = 0; i < words.length; i++) {
    const word = words[i]!;
    if (MARIADB_ONLY_WORDS.has(word)) return true;
    if ((word === 'NEXT' || word === 'PREVIOUS') && words[i + 1] === 'VALUE') return true;
    if (word === 'IF' && (words[i + 1] === 'EXISTS' || words[i + 1] === 'NOT')) return true;
    if (word === 'OR' && words[i + 1] === 'REPLACE' && i === 1) {
      const object = words[i + 2];
      if (object !== 'VIEW' && object !== 'ALGORITHM' && object !== 'DEFINER' && object !== 'SQL')
        return true;
    }
  }
  return false;
}
