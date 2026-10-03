import { checkServerIdentity, type PeerCertificate } from 'node:tls';

import {
  connectionProfileSchema,
  QuerybaraError,
  type ConnectionProfileInput,
  type ResolvedProfile,
} from '@querybara/core';
import type { FileReader } from '@querybara/driver-sql-base';
import { describe, expect, it } from 'vitest';

import {
  buildRedisConnectionPlan,
  connectionNameFor,
  parseRedisUri,
  redactRedisUri,
  redisProfileFromUrl,
} from '../src';

const now = '2026-09-29T10:00:00.000Z';
const readFile: FileReader = (path) => Buffer.from(`contents of ${path}`);

function profile(
  input: Partial<ConnectionProfileInput> = {},
  secrets: Record<string, string> = { pw: 's3cret' },
  endpointOverride?: { host: string; port: number },
): ResolvedProfile {
  return {
    profile: connectionProfileSchema.parse({
      id: 'p',
      name: 'Redis',
      engine: 'redis',
      endpoint: { kind: 'host', host: 'cache.example.com', port: 6380 },
      auth: { method: 'password', password: { id: 'pw' } },
      tls: { mode: 'disable' },
      createdAt: now,
      updatedAt: now,
      ...input,
    }),
    secrets,
    ...(endpointOverride ? { endpointOverride } : {}),
  };
}

function thrown(fn: () => unknown): QuerybaraError {
  try {
    fn();
  } catch (error) {
    if (error instanceof QuerybaraError) return error;
    throw error;
  }
  throw new Error('Expected an error');
}

describe('parseRedisUri', () => {
  it.each([
    ['redis://cache:6380/2', { tls: false, host: 'cache', port: 6380, database: 2 }],
    [
      'rediss://app:p%40ss@cache.example.com',
      { tls: true, host: 'cache.example.com', user: 'app', password: 'p@ss' },
    ],
    ['redis://:onlypass@[::1]:7000', { tls: false, host: '::1', port: 7000, password: 'onlypass' }],
    ['redis://h?db=4', { tls: false, host: 'h', database: 4 }],
    ['valkeys://v', { tls: true, host: 'v' }],
    [
      'unix:///run/redis/redis.sock?db=1',
      { tls: false, socketPath: '/run/redis/redis.sock', database: 1 },
    ],
  ])('%s', (uri, expected) => {
    expect(parseRedisUri(uri)).toEqual(expected);
  });

  it('rejects other schemes and bad databases without echoing the URI', () => {
    const scheme = thrown(() => parseRedisUri('postgres://u:secret@h/db'));
    expect(scheme.code).toBe('VALIDATION_FAILED');
    expect(scheme.message).not.toContain('secret');
    expect(thrown(() => parseRedisUri('redis://h/notanumber')).message).toMatch(
      /not a logical database/,
    );
    expect(thrown(() => parseRedisUri('cache:6379')).message).toMatch(/no scheme/);
  });

  it('redacts passwords', () => {
    expect(redactRedisUri('redis://app:s3cret@h:6379/1')).toBe('redis://app@h:6379/1');
    expect(redactRedisUri('rediss://:s3cret@h')).toBe('rediss://h');
    expect(redactRedisUri('redis://h:6379')).toBe('redis://h:6379');
  });
});

