import { lineStartOffset } from '@joinery/driver-sql-base';
import { quoteString } from '@joinery/sql-tools';

/**
 * MySQL / MariaDB text helpers: a small lexer that knows strings, quoted identifiers and
 * comments, and the normalisations introspection needs (DEFINER clauses, own-database
 * qualifiers, column defaults).
 */

type Token =
  | { kind: 'text'; text: string }
  | { kind: 'string'; text: string }
  | { kind: 'ident'; text: string; name: string }
  | { kind: 'word'; text: string }
  | { kind: 'comment'; text: string };

const WORD = /[A-Za-z0-9_$\u0080-￿]/;

/** Splits MySQL text into tokens without losing a character: joining `text` gives the input. */
export function tokenize(sql: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const push = (token: Token): void => {
    tokens.push(token);
  };
  while (i < sql.length) {
    const ch = sql[i]!;
    const start = i;
    if (ch === "'" || ch === '"') {
      i++;
      while (i < sql.length) {
        if (sql[i] === '\\') {
          i += 2;
          continue;
        }
        if (sql[i] === ch) {
          if (sql[i + 1] === ch) {
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      push({ kind: 'string', text: sql.slice(start, i) });
    } else if (ch === '`') {
      i++;
      let name = '';
      while (i < sql.length) {
        if (sql[i] === '`') {
          if (sql[i + 1] === '`') {
            name += '`';
            i += 2;
            continue;
          }
          i++;
          break;
        }
        name += sql[i];
        i++;
      }
      push({ kind: 'ident', text: sql.slice(start, i), name });
    } else if (ch === '#' || (ch === '-' && sql[i + 1] === '-' && /\s/.test(sql[i + 2] ?? ' '))) {
      while (i < sql.length && sql[i] !== '\n') i++;
      push({ kind: 'comment', text: sql.slice(start, i) });
    } else if (ch === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2);
      i = end === -1 ? sql.length : end + 2;
      push({ kind: 'comment', text: sql.slice(start, i) });
    } else if (WORD.test(ch)) {
      while (i < sql.length && WORD.test(sql[i]!)) i++;
      push({ kind: 'word', text: sql.slice(start, i) });
    } else {
      i++;
      push({ kind: 'text', text: ch });
    }
  }
  return tokens;
}

/**
 * Removes qualifiers naming `database` (`` `db`. `` or `db.`) outside strings and comments,
 * so definitions of two databases with different names compare equal (schema.ts conventions).
 */
export function removeDatabaseQualifier(sql: string, database: string): string {
  const tokens = tokenize(sql);
  let out = '';
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    const next = tokens[i + 1];
    const names =
      (token.kind === 'ident' && token.name === database) ||
      (token.kind === 'word' && token.text === database);
    const prev = tokens[i - 1];
    const afterDot = prev !== undefined && prev.kind === 'text' && prev.text === '.';
    const after = tokens[i + 2];
    if (
      names &&
      !afterDot &&
      next?.kind === 'text' &&
      next.text === '.' &&
      after !== undefined &&
      (after.kind === 'ident' || after.kind === 'word')
    ) {
      i++; // skip the dot as well
      continue;
    }
    out += token.text;
  }
  return out;
}

/**
 * Drops the DEFINER clause from a SHOW CREATE statement ("CREATE DEFINER=`u`@`h` PROCEDURE"
 * → "CREATE PROCEDURE"). The definer is kept separately.
 */
export function stripDefiner(sql: string): string {
  const account = String.raw`(?:\x60(?:[^\x60]|\x60\x60)*\x60|'(?:[^']|'')*'|"(?:[^"]|"")*"|[^\s@]+)`;
  const pattern = new RegExp(
    String.raw`^(\s*CREATE\s+(?:OR\s+REPLACE\s+)?(?:ALGORITHM\s*=\s*\w+\s+)?)DEFINER\s*=\s*(?:CURRENT_USER(?:\s*\(\s*\))?|${account}(?:\s*@\s*${account})?)\s+`,
    'i',
  );
  return sql.replace(pattern, '$1');
}

/** The statement's command for status chunks: "INSERT", "CREATE TABLE", "CALL"... */
export function commandOf(sql: string): string | null {
  const words = tokenize(sql)
    .filter((t) => t.kind === 'word')
    .map((t) => t.text.toUpperCase());
  const first = words[0];
  if (first === undefined) return null;
  if (!['CREATE', 'ALTER', 'DROP'].includes(first)) return first;
  const skip = new Set([
    'OR',
    'REPLACE',
    'TEMPORARY',
    'UNIQUE',
    'FULLTEXT',
    'SPATIAL',
    'ONLINE',
    'OFFLINE',
    'IGNORE',
    'ALGORITHM',
    'UNDEFINED',
    'MERGE',
    'TEMPTABLE',
    'DEFINER',
    'SQL',
    'SECURITY',
    'INVOKER',
    'IF',
    'NOT',
    'EXISTS',
    'AGGREGATE',
    'CURRENT_USER',
  ]);
  const object = words.slice(1).find((w) => !skip.has(w) && !w.includes('@'));
  return object ? `${first} ${object}` : first;
}

/** Position (0-based) of a MySQL/MariaDB syntax error, from "... near '<text>' at line N". */
export function syntaxErrorPosition(message: string, sql: string): number | undefined {
  const match = /near '([\s\S]*)' at line (\d+)\s*$/.exec(message);
  if (!match) return undefined;
  const near = match[1]!;
  const lineStart = lineStartOffset(sql, Number(match[2]));
  if (near === '') return sql.trimEnd().length;
  const index = sql.indexOf(near, lineStart);
  if (index >= 0) return index;
  const prefix = near.slice(0, 16);
  const fallback = sql.indexOf(prefix, lineStart);
  return fallback >= 0 ? fallback : undefined;
}

const CURRENT_TIMESTAMP =
  /^(?:current_timestamp|now|localtime|localtimestamp)(?:\s*\(\s*(\d*)\s*\))?$/i;

/** CURRENT_TIMESTAMP spellings (now(), current_timestamp(3)...) → "CURRENT_TIMESTAMP[(n)]". */
export function normaliseCurrentTimestamp(text: string): string | undefined {
  const match = CURRENT_TIMESTAMP.exec(text.trim());
  if (!match) return undefined;
  const precision = match[1];
  return precision && precision !== '0' ? `CURRENT_TIMESTAMP(${precision})` : 'CURRENT_TIMESTAMP';
}

/** True when the first parenthesised group spans the whole text: "(a + b)" but not "(a) + (b)". */
function isWrapped(text: string): boolean {
  if (!text.startsWith('(')) return false;
  let depth = 0;
  let consumed = 0;
  for (const token of tokenize(text)) {
    consumed += token.text.length;
    if (token.kind !== 'text') continue;
    if (token.text === '(') depth++;
    if (token.text === ')') {
      depth--;
      if (depth === 0) return consumed === text.length;
    }
  }
  return false;
}

/** Undoes MariaDB/MySQL string literal quoting: 'it''s' / 'it\'s' → it's. */
export function unquoteLiteral(literal: string): string {
  const quote = literal[0]!;
  const body = literal.slice(1, -1);
  let out = '';
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    if (ch === '\\' && i + 1 < body.length) {
      const next = body[++i]!;
      const escapes: Record<string, string> = {
        '0': '\0',
        n: '\n',
        r: '\r',
        t: '\t',
        Z: '\x1a',
        b: '\b',
      };
      out += escapes[next] ?? next;
    } else if (ch === quote && body[i + 1] === quote) {
      out += quote;
      i++;
    } else {
      out += ch;
    }
  }
  return out;
}

