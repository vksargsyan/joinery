import { z } from 'zod';

import { idSchema, stringListSchema } from '../schemas/common';
import {
  redisAclRulesSchema,
  redisAclUserSchema,
  redisBigKeyInputSchema,
  redisBigKeyProgressSchema,
  redisBigKeyReportSchema,
  redisBulkDeleteProgressSchema,
  redisBulkDeleteResultSchema,
  redisBytesInputSchema,
  redisBytesSchema,
  redisClaimOptionsSchema,
  redisClaimResultSchema,
  redisClientInfoSchema,
  redisCommandCatalogSchema,
  redisCommandResultSchema,
  redisConfigApplyResultSchema,
  redisConfigChangeSchema,
  redisConfigNodeOutcomeSchema,
  redisConfigNodeSchema,
  redisConfigSnapshotSchema,
  redisCopyResultSchema,
  redisCursorOptionsSchema,
  redisGeoMemberSchema,
  redisHashPageSchema,
  redisInfoSectionsSchema,
  redisKeyInfoSchema,
  redisLatencyEventSchema,
  redisLatencySampleSchema,
  redisMemberPageSchema,
  redisMonitorEventSchema,
  redisNewKeyValueSchema,
  redisNodeInfoSchema,
  redisPendingEntrySchema,
  redisPendingRangeOptionsSchema,
  redisPendingSummarySchema,
  redisPubSubMessageSchema,
  redisScanInputSchema,
  redisScanPageSchema,
  redisSessionInfoSchema,
  redisSetStringOptionsSchema,
  redisSlowlogEntrySchema,
  redisStreamAddOptionsSchema,
  redisStreamConsumerSchema,
  redisStreamEntrySchema,
  redisStreamGroupSchema,
  redisStreamInfoSchema,
  redisStreamRangeOptionsSchema,
  redisStringValueSchema,
  redisSubscribeInputSchema,
  redisTopologySchema,
  redisZRangeOptionsSchema,
  redisZSetEntrySchema,
} from '../schemas/redis';

/**
 * The `redis.*` namespace of the connection host contract (spec §10, §15): the key browser,
 * value editors and server tools of a Redis session opened with `openSession` (with the logical
 * database as `database`). SCAN pages, Pub/Sub messages and MONITOR are streams: they run as
 * the page pulls, and stopping the stream ends the scan, unsubscribes or stops MONITOR. Bulk
 * delete and the big-key report report progress and stop when the call is cancelled.
 *
 * Write rules (spec §4) are checked by the host whatever the page sends: a read-only profile
 * refuses every write with READ_ONLY (dry runs and reads still work); destructive operations
 * (deletes, bulk delete, a rename or copy over an existing key, FLUSH-like commands, CLIENT KILL,
 * ACL changes, CONFIG REWRITE and RESETSTAT) need `confirmed` on every profile, and every write
 * needs it on production profiles and profiles that confirm writes (CONFIRMATION_REQUIRED
 * otherwise). Engines other than Redis answer NOT_SUPPORTED.
 */

const sessionId = idSchema;
const key = redisBytesInputSchema;
const keys = z.array(redisBytesInputSchema).min(1).max(10_000);
const node = z.string().min(1).max(300);
const confirmed = z.boolean().optional();
const done = z.void();
const onKey = { sessionId, key };
const onNode = z.object({ sessionId, node: node.optional() });
const streamId = z.string().min(1).max(64);
const streamIds = z.array(streamId).min(1).max(10_000);
const group = redisBytesInputSchema;
const intResult = z.number();
/** Configuration calls: one node, or (Cluster) every primary, with `replicas` every node. */
const configTarget = { sessionId, node: node.optional(), replicas: z.boolean().optional() };

