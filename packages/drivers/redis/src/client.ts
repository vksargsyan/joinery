import type { Socket } from 'node:net';
import type { ConnectionOptions } from 'node:tls';

import { JoineryError } from '@joinery/core';
import { Cluster, Command, Redis, type ClusterOptions, type RedisOptions } from 'ioredis';

import type { RedisConnectionPlan } from './config';
import { isReplyError, mapRedisError, pickConnectError, type RedisErrorContext } from './errors';
import { NodeRouting, announcedAddress } from './routing';

/** A command argument as ioredis takes it; byte arrays are sent as they are. */
export type Arg = string | Uint8Array | number;

type IoArg = string | Buffer | number;

/** The command name of an argument list, as text. */
export function commandName(arg: Arg | undefined): string {
  if (arg === undefined) return '';
  return arg instanceof Uint8Array ? new TextDecoder().decode(arg) : String(arg);
}

function toIoArg(arg: Arg): IoArg {
  if (typeof arg === 'string' || typeof arg === 'number') return arg;
  return Buffer.isBuffer(arg) ? arg : Buffer.from(arg.buffer, arg.byteOffset, arg.byteLength);
}

/**
 * "host:port" of an ioredis node connection: the address the node announced, also when it is
 * reached through a tunnel's forward (see NodeRouting).
 */
export function addressOf(node: Redis): string {
  const host = node.options.host ?? 'localhost';
  const port = node.options.port ?? 6379;
  const address = host.includes(':') ? `[${host}]:${port}` : `${host}:${port}`;
  return announcedAddress(address) ?? address;
}

/** The host and port of `addressOf`. */
export function hostPortOf(node: Redis): { host: string; port: number } {
  const address = addressOf(node);
  const colon = address.lastIndexOf(':');
  return {
    host: address.slice(0, colon).replace(/^\[(.*)\]$/, '$1'),
    port: Number(address.slice(colon + 1)),
  };
}

const MAX_RECONNECTS = 10;

/**
 * The ioredis client(s) behind a session: a standalone / Sentinel-managed `Redis`, or a
 * `Cluster`. Every connection talks RESP2 with Buffer replies (binary safe), never replays a
 * command after a reconnect (a killed command must not run again), and fails pending commands
 * as soon as the connection drops. Once connected, a dropped connection is re-established a few
 * times before the session gives up; while connecting, nothing is retried, so the first error
 * is reported.
 *
 * Sentinel and Cluster behind a tunnel reach every node through its forwards (NodeRouting);
 * `plan.seeds` are then the forwarded seeds or Sentinels.
 */
export class RedisConnection {
  private established = false;
  private closed = false;
  private readonly controls = new Map<string, Promise<Redis>>();
  private readonly clientIds = new WeakMap<Redis, string>();
  private readonly watched = new WeakSet<Redis>();
  private readonly extra = new Set<Redis | Cluster>();

  private constructor(
    readonly plan: RedisConnectionPlan,
    readonly client: Redis | Cluster,
    private readonly routing: NodeRouting | undefined,
  ) {}

  /**
   * TLS options for a direct connection to one of the Sentinels. Behind a tunnel the seeds are
   * local forwards, so a certificate is checked against the configured Sentinel names instead.
   */
  sentinelTls(): ConnectionOptions | undefined {
    return this.routing ? this.routing.sentinelTls() : this.plan.tlsOptions;
  }

  /** Opens and authenticates the connection; maps failures to JoineryErrors with hints. */
  static async open(plan: RedisConnectionPlan): Promise<RedisConnection> {
    const routing = plan.nodeRoute ? await NodeRouting.open(plan, plan.nodeRoute) : undefined;
    const routed: RedisConnectionPlan = routing
      ? { ...plan, seeds: routing.seeds, target: routing.seeds[0] ?? plan.target }
      : plan;
    const box: { conn?: RedisConnection } = {};
    const live = (): boolean => box.conn !== undefined && box.conn.established && !box.conn.closed;
    const retry = (times: number): number | null =>
      live() && times <= MAX_RECONNECTS ? Math.min(times * 200, 2000) : null;
    const client = createClient(routed, retry, live, routing);
    const conn = new RedisConnection(routed, client, routing);
    box.conn = conn;
    // Errors also reach the pending commands; the listeners keep ioredis from logging them.
    client.on('error', () => undefined);
    if (client instanceof Cluster) client.on('node error', () => undefined);
    try {
      await connectClient(client, conn.context('connect'));
    } catch (error) {
      routing?.release();
      throw error;
    }
    conn.established = true;
    return conn;
  }

