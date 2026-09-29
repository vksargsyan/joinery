import { inspect } from 'node:util';

import { newId, type ConnectionProfile } from '@joinery/core';
import { describe, expect, it } from 'vitest';

import { REDACTED, exportProfiles, importProfiles } from '../src';
import { PassphraseKeys, encryptEnvelope } from '../src/secrets/envelope';
import { TEST_COST, memoryStore, postgresProfile, thrown } from './helpers';

const PASSPHRASE = 'export passphrase ✓';

function fixture() {
  const store = memoryStore();
  const folder = store.folders.create({ name: 'Production' });
  const password = { id: newId(), policy: 'save' as const };
  const sshPassphrase = { id: newId(), policy: 'session' as const };
  const pg = store.profiles.save(
    postgresProfile({
      auth: { method: 'password', user: 'app', password },
      ssh: {
        hops: [
          {
            host: 'bastion',
            user: 'ops',
            auth: { method: 'privateKey', keyPath: '/k', passphrase: sshPassphrase },
          },
        ],
      },
      presentation: { folderId: folder.id, environment: 'production', tags: ['core'] },
    }),
  );
  const redis = store.profiles.save({
    name: 'Cache',
    engine: 'redis',
    endpoint: { kind: 'host', host: 'cache', port: 6379 },
  });
  const secrets = {
    [password.id]: 'db-password-123',
    [sshPassphrase.id]: 'ssh-passphrase-456',
    unrelated: 'must-not-be-exported',
  };
  return { store, folder, pg, redis, secrets, password, sshPassphrase };
}

