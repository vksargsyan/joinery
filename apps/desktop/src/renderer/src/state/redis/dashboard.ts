import {
  infoMetrics,
  parseKeyspace,
  parseReplication,
  serverIdentity,
  type InfoMetrics,
  type InfoSections,
  type KeyspaceEntry,
  type ReplicationInfo,
} from '@querybara/redis-tools';

/**
 * The INFO dashboard (spec §10, §15): INFO polled at the user-set interval (5 s by default),
 * the samples kept for the session, and the numbers the tiles and sparklines show. In Cluster
 * mode each sample sums every primary.
 */

export const DEFAULT_POLL_MS = 5_000;
export const POLL_CHOICES_MS = [1_000, 2_000, 5_000, 10_000, 30_000, 60_000];
/** Samples kept: an hour at the default interval. */
export const MAX_SAMPLES = 720;

export interface DashboardSample {
  /** Local time of the poll, Unix ms. */
  readonly at: number;
  readonly metrics: InfoMetrics;
  /** The INFO sections of the first node (identity, keyspace and replication). */
  readonly info: InfoSections;
  /** Nodes summed into the sample (1 outside Cluster mode). */
  readonly nodes: number;
}

function sum(values: readonly (number | undefined)[]): number | undefined {
  const known = values.filter((v): v is number => v !== undefined);
  return known.length === 0 ? undefined : known.reduce((a, b) => a + b, 0);
}

/** One sample from the INFO of every node polled (one outside Cluster mode). */
export function sampleFrom(at: number, infos: readonly InfoSections[]): DashboardSample {
  const all = infos.map(infoMetrics);
  const first = all[0];
  if (!first || all.length === 1) {
    return { at, metrics: first ?? infoMetrics({}), info: infos[0] ?? {}, nodes: infos.length };
  }
  const pick = <K extends keyof InfoMetrics>(key: K): ((InfoMetrics[K] & number) | undefined)[] =>
    all.map((m) => m[key] as (InfoMetrics[K] & number) | undefined);
  const hits = sum(pick('keyspaceHits'));
  const misses = sum(pick('keyspaceMisses'));
  const metrics: InfoMetrics = {
    ...first,
    usedMemory: sum(pick('usedMemory')),
    usedMemoryPeak: sum(pick('usedMemoryPeak')),
    usedMemoryRss: sum(pick('usedMemoryRss')),
    maxMemory: sum(pick('maxMemory')),
    opsPerSec: sum(pick('opsPerSec')),
    connectedClients: sum(pick('connectedClients')),
    blockedClients: sum(pick('blockedClients')),
    keyspaceHits: hits,
    keyspaceMisses: misses,
    hitRatio:
      hits !== undefined && misses !== undefined && hits + misses > 0
        ? hits / (hits + misses)
        : undefined,
    totalKeys: all.reduce((n, m) => n + m.totalKeys, 0),
    totalExpires: all.reduce((n, m) => n + m.totalExpires, 0),
    expiredKeys: sum(pick('expiredKeys')),
    evictedKeys: sum(pick('evictedKeys')),
    inputKbps: sum(pick('inputKbps')),
    outputKbps: sum(pick('outputKbps')),
  };
  return { at, metrics, info: infos[0] ?? {}, nodes: infos.length };
}

/** Appends a sample, keeping the newest `max`. */
export function pushSample(
  samples: readonly DashboardSample[],
  sample: DashboardSample,
  max = MAX_SAMPLES,
): DashboardSample[] {
  const next = [...samples, sample];
  return next.length > max ? next.slice(next.length - max) : next;
}

export interface DashboardView {
  readonly server?: { readonly flavor: string; readonly version: string; readonly mode?: string };
  readonly uptimeSeconds?: number;
  readonly memory: {
    readonly used?: number;
    readonly peak?: number;
    readonly rss?: number;
    readonly max?: number;
    readonly fragmentation?: number;
    /** used / maxmemory, 0..1, when a limit is set. */
    readonly usedShare?: number;
  };
  readonly opsPerSec?: number;
  readonly clients: { readonly connected?: number; readonly blocked?: number };
  /** Lifetime hit ratio (since the stats were reset), 0..1. */
  readonly hitRatio?: number;
  /** Hit ratio over the last polling interval, from the counters' deltas, 0..1. */
  readonly recentHitRatio?: number;
  readonly keys: { readonly total: number; readonly withExpiry: number };
  readonly keyspace: readonly KeyspaceEntry[];
  readonly replication: ReplicationInfo;
  readonly network: { readonly inputKbps?: number; readonly outputKbps?: number };
  readonly evictedKeys?: number;
  readonly expiredKeys?: number;
  /** Series for the sparklines, oldest first. */
  readonly series: {
    readonly memory: readonly number[];
    readonly opsPerSec: readonly number[];
    readonly clients: readonly number[];
    readonly hitRatio: readonly number[];
  };
}

