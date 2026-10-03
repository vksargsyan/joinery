import type { Session } from '@querybara/core';
import type {
  AclLogEntry,
  AclUser,
  ClientInfo,
  ClusterNodeInfo,
  CommandCatalog,
  ConfigChange,
  InfoSections,
  LatencyEvent,
  LatencySample,
  PatternStats,
  RedisBytes,
  RedisReply,
  SearchFieldSuggestion,
  SearchIndexDefinition,
  SearchIndexInfo,
  SearchKeyType,
  SearchResult,
  SlowlogEntry,
} from '@querybara/redis-tools';

import type {
  ConfigApplyResult,
  ConfigNode,
  ConfigNodeOutcome,
  ConfigSnapshot,
  ConfigTarget,
} from './config-service';

/**
 * The Redis session API (spec §10, §15): the generic Session contract plus key services and
 * server tools. Keys, fields, members and values are bytes (Uint8Array); inputs also accept
 * text, which means its UTF-8 bytes. Everything returned survives structured clone.
 *
 * In Cluster mode, keyed operations are routed by hash slot; `node` options (a "host:port"
 * from `nodes()`) pick one node for keyless ones. Logical databases exist only outside Cluster.
 */

export type RedisTopology = 'standalone' | 'sentinel' | 'cluster';

export interface RedisModule {
  readonly name: string;
  readonly version: string;
}

/** What the session learned about the server when it connected. */
export interface RedisServerInfo {
  /** Valkey or Redis (Valkey reports server_name:valkey). */
  readonly flavor: 'redis' | 'valkey';
  /** The product version (Valkey's own version on Valkey). */
  readonly version: string;
  /** redis_version as reported (Valkey keeps a Redis-compatible number there). */
  readonly redisVersion: string;
  /** How Querybara reaches the server. */
  readonly topology: RedisTopology;
  /** Role of the node the session talks to (the first primary in Cluster mode). */
  readonly role: 'master' | 'replica' | 'unknown';
  /** Loaded modules (RedisJSON is "ReJSON", RediSearch "search"...). */
  readonly modules: readonly RedisModule[];
  /** Logical databases (1 in Cluster mode). */
  readonly databases: number;
  /** False when CONFIG GET databases was refused and the count comes from INFO keyspace. */
  readonly databasesExact: boolean;
  readonly clusterMode: boolean;
}

/** A server node: the one server, or a Cluster primary or replica. */
export interface RedisNode {
  /** "host:port"; pass it as `node` to target this node. */
  readonly address: string;
  readonly host: string;
  readonly port: number;
  readonly role: 'primary' | 'replica';
}

export interface CommandOptions {
  /** Cluster: the node to run a keyless command on (default: the key's slot owner, else the target node). */
  readonly node?: string;
}

/** A reply and the node that sent it. */
export interface NodeReply {
  readonly node: string;
  readonly reply: RedisReply;
}

// ---------------------------------------------------------------------------------------------
// Keys

export interface ScanOptions {
  /** "0" (or omitted) starts a scan; pass back `cursor` to continue. */
  readonly cursor?: string;
  /** Glob pattern (SCAN MATCH). */
  readonly match?: RedisBytes;
  /** Only keys of this type (SCAN TYPE, Redis 6+), e.g. "hash". */
  readonly type?: string;
  /** Work hint per SCAN call (SCAN COUNT); default 500. */
  readonly count?: number;
  /** Cluster: scan only this node instead of every primary. */
  readonly node?: string;
}

export interface ScanResult {
  readonly keys: Uint8Array[];
  /** "0" when the scan is complete. In Cluster mode a composite cursor over every primary. */
  readonly cursor: string;
  readonly done: boolean;
}

export interface ScanPageOptions extends ScanOptions {
  /** Stop once at least this many keys were collected. */
  readonly limit: number;
  /** At most this many SCAN round trips (default 50). */
  readonly maxCalls?: number;
  /** Stop after this long (default 2000 ms). */
  readonly timeBudgetMs?: number;
  readonly signal?: AbortSignal;
}

export interface ScanPageResult extends ScanResult {
  /** SCAN round trips made. */
  readonly calls: number;
  /** The call or time budget ran out before `limit` keys were found (and the scan is not done). */
  readonly budgetExhausted: boolean;
}

