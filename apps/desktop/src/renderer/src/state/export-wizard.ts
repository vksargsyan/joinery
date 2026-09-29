import type { CellValue, SqlDialect } from '@joinery/core';
import type { ExportJob, ExportSettings, TransferExportFormat } from '@joinery/ipc';
import { createStore, type StoreApi } from 'zustand/vanilla';

import { errorMessage } from '../lib/errors';

/**
 * The export wizard (spec §12) as a state machine: the tables to export (several from one
 * database or schema), or a query result that the job runner runs again → the format and its
 * options (header, delimiter, NULL marker, JSON pretty or lines, Excel decimals, SQL INSERT
 * batch size, with DDL, gzip or a ZIP archive, byte order mark) and one file per table or one
 * combined file → the destination → run as a job. The page never touches the file system: the
 * destination comes from main's save or folder dialog, and the job runner writes it.
 */

export const EXPORT_STEPS = ['source', 'format', 'destination'] as const;
export type ExportStep = (typeof EXPORT_STEPS)[number];

interface SourceBase {
  readonly profileId: string;
  readonly profileName: string;
  readonly dialect: SqlDialect;
  /** PostgreSQL: the database the job connects to; MySQL/MariaDB: the tables' database. */
  readonly database: string | undefined;
}

export type ExportSource =
  | (SourceBase & {
      readonly kind: 'tables';
      /** PostgreSQL schema; the database on MySQL/MariaDB. */
      readonly schema: string;
      /** Tables selected when the wizard opens. */
      readonly tables: readonly string[];
    })
  | (SourceBase & {
      readonly kind: 'query';
      readonly text: string;
      readonly params?: readonly CellValue[];
    });

export interface ExportWizardApi {
  saveFile(options: {
    readonly title: string;
    readonly defaultName: string;
    readonly filters: readonly { readonly name: string; readonly extensions: string[] }[];
  }): Promise<string | null>;
  openDirectory(options: { readonly title: string }): Promise<string | null>;
  /** Starts the job; undefined when the user dismissed a secrets prompt. */
  start(job: ExportJob): Promise<string | undefined>;
}

export interface ExportWizardState {
  readonly step: ExportStep;
  readonly source: ExportSource;
  /** Tables of the schema to choose from. */
  readonly available: readonly string[];
  readonly selected: readonly string[];
  readonly format: TransferExportFormat;
  readonly header: boolean;
  /** CSV delimiter (TSV always uses a tab). */
  readonly delimiter: string;
  /** Text written for NULL in CSV and TSV. */
  readonly nullMarker: string;
  readonly pretty: boolean;
  readonly rowsPerStatement: number;
  readonly dropTable: boolean;
  /** Excel: decimals that fit a double exactly as numbers (else every decimal as text). */
  readonly decimalsAsNumbers: boolean;
  readonly gzip: boolean;
  /** A ZIP archive holding a file per table (or the query's file); never with gzip. */
  readonly zip: boolean;
  readonly bom: boolean;
  readonly encoding: 'utf-8' | 'utf-16le';
  /** Several tables: one file per table, or one combined file (not CSV, TSV, JSON Lines). */
  readonly layout: 'per-table' | 'combined';
  /** The file or folder picked. */
  readonly path: string | undefined;
  readonly busy: string | undefined;
  readonly error: string | undefined;
  readonly jobId: string | undefined;
}

export const EXPORT_FORMAT_LABELS: Readonly<Record<TransferExportFormat, string>> = {
  csv: 'CSV',
  tsv: 'TSV',
  json: 'JSON',
  jsonl: 'JSON Lines',
  xlsx: 'Excel workbook (.xlsx)',
  xml: 'XML',
  sql: 'SQL INSERT statements',
  'sql-ddl': 'SQL with DDL (CREATE TABLE and INSERTs)',
  html: 'HTML page',
  markdown: 'Markdown tables',
};

