/**
 * INFO parsing for the dashboard and server tools (spec §10, §15). INFO is text: `# Section`
 * headers, then `field:value` lines; some values are `k=v,k=v` lists (keyspace, replicas,
 * command stats).
 */

/** Sections by lower-case name ("server", "memory", "keyspace"...), then field → value. */
export type InfoSections = Readonly<Record<string, Readonly<Record<string, string>>>>;

/**
 * Parses INFO text. Fields before any header land in the "default" section. Unknown sections
 * and fields are kept, so newer servers need no parser change.
 */
export function parseInfo(text: string): InfoSections {
  const sections: Record<string, Record<string, string>> = {};
  let current = 'default';
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '') continue;
    if (line.startsWith('#')) {
      current = line.replace(/^#\s*/, '').trim().toLowerCase();
      sections[current] ??= {};
      continue;
    }
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    (sections[current] ??= {})[line.slice(0, colon)] = line.slice(colon + 1);
  }
  return sections;
}

/** A field from any section (the first section that has it). */
export function infoField(info: InfoSections, field: string): string | undefined {
  for (const section of Object.values(info)) {
    const value = section[field];
    if (value !== undefined) return value;
  }
  return undefined;
}

/** "keys=1,expires=0,avg_ttl=0" → { keys: "1", expires: "0", avg_ttl: "0" }. */
export function parseFieldList(value: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of value.split(',')) {
    const eq = part.indexOf('=');
    if (eq > 0) out[part.slice(0, eq)] = part.slice(eq + 1);
  }
  return out;
}

function num(value: string | undefined): number | undefined {
  if (value === undefined || value === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

export interface KeyspaceEntry {
  readonly db: number;
  readonly keys: number;
  readonly expires: number;
  readonly avgTtlMs: number;
}

/** The keyspace section: one entry per logical database that has keys, by DB number. */
export function parseKeyspace(info: InfoSections): KeyspaceEntry[] {
  const out: KeyspaceEntry[] = [];
  for (const [field, value] of Object.entries(info['keyspace'] ?? {})) {
    const match = /^db(\d+)$/.exec(field);
    if (!match) continue;
    const f = parseFieldList(value);
    out.push({
      db: Number(match[1]),
      keys: num(f['keys']) ?? 0,
      expires: num(f['expires']) ?? 0,
      avgTtlMs: num(f['avg_ttl']) ?? 0,
    });
  }
  return out.sort((a, b) => a.db - b.db);
}

export interface ReplicaLink {
  readonly ip: string;
  readonly port: number;
  readonly state: string;
  readonly offset: number;
  readonly lag: number;
}

export interface ReplicationInfo {
  /** "master" or "slave" as INFO reports it; `isReplica` says which. */
  readonly role: string;
  readonly isReplica: boolean;
  readonly connectedReplicas: number;
  readonly replicas: readonly ReplicaLink[];
  /** Set on a replica. */
  readonly master?: {
    readonly host: string;
    readonly port: number;
    readonly linkStatus: string;
    readonly lastIoSecondsAgo?: number;
    readonly syncInProgress: boolean;
  };
  readonly masterReplOffset?: number;
  readonly replId?: string;
}

/** The replication section: role, the replicas of a primary, or the primary of a replica. */
export function parseReplication(info: InfoSections): ReplicationInfo {
  const r = info['replication'] ?? {};
  const role = r['role'] ?? 'master';
  const replicas: ReplicaLink[] = [];
  for (const [field, value] of Object.entries(r)) {
    if (!/^slave\d+$/.test(field)) continue;
    const f = parseFieldList(value);
    replicas.push({
      ip: f['ip'] ?? '',
      port: num(f['port']) ?? 0,
      state: f['state'] ?? '',
      offset: num(f['offset']) ?? 0,
      lag: num(f['lag']) ?? 0,
    });
  }
  const out: {
    -readonly [K in keyof ReplicationInfo]: ReplicationInfo[K];
  } = {
    role,
    isReplica: role === 'slave' || role === 'replica',
    connectedReplicas: num(r['connected_slaves']) ?? replicas.length,
    replicas,
  };
  if (r['master_host'] !== undefined) {
    const lastIo = num(r['master_last_io_seconds_ago']);
    out.master = {
      host: r['master_host'],
      port: num(r['master_port']) ?? 0,
      linkStatus: r['master_link_status'] ?? '',
      ...(lastIo !== undefined ? { lastIoSecondsAgo: lastIo } : {}),
      syncInProgress: r['master_sync_in_progress'] === '1',
    };
  }
  const offset = num(r['master_repl_offset']);
  if (offset !== undefined) out.masterReplOffset = offset;
  if (r['master_replid'] !== undefined) out.replId = r['master_replid'];
  return out;
}

export interface CommandStat {
  /** Lower case; subcommands as "config|get". */
  readonly command: string;
  readonly calls: number;
  readonly usec: number;
  readonly usecPerCall: number;
  readonly rejectedCalls: number;
  readonly failedCalls: number;
}

/** The commandstats section, most-called first. */
export function parseCommandStats(info: InfoSections): CommandStat[] {
  const out: CommandStat[] = [];
  for (const [field, value] of Object.entries(info['commandstats'] ?? {})) {
    if (!field.startsWith('cmdstat_')) continue;
    const f = parseFieldList(value);
    out.push({
      command: field.slice('cmdstat_'.length),
      calls: num(f['calls']) ?? 0,
      usec: num(f['usec']) ?? 0,
      usecPerCall: num(f['usec_per_call']) ?? 0,
      rejectedCalls: num(f['rejected_calls']) ?? 0,
      failedCalls: num(f['failed_calls']) ?? 0,
    });
  }
  return out.sort((a, b) => b.calls - a.calls || a.command.localeCompare(b.command));
}

/** The errorstats section: error prefix → count. */
export function parseErrorStats(info: InfoSections): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [field, value] of Object.entries(info['errorstats'] ?? {})) {
    if (field.startsWith('errorstat_')) {
      out[field.slice('errorstat_'.length)] = num(parseFieldList(value)['count']) ?? 0;
    }
  }
  return out;
}

