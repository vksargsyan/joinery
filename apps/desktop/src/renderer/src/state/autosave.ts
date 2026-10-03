import type {
  AutosaveEntry,
  AutosaveEntryInput,
  AutosaveKind,
  AutosaveSaveInput,
  StoredProfile,
} from '@querybara/ipc';
import { useEffect, useRef } from 'react';
import { create } from 'zustand';

import { mainApi } from '../lib/main-client';
import { keys, queryClient } from './data';

/**
 * Editor autosave and crash restore (spec §18: unsaved editor tabs autosave every few seconds
 * and come back after a crash). SQL tabs, MongoDB consoles and shells and the Redis CLI report
 * edits here; a queue writes the changed buffers (text, caret, connection and database — never
 * results or secrets) to the local store a couple of seconds after a change, in one transaction.
 * At start, every buffer left in the store reopens as a tab marked "restored", noting whether
 * the last run crashed. Closing a tab on purpose discards its buffer.
 */

/** How long after an edit the buffer is written; edits in between ride along. */
export const AUTOSAVE_DELAY_MS = 2_000;

/** What an editor hands over when the queue writes: its buffer and where it runs. */
export type AutosaveSnapshot = Omit<AutosaveEntryInput, 'id' | 'position'>;

export interface AutosaveTimers {
  set(run: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const WINDOW_TIMERS: AutosaveTimers = {
  set: (run, ms) => setTimeout(run, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * Collects dirty editors and writes them in batches. An editor is read when the batch is
 * written, not on every keystroke, so a large script costs one copy per save. A failed write
 * keeps its buffers dirty and tries again after the next delay.
 */
export class AutosaveQueue {
  readonly #sink: (changes: AutosaveSaveInput) => Promise<void>;
  readonly #delay: number;
  readonly #timers: AutosaveTimers;
  readonly #dirty = new Map<string, () => AutosaveSnapshot | undefined>();
  readonly #removed = new Set<string>();
  /** Buffers a tab takes over (a restored tab has a new id): removed with its first write. */
  readonly #replaces = new Map<string, readonly string[]>();
  readonly #positions = new Map<string, number>();
  /** Tabs whose buffer this queue has written, so only those need removing. */
  readonly #stored = new Set<string>();
  #nextPosition = 0;
  #timer: unknown;
  #chain: Promise<void> = Promise.resolve();

  constructor(options: {
    readonly sink: (changes: AutosaveSaveInput) => Promise<void>;
    readonly delayMs?: number;
    readonly timers?: AutosaveTimers;
  }) {
    this.#sink = options.sink;
    this.#delay = options.delayMs ?? AUTOSAVE_DELAY_MS;
    this.#timers = options.timers ?? WINDOW_TIMERS;
  }

  /** An editor changed: `read` is called when the batch is written (undefined: keep nothing). */
  note(id: string, read: () => AutosaveSnapshot | undefined): void {
    this.#dirty.set(id, read);
    this.#removed.delete(id);
    if (!this.#positions.has(id)) this.#positions.set(id, this.#nextPosition++);
    this.#schedule();
  }

  /** Tab `id` continues the saved buffers `previous` (it was restored from them). */
  adopt(id: string, previous: readonly string[]): void {
    this.#replaces.set(id, [...(this.#replaces.get(id) ?? []), ...previous]);
  }

  /** The tab was closed on purpose: its buffer (and any it took over) goes at once. */
  discard(id: string): void {
    this.#dirty.delete(id);
    this.#positions.delete(id);
    for (const old of this.#replaces.get(id) ?? []) this.#removed.add(old);
    this.#replaces.delete(id);
    if (this.#stored.delete(id)) this.#removed.add(id);
    if (this.#removed.size > 0) void this.flush();
  }

  /** True while changes wait to be written. */
  get pending(): boolean {
    return this.#dirty.size > 0 || this.#removed.size > 0;
  }

  #schedule(): void {
    if (this.#timer !== undefined) return;
    this.#timer = this.#timers.set(() => {
      this.#timer = undefined;
      void this.flush();
    }, this.#delay);
  }

  /** Writes everything dirty now; resolves once the store has it (or the write failed). */
  flush(): Promise<void> {
    if (this.#timer !== undefined) {
      this.#timers.clear(this.#timer);
      this.#timer = undefined;
    }
    const reads = [...this.#dirty];
    const removed = [...this.#removed];
    this.#dirty.clear();
    this.#removed.clear();
    if (reads.length === 0 && removed.length === 0) return this.#chain;
    const upsert: AutosaveEntryInput[] = [];
    const remove = new Set(removed);
    const adopted: [string, readonly string[]][] = [];
    for (const [id, read] of reads) {
      const previous = this.#replaces.get(id);
      if (previous) {
        adopted.push([id, previous]);
        this.#replaces.delete(id);
        for (const old of previous) remove.add(old);
      }
      const snapshot = read();
      if (snapshot === undefined || snapshot.text.trim() === '') {
        // Nothing worth keeping; a buffer written earlier goes.
        if (this.#stored.delete(id)) remove.add(id);
      } else {
        upsert.push({ ...snapshot, id, position: this.#positions.get(id) ?? 0 });
        this.#stored.add(id);
      }
    }
    for (const entry of upsert) remove.delete(entry.id);
    const batch: AutosaveSaveInput = { upsert, remove: [...remove] };
    this.#chain = this.#chain.then(async () => {
      try {
        await this.#sink(batch);
      } catch {
        // Keep what was not written for the next attempt, unless it changed or closed since.
        for (const [id, read] of reads) {
          if (!this.#dirty.has(id) && this.#positions.has(id)) this.#dirty.set(id, read);
        }
        for (const [id, previous] of adopted) {
          if (this.#positions.has(id)) this.adopt(id, previous);
        }
        for (const id of batch.remove) if (!this.#dirty.has(id)) this.#removed.add(id);
        this.#schedule();
      }
    });
    return this.#chain;
  }
}

let queue: AutosaveQueue | undefined;

function sharedQueue(): AutosaveQueue {
  queue ??= new AutosaveQueue({ sink: (changes) => mainApi().autosave.save(changes) });
  return queue;
}

/** An editor's buffer changed; it is written within AUTOSAVE_DELAY_MS. */
export function noteEditor(id: string, read: () => AutosaveSnapshot | undefined): void {
  sharedQueue().note(id, read);
}

/** A tab was closed on purpose: its autosaved buffer is dropped. */
export function discardEditor(id: string): void {
  sharedQueue().discard(id);
  dismissRestored(id);
}

/**
 * Autosaves an editor held in React state (the MongoDB console, the Redis CLI): notes it on
 * mount and whenever its text or context changes.
 */
export function useEditorAutosave(id: string, snapshot: AutosaveSnapshot): void {
  const latest = useRef(snapshot);
  latest.current = snapshot;
  const { kind, profileId, database, title, text } = snapshot;
  useEffect(() => {
    noteEditor(id, () => latest.current);
  }, [id, kind, profileId, database, title, text]);
}

// ---------------------------------------------------------------------------------------------
// Restore

/** How a tab was restored, for its "restored" marker. */
export interface RestoredInfo {
  /** When the buffer was last written. */
  readonly savedAt: string;
  /** The previous run ended without closing cleanly (a crash or a kill). */
  readonly afterCrash: boolean;
}

interface RestoredState {
  readonly tabs: Readonly<Record<string, RestoredInfo>>;
}

/** Tabs reopened from autosave, until the user dismisses the marker or closes the tab. */
export const useRestored = create<RestoredState>()(() => ({ tabs: {} }));

export function dismissRestored(id: string): void {
  useRestored.setState((state) => {
    if (!(id in state.tabs)) return state;
    const { [id]: _gone, ...tabs } = state.tabs;
    return { tabs };
  });
}

/** Reopens a saved buffer as a tab and returns the tab's id (undefined: it could not). */
export type Restorer = (entry: AutosaveEntry, profile: StoredProfile) => string | undefined;

const restorers = new Map<AutosaveKind, Restorer>();

/** Registers how buffers of one kind reopen (the dock registers each editor it hosts). */
export function registerRestorer(kind: AutosaveKind, restorer: Restorer): void {
  restorers.set(kind, restorer);
}

/**
 * The buffers to reopen, in tab order: those whose connection still exists and whose kind this
 * build can open. The others stay in the store (a later build may open them; a deleted
 * profile's go with it).
 */
export function planRestore(
  entries: readonly AutosaveEntry[],
  profiles: readonly StoredProfile[],
  kinds: ReadonlySet<AutosaveKind>,
): { readonly entry: AutosaveEntry; readonly profile: StoredProfile }[] {
  const byId = new Map(profiles.map((profile) => [profile.id, profile]));
  return [...entries]
    .sort((a, b) => a.position - b.position || a.savedAt.localeCompare(b.savedAt))
    .flatMap((entry) => {
      const profile = byId.get(entry.profileId);
      return profile && kinds.has(entry.kind) ? [{ entry, profile }] : [];
    });
}

let restoring: Promise<number> | undefined;

/**
 * Reopens the autosaved buffers of the previous run, once per page load; resolves with how many
 * tabs came back. Each restored tab takes its buffer over (the old row goes with its first save).
 */
export function restoreEditors(): Promise<number> {
  restoring ??= (async () => {
    const { previousRun, entries } = await mainApi().autosave.restore();
    if (entries.length === 0) return 0;
    const profiles = await queryClient.fetchQuery({
      queryKey: keys.profiles,
      queryFn: () => mainApi().profiles.list(),
    });
    let restored = 0;
    for (const { entry, profile } of planRestore(entries, profiles, new Set(restorers.keys()))) {
      let id: string | undefined;
      try {
        id = restorers.get(entry.kind)?.(entry, profile);
      } catch {
        id = undefined;
      }
      if (id === undefined) continue;
      sharedQueue().adopt(id, [entry.id]);
      useRestored.setState((state) => ({
        tabs: {
          ...state.tabs,
          [id]: { savedAt: entry.savedAt, afterCrash: previousRun === 'unclean' },
        },
      }));
      restored++;
    }
    return restored;
  })().catch(() => 0);
  return restoring;
}