  context(phase: RedisErrorContext['phase'], command?: string): RedisErrorContext {
    return {
      where: this.plan.where,
      phase,
      ...(command !== undefined ? { command } : {}),
      ...(this.plan.masterName !== undefined ? { masterName: this.plan.masterName } : {}),
    };
  }

  get isCluster(): boolean {
    return this.client instanceof Cluster;
  }

  get isOpen(): boolean {
    return !this.closed;
  }

  /** Cluster primaries sorted by address; the one connection otherwise. */
  primaries(): Redis[] {
    if (!(this.client instanceof Cluster)) return [this.client];
    return this.client.nodes('master').sort((a, b) => addressOf(a).localeCompare(addressOf(b)));
  }

  /** Cluster replicas sorted by address; none otherwise. */
  replicas(): Redis[] {
    if (!(this.client instanceof Cluster)) return [];
    return this.client.nodes('slave').sort((a, b) => addressOf(a).localeCompare(addressOf(b)));
  }

  /** The node connection for "host:port"; NOT_FOUND when the session knows no such node. */
  node(address: string): Redis {
    const all = [...this.primaries(), ...this.replicas()];
    const found = all.find((n) => addressOf(n) === address);
    if (!found) {
      throw new JoineryError({
        code: 'NOT_FOUND',
        message: `No node ${address} in this ${this.isCluster ? 'cluster' : 'connection'}`,
        hint: `Known nodes: ${all.map(addressOf).join(', ')}`,
      });
    }
    return found;
  }

  /** Cluster: the primary serving the slot of the command's keys; undefined for keyless ones. */
  slotOwner(args: readonly Arg[]): Redis | undefined {
    if (!(this.client instanceof Cluster)) return undefined;
    let slot: number | null | undefined;
    try {
      const [name, ...rest] = args;
      slot = new Command(commandName(name).toLowerCase(), rest.map(toIoArg)).getSlot();
    } catch {
      return undefined;
    }
    if (slot === null || slot === undefined) return undefined;
    const key = this.client.slots[slot]?.[0];
    if (key === undefined) return undefined;
    const owner = announcedAddress(key) ?? key;
    return this.primaries().find((n) => addressOf(n) === owner);
  }

  /** Runs a command; with `node`, on that node connection (following MOVED / ASK in Cluster mode). */
  async raw(args: readonly Arg[], node?: Redis): Promise<unknown> {
    return (await this.rawOn(args, node)).value;
  }

  /**
   * Like `raw`, and says which node answered: in Cluster mode a command sent to one node may be
   * redirected (MOVED / ASK) to another.
   */
  async rawOn(args: readonly Arg[], node?: Redis): Promise<{ value: unknown; node?: Redis }> {
    if (args.length === 0)
      throw new JoineryError({ code: 'VALIDATION_FAILED', message: 'No command' });
    const name = commandName(args[0]);
    const rest = args.slice(1).map(toIoArg);
    const target = node ?? this.client;
    if (target instanceof Redis && this.client instanceof Cluster) {
      return this.onNode(target, name, rest, 3);
    }
    return { value: await target.callBuffer(name, ...rest), ...(node ? { node } : {}) };
  }

