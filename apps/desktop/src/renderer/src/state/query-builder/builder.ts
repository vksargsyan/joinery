import { newId as makeId, type SqlDialect } from '@joinery/core';
import {
  emptyQueryModel,
  generateQuery,
  parseQuery,
  type Criterion,
  type CriteriaGroup,
  type GroupItem,
  type JoinCondition,
  type JoinType,
  type OrderItem,
  type QueryIssue,
  type QueryModel,
  type SelectItem,
} from '@joinery/sql-tools';
import { useStore } from 'zustand';
import { createStore, type StoreApi } from 'zustand/vanilla';

import { errorMessage } from '../../lib/errors';
import { columnsOf, type BuilderCatalog, type CatalogEntry } from './catalog';
import * as edit from './edit';
import { placeNext, type Point } from './layout';

/**
 * One visual query builder (spec §8): the model on the canvas and in the side panels, and the
 * SQL pane kept in step with it both ways. Every builder edit regenerates the SQL; every edit
 * of the SQL is parsed back, and the builder follows when the SQL is in the subset it can show.
 * When it is not (a CTE, a UNION…) or does not parse yet, the builder keeps its last model,
 * turns read-only and says why; the SQL stays the user's and still runs as written. Running
 * and opening the SQL in an editor belong to the panel; this class holds no connection.
 */

export interface BuilderTarget {
  readonly profileId: string;
  readonly dialect: SqlDialect;
  /** The database the builder queries; the connection's own when unset. */
  readonly database?: string | undefined;
  /** PostgreSQL: the schema listed first and used for names without one. */
  readonly schema?: string | undefined;
}

/** Whether the SQL pane and the builder agree. */
export type SqlSync =
  | { readonly status: 'synced' }
  /** The SQL uses something the builder cannot show (`construct`); the builder is read-only. */
  | {
      readonly status: 'unsupported';
      readonly construct: string;
      readonly message: string;
      readonly start: number;
      readonly end: number;
    }
  /** The SQL does not parse (yet); the builder shows the last query it could read. */
  | {
      readonly status: 'invalid';
      readonly message: string;
      readonly start: number;
      readonly end: number;
    };

export type CatalogStatus =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly catalog: BuilderCatalog }
  | { readonly status: 'error'; readonly error: string };

export type SidePanel = 'columns' | 'joins' | 'criteria' | 'group' | 'sort';

/** A criterion to add: any kind, without its id (the builder assigns one). */
export type NewCriterion = Criterion extends infer C
  ? C extends Criterion
    ? Omit<C, 'id'>
    : never
  : never;

export interface QueryBuilderState {
  readonly model: QueryModel;
  /** Canvas positions of tables, by table id. */
  readonly positions: Readonly<Record<string, Point>>;
  /** The SQL pane's text. */
  readonly sql: string;
  /** Who wrote `sql` last: the builder (generated) or the user (typed). */
  readonly sqlSource: 'builder' | 'editor';
  readonly sync: SqlSync;
  /** What generateQuery found wrong with the model. */
  readonly issues: readonly QueryIssue[];
  readonly catalog: CatalogStatus;
  readonly search: string;
  readonly panel: SidePanel;
  /** The join shown in the Joins panel (a click on its edge). */
  readonly selectedJoin: string | undefined;
  /** Bumped to ask the canvas for an auto-layout once it has measured the tables. */
  readonly layoutRequest: number;
}

/** Loads the catalog of the builder's database from the metadata cache. */
export type CatalogSource = () => Promise<BuilderCatalog>;

export class QueryBuilder {
  readonly store: StoreApi<QueryBuilderState>;

  constructor(
    readonly target: BuilderTarget,
    private readonly loadCatalog: CatalogSource,
    private readonly newId: () => string = makeId,
  ) {
    const model = emptyQueryModel();
    this.store = createStore<QueryBuilderState>()(() => ({
      model,
      positions: {},
      sql: generateQuery(model, target.dialect).sql,
      sqlSource: 'builder',
      sync: { status: 'synced' },
      issues: [],
      catalog: { status: 'loading' },
      search: '',
      panel: 'columns',
      selectedJoin: undefined,
      layoutRequest: 0,
    }));
  }

  get state(): QueryBuilderState {
    return this.store.getState();
  }

  private set(patch: Partial<QueryBuilderState>): void {
    this.store.setState(patch);
  }

  /** The catalog, once loaded. */
  get catalog(): BuilderCatalog | undefined {
    const catalog = this.state.catalog;
    return catalog.status === 'ready' ? catalog.catalog : undefined;
  }

  /** True when edits of the model are refused: the SQL is not the builder's. */
  get readOnly(): boolean {
    return this.state.sync.status !== 'synced';
  }

  /**
   * Loads the catalog, then reads `sql` into the builder when given ("Open in query builder"),
   * so unqualified columns attach to their tables.
   */
  async init(sql?: string): Promise<void> {
    await this.reloadCatalog();
    // Its tables are new to the canvas, so reading it asks for a layout.
    if (sql !== undefined && sql.trim() !== '') this.setSql(sql);
  }

