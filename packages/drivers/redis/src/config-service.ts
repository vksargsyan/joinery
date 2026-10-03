import { QuerybaraError } from '@querybara/core';
import {
  CONFIG_SECRET_MASK,
  configErrorParameter,
  isSecretConfig,
  versionAtLeast,
  type ConfigChange,
  type ConfigNodeValues,
} from '@querybara/redis-tools';
import type { Redis, RedisOptions } from 'ioredis';

import { addressOf, connectClient, type Arg } from './client';
import type { RedisContext } from './context';
import { mapRedisError } from './errors';
import { isServerError } from './keys';
import { asRecord, asText } from './replies';
import { topology } from './tools';
import type { RedisNode } from './types';

/**
 * The configuration editor's service (spec §15, "CONFIG GET and SET"): CONFIG GET * per node,
 * CONFIG SET of several parameters with a result per parameter, CONFIG REWRITE and CONFIG
 * RESETSTAT. In Cluster mode it works per node (every primary by default); in Sentinel mode on
 * the master, or on a replica reached through the Sentinels. Secret values (requirepass,
 * masterauth…) never leave this module: reads say only whether they are set. When the server
 * refuses CONFIG itself (an ACL user without @admin, or a managed service that renamed or
 * disabled it), the calls fail with NOT_SUPPORTED and a hint the page shows as is.
 */

/** Which nodes a configuration call covers. */
export interface ConfigTarget {
  /**
   * "host:port" of one node: in Cluster mode any primary or replica; in Sentinel mode a replica
   * the Sentinels report (the master when absent). Standalone servers have only themselves.
   */
  readonly node?: string;
  /** Cluster, without `node`: the replicas too (default: every primary). */
  readonly replicas?: boolean;
}

/** A node the configuration editor can target. */
export interface ConfigNode {
  readonly address: string;
  readonly role: 'primary' | 'replica';
}

export interface ConfigSnapshot {
  /** One entry per node read, in node order. */
  readonly nodes: readonly ConfigNodeValues[];
  /** CONFIG SET takes several parameters in one all-or-nothing call (Redis 7+, Valkey). */
  readonly multiSet: boolean;
}

export interface ConfigParameterOutcome {
  readonly name: string;
  readonly applied: boolean;
  /** Why it was not applied: the server's error, or that an all-or-nothing call failed. */
  readonly error?: string;
}

export interface ConfigApplyResult {
  /** The changes went in one all-or-nothing CONFIG SET per node. */
  readonly atomic: boolean;
  readonly nodes: readonly {
    readonly node: string;
    readonly parameters: readonly ConfigParameterOutcome[];
  }[];
}

/** The outcome of CONFIG REWRITE or CONFIG RESETSTAT on one node. */
export interface ConfigNodeOutcome {
  readonly node: string;
  readonly ok: boolean;
  readonly error?: string;
}

/** What the service needs from the session: the service context and its nodes. */
export interface ConfigContext extends RedisContext {
  nodes(includeReplicas?: boolean): RedisNode[];
}

interface Endpoint {
  readonly address: string;
  readonly role: 'primary' | 'replica';
  /** Runs a command on the node; failures are QuerybaraErrors. */
  run(args: readonly Arg[]): Promise<unknown>;
}

/** Whether CONFIG SET takes several parameters at once (and applies them all or none). */
export function supportsMultiSet(ctx: RedisContext): boolean {
  return versionAtLeast(ctx.server.redisVersion, '7.0.0');
}

function splitAddress(address: string): [string, string] {
  const match = /^\[?(.*?)\]?:(\d+)$/.exec(address);
  if (!match) {
    throw new QuerybaraError({
      code: 'VALIDATION_FAILED',
      message: `"${address}" is not a host:port address`,
    });
  }
  return [match[1]!, match[2]!];
}

function noSuchNode(address: string, known: readonly string[]): QuerybaraError {
  return new QuerybaraError({
    code: 'NOT_FOUND',
    message: `No node ${address} in this connection`,
    hint: `Known nodes: ${known.join(', ')}`,
  });
}

interface Closable {
  close(): void;
}

/**
 * A replica of the Sentinel-managed master, on its own short-lived connection that the
 * Sentinels resolve (so address translation for tunnels applies as for the master). Fails with
 * NOT_FOUND when the Sentinels do not list it as available.
 */
async function sentinelReplica(ctx: ConfigContext, address: string): Promise<Endpoint & Closable> {
  const [host, port] = splitAddress(address);
  const master = ctx.conn.primaries()[0]!;
  let listed = false;
  const options: Partial<RedisOptions> = {
    role: 'slave',
    // Only this replica: ioredis would otherwise fall back to a random one.
    preferredSlaves: (slaves) => {
      const found = slaves.find((s) => s.ip === host && String(s.port) === port) ?? null;
      listed = found !== null;
      return found;
    },
    retryStrategy: () => null,
    sentinelRetryStrategy: () => null,
  };
  const replica = master.duplicate(options);
  replica.on('error', () => undefined);
  await connectClient(replica, ctx.conn.context('connect'));
  if (!listed) {
    replica.disconnect();
    throw new QuerybaraError({
      code: 'NOT_FOUND',
      message: `The Sentinels do not list ${address} as an available replica`,
      hint: 'Refresh the node list: the replica may be down or have been promoted',
    });
  }
  return {
    address,
    role: 'replica',
    run: async (args) => {
      try {
        const [name, ...rest] = args;
        return await replica.callBuffer(
          String(name),
          ...rest.map((a) =>
            a instanceof Uint8Array ? Buffer.from(a.buffer, a.byteOffset, a.byteLength) : a,
          ),
        );
      } catch (error) {
        throw mapRedisError(error, { ...ctx.conn.context('command', 'CONFIG'), where: address });
      }
    },
    close: () => replica.disconnect(),
  };
}

