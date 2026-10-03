import { engineIdSchema } from '@querybara/core';
import { z } from 'zod';

import { idSchema } from './common';

/**
 * Backup and restore jobs (spec §14) as they cross between the renderer, main and the job
 * runner. Backups write only where the window's `dialogs.saveFile` pointed and restores read
 * only files it picked with `dialogs.openFile` (ADR 0006's file grants).
 *
 * An archive passphrase travels with the job to the job runner, which derives the keys and
 * drops it; job records, logs and the history never hold it. The literal lists mirror
 * @querybara/backup, which this package cannot import (it uses Node.js); the desktop tests check
 * they match.
 */

const filePathSchema = z.string().min(1).max(4096);
const countSchema = z.number().int().nonnegative();
const jsonScalarSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);

/** `qbak` is Querybara's archive; `custom` is pg_dump's (native tools only). */
export const BACKUP_FILE_FORMATS = ['sql', 'sql-gz', 'qbak', 'custom'] as const;
export const backupFileFormatSchema = z.enum(BACKUP_FILE_FORMATS);
export type BackupFileFormat = z.infer<typeof backupFileFormatSchema>;

export const BACKUP_OBJECT_KIND_NAMES = [
  'schema',
  'extension',
  'type',
  'sequence',
  'table',
  'partition',
  'index',
  'unique',
  'check',
  'primary-key',
  'column',
  'foreign-key',
  'trigger',
  'view',
  'materialized-view',
  'routine',
  'event',
  'grants',
  'collection',
  'keys',
] as const;
export const backupObjectKindSchema = z.enum(BACKUP_OBJECT_KIND_NAMES);
export type BackupObjectKindName = z.infer<typeof backupObjectKindSchema>;

/** Querybara's own format, or pg_dump / mysqldump when installed. */
export const backupMethodSchema = z.enum(['querybara', 'native']);
export type BackupMethod = z.infer<typeof backupMethodSchema>;

/** An archive passphrase: used by the job runner to derive keys, never stored or logged. */
export const backupPassphraseSchema = z.string().min(1).max(1024);

export const backupObjectRefSchema = z.object({
  kind: backupObjectKindSchema,
  schema: z.string().max(256).optional(),
  name: z.string().min(1).max(1024),
});
export type BackupObjectRef = z.infer<typeof backupObjectRefSchema>;

export const backupSelectionSchema = z.object({
  /** PostgreSQL schemas; every non-system schema when absent. */
  schemas: z.array(z.string().min(1).max(256)).max(1000).optional(),
  /** Only these objects (and what they need). */
  include: z.array(backupObjectRefSchema).max(100_000).optional(),
  exclude: z.array(backupObjectRefSchema).max(100_000).optional(),
  /** Tables backed up without their rows. */
  excludeData: z.array(backupObjectRefSchema).max(100_000).optional(),
});
export type BackupSelectionInfo = z.infer<typeof backupSelectionSchema>;

const jobTarget = {
  profileId: idSchema,
  /**
   * PostgreSQL: the database to connect to. MySQL and MariaDB: the database to back up or
   * restore into. MongoDB: the database. Redis: the logical database number.
   */
  database: z.string().max(256).optional(),
  method: backupMethodSchema.optional(),
};

export const backupJobSchema = z.object({
  kind: z.literal('backup'),
  ...jobTarget,
  format: backupFileFormatSchema,
  output: z.object({ path: filePathSchema }),
  /** Archives: gzip each file inside (default true). */
  compress: z.boolean().optional(),
  /** Archives only. */
  encryption: z.object({ passphrase: backupPassphraseSchema }).optional(),
  selection: backupSelectionSchema.optional(),
  structure: z.boolean().optional(),
  data: z.boolean().optional(),
  grants: z.boolean().optional(),
  ownership: z.boolean().optional(),
  consistent: z.boolean().optional(),
  deferrable: z.boolean().optional(),
  rowsPerStatement: z.number().int().min(1).max(100_000).optional(),
  /** MongoDB: collections to back up (default all) and how documents are written. */
  collections: z.array(z.string().min(1).max(256)).max(100_000).optional(),
  documentFormat: z.enum(['bson', 'ejson']).optional(),
  /** Redis: the key pattern (default `*`). */
  pattern: z.string().max(1024).optional(),
});
export type BackupJob = z.infer<typeof backupJobSchema>;

