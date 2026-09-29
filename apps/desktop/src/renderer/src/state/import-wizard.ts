import type { SqlDialect, TableDef } from '@joinery/core';
import {
  DATA_TYPE_PATTERN,
  type ColumnMappingInfo,
  type CsvReadSettings,
  type ImportJob,
  type ImportMode,
  type ImportSettings,
  type NewTablePlan,
  type NewTablePlanInput,
  type TransferPreview,
  type TransferPreviewInput,
  type TransferRowFormat,
} from '@joinery/ipc';
import { createStore, type StoreApi } from 'zustand/vanilla';

import { errorMessage } from '../lib/errors';

/**
 * The import wizard (spec §12) as a state machine: choose the file → preview with the detected
 * format, delimiter, header and encoding (editable; every change previews again) → column
 * mapping (auto-matched; for a new table the inferred columns and types, rendered through
 * `tableFromColumns` in the job runner) → options (mode, key columns, batch size, transaction,
 * errors, foreign key checks) → review → run as a job. The write rules apply before it starts:
 * a read-only profile refuses, a production profile confirms, and replace warns that it
 * empties the table.
 *
 * No React and no IPC here: everything the wizard asks of the app comes through
 * `ImportWizardApi`, so the tests drive it with fakes.
 */

export const IMPORT_STEPS = ['file', 'preview', 'mapping', 'options', 'review'] as const;
export type ImportStep = (typeof IMPORT_STEPS)[number];

export interface ImportTarget {
  readonly profileId: string;
  readonly profileName: string;
  readonly dialect: SqlDialect;
  /** PostgreSQL: the database the job connects to; MySQL/MariaDB: the table's database. */
  readonly database: string | undefined;
  /** PostgreSQL schema; the database on MySQL/MariaDB. */
  readonly schema: string;
  /** The table to import into, or null to create a new one. */
  readonly table: string | null;
  readonly readOnly: boolean;
  readonly production: boolean;
  /** Production, or the profile's own "ask before every write". */
  readonly confirmWrites: boolean;
}

/** A column of the existing target table. */
export interface TargetColumn {
  readonly name: string;
  readonly dataType: string;
  readonly nullable: boolean;
  /** Has a default, identity or auto-increment: can be left unmapped. */
  readonly defaulted: boolean;
}

/** A file column of a new table, as the user edits it. */
export interface NewColumnDraft {
  readonly source: string;
  readonly include: boolean;
  /** Blank keeps the planned name. */
  readonly name: string;
  /** Blank keeps the inferred type. */
  readonly dataType: string;
  readonly nullable: boolean;
}

export interface ImportWizardApi {
  pickFile(): Promise<string | null>;
  preview(input: TransferPreviewInput): Promise<TransferPreview>;
  autoMatch(input: { sources: string[]; targets: string[] }): Promise<ColumnMappingInfo[]>;
  planTable(input: NewTablePlanInput): Promise<NewTablePlan>;
  loadTable(target: ImportTarget): Promise<TableDef>;
  confirm(options: {
    readonly title: string;
    readonly message: string;
    readonly confirmLabel: string;
    readonly danger: boolean;
  }): Promise<boolean>;
  /** Starts the job; undefined when the user dismissed a secrets prompt. */
  start(job: ImportJob): Promise<string | undefined>;
}

export interface ImportWizardState {
  readonly step: ImportStep;
  readonly target: ImportTarget;
  readonly path: string | undefined;
  /** What is being worked on ("Reading the file…"), while it is. */
  readonly busy: string | undefined;
  readonly error: string | undefined;
  /** File options the user fixed; the preview detects the rest. */
  readonly format: TransferRowFormat | undefined;
  readonly encoding: string | undefined;
  readonly csv: CsvReadSettings;
  readonly preview: TransferPreview | undefined;
  /** Existing table: its columns, and which one each file column goes to ('' skips it). */
  readonly tableColumns: readonly TargetColumn[];
  readonly primaryKey: readonly string[];
  readonly mapping: Readonly<Record<string, string>>;
  /** New table: its name, the file columns as edited, and the plan built from them. */
  readonly newTableName: string;
  readonly newColumns: readonly NewColumnDraft[];
  /** New table primary key, by file column. */
  readonly newPrimaryKey: readonly string[];
  readonly plan: NewTablePlan | undefined;
  readonly planError: string | undefined;
  readonly mode: ImportMode;
  readonly keyColumns: readonly string[];
  readonly batchSize: number;
  readonly transaction: 'single' | 'per-batch';
  readonly onError: 'stop' | 'skip';
  readonly disableForeignKeys: boolean;
  /** The job the wizard started. */
  readonly jobId: string | undefined;
}

