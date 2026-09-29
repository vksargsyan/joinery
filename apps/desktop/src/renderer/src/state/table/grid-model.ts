import type { CellValue } from '@joinery/core';
import {
  formatCell,
  isDefault,
  isLargeValue,
  type ChangeSet,
  type ColumnInfo,
  type EditValue,
  type RowKey,
  type RowStatus,
} from '@joinery/table-data';

/**
 * What the table grid shows (spec §7): the loaded rows followed by the rows staged for insert,
 * each cell's staged or loaded value, and how it is drawn — NULL, an empty string and DEFAULT
 * as distinct states, long values as a preview. Also the selection footer's figures. Pure, so
 * the grid component only maps these onto Glide cells.
 */

/** A row of the grid: a loaded row by its index, or a staged insert by its key. */
export type RowRef =
  | { readonly kind: 'loaded'; readonly index: number; readonly key: RowKey | null }
  | { readonly kind: 'insert'; readonly key: RowKey };

/** The loaded rows as the grid needs them: values in `columns` order, and each row's key. */
export interface LoadedRows {
  readonly columns: readonly string[];
  readonly rows: readonly (readonly CellValue[])[];
  readonly keys: readonly (RowKey | null)[];
}

/** Number of grid rows: loaded rows, then staged inserts. */
export function gridRowCount(loaded: LoadedRows, changes: ChangeSet): number {
  return loaded.rows.length + changes.counts.inserted;
}

/** The row at grid position `index` (undefined past the end). */
export function rowAt(
  loaded: LoadedRows,
  inserts: readonly RowKey[],
  index: number,
): RowRef | undefined {
  if (index < 0) return undefined;
  if (index < loaded.rows.length) {
    return { kind: 'loaded', index, key: loaded.keys[index] ?? null };
  }
  const key = inserts[index - loaded.rows.length];
  return key === undefined ? undefined : { kind: 'insert', key };
}

/** The keys of the staged inserts, in grid order. */
export function insertKeys(changes: ChangeSet): RowKey[] {
  return changes.insertedRows().map((row) => row.key);
}

/** A loaded row's values by column name (what ChangeSet edits need the first time). */
export function loadedRecord(loaded: LoadedRows, index: number): Record<string, CellValue> {
  const record: Record<string, CellValue> = {};
  const row = loaded.rows[index];
  loaded.columns.forEach((name, i) => {
    record[name] = row?.[i] ?? null;
  });
  return record;
}

/** The status of a grid row: unchanged, edited, deleted or inserted. */
export function rowStatus(changes: ChangeSet, ref: RowRef): RowStatus {
  if (ref.kind === 'insert') return 'inserted';
  return ref.key === null ? 'unchanged' : changes.status(ref.key);
}

/** The value a cell shows: staged, loaded, or DEFAULT in an inserted row. */
export function cellValue(
  loaded: LoadedRows,
  changes: ChangeSet,
  ref: RowRef,
  columnIndex: number,
): EditValue | undefined {
  const column = loaded.columns[columnIndex];
  if (column === undefined) return undefined;
  if (ref.kind === 'insert') return changes.valueOf(ref.key, column);
  const value = loaded.rows[ref.index]?.[columnIndex] ?? null;
  return ref.key === null ? value : changes.valueOf(ref.key, column, value);
}

/** Whether the cell holds a staged change. */
export function cellEdited(
  loaded: LoadedRows,
  changes: ChangeSet,
  ref: RowRef,
  columnIndex: number,
): boolean {
  const column = loaded.columns[columnIndex];
  if (column === undefined || ref.key === null) return false;
  return changes.isEdited(ref.key, column);
}

export type CellState = 'value' | 'null' | 'default' | 'empty' | 'preview';

export interface CellDisplay {
  /** One-line text for the grid: at most `PREVIEW_CHARS` characters. */
  readonly text: string;
  readonly state: CellState;
  /** The value is longer than what the grid shows; opening the cell shows it all. */
  readonly truncated: boolean;
}

/** Characters of a long value the grid draws; the editor and viewers show the full value. */
export const PREVIEW_CHARS = 200;
const BINARY_PREVIEW_BYTES = 32;

function hex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

/** How a cell value is drawn in the grid (see the module comment). */
export function displayCell(value: EditValue | undefined): CellDisplay {
  if (value === undefined || value === null)
    return { text: 'NULL', state: 'null', truncated: false };
  if (isDefault(value)) return { text: 'DEFAULT', state: 'default', truncated: false };
  if (isLargeValue(value)) {
    return { text: `${value.preview.slice(0, PREVIEW_CHARS)}…`, state: 'preview', truncated: true };
  }
  if (value instanceof Uint8Array) {
    const shown = value.subarray(0, BINARY_PREVIEW_BYTES);
    const more = value.length > shown.length;
    return {
      text: `0x${hex(shown)}${more ? `… (${value.length} bytes)` : ''}`,
      state: 'value',
      truncated: more,
    };
  }
  if (value === '') return { text: "''", state: 'empty', truncated: false };
  const text = formatCell(value);
  const long = text.length > PREVIEW_CHARS;
  const oneLine = (long ? text.slice(0, PREVIEW_CHARS) : text).replace(/\r?\n|\r/g, '↵');
  return { text: long ? `${oneLine}…` : oneLine, state: 'value', truncated: long };
}

const NUMERIC = new Set(['integer', 'bigint', 'decimal', 'float']);

/** Whether the selection footer sums and averages the column. */
export function isNumericColumn(column: ColumnInfo): boolean {
  return NUMERIC.has(column.kind) && !column.booleanLike;
}

function toNumber(value: EditValue | undefined): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

export interface SelectionStats {
  /** Selected cells. */
  readonly cells: number;
  /** Rows the selection touches. */
  readonly rows: number;
  /** Figures over the numeric cells, when any is selected. */
  readonly numeric?: {
    readonly count: number;
    readonly sum: number;
    readonly avg: number;
    readonly min: number;
    readonly max: number;
  };
}

/**
 * The selection footer (spec §7: count, sum, average, min and max). `cells` yields each selected
 * cell's value and column; NULL and DEFAULT count as cells but not as numbers.
 */
export function selectionStats(
  cells: Iterable<{ readonly value: EditValue | undefined; readonly column: ColumnInfo }>,
  rows: number,
): SelectionStats {
  let count = 0;
  let numbers = 0;
  let sum = 0;
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const { value, column } of cells) {
    count++;
    if (!isNumericColumn(column)) continue;
    const n = toNumber(value);
    if (n === undefined) continue;
    numbers++;
    sum += n;
    if (n < min) min = n;
    if (n > max) max = n;
  }
  return {
    cells: count,
    rows,
    ...(numbers > 0 ? { numeric: { count: numbers, sum, avg: sum / numbers, min, max } } : {}),
  };
}

/** A figure for the footer: integers as they are, fractions to at most 6 significant places. */
export function formatStat(value: number): string {
  if (Number.isInteger(value)) return value.toLocaleString('en-US');
  return value.toLocaleString('en-US', { maximumSignificantDigits: 12 });
}

/** The key the paste errors of a cell are kept under. */
export function cellErrorKey(key: RowKey, column: string): string {
  return `${key}\u0000${column}`;
}
