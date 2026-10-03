import {
  connectionProfileSchema,
  type ConnectionCheckResult,
  type ConnectionProfileInput,
  type ResolvedProfile,
} from '@querybara/core';
import { describe, expect, it } from 'vitest';

import {
  checkSearchConnection,
  parsePublishAddress,
  type HttpRequest,
  type HttpResponse,
  type SearchCheckDeps,
} from '../src';

/** Test Connection's step logic with the network faked. */

function resolved(input: Partial<ConnectionProfileInput> = {}, secrets = {}): ResolvedProfile {
  return {
    profile: connectionProfileSchema.parse({
      id: 'p',
      name: 'Search',
      engine: 'elasticsearch',
      endpoint: { kind: 'urls', urls: ['https://es.example.com:9200'] },
      auth: { method: 'password', user: 'elastic', password: { id: 'pw' } },
      createdAt: '2026-09-29T10:00:00.000Z',
      updatedAt: '2026-09-29T10:00:00.000Z',
      ...input,
    }),
    secrets: { pw: 'top-secret', ...secrets },
  };
}

const ROOT = JSON.stringify({
  name: 'es1',
  cluster_name: 'prod',
  version: { number: '8.19.3', build_flavor: 'default' },
  tagline: 'You Know, for Search',
});

function fakeDeps(
  routes: Record<string, [number, string]>,
  extra: Partial<SearchCheckDeps> = {},
): Partial<SearchCheckDeps> {
  return {
    lookup: async () => '10.0.0.5',
    probe: async () => undefined,
    tlsHandshake: async () => undefined,
    now: () => 0,
    client: () => ({
      request: async (request: HttpRequest): Promise<HttpResponse> => {
        const [status, body] = routes[`${request.method} ${request.path}`] ?? [404, '{}'];
        return {
          status,
          body,
          headers: {},
          truncated: false,
          durationMs: 1,
          node: {
            protocol: 'https:',
            host: 'es.example.com',
            port: 9200,
            hostHeader: 'es.example.com:9200',
            pathPrefix: '',
            label: 'https://es.example.com:9200',
          },
        };
      },
      close: () => undefined,
    }),
    ...extra,
  };
}

async function run(
  profile: ResolvedProfile,
  deps: Partial<SearchCheckDeps>,
): Promise<ConnectionCheckResult[]> {
  const results: ConnectionCheckResult[] = [];
  for await (const result of checkSearchConnection(profile, deps)) results.push(result);
  return results;
}

const HEALTHY: Record<string, [number, string]> = {
  'GET /': [200, ROOT],
  'GET /_security/_authenticate': [
    200,
    '{"username":"elastic","authentication_realm":{"name":"native1"}}',
  ],
  'GET /_cluster/health': [200, '{"status":"green","number_of_nodes":3}'],
  'GET /_license': [200, '{"license":{"type":"platinum","status":"active"}}'],
  'GET /_cat/plugins': [200, '[]'],
};