/** The latencystats section (Redis 7+): command → percentile ("p50", "p99"...) → microseconds. */
export function parseLatencyStats(info: InfoSections): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {};
  for (const [field, value] of Object.entries(info['latencystats'] ?? {})) {
    if (!field.startsWith('latency_percentiles_usec_')) continue;
    const percentiles: Record<string, number> = {};
    for (const [p, v] of Object.entries(parseFieldList(value))) {
      const n = num(v);
      if (n !== undefined) percentiles[p] = n;
    }
    out[field.slice('latency_percentiles_usec_'.length)] = percentiles;
  }
  return out;
}

export interface ServerIdentity {
  /** Valkey reports `server_name:valkey` (and `valkey_version`); anything else is Redis. */
  readonly flavor: 'redis' | 'valkey';
  /** The product version: valkey_version on Valkey, redis_version otherwise. */
  readonly version: string;
  /** redis_version as reported (Valkey keeps a Redis-compatible value here). */
  readonly redisVersion: string;
  /** redis_mode: standalone, sentinel or cluster. */
  readonly mode?: string;
}

/** Who the server is, from the server section. */
export function serverIdentity(info: InfoSections): ServerIdentity {
  const server = info['server'] ?? info['default'] ?? {};
  const redisVersion = server['redis_version'] ?? '';
  const valkey =
    server['server_name']?.toLowerCase() === 'valkey' || server['valkey_version'] !== undefined;
  const mode = server['server_mode'] ?? server['redis_mode'];
  return {
    flavor: valkey ? 'valkey' : 'redis',
    version: (valkey ? server['valkey_version'] : undefined) ?? redisVersion,
    redisVersion,
    ...(mode !== undefined ? { mode } : {}),
  };
}

/** The numbers the INFO dashboard charts (spec §10). Missing fields are undefined. */
export interface InfoMetrics {
  readonly usedMemory?: number;
  readonly usedMemoryPeak?: number;
  readonly usedMemoryRss?: number;
  readonly maxMemory?: number;
  readonly fragmentationRatio?: number;
  readonly opsPerSec?: number;
  readonly connectedClients?: number;
  readonly blockedClients?: number;
  readonly keyspaceHits?: number;
  readonly keyspaceMisses?: number;
  /** hits / (hits + misses), 0..1; undefined before any lookup. */
  readonly hitRatio?: number;
  readonly totalKeys: number;
  readonly totalExpires: number;
  readonly expiredKeys?: number;
  readonly evictedKeys?: number;
  readonly inputKbps?: number;
  readonly outputKbps?: number;
  readonly uptimeSeconds?: number;
  readonly role?: string;
  readonly connectedReplicas?: number;
}

export function infoMetrics(info: InfoSections): InfoMetrics {
  const f = (name: string): number | undefined => num(infoField(info, name));
  const hits = f('keyspace_hits');
  const misses = f('keyspace_misses');
  const keyspace = parseKeyspace(info);
  return {
    usedMemory: f('used_memory'),
    usedMemoryPeak: f('used_memory_peak'),
    usedMemoryRss: f('used_memory_rss'),
    maxMemory: f('maxmemory'),
    fragmentationRatio: f('mem_fragmentation_ratio'),
    opsPerSec: f('instantaneous_ops_per_sec'),
    connectedClients: f('connected_clients'),
    blockedClients: f('blocked_clients'),
    keyspaceHits: hits,
    keyspaceMisses: misses,
    hitRatio:
      hits !== undefined && misses !== undefined && hits + misses > 0
        ? hits / (hits + misses)
        : undefined,
    totalKeys: keyspace.reduce((sum, k) => sum + k.keys, 0),
    totalExpires: keyspace.reduce((sum, k) => sum + k.expires, 0),
    expiredKeys: f('expired_keys'),
    evictedKeys: f('evicted_keys'),
    inputKbps: f('instantaneous_input_kbps'),
    outputKbps: f('instantaneous_output_kbps'),
    uptimeSeconds: f('uptime_in_seconds'),
    role: infoField(info, 'role'),
    connectedReplicas: f('connected_slaves'),
  };
}
