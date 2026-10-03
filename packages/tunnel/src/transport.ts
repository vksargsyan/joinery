import { createServer, type Server, type Socket } from 'node:net';
import type { Duplex } from 'node:stream';

import { QuerybaraError, toErrorData, type HostPort, type ResolvedProfile } from '@querybara/core';

import type { HostKeyVerifier } from './host-keys';
import type { KeyFileReader } from './ssh';

/**
 * A local endpoint for one profile's SSH tunnel or proxy. The driver connects to
 * `endpointOverride` (set it on the ResolvedProfile, see `tunnelledProfile`) and every accepted
 * socket gets its own forwarded channel to the database endpoint. TLS still verifies the
 * profile's host name, since the drivers keep it as the TLS name.
 *
 * A profile that reaches several servers (a MongoDB replica set, Redis Sentinel or Cluster; see
 * `tunnelReach`) also gets `nodes`, which reaches every server through the same route.
 */
export interface Transport {
  /**
   * 127.0.0.1 and the OS-assigned port the transport listens on, forwarding to the profile's
   * server (for several servers, the first one the profile names or its SRV record lists).
   */
  readonly endpointOverride: { readonly host: string; readonly port: number };
  /** The route, for status lines: "SSH me@bastion:22 → db.internal:5432". Holds no secrets. */
  readonly description: string;
  /**
   * Opens one forwarded channel to the endpoint and closes it again: proves the whole path. With
   * several servers, the first that accepts the channel passes.
   */
  probe(): Promise<void>;
  /**
   * Reports failures the driver cannot explain: the SSH session dropped (the transport reconnects
   * on the next connection), or a forward was refused. Returns an unsubscribe function.
   */
  onError(listener: (error: QuerybaraError) => void): () => void;
  /** Closes the listener and every forwarded channel, and releases the shared SSH sessions. */
  close(): Promise<void>;
  /** Present when the profile reaches several servers: a route to each of them. */
  readonly nodes?: NodeRoute;
}

/**
 * A loopback SOCKS5 endpoint (RFC 1928, CONNECT only) that opens each connection through a
 * transport's route, with the destination name resolved on the far side. It requires the user
 * name and password (RFC 1929), random per route, so other local processes cannot use the
 * tunnel through it.
 */
export interface SocksEndpoint {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly password: string;
}

/**
 * How a driver reaches every server of a topology through one transport (one SSH session, or
 * the configured proxy): a SOCKS5 endpoint for drivers that speak SOCKS (the MongoDB driver
 * sends every connection it opens through it), and loopback forwards per server for those that
 * only take a host and port (ioredis, through its NAT map). Forwards stay open until the
 * transport closes; at most `MAX_NODE_FORWARDS` per transport.
 */
export interface NodeRoute {
  readonly socks5: SocksEndpoint;
  /**
   * The loopback forward to `target` (as the far side names it), opened on first use and then
   * reused. Rejects past the forward limit.
   */
  forward(target: HostPort): Promise<HostPort>;
  /**
   * `forward` for callers that cannot wait (a NAT map): the open forward to `target`, or a
   * reserved listener assigned to it on the spot; undefined when none is left. See `reserve`.
   */
  forwardNow(target: HostPort): HostPort | undefined;
  /**
   * Keeps `count` listeners bound in advance, so `forwardNow` can hand one out synchronously;
   * the reserve refills in the background as it is used.
   */
  reserve(count: number): Promise<void>;
  /** Forwards assigned to a server so far. */
  readonly forwardCount: number;
  /** Channels open right now through the route (SOCKS connections and forwarded sockets). */
  readonly channelCount: number;
}

/** How transports connect. The verifier is required: unknown host keys are never accepted silently. */
export interface TransportOptions {
  readonly hostKeyVerifier: HostKeyVerifier;
  /**
   * Budget for each SSH handshake (excluding time spent in the verifier), proxy handshake and
   * channel open. Defaults to the profile's connect timeout.
   */
  readonly connectTimeoutMs?: number;
  /** The ssh-agent socket, or `pageant`; defaults to SSH_AUTH_SOCK, then Pageant on Windows. */
  readonly agent?: string;
  /** Reads private key files (with `~` expanded); injectable for tests. */
  readonly readFile?: KeyFileReader;
  /** Looks up an SRV record on this computer (mongodb+srv); injectable for tests. */
  readonly resolveSrv?: (record: string) => Promise<HostPort[]>;
}

/** How a transport reaches its servers; implemented for SSH chains and for plain proxies. */
export interface Route {
  /**
   * Opens one stream to `target`, named as the far side resolves it; `srcPort` is the local
   * client's port (0 for a probe).
   */
  open(target: HostPort, srcPort: number): Promise<Duplex>;
  /** Called once when the transport closes. */
  release(): Promise<void>;
}

/** Converts anything thrown into a QuerybaraError, keeping QuerybaraErrors as they are. */
export function asQuerybaraError(error: unknown): QuerybaraError {
  return error instanceof QuerybaraError ? error : new QuerybaraError(toErrorData(error));
}

