import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { openStore, type AutosaveEntryInput } from '../src';
import { fakeClock, memoryStore, postgresProfile, tempDir, testSealer, thrown } from './helpers';

function buffer(
  profileId: string,
  overrides: Partial<AutosaveEntryInput> = {},
): AutosaveEntryInput {
  return {
    id: 'tab-1',
    kind: 'sql',
    profileId,
    title: 'Local query',
    text: 'SELECT * FROM items',
    cursor: 7,
    position: 0,
    ...overrides,
  };
}

describe('editor autosave', () => {
  it('upserts and removes buffers atomically and lists them in tab order', () => {
    const clock = fakeClock();
    const store = memoryStore({ clock });
    const profile = store.profiles.save(postgresProfile());
    expect(
      store.autosave.save({
        upsert: [
          buffer(profile.id, { id: 'b', position: 2 }),
          buffer(profile.id, { id: 'a', position: 1, kind: 'redis-cli', database: '3' }),
        ],
      }),
    ).toEqual(['b', 'a']);
    expect(store.autosave.list().map((e) => [e.id, e.kind, e.database])).toEqual([
      ['a', 'redis-cli', '3'],
      ['b', 'sql', null],
    ]);
    clock.advance();
    store.autosave.save({
      upsert: [buffer(profile.id, { id: 'b', text: 'SELECT 2', position: 2 })],
      remove: ['a'],
    });
    expect(store.autosave.list()).toEqual([
      {
        id: 'b',
        kind: 'sql',
        profileId: profile.id,
        database: null,
        title: 'Local query',
        text: 'SELECT 2',
        cursor: 7,
        position: 2,
        savedAt: clock.iso(),
      },
    ]);
    expect(store.autosave.discard(['b', 'missing'])).toBe(1);
    expect(store.autosave.list()).toEqual([]);
  });

  it('skips buffers of deleted profiles and drops them with their profile', () => {
    const store = memoryStore();
    const profile = store.profiles.save(postgresProfile());
    expect(store.autosave.save({ upsert: [buffer('gone'), buffer(profile.id)] })).toEqual([
      'tab-1',
    ]);
    store.profiles.delete(profile.id);
    expect(store.autosave.list()).toEqual([]);
  });

  it('validates what it stores', () => {
    const store = memoryStore();
    const profile = store.profiles.save(postgresProfile());
    expect(
      thrown(() => store.autosave.save({ upsert: [buffer(profile.id, { position: -1 })] })),
    ).toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('leaves out rows this build cannot read instead of failing the restore', () => {
    const store = memoryStore();
    const profile = store.profiles.save(postgresProfile());
    store.autosave.save({ upsert: [buffer(profile.id)] });
    store.db.run(
      `INSERT INTO editor_autosave (id, kind, profile_id, title, text, position, saved_at)
       VALUES ('future', 'notebook', ?, 't', 'x', 1, '2026-09-29T10:00:00.000Z')`,
      [profile.id],
    );
    expect(store.autosave.list().map((e) => e.id)).toEqual(['tab-1']);
  });

  it('tells a clean exit from a crash across reopening the store', () => {
    const location = join(tempDir(), 'store.db');
    const first = openStore(location, { sealer: testSealer() });
    expect(first.autosave.startRun()).toEqual({ ended: 'none', startedAt: null });
    first.autosave.finishRun();
    first.close();

    const second = openStore(location, { sealer: testSealer() });
    expect(second.autosave.startRun()).toMatchObject({ ended: 'clean' });
    // No finishRun: the app was killed.
    second.close();

    const third = openStore(location, { sealer: testSealer() });
    expect(third.autosave.startRun()).toMatchObject({
      ended: 'unclean',
      startedAt: expect.any(String),
    });
    third.close();
  });
});
