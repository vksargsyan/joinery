import { z } from 'zod';

import { engineIdSchema } from './engines';

/**
 * The normalised schema snapshot (spec §13, step 1). Introspection of every SQL engine lands in
 * this shape, and the structure diff, ER modelling, autocomplete and the metadata cache all read
 * it. Definitions keep the server's text (expressions, view bodies, routine bodies); the sync
 * engine normalises them before comparing.
 *
 * MySQL and MariaDB have no level between database and objects, so their snapshot holds exactly
 * one schema named after the database.
 *
 * Conventions every producer follows, so the diff compares like with like and a deployed script
 * re-introspects with zero differences (spec §13, step 8):
 *
 * - Names are exact and unquoted. Columns are ordered by ordinal; every other list by name.
 * - `dataType` is the type as the engine prints it: PostgreSQL format_type() ("character
 *   varying(255)", "timestamp with time zone", "integer[]"); MySQL/MariaDB COLUMN_TYPE
 *   ("int unsigned", "varchar(255)", "enum('a','b')").
 * - `default` is SQL expression text that can follow DEFAULT verbatim: string literals quoted
 *   ("'abc'"), CURRENT_TIMESTAMP bare, MySQL expression defaults parenthesised; null means no
 *   default. PostgreSQL identity columns have a null default and `identity` set.
 * - NOT NULL is `nullable: false`, never a check. `checks[].expression` is the condition without
 *   the CHECK keyword (PostgreSQL: pg_get_constraintdef minus the leading "CHECK ").
 * - Primary keys go in `primaryKey` and PostgreSQL UNIQUE constraints in `uniques`; the indexes
 *   backing them are not repeated in `indexes`. MySQL/MariaDB unique keys are indexes, so they
 *   go in `indexes` with `unique: true` and `uniques` stays empty.
 * - Foreign keys set `refSchema` only when the referenced table is in another schema.
 * - Definitions never qualify objects with the snapshot's own database name, and MySQL/MariaDB
 *   definitions omit the DEFINER clause (routines keep it in `definer`, views in
 *   `options.definer`), so snapshots of two databases with different names compare cleanly.
 * - `views[].definition` is the SELECT body; routines, triggers, events and types hold the full
 *   CREATE statement.
 * - Sequences owned by serial columns are listed with `ownedBy`; identity sequences are not
 *   (they belong to the column).
 * - Table `options` keys: MySQL/MariaDB `engine`, `charset`, `collation`, `autoIncrement`,
 *   `rowFormat`; PostgreSQL `tablespace` (only when not the default) and storage parameters
 *   such as `fillfactor`.
 * - Column `charset`/`collation` are set only when they differ from the table default
 *   (MySQL/MariaDB) or the database default (PostgreSQL).
 */

export const indexColumnSchema = z.object({
  /** Column name, or null for an expression part. */
  name: z.string().nullable(),
  expression: z.string().optional(),
  order: z.enum(['asc', 'desc']).default('asc'),
  /** MySQL prefix length, e.g. KEY (title(32)). */
  length: z.number().int().positive().optional(),
  nulls: z.enum(['first', 'last']).optional(),
  collation: z.string().optional(),
  opclass: z.string().optional(),
});
export type IndexColumn = z.infer<typeof indexColumnSchema>;

export const columnDefSchema = z.object({
  name: z.string(),
  /** 1-based position. */
  ordinal: z.number().int().positive(),
  /** Full type as the engine writes it in DDL, e.g. "varchar(255)", "numeric(10,2)", "integer[]". */
  dataType: z.string(),
  nullable: z.boolean(),
  /** Default expression text, or null when the column has no default. */
  default: z.string().nullable().default(null),
  generated: z.object({ expression: z.string(), stored: z.boolean() }).optional(),
  identity: z
    .object({
      generation: z.enum(['always', 'by-default']),
      start: z.string().optional(),
      increment: z.string().optional(),
    })
    .optional(),
  /** MySQL AUTO_INCREMENT. */
  autoIncrement: z.boolean().default(false),
  charset: z.string().optional(),
  collation: z.string().optional(),
  /** MySQL ON UPDATE CURRENT_TIMESTAMP and similar. */
  onUpdate: z.string().optional(),
  comment: z.string().optional(),
});
export type ColumnDef = z.infer<typeof columnDefSchema>;

