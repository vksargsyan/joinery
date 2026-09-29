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

describe('checkConnection through a tunnel (runSshStep)', () => {
  const ssh = {
    hops: [{ host: 'bastion.example.com', user: 'me', auth: { method: 'agent' as const } }],
  };

  function tunnel(status: 'ok' | 'failed' = 'ok') {
    const state = { closed: 0, calls: 0 };
    const runSshStep: CheckConnectionDeps['runSshStep'] = async () => {
      state.calls += 1;
      if (status === 'failed') {
        return {
          result: {
            step: 'ssh',
            status: 'failed',
            durationMs: 3,
            message: 'The SSH server bastion.example.com:22 rejected the password',
            hint: 'Check the SSH user name and password',
          },
        };
      }
      return {
        result: { step: 'ssh', status: 'ok', durationMs: 3, message: 'SSH me@bastion → db' },
        transport: {
          endpointOverride: { host: '127.0.0.1', port: 40123 },
          close: async () => {
            state.closed += 1;
          },
        },
      };
    };
    return { state, runSshStep };
  }

  it('checks the first hop, opens the tunnel, runs the driver steps through it and closes it', async () => {
    const { state, runSshStep } = tunnel();
    let seen: ResolvedProfile | undefined;
    const lookups: string[] = [];
    const results = await run(
      resolved({ ssh }),
      adapter(async () => fakeSession()),
      {
        ...okDeps,
        lookup: async (host) => {
          lookups.push(host);
          return '192.0.2.20';
        },
        runSshStep,
      },
    );
    expect(statuses(results)).toEqual([
      'dns:ok',
      'tcp:ok',
      'ssh:ok',
      'tls:ok',
      'auth:ok',
      'ping:ok',
      'version:ok',
    ]);
    expect(lookups).toEqual(['bastion.example.com']);
    expect(results[0]!.message).toContain('bastion.example.com');
    expect(results[2]!.message).toBe('SSH me@bastion → db');
    expect(state.closed).toBe(1);

    const connectSpy = adapter(async () => fakeSession());
    const original = connectSpy.connect;
    connectSpy.connect = async (profile) => {
      seen = profile;
      return original(profile);
    };
    await run(resolved({ ssh }), connectSpy, { ...okDeps, runSshStep });
    expect(seen?.endpointOverride).toEqual({ host: '127.0.0.1', port: 40123 });
    expect(seen?.profile.endpoint).toEqual({ kind: 'host', host: 'db.example.com', port: 5432 });
    expect(state.closed).toBe(2);
  });

  it('names a failing SSH step and skips the rest', async () => {
    const { runSshStep } = tunnel('failed');
    const results = await run(
      resolved({ ssh }),
      adapter(async () => fakeSession()),
      { ...okDeps, runSshStep },
    );
    expect(statuses(results)).toEqual([
      'dns:ok',
      'tcp:ok',
      'ssh:failed',
      'tls:skipped',
      'auth:skipped',
      'ping:skipped',
      'version:skipped',
    ]);
    expect(results[2]!.hint).toMatch(/password/);
  });

  it('does not open the tunnel when the first hop does not resolve', async () => {
    const { state, runSshStep } = tunnel();
    const results = await run(
      resolved({ ssh }),
      adapter(async () => fakeSession()),
      {
        ...okDeps,
        lookup: async () => {
          throw Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' });
        },
        runSshStep,
      },
    );
    expect(results[0]).toMatchObject({ step: 'dns', status: 'failed' });
    expect(results[0]!.message).toContain('bastion.example.com');
    expect(state.calls).toBe(0);
  });

  it('runs a proxy-only profile through the transport without the proxy', async () => {
    const { state, runSshStep } = tunnel();
    let seen: ResolvedProfile | undefined;
    const results = await run(
      resolved({ proxy: { kind: 'socks5', host: '10.0.0.5', port: 1080 } }),
      {
        ...adapter(async () => fakeSession()),
        connect: async (profile) => {
          seen = profile;
          return fakeSession();
        },
      },
      { ...okDeps, runSshStep },
    );
    expect(statuses(results)).toEqual([
      'dns:skipped',
      'tcp:ok',
      'ssh:ok',
      'tls:ok',
      'auth:ok',
      'ping:ok',
      'version:ok',
    ]);
    expect(seen?.profile.proxy).toBeUndefined();
    expect(seen?.endpointOverride).toEqual({ host: '127.0.0.1', port: 40123 });
    expect(state.closed).toBe(1);
  });

  it('closes the transport when authentication fails', async () => {
    const { state, runSshStep } = tunnel();
    const results = await run(
      resolved({ ssh }),
      adapter(async () => {
        throw new JoineryError({ code: 'AUTH_FAILED', message: 'password authentication failed' });
      }),
      { ...okDeps, runSshStep },
    );
    expect(statuses(results).slice(2, 5)).toEqual(['ssh:ok', 'tls:ok', 'auth:failed']);
    expect(state.closed).toBe(1);
  });

  it('accepts partial deps', async () => {
    const results: ConnectionCheckResult[] = [];
    for await (const result of checkConnection(
      resolved({ endpoint: { kind: 'host', host: '10.1.2.3', port: 5432 } }),
      adapter(async () => fakeSession()),
      { probe: async () => undefined },
    )) {
      results.push(result);
    }
    expect(statuses(results)[1]).toBe('tcp:ok');
  });
});
