import { describe, expect, it } from 'vitest';

import { MAX_ER_DRAFT_TEXT, MIGRATIONS } from '../src';
import { fakeClock, memoryStore, postgresProfile, thrown } from './helpers';

/**
 * ER model drafts (spec §8): one per connection, database and schema, replaced on each save,
 * listed newest first without their models, and gone with the connection.
 */

const document = {
  format: 'joinery.er-model',
  version: 1,
  model: { schemas: [{ name: 'public', tables: [] }] },
};

describe('ER model drafts', () => {
  it('is a migration of its own', () => {
    expect(MIGRATIONS.find((m) => m.name === 'ER model drafts')?.version).toBe(5);
  });

  it('keeps one draft per place, replacing it on each save', () => {
    const clock = fakeClock();
    const store = memoryStore({ clock });
    const profile = store.profiles.save(postgresProfile({ name: 'Dev' }));
    const key = { profileId: profile.id, database: 'shop', schema: 'public' };
    expect(store.erModelDrafts.get(key)).toBeUndefined();

    const first = store.erModelDrafts.put({ ...key, document, changes: 2 });
    expect(first).toEqual({ ...key, document, changes: 2, savedAt: clock.iso() });

    clock.advance();
    const next = { ...document, model: { schemas: [] } };
    store.erModelDrafts.put({ ...key, document: next, changes: 3 });
    expect(store.erModelDrafts.get(key)).toEqual({
      ...key,
      document: next,
      changes: 3,
      savedAt: clock.iso(),
    });

    clock.advance();
    store.erModelDrafts.put({ ...key, schema: 'sales', document, changes: 1 });
    store.erModelDrafts.put({ ...key, database: 'crm', document, changes: 4 });
    expect(store.erModelDrafts.list({ profileId: profile.id })).toEqual([
      { ...key, database: 'crm', changes: 4, savedAt: clock.iso() },
      { ...key, schema: 'sales', changes: 1, savedAt: clock.iso() },
      { ...key, changes: 3, savedAt: expect.any(String) },
    ]);
    expect(
      store.erModelDrafts.list({ profileId: profile.id, database: 'shop' }).map((d) => d.schema),
    ).toEqual(['sales', 'public']);

    expect(store.erModelDrafts.delete(key)).toBe(true);
    expect(store.erModelDrafts.delete(key)).toBe(false);
    expect(store.erModelDrafts.get(key)).toBeUndefined();
  });

  it('goes with its connection, and refuses one without', () => {
    const store = memoryStore();
    const profile = store.profiles.save(postgresProfile({ name: 'Dev' }));
    const key = { profileId: profile.id, database: 'shop', schema: 'public' };
    store.erModelDrafts.put({ ...key, document, changes: 1 });
    store.profiles.delete(profile.id);
    expect(store.erModelDrafts.list({ profileId: profile.id })).toEqual([]);
    expect(thrown(() => store.erModelDrafts.put({ ...key, document, changes: 1 }))).toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('validates what it keeps', () => {
    const store = memoryStore();
    const profile = store.profiles.save(postgresProfile({ name: 'Dev' }));
    const key = { profileId: profile.id, database: 'shop', schema: 'public' };
    expect(thrown(() => store.erModelDrafts.put({ ...key, document, changes: -1 }))).toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    const huge = { blob: 'x'.repeat(MAX_ER_DRAFT_TEXT) };
    expect(
      thrown(() => store.erModelDrafts.put({ ...key, document: huge, changes: 1 })),
    ).toMatchObject({ code: 'VALIDATION_FAILED', message: expect.stringContaining('too large') });
  });
});
