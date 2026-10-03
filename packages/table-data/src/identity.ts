import type { CellValue, SqlDialect, TableDef } from '@querybara/core';

import { describeColumns, type ColumnInfo } from './columns';
import { isLargeValue, toHex } from './values';

/**
 * How a loaded row is found again to update or delete it (spec §7: editing needs a primary or
 * unique key; without one the grid is read-only unless the user accepts matching on every
 * column, with a warning).
 */
export interface RowIdentity {
  readonly kind: 'primary-key' | 'unique' | 'all-columns' | 'none';
  /** Columns whose loaded values find the row; empty for `none`. */
  readonly columns: readonly string[];
  /** Constraint or index name, for primary-key and unique identities. */
  readonly name?: string;
  /** `all-columns` only: what the user must accept before editing. */
  readonly warning?: string;
  /** `all-columns` only: columns whose values may not match exactly, and why. */
  readonly unreliable?: readonly UnreliableColumn[];
}

export interface UnreliableColumn {
  readonly column: string;
  readonly reason: string;
}

/** A row's identity values encoded as one string: stable, comparable, usable as a map key. */
export type RowKey = string;

/** Whether rows can be updated and deleted through this identity. */
export function canEdit(identity: RowIdentity): boolean {
  return identity.kind !== 'none';
}

/**
 * The identity to edit a table's rows with: the primary key, else the best unique key whose
 * columns are all NOT NULL (plain columns only: no expression or partial indexes, which do not
 * make rows unique), preferring fewer columns. Otherwise `none`: offer `allColumnsIdentity`.
 */
export function rowIdentity(table: TableDef): RowIdentity {
  if (table.primaryKey) {
    return { kind: 'primary-key', name: table.primaryKey.name, columns: table.primaryKey.columns };
  }
  const notNull = new Set(table.columns.filter((c) => !c.nullable).map((c) => c.name));
  const candidates: { name: string; columns: string[] }[] = table.uniques.map((u) => ({
    name: u.name,
    columns: [...u.columns],
  }));
  for (const index of table.indexes) {
    if (!index.unique || index.where !== undefined) continue;
    if (index.columns.some((part) => part.name === null || part.expression !== undefined)) continue;
    candidates.push({ name: index.name, columns: index.columns.map((part) => part.name!) });
  }
  const usable = candidates
    .filter((c) => c.columns.length > 0 && c.columns.every((name) => notNull.has(name)))
    .sort((a, b) => a.columns.length - b.columns.length || a.name.localeCompare(b.name));
  const best = usable[0];
  if (best) return { kind: 'unique', name: best.name, columns: best.columns };
  return { kind: 'none', columns: [] };
}

function unreliableReason(column: ColumnInfo, dialect: SqlDialect | undefined): string | undefined {
  switch (column.kind) {
    case 'float':
      return 'floating-point values may not compare equal to what was loaded';
    case 'json':
      return 'JSON is compared as a document, and may differ from what was loaded';
    case 'binary':
      return 'binary values may be loaded as previews, which cannot be matched';
    case 'geometry':
      return dialect === 'postgres'
        ? 'geometry is compared by its text form'
        : 'geometry cannot be compared, so it is left out of the match';
    default:
      return /text$|clob$/i.test(column.dataType)
        ? 'long text may be loaded as a preview, which cannot be matched'
        : undefined;
  }
}

/** Column facts; without a dialect, each type is read as PostgreSQL, else as MySQL. */
function columnsOf(table: TableDef, dialect: SqlDialect | undefined): ColumnInfo[] {
  if (dialect !== undefined) return describeColumns(table, { dialect });
  const mysql = describeColumns(table, { dialect: 'mysql' });
  return describeColumns(table, { dialect: 'postgres' }).map((column, i) =>
    column.kind === 'unknown' ? (mysql[i] ?? column) : column,
  );
}

