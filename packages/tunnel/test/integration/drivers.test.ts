import { existsSync } from 'node:fs';

import {
  JoineryError,
  type ConnectionCheckResult,
  type ConnectionProfileInput,
  type DriverAdapter,
  type ResolvedProfile,
  type Session,
} from '@joinery/core';
import { createMysqlAdapter } from '@joinery/driver-mysql';
import { createPostgresAdapter } from '@joinery/driver-postgres';
import { resolvedProfileFromUrl } from '@joinery/driver-sql-base';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  MemoryKnownHosts,
  TransportManager,
  checkConnectionThroughTransport,
  connectThroughTransport,
  knownHostsVerifier,
  type HostKeyInfo,
} from '../../src';
import {
  startHttpProxy,
  startSocks5Server,
  startSshServer,
  type ProxyServer,
  type TestSshServer,
} from '../helpers/servers';

/**
 * Real drivers through an in-process SSH server (and proxies) forwarding to the local test
 * servers: sessions, streaming, Test Connection, shared sessions and closing mid-stream.
 */

const ENGINES = [
  ['PostgreSQL', process.env['JOINERY_TEST_POSTGRES_URL']],
  ['MySQL', process.env['JOINERY_TEST_MYSQL_URL']],
  ['MariaDB', process.env['JOINERY_TEST_MARIADB_URL']],
] as const;
const PG_TLS_CA = process.env['JOINERY_TEST_POSTGRES_TLS_CA'];

const SSH_PASSWORD = 'bastion-password';
const ROWS = 5000;

let ssh: TestSshServer;
let socks: ProxyServer;
let http: ProxyServer;
let manager: TransportManager;
const prompted: HostKeyInfo[] = [];

beforeAll(async () => {
  ssh = await startSshServer({ users: { tunnel: { password: SSH_PASSWORD } } });
  socks = await startSocks5Server();
  http = await startHttpProxy({ user: 'proxy', password: 'proxy-pw' });
  // Trust on first use, as the desktop does after the user accepts the fingerprint.
  const verifier = knownHostsVerifier(new MemoryKnownHosts(), async (_host, _port, key) => {
    prompted.push(key);
    return key.fingerprintSha256 === ssh.hostKeyFingerprint ? 'trust' : 'reject';
  });
  manager = new TransportManager({ hostKeyVerifier: verifier });
});
afterAll(async () => {
  manager?.closeAll();
  await Promise.all([ssh?.close(), socks?.close(), http?.close()]);
});

function adapterFor(resolved: ResolvedProfile): DriverAdapter {
  return resolved.profile.engine === 'postgres'
    ? createPostgresAdapter()
    : createMysqlAdapter({ engine: resolved.profile.engine === 'mariadb' ? 'mariadb' : 'mysql' });
}

/** The test server's profile, reached through the in-process SSH server as `localhost`. */
function throughSsh(url: string, overrides: Partial<ConnectionProfileInput> = {}): ResolvedProfile {
  const base = resolvedProfileFromUrl(url, {
    ssh: {
      hops: [
        {
          host: 'localhost',
          port: ssh.port,
          user: 'tunnel',
          auth: { method: 'password', password: { id: 'ssh-password' } },
        },
      ],
    },
    ...overrides,
  });
  return { ...base, secrets: { ...base.secrets, 'ssh-password': SSH_PASSWORD } };
}

function throughProxy(url: string, kind: 'socks5' | 'http'): ResolvedProfile {
  const base = resolvedProfileFromUrl(url, {
    proxy:
      kind === 'socks5'
        ? { kind, host: '127.0.0.1', port: socks.port }
        : {
            kind,
            host: '127.0.0.1',
            port: http.port,
            user: 'proxy',
            password: { id: 'proxy-password' },
          },
  });
  return { ...base, secrets: { ...base.secrets, 'proxy-password': 'proxy-pw' } };
}

