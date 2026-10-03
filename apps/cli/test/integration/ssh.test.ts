import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, connect as netConnect, type AddressInfo, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { connectionProfileSchema } from '@querybara/core';
import { createPassphraseSealer, openStore } from '@querybara/storage';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startSshServer, type TestSshServer } from '../ssh-server';

/**
 * The BUILT binary through SSH tunnels and a SOCKS5 proxy (spec §4): an in-process ssh2 server
 * (and proxy) in this test process forward to the local test servers. Covers `test` printing the
 * SSH step, queries through one and two hops (a jump host), trust on first use with
 * --ssh-accept-new into the known_hosts next to the store, and saved profiles with a tunnel.
 * Gated on the QUERYBARA_TEST_*_URL variables like the other integration suites.
 */

const BIN = fileURLToPath(new URL('../../dist/querybara.mjs', import.meta.url));
const SSH_USER = 'tunnel';
const SSH_PASSWORD = 'it-Bastion-9f2';
const PASSPHRASE = 'it-store-passphrase';

interface Engine {
  readonly name: 'postgres' | 'mariadb' | 'mysql';
  readonly url: string;
}

const ENGINES: Engine[] = (
  [
    ['postgres', process.env['QUERYBARA_TEST_POSTGRES_URL']],
    ['mariadb', process.env['QUERYBARA_TEST_MARIADB_URL']],
    ['mysql', process.env['QUERYBARA_TEST_MYSQL_URL']],
  ] as const
)
  .filter((entry): entry is readonly [Engine['name'], string] => Boolean(entry[1]))
  .map(([name, url]) => ({ name, url }));

let workDir = '';
let storePath = '';
let ssh: TestSshServer;
let socks: { port: number; connections: number; close(): Promise<void> };

interface Result {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function querybara(args: readonly string[], env: Record<string, string> = {}): Promise<Result> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, ...args], {
      env: {
        PATH: process.env['PATH'] ?? '',
        HOME: workDir,
        QUERYBARA_STORE: storePath,
        NO_COLOR: '1',
        ...env,
      },
      cwd: workDir,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.stdin.end();
    child.on('error', reject);
    child.on('close', (code) =>
      resolve({
        code,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      }),
    );
  });
}

/** The server URL with TLS off (the test servers use plain TCP). */
function urlFor(engine: Engine): string {
  const url = new URL(engine.url);
  url.searchParams.set(
    engine.name === 'postgres' ? 'sslmode' : 'ssl-mode',
    engine.name === 'postgres' ? 'disable' : 'disabled',
  );
  return url.toString();
}

