import type { CellValue, ColumnMeta } from '@querybara/core';

import { cellJson, cellText, isNumericKind, uniqueKeys } from './cells';
import type { Sink } from './sink';
import { displayWidth, padToWidth, singleLine, truncateToWidth } from './width';

export const OUTPUT_FORMATS = ['table', 'csv', 'tsv', 'json', 'jsonl'] as const;
export type OutputFormat = (typeof OUTPUT_FORMATS)[number];

/** Column-oriented row data, as `rows` chunks carry it: data[column][row]. */
export type ColumnData = readonly (readonly CellValue[])[];

/**
 * Streams result sets to a sink. `begin` opens a result set, `rows` may be called any number of
 * times with pages of rows, `end` closes it. Several result sets may follow each other.
 * Writers hold at most one page, so memory stays flat however many rows stream through.
 */
export interface ResultWriter {
  begin(columns: readonly ColumnMeta[]): Promise<void>;
  rows(data: ColumnData, rowCount: number): Promise<void>;
  end(): Promise<void>;
}

export interface TableOptions {
  /** Width to fit the table into (the terminal width); undefined: no fitting. */
  readonly width?: number;
  /** Longest a cell may be before it is cut with '…'. */
  readonly maxColumnWidth?: number;
  /** How NULL shows. */
  readonly nullText?: string;
}

export const DEFAULT_MAX_COLUMN_WIDTH = 50;
const MIN_COLUMN_WIDTH = 4;

export function createResultWriter(
  format: OutputFormat,
  sink: Sink,
  options: TableOptions = {},
): ResultWriter {
  switch (format) {
    case 'table':
      return new TableWriter(sink, options);
    case 'csv':
      return new DelimitedWriter(sink, 'csv');
    case 'tsv':
      return new DelimitedWriter(sink, 'tsv');
    case 'json':
      return new JsonWriter(sink, false);
    case 'jsonl':
      return new JsonWriter(sink, true);
  }
}

// ---------------------------------------------------------------------------------------------
// CSV and TSV

/**
 * RFC 4180 CSV. A field is quoted when it holds a comma, quote or line break, and the empty
 * string is written `""` so it stays distinct from NULL (an empty unquoted field).
 */
