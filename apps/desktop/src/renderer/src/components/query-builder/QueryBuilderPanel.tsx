import { useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';

import { useConnections } from '../../state/connections';
import { cachedProfile, useSettings } from '../../state/data';
import { useBuilderState, type QueryBuilder } from '../../state/query-builder/builder';
import { useQueryBuilders } from '../../state/query-builder/panels';
import { cancelQuery, runQuery } from '../../state/runner';
import { useWorkspace } from '../../state/workspace';
import { openQueryTab } from '../dock';
import { Results } from '../QueryPanel';
import { useTheme } from '../theme';
import { Button, EnvironmentBadge, Icon, cx } from '../ui';
import { Canvas } from './Canvas';
import { BuilderProvider } from './parts';
import { SidePanels } from './SidePanels';
import { SqlPane } from './SqlPane';
import { TableList } from './TableList';

/**
 * A visual query builder panel (spec §8): the tables of the database on the left, the canvas
 * in the middle, the side panels on the right, and under them the live SQL beside the results.
 * Run executes the SQL as the query tabs do, into the same result grid; "Open in editor" copies
 * it into a new SQL tab.
 */
export function QueryBuilderPanel(props: { readonly panelId: string }) {
  const { panelId } = props;
  const builder = useQueryBuilders((state) => state.builders[panelId]);
  const tab = useWorkspace((state) => state.tabs[panelId]);
  const theme = useTheme();
  const settings = useSettings();
  const [split, setSplit] = useState(0.6);
  const area = useRef<HTMLDivElement>(null);
  const flush = useRef<(() => void) | undefined>(undefined);
  if (!builder || !tab) return null;

  const run = (): void => {
    flush.current?.();
    if (builder.blockingIssue) return;
    void runQuery(panelId, 'all');
  };

  const startResize = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const box = area.current?.getBoundingClientRect();
    if (!box) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const move = (e: PointerEvent): void => {
      setSplit(Math.min(0.85, Math.max(0.2, (e.clientY - box.top) / box.height)));
    };
    const up = (): void => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  return (
    <BuilderProvider value={builder}>
      <div className="flex h-full flex-col bg-bg" data-testid="query-builder">
        <Toolbar builder={builder} panelId={panelId} onRun={run} flush={() => flush.current?.()} />
        <SyncBanner builder={builder} />
        <div ref={area} className="flex min-h-0 flex-1 flex-col">
          <div style={{ height: `${split * 100}%` }} className="flex min-h-0">
            <div className="w-48 shrink-0 border-r border-border bg-panel">
              <TableList />
            </div>
            <div className="relative min-w-0 flex-1">
              <Canvas theme={theme} />
              <IssuesBar builder={builder} />
            </div>
            <div className="w-80 shrink-0 border-l border-border bg-panel">
              <SidePanels />
            </div>
          </div>
          <div
            role="separator"
            aria-orientation="horizontal"
            aria-label="Resize the builder and the SQL"
            className="h-1 cursor-row-resize border-y border-border bg-panel hover:bg-accent/40"
            onPointerDown={startResize}
          />
          <div className="flex min-h-0 flex-1">
            <section
              aria-label="SQL"
              className="flex w-[45%] min-w-0 flex-col border-r border-border"
            >
              <h2 className="border-b border-border bg-panel px-2 py-1 text-[11px] font-semibold tracking-wide text-muted uppercase">
                SQL
              </h2>
              <div className="min-h-0 flex-1">
                <SqlPane
                  panelId={panelId}
                  theme={theme}
                  fontSize={settings.data?.editor.fontSize ?? 13}
                  onRun={run}
                  flushRef={flush}
                />
              </div>
            </section>
            <section aria-label="Results" className="min-w-0 flex-1">
              <Results tab={tab} theme={theme} dialect={builder.target.dialect} />
            </section>
          </div>
        </div>
        <Footer builder={builder} />
      </div>
    </BuilderProvider>
  );
}

function Toolbar(props: {
  readonly builder: QueryBuilder;
  readonly panelId: string;
  readonly onRun: () => void;
  readonly flush: () => void;
}) {
  const { builder, panelId } = props;
  const tab = useWorkspace((state) => state.tabs[panelId]);
  const blocking = useBuilderState(builder, () => builder.blockingIssue);
  const hasTables = useBuilderState(builder, (state) => state.model.tables.length > 0);
  const readOnly = useBuilderState(builder, (state) => state.sync.status !== 'synced');
  const running = tab?.running === true;
  return (
    <div
      role="toolbar"
      aria-label="Query builder"
      className="flex flex-wrap items-center gap-1.5 border-b border-border bg-panel px-2 py-1.5"
    >
      <Button
        size="sm"
        variant="primary"
        onClick={props.onRun}
        disabled={running || blocking !== undefined}
        title={
          blocking
            ? `Fix this first: ${blocking.message}`
            : 'Run the query (Ctrl/Cmd+Enter in the SQL)'
        }
      >
        <Icon name="play" className="h-3.5 w-3.5" />
        Run
      </Button>
      <Button
        size="sm"
        variant={running ? 'danger' : 'secondary'}
        onClick={() => void cancelQuery(panelId)}
        disabled={!running || tab?.cancelling === true}
      >
        <Icon name="stop" className="h-3.5 w-3.5" />
        {tab?.cancelling ? 'Cancelling…' : 'Cancel'}
      </Button>
      <Button
        size="sm"
        onClick={() => {
          props.flush();
          openQueryTab({
            profileId: builder.target.profileId,
            title: `${cachedProfile(builder.target.profileId)?.name ?? 'Query'} (from builder)`,
            text: builder.state.sql,
            ...(builder.target.database === undefined ? {} : { database: builder.target.database }),
          });
        }}
        title="Open the SQL in a new SQL tab"
      >
        Open in editor
      </Button>
      <Button
        size="sm"
        variant="ghost"
        onClick={() => builder.requestLayout()}
        disabled={!hasTables}
        title="Arrange the tables automatically"
      >
        Auto layout
      </Button>
      <span className="flex-1" />
      {readOnly && (
        <span className="rounded bg-warning/15 px-1.5 py-0.5 text-[11px] font-semibold text-warning">
          Read-only
        </span>
      )}
      {running && (
        <span className="text-xs text-muted" aria-live="polite">
          Running…
        </span>
      )}
    </div>
  );
}

/** Why the builder does not follow the SQL, with the way back to the builder's own query. */
function SyncBanner({ builder }: { readonly builder: QueryBuilder }) {
  const sync = useBuilderState(builder, (state) => state.sync);
  if (sync.status === 'synced') return null;
  return (
    <div
      role="status"
      data-testid="builder-readonly"
      data-kind={sync.status}
      className="flex items-start gap-2 border-b border-warning/30 bg-warning/10 px-3 py-1.5 text-xs text-warning"
    >
      <Icon name="warning" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <span className="flex-1">
        {sync.status === 'unsupported' ? (
          <>
            <strong>Read-only:</strong> {sync.message} The SQL runs as written; the builder follows
            it again once the SQL is back to what it can show.
          </>
        ) : (
          <>
            <strong>The SQL does not parse yet:</strong> {sync.message} The builder shows the last
            query it could read.
          </>
        )}
      </span>
      <Button size="sm" variant="ghost" onClick={() => builder.revertSql()}>
        Back to the builder’s query
      </Button>
    </div>
  );
}

/** The model's problems, errors first. */
function IssuesBar({ builder }: { readonly builder: QueryBuilder }) {
  const issues = useBuilderState(builder, (state) => state.issues);
  const source = useBuilderState(builder, (state) => state.sqlSource);
  if (issues.length === 0 || source === 'editor') return null;
  const sorted = [...issues].sort(
    (a, b) => Number(b.severity === 'error') - Number(a.severity === 'error'),
  );
  return (
    <ul
      data-testid="builder-issues"
      aria-label="Problems"
      className="absolute top-2 right-2 left-2 z-10 flex max-h-24 flex-col gap-0.5 overflow-auto rounded border border-border bg-panel/95 px-2 py-1 text-xs shadow"
    >
      {sorted.map((issue, index) => (
        <li key={index} className={cx(issue.severity === 'error' ? 'text-danger' : 'text-warning')}>
          {issue.message}
        </li>
      ))}
    </ul>
  );
}

function Footer({ builder }: { readonly builder: QueryBuilder }) {
  const profile = cachedProfile(builder.target.profileId);
  const connection = useConnections((state) => state.byProfile[builder.target.profileId]);
  const catalog = useBuilderState(builder, (state) => state.catalog);
  const database = catalog.status === 'ready' ? catalog.catalog.database : builder.target.database;
  return (
    <footer className="flex items-center gap-2 border-t border-border bg-panel px-3 py-0.5 text-[11px] text-muted">
      {profile && (
        <span className="flex items-center gap-1.5">
          <EnvironmentBadge environment={profile.presentation.environment} />
          {profile.name}
        </span>
      )}
      {database !== undefined && <span>· {database}</span>}
      <span className="flex-1" />
      <span>
        {connection?.status === 'ready' ? 'Connected' : (connection?.status ?? 'Not connected')}
      </span>
    </footer>
  );
}
