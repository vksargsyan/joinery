import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type Server, type Socket } from 'node:net';
import type { Duplex } from 'node:stream';

import type { HostPort, QuerybaraError } from '@querybara/core';

import {
  asQuerybaraError,
  listenOnLoopback,
  splice,
  type Route,
  type SocksEndpoint,
} from './transport';

/**
 * The loopback SOCKS5 server behind `NodeRoute.socks5` (RFC 1928 and RFC 1929): CONNECT only,
 * user name and password required, every accepted request opened through the transport's route
 * with the destination name passed on unresolved, so the SSH server (or the proxy) resolves it.
 */

/** Concurrent channels one SOCKS endpoint carries; more are refused (general failure). */
export const MAX_SOCKS_CHANNELS = 512;

const VERSION = 5;
const AUTH_VERSION = 1;
const METHOD_USER_PASSWORD = 0x02;
const METHOD_NONE_ACCEPTABLE = 0xff;
const CMD_CONNECT = 1;
const ATYP_IPV4 = 1;
const ATYP_DOMAIN = 3;
const ATYP_IPV6 = 4;

/** RFC 1928 §6 reply codes. */
const REPLY = {
  succeeded: 0,
  generalFailure: 1,
  notAllowed: 2,
  hostUnreachable: 4,
  connectionRefused: 5,
  ttlExpired: 6,
  commandNotSupported: 7,
  addressTypeNotSupported: 8,
} as const;

class SocksProtocolError extends Error {}

/** Reads exact byte counts from a paused socket during the handshake. */
class HandshakeReader {
  private buffered = Buffer.alloc(0);
  private waiting: { length: number; resolve(value: Buffer): void; reject(e: Error): void } | null =
    null;
  private ended: Error | null = null;

  constructor(private readonly socket: Socket) {
    socket.on('data', this.onData);
    socket.once('close', this.onEnd);
    socket.once('end', this.onEnd);
    socket.resume();
  }

  read(length: number): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      this.waiting = { length, resolve, reject };
      this.flush();
    });
  }

  /** Stops reading and hands back whatever arrived after the handshake. */
  detach(): Buffer {
    this.socket.pause();
    this.socket.off('data', this.onData);
    this.socket.off('close', this.onEnd);
    this.socket.off('end', this.onEnd);
    const rest = this.buffered;
    this.buffered = Buffer.alloc(0);
    return rest;
  }

  private readonly onData = (chunk: Buffer): void => {
    this.buffered = Buffer.concat([this.buffered, chunk]);
    if (this.buffered.length > 1024) {
      this.ended = new SocksProtocolError('oversized handshake');
    }
    this.flush();
  };

  private readonly onEnd = (): void => {
    this.ended ??= new SocksProtocolError('the client closed the connection');
    this.flush();
  };

  private flush(): void {
    const waiting = this.waiting;
    if (!waiting) return;
    if (this.buffered.length >= waiting.length) {
      this.waiting = null;
      const out = this.buffered.subarray(0, waiting.length);
      this.buffered = this.buffered.subarray(waiting.length);
      waiting.resolve(out);
    } else if (this.ended) {
      this.waiting = null;
      waiting.reject(this.ended);
    }
  }
}

/** Digest used to compare credentials in constant time whatever their lengths. */
function digest(value: Buffer): Buffer {
  return createHash('sha256').update(value).digest();
}

/** The SOCKS5 reply code for a failure to open the destination. */
function replyCodeFor(error: QuerybaraError): number {
  switch (error.engineCode) {
    case 'FORWARD_PROHIBITED':
    case 'PROXY_REFUSED':
      return REPLY.notAllowed;
    case 'FORWARD_CONNECT_FAILED':
      return REPLY.connectionRefused;
    case 'ETIMEDOUT':
      return REPLY.ttlExpired;
    default:
      return error.code === 'CONNECTION_FAILED' ? REPLY.hostUnreachable : REPLY.generalFailure;
  }
}

function reply(code: number): Buffer {
  // BND.ADDR 0.0.0.0:0: the bound address means nothing to a client of this endpoint.
  return Buffer.from([VERSION, code, 0, ATYP_IPV4, 0, 0, 0, 0, 0, 0]);
}

/** A loopback SOCKS5 endpoint over a route; see the module comment. */
export class LocalSocksServer {
  private readonly sockets = new Set<Socket>();
  private readonly streams = new Set<Duplex>();
  /** Channels being opened, counted against the limit with the open ones. */
  private opening = 0;
  private readonly userDigest: Buffer;
  private readonly passwordDigest: Buffer;
  private closing: Promise<void> | undefined;

  private constructor(
    private readonly server: Server,
    private readonly route: Route,
    readonly endpoint: SocksEndpoint,
    private readonly handshakeTimeoutMs: number,
    private readonly report: (error: QuerybaraError) => void,
  ) {
    this.userDigest = digest(Buffer.from(endpoint.user));
    this.passwordDigest = digest(Buffer.from(endpoint.password));
    server.on('connection', (socket) => this.accept(socket));
  }

