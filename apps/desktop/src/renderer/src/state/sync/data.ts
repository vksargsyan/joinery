import type {
  DataActions,
  DataCompareOptions,
  DataComparisonSettings,
  DataResult,
  DataRowAction,
  DataRowPage,
  DataScriptPreview,
  DataTableResult,
  DataTableSettings,
  JobInfo,
  SavedComparisonSave,
} from '@querybara/ipc';
import { createStore, type StoreApi } from 'zustand/vanilla';

import { errorMessage } from '../../lib/errors';
import type { SyncApi } from './api';
import {
  jobFailure,
  pairProblem,
  parseNames,
  sideDraft,
  sideInput,
  type ProfileLookup,
  type SideDraft,
  type SideRole,
} from './sides';
import type { RunningJob } from './structure';

/**
 * Data compare (spec §13, data sync) as a view model: two sides and the options (actions,
 * ignored columns, float tolerance, trim and case rules, foreign key checks and triggers while
 * applying) → a compare job over the tables that pair by name and share a key (the others are
 * listed with the reason) → counts per table and a paged row diff grid → the sync script
 * exported, or applied in batched transactions as a job, after which the tables are compared
 * again. Per-table column subsets take effect on the next compare.
 */

export interface DataOptionsDraft {
  readonly actions: DataActions;
  /** Column names, comma-separated. */
  readonly ignoreColumns: string;
  /** A number, or empty for exact comparison. */
  readonly floatTolerance: string;
  readonly trim: 'none' | 'trailing' | 'both';
  readonly caseInsensitive: boolean;
  readonly disableForeignKeyChecks: boolean;
  readonly disableTriggers: boolean;
}

export const DEFAULT_DATA_OPTIONS: DataOptionsDraft = {
  actions: { insert: true, update: true, delete: true },
  ignoreColumns: '',
  floatTolerance: '',
  trim: 'none',
  caseInsensitive: false,
  disableForeignKeyChecks: false,
  disableTriggers: false,
};

export interface DataCompareState {
  readonly source: SideDraft;
  readonly target: SideDraft;
  readonly options: DataOptionsDraft;
  /** Per-table column subsets by table name; absent: every common column. */
  readonly tableColumns: Readonly<Record<string, readonly string[]>>;
  readonly running: RunningJob | undefined;
  readonly result: DataResult | undefined;
  /** Indexes of the tables ticked for syncing. */
  readonly checked: readonly number[];
  /** The table whose rows the grid shows. */
  readonly focused: number | undefined;
  readonly rowAction: DataRowAction;
  readonly rows: DataRowPage | undefined;
  readonly rowsLoading: boolean;
  readonly error: string | undefined;
  readonly notice: string | undefined;
  /** Options that need a new compare changed since the comparison ran. */
  readonly stale: boolean;
  readonly saved: { readonly id: string; readonly name: string } | undefined;
}

export interface DataCompareInit {
  readonly source?: Partial<SideDraft>;
  readonly target?: Partial<SideDraft>;
  readonly settings?: DataComparisonSettings;
  readonly saved?: { readonly id: string; readonly name: string };
}

function draftOf(settings: DataComparisonSettings | undefined): {
  options: DataOptionsDraft;
  tableColumns: Record<string, readonly string[]>;
} {
  const options = settings?.options;
  const tableColumns: Record<string, readonly string[]> = {};
  for (const table of settings?.tables ?? []) {
    if (table.columns !== undefined) tableColumns[table.name] = table.columns;
  }
  return {
    options: {
      actions: options?.actions ?? DEFAULT_DATA_OPTIONS.actions,
      ignoreColumns: (options?.ignoreColumns ?? []).join(', '),
      floatTolerance: options?.floatTolerance !== undefined ? String(options.floatTolerance) : '',
      trim: options?.trim ?? 'none',
      caseInsensitive: options?.caseInsensitive ?? false,
      disableForeignKeyChecks: options?.disableForeignKeyChecks ?? false,
      disableTriggers: options?.disableTriggers ?? false,
    },
    tableColumns,
  };
}

/** Rows a table needs changed for the chosen actions. */
export function pendingChanges(table: DataTableResult, actions: DataActions): number {
  return (
    (actions.insert ? table.counts.inserts : 0) +
    (actions.update ? table.counts.updates : 0) +
    (actions.delete ? table.counts.deletes : 0)
  );
}

