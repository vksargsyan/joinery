import { tableDefSchema } from '@querybara/core';
import { describe, expect, it } from 'vitest';

import {
  displayColumns,
  isNaturalLayout,
  moveColumn,
  naturalLayout,
  nudgeColumn,
  reconcileLayout,
  resetWidth,
  setHidden,
  setPinned,
  setWidth,
  showAll,
  type ColumnLayout,
} from '../src/renderer/src/state/grid-layout';
import { addChild, emptyFilter, newCondition } from '../src/renderer/src/state/table/filter-draft';
import {
  fromStoredLayout,
  parseFilter,
  sameViewState,
  serialiseFilter,
  storedViewState,
  toStoredLayout,
  viewStateOf,
  viewTable,
  type ViewState,
} from '../src/renderer/src/state/table/saved-views';
import { describeColumns } from '@querybara/table-data';

/**
 * Grid column layouts (hide, reorder, pin, resize) and saved table views: the pure models the
 * table data grid and the query result grid draw from, and what a view writes to the store.
 */

const KEYS = ['id', 'name', 'qty', 'price', 'note'];
const keys = (layout: ColumnLayout): string[] => layout.columns.map((c) => c.key);
const shown = (layout: ColumnLayout): string[] =>
  displayColumns(layout, KEYS).order.map((i) => KEYS[i]!);

describe('column layout', () => {
  it('starts natural and maps display positions to model columns', () => {
    const layout = naturalLayout(KEYS);
    expect(displayColumns(layout, KEYS)).toEqual({
      order: [0, 1, 2, 3, 4],
      frozen: 0,
      widths: [undefined, undefined, undefined, undefined, undefined],
    });
    expect(isNaturalLayout(layout, KEYS)).toBe(true);
  });

  it('hides and shows columns, never the last visible one', () => {
    let layout = setHidden(naturalLayout(KEYS), 'qty', true);
    layout = setHidden(layout, 'note', true);
    expect(shown(layout)).toEqual(['id', 'name', 'price']);
    const single = ['id', 'name', 'price'].reduce(
      (current, key) => setHidden(current, key, true),
      layout,
    );
    expect(shown(single)).toEqual(['price']);
    expect(shown(showAll(layout))).toEqual(KEYS);
    expect(isNaturalLayout(layout, KEYS)).toBe(false);
  });

  it('pins columns at the left, in the order they were pinned, and unpins them after', () => {
    let layout = setPinned(naturalLayout(KEYS), 'price', true);
    layout = setPinned(layout, 'name', true);
    expect(shown(layout)).toEqual(['price', 'name', 'id', 'qty', 'note']);
    expect(displayColumns(layout, KEYS).frozen).toBe(2);
    layout = setPinned(layout, 'price', false);
    expect(shown(layout)).toEqual(['name', 'price', 'id', 'qty', 'note']);
    expect(displayColumns(layout, KEYS).frozen).toBe(1);
  });

  it('moves columns as header drags do, pinning inside the frozen block', () => {
    const layout = moveColumn(naturalLayout(KEYS), 4, 1);
    expect(shown(layout)).toEqual(['id', 'note', 'name', 'qty', 'price']);
    const pinned = setPinned(layout, 'id', true);
    const into = moveColumn(pinned, 3, 0);
    expect(shown(into)).toEqual(['qty', 'id', 'note', 'name', 'price']);
    expect(displayColumns(into, KEYS).frozen).toBe(2);
    const out = moveColumn(into, 0, 4);
    expect(shown(out)).toEqual(['id', 'note', 'name', 'price', 'qty']);
    expect(displayColumns(out, KEYS).frozen).toBe(1);
    expect(moveColumn(layout, 1, 1)).toBe(layout);
    expect(moveColumn(layout, 1, 9)).toBe(layout);
  });

  it('keeps hidden columns in place when moving the visible ones', () => {
    const layout = setHidden(naturalLayout(KEYS), 'name', true);
    const moved = moveColumn(layout, 0, 1);
    expect(keys(moved)).toEqual(['name', 'qty', 'id', 'price', 'note']);
    expect(shown(moved)).toEqual(['qty', 'id', 'price', 'note']);
    expect(shown(nudgeColumn(moved, 'id', -1))).toEqual(['id', 'qty', 'price', 'note']);
    expect(shown(nudgeColumn(moved, 'note', 1))).toEqual(['qty', 'id', 'price', 'note']);
  });

  it('keeps widths, clamped, and forgets them on reset', () => {
    const layout = setWidth(naturalLayout(KEYS), 'name', 5);
    expect(displayColumns(layout, KEYS).widths[1]).toBe(40);
    expect(displayColumns(setWidth(layout, 'name', 260.4), KEYS).widths[1]).toBe(260);
    expect(displayColumns(resetWidth(layout, 'name'), KEYS).widths[1]).toBeUndefined();
  });

  it('follows the columns the grid has now', () => {
    const saved: ColumnLayout = {
      columns: [
        { key: 'note', pinned: true },
        { key: 'gone', hidden: true },
        { key: 'id', width: 90 },
        { key: 'name', pinned: true },
      ],
    };
    const layout = reconcileLayout(saved, KEYS);
    // Pinned first, the dropped column gone, new columns appended.
    expect(keys(layout)).toEqual(['note', 'name', 'id', 'qty', 'price']);
    expect(displayColumns(saved, KEYS)).toEqual({
      order: [4, 1, 0, 2, 3],
      frozen: 2,
      widths: [undefined, undefined, 90, undefined, undefined],
    });
    // A layout that hides every column the grid still has shows them all.
    const hidden = reconcileLayout({ columns: [{ key: 'id', hidden: true }] }, ['id']);
    expect(hidden.columns).toEqual([{ key: 'id' }]);
  });
});

