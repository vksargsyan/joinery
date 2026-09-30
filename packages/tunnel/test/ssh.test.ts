import { generateKeyPairSync } from 'node:crypto';

import ssh2 from 'ssh2';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  MemoryKnownHosts,
  TransportManager,
  knownHostsVerifier,
  openTransport,
  type HostKeyVerifier,
  type Transport,
  type TransportOptions,
} from '../src';
import { toPpk } from './helpers/ppk';
import { connectLocal, echo, hop, resolvedWith, until } from './helpers/profiles';
import {
  closedPort,
  ed25519Pair,
  startAgent,
  startEchoServer,
  startFloodServer,
  startSilentServer,
  startSocks5Server,
  startSshServer,
  type TcpServer,
  type TestSshServer,
} from './helpers/servers';

const PASSWORD = 'correct horse battery staple';
const PASSPHRASE = 'key passphrase 42';

const plainKey = ed25519Pair();
const lockedKey = ed25519Pair({ passphrase: PASSPHRASE });
const pem = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: {
    type: 'pkcs1',
    format: 'pem',
    cipher: 'aes-256-cbc',
    passphrase: PASSPHRASE,
  },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});
const pemPublic = (() => {
  const parsed = ssh2.utils.parseKey(pem.privateKey, PASSPHRASE);
  if (parsed instanceof Error) throw parsed;
  return parsed.getPublicSSH();
})();
const ppkKey = ed25519Pair();

/** Key files by path, served by the injected reader. */
const keyFiles: Record<string, string> = {
  '~/.ssh/id_plain': plainKey.private,
  '~/.ssh/id_locked': lockedKey.private,
  '/keys/rsa.pem': pem.privateKey,
  '/keys/putty.ppk': toPpk(ppkKey.private, { version: 3 }),
  '/keys/putty-v2.ppk': toPpk(ppkKey.private, { version: 2, passphrase: PASSPHRASE }),
};
const readFile = async (path: string): Promise<Buffer> => {
  const text = keyFiles[path];
  if (text === undefined) throw Object.assign(new Error('no such file'), { code: 'ENOENT' });
  return Buffer.from(text);
};

let target: TcpServer;
let server: TestSshServer;

beforeAll(async () => {
  target = await startEchoServer();
  server = await startSshServer({
    users: {
      tunnel: {
        password: PASSWORD,
        publicKeys: [plainKey.public, lockedKey.public, pemPublic, ppkKey.public],
      },
    },
  });
});
afterAll(async () => {
  await server.close();
  await target.close();
});

const open: Transport[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((t) => t.close()));
});

/** A verifier that trusts exactly the test server's key (as if the user accepted it earlier). */
function trusting(...servers: TestSshServer[]): HostKeyVerifier {
  return knownHostsVerifier(
    new MemoryKnownHosts(
      servers.map((s) => ({
        host: '127.0.0.1',
        port: s.port,
        algorithm: s.hostKeyAlgorithm,
        fingerprintSha256: s.hostKeyFingerprint,
      })),
    ),
    'reject',
  );
}

function options(extra: Partial<TransportOptions> = {}): TransportOptions {
  return { hostKeyVerifier: trusting(server), readFile, connectTimeoutMs: 5000, ...extra };
}

type Auth = Parameters<typeof hop>[1];

function profileVia(auth: Auth, secrets: Record<string, string> = {}, extra = {}) {
  return resolvedWith(
    {
      endpoint: { kind: 'host', host: '127.0.0.1', port: target.port },
      ssh: { hops: [hop(server.port, auth)], keepAliveIntervalMs: 0 },
      ...extra,
    },
    secrets,
  );
}

