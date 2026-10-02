import { isSqlEngine } from '@joinery/core';
import type { StoredProfile } from '@joinery/ipc';

import { mainApi } from '../lib/main-client';
import { registerCommands, showStatus } from '../state/commands';
import { connect, disconnect, useConnections } from '../state/connections';
import { keys, queryClient } from '../state/data';
import {
  loadChildren,
  pathKey,
  resetExplorer,
  setProfileExpanded,
  tablesFolderPath,
  useExplorer,
} from '../state/explorer';
import { createFolder } from '../state/folders';
import { showJobs, useJobs } from '../state/jobs';
import { openKeybindingsPanel } from '../state/keybindings-panel';
import { loadSnapshot } from '../state/metadata';
import { openCreateCollection } from '../state/mongo/create-dialogs';
import { revealObjects, useObjectsView } from '../state/objects-view';
import { openPalette, quickPick } from '../state/palette';
import { panelInfo } from '../state/panels';
import { openSchedulesPanel } from '../state/schedules';
import { getTableView } from '../state/table-view';
import { openAbout } from '../state/updates';
import { useWorkspace } from '../state/workspace';
import { currentDock, openTableDesigner, requestClosePanel, requestCloseTab } from './dock';

/**
 * The commands of the palette and the key bindings (state/commands.ts): connections, queries,
 * tables, the window's views and tools, preferences and help. What lives in App's own state (the
 * connection dialog, the history panel, the theme) comes in through `AppActions`.
 */

export interface AppActions {
  readonly newConnection: () => void;
  readonly editConnection: (profile: StoredProfile) => void;
  readonly newQuery: () => void;
  readonly canNewQuery: () => boolean;
  readonly toggleHistory: () => void;
  readonly toggleTheme: () => void;
}

function profiles(): StoredProfile[] {
  return queryClient.getQueryData<StoredProfile[]>(keys.profiles) ?? [];
}

function status(profileId: string): string | undefined {
  return useConnections.getState().byProfile[profileId]?.status;
}

function connected(): StoredProfile[] {
  return profiles().filter((profile) => status(profile.id) === 'ready');
}

/** Asks for a connection among `candidates`; undefined when the user closes the list. */
function pickConnection(placeholder: string, candidates: readonly StoredProfile[]) {
  return quickPick({
    placeholder,
    items: candidates.map((profile) => ({
      label: profile.name,
      description: `${profile.presentation.environment} · ${profile.engine}`,
      icon: 'plug' as const,
      value: profile,
    })),
  });
}

/** The active dock panel's id, if any. */
function activeId(): string | undefined {
  return currentDock()?.activePanel?.id;
}

function stepTab(by: number): void {
  const dock = currentDock();
  const group = dock?.activeGroup;
  const panels = group?.panels ?? [];
  if (panels.length < 2 || !group?.activePanel) return;
  const at = panels.indexOf(group.activePanel);
  panels[(at + by + panels.length) % panels.length]?.api.setActive();
}