function rowsQuery(engine: string): string {
  if (engine === 'postgres') {
    return `SELECT g AS n, repeat('x', 100) AS pad FROM generate_series(1, ${ROWS}) AS g`;
  }
  const digits = (count: number) =>
    `(${Array.from({ length: count }, (_, i) => `SELECT ${i} AS d`).join(' UNION ALL ')})`;
  return (
    `SELECT a.d + 10 * b.d + 100 * c.d + 1000 * e.d + 1 AS n, REPEAT('x', 100) AS pad ` +
    `FROM ${digits(10)} a CROSS JOIN ${digits(10)} b CROSS JOIN ${digits(10)} c ` +
    `CROSS JOIN ${digits(ROWS / 1000)} e`
  );
}

let executions = 0;

/** Streams a statement and returns its row chunk sizes and the sum of the first column. */
async function stream(
  session: Session,
  text: string,
): Promise<{ chunks: number[]; total: number; sum: number }> {
  const chunks: number[] = [];
  let total = -1;
  let sum = 0;
  executions += 1;
  for await (const chunk of session.execute(text, {
    executionId: `e${executions}`,
    pageSize: 1000,
  })) {
    if (chunk.type === 'rows') {
      chunks.push(chunk.rowCount);
      for (const value of chunk.data[0]!) sum += Number(value);
    }
    if (chunk.type === 'end') total = chunk.rowCount;
  }
  return { chunks, total, sum };
}

async function steps(
  adapter: DriverAdapter,
  resolved: ResolvedProfile,
): Promise<ConnectionCheckResult[]> {
  const results: ConnectionCheckResult[] = [];
  for await (const result of checkConnectionThroughTransport(adapter, resolved, manager)) {
    results.push(result);
  }
  return results;
}

describe.each(ENGINES)('%s through an SSH tunnel', (name, url) => {
  it.skipIf(!url)('runs queries and streams thousands of rows', async () => {
    const resolved = throughSsh(url!);
    const connected = await connectThroughTransport(adapterFor(resolved), resolved, manager);
    try {
      const { session, transport } = connected;
      expect(transport?.endpointOverride.host).toBe('127.0.0.1');
      const one = await stream(session, 'SELECT 1');
      expect(one).toMatchObject({ total: 1, sum: 1 });
      const many = await stream(session, rowsQuery(resolved.profile.engine));
      expect(many.total).toBe(ROWS);
      expect(many.sum).toBe((ROWS * (ROWS + 1)) / 2);
      expect(many.chunks.length).toBeGreaterThanOrEqual(ROWS / 1000);
    } finally {
      await connected.close();
    }
    expect(prompted).toHaveLength(1);
  });

  it.skipIf(!url)('passes Test Connection through the tunnel, every step ok', async () => {
    const resolved = throughSsh(url!);
    const results = await steps(adapterFor(resolved), resolved);
    expect(results.map((r) => [r.step, r.status])).toEqual([
      ['dns', 'ok'],
      ['tcp', 'ok'],
      ['ssh', 'ok'],
      ['tls', 'skipped'],
      ['auth', 'ok'],
      ['ping', 'ok'],
      ['version', 'ok'],
    ]);
    expect(results[0]!.message).toMatch(/^The SSH server localhost resolves to/);
    expect(results[2]!.message).toMatch(/^SSH tunnel@localhost:\d+ → /);
    expect(results[6]!.message).toContain(name === 'PostgreSQL' ? 'PostgreSQL' : 'M');
    expect(manager.sessionCount).toBe(0);
  });

  it.skipIf(!url)('names the failing SSH step', async () => {
    const resolved = throughSsh(url!);
    const wrong = { ...resolved, secrets: { ...resolved.secrets, 'ssh-password': 'nope' } };
    const results = await steps(adapterFor(resolved), wrong);
    expect(results.find((r) => r.status === 'failed')).toMatchObject({
      step: 'ssh',
      hint: 'Check the SSH user name and password',
    });
  });

  it.skipIf(!url)('fails cleanly when the tunnel closes mid-stream', async () => {
    const resolved = throughSsh(url!);
    const { session, transport, close } = await connectThroughTransport(
      adapterFor(resolved),
      resolved,
      manager,
    );
    try {
      executions += 1;
      // Millions of rows, streamed without materialising them on the server.
      const sql =
        name === 'PostgreSQL'
          ? `SELECT g, repeat('x', 200) FROM generate_series(1, 5000000) AS g`
          : name === 'MariaDB'
            ? `SELECT seq, REPEAT('x', 200) FROM seq_1_to_5000000`
            : `SELECT a.ORDINAL_POSITION, REPEAT('x', 200) FROM information_schema.COLUMNS a CROSS JOIN information_schema.COLUMNS b`;
      const results = session.execute(sql, { executionId: `e${executions}`, pageSize: 500 });
      const iterator = results[Symbol.asyncIterator]();
      let rows = 0;
      while (rows < 1000) {
        const next = await iterator.next();
        if (next.done) throw new Error('the statement ended early');
        if (next.value.type === 'rows') rows += next.value.rowCount;
      }
      await transport!.close();
      const error = await (async () => {
        for (;;) {
          const next = await iterator.next();
          if (next.done) return undefined;
        }
      })().catch((e: unknown) => e);
      expect(error).toBeInstanceOf(JoineryError);
      expect(error).toMatchObject({ code: 'CONNECTION_FAILED' });
    } finally {
      await close().catch(() => undefined);
    }
    expect(manager.sessionCount).toBe(0);
  });
});

