import { createHash } from 'node:crypto';
import { createServer, connect as netConnect, type AddressInfo, type Socket } from 'node:net';

import ssh2 from 'ssh2';
import type { Connection } from 'ssh2';

/**
 * An in-process SSH server (ssh2's Server) for the unit and integration tests: password login and
 * direct-tcpip forwarding to real TCP destinations, like `AllowTcpForwarding yes` on a bastion.
 */

export interface TestSshServer {
  readonly port: number;
  /** `SHA256:…` of the host key, as Joinery shows it. */
  readonly hostKeyFingerprint: string;
  readonly stats: { connections: number; authenticated: number; forwards: number };
  /** SSH sessions open right now. */
  readonly active: number;
  /** Drops every client connection, as a network failure or a server restart would. */
  dropAll(): void;
  close(): Promise<void>;
}

/** A fresh Ed25519 host key (OpenSSH text), skipping the rare keys ssh2 encodes wrongly. */
export function ed25519Key(): string {
  for (;;) {
    const pair = ssh2.utils.generateKeyPairSync('ed25519');
    if (!(ssh2.utils.parseKey(pair.private) instanceof Error)) return pair.private;
  }
}

export async function startSshServer(options: {
  readonly user: string;
  readonly password: string;
  readonly hostKey?: string;
}): Promise<TestSshServer> {
  const hostKey = options.hostKey ?? ed25519Key();
  const parsed = ssh2.utils.parseKey(hostKey);
  if (parsed instanceof Error) throw parsed;
  const fingerprint = createHash('sha256')
    .update(parsed.getPublicSSH())
    .digest('base64')
    .replace(/=+$/, '');
  const stats = { connections: 0, authenticated: 0, forwards: 0 };
  const clients = new Set<Connection>();
  const upstreams = new Set<Socket>();
  const server = new ssh2.Server({ hostKeys: [hostKey] }, (client) => {
    stats.connections += 1;
    clients.add(client);
    client.on('close', () => clients.delete(client));
    client.on('error', () => undefined);
    client.on('authentication', (ctx) => {
      if (ctx.username !== options.user) return ctx.reject();
      if (ctx.method === 'password') {
        return ctx.password === options.password ? ctx.accept() : ctx.reject();
      }
      if (ctx.method === 'keyboard-interactive') {
        return ctx.prompt([{ prompt: 'Password: ', echo: false }], (answers) =>
          answers[0] === options.password ? ctx.accept() : ctx.reject(),
        );
      }
      return ctx.reject(['password', 'keyboard-interactive']);
    });
    client.on('ready', () => {
      stats.authenticated += 1;
      client.on('tcpip', (accept, reject, info) => {
        stats.forwards += 1;
        const upstream = netConnect({ host: info.destIP, port: info.destPort });
        upstreams.add(upstream);
        upstream.once('close', () => upstreams.delete(upstream));
        upstream.once('error', () => {
          upstream.destroy();
          reject();
        });
        upstream.once('connect', () => {
          const channel = accept();
          channel.on('error', () => undefined);
          upstream.pipe(channel).pipe(upstream);
          channel.once('close', () => upstream.destroy());
          upstream.once('close', () => channel.destroy());
        });
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const drop = (): void => {
    for (const client of clients) client.end();
    for (const upstream of upstreams) upstream.destroy();
  };
  return {
    port: (server.address() as AddressInfo).port,
    hostKeyFingerprint: `SHA256:${fingerprint}`,
    stats,
    get active() {
      return clients.size;
    },
    dropAll: drop,
    close: async () => {
      drop();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** A TCP echo server standing in for a database behind the bastion. */
export async function startEchoServer(): Promise<{ port: number; close(): Promise<void> }> {
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    socket.on('error', () => undefined);
    socket.pipe(socket);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  return {
    port: (server.address() as AddressInfo).port,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
