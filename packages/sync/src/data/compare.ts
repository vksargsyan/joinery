import type { CellValue, ColumnKind, ColumnMeta, Session, SqlDialect } from '@querybara/core';
import { cancelledError, QuerybaraError, newId, rowAt } from '@querybara/core';

import type { CanonicalOptions } from './canonical';
import { compareKeys, compareKind } from './canonical';
import type { MergeSummary, Row, RowDiff } from './merge';
import { columnIndex, mergeSortedRows } from './merge';
import type { KeyRange, SqlQuery, TableRef } from './sql';
import { boundaryQuery, checksumQuery, columnsQuery, rowsQuery } from './sql';

/** A table on each side, paired for data compare (spec §13, data sync step 1). */
export interface TablePair {
  readonly source: TableRef;
  readonly target: TableRef;
  /** Primary or unique NOT NULL key (source names; matched case-insensitively on the target). */
  readonly keyColumns: readonly string[];
  /** Columns to compare; default every source column the target also has. */
  readonly columns?: readonly string[];
  readonly ignoreColumns?: readonly string[];
}

/** Tuning and value rules for a data compare. */
export interface DataCompareOptions {
  readonly canonical?: CanonicalOptions;
  /** Rows per checksum range when walking the key space (default 10 000). */
  readonly chunkRows?: number;
  /** Mismatched ranges are bisected until they hold at most this many rows (default 1 000). */
  readonly streamRows?: number;
  /**
   * Compare server-side checksums before streaming rows. Default: when both sides are the same
   * engine family, whose text forms match; cross-engine compares stream every row and compare
   * canonical values.
   */
  readonly checksums?: boolean;
  /** Rows per fetched page (Session.execute pageSize). */
  readonly pageSize?: number;
  readonly signal?: AbortSignal;
}

/** Totals of one table compare. */
export interface DataCompareSummary extends MergeSummary {
  /** Key ranges checked with checksums, and how many of them matched without streaming. */
  readonly ranges: number;
  readonly matchedRanges: number;
  readonly streamedRanges: number;
  readonly checksums: boolean;
}

/** What `compareTableData` yields while it runs. */
export type DataCompareEvent =
  | {
      readonly type: 'start';
      readonly sourceColumns: readonly ColumnMeta[];
      readonly targetColumns: readonly ColumnMeta[];
      /** Non-key columns compared (source names). */
      readonly compared: readonly string[];
      readonly checksums: boolean;
    }
  | {
      readonly type: 'progress';
      readonly phase: 'checksum' | 'stream';
      readonly ranges: number;
      readonly matchedRanges: number;
      readonly rowsCompared: number;
    }
  | { readonly type: 'diff'; readonly diff: RowDiff }
  | { readonly type: 'done'; readonly summary: DataCompareSummary };

function dialectOf(session: Session): SqlDialect {
  const engine = session.engine;
  if (engine === 'postgres' || engine === 'mysql' || engine === 'mariadb') return engine;
  throw new QuerybaraError({
    code: 'NOT_SUPPORTED',
    message: `Data compare does not support ${engine}`,
  });
}

const family = (dialect: SqlDialect): string => (dialect === 'postgres' ? 'postgres' : 'mysql');

/** A connected side: its session, dialect, table and the columns it selects. */
interface Side {
  readonly session: Session;
  readonly dialect: SqlDialect;
  readonly table: TableRef;
  readonly columns: readonly string[];
  readonly keyColumns: readonly string[];
  readonly keyKinds: readonly ColumnKind[];
}

async function* streamRows(
  side: Side,
  query: SqlQuery,
  options: DataCompareOptions,
): AsyncGenerator<Row> {
  for await (const chunk of side.session.execute(query.text, {
    executionId: newId(),
    params: query.params,
    ...(options.pageSize !== undefined ? { pageSize: options.pageSize } : {}),
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
  })) {
    if (chunk.type === 'rows') {
      for (let r = 0; r < chunk.rowCount; r++) yield rowAt(chunk, r);
    }
  }
}

async function queryAll(
  session: Session,
  query: SqlQuery,
  options: DataCompareOptions,
): Promise<{ columns: ColumnMeta[]; rows: CellValue[][] }> {
  let columns: ColumnMeta[] = [];
  const rows: CellValue[][] = [];
  for await (const chunk of session.execute(query.text, {
    executionId: newId(),
    params: query.params,
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
  })) {
    if (chunk.type === 'columns' && chunk.resultIndex === 0) columns = [...chunk.columns];
    if (chunk.type === 'rows' && chunk.resultIndex === 0) {
      for (let r = 0; r < chunk.rowCount; r++) rows.push(rowAt(chunk, r));
    }
  }
  return { columns, rows };
}