describe.each(ENGINES)('%s through proxies', (_name, url) => {
  it.skipIf(!url)('connects through a SOCKS5 proxy and an authenticating HTTP proxy', async () => {
    for (const kind of ['socks5', 'http'] as const) {
      const resolved = throughProxy(url!, kind);
      const { session, close } = await connectThroughTransport(
        adapterFor(resolved),
        resolved,
        manager,
      );
      try {
        expect(await stream(session, rowsQuery(resolved.profile.engine))).toMatchObject({
          total: ROWS,
        });
      } finally {
        await close();
      }
      const results = await steps(adapterFor(resolved), resolved);
      expect(results.filter((r) => r.status === 'failed')).toEqual([]);
      expect(results.find((r) => r.step === 'ssh')?.message).toMatch(
        kind === 'socks5' ? /^SOCKS5 proxy/ : /^HTTP proxy/,
      );
    }
  });
});

describe('shared bastion across engines', () => {
  const available = ENGINES.filter(([, url]) => url !== undefined);
  it.skipIf(available.length < 2)('opens every engine through one SSH session', async () => {
    const before = ssh.stats.connections;
    const sessions = await Promise.all(
      available.map(([, url]) => {
        const resolved = throughSsh(url!);
        return connectThroughTransport(adapterFor(resolved), resolved, manager);
      }),
    );
    try {
      expect(ssh.stats.connections - before).toBe(1);
      expect(manager.sessionCount).toBe(1);
      for (const { session } of sessions) {
        expect(await stream(session, 'SELECT 1')).toMatchObject({ total: 1 });
      }
    } finally {
      await Promise.all(sessions.map((s) => s.close()));
    }
    expect(manager.sessionCount).toBe(0);
  });
});

describe.skipIf(!ENGINES[0][1] || !PG_TLS_CA || !existsSync(PG_TLS_CA ?? ''))(
  'TLS through the tunnel',
  () => {
    it('verifies the certificate against the profile host, not 127.0.0.1', async () => {
      const url = ENGINES[0][1]!;
      const port = Number(new URL(url).port);
      // The certificate names localhost; the driver's socket goes to the tunnel's 127.0.0.1.
      const resolved = throughSsh(url, {
        endpoint: { kind: 'host', host: 'localhost', port },
        tls: { mode: 'verify-full', caPath: PG_TLS_CA! },
      });
      const results = await steps(createPostgresAdapter(), resolved);
      expect(results.map((r) => `${r.step}:${r.status}`)).toEqual([
        'dns:ok',
        'tcp:ok',
        'ssh:ok',
        'tls:ok',
        'auth:ok',
        'ping:ok',
        'version:ok',
      ]);

      const wrongName = throughSsh(url, {
        endpoint: { kind: 'host', host: '127.0.0.1', port },
        tls: { mode: 'verify-full', caPath: PG_TLS_CA! },
      });
      const failed = await steps(createPostgresAdapter(), wrongName);
      expect(failed.find((r) => r.status === 'failed')?.step).toBe('tls');
    });
  },
);
