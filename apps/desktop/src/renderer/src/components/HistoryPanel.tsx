import { useEffect, useState } from 'react';

import { formatDuration, formatRows } from '../lib/format';
import { useHistory, useProfiles } from '../state/data';
import { useWorkspace } from '../state/workspace';
import { openQueryTab } from './dock';
import { Button, Icon, Input, cx } from './ui';

/**
 * Query history (spec §6): every run with its connection, duration, rows and status, newest
 * first, searchable across all connections or the active tab's one. Opening an entry puts its
 * text in a new query tab.
 */
export function HistoryPanel(props: { readonly onClose: () => void }) {
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [onlyActive, setOnlyActive] = useState(false);
  const activeProfile = useWorkspace((state) =>
    state.activeTabId ? state.tabs[state.activeTabId]?.profileId : undefined,
  );
  const profiles = useProfiles();
  const history = useHistory(debounced, onlyActive ? activeProfile : undefined);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(query), 200);
    return () => clearTimeout(timer);
  }, [query]);

  const nameOf = (id: string): string =>
    profiles.data?.find((p) => p.id === id)?.name ?? 'Deleted connection';

  return (
    <aside
      className="flex h-full flex-col border-l border-border bg-panel"
      aria-label="Query history"
    >
      <div className="flex items-center gap-2 border-b border-border px-2 py-1.5">
        <h2 className="flex-1 text-xs font-semibold tracking-wide text-muted uppercase">History</h2>
        <Button size="sm" variant="ghost" onClick={props.onClose} aria-label="Close history">
          <Icon name="close" className="h-3 w-3" />
        </Button>
      </div>
      <div className="flex flex-col gap-1.5 border-b border-border p-2">
        <Input
          type="search"
          placeholder="Search statements"
          aria-label="Search history"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <label className="flex items-center gap-1.5 text-xs text-muted">
          <input
            type="checkbox"
            checked={onlyActive}
            disabled={!activeProfile}
            onChange={(event) => setOnlyActive(event.target.checked)}
          />
          Only the active tab's connection
        </label>
      </div>
      <ol className="min-h-0 flex-1 overflow-auto" data-testid="history-list">
        {history.data?.entries.length === 0 && (
          <li className="p-3 text-xs text-muted">No matching runs.</li>
        )}
        {history.data?.entries.map((entry) => (
          <li key={entry.id} className="group border-b border-border px-2 py-1.5 hover:bg-hover">
            <div className="flex items-center gap-1.5 text-[11px] text-muted">
              <span
                className={cx(
                  'h-1.5 w-1.5 rounded-full',
                  entry.status === 'success'
                    ? 'bg-success'
                    : entry.status === 'error'
                      ? 'bg-danger'
                      : 'bg-warning',
                )}
                aria-label={entry.status}
              />
              <span className="truncate">{nameOf(entry.profileId)}</span>
              <span className="flex-1" />
              <time dateTime={entry.executedAt}>{new Date(entry.executedAt).toLocaleString()}</time>
            </div>
            <pre className="mt-0.5 max-h-16 overflow-hidden font-mono text-xs whitespace-pre-wrap text-fg">
              {entry.text}
            </pre>
            <div className="mt-0.5 flex items-center gap-2 text-[11px] text-muted">
              {entry.durationMs !== null && <span>{formatDuration(entry.durationMs)}</span>}
              {entry.rowCount !== null && <span>{formatRows(entry.rowCount)}</span>}
              {entry.error && <span className="truncate text-danger">{entry.error}</span>}
              <span className="flex-1" />
              <Button
                size="sm"
                variant="ghost"
                className="opacity-0 group-hover:opacity-100 focus:opacity-100"
                onClick={() =>
                  openQueryTab({
                    profileId: entry.profileId,
                    title: `${nameOf(entry.profileId)} query`,
                    text: entry.text,
                  })
                }
              >
                Open
              </Button>
            </div>
          </li>
        ))}
      </ol>
    </aside>
  );
}
