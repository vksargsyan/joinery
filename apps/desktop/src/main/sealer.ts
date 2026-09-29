import { JoineryError } from '@joinery/core';
import type { SecretSealer } from '@joinery/storage';

/** The part of Electron's `safeStorage` the sealer uses, typed structurally for tests. */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Uint8Array;
  decryptString(encrypted: Buffer): string;
  /** Linux only: which secret store Chromium picked ("basic_text" means none). */
  getSelectedStorageBackend?(): string;
}

export const SAFE_STORAGE_SEALER_ID = 'electron-safe-storage';

/**
 * Linux backends that do not protect anything: with no secret service (GNOME Keyring, KWallet)
 * Chromium falls back to a hard-coded key and still reports encryption as available.
 */
const UNPROTECTED_LINUX_BACKENDS = new Set(['basic_text', 'unknown']);

/**
 * A SecretSealer on Electron safeStorage (spec §4, §18: Keychain, DPAPI, libsecret). It reports
 * itself unavailable when the OS offers no real secret store, so saving a secret fails with a
 * clear NOT_SUPPORTED while "remember for this session" and "ask every time" keep working.
 * Call only after the app is ready (safeStorage requires it on Linux).
 */
export function createSafeStorageSealer(
  safeStorage: SafeStorageLike,
  platform: string = process.platform,
): SecretSealer {
  const isAvailable = (): boolean => {
    if (!safeStorage.isEncryptionAvailable()) return false;
    if (platform !== 'linux') return true;
    const backend = safeStorage.getSelectedStorageBackend?.() ?? 'unknown';
    return !UNPROTECTED_LINUX_BACKENDS.has(backend);
  };
  return {
    id: SAFE_STORAGE_SEALER_ID,
    isAvailable,
    seal(plaintext) {
      if (!isAvailable()) {
        throw new JoineryError({
          code: 'NOT_SUPPORTED',
          message: 'No secure storage is available on this system',
          hint: 'Install and unlock a secret service (GNOME Keyring or KWallet), or choose "remember for this session".',
        });
      }
      return new Uint8Array(safeStorage.encryptString(plaintext));
    },
    unseal(sealed) {
      if (!isAvailable()) {
        throw new JoineryError({ code: 'NOT_SUPPORTED', message: 'Secure storage is unavailable' });
      }
      return safeStorage.decryptString(Buffer.from(sealed));
    },
  };
}