async function openVia(
  auth: Auth,
  secrets: Record<string, string> = {},
  extra: Partial<TransportOptions> = {},
): Promise<Transport> {
  const transport = await openTransport(profileVia(auth, secrets), options(extra));
  open.push(transport!);
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

describe('SSH authentication', () => {
  it('forwards through an SSH server with a password', async () => {
    const transport = await openVia(
      { method: 'password', password: { id: 'ssh-pw' } },
      { 'ssh-pw': PASSWORD },
    );
    expect(transport.endpointOverride.host).toBe('127.0.0.1');
    expect(transport.endpointOverride.port).toBeGreaterThan(0);
    expect(transport.description).toBe(
      `SSH tunnel@127.0.0.1:${server.port} → 127.0.0.1:${target.port}`,
    );
    expect(await echo(transport.endpointOverride, 'hello')).toBe('hello');
    expect(server.stats.forwards.at(-1)).toEqual({ host: '127.0.0.1', port: target.port });
  });

  it('gives every local connection its own channel', async () => {
    const transport = await openVia(
      { method: 'password', password: { id: 'ssh-pw' } },
      { 'ssh-pw': PASSWORD },
    );
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) => echo(transport.endpointOverride, `message ${i}`)),
    );
    expect(results).toEqual(Array.from({ length: 5 }, (_, i) => `message ${i}`));
  });

  it('rejects a wrong password without echoing it', async () => {
    const error = await failure(
      openVia({ method: 'password', password: { id: 'ssh-pw' } }, { 'ssh-pw': 'wrong-pw-123' }),
    );
    expect(error).toMatchObject({
      code: 'SSH_FAILED',
      engineCode: 'AUTH_REJECTED',
      message: expect.stringContaining('rejected the password for user "tunnel"'),
      hint: expect.stringContaining('password'),
    });
    expect(JSON.stringify(error)).not.toContain('wrong-pw-123');
    expect(String(error)).not.toContain('wrong-pw-123');
  });

  it('asks for a password that was not provided', async () => {
    await expect(
      openVia({ method: 'password', password: { id: 'ssh-pw', policy: 'ask' } }),
    ).rejects.toMatchObject({ code: 'SSH_FAILED', engineCode: 'PASSWORD_REQUIRED' });
  });

  it('logs in with an OpenSSH key, with and without a passphrase', async () => {
    const plain = await openVia({ method: 'privateKey', keyPath: '~/.ssh/id_plain' });
    expect(await echo(plain.endpointOverride)).toBe('ping through the tunnel');

    const locked = await openVia(
      { method: 'privateKey', keyPath: '~/.ssh/id_locked', passphrase: { id: 'kp' } },
      { kp: PASSPHRASE },
    );
    expect(await echo(locked.endpointOverride)).toBe('ping through the tunnel');
  });

  it('logs in with an encrypted PEM key', async () => {
    const transport = await openVia(
      { method: 'privateKey', keyPath: '/keys/rsa.pem', passphrase: { id: 'kp' } },
      { kp: PASSPHRASE },
    );
    expect(await echo(transport.endpointOverride)).toBe('ping through the tunnel');
  });

  it('logs in with PuTTY keys (PPK v3 Ed25519, encrypted PPK v2)', async () => {
    const v3 = await openVia({ method: 'privateKey', keyPath: '/keys/putty.ppk' });
    expect(await echo(v3.endpointOverride)).toBe('ping through the tunnel');
    const v2 = await openVia(
      { method: 'privateKey', keyPath: '/keys/putty-v2.ppk', passphrase: { id: 'kp' } },
      { kp: PASSPHRASE },
    );
    expect(await echo(v2.endpointOverride)).toBe('ping through the tunnel');
  });

  it('names a missing or wrong passphrase, and an unreadable key file', async () => {
    await expect(
      openVia({ method: 'privateKey', keyPath: '~/.ssh/id_locked' }),
    ).rejects.toMatchObject({ code: 'SSH_FAILED', engineCode: 'PASSPHRASE_REQUIRED' });
    const wrong = await failure(
      openVia(
        { method: 'privateKey', keyPath: '~/.ssh/id_locked', passphrase: { id: 'kp' } },
        { kp: 'bad-phrase-77' },
      ),
    );
    expect(wrong).toMatchObject({ engineCode: 'BAD_PASSPHRASE' });
    expect(JSON.stringify(wrong)).not.toContain('bad-phrase-77');
    await expect(
      openVia({ method: 'privateKey', keyPath: '/missing/id_rsa' }),
    ).rejects.toMatchObject({
      code: 'SSH_FAILED',
      message: expect.stringContaining('/missing/id_rsa'),
      engineCode: 'ENOENT',
    });
  });

  it('reports a key the server does not accept', async () => {
    const stranger = ed25519Pair();
    keyFiles['/keys/stranger'] = stranger.private;
    await expect(
      openVia({ method: 'privateKey', keyPath: '/keys/stranger' }),
    ).rejects.toMatchObject({
      code: 'SSH_FAILED',
      engineCode: 'AUTH_REJECTED',
      hint: expect.stringContaining('authorized_keys'),
    });
  });

  it('logs in through an ssh-agent', async () => {
    const agent = await startAgent(plainKey.private);
    try {
      const transport = await openVia({ method: 'agent' }, {}, { agent: agent.socketPath });
      expect(await echo(transport.endpointOverride)).toBe('ping through the tunnel');
    } finally {
      await agent.close();
    }
    const stranger = await startAgent(ed25519Pair().private);
    try {
      await expect(
        openVia({ method: 'agent' }, {}, { agent: stranger.socketPath }),
      ).rejects.toMatchObject({
        engineCode: 'AUTH_REJECTED',
        hint: expect.stringContaining('ssh-add'),
      });
    } finally {
      await stranger.close();
    }
  });
});

