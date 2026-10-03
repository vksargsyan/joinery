import type { ActionResult, ServerAction, TopQuery, TopQueryOrder } from '@querybara/core';
import { useEffect, useState } from 'react';

import { errorMessage } from '../../lib/errors';
import { formatCell, formatMs, formatNumber } from '../../state/server-tools/format';
import { useServerToolsPanels } from '../../state/server-tools/panels';
import { Notice, Toolbar } from '../redis/common';
import { Button, cx } from '../ui';
import {
  ActionOutcome,
  NoticeList,
  ToolSelect,
  runAction,
  useToolData,
  type TabProps,
} from './common';

/**
 * Top queries (spec §15): pg_stat_statements, the statement digests of performance_schema, or
 * the MongoDB profiler grouped by query shape. When the source is missing or off it says why
 * and how to fix it (and offers the fix when it can run from here: CREATE EXTENSION, the
 * digest consumer, the profiler level).
 */

const ORDER_LABELS: Readonly<Record<TopQueryOrder, string>> = {
  total: 'Total time',
  mean: 'Mean time',
  calls: 'Calls',
  rows: 'Rows',
  max: 'Max time',
};

export function TopQueriesTab({ panelId, info }: TabProps) {
  const mongo = info.engine === 'mongodb';
  const focus = useServerToolsPanels((state) => state.panels[panelId]?.focus);
  const [orderBy, setOrderBy] = useState<TopQueryOrder>('total');
  const [limit, setLimit] = useState(100);
  const [database, setDatabase] = useState<string | undefined>(
    mongo ? (focus?.container ?? undefined) : undefined,
  );
  const [selected, setSelected] = useState<string>();
  const [error, setError] = useState<string>();
  const [result, setResult] = useState<ActionResult>();
  useEffect(() => {
    if (mongo && focus?.container) setDatabase(focus.container);
  }, [mongo, focus?.container]);
  const top = useToolData(
    panelId,
    undefined,
    (host, sessionId) =>
      host.serverTools.topQueries({
        sessionId,
        options: { orderBy, limit, ...(database !== undefined ? { database } : {}) },
      }),
    [orderBy, limit, database],
  );
  const data = top.data;
  const profiler = data?.profiler ?? null;
  const act = async (action: ServerAction, confirmLabel: string): Promise<void> => {
    setError(undefined);
    try {
      const done = await runAction(panelId, action, { confirmLabel });
      if (done) {
        setResult(done);
        await top.reload();
      }
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  const current = data?.queries.find((q) => q.id === selected);

  return (
    <div className="flex h-full flex-col" data-testid="server-top-queries">
      <Toolbar label="Top queries">
        <ToolSelect
          label="Order by"
          value={orderBy}
          onChange={(v) => setOrderBy(v as TopQueryOrder)}
          options={info.topQueryOrders.map((o) => ({ value: o, label: ORDER_LABELS[o] }))}
        />
        <ToolSelect
          label="Show"
          value={String(limit)}
          onChange={(v) => setLimit(Number(v))}
          options={[25, 100, 500].map((n) => ({ value: String(n), label: String(n) }))}
        />
        {mongo && (
          <ToolSelect
            label="Database"
            value={database ?? profiler?.database ?? ''}
            onChange={setDatabase}
            options={info.databases.map((d) => ({ value: d, label: d }))}
          />
        )}
        <Button size="sm" onClick={() => void top.reload()} disabled={top.loading}>
          Refresh
        </Button>
        {profiler && (
          <>
            <span className="text-xs text-muted" data-testid="profiler-level">
              Profiler level {profiler.level}
              {profiler.slowMs !== null ? ` · slowms ${profiler.slowMs}` : ''}
            </span>
            {[0, 1, 2].map((level) => (
              <Button
                key={level}
                size="sm"
                variant="ghost"
                disabled={profiler.level === level}
                onClick={() =>
                  void act(
                    {
                      kind: 'profiler',
                      database: profiler.database,
                      level: level as 0 | 1 | 2,
                      ...(profiler.slowMs !== null ? { slowMs: profiler.slowMs } : {}),
                    },
                    'Set level',
                  )
                }
              >
                {level === 0 ? 'Off' : level === 1 ? 'Slow only' : 'All'}
              </Button>
            ))}
          </>
        )}
        <span className="flex-1" />
        {data?.resettable && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() =>
              void act(
                {
                  kind: 'topQueries',
                  operation: 'reset',
                  ...(mongo && profiler ? { database: profiler.database } : {}),
                },
                'Reset',
              )
            }
          >
            Reset statistics…
          </Button>
        )}
      </Toolbar>
      {(error ?? top.error) && <Notice kind="error">{error ?? top.error}</Notice>}
      {data?.unavailable && (
        <div
          role="status"
          className="flex items-start gap-3 border-b border-warning/30 bg-warning/10 px-3 py-2 text-xs"
          data-testid="top-queries-unavailable"
        >
          <div className="flex-1">
            <p className="font-medium text-warning">{data.unavailable.message}</p>
            {data.unavailable.hint && <p className="mt-0.5 text-muted">{data.unavailable.hint}</p>}
          </div>
          {data.unavailable.fix && (
            <Button size="sm" onClick={() => void act(data.unavailable!.fix!, 'Run')}>
              {data.unavailable.fix.kind === 'profiler' ? 'Turn on the profiler…' : 'Fix it…'}
            </Button>
          )}
        </div>
      )}
      <NoticeList notices={data?.notices ?? []} />
      {result && (
        <ActionOutcome result={result} engine={info.engine} onClose={() => setResult(undefined)} />
      )}
      <div className="min-h-0 flex-1 overflow-auto">
        {data && !data.unavailable && data.queries.length === 0 && (
          <p className="p-4 text-center text-xs text-muted">No statements recorded yet.</p>
        )}
        {data && data.queries.length > 0 && (
          <table
            className="w-full text-xs"
            aria-label="Top queries"
            data-testid="top-queries-table"
          >
            <thead className="sticky top-0 bg-panel text-left text-[11px] text-muted uppercase">
              <tr>
                <th className="px-2 py-1">Statement</th>
                <th className="px-2 py-1">Database</th>
                <th className="px-2 py-1 text-right">Calls</th>
                <th className="px-2 py-1 text-right">Total</th>
                <th className="px-2 py-1 text-right">Mean</th>
                <th className="px-2 py-1 text-right">Max</th>
                <th className="px-2 py-1 text-right">Rows</th>
              </tr>
            </thead>
            <tbody>
              {data.queries.map((q) => (
                <QueryRow
                  key={q.id}
                  query={q}
                  selected={q.id === selected}
                  onSelect={() => setSelected(q.id)}
                />
              ))}
            </tbody>
          </table>
        )}
      </div>
      {current && data && (
        <section
          aria-label="Statement details"
          className="max-h-60 overflow-auto border-t border-border bg-panel px-3 py-2 text-xs"
        >
          <pre className="mb-2 font-mono whitespace-pre-wrap select-text">{current.text}</pre>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
            {current.user && (
              <>
                <dt className="text-muted">User</dt>
                <dd>{current.user}</dd>
              </>
            )}
            {data.detailColumns.map((column) => (
              <div key={column.key} className="contents">
                <dt className="text-muted">{column.label}</dt>
                <dd className="break-all">{formatCell(current.detail[column.key], column.unit)}</dd>
              </div>
            ))}
          </dl>
        </section>
      )}
    </div>
  );
}