describe('saved views', () => {
  const items = tableDefSchema.parse({
    name: 'items',
    columns: [
      { name: 'id', ordinal: 1, dataType: 'integer', nullable: false },
      { name: 'name', ordinal: 2, dataType: 'text', nullable: true },
    ],
    primaryKey: { name: 'items_pkey', columns: ['id'] },
  });
  const [id, name] = describeColumns(items, { dialect: 'postgres' });

  function state(overrides: Partial<ViewState> = {}): ViewState {
    return {
      layout: setPinned(setWidth(naturalLayout(['id', 'name']), 'name', 300), 'name', true),
      sort: [{ column: 'name', direction: 'desc' }],
      filter: { mode: 'visual', draft: emptyFilter(), raw: '' },
      ...overrides,
    };
  }

  it('keys a view by profile, database, schema and table', () => {
    expect(
      viewTable({ profileId: 'p1', database: undefined, schema: 'public', name: 'items' }),
    ).toEqual({ profileId: 'p1', database: null, schema: 'public', table: 'items' });
  });

  it('writes the layout by column name and reads it back', () => {
    const layout = state().layout;
    const stored = toStoredLayout(layout);
    expect(stored).toEqual({
      columns: [{ name: 'name', width: 300, pinned: true }, { name: 'id' }],
    });
    expect(fromStoredLayout(stored)).toEqual(layout);
  });

  it('round-trips the filter bar, builder or raw, and drops an empty one', () => {
    const root = emptyFilter();
    const draft = addChild(root, root.id, {
      ...newCondition(id!, 'postgres'),
      operator: '>',
      text: '3',
    });
    const visual = { mode: 'visual' as const, draft, raw: '' };
    expect(parseFilter(serialiseFilter(visual))).toEqual(visual);
    const raw = { mode: 'raw' as const, draft: emptyFilter(), raw: 'qty > 3' };
    expect(parseFilter(serialiseFilter(raw))).toMatchObject({ mode: 'raw', raw: 'qty > 3' });
    expect(serialiseFilter({ mode: 'visual', draft: emptyFilter(), raw: '' })).toBeNull();
    expect(serialiseFilter({ mode: 'raw', draft, raw: '  ' })).toBeNull();
  });

  it('reads an unreadable or foreign filter as no filter', () => {
    for (const text of ['not json', '{"v":2,"mode":"raw","raw":"x"}', '{"v":1,"mode":"visual"}']) {
      const filter = parseFilter(text);
      expect(filter.mode).toBe('visual');
      expect(filter.draft.children).toEqual([]);
    }
  });

  it('turns a stored view back into what the grid shows', () => {
    const stored = storedViewState(state());
    const view = {
      id: 'v1',
      profileId: 'p1',
      database: null,
      schema: 'public',
      table: 'items',
      name: 'Wide',
      isDefault: false,
      ...stored,
      version: 1,
      createdAt: '2026-09-29T10:00:00.000Z',
      updatedAt: '2026-09-29T10:00:00.000Z',
    };
    expect(sameViewState(viewStateOf(view), state())).toBe(true);
  });

  it('tells a changed view from an unchanged one, ignoring builder node ids', () => {
    const root = emptyFilter();
    const draft = addChild(root, root.id, { ...newCondition(name!, 'postgres'), text: 'x' });
    const a = state({ filter: { mode: 'visual', draft, raw: '' } });
    const copy = parseFilter(serialiseFilter(a.filter));
    const renumbered = {
      ...copy,
      draft: {
        ...copy.draft,
        id: 'other',
        children: copy.draft.children.map((c) => ({ ...c, id: 'n' })),
      },
    };
    expect(sameViewState(a, { ...a, filter: renumbered })).toBe(true);
    expect(sameViewState(a, { ...a, sort: [] })).toBe(false);
    expect(sameViewState(a, { ...a, layout: setHidden(a.layout, 'id', true) })).toBe(false);
  });
});