/** TYPE and the lowercase kind the editors use; module types keep their TYPE name. */
export type RedisKeyKind =
  | 'string'
  | 'hash'
  | 'list'
  | 'set'
  | 'zset'
  | 'stream'
  | 'json'
  | 'none'
  | 'module'
  /** TYPE failed (e.g. NOPERM for a key outside the ACL user's patterns). */
  | 'unknown';

export interface KeyInfo {
  readonly key: Uint8Array;
  /** TYPE as reported: string, hash, list, set, zset, stream, ReJSON-RL, none... */
  readonly type: string;
  readonly kind: RedisKeyKind;
  /** PTTL in milliseconds; -1 without expiry, -2 when the key does not exist. */
  readonly ttlMs: number;
  /** OBJECT ENCODING (listpack, hashtable, embstr...); null when unavailable. */
  readonly encoding: string | null;
  /** STRLEN / HLEN / LLEN / SCARD / ZCARD / XLEN; null for other types or when refused. */
  readonly length: number | null;
  /** Why TYPE failed (kind "unknown"). */
  readonly error?: string;
}

export interface StringReadOptions {
  /** First byte to read (default 0). */
  readonly offset?: number;
  /** Bytes to read at most (default 1 MiB); larger values are read with GETRANGE. */
  readonly maxBytes?: number;
}

export interface StringValue {
  readonly bytes: Uint8Array;
  /** STRLEN: the full size of the value. */
  readonly size: number;
  readonly offset: number;
  /** Only part of the value was read. */
  readonly truncated: boolean;
}

export interface CursorOptions {
  readonly cursor?: string;
  readonly match?: RedisBytes;
  readonly count?: number;
}

export interface CursorPage<T> {
  readonly items: T[];
  readonly cursor: string;
  readonly done: boolean;
}

export interface HashEntry {
  readonly field: Uint8Array;
  readonly value: Uint8Array;
}

export interface ZSetEntry {
  readonly member: Uint8Array;
  /** The score as a number (±Infinity for "inf"). */
  readonly score: number;
  /** The score as Redis printed it, exact to the last digit. */
  readonly scoreText: string;
}

export type ZRangeOptions =
  | {
      readonly by: 'index';
      readonly start: number;
      readonly stop: number;
      readonly reverse?: boolean;
    }
  | {
      readonly by: 'score';
      /** Score bounds as Redis takes them: "1", "(1", "-inf", "+inf". */
      readonly min: string;
      readonly max: string;
      readonly reverse?: boolean;
      readonly offset?: number;
      readonly count?: number;
    };

export interface StreamEntry {
  readonly id: string;
  readonly fields: readonly (readonly [Uint8Array, Uint8Array])[];
}

export interface StreamRangeOptions {
  /** Entry ids or "-" / "+" (defaults); "(" prefix for exclusive (Redis 6.2+). */
  readonly start?: string;
  readonly end?: string;
  readonly count?: number;
  /** Newest first (XREVRANGE). */
  readonly reverse?: boolean;
}

export interface StreamInfo {
  readonly length: number;
  readonly radixTreeKeys: number;
  readonly radixTreeNodes: number;
  readonly groups: number;
  readonly lastGeneratedId: string;
  readonly firstEntry: StreamEntry | null;
  readonly lastEntry: StreamEntry | null;
  /** Every field XINFO STREAM returned, as text. */
  readonly fields: Readonly<Record<string, string>>;
}

export interface StreamGroup {
  readonly name: string;
  readonly consumers: number;
  readonly pending: number;
  readonly lastDeliveredId: string;
  /** Redis 7+. */
  readonly entriesRead?: number | null;
  readonly lag?: number | null;
}

export interface StreamConsumer {
  readonly name: string;
  readonly pending: number;
  readonly idleMs: number;
  /** Redis 7.2+. */
  readonly inactiveMs?: number;
}

export interface PendingSummary {
  readonly count: number;
  readonly smallestId: string | null;
  readonly largestId: string | null;
  readonly consumers: readonly { readonly name: string; readonly pending: number }[];
}