export const redisHostContractShape = {
  /** Server, database, delimiter and nodes of the session. */
  session: { input: z.object({ sessionId }), output: redisSessionInfoSchema },
  /** Cluster: the node keyless CLI commands go to; absent resets to the default. */
  setTargetNode: { input: z.object({ sessionId, node: node.optional() }), output: done },
  /** COMMAND DOCS + COMMAND INFO for autocomplete and inline docs (cached by the session). */
  commandDocs: { input: z.object({ sessionId }), output: redisCommandCatalogSchema },
  /**
   * Runs one CLI command (its arguments, tokenized by the page as redis-cli does) and returns
   * the reply tree; server errors come back as error replies. Commands that would take over the
   * connection (SUBSCRIBE, MONITOR...) are refused with a pointer to the tool that does it.
   * Cancelling the call drops the session's connection (a new one takes over the session, in
   * the same database), as redis-cli does on Ctrl+C.
   */
  command: {
    input: z.object({
      sessionId,
      args: z.array(redisBytesInputSchema).min(1).max(1_000_000),
      node: node.optional(),
      confirmed,
    }),
    output: redisCommandResultSchema,
  },

  /** Streams SCAN pages (never KEYS) with each key's type, TTL and length; every primary in Cluster mode. */
  scan: { input: redisScanInputSchema, item: redisScanPageSchema },
  keyInfo: { input: z.object({ sessionId, keys }), output: z.array(redisKeyInfoSchema) },
  /** MEMORY USAGE per key (null when refused or gone), for the rows on screen only. */
  memoryUsage: {
    input: z.object({ sessionId, keys, samples: z.number().int().min(0).max(1000).optional() }),
    output: z.array(z.number().nullable()),
  },
  exists: { input: z.object({ sessionId, keys }), output: z.object({ count: intResult }) },
  dbSize: { input: onNode, output: z.object({ count: intResult }) },
  /**
   * SCAN + UNLINK in batches by pattern, with progress (spec §10). `dryRun` only counts (and
   * returns a sample); the real run is destructive. Cancelling the call stops it.
   */
  bulkDelete: {
    input: z.object({
      sessionId,
      match: redisBytesInputSchema,
      type: z.string().min(1).max(64).optional(),
      dryRun: z.boolean().optional(),
      batchSize: z.number().int().min(1).max(10_000).optional(),
      confirmed,
    }),
    output: redisBulkDeleteResultSchema,
    progress: redisBulkDeleteProgressSchema,
  },

  key: {
    create: {
      input: z.object({
        ...onKey,
        value: redisNewKeyValueSchema,
        ttlMs: z.number().int().positive().optional(),
        confirmed,
      }),
      output: done,
    },
    /** UNLINK (destructive). */
    delete: {
      input: z.object({ sessionId, keys, confirmed }),
      output: z.object({ count: intResult }),
    },
    /** PEXPIRE with a TTL in milliseconds, PERSIST with null. */
    expire: {
      input: z.object({ ...onKey, ttlMs: z.number().int().positive().nullable(), confirmed }),
      output: z.object({ changed: z.boolean() }),
    },
    /** RENAME, or RENAMENX with `onlyIfNew`; destructive when it may replace a key. */
    rename: {
      input: z.object({
        ...onKey,
        newKey: redisBytesInputSchema,
        onlyIfNew: z.boolean().optional(),
        confirmed,
      }),
      output: z.object({ renamed: z.boolean() }),
    },
    /** COPY (or DUMP + RESTORE), to another logical database with `db`; destructive with `replace`. */
    copy: {
      input: z.object({
        ...onKey,
        destination: redisBytesInputSchema,
        db: z.number().int().nonnegative().optional(),
        replace: z.boolean().optional(),
        confirmed,
      }),
      output: redisCopyResultSchema,
    },
  },

  string: {
    /** The value, or a byte range of it for large values; null when the key is gone. */
    get: {
      input: z.object({
        ...onKey,
        offset: z.number().int().nonnegative().optional(),
        maxBytes: z
          .number()
          .int()
          .positive()
          .max(64 * 1024 * 1024)
          .optional(),
      }),
      output: redisStringValueSchema.nullable(),
    },
    set: {
      input: z.object({
        ...onKey,
        value: redisBytesInputSchema,
        options: redisSetStringOptionsSchema.optional(),
        confirmed,
      }),
      output: z.object({ written: z.boolean() }),
    },
  },
  hash: {
    /** HMGET: the values of these fields (null for a missing one). */
    get: {
      input: z.object({ ...onKey, fields: keys }),
      output: z.array(redisBytesSchema.nullable()),
    },
    scan: {
      input: z.object({ ...onKey, options: redisCursorOptionsSchema.optional() }),
      output: redisHashPageSchema,
    },
    set: {
      input: z.object({
        ...onKey,
        entries: z.array(z.tuple([redisBytesInputSchema, redisBytesInputSchema])).min(1),
        confirmed,
      }),
      output: z.object({ added: intResult }),
    },
    delete: {
      input: z.object({ ...onKey, fields: keys, confirmed }),
      output: z.object({ removed: intResult }),
    },
  },
  list: {
    range: {
      input: z.object({ ...onKey, start: z.number().int(), stop: z.number().int() }),
      output: z.array(redisBytesSchema),
    },
    set: {
      input: z.object({
        ...onKey,
        index: z.number().int(),
        value: redisBytesInputSchema,
        confirmed,
      }),
      output: done,
    },
    push: {
      input: z.object({
        ...onKey,
        values: z.array(redisBytesInputSchema).min(1),
        side: z.enum(['left', 'right']).optional(),
        confirmed,
      }),
      output: z.object({ length: intResult }),
    },
    /** Removes the element at `index` only while it still equals `expected`. */
    removeAt: {
      input: z.object({
        ...onKey,
        index: z.number().int(),
        expected: redisBytesInputSchema,
        confirmed,
      }),
      output: z.object({ removed: z.boolean() }),
    },
  },
  set: {
    scan: {
      input: z.object({ ...onKey, options: redisCursorOptionsSchema.optional() }),
      output: redisMemberPageSchema,
    },
    add: {
      input: z.object({ ...onKey, members: keys, confirmed }),
      output: z.object({ added: intResult }),
    },
    remove: {
      input: z.object({ ...onKey, members: keys, confirmed }),
      output: z.object({ removed: intResult }),
    },
  },
  zset: {
    range: {
      input: z.object({ ...onKey, options: redisZRangeOptionsSchema }),
      output: z.array(redisZSetEntrySchema),
    },
    /** ZADD; `condition: 'xx'` edits the score of an existing member only. */
    add: {
      input: z.object({
        ...onKey,
        entries: z
          .array(z.tuple([redisBytesInputSchema, z.union([z.number(), z.string()])]))
          .min(1),
        condition: z.enum(['nx', 'xx']).optional(),
        confirmed,
      }),
      output: z.object({ added: intResult }),
    },
    remove: {
      input: z.object({ ...onKey, members: keys, confirmed }),
      output: z.object({ removed: intResult }),
    },
  },
  stream: {
    range: {
      input: z.object({ ...onKey, options: redisStreamRangeOptionsSchema.optional() }),
      output: z.array(redisStreamEntrySchema),
    },
    info: { input: z.object(onKey), output: redisStreamInfoSchema },
    groups: { input: z.object(onKey), output: z.array(redisStreamGroupSchema) },
    consumers: {
      input: z.object({ ...onKey, group }),
      output: z.array(redisStreamConsumerSchema),
    },
    pending: { input: z.object({ ...onKey, group }), output: redisPendingSummarySchema },
    pendingRange: {
      input: z.object({ ...onKey, group, options: redisPendingRangeOptionsSchema.optional() }),
      output: z.array(redisPendingEntrySchema),
    },
    /** XADD; returns the new entry's id. */
    add: {
      input: z.object({
        ...onKey,
        fields: z.array(z.tuple([redisBytesInputSchema, redisBytesInputSchema])).min(1),
        options: redisStreamAddOptionsSchema.optional(),
        confirmed,
      }),
      output: z.object({ id: z.string().nullable() }),
    },
    /** XDEL. */
    delete: {
      input: z.object({ ...onKey, ids: streamIds, confirmed }),
      output: z.object({ removed: intResult }),
    },
    groupCreate: {
      input: z.object({
        ...onKey,
        group,
        id: streamId.optional(),
        mkStream: z.boolean().optional(),
        confirmed,
      }),
      output: done,
    },
    /** XGROUP DESTROY (destructive). */
    groupDestroy: {
      input: z.object({ ...onKey, group, confirmed }),
      output: z.object({ destroyed: z.boolean() }),
    },
    ack: {
      input: z.object({ ...onKey, group, ids: streamIds, confirmed }),
      output: z.object({ acknowledged: intResult }),
    },
    claim: {
      input: z.object({
        ...onKey,
        group,
        consumer: redisBytesInputSchema,
        minIdleMs: z.number().int().nonnegative(),
        ids: streamIds,
        options: redisClaimOptionsSchema.optional(),
        confirmed,
      }),
      output: redisClaimResultSchema,
    },
  },
  json: {
    /** The value at `path` (default "$") as JSON text; null when the key is gone. */
    get: {
      input: z.object({ ...onKey, path: z.string().min(1).max(4096).optional() }),
      output: z.object({ json: z.string().nullable() }),
    },
    set: {
      input: z.object({
        ...onKey,
        path: z.string().min(1).max(4096),
        json: z.string().min(1),
        confirmed,
      }),
      output: z.object({ written: z.boolean() }),
    },
  },
  hll: {
    count: { input: z.object({ sessionId, keys }), output: z.object({ count: intResult }) },
  },
  bitmap: {
    /** Bytes [startByte, endByte] (GETRANGE) for the bits view. */
    range: {
      input: z.object({
        ...onKey,
        startByte: z.number().int().nonnegative(),
        endByte: z.number().int().nonnegative(),
      }),
      output: redisBytesSchema,
    },
    count: { input: z.object(onKey), output: z.object({ count: intResult }) },
  },
  geo: {
    members: {
      input: z.object({ ...onKey, start: z.number().int(), stop: z.number().int() }),
      output: z.array(redisGeoMemberSchema),
    },
  },

  info: {
    input: z.object({
      sessionId,
      section: z.string().min(1).max(64).optional(),
      node: node.optional(),
    }),
    output: redisInfoSectionsSchema,
  },
  /** INFO from every primary (Cluster) or the one server. */
  infoAll: {
    input: z.object({ sessionId, section: z.string().min(1).max(64).optional() }),
    output: z.array(redisNodeInfoSchema),
  },
  slowlog: {
    get: {
      input: z.object({
        sessionId,
        count: z.number().int().min(1).max(100_000).optional(),
        node: node.optional(),
      }),
      output: z.array(redisSlowlogEntrySchema),
    },
    /** SLOWLOG RESET (destructive: the entries are gone). */
    reset: { input: z.object({ sessionId, node: node.optional(), confirmed }), output: done },
  },
  clients: {
    list: {
      input: z.object({ sessionId, node: node.optional(), type: z.string().min(1).optional() }),
      output: z.array(redisClientInfoSchema),
    },
    /** CLIENT KILL ID (destructive). */
    kill: {
      input: z.object({
        sessionId,
        id: z.number().int().nonnegative(),
        node: node.optional(),
        confirmed,
      }),
      output: z.object({ killed: z.boolean() }),
    },
  },
  latency: {
    latest: { input: onNode, output: z.array(redisLatencyEventSchema) },
    history: {
      input: z.object({ sessionId, event: z.string().min(1).max(256), node: node.optional() }),
      output: z.array(redisLatencySampleSchema),
    },
    doctor: { input: onNode, output: z.object({ text: z.string() }) },
    /** latency-monitor-threshold in ms (0 = off); null when CONFIG is refused. */
    threshold: { input: onNode, output: z.object({ ms: z.number().nullable() }) },
    setThreshold: {
      input: z.object({
        sessionId,
        ms: z.number().int().nonnegative(),
        node: node.optional(),
        confirmed,
      }),
      output: done,
    },
    /** LATENCY RESET (destructive: the history is gone). */
    reset: {
      input: z.object({
        sessionId,
        events: stringListSchema.optional(),
        node: node.optional(),
        confirmed,
      }),
      output: z.object({ reset: intResult }),
    },
  },
  memoryDoctor: { input: onNode, output: z.object({ text: z.string() }) },
  /**
   * The configuration editor (spec §15): CONFIG GET and SET per node. When the server refuses
   * CONFIG (an ACL user without it, or a managed service that renamed or disabled it) the calls
   * fail with NOT_SUPPORTED (engineCode NOPERM for the ACL case) and a hint to show.
   */
  config: {
    /** The nodes it can target: Cluster nodes, the Sentinel master and its replicas, or the server. */
    nodes: { input: z.object({ sessionId }), output: z.array(redisConfigNodeSchema) },
    /** CONFIG GET * per node; secret values never cross (only whether they are set). */
    get: { input: z.object(configTarget), output: redisConfigSnapshotSchema },
    /**
     * CONFIG SET, all pairs in one all-or-nothing call on Redis 7+ and Valkey, one at a time on
     * 6.2; outcomes per node and parameter. A write, destructive for parameters that can lock
     * clients out (requirepass, bind, port…).
     */
    set: {
      input: z.object({
        ...configTarget,
        changes: z.array(redisConfigChangeSchema).min(1).max(500),
        confirmed,
      }),
      output: redisConfigApplyResultSchema,
    },
    /** CONFIG REWRITE (destructive: it rewrites the configuration file). */
    rewrite: {
      input: z.object({ ...configTarget, confirmed }),
      output: z.array(redisConfigNodeOutcomeSchema),
    },
    /** CONFIG RESETSTAT (destructive: the statistics are gone). */
    resetStat: {
      input: z.object({ ...configTarget, confirmed }),
      output: z.array(redisConfigNodeOutcomeSchema),
    },
  },
  /** MONITOR on its own connection until the caller stops (costly: the page warns first). */
  monitor: {
    input: z.object({ sessionId, node: node.optional() }),
    item: redisMonitorEventSchema,
  },
  /** Sampled SCAN + MEMORY USAGE grouped by key pattern; cancelling the call stops it. */
  bigKeys: {
    input: redisBigKeyInputSchema,
    output: redisBigKeyReportSchema,
    progress: redisBigKeyProgressSchema,
  },
  acl: {
    users: { input: z.object({ sessionId }), output: z.array(z.string()) },
    /** ACL LIST: every user as the rules that would recreate it. */
    list: { input: z.object({ sessionId }), output: z.array(z.string()) },
    getUser: {
      input: z.object({ sessionId, name: z.string().min(1).max(512) }),
      output: redisAclUserSchema.nullable(),
    },
    /** ACL SETUSER with the rules as typed (an ACL change: destructive). */
    setUser: {
      input: z.object({
        sessionId,
        name: z.string().min(1).max(512),
        rules: redisAclRulesSchema,
        confirmed,
      }),
      output: done,
    },
    delUser: {
      input: z.object({
        sessionId,
        names: z.array(z.string().min(1).max(512)).min(1).max(1000),
        confirmed,
      }),
      output: z.object({ deleted: intResult }),
    },
    whoAmI: { input: z.object({ sessionId }), output: z.object({ user: z.string() }) },
  },
  /** Subscribes on its own connection and streams messages until the caller stops. */
  subscribe: { input: redisSubscribeInputSchema, item: redisPubSubMessageSchema },
  /** PUBLISH (SPUBLISH with `sharded`); returns the receivers. A write for the write rules. */
  publish: {
    input: z.object({
      sessionId,
      channel: redisBytesInputSchema,
      message: redisBytesInputSchema,
      sharded: z.boolean().optional(),
      confirmed,
    }),
    output: z.object({ receivers: intResult }),
  },
  /** PUBSUB CHANNELS: the active channels, optionally matching a pattern. */
  channels: {
    input: z.object({ sessionId, pattern: redisBytesInputSchema.optional() }),
    output: z.array(redisBytesSchema),
  },
  topology: { input: z.object({ sessionId }), output: redisTopologySchema },
};
