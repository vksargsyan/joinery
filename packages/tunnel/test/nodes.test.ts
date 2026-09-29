import { connect as netConnect, type Socket } from 'node:net';
import { networkInterfaces } from 'node:os';

import type { ConnectionProfileInput, HostPort } from '@joinery/core';
import { SocksClient } from 'socks';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  MAX_NODE_FORWARDS,
  MemoryKnownHosts,
  TransportManager,
  knownHostsVerifier,
  nodeRouteOf,
  runSshStep,
  tunnelledProfile,
  type NodeRoute,
  type SocksEndpoint,
  type Transport,
} from '../src';
import { echo, hop, resolvedWith, until } from './helpers/profiles';
import {
  closedPort,
  startEchoServer,
  startHttpProxy,
  startSocks5Server,
  startSshServer,
  type ProxyServer,
  type TcpServer,
  type TestSshServer,
} from './helpers/servers';

/**
 * Transports to topologies of several servers: the loopback SOCKS5 endpoint (credentials
 * required, loopback only, names resolved on the far side), per-server forwards (reused,
 * reserved for synchronous callers, capped), probing, SRV records and cleanup; over SSH, a jump
 * host and both kinds of proxy.
 */

const PASSWORD = 'bastion-password';
/** A name only the SSH server (and the proxies) can resolve. */
const PRIVATE_NAME = 'db.private.test';

let targetA: TcpServer;
let targetB: TcpServer;
let ssh: TestSshServer;
let jump: TestSshServer;
let socks: ProxyServer;
let http: ProxyServer;
let manager: TransportManager;
const opened: Transport[] = [];

beforeAll(async () => {
  targetA = await startEchoServer();
  targetB = await startEchoServer();
  const hosts = { [PRIVATE_NAME]: '127.0.0.1' };
  ssh = await startSshServer({ users: { tunnel: { password: PASSWORD } }, hosts });
  jump = await startSshServer({ users: { tunnel: { password: PASSWORD } } });
  socks = await startSocks5Server(undefined, { hosts });
  http = await startHttpProxy(undefined, { hosts });
  manager = new TransportManager({
    hostKeyVerifier: knownHostsVerifier(new MemoryKnownHosts(), 'accept-new'),
  });
});
afterEach(async () => {
  await Promise.all(opened.splice(0).map((t) => t.close()));
});
afterAll(async () => {
  manager.closeAll();
  await Promise.all([
    targetA.close(),
    targetB.close(),
    ssh.close(),
    jump.close(),
    socks.close(),
    http.close(),
  ]);
});

const sshAuth = { method: 'password' as const, password: { id: 'pw' } };

/** A MongoDB host list over SSH (or `extra`), whose members are the two echo servers. */
function hostList(
  hosts: HostPort[] = [
    { host: PRIVATE_NAME, port: targetA.port },
    { host: '127.0.0.1', port: targetB.port },
  ],
  extra: Partial<ConnectionProfileInput> = { ssh: { hops: [hop(ssh.port, sshAuth)] } },
) {
  return resolvedWith(
    { engine: 'mongodb', endpoint: { kind: 'hosts', hosts, replicaSet: 'rs0' }, ...extra },
    { pw: PASSWORD },
  );
}

async function open(
  resolved: ReturnType<typeof hostList>,
  options: Parameters<TransportManager['open']>[1] = {},
): Promise<Transport & { nodes: NodeRoute }> {
  const transport = await manager.open(resolved, options);
  if (!transport?.nodes) throw new Error('expected a transport with nodes');
  opened.push(transport);
  return transport as Transport & { nodes: NodeRoute };
}

/** A SOCKS5 CONNECT through `endpoint`, as the MongoDB driver makes one. */
async function socksConnect(
  endpoint: SocksEndpoint,
  target: HostPort,
  credentials: { user?: string; password?: string } = endpoint,
): Promise<Socket> {
  const { socket } = await SocksClient.createConnection({
    proxy: {
      host: endpoint.host,
      port: endpoint.port,
      type: 5,
      ...(credentials.user !== undefined
        ? { userId: credentials.user, password: credentials.password ?? '' }
        : {}),
    },
    command: 'connect',
    destination: target,
    timeout: 5000,
  });
  return socket;
}