export function csvField(value: CellValue): string {
  if (value === null) return '';
  const text = cellText(value);
  if (text === '') return '""';
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/**
 * PostgreSQL text-format TSV (what COPY ... TO emits): backslash, tab, newline and carriage
 * return are backslash-escaped and NULL is `\N`, so every value survives a round trip.
 */
export function tsvField(value: CellValue): string {
  if (value === null) return '\\N';
  return escapeTsv(cellText(value));
}

function escapeTsv(text: string): string {
  if (!/[\\\t\n\r]/.test(text)) return text;
  return text
    .replaceAll('\\', '\\\\')
    .replaceAll('\t', '\\t')
    .replaceAll('\n', '\\n')
    .replaceAll('\r', '\\r');
}

class DelimitedWriter implements ResultWriter {
  #sets = 0;
  #columns = 0;

  constructor(
    private readonly sink: Sink,
    private readonly kind: 'csv' | 'tsv',
  ) {}

  async begin(columns: readonly ColumnMeta[]): Promise<void> {
    this.#columns = columns.length;
    const header =
      this.kind === 'csv'
        ? columns.map((c) => csvField(c.name)).join(',')
        : columns.map((c) => escapeTsv(c.name)).join('\t');
    // A blank line separates consecutive result sets.
    await this.sink.write(`${this.#sets++ > 0 ? '\n' : ''}${header}\n`);
  }

  async rows(data: ColumnData, rowCount: number): Promise<void> {
    const field = this.kind === 'csv' ? csvField : tsvField;
    const separator = this.kind === 'csv' ? ',' : '\t';
    let out = '';
    for (let r = 0; r < rowCount; r++) {
      let line = '';
      for (let c = 0; c < this.#columns; c++) {
        if (c > 0) line += separator;
        line += field(data[c]?.[r] ?? null);
      }
      out += `${line}\n`;
    }
    await this.sink.write(out);
  }

  async end(): Promise<void> {}
}

// ---------------------------------------------------------------------------------------------
// JSON and JSON Lines

/**
 * `json`: each result set is one array of row objects (several result sets: one array per
 * line group). `jsonl`: one object per row. Rows are written page by page, never buffered.
 */
class JsonWriter implements ResultWriter {
  #keys: string[] = [];
  #columns: readonly ColumnMeta[] = [];
  #first = true;

  constructor(
    private readonly sink: Sink,
    private readonly lines: boolean,
  ) {}

  async begin(columns: readonly ColumnMeta[]): Promise<void> {
    this.#columns = columns;
    this.#keys = uniqueKeys(columns.map((c) => c.name)).map((key) => JSON.stringify(key));
    this.#first = true;
    if (!this.lines) await this.sink.write('[');
  }

  async rows(data: ColumnData, rowCount: number): Promise<void> {
    let out = '';
    for (let r = 0; r < rowCount; r++) {
      let object = '{';
      for (let c = 0; c < this.#keys.length; c++) {
        if (c > 0) object += ',';
        object += `${this.#keys[c]}:${cellJson(data[c]?.[r] ?? null, this.#columns[c]?.kind)}`;
      }
      object += '}';
      if (this.lines) out += `${object}\n`;
      else {
        out += `${this.#first ? '\n' : ',\n'}${object}`;
        this.#first = false;
      }
    }
    await this.sink.write(out);
  }

  async end(): Promise<void> {
    if (!this.lines) await this.sink.write(this.#first ? ']\n' : '\n]\n');
  }
}

// ---------------------------------------------------------------------------------------------
// Table

/**
 * An aligned text table, psql style. Column widths come from the header and the first page of
 * rows (so output starts without reading the whole result), capped at `maxColumnWidth` and then
 * shrunk, widest first, until the table fits the terminal. Longer cells are cut with '…';
 * line breaks and control characters are shown as symbols so a row stays on one line.
 */
export class TableWriter implements ResultWriter {
  #columns: readonly ColumnMeta[] = [];
  #widths: number[] | undefined;
  #pending: string[][] = [];
  #sets = 0;
  readonly #maxColumnWidth: number;
  readonly #nullText: string;

  constructor(
    private readonly sink: Sink,
    private readonly options: TableOptions = {},
  ) {
    this.#maxColumnWidth = Math.max(
      MIN_COLUMN_WIDTH,
      options.maxColumnWidth ?? DEFAULT_MAX_COLUMN_WIDTH,
    );
    this.#nullText = options.nullText ?? 'NULL';
  }

  async begin(columns: readonly ColumnMeta[]): Promise<void> {
    this.#columns = columns;
    this.#widths = undefined;
    this.#pending = [];
    if (this.#sets++ > 0) await this.sink.write('\n');
  }

  async rows(data: ColumnData, rowCount: number): Promise<void> {
    const cells: string[][] = [];
    for (let r = 0; r < rowCount; r++) {
      const row: string[] = [];
      for (let c = 0; c < this.#columns.length; c++) {
        const value = data[c]?.[r] ?? null;
        row.push(value === null ? this.#nullText : singleLine(cellText(value)));
      }
      cells.push(row);
    }
    if (this.#widths === undefined) {
      this.#pending.push(...cells);
      await this.#flushPending();
    } else {
      await this.sink.write(this.#renderRows(cells, this.#widths));
    }
  }

  async end(): Promise<void> {
    if (this.#widths === undefined) await this.#flushPending();
  }

  async #flushPending(): Promise<void> {
    const widths = this.#computeWidths(this.#pending);
    this.#widths = widths;
    const header = this.#columns
      .map((c, i) => ` ${padToWidth(truncateToWidth(singleLine(c.name), widths[i]!), widths[i]!)} `)
      .join('|');
    const rule = widths.map((w) => '-'.repeat(w + 2)).join('+');
    const rows = this.#renderRows(this.#pending, widths);
    this.#pending = [];
    await this.sink.write(`${header.trimEnd()}\n${rule}\n${rows}`);
  }

  #computeWidths(rows: readonly string[][]): number[] {
    const widths = this.#columns.map((c) =>
      Math.min(this.#maxColumnWidth, Math.max(1, displayWidth(singleLine(c.name)))),
    );
    for (const row of rows) {
      row.forEach((cell, i) => {
        const w = Math.min(this.#maxColumnWidth, displayWidth(cell));
        if (w > widths[i]!) widths[i] = w;
      });
    }
    const limit = this.options.width;
    if (limit !== undefined && widths.length > 0) {
      // Each column takes its width plus two spaces of padding, and one '|' between columns.
      const total = (): number => widths.reduce((sum, w) => sum + w + 2, 0) + widths.length - 1;
      let over = total() - limit;
      while (over > 0) {
        let widest = -1;
        for (let i = 0; i < widths.length; i++) {
          if (widths[i]! > MIN_COLUMN_WIDTH && (widest === -1 || widths[i]! > widths[widest]!)) {
            widest = i;
          }
        }
        if (widest === -1) break;
        widths[widest]!--;
        over--;
      }
    }
    return widths;
  }

  #renderRows(rows: readonly string[][], widths: readonly number[]): string {
    let out = '';
    for (const row of rows) {
      let line = '';
      for (let c = 0; c < widths.length; c++) {
        const width = widths[c]!;
        const cell = truncateToWidth(row[c] ?? '', width);
        const align = isNumericKind(this.#columns[c]?.kind ?? 'unknown') ? 'right' : 'left';
        line += `${c > 0 ? '|' : ''} ${padToWidth(cell, width, align)} `;
      }
      out += `${line.trimEnd()}\n`;
    }
    return out;
  }
}
