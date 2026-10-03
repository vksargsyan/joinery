import { createCipheriv, createHash, createHmac, createPrivateKey, randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MessageChannel } from 'node:worker_threads';

import type { ConnectionCheckResult } from '@querybara/core';
import {
  createClient,
  fromNodePort,
  mainContract,
  serve,
  type Client,
  type HostKeyPromptEvent,
  type MainContract,
  type PortLike,
} from '@querybara/ipc';
import { openStore, type SecretSealer } from '@querybara/storage';
import { MemoryKnownHosts, importPrivateKey } from '@querybara/tunnel';
import ssh2 from 'ssh2';
import { afterEach, describe, expect, it } from 'vitest';

import { createMainHandlers } from '../src/main/api';
import { HostKeyBroker } from '../src/main/host-keys';
import { inspectPrivateKey } from '../src/main/ssh-keys';
import { ConnectionSupervisor } from '../src/main/supervisor';
import { fakeHosts, profileInput } from './helpers';
import { ed25519Key } from './ssh-server';

/**
 * Main's SSH side: private keys picked in the dialog (checked and PPK-converted in main), host
 * key questions through the main contract, and labelled secret prompts. Nothing secret reaches
 * the renderer's end of the port.
 */

const PASSPHRASE = 'k3y-Passphrase!';
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const clean of cleanup.splice(0)) clean();
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'querybara-ssh-main-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function wire(value: Buffer | string): Buffer {
  const data = typeof value === 'string' ? Buffer.from(value) : value;
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  return Buffer.concat([length, data]);
}

const sha1 = (...parts: (Buffer | string)[]): Buffer => {
  const hash = createHash('sha1');
  for (const part of parts) hash.update(part);
  return hash.digest();
};

/** An Ed25519 OpenSSH key as a PuTTY PPK (format 2), optionally encrypted, like PuTTYgen writes. */
function toPpk(opensshKey: string, passphrase?: string): string {
  const parsed = ssh2.utils.parseKey(opensshKey);
  if (parsed instanceof Error) throw parsed;
  const jwk = createPrivateKey(parsed.getPrivatePEM()).export({ format: 'jwk' });
  const publicBlob = parsed.getPublicSSH();
  let privateBlob = wire(Buffer.from(jwk.d ?? '', 'base64url'));
  const encryption = passphrase ? 'aes256-cbc' : 'none';
  const comment = 'querybara-test-key';
  if (passphrase) {
    const padding = (16 - (privateBlob.length % 16)) % 16;
    privateBlob = Buffer.concat([privateBlob, randomBytes(padding)]);
  }
  const macData = Buffer.concat([
    wire('ssh-ed25519'),
    wire(encryption),
    wire(comment),
    wire(publicBlob),
    wire(privateBlob),
  ]);
  const mac = createHmac('sha1', sha1('putty-private-key-file-mac-key', passphrase ?? ''))
    .update(macData)
    .digest('hex');
  let stored = privateBlob;
  if (passphrase) {
    const key = Buffer.concat([
      sha1(Buffer.from([0, 0, 0, 0]), passphrase),
      sha1(Buffer.from([0, 0, 0, 1]), passphrase),
    ]).subarray(0, 32);
    const cipher = createCipheriv('aes-256-cbc', key, Buffer.alloc(16));
    cipher.setAutoPadding(false);
    stored = Buffer.concat([cipher.update(privateBlob), cipher.final()]);
  }
  const lines = (data: Buffer): string[] => data.toString('base64').match(/.{1,64}/g) ?? [];
  const publicLines = lines(publicBlob);
  const privateLines = lines(stored);
  return [
    'PuTTY-User-Key-File-2: ssh-ed25519',
    `Encryption: ${encryption}`,
    `Comment: ${comment}`,
    `Public-Lines: ${publicLines.length}`,
    ...publicLines,
    `Private-Lines: ${privateLines.length}`,
    ...privateLines,
    `Private-MAC: ${mac}`,
    '',
  ].join('\n');
}

function fingerprintOf(opensshKey: string): string {
  const parsed = ssh2.utils.parseKey(opensshKey);
  if (parsed instanceof Error) throw parsed;
  return `SHA256:${createHash('sha256').update(parsed.getPublicSSH()).digest('base64').replace(/=+$/, '')}`;
}

function encryptedOpenSsh(): string {
  for (;;) {
    const pair = ssh2.utils.generateKeyPairSync('ed25519', {
      passphrase: PASSPHRASE,
      cipher: 'aes256-ctr',
      rounds: 2,
    });
    if (!(ssh2.utils.parseKey(pair.private, PASSPHRASE) instanceof Error)) return pair.private;
  }
}