  /** Reads the catalog again (the structure changed); the model stays as it is. */
  async reloadCatalog(): Promise<void> {
    try {
      const catalog = await this.loadCatalog();
      this.set({ catalog: { status: 'ready', catalog } });
    } catch (error) {
      if (this.state.catalog.status !== 'ready') {
        this.set({ catalog: { status: 'error', error: errorMessage(error) } });
      }
    }
  }

  // The SQL pane

  /**
   * The user edited the SQL. It is kept as typed; when it parses into the builder's subset the
   * model follows (tables matched to the ones on the canvas, new ones laid out), otherwise the
   * builder turns read-only with the reason.
   */
  setSql(sql: string): void {
    if (sql === this.state.sql) return;
    const result = parseQuery(sql, this.target.dialect, { columnsOf: columnsOf(this.catalog) });
    if (result.status !== 'ok') {
      this.set({ sql, sqlSource: 'editor', sync: result });
      return;
    }
    const before = this.state.model;
    const model = edit.reconcile(before, result.model, this.newId);
    const known = new Set(before.tables.map((table) => table.id));
    const added = model.tables.some((table) => !known.has(table.id));
    const positions = this.positionsFor(model);
    this.set({
      sql,
      sqlSource: 'editor',
      sync: { status: 'synced' },
      model,
      positions,
      issues: generateQuery(model, this.target.dialect).issues,
      ...(added ? { layoutRequest: this.state.layoutRequest + 1 } : {}),
    });
  }

  /** Throws away SQL the builder cannot show and writes the builder's own query again. */
  revertSql(): void {
    this.apply(this.state.model, true);
  }

  // Model edits

  /** Takes a new model: regenerates the SQL and reports its issues. Refused while read-only. */
  private apply(model: QueryModel, force = false): void {
    if (this.readOnly && !force) return;
    const generated = generateQuery(model, this.target.dialect);
    this.set({
      model,
      positions: this.positionsFor(model),
      sql: generated.sql,
      sqlSource: 'builder',
      sync: { status: 'synced' },
      issues: generated.issues,
    });
  }

  private update(change: (model: QueryModel) => QueryModel): void {
    this.apply(change(this.state.model));
  }

  /** Positions of the model's tables: kept where known, new ones placed after the others. */
  private positionsFor(model: QueryModel): Record<string, Point> {
    const positions: Record<string, Point> = {};
    const placed: Point[] = [];
    for (const table of model.tables) {
      const known = this.state.positions[table.id];
      if (known) {
        positions[table.id] = known;
        placed.push(known);
      }
    }
    for (const table of model.tables) {
      if (positions[table.id]) continue;
      const point = placeNext(placed);
      positions[table.id] = point;
      placed.push(point);
    }
    return positions;
  }

  /** Adds a table from the list (at `at` when dropped on the canvas), with its FK joins. */
  addTable(entry: CatalogEntry, at?: Point): string | undefined {
    const catalog = this.catalog;
    if (!catalog || this.readOnly) return undefined;
    const { model, tableId } = edit.addTable(this.state.model, catalog, entry, this.newId);
    if (at) this.set({ positions: { ...this.state.positions, [tableId]: at } });
    this.apply(model);
    return tableId;
  }

  removeTable(tableId: string): void {
    this.update((model) => edit.removeTable(model, tableId));
  }

  setAlias(tableId: string, alias: string): void {
    this.update((model) => edit.setAlias(model, tableId, alias));
  }

  toggleColumn(tableId: string, column: string, on: boolean): void {
    this.update((model) => edit.toggleColumn(model, tableId, column, on, this.newId));
  }

  toggleStar(tableId: string, on: boolean): void {
    this.update((model) => edit.toggleStar(model, tableId, on, this.newId));
  }

  /** Canvas positions after a drag or an auto-layout; they do not touch the SQL. */
  movePositions(positions: Readonly<Record<string, Point>>): void {
    this.set({ positions: { ...this.state.positions, ...positions } });
  }

  requestLayout(): void {
    this.set({ layoutRequest: this.state.layoutRequest + 1 });
  }

  setDistinct(distinct: boolean): void {
    this.update((model) => ({ ...model, distinct }));
  }

  // Joins

  connectColumns(
    from: { readonly table: string; readonly column: string },
    to: { readonly table: string; readonly column: string },
  ): void {
    if (this.readOnly) return;
    const result = edit.connectColumns(this.state.model, from, to, this.newId);
    this.apply(result.model);
    if (result.joinId) this.set({ selectedJoin: result.joinId });
  }

  addJoin(left: string, right: string): void {
    if (this.readOnly || left === right) return;
    const model = edit.addJoin(this.state.model, left, right, this.newId);
    this.apply(model);
    this.set({ selectedJoin: model.joins.at(-1)?.id, panel: 'joins' });
  }

  setJoinType(joinId: string, type: JoinType): void {
    this.update((model) => edit.setJoinType(model, joinId, type));
  }

