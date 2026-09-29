/**
 * Shared shapes of the transfer pipeline (spec §12): what readers produce, what imports and
 * exports report. Everything here survives structured clone, so previews, progress events and
 * summaries cross from the job runner to the renderer unchanged.
 */

/** File formats the readers understand. `sql` files are run statement by statement. */
export const FILE_FORMATS = ['csv', 'tsv', 'json', 'jsonl', 'xlsx', 'xml', 'sql'] as const;
export type FileFormat = (typeof FILE_FORMATS)[number];

/**
 * Export formats: the file formats, SQL INSERTs preceded by the table's DDL, and two formats
 * for reading rather than loading: a self-contained HTML page and Markdown tables.
 */
export const EXPORT_FORMATS = [
  'csv',
  'tsv',
  'json',
  'jsonl',
  'xlsx',
  'xml',
  'sql',
  'sql-ddl',
  'html',
  'markdown',
] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

/**
 * A JSON value kept as its exact source text: a nested object or array, or a number that a
 * JavaScript number would not reproduce digit for digit (`1.50`, `1e5`, 30-digit decimals).
 * A plain object rather than a class so it survives structured clone.
 */
export interface JsonText {
  readonly $json: string;
}

export function jsonText(text: string): JsonText {
  return { $json: text };
}

export function isJsonText(value: unknown): value is JsonText {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { $json?: unknown }).$json === 'string'
  );
}

/**
 * One cell as a reader produces it. Text formats yield `string | null`; JSON yields parsed
 * scalars (integers beyond 2^53 as bigint) and JsonText for nested values.
 */
export type SourceCell = string | number | bigint | boolean | null | JsonText;
export type SourceRow = readonly SourceCell[];

/** A row that failed: while reading, converting or writing. */
export interface RowError {
  /** 1-based data row number (a header line is not counted); absent for whole-run failures. */
  readonly row?: number;
  /** 1-based line of the source file where the row starts. */
  readonly line?: number;
  /** The column that failed, when known (target column name for conversions and writes). */
  readonly column?: string;
  readonly message: string;
}

/** A batch of rows from a reader. Batches follow the source's own chunking. */
export interface RowBatch {
  /**
   * Source column names. Append-only over one read: a JSON object with a new key or a CSV
   * record with extra fields adds a column, and earlier rows simply lack it.
   */
  readonly columns: readonly string[];
  /** Rows aligned with `columns`; a row shorter than `columns` has nulls for the rest. */
  readonly rows: readonly SourceRow[];
  /** 1-based data row number of each row. */
  readonly rowNumbers: readonly number[];
  /** 1-based source line where each row starts. */
  readonly lines: readonly number[];
  /** Rows that could not be parsed (a malformed JSON Lines line); counted as errors. */
  readonly rejected: readonly RowError[];
  /** Source bytes consumed so far (compressed bytes when the reader decompressed). */
  readonly bytesRead: number;
  /** Cells are parsed JSON values (strings are JSON strings, not raw text). */
  readonly json?: boolean;
}

/** How a run ended. Runtime failures end in a summary rather than a thrown error. */
export type TransferStatus = 'completed' | 'failed' | 'cancelled';

/** Progress of an import or export, reported at most every `progressIntervalMs`. */
export interface TransferProgress {
  readonly rowsRead: number;
  readonly rowsWritten: number;
  /** Rows skipped after an error (`onError: 'skip'`). */
  readonly rowsSkipped: number;
  /** Source bytes read (import) or bytes written to the sink (export). */
  readonly bytes: number;
  readonly elapsedMs: number;
  /** Rows written per second since the start. */
  readonly rowsPerSecond: number;
  /** The table being exported, for multi-table exports. */
  readonly table?: string;
}

/** The result of an import or export. */
export interface TransferSummary {
  readonly status: TransferStatus;
  readonly rowsRead: number;
  /**
   * Rows written and kept: committed rows for an import (a rolled-back transaction counts
   * zero), rows written to the sink for an export.
   */
  readonly rowsWritten: number;
  readonly rowsSkipped: number;
  readonly errors: readonly RowError[];
  readonly durationMs: number;
}
