import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { inspect } from 'node:util';

import { connectionProfileSchema } from '@joinery/core';
import { openStore } from '@joinery/storage';
import ssh2 from 'ssh2';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { proxyUrl, sshHop } from '../src/options';
import { Reporter } from '../src/reporter';
import { StoreHandle, cliSealer } from '../src/store';
import { resolveTarget, resolvedProfile, type TargetDeps } from '../src/target';
import { defaultKnownHostsPath } from '../src/tunnels';
import { FakeAdapter, FakeSession, MemoryStream, ScriptedPrompter, run, tempDir } from './helpers';
import { ed25519Key, startEchoServer, startSshServer, type TestSshServer } from './ssh-server';

/**
 * SSH tunnels and proxies in joinery-cli (spec §4): the --ssh and --proxy flags, the secrets a
 * route needs, saved profiles with a tunnel, and `joinery test` through a real in-process SSH
 * server with a fake driver behind it.
 */

const SSH_PASSWORD = 'bastion-Secret-77';
const URI = 'postgres://app@db.internal:5432/shop?sslmode=disable';

describe('--ssh and --proxy values', () => {
  it('parses user@host[:port] hops', () => {
    expect(sshHop('ops@bastion')).toEqual({ user: 'ops', host: 'bastion', port: 22 });
    expect(sshHop('ops@bastion.example.com:2222')).toEqual({
      user: 'ops',
      host: 'bastion.example.com',
      port: 2222,
    });
    expect(sshHop('ops@[::1]:22')).toEqual({ user: 'ops', host: '::1', port: 22 });
    for (const bad of [
      'bastion',
      'ops@',
      '@bastion',
      'ops@h:0',
      'ops@h:70000',
      'ops@h:x',
      'a@b@c',
    ]) {
      expect(() => sshHop(bad), bad).toThrow(/user@host|port/);
    }
  });

  it('parses SOCKS5 and HTTP proxy URLs', () => {
    expect(proxyUrl('socks5://proxy.internal:1081')).toEqual({
      kind: 'socks5',
      host: 'proxy.internal',
      port: 1081,
    });
    expect(proxyUrl('http://proxy:3128')).toEqual({ kind: 'http', host: 'proxy', port: 3128 });
    expect(proxyUrl('socks5h://me:p%40ss@proxy')).toEqual({
      kind: 'socks5',
      host: 'proxy',
      port: 1080,
      user: 'me',
      password: 'p@ss',
    });
    expect(proxyUrl('http://proxy')).toMatchObject({ port: 80 });
    for (const bad of ['ftp://proxy:21', 'proxy:1080', 'socks5://proxy:1080/x', 'not a url']) {
      expect(() => proxyUrl(bad), bad).toThrow();
    }
  });

  it('rejects bad values and conflicting logins on the command line', async () => {
    const bad = await run(['test', URI, '--ssh', 'bastion']);
    expect(bad.code).toBe(2);
    expect(bad.stderr).toMatch(/--ssh <user@host\[:port\]>.*user@host/s);
    const both = await run(['test', URI, '--ssh', 'ops@b', '--ssh-key', '/k', '--ssh-agent']);
    expect(both.code).toBe(2);
    expect(both.stderr).toMatch(/cannot be used with/);
    const proxy = await run(['query', URI, '-e', 'select 1', '--proxy', 'ftp://me:pw-123@p:21']);
    expect(proxy.code).toBe(2);
    expect(proxy.stderr).toMatch(/--proxy ftp:\/\/me:\*\*\*@p:21: Use a socks5:\/\/ or http:\/\//);
    expect(proxy.stderr).not.toContain('pw-123');
  });

  it('lists the options in the help of every command that connects', async () => {
    for (const command of ['test', 'query', 'compare', 'data-compare', 'ddl']) {
      const help = await run([command, '--help']);
      expect(help.stdout, command).toContain('--ssh <user@host[:port]>');
      expect(help.stdout, command).toContain('--ssh-accept-new');
      expect(help.stdout, command).toContain('--known-hosts <path>');
    }
    expect((await run(['--help'])).stdout).toContain('SSH tunnels and proxies:');
  });
});

function deps(
  store: StoreHandle,
  env: Record<string, string> = {},
  prompter = new ScriptedPrompter(false),
): TargetDeps & { stderr: MemoryStream } {
  const stderr = new MemoryStream();
  return { store, env, prompter, reporter: new Reporter(stderr, { verbose: true }), stderr };
}

describe('URI targets with --ssh and --proxy', () => {
  let dir: string;
  let cleanup: () => void;
  let store: StoreHandle;
  beforeEach(() => {
    ({ dir, cleanup } = tempDir());
    store = new StoreHandle({ path: join(dir, 'joinery.db'), source: '--store' }, {});
  });
  afterEach(() => {
    store.close();
    cleanup();
  });

  const hops = [
    { user: 'ops', host: 'jump', port: 22 },
    { user: 'tunnel', host: 'bastion', port: 2222 },
  ];

  it('builds jump hosts in order with the password from --ssh-password-env, never shown', async () => {
    const target = await resolveTarget(
      URI,
      { tunnel: { ssh: hops, sshPasswordEnv: 'BASTION_PW' } },
      deps(store, { BASTION_PW: SSH_PASSWORD }),
    );
    const resolved = resolvedProfile(target);
    expect(resolved.profile.ssh?.hops.map((h) => `${h.user}@${h.host}:${h.port}`)).toEqual([
      'ops@jump:22',
      'tunnel@bastion:2222',
    ]);
    for (const hop of resolved.profile.ssh?.hops ?? []) {
      expect(hop.auth.method).toBe('password');
      if (hop.auth.method === 'password') {
        expect(resolved.secrets[hop.auth.password.id]).toBe(SSH_PASSWORD);
      }
    }
    expect(JSON.stringify(target)).not.toContain(SSH_PASSWORD);
    expect(inspect(target, { depth: 10 })).not.toContain(SSH_PASSWORD);
    // A URI profile is still valid with its tunnel.
    expect(() => connectionProfileSchema.parse(resolved.profile)).not.toThrow();
  });

  it('takes the SSH password from JOINERY_SSH_PASSWORD, a prompt per hop, or fails with a hint', async () => {
    const fromEnv = await resolveTarget(
      URI,
      { tunnel: { ssh: hops.slice(0, 1) } },
      deps(store, { JOINERY_SSH_PASSWORD: SSH_PASSWORD }),
    );
    expect(Object.values(resolvedProfile(fromEnv).secrets)).toEqual([SSH_PASSWORD]);

    const prompter = new ScriptedPrompter(true, { secret: ['one', 'two'] });
    await resolveTarget(URI, { tunnel: { ssh: hops } }, deps(store, {}, prompter));
    expect(prompter.asked).toEqual([
      'SSH password for ops@jump:22: ',
      'SSH password for tunnel@bastion:2222: ',
    ]);

    await expect(resolveTarget(URI, { tunnel: { ssh: hops } }, deps(store))).rejects.toMatchObject({
      code: 'AUTH_FAILED',
      hint: expect.stringContaining('--ssh-key'),
    });
    await expect(
      resolveTarget(URI, { tunnel: { ssh: hops, sshPasswordEnv: 'NOPE' } }, deps(store)),
    ).rejects.toMatchObject({ message: '--ssh-password-env: NOPE is not set' });
  });

  it('uses the agent or a key file, asking for the passphrase of an encrypted key', async () => {
    const agent = await resolveTarget(URI, { tunnel: { ssh: hops, sshAgent: true } }, deps(store));
    expect(agent.profile.ssh?.hops.map((h) => h.auth)).toEqual([
      { method: 'agent' },
      { method: 'agent' },
    ]);

    const plain = join(dir, 'id_plain');
    writeFileSync(plain, ed25519Key());
    const withKey = await resolveTarget(URI, { tunnel: { ssh: hops, sshKey: plain } }, deps(store));
    expect(withKey.profile.ssh?.hops[1]?.auth).toEqual({ method: 'privateKey', keyPath: plain });

    const locked = join(dir, 'id_locked');
    writeFileSync(
      locked,
      ssh2.utils.generateKeyPairSync('ed25519', {
        passphrase: 'k3y',
        cipher: 'aes256-ctr',
        rounds: 2,
      }).private,
    );
    const env = { JOINERY_SSH_KEY_PASSPHRASE: 'k3y' };
    const unlocked = resolvedProfile(
      await resolveTarget(URI, { tunnel: { ssh: hops, sshKey: locked } }, deps(store, env)),
    );
    const auth = unlocked.profile.ssh?.hops[0]?.auth;
    expect(auth?.method === 'privateKey' && auth.passphrase).toBeTruthy();
    if (auth?.method === 'privateKey' && auth.passphrase) {
      expect(unlocked.secrets[auth.passphrase.id]).toBe('k3y');
    }
    await expect(
      resolveTarget(
        URI,
        { tunnel: { ssh: hops, sshKey: locked } },
        deps(store, { JOINERY_SSH_KEY_PASSPHRASE: 'wrong' }),
      ),
    ).rejects.toMatchObject({ engineCode: 'BAD_PASSPHRASE' });
    await expect(
      resolveTarget(URI, { tunnel: { ssh: hops, sshKey: locked } }, deps(store)),
    ).rejects.toMatchObject({ hint: expect.stringContaining('JOINERY_SSH_KEY_PASSPHRASE') });
    await expect(
      resolveTarget(URI, { tunnel: { ssh: hops, sshKey: join(dir, 'missing') } }, deps(store)),
    ).rejects.toMatchObject({ message: expect.stringContaining('ENOENT') });
  });

  it('adds a proxy with its password, and refuses login flags without --ssh', async () => {
    const target = await resolveTarget(
      URI,
      { tunnel: { proxy: { kind: 'socks5', host: 'proxy', port: 1080, user: 'me' } } },
      deps(store, { JOINERY_PROXY_PASSWORD: 'proxy-pw' }),
    );
    const resolved = resolvedProfile(target);
    expect(resolved.profile.proxy).toMatchObject({ kind: 'socks5', host: 'proxy', user: 'me' });
    expect(resolved.secrets[resolved.profile.proxy!.password!.id]).toBe('proxy-pw');
    expect(resolved.profile.ssh).toBeUndefined();
    await expect(
      resolveTarget(URI, { tunnel: { sshAgent: true } }, deps(store)),
    ).rejects.toMatchObject({ message: expect.stringContaining('need --ssh user@host') });
  });
});

describe('saved profiles with a tunnel', () => {
  let dir: string;
  let cleanup: () => void;
  beforeEach(() => {
    ({ dir, cleanup } = tempDir());
  });
  afterEach(() => cleanup());

  it('asks for their SSH secrets or takes them from the environment', async () => {
    const path = join(dir, 'joinery.db');
    const raw = openStore(path, { sealer: cliSealer({}) });
    const now = new Date().toISOString();
    raw.profiles.save(
      connectionProfileSchema.parse({
        id: 'p1',
        name: 'prod',
        engine: 'postgres',
        endpoint: { kind: 'host', host: '10.0.0.5', port: 5432 },
        auth: { method: 'none' },
        ssh: {
          hops: [
            {
              host: 'bastion',
              user: 'ops',
              auth: { method: 'password', password: { id: 'ssh-ref', policy: 'ask' } },
            },
          ],
        },
        proxy: {
          kind: 'http',
          host: 'proxy',
          port: 3128,
          password: { id: 'proxy-ref', policy: 'ask' },
        },
        createdAt: now,
        updatedAt: now,
      }),
    );
    raw.close();
    const store = new StoreHandle({ path, source: '--store' }, {});
    try {
      const d = deps(store, { JOINERY_SSH_PASSWORD: SSH_PASSWORD, JOINERY_PROXY_PASSWORD: 'pp' });
      const target = await resolveTarget(
        'prod',
        { tunnel: { ssh: [{ user: 'x', host: 'y', port: 22 }] } },
        d,
      );
      expect(resolvedProfile(target).secrets['ssh-ref']).toBe(SSH_PASSWORD);
      expect(resolvedProfile(target).secrets['proxy-ref']).toBe('pp');
      expect(target.profile.ssh?.hops[0]?.host).toBe('bastion');
      expect(d.stderr.text()).toMatch(/apply to URI targets; "prod" uses its saved SSH/);

      const prompter = new ScriptedPrompter(true, { secret: ['typed-ssh', 'typed-proxy'] });
      await resolveTarget('prod', {}, deps(store, {}, prompter));
      expect(prompter.asked).toEqual([
        'SSH password (ops@bastion:22) for prod: ',
        'proxy password (proxy:3128) for prod: ',
      ]);
      await expect(resolveTarget('prod', {}, deps(store))).rejects.toMatchObject({
        code: 'AUTH_FAILED',
        hint: expect.stringContaining('JOINERY_SSH_PASSWORD'),
      });
    } finally {
      store.close();
    }
  });
});

describe('joinery test through an in-process SSH server', () => {
  let ssh: TestSshServer;
  let database: { port: number; close(): Promise<void> };
  beforeAll(async () => {
    ssh = await startSshServer({ user: 'tunnel', password: SSH_PASSWORD });
    database = await startEchoServer();
  });
  afterAll(async () => {
    await Promise.all([ssh?.close(), database?.close()]);
  });

  it('prints the SSH step, remembers the host key with --ssh-accept-new and refuses changes', async () => {
    const { dir, cleanup } = tempDir();
    try {
      const knownHosts = join(dir, 'known_hosts');
      const session = new FakeSession('postgres', () => ({ command: 'SELECT', rowsAffected: 0 }));
      const adapter = new FakeAdapter('postgres', session);
      const uri = `postgres://app@127.0.0.1:${database.port}/shop?sslmode=disable`;
      const args = [
        'test',
        uri,
        '--ssh',
        `tunnel@127.0.0.1:${ssh.port}`,
        '--ssh-password-env',
        'BASTION_PW',
        '--known-hosts',
        knownHosts,
      ];
      const env = { BASTION_PW: SSH_PASSWORD, JOINERY_PASSWORD: 'db-pw' };

      // A new host key is refused without a terminal or --ssh-accept-new.
      const refused = await run(args, { env, adapter, cwd: dir });
      expect(refused.code).toBe(1);
      expect(refused.stdout).toMatch(
        /✗ SSH\s+The host key of the SSH server 127\.0\.0\.1:\d+ is not known yet/,
      );
      expect(refused.stdout).toContain('--ssh-accept-new');

      const accepted = await run([...args, '--ssh-accept-new'], { env, adapter, cwd: dir });
      expect(accepted.code).toBe(0);
      expect(accepted.stdout).toContain(`via SSH tunnel@127.0.0.1:${ssh.port}`);
      expect(accepted.stdout).toMatch(
        new RegExp(
          `✓ SSH\\s+SSH tunnel@127\\.0\\.0\\.1:${ssh.port} → 127\\.0\\.0\\.1:${database.port}`,
        ),
      );
      expect(accepted.stderr).toContain('Trusting the new SSH host key');
      expect(readFileSync(knownHosts, 'utf8')).toBe(
        `[127.0.0.1]:${ssh.port} ssh-ed25519 ${ssh.hostKeyFingerprint}\n`,
      );
      // The driver connected to the tunnel's local end, not to the database host.
      const through = adapter.connects.at(-1);
      expect(through?.endpointOverride?.host).toBe('127.0.0.1');
      expect(through?.endpointOverride?.port).not.toBe(database.port);
      expect(accepted.stdout + accepted.stderr).not.toContain(SSH_PASSWORD);

      // Remembered now: no flag needed. A different key for the same server is refused loudly.
      expect((await run(args, { env, adapter, cwd: dir })).code).toBe(0);
      writeFileSync(knownHosts, `[127.0.0.1]:${ssh.port} ssh-ed25519 SHA256:somethingElse\n`);
      const changed = await run([...args, '--ssh-accept-new'], { env, adapter, cwd: dir });
      expect(changed.code).toBe(1);
      expect(changed.stdout).toMatch(/has CHANGED/);
      expect(changed.stdout).toMatch(/man-in-the-middle/);
    } finally {
      cleanup();
    }
  });

  it('asks about a new host key in a terminal', async () => {
    const { dir, cleanup } = tempDir();
    try {
      const knownHosts = join(dir, 'known_hosts');
      const session = new FakeSession('postgres', () => ({ command: 'SELECT', rowsAffected: 0 }));
      const prompter = new ScriptedPrompter(true, { secret: [SSH_PASSWORD], confirm: ['yes'] });
      const result = await run(
        [
          'query',
          `postgres://app:pw@127.0.0.1:${database.port}/shop?sslmode=disable`,
          '-e',
          'select 1',
          '--ssh',
          `tunnel@127.0.0.1:${ssh.port}`,
          '--known-hosts',
          knownHosts,
        ],
        { session, prompter, cwd: dir },
      );
      expect(result.code).toBe(0);
      expect(prompter.asked[0]).toBe(`SSH password for tunnel@127.0.0.1:${ssh.port}: `);
      expect(prompter.asked[1]).toContain(ssh.hostKeyFingerprint);
      expect(readFileSync(knownHosts, 'utf8')).toContain(ssh.hostKeyFingerprint);
      expect(session.executed.map((e) => e.text)).toEqual(['select 1']);
      expect(session.closed).toBe(true);
    } finally {
      cleanup();
    }
  });

  it('shares the desktop app’s known hosts by default', () => {
    expect(defaultKnownHostsPath('/home/me/.config/Joinery/joinery.db')).toBe(
      '/home/me/.config/Joinery/known_hosts',
    );
  });
});
