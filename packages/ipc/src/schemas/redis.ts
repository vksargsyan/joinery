import type {
  BigKeyEntry,
  BigKeyReport,
  BulkDeleteProgress,
  BulkDeleteResult,
  ClaimOptions,
  ConfigApplyResult,
  ConfigNode,
  ConfigNodeOutcome,
  ConfigSnapshot,
  CopyResult,
  CursorPage,
  GeoMember,
  HashEntry,
  KeyInfo,
  MonitorEvent,
  NewKeyValue,
  NodeInfo,
  PendingEntry,
  PendingRangeOptions,
  PendingSummary,
  PubSubMessage,
  RedisKeyKind,
  RedisModule,
  RedisNode,
  RedisServerInfo,
  RedisTopologyView,
  ScanPageResult,
  SentinelMaster,
  SearchQueryResult,
  SentinelPeer,
  SetStringOptions,
  StreamAddOptions,
  StreamConsumer,
  StreamEntry,
  StreamGroup,
  StreamInfo,
  StreamRangeOptions,
  StreamTrimOptions,
  StringValue,
  TopologyNode,
  ZRangeOptions,
  ZSetEntry,
} from '@joinery/driver-redis';
import type {
  AclSelector,
  AclUser,
  ClientInfo,
  CommandArgument,
  CommandCatalog,
  CommandDoc,
  CommandKeySpec,
  ConfigChange,
  ConfigNodeValues,
  InfoSections,
  LatencyEvent,
  LatencySample,
  PatternStats,
  RedisBytes,
  RedisReply,
  SearchDocument,
  SearchField,
  SearchFieldDefinition,
  SearchFieldSuggestion,
  SearchIndexDefinition,
  SearchIndexInfo,
  SlowlogEntry,
} from '@joinery/redis-tools';
import { z } from 'zod';

import { idSchema } from './common';

/**
 * Zod schemas for the Redis session services the connection host serves (spec §10, §15). Each
 * is annotated with the driver's own type (from @joinery/driver-redis and @joinery/redis-tools,
 * imported as types only, so nothing of the driver reaches the renderer), so a drift between
 * the driver and the contract fails to compile. Keys, fields, members and values are bytes
 * (Uint8Array) everywhere: the page shows and parses them with `displayBytes` and
 * `parseDisplayBytes`; inputs may also be text, which stands for its UTF-8 bytes.
 */

type Schema<T> = z.ZodType<T, T>;

/** Raw bytes: a Uint8Array (a Node Buffer on the sending side, a Uint8Array once cloned). */
export const redisBytesSchema: Schema<Uint8Array> = z.custom<Uint8Array>(
  (value) => value instanceof Uint8Array,
  'Expected bytes (Uint8Array)',
);

/** A key, field, member or value as an input: bytes, or text for its UTF-8 bytes. */
export const redisBytesInputSchema: Schema<RedisBytes> = z.union([redisBytesSchema, z.string()]);

/** Any JavaScript number, ±Infinity and NaN included (sorted-set scores, RESP3 doubles). */
const anyNumber: Schema<number> = z.custom<number>(
  (value) => typeof value === 'number',
  'Expected a number',
);

const count = z.number().int().nonnegative();
const textRecord: Schema<Readonly<Record<string, string>>> = z.record(z.string(), z.string());

/** A reply tree (redis-tools RedisReply): bulk strings stay bytes, big integers are bigint. */
export const redisReplySchema: Schema<RedisReply> = z.lazy(() =>
  z.discriminatedUnion('type', [
    z.object({ type: z.literal('status'), value: z.string() }),
    z.object({ type: z.literal('error'), value: z.string() }),
    z.object({ type: z.literal('integer'), value: z.union([z.number(), z.bigint()]) }),
    z.object({ type: z.literal('bulk'), value: redisBytesSchema }),
    z.object({ type: z.literal('nil') }),
    z.object({ type: z.literal('array'), items: z.array(redisReplySchema) }),
    z.object({ type: z.literal('double'), value: anyNumber }),
    z.object({ type: z.literal('boolean'), value: z.boolean() }),
    z.object({ type: z.literal('bignum'), value: z.bigint() }),
    z.object({ type: z.literal('verbatim'), format: z.string(), value: redisBytesSchema }),
    z.object({
      type: z.literal('map'),
      entries: z.array(z.tuple([redisReplySchema, redisReplySchema])),
    }),
    z.object({ type: z.literal('set'), items: z.array(redisReplySchema) }),
    z.object({ type: z.literal('push'), items: z.array(redisReplySchema) }),
  ]),
);

