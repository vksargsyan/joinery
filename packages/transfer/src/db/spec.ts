import type { EngineId, Session } from '@joinery/core';

import type { RowError, TransferStatus } from '../types';

/**
 * Data transfer between databases (spec §12, "Data transfer between databases"): what a
 * transfer is asked to do (`DbTransferSpec`), what it will do (`TransferPlan`, shown in the
 * wizard's mapping and review steps), and what it did (`DbTransferSummary`). Everything here
 * is plain data that survives structured clone, so the same shapes travel from the job runner
 * to the renderer and the CLI prints them.
 */

/** What happens to a target table or collection before the data goes in. */
export const DB_TABLE_MODES = ['create', 'drop-create', 'truncate', 'append'] as const;
/**
 * `create`: create it (refused when it exists). `drop-create`: drop it when it exists, then
 * create it. `truncate`: empty it (create it when missing). `append`: insert into it by
 * matching column names (create it when missing).
 */
export type DbTableMode = (typeof DB_TABLE_MODES)[number];

/**
 * How a MongoDB sub-document or array field lands in a SQL table: `columns` flattens a
 * sub-document into one column per field, `json` keeps the value as a JSON column, `child`
 * turns an array into a child table with a parent key.
 */
export const FIELD_SHAPES = ['columns', 'json', 'child'] as const;
export type FieldShape = (typeof FIELD_SHAPES)[number];

/** What the user changed about one source column (or MongoDB field path). */
export interface ColumnOverride {
  /** Source column name, or MongoDB field path (`address.city`, `items[].sku`). */
  readonly source: string;
  /** Target column (or field) name. */
  readonly target?: string;
  /** Target type: a SQL column type, or a BSON type name for MongoDB targets. */
  readonly dataType?: string;
  /** Leave the column out. */
  readonly skip?: boolean;
  /** MongoDB → SQL: how a sub-document or array field lands. */
  readonly shape?: FieldShape;
}

/** SQL → MongoDB: child rows embedded in each parent document as an array of sub-documents. */
export interface EmbedSpec {
  /** The child table. */
  readonly table: string;
  /** The child table's foreign key (by name) that references the parent table. */
  readonly foreignKey: string;
  /** The parent document field holding the array (default: the child table name). */
  readonly field?: string;
}

/** One source table or collection. */
export interface TransferObjectSpec {
  readonly name: string;
  /** Target table or collection name (default: the source name). */
  readonly target?: string;
  /** Overrides the transfer's mode for this object. */
  readonly mode?: DbTableMode;
  readonly columns?: readonly ColumnOverride[];
  readonly embed?: readonly EmbedSpec[];
}

export interface DbTransferOptions {
  readonly mode: DbTableMode;
  /** Rows (documents, keys) per batch. */
  readonly batchSize: number;
  /** Commit every batch in its own transaction (SQL targets); otherwise statements autocommit. */
  readonly transactionPerBatch: boolean;
  /** `skip` logs failing rows and goes on; `stop` ends the transfer at the first one. */
  readonly onError: 'stop' | 'skip';
  /**
   * Switch foreign key checks and triggers off while loading, where the engine allows:
   * MySQL/MariaDB `foreign_key_checks = 0` (triggers cannot be switched off), PostgreSQL
   * `session_replication_role = replica` (needs a superuser). Restored afterwards.
   */
  readonly disableConstraints: boolean;
  /** Tables transferred at the same time, each on its own pair of sessions. */
  readonly parallel: number;
  /** Create primary keys (PostgreSQL), indexes and foreign keys after the data, for speed. */
  readonly deferConstraints: boolean;
  /** Move identity sequences and AUTO_INCREMENT counters past the copied values. */
  readonly resetSequences: boolean;
  /** MongoDB → SQL: documents sampled to infer columns and types. */
  readonly sampleSize: number;
  /** SQL → MongoDB: a single-column primary key becomes `_id`. */
  readonly idFromPrimaryKey: boolean;
  /** Redis: overwrite keys that exist on the target (RESTORE ... REPLACE). */
  readonly replace: boolean;
  /** Redis: keep each key's time to live. */
  readonly keepTtl: boolean;
}

export const DEFAULT_DB_TRANSFER_OPTIONS: DbTransferOptions = {
  mode: 'create',
  batchSize: 1000,
  transactionPerBatch: true,
  onError: 'stop',
  disableConstraints: false,
  parallel: 2,
  deferConstraints: true,
  resetSequences: true,
  sampleSize: 1000,
  idFromPrimaryKey: true,
  replace: false,
  keepTtl: true,
};

/**
 * A transfer between two connections. The sessions say which servers; `database` and
 * `schema` say where on them: the PostgreSQL schema of the tables, the MongoDB database of the
 * collections. MySQL and MariaDB use the session's database; Redis the session's logical
 * database.
 */
