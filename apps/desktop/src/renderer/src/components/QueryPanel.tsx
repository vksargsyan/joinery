import { hasWeakTls, isSqlEngine, type SqlDialect } from '@joinery/core';
import { analyzeStatement } from '@joinery/sql-tools';
import { Tabs } from 'radix-ui';
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';

import { formatCount, formatRows } from '../lib/format';
import { dismissRestored, useRestored } from '../state/autosave';
import { connect, useConnections } from '../state/connections';
import { cachedProfile, useProfiles, useSettings } from '../state/data';
import { explainQuery } from '../state/explain/run';
import { openQueryBuilderFromTab } from '../state/query-builder/panels';
import { naturalLayout, reconcileLayout } from '../state/grid-layout';
import { resultSource } from '../state/result-sources';
import { cancelQuery, commit, fetchMore, rollback, runQuery, setAutoCommit } from '../state/runner';
import { openExportQuery } from '../state/transfer-dialogs';
import {
  patchResult,
  patchTab,
  runtimeOf,
  useWorkspace,
  type MessageEntry,
  type QueryTab,
} from '../state/workspace';
import { takePendingRun } from './dock';
import { PlanView } from './explain/PlanView';
import { disposeModel, QueryEditor } from './QueryEditor';
import { resultColumnKeys, ResultGrid } from './ResultGrid';
import { ColumnsPopover } from './table/ColumnMenus';
import { Button, cx, EnvironmentBadge, Icon, TAB } from './ui';
import { useTheme } from './theme';

/**
 * One query tab (spec §6): toolbar, editor and the result area (one tab per result set plus
 * Messages), with the transaction controls and the lost-connection banner.
 */
export function QueryPanel(props: { readonly tabId: string }) {
  const { tabId } = props;
  const tab = useWorkspace((state) => state.tabs[tabId]);
  const profiles = useProfiles();
  const profile = profiles.data?.find((p) => p.id === tab?.profileId);
  const connection = useConnections((state) => (tab ? state.byProfile[tab.profileId] : undefined));
  const settings = useSettings();
  const theme = useTheme();
  const restored = useRestored((state) => state.tabs[tabId]);
  const [split, setSplit] = useState(0.45);
  const area = useRef<HTMLDivElement>(null);

  useEffect(() => () => disposeModel(tabId), [tabId]);

  if (!tab) return null;
  if (!profile) {
    return <div className="p-4 text-sm text-muted">The connection of this tab was deleted.</div>;
  }
  if (!isSqlEngine(profile.engine)) {
    return <div className="p-4 text-sm text-muted">Query tabs are for SQL connections.</div>;
  }
  const dialect = profile.engine;

  const startResize = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const box = area.current?.getBoundingClientRect();
    if (!box) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const move = (e: PointerEvent): void => {
      setSplit(Math.min(0.85, Math.max(0.15, (e.clientY - box.top) / box.height)));
    };
    const up = (): void => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const lost = connection?.status === 'lost' || connection?.status === 'failed';

  return (
    <div className="flex h-full flex-col bg-bg" data-testid="query-panel">
      <Toolbar
        tab={tab}
        canAnalyze={connection?.info?.capabilities.explainFormats.includes('analyze') ?? true}
      />
      {lost && (
        <div
          role="alert"
          data-testid="connection-lost"
          className="flex items-center gap-3 border-b border-danger/40 bg-danger/10 px-3 py-1.5 text-[13px] text-danger"
        >
          <Icon name="warning" />
          <span className="flex-1">{connection.error ?? 'The connection was lost.'}</span>
          <Button
            size="sm"
            variant="danger"
            onClick={() => void connect(tab.profileId).catch(() => undefined)}
          >
            Reconnect
          </Button>
        </div>
      )}
      {restored && (
        <div
          role="status"
          data-testid="restored-banner"
          className="flex items-center gap-2 border-b border-accent/30 bg-accent/10 px-3 py-1 text-xs"
        >
          <span className="flex-1">
            {restored.afterCrash
              ? 'Joinery closed unexpectedly. This tab was restored from its autosave'
              : 'This tab was restored from the last session'}{' '}
            (saved at {new Date(restored.savedAt).toLocaleTimeString()}). Results are not kept.
          </span>
          <Button size="sm" variant="ghost" onClick={() => dismissRestored(tabId)}>
            Dismiss
          </Button>
        </div>
      )}
      {hasWeakTls(profile) && (
        <div className="flex items-center gap-2 border-b border-warning/30 bg-warning/10 px-3 py-1 text-xs text-warning">
          <Icon name="warning" className="h-3.5 w-3.5" />
          {profile.tls.mode === 'disable'
            ? 'TLS is disabled for this connection: traffic is not encrypted.'
            : 'The server certificate is not fully verified for this connection.'}
        </div>
      )}
      <div ref={area} className="flex min-h-0 flex-1 flex-col">
        <div style={{ height: `${split * 100}%` }} className="min-h-0">
          <QueryEditor
            tabId={tabId}
            dialect={dialect}
            theme={theme}
            fontSize={settings.data?.editor.fontSize ?? 13}
            minimap={settings.data?.editor.minimap ?? false}
            onReady={() => {
              if (takePendingRun(tabId)) void runQuery(tabId, 'all');
            }}
          />
        </div>
        <div
          role="separator"
          aria-orientation="horizontal"
          aria-label="Resize editor and results"
          className="h-1 cursor-row-resize border-y border-border bg-panel hover:bg-focus"
          onPointerDown={startResize}
        />
        <div className="min-h-0 flex-1">
          <Results tab={tab} theme={theme} dialect={dialect} />
        </div>
      </div>
      <footer className="flex h-[22px] shrink-0 items-center gap-2 border-t border-border bg-panel px-2 text-xs text-muted">
        <span className="flex items-center gap-1.5">
          <EnvironmentBadge environment={profile.presentation.environment} />
          {profile.name}
        </span>
        {connection?.info && <span>· {connection.info.serverVersion}</span>}
        <span className="flex-1" />
        <span>
          {connection?.status === 'ready' ? 'Connected' : (connection?.status ?? 'Not connected')}
        </span>
      </footer>
    </div>
  );
}

