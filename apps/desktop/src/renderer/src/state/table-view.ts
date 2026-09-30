import {
  JoineryError,
  isSqlEngine,
  newId,
  type CellValue,
  type ForeignKeyDef,
  type SchemaSnapshot,
  type SqlDialect,
  type TableDef,
} from '@joinery/core';
import type { GridView } from '@joinery/ipc';
import { safetyPolicyFor } from '@joinery/sql-tools';
import {
  allColumnsIdentity,
  buildBrowseQuery,
  buildCountQuery,
  buildEstimateQuery,
  buildLookupQuery,
  buildReferencedRowQuery,
  condition,
  and,
  copyRows,
  createChangeStore,
  describeColumns,
  isDefault,
  isLargeValue,
  mapPastedRows,
  parseEstimate,
  pasteIntoChangeSet,
  rowIdentity,
  type ChangePlan,
  type ChangeStore,
  type ColumnInfo,
  type CopyFormat,
  type EditValue,
  type ExistingRow,
  type FilterGroup,
  type FilterOptions,
  type LookupQuery,
  type RowIdentity,
  type RowKey,
  type SortTerm,
  type TableRef,
} from '@joinery/table-data';
import { useStore } from 'zustand';
import { createStore, type StoreApi } from 'zustand/vanilla';

import { errorInfo, errorMessage } from '../lib/errors';
import { formatCount } from '../lib/format';
import { mainApi } from '../lib/main-client';
import { useConnections } from './connections';
import { profileById } from './data';
import { confirm, confirmRun } from './dialogs';
import {
  displayColumns,
  naturalLayout,
  reconcileLayout,
  type ColumnLayout,
  type DisplayColumns,
} from './grid-layout';
import { findTable, loadSnapshot, useMetadata } from './metadata';
import { patchPanel } from './panels';
import { SessionLane, collect } from './session-lane';
import {
  describeApplyFailure,
  mergeApplied,
  planApply,
  writeGate,
  type ApplyFailure,
} from './table/apply-flow';
import {
  checkRawCondition,
  compileDraft,
  draftFromFilter,
  emptyFilter,
  type GroupDraft,
} from './table/filter-draft';
import {
  cellErrorKey,
  cellValue,
  gridRowCount,
  insertKeys,
  loadedRecord,
  rowAt,
  type RowRef,
} from './table/grid-model';
import {
  DEFAULT_TABLE_PAGE,
  PagingController,
  type PageMove,
  type PagingOptions,
  type PagingState,
} from './table/paging';
import {
  sameViewState,
  storedViewState,
  viewStateOf,
  viewTable,
  type ViewState,
} from './table/saved-views';
import { nextSort } from './table/sort';

/**
 * One table data view (spec §7): the table's definition from the metadata cache, its rows
 * paged from its own session, server-side sort and filter, counts, the staged changes with
 * undo, and Apply through the connection host. React reads it through `useTableState`; the
 * grid, form and JSON views all show the same rows.
 */

/** A table to open. */
export interface TableTarget {
  readonly profileId: string;
  /** The database: PostgreSQL sessions connect to it; the table's database on MySQL/MariaDB. */
  readonly database: string | undefined;
  /** PostgreSQL schema; the database on MySQL/MariaDB. */
  readonly schema: string;
  readonly name: string;
}

export type ViewMode = 'grid' | 'form' | 'json';

export interface Notice {
  readonly kind: 'info' | 'success' | 'error';
  readonly text: string;
}

export interface TableViewState {
  readonly status: 'loading' | 'ready' | 'error';
  readonly error: string | undefined;
  readonly dialect: SqlDialect | undefined;
  readonly table: TableDef | undefined;
  readonly columns: readonly ColumnInfo[];
  /** The table's own key (primary or unique), or `none`. */
  readonly keyIdentity: RowIdentity;
  /** What rows are matched by: the key, or all columns once the user accepted it. */
  readonly identity: RowIdentity;
  /** The profile is locked read-only: nothing can be staged. */
  readonly readOnlyProfile: boolean;
  readonly sort: readonly SortTerm[];
  readonly draft: GroupDraft;
  readonly filterMode: 'visual' | 'raw';
  readonly rawText: string;
  readonly filterIssues: Readonly<Record<string, string>>;
  readonly rawIssue: { readonly message: string; readonly position: number } | undefined;
  /** The filter the loaded rows were read with. */
  readonly active: { readonly filter?: FilterGroup; readonly rawWhere?: string };
  readonly paging: PagingState;
  /** undefined while loading; null when the server has no estimate. */
  readonly estimate: number | null | undefined;
  readonly exactCount: number | undefined;
  readonly counting: boolean;
  readonly viewMode: ViewMode;
  /** The record the form view shows, as a grid row index. */
  readonly formIndex: number;
  /** Paste errors by `cellErrorKey`. */
  readonly cellErrors: Readonly<Record<string, string>>;
  readonly notice: Notice | undefined;
  readonly applying: boolean;
  /** The structure changed while changes were staged: refresh to see it. */
  readonly stale: boolean;
  /** Which columns the grid shows, in what order, pinned and sized (spec §7). */
  readonly layout: ColumnLayout;
  /** The table's saved views, its default first. */
  readonly views: readonly GridView[];
  /** The saved view last applied or saved; undefined for the plain table. */
  readonly activeViewId: string | undefined;
}

