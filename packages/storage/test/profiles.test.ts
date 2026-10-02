import { newId, type SecretRef } from '@joinery/core';
import { describe, expect, it } from 'vitest';

import { fakeClock, memoryStore, postgresProfile, thrown } from './helpers';

describe('profiles', () => {
  it('saves, reads and lists a profile with defaults applied', () => {
    const clock = fakeClock();
    const store = memoryStore({ clock });
    const saved = store.profiles.save(postgresProfile());
    expect(saved.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(saved.version).toBe(1);
    expect(saved.createdAt).toBe(clock.iso());
    expect(saved.updatedAt).toBe(clock.iso());
    expect(saved.tls.mode).toBe('disable');
    expect(saved.presentation.folderId).toBeNull();
    expect(store.profiles.get(saved.id)).toEqual(saved);
    expect(store.profiles.list()).toEqual([saved]);
    expect(store.profiles.count()).toBe(1);
    expect(store.profiles.get('missing')).toBeUndefined();
  });

  it('bumps version and updatedAt on every save and keeps createdAt', () => {
    const clock = fakeClock();
    const store = memoryStore({ clock });
    const first = store.profiles.save(postgresProfile());
    clock.advance();
    const second = store.profiles.save({ ...first, name: 'Renamed' });
    expect(second).toMatchObject({ id: first.id, name: 'Renamed', version: 2 });
    expect(second.createdAt).toBe(first.createdAt);
    expect(second.updatedAt).toBe(clock.iso());
    expect(second.updatedAt > first.updatedAt).toBe(true);
    clock.advance();
    expect(store.profiles.save(second).version).toBe(3);
  });

  it('keeps an imported createdAt for new rows only', () => {
    const store = memoryStore();
    const saved = store.profiles.save(postgresProfile({ createdAt: '2020-01-01T00:00:00.000Z' }));
    expect(saved.createdAt).toBe('2020-01-01T00:00:00.000Z');
    const again = store.profiles.save({ ...saved, createdAt: '2021-01-01T00:00:00.000Z' });
    expect(again.createdAt).toBe('2020-01-01T00:00:00.000Z');
  });

  it('enforces expectedVersion for optimistic concurrency', () => {
    const store = memoryStore();
    const saved = store.profiles.save(postgresProfile(), { expectedVersion: 0 });
    expect(store.profiles.save(saved, { expectedVersion: 1 }).version).toBe(2);
    expect(thrown(() => store.profiles.save(saved, { expectedVersion: 1 }))).toMatchObject({
      code: 'CONFLICT',
      message: expect.stringContaining('changed elsewhere'),
    });
    expect(() =>
      store.profiles.save(postgresProfile({ id: saved.id }), { expectedVersion: 0 }),
    ).toThrow(/changed elsewhere/);
    expect(store.profiles.get(saved.id)?.version).toBe(2);
  });

  it('rejects invalid profiles with a readable validation error', () => {
    const store = memoryStore();
    const error = thrown(() =>
      store.profiles.save({
        name: 'Bad',
        engine: 'elasticsearch',
        endpoint: { kind: 'host', host: 'x', port: 9200 },
      }),
    );
    expect(error).toMatchObject({
      code: 'VALIDATION_FAILED',
      message: 'Invalid connection profile',
      detail: expect.stringContaining('does not accept a "host" endpoint'),
    });
    expect(store.profiles.count()).toBe(0);
  });

  it('requires the folder to exist', () => {
    const store = memoryStore();
    expect(
      thrown(() => store.profiles.save(postgresProfile({ presentation: { folderId: 'nope' } }))),
    ).toMatchObject({ code: 'NOT_FOUND' });
  });

  it('lists root profiles first, then by folder order, then by name case-insensitively', () => {
    const store = memoryStore();
    const zeta = store.folders.create({ name: 'Zeta', sortOrder: 0 });
    const alpha = store.folders.create({ name: 'alpha', sortOrder: 1 });
    const save = (name: string, folderId: string | null) =>
      store.profiles.save(postgresProfile({ name, presentation: { folderId } }));
    save('b-root', null);
    save('beta', alpha.id);
    save('Alpha', alpha.id);
    save('a-root', null);
    save('zulu', zeta.id);
    save('Apple', zeta.id);
    expect(store.profiles.list().map((profile) => profile.name)).toEqual([
      'a-root',
      'b-root',
      'Apple',
      'zulu',
      'Alpha',
      'beta',
    ]);
  });

  it('filters by folder, engine and environment through the indexed columns', () => {
    const store = memoryStore();
    const folder = store.folders.create({ name: 'Prod' });
    store.profiles.save(
      postgresProfile({
        name: 'pg prod',
        presentation: { folderId: folder.id, environment: 'production' },
      }),
    );
    store.profiles.save(postgresProfile({ name: 'pg dev' }));
    store.profiles.save({
      name: 'cache',
      engine: 'redis',
      endpoint: { kind: 'host', host: 'localhost', port: 6379 },
      presentation: { environment: 'production' },
    });
    const names = (filter: Parameters<typeof store.profiles.list>[0]) =>
      store.profiles.list(filter).map((profile) => profile.name);
    expect(names({ folderId: folder.id })).toEqual(['pg prod']);
    expect(names({ folderId: null })).toEqual(['cache', 'pg dev']);
    expect(names({ engine: 'redis' })).toEqual(['cache']);
    expect(names({ environment: 'production' })).toEqual(['cache', 'pg prod']);
    expect(names({ engine: 'postgres', environment: 'dev' })).toEqual(['pg dev']);
    expect(
      store.db.get('SELECT folder_id, environment, engine FROM profiles WHERE name = ?', [
        'pg prod',
      ]),
    ).toEqual({
      folder_id: folder.id,
      environment: 'production',
      engine: 'postgres',
    });
  });

  it('moves a profile between folders with a version bump', () => {
    const store = memoryStore();
    const folder = store.folders.create({ name: 'Team' });
    const saved = store.profiles.save(postgresProfile());
    const moved = store.profiles.move(saved.id, folder.id);
    expect(moved.presentation.folderId).toBe(folder.id);
    expect(moved.version).toBe(2);
    expect(store.profiles.move(saved.id, null).presentation.folderId).toBeNull();
    expect(thrown(() => store.profiles.move('missing', null))).toMatchObject({ code: 'NOT_FOUND' });
  });

  it('cascades a delete to secrets, history, metadata cache and connection-scoped saved queries', () => {
    const store = memoryStore();
    const profile = store.profiles.save(postgresProfile());
    const other = store.profiles.save(postgresProfile({ name: 'Other' }));
    const ref = passwordRef(profile);
    store.secrets.set(ref, 'hunter2');
    store.history.append({ profileId: profile.id, text: 'SELECT 1', status: 'success' });
    store.history.append({ profileId: other.id, text: 'SELECT 2', status: 'success' });
    store.metadataCache.put(profile.id, {
      engine: 'postgres',
      database: 'app',
      schemas: [],
      capturedAt: '2026-09-29T10:00:00.000Z',
    });
    const scoped = store.savedQueries.create({
      name: 'Mine',
      text: 'SELECT 1',
      profileId: profile.id,
    });
    const inProject = store.savedQueries.create({
      name: 'Shared',
      text: 'SELECT 2',
      profileId: profile.id,
      projectId: 'project-1',
    });

    expect(store.profiles.delete(profile.id)).toBe(true);
    expect(store.profiles.get(profile.id)).toBeUndefined();
    expect(store.secrets.get(ref)).toBeUndefined();
    expect(store.db.get('SELECT count(*) AS n FROM secrets')).toEqual({ n: 0 });
    expect(store.history.count(profile.id)).toBe(0);
    expect(store.history.count(other.id)).toBe(1);
    expect(store.metadataCache.list(profile.id)).toEqual([]);
    expect(store.savedQueries.get(scoped.id)).toBeUndefined();
    expect(store.savedQueries.get(inProject.id)).toMatchObject({ profileId: null, version: 2 });
    expect(store.profiles.delete(profile.id)).toBe(false);
  });

  it('drops session copies of the secrets of a deleted profile', () => {
    const store = memoryStore();
    const profile = store.profiles.save(
      postgresProfile({
        auth: { method: 'password', user: 'app', password: { id: newId(), policy: 'session' } },
      }),
    );
    const ref = passwordRef(profile);
    store.secrets.set(ref, 'in memory');
    expect(store.secrets.get(ref)).toBe('in memory');
    store.profiles.delete(profile.id);
    expect(store.secrets.get(ref)).toBeUndefined();
  });

  it('deletes a secret the profile stops referencing, unless another profile still uses it', () => {
    const store = memoryStore();
    const shared: SecretRef = { id: newId(), policy: 'save' };
    const a = store.profiles.save(
      postgresProfile({ auth: { method: 'password', user: 'a', password: shared } }),
    );
    store.profiles.save(
      postgresProfile({ name: 'b', auth: { method: 'password', user: 'b', password: shared } }),
    );
    store.secrets.set(shared, 'shared secret');

    // a switches to no password: b still needs the secret.
    store.profiles.save({ ...a, auth: { method: 'none' } });
    expect(store.secrets.get(shared)).toBe('shared secret');

    // Deleting the last profile that references it removes it.
    const b = store.profiles.list().find((profile) => profile.name === 'b');
    store.profiles.delete(b?.id ?? '');
    expect(store.secrets.get(shared)).toBeUndefined();
  });
});

function passwordRef(profile: { auth: { method: string; password?: SecretRef } }): SecretRef {
  if (!profile.auth.password) throw new Error('profile has no password ref');
  return profile.auth.password;
}