const ROW_FORMATS: readonly string[] = ['csv', 'tsv', 'json', 'jsonl'];

/** A table name from a file name: `Orders 2024.csv.gz` → `orders_2024`. */
export function tableNameFromFile(path: string): string {
  const file = path.split(/[\\/]/).pop() ?? '';
  const base = file.replace(/(\.gz)?$/i, '').replace(/\.[^.]*$/, '');
  const name = base
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_]+/gu, '_')
    .replace(/^_+|_+$/g, '');
  return (/^\p{N}/u.test(name) ? `t_${name}` : name) || 'imported';
}

export function initialImportState(target: ImportTarget): ImportWizardState {
  return {
    step: 'file',
    target,
    path: undefined,
    busy: undefined,
    error: target.readOnly
      ? `"${target.profileName}" is read-only, so nothing can be imported into it.`
      : undefined,
    format: undefined,
    encoding: undefined,
    csv: {},
    preview: undefined,
    tableColumns: [],
    primaryKey: [],
    mapping: {},
    newTableName: '',
    newColumns: [],
    newPrimaryKey: [],
    plan: undefined,
    planError: undefined,
    mode: 'append',
    keyColumns: [],
    batchSize: 1000,
    transaction: 'single',
    onError: 'stop',
    disableForeignKeys: false,
    jobId: undefined,
  };
}

/** The mapped pairs, in file column order. */
export function mappedPairs(state: ImportWizardState): ColumnMappingInfo[] {
  if (state.target.table === null) {
    return (state.plan?.columns ?? []).map((column) => ({
      source: column.source,
      target: column.name,
    }));
  }
  return (state.preview?.columns ?? []).flatMap((column) => {
    const target = state.mapping[column.name];
    return target ? [{ source: column.name, target }] : [];
  });
}

/** Why the wizard cannot move on from its current step, if it cannot. */
export function stepProblem(state: ImportWizardState): string | undefined {
  if (state.target.readOnly) return 'The connection is read-only';
  switch (state.step) {
    case 'file':
      return state.preview === undefined ? 'Choose a file to import' : undefined;
    case 'preview':
      if (!state.preview) return 'Choose a file to import';
      if (!ROW_FORMATS.includes(state.preview.format)) {
        return 'This is a SQL script; run it with "Run SQL file…" instead';
      }
      return state.preview.columns.length === 0 ? 'The file has no columns to import' : undefined;
    case 'mapping':
      return mappingProblem(state);
    case 'options':
    case 'review':
      return mappingProblem(state) ?? optionsProblem(state);
  }
}

function mappingProblem(state: ImportWizardState): string | undefined {
  if (state.target.table === null) {
    if (state.newTableName.trim() === '') return 'Name the new table';
    if (!state.newColumns.some((c) => c.include)) return 'Include at least one column';
    const badType = state.newColumns.find(
      (c) => c.include && c.dataType.trim() !== '' && !DATA_TYPE_PATTERN.test(c.dataType.trim()),
    );
    if (badType) return `"${badType.dataType}" is not a column type Joinery can use`;
    if (state.planError) return state.planError;
    return state.plan === undefined ? 'Planning the new table…' : undefined;
  }
  const pairs = mappedPairs(state);
  if (pairs.length === 0) return 'Map at least one column';
  const seen = new Set<string>();
  for (const { target } of pairs) {
    if (seen.has(target)) return `Column "${target}" is mapped more than once`;
    seen.add(target);
  }
  return undefined;
}

function optionsProblem(state: ImportWizardState): string | undefined {
  const keyed = state.mode === 'update' || state.mode === 'upsert' || state.mode === 'delete';
  if (!keyed) return undefined;
  if (state.keyColumns.length === 0) return `Mode "${state.mode}" needs key columns`;
  const mapped = new Set(mappedPairs(state).map((pair) => pair.target));
  const unmapped = state.keyColumns.find((key) => !mapped.has(key));
  if (unmapped) return `Key column "${unmapped}" is not mapped`;
  if (state.mode === 'update' && mapped.size <= state.keyColumns.length) {
    return 'Update needs a mapped column besides the keys';
  }
  return undefined;
}

