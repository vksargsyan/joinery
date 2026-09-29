import { useRef } from 'react';

import { errorMessage } from '../../lib/errors';
import { POLL_CHOICES_MS, formatUptime } from '../../state/redis/dashboard';
import {
  clearMonitorHistory,
  deriveMonitor,
  monitorHistory,
  recordMonitorError,
  recordSnapshot,
  setMonitorInterval,
  setMonitorPaused,
  useMonitorHistory,
} from '../../state/server-tools/monitor';
import { panelState, serverToolsLane } from '../../state/server-tools/panels';
import { Notice, Stat, Toolbar, usePolling } from '../redis/common';
import { Sparkline } from '../redis/tools/DashboardPanel';
import { Button } from '../ui';
import { NoticeList, SectionTitle, ToolTableView, type TabProps } from './common';

/**
 * The monitoring view (spec §15): the engine's figures as tiles with sparklines, polled at
 * the user-set interval (5 s by default) with the history kept for the app session, and its
 * tables (databases, replication, locks, the oplog...) from the latest poll. The look and the
 * sparklines are the Redis INFO dashboard's.
 */

/**
 * Polls the monitor while the panel is open, whichever tab shows, so the history has no gaps
 * when the user looks at sessions or settings for a while.
 */
export function MonitorPoller(props: { readonly panelId: string }) {
  const { profileId } = panelState(props.panelId);
  const history = useMonitorHistory((state) => state.byProfile[profileId]);
  const busy = useRef(false);
  usePolling(
    () => {
      if (busy.current) return;
      busy.current = true;
      serverToolsLane(props.panelId)
        .run((host, sessionId) => host.serverTools.monitor({ sessionId }))
        .then(
          (snapshot) => recordSnapshot(profileId, snapshot),
          (e: unknown) => recordMonitorError(profileId, errorMessage(e)),
        )
        .finally(() => {
          busy.current = false;
        });
    },
    history?.intervalMs ?? monitorHistory(profileId).intervalMs,
    history?.paused ?? false,
  );
  return null;
}

export function MonitorTab({ panelId, info }: TabProps) {
  const { profileId } = panelState(panelId);
  const history =
    useMonitorHistory((state) => state.byProfile[profileId]) ?? monitorHistory(profileId);
  const view = deriveMonitor(history.samples);
  return (
    <div className="flex h-full flex-col" data-testid="server-monitor">
      <Toolbar label="Monitor">
        <label className="flex items-center gap-1 text-xs text-muted">
          Refresh every
          <select
            aria-label="Refresh interval"
            className="h-7 rounded border border-border bg-panel-2 px-1 text-xs text-fg"
            value={history.intervalMs}
            onChange={(e) => setMonitorInterval(profileId, Number(e.target.value))}
          >
            {POLL_CHOICES_MS.map((ms) => (
              <option key={ms} value={ms}>
                {ms / 1000} s
              </option>
            ))}
          </select>
        </label>
        <Button
          size="sm"
          onClick={() => setMonitorPaused(profileId, !history.paused)}
          aria-pressed={history.paused}
        >
          {history.paused ? 'Resume' : 'Pause'}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => clearMonitorHistory(profileId)}>
          Clear history
        </Button>
        <span className="flex-1" />
        <span className="text-xs text-muted" data-testid="monitor-status">
          {info.product} {info.version}
          {view.uptimeSeconds !== null && ` · up ${formatUptime(Math.round(view.uptimeSeconds))}`}
          {` · ${view.samples} ${view.samples === 1 ? 'sample' : 'samples'}`}
        </span>
      </Toolbar>
      {history.error && <Notice kind="error">{history.error}</Notice>}
      <NoticeList notices={view.notices} />
      <div className="min-h-0 flex-1 overflow-auto p-3">
        {view.samples === 0 && !history.error && (
          <p className="text-xs text-muted">Reading the server's statistics…</p>
        )}
        <div className="flex flex-wrap gap-3">
          {view.tiles.map((tile) => (
            <Stat key={tile.id} label={tile.label} value={tile.value} detail={tile.detail}>
              <Sparkline values={tile.series} label={tile.label} />
            </Stat>
          ))}
        </div>
        <div className="mt-4 grid gap-4 xl:grid-cols-2">
          {view.sections.map((section) => (
            <section key={section.id} data-testid={`monitor-section-${section.id}`}>
              <SectionTitle>{section.title}</SectionTitle>
              {section.notice && <NoticeList notices={[section.notice]} />}
              <ToolTableView table={section.table} label={section.title} empty={section.empty} />
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
