import type { Socket } from 'node:net';

import {
  connectionProfileSchema,
  type ConnectionProfileInput,
  type ResolvedProfile,
} from '@querybara/core';
import type { FileReader } from '@querybara/driver-sql-base';
import { describe, expect, it } from 'vitest';

import { buildMysqlConnectionPlan } from '../src';
import { queryTimeoutStatement } from '../src/config';

const now = '2026-09-29T10:00:00.000Z';
const readFile: FileReader = (path) => Buffer.from(`contents of ${path}`);

function profile(
  input: Partial<ConnectionProfileInput> = {},
  secrets: Record<string, string> = { pw: 's3cret' },
  endpointOverride?: { host: string; port: number },
): ResolvedProfile {
  return {
    profile: connectionProfileSchema.parse({
      id: 'm',
      name: 'MySQL',
      engine: 'mysql',
      endpoint: { kind: 'host', host: 'db.example.com', port: 3306 },
      auth: { method: 'password', user: 'app', password: { id: 'pw' } },
      // A remote server with verified TLS (a new profile's default is TLS off).
      tls: { mode: 'verify-full' },
      createdAt: now,
      updatedAt: now,
      ...input,
    }),
    secrets,
    ...(endpointOverride ? { endpointOverride } : {}),
  };
}

describe('buildMysqlConnectionPlan', () => {
  it('maps endpoint, credentials and value handling', () => {
    const plan = buildMysqlConnectionPlan(
      profile({
        tls: { mode: 'disable' },
        options: {
          defaultDatabase: 'shop',
          charset: 'utf8mb4',
          connectTimeoutMs: 4000,
          timeZone: '+00:00',
          initSql: ["SET SESSION sql_mode = 'ANSI'"],
          queryTimeoutMs: 1500,
        },
      }),
      { readFile },
    );
    expect(plan.options).toMatchObject({
      host: 'db.example.com',
      port: 3306,
      user: 'app',
      password: 's3cret',
      database: 'shop',
      charset: 'utf8mb4',
      connectTimeout: 4000,
      dateStrings: true,
      supportBigNumbers: true,
      bigNumberStrings: true,
      decimalNumbers: false,
      jsonStrings: true,
      rowsAsArray: true,
      multipleStatements: false,
      flags: ['-LOCAL_FILES'],
      connectAttributes: { program_name: 'Querybara' },
    });
    expect(plan.options.ssl).toBeUndefined();
    expect(plan.options.stream).toBeUndefined();
    expect(plan.setup).toEqual(["SET time_zone = '+00:00'", "SET SESSION sql_mode = 'ANSI'"]);
    expect(plan.queryTimeoutMs).toBe(1500);
  });

  it('builds a control connection without database, setup or timeout', () => {
    const plan = buildMysqlConnectionPlan(
      profile({
        tls: { mode: 'disable' },
        options: { defaultDatabase: 'shop', initSql: ['SELECT 1'], queryTimeoutMs: 5 },
      }),
      { control: true, readFile },
    );
    expect(plan.options.database).toBeUndefined();
    expect(plan.setup).toEqual([]);
    expect(plan.queryTimeoutMs).toBeUndefined();
  });

  it('uses Unix sockets and URIs', () => {
    expect(
      buildMysqlConnectionPlan(
        profile({ endpoint: { kind: 'socket', path: '/run/mysqld/mysqld.sock' } }),
        { readFile },
      ).options,
    ).toMatchObject({ socketPath: '/run/mysqld/mysqld.sock' });
    const uri = buildMysqlConnectionPlan(
      profile({
        endpoint: { kind: 'uri', uri: 'mysql://report@replica.internal:3307/analytics' },
        tls: { mode: 'disable' },
      }),
      { readFile },
    );
    expect(uri.options).toMatchObject({
      host: 'replica.internal',
      port: 3307,
      user: 'app',
      database: 'analytics',
    });
  });

  it('maps TLS modes to mysql2 ssl options', () => {
    const ssl = (tls: ConnectionProfileInput['tls']) =>
      buildMysqlConnectionPlan(profile({ tls }), { readFile }).options.ssl;
    expect(ssl({ mode: 'disable' })).toBeUndefined();
    expect(ssl({ mode: 'require' })).toEqual({ rejectUnauthorized: false, verifyIdentity: false });
    expect(ssl({ mode: 'verify-ca', caPath: '/ca.pem' })).toEqual({
      rejectUnauthorized: true,
      verifyIdentity: false,
      ca: Buffer.from('contents of /ca.pem'),
    });
    expect(ssl({ mode: 'verify-full', certPath: '/c.pem', keyPath: '/c.key' })).toMatchObject({
      rejectUnauthorized: true,
      verifyIdentity: true,
      cert: Buffer.from('contents of /c.pem'),
      key: Buffer.from('contents of /c.key'),
    });
  });

  it('verifies the expected name while dialling the tunnel under verify-full', () => {
    const plan = buildMysqlConnectionPlan(profile({}, undefined, { host: '127.0.0.1', port: 1 }), {
      readFile,
    });
    expect(plan.options.host).toBe('db.example.com');
    expect(plan.options.port).toBe(1);
    expect(typeof plan.options.stream).toBe('function');
    const socket = (plan.options.stream as () => Socket)();
    socket.on('error', () => undefined);
    socket.destroy();
  });

  it('pins IP addresses as the name to verify', () => {
    const plan = buildMysqlConnectionPlan(
      profile({ endpoint: { kind: 'host', host: '127.0.0.1', port: 1 } }),
      {
        readFile,
      },
    );
    const socket = (plan.options.stream as () => Socket & { _host?: string })();
    socket.on('error', () => undefined);
    expect(socket._host).toBe('127.0.0.1');
    socket.destroy();
  });

  it('writes the query timeout for each flavour', () => {
    expect(queryTimeoutStatement(false, 1500)).toBe('SET SESSION max_execution_time = 1500');
    expect(queryTimeoutStatement(true, 1500)).toBe('SET SESSION max_statement_time = 1.500');
  });
});
