import { SQL_ENGINE_IDS, engineIdSchema } from '@querybara/core';
import type {
  CompareOptions,
  DiffSummary,
  OperationKind,
  RenameObjectKind,
  RenameRule,
  ResolvedCompareOptions,
  SchemaDiff,
  SyncObjectKind,
  SyncOperation,
  SyncWarning,
  WarningCode,
} from '@querybara/sync';
import { z } from 'zod';

import { idSchema } from './common';

/**
 * Schemas for structure sync and data sync in the desktop app (spec §13) as they cross between
 * the renderer and main. Comparisons, scripts and applies run as jobs in the job runner; the
 * renderer starts them by naming two connections, reads their results here, and never sees a
 * driver or a schema snapshot. The structure diff mirrors `@querybara/sync`'s model (checked
 * with `satisfies`); the renderer ticks operations with that package's selection helpers.
 *
 * Data compare rows cross as display text (`null` is SQL NULL), paged from files the job runner
 * spooled, so a large diff is never held in memory.
 */

const countSchema = z.number().int().nonnegative();
/** A database, schema, table or column name. */
const nameSchema = z.string().min(1).max(256);
const filePathSchema = z.string().min(1).max(4096);
const timestampSchema = z.iso.datetime({ offset: true });
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);

/** "Ask every time" secrets for either connection of a comparison, by SecretRef id. */
const oneCallSecretsSchema = z.record(z.uuid(), z.string().max(65_536));

/** The job kinds sync adds to the job runner (spec §3, §14). */
export const SYNC_JOB_KINDS = [
  'structure-compare',
  'structure-apply',
  'data-compare',
  'data-apply',
] as const;
export type SyncJobKind = (typeof SYNC_JOB_KINDS)[number];

export function isSyncJobKind(kind: string): kind is SyncJobKind {
  return (SYNC_JOB_KINDS as readonly string[]).includes(kind);
}

/**
 * One side of a comparison. PostgreSQL: `database` is the database the job connects to and
 * `schemas` narrows the compare (every non-system schema when absent or empty; schemas pair by
 * name). MySQL and MariaDB: `database` is the database compared. The connection's default
 * database when absent.
 */
export const syncSideSchema = z.object({
  profileId: idSchema,
  database: nameSchema.optional(),
  schemas: z.array(nameSchema).max(1000).optional(),
});
export type SyncSide = z.infer<typeof syncSideSchema>;

// ---------------------------------------------------------------------------------------------
// Structure compare

export const RENAME_OBJECT_KINDS = [
  'table',
  'column',
  'index',
  'constraint',
  'view',
] as const satisfies readonly RenameObjectKind[];

/** A rename mapping (spec §13, step 3): `from` is the target's name, `to` the source's. */
export const renameRuleSchema = z.object({
  objectKind: z.enum(RENAME_OBJECT_KINDS),
  schema: nameSchema.optional(),
  table: nameSchema.optional(),
  from: nameSchema,
  to: nameSchema,
}) satisfies z.ZodType<RenameRule>;
export type RenameRuleInfo = z.infer<typeof renameRuleSchema>;

/** The §13 options; every flag left out takes the engine's default. */
export const structureCompareOptionsSchema = z.object({
  ignoreComments: z.boolean().optional(),
  ignoreCollation: z.boolean().optional(),
  ignoreAutoIncrement: z.boolean().optional(),
  ignoreDefiner: z.boolean().optional(),
  ignoreOwnership: z.boolean().optional(),
  ignorePrivileges: z.boolean().optional(),
  ignorePartitions: z.boolean().optional(),
  ignoreColumnOrder: z.boolean().optional(),
  ignoreNameCase: z.boolean().optional(),
  ignoreNames: z.boolean().optional(),
  ignoreExtensionVersions: z.boolean().optional(),
  detectRenames: z.boolean().optional(),
  renames: z.array(renameRuleSchema).max(1000).optional(),
}) satisfies z.ZodType<CompareOptions>;
export type StructureCompareOptions = z.infer<typeof structureCompareOptionsSchema>;

