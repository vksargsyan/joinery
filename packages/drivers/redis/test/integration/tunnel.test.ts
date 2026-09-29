import type { ConnectionCheckResult, ResolvedProfile } from '@joinery/core';
import {
  MemoryKnownHosts,
  TransportManager,
  connectThroughTransport,
  knownHostsVerifier,
  runSshStep,
} from '@joinery/tunnel';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { redisProfileFromUrl, type RedisSession } from '../../src';
import { startSshServer, type TestSshServer } from '../../../../tunnel/test/helpers/servers';
import {
  REDIS_URL,
  adapter,
  cleanup,
  clusterProfile,
  newPrefix,
  replies,
  sentinelProfile,
} from './helpers';

const SSH_PASSWORD = 'bastion-password';

/** A standalone Redis reached through an in-process SSH server (the tunnel package's helper). */
describe.skipIf(!REDIS_URL)('through an SSH tunnel', () => {
  let ssh: TestSshServer;
  let manager: TransportManager;

  beforeAll(async () => {
    ssh = await startSshServer({ users: { tunnel: { password: SSH_PASSWORD } } });
    const verifier = knownHostsVerifier(new MemoryKnownHosts(), async (_host, _port, key) =>
      key.fingerprintSha256 === ssh.hostKeyFingerprint ? 'trust' : 'reject',
    );
    manager = new TransportManager({ hostKeyVerifier: verifier });
  });
  afterAll(async () => {
    manager?.closeAll();
    await ssh?.close();
  });

  function tunnelled(base: ResolvedProfile): ResolvedProfile {
    const profile = {
      ...base.profile,
      ssh: {
        hops: [
          {
            host: '127.0.0.1',
            port: ssh.port,
            user: 'tunnel',
            auth: {
              method: 'password' as const,
              password: { id: 'ssh-password', policy: 'save' as const },
            },
          },
        ],
        keepAliveIntervalMs: 15_000,
      },
    };
    return { profile, secrets: { ...base.secrets, 'ssh-password': SSH_PASSWORD } };
  }

  it('runs commands through the tunnel', async () => {
    const resolved = tunnelled(redisProfileFromUrl(REDIS_URL!));
    const connected = await connectThroughTransport(adapter, resolved, manager);
    const session = connected.session as RedisSession;
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
    const resolved = tunnelled(redisProfileFromUrl(REDIS_URL!));
    const steps: ConnectionCheckResult[] = [];
    for await (const step of adapter.checkConnection(resolved, {
      runSshStep: (r) => runSshStep(r, manager),
    })) {
      steps.push(step);
    }
    expect(steps.map((s) => [s.step, s.status])).toEqual([
      ['dns', 'skipped'],
      ['tcp', 'ok'],
      ['ssh', 'ok'],
      ['tls', 'skipped'],
      ['auth', 'ok'],
      ['ping', 'ok'],
      ['version', 'ok'],
    ]);
  });

  it('refuses Sentinel and Cluster endpoints through a tunnel', async () => {
    for (const base of [sentinelProfile(), clusterProfile()]) {
      const resolved = tunnelled(base);
      const error = await adapter.connect(resolved).catch((e: unknown) => e);
      expect(error).toMatchObject({ code: 'NOT_SUPPORTED' });
      expect((error as { hint: string }).hint).toMatch(/single host/);
      const steps: ConnectionCheckResult[] = [];
      for await (const step of adapter.checkConnection(resolved, {
        runSshStep: (r) => runSshStep(r, manager),
      })) {
        steps.push(step);
      }
      expect(steps.find((s) => s.status === 'failed')).toMatchObject({
        step: 'ssh',
        hint: expect.stringMatching(/single host/),
      });
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
