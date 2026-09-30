/**
 * Column layout of a data grid (spec §7: hide, reorder, pin and resize columns): which columns
 * show, in what order, which are frozen at the left, and their widths. Shared by the table data
 * grid (keyed by column name, saved with table views) and the query result grid (keyed by
 * position, since a result can repeat a name). Pure; the grids map display positions to the
 * model's column indexes through `displayColumns`, one array lookup per cell.
 *
 * Invariant: every column is listed once, in display order, pinned columns first.
 */

export interface LayoutColumn {
  readonly key: string;
  /** Set once the user resized the column; the grid's own width otherwise. */
  readonly width?: number;
  readonly hidden?: boolean;
  /** Frozen at the left edge while the grid scrolls sideways. */
  readonly pinned?: boolean;
}

export interface ColumnLayout {
  readonly columns: readonly LayoutColumn[];
}

/** Narrowest and widest a resized column may be. */
export const MIN_COLUMN_WIDTH = 40;
export const MAX_COLUMN_WIDTH = 2000;

/** The natural layout: every column shown, in the model's order, none pinned or resized. */
export function naturalLayout(keys: readonly string[]): ColumnLayout {
  return { columns: keys.map((key) => ({ key })) };
}

/** Pinned columns first, keeping each group's order. */
function normalise(columns: readonly LayoutColumn[]): LayoutColumn[] {
  return [...columns.filter((c) => c.pinned), ...columns.filter((c) => !c.pinned)];
}

/**
 * A layout for the columns the grid has now: known columns keep their place and settings,
 * columns the layout does not know are appended (shown), and columns that went away are dropped.
 * Undefined gives the natural layout.
 */
export function reconcileLayout(
  layout: ColumnLayout | undefined,
  keys: readonly string[],
): ColumnLayout {
  if (!layout) return naturalLayout(keys);
  const present = new Set(keys);
  const seen = new Set<string>();
  const kept: LayoutColumn[] = [];
  for (const column of layout.columns) {
    if (!present.has(column.key) || seen.has(column.key)) continue;
    seen.add(column.key);
    kept.push(column);
  }
  for (const key of keys) if (!seen.has(key)) kept.push({ key });
  const columns = normalise(kept);
  // Never leave a grid with nothing to show.
  if (columns.length > 0 && columns.every((c) => c.hidden)) {
    return { columns: columns.map((c) => withoutHidden(c)) };
  }
  return { columns };
}

function withoutHidden(column: LayoutColumn): LayoutColumn {
  const { hidden: _hidden, ...rest } = column;
  return rest;
}

/** What the grid draws: model column indexes in display order, and how many are frozen. */
export interface DisplayColumns {
  /** `order[displayIndex]` is the model's column index. */
  readonly order: readonly number[];
  readonly frozen: number;
  /** Widths set by the user, by display index (undefined: the grid's default). */
  readonly widths: readonly (number | undefined)[];
}

/** The visible columns of `layout` over the model's `keys` (reconciled first). */
export function displayColumns(
  layout: ColumnLayout | undefined,
  keys: readonly string[],
): DisplayColumns {
  const index = new Map(keys.map((key, i) => [key, i]));
  const order: number[] = [];
  const widths: (number | undefined)[] = [];
  let frozen = 0;
  for (const column of reconcileLayout(layout, keys).columns) {
    if (column.hidden) continue;
    const at = index.get(column.key);
    if (at === undefined) continue;
    order.push(at);
    widths.push(column.width);
    if (column.pinned) frozen++;
  }
  return { order, frozen, widths };
}

function update(
  layout: ColumnLayout,
  key: string,
  patch: (column: LayoutColumn) => LayoutColumn,
): ColumnLayout {
  return { columns: layout.columns.map((c) => (c.key === key ? patch(c) : c)) };
}

