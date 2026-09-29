import { ENGINES, isSqlEngine } from '@joinery/core';
import type { BackupInspection, BackupMethod, RestorePlan } from '@joinery/ipc';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';

import { errorMessage } from '../../lib/errors';
import { formatCount } from '../../lib/format';
import { mainApi } from '../../lib/main-client';
import { planRestore, startBackupJob, wizardSecrets } from '../../state/backup/dialogs';
import {
  FORMAT_LABELS,
  conflictLabel,
  defaultRestoreChoices,
  engineFit,
  nativeRestoreTool,
  restoreCatalog,
  restoreJobSpec,
  restoreProblem,
  type BackupTarget,
  type RestoreChoices,
} from '../../state/backup/options';
import { confirm } from '../../state/dialogs';
import { TextField } from '../designer/fields';
import { StepBar, formatBytes } from '../jobs/shared';
import { Button, Modal } from '../ui';
import { NATIVE_TOOLS_KEY } from './BackupDialog';
import { BackupHistory, Check, Choice, JobProgress } from './shared';

/**
 * The restore wizard (spec §14): pick a backup file (and unlock it when it is encrypted), pick
 * what to restore from an archive, pick the target (the connection's database, a new one, or
 * any other name), review the plan, then follow the job. Restores follow the connection's
 * rules: a read-only connection refuses, a production one asks first, and restoring over
 * existing objects is always confirmed after listing what will be dropped or overwritten. Main
 * and the job runner check all of it again.
 */

type Step = 'file' | 'objects' | 'target' | 'review' | 'progress';

const STEP_LABELS: Readonly<Record<Step, string>> = {
  file: 'File',
  objects: 'Objects',
  target: 'Target',
  review: 'Review',
  progress: 'Progress',
};

