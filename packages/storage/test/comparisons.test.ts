import { describe, expect, it } from 'vitest';

import { MIGRATIONS } from '../src';
import { fakeClock, memoryStore, postgresProfile, thrown } from './helpers';

/**
 * Saved structure and data comparisons (spec §13): the two connections are references that a
 * deleted connection clears, the rest is a JSON definition, and writes are versioned like the
 * other syncable rows.
 */

describe('saved comparisons', () => {
  it('is a migration of its own', () => {
    expect(MIGRATIONS.at(-1)?.name).toBe('saved comparisons');
  });

  it('creates, reads, updates with version bumps and deletes', () => {
    const clock = fakeClock();
    const store = memoryStore({ clock });
    const dev = store.profiles.save(postgresProfile({ name: 'Dev' }));
    const prod = store.profiles.save(postgresProfile({ name: 'Prod' }));
    const definition = {
      source: { database: 'shop_dev', schemas: ['public'] },
      target: { database: 'shop' },
      structure: {
        ignoreComments: true,
        renames: [{ objectKind: 'table', from: 'clients', to: 'customers' }],
      },
    };
    const saved = store.comparisons.create({
      name: '  Dev to prod  ',
      kind: 'structure',
      sourceProfileId: dev.id,
      targetProfileId: prod.id,
      definition,
    });
    expect(saved).toEqual({
      id: expect.any(String),
      name: 'Dev to prod',
      kind: 'structure',
      sourceProfileId: dev.id,
      targetProfileId: prod.id,
      definition,
      version: 1,
      createdAt: clock.iso(),
      updatedAt: clock.iso(),
    });
    expect(store.comparisons.get(saved.id)).toEqual(saved);

    clock.advance();
    const updated = store.comparisons.update(saved.id, {
      name: 'Dev → prod',
      definition: { ...definition, target: { database: 'shop_v2' } },
    });
    expect(updated).toMatchObject({
      name: 'Dev → prod',
      kind: 'structure',
      sourceProfileId: dev.id,
      definition: { target: { database: 'shop_v2' } },
      version: 2,
      createdAt: saved.createdAt,
      updatedAt: clock.iso(),
    });
    expect(
      thrown(() => store.comparisons.update(saved.id, { name: 'x' }, { expectedVersion: 1 })),
    ).toMatchObject({ code: 'CONFLICT' });
    expect(store.comparisons.delete(saved.id)).toBe(true);
    expect(store.comparisons.get(saved.id)).toBeUndefined();
    expect(store.comparisons.delete(saved.id)).toBe(false);
  });

  it('lists by name, filters by kind and connection, and survives a deleted connection', () => {
    const store = memoryStore();
    const dev = store.profiles.save(postgresProfile({ name: 'Dev' }));
    const prod = store.profiles.save(postgresProfile({ name: 'Prod' }));
    const other = store.profiles.save(postgresProfile({ name: 'Other' }));
    store.comparisons.create({
      name: 'b data',
      kind: 'data',
      sourceProfileId: dev.id,
      targetProfileId: prod.id,
    });
    const structure = store.comparisons.create({
      name: 'A structure',
      kind: 'structure',
      sourceProfileId: prod.id,
      targetProfileId: dev.id,
    });
    store.comparisons.create({ name: 'c other', kind: 'structure', sourceProfileId: other.id });
    expect(store.comparisons.list().map((c) => c.name)).toEqual([
      'A structure',
      'b data',
      'c other',
    ]);
    expect(store.comparisons.list({ kind: 'data' }).map((c) => c.name)).toEqual(['b data']);
    expect(store.comparisons.list({ profileId: dev.id }).map((c) => c.name)).toEqual([
      'A structure',
      'b data',
    ]);

    store.profiles.delete(dev.id);
    expect(store.comparisons.get(structure.id)).toMatchObject({
      sourceProfileId: prod.id,
      targetProfileId: null,
      version: 1,
    });
  });

  it('refuses unknown connections, a bad kind and a blank name', () => {
    const store = memoryStore();
    expect(
      thrown(() =>
        store.comparisons.create({ name: 'x', kind: 'structure', sourceProfileId: 'missing' }),
      ),
    ).toMatchObject({ code: 'NOT_FOUND' });
    expect(
      thrown(() =>
        store.comparisons.create({ name: 'x', kind: 'schema' as unknown as 'structure' }),
      ),
    ).toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(thrown(() => store.comparisons.create({ name: '  ', kind: 'data' }))).toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    const saved = store.comparisons.create({ name: 'x', kind: 'data' });
    expect(
      thrown(() => store.comparisons.update(saved.id, { targetProfileId: 'missing' })),
    ).toMatchObject({ code: 'NOT_FOUND' });
    expect(thrown(() => store.comparisons.update('nope', { name: 'y' }))).toMatchObject({
      code: 'NOT_FOUND',
    });
  });
});
