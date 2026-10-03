import type {
  ConnectionCheckResult,
  ConnectionProfileInput,
  ResolvedProfile,
} from '@querybara/core';
import {
  MemoryKnownHosts,
  TransportManager,
  connectThroughTransport,
  knownHostsVerifier,
  runSshStep,
  type TransportSession,
} from '@querybara/tunnel';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  startHttpProxy,
  startSocks5Server,
  startSshServer,
  type ProxyServer,
  type TestSshServer,
} from '../../../../tunnel/test/helpers/servers';
import { checkConnection, isMongoSession, mongodbAdapter, type MongoSession } from '../../src';
import { MONGO_URL, cells, collect, mongoProfile, testDatabase } from './helpers';

/**
 * The replica set through an in-process SSH server (and proxies). A single host is forwarded and
 * connected to directly; a host list is discovered through the tunnel's SOCKS5 endpoint, every
 * member reached by the name it announces. The seed below is a name only the SSH server (and the
 * proxies) resolve, so nothing reaches it except through them; and the server reports each
 * connection coming from the SSH server's own sockets.
 */

const SSH_PASSWORD = 'bastion-password';
/** The replica set's seed as only the far side knows it. */
const SEED_NAME = 'rs-seed.private.test';
const HOSTS = { [SEED_NAME]: '127.0.0.1' };

let ssh: TestSshServer;
let jump: TestSshServer;
let socks: ProxyServer;
let http: ProxyServer;
let manager: TransportManager;

const port = (): number => Number(new URL(MONGO_URL!.replace('mongodb://', 'http://')).port);

beforeAll(async () => {
  ssh = await startSshServer({ users: { tunnel: { password: SSH_PASSWORD } }, hosts: HOSTS });
  jump = await startSshServer({ users: { tunnel: { password: SSH_PASSWORD } } });
  socks = await startSocks5Server(undefined, { hosts: HOSTS });
  http = await startHttpProxy(undefined, { hosts: HOSTS });
  manager = new TransportManager({
    hostKeyVerifier: knownHostsVerifier(new MemoryKnownHosts(), 'accept-new'),
  });
});

afterAll(async () => {
  manager?.closeAll();
  await Promise.all([ssh?.close(), jump?.close(), socks?.close(), http?.close()]);
});

function hopTo(server: TestSshServer) {
  return {
    host: '127.0.0.1',
    port: server.port,
    user: 'tunnel',
    auth: { method: 'password' as const, password: { id: 'ssh-password' } },
  };
}

function throughSsh(
  overrides: Partial<ConnectionProfileInput> = {},
  hops = [hopTo(ssh)],
): ResolvedProfile {
  const base = mongoProfile(MONGO_URL!, {
    endpoint: { kind: 'host', host: '127.0.0.1', port: port() },
    ssh: { hops, keepAliveIntervalMs: 15000 },
    ...overrides,
  });
  return { ...base, secrets: { ...base.secrets, 'ssh-password': SSH_PASSWORD } };
}

/** The replica set's host list, seeded by a name only the far side resolves. */
const replicaSet: ConnectionProfileInput['endpoint'] = {
  kind: 'hosts',
  hosts: [{ host: SEED_NAME, port: 27018 }],
  replicaSet: 'rs0',
};

async function mongo(connected: TransportSession): Promise<MongoSession> {
  if (!isMongoSession(connected.session)) throw new Error('expected a MongoSession');
  return connected.session;
}

/** The port the server sees this session's connection come from (`whatsmyuri`). */
async function clientPort(session: MongoSession): Promise<number> {
  const [reply] = cells(await collect(session, '{ whatsmyuri: 1 }'));
  const you = (JSON.parse(reply!) as { you: string }).you;
  return Number(you.slice(you.lastIndexOf(':') + 1));
}

async function steps(resolved: ResolvedProfile): Promise<ConnectionCheckResult[]> {
  const results: ConnectionCheckResult[] = [];
  for await (const result of checkConnection(resolved, {
    runSshStep: (profile) => runSshStep(profile, manager),
  })) {
    results.push(result);
  }
  return results;
}