const EXTENSIONS: Readonly<Record<TransferExportFormat, string>> = {
  csv: 'csv',
  tsv: 'tsv',
  json: 'json',
  jsonl: 'jsonl',
  xlsx: 'xlsx',
  xml: 'xml',
  sql: 'sql',
  'sql-ddl': 'sql',
  html: 'html',
  markdown: 'md',
};

/** Formats that can hold several tables in one file. */
export function combinable(format: TransferExportFormat): boolean {
  return format !== 'csv' && format !== 'tsv' && format !== 'jsonl';
}

/** Formats written as text, where encoding and byte order mark apply. */
export function textFormat(format: TransferExportFormat): boolean {
  return format !== 'xlsx';
}

export function initialExportState(
  source: ExportSource,
  available: readonly string[] = [],
): ExportWizardState {
  return {
    step: source.kind === 'query' ? 'format' : 'source',
    source,
    available: source.kind === 'tables' ? [...new Set([...available, ...source.tables])] : [],
    selected: source.kind === 'tables' ? [...source.tables] : [],
    format: 'csv',
    header: true,
    delimiter: ',',
    nullMarker: '',
    pretty: false,
    rowsPerStatement: 100,
    dropTable: false,
    decimalsAsNumbers: false,
    gzip: false,
    zip: false,
    bom: false,
    encoding: 'utf-8',
    layout: 'per-table',
    path: undefined,
    busy: undefined,
    error: undefined,
    jobId: undefined,
  };
}

/** Whether the export writes one file (else one per table into a folder). A ZIP is one file. */
export function writesOneFile(state: ExportWizardState): boolean {
  return (
    state.zip ||
    state.source.kind === 'query' ||
    state.selected.length <= 1 ||
    state.layout === 'combined'
  );
}