export function RestoreDialog(props: {
  readonly target: BackupTarget;
  readonly onClose: () => void;
}) {
  const { target } = props;
  const sql = isSqlEngine(target.engine);
  const [step, setStep] = useState<Step>('file');
  const [path, setPath] = useState<string>();
  const [inspection, setInspection] = useState<BackupInspection>();
  const [passphrase, setPassphrase] = useState('');
  const [choices, setChoices] = useState<RestoreChoices>(() => defaultRestoreChoices(target));
  const [secrets, setSecrets] = useState<Record<string, string>>();
  const [plan, setPlan] = useState<RestorePlan>();
  const [acknowledged, setAcknowledged] = useState(false);
  const [jobId, setJobId] = useState<string>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const tools = useQuery({
    queryKey: NATIVE_TOOLS_KEY,
    queryFn: () => mainApi().backup.nativeTools(),
    enabled: sql,
    staleTime: 60_000,
  });

  const archive = inspection?.format === 'jbak';
  const steps: readonly Step[] =
    archive && (inspection.objects?.length ?? 0) > 1
      ? ['file', 'objects', 'target', 'review', 'progress']
      : ['file', 'target', 'review', 'progress'];
  const at = steps.indexOf(step);
  const problem = restoreProblem(target, inspection, choices);
  const restoreTool = inspection
    ? nativeRestoreTool(target.engine, inspection.format, tools.data ?? [])
    : undefined;

  const change = (patch: Partial<RestoreChoices>): void => {
    setChoices((current) => ({ ...current, ...patch }));
    setPlan(undefined);
    setAcknowledged(false);
  };

  const inspect = async (file: string, key?: string): Promise<void> => {
    setBusy(true);
    setError(undefined);
    try {
      const info = await mainApi().backup.inspect({
        path: file,
        ...(key !== undefined ? { passphrase: key } : {}),
      });
      setInspection(info);
      setChoices({
        ...defaultRestoreChoices(target, info),
        ...(key !== undefined ? { passphrase: key } : {}),
      });
      setPlan(undefined);
      setAcknowledged(false);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const chooseFile = async (): Promise<void> => {
    setError(undefined);
    const picked = (
      await mainApi().dialogs.openFile({
        title: 'Restore a backup',
        filters: [
          { name: 'Backups', extensions: ['jbak', 'sql', 'gz', 'dump', 'backup'] },
          { name: 'All files', extensions: ['*'] },
        ],
      })
    ).path;
    if (picked === null) return;
    setPath(picked);
    setInspection(undefined);
    setPassphrase('');
    await inspect(picked);
  };

  const review = async (): Promise<void> => {
    if (!path || !inspection || problem !== undefined) return;
    setBusy(true);
    setError(undefined);
    setPlan(undefined);
    setAcknowledged(false);
    try {
      let known = secrets;
      if (known === undefined) {
        const typed = await wizardSecrets(target);
        if (typed === null) return;
        known = typed ?? {};
        setSecrets(known);
      }
      const job = restoreJobSpec(target, path, inspection, choices);
      setPlan(await planRestore(job, Object.keys(known).length > 0 ? known : undefined));
      setStep('review');
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const start = async (): Promise<void> => {
    if (!path || !inspection || !plan) return;
    if (plan.conflicts.length > 0 && !acknowledged) return;
    let confirmed = false;
    if (target.confirmWrites) {
      const ok = await confirm({
        title: target.production ? 'Restore into a production connection?' : 'Restore now?',
        message: `The restore writes to "${target.profileName}"${
          choices.database.trim() !== '' ? ` (${choices.database.trim()})` : ''
        }.`,
        confirmLabel: 'Restore',
        danger: true,
      });
      if (!ok) return;
      confirmed = true;
    }
    setBusy(true);
    setError(undefined);
    try {
      const job = restoreJobSpec(target, path, inspection, choices, {
        conflicts: plan.conflicts,
        confirmed,
      });
      const id = await startBackupJob(
        target,
        job,
        secrets && Object.keys(secrets).length > 0 ? secrets : undefined,
      );
      setPassphrase('');
      setChoices((current) => ({ ...current, passphrase: undefined }));
      setJobId(id);
      setStep('progress');
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const next = (): void => {
    if (step === 'target') {
      void review();
      return;
    }
    const following = steps[at + 1];
    if (following) setStep(following);
  };

  const nextDisabled =
    busy ||
    (step === 'file' && (!inspection || (archive && !inspection.objects))) ||
    (step === 'target' && problem !== undefined) ||
    (step === 'objects' && choices.select !== undefined && choices.select.length === 0);

  return (
    <Modal
      open
      onOpenChange={(open) => !open && props.onClose()}
      title="Restore"
      description={`${target.profileName}${target.database !== undefined ? ` · ${target.database}` : ''}`}
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
              {at > 0 && (
                <Button onClick={() => setStep(steps[at - 1]!)} disabled={busy}>
                  Back
                </Button>
              )}
              {step === 'review' ? (
                <Button
                  variant="danger"
                  onClick={() => void start()}
                  disabled={busy || !plan || (plan.conflicts.length > 0 && !acknowledged)}
                >
                  Restore
                </Button>
              ) : (
                <Button
                  variant="primary"
                  onClick={next}
                  disabled={nextDisabled}
                  title={step === 'target' ? problem : undefined}
                >
                  {step === 'target' ? 'Review' : 'Next'}
                </Button>
              )}
            </>
          )}
        </>
      }
    >
      <div data-testid="restore-dialog" className="flex flex-col gap-3 text-xs">
        <StepBar steps={steps} labels={STEP_LABELS} current={step} />
        {target.readOnly && (
          <p role="alert" className="text-danger">
            &quot;{target.profileName}&quot; is read-only, so nothing can be restored into it.
          </p>
        )}
        {step === 'file' && (
          <FileStep
            target={target}
            path={path}
            inspection={inspection}
            passphrase={passphrase}
            onPassphrase={setPassphrase}
            busy={busy}
            onChoose={() => void chooseFile()}
            onUnlock={() => path && void inspect(path, passphrase)}
          />
        )}
        {step === 'objects' && inspection?.objects && (
          <ObjectsStep inspection={inspection} choices={choices} change={change} />
        )}
        {step === 'target' && inspection && (
          <TargetStep
            target={target}
            inspection={inspection}
            choices={choices}
            change={change}
            restoreTool={restoreTool ? `${restoreTool.name} ${restoreTool.version}` : undefined}
            problem={problem}
          />
        )}
        {step === 'review' && plan && (
          <ReviewStep
            plan={plan}
            acknowledged={acknowledged}
            onAcknowledged={setAcknowledged}
            target={target}
          />
        )}
        {step === 'progress' && jobId && <JobProgress jobId={jobId} />}
        <div className="border-t border-border pt-3">
          <BackupHistory profileId={target.profileId} kind="restore" />
        </div>
      </div>
    </Modal>
  );
}

function FileStep(props: {
  readonly target: BackupTarget;
  readonly path: string | undefined;
  readonly inspection: BackupInspection | undefined;
  readonly passphrase: string;
  readonly onPassphrase: (value: string) => void;
  readonly busy: boolean;
  readonly onChoose: () => void;
  readonly onUnlock: () => void;
}) {
  const { inspection } = props;
  const locked = inspection?.format === 'jbak' && !inspection.objects;
  const fit = inspection ? engineFit(props.target.engine, inspection.engine) : undefined;
  return (
    <div className="flex flex-col items-start gap-2">
      <p className="text-muted">
        Joinery archives (.jbak), SQL scripts (.sql, .sql.gz) and pg_dump archives restore here.
      </p>
      <Button onClick={props.onChoose} disabled={props.busy}>
        Choose backup file…
      </Button>
      {props.path && <p className="font-mono break-all">{props.path}</p>}
      {locked && (
        <form
          className="flex w-full items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            props.onUnlock();
          }}
        >
          <div className="w-72">
            <TextField
              type="password"
              autoComplete="off"
              aria-label="Backup passphrase"
              placeholder="Passphrase"
              value={props.passphrase}
              onChange={(event) => props.onPassphrase(event.target.value)}
            />
          </div>
          <Button type="submit" size="sm" disabled={props.passphrase === '' || props.busy}>
            Unlock
          </Button>
          <span className="text-muted">The archive is encrypted.</span>
        </form>
      )}
      {inspection && (
        <dl
          className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-0.5"
          data-testid="backup-inspection"
        >
          <dt className="text-muted">Format</dt>
          <dd>
            {FORMAT_LABELS[inspection.format]}
            {inspection.encrypted ? ', encrypted' : ''}
          </dd>
          <dt className="text-muted">Size</dt>
          <dd>{formatBytes(inspection.size)}</dd>
          {inspection.engine && (
            <>
              <dt className="text-muted">From</dt>
              <dd>
                {ENGINES[inspection.engine].displayName} {inspection.serverVersion ?? ''}
                {inspection.database !== undefined ? ` · ${inspection.database}` : ''}
              </dd>
            </>
          )}
          {inspection.createdAt && (
            <>
              <dt className="text-muted">Created</dt>
              <dd>{new Date(inspection.createdAt).toLocaleString()}</dd>
            </>
          )}
          {inspection.objects && (
            <>
              <dt className="text-muted">Objects</dt>
              <dd>{formatCount(inspection.objects.length)}</dd>
            </>
          )}
        </dl>
      )}
      {fit?.note && <p className={fit.ok ? 'text-warning' : 'text-danger'}>{fit.note}</p>}
      {inspection?.warnings?.map((warning, i) => (
        <p key={i} className="text-warning">
          {warning}
        </p>
      ))}
    </div>
  );
}

function ObjectsStep(props: {
  readonly inspection: BackupInspection;
  readonly choices: RestoreChoices;
  readonly change: (patch: Partial<RestoreChoices>) => void;
}) {
  const { inspection, choices, change } = props;
  const groups = restoreCatalog(inspection.objects ?? []);
  const all = groups.flatMap((g) => g.objects.map((o) => o.id));
  const selected = new Set(choices.select ?? all);
  const set = (ids: readonly string[], on: boolean): void => {
    const next = new Set(selected);
    for (const id of ids) {
      if (on) next.add(id);
      else next.delete(id);
    }
    change({ select: next.size === all.length ? undefined : all.filter((id) => next.has(id)) });
  };
  const sqlArchive = inspection.engine !== undefined && isSqlEngine(inspection.engine);
  return (
    <div className="flex flex-col gap-2">
      <Check
        checked={selected.size === all.length}
        indeterminate={selected.size > 0 && selected.size < all.length}
        onChange={(on) => set(all, on)}
      >
        <span className="font-medium">Everything ({all.length})</span>
      </Check>
      <div
        className="max-h-72 overflow-auto rounded border border-border p-1.5"
        role="group"
        aria-label="Objects to restore"
      >
        {groups.map((g) => {
          const ids = g.objects.map((o) => o.id);
          const on = ids.filter((id) => selected.has(id)).length;
          return (
            <div key={g.kind} className="mb-1.5">
              <Check
                checked={on === ids.length}
                indeterminate={on > 0 && on < ids.length}
                onChange={(value) => set(ids, value)}
              >
                <span className="font-semibold">
                  {g.label} ({ids.length})
                </span>
              </Check>
              <ul className="ml-5">
                {g.objects.map((o) => (
                  <li key={o.id}>
                    <Check checked={selected.has(o.id)} onChange={(value) => set([o.id], value)}>
                      <span className="font-mono" data-testid="restore-object">
                        {o.qualifiedName}
                      </span>
                      {o.rows !== undefined && (
                        <span className="text-muted">{formatCount(o.rows)}</span>
                      )}
                    </Check>
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </div>
      <p className="text-muted">
        {selected.size} of {all.length} selected. What they need comes along (the review lists it);
        a foreign key comes only when both of its tables do.
      </p>
      {sqlArchive && (
        <div className="flex gap-4">
          <Check checked={choices.structure} onChange={(structure) => change({ structure })}>
            Structure
          </Check>
          <Check checked={choices.data} onChange={(data) => change({ data })}>
            Data
          </Check>
        </div>
      )}
    </div>
  );
}

function TargetStep(props: {
  readonly target: BackupTarget;
  readonly inspection: BackupInspection;
  readonly choices: RestoreChoices;
  readonly change: (patch: Partial<RestoreChoices>) => void;
  readonly restoreTool: string | undefined;
  readonly problem: string | undefined;
}) {
  const { target, inspection, choices, change } = props;
  const sql = isSqlEngine(target.engine);
  const script = inspection.format !== 'jbak';
  return (
    <div className="flex flex-col gap-3">
      {sql && (
        <Choice<'existing' | 'new'>
          name="restore-into"
          legend="Restore into"
          value={choices.createDatabase ? 'new' : 'existing'}
          onChange={(value) =>
            change({
              createDatabase: value === 'new',
              database:
                value === 'new'
                  ? `${inspection.database ?? 'restored'}_restored`
                  : (target.database ?? ''),
            })
          }
          options={[
            { value: 'existing', label: 'An existing database' },
            { value: 'new', label: 'A new database' },
          ]}
        />
      )}
      <label className="flex w-72 flex-col gap-1">
        <span className="text-[11px] font-medium text-muted">
          {target.engine === 'redis'
            ? 'Database number'
            : choices.createDatabase
              ? 'New database name'
              : 'Database'}
        </span>
        <TextField
          aria-label={choices.createDatabase ? 'New database name' : 'Target database'}
          mono
          value={choices.database}
          placeholder={sql && !choices.createDatabase ? 'The connection default' : ''}
          onChange={(event) => change({ database: event.target.value })}
        />
      </label>
      {target.engine === 'redis' && (
        <div className="flex flex-col gap-1">
          <Check checked={choices.replace} onChange={(replace) => change({ replace })}>
            Replace keys that exist (REPLACE)
          </Check>
          <Check checked={choices.absoluteTtl} onChange={(absoluteTtl) => change({ absoluteTtl })}>
            Keep the original expiry times (keys already expired are skipped)
          </Check>
        </div>
      )}
      {sql && script && (
        <Choice<BackupMethod>
          name="restore-method"
          legend="Run the script with"
          value={choices.method}
          onChange={(method) => change({ method })}
          options={[
            {
              value: 'joinery',
              label: 'Joinery (statement by statement)',
              disabled: inspection.format === 'custom',
            },
            {
              value: 'native',
              label: props.restoreTool
                ? `Native tool (${props.restoreTool})`
                : 'Native tool (not found)',
              disabled: props.restoreTool === undefined,
            },
          ]}
        />
      )}
      <Choice<'stop' | 'continue'>
        name="restore-errors"
        legend="When a statement fails"
        value={choices.onError}
        onChange={(onError) => change({ onError })}
        options={[
          { value: 'stop', label: 'Stop (and roll back what can be)' },
          { value: 'continue', label: 'Log it and continue' },
        ]}
      />
      {props.problem && <p className="text-muted">{props.problem}</p>}
    </div>
  );
}

function ReviewStep(props: {
  readonly plan: RestorePlan;
  readonly acknowledged: boolean;
  readonly onAcknowledged: (value: boolean) => void;
  readonly target: BackupTarget;
}) {
  const { plan } = props;
  const drops = plan.conflicts.filter((c) => c.action !== 'append').length;
  return (
    <div className="flex flex-col gap-2" data-testid="restore-review">
      {plan.objects.length > 0 && (
        <p>
          Restores {formatCount(plan.objects.length)} objects
          {plan.added.length > 0 ? `, ${plan.added.length} of them because others need them` : ''}.
        </p>
      )}
      {plan.skipped.length > 0 && (
        <details>
          <summary className="cursor-pointer text-warning">{plan.skipped.length} left out</summary>
          <ul className="ml-4 list-disc">
            {plan.skipped.map((s) => (
              <li key={s.id}>
                <span className="font-mono">{s.id}</span>: {s.reason}
              </li>
            ))}
          </ul>
        </details>
      )}
      {plan.warnings.map((warning, i) => (
        <p key={i} className="text-warning">
          {warning}
        </p>
      ))}
      {plan.conflicts.length === 0 ? (
        <p className="text-muted">Nothing that exists is dropped or overwritten.</p>
      ) : (
        <div className="flex flex-col gap-1.5 rounded border border-danger/50 p-2">
          <p className="font-medium text-danger">
            {drops > 0
              ? `${drops} existing ${drops === 1 ? 'object is' : 'objects are'} dropped or overwritten:`
              : 'These objects exist already:'}
          </p>
          <ul
            className="max-h-40 overflow-auto font-mono text-[11px]"
            data-testid="restore-conflicts"
          >
            {plan.conflicts.map((conflict) => (
              <li key={conflict.id}>{conflictLabel(conflict)}</li>
            ))}
          </ul>
          <Check checked={props.acknowledged} onChange={props.onAcknowledged}>
            I understand: restore over these objects
          </Check>
        </div>
      )}
      {props.target.confirmWrites && (
        <p className="text-warning">
          {props.target.production ? 'This is a production connection' : 'This connection asks'}{' '}
          before every write: you confirm once more before the restore starts.
        </p>
      )}
    </div>
  );
}