export interface PendingEntry {
  readonly id: string;
  readonly consumer: string;
  readonly idleMs: number;
  readonly deliveries: number;
}

export interface PendingRangeOptions {
  readonly start?: string;
  readonly end?: string;
  readonly count?: number;
  readonly consumer?: RedisBytes;
  /** Only entries idle at least this long (Redis 6.2+). */
  readonly minIdleMs?: number;
}

export interface GeoMember {
  readonly member: Uint8Array;
  readonly longitude: number;
  readonly latitude: number;
  /** With GEOSEARCH WITHDIST, in the search unit. */
  readonly distance?: number;
}

export interface GeoSearchOptions {
  readonly from:
    { readonly member: RedisBytes } | { readonly longitude: number; readonly latitude: number };
  readonly by: { readonly radius: number } | { readonly width: number; readonly height: number };
  readonly unit?: 'm' | 'km' | 'mi' | 'ft';
  readonly sort?: 'ASC' | 'DESC';
  readonly count?: number;
  readonly any?: boolean;
}

/** A new key's type and contents (spec §10 value editors: "create a key of each type"). */
export type NewKeyValue =
  | { readonly type: 'string'; readonly value: RedisBytes }
  | { readonly type: 'hash'; readonly entries: readonly (readonly [RedisBytes, RedisBytes])[] }
  | { readonly type: 'list'; readonly items: readonly RedisBytes[] }
  | { readonly type: 'set'; readonly members: readonly RedisBytes[] }
  | { readonly type: 'zset'; readonly entries: readonly (readonly [RedisBytes, number | string])[] }
  | {
      readonly type: 'stream';
      readonly fields: readonly (readonly [RedisBytes, RedisBytes])[];
      readonly id?: string;
    }
  | { readonly type: 'json'; readonly json: string };

export interface SetStringOptions {
  /** Keep the current TTL (SET KEEPTTL). */
  readonly keepTtl?: boolean;
  /** Set a new TTL in milliseconds (SET PX). */
  readonly ttlMs?: number;
  /** Only if the key does not exist (NX) / exists (XX). */
  readonly condition?: 'nx' | 'xx';
}

export interface StreamAddOptions {
  /** Entry id; "*" (default) lets the server pick. */
  readonly id?: string;
  /** Trim with MAXLEN or MINID while adding. */
  readonly trim?: StreamTrimOptions;
  /** Do not create the stream (NOMKSTREAM). */
  readonly noMkStream?: boolean;
}

export interface StreamTrimOptions {
  readonly strategy: 'maxlen' | 'minid';
  readonly threshold: string | number;
  /** "~" trimming (faster, may keep a few more entries). */
  readonly approximate?: boolean;
  /** LIMIT for approximate trimming. */
  readonly limit?: number;
}

export interface ClaimOptions {
  readonly idleMs?: number;
  readonly retryCount?: number;
  readonly force?: boolean;
  /** Return only ids (JUSTID). */
  readonly justId?: boolean;
}

export interface CopyOptions {
  /** Replace the destination if it exists. */
  readonly replace?: boolean;
  /** Target logical database (standalone / Sentinel). */
  readonly db?: number;
}

export interface CopyResult {
  readonly copied: boolean;
  /** COPY (Redis 6.2+) or DUMP + RESTORE (fallback; keeps the TTL). */
  readonly method: 'copy' | 'dump-restore';
}

export interface DumpedKey {
  readonly key: Uint8Array;
  /** DUMP payload; null when the key vanished. */
  readonly payload: Uint8Array | null;
  /** PTTL at dump time: -1 without expiry. */
  readonly ttlMs: number;
  /** Absolute expiry (Unix ms) derived from the TTL, or null. */
  readonly expireAtMs: number | null;
}

export interface RestoreOptions {
  readonly replace?: boolean;
  /** Use `expireAtMs` (ABSTTL) instead of the relative TTL, for restores long after the dump. */
  readonly absoluteTtl?: boolean;
  /** Target logical database (standalone / Sentinel). */
  readonly db?: number;
}

