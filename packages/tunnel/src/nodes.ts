import type { Duplex } from 'node:stream';

import { JoineryError, type HostPort } from '@joinery/core';

import { hostLabel } from './errors';
import { LocalSocksServer } from './socks';
import {
  LocalForwarder,
  asJoineryError,
  type NodeRoute,
  type Route,
  type Transport,
} from './transport';

/** Loopback forwards one transport opens to the servers of its topology, at most. */
export const MAX_NODE_FORWARDS = 64;

/** Servers a probe tries, in order, before it reports the first failure. */
const PROBED_SERVERS = 4;

function keyOf(target: HostPort): string {
  return `${target.host.toLowerCase()}:${target.port}`;
}

/** Lets forwards share the transport's route; only the transport releases it. */
function borrowed(route: Route): Route {
  return {
    open: (target, srcPort) => route.open(target, srcPort),
    release: async () => undefined,
  };
}

function tooManyServers(): JoineryError {
  return new JoineryError({
    code: 'CONNECTION_FAILED',
    message: `This connection already reaches ${MAX_NODE_FORWARDS} servers through the tunnel, the most it may`,
    hint: 'Connect to a smaller part of the topology, or reconnect to drop servers that left it',
    engineCode: 'TOO_MANY_FORWARDS',
  });
}

/**
 * The transport of a profile that reaches several servers (see `tunnelReach`): the usual local
 * endpoint to the first server, and `nodes` to reach the others, all over one route (one SSH
 * chain or the configured proxy). Everything it opened closes with it.
 */
export class NodeTransport implements Transport {
  private readonly listeners = new Set<(error: JoineryError) => void>();
  /** Forwards by target, including those still starting. */
  private readonly forwards = new Map<string, Promise<LocalForwarder>>();
  /** Forwards that are listening, by target: what `forwardNow` can hand out at once. */
  private readonly ready = new Map<string, LocalForwarder>();
  private readonly spares: LocalForwarder[] = [];
  private spareTarget = 0;
  private refilling: Promise<void> | undefined;
  private closing: Promise<void> | undefined;
  readonly nodes: NodeRoute;

  private constructor(
    private readonly route: Route,
    private readonly servers: readonly HostPort[],
    private readonly primary: LocalForwarder,
    private readonly socks: LocalSocksServer,
    readonly description: string,
  ) {
    primary.onError((error) => this.emitError(error));
    const forwardCount = (): number => this.forwards.size;
    const channelCount = (): number => this.channelCount;
    this.nodes = {
      socks5: socks.endpoint,
      forward: (target) => this.forward(target),
      forwardNow: (target) => this.forwardNow(target),
      reserve: (count) => this.reserve(count),
      get forwardCount(): number {
        return forwardCount();
      },
      get channelCount(): number {
        return channelCount();
      },
    };
  }

  /**
   * Opens the local endpoint to the first of `servers` and the SOCKS5 endpoint over `route`,
   * which the transport owns once opened (it releases it when it closes); when opening fails,
   * the route is still the caller's to release.
   */
  static async open(
    route: Route,
    servers: readonly HostPort[],
    description: string,
    options: { readonly timeoutMs: number },
  ): Promise<NodeTransport> {
    const primary = await LocalForwarder.listen(borrowed(route), servers[0], description);
    try {
      const box: { transport?: NodeTransport } = {};
      const socks = await LocalSocksServer.listen(route, {
        handshakeTimeoutMs: options.timeoutMs,
        report: (error) => box.transport?.emitError(error),
      });
      box.transport = new NodeTransport(route, servers, primary, socks, description);
      return box.transport;
    } catch (error) {
      await primary.close();
      throw error;
    }
  }

  get endpointOverride(): { readonly host: string; readonly port: number } {
    return this.primary.endpointOverride;
  }

  /** Channels open right now through every endpoint of the transport. */
  get channelCount(): number {
    let count = this.primary.channelCount + this.socks.channelCount;
    for (const forwarder of this.ready.values()) count += forwarder.channelCount;
    return count;
  }

