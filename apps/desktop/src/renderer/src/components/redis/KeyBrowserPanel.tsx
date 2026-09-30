import { utf8Bytes } from '@joinery/redis-tools';
import { useCallback, useEffect, useMemo, useRef, useState, type UIEvent } from 'react';

import { errorMessage } from '../../lib/errors';
import { formatCount } from '../../lib/format';
import { destructive } from '../../../../shared/redis-safety';
import {
  KEY_TYPES,
  KeyBrowserController,
  keyTreeRows,
  patternNamespaceIds,
  type KeyRow,
  type KeyTreeRow,
} from '../../state/redis/key-browser';
import {
  emitKeyChange,
  laneSession,
  onKeyChange,
  onPanelDispose,
  openRedisPanel,
  panelLane,
  redisWrite,
  resetPanelLane,
  retargetPanel,
  type RedisPanelTarget,
} from '../../state/redis/panels';
import { formatBytes, formatTtl } from '../../state/redis/value-model';
import { Button, Icon, Input, cx } from '../ui';
import {
  EmptyState,
  NodeSelect,
  Notice,
  Separator,
  Toolbar,
  TypeBadge,
  useConnectionFacts,
} from './common';
import { BulkDeleteDialog, NewKeyDialog } from './KeyDialogs';

/**
 * The key browser (spec §10): SCAN pages (never KEYS) with pattern and type filters, as a
 * namespace tree on the connection's delimiter or a flat list; key, type, TTL and memory columns
 * (MEMORY USAGE only for the rows on screen); "Load more" continues the scan. In Cluster mode it
 * scans every primary, or one node. Bulk delete by pattern counts first, then deletes.
 */

const ROW_HEIGHT = 26;
const OVERSCAN = 12;

