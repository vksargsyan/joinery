import type { CsvField } from './csv';
import type { RowBatch, RowError, SourceCell } from './types';

/** Pieces every reader shares: column naming and collecting rows into batches. */

/** Column names from a header record: trimmed, blanks named `columnN`, duplicates suffixed. */
export function headerNames(record: readonly CsvField[]): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  record.forEach((cell, i) => {
    let name = (cell ?? '').trim();
    if (name === '') name = `column${i + 1}`;
    let unique = name;
    for (let n = 2; seen.has(unique.toLowerCase()); n++) unique = `${name}_${n}`;
    seen.add(unique.toLowerCase());
    names.push(unique);
  });
  return names;
}

/** Appends generated names so that `columns` has at least `width` entries. */
export function widen(columns: string[], width: number): string[] {
  if (columns.length >= width) return columns;
  const next = [...columns];
  const taken = new Set(next.map((c) => c.toLowerCase()));
  for (let i = next.length; i < width; i++) {
    let name = `column${i + 1}`;
    for (let n = 2; taken.has(name.toLowerCase()); n++) name = `column${i + 1}_${n}`;
    taken.add(name.toLowerCase());
    next.push(name);
  }
  return next;
}

/** Rows being collected for one batch. */
export interface BatchParts {
  rows: SourceCell[][];
  rowNumbers: number[];
  lines: number[];
  rejected: RowError[];
}

export const emptyParts = (): BatchParts => ({ rows: [], rowNumbers: [], lines: [], rejected: [] });

export function toBatch(
  columns: readonly string[],
  parts: BatchParts,
  bytesRead: number,
  json = false,
): RowBatch {
  return {
    columns,
    rows: parts.rows,
    rowNumbers: parts.rowNumbers,
    lines: parts.lines,
    rejected: parts.rejected,
    bytesRead,
    ...(json ? { json } : {}),
  };
}
