import { isIP } from 'node:net';
import { checkServerIdentity, type ConnectionOptions, type PeerCertificate } from 'node:tls';

import type { HostPort } from '@joinery/core';
import type { NetworkTarget } from '@joinery/driver-sql-base';
import type { NodeRoute } from '@joinery/tunnel';
import { Redis, type RedisOptions } from 'ioredis';

import type { RedisConnectionPlan } from './config';

/**
 * Sentinel and Cluster behind an SSH tunnel or proxy (ADR 0008). ioredis connects to the
 * addresses the servers announce (CLUSTER SLOTS, MOVED and ASK, the Sentinels' master and
 * replicas), which only the far side can reach; its NAT map, a synchronous function, turns each
 * into a loopback forward of the tunnel's node route. The nodes known up front (the seeds or
 * Sentinels, and what they report) are forwarded before connecting; a node that appears later
 * (a failover, a new replica, a MOVED to a node not seen yet) gets one of the route's reserved
 * forwards at once.
 */

/** Reserved forwards kept ready for nodes that appear after connecting. */
const SPARE_FORWARDS = 4;

/** Local forward ("127.0.0.1:port") → the address the node announced, while a session uses it. */
const announced = new Map<string, { readonly address: string; refs: number }>();

/** The announced address behind a local forward address, or undefined for any other address. */
export function announcedAddress(local: string): string | undefined {
  return announced.get(local)?.address;
}

function addressText({ host, port }: HostPort): string {
  return host.includes(':') ? `[${host}]:${port}` : `${host}:${port}`;
}

/** "host:port" as ioredis keys nodes (IPv6 hosts unbracketed): split at the last colon. */
function parseKey(key: string): HostPort | undefined {
  const colon = key.lastIndexOf(':');
  const port = Number(key.slice(colon + 1));
  if (colon <= 0 || !Number.isInteger(port) || port < 1 || port > 65535) return undefined;
  return { host: key.slice(0, colon).replace(/^\[(.*)\]$/, '$1'), port };
}

/** What ioredis's NAT map returns: the forward, and the node's own TLS name when verified. */
interface Mapped extends HostPort {
  /** For a Cluster node's connection. */
  tls?: ConnectionOptions;
  /** For the Sentinel-resolved master's connection (merged into its TLS options). */
  servername?: string;
  checkServerIdentity?: ConnectionOptions['checkServerIdentity'];
}

/** A connection's view of its node route; see the module comment. */
export class NodeRouting {
  private readonly registered = new Set<string>();
  /** The seeds or Sentinels, forwarded, each with the name its certificate is checked against. */
  readonly seeds: NetworkTarget[] = [];

  private constructor(
    private readonly route: NodeRoute,
    private readonly plan: RedisConnectionPlan,
  ) {}

  /**
   * Forwards the plan's seeds or Sentinels, asks the first that answers for the rest of the
   * topology, forwards that too, and reserves spare forwards for later arrivals.
   */
  static async open(plan: RedisConnectionPlan, route: NodeRoute): Promise<NodeRouting> {
    const routing = new NodeRouting(route, plan);
    try {
      for (const seed of plan.seeds) {
        if (seed.kind !== 'tcp') continue;
        const local = await routing.map(seed);
        routing.seeds.push({ kind: 'tcp', host: local.host, port: local.port, tlsHost: seed.host });
      }
      const nodes = await routing.discover();
      await Promise.all(nodes.map((node) => routing.map(node)));
      await route.reserve(SPARE_FORWARDS);
    } catch (error) {
      routing.release();
      throw error;
    }
    return routing;
  }

  /** ioredis's NAT map: every announced address to its forward (see the module comment). */
  readonly natMap = (key: string): Mapped => {
    const target = parseKey(key);
    const local = target ? this.route.forwardNow(target) : undefined;
    if (!target || !local) {
      // No forward to hand out right now: open one for the next attempt, and give ioredis an
      // address that fails at once rather than the announced one, which would bypass the tunnel.
      if (target) this.map(target).catch(() => undefined);
      return { host: '127.0.0.1', port: 0 };
    }
    this.register(local, target);
    const tls = this.nodeTls(target.host);
    if (!tls) return { host: local.host, port: local.port };
    if (this.plan.topology === 'cluster') return { host: local.host, port: local.port, tls };
    // Sentinel merges these into the master's TLS options.
    return {
      host: local.host,
      port: local.port,
      ...(tls.servername !== undefined ? { servername: tls.servername } : {}),
      ...(tls.checkServerIdentity ? { checkServerIdentity: tls.checkServerIdentity } : {}),
    };
  };

  /**
   * TLS options for a node reached through a forward: the connection goes to 127.0.0.1, so with
   * verify-full the node's certificate is checked against the name it was announced under
   * (unless the profile sets one TLS server name for all of them).
   */
  nodeTls(host: string): ConnectionOptions | undefined {
    const base = this.plan.tlsOptions;
    if (!base || this.plan.tls.mode !== 'verify-full' || base.checkServerIdentity) return base;
    return {
      ...base,
      ...(isIP(host) === 0 ? { servername: host } : {}),
      checkServerIdentity: (_host: string, cert: PeerCertificate) =>
        checkServerIdentity(host, cert),
    };
  }

