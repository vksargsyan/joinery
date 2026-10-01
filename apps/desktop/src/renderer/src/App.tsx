import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';

import { mainApi } from './lib/main-client';
import { AboutDialog } from './components/AboutDialog';
import { registerAppCommands, type AppActions } from './components/app-commands';
import { CommandPalette } from './components/CommandPalette';
import { CommandStatus } from './components/CommandStatus';
import { ConnectionDialog, type ConnectionDialogMode } from './components/ConnectionDialog';
import { Dock, openQueryTab } from './components/dock';
import { HistoryPanel } from './components/HistoryPanel';
import { HostKeyPrompts } from './components/HostKeyPrompt';
import { JobsPanel } from './components/jobs/JobsPanel';
import { TransferDialogs } from './components/jobs/TransferDialogs';
import { TransferDbHost } from './components/transfer-db/TransferDbDialog';
import { BackupDialogs } from './components/backup/BackupDialogs';
import { Prompts } from './components/Prompts';
import { ScheduleDialog } from './components/schedules/ScheduleDialog';
import { openRedisTool } from './components/redis/RedisTree';
import { Sidebar } from './components/Sidebar';
import { TitleBar } from './components/TitleBar';
import { useTheme } from './components/theme';
import { UpdateNotice } from './components/UpdateNotice';
import { useConnections } from './state/connections';
import { keys, useProfiles, useSettings } from './state/data';
import { startKeybindings, useKeybindings } from './state/keybindings';
import { runningCount, showJobs, useJobs, watchJobs } from './state/jobs';
import { usePanels } from './state/panels';
import { openSchedulesPanel } from './state/schedules';
import { openAbout, watchAppCommands, watchUpdates } from './state/updates';
import { useWorkspace } from './state/workspace';

/**
 * The window: the title bar, connections and objects on the left, dockable query tabs in the
 * middle, history on the right. The active tab's connection drives the production guardrail: a red frame around the
 * whole window and a banner naming the connection (spec §4).
 */
export function App() {
  const theme = useTheme();
  const queryClient = useQueryClient();
  const [dialog, setDialog] = useState<ConnectionDialogMode>();
  const [historyOpen, setHistoryOpen] = useState(false);
  const jobsOpen = useJobs((state) => state.open);
  const jobsRunning = useJobs(runningCount);
  const profiles = useProfiles();
  const activeTab = useWorkspace((state) =>
    state.activeTabId ? state.tabs[state.activeTabId] : undefined,
  );
  // Table data views and designers count as the active tab too.
  const activeId = useWorkspace((state) => state.activeTabId);
  // Panels of no connection (Schedules, Keyboard Shortcuts) have the empty id.
  const activePanelProfile = usePanels((state) =>
    activeId ? state.panels[activeId]?.profileId || undefined : undefined,
  );
  const activePanelTitle = usePanels((state) =>
    activeId ? state.panels[activeId]?.title : undefined,
  );
  const activeTitle = activeTab?.title ?? activePanelTitle;
  const activeProfileId = activeTab?.profileId ?? activePanelProfile;
  const activeProfile = profiles.data?.find((p) => p.id === activeProfileId);
  const production = activeProfile?.presentation.environment === 'production';
  const readyProfiles = useConnections(
    useShallow((state) =>
      Object.values(state.byProfile)
        .filter((c) => c.status === 'ready')
        .map((c) => c.profileId),
    ),
  );

  useEffect(() => {
    document.documentElement.dataset['theme'] = theme;
  }, [theme]);

  useEffect(() => {
    void watchJobs();
  }, []);

  useEffect(() => {
    void watchUpdates();
    void watchAppCommands();
  }, []);

  // `#about` opens the About box: a link for what cannot reach the application menu (the
  // packaged-app tests drive the page only).
  useEffect(() => {
    const follow = (): void => {
      if (location.hash !== '#about') return;
      history.replaceState(null, '', location.pathname + location.search);
      openAbout();
    };
    follow();
    window.addEventListener('hashchange', follow);
    return () => window.removeEventListener('hashchange', follow);
  }, []);

  const toggleTheme = async (): Promise<void> => {
    await mainApi().settings.set({ theme: theme === 'dark' ? 'light' : 'dark' });
    await queryClient.invalidateQueries({ queryKey: keys.settings });
  };

  const newQuery = (): void => {
    const profileId = activeProfileId ?? readyProfiles[0];
    const profile = profiles.data?.find((p) => p.id === profileId);
    if (profile?.engine === 'redis') openRedisTool(profile, 'cli');
    else if (profile) openQueryTab({ profileId: profile.id, title: `${profile.name} query` });
  };

  // The palette's commands and the key bindings (what App holds comes through `actions`).
  const actions = useRef<AppActions>(undefined as unknown as AppActions);
  actions.current = {
    newConnection: () => setDialog({ kind: 'create' }),
    editConnection: (profile) => setDialog({ kind: 'edit', profile }),
    newQuery,
    canNewQuery: () => activeTab !== undefined || readyProfiles.length > 0,
    toggleHistory: () => setHistoryOpen((open) => !open),
    toggleTheme: () => void toggleTheme(),
  };
  useEffect(() => registerAppCommands(() => actions.current), []);
  useEffect(() => startKeybindings(), []);
  const settings = useSettings();
  useEffect(() => {
    if (settings.data) useKeybindings.setState({ overrides: settings.data.keybindings });
  }, [settings.data]);

  return (
    <div className="flex h-full flex-col">
      <TitleBar
        title={activeTitle}
        production={production ? activeProfile?.name : undefined}
        theme={theme}
        onToggleTheme={() => void toggleTheme()}
        onNewQuery={newQuery}
        newQueryDisabled={!activeTab && readyProfiles.length === 0}
        historyOpen={historyOpen}
        onToggleHistory={() => setHistoryOpen(!historyOpen)}
        onSchedules={() => openSchedulesPanel()}
        jobsOpen={jobsOpen}
        jobsRunning={jobsRunning}
        onToggleJobs={() => showJobs(!jobsOpen)}
      />
      <div className="flex min-h-0 flex-1">
        <div className="w-72 shrink-0">
          <Sidebar onEdit={setDialog} />
        </div>
        <main className="min-w-0 flex-1" aria-label="Query tabs">
          <Dock theme={theme} />
        </main>
        {historyOpen && (
          <div className="w-80 shrink-0">
            <HistoryPanel onClose={() => setHistoryOpen(false)} />
          </div>
        )}
        {jobsOpen && (
          <div className="w-96 shrink-0">
            <JobsPanel />
          </div>
        )}
      </div>
      {production && (
        <div
          aria-hidden="true"
          data-testid="production-frame"
          className="pointer-events-none fixed inset-0 z-30 border-[3px] border-env-production"
        />
      )}
      <Prompts />
      <ScheduleDialog />
      <HostKeyPrompts />
      <TransferDialogs />
      <TransferDbHost />
      <BackupDialogs />
      <AboutDialog />
      <CommandPalette />
      <CommandStatus />
      <UpdateNotice />
      {dialog && <ConnectionDialog mode={dialog} onClose={() => setDialog(undefined)} />}
    </div>
  );
}