describe.skipIf(!MONGO_URL)('MongoDB through an SSH tunnel', () => {
  it('connects to a single host with directConnection and runs queries and transactions', async () => {
    const connected = await connectThroughTransport(mongodbAdapter, throughSsh(), manager);
    const db = testDatabase();
    try {
      const { transport } = connected;
      const session = await mongo(connected);
      expect(transport?.endpointOverride.host).toBe('127.0.0.1');
      expect(transport?.nodes).toBeUndefined();
      expect(session.capabilities().transactions).toBe(true);
      const ns = { db, collection: 'c' };
      await session.begin();
      await session.insertMany(
        ns,
        `[${Array.from({ length: 3000 }, (_, i) => `{ i: ${i} }`).join(',')}]`,
      );
      await session.commit();
      let count = 0;
      for await (const page of session.find(ns, {}, { pageSize: 1000 }))
        count += page.documents.length;
      expect(count).toBe(3000);
      expect(ssh.stats.upstreamPorts.has(await clientPort(session))).toBe(true);
    } finally {
      if (isMongoSession(connected.session)) {
        await connected.session.dropDatabase(db).catch(() => undefined);
      }
      await connected.close();
    }
  });

  it('discovers the replica set through the tunnel, every connection going through it', async () => {
    const forwardsBefore = ssh.stats.forwards.length;
    const connected = await connectThroughTransport(
      mongodbAdapter,
      throughSsh({ endpoint: replicaSet }),
      manager,
    );
    const db = testDatabase();
    try {
      const session = await mongo(connected);
      expect((await session.serverInfo()).topology).toBe('replicaSet');
      const info = await session.serverInfo();
      expect(info).toMatchObject({ topology: 'replicaSet', setName: 'rs0' });
      // A write and a read on the primary it discovered, in a transaction.
      const ns = { db, collection: 'through_socks' };
      await session.begin();
      await session.insertMany(ns, '[{ a: 1 }, { a: 2 }]');
      await session.commit();
      expect(await session.count(ns)).toBe(2);

      // The seed name went to the SSH server unresolved, then the member it announced.
      const forwards = ssh.stats.forwards.slice(forwardsBefore);
      expect(forwards).toContainEqual({ host: SEED_NAME, port: 27018 });
      expect(forwards).toContainEqual({ host: '127.0.0.1', port: 27018 });
      // The server sees this session's connection coming from the SSH server.
      expect(ssh.stats.upstreamPorts.has(await clientPort(session))).toBe(true);
      const nodes = connected.transport!.nodes!;
      expect(nodes.channelCount).toBeGreaterThanOrEqual(2);
      expect(nodes.forwardCount).toBe(0);
    } finally {
      if (isMongoSession(connected.session)) {
        await connected.session.dropDatabase(db).catch(() => undefined);
      }
      await connected.close();
    }
    expect(connected.transport!.nodes!.channelCount).toBe(0);
    expect(manager.sessionCount).toBe(0);
  });

  it('passes Test Connection for the replica set: the SSH step, then its own steps', async () => {
    const results = await steps(throughSsh({ endpoint: replicaSet }));
    expect(results.map((r) => [r.step, r.status])).toEqual([
      ['dns', 'skipped'],
      ['tcp', 'ok'],
      ['ssh', 'ok'],
      ['tls', 'skipped'],
      ['auth', 'ok'],
      ['ping', 'ok'],
      ['version', 'ok'],
    ]);
    expect(results[2]!.message).toBe(
      `SSH tunnel@127.0.0.1:${ssh.port} → ${SEED_NAME}:27018, every server through the tunnel`,
    );
    expect(results[6]!.message).toContain('replica set rs0');

    const single = await steps(throughSsh());
    expect(single.map((r) => r.status)).not.toContain('failed');
    expect(single[6]!.message).toContain('replica set rs0');
  });

  it('reaches the replica set through a jump host', async () => {
    const before = { jump: jump.stats.forwards.length, ssh: ssh.stats.forwards.length };
    const connected = await connectThroughTransport(
      mongodbAdapter,
      throughSsh({ endpoint: replicaSet }, [hopTo(jump), hopTo(ssh)]),
      manager,
    );
    try {
      const session = await mongo(connected);
      await session.ping();
      expect((await session.serverInfo()).topology).toBe('replicaSet');
      expect(jump.stats.forwards.slice(before.jump)).toEqual([
        { host: '127.0.0.1', port: ssh.port },
      ]);
      expect(ssh.stats.forwards.slice(before.ssh)).toContainEqual({ host: SEED_NAME, port: 27018 });
      expect(ssh.stats.upstreamPorts.has(await clientPort(session))).toBe(true);
    } finally {
      await connected.close();
    }
  });

  it('reads a URI naming the replica set the same way', async () => {
    const connected = await connectThroughTransport(
      mongodbAdapter,
      throughSsh({
        endpoint: { kind: 'uri', uri: `mongodb://${SEED_NAME}:27018/?replicaSet=rs0` },
      }),
      manager,
    );
    try {
      const session = await mongo(connected);
      expect((await session.serverInfo()).topology).toBe('replicaSet');
    } finally {
      await connected.close();
    }
  });

  it('says clearly when an SRV name does not resolve on this computer', async () => {
    const srv = throughSsh({ endpoint: { kind: 'srv', host: 'cluster0.querybara.invalid' } });
    await expect(connectThroughTransport(mongodbAdapter, srv, manager)).rejects.toMatchObject({
      code: 'CONNECTION_FAILED',
      engineCode: 'SRV_NOT_RESOLVED',
      message: expect.stringContaining('_mongodb._tcp.cluster0.querybara.invalid'),
      hint: expect.stringContaining('host list'),
    });
    const results = await steps(srv);
    expect(results.find((r) => r.status === 'failed')).toMatchObject({
      step: 'ssh',
      message: expect.stringContaining('could not be looked up on this computer'),
    });
    expect(manager.sessionCount).toBe(0);
  });

  it.each(['socks5', 'http'] as const)(
    'discovers the replica set through a %s proxy',
    async (kind) => {
      const proxy = kind === 'socks5' ? socks : http;
      const resolved = mongoProfile(MONGO_URL!, {
        endpoint: replicaSet,
        proxy: { kind, host: '127.0.0.1', port: proxy.port },
      });
      const connected = await connectThroughTransport(mongodbAdapter, resolved, manager);
      try {
        const session = await mongo(connected);
        await session.ping();
        expect((await session.serverInfo()).topology).toBe('replicaSet');
        expect(proxy.stats.destinations).toContain(`${SEED_NAME}:27018`);
        expect(proxy.stats.destinations).toContain('127.0.0.1:27018');
      } finally {
        await connected.close();
      }
    },
  );
});
