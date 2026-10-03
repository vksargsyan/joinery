import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

import { QuerybaraError, connectionProfileSchema } from '@querybara/core';
import { ER_MODEL_FORMAT, erModelDocumentSchema, scheduleTaskSchema } from '@querybara/ipc';
import { openDatabase, openStore, type SecretSealer, type Store } from '@querybara/storage';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { erModelHandlers } from '../src/main/er-models';
import {
  KNOWN_HOSTS_FILE,
  LOCAL_STATE_FILE,
  PREVIOUS_DIR_NAME,
  PREVIOUS_STORE_FILE,
  SSH_KEYS_DIR,
  STORE_FILE,
  migratePreviousInstall,
  type PreviousInstallResult,
} from '../src/main/previous-install';
import { SAFE_STORAGE_SEALER_ID } from '../src/main/sealer';
import { resolveProfile } from '../src/main/secrets';
import { shop } from './er-fixtures';
import { profileInput } from './helpers';

/** How 0.1.0 wrote the values that carried its name in lower case. */
const OLD_ID = PREVIOUS_DIR_NAME.toLowerCase();

/** A safeStorage-like sealer: XOR with `key`, so another key reads garbage or fails. */
function sealer(key: number, options: { readonly failsToOpen?: boolean } = {}): SecretSealer {
  return {
    id: SAFE_STORAGE_SEALER_ID,
    isAvailable: () => true,
    seal: (plain) => new TextEncoder().encode(plain).map((b) => b ^ key),
    unseal(sealed) {
      // Chromium refuses a value sealed under another app's key.
      if (options.failsToOpen) throw new Error('Error while decrypting the ciphertext');
      return new TextDecoder().decode(sealed.map((b) => b ^ key));
    },
  };
}

let root: string;
let appData: string;
let oldDir: string;
let userData: string;
let logged: string[];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'querybara-previous-'));
  appData = join(root, 'appData');
  oldDir = join(appData, PREVIOUS_DIR_NAME);
  userData = join(appData, 'Querybara');
  logged = [];
  mkdirSync(oldDir, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function run(): PreviousInstallResult {
  return migratePreviousInstall({
    appDataDir: appData,
    userDataDir: userData,
    log: (message) => logged.push(message),
  });
}

function oldStore(): Store {
  return openStore(join(oldDir, PREVIOUS_STORE_FILE), { sealer: sealer(0x5a) });
}

function newStore(key = 0x5a, options: { readonly failsToOpen?: boolean } = {}): Store {
  return openStore(join(userData, STORE_FILE), { sealer: sealer(key, options) });
}

/** A profile with a saved password, as 0.1.0 kept it. */
function seedOldInstall(): { readonly profileId: string; readonly passwordRef: string } {
  const store = oldStore();
  try {
    const input = profileInput();
    const profile = store.profiles.save(input);
    const auth = profile.auth as { password: { id: string; policy: 'save' } };
    store.secrets.set(auth.password, 'hunter2');
    return { profileId: profile.id, passwordRef: auth.password.id };
  } finally {
    store.close();
  }
}

/** Every file under `dir` with a digest of its contents, to show it was left as it was. */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) walk(path);
      else {
        const info = statSync(path);
        out[relative(dir, path)] =
          `${createHash('sha256').update(readFileSync(path)).digest('hex')}:${info.mtimeMs}`;
      }
    }
  };
  walk(dir);
  return out;
}

