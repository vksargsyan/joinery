import type {
  JobInfo,
  RenameRuleInfo,
  SavedComparisonSave,
  StructureCompareOptions,
  StructureResult,
  StructureScript,
  SyncOperationInfo,
} from '@joinery/ipc';
import {
  DEFAULT_COMPARE_OPTIONS,
  missingDependencies,
  setAllSelected,
  setOperationSelected,
  type OperationKind,
  type SchemaDiff,
  type SyncObjectKind,
} from '@joinery/sync';
import { createStore, type StoreApi } from 'zustand/vanilla';

import { errorMessage } from '../../lib/errors';
import type { SyncApi } from './api';
import {
  jobFailure,
  pairProblem,
  sideDraft,
  sideInput,
  type ProfileLookup,
  type SideDraft,
  type SideRole,
} from './sides';

/**
 * Structure compare (spec §13, structure sync pipeline) as a view model: two sides and the §13
 * options with a rename mapping → a compare job → operations grouped by object kind, each
 * tickable (destructive ones start unticked; the engine's selection helpers keep dependencies
 * consistent), a side-by-side DDL view and the script for the selection → an apply job with
 * its automatic re-compare, which must leave none of the applied operations → the script or
 * an HTML report exported, the comparison saved. Jobs and scripts run in the job runner.
 */

export type StructureOptionKey = keyof Omit<Required<StructureCompareOptions>, 'renames'>;

/** The §13 options in the order the panel lists them, with the engines they apply to. */
export const STRUCTURE_OPTIONS: readonly {
  readonly key: StructureOptionKey;
  readonly label: string;
  readonly hint?: string;
}[] = [
  { key: 'ignoreComments', label: 'Ignore comments' },
  { key: 'ignoreCollation', label: 'Ignore collation', hint: 'Character sets still compare' },
  {
    key: 'ignoreAutoIncrement',
    label: 'Ignore auto-increment values',
    hint: 'MySQL and MariaDB counters',
  },
  { key: 'ignoreDefiner', label: 'Ignore DEFINER', hint: 'MySQL and MariaDB routines and views' },
  { key: 'ignoreOwnership', label: 'Ignore ownership', hint: 'PostgreSQL owners' },
  { key: 'ignorePrivileges', label: 'Ignore privileges' },
  { key: 'ignorePartitions', label: 'Ignore partitions' },
  { key: 'ignoreColumnOrder', label: 'Ignore column order', hint: 'MySQL and MariaDB' },
  { key: 'ignoreNameCase', label: 'Ignore name case', hint: 'MySQL and MariaDB' },
  {
    key: 'ignoreNames',
    label: 'Ignore names of generated constraints and indexes',
    hint: 'Match them by definition',
  },
  { key: 'ignoreExtensionVersions', label: 'Ignore extension versions', hint: 'PostgreSQL' },
  {
    key: 'detectRenames',
    label: 'Detect renamed indexes and constraints',
    hint: 'Rename instead of drop and create',
  },
];

export type StructureOptionsDraft = Readonly<Record<StructureOptionKey, boolean>>;

export const OBJECT_KIND_LABELS: Readonly<Record<SyncObjectKind, string>> = {
  schema: 'Schemas',
  extension: 'Extensions',
  type: 'Types',
  sequence: 'Sequences',
  table: 'Tables',
  column: 'Columns',
  'primary-key': 'Primary keys',
  unique: 'Unique constraints',
  index: 'Indexes',
  'foreign-key': 'Foreign keys',
  check: 'Check constraints',
  trigger: 'Triggers',
  partition: 'Partitions',
  view: 'Views',
  'materialized-view': 'Materialized views',
  routine: 'Routines',
  event: 'Events',
};

const GROUP_ORDER = Object.keys(OBJECT_KIND_LABELS) as SyncObjectKind[];

