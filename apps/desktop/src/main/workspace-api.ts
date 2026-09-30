import type { HandlersOf, mainContract } from '@joinery/ipc';
import type { PreviousRun, Store } from '@joinery/storage';

/**
 * The main contract's workspace handlers: saved table views (spec §7) and editor autosave for
 * crash restore (spec §18). Main only stores and reads; the renderer decides what to save.
 */

type MainHandlers = HandlersOf<typeof mainContract>;

export function gridViewHandlers(store: Store): MainHandlers['gridViews'] {
  const views = store.gridViews;
  return {
    list: (table) => views.list(table),
    save: ({ expectedVersion, isDefault, ...view }) =>
      views.save(
        { ...view, ...(isDefault === undefined ? {} : { isDefault }) },
        expectedVersion === undefined ? {} : { expectedVersion },
      ),
    setDefault: ({ table, id }) => views.setDefault(table, id),
    delete: ({ id }) => {
      views.delete(id);
    },
  };
}

/**
 * `previousRun` is how the app's last run ended, read once at start-up (before this run marked
 * itself as running), so every window of this run sees the same answer.
 */
export function autosaveHandlers(
  store: Store,
  previousRun: PreviousRun['ended'],
): MainHandlers['autosave'] {
  return {
    restore: () => ({ previousRun, entries: store.autosave.list() }),
    save: ({ upsert, remove }) => {
      store.autosave.save({ upsert, remove });
    },
  };
}
