import type { SqlDialect } from '@joinery/core';

import { isTrivia, tokenize, type Token } from '../lexer';

/**
 * Token-level helpers shared by the query model's parser and generator: keyword classes, depth
 * scanning (parentheses, brackets and CASE … END), identifier and string literal decoding, and
 * the checks a hand-written SQL fragment must pass before the builder writes it into a query.
 */

const RESERVED_COMMON = [
  'ALL',
  'AND',
  'ANY',
  'AS',
  'ASC',
  'BETWEEN',
  'BOTH',
  'BY',
  'CASE',
  'CAST',
  'CHECK',
  'COLLATE',
  'COLUMN',
  'CONSTRAINT',
  'CREATE',
  'CROSS',
  'CURRENT_DATE',
  'CURRENT_TIME',
  'CURRENT_TIMESTAMP',
  'CURRENT_USER',
  'DEFAULT',
  'DESC',
  'DISTINCT',
  'ELSE',
  'END',
  'EXCEPT',
  'EXISTS',
  'FALSE',
  'FETCH',
  'FOR',
  'FOREIGN',
  'FROM',
  'FULL',
  'GRANT',
  'GROUP',
  'HAVING',
  'IN',
  'INNER',
  'INTERSECT',
  'INTO',
  'IS',
  'JOIN',
  'LATERAL',
  'LEADING',
  'LEFT',
  'LIKE',
  'LIMIT',
  'LOCALTIME',
  'LOCALTIMESTAMP',
  'NATURAL',
  'NOT',
  'NULL',
  'ON',
  'OR',
  'ORDER',
  'OUTER',
  'PRIMARY',
  'REFERENCES',
  'RIGHT',
  'SELECT',
  'TABLE',
  'THEN',
  'TO',
  'TRAILING',
  'TRUE',
  'UNION',
  'UNIQUE',
  'USING',
  'WHEN',
  'WHERE',
  'WINDOW',
  'WITH',
];

const RESERVED_POSTGRES = new Set([
  ...RESERVED_COMMON,
  'ANALYSE',
  'ANALYZE',
  'ARRAY',
  'ASYMMETRIC',
  'AUTHORIZATION',
  'BINARY',
  'COLLATION',
  'CONCURRENTLY',
  'CURRENT_CATALOG',
  'CURRENT_ROLE',
  'CURRENT_SCHEMA',
  'DEFERRABLE',
  'DO',
  'FREEZE',
  'ILIKE',
  'INITIALLY',
  'ISNULL',
  'NOTNULL',
  'OFFSET',
  'ONLY',
  'OVERLAPS',
  'PLACING',
  'RETURNING',
  'SESSION_USER',
  'SIMILAR',
  'SOME',
  'SYMMETRIC',
  'SYSTEM_USER',
  'TABLESAMPLE',
  'UNKNOWN',
  'USER',
  'VARIADIC',
  'VERBOSE',
]);

const RESERVED_MYSQL = new Set([
  ...RESERVED_COMMON,
  'CUBE',
  'DISTINCTROW',
  'DIV',
  'DUAL',
  'FORCE',
  'GROUPING',
  'HIGH_PRIORITY',
  'IGNORE',
  'INDEX',
  'INTERVAL',
  'KEY',
  'LOCK',
  'MATCH',
  'MOD',
  'OVER',
  'PARTITION',
  'PROCEDURE',
  'REGEXP',
  'RLIKE',
  'ROWS',
  'SQL_BIG_RESULT',
  'SQL_CALC_FOUND_ROWS',
  'SQL_SMALL_RESULT',
  'STRAIGHT_JOIN',
  'USE',
  'UTC_DATE',
  'UTC_TIME',
  'UTC_TIMESTAMP',
  'VALUES',
  'XOR',
]);

/** Words that may follow an expression without being its alias (interval units, modifiers). */
const NEVER_ALIAS = new Set([
  'DAY',
  'HOUR',
  'MINUTE',
  'SECOND',
  'MONTH',
  'YEAR',
  'WEEK',
  'QUARTER',
  'MICROSECOND',
  'ESCAPE',
  'NULLS',
  'FIRST',
  'LAST',
  'OFFSET',
  'OVER',
  'FILTER',
  'WITHIN',
  'COLLATE',
  'UNKNOWN',
]);

