import { isSyncJobKind, type JobInfo, type JobRowError } from '@joinery/ipc';

import { formatCount, formatDuration } from '../../lib/format';
import {
  cancelJob,
  clearFinishedJobs,
  jobFraction,
  selectJob,
  showJobs,
  useJobs,
} from '../../state/jobs';
import { Button, Icon, cx } from '../ui';
import { formatBytes } from './shared';

/**
 * The job list (spec §14): running jobs with their progress (rows, bytes, rows per second,
 * phase) and a Cancel button, finished ones from the job history with their summary, the rows
 * or statements that failed, and the log.
 */
export function JobsPanel() {
  const order = useJobs((state) => state.order);
  const jobs = useJobs((state) => state.jobs);
  const selected = useJobs((state) => state.selected);
  const finished = order.some((id) => jobs[id] && jobs[id].state !== 'running');
  return (
    <aside
      className="flex h-full flex-col border-l border-border bg-panel"
      aria-label="Jobs"
      data-testid="jobs-panel"
    >
      <div className="flex items-center gap-2 border-b border-border px-2 py-1.5">
        <h2 className="flex-1 text-xs font-semibold tracking-wide text-muted uppercase">Jobs</h2>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => void clearFinishedJobs()}
          disabled={!finished}
        >
          Clear finished
        </Button>
        <Button size="sm" variant="ghost" onClick={() => showJobs(false)} aria-label="Close jobs">
          <Icon name="close" className="h-3 w-3" />
        </Button>
      </div>
      <ol className="min-h-0 flex-1 overflow-auto" data-testid="job-list">
        {order.length === 0 && (
          <li className="p-3 text-xs text-muted">
            Imports, exports, SQL files and comparisons you run appear here.
          </li>
        )}
        {order.map((id) => {
          const job = jobs[id];
          return job ? <JobItem key={id} job={job} expanded={selected === id} /> : null;
        })}
      </ol>
    </aside>
  );
}

const STATE_LABELS: Readonly<Record<JobInfo['state'], string>> = {
  running: 'Running',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

function JobItem(props: { readonly job: JobInfo; readonly expanded: boolean }) {
  const { job } = props;
  const fraction = jobFraction(job);
  const progress = job.progress;
  const summary = job.summary;
  const incomplete =
    job.state === 'completed' &&
    summary !== undefined &&
    (summary.rowsSkipped > 0 || (summary.failed ?? 0) > 0);
  return (
    <li
      className="border-b border-border px-2 py-1.5 text-xs"
      data-testid="job-item"
      data-state={job.state}
      data-job-id={job.id}
    >
      <button
        type="button"
        className="flex w-full items-center gap-1.5 text-left"
        aria-expanded={props.expanded}
        onClick={() => selectJob(props.expanded ? undefined : job.id)}
      >
        <span
          aria-hidden="true"
          className={cx(
            'h-1.5 w-1.5 shrink-0 rounded-full',
            job.state === 'running'
              ? 'animate-pulse bg-accent'
              : job.state === 'completed'
                ? incomplete
                  ? 'bg-warning'
                  : 'bg-success'
                : job.state === 'failed'
                  ? 'bg-danger'
                  : 'bg-warning',
          )}
        />
        <span className="min-w-0 flex-1 truncate font-medium" title={job.title}>
          {job.title}
        </span>
        <span
          className={cx('shrink-0', job.state === 'failed' ? 'text-danger' : 'text-muted')}
          data-testid="job-state"
        >
          {job.cancelling ? 'Cancelling…' : STATE_LABELS[job.state]}
        </span>
      </button>
      <p className="mt-0.5 truncate text-[11px] text-muted">
        {job.profileName}
        {job.target.database ? ` · ${job.target.database}` : ''}
      </p>
      {job.state === 'running' && (
        <div className="mt-1 flex flex-col gap-1">
          <div
            role="progressbar"
            aria-label={`${job.title} progress`}
            aria-valuemin={0}
            aria-valuemax={100}
            {...(fraction !== undefined ? { 'aria-valuenow': Math.round(fraction * 100) } : {})}
            className="h-1.5 overflow-hidden rounded bg-panel-2"
          >
            <div
              className={cx('h-full bg-accent', fraction === undefined && 'w-1/3 animate-pulse')}
              style={fraction !== undefined ? { width: `${fraction * 100}%` } : undefined}
            />
          </div>
          <div className="flex items-center gap-2 text-[11px] text-muted">
            <span className="min-w-0 flex-1 truncate" data-testid="job-progress">
              {progressText(job)}
            </span>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void cancelJob(job.id)}
              disabled={job.cancelling}
            >
              Cancel
            </Button>
          </div>
          {progress?.phase && <span className="text-[11px] text-muted">{progress.phase}</span>}
        </div>
      )}
      {job.state !== 'running' && (
        <p
          className={cx('mt-0.5 text-[11px]', job.state === 'failed' ? 'text-danger' : 'text-fg')}
          data-testid="job-summary"
        >
          {summaryText(job)}
        </p>
      )}
      {props.expanded && <JobDetails job={job} />}
    </li>
  );
}