describe('private keys picked in the connection dialog', () => {
  it('describes an OpenSSH key by type and fingerprint and keeps its path', async () => {
    const dir = tempDir();
    const key = ed25519Key();
    const path = join(dir, 'id_ed25519');
    writeFileSync(path, key, { mode: 0o600 });
    expect(await inspectPrivateKey(path, undefined, join(dir, 'keys'))).toEqual({
      format: 'openssh',
      encrypted: false,
      locked: false,
      keyType: 'ssh-ed25519',
      fingerprintSha256: fingerprintOf(key),
      keyPath: path,
      converted: false,
    });
  });

  it('asks for the passphrase of an encrypted key and checks it', async () => {
    const dir = tempDir();
    const key = encryptedOpenSsh();
    const path = join(dir, 'id_locked');
    writeFileSync(path, key, { mode: 0o600 });
    const locked = await inspectPrivateKey(path, undefined, join(dir, 'keys'));
    expect(locked).toMatchObject({ format: 'openssh', encrypted: true, locked: true });
    await expect(inspectPrivateKey(path, 'wrong', join(dir, 'keys'))).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      engineCode: 'BAD_PASSPHRASE',
    });
    expect(await inspectPrivateKey(path, PASSPHRASE, join(dir, 'keys'))).toMatchObject({
      encrypted: true,
      locked: false,
      keyType: 'ssh-ed25519',
      keyPath: path,
    });
  });

  it('converts a PuTTY key to PEM, saved for the owner only, on import', async () => {
    const dir = tempDir();
    const keysDir = join(dir, 'ssh-keys');
    const key = ed25519Key();
    const path = join(dir, 'work laptop.ppk');
    writeFileSync(path, toPpk(key));
    const info = await inspectPrivateKey(path, undefined, keysDir);
    expect(info).toMatchObject({
      format: 'ppk',
      encrypted: false,
      locked: false,
      keyType: 'ssh-ed25519',
      fingerprintSha256: fingerprintOf(key),
      comment: 'querybara-test-key',
      converted: true,
    });
    expect(info.keyPath.startsWith(keysDir)).toBe(true);
    expect(info.keyPath).toMatch(/work_laptop-[0-9a-f]{12}\.pem$/);
    const pem = readFileSync(info.keyPath, 'utf8');
    expect(pem).toMatch(/^-----BEGIN PRIVATE KEY-----/);
    expect(importPrivateKey(pem).fingerprintSha256).toBe(fingerprintOf(key));
    if (process.platform !== 'win32') {
      expect(statSync(info.keyPath).mode & 0o777).toBe(0o600);
      expect(statSync(keysDir).mode & 0o777).toBe(0o700);
    }
    // Importing it again replaces the same copy.
    expect((await inspectPrivateKey(path, undefined, keysDir)).keyPath).toBe(info.keyPath);
  });

  it('converts an encrypted PuTTY key once the passphrase is known, still encrypted', async () => {
    const dir = tempDir();
    const keysDir = join(dir, 'ssh-keys');
    const key = ed25519Key();
    const path = join(dir, 'locked.ppk');
    writeFileSync(path, toPpk(key, PASSPHRASE));
    expect(await inspectPrivateKey(path, undefined, keysDir)).toMatchObject({
      format: 'ppk',
      encrypted: true,
      locked: true,
      converted: false,
      keyPath: path,
    });
    const info = await inspectPrivateKey(path, PASSPHRASE, keysDir);
    expect(info).toMatchObject({ encrypted: true, locked: false, converted: true });
    const pem = readFileSync(info.keyPath, 'utf8');
    expect(pem).toMatch(/^-----BEGIN ENCRYPTED PRIVATE KEY-----/);
    expect(pem).not.toContain(PASSPHRASE);
    expect(importPrivateKey(pem, PASSPHRASE).fingerprintSha256).toBe(fingerprintOf(key));
  });

  it('refuses files that are not private keys, naming the file', async () => {
    const dir = tempDir();
    const keysDir = join(dir, 'keys');
    const pub = join(dir, 'id_ed25519.pub');
    writeFileSync(pub, 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIA== me@host\n');
    await expect(inspectPrivateKey(pub, undefined, keysDir)).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    await expect(inspectPrivateKey(join(dir, 'missing'), undefined, keysDir)).rejects.toMatchObject(
      {
        code: 'VALIDATION_FAILED',
        message: expect.stringContaining('ENOENT'),
      },
    );
    mkdirSync(join(dir, 'folder'));
    await expect(inspectPrivateKey(join(dir, 'folder'), undefined, keysDir)).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      message: expect.stringContaining('not a file'),
    });
  });
});

const sealer: SecretSealer = {
  id: 'test-xor',
  isAvailable: () => true,
  seal: (plain) => new TextEncoder().encode(plain).map((b) => b ^ 0x2a),
  unseal: (sealed) => new TextDecoder().decode(sealed.map((b) => b ^ 0x2a)),
};