// ---------------------------------------------------------------------------------------------
// Session

const redisModuleSchema: Schema<RedisModule> = z.object({ name: z.string(), version: z.string() });

export const redisServerSchema: Schema<RedisServerInfo> = z.object({
  flavor: z.enum(['redis', 'valkey']),
  version: z.string(),
  redisVersion: z.string(),
  topology: z.enum(['standalone', 'sentinel', 'cluster']),
  role: z.enum(['master', 'replica', 'unknown']),
  modules: z.array(redisModuleSchema),
  databases: z.number().int().positive(),
  databasesExact: z.boolean(),
  clusterMode: z.boolean(),
});

export const redisNodeSchema: Schema<RedisNode> = z.object({
  address: z.string(),
  host: z.string(),
  port: z.number().int().nonnegative(),
  role: z.enum(['primary', 'replica']),
});

/** What a Redis session is: the server, its database, delimiter and nodes. */
export const redisSessionInfoSchema = z.object({
  server: redisServerSchema,
  /** The logical database the session's commands run in (0 in Cluster mode). */
  database: z.number().int().nonnegative(),
  keyDelimiter: z.string(),
  /** Primaries, then replicas (Cluster), or the one server. */
  nodes: z.array(redisNodeSchema),
  /** Cluster: the node keyless CLI commands go to; absent for the default. */
  targetNode: z.string().optional(),
  /** The session user (ACL WHOAMI), when the server answers it. */
  user: z.string().optional(),
});
export type RedisSessionInfo = z.infer<typeof redisSessionInfoSchema>;

// ---------------------------------------------------------------------------------------------
// Keys

const keyKindSchema: Schema<RedisKeyKind> = z.enum([
  'string',
  'hash',
  'list',
  'set',
  'zset',
  'stream',
  'json',
  'none',
  'module',
  'unknown',
]);

export const redisKeyInfoSchema: Schema<KeyInfo> = z.object({
  key: redisBytesSchema,
  type: z.string(),
  kind: keyKindSchema,
  ttlMs: z.number(),
  encoding: z.string().nullable(),
  length: z.number().nullable(),
  error: z.string().optional(),
});

/** One page of the key browser's scan: the keys found with their type, TTL and length. */
export interface RedisScanPage extends Omit<ScanPageResult, 'keys'> {
  readonly keys: readonly KeyInfo[];
}

export const redisScanPageSchema: Schema<RedisScanPage> = z.object({
  keys: z.array(redisKeyInfoSchema),
  cursor: z.string(),
  done: z.boolean(),
  calls: count,
  budgetExhausted: z.boolean(),
});

export const redisScanInputSchema = z.object({
  sessionId: idSchema,
  /** Glob pattern (SCAN MATCH); every key when absent. */
  match: redisBytesInputSchema.optional(),
  /** Only keys of this TYPE (string, hash, ReJSON-RL...). */
  type: z.string().min(1).max(64).optional(),
  /** Keys per page: each page scans until it has this many or its budget runs out. */
  pageSize: z.number().int().min(1).max(10_000).default(500),
  /** SCAN COUNT hint. */
  count: z.number().int().min(1).max(100_000).optional(),
  /** Cluster: scan one node instead of every primary. */
  node: z.string().min(1).optional(),
  /** Resume from a cursor a page returned. */
  cursor: z.string().min(1).optional(),
});

const bulkProgressFields = {
  matched: count,
  deleted: count,
  failed: count,
  scanCalls: count,
};

export const redisBulkDeleteProgressSchema: Schema<BulkDeleteProgress> =
  z.object(bulkProgressFields);

export const redisBulkDeleteResultSchema: Schema<BulkDeleteResult> = z.object({
  ...bulkProgressFields,
  dryRun: z.boolean(),
  cancelled: z.boolean(),
  sample: z.array(redisBytesSchema),
});

export const redisCopyResultSchema: Schema<CopyResult> = z.object({
  copied: z.boolean(),
  method: z.enum(['copy', 'dump-restore']),
});

const entryPair = z.tuple([redisBytesInputSchema, redisBytesInputSchema]);
const scorePair = z.tuple([redisBytesInputSchema, z.union([anyNumber, z.string()])]);