function progressText(job: JobInfo): string {
  const p = job.progress;
  if (!p) return 'Starting…';
  const parts: string[] = [];
  if (job.kind === 'run-sql-file' || isSyncJobKind(job.kind)) {
    if (p.statements !== undefined) parts.push(`${formatCount(p.statements)} statements`);
    if (p.failed) parts.push(`${formatCount(p.failed)} failed`);
  } else if (p.rowsWritten !== undefined) {
    parts.push(`${formatCount(p.rowsWritten)} rows`);
    if (p.rowsSkipped) parts.push(`${formatCount(p.rowsSkipped)} skipped`);
    if (p.rowsPerSecond) parts.push(`${formatCount(p.rowsPerSecond)} rows/s`);
  }
  if (p.bytes !== undefined) {
    parts.push(
      p.totalBytes
        ? `${formatBytes(p.bytes)} of ${formatBytes(p.totalBytes)}`
        : formatBytes(p.bytes),
    );
  }
  if (p.table) parts.push(p.table);
  parts.push(formatDuration(p.elapsedMs));
  return parts.join(' · ');
}

function summaryText(job: JobInfo): string {
  const s = job.summary;
  if (!s) return job.error?.message ?? STATE_LABELS[job.state];
  const time = formatDuration(s.durationMs);
  if (isSyncJobKind(job.kind)) return `${s.outcome ?? STATE_LABELS[job.state]} · ${time}`;
  if (job.kind === 'run-sql-file') {
    return `${formatCount(s.statements ?? 0)} statements${s.failed ? `, ${formatCount(s.failed)} failed` : ''} · ${time}`;
  }
  const verb = job.kind === 'export' ? 'exported' : 'imported';
  const rows = `${formatCount(s.rowsWritten)} rows ${verb}`;
  const skipped = s.rowsSkipped > 0 ? `, ${formatCount(s.rowsSkipped)} skipped` : '';
  const bytes = s.bytesWritten !== undefined ? ` · ${formatBytes(s.bytesWritten)}` : '';
  const why = job.state === 'failed' && job.errors[0] ? ` · ${job.errors[0].message}` : '';
  return `${rows}${skipped}${bytes} · ${time}${why}`;
}

