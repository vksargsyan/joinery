import { SqlTranslationError } from './errors';

/**
 * The SQL lexer behind `sqlToMql`. Joinery owns its SQL lexing (ADR 0005); this one is separate
 * from @joinery/sql-tools because the translator reads one dialect of its own: backticks and
 * double quotes both quote identifiers (MySQL and ANSI), single quotes are strings with `''` as
 * the only escape, and `--` and `/* *\/` are comments. Keeping it here also keeps this package
 * free of sql-tools' parser and formatter dependencies in the renderer bundle.
 */

export type SqlTokenKind =
  /** A keyword or an unquoted identifier; `upper` holds its upper-case form. */
  | 'word'
  /** A `"quoted"` or `` `quoted` `` identifier; `value` is the unescaped name. */
  | 'quoted'
  /** A `'string'`; `value` is the unescaped text. */
  | 'string'
  | 'number'
  /** Operators and punctuation, one to two characters: `( ) , . * ; = <> != <= >= || ::`... */
  | 'op'
  | 'eof';

export interface SqlToken {
  readonly kind: SqlTokenKind;
  readonly value: string;
  /** The upper-case value of a word (for keyword checks); the value otherwise. */
  readonly upper: string;
  readonly start: number;
  /** Exclusive. */
  readonly end: number;
}

const WORD_START = /[\p{L}_]/u;
const WORD_PART = /[\p{L}\p{N}_$]/u;
const TWO_CHAR_OPS = new Set(['<>', '!=', '<=', '>=', '||', '::', '==']);

function isDigit(c: string | undefined): boolean {
  return c !== undefined && c >= '0' && c <= '9';
}

/** Splits a statement into tokens, ending with one `eof` token. */
export function tokenizeSql(sql: string): SqlToken[] {
  const tokens: SqlToken[] = [];
  const push = (kind: SqlTokenKind, value: string, start: number, end: number): void => {
    tokens.push({ kind, value, upper: kind === 'word' ? value.toUpperCase() : value, start, end });
  };
  const fail = (start: number, end: number, reason: string): never => {
    throw new SqlTranslationError(sql, 'VALIDATION_FAILED', { start, end }, reason);
  };
  let i = 0;
  while (i < sql.length) {
    const c = sql[i]!;
    if (/\s/u.test(c)) {
      i += 1;
      continue;
    }
    if (c === '-' && sql[i + 1] === '-') {
      while (i < sql.length && sql[i] !== '\n' && sql[i] !== '\r') i += 1;
      continue;
    }
    if (c === '/' && sql[i + 1] === '*') {
      const close = sql.indexOf('*/', i + 2);
      if (close < 0) fail(i, sql.length, 'This comment is never closed');
      i = close + 2;
      continue;
    }
    const start = i;
    if (c === "'" || c === '"' || c === '`') {
      let value = '';
      i += 1;
      for (;;) {
        if (i >= sql.length) {
          fail(
            start,
            sql.length,
            c === "'" ? 'This string is never closed' : 'This quoted name is never closed',
          );
        }
        const d = sql[i]!;
        if (d === c) {
          if (sql[i + 1] === c) {
            value += c;
            i += 2;
            continue;
          }
          i += 1;
          break;
        }
        value += d;
        i += 1;
      }
      push(c === "'" ? 'string' : 'quoted', value, start, i);
      continue;
    }
    const previous = tokens[tokens.length - 1];
    const afterDot = previous?.kind === 'op' && previous.value === '.';
    if (isDigit(c) || (c === '.' && isDigit(sql[i + 1]) && !afterDot && !isPathEnd(previous))) {
      if (afterDot) {
        // An array index in a path (`items.0.name`): digits only.
        while (isDigit(sql[i])) i += 1;
      } else {
        while (isDigit(sql[i])) i += 1;
        if (sql[i] === '.') {
          i += 1;
          while (isDigit(sql[i])) i += 1;
        }
        if (
          (sql[i] === 'e' || sql[i] === 'E') &&
          (isDigit(sql[i + 1]) || (/[+-]/.test(sql[i + 1] ?? '') && isDigit(sql[i + 2])))
        ) {
          i += 2;
          while (isDigit(sql[i])) i += 1;
        }
      }
      if (i < sql.length && WORD_PART.test(sql[i]!)) {
        while (i < sql.length && WORD_PART.test(sql[i]!)) i += 1;
        fail(start, i, `"${sql.slice(start, i)}" is not a number`);
      }
      push('number', sql.slice(start, i), start, i);
      continue;
    }
    if (WORD_START.test(c)) {
      while (i < sql.length && WORD_PART.test(sql[i]!)) i += 1;
      push('word', sql.slice(start, i), start, i);
      continue;
    }
    const two = sql.slice(i, i + 2);
    if (TWO_CHAR_OPS.has(two)) {
      i += 2;
      push('op', two, start, i);
      continue;
    }
    // A surrogate pair stays one token, so an error never splits a character.
    const code = sql.codePointAt(i)!;
    i += code > 0xffff ? 2 : 1;
    push('op', sql.slice(start, i), start, i);
  }
  push('eof', '', sql.length, sql.length);
  return tokens;
}

/** A token after which `.` continues a path rather than starting a number. */
function isPathEnd(token: SqlToken | undefined): boolean {
  if (token === undefined) return false;
  return (
    token.kind === 'word' ||
    token.kind === 'quoted' ||
    (token.kind === 'op' && (token.value === ')' || token.value === '*'))
  );
}
