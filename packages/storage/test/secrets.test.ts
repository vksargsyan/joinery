import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { inspect } from 'node:util';

import { newId, type ConnectionProfile, type SecretRef } from '@querybara/core';
import { describe, expect, it } from 'vitest';

import { REDACTED, createPassphraseSealer, openStore, type SecretSealer } from '../src';
import {
  TEST_COST,
  memoryStore,
  postgresProfile,
  tempDir,
  testSealer,
  thrown,
  track,
} from './helpers';

const PLAINTEXT = 'N33dle-in-the-haystack-Æøå-🔑-hunter2';

describe('passphrase sealer', () => {
  const sealer = testSealer();

  it('round-trips any string, with fresh salt and nonce every time', () => {
    for (const value of ['', 'x', PLAINTEXT, 'long '.repeat(10_000)]) {
      expect(sealer.unseal(sealer.seal(value))).toBe(value);
    }
    const a = sealer.seal(PLAINTEXT);
    const b = sealer.seal(PLAINTEXT);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
    expect(Buffer.from(a).includes(Buffer.from(PLAINTEXT))).toBe(false);
    expect(sealer.isAvailable()).toBe(true);
  });

  it('unseals across instances with the same passphrase, normalising Unicode', () => {
    const composed = createPassphraseSealer('café', { cost: TEST_COST });
    const decomposed = createPassphraseSealer('café', { cost: TEST_COST });
    expect(decomposed.unseal(composed.seal(PLAINTEXT))).toBe(PLAINTEXT);
  });

  it('fails with AUTH_FAILED on a wrong passphrase', () => {
    const sealed = sealer.seal(PLAINTEXT);
    const error = thrown(() => testSealer('wrong passphrase').unseal(sealed));
    expect(error).toMatchObject({
      code: 'AUTH_FAILED',
      message: expect.stringMatching(/passphrase is wrong or the data was modified/),
    });
  });

  it('detects tampering anywhere in the sealed value', () => {
    const sealed = sealer.seal(PLAINTEXT);
    // Header fields (kdf, cost), salt, nonce, ciphertext and tag: every byte is authenticated.
    for (const offset of [5, 6, 7, 8, 10, 30, 40, sealed.length - 20, sealed.length - 1]) {
      const copy = Uint8Array.from(sealed);
      copy[offset] = (copy[offset] ?? 0) ^ 0x01;
      const error = thrown(() => sealer.unseal(copy));
      expect(error, `offset ${offset}`).toMatchObject({
        code: expect.stringMatching(/AUTH_FAILED|VALIDATION_FAILED/),
      });
    }
  });

  it('rejects foreign, truncated and future-format input clearly', () => {
    const sealed = sealer.seal(PLAINTEXT);
    expect(thrown(() => sealer.unseal(sealed.subarray(0, 20)))).toMatchObject({
      code: 'VALIDATION_FAILED',
      message: 'This is not a Querybara sealed secret',
    });
    expect(thrown(() => sealer.unseal(new TextEncoder().encode('x'.repeat(80))))).toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    const future = Uint8Array.from(sealed);
    future[4] = 2;
    expect(thrown(() => sealer.unseal(future))).toMatchObject({ code: 'NOT_SUPPORTED' });
  });

  it('never shows the passphrase', () => {
    const secretive = createPassphraseSealer('my-passphrase-XYZ', { cost: TEST_COST });
    for (const text of [JSON.stringify(secretive), inspect(secretive), String(secretive)]) {
      expect(text).not.toContain('my-passphrase-XYZ');
    }
  });

  it('refuses empty passphrases and out-of-range costs', () => {
    expect(thrown(() => createPassphraseSealer(''))).toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(() => createPassphraseSealer('x', { cost: { log2N: 4, r: 8, p: 1 } })).toThrow(
      RangeError,
    );
    expect(() => createPassphraseSealer('x', { cost: { log2N: 22, r: 8, p: 1 } })).toThrow(
      RangeError,
    );
  });
});

function withSecrets(refs: {
  password?: SecretRef;
  sshPassphrase?: SecretRef;
  proxy?: SecretRef;
  tlsKey?: SecretRef;
}): Parameters<ReturnType<typeof memoryStore>['profiles']['save']>[0] {
  return postgresProfile({
    auth: {
      method: 'password',
      user: 'app',
      ...(refs.password ? { password: refs.password } : {}),
    },
    ...(refs.tlsKey ? { tls: { mode: 'verify-full', keyPassphrase: refs.tlsKey } } : {}),
    ...(refs.sshPassphrase
      ? {
          ssh: {
            hops: [
              {
                host: 'bastion',
                user: 'ops',
                auth: {
                  method: 'privateKey',
                  keyPath: '~/.ssh/id_ed25519',
                  passphrase: refs.sshPassphrase,
                },
              },
            ],
          },
        }
      : {}),
    ...(refs.proxy
      ? { proxy: { kind: 'socks5', host: 'proxy', port: 1080, password: refs.proxy } }
      : {}),
  });
}