function QueryRow(props: {
  readonly query: TopQuery;
  readonly selected: boolean;
  readonly onSelect: () => void;
}) {
  const q = props.query;
  return (
    <tr
      data-testid="top-query-row"
      tabIndex={0}
      aria-selected={props.selected}
      className={cx(
        'cursor-default border-b border-border/50 hover:bg-hover focus:bg-hover focus:outline-none',
        props.selected && 'bg-accent/15',
      )}
      onClick={props.onSelect}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          props.onSelect();
        }
      }}
    >
      <td className="max-w-xl truncate px-2 py-1 font-mono" title={q.text}>
        {q.text}
      </td>
      <td className="px-2 py-1">{q.database ?? '—'}</td>
      <td className="px-2 py-1 text-right tabular-nums">{formatNumber(q.calls)}</td>
      <td className="px-2 py-1 text-right tabular-nums">{formatMs(q.totalMs)}</td>
      <td className="px-2 py-1 text-right tabular-nums">{formatMs(q.meanMs)}</td>
      <td className="px-2 py-1 text-right tabular-nums">
        {q.maxMs === null ? '—' : formatMs(q.maxMs)}
      </td>
      <td className="px-2 py-1 text-right tabular-nums">
        {q.rows === null ? '—' : formatNumber(q.rows)}
      </td>
    </tr>
  );
}
