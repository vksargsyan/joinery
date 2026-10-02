import type { ExplainResult, SqlDialect } from '@joinery/core';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';

import { copyToClipboard } from '../../lib/clipboard';
import {
  buildPlanModel,
  formatPlanNumber,
  formatPlanTime,
  shareOf,
  visibleRows,
  type PlanModel,
  type PlanRow,
} from '../../state/explain/model';
import { setExplainBuffers } from '../../state/explain/run';
import type { ExplainTabState } from '../../state/workspace';
import { Button, Icon, cx } from '../ui';
import { PlanDetails } from './PlanDetails';

/**
 * The visual explain of a query tab (spec §6): a summary (planning and execution time, cost,
 * rows, misestimates), the plan as a tree with each node's operation, relation, cost, estimated
 * and actual rows (misestimates flagged), time, loops and buffers, the slowest (or, unanalyzed,
 * most expensive) node highlighted, a details pane for the selected node, and the server's raw
 * output. Styled like the MongoDB explain view.
 */
export function PlanView(props: {
  readonly tabId: string;
  readonly explain: ExplainTabState | undefined;
  readonly dialect: SqlDialect;
}) {
  const { explain, dialect, tabId } = props;
  if (!explain) {
    return (
      <p className="p-4 text-sm text-muted">
        Explain (Ctrl/Cmd+E) shows how the server plans the statement at the cursor; Explain Analyze
        (Ctrl/Cmd+Shift+E) runs it to measure each step.
      </p>
    );
  }
  if (explain.status === 'running') {
    return (
      <p className="p-4 text-sm text-muted" role="status" data-testid="plan-running">
        {explain.analyze
          ? 'Analyzing: the statement runs, then its changes are rolled back…'
          : 'Explaining…'}
      </p>
    );
  }
  if (explain.status === 'error' || !explain.result) {
    return (
      <p role="alert" className="p-4 text-sm text-danger" data-testid="plan-error">
        {explain.error ?? 'The statement could not be explained.'}
      </p>
    );
  }
  return (
    <LoadedPlan
      key={explain.at}
      tabId={tabId}
      result={explain.result}
      analyze={explain.analyze}
      buffers={explain.buffers}
      dialect={dialect}
    />
  );
}

function LoadedPlan(props: {
  readonly tabId: string;
  readonly result: ExplainResult;
  readonly analyze: boolean;
  readonly buffers: boolean;
  readonly dialect: SqlDialect;
}) {
  const { result } = props;
  const model = useMemo(() => buildPlanModel(result.plan), [result]);
  const [mode, setMode] = useState<'tree' | 'raw'>('tree');
  const [selected, setSelected] = useState(model.hottestId ?? result.plan.id);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const rows = useMemo(() => visibleRows(model, collapsed), [model, collapsed]);
  const selectedRow = model.byId.get(selected) ?? model.rows[0]!;

  return (
    <div className="flex h-full flex-col text-xs" data-testid="sql-plan">
      <Summary
        model={model}
        result={result}
        onSelectHottest={() => model.hottestId && setSelected(model.hottestId)}
      />
      <div className="flex items-center gap-2 border-b border-border bg-panel px-2 py-1">
        <div className="flex rounded border border-border" role="radiogroup" aria-label="Plan view">
          {(['tree', 'raw'] as const).map((option) => (
            <button
              key={option}
              type="button"
              role="radio"
              aria-checked={mode === option}
              className={cx(
                'px-2 py-0.5 text-xs',
                mode === option ? 'bg-badge text-fg' : 'text-muted hover:bg-hover',
              )}
              onClick={() => setMode(option)}
            >
              {option === 'tree' ? 'Plan' : result.rawFormat === 'json' ? 'Raw JSON' : 'Raw text'}
            </button>
          ))}
        </div>
        {props.dialect === 'postgres' && (
          <label
            className="flex items-center gap-1.5 text-muted"
            title="Report shared, local and temporary blocks read and written (EXPLAIN BUFFERS) with the next Explain Analyze"
          >
            <input
              type="checkbox"
              checked={props.buffers}
              onChange={(event) => setExplainBuffers(props.tabId, event.target.checked)}
            />
            Buffers
          </label>
        )}
        <span className="flex-1" />
        {mode === 'tree' && (
          <>
            <Button size="sm" variant="ghost" onClick={() => setCollapsed(new Set())}>
              Expand all
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() =>
                setCollapsed(
                  new Set(
                    model.rows
                      .filter((r) => r.node.children.length > 0 && r.depth > 0)
                      .map((r) => r.node.id),
                  ),
                )
              }
            >
              Collapse
            </Button>
          </>
        )}
        {mode === 'raw' && (
          <Button size="sm" variant="ghost" onClick={() => copyToClipboard(rawText(result))}>
            Copy
          </Button>
        )}
      </div>
      {mode === 'raw' ? (
        <pre
          className="min-h-0 flex-1 overflow-auto bg-panel-2 p-2 font-mono text-[11px] select-text"
          data-testid="plan-raw"
        >
          {rawText(result)}
        </pre>
      ) : (
        <div className="flex min-h-0 flex-1">
          <PlanTree
            model={model}
            rows={rows}
            selected={selectedRow.node.id}
            collapsed={collapsed}
            onSelect={setSelected}
            onToggle={(id) =>
              setCollapsed((current) => {
                const next = new Set(current);
                if (next.has(id)) next.delete(id);
                else next.add(id);
                return next;
              })
            }
          />
          <PlanDetails row={selectedRow} model={model} />
        </div>
      )}
    </div>
  );
}

