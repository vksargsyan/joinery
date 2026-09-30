import type {
  MonitorSection,
  MonitorSnapshot,
  MonitorTile,
  ServerNotice,
  ValueUnit,
} from '@joinery/core';
import { create } from 'zustand';

import { DEFAULT_POLL_MS, MAX_SAMPLES } from '../redis/dashboard';
import { formatValue } from './format';

/**
 * The monitoring view's history (spec §15): snapshots polled at the user-set interval (5 s by
 * default) and kept per connection for the app session, so reopening the server tools shows
 * what was collected before; and the tiles derived from them: gauges as read, counters turned
 * into per-second rates and counter pairs into ratios over each polling interval, the way the
 * Redis INFO dashboard derives its hit ratio.
 */

export interface MonitorHistory {
  readonly samples: readonly MonitorSnapshot[];
  readonly error: string | undefined;
  readonly intervalMs: number;
  readonly paused: boolean;
}

const EMPTY: MonitorHistory = {
  samples: [],
  error: undefined,
  intervalMs: DEFAULT_POLL_MS,
  paused: false,
};

export const useMonitorHistory = create<{
  readonly byProfile: Readonly<Record<string, MonitorHistory>>;
}>()(() => ({ byProfile: {} }));

export function monitorHistory(profileId: string): MonitorHistory {
  return useMonitorHistory.getState().byProfile[profileId] ?? EMPTY;
}

function patch(profileId: string, next: Partial<MonitorHistory>): void {
  useMonitorHistory.setState((state) => ({
    byProfile: { ...state.byProfile, [profileId]: { ...monitorHistory(profileId), ...next } },
  }));
}

/** Appends a sample, keeping the newest `max`. */
export function pushSample<T>(samples: readonly T[], sample: T, max = MAX_SAMPLES): T[] {
  const next = [...samples, sample];
  return next.length > max ? next.slice(next.length - max) : next;
}

export function recordSnapshot(profileId: string, snapshot: MonitorSnapshot): void {
  patch(profileId, {
    samples: pushSample(monitorHistory(profileId).samples, snapshot),
    error: undefined,
  });
}

export function recordMonitorError(profileId: string, error: string): void {
  patch(profileId, { error });
}

export function setMonitorInterval(profileId: string, intervalMs: number): void {
  patch(profileId, { intervalMs });
}

export function setMonitorPaused(profileId: string, paused: boolean): void {
  patch(profileId, { paused });
}

export function clearMonitorHistory(profileId: string): void {
  patch(profileId, { samples: [], error: undefined });
}

export interface TileView {
  readonly id: string;
  readonly label: string;
  /** The current value, formatted. */
  readonly value: string;
  readonly detail: string | undefined;
  /** For the sparkline, oldest first. */
  readonly series: readonly number[];
  readonly unit: ValueUnit;
}

export interface MonitorView {
  readonly tiles: readonly TileView[];
  readonly sections: readonly MonitorSection[];
  readonly notices: readonly ServerNotice[];
  readonly uptimeSeconds: number | null;
  readonly samples: number;
}

function tileIn(snapshot: MonitorSnapshot, id: string): MonitorTile | undefined {
  return snapshot.tiles.find((t) => t.id === id);
}

/** The per-second rate between two readings of a counter; undefined across a reset. */
export function rateBetween(
  a: { readonly at: number; readonly value: number | null },
  b: { readonly at: number; readonly value: number | null },
): number | undefined {
  if (a.value === null || b.value === null) return undefined;
  const seconds = (b.at - a.at) / 1000;
  const delta = b.value - a.value;
  if (seconds <= 0 || delta < 0) return undefined;
  return delta / seconds;
}

/** hits / total over one interval; undefined when nothing was counted or the counters reset. */
export function ratioBetween(
  a: { readonly hits: number | null; readonly total: number | null },
  b: { readonly hits: number | null; readonly total: number | null },
): number | undefined {
  if (a.hits === null || b.hits === null || a.total === null || b.total === null) return undefined;
  const hits = b.hits - a.hits;
  const total = b.total - a.total;
  if (total <= 0 || hits < 0) return undefined;
  return hits / total;
}

function deriveTile(samples: readonly MonitorSnapshot[], tile: MonitorTile): TileView {
  const history = samples
    .map((s) => ({ at: s.at, tile: tileIn(s, tile.id) }))
    .filter((h): h is { at: number; tile: MonitorTile } => h.tile?.kind === tile.kind);
  switch (tile.kind) {
    case 'gauge': {
      const series = history
        .map((h) => (h.tile.kind === 'gauge' ? h.tile.value : null))
        .filter((v): v is number => v !== null);
      return {
        id: tile.id,
        label: tile.label,
        value: formatValue(tile.value, tile.unit),
        detail: tile.detail,
        series,
        unit: tile.unit,
      };
    }
    case 'rate': {
      const series: number[] = [];
      for (let i = 1; i < history.length; i++) {
        const a = history[i - 1]!;
        const b = history[i]!;
        if (a.tile.kind !== 'rate' || b.tile.kind !== 'rate') continue;
        const rate = rateBetween(
          { at: a.at, value: a.tile.counter },
          { at: b.at, value: b.tile.counter },
        );
        if (rate !== undefined) series.push(rate);
      }
      const last = series.at(-1);
      const text =
        history.length < 2 ? '…' : last === undefined ? '—' : formatValue(last, tile.unit);
      return {
        id: tile.id,
        label: tile.label,
        value: tile.unit === 'bytes' && last !== undefined ? `${text}/s` : text,
        detail: tile.detail,
        series,
        unit: tile.unit,
      };
    }
    case 'ratio': {
      const unit = tile.unit ?? 'ratio';
      const series: number[] = [];
      for (let i = 1; i < history.length; i++) {
        const a = history[i - 1]!.tile;
        const b = history[i]!.tile;
        if (a.kind !== 'ratio' || b.kind !== 'ratio') continue;
        const ratio = ratioBetween(a, b);
        if (ratio !== undefined) series.push(ratio);
      }
      // Before a second sample (or in an idle interval), the ratio since the counters started.
      const previous = history.at(-2)?.tile;
      const recent = previous?.kind === 'ratio' ? ratioBetween(previous, tile) : undefined;
      const lifetime =
        tile.hits !== null && tile.total !== null && tile.total > 0
          ? tile.hits / tile.total
          : undefined;
      return {
        id: tile.id,
        label: tile.label,
        value: formatValue(recent ?? lifetime, unit),
        detail: [
          tile.detail,
          recent === undefined && lifetime !== undefined ? 'since start' : undefined,
        ]
          .filter(Boolean)
          .join(' · '),
        series,
        unit,
      };
    }
  }
}

/** Everything the monitoring view shows, from the samples so far. */
export function deriveMonitor(samples: readonly MonitorSnapshot[]): MonitorView {
  const last = samples.at(-1);
  return {
    tiles: last ? last.tiles.map((tile) => deriveTile(samples, tile)) : [],
    sections: last?.sections ?? [],
    notices: last?.notices ?? [],
    uptimeSeconds: last?.uptimeSeconds ?? null,
    samples: samples.length,
  };
}
