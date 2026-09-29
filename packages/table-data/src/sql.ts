import { JoineryError, type CellValue, type SqlDialect } from '@joinery/core';
import { quoteIdent, quoteQualified, quoteString } from '@joinery/sql-tools';

import { comparedAsText, isSingleFloat, type ColumnInfo } from './columns';
import { isLargeValue, toHex } from './values';

/**
 * Internal SQL assembly. Statements are built as fragments: raw SQL text (only ever produced
 * from quoted identifiers, keywords and checked raw WHERE text) and values. One fragment list
 * renders two ways: with positional parameters (`$n` for PostgreSQL, `?` for MySQL/MariaDB)
 * to run, and with literals for the Apply dialog, so the preview is exactly what runs.
 */

/** A table: `schema` is the PostgreSQL schema, or the MySQL/MariaDB database. */
export interface TableRef {
  readonly schema?: string;
  readonly name: string;
}

/** Statement text and its positional parameters. */
export interface SqlQuery {
  readonly sql: string;
  readonly params: readonly CellValue[];
}

export interface ValueFragment {
  readonly value: CellValue;
}

export type Fragment = string | ValueFragment;

/** A value fragment: a placeholder when run, a literal in previews. */
export const param = (value: CellValue): ValueFragment => ({ value });

/** Joins fragment lists with a separator. */
export function joinFragments(
  parts: readonly (readonly Fragment[])[],
  separator: string,
): Fragment[] {
  const out: Fragment[] = [];
  parts.forEach((part, i) => {
    if (i > 0) out.push(separator);
    out.push(...part);
  });
  return out;
}

/** The fragments as parameterised SQL: `$n` placeholders on PostgreSQL, `?` on MySQL/MariaDB. */
export function renderQuery(fragments: readonly Fragment[], dialect: SqlDialect): SqlQuery {
  const params: CellValue[] = [];
  let sql = '';
  for (const fragment of fragments) {
    if (typeof fragment === 'string') {
      sql += fragment;
    } else {
      if (isLargeValue(fragment.value)) {
        throw new JoineryError({
          code: 'VALIDATION_FAILED',
          message:
            'A large value was only previewed; load it in full before writing or matching it',
        });
      }
      params.push(fragment.value);
      sql += dialect === 'postgres' ? `$${params.length}` : '?';
    }
  }
  return { sql, params };
}

/** The fragments with every value inlined as a literal, for previews and copied SQL. */
export function renderLiterals(fragments: readonly Fragment[], dialect: SqlDialect): string {
  return fragments
    .map((fragment) =>
      typeof fragment === 'string' ? fragment : sqlLiteral(fragment.value, dialect),
    )
    .join('');
}

/**
 * A SQL literal for a cell value: strings through the dialect's quoting, bytes as hex
 * literals, numbers and bigints bare, booleans as TRUE/FALSE. PostgreSQL non-finite floats are
 * quoted ('NaN'), which the column's type coerces; MySQL cannot store them. Large-value
 * previews cannot be written.
 */
export function sqlLiteral(value: CellValue, dialect: SqlDialect): string {
  if (value === null) return 'NULL';
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number') {
    if (Number.isFinite(value)) return Object.is(value, -0) ? '-0' : String(value);
    if (dialect !== 'postgres') {
      throw new JoineryError({
        code: 'NOT_SUPPORTED',
        message: `MySQL and MariaDB cannot store ${String(value)}`,
      });
    }
    return Number.isNaN(value) ? "'NaN'" : value > 0 ? "'Infinity'" : "'-Infinity'";
  }
  if (typeof value === 'string') return quoteString(value, dialect);
  if (value instanceof Uint8Array) {
    return dialect === 'postgres' ? `'\\x${toHex(value)}'::bytea` : `X'${toHex(value)}'`;
  }
  throw new JoineryError({
    code: 'VALIDATION_FAILED',
    message: 'A large value was only previewed; load it in full before writing it',
  });
}

