import { JoineryError } from '@joinery/core';
import {
  aggregateByPattern,
  buildCommandCatalog,
  nodeAddress,
  parseAclLog,
  parseAclUser,
  parseClientList,
  parseClusterNodes,
  parseClusterShards,
  parseInfo,
  parseLatencyHistory,
  parseLatencyLatest,
  parseReplication,
  parseSlowlog,
  toBytes,
  uncoveredSlots,
  type AclLogEntry,
  type AclUser,
  type ClientInfo,
  type ClusterNodeInfo,
  type CommandCatalog,
  type InfoSections,
  type KeySample,
  type LatencyEvent,
  type LatencySample,
  type RedisBytes,
  type RedisReply,
  type SlowlogEntry,
} from '@joinery/redis-tools';
import { Redis } from 'ioredis';

import { addressOf, connectClient, type Arg } from './client';
import type { RedisContext } from './context';
import { mapRedisError } from './errors';
import { dbSize, isServerError, scan } from './keys';
import { asArray, asBytes, asNumber, asRecord, asText, toRedisReply } from './replies';
import type {
  BigKeyEntry,
  BigKeyOptions,
  BigKeyReport,
  ConfigValues,
  NodeInfo,
  RedisTopologyView,
  SentinelMaster,
  SentinelPeer,
  TopologyNode,
} from './types';

/** Server tools (spec §10, §15): monitoring, sessions, slow log, latency, ACL, topology. */

async function text(ctx: RedisContext, args: readonly Arg[], node?: string): Promise<string> {
  return asText(await ctx.call(args, ctx.nodeFor(node))) ?? '';
}

async function reply(ctx: RedisContext, args: readonly Arg[], node?: string): Promise<RedisReply> {
  return toRedisReply(await ctx.call(args, ctx.nodeFor(node)));
}

export async function info(
  ctx: RedisContext,
  section?: string,
  node?: string,
): Promise<InfoSections> {
  return parseInfo(await text(ctx, section ? ['info', section] : ['info'], node));
}

export async function infoAll(ctx: RedisContext, section?: string): Promise<NodeInfo[]> {
  return Promise.all(
    ctx.scanNodes(undefined).map(async (node) => ({
      node: addressOf(node),
      info: parseInfo(asText(await ctx.call(section ? ['info', section] : ['info'], node)) ?? ''),
    })),
  );
}

/** CONFIG GET; `denied` instead of an error when CONFIG is refused (ACL or renamed away). */
export async function configGet(
  ctx: RedisContext,
  pattern: string,
  node?: string,
): Promise<ConfigValues> {
  try {
    const record = asRecord(await ctx.call(['config', 'get', pattern], ctx.nodeFor(node)));
    const values: Record<string, string> = {};
    for (const [k, v] of Object.entries(record)) values[k] = asText(v) ?? '';
    return { values, denied: false };
  } catch (error) {
    if (
      error instanceof JoineryError &&
      (error.engineCode === 'NOPERM' || /unknown command/i.test(error.message))
    ) {
      return { values: {}, denied: true };
    }
    throw error;
  }
}

/** CONFIG SET on one node, or on every node of a cluster when none is given. */
export async function configSet(
  ctx: RedisContext,
  parameter: string,
  value: string,
  node?: string,
): Promise<void> {
  const nodes =
    node !== undefined || !ctx.conn.isCluster
      ? [ctx.nodeFor(node)]
      : [...ctx.conn.primaries(), ...ctx.conn.replicas()];
  await Promise.all(nodes.map((n) => ctx.call(['config', 'set', parameter, value], n)));
}

export async function slowlogGet(
  ctx: RedisContext,
  count = 128,
  node?: string,
): Promise<SlowlogEntry[]> {
  return parseSlowlog(await reply(ctx, ['slowlog', 'get', count], node));
}

export async function clientList(
  ctx: RedisContext,
  node?: string,
  type?: string,
): Promise<ClientInfo[]> {
  return parseClientList(
    await text(ctx, type ? ['client', 'list', 'TYPE', type] : ['client', 'list'], node),
  );
}

