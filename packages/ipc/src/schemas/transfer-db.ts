import { engineIdSchema } from '@querybara/core';
import { z } from 'zod';

import { idSchema } from './common';

/**
 * Schemas for data transfer between databases (spec §12): the transfer job the wizard, the
 * scheduler and querybara-cli run, the wizard's inspection of a connection (databases, schemas,
 * tables or collections), and the plan it shows in its mapping and review steps. They mirror
 * @querybara/transfer's `DbTransferSpec` and `TransferPlan`, which this package cannot import;
 * the desktop tests check they match.
 *
 * Column types typed in the wizard reach DDL: they must look like a type (see
 * `TRANSFER_DATA_TYPE_PATTERN`), and the engine checks them again before it renders anything.
 */

export const DB_TABLE_MODES = ['create', 'drop-create', 'truncate', 'append'] as const;
export const dbTableModeSchema = z.enum(DB_TABLE_MODES);
export type DbTableModeInfo = z.infer<typeof dbTableModeSchema>;

export const FIELD_SHAPES = ['columns', 'json', 'child'] as const;
export const fieldShapeSchema = z.enum(FIELD_SHAPES);

/**
 * A target column type: words, an optional `(n)` or `(p,s)`, more words and array brackets
 * (`varchar(255)`, `timestamp(3) with time zone`, `int unsigned`, `text[]`, a BSON type name),
 * or a MySQL ENUM/SET with quoted labels.
 */
export const TRANSFER_DATA_TYPE_PATTERN =
  /^(?:[A-Za-z_][\w$.]*(?:\s+[A-Za-z_][\w$.]*)*(?:\s*\(\s*\d+(?:\s*,\s*-?\d+)?\s*\))?(?:\s+[A-Za-z_][\w$.]*)*(?:\s*\[\s*\d*\s*\])*|(?:enum|set)\s*\(\s*'(?:[^'\\]|\\.|'')*'(?:\s*,\s*'(?:[^'\\]|\\.|'')*')*\s*\))$/i;

export const transferDataTypeSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(TRANSFER_DATA_TYPE_PATTERN, 'Enter a type such as varchar(255), numeric(10,2) or text');

const nameSchema = z.string().min(1).max(256);
const countSchema = z.number().int().nonnegative();

/** What the user changed about one source column (or MongoDB field path). */
export const columnOverrideSchema = z.object({
  source: z.string().min(1).max(1024),
  target: z.string().trim().min(1).max(128).optional(),
  dataType: transferDataTypeSchema.optional(),
  skip: z.boolean().optional(),
  shape: fieldShapeSchema.optional(),
});
export type ColumnOverrideInfo = z.infer<typeof columnOverrideSchema>;

/** SQL → MongoDB: child rows embedded through a foreign key of the child table. */
export const embedSpecSchema = z.object({
  table: nameSchema,
  foreignKey: nameSchema,
  field: z.string().trim().min(1).max(256).optional(),
});

export const transferObjectSchema = z.object({
  /** Source table or collection. */
  name: nameSchema,
  /** Target table or collection (default: the source name). */
  target: nameSchema.optional(),
  mode: dbTableModeSchema.optional(),
  columns: z.array(columnOverrideSchema).max(4096).optional(),
  embed: z.array(embedSpecSchema).max(32).optional(),
});
export type TransferObjectInfo = z.infer<typeof transferObjectSchema>;

export const transferOptionsSchema = z.object({
  mode: dbTableModeSchema.optional(),
  batchSize: z.number().int().min(1).max(100_000).optional(),
  transactionPerBatch: z.boolean().optional(),
  onError: z.enum(['stop', 'skip']).optional(),
  /** Foreign key checks and triggers off while loading, where the engine allows. */
  disableConstraints: z.boolean().optional(),
  /** Tables transferred at the same time. */
  parallel: z.number().int().min(1).max(8).optional(),
  deferConstraints: z.boolean().optional(),
  resetSequences: z.boolean().optional(),
  /** MongoDB → SQL: documents sampled to infer the columns. */
  sampleSize: z.number().int().min(1).max(100_000).optional(),
  idFromPrimaryKey: z.boolean().optional(),
  /** Redis: overwrite keys that exist on the target. */
  replace: z.boolean().optional(),
  keepTtl: z.boolean().optional(),
});
export type TransferOptionsInfo = z.infer<typeof transferOptionsSchema>;

/**
 * A transfer between two connections. The job's `profileId` and `database` are the source's;
 * `schema` is the source's PostgreSQL schema. For a MongoDB source `database` names the
 * database of the collections; for Redis, the logical database.
 */