function JobDetails({ job }: { readonly job: JobInfo }) {
  const summary = job.summary;
  return (
    <div className="mt-2 flex flex-col gap-2" data-testid="job-details">
      {job.target.file && (
        <p className="font-mono text-[11px] break-all text-muted">{job.target.file}</p>
      )}
      {summary && (
        <dl className="grid grid-cols-[6.5rem_1fr] gap-x-2 text-[11px]">
          {isSyncJobKind(job.kind) ? (
            <>
              <dt className="text-muted">Outcome</dt>
              <dd>{summary.outcome ?? STATE_LABELS[job.state]}</dd>
              {summary.statements !== undefined && (
                <>
                  <dt className="text-muted">Statements</dt>
                  <dd>{formatCount(summary.statements)}</dd>
                </>
              )}
            </>
          ) : job.kind === 'run-sql-file' ? (
            <>
              <dt className="text-muted">Statements</dt>
              <dd>{formatCount(summary.statements ?? 0)}</dd>
              <dt className="text-muted">Failed</dt>
              <dd>{formatCount(summary.failed ?? 0)}</dd>
              <dt className="text-muted">Rows affected</dt>
              <dd>{formatCount(summary.rowsAffected ?? 0)}</dd>
            </>
          ) : (
            <>
              <dt className="text-muted">Rows read</dt>
              <dd>{formatCount(summary.rowsRead)}</dd>
              <dt className="text-muted">Rows {job.kind === 'export' ? 'written' : 'kept'}</dt>
              <dd>{formatCount(summary.rowsWritten)}</dd>
              <dt className="text-muted">Rows skipped</dt>
              <dd>{formatCount(summary.rowsSkipped)}</dd>
            </>
          )}
          <dt className="text-muted">Duration</dt>
          <dd>{formatDuration(summary.durationMs)}</dd>
          {summary.files?.map((file) => (
            <div key={file} className="contents">
              <dt className="text-muted">File</dt>
              <dd className="font-mono break-all">{file}</dd>
            </div>
          ))}
        </dl>
      )}
      {job.errors.length > 0 && <ErrorRows job={job} errors={job.errors} />}
      <ol
        className="max-h-40 overflow-auto rounded border border-border bg-panel-2 p-1 font-mono text-[11px]"
        aria-label="Job log"
        data-testid="job-log"
      >
        {job.log.map((entry, index) => (
          <li
            key={index}
            className={cx(
              'whitespace-pre-wrap',
              entry.level === 'error' && 'text-danger',
              entry.level === 'warning' && 'text-warning',
            )}
          >
            <span className="mr-1.5 text-muted">{new Date(entry.at).toLocaleTimeString()}</span>
            {entry.message}
          </li>
        ))}
      </ol>
    </div>
  );
}

function ErrorRows(props: { readonly job: JobInfo; readonly errors: readonly JobRowError[] }) {
  const statements = props.job.kind === 'run-sql-file' || isSyncJobKind(props.job.kind);
  return (
    <div className="max-h-48 overflow-auto rounded border border-danger/40">
      <table className="w-full text-[11px]" data-testid="job-errors">
        <thead className="sticky top-0 bg-panel text-left text-muted">
          <tr>
            {statements ? (
              <>
                <th className="px-1.5 py-0.5 font-medium">Statement</th>
                <th className="px-1.5 py-0.5 font-medium">Line</th>
              </>
            ) : (
              <>
                <th className="px-1.5 py-0.5 font-medium">Row</th>
                <th className="px-1.5 py-0.5 font-medium">Line</th>
                <th className="px-1.5 py-0.5 font-medium">Column</th>
              </>
            )}
            <th className="px-1.5 py-0.5 font-medium">Message</th>
          </tr>
        </thead>
        <tbody>
          {props.errors.map((error, index) => (
            <tr key={index} className="border-t border-border/60 align-top">
              {statements ? (
                <>
                  <td className="px-1.5 py-0.5">{error.statement ?? ''}</td>
                  <td className="px-1.5 py-0.5">{error.line ?? ''}</td>
                </>
              ) : (
                <>
                  <td className="px-1.5 py-0.5">{error.row ?? ''}</td>
                  <td className="px-1.5 py-0.5">{error.line ?? ''}</td>
                  <td className="px-1.5 py-0.5 font-mono">{error.column ?? ''}</td>
                </>
              )}
              <td className="px-1.5 py-0.5 text-danger">
                {error.message}
                {error.text && (
                  <pre className="mt-0.5 font-mono whitespace-pre-wrap text-muted">
                    {error.text}
                  </pre>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
