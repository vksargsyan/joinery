import {
  JoineryError,
  capabilitiesFor,
  type ConnectionCheckResult,
  type DriverAdapter,
  type ResolvedProfile,
  type Session,
} from '@joinery/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  MemoryKnownHosts,
  TransportManager,
  checkConnectionThroughTransport,
  connectThroughTransport,
  knownHostsVerifier,
  runSshStep,
} from '../src';
import { echo, hop, resolvedWith, until } from './helpers/profiles';
import {
  startEchoServer,
  startSshServer,
  type TcpServer,
  type TestSshServer,
} from './helpers/servers';

const PASSWORD = 'bastion-password';

let target: TcpServer;
let server: TestSshServer;
let strict: TestSshServer;
let manager: TransportManager;

beforeAll(async () => {
  target = await startEchoServer();
  server = await startSshServer({ users: { tunnel: { password: PASSWORD } } });
  strict = await startSshServer({
    users: { tunnel: { password: PASSWORD } },
    forwarding: 'prohibit',
  });
  const known = new MemoryKnownHosts(
    [server, strict].map((s) => ({
      host: '127.0.0.1',
      port: s.port,
      algorithm: s.hostKeyAlgorithm,
      fingerprintSha256: s.hostKeyFingerprint,
    })),
  );
  manager = new TransportManager({ hostKeyVerifier: knownHostsVerifier(known, 'reject') });
});
afterAll(async () => {
  manager.closeAll();
  await Promise.all([target.close(), server.close(), strict.close()]);
});

function tunnelled(sshPort = server.port, password = PASSWORD): ResolvedProfile {
  return resolvedWith(
    {
      endpoint: { kind: 'host', host: '127.0.0.1', port: target.port },
      ssh: { hops: [hop(sshPort, { method: 'password', password: { id: 'pw' } })] },
    },
    { pw: password },
  );
}

/** A driver whose sessions prove the path with an echo; it records what it was given. */
function echoAdapter(): DriverAdapter & { seen: ResolvedProfile[] } {
  const seen: ResolvedProfile[] = [];
  return {
    engine: 'postgres',
    seen,
    capabilities: () => capabilitiesFor('postgres'),
    async connect(resolved) {
      seen.push(resolved);
      const endpoint =
        resolved.endpointOverride ??
        (resolved.profile.endpoint.kind === 'host' ? resolved.profile.endpoint : undefined);
      if (!endpoint) throw new Error('no endpoint');
      const reply = await echo(endpoint, 'hello');
      if (reply !== 'hello') {
        throw new JoineryError({ code: 'CONNECTION_FAILED', message: 'Connection terminated' });
      }
      const session: Session = {
        engine: 'postgres',
        serverVersion: '16.4',
        inTransaction: false,
        capabilities: () => capabilitiesFor('postgres'),
        execute: () => ({ [Symbol.asyncIterator]: async function* () {} }),
        cancel: async () => undefined,
        introspect: async () => {
          throw new Error('unused');
        },
        browse: async () => [],
        ping: async () => {
          if ((await echo(endpoint, 'ping')) !== 'ping') throw new Error('ping failed');
        },
        close: async () => undefined,
      };
      return session;
    },
  };
}

async function collect(
  iterable: AsyncIterable<ConnectionCheckResult>,
): Promise<ConnectionCheckResult[]> {
  const results: ConnectionCheckResult[] = [];
  for await (const result of iterable) results.push(result);
  return results;
}

const statuses = (results: ConnectionCheckResult[]) => results.map((r) => `${r.step}:${r.status}`);

