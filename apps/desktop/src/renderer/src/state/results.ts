import type { CellValue, ColumnMeta, NoticeSeverity, ResultChunk } from '@joinery/core';

import { formatDuration, formatRows } from '../lib/format';

/**
 * Result accumulation for the grid (spec §6, §7). Rows arrive as column-oriented chunks of up to
 * 1,000 rows; they are appended column by column, never transposed, so the grid reads a cell with
 * two array lookups. No React here: the query runner feeds chunks in, the grid reads cells out.
 */

/** One result set of a statement (a SELECT, or one of several from a CALL). */
export class ResultSetBuffer {
  readonly resultIndex: number;
  readonly columns: readonly ColumnMeta[];
  /** data[column][row]. */
  readonly #data: CellValue[][];
  #rowCount = 0;

  constructor(resultIndex: number, columns: readonly ColumnMeta[]) {
    this.resultIndex = resultIndex;
    this.columns = columns;
    this.#data = columns.map(() => []);
  }

  get rowCount(): number {
    return this.#rowCount;
  }

  /** Appends a `rows` chunk. Throws when its shape does not match the columns. */
  append(chunk: Extract<ResultChunk, { type: 'rows' }>): void {
    if (chunk.data.length !== this.columns.length) {
      throw new Error(
        `Result ${chunk.resultIndex} has ${this.columns.length} columns, a chunk had ${chunk.data.length}`,
      );
    }
    for (let c = 0; c < this.columns.length; c++) {
      const target = this.#data[c]!;
      const source = chunk.data[c]!;
      for (let r = 0; r < chunk.rowCount; r++) target.push(source[r] ?? null);
    }
    this.#rowCount += chunk.rowCount;
  }

  cell(column: number, row: number): CellValue {
    return this.#data[column]?.[row] ?? null;
  }

  row(row: number): CellValue[] {
    return this.#data.map((column) => column[row] ?? null);
  }
}

export interface StatementNotice {
  readonly severity: NoticeSeverity;
  readonly message: string;
  readonly code?: string;
}

export interface StatementStatus {
  readonly command: string | null;
  readonly rowsAffected: number | null;
}

/**
 * Everything one statement produced: its result sets in order, command status, notices and the
 * end summary. `consume` takes the chunks of `Session.execute` in the order they arrive.
 */
export class StatementResult {
  readonly sets: ResultSetBuffer[] = [];
  readonly notices: StatementNotice[] = [];
  status: StatementStatus | undefined;
  end: { readonly durationMs: number; readonly rowCount: number } | undefined;
  /** Bumps on every change, so views can re-render cheaply. */
  version = 0;

  /** Rows loaded across all result sets. */
  get loadedRows(): number {
    let total = 0;
    for (const set of this.sets) total += set.rowCount;
    return total;
  }

  get complete(): boolean {
    return this.end !== undefined;
  }

  set(resultIndex: number): ResultSetBuffer | undefined {
    return this.sets.find((set) => set.resultIndex === resultIndex);
  }

  consume(chunk: ResultChunk): void {
    switch (chunk.type) {
      case 'columns':
        if (this.set(chunk.resultIndex)) {
          throw new Error(`Result ${chunk.resultIndex} announced its columns twice`);
        }
        this.sets.push(new ResultSetBuffer(chunk.resultIndex, chunk.columns));
        break;
      case 'rows': {
        const set = this.set(chunk.resultIndex);
        if (!set)
          throw new Error(`Rows arrived for result ${chunk.resultIndex} before its columns`);
        set.append(chunk);
        break;
      }
      case 'status':
        this.status = { command: chunk.command, rowsAffected: chunk.rowsAffected };
        break;
      case 'notice':
        this.notices.push({
          severity: chunk.severity,
          message: chunk.message,
          ...(chunk.code === undefined ? {} : { code: chunk.code }),
        });
        break;
      case 'end':
        this.end = { durationMs: chunk.durationMs, rowCount: chunk.rowCount };
        break;
    }
    this.version++;
  }
}

/** How the grid and the copy commands show a cell. NULL is its own state (spec §7). */
export function cellText(value: CellValue): string {
  if (value === null) return 'NULL';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (value instanceof Uint8Array) {
    const shown = value.subarray(0, 64);
    let hex = '';
    for (const byte of shown) hex += byte.toString(16).padStart(2, '0');
    return `\\x${hex}${value.length > shown.length ? '…' : ''}`;
  }
  return `${value.preview}…`;
}

/** The Messages line for a finished (or paused) statement. */
export function summarise(
  result: StatementResult,
  state: 'done' | 'paused' | 'truncated',
  elapsedMs: number,
): string {
  const parts: string[] = [];
  const status = result.status;
  if (result.sets.length > 0) {
    const rows = formatRows(result.loadedRows);
    parts.push(
      state === 'paused'
        ? `${rows} shown, more available`
        : state === 'truncated'
          ? `${rows} shown (stopped at the row limit)`
          : `${rows} returned`,
    );
  } else {
    if (status?.command) parts.push(status.command);
    if (status?.rowsAffected !== null && status?.rowsAffected !== undefined) {
      parts.push(`${formatRows(status.rowsAffected)} affected`);
    }
  }
  parts.push(formatDuration(result.end?.durationMs ?? elapsedMs));
  return parts.join(' · ');
}

/**
 * Initial grid column widths in pixels, from the header and the first `sample` rows: wide
 * enough for typical values, capped so one long text column does not push the others away.
 */
export function suggestColumnWidths(set: ResultSetBuffer, sample = 200): number[] {
  const rows = Math.min(set.rowCount, sample);
  return set.columns.map((column, c) => {
    let longest = column.name.length + 2;
    for (let r = 0; r < rows && longest < 60; r++) {
      longest = Math.max(longest, Math.min(60, cellText(set.cell(c, r)).length));
    }
    return Math.min(480, Math.max(64, Math.round(longest * 7.5 + 24)));
  });
}
