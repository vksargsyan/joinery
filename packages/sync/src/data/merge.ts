import type { CellValue, ColumnKind } from '@joinery/core';
import { JoineryError } from '@joinery/core';

import type { CanonicalOptions } from './canonical';
import { compareKeys, compareKind, valuesEqual } from './canonical';

/** One row as the server returned it, in the order of its side's column list. */
export type Row = readonly CellValue[];

/** What the target needs for one key. */
export type RowAction = 'insert' | 'update' | 'delete';

/** How one key differs (spec §13, data sync step 5). */
export interface RowDiff {
  readonly action: RowAction;
  /** Key values (source side for inserts and updates, target side for deletes). */
  readonly key: readonly CellValue[];
  /** Updates: the compared columns whose values differ. */
  readonly changedColumns?: readonly string[];
  /** In the source's column order; present for inserts and updates. */
  readonly sourceRow?: Row;
  /** In the target's column order; present for updates and deletes. */
  readonly targetRow?: Row;
}

/** Row counts of a merge; `equal` counts keys whose compared values match. */
export interface MergeSummary {
  readonly inserts: number;
  readonly updates: number;
  readonly deletes: number;
  readonly equal: number;
  readonly sourceRows: number;
  readonly targetRows: number;
}

/** Column lists, kinds and rules for merging two row streams. */
export interface MergeOptions {
  /** Key columns, by source name; they must also exist on the target side. */
  readonly keyColumns: readonly string[];
  readonly sourceColumns: readonly string[];
  readonly targetColumns: readonly string[];
  /** Columns to compare (default: every source column the target also has). */
  readonly compareColumns?: readonly string[];
  readonly ignoreColumns?: readonly string[];
  /** ColumnMeta.kind per column name, per side; missing columns compare as strings. */
  readonly sourceKinds?: Readonly<Record<string, ColumnKind>>;
  readonly targetKinds?: Readonly<Record<string, ColumnKind>>;
  readonly canonical?: CanonicalOptions;
}

/** Finds a column by exact name, then case-insensitively (engines differ in name case). */
export function columnIndex(columns: readonly string[], name: string): number {
  const exact = columns.indexOf(name);
  if (exact !== -1) return exact;
  const lower = name.toLowerCase();
  return columns.findIndex((c) => c.toLowerCase() === lower);
}

/** Resolved key positions, key comparison kinds and compared column pairs. */
export interface MergePlan {
  readonly sourceKey: readonly number[];
  readonly targetKey: readonly number[];
  readonly keyKinds: readonly ColumnKind[];
  readonly compared: readonly {
    name: string;
    source: number;
    target: number;
    sourceKind: ColumnKind;
    targetKind: ColumnKind;
  }[];
}

/** Resolves column positions and comparison kinds; throws when a key column is missing. */
export function planMerge(options: MergeOptions): MergePlan {
  const kindOf = (
    kinds: Readonly<Record<string, ColumnKind>> | undefined,
    name: string,
  ): ColumnKind => {
    if (kinds === undefined) return 'string';
    const direct = kinds[name];
    if (direct !== undefined) return direct;
    const match = Object.keys(kinds).find((k) => k.toLowerCase() === name.toLowerCase());
    return match !== undefined ? (kinds[match] ?? 'string') : 'string';
  };
  const sourceKey = options.keyColumns.map((k) => columnIndex(options.sourceColumns, k));
  const targetKey = options.keyColumns.map((k) => columnIndex(options.targetColumns, k));
  const missing = options.keyColumns.filter((_k, i) => sourceKey[i] === -1 || targetKey[i] === -1);
  if (missing.length > 0) {
    throw new JoineryError({
      code: 'VALIDATION_FAILED',
      message: `Key column ${missing.join(', ')} is missing on one side`,
      hint: 'Data compare needs the same primary or unique key on both tables.',
    });
  }
  const ignored = new Set((options.ignoreColumns ?? []).map((c) => c.toLowerCase()));
  const keySet = new Set(options.keyColumns.map((c) => c.toLowerCase()));
  const wanted = options.compareColumns ?? options.sourceColumns;
  const compared: MergePlan['compared'][number][] = [];
  for (const name of wanted) {
    if (ignored.has(name.toLowerCase()) || keySet.has(name.toLowerCase())) continue;
    const source = columnIndex(options.sourceColumns, name);
    const target = columnIndex(options.targetColumns, name);
    if (source === -1 || target === -1) continue;
    compared.push({
      name,
      source,
      target,
      sourceKind: kindOf(options.sourceKinds, name),
      targetKind: kindOf(options.targetKinds, options.targetColumns[target]!),
    });
  }
  return {
    sourceKey,
    targetKey,
    keyKinds: options.keyColumns.map((k) =>
      compareKind(kindOf(options.sourceKinds, k), kindOf(options.targetKinds, k)),
    ),
    compared,
  };
}

