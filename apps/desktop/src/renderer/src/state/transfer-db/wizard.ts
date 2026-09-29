import { isSqlEngine, requiresWriteConfirmation, type EngineId } from '@joinery/core';
import type {
  ColumnOverrideInfo,
  DbTableModeInfo,
  StoredProfile,
  TransferInspection,
  TransferJob,
  TransferOptionsInfo,
  TransferPlanInfo,
} from '@joinery/ipc';
import { createStore, type StoreApi } from 'zustand/vanilla';

import { errorMessage } from '../../lib/errors';

/**
 * The data transfer wizard (spec §12) as a state machine: source objects → target connection
 * → options → column and type mapping → review → run as a job. The plan every step shows is
 * the job runner's (`transferDb.plan`), so the mapping, the DDL and the list of what is
 * created, emptied or dropped are exactly what the job will do. The write rules apply before
 * it starts: a read-only target refuses, and drops, truncates, REPLACE and every transfer
 * into a production or confirm-every-write profile ask first, listing what will happen.
 *
 * No React and no IPC here: everything comes through `TransferDbApi`, so the tests drive it
 * with fakes.
 */

export const TRANSFER_STEPS = ['source', 'target', 'options', 'mapping', 'review'] as const;
export type TransferStep = (typeof TRANSFER_STEPS)[number];

/** The steps a source engine goes through: Redis keys have no columns to map. */
export function stepsFor(engine: EngineId | undefined): readonly TransferStep[] {
  return engine === 'redis' ? TRANSFER_STEPS.filter((s) => s !== 'mapping') : TRANSFER_STEPS;
}

/** Where the wizard was opened: a connection, a database or schema, or tables. */
export interface TransferSource {
  readonly profileId: string;
  readonly database?: string | undefined;
  readonly schema?: string | undefined;
  /** Tables or collections to start with. */
  readonly objects?: readonly string[];
  /** Redis: the key pattern to start with. */
  readonly pattern?: string;
}

/** A connection as the wizard needs it. */
export interface TransferEndpoint {
  readonly profileId: string;
  readonly profileName: string;
  readonly engine: EngineId;
  readonly readOnly: boolean;
  readonly production: boolean;
  /** Production, or the profile's own "ask before every write". */
  readonly confirmWrites: boolean;
}

export function endpointOf(profile: StoredProfile): TransferEndpoint {
  return {
    profileId: profile.id,
    profileName: profile.name,
    engine: profile.engine,
    readOnly: profile.presentation.readOnly,
    production: profile.presentation.environment === 'production',
    confirmWrites: requiresWriteConfirmation(profile),
  };
}

/** The engine pairs the transfer engine supports (@joinery/transfer `transferSupport`). */
export function canTransfer(source: EngineId, target: EngineId): boolean {
  return (
    (isSqlEngine(source) && (isSqlEngine(target) || target === 'mongodb')) ||
    (source === 'mongodb' && isSqlEngine(target)) ||
    (source === 'redis' && target === 'redis')
  );
}

export interface TransferDbApi {
  profiles(): Promise<readonly StoredProfile[]>;
  inspect(profileId: string, database?: string, schema?: string): Promise<TransferInspection>;
  plan(job: TransferJob): Promise<TransferPlanInfo>;
  confirm(options: {
    readonly title: string;
    readonly message: string;
    readonly detail?: string;
    readonly confirmLabel: string;
    readonly danger: boolean;
  }): Promise<boolean>;
  /** Starts the job; undefined when the user dismissed a secrets prompt. */
  start(job: TransferJob): Promise<string | undefined>;
}

/** What the user changed about one source table or collection. */
export interface ObjectEdit {
  readonly target?: string;
  readonly mode?: DbTableModeInfo;
  readonly columns: Readonly<Record<string, ColumnOverrideInfo>>;
  readonly embed: readonly {
    readonly table: string;
    readonly foreignKey: string;
    readonly field: string;
  }[];
}

/** The BSON types a SQL column can be written as (@joinery/transfer MONGO_FIELD_TYPES). */
export const MONGO_FIELD_TYPES = [
  'string',
  'int',
  'long',
  'double',
  'decimal',
  'bool',
  'date',
  'binData',
  'uuid',
  'objectId',
  'json',
] as const;

export type TransferOptionsState = Required<TransferOptionsInfo>;