export interface BulkDeleteOptions {
  /** Glob pattern of the keys to delete. */
  readonly match: RedisBytes;
  readonly type?: string;
  /** Count only (SCAN), delete nothing. */
  readonly dryRun?: boolean;
  /** Keys per UNLINK (default 500). */
  readonly batchSize?: number;
  /** SCAN COUNT (default 1000). */
  readonly scanCount?: number;
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: BulkDeleteProgress) => void;
}

export interface BulkDeleteProgress {
  /** Keys matched so far. */
  readonly matched: number;
  /** Keys deleted so far (0 in a dry run). */
  readonly deleted: number;
  /** Keys the server refused to delete (NOPERM for keys outside the ACL user's patterns). */
  readonly failed: number;
  readonly scanCalls: number;
}

export interface BulkDeleteResult extends BulkDeleteProgress {
  readonly dryRun: boolean;
  /** Stopped by the signal before the scan finished. */
  readonly cancelled: boolean;
  /** A few matched keys, for the confirmation dialog. */
  readonly sample: Uint8Array[];
}

// ---------------------------------------------------------------------------------------------
// Tools

export interface ConfigValues {
  readonly values: Readonly<Record<string, string>>;
  /** CONFIG was refused (NOPERM or renamed away): `values` is empty. */
  readonly denied: boolean;
}

/** FT.SEARCH options. */
export interface SearchQueryOptions {
  readonly offset?: number;
  /** Documents per page (default 10). */
  readonly limit?: number;
  readonly sortBy?: string;
  readonly sortDescending?: boolean;
  /** Fields to return (default all); ignored with `noContent`. */
  readonly returnFields?: readonly string[];
  readonly withScores?: boolean;
  /** Keys only. */
  readonly noContent?: boolean;
  /** No stemming of the query terms. */
  readonly verbatim?: boolean;
  /** Query dialect (1 to 4; 2 for PARAMS and vector queries). */
  readonly dialect?: number;
  /** Named parameters ($name) for dialect 2 and later. */
  readonly params?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
  readonly node?: string;
}

export interface SearchQueryResult extends SearchResult {
  readonly durationMs: number;
}

export interface SearchSuggestOptions {
  /** Keys to read (default 50, at most 500). */
  readonly sample?: number;
  readonly node?: string;
}

export interface BigKeyOptions {
  /** Keys to sample at most (default 5000). */
  readonly sampleSize?: number;
  /** Stop after this long (default 10 s). */
  readonly timeBudgetMs?: number;
  readonly match?: RedisBytes;
  /** MEMORY USAGE SAMPLES for aggregates (default 5, as Redis). */
  readonly memorySamples?: number;
  /** Largest keys to list (default 20). */
  readonly top?: number;
  readonly node?: string;
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: {
    readonly sampled: number;
    readonly scanCalls: number;
  }) => void;
}

export interface BigKeyEntry {
  readonly key: Uint8Array;
  readonly type: string;
  readonly bytes: number | null;
  readonly length: number | null;
  readonly ttlMs: number;
}

export interface BigKeyReport {
  readonly sampled: number;
  /** Keys in the scanned databases/nodes (DBSIZE), for extrapolation. */
  readonly totalKeys: number;
  /** Sum of MEMORY USAGE over the sample. */
  readonly sampledBytes: number;
  /** sampledBytes scaled to totalKeys. */
  readonly estimatedTotalBytes: number;
  readonly patterns: readonly PatternStats[];
  readonly largest: readonly BigKeyEntry[];
  /** The scan covered every key. */
  readonly complete: boolean;
  readonly cancelled: boolean;
  /** MEMORY USAGE was refused (NOPERM): sizes are unknown. */
  readonly memoryDenied: boolean;
  readonly durationMs: number;
}

export interface PubSubMessage {
  readonly kind: 'message' | 'pmessage' | 'smessage';
  readonly channel: Uint8Array;
  /** The pattern that matched (pmessage). */
  readonly pattern?: Uint8Array;
  readonly message: Uint8Array;
  /** Local receive time, Unix ms. */
  readonly receivedAt: number;
  /** Messages dropped before this one because the consumer fell behind. */
  readonly dropped: number;
}

