import {
  JoineryError,
  newId,
  rowAt,
  toErrorData,
  type CellValue,
  type QueryParams,
  type Session,
} from '@joinery/core';

/** Small helpers every backup and restore uses: statements, cancellation, progress pacing. */

export function cancelled(): JoineryError {
  return new JoineryError({ code: 'CANCELLED', message: 'Cancelled' });
}

export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw cancelled();
}

export function isCancel(error: unknown, signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true || (error instanceof JoineryError && error.code === 'CANCELLED');
}

/** Runs one statement to completion; returns the rows it affected, when the server said. */
export async function drain(
  session: Session,
  sql: string,
  signal?: AbortSignal,
  params?: QueryParams,
): Promise<number> {
  let affected = 0;
  for await (const chunk of session.execute(sql, {
    executionId: newId(),
    ...(signal !== undefined ? { signal } : {}),
    ...(params !== undefined ? { params } : {}),
  })) {
    if (chunk.type === 'status' && chunk.rowsAffected !== null) affected += chunk.rowsAffected;
  }
  return affected;
}

/** Runs a query and returns the rows of its first result. */
export async function queryRows(
  session: Session,
  sql: string,
  params?: QueryParams,
): Promise<CellValue[][]> {
  const rows: CellValue[][] = [];
  for await (const chunk of session.execute(sql, {
    executionId: newId(),
    ...(params !== undefined ? { params } : {}),
  })) {
    if (chunk.type === 'rows' && chunk.resultIndex === 0) {
      for (let r = 0; r < chunk.rowCount; r++) rows.push(rowAt(chunk, r));
    }
  }
  return rows;
}

/** Text of a cell that should hold text (catalog queries). */
export function text(value: CellValue | undefined): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'boolean') {
    return String(value);
  }
  if (value instanceof Uint8Array) return Buffer.from(value).toString('utf8');
  return undefined;
}

/** Paces progress events: at most one per interval, plus the forced ones. */
export class Pacer {
  #last = Number.NEGATIVE_INFINITY;
  readonly started = performance.now();

  constructor(private readonly intervalMs: number) {}

  due(force = false): boolean {
    const now = performance.now();
    if (!force && now - this.#last < this.intervalMs) return false;
    this.#last = now;
    return true;
  }

  get elapsedMs(): number {
    return Math.round(performance.now() - this.started);
  }
}

export function errorMessage(error: unknown): string {
  return toErrorData(error).message;
}

/** The start of a statement, on one line, for error logs. */
export function excerpt(sql: string, max = 200): string {
  const flat = sql.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export function plural(count: number, word: string): string {
  return `${count.toLocaleString('en-US')} ${word}${count === 1 ? '' : 's'}`;
}
