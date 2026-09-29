import { describe, expect, it } from 'vitest';

import { MIGRATIONS, migrate, openDatabase, type GridViewSaveInput } from '../src';
import { fakeClock, memoryStore, postgresProfile, thrown } from './helpers';

function items(profileId: string, overrides: Partial<GridViewSaveInput> = {}): GridViewSaveInput {
  return {
    profileId,
    database: 'shop',
    schema: 'public',
    table: 'items',
    name: 'Compact',
    layout: {
      columns: [
        { name: 'id', pinned: true, width: 80 },
        { name: 'name', width: 240 },
        { name: 'note', hidden: true },
      ],
    },
    sort: [{ column: 'name', direction: 'desc' }],
    filter: '{"mode":"raw","raw":"qty > 3"}',
    ...overrides,
  };
}

describe('grid views', () => {
  it('creates, lists per table, updates with version bumps and deletes', () => {
    const clock = fakeClock();
    const store = memoryStore({ clock });
    const profile = store.profiles.save(postgresProfile());
    const view = store.gridViews.save(items(profile.id));
    expect(view).toEqual({
      id: expect.any(String),
      profileId: profile.id,
      database: 'shop',
      schema: 'public',
      table: 'items',
      name: 'Compact',
      isDefault: false,
      layout: items(profile.id).layout,
      sort: [{ column: 'name', direction: 'desc' }],
      filter: '{"mode":"raw","raw":"qty > 3"}',
      version: 1,
      createdAt: clock.iso(),
      updatedAt: clock.iso(),
    });
    store.gridViews.save(items(profile.id, { table: 'orders', name: 'Other table' }));
    const table = { profileId: profile.id, database: 'shop', schema: 'public', table: 'items' };
    expect(store.gridViews.list(table).map((v) => v.name)).toEqual(['Compact']);

    clock.advance();
    const updated = store.gridViews.save({ ...items(profile.id), id: view.id, filter: null });
    expect(updated).toMatchObject({ version: 2, filter: null, updatedAt: clock.iso() });
    expect(
      thrown(() =>
        store.gridViews.save({ ...items(profile.id), id: view.id }, { expectedVersion: 1 }),
      ),
    ).toMatchObject({ code: 'CONFLICT' });
    expect(store.gridViews.delete(view.id)).toBe(true);
    expect(store.gridViews.list(table)).toEqual([]);
  });

  it('keeps names unique per table, ignoring case', () => {
    const store = memoryStore();
    const profile = store.profiles.save(postgresProfile());
    store.gridViews.save(items(profile.id));
    expect(
      thrown(() => store.gridViews.save(items(profile.id, { name: 'compact' }))),
    ).toMatchObject({
      code: 'VALIDATION_FAILED',
      message: expect.stringContaining('already exists'),
    });
    // The same name on another table, or in the default database, is fine.
    expect(() => store.gridViews.save(items(profile.id, { table: 'orders' }))).not.toThrow();
    expect(() => store.gridViews.save(items(profile.id, { database: null }))).not.toThrow();
  });

  it('keeps one default per table and lists it first', () => {
    const store = memoryStore();
    const profile = store.profiles.save(postgresProfile());
    const a = store.gridViews.save(items(profile.id, { name: 'A', isDefault: true }));
    const b = store.gridViews.save(items(profile.id, { name: 'B', isDefault: true }));
    const table = { profileId: profile.id, database: 'shop', schema: 'public', table: 'items' };
    expect(store.gridViews.list(table).map((v) => [v.name, v.isDefault])).toEqual([
      ['B', true],
      ['A', false],
    ]);
    store.gridViews.setDefault(table, a.id);
    expect(store.gridViews.defaultFor(table)?.id).toBe(a.id);
    expect(store.gridViews.get(b.id)?.isDefault).toBe(false);
    store.gridViews.setDefault(table, null);
    expect(store.gridViews.defaultFor(table)).toBeUndefined();
    const other = { ...table, table: 'orders' };
    expect(thrown(() => store.gridViews.setDefault(other, a.id))).toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('validates the layout and goes away with the profile', () => {
    const store = memoryStore();
    const profile = store.profiles.save(postgresProfile());
    expect(
      thrown(() =>
        store.gridViews.save(
          items(profile.id, { layout: { columns: [{ name: 'id', width: 1 }] } }),
        ),
      ),
    ).toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(thrown(() => store.gridViews.save(items('nobody')))).toMatchObject({
      code: 'NOT_FOUND',
    });
    store.gridViews.save(items(profile.id));
    store.profiles.delete(profile.id);
    expect(store.db.get('SELECT count(*) AS n FROM grid_views')).toEqual({ n: 0 });
  });

  it('is created by its own migration on a version 3 store', () => {
    const db = openDatabase(':memory:');
    migrate(db, MIGRATIONS.slice(0, 3));
    expect(migrate(db).applied).toEqual([4]);
    const tables = db
      .all("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .map((row) => row['name']);
    expect(tables).toEqual(expect.arrayContaining(['app_runs', 'editor_autosave', 'grid_views']));
    db.close();
  });
});