export const redisNewKeyValueSchema: Schema<NewKeyValue> = z.discriminatedUnion('type', [
  z.object({ type: z.literal('string'), value: redisBytesInputSchema }),
  z.object({ type: z.literal('hash'), entries: z.array(entryPair).min(1) }),
  z.object({ type: z.literal('list'), items: z.array(redisBytesInputSchema).min(1) }),
  z.object({ type: z.literal('set'), members: z.array(redisBytesInputSchema).min(1) }),
  z.object({ type: z.literal('zset'), entries: z.array(scorePair).min(1) }),
  z.object({
    type: z.literal('stream'),
    fields: z.array(entryPair).min(1),
    id: z.string().min(1).optional(),
  }),
  z.object({ type: z.literal('json'), json: z.string().min(1) }),
]);

// ---------------------------------------------------------------------------------------------
// Values

export const redisStringValueSchema: Schema<StringValue> = z.object({
  bytes: redisBytesSchema,
  size: count,
  offset: count,
  truncated: z.boolean(),
});

export const redisSetStringOptionsSchema: Schema<SetStringOptions> = z.object({
  keepTtl: z.boolean().optional(),
  ttlMs: z.number().int().positive().optional(),
  condition: z.enum(['nx', 'xx']).optional(),
});

export const redisCursorOptionsSchema = z.object({
  cursor: z.string().min(1).optional(),
  match: redisBytesInputSchema.optional(),
  count: z.number().int().min(1).max(100_000).optional(),
});

export const redisHashPageSchema: Schema<CursorPage<HashEntry>> = z.object({
  items: z.array(z.object({ field: redisBytesSchema, value: redisBytesSchema })),
  cursor: z.string(),
  done: z.boolean(),
});

export const redisMemberPageSchema: Schema<CursorPage<Uint8Array>> = z.object({
  items: z.array(redisBytesSchema),
  cursor: z.string(),
  done: z.boolean(),
});

export const redisZSetEntrySchema: Schema<ZSetEntry> = z.object({
  member: redisBytesSchema,
  score: anyNumber,
  scoreText: z.string(),
});

export const redisZRangeOptionsSchema: Schema<ZRangeOptions> = z.discriminatedUnion('by', [
  z.object({
    by: z.literal('index'),
    start: z.number().int(),
    stop: z.number().int(),
    reverse: z.boolean().optional(),
  }),
  z.object({
    by: z.literal('score'),
    min: z.string().min(1),
    max: z.string().min(1),
    reverse: z.boolean().optional(),
    offset: z.number().int().nonnegative().optional(),
    count: z.number().int().positive().optional(),
  }),
]);

export const redisStreamEntrySchema: Schema<StreamEntry> = z.object({
  id: z.string(),
  fields: z.array(z.tuple([redisBytesSchema, redisBytesSchema])),
});

export const redisStreamRangeOptionsSchema: Schema<StreamRangeOptions> = z.object({
  start: z.string().min(1).optional(),
  end: z.string().min(1).optional(),
  count: z.number().int().positive().max(100_000).optional(),
  reverse: z.boolean().optional(),
});

export const redisStreamInfoSchema: Schema<StreamInfo> = z.object({
  length: count,
  radixTreeKeys: count,
  radixTreeNodes: count,
  groups: count,
  lastGeneratedId: z.string(),
  firstEntry: redisStreamEntrySchema.nullable(),
  lastEntry: redisStreamEntrySchema.nullable(),
  fields: textRecord,
});

export const redisStreamGroupSchema: Schema<StreamGroup> = z.object({
  name: z.string(),
  consumers: count,
  pending: count,
  lastDeliveredId: z.string(),
  entriesRead: z.number().nullable().optional(),
  lag: z.number().nullable().optional(),
});

export const redisStreamConsumerSchema: Schema<StreamConsumer> = z.object({
  name: z.string(),
  pending: count,
  idleMs: z.number(),
  inactiveMs: z.number().optional(),
});

export const redisPendingSummarySchema: Schema<PendingSummary> = z.object({
  count,
  smallestId: z.string().nullable(),
  largestId: z.string().nullable(),
  consumers: z.array(z.object({ name: z.string(), pending: count })),
});

export const redisPendingEntrySchema: Schema<PendingEntry> = z.object({
  id: z.string(),
  consumer: z.string(),
  idleMs: z.number(),
  deliveries: count,
});