function Toolbar({ tab, canAnalyze }: { readonly tab: QueryTab; readonly canAnalyze: boolean }) {
  const runSelectionOrStatement = (): void => {
    const selection = runtimeOf(tab.id).editor?.selection();
    void runQuery(tab.id, selection ? 'selection' : 'statement');
  };
  return (
    <div
      className="flex flex-wrap items-center gap-1.5 border-b border-border bg-panel px-2 py-1.5"
      role="toolbar"
      aria-label="Query"
    >
      <Button
        size="sm"
        variant="primary"
        onClick={runSelectionOrStatement}
        disabled={tab.running}
        title="Run the selection, or the statement at the cursor (Ctrl/Cmd+Enter)"
      >
        <Icon name="play" className="h-3.5 w-3.5" />
        Run
      </Button>
      <Button
        size="sm"
        onClick={() => void runQuery(tab.id, 'all')}
        disabled={tab.running}
        title="Run every statement (Ctrl/Cmd+Shift+Enter)"
      >
        <Icon name="play-all" className="h-3.5 w-3.5" />
        Run all
      </Button>
      <Button
        size="sm"
        onClick={() => void explainQuery(tab.id, { analyze: false })}
        disabled={tab.running}
        title="Show the plan of the selection, or the statement at the cursor (Ctrl/Cmd+E)"
      >
        Explain
      </Button>
      <Button
        size="sm"
        onClick={() => void explainQuery(tab.id, { analyze: true })}
        disabled={tab.running || !canAnalyze}
        title={
          canAnalyze
            ? 'Run the statement and show the measured plan; changes are rolled back (Ctrl/Cmd+Shift+E)'
            : 'This server version cannot EXPLAIN ANALYZE'
        }
      >
        Explain Analyze
      </Button>
      <Button
        size="sm"
        variant={tab.running ? 'danger' : 'secondary'}
        onClick={() => void cancelQuery(tab.id)}
        disabled={!tab.running || tab.cancelling || tab.explain?.status === 'running'}
        title="Cancel the running statement"
      >
        <Icon name="stop" className="h-3.5 w-3.5" />
        {tab.cancelling ? 'Cancelling…' : 'Cancel'}
      </Button>
      <Button
        size="sm"
        variant="ghost"
        onClick={() => runtimeOf(tab.id).editor?.format()}
        title="Format the SQL (Shift+Alt+F)"
      >
        <Icon name="format" className="h-3.5 w-3.5" />
        Format
      </Button>
      <Button
        size="sm"
        variant="ghost"
        onClick={() => openQueryBuilderFromTab(tab.id)}
        title="Open the selection, or the statement at the cursor, in the visual query builder"
      >
        Open in query builder
      </Button>
      <span className="mx-1 h-5 w-px bg-border" />
      <label className="flex items-center gap-1.5 text-xs" title="Commit after every statement">
        <input
          type="checkbox"
          checked={tab.autoCommit}
          disabled={tab.running}
          onChange={(event) => void setAutoCommit(tab.id, event.target.checked)}
        />
        Auto-commit
      </label>
      <Button
        size="sm"
        onClick={() => void commit(tab.id)}
        disabled={tab.running || !tab.inTransaction}
      >
        Commit
      </Button>
      <Button
        size="sm"
        onClick={() => void rollback(tab.id)}
        disabled={tab.running || !tab.inTransaction}
      >
        Rollback
      </Button>
      {tab.inTransaction && (
        <span
          data-testid="transaction-badge"
          className="rounded bg-warning/20 px-1.5 py-0.5 text-[11px] font-semibold text-warning"
        >
          Transaction open
        </span>
      )}
      <span className="flex-1" />
      {tab.running && (
        <span className="text-xs text-muted" aria-live="polite">
          Running…
        </span>
      )}
    </div>
  );
}

