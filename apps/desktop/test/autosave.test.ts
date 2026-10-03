import type { AutosaveEntry, AutosaveSaveInput, StoredProfile } from '@querybara/ipc';
import { describe, expect, it } from 'vitest';

import {
  AUTOSAVE_DELAY_MS,
  AutosaveQueue,
  planRestore,
  type AutosaveSnapshot,
  type AutosaveTimers,
} from '../src/renderer/src/state/autosave';

/**
 * Editor autosave (spec §18): the queue's batching (a write a couple of seconds after the first
 * change, with later edits riding along), discard on close, taking over restored buffers,
 * retries after a failed write, and which saved buffers reopen at start.
 */

/** Timers the test advances by hand. */
function manualTimers() {
  let now = 0;
  const pending: { at: number; run: () => void; id: number }[] = [];
  let next = 1;
  const timers: AutosaveTimers = {
    set: (run, ms) => {
      const id = next++;
      pending.push({ at: now + ms, run, id });
      return id;
    },
    clear: (handle) => {
      const at = pending.findIndex((t) => t.id === handle);
      if (at >= 0) pending.splice(at, 1);
    },
  };
  return {
    timers,
    advance(ms: number) {
      now += ms;
      for (const timer of pending.filter((t) => t.at <= now)) {
        pending.splice(pending.indexOf(timer), 1);
        timer.run();
      }
    },
    get scheduled() {
      return pending.length;
    },
  };
}

function setup(fail = false) {
  const clock = manualTimers();
  const writes: AutosaveSaveInput[] = [];
  let failing = fail;
  const queue = new AutosaveQueue({
    sink: async (changes) => {
      if (failing) throw new Error('main is gone');
      writes.push(changes);
    },
    timers: clock.timers,
  });
  return {
    queue,
    clock,
    writes,
    recover() {
      failing = false;
    },
  };
}

function sql(text: string, overrides: Partial<AutosaveSnapshot> = {}): () => AutosaveSnapshot {
  return () => ({
    kind: 'sql',
    profileId: 'p1',
    database: null,
    title: 'Query',
    text,
    cursor: text.length,
    ...overrides,
  });
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('autosave queue', () => {
  it('writes a few seconds after the first change, with the latest text of each editor', async () => {
    const { queue, clock, writes } = setup();
    let text = 'SELECT';
    queue.note('a', () => sql(text)());
    clock.advance(AUTOSAVE_DELAY_MS / 2);
    text = 'SELECT 1';
    queue.note('a', () => sql(text)());
    queue.note('b', sql('db.orders.find()', { kind: 'mongo-console', database: 'shop' }));
    expect(writes).toEqual([]);
    clock.advance(AUTOSAVE_DELAY_MS / 2);
    await settle();
    expect(writes).toEqual([
      {
        upsert: [
          { ...sql('SELECT 1')(), id: 'a', position: 0 },
          {
            ...sql('db.orders.find()', { kind: 'mongo-console', database: 'shop' })(),
            id: 'b',
            position: 1,
          },
        ],
        remove: [],
      },
    ]);
    expect(queue.pending).toBe(false);
    // Nothing changed: nothing more is written.
    clock.advance(AUTOSAVE_DELAY_MS * 3);
    await settle();
    expect(writes).toHaveLength(1);
  });

  it('keeps nothing for an empty buffer, and discards a closed tab at once', async () => {
    const { queue, clock, writes } = setup();
    let text = 'SELECT 1';
    queue.note('a', () => sql(text)());
    queue.note('b', sql('   '));
    clock.advance(AUTOSAVE_DELAY_MS);
    await settle();
    expect(writes[0]).toMatchObject({ upsert: [{ id: 'a' }], remove: [] });
    // Emptied after it was written: the saved buffer goes.
    text = '';
    queue.note('a', () => sql(text)());
    clock.advance(AUTOSAVE_DELAY_MS);
    await settle();
    expect(writes[1]).toEqual({ upsert: [], remove: ['a'] });
    queue.note('c', sql('SELECT 3'));
    await queue.flush();
    queue.discard('c');
    await settle();
    expect(writes[3]).toEqual({ upsert: [], remove: ['c'] });
    // A panel that never autosaved costs nothing to close.
    queue.discard('table-view');
    await settle();
    expect(writes).toHaveLength(4);
  });

  it('writes nothing for a tab closed before its first write', async () => {
    const { queue, clock, writes } = setup();
    queue.note('a', sql('SELECT 1'));
    queue.discard('a');
    clock.advance(AUTOSAVE_DELAY_MS);
    await settle();
    expect(writes).toEqual([]);
    expect(queue.pending).toBe(false);
  });

  it('replaces the buffer a restored tab came from with its first write', async () => {
    const { queue, clock, writes } = setup();
    queue.adopt('new', ['old']);
    queue.note('new', sql('SELECT 1'));
    clock.advance(AUTOSAVE_DELAY_MS);
    await settle();
    expect(writes).toEqual([
      { upsert: [{ ...sql('SELECT 1')(), id: 'new', position: 0 }], remove: ['old'] },
    ]);
    // Closing a restored tab before it saved also drops the buffer it came from.
    queue.adopt('again', ['older']);
    queue.discard('again');
    await settle();
    expect(writes[1]).toEqual({ upsert: [], remove: ['older'] });
  });

  it('tries a failed write again after the next delay', async () => {
    const { queue, clock, writes, recover } = setup(true);
    queue.adopt('a', ['old']);
    queue.note('a', sql('SELECT 1'));
    clock.advance(AUTOSAVE_DELAY_MS);
    await settle();
    expect(writes).toEqual([]);
    expect(queue.pending).toBe(true);
    recover();
    clock.advance(AUTOSAVE_DELAY_MS);
    await settle();
    expect(writes).toEqual([
      { upsert: [{ ...sql('SELECT 1')(), id: 'a', position: 0 }], remove: ['old'] },
    ]);
  });
});

describe('restore', () => {
  const entry = (overrides: Partial<AutosaveEntry>): AutosaveEntry => ({
    id: 'e',
    kind: 'sql',
    profileId: 'p1',
    database: null,
    title: 'Query',
    text: 'SELECT 1',
    cursor: null,
    position: 0,
    savedAt: '2026-09-29T10:00:00.000Z',
    ...overrides,
  });
  const profile = (id: string): StoredProfile => ({ id, name: id }) as unknown as StoredProfile;

  it('reopens in tab order the buffers whose connection and editor exist', () => {
    const plan = planRestore(
      [
        entry({ id: 'c', position: 2, kind: 'redis-cli', database: '3' }),
        entry({ id: 'gone', position: 0, profileId: 'deleted' }),
        entry({ id: 'a', position: 1 }),
        entry({ id: 'shell', position: 3, kind: 'mongo-shell' }),
      ],
      [profile('p1')],
      new Set(['sql', 'redis-cli'] as const),
    );
    expect(plan.map(({ entry: e }) => e.id)).toEqual(['a', 'c']);
    expect(plan[0]!.profile.id).toBe('p1');
  });
});
