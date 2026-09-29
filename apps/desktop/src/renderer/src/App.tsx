import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';

import { mainApi } from './lib/main-client';
import { ConnectionDialog, type ConnectionDialogMode } from './components/ConnectionDialog';
import { Dock, openQueryTab } from './components/dock';
import { HistoryPanel } from './components/HistoryPanel';
import { Prompts } from './components/Prompts';
import { Sidebar } from './components/Sidebar';
import { useTheme } from './components/theme';
import { Button, Icon } from './components/ui';
import { useConnections } from './state/connections';
import { keys, useProfiles } from './state/data';
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
  const profiles = useProfiles();
  const activeTab = useWorkspace((state) =>
    state.activeTabId ? state.tabs[state.activeTabId] : undefined,
  );
  const activeProfile = profiles.data?.find((p) => p.id === activeTab?.profileId);
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

  const toggleTheme = async (): Promise<void> => {
    await mainApi().settings.set({ theme: theme === 'dark' ? 'light' : 'dark' });
    await queryClient.invalidateQueries({ queryKey: keys.settings });
  };

  const newQuery = (): void => {
    const profileId = activeTab?.profileId ?? readyProfiles[0];
    const profile = profiles.data?.find((p) => p.id === profileId);
    if (profile) openQueryTab({ profileId: profile.id, title: `${profile.name} query` });
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
      </div>
      {production && (
        <div
          aria-hidden="true"
          data-testid="production-frame"
          className="pointer-events-none fixed inset-0 z-30 border-[3px] border-env-production"
        />
      )}
      <Prompts />
      {dialog && <ConnectionDialog mode={dialog} onClose={() => setDialog(undefined)} />}
    </div>
  );
}