/** Operations of one object kind, with badge counts. */
export interface OperationGroup {
  readonly objectKind: SyncObjectKind;
  readonly label: string;
  readonly operations: readonly SyncOperationInfo[];
  readonly counts: Readonly<Record<OperationKind, number>>;
  readonly selected: number;
}

/** The operations grouped by object kind (tables, then columns, keys, views...). */
export function groupOperations(
  operations: readonly SyncOperationInfo[],
  selected: ReadonlySet<string>,
): OperationGroup[] {
  const groups: OperationGroup[] = [];
  for (const objectKind of GROUP_ORDER) {
    const ops = operations
      .filter((op) => op.objectKind === objectKind)
      .sort((a, b) => a.qualifiedName.localeCompare(b.qualifiedName));
    if (ops.length === 0) continue;
    const counts = { create: 0, alter: 0, drop: 0, rename: 0 };
    for (const op of ops) counts[op.kind]++;
    groups.push({
      objectKind,
      label: OBJECT_KIND_LABELS[objectKind],
      operations: ops,
      counts,
      selected: ops.filter((op) => selected.has(op.id)).length,
    });
  }
  return groups;
}

export interface RunningJob {
  readonly jobId: string | undefined;
  readonly kind: 'compare' | 'apply';
  readonly phase: string;
  readonly cancelling: boolean;
}

export interface StructureCompareState {
  readonly source: SideDraft;
  readonly target: SideDraft;
  readonly options: StructureOptionsDraft;
  readonly renames: readonly RenameRuleInfo[];
  readonly running: RunningJob | undefined;
  /** The current comparison: a compare's, or the last apply's re-compare. */
  readonly result: StructureResult | undefined;
  /** Ids of the ticked operations. */
  readonly selected: readonly string[];
  /** The operation the side-by-side view shows. */
  readonly focused: string | undefined;
  /** The script for `scriptFor`; stale while `scriptFor` differs from the selection. */
  readonly script: StructureScript | undefined;
  readonly scriptFor: string | undefined;
  readonly error: string | undefined;
  readonly notice: string | undefined;
  /** The setup changed since the comparison ran. */
  readonly stale: boolean;
  readonly saved: { readonly id: string; readonly name: string } | undefined;
}

export interface StructureCompareInit {
  readonly source?: Partial<SideDraft>;
  readonly target?: Partial<SideDraft>;
  readonly options?: StructureCompareOptions;
  readonly saved?: { readonly id: string; readonly name: string };
}

function optionsDraft(options: StructureCompareOptions = {}): StructureOptionsDraft {
  const draft = {} as Record<StructureOptionKey, boolean>;
  for (const { key } of STRUCTURE_OPTIONS)
    draft[key] = options[key] ?? DEFAULT_COMPARE_OPTIONS[key];
  return draft;
}

function selectionKey(selected: readonly string[]): string {
  return [...selected].sort().join('\n');
}

/**
 * The comparison's diff with a selection, as the engine's selection helpers take it. The step
 * order is left out of what the page gets; only script generation (in the job runner) needs it.
 */
function selectable(result: StructureResult, selected: ReadonlySet<string>): SchemaDiff {
  return {
    ...result.diff,
    order: [],
    operations: result.diff.operations.map((op) => ({ ...op, selected: selected.has(op.id) })),
  };
}

function defaultSelection(result: StructureResult): string[] {
  return result.diff.operations.filter((op) => op.selected).map((op) => op.id);
}

export interface StructureCompareConfig {
  /** Delay before the script for a new selection is asked for (typing, ticking in a row). */
  readonly scriptDelayMs?: number;
}

export class StructureCompare {
  readonly store: StoreApi<StructureCompareState>;
  readonly #api: SyncApi;
  readonly #lookup: ProfileLookup;
  readonly #scriptDelayMs: number;
  #scriptTimer: ReturnType<typeof setTimeout> | undefined;
  #scriptRequest = 0;
  #disposed = false;