export const redisPendingRangeOptionsSchema: Schema<PendingRangeOptions> = z.object({
  start: z.string().min(1).optional(),
  end: z.string().min(1).optional(),
  count: z.number().int().positive().max(100_000).optional(),
  consumer: redisBytesInputSchema.optional(),
  minIdleMs: z.number().int().nonnegative().optional(),
});

export const redisStreamTrimOptionsSchema: Schema<StreamTrimOptions> = z.object({
  strategy: z.enum(['maxlen', 'minid']),
  threshold: z.union([z.string().min(1), z.number().int().nonnegative()]),
  approximate: z.boolean().optional(),
  limit: z.number().int().positive().optional(),
});

export const redisStreamAddOptionsSchema: Schema<StreamAddOptions> = z.object({
  id: z.string().min(1).optional(),
  trim: redisStreamTrimOptionsSchema.optional(),
  noMkStream: z.boolean().optional(),
});

export const redisClaimOptionsSchema: Schema<ClaimOptions> = z.object({
  idleMs: z.number().int().nonnegative().optional(),
  retryCount: z.number().int().nonnegative().optional(),
  force: z.boolean().optional(),
  justId: z.boolean().optional(),
});

/** XCLAIM's answer: the claimed entries, or only their ids with `justId`. */
export const redisClaimResultSchema: Schema<StreamEntry[] | string[]> = z.union([
  z.array(redisStreamEntrySchema),
  z.array(z.string()),
]);

export const redisGeoMemberSchema: Schema<GeoMember> = z.object({
  member: redisBytesSchema,
  longitude: z.number(),
  latitude: z.number(),
  distance: z.number().optional(),
});

// ---------------------------------------------------------------------------------------------
// Tools

export const redisInfoSectionsSchema: Schema<InfoSections> = z.record(z.string(), textRecord);

export const redisNodeInfoSchema: Schema<NodeInfo> = z.object({
  node: z.string(),
  info: redisInfoSectionsSchema,
});

export const redisSlowlogEntrySchema: Schema<SlowlogEntry> = z.object({
  id: z.number(),
  timestamp: z.number(),
  durationMicros: z.number(),
  args: z.array(redisBytesSchema),
  client: z.string().optional(),
  clientName: z.string().optional(),
});

export const redisClientInfoSchema: Schema<ClientInfo> = z.object({
  id: z.number(),
  addr: z.string(),
  laddr: z.string().optional(),
  name: z.string(),
  ageSeconds: z.number(),
  idleSeconds: z.number(),
  flags: z.string(),
  db: z.number(),
  cmd: z.string(),
  user: z.string().optional(),
  subscriptions: z.number(),
  patternSubscriptions: z.number(),
  outputMemory: z.number(),
  totalMemory: z.number(),
  fields: textRecord,
});

export const redisLatencyEventSchema: Schema<LatencyEvent> = z.object({
  event: z.string(),
  timestamp: z.number(),
  latestMs: z.number(),
  maxMs: z.number(),
});

export const redisLatencySampleSchema: Schema<LatencySample> = z.object({
  timestamp: z.number(),
  latencyMs: z.number(),
});

const aclSelectorSchema: Schema<AclSelector> = z.object({
  commands: z.string(),
  keys: z.string(),
  channels: z.string(),
});

export const redisAclUserSchema: Schema<AclUser> = z.object({
  flags: z.array(z.string()),
  passwordHashes: z.array(z.string()),
  commands: z.string(),
  keys: z.string(),
  channels: z.string(),
  selectors: z.array(aclSelectorSchema),
});

/** ACL SETUSER rules: "on", ">password", "~app:*", "+@read"... One rule per word. */
export const redisAclRulesSchema = z.array(z.string().min(1).max(4096)).max(1000);

// ---------------------------------------------------------------------------------------------
// Configuration

const configRole = z.enum(['primary', 'replica']);

export const redisConfigNodeSchema: Schema<ConfigNode> = z.object({
  address: z.string(),
  role: configRole,
});

const configNodeValuesSchema: Schema<ConfigNodeValues> = z.object({
  node: z.string(),
  role: configRole,
  values: textRecord,
  secrets: z.record(z.string(), z.boolean()),
});

/** CONFIG GET * per node; secret parameters only say whether they are set. */
export const redisConfigSnapshotSchema: Schema<ConfigSnapshot> = z.object({
  nodes: z.array(configNodeValuesSchema),
  multiSet: z.boolean(),
});

