import type { HandlersOf, mainContract } from '@joinery/ipc';
import type { Store } from '@joinery/storage';

/**
 * The main contract's metadata cache and snippet handlers (spec §5, §6). Main only stores and
 * reads: the renderer introspects through its connection hosts and hands snapshots here, so the
 * local store never needs a database connection of its own.
 */

type MainHandlers = HandlersOf<typeof mainContract>;

export function metadataHandlers(store: Store): MainHandlers['metadata'] {
  const cache = store.metadataCache;
  return {
    get: ({ profileId, databases }) => {
      const names = databases ?? cache.list(profileId).map((info) => info.database);
      return [...new Set(names)].sort().flatMap((database) => {
        const cached = cache.get(profileId, database);
        return cached ? [cached] : [];
      });
    },
    put: ({ profileId, snapshot }) => cache.put(profileId, snapshot),
    invalidate: ({ profileId, database }) => ({ dropped: cache.invalidate(profileId, database) }),
  };
}

export function snippetHandlers(store: Store): MainHandlers['snippets'] {
  return {
    list: ({ engine }) => store.snippets.list(engine === undefined ? {} : { engine }),
  };
}
