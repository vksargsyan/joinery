import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import {
  connect as netConnect,
  createServer as createNetServer,
  type AddressInfo,
  type Server as NetServer,
  type Socket,
} from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import ssh2 from 'ssh2';
import type { Connection, ParsedKey } from 'ssh2';

import { fingerprintOf } from '../../src';

/** Closes a Node server and waits for it; resolves even when it was not listening. */
function closeServer(server: NetServer | HttpServer): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

function portOf(server: NetServer | HttpServer): number {
  return (server.address() as AddressInfo).port;
}

async function listen<S extends NetServer | HttpServer>(server: S): Promise<S> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  return server;
}

/** Tracks the sockets of a server so `close` can end them. */
function tracked(server: NetServer | HttpServer): Set<Socket> {
  const sockets = new Set<Socket>();
  server.on('connection', (socket: Socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  return sockets;
}

export interface TcpServer {
  readonly port: number;
  /** Sockets currently open on the server side. */
  readonly open: Set<Socket>;
  close(): Promise<void>;
}

/** A TCP echo server. */
export async function startEchoServer(): Promise<TcpServer> {
  const server = createNetServer((socket) => {
    socket.on('error', () => undefined);
    socket.pipe(socket);
  });
  const open = tracked(server);
  await listen(server);
  return {
    port: portOf(server),
    open,
    close: async () => {
      for (const socket of open) socket.destroy();
      await closeServer(server);
    },
  };
}

/** A TCP server that writes 64 KiB chunks for as long as the client reads. */
export async function startFloodServer(): Promise<TcpServer> {
  const chunk = Buffer.alloc(64 * 1024, 'x');
  const server = createNetServer((socket) => {
    socket.on('error', () => undefined);
    const pump = (): void => {
      while (!socket.destroyed && socket.write(chunk));
    };
    socket.on('drain', pump);
    pump();
  });
  const open = tracked(server);
  await listen(server);
  return {
    port: portOf(server),
    open,
    close: async () => {
      for (const socket of open) socket.destroy();
      await closeServer(server);
    },
  };
}

/** A TCP server that accepts connections and never says anything. */
export async function startSilentServer(): Promise<TcpServer> {
  const server = createNetServer((socket) => socket.on('error', () => undefined));
  const open = tracked(server);
  await listen(server);
  return {
    port: portOf(server),
    open,
    close: async () => {
      for (const socket of open) socket.destroy();
      await closeServer(server);
    },
  };
}

/** A port nothing listens on. */
export async function closedPort(): Promise<number> {
  const server = await listen(createNetServer());
  const port = portOf(server);
  await closeServer(server);
  return port;
}

export interface SshUser {
  readonly password?: string;
  /** Public keys (any ssh2-parseable form) allowed to log in. */
  readonly publicKeys?: readonly (string | Buffer)[];
}

export interface SshServerOptions {
  readonly users: Readonly<Record<string, SshUser>>;
  /** `prohibit` behaves like `AllowTcpForwarding no`; a function filters destinations. */
  readonly forwarding?: 'allow' | 'prohibit' | ((host: string, port: number) => boolean);
  /** The host key (OpenSSH private key text); a fresh Ed25519 key by default. */
  readonly hostKey?: string;
  /** Names only this server resolves (like a private DNS zone behind a bastion), to addresses. */
  readonly hosts?: Readonly<Record<string, string>>;
}

export interface TestSshServer {
  readonly port: number;
  readonly hostKeyFingerprint: string;
  readonly hostKeyAlgorithm: string;
  /** TCP connections accepted so far. */
  readonly stats: {
    connections: number;
    active: number;
    authenticated: number;
    keepalives: number;
    /** Every direct-tcpip request, as the client named its destination. */
    forwards: { host: string; port: number }[];
    /**
     * The local ports of the server's own connections to forwarded destinations: a database
     * that reports a client from one of these ports was reached through this server.
     */
    upstreamPorts: Set<number>;
  };
  /** Forwarded channels open right now. */
  readonly openChannels: number;
  /** Drops every client connection (simulates a network failure or a server restart). */
  dropAll(): void;
  close(): Promise<void>;
}

/**
 * An Ed25519 key pair as OpenSSH texts, from ssh2's generator. About one key in 256 has a public
 * key starting with a zero byte, which ssh2's generator encodes wrongly; those are skipped.
 */
export function ed25519Pair(options: { passphrase?: string; comment?: string } = {}): {
  private: string;
  public: string;
} {
  for (;;) {
    const pair = ssh2.utils.generateKeyPairSync('ed25519', {
      ...(options.comment ? { comment: options.comment } : {}),
      ...(options.passphrase
        ? { passphrase: options.passphrase, cipher: 'aes256-ctr', rounds: 2 }
        : {}),
    });
    if (!(ssh2.utils.parseKey(pair.private, options.passphrase) instanceof Error)) return pair;
  }
}

function parse(key: string | Buffer): ParsedKey {
  const parsed = ssh2.utils.parseKey(key);
  if (parsed instanceof Error) throw parsed;
  return parsed;
}

/**
 * An in-process SSH server (ssh2's Server) with password, public key and keyboard-interactive
 * auth, and direct-tcpip forwarding to real TCP destinations.
 */
export async function startSshServer(options: SshServerOptions): Promise<TestSshServer> {
  const hostKey = options.hostKey ?? ed25519Pair().private;
  const parsedHostKey = parse(hostKey);
  const stats: TestSshServer['stats'] = {
    connections: 0,
    active: 0,
    authenticated: 0,
    keepalives: 0,
    forwards: [],
    upstreamPorts: new Set(),
  };
  const clients = new Set<Connection>();
  const upstreams = new Set<Socket>();
  const server = new ssh2.Server(
    {
      hostKeys: [hostKey],
      debug: (message: string) => {
        if (message.includes('GLOBAL_REQUEST (keepalive@openssh.com)')) stats.keepalives += 1;
      },
    },
    (client) => {
      stats.connections += 1;
      stats.active += 1;
      clients.add(client);
      client.on('close', () => {
        stats.active -= 1;
        clients.delete(client);
      });
      client.on('error', () => undefined);
      client.on('authentication', (ctx) => {
        const user = options.users[ctx.username];
        if (!user) return ctx.reject();
        switch (ctx.method) {
          case 'password':
            return user.password !== undefined && ctx.password === user.password
              ? ctx.accept()
              : ctx.reject();
          case 'keyboard-interactive':
            if (user.password === undefined) return ctx.reject();
            return ctx.prompt([{ prompt: 'Password: ', echo: false }], (answers) =>
              answers[0] === user.password ? ctx.accept() : ctx.reject(),
            );
          case 'publickey': {
            const allowed = (user.publicKeys ?? [])
              .map(parse)
              .find((key) => key.getPublicSSH().equals(ctx.key.data));
            if (!allowed) return ctx.reject();
            if (!ctx.signature) return ctx.accept();
            return allowed.verify(ctx.blob!, ctx.signature, ctx.hashAlgo)
              ? ctx.accept()
              : ctx.reject();
          }
          default:
            return ctx.reject(['password', 'publickey', 'keyboard-interactive']);
        }
      });
      client.on('ready', () => {
        stats.authenticated += 1;
        const forwarding = options.forwarding ?? 'allow';
        if (forwarding === 'prohibit') return;
        client.on('tcpip', (accept, reject, info) => {
          stats.forwards.push({ host: info.destIP, port: info.destPort });
          if (typeof forwarding === 'function' && !forwarding(info.destIP, info.destPort)) {
            reject();
            return;
          }
          const host = options.hosts?.[info.destIP] ?? info.destIP;
          const upstream = netConnect({ host, port: info.destPort });
          upstreams.add(upstream);
          upstream.once('close', () => upstreams.delete(upstream));
          upstream.once('error', () => {
            upstream.destroy();
            reject();
          });
          upstream.once('connect', () => {
            if (upstream.localPort !== undefined) stats.upstreamPorts.add(upstream.localPort);
            const channel = accept();
            channel.on('error', () => undefined);
            upstream.pipe(channel).pipe(upstream);
            channel.once('close', () => upstream.destroy());
            upstream.once('close', () => channel.destroy());
          });
        });
      });
    },
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    hostKeyFingerprint: fingerprintOf(parsedHostKey.getPublicSSH()),
    hostKeyAlgorithm: parsedHostKey.type,
    stats,
    get openChannels() {
      return upstreams.size;
    },
    dropAll: () => {
      for (const client of clients) client.end();
      for (const upstream of upstreams) upstream.destroy();
    },
    close: async () => {
      for (const client of clients) client.end();
      for (const upstream of upstreams) upstream.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** A byte reader over a socket, for the SOCKS5 server. */
function byteReader(socket: Socket): (length: number) => Promise<Buffer> {
  let buffered = Buffer.alloc(0);
  let waiting: { length: number; resolve: (value: Buffer) => void } | undefined;
  const flush = (): void => {
    if (waiting && buffered.length >= waiting.length) {
      const { length, resolve } = waiting;
      waiting = undefined;
      const out = buffered.subarray(0, length);
      buffered = buffered.subarray(length);
      resolve(out);
    }
  };
  const onData = (chunk: Buffer): void => {
    buffered = Buffer.concat([buffered, chunk]);
    flush();
  };
  socket.on('data', onData);
  return (length) =>
    new Promise((resolve) => {
      waiting = { length, resolve };
      flush();
    });
}

export interface ProxyServer {
  readonly port: number;
  readonly stats: { connections: number; destinations: string[] };
  close(): Promise<void>;
}

/**
 * A minimal SOCKS5 CONNECT server, optionally requiring user name and password (RFC 1929).
 * `hosts` maps names only the proxy resolves to addresses.
 */
export async function startSocks5Server(
  credentials?: { user: string; password: string },
  options: { refuse?: boolean; hosts?: Readonly<Record<string, string>> } = {},
): Promise<ProxyServer> {
  const stats = { connections: 0, destinations: [] as string[] };
  const server = createNetServer(async (socket) => {
    stats.connections += 1;
    socket.on('error', () => undefined);
    const read = byteReader(socket);
    const [, methodCount] = await read(2);
    const methods = [...(await read(methodCount!))];
    const wanted = credentials ? 0x02 : 0x00;
    if (!methods.includes(wanted)) {
      socket.end(Buffer.from([5, 0xff]));
      return;
    }
    socket.write(Buffer.from([5, wanted]));
    if (credentials) {
      const [, userLength] = await read(2);
      const user = (await read(userLength!)).toString();
      const [passwordLength] = await read(1);
      const password = (await read(passwordLength!)).toString();
      const ok = user === credentials.user && password === credentials.password;
      socket.write(Buffer.from([1, ok ? 0 : 1]));
      if (!ok) {
        socket.end();
        return;
      }
    }
    const [, , , addressType] = await read(4);
    let host: string;
    if (addressType === 1) host = [...(await read(4))].join('.');
    else if (addressType === 3) host = (await read((await read(1))[0]!)).toString();
    else host = (await read(16)).toString('hex');
    const port = (await read(2)).readUInt16BE(0);
    stats.destinations.push(`${host}:${port}`);
    const reply = (code: number): Buffer => Buffer.from([5, code, 0, 1, 0, 0, 0, 0, 0, 0]);
    if (options.refuse) {
      socket.end(reply(2));
      return;
    }
    socket.removeAllListeners('data');
    const upstream = netConnect({ host: options.hosts?.[host] ?? host, port });
    upstream.once('error', () => socket.end(reply(5)));
    upstream.once('connect', () => {
      socket.write(reply(0));
      socket.pipe(upstream).pipe(socket);
      socket.once('close', () => upstream.destroy());
      upstream.once('close', () => socket.destroy());
    });
  });
  const open = tracked(server);
  await listen(server);
  return {
    port: portOf(server),
    stats,
    close: async () => {
      for (const socket of open) socket.destroy();
      await closeServer(server);
    },
  };
}

/**
 * A minimal HTTP CONNECT proxy, optionally requiring Basic proxy authentication. `hosts` maps
 * names only the proxy resolves to addresses.
 */
export async function startHttpProxy(
  credentials?: { user: string; password: string },
  options: { hosts?: Readonly<Record<string, string>> } = {},
): Promise<ProxyServer> {
  const stats = { connections: 0, destinations: [] as string[] };
  const server = createHttpServer((_req, res) => {
    res.writeHead(405).end();
  });
  server.on('connect', (req, socket: Socket, head: Buffer) => {
    stats.connections += 1;
    socket.on('error', () => undefined);
    if (credentials) {
      const expected = `Basic ${Buffer.from(`${credentials.user}:${credentials.password}`).toString('base64')}`;
      if (req.headers['proxy-authorization'] !== expected) {
        socket.end(
          'HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="test"\r\n\r\n',
        );
        return;
      }
    }
    const [host, port] = (req.url ?? '').split(/:(?=\d+$)/);
    stats.destinations.push(`${host}:${port}`);
    const name = host!.replace(/^\[(.*)\]$/, '$1');
    const upstream = netConnect({ host: options.hosts?.[name] ?? name, port: Number(port) });
    upstream.once('error', () => socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'));
    upstream.once('connect', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      socket.pipe(upstream).pipe(socket);
      socket.once('close', () => upstream.destroy());
      upstream.once('close', () => socket.destroy());
    });
  });
  const open = tracked(server);
  await listen(server);
  return {
    port: portOf(server),
    stats,
    close: async () => {
      for (const socket of open) socket.destroy();
      await closeServer(server);
    },
  };
}

export interface TestAgent {
  readonly socketPath: string;
  close(): Promise<void>;
}

/** An in-process ssh-agent (ssh2's AgentProtocol in server mode) holding one key. */
export async function startAgent(privateKey: string): Promise<TestAgent> {
  const key = parse(privateKey);
  const dir = mkdtempSync(join(tmpdir(), 'joinery-agent-'));
  const socketPath = join(dir, 'agent.sock');
  const server = createNetServer((socket) => {
    socket.on('error', () => undefined);
    const protocol = new ssh2.AgentProtocol(false);
    protocol.on('identities', (request) => protocol.getIdentitiesReply(request, [key]));
    protocol.on('sign', (request, _publicKey, data) => protocol.signReply(request, key.sign(data)));
    socket.pipe(protocol).pipe(socket);
  });
  const open = tracked(server);
  await new Promise<void>((resolve) => server.listen(socketPath, () => resolve()));
  return {
    socketPath,
    close: async () => {
      for (const socket of open) socket.destroy();
      await closeServer(server);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
