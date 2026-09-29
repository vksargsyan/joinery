import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { MemoryKnownHosts, knownHostsVerifier, openTransport, type Transport } from '../src';
import { connectThroughProxy } from '../src/proxy';
import { echo, resolvedWith } from './helpers/profiles';
import {
  closedPort,
  startEchoServer,
  startHttpProxy,
  startSilentServer,
  startSocks5Server,
  type ProxyServer,
  type TcpServer,
} from './helpers/servers';

const verifier = knownHostsVerifier(new MemoryKnownHosts(), 'reject');
const credentials = { user: 'proxy-user', password: 'proxy-secret-pw' };

let target: TcpServer;
let socks: ProxyServer;
let socksAuth: ProxyServer;
let http: ProxyServer;
let httpAuth: ProxyServer;

beforeAll(async () => {
  target = await startEchoServer();
  socks = await startSocks5Server();
  socksAuth = await startSocks5Server(credentials);
  http = await startHttpProxy();
  httpAuth = await startHttpProxy(credentials);
});
afterAll(async () => {
  await Promise.all([target, socks, socksAuth, http, httpAuth].map((s) => s.close()));
});

async function viaProxy(
  kind: 'socks5' | 'http',
  port: number,
  auth?: { user?: string; password?: string },
): Promise<Transport> {
  const resolved = resolvedWith(
    {
      endpoint: { kind: 'host', host: '127.0.0.1', port: target.port },
      proxy: {
        kind,
        host: '127.0.0.1',
        port,
        ...(auth?.user !== undefined ? { user: auth.user } : {}),
        ...(auth?.password !== undefined ? { password: { id: 'proxy-pw' } } : {}),
      },
    },
    auth?.password !== undefined ? { 'proxy-pw': auth.password } : {},
  );
  const transport = await openTransport(resolved, { hostKeyVerifier: verifier });
  return transport!;
}

async function failure(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error('expected a failure');
    },
    (error: unknown) => error,
  );
}

describe.each([
  ['socks5', () => socks, () => socksAuth],
  ['http', () => http, () => httpAuth],
] as const)('%s proxy transport', (kind, plain, withAuth) => {
  it('forwards every local connection through the proxy', async () => {
    const transport = await viaProxy(kind, plain().port);
    try {
      expect(transport.endpointOverride.host).toBe('127.0.0.1');
      expect(transport.description).toContain(`127.0.0.1:${target.port}`);
      const before = plain().stats.connections;
      expect(await echo(transport.endpointOverride, 'one')).toBe('one');
      expect(await echo(transport.endpointOverride, 'two')).toBe('two');
      expect(plain().stats.connections - before).toBe(2);
      expect(plain().stats.destinations.at(-1)).toBe(`127.0.0.1:${target.port}`);
    } finally {
      await transport.close();
    }
  });

  it('authenticates with the proxy user and password', async () => {
    const transport = await viaProxy(kind, withAuth().port, credentials);
    try {
      await transport.probe();
      expect(await echo(transport.endpointOverride)).toBe('ping through the tunnel');
    } finally {
      await transport.close();
    }
  });

  it('reports rejected credentials without echoing them', async () => {
    const transport = await viaProxy(kind, withAuth().port, {
      user: credentials.user,
      password: 'not-the-password',
    });
    try {
      const error = await failure(transport.probe());
      expect(error).toMatchObject({
        code: 'CONNECTION_FAILED',
        engineCode: 'PROXY_AUTH_FAILED',
        hint: expect.stringContaining('proxy user and password'),
      });
      expect(JSON.stringify(error)).not.toContain('not-the-password');

      const errors: unknown[] = [];
      transport.onError((e) => errors.push(e));
      // The driver's socket is closed; the listener learns why.
      expect(await echo(transport.endpointOverride).catch(() => '')).toBe('');
      await expect.poll(() => errors.length).toBe(1);
    } finally {
      await transport.close();
    }
  });

  it('asks for credentials the proxy requires', async () => {
    const transport = await viaProxy(kind, withAuth().port);
    try {
      expect(await failure(transport.probe())).toMatchObject({
        engineCode: 'PROXY_AUTH_FAILED',
        message: expect.stringMatching(/requires a user name and password/),
      });
    } finally {
      await transport.close();
    }
  });

  it('names an unreachable proxy', async () => {
    const transport = await viaProxy(kind, await closedPort());
    try {
      expect(await failure(transport.probe())).toMatchObject({
        code: 'CONNECTION_FAILED',
        message: expect.stringMatching(/refused/),
        hint: expect.stringContaining('running'),
      });
    } finally {
      await transport.close();
    }
  });
});

describe('connectThroughProxy', () => {
  it('reports a destination the proxy cannot reach', async () => {
    const port = await closedPort();
    const target = { host: '127.0.0.1', port };
    await expect(
      connectThroughProxy(
        { kind: 'socks5', host: '127.0.0.1', port: socks.port },
        {},
        target,
        2000,
      ),
    ).rejects.toMatchObject({ code: 'CONNECTION_FAILED', engineCode: 'PROXY_REFUSED' });
    await expect(
      connectThroughProxy({ kind: 'http', host: '127.0.0.1', port: http.port }, {}, target, 2000),
    ).rejects.toMatchObject({
      code: 'CONNECTION_FAILED',
      engineCode: 'PROXY_REFUSED',
      message: expect.stringContaining('502'),
    });
    const refusing = await startSocks5Server(undefined, { refuse: true });
    try {
      await expect(
        connectThroughProxy(
          { kind: 'socks5', host: '127.0.0.1', port: refusing.port },
          {},
          { host: 'db', port: 5432 },
          2000,
        ),
      ).rejects.toMatchObject({ message: expect.stringContaining('do not allow') });
    } finally {
      await refusing.close();
    }
  });

  it('times out on a proxy that never answers', async () => {
    const silent = await startSilentServer();
    try {
      for (const kind of ['socks5', 'http'] as const) {
        const started = Date.now();
        await expect(
          connectThroughProxy(
            { kind, host: '127.0.0.1', port: silent.port },
            {},
            { host: 'db', port: 1 },
            300,
          ),
        ).rejects.toMatchObject({
          code: 'CONNECTION_FAILED',
          message: expect.stringMatching(/0\.3 s/),
        });
        expect(Date.now() - started).toBeLessThan(2000);
      }
    } finally {
      await silent.close();
    }
  });

  it('refuses a missing proxy password before connecting', async () => {
    await expect(
      connectThroughProxy(
        {
          kind: 'http',
          host: '127.0.0.1',
          port: http.port,
          user: 'u',
          password: { id: 'gone', policy: 'ask' },
        },
        {},
        { host: 'db', port: 1 },
        1000,
      ),
    ).rejects.toMatchObject({ engineCode: 'PASSWORD_REQUIRED' });
  });
});
