import {
  DockviewReact,
  themeDark,
  themeLight,
  type DockviewApi,
  type IDockviewPanelHeaderProps,
  type IDockviewPanelProps,
} from 'dockview-react';
import { newId } from '@joinery/core';
import type { FilterGroup } from '@joinery/table-data';
import { useEffect } from 'react';

import { createDesigner, disposeDesigner, type DesignerTarget } from '../state/designer';
import { cachedProfile } from '../state/data';
import { confirm } from '../state/dialogs';
import {
  panelInfo,
  panelKey,
  panelWithKey,
  registerPanel,
  unregisterPanel,
  usePanels,
  type PanelKind,
} from '../state/panels';
import { disposeRedisPanel } from '../state/redis/panels';
import { disposeMongoPanel } from '../state/mongo/panels';
import { disposeSyncPanel } from '../state/sync/panels';
import { closeTab } from '../state/runner';
import { createTableView, disposeTableView, type TableTarget } from '../state/table-view';
import { createTab, useWorkspace } from '../state/workspace';
import { TableDesignerPanel } from './designer/TableDesignerPanel';
import { QueryPanel } from './QueryPanel';
import { RedisPanel } from './redis/RedisPanel';
import { MongoPanel } from './mongo/MongoPanel';
import { SyncPanel } from './sync/SyncPanel';
import { openMongoConsole } from './mongo/open';
import { TableDataPanel } from './table/TableDataPanel';
import { Icon, cx } from './ui';

/**
 * The main area (spec §19: dockview): query tabs, table data views and table designers as dock
 * panels that can be split and rearranged. The workspace store owns query tab state and the
 * panels store names the others; dockview only lays the panels out. Closing goes through
 * `closeTab` (asks when a transaction is open) or `requestClosePanel` (asks when changes are
 * staged or a design is unsaved).
 */

let dockApi: DockviewApi | undefined;
const pendingRuns = new Set<string>();

interface QueryPanelParams {
  readonly tabId: string;
}

interface PanelParams {
  readonly panelId: string;
}

function addPanel(kind: PanelKind, id: string, title: string): void {
  dockApi?.addPanel<PanelParams>({
    id,
    component: kind === 'table-data' ? 'tableData' : 'tableDesigner',
    tabComponent: 'panelTab',
    title,
    params: { panelId: id },
    renderer: 'always',
  });
}

/** The dock, for modules that add their own panels (the Redis tools); undefined before it is ready. */
export function currentDock(): DockviewApi | undefined {
  return dockApi;
}

function focusPanel(key: string): string | undefined {
  const open = panelWithKey(key);
  if (!open) return undefined;
  dockApi?.getPanel(open.id)?.api.setActive();
  return open.id;
}

/**
 * Opens a table's data view (spec §7), or focuses the one already open. With a filter (a
 * foreign key's referenced row) it always opens a new view filtered to it.
 */
export function openTableData(
  target: TableTarget,
  options: { readonly filter?: FilterGroup } = {},
): string {
  const key = panelKey('data', target);
  if (!options.filter) {
    const open = focusPanel(key);
    if (open) return open;
  }
  const id = newId();
  registerPanel({
    id,
    kind: 'table-data',
    profileId: target.profileId,
    title: target.name,
    ...(options.filter ? {} : { key }),
  });
  createTableView(id, target, options);
  addPanel('table-data', id, target.name);
  return id;
}

/** Opens the table designer (spec §8) on a table, or on a new one when `name` is null. */
export function openTableDesigner(target: DesignerTarget): string {
  const key =
    target.name === null ? undefined : panelKey('design', { ...target, name: target.name });
  if (key) {
    const open = focusPanel(key);
    if (open) return open;
  }
  const id = newId();
  const title = target.name === null ? 'New table' : `${target.name} (design)`;
  registerPanel({
    id,
    kind: 'table-designer',
    profileId: target.profileId,
    title,
    ...(key ? { key } : {}),
  });
  createDesigner(id, target);
  addPanel('table-designer', id, title);
  return id;
}

/** Closes a data view or designer, asking first when it holds unsaved work. */
export async function requestClosePanel(id: string): Promise<void> {
  const info = panelInfo(id);
  if (info?.dirty) {
    const ok = await confirm({
      title: `Close "${info.title}"?`,
      message:
        info.kind === 'table-data'
          ? 'The staged changes were not applied and will be lost.'
          : info.kind === 'redis'
            ? 'The edited value was not saved and will be lost.'
            : 'The design was not saved and will be lost.',
      confirmLabel: 'Close without saving',
      danger: true,
    });
    if (!ok) return;
  }
  dockApi?.getPanel(id)?.api.close();
}

function disposePanel(id: string): void {
  const info = panelInfo(id);
  if (!info) return;
  unregisterPanel(id);
  if (info.kind === 'table-data') void disposeTableView(id);
  else if (info.kind === 'redis') disposeRedisPanel(id);
  else if (info.kind === 'mongo') disposeMongoPanel(id);
  else if (info.kind === 'sync') disposeSyncPanel(id);
  else void disposeDesigner(id);
}

