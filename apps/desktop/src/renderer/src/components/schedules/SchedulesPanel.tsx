import { upcomingRuns } from '@joinery/core';
import type { ScheduleInfo, ScheduleRunInfo } from '@joinery/ipc';
import { useEffect, useState } from 'react';

import { copyToClipboard } from '../../lib/clipboard';
import { errorMessage } from '../../lib/errors';
import { useSettings } from '../../state/data';
import { confirm } from '../../state/dialogs';
import {
  deleteSchedule,
  draftOf,
  editSchedule,
  loadSchedules,
  runScheduleNow,
  selectSchedule,
  setConfirmClose,
  setScheduleEnabled,
  useSchedules,
} from '../../state/schedules';
import { Button, Icon, cx } from '../ui';
import { KIND_LABELS, KindIcon, StatusPill, duration, relative, when } from './parts';

/**
 * The Schedules panel (spec: scheduler and automation): every schedule with its switch, when it
 * runs next and how its last run went; the selected one's details (what, when, where its files
 * go, what would make it fail) with Run now, Edit and Delete; and its run history, newest first,
 * with each run's message and files.
 */
export function SchedulesPanel() {
  const status = useSchedules((s) => s.status);
  const error = useSchedules((s) => s.error);
  const schedules = useSchedules((s) => s.schedules);
  const selected = useSchedules((s) => s.selected);
  // Relative times ("in 3 h") stay current.
  const [, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTick((n) => n + 1), 30_000);
    return () => clearInterval(timer);
  }, []);
  const current = schedules.find((s) => s.id === selected);

  return (
    <div className="flex h-full flex-col bg-bg" data-testid="schedules-panel">
      <header className="flex items-center gap-3 border-b border-border bg-panel px-4 py-3">
        <div className="min-w-0 flex-1">
          <h1 className="text-sm font-semibold text-fg">Schedules</h1>
          <p className="text-xs text-muted">
            Backups, SQL files, exports and comparisons that run by themselves while Joinery is
            open.
          </p>
        </div>
        <AskBeforeClosing />
        <Button size="sm" variant="ghost" onClick={() => void loadSchedules()}>
          <Icon name="refresh" className="h-3.5 w-3.5" />
          Refresh
        </Button>
      </header>
      {status === 'error' && (
        <p
          role="alert"
          className="border-b border-danger/30 bg-danger/10 px-4 py-2 text-xs text-danger"
        >
          The schedules could not be read: {error}
        </p>
      )}
      {status === 'ready' && schedules.length === 0 ? (
        <Empty />
      ) : (
        <div className="flex min-h-0 flex-1">
          <ul
            aria-label="Schedules"
            className="w-[400px] shrink-0 overflow-auto border-r border-border bg-panel py-1"
          >
            {schedules.map((schedule) => (
              <ScheduleRow
                key={schedule.id}
                schedule={schedule}
                active={schedule.id === selected}
              />
            ))}
          </ul>
          <div className="min-w-0 flex-1 overflow-auto">
            {current ? <Details schedule={current} /> : null}
          </div>
        </div>
      )}
    </div>
  );
}