describe('host key verification', () => {
  it('never accepts an unknown host key silently', async () => {
    const before = server.stats.authenticated;
    const error = await failure(
      openVia(
        { method: 'password', password: { id: 'ssh-pw' } },
        { 'ssh-pw': PASSWORD },
        { hostKeyVerifier: knownHostsVerifier(new MemoryKnownHosts(), 'reject') },
      ),
    );
    expect(error).toMatchObject({
      code: 'SSH_FAILED',
      engineCode: 'HOST_KEY_REJECTED',
      message: expect.stringContaining(server.hostKeyFingerprint),
    });
    // The password was never sent.
    expect(server.stats.authenticated).toBe(before);
  });

  it('trusts a key once the verifier accepts it, and remembers it', async () => {
    const store = new MemoryKnownHosts();
    const prompts: string[] = [];
    const verifier = knownHostsVerifier(store, async (host, port, key) => {
      prompts.push(`${host}:${port} ${key.algorithm} ${key.fingerprintSha256}`);
      return 'trust' as const;
    });
    const auth = { method: 'password' as const, password: { id: 'ssh-pw' } };
    await openVia(auth, { 'ssh-pw': PASSWORD }, { hostKeyVerifier: verifier });
    await openVia(auth, { 'ssh-pw': PASSWORD }, { hostKeyVerifier: verifier });
    expect(prompts).toEqual([`127.0.0.1:${server.port} ssh-ed25519 ${server.hostKeyFingerprint}`]);
    expect(store.entries()).toHaveLength(1);
  });

  it('refuses a changed host key loudly', async () => {
    const before = server.stats.authenticated;
    const store = new MemoryKnownHosts([
      {
        host: '127.0.0.1',
        port: server.port,
        algorithm: 'ssh-ed25519',
        fingerprintSha256: 'SHA256:0ldK3yTh4tTh3S3rv3rUs3dT0H4v3AAAAAAAAAAAAAA',
      },
    ]);
    const error = await failure(
      openVia(
        { method: 'password', password: { id: 'ssh-pw' } },
        { 'ssh-pw': PASSWORD },
        { hostKeyVerifier: knownHostsVerifier(store, 'accept-new') },
      ),
    );
    expect(error).toMatchObject({ code: 'SSH_FAILED', engineCode: 'HOST_KEY_CHANGED' });
    expect((error as Error).message).toMatch(/WARNING: .* has CHANGED/);
    expect(server.stats.authenticated).toBe(before);
  });

  it('does not count time spent asking the user against the connect timeout', async () => {
    const transport = await openVia(
      { method: 'password', password: { id: 'ssh-pw' } },
      { 'ssh-pw': PASSWORD },
      {
        connectTimeoutMs: 400,
        hostKeyVerifier: async () => {
          await new Promise((resolve) => setTimeout(resolve, 800));
          return 'trust' as const;
        },
      },
    );
    expect(await echo(transport.endpointOverride)).toBe('ping through the tunnel');
  });
});

