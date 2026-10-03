import {
  isSqlEngine,
  type BrowseNode,
  type BrowseNodeKind,
  type SchemaSnapshot,
} from '@querybara/core';
import type { StoredProfile } from '@querybara/ipc';
import { create } from 'zustand';

import { useConnections } from './connections';
import { keys, queryClient } from './data';
import { loadChildren, pathKey, useExplorer, type ChildrenState } from './explorer';
import { loadSnapshot } from './metadata';

/**
 * Go to Object (⌘P): the tables, views and collections of the connected connections, as VS
 * Code's quick open lists files. SQL connections answer from their schema snapshot (the one
 * autocomplete reads: the connection's database), and every connection from what its explorer
 * has loaded; MongoDB's collections load for the first databases when the palette opens. Each
 * entry is an explorer node, so it opens as a click in the tree does.
 */

export interface ObjectEntry {
  /** The connection and the node's path. */
  readonly key: string;
  readonly profile: StoredProfile;
  readonly node: BrowseNode;
  /** Where it lives: "shop · public", "shop". */
  readonly where: string;
}

const OBJECT_KINDS: ReadonlySet<BrowseNodeKind> = new Set([
  'table',
  'view',
  'materialized-view',
  'foreign-table',
  'collection',
  'time-series',
]);

/** MongoDB databases whose collections load when the palette opens, at most. */
const MONGO_DATABASES = 8;
const MONGO_SYSTEM = new Set(['admin', 'config', 'local']);

export function entryKey(profileId: string, path: readonly string[]): string {
  return `${profileId}\u0000${pathKey(path)}`;
}

function whereOf(profile: StoredProfile, path: readonly string[]): string {
  // PostgreSQL: database / schema / folder / object; MySQL, MariaDB, MongoDB: database / folder.
  return profile.engine === 'postgres' ? `${path[0]} · ${path[1]}` : (path[0] ?? '');
}

/** The objects a connection's explorer has loaded. */
export function explorerEntries(
  profile: StoredProfile,
  children: Readonly<Record<string, ChildrenState>> | undefined,
): ObjectEntry[] {
  const out: ObjectEntry[] = [];
  for (const state of Object.values(children ?? {})) {
    for (const node of state.nodes ?? []) {
      if (!OBJECT_KINDS.has(node.kind)) continue;
      out.push({
        key: entryKey(profile.id, node.path),
        profile,
        node,
        where: whereOf(profile, node.path),
      });
    }
  }
  return out;
}

/** The tables and views of a SQL connection's snapshot, as explorer nodes. */
export function snapshotEntries(profile: StoredProfile, snapshot: SchemaSnapshot): ObjectEntry[] {
  const postgres = profile.engine === 'postgres';
  const out: ObjectEntry[] = [];
  for (const schema of snapshot.schemas) {
    const base = postgres ? [snapshot.database, schema.name] : [schema.name];
    const add = (kind: BrowseNodeKind, folder: string, name: string): void => {
      const path = [...base, folder, name];
      out.push({
        key: entryKey(profile.id, path),
        profile,
        node: { kind, name, path, hasChildren: true },
        where: whereOf(profile, path),
      });
    };
    for (const table of schema.tables) add('table', 'tables', table.name);
    for (const view of schema.views) add('view', 'views', view.name);
  }
  return out;
}

interface QuickOpenState {
  /** Snapshot entries, by connection. */
  readonly snapshots: Readonly<Record<string, readonly ObjectEntry[]>>;
  /** Connections still being read. */
  readonly loading: number;
  /** Entries opened from the palette, most recent first. */
  readonly recent: readonly string[];
}

const RECENT_KEY = 'querybara.recentObjects';

function readRecent(): string[] {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]');
    return Array.isArray(stored) ? stored.filter((k): k is string => typeof k === 'string') : [];
  } catch {
    return [];
  }
}

export const useQuickOpen = create<QuickOpenState>()(() => ({
  snapshots: {},
  loading: 0,
  recent: typeof localStorage === 'undefined' ? [] : readRecent(),
}));

/** The connected connections, as profiles. */
export function connectedProfiles(): StoredProfile[] {
  const profiles = queryClient.getQueryData<StoredProfile[]>(keys.profiles) ?? [];
  const byProfile = useConnections.getState().byProfile;
  return profiles.filter((profile) => byProfile[profile.id]?.status === 'ready');
}

/** Reads what the palette searches: snapshots of SQL connections, MongoDB collections. */
export function refreshQuickOpen(): void {
  for (const profile of connectedProfiles()) {
    if (isSqlEngine(profile.engine)) {
      useQuickOpen.setState((s) => ({ loading: s.loading + 1 }));
      void loadSnapshot(profile.id, { dialect: profile.engine })
        .then((snapshot) =>
          useQuickOpen.setState((s) => ({
            snapshots: { ...s.snapshots, [profile.id]: snapshotEntries(profile, snapshot) },
          })),
        )
        .catch(() => undefined)
        .finally(() => useQuickOpen.setState((s) => ({ loading: s.loading - 1 })));
    } else if (profile.engine === 'mongodb') {
      void loadMongo(profile);
    }
  }
}

async function loadMongo(profile: StoredProfile): Promise<void> {
  const children = () => useExplorer.getState().children[profile.id] ?? {};
  if (!children()[pathKey([])]?.nodes) await loadChildren(profile.id, []);
  const databases = (children()[pathKey([])]?.nodes ?? [])
    .filter((node) => node.kind === 'database' && !MONGO_SYSTEM.has(node.name))
    .slice(0, MONGO_DATABASES);
  await Promise.all(
    databases
      .filter((db) => !children()[pathKey([db.name, 'collections'])])
      .map((db) => loadChildren(profile.id, [db.name, 'collections'])),
  );
}

/** Remembers an entry opened from the palette. */
export function rememberEntry(key: string): void {
  const recent = [key, ...useQuickOpen.getState().recent.filter((k) => k !== key)].slice(0, 12);
  useQuickOpen.setState({ recent });
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(recent));
  } catch {
    // Not kept.
  }
}
