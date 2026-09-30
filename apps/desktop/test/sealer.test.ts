import { openStore } from '@joinery/storage';
import { describe, expect, it } from 'vitest';

import {
  SAFE_STORAGE_SEALER_ID,
  createSafeStorageSealer,
  type SafeStorageLike,
} from '../src/main/sealer';

/** A stand-in for Electron's safeStorage: XOR "encryption", enough to see values round-trip. */
function fakeSafeStorage(options: { available: boolean; backend?: string }): SafeStorageLike & {
  encrypted: string[];
} {
  const encrypted: string[] = [];
  const xor = (bytes: Uint8Array): Uint8Array => bytes.map((b) => b ^ 0x5a);
  return {
    encrypted,
    isEncryptionAvailable: () => options.available,
    encryptString(plain) {
      encrypted.push(plain);
      return Buffer.from(xor(new TextEncoder().encode(plain)));
    },
    decryptString(buffer) {
      return new TextDecoder().decode(xor(new Uint8Array(buffer)));
    },
    ...(options.backend === undefined ? {} : { getSelectedStorageBackend: () => options.backend! }),
  };
}

describe('safeStorage sealer', () => {
  it('seals and unseals through safeStorage without storing plaintext', () => {
    const storage = fakeSafeStorage({ available: true });
    const sealer = createSafeStorageSealer(storage, 'darwin');
    expect(sealer.id).toBe(SAFE_STORAGE_SEALER_ID);
    expect(sealer.isAvailable()).toBe(true);
    const sealed = sealer.seal('hunter2');
    expect(sealed).toBeInstanceOf(Uint8Array);
    expect(new TextDecoder().decode(sealed)).not.toContain('hunter2');
    expect(sealer.unseal(sealed)).toBe('hunter2');
  });

  it('treats Linux without a secret service as unavailable', () => {
    for (const backend of ['basic_text', 'unknown']) {
      const sealer = createSafeStorageSealer(
        fakeSafeStorage({ available: true, backend }),
        'linux',
      );
      expect(sealer.isAvailable(), backend).toBe(false);
    }
    for (const backend of ['gnome_libsecret', 'kwallet5', 'kwallet6']) {
      const sealer = createSafeStorageSealer(
        fakeSafeStorage({ available: true, backend }),
        'linux',
      );
      expect(sealer.isAvailable(), backend).toBe(true);
    }
    expect(
      createSafeStorageSealer(fakeSafeStorage({ available: true }), 'linux').isAvailable(),
    ).toBe(false);
    expect(
      createSafeStorageSealer(fakeSafeStorage({ available: false }), 'win32').isAvailable(),
    ).toBe(false);
  });

  it('refuses to seal clearly when unavailable, without echoing the value', () => {
    const storage = fakeSafeStorage({ available: true, backend: 'basic_text' });
    const sealer = createSafeStorageSealer(storage, 'linux');
    let error: unknown;
    try {
      sealer.seal('hunter2');
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ code: 'NOT_SUPPORTED' });
    expect(JSON.stringify(error)).not.toContain('hunter2');
    expect(String((error as Error).message)).not.toContain('hunter2');
    expect(storage.encrypted).toEqual([]);
  });

  it('keeps "session" and "ask" secrets working in the store when saving is impossible', () => {
    const store = openStore(':memory:', {
      sealer: createSafeStorageSealer(
        fakeSafeStorage({ available: true, backend: 'basic_text' }),
        'linux',
      ),
    });
    try {
      expect(store.secrets.canSave()).toBe(false);
      const id = crypto.randomUUID();
      expect(() => store.secrets.set({ id, policy: 'save' }, 'hunter2')).toThrow(
        expect.objectContaining({ code: 'NOT_SUPPORTED' }),
      );
      store.secrets.set({ id, policy: 'session' }, 'hunter2');
      expect(store.secrets.get({ id, policy: 'session' })).toBe('hunter2');
      expect(store.secrets.get({ id, policy: 'ask' })).toBeUndefined();
    } finally {
      store.close();
    }
  });

  it('stores sealed values that only the same safeStorage can open', () => {
    const storage = fakeSafeStorage({ available: true, backend: 'gnome_libsecret' });
    const store = openStore(':memory:', { sealer: createSafeStorageSealer(storage, 'linux') });
    try {
      const ref = { id: crypto.randomUUID(), policy: 'save' as const };
      store.secrets.set(ref, 'hunter2');
      expect(storage.encrypted).toEqual(['hunter2']);
      const raw = store.db.get('SELECT sealed FROM secrets WHERE id = ?', [ref.id]);
      expect(new TextDecoder().decode(raw?.['sealed'] as Uint8Array)).not.toContain('hunter2');
      expect(store.secrets.get(ref)).toBe('hunter2');
    } finally {
      store.close();
    }
  });
});