/** One CONFIG SET pair. The value may be a secret: it is never logged or echoed. */
export const redisConfigChangeSchema: Schema<ConfigChange> = z.object({
  name: z.string().min(1).max(256),
  value: z.string().max(65_536),
});

export const redisConfigApplyResultSchema: Schema<ConfigApplyResult> = z.object({
  atomic: z.boolean(),
  nodes: z.array(
    z.object({
      node: z.string(),
      parameters: z.array(
        z.object({ name: z.string(), applied: z.boolean(), error: z.string().optional() }),
      ),
    }),
  ),
});

export const redisConfigNodeOutcomeSchema: Schema<ConfigNodeOutcome> = z.object({
  node: z.string(),
  ok: z.boolean(),
  error: z.string().optional(),
});

const patternStatsSchema: Schema<PatternStats> = z.object({
  pattern: z.string(),
  count,
  totalBytes: z.number(),
  maxBytes: z.number(),
  avgBytes: z.number(),
  largestKey: redisBytesSchema.nullable(),
  types: z.record(z.string(), z.number()),
  withTtl: count,
  share: z.number(),
});

const bigKeyEntrySchema: Schema<BigKeyEntry> = z.object({
  key: redisBytesSchema,
  type: z.string(),
  bytes: z.number().nullable(),
  length: z.number().nullable(),
  ttlMs: z.number(),
});

export const redisBigKeyReportSchema: Schema<BigKeyReport> = z.object({
  sampled: count,
  totalKeys: count,
  sampledBytes: z.number(),
  estimatedTotalBytes: z.number(),
  patterns: z.array(patternStatsSchema),
  largest: z.array(bigKeyEntrySchema),
  complete: z.boolean(),
  cancelled: z.boolean(),
  memoryDenied: z.boolean(),
  durationMs: z.number(),
});

export const redisBigKeyInputSchema = z.object({
  sessionId: idSchema,
  sampleSize: z.number().int().min(1).max(1_000_000).optional(),
  timeBudgetMs: z.number().int().min(100).max(600_000).optional(),
  match: redisBytesInputSchema.optional(),
  memorySamples: z.number().int().min(0).max(1000).optional(),
  top: z.number().int().min(1).max(1000).optional(),
  node: z.string().min(1).optional(),
});

export const redisBigKeyProgressSchema = z.object({ sampled: count, scanCalls: count });

// ---------------------------------------------------------------------------------------------
// RediSearch (FT.*)

const searchFieldSchema: Schema<SearchField> = z.object({
  identifier: z.string(),
  attribute: z.string(),
  type: z.string(),
  options: textRecord,
  flags: z.array(z.string()),
});

export const redisSearchInfoSchema: Schema<SearchIndexInfo> = z.object({
  name: z.string(),
  keyType: z.string(),
  prefixes: z.array(z.string()),
  filter: z.string().nullable(),
  language: z.string().nullable(),
  fields: z.array(searchFieldSchema),
  documents: z.number().nullable(),
  terms: z.number().nullable(),
  records: z.number().nullable(),
  memoryBytes: z.number().nullable(),
  indexing: z.boolean(),
  percentIndexed: z.number().nullable(),
  failures: z.number(),
  lastError: z.string().nullable(),
  lastErrorKey: z.string().nullable(),
  stats: z.array(z.tuple([z.string(), z.string()]).readonly()),
});

const searchDocumentSchema: Schema<SearchDocument> = z.object({
  key: redisBytesSchema,
  score: z.number().nullable(),
  fields: z.array(z.tuple([z.string(), redisBytesSchema]).readonly()),
});

export const redisSearchResultSchema: Schema<SearchQueryResult> = z.object({
  total: count,
  documents: z.array(searchDocumentSchema),
  durationMs: count,
});

const indexName = z.string().min(1).max(512);
const searchNode = z.string().min(1).optional();

