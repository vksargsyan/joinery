import {
  JoineryError,
  capabilitiesFor,
  type ConnectionCheckResult,
  type DriverAdapter,
  type ResolvedProfile,
  type Session,
} from '@joinery/core';
import { describe, expect, it } from 'vitest';

import { checkConnection, type CheckConnectionDeps } from '../src';
import { resolved } from './fixtures';

function fakeSession(
  ping: () => Promise<void> = async () => undefined,
): Session & { closed: boolean } {
  const session = {
    engine: 'postgres' as const,
    serverVersion: '16.4',
    inTransaction: false,
    closed: false,
    capabilities: () => capabilitiesFor('postgres'),
    execute: () => ({ [Symbol.asyncIterator]: async function* () {} }),
    cancel: async () => undefined,
    introspect: async () => {
      throw new Error('unused');
    },
    browse: async () => [],
    ping,
    close: async () => {
      session.closed = true;
    },
  };
  return session;
}

function adapter(connect: () => Promise<Session>): DriverAdapter {
  return { engine: 'postgres', capabilities: () => capabilitiesFor('postgres'), connect };
}

const okDeps: CheckConnectionDeps = {
  lookup: async () => '192.0.2.10',
  probe: async () => undefined,
  now: () => 0,
};

async function run(
  profile: ResolvedProfile,
  driver: DriverAdapter,
  deps: CheckConnectionDeps = okDeps,
): Promise<ConnectionCheckResult[]> {
  const results: ConnectionCheckResult[] = [];
  for await (const result of checkConnection(profile, driver, deps)) results.push(result);
  return results;
}

const statuses = (results: ConnectionCheckResult[]) => results.map((r) => `${r.step}:${r.status}`);

describe('checkConnection', () => {
  it('runs every step in order and closes the session', async () => {
    const session = fakeSession();
    const results = await run(
      resolved(),
      adapter(async () => session),
    );
    expect(statuses(results)).toEqual([
      'dns:ok',
      'tcp:ok',
      'ssh:skipped',
      'tls:ok',
      'auth:ok',
      'ping:ok',
      'version:ok',
    ]);
    expect(results[0]!.message).toContain('192.0.2.10');
    expect(results.at(-1)!.message).toBe('PostgreSQL 16.4');
    expect(session.closed).toBe(true);
  });

  it('names a DNS failure and skips the rest', async () => {
    const deps = {
      ...okDeps,
      lookup: async () => {
        throw Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' });
      },
    };
    const results = await run(
      resolved(),
      adapter(async () => fakeSession()),
      deps,
    );
    expect(results[0]).toMatchObject({ step: 'dns', status: 'failed', hint: expect.any(String) });
    expect(results.slice(1).every((r) => r.status === 'skipped')).toBe(true);
    expect(results).toHaveLength(7);
  });

  it('names a TCP failure', async () => {
    const deps = {
      ...okDeps,
      probe: async () => {
        throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
      },
    };
    const results = await run(
      resolved(),
      adapter(async () => fakeSession()),
      deps,
    );
    expect(statuses(results).slice(0, 2)).toEqual(['dns:ok', 'tcp:failed']);
    expect(results[1]!.hint).toMatch(/running/);
  });

  it('tells TLS failures from authentication failures', async () => {
    const tlsFailure = await run(
      resolved(),
      adapter(async () => {
        throw new JoineryError({ code: 'TLS_FAILED', message: 'self-signed', hint: 'set the CA' });
      }),
    );
    expect(tlsFailure.find((r) => r.status === 'failed')).toMatchObject({
      step: 'tls',
      hint: 'set the CA',
    });

    const authFailure = await run(
      resolved(),
      adapter(async () => {
        throw new JoineryError({ code: 'AUTH_FAILED', message: 'password authentication failed' });
      }),
    );
    expect(statuses(authFailure).slice(3, 5)).toEqual(['tls:ok', 'auth:failed']);
  });

  it('skips DNS for IP addresses and TLS when it is disabled', async () => {
    const profile = resolved({
      endpoint: { kind: 'host', host: '10.1.2.3', port: 5432 },
      tls: { mode: 'disable' },
    });
    const results = await run(
      profile,
      adapter(async () => fakeSession()),
    );
    expect(statuses(results)).toEqual([
      'dns:skipped',
      'tcp:ok',
      'ssh:skipped',
      'tls:skipped',
      'auth:ok',
      'ping:ok',
      'version:ok',
    ]);
  });

  it('fails the SSH step when a tunnel is configured but not open, and passes it through the tunnel', async () => {
    const ssh = { hops: [{ host: 'bastion', user: 'me', auth: { method: 'agent' as const } }] };
    const closed = await run(
      resolved({ ssh }),
      adapter(async () => fakeSession()),
    );
    expect(statuses(closed)).toEqual([
      'dns:skipped',
      'tcp:skipped',
      'ssh:failed',
      'tls:skipped',
      'auth:skipped',
      'ping:skipped',
      'version:skipped',
    ]);
    const open = await run(
      resolved({ ssh }, undefined, { host: '127.0.0.1', port: 40000 }),
      adapter(async () => fakeSession()),
    );
    expect(open.find((r) => r.step === 'ssh')).toMatchObject({
      status: 'ok',
      message: 'Tunnel open at 127.0.0.1:40000',
    });
  });

  it('reports a failing ping and still closes the session', async () => {
    const session = fakeSession(async () => {
      throw new JoineryError({ code: 'CONNECTION_FAILED', message: 'gone' });
    });
    const results = await run(
      resolved(),
      adapter(async () => session),
    );
    expect(statuses(results).slice(5)).toEqual(['ping:failed', 'version:skipped']);
    expect(session.closed).toBe(true);
  });
});
