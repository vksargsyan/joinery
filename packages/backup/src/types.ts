import type { ErrorData } from '@querybara/core';
import type { Sink } from '@querybara/transfer';

import type { ArchiveEncryption } from './archive/writer';
import type { BackupObjectKind, Manifest } from './archive/manifest';

/**
 * Options, progress and outcomes shared by every engine's backup and restore. Backups and
 * restores run in the job runner (spec §14: they share its progress events, logs and
 * notifications) and in querybara-cli, so everything here is plain data and callbacks.
 */

/** Output formats. `sql` and `sql-gz` are SQL engines only; `qbak` is every engine's archive. */
export const BACKUP_FORMATS = ['sql', 'sql-gz', 'qbak'] as const;
export type BackupFormat = (typeof BACKUP_FORMATS)[number];

export type LogLevel = 'info' | 'warning' | 'error';
export type Logger = (level: LogLevel, message: string) => void;

/** An object named in a selection. Routines match every overload of the name. */
export interface ObjectRef {
  readonly kind: BackupObjectKind;
  /** PostgreSQL schema. */
  readonly schema?: string;
  readonly name: string;
}

/**
 * What to back up. Without `include`, everything in scope; with it, those objects plus what
 * they need (a view's tables, a column's type...), and each table's keys and triggers.
 * `exclude` leaves objects out, and with them whatever cannot exist without them.
 */
export interface BackupSelection {
  /** PostgreSQL schemas (default: every non-system schema). */
  readonly schemas?: readonly string[];
  readonly include?: readonly ObjectRef[];
  readonly exclude?: readonly ObjectRef[];
  /** Tables backed up as structure only. */
  readonly excludeData?: readonly ObjectRef[];
}

export interface BackupProgress {
  /** What is happening, e.g. "Reading the structure", "Backing up data". */
  readonly phase: string;
  /** The object being written. */
  readonly object?: string;
  readonly objectsDone: number;
  readonly objectsTotal: number;
  /** Rows (SQL), documents (MongoDB) or keys (Redis) so far. */
  readonly rows: number;
  /** Bytes written to the output. */
  readonly bytes: number;
  readonly elapsedMs: number;
}

/** Options every engine's backup takes. */
export interface BackupCommonOptions {
  /** Where the backup goes; a file sink removes its partial file when the backup fails. */
  readonly output: Sink;
  readonly format: BackupFormat;
  /** Archives: gzip each file inside (default true). */
  readonly compress?: boolean;
  /** Archives: encrypt with this passphrase (AES-256-GCM, scrypt). */
  readonly encryption?: ArchiveEncryption;
  /** Written into the manifest, e.g. "Querybara 0.1.0". */
  readonly producer?: string;
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: BackupProgress) => void;
  readonly onLog?: Logger;
  /** Minimum time between progress events (default 250 ms). */
  readonly progressIntervalMs?: number;
}

export type TransferStatus = 'completed' | 'failed' | 'cancelled';

export interface BackupSummary {
  readonly status: TransferStatus;
  readonly format: BackupFormat | 'custom';
  /** Objects written. */
  readonly objects: number;
  /** Tables, collections or key sets with data. */
  readonly dataObjects: number;
  /** Rows, documents or keys. */
  readonly rows: number;
  readonly bytesWritten: number;
  readonly durationMs: number;
  readonly warnings: readonly string[];
  /** Why the backup failed. */
  readonly error?: ErrorData;
  /** Archives: the manifest as written. */
  readonly manifest?: Manifest;
}

export interface RestoreProgress {
  readonly phase: string;
  readonly object?: string;
  readonly objectsDone: number;
  readonly objectsTotal: number;
  readonly rows: number;
  readonly statements: number;
  readonly failed: number;
  /** Bytes of the backup read so far. */
  readonly bytes: number;
  readonly totalBytes?: number;
  readonly elapsedMs: number;
}

/** A statement (or document batch, or key) that failed during a restore. */
export interface RestoreError {
  /** The object it belongs to. */
  readonly object?: string;
  /** 1-based statement number in the run. */
  readonly statement?: number;
  /** 1-based line of a plain SQL file. */
  readonly line?: number;
  readonly message: string;
  /** The start of the statement. */
  readonly text?: string;
}

export interface RestoreSummary {
  readonly status: TransferStatus;
  readonly objects: number;
  readonly rows: number;
  readonly statements: number;
  readonly failed: number;
  readonly errors: readonly RestoreError[];
  readonly warnings: readonly string[];
  readonly durationMs: number;
  /** Why the whole restore failed (not a single statement). */
  readonly error?: ErrorData;
}

/** Options every engine's restore takes. */
export interface RestoreCommonOptions {
  /** Stop at the first failure (default) or log it and continue. */
  readonly onError?: 'stop' | 'continue';
  /** Failures kept in the summary (default 1000). */
  readonly errorLogLimit?: number;
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: RestoreProgress) => void;
  readonly onLog?: Logger;
  readonly progressIntervalMs?: number;
}

/** What a restore would do to existing objects, for the confirmation. */
export interface RestoreConflict {
  /** The backup object that clashes (`database` for a whole script run over a database). */
  readonly id: string;
  readonly kind: BackupObjectKind | 'database';
  readonly qualifiedName: string;
  /**
   * `drop`: the existing object is dropped first; `append`: rows are added to it; `overwrite`:
   * existing keys are replaced, or a script runs over objects that exist.
   */
  readonly action: 'drop' | 'append' | 'overwrite';
}
