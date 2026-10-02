import { isSqlEngine } from '@joinery/core';
import type { BackupFileFormat, BackupMethod } from '@joinery/ipc';
import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';

import { errorMessage } from '../../lib/errors';
import { mainApi } from '../../lib/main-client';
import {
  mongoCollections,
  serverSnapshot,
  startBackupJob,
  wizardSecrets,
} from '../../state/backup/dialogs';
import {
  FORMAT_LABELS,
  MIN_PASSPHRASE_LENGTH,
  backupJobSpec,
  backupProblem,
  catalogItems,
  changeOptions,
  defaultBackupOptions,
  defaultFileName,
  formatFilter,
  formatsFor,
  mongoCatalog,
  nativeDumpTool,
  sqlCatalog,
  sqlSelection,
  type BackupOptions,
  type BackupTarget,
  type CatalogGroup,
} from '../../state/backup/options';
import { loadSnapshot } from '../../state/metadata';
import { backupDraft, editSchedule } from '../../state/schedules';
import { SelectField, TextField } from '../designer/fields';
import { StepBar } from '../jobs/shared';
import { Button, Modal } from '../ui';
import { BackupHistory, Check, Choice, JobProgress } from './shared';

/**
 * The backup wizard (spec §14): pick the objects (SQL objects by schema and kind, MongoDB
 * collections; a key pattern for Redis), then the method, format, compression, encryption and
 * the file, and follow the job's progress. The backup runs in the job runner, so it shares the
 * job list, the history and the notifications; the passphrase goes with the job and is not
 * kept anywhere.
 */

type Step = 'objects' | 'options' | 'progress';

const STEP_LABELS: Readonly<Record<Step, string>> = {
  objects: 'Objects',
  options: 'Options',
  progress: 'Progress',
};

export const NATIVE_TOOLS_KEY = ['backup-native-tools'] as const;

