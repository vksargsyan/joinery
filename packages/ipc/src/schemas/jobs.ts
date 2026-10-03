import { SQL_ENGINE_IDS, errorDataSchema } from '@querybara/core';
import { z } from 'zod';

import { openFileInputSchema } from './app';
import { backupJobSchema, restoreJobSchema } from './backup';
import { idSchema } from './common';
import { cellValueSchema } from './results';
import { SYNC_JOB_KINDS } from './sync';
import { transferJobSchema } from './transfer-db';

/**
 * Schemas for data transfer jobs (spec §3: the job runner; §12: import and export; §14: job
 * progress, logs and history) as they cross between the renderer and main.
 *
 * File paths are absolute paths the user picked in a native dialog; main only lets a job read
 * or write a path its window's dialogs returned. The literal lists mirror @querybara/transfer,
 * which this package cannot import (it uses Node.js streams); the desktop tests check they
 * match.
 */

export const sqlDialectSchema = z.enum(SQL_ENGINE_IDS);

/** Formats rows are read from. */
export const TRANSFER_ROW_FORMATS = [
  'csv',
  'tsv',
  'json',
  'jsonl',
  'xlsx',
  'xml',
  'parquet',
] as const;
export const transferRowFormatSchema = z.enum(TRANSFER_ROW_FORMATS);
export type TransferRowFormat = z.infer<typeof transferRowFormatSchema>;

/** Formats a preview recognises: the row formats plus SQL scripts. */
export const TRANSFER_FILE_FORMATS = [...TRANSFER_ROW_FORMATS, 'sql'] as const;
export const transferFileFormatSchema = z.enum(TRANSFER_FILE_FORMATS);
export type TransferFileFormat = z.infer<typeof transferFileFormatSchema>;

export const TRANSFER_EXPORT_FORMATS = [
  'csv',
  'tsv',
  'json',
  'jsonl',
  'xlsx',
  'xml',
  'parquet',
  'sql',
  'sql-ddl',
  'html',
  'markdown',
] as const;
export const transferExportFormatSchema = z.enum(TRANSFER_EXPORT_FORMATS);
export type TransferExportFormat = z.infer<typeof transferExportFormatSchema>;

export const IMPORT_MODES = ['append', 'update', 'upsert', 'delete', 'replace'] as const;
export const importModeSchema = z.enum(IMPORT_MODES);
export type ImportMode = z.infer<typeof importModeSchema>;

export const INFERRED_COLUMN_TYPES = [
  'boolean',
  'integer',
  'bigint',
  'decimal',
  'float',
  'date',
  'timestamp',
  'uuid',
  'json',
  'time',
  'binary',
  'text',
] as const;

export const filePathSchema = z.string().min(1).max(4096);
/** A WHATWG encoding label such as utf-8, utf-16le or windows-1252. */
const encodingSchema = z
  .string()
  .min(1)
  .max(40)
  .regex(/^[A-Za-z0-9_.:-]+$/);
const charSchema = z.string().length(1);
const countSchema = z.number().int().nonnegative();
const nameSchema = z.string().min(1).max(256);
const timestampSchema = z.iso.datetime({ offset: true });

/** CSV and TSV reading: what the preview detected, or what the user fixed. */
export const csvReadSettingsSchema = z.object({
  delimiter: charSchema.optional(),
  quote: charSchema.nullable().optional(),
  escape: charSchema.nullable().optional(),
  /** Unquoted field text that means NULL; null for none. */
  nullMarker: z.string().max(32).nullable().optional(),
  /** The first record holds the column names. */
  header: z.boolean().optional(),
});
export type CsvReadSettings = z.infer<typeof csvReadSettingsSchema>;

/** Excel: the worksheet and the row holding the column names (0: none). */
export const xlsxReadSettingsSchema = z.object({
  sheet: z.string().min(1).max(255).optional(),
  headerRow: z.number().int().min(0).max(1_048_576).optional(),
});
export type XlsxReadSettings = z.infer<typeof xlsxReadSettingsSchema>;