/** The engine's defaults (@joinery/transfer DEFAULT_DB_TRANSFER_OPTIONS; the tests compare). */
export const DEFAULT_TRANSFER_OPTIONS: TransferOptionsState = {
  mode: 'create',
  batchSize: 1000,
  transactionPerBatch: true,
  onError: 'stop',
  disableConstraints: false,
  parallel: 2,
  deferConstraints: true,
  resetSequences: true,
  sampleSize: 1000,
  idFromPrimaryKey: true,
  replace: false,
  keepTtl: true,
};

export interface TransferDbState {
  readonly step: TransferStep;
  readonly busy: string | undefined;
  readonly error: string | undefined;
  readonly profiles: readonly StoredProfile[];
  readonly source: TransferEndpoint | undefined;
  readonly sourceDatabase: string | undefined;
  readonly sourceSchema: string | undefined;
  readonly sourceInfo: TransferInspection | undefined;
  /** Tables or collections to transfer. */
  readonly selected: readonly string[];
  /** Redis: key patterns, one per line. */
  readonly keyPatterns: string;
  readonly target: TransferEndpoint | undefined;
  readonly targetDatabase: string | undefined;
  readonly targetSchema: string | undefined;
  readonly targetInfo: TransferInspection | undefined;
  readonly options: TransferOptionsState;
  readonly edits: Readonly<Record<string, ObjectEdit>>;
  readonly plan: TransferPlanInfo | undefined;
  readonly planError: string | undefined;
  readonly planning: boolean;
  readonly jobId: string | undefined;
}

export function initialTransferState(): TransferDbState {
  return {
    step: 'source',
    busy: undefined,
    error: undefined,
    profiles: [],
    source: undefined,
    sourceDatabase: undefined,
    sourceSchema: undefined,
    sourceInfo: undefined,
    selected: [],
    keyPatterns: '*',
    target: undefined,
    targetDatabase: undefined,
    targetSchema: undefined,
    targetInfo: undefined,
    options: DEFAULT_TRANSFER_OPTIONS,
    edits: {},
    plan: undefined,
    planError: undefined,
    planning: false,
    jobId: undefined,
  };
}

const EMPTY_EDIT: ObjectEdit = { columns: {}, embed: [] };

/** Connections the source can transfer into. */
export function targetsFor(state: TransferDbState): StoredProfile[] {
  const source = state.source;
  if (source === undefined) return [];
  return state.profiles.filter((p) => canTransfer(source.engine, p.engine));
}

