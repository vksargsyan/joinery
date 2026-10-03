import { QuerybaraError } from '@querybara/core';
import type { ImportMode, TransferPreview, TransferRowFormat } from '@querybara/ipc';
import { useState, type ReactNode } from 'react';
import { useStore } from 'zustand';

import { mainApi } from '../../lib/main-client';
import { confirm } from '../../state/dialogs';
import {
  IMPORT_STEPS,
  ImportWizard,
  importSettingsOf,
  mappedPairs,
  stepProblem,
  type ImportStep,
  type ImportTarget,
  type ImportWizardApi,
  type ImportWizardState,
} from '../../state/import-wizard';
import { startJob } from '../../state/jobs';
import { findTable, loadSnapshot } from '../../state/metadata';
import { SelectField, TextField } from '../designer/fields';
import { Button, Modal, cx } from '../ui';
import { PreviewTable, SavedSettings, StepBar, formatBytes } from './shared';

/**
 * The import wizard's dialog (spec §12). The state machine in state/import-wizard does the
 * work; this renders each step. The file is read by the job runner, never by this page.
 */

const STEP_LABELS: Readonly<Record<ImportStep, string>> = {
  file: 'File',
  preview: 'Preview',
  mapping: 'Columns',
  options: 'Options',
  review: 'Review',
};

const ENCODINGS = [
  'utf-8',
  'utf-16le',
  'utf-16be',
  'windows-1252',
  'iso-8859-1',
  'iso-8859-15',
  'shift_jis',
  'gbk',
];

const DELIMITERS: readonly { readonly value: string; readonly label: string }[] = [
  { value: ',', label: 'Comma (,)' },
  { value: ';', label: 'Semicolon (;)' },
  { value: '\t', label: 'Tab' },
  { value: '|', label: 'Pipe (|)' },
];

const MODES: readonly {
  readonly mode: ImportMode;
  readonly label: string;
  readonly hint: string;
}[] = [
  { mode: 'append', label: 'Append', hint: 'Insert every row' },
  { mode: 'update', label: 'Update', hint: 'Update rows that match on the key columns' },
  { mode: 'upsert', label: 'Upsert', hint: 'Insert new rows, update the ones that match' },
  { mode: 'delete', label: 'Delete matching', hint: 'Delete rows that match on the keys' },
  { mode: 'replace', label: 'Replace', hint: 'Empty the table, then insert every row' },
];

function wizardApi(): ImportWizardApi {
  return {
    pickFile: async () =>
      (
        await mainApi().dialogs.openFile({
          title: 'Import data from',
          filters: [
            {
              name: 'Data files',
              extensions: [
                'csv',
                'tsv',
                'tab',
                'txt',
                'json',
                'jsonl',
                'ndjson',
                'xlsx',
                'xlsm',
                'xml',
                'parquet',
                'parq',
                'pq',
                'gz',
              ],
            },
            { name: 'All files', extensions: ['*'] },
          ],
        })
      ).path,
    preview: (input) => mainApi().transfer.preview(input),
    autoMatch: (input) => mainApi().transfer.autoMatch(input),
    planTable: (input) => mainApi().transfer.planTable(input),
    loadTable: async (target) => {
      const snapshot = await loadSnapshot(target.profileId, {
        dialect: target.dialect,
        ...(target.database !== undefined ? { database: target.database } : {}),
        ...(target.dialect === 'postgres' ? { schemas: [target.schema] } : {}),
      });
      const table = findTable(snapshot, target.schema, target.table ?? '');
      if (!table) {
        throw new QuerybaraError({
          code: 'NOT_FOUND',
          message: `Table ${target.schema}.${target.table ?? ''} was not found`,
        });
      }
      return table;
    },
    confirm: (options) => confirm(options),
    start: (job) => startJob(job),
  };
}

