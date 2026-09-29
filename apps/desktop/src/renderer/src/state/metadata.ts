import { isSqlEngine, type SchemaSnapshot, type SqlDialect, type TableDef } from '@joinery/core';
import { create } from 'zustand';

import { languageClient } from '../lib/language';
import { mainApi } from '../lib/main-client';
import { useConnections } from './connections';
import { loadChildren, reloadChildren, useExplorer } from './explorer';
import { MetadataCache, type MetadataStatus, type StructureChange } from './metadata-cache';
import { SessionLane, collect } from './session-lane';
import { readConnectionFacts } from './session-facts';

/**
 * The app's one schema metadata source (spec §5: a metadata cache per connection in SQLite feeds
 * autocomplete; §8: the designers share it): a MetadataCache fed by the local store (through
 * main) and each connection's host, serving the table views and the designer (`loadSnapshot`)
 * and publishing to autocomplete's language worker. Introspection and the designer's checks run
 * on one shared metadata session per connection and database.
 *
 * When the structure changes (DDL run from a query tab, a designer save or drop, a Refresh that
 * finds something new), `useMetadata` bumps the connection's version so open views reload their
 * definitions, and the explorer reloads the folders under the databases that changed.
 */

export interface SnapshotScope {
  readonly dialect: SqlDialect;
  /**
   * The database to introspect: PostgreSQL sessions connect to it, MySQL/MariaDB name it in
   * the introspection scope. The connection's default database when left out.
   */
  readonly database?: string;
  /** PostgreSQL schemas; every schema when left out. */
  readonly schemas?: readonly string[];
}

interface MetadataState {
  /** profileId → version, bumped whenever a connection's structure changed. */
  readonly versions: Readonly<Record<string, number>>;
}

export const useMetadata = create<MetadataState>()(() => ({ versions: {} }));

interface StatusState {
  readonly byProfile: Readonly<Record<string, MetadataStatus>>;
}

/** Whether a connection's metadata is loading, for the editor's quiet indicator. */
export const useMetadataStatus = create<StatusState>()(() => ({ byProfile: {} }));

const lanes = new Map<string, SessionLane>();

/**
 * The shared metadata session of a profile and database. PostgreSQL's connected database and
 * no database at all share one session.
 */
export function metadataLane(profileId: string, database?: string): SessionLane {
  const connected = metadataCache.facts(profileId)?.database;
  const key = `${profileId}\u0000${database === connected ? '' : (database ?? '')}`;
  let lane = lanes.get(key);
  if (!lane) {
    lane = new SessionLane(profileId, database);
    lanes.set(key, lane);
  }
  return lane;
}

function bumpVersion(profileId: string): void {
  useMetadata.setState((state) => ({
    versions: { ...state.versions, [profileId]: (state.versions[profileId] ?? 0) + 1 },
  }));
}

function structureChanged(profileId: string, change: StructureChange): void {
  bumpVersion(profileId);
  reloadChildren(profileId, (path) =>
    path.length === 0 ? change.list : change.databases.includes(path[0]!),
  );
}

/** The cache itself, for autocomplete's session tracking. */
export const metadataCache = new MetadataCache(
  {
    loadCached: async (profileId) =>
      (await mainApi().metadata.get({ profileId })).map((entry) => entry.snapshot),
    store: async (profileId, snapshot) => {
      await mainApi().metadata.put({ profileId, snapshot });
    },
    drop: async (profileId, database) => {
      await mainApi().metadata.invalidate({ profileId, database });
    },
    facts: (profileId, dialect) =>
      metadataLane(profileId).run((host, sessionId) =>
        readConnectionFacts(dialect, async (sql) => (await collect(host, sessionId, { sql })).rows),
      ),
    introspect: (profileId, dialect, database, schemas) =>
      dialect === 'postgres'
        ? metadataLane(profileId, database).run((host, sessionId) =>
            host.introspect({ sessionId, scope: schemas ? { schemas: [...schemas] } : {} }),
          )
        : metadataLane(profileId).run((host, sessionId) =>
            host.introspect({ sessionId, scope: { database } }),
          ),
  },
  {
    publish: (profileId, change) => languageClient.setSnapshots(profileId, change),
    forget: (profileId) => languageClient.forget(profileId),
    status: (profileId, status) =>
      useMetadataStatus.setState((state) => ({
        byProfile: { ...state.byProfile, [profileId]: status },
      })),
    changed: structureChanged,
  },
);

