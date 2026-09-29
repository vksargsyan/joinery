import {
  bsonTypeOf,
  isBsonDocument,
  type BsonDocument,
  type BsonTypeName,
  type BsonValue,
} from './bson';
import { formatShellInline } from './shell/format';

/**
 * The table view of documents (spec §9): top-level fields become columns (optionally with
 * sub-document fields flattened into dotted columns), and a cell holding a sub-document or an
 * array offers a drill-down path. Drilling in re-runs `tableView` with that path: a
 * sub-document becomes one row per document, an array one row per element.
 */

/** A path into a document: field names and array indexes. */
export type DocumentPath = readonly (string | number)[];

export interface TableViewOptions {
  /** Drill-down path from each document's root; `[]` (default) shows the documents. */
  readonly path?: DocumentPath;
  /** Sub-document levels flattened into dotted columns; 0 (default) keeps them as one cell. */
  readonly expandDepth?: number;
  /** Most columns shown; the rest are dropped and `truncatedColumns` set. Default 500. */
  readonly maxColumns?: number;
  /** Longest cell text; default 200 characters. */
  readonly maxCellLength?: number;
}

export interface TableColumn {
  /** Dotted label, e.g. "address.city"; "" for the value column of non-document rows. */
  readonly key: string;
  /** Field names from the row value to the cell. */
  readonly path: readonly string[];
  /** Types seen in the column, most frequent first. */
  readonly types: readonly BsonTypeName[];
}

export interface TableCell {
  /** `missing` when the row has no such field. */
  readonly type: BsonTypeName | 'missing';
  /** Display text: strings as they are, other values in shell form, containers summarised. */
  readonly text: string;
  /** For documents and arrays: the path (from the document root) to drill into. */
  readonly drill?: DocumentPath;
}

export interface TableRow {
  /** Index of the source document in the input. */
  readonly document: number;
  /** Path from the source document's root to this row's value. */
  readonly path: DocumentPath;
  readonly cells: readonly TableCell[];
}

export interface TableView {
  readonly columns: readonly TableColumn[];
  readonly rows: readonly TableRow[];
  readonly truncatedColumns: boolean;
}

/** The value at `path` inside `value`, or undefined when the path does not exist. */
export function valueAtPath(value: BsonValue, path: DocumentPath): BsonValue | undefined {
  let current: BsonValue | undefined = value;
  for (const part of path) {
    if (Array.isArray(current) && typeof part === 'number') {
      current = current[part];
    } else if (isBsonDocument(current) && typeof part === 'string') {
      current = Object.prototype.hasOwnProperty.call(current, part) ? current[part] : undefined;
    } else {
      return undefined;
    }
    if (current === undefined) return undefined;
  }
  return current;
}

/**
 * A copy of `root` with the value at `path` replaced (or, when `value` is undefined, the field
 * removed or the element spliced out). Field order is kept. Throws when the path's parent does
 * not exist.
 */