/** XML: the path from the root of the repeated row elements, e.g. `/orders/order`. */
export const xmlReadSettingsSchema = z.object({
  rowPath: z.string().min(1).max(4096).optional(),
});
export type XmlReadSettings = z.infer<typeof xmlReadSettingsSchema>;

export const transferPreviewInputSchema = z.object({
  path: filePathSchema,
  /** Detected from the name and content when absent. */
  format: transferFileFormatSchema.optional(),
  encoding: encodingSchema.optional(),
  csv: csvReadSettingsSchema.optional(),
  xlsx: xlsxReadSettingsSchema.optional(),
  xml: xmlReadSettingsSchema.optional(),
  sampleRows: z.number().int().min(1).max(1000).optional(),
  /** For splitting SQL files. */
  dialect: sqlDialectSchema.optional(),
});
export type TransferPreviewInput = z.input<typeof transferPreviewInputSchema>;

export const inferredColumnSchema = z.object({
  name: z.string().max(1024),
  type: z.enum(INFERRED_COLUMN_TYPES),
  nullable: z.boolean(),
  maxLength: countSchema,
  samples: countSchema,
  precision: countSchema.optional(),
  scale: countSchema.optional(),
  fractionalDigits: countSchema.optional(),
  withTimeZone: z.boolean().optional(),
  dateOrder: z.enum(['ymd', 'dmy', 'mdy']).optional(),
});
export type InferredColumnInfo = z.infer<typeof inferredColumnSchema>;

/** A file's preview (spec §12: detection, sample rows and inferred column types). */
export const transferPreviewSchema = z.object({
  format: transferFileFormatSchema,
  compression: z.enum(['gzip', 'none']),
  encoding: z.string(),
  /** The file starts with a byte order mark. */
  bom: z.boolean(),
  /** The sample is the whole file. */
  complete: z.boolean(),
  /** CSV and TSV: the dialect as detected or given. */
  csv: z
    .object({
      delimiter: z.string(),
      quote: z.string().nullable(),
      escape: z.string().nullable(),
      nullMarker: z.string().nullable(),
      header: z.boolean(),
    })
    .optional(),
  columns: z.array(inferredColumnSchema),
  /** Sample rows as display text; null is a NULL. */
  rows: z.array(z.array(z.string().nullable())),
  /** SQL files: the first statements. */
  statements: z.array(z.string()).optional(),
  /** Excel: every worksheet, and the one previewed with its header row (0: none). */
  sheets: z.array(z.string()).optional(),
  xlsx: z.object({ sheet: z.string(), headerRow: countSchema }).optional(),
  /** XML: the row path previewed, and the paths that could hold rows, best first. */
  xml: z
    .object({
      rowPath: z.string(),
      candidates: z.array(z.object({ path: z.string(), count: countSchema, fields: countSchema })),
    })
    .optional(),
  /** Parquet: rows and row groups in the whole file, its writer and page codecs. */
  parquet: z
    .object({
      rows: countSchema,
      rowGroups: countSchema,
      createdBy: z.string().max(1024).optional(),
      compressions: z.array(z.string().max(32)).max(16),
    })
    .optional(),
  /** File size in bytes. */
  size: countSchema,
});
export type TransferPreview = z.infer<typeof transferPreviewSchema>;

/** One file column feeding one table column. */
export const columnMappingSchema = z.object({
  source: z.string().min(1).max(1024),
  target: z.string().min(1).max(1024),
});
export type ColumnMappingInfo = z.infer<typeof columnMappingSchema>;

export const autoMatchInputSchema = z.object({
  sources: z.array(z.string().max(1024)).max(10_000),
  targets: z.array(z.string().max(1024)).max(10_000),
});

/**
 * A column type typed by the user for a new table: words, an optional (n) or (p,s), more words
 * and array brackets, e.g. `varchar(255)`, `numeric(10,2)`, `timestamp(3) with time zone`,
 * `int unsigned`, `text[]`. Quotes, semicolons and comments never reach the DDL.
 */