const resolvedCompareOptionsSchema = z.object({
  ignoreComments: z.boolean(),
  ignoreCollation: z.boolean(),
  ignoreAutoIncrement: z.boolean(),
  ignoreDefiner: z.boolean(),
  ignoreOwnership: z.boolean(),
  ignorePrivileges: z.boolean(),
  ignorePartitions: z.boolean(),
  ignoreColumnOrder: z.boolean(),
  ignoreNameCase: z.boolean(),
  ignoreNames: z.boolean(),
  ignoreExtensionVersions: z.boolean(),
  detectRenames: z.boolean(),
  renames: z.array(renameRuleSchema),
}) satisfies z.ZodType<ResolvedCompareOptions>;

export const SYNC_OBJECT_KINDS = [
  'schema',
  'extension',
  'type',
  'sequence',
  'table',
  'column',
  'primary-key',
  'unique',
  'index',
  'foreign-key',
  'check',
  'trigger',
  'partition',
  'view',
  'materialized-view',
  'routine',
  'event',
] as const satisfies readonly SyncObjectKind[];

export const OPERATION_KINDS = [
  'create',
  'alter',
  'drop',
  'rename',
] as const satisfies readonly OperationKind[];

export const SYNC_WARNING_CODES = [
  'data-loss',
  'may-fail',
  'unsupported',
  'rebuild',
  'cross-family',
  'non-transactional',
  'missing-dependency',
  'info',
] as const satisfies readonly WarningCode[];

export const syncWarningSchema = z.object({
  code: z.enum(SYNC_WARNING_CODES),
  message: z.string(),
}) satisfies z.ZodType<SyncWarning>;

const operationStepSchema = z.object({
  phase: z.number(),
  statements: z.array(z.string()),
  preTransaction: z.boolean().optional(),
});

/** One tickable operation of a structure comparison (spec §13, steps 4-5). */
export const syncOperationSchema = z.object({
  id: z.string(),
  kind: z.enum(OPERATION_KINDS),
  objectKind: z.enum(SYNC_OBJECT_KINDS),
  name: z.string(),
  qualifiedName: z.string(),
  parent: z.string().optional(),
  schema: z.string().optional(),
  statements: z.array(z.string()),
  sourceDdl: z.string().optional(),
  targetDdl: z.string().optional(),
  destructive: z.boolean(),
  selected: z.boolean(),
  dependsOn: z.array(z.string()),
  warnings: z.array(syncWarningSchema),
  changes: z.array(z.string()),
  reason: z.string().optional(),
  steps: z.array(operationStepSchema),
}) satisfies z.ZodType<SyncOperation>;
export type SyncOperationInfo = z.infer<typeof syncOperationSchema>;

const diffFields = {
  sourceEngine: engineIdSchema,
  targetEngine: engineIdSchema,
  dialect: z.enum(SQL_ENGINE_IDS),
  sourceDatabase: z.string(),
  targetDatabase: z.string(),
  operations: z.array(syncOperationSchema),
  warnings: z.array(syncWarningSchema),
  options: resolvedCompareOptionsSchema,
  identical: z.boolean(),
};

/**
 * A whole structure diff, as main hands it to the job runner for script generation and apply.
 * `order` (the step order) is a list of `[operation, step]` index pairs.
 */
export const schemaDiffSchema = z.object({
  ...diffFields,
  order: z.array(z.tuple([countSchema, countSchema])),
}) satisfies z.ZodType<SchemaDiff>;

/**
 * The diff as the renderer sees it: everything but the step order, which only script
 * generation needs, and that runs in the job runner.
 */
export const comparedDiffSchema = z.object(diffFields);
export type ComparedDiff = z.infer<typeof comparedDiffSchema>;

export const diffSummarySchema = z.object({
  total: countSchema,
  create: countSchema,
  alter: countSchema,
  drop: countSchema,
  rename: countSchema,
  destructive: countSchema,
  selected: countSchema,
  byObjectKind: z.partialRecord(z.enum(SYNC_OBJECT_KINDS), countSchema),
}) satisfies z.ZodType<DiffSummary>;

