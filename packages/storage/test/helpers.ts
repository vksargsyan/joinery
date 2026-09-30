import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { newId } from '@joinery/core';
import { afterEach } from 'vitest';

import {
  createPassphraseSealer,
  openStore,
  type ProfileSaveInput,
  type ScryptCost,
  type SecretSealer,
  type Store,
} from '../src';

/** Cheap scrypt parameters so sealing in tests takes milliseconds. */
export const TEST_COST: ScryptCost = { log2N: 10, r: 8, p: 1 };

export function testSealer(passphrase = 'correct horse battery staple'): SecretSealer {
  return createPassphraseSealer(passphrase, { cost: TEST_COST });
}

/** A clock that only moves when told to, one second at a time by default. */
export function fakeClock(start = '2026-09-29T10:00:00.000Z') {
  let current = Date.parse(start);
  return {
    now: () => new Date(current),
    advance(ms = 1000) {
      current += ms;
    },
    iso: () => new Date(current).toISOString(),
  };
}

const openStores: Store[] = [];
const tempDirs: string[] = [];

afterEach(() => {
  for (const store of openStores.splice(0)) store.close();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** An in-memory store, closed after the test. */
export function memoryStore(
  options: { sealer?: SecretSealer; clock?: ReturnType<typeof fakeClock> } = {},
): Store {
  const clock = options.clock ?? fakeClock();
  const store = openStore(':memory:', { sealer: options.sealer ?? testSealer(), now: clock.now });
  openStores.push(store);
  return store;
}

/** A fresh temporary directory, deleted after the test. */
export function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'joinery-storage-'));
  tempDirs.push(dir);
  return dir;
}

/** Registers a store opened by the test itself so it is closed afterwards. */
export function track(store: Store): Store {
  openStores.push(store);
  return store;
}

export function postgresProfile(overrides: Partial<ProfileSaveInput> = {}): ProfileSaveInput {
  return {
    name: 'Local Postgres',
    engine: 'postgres',
    endpoint: { kind: 'host', host: 'localhost', port: 5432 },
    auth: { method: 'password', user: 'app', password: { id: newId(), policy: 'save' } },
    ...overrides,
  };
}

/** The value `fn` throws (fails the test when it does not throw). */
export function thrown(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error('Expected the call to throw');
}
