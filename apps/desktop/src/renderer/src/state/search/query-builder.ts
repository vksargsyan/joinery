import {
  aggregationName,
  buildDsl,
  emptyDslModel,
  newAggregation,
  newCondition,
  newGroup,
  newRaw,
  newSort,
  readDsl,
  uniqueName,
  withOperator,
  type DslAggregation,
  type DslAggregationType,
  type DslCondition,
  type DslField,
  type DslGroup,
  type DslItem,
  type DslModel,
  type DslSortField,
  type DslSortItem,
  type DslTexts,
  type Occur,
} from '@joinery/search-tools';
import { useStore } from 'zustand';
import { createStore, type StoreApi } from 'zustand/vanilla';

/**
 * The documents view's query builder (spec §11, ADR 0024): the index's mapped fields to build
 * with, and a bool query (must, filter, should and must_not clauses: conditions, groups, nested
 * groups and clauses kept as JSON), a sort and aggregations. Like the collection view's builder
 * it is the query bar's second editor, not a second query: every complete change is written to
 * the bar's query, sort and aggregation texts, and every change of those texts from elsewhere
 * is read back. Only text that is not valid JSON stops the builder (it says which part); while
 * a change is incomplete the bar keeps the last complete query and searching asks for the fix.
 */

export type QueryEditorMode = 'text' | 'builder';

/** Where a clause goes: a section of a group. */
export interface ClauseTarget {
  readonly group: string;
  readonly occur: Occur;
}

/** The documents view as the builder uses it. */
export interface DslBuilderHost {
  readonly texts: () => DslTexts;
  /** Calls `listener` after every change of the view's state. */
  readonly subscribe: (listener: () => void) => () => void;
  readonly setTexts: (texts: DslTexts) => void;
}

export interface FieldList {
  readonly status: 'idle' | 'loading' | 'done' | 'error';
  readonly fields: readonly DslField[];
  readonly error: string | undefined;
}

export interface DslBuilderState {
  readonly mode: QueryEditorMode;
  readonly model: DslModel;
  /** What to fix, by item id. */
  readonly issues: Readonly<Record<string, string>>;
  /** What runs but may not do what was meant, by item id. */
  readonly warnings: Readonly<Record<string, string>>;
  /** Why the builder is read-only: the bar's text is not valid JSON. */
  readonly blocked: string | undefined;
  /** The first problem of a builder change the bar does not have yet. */
  readonly pending: string | undefined;
  readonly fieldList: FieldList;
  /** The field list's search text (also a path to add that the mapping does not have). */
  readonly search: string;
}

// ---------------------------------------------------------------------------------------------
// The clause tree

/** Every item of a group, depth first, with the group it is in and where. */
export function* walkItems(
  group: DslGroup,
): Generator<{ readonly item: DslItem; readonly parent: DslGroup; readonly occur: Occur }> {
  for (const occur of Object.keys(group.clauses) as Occur[]) {
    for (const item of group.clauses[occur]) {
      yield { item, parent: group, occur };
      if (item.kind === 'group') yield* walkItems(item);
    }
  }
}

/** The group with this id (the root included). */
export function findGroup(root: DslGroup, id: string): DslGroup | undefined {
  if (root.id === id) return root;
  for (const { item } of walkItems(root)) if (item.kind === 'group' && item.id === id) return item;
  return undefined;
}

/** A copy of the tree with `change` applied to every group, children first. */
function mapGroups(group: DslGroup, change: (group: DslGroup) => DslGroup): DslGroup {
  const clauses = { ...group.clauses };
  for (const occur of Object.keys(clauses) as Occur[]) {
    clauses[occur] = clauses[occur].map((item) =>
      item.kind === 'group' ? mapGroups(item, change) : item,
    );
  }
  return change({ ...group, clauses });
}

export function addClause(root: DslGroup, target: ClauseTarget, item: DslItem): DslGroup {
  return mapGroups(root, (g) =>
    g.id === target.group
      ? { ...g, clauses: { ...g.clauses, [target.occur]: [...g.clauses[target.occur], item] } }
      : g,
  );
}

export function removeClause(root: DslGroup, id: string): DslGroup {
  return mapGroups(root, (g) => {
    let changed = false;
    const clauses = { ...g.clauses };
    for (const occur of Object.keys(clauses) as Occur[]) {
      const kept = clauses[occur].filter((item) => item.id !== id);
      if (kept.length !== clauses[occur].length) {
        clauses[occur] = kept;
        changed = true;
      }
    }
    return changed ? { ...g, clauses } : g;
  });
}