/** Who a comparison side turned out to be, for headers, reports and the job list. */
export const syncSideInfoSchema = z.object({
  profileId: idSchema,
  profileName: z.string(),
  engine: engineIdSchema,
  serverVersion: z.string(),
  database: z.string(),
  schemas: z.array(z.string()).optional(),
});
export type SyncSideInfo = z.infer<typeof syncSideInfoSchema>;

/** A deployment script for one selection, generated in the job runner (spec §13, step 7). */
export const structureScriptSchema = z.object({
  /** The runnable script: terminators, comments and MySQL DELIMITER blocks. */
  text: z.string(),
  statementCount: countSchema,
  operationCount: countSchema,
  /** PostgreSQL: one transaction. */
  transactional: z.boolean(),
  /** MySQL and MariaDB DDL is not transactional: back up first (spec §13). */
  backupRecommended: z.boolean(),
  warnings: z.array(syncWarningSchema),
  /** Selected operations whose dependencies are not selected. */
  missingDependencies: z.array(z.object({ operationId: z.string(), missing: z.array(z.string()) })),
  /** SHA-256 of `text`: an apply runs only the script the user confirmed. */
  sha256: sha256Schema,
});
export type StructureScript = z.infer<typeof structureScriptSchema>;

/** A finished structure compare, or an apply with its automatic re-compare (step 8). */
export const structureResultSchema = z.object({
  jobId: idSchema,
  source: syncSideInfoSchema,
  target: syncSideInfoSchema,
  diff: comparedDiffSchema,
  summary: diffSummarySchema,
  /** The script for the operations selected by default. */
  script: structureScriptSchema,
  /** Present on an apply's result; `diff` is then the re-compare. */
  applied: z
    .object({
      statements: countSchema,
      operations: z.array(z.string()),
      durationMs: countSchema,
      /** Applied operations the re-compare still finds: the target did not converge. */
      unconverged: z.array(z.string()),
    })
    .optional(),
});
export type StructureResult = z.infer<typeof structureResultSchema>;

export const structureCompareInputSchema = z.object({
  source: syncSideSchema,
  target: syncSideSchema,
  options: structureCompareOptionsSchema,
  secrets: oneCallSecretsSchema.optional(),
});
export type StructureCompareInput = z.infer<typeof structureCompareInputSchema>;

/** The operations to include, by id, of a finished compare (or apply) job. */
export const structureSelectionSchema = z.object({
  jobId: idSchema,
  selected: z.array(z.string().max(4096)).max(100_000),
});
export type StructureSelection = z.infer<typeof structureSelectionSchema>;

export const structureApplyInputSchema = structureSelectionSchema.extend({
  /** `sha256` of the script the user reviewed; the job refuses any other script. */
  scriptSha256: sha256Schema,
  /** The user confirmed: needed on production profiles and ones that confirm every write. */
  confirmed: z.boolean().optional(),
  secrets: oneCallSecretsSchema.optional(),
});
export type StructureApplyInput = z.infer<typeof structureApplyInputSchema>;

export const structureExportInputSchema = structureSelectionSchema.extend({
  /** The deployment script, or the HTML report (spec §13). */
  format: z.enum(['sql', 'html']),
  /** A path this window picked with `dialogs.saveFile`. */
  path: filePathSchema,
});
export type StructureExportInput = z.infer<typeof structureExportInputSchema>;

// ---------------------------------------------------------------------------------------------
// Data compare

export const DATA_ROW_ACTIONS = ['insert', 'update', 'delete'] as const;
export const dataRowActionSchema = z.enum(DATA_ROW_ACTIONS);
export type DataRowAction = z.infer<typeof dataRowActionSchema>;

export const dataActionsSchema = z.object({
  insert: z.boolean(),
  update: z.boolean(),
  delete: z.boolean(),
});
export type DataActions = z.infer<typeof dataActionsSchema>;

