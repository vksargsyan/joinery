import type { CellValue, ForeignKeyDef, SqlDialect, TableDef } from '@joinery/core';

import type { ColumnInfo } from './columns';
import { and, condition, escapeLike, textMatch, type FilterGroup } from './filter';
import {
  andAll,
  compare,
  ident,
  joinFragments,
  renderQuery,
  tableSql,
  type Fragment,
  type SqlQuery,
  type TableRef,
} from './sql';

/**
 * Foreign keys in the grid (spec §7): click a value to open the referenced row, edit through
 * a lookup dropdown of the referenced table's keys and a label column.
 */

export interface ForeignKeyOptions {
  readonly dialect: SqlDialect;
  /** Schema of the table that owns the foreign key; the referenced table is there too unless
   * the key names `refSchema`. */
  readonly schema?: string;
  /** The referenced table's columns (describeColumns): exact comparisons and the label guess. */
  readonly referencedColumns?: readonly ColumnInfo[];
}

/** The foreign keys that include a column, for the grid to decorate its cells. */
export function foreignKeysOf(table: TableDef, column: string): ForeignKeyDef[] {
  return table.foreignKeys.filter((fk) => fk.columns.includes(column));
}

/** The table a foreign key references. */
export function referencedTable(fk: ForeignKeyDef, schema?: string): TableRef {
  const refSchema = fk.refSchema ?? schema;
  return refSchema === undefined ? { name: fk.refTable } : { schema: refSchema, name: fk.refTable };
}

function refColumn(name: string, options: ForeignKeyOptions): ColumnInfo {
  return (
    options.referencedColumns?.find((c) => c.name === name) ?? {
      name,
      dialect: options.dialect,
      dataType: '',
      kind: 'unknown',
      nullable: true,
      hasDefault: false,
      autoIncrement: false,
      generated: false,
    }
  );
}

export interface ReferencedRowQuery extends SqlQuery {
  readonly table: TableRef;
  /** The same row as a filter, to open the referenced table's grid on it. */
  readonly filter: FilterGroup;
}

/**
 * The row a foreign key value points at. `values` are the referencing row's values of
 * `fk.columns`, in order. Null when any is NULL: with MATCH SIMPLE (the default) the row
 * references nothing.
 */
export function buildReferencedRowQuery(
  fk: ForeignKeyDef,
  values: readonly CellValue[],
  options: ForeignKeyOptions,
): ReferencedRowQuery | null {
  if (values.length !== fk.refColumns.length || values.some((v) => v === null || v === undefined)) {
    return null;
  }
  const { dialect } = options;
  const table = referencedTable(fk, options.schema);
  const where = andAll(
    fk.refColumns.map((name, i) => compare(refColumn(name, options), '=', values[i]!, dialect)),
  );
  const select = options.referencedColumns
    ? options.referencedColumns.map((c) => ident(c.name, dialect)).join(', ')
    : '*';
  return {
    ...renderQuery(
      [`SELECT ${select} FROM ${tableSql(table, dialect)} WHERE `, ...where, ' LIMIT 1'],
      dialect,
    ),
    table,
    filter: and(...fk.refColumns.map((name, i) => condition(name, '=', values[i]!))),
  };
}

const LABEL_NAMES = [
  'name',
  'title',
  'label',
  'display_name',
  'displayname',
  'full_name',
  'fullname',
  'username',
  'user_name',
  'login',
  'email',
  'code',
  'slug',
  'description',
];

/**
 * The column that best describes a row to a person, for lookup dropdowns: a well-known name
 * (name, title, label, email...), then a column ending in "name", then the first text
 * column. Key columns are skipped; null when there is no candidate.
 */
export function guessLabelColumn(
  columns: readonly ColumnInfo[],
  exclude: readonly string[] = [],
): string | null {
  const candidates = columns.filter(
    (c) => !exclude.includes(c.name) && (c.kind === 'string' || c.kind === 'enum'),
  );
  const lower = (c: ColumnInfo): string => c.name.toLowerCase();
  for (const wanted of LABEL_NAMES) {
    const hit = candidates.find((c) => lower(c) === wanted);
    if (hit) return hit.name;
  }
  const named = candidates.find((c) => /name$/.test(lower(c)));
  if (named) return named.name;
  const bounded = candidates.find((c) => c.length !== undefined);
  return (bounded ?? candidates[0])?.name ?? null;
}

export interface LookupOptions extends ForeignKeyOptions {
  /** Text typed into the dropdown: matches the label (contains) or a key (starts with). */
  readonly search?: string;
  /** Rows to list; default 50. */
  readonly limit?: number;
  /** The label column; guessed from `referencedColumns` when left out, none when null. */
  readonly labelColumn?: string | null;
}

export interface LookupQuery extends SqlQuery {
  readonly table: TableRef;
  /** The referenced key columns, in foreign key order: the values to write. */
  readonly keyColumns: readonly string[];
  readonly labelColumn: string | null;
  /** Result columns: the key columns, then the label column. */
  readonly columns: readonly string[];
}

/**
 * Options for a foreign key cell's lookup dropdown: the referenced key columns plus a label,
 * filtered by the search text case-insensitively and ordered by label.
 */
export function buildLookupQuery(fk: ForeignKeyDef, options: LookupOptions): LookupQuery {
  const { dialect } = options;
  const table = referencedTable(fk, options.schema);
  const keyColumns = [...fk.refColumns];
  const labelColumn =
    options.labelColumn !== undefined
      ? options.labelColumn
      : options.referencedColumns
        ? guessLabelColumn(options.referencedColumns, keyColumns)
        : null;
  const columns =
    labelColumn !== null && !keyColumns.includes(labelColumn)
      ? [...keyColumns, labelColumn]
      : keyColumns;
  const limit = Math.max(1, Math.min(10_000, Math.floor(options.limit ?? 50)));
  const search = options.search?.trim() ?? '';
  const where: Fragment[] = [];
  if (search !== '') {
    const escaped = escapeLike(search);
    const matches: Fragment[][] = [];
    const match = (name: string, pattern: string): Fragment[] =>
      textMatch(refColumn(name, options), dialect, pattern, {
        caseSensitive: false,
        negate: false,
        escaped: true,
      });
    if (labelColumn !== null) matches.push(match(labelColumn, `%${escaped}%`));
    for (const name of keyColumns) matches.push(match(name, `${escaped}%`));
    where.push(' WHERE ', ...joinFragments(matches, ' OR '));
  }
  const order = [
    ...(labelColumn !== null ? [labelColumn] : []),
    ...keyColumns.filter((k) => k !== labelColumn),
  ]
    .map((name) => ident(name, dialect))
    .join(', ');
  return {
    ...renderQuery(
      [
        `SELECT ${columns.map((name) => ident(name, dialect)).join(', ')} FROM ${tableSql(table, dialect)}`,
        ...where,
        ` ORDER BY ${order} LIMIT ${limit}`,
      ],
      dialect,
    ),
    table,
    keyColumns,
    labelColumn,
    columns,
  };
}