function setup(keysDir?: string) {
  const store = openStore(':memory:', { sealer });
  const broker = new HostKeyBroker({ store: new MemoryKnownHosts() });
  const step: ConnectionCheckResult = { step: 'ssh', status: 'ok', durationMs: 3 };
  const hosts = fakeHosts((process, message) => {
    if (message.type === 'check') {
      setImmediate(() =>
        process.emit({
          type: 'host-key',
          requestId: 'r1',
          host: 'bastion.example.com',
          port: 22,
          key: { algorithm: 'ssh-ed25519', fingerprintSha256: 'SHA256:abcDEF0123456789' },
        }),
      );
    }
    if (message.type === 'host-key-decision') {
      setImmediate(() => {
        process.emit({
          type: 'check-step',
          result: message.decision === 'trust' ? step : { ...step, status: 'failed' },
        });
        process.emit({ type: 'check-done' });
      });
    }
  });
  const supervisor = new ConnectionSupervisor<string>({ spawn: hosts.spawn, hostKeys: broker });
  const handlers = createMainHandlers<string>(
    {
      store,
      supervisor,
      spawnHost: hosts.spawn,
      createChannel: () => ({ local: 'host-end', remote: 'renderer-end' }),
      appInfo: () => ({
        name: 'Querybara',
        version: '0.1.0',
        platform: 'linux',
        arch: 'x64',
        versions: { node: '24' },
      }),
      openExternal: async () => {},
      hostKeys: broker,
      ...(keysDir ? { keysDir } : {}),
    },
    { sendPort: () => undefined, openFile: async () => null },
  );
  const channel = new MessageChannel();
  cleanup.push(() => {
    channel.port1.close();
    channel.port2.close();
    supervisor.closeAll();
    store.close();
  });
  serve(fromNodePort(channel.port2), mainContract, handlers);
  const received: unknown[] = [];
  const recorded: PortLike = fromNodePort(channel.port1);
  const renderer: PortLike = {
    ...recorded,
    onMessage: (listener) =>
      recorded.onMessage((data) => {
        received.push(data);
        listener(data);
      }),
  };
  const main: Client<MainContract['shape']> = createClient(renderer, mainContract);
  return { main, store, hosts, received };
}

describe('main contract: SSH', () => {
  it('labels each missing secret with what it is for', async () => {
    const { main } = setup();
    const ids = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
    const saved = await main.profiles.save({
      profile: profileInput({
        auth: { method: 'password', user: 'app', password: { id: ids[0]!, policy: 'ask' } },
        ssh: {
          hops: [
            {
              host: 'bastion',
              user: 'ops',
              auth: { method: 'password', password: { id: ids[1]!, policy: 'ask' } },
            },
          ],
        },
        proxy: {
          kind: 'socks5',
          host: 'proxy.internal',
          port: 1080,
          password: { id: ids[2]!, policy: 'session' },
        },
      }),
    });
    const status = await main.profiles.secretStatus({ profileId: saved.id });
    expect(status.missing.map((m) => [m.refId, m.label])).toEqual([
      [ids[0], 'Password'],
      [ids[1], 'SSH password for ops@bastion:22'],
      [ids[2], 'SOCKS5 proxy password for proxy.internal:1080'],
    ]);
  });

  it('asks the window about a host key during Test Connection and never sends a secret back', async () => {
    const { main, received } = setup();
    const events = main.hostKeys.prompts();
    const steps: ConnectionCheckResult[] = [];
    const sshPassword = 'ssh-Secret-4711';
    const refId = crypto.randomUUID();
    const testing = (async () => {
      for await (const step of main.testConnection({
        profile: profileInput({
          ssh: {
            hops: [
              {
                host: 'bastion.example.com',
                user: 'ops',
                auth: { method: 'password', password: { id: refId, policy: 'ask' } },
              },
            ],
          },
        }),
        secrets: { [refId]: sshPassword },
      })) {
        steps.push(step);
      }
    })();
    const first = (await events.next()).value as HostKeyPromptEvent;
    expect(first).toMatchObject({
      type: 'open',
      prompt: {
        kind: 'unknown',
        host: 'bastion.example.com',
        purpose: 'test',
        profileName: 'Local Postgres',
      },
    });
    if (first.type !== 'open') throw new Error('expected a question');
    await main.hostKeys.answer({ promptId: first.prompt.promptId, answer: 'trust-once' });
    expect((await events.next()).value).toEqual({
      type: 'closed',
      promptId: first.prompt.promptId,
    });
    await testing;
    expect(steps.map((s) => s.status)).toEqual(['ok']);
    await events.return();
    expect(JSON.stringify(received)).not.toContain(sshPassword);
  });

  it('checks key files in main', async () => {
    const dir = tempDir();
    const path = join(dir, 'id_test');
    writeFileSync(path, ed25519Key());
    const { main } = setup(join(dir, 'keys'));
    expect(await main.ssh.inspectKey({ path })).toMatchObject({
      format: 'openssh',
      keyType: 'ssh-ed25519',
      locked: false,
    });
    const without = setup();
    await expect(without.main.ssh.inspectKey({ path })).rejects.toMatchObject({
      code: 'NOT_SUPPORTED',
    });
  });
});