/** Opens a query tab for a connection, optionally with text, and runs it when asked. */
export function openQueryTab(options: {
  readonly profileId: string;
  readonly title: string;
  readonly text?: string;
  readonly run?: boolean;
}): string {
  // A MongoDB connection's "query tab" is its command console (spec §9).
  if (cachedProfile(options.profileId)?.engine === 'mongodb') return openMongoConsole(options);
  const tabId = createTab({
    profileId: options.profileId,
    title: options.title,
    ...(options.text === undefined ? {} : { text: options.text }),
  });
  if (options.run) pendingRuns.add(tabId);
  dockApi?.addPanel<QueryPanelParams>({
    id: tabId,
    component: 'query',
    tabComponent: 'queryTab',
    title: options.title,
    params: { tabId },
    renderer: 'always',
  });
  return tabId;
}

/** Runs a tab opened with `run: true` once its editor exists. */
export function takePendingRun(tabId: string): boolean {
  return pendingRuns.delete(tabId);
}

export async function requestCloseTab(tabId: string): Promise<void> {
  const closed = await closeTab(tabId);
  if (closed) dockApi?.getPanel(tabId)?.api.close();
}

function QueryPanelHost(props: IDockviewPanelProps<QueryPanelParams>) {
  return <QueryPanel tabId={props.params.tabId} />;
}

function QueryTabHeader(props: IDockviewPanelHeaderProps<QueryPanelParams>) {
  const tabId = props.params.tabId;
  const tab = useWorkspace((state) => state.tabs[tabId]);
  return (
    <div
      className="flex h-full items-center gap-1.5 px-2 text-[13px]"
      onMouseDown={(event) => {
        if (event.button === 1) {
          event.preventDefault();
          void requestCloseTab(tabId);
        }
      }}
    >
      {tab?.running && (
        <span aria-label="Running" className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />
      )}
      <span className="max-w-48 truncate">{tab?.title ?? props.api.title}</span>
      {tab?.inTransaction && (
        <span
          title="Open transaction"
          className="rounded bg-warning/20 px-1 text-[10px] font-semibold text-warning"
        >
          TX
        </span>
      )}
      <button
        type="button"
        aria-label={`Close ${tab?.title ?? 'tab'}`}
        className="rounded p-0.5 text-muted hover:bg-hover hover:text-fg"
        onClick={(event) => {
          event.stopPropagation();
          void requestCloseTab(tabId);
        }}
      >
        <Icon name="close" className="h-3 w-3" />
      </button>
    </div>
  );
}

function TableDataHost(props: IDockviewPanelProps<PanelParams>) {
  return <TableDataPanel panelId={props.params.panelId} />;
}

function TableDesignerHost(props: IDockviewPanelProps<PanelParams>) {
  return <TableDesignerPanel panelId={props.params.panelId} />;
}

function RedisPanelHost(props: IDockviewPanelProps<PanelParams>) {
  return <RedisPanel panelId={props.params.panelId} />;
}

function MongoPanelHost(props: IDockviewPanelProps<PanelParams>) {
  return <MongoPanel panelId={props.params.panelId} />;
}

function SyncPanelHost(props: IDockviewPanelProps<PanelParams>) {
  return <SyncPanel panelId={props.params.panelId} />;
}

function PanelTabHeader(props: IDockviewPanelHeaderProps<PanelParams>) {
  const panelId = props.params.panelId;
  const info = usePanels((state) => state.panels[panelId]);
  const title = info?.title ?? props.api.title ?? '';
  return (
    <div
      className="flex h-full items-center gap-1.5 px-2 text-[13px]"
      onMouseDown={(event) => {
        if (event.button === 1) {
          event.preventDefault();
          void requestClosePanel(panelId);
        }
      }}
    >
      {info?.busy && (
        <span aria-label="Working" className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />
      )}
      <Icon name="table" className="h-3.5 w-3.5 text-muted" />
      <span className="max-w-48 truncate">{title}</span>
      {info?.dirty && (
        <span title="Unsaved changes" aria-label="Unsaved changes" className="text-warning">
          ●
        </span>
      )}
      <button
        type="button"
        aria-label={`Close ${title}`}
        className="rounded p-0.5 text-muted hover:bg-hover hover:text-fg"
        onClick={(event) => {
          event.stopPropagation();
          void requestClosePanel(panelId);
        }}
      >
        <Icon name="close" className="h-3 w-3" />
      </button>
    </div>
  );
}

function Watermark() {
  return (
    <div className="flex h-full items-center justify-center text-center text-muted">
      <div>
        <p className="text-sm">No query tabs open</p>
        <p className="mt-1 text-xs">Connect to a database in the sidebar, then open a query tab.</p>
      </div>
    </div>
  );
}

export function Dock(props: { readonly theme: 'dark' | 'light' }) {
  useEffect(() => () => void (dockApi = undefined), []);
  return (
    <DockviewReact
      className={cx('joinery-dock h-full')}
      theme={props.theme === 'dark' ? themeDark : themeLight}
      components={{
        query: QueryPanelHost,
        tableData: TableDataHost,
        tableDesigner: TableDesignerHost,
        redis: RedisPanelHost,
        mongo: MongoPanelHost,
        sync: SyncPanelHost,
      }}
      tabComponents={{ queryTab: QueryTabHeader, panelTab: PanelTabHeader }}
      watermarkComponent={Watermark}
      disableFloatingGroups
      onReady={(event) => {
        dockApi = event.api;
        event.api.onDidActivePanelChange(({ panel }) => {
          useWorkspace.setState({ activeTabId: panel?.id });
        });
        // A panel removed by the dock itself (not through requestCloseTab) still frees its tab.
        event.api.onDidRemovePanel((panel) => {
          if (useWorkspace.getState().tabs[panel.id]) void closeTab(panel.id, { force: true });
          disposePanel(panel.id);
        });
      }}
    />
  );
}