/** Upper-case text of a `word` token, '' for anything else. */
export function wordOf(token: Token | undefined): string {
  return token?.kind === 'word' ? token.text.toUpperCase() : '';
}

export function isWord(token: Token | undefined, ...words: string[]): boolean {
  const word = wordOf(token);
  return word !== '' && words.includes(word);
}

export function isPunct(token: Token | undefined, text: string): boolean {
  return token !== undefined && token.kind === 'punctuation' && token.text === text;
}

export function isOperator(token: Token | undefined, ...texts: string[]): boolean {
  return token !== undefined && token.kind === 'operator' && texts.includes(token.text);
}

/** A word the dialect reserves: never a bare column, table or alias name. */
export function isReserved(word: string, dialect: SqlDialect): boolean {
  return (dialect === 'postgres' ? RESERVED_POSTGRES : RESERVED_MYSQL).has(word.toUpperCase());
}

/** A token that can name something: a quoted identifier or an unreserved word. */
export function isIdentifier(token: Token | undefined, dialect: SqlDialect): token is Token {
  if (!token) return false;
  if (token.kind === 'quoted-identifier') return !token.text.startsWith('U&');
  return token.kind === 'word' && !isReserved(token.text, dialect);
}

/** A token that can be an implicit alias (`SELECT a b`, `FROM t x`). */
export function isAliasToken(token: Token | undefined, dialect: SqlDialect): boolean {
  return isIdentifier(token, dialect) && !NEVER_ALIAS.has(wordOf(token));
}

/**
 * The name an identifier token stands for: quotes removed, and an unquoted PostgreSQL name
 * folded to lower case (ASCII only, like the server). Undefined for anything else.
 */
export function identifierName(token: Token, dialect: SqlDialect): string | undefined {
  if (token.kind === 'quoted-identifier') {
    const quote = token.text[0];
    if (token.unterminated || (quote !== '"' && quote !== '`')) return undefined;
    return token.text.slice(1, -1).replaceAll(quote + quote, quote);
  }
  if (token.kind !== 'word') return undefined;
  return dialect === 'postgres'
    ? token.text.replace(/[A-Z]+/g, (letters) => letters.toLowerCase())
    : token.text;
}

const MYSQL_UNESCAPES: Readonly<Record<string, string>> = {
  '0': '\0',
  b: '\b',
  n: '\n',
  r: '\r',
  t: '\t',
  Z: '\x1a',
  '%': '\\%',
  _: '\\_',
};

/**
 * The value of a string literal token: PostgreSQL standard strings and E'…' escapes, MySQL
 * single- or double-quoted strings with backslash escapes. Undefined for literals that are not
 * plain text (N'…', X'…', B'…', U&'…', MySQL charset introducers are separate tokens).
 */
export function stringValue(token: Token, dialect: SqlDialect): string | undefined {
  if (token.kind !== 'string' || token.unterminated) return undefined;
  const text = token.text;
  const quote = text[0];
  if (dialect === 'postgres') {
    if (quote === "'") return text.slice(1, -1).replaceAll("''", "'");
    if ((quote === 'E' || quote === 'e') && text[1] === "'")
      return postgresEscape(text.slice(2, -1));
    return undefined;
  }
  if (quote !== "'" && quote !== '"') return undefined;
  const body = text.slice(1, -1);
  let out = '';
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    if (ch === '\\' && i + 1 < body.length) {
      const next = body[++i]!;
      out += MYSQL_UNESCAPES[next] ?? next;
    } else if (ch === quote && body[i + 1] === quote) {
      out += quote;
      i++;
    } else {
      out += ch;
    }
  }
  return out;
}

function postgresEscape(body: string): string | undefined {
  let out = '';
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    if (ch === "'" && body[i + 1] === "'") {
      out += "'";
      i++;
      continue;
    }
    if (ch !== '\\') {
      out += ch;
      continue;
    }
    const next = body[++i];
    if (next === undefined) return undefined;
    const simple: Record<string, string> = { b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
    if (simple[next] !== undefined) out += simple[next];
    // Octal, hex and Unicode escapes are rare in hand-written criteria: keep those literals raw.
    else if (/[0-7xuU]/.test(next)) return undefined;
    else out += next;
  }
  return out;
}

