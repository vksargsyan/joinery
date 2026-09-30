import type { SqlDialect } from '@joinery/core';

/**
 * Identifier and literal quoting per dialect. MariaDB follows MySQL rules. Callers that build
 * SQL from names or values must go through these helpers, never string concatenation.
 */

export function quoteIdent(name: string, dialect: SqlDialect): string {
  if (dialect === 'postgres') return `"${name.replaceAll('"', '""')}"`;
  return `\`${name.replaceAll('`', '``')}\``;
}

/** Quotes and dot-joins the defined parts: quoteQualified(['public', 'users'], 'postgres'). */
export function quoteQualified(
  parts: readonly (string | undefined | null)[],
  dialect: SqlDialect,
): string {
  return parts
    .filter((part): part is string => part !== undefined && part !== null && part !== '')
    .map((part) => quoteIdent(part, dialect))
    .join('.');
}

const MYSQL_STRING_ESCAPES: Readonly<Record<string, string>> = {
  '\0': '\\0',
  '\n': '\\n',
  '\r': '\\r',
  '\x1a': '\\Z',
  '\\': '\\\\',
  "'": "''",
};

/**
 * A string literal. PostgreSQL assumes standard_conforming_strings = on (the default since 9.1).
 * MySQL and MariaDB assume backslash escapes are enabled (NO_BACKSLASH_ESCAPES off, the default).
 */
export function quoteString(value: string, dialect: SqlDialect): string {
  if (dialect === 'postgres') {
    if (value.includes('\0')) throw new RangeError('PostgreSQL text cannot contain NUL bytes');
    return `'${value.replaceAll("'", "''")}'`;
  }
  // eslint-disable-next-line no-control-regex -- MySQL escapes NUL and Ctrl-Z in literals
  return `'${value.replace(/[\0\n\r\x1a\\']/g, (ch) => MYSQL_STRING_ESCAPES[ch] ?? ch)}'`;
}