  private async onNode(
    node: Redis,
    name: string,
    rest: IoArg[],
    redirects: number,
  ): Promise<{ value: unknown; node?: Redis }> {
    try {
      return { value: await node.callBuffer(name, ...rest), node };
    } catch (error) {
      const redirect = isReplyError(error) ? /^(MOVED|ASK) \d+ (\S+)$/.exec(error.message) : null;
      if (!redirect || redirects <= 0 || !(this.client instanceof Cluster)) throw error;
      const cluster = this.client;
      if (redirect[1] === 'MOVED') cluster.refreshSlotsCache();
      const address = redirect[2]!;
      const next = [...this.primaries(), ...this.replicas()].find((n) => addressOf(n) === address);
      // A node the pool does not know yet: let ioredis route it.
      if (!next) return { value: await cluster.callBuffer(name, ...rest) };
      if (redirect[1] === 'ASK') {
        const results = await next
          .pipeline()
          .call('asking')
          .callBuffer(name, ...rest)
          .exec();
        const [err, value] = results?.[1] ?? [new Error('ASK redirection failed'), null];
        if (err) throw err;
        return { value, node: next };
      }
      return this.onNode(next, name, rest, redirects - 1);
    }
  }

  /** Runs a command and maps a failure to a JoineryError. */
  async call(args: readonly Arg[], node?: Redis): Promise<unknown> {
    try {
      return await this.raw(args, node);
    } catch (error) {
      throw mapRedisError(error, this.context('command', commandName(args[0]).toUpperCase()));
    }
  }

  /**
   * Runs commands on the standalone connection in one write, so nothing else interleaves
   * (used to run a command in another logical database between two SELECTs). Returns the
   * replies in order; a failed command's error is in its slot.
   */
  async atomic(
    commands: readonly (readonly Arg[])[],
  ): Promise<{ error: unknown; value: unknown }[]> {
    if (this.client instanceof Cluster) {
      throw new JoineryError({ code: 'NOT_SUPPORTED', message: 'Not available in Cluster mode' });
    }
    const pipeline = this.client.pipeline();
    for (const [name, ...rest] of commands) pipeline.callBuffer(String(name), ...rest.map(toIoArg));
    const results = (await pipeline.exec()) ?? [];
    return results.map(([error, value]) => ({ error, value }));
  }

  /** CLIENT ID of a node connection, cached until that connection closes. */
  async clientId(node: Redis): Promise<string> {
    const cached = this.clientIds.get(node);
    if (cached !== undefined) return cached;
    if (!this.watched.has(node)) {
      this.watched.add(node);
      node.on('close', () => this.clientIds.delete(node));
    }
    const id = String(await node.callBuffer('client', 'id'));
    this.clientIds.set(node, id);
    return id;
  }

  /** Kills a client (by CLIENT ID) of `node` from a separate control connection. */
  async killClient(node: Redis, clientId: string): Promise<void> {
    const control = await this.control(node);
    await control.callBuffer('client', 'kill', 'id', clientId);
  }

  private control(node: Redis): Promise<Redis> {
    const address = addressOf(node);
    let pending = this.controls.get(address);
    if (!pending) {
      const created = node.duplicate({ connectionName: `${this.plan.connectionName}-control` });
      created.on('error', () => undefined);
      pending = connectClient(created, this.context('connect')).then(() => created);
      pending.catch(() => this.controls.delete(address));
      this.controls.set(address, pending);
    }
    return pending;
  }

  /** A new connection with the same settings (Pub/Sub, MONITOR), connected; closed with the session. */
  async duplicate(node?: Redis): Promise<Redis | Cluster> {
    const source = node ?? this.client;
    const created: Redis | Cluster =
      source instanceof Cluster ? source.duplicate() : source.duplicate();
    created.on('error', () => undefined);
    await connectClient(created, this.context('connect'));
    this.adopt(created);
    return created;
  }

  /** Closes `client` with the session (Pub/Sub and MONITOR connections). */
  adopt(client: Redis | Cluster): void {
    this.extra.add(client);
    client.once('end', () => this.extra.delete(client));
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const controls = [...this.controls.values()];
    this.controls.clear();
    for (const pending of controls) {
      await pending.then((c) => c.disconnect()).catch(() => undefined);
    }
    for (const c of this.extra) c.disconnect();
    this.extra.clear();
    this.client.disconnect();
    this.routing?.release();
  }
}

