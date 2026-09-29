import { connectionProfileSchema, type ConnectionProfileInput } from '@joinery/core';
import { describe, expect, it } from 'vitest';

import { needsTransport, tunnelTarget } from '../src';

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

  it('refuses sockets and host lists with NOT_SUPPORTED, never echoing the URI', () => {
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
    expect(() =>
      tunnelTarget(
        profile({
          engine: 'mongodb',
          endpoint: { kind: 'hosts', hosts: [{ host: 'a', port: 27017 }] },
        }),
      ),
    ).toThrow(expect.objectContaining({ code: 'NOT_SUPPORTED' }));
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