function onNode(ctx: ConfigContext, node: Redis, role: Endpoint['role']): Endpoint {
  return { address: addressOf(node), role, run: (args) => ctx.call(args, node) };
}

/** Runs `task` on the target's nodes, closing any connection opened for it. */
async function withEndpoints<T>(
  ctx: ConfigContext,
  target: ConfigTarget,
  task: (endpoints: readonly Endpoint[]) => Promise<T>,
): Promise<T> {
  if (ctx.conn.isCluster) {
    if (target.node !== undefined) {
      const node = ctx.conn.node(target.node);
      const replica = ctx.conn.replicas().includes(node);
      return task([onNode(ctx, node, replica ? 'replica' : 'primary')]);
    }
    return task([
      ...ctx.conn.primaries().map((n) => onNode(ctx, n, 'primary')),
      ...(target.replicas ? ctx.conn.replicas().map((n) => onNode(ctx, n, 'replica')) : []),
    ]);
  }
  const self = ctx.nodes()[0]!;
  if (target.node === undefined || target.node === self.address) {
    const main = ctx.nodeFor(undefined);
    return task([{ address: self.address, role: self.role, run: (args) => ctx.call(args, main) }]);
  }
  if (ctx.server.topology !== 'sentinel') throw noSuchNode(target.node, [self.address]);
  const replica = await sentinelReplica(ctx, target.node);
  try {
    return await task([replica]);
  } finally {
    replica.close();
  }
}

/**
 * The error for a refused CONFIG command, when the refusal is about CONFIG itself (an ACL
 * user without it, or a server that renamed or disabled it) rather than one parameter.
 */
function unavailable(error: unknown, subcommand: string): QuerybaraError | undefined {
  if (!isServerError(error)) return undefined;
  if (error.engineCode === 'NOPERM') {
    return new QuerybaraError(
      {
        code: 'NOT_SUPPORTED',
        engineCode: 'NOPERM',
        message: `The ACL user may not run CONFIG ${subcommand}`,
        hint:
          'CONFIG is in the @admin and @dangerous ACL categories: grant +config|get to read the ' +
          'configuration and +config|set to change it, or connect as an administrator',
      },
      { cause: error },
    );
  }
  if (
    configErrorParameter(error.message) === undefined &&
    /unknown (sub)?command|not allowed|disabled/i.test(error.message)
  ) {
    return new QuerybaraError(
      {
        code: 'NOT_SUPPORTED',
        ...(error.engineCode !== undefined ? { engineCode: error.engineCode } : {}),
        message: `This server does not offer CONFIG ${subcommand}: it was renamed or disabled`,
        hint:
          'Managed Redis and Valkey services often rename or disable CONFIG; change the ' +
          'parameters in the provider’s console instead',
      },
      { cause: error },
    );
  }
  return undefined;
}

/** The server's message for a failed command; throws what is not a per-node server error. */
function serverMessage(error: unknown, subcommand: string): string {
  const refused = unavailable(error, subcommand);
  if (refused) throw refused;
  if (!isServerError(error)) throw error;
  return error.message;
}

/** Nodes the editor can target: Cluster nodes, the Sentinel master and its replicas, or the server. */
export async function configNodes(ctx: ConfigContext): Promise<ConfigNode[]> {
  const nodes: ConfigNode[] = ctx.nodes(true).map((n) => ({ address: n.address, role: n.role }));
  if (ctx.server.topology !== 'sentinel') return nodes;
  const view = await topology(ctx).catch(() => undefined);
  for (const replica of view?.sentinel?.replicas ?? []) {
    if (/s_down|o_down|disconnected/.test(replica.flags)) continue;
    const host = replica.host.includes(':') ? `[${replica.host}]` : replica.host;
    nodes.push({ address: `${host}:${replica.port}`, role: 'replica' });
  }
  return nodes;
}

async function readNode(endpoint: Endpoint): Promise<ConfigNodeValues> {
  let raw: unknown;
  try {
    raw = await endpoint.run(['config', 'get', '*']);
  } catch (error) {
    throw unavailable(error, 'GET') ?? error;
  }
  const values: Record<string, string> = {};
  const secrets: Record<string, boolean> = {};
  for (const [name, value] of Object.entries(asRecord(raw))) {
    const text = asText(value) ?? '';
    if (isSecretConfig(name)) secrets[name] = text !== '';
    else values[name] = text;
  }
  return { node: endpoint.address, role: endpoint.role, values, secrets };
}

