import { createPrivateKey, generateKeyPairSync, sign, verify } from 'node:crypto';

import ssh2 from 'ssh2';
import { describe, expect, it } from 'vitest';

import { fingerprintOf, importPrivateKey } from '../src';
import { ssh2KeyFrom } from '../src/keys';
import { argon2Available, toPpk } from './helpers/ppk';
import { ed25519Pair } from './helpers/servers';

function fingerprintOfKey(text: string, passphrase?: string): string {
  const parsed = ssh2.utils.parseKey(text, passphrase);
  if (parsed instanceof Error) throw parsed;
  return fingerprintOf(parsed.getPublicSSH());
}

const rsa = ssh2.utils.generateKeyPairSync('rsa', { bits: 2048, comment: 'rsa@test' });
const ecdsa = ssh2.utils.generateKeyPairSync('ecdsa', { bits: 256 });
const ed25519 = ed25519Pair({ comment: 'me@laptop' });

describe('importPrivateKey', () => {
  it('reads an OpenSSH key: type, SHA-256 fingerprint and authorized_keys line', () => {
    const info = importPrivateKey(ed25519.private);
    expect(info).toMatchObject({
      format: 'openssh',
      encrypted: false,
      needsPassphrase: false,
      keyType: 'ssh-ed25519',
      comment: 'me@laptop',
    });
    expect(info.fingerprintSha256).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/);
    expect(info.fingerprintSha256).toBe(fingerprintOfKey(ed25519.public));
    expect(info.publicKey).toBe(ed25519.public);
    expect(info.converted).toBeUndefined();
  });

  it('shows an encrypted OpenSSH key before the passphrase, and checks the passphrase', () => {
    const locked = ed25519Pair({ passphrase: 'open sesame' });
    const before = importPrivateKey(locked.private);
    expect(before).toMatchObject({
      format: 'openssh',
      encrypted: true,
      needsPassphrase: true,
      keyType: 'ssh-ed25519',
      fingerprintSha256: fingerprintOfKey(locked.public),
    });
    expect(() => importPrivateKey(locked.private, 'wrong')).toThrow(
      expect.objectContaining({ code: 'VALIDATION_FAILED', engineCode: 'BAD_PASSPHRASE' }),
    );
    expect(importPrivateKey(locked.private, 'open sesame')).toMatchObject({
      encrypted: true,
      needsPassphrase: false,
      fingerprintSha256: fingerprintOfKey(locked.public),
    });
  });

  it('reads PEM keys (PKCS#1 RSA, SEC1 EC), encrypted or not', () => {
    const pem = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    });
    const info = importPrivateKey(pem.privateKey);
    expect(info).toMatchObject({ format: 'pem', keyType: 'ssh-rsa', encrypted: false });
    expect(info.fingerprintSha256).toBe(fingerprintOfKey(pem.privateKey));

    const encrypted = generateKeyPairSync('ec', {
      namedCurve: 'prime256v1',
      privateKeyEncoding: {
        type: 'sec1',
        format: 'pem',
        cipher: 'aes-256-cbc',
        passphrase: 'pem-pass',
      },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    });
    expect(importPrivateKey(encrypted.privateKey)).toEqual({
      format: 'pem',
      encrypted: true,
      needsPassphrase: true,
    });
    expect(importPrivateKey(encrypted.privateKey, 'pem-pass')).toMatchObject({
      keyType: 'ecdsa-sha2-nistp256',
      fingerprintSha256: fingerprintOfKey(encrypted.privateKey, 'pem-pass'),
    });
    expect(() => importPrivateKey(encrypted.privateKey, 'nope')).toThrow(
      expect.objectContaining({ engineCode: 'BAD_PASSPHRASE' }),
    );
  });

  it('reads PKCS#8 keys of every SSH key type and hands ssh2 a key it can sign with', () => {
    for (const pair of [rsa, ecdsa, ed25519]) {
      const parsed = ssh2.utils.parseKey(pair.private);
      if (parsed instanceof Error) throw parsed;
      const pkcs8 = createPrivateKey(parsed.getPrivatePEM())
        .export({ type: 'pkcs8', format: 'pem' })
        .toString();
      const info = importPrivateKey(pkcs8);
      expect(info).toMatchObject({ format: 'pkcs8', keyType: parsed.type });
      expect(info.fingerprintSha256).toBe(fingerprintOfKey(pair.public));

      const key = ssh2KeyFrom(pkcs8, undefined, 'test');
      const converted = ssh2.utils.parseKey(key.text);
      if (converted instanceof Error) throw converted;
      const data = Buffer.from('proof of possession');
      expect(parsed.verify(data, converted.sign(data))).toBe(true);
    }

    const encrypted = createPrivateKey(
      (ssh2.utils.parseKey(ed25519.private) as ssh2.ParsedKey).getPrivatePEM(),
    )
      .export({ type: 'pkcs8', format: 'pem', cipher: 'aes-256-cbc', passphrase: 'p8' })
      .toString();
    expect(importPrivateKey(encrypted)).toEqual({
      format: 'pkcs8',
      encrypted: true,
      needsPassphrase: true,
    });
    expect(importPrivateKey(encrypted, 'p8').fingerprintSha256).toBe(
      fingerprintOfKey(ed25519.public),
    );
  });

  it('rejects public keys and junk with a clear message', () => {
    expect(() => importPrivateKey(ed25519.public)).toThrow(/public key/);
    expect(() => importPrivateKey('hello')).toThrow(
      expect.objectContaining({ code: 'VALIDATION_FAILED' }),
    );
    const dsaLike = 'PuTTY-User-Key-File-2: ssh-dss\nEncryption: none\n';
    expect(() => importPrivateKey(dsaLike)).toThrow(/missing required fields/);
  });
});