/** The job the wizard's current state describes. */
export function buildImportJob(state: ImportWizardState, confirmed: boolean): ImportJob {
  const { target, preview } = state;
  if (!state.path || !preview || !ROW_FORMATS.includes(preview.format)) {
    throw new Error('Choose a file to import first');
  }
  const format = preview.format as TransferRowFormat;
  const csv =
    (format === 'csv' || format === 'tsv') && preview.csv
      ? {
          delimiter: preview.csv.delimiter,
          quote: preview.csv.quote,
          escape: preview.csv.escape,
          nullMarker: preview.csv.nullMarker,
          header: preview.csv.header,
        }
      : undefined;
  const newTable = target.table === null;
  const plan = state.plan;
  return {
    kind: 'import',
    profileId: target.profileId,
    ...(target.database !== undefined ? { database: target.database } : {}),
    file: {
      path: state.path,
      format,
      encoding: preview.encoding,
      ...(csv ? { csv } : {}),
    },
    table: {
      ...(target.dialect === 'postgres' ? { schema: target.schema } : {}),
      name: newTable ? state.newTableName.trim() : target.table!,
    },
    ...(newTable && plan ? { create: { columns: plan.columns, primaryKey: plan.primaryKey } } : {}),
    mapping: mappedPairs(state),
    mode: newTable ? 'append' : state.mode,
    ...(!newTable && state.mode !== 'append' && state.mode !== 'replace'
      ? { keyColumns: [...state.keyColumns] }
      : {}),
    batchSize: state.batchSize,
    transaction: state.transaction,
    onError: state.onError,
    ...(state.disableForeignKeys && !newTable ? { disableForeignKeys: true } : {}),
    ...(confirmed ? { confirmed: true } : {}),
  };
}

/** The wizard's options worth saving as a transfer profile. */
export function importSettingsOf(state: ImportWizardState): ImportSettings {
  const format = state.preview?.format;
  return {
    ...(format !== undefined && ROW_FORMATS.includes(format)
      ? { format: format as TransferRowFormat }
      : {}),
    ...(state.encoding !== undefined ? { encoding: state.encoding } : {}),
    ...(Object.keys(state.csv).length > 0 ? { csv: state.csv } : {}),
    mode: state.mode,
    batchSize: state.batchSize,
    transaction: state.transaction,
    onError: state.onError,
    disableForeignKeys: state.disableForeignKeys,
  };
}

/** One run of the import wizard. */
export class ImportWizard {
  readonly store: StoreApi<ImportWizardState>;
  readonly #api: ImportWizardApi;
  #previewSeq = 0;
  #planSeq = 0;
  #table: TableDef | undefined;

  constructor(target: ImportTarget, api: ImportWizardApi) {
    this.store = createStore<ImportWizardState>()(() => initialImportState(target));
    this.#api = api;
  }

  get state(): ImportWizardState {
    return this.store.getState();
  }