export function updateClause(
  root: DslGroup,
  id: string,
  change: (item: DslItem) => DslItem,
): DslGroup {
  if (root.id === id) return change(root) as DslGroup;
  return mapGroups(root, (g) => {
    let changed = false;
    const clauses = { ...g.clauses };
    for (const occur of Object.keys(clauses) as Occur[]) {
      if (!clauses[occur].some((item) => item.id === id)) continue;
      clauses[occur] = clauses[occur].map((item) => (item.id === id ? change(item) : item));
      changed = true;
    }
    return changed ? { ...g, clauses } : g;
  });
}

/**
 * Moves a clause to another section (of its group or another one), at the end or before the
 * clause `before`. A group cannot move into itself.
 */
export function moveClause(
  root: DslGroup,
  id: string,
  target: ClauseTarget,
  before?: string,
): DslGroup {
  let moving: DslItem | undefined;
  for (const { item } of walkItems(root)) if (item.id === id) moving = item;
  if (!moving || id === before) return root;
  if (moving.kind === 'group' && findGroup(moving, target.group)) return root;
  const without = removeClause(root, id);
  return mapGroups(without, (g) => {
    if (g.id !== target.group) return g;
    const list = [...g.clauses[target.occur]];
    const at = before === undefined ? -1 : list.findIndex((item) => item.id === before);
    list.splice(at < 0 ? list.length : at, 0, moving);
    return { ...g, clauses: { ...g.clauses, [target.occur]: list } };
  });
}

/** The nested paths a group's clauses are inside (its own and its ancestors'). */
export function nestedScope(root: DslGroup, groupId: string): string[] {
  const path = (group: DslGroup, trail: string[]): string[] | undefined => {
    const here = group.path === '' ? trail : [...trail, group.path];
    if (group.id === groupId) return here;
    for (const occur of Object.keys(group.clauses) as Occur[]) {
      for (const item of group.clauses[occur]) {
        if (item.kind !== 'group') continue;
        const found = path(item, here);
        if (found) return found;
      }
    }
    return undefined;
  };
  return path(root, []) ?? [];
}

function mapAggregations(
  aggs: readonly DslAggregation[],
  change: (agg: DslAggregation) => DslAggregation | undefined,
): DslAggregation[] {
  return aggs.flatMap((agg) => {
    const next = change({ ...agg, aggs: mapAggregations(agg.aggs, change) });
    return next ? [next] : [];
  });
}

/** The aggregations beside this one (the list it is in). */
function siblingsOf(aggs: readonly DslAggregation[], id: string): readonly DslAggregation[] {
  if (aggs.some((a) => a.id === id)) return aggs;
  for (const agg of aggs) {
    const found = siblingsOf(agg.aggs, id);
    if (found.length > 0) return found;
  }
  return [];
}

export function findAggregation(
  aggs: readonly DslAggregation[],
  id: string,
): DslAggregation | undefined {
  for (const agg of aggs) {
    if (agg.id === id) return agg;
    const found = findAggregation(agg.aggs, id);
    if (found) return found;
  }
  return undefined;
}

// ---------------------------------------------------------------------------------------------
// The builder

function sameTexts(a: DslTexts | undefined, b: DslTexts): boolean {
  return a !== undefined && a.query === b.query && a.sort === b.sort && a.aggs === b.aggs;
}

const PARTS: Readonly<Record<keyof DslTexts, string>> = {
  query: 'query',
  sort: 'sort',
  aggs: 'aggregations',
};

export class DslBuilder {
  readonly store: StoreApi<DslBuilderState>;
  readonly #host: DslBuilderHost;
  readonly #unsubscribe: () => void;
  /** The bar's texts as last seen, to skip view changes that are not the query's. */
  #last: DslTexts | undefined;
  /** The bar's texts the builder shows; undefined while blocked. */
  #synced: DslTexts | undefined;
  #emitting = false;

  constructor(host: DslBuilderHost) {
    this.#host = host;
    this.store = createStore<DslBuilderState>()(() => ({
      mode: 'text',
      model: emptyDslModel(),
      issues: {},
      warnings: {},
      blocked: undefined,
      pending: undefined,
      fieldList: { status: 'idle', fields: [], error: undefined },
      search: '',
    }));
    this.#unsubscribe = host.subscribe(() => this.#onBarChange());
    this.#onBarChange();
  }

  get state(): DslBuilderState {
    return this.store.getState();
  }

