import type { SqlDialect } from '@querybara/core';
import {
  formatDialect,
  mariadb,
  mysql,
  postgresql,
  type FormatOptionsWithDialect,
} from 'sql-formatter';

import { tokenize } from './lexer';
import { splitStatements } from './splitter';

/** Formatter settings (spec §6: "Formatter (sql-formatter) with per-dialect settings"). */
export interface SqlFormatOptions {
  /** Default 'upper'. Also applies to data types. */
  readonly keywordCase?: 'upper' | 'lower' | 'preserve';
  /** Default 'preserve'. */
  readonly functionCase?: 'upper' | 'lower' | 'preserve';
  /** Spaces per indent level. Default 2. */
  readonly indent?: number;
  readonly useTabs?: boolean;
  /** Blank lines between statements. Default 1. */
  readonly linesBetweenStatements?: number;
  /** Put AND / OR at the start of a line (default) or at the end. */
  readonly logicalOperatorNewline?: 'before' | 'after';
  /** Parenthesised expressions up to this width stay on one line. Default 50. */
  readonly expressionWidth?: number;
}

const DIALECTS = { mysql, mariadb, postgres: postgresql } as const;

/**
 * Formats a script statement by statement with sql-formatter, so MySQL DELIMITER commands,
 * custom delimiters, executable comments and the comments between statements survive untouched.
 * Only whitespace and keyword case change inside a statement; a statement sql-formatter cannot
 * parse is left as written.
 */
export function formatSql(text: string, dialect: SqlDialect, options?: SqlFormatOptions): string {
  const statements = splitStatements(text, dialect);
  if (statements.length === 0) return text;
  const keywordCase = options?.keywordCase ?? 'upper';
  const config: FormatOptionsWithDialect = {
    dialect: DIALECTS[dialect],
    keywordCase,
    dataTypeCase: keywordCase,
    functionCase: options?.functionCase ?? 'preserve',
    identifierCase: 'preserve',
    tabWidth: options?.indent ?? 2,
    useTabs: options?.useTabs ?? false,
    logicalOperatorNewline: options?.logicalOperatorNewline ?? 'before',
    expressionWidth: options?.expressionWidth ?? 50,
    linesBetweenQueries: 0,
    // Querybara's placeholders (spec §6), so sql-formatter keeps `:name` and `$1` intact.
    paramTypes:
      dialect === 'postgres'
        ? { numbered: ['$'], named: [':'] }
        : { positional: true, numbered: ['$'], named: [':'] },
  };
  const separator = '\n'.repeat((options?.linesBetweenStatements ?? 1) + 1);

  const out: string[] = [text.slice(0, statements[0]!.start)];
  statements.forEach((statement, index) => {
    out.push(formatOne(statement.text, config));
    const next = statements[index + 1];
    const gap = text.slice(statement.end, next ? next.start : text.length);
    out.push(normalizeGap(gap, statement.delimiter, dialect, next ? separator : '\n'));
  });
  const result = out.join('');
  return /\r?\n$/.test(text) ? result : result.replace(/\n$/, '');
}

function formatOne(statement: string, config: FormatOptionsWithDialect): string {
  try {
    const formatted = formatDialect(statement, config).trim();
    return formatted.length > 0 ? formatted : statement;
  } catch {
    return statement;
  }
}

/**
 * The text between two statements: whitespace before the delimiter goes, the delimiter stays,
 * and a whitespace-only remainder becomes `separator`. Comments and DELIMITER lines are kept.
 */
function normalizeGap(
  gap: string,
  delimiter: string,
  dialect: SqlDialect,
  separator: string,
): string {
  let head = '';
  let rest = gap;
  const token =
    delimiter === ''
      ? undefined
      : tokenize(gap, dialect, { delimiter }).find((t) => t.kind === 'delimiter');
  if (token) {
    const before = gap.slice(0, token.start);
    head = (/^\s*$/.test(before) ? '' : before) + delimiter;
    rest = gap.slice(token.end);
  }
  return head + (/^\s*$/.test(rest) ? separator : rest);
}