export const restoreJobSchema = z.object({
  kind: z.literal('restore'),
  ...jobTarget,
  path: filePathSchema,
  passphrase: backupPassphraseSchema.optional(),
  /** Archive object ids to restore (default all); what they need comes along. */
  select: z.array(z.string().min(1).max(4096)).max(100_000).optional(),
  structure: z.boolean().optional(),
  data: z.boolean().optional(),
  onError: z.enum(['stop', 'continue']),
  /** Redis: overwrite existing keys, and expire keys at their original time. */
  replace: z.boolean().optional(),
  absoluteTtl: z.boolean().optional(),
  /** Create `database` first (SQL engines). */
  createDatabase: z.boolean().optional(),
  /**
   * The existing objects the user agreed to drop or overwrite (conflict ids from the plan). The
   * job runner finds the conflicts again and refuses when any is not in this list.
   */
  confirmedConflicts: z.array(z.string().min(1).max(4096)).max(100_000).optional(),
  /** The user confirmed writing to a production profile or one that confirms every write. */
  confirmed: z.boolean().optional(),
});
export type RestoreJob = z.infer<typeof restoreJobSchema>;

export const backupObjectInfoSchema = z.object({
  id: z.string(),
  kind: backupObjectKindSchema,
  schema: z.string().optional(),
  name: z.string(),
  qualifiedName: z.string(),
  parent: z.string().optional(),
  dependsOn: z.array(z.string()),
  /** Rows, documents or keys backed up. */
  rows: countSchema.optional(),
  detail: z.record(z.string(), jsonScalarSchema).optional(),
});
export type BackupObjectInfo = z.infer<typeof backupObjectInfoSchema>;

export const backupInspectInputSchema = z.object({
  path: filePathSchema,
  passphrase: backupPassphraseSchema.optional(),
});
export type BackupInspectInput = z.infer<typeof backupInspectInputSchema>;

/** What a backup file holds (the restore wizard's first step). */
export const backupInspectionSchema = z.object({
  format: backupFileFormatSchema,
  size: countSchema,
  encrypted: z.boolean(),
  /** Absent when the archive is encrypted and no passphrase was given. */
  objects: z.array(backupObjectInfoSchema).optional(),
  engine: engineIdSchema.optional(),
  serverVersion: z.string().optional(),
  database: z.string().optional(),
  createdAt: z.string().optional(),
  producer: z.string().optional(),
  options: z.record(z.string(), jsonScalarSchema).optional(),
  warnings: z.array(z.string()).optional(),
});
export type BackupInspection = z.infer<typeof backupInspectionSchema>;

export const restoreConflictSchema = z.object({
  id: z.string(),
  kind: z.string(),
  qualifiedName: z.string(),
  action: z.enum(['drop', 'append', 'overwrite']),
});
export type RestoreConflictInfo = z.infer<typeof restoreConflictSchema>;

export const restorePlanInputSchema = z.object({
  job: restoreJobSchema,
  /** "Ask every time" secrets for this connection only. */
  secrets: z.record(z.uuid(), z.string().max(65_536)).optional(),
});
export type RestorePlanInput = z.infer<typeof restorePlanInputSchema>;

/** What a restore will do: the review step, and the confirmation of what it drops. */
export const restorePlanSchema = z.object({
  format: backupFileFormatSchema,
  objects: z.array(z.string()),
  added: z.array(z.string()),
  skipped: z.array(z.object({ id: z.string(), reason: z.string() })),
  conflicts: z.array(restoreConflictSchema),
  warnings: z.array(z.string()),
});
export type RestorePlan = z.infer<typeof restorePlanSchema>;

export const NATIVE_TOOL_NAMES = [
  'pg_dump',
  'pg_restore',
  'psql',
  'mysqldump',
  'mariadb-dump',
  'mysql',
  'mariadb',
] as const;

export const nativeToolSchema = z.object({
  name: z.enum(NATIVE_TOOL_NAMES),
  path: z.string(),
  family: z.enum(['postgres', 'mysql', 'mariadb']),
  version: z.string(),
  major: countSchema,
  minor: countSchema,
});
export type NativeToolInfo = z.infer<typeof nativeToolSchema>;