/** The result sets, plan and messages of a query tab (also shown under a query builder). */
export function Results({
  tab,
  theme,
  dialect,
}: {
  readonly tab: QueryTab;
  readonly theme: 'dark' | 'light';
  readonly dialect: SqlDialect;
}) {
  const errors = tab.messages.filter((m) => m.kind === 'error').length;
  return (
    <Tabs.Root
      value={tab.activePane}
      onValueChange={(value) => patchTab(tab.id, { activePane: value })}
      className="flex h-full flex-col"
    >
      <Tabs.List
        aria-label="Results"
        className="flex shrink-0 items-center gap-0.5 overflow-x-auto border-b border-border bg-panel px-1"
      >
        {tab.results.map((result) => (
          <Tabs.Trigger key={result.id} value={result.id} className={TAB}>
            {result.title}
          </Tabs.Trigger>
        ))}
        {tab.explain && (
          <Tabs.Trigger value="plan" className={TAB}>
            {tab.explain.analyze ? 'Plan (analyzed)' : 'Plan'}
          </Tabs.Trigger>
        )}
        <Tabs.Trigger value="messages" className={TAB}>
          Messages
          {errors > 0 && (
            <span className="ml-1 rounded bg-danger/20 px-1 text-danger">{errors}</span>
          )}
        </Tabs.Trigger>
      </Tabs.List>
      {tab.results.map((result) => (
        <Tabs.Content key={result.id} value={result.id} className="flex min-h-0 flex-1 flex-col">
          <div className="min-h-0 flex-1">
            <ResultGrid
              view={result}
              theme={theme}
              onLayoutChange={(layout) => patchResult(tab.id, result.id, { layout })}
            />
          </div>
          <div className="flex items-center gap-2 border-t border-border bg-panel px-2 py-1 text-xs">
            <span data-testid="row-count" aria-live="polite">
              {formatRows(result.rowCount)}
            </span>
            {result.hasMore && (
              <span className="text-muted" data-testid="more-available">
                · more available
              </span>
            )}
            {result.truncated && (
              <span className="text-muted">
                · stopped at the row limit (run it alone to fetch more)
              </span>
            )}
            {result.fetching && <span className="text-muted">· fetching…</span>}
            <span className="flex-1" />
            <ColumnsPopover
              layout={reconcileLayout(result.layout, resultColumnKeys(result))}
              label={(key) => result.columns[Number(key)]?.name ?? key}
              onChange={(layout) => patchResult(tab.id, result.id, { layout })}
              onReset={() =>
                patchResult(tab.id, result.id, {
                  layout: naturalLayout(resultColumnKeys(result)),
                })
              }
            />
            <ExportResultsButton resultId={result.id} profileId={tab.profileId} />
            {result.hasMore && (
              <>
                <Button
                  size="sm"
                  onClick={() => void fetchMore(tab.id, false)}
                  disabled={tab.running}
                >
                  Fetch more ({formatCount(tab.rowLimit)})
                </Button>
                <Button
                  size="sm"
                  onClick={() => void fetchMore(tab.id, true)}
                  disabled={tab.running}
                >
                  Fetch all
                </Button>
              </>
            )}
          </div>
        </Tabs.Content>
      ))}
      {tab.explain && (
        <Tabs.Content value="plan" className="min-h-0 flex-1">
          <PlanView tabId={tab.id} explain={tab.explain} dialect={dialect} />
        </Tabs.Content>
      )}
      <Tabs.Content value="messages" className="min-h-0 flex-1 overflow-auto">
        <Messages tab={tab} />
      </Tabs.Content>
    </Tabs.Root>
  );
}