describe('chains, proxies and keep-alives', () => {
  it('reaches the endpoint through two jump hosts', async () => {
    const inner = await startSshServer({ users: { deploy: { password: 'inner-pw' } } });
    try {
      const resolved = resolvedWith(
        {
          endpoint: { kind: 'host', host: '127.0.0.1', port: target.port },
          ssh: {
            hops: [
              hop(server.port, { method: 'password', password: { id: 'outer' } }),
              hop(inner.port, { method: 'password', password: { id: 'inner' } }, 'deploy'),
            ],
          },
        },
        { outer: PASSWORD, inner: 'inner-pw' },
      );
      const forwardsBefore = server.stats.forwards.length;
      const transport = (await openTransport(resolved, {
        ...options(),
        hostKeyVerifier: trusting(server, inner),
      }))!;
      open.push(transport);
      expect(transport.description).toBe(
        `SSH tunnel@127.0.0.1:${server.port} → deploy@127.0.0.1:${inner.port} → 127.0.0.1:${target.port}`,
      );
      expect(await echo(transport.endpointOverride, 'two hops')).toBe('two hops');
      // The outer server forwarded to the inner SSH server; the inner one to the endpoint.
      expect(server.stats.forwards.slice(forwardsBefore)).toEqual([
        { host: '127.0.0.1', port: inner.port },
      ]);
      expect(inner.stats.forwards).toEqual([{ host: '127.0.0.1', port: target.port }]);
      expect(inner.stats.connections).toBe(1);
    } finally {
      await inner.close();
    }
  });

  it('runs the first hop through a SOCKS5 proxy', async () => {
    const proxy = await startSocks5Server();
    try {
      const resolved = resolvedWith(
        {
          endpoint: { kind: 'host', host: '127.0.0.1', port: target.port },
          ssh: { hops: [hop(server.port, { method: 'password', password: { id: 'pw' } })] },
          proxy: { kind: 'socks5', host: '127.0.0.1', port: proxy.port },
        },
        { pw: PASSWORD },
      );
      const transport = (await openTransport(resolved, options()))!;
      open.push(transport);
      expect(transport.description).toContain('SOCKS5 proxy');
      expect(await echo(transport.endpointOverride)).toBe('ping through the tunnel');
      expect(proxy.stats.destinations).toEqual([`127.0.0.1:${server.port}`]);
    } finally {
      await proxy.close();
    }
  });

  it('sends keep-alives at the profile interval, and none when it is 0', async () => {
    const quiet = await startSshServer({ users: { tunnel: { password: PASSWORD } } });
    const busy = await startSshServer({ users: { tunnel: { password: PASSWORD } } });
    try {
      const make = (s: TestSshServer, keepAliveIntervalMs: number) =>
        resolvedWith(
          {
            endpoint: { kind: 'host', host: '127.0.0.1', port: target.port },
            ssh: {
              hops: [hop(s.port, { method: 'password', password: { id: 'pw' } })],
              keepAliveIntervalMs,
            },
          },
          { pw: PASSWORD },
        );
      const verifier = trusting(quiet, busy);
      open.push(
        (await openTransport(make(quiet, 0), { ...options(), hostKeyVerifier: verifier }))!,
      );
      open.push(
        (await openTransport(make(busy, 40), { ...options(), hostKeyVerifier: verifier }))!,
      );
      await until(() => busy.stats.keepalives >= 3);
      expect(quiet.stats.keepalives).toBe(0);
    } finally {
      await quiet.close();
      await busy.close();
    }
  });
});