export function registerAppCommands(actions: () => AppActions): () => void {
  return registerCommands([
    {
      id: 'workbench.commandPalette',
      category: 'View',
      title: 'Show All Commands',
      icon: 'kebab',
      unremembered: true,
      run: () => openPalette('>'),
    },
    {
      id: 'workbench.quickOpen',
      category: 'Go',
      title: 'Go to Table or Collection…',
      icon: 'search',
      keywords: ['open', 'find', 'object'],
      unremembered: true,
      run: () => openPalette(''),
    },
    {
      id: 'workbench.keyboardShortcuts',
      category: 'Preferences',
      title: 'Keyboard Shortcuts',
      icon: 'settings',
      keywords: ['keybindings', 'keys', 'hotkeys'],
      run: () => openKeybindingsPanel(),
    },
    {
      id: 'workbench.toggleTheme',
      category: 'Preferences',
      title: 'Toggle Light/Dark Theme',
      icon: 'sun',
      keywords: ['color', 'theme', 'dark', 'light'],
      run: () => actions().toggleTheme(),
    },
    {
      id: 'connection.new',
      category: 'Connection',
      title: 'New Connection…',
      icon: 'connection-new',
      run: () => actions().newConnection(),
    },
    {
      id: 'connection.newFolder',
      category: 'Connection',
      title: 'New Folder',
      icon: 'folder-new',
      run: async () => {
        await createFolder();
      },
    },
    {
      id: 'connection.connect',
      category: 'Connection',
      title: 'Connect…',
      icon: 'plug',
      enabled: () => profiles().some((p) => status(p.id) !== 'ready'),
      run: async () => {
        const profile = await pickConnection(
          'Select a connection to open',
          profiles().filter((p) => status(p.id) !== 'ready'),
        );
        if (!profile) return;
        await connect(profile.id);
        setProfileExpanded(profile.id, true);
        void loadChildren(profile.id, []);
      },
    },
    {
      id: 'connection.disconnect',
      category: 'Connection',
      title: 'Disconnect…',
      icon: 'disconnect',
      enabled: () => connected().length > 0,
      run: async () => {
        const profile = await pickConnection('Select a connection to close', connected());
        if (!profile) return;
        resetExplorer(profile.id);
        await disconnect(profile.id);
      },
    },
    {
      id: 'connection.closeAll',
      category: 'Connection',
      title: 'Close All Connections',
      icon: 'disconnect',
      enabled: () => connected().length > 0,
      run: async () => {
        await Promise.all(
          connected().map(async (profile) => {
            resetExplorer(profile.id);
            await disconnect(profile.id).catch(() => undefined);
          }),
        );
      },
    },
    {
      id: 'connection.edit',
      category: 'Connection',
      title: 'Edit Connection…',
      icon: 'edit',
      enabled: () => profiles().length > 0,
      run: async () => {
        const profile = await pickConnection('Select a connection to edit', profiles());
        if (profile) actions().editConnection(profile);
      },
    },
    {
      id: 'connection.search',
      category: 'Connection',
      title: 'Search Connections',
      icon: 'search',
      run: () => {
        const input = document.querySelector<HTMLInputElement>('[data-testid="sidebar-search"]');
        input?.focus();
        input?.select();
      },
    },
    {
      id: 'query.new',
      category: 'Query',
      title: 'New Query Tab',
      icon: 'query',
      enabled: () => actions().canNewQuery(),
      run: () => actions().newQuery(),
    },
    {
      id: 'query.history',
      category: 'Query',
      title: 'Show History',
      icon: 'history',
      run: () => actions().toggleHistory(),
    },
    {
      id: 'table.create',
      category: 'Table',
      title: 'Create Table…',
      icon: 'table-new',
      enabled: () => connected().some((p) => isSqlEngine(p.engine)),
      run: async () => {
        const items = (
          await Promise.all(
            connected()
              .filter((p) => isSqlEngine(p.engine))
              .map(async (profile) => {
                if (!isSqlEngine(profile.engine)) return [];
                const dialect = profile.engine;
                const snapshot = await loadSnapshot(profile.id, { dialect }).catch(() => undefined);
                return (snapshot?.schemas ?? []).map((schema) => {
                  const database = dialect === 'postgres' ? snapshot!.database : schema.name;
                  return {
                    label: dialect === 'postgres' ? `${database}.${schema.name}` : schema.name,
                    description: profile.name,
                    icon: 'database' as const,
                    value: { profile, dialect, database, schema: schema.name },
                  };
                });
              }),
          )
        ).flat();
        const target = await quickPick({ placeholder: 'Where should the table go?', items });
        if (!target) return;
        openTableDesigner({
          profileId: target.profile.id,
          database: target.database,
          schema: target.schema,
          name: null,
          tablesPath: tablesFolderPath(
            { database: target.database, schema: target.schema, name: '' },
            target.dialect,
          ),
        });
      },
    },
    {
      id: 'collection.create',
      category: 'Collection',
      title: 'Create Collection…',
      icon: 'table-new',
      enabled: () => connected().some((p) => p.engine === 'mongodb'),
      run: async () => {
        const mongos = connected().filter((p) => p.engine === 'mongodb');
        const lists = await Promise.all(
          mongos.map(async (profile) => {
            await loadChildren(profile.id, []);
            const nodes = useExplorer.getState().children[profile.id]?.[pathKey([])]?.nodes ?? [];
            return nodes
              .filter((node) => node.kind === 'database')
              .map((node) => ({
                label: node.name,
                description: profile.name,
                icon: 'database' as const,
                value: { profile, db: node.name },
              }));
          }),
        );
        const target = await quickPick({
          placeholder: 'Which database should the collection go in?',
          items: lists.flat(),
        });
        if (!target) return;
        // The create dialogs live in the connection's tree: open it first.
        setProfileExpanded(target.profile.id, true);
        openCreateCollection(target.profile.id, target.db);
      },
    },
    {
      id: 'view.objects',
      category: 'View',
      title: 'Show Objects',
      icon: 'table',
      run: () => {
        if (!revealObjects()) {
          showStatus('info', 'Click a database, a schema or a folder in the side bar first.');
        }
      },
    },
    {
      id: 'view.closeTab',
      category: 'View',
      title: 'Close Tab',
      icon: 'close',
      enabled: () => activeId() !== undefined,
      run: async () => {
        const id = activeId();
        if (id === undefined) return;
        if (useWorkspace.getState().tabs[id]) await requestCloseTab(id);
        else await requestClosePanel(id);
      },
    },
    {
      id: 'view.nextTab',
      category: 'View',
      title: 'Next Tab',
      icon: 'page-next',
      run: () => stepTab(1),
    },
    {
      id: 'view.previousTab',
      category: 'View',
      title: 'Previous Tab',
      icon: 'page-previous',
      run: () => stepTab(-1),
    },
    {
      id: 'view.refresh',
      category: 'View',
      title: 'Refresh',
      icon: 'refresh',
      enabled: () => {
        const id = activeId();
        const kind = id === undefined ? undefined : panelInfo(id)?.kind;
        return kind === 'table-data' || kind === 'objects';
      },
      run: async () => {
        const id = activeId();
        if (id === undefined) return;
        const kind = panelInfo(id)?.kind;
        if (kind === 'table-data') await getTableView(id)?.refresh();
        else if (kind === 'objects') {
          const location = useObjectsView.getState().location;
          if (location) await loadChildren(location.profileId, location.path);
        }
      },
    },
    {
      id: 'tools.schedules',
      category: 'Tools',
      title: 'Schedules',
      icon: 'schedule',
      run: () => openSchedulesPanel(),
    },
    {
      id: 'tools.jobs',
      category: 'Tools',
      title: 'Toggle Jobs',
      icon: 'jobs',
      run: () => showJobs(!useJobs.getState().open),
    },
    {
      id: 'help.about',
      category: 'Help',
      title: 'About Joinery',
      icon: 'bookmark',
      run: () => openAbout(),
    },
    {
      id: 'help.checkForUpdates',
      category: 'Help',
      title: 'Check for Updates…',
      icon: 'download',
      run: () => mainApi().app.menu({ command: 'checkForUpdates' }),
    },
    {
      id: 'help.releaseNotes',
      category: 'Help',
      title: 'Release Notes',
      icon: 'open',
      run: () => mainApi().app.menu({ command: 'releaseNotes' }),
    },
  ]);
}