export interface SubscribeOptions {
  readonly channels?: readonly RedisBytes[];
  readonly patterns?: readonly RedisBytes[];
  /** Sharded channels (SSUBSCRIBE, Redis 7+). */
  readonly shardChannels?: readonly RedisBytes[];
  /** Messages kept while the consumer is slower than the publisher (default 10,000). */
  readonly bufferSize?: number;
  readonly signal?: AbortSignal;
}

/** A live subscription on its own connection. Iterate it; `close` (or `return`) unsubscribes. */
export interface PubSubSubscription extends AsyncIterable<PubSubMessage> {
  close(): Promise<void>;
}

export interface MonitorEvent {
  /** Server time, Unix seconds with microseconds. */
  readonly timestamp: number;
  readonly db: number;
  /** Client address, or "lua". */
  readonly source: string;
  readonly args: readonly Uint8Array[];
  /** Cluster: the node that ran the command. */
  readonly node: string;
  readonly dropped: number;
}

export interface MonitorOptions {
  /** Cluster: one node; default every primary. */
  readonly node?: string;
  readonly bufferSize?: number;
  readonly signal?: AbortSignal;
}

export interface MonitorStream extends AsyncIterable<MonitorEvent> {
  close(): Promise<void>;
}

export interface TopologyNode extends ClusterNodeInfo {
  readonly address: string;
}

export interface SentinelMaster {
  readonly name: string;
  readonly host: string;
  readonly port: number;
  readonly flags: string;
  readonly replicas: number;
  readonly sentinels: number;
  readonly quorum: number;
  readonly fields: Readonly<Record<string, string>>;
}

export interface SentinelPeer {
  readonly host: string;
  readonly port: number;
  readonly flags: string;
  readonly fields: Readonly<Record<string, string>>;
}

export interface RedisTopologyView {
  readonly topology: RedisTopology;
  /** Cluster nodes with slot ranges; the server and its replicas otherwise. */
  readonly nodes: readonly TopologyNode[];
  /** Slot ranges no primary serves (Cluster). */
  readonly uncoveredSlots: readonly (readonly [number, number])[];
  /** Sentinel mode: what the sentinels report about the monitored master. */
  readonly sentinel?: {
    readonly masterName: string;
    readonly master: SentinelMaster | null;
    readonly replicas: readonly SentinelPeer[];
    readonly sentinels: readonly SentinelPeer[];
  };
}

export interface NodeInfo {
  readonly node: string;
  readonly info: InfoSections;
}

/**
 * A Redis session: the Session contract (execute runs redis-cli style command lines) plus the
 * key browser, value editors and server tools.
 */
export interface RedisSession extends Session {
  readonly engine: 'redis';
  readonly server: RedisServerInfo;
  /** The logical database commands run in (always 0 in Cluster mode). */
  readonly database: number;
  /** The namespace delimiter of the key browser (profile option, default ":"). */
  readonly keyDelimiter: string;

  /** SELECT a logical database ("db3" or "3"); Cluster mode has only database 0. */
  useDatabase(name: string): Promise<void>;

  /** Primaries (and replicas with `includeReplicas`) in Cluster mode; the server otherwise. */
  nodes(includeReplicas?: boolean): RedisNode[];
  /** Cluster: the node keyless commands typed in the CLI go to; undefined for the default. */
  setTargetNode(node: string | undefined): void;
  readonly targetNode: string | undefined;

  /** Runs one command and returns the structured reply; server errors come back as error replies. */
  command(args: readonly RedisBytes[], options?: CommandOptions): Promise<RedisReply>;
  /** Runs a keyless command on every primary (or every node), e.g. DBSIZE or SCRIPT FLUSH. */
  commandAll(
    args: readonly RedisBytes[],
    options?: { readonly replicas?: boolean },
  ): Promise<NodeReply[]>;

  // Keys
  scan(options?: ScanOptions): Promise<ScanResult>;
  scanPage(options: ScanPageOptions): Promise<ScanPageResult>;
  keyInfo(keys: readonly RedisBytes[]): Promise<KeyInfo[]>;
  memoryUsage(
    keys: readonly RedisBytes[],
    options?: { readonly samples?: number },
  ): Promise<(number | null)[]>;
  exists(keys: readonly RedisBytes[]): Promise<number>;
  dbSize(options?: { readonly node?: string }): Promise<number>;