/** Decimal number text, optionally negative: what a `number` value holds. */
export const DECIMAL_NUMBER = /^-?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

/** Placeholder text a dialect's run prompts for. */
export function isParameterText(text: string, dialect: SqlDialect): boolean {
  if (/^\$[1-9]\d*$/.test(text) || /^:[A-Za-z_][A-Za-z0-9_]*$/.test(text)) return true;
  return dialect !== 'postgres' && text === '?';
}

/**
 * Walks tokens[start, end) at nesting depth 0: parentheses, brackets and CASE … END nest.
 * `visit` sees every depth-0 token (the opening token of a nested part too) and may stop the
 * walk by returning true; the index it stopped at is returned, or -1.
 */
export function scanTop(
  tokens: readonly Token[],
  start: number,
  end: number,
  visit: (token: Token, index: number) => boolean | void,
): number {
  let depth = 0;
  for (let i = start; i < end; i++) {
    const token = tokens[i]!;
    if (depth === 0 && visit(token, i) === true) return i;
    if (isPunct(token, '(') || isPunct(token, '[') || isWord(token, 'CASE')) depth++;
    else if (isPunct(token, ')') || isPunct(token, ']') || isWord(token, 'END')) {
      depth = Math.max(0, depth - 1);
    }
  }
  return -1;
}

