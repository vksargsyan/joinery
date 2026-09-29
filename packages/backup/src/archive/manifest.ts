import { engineIdSchema } from '@joinery/core';
import { z } from 'zod';

/**
 * The manifest of a Joinery archive (docs/backup-archive-format.md): what was backed up, from
 * which server, with which options, and where each object's files are in the archive, with a
 * SHA-256 of each file. It is the archive's last entry, so it is written once every object has
 * streamed through, and it is validated against this schema when an archive is opened.
 */

export const ARCHIVE_FORMAT = 'joinery-backup';
export const ARCHIVE_FORMAT_VERSION = 1;

export const ENTRY_CONTENT_TYPES = [
  /** SQL statements, each ending with `;` and a newline. */
  'application/sql',
  /** A JSON document. */
  'application/json',
  /** Concatenated BSON documents. */
  'application/bson',
  /** Canonical Extended JSON, one document per line. */
  'application/x-ndjson',
] as const;
export type EntryContentType = (typeof ENTRY_CONTENT_TYPES)[number];

/** Where one file of the archive lives, and what it must hash to. */
export const entryRecordSchema = z.object({
  /** A path-like name, unique in the archive, e.g. `data/public/orders.sql`. */
  name: z.string().min(1).max(2048),
  /** Position in the archive, bound into every frame's integrity check. */
  index: z.number().int().nonnegative(),
  /** Byte offset of the entry header. */
  offset: z.number().int().nonnegative(),
  /** Bytes the entry takes in the archive: header and frames. */
  storedLength: z.number().int().nonnegative(),
  /** Bytes of content, uncompressed. */
  size: z.number().int().nonnegative(),
  /** SHA-256 of the uncompressed content, lower-case hex. */
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  contentType: z.enum(ENTRY_CONTENT_TYPES),
});
export type EntryRecord = z.infer<typeof entryRecordSchema>;

/** Kinds of objects an archive holds. */
export const BACKUP_OBJECT_KINDS = [
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
export const backupObjectKindSchema = z.enum(BACKUP_OBJECT_KINDS);
export type BackupObjectKind = z.infer<typeof backupObjectKindSchema>;

const jsonScalar = z.union([z.string(), z.number(), z.boolean(), z.null()]);

/** One restorable object and the files that hold it. */
export const backupObjectSchema = z.object({
  /** Stable id, e.g. `table:public.orders:create`. */
  id: z.string().min(1).max(4096),
  kind: backupObjectKindSchema,
  /** PostgreSQL schema; absent for MySQL, MariaDB, MongoDB and Redis. */
  schema: z.string().optional(),
  name: z.string(),
  /** Display name, e.g. `public.orders`. */
  qualifiedName: z.string(),
  /** The object this one belongs to (a table's foreign keys and triggers). */
  parent: z.string().optional(),
  /** Objects that must exist before this one is created. */
  dependsOn: z.array(z.string()).default([]),
  /** SQL: the entry with the statements `{ pre: [...], post: [...] }`. */
  ddl: z.string().optional(),
  /** Rows or documents and the entry holding them. */
  data: z
    .object({
      entry: z.string(),
      /** Rows (SQL), documents (MongoDB) or keys (Redis). */
      count: z.number().int().nonnegative(),
      /** SQL: the columns the INSERTs name. */
      columns: z.array(z.string()).optional(),
    })
    .optional(),
  /** MongoDB: the entry with the collection's options and indexes. */
  metadata: z.string().optional(),
  /** Engine-specific facts shown in the restore wizard (MongoDB collection type...). */
  detail: z.record(z.string(), jsonScalar).optional(),
});
export type BackupObject = z.infer<typeof backupObjectSchema>;

export const manifestSchema = z.object({
  format: z.literal(ARCHIVE_FORMAT),
  formatVersion: z.literal(ARCHIVE_FORMAT_VERSION),
  createdAt: z.iso.datetime({ offset: true }),
  /** "Joinery" and the version that wrote the archive, when known. */
  producer: z.string().max(200),
  engine: engineIdSchema,
  serverVersion: z.string().max(500),
  /** The database (MongoDB database, Redis logical database) backed up. */
  database: z.string().max(512),
  /** Database default charset, collation, encoding... */
  databaseOptions: z.record(z.string(), z.string()).default({}),
  /** The backup options, for display and for the restore to honour (compression, snapshot...). */
  options: z.record(z.string(), jsonScalar).default({}),
  /** Objects in creation order. */
  objects: z.array(backupObjectSchema),
  entries: z.array(entryRecordSchema),
  warnings: z.array(z.string()).default([]),
});
export type Manifest = z.infer<typeof manifestSchema>;
export type ManifestInput = z.input<typeof manifestSchema>;