  // Reads
  getString(key: RedisBytes, options?: StringReadOptions): Promise<StringValue | null>;
  hashScan(key: RedisBytes, options?: CursorOptions): Promise<CursorPage<HashEntry>>;
  hashGet(key: RedisBytes, fields: readonly RedisBytes[]): Promise<(Uint8Array | null)[]>;
  listRange(key: RedisBytes, start: number, stop: number): Promise<Uint8Array[]>;
  setScan(key: RedisBytes, options?: CursorOptions): Promise<CursorPage<Uint8Array>>;
  zsetRange(key: RedisBytes, options: ZRangeOptions): Promise<ZSetEntry[]>;
  zsetScan(key: RedisBytes, options?: CursorOptions): Promise<CursorPage<ZSetEntry>>;
  zsetScore(key: RedisBytes, member: RedisBytes): Promise<ZSetEntry | null>;
  streamRange(key: RedisBytes, options?: StreamRangeOptions): Promise<StreamEntry[]>;
  streamInfo(key: RedisBytes): Promise<StreamInfo>;
  streamGroups(key: RedisBytes): Promise<StreamGroup[]>;
  streamConsumers(key: RedisBytes, group: RedisBytes): Promise<StreamConsumer[]>;
  streamPending(key: RedisBytes, group: RedisBytes): Promise<PendingSummary>;
  streamPendingRange(
    key: RedisBytes,
    group: RedisBytes,
    options?: PendingRangeOptions,
  ): Promise<PendingEntry[]>;
  /** RedisJSON: the value at `path` (default "$") as JSON text; null when the key is missing. */
  jsonGet(key: RedisBytes, path?: string): Promise<string | null>;
  jsonType(key: RedisBytes, path?: string): Promise<string[]>;
  hllCount(keys: readonly RedisBytes[]): Promise<number>;
  /** Bitmap bytes [startByte, endByte] (GETRANGE) for the bits view. */
  bitmapRange(key: RedisBytes, startByte: number, endByte: number): Promise<Uint8Array>;
  bitCount(
    key: RedisBytes,
    range?: { readonly start: number; readonly end: number; readonly unit?: 'BYTE' | 'BIT' },
  ): Promise<number>;
  bitPos(
    key: RedisBytes,
    bit: 0 | 1,
    range?: { readonly start: number; readonly end?: number; readonly unit?: 'BYTE' | 'BIT' },
  ): Promise<number>;
  /** Geo members by index window (ZRANGE) with their positions (GEOPOS). */
  geoMembers(key: RedisBytes, start: number, stop: number): Promise<GeoMember[]>;
  geoSearch(key: RedisBytes, options: GeoSearchOptions): Promise<GeoMember[]>;

