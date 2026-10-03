import { newId } from '@querybara/core';
import { formatFindText, type SchemaAnalysis } from '@querybara/mongo-tools';
import { useStore } from 'zustand';
import { createStore, type StoreApi } from 'zustand/vanilla';

import { errorInfo, errorMessage } from '../../lib/errors';
import {
  QUERY_FIELDS,
  findTextOf,
  modelOf,
  type QueryExtras,
  type QueryField,
  type QueryFields,
  type TextIssue,
} from './query-bar';
import {
  EMPTY_BUILDER_QUERY,
  NO_ISSUES,
  addProjection,
  addSort,
  buildQuery,
  builderFields,
  moveItem,
  newCondition,
  readQuery,
  withOperator,
  type BuilderField,
  type BuilderIssues,
  type BuilderQuery,
  type Condition,
  type ConditionOperator,
  type FilterItem,
  type OrGroup,
  type ValueType,
} from './query-builder-model';

/**
 * The collection view's visual query builder (spec §9, "Browsing and editing"): the fields of a
 * schema sample to build with, and the builder's filter, projection, sort, skip and limit. It is
 * the query bar's second editor, not a second query: every valid change is written to the bar
 * as find() text (so the text, the fields and running stay the query bar's), and every change
 * to the bar from elsewhere (the text edited by hand, the fields, Reset) is read back into the
 * builder. When the bar holds a query the builder cannot show, or text that does not parse, the
 * builder says why and stays read-only until the query is simple again. While a builder change
 * is incomplete (a value still to type) the bar keeps the last valid query and running asks for
 * the fix first.
 */

export type QueryEditorMode = 'fields' | 'builder';

/** What the builder reads from the query bar. */
export interface QueryBarSnapshot {
  readonly fields: QueryFields;
  readonly extras: QueryExtras;
  readonly issues: Partial<Record<QueryField, TextIssue>>;
  readonly findIssue: TextIssue | undefined;
}

/** The collection view as the builder uses it. */
export interface QueryBuilderHost {
  readonly collection: string;
  readonly query: () => QueryBarSnapshot;
  /** Calls `listener` after every change of the view's state. */
  readonly subscribe: (listener: () => void) => () => void;
  readonly setFindText: (text: string) => void;
  /** A schema analysis of a $sample of the collection, on the view's session. */
  readonly sample: (sampleSize: number, signal: AbortSignal) => Promise<SchemaAnalysis>;
}

export interface FieldSample {
  readonly status: 'idle' | 'loading' | 'done' | 'error';
  readonly fields: readonly BuilderField[];
  readonly documentCount: number;
  readonly error: string | undefined;
}

export interface Blocked {
  /** `unsupported`: the query uses what the builder cannot show; `invalid`: the bar has an error. */
  readonly kind: 'unsupported' | 'invalid';
  readonly message: string;
}

export interface QueryBuilderState {
  readonly mode: QueryEditorMode;
  readonly query: BuilderQuery;
  readonly issues: BuilderIssues;
  /** Why the builder is read-only, if it is. */
  readonly blocked: Blocked | undefined;
  /** The first problem of a builder change the query bar does not have yet. */
  readonly pending: string | undefined;
  readonly sample: FieldSample;
  /** The field list's search text (also a path to add that is not in the sample). */
  readonly search: string;
}

/** Documents sampled for the field list. */
export const BUILDER_SAMPLE_SIZE = 1000;

const FIELD_LABELS: Readonly<Record<QueryField, string>> = {
  filter: 'Filter',
  projection: 'Projection',
  sort: 'Sort',
  skip: 'Skip',
  limit: 'Limit',
};

function snapshot(bar: QueryBarSnapshot): QueryBarSnapshot {
  return { fields: bar.fields, extras: bar.extras, issues: bar.issues, findIssue: bar.findIssue };
}

function sameBar(a: QueryBarSnapshot | undefined, b: QueryBarSnapshot): boolean {
  return (
    a !== undefined &&
    a.fields === b.fields &&
    a.extras === b.extras &&
    a.issues === b.issues &&
    a.findIssue === b.findIssue
  );
}

export class QueryBuilder {
  readonly store: StoreApi<QueryBuilderState>;
  readonly #host: QueryBuilderHost;
  readonly #unsubscribe: () => void;
  /** The query bar as last seen, to skip view changes that are not the query's. */
  #last: QueryBarSnapshot | undefined;
  /** The bar's normalised find() text the builder shows; undefined while blocked on an error. */
  #synced: string | undefined;
  #emitting = false;
  #sampling: AbortController | undefined;

