import { describe, expect, it, vi } from 'vitest';

import {
  ChangeSet,
  DEFAULT,
  createChangeStore,
  isDefault,
  sameValue,
  type ExistingRow,
} from '../src';

const row = (key: string, values: Record<string, unknown>): ExistingRow =>
  ({ key, values }) as ExistingRow;

const a = row('n1', { id: 1, name: 'a', note: null, data: new Uint8Array([1]) });
const b = row('n2', { id: 2, name: 'b', note: '' });

describe('ChangeSet', () => {
  it('stages edits and reports cell and row state', () => {
    const changes = ChangeSet.empty().edit(a, 'name', 'x').edit('n1', 'note', '');
    expect(changes.status('n1')).toBe('edited');
    expect(changes.status('n2')).toBe('unchanged');
    expect(changes.staged('n1', 'name')).toBe('x');
    expect(changes.isEdited('n1', 'note')).toBe(true);
    expect(changes.valueOf('n1', 'id', 1)).toBe(1);
    expect(changes.valueOf('n1', 'note', null)).toBe('');
    expect(changes.counts).toEqual({ edited: 1, deleted: 0, inserted: 0, cells: 2 });
    expect(ChangeSet.empty().isEmpty).toBe(true);
  });

  it('is immutable: every operation returns a new snapshot', () => {
    const empty = ChangeSet.empty();
    const edited = empty.edit(a, 'name', 'x');
    expect(empty.isEmpty).toBe(true);
    expect(edited).not.toBe(empty);
    expect(edited.edit('n1', 'name', 'y').staged('n1', 'name')).toBe('y');
    expect(edited.staged('n1', 'name')).toBe('x');
  });

  it('clears an edit set back to the loaded value, and drops the row when nothing is left', () => {
    const changes = ChangeSet.empty()
      .edit(a, 'name', 'x')
      .edit('n1', 'data', new Uint8Array([2]));
    const back = changes.edit('n1', 'name', 'a').edit('n1', 'data', new Uint8Array([1]));
    expect(back.status('n1')).toBe('unchanged');
    expect(back.isEmpty).toBe(true);
  });

  it('keeps NULL, empty string and DEFAULT distinct', () => {
    const changes = ChangeSet.empty()
      .edit(a, 'note', '')
      .edit(b, 'note', null)
      .edit(b, 'name', DEFAULT);
    expect(changes.staged('n1', 'note')).toBe('');
    expect(changes.staged('n2', 'note')).toBeNull();
    expect(isDefault(changes.staged('n2', 'name'))).toBe(true);
    expect(ChangeSet.empty().edit(a, 'note', null).isEmpty).toBe(true);
    expect(ChangeSet.empty().edit(b, 'note', '').isEmpty).toBe(true);
  });

  it('deletes rows, discarding their edits, and refuses to edit a deleted row until restored', () => {
    const changes = ChangeSet.empty().edit(a, 'name', 'x').delete('n1').delete(b);
    expect(changes.status('n1')).toBe('deleted');
    expect(changes.staged('n1', 'name')).toBeUndefined();
    expect(changes.counts).toEqual({ edited: 0, deleted: 2, inserted: 0, cells: 0 });
    expect(() => changes.edit('n1', 'name', 'y')).toThrow(/marked for deletion/);
    const restored = changes.revert('n1');
    expect(restored.status('n1')).toBe('unchanged');
    expect(restored.edit(a, 'name', 'y').status('n1')).toBe('edited');
    expect(changes.revert('n1', 'name').status('n1')).toBe('deleted');
  });

  it('needs the loaded values the first time a row is changed', () => {
    expect(() => ChangeSet.empty().edit('n9', 'name', 'x')).toThrow(/Pass the loaded row/);
    expect(() => ChangeSet.empty().delete('n9')).toThrow(/Pass the loaded row/);
  });

  it('stages inserts with DEFAULT cells, and deleting one removes it', () => {
    let changes = ChangeSet.empty();
    const key = changes.nextInsertKey;
    changes = changes.insert({ name: 'new', note: DEFAULT });
    expect(key).toBe('+1');
    expect(changes.status(key)).toBe('inserted');
    expect(isDefault(changes.valueOf(key, 'note'))).toBe(true);
    expect(changes.valueOf(key, 'name')).toBe('new');
    changes = changes.edit(key, 'note', null).edit(key, 'name', DEFAULT);
    expect(changes.valueOf(key, 'note')).toBeNull();
    expect(changes.isEdited(key, 'name')).toBe(false);
    expect(changes.insertedRows().map((r) => [...r.values])).toEqual([[['note', null]]]);
    changes = changes.revert(key, 'note');
    expect(changes.insertedRows()[0]!.values.size).toBe(0);
    const deleted = changes.delete(key);
    expect(deleted.isEmpty).toBe(true);
    expect(deleted.status(key)).toBe('unchanged');
  });

  it('never reuses insert keys, even after discard', () => {
    const changes = ChangeSet.empty().insert().insert().discard();
    expect(changes.isEmpty).toBe(true);
    expect(changes.nextInsertKey).toBe('+3');
  });

  it('reverts single cells and whole rows', () => {
    const changes = ChangeSet.empty().edit(a, 'name', 'x').edit('n1', 'note', 'y');
    expect(changes.revert('n1', 'name').editedRows()[0]!.edits).toEqual(new Map([['note', 'y']]));
    expect(changes.revert('n1', 'name').revert('n1', 'note').isEmpty).toBe(true);
    expect(changes.revert('n1').isEmpty).toBe(true);
    expect(changes.revert('missing')).toBeInstanceOf(ChangeSet);
  });

  it('applies batches in one snapshot', () => {
    const inserted: string[] = [];
    const changes = ChangeSet.empty().batch((draft) => {
      draft.edit(a, 'name', 'x');
      inserted.push(draft.insert({ name: 'p' }), draft.insert({ name: 'q' }));
      draft.delete(b);
    });
    expect(inserted).toEqual(['+1', '+2']);
    expect(changes.counts).toEqual({ edited: 1, deleted: 1, inserted: 2, cells: 1 });
    expect(changes.editedRows().map((r) => r.key)).toEqual(['n1']);
    expect(changes.deletedRows().map((r) => r.key)).toEqual(['n2']);
  });

  it('refuses large-value previews as edits', () => {
    const preview = { $handle: 'h1', preview: 'abc', byteLength: 9000, kind: 'text' as const };
    expect(() => ChangeSet.empty().edit(a, 'name', preview)).toThrow(/preview/);
  });

  it('survives structured clone', () => {
    const changes = ChangeSet.empty().edit(a, 'name', DEFAULT).insert({ note: 5n });
    const rows = structuredClone(changes.editedRows());
    expect(isDefault(rows[0]!.edits.get('name'))).toBe(true);
    expect(structuredClone(changes.insertedRows())[0]!.values.get('note')).toBe(5n);
  });
});

