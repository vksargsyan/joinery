import { describe, expect, it } from 'vitest';

import {
  QuerybaraError,
  capabilitiesFor,
  compareVersions,
  connectionProfileSchema,
  hasWeakTls,
  isLocalEndpoint,
  parseServerVersion,
  requiresWriteConfirmation,
  rowAt,
  schemaSnapshotSchema,
  secretRefsOf,
  toColumnChunk,
  toErrorData,
} from '../src';

const now = '2026-09-29T10:00:00.000Z';

describe('server versions', () => {
  it('parses engine banners', () => {
    expect(parseServerVersion('10.11.6-MariaDB-0ubuntu0.24.04.1')).toMatchObject({
      major: 10,
      minor: 11,
      patch: 6,
    });
    expect(parseServerVersion('16.4 (Debian 16.4-1.pgdg120+2)')).toMatchObject({
      major: 16,
      minor: 4,
      patch: 0,
    });
    expect(parseServerVersion('no digits')).toBeUndefined();
  });

  it('compares versions numerically', () => {
    expect(compareVersions('8.0.9', '8.0.18')).toBeLessThan(0);
    expect(compareVersions('10.11.0', '10.6.9')).toBeGreaterThan(0);
    expect(compareVersions('8.4', '8.4.0')).toBe(0);
  });
});

describe('capabilities', () => {
  it('gates MySQL EXPLAIN ANALYZE on 8.0.18', () => {
    expect(capabilitiesFor('mysql', '8.0.17').explainFormats).not.toContain('analyze');
    expect(capabilitiesFor('mysql', '8.4.2').explainFormats).toContain('analyze');
  });

  it('gates MariaDB sequences and RETURNING on version', () => {
    expect(capabilitiesFor('mariadb', '10.2.40').sequences).toBe(false);
    expect(capabilitiesFor('mariadb', '10.4.0').returning).toBe(false);
    expect(capabilitiesFor('mariadb', '10.11.6-MariaDB').returning).toBe(true);
  });

  it('marks PostgreSQL DDL as transactional', () => {
    expect(capabilitiesFor('postgres').transactionalDdl).toBe(true);
    expect(capabilitiesFor('mysql').transactionalDdl).toBe(false);
  });
});

