import { QuerybaraError, type CellValue, type SqlDialect } from '@querybara/core';

import { formatCell } from './cells';
import type { ColumnInfo } from './columns';
import type { RowIdentity } from './identity';
import {
  andAll,
  compare,
  ident,
  joinFragments,
  param,
  renderLiterals,
  tableSql,
  type Fragment,
  type TableRef,
} from './sql';
import { isDefault, isLargeValue, type EditValue } from './values';

/**
 * Copy selected rows (spec §7) as TSV (what Excel and Google Sheets paste), CSV (RFC 4180),
 * JSON, a Markdown table, or INSERT / UPDATE statements for the table.
 */

export const COPY_FORMATS = ['tsv', 'csv', 'json', 'markdown', 'insert', 'update'] as const;
export type CopyFormat = (typeof COPY_FORMATS)[number];

export interface CopyOptions {
  /** Dialect and table for INSERT / UPDATE statements. */
  readonly dialect?: SqlDialect;
  readonly table?: TableRef;
  /** UPDATE statements find rows by these columns, which must be among those copied. */
  readonly identity?: RowIdentity;
  /** A header row: default false for TSV, true for CSV (Markdown always has one). */
  readonly header?: boolean;
  /** Text for NULL in TSV, CSV and Markdown: '' by default ("NULL" in Markdown). */
  readonly nullText?: string;
}

function text(value: EditValue, nullText: string): string {
  if (value === null) return nullText;
  return formatCell(value);
}

/** Quoted only when it must be: a tab or line break inside, or a leading quote. */
function tsvCell(value: string): string {
  return /[\t\n\r]/.test(value) || value.startsWith('"')
    ? `"${value.replaceAll('"', '""')}"`
    : value;
}

function csvCell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

function markdownCell(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/\|/g, '\\|')
    .replace(/\r?\n|\r/g, '<br>');
}

const NUMERIC = new Set(['integer', 'bigint', 'decimal', 'float']);
const JSON_NUMBER = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?$/;

/** One cell as JSON text: numbers and decimals as numbers, JSON documents embedded. */
function jsonValue(value: CellValue, column: ColumnInfo): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number')
    return Number.isFinite(value) ? String(value) : JSON.stringify(String(value));
  if (typeof value === 'string') {
    if (column.kind === 'decimal' && JSON_NUMBER.test(value)) return value;
    if (column.kind === 'json') {
      try {
        JSON.parse(value);
        return value.trim();
      } catch {
        return JSON.stringify(value);
      }
    }
    return JSON.stringify(value);
  }
  return JSON.stringify(formatCell(value));
}

function requireSql(
  options: CopyOptions,
  format: string,
): { dialect: SqlDialect; table: TableRef } {
  if (options.dialect === undefined || options.table === undefined) {
    throw new QuerybaraError({
      code: 'VALIDATION_FAILED',
      message: `Copy as ${format} needs the dialect and the table`,
    });
  }
  return { dialect: options.dialect, table: options.table };
}

function literal(value: EditValue): Fragment[] {
  if (isDefault(value)) return ['DEFAULT'];
  if (isLargeValue(value)) {
    throw new QuerybaraError({
      code: 'VALIDATION_FAILED',
      message: 'A large value was only previewed; load it in full before copying it as SQL',
    });
  }
  return [param(value)];
}

/**
 * The rows as text in `format`. `rows[r][c]` is the value of `columns[c]`; DEFAULT cells (of
 * rows not inserted yet) are empty in text formats, left out of JSON, and DEFAULT in SQL.
 * Generated columns are left out of INSERT and UPDATE statements.
 */