/** The file name the save dialog suggests. */
export function suggestedName(state: ExportWizardState): string {
  const base =
    state.source.kind === 'query'
      ? 'query_result'
      : state.selected.length === 1
        ? state.selected[0]!
        : state.source.schema;
  const safe = base.replace(/[<>:"/\\|?*]/g, '_');
  if (state.zip) return `${safe}.zip`;
  return `${safe}.${EXTENSIONS[state.format]}${state.gzip ? '.gz' : ''}`;
}

export function exportStepProblem(state: ExportWizardState): string | undefined {
  const source = state.source;
  switch (state.step) {
    case 'source':
      return state.selected.length === 0 ? 'Choose at least one table' : undefined;
    case 'format':
      if (source.kind === 'query' && state.format === 'sql-ddl') {
        return 'SQL with DDL exports tables, not a query result';
      }
      if (state.format === 'csv' && state.delimiter.length !== 1) {
        return 'The delimiter is one character';
      }
      if (
        source.kind === 'tables' &&
        state.selected.length > 1 &&
        state.layout === 'combined' &&
        !combinable(state.format)
      ) {
        return `A combined file is not available for ${EXPORT_FORMAT_LABELS[state.format]}; export one file per table`;
      }
      return undefined;
    case 'destination':
      return state.path === undefined
        ? writesOneFile(state)
          ? 'Choose the file to write'
          : 'Choose the folder to write the files to'
        : undefined;
  }
}

/** The job the wizard's current state describes. */
export function buildExportJob(state: ExportWizardState): ExportJob {
  const { source } = state;
  if (state.path === undefined) throw new Error('Choose where to export first');
  const csvLike = state.format === 'csv' || state.format === 'tsv';
  const text = textFormat(state.format);
  const zip = state.zip;
  return {
    kind: 'export',
    profileId: source.profileId,
    ...(source.database !== undefined ? { database: source.database } : {}),
    source:
      source.kind === 'query'
        ? {
            kind: 'query',
            text: source.text,
            ...(source.params !== undefined && source.params.length > 0
              ? { params: [...source.params] }
              : {}),
          }
        : {
            kind: 'tables',
            ...(source.dialect === 'postgres' ? { schema: source.schema } : {}),
            tables: [...state.selected],
          },
    format: state.format,
    ...(csvLike
      ? {
          csv: {
            header: state.header,
            ...(state.format === 'csv' ? { delimiter: state.delimiter } : {}),
            nullMarker: state.nullMarker === '' ? null : state.nullMarker,
          },
        }
      : {}),
    ...(state.format === 'json' ? { json: { pretty: state.pretty } } : {}),
    ...(state.format === 'sql' || state.format === 'sql-ddl'
      ? {
          sql: {
            rowsPerStatement: state.rowsPerStatement,
            ...(state.format === 'sql-ddl' && state.dropTable ? { dropTable: true } : {}),
          },
        }
      : {}),
    ...(state.format === 'xlsx'
      ? {
          xlsx: {
            header: state.header,
            decimals: state.decimalsAsNumbers ? ('number' as const) : ('text' as const),
          },
        }
      : {}),
    ...(text && state.encoding !== 'utf-8' ? { encoding: state.encoding } : {}),
    ...(text && state.bom ? { bom: true } : {}),
    ...(zip ? { zip: true } : state.gzip ? { gzip: true } : {}),
    output: writesOneFile(state)
      ? { kind: 'file', path: state.path }
      : { kind: 'directory', path: state.path },
  };
}

/** The wizard's options worth saving as a transfer profile. */
export function exportSettingsOf(state: ExportWizardState): ExportSettings {
  return {
    format: state.format,
    csv: {
      header: state.header,
      delimiter: state.delimiter,
      nullMarker: state.nullMarker === '' ? null : state.nullMarker,
    },
    json: { pretty: state.pretty },
    sql: { rowsPerStatement: state.rowsPerStatement, dropTable: state.dropTable },
    xlsx: { header: state.header, decimals: state.decimalsAsNumbers ? 'number' : 'text' },
    encoding: state.encoding,
    bom: state.bom,
    gzip: state.gzip,
    zip: state.zip,
    layout: state.layout,
  };
}

/** One run of the export wizard. */
export class ExportWizard {
  readonly store: StoreApi<ExportWizardState>;
  readonly #api: ExportWizardApi;

  constructor(source: ExportSource, api: ExportWizardApi, available: readonly string[] = []) {
    this.store = createStore<ExportWizardState>()(() => initialExportState(source, available));
    this.#api = api;
  }

  get state(): ExportWizardState {
    return this.store.getState();
  }

  #set(patch: Partial<ExportWizardState>): void {
    this.store.setState(patch);
  }

  /** The tables to choose from, once the schema's list has loaded. */
  setAvailable(tables: readonly string[]): void {
    this.#set({ available: [...new Set([...tables, ...this.state.selected])] });
  }

  toggleTable(table: string): void {
    const selected = this.state.selected;
    this.#set({
      selected: selected.includes(table)
        ? selected.filter((t) => t !== table)
        : this.state.available.filter((t) => t === table || selected.includes(t)),
      path: undefined,
    });
  }

  selectAll(all: boolean): void {
    this.#set({ selected: all ? [...this.state.available] : [], path: undefined });
  }

  /**
   * Changes format options. A change that alters the file name or the one-file-or-folder
   * choice forgets the destination, so it is picked again.
   */
  setOptions(
    patch: Partial<
      Pick<
        ExportWizardState,
        | 'format'
        | 'header'
        | 'delimiter'
        | 'nullMarker'
        | 'pretty'
        | 'rowsPerStatement'
        | 'dropTable'
        | 'decimalsAsNumbers'
        | 'gzip'
        | 'zip'
        | 'bom'
        | 'encoding'
        | 'layout'
      >
    >,
  ): void {
    const resets =
      patch.format !== undefined ||
      patch.gzip !== undefined ||
      patch.zip !== undefined ||
      patch.layout;
    this.#set({ ...patch, ...(resets ? { path: undefined } : {}) });
    // gzip and ZIP exclude each other; a workbook is compressed already; a ZIP holds a file
    // per table, not a combined one.
    if (patch.zip === true) this.#set({ gzip: false, layout: 'per-table' });
    if (patch.gzip === true) this.#set({ zip: false });
    if (patch.layout === 'combined') this.#set({ zip: false });
    if (this.state.format === 'xlsx' && this.state.gzip) this.#set({ gzip: false });
    if (
      patch.format !== undefined &&
      !combinable(patch.format) &&
      this.state.layout === 'combined'
    ) {
      this.#set({ layout: 'per-table' });
    }
  }

  applySettings(settings: ExportSettings): void {
    this.setOptions({
      ...(settings.format !== undefined &&
      !(settings.format === 'sql-ddl' && this.state.source.kind === 'query')
        ? { format: settings.format }
        : {}),
      ...(settings.csv?.header !== undefined ? { header: settings.csv.header } : {}),
      ...(settings.csv?.delimiter !== undefined ? { delimiter: settings.csv.delimiter } : {}),
      ...(settings.csv?.nullMarker !== undefined
        ? { nullMarker: settings.csv.nullMarker ?? '' }
        : {}),
      ...(settings.json?.pretty !== undefined ? { pretty: settings.json.pretty } : {}),
      ...(settings.sql?.rowsPerStatement !== undefined
        ? { rowsPerStatement: settings.sql.rowsPerStatement }
        : {}),
      ...(settings.sql?.dropTable !== undefined ? { dropTable: settings.sql.dropTable } : {}),
      ...(settings.format === 'xlsx' && settings.xlsx?.header !== undefined
        ? { header: settings.xlsx.header }
        : {}),
      ...(settings.xlsx?.decimals !== undefined
        ? { decimalsAsNumbers: settings.xlsx.decimals === 'number' }
        : {}),
      ...(settings.encoding !== undefined ? { encoding: settings.encoding } : {}),
      ...(settings.bom !== undefined ? { bom: settings.bom } : {}),
      ...(settings.layout !== undefined ? { layout: settings.layout } : {}),
      ...(settings.gzip !== undefined ? { gzip: settings.gzip } : {}),
      ...(settings.zip !== undefined ? { zip: settings.zip } : {}),
    });
  }

  next(): void {
    if (exportStepProblem(this.state) !== undefined) return;
    const at = EXPORT_STEPS.indexOf(this.state.step);
    if (at < EXPORT_STEPS.length - 1) this.#set({ step: EXPORT_STEPS[at + 1]!, error: undefined });
  }

  back(): void {
    const at = EXPORT_STEPS.indexOf(this.state.step);
    const first = this.state.source.kind === 'query' ? 1 : 0;
    if (at > first) this.#set({ step: EXPORT_STEPS[at - 1]!, error: undefined });
  }

  /** Asks main for the file (save dialog) or the folder (one file per table). */
  async chooseDestination(): Promise<void> {
    const state = this.state;
    const path = writesOneFile(state)
      ? await this.#api.saveFile({
          title: 'Export to',
          defaultName: suggestedName(state),
          filters: [
            state.zip
              ? { name: 'ZIP archive', extensions: ['zip'] }
              : {
                  name: EXPORT_FORMAT_LABELS[state.format],
                  extensions: state.gzip ? ['gz'] : [EXTENSIONS[state.format]],
                },
          ],
        })
      : await this.#api.openDirectory({ title: 'Export the tables into' });
    if (path !== null) this.#set({ path, error: undefined });
  }

  async run(): Promise<string | undefined> {
    const problem = exportStepProblem({ ...this.state, step: 'destination' });
    if (problem !== undefined) {
      this.#set({ error: problem });
      return undefined;
    }
    this.#set({ busy: 'Starting the export…', error: undefined });
    try {
      const jobId = await this.#api.start(buildExportJob(this.state));
      this.#set({ busy: undefined, jobId });
      return jobId;
    } catch (error) {
      this.#set({ busy: undefined, error: errorMessage(error) });
      return undefined;
    }
  }
}
