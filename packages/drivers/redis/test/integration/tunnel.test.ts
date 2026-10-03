import type { ConnectionCheckResult, ResolvedProfile } from '@querybara/core';
import { keySlot, type RedisReply } from '@querybara/redis-tools';
import {
  MemoryKnownHosts,
  TransportManager,
  connectThroughTransport,
  knownHostsVerifier,
  runSshStep,
  type TransportSession,
} from '@querybara/tunnel';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { redisProfileFromUrl, type RedisSession } from '../../src';
import {
  startHttpProxy,
  startSocks5Server,
  startSshServer,
  type ProxyServer,
  type TestSshServer,
} from '../../../../tunnel/test/helpers/servers';
import {
  REDIS_CLUSTER,
  REDIS_SENTINEL,
  REDIS_URL,
  adapter,
  cleanup,
  clusterProfile,
  dec,
  newPrefix,
  replies,
  sentinelProfile,
} from './helpers';

/**
 * Redis through an in-process SSH server (the tunnel package's helper): a standalone server over
 * one forward; Cluster and Sentinel with every node they announce reached through the tunnel
 * (and through a jump host and proxies). The seeds and Sentinels are named by a name only the
 * SSH server resolves, and each node reports its connections coming from the SSH server.
 */

const SSH_PASSWORD = 'bastion-password';
/** A name for 127.0.0.1 that only the SSH server and the proxies resolve. */
const PRIVATE = 'redis.private.test';
const HOSTS = { [PRIVATE]: '127.0.0.1' };

let ssh: TestSshServer;
let jump: TestSshServer;
let socks: ProxyServer;
let http: ProxyServer;
let manager: TransportManager;

beforeAll(async () => {
  ssh = await startSshServer({ users: { tunnel: { password: SSH_PASSWORD } }, hosts: HOSTS });
  jump = await startSshServer({ users: { tunnel: { password: SSH_PASSWORD } } });
  socks = await startSocks5Server(undefined, { hosts: HOSTS });
  http = await startHttpProxy(undefined, { hosts: HOSTS });
  const trusted = new Set([ssh.hostKeyFingerprint, jump.hostKeyFingerprint]);
  const verifier = knownHostsVerifier(new MemoryKnownHosts(), async (_host, _port, key) =>
    trusted.has(key.fingerprintSha256) ? 'trust' : 'reject',
  );
  manager = new TransportManager({ hostKeyVerifier: verifier });
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
    auth: {
      method: 'password' as const,
      password: { id: 'ssh-password', policy: 'save' as const },
    },
  };
}

function tunnelled(base: ResolvedProfile, hops = [hopTo(ssh)]): ResolvedProfile {
  const profile = { ...base.profile, ssh: { hops, keepAliveIntervalMs: 15_000 } };
  return { profile, secrets: { ...base.secrets, 'ssh-password': SSH_PASSWORD } };
}

/** The profile's seeds or Sentinels renamed to the name only the far side resolves. */
function privately(base: ResolvedProfile): ResolvedProfile {
  const endpoint = base.profile.endpoint;
  const rename = <T extends { host: string }>(h: T): T => ({ ...h, host: PRIVATE });
  const renamed =
    endpoint.kind === 'cluster'
      ? { ...endpoint, seeds: endpoint.seeds.map(rename) }
      : endpoint.kind === 'sentinel'
        ? { ...endpoint, sentinels: endpoint.sentinels.map(rename) }
        : endpoint;
  return { ...base, profile: { ...base.profile, endpoint: renamed } };
}

function redis(connected: TransportSession): RedisSession {
  return connected.session as RedisSession;
}

function text(reply: RedisReply): string {
  return reply.type === 'bulk' || reply.type === 'verbatim' ? dec(reply.value)! : '';
}

/** The port a node sees a connection come from, from CLIENT INFO's `addr`. */
function clientPort(info: string): number {
  const addr = /(?:^|\s)addr=(\S+)/.exec(info)?.[1] ?? '';
  return Number(addr.slice(addr.lastIndexOf(':') + 1));
}

async function steps(resolved: ResolvedProfile): Promise<ConnectionCheckResult[]> {
  const out: ConnectionCheckResult[] = [];
  for await (const step of adapter.checkConnection(resolved, {
    runSshStep: (r) => runSshStep(r, manager),
  })) {
    out.push(step);
  }
  return out;
}