/**
 * "Export results…": the statement runs again in the job runner, every row to a file. Not for
 * a statement that writes (DELETE … RETURNING): running it again would write again.
 */
function ExportResultsButton(props: { readonly resultId: string; readonly profileId: string }) {
  const source = resultSource(props.resultId);
  const profile = cachedProfile(props.profileId);
  if (!source || !profile || !isSqlEngine(profile.engine)) return null;
  if (analyzeStatement(source.text, profile.engine).isWrite) return null;
  return (
    <Button
      size="sm"
      variant="ghost"
      onClick={() => openExportQuery(profile, source)}
      title="Run the statement again and write every row to a file"
    >
      Export results…
    </Button>
  );
}

function Messages({ tab }: { readonly tab: QueryTab }) {
  if (tab.messages.length === 0) {
    return <p className="p-3 text-xs text-muted">Run a statement to see its messages here.</p>;
  }
  const reveal = (message: MessageEntry): void => {
    if (!message.range) return;
    patchTab(tab.id, {
      errorMarker:
        message.kind === 'error' ? { ...message.range, message: message.text } : undefined,
    });
    runtimeOf(tab.id).editor?.focus();
  };
  return (
    <ol
      className="flex flex-col divide-y divide-border font-mono text-xs"
      data-testid="messages"
      aria-live="polite"
    >
      {tab.messages.map((message) => (
        <li
          key={message.id}
          className={cx(
            'px-3 py-1.5',
            message.kind === 'error' && 'text-danger',
            message.kind === 'warning' && 'text-warning',
            message.kind === 'success' && 'text-fg',
            (message.kind === 'info' || message.kind === 'notice') && 'text-muted',
            message.range && 'cursor-pointer hover:bg-hover',
          )}
          onClick={() => reveal(message)}
        >
          <span className="mr-2 text-muted">{new Date(message.at).toLocaleTimeString()}</span>
          <span className="whitespace-pre-wrap">{message.text}</span>
          {message.detail && (
            <p className="mt-0.5 whitespace-pre-wrap text-muted">{message.detail}</p>
          )}
        </li>
      ))}
    </ol>
  );
}