async function roundTrip(socket: Socket, message: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let received = '';
    socket.on('data', (chunk: Buffer) => {
      received += chunk.toString();
      if (received.length >= message.length) resolve(received);
    });
    socket.once('error', reject);
    socket.write(message);
  });
}

describe('the SOCKS5 endpoint of a node route', () => {
  it('opens each destination through the tunnel, resolving names on the SSH server', async () => {
    const transport = await open(hostList());
    const endpoint = transport.nodes.socks5;
    expect(endpoint.host).toBe('127.0.0.1');
    expect(endpoint.password.length).toBeGreaterThanOrEqual(24);
    const before = ssh.stats.forwards.length;
    const socket = await socksConnect(endpoint, { host: PRIVATE_NAME, port: targetA.port });
    try {
      expect(await roundTrip(socket, 'through socks')).toBe('through socks');
      expect(transport.nodes.channelCount).toBe(1);
    } finally {
      socket.destroy();
    }
    // The name reached the SSH server unresolved: only it knows the private zone.
    expect(ssh.stats.forwards.slice(before)).toEqual([
      expect.objectContaining({ host: PRIVATE_NAME, port: targetA.port }),
    ]);
    await until(() => transport.nodes.channelCount === 0);
  });

  it('requires the route’s user name and password', async () => {
    const transport = await open(hostList());
    const endpoint = transport.nodes.socks5;
    const target = { host: '127.0.0.1', port: targetA.port };
    await expect(socksConnect(endpoint, target, {})).rejects.toThrow(
      /no accepted authentication type/i,
    );
    await expect(
      socksConnect(endpoint, target, { user: endpoint.user, password: 'guess' }),
    ).rejects.toThrow(/Authentication failed/i);
    await expect(
      socksConnect(endpoint, target, { user: 'someone', password: endpoint.password }),
    ).rejects.toThrow(/Authentication failed/i);
    // Another route's credentials do not open this one.
    const other = await open(hostList());
    await expect(
      socksConnect(endpoint, target, {
        user: other.nodes.socks5.user,
        password: other.nodes.socks5.password,
      }),
    ).rejects.toThrow(/Authentication failed/i);
  });

  it('listens on the loopback interface only', async () => {
    const transport = await open(hostList());
    const external = Object.values(networkInterfaces())
      .flat()
      .find((address) => address && !address.internal && address.family === 'IPv4');
    for (const port of [transport.nodes.socks5.port, transport.endpointOverride.port]) {
      if (external) {
        await expect(
          new Promise((resolve, reject) => {
            const socket = netConnect({ host: external.address, port });
            socket.once('connect', () => {
              socket.destroy();
              resolve('connected');
            });
            socket.once('error', reject);
          }),
        ).rejects.toMatchObject({ code: 'ECONNREFUSED' });
      }
    }
  });

  it('answers a refused destination with a SOCKS error and reports the tunnel’s reason', async () => {
    const transport = await open(hostList());
    const reported: string[] = [];
    transport.onError((error) => reported.push(String(error.engineCode)));
    const port = await closedPort();
    await expect(socksConnect(transport.nodes.socks5, { host: '127.0.0.1', port })).rejects.toThrow(
      /Socks5 proxy rejected connection/,
    );
    await until(() => reported.length > 0);
    expect(reported[0]).toBe('FORWARD_CONNECT_FAILED');
  });
});

