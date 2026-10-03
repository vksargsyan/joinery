import type { WatchScope } from '@querybara/mongo-tools';

import { formatCount } from '../../lib/format';
import {
  scopeLabel,
  useChangeStream,
  type ChangeEntry,
  type ChangeStreamViewer,
} from '../../state/mongo/change-stream';
import { Button, Icon, cx } from '../ui';
import { Banner, ShellInput, SmallSelect } from './parts';

/**
 * The change stream viewer panel (spec §9): scope, optional $match pipeline and the full
 * document switch; start, pause (keeps the resume token), resume, stop and clear; the live list
 * of events and the selected event's details.
 */

const OPERATION_CLASSES: Readonly<Record<string, string>> = {
  insert: 'bg-success/15 text-success',
  update: 'bg-accent/15 text-accent',
  replace: 'bg-warning/15 text-warning',
  delete: 'bg-danger/15 text-danger',
};

export function ChangeStreamPanel({ viewer }: { readonly viewer: ChangeStreamViewer }) {
  const scope = useChangeStream(viewer, (s) => s.scope);
  const status = useChangeStream(viewer, (s) => s.status);
  const pipelineText = useChangeStream(viewer, (s) => s.pipelineText);
  const pipelineIssue = useChangeStream(viewer, (s) => s.pipelineIssue);
  const fullDocument = useChangeStream(viewer, (s) => s.fullDocument);
  const log = useChangeStream(viewer, (s) => s.log);
  const selected = useChangeStream(viewer, (s) => s.selected);
  const error = useChangeStream(viewer, (s) => s.error);
  const standalone = useChangeStream(viewer, (s) => s.standalone);
  const resumeToken = useChangeStream(viewer, (s) => s.resumeToken);
  const watching = status === 'watching';
  const entry = log.entries.find((e) => e.seq === selected);
  const origin = viewer.target.scope;
  const scopes: { value: string; label: string; scope: WatchScope }[] = [
    ...(origin.kind === 'collection'
      ? [{ value: 'collection', label: `Collection ${origin.ns.collection}`, scope: origin }]
      : []),
    ...(origin.kind !== 'cluster'
      ? [
          {
            value: 'database',
            label: `Database ${origin.kind === 'database' ? origin.db : origin.ns.db}`,
            scope: {
              kind: 'database',
              db: origin.kind === 'database' ? origin.db : origin.ns.db,
            } as WatchScope,
          },
        ]
      : []),
    { value: 'cluster', label: 'Whole deployment', scope: { kind: 'cluster' } },
  ];

  return (
    <div
      className="flex h-full flex-col bg-bg"
      data-testid="mongo-changes-panel"
      aria-label="Change stream"
    >
      <div
        className="flex flex-wrap items-end gap-2 border-b border-border bg-panel px-2 py-1.5"
        role="toolbar"
        aria-label="Change stream"
      >
        <label className="flex flex-col gap-0.5 text-[11px] font-medium text-muted">
          Watch
          <SmallSelect
            value={scope.kind}
            disabled={watching}
            onChange={(event) => {
              const next = scopes.find((s) => s.value === event.target.value);
              if (next) viewer.setScope(next.scope);
            }}
            className="w-52"
            data-testid="changes-scope"
          >
            {scopes.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </SmallSelect>
        </label>
        <div className="flex min-w-[240px] flex-1 flex-col gap-0.5">
          <label htmlFor={`${viewer.id}-pipeline`} className="text-[11px] font-medium text-muted">
            $match filter or pipeline (optional)
          </label>
          <ShellInput
            id={`${viewer.id}-pipeline`}
            value={pipelineText}
            onChange={(text) => viewer.setPipelineText(text)}
            placeholder="{ operationType: 'insert' }  or  [{ $match: … }]"
            disabled={watching}
            issue={
              pipelineIssue
                ? `${pipelineIssue.message} (column ${pipelineIssue.column})`
                : undefined
            }
            data-testid="changes-pipeline"
          />
        </div>
        <label className="flex items-center gap-1 pb-1.5 text-xs">
          <input
            type="checkbox"
            checked={fullDocument}
            disabled={watching}
            onChange={(event) => viewer.setFullDocument(event.target.checked)}
            data-testid="changes-full-document"
          />
          Full document on update
        </label>
        {watching ? (
          <Button
            size="sm"
            variant="secondary"
            onClick={() => void viewer.pause()}
            data-testid="changes-pause"
          >
            Pause
          </Button>
        ) : (
          <Button
            size="sm"
            variant="primary"
            disabled={standalone || pipelineIssue !== undefined}
            onClick={() => void viewer.start()}
            data-testid="changes-start"
          >
            <Icon name="play" className="h-3.5 w-3.5" />
            {status === 'paused' ? 'Resume' : 'Start'}
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          disabled={status === 'stopped' || status === 'error'}
          onClick={() => void viewer.stop()}
          data-testid="changes-stop"
        >
          <Icon name="stop" className="h-3.5 w-3.5" />
          Stop
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => viewer.clear()}
          data-testid="changes-clear"
        >
          Clear
        </Button>
      </div>
      {standalone && (
        <Banner kind="warning" testId="changes-standalone">
          Change streams need a replica set or a sharded cluster; this server is a standalone. A
          one-member replica set works for development.
        </Banner>
      )}
      {error && !standalone && (
        <Banner kind="error" testId="changes-error">
          {error}
        </Banner>
      )}
      <div className="flex items-center gap-3 border-b border-border bg-panel px-2 py-1 text-xs">
        <span
          className={cx(
            'flex items-center gap-1.5 font-medium',
            watching ? 'text-success' : status === 'paused' ? 'text-warning' : 'text-muted',
          )}
          data-testid="changes-status"
          aria-live="polite"
        >
          <span
            className={cx(
              'h-2 w-2 rounded-full',
              watching
                ? 'animate-pulse bg-success'
                : status === 'paused'
                  ? 'bg-warning'
                  : 'bg-muted',
            )}
          />
          {watching
            ? `Watching ${scopeLabel(scope)}`
            : status === 'paused'
              ? 'Paused: resuming delivers what changed meanwhile'
              : status === 'error'
                ? 'Stopped by an error'
                : 'Stopped'}
        </span>
        <span className="text-muted" data-testid="changes-counts">
          {formatCount(Object.values(log.counts).reduce((sum, n) => sum + n, 0))} events
          {Object.entries(log.counts)
            .map(([op, n]) => ` · ${op} ${formatCount(n)}`)
            .join('')}
          {log.dropped > 0 ? ` · oldest ${formatCount(log.dropped)} dropped` : ''}
        </span>
        {resumeToken && status !== 'watching' && (
          <span className="truncate text-[11px] text-muted" title={resumeToken}>
            resume token kept
          </span>
        )}
      </div>
      <div className="flex min-h-0 flex-1">
        <div className="min-w-0 flex-1 overflow-auto">
          <table className="w-full border-collapse text-xs" data-testid="changes-list">
            <thead className="sticky top-0 bg-panel text-left text-muted">
              <tr>
                <th className="border-b border-border px-2 py-1 font-medium">#</th>
                <th className="border-b border-border px-2 py-1 font-medium">Time</th>
                <th className="border-b border-border px-2 py-1 font-medium">Operation</th>
                <th className="border-b border-border px-2 py-1 font-medium">Namespace</th>
                <th className="border-b border-border px-2 py-1 font-medium">Document key</th>
                <th className="border-b border-border px-2 py-1 font-medium">Changed fields</th>
              </tr>
            </thead>
            <tbody>
              {[...log.entries].reverse().map((change) => (
                <ChangeRow
                  key={change.seq}
                  change={change}
                  selected={change.seq === selected}
                  onSelect={() => viewer.select(change.seq)}
                />
              ))}
            </tbody>
          </table>
          {log.entries.length === 0 && (
            <p className="p-4 text-sm text-muted">
              {watching ? 'Waiting for changes…' : 'Start watching to see changes as they happen.'}
            </p>
          )}
        </div>
        <aside
          className="flex w-[380px] shrink-0 flex-col gap-2 overflow-auto border-l border-border p-2 text-xs"
          data-testid="changes-detail"
        >
          {entry ? <ChangeDetail change={entry} /> : <p className="text-muted">Select an event.</p>}
        </aside>
      </div>
    </div>
  );
}

function ChangeRow(props: {
  readonly change: ChangeEntry;
  readonly selected: boolean;
  readonly onSelect: () => void;
}) {
  const { change } = props;
  return (
    <tr
      data-operation={change.operationType}
      aria-selected={props.selected}
      tabIndex={0}
      onClick={props.onSelect}
      onKeyDown={(event) => event.key === 'Enter' && props.onSelect()}
      className={cx('cursor-default hover:bg-hover', props.selected && 'bg-accent/10')}
    >
      <td className="border-b border-border px-2 py-1 text-muted">{change.seq}</td>
      <td className="border-b border-border px-2 py-1 whitespace-nowrap text-muted">
        {change.clusterTime ? new Date(change.clusterTime).toLocaleTimeString() : ''}
      </td>
      <td className="border-b border-border px-2 py-1">
        <span
          className={cx(
            'rounded px-1.5 py-px text-[10px] font-semibold',
            OPERATION_CLASSES[change.operationType] ?? 'bg-panel-2 text-muted',
          )}
        >
          {change.operationType}
        </span>
      </td>
      <td className="border-b border-border px-2 py-1 font-mono">{change.namespace ?? ''}</td>
      <td className="border-b border-border px-2 py-1 font-mono" data-testid="change-key">
        {change.documentKey ?? ''}
      </td>
      <td className="max-w-[280px] truncate border-b border-border px-2 py-1 font-mono">
        {change.updatedFields ?? ''}
        {change.removedFields.length > 0 ? ` −${change.removedFields.join(', ')}` : ''}
      </td>
    </tr>
  );
}

function ChangeDetail({ change }: { readonly change: ChangeEntry }) {
  return (
    <>
      <h3 className="text-[13px] font-semibold">
        {change.operationType} · {change.namespace}
      </h3>
      {change.documentKey && (
        <p>
          Document key <span className="font-mono">{change.documentKey}</span>
        </p>
      )}
      {change.updatedFields && (
        <>
          <h4 className="text-[11px] font-medium text-muted">Updated fields</h4>
          <pre className="rounded border border-border bg-panel-2 p-2 font-mono whitespace-pre-wrap select-text">
            {change.updatedFields}
          </pre>
        </>
      )}
      {change.removedFields.length > 0 && (
        <p>
          Removed <span className="font-mono">{change.removedFields.join(', ')}</span>
        </p>
      )}
      <h4 className="text-[11px] font-medium text-muted">Full document</h4>
      <pre
        className="rounded border border-border bg-panel-2 p-2 font-mono whitespace-pre-wrap select-text"
        data-testid="change-full-document"
      >
        {change.fullDocument ??
          (change.operationType === 'delete' ? '(deleted)' : '(not looked up)')}
      </pre>
      <details>
        <summary className="cursor-pointer text-muted">Whole event (Extended JSON)</summary>
        <pre className="mt-1 max-h-72 overflow-auto rounded border border-border bg-panel-2 p-2 font-mono select-text">
          {JSON.stringify(JSON.parse(change.event), null, 2)}
        </pre>
      </details>
    </>
  );
}