describe('connection profiles', () => {
  const base = {
    id: 'p1',
    name: 'Local Postgres',
    engine: 'postgres',
    endpoint: { kind: 'host', host: 'localhost', port: 5432 },
    createdAt: now,
    updatedAt: now,
  } as const;

  it('applies the defaults: TLS off until stated, no sign-in', () => {
    const profile = connectionProfileSchema.parse(base);
    expect(profile.tls.mode).toBe('disable');
    expect(profile.auth).toEqual({ method: 'none' });
    expect(profile.presentation.environment).toBe('dev');
    expect(profile.options.connectTimeoutMs).toBe(10_000);
    expect(requiresWriteConfirmation(profile)).toBe(false);
  });

  it('rejects an endpoint form the engine does not accept', () => {
    const result = connectionProfileSchema.safeParse({
      ...base,
      endpoint: { kind: 'cloudId', cloudId: 'x' },
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(['endpoint', 'kind']);
  });

  it('never holds secret values, only references', () => {
    const profile = connectionProfileSchema.parse({
      ...base,
      auth: { method: 'password', user: 'app', password: { id: 'sec-1' } },
      ssh: {
        hops: [
          {
            host: 'bastion',
            user: 'ops',
            auth: {
              method: 'privateKey',
              keyPath: '~/.ssh/id_ed25519',
              passphrase: { id: 'sec-2' },
            },
          },
        ],
      },
      presentation: { environment: 'production' },
    });
    expect(secretRefsOf(profile).map((r) => r.id)).toEqual(['sec-1', 'sec-2']);
    expect(profile.ssh?.hops[0]?.port).toBe(22);
    expect(requiresWriteConfirmation(profile)).toBe(true);
  });
});

describe('the weak-TLS warning', () => {
  const profile = (patch: object) =>
    connectionProfileSchema.parse({
      id: 'p',
      name: 'P',
      engine: 'postgres',
      endpoint: { kind: 'host', host: 'db.example.com', port: 5432 },
      createdAt: now,
      updatedAt: now,
      ...patch,
    });
  const hop = { host: 'bastion', user: 'ops', auth: { method: 'agent' } };

  it('shows for a remote server without verified TLS', () => {
    expect(hasWeakTls(profile({}))).toBe(true);
    expect(hasWeakTls(profile({ tls: { mode: 'require' } }))).toBe(true);
    expect(hasWeakTls(profile({ tls: { mode: 'verify-full' } }))).toBe(false);
  });

  it('does not show for localhost, a socket or loopback behind an SSH tunnel', () => {
    for (const host of ['localhost', '127.0.0.1', '127.1.2.3', '::1', 'db.localhost']) {
      const local = profile({ endpoint: { kind: 'host', host, port: 5432 } });
      expect(isLocalEndpoint(local), host).toBe(true);
      expect(hasWeakTls(local), host).toBe(false);
    }
    expect(hasWeakTls(profile({ endpoint: { kind: 'socket', path: '/tmp' } }))).toBe(false);
    const tunnelled = profile({
      endpoint: { kind: 'host', host: '127.0.0.1', port: 5432 },
      ssh: { hops: [hop] },
    });
    expect(hasWeakTls(tunnelled)).toBe(false);
    expect(
      hasWeakTls(
        profile({
          engine: 'elasticsearch',
          endpoint: { kind: 'urls', urls: ['http://localhost:9200', 'http://127.0.0.1:9201'] },
        }),
      ),
    ).toBe(false);
  });

  it('shows for loopback reached through a proxy, and for a mixed host list', () => {
    const proxied = profile({
      endpoint: { kind: 'host', host: 'localhost', port: 5432 },
      proxy: { kind: 'socks5', host: 'proxy', port: 1080 },
    });
    expect(hasWeakTls(proxied)).toBe(true);
    const mixed = profile({
      engine: 'mongodb',
      endpoint: {
        kind: 'hosts',
        hosts: [
          { host: 'localhost', port: 27017 },
          { host: 'db2.example.com', port: 27017 },
        ],
      },
    });
    expect(hasWeakTls(mixed)).toBe(true);
  });
});

describe('result chunks', () => {
  it('round-trips rows through the column-oriented layout', () => {
    const rows = [
      [1, 'a', null],
      [2, 'b', 9007199254740993n],
    ];
    const chunk = toColumnChunk(0, 3, rows);
    expect(chunk.rowCount).toBe(2);
    expect(chunk.data[1]).toEqual(['a', 'b']);
    expect(rowAt(chunk, 1)).toEqual([2, 'b', 9007199254740993n]);
    expect(structuredClone(chunk)).toEqual(chunk);
  });
});

describe('schema snapshots', () => {
  it('fills defaults so producers only write what they know', () => {
    const snapshot = schemaSnapshotSchema.parse({
      engine: 'mysql',
      database: 'shop',
      capturedAt: now,
      schemas: [
        {
          name: 'shop',
          tables: [
            {
              name: 'users',
              columns: [{ name: 'id', ordinal: 1, dataType: 'int', nullable: false }],
              primaryKey: { name: 'PRIMARY', columns: ['id'] },
            },
          ],
        },
      ],
    });
    const table = snapshot.schemas[0]?.tables[0];
    expect(table?.indexes).toEqual([]);
    expect(table?.columns[0]?.default).toBeNull();
    expect(snapshot.schemas[0]?.views).toEqual([]);
  });
});

describe('errors', () => {
  it('serialises across a process boundary', () => {
    const error = new QuerybaraError({
      code: 'SQL_ERROR',
      message: 'relation "nope" does not exist',
      sqlState: '42P01',
      position: 14,
    });
    const data = toErrorData(error);
    expect(data).toEqual({
      code: 'SQL_ERROR',
      message: 'relation "nope" does not exist',
      sqlState: '42P01',
      position: 14,
    });
    expect(toErrorData(new Error('boom'))).toEqual({ code: 'INTERNAL', message: 'boom' });
  });
});
