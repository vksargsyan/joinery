import { JoineryError } from '@joinery/core';

import { readNumber } from './internal/rows';
import type { SqliteDatabase } from './sqlite';

/**
 * Schema migrations. Each migration has the next integer version, runs in its own transaction
 * and records itself in `PRAGMA user_version`, so a crash mid-way leaves the store at the last
 * complete version. Never edit a released migration; add a new one.
 *
 * `PRAGMA foreign_keys` cannot change inside a transaction, so a future migration that rebuilds
 * a table must follow SQLite's 12-step procedure with foreign keys left on (no dangling rows).
 */

export interface Migration {
  readonly version: number;
  readonly name: string;
  up(db: SqliteDatabase): void;
}

const initialSchema: Migration = {
  version: 1,
  name: 'initial schema',
  up(db) {
    db.exec(`
      CREATE TABLE folders (
        id TEXT PRIMARY KEY,
        parent_id TEXT REFERENCES folders (id),
        name TEXT NOT NULL,
        sort_order INTEGER NOT NULL DEFAULT 0,
        version INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX folders_by_parent ON folders (parent_id);

      -- The full validated profile lives in data; the other columns are indexed copies.
      CREATE TABLE profiles (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        engine TEXT NOT NULL,
        folder_id TEXT REFERENCES folders (id),
        environment TEXT NOT NULL,
        data TEXT NOT NULL,
        version INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX profiles_by_folder ON profiles (folder_id, name COLLATE NOCASE);
      CREATE INDEX profiles_by_name ON profiles (name COLLATE NOCASE);
      CREATE INDEX profiles_by_engine ON profiles (engine);
      CREATE INDEX profiles_by_environment ON profiles (environment);

      -- Which secrets each profile references; a secret is deleted once no profile needs it.
      CREATE TABLE profile_secrets (
        profile_id TEXT NOT NULL REFERENCES profiles (id) ON DELETE CASCADE,
        secret_id TEXT NOT NULL,
        PRIMARY KEY (profile_id, secret_id)
      ) STRICT, WITHOUT ROWID;
      CREATE INDEX profile_secrets_by_secret ON profile_secrets (secret_id);

      -- Sealed values only; plaintext never reaches this table.
      CREATE TABLE secrets (
        id TEXT PRIMARY KEY,
        sealer TEXT NOT NULL,
        sealed BLOB NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE query_history (
        seq INTEGER PRIMARY KEY,
        id TEXT NOT NULL UNIQUE,
        profile_id TEXT NOT NULL REFERENCES profiles (id) ON DELETE CASCADE,
        database_name TEXT,
        text TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('success', 'error', 'cancelled')),
        error TEXT,
        duration_ms REAL,
        row_count INTEGER,
        executed_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX query_history_by_profile ON query_history (profile_id, seq);

      CREATE TABLE saved_queries (
        id TEXT PRIMARY KEY,
        profile_id TEXT REFERENCES profiles (id) ON DELETE SET NULL,
        project_id TEXT,
        name TEXT NOT NULL,
        description TEXT,
        database_name TEXT,
        text TEXT NOT NULL,
        tags TEXT NOT NULL,
        version INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX saved_queries_by_profile ON saved_queries (profile_id);
      CREATE INDEX saved_queries_by_project ON saved_queries (project_id);

      CREATE TABLE snippets (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        prefix TEXT,
        description TEXT,
        body TEXT NOT NULL,
        engines TEXT NOT NULL,
        version INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE metadata_cache (
        profile_id TEXT NOT NULL REFERENCES profiles (id) ON DELETE CASCADE,
        database_name TEXT NOT NULL,
        snapshot TEXT NOT NULL,
        captured_at TEXT NOT NULL,
        stored_at TEXT NOT NULL,
        PRIMARY KEY (profile_id, database_name)
      ) STRICT;

      CREATE TABLE settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        version INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
    `);
  },
};

/** The FTS5 table backing history search; absent when SQLite lacks FTS5 or trigram. */
export const HISTORY_FTS_TABLE = 'query_history_fts';