export async function latencyLatest(ctx: RedisContext, node?: string): Promise<LatencyEvent[]> {
  return parseLatencyLatest(await reply(ctx, ['latency', 'latest'], node));
}

export async function latencyHistory(
  ctx: RedisContext,
  event: string,
  node?: string,
): Promise<LatencySample[]> {
  return parseLatencyHistory(await reply(ctx, ['latency', 'history', event], node));
}

export async function aclGetUser(ctx: RedisContext, name: string): Promise<AclUser | null> {
  const raw = await ctx.call(['acl', 'getuser', name], ctx.nodeFor(undefined));
  return raw === null ? null : parseAclUser(toRedisReply(raw));
}

export async function aclLog(ctx: RedisContext, count?: number): Promise<AclLogEntry[]> {
  const args: Arg[] = ['acl', 'log'];
  if (count !== undefined) args.push(count);
  return parseAclLog(await reply(ctx, args));
}

/** ACL changes are per node: in Cluster mode they go to every node. */
export async function aclOnEveryNode(ctx: RedisContext, args: readonly Arg[]): Promise<unknown[]> {
  const nodes = ctx.conn.isCluster
    ? [...ctx.conn.primaries(), ...ctx.conn.replicas()]
    : [ctx.nodeFor(undefined)];
  return Promise.all(nodes.map((n) => ctx.call(args, n)));
}

export async function pubsubNumSub(
  ctx: RedisContext,
  channels: readonly RedisBytes[],
): Promise<{ channel: Uint8Array; subscribers: number }[]> {
  if (channels.length === 0) return [];
  const items = asArray(
    await ctx.call(['pubsub', 'numsub', ...channels.map(toBytes)], ctx.nodeFor(undefined)),
  );
  const out: { channel: Uint8Array; subscribers: number }[] = [];
  for (let i = 0; i + 1 < items.length; i += 2) {
    out.push({ channel: asBytes(items[i])!, subscribers: asNumber(items[i + 1]) ?? 0 });
  }
  return out;
}

/** COMMAND DOCS (Redis 7+) and COMMAND (every server), merged; either may be refused. */
export async function commandDocs(ctx: RedisContext): Promise<CommandCatalog> {
  const node = ctx.nodeFor(undefined);
  const attempt = async (args: Arg[]): Promise<RedisReply | undefined> => {
    try {
      return toRedisReply(await ctx.call(args, node));
    } catch (error) {
      if (isServerError(error)) return undefined;
      throw error;
    }
  };
  const [docs, infoReply] = await Promise.all([attempt(['command', 'docs']), attempt(['command'])]);
  return buildCommandCatalog({
    ...(docs ? { docs } : {}),
    ...(infoReply ? { info: infoReply } : {}),
  });
}

// ---------------------------------------------------------------------------------------------
// Big keys

const LENGTH: Readonly<Record<string, string>> = {
  string: 'strlen',
  hash: 'hlen',
  list: 'llen',
  set: 'scard',
  zset: 'zcard',
  stream: 'xlen',
};

/**
 * The big-key report (spec §10): SCAN a sample of keys (bounded by `sampleSize` and the time
 * budget, cancellable), size each with MEMORY USAGE, and group by key pattern. Estimates the
 * total from the sample and DBSIZE.
 */
