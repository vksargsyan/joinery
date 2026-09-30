import type { ActionResult, ServerSession } from '@joinery/core';
import { useState } from 'react';

import { errorMessage } from '../../lib/errors';
import { formatCell, formatMs } from '../../state/server-tools/format';
import { canSignal, filterSessions, sessionKey } from '../../state/server-tools/view';
import { Notice, Toolbar, usePolling } from '../redis/common';
import { Button, Input, cx } from '../ui';
import { ActionOutcome, Check, NoticeList, runAction, useToolData, type TabProps } from './common';

/**
 * The session list (spec §15): pg_stat_activity, the process list or $currentOp, filtered and
 * sorted by running time, with cancel and terminate (KILL QUERY / KILL CONNECTION, killOp) after
 * the exact statement is shown. The tools' own session is marked and cannot be signalled.
 */

export function SessionsTab({ panelId, info }: TabProps) {
  const [includeIdle, setIncludeIdle] = useState(true);
  const [includeBackground, setIncludeBackground] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [text, setText] = useState('');
  const [selected, setSelected] = useState<string>();
  const [error, setError] = useState<string>();
  const [result, setResult] = useState<ActionResult>();
  const list = useToolData(
    panelId,
    undefined,
    (host, sessionId) =>
      host.serverTools.sessions({ sessionId, options: { includeIdle, includeBackground } }),
    [includeIdle, includeBackground],
  );
  usePolling(() => void list.reload(), 5_000, !autoRefresh);
  const sessions = filterSessions(list.data?.sessions ?? [], { text });
  const current = sessions.find((s) => sessionKey(s) === selected);

  const signal = async (
    session: ServerSession,
    operation: 'cancel' | 'terminate',
  ): Promise<void> => {
    setError(undefined);
    try {
      const done = await runAction(
        panelId,
        { kind: 'session', operation, id: session.id },
        {
          confirmLabel: info.sessionActions.find((a) => a.operation === operation)?.label ?? 'Run',
        },
      );
      if (done) {
        setResult(done);
        await list.reload();
      }
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  return (
    <div className="flex h-full flex-col" data-testid="server-sessions">
      <Toolbar label="Sessions">
        <Input
          aria-label="Filter sessions"
          placeholder="Filter by user, database, client or query"
          className="h-7 w-72 text-xs"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <Check label="Idle" checked={includeIdle} onChange={setIncludeIdle} />
        <Check label="Background" checked={includeBackground} onChange={setIncludeBackground} />
        <Check label="Auto-refresh" checked={autoRefresh} onChange={setAutoRefresh} />
        <Button size="sm" onClick={() => void list.reload()} disabled={list.loading}>
          Refresh
        </Button>
        <span className="flex-1" />
        {info.sessionActions.map((action) => (
          <Button
            key={action.operation}
            size="sm"
            variant={action.operation === 'terminate' ? 'danger' : 'secondary'}
            disabled={!current || !canSignal(current)}
            title={action.description}
            onClick={() => current && void signal(current, action.operation)}
          >
            {action.label}…
          </Button>
        ))}
      </Toolbar>
      {(error ?? list.error) && <Notice kind="error">{error ?? list.error}</Notice>}
      <NoticeList notices={list.data?.notices ?? []} />
      {result && (
        <ActionOutcome result={result} engine={info.engine} onClose={() => setResult(undefined)} />
      )}
      <div className="min-h-0 flex-1 overflow-auto">
        <table className="w-full text-xs" aria-label="Sessions" data-testid="sessions-table">
          <thead className="sticky top-0 bg-panel text-left text-[11px] text-muted uppercase">
            <tr>
              <th className="px-2 py-1">Id</th>
              <th className="px-2 py-1">User</th>
              <th className="px-2 py-1">Database</th>
              <th className="px-2 py-1">Client</th>
              <th className="px-2 py-1">State</th>
              <th className="px-2 py-1 text-right">Running</th>
              <th className="px-2 py-1">Waiting for</th>
              <th className="px-2 py-1">Query</th>
            </tr>
          </thead>
          <tbody>
            {sessions.map((s) => (
              <tr
                key={sessionKey(s)}
                data-testid="session-row"
                aria-selected={sessionKey(s) === selected}
                tabIndex={0}
                className={cx(
                  'cursor-default border-b border-border/50 hover:bg-hover focus:bg-hover focus:outline-none',
                  sessionKey(s) === selected && 'bg-accent/15',
                )}
                onClick={() => setSelected(sessionKey(s))}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    setSelected(sessionKey(s));
                  }
                }}
              >
                <td className="px-2 py-1 font-mono whitespace-nowrap">
                  {s.id || '—'}
                  {s.own && (
                    <span className="ml-1 rounded bg-panel-2 px-1 text-[10px] text-muted">
                      this tool
                    </span>
                  )}
                </td>
                <td className="px-2 py-1">{s.user ?? '—'}</td>
                <td className="px-2 py-1">{s.database ?? '—'}</td>
                <td className="px-2 py-1 whitespace-nowrap">
                  {s.client ?? '—'}
                  {s.application ? ` · ${s.application}` : ''}
                </td>
                <td className="px-2 py-1 whitespace-nowrap">{s.state ?? '—'}</td>
                <td className="px-2 py-1 text-right tabular-nums whitespace-nowrap">
                  {s.durationMs === null ? '—' : formatMs(s.durationMs)}
                </td>
                <td className="px-2 py-1">
                  {s.wait ?? ''}
                  {s.blockedBy.length > 0 && (
                    <span className="text-warning"> · blocked by {s.blockedBy.join(', ')}</span>
                  )}
                </td>
                <td className="max-w-md truncate px-2 py-1 font-mono" title={s.query ?? undefined}>
                  {s.query ?? ''}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {list.data && sessions.length === 0 && (
          <p className="p-4 text-center text-xs text-muted">No sessions match.</p>
        )}
        {list.data?.truncated && (
          <p className="p-2 text-center text-xs text-muted">Only the first sessions are shown.</p>
        )}
      </div>
      {current && (
        <section
          aria-label="Session details"
          className="max-h-56 overflow-auto border-t border-border bg-panel px-3 py-2 text-xs"
          data-testid="session-details"
        >
          <pre className="mb-2 font-mono whitespace-pre-wrap select-text">
            {current.query ?? ''}
          </pre>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
            {(list.data?.detailColumns ?? []).map((column) => (
              <div key={column.key} className="contents">
                <dt className="text-muted">{column.label}</dt>
                <dd>{formatCell(current.detail[column.key], column.unit)}</dd>
              </div>
            ))}
          </dl>
        </section>
      )}
    </div>
  );
}