describe.skipIf(!REDIS_URL)('through an SSH tunnel', () => {
  it('runs commands through the tunnel', async () => {
    const resolved = tunnelled(redisProfileFromUrl(REDIS_URL!));
    const connected = await connectThroughTransport(adapter, resolved, manager);
    const session = redis(connected);
    const p = newPrefix();
    try {
      expect(await replies(session, `set ${p}k v\nget ${p}k`)).toEqual(['OK', '"v"']);
      expect(ssh.stats.forwards.some((f) => f.port === Number(new URL(REDIS_URL!).port))).toBe(
        true,
      );
      expect((await session.scanPage({ match: `${p}*`, limit: 10 })).keys).toHaveLength(1);
    } finally {
      await cleanup(session, p);
      await connected.close();
    }
  });

  it('runs Test Connection through the tunnel', async () => {
    const results = await steps(tunnelled(redisProfileFromUrl(REDIS_URL!)));
    expect(results.map((s) => [s.step, s.status])).toEqual([
      ['dns', 'skipped'],
      ['tcp', 'ok'],
      ['ssh', 'ok'],
      ['tls', 'skipped'],
      ['auth', 'ok'],
      ['ping', 'ok'],
      ['version', 'ok'],
    ]);
  });

  it('goes through a proxy alone, not around it', async () => {
    const base = redisProfileFromUrl(REDIS_URL!);
    const resolved = {
      ...base,
      profile: {
        ...base.profile,
        proxy: { kind: 'socks5' as const, host: '127.0.0.1', port: socks.port },
      },
    };
    const before = socks.stats.connections;
    const connected = await connectThroughTransport(adapter, resolved, manager);
    try {
      expect(await replies(redis(connected), 'ping')).toEqual(['PONG']);
      expect(socks.stats.connections).toBeGreaterThan(before);
    } finally {
      await connected.close();
    }
  });

  it('refuses a tunnelled profile when no tunnel is open', async () => {
    const error = await adapter
      .connect(tunnelled(redisProfileFromUrl(REDIS_URL!)))
      .catch((e: unknown) => e);
    expect(error).toMatchObject({
      code: 'NOT_SUPPORTED',
      message: expect.stringMatching(/no tunnel is open/),
    });
  });
});

describe.skipIf(!REDIS_CLUSTER || !REDIS_URL)('Cluster through an SSH tunnel', () => {
  it('reads and writes on every primary, each reached through the tunnel', async () => {
    const forwardsBefore = ssh.stats.forwards.length;
    const connected = await connectThroughTransport(
      adapter,
      tunnelled(privately(clusterProfile())),
      manager,
    );
    const session = redis(connected);
    const p = newPrefix();
    try {
      expect(session.server).toMatchObject({ topology: 'cluster', clusterMode: true });
      // The nodes keep the addresses they announce, not the forwards' local ones.
      const primaries = session.nodes().map((n) => n.address);
      expect(primaries).toEqual(REDIS_CLUSTER!.split(',').sort());
      expect(session.nodes()[0]).toMatchObject({ host: '127.0.0.1' });

      // Keys on every primary (hash tags pick a slot on each), written and read back.
      const view = await session.topology();
      const keys = view.nodes
        .filter((n) => n.role === 'primary')
        .map((n) => {
          const [start] = n.slots[0]!;
          let tag = 0;
          while (keySlot(`{${tag}}`) < start || keySlot(`{${tag}}`) > n.slots[0]![1]) tag += 1;
          return { node: n.address, key: `${p}{${tag}}k` };
        });
      expect(new Set(keys.map((k) => k.node)).size).toBe(3);
      for (const { key } of keys) {
        expect(await session.command(['SET', key, `v-${key}`])).toMatchObject({ value: 'OK' });
      }
      for (const { key } of keys) {
        expect(text(await session.command(['GET', key]))).toBe(`v-${key}`);
      }

      // Every primary sees this session's connection come from the SSH server.
      const infos = await session.commandAll(['CLIENT', 'INFO']);
      expect(infos.map((r) => r.node)).toEqual(primaries);
      for (const info of infos) {
        expect(ssh.stats.upstreamPorts.has(clientPort(text(info.reply)))).toBe(true);
      }
      // The seed went to the SSH server by its private name, the nodes by what they announce.
      const forwards = ssh.stats.forwards.slice(forwardsBefore);
      expect(forwards).toContainEqual({ host: PRIVATE, port: 7100 });
      for (const address of primaries) {
        const [host, port] = address.split(':') as [string, string];
        expect(forwards).toContainEqual({ host, port: Number(port) });
      }
      expect(connected.transport!.nodes!.forwardCount).toBeGreaterThanOrEqual(4);
    } finally {
      await cleanup(session, p);
      await connected.close();
    }
    expect(manager.sessionCount).toBe(0);
  });

  it('follows a MOVED to the node that owns the key', async () => {
    const connected = await connectThroughTransport(
      adapter,
      tunnelled(privately(clusterProfile())),
      manager,
    );
    const session = redis(connected);
    const p = newPrefix();
    try {
      const key = `${p}moved`;
      const view = await session.topology();
      const slot = keySlot(key);
      const owner = view.nodes.find(
        (n) => n.role === 'primary' && n.slots.some(([s, e]) => slot >= s && slot <= e),
      )!.address;
      const other = session.nodes().find((n) => n.address !== owner)!.address;
      // Sent to a node that does not own the slot: it answers MOVED, and the session follows.
      expect(await session.command(['SET', key, 'moved'], { node: other })).toMatchObject({
        value: 'OK',
      });
      expect(text(await session.command(['GET', key], { node: other }))).toBe('moved');
      const chunks: unknown[] = [];
      session.setTargetNode(other);
      for await (const chunk of session.execute(`get ${key}`, { executionId: `moved-${p}` })) {
        chunks.push(chunk);
      }
      const row = chunks.find((c) => (c as { type: string }).type === 'rows') as {
        data: unknown[][];
      };
      expect(row.data[1]![0]).toBe(owner);
    } finally {
      session.setTargetNode(undefined);
      await cleanup(session, p);
      await connected.close();
    }
  });

  it('passes Test Connection: the SSH step, then the cluster', async () => {
    const results = await steps(tunnelled(privately(clusterProfile())));
    expect(results.map((s) => [s.step, s.status])).toEqual([
      ['dns', 'skipped'],
      ['tcp', 'ok'],
      ['ssh', 'ok'],
      ['tls', 'skipped'],
      ['auth', 'ok'],
      ['ping', 'ok'],
      ['version', 'ok'],
    ]);
    expect(results[2]!.message).toMatch(/every server through the tunnel$/);
    expect(results[6]!.message).toMatch(/cluster of 3 primaries/);
  });

  it('goes through a jump host', async () => {
    const before = { jump: jump.stats.forwards.length, ssh: ssh.stats.connections };
    const connected = await connectThroughTransport(
      adapter,
      tunnelled(privately(clusterProfile()), [hopTo(jump), hopTo(ssh)]),
      manager,
    );
    const session = redis(connected);
    try {
      const pings = await session.commandAll(['PING']);
      expect(pings.map((r) => r.reply)).toEqual([
        { type: 'status', value: 'PONG' },
        { type: 'status', value: 'PONG' },
        { type: 'status', value: 'PONG' },
      ]);
      expect(jump.stats.forwards.slice(before.jump)).toEqual([
        { host: '127.0.0.1', port: ssh.port },
      ]);
      expect(ssh.stats.connections - before.ssh).toBe(1);
    } finally {
      await connected.close();
    }
  });

  it.each(['socks5', 'http'] as const)('goes through a %s proxy', async (kind) => {
    const proxy = kind === 'socks5' ? socks : http;
    const base = privately(clusterProfile());
    const resolved = {
      ...base,
      profile: { ...base.profile, proxy: { kind, host: '127.0.0.1', port: proxy.port } },
    };
    const connected = await connectThroughTransport(adapter, resolved, manager);
    const session = redis(connected);
    try {
      expect((await session.commandAll(['PING'])).length).toBe(3);
      expect(proxy.stats.destinations).toContain(`${PRIVATE}:7100`);
      expect(proxy.stats.destinations).toContain('127.0.0.1:7101');
    } finally {
      await connected.close();
    }
  });
});

