/**
 * @joinery/backup — backup and restore (spec §14).
 *
 * - The Joinery archive (.jbak): one file per object plus a manifest, optionally encrypted with
 *   AES-256-GCM under a scrypt-derived key, streamed in frames so any size fits in flat memory,
 *   with random access for selective restore (`ArchiveWriter`, `ArchiveReader`; the format is
 *   specified in docs/backup-archive-format.md).
 * - SQL engines: app-native logical backups in one consistent snapshot, to plain SQL, gzipped
 *   SQL or an archive (`backupSql`), and restores of everything or selected objects with the
 *   write rules enforced (`planSqlRestore`, `restoreSqlArchive`, `restoreSqlScript`).
 * - MongoDB collections with their options and indexes, and Redis keys with their TTLs.
 * - The native tools (pg_dump, pg_restore, psql, mysqldump, mysql) when installed.
 * - `runBackup`, `inspectBackup`, `planRestore` and `runRestore` dispatch on the engine, for
 *   the job runner and joinery-cli.
 *
 * Never imports Electron: it runs in the job runner utility process and in joinery-cli.
 */

export { DEFAULT_SCRYPT_COST, isValidScryptCost, type ScryptCost } from './archive/crypto';
export { isArchive } from './archive/format';
export {
  ARCHIVE_FORMAT,
  ARCHIVE_FORMAT_VERSION,
  BACKUP_OBJECT_KINDS,
  ENTRY_CONTENT_TYPES,
  backupObjectSchema,
  entryRecordSchema,
  manifestSchema,
  type BackupObject,
  type BackupObjectKind,
  type EntryContentType,
  type EntryRecord,
  type Manifest,
} from './archive/manifest';
export {
  ArchiveWriter,
  type ArchiveEncryption,
  type ArchiveWriterOptions,
  type EntryWriter,
  type ManifestContent,
} from './archive/writer';
export {
  ArchiveReader,
  fileArchiveSource,
  memoryArchiveSource,
  type ArchiveOpenOptions,
  type ArchiveProbe,
  type ArchiveSource,
} from './archive/reader';

export {
  BACKUP_FORMATS,
  type BackupCommonOptions,
  type BackupFormat,
  type BackupProgress,
  type BackupSelection,
  type BackupSummary,
  type LogLevel,
  type Logger,
  type ObjectRef,
  type RestoreCommonOptions,
  type RestoreConflict,
  type RestoreError,
  type RestoreProgress,
  type RestoreSummary,
  type TransferStatus,
} from './types';
export { checkConfirmed, safeName } from './common';
export {
  refMatches,
  resolveSelection,
  type Selectable,
  type SelectionResult,
  type SelectionRules,
} from './selection';

export {
  backupSql,
  scriptPreamble,
  type ObjectStatements,
  type SqlBackupOptions,
} from './sql/backup';
export { InsertWriter, tableData, type TableData } from './sql/data';
export { emptyTarget, planSqlObjects, type SqlObject, type SqlPlan } from './sql/objects';
export {
  countObjects,
  objectStatements,
  planSqlRestore,
  restoreSqlArchive,
  restoreSqlScript,
  scriptConflicts,
  type SqlRestoreOptions,
  type SqlRestorePlan,
  type SqlRestorePlanOptions,
  type SqlScriptRestoreOptions,
} from './sql/restore';
export { createDatabase, currentDatabase, type SnapshotMode } from './sql/session';

export {
  backupMongo,
  createCommand,
  indexesToCreate,
  isMongoBackupSession,
  planMongoRestore,
  restoreMongoArchive,
  type CollectionMetadata,
  type DocumentFormat,
  type MongoBackupOptions,
  type MongoBackupSession,
  type MongoRestoreOptions,
  type MongoRestorePlan,
} from './mongo/archive';
export {
  backupRedis,
  isRedisBackupSession,
  planRedisRestore,
  restoreRedisArchive,
  type DumpedKeyRecord,
  type RedisBackupOptions,
  type RedisBackupSession,
  type RedisRestoreOptions,
  type RedisRestorePlan,
} from './redis/archive';

export {
  inspectBackup,
  planRestore,
  runBackup,
  runRestore,
  type BackupInspection,
  type BackupRequest,
  type RestorePlanSummary,
  type RestoreRequest,
} from './run';

export {
  NATIVE_TOOL_NAMES,
  chooseTool,
  detectNativeTools,
  parseToolVersion,
  serverFamily,
  type DetectOptions,
  type NativeTask,
  type NativeTool,
  type NativeToolName,
  type ToolFamily,
} from './native/tools';
export { nativeEndpoint, optionValue, pgPassLine, type NativeEndpoint } from './native/run';
export {
  isPgCustomArchive,
  nativeBackup,
  nativeRestore,
  type NativeBackupOptions,
  type NativeFormat,
  type NativeRestoreOptions,
} from './native/native';