/** Data compare options (spec §13, "Data sync algorithm"). */
export const dataCompareOptionsSchema = z.object({
  /** Which differences the sync script and apply act on. */
  actions: dataActionsSchema,
  /** Columns never compared or written, in every table. */
  ignoreColumns: z.array(nameSchema).max(1000).optional(),
  /** Absolute tolerance for floating-point columns. */
  floatTolerance: z.number().nonnegative().max(1e15).optional(),
  trim: z.enum(['none', 'trailing', 'both']).optional(),
  caseInsensitive: z.boolean().optional(),
  /** MySQL: FOREIGN_KEY_CHECKS = 0; PostgreSQL: session_replication_role (superuser). */
  disableForeignKeyChecks: z.boolean().optional(),
  /** PostgreSQL: disable user triggers on each table while applying (needs ownership). */
  disableTriggers: z.boolean().optional(),
});
export type DataCompareOptions = z.infer<typeof dataCompareOptionsSchema>;

/** A table to compare (by pair name, `schema.table` on PostgreSQL), with its column subset. */
export const dataTableSettingsSchema = z.object({
  name: z.string().min(1).max(600),
  /** Compare only these columns besides the key; every common column when absent. */
  columns: z.array(nameSchema).max(4096).optional(),
});
export type DataTableSettings = z.infer<typeof dataTableSettingsSchema>;

export const dataCompareInputSchema = z.object({
  source: syncSideSchema,
  target: syncSideSchema,
  options: dataCompareOptionsSchema,
  /** Only these tables; every pairable table when absent. */
  tables: z.array(dataTableSettingsSchema).max(10_000).optional(),
  secrets: oneCallSecretsSchema.optional(),
});
export type DataCompareInput = z.infer<typeof dataCompareInputSchema>;

const tableRefSchema = z.object({ schema: z.string().optional(), name: z.string() });

export const dataCountsSchema = z.object({
  inserts: countSchema,
  updates: countSchema,
  deletes: countSchema,
  /** Keys whose compared values match. */
  equal: countSchema,
  sourceRows: countSchema,
  targetRows: countSchema,
});
export type DataCounts = z.infer<typeof dataCountsSchema>;

const perActionSchema = z.object({ insert: countSchema, update: countSchema, delete: countSchema });

/** One compared table (spec §13, data sync step 6). */
export const dataTableResultSchema = z.object({
  index: countSchema,
  name: z.string(),
  source: tableRefSchema,
  target: tableRefSchema,
  keyColumns: z.array(z.string()),
  /** Columns both sides have, key included: what the column subset picks from. */
  commonColumns: z.array(z.string()),
  /** Non-key columns compared. */
  compared: z.array(z.string()),
  /** The row grid's columns: the key columns, then the compared ones. */
  columns: z.array(z.string()),
  counts: dataCountsSchema,
  /** Checksums ran on the servers; ranges that matched never left them. */
  checksums: z.boolean(),
  ranges: countSchema,
  matchedRanges: countSchema,
  /** Row differences kept for the grid, per action (the first ones of a large diff). */
  stored: perActionSchema,
  /** Sync statements spooled per action. */
  statements: perActionSchema,
  /** Why this table's compare failed; the other tables still compared. */
  error: z.string().optional(),
  durationMs: countSchema,
});
export type DataTableResult = z.infer<typeof dataTableResultSchema>;

export const dataResultSchema = z.object({
  jobId: idSchema,
  source: syncSideInfoSchema,
  target: syncSideInfoSchema,
  options: dataCompareOptionsSchema,
  tables: z.array(dataTableResultSchema),
  /** Tables left out, and why (no shared key, only on one side...). */
  skipped: z.array(z.object({ name: z.string(), reason: z.string() })),
  /** Rows per page of `data.rows`. */
  pageSize: countSchema,
});
export type DataResult = z.infer<typeof dataResultSchema>;

/** Cells as display text; `null` is SQL NULL. */
const displayCellsSchema = z.array(z.string().nullable());

/** One row difference in the grid's column order (`DataTableResult.columns`). */
export const dataRowDiffSchema = z.object({
  action: dataRowActionSchema,
  /** Values of the key columns. */
  key: displayCellsSchema,
  /** The source row (inserts and updates). */
  source: displayCellsSchema.optional(),
  /** The target row (updates and deletes). */
  target: displayCellsSchema.optional(),
  /** Updates: the columns whose values differ. */
  changed: z.array(z.string()).optional(),
});
export type DataRowDiff = z.infer<typeof dataRowDiffSchema>;