/** Connects an ioredis client, reporting the most telling error when it fails. */
export async function connectClient(
  client: Redis | Cluster,
  ctx: RedisErrorContext,
): Promise<void> {
  const events: unknown[] = [];
  const listener = (error: unknown): void => {
    events.push(error);
  };
  client.on('error', listener);
  if (client instanceof Cluster) client.on('node error', listener);
  try {
    await client.connect();
  } catch (error) {
    client.disconnect();
    throw pickConnectError(error, events, ctx);
  } finally {
    client.off('error', listener);
    if (client instanceof Cluster) client.off('node error', listener);
  }
}

function withoutKeepAlive(redis: Redis): void {
  redis.on('connect', () => {
    const stream = redis.stream as Socket | undefined;
    stream?.setKeepAlive?.(false);
  });
}

/** The ioredis options every connection of a plan shares (per node in Cluster mode). */
function commonOptions(plan: RedisConnectionPlan): RedisOptions {
  return {
    lazyConnect: true,
    enableReadyCheck: false,
    protocol: 2,
    maxRetriesPerRequest: 0,
    autoResendUnfulfilledCommands: false,
    enableOfflineQueue: true,
    connectTimeout: plan.connectTimeoutMs,
    ...(plan.commandTimeoutMs !== undefined ? { commandTimeout: plan.commandTimeoutMs } : {}),
    keepAlive: 30_000,
    noDelay: true,
    connectionName: plan.connectionName,
    clientInfoTag: 'joinery',
    ...(plan.user !== undefined ? { username: plan.user } : {}),
    ...(plan.password !== undefined ? { password: plan.password } : {}),
    ...(plan.tlsOptions ? { tls: plan.tlsOptions } : {}),
    // Exact 64-bit integers as strings; Cluster needs numbers for its own slot map.
    stringNumbers: plan.topology !== 'cluster',
    showFriendlyErrorStack: false,
  };
}

function createClient(
  plan: RedisConnectionPlan,
  retry: (times: number) => number | null,
  established: () => boolean,
  routing: NodeRouting | undefined,
): Redis | Cluster {
  const common = commonOptions(plan);
  if (plan.topology === 'cluster') {
    const seeds = plan.seeds.map((s) => {
      if (s.kind !== 'tcp') return {};
      const tls = routing?.nodeTls(s.tlsHost);
      return { host: s.host, port: s.port, ...(tls ? { tls } : {}) };
    });
    const options: ClusterOptions = {
      lazyConnect: true,
      enableOfflineQueue: true,
      enableReadyCheck: true,
      scaleReads: 'master',
      slotsRefreshTimeout: Math.max(1000, plan.connectTimeoutMs),
      clusterRetryStrategy: (times) => retry(times) ?? null,
      redisOptions: common,
      ...(routing ? { natMap: routing.natMap } : {}),
    };
    const cluster = new Cluster(seeds, options);
    if (!plan.keepAlive) cluster.on('+node', (node: Redis) => withoutKeepAlive(node));
    return cluster;
  }
  const base: RedisOptions = { ...common, db: plan.database, retryStrategy: retry };
  let redis: Redis;
  if (plan.topology === 'sentinel') {
    redis = new Redis({
      ...base,
      sentinels: plan.seeds.map((s) => (s.kind === 'tcp' ? { host: s.host, port: s.port } : {})),
      name: plan.masterName!,
      // The same credentials for the Sentinels; the explicit "default" user keeps a Sentinel
      // without a password from warning about the one it is given.
      ...(plan.password !== undefined
        ? { sentinelUsername: plan.user ?? 'default', sentinelPassword: plan.password }
        : {}),
      ...(plan.tlsOptions
        ? {
            enableTLSForSentinelMode: true,
            sentinelTLS: routing?.sentinelTls() ?? plan.tlsOptions,
          }
        : {}),
      sentinelCommandTimeout: plan.connectTimeoutMs,
      sentinelRetryStrategy: (times) => (established() && times <= 3 ? 200 : null),
      failoverDetector: false,
      ...(routing ? { natMap: routing.natMap } : {}),
    });
  } else if (plan.target.kind === 'socket') {
    redis = new Redis({ ...base, path: plan.target.path });
  } else {
    redis = new Redis({ ...base, host: plan.target.host, port: plan.target.port });
  }
  if (!plan.keepAlive) withoutKeepAlive(redis);
  return redis;
}