/** Whether a table differs at all. */
export function differs(table: DataTableResult): boolean {
  return table.counts.inserts + table.counts.updates + table.counts.deletes > 0;
}

const ACTIONS: readonly DataRowAction[] = ['insert', 'update', 'delete'];

export class DataCompare {
  readonly store: StoreApi<DataCompareState>;
  readonly #api: SyncApi;
  readonly #lookup: ProfileLookup;
  #rowsRequest = 0;
  #disposed = false;

  constructor(init: DataCompareInit, api: SyncApi, lookup: ProfileLookup) {
    this.#api = api;
    this.#lookup = lookup;
    const { options, tableColumns } = draftOf(init.settings);
    this.store = createStore<DataCompareState>()(() => ({
      source: sideDraft(init.source),
      target: sideDraft(init.target),
      options,
      tableColumns,
      running: undefined,
      result: undefined,
      checked: [],
      focused: undefined,
      rowAction: 'insert',
      rows: undefined,
      rowsLoading: false,
      error: undefined,
      notice: undefined,
      stale: false,
      saved: init.saved,
    }));
  }

  get state(): DataCompareState {
    return this.store.getState();
  }

  #set(patch: Partial<DataCompareState>): void {
    if (!this.#disposed) this.store.setState(patch);
  }

  setSide(role: SideRole, patch: Partial<SideDraft>): void {
    const current = this.state[role];
    const next = { ...current, ...patch };
    if (patch.profileId !== undefined && patch.profileId !== current.profileId) {
      const profile = this.#lookup(patch.profileId);
      next.database = patch.database ?? profile?.defaultDatabase ?? '';
      next.schemas = patch.schemas ?? '';
    }
    this.#set({ [role]: next, stale: this.state.result !== undefined, error: undefined });
  }

