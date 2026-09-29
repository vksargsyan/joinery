/**
 * @joinery/storage: the local SQLite store (spec §4, §5, §6, §16). Used by the desktop main
 * process and by joinery-cli; it never imports Electron. The desktop plugs Electron safeStorage
 * in through `SecretSealer`.
 */

export {
  openDatabase,
  type OpenDatabaseOptions,
  type RunResult,
  type SqlParams,
  type SqlRow,
  type SqlValue,
  type SqliteDatabase,
  type SqliteStatement,
} from './sqlite';

export {
  MIGRATIONS,
  SCHEMA_VERSION,
  migrate,
  readSchemaVersion,
  type Migration,
  type MigrationResult,
} from './migrations';

export { createStore, openStore, type Store, type StoreOptions } from './store';

export type { WriteOptions } from './internal/versioning';
export { REDACTED } from './internal/redact';

export type {
  ProfileFilter,
  ProfileRepository,
  ProfileRepositoryHooks,
  ProfileSaveInput,
  StoredProfile,
} from './repositories/profiles';
export {
  folderSchema,
  type Folder,
  type FolderCreateInput,
  type FolderPatch,
  type FolderRepository,
} from './repositories/folders';
export {
  historyEntrySchema,
  queryStatusSchema,
  type HistoryEntry,
  type HistoryEntryInput,
  type HistoryPage,
  type HistoryPageOptions,
  type QueryHistoryRepository,
  type QueryStatus,
} from './repositories/history';
export {
  savedQuerySchema,
  type SavedQuery,
  type SavedQueryCreateInput,
  type SavedQueryFilter,
  type SavedQueryPatch,
  type SavedQueryRepository,
} from './repositories/saved-queries';
export {
  snippetSchema,
  type Snippet,
  type SnippetCreateInput,
  type SnippetPatch,
  type SnippetRepository,
} from './repositories/snippets';
export type {
  CachedSnapshot,
  CachedSnapshotInfo,
  MetadataCacheRepository,
  SchemaSnapshotInput,
} from './repositories/metadata-cache';
export type { JsonValue, SettingEntry, SettingsRepository } from './repositories/settings';
export {
  savedComparisonRecordSchema,
  type SavedComparisonCreateInput,
  type SavedComparisonFilter,
  type SavedComparisonPatch,
  type SavedComparisonRecord,
  type SavedComparisonRepository,
} from './repositories/comparisons';
export {
  gridColumnStateSchema,
  gridLayoutSchema,
  gridSortTermSchema,
  gridViewSchema,
  gridViewTableSchema,
  type GridColumnState,
  type GridLayout,
  type GridSortTerm,
  type GridView,
  type GridViewRepository,
  type GridViewSaveInput,
  type GridViewTable,
} from './repositories/grid-views';
export {
  AUTOSAVE_KINDS,
  MAX_AUTOSAVE_TEXT,
  autosaveEntrySchema,
  type AutosaveEntry,
  type AutosaveEntryInput,
  type AutosaveKind,
  type EditorAutosaveRepository,
  type PreviousRun,
} from './repositories/editor-autosave';

export {
  PASSPHRASE_SEALER_ID,
  createPassphraseSealer,
  type PassphraseSealerOptions,
  type SecretSealer,
} from './secrets/sealer';
export { DEFAULT_SCRYPT_COST, type ScryptCost } from './secrets/envelope';
export type { ResolvedSecrets, SecretStore } from './secrets/secret-store';

export {
  parseConnectionUri,
  type ConnectionProfileDraft,
  type ParseConnectionUriOptions,
  type ParsedConnectionUri,
} from './import/uri';
export { matchPgpass, parsePgpass, type PgpassEntry, type PgpassTarget } from './import/pgpass';
export {
  exportProfiles,
  exportedFolderSchema,
  importProfiles,
  type ExportProfilesOptions,
  type ExportedFolder,
  type ImportedProfiles,
} from './import/export';
