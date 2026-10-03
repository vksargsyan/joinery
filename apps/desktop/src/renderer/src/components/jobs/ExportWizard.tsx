import type { TransferExportFormat } from '@querybara/ipc';
import { useEffect, useState } from 'react';
import { useStore } from 'zustand';

import { mainApi } from '../../lib/main-client';
import {
  EXPORT_FORMAT_LABELS,
  EXPORT_STEPS,
  ExportWizard,
  buildExportJob,
  combinable,
  exportSettingsOf,
  gzipAllowed,
  textFormat,
  exportStepProblem,
  suggestedName,
  writesOneFile,
  type ExportSource,
  type ExportStep,
  type ExportWizardApi,
  type ExportWizardState,
  type ParquetCompression,
} from '../../state/export-wizard';
import { loadChildren, pathKey, useExplorer } from '../../state/explorer';
import { startJob } from '../../state/jobs';
import { editSchedule, exportDraft } from '../../state/schedules';
import { SelectField, TextField } from '../designer/fields';
import { Button, Modal } from '../ui';
import { SavedSettings, StepBar } from './shared';

/**
 * The export wizard's dialog (spec §12): tables of one schema (or a query result) → format and
 * options → destination, then a job in the job runner writes the files.
 */

/** What each format writes, under the format picker. */
const FORMAT_NOTES: Partial<Readonly<Record<TransferExportFormat, string>>> = {
  jsonl: 'One JSON object per line.',
  xlsx: 'Typed cells: numbers, booleans, and dates as Excel dates. Several tables go on one worksheet each.',
  xml: 'An <export> of <table> elements with one <row> per row; NULL is xsi:nil.',
  parquet:
    'Columnar and typed, for DuckDB, Spark, pandas and warehouses: integers, exact decimals, dates, timestamps and UUIDs keep their types. One table per file.',
  html: 'A self-contained page with one table per result, readable in any browser.',
  markdown: 'Pipe tables, as GitHub and most wikis render them.',
};

type Compression = 'none' | 'gzip' | 'zip';

/** Parquet page codecs, as the codec picker names them. */
const PARQUET_CODECS: Readonly<Record<ParquetCompression, string>> = {
  snappy: 'Snappy (fast, read everywhere)',
  zstd: 'ZSTD (smaller files)',
  gzip: 'GZIP (for older readers)',
  none: 'None',
};

const STEP_LABELS: Readonly<Record<ExportStep, string>> = {
  source: 'Tables',
  format: 'Format',
  destination: 'Destination',
};

function wizardApi(): ExportWizardApi {
  return {
    saveFile: async (options) =>
      (
        await mainApi().dialogs.saveFile({
          title: options.title,
          defaultName: options.defaultName,
          filters: options.filters.map((f) => ({ name: f.name, extensions: f.extensions })),
        })
      ).path,
    openDirectory: async (options) => (await mainApi().dialogs.openDirectory(options)).path,
    start: (job) => startJob(job),
  };
}

