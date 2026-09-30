import {
  JoineryError,
  cancelledError,
  newId,
  rowAt,
  type CellValue,
  type ColumnMeta,
  type Session,
} from '@joinery/core';

import {
  buildCountQuery,
  buildEstimateQuery,
  parseEstimate,
  type BrowseQuery,
  type FilterOptions,
} from './browse';
import type { SqlQuery } from './sql';

/** One statement's outcome: its first result set and the affected-row count. */
export interface StatementResult {
  readonly columns: readonly ColumnMeta[];
  readonly rows: CellValue[][];
  /** Rows the statement changed; null when the server did not say (SELECT, RETURNING on MariaDB). */
  readonly rowsAffected: number | null;
}

export interface RunOptions {
  readonly signal?: AbortSignal;
}

/** Runs one statement to completion through the Session and collects its first result. */
export async function runQuery(
  session: Session,
  query: SqlQuery,
  options: RunOptions = {},
): Promise<StatementResult> {
  if (options.signal?.aborted) throw cancelledError();
  let columns: readonly ColumnMeta[] = [];
  const rows: CellValue[][] = [];
  let rowsAffected: number | null = null;
  for await (const chunk of session.execute(query.sql, {
    executionId: newId(),
    ...(query.params.length > 0 ? { params: query.params } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  })) {
    if (chunk.type === 'columns' && chunk.resultIndex === 0) columns = chunk.columns;
    else if (chunk.type === 'rows' && chunk.resultIndex === 0) {
      for (let r = 0; r < chunk.rowCount; r++) rows.push(rowAt(chunk, r));
    } else if (chunk.type === 'status' && chunk.rowsAffected !== null) {
      rowsAffected = chunk.rowsAffected;
    }
  }
  return { columns, rows, rowsAffected };
}

export interface FetchedPage {
  /** Rows in display order (reversed pages are turned around). */
  readonly rows: CellValue[][];
  readonly columns: readonly ColumnMeta[];
  /** Fewer rows than the page size came back: there is nothing further in this direction. */
  readonly complete: boolean;
}

/** Runs a browse query and returns its rows in display order. */
export async function fetchPage(
  session: Session,
  query: BrowseQuery,
  options: RunOptions = {},
): Promise<FetchedPage> {
  const result = await runQuery(session, query, options);
  const rows = query.reversed ? result.rows.reverse() : result.rows;
  return { rows, columns: result.columns, complete: rows.length < query.limit };
}

/** The exact number of rows the filter matches (spec §7: total count on demand). */
export async function countRows(
  session: Session,
  options: FilterOptions,
  run: RunOptions = {},
): Promise<number> {
  const result = await runQuery(session, buildCountQuery(options), run);
  const value = result.rows[0]?.[0];
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint' || typeof value === 'string') return Number(value);
  throw new JoineryError({ code: 'INTERNAL', message: 'The server returned no row count' });
}

/**
 * The row estimate shown by default: the catalog statistic, or the planner's estimate when a
 * filter is set or the catalog has none (a table never analysed). Null when neither knows.
 */
export async function estimateRows(
  session: Session,
  options: FilterOptions,
  run: RunOptions = {},
): Promise<number | null> {
  const first = buildEstimateQuery(options);
  const result = await runQuery(session, first, run);
  const estimate = parseEstimate(
    first,
    result.columns.map((c) => c.name),
    result.rows,
  );
  if (estimate !== null || first.source === 'pg-explain' || first.source === 'mysql-explain') {
    return estimate;
  }
  const planner = buildEstimateQuery({ ...options, method: 'explain' });
  const fallback = await runQuery(session, planner, run);
  return parseEstimate(
    planner,
    fallback.columns.map((c) => c.name),
    fallback.rows,
  );
}