const historyFullText: Migration = {
  version: 2,
  name: 'query history full-text index',
  up(db) {
    // node:sqlite (Node.js and Electron) compiles FTS5 in. If a build ever lacks it, history
    // search falls back to LIKE, which the repository detects from the missing table.
    if (!supportsTrigramFts(db)) return;
    db.exec(`
      CREATE VIRTUAL TABLE ${HISTORY_FTS_TABLE} USING fts5 (
        text, content = 'query_history', content_rowid = 'seq', tokenize = 'trigram'
      );
      INSERT INTO ${HISTORY_FTS_TABLE} (${HISTORY_FTS_TABLE}) VALUES ('rebuild');
      CREATE TRIGGER query_history_fts_insert AFTER INSERT ON query_history BEGIN
        INSERT INTO ${HISTORY_FTS_TABLE} (rowid, text) VALUES (new.seq, new.text);
      END;
      CREATE TRIGGER query_history_fts_delete AFTER DELETE ON query_history BEGIN
        INSERT INTO ${HISTORY_FTS_TABLE} (${HISTORY_FTS_TABLE}, rowid, text)
          VALUES ('delete', old.seq, old.text);
      END;
      CREATE TRIGGER query_history_fts_update AFTER UPDATE OF text ON query_history BEGIN
        INSERT INTO ${HISTORY_FTS_TABLE} (${HISTORY_FTS_TABLE}, rowid, text)
          VALUES ('delete', old.seq, old.text);
        INSERT INTO ${HISTORY_FTS_TABLE} (rowid, text) VALUES (new.seq, new.text);
      END;
    `);
  },
};

/** Every migration, in order. The last one's version is the schema version this build writes. */
export const MIGRATIONS: readonly Migration[] = [initialSchema, historyFullText];

export const SCHEMA_VERSION = MIGRATIONS.length;

export interface MigrationResult {
  readonly from: number;
  readonly to: number;
  /** Versions applied by this call, in order. */
  readonly applied: readonly number[];
}

/** The schema version recorded in the database (0 for a new, empty one). */
export function readSchemaVersion(db: SqliteDatabase): number {
  const row = db.get('PRAGMA user_version');
  return row ? readNumber(row, 'user_version') : 0;
}

/**
 * Brings the database up to the latest schema. Safe to call on every open and from two
 * processes at once: each step re-checks the version inside its write transaction. Refuses a
 * store written by a newer Joinery rather than risk corrupting it.
 */
export function migrate(
  db: SqliteDatabase,
  migrations: readonly Migration[] = MIGRATIONS,
): MigrationResult {
  assertOrdered(migrations);
  const latest = migrations.length;
  const from = readSchemaVersion(db);
  assertKnownVersion(from, latest, db.location);
  const applied: number[] = [];
  for (const migration of migrations) {
    if (migration.version <= from) continue;
    db.transaction(() => {
      const current = readSchemaVersion(db);
      assertKnownVersion(current, latest, db.location);
      if (current >= migration.version) return;
      migration.up(db);
      // user_version is part of the database header, so it commits or rolls back with the rest.
      db.exec(`PRAGMA user_version = ${migration.version}`);
      applied.push(migration.version);
    });
  }
  return { from, to: readSchemaVersion(db), applied };
}

function assertOrdered(migrations: readonly Migration[]): void {
  migrations.forEach((migration, index) => {
    if (migration.version !== index + 1) {
      throw new Error(`Migration "${migration.name}" must have version ${index + 1}`);
    }
  });
}

function assertKnownVersion(version: number, latest: number, location: string): void {
  if (version <= latest) return;
  throw new JoineryError({
    code: 'NOT_SUPPORTED',
    message: `The Joinery data store at ${location} has schema version ${version}, but this version of Joinery only understands up to ${latest}.`,
    hint: 'Update Joinery to open this data store; it was written by a newer version.',
  });
}

function supportsTrigramFts(db: SqliteDatabase): boolean {
  try {
    db.transaction(() => {
      db.exec("CREATE VIRTUAL TABLE temp.joinery_fts_probe USING fts5 (x, tokenize = 'trigram')");
      db.exec('DROP TABLE temp.joinery_fts_probe');
    });
    return true;
  } catch {
    return false;
  }
}