  swapJoin(joinId: string): void {
    this.update((model) => edit.swapJoin(model, joinId));
  }

  setJoinCondition(joinId: string, index: number, patch: Partial<JoinCondition>): void {
    this.update((model) => edit.setJoinCondition(model, joinId, index, patch));
  }

  addJoinCondition(joinId: string): void {
    this.update((model) => edit.addJoinCondition(model, joinId));
  }

  removeJoinCondition(joinId: string, index: number): void {
    this.update((model) => edit.removeJoinCondition(model, joinId, index));
  }

  removeJoin(joinId: string): void {
    this.update((model) => edit.removeJoin(model, joinId));
  }

  selectJoin(joinId: string | undefined): void {
    this.set({
      selectedJoin: joinId,
      ...(joinId === undefined ? {} : { panel: 'joins' as const }),
    });
  }

  // Select list

  addSelectItem(item: Omit<Extract<SelectItem, { kind: 'expr' }>, 'id'>): void {
    this.update((model) => ({
      ...model,
      columns: [...model.columns, { ...item, id: this.newId() }],
    }));
  }

  updateSelectItem(id: string, update: (item: SelectItem) => SelectItem): void {
    this.update((model) => ({ ...model, columns: edit.replaceItem(model.columns, id, update) }));
  }

  moveSelectItem(id: string, delta: number): void {
    this.update((model) => ({ ...model, columns: edit.moveItem(model.columns, id, delta) }));
  }

  removeSelectItem(id: string): void {
    this.update((model) => ({ ...model, columns: edit.removeItem(model.columns, id) }));
  }

  // Criteria (WHERE and HAVING)

  updateCriteria(which: 'where' | 'having', change: (group: CriteriaGroup) => CriteriaGroup): void {
    this.update((model) => ({ ...model, [which]: change(model[which]) }));
  }

  addCriterion(which: 'where' | 'having', groupId: string, criterion: NewCriterion): void {
    const withId = { ...criterion, id: this.newId() } as Criterion;
    this.updateCriteria(which, (group) => edit.addCriterion(group, groupId, withId));
  }

  patchCriterion(
    which: 'where' | 'having',
    id: string,
    update: (criterion: Criterion) => Criterion,
  ): void {
    this.updateCriteria(which, (group) => edit.updateCriterion(group, id, update));
  }

  removeCriterion(which: 'where' | 'having', id: string): void {
    this.updateCriteria(which, (group) => edit.removeCriterion(group, id));
  }

  // GROUP BY

  addGroupItem(item: Omit<GroupItem, 'id'>): void {
    this.update((model) => ({
      ...model,
      groupBy: [...model.groupBy, { ...item, id: this.newId() }],
    }));
  }

  updateGroupItem(id: string, update: (item: GroupItem) => GroupItem): void {
    this.update((model) => ({ ...model, groupBy: edit.replaceItem(model.groupBy, id, update) }));
  }

  moveGroupItem(id: string, delta: number): void {
    this.update((model) => ({ ...model, groupBy: edit.moveItem(model.groupBy, id, delta) }));
  }

  removeGroupItem(id: string): void {
    this.update((model) => ({ ...model, groupBy: edit.removeItem(model.groupBy, id) }));
  }

  groupBySelected(): void {
    this.update((model) => edit.groupBySelected(model, this.newId));
  }

  // ORDER BY and paging

  addOrderItem(item: Omit<OrderItem, 'id'>): void {
    this.update((model) => ({
      ...model,
      orderBy: [...model.orderBy, { ...item, id: this.newId() }],
    }));
  }

  updateOrderItem(id: string, update: (item: OrderItem) => OrderItem): void {
    this.update((model) => ({ ...model, orderBy: edit.replaceItem(model.orderBy, id, update) }));
  }

  moveOrderItem(id: string, delta: number): void {
    this.update((model) => ({ ...model, orderBy: edit.moveItem(model.orderBy, id, delta) }));
  }

  removeOrderItem(id: string): void {
    this.update((model) => ({ ...model, orderBy: edit.removeItem(model.orderBy, id) }));
  }

  /** LIMIT or OFFSET; undefined removes it. */
  setPaging(which: 'limit' | 'offset', value: number | undefined): void {
    this.update((model) => {
      const { [which]: _old, ...rest } = model;
      return value === undefined ? rest : { ...rest, [which]: value };
    });
  }

  // UI state

  setSearch(search: string): void {
    this.set({ search });
  }

  showPanel(panel: SidePanel): void {
    this.set({ panel });
  }

  /** The first error that stops the builder's SQL from running as built, if any. */
  get blockingIssue(): QueryIssue | undefined {
    if (this.state.sqlSource === 'editor') return undefined;
    return this.state.issues.find((issue) => issue.severity === 'error');
  }
}

export function useBuilderState<T>(
  builder: QueryBuilder,
  selector: (state: QueryBuilderState) => T,
): T {
  return useStore(builder.store, selector);
}
