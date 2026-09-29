import {
  connectionProfileSchema,
  JoineryError,
  type ConnectionCheckResult,
  type ConnectionProfileInput,
  type DriverAdapter,
  type ResolvedProfile,
} from '@joinery/core';
import type { CheckConnectionDeps } from '@joinery/driver-sql-base';
import { describe, expect, it } from 'vitest';

import { checkRedisConnection } from '../src';
import type { RedisSession } from '../src';

const now = '2026-09-29T10:00:00.000Z';

function profile(input: Partial<ConnectionProfileInput>): ResolvedProfile {
  return {
    profile: connectionProfileSchema.parse({
      id: 'p',
      name: 'Redis',
      engine: 'redis',
      endpoint: { kind: 'host', host: 'cache.example.com', port: 6379 },
      tls: { mode: 'disable' },
      createdAt: now,
      updatedAt: now,
      ...input,
    }),
    secrets: {},
  };
}

function fakeAdapter(outcome: 'ok' | JoineryError): DriverAdapter {
  const session = {
    engine: 'redis',
    server: { flavor: 'valkey', version: '8.0.1', topology: 'cluster', role: 'master' },
    nodes: () => [{}, {}, {}],
    ping: async () => undefined,
    close: async () => undefined,
  } as unknown as RedisSession;
  return {
    engine: 'redis',
    capabilities: () => {
      throw new Error('unused');
    },
    connect: async () => {
      if (outcome !== 'ok') throw outcome;
      return session;
    },
  };
}

function deps(reachable: readonly string[], resolvable = true): Partial<CheckConnectionDeps> {
  let clock = 0;
  return {
    now: () => (clock += 5),
    lookup: async (host) => {
      if (!resolvable || host === 'bad.example')
        throw Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' });
      return '10.0.0.9';
    },
    probe: async (target) => {
      const where = target.kind === 'tcp' ? `${target.host}:${target.port}` : target.path;
      if (!reachable.includes(where))
        throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    },
  };
}

async function collect(
  iterable: AsyncIterable<ConnectionCheckResult>,
): Promise<ConnectionCheckResult[]> {
  const out: ConnectionCheckResult[] = [];
  for await (const step of iterable) out.push(step);
  return out;
}

describe('checkRedisConnection', () => {
  it('passes DNS and TCP when one cluster seed answers', async () => {
    const resolved = profile({
      endpoint: {
        kind: 'cluster',
        seeds: [
          { host: 'bad.example', port: 7000 },
          { host: 'n2.example', port: 7000 },
        ],
      },
    });
    const steps = await collect(
      checkRedisConnection(resolved, fakeAdapter('ok'), deps(['n2.example:7000'])),
    );
    expect(steps.map((s) => [s.step, s.status])).toEqual([
      ['dns', 'ok'],
      ['tcp', 'ok'],
      ['ssh', 'skipped'],
      ['tls', 'skipped'],
      ['auth', 'ok'],
      ['ping', 'ok'],
      ['version', 'ok'],
    ]);
    expect(steps[0]!.message).toMatch(/bad\.example does not resolve/);
    expect(steps[1]!.message).toMatch(/1 of 2 did not answer/);
    expect(steps[6]!.message).toBe('Valkey 8.0.1 (cluster of 3 primaries)');
  });

  it('fails TCP when no sentinel answers', async () => {
    const resolved = profile({
      endpoint: {
        kind: 'sentinel',
        sentinels: [{ host: '10.0.0.1', port: 26379 }],
        masterName: 'm',
      },
    });
    const steps = await collect(checkRedisConnection(resolved, fakeAdapter('ok'), deps([])));
    expect(steps.map((s) => [s.step, s.status])).toEqual([
      ['dns', 'skipped'],
      ['tcp', 'failed'],
      ['ssh', 'skipped'],
      ['tls', 'skipped'],
      ['auth', 'skipped'],
      ['ping', 'skipped'],
      ['version', 'skipped'],
    ]);
    expect(steps[1]!.hint).toMatch(/running/);
  });

  it('fails DNS when no host resolves', async () => {
    const steps = await collect(
      checkRedisConnection(profile({}), fakeAdapter('ok'), deps([], false)),
    );
    expect(steps[0]).toMatchObject({ step: 'dns', status: 'failed' });
  });

  it('tells TLS failures from auth failures', async () => {
    const tls = profile({ tls: { mode: 'verify-full' } });
    const reachable = deps(['cache.example.com:6379']);
    const tlsFailure = new JoineryError({
      code: 'TLS_FAILED',
      message: 'bad cert',
      hint: 'set the CA',
    });
    let steps = await collect(checkRedisConnection(tls, fakeAdapter(tlsFailure), reachable));
    expect(steps.find((s) => s.status === 'failed')).toMatchObject({
      step: 'tls',
      hint: 'set the CA',
    });
    const authFailure = new JoineryError({ code: 'AUTH_FAILED', message: 'no', hint: 'password' });
    steps = await collect(checkRedisConnection(tls, fakeAdapter(authFailure), reachable));
    expect(steps.map((s) => [s.step, s.status]).slice(3, 5)).toEqual([
      ['tls', 'ok'],
      ['auth', 'failed'],
    ]);
  });

  it('fails the SSH step for tunnelled Sentinel and Cluster profiles', async () => {
    const ssh = {
      hops: [{ host: '10.0.0.5', port: 22, user: 'u', auth: { method: 'agent' as const } }],
      keepAliveIntervalMs: 15000,
    };
    const resolved = profile({
      ssh,
      endpoint: { kind: 'cluster', seeds: [{ host: 'n1', port: 7000 }] },
    });
    const steps = await collect(
      checkRedisConnection(resolved, fakeAdapter('ok'), {
        ...deps(['10.0.0.5:22']),
        runSshStep: async () => {
          throw new Error('should not be called');
        },
      }),
    );
    expect(steps.find((s) => s.status === 'failed')).toMatchObject({
      step: 'ssh',
      hint: expect.stringMatching(/single host/),
    });
    const noRunner = await collect(
      checkRedisConnection(profile({ ssh }), fakeAdapter('ok'), deps(['10.0.0.5:22'])),
    );
    expect(noRunner.find((s) => s.status === 'failed')).toMatchObject({
      step: 'ssh',
      hint: expect.stringMatching(/from the app/),
    });
  });
});