/** A minimal SOCKS5 CONNECT server without authentication. */
async function startSocks5(): Promise<typeof socks> {
  const sockets = new Set<Socket>();
  const state = { connections: 0 };
  const server = createServer((socket) => {
    state.connections += 1;
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    socket.on('error', () => undefined);
    let buffered = Buffer.alloc(0);
    let stage: 'greeting' | 'request' | 'open' = 'greeting';
    socket.on('data', (chunk: Buffer) => {
      if (stage === 'open') return;
      buffered = Buffer.concat([buffered, chunk]);
      if (stage === 'greeting') {
        if (buffered.length < 2 || buffered.length < 2 + buffered[1]!) return;
        buffered = buffered.subarray(2 + buffered[1]!);
        stage = 'request';
        socket.write(Buffer.from([5, 0]));
      }
      if (stage === 'request' && buffered.length >= 5) {
        const type = buffered[3];
        const hostLength = type === 1 ? 4 : type === 4 ? 16 : 1 + buffered[4]!;
        if (buffered.length < 4 + hostLength + 2) return;
        const host =
          type === 1
            ? [...buffered.subarray(4, 8)].join('.')
            : buffered.subarray(5, 5 + buffered[4]!).toString();
        const port = buffered.readUInt16BE(4 + hostLength);
        stage = 'open';
        socket.removeAllListeners('data');
        const upstream = netConnect({ host, port });
        upstream.once('error', () => socket.end(Buffer.from([5, 5, 0, 1, 0, 0, 0, 0, 0, 0])));
        upstream.once('connect', () => {
          socket.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
          socket.pipe(upstream).pipe(socket);
          socket.once('close', () => upstream.destroy());
          upstream.once('close', () => socket.destroy());
        });
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  return {
    port: (server.address() as AddressInfo).port,
    get connections() {
      return state.connections;
    },
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

beforeAll(async () => {
  if (ENGINES.length === 0) return;
  if (!existsSync(BIN)) {
    throw new Error(`${BIN} is missing: run "pnpm --filter @querybara/cli build" first`);
  }
  workDir = mkdtempSync(join(tmpdir(), 'querybara-cli-ssh-'));
  storePath = join(workDir, 'querybara.db');
  ssh = await startSshServer({ user: SSH_USER, password: SSH_PASSWORD });
  socks = await startSocks5();
});

afterAll(async () => {
  await Promise.all([ssh?.close(), socks?.close()]);
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

describe.skipIf(ENGINES.length === 0)('host keys', () => {
  it('refuses an unknown host key without a terminal, then trusts it with --ssh-accept-new', async () => {
    const engine = ENGINES[0]!;
    const hop = ['--ssh', `${SSH_USER}@127.0.0.1:${ssh.port}`, '--ssh-password-env', 'PW'];
    const refused = await querybara(['test', urlFor(engine), ...hop], { PW: SSH_PASSWORD });
    expect(refused.code).toBe(1);
    expect(refused.stdout).toMatch(/✗ SSH\s+The host key of the SSH server .* is not known yet/);
    expect(refused.stdout).toContain(ssh.hostKeyFingerprint);

    const accepted = await querybara(['test', urlFor(engine), ...hop, '--ssh-accept-new'], {
      PW: SSH_PASSWORD,
    });
    expect(accepted.code, accepted.stdout + accepted.stderr).toBe(0);
    // Remembered next to the store, where the desktop app keeps its known_hosts too.
    expect(readFileSync(join(workDir, 'known_hosts'), 'utf8')).toBe(
      `[127.0.0.1]:${ssh.port} ssh-ed25519 ${ssh.hostKeyFingerprint}\n`,
    );
  });
});

describe.each(ENGINES)('$name through SSH', (engine) => {
  const env = { QUERYBARA_SSH_PASSWORD: SSH_PASSWORD };
  const sshArgs = (): string[] => ['--ssh', `${SSH_USER}@127.0.0.1:${ssh.port}`];

  it('test prints the SSH step and passes', async () => {
    const result = await querybara(['test', urlFor(engine), ...sshArgs()], env);
    expect(result.code, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toMatch(/✓ TCP\s+Connected to the SSH server 127\.0\.0\.1:\d+/);
    expect(result.stdout).toMatch(
      new RegExp(`✓ SSH\\s+SSH ${SSH_USER}@127\\.0\\.0\\.1:${ssh.port} → `),
    );
    expect(result.stdout).toMatch(/✓ Auth/);
    expect(result.stdout).toContain('Connection OK.');
    expect(result.stdout + result.stderr).not.toContain(SSH_PASSWORD);
  });

  it('runs queries through a jump host and the SSH server', async () => {
    const forwards = ssh.stats.forwards;
    const result = await querybara(
      [
        'query',
        urlFor(engine),
        ...sshArgs(),
        ...sshArgs(),
        '--format',
        'csv',
        '-e',
        'select 40 + 2 as answer',
      ],
      env,
    );
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toBe('answer\n42\n');
    // The first hop forwarded to the second, and the second to the database.
    expect(ssh.stats.forwards - forwards).toBeGreaterThanOrEqual(2);
  });

  it('runs a query through a SOCKS5 proxy', async () => {
    const before = socks.connections;
    const result = await querybara([
      'query',
      urlFor(engine),
      '--proxy',
      `socks5://127.0.0.1:${socks.port}`,
      '--format',
      'csv',
      '-e',
      'select 7 as seven',
    ]);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toBe('seven\n7\n');
    expect(socks.connections).toBeGreaterThan(before);
  });

  it('connects a saved profile through its tunnel', async () => {
    const url = new URL(engine.url);
    const name = `ssh-${engine.name}`;
    const store = openStore(storePath, { sealer: createPassphraseSealer(PASSPHRASE) });
    try {
      const now = new Date().toISOString();
      const profile = connectionProfileSchema.parse({
        id: `ssh-profile-${engine.name}`,
        name,
        engine: engine.name,
        endpoint: { kind: 'host', host: url.hostname, port: Number(url.port) },
        auth: {
          method: 'password',
          user: decodeURIComponent(url.username),
          password: { id: `db-${engine.name}`, policy: 'save' },
        },
        tls: { mode: 'disable' },
        options: { defaultDatabase: url.pathname.slice(1) },
        ssh: {
          hops: [
            {
              host: '127.0.0.1',
              port: ssh.port,
              user: SSH_USER,
              auth: { method: 'password', password: { id: `ssh-${engine.name}`, policy: 'save' } },
            },
          ],
        },
        createdAt: now,
        updatedAt: now,
      });
      store.profiles.save(profile, { expectedVersion: 0 });
      store.secrets.set(
        { id: `db-${engine.name}`, policy: 'save' },
        decodeURIComponent(url.password),
      );
      store.secrets.set({ id: `ssh-${engine.name}`, policy: 'save' }, SSH_PASSWORD);
    } finally {
      store.close();
    }
    const passphrase = { QUERYBARA_PASSPHRASE: PASSPHRASE };
    const tested = await querybara(['test', name], passphrase);
    expect(tested.code, tested.stdout + tested.stderr).toBe(0);
    expect(tested.stdout).toMatch(/✓ SSH/);
    const queried = await querybara(
      ['query', name, '--format', 'csv', '-e', 'select 1 as one'],
      passphrase,
    );
    expect(queried.code, queried.stderr).toBe(0);
    expect(queried.stdout).toBe('one\n1\n');
  });
});
