import type { ConnectionCheckResult, ResolvedProfile } from '@joinery/core';
import { describe, expect, it } from 'vitest';

import { checkConnection, createMysqlAdapter } from '../../src';
import { SUITES, TARGETS, rows, target } from './helpers';

async function checkSteps(resolved: ResolvedProfile): Promise<ConnectionCheckResult[]> {
  const results: ConnectionCheckResult[] = [];
  for await (const result of checkConnection(resolved)) results.push(result);
  return results;
}

function withPassword(resolved: ResolvedProfile, password: string): ResolvedProfile {
  return { ...resolved, secrets: { ...resolved.secrets, password } };
}

describe.skipIf(TARGETS.length === 0).each(SUITES)('%s connection', (engine, url) => {
  const t = target(engine, url);
  const socket =
    process.env[engine === 'mysql' ? 'JOINERY_TEST_MYSQL_SOCKET' : 'JOINERY_TEST_MARIADB_SOCKET'];
  /** CA of the test server's certificate, issued for DNS:localhost only. */
  const tlsCa =
    process.env[engine === 'mysql' ? 'JOINERY_TEST_MYSQL_TLS_CA' : 'JOINERY_TEST_MARIADB_TLS_CA'];

  it('maps a wrong password to AUTH_FAILED without echoing it', async () => {
    const error = await createMysqlAdapter({ engine })
      .connect(withPassword(t.profile(), 'definitely-wrong-password'))
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'AUTH_FAILED', engineCode: 1045 });
    expect(JSON.stringify(error)).not.toContain('definitely-wrong-password');
  });

  it('maps a refused port to CONNECTION_FAILED with a hint', async () => {
    const resolved = t.profile({ endpoint: { kind: 'host', host: '127.0.0.1', port: 1 } });
    await expect(createMysqlAdapter({ engine }).connect(resolved)).rejects.toMatchObject({
      code: 'CONNECTION_FAILED',
      hint: expect.stringContaining('running'),
    });
  });

  it('maps an unknown database to NOT_FOUND', async () => {
    await expect(
      t.connect({ options: { defaultDatabase: 'no_such_db_xyz' } }),
    ).rejects.toMatchObject({
      code: 'NOT_FOUND',
      engineCode: 1049,
    });
  });

  describe.skipIf(!tlsCa)('TLS modes', () => {
    const tlsRows = "SHOW SESSION STATUS LIKE 'Ssl_version'";

    it('require encrypts without verifying', async () => {
      const session = await t.connect({ tls: { mode: 'require' } });
      const [[, version]] = (await rows(session, tlsRows)) as [[string, string]];
      expect(version).toMatch(/^TLS/);
      await session.close();
    });

    it('verify-ca checks the chain but not the host name', async () => {
      const session = await t.connect({ tls: { mode: 'verify-ca', caPath: tlsCa! } });
      await session.close();
      await expect(t.connect({ tls: { mode: 'verify-ca' } })).rejects.toMatchObject({
        code: 'TLS_FAILED',
      });
    });

    it('verify-full checks the host name, honouring the server name override', async () => {
      // The certificate names "localhost" only; the test URL connects to 127.0.0.1.
      await expect(
        t.connect({ tls: { mode: 'verify-full', caPath: tlsCa! } }),
      ).rejects.toMatchObject({
        code: 'TLS_FAILED',
      });
      const session = await t.connect({
        tls: { mode: 'verify-full', caPath: tlsCa!, servername: 'localhost' },
      });
      const [[, version]] = (await rows(session, tlsRows)) as [[string, string]];
      expect(version).toMatch(/^TLS/);
      await session.close();
    });

    it('reports a TLS failure at the tls step of Test Connection', async () => {
      const results = await checkSteps(t.profile({ tls: { mode: 'verify-full', caPath: tlsCa! } }));
      expect(results.find((r) => r.status === 'failed')).toMatchObject({ step: 'tls' });
    });
  });

  it('rejects an unknown charset as a validation error', async () => {
    await expect(t.connect({ options: { charset: 'no-such-charset' } })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
  });

  it('runs Test Connection step by step', async () => {
    const results = await checkSteps(t.profile());
    expect(results.map((r) => [r.step, r.status])).toEqual([
      ['dns', 'skipped'],
      ['tcp', 'ok'],
      ['ssh', 'skipped'],
      ['tls', 'skipped'],
      ['auth', 'ok'],
      ['ping', 'ok'],
      ['version', 'ok'],
    ]);
  });

  it('names the failing Test Connection step', async () => {
    const badPassword = await checkSteps(withPassword(t.profile(), 'nope'));
    expect(badPassword.find((r) => r.status === 'failed')).toMatchObject({ step: 'auth' });
    const refused = await checkSteps(
      t.profile({ endpoint: { kind: 'host', host: '127.0.0.1', port: 1 } }),
    );
    expect(refused.find((r) => r.status === 'failed')).toMatchObject({ step: 'tcp' });
  });

  it.skipIf(!socket)('connects through a Unix socket', async () => {
    const base = t.profile();
    const session = await createMysqlAdapter({ engine }).connect({
      ...base,
      profile: { ...base.profile, endpoint: { kind: 'socket', path: socket! } },
    });
    expect(await rows(session, 'SELECT 1')).toEqual([[1]]);
    await session.close();
  });

  it('connects through a tunnel override and refuses SSH without one', async () => {
    const base = t.profile();
    const ssh = {
      hops: [
        { host: 'bastion.example.com', port: 22, user: 'me', auth: { method: 'agent' as const } },
      ],
      keepAliveIntervalMs: 15000,
    };
    const tunnelled = { ...base, profile: { ...base.profile, ssh } };
    await expect(createMysqlAdapter({ engine }).connect(tunnelled)).rejects.toMatchObject({
      code: 'NOT_SUPPORTED',
    });
    const endpoint = base.profile.endpoint;
    if (endpoint.kind !== 'host') throw new Error('expected a host endpoint');
    const session = await createMysqlAdapter({ engine }).connect({
      ...tunnelled,
      profile: {
        ...tunnelled.profile,
        endpoint: { kind: 'host', host: 'db.internal.example', port: 3306 },
      },
      endpointOverride: { host: endpoint.host, port: endpoint.port },
    });
    expect(await rows(session, 'SELECT 1')).toEqual([[1]]);
    await session.close();
  });
});
