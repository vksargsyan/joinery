import {
  connectionProfileSchema,
  type ConnectionProfileInput,
  type ResolvedProfile,
} from '@querybara/core';
import type { FileReader } from '@querybara/driver-sql-base';
import { describe, expect, it } from 'vitest';

import { buildPgConnectionPlan } from '../src';
import { socketHostPort } from '../src/config';

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
      name: 'Postgres',
      engine: 'postgres',
      endpoint: { kind: 'host', host: 'db.example.com', port: 5432 },
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

describe('buildPgConnectionPlan', () => {
  it('maps endpoint, credentials and session options', () => {
    const plan = buildPgConnectionPlan(
      profile({
        options: {
          connectTimeoutMs: 5000,
          queryTimeoutMs: 30000,
          charset: 'UTF8',
          timeZone: "Europe/O'Brien",
          initSql: ['SET work_mem = 65536'],
          defaultDatabase: 'sales',
          applicationName: 'Querybara test',
          keepAlive: false,
        },
        tls: { mode: 'disable' },
      }),
      { readFile },
    );
    expect(plan.config).toMatchObject({
      host: 'db.example.com',
      port: 5432,
      user: 'app',
      password: 's3cret',
      database: 'sales',
      connectionTimeoutMillis: 5000,
      statement_timeout: 30000,
      client_encoding: 'UTF8',
      application_name: 'Querybara test',
      keepAlive: false,
      ssl: false,
    });
    expect(plan.config.types).toBeDefined();
    expect(plan.setup).toEqual(["SET TIME ZONE 'Europe/O''Brien'", 'SET work_mem = 65536']);
    expect(plan.where).toBe('db.example.com:5432');
  });

  it('builds a control connection without init SQL or timeouts', () => {
    const plan = buildPgConnectionPlan(
      profile({
        options: { queryTimeoutMs: 1000, initSql: ['SELECT 1'], timeZone: 'UTC' },
        tls: { mode: 'disable' },
      }),
      { control: true, readFile },
    );
    expect(plan.setup).toEqual([]);
    expect(plan.config.statement_timeout).toBeUndefined();
    expect(plan.config.application_name).toBe('Querybara (control)');
  });

  it('connects to Unix sockets given as a directory or a socket file', () => {
    expect(socketHostPort('/var/run/postgresql/.s.PGSQL.5433', 5432)).toEqual({
      host: '/var/run/postgresql',
      port: 5433,
    });
    expect(socketHostPort('/var/run/postgresql', 5432)).toEqual({
      host: '/var/run/postgresql',
      port: 5432,
    });
    const plan = buildPgConnectionPlan(
      profile({ endpoint: { kind: 'socket', path: '/tmp/.s.PGSQL.6000' } }),
      {
        readFile,
      },
    );
    expect(plan.config).toMatchObject({ host: '/tmp', port: 6000, ssl: false });
  });

  it('reads URIs, keeping the password out of them', () => {
    const plan = buildPgConnectionPlan(
      profile({
        endpoint: { kind: 'uri', uri: 'postgresql://reporter@db.internal:6432/analytics' },
        auth: { method: 'password', password: { id: 'pw' } },
      }),
      { readFile },
    );
    expect(plan.config).toMatchObject({
      host: 'db.internal',
      port: 6432,
      user: 'reporter',
      password: 's3cret',
      database: 'analytics',
    });
  });

  it('dials the tunnel and verifies the certificate against the profile host', () => {
    const plan = buildPgConnectionPlan(profile({}, undefined, { host: '127.0.0.1', port: 40123 }), {
      readFile,
    });
    expect(plan.config).toMatchObject({ host: '127.0.0.1', port: 40123 });
    expect(plan.tls.expectedHostname).toBe('db.example.com');
    expect(plan.config.ssl).toMatchObject({
      rejectUnauthorized: true,
      servername: 'db.example.com',
    });
  });

  it('maps each TLS mode to pg ssl options', () => {
    const ssl = (tls: ConnectionProfileInput['tls']) =>
      buildPgConnectionPlan(profile({ tls }), { readFile }).config.ssl;
    expect(ssl({ mode: 'disable' })).toBe(false);
    expect(ssl({ mode: 'require' })).toMatchObject({ rejectUnauthorized: false });
    expect(ssl({ mode: 'verify-ca', caPath: '/ca.pem' })).toMatchObject({
      rejectUnauthorized: true,
      ca: Buffer.from('contents of /ca.pem'),
    });
    expect(ssl({ mode: 'verify-full', servername: 'cert.example.com' })).toMatchObject({
      rejectUnauthorized: true,
      servername: 'cert.example.com',
    });
  });

  it('sends the client certificate for certificate authentication', () => {
    const plan = buildPgConnectionPlan(
      profile({
        auth: { method: 'clientCertificate', user: 'svc' },
        tls: { mode: 'verify-full', certPath: '/svc.crt', keyPath: '/svc.key' },
      }),
      { readFile },
    );
    expect(plan.config.user).toBe('svc');
    expect(plan.config.password).toBeUndefined();
    expect(plan.config.ssl).toMatchObject({
      cert: Buffer.from('contents of /svc.crt'),
      key: Buffer.from('contents of /svc.key'),
    });
  });
});
