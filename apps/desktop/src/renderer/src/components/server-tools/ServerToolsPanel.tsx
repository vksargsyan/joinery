import type { KeyboardEvent } from 'react';

import {
  SERVER_TOOLS_TABS,
  TAB_TITLES,
  showTab,
  useServerToolsPanels,
  type ServerToolsTab,
} from '../../state/server-tools/panels';
import { Notice } from '../redis/common';
import { TAB } from '../ui';
import { NoticeList, useServerToolsInfo, type TabProps } from './common';
import { MaintenanceTab } from './MaintenanceTab';
import { MonitorPoller, MonitorTab } from './MonitorTab';
import { SessionsTab } from './SessionsTab';
import { SettingsTab } from './SettingsTab';
import { TopQueriesTab } from './TopQueriesTab';
import { UsersTab } from './UsersTab';

/**
 * The server tools dock panel (spec §15) of a MySQL, MariaDB, PostgreSQL or MongoDB
 * connection: a tab strip (arrow keys move between tabs) over the monitor, sessions, top
 * queries, users, maintenance and settings. The monitor keeps polling while another tab shows.
 */

export function ServerToolsPanel(props: { readonly panelId: string }) {
  const state = useServerToolsPanels((s) => s.panels[props.panelId]);
  const { info, error } = useServerToolsInfo(props.panelId);
  if (!state) return <p className="p-4 text-sm text-muted">This panel was closed.</p>;
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const index = SERVER_TOOLS_TABS.indexOf(state.tab);
    const next =
      event.key === 'ArrowRight'
        ? SERVER_TOOLS_TABS[(index + 1) % SERVER_TOOLS_TABS.length]
        : event.key === 'ArrowLeft'
          ? SERVER_TOOLS_TABS[(index + SERVER_TOOLS_TABS.length - 1) % SERVER_TOOLS_TABS.length]
          : undefined;
    if (!next) return;
    event.preventDefault();
    showTab(props.panelId, next);
    event.currentTarget.querySelector<HTMLElement>(`[data-tab="${next}"]`)?.focus();
  };
  return (
    <div className="flex h-full flex-col bg-bg" data-testid="server-tools-panel">
      <MonitorPoller panelId={props.panelId} />
      <div className="flex items-center gap-2 border-b border-border bg-panel px-2">
        <div role="tablist" aria-label="Server tools" className="flex" onKeyDown={onKeyDown}>
          {SERVER_TOOLS_TABS.map((tab) => (
            <button
              key={tab}
              type="button"
              role="tab"
              data-tab={tab}
              id={`${props.panelId}-${tab}`}
              aria-selected={state.tab === tab}
              aria-controls={`${props.panelId}-panel`}
              tabIndex={state.tab === tab ? 0 : -1}
              className={TAB}
              onClick={() => showTab(props.panelId, tab)}
            >
              {TAB_TITLES[tab]}
            </button>
          ))}
        </div>
        <span className="flex-1" />
        {info && (
          <span className="truncate text-xs text-muted" data-testid="server-tools-identity">
            {info.product} {info.version} · {info.user}
            {info.database ? ` · ${info.database}` : ''}
          </span>
        )}
      </div>
      {error && <Notice kind="error">{error}</Notice>}
      {info && state.tab !== 'monitor' && <NoticeList notices={info.notices} />}
      <div
        role="tabpanel"
        id={`${props.panelId}-panel`}
        aria-labelledby={`${props.panelId}-${state.tab}`}
        className="min-h-0 flex-1"
      >
        {info && <TabContent tab={state.tab} panelId={props.panelId} info={info} />}
      </div>
    </div>
  );
}

function TabContent(props: TabProps & { readonly tab: ServerToolsTab }) {
  const tab = { panelId: props.panelId, info: props.info };
  switch (props.tab) {
    case 'monitor':
      return <MonitorTab {...tab} />;
    case 'sessions':
      return <SessionsTab {...tab} />;
    case 'topQueries':
      return <TopQueriesTab {...tab} />;
    case 'users':
      return <UsersTab {...tab} />;
    case 'maintenance':
      return <MaintenanceTab {...tab} />;
    case 'settings':
      return <SettingsTab {...tab} />;
  }
}