export type ApplyOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly cancelled: true }
  | { readonly ok: false; readonly cancelled: false; readonly failure: ApplyFailure };

export interface LookupOption {
  /** Values of the referenced key columns, in foreign key order. */
  readonly values: readonly CellValue[];
  readonly label: string | null;
}

const NONE: RowIdentity = { kind: 'none', columns: [] };

function toCount(value: CellValue | undefined): number | undefined {
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint' || typeof value === 'string') {
    const n = Number(value);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

const PAGE_SIZE_KEY = 'joinery.table.pageSize';

/** The page size last chosen, kept in this browser profile (a convenience, not a setting). */
function readPageSize(): number {
  try {
    const stored = Number(localStorage.getItem(PAGE_SIZE_KEY));
    return Number.isInteger(stored) && stored >= 1 && stored <= 100_000
      ? stored
      : DEFAULT_TABLE_PAGE;
  } catch {
    return DEFAULT_TABLE_PAGE;
  }
}

function savePageSize(size: number): void {
  try {
    localStorage.setItem(PAGE_SIZE_KEY, String(size));
  } catch {
    // Not kept: the next view starts with the default.
  }
}

export class TableView {
  readonly id: string;
  readonly target: TableTarget;
  readonly store: StoreApi<TableViewState>;
  readonly changes: ChangeStore;
  readonly #lane: SessionLane;
  readonly #paging: PagingController;
  #snapshot: SchemaSnapshot | undefined;
  #countExecution: string | undefined;
  #metadataVersion: number;
  readonly #unsubscribe: (() => void)[] = [];
  /** Opened on a foreign key's row: the default view must not replace that filter. */
  readonly #pinnedFilter: boolean;
  #display:
    { layout: ColumnLayout; columns: readonly ColumnInfo[]; value: DisplayColumns } | undefined;

  constructor(id: string, target: TableTarget, options: { readonly filter?: FilterGroup } = {}) {
    this.id = id;
    this.target = target;
    this.#pinnedFilter = options.filter !== undefined;
    this.#paging = new PagingController(
      (query, signal) =>
        this.#lane.run(async (host, sessionId) => {
          const result = await collect(host, sessionId, query, { signal });
          return result.rows;
        }),
      () => this.store.setState({ paging: this.#paging.state }),
      readPageSize(),
    );
    const draft = options.filter ? draftFromFilter(options.filter) : emptyFilter();
    this.store = createStore<TableViewState>()(() => ({
      status: 'loading',
      error: undefined,
      dialect: undefined,
      table: undefined,
      columns: [],
      keyIdentity: NONE,
      identity: NONE,
      readOnlyProfile: false,
      sort: [],
      draft,
      filterMode: 'visual',
      rawText: '',
      filterIssues: {},
      rawIssue: undefined,
      active: options.filter ? { filter: options.filter } : {},
      paging: this.#paging.state,
      estimate: undefined,
      exactCount: undefined,
      counting: false,
      viewMode: 'grid',
      formIndex: 0,
      cellErrors: {},
      notice: undefined,
      applying: false,
      stale: false,
      layout: { columns: [] },
      views: [],
      activeViewId: undefined,
    }));
    this.changes = createChangeStore();
    this.#lane = new SessionLane(target.profileId, target.database);
    this.#metadataVersion = useMetadata.getState().versions[target.profileId] ?? 0;
    this.#unsubscribe.push(
      this.changes.subscribe(() => patchPanel(id, { dirty: !this.changes.getSnapshot().isEmpty })),
      useMetadata.subscribe((state) => {
        const version = state.versions[target.profileId] ?? 0;
        if (version === this.#metadataVersion) return;
        this.#metadataVersion = version;
        if (this.changes.getSnapshot().isEmpty) void this.refreshDefinition();
        else this.#set({ stale: true });
      }),
    );
  }

  get state(): TableViewState {
    return this.store.getState();
  }

  #set(patch: Partial<TableViewState>): void {
    this.store.setState(patch);
  }

  get tableRef(): TableRef {
    return { schema: this.target.schema, name: this.target.name };
  }

  /** Rows can be staged: a key (or accepted all-columns match) and a writable profile. */
  get editable(): boolean {
    const s = this.state;
    return s.status === 'ready' && s.identity.kind !== 'none' && !s.readOnlyProfile;
  }

  /** Loads the definition and the first page. */
  async init(): Promise<void> {
    this.#set({ status: 'loading', error: undefined });
    try {
      const profile = await profileById(this.target.profileId);
      if (!profile)
        throw new JoineryError({ code: 'NOT_FOUND', message: 'The connection was deleted' });
      if (!isSqlEngine(profile.engine)) {
        throw new JoineryError({
          code: 'NOT_SUPPORTED',
          message: 'Table data needs a SQL connection',
        });
      }
      this.#set({ dialect: profile.engine, readOnlyProfile: profile.presentation.readOnly });
      await this.#loadDefinition();
      await this.#loadViews();
      const initial = this.state.views.find((view) => view.isDefault);
      if (initial) this.#adoptViewState(viewStateOf(initial), initial.id);
      await this.reload();
    } catch (error) {
      this.#set({ status: 'error', error: errorMessage(error) });
    }
  }

  async #loadDefinition(): Promise<void> {
    const dialect = this.state.dialect!;
    const { profileId, database, schema, name } = this.target;
    const snapshot = await loadSnapshot(profileId, {
      dialect,
      ...(database !== undefined ? { database } : {}),
      ...(dialect === 'postgres' ? { schemas: [schema] } : {}),
    });
    const table = findTable(snapshot, schema, name);
    if (!table) {
      throw new JoineryError({
        code: 'NOT_FOUND',
        message: `Table ${schema}.${name} was not found; it may have been dropped or renamed`,
      });
    }
    this.#snapshot = snapshot;
    const columns = describeColumns(table, { dialect, snapshot, schema });
    const keyIdentity = rowIdentity(table);
    const accepted = this.state.identity.kind === 'all-columns' && keyIdentity.kind === 'none';
    const identity = accepted ? allColumnsIdentity(table, { dialect }) : keyIdentity;
    const names = new Set(columns.map((c) => c.name));
    this.#set({
      status: 'ready',
      error: undefined,
      table,
      columns,
      keyIdentity,
      identity,
      sort: this.state.sort.filter((term) => names.has(term.column)),
      stale: false,
      layout: reconcileLayout(
        this.state.layout.columns.length === 0 ? undefined : this.state.layout,
        columns.map((c) => c.name),
      ),
    });
  }

  #filterOptions(): FilterOptions {
    const s = this.state;
    return {
      dialect: s.dialect!,
      table: this.tableRef,
      columns: s.columns,
      ...(s.active.filter ? { filter: s.active.filter } : {}),
      ...(s.active.rawWhere !== undefined ? { rawWhere: s.active.rawWhere } : {}),
    };
  }

  #pagingOptions(): PagingOptions {
    return { ...this.#filterOptions(), identity: this.state.identity, sort: this.state.sort };
  }

  /** Reads the rows again from the first page, and the estimate. */
  async reload(): Promise<void> {
    if (this.state.status !== 'ready') return;
    this.#set({ exactCount: undefined, cellErrors: {}, formIndex: 0 });
    const loading = this.#paging.reset(this.#pagingOptions()).catch((error: unknown) => {
      this.#set({ notice: { kind: 'error', text: errorMessage(error) } });
    });
    void this.#refreshEstimate();
    await loading;
    const error = this.#paging.state.error;
    if (error !== undefined) this.#set({ notice: { kind: 'error', text: errorMessage(error) } });
  }

  /**
   * Shows another page (asks first when changes are staged: their rows may leave the grid). The
   * last page takes the exact count, counted first when it is not known yet.
   */
  async goToPage(move: PageMove | 'last'): Promise<void> {
    if (this.state.status !== 'ready') return;
    if (!(await this.confirmDiscard('Changing the page'))) return;
    let target: PageMove = move === 'last' ? 1 : move;
    if (move === 'last') {
      if (this.state.exactCount === undefined) await this.countExactly();
      const count = this.state.exactCount;
      if (count === undefined) return;
      target = Math.max(1, Math.ceil(count / this.#paging.pageSize));
    }
    this.#set({ cellErrors: {}, formIndex: 0 });
    await this.#paging.goTo(target);
    const error = this.#paging.state.error;
    if (error !== undefined) this.#set({ notice: { kind: 'error', text: errorMessage(error) } });
  }

  /** Rows per page, kept for every table; the view starts over on the first page. */
  async setPageSize(size: number): Promise<void> {
    if (size === this.#paging.pageSize || this.state.status !== 'ready') return;
    if (!(await this.confirmDiscard('Changing the page size'))) return;
    savePageSize(size);
    this.#set({ cellErrors: {}, formIndex: 0 });
    await this.#paging.reset(this.#pagingOptions(), size).catch((error: unknown) => {
      this.#set({ notice: { kind: 'error', text: errorMessage(error) } });
    });
  }

  /** Asks before dropping staged changes; true when there are none or the user agreed. */
  async confirmDiscard(action: string): Promise<boolean> {
    const counts = this.changes.getSnapshot().counts;
    const total = counts.edited + counts.inserted + counts.deleted;
    if (total === 0) return true;
    const ok = await confirm({
      title: 'Discard staged changes?',
      message: `${action} discards ${total} staged ${total === 1 ? 'row change' : 'row changes'} that were not applied.`,
      confirmLabel: 'Discard changes',
      danger: true,
    });
    if (ok) this.changes.reset();
    return ok;
  }

  /** Refresh: the definition and rows again (asks first when changes are staged). */
  async refresh(): Promise<void> {
    if (!(await this.confirmDiscard('Refreshing'))) return;
    await this.refreshDefinition();
  }

  async refreshDefinition(): Promise<void> {
    try {
      await this.#loadDefinition();
      this.changes.reset();
      await this.reload();
    } catch (error) {
      this.#set({ status: 'error', error: errorMessage(error) });
    }
  }

  async toggleSort(column: string, additive: boolean): Promise<void> {
    if (!(await this.confirmDiscard('Sorting reloads the rows and'))) return;
    this.#set({ sort: nextSort(this.state.sort, column, additive) });
    await this.reload();
  }

  /** Sorts by one column alone (the header menu), or drops it from the sort with null. */
  async sortBy(column: string, direction: 'asc' | 'desc' | null): Promise<void> {
    if (!(await this.confirmDiscard('Sorting reloads the rows and'))) return;
    this.#set({
      sort:
        direction === null
          ? this.state.sort.filter((term) => term.column !== column)
          : [{ column, direction }],
    });
    await this.reload();
  }

  setDraft(draft: GroupDraft): void {
    this.#set({ draft });
  }

  setFilterMode(mode: 'visual' | 'raw'): void {
    this.#set({ filterMode: mode, filterIssues: {}, rawIssue: undefined });
  }

  setRawText(text: string): void {
    this.#set({ rawText: text, rawIssue: undefined });
  }

  /** Runs the filter being edited (visual or raw); problems are shown instead of running. */
  async applyFilter(): Promise<void> {
    const s = this.state;
    if (!s.dialect) return;
    let active: TableViewState['active'];
    if (s.filterMode === 'visual') {
      const compiled = compileDraft(s.draft, s.columns, s.dialect);
      if (Object.keys(compiled.issues).length > 0) {
        this.#set({ filterIssues: compiled.issues });
        return;
      }
      active = compiled.filter ? { filter: compiled.filter } : {};
    } else {
      const check = checkRawCondition(s.rawText, s.dialect);
      if (check && !check.ok) {
        this.#set({ rawIssue: { message: check.message, position: check.position } });
        return;
      }
      active = s.rawText.trim() === '' ? {} : { rawWhere: s.rawText };
    }
    if (!(await this.confirmDiscard('Filtering reloads the rows and'))) return;
    this.#set({ active, filterIssues: {}, rawIssue: undefined });
    await this.reload();
  }

  async clearFilter(): Promise<void> {
    if (!(await this.confirmDiscard('Clearing the filter reloads the rows and'))) return;
    this.#set({
      draft: emptyFilter(),
      rawText: '',
      active: {},
      filterIssues: {},
      rawIssue: undefined,
    });
    await this.reload();
  }

  async #refreshEstimate(): Promise<void> {
    this.#set({ estimate: undefined });
    try {
      const options = this.#filterOptions();
      const read = async (
        method?: 'explain',
      ): Promise<{ estimate: number | null; catalog: boolean }> => {
        const query = buildEstimateQuery(method ? { ...options, method } : options);
        const result = await this.#lane.run((host, sessionId) => collect(host, sessionId, query));
        return {
          estimate: parseEstimate(
            query,
            result.columns.map((c) => c.name),
            result.rows,
          ),
          catalog: query.source === 'pg-class' || query.source === 'mysql-table-rows',
        };
      };
      const first = await read();
      // A table never analysed has no catalog estimate; ask the planner instead.
      const estimate =
        first.estimate === null && first.catalog
          ? (await read('explain')).estimate
          : first.estimate;
      this.#set({ estimate });
    } catch {
      this.#set({ estimate: null });
    }
  }

  /** Count exactly (spec §7: total count on demand). */
  async countExactly(): Promise<void> {
    if (this.state.counting) return;
    const executionId = newId();
    this.#countExecution = executionId;
    this.#set({ counting: true });
    try {
      const query = buildCountQuery(this.#filterOptions());
      const result = await this.#lane.run((host, sessionId) =>
        collect(host, sessionId, query, { executionId }),
      );
      const count = toCount(result.rows[0]?.[0]);
      if (count !== undefined) this.#set({ exactCount: count });
    } catch (error) {
      if (errorInfo(error).code !== 'CANCELLED') {
        this.#set({ notice: { kind: 'error', text: `Count failed: ${errorMessage(error)}` } });
      }
    } finally {
      this.#countExecution = undefined;
      this.#set({ counting: false });
    }
  }

  /** Cancels a running exact count on the server. */
  cancelCount(): void {
    const current = this.#lane.current;
    const executionId = this.#countExecution;
    if (current && executionId) {
      void current.host.cancel({ sessionId: current.sessionId, executionId }).catch(() => {});
    }
  }

  /**
   * Accepts matching rows on every column for a table without a key (after its warning was
   * shown): the rows reload with that identity and can be edited.
   */
  async acceptAllColumns(): Promise<void> {
    const s = this.state;
    if (!s.table || !s.dialect || s.keyIdentity.kind !== 'none') return;
    this.#set({ identity: allColumnsIdentity(s.table, { dialect: s.dialect }) });
    this.changes.reset();
    await this.reload();
  }

  // -------------------------------------------------------------------------------------------
  // Column layout and saved views (spec §7: hide, reorder, pin and resize; save views per table)

  /** The grid's visible columns: model indexes in display order, frozen count and widths. */
  get display(): DisplayColumns {
    const { layout, columns } = this.state;
    const cached = this.#display;
    if (cached && cached.layout === layout && cached.columns === columns) return cached.value;
    const value = displayColumns(
      layout,
      columns.map((c) => c.name),
    );
    this.#display = { layout, columns, value };
    return value;
  }

  /** The model's column index of a grid (display) column. */
  modelColumn(display: number): number | undefined {
    return this.display.order[display];
  }

  /** The visible columns in display order (what paste and copy work across). */
  displayedColumns(): ColumnInfo[] {
    const columns = this.state.columns;
    return this.display.order.map((i) => columns[i]!);
  }

  setLayout(layout: ColumnLayout): void {
    this.#set({ layout });
  }

  /** What a saved view would keep right now. */
  viewState(): ViewState {
    const s = this.state;
    return {
      layout: s.layout,
      sort: s.sort,
      filter: { mode: s.filterMode, draft: s.draft, raw: s.rawText },
    };
  }

  /** The applied view has changes not saved into it (or the plain table was changed). */
  viewModified(): boolean {
    const s = this.state;
    const active = s.views.find((view) => view.id === s.activeViewId);
    if (active) return !sameViewState(this.viewState(), viewStateOf(active));
    const names = s.columns.map((c) => c.name);
    return !sameViewState(this.viewState(), {
      layout: naturalLayout(names),
      sort: [],
      filter: { mode: 'visual', draft: emptyFilter(), raw: '' },
    });
  }

  async #loadViews(): Promise<void> {
    try {
      const views = await mainApi().gridViews.list(viewTable(this.target));
      this.#set({ views });
    } catch (error) {
      this.#set({
        views: [],
        notice: { kind: 'error', text: `Saved views could not be read: ${errorMessage(error)}` },
      });
    }
  }

  /** Puts a view's layout, sort and filter in place (without reading rows). */
  #adoptViewState(state: ViewState, id: string | undefined): void {
    const s = this.state;
    const names = s.columns.map((c) => c.name);
    const known = new Set(names);
    const patch: Partial<TableViewState> = {
      layout: reconcileLayout(state.layout, names),
      sort: state.sort.filter((term) => known.has(term.column)),
      activeViewId: id,
      filterIssues: {},
      rawIssue: undefined,
    };
    if (!this.#pinnedFilter || id === undefined) {
      const { filter } = state;
      let active: TableViewState['active'] = {};
      let issues: Readonly<Record<string, string>> = {};
      if (filter.mode === 'raw') {
        if (filter.raw.trim() !== '') active = { rawWhere: filter.raw };
      } else if (s.dialect) {
        const compiled = compileDraft(filter.draft, s.columns, s.dialect);
        issues = compiled.issues;
        if (Object.keys(issues).length === 0 && compiled.filter) {
          active = { filter: compiled.filter };
        }
      }
      Object.assign(patch, {
        draft: filter.draft,
        filterMode: filter.mode,
        rawText: filter.raw,
        active,
        filterIssues: issues,
      });
    }
    this.#set(patch);
  }

  /**
   * Applies a saved view, or the plain table (natural layout, no sort, no filter) with null,
   * and reads the rows again.
   */
  async applyView(id: string | null): Promise<void> {
    const view = id === null ? undefined : this.state.views.find((v) => v.id === id);
    if (id !== null && !view) return;
    if (!(await this.confirmDiscard('Switching the view reloads the rows and'))) return;
    this.#adoptViewState(
      view
        ? viewStateOf(view)
        : {
            layout: naturalLayout(this.state.columns.map((c) => c.name)),
            sort: [],
            filter: { mode: 'visual', draft: emptyFilter(), raw: '' },
          },
      view?.id,
    );
    await this.reload();
  }

  /** Saves the current layout, sort and filter as a new named view. */
  async saveViewAs(name: string, options: { readonly makeDefault?: boolean } = {}): Promise<void> {
    const saved = await mainApi().gridViews.save({
      ...viewTable(this.target),
      name,
      ...(options.makeDefault ? { isDefault: true } : {}),
      ...storedViewState(this.viewState()),
    });
    await this.#loadViews();
    this.#set({
      activeViewId: saved.id,
      notice: { kind: 'success', text: `Saved view "${name}"` },
    });
  }

  /** Saves the current layout, sort and filter into an existing view. */
  async updateView(id: string): Promise<void> {
    const view = this.state.views.find((v) => v.id === id);
    if (!view) return;
    await mainApi().gridViews.save({
      ...viewTable(this.target),
      id,
      name: view.name,
      isDefault: view.isDefault,
      ...storedViewState(this.viewState()),
      expectedVersion: view.version,
    });
    await this.#loadViews();
    this.#set({ activeViewId: id, notice: { kind: 'success', text: `Saved view "${view.name}"` } });
  }

  /** Makes a view the one the table opens with, or none with null. */
  async setDefaultView(id: string | null): Promise<void> {
    await mainApi().gridViews.setDefault({ table: viewTable(this.target), id });
    await this.#loadViews();
  }

  async deleteView(id: string): Promise<void> {
    await mainApi().gridViews.delete({ id });
    await this.#loadViews();
    if (this.state.activeViewId === id) this.#set({ activeViewId: undefined });
  }

  setViewMode(mode: ViewMode): void {
    this.#set({ viewMode: mode });
  }

  setFormIndex(index: number): void {
    const total = gridRowCount(this.#paging.state, this.changes.getSnapshot());
    const next = Math.max(0, Math.min(index, total - 1));
    this.#set({ formIndex: next });
  }

  dismissNotice(): void {
    this.#set({ notice: undefined });
  }

  // -------------------------------------------------------------------------------------------
  // Rows and cells

  /** Number of grid rows (loaded, then staged inserts). */
  rowCount(): number {
    return gridRowCount(this.#paging.state, this.changes.getSnapshot());
  }

  /** The row at a grid position. */
  rowAt(index: number): RowRef | undefined {
    return rowAt(this.#paging.state, insertKeys(this.changes.getSnapshot()), index);
  }

  /** A cell's current value (staged or loaded); `column` is an index into `columns`. */
  valueAt(ref: RowRef, column: number): EditValue | undefined {
    return cellValue(this.#paging.state, this.changes.getSnapshot(), ref, column);
  }

  /** A cell's current value by column name. */
  valueByName(ref: RowRef, name: string): EditValue | undefined {
    const at = this.#paging.state.columns.indexOf(name);
    return at < 0 ? undefined : this.valueAt(ref, at);
  }

  #existing(ref: RowRef): ExistingRow | RowKey {
    if (ref.kind === 'insert') return ref.key;
    if (ref.key === null) {
      throw new JoineryError({
        code: 'READ_ONLY',
        message: 'This table has no primary or unique key, so its rows cannot be edited',
      });
    }
    return { key: ref.key, values: loadedRecord(this.#paging.state, ref.index) };
  }

  #refuseUnlessEditable(): boolean {
    if (this.editable) return true;
    this.#set({
      notice: {
        kind: 'error',
        text: this.state.readOnlyProfile
          ? 'This connection is read-only.'
          : 'This table has no primary or unique key, so it is read-only.',
      },
    });
    return false;
  }

  #stage(update: () => void): boolean {
    if (!this.#refuseUnlessEditable()) return false;
    try {
      update();
      return true;
    } catch (error) {
      this.#set({ notice: { kind: 'error', text: errorMessage(error) } });
      return false;
    }
  }

  /** Stages a value for one cell (`column` by name). */
  setCell(ref: RowRef, column: string, value: EditValue): boolean {
    return this.setCells([{ ref, column, value }]);
  }

  /** Stages several cells at once (one undo step). */
  setCells(cells: readonly { ref: RowRef; column: string; value: EditValue }[]): boolean {
    return this.#stage(() => {
      const targets = cells.map((cell) => ({ ...cell, row: this.#existing(cell.ref) }));
      this.changes.update((changes) =>
        changes.batch((draft) => {
          for (const cell of targets) draft.edit(cell.row, cell.column, cell.value);
        }),
      );
      const errors = { ...this.state.cellErrors };
      let cleared = false;
      for (const cell of cells) {
        const key = cell.ref.key;
        if (key === null) continue;
        const errorKey = cellErrorKey(key, cell.column);
        if (errors[errorKey] !== undefined) {
          delete errors[errorKey];
          cleared = true;
        }
      }
      if (cleared) this.#set({ cellErrors: errors });
    });
  }

  /** Stages a new row (every cell DEFAULT) and returns its grid position. */
  addRow(): number | undefined {
    let position: number | undefined;
    this.#stage(() => {
      this.changes.update((changes) => changes.insert());
      position = this.rowCount() - 1;
    });
    return position;
  }

  /**
   * Stages copies of rows as new rows. Columns the server numbers or computes (auto-increment,
   * identity, generated) are left to their defaults, so the copies get their own keys.
   */
  duplicateRows(refs: readonly RowRef[]): void {
    const columns = this.state.columns;
    this.#stage(() => {
      this.changes.update((changes) =>
        changes.batch((draft) => {
          for (const ref of refs) {
            const values: Record<string, EditValue> = {};
            columns.forEach((column, i) => {
              if (column.autoIncrement || column.generated || column.readOnly !== undefined) return;
              const value = this.valueAt(ref, i);
              if (value !== undefined && !isLargeValue(value)) values[column.name] = value;
            });
            draft.insert(values);
          }
        }),
      );
    });
  }

  /** Stages deletes (a staged insert is simply dropped). */
  deleteRows(refs: readonly RowRef[]): void {
    this.#stage(() => {
      const rows = refs.map((ref) => this.#existing(ref));
      this.changes.update((changes) =>
        changes.batch((draft) => {
          for (const row of rows) draft.delete(row);
        }),
      );
    });
  }

  /** Reverts rows (or one cell of them) to what was loaded. */
  revert(refs: readonly RowRef[], column?: string): void {
    this.changes.update((changes) =>
      changes.batch((draft) => {
        for (const ref of refs) if (ref.key !== null) draft.revert(ref.key, column);
      }),
    );
  }

  undo(): void {
    this.changes.undo();
  }

  redo(): void {
    this.changes.redo();
  }

  /** Discard: drops every staged change. */
  discard(): void {
    this.changes.update((changes) => changes.discard());
    this.#set({ cellErrors: {} });
  }

  /**
   * Pastes text rows (from Excel, Google Sheets or the grid) at a grid position, where
   * `startColumn` counts the visible columns in display order: onto existing rows first, new rows
   * past the end. Cells that do not parse for their column are skipped and marked with their
   * error.
   */
  paste(startRow: number, startColumn: number, values: readonly (readonly string[])[]): void {
    if (!this.#refuseUnlessEditable() || values.length === 0) return;
    const changes = this.changes.getSnapshot();
    const pasted = mapPastedRows(values, this.displayedColumns(), startColumn);
    const targets: (ExistingRow | RowKey)[] = [];
    const total = this.rowCount();
    for (let r = startRow; r < total && targets.length < values.length; r++) {
      const ref = this.rowAt(r);
      if (!ref || (ref.kind === 'loaded' && ref.key === null)) break;
      targets.push(this.#existing(ref));
    }
    const result = pasteIntoChangeSet(changes, pasted, { rows: targets });
    this.changes.update(() => result.changes);
    const errors = { ...this.state.cellErrors };
    let inserted = 0;
    pasted.rows.forEach((cells, r) => {
      const target = targets[r];
      const key =
        target === undefined
          ? result.inserted[inserted++]
          : typeof target === 'string'
            ? target
            : target.key;
      if (key === undefined) return;
      for (const cell of cells) {
        const errorKey = cellErrorKey(key, cell.column);
        if (cell.error !== undefined) errors[errorKey] = cell.error;
        else delete errors[errorKey];
      }
    });
    const parts = [
      `Pasted ${formatCount(values.length)} ${values.length === 1 ? 'row' : 'rows'}`,
      ...(result.inserted.length > 0 ? [`${result.inserted.length} new`] : []),
      ...(pasted.errors > 0
        ? [
            `${pasted.errors} ${pasted.errors === 1 ? 'cell' : 'cells'} could not be read (marked red)`,
          ]
        : []),
      ...(pasted.overflow > 0 ? [`${pasted.overflow} past the last column dropped`] : []),
    ];
    this.#set({
      cellErrors: errors,
      notice: { kind: pasted.errors > 0 ? 'error' : 'info', text: parts.join(' · ') },
    });
  }

  /** The rows as text for the clipboard (spec §7: copy as TSV, CSV, JSON, Markdown, SQL). */
  copyText(format: CopyFormat, refs: readonly RowRef[], columnIndexes: readonly number[]): string {
    const s = this.state;
    const all = format === 'insert' || format === 'update';
    const indexes = all || columnIndexes.length === 0 ? s.columns.map((_c, i) => i) : columnIndexes;
    const rows = refs.map((ref) => indexes.map((i) => this.valueAt(ref, i) ?? null));
    return copyRows(
      rows,
      indexes.map((i) => s.columns[i]!),
      format,
      {
        dialect: s.dialect!,
        table: this.tableRef,
        identity: s.identity,
      },
    );
  }

  /** The first `limit` rows as a JSON array, for the JSON view. */
  jsonText(limit = 1_000): string {
    const refs: RowRef[] = [];
    const total = Math.min(this.rowCount(), limit);
    for (let i = 0; i < total; i++) {
      const ref = this.rowAt(i);
      if (ref && !(ref.key !== null && this.changes.getSnapshot().status(ref.key) === 'deleted')) {
        refs.push(ref);
      }
    }
    return this.copyText('json', refs, []);
  }

  // -------------------------------------------------------------------------------------------
  // Large values and foreign keys

  /**
   * The full value of a cell loaded as a preview (spec §7: large values load as a preview, the
   * full value when opened). Reads it by the row's key and keeps it in the loaded row, so it can
   * be edited afterwards. Other values come back as they are.
   */
  async fullValue(ref: RowRef, column: string): Promise<EditValue | undefined> {
    const current = this.valueByName(ref, column);
    if (!isLargeValue(current) || ref.kind !== 'loaded' || ref.key === null) return current;
    const s = this.state;
    const record = loadedRecord(this.#paging.state, ref.index);
    const filter = and(
      ...s.identity.columns.map((name) => condition(name, '=', record[name] ?? null)),
    );
    const query = buildBrowseQuery({
      ...this.#filterOptions(),
      filter,
      rawWhere: undefined,
      identity: s.identity,
      select: [column],
      limit: 1,
    });
    const result = await this.#lane.run((host, sessionId) => collect(host, sessionId, query));
    const value = result.rows[0]?.[0] ?? null;
    const state = this.#paging.state;
    const at = state.columns.indexOf(column);
    const rows = state.rows.map((row, i) =>
      i === ref.index ? row.map((cell, c) => (c === at ? value : cell)) : [...row],
    );
    this.#paging.replaceRows(rows, [...state.keys]);
    return value;
  }

  /** The foreign keys a column takes part in. */
  foreignKeysOf(column: string): ForeignKeyDef[] {
    return this.state.table?.foreignKeys.filter((fk) => fk.columns.includes(column)) ?? [];
  }

  /** The table and filter that show the row a foreign key value references, if any. */
  referencedRow(
    ref: RowRef,
    fk: ForeignKeyDef,
  ): { readonly target: TableTarget; readonly filter: FilterGroup } | undefined {
    const values: CellValue[] = [];
    for (const name of fk.columns) {
      const value = this.valueByName(ref, name);
      if (value === undefined || isDefault(value) || isLargeValue(value)) return undefined;
      values.push(value);
    }
    const query = buildReferencedRowQuery(fk, values, {
      dialect: this.state.dialect!,
      schema: this.target.schema,
    });
    if (!query) return undefined;
    const schema = query.table.schema ?? this.target.schema;
    const pg = this.state.dialect === 'postgres';
    return {
      target: {
        profileId: this.target.profileId,
        database: pg ? this.target.database : schema,
        schema,
        name: query.table.name,
      },
      filter: query.filter,
    };
  }

  /** Options for a foreign key cell's lookup dropdown, filtered by `search`. */
  async lookup(fk: ForeignKeyDef, search: string): Promise<LookupOption[]> {
    const s = this.state;
    const dialect = s.dialect!;
    const refSchema = fk.refSchema ?? this.target.schema;
    let snapshot = this.#snapshot;
    let referenced = snapshot ? findTable(snapshot, refSchema, fk.refTable) : undefined;
    if (!referenced) {
      snapshot = await loadSnapshot(this.target.profileId, {
        dialect,
        ...(dialect === 'postgres'
          ? {
              ...(this.target.database !== undefined ? { database: this.target.database } : {}),
              schemas: [refSchema],
            }
          : { database: refSchema }),
      });
      referenced = findTable(snapshot, refSchema, fk.refTable);
    }
    const query: LookupQuery = buildLookupQuery(fk, {
      dialect,
      schema: this.target.schema,
      ...(referenced
        ? {
            referencedColumns: describeColumns(referenced, {
              dialect,
              snapshot: snapshot!,
              schema: refSchema,
            }),
          }
        : {}),
      search,
      limit: 50,
    });
    const result = await this.#lane.run((host, sessionId) => collect(host, sessionId, query));
    const labelAt = query.labelColumn === null ? -1 : query.columns.indexOf(query.labelColumn);
    return result.rows.map((row) => ({
      values: query.keyColumns.map((_k, i) => row[i] ?? null),
      label: labelAt < 0 ? null : row[labelAt] === null ? 'NULL' : String(row[labelAt]),
    }));
  }

  // -------------------------------------------------------------------------------------------
  // Apply

  /** The statements Apply would run, or why the changes cannot be written. */
  planApply(): { readonly plan: ChangePlan } | { readonly error: string } {
    const s = this.state;
    const returning =
      useConnections.getState().byProfile[this.target.profileId]?.info?.capabilities.returning ??
      s.dialect !== 'mysql';
    try {
      const plan = planApply(this.changes.getSnapshot(), {
        dialect: s.dialect!,
        table: this.tableRef,
        columns: s.columns,
        identity: s.identity,
        returning,
      });
      return { plan };
    } catch (error) {
      return { error: errorMessage(error) };
    }
  }

  /**
   * Runs the plan in one transaction on the connection host, after the write-safety rules: a
   * read-only profile refuses, production always asks. On success the rows as written replace
   * the loaded ones and the staged changes are cleared.
   */
  async apply(plan: ChangePlan): Promise<ApplyOutcome> {
    // Read again: the profile may have become read-only or production since the view opened.
    const profile = await profileById(this.target.profileId);
    if (!profile) {
      return {
        ok: false,
        cancelled: false,
        failure: { conflict: false, message: 'The connection was deleted' },
      };
    }
    const gate = writeGate(
      plan.statements.map((statement) => statement.preview),
      plan.dialect,
      safetyPolicyFor(profile),
    );
    if (gate.action === 'refuse') {
      return { ok: false, cancelled: false, failure: { conflict: false, message: gate.message } };
    }
    if (gate.action === 'confirm') {
      const ok = await confirmRun(
        gate.statements,
        profile.presentation.environment === 'production',
      );
      if (!ok) return { ok: false, cancelled: true };
    }
    this.#set({ applying: true });
    patchPanel(this.id, { busy: true });
    try {
      const result = await this.#lane.run((host, sessionId) =>
        host.applyChanges({ sessionId, plan }),
      );
      const merged = mergeApplied(this.#paging.state, plan, result, this.state.identity);
      this.#paging.replaceRows(merged.rows, merged.keys);
      this.changes.reset();
      const counts = { insert: 0, update: 0, delete: 0 };
      for (const row of result.rows) counts[row.kind]++;
      const summary = [
        counts.update > 0 ? `${counts.update} updated` : '',
        counts.insert > 0 ? `${counts.insert} inserted` : '',
        counts.delete > 0 ? `${counts.delete} deleted` : '',
      ].filter(Boolean);
      this.#set({
        cellErrors: {},
        exactCount: undefined,
        notice: { kind: 'success', text: `Applied: ${summary.join(', ')}` },
      });
      if (merged.unreadable > 0) await this.reload();
      else void this.#refreshEstimate();
      return { ok: true };
    } catch (error) {
      return { ok: false, cancelled: false, failure: describeApplyFailure(errorInfo(error)) };
    } finally {
      this.#set({ applying: false });
      patchPanel(this.id, { busy: false });
    }
  }

  /** After a conflict: drop the staged changes and read the rows again. */
  async discardAndReload(): Promise<void> {
    this.changes.reset();
    await this.reload();
  }

  async dispose(): Promise<void> {
    for (const unsubscribe of this.#unsubscribe) unsubscribe();
    this.#paging.dispose();
    await this.#lane.close();
  }
}

const views = new Map<string, TableView>();

/** Creates and starts the view of a panel. */
export function createTableView(
  id: string,
  target: TableTarget,
  options: { readonly filter?: FilterGroup } = {},
): TableView {
  const view = new TableView(id, target, options);
  views.set(id, view);
  void view.init();
  return view;
}

export function getTableView(id: string): TableView | undefined {
  return views.get(id);
}

/** Closes a view's session (the panel closed). */
export async function disposeTableView(id: string): Promise<void> {
  const view = views.get(id);
  views.delete(id);
  await view?.dispose();
}

/** Subscribes a component to part of a view's state. */
export function useTableState<T>(view: TableView, selector: (state: TableViewState) => T): T {
  return useStore(view.store, selector);
}