const searchFieldDefinitionSchema: Schema<SearchFieldDefinition> = z.object({
  identifier: z.string().min(1).max(1024),
  attribute: z.string().max(256).optional(),
  type: z.enum(['TEXT', 'TAG', 'NUMERIC', 'GEO', 'VECTOR', 'GEOSHAPE']),
  sortable: z.boolean().optional(),
  noStem: z.boolean().optional(),
  weight: z.number().positive().max(1000).optional(),
  phonetic: z.string().max(32).optional(),
  separator: z.string().length(1).optional(),
  caseSensitive: z.boolean().optional(),
  vector: z
    .object({
      algorithm: z.enum(['FLAT', 'HNSW']),
      dim: z.number().int().min(1).max(32768),
      distance: z.enum(['COSINE', 'L2', 'IP']),
      dataType: z.enum(['FLOAT32', 'FLOAT64', 'FLOAT16', 'BFLOAT16']),
      m: z.number().int().min(1).max(512).optional(),
      efConstruction: z.number().int().min(1).max(4096).optional(),
    })
    .optional(),
  indexMissing: z.boolean().optional(),
  indexEmpty: z.boolean().optional(),
});

export const redisSearchDefinitionSchema: Schema<SearchIndexDefinition> = z.object({
  name: indexName,
  keyType: z.enum(['HASH', 'JSON']),
  prefixes: z.array(z.string().max(1024)).max(64),
  filter: z.string().max(4096).optional(),
  language: z.string().max(32).optional(),
  fields: z.array(searchFieldDefinitionSchema).min(1).max(1024),
});

export const redisSearchSuggestionSchema: Schema<SearchFieldSuggestion> = z.object({
  identifier: z.string(),
  attribute: z.string().optional(),
  type: z.enum(['TEXT', 'TAG', 'NUMERIC', 'GEO', 'VECTOR', 'GEOSHAPE']),
  sortable: z.boolean().optional(),
  seen: count,
  example: z.string(),
});

export const redisSearchListInputSchema = z.object({ sessionId: idSchema, node: searchNode });
export const redisSearchInfoInputSchema = z.object({
  sessionId: idSchema,
  index: indexName,
  node: searchNode,
});
export const redisSearchQueryInputSchema = z.object({
  sessionId: idSchema,
  index: indexName,
  query: z.string().min(1).max(65_536),
  offset: z.number().int().min(0).max(10_000_000).optional(),
  limit: z.number().int().min(0).max(10_000).optional(),
  sortBy: z.string().max(256).optional(),
  sortDescending: z.boolean().optional(),
  returnFields: z.array(z.string().max(1024)).max(256).optional(),
  withScores: z.boolean().optional(),
  noContent: z.boolean().optional(),
  verbatim: z.boolean().optional(),
  dialect: z.number().int().min(1).max(4).optional(),
  params: z.record(z.string().regex(/^\w{1,64}$/), z.string().max(65_536)).optional(),
  timeoutMs: z.number().int().min(1).max(600_000).optional(),
  node: searchNode,
});
export const redisSearchExplainInputSchema = z.object({
  sessionId: idSchema,
  index: indexName,
  query: z.string().min(1).max(65_536),
  dialect: z.number().int().min(1).max(4).optional(),
  node: searchNode,
});
export const redisSearchCreateInputSchema = z.object({
  sessionId: idSchema,
  definition: redisSearchDefinitionSchema,
  node: searchNode,
  confirmed: z.boolean().optional(),
});
export const redisSearchDropInputSchema = z.object({
  sessionId: idSchema,
  index: indexName,
  /** DD: delete the indexed keys too. */
  deleteDocuments: z.boolean(),
  node: searchNode,
  confirmed: z.boolean().optional(),
});
export const redisSearchSuggestInputSchema = z.object({
  sessionId: idSchema,
  keyType: z.enum(['HASH', 'JSON']),
  prefix: z.string().max(1024),
  sample: z.number().int().min(1).max(500).optional(),
  node: searchNode,
});

export const redisPubSubMessageSchema: Schema<PubSubMessage> = z.object({
  kind: z.enum(['message', 'pmessage', 'smessage']),
  channel: redisBytesSchema,
  pattern: redisBytesSchema.optional(),
  message: redisBytesSchema,
  receivedAt: z.number(),
  dropped: count,
});

export const redisSubscribeInputSchema = z.object({
  sessionId: idSchema,
  channels: z.array(redisBytesInputSchema).max(1000).optional(),
  patterns: z.array(redisBytesInputSchema).max(1000).optional(),
  shardChannels: z.array(redisBytesInputSchema).max(1000).optional(),
  bufferSize: z.number().int().min(1).max(1_000_000).optional(),
});