/** CONFIG GET * on the target's nodes (every primary by default in Cluster mode). */
export async function configRead(
  ctx: ConfigContext,
  target: ConfigTarget = {},
): Promise<ConfigSnapshot> {
  return withEndpoints(ctx, target, async (endpoints) => ({
    nodes: await Promise.all(endpoints.map(readNode)),
    multiSet: supportsMultiSet(ctx),
  }));
}

/** Replaces secret values in a server message (6.2 echoes a refused value in its error). */
function scrub(message: string, changes: readonly ConfigChange[]): string {
  let out = message;
  for (const change of changes) {
    if (isSecretConfig(change.name) && change.value !== '') {
      out = out.split(change.value).join(CONFIG_SECRET_MASK);
    }
  }
  return out;
}

async function applyOnNode(
  endpoint: Endpoint,
  changes: readonly ConfigChange[],
  atomic: boolean,
): Promise<{ node: string; parameters: ConfigParameterOutcome[] }> {
  const node = endpoint.address;
  if (atomic) {
    try {
      await endpoint.run(['config', 'set', ...changes.flatMap((c) => [c.name, c.value])]);
      return { node, parameters: changes.map((c) => ({ name: c.name, applied: true })) };
    } catch (error) {
      const message = scrub(serverMessage(error, 'SET'), changes);
      const culprit = configErrorParameter(message)?.toLowerCase();
      const known = changes.some((c) => c.name.toLowerCase() === culprit);
      return {
        node,
        parameters: changes.map((c) => ({
          name: c.name,
          applied: false,
          error:
            !known || c.name.toLowerCase() === culprit
              ? message
              : `Not applied: the server applies these changes all or none, and it refused ${culprit}`,
        })),
      };
    }
  }
  const parameters: ConfigParameterOutcome[] = [];
  for (const change of changes) {
    try {
      await endpoint.run(['config', 'set', change.name, change.value]);
      parameters.push({ name: change.name, applied: true });
    } catch (error) {
      parameters.push({
        name: change.name,
        applied: false,
        error: scrub(serverMessage(error, 'SET'), [change]),
      });
    }
  }
  return { node, parameters };
}

/**
 * CONFIG SET of `changes` on the target's nodes (every primary by default in Cluster mode): in
 * one all-or-nothing call per node on Redis 7+ and Valkey, one parameter at a time before
 * (where some may apply and others not). Refusals come back per parameter; only a refusal of
 * CONFIG itself fails the call.
 */
export async function configApply(
  ctx: ConfigContext,
  changes: readonly ConfigChange[],
  target: ConfigTarget = {},
): Promise<ConfigApplyResult> {
  const seen = new Set<string>();
  for (const change of changes) {
    const name = change.name.trim().toLowerCase();
    if (name === '' || /\s/.test(name)) {
      throw new QuerybaraError({ code: 'VALIDATION_FAILED', message: 'Enter a parameter name' });
    }
    if (seen.has(name)) {
      throw new QuerybaraError({
        code: 'VALIDATION_FAILED',
        message: `${change.name} is changed twice`,
      });
    }
    seen.add(name);
  }
  const atomic = supportsMultiSet(ctx) && changes.length > 1;
  if (changes.length === 0) return { atomic, nodes: [] };
  return withEndpoints(ctx, target, async (endpoints) => ({
    atomic,
    nodes: await Promise.all(endpoints.map((e) => applyOnNode(e, changes, atomic))),
  }));
}

const REWRITE_HINTS: readonly (readonly [RegExp, string])[] = [
  [
    /without a config file/i,
    'The server was started without a configuration file, so there is nothing to rewrite',
  ],
];

async function onEach(
  ctx: ConfigContext,
  target: ConfigTarget,
  subcommand: 'REWRITE' | 'RESETSTAT',
): Promise<ConfigNodeOutcome[]> {
  return withEndpoints(ctx, target, (endpoints) =>
    Promise.all(
      endpoints.map(async (endpoint): Promise<ConfigNodeOutcome> => {
        try {
          await endpoint.run(['config', subcommand.toLowerCase()]);
          return { node: endpoint.address, ok: true };
        } catch (error) {
          const message = serverMessage(error, subcommand);
          const friendly = REWRITE_HINTS.find(([pattern]) => pattern.test(message))?.[1];
          return { node: endpoint.address, ok: false, error: friendly ?? message };
        }
      }),
    ),
  );
}

/** CONFIG REWRITE: writes the running configuration into each node's configuration file. */
export function configRewrite(
  ctx: ConfigContext,
  target: ConfigTarget = {},
): Promise<ConfigNodeOutcome[]> {
  return onEach(ctx, target, 'REWRITE');
}

/** CONFIG RESETSTAT: resets INFO's counters, command and error stats and latency percentiles. */
export function configResetStat(
  ctx: ConfigContext,
  target: ConfigTarget = {},
): Promise<ConfigNodeOutcome[]> {
  return onEach(ctx, target, 'RESETSTAT');
}
