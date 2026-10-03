import {
  QuerybaraError,
  connectionProfileSchema,
  type ConnectionCheckResult,
  type ConnectionProfileInput,
  type ResolvedProfile,
} from '@querybara/core';
import { describe, expect, it } from 'vitest';

import { checkConnection, type MongoCheckDeps } from '../src';
import type { MongoDbSession } from '../src/session';

function resolved(
  input: Partial<ConnectionProfileInput> = {},
  secrets: Record<string, string> = {},
): ResolvedProfile {
  const profile = connectionProfileSchema.parse({
    id: 'p',
    name: 'Mongo',
    engine: 'mongodb',
    endpoint: { kind: 'host', host: 'db.example.com', port: 27017 },
    auth: { method: 'password', user: 'ada', password: { id: 'pw' } },
    tls: { mode: 'disable' },
    createdAt: '2026-09-29T10:00:00.000Z',
    updatedAt: '2026-09-29T10:00:00.000Z',
    ...input,
  });
  return { profile, secrets: { pw: 'hunter2', ...secrets } };
}

function fakeSession(): MongoDbSession {
  return {
    serverVersion: '8.0.4',
    topology: 'replicaSet',
    ping: async () => undefined,
    serverInfo: async () => ({
      version: '8.0.4',
      topology: 'replicaSet',
      setName: 'rs0',
      members: [{}, {}, {}],
      modules: [],
    }),
    close: async () => undefined,
  } as unknown as MongoDbSession;
}

const network: Partial<MongoCheckDeps> = {
  lookup: async (host) =>
    host.endsWith('.invalid')
      ? Promise.reject(Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }))
      : '10.0.0.5',
  probe: async () => undefined,
  now: () => 0,
  tlsHandshake: async () => undefined,
  resolveSrv: async () => [
    { host: 'shard-00.example.net', port: 27017 },
    { host: 'shard-01.example.net', port: 27017 },
  ],
  connect: async () => fakeSession(),
};

async function run(
  profile: ResolvedProfile,
  deps: Partial<MongoCheckDeps> = {},
): Promise<ConnectionCheckResult[]> {
  const out: ConnectionCheckResult[] = [];
  for await (const result of checkConnection(profile, { ...network, ...deps })) out.push(result);
  return out;
}

const statuses = (results: readonly ConnectionCheckResult[]) =>
  results.map((r) => `${r.step}:${r.status}`);

