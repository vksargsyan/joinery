import * as nodeCrypto from 'node:crypto';
import { createCipheriv, createHash, createHmac, createPrivateKey, randomBytes } from 'node:crypto';

import ssh2 from 'ssh2';

import { mpint, wireString, wireUint32 } from '../../src/wire';

/**
 * Writes PuTTY PPK files (format versions 2 and 3) from an OpenSSH key, following PuTTY's
 * sshpubk.c, so the tests can feed the parser real PPK layouts without PuTTYgen.
 */

type Argon2 = (
  algorithm: 'argon2id',
  parameters: {
    message: Buffer;
    nonce: Buffer;
    parallelism: number;
    tagLength: number;
    memory: number;
    passes: number;
  },
) => Buffer;

export const argon2Available =
  typeof (nodeCrypto as unknown as { argon2Sync?: Argon2 }).argon2Sync === 'function';

function lines(data: Buffer): string[] {
  return data.toString('base64').match(/.{1,64}/g) ?? [];
}

export function toPpk(
  opensshKey: string,
  options: { version: 2 | 3; passphrase?: string; comment?: string },
): string {
  const parsed = ssh2.utils.parseKey(opensshKey);
  if (parsed instanceof Error) throw parsed;
  const jwk = createPrivateKey(parsed.getPrivatePEM()).export({ format: 'jwk' });
  const b = (value: string | undefined): Buffer => Buffer.from(value ?? '', 'base64url');
  const algorithm = parsed.type;
  let privateBlob: Buffer;
  if (algorithm === 'ssh-rsa') {
    privateBlob = Buffer.concat([
      mpint(b(jwk.d)),
      mpint(b(jwk.p)),
      mpint(b(jwk.q)),
      mpint(b(jwk.qi)),
    ]);
  } else if (algorithm === 'ssh-ed25519') {
    privateBlob = wireString(b(jwk.d));
  } else {
    privateBlob = mpint(b(jwk.d));
  }
  const publicBlob = parsed.getPublicSSH();
  const comment = options.comment ?? 'imported-key';
  const encryption = options.passphrase ? 'aes256-cbc' : 'none';
  if (options.passphrase) {
    const padding = (16 - (privateBlob.length % 16)) % 16;
    privateBlob = Buffer.concat([privateBlob, randomBytes(padding)]);
  }
  const pass = Buffer.from(options.passphrase ?? '');
  let cipherKey: Buffer | undefined;
  let iv: Buffer | undefined;
  let macKey: Buffer;
  const extra: string[] = [];
  if (options.version === 2) {
    macKey = createHash('sha1').update('putty-private-key-file-mac-key').update(pass).digest();
    if (options.passphrase) {
      cipherKey = Buffer.concat([
        createHash('sha1').update(wireUint32(0)).update(pass).digest(),
        createHash('sha1').update(wireUint32(1)).update(pass).digest(),
      ]).subarray(0, 32);
      iv = Buffer.alloc(16);
    }
  } else if (options.passphrase) {
    const argon2Sync = (nodeCrypto as unknown as { argon2Sync: Argon2 }).argon2Sync;
    const salt = randomBytes(16);
    const derived = argon2Sync('argon2id', {
      message: pass,
      nonce: salt,
      parallelism: 1,
      tagLength: 80,
      memory: 8192,
      passes: 3,
    });
    cipherKey = derived.subarray(0, 32);
    iv = derived.subarray(32, 48);
    macKey = derived.subarray(48, 80);
    extra.push(
      'Key-Derivation: Argon2id',
      'Argon2-Memory: 8192',
      'Argon2-Passes: 3',
      'Argon2-Parallelism: 1',
      `Argon2-Salt: ${salt.toString('hex')}`,
    );
  } else {
    macKey = Buffer.alloc(0);
  }
  const mac = createHmac(options.version === 2 ? 'sha1' : 'sha256', macKey)
    .update(
      Buffer.concat([
        wireString(algorithm),
        wireString(encryption),
        wireString(comment),
        wireString(publicBlob),
        wireString(privateBlob),
      ]),
    )
    .digest('hex');
  let stored = privateBlob;
  if (cipherKey && iv) {
    const cipher = createCipheriv('aes-256-cbc', cipherKey, iv);
    cipher.setAutoPadding(false);
    stored = Buffer.concat([cipher.update(privateBlob), cipher.final()]);
  }
  const publicLines = lines(publicBlob);
  const privateLines = lines(stored);
  return [
    `PuTTY-User-Key-File-${options.version}: ${algorithm}`,
    `Encryption: ${encryption}`,
    `Comment: ${comment}`,
    `Public-Lines: ${publicLines.length}`,
    ...publicLines,
    ...extra,
    `Private-Lines: ${privateLines.length}`,
    ...privateLines,
    `Private-MAC: ${mac}`,
    '',
  ].join('\r\n');
}