export function KeyBrowserPanel(props: {
  readonly panelId: string;
  readonly target: RedisPanelTarget;
}) {
  const { panelId, target } = props;
  const { facts, error: factsError } = useConnectionFacts(target.profileId);
  const [, setVersion] = useState(0);
  const controller = useMemo(
    () =>
      new KeyBrowserController(
        async (query) => {
          const { host, sessionId } = await laneSession(panelLane(panelId));
          return host.redis.scan({
            sessionId,
            pageSize: query.pageSize,
            ...(query.match !== undefined ? { match: query.match } : {}),
            ...(query.type !== undefined ? { type: query.type } : {}),
            ...(query.node !== undefined ? { node: query.node } : {}),
          });
        },
        (keys) =>
          panelLane(panelId).run((host, sessionId) =>
            host.redis.memoryUsage({ sessionId, keys: [...keys] }),
          ),
        () => setVersion((v) => v + 1),
      ),
    [panelId],
  );
  const state = controller.state;
  const [pattern, setPattern] = useState(target.pattern ?? '');
  const [type, setType] = useState('');
  const [dialog, setDialog] = useState<'new' | 'bulk'>();
  const [actionError, setActionError] = useState<string>();
  const delimiter = facts?.info.keyDelimiter ?? ':';
  const cluster = facts?.info.server.clusterMode === true;

  useEffect(() => {
    void controller.reset({ pattern: target.pattern ?? '', type: '', ...nodeOf(target) });
    const stop = onPanelDispose(panelId, () => controller.dispose());
    return () => {
      stop();
      controller.dispose();
    };
    // Scans restart explicitly (filters, database); not on every target change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [controller]);

  useEffect(
    () =>
      onKeyChange((change) => {
        if (change.profileId !== target.profileId) return;
        if (!cluster && (change.database ?? 0) !== (target.database ?? 0)) return;
        if (change.kind === 'deleted') controller.removeKeys([change.key]);
        if (change.kind === 'renamed') controller.removeKeys([change.key]);
        const added = change.kind === 'renamed' ? change.newKey : change.key;
        if (change.kind !== 'deleted' && added) {
          void panelLane(panelId)
            .run((host, sessionId) => host.redis.keyInfo({ sessionId, keys: [added] }))
            .then(([info]) => info && info.kind !== 'none' && controller.upsert(info))
            .catch(() => undefined);
        }
      }),
    [controller, panelId, target.profileId, target.database, cluster],
  );

  // Open the tree down to where the filter points.
  useEffect(() => {
    if (facts) controller.expand(patternNamespaceIds(state.filter.pattern, delimiter));
  }, [controller, facts, delimiter, state.filter.pattern]);

  const applyFilter = (): void => {
    void controller.reset({ pattern, type, ...nodeOf(target) });
  };
  const switchDatabase = (database: number): void => {
    retargetPanel(panelId, { database });
    resetPanelLane(panelId);
    void controller.reset({ pattern, type });
  };
  const switchNode = (node: string | undefined): void => {
    retargetPanel(panelId, node === undefined ? { node: undefined } : { node });
    void controller.reset({ pattern, type, ...(node !== undefined ? { node } : {}) });
  };
  const openKey = (row: KeyRow): void => {
    openRedisPanel({
      profileId: target.profileId,
      profileName: target.profileName,
      tool: 'value',
      key: row.key,
      ...(cluster ? {} : { database: target.database ?? 0 }),
    });
  };
  const deleteKey = async (row: KeyRow): Promise<void> => {
    setActionError(undefined);
    try {
      const done = await redisWrite({
        profileId: target.profileId,
        operation: destructive('deletes the key'),
        title: 'Delete key?',
        commands: [[utf8Bytes('UNLINK'), row.key]],
        confirmLabel: 'Delete',
        run: (confirmed) =>
          panelLane(panelId).run((host, sessionId) =>
            host.redis.key.delete({ sessionId, keys: [row.key], confirmed }),
          ),
      });
      if (done) {
        emitKeyChange({
          profileId: target.profileId,
          database: cluster ? undefined : (target.database ?? 0),
          kind: 'deleted',
          key: row.key,
        });
      }
    } catch (e) {
      setActionError(errorMessage(e));
    }
  };

  const fetchMemory = useCallback(
    (ids: string[]): void => void controller.fetchMemory(ids),
    [controller],
  );

  const treeRows = useMemo(
    () =>
      state.view === 'tree'
        ? keyTreeRows(state.rows, delimiter, state.expanded)
        : state.rows.map((row): KeyTreeRow => ({
            kind: 'key',
            id: row.id,
            name: row.name,
            depth: 0,
            row,
          })),
    [state.rows, state.view, state.expanded, delimiter],
  );

  const scope = {
    panelId,
    profileId: target.profileId,
    database: cluster ? undefined : (target.database ?? 0),
  };

  return (
    <div className="flex h-full flex-col bg-bg" data-testid="key-browser">
      <Toolbar label="Key browser">
        {!cluster && facts && (
          <label className="flex items-center gap-1 text-xs text-muted">
            Database
            <select
              aria-label="Database"
              className="h-7 rounded border border-border bg-panel-2 px-1 text-xs text-fg"
              value={target.database ?? 0}
              onChange={(e) => switchDatabase(Number(e.target.value))}
            >
              {Array.from({ length: Math.min(facts.info.server.databases, 256) }, (_, db) => (
                <option key={db} value={db}>
                  db{db}
                </option>
              ))}
            </select>
          </label>
        )}
        <NodeSelect facts={facts} value={target.node} onChange={switchNode} />
        <form
          className="flex items-center gap-1.5"
          onSubmit={(event) => {
            event.preventDefault();
            applyFilter();
          }}
        >
          <Input
            aria-label="Key pattern"
            placeholder="Pattern, e.g. user:*"
            className="h-7 w-56 font-mono text-xs"
            value={pattern}
            onChange={(e) => setPattern(e.target.value)}
          />
          <select
            aria-label="Key type"
            className="h-7 rounded border border-border bg-panel-2 px-1 text-xs text-fg"
            value={type}
            onChange={(e) => setType(e.target.value)}
          >
            {KEY_TYPES.map((t) => (
              <option key={t} value={t}>
                {t === '' ? 'Any type' : t}
              </option>
            ))}
          </select>
          <Button size="sm" type="submit" variant="primary">
            Scan
          </Button>
        </form>
        <Separator />
        <div className="flex rounded border border-border" role="radiogroup" aria-label="View">
          {(['tree', 'list'] as const).map((view) => (
            <button
              key={view}
              type="button"
              role="radio"
              aria-checked={state.view === view}
              className={cx(
                'h-7 px-2 text-xs',
                state.view === view ? 'bg-badge text-fg' : 'text-muted hover:bg-hover',
              )}
              onClick={() => controller.setView(view)}
            >
              {view === 'tree' ? 'Tree' : 'List'}
            </button>
          ))}
        </div>
        <Button size="sm" onClick={() => void controller.reset()} title="Scan again">
          <Icon name="refresh" className="h-3.5 w-3.5" />
          Refresh
        </Button>
        <span className="flex-1" />
        <Button size="sm" onClick={() => setDialog('new')}>
          <Icon name="plus" className="h-3.5 w-3.5" />
          New key
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setDialog('bulk')}>
          Bulk delete…
        </Button>
      </Toolbar>
      {(factsError ?? state.error ?? actionError) && (
        <Notice kind="error" onClose={() => setActionError(undefined)}>
          {factsError ?? state.error ?? actionError}
        </Notice>
      )}
      <KeyTable
        rows={treeRows}
        memory={state.memory}
        onToggle={(id) => controller.toggleNamespace(id)}
        onOpen={openKey}
        onDelete={(row) => void deleteKey(row)}
        onVisible={fetchMemory}
        empty={
          state.loading
            ? 'Scanning…'
            : state.hasMore
              ? 'No keys in this page yet: load more to keep scanning.'
              : 'No keys match.'
        }
      />
      <footer className="flex flex-wrap items-center gap-2 border-t border-border bg-panel px-2 py-1 text-xs">
        <span data-testid="key-count">{formatCount(state.rows.length)} keys loaded</span>
        <span className="text-muted">· {formatCount(state.scanCalls)} SCAN calls</span>
        {state.loading && <span className="text-muted">· scanning…</span>}
        {!state.hasMore && !state.loading && !state.error && (
          <span className="text-muted" data-testid="scan-complete">
            · scan complete
          </span>
        )}
        {state.budgetExhausted && state.hasMore && (
          <span className="text-muted">· the last page stopped at its SCAN budget</span>
        )}
        <span className="flex-1" />
        {state.hasMore && (
          <Button size="sm" onClick={() => void controller.loadMore()} disabled={state.loading}>
            Load more
          </Button>
        )}
      </footer>
      {dialog === 'new' && (
        <NewKeyDialog
          scope={scope}
          jsonModule={facts?.info.server.modules.some((m) => /^rejson$/i.test(m.name)) ?? false}
          onClose={() => setDialog(undefined)}
          onCreated={(key) => {
            setDialog(undefined);
            openRedisPanel({
              profileId: target.profileId,
              profileName: target.profileName,
              tool: 'value',
              key,
              ...(scope.database !== undefined ? { database: scope.database } : {}),
            });
          }}
        />
      )}
      {dialog === 'bulk' && (
        <BulkDeleteDialog
          scope={scope}
          pattern={pattern}
          type={type}
          onClose={() => setDialog(undefined)}
          onDeleted={() => void controller.reset()}
        />
      )}
    </div>
  );
}

function nodeOf(target: RedisPanelTarget): { node?: string } {
  return target.node === undefined ? {} : { node: target.node };
}

/** The key rows, windowed: only the rows on screen are rendered (and get their memory). */
function KeyTable(props: {
  readonly rows: readonly KeyTreeRow[];
  readonly memory: Readonly<Record<string, number | null | 'loading'>>;
  readonly onToggle: (id: string) => void;
  readonly onOpen: (row: KeyRow) => void;
  readonly onDelete: (row: KeyRow) => void;
  readonly onVisible: (ids: string[]) => void;
  readonly empty: string;
}) {
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(600);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = box.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setHeight(element.clientHeight));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const first = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const last = Math.min(props.rows.length, Math.ceil((scrollTop + height) / ROW_HEIGHT) + OVERSCAN);
  const visible = props.rows.slice(first, last);
  const visibleKeys = visible
    .filter((r): r is Extract<KeyTreeRow, { kind: 'key' }> => r.kind === 'key')
    .map((r) => r.id);
  const visibleSignature = visibleKeys.join('\u0001');
  const onVisible = props.onVisible;
  useEffect(() => {
    if (visibleKeys.length === 0) return;
    const timer = setTimeout(() => onVisible(visibleKeys), 150);
    return () => clearTimeout(timer);
    // The signature stands for the visible keys.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleSignature, onVisible]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="grid shrink-0 grid-cols-[1fr_70px_110px_90px_28px] border-b border-border bg-panel px-2 py-1 text-[11px] font-semibold tracking-wide text-muted uppercase">
        <span>Key</span>
        <span>Type</span>
        <span>TTL</span>
        <span className="text-right">Memory</span>
        <span />
      </div>
      <div
        ref={box}
        role="grid"
        aria-label="Keys"
        className="min-h-0 flex-1 overflow-auto"
        onScroll={(event: UIEvent<HTMLDivElement>) => setScrollTop(event.currentTarget.scrollTop)}
      >
        {props.rows.length === 0 ? (
          <EmptyState>{props.empty}</EmptyState>
        ) : (
          <div style={{ height: props.rows.length * ROW_HEIGHT, position: 'relative' }}>
            {visible.map((row, i) => (
              <div
                key={row.kind === 'key' ? `k${row.id}` : `n${row.id}`}
                role="row"
                data-testid={row.kind === 'key' ? 'key-row' : 'namespace-row'}
                data-name={row.name}
                tabIndex={0}
                className="group absolute right-0 left-0 grid cursor-default grid-cols-[1fr_70px_110px_90px_28px] items-center px-2 text-[13px] hover:bg-hover focus:bg-hover focus:outline-none"
                style={{ top: (first + i) * ROW_HEIGHT, height: ROW_HEIGHT }}
                onClick={() =>
                  row.kind === 'key' ? props.onOpen(row.row) : props.onToggle(row.id)
                }
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    if (row.kind === 'key') props.onOpen(row.row);
                    else props.onToggle(row.id);
                  }
                  if (event.key === 'Delete' && row.kind === 'key') props.onDelete(row.row);
                }}
              >
                <span
                  className="flex min-w-0 items-center gap-1"
                  style={{ paddingLeft: row.depth * 14 }}
                >
                  {row.kind === 'namespace' ? (
                    <>
                      <Icon
                        name={row.expanded ? 'chevron-down' : 'chevron-right'}
                        className="h-3 w-3 text-muted"
                      />
                      <Icon name="folder" className="text-muted" />
                      <span className="truncate font-mono">{row.name}</span>
                      <span className="text-xs text-muted">({formatCount(row.count)})</span>
                    </>
                  ) : (
                    <>
                      <span className="w-3" />
                      <span className="truncate font-mono select-text" title={row.row.name}>
                        {row.name}
                      </span>
                    </>
                  )}
                </span>
                {row.kind === 'key' ? (
                  <>
                    <span>
                      <TypeBadge type={row.row.type} />
                    </span>
                    <span className="text-xs text-muted">{formatTtl(row.row.ttlMs)}</span>
                    <span className="text-right text-xs text-muted tabular-nums">
                      {props.memory[row.id] === 'loading'
                        ? '…'
                        : formatBytes(props.memory[row.id] as number | null | undefined)}
                    </span>
                    <button
                      type="button"
                      aria-label={`Delete ${row.name}`}
                      className="rounded p-0.5 text-muted opacity-0 group-hover:opacity-100 hover:text-danger focus:opacity-100"
                      onClick={(event) => {
                        event.stopPropagation();
                        props.onDelete(row.row);
                      }}
                    >
                      <Icon name="close" className="h-3 w-3" />
                    </button>
                  </>
                ) : (
                  <span className="col-span-4" />
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
