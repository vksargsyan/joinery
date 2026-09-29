import { JoineryError } from '@joinery/core';

import {
  DEFAULT_SCRYPT_COST,
  PassphraseKeys,
  assertScryptCost,
  decryptEnvelope,
  encryptEnvelope,
  type ScryptCost,
} from './envelope';

/**
 * Seals secret values before they reach the database (spec §4, §18). The desktop app
 * implements it with Electron safeStorage (Keychain, DPAPI, libsecret); joinery-cli on a
 * headless machine without a keychain uses `createPassphraseSealer`.
 */
export interface SecretSealer {
  /**
   * Stable name of the sealing scheme, stored next to each sealed value, e.g.
   * "electron-safe-storage". A value sealed by another scheme is reported as unreadable instead
   * of being fed to the wrong `unseal`.
   */
  readonly id: string;
  /** False when the OS offers no secure storage (e.g. Linux without a secret service). */
  isAvailable(): boolean;
  seal(plaintext: string): Uint8Array;
  /** Throws when the value cannot be unsealed (other machine, other user, rotated key). */
  unseal(sealed: Uint8Array): string;
}

export interface PassphraseSealerOptions {
  /** scrypt cost; lower it only in tests. Values sealed earlier keep their own cost. */
  readonly cost?: ScryptCost;
}

const SEALED_MAGIC = 'JNS1';
export const PASSPHRASE_SEALER_ID = 'passphrase-v1';

/**
 * A sealer keyed by a passphrase: AES-256-GCM with a scrypt-derived key and a fresh random salt
 * and nonce per value, in a versioned format. For joinery-cli on machines without a keychain.
 * The passphrase stays in a private field and never shows in JSON, inspect or errors.
 */
export function createPassphraseSealer(
  passphrase: string,
  options: PassphraseSealerOptions = {},
): SecretSealer {
  return new PassphraseSealer(passphrase, options.cost ?? DEFAULT_SCRYPT_COST);
}

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

class PassphraseSealer implements SecretSealer {
  readonly id = PASSPHRASE_SEALER_ID;
  readonly #keys: PassphraseKeys;
  readonly #cost: ScryptCost;

  constructor(passphrase: string, cost: ScryptCost) {
    assertScryptCost(cost);
    this.#keys = new PassphraseKeys(passphrase);
    this.#cost = cost;
  }

  isAvailable(): boolean {
    return true;
  }

  seal(plaintext: string): Uint8Array {
    if (typeof plaintext !== 'string') {
      throw new JoineryError({ code: 'VALIDATION_FAILED', message: 'Only strings can be sealed' });
    }
    return encryptEnvelope(SEALED_MAGIC, encoder.encode(plaintext), this.#keys, this.#cost);
  }

  unseal(sealed: Uint8Array): string {
    const plaintext = decryptEnvelope(SEALED_MAGIC, sealed, this.#keys, 'sealed secret');
    try {
      return decoder.decode(plaintext);
    } catch {
      throw new JoineryError({
        code: 'VALIDATION_FAILED',
        message: 'The sealed secret is damaged',
      });
    }
  }

  toJSON(): { id: string } {
    return { id: this.id };
  }

  toString(): string {
    return `[SecretSealer ${this.id}]`;
  }
}