  #set(patch: Partial<ImportWizardState>): void {
    this.store.setState(patch);
  }

  /** Asks for the file, previews it and moves to the preview. */
  async chooseFile(): Promise<void> {
    const path = await this.#api.pickFile();
    if (path === null) return;
    this.#set({
      path,
      format: undefined,
      encoding: undefined,
      csv: {},
      preview: undefined,
      mapping: {},
      newColumns: [],
      plan: undefined,
      newTableName: tableNameFromFile(path),
    });
    if (await this.refreshPreview()) this.#set({ step: 'preview' });
  }

  /** Fixes file options (format, encoding, CSV dialect) and previews again. */
  async setFileOptions(patch: {
    readonly format?: TransferRowFormat | undefined;
    readonly encoding?: string | undefined;
    readonly csv?: CsvReadSettings;
  }): Promise<void> {
    this.#set({
      ...('format' in patch ? { format: patch.format } : {}),
      ...('encoding' in patch ? { encoding: patch.encoding } : {}),
      ...(patch.csv !== undefined ? { csv: { ...this.state.csv, ...patch.csv } } : {}),
    });
    await this.refreshPreview();
  }

  /** Reads the file again with the current options; false when it could not be read. */
  async refreshPreview(): Promise<boolean> {
    const { path, format, encoding, csv, target } = this.state;
    if (!path) return false;
    const seq = ++this.#previewSeq;
    this.#set({ busy: 'Reading the file…', error: undefined });
    try {
      const preview = await this.#api.preview({
        path,
        dialect: target.dialect,
        ...(format !== undefined ? { format } : {}),
        ...(encoding !== undefined ? { encoding } : {}),
        ...(Object.keys(csv).length > 0 ? { csv } : {}),
      });
      if (seq !== this.#previewSeq) return false;
      this.#set({ preview, busy: undefined });
      return true;
    } catch (error) {
      if (seq !== this.#previewSeq) return false;
      this.#set({ busy: undefined, error: errorMessage(error) });
      return false;
    }
  }

  async next(): Promise<void> {
    const state = this.state;
    if (stepProblem(state) !== undefined || state.busy) return;
    switch (state.step) {
      case 'file':
        this.#set({ step: 'preview' });
        return;
      case 'preview':
        if (await this.#prepareMapping()) this.#set({ step: 'mapping' });
        return;
      case 'mapping':
        this.#set({
          step: 'options',
          ...(state.keyColumns.length === 0 ? { keyColumns: this.#defaultKeys() } : {}),
        });
        return;
      case 'options':
        this.#set({ step: 'review' });
        return;
      case 'review':
        return;
    }
  }

  back(): void {
    const at = IMPORT_STEPS.indexOf(this.state.step);
    if (at > 0 && !this.state.busy) this.#set({ step: IMPORT_STEPS[at - 1]!, error: undefined });
  }

  #defaultKeys(): string[] {
    const mapped = new Set(mappedPairs(this.state).map((pair) => pair.target));
    return this.state.primaryKey.filter((key) => mapped.has(key));
  }

  async #prepareMapping(): Promise<boolean> {
    const { preview, target } = this.state;
    if (!preview) return false;
    const sources = preview.columns.map((column) => column.name);
    if (target.table === null) {
      const known = new Map(this.state.newColumns.map((column) => [column.source, column]));
      this.#set({
        newColumns: sources.map(
          (source) =>
            known.get(source) ?? {
              source,
              include: true,
              name: '',
              dataType: '',
              nullable: true,
            },
        ),
        newPrimaryKey: this.state.newPrimaryKey.filter((key) => sources.includes(key)),
      });
      await this.replan();
      return this.state.planError === undefined;
    }
    this.#set({ busy: 'Reading the table…', error: undefined });
    try {
      this.#table ??= await this.#api.loadTable(target);
      const columns: TargetColumn[] = this.#table.columns
        .filter((column) => column.generated === undefined)
        .map((column) => ({
          name: column.name,
          dataType: column.dataType,
          nullable: column.nullable,
          defaulted:
            column.default !== null || column.identity !== undefined || column.autoIncrement,
        }));
      const pairs = await this.#api.autoMatch({
        sources,
        targets: columns.map((column) => column.name),
      });
      const kept = Object.fromEntries(
        Object.entries(this.state.mapping).filter(([source]) => sources.includes(source)),
      );
      this.#set({
        busy: undefined,
        tableColumns: columns,
        primaryKey: [...(this.#table.primaryKey?.columns ?? [])],
        mapping:
          Object.keys(kept).length > 0
            ? kept
            : Object.fromEntries(pairs.map((pair) => [pair.source, pair.target])),
      });
      return true;
    } catch (error) {
      this.#set({ busy: undefined, error: errorMessage(error) });
      return false;
    }
  }

  /** Maps a file column to a table column, or skips it (''). */
  setMapping(source: string, target: string): void {
    this.#set({ mapping: { ...this.state.mapping, [source]: target } });
  }

  setNewTableName(name: string): void {
    this.#set({ newTableName: name });
    void this.replan();
  }

  setNewColumn(source: string, patch: Partial<Omit<NewColumnDraft, 'source'>>): void {
    this.#set({
      newColumns: this.state.newColumns.map((column) =>
        column.source === source ? { ...column, ...patch } : column,
      ),
      ...(patch.include === false
        ? { newPrimaryKey: this.state.newPrimaryKey.filter((key) => key !== source) }
        : {}),
    });
    void this.replan();
  }

  togglePrimaryKey(source: string): void {
    const current = this.state.newPrimaryKey;
    this.#set({
      newPrimaryKey: current.includes(source)
        ? current.filter((key) => key !== source)
        : [...current, source],
    });
    void this.replan();
  }

  /** Plans the new table from the preview's columns and the user's edits. */
  async replan(): Promise<void> {
    const { preview, target, newColumns, newTableName, newPrimaryKey } = this.state;
    if (!preview || target.table !== null) return;
    const included = newColumns.filter((column) => column.include);
    const name = newTableName.trim();
    const seq = ++this.#planSeq;
    const invalidType = included.find(
      (c) => c.dataType.trim() !== '' && !DATA_TYPE_PATTERN.test(c.dataType.trim()),
    );
    if (included.length === 0 || name === '' || invalidType) {
      this.#set({ plan: undefined, planError: undefined });
      return;
    }
    const inferred = new Map(preview.columns.map((column) => [column.name, column]));
    try {
      const plan = await this.#api.planTable({
        dialect: target.dialect,
        name,
        ...(target.dialect === 'postgres' ? { schema: target.schema } : {}),
        columns: included.map((column) => ({
          inferred: inferred.get(column.source)!,
          ...(column.name.trim() !== '' ? { name: column.name.trim() } : {}),
          ...(column.dataType.trim() !== '' ? { dataType: column.dataType.trim() } : {}),
          nullable: column.nullable,
        })),
        primaryKey: newPrimaryKey.filter((key) => included.some((c) => c.source === key)),
      });
      if (seq === this.#planSeq) this.#set({ plan, planError: undefined });
    } catch (error) {
      if (seq === this.#planSeq) this.#set({ plan: undefined, planError: errorMessage(error) });
    }
  }

  setOptions(
    patch: Partial<
      Pick<
        ImportWizardState,
        'mode' | 'keyColumns' | 'batchSize' | 'transaction' | 'onError' | 'disableForeignKeys'
      >
    >,
  ): void {
    this.#set(patch);
  }

  /** Applies saved settings: file options preview again, the rest fill the options step. */
  async applySettings(settings: ImportSettings): Promise<void> {
    this.#set({
      ...(settings.mode !== undefined && this.state.target.table !== null
        ? { mode: settings.mode }
        : {}),
      ...(settings.batchSize !== undefined ? { batchSize: settings.batchSize } : {}),
      ...(settings.transaction !== undefined ? { transaction: settings.transaction } : {}),
      ...(settings.onError !== undefined ? { onError: settings.onError } : {}),
      ...(settings.disableForeignKeys !== undefined
        ? { disableForeignKeys: settings.disableForeignKeys }
        : {}),
    });
    if (settings.format !== undefined || settings.encoding !== undefined || settings.csv) {
      await this.setFileOptions({
        ...(settings.format !== undefined ? { format: settings.format } : {}),
        ...(settings.encoding !== undefined ? { encoding: settings.encoding } : {}),
        ...(settings.csv !== undefined ? { csv: settings.csv } : {}),
      });
    }
  }

  /**
   * Starts the import after the write rules: production and "confirm every write" profiles
   * ask, replace warns that the table is emptied first, delete that rows go. Returns the job
   * id, or undefined when the user said no.
   */
  async run(): Promise<string | undefined> {
    const state = this.state;
    const problem = stepProblem(state);
    if (problem !== undefined) {
      this.#set({ error: problem });
      return undefined;
    }
    const { target } = state;
    const table = target.table ?? state.newTableName.trim();
    const mode = target.table === null ? 'append' : state.mode;
    let confirmed = false;
    if (mode === 'replace' || mode === 'delete') {
      const ok = await this.#api.confirm({
        title: mode === 'replace' ? `Replace the rows of ${table}?` : `Delete rows of ${table}?`,
        message:
          mode === 'replace'
            ? `Replace empties ${table} first: every row in it now is deleted and the file's rows take their place.${target.production ? ' This is a production connection.' : ''}`
            : `Rows of ${table} that match the file's key columns are deleted.${target.production ? ' This is a production connection.' : ''}`,
        confirmLabel: mode === 'replace' ? 'Empty and import' : 'Delete matching rows',
        danger: true,
      });
      if (!ok) return undefined;
      confirmed = true;
    } else if (target.confirmWrites) {
      const ok = await this.#api.confirm({
        title: target.production ? 'Import into a production connection?' : 'Import these rows?',
        message: `The file's rows are written to ${table} on "${target.profileName}".`,
        confirmLabel: 'Import',
        danger: target.production,
      });
      if (!ok) return undefined;
      confirmed = true;
    }
    this.#set({ busy: 'Starting the import…', error: undefined });
    try {
      const jobId = await this.#api.start(buildImportJob(this.state, confirmed));
      this.#set({ busy: undefined, jobId });
      return jobId;
    } catch (error) {
      this.#set({ busy: undefined, error: errorMessage(error) });
      return undefined;
    }
  }
}