function Empty() {
  const ways = [
    { kind: 'backup' as const, text: 'Back up… on a connection or database, then Schedule…' },
    { kind: 'export' as const, text: 'Export… on tables or a query result, then Schedule…' },
    { kind: 'sql' as const, text: 'Run SQL file… on a connection, then Schedule…' },
    { kind: 'comparison' as const, text: 'Compare, then Schedule… on a saved comparison' },
  ];
  return (
    <div className="flex flex-1 items-center justify-center p-8">
      <div className="max-w-md text-center">
        <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-accent/12 text-accent">
          <svg
            viewBox="0 0 16 16"
            className="h-6 w-6"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.3"
            aria-hidden
          >
            <circle cx="8" cy="8" r="6.5" />
            <path d="M8 4.5V8l2.5 1.5" />
          </svg>
        </span>
        <h2 className="mt-3 text-sm font-semibold text-fg">No schedules yet</h2>
        <p className="mt-1 text-xs text-muted">
          Any of these can run on a schedule. Set one up where you run it once:
        </p>
        <ul className="mt-4 flex flex-col gap-2 text-left">
          {ways.map((way) => (
            <li
              key={way.kind}
              className="flex items-center gap-3 rounded-lg border border-border bg-panel px-3 py-2 text-xs"
            >
              <KindIcon kind={way.kind} className="text-accent" />
              {way.text}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

/** The setting behind the question Joinery asks when it closes with schedules on. */
function AskBeforeClosing() {
  const settings = useSettings();
  const [error, setError] = useState<string>();
  const on = settings.data?.schedules.confirmClose ?? true;
  return (
    <div
      className="flex items-center gap-2 text-xs text-muted"
      title={
        error ??
        'Schedules run only while Joinery is open, so closing it with schedules on asks first'
      }
    >
      <Switch
        on={on}
        label="Ask before closing Joinery"
        onChange={(next) => {
          setError(undefined);
          setConfirmClose(next).catch((e: unknown) => setError(errorMessage(e)));
        }}
      />
      <span className={cx(error !== undefined && 'text-danger')} aria-hidden>
        Ask before closing
      </span>
    </div>
  );
}

function Switch(props: {
  readonly on: boolean;
  readonly label: string;
  readonly onChange: (on: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={props.on}
      aria-label={props.label}
      onClick={(event) => {
        event.stopPropagation();
        props.onChange(!props.on);
      }}
      className={cx(
        'relative h-5 w-9 shrink-0 rounded-full transition-colors',
        props.on ? 'bg-accent' : 'bg-pressed ring-1 ring-strong ring-inset',
      )}
    >
      <span
        aria-hidden
        className={cx(
          'absolute top-0.5 left-0 h-4 w-4 rounded-full transition-transform',
          props.on ? 'translate-x-4.5 bg-accent-fg' : 'translate-x-0.5 bg-muted',
        )}
      />
    </button>
  );
}

function ScheduleRow(props: { readonly schedule: ScheduleInfo; readonly active: boolean }) {
  const { schedule } = props;
  const [error, setError] = useState<string>();
  return (
    <li>
      <div
        role="button"
        tabIndex={0}
        data-testid="schedule-row"
        data-schedule={schedule.name}
        aria-current={props.active || undefined}
        onClick={() => selectSchedule(schedule.id)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            selectSchedule(schedule.id);
          }
        }}
        className={cx(
          'mx-1 flex cursor-default items-start gap-3 rounded-md px-3 py-2.5 outline-none focus-visible:ring-2 focus-visible:ring-focus',
          props.active ? 'bg-accent/12' : 'hover:bg-hover',
          !schedule.enabled && 'opacity-60',
        )}
      >
        <span
          className={cx(
            'mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md',
            schedule.enabled ? 'bg-accent/15 text-accent' : 'bg-panel-2 text-muted',
          )}
        >
          <KindIcon kind={schedule.kind} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-fg">
              {schedule.name}
            </span>
            {schedule.warnings.length > 0 && (
              <span
                title={schedule.warnings.join('\n')}
                className="text-warning"
                aria-label="Needs attention"
              >
                <Icon name="warning" className="h-3.5 w-3.5" />
              </span>
            )}
          </div>
          <p className="truncate text-xs text-muted">
            {schedule.description} · {schedule.target}
          </p>
          <div className="mt-1 flex items-center gap-2 text-[11px] text-muted">
            {schedule.running ? (
              <StatusPill status="running" />
            ) : (
              schedule.lastStatus && <StatusPill status={schedule.lastStatus} />
            )}
            <span className="truncate">
              {schedule.enabled && schedule.nextRunAt
                ? `Next ${relative(schedule.nextRunAt)}`
                : schedule.enabled
                  ? 'Planning…'
                  : 'Off'}
            </span>
          </div>
          {error && <p className="mt-1 text-[11px] text-danger">{error}</p>}
        </div>
        <Switch
          on={schedule.enabled}
          label={`Turn ${schedule.name} ${schedule.enabled ? 'off' : 'on'}`}
          onChange={(on) => {
            setError(undefined);
            setScheduleEnabled(schedule.id, on).catch((e) => setError(errorMessage(e)));
          }}
        />
      </div>
    </li>
  );
}

function Details({ schedule }: { readonly schedule: ScheduleInfo }) {
  const runs = useSchedules((s) => s.runs[schedule.id]);
  const [error, setError] = useState<string>();
  const upcoming = schedule.enabled ? upcomingRuns(schedule.rule, new Date(), 3) : [];
  const output = schedule.task.kind === 'sql' ? undefined : schedule.task.output;

  const remove = async (): Promise<void> => {
    const ok = await confirm({
      title: `Delete ${schedule.name}?`,
      message: 'It stops running. Files its runs wrote stay where they are.',
      confirmLabel: 'Delete',
      danger: true,
    });
    if (ok) await deleteSchedule(schedule.id).catch((e) => setError(errorMessage(e)));
  };

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-5 p-5" data-testid="schedule-details">
      <div className="flex items-start gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-accent/15 text-accent">
          <KindIcon kind={schedule.kind} className="h-5 w-5" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-base font-semibold text-fg">{schedule.name}</h2>
          <p className="text-xs text-muted">
            {KIND_LABELS[schedule.kind]} · {schedule.target}
          </p>
        </div>
        <Button
          size="sm"
          variant="primary"
          disabled={schedule.running}
          onClick={() => {
            setError(undefined);
            runScheduleNow(schedule.id).catch((e) => setError(errorMessage(e)));
          }}
          data-testid="schedule-run-now"
        >
          <Icon name="play" className="h-3.5 w-3.5" />
          {schedule.running ? 'Running…' : 'Run now'}
        </Button>
        <Button size="sm" onClick={() => editSchedule(draftOf(schedule))}>
          Edit
        </Button>
        <Button size="sm" variant="ghost" className="text-danger" onClick={() => void remove()}>
          Delete
        </Button>
      </div>

      {error && (
        <p
          role="alert"
          className="rounded-md border border-danger/40 bg-danger/8 px-3 py-2 text-xs text-danger"
        >
          {error}
        </p>
      )}
      {schedule.warnings.length > 0 && (
        <ul className="flex flex-col gap-1 rounded-md border border-warning/40 bg-warning/8 px-3 py-2 text-xs text-warning">
          {schedule.warnings.map((warning) => (
            <li key={warning} className="flex gap-1.5">
              <Icon name="warning" className="mt-0.5 h-3 w-3 shrink-0" />
              {warning}
            </li>
          ))}
        </ul>
      )}

      <dl className="grid grid-cols-[120px_1fr] gap-x-4 gap-y-2 rounded-lg border border-border bg-panel p-4 text-xs">
        <dt className="text-muted">When</dt>
        <dd className="text-fg">
          {schedule.description}
          {!schedule.enabled && <span className="text-muted"> · off</span>}
        </dd>
        {upcoming.length > 0 && (
          <>
            <dt className="text-muted">Next runs</dt>
            <dd className="text-fg">{upcoming.map((d) => when(d.toISOString())).join(' · ')}</dd>
          </>
        )}
        <dt className="text-muted">Missed runs</dt>
        <dd className="text-fg">
          {schedule.missed === 'run-once' ? 'Caught up once when Joinery is back' : 'Skipped'}
        </dd>
        {output && (
          <>
            <dt className="text-muted">Writes to</dt>
            <dd className="truncate font-mono text-fg" title={output.folder}>
              {output.folder}
            </dd>
            <dt className="text-muted">Named</dt>
            <dd className="font-mono text-fg">
              {output.fileName}
              {output.keep !== null && (
                <span className="font-sans text-muted"> · newest {output.keep} kept</span>
              )}
            </dd>
          </>
        )}
        {schedule.task.kind === 'sql' && (
          <>
            <dt className="text-muted">SQL file</dt>
            <dd className="truncate font-mono text-fg" title={schedule.task.job.path}>
              {schedule.task.job.path}
            </dd>
          </>
        )}
        <dt className="text-muted">Notifies</dt>
        <dd className="text-fg">
          {schedule.notify === 'failures'
            ? 'When a run fails or finds differences'
            : schedule.notify === 'always'
              ? 'After every run'
              : 'Never'}
        </dd>
      </dl>

      <section aria-label="Runs">
        <h3 className="mb-2 text-[11px] font-semibold tracking-wide text-muted uppercase">Runs</h3>
        {!runs || runs.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-xs text-muted">
            No runs yet.{schedule.nextRunAt ? ` The first is ${relative(schedule.nextRunAt)}.` : ''}
          </p>
        ) : (
          <ol
            className="flex flex-col divide-y divide-border rounded-lg border border-border bg-panel"
            data-testid="schedule-runs"
          >
            {runs.map((run) => (
              <RunRow key={run.id} run={run} />
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}

const TRIGGERS: Readonly<Record<ScheduleRunInfo['trigger'], string>> = {
  schedule: 'On schedule',
  'catch-up': 'Caught up',
  manual: 'Run now',
};

function RunRow({ run }: { readonly run: ScheduleRunInfo }) {
  return (
    <li
      className="flex flex-col gap-1 px-4 py-2.5 text-xs"
      data-testid="schedule-run"
      data-status={run.status}
    >
      <div className="flex items-center gap-2">
        <StatusPill status={run.status} />
        <span className="text-fg">{when(run.startedAt)}</span>
        <span className="text-muted">· {TRIGGERS[run.trigger]}</span>
        <span className="flex-1" />
        <span className="text-muted">{duration(run.startedAt, run.finishedAt)}</span>
      </div>
      {run.message && (
        <p className={cx('pl-1', run.status === 'failed' ? 'text-danger' : 'text-muted')}>
          {run.message}
        </p>
      )}
      {run.outputs.map((path) => (
        <button
          key={path}
          type="button"
          title="Copy the path"
          onClick={() => copyToClipboard(path)}
          className="truncate pl-1 text-left font-mono text-[11px] text-accent hover:underline"
        >
          {path}
        </button>
      ))}
    </li>
  );
}
