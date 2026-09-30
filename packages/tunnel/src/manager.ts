import { createHmac, randomBytes } from 'node:crypto';
import { resolveSrv as dnsResolveSrv } from 'node:dns/promises';
import type { Duplex } from 'node:stream';

import {
  type HostPort,
  type JoineryError,
  type ProxyOptions,
  type ResolvedProfile,
  type SshHop,
} from '@joinery/core';
import type { Client } from 'ssh2';

import { tunnelReach, type TunnelReach } from './endpoint';
import { errorMessage, errorProp, hostLabel, tunnelError } from './errors';
import { NodeTransport } from './nodes';
import { connectThroughProxy, describeProxy } from './proxy';
import { agentSocket, connectHop, defaultKeyFileReader, forwardOut, hopLabel } from './ssh';
import {
  LocalForwarder,
  asJoineryError,
  type Route,
  type Transport,
  type TransportOptions,
} from './transport';

/** One SSH session, shared by every transport whose chain starts with the same hops. */
class SshLink {
  refs = 0;
  client: Client | undefined;
  /** Settles when the session is authenticated (or failed to be). */
  ready: Promise<void> = Promise.resolve();
  private dead = false;
  private closed = false;
  private readonly listeners = new Set<(error: JoineryError) => void>();

  constructor(
    readonly key: string,
    readonly label: string,
    private readonly onDead: (link: SshLink) => void,
  ) {}