describe('sameValue', () => {
  it('compares cell values the way change tracking needs', () => {
    expect(sameValue(5, 5n)).toBe(true);
    expect(sameValue(null, '')).toBe(false);
    expect(sameValue(DEFAULT, { $default: true })).toBe(true);
    expect(sameValue(DEFAULT, null)).toBe(false);
    expect(sameValue(Number.NaN, Number.NaN)).toBe(true);
    expect(sameValue(0, -0)).toBe(false);
    expect(sameValue(new Uint8Array([1, 2]), new Uint8Array([1, 2]))).toBe(true);
    expect(sameValue(new Uint8Array([1]), '1')).toBe(false);
    expect(sameValue(true, 1)).toBe(false);
  });
});

describe('createChangeStore', () => {
  it('notifies subscribers and supports undo and redo', () => {
    const store = createChangeStore();
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    store.update((c) => c.edit(a, 'name', 'x'));
    store.update((c) => c.insert());
    store.update((c) => c);
    expect(listener).toHaveBeenCalledTimes(2);
    expect(store.getSnapshot().counts.inserted).toBe(1);
    expect(store.undo()).toBe(true);
    expect(store.getSnapshot().counts.inserted).toBe(0);
    expect(store.canRedo).toBe(true);
    expect(store.redo()).toBe(true);
    expect(store.getSnapshot().counts.inserted).toBe(1);
    store.reset();
    expect(store.getSnapshot().isEmpty).toBe(true);
    expect(store.canUndo).toBe(false);
    expect(store.undo()).toBe(false);
    unsubscribe();
    store.update((c) => c.insert());
    expect(listener).toHaveBeenCalledTimes(5);
  });

  it('keeps a bounded history', () => {
    const store = createChangeStore(ChangeSet.empty(), { historyLimit: 2 });
    for (let i = 0; i < 5; i++) store.update((c) => c.insert());
    expect(store.undo()).toBe(true);
    expect(store.undo()).toBe(true);
    expect(store.undo()).toBe(false);
    expect(store.getSnapshot().counts.inserted).toBe(3);
  });
});