describe('moving a 0.1.0 install', () => {
  it('copies the store, known hosts, SSH keys and Local State once, leaving the old folder as it was', () => {
    const { profileId, passwordRef } = seedOldInstall();
    writeFileSync(join(oldDir, KNOWN_HOSTS_FILE), 'bastion.example.com ssh-ed25519 AAAA\n');
    writeFileSync(join(oldDir, LOCAL_STATE_FILE), '{"os_crypt":{"encrypted_key":"RFBBUEk="}}');
    mkdirSync(join(oldDir, SSH_KEYS_DIR), { mode: 0o700 });
    writeFileSync(join(oldDir, SSH_KEYS_DIR, 'work-0123456789ab.pem'), 'PEM', { mode: 0o600 });
    const before = snapshot(oldDir);

    const result = run();

    expect(result).toEqual({
      status: 'migrated',
      from: oldDir,
      copied: [STORE_FILE, KNOWN_HOSTS_FILE, LOCAL_STATE_FILE, SSH_KEYS_DIR],
    });
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain('Copied the data of version 0.1.0');
    expect(snapshot(oldDir)).toEqual(before);
    expect(existsSync(join(userData, PREVIOUS_STORE_FILE))).toBe(false);
    expect(readFileSync(join(userData, KNOWN_HOSTS_FILE), 'utf8')).toContain('bastion');
    expect(readFileSync(join(userData, SSH_KEYS_DIR, 'work-0123456789ab.pem'), 'utf8')).toBe('PEM');
    expect(readdirSync(userData).filter((name) => name.startsWith('.moving'))).toEqual([]);
    if (process.platform !== 'win32') {
      expect(statSync(join(userData, STORE_FILE)).mode & 0o777).toBe(0o600);
      expect(statSync(join(userData, SSH_KEYS_DIR)).mode & 0o777).toBe(0o700);
    }

    const store = newStore();
    try {
      expect(store.profiles.list().map((p) => p.id)).toEqual([profileId]);
      // Same key (Windows, with the copied Local State): the saved password still opens.
      const profile = store.profiles.get(profileId)!;
      expect(resolveProfile(store, profile, {}, { requireAll: true }).secrets[passwordRef]).toBe(
        'hunter2',
      );
      // A later change in Querybara is not undone by a second start.
      store.profiles.save({ ...profile, name: 'Renamed' });
    } finally {
      store.close();
    }

    expect(run()).toEqual({ status: 'skipped', reason: 'has-data' });
    const again = newStore();
    try {
      expect(again.profiles.get(profileId)!.name).toBe('Renamed');
    } finally {
      again.close();
    }
  });

  it('leaves existing Querybara data alone', () => {
    seedOldInstall();
    const existing = newStore();
    existing.profiles.save(profileInput({ name: 'Mine' }));
    existing.close();
    writeFileSync(join(oldDir, KNOWN_HOSTS_FILE), 'old\n');
    const before = snapshot(userData);

    expect(run()).toEqual({ status: 'skipped', reason: 'has-data' });
    expect(snapshot(userData)).toEqual(before);
    expect(logged).toEqual([]);
  });

  it('does nothing without an old install', () => {
    rmSync(oldDir, { recursive: true });
    expect(run()).toEqual({ status: 'skipped', reason: 'no-previous-data' });
    mkdirSync(oldDir);
    writeFileSync(join(oldDir, KNOWN_HOSTS_FILE), 'old\n');
    expect(run()).toEqual({ status: 'skipped', reason: 'no-previous-data' });
    expect(existsSync(userData)).toBe(false);
    expect(logged).toEqual([]);
  });

  it('starts fresh when the old store is damaged', () => {
    writeFileSync(join(oldDir, PREVIOUS_STORE_FILE), 'not a database, just text'.repeat(200));
    writeFileSync(join(oldDir, KNOWN_HOSTS_FILE), 'old\n');
    const before = snapshot(oldDir);

    const result = run();

    expect(result.status).toBe('failed');
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain('starting fresh');
    expect(snapshot(oldDir)).toEqual(before);
    // Nothing half-copied: no store, no known hosts, no staging folder.
    expect(readdirSync(userData)).toEqual([]);
    const store = newStore();
    try {
      expect(store.profiles.count()).toBe(0);
    } finally {
      store.close();
    }
  });

  it('copies what is committed while the old app holds the store open and writes', () => {
    const { profileId } = seedOldInstall();
    // The old app is running: a commit still in the write-ahead log, and a write in progress.
    const running = oldStore();
    const second = running.profiles.save(profileInput({ name: 'Only in the WAL' }));
    const writer = openDatabase(join(oldDir, PREVIOUS_STORE_FILE));
    writer.exec('BEGIN IMMEDIATE');
    writer.run(`UPDATE profiles SET name = 'uncommitted'`);
    try {
      expect(existsSync(join(oldDir, `${PREVIOUS_STORE_FILE}-wal`))).toBe(true);
      expect(run().status).toBe('migrated');
    } finally {
      writer.exec('ROLLBACK');
      writer.close();
      running.close();
    }
    const store = newStore();
    try {
      expect(
        store.profiles
          .list()
          .map((p) => [p.id, p.name])
          .sort(),
      ).toEqual(
        [
          [profileId, 'Local Postgres'],
          [second.id, 'Only in the WAL'],
        ].sort(),
      );
    } finally {
      store.close();
    }
  });

  it('asks again for passwords sealed with the old app key', () => {
    const { profileId, passwordRef } = seedOldInstall();
    expect(run().status).toBe('migrated');

    // macOS and Linux: safeStorage's key is the new app's own Keychain or secret service entry.
    const store = newStore(0x33, { failsToOpen: true });
    try {
      const profile = store.profiles.get(profileId)!;
      const resolved = store.secrets.resolve(profile);
      expect(resolved.missing.map((ref) => ref.id)).toEqual([passwordRef]);
      expect(resolved.unreadable.map((ref) => ref.id)).toEqual([passwordRef]);
      expect(() => resolveProfile(store, profile, {}, { requireAll: true })).toThrow(
        QuerybaraError,
      );
      // Typed when asked, it is used for the connection.
      expect(
        resolveProfile(store, profile, { [passwordRef]: 'hunter2' }, { requireAll: true }).secrets[
          passwordRef
        ],
      ).toBe('hunter2');
    } finally {
      store.close();
    }
  });

  it('translates stored values that carried the old name', async () => {
    const store = oldStore();
    const keyPath = join(oldDir, SSH_KEYS_DIR, 'work-0123456789ab.pem');
    let profileId: string;
    let custom: string;
    try {
      const profile = store.profiles.save(
        profileInput({
          options: { applicationName: PREVIOUS_DIR_NAME },
          ssh: {
            hops: [{ host: 'bastion', user: 'ops', auth: { method: 'privateKey', keyPath } }],
          },
        }),
      );
      profileId = profile.id;
      custom = store.profiles.save(
        profileInput({ name: 'Custom', options: { applicationName: 'reports' } }),
      ).id;
      const base = shop();
      store.erModelDrafts.put({
        profileId,
        database: 'shop',
        schema: 'public',
        changes: 1,
        document: {
          format: `${OLD_ID}.er-model`,
          version: 1,
          engine: 'postgres',
          database: 'shop',
          schema: 'public',
          savedAt: '2026-09-30T10:00:00.000Z',
          model: {
            schemas: base.schemas.filter((s) => s.name === 'public'),
            tableOrigins: {},
            columnOrigins: {},
          },
          base,
          layout: {
            positions: [],
            hidden: [],
            display: { columns: 'all', types: true },
            includeViews: false,
          },
        } as never,
      });
      store.schedules.create({
        name: 'Nightly',
        kind: 'backup',
        profileId,
        task: {
          kind: 'backup',
          job: { kind: 'backup', profileId, database: 'shop', method: OLD_ID, format: 'jbak' },
          encrypted: false,
          output: { folder: join(root, 'backups'), fileName: '{name}-{date}.jbak', keep: 7 },
        },
        rule: { kind: 'interval', every: 1, unit: 'hours' },
      });
    } finally {
      store.close();
    }

    expect(run().status).toBe('migrated');

    const migrated = newStore();
    try {
      const profile = connectionProfileSchema.parse(migrated.profiles.get(profileId)!);
      expect(profile.options.applicationName).toBe('Querybara');
      expect(profile.ssh?.hops[0]?.auth).toEqual({
        method: 'privateKey',
        keyPath: join(userData, SSH_KEYS_DIR, 'work-0123456789ab.pem'),
      });
      expect(migrated.profiles.get(custom)!.options.applicationName).toBe('reports');

      const draft = await erModelHandlers(migrated).getDraft(
        { profileId, database: 'shop', schema: 'public' },
        {} as never,
      );
      expect(draft?.document.format).toBe(ER_MODEL_FORMAT);
      expect(erModelDocumentSchema.safeParse(draft?.document).success).toBe(true);

      const [schedule] = migrated.schedules.list();
      const task = scheduleTaskSchema.parse(schedule!.task);
      expect(task).toMatchObject({
        kind: 'backup',
        job: { format: 'qbak', method: 'querybara' },
        output: { fileName: '{name}-{date}.qbak' },
      });
    } finally {
      migrated.close();
    }
  });
});