type AnyRows = Iterable<Row> | AsyncIterable<Row>;

function iterate(rows: AnyRows): AsyncIterator<Row> | Iterator<Row> {
  return Symbol.asyncIterator in rows
    ? (rows as AsyncIterable<Row>)[Symbol.asyncIterator]()
    : (rows as Iterable<Row>)[Symbol.iterator]();
}

/**
 * Reads one side's key-ordered stream, checking the order: a key that goes backwards means the
 * servers sort differently (collation); a repeated key with an identical row (overlapping
 * ranges) is skipped; a repeated key with a different row means the key is not unique.
 */
class OrderedStream {
  private readonly iterator: AsyncIterator<Row> | Iterator<Row>;
  private previous: Row | undefined;
  count = 0;

  constructor(
    rows: AnyRows,
    private readonly keyIndexes: readonly number[],
    private readonly keyKinds: readonly ColumnKind[],
    private readonly side: 'source' | 'target',
  ) {
    this.iterator = iterate(rows);
  }

  key(row: Row): CellValue[] {
    return this.keyIndexes.map((i) => row[i] ?? null);
  }

  async next(): Promise<Row | undefined> {
    for (;;) {
      const result = await this.iterator.next();
      if (result.done) return undefined;
      const row = result.value;
      if (this.previous !== undefined) {
        const order = compareKeys(this.key(this.previous), this.key(row), this.keyKinds);
        if (order > 0) {
          throw new JoineryError({
            code: 'VALIDATION_FAILED',
            message: `The ${this.side} rows are not sorted by key (at ${JSON.stringify(this.key(row), stringifyCell)})`,
            hint: 'The two servers order the key differently; compare with a binary collation on string keys.',
          });
        }
        if (order === 0) {
          if (sameRow(this.previous, row)) continue;
          throw new JoineryError({
            code: 'VALIDATION_FAILED',
            message: `Key ${JSON.stringify(this.key(row), stringifyCell)} is not unique in the ${this.side}`,
          });
        }
      }
      this.previous = row;
      this.count++;
      return row;
    }
  }

  async close(): Promise<void> {
    await this.iterator.return?.();
  }
}

function stringifyCell(_key: string, value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Uint8Array)
    return `0x${[...value].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
  return value;
}

function sameRow(a: Row, b: Row): boolean {
  if (a.length !== b.length) return false;
  return a.every((value, i) => {
    const other = b[i] ?? null;
    if (value instanceof Uint8Array && other instanceof Uint8Array) {
      return value.length === other.length && value.every((byte, j) => byte === other[j]);
    }
    return value === other;
  });
}

/**
 * Merges two key-ordered row streams into insert/update/delete actions (spec §13, step 5).
 * Both inputs must be sorted by the key in the order `compareKeys` defines — which the
 * `rowsQuery` ORDER BY produces. Streams are consumed lazily, so memory stays flat. Returns the
 * counts when the iteration completes.
 */
export async function* mergeSortedRows(
  source: AnyRows,
  target: AnyRows,
  options: MergeOptions,
): AsyncGenerator<RowDiff, MergeSummary, undefined> {
  const plan = planMerge(options);
  const left = new OrderedStream(source, plan.sourceKey, plan.keyKinds, 'source');
  const right = new OrderedStream(target, plan.targetKey, plan.keyKinds, 'target');
  let inserts = 0;
  let updates = 0;
  let deletes = 0;
  let equal = 0;
  try {
    let a = await left.next();
    let b = await right.next();
    while (a !== undefined || b !== undefined) {
      const order =
        a === undefined
          ? 1
          : b === undefined
            ? -1
            : compareKeys(left.key(a), right.key(b), plan.keyKinds);
      if (order < 0) {
        inserts++;
        yield { action: 'insert', key: left.key(a!), sourceRow: a! };
        a = await left.next();
      } else if (order > 0) {
        deletes++;
        yield { action: 'delete', key: right.key(b!), targetRow: b! };
        b = await right.next();
      } else {
        const changed = plan.compared
          .filter(
            (c) =>
              !valuesEqual(
                a![c.source] ?? null,
                b![c.target] ?? null,
                c.sourceKind,
                c.targetKind,
                options.canonical,
              ),
          )
          .map((c) => c.name);
        if (changed.length > 0) {
          updates++;
          yield {
            action: 'update',
            key: left.key(a!),
            changedColumns: changed,
            sourceRow: a!,
            targetRow: b!,
          };
        } else {
          equal++;
        }
        a = await left.next();
        b = await right.next();
      }
    }
  } finally {
    await left.close();
    await right.close();
  }
  return { inserts, updates, deletes, equal, sourceRows: left.count, targetRows: right.count };
}