function patternsOf(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

/** Why the wizard cannot move on from its current step, if it cannot. */
export function stepProblem(state: TransferDbState): string | undefined {
  const { source, target } = state;
  if (source === undefined || state.sourceInfo === undefined) return 'Reading the source…';
  if (state.step === 'source') {
    if (source.engine === 'redis') {
      return patternsOf(state.keyPatterns).length === 0
        ? 'Enter a key pattern (* for every key)'
        : undefined;
    }
    return state.selected.length === 0
      ? `Choose at least one ${source.engine === 'mongodb' ? 'collection' : 'table'}`
      : undefined;
  }
  if (target === undefined) return 'Choose the connection to transfer into';
  if (target.readOnly) return `"${target.profileName}" is read-only`;
  if (state.targetInfo === undefined) return 'Reading the target…';
  if (target.engine === 'mongodb' && !state.targetDatabase?.trim())
    return 'Name the target database';
  if (target.engine !== 'postgres' && isSqlEngine(target.engine) && !state.targetDatabase) {
    return 'Choose the target database';
  }
  if (state.step === 'target' || state.step === 'options') return undefined;
  if (state.planError !== undefined) return state.planError;
  if (state.plan === undefined) return 'Planning the transfer…';
  return state.plan.problems[0];
}

function overridesOf(edit: ObjectEdit): ColumnOverrideInfo[] {
  return Object.values(edit.columns).flatMap((column) => {
    const clean: ColumnOverrideInfo = {
      source: column.source,
      ...(column.target?.trim() ? { target: column.target.trim() } : {}),
      ...(column.dataType?.trim() ? { dataType: column.dataType.trim() } : {}),
      ...(column.skip === true ? { skip: true } : {}),
      ...(column.shape !== undefined ? { shape: column.shape } : {}),
    };
    return Object.keys(clean).length > 1 ? [clean] : [];
  });
}

/** The options that apply to this pair of engines. */
function optionsFor(state: TransferDbState): TransferOptionsInfo {
  const o = state.options;
  const from = state.source?.engine;
  const to = state.target?.engine;
  if (from === 'redis') {
    return {
      batchSize: o.batchSize,
      onError: o.onError,
      parallel: o.parallel,
      replace: o.replace,
      keepTtl: o.keepTtl,
    };
  }
  return {
    mode: o.mode,
    batchSize: o.batchSize,
    onError: o.onError,
    parallel: o.parallel,
    ...(to !== 'mongodb'
      ? {
          transactionPerBatch: o.transactionPerBatch,
          disableConstraints: o.disableConstraints,
          deferConstraints: o.deferConstraints,
          resetSequences: o.resetSequences,
        }
      : { idFromPrimaryKey: o.idFromPrimaryKey }),
    ...(from === 'mongodb' ? { sampleSize: o.sampleSize } : {}),
  };
}

/** The job the wizard's state describes. */
export function buildTransferJob(state: TransferDbState, confirmed: boolean): TransferJob {
  const { source, target } = state;
  if (source === undefined || target === undefined)
    throw new Error('Choose the source and the target');
  const redis = source.engine === 'redis';
  return {
    kind: 'transfer',
    profileId: source.profileId,
    ...(state.sourceDatabase ? { database: state.sourceDatabase } : {}),
    ...(source.engine === 'postgres' && state.sourceSchema ? { schema: state.sourceSchema } : {}),
    objects: redis
      ? []
      : state.selected.map((name) => {
          const edit = state.edits[name] ?? EMPTY_EDIT;
          const columns = overridesOf(edit);
          const renamed = edit.target?.trim();
          return {
            name,
            ...(renamed && renamed !== name ? { target: renamed } : {}),
            ...(edit.mode !== undefined ? { mode: edit.mode } : {}),
            ...(columns.length > 0 ? { columns } : {}),
            ...(edit.embed.length > 0 && target.engine === 'mongodb'
              ? { embed: [...edit.embed] }
              : {}),
          };
        }),
    ...(redis ? { keyPatterns: patternsOf(state.keyPatterns) } : {}),
    target: {
      profileId: target.profileId,
      ...(state.targetDatabase?.trim() ? { database: state.targetDatabase.trim() } : {}),
      ...(target.engine === 'postgres' && state.targetSchema?.trim()
        ? { schema: state.targetSchema.trim() }
        : {}),
    },
    options: optionsFor(state),
    ...(confirmed ? { confirmed: true } : {}),
  };
}

/** Child tables that reference `table`, for SQL → MongoDB embedding. */
export function childrenOf(
  state: TransferDbState,
  table: string,
): { readonly table: string; readonly foreignKey: string }[] {
  return (state.sourceInfo?.objects ?? []).flatMap((object) =>
    (object.foreignKeys ?? [])
      .filter((fk) => fk.refTable === table)
      .map((fk) => ({ table: object.name, foreignKey: fk.name })),
  );
}

/** One run of the data transfer wizard. */
export class TransferDbWizard {
  readonly store: StoreApi<TransferDbState>;
  readonly #api: TransferDbApi;
  readonly #origin: TransferSource;
  #sourceSeq = 0;
  #targetSeq = 0;
  #planSeq = 0;

  constructor(origin: TransferSource, api: TransferDbApi) {
    this.store = createStore<TransferDbState>()(() => initialTransferState());
    this.#api = api;
    this.#origin = origin;
  }

  get state(): TransferDbState {
    return this.store.getState();
  }

  #set(patch: Partial<TransferDbState>): void {
    this.store.setState(patch);
  }

  #fail(error: unknown): void {
    this.#set({ busy: undefined, error: errorMessage(error) });
  }

  /** Loads the connections and reads the source. */
  async open(): Promise<void> {
    this.#set({ busy: 'Reading the source…', error: undefined });
    try {
      const profiles = await this.#api.profiles();
      const profile = profiles.find((p) => p.id === this.#origin.profileId);
      if (profile === undefined) throw new Error('The connection was deleted');
      this.#set({
        profiles,
        source: endpointOf(profile),
        sourceDatabase: this.#origin.database,
        sourceSchema: this.#origin.schema,
        selected: [...(this.#origin.objects ?? [])],
        keyPatterns: this.#origin.pattern ?? '*',
      });
      await this.#inspectSource(true);
    } catch (error) {
      this.#fail(error);
    }
  }

  async #inspectSource(keepSelection: boolean): Promise<void> {
    const { source, sourceDatabase, sourceSchema } = this.state;
    if (source === undefined) return;
    const seq = ++this.#sourceSeq;
    this.#set({ busy: 'Reading the source…', error: undefined });
    try {
      const info = await this.#api.inspect(source.profileId, sourceDatabase, sourceSchema);
      if (seq !== this.#sourceSeq) return;
      const names = new Set(info.objects.map((o) => o.name));
      this.#set({
        busy: undefined,
        sourceInfo: info,
        sourceDatabase: sourceDatabase ?? info.database,
        ...(source.engine === 'postgres' && sourceSchema === undefined
          ? { sourceSchema: 'public' }
          : {}),
        selected: keepSelection ? this.state.selected.filter((n) => names.has(n)) : [],
      });
    } catch (error) {
      if (seq === this.#sourceSeq) this.#fail(error);
    }
  }

  async setSourceDatabase(database: string): Promise<void> {
    this.#set({
      sourceDatabase: database,
      ...(this.state.source?.engine === 'postgres' ? { sourceSchema: 'public' } : {}),
    });
    await this.#inspectSource(false);
  }

  async setSourceSchema(schema: string): Promise<void> {
    this.#set({ sourceSchema: schema });
    await this.#inspectSource(false);
  }

  toggleObject(name: string): void {
    const selected = this.state.selected;
    this.#set({
      selected: selected.includes(name) ? selected.filter((n) => n !== name) : [...selected, name],
    });
  }

  selectAll(all: boolean): void {
    this.#set({ selected: all ? (this.state.sourceInfo?.objects ?? []).map((o) => o.name) : [] });
  }

  setKeyPatterns(text: string): void {
    this.#set({ keyPatterns: text });
  }

  /** Picks the target connection and reads it. */
  async chooseTarget(profileId: string): Promise<void> {
    const profile = this.state.profiles.find((p) => p.id === profileId);
    if (profile === undefined) return;
    const target = endpointOf(profile);
    const { source, sourceDatabase } = this.state;
    this.#set({
      target,
      targetInfo: undefined,
      plan: undefined,
      planError: undefined,
      targetDatabase:
        target.engine === 'mongodb'
          ? source?.engine === 'mongodb'
            ? undefined
            : sourceDatabase
          : undefined,
      targetSchema:
        target.engine === 'postgres'
          ? source?.engine === 'postgres'
            ? this.state.sourceSchema
            : 'public'
          : undefined,
      error: target.readOnly
        ? `"${target.profileName}" is read-only, so nothing can be transferred into it.`
        : undefined,
    });
    await this.#inspectTarget();
  }

  async #inspectTarget(): Promise<void> {
    const { target, targetDatabase, targetSchema } = this.state;
    if (target === undefined) return;
    const seq = ++this.#targetSeq;
    this.#set({ busy: 'Reading the target…' });
    try {
      // A MongoDB database may not exist yet: its collections are read from the default one.
      const info = await this.#api.inspect(
        target.profileId,
        target.engine === 'mongodb' ? undefined : targetDatabase,
        target.engine === 'postgres' ? targetSchema : undefined,
      );
      if (seq !== this.#targetSeq) return;
      this.#set({
        busy: undefined,
        targetInfo: info,
        targetDatabase: targetDatabase ?? (target.engine === 'mongodb' ? undefined : info.database),
        ...(target.engine === 'postgres' && targetSchema === undefined
          ? { targetSchema: 'public' }
          : {}),
      });
    } catch (error) {
      if (seq === this.#targetSeq) this.#fail(error);
    }
  }

  async setTargetDatabase(database: string): Promise<void> {
    this.#set({
      targetDatabase: database,
      ...(this.state.target?.engine === 'postgres' ? { targetSchema: 'public' } : {}),
      plan: undefined,
    });
    if (this.state.target?.engine !== 'mongodb') await this.#inspectTarget();
  }

  setTargetSchema(schema: string): void {
    this.#set({ targetSchema: schema, plan: undefined });
  }

  setOptions(patch: Partial<TransferOptionsState>): void {
    this.#set({ options: { ...this.state.options, ...patch }, plan: undefined });
  }

  #edit(name: string, change: (edit: ObjectEdit) => ObjectEdit): void {
    const current = this.state.edits[name] ?? EMPTY_EDIT;
    this.#set({ edits: { ...this.state.edits, [name]: change(current) } });
  }

  /** SQL → MongoDB: embeds (or stops embedding) a child table through one of its foreign keys. */
  toggleEmbed(table: string, child: { readonly table: string; readonly foreignKey: string }): void {
    this.#edit(table, (edit) => {
      const on = edit.embed.some(
        (e) => e.foreignKey === child.foreignKey && e.table === child.table,
      );
      return {
        ...edit,
        embed: on
          ? edit.embed.filter(
              (e) => !(e.foreignKey === child.foreignKey && e.table === child.table),
            )
          : [...edit.embed, { ...child, field: child.table }],
      };
    });
    this.#set({ plan: undefined });
  }

  setEmbedField(table: string, foreignKey: string, field: string): void {
    this.#edit(table, (edit) => ({
      ...edit,
      embed: edit.embed.map((e) => (e.foreignKey === foreignKey ? { ...e, field } : e)),
    }));
    this.#set({ plan: undefined });
  }

  /** Renames the target table or collection. */
  setTargetName(name: string, target: string): void {
    this.#edit(name, (edit) => ({ ...edit, target }));
    void this.replan();
  }

  /** Overrides the mode for one table (undefined: the transfer's). */
  setObjectMode(name: string, mode: DbTableModeInfo | undefined): void {
    this.#edit(name, ({ mode: _old, ...edit }) => (mode === undefined ? edit : { ...edit, mode }));
    void this.replan();
  }

  /** Changes a column: its target name, type, whether it is skipped, how a field lands. */
  setColumn(
    name: string,
    source: string,
    patch: Omit<Partial<ColumnOverrideInfo>, 'source'>,
  ): void {
    this.#edit(name, (edit) => ({
      ...edit,
      columns: { ...edit.columns, [source]: { ...edit.columns[source], ...patch, source } },
    }));
    void this.replan();
  }

  /** Asks the job runner what the transfer will do now. */
  async replan(): Promise<void> {
    if (this.state.source === undefined || this.state.target === undefined) return;
    const seq = ++this.#planSeq;
    this.#set({ planning: true });
    try {
      const plan = await this.#api.plan(buildTransferJob(this.state, false));
      if (seq === this.#planSeq) this.#set({ plan, planError: undefined, planning: false });
    } catch (error) {
      if (seq === this.#planSeq)
        this.#set({ plan: undefined, planError: errorMessage(error), planning: false });
    }
  }

  async next(): Promise<void> {
    const state = this.state;
    if (stepProblem(state) !== undefined || state.busy) return;
    const steps = stepsFor(state.source?.engine);
    const at = steps.indexOf(state.step);
    const next = steps[at + 1];
    if (next === undefined) return;
    this.#set({ step: next, error: undefined });
    if (next === 'mapping' || next === 'review') await this.replan();
  }

  back(): void {
    const steps = stepsFor(this.state.source?.engine);
    const at = steps.indexOf(this.state.step);
    if (at > 0 && !this.state.busy) this.#set({ step: steps[at - 1]!, error: undefined });
  }

  /**
   * Starts the transfer after the write rules: what it drops, empties or overwrites, and any
   * transfer into a production or confirm-every-write profile, is confirmed first with the
   * list of what will be created, emptied and dropped. Returns the job id, or undefined.
   */
  async run(): Promise<string | undefined> {
    await this.replan();
    const state = this.state;
    const problem = stepProblem(state);
    if (problem !== undefined || state.plan === undefined || state.target === undefined) {
      this.#set({ error: problem ?? 'Planning the transfer…' });
      return undefined;
    }
    const { plan, target } = state;
    let confirmed = false;
    if (plan.destructive.length > 0 || target.confirmWrites) {
      const destructive = plan.destructive.length > 0;
      const ok = await this.#api.confirm({
        title: destructive
          ? 'Drop, empty or overwrite data on the target?'
          : target.production
            ? 'Transfer into a production connection?'
            : 'Transfer into this connection?',
        message: `The transfer writes to "${target.profileName}"${target.production ? ', a production connection' : ''}.`,
        detail: [...plan.destructive, ...plan.creates].join('\n'),
        confirmLabel: 'Transfer',
        danger: destructive || target.production,
      });
      if (!ok) return undefined;
      confirmed = true;
    }
    this.#set({ busy: 'Starting the transfer…', error: undefined });
    try {
      const jobId = await this.#api.start(buildTransferJob(this.state, confirmed));
      this.#set({ busy: undefined, jobId });
      return jobId;
    } catch (error) {
      this.#fail(error);
      return undefined;
    }
  }
}