  /**
   * Listens on 127.0.0.1 with an OS-assigned port and fresh random credentials. `report` gets the
   * route's failures (a refused forward, a dropped SSH session), as a transport's onError does.
   */
  static async listen(
    route: Route,
    options: { handshakeTimeoutMs: number; report: (error: QuerybaraError) => void },
  ): Promise<LocalSocksServer> {
    const server = createServer({ pauseOnConnect: true });
    const port = await listenOnLoopback(server);
    const endpoint: SocksEndpoint = {
      host: '127.0.0.1',
      port,
      user: `querybara-${randomBytes(6).toString('hex')}`,
      password: randomBytes(24).toString('base64url'),
    };
    return new LocalSocksServer(
      server,
      route,
      endpoint,
      options.handshakeTimeoutMs,
      options.report,
    );
  }

  /** Channels open right now. */
  get channelCount(): number {
    return this.streams.size;
  }

  /** Stops listening and closes every channel; the route is its owner's to release. */
  close(): Promise<void> {
    this.closing ??= (async () => {
      const stopped = new Promise<void>((resolve) => this.server.close(() => resolve()));
      for (const socket of this.sockets) socket.destroy();
      for (const stream of this.streams) stream.destroy();
      this.streams.clear();
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
    // A client that stalls the handshake, or lingers after a refusal, is cut off.
    const timer = setTimeout(() => socket.destroy(), this.handshakeTimeoutMs);
    socket.once('close', () => {
      clearTimeout(timer);
      this.sockets.delete(socket);
    });
    this.handshake(socket).then(
      (request) => {
        if (!request) return;
        clearTimeout(timer);
        this.connect(socket, request.target, request.rest);
      },
      () => socket.destroy(),
    );
  }

  /** Sends a refusal and lets the client close (the handshake timer closes it otherwise). */
  private refuse(socket: Socket, reader: HandshakeReader | undefined, message: Buffer): undefined {
    reader?.detach();
    socket.on('data', () => undefined);
    socket.resume();
    socket.end(message);
    return undefined;
  }

  /** Negotiates auth and reads the request; undefined when a reply already refused it. */
  private async handshake(socket: Socket): Promise<{ target: HostPort; rest: Buffer } | undefined> {
    const reader = new HandshakeReader(socket);
    const [version, methodCount] = await reader.read(2);
    if (version !== VERSION) throw new SocksProtocolError('not SOCKS5');
    const methods = await reader.read(methodCount!);
    if (!methods.includes(METHOD_USER_PASSWORD)) {
      return this.refuse(socket, reader, Buffer.from([VERSION, METHOD_NONE_ACCEPTABLE]));
    }
    socket.write(Buffer.from([VERSION, METHOD_USER_PASSWORD]));

    const [authVersion, userLength] = await reader.read(2);
    if (authVersion !== AUTH_VERSION) throw new SocksProtocolError('bad auth version');
    const user = await reader.read(userLength!);
    const [passwordLength] = await reader.read(1);
    const password = await reader.read(passwordLength!);
    // Both compared, in constant time, before deciding.
    const userOk = timingSafeEqual(digest(user), this.userDigest);
    const passwordOk = timingSafeEqual(digest(password), this.passwordDigest);
    if (!userOk || !passwordOk) {
      return this.refuse(socket, reader, Buffer.from([AUTH_VERSION, 1]));
    }
    socket.write(Buffer.from([AUTH_VERSION, 0]));

    const [requestVersion, command, , addressType] = await reader.read(4);
    if (requestVersion !== VERSION) throw new SocksProtocolError('bad request version');
    let host: string;
    if (addressType === ATYP_IPV4) {
      host = [...(await reader.read(4))].join('.');
    } else if (addressType === ATYP_DOMAIN) {
      const [length] = await reader.read(1);
      host = (await reader.read(length!)).toString('utf8');
    } else if (addressType === ATYP_IPV6) {
      const bytes = await reader.read(16);
      const groups: string[] = [];
      for (let i = 0; i < 16; i += 2) groups.push(bytes.readUInt16BE(i).toString(16));
      host = groups.join(':');
    } else {
      return this.refuse(socket, reader, reply(REPLY.addressTypeNotSupported));
    }
    const port = (await reader.read(2)).readUInt16BE(0);
    if (command !== CMD_CONNECT) {
      return this.refuse(socket, reader, reply(REPLY.commandNotSupported));
    }
    if (host === '' || port === 0) return this.refuse(socket, reader, reply(REPLY.notAllowed));
    if (this.streams.size + this.opening >= MAX_SOCKS_CHANNELS) {
      return this.refuse(socket, reader, reply(REPLY.generalFailure));
    }
    return { target: { host, port }, rest: reader.detach() };
  }

  private connect(socket: Socket, target: HostPort, rest: Buffer): void {
    this.opening += 1;
    const opened = this.route.open(target, socket.remotePort ?? 0).finally(() => {
      this.opening -= 1;
    });
    opened.then(
      (stream) => {
        if (this.closing || socket.destroyed) {
          stream.destroy();
          return;
        }
        this.streams.add(stream);
        socket.write(reply(REPLY.succeeded));
        if (rest.length > 0) stream.write(rest);
        splice(socket, stream, () => this.streams.delete(stream));
        socket.resume();
      },
      (error: unknown) => {
        const failure = asQuerybaraError(error);
        if (!socket.destroyed) {
          this.refuse(socket, undefined, reply(replyCodeFor(failure)));
          const timer = setTimeout(() => socket.destroy(), this.handshakeTimeoutMs);
          socket.once('close', () => clearTimeout(timer));
        }
        if (!this.closing) this.report(failure);
      },
    );
  }
}