export const DATA_TYPE_PATTERN =
  /^[A-Za-z_][\w$.]*(?:\s+[A-Za-z_][\w$.]*)*(?:\s*\(\s*\d+(?:\s*,\s*-?\d+)?\s*\))?(?:\s+[A-Za-z_][\w$.]*)*(?:\s*\[\s*\d*\s*\])*$/;

export const dataTypeSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(DATA_TYPE_PATTERN, 'Enter a type such as varchar(255), numeric(10,2) or text');

/** A column of a table created from a file. */
export const newTableColumnSchema = z.object({
  /** The file column it is filled from. */
  source: z.string().min(1).max(1024),
  name: z.string().min(1).max(128),
  dataType: dataTypeSchema,
  nullable: z.boolean(),
});
export type NewTableColumn = z.infer<typeof newTableColumnSchema>;

/**
 * "Import into a new table": the inferred columns, with the user's name, type and nullability
 * edits, turned into columns and the CREATE TABLE script.
 */
export const newTablePlanInputSchema = z.object({
  dialect: sqlDialectSchema,
  name: nameSchema,
  /** PostgreSQL schema. */
  schema: z.string().max(256).optional(),
  columns: z
    .array(
      z.object({
        inferred: inferredColumnSchema,
        name: z.string().max(128).optional(),
        dataType: dataTypeSchema.optional(),
        nullable: z.boolean().optional(),
      }),
    )
    .min(1)
    .max(4096),
  /** Primary key, by file column name. */
  primaryKey: z.array(z.string()).max(64).default([]),
});
export type NewTablePlanInput = z.input<typeof newTablePlanInputSchema>;

export const newTablePlanSchema = z.object({
  columns: z.array(newTableColumnSchema),
  /** Primary key, by new column name. */
  primaryKey: z.array(z.string()),
  statements: z.array(z.string()),
});
export type NewTablePlan = z.infer<typeof newTablePlanSchema>;

// ---------------------------------------------------------------------------------------------
// Jobs

const jobBase = {
  profileId: idSchema,
  /**
   * PostgreSQL: the database the job connects to. MySQL and MariaDB: the database the job's
   * session uses, so table names resolve there.
   */
  database: z.string().max(256).optional(),
};

export const importJobSchema = z.object({
  kind: z.literal('import'),
  ...jobBase,
  file: z.object({
    path: filePathSchema,
    format: transferRowFormatSchema,
    encoding: encodingSchema.optional(),
    csv: csvReadSettingsSchema.optional(),
    xlsx: xlsxReadSettingsSchema.optional(),
    xml: xmlReadSettingsSchema.optional(),
  }),
  /** The target table; PostgreSQL schema, or none on MySQL and MariaDB. */
  table: z.object({ schema: z.string().max(256).optional(), name: nameSchema }),
  /** Create the table first, with these columns (import into a new table). */
  create: z
    .object({
      columns: z.array(newTableColumnSchema).min(1).max(4096),
      primaryKey: z.array(z.string()).max(64),
    })
    .optional(),
  mapping: z.array(columnMappingSchema).min(1).max(4096),
  mode: importModeSchema,
  /** Key columns for update, upsert and delete; default the primary key. */
  keyColumns: z.array(z.string()).max(64).optional(),
  batchSize: z.number().int().min(1).max(100_000).optional(),
  /** One transaction for the whole file (default), or one per batch. */
  transaction: z.enum(['single', 'per-batch']).optional(),
  onError: z.enum(['stop', 'skip']).optional(),
  disableForeignKeys: z.boolean().optional(),
  /**
   * The user confirmed the write: needed on production profiles and profiles that confirm
   * every write, and for replace and delete modes.
   */
  confirmed: z.boolean().optional(),
});
export type ImportJob = z.infer<typeof importJobSchema>;

export const exportCsvSettingsSchema = z.object({
  header: z.boolean().optional(),
  delimiter: charSchema.optional(),
  quote: charSchema.nullable().optional(),
  /** Text written for NULL (default: an empty field). */
  nullMarker: z.string().max(32).nullable().optional(),
  lineEnding: z.enum(['\n', '\r\n']).optional(),
});