  constructor(
    init: StructureCompareInit,
    api: SyncApi,
    lookup: ProfileLookup,
    config: StructureCompareConfig = {},
  ) {
    this.#api = api;
    this.#lookup = lookup;
    this.#scriptDelayMs = config.scriptDelayMs ?? 150;
    this.store = createStore<StructureCompareState>()(() => ({
      source: sideDraft(init.source),
      target: sideDraft(init.target),
      options: optionsDraft(init.options),
      renames: init.options?.renames ?? [],
      running: undefined,
      result: undefined,
      selected: [],
      focused: undefined,
      script: undefined,
      scriptFor: undefined,
      error: undefined,
      notice: undefined,
      stale: false,
      saved: init.saved,
    }));
  }

  get state(): StructureCompareState {
    return this.store.getState();
  }

  #set(patch: Partial<StructureCompareState>): void {
    if (!this.#disposed) this.store.setState(patch);
  }

  #changed(patch: Partial<StructureCompareState>): void {
    this.#set({ ...patch, stale: this.state.result !== undefined, error: undefined });
  }

  setSide(role: SideRole, patch: Partial<SideDraft>): void {
    const current = this.state[role];
    const next = { ...current, ...patch };
    if (patch.profileId !== undefined && patch.profileId !== current.profileId) {
      // Another connection: its default database, and no schemas carried over.
      const profile = this.#lookup(patch.profileId);
      next.database = patch.database ?? profile?.defaultDatabase ?? '';
      next.schemas = patch.schemas ?? '';
    }
    this.#changed({ [role]: next });
  }

  /** Compares the other way round: the target becomes the source. */
  swapSides(): void {
    this.#changed({ source: this.state.target, target: this.state.source });
  }

  setOption(key: StructureOptionKey, value: boolean): void {
    this.#changed({ options: { ...this.state.options, [key]: value } });
  }

  addRename(rule: RenameRuleInfo): void {
    this.#changed({ renames: [...this.state.renames, rule] });
  }

  updateRename(index: number, patch: Partial<RenameRuleInfo>): void {
    this.#changed({
      renames: this.state.renames.map((rule, i) => (i === index ? { ...rule, ...patch } : rule)),
    });
  }

  removeRename(index: number): void {
    this.#changed({ renames: this.state.renames.filter((_, i) => i !== index) });
  }

  /** What stops a compare from starting, or undefined. */
  problem(): string | undefined {
    const { source, target, renames } = this.state;
    const pair = pairProblem(source, target, this.#lookup, 'structure');
    if (pair) return pair;
    if (renames.some((rule) => rule.from.trim() === '' || rule.to.trim() === '')) {
      return 'Each rename needs the target name and the source name';
    }
    return undefined;
  }

  /** The options as the contract takes them. */
  compareOptions(): StructureCompareOptions {
    const renames = this.state.renames
      .map((rule) => ({
        objectKind: rule.objectKind,
        from: rule.from.trim(),
        to: rule.to.trim(),
        ...(rule.schema?.trim() ? { schema: rule.schema.trim() } : {}),
        ...(rule.table?.trim() ? { table: rule.table.trim() } : {}),
      }))
      .filter((rule) => rule.from !== '' && rule.to !== '');
    return { ...this.state.options, ...(renames.length > 0 ? { renames } : {}) };
  }

  /** Runs a compare job and shows its result. */
  async compare(): Promise<void> {
    const problem = this.problem();
    if (problem !== undefined) {
      this.#set({ error: problem });
      return;
    }
    const { source, target } = this.state;
    const lookup = (draft: SideDraft) =>
      draft.profileId !== undefined ? this.#lookup(draft.profileId) : undefined;
    this.#set({
      running: { jobId: undefined, kind: 'compare', phase: 'Starting…', cancelling: false },
      error: undefined,
      notice: undefined,
    });
    try {
      const jobId = await this.#api.compareStructure({
        source: sideInput(source, lookup(source)),
        target: sideInput(target, lookup(target)),
        options: this.compareOptions(),
      });
      if (jobId === undefined) {
        this.#set({ running: undefined });
        return;
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
        return;
      }
      if (this.#disposed) {
        this.#api.discard(jobId);
        return;
      }
      this.#show(await this.#api.structureResult(jobId));
      this.#set({ running: undefined, stale: false });
    } catch (error) {
      this.#set({ running: undefined, error: errorMessage(error) });
    }
  }

  /** Cancels the running compare or apply (an apply on PostgreSQL rolls back). */
  async cancel(): Promise<void> {
    const running = this.state.running;
    if (!running?.jobId) return;
    this.#set({ running: { ...running, cancelling: true } });
    await this.#api.cancel(running.jobId);
  }

  /** Ticks or unticks an operation; dependencies follow (the engine's selection helpers). */
  toggle(id: string, selected: boolean): void {
    const result = this.state.result;
    if (!result) return;
    const next = setOperationSelected(
      selectable(result, new Set(this.state.selected)),
      id,
      selected,
    );
    this.#select(next.operations.filter((op) => op.selected).map((op) => op.id));
  }

  /** Ticks or unticks every operation the filter picks (all by default). */
  setAll(selected: boolean, filter: (op: SyncOperationInfo) => boolean = () => true): void {
    const result = this.state.result;
    if (!result) return;
    const ops = new Map(result.diff.operations.map((op) => [op.id, op]));
    const next = setAllSelected(selectable(result, new Set(this.state.selected)), selected, (op) =>
      filter(ops.get(op.id)!),
    );
    this.#select(next.operations.filter((op) => op.selected).map((op) => op.id));
  }

  focus(id: string | undefined): void {
    this.#set({ focused: id });
  }

  /** Ticked operations whose dependencies are unticked (spec §13, step 5). */
  missing(): { operationId: string; missing: string[] }[] {
    const result = this.state.result;
    if (!result) return [];
    return missingDependencies(selectable(result, new Set(this.state.selected)));
  }

  /** Whether the shown script belongs to the current selection. */
  scriptCurrent(): boolean {
    return (
      this.state.script !== undefined && this.state.scriptFor === selectionKey(this.state.selected)
    );
  }

  /** The script for the current selection, generated in the job runner. */
  async refreshScript(): Promise<StructureScript | undefined> {
    if (this.#scriptTimer !== undefined) clearTimeout(this.#scriptTimer);
    this.#scriptTimer = undefined;
    const { result, selected } = this.state;
    if (!result) return undefined;
    const key = selectionKey(selected);
    if (this.scriptCurrent()) return this.state.script;
    const request = ++this.#scriptRequest;
    try {
      const script = await this.#api.structureScript(result.jobId, selected);
      if (request === this.#scriptRequest && this.state.result === result) {
        this.#set({ script, scriptFor: key });
      }
      return selectionKey(this.state.selected) === key ? script : undefined;
    } catch (error) {
      if (request === this.#scriptRequest) this.#set({ error: errorMessage(error) });
      return undefined;
    }
  }

  /**
   * Applies the ticked operations: the job runs the reviewed script (by its hash) with
   * progress and stop-on-error, then re-compares. The re-compare becomes the comparison.
   * Resolves true when the script ran.
   */
  async apply(script: StructureScript, confirmed: boolean): Promise<boolean> {
    const { result, selected } = this.state;
    if (!result || this.state.running) return false;
    this.#set({
      running: { jobId: undefined, kind: 'apply', phase: 'Starting…', cancelling: false },
      error: undefined,
      notice: undefined,
    });
    try {
      const jobId = await this.#api.applyStructure(
        {
          jobId: result.jobId,
          selected: [...selected],
          scriptSha256: script.sha256,
          confirmed,
        },
        result.target.profileId,
      );
      if (jobId === undefined) {
        this.#set({ running: undefined });
        return false;
      }
      const job = await this.#follow(jobId, 'apply');
      if (job.state !== 'running' && job.state !== 'cancelled') {
        this.#api.structureChanged(result.target.profileId);
      }
      if (job.state !== 'completed') {
        this.#set({
          running: undefined,
          ...(job.state === 'cancelled'
            ? { notice: 'The apply was cancelled' }
            : { error: `${jobFailure(job)} Compare again to see the target as it is now.` }),
        });
        return false;
      }
      this.#api.discard(result.jobId);
      if (this.#disposed) {
        this.#api.discard(jobId);
        return true;
      }
      const after = await this.#api.structureResult(jobId);
      this.#show(after);
      const applied = after.applied;
      const remaining = after.diff.operations.length;
      this.#set({
        running: undefined,
        stale: false,
        notice:
          applied === undefined
            ? undefined
            : `Applied ${applied.statements} ${applied.statements === 1 ? 'statement' : 'statements'}. Compared again: ${
                remaining === 0
                  ? 'the target now matches the source.'
                  : `${remaining} ${remaining === 1 ? 'difference remains' : 'differences remain'}, none of them applied.`
              }`,
        ...(applied && applied.unconverged.length > 0
          ? {
              error: `${applied.unconverged.length} applied ${applied.unconverged.length === 1 ? 'operation still differs' : 'operations still differ'} after applying: ${applied.unconverged.join(', ')}`,
            }
          : {}),
      });
      return true;
    } catch (error) {
      this.#set({ running: undefined, error: errorMessage(error) });
      return false;
    }
  }

  /** Writes the selection's script (.sql) or the HTML report where the user picks. */
  async export(format: 'sql' | 'html'): Promise<void> {
    const result = this.state.result;
    if (!result) return;
    const base = `${result.source.database}-to-${result.target.database}`.replace(
      /[<>:"/\\|?*\s]/g,
      '_',
    );
    try {
      const path = await this.#api.saveFile({
        title: format === 'sql' ? 'Save the script' : 'Save the report',
        defaultName: `${base}${format === 'sql' ? '.sql' : '.html'}`,
        extension: format,
        label: format === 'sql' ? 'SQL script' : 'HTML report',
      });
      if (path === null) return;
      const bytes = await this.#api.exportStructure({
        jobId: result.jobId,
        selected: [...this.state.selected],
        format,
        path,
      });
      this.#set({
        notice: `Wrote ${bytes.toLocaleString('en-US')} bytes to ${path}`,
        error: undefined,
      });
    } catch (error) {
      this.#set({ error: errorMessage(error) });
    }
  }

  /** The comparison as a saved comparison (connections, databases, options, mapping). */
  savedInput(name: string): SavedComparisonSave {
    const { source, target, saved } = this.state;
    const lookup = (draft: SideDraft) =>
      draft.profileId !== undefined ? this.#lookup(draft.profileId) : undefined;
    return {
      ...(saved !== undefined ? { id: saved.id } : {}),
      name,
      kind: 'structure',
      source: sideInput(source, lookup(source)),
      target: sideInput(target, lookup(target)),
      structure: this.compareOptions(),
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

  /** Forgets the comparison main keeps (the panel closed); a job still running is left alone. */
  dispose(): void {
    if (this.#scriptTimer !== undefined) clearTimeout(this.#scriptTimer);
    const jobId = this.state.result?.jobId;
    if (jobId !== undefined) this.#api.discard(jobId);
    this.#disposed = true;
  }

  #show(result: StructureResult): void {
    const selected = defaultSelection(result);
    this.#set({
      result,
      selected,
      focused: result.diff.operations[0]?.id,
      script: result.script,
      scriptFor: selectionKey(selected),
    });
  }

  #select(selected: string[]): void {
    this.#set({ selected });
    if (this.scriptCurrent()) return;
    if (this.#scriptTimer !== undefined) clearTimeout(this.#scriptTimer);
    this.#scriptTimer = setTimeout(() => void this.refreshScript(), this.#scriptDelayMs);
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