export function withValueAt(
  root: BsonValue,
  path: DocumentPath,
  value: BsonValue | undefined,
): BsonValue {
  if (path.length === 0) {
    if (value === undefined) throw new RangeError('Cannot remove the root value');
    return value;
  }
  const [head, ...rest] = path;
  if (Array.isArray(root) && typeof head === 'number') {
    if (head < 0 || head > root.length) throw new RangeError(`No element ${head}`);
    const copy = root.slice();
    if (rest.length === 0 && value === undefined) copy.splice(head, 1);
    else copy[head] = withValueAt(root[head] ?? {}, rest, value);
    return copy;
  }
  if (isBsonDocument(root) && typeof head === 'string') {
    const copy: BsonDocument = {};
    let found = false;
    for (const key of Object.keys(root)) {
      if (key !== head) {
        Object.defineProperty(copy, key, {
          value: root[key],
          enumerable: true,
          writable: true,
          configurable: true,
        });
        continue;
      }
      found = true;
      if (rest.length === 0 && value === undefined) continue;
      Object.defineProperty(copy, key, {
        value: rest.length === 0 ? value : withValueAt(root[key]!, rest, value),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    if (!found && value !== undefined) {
      if (rest.length > 0) throw new RangeError(`No field "${head}"`);
      Object.defineProperty(copy, head, {
        value,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return copy;
  }
  throw new RangeError(`Cannot follow "${String(head)}" into a ${bsonTypeOf(root)}`);
}

/** "{ 3 fields }" / "[ 5 elements ]" for containers; undefined for other values. */
export function containerSummary(value: BsonValue): string | undefined {
  if (Array.isArray(value)) {
    return `[ ${value.length} element${value.length === 1 ? '' : 's'} ]`;
  }
  if (isBsonDocument(value)) {
    const n = Object.keys(value).length;
    return `{ ${n} field${n === 1 ? '' : 's'} }`;
  }
  return undefined;
}

/** A value's table cell text. */
export function cellText(value: BsonValue, maxLength = 200): string {
  const summary = containerSummary(value);
  if (summary !== undefined) return summary;
  if (typeof value === 'string') {
    return value.length > maxLength ? `${value.slice(0, maxLength)}…` : value;
  }
  const text = formatShellInline(value, { maxStringLength: maxLength });
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

interface ColumnState {
  readonly key: string;
  readonly path: readonly string[];
  readonly types: Map<BsonTypeName, number>;
}

/** Builds the table view of `documents` (see the module comment). */
export function tableView(
  documents: readonly BsonValue[],
  options: TableViewOptions = {},
): TableView {
  const basePath = options.path ?? [];
  const expandDepth = options.expandDepth ?? 0;
  const maxColumns = options.maxColumns ?? 500;
  const maxCell = options.maxCellLength ?? 200;

  const rowsIn: { document: number; path: DocumentPath; value: BsonValue }[] = [];
  documents.forEach((doc, index) => {
    const value = valueAtPath(doc, basePath);
    if (value === undefined) return;
    if (Array.isArray(value) && basePath.length > 0) {
      value.forEach((item, i) =>
        rowsIn.push({ document: index, path: [...basePath, i], value: item }),
      );
    } else {
      rowsIn.push({ document: index, path: basePath, value });
    }
  });

  const columns = new Map<string, ColumnState>();
  let truncatedColumns = false;
  const column = (path: readonly string[]): ColumnState | undefined => {
    const key = path.join('.');
    let state = columns.get(key);
    if (!state) {
      if (columns.size >= maxColumns) {
        truncatedColumns = true;
        return undefined;
      }
      state = { key, path, types: new Map() };
      columns.set(key, state);
    }
    return state;
  };
  const collect = (value: BsonDocument, prefix: readonly string[], depth: number): void => {
    for (const key of Object.keys(value)) {
      const child = value[key]!;
      const path = [...prefix, key];
      if (isBsonDocument(child) && depth < expandDepth && Object.keys(child).length > 0) {
        collect(child, path, depth + 1);
        continue;
      }
      const state = column(path);
      if (state) {
        const type = bsonTypeOf(child);
        state.types.set(type, (state.types.get(type) ?? 0) + 1);
      }
    }
  };
  for (const row of rowsIn) {
    if (isBsonDocument(row.value)) {
      collect(row.value, [], 0);
    } else {
      const state = column([]);
      if (state) {
        const type = bsonTypeOf(row.value);
        state.types.set(type, (state.types.get(type) ?? 0) + 1);
      }
    }
  }

  const ordered = [...columns.values()];
  const rows: TableRow[] = rowsIn.map((row) => ({
    document: row.document,
    path: row.path,
    cells: ordered.map((col): TableCell => {
      const value =
        col.path.length === 0
          ? isBsonDocument(row.value)
            ? undefined
            : row.value
          : valueAtPath(row.value, col.path);
      if (value === undefined) return { type: 'missing', text: '' };
      const type = bsonTypeOf(value);
      const cell: TableCell = { type, text: cellText(value, maxCell) };
      if (Array.isArray(value) || isBsonDocument(value)) {
        return { ...cell, drill: [...row.path, ...col.path] };
      }
      return cell;
    }),
  }));

  return {
    columns: ordered.map((col) => ({
      key: col.key,
      path: col.path,
      types: [...col.types.entries()].sort((a, b) => b[1] - a[1]).map(([type]) => type),
    })),
    rows,
    truncatedColumns,
  };
}
