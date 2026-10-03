import { FILTER_OPERATORS, type SortTerm } from '@querybara/table-data';
import type { GridLayout, GridView, GridViewTable } from '@querybara/ipc';
import { z } from 'zod';

import type { ColumnLayout, LayoutColumn } from '../grid-layout';
import { emptyFilter, hasConditions, type FilterDraft, type GroupDraft } from './filter-draft';

/**
 * Saved table views (spec §7, "save views per table"): what a view keeps — the column layout,
 * the server-side sort and the filter bar (builder or raw WHERE) — and how it is written to and
 * read from the local store. The filter goes as versioned JSON text and is validated on the way
 * back, so a view written by another version degrades to "no filter" instead of breaking.
 */

/** The filter bar's state as a view keeps it. */
export interface SavedFilter {
  readonly mode: 'visual' | 'raw';
  readonly draft: GroupDraft;
  readonly raw: string;
}

/** Everything a view restores. */
export interface ViewState {
  readonly layout: ColumnLayout;
  readonly sort: readonly SortTerm[];
  readonly filter: SavedFilter;
}

const conditionSchema = z.object({
  id: z.string().min(1),
  type: z.literal('condition'),
  column: z.string(),
  operator: z.enum(FILTER_OPERATORS),
  text: z.string(),
  text2: z.string(),
  caseSensitive: z.boolean(),
  disabled: z.boolean(),
});

const groupSchema: z.ZodType<GroupDraft> = z.lazy(() =>
  z.object({
    id: z.string().min(1),
    type: z.literal('group'),
    combinator: z.enum(['and', 'or']),
    children: z.array(z.union([conditionSchema, groupSchema]) as z.ZodType<FilterDraft>),
    disabled: z.boolean(),
  }),
);

const savedFilterSchema = z.object({
  v: z.literal(1),
  mode: z.enum(['visual', 'raw']),
  draft: groupSchema,
  raw: z.string(),
});

/** The table a view belongs to, as the store keys it. */
export function viewTable(target: {
  readonly profileId: string;
  readonly database: string | undefined;
  readonly schema: string;
  readonly name: string;
}): GridViewTable {
  return {
    profileId: target.profileId,
    database: target.database ?? null,
    schema: target.schema,
    table: target.name,
  };
}

/** True when the filter bar holds nothing worth keeping. */
export function isEmptyFilter(filter: SavedFilter): boolean {
  return filter.mode === 'raw' ? filter.raw.trim() === '' : !hasConditions(filter.draft);
}

/** The filter as the store keeps it; null for an empty filter bar. */
export function serialiseFilter(filter: SavedFilter): string | null {
  if (isEmptyFilter(filter)) return null;
  return JSON.stringify({ v: 1, mode: filter.mode, draft: filter.draft, raw: filter.raw });
}

/** A stored filter, or the empty filter when there is none or it no longer reads. */
export function parseFilter(text: string | null): SavedFilter {
  const empty: SavedFilter = { mode: 'visual', draft: emptyFilter(), raw: '' };
  if (text === null) return empty;
  try {
    const parsed = savedFilterSchema.safeParse(JSON.parse(text));
    if (!parsed.success) return empty;
    const { mode, draft, raw } = parsed.data;
    return { mode, draft, raw };
  } catch {
    return empty;
  }
}

/** A grid layout as the store keeps it (keys are column names). */
export function toStoredLayout(layout: ColumnLayout): GridLayout {
  return {
    columns: layout.columns.map((column) => ({
      name: column.key,
      ...(column.width === undefined ? {} : { width: column.width }),
      ...(column.hidden ? { hidden: true } : {}),
      ...(column.pinned ? { pinned: true } : {}),
    })),
  };
}

export function fromStoredLayout(stored: GridLayout): ColumnLayout {
  return {
    columns: stored.columns.map((column): LayoutColumn => ({
      key: column.name,
      ...(column.width === undefined ? {} : { width: column.width }),
      ...(column.hidden ? { hidden: true } : {}),
      ...(column.pinned ? { pinned: true } : {}),
    })),
  };
}

/** What a saved view restores. */
export function viewStateOf(view: GridView): ViewState {
  return {
    layout: fromStoredLayout(view.layout),
    sort: view.sort.map((term) => ({ ...term })),
    filter: parseFilter(view.filter),
  };
}

/** The fields of a save request for `state`. */
export function storedViewState(state: ViewState): {
  readonly layout: GridLayout;
  readonly sort: SortTerm[];
  readonly filter: string | null;
} {
  return {
    layout: toStoredLayout(state.layout),
    sort: state.sort.map((term) => ({ ...term })),
    filter: serialiseFilter(state.filter),
  };
}

/** Whether two view states would save the same (ignoring builder node ids). */
export function sameViewState(a: ViewState, b: ViewState): boolean {
  const strip = (state: ViewState): string =>
    JSON.stringify({
      layout: toStoredLayout(state.layout),
      sort: state.sort,
      filter: isEmptyFilter(state.filter)
        ? null
        : state.filter.mode === 'raw'
          ? { raw: state.filter.raw.trim() }
          : { draft: withoutIds(state.filter.draft) },
    });
  return strip(a) === strip(b);
}

function withoutIds(node: FilterDraft): unknown {
  if (node.type === 'condition') {
    const { id: _id, ...rest } = node;
    return rest;
  }
  const { id: _id, children, ...rest } = node;
  return { ...rest, children: children.map(withoutIds) };
}