  constructor(host: QueryBuilderHost) {
    this.#host = host;
    this.store = createStore<QueryBuilderState>()(() => ({
      mode: 'fields',
      query: EMPTY_BUILDER_QUERY,
      issues: NO_ISSUES,
      blocked: undefined,
      pending: undefined,
      sample: { status: 'idle', fields: [], documentCount: 0, error: undefined },
      search: '',
    }));
    this.#unsubscribe = host.subscribe(() => this.#onBarChange());
    this.#onBarChange();
  }

  get state(): QueryBuilderState {
    return this.store.getState();
  }

  #set(patch: Partial<QueryBuilderState>): void {
    this.store.setState(patch);
  }

  /** Shows the fields or the builder; the first switch to the builder samples the fields. */
  setMode(mode: QueryEditorMode): void {
    this.#set({ mode });
    if (mode === 'builder' && this.state.sample.status === 'idle') void this.loadFields();
  }

  setSearch(search: string): void {
    this.#set({ search });
  }

  /** Samples the collection for the field list (again). */
  async loadFields(): Promise<void> {
    this.#sampling?.abort();
    const controller = new AbortController();
    this.#sampling = controller;
    this.#set({ sample: { ...this.state.sample, status: 'loading', error: undefined } });
    try {
      const analysis = await this.#host.sample(BUILDER_SAMPLE_SIZE, controller.signal);
      if (this.#sampling !== controller) return;
      this.#set({
        sample: {
          status: 'done',
          fields: builderFields(analysis),
          documentCount: analysis.documentCount,
          error: undefined,
        },
      });
    } catch (error) {
      if (this.#sampling !== controller) return;
      const cancelled = controller.signal.aborted || errorInfo(error).code === 'CANCELLED';
      this.#set({
        sample: {
          ...this.state.sample,
          status: cancelled ? 'idle' : 'error',
          error: cancelled ? undefined : errorMessage(error),
        },
      });
    } finally {
      if (this.#sampling === controller) this.#sampling = undefined;
    }
  }

  /** The sampled field at a path, if the sample has it. */
  field(path: string): BuilderField | undefined {
    return this.state.sample.fields.find((f) => f.path === path);
  }

  /**
   * The problem to fix before running: a builder change the query bar does not have yet.
   * Undefined when the bar's query is the builder's (or the builder is read-only).
   */
  pendingIssue(): string | undefined {
    return this.state.blocked ? undefined : this.state.pending;
  }

  // -------------------------------------------------------------------------------------------
  // Filter

  /** Adds a condition on a field, to the top level or to an OR group; returns its id. */
  addCondition(path: string, groupId?: string): string | undefined {
    if (this.state.blocked) return undefined;
    const condition = newCondition(path, this.field(path));
    const q = this.state.query;
    const filter =
      groupId === undefined
        ? [...q.filter, condition]
        : q.filter.map((item) =>
            item.kind === 'or' && item.id === groupId
              ? { ...item, conditions: [...item.conditions, condition] }
              : item,
          );
    this.#apply({ ...q, filter });
    return condition.id;
  }

  /** Adds an OR group, with a first condition on `path` when given; returns the new ids. */
  addOrGroup(path?: string): { readonly group: string; readonly condition?: string } | undefined {
    if (this.state.blocked) return undefined;
    const condition = path === undefined ? undefined : newCondition(path, this.field(path));
    const group: OrGroup = { kind: 'or', id: newId(), conditions: condition ? [condition] : [] };
    const q = this.state.query;
    this.#apply({ ...q, filter: [...q.filter, group] });
    return { group: group.id, ...(condition ? { condition: condition.id } : {}) };
  }

  removeGroup(id: string): void {
    const q = this.state.query;
    this.#apply({ ...q, filter: q.filter.filter((item) => item.id !== id) });
  }

  removeCondition(id: string): void {
    const q = this.state.query;
    const filter: FilterItem[] = [];
    for (const item of q.filter) {
      if (item.kind === 'condition') {
        if (item.id !== id) filter.push(item);
      } else {
        filter.push({ ...item, conditions: item.conditions.filter((c) => c.id !== id) });
      }
    }
    this.#apply({ ...q, filter });
  }

  /** Changes a condition: its operator (keeping what it can of the value), value or type. */
  updateCondition(
    id: string,
    patch: {
      readonly operator?: ConditionOperator;
      readonly valueType?: ValueType;
      readonly text?: string;
      readonly flags?: string;
    },
  ): void {
    const change = (c: Condition): Condition => {
      if (c.id !== id) return c;
      let next = patch.operator ? withOperator(c, patch.operator, this.field(c.path)) : c;
      if (patch.valueType !== undefined) next = { ...next, valueType: patch.valueType };
      if (patch.text !== undefined) next = { ...next, text: patch.text };
      if (patch.flags !== undefined) next = { ...next, flags: patch.flags };
      return next;
    };
    const q = this.state.query;
    const filter = q.filter.map((item) =>
      item.kind === 'condition'
        ? change(item)
        : { ...item, conditions: item.conditions.map(change) },
    );
    this.#apply({ ...q, filter });
  }

  // -------------------------------------------------------------------------------------------
  // Projection, sort, skip and limit

  addProjection(path: string): void {
    const q = this.state.query;
    this.#apply({ ...q, projection: addProjection(q.projection, path) });
  }

  setProjection(path: string, include: boolean): void {
    const q = this.state.query;
    this.#apply({
      ...q,
      projection: q.projection.map((e) => (e.path === path ? { path, include } : e)),
    });
  }

  removeProjection(path: string): void {
    const q = this.state.query;
    this.#apply({ ...q, projection: q.projection.filter((e) => e.path !== path) });
  }

  addSort(path: string): void {
    const q = this.state.query;
    this.#apply({ ...q, sort: addSort(q.sort, path) });
  }

  setSortDirection(path: string, direction: 1 | -1): void {
    const q = this.state.query;
    this.#apply({ ...q, sort: q.sort.map((e) => (e.path === path ? { path, direction } : e)) });
  }

  /** Moves a sort key: earlier keys sort first. */
  moveSort(from: number, to: number): void {
    const q = this.state.query;
    this.#apply({ ...q, sort: moveItem(q.sort, from, to) });
  }

  removeSort(path: string): void {
    const q = this.state.query;
    this.#apply({ ...q, sort: q.sort.filter((e) => e.path !== path) });
  }

  setSkip(text: string): void {
    this.#apply({ ...this.state.query, skip: text });
  }

  setLimit(text: string): void {
    this.#apply({ ...this.state.query, limit: text });
  }

  // -------------------------------------------------------------------------------------------
  // Keeping the builder and the query bar in step

  /** Takes a builder change; when it is valid the query bar gets it as find() text. */
  #apply(query: BuilderQuery): void {
    if (this.state.blocked) return;
    const built = buildQuery(query);
    if (!built.ok) {
      this.#set({ query, issues: built.issues, pending: built.message });
      return;
    }
    this.#set({ query, issues: NO_ISSUES, pending: undefined });
    const extras = this.#host.query().extras;
    const text = formatFindText(this.#host.collection, { ...built.model, ...extras });
    this.#emitting = true;
    try {
      this.#host.setFindText(text);
    } finally {
      this.#emitting = false;
    }
    const after = this.#host.query();
    this.#last = snapshot(after);
    this.#synced = findTextOf(this.#host.collection, after.fields, after.extras);
    if (after.findIssue) this.#sync(after);
  }

  #onBarChange(): void {
    const bar = this.#host.query();
    if (sameBar(this.#last, bar)) return;
    this.#last = snapshot(bar);
    if (!this.#emitting) this.#sync(bar);
  }

  /** Reads the query bar into the builder, or blocks the builder with the reason it cannot. */
  #sync(bar: QueryBarSnapshot): void {
    const invalid = (message: string): void => {
      this.#synced = undefined;
      this.#set({ blocked: { kind: 'invalid', message }, pending: undefined });
    };
    if (bar.findIssue) {
      invalid('The find() text has an error: fix it to keep building.');
      return;
    }
    const field = QUERY_FIELDS.find((f) => bar.issues[f] !== undefined);
    if (field) {
      invalid(`The ${FIELD_LABELS[field]} field has an error: fix it to keep building.`);
      return;
    }
    const text = findTextOf(this.#host.collection, bar.fields, bar.extras);
    if (text !== undefined && text === this.#synced) return;
    this.#synced = text;
    let read;
    try {
      read = readQuery(modelOf(bar.fields, bar.extras));
    } catch (error) {
      invalid(errorMessage(error));
      return;
    }
    const unsupported = (message: string): void => {
      this.#set({ blocked: { kind: 'unsupported', message }, pending: undefined });
    };
    if (!read.ok) {
      unsupported(read.reason);
      return;
    }
    // What the builder shows must build again: e.g. $options flags MongoDB does not have.
    const built = buildQuery(read.query);
    if (!built.ok) {
      unsupported(built.message);
      return;
    }
    this.#set({ query: read.query, issues: NO_ISSUES, blocked: undefined, pending: undefined });
  }

  dispose(): void {
    this.#unsubscribe();
    this.#sampling?.abort();
    this.#sampling = undefined;
  }
}

/** Subscribes a component to part of a query builder's state. */
export function useQueryBuilder<T>(
  builder: QueryBuilder,
  selector: (state: QueryBuilderState) => T,
): T {
  return useStore(builder.store, selector);
}
