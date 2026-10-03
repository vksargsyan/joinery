import { QuerybaraError, type CellValue } from '@querybara/core';

import { isInsertKey, type RowKey } from './identity';
import { DEFAULT, isDefault, isLargeValue, sameValue, type EditValue } from './values';

/**
 * The pending changes model (spec §7): edits, inserts and deletes are staged and highlighted,
 * Apply writes them in one transaction, Discard reverts. A ChangeSet is an immutable snapshot,
 * so the grid can keep one per render, compare by identity and undo by keeping the previous
 * one; every query on it is a map lookup. Loaded rows are addressed by RowKey (`rowKeyOf`),
 * staged inserts by the key `insert` gave them.
 *
 * Rules:
 * - Editing a cell back to its loaded value clears the edit; a row without edits drops out.
 * - Deleting a row discards its edits; editing a deleted row is refused until it is restored
 *   with `revert`.
 * - Deleting a staged insert removes it: there is nothing to delete on the server.
 * - An inserted row's cells start as DEFAULT; setting one back to DEFAULT clears it.
 * - NULL, '' and DEFAULT are distinct values everywhere.
 */

/** A loaded row: its key and the values it was loaded with, by column name. */
export interface ExistingRow {
  readonly key: RowKey;
  readonly values: Readonly<Record<string, CellValue>>;
}

/** A loaded row with staged edits, or staged for delete. */
export interface RowChange {
  readonly key: RowKey;
  /** The values the row was loaded with (they find it again and detect conflicts). */
  readonly original: Readonly<Record<string, CellValue>>;
  /** Changed cells, in the order they were first changed. */
  readonly edits: ReadonlyMap<string, EditValue>;
  readonly deleted: boolean;
}

/** A row staged for insert: the cells set so far (every other cell is DEFAULT). */
export interface RowInsert {
  readonly key: RowKey;
  readonly values: ReadonlyMap<string, EditValue>;
}

export type RowStatus = 'unchanged' | 'edited' | 'deleted' | 'inserted';

export interface ChangeCounts {
  readonly edited: number;
  readonly deleted: number;
  readonly inserted: number;
  /** Edited cells across edited rows. */
  readonly cells: number;
}

function refuse(message: string): never {
  throw new QuerybaraError({ code: 'VALIDATION_FAILED', message });
}

function checkWritable(value: EditValue): void {
  if (isLargeValue(value))
    refuse('Load the full value before editing it; only a preview is loaded');
}

/**
 * Mutable view used inside `ChangeSet.batch`: the same operations, applied in place, so a
 * paste of thousands of cells copies the maps once.
 */
export interface ChangeDraft {
  /**
   * Stages a cell value. Loaded rows are passed as ExistingRow the first time (their loaded
   * values are needed); staged inserts and already changed rows can be passed by key.
   */
  edit(row: ExistingRow | RowKey, column: string, value: EditValue): void;
  /** Stages a new row and returns its key. Cells left out are DEFAULT. */
  insert(values?: Readonly<Record<string, EditValue>>): RowKey;
  /** Stages a delete: a loaded row (edits discarded), or drops a staged insert. */
  delete(row: ExistingRow | RowKey): void;
  /**
   * Reverts one cell (back to the loaded value, or to DEFAULT for an insert) or, without a
   * column, the whole row: its edits, its delete, or the staged insert itself.
   */
  revert(key: RowKey, column?: string): void;
  /** Drops every staged change. Insert keys keep counting up, so none is ever reused. */
  discard(): void;
}

class Draft implements ChangeDraft {
  readonly rows: Map<RowKey, RowChange>;
  readonly inserts: Map<RowKey, RowInsert>;

  constructor(
    rows: ReadonlyMap<RowKey, RowChange>,
    inserts: ReadonlyMap<RowKey, RowInsert>,
    public sequence: number,
  ) {
    this.rows = new Map(rows);
    this.inserts = new Map(inserts);
  }