export const keyDefSchema = z.object({
  name: z.string(),
  columns: z.array(z.string()).min(1),
});
export type KeyDef = z.infer<typeof keyDefSchema>;

export const indexDefSchema = z.object({
  name: z.string(),
  columns: z.array(indexColumnSchema).min(1),
  unique: z.boolean().default(false),
  /** btree, hash, gin, gist, brin, fulltext, spatial... */
  method: z.string().optional(),
  /** Partial index predicate. */
  where: z.string().optional(),
  include: z.array(z.string()).default([]),
  invisible: z.boolean().default(false),
  comment: z.string().optional(),
  /** Full CREATE INDEX statement as the server reports it, when available (PostgreSQL). */
  definition: z.string().optional(),
});
export type IndexDef = z.infer<typeof indexDefSchema>;

export const referentialActionSchema = z.enum([
  'NO ACTION',
  'RESTRICT',
  'CASCADE',
  'SET NULL',
  'SET DEFAULT',
]);
export type ReferentialAction = z.infer<typeof referentialActionSchema>;

export const foreignKeyDefSchema = z.object({
  name: z.string(),
  columns: z.array(z.string()).min(1),
  refSchema: z.string().optional(),
  refTable: z.string(),
  refColumns: z.array(z.string()).min(1),
  onUpdate: referentialActionSchema.default('NO ACTION'),
  onDelete: referentialActionSchema.default('NO ACTION'),
  match: z.enum(['SIMPLE', 'FULL', 'PARTIAL']).optional(),
  deferrable: z.enum(['not-deferrable', 'initially-immediate', 'initially-deferred']).optional(),
});
export type ForeignKeyDef = z.infer<typeof foreignKeyDefSchema>;

export const checkDefSchema = z.object({
  name: z.string(),
  expression: z.string(),
});
export type CheckDef = z.infer<typeof checkDefSchema>;

export const triggerDefSchema = z.object({
  name: z.string(),
  timing: z.enum(['BEFORE', 'AFTER', 'INSTEAD OF']),
  events: z.array(z.enum(['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'])).min(1),
  /** Full CREATE TRIGGER statement. */
  definition: z.string(),
});
export type TriggerDef = z.infer<typeof triggerDefSchema>;

export const partitioningSchema = z.object({
  /** RANGE, LIST, HASH, KEY. */
  method: z.string(),
  /** Partition key expression, e.g. "(created_at)" or "YEAR(created_at)". */
  key: z.string(),
  partitions: z.array(z.object({ name: z.string(), bound: z.string().optional() })).default([]),
});
export type Partitioning = z.infer<typeof partitioningSchema>;

export const tableDefSchema = z.object({
  name: z.string(),
  kind: z.enum(['table', 'partitioned', 'foreign']).default('table'),
  columns: z.array(columnDefSchema),
  primaryKey: keyDefSchema.optional(),
  uniques: z.array(keyDefSchema).default([]),
  indexes: z.array(indexDefSchema).default([]),
  foreignKeys: z.array(foreignKeyDefSchema).default([]),
  checks: z.array(checkDefSchema).default([]),
  triggers: z.array(triggerDefSchema).default([]),
  partitioning: partitioningSchema.optional(),
  /** Engine-specific table options: engine, charset, collation, tablespace, autoIncrement, row_format... */
  options: z.record(z.string(), z.string()).default({}),
  comment: z.string().optional(),
  owner: z.string().optional(),
});
export type TableDef = z.infer<typeof tableDefSchema>;