export const transferJobSchema = z.object({
  kind: z.literal('transfer'),
  profileId: idSchema,
  database: z.string().max(256).optional(),
  schema: z.string().max(256).optional(),
  /** Tables or collections. */
  objects: z.array(transferObjectSchema).max(10_000),
  /** Redis: glob patterns of the keys to copy. */
  keyPatterns: z.array(z.string().min(1).max(1024)).max(100).optional(),
  target: z.object({
    profileId: idSchema,
    database: z.string().max(256).optional(),
    schema: z.string().max(256).optional(),
  }),
  options: transferOptionsSchema.optional(),
  /**
   * The user confirmed the writes: needed for drop and create, truncate and Redis REPLACE, and
   * for every transfer into a production profile or one that confirms every write.
   */
  confirmed: z.boolean().optional(),
});
export type TransferJob = z.infer<typeof transferJobSchema>;

// ---------------------------------------------------------------------------------------------
// The plan

export const plannedColumnSchema = z.object({
  source: z.string(),
  target: z.string(),
  sourceType: z.string(),
  targetType: z.string(),
  defaultType: z.string(),
  nullable: z.boolean(),
  key: z.boolean(),
  editable: z.boolean(),
  skipped: z.boolean(),
  shape: fieldShapeSchema.optional(),
  note: z.string().optional(),
});
export type PlannedColumnInfo = z.infer<typeof plannedColumnSchema>;

export const plannedTableSchema = z.object({
  source: z.string(),
  target: z.string(),
  kind: z.enum(['table', 'child-table', 'collection', 'keys']),
  parent: z.string().optional(),
  action: dbTableModeSchema,
  exists: z.boolean(),
  rows: countSchema.optional(),
  columns: z.array(plannedColumnSchema),
  embeds: z
    .array(z.object({ table: z.string(), field: z.string(), foreignKey: z.string() }))
    .optional(),
  problems: z.array(z.string()),
  warnings: z.array(z.string()),
});
export type PlannedTableInfo = z.infer<typeof plannedTableSchema>;

/** What a transfer will do, for the mapping and review steps. */
export const transferPlanSchema = z.object({
  sourceEngine: engineIdSchema,
  targetEngine: engineIdSchema,
  sourceVersion: z.string(),
  targetVersion: z.string(),
  tables: z.array(plannedTableSchema),
  before: z.array(z.string()),
  after: z.array(z.string()),
  destructive: z.array(z.string()),
  creates: z.array(z.string()),
  problems: z.array(z.string()),
  warnings: z.array(z.string()),
});
export type TransferPlanInfo = z.infer<typeof transferPlanSchema>;

// ---------------------------------------------------------------------------------------------
// Wizard requests

const secretsSchema = z.record(z.uuid(), z.string().max(65_536));

/** What the wizard asks about a connection: its databases, schemas and objects. */
export const transferInspectInputSchema = z.object({
  profileId: idSchema,
  database: z.string().max(256).optional(),
  schema: z.string().max(256).optional(),
  /** "Ask every time" secrets of the profile, for this call only. */
  secrets: secretsSchema.optional(),
});
export type TransferInspectInput = z.infer<typeof transferInspectInputSchema>;

export const transferSourceObjectSchema = z.object({
  name: z.string(),
  kind: z.enum(['table', 'collection']),
  /** Rows or documents, as the server estimates them. */
  rows: countSchema.optional(),
  /** SQL tables: their foreign keys, so the wizard can offer to embed children. */
  foreignKeys: z
    .array(z.object({ name: z.string(), columns: z.array(z.string()), refTable: z.string() }))
    .optional(),
});
export type TransferSourceObject = z.infer<typeof transferSourceObjectSchema>;

export const transferInspectionSchema = z.object({
  engine: engineIdSchema,
  serverVersion: z.string(),
  /** Databases on the server (Redis: logical database numbers). */
  databases: z.array(z.string()),
  /** The database looked at (the connection's default when none was asked for). */
  database: z.string().optional(),
  /** PostgreSQL schemas of that database. */
  schemas: z.array(z.string()),
  /** Tables of the schema (or database), or collections. */
  objects: z.array(transferSourceObjectSchema),
  /** Redis: keys in the database (every primary in Cluster mode). */
  keys: countSchema.optional(),
  /** Redis Cluster: logical databases do not exist. */
  cluster: z.boolean().optional(),
});
export type TransferInspection = z.infer<typeof transferInspectionSchema>;

export const transferPlanInputSchema = z.object({
  job: transferJobSchema,
  /** "Ask every time" secrets of both profiles (SecretRef ids are unique across profiles). */
  secrets: secretsSchema.optional(),
});
