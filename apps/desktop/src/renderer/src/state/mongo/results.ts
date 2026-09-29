import {
  EJSON,
  formatShell,
  fromEjson,
  tableView,
  type BsonValue,
  type DocumentPath,
  type TableCell,
  type TableRow,
  type TableView,
} from '@joinery/mongo-tools';
import { useStore } from 'zustand';
import { createStore, type StoreApi } from 'zustand/vanilla';

/**
 * Documents shown three ways (spec §9: "Tree, table and JSON views of the same result"): a tree
 * of expandable documents with BSON type badges, a table that flattens nested fields into
 * columns and drills into arrays and sub-documents (each drill shows that value as its own
 * table, with a breadcrumb back), and read-only JSON as mongosh prints it or as relaxed
 * Extended JSON. The collection view and the console both keep their results here; documents
 * stay canonical Extended JSON and are parsed once, on first display.
 */

export type ResultMode = 'tree' | 'table' | 'json';
export type JsonStyle = 'shell' | 'ejson';

/** A drill-down: a path inside one document (the table shows the value there). */
export interface Drill {
  readonly document: number;
  readonly path: DocumentPath;
}

export interface Crumb {
  readonly label: string;
  /** undefined: back to the documents. */
  readonly drill: Drill | undefined;
}

export interface ResultsState {
  /** Canonical Extended JSON, in result order. */
  readonly documents: readonly string[];
  /** Bumped whenever `documents` changes. */
  readonly version: number;
  readonly loading: boolean;
  /** The cursor has more documents to fetch. */
  readonly hasMore: boolean;
  readonly error: string | undefined;
  readonly mode: ResultMode;
  readonly jsonStyle: JsonStyle;
  /** Table view: sub-document fields become dotted columns (two levels deep). */
  readonly flatten: boolean;
  readonly drill: Drill | undefined;
  /** Tree view: expanded nodes, by `nodeKey`. */
  readonly expanded: Readonly<Record<string, boolean>>;
}

/** Sub-document levels flattened into columns when `flatten` is on. */
export const FLATTEN_DEPTH = 2;

/** The tree view's key of a node: its document and path. */
export function nodeKey(document: number, path: DocumentPath): string {
  return `${document}:${JSON.stringify(path)}`;
}

/** "items[2].sku" for a path inside a document. */
export function pathLabel(path: DocumentPath): string {
  let out = '';
  for (const part of path)
    out += typeof part === 'number' ? `[${part}]` : out === '' ? part : `.${part}`;
  return out;
}

/** The breadcrumb of a drill: the documents, then each field or element on the way. */
export function crumbsOf(drill: Drill | undefined): Crumb[] {
  const crumbs: Crumb[] = [{ label: 'Documents', drill: undefined }];
  if (!drill) return crumbs;
  crumbs.push({
    label: `Document ${drill.document + 1}`,
    drill: { document: drill.document, path: [] },
  });
  for (let i = 1; i <= drill.path.length; i++) {
    const part = drill.path[i - 1]!;
    crumbs.push({
      label: typeof part === 'number' ? `[${part}]` : part,
      drill: { document: drill.document, path: drill.path.slice(0, i) },
    });
  }
  return crumbs;
}

/** The drill a table cell leads to (undefined for scalar cells). */
export function drillInto(
  current: Drill | undefined,
  row: TableRow,
  cell: TableCell,
): Drill | undefined {
  if (cell.drill === undefined) return undefined;
  return { document: current ? current.document : row.document, path: cell.drill };
}

/**
 * The table of documents, or of the value a drill points at (one document's sub-document or
 * array). A drill to the document root shows that one document as a table.
 */
export function tableOf(
  values: readonly BsonValue[],
  drill: Drill | undefined,
  flatten: boolean,
): TableView {
  const expandDepth = flatten ? FLATTEN_DEPTH : 0;
  if (!drill) return tableView(values, { expandDepth });
  const document = values[drill.document];
  if (document === undefined) return { columns: [], rows: [], truncatedColumns: false };
  const view = tableView([document], { path: drill.path, expandDepth });
  return { ...view, rows: view.rows.map((row) => ({ ...row, document: drill.document })) };
}