  #set(patch: Partial<DslBuilderState>): void {
    this.store.setState(patch);
  }

  setMode(mode: QueryEditorMode): void {
    this.#set({ mode });
  }

  setSearch(search: string): void {
    this.#set({ search });
  }

  /** The mapped fields (from the view's mapping); the bar is read again with their types. */
  setFields(fieldList: FieldList): void {
    this.#set({ fieldList });
    if (this.state.pending === undefined) {
      this.#synced = undefined;
      this.#sync(this.#host.texts());
    }
  }

  field(path: string): DslField | undefined {
    return this.state.fieldList.fields.find((f) => f.path === path);
  }

  get #fields(): readonly DslField[] {
    return this.state.fieldList.fields;
  }

  /** The problem to fix before searching, if the bar does not have the builder's query yet. */
  pendingIssue(): string | undefined {
    return this.state.mode === 'builder' && !this.state.blocked ? this.state.pending : undefined;
  }

  /** Starts over with an empty query, sort and aggregations. */
  clear(): void {
    this.#set({ blocked: undefined });
    this.#apply(emptyDslModel());
  }

  // -------------------------------------------------------------------------------------------
  // Clauses

  /** The target a field's clause goes to by default: the root's must or filter. */
  rootTarget(occur: Occur = 'must'): ClauseTarget {
    return { group: this.state.model.query.id, occur };
  }

  /**
   * Adds a condition on a field; returns its id. A field inside a nested field goes into a
   * nested group on it (the one already in that section, or a new one), since outside one it
   * matches no document.
   */
  addCondition(path: string, target: ClauseTarget = this.rootTarget()): string | undefined {
    if (this.state.blocked) return undefined;
    const info = this.field(path);
    const condition = newCondition(path, info);
    let query = this.state.model.query;
    let into = target;
    const scope = nestedScope(query, target.group);
    for (const nested of info?.nested ?? []) {
      if (scope.includes(nested)) continue;
      const host = findGroup(query, into.group);
      const existing = host?.clauses[into.occur].find(
        (item): item is DslGroup => item.kind === 'group' && item.path === nested,
      );
      if (existing) {
        into = { group: existing.id, occur: 'must' };
      } else {
        const group = newGroup(nested);
        query = addClause(query, into, group);
        into = { group: group.id, occur: 'must' };
      }
    }
    this.#applyQuery(addClause(query, into, condition));
    return condition.id;
  }

  /** Adds a group (a nested one with a path); returns its id. */
  addGroup(target: ClauseTarget, path = ''): string | undefined {
    if (this.state.blocked) return undefined;
    const group = newGroup(path);
    this.#applyQuery(addClause(this.state.model.query, target, group));
    return group.id;
  }

  /** Adds a clause written as JSON; returns its id. */
  addRaw(target: ClauseTarget, text = '{"match_all": {}}'): string | undefined {
    if (this.state.blocked) return undefined;
    const raw = newRaw(text);
    this.#applyQuery(addClause(this.state.model.query, target, raw));
    return raw.id;
  }

  updateCondition(id: string, patch: Partial<Omit<DslCondition, 'kind' | 'id'>>): void {
    this.#applyQuery(
      updateClause(this.state.model.query, id, (item) => {
        if (item.kind !== 'condition') return item;
        const next = patch.operator ? withOperator(item, patch.operator) : item;
        return { ...next, ...patch };
      }),
    );
  }

  updateGroup(
    id: string,
    patch: { readonly minimumShouldMatch?: string; readonly path?: string },
  ): void {
    this.#applyQuery(
      updateClause(this.state.model.query, id, (item) =>
        item.kind === 'group' ? { ...item, ...patch } : item,
      ),
    );
  }

  setRaw(id: string, text: string): void {
    this.#applyQuery(
      updateClause(this.state.model.query, id, (item) =>
        item.kind === 'dsl' ? { ...item, text } : item,
      ),
    );
  }

  removeClause(id: string): void {
    this.#applyQuery(removeClause(this.state.model.query, id));
  }

  moveClause(id: string, target: ClauseTarget, before?: string): void {
    this.#applyQuery(moveClause(this.state.model.query, id, target, before));
  }

  // -------------------------------------------------------------------------------------------
  // Sort

  addSort(path: string): void {
    const sort = newSort(path, this.field(path));
    if (this.state.model.sort.some((s) => s.kind === 'field' && s.field === sort.field)) return;
    this.#applySort([...this.state.model.sort, sort]);
  }

  addRawSort(): void {
    this.#applySort([...this.state.model.sort, newRaw('{"_score": "desc"}')]);
  }

  updateSort(id: string, patch: Partial<Pick<DslSortField, 'order' | 'missing' | 'field'>>): void {
    this.#applySort(
      this.state.model.sort.map((s) =>
        s.id === id && s.kind === 'field' ? { ...s, ...patch } : s,
      ),
    );
  }

  setRawSort(id: string, text: string): void {
    this.#applySort(
      this.state.model.sort.map((s) => (s.id === id && s.kind === 'dsl' ? { ...s, text } : s)),
    );
  }

  /** Moves a sort key: earlier keys sort first. */
  moveSort(from: number, to: number): void {
    const sort = [...this.state.model.sort];
    if (to < 0 || to >= sort.length) return;
    const [item] = sort.splice(from, 1);
    if (!item) return;
    sort.splice(to, 0, item);
    this.#applySort(sort);
  }

  removeSort(id: string): void {
    this.#applySort(this.state.model.sort.filter((s) => s.id !== id));
  }

  // -------------------------------------------------------------------------------------------
  // Aggregations

  /** Adds an aggregation at the top or under a bucket aggregation; returns its id. */
  addAggregation(type: DslAggregationType | 'dsl', path: string, parent?: string): string {
    const aggs = this.state.model.aggs;
    const siblings = (
      parent === undefined ? aggs : (findAggregation(aggs, parent)?.aggs ?? [])
    ).map((a) => a.name);
    const agg = newAggregation(type, path, this.field(path), siblings);
    this.#applyAggs(
      parent === undefined
        ? [...aggs, agg]
        : mapAggregations(aggs, (a) => (a.id === parent ? { ...a, aggs: [...a.aggs, agg] } : a)),
    );
    return agg.id;
  }

  /**
   * Changes an aggregation. A new type starts from its own interval; a name the builder gave
   * follows a new type or field (by_status becomes by_team), a name the user typed stays.
   */
  updateAggregation(id: string, patch: Partial<Omit<DslAggregation, 'id' | 'aggs'>>): void {
    const aggs = this.state.model.aggs;
    const siblings = siblingsOf(aggs, id)
      .filter((a) => a.id !== id)
      .map((a) => a.name);
    this.#applyAggs(
      mapAggregations(aggs, (a) => {
        if (a.id !== id) return a;
        let next: DslAggregation = { ...a, ...patch };
        if (patch.type !== undefined && patch.type !== a.type && patch.interval === undefined) {
          const fresh = newAggregation(patch.type, next.field, this.field(next.field), []);
          next = {
            ...next,
            interval: fresh.interval,
            fixed: false,
            text: patch.type === 'dsl' ? fresh.text : next.text,
          };
        }
        const given = aggregationName(a.type, a.field);
        const named = a.name === given || a.name.startsWith(`${given}_`);
        if (named && patch.name === undefined && (next.type !== a.type || next.field !== a.field)) {
          next = { ...next, name: uniqueName(aggregationName(next.type, next.field), siblings) };
        }
        return next;
      }),
    );
  }

  removeAggregation(id: string): void {
    this.#applyAggs(mapAggregations(this.state.model.aggs, (a) => (a.id === id ? undefined : a)));
  }

  // -------------------------------------------------------------------------------------------
  // Keeping the builder and the query bar in step

  #applyQuery(query: DslGroup): void {
    this.#apply({ ...this.state.model, query });
  }

  #applySort(sort: readonly DslSortItem[]): void {
    this.#apply({ ...this.state.model, sort });
  }

  #applyAggs(aggs: readonly DslAggregation[]): void {
    this.#apply({ ...this.state.model, aggs });
  }

  /** Takes a builder change; when it is complete the query bar gets it. */
  #apply(model: DslModel): void {
    if (this.state.blocked) return;
    const built = buildDsl(model, this.#fields);
    if (!built.ok) {
      this.#set({ model, issues: built.issues, warnings: {}, pending: built.message });
      return;
    }
    this.#set({ model, issues: {}, warnings: built.warnings, pending: undefined });
    this.#emitting = true;
    try {
      this.#host.setTexts(built.texts);
    } finally {
      this.#emitting = false;
    }
    this.#last = this.#host.texts();
    this.#synced = this.#last;
  }

  #onBarChange(): void {
    const texts = this.#host.texts();
    if (sameTexts(this.#last, texts)) return;
    this.#last = texts;
    if (!this.#emitting) this.#sync(texts);
  }

  /** Reads the bar into the builder, or blocks the builder with the reason it cannot. */
  #sync(texts: DslTexts): void {
    if (sameTexts(this.#synced, texts)) return;
    const read = readDsl(texts, this.#fields);
    if (!read.ok) {
      this.#synced = undefined;
      this.#set({
        blocked: `The ${PARTS[read.part]} text is not valid JSON, so the builder cannot show it: fix it in Text mode, or start over.`,
        pending: undefined,
      });
      return;
    }
    const built = buildDsl(read.model, this.#fields);
    this.#synced = texts;
    this.#set({
      model: read.model,
      issues: built.ok ? {} : built.issues,
      warnings: built.ok ? built.warnings : {},
      blocked: undefined,
      pending: built.ok ? undefined : built.message,
    });
  }

  dispose(): void {
    this.#unsubscribe();
  }
}

/** Subscribes a component to part of a query builder's state. */
export function useDslBuilder<T>(builder: DslBuilder, selector: (state: DslBuilderState) => T): T {
  return useStore(builder.store, selector);
}