export interface DbTransferSpec {
  readonly source: { readonly database?: string; readonly schema?: string };
  readonly target: { readonly database?: string; readonly schema?: string };
  /** Tables (SQL sources) or collections (MongoDB sources). */
  readonly objects: readonly TransferObjectSpec[];
  /** Redis sources: glob patterns of the keys to copy. */
  readonly keyPatterns?: readonly string[];
  readonly options?: Partial<DbTransferOptions>;
}

// ---------------------------------------------------------------------------------------------
// The plan

/** One target column (or document field) and where it comes from. */
export interface PlannedColumn {
  /** Source column, or MongoDB field path. */
  readonly source: string;
  readonly target: string;
  /** The source's type: SQL type text, or the BSON types seen (`int|long`). */
  readonly sourceType: string;
  /** The type the target gets (the mapping table's, or the user's). */
  readonly targetType: string;
  /** What the engine pair's mapping table picked. */
  readonly defaultType: string;
  readonly nullable: boolean;
  /** Part of the target's primary key (or `_id`). */
  readonly key: boolean;
  /** The type can be changed (false when appending into an existing table). */
  readonly editable: boolean;
  /** Left out by the user. */
  readonly skipped: boolean;
  /** MongoDB sub-documents and arrays: how the field lands. */
  readonly shape?: FieldShape;
  /** Why the mapping is what it is, or what to watch out for. */
  readonly note?: string;
}

export type PlannedAction = DbTableMode;

/** One target table, collection or key space. */
export interface PlannedTable {
  /** Source table, collection, `collection.field` for a child table, or a key pattern. */
  readonly source: string;
  readonly target: string;
  readonly kind: 'table' | 'child-table' | 'collection' | 'keys';
  /** Child tables: the target table they reference. */
  readonly parent?: string;
  readonly action: PlannedAction;
  /** The target exists now. */
  readonly exists: boolean;
  /** Rows (documents, keys) in the source, as the server estimates them. */
  readonly rows?: number;
  readonly columns: readonly PlannedColumn[];
  /** SQL → MongoDB: child tables embedded as arrays. */
  readonly embeds?: readonly {
    readonly table: string;
    readonly field: string;
    readonly foreignKey: string;
  }[];
  /** Why this table cannot be transferred as asked. */
  readonly problems: readonly string[];
  readonly warnings: readonly string[];
}

export interface TransferPlan {
  readonly sourceEngine: EngineId;
  readonly targetEngine: EngineId;
  readonly sourceVersion: string;
  readonly targetVersion: string;
  readonly tables: readonly PlannedTable[];
  /** Statements (or commands) run on the target before the data: drops, creates, truncates. */
  readonly before: readonly string[];
  /** Run after the data: keys, indexes, foreign keys, sequence resets. */
  readonly after: readonly string[];
  /** What is destroyed, in words ("Drop table orders (it exists)"), for the confirmation. */
  readonly destructive: readonly string[];
  /** What is created, in words. */
  readonly creates: readonly string[];
  /** Problems that stop the transfer (listed per table too). */
  readonly problems: readonly string[];
  readonly warnings: readonly string[];
}

// ---------------------------------------------------------------------------------------------
// Running

/** A session opened for a transfer and how to close it (with its tunnel, if any). */
export interface OpenedSession {
  readonly session: Session;
  close(): Promise<void>;
}

/** Opens another session on one side of the transfer (same server, database and tunnel). */
export type SessionOpener = () => Promise<OpenedSession>;

export interface DbTransferProgress {
  readonly phase: string;
  readonly tables: number;
  readonly tablesDone: number;
  /** Tables being transferred now. */
  readonly current: readonly string[];
  readonly rowsRead: number;
  readonly rowsWritten: number;
  readonly rowsSkipped: number;
  readonly elapsedMs: number;
  readonly rowsPerSecond: number;
}

/** A failed row, statement or table, with the table it belongs to. */
export interface DbTransferError extends RowError {
  readonly table?: string;
}

export interface DbTransferTableSummary {
  readonly source: string;
  readonly target: string;
  readonly status: TransferStatus;
  readonly rowsRead: number;
  readonly rowsWritten: number;
  readonly rowsSkipped: number;
  readonly durationMs: number;
}

export interface DbTransferSummary {
  readonly status: TransferStatus;
  readonly rowsRead: number;
  readonly rowsWritten: number;
  readonly rowsSkipped: number;
  readonly durationMs: number;
  readonly tables: readonly DbTransferTableSummary[];
  /** Failed rows (the first `errorLogLimit`), and statements after the data that failed. */
  readonly errors: readonly DbTransferError[];
}

/** Resolves the options with their defaults, clamped to sane bounds. */
export function resolveOptions(options: Partial<DbTransferOptions> | undefined): DbTransferOptions {
  const merged = { ...DEFAULT_DB_TRANSFER_OPTIONS, ...stripUndefined(options ?? {}) };
  return {
    ...merged,
    batchSize: clamp(merged.batchSize, 1, 100_000),
    parallel: clamp(merged.parallel, 1, 16),
    sampleSize: clamp(merged.sampleSize, 1, 100_000),
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.floor(Number.isFinite(value) ? value : min)));
}

function stripUndefined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;
}