/** One document as the JSON view prints it. */
export function jsonText(value: BsonValue, style: JsonStyle): string {
  return style === 'shell'
    ? formatShell(value)
    : EJSON.stringify(value, undefined, 2, { relaxed: true });
}

/** A store of documents and how they are shown; `fetchMore` pulls the next page, if any. */
export class DocumentResults {
  readonly store: StoreApi<ResultsState>;
  #parsed: BsonValue[] = [];
  #parsedVersion = -1;
  #fetchMore: (() => Promise<void>) | undefined;

  constructor(initial: Partial<Pick<ResultsState, 'mode' | 'jsonStyle' | 'flatten'>> = {}) {
    this.store = createStore<ResultsState>()(() => ({
      documents: [],
      version: 0,
      loading: false,
      hasMore: false,
      error: undefined,
      mode: initial.mode ?? 'tree',
      jsonStyle: initial.jsonStyle ?? 'shell',
      flatten: initial.flatten ?? true,
      drill: undefined,
      expanded: {},
    }));
  }

  get state(): ResultsState {
    return this.store.getState();
  }

  #set(patch: Partial<ResultsState>): void {
    this.store.setState(patch);
  }

  /** The parsed documents (BSON values), parsed once per change. */
  values(): readonly BsonValue[] {
    const s = this.state;
    if (this.#parsedVersion !== s.version) {
      this.#parsed = s.documents.map((doc) => fromEjson(doc, 'document'));
      this.#parsedVersion = s.version;
    }
    return this.#parsed;
  }

  /** Starts a new result: no documents, loading, drill and expansion reset. */
  begin(fetchMore?: () => Promise<void>): void {
    this.#fetchMore = fetchMore;
    this.#set({
      documents: [],
      version: this.state.version + 1,
      loading: true,
      hasMore: false,
      error: undefined,
      drill: undefined,
      expanded: {},
    });
  }

  /** Appends a page; `hasMore` says whether the cursor may have more. */
  append(documents: readonly string[], hasMore: boolean): void {
    this.#set({
      documents: [...this.state.documents, ...documents],
      version: this.state.version + 1,
      loading: false,
      hasMore,
    });
  }

  fail(message: string): void {
    this.#set({ loading: false, hasMore: false, error: message });
  }

  setLoading(loading: boolean): void {
    this.#set({ loading });
  }

  /** Replaces one document (after an edit), keeping the view where it is. */
  replaceAt(index: number, document: string): void {
    const documents = [...this.state.documents];
    if (index < 0 || index >= documents.length) return;
    documents[index] = document;
    this.#set({ documents, version: this.state.version + 1 });
  }

  /** Removes one document (after a delete). */
  removeAt(index: number): void {
    const documents = this.state.documents.filter((_doc, i) => i !== index);
    this.#set({ documents, version: this.state.version + 1, drill: undefined });
  }

  /** Loads the next page when the view shows documents near the end. */
  onVisibleEnd(): void {
    const s = this.state;
    if (s.hasMore && !s.loading && this.#fetchMore) void this.#fetchMore();
  }

  setMode(mode: ResultMode): void {
    this.#set({ mode });
  }

  setJsonStyle(jsonStyle: JsonStyle): void {
    this.#set({ jsonStyle });
  }

  setFlatten(flatten: boolean): void {
    this.#set({ flatten });
  }

  setDrill(drill: Drill | undefined): void {
    this.#set({ drill });
  }

  toggleNode(key: string): void {
    const expanded = { ...this.state.expanded };
    if (expanded[key]) delete expanded[key];
    else expanded[key] = true;
    this.#set({ expanded });
  }

  /** The documents as the JSON view prints them. */
  json(): string {
    const values = this.values();
    return this.state.jsonStyle === 'shell'
      ? values.map((value) => formatShell(value)).join('\n')
      : EJSON.stringify([...values], undefined, 2, { relaxed: true });
  }
}

/** Subscribes a component to part of a result's state. */
export function useResults<T>(results: DocumentResults, selector: (state: ResultsState) => T): T {
  return useStore(results.store, selector);
}
