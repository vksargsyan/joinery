import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  scrypt,
  timingSafeEqual,
} from 'node:crypto';

import { JoineryError } from '@joinery/core';

/**
 * Passphrase encryption of Joinery archives: scrypt turns the passphrase and a random salt into
 * two independent 256-bit keys, one for AES-256-GCM over every frame of every entry and one for
 * an HMAC-SHA256 over the archive header (so a wrong passphrase is told apart from a damaged
 * frame). Frames use the STREAM construction: the nonce is a random per-entry prefix plus the
 * frame counter, and the associated data binds the entry header, the counter and a "last frame"
 * flag, so frames cannot be reordered, moved between entries or cut off at the end undetected.
 *
 * The passphrase itself is never stored, logged or kept after the keys are derived.
 */

/** scrypt cost, stored in the archive header. */
export interface ScryptCost {
  /** log2 of the CPU/memory cost N. */
  readonly log2N: number;
  readonly r: number;
  readonly p: number;
}

/** About 0.4 s and 128 MiB on a current laptop: OWASP's scrypt recommendation. */
export const DEFAULT_SCRYPT_COST: ScryptCost = { log2N: 17, r: 8, p: 1 };

export const SALT_LENGTH = 16;
export const NONCE_PREFIX_LENGTH = 8;
export const TAG_LENGTH = 16;
export const KEY_CHECK_LENGTH = 32;
const MAX_SCRYPT_MEMORY = 1024 * 1024 * 1024;

/** Bounds on the cost read from a file, so a crafted header cannot demand gigabytes or hours. */
export function isValidScryptCost(cost: ScryptCost): boolean {
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

/** The two keys derived from a passphrase. */
export interface ArchiveKeys {
  /** AES-256-GCM key for frames. */
  readonly encryption: Buffer;
  /** HMAC-SHA256 key for the header check. */
  readonly check: Buffer;
}

/** Derives the archive keys; slow on purpose (see DEFAULT_SCRYPT_COST). */
export async function deriveKeys(
  passphrase: string,
  salt: Uint8Array,
  cost: ScryptCost,
): Promise<ArchiveKeys> {
  if (passphrase.length === 0) {
    throw new JoineryError({ code: 'VALIDATION_FAILED', message: 'The passphrase is empty' });
  }
  if (!isValidScryptCost(cost)) {
    throw new JoineryError({
      code: 'VALIDATION_FAILED',
      message: 'The archive asks for key derivation settings outside the allowed range',
    });
  }
  // The same passphrase typed on another OS or keyboard layout must give the same key.
  const normalized = passphrase.normalize('NFC');
  const derived = await new Promise<Buffer>((resolve, reject) => {
    scrypt(
      normalized,
      salt,
      64,
      { N: 2 ** cost.log2N, r: cost.r, p: cost.p, maxmem: 2 * 128 * 2 ** cost.log2N * cost.r },
      (error, key) => (error ? reject(error) : resolve(key)),
    );
  });
  return { encryption: derived.subarray(0, 32), check: derived.subarray(32, 64) };
}

export function randomSalt(): Uint8Array {
  return randomBytes(SALT_LENGTH);
}

export function randomNoncePrefix(): Uint8Array {
  return randomBytes(NONCE_PREFIX_LENGTH);
}

/** HMAC-SHA256 of the header bytes with the check key. */
export function headerMac(keys: ArchiveKeys, header: Uint8Array): Uint8Array {
  return createHmac('sha256', keys.check).update(header).digest();
}

/** Constant-time comparison of the stored and the computed header MAC. */
export function headerMacMatches(keys: ArchiveKeys, header: Uint8Array, mac: Uint8Array): boolean {
  const expected = headerMac(keys, header);
  return mac.length === expected.length && timingSafeEqual(expected, mac);
}

function frameNonce(prefix: Uint8Array, frame: number): Buffer {
  const nonce = Buffer.alloc(12);
  Buffer.from(prefix.buffer, prefix.byteOffset, prefix.byteLength).copy(nonce, 0);
  nonce.writeUInt32BE(frame >>> 0, 8);
  return nonce;
}

function frameAad(entryHeader: Uint8Array, frame: number, last: boolean): Buffer {
  const aad = Buffer.alloc(entryHeader.length + 5);
  Buffer.from(entryHeader.buffer, entryHeader.byteOffset, entryHeader.byteLength).copy(aad, 0);
  aad.writeUInt32BE(frame >>> 0, entryHeader.length);
  aad.writeUInt8(last ? 1 : 0, entryHeader.length + 4);
  return aad;
}

/** A frame's ciphertext followed by its 16-byte tag. */
export function sealFrame(
  key: Buffer,
  entryHeader: Uint8Array,
  noncePrefix: Uint8Array,
  frame: number,
  last: boolean,
  plaintext: Uint8Array,
): Uint8Array {
  const cipher = createCipheriv('aes-256-gcm', key, frameNonce(noncePrefix, frame), {
    authTagLength: TAG_LENGTH,
  });
  cipher.setAAD(frameAad(entryHeader, frame, last));
  return Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
}

/** Decrypts and authenticates one frame; tampering fails with AUTH_FAILED. */
export function openFrame(
  key: Buffer,
  entryHeader: Uint8Array,
  noncePrefix: Uint8Array,
  frame: number,
  last: boolean,
  sealed: Uint8Array,
  what: string,
): Uint8Array {
  if (sealed.length < TAG_LENGTH) throw damaged(what);
  const body = sealed.subarray(0, sealed.length - TAG_LENGTH);
  const tag = sealed.subarray(sealed.length - TAG_LENGTH);
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, frameNonce(noncePrefix, frame), {
      authTagLength: TAG_LENGTH,
    });
    decipher.setAAD(frameAad(entryHeader, frame, last));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]);
  } catch {
    throw new JoineryError({
      code: 'AUTH_FAILED',
      message: `The backup was modified or is damaged: ${what} failed its integrity check`,
    });
  }
}

export function damaged(what: string, detail?: string): JoineryError {
  return new JoineryError({
    code: 'VALIDATION_FAILED',
    message: `The backup is damaged: ${what}${detail ? ` (${detail})` : ''}`,
  });
}