/** Starts loading the metadata of a ready SQL connection (idempotent). */
export function openMetadata(profileId: string): void {
  const connection = useConnections.getState().byProfile[profileId];
  const engine = connection?.info?.engine;
  if (connection?.status !== 'ready' || engine === undefined || !isSqlEngine(engine)) return;
  void metadataCache.open(profileId, engine);
}

function closeMetadata(profileId: string): void {
  metadataCache.close(profileId);
  for (const [key, lane] of [...lanes]) {
    if (!key.startsWith(`${profileId}\u0000`)) continue;
    lanes.delete(key);
    void lane.close();
  }
}

/**
 * A snapshot of `scope` read from the server since the last change Joinery knows of, for the
 * table views and the designer.
 */
export function loadSnapshot(profileId: string, scope: SnapshotScope): Promise<SchemaSnapshot> {
  return metadataCache.snapshot(profileId, scope.dialect, {
    ...(scope.database === undefined ? {} : { database: scope.database }),
    ...(scope.schemas === undefined ? {} : { schemas: scope.schemas }),
  });
}

/**
 * The structure changed through Joinery (a designer save or drop): every snapshot of the
 * connection is read again, and open views reload once it has been.
 */
export function invalidateMetadata(profileId: string): void {
  if (!metadataCache.invalidate(profileId)) bumpVersion(profileId);
}

/**
 * The explorer's Refresh (spec §5: children refresh on demand): reloads a tree level and the
 * metadata under it, the whole connection's for the root.
 */
export function refreshObjects(profileId: string, path: readonly string[]): void {
  void loadChildren(profileId, path);
  const database = path[0];
  void metadataCache.refresh(profileId, database === undefined ? undefined : [database]);
}

/**
 * A table in a snapshot: PostgreSQL by schema and name, MySQL/MariaDB by name (their snapshot
 * holds the one database as its only schema).
 */
export function findTable(
  snapshot: SchemaSnapshot,
  schema: string,
  name: string,
): TableDef | undefined {
  const home =
    snapshot.schemas.find((s) => s.name === schema) ??
    (snapshot.engine === 'postgres' ? undefined : snapshot.schemas[0]);
  return home?.tables.find((t) => t.name === name);
}

let watching = false;

/**
 * Follows connections and the explorer for the life of the page: a connection that becomes
 * ready loads its metadata, one that goes away is forgotten, and a MySQL database expanded in
 * the explorer is loaded for autocomplete.
 */
export function watchMetadata(): void {
  if (watching) return;
  watching = true;
  for (const profileId of Object.keys(useConnections.getState().byProfile)) openMetadata(profileId);
  useConnections.subscribe((state, previous) => {
    for (const [profileId, connection] of Object.entries(state.byProfile)) {
      const before = previous.byProfile[profileId];
      if (
        connection.status === 'ready' &&
        (before?.status !== 'ready' || before.generation !== connection.generation)
      ) {
        openMetadata(profileId);
      }
    }
    for (const profileId of Object.keys(previous.byProfile)) {
      if (!(profileId in state.byProfile)) closeMetadata(profileId);
    }
  });
  useExplorer.subscribe((state, previous) => {
    for (const [profileId, expanded] of Object.entries(state.expanded)) {
      if (expanded === previous.expanded[profileId]) continue;
      for (const [key, open] of Object.entries(expanded)) {
        if (!open || previous.expanded[profileId]?.[key]) continue;
        const database = (JSON.parse(key) as string[])[0];
        if (database !== undefined) void metadataCache.use(profileId, database);
      }
    }
  });
}