describe('checkSearchConnection', () => {
  it('reports every step of a healthy cluster', async () => {
    const results = await run(resolved(), fakeDeps(HEALTHY));
    expect(results.map((r) => [r.step, r.status, r.message])).toEqual([
      ['dns', 'ok', 'es.example.com → 10.0.0.5'],
      ['tcp', 'ok', 'Connected to es.example.com:9200'],
      ['ssh', 'skipped', 'No SSH tunnel'],
      ['tls', 'ok', 'Encrypted; certificate and host name verified'],
      ['auth', 'ok', 'Signed in as elastic (realm native1)'],
      ['ping', 'ok', 'Cluster health green, 3 nodes'],
      ['version', 'ok', 'Elasticsearch 8.19.3 (platinum licence, ES|QL, SQL), cluster "prod"'],
    ]);
  });

  it('fails the auth step with a hint and skips the rest, never showing the password', async () => {
    const results = await run(
      resolved(),
      fakeDeps({
        'GET /': [
          401,
          '{"error":{"type":"security_exception","reason":"unable to authenticate user [elastic]"},"status":401}',
        ],
      }),
    );
    expect(results.map((r) => [r.step, r.status])).toEqual([
      ['dns', 'ok'],
      ['tcp', 'ok'],
      ['ssh', 'skipped'],
      ['tls', 'ok'],
      ['auth', 'failed'],
      ['ping', 'skipped'],
      ['version', 'skipped'],
    ]);
    expect(results[4]!.hint).toBe('Check the user name and password');
    expect(JSON.stringify(results)).not.toContain('top-secret');
  });

  it('fails DNS when no host resolves, and TCP when no node answers', async () => {
    const dns = await run(
      resolved(),
      fakeDeps(HEALTHY, {
        lookup: async () => {
          throw Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' });
        },
      }),
    );
    expect(dns[0]).toMatchObject({ step: 'dns', status: 'failed' });
    expect(dns[0]!.hint).toContain('host name');
    const tcp = await run(
      resolved(),
      fakeDeps(HEALTHY, {
        probe: async () => {
          throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
        },
      }),
    );
    expect(tcp[1]).toMatchObject({ step: 'tcp', status: 'failed' });
  });

  it('skips TLS for an http URL, and names the OSS distribution', async () => {
    const results = await run(
      resolved({
        endpoint: { kind: 'urls', urls: ['http://10.0.0.9:9200'] },
        auth: { method: 'none' },
      }),
      fakeDeps({
        ...HEALTHY,
        'GET /': [
          200,
          JSON.stringify({
            cluster_name: 'oss',
            version: { number: '7.10.2', build_flavor: 'oss' },
          }),
        ],
        'GET /_license': [400, '{"error":"no handler found for uri [/_license]"}'],
      }),
    );
    expect(results.map((r) => [r.step, r.status])).toEqual([
      ['dns', 'skipped'],
      ['tcp', 'ok'],
      ['ssh', 'skipped'],
      ['tls', 'skipped'],
      ['auth', 'ok'],
      ['ping', 'ok'],
      ['version', 'ok'],
    ]);
    expect(results[4]!.message).toBe('No authentication needed');
    expect(results[6]!.message).toBe('Elasticsearch 7.10.2 (OSS distribution), cluster "oss"');
  });

  it('passes auth for a user without the monitor privilege, and says so', async () => {
    const results = await run(
      resolved(),
      fakeDeps({ ...HEALTHY, 'GET /': [403, '{}'], 'GET /_cluster/health': [403, '{}'] }),
    );
    expect(results[4]).toMatchObject({ step: 'auth', status: 'ok' });
    expect(results[4]!.message).toContain('monitor privilege');
    expect(results[6]).toMatchObject({
      step: 'version',
      status: 'ok',
      message: 'Unknown: the user may not read GET /',
    });
  });

  it('fails the SSH step when a tunnel is needed but none can open', async () => {
    const results = await run(
      resolved({
        ssh: {
          hops: [{ host: 'bastion', port: 22, user: 'me', auth: { method: 'agent' } }],
          keepAliveIntervalMs: 0,
        },
      }),
      fakeDeps(HEALTHY),
    );
    expect(results.find((r) => r.step === 'ssh')).toMatchObject({ status: 'failed' });
  });
});

describe('parsePublishAddress', () => {
  it('reads ip:port and host/ip:port', () => {
    expect(parsePublishAddress('127.0.0.1:9200')).toEqual({ host: '127.0.0.1', port: 9200 });
    expect(parsePublishAddress('es1.internal/10.0.0.4:9200')).toEqual({
      host: 'es1.internal',
      port: 9200,
    });
    expect(parsePublishAddress('[::1]:9201')).toEqual({ host: '::1', port: 9201 });
    expect(parsePublishAddress('nonsense')).toBeUndefined();
  });
});