const ref = (policy: SecretRef['policy']): SecretRef => ({ id: newId(), policy });

describe('secret store policies', () => {
  it('seals "save" secrets into the database', () => {
    const store = memoryStore();
    const password = ref('save');
    store.secrets.set(password, PLAINTEXT);
    expect(store.secrets.get(password)).toBe(PLAINTEXT);
    const row = store.db.get('SELECT sealer, sealed FROM secrets WHERE id = ?', [password.id]);
    expect(row?.['sealer']).toBe('passphrase-v1');
    expect(row?.['sealed']).toBeInstanceOf(Uint8Array);
    store.secrets.clearSession();
    expect(store.secrets.get(password)).toBe(PLAINTEXT);
  });

  it('keeps "session" secrets in memory only, until clearSession', () => {
    const store = memoryStore();
    const password = ref('session');
    store.secrets.set(password, PLAINTEXT);
    expect(store.secrets.get(password)).toBe(PLAINTEXT);
    expect(store.db.get('SELECT count(*) AS n FROM secrets')).toEqual({ n: 0 });
    store.secrets.clearSession();
    expect(store.secrets.get(password)).toBeUndefined();
  });

  it('stores nothing for "ask" secrets', () => {
    const store = memoryStore();
    const password = ref('ask');
    store.secrets.set(password, PLAINTEXT);
    expect(store.secrets.get(password)).toBeUndefined();
    expect(store.db.get('SELECT count(*) AS n FROM secrets')).toEqual({ n: 0 });
  });

  it('moves the value when the policy changes', () => {
    const store = memoryStore();
    const id = newId();
    store.secrets.set({ id, policy: 'save' }, 'one');
    store.secrets.set({ id, policy: 'session' }, 'two');
    expect(store.db.get('SELECT count(*) AS n FROM secrets')).toEqual({ n: 0 });
    expect(store.secrets.get({ id, policy: 'session' })).toBe('two');
    store.secrets.set({ id, policy: 'save' }, 'three');
    expect(store.secrets.get({ id, policy: 'save' })).toBe('three');
    store.secrets.clearSession();
    expect(store.secrets.get({ id, policy: 'save' })).toBe('three');
    store.secrets.set({ id, policy: 'ask' }, 'four');
    expect(store.secrets.get({ id, policy: 'save' })).toBeUndefined();
    expect(store.secrets.get({ id })).toBeUndefined();
  });

  it('deletes both copies', () => {
    const store = memoryStore();
    const saved = ref('save');
    const session = ref('session');
    store.secrets.set(saved, 'a');
    store.secrets.set(session, 'b');
    store.secrets.delete(saved);
    store.secrets.delete(session.id);
    expect(store.secrets.get(saved)).toBeUndefined();
    expect(store.secrets.get(session)).toBeUndefined();
  });

  it('resolves every secret of a profile and lists the ones to prompt for', () => {
    const store = memoryStore();
    const refs = {
      password: ref('save'),
      sshPassphrase: ref('session'),
      proxy: ref('ask'),
      tlsKey: ref('save'),
    };
    const profile = store.profiles.save(withSecrets(refs));
    store.secrets.set(refs.password, 'db password');
    store.secrets.set(refs.sshPassphrase, 'key passphrase');
    store.secrets.set(refs.proxy, 'never stored');

    const resolved = store.secrets.resolve(profile);
    expect(resolved.secrets[refs.password.id]).toBe('db password');
    expect(resolved.secrets[refs.sshPassphrase.id]).toBe('key passphrase');
    expect(Object.keys(resolved.secrets).sort()).toEqual(
      [refs.password.id, refs.sshPassphrase.id].sort(),
    );
    expect(resolved.missing).toEqual([refs.tlsKey, refs.proxy]);
    expect(resolved.unreadable).toEqual([]);

    store.secrets.clearSession();
    expect(store.secrets.resolve(profile).missing).toEqual([
      refs.tlsKey,
      refs.sshPassphrase,
      refs.proxy,
    ]);
  });

  it('reports sealed values it cannot unseal as unreadable and missing', () => {
    const location = join(tempDir(), 'store.db');
    const password = ref('save');
    const first = track(openStore(location, { sealer: testSealer('first') }));
    const profile = first.profiles.save(withSecrets({ password }));
    first.secrets.set(password, PLAINTEXT);
    first.close();

    const other = track(openStore(location, { sealer: testSealer('second') }));
    expect(other.secrets.resolve(profile)).toMatchObject({
      missing: [password],
      unreadable: [password],
    });
    other.close();

    const same = testSealer('first');
    const foreign: SecretSealer = {
      id: 'electron-safe-storage',
      isAvailable: () => true,
      seal: (value) => same.seal(value),
      unseal: (sealed) => same.unseal(sealed),
    };
    const third = track(openStore(location, { sealer: foreign }));
    expect(third.secrets.resolve(profile).unreadable).toEqual([password]);
  });

  it('refuses to save when secure storage is unavailable but still keeps session secrets', () => {
    const base = testSealer();
    const unavailable: SecretSealer = {
      id: 'electron-safe-storage',
      isAvailable: () => false,
      seal: (value) => base.seal(value),
      unseal: (sealed) => base.unseal(sealed),
    };
    const store = memoryStore({ sealer: unavailable });
    expect(store.secrets.canSave()).toBe(false);
    expect(thrown(() => store.secrets.set(ref('save'), PLAINTEXT))).toMatchObject({
      code: 'NOT_SUPPORTED',
      hint: expect.stringContaining('remember for this session'),
    });
    const session = ref('session');
    store.secrets.set(session, PLAINTEXT);
    expect(store.secrets.get(session)).toBe(PLAINTEXT);
  });

  it('validates refs and values', () => {
    const store = memoryStore();
    expect(thrown(() => store.secrets.set({ id: '' }, 'x'))).toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    expect(thrown(() => store.secrets.set({ id: 'toJSON' }, 'x'))).toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    expect(thrown(() => store.secrets.set(ref('save'), 42 as unknown as string))).toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    // The policy defaults to "save", as in the profile schema.
    const id = newId();
    store.secrets.set({ id }, 'x');
    expect(store.db.get('SELECT count(*) AS n FROM secrets WHERE id = ?', [id])).toEqual({ n: 1 });
  });
});

