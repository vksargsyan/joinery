import type { ScheduleRule } from '@querybara/core';
import type { ScheduleNotify, ScheduleOutput } from '@querybara/ipc';
import { useEffect, useMemo, useState } from 'react';

import { errorMessage } from '../../lib/errors';
import { mainApi } from '../../lib/main-client';
import {
  closeScheduleEditor,
  openSchedulesPanel,
  saveSchedule,
  useSchedules,
  type ScheduleDraft,
} from '../../state/schedules';
import { Button, Icon, Modal, cx } from '../ui';
import { RuleEditor } from './RuleEditor';
import { KindIcon } from './parts';

/**
 * The schedule editor (spec: scheduler and automation): what runs (from the wizard that made
 * it, or the schedule being edited), its name, when it runs, where each run's file goes (a
 * folder picked here, a name with {name}, {date} and {time}, how many to keep), and when to
 * notify. An encrypted backup asks for its passphrase once; it is kept in the secret store.
 */
export function ScheduleDialog() {
  const draft = useSchedules((s) => s.editing);
  if (!draft) return null;
  return <Editor key={draft.id ?? 'new'} draft={draft} />;
}

const NOTIFY: readonly { readonly value: ScheduleNotify; readonly label: string }[] = [
  { value: 'failures', label: 'When a run fails or finds differences' },
  { value: 'always', label: 'After every run' },
  { value: 'never', label: 'Never' },
];

const pad = (n: number): string => String(n).padStart(2, '0');

/** A stable empty list: a selector returning a new [] each time would never settle. */
const NO_WARNINGS: readonly string[] = [];

/** The template's next file name, as the scheduler will write it. */
function sampleName(template: string, name: string, at: Date): string {
  const slug =
    name
      .trim()
      .replace(/[^\p{L}\p{N}._-]+/gu, '-')
      .replace(/-+/g, '-')
      .replace(/^[-.]+|-+$/g, '') || 'schedule';
  return template
    .replaceAll('{name}', slug)
    .replaceAll('{date}', `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`)
    .replaceAll('{time}', `${pad(at.getHours())}-${pad(at.getMinutes())}`);
}

