import type { JobInfo } from '@joinery/ipc';
import { useMemo, type ReactNode } from 'react';

import { formatCount, formatDuration } from '../../lib/format';
import { showBackupJob } from '../../state/backup/dialogs';
import { cancelJob, jobFraction, useJobs } from '../../state/jobs';
import { Button, cx } from '../ui';
import { formatBytes } from '../jobs/shared';

/** Pieces the backup and restore wizards share: live progress, history and checkboxes. */

const STATE_LABELS: Readonly<Record<JobInfo['state'], string>> = {
  running: 'Running',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

/** A started backup or restore job, as the job runner reports it. */
export function JobProgress(props: { readonly jobId: string }) {
  const job = useJobs((state) => state.jobs[props.jobId]);
  if (!job) return <p className="text-xs text-muted">Starting…</p>;
  const fraction = jobFraction(job);
  const progress = job.progress;
  const summary = job.summary;
  const incomplete = job.state === 'completed' && (summary?.failed ?? 0) > 0;
  return (
    <div
      className="flex flex-col gap-2 text-xs"
      data-testid="backup-progress"
      data-state={job.state}
    >
      <p className="font-medium">{job.title}</p>
      <p>
        <span
          data-testid="backup-state"
          className={cx(
            'font-semibold',
            job.state === 'failed' && 'text-danger',
            (job.state === 'cancelled' || incomplete) && 'text-warning',
            job.state === 'completed' && !incomplete && 'text-success',
          )}
        >
          {incomplete ? 'Completed with errors' : STATE_LABELS[job.state]}
        </span>
        {job.cancelling && job.state === 'running' ? ' · cancelling…' : ''}
      </p>
      {job.state === 'running' && (
        <div
          className="h-1.5 w-full overflow-hidden rounded bg-panel-2"
          role="progressbar"
          aria-label="Progress"
          {...(fraction !== undefined ? { 'aria-valuenow': Math.round(fraction * 100) } : {})}
        >
          <div
            className={cx('h-full bg-accent', fraction === undefined && 'animate-pulse')}
            style={{ width: `${Math.round((fraction ?? 1) * 100)}%` }}
          />
        </div>
      )}
      {job.state === 'running' && progress && (
        <p className="text-muted">
          {progress.phase}
          {progress.rowsWritten !== undefined ? ` · ${formatCount(progress.rowsWritten)} rows` : ''}
          {progress.bytes !== undefined ? ` · ${formatBytes(progress.bytes)}` : ''}
          {progress.failed ? ` · ${formatCount(progress.failed)} failed` : ''}
        </p>
      )}
      {summary && job.state !== 'running' && (
        <p className="text-muted" data-testid="backup-summary">
          {formatCount(summary.rowsWritten)} rows
          {summary.bytesWritten !== undefined ? ` · ${formatBytes(summary.bytesWritten)}` : ''}
          {summary.statements !== undefined
            ? ` · ${formatCount(summary.statements)} statements`
            : ''}
          {summary.failed ? ` · ${formatCount(summary.failed)} failed` : ''}
          {` · ${formatDuration(summary.durationMs)}`}
        </p>
      )}
      {job.error && (
        <p role="alert" className="text-danger">
          {job.error.message}
        </p>
      )}
      {job.errors.length > 0 && (
        <ul className="max-h-32 overflow-auto rounded border border-border p-1.5 font-mono text-[11px]">
          {job.errors.slice(0, 50).map((error, i) => (
            <li key={i} className="text-danger">
              {error.line !== undefined ? `line ${error.line}: ` : ''}
              {error.message}
            </li>
          ))}
        </ul>
      )}
      <div className="flex gap-2">
        {job.state === 'running' && (
          <Button size="sm" onClick={() => void cancelJob(job.id)} disabled={job.cancelling}>
            Cancel job
          </Button>
        )}
        <Button size="sm" variant="ghost" onClick={() => showBackupJob(job.id)}>
          Show in Jobs
        </Button>
      </div>
    </div>
  );
}

/** The connection's recent backups or restores, from the job history. */
export function BackupHistory(props: {
  readonly profileId: string;
  readonly kind: 'backup' | 'restore';
}) {
  const order = useJobs((state) => state.order);
  const jobs = useJobs((state) => state.jobs);
  const recent = useMemo(
    () =>
      order
        .map((id) => jobs[id])
        .filter(
          (job): job is JobInfo =>
            job !== undefined && job.kind === props.kind && job.profileId === props.profileId,
        )
        .slice(0, 8),
    [order, jobs, props.kind, props.profileId],
  );
  return (
    <section className="flex flex-col gap-1 text-xs" aria-label="History">
      <h3 className="text-[11px] font-medium text-muted">
        {props.kind === 'backup' ? 'Recent backups' : 'Recent restores'}
      </h3>
      {recent.length === 0 ? (
        <p className="text-muted">None yet on this connection.</p>
      ) : (
        <ul className="flex flex-col" data-testid="backup-history">
          {recent.map((job) => (
            <li key={job.id}>
              <button
                type="button"
                className="flex w-full items-center gap-2 rounded px-1.5 py-0.5 text-left hover:bg-hover"
                onClick={() => showBackupJob(job.id)}
                title="Show in Jobs"
              >
                <span className="min-w-0 flex-1 truncate">{job.title}</span>
                <span className={cx(job.state === 'failed' && 'text-danger', 'text-muted')}>
                  {STATE_LABELS[job.state]}
                </span>
                <span className="text-muted">{new Date(job.createdAt).toLocaleString()}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** A labelled checkbox. */
export function Check(props: {
  readonly checked: boolean;
  readonly onChange: (checked: boolean) => void;
  readonly children: ReactNode;
  readonly disabled?: boolean;
  readonly indeterminate?: boolean;
  readonly hint?: string;
}) {
  return (
    <label
      className={cx('flex items-center gap-1.5', props.disabled && 'opacity-50')}
      title={props.hint}
    >
      <input
        type="checkbox"
        checked={props.checked}
        disabled={props.disabled}
        ref={(element) => {
          if (element) element.indeterminate = props.indeterminate === true;
        }}
        onChange={(event) => props.onChange(event.target.checked)}
      />
      {props.children}
    </label>
  );
}

/** A group of radio buttons. */
export function Choice<T extends string>(props: {
  readonly name: string;
  readonly legend: string;
  readonly value: T;
  readonly options: readonly {
    readonly value: T;
    readonly label: ReactNode;
    readonly disabled?: boolean;
  }[];
  readonly onChange: (value: T) => void;
}) {
  return (
    <fieldset className="flex flex-col gap-1">
      <legend className="mb-1 text-[11px] font-medium text-muted">{props.legend}</legend>
      {props.options.map((option) => (
        <label
          key={option.value}
          className={cx('flex items-center gap-1.5', option.disabled && 'opacity-50')}
        >
          <input
            type="radio"
            name={props.name}
            checked={props.value === option.value}
            disabled={option.disabled}
            onChange={() => props.onChange(option.value)}
          />
          {option.label}
        </label>
      ))}
    </fieldset>
  );
}
