import type { ConnectionCheckResult, ConnectionProfileInput, ResolvedProfile } from '@joinery/core';
import {
  MemoryKnownHosts,
  TransportManager,
  connectThroughTransport,
  knownHostsVerifier,
  runSshStep,
} from '@joinery/tunnel';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  startSocks5Server,
  startSshServer,
  type ProxyServer,
  type TestSshServer,
} from '../../../../tunnel/test/helpers/servers';
import { checkConnection, isMongoSession, mongodbAdapter } from '../../src';
import { MONGO_URL, mongoProfile, testDatabase } from './helpers';

/**
 * The replica set through an in-process SSH server (and a SOCKS5 proxy): the tunnel forwards
 * one host, so the driver connects with directConnection and never tries the members' names.
 */

const SSH_PASSWORD = 'bastion-password';

let ssh: TestSshServer;
let socks: ProxyServer;
let manager: TransportManager;

beforeAll(async () => {
  ssh = await startSshServer({ users: { tunnel: { password: SSH_PASSWORD } } });
  socks = await startSocks5Server();
  manager = new TransportManager({
    hostKeyVerifier: knownHostsVerifier(new MemoryKnownHosts(), 'accept-new'),
  });
});

afterAll(async () => {
  manager?.closeAll();
  await Promise.all([ssh?.close(), socks?.close()]);
});

function throughSsh(overrides: Partial<ConnectionProfileInput> = {}): ResolvedProfile {
  const base = mongoProfile(MONGO_URL!, {
    // The replica set's host list: the tunnel can only forward one of them.
    endpoint: {
      kind: 'host',
      host: '127.0.0.1',
      port: Number(new URL(MONGO_URL!.replace('mongodb://', 'http://')).port),
    },
    ssh: {
      hops: [
        {
          host: '127.0.0.1',
          port: ssh.port,
          user: 'tunnel',
          auth: { method: 'password', password: { id: 'ssh-password' } },
        },
      ],
      keepAliveIntervalMs: 15000,
    },
    ...overrides,
  });
  return { ...base, secrets: { ...base.secrets, 'ssh-password': SSH_PASSWORD } };
}

describe.skipIf(!MONGO_URL)('MongoDB through an SSH tunnel', () => {
  it('connects with directConnection and runs queries and transactions', async () => {
    const connected = await connectThroughTransport(mongodbAdapter, throughSsh(), manager);
    const db = testDatabase();
    try {
      const { session, transport } = connected;
      expect(transport?.endpointOverride.host).toBe('127.0.0.1');
      if (!isMongoSession(session)) throw new Error('expected a MongoSession');
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
      expect(ssh.stats.forwards.length).toBeGreaterThan(0);
    } finally {
      if (isMongoSession(connected.session)) {
        await connected.session.dropDatabase(db).catch(() => undefined);
      }
      await connected.close();
    }
  });

  it('passes Test Connection through the tunnel, every step accounted for', async () => {
    const results: ConnectionCheckResult[] = [];
    for await (const result of checkConnection(throughSsh(), {
      runSshStep: (profile) => runSshStep(profile, manager),
    })) {
      results.push(result);
    }
    expect(results.map((r) => [r.step, r.status])).toEqual([
      ['dns', 'skipped'],
      ['tcp', 'ok'],
      ['ssh', 'ok'],
      ['tls', 'skipped'],
      ['auth', 'ok'],
      ['ping', 'ok'],
      ['version', 'ok'],
    ]);
    expect(results[6]!.message).toContain('replica set rs0');
  });

  it('refuses host lists and SRV names through a tunnel with a hint', async () => {
    const list = throughSsh({
      endpoint: { kind: 'hosts', hosts: [{ host: '127.0.0.1', port: 27018 }], replicaSet: 'rs0' },
    });
    await expect(connectThroughTransport(mongodbAdapter, list, manager)).rejects.toMatchObject({
      code: 'NOT_SUPPORTED',
      hint: expect.stringContaining('single host'),
    });
    const srv = throughSsh({ endpoint: { kind: 'srv', host: 'cluster0.example.net' } });
    await expect(connectThroughTransport(mongodbAdapter, srv, manager)).rejects.toMatchObject({
      code: 'NOT_SUPPORTED',
      hint: expect.stringContaining('single host'),
    });
    const srvUri = throughSsh({
      endpoint: { kind: 'uri', uri: 'mongodb+srv://cluster0.example.net/' },
    });
    await expect(connectThroughTransport(mongodbAdapter, srvUri, manager)).rejects.toMatchObject({
      code: 'NOT_SUPPORTED',
      hint: expect.stringContaining('+srv'),
    });
    const multi = throughSsh({
      endpoint: { kind: 'uri', uri: 'mongodb://a:1,b:2/?replicaSet=rs0' },
    });
    await expect(connectThroughTransport(mongodbAdapter, multi, manager)).rejects.toMatchObject({
      code: 'NOT_SUPPORTED',
      hint: expect.stringContaining('one host'),
    });
    // The driver itself refuses them too when handed an override.
    await expect(
      mongodbAdapter.connect({ ...list, endpointOverride: { host: '127.0.0.1', port: 1 } }),
    ).rejects.toMatchObject({ code: 'NOT_SUPPORTED' });
  });

  it('works through a SOCKS5 proxy the same way', async () => {
    const resolved = mongoProfile(MONGO_URL!, {
      endpoint: {
        kind: 'host',
        host: '127.0.0.1',
        port: Number(new URL(MONGO_URL!.replace('mongodb://', 'http://')).port),
      },
      proxy: { kind: 'socks5', host: '127.0.0.1', port: socks.port },
    });
    const connected = await connectThroughTransport(mongodbAdapter, resolved, manager);
    try {
      await connected.session.ping();
    } finally {
      await connected.close();
    }
  });
});