export function ExportWizardDialog(props: {
  readonly source: ExportSource;
  /** The explorer folder listing the schema's tables, to offer them all. */
  readonly tablesPath?: readonly string[];
  readonly onClose: () => void;
}) {
  const [wizard] = useState(() => new ExportWizard(props.source, wizardApi()));
  const state = useStore(wizard.store);
  const problem = exportStepProblem(state);
  const { source, tablesPath } = props;
  const listed = useExplorer((explorer) =>
    tablesPath ? explorer.children[source.profileId]?.[pathKey(tablesPath)]?.nodes : undefined,
  );

  useEffect(() => {
    if (tablesPath && !listed) void loadChildren(source.profileId, tablesPath);
  }, [listed, source.profileId, tablesPath]);
  useEffect(() => {
    if (listed) {
      wizard.setAvailable(listed.filter((node) => node.kind === 'table').map((node) => node.name));
    }
  }, [listed, wizard]);

  const run = async (): Promise<void> => {
    if (await wizard.run()) props.onClose();
  };
  // A scheduled query cannot be asked for its parameters: it runs as written, without them.
  const hasParams = source.kind === 'query' && (source.params?.length ?? 0) > 0;
  const schedule = (): void => {
    const job = buildExportJob({ ...state, path: state.path ?? suggestedName(state) });
    const name =
      source.kind === 'query'
        ? `Export ${source.profileName} query`
        : `Export ${state.selected.length === 1 ? state.selected[0] : `${state.selected.length} tables`}`;
    editSchedule(exportDraft(job, { profileName: source.profileName }, name));
    props.onClose();
  };
  const title =
    source.kind === 'query' ? 'Export query results' : `Export tables of ${source.schema}`;
  return (
    <Modal
      open
      onOpenChange={(open) => !open && props.onClose()}
      title={title}
      description={`${source.profileName}${source.database ? ` · ${source.database}` : ''}`}
      width="w-[720px]"
      footer={
        <>
          <span
            className="mr-auto self-center text-xs text-danger"
            role={state.error ? 'alert' : undefined}
          >
            {state.error ?? ''}
          </span>
          <Button variant="ghost" onClick={props.onClose}>
            Cancel
          </Button>
          {EXPORT_STEPS.indexOf(state.step) > (source.kind === 'query' ? 1 : 0) && (
            <Button onClick={() => wizard.back()}>Back</Button>
          )}
          {state.step === 'destination' ? (
            <>
              <Button
                onClick={schedule}
                disabled={hasParams || state.busy !== undefined}
                title={
                  hasParams
                    ? 'A query with parameters cannot run on a schedule: no one is there to fill them in'
                    : 'Export on a schedule instead, a new file each run'
                }
              >
                Schedule…
              </Button>
              <Button
                variant="primary"
                onClick={() => void run()}
                disabled={problem !== undefined || state.busy !== undefined}
              >
                Export
              </Button>
            </>
          ) : (
            <Button
              variant="primary"
              onClick={() => wizard.next()}
              disabled={problem !== undefined}
              title={problem}
            >
              Next
            </Button>
          )}
        </>
      }
    >
      <div data-testid="export-wizard">
        <StepBar
          steps={source.kind === 'query' ? EXPORT_STEPS.slice(1) : EXPORT_STEPS}
          labels={STEP_LABELS}
          current={state.step}
        />
        {state.step === 'source' && <TablesStep wizard={wizard} state={state} />}
        {state.step === 'format' && <FormatStep wizard={wizard} state={state} />}
        {state.step === 'destination' && <DestinationStep wizard={wizard} state={state} />}
        {problem && state.step !== 'destination' && (
          <p className="mt-2 text-xs text-muted">{problem}</p>
        )}
      </div>
    </Modal>
  );
}

interface StepProps {
  readonly wizard: ExportWizard;
  readonly state: ExportWizardState;
}

function TablesStep({ wizard, state }: StepProps) {
  const all = state.available.length > 0 && state.selected.length === state.available.length;
  return (
    <div className="flex flex-col gap-2 text-xs">
      <label className="flex items-center gap-1.5 font-medium">
        <input
          type="checkbox"
          checked={all}
          onChange={(event) => wizard.selectAll(event.target.checked)}
        />
        All tables ({state.available.length})
      </label>
      <ul
        className="max-h-80 overflow-auto rounded border border-border p-1"
        aria-label="Tables to export"
      >
        {state.available.map((table) => (
          <li key={table}>
            <label className="flex items-center gap-1.5 rounded px-1.5 py-0.5 hover:bg-hover">
              <input
                type="checkbox"
                checked={state.selected.includes(table)}
                onChange={() => wizard.toggleTable(table)}
              />
              <span className="font-mono">{table}</span>
            </label>
          </li>
        ))}
      </ul>
      <p className="text-muted">{state.selected.length} selected</p>
    </div>
  );
}

