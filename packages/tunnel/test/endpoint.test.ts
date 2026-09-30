import { connectionProfileSchema, type ConnectionProfileInput } from '@joinery/core';
import { describe, expect, it } from 'vitest';

import { cloudIdUrl, needsTransport, tunnelReach, tunnelTarget } from '../src';

function profile(input: Partial<ConnectionProfileInput>) {
  return connectionProfileSchema.parse({
    id: 'p',
    name: 'P',
    engine: 'postgres',
    endpoint: { kind: 'host', host: 'db.internal', port: 5432 },
    createdAt: '2026-09-29T10:00:00.000Z',
    updatedAt: '2026-09-29T10:00:00.000Z',
    ...input,
  });
}

describe('tunnelTarget', () => {
  it('uses the host endpoint', () => {
    expect(tunnelTarget(profile({}))).toEqual({ host: 'db.internal', port: 5432 });
  });

  it('parses a URI endpoint, with the engine default port and IPv6 hosts', () => {
    expect(
      tunnelTarget(profile({ endpoint: { kind: 'uri', uri: 'postgres://u:pw@db.lan:6543/app' } })),
    ).toEqual({ host: 'db.lan', port: 6543 });
    expect(
      tunnelTarget(
        profile({ engine: 'mysql', endpoint: { kind: 'uri', uri: 'mysql://root@[fd00::5]/x' } }),
      ),
    ).toEqual({ host: 'fd00::5', port: 3306 });
    expect(tunnelTarget(profile({ endpoint: { kind: 'uri', uri: 'postgres:///app' } }))).toEqual({
      host: 'localhost',
      port: 5432,
    });
  });

  it('refuses sockets and SQL host lists with NOT_SUPPORTED, never echoing the URI', () => {
    expect(() =>
      tunnelTarget(profile({ endpoint: { kind: 'socket', path: '/var/run/postgresql/.s.PGSQL' } })),
    ).toThrow(
      expect.objectContaining({
        code: 'NOT_SUPPORTED',
        message: expect.stringMatching(/Unix socket/),
      }),
    );
    const socketUri = 'postgres://u:topsecret@/app?host=/var/run/postgresql';
    let error: unknown;
    try {
      tunnelTarget(profile({ endpoint: { kind: 'uri', uri: socketUri } }));
    } catch (e) {
      error = e;
    }
    expect(error).toMatchObject({ code: 'NOT_SUPPORTED' });
    expect(JSON.stringify(error)).not.toContain('topsecret');
    const multiHost = 'postgres://u:topsecret@a:5432,b:5432/app';
    expect(() => tunnelTarget(profile({ endpoint: { kind: 'uri', uri: multiHost } }))).toThrow(
      expect.objectContaining({ code: 'NOT_SUPPORTED', hint: expect.stringMatching(/one host/) }),
    );
  });

  it('names the first server of a topology, and none for an SRV name', () => {
    expect(
      tunnelTarget(
        profile({
          engine: 'mongodb',
          endpoint: { kind: 'hosts', hosts: [{ host: 'a', port: 27018 }] },
        }),
      ),
    ).toEqual({ host: 'a', port: 27018 });
    expect(() =>
      tunnelTarget(profile({ engine: 'mongodb', endpoint: { kind: 'srv', host: 'c.example' } })),
    ).toThrow(expect.objectContaining({ code: 'NOT_SUPPORTED' }));
  });
});