/** Hides or shows a column; the last visible column cannot be hidden. */
export function setHidden(layout: ColumnLayout, key: string, hidden: boolean): ColumnLayout {
  if (hidden && layout.columns.filter((c) => !c.hidden && c.key !== key).length === 0) {
    return layout;
  }
  return update(layout, key, (c) => (hidden ? { ...c, hidden: true } : withoutHidden(c)));
}

/** Shows every column, keeping order, pins and widths. */
export function showAll(layout: ColumnLayout): ColumnLayout {
  return { columns: layout.columns.map(withoutHidden) };
}

/**
 * Pins a column (it joins the end of the frozen block) or unpins it (it becomes the first
 * column after the frozen block).
 */
export function setPinned(layout: ColumnLayout, key: string, pinned: boolean): ColumnLayout {
  const column = layout.columns.find((c) => c.key === key);
  if (!column || Boolean(column.pinned) === pinned) return layout;
  const rest = layout.columns.filter((c) => c.key !== key);
  const block = rest.filter((c) => c.pinned).length;
  const moved: LayoutColumn = pinned
    ? { ...column, pinned: true }
    : (({ pinned: _pinned, ...other }) => other)(column);
  return { columns: [...rest.slice(0, block), moved, ...rest.slice(block)] };
}

/** Sets a column's width (clamped), as a drag on the header border does. */
export function setWidth(layout: ColumnLayout, key: string, width: number): ColumnLayout {
  const clamped = Math.round(Math.min(MAX_COLUMN_WIDTH, Math.max(MIN_COLUMN_WIDTH, width)));
  return update(layout, key, (c) => ({ ...c, width: clamped }));
}

/** Forgets a column's width, so the grid sizes it again. */
export function resetWidth(layout: ColumnLayout, key: string): ColumnLayout {
  return update(layout, key, ({ width: _width, ...rest }) => rest);
}

/**
 * Moves the visible column at display position `from` to display position `to`, as dragging a
 * header does. Hidden columns keep their place relative to their neighbours. A column dropped
 * inside the frozen block is pinned; one dropped after it is unpinned.
 */
export function moveColumn(layout: ColumnLayout, from: number, to: number): ColumnLayout {
  const visible = layout.columns.filter((c) => !c.hidden);
  const moving = visible[from];
  if (!moving || from === to || to < 0 || to >= visible.length) return layout;
  const frozen = visible.filter((c) => c.pinned).length;
  const pinned = to < frozen;
  const others = layout.columns.filter((c) => c.key !== moving.key);
  const othersVisible = others.filter((c) => !c.hidden);
  // Insert before the visible column that ends up after it, or after the last visible one.
  const anchor = othersVisible[to];
  let at = anchor ? others.indexOf(anchor) : others.length;
  if (!anchor) {
    const last = othersVisible.at(-1);
    at = last ? others.indexOf(last) + 1 : others.length;
  }
  const moved: LayoutColumn = pinned
    ? { ...moving, pinned: true }
    : (({ pinned: _pinned, ...other }) => other)(moving);
  const columns = [...others.slice(0, at), moved, ...others.slice(at)];
  return { columns: normalise(columns) };
}

/** Moves a column one visible place left (-1) or right (+1), for keyboard reordering. */
export function nudgeColumn(layout: ColumnLayout, key: string, step: -1 | 1): ColumnLayout {
  const visible = layout.columns.filter((c) => !c.hidden);
  const from = visible.findIndex((c) => c.key === key);
  if (from < 0) return layout;
  return moveColumn(layout, from, from + step);
}

/** True when the layout shows every column in the model's order, unpinned and unresized. */
export function isNaturalLayout(layout: ColumnLayout, keys: readonly string[]): boolean {
  const columns = reconcileLayout(layout, keys).columns;
  return (
    columns.length === keys.length &&
    columns.every((c, i) => c.key === keys[i] && !c.hidden && !c.pinned && c.width === undefined)
  );
}

/** How many columns are hidden, for the Columns button's label. */
export function hiddenCount(layout: ColumnLayout): number {
  return layout.columns.filter((c) => c.hidden).length;
}