export function ImportWizardDialog(props: {
  readonly target: ImportTarget;
  readonly onClose: () => void;
}) {
  const [wizard] = useState(() => new ImportWizard(props.target, wizardApi()));
  const state = useStore(wizard.store);
  const { target } = state;
  const problem = stepProblem(state);
  const run = async (): Promise<void> => {
    if (await wizard.run()) props.onClose();
  };
  const where = target.dialect === 'postgres' ? `${target.schema}.` : '';
  return (
    <Modal
      open
      onOpenChange={(open) => !open && props.onClose()}
      title={
        target.table === null
          ? `Import into a new table in ${target.schema}`
          : `Import data into ${where}${target.table}`
      }
      description={`${target.profileName}${target.database ? ` · ${target.database}` : ''}`}
      width="w-[880px]"
      footer={
        <>
          <span
            className="mr-auto self-center text-xs text-danger"
            role={state.error ? 'alert' : undefined}
          >
            {state.error ?? ''}
          </span>
          {state.busy && <span className="self-center text-xs text-muted">{state.busy}</span>}
          <Button variant="ghost" onClick={props.onClose}>
            Cancel
          </Button>
          {state.step !== 'file' && (
            <Button onClick={() => wizard.back()} disabled={state.busy !== undefined}>
              Back
            </Button>
          )}
          {state.step === 'review' ? (
            <Button
              variant={state.mode === 'replace' || state.mode === 'delete' ? 'danger' : 'primary'}
              onClick={() => void run()}
              disabled={problem !== undefined || state.busy !== undefined}
            >
              Import
            </Button>
          ) : (
            state.step !== 'file' && (
              <Button
                variant="primary"
                onClick={() => void wizard.next()}
                disabled={problem !== undefined || state.busy !== undefined}
                title={problem}
              >
                Next
              </Button>
            )
          )}
        </>
      }
    >
      <div data-testid="import-wizard">
        <StepBar steps={IMPORT_STEPS} labels={STEP_LABELS} current={state.step} />
        {state.step === 'file' && <FileStep wizard={wizard} state={state} />}
        {state.step === 'preview' && state.preview && <PreviewStep wizard={wizard} state={state} />}
        {state.step === 'mapping' &&
          (target.table === null ? (
            <NewTableStep wizard={wizard} state={state} />
          ) : (
            <MappingStep wizard={wizard} state={state} />
          ))}
        {state.step === 'options' && <OptionsStep wizard={wizard} state={state} />}
        {state.step === 'review' && <ReviewStep state={state} />}
        {state.step !== 'file' && state.step !== 'review' && problem && !state.error && (
          <p className="mt-2 text-xs text-muted">{problem}</p>
        )}
      </div>
    </Modal>
  );
}

interface StepProps {
  readonly wizard: ImportWizard;
  readonly state: ImportWizardState;
}

function FileStep({ wizard, state }: StepProps) {
  return (
    <div className="flex flex-col items-start gap-3 text-[13px]">
      <p className="text-muted">
        CSV, TSV, JSON (an array of objects), JSON Lines, Excel workbooks (.xlsx), XML and Parquet
        files, text formats optionally gzip-compressed. The format, encoding, delimiter, header,
        worksheet and XML row path are detected, and Parquet brings its own column types; you can
        change them on the next step.
      </p>
      <Button
        variant="primary"
        onClick={() => void wizard.chooseFile()}
        disabled={state.target.readOnly || state.busy !== undefined}
      >
        Choose file…
      </Button>
      {state.path && <p className="font-mono text-xs break-all">{state.path}</p>}
    </div>
  );
}

function Labelled(props: {
  readonly id: string;
  readonly label: string;
  readonly children: ReactNode;
  readonly className?: string;
}) {
  return (
    <div className={cx('flex flex-col gap-1', props.className)}>
      <label htmlFor={props.id} className="text-[11px] font-medium text-muted">
        {props.label}
      </label>
      {props.children}
    </div>
  );
}

const FORMAT_NAMES: Readonly<Record<string, string>> = {
  csv: 'CSV',
  tsv: 'TSV',
  json: 'JSON',
  jsonl: 'JSON Lines',
  xlsx: 'Excel',
  xml: 'XML',
  parquet: 'Parquet',
  sql: 'SQL',
};

