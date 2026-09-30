import { schemaSnapshotSchema, type SchemaSnapshot } from '@joinery/core';
import type { z } from 'zod';

import type { RepositoryContext } from '../internal/context';
import { notFound, parseOrThrow } from '../internal/errors';
import { readJson, readText } from '../internal/rows';
import type { SqlRow, SqliteDatabase } from '../sqlite';

/** What callers pass to `put`: a snapshot as introspection produced it (defaults optional). */
export type SchemaSnapshotInput = z.input<typeof schemaSnapshotSchema>;

export interface CachedSnapshotInfo {
  readonly profileId: string;
  readonly database: string;
  /** When the snapshot was introspected (the snapshot's own `capturedAt`). */
  readonly capturedAt: string;
  /** When it was written to the cache. */
  readonly storedAt: string;
}

export interface CachedSnapshot extends CachedSnapshotInfo {
  readonly snapshot: SchemaSnapshot;
}

/**
 * The per-connection metadata cache (spec §5): one schema snapshot per (profile, database),
 * feeding autocomplete, the query builder and the diagram tools without a round trip. It is
 * disposable: an entry that no longer validates (after an upgrade changed the snapshot shape)
 * reads as a miss and is dropped.
 */
export class MetadataCacheRepository {
  readonly #db: SqliteDatabase;
  readonly #now: () => string;

  constructor(context: RepositoryContext) {
    this.#db = context.db;
    this.#now = context.now;
  }

  /** Stores (or replaces) the snapshot of `snapshot.database` for a profile. */
  put(profileId: string, input: SchemaSnapshotInput): CachedSnapshotInfo {
    const snapshot = parseOrThrow(schemaSnapshotSchema, input, 'schema snapshot');
    if (!this.#db.get('SELECT 1 AS found FROM profiles WHERE id = ?', [profileId])) {
      throw notFound('Profile', profileId);
    }
    const info: CachedSnapshotInfo = {
      profileId,
      database: snapshot.database,
      capturedAt: snapshot.capturedAt,
      storedAt: this.#now(),
    };
    this.#db.run(
      `INSERT INTO metadata_cache (profile_id, database_name, snapshot, captured_at, stored_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (profile_id, database_name) DO UPDATE SET
         snapshot = excluded.snapshot, captured_at = excluded.captured_at,
         stored_at = excluded.stored_at`,
      [profileId, info.database, JSON.stringify(snapshot), info.capturedAt, info.storedAt],
    );
    return info;
  }

  get(profileId: string, database: string): CachedSnapshot | undefined {
    const row = this.#db.get(
      'SELECT * FROM metadata_cache WHERE profile_id = ? AND database_name = ?',
      [profileId, database],
    );
    if (!row) return undefined;
    const parsed = schemaSnapshotSchema.safeParse(readJson(row, 'snapshot'));
    if (!parsed.success) {
      this.invalidate(profileId, database);
      return undefined;
    }
    return { ...toInfo(row), snapshot: parsed.data };
  }

  /** What is cached for a profile, without loading the snapshots. Ordered by database name. */
  list(profileId: string): CachedSnapshotInfo[] {
    return this.#db
      .all(
        `SELECT profile_id, database_name, captured_at, stored_at FROM metadata_cache
         WHERE profile_id = ? ORDER BY database_name`,
        [profileId],
      )
      .map(toInfo);
  }

  /**
   * Drops one database's snapshot, or every snapshot of the profile (after DDL, on refresh, or
   * when the user asks). Returns the number of entries dropped.
   */
  invalidate(profileId: string, database?: string): number {
    return database === undefined
      ? this.#db.run('DELETE FROM metadata_cache WHERE profile_id = ?', [profileId]).changes
      : this.#db.run('DELETE FROM metadata_cache WHERE profile_id = ? AND database_name = ?', [
          profileId,
          database,
        ]).changes;
  }
}

function toInfo(row: SqlRow): CachedSnapshotInfo {
  return {
    profileId: readText(row, 'profile_id'),
    database: readText(row, 'database_name'),
    capturedAt: readText(row, 'captured_at'),
    storedAt: readText(row, 'stored_at'),
  };
}