export async function bigKeys(
  ctx: RedisContext,
  options: BigKeyOptions = {},
): Promise<BigKeyReport> {
  const started = performance.now();
  const sampleSize = options.sampleSize ?? 5000;
  const deadline = started + (options.timeBudgetMs ?? 10_000);
  const samples: (KeySample & { ttlMs: number; length: number | null })[] = [];
  let cursor = '0';
  let scanCalls = 0;
  let complete = false;
  let cancelled = false;
  let memoryDenied = false;
  // Refusals (NOPERM for keys outside the ACL patterns) leave a field unknown; a lost
  // connection still fails the report.
  const soft = (error: unknown): null => {
    if (!isServerError(error)) throw error;
    if (error.engineCode === 'NOPERM') memoryDenied = true;
    return null;
  };
  const measure = async (key: Uint8Array): Promise<void> => {
    const type = asText(await ctx.call(['type', key]).catch(soft)) ?? '';
    if (type === 'none') return;
    const memArgs: Arg[] = ['memory', 'usage', key];
    if (options.memorySamples !== undefined) memArgs.push('SAMPLES', options.memorySamples);
    const lengthCommand = LENGTH[type];
    const [bytes, ttl, length] = await Promise.all([
      ctx.call(memArgs).catch(soft),
      ctx.call(['pttl', key]).catch(soft),
      lengthCommand ? ctx.call([lengthCommand, key]).catch(soft) : Promise.resolve(null),
    ]);
    samples.push({
      key,
      type: type || 'unknown',
      bytes: asNumber(bytes),
      ttlMs: asNumber(ttl) ?? -1,
      length: asNumber(length),
    });
  };
  while (samples.length < sampleSize) {
    if (options.signal?.aborted) {
      cancelled = true;
      break;
    }
    if (performance.now() >= deadline) break;
    const step = await scan(ctx, {
      cursor,
      count: 500,
      ...(options.match !== undefined ? { match: options.match } : {}),
      ...(options.node !== undefined ? { node: options.node } : {}),
    });
    scanCalls += 1;
    cursor = step.cursor;
    const room = sampleSize - samples.length;
    const keys = step.keys.slice(0, room);
    for (let i = 0; i < keys.length; i += 100) {
      await Promise.all(keys.slice(i, i + 100).map(measure));
    }
    options.onProgress?.({ sampled: samples.length, scanCalls });
    if (step.done) {
      complete = keys.length === step.keys.length;
      break;
    }
  }
  const totalKeys = await dbSize(ctx, options.node).catch(() => samples.length);
  const sampledBytes = samples.reduce((sum, s) => sum + (s.bytes ?? 0), 0);
  const largest: BigKeyEntry[] = [...samples]
    .filter((s) => s.bytes !== null)
    .sort((a, b) => (b.bytes ?? 0) - (a.bytes ?? 0))
    .slice(0, options.top ?? 20)
    .map((s) => ({ key: s.key, type: s.type, bytes: s.bytes, length: s.length, ttlMs: s.ttlMs }));
  return {
    sampled: samples.length,
    totalKeys,
    sampledBytes,
    estimatedTotalBytes:
      samples.length > 0
        ? Math.round((sampledBytes * Math.max(totalKeys, samples.length)) / samples.length)
        : 0,
    patterns: aggregateByPattern(samples, { delimiter: ctx.keyDelimiter, limit: 50 }),
    largest,
    complete,
    cancelled,
    memoryDenied,
    durationMs: Math.round(performance.now() - started),
  };
}

// ---------------------------------------------------------------------------------------------
// Topology

function peer(raw: unknown): SentinelPeer {
  const record = asRecord(raw);
  const fields: Record<string, string> = {};
  for (const [k, v] of Object.entries(record)) fields[k] = asText(v) ?? '';
  return {
    host: fields['ip'] ?? '',
    port: Number(fields['port'] ?? 0),
    flags: fields['flags'] ?? '',
    fields,
  };
}