/** A ResolvedProfile opened through a transport whose profile reaches several servers. */
export interface RoutedProfile extends ResolvedProfile {
  /** Reaches every server of the topology through the transport (see `NodeRoute`). */
  readonly nodeRoute?: NodeRoute;
}

/**
 * The ResolvedProfile a driver connects with through `transport`: the endpoint override set and
 * the proxy removed, since the transport already goes through it (the SQL drivers refuse a
 * profile that still names one). TLS keeps verifying the profile's own host name. A transport
 * with `nodes` also passes them on as `nodeRoute` (read them with `nodeRouteOf`).
 */
export function tunnelledProfile(
  resolved: ResolvedProfile,
  transport: Pick<Transport, 'endpointOverride' | 'nodes'>,
): RoutedProfile {
  const { proxy: _proxy, ...profile } = resolved.profile;
  const { nodeRoute: _previous, ...rest } = resolved as RoutedProfile;
  return {
    ...rest,
    profile,
    endpointOverride: transport.endpointOverride,
    ...(transport.nodes ? { nodeRoute: transport.nodes } : {}),
  };
}

/** The node route a profile was opened with (see `tunnelledProfile`), if any. */
export function nodeRouteOf(resolved: ResolvedProfile): NodeRoute | undefined {
  return (resolved as RoutedProfile).nodeRoute;
}

/** Pipes a local socket and a forwarded stream together until either side closes. */
export function splice(local: Socket, remote: Duplex, onClosed: () => void): void {
  let open = 2;
  const closed = (): void => {
    open -= 1;
    if (open === 0) onClosed();
  };
  local.pipe(remote);
  remote.pipe(local);
  // The remote end finished: let the local side drain what is buffered, then end it.
  remote.once('close', () => {
    local.end();
    closed();
  });
  local.once('close', () => {
    remote.destroy();
    // An SSH channel only reports 'close' after its readable side ended: drain what is left.
    remote.resume();
    closed();
  });
  remote.on('error', () => local.destroy());
  local.on('error', () => remote.destroy());
}

/** Starts a server on 127.0.0.1 with an OS-assigned port. */
export async function listenOnLoopback(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    server.close();
    throw new QuerybaraError({ code: 'INTERNAL', message: 'The tunnel listener has no port' });
  }
  return address.port;
}

/**
 * A listener on 127.0.0.1 that forwards every accepted socket over its route to one target. A
 * forwarder listened without a target (a reserved one) refuses connections until `assign`.
 */
export class LocalForwarder implements Transport {
  private readonly sockets = new Set<Socket>();
  private readonly streams = new Set<Duplex>();
  private readonly listeners = new Set<(error: QuerybaraError) => void>();
  private closing: Promise<void> | undefined;

  private constructor(
    private readonly server: Server,
    private readonly route: Route,
    private target: HostPort | undefined,
    public description: string,
    readonly endpointOverride: { readonly host: string; readonly port: number },
  ) {
    server.on('connection', (socket) => this.accept(socket));
  }

  /** Starts listening on 127.0.0.1 with an OS-assigned port. */
  static async listen(
    route: Route,
    target: HostPort | undefined,
    description: string,
  ): Promise<LocalForwarder> {
    const server = createServer({ pauseOnConnect: true });
    const port = await listenOnLoopback(server);
    return new LocalForwarder(server, route, target, description, { host: '127.0.0.1', port });
  }

  /** Points a reserved forwarder at its target. */
  assign(target: HostPort, description: string): void {
    this.target = target;
    this.description = description;
  }

  /** Forwarded channels open right now. */
  get channelCount(): number {
    return this.streams.size;
  }

  async probe(): Promise<void> {
    if (!this.target) throw notAssigned();
    const stream = await this.route.open(this.target, 0);
    stream.destroy();
  }

  onError(listener: (error: QuerybaraError) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Reports a failure to the onError listeners. */
  emitError(error: QuerybaraError): void {
    for (const listener of [...this.listeners]) listener(error);
  }

  close(): Promise<void> {
    this.closing ??= (async () => {
      const stopped = new Promise<void>((resolve) => this.server.close(() => resolve()));
      for (const socket of this.sockets) socket.destroy();
      for (const stream of this.streams) stream.destroy();
      this.streams.clear();
      this.listeners.clear();
      await this.route.release();
      await stopped;
    })();
    return this.closing;
  }

  private accept(socket: Socket): void {
    const target = this.target;
    if (this.closing || !target) {
      socket.destroy();
      return;
    }
    this.sockets.add(socket);
    socket.setNoDelay(true);
    socket.on('error', () => socket.destroy());
    socket.once('close', () => this.sockets.delete(socket));
    this.route.open(target, socket.remotePort ?? 0).then(
      (stream) => {
        if (this.closing || socket.destroyed) {
          stream.destroy();
          return;
        }
        this.streams.add(stream);
        splice(socket, stream, () => this.streams.delete(stream));
      },
      (error: unknown) => {
        socket.destroy();
        if (!this.closing) this.emitError(asQuerybaraError(error));
      },
    );
  }
}

function notAssigned(): QuerybaraError {
  return new QuerybaraError({ code: 'INTERNAL', message: 'The forward has no target yet' });
}