export const exportJsonSettingsSchema = z.object({
  /** Indent objects over several lines. */
  pretty: z.boolean().optional(),
});

/** Excel: a header row (default on); decimals as exact text (default) or as numbers when exact. */
export const exportXlsxSettingsSchema = z.object({
  header: z.boolean().optional(),
  decimals: z.enum(['text', 'number']).optional(),
});

export const PARQUET_COMPRESSIONS = ['snappy', 'zstd', 'gzip', 'none'] as const;

/** Parquet: the page codec (default Snappy). */
export const exportParquetSettingsSchema = z.object({
  compression: z.enum(PARQUET_COMPRESSIONS).optional(),
});

export const exportSqlSettingsSchema = z.object({
  /** Rows per INSERT statement. */
  rowsPerStatement: z.number().int().min(1).max(10_000).optional(),
  /** SQL with DDL: DROP TABLE IF EXISTS before CREATE TABLE. */
  dropTable: z.boolean().optional(),
});

export const exportJobSchema = z.object({
  kind: z.literal('export'),
  ...jobBase,
  source: z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('tables'),
      /** PostgreSQL schema of the tables. */
      schema: z.string().max(256).optional(),
      tables: z.array(nameSchema).min(1).max(10_000),
    }),
    /** A query result, run again in the job runner. */
    z.object({
      kind: z.literal('query'),
      text: z.string().min(1).max(10_000_000),
      params: z.array(cellValueSchema).max(65_535).optional(),
    }),
  ]),
  format: transferExportFormatSchema,
  csv: exportCsvSettingsSchema.optional(),
  json: exportJsonSettingsSchema.optional(),
  sql: exportSqlSettingsSchema.optional(),
  xlsx: exportXlsxSettingsSchema.optional(),
  parquet: exportParquetSettingsSchema.optional(),
  encoding: z.enum(['utf-8', 'utf-16le']).optional(),
  bom: z.boolean().optional(),
  gzip: z.boolean().optional(),
  /** One file per table (or the query's one file) inside a ZIP archive written to `output`. */
  zip: z.boolean().optional(),
  /**
   * `file`: one file (a table, a query, several tables combined, or the ZIP archive).
   * `directory`: one file per table, named after it.
   */
  output: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('file'), path: filePathSchema }),
    z.object({ kind: z.literal('directory'), path: filePathSchema }),
  ]),
});
export type ExportJob = z.infer<typeof exportJobSchema>;

export const runSqlFileJobSchema = z.object({
  kind: z.literal('run-sql-file'),
  ...jobBase,
  path: filePathSchema,
  /** Stop at the first failing statement, or log it and continue. */
  onError: z.enum(['stop', 'continue']),
  encoding: encodingSchema.optional(),
  /** The user confirmed the run on a production profile or one that confirms every write. */
  confirmed: z.boolean().optional(),
});
export type RunSqlFileJob = z.infer<typeof runSqlFileJobSchema>;

export const jobSpecSchema = z.discriminatedUnion('kind', [
  importJobSchema,
  exportJobSchema,
  runSqlFileJobSchema,
  transferJobSchema,
  backupJobSchema,
  restoreJobSchema,
]);
export type JobSpec = z.infer<typeof jobSpecSchema>;
export type JobKind = JobSpec['kind'];

/** A running job's progress (spec §14: jobs share progress events). */
export const jobProgressSchema = z.object({
  /** What is happening now, e.g. "Connecting", "Importing", "Exporting orders". */
  phase: z.string().max(300),
  rowsRead: countSchema.optional(),
  rowsWritten: countSchema.optional(),
  rowsSkipped: countSchema.optional(),
  /** Bytes read from the file (import, SQL file) or written to it (export). */
  bytes: countSchema.optional(),
  /** Size of the file being read, for a percentage. */
  totalBytes: countSchema.optional(),
  rowsPerSecond: countSchema.optional(),
  /** SQL files: statements run and failed so far. */
  statements: countSchema.optional(),
  failed: countSchema.optional(),
  /** The table being exported. */
  table: z.string().optional(),
  elapsedMs: countSchema,
});
export type JobProgress = z.infer<typeof jobProgressSchema>;

