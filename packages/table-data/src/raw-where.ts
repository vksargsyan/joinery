import { JoineryError, type SqlDialect } from '@joinery/core';
import { tokenize } from '@joinery/sql-tools';

/**
 * The raw WHERE box (spec §7) takes SQL the user types, inserted verbatim as
 * `WHERE (<text>)`. Before that, the dialect lexer checks it is one expression that cannot
 * escape its parentheses: no statement delimiter, no unterminated string, quoted identifier or
 * comment (which would swallow the rest of the query), no executable comment (MySQL runs
 * those), parentheses balanced and never closing more than they opened, no clause keyword
 * at the top level, and no bind parameters (the query numbers its own).
 */

export type RawWhereCheck =
  | {
      readonly ok: true;
      /** The text ends in a line comment, so the clause must end with a line break. */
      readonly endsWithLineComment: boolean;
    }
  | {
      readonly ok: false;
      readonly message: string;
      /** 0-based offset of the offending token. */
      readonly position: number;
    };

/** Reserved words that end a WHERE condition when they appear outside parentheses. */
const CLAUSE_KEYWORDS = new Set([
  'where',
  'order',
  'group',
  'having',
  'limit',
  'union',
  'intersect',
  'except',
  'into',
  'for',
  'select',
]);

/** Also reserved at the top level in PostgreSQL (MySQL allows them as column names). */
const PG_CLAUSE_KEYWORDS = new Set(['offset', 'fetch', 'window', 'returning']);

function isClauseKeyword(word: string, dialect: SqlDialect): boolean {
  return CLAUSE_KEYWORDS.has(word) || (dialect === 'postgres' && PG_CLAUSE_KEYWORDS.has(word));
}

/** Checks a raw WHERE condition (see the module comment); the UI shows `message` at `position`. */
export function checkRawWhere(text: string, dialect: SqlDialect): RawWhereCheck {
  const tokens = tokenize(text, dialect);
  let depth = 0;
  let significant = 0;
  let lastLineComment = false;
  const fail = (message: string, position: number): RawWhereCheck => ({
    ok: false,
    message,
    position,
  });
  for (const token of tokens) {
    if (token.kind === 'whitespace') continue;
    lastLineComment = token.kind === 'line-comment';
    if (token.unterminated) {
      const what =
        token.kind === 'string'
          ? 'string'
          : token.kind === 'quoted-identifier'
            ? 'quoted name'
            : token.kind === 'dollar-string'
              ? 'dollar-quoted string'
              : 'comment';
      return fail(`Unterminated ${what}`, token.start);
    }
    switch (token.kind) {
      case 'line-comment':
      case 'block-comment':
        continue;
      case 'delimiter':
        return fail('Only one condition is allowed: remove the ";"', token.start);
      case 'client-command':
        return fail('DELIMITER is a client command, not a condition', token.start);
      case 'executable-comment':
        return fail('Executable comments (/*! ... */) are not allowed in a filter', token.start);
      case 'parameter':
        if (token.text.startsWith('$') || token.text === '?') {
          return fail(`Parameters (${token.text}) are not supported in a filter`, token.start);
        }
        break;
      case 'punctuation':
        if (token.text === '(') depth++;
        else if (token.text === ')') {
          depth--;
          if (depth < 0)
            return fail('Unbalanced ")": it closes a parenthesis never opened', token.start);
        }
        break;
      case 'word':
        if (depth === 0 && isClauseKeyword(token.text.toLowerCase(), dialect)) {
          return fail(
            significant === 0 && token.text.toLowerCase() === 'where'
              ? 'Leave out the WHERE keyword: type only the condition'
              : `${token.text.toUpperCase()} is not part of a condition`,
            token.start,
          );
        }
        break;
      default:
        break;
    }
    significant++;
  }
  if (significant === 0) return fail('The condition is empty', 0);
  if (depth > 0) return fail(`Missing ")": ${depth} parenthesis left open`, text.length);
  return { ok: true, endsWithLineComment: lastLineComment };
}

/** The checked condition wrapped in parentheses, ready to AND into a WHERE clause. */
export function rawWhereSql(text: string, dialect: SqlDialect): string {
  const check = checkRawWhere(text, dialect);
  if (!check.ok) {
    throw new JoineryError({
      code: 'VALIDATION_FAILED',
      message: `Invalid WHERE condition: ${check.message}`,
      position: check.position,
    });
  }
  return check.endsWithLineComment ? `(${text}\n)` : `(${text})`;
}