  edit(row: ExistingRow | RowKey, column: string, value: EditValue): void {
    checkWritable(value);
    const key = typeof row === 'string' ? row : row.key;
    if (isInsertKey(key)) {
      const insert = this.inserts.get(key) ?? refuse(`No staged insert ${key}`);
      const values = new Map(insert.values);
      if (isDefault(value)) values.delete(column);
      else values.set(column, value);
      this.inserts.set(key, { key, values });
      return;
    }
    const current = this.rows.get(key);
    if (current?.deleted) refuse('The row is marked for deletion; restore it before editing');
    const original =
      current?.original ??
      (typeof row === 'string'
        ? refuse('Pass the loaded row the first time it is edited')
        : row.values);
    const edits = new Map(current?.edits ?? []);
    if (Object.hasOwn(original, column) && sameValue(original[column], value)) edits.delete(column);
    else edits.set(column, value);
    if (edits.size === 0) this.rows.delete(key);
    else this.rows.set(key, { key, original, edits, deleted: false });
  }

  insert(values: Readonly<Record<string, EditValue>> = {}): RowKey {
    this.sequence += 1;
    const key = `+${this.sequence}`;
    const cells = new Map<string, EditValue>();
    for (const [column, value] of Object.entries(values)) {
      checkWritable(value);
      if (!isDefault(value)) cells.set(column, value);
    }
    this.inserts.set(key, { key, values: cells });
    return key;
  }

  delete(row: ExistingRow | RowKey): void {
    const key = typeof row === 'string' ? row : row.key;
    if (isInsertKey(key)) {
      this.inserts.delete(key);
      return;
    }
    const current = this.rows.get(key);
    const original =
      current?.original ??
      (typeof row === 'string' ? refuse('Pass the loaded row to delete it') : row.values);
    this.rows.set(key, { key, original, edits: new Map(), deleted: true });
  }

  revert(key: RowKey, column?: string): void {
    if (isInsertKey(key)) {
      const insert = this.inserts.get(key);
      if (!insert) return;
      if (column === undefined) {
        this.inserts.delete(key);
        return;
      }
      const values = new Map(insert.values);
      values.delete(column);
      this.inserts.set(key, { key, values });
      return;
    }
    const current = this.rows.get(key);
    if (!current) return;
    if (column === undefined) {
      this.rows.delete(key);
      return;
    }
    if (current.deleted) return;
    const edits = new Map(current.edits);
    edits.delete(column);
    if (edits.size === 0) this.rows.delete(key);
    else this.rows.set(key, { ...current, edits });
  }

  discard(): void {
    this.rows.clear();
    this.inserts.clear();
  }
}

/** An immutable snapshot of the staged changes to one table (see the module comment). */
export class ChangeSet {
  private countsCache: ChangeCounts | undefined;

  private constructor(
    private readonly rowMap: ReadonlyMap<RowKey, RowChange>,
    private readonly insertMap: ReadonlyMap<RowKey, RowInsert>,
    private readonly sequence: number,
  ) {}

  static empty(): ChangeSet {
    return new ChangeSet(new Map(), new Map(), 0);
  }

  get isEmpty(): boolean {
    return this.rowMap.size === 0 && this.insertMap.size === 0;
  }

  get counts(): ChangeCounts {
    if (this.countsCache === undefined) {
      let edited = 0;
      let deleted = 0;
      let cells = 0;
      for (const row of this.rowMap.values()) {
        if (row.deleted) deleted++;
        else {
          edited++;
          cells += row.edits.size;
        }
      }
      this.countsCache = { edited, deleted, inserted: this.insertMap.size, cells };
    }
    return this.countsCache;
  }

  /** The key the next `insert` will get. */
  get nextInsertKey(): RowKey {
    return `+${this.sequence + 1}`;
  }

  status(key: RowKey): RowStatus {
    if (this.insertMap.has(key)) return 'inserted';
    const row = this.rowMap.get(key);
    if (!row) return 'unchanged';
    return row.deleted ? 'deleted' : 'edited';
  }

  /** The staged value of a cell, or undefined when the cell is not changed. */
  staged(key: RowKey, column: string): EditValue | undefined {
    const insert = this.insertMap.get(key);
    if (insert) return insert.values.get(column);
    return this.rowMap.get(key)?.edits.get(column);
  }