describe('buildRedisConnectionPlan', () => {
  it('maps a host endpoint, credentials and options', () => {
    const plan = buildRedisConnectionPlan(
      profile({
        auth: { method: 'password', user: 'app', password: { id: 'pw' } },
        options: {
          connectTimeoutMs: 5000,
          queryTimeoutMs: 30000,
          defaultDatabase: '3',
          applicationName: 'My Querybara app',
          keepAlive: false,
        },
      }),
    );
    expect(plan).toMatchObject({
      topology: 'standalone',
      target: { kind: 'tcp', host: 'cache.example.com', port: 6380 },
      user: 'app',
      password: 's3cret',
      database: 3,
      connectTimeoutMs: 5000,
      commandTimeoutMs: 30000,
      keepAlive: false,
      connectionName: 'My-Querybara-app',
      where: 'cache.example.com:6380',
      tunnelled: false,
    });
    expect(plan.tlsOptions).toBeUndefined();
  });

  it('takes passwords only from the secrets, and the URI user and database as fallbacks', () => {
    const fromUri = buildRedisConnectionPlan(
      profile({
        endpoint: { kind: 'uri', uri: 'redis://olduser:oldpass@h:7000/5' },
        auth: { method: 'password', password: { id: 'pw' } },
      }),
    );
    expect(fromUri).toMatchObject({
      user: 'olduser',
      password: 's3cret',
      database: 5,
      target: { host: 'h', port: 7000 },
    });
    const uriPassword = buildRedisConnectionPlan(
      profile({
        endpoint: { kind: 'uri', uri: 'redis://:frompaste@h' },
        auth: { method: 'password' },
      }),
    );
    expect(uriPassword.password).toBeUndefined();
    const none = buildRedisConnectionPlan(
      profile({ endpoint: { kind: 'uri', uri: 'redis://:x@h' }, auth: { method: 'none' } }),
    );
    expect(none.password).toBeUndefined();
    expect(
      buildRedisConnectionPlan(
        profile({
          endpoint: { kind: 'uri', uri: 'redis://h/5' },
          options: { defaultDatabase: '1' },
        }),
      ).database,
    ).toBe(1);
  });

  it('fails AUTH_FAILED when the password secret was not unsealed', () => {
    const error = thrown(() => buildRedisConnectionPlan(profile({}, {})));
    expect(error.code).toBe('AUTH_FAILED');
  });

  it('maps socket, Sentinel and Cluster endpoints', () => {
    expect(
      buildRedisConnectionPlan(profile({ endpoint: { kind: 'socket', path: '/tmp/r.sock' } })),
    ).toMatchObject({
      target: { kind: 'socket', path: '/tmp/r.sock' },
      where: '/tmp/r.sock',
    });
    const sentinel = buildRedisConnectionPlan(
      profile({
        endpoint: {
          kind: 'sentinel',
          sentinels: [
            { host: 's1', port: 26379 },
            { host: 's2', port: 26379 },
          ],
          masterName: 'mymaster',
        },
        options: { defaultDatabase: '2' },
      }),
    );
    expect(sentinel).toMatchObject({ topology: 'sentinel', masterName: 'mymaster', database: 2 });
    expect(sentinel.seeds).toHaveLength(2);
    expect(sentinel.where).toBe('master "mymaster" via Sentinel s1:26379, s2:26379');
    const cluster = buildRedisConnectionPlan(
      profile({
        endpoint: { kind: 'cluster', seeds: [{ host: 'n1', port: 7000 }] },
        options: { defaultDatabase: '4' },
      }),
    );
    expect(cluster).toMatchObject({
      topology: 'cluster',
      database: 0,
      where: 'cluster seeds n1:7000',
    });
  });

  it('maps the four TLS modes, with CA, client certificate and SNI', () => {
    const base = { caPath: '/ca.pem', certPath: '/cert.pem', keyPath: '/key.pem' };
    const full = buildRedisConnectionPlan(
      profile({ tls: { mode: 'verify-full', ...base, servername: 'redis.internal' } }),
      { readFile },
    );
    expect(full.tlsOptions).toMatchObject({
      rejectUnauthorized: true,
      servername: 'redis.internal',
      ca: Buffer.from('contents of /ca.pem'),
      cert: Buffer.from('contents of /cert.pem'),
      key: Buffer.from('contents of /key.pem'),
    });
    const ca = buildRedisConnectionPlan(profile({ tls: { mode: 'verify-ca', ...base } }), {
      readFile,
    });
    expect(ca.tlsOptions).toMatchObject({ rejectUnauthorized: true });
    expect(ca.tlsOptions!.checkServerIdentity!('other', {} as PeerCertificate)).toBeUndefined();
    const require = buildRedisConnectionPlan(profile({ tls: { mode: 'require' } }), { readFile });
    expect(require.tlsOptions).toMatchObject({ rejectUnauthorized: false });
    expect(
      buildRedisConnectionPlan(profile({ tls: { mode: 'disable', ...base } }), { readFile })
        .tlsOptions,
    ).toBeUndefined();
  });

  it('turns TLS on for rediss:// and checks each node of a cluster against its own host', () => {
    const rediss = buildRedisConnectionPlan(
      profile({ endpoint: { kind: 'uri', uri: 'rediss://h' }, tls: { mode: 'disable' } }),
    );
    expect(rediss.tls.mode).toBe('verify-full');
    expect(rediss.tlsOptions).toMatchObject({ rejectUnauthorized: true, servername: 'h' });
    const cluster = buildRedisConnectionPlan(
      profile({
        endpoint: {
          kind: 'cluster',
          seeds: [
            { host: 'n1', port: 7000 },
            { host: 'n2', port: 7000 },
          ],
        },
        tls: { mode: 'verify-full' },
      }),
    );
    expect(cluster.tlsOptions).toMatchObject({ rejectUnauthorized: true });
    expect(cluster.tlsOptions!.servername).toBeUndefined();
    expect(cluster.tlsOptions!.checkServerIdentity).toBeUndefined();
    expect(checkServerIdentity).toBeDefined();
  });

  it('connects to the tunnel but verifies the real host', () => {
    const plan = buildRedisConnectionPlan(
      profile(
        {
          tls: { mode: 'verify-full' },
          ssh: {
            hops: [{ host: 'bastion', port: 22, user: 'u', auth: { method: 'agent' } }],
            keepAliveIntervalMs: 15000,
          },
        },
        { pw: 'x' },
        { host: '127.0.0.1', port: 50000 },
      ),
    );
    expect(plan.target).toEqual({
      kind: 'tcp',
      host: '127.0.0.1',
      port: 50000,
      tlsHost: 'cache.example.com',
    });
    expect(plan.tlsOptions).toMatchObject({ servername: 'cache.example.com' });
    expect(plan).toMatchObject({
      tunnelled: true,
      where: 'cache.example.com:6380 (through the tunnel)',
    });
  });

  it('refuses tunnels it cannot use', () => {
    const ssh = {
      hops: [{ host: 'bastion', port: 22, user: 'u', auth: { method: 'agent' as const } }],
      keepAliveIntervalMs: 15000,
    };
    expect(thrown(() => buildRedisConnectionPlan(profile({ ssh }))).message).toMatch(
      /no tunnel is open/,
    );
    const sentinel = thrown(() =>
      buildRedisConnectionPlan(
        profile(
          {
            ssh,
            endpoint: {
              kind: 'sentinel',
              sentinels: [{ host: 's', port: 26379 }],
              masterName: 'm',
            },
          },
          { pw: 'x' },
          { host: '127.0.0.1', port: 1 },
        ),
      ),
    );
    // Sentinel behind a tunnel needs the tunnel's node route, not only one forwarded host.
    expect(sentinel.code).toBe('NOT_SUPPORTED');
    expect(sentinel.hint).toMatch(/connection host/);
    const socket = thrown(() =>
      buildRedisConnectionPlan(
        profile(
          { ssh, endpoint: { kind: 'uri', uri: 'unix:///tmp/r.sock' } },
          { pw: 'x' },
          { host: '127.0.0.1', port: 1 },
        ),
      ),
    );
    expect(socket.message).toMatch(/Unix socket/);
  });

  it('keeps the Sentinels and cluster seeds behind a tunnel, reached through its node route', () => {
    const ssh = {
      hops: [{ host: 'bastion', port: 22, user: 'u', auth: { method: 'agent' as const } }],
      keepAliveIntervalMs: 15000,
    };
    const nodeRoute = {
      socks5: { host: '127.0.0.1', port: 1, user: 'u', password: 'p' },
      forward: async () => ({ host: '127.0.0.1', port: 2 }),
      forwardNow: () => undefined,
      reserve: async () => undefined,
      forwardCount: 0,
      channelCount: 0,
    };
    const routed = (endpoint: ConnectionProfileInput['endpoint']) =>
      buildRedisConnectionPlan({
        ...profile({ ssh, endpoint }, { pw: 'x' }, { host: '127.0.0.1', port: 1 }),
        nodeRoute,
      } as ResolvedProfile);
    const sentinel = routed({
      kind: 'sentinel',
      sentinels: [{ host: 's1.internal', port: 26379 }],
      masterName: 'm',
    });
    expect(sentinel).toMatchObject({
      topology: 'sentinel',
      tunnelled: true,
      nodeRoute,
      seeds: [{ kind: 'tcp', host: 's1.internal', port: 26379 }],
      where: 'master "m" via Sentinel s1.internal:26379 (through the tunnel)',
    });
    const cluster = routed({ kind: 'cluster', seeds: [{ host: 'c1.internal', port: 7000 }] });
    expect(cluster).toMatchObject({ topology: 'cluster', tunnelled: true, nodeRoute });
    expect(cluster.seeds).toEqual([
      { kind: 'tcp', host: 'c1.internal', port: 7000, tlsHost: 'c1.internal' },
    ]);
  });

  it('refuses other engines and auth methods', () => {
    const other = { ...profile(), profile: { ...profile().profile, engine: 'postgres' as const } };
    expect(thrown(() => buildRedisConnectionPlan(other)).code).toBe('VALIDATION_FAILED');
    expect(
      thrown(() =>
        buildRedisConnectionPlan(profile({ auth: { method: 'apiKey', apiKey: { id: 'k' } } })),
      ).code,
    ).toBe('NOT_SUPPORTED');
    expect(
      thrown(() => buildRedisConnectionPlan(profile({ auth: { method: 'clientCertificate' } })))
        .code,
    ).toBe('VALIDATION_FAILED');
    expect(
      thrown(() => buildRedisConnectionPlan(profile({ options: { defaultDatabase: 'x' } }))).code,
    ).toBe('VALIDATION_FAILED');
  });
});

describe('helpers', () => {
  it('sanitises connection names', () => {
    expect(connectionNameFor('Querybara')).toBe('Querybara');
    expect(connectionNameFor(' My app\n2 ')).toBe('My-app-2');
    expect(connectionNameFor('  ')).toBe('Querybara');
  });

  it('builds test profiles from URLs', () => {
    const resolved = redisProfileFromUrl('rediss://app:pw@127.0.0.1:6380/2');
    expect(resolved.profile).toMatchObject({
      engine: 'redis',
      endpoint: { kind: 'host', host: '127.0.0.1', port: 6380 },
      auth: { method: 'password', user: 'app', password: { id: 'password' } },
      tls: { mode: 'verify-full' },
      options: { defaultDatabase: '2' },
    });
    expect(resolved.secrets).toEqual({ password: 'pw' });
    expect(redisProfileFromUrl('redis://h').profile.auth).toEqual({ method: 'none' });
  });
});
