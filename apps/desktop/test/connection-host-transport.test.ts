import { createServer, connect as netConnect, type AddressInfo, type Socket } from 'node:net';
import { MessageChannel } from 'node:worker_threads';

import {
  JoineryError,
  capabilitiesFor,
  connectionProfileSchema,
  type DriverAdapter,
  type ResolvedProfile,
  type ResultChunk,
  type Session,
} from '@joinery/core';
import { connectionHostContract, createClient, fromNodePort } from '@joinery/ipc';
import {
  MemoryKnownHosts,
  TransportManager,
  connectThroughTransport,
  knownHostsVerifier,
} from '@joinery/tunnel';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { ConnectionHost } from '../src/connection-host/host';
import { profileInput } from './helpers';
import { startSshServer, type TestSshServer } from './ssh-server';

/**
 * The connection host with real tunnels: an in-process SSH server forwards to a TCP echo server
 * that stands in for the database, and a fake driver whose sessions are sockets through the
 * tunnel. Proves that sessions share one SSH session, that closing the last one releases it,
 * and that a dropped SSH session is reported once so main can restart the host.
 */

class SocketSession implements Session {
  readonly engine = 'postgres' as const;
  readonly serverVersion = '16.4';
  readonly inTransaction = false;

  constructor(
    readonly socket: Socket,
    readonly database: string | undefined,
  ) {}

  capabilities() {
    return capabilitiesFor('postgres', this.serverVersion);
  }

  // eslint-disable-next-line require-yield
  async *execute(): AsyncGenerator<ResultChunk> {
    throw new JoineryError({ code: 'NOT_SUPPORTED', message: 'not in this test' });
  }

  async cancel(): Promise<void> {}

  introspect(): never {
    throw new JoineryError({ code: 'NOT_SUPPORTED', message: 'not in this test' });
  }

  async browse(): Promise<never[]> {
    return [];
  }

  /** Sends a line through the tunnel and waits for the echo. */
  ping(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket.once('data', () => resolve());
      this.socket.once('error', reject);
      this.socket.write('ping\n');
    });
  }

  async close(): Promise<void> {
    this.socket.destroy();
  }
}

function socketAdapter(): DriverAdapter & { sessions: SocketSession[] } {
  const sessions: SocketSession[] = [];
  return {
    engine: 'postgres',
    sessions,
    capabilities: (version) => capabilitiesFor('postgres', version),
    connect: (resolved) =>
      new Promise((resolve, reject) => {
        const endpoint = resolved.endpointOverride;
        if (!endpoint) {
          reject(new Error('The test driver only connects through a tunnel'));
          return;
        }
        const socket = netConnect(endpoint);
        socket.once('error', reject);
        socket.once('connect', () => {
          const session = new SocketSession(socket, resolved.profile.options.defaultDatabase);
          sessions.push(session);
          resolve(session);
        });
      }),
  };
}

let ssh: TestSshServer;
let echo: { port: number; close(): Promise<void> };
const channels: MessageChannel[] = [];

beforeAll(async () => {
  ssh = await startSshServer({ user: 'tunnel', password: 'bastion-pw' });
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    socket.on('error', () => undefined);
    socket.pipe(socket);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  echo = {
    port: (server.address() as AddressInfo).port,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
});

afterAll(async () => {
  await Promise.all([ssh?.close(), echo?.close()]);
});

afterEach(() => {
  for (const channel of channels.splice(0)) {
    channel.port1.close();
    channel.port2.close();
  }
});

function tunnelledProfile(): ResolvedProfile {
  return {
    profile: connectionProfileSchema.parse(
      profileInput({
        endpoint: { kind: 'host', host: '127.0.0.1', port: echo.port },
        ssh: {
          hops: [
            {
              host: '127.0.0.1',
              port: ssh.port,
              user: 'tunnel',
              auth: { method: 'password', password: { id: 'ssh-pw', policy: 'save' } },
            },
          ],
        },
      }),
    ),
    secrets: { 'ssh-pw': 'bastion-pw' },
  };
}

async function startHost() {
  const adapter = socketAdapter();
  const manager = new TransportManager({
    hostKeyVerifier: knownHostsVerifier(new MemoryKnownHosts(), 'accept-new'),
  });
  const lost: JoineryError[] = [];
  const host = new ConnectionHost(adapter, tunnelledProfile(), {
    open: (profile) => connectThroughTransport(adapter, profile, manager),
    onTransportLost: (error) => lost.push(error),
  });
  await host.start();
  const channel = new MessageChannel();
  channels.push(channel);
  const attached = host.attach(fromNodePort(channel.port2));
  const client = createClient(fromNodePort(channel.port1), connectionHostContract);
  return { adapter, manager, host, client, lost, attached };
}

describe('connection host through an SSH tunnel', () => {
  it('shares one SSH session between its sessions and releases it with the last one', async () => {
    const connectionsBefore = ssh.stats.connections;
    const { adapter, manager, host, client } = await startHost();
    const a = await client.openSession({});
    const b = await client.openSession({ database: 'analytics' });
    expect(adapter.sessions.map((s) => s.database)).toEqual([undefined, undefined, 'analytics']);
    await client.ping({ sessionId: b.sessionId });
    expect(ssh.stats.connections - connectionsBefore).toBe(1);
    expect(manager.sessionCount).toBe(1);

    await client.closeSession(a);
    await client.closeSession(b);
    expect(manager.sessionCount).toBe(1);
    await host.shutdown();
    await expect.poll(() => manager.sessionCount).toBe(0);
    await expect.poll(() => ssh.active).toBe(0);
    manager.closeAll();
  });

  it('closes a closed window’s sessions with their tunnels', async () => {
    const { adapter, manager, host, client, attached } = await startHost();
    await client.openSession({});
    await client.openSession({});
    attached.dispose();
    await expect.poll(() => adapter.sessions.slice(1).every((s) => s.socket.destroyed)).toBe(true);
    // The metadata session keeps the SSH session until the host shuts down.
    expect(manager.sessionCount).toBe(1);
    await host.shutdown();
    await expect.poll(() => manager.sessionCount).toBe(0);
    manager.closeAll();
  });

  it('reports a dropped SSH session once, so main can restart the host', async () => {
    const { client, lost, manager, host } = await startHost();
    await client.openSession({});
    await client.openSession({});
    ssh.dropAll();
    await expect.poll(() => lost.length).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(lost).toHaveLength(1);
    expect(lost[0]).toMatchObject({ code: 'SSH_FAILED', engineCode: 'SSH_DISCONNECTED' });
    expect(lost[0]?.message).toMatch(/SSH connection to tunnel@127\.0\.0\.1:\d+ was lost/);
    await host.shutdown();
    manager.closeAll();
  });
});
