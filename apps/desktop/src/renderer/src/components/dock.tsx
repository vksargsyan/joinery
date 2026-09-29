import {
  DockviewReact,
  themeDark,
  themeLight,
  type DockviewApi,
  type IDockviewPanelHeaderProps,
  type IDockviewPanelProps,
} from 'dockview-react';
import { useEffect } from 'react';

import { closeTab } from '../state/runner';
import { createTab, useWorkspace } from '../state/workspace';
import { QueryPanel } from './QueryPanel';
import { Icon, cx } from './ui';

/**
 * The main area (spec §19: dockview): query tabs as dock panels that can be split and rearranged.
 * The workspace store owns tab state; dockview only lays the panels out. Closing goes through
 * `closeTab`, which asks first when the tab has an open transaction.
 */

let dockApi: DockviewApi | undefined;
const pendingRuns = new Set<string>();

interface QueryPanelParams {
  readonly tabId: string;
}

/** Opens a query tab for a connection, optionally with text, and runs it when asked. */
export function openQueryTab(options: {
  readonly profileId: string;
  readonly title: string;
  readonly text?: string;
  readonly run?: boolean;
}): string {
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
      components={{ query: QueryPanelHost }}
      tabComponents={{ queryTab: QueryTabHeader }}
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
        });
      }}
    />
  );
}