function series(
  samples: readonly DashboardSample[],
  read: (m: InfoMetrics) => number | undefined,
): number[] {
  return samples.map((s) => read(s.metrics)).filter((v): v is number => v !== undefined);
}

/** The ratio of the hits and misses counted between two samples (counters are cumulative). */
function windowRatio(a: DashboardSample, b: DashboardSample): number | undefined {
  const hits = (b.metrics.keyspaceHits ?? 0) - (a.metrics.keyspaceHits ?? 0);
  const misses = (b.metrics.keyspaceMisses ?? 0) - (a.metrics.keyspaceMisses ?? 0);
  // A reset (CONFIG RESETSTAT, restart) makes the deltas negative: no ratio for that window.
  if (hits < 0 || misses < 0 || hits + misses === 0) return undefined;
  return hits / (hits + misses);
}

/** Everything the dashboard shows, from the samples so far. */
export function deriveDashboard(samples: readonly DashboardSample[]): DashboardView {
  const last = samples.at(-1);
  const previous = samples.at(-2);
  const m = last?.metrics;
  const identity = last ? serverIdentity(last.info) : undefined;
  const ratios: number[] = [];
  for (let i = 1; i < samples.length; i++) {
    const ratio = windowRatio(samples[i - 1]!, samples[i]!);
    if (ratio !== undefined) ratios.push(ratio);
  }
  const recent = last && previous ? windowRatio(previous, last) : undefined;
  return {
    ...(identity && identity.redisVersion !== ''
      ? {
          server: {
            flavor: identity.flavor,
            version: identity.version,
            ...(identity.mode !== undefined ? { mode: identity.mode } : {}),
          },
        }
      : {}),
    ...(m?.uptimeSeconds !== undefined ? { uptimeSeconds: m.uptimeSeconds } : {}),
    memory: {
      ...(m?.usedMemory !== undefined ? { used: m.usedMemory } : {}),
      ...(m?.usedMemoryPeak !== undefined ? { peak: m.usedMemoryPeak } : {}),
      ...(m?.usedMemoryRss !== undefined ? { rss: m.usedMemoryRss } : {}),
      ...(m?.maxMemory ? { max: m.maxMemory } : {}),
      ...(m?.fragmentationRatio !== undefined ? { fragmentation: m.fragmentationRatio } : {}),
      ...(m?.maxMemory && m.usedMemory !== undefined
        ? { usedShare: m.usedMemory / m.maxMemory }
        : {}),
    },
    ...(m?.opsPerSec !== undefined ? { opsPerSec: m.opsPerSec } : {}),
    clients: {
      ...(m?.connectedClients !== undefined ? { connected: m.connectedClients } : {}),
      ...(m?.blockedClients !== undefined ? { blocked: m.blockedClients } : {}),
    },
    ...(m?.hitRatio !== undefined ? { hitRatio: m.hitRatio } : {}),
    ...(recent !== undefined ? { recentHitRatio: recent } : {}),
    keys: { total: m?.totalKeys ?? 0, withExpiry: m?.totalExpires ?? 0 },
    keyspace: last ? parseKeyspace(last.info) : [],
    replication: parseReplication(last?.info ?? {}),
    network: {
      ...(m?.inputKbps !== undefined ? { inputKbps: m.inputKbps } : {}),
      ...(m?.outputKbps !== undefined ? { outputKbps: m.outputKbps } : {}),
    },
    ...(m?.evictedKeys !== undefined ? { evictedKeys: m.evictedKeys } : {}),
    ...(m?.expiredKeys !== undefined ? { expiredKeys: m.expiredKeys } : {}),
    series: {
      memory: series(samples, (x) => x.usedMemory),
      opsPerSec: series(samples, (x) => x.opsPerSec),
      clients: series(samples, (x) => x.connectedClients),
      hitRatio: ratios,
    },
  };
}

/**
 * An SVG path for a sparkline of `values` in a width × height box (y grows down; the lowest
 * value sits on the bottom edge). Empty for no values; a flat line for a constant series.
 */
export function sparklinePath(values: readonly number[], width: number, height: number): string {
  if (values.length === 0) return '';
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min;
  const step = values.length > 1 ? width / (values.length - 1) : 0;
  const y = (v: number): number => (span === 0 ? height / 2 : height - ((v - min) / span) * height);
  return values
    .map((v, i) => `${i === 0 ? 'M' : 'L'}${(i * step).toFixed(1)},${y(v).toFixed(1)}`)
    .join(' ');
}

/** "3 d 4 h", "2 h 5 min", "42 s". */
export function formatUptime(seconds: number): string {
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ${minutes % 60} min`;
  return `${Math.floor(hours / 24)} d ${hours % 24} h`;
}