export const redisMonitorEventSchema: Schema<MonitorEvent> = z.object({
  timestamp: z.number(),
  db: z.number(),
  source: z.string(),
  args: z.array(redisBytesSchema),
  node: z.string(),
  dropped: count,
});

const slotRange = z.tuple([z.number().int(), z.number().int()]);

const topologyNodeSchema: Schema<TopologyNode> = z.object({
  id: z.string(),
  host: z.string(),
  port: z.number(),
  busPort: z.number().optional(),
  hostname: z.string().optional(),
  role: z.enum(['primary', 'replica']),
  primaryId: z.string().optional(),
  flags: z.array(z.string()),
  myself: z.boolean(),
  failing: z.boolean(),
  state: z.string(),
  slots: z.array(slotRange),
  replicationOffset: z.number().optional(),
  configEpoch: z.number().optional(),
  address: z.string(),
});

const sentinelPeerSchema: Schema<SentinelPeer> = z.object({
  host: z.string(),
  port: z.number(),
  flags: z.string(),
  fields: textRecord,
});

const sentinelMasterSchema: Schema<SentinelMaster> = z.object({
  name: z.string(),
  host: z.string(),
  port: z.number(),
  flags: z.string(),
  replicas: z.number(),
  sentinels: z.number(),
  quorum: z.number(),
  fields: textRecord,
});

export const redisTopologySchema: Schema<RedisTopologyView> = z.object({
  topology: z.enum(['standalone', 'sentinel', 'cluster']),
  nodes: z.array(topologyNodeSchema),
  uncoveredSlots: z.array(slotRange),
  sentinel: z
    .object({
      masterName: z.string(),
      master: sentinelMasterSchema.nullable(),
      replicas: z.array(sentinelPeerSchema),
      sentinels: z.array(sentinelPeerSchema),
    })
    .optional(),
});

// ---------------------------------------------------------------------------------------------
// Command docs

const commandArgumentSchema: Schema<CommandArgument> = z.lazy(() =>
  z.object({
    name: z.string(),
    type: z.string(),
    token: z.string().optional(),
    displayText: z.string().optional(),
    summary: z.string().optional(),
    since: z.string().optional(),
    deprecatedSince: z.string().optional(),
    keySpecIndex: z.number().optional(),
    optional: z.boolean(),
    multiple: z.boolean(),
    multipleToken: z.boolean(),
    arguments: z.array(commandArgumentSchema),
  }),
);

const commandKeySpecSchema: Schema<CommandKeySpec> = z.object({
  flags: z.array(z.string()),
  beginSearch: textRecord,
  findKeys: textRecord,
});

const commandDocSchema: Schema<CommandDoc> = z.lazy(() =>
  z.object({
    name: z.string(),
    container: z.string().optional(),
    summary: z.string().optional(),
    since: z.string().optional(),
    group: z.string().optional(),
    complexity: z.string().optional(),
    deprecatedSince: z.string().optional(),
    replacedBy: z.string().optional(),
    docFlags: z.array(z.string()),
    history: z.array(z.object({ version: z.string(), description: z.string() })),
    arguments: z.array(commandArgumentSchema),
    subcommands: z.array(commandDocSchema),
    arity: z.number().optional(),
    flags: z.array(z.string()),
    aclCategories: z.array(z.string()),
    tips: z.array(z.string()),
    keys: z.object({ first: z.number(), last: z.number(), step: z.number() }).optional(),
    keySpecs: z.array(commandKeySpecSchema),
    write: z.boolean(),
    readOnly: z.boolean(),
    blocking: z.boolean(),
    dangerous: z.boolean(),
    admin: z.boolean(),
  }),
);

/** The command catalog behind the CLI's autocomplete and inline docs (COMMAND DOCS + INFO). */
export const redisCommandCatalogSchema: Schema<CommandCatalog> = z.object({
  commands: z.record(z.string(), commandDocSchema),
  source: z.enum(['docs', 'info']),
});

/** A command's reply and, in Cluster mode, the node that answered. */
export const redisCommandResultSchema = z.object({
  reply: redisReplySchema,
  node: z.string().optional(),
  durationMs: z.number().nonnegative(),
  /** The logical database the session is in after the command (SELECT changes it). */
  database: z.number().int().nonnegative(),
  /** A MULTI is open on the session after the command. */
  inTransaction: z.boolean(),
});
export type RedisCommandResult = z.infer<typeof redisCommandResultSchema>;