describe('secrets never leak', () => {
  it('redacts resolved secrets in JSON, inspect and string form but keeps them cloneable', () => {
    const store = memoryStore();
    const password = ref('save');
    const profile: ConnectionProfile = store.profiles.save(withSecrets({ password }));
    store.secrets.set(password, PLAINTEXT);
    const resolved = store.secrets.resolve(profile);

    for (const text of [
      JSON.stringify(resolved),
      JSON.stringify(resolved.secrets),
      inspect(resolved, { depth: 10 }),
      inspect(resolved.secrets),
      String(resolved.secrets),
      `${resolved.secrets}`,
    ]) {
      expect(text).not.toContain(PLAINTEXT);
    }
    expect(JSON.parse(JSON.stringify(resolved.secrets))).toEqual({ [password.id]: REDACTED });
    expect(Object.isFrozen(resolved.secrets)).toBe(true);
    // The connection host receives the values over a MessagePort (structured clone).
    expect(structuredClone(resolved.secrets)).toEqual({ [password.id]: PLAINTEXT });
  });

  it('keeps session values out of the secret store JSON and inspect output', () => {
    const store = memoryStore();
    store.secrets.set(ref('session'), PLAINTEXT);
    for (const text of [
      JSON.stringify(store.secrets),
      inspect(store.secrets),
      inspect(store, { depth: 5 }),
    ]) {
      expect(text).not.toContain(PLAINTEXT);
    }
  });

  it('keeps the value out of errors raised by a failing sealer', () => {
    const leaky: SecretSealer = {
      id: 'leaky',
      isAvailable: () => true,
      seal: (value) => {
        throw new Error(`cannot encrypt ${value}`);
      },
      unseal: () => '',
    };
    const store = memoryStore({ sealer: leaky });
    const error = thrown(() => store.secrets.set(ref('save'), PLAINTEXT));
    expect(error).toMatchObject({ code: 'INTERNAL', message: 'The secret could not be sealed' });
    expect(JSON.stringify(error)).not.toContain(PLAINTEXT);
    expect(inspect(error)).not.toContain(PLAINTEXT);
  });

  it('never writes plaintext to the database file or its WAL', () => {
    const dir = tempDir();
    const location = join(dir, 'querybara.db');
    const store = track(openStore(location, { sealer: testSealer() }));
    const saved = ref('save');
    const session = ref('session');
    const sessionPlaintext = `${PLAINTEXT}-session`;
    const profile = store.profiles.save(withSecrets({ password: saved, sshPassphrase: session }));
    store.secrets.set(saved, PLAINTEXT);
    store.secrets.set(session, sessionPlaintext);
    store.secrets.set(saved, `${PLAINTEXT}-v2`);
    store.secrets.set(saved, PLAINTEXT);
    expect(store.secrets.resolve(profile).missing).toEqual([]);

    const needles = [PLAINTEXT, sessionPlaintext, 'hunter2'].flatMap((text) => [
      Buffer.from(text, 'utf8'),
      Buffer.from(text, 'utf16le'),
    ]);
    const scan = () => {
      const files = [location, `${location}-wal`, `${location}-journal`].filter((file) =>
        existsSync(file),
      );
      expect(files).toContain(location);
      for (const file of files) {
        const bytes = readFileSync(file);
        for (const needle of needles) expect(bytes.includes(needle), file).toBe(false);
      }
      return files;
    };
    // While open: recent writes sit in the WAL.
    expect(scan()).toContain(`${location}-wal`);
    // After a checkpoint and close, everything is in the main file.
    store.close();
    scan();

    // And the sealed value still opens.
    const reopened = track(openStore(location, { sealer: testSealer() }));
    expect(reopened.secrets.get(saved)).toBe(PLAINTEXT);
  });
});