function Editor({ draft }: { readonly draft: ScheduleDraft }) {
  const [name, setName] = useState(draft.name);
  const [rule, setRule] = useState<ScheduleRule | undefined>(draft.rule);
  const [missed, setMissed] = useState(draft.missed);
  const [notify, setNotify] = useState(draft.notify);
  const [enabled, setEnabled] = useState(draft.enabled);
  const [output, setOutput] = useState<ScheduleOutput | undefined>(
    draft.task.kind === 'sql' ? undefined : draft.task.output,
  );
  const [passphrase, setPassphrase] = useState(draft.passphrase ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const warnings = useSchedules(
    (s) => s.schedules.find((schedule) => schedule.id === draft.id)?.warnings ?? NO_WARNINGS,
  );
  useEffect(() => setError(undefined), [name, rule, output, passphrase]);

  const encrypted = draft.task.kind === 'backup' && draft.task.encrypted;
  const needsPassphrase = encrypted && draft.id === undefined && draft.passphrase === undefined;
  const templateProblem = useMemo(() => {
    if (!output) return undefined;
    if (/[\\/]/.test(output.fileName)) return 'A file name has no folder in it';
    if (!output.fileName.includes('{date}') && !output.fileName.includes('{time}')) {
      return 'Put {date} or {time} in the name, so runs do not overwrite each other';
    }
    return undefined;
  }, [output]);
  const problem =
    name.trim() === ''
      ? 'Give the schedule a name'
      : !rule
        ? 'Finish the schedule above'
        : output && output.folder === ''
          ? 'Choose the folder each run writes to'
          : (templateProblem ??
            (needsPassphrase && passphrase === '' ? 'Enter the backup passphrase' : undefined));

  const chooseFolder = async (): Promise<void> => {
    const { path } = await mainApi().dialogs.openDirectory({ title: 'Choose where runs write' });
    if (path !== null && output) setOutput({ ...output, folder: path });
  };

  const save = async (): Promise<void> => {
    if (problem || !rule) return;
    setSaving(true);
    try {
      const saved = await saveSchedule(draft, {
        name: name.trim(),
        rule,
        missed,
        notify,
        enabled,
        ...(output && draft.task.kind !== 'sql'
          ? { task: { ...draft.task, output } as ScheduleDraft['task'] }
          : {}),
        ...(passphrase !== '' ? { passphrase } : {}),
      });
      closeScheduleEditor();
      openSchedulesPanel(saved.id);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open
      onOpenChange={(open) => !open && !saving && closeScheduleEditor()}
      title={draft.id === undefined ? 'Schedule' : 'Edit the schedule'}
      width="w-[600px]"
      footer={
        <>
          <label className="mr-auto flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(event) => setEnabled(event.target.checked)}
              className="accent-[var(--accent)]"
            />
            On
          </label>
          <Button onClick={() => closeScheduleEditor()} disabled={saving}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={() => void save()}
            disabled={saving || problem !== undefined}
            title={problem}
            data-testid="schedule-save"
          >
            {saving ? 'Saving…' : draft.id === undefined ? 'Schedule' : 'Save'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-5 text-[13px]" data-testid="schedule-editor">
        <div className="flex items-start gap-3 rounded-lg border border-border bg-panel-2 p-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-accent/15 text-accent">
            <KindIcon kind={draft.task.kind} className="h-4.5 w-4.5" />
          </span>
          <div className="min-w-0 flex-1">
            <input
              aria-label="Schedule name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              className="w-full rounded border border-transparent bg-transparent px-1 py-0.5 text-sm font-semibold text-fg hover:border-border focus:border-accent focus:bg-bg focus:outline-none"
            />
            <p className="mt-0.5 px-1 text-xs text-muted">{draft.what}</p>
          </div>
        </div>

        {warnings.length > 0 && (
          <ul className="flex flex-col gap-1 rounded-md border border-warning/40 bg-warning/8 px-3 py-2 text-xs text-warning">
            {warnings.map((warning) => (
              <li key={warning} className="flex gap-1.5">
                <Icon name="warning" className="mt-0.5 h-3 w-3 shrink-0" />
                {warning}
              </li>
            ))}
          </ul>
        )}

        <section aria-label="When">
          <h3 className="mb-2 text-[11px] font-semibold tracking-wide text-muted uppercase">
            When
          </h3>
          <RuleEditor
            rule={draft.rule}
            missed={missed}
            onChange={setRule}
            onMissedChange={setMissed}
          />
        </section>

        {output && (
          <section aria-label="Output">
            <h3 className="mb-2 text-[11px] font-semibold tracking-wide text-muted uppercase">
              Each run writes
            </h3>
            <div className="flex flex-col gap-2">
              <div className="flex items-center gap-2">
                <span
                  className={cx(
                    'min-w-0 flex-1 truncate rounded border border-border bg-panel-2 px-2 py-1.5 font-mono text-xs',
                    output.folder === '' && 'text-muted',
                  )}
                  title={output.folder}
                  data-testid="schedule-folder"
                >
                  {output.folder === '' ? 'No folder chosen' : output.folder}
                </span>
                <Button size="sm" onClick={() => void chooseFolder()}>
                  {output.folder === '' ? 'Choose folder…' : 'Change…'}
                </Button>
              </div>
              <label className="flex items-center gap-2">
                <span className="w-20 shrink-0 text-xs text-muted">Named</span>
                <input
                  aria-label="File name"
                  value={output.fileName}
                  onChange={(event) => setOutput({ ...output, fileName: event.target.value })}
                  aria-invalid={templateProblem !== undefined}
                  className="h-8 min-w-0 flex-1 rounded border border-border bg-panel-2 px-2 font-mono text-xs text-fg focus:border-accent focus:outline-none aria-[invalid=true]:border-danger"
                />
              </label>
              <p className="pl-22 text-xs text-muted">
                {templateProblem ? (
                  <span className="text-danger">{templateProblem}</span>
                ) : (
                  <>
                    Like{' '}
                    <span className="font-mono text-fg">
                      {sampleName(output.fileName, name, new Date())}
                    </span>
                    {' · '}
                    {['{name}', '{date}', '{time}'].map((token) => (
                      <button
                        key={token}
                        type="button"
                        className="mx-0.5 rounded bg-panel-2 px-1 font-mono text-[11px] text-accent hover:bg-hover"
                        onClick={() =>
                          setOutput({ ...output, fileName: `${output.fileName}${token}` })
                        }
                        title={`Add ${token}`}
                      >
                        {token}
                      </button>
                    ))}
                  </>
                )}
              </p>
              <label className="flex items-center gap-2 text-xs">
                <input
                  type="checkbox"
                  checked={output.keep !== null}
                  onChange={(event) =>
                    setOutput({ ...output, keep: event.target.checked ? 14 : null })
                  }
                  className="accent-[var(--accent)]"
                />
                Keep only the newest
                <input
                  type="number"
                  aria-label="Files to keep"
                  min={1}
                  max={1000}
                  disabled={output.keep === null}
                  value={output.keep ?? 14}
                  onChange={(event) =>
                    setOutput({
                      ...output,
                      keep: Math.max(1, Math.min(1000, Number(event.target.value) || 1)),
                    })
                  }
                  className="h-7 w-16 rounded border border-border bg-panel-2 px-1.5 text-xs text-fg focus:border-accent focus:outline-none disabled:opacity-50"
                />
                <span className="text-muted">
                  {draft.task.kind === 'comparison' ? 'reports' : 'files'}; older ones this schedule
                  wrote are deleted
                </span>
              </label>
            </div>
          </section>
        )}

        {encrypted && (
          <section aria-label="Encryption">
            <h3 className="mb-2 text-[11px] font-semibold tracking-wide text-muted uppercase">
              Encryption
            </h3>
            <label className="flex items-center gap-2">
              <span className="w-20 shrink-0 text-xs text-muted">Passphrase</span>
              <input
                type="password"
                aria-label="Backup passphrase"
                value={passphrase}
                autoComplete="new-password"
                placeholder={needsPassphrase ? 'Required' : 'Kept: type to change it'}
                onChange={(event) => setPassphrase(event.target.value)}
                className="h-8 min-w-0 flex-1 rounded border border-border bg-panel-2 px-2 text-[13px] text-fg focus:border-accent focus:outline-none"
              />
            </label>
            <p className="mt-1 pl-22 text-xs text-muted">
              Kept in this computer&apos;s secure storage, never with the schedule.
            </p>
          </section>
        )}

        <section aria-label="Notifications">
          <h3 className="mb-2 text-[11px] font-semibold tracking-wide text-muted uppercase">
            Notify me
          </h3>
          <div role="radiogroup" aria-label="Notify me" className="flex flex-col gap-1">
            {NOTIFY.map((option) => (
              <label key={option.value} className="flex items-center gap-2 text-xs">
                <input
                  type="radio"
                  name="notify"
                  checked={notify === option.value}
                  onChange={() => setNotify(option.value)}
                  className="accent-[var(--accent)]"
                />
                {option.label}
              </label>
            ))}
          </div>
        </section>

        <p className="rounded-md bg-panel-2 px-3 py-2 text-xs text-muted">
          Schedules run while Querybara is open, and closing it with schedules on asks first. Runs
          missed while it is closed are caught up or skipped, as chosen above, when it opens again.
          A run needs the connection&apos;s password saved.
        </p>

        {error && (
          <p
            role="alert"
            className="rounded-md border border-danger/40 bg-danger/8 px-3 py-2 text-xs text-danger"
          >
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}