describe('tunnelReach', () => {
  const mongo = (uri: string) =>
    tunnelReach(profile({ engine: 'mongodb', endpoint: { kind: 'uri', uri } }));

  it('reaches one server for a host endpoint or a single-host URI', () => {
    expect(tunnelReach(profile({}))).toEqual({
      kind: 'host',
      target: { host: 'db.internal', port: 5432 },
    });
    expect(mongo('mongodb://app:pw@db1.lan:27018/sales?authSource=admin')).toEqual({
      kind: 'host',
      target: { host: 'db1.lan', port: 27018 },
    });
    expect(mongo('mongodb://[fd00::5]/')).toEqual({
      kind: 'host',
      target: { host: 'fd00::5', port: 27017 },
    });
  });

  it('reaches every server of a replica set, an SRV name, Sentinel and Cluster', () => {
    expect(
      tunnelReach(
        profile({
          engine: 'mongodb',
          endpoint: {
            kind: 'hosts',
            hosts: [
              { host: 'a', port: 27017 },
              { host: 'b', port: 27018 },
            ],
            replicaSet: 'rs0',
          },
        }),
      ),
    ).toEqual({
      kind: 'nodes',
      seeds: [
        { host: 'a', port: 27017 },
        { host: 'b', port: 27018 },
      ],
    });
    expect(
      tunnelReach(profile({ engine: 'mongodb', endpoint: { kind: 'srv', host: 'c0.example' } })),
    ).toEqual({ kind: 'nodes', seeds: [], srvRecord: '_mongodb._tcp.c0.example' });
    expect(mongo('mongodb+srv://u:topsecret@c0.example/app')).toEqual({
      kind: 'nodes',
      seeds: [],
      srvRecord: '_mongodb._tcp.c0.example',
    });
    expect(mongo('mongodb://u:p@a:1,[::1]:2,b/app?replicaSet=rs0')).toEqual({
      kind: 'nodes',
      seeds: [
        { host: 'a', port: 1 },
        { host: '::1', port: 2 },
        { host: 'b', port: 27017 },
      ],
    });
    // One host that names its replica set is discovered too.
    expect(mongo('mongodb://a:1/?replicaSet=rs0')).toEqual({
      kind: 'nodes',
      seeds: [{ host: 'a', port: 1 }],
    });
    expect(
      tunnelReach(
        profile({
          engine: 'redis',
          endpoint: {
            kind: 'sentinel',
            sentinels: [{ host: 's1', port: 26379 }],
            masterName: 'm',
          },
        }),
      ),
    ).toEqual({ kind: 'nodes', seeds: [{ host: 's1', port: 26379 }] });
    expect(
      tunnelReach(
        profile({
          engine: 'redis',
          endpoint: { kind: 'cluster', seeds: [{ host: 'c', port: 7000 }] },
        }),
      ),
    ).toEqual({ kind: 'nodes', seeds: [{ host: 'c', port: 7000 }] });
  });

  it('refuses a MongoDB socket URI and never echoes a URI it cannot parse', () => {
    expect(() => mongo('mongodb://%2Ftmp%2Fmongodb-27017.sock/app')).toThrow(
      expect.objectContaining({ code: 'NOT_SUPPORTED', message: expect.stringMatching(/socket/) }),
    );
    let error: unknown;
    try {
      mongo('mongodb://u:topsecret@a:99999/app');
    } catch (e) {
      error = e;
    }
    expect(error).toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(JSON.stringify(error)).not.toContain('topsecret');
  });

  it('reaches one Elasticsearch node URL, or a Cloud ID', () => {
    const search = (endpoint: ConnectionProfileInput['endpoint'], tls = 'verify-full' as const) =>
      tunnelTarget(profile({ engine: 'elasticsearch', endpoint, tls: { mode: tls } }));
    expect(search({ kind: 'urls', urls: ['https://es.internal:9243/prefix'] })).toEqual({
      host: 'es.internal',
      port: 9243,
    });
    expect(search({ kind: 'urls', urls: ['es.internal'] })).toEqual({
      host: 'es.internal',
      port: 443,
    });
    expect(search({ kind: 'urls', urls: ['http://[fd00::9]'] })).toEqual({
      host: 'fd00::9',
      port: 80,
    });
    expect(() => search({ kind: 'urls', urls: ['https://a:9200', 'https://b:9200'] })).toThrow(
      expect.objectContaining({ code: 'NOT_SUPPORTED' }),
    );
    const cloudId = `prod:${btoa('us-east-1.aws.found.io:443$abc123$def456')}`;
    expect(search({ kind: 'cloudId', cloudId })).toEqual({
      host: 'abc123.us-east-1.aws.found.io',
      port: 443,
    });
    expect(cloudIdUrl(`x:${btoa('eu.cloud.es.io:9243$es$kb')}`)).toBe(
      'https://es.eu.cloud.es.io:9243',
    );
    expect(() => cloudIdUrl('nonsense')).toThrow(
      expect.objectContaining({ code: 'VALIDATION_FAILED' }),
    );
  });

  it('knows when a profile needs a transport', () => {
    expect(needsTransport(profile({}))).toBe(false);
    expect(needsTransport(profile({ proxy: { kind: 'http', host: 'p', port: 3128 } }))).toBe(true);
    expect(
      needsTransport(
        profile({ ssh: { hops: [{ host: 'b', user: 'u', auth: { method: 'agent' } }] } }),
      ),
    ).toBe(true);
  });
});
