import { QuerybaraError, type CellValue, type SqlDialect } from '@querybara/core';

import { canSort, type ColumnInfo } from './columns';
import { compileFilter, type FilterNode } from './filter';
import type { RowIdentity } from './identity';
import {
  defaultNullsFirst,
  keysetBlocker,
  keysetPredicate,
  keysetSql,
  reverseTerms,
  type KeysetTerm,
} from './keyset';
import { rawWhereSql } from './raw-where';
import {
  ident,
  joinFragments,
  param,
  renderQuery,
  tableSql,
  type Fragment,
  type SqlQuery,
  type TableRef,
} from './sql';

/**
 * Queries behind the table data grid (spec §7): one page of rows with server-side filter and
 * sort, the exact row count on demand, and the row estimate shown by default.
 */

export interface SortTerm {
  readonly column: string;
  readonly direction: 'asc' | 'desc';
  /** Where NULLs go; the engine's default when left out (see keyset.ts). */
  readonly nulls?: 'first' | 'last';
}

/**
 * Which page to read. Keyset pages continue from the order key of a loaded row
 * (`BrowseQuery.keyIndexes` picks it out; `pageAfter` / `pageBefore` build these). `last` and
 * `before` read backwards and come back reversed. `offset` works in either paging mode.
 */
export type BrowsePage =
  | { readonly kind: 'first' }
  | { readonly kind: 'last' }
  | { readonly kind: 'after'; readonly key: readonly CellValue[] }
  | { readonly kind: 'before'; readonly key: readonly CellValue[] }
  | { readonly kind: 'offset'; readonly offset: number };

export interface FilterOptions {
  readonly dialect: SqlDialect;
  readonly table: TableRef;
  /** The table's columns (describeColumns): types for operands, names for validation. */
  readonly columns: readonly ColumnInfo[];
  readonly filter?: FilterNode;
  /** A condition typed by the user, checked by `checkRawWhere` and ANDed in verbatim. */
  readonly rawWhere?: string;
}

export interface BrowseOptions extends FilterOptions {
  readonly identity: RowIdentity;
  /** Columns to read, in order; all of `columns` when left out. */
  readonly select?: readonly string[];
  readonly sort?: readonly SortTerm[];
  readonly page?: BrowsePage;
  /** Rows per page. */
  readonly limit: number;
}

export interface BrowseQuery extends SqlQuery {
  /**
   * Result columns in order: the selected ones, then any order-key or identity columns that
   * were not selected (the grid needs them for paging and editing; hide them).
   */
  readonly columns: readonly string[];
  readonly paging: 'keyset' | 'offset';
  /** Why keyset paging was not possible, when it was not. */
  readonly offsetReason?: string;
  /** Positions in `columns` of the order key: sort columns, then identity columns. */
  readonly keyIndexes: readonly number[];
  /** Positions in `columns` of the identity columns (for `rowKeyAt`). */
  readonly identityIndexes: readonly number[];
  /** Rows arrive in reverse display order (`last`, `before`): reverse them. */
  readonly reversed: boolean;
  readonly limit: number;
}

const MAX_LIMIT = 1_000_000;

function fail(message: string): never {
  throw new QuerybaraError({ code: 'VALIDATION_FAILED', message });
}

function columnMap(columns: readonly ColumnInfo[]): Map<string, ColumnInfo> {
  return new Map(columns.map((c) => [c.name, c]));
}

/** The WHERE conditions of the filter and raw condition, each ready to AND together. */
function whereParts(options: FilterOptions): Fragment[][] {
  const parts: Fragment[][] = [];
  const compiled = compileFilter(options.filter, options.columns, options.dialect);
  if (compiled) parts.push(compiled.compound ? ['(', ...compiled.sql, ')'] : compiled.sql);
  if (options.rawWhere !== undefined && options.rawWhere.trim() !== '') {
    parts.push([rawWhereSql(options.rawWhere, options.dialect)]);
  }
  return parts;
}

function whereClause(parts: readonly Fragment[][]): Fragment[] {
  return parts.length === 0 ? [] : [' WHERE ', ...joinFragments(parts, ' AND ')];
}

interface OrderTerm extends KeysetTerm {
  readonly column: ColumnInfo;
}

function orderSql(terms: readonly OrderTerm[], dialect: SqlDialect): string {
  const items: string[] = [];
  for (const term of terms) {
    const name = ident(term.column.name, dialect);
    const direction = term.descending ? 'DESC' : 'ASC';
    const nonDefault =
      term.nullable && term.nullsFirst !== defaultNullsFirst(dialect, term.descending);
    if (!nonDefault) items.push(`${name} ${direction}`);
    else if (dialect === 'postgres')
      items.push(`${name} ${direction} NULLS ${term.nullsFirst ? 'FIRST' : 'LAST'}`);
    else items.push(`${name} IS NULL ${term.nullsFirst ? 'DESC' : 'ASC'}`, `${name} ${direction}`);
  }
  return items.length === 0 ? '' : ` ORDER BY ${items.join(', ')}`;
}