describe.skipIf(!REDIS_SENTINEL || !REDIS_URL)('Sentinel through an SSH tunnel', () => {
  it('finds the master through the tunnel and works on it', async () => {
    const connected = await connectThroughTransport(
      adapter,
      tunnelled(privately(sentinelProfile({ options: { defaultDatabase: '1' } }))),
      manager,
    );
    const session = redis(connected);
    const p = newPrefix();
    try {
      expect(session.server).toMatchObject({ topology: 'sentinel', role: 'master' });
      expect(await replies(session, `set ${p}k v\nget ${p}k`)).toEqual(['OK', '"v"']);
      const info = text(await session.command(['CLIENT', 'INFO']));
      expect(ssh.stats.upstreamPorts.has(clientPort(info))).toBe(true);
      // The Sentinels' view, asked through the tunnel too.
      const view = await session.topology();
      expect(view.sentinel!.master).toMatchObject({
        port: Number(new URL(REDIS_URL!).port),
        flags: expect.stringContaining('master'),
      });
      expect(view.sentinel!.replicas.length).toBeGreaterThanOrEqual(1);
      const port = Number(new URL(REDIS_URL!).port);
      expect(ssh.stats.forwards).toContainEqual({ host: '127.0.0.1', port });
      expect(ssh.stats.forwards).toContainEqual({
        host: PRIVATE,
        port: Number(REDIS_SENTINEL!.split('/')[0]!.split(':')[1]),
      });
    } finally {
      await cleanup(session, p);
      await connected.close();
    }
  });

  it('passes Test Connection through the tunnel', async () => {
    const results = await steps(tunnelled(privately(sentinelProfile())));
    expect(results.map((s) => s.status)).toEqual([
      'skipped',
      'ok',
      'ok',
      'skipped',
      'ok',
      'ok',
      'ok',
    ]);
    expect(results.at(-1)!.message).toMatch(/through Sentinel, master/);
  });

  it('names an unknown master through the tunnel too', async () => {
    const base = privately(sentinelProfile());
    const endpoint = base.profile.endpoint;
    if (endpoint.kind !== 'sentinel') throw new Error('expected a Sentinel profile');
    const resolved = tunnelled({
      ...base,
      profile: { ...base.profile, endpoint: { ...endpoint, masterName: 'no-such-master' } },
    });
    const error = await connectThroughTransport(adapter, resolved, manager).catch(
      (e: unknown) => e,
    );
    expect(error).toMatchObject({ code: 'CONNECTION_FAILED' });
    expect((error as { message: string }).message).toMatch(/no-such-master/);
  });
});
