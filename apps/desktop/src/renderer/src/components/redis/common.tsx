import { displayBytes } from '@joinery/redis-tools';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

import { errorMessage } from '../../lib/errors';
import type { HostClient } from '../../lib/main-client';
import { connectionFacts, panelLane, type RedisConnectionFacts } from '../../state/redis/panels';
import { typeBadge } from '../../state/redis/value-model';
import { Icon, cx } from '../ui';

/** Building blocks shared by the Redis panels: toolbars, notices, badges and data hooks. */

export function Toolbar(props: { readonly children: ReactNode; readonly label: string }) {
  return (
    <div
      role="toolbar"
      aria-label={props.label}
      className="flex flex-wrap items-center gap-1.5 border-b border-border bg-panel px-2 py-1.5"
    >
      {props.children}
    </div>
  );
}

export function Separator() {
  return <span className="mx-1 h-5 w-px bg-border" />;
}

export function Notice(props: {
  readonly kind: 'error' | 'warning' | 'info';
  readonly children: ReactNode;
  readonly onClose?: () => void;
}) {
  return (
    <div
      role={props.kind === 'info' ? 'status' : 'alert'}
      className={cx(
        'flex items-center gap-2 border-b px-3 py-1.5 text-xs',
        props.kind === 'error' && 'border-danger/40 bg-danger/10 text-danger',
        props.kind === 'warning' && 'border-warning/30 bg-warning/10 text-warning',
        props.kind === 'info' && 'border-border bg-panel-2 text-muted',
      )}
    >
      {props.kind !== 'info' && <Icon name="warning" className="h-3.5 w-3.5" />}
      <span className="flex-1 whitespace-pre-wrap">{props.children}</span>
      {props.onClose && (
        <button
          type="button"
          aria-label="Dismiss"
          className="rounded p-0.5 hover:bg-hover"
          onClick={props.onClose}
        >
          <Icon name="close" className="h-3 w-3" />
        </button>
      )}
    </div>
  );
}

export function TypeBadge(props: { readonly type: string }) {
  const badge = typeBadge(props.type);
  return (
    <span
      data-testid="type-badge"
      className={cx(
        'inline-block min-w-11 rounded px-1 text-center text-[10px] font-semibold tracking-wide',
        badge.tone,
      )}
    >
      {badge.label}
    </span>
  );
}

/** Bytes as display text (binary-safe escapes), selectable, with the full value as a tooltip. */
export function BytesText(props: { readonly bytes: Uint8Array; readonly className?: string }) {
  const text = displayBytes(props.bytes);
  return (
    <span
      className={cx('font-mono whitespace-pre select-text', props.className)}
      title={text.length > 80 ? text.slice(0, 2000) : undefined}
    >
      {text}
    </span>
  );
}

/** The connection's server, nodes and command catalog (loaded once per connection). */
export function useConnectionFacts(profileId: string): {
  readonly facts: RedisConnectionFacts | undefined;
  readonly error: string | undefined;
} {
  const [facts, setFacts] = useState<RedisConnectionFacts>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    let live = true;
    connectionFacts(profileId).then(
      (loaded) => live && setFacts(loaded),
      (e: unknown) => live && setError(errorMessage(e)),
    );
    return () => {
      live = false;
    };
  }, [profileId]);
  return { facts, error };
}

/**
 * Loads data on the panel's session and keeps it with its error and loading state; `reload`
 * runs it again. The latest call wins when calls overlap.
 */
export function usePanelData<T>(
  panelId: string,
  load: (host: HostClient, sessionId: string) => Promise<T>,
  deps: readonly unknown[],
): {
  readonly data: T | undefined;
  readonly error: string | undefined;
  readonly loading: boolean;
  readonly reload: () => Promise<void>;
} {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const latest = useRef(0);
  const loadRef = useRef(load);
  loadRef.current = load;
  const reload = useCallback(async (): Promise<void> => {
    const call = ++latest.current;
    setLoading(true);
    try {
      const value = await panelLane(panelId).run((host, sessionId) =>
        loadRef.current(host, sessionId),
      );
      if (call !== latest.current) return;
      setData(value);
      setError(undefined);
    } catch (e) {
      if (call === latest.current) setError(errorMessage(e));
    } finally {
      if (call === latest.current) setLoading(false);
    }
  }, [panelId]);
  useEffect(() => {
    void reload();
    // `deps` are the caller's inputs to `load`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reload, ...deps]);
  return { data, error, loading, reload };
}

/** Calls `tick` every `intervalMs` while mounted and not paused (and once at the start). */
export function usePolling(tick: () => void, intervalMs: number, paused = false): void {
  const tickRef = useRef(tick);
  tickRef.current = tick;
  useEffect(() => {
    if (paused) return;
    tickRef.current();
    const timer = setInterval(() => tickRef.current(), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs, paused]);
}

/** A node picker for Cluster mode: every primary (or "All primaries" when `allowAll`). */
export function NodeSelect(props: {
  readonly facts: RedisConnectionFacts | undefined;
  readonly value: string | undefined;
  readonly onChange: (node: string | undefined) => void;
  readonly allowAll?: boolean;
  readonly label?: string;
}) {
  const nodes = props.facts?.info.nodes.filter((n) => n.role === 'primary') ?? [];
  if (!props.facts?.info.server.clusterMode) return null;
  return (
    <label className="flex items-center gap-1 text-xs text-muted">
      {props.label ?? 'Node'}
      <select
        aria-label={props.label ?? 'Node'}
        className="h-7 rounded border border-border bg-panel-2 px-1 text-xs text-fg"
        value={props.value ?? ''}
        onChange={(event) => props.onChange(event.target.value || undefined)}
      >
        {props.allowAll !== false && <option value="">All primaries</option>}
        {nodes.map((node) => (
          <option key={node.address} value={node.address}>
            {node.address}
          </option>
        ))}
      </select>
    </label>
  );
}

/** A small labelled figure for the dashboards. */
export function Stat(props: {
  readonly label: string;
  readonly value: ReactNode;
  readonly detail?: ReactNode;
  readonly children?: ReactNode;
}) {
  return (
    <div className="flex min-w-40 flex-1 flex-col gap-1 rounded border border-border bg-panel p-3">
      <span className="text-[11px] font-medium tracking-wide text-muted uppercase">
        {props.label}
      </span>
      <span className="text-lg font-semibold tabular-nums" data-testid={`stat-${props.label}`}>
        {props.value}
      </span>
      {props.detail !== undefined && <span className="text-xs text-muted">{props.detail}</span>}
      {props.children}
    </div>
  );
}

export function EmptyState(props: { readonly children: ReactNode }) {
  return <p className="p-4 text-center text-xs text-muted">{props.children}</p>;
}

export function timeText(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleString();
}
