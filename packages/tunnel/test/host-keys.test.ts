import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  FileKnownHosts,
  MemoryKnownHosts,
  knownHostsVerifier,
  type HostKeyInfo,
  type KnownHostsStore,
} from '../src';

const keyA: HostKeyInfo = {
  algorithm: 'ssh-ed25519',
  fingerprintSha256: 'SHA256:AAAAaaaaBBBBbbbbCCCCccccDDDDddddEEEEeeee012',
};
const keyB: HostKeyInfo = {
  algorithm: 'ssh-ed25519',
  fingerprintSha256: 'SHA256:ZZZZzzzzYYYYyyyyXXXXxxxxWWWWwwwwVVVVvvvv987',
};

const dirs: string[] = [];
function tempFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'querybara-known-hosts-'));
  dirs.push(dir);
  return join(dir, 'nested', 'known_hosts');
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe.each<[string, () => KnownHostsStore]>([
  ['MemoryKnownHosts', () => new MemoryKnownHosts()],
  ['FileKnownHosts', () => new FileKnownHosts(tempFile())],
])('knownHostsVerifier with %s', (_name, makeStore) => {
  it('rejects an unknown key under the strict policy and remembers nothing', async () => {
    const store = makeStore();
    const verify = knownHostsVerifier(store, 'reject');
    expect(await verify('bastion', 22, keyA)).toBe('reject');
    expect(await store.lookup('bastion', 22)).toEqual([]);
  });

  it('trusts and remembers a new key with accept-new, then trusts it again', async () => {
    const store = makeStore();
    const verify = knownHostsVerifier(store, 'accept-new');
    expect(await verify('Bastion', 22, keyA)).toBe('trust');
    expect(await store.lookup('bastion', 22)).toEqual([{ host: 'bastion', port: 22, ...keyA }]);
    expect(await knownHostsVerifier(store, 'reject')('bastion', 22, keyA)).toBe('trust');
    // Another port is another host.
    expect(await knownHostsVerifier(store, 'reject')('bastion', 2222, keyA)).toBe('reject');
  });

  it('refuses a changed key loudly, whatever the policy', async () => {
    const store = makeStore();
    await store.remember({ host: 'db-bastion', port: 22, ...keyA });
    const verify = knownHostsVerifier(store, 'accept-new');
    const error = await Promise.resolve(verify('db-bastion', 22, keyB)).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'SSH_FAILED', engineCode: 'HOST_KEY_CHANGED' });
    expect((error as Error).message).toMatch(/CHANGED/);
    expect((error as Error).message).toContain(keyA.fingerprintSha256);
    expect((error as Error).message).toContain(keyB.fingerprintSha256);
    expect((error as Error).message).toMatch(/man-in-the-middle/);
    expect(await store.lookup('db-bastion', 22)).toHaveLength(1);

    await store.forget('db-bastion', 22);
    expect(await verify('db-bastion', 22, keyB)).toBe('trust');
  });

  it('asks the prompt only for unknown keys and remembers what it trusted', async () => {
    const store = makeStore();
    const asked: string[] = [];
    const verify = knownHostsVerifier(store, async (host, port, key) => {
      asked.push(`${host}:${port} ${key.fingerprintSha256}`);
      return host === 'good' ? 'trust' : 'reject';
    });
    expect(await verify('good', 22, keyA)).toBe('trust');
    expect(await verify('good', 22, keyA)).toBe('trust');
    expect(await verify('evil', 22, keyB)).toBe('reject');
    expect(await verify('evil', 22, keyB)).toBe('reject');
    expect(asked).toEqual([
      `good:22 ${keyA.fingerprintSha256}`,
      `evil:22 ${keyB.fingerprintSha256}`,
      `evil:22 ${keyB.fingerprintSha256}`,
    ]);
  });
});

describe('FileKnownHosts', () => {
  it('writes one line per key with owner-only permissions, keeping comments', async () => {
    const path = tempFile();
    const store = new FileKnownHosts(path);
    await store.remember({ host: 'bastion', port: 22, ...keyA });
    await store.remember({ host: 'bastion', port: 22, ...keyA });
    await store.remember({ host: '::1', port: 2222, ...keyB });
    expect(readFileSync(path, 'utf8')).toBe(
      `[bastion]:22 ssh-ed25519 ${keyA.fingerprintSha256}\n[::1]:2222 ssh-ed25519 ${keyB.fingerprintSha256}\n`,
    );
    if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600);

    writeFileSync(path, `# team bastions\n${readFileSync(path, 'utf8')}`);
    await store.forget('bastion', 22);
    expect(readFileSync(path, 'utf8')).toBe(
      `# team bastions\n[::1]:2222 ssh-ed25519 ${keyB.fingerprintSha256}\n`,
    );
    expect(await new FileKnownHosts(path).lookup('::1', 2222)).toHaveLength(1);
  });

  it('serialises concurrent writes', async () => {
    const store = new FileKnownHosts(tempFile());
    await Promise.all(
      Array.from({ length: 20 }, (_, i) => store.remember({ host: `h${i}`, port: 22, ...keyA })),
    );
    for (let i = 0; i < 20; i++) expect(await store.lookup(`h${i}`, 22)).toHaveLength(1);
  });
});
