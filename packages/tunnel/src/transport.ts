import { createServer, type Server, type Socket } from 'node:net';
import type { Duplex } from 'node:stream';

import { JoineryError, toErrorData, type ResolvedProfile } from '@joinery/core';

import type { HostKeyVerifier } from './host-keys';
import type { KeyFileReader } from './ssh';

/**
 * A local endpoint for one profile's SSH tunnel or proxy. The driver connects to
 * `endpointOverride` (set it on the ResolvedProfile, see `tunnelledProfile`) and every accepted
 * socket gets its own forwarded channel to the database endpoint. TLS still verifies the
 * profile's host name, since the drivers keep it as the TLS name.
 */
export interface Transport {
  /** 127.0.0.1 and the OS-assigned port the transport listens on. */
  readonly endpointOverride: { readonly host: string; readonly port: number };
  /** The route, for status lines: "SSH me@bastion:22 → db.internal:5432". Holds no secrets. */
  readonly description: string;
  /** Opens one forwarded channel to the endpoint and closes it again: proves the whole path. */
  probe(): Promise<void>;
  /**
   * Reports failures the driver cannot explain: the SSH session dropped (the transport reconnects
   * on the next connection), or a forward was refused. Returns an unsubscribe function.
   */
  onError(listener: (error: JoineryError) => void): () => void;
  /** Closes the listener and every forwarded channel, and releases the shared SSH sessions. */
  close(): Promise<void>;
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
}

/** How a transport reaches the endpoint; implemented for SSH chains and for plain proxies. */
export interface Route {
  /** Opens one stream to the endpoint; `srcPort` is the local client's port (0 for a probe). */
  open(srcPort: number): Promise<Duplex>;
  /** Called once when the transport closes. */
  release(): Promise<void>;
}

/** Converts anything thrown into a JoineryError, keeping JoineryErrors as they are. */
export function asJoineryError(error: unknown): JoineryError {
  return error instanceof JoineryError ? error : new JoineryError(toErrorData(error));
}

/**
 * The ResolvedProfile a driver connects with through `transport`: the endpoint override set and
 * the proxy removed, since the transport already goes through it (the SQL drivers refuse a
 * profile that still names one). TLS keeps verifying the profile's own host name.
 */
export function tunnelledProfile(resolved: ResolvedProfile, transport: Transport): ResolvedProfile {
  const { proxy: _proxy, ...profile } = resolved.profile;
  return { ...resolved, profile, endpointOverride: transport.endpointOverride };
}

/** Pipes a local socket and a forwarded stream together until either side closes. */
function splice(local: Socket, remote: Duplex, onClosed: () => void): void {
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
    closed();
  });
  remote.on('error', () => local.destroy());
  local.on('error', () => remote.destroy());
}

/** A transport listening on 127.0.0.1 that forwards every accepted socket over its route. */
export class LocalForwarder implements Transport {
  private readonly sockets = new Set<Socket>();
  private readonly streams = new Set<Duplex>();
  private readonly listeners = new Set<(error: JoineryError) => void>();
  private closing: Promise<void> | undefined;

  private constructor(
    private readonly server: Server,
    private readonly route: Route,
    readonly description: string,
    readonly endpointOverride: { readonly host: string; readonly port: number },
  ) {
    server.on('connection', (socket) => this.accept(socket));
  }

  /** Starts listening on 127.0.0.1 with an OS-assigned port. */
  static async listen(route: Route, description: string): Promise<LocalForwarder> {
    const server = createServer({ pauseOnConnect: true });
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
      throw new JoineryError({ code: 'INTERNAL', message: 'The tunnel listener has no port' });
    }
    return new LocalForwarder(server, route, description, {
      host: '127.0.0.1',
      port: address.port,
    });
  }

  async probe(): Promise<void> {
    const stream = await this.route.open(0);
    stream.destroy();
  }

  onError(listener: (error: JoineryError) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Reports a failure to the onError listeners. */
  emitError(error: JoineryError): void {
    for (const listener of [...this.listeners]) listener(error);
  }

  close(): Promise<void> {
    this.closing ??= (async () => {
      const stopped = new Promise<void>((resolve) => this.server.close(() => resolve()));
      for (const socket of this.sockets) socket.destroy();
      for (const stream of this.streams) stream.destroy();
      this.listeners.clear();
      await this.route.release();
      await stopped;
    })();
    return this.closing;
  }

  private accept(socket: Socket): void {
    if (this.closing) {
      socket.destroy();
      return;
    }
    this.sockets.add(socket);
    socket.setNoDelay(true);
    socket.on('error', () => socket.destroy());
    socket.once('close', () => this.sockets.delete(socket));
    this.route.open(socket.remotePort ?? 0).then(
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
        if (!this.closing) this.emitError(asJoineryError(error));
      },
    );
  }
}