  isEdited(key: RowKey, column: string): boolean {
    const insert = this.insertMap.get(key);
    if (insert) return insert.values.has(column);
    return this.rowMap.get(key)?.edits.has(column) ?? false;
  }

  /**
   * What a cell shows: the staged value, else `loaded` for a loaded row, else DEFAULT for an
   * inserted row.
   */
  valueOf(key: RowKey, column: string, loaded?: CellValue): EditValue | undefined {
    const insert = this.insertMap.get(key);
    if (insert) return insert.values.has(column) ? insert.values.get(column) : DEFAULT;
    const edits = this.rowMap.get(key)?.edits;
    return edits?.has(column) ? edits.get(column) : loaded;
  }

  row(key: RowKey): RowChange | RowInsert | undefined {
    return this.insertMap.get(key) ?? this.rowMap.get(key);
  }

  /** Loaded rows with edits, in the order they were first changed. */
  editedRows(): RowChange[] {
    return [...this.rowMap.values()].filter((row) => !row.deleted);
  }

  deletedRows(): RowChange[] {
    return [...this.rowMap.values()].filter((row) => row.deleted);
  }

  /** Staged inserts, in insertion order. */
  insertedRows(): RowInsert[] {
    return [...this.insertMap.values()];
  }

  /** Applies several operations at once and returns the resulting snapshot. */
  batch(apply: (draft: ChangeDraft) => void): ChangeSet {
    const draft = new Draft(this.rowMap, this.insertMap, this.sequence);
    apply(draft);
    return new ChangeSet(draft.rows, draft.inserts, draft.sequence);
  }

  edit(row: ExistingRow | RowKey, column: string, value: EditValue): ChangeSet {
    return this.batch((draft) => draft.edit(row, column, value));
  }

  insert(values: Readonly<Record<string, EditValue>> = {}): ChangeSet {
    return this.batch((draft) => void draft.insert(values));
  }

  delete(row: ExistingRow | RowKey): ChangeSet {
    return this.batch((draft) => draft.delete(row));
  }

  revert(key: RowKey, column?: string): ChangeSet {
    return this.batch((draft) => draft.revert(key, column));
  }

  discard(): ChangeSet {
    return new ChangeSet(new Map(), new Map(), this.sequence);
  }
}

export type ChangeListener = () => void;

/**
 * A small observable holder for the grid: the current ChangeSet, undo and redo, and change
 * notification in the shape React's useSyncExternalStore expects.
 */
export interface ChangeStore {
  getSnapshot(): ChangeSet;
  subscribe(listener: ChangeListener): () => void;
  /** Replaces the snapshot with `update(current)`; a no-op when it returns the same one. */
  update(update: (changes: ChangeSet) => ChangeSet): void;
  undo(): boolean;
  redo(): boolean;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  /** Starts over (after Apply or a reload), clearing history. */
  reset(changes?: ChangeSet): void;
}

/** A ChangeStore starting at `initial`, keeping up to `historyLimit` undo steps (200). */
export function createChangeStore(
  initial: ChangeSet = ChangeSet.empty(),
  options: { readonly historyLimit?: number } = {},
): ChangeStore {
  const limit = options.historyLimit ?? 200;
  let current = initial;
  let past: ChangeSet[] = [];
  let future: ChangeSet[] = [];
  const listeners = new Set<ChangeListener>();
  const emit = (): void => {
    for (const listener of [...listeners]) listener();
  };
  return {
    getSnapshot: () => current,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    update(update) {
      const next = update(current);
      if (next === current) return;
      past.push(current);
      if (past.length > limit) past = past.slice(past.length - limit);
      future = [];
      current = next;
      emit();
    },
    undo() {
      const previous = past.pop();
      if (!previous) return false;
      future.push(current);
      current = previous;
      emit();
      return true;
    },
    redo() {
      const next = future.pop();
      if (!next) return false;
      past.push(current);
      current = next;
      emit();
      return true;
    },
    get canUndo() {
      return past.length > 0;
    },
    get canRedo() {
      return future.length > 0;
    },
    reset(changes = ChangeSet.empty()) {
      current = changes;
      past = [];
      future = [];
      emit();
    },
  };
}