describe('profile export', () => {
  it('round-trips profiles, folders and referenced secrets', () => {
    const { folder, pg, redis, secrets, password, sshPassphrase } = fixture();
    const bytes = exportProfiles([pg, redis], {
      passphrase: PASSPHRASE,
      secrets,
      folders: [folder],
      cost: TEST_COST,
      now: () => new Date('2026-09-29T12:00:00.000Z'),
    });
    const imported = importProfiles(bytes, PASSPHRASE);
    const strip = ({ version: _version, ...profile }: ConnectionProfile & { version: number }) =>
      profile;
    expect(imported.profiles).toEqual([strip(pg), strip(redis)]);
    expect(imported.folders).toEqual([
      { id: folder.id, parentId: null, name: 'Production', sortOrder: 0 },
    ]);
    expect(imported.exportedAt).toBe('2026-09-29T12:00:00.000Z');
    expect({ ...imported.secrets }).toEqual({
      [password.id]: 'db-password-123',
      [sshPassphrase.id]: 'ssh-passphrase-456',
    });
    expect(JSON.stringify(imported)).not.toContain('db-password-123');
    expect(inspect(imported, { depth: 10 })).not.toContain('db-password-123');
    expect(JSON.parse(JSON.stringify(imported.secrets))).toEqual({
      [password.id]: REDACTED,
      [sshPassphrase.id]: REDACTED,
    });
  });

  it('writes no secrets unless asked, and never plaintext', () => {
    const { pg, secrets } = fixture();
    const withoutSecrets = exportProfiles([pg], { passphrase: PASSPHRASE, cost: TEST_COST });
    expect({ ...importProfiles(withoutSecrets, PASSPHRASE).secrets }).toEqual({});
    const withSecrets = exportProfiles([pg], { passphrase: PASSPHRASE, secrets, cost: TEST_COST });
    const raw = Buffer.from(withSecrets);
    for (const needle of ['db-password-123', 'Local Postgres', 'localhost', 'joinery.profiles']) {
      expect(raw.includes(Buffer.from(needle))).toBe(false);
    }
  });

  it('imports into a fresh store', () => {
    const { pg, folder, secrets, password } = fixture();
    const bytes = exportProfiles([pg], {
      passphrase: PASSPHRASE,
      secrets,
      folders: [folder],
      cost: TEST_COST,
    });
    const imported = importProfiles(bytes, PASSPHRASE);
    const target = memoryStore();
    for (const exported of imported.folders) target.folders.create(exported);
    for (const profile of imported.profiles) target.profiles.save(profile);
    target.secrets.set(password, imported.secrets[password.id] ?? '');
    const [restored] = target.profiles.list();
    expect(restored?.createdAt).toBe(pg.createdAt);
    expect(restored && target.secrets.resolve(restored).secrets[password.id]).toBe(
      'db-password-123',
    );
  });

  it('orders folders parents first and roots anything pointing outside the export', () => {
    const { store, pg } = fixture();
    const child = { id: 'child', parentId: 'parent', name: 'Child', sortOrder: 0 };
    const parent = { id: 'parent', parentId: 'grandparent', name: 'Parent', sortOrder: 0 };
    const loopA = { id: 'loop-a', parentId: 'loop-b', name: 'A', sortOrder: 0 };
    const loopB = { id: 'loop-b', parentId: 'loop-a', name: 'B', sortOrder: 0 };
    const bytes = exportProfiles([pg], {
      passphrase: PASSPHRASE,
      folders: [child, loopA, parent, loopB],
      cost: TEST_COST,
    });
    const imported = importProfiles(bytes, PASSPHRASE);
    expect(imported.folders).toEqual([
      { ...parent, parentId: null },
      child,
      { ...loopB, parentId: null },
      loopA,
    ]);
    // pg's folder was not exported, so it comes back at the root.
    expect(imported.profiles[0]?.presentation.folderId).toBeNull();
    const target = memoryStore();
    for (const folder of imported.folders) target.folders.create(folder);
    for (const profile of imported.profiles) target.profiles.save(profile);
    expect(target.folders.list()).toHaveLength(4);
    expect(store.profiles.get(pg.id)?.presentation.folderId).not.toBeNull();
  });

  it('fails clearly on a wrong passphrase', () => {
    const { pg } = fixture();
    const bytes = exportProfiles([pg], { passphrase: PASSPHRASE, cost: TEST_COST });
    const error = thrown(() => importProfiles(bytes, 'wrong'));
    expect(error).toMatchObject({
      code: 'AUTH_FAILED',
      message:
        'Could not decrypt the export file: the passphrase is wrong or the data was modified',
    });
  });

  it('detects tampering and rejects files that are not exports', () => {
    const { pg } = fixture();
    const bytes = exportProfiles([pg], { passphrase: PASSPHRASE, cost: TEST_COST });
    for (const offset of [8, 20, 45, Math.floor(bytes.length / 2), bytes.length - 1]) {
      const copy = Uint8Array.from(bytes);
      copy[offset] = (copy[offset] ?? 0) ^ 0x80;
      expect(
        thrown(() => importProfiles(copy, PASSPHRASE)),
        `offset ${offset}`,
      ).toMatchObject({
        code: expect.stringMatching(/AUTH_FAILED|VALIDATION_FAILED/),
      });
    }
    expect(
      thrown(() => importProfiles(bytes.subarray(0, bytes.length - 1), PASSPHRASE)),
    ).toMatchObject({
      code: 'AUTH_FAILED',
    });
    expect(
      thrown(() => importProfiles(new TextEncoder().encode('{"profiles":[]}'), PASSPHRASE)),
    ).toMatchObject({
      code: 'VALIDATION_FAILED',
      message: 'This is not a Joinery export file',
    });
  });

  it('refuses files written by a newer Joinery', () => {
    const payload = new TextEncoder().encode(
      JSON.stringify({ format: 'joinery.profiles', version: 2, profiles: [] }),
    );
    const bytes = encryptEnvelope('JNRX', payload, new PassphraseKeys(PASSPHRASE), TEST_COST);
    expect(thrown(() => importProfiles(bytes, PASSPHRASE))).toMatchObject({
      code: 'NOT_SUPPORTED',
      hint: 'Update Joinery to import it.',
    });
  });

  it('refuses an empty passphrase and invalid profiles', () => {
    const { pg } = fixture();
    expect(thrown(() => exportProfiles([pg], { passphrase: '', cost: TEST_COST }))).toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    expect(
      thrown(() =>
        exportProfiles([{ ...pg, engine: 'elasticsearch' }], {
          passphrase: PASSPHRASE,
          cost: TEST_COST,
        }),
      ),
    ).toMatchObject({ code: 'VALIDATION_FAILED' });
  });
});
