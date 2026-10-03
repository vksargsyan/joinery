import type { SchemaSnapshot, SqlEngineId, TableDef } from '@querybara/core';

import type { SyncObjectKind, SyncOperation, SyncWarning } from '../model';
import type { CompareOptions } from '../options';

/**
 * Public types of the table designer engine (spec §8, "Table designer"). The desktop form edits
 * a `TableDef`; this engine validates it, diffs it against the live table with the structure
 * sync machinery, and explains what saving will do to existing data.
 */

/**
 * Names the user changed in the designer, live name → edited name. The designer knows which
 * row was renamed, so renames are never guessed: a column missing from this map that is not in
 * the edited table is dropped, and a new name is added.
 */
export interface DesignRenames {
  readonly columns?: Readonly<Record<string, string>>;
  /** Indexes, including MySQL/MariaDB unique keys. */
  readonly indexes?: Readonly<Record<string, string>>;
  /** Primary key, unique, check and foreign key constraints. */
  readonly constraints?: Readonly<Record<string, string>>;
}

/** Switches for the save script. */
export interface DesignOptions {
  /**
   * Structure-compare options. The designer compares every attribute, including the MySQL
   * AUTO_INCREMENT counter when the edited table sets one, unless told otherwise here.
   */
  readonly compare?: CompareOptions;
  /** A comment line before each operation in `script` (default false). */
  readonly comments?: boolean;
  /**
   * MySQL/MariaDB: run the script with FOREIGN_KEY_CHECKS = 0. Off by default, so a new foreign
   * key validates existing rows the way a hand-written ALTER TABLE does.
   */
  readonly disableForeignKeyChecks?: boolean;
}

/**
 * Where the designed table lives and what surrounds it. `snapshot` is the live database from
 * the metadata cache: foreign-key targets, tables that reference this one, dependent views,
 * PostgreSQL types and sequences, database default charset/collation. Without it the designer
 * still works, but cannot check references or rebuild dependents.
 */
export interface DesignContext {
  readonly engine: SqlEngineId;
  /** Server version banner ("8.4.2", "11.4.5-MariaDB", "16.4"); the snapshot's when omitted. */
  readonly serverVersion?: string;
  /** PostgreSQL schema of the table; the database name on MySQL/MariaDB. */
  readonly schema: string;
  readonly snapshot?: SchemaSnapshot;
  readonly renames?: DesignRenames;
  readonly options?: DesignOptions;
}

/** How bad a data-loss warning is. */
export type DataLossSeverity =
  /** Saving loses or changes existing values (dropped column, truncated text). */
  | 'data-loss'
  /** Saving fails on some existing data (NULLs under NOT NULL, duplicates under UNIQUE). */
  | 'may-fail'
  /** Worth knowing, nothing is lost. */
  | 'info';

/**
 * One risk the save dialog lists (spec §8: "risky changes show a data-loss warning"). A
 * `checkQuery` returns one row with one number — the rows affected — so the dialog can show
 * the count before the user confirms; `findQuery` lists (up to 100 of) those rows. Both use the
 * live names, since they run before the save.
 */
export interface DataLossWarning {
  readonly severity: DataLossSeverity;
  readonly objectKind: SyncObjectKind;
  /** Name in the edited table (the live name for dropped objects). */
  readonly objectName: string;
  /** Designer path of the object, e.g. `columns[3]`, when it still exists in the edited table. */
  readonly path?: string;
  readonly message: string;
  readonly checkQuery?: string;
  readonly findQuery?: string;
  /** The operation that causes it, when there is one. */
  readonly operationId?: string;
}

/** A problem found before saving (spec §8: invalid combinations are flagged). */
export interface ValidationIssue {
  /** Where in the edited `TableDef`, e.g. `columns[3].dataType`, `indexes[0].columns[1]`. */
  readonly path: string;
  /** Stable identifier for tests and the UI, e.g. `unknown-type`, `duplicate-name`. */
  readonly code: string;
  readonly message: string;
  /** Errors block saving; warnings are shown next to the field. */
  readonly severity: 'error' | 'warning';
}

/** What saving the designed table will do. */
export interface TableDesign {
  /** Operations in execution order; every one is part of the save. */
  readonly operations: readonly SyncOperation[];
  /** Runnable script for the preview (PostgreSQL: one transaction). */
  readonly script: string;
  /** Plain statements for the driver, in order, without terminators. */
  readonly statements: readonly string[];
  /** Non-transactional DDL, unsupported changes, rebuilt dependents... */
  readonly warnings: readonly SyncWarning[];
  readonly dataLoss: readonly DataLossWarning[];
  /** No error-level issue: Save may run. */
  readonly valid: boolean;
  readonly issues: readonly ValidationIssue[];
  /** The script runs in one transaction (PostgreSQL). */
  readonly transactional: boolean;
  /** Nothing to save. */
  readonly unchanged: boolean;
  /**
   * The edited table as it is compared and saved: ordinals from row order, MySQL unique
   * constraints as unique indexes, PostgreSQL serial columns expanded, expressions following
   * renames, and what the server adds by itself (MySQL foreign-key indexes, MariaDB JSON checks).
   */
  readonly table: TableDef;
}