/** A row (import) or statement (SQL file) that failed. */
export const jobRowErrorSchema = z.object({
  /** 1-based data row. */
  row: countSchema.optional(),
  /** 1-based line of the file where the row or statement starts. */
  line: countSchema.optional(),
  /** The target column that failed, when known. */
  column: z.string().optional(),
  /** Transfers: the target table (collection, key pattern) of the row. */
  table: z.string().optional(),
  /** SQL files: 1-based statement number and the column where it starts. */
  statement: countSchema.optional(),
  position: countSchema.optional(),
  message: z.string(),
  /** SQL files: the start of the statement. */
  text: z.string().optional(),
});
export type JobRowError = z.infer<typeof jobRowErrorSchema>;

export const jobStatusSchema = z.enum(['completed', 'failed', 'cancelled']);

/** How a job ended (the transfer summary). */
export const jobSummarySchema = z.object({
  status: jobStatusSchema,
  rowsRead: countSchema,
  /** Rows committed (import) or written to the file (export). */
  rowsWritten: countSchema,
  rowsSkipped: countSchema,
  rowsAffected: countSchema.optional(),
  bytesWritten: countSchema.optional(),
  statements: countSchema.optional(),
  failed: countSchema.optional(),
  durationMs: countSchema,
  /** Multi-table exports: each table's outcome. */
  tables: z
    .array(
      z.object({
        table: z.string(),
        status: jobStatusSchema,
        rowsWritten: countSchema,
        bytesWritten: countSchema.optional(),
      }),
    )
    .optional(),
  /** Files an export wrote. */
  files: z.array(z.string()).optional(),
  /** A one-line outcome for jobs the counts above do not describe (structure and data sync). */
  outcome: z.string().max(500).optional(),
});
export type JobSummary = z.infer<typeof jobSummarySchema>;

export const jobStateSchema = z.enum(['running', 'completed', 'failed', 'cancelled']);
export type JobState = z.infer<typeof jobStateSchema>;

export const jobLogEntrySchema = z.object({
  at: timestampSchema,
  level: z.enum(['info', 'warning', 'error']),
  message: z.string(),
});
export type JobLogEntry = z.infer<typeof jobLogEntrySchema>;

/** A job as the job list shows it; finished ones come from the job history. */
export const jobInfoSchema = z.object({
  id: idSchema,
  kind: z.enum([
    'import',
    'export',
    'run-sql-file',
    'transfer',
    'backup',
    'restore',
    ...SYNC_JOB_KINDS,
  ]),
  title: z.string(),
  profileId: idSchema,
  profileName: z.string(),
  state: jobStateSchema,
  /** Cancel was asked for; the job is rolling back. */
  cancelling: z.boolean(),
  createdAt: timestampSchema,
  finishedAt: timestampSchema.optional(),
  progress: jobProgressSchema.optional(),
  summary: jobSummarySchema.optional(),
  /** Why the whole job failed (could not connect, the table was not found...). */
  error: errorDataSchema.optional(),
  /** Rows or statements that failed (the first thousand). */
  errors: z.array(jobRowErrorSchema),
  log: z.array(jobLogEntrySchema),
  /** What the job works on, for the list. */
  target: z.object({
    file: z.string().optional(),
    table: z.string().optional(),
    database: z.string().optional(),
    format: z.string().optional(),
  }),
});
export type JobInfo = z.infer<typeof jobInfoSchema>;

export const jobEventSchema = z.discriminatedUnion('type', [
  /** A job started or changed state; the whole record. */
  z.object({ type: z.literal('job'), job: jobInfoSchema }),
  z.object({ type: z.literal('progress'), jobId: idSchema, progress: jobProgressSchema }),
  z.object({ type: z.literal('log'), jobId: idSchema, entry: jobLogEntrySchema }),
  /** Dropped from the history. */
  z.object({ type: z.literal('removed'), jobId: idSchema }),
]);
export type JobEvent = z.infer<typeof jobEventSchema>;

