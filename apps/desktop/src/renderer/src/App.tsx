import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';

import { mainApi } from './lib/main-client';
import { ConnectionDialog, type ConnectionDialogMode } from './components/ConnectionDialog';
import { Dock, openQueryTab } from './components/dock';
import { HistoryPanel } from './components/HistoryPanel';
import { HostKeyPrompts } from './components/HostKeyPrompt';
import { JobsPanel } from './components/jobs/JobsPanel';
import { TransferDialogs } from './components/jobs/TransferDialogs';
import { TransferDbHost } from './components/transfer-db/TransferDbDialog';
import { BackupDialogs } from './components/backup/BackupDialogs';
import { Prompts } from './components/Prompts';
import { openRedisTool } from './components/redis/RedisTree';
import { Sidebar } from './components/Sidebar';
import { SyncMenu } from './components/sync/SyncMenu';
import { useTheme } from './components/theme';
import { Button, Icon } from './components/ui';
import { useConnections } from './state/connections';
import { keys, useProfiles } from './state/data';
import { runningCount, showJobs, useJobs, watchJobs } from './state/jobs';
import { usePanels } from './state/panels';
import { useWorkspace } from './state/workspace';

/**
 * The window: connections and objects on the left, dockable query tabs in the middle, history on
 * the right. The active tab's connection drives the production guardrail: a red frame around the
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
  const activePanelProfile = usePanels((state) =>
    activeId ? state.panels[activeId]?.profileId : undefined,
  );
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

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-9 shrink-0 items-center gap-2 border-b border-border bg-panel px-3">
        <span className="text-[13px] font-semibold tracking-tight">Joinery</span>
        {production && activeProfile && (
          <span
            role="status"
            data-testid="production-banner"
            className="rounded bg-env-production px-2 py-0.5 text-[11px] font-bold tracking-wide text-white uppercase"
          >
            Production · {activeProfile.name}
          </span>
        )}
        <span className="flex-1" />
        <Button
          size="sm"
          variant="ghost"
          onClick={newQuery}
          disabled={!activeTab && readyProfiles.length === 0}
        >
          <Icon name="plus" className="h-3.5 w-3.5" />
          New query
        </Button>
        <Button
          size="sm"
          variant={historyOpen ? 'secondary' : 'ghost'}
          onClick={() => setHistoryOpen(!historyOpen)}
          aria-pressed={historyOpen}
        >
          <Icon name="history" className="h-3.5 w-3.5" />
          History
        </Button>
        <SyncMenu />
        <Button
          size="sm"
          variant={jobsOpen ? 'secondary' : 'ghost'}
          onClick={() => showJobs(!jobsOpen)}
          aria-pressed={jobsOpen}
        >
          Jobs
          {jobsRunning > 0 && (
            <span
              className="rounded bg-accent px-1 text-[10px] text-accent-fg"
              aria-label={`${jobsRunning} running`}
            >
              {jobsRunning}
            </span>
          )}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => void toggleTheme()}
          aria-label="Switch theme"
        >
          {theme === 'dark' ? 'Light theme' : 'Dark theme'}
        </Button>
      </header>
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
      <HostKeyPrompts />
      <TransferDialogs />
      <TransferDbHost />
      <BackupDialogs />
      {dialog && <ConnectionDialog mode={dialog} onClose={() => setDialog(undefined)} />}
    </div>
  );
}