  swapSides(): void {
    this.#set({
      source: this.state.target,
      target: this.state.source,
      stale: this.state.result !== undefined,
    });
  }

  /** Changes options; all but the actions take effect on the next compare. */
  setOptions(patch: Partial<DataOptionsDraft>): void {
    const needsCompare = Object.keys(patch).some((key) => key !== 'actions');
    this.#set({
      options: { ...this.state.options, ...patch },
      ...(needsCompare && this.state.result !== undefined ? { stale: true } : {}),
      error: undefined,
    });
  }

  /** A table's column subset (undefined: every common column), for the next compare. */
  setTableColumns(name: string, columns: readonly string[] | undefined): void {
    const { [name]: _old, ...rest } = this.state.tableColumns;
    this.#set({
      tableColumns: columns === undefined ? rest : { ...rest, [name]: columns },
      stale: this.state.result !== undefined,
    });
  }

  problem(): string | undefined {
    const { source, target, options } = this.state;
    const pair = pairProblem(source, target, this.#lookup, 'data');
    if (pair) return pair;
    if (options.floatTolerance.trim() !== '') {
      const value = Number(options.floatTolerance);
      if (!Number.isFinite(value) || value < 0) return 'The float tolerance is a number ≥ 0';
    }
    return undefined;
  }

  /** The options as the contract takes them. */
  compareOptions(): DataCompareOptions {
    const { options } = this.state;
    const ignore = parseNames(options.ignoreColumns);
    const tolerance = options.floatTolerance.trim();
    return {
      actions: options.actions,
      ...(ignore.length > 0 ? { ignoreColumns: ignore } : {}),
      ...(tolerance !== '' ? { floatTolerance: Number(tolerance) } : {}),
      ...(options.trim !== 'none' ? { trim: options.trim } : {}),
      ...(options.caseInsensitive ? { caseInsensitive: true } : {}),
      ...(options.disableForeignKeyChecks ? { disableForeignKeyChecks: true } : {}),
      ...(options.disableTriggers ? { disableTriggers: true } : {}),
    };
  }

  #tableSettings(): DataTableSettings[] | undefined {
    const entries = Object.entries(this.state.tableColumns);
    if (entries.length === 0) return undefined;
    // With subsets, the tables of the last comparison are compared again, each with its own.
    const names = this.state.result?.tables.map((t) => t.name);
    if (names === undefined) return undefined;
    return names.map((name) => ({
      name,
      ...(this.state.tableColumns[name] !== undefined
        ? { columns: [...this.state.tableColumns[name]!] }
        : {}),
    }));
  }

  /** Runs a compare job and shows its result; resolves true when it completed. */
  async compare(): Promise<boolean> {
    const problem = this.problem();
    if (problem !== undefined) {
      this.#set({ error: problem });
      return false;
    }
    const { source, target } = this.state;
    const lookup = (draft: SideDraft) =>
      draft.profileId !== undefined ? this.#lookup(draft.profileId) : undefined;
    this.#set({
      running: { jobId: undefined, kind: 'compare', phase: 'Starting…', cancelling: false },
      error: undefined,
    });
    try {
      const tables = this.#tableSettings();
      const jobId = await this.#api.compareData({
        source: sideInput(source, lookup(source)),
        target: sideInput(target, lookup(target)),
        options: this.compareOptions(),
        ...(tables !== undefined ? { tables } : {}),
      });
      if (jobId === undefined) {
        this.#set({ running: undefined });
        return false;
      }
      const job = await this.#follow(jobId, 'compare');
      if (job.state !== 'completed') {
        this.#api.discard(jobId);
        this.#set({
          running: undefined,
          ...(job.state === 'cancelled'
            ? { notice: 'The comparison was cancelled' }
            : { error: jobFailure(job) }),
        });
        return false;
      }
      if (this.#disposed) {
        this.#api.discard(jobId);
        return false;
      }
      const result = await this.#api.dataResult(jobId);
      const previous = this.state.result;
      const focused =
        result.tables.find((t) => t.name === previous?.tables[this.state.focused ?? -1]?.name) ??
        result.tables.find(differs) ??
        result.tables[0];
      this.#set({
        result,
        checked: result.tables.filter((t) => differs(t) && !t.error).map((t) => t.index),
        running: undefined,
        stale: false,
        rows: undefined,
      });
      if (previous) this.#api.discard(previous.jobId);
      if (focused) await this.focus(focused.index);
      else this.#set({ focused: undefined });
      return true;
    } catch (error) {
      this.#set({ running: undefined, error: errorMessage(error) });
      return false;
    }
  }

  async cancel(): Promise<void> {
    const running = this.state.running;
    if (!running?.jobId) return;
    this.#set({ running: { ...running, cancelling: true } });
    await this.#api.cancel(running.jobId);
  }

  toggleTable(index: number, checked: boolean): void {
    const current = new Set(this.state.checked);
    if (checked) current.add(index);
    else current.delete(index);
    this.#set({ checked: [...current].sort((a, b) => a - b) });
  }

  /** Shows a table's rows: the first action that has any. */
  async focus(index: number): Promise<void> {
    const table = this.state.result?.tables.find((t) => t.index === index);
    if (!table) return;
    const action = ACTIONS.find((a) => table.stored[a] > 0) ?? 'insert';
    this.#set({ focused: index });
    await this.showRows(action, 0);
  }

  /** Loads one page of the focused table's differences for an action. */
  async showRows(action: DataRowAction, page: number): Promise<void> {
    const { result, focused } = this.state;
    if (!result || focused === undefined) return;
    const request = ++this.#rowsRequest;
    this.#set({ rowAction: action, rowsLoading: true });
    try {
      const rows = await this.#api.dataRows({ jobId: result.jobId, table: focused, action, page });
      if (request === this.#rowsRequest) this.#set({ rows, rowsLoading: false });
    } catch (error) {
      if (request === this.#rowsRequest) {
        this.#set({ rows: undefined, rowsLoading: false, error: errorMessage(error) });
      }
    }
  }

  /** The tables and actions an apply or script covers. */
  selection(): { jobId: string; tables: number[]; actions: DataActions } | undefined {
    const { result, checked, options } = this.state;
    if (!result || checked.length === 0) return undefined;
    return { jobId: result.jobId, tables: [...checked], actions: options.actions };
  }

  /** Changes the selection would make, over the ticked tables. */
  pendingTotal(): number {
    const { result, checked, options } = this.state;
    if (!result) return 0;
    return result.tables
      .filter((t) => checked.includes(t.index))
      .reduce((sum, t) => sum + pendingChanges(t, options.actions), 0);
  }

  /** The start of the sync script, for the review before applying. */
  async preview(): Promise<DataScriptPreview | undefined> {
    const selection = this.selection();
    if (!selection) return undefined;
    try {
      return await this.#api.dataPreview(selection);
    } catch (error) {
      this.#set({ error: errorMessage(error) });
      return undefined;
    }
  }

  /**
   * Applies the ticked tables' changes as a job, in batched transactions, then compares again
   * so the counts show what is left. Resolves true when the changes were applied.
   */
  async apply(confirmed: boolean): Promise<boolean> {
    const selection = this.selection();
    const result = this.state.result;
    if (!selection || !result || this.state.running) return false;
    this.#set({
      running: { jobId: undefined, kind: 'apply', phase: 'Starting…', cancelling: false },
      error: undefined,
      notice: undefined,
    });
    try {
      const jobId = await this.#api.applyData({ ...selection, confirmed }, result.target.profileId);
      if (jobId === undefined) {
        this.#set({ running: undefined });
        return false;
      }
      const job = await this.#follow(jobId, 'apply');
      if (job.state !== 'completed') {
        this.#set({
          running: undefined,
          ...(job.state === 'cancelled'
            ? { notice: 'The apply was cancelled; the table it was writing rolled back' }
            : { error: jobFailure(job) }),
        });
        return false;
      }
      const applied = job.summary?.outcome ?? 'Applied';
      this.#set({ running: undefined });
      const compared = await this.compare();
      if (compared && this.state.result) {
        const synced = new Set(
          result.tables.filter((t) => selection.tables.includes(t.index)).map((t) => t.name),
        );
        const left = this.state.result.tables
          .filter((t) => synced.has(t.name))
          .reduce((sum, t) => sum + pendingChanges(t, selection.actions), 0);
        this.#set({
          notice: `${applied}. Compared again: ${
            left === 0
              ? 'no differences remain in the synced tables.'
              : `${left} ${left === 1 ? 'difference remains' : 'differences remain'}.`
          }`,
        });
      }
      return true;
    } catch (error) {
      this.#set({ running: undefined, error: errorMessage(error) });
      return false;
    }
  }

  /** Writes the sync script for the ticked tables where the user picks. */
  async exportScript(): Promise<void> {
    const selection = this.selection();
    const result = this.state.result;
    if (!selection || !result) return;
    try {
      const path = await this.#api.saveFile({
        title: 'Save the sync script',
        defaultName: `${result.source.database}-to-${result.target.database}-data.sql`.replace(
          /[<>:"/\\|?*\s]/g,
          '_',
        ),
        extension: 'sql',
        label: 'SQL script',
      });
      if (path === null) return;
      const bytes = await this.#api.exportData({ ...selection, path });
      this.#set({
        notice: `Wrote ${bytes.toLocaleString('en-US')} bytes to ${path}`,
        error: undefined,
      });
    } catch (error) {
      this.#set({ error: errorMessage(error) });
    }
  }

  savedInput(name: string): SavedComparisonSave {
    const { source, target, saved, tableColumns } = this.state;
    const lookup = (draft: SideDraft) =>
      draft.profileId !== undefined ? this.#lookup(draft.profileId) : undefined;
    const tables = Object.entries(tableColumns).map(([table, columns]) => ({
      name: table,
      columns: [...columns],
    }));
    return {
      ...(saved !== undefined ? { id: saved.id } : {}),
      name,
      kind: 'data',
      source: sideInput(source, lookup(source)),
      target: sideInput(target, lookup(target)),
      data: {
        options: this.compareOptions(),
        ...(tables.length > 0 ? { tables } : {}),
      },
    };
  }

  async save(name: string): Promise<boolean> {
    try {
      const saved = await this.#api.saveComparison(this.savedInput(name));
      this.#set({ saved: { id: saved.id, name: saved.name }, notice: `Saved "${saved.name}"` });
      return true;
    } catch (error) {
      this.#set({ error: errorMessage(error) });
      return false;
    }
  }

  dispose(): void {
    const jobId = this.state.result?.jobId;
    if (jobId !== undefined) this.#api.discard(jobId);
    this.#disposed = true;
  }

  #follow(jobId: string, kind: RunningJob['kind']): Promise<JobInfo> {
    this.#set({ running: { jobId, kind, phase: 'Starting…', cancelling: false } });
    return this.#api.waitForJob(jobId, (job) => {
      this.#set({
        running: {
          jobId,
          kind,
          phase: job.progress?.phase ?? 'Working…',
          cancelling: job.cancelling,
        },
      });
    });
  }
}