export const jobStartInputSchema = z.object({
  job: jobSpecSchema,
  /** "Ask every time" secrets for this job's connection only. */
  secrets: z.record(z.uuid(), z.string().max(65_536)).optional(),
});

// ---------------------------------------------------------------------------------------------
// Dialogs and saved wizard settings

export const saveFileInputSchema = openFileInputSchema.extend({
  /** Suggested file name (no folders). */
  defaultName: z
    .string()
    .max(255)
    .regex(/^[^\\/]*$/)
    .optional(),
});

export const openDirectoryInputSchema = z.object({ title: z.string().max(200).optional() });

/** A text file picked with `dialogs.openFile`, for `dialogs.readFile`. */
export const readFileInputSchema = z.object({ path: z.string().min(1).max(4096) });

/** The largest file `dialogs.writeFile` takes, as text or as base64 (an exported image). */
export const WRITE_FILE_LIMIT = 64 * 1024 * 1024;

/**
 * Text, or bytes as base64, for `dialogs.writeFile` to write to a path the user picked with
 * `saveFile` (an exported diagram or image).
 */
export const writeFileInputSchema = z.union([
  z.object({ path: z.string().min(1).max(4096), text: z.string().max(WRITE_FILE_LIMIT) }),
  z.object({
    path: z.string().min(1).max(4096),
    base64: z
      .string()
      .max(WRITE_FILE_LIMIT)
      .regex(/^[A-Za-z0-9+/]*={0,2}$/, 'Not base64'),
  }),
]);

/** Import wizard options worth reusing (spec §12: every wizard saves its settings). */
export const importSettingsSchema = z.object({
  format: transferRowFormatSchema.optional(),
  encoding: encodingSchema.optional(),
  csv: csvReadSettingsSchema.optional(),
  xlsx: xlsxReadSettingsSchema.optional(),
  xml: xmlReadSettingsSchema.optional(),
  mode: importModeSchema.optional(),
  batchSize: z.number().int().min(1).max(100_000).optional(),
  transaction: z.enum(['single', 'per-batch']).optional(),
  onError: z.enum(['stop', 'skip']).optional(),
  disableForeignKeys: z.boolean().optional(),
});
export type ImportSettings = z.infer<typeof importSettingsSchema>;

export const exportSettingsSchema = z.object({
  format: transferExportFormatSchema.optional(),
  csv: exportCsvSettingsSchema.optional(),
  json: exportJsonSettingsSchema.optional(),
  sql: exportSqlSettingsSchema.optional(),
  xlsx: exportXlsxSettingsSchema.optional(),
  parquet: exportParquetSettingsSchema.optional(),
  encoding: z.enum(['utf-8', 'utf-16le']).optional(),
  bom: z.boolean().optional(),
  gzip: z.boolean().optional(),
  zip: z.boolean().optional(),
  /** Several tables: one file per table or one combined file. */
  layout: z.enum(['per-table', 'combined']).optional(),
});
export type ExportSettings = z.infer<typeof exportSettingsSchema>;

const transferProfileBase = {
  id: idSchema,
  name: z.string().trim().min(1).max(100),
  updatedAt: timestampSchema,
};

/** Saved wizard settings; scheduled jobs will reuse them. File paths are never saved. */
export const transferProfileSchema = z.discriminatedUnion('kind', [
  z.object({ ...transferProfileBase, kind: z.literal('import'), settings: importSettingsSchema }),
  z.object({ ...transferProfileBase, kind: z.literal('export'), settings: exportSettingsSchema }),
]);
export type TransferProfile = z.infer<typeof transferProfileSchema>;

export const transferProfileSaveSchema = z.discriminatedUnion('kind', [
  z.object({
    id: idSchema.optional(),
    name: transferProfileBase.name,
    kind: z.literal('import'),
    settings: importSettingsSchema,
  }),
  z.object({
    id: idSchema.optional(),
    name: transferProfileBase.name,
    kind: z.literal('export'),
    settings: exportSettingsSchema,
  }),
]);
