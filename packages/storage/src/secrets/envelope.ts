import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';

import { JoineryError } from '@joinery/core';

/**
 * Passphrase encryption shared by the passphrase sealer and the profile export file:
 * AES-256-GCM with a key derived by scrypt from the passphrase and a random per-message salt.
 *
 * Layout (all integers one byte):
 *
 *   magic[4] | version | kdf | log2(N) | r | p | salt[16] | nonce[12] | ciphertext | tag[16]
 *
 * Everything before the ciphertext is authenticated as associated data, so changing the header
 * (or the magic) fails decryption just like changing the ciphertext.
 */

export interface ScryptCost {
  /** log2 of the CPU/memory cost N. */
  readonly log2N: number;
  readonly r: number;
  readonly p: number;
}

/** About 0.4 s and 128 MiB on a current laptop: OWASP's scrypt recommendation. */
export const DEFAULT_SCRYPT_COST: ScryptCost = { log2N: 17, r: 8, p: 1 };

const FORMAT_VERSION = 1;
const KDF_SCRYPT = 1;
const SALT_LENGTH = 16;
const NONCE_LENGTH = 12;
const TAG_LENGTH = 16;
const HEADER_LENGTH = 4 + 5 + SALT_LENGTH + NONCE_LENGTH;
const MAX_SCRYPT_MEMORY = 1024 * 1024 * 1024;

/** Bounds on the cost read from a file, so a crafted header cannot demand gigabytes or hours. */
function checkCost(cost: ScryptCost): boolean {
  const { log2N, r, p } = cost;
  return (
    Number.isInteger(log2N) &&
    Number.isInteger(r) &&
    Number.isInteger(p) &&
    log2N >= 10 &&
    log2N <= 20 &&
    r >= 1 &&
    r <= 32 &&
    p >= 1 &&
    p <= 16 &&
    128 * 2 ** log2N * r <= MAX_SCRYPT_MEMORY
  );
}

export function assertScryptCost(cost: ScryptCost): void {
  if (!checkCost(cost)) {
    throw new RangeError('scrypt cost out of range (log2N 10-20, r 1-32, p 1-16, at most 1 GiB)');
  }
}

/**
 * Derives AES keys from one passphrase and remembers them per salt, so unsealing a value sealed
 * earlier in the same process skips the deliberately slow KDF.
 */
export class PassphraseKeys {
  readonly #passphrase: string;
  readonly #cache = new Map<string, Buffer>();

  constructor(passphrase: string) {
    if (typeof passphrase !== 'string' || passphrase.length === 0) {
      throw new JoineryError({ code: 'VALIDATION_FAILED', message: 'The passphrase is empty' });
    }
    // The same passphrase typed on another OS or keyboard layout must give the same key.
    this.#passphrase = passphrase.normalize('NFC');
  }

  derive(salt: Uint8Array, cost: ScryptCost): Buffer {
    const cacheKey = `${cost.log2N}.${cost.r}.${cost.p}.${Buffer.from(salt).toString('hex')}`;
    const cached = this.#cache.get(cacheKey);
    if (cached) return cached;
    const key = scryptSync(this.#passphrase, salt, 32, {
      N: 2 ** cost.log2N,
      r: cost.r,
      p: cost.p,
      maxmem: 2 * 128 * 2 ** cost.log2N * cost.r,
    });
    if (this.#cache.size >= 256) {
      const oldest = this.#cache.keys().next();
      if (!oldest.done) this.#cache.delete(oldest.value);
    }
    this.#cache.set(cacheKey, key);
    return key;
  }

  toJSON(): string {
    return '[passphrase]';
  }

  toString(): string {
    return '[passphrase]';
  }
}

/** Encrypts `plaintext` under `magic` (4 ASCII bytes naming the payload kind). */
export function encryptEnvelope(
  magic: string,
  plaintext: Uint8Array,
  keys: PassphraseKeys,
  cost: ScryptCost,
): Uint8Array {
  assertScryptCost(cost);
  const header = Buffer.alloc(HEADER_LENGTH);
  magicBytes(magic).copy(header, 0);
  header.writeUInt8(FORMAT_VERSION, 4);
  header.writeUInt8(KDF_SCRYPT, 5);
  header.writeUInt8(cost.log2N, 6);
  header.writeUInt8(cost.r, 7);
  header.writeUInt8(cost.p, 8);
  const salt = randomBytes(SALT_LENGTH);
  const nonce = randomBytes(NONCE_LENGTH);
  salt.copy(header, 9);
  nonce.copy(header, 9 + SALT_LENGTH);
  const cipher = createCipheriv('aes-256-gcm', keys.derive(salt, cost), nonce, {
    authTagLength: TAG_LENGTH,
  });
  cipher.setAAD(header);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return new Uint8Array(Buffer.concat([header, ciphertext, cipher.getAuthTag()]));
}

/** True when `data` starts with `magic`: cheap sniffing before a (slow) decrypt. */
export function hasMagic(magic: string, data: Uint8Array): boolean {
  const expected = magicBytes(magic);
  return data.length >= 4 && expected.equals(Buffer.from(data.subarray(0, 4)));
}

/**
 * Decrypts an envelope. `what` names the payload in error messages ("export file", "sealed
 * secret"). A wrong passphrase and tampering are indistinguishable under GCM, so both report
 * AUTH_FAILED with the same message.
 */
export function decryptEnvelope(
  magic: string,
  data: Uint8Array,
  keys: PassphraseKeys,
  what: string,
): Uint8Array {
  const bytes = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (bytes.length < HEADER_LENGTH + TAG_LENGTH || !hasMagic(magic, bytes)) {
    throw new JoineryError({ code: 'VALIDATION_FAILED', message: `This is not a Joinery ${what}` });
  }
  const version = bytes.readUInt8(4);
  if (version !== FORMAT_VERSION) {
    throw new JoineryError({
      code: 'NOT_SUPPORTED',
      message: `This ${what} uses format version ${version}, which this version of Joinery cannot read`,
      hint: 'Update Joinery and try again.',
    });
  }
  const cost: ScryptCost = {
    log2N: bytes.readUInt8(6),
    r: bytes.readUInt8(7),
    p: bytes.readUInt8(8),
  };
  if (bytes.readUInt8(5) !== KDF_SCRYPT || !checkCost(cost)) {
    throw new JoineryError({ code: 'VALIDATION_FAILED', message: `The ${what} is damaged` });
  }
  const header = bytes.subarray(0, HEADER_LENGTH);
  const salt = bytes.subarray(9, 9 + SALT_LENGTH);
  const nonce = bytes.subarray(9 + SALT_LENGTH, HEADER_LENGTH);
  const ciphertext = bytes.subarray(HEADER_LENGTH, bytes.length - TAG_LENGTH);
  const tag = bytes.subarray(bytes.length - TAG_LENGTH);
  try {
    const decipher = createDecipheriv('aes-256-gcm', keys.derive(salt, cost), nonce, {
      authTagLength: TAG_LENGTH,
    });
    decipher.setAAD(header);
    decipher.setAuthTag(tag);
    return new Uint8Array(Buffer.concat([decipher.update(ciphertext), decipher.final()]));
  } catch {
    throw new JoineryError({
      code: 'AUTH_FAILED',
      message: `Could not decrypt the ${what}: the passphrase is wrong or the data was modified`,
    });
  }
}

function magicBytes(magic: string): Buffer {
  const bytes = Buffer.from(magic, 'latin1');
  if (bytes.length !== 4) throw new RangeError('Envelope magic must be 4 bytes');
  return bytes;
}