  get alive(): boolean {
    return !this.dead && !this.closed && this.client !== undefined;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  onFailure(listener: (error: JoineryError) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** The session failed or dropped: forget it so the next open reconnects, and tell its users. */
  fail(error: JoineryError): void {
    if (this.dead) return;
    this.dead = true;
    this.onDead(this);
    this.client?.destroy();
    if (this.closed) return;
    for (const listener of [...this.listeners]) listener(error);
  }

  close(): void {
    this.closed = true;
    this.listeners.clear();
    this.client?.end();
  }
}

/** Keeps the process-wide SSH sessions; see `TransportManager.open`. */
export class TransportManager {
  private readonly links = new Map<string, SshLink>();
  /** Keys the credential digests in session identities; never leaves this process. */
  private readonly identityKey = randomBytes(32);

  constructor(private readonly defaults: TransportOptions) {}

  /**
   * Opens the transport a profile needs (spec §4): an SSH chain when `profile.ssh` is set (the
   * first hop direct, or through `profile.proxy` when both are set; each next hop through the
   * previous one; the last hop forwarding to the endpoint), a SOCKS5 or HTTP CONNECT proxy when
   * only `profile.proxy` is set, and nothing (undefined) otherwise.
   *
   * A profile that reaches several servers (a MongoDB host list, SRV name or replica set URI,
   * Redis Sentinel or Cluster; see `tunnelReach`) gets a transport with `nodes`, which reaches
   * each server by the name it announces over the same SSH session or proxy. Its SRV record is
   * looked up on this computer first: a name that does not resolve here fails the open.
   *
   * SSH sessions are shared: profiles whose chains start with the same hops (host, port, user
   * and credentials) reuse one session, which closes when its last transport closes. A session
   * that fails is dropped, and the next connection through any of its transports reconnects.
   */
  async open(
    resolved: ResolvedProfile,
    overrides: Partial<TransportOptions> = {},
  ): Promise<Transport | undefined> {
    const { profile } = resolved;
    if (!profile.ssh && !profile.proxy) return undefined;
    const options = { ...this.defaults, ...overrides };
    const timeoutMs = options.connectTimeoutMs ?? profile.options.connectTimeoutMs;
    const reach = tunnelReach(profile);

    let route: Route;
    let via: string;
    if (!profile.ssh) {
      const proxy = profile.proxy!;
      route = {
        open: (target) => connectThroughProxy(proxy, resolved.secrets, target, timeoutMs),
        release: async () => undefined,
      };
      via = describeProxy(proxy);
    } else {
      const ssh = profile.ssh;
      const chain: ChainSpec = {
        hops: ssh.hops,
        proxy: profile.proxy,
        secrets: resolved.secrets,
        keepAliveIntervalMs: ssh.keepAliveIntervalMs,
        timeoutMs,
        options,
      };
      const sshRoute = new SshRoute(this, chain);
      // Connect now, so a bad password or an untrusted host key fails the open, not a later query.
      await sshRoute.links();
      route = sshRoute;
      const proxied = profile.proxy ? `${describeProxy(profile.proxy)} → ` : '';
      via = `SSH ${proxied}${ssh.hops.map(hopLabel).join(' → ')}`;
    }

    let transport: LocalForwarder | NodeTransport;
    try {
      if (reach.kind === 'host') {
        const label = hostLabel(reach.target.host, reach.target.port);
        transport = await LocalForwarder.listen(route, reach.target, `${via} → ${label}`);
      } else {
        const servers = await serversOf(reach, options, timeoutMs);
        transport = await NodeTransport.open(
          route,
          servers,
          `${via} → ${describeServers(reach, servers)}`,
          { timeoutMs },
        );
      }
    } catch (error) {
      await route.release();
      throw error;
    }
    if (route instanceof SshRoute) route.report = (error) => transport.emitError(error);
    return transport;
  }

  /** Live SSH sessions (one per distinct hop path), for diagnostics and tests. */
  get sessionCount(): number {
    return [...this.links.values()].filter((link) => link.alive).length;
  }

  /** Closes every SSH session, e.g. when the process shuts down. */
  closeAll(): void {
    for (const link of this.links.values()) link.close();
    this.links.clear();
  }

  /** Acquires (connecting where needed) the sessions of a chain, first hop first. */
  async acquire(chain: ChainSpec): Promise<SshLink[]> {
    const acquired: SshLink[] = [];
    try {
      let key = this.proxyIdentity(chain);
      let parent: SshLink | undefined;
      for (const hop of chain.hops) {
        key = `${key} > ${this.hopIdentity(hop, chain)}`;
        // A link in the map is connecting or alive: dead and released links are removed.
        let link = this.links.get(key);
        if (!link) {
          link = this.connect(key, hop, parent, chain);
          this.links.set(key, link);
        }
        link.refs += 1;
        acquired.push(link);
        await link.ready;
        if (!link.alive) throw sessionLost(link.label, 'it closed while connecting');
        parent = link;
      }
      return acquired;
    } catch (error) {
      this.release(acquired);
      throw error;
    }
  }

  /** Releases a chain; a session closes when no transport uses it any more. */
  release(links: readonly SshLink[]): void {
    for (const link of [...links].reverse()) {
      link.refs -= 1;
      if (link.refs > 0) continue;
      if (this.links.get(link.key) === link) this.links.delete(link.key);
      link.close();
    }
  }

  private connect(
    key: string,
    hop: SshHop,
    parent: SshLink | undefined,
    chain: ChainSpec,
  ): SshLink {
    const link = new SshLink(key, hopLabel(hop), (dead) => {
      if (this.links.get(dead.key) === dead) this.links.delete(dead.key);
    });
    const hopTarget: HostPort = { host: hop.host, port: hop.port };
    link.ready = (async () => {
      let sock: Duplex | undefined;
      if (parent) {
        if (!parent.client || !parent.alive) throw sessionLost(parent.label, 'it closed');
        sock = await forwardOut(parent.client, 0, hopTarget, chain.timeoutMs, parent.label);
      } else if (chain.proxy) {
        sock = await connectThroughProxy(chain.proxy, chain.secrets, hopTarget, chain.timeoutMs);
      }
      const client = await connectHop({
        hop,
        secrets: chain.secrets,
        ...(sock ? { sock } : {}),
        verifier: chain.options.hostKeyVerifier,
        timeoutMs: chain.timeoutMs,
        keepAliveIntervalMs: chain.keepAliveIntervalMs,
        agent: chain.options.agent,
        readFile: chain.options.readFile ?? defaultKeyFileReader,
      }).catch((error: unknown) => {
        sock?.destroy();
        throw error;
      });
      link.client = client;
      client.on('error', (error) => link.fail(sessionLost(link.label, errorMessage(error))));
      client.on('close', () => link.fail(sessionLost(link.label, 'the connection closed')));
      if (link.isClosed) client.end();
    })();
    link.ready.catch((error: unknown) => link.fail(asJoineryError(error)));
    return link;
  }

  private digest(value: string | undefined): string {
    return createHmac('sha256', this.identityKey)
      .update(value ?? '')
      .digest('base64');
  }

  /** Who a hop logs in as — never the secret itself, only a keyed digest of it. */
  private hopIdentity(hop: SshHop, chain: ChainSpec): string {
    const auth = hop.auth;
    let credential: string;
    switch (auth.method) {
      case 'password':
        credential = `password:${this.digest(chain.secrets[auth.password.id])}`;
        break;
      case 'privateKey':
        credential = `key:${auth.keyPath}:${this.digest(auth.passphrase ? chain.secrets[auth.passphrase.id] : undefined)}`;
        break;
      case 'agent':
        credential = `agent:${agentSocket(chain.options.agent) ?? ''}`;
        break;
    }
    return `${hopLabel(hop)}#${credential}`;
  }

  private proxyIdentity(chain: ChainSpec): string {
    const proxy = chain.proxy;
    if (!proxy) return 'direct';
    const password = proxy.password ? chain.secrets[proxy.password.id] : undefined;
    return `${proxy.kind}://${proxy.user ?? ''}@${hostLabel(proxy.host, proxy.port)}#${this.digest(password)}`;
  }
}

interface ChainSpec {
  readonly hops: readonly SshHop[];
  readonly proxy: ProxyOptions | undefined;
  readonly secrets: Readonly<Record<string, string>>;
  readonly keepAliveIntervalMs: number;
  readonly timeoutMs: number;
  readonly options: TransportOptions;
}

function sessionLost(label: string, reason: string): JoineryError {
  return tunnelError(
    'SSH_FAILED',
    `The SSH connection to ${label} was lost: ${reason}`,
    'The SSH server or the network dropped the connection; Joinery reconnects on the next connection attempt',
    undefined,
    'SSH_DISCONNECTED',
  );
}

/**
 * A transport's route over a shared SSH chain: each stream is a direct-tcpip channel from the
 * last hop, so the SSH server resolves the target's name. Reconnects when the chain has dropped.
 */
class SshRoute implements Route {
  private current: SshLink[] | undefined;
  private acquiring: Promise<SshLink[]> | undefined;
  private unsubscribe: (() => void)[] = [];
  private released = false;
  /** Where session failures go: the transport's onError listeners. */
  report: (error: JoineryError) => void = () => undefined;

  constructor(
    private readonly manager: TransportManager,
    private readonly chain: ChainSpec,
  ) {}

  /** The chain's sessions, reacquiring them when one has dropped. */
  links(): Promise<SshLink[]> {
    if (this.current?.every((link) => link.alive)) return Promise.resolve(this.current);
    this.acquiring ??= this.reacquire().finally(() => {
      this.acquiring = undefined;
    });
    return this.acquiring;
  }

  async open(target: HostPort, srcPort: number): Promise<Duplex> {
    for (let attempt = 1; ; attempt++) {
      const links = await this.links();
      const last = links.at(-1)!;
      try {
        return await forwardOut(last.client!, srcPort, target, this.chain.timeoutMs, last.label);
      } catch (error) {
        // The session dropped between checking and forwarding: reconnect once.
        if (attempt === 1 && !last.alive && !this.released) continue;
        throw error;
      }
    }
  }

  async release(): Promise<void> {
    if (this.released) return;
    this.released = true;
    await this.acquiring?.catch(() => undefined);
    this.drop();
  }

  private async reacquire(): Promise<SshLink[]> {
    // Acquire the new chain before releasing the old one, so its live hops are reused.
    const stale = this.detach();
    try {
      const links = await this.manager.acquire(this.chain);
      if (this.released) {
        this.manager.release(links);
        throw tunnelError('SSH_FAILED', 'The tunnel was closed', 'Open the connection again');
      }
      this.current = links;
      // When a hop drops, the hops behind it drop too: report the first failure only.
      let reported = false;
      this.unsubscribe = links.map((link) =>
        link.onFailure((error) => {
          if (reported) return;
          reported = true;
          this.report(error);
        }),
      );
      return links;
    } finally {
      if (stale) this.manager.release(stale);
    }
  }

  private detach(): SshLink[] | undefined {
    for (const unsubscribe of this.unsubscribe) unsubscribe();
    this.unsubscribe = [];
    const current = this.current;
    this.current = undefined;
    return current;
  }

  private drop(): void {
    const current = this.detach();
    if (current) this.manager.release(current);
  }
}

/** The servers a `nodes` reach starts from: its seeds, or its SRV record looked up here. */
async function serversOf(
  reach: Extract<TunnelReach, { kind: 'nodes' }>,
  options: TransportOptions,
  timeoutMs: number,
): Promise<readonly HostPort[]> {
  if (reach.srvRecord === undefined) return reach.seeds;
  const lookup = options.resolveSrv ?? defaultResolveSrv;
  let servers: HostPort[];
  try {
    servers = await withTimeout(lookup(reach.srvRecord), timeoutMs);
  } catch (error) {
    const code = errorProp(error, 'code');
    throw tunnelError(
      'CONNECTION_FAILED',
      `The SRV record ${reach.srvRecord} could not be looked up on this computer${code ? ` (${code})` : ''}`,
      'SRV and TXT records are looked up here, not through the SSH tunnel or proxy: make the name resolvable on this computer, or connect with a host list of the members as the SSH server sees them',
      error,
      'SRV_NOT_RESOLVED',
    );
  }
  if (servers.length === 0) {
    throw tunnelError(
      'CONNECTION_FAILED',
      `The SRV record ${reach.srvRecord} lists no servers`,
      'Check the cluster host name, or connect with a host list',
      undefined,
      'SRV_NOT_RESOLVED',
    );
  }
  return servers;
}

async function defaultResolveSrv(record: string): Promise<HostPort[]> {
  const records = await dnsResolveSrv(record);
  return records.map((r) => ({ host: r.name, port: r.port }));
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(Object.assign(new Error('The DNS lookup timed out'), { code: 'ETIMEOUT' })),
      timeoutMs,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** "a:27017, b:27017, every server through the tunnel", or the SRV record and what it lists. */
function describeServers(
  reach: Extract<TunnelReach, { kind: 'nodes' }>,
  servers: readonly HostPort[],
): string {
  const list = servers.map((s) => hostLabel(s.host, s.port)).join(', ');
  const named = reach.srvRecord === undefined ? list : `${reach.srvRecord} (${list})`;
  return `${named}, every server through the tunnel`;
}

/**
 * Opens a profile's transport with its own manager (no session sharing); see
 * `TransportManager.open`. Pass `manager` to share SSH sessions with other transports.
 */
export function openTransport(
  resolved: ResolvedProfile,
  options: TransportOptions & { readonly manager?: TransportManager },
): Promise<Transport | undefined> {
  const { manager, ...rest } = options;
  return (manager ?? new TransportManager(rest)).open(resolved, manager ? rest : {});
}