export const viewDefSchema = z.object({
  name: z.string(),
  materialized: z.boolean().default(false),
  /** The SELECT body as the server reports it. */
  definition: z.string(),
  columns: z.array(z.string()).default([]),
  checkOption: z.enum(['LOCAL', 'CASCADED']).optional(),
  /** MySQL ALGORITHM / SQL SECURITY / DEFINER, PostgreSQL security_barrier... */
  options: z.record(z.string(), z.string()).default({}),
  /** Materialised view indexes (PostgreSQL). */
  indexes: z.array(indexDefSchema).default([]),
  comment: z.string().optional(),
  owner: z.string().optional(),
});
export type ViewDef = z.infer<typeof viewDefSchema>;

export const routineDefSchema = z.object({
  name: z.string(),
  kind: z.enum(['function', 'procedure', 'aggregate']),
  /** Identity arguments, e.g. "integer, text"; distinguishes PostgreSQL overloads. */
  signature: z.string().default(''),
  returns: z.string().optional(),
  language: z.string().optional(),
  /** Full CREATE statement as the server reports it. */
  definition: z.string(),
  definer: z.string().optional(),
  comment: z.string().optional(),
  owner: z.string().optional(),
});
export type RoutineDef = z.infer<typeof routineDefSchema>;

export const sequenceDefSchema = z.object({
  name: z.string(),
  dataType: z.string().optional(),
  start: z.string(),
  increment: z.string(),
  minValue: z.string().optional(),
  maxValue: z.string().optional(),
  cache: z.string().optional(),
  cycle: z.boolean().default(false),
  /** "table.column" when the sequence is owned by a column (serial / identity). */
  ownedBy: z.string().optional(),
  owner: z.string().optional(),
});
export type SequenceDef = z.infer<typeof sequenceDefSchema>;

export const typeDefSchema = z.object({
  name: z.string(),
  kind: z.enum(['enum', 'composite', 'domain', 'range']),
  /** Enum labels in order. */
  values: z.array(z.string()).default([]),
  /** Full CREATE TYPE / CREATE DOMAIN statement. */
  definition: z.string(),
  comment: z.string().optional(),
  owner: z.string().optional(),
});
export type TypeDef = z.infer<typeof typeDefSchema>;

export const eventDefSchema = z.object({
  name: z.string(),
  /** Full CREATE EVENT statement (MySQL, MariaDB). */
  definition: z.string(),
  enabled: z.boolean().default(true),
});
export type EventDef = z.infer<typeof eventDefSchema>;

export const schemaDefSchema = z.object({
  name: z.string(),
  tables: z.array(tableDefSchema).default([]),
  views: z.array(viewDefSchema).default([]),
  routines: z.array(routineDefSchema).default([]),
  sequences: z.array(sequenceDefSchema).default([]),
  types: z.array(typeDefSchema).default([]),
  events: z.array(eventDefSchema).default([]),
  comment: z.string().optional(),
  owner: z.string().optional(),
});
export type SchemaDef = z.infer<typeof schemaDefSchema>;

export const extensionDefSchema = z.object({
  name: z.string(),
  schema: z.string().optional(),
  version: z.string().optional(),
});
export type ExtensionDef = z.infer<typeof extensionDefSchema>;

export const schemaSnapshotSchema = z.object({
  engine: engineIdSchema,
  serverVersion: z.string().optional(),
  database: z.string(),
  /** Database default charset / collation / encoding. */
  options: z.record(z.string(), z.string()).default({}),
  schemas: z.array(schemaDefSchema),
  extensions: z.array(extensionDefSchema).default([]),
  capturedAt: z.string(),
});
export type SchemaSnapshot = z.infer<typeof schemaSnapshotSchema>;

/** Kinds of objects a snapshot can hold, used to scope introspection and sync. */
export const SCHEMA_OBJECT_KINDS = [
  'table',
  'view',
  'materialized-view',
  'routine',
  'sequence',
  'type',
  'trigger',
  'event',
  'extension',
] as const;
export type SchemaObjectKind = (typeof SCHEMA_OBJECT_KINDS)[number];
