import { describe, expect, it } from 'vitest';

import type { Store } from '../src';
import { fakeClock, memoryStore, postgresProfile, thrown } from './helpers';

function seeded(store: Store, texts: readonly string[], profileId?: string): string {
  const id = profileId ?? store.profiles.save(postgresProfile()).id;
  for (const text of texts) store.history.append({ profileId: id, text, status: 'success' });
  return id;
}

const QUERIES = [
  'SELECT * FROM users WHERE id = 1',
  'select count(*) from orders',
  'UPDATE users SET name = $1 WHERE id = $2',
  "SELECT * FROM products WHERE sku LIKE 'AB_%'",
  'DELETE FROM sessions WHERE expires_at < now()',
  'SELECT "Größe" FROM maße',
  'db.users.find({ "email": "a@b.c" })',
] as const;

describe('query history', () => {
  it('appends entries with defaults and reads them back', () => {
    const clock = fakeClock();
    const store = memoryStore({ clock });
    const profile = store.profiles.save(postgresProfile());
    const entry = store.history.append({
      profileId: profile.id,
      database: 'app',
      text: 'SELECT 1',
      status: 'error',
      error: 'permission denied',
      durationMs: 12.5,
      rowCount: 0,
    });
    expect(entry).toEqual({
      id: expect.any(String),
      profileId: profile.id,
      database: 'app',
      text: 'SELECT 1',
      status: 'error',
      error: 'permission denied',
      durationMs: 12.5,
      rowCount: 0,
      executedAt: clock.iso(),
    });
    expect(store.history.get(entry.id)).toEqual(entry);
    const minimal = store.history.append({
      profileId: profile.id,
      text: 'SELECT 2',
      status: 'success',
    });
    expect(minimal).toMatchObject({
      database: null,
      error: null,
      durationMs: null,
      rowCount: null,
    });
  });

  it('rejects entries for unknown profiles and invalid input', () => {
    const store = memoryStore();
    expect(
      thrown(() => store.history.append({ profileId: 'nope', text: 'x', status: 'success' })),
    ).toMatchObject({ code: 'NOT_FOUND' });
    const id = seeded(store, []);
    expect(
      thrown(() =>
        store.history.append({ profileId: id, text: 'x', status: 'success', rowCount: -1 }),
      ),
    ).toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('pages newest first with a stable keyset cursor', () => {
    const store = memoryStore();
    const texts = Array.from({ length: 7 }, (_, index) => `SELECT ${index}`);
    const id = seeded(store, texts);
    const first = store.history.list({ profileId: id, limit: 3 });
    expect(first.entries.map((entry) => entry.text)).toEqual(['SELECT 6', 'SELECT 5', 'SELECT 4']);
    // A run arriving between pages must not shift the next page.
    store.history.append({ profileId: id, text: 'SELECT new', status: 'success' });
    const second = store.history.list({ profileId: id, limit: 3, cursor: first.nextCursor ?? '' });
    expect(second.entries.map((entry) => entry.text)).toEqual(['SELECT 3', 'SELECT 2', 'SELECT 1']);
    const third = store.history.list({ profileId: id, limit: 3, cursor: second.nextCursor ?? '' });
    expect(third.entries.map((entry) => entry.text)).toEqual(['SELECT 0']);
    expect(third.nextCursor).toBeNull();
    expect(() => store.history.list({ cursor: 'abc' })).toThrow(/cursor/);
    expect(() => store.history.list({ limit: 0 })).toThrow(RangeError);
  });

  it('lists across profiles or per profile', () => {
    const store = memoryStore();
    const a = seeded(store, ['SELECT a']);
    const b = seeded(store, ['SELECT b']);
    expect(store.history.list().entries.map((entry) => entry.text)).toEqual([
      'SELECT b',
      'SELECT a',
    ]);
    expect(store.history.list({ profileId: a }).entries).toHaveLength(1);
    expect(store.history.count()).toBe(2);
    expect(store.history.count(b)).toBe(1);
  });

  it('uses the FTS5 trigram index when available', () => {
    expect(memoryStore().history.fullTextSearch).toBe(true);
  });

  for (const mode of ['fts', 'like'] as const) {
    describe(`search (${mode})`, () => {
      function searchStore(): { store: Store; profileId: string } {
        const store = memoryStore();
        if (mode === 'like') {
          store.db.exec(`
            DROP TRIGGER query_history_fts_insert;
            DROP TRIGGER query_history_fts_delete;
            DROP TRIGGER query_history_fts_update;
            DROP TABLE query_history_fts;
          `);
        }
        const profileId = seeded(store, QUERIES);
        expect(store.history.fullTextSearch).toBe(mode === 'fts');
        return { store, profileId };
      }

      const cases: [string, string[]][] = [
        ['users', [QUERIES[6], QUERIES[2], QUERIES[0]]],
        ['USERS where', [QUERIES[2], QUERIES[0]]],
        ['from users id', [QUERIES[0]]],
        ['count(*)', [QUERIES[1]]],
        ["'AB_%'", [QUERIES[3]]],
        ['_%', [QUERIES[3]]],
        ['$1', [QUERIES[2]]],
        ['"email"', [QUERIES[6]]],
        ['Größe', [QUERIES[5]]],
        ['ord', [QUERIES[1]]],
        ['no such text', []],
      ];
      for (const [query, expected] of cases) {
        it(`finds ${JSON.stringify(query)}`, () => {
          const { store } = searchStore();
          expect(store.history.search(query).entries.map((entry) => entry.text)).toEqual(expected);
        });
      }

      it('scopes and pages search results', () => {
        const { store, profileId } = searchStore();
        const other = seeded(store, ['SELECT * FROM users']);
        expect(store.history.search('users', { profileId: other }).entries).toHaveLength(1);
        expect(store.history.search('users', { profileId }).entries).toHaveLength(3);
        const page = store.history.search('users', { limit: 2 });
        expect(page.entries).toHaveLength(2);
        const rest = store.history.search('users', { limit: 2, cursor: page.nextCursor ?? '' });
        expect(rest.entries.map((entry) => entry.text)).toEqual([QUERIES[2], QUERIES[0]]);
      });

      it('treats an empty query as a plain listing', () => {
        const { store } = searchStore();
        expect(store.history.search('   ').entries).toHaveLength(QUERIES.length);
      });
    });
  }

  it('keeps the index in sync with deletes, prunes and cascades', () => {
    const store = memoryStore();
    const id = seeded(store, ['SELECT alpha', 'SELECT beta', 'SELECT alphabet']);
    const [newest] = store.history.list().entries;
    expect(store.history.delete(newest?.id ?? '')).toBe(true);
    expect(store.history.search('alpha').entries.map((entry) => entry.text)).toEqual([
      'SELECT alpha',
    ]);
    store.profiles.delete(id);
    expect(store.history.search('select').entries).toEqual([]);
    store.db.exec("INSERT INTO query_history_fts (query_history_fts) VALUES ('integrity-check')");
  });

  it('prunes to the newest N entries per profile', () => {
    const store = memoryStore();
    const a = seeded(store, ['a1', 'a2', 'a3', 'a4']);
    const b = seeded(store, ['b1', 'b2']);
    expect(store.history.prune(2)).toBe(2);
    expect(store.history.list({ profileId: a }).entries.map((entry) => entry.text)).toEqual([
      'a4',
      'a3',
    ]);
    expect(store.history.count(b)).toBe(2);
    expect(store.history.prune(1, { profileId: b })).toBe(1);
    expect(store.history.list({ profileId: b }).entries.map((entry) => entry.text)).toEqual(['b2']);
    expect(store.history.count(a)).toBe(2);
    expect(store.history.search('a1').entries).toEqual([]);
    expect(store.history.prune(0)).toBe(3);
    expect(() => store.history.prune(-1)).toThrow(RangeError);
  });

  it('clears all history or one profile', () => {
    const store = memoryStore();
    const a = seeded(store, ['a1', 'a2']);
    seeded(store, ['b1']);
    expect(store.history.clear(a)).toBe(2);
    expect(store.history.count()).toBe(1);
    expect(store.history.clear()).toBe(1);
    expect(store.history.count()).toBe(0);
  });
});