describe('forwards of a node route', () => {
  it('opens one loopback forward per server and reuses it', async () => {
    const transport = await open(hostList());
    const a = await transport.nodes.forward({ host: PRIVATE_NAME, port: targetA.port });
    const again = await transport.nodes.forward({
      host: PRIVATE_NAME.toUpperCase(),
      port: targetA.port,
    });
    const b = await transport.nodes.forward({ host: '127.0.0.1', port: targetB.port });
    expect(a.host).toBe('127.0.0.1');
    expect(again).toEqual(a);
    expect(b.port).not.toBe(a.port);
    expect(transport.nodes.forwardCount).toBe(2);
    expect(await echo(a, 'to a')).toBe('to a');
    expect(await echo(b, 'to b')).toBe('to b');
  });

  it('hands out reserved forwards synchronously, and refills the reserve', async () => {
    const transport = await open(hostList());
    expect(transport.nodes.forwardNow({ host: '127.0.0.1', port: targetA.port })).toBeUndefined();
    await transport.nodes.reserve(2);
    const a = transport.nodes.forwardNow({ host: '127.0.0.1', port: targetA.port });
    const b = transport.nodes.forwardNow({ host: PRIVATE_NAME, port: targetB.port });
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    // The same server keeps its forward.
    expect(transport.nodes.forwardNow({ host: '127.0.0.1', port: targetA.port })).toEqual(a);
    expect(await echo(a!, 'reserved a')).toBe('reserved a');
    expect(await echo(b!, 'reserved b')).toBe('reserved b');
    await until(() => transport.nodes.forwardNow({ host: 'c', port: 1 }) !== undefined);
    expect(await transport.nodes.forward({ host: '127.0.0.1', port: targetA.port })).toEqual(a);
  });

  it(`stops at ${MAX_NODE_FORWARDS} servers`, async () => {
    const transport = await open(hostList());
    await Promise.all(
      Array.from({ length: MAX_NODE_FORWARDS }, (_, i) =>
        transport.nodes.forward({ host: `node-${i}.test`, port: 7000 }),
      ),
    );
    expect(transport.nodes.forwardCount).toBe(MAX_NODE_FORWARDS);
    await expect(
      transport.nodes.forward({ host: 'one-more.test', port: 7000 }),
    ).rejects.toMatchObject({
      code: 'CONNECTION_FAILED',
      engineCode: 'TOO_MANY_FORWARDS',
    });
    // An existing forward is still handed out.
    await expect(
      transport.nodes.forward({ host: 'node-3.test', port: 7000 }),
    ).resolves.toBeDefined();
  });

  it('closes every forward, the SOCKS endpoint and the SSH session with the transport', async () => {
    const transport = await manager.open(hostList());
    const nodes = transport!.nodes!;
    await nodes.reserve(1);
    const forward = await nodes.forward({ host: '127.0.0.1', port: targetA.port });
    const socket = await socksConnect(nodes.socks5, { host: '127.0.0.1', port: targetB.port });
    expect(manager.sessionCount).toBe(1);
    await transport!.close();
    await until(() => socket.destroyed);
    await expect(echo(forward)).rejects.toMatchObject({ code: 'ECONNREFUSED' });
    await expect(
      socksConnect(nodes.socks5, { host: '127.0.0.1', port: targetB.port }),
    ).rejects.toThrow();
    expect(manager.sessionCount).toBe(0);
    await expect(nodes.forward({ host: '127.0.0.1', port: targetB.port })).rejects.toMatchObject({
      message: 'The tunnel was closed',
    });
    await until(() => ssh.openChannels === 0);
  });
});