/** The quoted table name, qualified by schema (PostgreSQL) or database (MySQL) when given. */
export function tableSql(table: TableRef, dialect: SqlDialect): string {
  return quoteQualified([table.schema, table.name], dialect);
}

/** A quoted identifier. */
export function ident(name: string, dialect: SqlDialect): string {
  return quoteIdent(name, dialect);
}

function isIntegerText(value: CellValue): boolean {
  return typeof value === 'string' && /^[+-]?\d+$/.test(value.trim());
}

/**
 * The operand for comparing `column` with `value`. PostgreSQL infers the parameter type from
 * the column, so values bind as they are. MySQL and MariaDB compare a string or double
 * operand with an integer or DECIMAL column as DOUBLE (losing digits past 2^53), a FLOAT
 * column as DOUBLE (0.1 never equals 0.1f), and a JSON column only with a JSON operand; the
 * cast makes each comparison exact.
 */
export function operand(
  column: ColumnInfo | undefined,
  value: CellValue,
  dialect: SqlDialect,
): Fragment[] {
  if (dialect === 'postgres' || column === undefined || value === null) return [param(value)];
  const kind = column.kind;
  if ((kind === 'integer' || kind === 'bigint' || kind === 'boolean') && !column.booleanLike) {
    if (typeof value === 'bigint' || isIntegerText(value)) {
      const negative =
        typeof value === 'bigint' ? value < 0n : String(value).trim().startsWith('-');
      return [`CAST(`, param(value), negative ? ' AS SIGNED)' : ' AS UNSIGNED)'];
    }
  }
  if (kind === 'decimal' && typeof value === 'string') {
    const precision = column.precision ?? 65;
    const scale = column.scale ?? 30;
    return [`CAST(`, param(value), ` AS DECIMAL(${precision},${scale}))`];
  }
  if (isSingleFloat(column, dialect) && typeof value === 'number') {
    return ['CAST(', param(value), ' AS FLOAT)'];
  }
  if (kind === 'json' && dialect === 'mysql' && typeof value === 'string') {
    return ['CAST(', param(value), ' AS JSON)'];
  }
  return [param(value)];
}

export type CompareOp = '=' | '<>' | '<' | '<=' | '>' | '>=';

/**
 * `column op value`, NULL-aware for `=` / `<>` (IS [NOT] NULL). `exact` is for matching a row
 * on the values it was loaded with: MySQL string columns then compare with their charset's
 * binary collation and PostgreSQL citext as text, so case-insensitive equality cannot match a
 * different row.
 */
export function compare(
  column: ColumnInfo,
  op: CompareOp,
  value: CellValue,
  dialect: SqlDialect,
  options: { readonly exact?: boolean } = {},
): Fragment[] {
  const name = ident(column.name, dialect);
  if (value === null) {
    if (op === '=') return [`${name} IS NULL`];
    if (op === '<>') return [`${name} IS NOT NULL`];
  }
  if (comparedAsText(column, dialect)) return [`${name}::text ${op} `, param(value)];
  if (
    options.exact &&
    dialect === 'postgres' &&
    /^([\w"]+\.)?citext$/i.test(column.dataType.trim())
  ) {
    return [`${name}::text ${op} `, param(value)];
  }
  if (
    options.exact &&
    dialect !== 'postgres' &&
    column.kind === 'string' &&
    column.charset !== undefined &&
    column.charset !== 'binary' &&
    typeof value === 'string'
  ) {
    return [`${name} COLLATE ${column.charset}_bin ${op} `, param(value)];
  }
  return [`${name} ${op} `, ...operand(column, value, dialect)];
}

/** `AND` of simple conditions (callers parenthesise compound ones); TRUE when empty. */
export function andAll(parts: readonly (readonly Fragment[])[]): Fragment[] {
  if (parts.length === 0) return ['TRUE'];
  return joinFragments(parts, ' AND ');
}