  /** TLS options for the Sentinels: a certificate valid for any of the configured ones passes. */
  sentinelTls(): ConnectionOptions | undefined {
    const base = this.plan.tlsOptions;
    if (!base || this.plan.tls.mode !== 'verify-full' || base.checkServerIdentity) return base;
    const hosts = this.seeds.map((s) => (s.kind === 'tcp' ? s.tlsHost : ''));
    return {
      ...base,
      checkServerIdentity: (_host: string, cert: PeerCertificate) => {
        let first: Error | undefined;
        for (const host of hosts) {
          const error = checkServerIdentity(host, cert);
          if (!error) return undefined;
          first ??= error;
        }
        return first;
      },
    };
  }

  /** Forgets this connection's announced addresses. */
  release(): void {
    for (const local of this.registered) {
      const entry = announced.get(local);
      if (!entry) continue;
      entry.refs -= 1;
      if (entry.refs <= 0) announced.delete(local);
    }
    this.registered.clear();
  }

  private async map(target: HostPort): Promise<HostPort> {
    const local = await this.route.forward({ host: target.host, port: target.port });
    this.register(local, target);
    return local;
  }

  private register(local: HostPort, target: HostPort): void {
    const key = addressText(local);
    if (this.registered.has(key)) return;
    this.registered.add(key);
    const entry = announced.get(key);
    const address = addressText(target);
    if (entry && entry.address === address) entry.refs += 1;
    else announced.set(key, { address, refs: 1 });
  }

  /** The nodes the first answering seed reports: the cluster's, or the master's set. */
  private async discover(): Promise<HostPort[]> {
    for (const seed of this.seeds) {
      if (seed.kind !== 'tcp') continue;
      const probe = this.discoveryClient(seed);
      probe.on('error', () => undefined);
      try {
        await probe.connect();
        return this.plan.topology === 'cluster'
          ? clusterNodes(await probe.call('cluster', 'slots'))
          : await sentinelNodes(probe, this.plan.masterName ?? '');
      } catch {
        // Try the next one; if none answers, connecting reports why.
      } finally {
        probe.disconnect();
      }
    }
    return [];
  }

  private discoveryClient(seed: Extract<NetworkTarget, { kind: 'tcp' }>): Redis {
    const plan = this.plan;
    const tls = plan.topology === 'sentinel' ? this.sentinelTls() : this.nodeTls(seed.tlsHost);
    const options: RedisOptions = {
      host: seed.host,
      port: seed.port,
      lazyConnect: true,
      enableReadyCheck: false,
      enableOfflineQueue: false,
      retryStrategy: () => null,
      maxRetriesPerRequest: 0,
      protocol: 2,
      connectTimeout: plan.connectTimeoutMs,
      commandTimeout: plan.connectTimeoutMs,
      ...(plan.password !== undefined
        ? { username: plan.user ?? 'default', password: plan.password }
        : {}),
      ...(tls ? { tls } : {}),
    };
    return new Redis(options);
  }
}

/** Every node of a CLUSTER SLOTS reply: [start, end, [ip, port, id], replicas...] per range. */
function clusterNodes(reply: unknown): HostPort[] {
  const nodes = new Map<string, HostPort>();
  for (const range of Array.isArray(reply) ? reply : []) {
    if (!Array.isArray(range)) continue;
    for (const node of range.slice(2)) {
      if (!Array.isArray(node) || typeof node[0] !== 'string' || node[0] === '') continue;
      const port = Number(node[1]);
      if (Number.isInteger(port) && port > 0) {
        nodes.set(`${node[0]}:${port}`, { host: node[0], port });
      }
    }
  }
  return [...nodes.values()];
}

/** The master, its replicas and the other Sentinels, as a Sentinel reports them. */
async function sentinelNodes(sentinel: Redis, masterName: string): Promise<HostPort[]> {
  const nodes: HostPort[] = [];
  const master = await sentinel.call('sentinel', 'get-master-addr-by-name', masterName);
  if (Array.isArray(master) && master.length >= 2) {
    nodes.push({ host: String(master[0]), port: Number(master[1]) });
  }
  for (const kind of ['replicas', 'sentinels']) {
    const peers = await sentinel.call('sentinel', kind, masterName).catch(() => []);
    for (const peer of Array.isArray(peers) ? peers : []) {
      if (!Array.isArray(peer)) continue;
      const fields = new Map<string, string>();
      for (let i = 0; i + 1 < peer.length; i += 2) fields.set(String(peer[i]), String(peer[i + 1]));
      const flags = fields.get('flags') ?? '';
      const ip = fields.get('ip');
      const port = Number(fields.get('port'));
      if (!ip || !Number.isInteger(port) || /disconnected/.test(flags)) continue;
      nodes.push({ host: ip, port });
    }
  }
  return nodes.filter((n) => Number.isInteger(n.port) && n.port > 0);
}
