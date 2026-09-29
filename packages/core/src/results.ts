/**
 * Query results (spec §3, "IPC contract"). Result sets stream as column-oriented chunks of up
 * to 1,000 rows, with column metadata sent once. Every value here survives structured clone,
 * so chunks cross MessagePorts unchanged.
 */

export type ColumnKind =
  | 'string'
  | 'integer'
  | 'bigint'
  | 'decimal'
  | 'float'
  | 'boolean'
  | 'date'
  | 'time'
  | 'datetime'
  | 'timestamp'
  | 'interval'
  | 'json'
  | 'binary'
  | 'uuid'
  | 'array'
  | 'enum'
  | 'geometry'
  | 'unknown';

export interface ColumnMeta {
  readonly name: string;
  /** The engine's own type name, e.g. "varchar(255)", "int4", "timestamptz". */
  readonly nativeType: string;
  readonly kind: ColumnKind;
  readonly nullable?: boolean;
  /** Source table and schema when the server reports them (enables editing and FK lookups). */
  readonly table?: string;
  readonly schema?: string;
}

/** A value too large to ship inline; the full value is fetched on demand by handle. */
export interface LargeValueHandle {
  readonly $handle: string;
  readonly preview: string;
  readonly byteLength: number;
  readonly kind: 'text' | 'binary';
}

/**
 * One cell. Drivers map native values onto this set:
 * - integers that fit in 2^53 as number, larger ones as bigint;
 * - decimals, dates, times and timestamps as the server's text form (no JS Date, so no
 *   time-zone shifting);
 * - JSON, arrays and composite values as JSON or server text;
 * - binary as Uint8Array.
 */
export type CellValue = null | boolean | number | bigint | string | Uint8Array | LargeValueHandle;

export type QueryParams = readonly CellValue[] | Readonly<Record<string, CellValue>>;

export const DEFAULT_PAGE_SIZE = 1000;

export interface ExecOptions {
  /** Caller-chosen id, used to cancel this execution. */
  readonly executionId: string;
  /** Rows per `rows` chunk; defaults to DEFAULT_PAGE_SIZE. */
  readonly pageSize?: number;
  readonly params?: QueryParams;
  readonly signal?: AbortSignal;
}

export type NoticeSeverity = 'debug' | 'info' | 'notice' | 'warning';

/**
 * What `Session.execute` yields for one statement, in order:
 * zero or more result sets (`columns` then `rows`...), `status`/`notice` as they occur, then
 * exactly one `end`. Errors are thrown from the iterator as JoineryError.
 *
 * The iterator is the cursor: rows are fetched as the consumer pulls, so a consumer that stops
 * at a row limit and later resumes gets "Fetch more" for free. Returning early closes the cursor.
 */
export type ResultChunk =
  | {
      readonly type: 'columns';
      /** 0 for the first result set of the statement, 1 for the next (e.g. CALL results). */
      readonly resultIndex: number;
      readonly columns: readonly ColumnMeta[];
    }
  | {
      readonly type: 'rows';
      readonly resultIndex: number;
      readonly rowCount: number;
      /** Column-oriented: data[columnIndex][rowIndex]. */
      readonly data: readonly (readonly CellValue[])[];
    }
  | {
      readonly type: 'status';
      /** Command tag, e.g. "INSERT", "UPDATE", "CREATE TABLE". */
      readonly command: string | null;
      readonly rowsAffected: number | null;
      readonly lastInsertId?: string | null;
    }
  | {
      readonly type: 'notice';
      readonly severity: NoticeSeverity;
      readonly message: string;
      readonly code?: string;
    }
  | {
      readonly type: 'end';
      readonly durationMs: number;
      /** Total rows yielded across result sets. */
      readonly rowCount: number;
    };

/** Transposes row-oriented values into a column-oriented `rows` chunk. */
export function toColumnChunk(
  resultIndex: number,
  columnCount: number,
  rows: readonly (readonly CellValue[])[],
): Extract<ResultChunk, { type: 'rows' }> {
  const data: CellValue[][] = Array.from({ length: columnCount }, () => new Array(rows.length));
  rows.forEach((row, r) => {
    for (let c = 0; c < columnCount; c++) data[c]![r] = row[c] ?? null;
  });
  return { type: 'rows', resultIndex, rowCount: rows.length, data };
}

/** Reads row `r` back out of a column-oriented chunk. */
export function rowAt(chunk: Extract<ResultChunk, { type: 'rows' }>, r: number): CellValue[] {
  return chunk.data.map((column) => column[r] ?? null);
}
