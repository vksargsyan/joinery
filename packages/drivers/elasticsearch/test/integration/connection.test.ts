import { createServer, type Server } from 'node:net';

import type { ConnectionCheckResult, ResolvedProfile } from '@joinery/core';
import { parseJsonTree, stringAt } from '@joinery/search-tools';
import { beforeAll, describe, expect, it } from 'vitest';

import { createSearchAdapter, isSearchSession, type SearchSession } from '../../src';
import { ES_URL, SERVERS, connect, profileFor } from './helpers';

/**
 * Connecting and Test Connection against the real servers (spec §4): the stepwise check,
 * wrong and missing credentials, API keys and bearer tokens, unreachable nodes, several node
 * URLs, and what a URL can hold.
 */

async function check(resolved: ResolvedProfile): Promise<ConnectionCheckResult[]> {
  const results: ConnectionCheckResult[] = [];
  for await (const result of createSearchAdapter().checkConnection(resolved)) {
    results.push(result);
  }
  return results;
}

function steps(results: readonly ConnectionCheckResult[]): [string, string][] {
  return results.map((r) => [r.step, r.status]);
}

let closed: Server;
let closedPort: number;

beforeAll(async () => {
  // A port that refuses connections: listen, note the port, close.
  closed = createServer();
  await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
  closedPort = (closed.address() as { port: number }).port;
  await new Promise<void>((resolve) => closed.close(() => resolve()));
});

describe.skipIf(SERVERS.length === 0).each(SERVERS)('connection', (server) => {
  it('passes Test Connection step by step', async () => {
    const results = await check(profileFor(server));
    expect(steps(results)).toEqual([
      ['dns', 'skipped'],
      ['tcp', 'ok'],
      ['ssh', 'skipped'],
      ['tls', 'skipped'],
      ['auth', 'ok'],
      ['ping', 'ok'],
      ['version', 'ok'],
    ]);
    expect(results[3]!.message).toContain('unencrypted');
    const version = results[6]!.message!;
    expect(version).toContain('Elasticsearch');
    expect(version).toMatch(/basic licence/);
    expect(results[4]!.message).toBe('Signed in as elastic (realm reserved)');
    expect(results[5]!.message).toMatch(/Cluster health (green|yellow), 1 node/);
  });

  it('fails the TCP step for a closed port with a hint', async () => {
    const url = new URL(server.url);
    url.port = String(closedPort);
    const results = await check(profileFor({ ...server, url: url.toString() }));
    expect(steps(results).slice(0, 3)).toEqual([
      ['dns', 'skipped'],
      ['tcp', 'failed'],
      ['ssh', 'skipped'],
    ]);
    expect(results[1]!.message).toContain('refused');
    expect(results[1]!.hint).toBeDefined();
    await expect(connect({ ...server, url: url.toString() })).rejects.toMatchObject({
      code: 'CONNECTION_FAILED',
    });
  });

  it('fails the TLS step for https to a plain HTTP port', async () => {
    const url = new URL(server.url);
    url.protocol = 'https:';
    const results = await check(
      profileFor({ ...server, url: url.toString() }, { tls: { mode: 'require' } }),
    );
    expect(results.find((r) => r.step === 'tls')).toMatchObject({ status: 'failed' });
    expect(results.find((r) => r.step === 'tls')!.hint).toContain('http://');
  });

  it('uses the other node when the first cannot be reached', async () => {
    const good = new URL(server.url);
    const bad = new URL(server.url);
    bad.port = String(closedPort);
    const resolved = profileFor(server);
    const nodes = [`${bad.protocol}//${bad.host}`, `${good.protocol}//${good.host}`];
    const session = await createSearchAdapter().connect({
      ...resolved,
      profile: { ...resolved.profile, endpoint: { kind: 'urls', urls: nodes } },
    });
    try {
      if (!isSearchSession(session)) throw new Error('expected a SearchSession');
      for (let i = 0; i < 4; i++) await session.ping();
      const results = await check({
        ...resolved,
        profile: { ...resolved.profile, endpoint: { kind: 'urls', urls: nodes } },
      });
      expect(results[1]).toMatchObject({ step: 'tcp', status: 'ok' });
      expect(results[1]!.message).toContain('not reachable');
    } finally {
      await session.close();
    }
  });

  it('sniffs the cluster nodes when asked', async () => {
    const session = await connect(server, { options: { sniff: true } });
    try {
      await session.ping();
      // Requests go to the sniffed nodes. Not a count over `*`: other test files create and
      // delete indices meanwhile, and a search over an index being deleted fails.
      expect((await session.nodes()).length).toBeGreaterThan(0);
    } finally {
      await session.close();
    }
  });
});