describe('MongoDB Test Connection', () => {
  it('runs every step and describes the topology', async () => {
    const results = await run(resolved({ tls: { mode: 'verify-full' } }));
    expect(statuses(results)).toEqual([
      'dns:ok',
      'tcp:ok',
      'ssh:skipped',
      'tls:ok',
      'auth:ok',
      'ping:ok',
      'version:ok',
    ]);
    expect(results[0]!.message).toBe('db.example.com → 10.0.0.5');
    expect(results[4]!.message).toBe('Logged in as ada');
    expect(results[6]!.message).toBe('MongoDB 8.0.4, replica set rs0 (3 members)');
  });

  it('resolves the SRV record of a mongodb+srv name', async () => {
    const results = await run(
      resolved({
        endpoint: { kind: 'srv', host: 'cluster0.example.net' },
        tls: { mode: 'verify-full' },
      }),
    );
    expect(results[0]).toMatchObject({
      status: 'ok',
      message:
        'SRV cluster0.example.net lists shard-00.example.net:27017, shard-01.example.net:27017',
    });
    const failed = await run(
      resolved({ endpoint: { kind: 'srv', host: 'cluster0.example.net' } }),
      {
        resolveSrv: () =>
          Promise.reject(Object.assign(new Error('queryDns ENOTFOUND'), { code: 'ENOTFOUND' })),
      },
    );
    expect(failed[0]).toMatchObject({
      step: 'dns',
      status: 'failed',
      hint: expect.stringContaining('SRV record'),
    });
    expect(statuses(failed).slice(1)).toEqual([
      'tcp:skipped',
      'ssh:skipped',
      'tls:skipped',
      'auth:skipped',
      'ping:skipped',
      'version:skipped',
    ]);
  });

  it('fails DNS only when no seed resolves, and TCP only when none is reachable', async () => {
    const list = resolved({
      endpoint: {
        kind: 'hosts',
        hosts: [
          { host: 'a.invalid', port: 1 },
          { host: 'b.example.com', port: 2 },
        ],
        replicaSet: 'rs0',
      },
    });
    const partial = await run(list);
    expect(partial[0]).toMatchObject({
      status: 'ok',
      message: 'b.example.com → 10.0.0.5; not resolved: a.invalid',
    });
    const none = await run(resolved({ endpoint: { kind: 'host', host: 'x.invalid', port: 1 } }));
    expect(none[0]).toMatchObject({
      step: 'dns',
      status: 'failed',
      hint: expect.stringContaining('host name'),
    });
    const refused = await run(resolved(), {
      probe: () =>
        Promise.reject(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })),
    });
    expect(refused[1]).toMatchObject({
      step: 'tcp',
      status: 'failed',
      message: 'Connection to db.example.com:27017 was refused',
    });
  });

  it('names TLS failures with a hint', async () => {
    const results = await run(resolved({ tls: { mode: 'verify-full' } }), {
      tlsHandshake: () =>
        Promise.reject(
          Object.assign(new Error('Hostname/IP does not match certificate'), {
            code: 'ERR_TLS_CERT_ALTNAME_INVALID',
          }),
        ),
    });
    expect(results[3]).toMatchObject({
      step: 'tls',
      status: 'failed',
      hint: expect.stringContaining('TLS server name'),
    });
  });

  it('fails auth with the driver error and never echoes the password', async () => {
    const results = await run(resolved(), {
      connect: () =>
        Promise.reject(
          new QuerybaraError({
            code: 'AUTH_FAILED',
            message: 'Authentication failed for hunter2',
            hint: 'Check the user name and password',
          }),
        ),
    });
    expect(results[4]).toMatchObject({
      step: 'auth',
      status: 'failed',
      hint: 'Check the user name and password',
    });
    expect(JSON.stringify(results)).not.toContain('hunter2');
  });

  it('diagnoses a replica set name mismatch and unreachable advertised members', async () => {
    const selection = new QuerybaraError({
      code: 'CONNECTION_FAILED',
      message: 'No member answered',
    });
    const mismatch = await run(
      resolved({
        endpoint: {
          kind: 'hosts',
          hosts: [{ host: 'db.example.com', port: 27017 }],
          replicaSet: 'prod',
        },
      }),
      {
        connect: () => Promise.reject(selection),
        hello: async () => ({ setName: 'rs0', hosts: ['db.example.com:27017'] }),
      },
    );
    expect(mismatch[4]).toMatchObject({
      step: 'auth',
      message: 'db.example.com:27017 belongs to replica set "rs0", not "prod"',
      hint: 'Set the replica set name to "rs0"',
    });
    const advertised = await run(resolved(), {
      connect: () => Promise.reject(selection),
      hello: async () => ({ setName: 'rs0', hosts: ['mongo1:27017', 'mongo2:27017'] }),
    });
    expect(advertised[4]).toMatchObject({
      message: expect.stringContaining('advertises its members as mongo1:27017, mongo2:27017'),
      hint: expect.stringContaining('Direct connection'),
    });
  });

  it('runs the SSH step through the injected transport, and refuses tunnels without one', async () => {
    const ssh = {
      hops: [
        { host: 'bastion.example.com', port: 22, user: 'me', auth: { method: 'agent' as const } },
      ],
      keepAliveIntervalMs: 0,
    };
    const closed: string[] = [];
    const through = await run(resolved({ ssh }), {
      runSshStep: async () => ({
        result: {
          step: 'ssh',
          status: 'ok',
          durationMs: 1,
          message: 'SSH me@bastion.example.com:22 → db.example.com:27017',
        },
        transport: {
          endpointOverride: { host: '127.0.0.1', port: 40000 },
          close: async () => void closed.push('closed'),
        },
      }),
    });
    expect(statuses(through)).toEqual([
      'dns:ok',
      'tcp:ok',
      'ssh:ok',
      'tls:skipped',
      'auth:ok',
      'ping:ok',
      'version:ok',
    ]);
    expect(through[0]!.message).toBe('The SSH server bastion.example.com resolves to 10.0.0.5');
    expect(closed).toEqual(['closed']);

    const without = await run(resolved({ ssh }));
    expect(without[2]).toMatchObject({
      step: 'ssh',
      status: 'failed',
      hint: expect.stringContaining('connection host'),
    });

    const list = await run(
      resolved({
        ssh,
        endpoint: {
          kind: 'hosts',
          hosts: [
            { host: 'a', port: 1 },
            { host: 'b', port: 2 },
          ],
        },
      }),
      {
        runSshStep: async () => ({
          result: { step: 'ssh', status: 'ok', durationMs: 1 },
          transport: {
            endpointOverride: { host: '127.0.0.1', port: 40000 },
            close: async () => undefined,
          },
        }),
      },
    );
    // A host list needs the transport's node route, not only one forwarded host.
    expect(list.find((r) => r.status === 'failed')).toMatchObject({
      step: 'tls',
      hint: expect.stringContaining('every member through the tunnel'),
    });
  });

  it('checks a replica set behind a tunnel through its node route', async () => {
    const ssh = {
      hops: [{ host: '10.1.1.1', port: 22, user: 'me', auth: { method: 'agent' as const } }],
      keepAliveIntervalMs: 0,
    };
    const forwarded: string[] = [];
    const handshakes: { host: string; port: number; servername?: string }[] = [];
    const connected: ResolvedProfile[] = [];
    const nodes = {
      socks5: { host: '127.0.0.1', port: 41000, user: 'querybara-x', password: 'route-secret' },
      forward: async (target: { host: string; port: number }) => {
        forwarded.push(`${target.host}:${target.port}`);
        return { host: '127.0.0.1', port: 42000 };
      },
      forwardNow: () => undefined,
      reserve: async () => undefined,
      forwardCount: 0,
      channelCount: 0,
    };
    const results = await run(
      resolved({
        ssh,
        tls: { mode: 'verify-full' },
        endpoint: { kind: 'srv', host: 'cluster0.example.net' },
      }),
      {
        runSshStep: async () => ({
          result: { step: 'ssh', status: 'ok', durationMs: 1, message: 'SSH me@10.1.1.1:22 → …' },
          transport: {
            endpointOverride: { host: '127.0.0.1', port: 40000 },
            nodes,
            close: async () => undefined,
          },
        }),
        tlsHandshake: async (target, options) => {
          handshakes.push({
            ...target,
            ...(options.servername ? { servername: options.servername } : {}),
          });
        },
        connect: async (profile) => {
          connected.push(profile);
          return fakeSession();
        },
      },
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
    // The TLS step went to the first server the SRV record lists, through a forward, by its name.
    expect(forwarded).toEqual(['shard-00.example.net:27017']);
    expect(handshakes).toEqual([
      { host: '127.0.0.1', port: 42000, servername: 'shard-00.example.net' },
    ]);
    // The session was opened with the route, so the driver goes through its SOCKS endpoint.
    expect(connected[0]).toHaveProperty('nodeRoute', nodes);
    expect(results[6]!.message).toContain('replica set rs0 (3 members)');
    expect(JSON.stringify(results)).not.toContain('route-secret');
  });
});