const count = (n: number, one: string, many = `${one}s`): string =>
  `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

/** What a Parquet file's footer says: its size in rows, its row groups, codecs and writer. */
function parquetSummary(parquet: NonNullable<TransferPreview['parquet']>): string {
  return [
    count(parquet.rows, 'row'),
    count(parquet.rowGroups, 'row group'),
    ...(parquet.compressions.length > 0 ? [parquet.compressions.join(', ')] : []),
    ...(parquet.createdBy !== undefined ? [`written by ${parquet.createdBy}`] : []),
  ].join(' · ');
}

function PreviewStep({ wizard, state }: StepProps) {
  const preview = state.preview!;
  const csv = preview.csv;
  const csvLike = preview.format === 'csv' || preview.format === 'tsv';
  const delimiterKnown = DELIMITERS.some((d) => d.value === csv?.delimiter);
  const xml = preview.xml;
  const paths = xml
    ? xml.candidates.some((c) => c.path === xml.rowPath)
      ? xml.candidates
      : [{ path: xml.rowPath, count: 0, fields: 0 }, ...xml.candidates]
    : [];
  return (
    <div className="flex flex-col gap-3">
      <p className="font-mono text-[11px] break-all text-muted">
        {state.path} · {formatBytes(preview.size)}
        {preview.compression === 'gzip' ? ' · gzip' : ''}
        {preview.bom ? ' · byte order mark' : ''}
      </p>
      <div className="grid grid-cols-5 gap-3">
        <Labelled id="import-format" label="Format">
          <SelectField
            id="import-format"
            value={state.format ?? ''}
            onChange={(event) =>
              void wizard.setFileOptions({
                format: (event.target.value || undefined) as TransferRowFormat | undefined,
              })
            }
          >
            <option value="">
              Detected: {FORMAT_NAMES[preview.format] ?? preview.format.toUpperCase()}
            </option>
            <option value="csv">CSV</option>
            <option value="tsv">TSV</option>
            <option value="json">JSON</option>
            <option value="jsonl">JSON Lines</option>
            <option value="xlsx">Excel (.xlsx)</option>
            <option value="xml">XML</option>
            <option value="parquet">Parquet</option>
          </SelectField>
        </Labelled>
        {preview.format === 'parquet' && preview.parquet && (
          <div className="col-span-4 flex flex-col gap-1">
            <span className="text-[11px] font-medium text-muted">Parquet file</span>
            <p
              className="flex h-8 items-center truncate text-xs"
              title={parquetSummary(preview.parquet)}
              data-testid="import-parquet-summary"
            >
              {parquetSummary(preview.parquet)}
            </p>
          </div>
        )}
        {preview.format === 'xlsx' && preview.xlsx && (
          <>
            <Labelled id="import-sheet" label="Worksheet" className="col-span-2">
              <SelectField
                id="import-sheet"
                value={preview.xlsx.sheet}
                onChange={(event) =>
                  void wizard.setFileOptions({ xlsx: { sheet: event.target.value } })
                }
              >
                {(preview.sheets ?? [preview.xlsx.sheet]).map((sheet) => (
                  <option key={sheet} value={sheet}>
                    {sheet}
                  </option>
                ))}
              </SelectField>
            </Labelled>
            <Labelled id="import-header-row" label="Header row (0: none)">
              <TextField
                key={`${preview.xlsx.sheet}:${preview.xlsx.headerRow}`}
                id="import-header-row"
                type="number"
                min={0}
                defaultValue={preview.xlsx.headerRow}
                onBlur={(event) => {
                  const row = Math.max(0, Math.floor(Number(event.target.value) || 0));
                  if (row !== preview.xlsx?.headerRow) {
                    void wizard.setFileOptions({ xlsx: { headerRow: row } });
                  }
                }}
              />
            </Labelled>
          </>
        )}
        {preview.format !== 'xlsx' && preview.format !== 'parquet' && (
          <Labelled id="import-encoding" label="Encoding">
            <SelectField
              id="import-encoding"
              value={state.encoding ?? ''}
              onChange={(event) =>
                void wizard.setFileOptions({ encoding: event.target.value || undefined })
              }
            >
              <option value="">Detected: {preview.encoding}</option>
              {ENCODINGS.map((encoding) => (
                <option key={encoding} value={encoding}>
                  {encoding}
                </option>
              ))}
            </SelectField>
          </Labelled>
        )}
        {preview.format === 'xml' && xml && (
          <>
            <Labelled id="import-row-path" label="Rows are the elements at" className="col-span-2">
              <SelectField
                id="import-row-path"
                value={xml.rowPath}
                onChange={(event) =>
                  void wizard.setFileOptions({ xml: { rowPath: event.target.value } })
                }
              >
                {paths.map((candidate) => (
                  <option key={candidate.path} value={candidate.path}>
                    {candidate.path}
                    {candidate.count > 0 ? ` (${candidate.count})` : ''}
                  </option>
                ))}
              </SelectField>
            </Labelled>
            <Labelled id="import-row-path-custom" label="Or type a path">
              <TextField
                key={xml.rowPath}
                id="import-row-path-custom"
                mono
                placeholder="/root/row"
                defaultValue={xml.rowPath}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') event.currentTarget.blur();
                }}
                onBlur={(event) => {
                  const path = event.target.value.trim();
                  if (path !== '' && path !== xml.rowPath) {
                    void wizard.setFileOptions({ xml: { rowPath: path } });
                  }
                }}
              />
            </Labelled>
          </>
        )}
        {csvLike && csv && (
          <>
            <Labelled id="import-delimiter" label="Delimiter">
              <SelectField
                id="import-delimiter"
                value={delimiterKnown ? csv.delimiter : 'other'}
                onChange={(event) => {
                  if (event.target.value !== 'other') {
                    void wizard.setFileOptions({ csv: { delimiter: event.target.value } });
                  }
                }}
              >
                {DELIMITERS.map((d) => (
                  <option key={d.label} value={d.value}>
                    {d.label}
                  </option>
                ))}
                {!delimiterKnown && <option value="other">“{csv.delimiter}”</option>}
              </SelectField>
            </Labelled>
            <Labelled id="import-quote" label="Quote">
              <SelectField
                id="import-quote"
                value={csv.quote ?? 'none'}
                onChange={(event) =>
                  void wizard.setFileOptions({
                    csv: {
                      quote: event.target.value === 'none' ? null : event.target.value,
                      escape: event.target.value === 'none' ? null : event.target.value,
                    },
                  })
                }
              >
                <option value={'"'}>Double quote (")</option>
                <option value="'">Single quote (')</option>
                <option value="none">None</option>
              </SelectField>
            </Labelled>
            <Labelled id="import-null" label="NULL is written as">
              <TextField
                id="import-null"
                placeholder="(empty field)"
                defaultValue={csv.nullMarker ?? ''}
                onBlur={(event) =>
                  void wizard.setFileOptions({ csv: { nullMarker: event.target.value } })
                }
              />
            </Labelled>
          </>
        )}
      </div>
      {csvLike && csv && (
        <label className="flex items-center gap-1.5 text-xs">
          <input
            type="checkbox"
            checked={csv.header}
            onChange={(event) =>
              void wizard.setFileOptions({ csv: { header: event.target.checked } })
            }
          />
          First row holds the column names
        </label>
      )}
      <PreviewTable preview={preview} />
      <p className="text-[11px] text-muted">
        {preview.complete
          ? `${preview.rows.length} rows in the file`
          : `The first ${preview.rows.length} rows`}
      </p>
    </div>
  );
}

function MappingStep({ wizard, state }: StepProps) {
  const preview = state.preview!;
  const used = new Map<string, number>();
  for (const target of Object.values(state.mapping)) {
    if (target) used.set(target, (used.get(target) ?? 0) + 1);
  }
  const mapped = new Set(mappedPairs(state).map((pair) => pair.target));
  const missing = state.tableColumns.filter(
    (column) => !column.nullable && !column.defaulted && !mapped.has(column.name),
  );
  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs text-muted">
        File columns were matched to table columns by name. Unmapped table columns get their
        defaults.
      </p>
      <div className="max-h-96 overflow-auto rounded border border-border">
        <table className="w-full text-xs" data-testid="import-mapping">
          <thead className="sticky top-0 bg-panel text-left text-muted">
            <tr>
              <th className="px-2 py-1 font-medium">File column</th>
              <th className="px-2 py-1 font-medium">Sample</th>
              <th className="px-2 py-1 font-medium">Table column</th>
            </tr>
          </thead>
          <tbody>
            {preview.columns.map((column, c) => {
              const target = state.mapping[column.name] ?? '';
              const sample = preview.rows.find((row) => row[c] !== null)?.[c] ?? null;
              return (
                <tr key={column.name} className="border-t border-border/60">
                  <td className="px-2 py-1 font-mono">
                    {column.name}
                    <span className="ml-1 text-muted">{column.type}</span>
                  </td>
                  <td className="max-w-48 truncate px-2 py-1 font-mono text-muted">
                    {sample ?? 'NULL'}
                  </td>
                  <td className="px-2 py-1">
                    <SelectField
                      aria-label={`Table column for ${column.name}`}
                      value={target}
                      invalid={target !== '' && (used.get(target) ?? 0) > 1}
                      onChange={(event) => wizard.setMapping(column.name, event.target.value)}
                    >
                      <option value="">— skip —</option>
                      {state.tableColumns.map((tableColumn) => (
                        <option key={tableColumn.name} value={tableColumn.name}>
                          {tableColumn.name} ({tableColumn.dataType})
                        </option>
                      ))}
                    </SelectField>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {missing.length > 0 && (
        <p className="text-xs text-warning">
          {missing.map((column) => column.name).join(', ')} {missing.length === 1 ? 'is' : 'are'}{' '}
          NOT NULL without a default and not mapped; rows will fail unless the server fills{' '}
          {missing.length === 1 ? 'it' : 'them'}.
        </p>
      )}
    </div>
  );
}

function NewTableStep({ wizard, state }: StepProps) {
  const preview = state.preview!;
  const planned = new Map(state.plan?.columns.map((column) => [column.source, column]));
  return (
    <div className="flex flex-col gap-3">
      <Labelled id="import-table-name" label="Table name" className="w-80">
        <TextField
          id="import-table-name"
          value={state.newTableName}
          onChange={(event) => wizard.setNewTableName(event.target.value)}
        />
      </Labelled>
      <div className="max-h-72 overflow-auto rounded border border-border">
        <table className="w-full text-xs" data-testid="import-new-columns">
          <thead className="sticky top-0 bg-panel text-left text-muted">
            <tr>
              <th className="px-2 py-1 font-medium">Import</th>
              <th className="px-2 py-1 font-medium">File column</th>
              <th className="px-2 py-1 font-medium">Column name</th>
              <th className="px-2 py-1 font-medium">Type</th>
              <th className="px-2 py-1 font-medium">Nullable</th>
              <th className="px-2 py-1 font-medium">Primary key</th>
            </tr>
          </thead>
          <tbody>
            {state.newColumns.map((column) => {
              const plan = planned.get(column.source);
              const inferred = preview.columns.find((c) => c.name === column.source);
              return (
                <tr key={column.source} className="border-t border-border/60">
                  <td className="px-2 py-1">
                    <input
                      type="checkbox"
                      aria-label={`Import ${column.source}`}
                      checked={column.include}
                      onChange={(event) =>
                        wizard.setNewColumn(column.source, { include: event.target.checked })
                      }
                    />
                  </td>
                  <td className="px-2 py-1 font-mono">
                    {column.source}
                    <span className="ml-1 text-muted">{inferred?.type}</span>
                  </td>
                  <td className="px-2 py-1">
                    <TextField
                      aria-label={`Name of ${column.source}`}
                      disabled={!column.include}
                      placeholder={plan?.name ?? column.source}
                      value={column.name}
                      onChange={(event) =>
                        wizard.setNewColumn(column.source, { name: event.target.value })
                      }
                    />
                  </td>
                  <td className="px-2 py-1">
                    <TextField
                      mono
                      aria-label={`Type of ${column.source}`}
                      disabled={!column.include}
                      placeholder={plan?.dataType ?? ''}
                      value={column.dataType}
                      onChange={(event) =>
                        wizard.setNewColumn(column.source, { dataType: event.target.value })
                      }
                    />
                  </td>
                  <td className="px-2 py-1 text-center">
                    <input
                      type="checkbox"
                      aria-label={`${column.source} is nullable`}
                      disabled={!column.include || state.newPrimaryKey.includes(column.source)}
                      checked={column.nullable && !state.newPrimaryKey.includes(column.source)}
                      onChange={(event) =>
                        wizard.setNewColumn(column.source, { nullable: event.target.checked })
                      }
                    />
                  </td>
                  <td className="px-2 py-1 text-center">
                    <input
                      type="checkbox"
                      aria-label={`${column.source} is in the primary key`}
                      disabled={!column.include}
                      checked={state.newPrimaryKey.includes(column.source)}
                      onChange={() => wizard.togglePrimaryKey(column.source)}
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <Ddl statements={state.plan?.statements ?? []} />
    </div>
  );
}

function Ddl(props: { readonly statements: readonly string[] }) {
  if (props.statements.length === 0) return null;
  return (
    <pre
      className="max-h-48 overflow-auto rounded border border-border bg-panel-2 p-2 font-mono text-[11px] whitespace-pre-wrap"
      data-testid="import-ddl"
    >
      {props.statements.map((statement) => `${statement};`).join('\n\n')}
    </pre>
  );
}

function OptionsStep({ wizard, state }: StepProps) {
  const existing = state.target.table !== null;
  const keyed = state.mode === 'update' || state.mode === 'upsert' || state.mode === 'delete';
  const mappedTargets = mappedPairs(state).map((pair) => pair.target);
  return (
    <div className="flex flex-col gap-4 text-xs">
      {existing && (
        <fieldset className="flex flex-col gap-1">
          <legend className="mb-1 text-[11px] font-medium text-muted">Mode</legend>
          {MODES.map(({ mode, label, hint }) => (
            <label key={mode} className="flex items-center gap-2">
              <input
                type="radio"
                name="import-mode"
                checked={state.mode === mode}
                onChange={() => wizard.setOptions({ mode })}
              />
              <span className="w-32">{label}</span>
              <span className="text-muted">{hint}</span>
            </label>
          ))}
          {state.mode === 'replace' && (
            <p className="mt-1 text-warning">
              Replace empties {state.target.table} before importing: every row in it now is deleted.
            </p>
          )}
        </fieldset>
      )}
      {existing && keyed && (
        <fieldset className="flex flex-col gap-1">
          <legend className="mb-1 text-[11px] font-medium text-muted">
            Key columns (rows match on these)
          </legend>
          <div className="flex flex-wrap gap-3">
            {mappedTargets.map((name) => (
              <label key={name} className="flex items-center gap-1.5">
                <input
                  type="checkbox"
                  checked={state.keyColumns.includes(name)}
                  onChange={(event) =>
                    wizard.setOptions({
                      keyColumns: event.target.checked
                        ? [...state.keyColumns, name]
                        : state.keyColumns.filter((key) => key !== name),
                    })
                  }
                />
                <span className="font-mono">{name}</span>
              </label>
            ))}
          </div>
        </fieldset>
      )}
      <div className="grid grid-cols-3 gap-3">
        <Labelled id="import-batch" label="Rows per batch">
          <TextField
            id="import-batch"
            type="number"
            min={1}
            max={100000}
            value={state.batchSize}
            onChange={(event) =>
              wizard.setOptions({
                batchSize: Math.min(100_000, Math.max(1, Number(event.target.value) || 1)),
              })
            }
          />
        </Labelled>
        <Labelled id="import-transaction" label="Transaction">
          <SelectField
            id="import-transaction"
            value={state.transaction}
            onChange={(event) =>
              wizard.setOptions({ transaction: event.target.value as 'single' | 'per-batch' })
            }
          >
            <option value="single">One for the whole file</option>
            <option value="per-batch">One per batch</option>
          </SelectField>
        </Labelled>
        <Labelled id="import-errors" label="When a row fails">
          <SelectField
            id="import-errors"
            value={state.onError}
            onChange={(event) =>
              wizard.setOptions({ onError: event.target.value as 'stop' | 'skip' })
            }
          >
            <option value="stop">Stop and roll back</option>
            <option value="skip">Skip it and continue</option>
          </SelectField>
        </Labelled>
      </div>
      {existing && (
        <label className="flex items-center gap-1.5">
          <input
            type="checkbox"
            checked={state.disableForeignKeys}
            onChange={(event) => wizard.setOptions({ disableForeignKeys: event.target.checked })}
          />
          Turn off foreign key checks during the load
          {state.target.dialect === 'postgres' && (
            <span className="text-muted">(also skips triggers; needs a superuser)</span>
          )}
        </label>
      )}
      <SavedSettings
        kind="import"
        current={() => importSettingsOf(wizard.state)}
        onLoad={(settings) => void wizard.applySettings(settings)}
      />
    </div>
  );
}

/** The file format line of the review: dialect, worksheet or row path as the preview read it. */
function formatSummary(state: ImportWizardState): string {
  const preview = state.preview;
  if (!preview) return '';
  const name = FORMAT_NAMES[preview.format] ?? preview.format.toUpperCase();
  if (preview.xlsx) {
    return `${name} · worksheet "${preview.xlsx.sheet}" · ${
      preview.xlsx.headerRow > 0 ? `header in row ${preview.xlsx.headerRow}` : 'no header row'
    }`;
  }
  if (preview.xml) return `${name} · ${preview.encoding} · rows at ${preview.xml.rowPath}`;
  if (preview.parquet) {
    return `${name} · ${count(preview.parquet.rows, 'row')} in ${count(preview.parquet.rowGroups, 'row group')}`;
  }
  return `${name} · ${preview.encoding}${
    preview.csv
      ? ` · delimiter ${preview.csv.delimiter === '\t' ? 'tab' : `"${preview.csv.delimiter}"`}${preview.csv.header ? ' · header' : ''}`
      : ''
  }`;
}

function ReviewStep({ state }: { readonly state: ImportWizardState }) {
  const { target } = state;
  const pairs = mappedPairs(state);
  const table = target.table ?? state.newTableName.trim();
  const rows: [string, string][] = [
    ['File', state.path ?? ''],
    ['Format', formatSummary(state)],
    ['Into', `${target.table === null ? 'new table ' : ''}${target.schema}.${table}`],
    ['Columns', pairs.map((pair) => `${pair.source} → ${pair.target}`).join(', ')],
    [
      'Mode',
      `${target.table === null ? 'append' : state.mode}${
        state.keyColumns.length > 0 && state.mode !== 'append' && state.mode !== 'replace'
          ? ` on ${state.keyColumns.join(', ')}`
          : ''
      }`,
    ],
    [
      'Options',
      `${state.batchSize.toLocaleString('en-US')} rows per batch · ${
        state.transaction === 'single' ? 'one transaction' : 'a transaction per batch'
      } · ${state.onError === 'stop' ? 'stop at the first failed row' : 'skip failed rows'}${
        state.disableForeignKeys ? ' · foreign key checks off' : ''
      }`,
    ],
  ];
  return (
    <div className="flex flex-col gap-3 text-xs" data-testid="import-review">
      <dl className="grid grid-cols-[7rem_1fr] gap-x-3 gap-y-1">
        {rows.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-muted">{label}</dt>
            <dd className="break-all">{value}</dd>
          </div>
        ))}
      </dl>
      {target.table === null && <Ddl statements={state.plan?.statements ?? []} />}
      {target.table !== null && state.mode === 'replace' && (
        <p className="font-medium text-danger">
          Replace deletes every row of {table} before importing.
        </p>
      )}
      {target.production && (
        <p className="font-medium text-danger">This is a production connection.</p>
      )}
      <p className="text-muted">
        The import runs as a job: follow it, or cancel it (which rolls back), in the Jobs panel.
      </p>
    </div>
  );
}