/**
 * Matching on every column, for tables without a usable key. Rows are found by the values
 * they were loaded with; identical rows are indistinguishable (one of them is changed), and
 * floating-point, JSON, binary and long text values can make the match miss, which the
 * warning says. MySQL geometry cannot be compared and is left out.
 */
export function allColumnsIdentity(
  table: TableDef,
  options: { readonly dialect?: SqlDialect } = {},
): RowIdentity {
  const dialect = options.dialect;
  const columns = columnsOf(table, dialect);
  const unreliable: UnreliableColumn[] = [];
  const used: string[] = [];
  for (const column of columns) {
    const reason = unreliableReason(column, dialect);
    if (reason !== undefined) unreliable.push({ column: column.name, reason });
    if (!(column.kind === 'geometry' && dialect !== undefined && dialect !== 'postgres')) {
      used.push(column.name);
    }
  }
  const details = unreliable.map((u) => `${u.column}: ${u.reason}`).join('; ');
  const warning =
    'This table has no primary key or unique key, so rows are matched on the values of every ' +
    'column. If several rows are identical, only one of them is changed.' +
    (details ? ` Some columns may not match exactly (${details}).` : '');
  return { kind: 'all-columns', columns: used, warning, unreliable };
}

function encodeValue(value: CellValue): string {
  if (value === null) return 'N';
  if (typeof value === 'boolean') return value ? 'T' : 'F';
  if (typeof value === 'bigint') return `n${value.toString()}`;
  if (typeof value === 'number') {
    return `n${Number.isInteger(value) && !Object.is(value, -0) ? BigInt(value).toString() : String(value)}`;
  }
  if (typeof value === 'string') return `s${value.length}:${value}`;
  if (value instanceof Uint8Array) return `x${toHex(value)}`;
  if (isLargeValue(value)) return `h${value.$handle.length}:${value.$handle}`;
  return 'N';
}

/**
 * The key of a loaded row: its identity values, type-tagged and length-prefixed so different
 * values never collide (NULL, '' and 'NULL' differ; 5 and 5n are the same row). Null for an
 * identity of kind `none`.
 */
export function rowKeyOf(
  identity: RowIdentity,
  values: Readonly<Record<string, CellValue>>,
): RowKey | null {
  if (identity.kind === 'none') return null;
  return identity.columns.map((name) => encodeValue(values[name] ?? null)).join('|');
}

/** `rowKeyOf` for a row array whose columns are named by `columns`. */
export function rowKeyAt(
  identity: RowIdentity,
  columns: readonly string[],
  row: readonly CellValue[],
): RowKey | null {
  if (identity.kind === 'none') return null;
  const record: Record<string, CellValue> = {};
  columns.forEach((name, i) => {
    record[name] = row[i] ?? null;
  });
  return rowKeyOf(identity, record);
}

/** Keys of rows staged for insert: never equal to a loaded row's key. */
export function isInsertKey(key: RowKey): boolean {
  return key.startsWith('+');
}

function displayValue(value: CellValue | undefined): string {
  if (value === undefined || value === null) return 'NULL';
  if (typeof value === 'string') {
    const short = value.length > 40 ? `${value.slice(0, 40)}…` : value;
    return `'${short.replaceAll("'", "''")}'`;
  }
  if (value instanceof Uint8Array)
    return `0x${toHex(value.subarray(0, 16))}${value.length > 16 ? '…' : ''}`;
  if (isLargeValue(value)) return `'${value.preview.slice(0, 40)}…'`;
  return String(value);
}

/** "id = 5" or "region = 'eu', id = 7": names a row in messages. */
export function describeRow(
  identity: RowIdentity,
  values: Readonly<Record<string, CellValue>>,
): string {
  const columns = identity.kind === 'none' ? [] : identity.columns;
  const shown = identity.kind === 'all-columns' ? columns.slice(0, 4) : columns;
  const text = shown.map((name) => `${name} = ${displayValue(values[name])}`).join(', ');
  return shown.length < columns.length ? `${text}, …` : text;
}