describe('runSshStep', () => {
  it('skips profiles without a tunnel or proxy', async () => {
    expect(await runSshStep(resolvedWith({}), manager)).toEqual({
      result: { step: 'ssh', status: 'skipped', durationMs: 0, message: 'No SSH tunnel or proxy' },
    });
  });

  it('opens the tunnel, proves the forward and hands over the transport', async () => {
    const outcome = await runSshStep(tunnelled(), manager);
    expect(outcome.result).toMatchObject({
      step: 'ssh',
      status: 'ok',
      message: `SSH tunnel@127.0.0.1:${server.port} → 127.0.0.1:${target.port}`,
    });
    expect(await echo(outcome.transport!.endpointOverride)).toBe('ping through the tunnel');
    await outcome.transport!.close();
    expect(manager.sessionCount).toBe(0);
  });

  it('fails with the reason and a hint, leaving nothing open', async () => {
    const wrong = await runSshStep(tunnelled(server.port, 'nope-not-it'), manager);
    expect(wrong.transport).toBeUndefined();
    expect(wrong.result).toMatchObject({
      step: 'ssh',
      status: 'failed',
      message: expect.stringContaining('rejected the password'),
      hint: 'Check the SSH user name and password',
    });
    expect(JSON.stringify(wrong)).not.toContain('nope-not-it');

    const refused = await runSshStep(tunnelled(strict.port), manager);
    expect(refused.result).toMatchObject({
      status: 'failed',
      hint: expect.stringContaining('AllowTcpForwarding'),
    });
    expect(manager.sessionCount).toBe(0);
    await until(() => strict.stats.active === 0);
  });
});

describe('checkConnectionThroughTransport', () => {
  it('runs every step through the tunnel and closes it afterwards', async () => {
    const adapter = echoAdapter();
    const results = await collect(checkConnectionThroughTransport(adapter, tunnelled(), manager));
    expect(statuses(results)).toEqual([
      'dns:skipped',
      'tcp:ok',
      'ssh:ok',
      'tls:skipped',
      'auth:ok',
      'ping:ok',
      'version:ok',
    ]);
    expect(results[1]!.message).toBe(`Connected to the SSH server 127.0.0.1:${server.port}`);
    expect(adapter.seen[0]!.endpointOverride?.host).toBe('127.0.0.1');
    expect(manager.sessionCount).toBe(0);
  });

  it('stops at a failing SSH step', async () => {
    const results = await collect(
      checkConnectionThroughTransport(echoAdapter(), tunnelled(strict.port), manager),
    );
    expect(statuses(results).slice(2)).toEqual([
      'ssh:failed',
      'tls:skipped',
      'auth:skipped',
      'ping:skipped',
      'version:skipped',
    ]);
  });

  it("uses the adapter's own check without a tunnel, and refuses what it cannot check", async () => {
    const own: ConnectionCheckResult[] = [
      { step: 'version', status: 'ok', durationMs: 0, message: 'own check' },
    ];
    const adapter: DriverAdapter = {
      ...echoAdapter(),
      checkConnection: async function* () {
        yield* own;
      },
    };
    expect(
      await collect(checkConnectionThroughTransport(adapter, resolvedWith({}), manager)),
    ).toEqual(own);
    await expect(
      collect(checkConnectionThroughTransport(echoAdapter(), resolvedWith({}), manager)),
    ).rejects.toMatchObject({ code: 'NOT_SUPPORTED' });
    const redis = resolvedWith({
      engine: 'redis',
      endpoint: { kind: 'host', host: '127.0.0.1', port: 6379 },
      proxy: { kind: 'http', host: '127.0.0.1', port: 3128 },
    });
    await expect(
      collect(checkConnectionThroughTransport(echoAdapter(), redis, manager)),
    ).rejects.toMatchObject({ code: 'NOT_SUPPORTED' });
  });
});

describe('connectThroughTransport', () => {
  it('opens a session through the tunnel and releases the tunnel with it', async () => {
    const adapter = echoAdapter();
    const { session, transport, close } = await connectThroughTransport(
      adapter,
      tunnelled(),
      manager,
    );
    expect(transport).toBeDefined();
    expect(adapter.seen[0]!.endpointOverride).toEqual(transport!.endpointOverride);
    await session.ping();
    expect(manager.sessionCount).toBe(1);
    await close();
    await close();
    expect(manager.sessionCount).toBe(0);
  });

  it("throws the tunnel's precise error when the driver fails because of it", async () => {
    await expect(
      connectThroughTransport(echoAdapter(), tunnelled(strict.port), manager),
    ).rejects.toMatchObject({ code: 'SSH_FAILED', engineCode: 'FORWARD_PROHIBITED' });
    expect(manager.sessionCount).toBe(0);
  });

  it('connects directly when the profile needs no transport', async () => {
    const adapter = echoAdapter();
    const direct = resolvedWith({
      endpoint: { kind: 'host', host: '127.0.0.1', port: target.port },
    });
    const { transport, close } = await connectThroughTransport(adapter, direct, manager);
    expect(transport).toBeUndefined();
    expect(adapter.seen[0]).toBe(direct);
    await close();
  });
});