async function checksum(
  side: Side,
  range: KeyRange,
  options: DataCompareOptions,
): Promise<{ count: number; checksum: string }> {
  const query = checksumQuery(side.table, side.columns, side.keyColumns, range, side.dialect);
  const { rows } = await queryAll(side.session, query, options);
  const row = rows[0] ?? [0, ''];
  return { count: Number(row[0] ?? 0), checksum: String(row[1] ?? '') };
}

async function boundary(
  side: Side,
  after: readonly CellValue[] | undefined,
  offset: number,
  options: DataCompareOptions,
): Promise<CellValue[] | undefined> {
  const { rows } = await queryAll(
    side.session,
    boundaryQuery(side.table, side.keyColumns, after, offset, side.dialect),
    options,
  );
  return rows[0];
}

/**
 * Compares one table's data between two sessions (spec §13, data sync steps 2-5): walks the
 * source key space in ranges, compares per-range checksums computed on each server, bisects
 * mismatched ranges until they are small, and streams those rows from both sides in key order
 * through `mergeSortedRows`. Yields a start event, progress, one event per differing row, and
 * a final summary. Runs anywhere a `Session` does: the job runner, querybara-cli and tests.
 *
 * Limitation: both servers must order the key the same way within the range predicates. For
 * integer, UUID, date and binary keys that always holds; string keys need the same collation on
 * both sides (rows are then streamed in binary order, which the merge expects).
 */
