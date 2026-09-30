import type { ReactNode } from 'react';

import { useSearchView, type SearchView, type SearchViewState } from '../../state/search/view';
import { Button, Icon, cx } from '../ui';

/** Small pieces the Elasticsearch / OpenSearch panels share: notices, tabs, sizes, bars. */

/** "1.2 GB" for a byte count. */
export function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

/** The panel's notice line (success, info or error), dismissable. */
export function NoticeBar<S extends SearchViewState>({ view }: { readonly view: SearchView<S> }) {
  const notice = useSearchView(view, (s) => s.notice);
  if (!notice) return null;
  return (
    <div
      role={notice.kind === 'error' ? 'alert' : 'status'}
      data-testid="search-notice"
      className={cx(
        'flex items-start gap-2 border-b border-border px-3 py-1 text-xs',
        notice.kind === 'error' && 'bg-danger/10 text-danger',
        notice.kind === 'success' && 'bg-success/10 text-success',
        notice.kind === 'info' && 'bg-panel-2 text-fg',
      )}
    >
      <span className="min-w-0 flex-1 whitespace-pre-wrap">{notice.text}</span>
      <button type="button" aria-label="Dismiss" onClick={() => view.dismissNotice()}>
        <Icon name="close" className="h-3 w-3" />
      </button>
    </div>
  );
}

/** A row of tabs (buttons with `role="tab"`). */
export function Tabs<T extends string>(props: {
  readonly tabs: readonly { readonly id: T; readonly label: string }[];
  readonly active: T;
  readonly onSelect: (id: T) => void;
  readonly label: string;
  readonly end?: ReactNode;
}) {
  return (
    <div
      className="flex items-center gap-1 border-b border-border bg-panel px-2 pt-1"
      role="tablist"
      aria-label={props.label}
    >
      {props.tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          aria-selected={tab.id === props.active}
          className={cx(
            '-mb-px rounded-t border border-b-0 px-3 py-1 text-xs',
            tab.id === props.active
              ? 'border-border bg-bg text-fg'
              : 'border-transparent text-muted hover:text-fg',
          )}
          onClick={() => props.onSelect(tab.id)}
        >
          {tab.label}
        </button>
      ))}
      <span className="flex-1" />
      {props.end}
    </div>
  );
}

/** Label/value pairs in a two-column grid. */
export function Facts(props: {
  readonly items: readonly (readonly [string, ReactNode])[];
  readonly testId?: string;
}) {
  return (
    <dl
      className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-xs"
      data-testid={props.testId}
    >
      {props.items.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="text-muted">{label}</dt>
          <dd className="min-w-0 truncate">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** A horizontal usage bar with optional markers (disk watermarks). */
export function UsageBar(props: {
  readonly percent: number | null;
  readonly markers?: readonly { readonly at: number; readonly label: string }[];
  readonly label: string;
}) {
  const percent = props.percent ?? 0;
  const level =
    props.markers && props.markers.length > 0
      ? props.markers.filter((m) => percent >= m.at).length
      : percent >= 90
        ? 2
        : percent >= 75
          ? 1
          : 0;
  return (
    <div
      className="relative h-2 w-full rounded bg-panel-2"
      role="meter"
      aria-label={props.label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={props.percent ?? undefined}
    >
      <div
        className={cx(
          'h-2 rounded',
          level === 0 && 'bg-success',
          level === 1 && 'bg-warning',
          level >= 2 && 'bg-danger',
        )}
        style={{ width: `${Math.min(100, percent)}%` }}
      />
      {props.markers?.map((marker) => (
        <span
          key={marker.label}
          title={`${marker.label}: ${marker.at}%`}
          className="absolute -top-0.5 h-3 w-px bg-fg/60"
          style={{ left: `${marker.at}%` }}
        />
      ))}
    </div>
  );
}

/** A panel toolbar with a Refresh button at its end. */
export function Toolbar(props: {
  readonly label: string;
  readonly children?: ReactNode;
  readonly onRefresh?: () => void;
  readonly loading?: boolean;
}) {
  return (
    <div
      className="flex flex-wrap items-center gap-1.5 border-b border-border bg-panel px-2 py-1"
      role="toolbar"
      aria-label={props.label}
    >
      {props.children}
      <span className="flex-1" />
      {props.loading && <span className="text-[11px] text-muted">Loading…</span>}
      {props.onRefresh && (
        <Button size="sm" variant="ghost" onClick={props.onRefresh}>
          <Icon name="refresh" className="h-3.5 w-3.5" />
          Refresh
        </Button>
      )}
    </div>
  );
}
