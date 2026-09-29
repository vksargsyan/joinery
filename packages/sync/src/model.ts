import type { EngineId, SqlDialect } from '@joinery/core';

import type { ResolvedCompareOptions } from './options';

/** What a structure sync operation acts on. */
export type SyncObjectKind =
  | 'schema'
  | 'extension'
  | 'type'
  | 'sequence'
  | 'table'
  | 'column'
  | 'primary-key'
  | 'unique'
  | 'index'
  | 'foreign-key'
  | 'check'
  | 'trigger'
  | 'partition'
  | 'view'
  | 'materialized-view'
  | 'routine'
  | 'event';

/** What an operation does to its object. */
export type OperationKind = 'create' | 'alter' | 'drop' | 'rename';

/** Why an operation carries a warning. */
export type WarningCode =
  /** The operation loses data or code. */
  | 'data-loss'
  /** The statement can fail on existing data (e.g. SET NOT NULL, narrowing with USING). */
  | 'may-fail'
  /** The change cannot be scripted; the operation holds no statements. */
  | 'unsupported'
  /** Recreated only because an object it depends on changes. */
  | 'rebuild'
  /** MySQL ↔ MariaDB differences. */
  | 'cross-family'
  /** Runs outside the script's transaction. */
  | 'non-transactional'
  /** A selected operation needs an unselected one. */
  | 'missing-dependency'
  | 'info';

/** A note shown next to an operation or the whole comparison. */
export interface SyncWarning {
  readonly code: WarningCode;
  readonly message: string;
}

/**
 * One tickable unit of the deployment (spec §13, steps 4-5). The UI lists these, shows the
 * side-by-side DDL, and lets the user untick them; the script generator orders their steps.
 */
export interface SyncOperation {
  /** Stable across re-compares of the same pair: `<objectKind>:<qualified name>:<action>`. */
  readonly id: string;
  readonly kind: OperationKind;
  readonly objectKind: SyncObjectKind;
  /** Object name (in the source, or the target for drops). */
  readonly name: string;
  /** Display name, e.g. `public.users.email`; MySQL names are unqualified. */
  readonly qualifiedName: string;
  /** Qualified name of the parent table or view, for sub-objects. */
  readonly parent?: string;
  readonly schema?: string;
  /** Statements in execution order (they may run at different points of the script). */
  readonly statements: readonly string[];
  /** DDL of the object in the source and the target, for the side-by-side view. */
  readonly sourceDdl?: string;
  readonly targetDdl?: string;
  /** Loses data or code; starts unselected. */
  readonly destructive: boolean;
  readonly selected: boolean;
  /** Operations this one needs: unselecting one of them unselects this one. */
  readonly dependsOn: readonly string[];
  readonly warnings: readonly SyncWarning[];
  /** Human-readable list of the differences, e.g. `type: integer → bigint`. */
  readonly changes: readonly string[];
  /** Why the operation exists when the object itself did not change (dependency rebuilds). */
  readonly reason?: string;
  /** Script steps; each runs at its own place in the dependency order. */
  readonly steps: readonly OperationStep[];
}

/** Part of an operation that runs at one point of the script. */
export interface OperationStep {
  /** Coarse ordering bucket (spec §13, step 6); lower runs first unless dependencies say otherwise. */
  readonly phase: number;
  readonly statements: readonly string[];
  /** Runs before the PostgreSQL transaction (ALTER TYPE ... ADD VALUE). */
  readonly preTransaction?: boolean;
}

/** Counts for the compare summary bar. */
export interface DiffSummary {
  readonly total: number;
  readonly create: number;
  readonly alter: number;
  readonly drop: number;
  readonly rename: number;
  readonly destructive: number;
  readonly selected: number;
  readonly byObjectKind: Readonly<Partial<Record<SyncObjectKind, number>>>;
}

/** The result of a structure comparison: ordered operations plus their step order. */
export interface SchemaDiff {
  readonly sourceEngine: EngineId;
  readonly targetEngine: EngineId;
  /** Dialect of the generated statements: the target's. */
  readonly dialect: SqlDialect;
  readonly sourceDatabase: string;
  readonly targetDatabase: string;
  /** Operations in execution order of their first step. */
  readonly operations: SyncOperation[];
  /** Step execution order: `[operation index, step index]` pairs. */
  readonly order: readonly (readonly [number, number])[];
  /** Pair-level warnings (cross-family compare, non-transactional DDL). */
  readonly warnings: readonly SyncWarning[];
  readonly options: ResolvedCompareOptions;
  /** True when there is nothing to deploy. */
  readonly identical: boolean;
}

/** `compareSchemas` result. */
export interface SchemaComparison {
  readonly diff: SchemaDiff;
  readonly summary: DiffSummary;
}