export async function* compareTableData(
  sourceSession: Session,
  targetSession: Session,
  pair: TablePair,
  options: DataCompareOptions = {},
): AsyncGenerator<DataCompareEvent, DataCompareSummary, undefined> {
  const check = (): void => {
    if (options.signal?.aborted) throw cancelledError();
  };
  const sourceDialect = dialectOf(sourceSession);
  const targetDialect = dialectOf(targetSession);
  if (pair.keyColumns.length === 0) {
    throw new QuerybaraError({
      code: 'VALIDATION_FAILED',
      message: 'Data compare needs a primary or unique key',
      hint: 'Pick the key columns, or add a primary key to both tables.',
    });
  }
  const [sourceMeta, targetMeta] = [
    (await queryAll(sourceSession, columnsQuery(pair.source, sourceDialect), options)).columns,
    (await queryAll(targetSession, columnsQuery(pair.target, targetDialect), options)).columns,
  ];
  const sourceNames = sourceMeta.map((c) => c.name);
  const targetNames = targetMeta.map((c) => c.name);
  const keyOnTarget = pair.keyColumns.map((k) => targetNames[columnIndex(targetNames, k)]);
  const missing = pair.keyColumns.filter(
    (k, i) => columnIndex(sourceNames, k) === -1 || keyOnTarget[i] === undefined,
  );
  if (missing.length > 0) {
    throw new QuerybaraError({
      code: 'VALIDATION_FAILED',
      message: `Key column ${missing.join(', ')} is missing on one side`,
    });
  }
  const ignored = new Set((pair.ignoreColumns ?? []).map((c) => c.toLowerCase()));
  const keyLower = new Set(pair.keyColumns.map((k) => k.toLowerCase()));
  const compared = (pair.columns ?? sourceNames).filter(
    (c) =>
      !keyLower.has(c.toLowerCase()) &&
      !ignored.has(c.toLowerCase()) &&
      columnIndex(sourceNames, c) !== -1 &&
      columnIndex(targetNames, c) !== -1,
  );
  const sourceColumns = [...pair.keyColumns, ...compared].map(
    (c) => sourceNames[columnIndex(sourceNames, c)]!,
  );
  const targetColumns = [...pair.keyColumns, ...compared].map(
    (c) => targetNames[columnIndex(targetNames, c)]!,
  );
  const kindsOf = (
    meta: readonly ColumnMeta[],
    names: readonly string[],
  ): Record<string, ColumnKind> =>
    Object.fromEntries(names.map((n) => [n, meta.find((m) => m.name === n)?.kind ?? 'string']));
  const sourceKinds = kindsOf(sourceMeta, sourceColumns);
  const targetKinds = kindsOf(targetMeta, targetColumns);
  const keyKinds = pair.keyColumns.map((_k, i) =>
    compareKind(
      sourceKinds[sourceColumns[i]!] ?? 'string',
      targetKinds[targetColumns[i]!] ?? 'string',
    ),
  );
  const source: Side = {
    session: sourceSession,
    dialect: sourceDialect,
    table: pair.source,
    columns: sourceColumns,
    keyColumns: sourceColumns.slice(0, pair.keyColumns.length),
    keyKinds: sourceColumns.slice(0, pair.keyColumns.length).map((c) => sourceKinds[c] ?? 'string'),
  };
  const target: Side = {
    session: targetSession,
    dialect: targetDialect,
    table: pair.target,
    columns: targetColumns,
    keyColumns: targetColumns.slice(0, pair.keyColumns.length),
    keyKinds: targetColumns.slice(0, pair.keyColumns.length).map((c) => targetKinds[c] ?? 'string'),
  };
  const useChecksums = options.checksums ?? family(sourceDialect) === family(targetDialect);
  yield {
    type: 'start',
    sourceColumns: sourceMeta,
    targetColumns: targetMeta,
    compared,
    checksums: useChecksums,
  };

  const totals = { inserts: 0, updates: 0, deletes: 0, equal: 0, sourceRows: 0, targetRows: 0 };
  let ranges = 0;
  let matchedRanges = 0;
  let streamedRanges = 0;
  const mergeOptions = {
    keyColumns: source.keyColumns,
    sourceColumns,
    targetColumns,
    sourceKinds,
    targetKinds,
    ...(options.canonical !== undefined ? { canonical: options.canonical } : {}),
  };

  async function* streamRange(range: KeyRange): AsyncGenerator<DataCompareEvent> {
    streamedRanges++;
    const merge = mergeSortedRows(
      streamRows(
        source,
        rowsQuery(
          source.table,
          source.columns,
          source.keyColumns,
          range,
          source.dialect,
          source.keyKinds,
        ),
        options,
      ),
      streamRows(
        target,
        rowsQuery(
          target.table,
          target.columns,
          target.keyColumns,
          range,
          target.dialect,
          target.keyKinds,
        ),
        options,
      ),
      mergeOptions,
    );
    for (;;) {
      const next = await merge.next();
      if (next.done) {
        const s = next.value;
        totals.inserts += s.inserts;
        totals.updates += s.updates;
        totals.deletes += s.deletes;
        totals.equal += s.equal;
        totals.sourceRows += s.sourceRows;
        totals.targetRows += s.targetRows;
        break;
      }
      yield { type: 'diff', diff: next.value };
    }
    yield {
      type: 'progress',
      phase: 'stream',
      ranges,
      matchedRanges,
      rowsCompared: totals.sourceRows + totals.targetRows,
    };
  }

  const streamRowsLimit = Math.max(1, options.streamRows ?? 1000);
  async function* compareRange(range: KeyRange): AsyncGenerator<DataCompareEvent> {
    check();
    ranges++;
    const [a, b] = await Promise.all([
      checksum(source, range, options),
      checksum(target, range, options),
    ]);
    if (a.count === b.count && a.checksum === b.checksum) {
      matchedRanges++;
      totals.equal += a.count;
      totals.sourceRows += a.count;
      totals.targetRows += b.count;
      yield {
        type: 'progress',
        phase: 'checksum',
        ranges,
        matchedRanges,
        rowsCompared: totals.sourceRows + totals.targetRows,
      };
      return;
    }
    const larger =
      a.count >= b.count ? { side: source, count: a.count } : { side: target, count: b.count };
    if (larger.count <= streamRowsLimit) {
      yield* streamRange(range);
      return;
    }
    // Bisect at the median key of the fuller side.
    const mid = await boundary(larger.side, range.lower, Math.floor(larger.count / 2) - 1, options);
    const splittable =
      mid !== undefined &&
      (range.upper === undefined || compareKeys(mid, range.upper, keyKinds) < 0) &&
      (range.lower === undefined || compareKeys(mid, range.lower, keyKinds) > 0);
    if (!splittable) {
      yield* streamRange(range);
      return;
    }
    yield* compareRange({
      ...(range.lower !== undefined ? { lower: range.lower } : {}),
      upper: mid,
    });
    yield* compareRange({
      lower: mid,
      ...(range.upper !== undefined ? { upper: range.upper } : {}),
    });
  }

  if (!useChecksums) {
    yield* streamRange({});
  } else {
    const chunk = Math.max(1, options.chunkRows ?? 10000);
    let lower: CellValue[] | undefined;
    for (;;) {
      check();
      const upper = await boundary(source, lower, chunk - 1, options);
      const range: KeyRange = {
        ...(lower !== undefined ? { lower } : {}),
        ...(upper !== undefined ? { upper } : {}),
      };
      yield* compareRange(range);
      if (upper === undefined) break;
      lower = upper;
    }
  }

  const summary: DataCompareSummary = {
    ...totals,
    ranges,
    matchedRanges,
    streamedRanges,
    checksums: useChecksums,
  };
  yield { type: 'done', summary };
  return summary;
}