  // Writes
  createKey(
    key: RedisBytes,
    value: NewKeyValue,
    options?: { readonly ttlMs?: number },
  ): Promise<void>;
  setString(key: RedisBytes, value: RedisBytes, options?: SetStringOptions): Promise<boolean>;
  setRange(key: RedisBytes, offset: number, value: RedisBytes): Promise<number>;
  hashSet(
    key: RedisBytes,
    entries: readonly (readonly [RedisBytes, RedisBytes])[],
  ): Promise<number>;
  hashDelete(key: RedisBytes, fields: readonly RedisBytes[]): Promise<number>;
  listSet(key: RedisBytes, index: number, value: RedisBytes): Promise<void>;
  listPush(
    key: RedisBytes,
    values: readonly RedisBytes[],
    side?: 'left' | 'right',
  ): Promise<number>;
  listInsert(
    key: RedisBytes,
    where: 'before' | 'after',
    pivot: RedisBytes,
    value: RedisBytes,
  ): Promise<number>;
  /** LREM: removes `count` occurrences (0 = all, negative = from the tail). */
  listRemove(key: RedisBytes, value: RedisBytes, count?: number): Promise<number>;
  /** Removes the element at `index` if it still equals `expected` (atomic MULTI). */
  listRemoveAt(key: RedisBytes, index: number, expected: RedisBytes): Promise<boolean>;
  setAdd(key: RedisBytes, members: readonly RedisBytes[]): Promise<number>;
  setRemove(key: RedisBytes, members: readonly RedisBytes[]): Promise<number>;
  zsetAdd(
    key: RedisBytes,
    entries: readonly (readonly [RedisBytes, number | string])[],
    options?: { readonly condition?: 'nx' | 'xx'; readonly compare?: 'gt' | 'lt' },
  ): Promise<number>;
  zsetIncrement(key: RedisBytes, member: RedisBytes, by: number | string): Promise<ZSetEntry>;
  zsetRemove(key: RedisBytes, members: readonly RedisBytes[]): Promise<number>;
  streamAdd(
    key: RedisBytes,
    fields: readonly (readonly [RedisBytes, RedisBytes])[],
    options?: StreamAddOptions,
  ): Promise<string | null>;
  streamDelete(key: RedisBytes, ids: readonly string[]): Promise<number>;
  streamTrim(key: RedisBytes, options: StreamTrimOptions): Promise<number>;
  streamGroupCreate(
    key: RedisBytes,
    group: RedisBytes,
    id?: string,
    options?: { readonly mkStream?: boolean; readonly entriesRead?: number },
  ): Promise<void>;
  streamGroupDestroy(key: RedisBytes, group: RedisBytes): Promise<boolean>;
  streamGroupSetId(key: RedisBytes, group: RedisBytes, id: string): Promise<void>;
  streamAck(key: RedisBytes, group: RedisBytes, ids: readonly string[]): Promise<number>;
  streamClaim(
    key: RedisBytes,
    group: RedisBytes,
    consumer: RedisBytes,
    minIdleMs: number,
    ids: readonly string[],
    options?: ClaimOptions,
  ): Promise<StreamEntry[] | string[]>;
  streamAutoClaim(
    key: RedisBytes,
    group: RedisBytes,
    consumer: RedisBytes,
    minIdleMs: number,
    start?: string,
    options?: { readonly count?: number; readonly justId?: boolean },
  ): Promise<{
    readonly next: string;
    readonly claimed: StreamEntry[] | string[];
    readonly deleted: string[];
  }>;
  jsonSet(
    key: RedisBytes,
    path: string,
    json: string,
    options?: { readonly condition?: 'nx' | 'xx' },
  ): Promise<boolean>;
  /** UNLINK (non-blocking delete); grouped by slot in Cluster mode. */
  deleteKeys(keys: readonly RedisBytes[]): Promise<number>;
  /** PEXPIRE with a TTL, PERSIST with null. */
  expire(key: RedisBytes, ttlMs: number | null): Promise<boolean>;
  rename(
    key: RedisBytes,
    newKey: RedisBytes,
    options?: { readonly onlyIfNew?: boolean },
  ): Promise<boolean>;
  copy(source: RedisBytes, destination: RedisBytes, options?: CopyOptions): Promise<CopyResult>;
  bulkDelete(options: BulkDeleteOptions): Promise<BulkDeleteResult>;
  dumpKeys(keys: readonly RedisBytes[]): Promise<DumpedKey[]>;
  restoreKeys(keys: readonly DumpedKey[], options?: RestoreOptions): Promise<number>;