function FormatStep({ wizard, state }: StepProps) {
  const csvLike = state.format === 'csv' || state.format === 'tsv';
  const sql = state.format === 'sql' || state.format === 'sql-ddl';
  const several = state.source.kind === 'tables' && state.selected.length > 1;
  const compression: Compression = state.zip ? 'zip' : state.gzip ? 'gzip' : 'none';
  const note = FORMAT_NOTES[state.format];
  return (
    <div className="flex flex-col gap-3 text-xs">
      <div className="grid grid-cols-2 gap-3">
        <div className="flex flex-col gap-1">
          <label htmlFor="export-format" className="text-[11px] font-medium text-muted">
            Format
          </label>
          <SelectField
            id="export-format"
            value={state.format}
            onChange={(event) =>
              wizard.setOptions({ format: event.target.value as TransferExportFormat })
            }
          >
            {(Object.keys(EXPORT_FORMAT_LABELS) as TransferExportFormat[])
              .filter((format) => !(format === 'sql-ddl' && state.source.kind === 'query'))
              .map((format) => (
                <option key={format} value={format}>
                  {EXPORT_FORMAT_LABELS[format]}
                </option>
              ))}
          </SelectField>
        </div>
        {several && (
          <fieldset className="flex flex-col gap-1">
            <legend className="mb-1 text-[11px] font-medium text-muted">Files</legend>
            <label className="flex items-center gap-1.5">
              <input
                type="radio"
                name="export-layout"
                checked={state.layout === 'per-table'}
                onChange={() => wizard.setOptions({ layout: 'per-table' })}
              />
              One file per table
            </label>
            <label className="flex items-center gap-1.5">
              <input
                type="radio"
                name="export-layout"
                disabled={!combinable(state.format)}
                checked={state.layout === 'combined'}
                onChange={() => wizard.setOptions({ layout: 'combined' })}
              />
              One combined file
              {combinable(state.format) ? '' : ' (not for CSV, TSV, JSON Lines or Parquet)'}
            </label>
          </fieldset>
        )}
      </div>
      {note && <p className="text-muted">{note}</p>}
      {state.format === 'xlsx' && (
        <div className="flex flex-col gap-1.5">
          <label className="flex items-center gap-1.5">
            <input
              type="checkbox"
              checked={state.header}
              onChange={(event) => wizard.setOptions({ header: event.target.checked })}
            />
            Header row with the column names (bold, frozen, with filters)
          </label>
          <label className="flex items-center gap-1.5">
            <input
              type="checkbox"
              checked={state.decimalsAsNumbers}
              onChange={(event) => wizard.setOptions({ decimalsAsNumbers: event.target.checked })}
            />
            Decimals as Excel numbers when exact (up to 15 digits); otherwise decimals are text
          </label>
        </div>
      )}
      {state.format === 'parquet' && (
        <div className="flex flex-wrap items-center gap-4">
          <label className="flex items-center gap-1.5">
            Codec
            <SelectField
              aria-label="Parquet codec"
              className="w-64"
              value={state.compression}
              onChange={(event) =>
                wizard.setOptions({ compression: event.target.value as ParquetCompression })
              }
            >
              {(Object.keys(PARQUET_CODECS) as ParquetCompression[]).map((codec) => (
                <option key={codec} value={codec}>
                  {PARQUET_CODECS[codec]}
                </option>
              ))}
            </SelectField>
          </label>
        </div>
      )}
      {csvLike && (
        <div className="grid grid-cols-3 gap-3">
          <label className="flex items-center gap-1.5">
            <input
              type="checkbox"
              checked={state.header}
              onChange={(event) => wizard.setOptions({ header: event.target.checked })}
            />
            Header row with the column names
          </label>
          {state.format === 'csv' && (
            <div className="flex flex-col gap-1">
              <label htmlFor="export-delimiter" className="text-[11px] font-medium text-muted">
                Delimiter
              </label>
              <SelectField
                id="export-delimiter"
                value={state.delimiter}
                onChange={(event) => wizard.setOptions({ delimiter: event.target.value })}
              >
                <option value=",">Comma (,)</option>
                <option value=";">Semicolon (;)</option>
                <option value="|">Pipe (|)</option>
              </SelectField>
            </div>
          )}
          <div className="flex flex-col gap-1">
            <label htmlFor="export-null" className="text-[11px] font-medium text-muted">
              Write NULL as
            </label>
            <TextField
              id="export-null"
              placeholder="(empty field)"
              value={state.nullMarker}
              onChange={(event) => wizard.setOptions({ nullMarker: event.target.value })}
            />
          </div>
        </div>
      )}
      {state.format === 'json' && (
        <label className="flex items-center gap-1.5">
          <input
            type="checkbox"
            checked={state.pretty}
            onChange={(event) => wizard.setOptions({ pretty: event.target.checked })}
          />
          Pretty-print (indent each object)
        </label>
      )}
      {sql && (
        <div className="grid grid-cols-2 gap-3">
          <div className="flex flex-col gap-1">
            <label htmlFor="export-batch" className="text-[11px] font-medium text-muted">
              Rows per INSERT
            </label>
            <TextField
              id="export-batch"
              type="number"
              min={1}
              max={10000}
              value={state.rowsPerStatement}
              onChange={(event) =>
                wizard.setOptions({
                  rowsPerStatement: Math.min(10_000, Math.max(1, Number(event.target.value) || 1)),
                })
              }
            />
          </div>
          {state.format === 'sql-ddl' && (
            <label className="flex items-center gap-1.5 self-end">
              <input
                type="checkbox"
                checked={state.dropTable}
                onChange={(event) => wizard.setOptions({ dropTable: event.target.checked })}
              />
              DROP TABLE IF EXISTS before each CREATE TABLE
            </label>
          )}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-4">
        <label className="flex items-center gap-1.5">
          Compression
          <SelectField
            aria-label="Compression"
            className="w-56"
            value={compression}
            onChange={(event) => {
              const value = event.target.value as Compression;
              wizard.setOptions({ gzip: value === 'gzip', zip: value === 'zip' });
            }}
          >
            <option value="none">None</option>
            {gzipAllowed(state.format) && <option value="gzip">gzip</option>}
            <option value="zip">
              {several ? 'ZIP archive, one file per table' : 'ZIP archive'}
            </option>
          </SelectField>
        </label>
        {textFormat(state.format) && (
          <>
            <label className="flex items-center gap-1.5">
              <input
                type="checkbox"
                checked={state.bom}
                onChange={(event) => wizard.setOptions({ bom: event.target.checked })}
              />
              Byte order mark (for Excel)
            </label>
            <label className="flex items-center gap-1.5">
              Encoding
              <SelectField
                aria-label="Encoding"
                className="w-28"
                value={state.encoding}
                onChange={(event) =>
                  wizard.setOptions({ encoding: event.target.value as 'utf-8' | 'utf-16le' })
                }
              >
                <option value="utf-8">UTF-8</option>
                <option value="utf-16le">UTF-16LE</option>
              </SelectField>
            </label>
          </>
        )}
      </div>
      <SavedSettings
        kind="export"
        current={() => exportSettingsOf(wizard.state)}
        onLoad={(settings) => wizard.applySettings(settings)}
      />
    </div>
  );
}

function DestinationStep({ wizard, state }: StepProps) {
  const oneFile = writesOneFile(state);
  const what =
    state.source.kind === 'query'
      ? 'the query result'
      : state.selected.length === 1
        ? state.selected[0]
        : `${state.selected.length} tables`;
  return (
    <div className="flex flex-col items-start gap-3 text-xs">
      <p>
        Export {what} as {EXPORT_FORMAT_LABELS[state.format]}
        {state.gzip ? ', gzip-compressed' : ''}
        {state.zip
          ? ', into a ZIP archive.'
          : oneFile
            ? ' to one file.'
            : ', one file per table, into a folder.'}
      </p>
      {state.source.kind === 'query' && (
        <p className="text-muted">
          The query runs again in the job runner, so every row is exported, not only those loaded in
          the grid.
        </p>
      )}
      <Button variant="secondary" onClick={() => void wizard.chooseDestination()}>
        {oneFile ? 'Choose file…' : 'Choose folder…'}
      </Button>
      {state.path && (
        <p className="font-mono break-all" data-testid="export-destination">
          {state.path}
        </p>
      )}
    </div>
  );
}
