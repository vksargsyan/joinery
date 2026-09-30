import { describe, expect, it } from 'vitest';

import { fakeClock, memoryStore, postgresProfile, thrown } from './helpers';

describe('folders', () => {
  it('creates nested folders and lists them by sort order then name', () => {
    const clock = fakeClock();
    const store = memoryStore({ clock });
    const root = store.folders.create({ name: 'Clients' });
    const b = store.folders.create({ name: 'beta', parentId: root.id, sortOrder: 1 });
    const a = store.folders.create({ name: 'Acme', parentId: root.id, sortOrder: 1 });
    const first = store.folders.create({ name: 'Zed', parentId: root.id, sortOrder: 0 });
    expect(root).toEqual({
      id: root.id,
      parentId: null,
      name: 'Clients',
      sortOrder: 0,
      version: 1,
      createdAt: clock.iso(),
      updatedAt: clock.iso(),
    });
    expect(store.folders.list({ parentId: root.id }).map((folder) => folder.id)).toEqual([
      first.id,
      a.id,
      b.id,
    ]);
    expect(store.folders.list({ parentId: null })).toEqual([root]);
    expect(store.folders.list()).toHaveLength(4);
  });

  it('validates names and parents', () => {
    const store = memoryStore();
    expect(thrown(() => store.folders.create({ name: '  ' }))).toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    expect(thrown(() => store.folders.create({ name: 'x', parentId: 'missing' }))).toMatchObject({
      code: 'NOT_FOUND',
    });
    const folder = store.folders.create({ name: 'x', id: 'fixed' });
    expect(thrown(() => store.folders.create({ name: 'y', id: 'fixed' }))).toMatchObject({
      message: expect.stringContaining('already exists'),
    });
    expect(store.folders.get(folder.id)?.name).toBe('x');
  });

  it('renames, reorders and moves with version bumps', () => {
    const clock = fakeClock();
    const store = memoryStore({ clock });
    const a = store.folders.create({ name: 'A' });
    const b = store.folders.create({ name: 'B' });
    clock.advance();
    const renamed = store.folders.update(a.id, { name: 'A2', sortOrder: 5 });
    expect(renamed).toMatchObject({ name: 'A2', sortOrder: 5, parentId: null, version: 2 });
    expect(renamed.updatedAt).toBe(clock.iso());
    const moved = store.folders.update(a.id, { parentId: b.id }, { expectedVersion: 2 });
    expect(moved).toMatchObject({ name: 'A2', parentId: b.id, version: 3 });
    expect(
      thrown(() => store.folders.update(a.id, { name: 'x' }, { expectedVersion: 2 })),
    ).toMatchObject({ message: expect.stringContaining('changed elsewhere') });
    expect(store.folders.update(a.id, { parentId: null }).parentId).toBeNull();
    expect(thrown(() => store.folders.update('missing', { name: 'x' }))).toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('refuses to move a folder into itself or its subtree', () => {
    const store = memoryStore();
    const top = store.folders.create({ name: 'top' });
    const mid = store.folders.create({ name: 'mid', parentId: top.id });
    const leaf = store.folders.create({ name: 'leaf', parentId: mid.id });
    for (const target of [top.id, mid.id, leaf.id]) {
      expect(thrown(() => store.folders.update(top.id, { parentId: target }))).toMatchObject({
        code: 'VALIDATION_FAILED',
      });
    }
    expect(store.folders.update(leaf.id, { parentId: top.id }).parentId).toBe(top.id);
  });

  it('deleting a folder moves its subfolders and profiles to its parent', () => {
    const store = memoryStore();
    const parent = store.folders.create({ name: 'parent' });
    const doomed = store.folders.create({ name: 'doomed', parentId: parent.id });
    const child = store.folders.create({ name: 'child', parentId: doomed.id });
    const profile = store.profiles.save(postgresProfile({ presentation: { folderId: doomed.id } }));

    expect(store.folders.delete(doomed.id)).toBe(true);
    expect(store.folders.get(doomed.id)).toBeUndefined();
    expect(store.folders.get(child.id)).toMatchObject({ parentId: parent.id, version: 2 });
    expect(store.profiles.get(profile.id)).toMatchObject({
      presentation: { folderId: parent.id },
      version: 2,
    });
    expect(store.folders.delete(doomed.id)).toBe(false);
  });

  it('deleting a top-level folder moves its contents to the root', () => {
    const store = memoryStore();
    const folder = store.folders.create({ name: 'top' });
    const profile = store.profiles.save(postgresProfile({ presentation: { folderId: folder.id } }));
    store.folders.delete(folder.id);
    expect(store.profiles.get(profile.id)?.presentation.folderId).toBeNull();
    expect(store.profiles.list({ folderId: null })).toHaveLength(1);
  });
});