const NUMERIC_LITERAL = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i;
const BIT_OR_HEX_LITERAL = /^(?:b'[01]*'|0b[01]+|x'[0-9a-f]*'|0x[0-9a-f]+)$/i;
const NUMERIC_TYPE =
  /^(?:tinyint|smallint|mediumint|int|integer|bigint|decimal|numeric|dec|fixed|float|double|real|bit|year|bool|boolean|serial)\b/i;

/**
 * Turns information_schema.COLUMNS.COLUMN_DEFAULT into DEFAULT expression text (schema.ts
 * conventions): string literals quoted, numbers bare, CURRENT_TIMESTAMP bare, other
 * expressions parenthesised, null for "no default" (including an implicit or explicit NULL).
 *
 * MySQL 8 reports literals unquoted and marks expression defaults with DEFAULT_GENERATED in
 * EXTRA; MariaDB (10.2.7+) reports SQL text: quoted literals, bare numbers, `NULL`, functions
 * in lower case.
 */
export function normaliseColumnDefault(
  columnDefault: string | null,
  extra: string,
  columnType: string,
  mariadb: boolean,
): string | null {
  if (columnDefault === null) return null;
  const text = columnDefault.trim();
  if (mariadb) {
    if (text.toUpperCase() === 'NULL') return null;
    if (text.startsWith("'") && text.endsWith("'") && text.length >= 2) {
      return quoteString(unquoteLiteral(text), 'mysql');
    }
    if (NUMERIC_LITERAL.test(text) || BIT_OR_HEX_LITERAL.test(text)) return text;
    return normaliseCurrentTimestamp(text) ?? parenthesise(text);
  }
  if (/\bDEFAULT_GENERATED\b/i.test(extra)) {
    // MySQL shows literals inside expression defaults with backslash-escaped quotes.
    const expression = columnDefault.replace(/\\'/g, "'");
    return normaliseCurrentTimestamp(expression) ?? parenthesise(expression);
  }
  const current = normaliseCurrentTimestamp(text);
  if (current !== undefined) return current;
  if (
    NUMERIC_TYPE.test(columnType) &&
    (NUMERIC_LITERAL.test(text) || BIT_OR_HEX_LITERAL.test(text))
  ) {
    return text;
  }
  if (
    /^(?:binary|varbinary|tinyblob|blob|mediumblob|longblob)/i.test(columnType) &&
    /^0x[0-9a-f]*$/i.test(text)
  ) {
    return text;
  }
  return quoteString(columnDefault, 'mysql');
}

function parenthesise(expression: string): string {
  const trimmed = expression.trim();
  return isWrapped(trimmed) ? trimmed : `(${trimmed})`;
}

/** "DEFAULT_GENERATED on update CURRENT_TIMESTAMP(3)" → "CURRENT_TIMESTAMP(3)". */
export function onUpdateOf(extra: string): string | undefined {
  const match = /\bon update\s+([A-Za-z_]+(?:\s*\(\s*\d*\s*\))?)/i.exec(extra);
  if (!match) return undefined;
  return normaliseCurrentTimestamp(match[1]!) ?? match[1]!;
}