/** Index of the `)` (or `]`) that closes the bracket at `open`, or -1. */
export function closingIndex(tokens: readonly Token[], open: number, end = tokens.length): number {
  let depth = 0;
  for (let i = open; i < end; i++) {
    const token = tokens[i]!;
    if (isPunct(token, '(') || isPunct(token, '[')) depth++;
    else if (isPunct(token, ')') || isPunct(token, ']')) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Splits tokens[start, end) at depth-0 commas: [start, end) pairs, empty parts included. */
export function splitTopCommas(
  tokens: readonly Token[],
  start: number,
  end: number,
): [number, number][] {
  const parts: [number, number][] = [];
  let from = start;
  scanTop(tokens, start, end, (token, index) => {
    if (isPunct(token, ',')) {
      parts.push([from, index]);
      from = index + 1;
    }
  });
  parts.push([from, end]);
  return parts;
}

/** The construct a token range uses that the builder cannot show anywhere, if any. */
export function unsupportedInside(
  tokens: readonly Token[],
  start: number,
  end: number,
): { readonly construct: string; readonly token: Token } | undefined {
  for (let i = start; i < end; i++) {
    const token = tokens[i]!;
    if (isWord(token, 'SELECT')) return { construct: 'a subquery', token };
    if (isWord(token, 'OVER') && isPunct(tokens[i - 1], ')')) {
      return { construct: 'a window function (OVER)', token };
    }
    if (token.kind === 'executable-comment') {
      return { construct: 'an executable comment (/*! … */)', token };
    }
  }
  return undefined;
}

/** Tokens that end an operand, for spotting two operands side by side (`a b` is an alias). */
export function endsOperand(token: Token): boolean {
  return (
    token.kind === 'word' ||
    token.kind === 'quoted-identifier' ||
    token.kind === 'number' ||
    token.kind === 'string' ||
    token.kind === 'dollar-string' ||
    token.kind === 'parameter' ||
    token.kind === 'variable' ||
    isPunct(token, ')') ||
    isPunct(token, ']')
  );
}

const SAFE_OPERATORS = new Set(['+', '-', '*', '/', '%', '::']);

/** Reserved words that are ordinary function calls when a parenthesis follows. */
const FUNCTION_KEYWORDS = new Set([
  'CAST',
  'COALESCE',
  'CONVERT',
  'EXTRACT',
  'GREATEST',
  'IF',
  'INSERT',
  'LEAST',
  'LEFT',
  'MOD',
  'NULLIF',
  'OVERLAY',
  'POSITION',
  'REPLACE',
  'RIGHT',
  'SUBSTRING',
  'TRIM',
]);

/**
 * True when a raw expression can stand next to operators and keywords without parentheses:
 * names, literals, function calls, parenthesised parts and arithmetic. Anything else (a
 * comparison, AND, CASE, a keyword) is wrapped in parentheses when it is written into a query,
 * so the query parses back with the same structure.
 */
export function isSimpleExpression(sql: string, dialect: SqlDialect): boolean {
  const tokens = significant(sql, dialect);
  if (tokens.length <= 1) return true;
  let previous: Token | undefined;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    const operand =
      token.kind === 'quoted-identifier' ||
      token.kind === 'number' ||
      token.kind === 'string' ||
      token.kind === 'parameter' ||
      (token.kind === 'word' &&
        (!isReserved(token.text, dialect) ||
          (FUNCTION_KEYWORDS.has(wordOf(token)) && isPunct(tokens[i + 1], '(')))) ||
      isPunct(token, '(');
    const call = isPunct(token, '(') && previous?.kind === 'word';
    const ok =
      (operand && (previous === undefined || !endsOperand(previous) || call)) ||
      isPunct(token, '.') ||
      (token.kind === 'operator' &&
        (SAFE_OPERATORS.has(token.text) || (dialect === 'postgres' && token.text === '||')));
    if (!ok) return false;
    if (isPunct(token, '(')) {
      // A parenthesised part counts as one operand, whatever it holds.
      const close = closingIndex(tokens, i);
      if (close < 0) return false;
      i = close;
      previous = tokens[close];
    } else {
      previous = token;
    }
  }
  return true;
}

/** True when a condition written as SQL has a depth-0 AND / OR (or MySQL's || and &&, XOR). */
export function hasTopLevelLogic(sql: string, dialect: SqlDialect): boolean {
  const tokens = significant(sql, dialect);
  return (
    scanTop(
      tokens,
      0,
      tokens.length,
      (token) =>
        isWord(token, 'AND', 'OR', 'XOR') ||
        (dialect !== 'postgres' && isOperator(token, '||', '&&')),
    ) >= 0
  );
}

/** True when the whole text is one parenthesised part: `(a OR b)`, not `(a) = (b)`. */
export function isParenthesized(sql: string, dialect: SqlDialect): boolean {
  const tokens = significant(sql, dialect);
  return isPunct(tokens[0], '(') && closingIndex(tokens, 0) === tokens.length - 1;
}

/** Why the brackets of tokens do not balance, or undefined when they do; with the token at fault. */
export function unbalanced(
  tokens: readonly Token[],
): { readonly message: string; readonly token: Token | undefined } | undefined {
  const open: Token[] = [];
  for (const token of tokens) {
    if (isPunct(token, '(') || isPunct(token, '[')) open.push(token);
    else if (isPunct(token, ')') || isPunct(token, ']')) {
      if (!open.pop()) return { message: 'A closing parenthesis has no opening one.', token };
    }
  }
  const last = open.pop();
  return last ? { message: 'A parenthesis is not closed.', token: last } : undefined;
}

function significant(sql: string, dialect: SqlDialect): Token[] {
  return tokenize(sql, dialect).filter((token) => !isTrivia(token.kind));
}

/**
 * Why a hand-written expression or condition cannot go into a query, or undefined when it can:
 * it must be one complete expression (no `;`, no comments, balanced brackets, closed strings,
 * no comma outside brackets) and use nothing the builder cannot show (subqueries, windows).
 */
export function checkFragment(sql: string, dialect: SqlDialect): string | undefined {
  const all = tokenize(sql, dialect);
  const tokens = all.filter((token) => !isTrivia(token.kind));
  if (tokens.length === 0) return 'It is empty.';
  for (const token of all) {
    if (token.unterminated) return 'A string, quoted name or comment is not closed.';
    if (token.kind === 'line-comment' || token.kind === 'block-comment') {
      return 'Comments cannot go into builder expressions.';
    }
    if (token.kind === 'delimiter' || token.kind === 'client-command') {
      return 'It must be one expression, without a statement delimiter.';
    }
  }
  const brackets = unbalanced(tokens);
  if (brackets) return brackets.message;
  const unsupported = unsupportedInside(tokens, 0, tokens.length);
  if (unsupported) return `The builder cannot hold ${unsupported.construct}; edit the SQL instead.`;
  if (scanTop(tokens, 0, tokens.length, (token) => isPunct(token, ',')) >= 0) {
    return 'It has a comma outside parentheses: write one expression.';
  }
  return undefined;
}