/**
 * One page of table rows: filter, raw condition, sort and page, parameterised. With a primary
 * or unique key identity the order ends with the key columns and pages continue by keyset;
 * otherwise (no key, the all-columns identity, or a sort column keyset cannot compare) pages
 * use OFFSET, and the result says why in `offsetReason`.
 */
export function buildBrowseQuery(options: BrowseOptions): BrowseQuery {
  const { dialect, identity } = options;
  const limit = options.limit;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT)
    fail(`The page size must be a whole number from 1 to ${MAX_LIMIT}`);
  const byName = columnMap(options.columns);
  const lookup = (name: string, what: string): ColumnInfo =>
    byName.get(name) ?? fail(`Unknown ${what} column ${name}`);

  const select = (options.select ?? options.columns.map((c) => c.name)).map((name) =>
    lookup(name, 'selected'),
  );
  const terms: OrderTerm[] = [];
  const seen = new Set<string>();
  for (const sort of options.sort ?? []) {
    const column = lookup(sort.column, 'sort');
    if (!canSort(column, dialect)) fail(`Cannot sort by ${column.name} (${column.dataType})`);
    if (seen.has(column.name)) continue;
    seen.add(column.name);
    const descending = sort.direction === 'desc';
    terms.push({
      column,
      descending,
      nullable: column.nullable,
      nullsFirst:
        sort.nulls === undefined ? defaultNullsFirst(dialect, descending) : sort.nulls === 'first',
    });
  }
  const keyed = identity.kind === 'primary-key' || identity.kind === 'unique';
  const identityColumns = identity.columns.map((name) => lookup(name, 'identity'));
  if (keyed) {
    for (const column of identityColumns) {
      if (seen.has(column.name)) continue;
      seen.add(column.name);
      terms.push({
        column,
        descending: false,
        nullable: column.nullable,
        nullsFirst: defaultNullsFirst(dialect, false),
      });
    }
  }

  let offsetReason: string | undefined;
  if (!keyed) {
    offsetReason =
      identity.kind === 'all-columns'
        ? 'Rows are matched on every column, which is not unique'
        : 'The table has no primary or unique key';
  } else {
    for (const term of terms) {
      offsetReason = keysetBlocker(term.column, dialect);
      if (offsetReason !== undefined) break;
    }
  }
  const paging = offsetReason === undefined ? 'keyset' : 'offset';

  const page = options.page ?? { kind: 'first' };
  const reversed = page.kind === 'last' || page.kind === 'before';
  if (paging === 'offset' && (page.kind === 'after' || page.kind === 'before'))
    fail(`Keyset pages are not available here (${offsetReason}); page by offset`);
  if (paging === 'offset' && page.kind === 'last')
    fail('The last page needs keyset paging; count the rows and page by offset');

  const orderTerms: OrderTerm[] = reversed
    ? reverseTerms(terms).map((t, i) => ({ ...t, column: terms[i]!.column }))
    : terms;
  const parts = whereParts(options);
  if (page.kind === 'after' || page.kind === 'before') {
    if (page.key.length !== terms.length)
      fail(`A keyset page needs ${terms.length} key values, got ${page.key.length}`);
    const predicate = keysetPredicate(orderTerms, page.key, { rowCompare: dialect === 'postgres' });
    const sql = keysetSql(
      predicate,
      terms.map((t) => t.column),
      dialect,
    );
    parts.push(predicate.type === 'or' || predicate.type === 'and' ? ['(', ...sql, ')'] : sql);
  }

  const resultColumns = select.map((c) => c.name);
  const include = (name: string): number => {
    const at = resultColumns.indexOf(name);
    if (at >= 0) return at;
    resultColumns.push(name);
    return resultColumns.length - 1;
  };
  const keyIndexes = terms.map((t) => include(t.column.name));
  const identityIndexes = identity.columns.map((name) => include(name));

  const fragments: Fragment[] = [
    `SELECT ${resultColumns.map((name) => ident(name, dialect)).join(', ')} FROM ${tableSql(options.table, dialect)}`,
    ...whereClause(parts),
    orderSql(orderTerms, dialect),
    ` LIMIT ${limit}`,
  ];
  if (page.kind === 'offset') {
    if (!Number.isInteger(page.offset) || page.offset < 0)
      fail('The offset must be a whole number');
    if (page.offset > 0) fragments.push(` OFFSET ${page.offset}`);
  }
  const query = renderQuery(fragments, dialect);
  return {
    ...query,
    columns: resultColumns,
    paging,
    ...(offsetReason !== undefined ? { offsetReason } : {}),
    keyIndexes,
    identityIndexes,
    reversed,
    limit,
  };
}

function keyOf(query: BrowseQuery, row: readonly CellValue[]): CellValue[] {
  return query.keyIndexes.map((i) => row[i] ?? null);
}

/** The page after a row of `query` (the last row shown, in display order). */
export function pageAfter(query: BrowseQuery, row: readonly CellValue[]): BrowsePage {
  return { kind: 'after', key: keyOf(query, row) };
}