async function sentinelView(ctx: RedisContext): Promise<RedisTopologyView['sentinel']> {
  const plan = ctx.conn.plan;
  const masterName = plan.masterName ?? '';
  let lastError: unknown;
  for (const seed of plan.seeds) {
    if (seed.kind !== 'tcp') continue;
    const sentinel = new Redis({
      host: seed.host,
      port: seed.port,
      lazyConnect: true,
      enableReadyCheck: false,
      protocol: 2,
      retryStrategy: () => null,
      maxRetriesPerRequest: 0,
      connectTimeout: plan.connectTimeoutMs,
      ...(plan.password !== undefined
        ? { username: plan.user ?? 'default', password: plan.password }
        : {}),
      ...(plan.tlsOptions ? { tls: plan.tlsOptions } : {}),
    });
    sentinel.on('error', () => undefined);
    try {
      await connectClient(sentinel, ctx.conn.context('connect'));
      const [master, replicas, sentinels] = await Promise.all([
        sentinel.callBuffer('sentinel', 'master', masterName),
        sentinel.callBuffer('sentinel', 'replicas', masterName),
        sentinel.callBuffer('sentinel', 'sentinels', masterName),
      ]);
      const m = peer(master);
      const masterView: SentinelMaster = {
        name: m.fields['name'] ?? masterName,
        host: m.host,
        port: m.port,
        flags: m.flags,
        replicas: Number(m.fields['num-slaves'] ?? 0),
        sentinels: Number(m.fields['num-other-sentinels'] ?? 0) + 1,
        quorum: Number(m.fields['quorum'] ?? 0),
        fields: m.fields,
      };
      return {
        masterName,
        master: masterView,
        replicas: asArray(replicas).map(peer),
        sentinels: [
          { host: seed.host, port: seed.port, flags: 'sentinel,myself', fields: {} },
          ...asArray(sentinels).map(peer),
        ],
      };
    } catch (error) {
      lastError = error;
    } finally {
      sentinel.disconnect();
    }
  }
  throw lastError === undefined
    ? new JoineryError({ code: 'CONNECTION_FAILED', message: 'No Sentinel answered' })
    : mapRedisError(lastError, ctx.conn.context('command', 'SENTINEL'));
}

function withAddress(node: ClusterNodeInfo): TopologyNode {
  return { ...node, address: nodeAddress(node) };
}

/**
 * The topology view (spec §10): Cluster nodes with roles, slot ranges and replication links
 * (CLUSTER SHARDS on 7+, CLUSTER NODES before); in Sentinel mode what the Sentinels report
 * about the master, its replicas and each other; otherwise the server and its replicas.
 */
export async function topology(ctx: RedisContext): Promise<RedisTopologyView> {
  if (ctx.conn.isCluster) {
    const node = ctx.nodeFor(undefined);
    let nodes: ClusterNodeInfo[];
    try {
      nodes = parseClusterShards(toRedisReply(await ctx.call(['cluster', 'shards'], node)));
    } catch {
      nodes = parseClusterNodes(asText(await ctx.call(['cluster', 'nodes'], node)) ?? '');
    }
    const self = addressOf(node);
    return {
      topology: 'cluster',
      nodes: nodes.map((n) => {
        const view = withAddress(n);
        return view.address === self ? { ...view, myself: true } : view;
      }),
      uncoveredSlots: uncoveredSlots(nodes),
    };
  }
  const replication = parseReplication(parseInfo(await text(ctx, ['info', 'replication'])));
  const target = ctx.conn.plan.target;
  const main = ctx.conn.primaries()[0]!;
  const host = main.stream?.remoteAddress ?? (target.kind === 'tcp' ? target.host : 'localhost');
  const port = main.stream?.remotePort ?? (target.kind === 'tcp' ? target.port : 0);
  const selfNode: TopologyNode = withAddress({
    id: '',
    host,
    port,
    role: replication.isReplica ? 'replica' : 'primary',
    flags: [replication.isReplica ? 'slave' : 'master', 'myself'],
    myself: true,
    failing: false,
    state: 'connected',
    slots: [],
    ...(replication.masterReplOffset !== undefined
      ? { replicationOffset: replication.masterReplOffset }
      : {}),
  });
  const replicas: TopologyNode[] = replication.replicas.map((r) =>
    withAddress({
      id: '',
      host: r.ip,
      port: r.port,
      role: 'replica',
      flags: ['slave'],
      myself: false,
      failing: r.state !== 'online',
      state: r.state,
      slots: [],
      replicationOffset: r.offset,
    }),
  );
  const nodes = [
    { ...selfNode, id: selfNode.address },
    ...replicas.map((r) => ({ ...r, id: r.address, primaryId: selfNode.address })),
  ];
  const view: RedisTopologyView = {
    topology: ctx.server.topology,
    nodes,
    uncoveredSlots: [],
  };
  if (ctx.server.topology !== 'sentinel') return view;
  return { ...view, sentinel: await sentinelView(ctx) };
}