function rawText(result: ExplainResult): string {
  if (result.rawFormat !== 'json') return result.raw;
  try {
    return JSON.stringify(JSON.parse(result.raw), null, 2);
  } catch {
    return result.raw;
  }
}

function Summary(props: {
  readonly model: PlanModel;
  readonly result: ExplainResult;
  readonly onSelectHottest: () => void;
}) {
  const { model, result } = props;
  const { summary } = model;
  const hottest = model.hottestId === undefined ? undefined : model.byId.get(model.hottestId);
  const figures: [string, string][] = [
    ['Planning', summary.planningMs === undefined ? '–' : formatPlanTime(summary.planningMs)],
    ['Execution', summary.executionMs === undefined ? '–' : formatPlanTime(summary.executionMs)],
    ['Total cost', summary.totalCost === undefined ? '–' : formatPlanNumber(summary.totalCost)],
    [
      model.analyzed ? 'Rows' : 'Rows (est.)',
      summary.rows === undefined ? '–' : formatPlanNumber(summary.rows),
    ],
    ['Misestimates', String(summary.misestimates)],
  ];
  return (
    <div className="flex flex-col gap-2 border-b border-border p-2">
      <div className="flex flex-wrap items-center gap-2">
        <span
          data-testid="plan-kind"
          className={cx(
            'rounded px-1.5 py-0.5 text-[11px] font-semibold',
            model.analyzed ? 'bg-accent/15 text-accent' : 'bg-panel-2 text-muted',
          )}
        >
          {model.analyzed ? 'Analyzed' : 'Estimated plan'}
        </span>
        {result.rolledBack && (
          <span className="text-[11px] text-muted" data-testid="plan-rolled-back">
            The statement ran inside a transaction that was rolled back.
          </span>
        )}
        {summary.analyzeUnavailable && (
          <span className="flex items-center gap-1 text-[11px] text-warning">
            <Icon name="warning" className="h-3.5 w-3.5" />
            The server cannot analyze this statement; this is its estimated plan.
          </span>
        )}
      </div>
      {hottest && (
        <button
          type="button"
          onClick={props.onSelectHottest}
          data-testid="plan-hottest"
          className="flex items-center gap-2 self-start rounded border border-danger/50 bg-danger/10 px-2 py-1 text-left text-danger"
        >
          <Icon name="warning" className="h-3.5 w-3.5" />
          {model.hottestBy === 'time' ? 'Slowest step' : 'Most expensive step'}:{' '}
          <span className="font-mono font-semibold">
            {hottest.node.operation}
            {hottest.node.relation ? ` on ${hottest.node.relation}` : ''}
          </span>
          <span className="text-danger/80">
            {model.hottestBy === 'time'
              ? `${formatPlanTime(hottest.selfTimeMs ?? 0)} of its own`
              : `cost ${formatPlanNumber(hottest.selfCost ?? 0)} of its own`}
          </span>
        </button>
      )}
      <dl className="grid grid-cols-5 gap-2">
        {figures.map(([label, value]) => (
          <div key={label} className="rounded border border-border bg-panel-2 px-2 py-1">
            <dt className="text-[11px] text-muted">{label}</dt>
            <dd
              className="font-mono text-sm"
              data-testid={`plan-${label
                .toLowerCase()
                .replace(/[^a-z]+/g, '-')
                .replace(/-$/, '')}`}
            >
              {value}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function PlanTree(props: {
  readonly model: PlanModel;
  readonly rows: readonly PlanRow[];
  readonly selected: string;
  readonly collapsed: ReadonlySet<string>;
  readonly onSelect: (id: string) => void;
  readonly onToggle: (id: string) => void;
}) {
  const { model, rows, selected, collapsed } = props;
  const list = useRef<HTMLDivElement>(null);
  const at = rows.findIndex((row) => row.node.id === selected);

  useEffect(() => {
    list.current
      ?.querySelector<HTMLElement>(`[data-node-id="${CSS.escape(selected)}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [selected]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const row = rows[at];
    if (!row) return;
    const hasChildren = row.node.children.length > 0;
    let next: string | undefined;
    switch (event.key) {
      case 'ArrowDown':
        next = rows[Math.min(rows.length - 1, at + 1)]?.node.id;
        break;
      case 'ArrowUp':
        next = rows[Math.max(0, at - 1)]?.node.id;
        break;
      case 'Home':
        next = rows[0]?.node.id;
        break;
      case 'End':
        next = rows.at(-1)?.node.id;
        break;
      case 'ArrowRight':
        if (hasChildren && collapsed.has(row.node.id)) props.onToggle(row.node.id);
        else if (hasChildren) next = row.node.children[0]?.id;
        break;
      case 'ArrowLeft':
        if (hasChildren && !collapsed.has(row.node.id)) props.onToggle(row.node.id);
        else next = row.parentId;
        break;
      default:
        return;
    }
    event.preventDefault();
    if (next !== undefined) props.onSelect(next);
  };

  return (
    <div
      ref={list}
      role="tree"
      aria-label="Plan"
      tabIndex={0}
      onKeyDown={onKeyDown}
      className="min-w-0 flex-1 overflow-auto p-2 font-mono outline-none focus-visible:ring-1 focus-visible:ring-accent"
      aria-activedescendant={`plan-node-${selected}`}
    >
      {rows.map((row) => (
        <PlanNodeRow
          key={row.node.id}
          row={row}
          model={model}
          selected={row.node.id === selected}
          expanded={!collapsed.has(row.node.id)}
          onSelect={() => props.onSelect(row.node.id)}
          onToggle={() => props.onToggle(row.node.id)}
        />
      ))}
    </div>
  );
}

function PlanNodeRow(props: {
  readonly row: PlanRow;
  readonly model: PlanModel;
  readonly selected: boolean;
  readonly expanded: boolean;
  readonly onSelect: () => void;
  readonly onToggle: () => void;
}) {
  const { row, model } = props;
  const { node } = row;
  const hottest = node.id === model.hottestId;
  const share = shareOf(model, row);
  const hasChildren = node.children.length > 0;
  return (
    <div
      id={`plan-node-${node.id}`}
      role="treeitem"
      aria-level={row.depth + 1}
      aria-selected={props.selected}
      {...(hasChildren ? { 'aria-expanded': props.expanded } : {})}
      data-testid="plan-node"
      data-node-id={node.id}
      data-operation={node.operation}
      data-hottest={hottest ? 'true' : undefined}
      onClick={props.onSelect}
      className={cx(
        'mb-1 cursor-default rounded border px-2 py-1',
        hottest ? 'border-danger/60 bg-danger/10' : 'border-border bg-panel-2',
        props.selected && 'ring-1 ring-accent',
        row.neverExecuted && 'opacity-50',
      )}
      style={{ marginLeft: row.depth * 18 }}
    >
      <div className="flex flex-wrap items-center gap-2">
        {hasChildren ? (
          <button
            type="button"
            tabIndex={-1}
            aria-label={props.expanded ? 'Collapse' : 'Expand'}
            className="rounded text-muted hover:text-fg"
            onClick={(event) => {
              event.stopPropagation();
              props.onToggle();
            }}
          >
            <Icon name={props.expanded ? 'chevron-down' : 'chevron-right'} className="h-3 w-3" />
          </button>
        ) : (
          <span className="w-3" />
        )}
        <span className={cx('font-semibold', hottest && 'text-danger')}>{node.operation}</span>
        {node.relation && <span className="text-muted">on {node.relation}</span>}
        {node.index && (
          <span className="rounded bg-accent/15 px-1 text-accent" title="Index">
            {node.index}
          </span>
        )}
        {hottest && (
          <span className="rounded bg-danger/20 px-1 text-[10px] font-semibold text-danger uppercase">
            {model.hottestBy === 'time' ? 'slowest' : 'most expensive'}
          </span>
        )}
        {row.neverExecuted && <span className="text-[11px] text-muted">never executed</span>}
        <span className="flex-1" />
        <Figures row={row} analyzed={model.analyzed} />
      </div>
      {share > 0 && (
        <div className="mt-1 h-1 rounded bg-border" aria-hidden="true">
          <div
            className={cx('h-1 rounded', hottest ? 'bg-danger' : 'bg-accent/60')}
            style={{ width: `${Math.max(2, share * 100)}%` }}
          />
        </div>
      )}
    </div>
  );
}

function Figures({ row, analyzed }: { readonly row: PlanRow; readonly analyzed: boolean }) {
  const { node, misestimate } = row;
  return (
    <span className="flex flex-wrap items-center gap-x-3 text-[11px] text-muted">
      {node.totalCost !== undefined && (
        <span title="Total cost (the node and its inputs)">
          cost <span className="text-fg">{formatPlanNumber(node.totalCost)}</span>
        </span>
      )}
      {node.estimatedRows !== undefined && (
        <span title="Rows the planner expected per loop">
          est <span className="text-fg">{formatPlanNumber(node.estimatedRows)}</span>
        </span>
      )}
      {analyzed && node.actualRows !== undefined && (
        <span title="Rows returned per loop">
          rows <span className="text-fg">{formatPlanNumber(node.actualRows)}</span>
        </span>
      )}
      {misestimate && (
        <span
          data-testid="plan-misestimate"
          className="rounded bg-warning/20 px-1 font-semibold text-warning"
          title={
            misestimate.direction === 'under'
              ? 'More rows than the planner expected'
              : 'Fewer rows than the planner expected'
          }
        >
          {misestimate.direction === 'under' ? '▲' : '▼'} ×
          {formatPlanNumber(Math.round(misestimate.factor))}
        </span>
      )}
      {node.loops !== undefined && node.loops !== 1 && (
        <span title="Times the node ran">
          loops <span className="text-fg">{formatPlanNumber(node.loops)}</span>
        </span>
      )}
      {row.totalTimeMs !== undefined && (
        <span title="Time over every loop, inputs included">
          <span className="text-fg">{formatPlanTime(row.totalTimeMs)}</span>
        </span>
      )}
      {row.buffers?.sharedHit !== undefined && (
        <span title="Shared blocks found in cache / read">
          buf{' '}
          <span className="text-fg">
            {formatPlanNumber(row.buffers.sharedHit)}/
            {formatPlanNumber(row.buffers.sharedRead ?? 0)}
          </span>
        </span>
      )}
    </span>
  );
}
