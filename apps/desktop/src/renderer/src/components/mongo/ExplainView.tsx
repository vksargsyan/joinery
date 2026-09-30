import type { PlanNode } from '@joinery/core';
import type { MongoExplainResult } from '@joinery/ipc';

import { formatCount } from '../../lib/format';
import type { ExplainState } from '../../state/mongo/collection-view';
import { Icon, cx } from '../ui';

/**
 * Visual explain for a MongoDB query (spec §9): the totals (returned, keys and documents
 * examined, time, indexes used) and the plan as a tree of stages with their index, rows and
 * time. A collection scan is highlighted, as is the plan that has one.
 */
export function ExplainView(props: { readonly explain: ExplainState | undefined }) {
  const { explain } = props;
  if (!explain) {
    return (
      <p className="p-4 text-sm text-muted">Run Explain to see how the server runs the query.</p>
    );
  }
  if (explain.loading) return <p className="p-4 text-sm text-muted">Explaining…</p>;
  if (explain.error) {
    return (
      <p role="alert" className="p-4 text-sm text-danger">
        {explain.error}
      </p>
    );
  }
  const result = explain.result;
  if (!result) return null;
  return (
    <div className="h-full overflow-auto p-3 text-xs" data-testid="mongo-explain">
      <Summary result={result} verbosity={explain.verbosity} />
      <ol className="mt-3 font-mono" aria-label="Plan">
        <PlanStage node={result.plan} depth={0} />
      </ol>
      <details className="mt-4">
        <summary className="cursor-pointer text-muted">Raw explain output</summary>
        <pre className="mt-2 max-h-96 overflow-auto rounded border border-border bg-panel-2 p-2 select-text">
          {prettyJson(result.raw)}
        </pre>
      </details>
    </div>
  );
}

function prettyJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

function Summary(props: { readonly result: MongoExplainResult; readonly verbosity: string }) {
  const { summary } = props.result;
  const figures: [string, string][] = [
    ['Returned', summary.nReturned === undefined ? '–' : formatCount(summary.nReturned)],
    [
      'Keys examined',
      summary.totalKeysExamined === undefined ? '–' : formatCount(summary.totalKeysExamined),
    ],
    [
      'Docs examined',
      summary.totalDocsExamined === undefined ? '–' : formatCount(summary.totalDocsExamined),
    ],
    ['Time', summary.executionTimeMillis === undefined ? '–' : `${summary.executionTimeMillis} ms`],
  ];
  return (
    <div className="flex flex-col gap-2">
      {summary.collectionScan ? (
        <p
          role="status"
          data-testid="explain-collscan"
          className="flex items-center gap-2 rounded border border-danger/50 bg-danger/10 px-2 py-1.5 text-danger"
        >
          <Icon name="warning" className="h-3.5 w-3.5" />
          COLLSCAN: the query reads every document of the collection. An index on the filtered or
          sorted fields avoids that.
        </p>
      ) : (
        <p
          role="status"
          data-testid="explain-indexed"
          className="rounded border border-success/40 bg-success/10 px-2 py-1.5 text-success"
        >
          Uses {summary.indexes.length === 1 ? 'index' : 'indexes'}{' '}
          <span className="font-mono font-semibold">{summary.indexes.join(', ') || '(none)'}</span>
        </p>
      )}
      <dl className="grid grid-cols-4 gap-2">
        {figures.map(([label, value]) => (
          <div key={label} className="rounded border border-border bg-panel-2 px-2 py-1">
            <dt className="text-[11px] text-muted">{label}</dt>
            <dd
              className="font-mono text-sm"
              data-testid={`explain-${label.toLowerCase().replace(/ /g, '-')}`}
            >
              {value}
            </dd>
          </div>
        ))}
      </dl>
      <p className="text-[11px] text-muted">
        {props.verbosity === 'queryPlanner'
          ? 'Query planner only: the query was not run, so there are no counts.'
          : 'Execution statistics: the query ran on the server to measure it.'}
      </p>
    </div>
  );
}

const SHOWN_DETAIL = [
  'keysExamined',
  'docsExamined',
  'keyPattern',
  'filter',
  'sortPattern',
  'direction',
];

function PlanStage(props: { readonly node: PlanNode; readonly depth: number }) {
  const { node } = props;
  const scan = node.detail['collectionScan'] === true;
  return (
    <li>
      <div
        className={cx(
          'mb-1 rounded border px-2 py-1',
          scan ? 'border-danger/60 bg-danger/10' : 'border-border bg-panel-2',
        )}
        style={{ marginLeft: props.depth * 18 }}
        data-testid="explain-stage"
        data-stage={node.operation}
      >
        <div className="flex flex-wrap items-center gap-2">
          <span className={cx('font-semibold', scan && 'text-danger')}>{node.operation}</span>
          {node.index && (
            <span className="rounded bg-accent/15 px-1 text-accent" title="Index">
              {node.index}
            </span>
          )}
          {node.relation && <span className="text-muted">{node.relation}</span>}
          <span className="flex-1" />
          {node.actualRows !== undefined && <span>{formatCount(node.actualRows)} returned</span>}
          {node.actualTimeMs !== undefined && (
            <span className="text-muted">{node.actualTimeMs} ms</span>
          )}
        </div>
        <div className="mt-0.5 flex flex-wrap gap-x-3 text-[11px] text-muted">
          {SHOWN_DETAIL.filter((key) => node.detail[key] !== undefined).map((key) => (
            <span key={key}>
              {key}: <span className="text-fg">{String(node.detail[key])}</span>
            </span>
          ))}
        </div>
      </div>
      {node.children.length > 0 && (
        <ol>
          {node.children.map((child) => (
            <PlanStage key={child.id} node={child} depth={props.depth + 1} />
          ))}
        </ol>
      )}
    </li>
  );
}