export const dataRowsInputSchema = z.object({
  jobId: idSchema,
  table: countSchema,
  action: dataRowActionSchema,
  page: countSchema,
});

export const dataRowPageSchema = z.object({
  rows: z.array(dataRowDiffSchema),
  page: countSchema,
  pageCount: countSchema,
  /** Rows kept for this table and action. */
  total: countSchema,
});
export type DataRowPage = z.infer<typeof dataRowPageSchema>;

/** Tables (by `DataTableResult.index`) and actions of a finished data compare. */
export const dataSelectionSchema = z.object({
  jobId: idSchema,
  tables: z.array(countSchema).min(1).max(10_000),
  actions: dataActionsSchema,
});
export type DataSelection = z.infer<typeof dataSelectionSchema>;

/** The start of a data sync script, for the review before applying it. */
export const dataScriptPreviewSchema = z.object({
  statements: z.array(z.string()),
  /** Statements the script has in all. */
  total: countSchema,
  truncated: z.boolean(),
});
export type DataScriptPreview = z.infer<typeof dataScriptPreviewSchema>;

export const dataApplyInputSchema = dataSelectionSchema.extend({
  /** The user confirmed: needed on production profiles and ones that confirm every write. */
  confirmed: z.boolean().optional(),
  secrets: oneCallSecretsSchema.optional(),
});
export type DataApplyInput = z.infer<typeof dataApplyInputSchema>;

export const dataExportInputSchema = dataSelectionSchema.extend({ path: filePathSchema });
export type DataExportInput = z.infer<typeof dataExportInputSchema>;

// ---------------------------------------------------------------------------------------------
// Saved comparisons

export const COMPARISON_KINDS = ['structure', 'data'] as const;
export const comparisonKindSchema = z.enum(COMPARISON_KINDS);
export type ComparisonKind = z.infer<typeof comparisonKindSchema>;

const savedSideSchema = z.object({
  /** Null once the connection was deleted: pick another before comparing. */
  profileId: idSchema.nullable(),
  database: nameSchema.optional(),
  schemas: z.array(nameSchema).max(1000).optional(),
});

export const dataComparisonSettingsSchema = z.object({
  options: dataCompareOptionsSchema,
  tables: z.array(dataTableSettingsSchema).max(10_000).optional(),
});
export type DataComparisonSettings = z.infer<typeof dataComparisonSettingsSchema>;

/**
 * What a saved comparison stores besides its name, kind and connections: the databases and
 * schemas, and the options (with rename mapping) or the data settings. Stored as JSON.
 */
export const comparisonDefinitionSchema = z.object({
  source: savedSideSchema.omit({ profileId: true }),
  target: savedSideSchema.omit({ profileId: true }),
  structure: structureCompareOptionsSchema.optional(),
  data: dataComparisonSettingsSchema.optional(),
});
export type ComparisonDefinition = z.infer<typeof comparisonDefinitionSchema>;

/** A saved comparison (spec §13: comparisons save as profiles). */
export const savedComparisonSchema = z.object({
  id: idSchema,
  name: z.string(),
  kind: comparisonKindSchema,
  source: savedSideSchema,
  target: savedSideSchema,
  structure: structureCompareOptionsSchema.optional(),
  data: dataComparisonSettingsSchema.optional(),
  version: z.number().int().positive(),
  updatedAt: timestampSchema,
});
export type SavedComparison = z.infer<typeof savedComparisonSchema>;

export const savedComparisonSaveSchema = z.object({
  /** Replaces this saved comparison; a new one when absent. */
  id: idSchema.optional(),
  name: z.string().trim().min(1).max(200),
  kind: comparisonKindSchema,
  source: syncSideSchema,
  target: syncSideSchema,
  structure: structureCompareOptionsSchema.optional(),
  data: dataComparisonSettingsSchema.optional(),
  expectedVersion: z.number().int().nonnegative().optional(),
});
export type SavedComparisonSave = z.infer<typeof savedComparisonSaveSchema>;
