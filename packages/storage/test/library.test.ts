import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { fakeClock, memoryStore, postgresProfile, thrown } from './helpers';

describe('saved queries', () => {
  it('creates, reads, updates with version bumps and deletes', () => {
    const clock = fakeClock();
    const store = memoryStore({ clock });
    const profile = store.profiles.save(postgresProfile());
    const query = store.savedQueries.create({
      name: 'Active users',
      text: 'SELECT * FROM users WHERE active',
      profileId: profile.id,
      database: 'app',
      tags: ['users'],
    });
    expect(query).toEqual({
      id: expect.any(String),
      name: 'Active users',
      text: 'SELECT * FROM users WHERE active',
      description: null,
      profileId: profile.id,
      projectId: null,
      database: 'app',
      tags: ['users'],
      version: 1,
      createdAt: clock.iso(),
      updatedAt: clock.iso(),
    });
    clock.advance();
    const updated = store.savedQueries.update(query.id, { text: 'SELECT 1', description: 'd' });
    expect(updated).toMatchObject({
      name: 'Active users',
      text: 'SELECT 1',
      description: 'd',
      tags: ['users'],
      version: 2,
      createdAt: query.createdAt,
      updatedAt: clock.iso(),
    });
    expect(store.savedQueries.update(query.id, { description: null }).description).toBeNull();
    expect(
      thrown(() => store.savedQueries.update(query.id, { name: 'x' }, { expectedVersion: 1 })),
    ).toMatchObject({ message: expect.stringContaining('changed elsewhere') });
    expect(store.savedQueries.delete(query.id)).toBe(true);
    expect(store.savedQueries.get(query.id)).toBeUndefined();
    expect(store.savedQueries.delete(query.id)).toBe(false);
  });

  it('filters by connection and project and orders by name', () => {
    const store = memoryStore();
    const profile = store.profiles.save(postgresProfile());
    store.savedQueries.create({ name: 'b conn', text: '1', profileId: profile.id });
    store.savedQueries.create({
      name: 'A conn+project',
      text: '2',
      profileId: profile.id,
      projectId: 'p1',
    });
    store.savedQueries.create({ name: 'c project', text: '3', projectId: 'p1' });
    store.savedQueries.create({ name: 'global', text: '4' });
    const names = (filter: Parameters<typeof store.savedQueries.list>[0]) =>
      store.savedQueries.list(filter).map((query) => query.name);
    expect(names({})).toEqual(['A conn+project', 'b conn', 'c project', 'global']);
    expect(names({ profileId: profile.id })).toEqual(['A conn+project', 'b conn']);
    expect(names({ projectId: 'p1' })).toEqual(['A conn+project', 'c project']);
    expect(names({ profileId: null, projectId: null })).toEqual(['global']);
    expect(names({ profileId: profile.id, projectId: null })).toEqual(['b conn']);
  });

  it('requires referenced profiles to exist', () => {
    const store = memoryStore();
    expect(
      thrown(() => store.savedQueries.create({ name: 'x', text: '1', profileId: 'missing' })),
    ).toMatchObject({ code: 'NOT_FOUND' });
    const query = store.savedQueries.create({ name: 'x', text: '1' });
    expect(
      thrown(() => store.savedQueries.update(query.id, { profileId: 'missing' })),
    ).toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(thrown(() => store.savedQueries.create({ name: ' ', text: '1' }))).toMatchObject({
      code: 'VALIDATION_FAILED',
    });
  });
});

describe('snippets', () => {
  it('stores template bodies verbatim and bumps versions on update', () => {
    const store = memoryStore();
    const body = 'SELECT ${1:columns} FROM ${2:table} WHERE ${3:condition};$0';
    const snippet = store.snippets.create({ name: 'Select where', prefix: 'selw', body });
    expect(snippet).toMatchObject({
      body,
      prefix: 'selw',
      engines: [],
      description: null,
      version: 1,
    });
    const updated = store.snippets.update(snippet.id, { engines: ['postgres'], prefix: null });
    expect(updated).toMatchObject({ body, prefix: null, engines: ['postgres'], version: 2 });
    expect(store.snippets.get(snippet.id)).toEqual(updated);
    expect(store.snippets.delete(snippet.id)).toBe(true);
    expect(thrown(() => store.snippets.update(snippet.id, { name: 'x' }))).toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('lists snippets that apply to an engine, including engine-agnostic ones', () => {
    const store = memoryStore();
    store.snippets.create({ name: 'any', body: 'x' });
    store.snippets.create({ name: 'pg', body: 'x', engines: ['postgres'] });
    store.snippets.create({ name: 'mysql family', body: 'x', engines: ['mysql', 'mariadb'] });
    const names = (engine?: 'postgres' | 'mariadb' | 'redis') =>
      store.snippets.list(engine ? { engine } : {}).map((snippet) => snippet.name);
    expect(names()).toEqual(['any', 'mysql family', 'pg']);
    expect(names('postgres')).toEqual(['any', 'pg']);
    expect(names('mariadb')).toEqual(['any', 'mysql family']);
    expect(names('redis')).toEqual(['any']);
    expect(
      thrown(() =>
        store.snippets.create({ name: 'bad', body: 'x', engines: ['oracle' as 'mysql'] }),
      ),
    ).toMatchObject({ code: 'VALIDATION_FAILED' });
  });
});

describe('settings', () => {
  it('stores JSON values with version bumps', () => {
    const clock = fakeClock();
    const store = memoryStore({ clock });
    expect(store.settings.get('editor')).toBeUndefined();
    const first = store.settings.set('editor', { fontSize: 13, vim: false, rulers: [80, 100] });
    expect(first).toEqual({
      key: 'editor',
      value: { fontSize: 13, vim: false, rulers: [80, 100] },
      version: 1,
      updatedAt: clock.iso(),
    });
    clock.advance();
    expect(store.settings.set('editor', { fontSize: 14 })).toMatchObject({
      version: 2,
      updatedAt: clock.iso(),
    });
    store.settings.set('theme', 'dark');
    store.settings.set('telemetry', null);
    expect(store.settings.get('editor')).toEqual({ fontSize: 14 });
    expect(store.settings.get('telemetry')).toBeNull();
    expect(store.settings.list().map((entry) => entry.key)).toEqual([
      'editor',
      'telemetry',
      'theme',
    ]);
    expect(store.settings.delete('theme')).toBe(true);
    expect(store.settings.get('theme')).toBeUndefined();
  });

  it('validates on read with a schema and falls back to undefined on mismatch', () => {
    const store = memoryStore();
    store.settings.set('fontSize', 'large');
    expect(store.settings.get('fontSize', z.number())).toBeUndefined();
    store.settings.set('fontSize', 15);
    const size: number | undefined = store.settings.get('fontSize', z.number());
    expect(size).toBe(15);
  });

  it('rejects values that are not JSON', () => {
    const store = memoryStore();
    expect(thrown(() => store.settings.set('x', Number.NaN))).toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    expect(thrown(() => store.settings.set('', 1))).toMatchObject({ code: 'VALIDATION_FAILED' });
  });
});