describe('shared bastion sessions', () => {
  it('reuses one SSH session for profiles that share a bastion, and releases it', async () => {
    const bastion = await startSshServer({
      users: { tunnel: { password: PASSWORD }, other: { password: PASSWORD } },
    });
    const manager = new TransportManager({ ...options(), hostKeyVerifier: trusting(bastion) });
    try {
      const profileFor = (id: string, secretId: string, user = 'tunnel') => ({
        ...resolvedWith(
          {
            id,
            endpoint: { kind: 'host', host: '127.0.0.1', port: target.port },
            ssh: {
              hops: [hop(bastion.port, { method: 'password', password: { id: secretId } }, user)],
            },
          },
          { [secretId]: PASSWORD },
        ),
      });
      const [a, b] = await Promise.all([
        manager.open(profileFor('a', 'a-ssh')),
        manager.open(profileFor('b', 'b-ssh')),
      ]);
      expect(bastion.stats.connections).toBe(1);
      expect(manager.sessionCount).toBe(1);
      expect(a!.endpointOverride.port).not.toBe(b!.endpointOverride.port);
      expect(await echo(a!.endpointOverride, 'a')).toBe('a');
      expect(await echo(b!.endpointOverride, 'b')).toBe('b');

      // Another user is another session.
      const c = await manager.open(profileFor('c', 'c-ssh', 'other'));
      expect(bastion.stats.connections).toBe(2);
      await c!.close();

      await a!.close();
      expect(manager.sessionCount).toBe(1);
      expect(await echo(b!.endpointOverride, 'still up')).toBe('still up');
      await b!.close();
      expect(manager.sessionCount).toBe(0);
      await until(() => bastion.stats.active === 0);
    } finally {
      manager.closeAll();
      await bastion.close();
    }
  });

  it('drops a failed session, reports it, and reconnects on the next connection', async () => {
    const bastion = await startSshServer({ users: { tunnel: { password: PASSWORD } } });
    const manager = new TransportManager({ ...options(), hostKeyVerifier: trusting(bastion) });
    try {
      const resolved = resolvedWith(
        {
          endpoint: { kind: 'host', host: '127.0.0.1', port: target.port },
          ssh: { hops: [hop(bastion.port, { method: 'password', password: { id: 'pw' } })] },
        },
        { pw: PASSWORD },
      );
      const transport = (await manager.open(resolved))!;
      open.push(transport);
      const errors: { engineCode?: string | number }[] = [];
      transport.onError((error) => errors.push(error));
      expect(await echo(transport.endpointOverride, 'before')).toBe('before');

      bastion.dropAll();
      await until(() => errors.length === 1);
      expect(errors[0]).toMatchObject({ engineCode: 'SSH_DISCONNECTED' });
      expect(manager.sessionCount).toBe(0);

      expect(await echo(transport.endpointOverride, 'after')).toBe('after');
      expect(bastion.stats.connections).toBe(2);
      expect(manager.sessionCount).toBe(1);

      // A new transport shares the reconnected session.
      const second = (await manager.open(resolved))!;
      open.push(second);
      expect(bastion.stats.connections).toBe(2);
    } finally {
      await Promise.all(open.splice(0).map((t) => t.close()));
      manager.closeAll();
      await bastion.close();
    }
  });
  it('reconnects only the hop that dropped, reporting it once', async () => {
    const outer = await startSshServer({ users: { tunnel: { password: PASSWORD } } });
    const inner = await startSshServer({ users: { tunnel: { password: PASSWORD } } });
    const manager = new TransportManager({
      ...options(),
      hostKeyVerifier: trusting(outer, inner),
    });
    try {
      const auth = { method: 'password' as const, password: { id: 'pw' } };
      const transport = (await manager.open(
        resolvedWith(
          {
            endpoint: { kind: 'host', host: '127.0.0.1', port: target.port },
            ssh: { hops: [hop(outer.port, auth), hop(inner.port, auth)] },
          },
          { pw: PASSWORD },
        ),
      ))!;
      open.push(transport);
      const errors: unknown[] = [];
      transport.onError((error) => errors.push(error));
      expect(manager.sessionCount).toBe(2);

      outer.dropAll();
      await until(() => errors.length > 0 && manager.sessionCount === 0);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(errors).toHaveLength(1);
      expect(await echo(transport.endpointOverride, 'both back')).toBe('both back');
      expect([outer.stats.connections, inner.stats.connections]).toEqual([2, 2]);

      inner.dropAll();
      await until(() => errors.length === 2);
      expect(await echo(transport.endpointOverride, 'inner back')).toBe('inner back');
      expect([outer.stats.connections, inner.stats.connections]).toEqual([2, 3]);
    } finally {
      await Promise.all(open.splice(0).map((t) => t.close()));
      manager.closeAll();
      await outer.close();
      await inner.close();
    }
  });
});

