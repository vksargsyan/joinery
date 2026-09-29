import { JoineryError, newId, type EngineId, type ServerToolsInfo } from '@joinery/core';
import { create } from 'zustand';

import { currentDock } from '../../components/dock';
import { connect } from '../connections';
import { panelWithKey, registerPanel, unregisterPanel } from '../panels';
import { SessionLane } from '../session-lane';

/**
 * The server tools panel (spec §15): one dock panel per connection with its tabs (monitor,
 * sessions, top queries, users, maintenance, settings). It works on its own sessions on the
 * connection host, one per database it needs (PostgreSQL reaches a database's objects only
 * from a session in it), so nothing it does touches a query tab's session.
 */

export const SERVER_TOOLS_TABS = [
  'monitor',
  'sessions',
  'topQueries',
  'users',
  'maintenance',
  'settings',
] as const;
export type ServerToolsTab = (typeof SERVER_TOOLS_TABS)[number];

export const TAB_TITLES: Readonly<Record<ServerToolsTab, string>> = {
  monitor: 'Monitor',
  sessions: 'Sessions',
  topQueries: 'Top queries',
  users: 'Users',
  maintenance: 'Maintenance',
  settings: 'Settings',
};

/** Engines with server tools here (Redis has its own module). */
export function hasServerTools(engine: EngineId): boolean {
  return (
    engine === 'postgres' || engine === 'mysql' || engine === 'mariadb' || engine === 'mongodb'
  );
}

/** Where the maintenance or top queries tab should start (from an explorer node). */
export interface ServerToolsFocus {
  /** PostgreSQL: the database to open a session in. */
  readonly database?: string;
  /** The schema (PostgreSQL) or database (MySQL, MongoDB) to list. */
  readonly container?: string;
  /** A table or collection to select. */
  readonly name?: string;
}

export interface ServerToolsPanelState {
  readonly profileId: string;
  readonly profileName: string;
  readonly engine: EngineId;
  readonly tab: ServerToolsTab;
  readonly focus: ServerToolsFocus | undefined;
  /** Changes whenever `focus` is set again, so the tab picks it up. */
  readonly focusId: string;
}

export const useServerToolsPanels = create<{
  readonly panels: Readonly<Record<string, ServerToolsPanelState>>;
}>()(() => ({ panels: {} }));

const lanes = new Map<string, SessionLane>();
const infos = new Map<string, { generation: number; info: Promise<ServerToolsInfo> }>();
/** Each connection's default database, once known: a lane asked for it is the default lane. */
const defaultDatabases = new Map<string, string | null>();

function keyOf(profileId: string): string {
  return ['server-tools', profileId].join('\u0000');
}

export function serverToolsTitle(profileName: string): string {
  return `Server tools · ${profileName}`;
}

/**
 * Opens the server tools of a connection on a tab, or focuses the open panel and switches it
 * to that tab (and to `focus`, a table or database picked in the explorer).
 */
export function openServerTools(
  profile: { readonly id: string; readonly name: string; readonly engine: EngineId },
  options: { readonly tab?: ServerToolsTab; readonly focus?: ServerToolsFocus } = {},
): string {
  const key = keyOf(profile.id);
  const open = panelWithKey(key);
  if (open) {
    currentDock()?.getPanel(open.id)?.api.setActive();
    if (options.tab !== undefined) showTab(open.id, options.tab, options.focus);
    return open.id;
  }
  const id = newId();
  const title = serverToolsTitle(profile.name);
  registerPanel({ id, kind: 'server-tools', profileId: profile.id, title, key });
  useServerToolsPanels.setState((state) => ({
    panels: {
      ...state.panels,
      [id]: {
        profileId: profile.id,
        profileName: profile.name,
        engine: profile.engine,
        tab: options.tab ?? 'monitor',
        focus: options.focus,
        focusId: newId(),
      },
    },
  }));
  currentDock()?.addPanel({
    id,
    component: 'serverTools',
    tabComponent: 'panelTab',
    title,
    params: { panelId: id },
    renderer: 'always',
  });
  return id;
}

export function showTab(panelId: string, tab: ServerToolsTab, focus?: ServerToolsFocus): void {
  useServerToolsPanels.setState((state) => {
    const current = state.panels[panelId];
    if (!current) return state;
    return {
      panels: {
        ...state.panels,
        [panelId]: {
          ...current,
          tab,
          ...(focus !== undefined ? { focus, focusId: newId() } : {}),
        },
      },
    };
  });
}

export function panelState(panelId: string): ServerToolsPanelState {
  const state = useServerToolsPanels.getState().panels[panelId];
  if (!state) throw new JoineryError({ code: 'NOT_FOUND', message: 'The panel was closed' });
  return state;
}

/** The panel's session in `database` (the connection's default when absent). */
export function serverToolsLane(panelId: string, database?: string): SessionLane {
  const { profileId } = panelState(panelId);
  const own = database !== undefined && database !== defaultDatabases.get(profileId);
  const key = `${panelId}\u0000${own ? database : ''}`;
  let lane = lanes.get(key);
  if (!lane) {
    lane = new SessionLane(profileId, own ? database : undefined);
    lanes.set(key, lane);
  }
  return lane;
}

/** What the tools can do on this connection's server (loaded once per connection). */
export async function serverToolsInfo(panelId: string): Promise<ServerToolsInfo> {
  const { profileId } = panelState(panelId);
  const connection = await connect(profileId);
  const known = infos.get(profileId);
  if (known && known.generation === connection.generation) return known.info;
  const info = serverToolsLane(panelId).run((host, sessionId) =>
    host.serverTools.info({ sessionId }),
  );
  infos.set(profileId, { generation: connection.generation, info });
  info.then(
    (loaded) => defaultDatabases.set(profileId, loaded.database),
    () => undefined,
  );
  info.catch(() => {
    if (infos.get(profileId)?.info === info) infos.delete(profileId);
  });
  return info;
}

/** Frees a closed panel: its sessions and state. The monitor history stays for the session. */
export function disposeServerToolsPanel(panelId: string): void {
  for (const [key, lane] of lanes) {
    if (key.startsWith(`${panelId}\u0000`)) {
      void lane.close();
      lanes.delete(key);
    }
  }
  useServerToolsPanels.setState((state) => {
    const { [panelId]: _gone, ...panels } = state.panels;
    return { panels };
  });
  unregisterPanel(panelId);
}
