import { existsSync } from 'node:fs';

import type { ConnectionCheckResult, ResolvedProfile } from '@querybara/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { checkConnection, createPostgresAdapter } from '../../src';
import { PG_URL, rows, testProfile, type connect } from './helpers';

/** CA of the test server's certificate (issued for DNS:localhost only), when TLS is set up. */
const TLS_CA = process.env['QUERYBARA_TEST_POSTGRES_TLS_CA'];
/** Directory of the server's Unix socket, when the test server exposes one. */
const SOCKET_DIR = process.env['QUERYBARA_TEST_POSTGRES_SOCKET_DIR'];

async function checkSteps(resolved: ResolvedProfile): Promise<ConnectionCheckResult[]> {
  const results: ConnectionCheckResult[] = [];
  for await (const result of checkConnection(resolved)) results.push(result);
  return results;
}

function withPassword(resolved: ResolvedProfile, password: string): ResolvedProfile {
  return { ...resolved, secrets: { ...resolved.secrets, password } };
}

describe.skipIf(!PG_URL)('PostgreSQL connection', () => {
  it('maps a wrong password to AUTH_FAILED without echoing it', async () => {
    const resolved = withPassword(testProfile(), 'definitely-wrong-password');
    const error = await createPostgresAdapter()
      .connect(resolved)
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'AUTH_FAILED', sqlState: '28P01' });
    expect(JSON.stringify(error)).not.toContain('definitely-wrong-password');
  });

  it('maps a refused port to CONNECTION_FAILED with a hint', async () => {
    const resolved = testProfile({ endpoint: { kind: 'host', host: '127.0.0.1', port: 1 } });
    await expect(createPostgresAdapter().connect(resolved)).rejects.toMatchObject({
      code: 'CONNECTION_FAILED',
      hint: expect.stringContaining('running'),
    });
  });

  it('maps an unknown database to NOT_FOUND', async () => {
    const base = testProfile();
    const resolved = {
      ...base,
      profile: {
        ...base.profile,
        options: { ...base.profile.options, defaultDatabase: 'no_such_db_xyz' },
      },
    };
    await expect(createPostgresAdapter().connect(resolved)).rejects.toMatchObject({
      code: 'NOT_FOUND',
      sqlState: '3D000',
    });
  });

  it('asks for the password when the secret was not unsealed', async () => {
    const resolved = { ...testProfile(), secrets: {} };
    await expect(createPostgresAdapter().connect(resolved)).rejects.toMatchObject({
      code: 'AUTH_FAILED',
    });
  });

  it('refuses SSH profiles without an open tunnel, and uses the tunnel override', async () => {
    const base = testProfile();
    const ssh = {
      hops: [
        { host: 'bastion.example.com', port: 22, user: 'me', auth: { method: 'agent' as const } },
      ],
      keepAliveIntervalMs: 15000,
    };
    const tunnelled = { ...base, profile: { ...base.profile, ssh } };
    await expect(createPostgresAdapter().connect(tunnelled)).rejects.toMatchObject({
      code: 'NOT_SUPPORTED',
    });

    const endpoint = base.profile.endpoint;
    if (endpoint.kind !== 'host') throw new Error('expected a host endpoint');
    const session = await createPostgresAdapter().connect({
      ...tunnelled,
      profile: {
        ...tunnelled.profile,
        endpoint: { kind: 'host', host: 'db.internal.example', port: 5432 },
      },
      endpointOverride: { host: endpoint.host, port: endpoint.port },
    });
    expect(await rows(session, 'SELECT 1')).toEqual([[1]]);
    await session.close();
  });

  it('runs Test Connection step by step', async () => {
    const results = await checkSteps(testProfile());
    expect(results.map((r) => [r.step, r.status])).toEqual([
      ['dns', 'skipped'],
      ['tcp', 'ok'],
      ['ssh', 'skipped'],
      ['tls', 'skipped'],
      ['auth', 'ok'],
      ['ping', 'ok'],
      ['version', 'ok'],
    ]);
    expect(results.at(-1)?.message).toMatch(/^PostgreSQL \d+/);
  });

  it('names the failing Test Connection step', async () => {
    const refused = await checkSteps(
      testProfile({ endpoint: { kind: 'host', host: '127.0.0.1', port: 1 } }),
    );
    expect(refused.find((r) => r.status === 'failed')).toMatchObject({
      step: 'tcp',
      hint: expect.any(String),
    });
    expect(refused.slice(2).every((r) => r.status === 'skipped')).toBe(true);

    const badPassword = await checkSteps(withPassword(testProfile(), 'nope'));
    expect(badPassword.find((r) => r.status === 'failed')).toMatchObject({ step: 'auth' });
  });

  describe.skipIf(!TLS_CA || !existsSync(TLS_CA ?? ''))('TLS modes', () => {
    const tls = (
      mode: 'require' | 'verify-ca' | 'verify-full',
      extra: Record<string, string> = {},
    ) => testProfile({ tls: { mode, ...extra } });

    it('require encrypts without verifying', async () => {
      const session = await createPostgresAdapter().connect(tls('require'));
      expect(
        await rows(session, 'SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()'),
      ).toEqual([[true]]);
      await session.close();
    });

    it('verify-ca checks the chain but not the host name', async () => {
      const session = await createPostgresAdapter().connect(tls('verify-ca', { caPath: TLS_CA! }));
      await session.close();
      await expect(createPostgresAdapter().connect(tls('verify-ca'))).rejects.toMatchObject({
        code: 'TLS_FAILED',
      });
    });

    it('verify-full checks the host name, honouring the server name override', async () => {
      // The certificate names "localhost" only; the test URL connects to 127.0.0.1.
      await expect(
        createPostgresAdapter().connect(tls('verify-full', { caPath: TLS_CA! })),
      ).rejects.toMatchObject({
        code: 'TLS_FAILED',
      });
      const session = await createPostgresAdapter().connect(
        tls('verify-full', { caPath: TLS_CA!, servername: 'localhost' }),
      );
      await session.close();
    });

    it('reports a TLS failure at the tls step of Test Connection', async () => {
      const results = await checkSteps(tls('verify-full', { caPath: TLS_CA! }));
      expect(results.find((r) => r.status === 'failed')).toMatchObject({ step: 'tls' });
    });
  });

  describe.skipIf(!SOCKET_DIR)('Unix socket endpoint', () => {
    let session: Awaited<ReturnType<typeof connect>>;
    beforeAll(async () => {
      const base = testProfile();
      const port = base.profile.endpoint.kind === 'host' ? base.profile.endpoint.port : 5432;
      session = await createPostgresAdapter().connect({
        ...base,
        profile: {
          ...base.profile,
          endpoint: { kind: 'socket', path: `${SOCKET_DIR}/.s.PGSQL.${port}` },
        },
      });
    });
    afterAll(() => session.close());

    it('connects through the socket file', async () => {
      expect(await rows(session, 'SELECT inet_server_addr() IS NULL')).toEqual([[true]]);
    });
  });
});