describe('forwarding failures and closing', () => {
  it('names a server that refuses to forward (AllowTcpForwarding no)', async () => {
    const strict = await startSshServer({
      users: { tunnel: { password: PASSWORD } },
      forwarding: 'prohibit',
    });
    try {
      const resolved = resolvedWith(
        {
          endpoint: { kind: 'host', host: '127.0.0.1', port: target.port },
          ssh: { hops: [hop(strict.port, { method: 'password', password: { id: 'pw' } })] },
        },
        { pw: PASSWORD },
      );
      const transport = (await openTransport(resolved, {
        ...options(),
        hostKeyVerifier: trusting(strict),
      }))!;
      open.push(transport);
      const errors: unknown[] = [];
      transport.onError((error) => errors.push(error));
      expect(await failure(transport.probe())).toMatchObject({
        code: 'SSH_FAILED',
        engineCode: 'FORWARD_PROHIBITED',
        hint: expect.stringContaining('AllowTcpForwarding'),
      });
      // A driver connection is closed, and the reason goes to onError.
      expect(await echo(transport.endpointOverride).catch(() => '')).toBe('');
      await until(() => errors.length === 1);
    } finally {
      await strict.close();
    }
  });

  it('names an endpoint the SSH server cannot reach', async () => {
    const transport = await openTransport(
      resolvedWith(
        {
          endpoint: { kind: 'host', host: '127.0.0.1', port: await closedPort() },
          ssh: { hops: [hop(server.port, { method: 'password', password: { id: 'pw' } })] },
        },
        { pw: PASSWORD },
      ),
      options(),
    );
    open.push(transport!);
    await expect(transport!.probe()).rejects.toMatchObject({
      code: 'CONNECTION_FAILED',
      engineCode: 'FORWARD_CONNECT_FAILED',
      hint: expect.stringContaining('as the SSH server sees them'),
    });
  });

  it('names an unreachable SSH server and one that never answers', async () => {
    const refused = await failure(
      openTransport(
        resolvedWith({
          ssh: { hops: [hop(await closedPort(), { method: 'agent' })] },
        }),
        { ...options(), agent: '/nonexistent/agent.sock' },
      ),
    );
    expect(refused).toMatchObject({
      code: 'CONNECTION_FAILED',
      message: expect.stringContaining('SSH server'),
    });

    const silent = await startSilentServer();
    try {
      const started = Date.now();
      await expect(
        openTransport(
          resolvedWith(
            {
              ssh: {
                hops: [hop(silent.port, { method: 'password', password: { id: 'pw' } })],
              },
            },
            { pw: 'x' },
          ),
          { ...options(), connectTimeoutMs: 300 },
        ),
      ).rejects.toMatchObject({ code: 'SSH_FAILED', message: expect.stringMatching(/0\.3 s/) });
      expect(Date.now() - started).toBeLessThan(3000);
    } finally {
      await silent.close();
    }
  });

  it('closes the listener and every channel when closed mid-stream', async () => {
    const flood = await startFloodServer();
    try {
      const transport = (await openTransport(
        resolvedWith(
          {
            endpoint: { kind: 'host', host: '127.0.0.1', port: flood.port },
            ssh: { hops: [hop(server.port, { method: 'password', password: { id: 'pw' } })] },
          },
          { pw: PASSWORD },
        ),
        options(),
      ))!;
      const socket = await connectLocal(transport.endpointOverride);
      let received = 0;
      const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()));
      socket.on('error', () => undefined);
      await new Promise<void>((resolve) => {
        socket.on('data', (chunk: Buffer) => {
          received += chunk.length;
          if (received > 1024 * 1024) resolve();
        });
      });
      await transport.close();
      await closed;
      await until(() => flood.open.size === 0);
      await expect(connectLocal(transport.endpointOverride)).rejects.toMatchObject({
        code: 'ECONNREFUSED',
      });
    } finally {
      await flood.close();
    }
  });

  it('refuses a socket endpoint with NOT_SUPPORTED', async () => {
    await expect(
      openTransport(
        resolvedWith({
          endpoint: { kind: 'socket', path: '/tmp/.s.PGSQL.5432' },
          ssh: { hops: [hop(server.port, { method: 'agent' })] },
        }),
        options(),
      ),
    ).rejects.toMatchObject({ code: 'NOT_SUPPORTED' });
  });

  it('opens nothing for a profile without a tunnel or proxy', async () => {
    expect(await openTransport(resolvedWith({}), options())).toBeUndefined();
  });
});
