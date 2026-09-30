import { parseCellInput, type ParseOptions } from './cells';
import type { ChangeSet, ExistingRow } from './changes';
import type { ColumnInfo } from './columns';
import type { RowKey } from './identity';
import type { EditValue } from './values';

/**
 * Paste from Excel or Google Sheets (spec §7). Both put TSV on the clipboard: cells split by
 * tabs, rows by line breaks, and a cell holding a tab, line break or quote wrapped in double
 * quotes with inner quotes doubled. A trailing line break ends the last row rather than
 * starting an empty one.
 */
export function parsePastedText(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let i = 0;
  const n = text.length;
  if (n === 0) return rows;
  for (;;) {
    let cell = '';
    let quotedOk = false;
    if (text[i] === '"') {
      // Quoted cell: valid only if the closing quote is followed by a separator or the end.
      let j = i + 1;
      let value = '';
      for (;;) {
        if (j >= n) break;
        if (text[j] === '"') {
          if (text[j + 1] === '"') {
            value += '"';
            j += 2;
            continue;
          }
          const after = text[j + 1];
          if (after === undefined || after === '\t' || after === '\n' || after === '\r') {
            quotedOk = true;
            cell = value;
            i = j + 1;
          }
          break;
        }
        value += text[j];
        j++;
      }
    }
    if (!quotedOk) {
      let j = i;
      while (j < n && text[j] !== '\t' && text[j] !== '\n' && text[j] !== '\r') j++;
      cell = text.slice(i, j);
      i = j;
    }
    row.push(cell);
    if (i >= n) {
      rows.push(row);
      break;
    }
    const separator = text[i];
    if (separator === '\t') {
      i++;
      continue;
    }
    // A line break: \r\n, \n or a lone \r.
    i += separator === '\r' && text[i + 1] === '\n' ? 2 : 1;
    rows.push(row);
    row = [];
    if (i >= n) break;
  }
  return rows;
}

export interface PastedCell {
  readonly column: string;
  readonly text: string;
  /** The parsed value; absent when the text did not parse. */
  readonly value?: EditValue;
  readonly error?: string;
}

export interface PastedRows {
  /** One entry per pasted row; cells map onto consecutive columns from the start column. */
  readonly rows: readonly (readonly PastedCell[])[];
  readonly errors: number;
  /** Cells past the last column, which were dropped. */
  readonly overflow: number;
}

/**
 * Maps pasted text rows onto `columns` starting at `startColumn` (an index into `columns`,
 * usually the grid's visible column order) and parses each cell for its column, keeping
 * per-cell errors for the grid to show.
 */
export function mapPastedRows(
  rows: readonly (readonly string[])[],
  columns: readonly ColumnInfo[],
  startColumn: number,
  options: ParseOptions = {},
): PastedRows {
  let errors = 0;
  let overflow = 0;
  const mapped = rows.map((cells) => {
    const out: PastedCell[] = [];
    cells.forEach((text, i) => {
      const column = columns[startColumn + i];
      if (!column) {
        overflow++;
        return;
      }
      const parsed = parseCellInput(text, column, options);
      if (parsed.ok) out.push({ column: column.name, text, value: parsed.value });
      else {
        errors++;
        out.push({ column: column.name, text, error: parsed.error });
      }
    });
    return out;
  });
  return { rows: mapped, errors, overflow };
}

export interface PasteTarget {
  /**
   * Rows the pasted rows land on, in order: loaded rows (as ExistingRow) or staged inserts
   * (by key). Pasted rows past the end become new rows unless `insertRemaining` is false.
   */
  readonly rows: readonly (ExistingRow | RowKey)[];
  readonly insertRemaining?: boolean;
}

export interface PasteResult {
  readonly changes: ChangeSet;
  /** Keys of the rows the paste inserted. */
  readonly inserted: readonly RowKey[];
  /** Cells not applied: parse errors, and cells of rows marked for deletion. */
  readonly skipped: number;
}

/** Stages parsed pasted rows as edits of existing rows and inserts of new ones, in one step. */
export function pasteIntoChangeSet(
  changes: ChangeSet,
  pasted: PastedRows,
  target: PasteTarget,
): PasteResult {
  const inserted: RowKey[] = [];
  let skipped = 0;
  const next = changes.batch((draft) => {
    pasted.rows.forEach((cells, r) => {
      const valid = cells.filter((cell) => cell.value !== undefined);
      skipped += cells.length - valid.length;
      const destination = target.rows[r];
      if (destination === undefined) {
        if (target.insertRemaining === false) {
          skipped += valid.length;
          return;
        }
        const values: Record<string, EditValue> = {};
        for (const cell of valid) values[cell.column] = cell.value!;
        inserted.push(draft.insert(values));
        return;
      }
      const key = typeof destination === 'string' ? destination : destination.key;
      if (changes.status(key) === 'deleted') {
        skipped += valid.length;
        return;
      }
      for (const cell of valid) draft.edit(destination, cell.column, cell.value!);
    });
  });
  return { changes: next, inserted, skipped };
}