describe('transports to several servers', () => {
  it('shares one SSH session across every server, the endpoint forwarding to the first', async () => {
    const connections = ssh.stats.connections;
    const transport = await open(hostList());
    expect(transport.description).toMatch(
      new RegExp(
        `^SSH tunnel@127\\.0\\.0\\.1:${ssh.port} → ${PRIVATE_NAME.replaceAll('.', '\\.')}:\\d+, 127\\.0\\.0\\.1:\\d+, every server through the tunnel$`,
      ),
    );
    expect(await echo(transport.endpointOverride, 'first')).toBe('first');
    const b = await transport.nodes.forward({ host: '127.0.0.1', port: targetB.port });
    expect(await echo(b, 'second')).toBe('second');
    const socket = await socksConnect(transport.nodes.socks5, {
      host: '127.0.0.1',
      port: targetA.port,
    });
    socket.destroy();
    expect(ssh.stats.connections - connections).toBe(1);
  });

  it('probes the servers in order until one answers', async () => {
    const down = await closedPort();
    const transport = await open(
      hostList([
        { host: '127.0.0.1', port: down },
        { host: '127.0.0.1', port: targetB.port },
      ]),
    );
    await expect(transport.probe()).resolves.toBeUndefined();
    const allDown = await open(hostList([{ host: '127.0.0.1', port: down }]));
    await expect(allDown.probe()).rejects.toMatchObject({ engineCode: 'FORWARD_CONNECT_FAILED' });
  });

  it('passes the SSH step of Test Connection and hands the route on to the driver', async () => {
    const resolved = hostList();
    const outcome = await runSshStep(resolved, manager);
    try {
      expect(outcome.result).toMatchObject({ step: 'ssh', status: 'ok' });
      const routed = tunnelledProfile(resolved, outcome.transport!);
      expect(nodeRouteOf(routed)).toBe(outcome.transport!.nodes);
      expect(routed.profile.proxy).toBeUndefined();
      expect(nodeRouteOf(resolved)).toBeUndefined();
    } finally {
      await outcome.transport?.close();
    }
  });

  it('looks SRV records up on this computer, with a clear error when they do not resolve', async () => {
    const srv = resolvedWith(
      {
        engine: 'mongodb',
        endpoint: { kind: 'srv', host: 'cluster0.example.test' },
        ssh: { hops: [hop(ssh.port, sshAuth)] },
      },
      { pw: PASSWORD },
    );
    const looked: string[] = [];
    const transport = await open(srv, {
      resolveSrv: async (record) => {
        looked.push(record);
        return [{ host: PRIVATE_NAME, port: targetA.port }];
      },
    });
    expect(looked).toEqual(['_mongodb._tcp.cluster0.example.test']);
    expect(transport.description).toContain('_mongodb._tcp.cluster0.example.test (');
    expect(await echo(transport.endpointOverride, 'srv')).toBe('srv');

    await expect(
      manager.open(srv, {
        resolveSrv: async () => {
          throw Object.assign(new Error('queryA ENOTFOUND'), { code: 'ENOTFOUND' });
        },
      }),
    ).rejects.toMatchObject({
      code: 'CONNECTION_FAILED',
      engineCode: 'SRV_NOT_RESOLVED',
      message: expect.stringContaining('could not be looked up on this computer (ENOTFOUND)'),
      hint: expect.stringContaining('not through the SSH tunnel'),
    });
    expect(manager.sessionCount).toBe(1);
  });

  it('reaches every server through a jump host', async () => {
    const connections = { jump: jump.stats.connections, ssh: ssh.stats.connections };
    const transport = await open(
      hostList(undefined, {
        ssh: { hops: [hop(jump.port, sshAuth), hop(ssh.port, sshAuth)] },
      }),
    );
    const socket = await socksConnect(transport.nodes.socks5, {
      host: PRIVATE_NAME,
      port: targetB.port,
    });
    try {
      expect(await roundTrip(socket, 'two hops')).toBe('two hops');
    } finally {
      socket.destroy();
    }
    expect(jump.stats.forwards.at(-1)).toMatchObject({ host: '127.0.0.1', port: ssh.port });
    expect(ssh.stats.forwards.at(-1)).toMatchObject({ host: PRIVATE_NAME, port: targetB.port });
    expect(jump.stats.connections - connections.jump).toBe(1);
    expect(ssh.stats.connections - connections.ssh).toBe(1);
  });

  it.each(['socks5', 'http'] as const)('reaches every server through a %s proxy', async (kind) => {
    const proxy = kind === 'socks5' ? socks : http;
    const transport = await open(
      hostList(undefined, { proxy: { kind, host: '127.0.0.1', port: proxy.port } }),
    );
    expect(transport.description).toMatch(kind === 'socks5' ? /^SOCKS5 proxy/ : /^HTTP proxy/);
    const socket = await socksConnect(transport.nodes.socks5, {
      host: PRIVATE_NAME,
      port: targetA.port,
    });
    try {
      expect(await roundTrip(socket, `via ${kind}`)).toBe(`via ${kind}`);
    } finally {
      socket.destroy();
    }
    const b = await transport.nodes.forward({ host: '127.0.0.1', port: targetB.port });
    expect(await echo(b, 'forward')).toBe('forward');
    expect(proxy.stats.destinations).toContain(`${PRIVATE_NAME}:${targetA.port}`);
  });
});