export function BackupDialog(props: {
  readonly target: BackupTarget;
  readonly onClose: () => void;
}) {
  const { target } = props;
  const sql = isSqlEngine(target.engine);
  const steps: readonly Step[] =
    target.engine === 'redis' ? ['options', 'progress'] : ['objects', 'options', 'progress'];
  const [step, setStep] = useState<Step>(steps[0]!);
  const [options, setOptions] = useState<BackupOptions>(() => defaultBackupOptions(target));
  // Everything starts checked: the wizard keeps what the user unchecked.
  const [unchecked, setUnchecked] = useState<ReadonlySet<string>>(new Set());
  const [withoutRows, setWithoutRows] = useState<ReadonlySet<string>>(new Set());
  const [jobId, setJobId] = useState<string>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const tools = useQuery({
    queryKey: NATIVE_TOOLS_KEY,
    queryFn: () => mainApi().backup.nativeTools(),
    enabled: sql,
    staleTime: 60_000,
  });
  const dumpTool = nativeDumpTool(target.engine, tools.data ?? []);

  const catalog = useQuery({
    queryKey: ['backup-catalog', target.profileId, target.database ?? '', target.schema ?? ''],
    queryFn: async (): Promise<CatalogGroup[]> => {
      const engine = target.engine;
      if (isSqlEngine(engine)) {
        const snapshot = await loadSnapshot(target.profileId, {
          dialect: engine,
          ...(target.database !== undefined ? { database: target.database } : {}),
          ...(target.schema !== undefined ? { schemas: [target.schema] } : {}),
        });
        return sqlCatalog(snapshot);
      }
      if (target.engine === 'mongodb' && target.database !== undefined) {
        return mongoCatalog(await mongoCollections(target.profileId, target.database));
      }
      return [];
    },
    enabled: target.engine !== 'redis',
    staleTime: 0,
    gcTime: 0,
  });
  const groups = useMemo(() => catalog.data ?? [], [catalog.data]);
  const items = useMemo(() => catalogItems(groups), [groups]);
  const checked = useMemo(
    () => new Set(items.filter((i) => !unchecked.has(i.key)).map((i) => i.key)),
    [items, unchecked],
  );
  const setChecked = (next: ReadonlySet<string>): void => {
    setUnchecked(new Set(items.filter((i) => !next.has(i.key)).map((i) => i.key)));
  };

  const update = (patch: Partial<BackupOptions>): void => {
    setOptions((current) => changeOptions(target.engine, current, patch));
  };

  const selectionEmpty = target.engine !== 'redis' && items.length > 0 && checked.size === 0;
  const problem = backupProblem(target, options, { empty: selectionEmpty });

  const chooseFile = async (): Promise<void> => {
    setError(undefined);
    try {
      const { path } = await mainApi().dialogs.saveFile({
        title: 'Save backup',
        defaultName: defaultFileName(target, options.format),
        filters: [formatFilter(options.format)],
      });
      if (path !== null) setOptions((current) => ({ ...current, path }));
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const buildJob = (withOptions: BackupOptions) => {
    const allChecked = checked.size === items.length;
    return backupJobSpec(target, withOptions, {
      ...(sql
        ? {
            selection: sqlSelection(
              groups,
              checked,
              withoutRows,
              target.schema !== undefined ? [target.schema] : undefined,
            ),
          }
        : {}),
      ...(target.engine === 'mongodb' && !allChecked
        ? { collections: items.filter((i) => checked.has(i.key)).map((i) => i.ref.name) }
        : {}),
    });
  };

  // A schedule writes a new file each run, named in the schedule editor: no file is chosen here.
  const scheduleOptions: BackupOptions = { ...options, path: options.path ?? 'scheduled' };
  const scheduleProblem = backupProblem(target, scheduleOptions, { empty: selectionEmpty });
  const schedule = (): void => {
    if (scheduleProblem !== undefined) return;
    const job = buildJob(scheduleOptions);
    editSchedule(
      backupDraft(
        job,
        { profileName: target.profileName, database: target.database },
        job.encryption?.passphrase,
      ),
    );
    props.onClose();
  };

  const start = async (): Promise<void> => {
    if (problem !== undefined) return;
    setBusy(true);
    setError(undefined);
    try {
      const secrets = await wizardSecrets(target);
      if (secrets === null) return;
      const job = buildJob(options);
      const id = await startBackupJob(target, job, secrets);
      // The passphrase went with the job; the page forgets it.
      setOptions((current) => ({ ...current, passphrase: '', passphraseAgain: '' }));
      setJobId(id);
      setStep('progress');
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const at = steps.indexOf(step);
  const where = [
    target.profileName,
    target.engine === 'redis' && target.database !== undefined
      ? `db${target.database}`
      : target.database,
    target.schema,
  ]
    .filter((part) => part !== undefined)
    .join(' · ');

  return (
    <Modal
      open
      onOpenChange={(open) => !open && props.onClose()}
      title="Back up"
      description={where}
      width="w-[720px]"
      footer={
        <>
          <span
            className="mr-auto self-center text-xs text-danger"
            role={error ? 'alert' : undefined}
          >
            {error ?? ''}
          </span>
          {step === 'progress' ? (
            <Button variant="primary" onClick={props.onClose}>
              Close
            </Button>
          ) : (
            <>
              <Button variant="ghost" onClick={props.onClose}>
                Cancel
              </Button>
              {at > 0 && <Button onClick={() => setStep(steps[at - 1]!)}>Back</Button>}
              {step === 'objects' ? (
                <Button
                  variant="primary"
                  onClick={() => setStep('options')}
                  disabled={catalog.isLoading || selectionEmpty}
                >
                  Next
                </Button>
              ) : (
                <>
                  <Button
                    onClick={schedule}
                    disabled={scheduleProblem !== undefined || busy}
                    title={scheduleProblem ?? 'Run this backup on a schedule instead'}
                  >
                    Schedule…
                  </Button>
                  <Button
                    variant="primary"
                    onClick={() => void start()}
                    disabled={problem !== undefined || busy}
                    title={problem}
                  >
                    Back up
                  </Button>
                </>
              )}
            </>
          )}
        </>
      }
    >
      <div data-testid="backup-dialog">
        <StepBar steps={steps} labels={STEP_LABELS} current={step} />
        {step === 'objects' && (
          <ObjectsStep
            groups={groups}
            loading={catalog.isLoading}
            error={catalog.error ? errorMessage(catalog.error) : undefined}
            checked={checked}
            onChecked={setChecked}
            withoutRows={withoutRows}
            onWithoutRows={setWithoutRows}
            rowsLabel={target.engine === 'mongodb' ? 'documents' : 'rows'}
          />
        )}
        {step === 'options' && (
          <OptionsStep
            target={target}
            options={options}
            update={update}
            dumpTool={dumpTool ? `${dumpTool.name} ${dumpTool.version}` : undefined}
            onChooseFile={() => void chooseFile()}
            problem={problem}
          />
        )}
        {step === 'progress' && jobId && <JobProgress jobId={jobId} />}
        <div className="mt-4 border-t border-border pt-3">
          <BackupHistory profileId={target.profileId} kind="backup" />
        </div>
      </div>
    </Modal>
  );
}

function ObjectsStep(props: {
  readonly groups: readonly CatalogGroup[];
  readonly loading: boolean;
  readonly error: string | undefined;
  readonly checked: ReadonlySet<string>;
  readonly onChecked: (checked: ReadonlySet<string>) => void;
  readonly withoutRows: ReadonlySet<string>;
  readonly onWithoutRows: (keys: ReadonlySet<string>) => void;
  readonly rowsLabel: string;
}) {
  const { groups, checked, withoutRows } = props;
  const [filter, setFilter] = useState('');
  if (props.loading) return <p className="text-xs text-muted">Reading the objects…</p>;
  if (props.error) {
    return (
      <p role="alert" className="text-xs text-danger">
        {props.error}
      </p>
    );
  }
  const all = groups.flatMap((g) => g.items);
  if (all.length === 0) {
    return (
      <p className="text-xs text-muted">
        Nothing to pick here: the backup takes whatever the database holds.
      </p>
    );
  }
  const needle = filter.trim().toLowerCase();
  const shown = groups
    .map((g) => ({
      ...g,
      items:
        needle === '' ? g.items : g.items.filter((i) => i.label.toLowerCase().includes(needle)),
    }))
    .filter((g) => g.items.length > 0);
  const toggle = (keys: readonly string[], on: boolean): void => {
    const next = new Set(checked);
    for (const key of keys) {
      if (on) next.add(key);
      else next.delete(key);
    }
    props.onChecked(next);
  };
  const toggleRows = (key: string, rows: boolean): void => {
    const next = new Set(withoutRows);
    if (rows) next.delete(key);
    else next.add(key);
    props.onWithoutRows(next);
  };
  const schemas = [...new Set(shown.map((g) => g.schema))];
  return (
    <div className="flex flex-col gap-2 text-xs">
      <div className="flex items-center gap-2">
        <Check
          checked={checked.size === all.length}
          indeterminate={checked.size > 0 && checked.size < all.length}
          onChange={(on) =>
            toggle(
              all.map((i) => i.key),
              on,
            )
          }
        >
          <span className="font-medium">Everything ({all.length})</span>
        </Check>
        <div className="ml-auto w-56">
          <TextField
            aria-label="Filter objects"
            placeholder="Filter"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
          />
        </div>
      </div>
      <div
        className="max-h-80 overflow-auto rounded border border-border p-1.5"
        role="group"
        aria-label="Objects to back up"
      >
        {schemas.map((schema) => (
          <div key={schema ?? ''} className="mb-1.5">
            {schema !== undefined && <p className="font-semibold">{schema}</p>}
            {shown
              .filter((g) => g.schema === schema)
              .map((g) => {
                const keys = g.items.map((i) => i.key);
                const on = keys.filter((k) => checked.has(k)).length;
                return (
                  <div key={g.key} className="ml-2">
                    <Check
                      checked={on === keys.length}
                      indeterminate={on > 0 && on < keys.length}
                      onChange={(value) => toggle(keys, value)}
                    >
                      <span className="text-muted">
                        {g.label} ({g.items.length})
                      </span>
                    </Check>
                    <ul className="ml-5">
                      {g.items.map((i) => (
                        <li key={i.key} className="flex items-center gap-3">
                          <Check
                            checked={checked.has(i.key)}
                            onChange={(value) => toggle([i.key], value)}
                          >
                            <span className="font-mono" data-testid="backup-object">
                              {i.label}
                            </span>
                          </Check>
                          {i.hasRows && checked.has(i.key) && (
                            <Check
                              checked={!withoutRows.has(i.key)}
                              onChange={(value) => toggleRows(i.key, value)}
                            >
                              <span className="text-muted">{props.rowsLabel}</span>
                            </Check>
                          )}
                        </li>
                      ))}
                    </ul>
                  </div>
                );
              })}
          </div>
        ))}
      </div>
      <p className="text-muted">
        {checked.size} of {all.length} selected. What the chosen objects need (the tables of a view,
        a column&apos;s type, a trigger&apos;s function) comes along; indexes, keys, triggers and
        privileges come with their table.
      </p>
    </div>
  );
}

function OptionsStep(props: {
  readonly target: BackupTarget;
  readonly options: BackupOptions;
  readonly update: (patch: Partial<BackupOptions>) => void;
  readonly dumpTool: string | undefined;
  readonly onChooseFile: () => void;
  readonly problem: string | undefined;
}) {
  const { target, options, update } = props;
  const sql = isSqlEngine(target.engine);
  const native = sql && options.method === 'native';
  const archive = options.format === 'jbak' && !native;
  return (
    <div className="flex flex-col gap-3 text-xs">
      {sql && (
        <Choice<BackupMethod>
          name="backup-method"
          legend="Method"
          value={options.method}
          onChange={(method) => update({ method })}
          options={[
            { value: 'joinery', label: 'Joinery (built in, no tools needed)' },
            {
              value: 'native',
              label: props.dumpTool
                ? `Native tool (${props.dumpTool})`
                : 'Native tool (pg_dump or mysqldump not found)',
              disabled: props.dumpTool === undefined,
            },
          ]}
        />
      )}
      <div className="grid grid-cols-2 gap-3">
        <label className="flex flex-col gap-1">
          <span className="text-[11px] font-medium text-muted">Format</span>
          <SelectField
            aria-label="Format"
            value={options.format}
            onChange={(event) => update({ format: event.target.value as BackupFileFormat })}
          >
            {formatsFor(target.engine, options.method).map((format) => (
              <option key={format} value={format}>
                {FORMAT_LABELS[format]}
              </option>
            ))}
          </SelectField>
        </label>
        {target.engine === 'mongodb' && (
          <label className="flex flex-col gap-1">
            <span className="text-[11px] font-medium text-muted">Documents as</span>
            <SelectField
              aria-label="Documents as"
              value={options.documentFormat}
              onChange={(event) =>
                update({ documentFormat: event.target.value as 'bson' | 'ejson' })
              }
            >
              <option value="bson">BSON</option>
              <option value="ejson">Extended JSON (canonical)</option>
            </SelectField>
          </label>
        )}
        {target.engine === 'redis' && (
          <label className="flex flex-col gap-1">
            <span className="text-[11px] font-medium text-muted">Keys matching</span>
            <TextField
              aria-label="Keys matching"
              mono
              value={options.pattern}
              onChange={(event) => update({ pattern: event.target.value })}
            />
          </label>
        )}
      </div>
      {archive && (
        <Check checked={options.compress} onChange={(compress) => update({ compress })}>
          Compress each object (gzip)
        </Check>
      )}
      {sql && (
        <fieldset className="grid grid-cols-2 gap-1">
          <legend className="mb-1 text-[11px] font-medium text-muted">Include</legend>
          <Check checked={options.structure} onChange={(structure) => update({ structure })}>
            Structure (DDL)
          </Check>
          <Check checked={options.data} onChange={(data) => update({ data })}>
            Data
          </Check>
          <Check checked={options.grants} onChange={(grants) => update({ grants })}>
            Privileges (GRANT)
          </Check>
          <Check checked={options.ownership} onChange={(ownership) => update({ ownership })}>
            Owners and definers
          </Check>
          {!native && (
            <Check
              checked={options.consistent}
              onChange={(consistent) => update({ consistent })}
              hint="Reads every table in one snapshot transaction"
            >
              Consistent snapshot
            </Check>
          )}
          {target.engine === 'postgres' && (
            <Check
              checked={options.deferrable}
              onChange={(deferrable) => update({ deferrable })}
              hint="Waits for a snapshot free of serialization anomalies before reading"
            >
              Deferrable snapshot
            </Check>
          )}
        </fieldset>
      )}
      {archive && (
        <div className="flex flex-col gap-1.5">
          <Check checked={options.encrypt} onChange={(encrypt) => update({ encrypt })}>
            Encrypt with a passphrase (AES-256-GCM)
          </Check>
          {options.encrypt && (
            <div className="grid grid-cols-2 gap-3">
              <TextField
                type="password"
                autoComplete="new-password"
                aria-label="Passphrase"
                placeholder={`Passphrase (${MIN_PASSPHRASE_LENGTH}+ characters)`}
                value={options.passphrase}
                onChange={(event) => update({ passphrase: event.target.value })}
              />
              <TextField
                type="password"
                autoComplete="new-password"
                aria-label="Passphrase again"
                placeholder="Passphrase again"
                value={options.passphraseAgain}
                onChange={(event) => update({ passphraseAgain: event.target.value })}
              />
              <p className="col-span-2 text-muted">
                Joinery does not keep the passphrase: without it the backup cannot be restored.
              </p>
            </div>
          )}
        </div>
      )}
      {target.engine === 'redis' && <ServerSnapshot target={target} />}
      <div className="flex flex-col items-start gap-1">
        <Button onClick={props.onChooseFile}>Choose file…</Button>
        {options.path && (
          <p className="font-mono break-all" data-testid="backup-path">
            {options.path}
          </p>
        )}
      </div>
      {props.problem && <p className="text-muted">{props.problem}</p>}
    </div>
  );
}

/** BGSAVE: the server writes its own RDB snapshot, after a confirmation. */
function ServerSnapshot(props: { readonly target: BackupTarget }) {
  const [reply, setReply] = useState<string>();
  const [error, setError] = useState<string>();
  const run = async (): Promise<void> => {
    setError(undefined);
    try {
      const text = await serverSnapshot(props.target);
      if (text !== undefined) setReply(text);
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  return (
    <div className="flex flex-col items-start gap-1 rounded border border-border p-2">
      <p className="text-muted">
        Or have the server save its whole dataset to its own RDB file (BGSAVE), on the server rather
        than here.
      </p>
      <Button
        size="sm"
        onClick={() => void run()}
        disabled={props.target.readOnly}
        title={props.target.readOnly ? 'This connection is read-only' : undefined}
      >
        Server snapshot (BGSAVE)…
      </Button>
      {reply && <p data-testid="bgsave-reply">{reply}</p>}
      {error && (
        <p role="alert" className="text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
