import type { RepositoryContext } from './internal/context';
import { migrate } from './migrations';
import { SavedComparisonRepository } from './repositories/comparisons';
import { EditorAutosaveRepository } from './repositories/editor-autosave';
import { FolderRepository } from './repositories/folders';
import { GridViewRepository } from './repositories/grid-views';
import { QueryHistoryRepository } from './repositories/history';
import { MetadataCacheRepository } from './repositories/metadata-cache';
import { ProfileRepository } from './repositories/profiles';
import { SavedQueryRepository } from './repositories/saved-queries';
import { SettingsRepository } from './repositories/settings';
import { SnippetRepository } from './repositories/snippets';
import type { SecretSealer } from './secrets/sealer';
import { SecretStore } from './secrets/secret-store';
import { openDatabase, type OpenDatabaseOptions, type SqliteDatabase } from './sqlite';

export interface StoreOptions {
  /**
   * Seals secrets with the `save` policy: Electron safeStorage in the desktop app, a
   * passphrase sealer in joinery-cli.
   */
  readonly sealer: SecretSealer;
  /** Clock for every timestamp the store writes; tests pin it. */
  readonly now?: () => Date;
}

/**
 * The local-first store (spec §16: SQLite is the source of truth). Opened by the desktop main
 * process and by joinery-cli; both may have it open at once (WAL, busy timeout).
 */
export interface Store {
  readonly db: SqliteDatabase;
  readonly profiles: ProfileRepository;
  readonly folders: FolderRepository;
  readonly secrets: SecretStore;
  readonly history: QueryHistoryRepository;
  readonly savedQueries: SavedQueryRepository;
  readonly snippets: SnippetRepository;
  readonly metadataCache: MetadataCacheRepository;
  readonly settings: SettingsRepository;
  /** Saved structure and data comparisons (spec §13). */
  readonly comparisons: SavedComparisonRepository;
  /** Saved table views: column layout, sort and filter per profile and table (spec §7). */
  readonly gridViews: GridViewRepository;
  /** Unsaved editor buffers and the app's run marker, for crash restore (spec §18). */
  readonly autosave: EditorAutosaveRepository;
  /** Forgets session secrets and closes the database. */
  close(): void;
}

/** Opens the store file (':memory:' for tests), creating and migrating it as needed. */
export function openStore(location: string, options: StoreOptions & OpenDatabaseOptions): Store {
  const db = openDatabase(location, options);
  try {
    return createStore(db, options);
  } catch (error) {
    db.close();
    throw error;
  }
}

/** Builds the store on an open database, migrating it first. */
export function createStore(db: SqliteDatabase, options: StoreOptions): Store {
  migrate(db);
  const clock = options.now ?? (() => new Date());
  const context: RepositoryContext = { db, now: () => clock().toISOString() };
  const secrets = new SecretStore(context, options.sealer);
  const profiles = new ProfileRepository(context, {
    onSecretsReleased: (ids) => secrets.forgetSession(ids),
  });
  return {
    db,
    profiles,
    folders: new FolderRepository(context, profiles),
    secrets,
    history: new QueryHistoryRepository(context),
    savedQueries: new SavedQueryRepository(context),
    snippets: new SnippetRepository(context),
    metadataCache: new MetadataCacheRepository(context),
    settings: new SettingsRepository(context),
    comparisons: new SavedComparisonRepository(context),
    gridViews: new GridViewRepository(context),
    autosave: new EditorAutosaveRepository(context),
    close() {
      secrets.clearSession();
      db.close();
    },
  };
}