describe('PuTTY PPK keys', () => {
  it('matches ssh2 on PPK version 2 RSA keys, plain and encrypted', () => {
    const plain = toPpk(rsa.private, { version: 2, comment: 'rsa-key' });
    const encrypted = toPpk(rsa.private, { version: 2, passphrase: 'putty' });
    // ssh2 parses PPK v2 RSA itself: an independent check of the layout.
    expect(fingerprintOfKey(plain)).toBe(fingerprintOfKey(rsa.public));
    expect(fingerprintOfKey(encrypted, 'putty')).toBe(fingerprintOfKey(rsa.public));

    expect(importPrivateKey(plain)).toMatchObject({
      format: 'ppk',
      encrypted: false,
      keyType: 'ssh-rsa',
      comment: 'rsa-key',
      fingerprintSha256: fingerprintOfKey(rsa.public),
    });
    expect(importPrivateKey(encrypted)).toMatchObject({
      format: 'ppk',
      encrypted: true,
      needsPassphrase: true,
      fingerprintSha256: fingerprintOfKey(rsa.public),
    });
    expect(() => importPrivateKey(encrypted, 'wrong')).toThrow(
      expect.objectContaining({ engineCode: 'BAD_PASSPHRASE' }),
    );
    expect(importPrivateKey(encrypted, 'putty').needsPassphrase).toBe(false);
  });

  it('reads version 3 Ed25519 and ECDSA keys, which ssh2 cannot', () => {
    for (const pair of [ed25519, ecdsa]) {
      const ppk = toPpk(pair.private, { version: 3 });
      expect(ssh2.utils.parseKey(ppk)).toBeInstanceOf(Error);
      const info = importPrivateKey(ppk);
      expect(info.fingerprintSha256).toBe(fingerprintOfKey(pair.public));
      const key = ssh2KeyFrom(ppk, undefined, 'test');
      expect(fingerprintOfKey(key.text)).toBe(fingerprintOfKey(pair.public));
    }
  });

  it('converts a PPK to PKCS#8 PEM, keeping its passphrase', () => {
    const encrypted = toPpk(ed25519.private, { version: 2, passphrase: 'keep-me' });
    const info = importPrivateKey(encrypted, 'keep-me');
    expect(info.converted).toMatch(/^-----BEGIN ENCRYPTED PRIVATE KEY-----/);
    expect(importPrivateKey(info.converted!, 'keep-me').fingerprintSha256).toBe(
      info.fingerprintSha256,
    );

    const plain = importPrivateKey(toPpk(rsa.private, { version: 3 }));
    expect(plain.converted).toMatch(/^-----BEGIN PRIVATE KEY-----/);
    // The converted key signs like the original.
    const data = Buffer.from('signed');
    const signature = sign(null, data, createPrivateKey(plain.converted!));
    const original = ssh2.utils.parseKey(rsa.private) as ssh2.ParsedKey;
    expect(verify(null, data, createPrivateKey(original.getPrivatePEM()), signature)).toBe(true);
  });

  it('detects a tampered PPK', () => {
    const ppk = toPpk(ed25519.private, { version: 3 }).replace(
      'Comment: imported-key',
      'Comment: tampered',
    );
    expect(() => importPrivateKey(ppk)).toThrow(/integrity check/);
  });

  it.runIf(argon2Available)('reads encrypted version 3 keys (Argon2id)', () => {
    const ppk = toPpk(ed25519.private, { version: 3, passphrase: 'argon' });
    expect(importPrivateKey(ppk, 'argon').fingerprintSha256).toBe(fingerprintOfKey(ed25519.public));
    expect(() => importPrivateKey(ppk, 'nope')).toThrow(
      expect.objectContaining({ engineCode: 'BAD_PASSPHRASE' }),
    );
  });

  it.skipIf(argon2Available)('explains encrypted version 3 keys on runtimes without Argon2', () => {
    const ppk = [
      'PuTTY-User-Key-File-3: ssh-ed25519',
      'Encryption: aes256-cbc',
      'Comment: k',
      'Public-Lines: 1',
      'AAAAC3NzaC1lZDI1NTE5AAAAIA==',
      'Key-Derivation: Argon2id',
      'Argon2-Memory: 8192',
      'Argon2-Passes: 3',
      'Argon2-Parallelism: 1',
      'Argon2-Salt: 00',
      'Private-Lines: 1',
      'AAAAAAAAAAAAAAAAAAAAAA==',
      'Private-MAC: 00',
    ].join('\n');
    expect(importPrivateKey(ppk)).toMatchObject({ format: 'ppk', needsPassphrase: true });
    expect(() => importPrivateKey(ppk, 'x')).toThrow(/Argon2/);
  });
});

describe('ssh2KeyFrom', () => {
  it('names the key file and never the passphrase', () => {
    const locked = ed25519Pair({ passphrase: 'hunter2-secret' });
    expect(() => ssh2KeyFrom(locked.private, undefined, '"~/.ssh/id"')).toThrow(
      expect.objectContaining({ code: 'SSH_FAILED', engineCode: 'PASSPHRASE_REQUIRED' }),
    );
    let error: unknown;
    try {
      ssh2KeyFrom(locked.private, 'wrong-guess', '"~/.ssh/id"');
    } catch (e) {
      error = e;
    }
    expect(error).toMatchObject({ code: 'SSH_FAILED', engineCode: 'BAD_PASSPHRASE' });
    expect(JSON.stringify(error)).not.toContain('wrong-guess');
    expect(String((error as Error).message)).toContain('~/.ssh/id');
    expect(ssh2KeyFrom(locked.private, 'hunter2-secret', 'k')).toEqual({
      text: locked.private.trim(),
      passphrase: 'hunter2-secret',
    });
  });
});