export function copyRows(
  rows: readonly (readonly EditValue[])[],
  columns: readonly ColumnInfo[],
  format: CopyFormat,
  options: CopyOptions = {},
): string {
  switch (format) {
    case 'tsv':
    case 'csv': {
      const nullText = options.nullText ?? '';
      const cell = format === 'tsv' ? tsvCell : csvCell;
      const separator = format === 'tsv' ? '\t' : ',';
      const lines = rows.map((row) =>
        columns.map((_c, i) => cell(text(row[i] ?? null, nullText))).join(separator),
      );
      if (options.header ?? format === 'csv') {
        lines.unshift(columns.map((c) => cell(c.name)).join(separator));
      }
      return lines.join(format === 'tsv' ? '\n' : '\r\n');
    }
    case 'markdown': {
      const nullText = options.nullText ?? 'NULL';
      const line = (cells: readonly string[]): string => `| ${cells.join(' | ')} |`;
      return [
        line(columns.map((c) => markdownCell(c.name))),
        line(columns.map((c) => (NUMERIC.has(c.kind) ? '---:' : '---'))),
        ...rows.map((row) =>
          line(columns.map((_c, i) => markdownCell(text(row[i] ?? null, nullText)))),
        ),
      ].join('\n');
    }
    case 'json': {
      const objects = rows.map((row) => {
        const members = columns
          .map((column, i) => {
            const value = row[i] ?? null;
            if (isDefault(value)) return undefined;
            return `${JSON.stringify(column.name)}: ${jsonValue(value, column)}`;
          })
          .filter((member): member is string => member !== undefined);
        return members.length === 0 ? '  {}' : `  {\n    ${members.join(',\n    ')}\n  }`;
      });
      return objects.length === 0 ? '[]' : `[\n${objects.join(',\n')}\n]`;
    }
    case 'insert': {
      const { dialect, table } = requireSql(options, 'INSERT');
      const writable = columns.map((c, i) => [c, i] as const).filter(([c]) => !c.generated);
      const head = `INSERT INTO ${tableSql(table, dialect)} (${writable.map(([c]) => ident(c.name, dialect)).join(', ')}) VALUES (`;
      return rows
        .map(
          (row) =>
            `${renderLiterals(
              [
                head,
                ...joinFragments(
                  writable.map(([, i]) => literal(row[i] ?? null)),
                  ', ',
                ),
                ')',
              ],
              dialect,
            )};`,
        )
        .join('\n');
    }
    case 'update': {
      const { dialect, table } = requireSql(options, 'UPDATE');
      const identity = options.identity;
      if (identity === undefined || identity.kind === 'none') {
        throw new QuerybaraError({
          code: 'VALIDATION_FAILED',
          message: 'Copy as UPDATE needs a primary key, a unique key or matching on all columns',
        });
      }
      const position = new Map(columns.map((c, i) => [c.name, i]));
      const missing = identity.columns.filter((name) => !position.has(name));
      if (missing.length > 0 && identity.kind !== 'all-columns') {
        throw new QuerybaraError({
          code: 'VALIDATION_FAILED',
          message: `Copy as UPDATE needs the key column${missing.length === 1 ? '' : 's'} ${missing.join(', ')} in the selection`,
        });
      }
      const keyColumns = identity.columns.filter((name) => position.has(name));
      const sets = columns
        .map((c, i) => [c, i] as const)
        .filter(([c]) => !c.generated && !keyColumns.includes(c.name));
      if (sets.length === 0) {
        throw new QuerybaraError({
          code: 'VALIDATION_FAILED',
          message: 'Copy as UPDATE needs at least one column besides the key',
        });
      }
      const limit = identity.kind === 'all-columns' && dialect !== 'postgres' ? ' LIMIT 1' : '';
      return rows
        .map((row) => {
          const where = andAll(
            keyColumns.map((name) => {
              const at = position.get(name)!;
              const value = row[at] ?? null;
              if (isDefault(value) || isLargeValue(value)) {
                throw new QuerybaraError({
                  code: 'VALIDATION_FAILED',
                  message: `Copy as UPDATE needs the loaded value of ${name}`,
                });
              }
              return compare(columns[at]!, '=', value, dialect);
            }),
          );
          const fragments: Fragment[] = [
            `UPDATE ${tableSql(table, dialect)} SET `,
            ...joinFragments(
              sets.map(([c, i]) => [`${ident(c.name, dialect)} = `, ...literal(row[i] ?? null)]),
              ', ',
            ),
            ' WHERE ',
            ...where,
            limit,
          ];
          return `${renderLiterals(fragments, dialect)};`;
        })
        .join('\n');
    }
  }
}