describe.skipIf(!ES_URL)('Elasticsearch authentication', () => {
  const server = { url: ES_URL! };
  const withoutPassword = (): string => {
    const url = new URL(ES_URL!);
    url.password = '';
    return url.toString();
  };

  it('fails the auth step for a wrong password, naming the user, never the password', async () => {
    const resolved = profileFor(server);
    const wrong = { ...resolved, secrets: { password: 'not-the-password' } };
    const results = await check(wrong);
    const auth = results.find((r) => r.step === 'auth')!;
    expect(auth).toMatchObject({ status: 'failed' });
    expect(auth.message).toContain('for elastic');
    expect(auth.hint).toContain('user name and password');
    expect(JSON.stringify(results)).not.toContain('not-the-password');
    await expect(createSearchAdapter().connect(wrong)).rejects.toMatchObject({
      code: 'AUTH_FAILED',
    });
  });

  it('asks for credentials when none are sent', async () => {
    const anonymous = profileFor(server, { auth: { method: 'none' } });
    await expect(createSearchAdapter().connect(anonymous)).rejects.toMatchObject({
      code: 'AUTH_FAILED',
      hint: expect.stringContaining('needs credentials'),
    });
    await expect(
      createSearchAdapter().connect(profileFor({ ...server, url: withoutPassword() })),
    ).rejects.toMatchObject({
      code: 'AUTH_FAILED',
    });
  });

  it('signs in with an API key, encoded or as id:key, and refuses an invalid one', async () => {
    const admin = await connect(server);
    let keyId: string | undefined;
    try {
      const created = await admin.request({
        method: 'POST',
        path: '/_security/api_key',
        body: JSON.stringify({ name: 'joinery-it', expiration: '1h' }),
      });
      expect(created.status).toBe(200);
      const node = parseJsonTree(created.body);
      keyId = stringAt(node, 'id')!;
      const encoded = stringAt(node, 'encoded')!;
      const raw = `${keyId}:${stringAt(node, 'api_key')!}`;
      for (const key of [encoded, raw]) {
        const resolved = profileFor(server, { auth: { method: 'apiKey', apiKey: { id: 'key' } } });
        const session = await createSearchAdapter().connect({ ...resolved, secrets: { key } });
        try {
          await session.ping();
        } finally {
          await session.close();
        }
        const results = await check({ ...resolved, secrets: { key } });
        expect(results.find((r) => r.step === 'auth')).toMatchObject({ status: 'ok' });
      }
      const bad = profileFor(server, { auth: { method: 'apiKey', apiKey: { id: 'key' } } });
      await expect(
        createSearchAdapter().connect({ ...bad, secrets: { key: 'bm90OmFrZXk=' } }),
      ).rejects.toMatchObject({ code: 'AUTH_FAILED', hint: expect.stringContaining('API key') });
    } finally {
      if (keyId) {
        await admin.request({
          method: 'DELETE',
          path: '/_security/api_key',
          body: JSON.stringify({ ids: [keyId] }),
        });
      }
      await admin.close();
    }
  });

  it('refuses an invalid bearer token with the token hint', async () => {
    const resolved = profileFor(server, { auth: { method: 'bearer', token: { id: 'token' } } });
    await expect(
      createSearchAdapter().connect({ ...resolved, secrets: { token: 'not-a-token' } }),
    ).rejects.toMatchObject({ code: 'AUTH_FAILED', hint: expect.stringContaining('token') });
  });

  it('reports a missing privilege as such', async () => {
    const admin = await connect(server);
    const user = `joinery-it-${Date.now()}`;
    let limited: SearchSession | undefined;
    try {
      await admin.request({
        method: 'PUT',
        path: `/_security/user/${user}`,
        body: JSON.stringify({ password: 'limited-password', roles: [] }),
      });
      const resolved = profileFor(server, {
        auth: { method: 'password', user, password: { id: 'password' } },
      });
      // No monitor privilege: GET / is refused, but the session still opens.
      limited = (await createSearchAdapter().connect({
        ...resolved,
        secrets: { password: 'limited-password' },
      })) as SearchSession;
      await expect(limited.listIndices()).rejects.toMatchObject({
        code: 'SQL_ERROR',
        hint: expect.stringContaining('privilege'),
      });
      const results = await check({ ...resolved, secrets: { password: 'limited-password' } });
      expect(results.find((r) => r.step === 'auth')!.message).toContain('monitor privilege');
    } finally {
      await limited?.close();
      await admin.request({ method: 'DELETE', path: `/_security/user/${user}` });
      await admin.close();
    }
  });
});