/** The page before a row of `query` (the first row shown, in display order). */
export function pageBefore(query: BrowseQuery, row: readonly CellValue[]): BrowsePage {
  return { kind: 'before', key: keyOf(query, row) };
}

/** The exact number of rows the filter matches. */
export function buildCountQuery(options: FilterOptions): SqlQuery {
  return renderQuery(
    [
      `SELECT count(*) AS ${ident('count', options.dialect)} FROM ${tableSql(options.table, options.dialect)}`,
      ...whereClause(whereParts(options)),
    ],
    options.dialect,
  );
}

/**
 * How `parseEstimate` reads the estimate query's result: a catalog statistic (PostgreSQL
 * `pg_class`, MySQL `information_schema.TABLES.TABLE_ROWS`) or the planner's estimate
 * (EXPLAIN), used when a filter is set.
 */
export type EstimateSource = 'pg-class' | 'pg-explain' | 'mysql-table-rows' | 'mysql-explain';

export interface EstimateQuery extends SqlQuery {
  readonly source: EstimateSource;
}

/**
 * A cheap row count estimate. Without a filter it reads the catalog: PostgreSQL scales
 * `reltuples` by the table's current size the way the planner does (null when the table was
 * never analysed); MySQL/MariaDB read TABLE_ROWS (InnoDB's estimate, which MySQL caches for
 * `information_schema_stats_expiry`). With a filter, or with `method: 'explain'`, it asks the
 * planner: PostgreSQL EXPLAIN's top "Plan Rows", MySQL/MariaDB EXPLAIN rows × filtered.
 */
export function buildEstimateQuery(
  options: FilterOptions & { readonly method?: 'catalog' | 'explain' },
): EstimateQuery {
  const { dialect, table } = options;
  const parts = whereParts(options);
  const method = options.method ?? (parts.length > 0 ? 'explain' : 'catalog');
  if (method === 'explain') {
    const select: Fragment[] = [`SELECT 1 FROM ${tableSql(table, dialect)}`, ...whereClause(parts)];
    if (dialect === 'postgres') {
      return {
        ...renderQuery(['EXPLAIN (FORMAT JSON) ', ...select], dialect),
        source: 'pg-explain',
      };
    }
    // MySQL 9 defaults to the TREE format, which has no rows and filtered columns.
    const explain = dialect === 'mysql' ? 'EXPLAIN FORMAT=TRADITIONAL ' : 'EXPLAIN ';
    return { ...renderQuery([explain, ...select], dialect), source: 'mysql-explain' };
  }
  if (dialect === 'postgres') {
    return {
      ...renderQuery(
        [
          'SELECT CASE WHEN c.reltuples < 0 OR c.relpages = 0 THEN NULL ELSE ' +
            '(c.reltuples / c.relpages * (pg_catalog.pg_relation_size(c.oid) / ' +
            "pg_catalog.current_setting('block_size')::float8))::bigint END AS estimate " +
            'FROM pg_catalog.pg_class c WHERE c.oid = CAST(',
          param(tableSql(table, dialect)),
          ' AS regclass)',
        ],
        dialect,
      ),
      source: 'pg-class',
    };
  }
  const schema: Fragment[] = table.schema === undefined ? ['DATABASE()'] : [param(table.schema)];
  return {
    ...renderQuery(
      [
        'SELECT TABLE_ROWS AS estimate FROM information_schema.TABLES WHERE TABLE_SCHEMA = ',
        ...schema,
        ' AND TABLE_NAME = ',
        param(table.name),
      ],
      dialect,
    ),
    source: 'mysql-table-rows',
  };
}

function toCount(value: CellValue | undefined): number | null {
  if (typeof value === 'number')
    return Number.isFinite(value) ? Math.max(0, Math.round(value)) : null;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value)))
    return Math.max(0, Math.round(Number(value)));
  return null;
}

/**
 * The estimate from an estimate query's first result: `columns` are its column names, `rows`
 * its rows. Null when the server has no estimate (a never-analysed PostgreSQL table).
 */
export function parseEstimate(
  query: EstimateQuery,
  columns: readonly string[],
  rows: readonly (readonly CellValue[])[],
): number | null {
  const first = rows[0];
  if (first === undefined) return null;
  switch (query.source) {
    case 'pg-class':
    case 'mysql-table-rows':
      return toCount(first[0]);
    case 'pg-explain': {
      const cell = first[0];
      if (typeof cell !== 'string') return null;
      try {
        const plan = JSON.parse(cell) as { Plan?: { 'Plan Rows'?: unknown } }[];
        return toCount(plan[0]?.Plan?.['Plan Rows'] as CellValue | undefined);
      } catch {
        return null;
      }
    }
    case 'mysql-explain': {
      const lower = columns.map((c) => c.toLowerCase());
      const rowsAt = lower.indexOf('rows');
      const filteredAt = lower.indexOf('filtered');
      const estimate = toCount(first[rowsAt]);
      if (estimate === null) return null;
      const filtered = filteredAt >= 0 ? Number(first[filteredAt]) : 100;
      return Math.round((estimate * (Number.isFinite(filtered) ? filtered : 100)) / 100);
    }
  }
}
