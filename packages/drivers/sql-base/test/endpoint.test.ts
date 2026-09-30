import { JoineryError } from '@joinery/core';
import { describe, expect, it } from 'vitest';

import { describeTarget, parseConnectionUri, resolveEndpoint } from '../src';
import { resolved } from './fixtures';

describe('parseConnectionUri', () => {
  it('parses host, port, user, database and parameters', () => {
    expect(
      parseConnectionUri(
        'postgresql://app%40corp@db.example.com:6543/sales?sslmode=require',
        'postgres',
      ),
    ).toEqual({
      scheme: 'postgresql',
      host: 'db.example.com',
      port: 6543,
      user: 'app@corp',
      database: 'sales',
      params: { sslmode: 'require' },
    });
  });

  it('unbrackets IPv6 hosts and decodes the database name', () => {
    const parsed = parseConnectionUri('mysql://root@[::1]:3307/my%20db', 'mysql');
    expect(parsed).toMatchObject({ host: '::1', port: 3307, database: 'my db' });
  });

  it('accepts the MariaDB scheme for MySQL-protocol engines only', () => {
    expect(parseConnectionUri('mariadb://u@h/db', 'mariadb').scheme).toBe('mariadb');
    expect(parseConnectionUri('mariadb://u@h/db', 'mysql').scheme).toBe('mariadb');
    expect(() => parseConnectionUri('mysql://u@h/db', 'postgres')).toThrow(
      /not a PostgreSQL scheme/,
    );
  });

  it('rejects malformed URIs without echoing them', () => {
    const attempt = (): unknown =>
      parseConnectionUri('postgres://u:hunter2@h1:5432,h2:5432/db', 'postgres');
    expect(attempt).toThrow(JoineryError);
    try {
      attempt();
    } catch (error) {
      expect((error as JoineryError).code).toBe('VALIDATION_FAILED');
      expect((error as JoineryError).message).not.toContain('hunter2');
    }
    expect(() => parseConnectionUri('db.example.com:5432', 'postgres')).toThrow(/no scheme/);
  });
});

describe('resolveEndpoint', () => {
  it('resolves a host endpoint', () => {
    expect(resolveEndpoint(resolved())).toEqual({
      target: { kind: 'tcp', host: 'db.example.com', port: 5432, tlsHost: 'db.example.com' },
      params: {},
      tunnelled: false,
    });
  });

  it('resolves a socket endpoint', () => {
    const endpoint = resolveEndpoint(
      resolved({ endpoint: { kind: 'socket', path: '/run/postgresql' } }),
    );
    expect(endpoint.target).toEqual({ kind: 'socket', path: '/run/postgresql' });
  });

  it('resolves URI endpoints, including sockets and default ports', () => {
    const uri = (value: string) =>
      resolveEndpoint(resolved({ endpoint: { kind: 'uri', uri: value } }));
    expect(uri('postgres://reporter@db.internal/sales')).toMatchObject({
      target: { kind: 'tcp', host: 'db.internal', port: 5432 },
      user: 'reporter',
      database: 'sales',
    });
    expect(uri('postgresql:///sales?host=/var/run/postgresql').target).toEqual({
      kind: 'socket',
      path: '/var/run/postgresql',
    });
    expect(uri('postgresql://%2Ftmp%2Fpg/sales').target).toEqual({
      kind: 'socket',
      path: '/tmp/pg',
    });
    const mysql = resolveEndpoint(
      resolved({
        engine: 'mysql',
        endpoint: { kind: 'uri', uri: 'mysql://root@localhost/app?socket=/tmp/mysql.sock' },
      }),
    );
    expect(mysql.target).toEqual({ kind: 'socket', path: '/tmp/mysql.sock' });
    const mysqlTcp = resolveEndpoint(
      resolved({ engine: 'mysql', endpoint: { kind: 'uri', uri: 'mysql://h/app' } }),
    );
    expect(mysqlTcp.target).toMatchObject({ host: 'h', port: 3306 });
  });

  it('dials the tunnel but keeps the profile host for certificate checks', () => {
    const endpoint = resolveEndpoint(resolved({}, {}, { host: '127.0.0.1', port: 40001 }));
    expect(endpoint).toMatchObject({
      target: { kind: 'tcp', host: '127.0.0.1', port: 40001, tlsHost: 'db.example.com' },
      tunnelled: true,
    });
  });

  it('refuses SSH profiles without an open tunnel', () => {
    const profile = resolved({
      ssh: { hops: [{ host: 'bastion', user: 'me', auth: { method: 'agent' } }] },
    });
    expect(() => resolveEndpoint(profile)).toThrow(
      expect.objectContaining({ code: 'NOT_SUPPORTED' }),
    );
    const tunnelled = { ...profile, endpointOverride: { host: '127.0.0.1', port: 40002 } };
    expect(resolveEndpoint(tunnelled).target).toMatchObject({ host: '127.0.0.1', port: 40002 });
  });

  it('refuses proxies without an open route and endpoint kinds the SQL engines do not take', () => {
    const proxied = resolved({ proxy: { kind: 'socks5', host: 'proxy', port: 1080 } });
    expect(() => resolveEndpoint(proxied)).toThrow(
      expect.objectContaining({
        code: 'NOT_SUPPORTED',
        message: expect.stringContaining('SOCKS5'),
      }),
    );
    const routed = { ...proxied, endpointOverride: { host: '127.0.0.1', port: 40003 } };
    expect(resolveEndpoint(routed).target).toMatchObject({ host: '127.0.0.1', port: 40003 });
    const base = resolved();
    const odd = {
      ...base,
      profile: { ...base.profile, endpoint: { kind: 'srv' as const, host: 'x' } },
    };
    expect(() => resolveEndpoint(odd)).toThrow(expect.objectContaining({ code: 'NOT_SUPPORTED' }));
  });

  it('describes targets for messages', () => {
    expect(describeTarget({ kind: 'tcp', host: '::1', port: 5432, tlsHost: '::1' })).toBe(
      '[::1]:5432',
    );
    expect(describeTarget({ kind: 'socket', path: '/tmp/s' })).toBe('/tmp/s');
  });
});