  /** The first server that accepts a channel passes; otherwise the first failure is thrown. */
  async probe(): Promise<void> {
    let first: unknown;
    for (const server of this.servers.slice(0, PROBED_SERVERS)) {
      let stream: Duplex;
      try {
        stream = await this.route.open(server, 0);
      } catch (error) {
        first ??= error;
        continue;
      }
      stream.destroy();
      return;
    }
    throw asJoineryError(first ?? new JoineryError({ code: 'INTERNAL', message: 'No server' }));
  }

  onError(listener: (error: JoineryError) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Reports a failure to the onError listeners. */
  emitError(error: JoineryError): void {
    if (this.closing) return;
    for (const listener of [...this.listeners]) listener(error);
  }

  close(): Promise<void> {
    this.closing ??= (async () => {
      this.listeners.clear();
      const pending = [...this.forwards.values()];
      this.forwards.clear();
      this.ready.clear();
      const spares = this.spares.splice(0);
      await Promise.allSettled([
        this.primary.close(),
        this.socks.close(),
        ...spares.map((spare) => spare.close()),
        ...pending.map((forwarder) => forwarder.then((f) => f.close())),
        this.refilling,
      ]);
      await this.route.release();
    })();
    return this.closing;
  }

  private forward(target: HostPort): Promise<HostPort> {
    if (this.closing) return Promise.reject(closed());
    const key = keyOf(target);
    let forwarder = this.forwards.get(key);
    if (!forwarder) {
      if (this.forwards.size >= MAX_NODE_FORWARDS) return Promise.reject(tooManyServers());
      forwarder = LocalForwarder.listen(borrowed(this.route), target, this.describe(target)).then(
        (opened) => this.adopt(key, opened),
      );
      this.forwards.set(key, forwarder);
      forwarder.catch(() => this.forwards.delete(key));
    }
    return forwarder.then((f) => f.endpointOverride);
  }

  private forwardNow(target: HostPort): HostPort | undefined {
    if (this.closing) return undefined;
    const key = keyOf(target);
    const open = this.ready.get(key);
    if (open) return open.endpointOverride;
    if (this.forwards.size >= MAX_NODE_FORWARDS && !this.forwards.has(key)) return undefined;
    const spare = this.spares.shift();
    this.refill().catch(() => undefined);
    if (!spare) return undefined;
    spare.assign(target, this.describe(target));
    this.adopt(key, spare);
    this.forwards.set(key, Promise.resolve(spare));
    return spare.endpointOverride;
  }

  private async reserve(count: number): Promise<void> {
    if (this.closing) throw closed();
    this.spareTarget = Math.max(this.spareTarget, Math.min(count, MAX_NODE_FORWARDS));
    await this.refill();
  }

  /** Brings the reserve back to its size, one listener at a time, after any refill under way. */
  private refill(): Promise<void> {
    const run = async (): Promise<void> => {
      while (!this.closing && this.spares.length < this.spareTarget) {
        const spare = await LocalForwarder.listen(borrowed(this.route), undefined, 'reserved');
        if (this.closing) {
          await spare.close();
          return;
        }
        this.spares.push(spare);
      }
    };
    const next = (this.refilling ?? Promise.resolve()).catch(() => undefined).then(run);
    this.refilling = next;
    return next;
  }

  /** Registers a listening forward; one that lost a race to another for its target closes. */
  private adopt(key: string, forwarder: LocalForwarder): LocalForwarder {
    const existing = this.ready.get(key);
    if (existing && existing !== forwarder) {
      void forwarder.close();
      return existing;
    }
    if (this.closing) {
      void forwarder.close();
      throw closed();
    }
    this.ready.set(key, forwarder);
    forwarder.onError((error) => this.emitError(error));
    return forwarder;
  }

  private describe(target: HostPort): string {
    return `${this.description} (${hostLabel(target.host, target.port)})`;
  }
}

function closed(): JoineryError {
  return new JoineryError({
    code: 'CONNECTION_FAILED',
    message: 'The tunnel was closed',
    hint: 'Open the connection again',
  });
}
