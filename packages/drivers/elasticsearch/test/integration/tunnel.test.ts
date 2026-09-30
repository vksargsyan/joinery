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
  startHttpProxy,
  startSocks5Server,
  startSshServer,
  type ProxyServer,
  type TestSshServer,
} from '../../../../tunnel/test/helpers/servers';
import { createSearchAdapter, isSearchSession } from '../../src';
import { SERVERS, profileFor, type TestServer } from './helpers';

/**
 * Elasticsearch through an in-process SSH server, a SOCKS5 proxy and an HTTP
 * CONNECT proxy: one node URL is forwarded, and the requests keep the node's own Host header.
 */

const SSH_PASSWORD = 'bastion-password';

let ssh: TestSshServer;
let socks: ProxyServer;
let httpProxy: ProxyServer;
let manager: TransportManager;

beforeAll(async () => {
  ssh = await startSshServer({ users: { tunnel: { password: SSH_PASSWORD } } });
  socks = await startSocks5Server();
  httpProxy = await startHttpProxy();
  manager = new TransportManager({
    hostKeyVerifier: knownHostsVerifier(new MemoryKnownHosts(), 'accept-new'),
  });
});

afterAll(async () => {
  manager?.closeAll();
  await Promise.all([ssh?.close(), socks?.close(), httpProxy?.close()]);
});

function throughSsh(
  server: TestServer,
  overrides: Partial<ConnectionProfileInput> = {},
): ResolvedProfile {
  const base = profileFor(server, {
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

describe.skipIf(SERVERS.length === 0).each(SERVERS)('through a tunnel', (server) => {
  it('connects through SSH and runs requests', async () => {
    const adapter = createSearchAdapter();
    const connected = await connectThroughTransport(adapter, throughSsh(server), manager);
    try {
      const { session, transport } = connected;
      expect(transport?.endpointOverride.host).toBe('127.0.0.1');
      if (!isSearchSession(session)) throw new Error('expected a SearchSession');
      expect((await session.clusterHealth()).nodes).toBeGreaterThan(0);
      expect(ssh.stats.forwards.length).toBeGreaterThan(0);
    } finally {
      await connected.close();
    }
  });

  it('passes Test Connection through the tunnel, every step accounted for', async () => {
    const results: ConnectionCheckResult[] = [];
    for await (const result of createSearchAdapter().checkConnection(throughSsh(server), {
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
  });

  it('refuses several URLs through a tunnel with a hint', async () => {
    const url = new URL(server.url);
    const several = throughSsh(server, {
      endpoint: { kind: 'urls', urls: [`http://${url.host}`, 'http://other:9200'] },
    });
    await expect(
      connectThroughTransport(createSearchAdapter(), several, manager),
    ).rejects.toMatchObject({ code: 'NOT_SUPPORTED', hint: expect.stringContaining('one URL') });
  });

  it('works through SOCKS5 and HTTP CONNECT proxies', async () => {
    for (const proxy of [
      { kind: 'socks5' as const, host: '127.0.0.1', port: socks.port },
      { kind: 'http' as const, host: '127.0.0.1', port: httpProxy.port },
    ]) {
      const connected = await connectThroughTransport(
        createSearchAdapter(),
        profileFor(server, { proxy }),
        manager,
      );
      try {
        await connected.session.ping();
      } finally {
        await connected.close();
      }
    }
  });
});