  // Tools
  info(options?: { readonly section?: string; readonly node?: string }): Promise<InfoSections>;
  infoAll(options?: { readonly section?: string }): Promise<NodeInfo[]>;
  configGet(pattern: string, options?: { readonly node?: string }): Promise<ConfigValues>;
  configSet(parameter: string, value: string, options?: { readonly node?: string }): Promise<void>;
  /** Nodes the configuration editor can target (Cluster nodes, Sentinel master and replicas). */
  configNodes(): Promise<ConfigNode[]>;
  /**
   * CONFIG GET * per node (every primary by default in Cluster mode), secrets masked;
   * NOT_SUPPORTED when the server refuses CONFIG (ACL, or renamed or disabled).
   */
  configRead(target?: ConfigTarget): Promise<ConfigSnapshot>;
  /** CONFIG SET of several parameters, with a result per node and parameter. */
  configApply(changes: readonly ConfigChange[], target?: ConfigTarget): Promise<ConfigApplyResult>;
  /** CONFIG REWRITE on each node of the target. */
  configRewrite(target?: ConfigTarget): Promise<ConfigNodeOutcome[]>;
  /** CONFIG RESETSTAT on each node of the target. */
  configResetStat(target?: ConfigTarget): Promise<ConfigNodeOutcome[]>;
  slowlogGet(count?: number, options?: { readonly node?: string }): Promise<SlowlogEntry[]>;
  slowlogLength(options?: { readonly node?: string }): Promise<number>;
  slowlogReset(options?: { readonly node?: string }): Promise<void>;
  clientList(options?: { readonly node?: string; readonly type?: string }): Promise<ClientInfo[]>;
  clientKill(id: number, options?: { readonly node?: string }): Promise<boolean>;
  latencyLatest(options?: { readonly node?: string }): Promise<LatencyEvent[]>;
  latencyHistory(event: string, options?: { readonly node?: string }): Promise<LatencySample[]>;
  latencyDoctor(options?: { readonly node?: string }): Promise<string>;
  latencyReset(events?: readonly string[], options?: { readonly node?: string }): Promise<number>;
  /** latency-monitor-threshold in ms (0 = off); null when CONFIG is refused. */
  latencyMonitorThreshold(options?: { readonly node?: string }): Promise<number | null>;
  setLatencyMonitorThreshold(ms: number, options?: { readonly node?: string }): Promise<void>;
  memoryDoctor(options?: { readonly node?: string }): Promise<string>;
  /** MONITOR on its own connection. Costly for the server: the UI warns before starting it. */
  monitor(options?: MonitorOptions): Promise<MonitorStream>;
  bigKeys(options?: BigKeyOptions): Promise<BigKeyReport>;
  /** RediSearch: index names (FT._LIST). NOT_SUPPORTED without the search module. */
  searchIndexes(options?: { readonly node?: string }): Promise<string[]>;
  searchInfo(index: string, options?: { readonly node?: string }): Promise<SearchIndexInfo>;
  searchQuery(
    index: string,
    query: string,
    options?: SearchQueryOptions,
  ): Promise<SearchQueryResult>;
  searchExplain(
    index: string,
    query: string,
    options?: { readonly dialect?: number; readonly node?: string },
  ): Promise<string>;
  searchCreate(
    definition: SearchIndexDefinition,
    options?: { readonly node?: string },
  ): Promise<void>;
  /** FT.DROPINDEX; `deleteDocuments` (DD) deletes the indexed keys too. */
  searchDrop(
    index: string,
    deleteDocuments: boolean,
    options?: { readonly node?: string },
  ): Promise<void>;
  /** Fields for a new index, from sample keys under a prefix. */
  searchSuggest(
    keyType: SearchKeyType,
    prefix: string,
    options?: SearchSuggestOptions,
  ): Promise<SearchFieldSuggestion[]>;
  aclList(): Promise<string[]>;
  aclUsers(): Promise<string[]>;
  aclGetUser(name: string): Promise<AclUser | null>;
  /** ACL SETUSER with rules such as "on", ">password", "~app:*", "+@read"; every node in Cluster mode. */
  aclSetUser(name: string, rules: readonly string[]): Promise<void>;
  aclDelUser(names: readonly string[]): Promise<number>;
  aclWhoAmI(): Promise<string>;
  aclCategories(category?: string): Promise<string[]>;
  aclLog(count?: number): Promise<AclLogEntry[]>;
  aclLogReset(): Promise<void>;
  subscribe(options: SubscribeOptions): Promise<PubSubSubscription>;
  publish(
    channel: RedisBytes,
    message: RedisBytes,
    options?: { readonly sharded?: boolean },
  ): Promise<number>;
  pubsubChannels(pattern?: RedisBytes): Promise<Uint8Array[]>;
  pubsubNumSub(
    channels: readonly RedisBytes[],
  ): Promise<{ readonly channel: Uint8Array; readonly subscribers: number }[]>;
  pubsubNumPat(): Promise<number>;
  topology(): Promise<RedisTopologyView>;
  /** Command docs for autocomplete and inline help (COMMAND DOCS + COMMAND INFO), cached. */
  commandDocs(): Promise<CommandCatalog>;
}
