import type { CellValue, ErrorData, SqlDialect } from '@querybara/core';
import {
  analyzeStatement,
  decideSafety,
  type ConfirmationReason,
  type SafetyPolicy,
} from '@querybara/sql-tools';
import {
  planChanges,
  rowKeyAt,
  type ApplyResult,
  type ChangePlan,
  type ChangeSet,
  type ColumnInfo,
  type RowIdentity,
  type RowKey,
  type TableRef,
} from '@querybara/table-data';

import type { LoadedRows } from './grid-model';

/**
 * Apply (spec §7): plan the staged changes, show the SQL, pass the write-safety rules, run the
 * plan in one transaction on the connection host, then merge the rows as written back into the
 * grid so it keeps its place. A CONFLICT means someone else changed a row since it was loaded:
 * nothing was saved, and the user is offered a reload.
 */

export interface ApplyTarget {
  readonly dialect: SqlDialect;
  readonly table: TableRef;
  readonly columns: readonly ColumnInfo[];
  readonly identity: RowIdentity;
  /** INSERT ... RETURNING works (server capability). */
  readonly returning: boolean;
}

/** The statements that write `changes`; throws VALIDATION_FAILED or READ_ONLY. */
export function planApply(changes: ChangeSet, target: ApplyTarget): ChangePlan {
  return planChanges(changes, {
    dialect: target.dialect,
    table: target.table,
    columns: target.columns,
    identity: target.identity,
    returning: target.returning,
  });
}

/** A statement the production confirmation lists, in the shape the prompt shows. */
export interface GatedStatement {
  readonly index: number;
  readonly line: number;
  readonly text: string;
  readonly reasons: readonly ConfirmationReason[];
}

export type WriteGate =
  | { readonly action: 'run' }
  | { readonly action: 'refuse'; readonly message: string }
  | { readonly action: 'confirm'; readonly statements: readonly GatedStatement[] };

/**
 * The write-safety rules (spec §4, §6) for SQL the user has already reviewed (the Apply preview,
 * the designer's script): a read-only profile refuses it; a production profile, or one that asks
 * before every write, always asks again with the statements listed. Otherwise the review was the
 * confirmation.
 */
export function writeGate(
  statements: readonly string[],
  dialect: SqlDialect,
  policy: SafetyPolicy,
): WriteGate {
  if (policy.readOnly) {
    return {
      action: 'refuse',
      message: 'This connection is read-only, so nothing was written.',
    };
  }
  const gated: GatedStatement[] = [];
  statements.forEach((text, index) => {
    const decision = decideSafety(analyzeStatement(text, dialect), policy);
    if (decision.action === 'confirm')
      gated.push({ index, line: 1, text, reasons: decision.reasons });
  });
  if (!(policy.production || policy.confirmWrites === true) || gated.length === 0) {
    return { action: 'run' };
  }
  return { action: 'confirm', statements: gated };
}

export interface MergedRows {
  readonly rows: CellValue[][];
  readonly keys: (RowKey | null)[];
  /** Loaded rows the server no longer has (deleted). */
  readonly removed: number;
  /** Rows written whose new values could not all be read back: reload to see them. */
  readonly unreadable: number;
}

/**
 * The loaded rows after a successful Apply: deleted rows removed, updated rows replaced by the
 * row as written, inserted rows appended. Rows that could not be read back keep what is known
 * (the values the statement wrote) and are counted in `unreadable`.
 */
export function mergeApplied(
  loaded: LoadedRows,
  plan: ChangePlan,
  result: ApplyResult,
  identity: RowIdentity,
): MergedRows {
  const position = new Map<string, number>();
  loaded.columns.forEach((name, i) => position.set(name, i));
  const fromPlan = (row: readonly CellValue[]): CellValue[] => {
    const out: CellValue[] = loaded.columns.map(() => null);
    plan.columns.forEach((name, i) => {
      const at = position.get(name);
      if (at !== undefined) out[at] = row[i] ?? null;
    });
    return out;
  };
  const known = new Map(plan.statements.map((s) => [s.key, s.knownValues]));
  const overlay = (base: readonly CellValue[], key: RowKey): CellValue[] => {
    const out = [...base];
    for (const [name, value] of Object.entries(known.get(key) ?? {})) {
      const at = position.get(name);
      if (at !== undefined) out[at] = value;
    }
    return out;
  };

  const indexOfKey = new Map<RowKey, number>();
  loaded.keys.forEach((key, i) => {
    if (key !== null) indexOfKey.set(key, i);
  });
  const rows: (CellValue[] | undefined)[] = loaded.rows.map((row) => [...row]);
  const keys: (RowKey | null)[] = [...loaded.keys];
  const appended: CellValue[][] = [];
  const appendedKeys: (RowKey | null)[] = [];
  let removed = 0;
  let unreadable = 0;
  for (const applied of result.rows) {
    if (applied.kind === 'delete') {
      const at = indexOfKey.get(applied.key);
      if (at !== undefined && rows[at] !== undefined) {
        rows[at] = undefined;
        removed++;
      }
      continue;
    }
    let row: CellValue[];
    if (applied.row) row = fromPlan(applied.row);
    else {
      unreadable++;
      const at = indexOfKey.get(applied.key);
      row = overlay(
        at === undefined ? loaded.columns.map(() => null) : loaded.rows[at]!,
        applied.key,
      );
    }
    const key = applied.newKey ?? rowKeyAt(identity, loaded.columns, row);
    if (applied.kind === 'update') {
      const at = indexOfKey.get(applied.key);
      if (at === undefined) continue;
      rows[at] = row;
      keys[at] = key;
    } else {
      appended.push(row);
      appendedKeys.push(key);
    }
  }
  const keptRows: CellValue[][] = [];
  const keptKeys: (RowKey | null)[] = [];
  rows.forEach((row, i) => {
    if (row === undefined) return;
    keptRows.push(row);
    keptKeys.push(keys[i] ?? null);
  });
  return {
    rows: [...keptRows, ...appended],
    keys: [...keptKeys, ...appendedKeys],
    removed,
    unreadable,
  };
}

/** What the Apply dialog says about a failure. */
export interface ApplyFailure {
  /** Someone else changed a row: offer a reload. */
  readonly conflict: boolean;
  readonly message: string;
  readonly detail?: string;
  readonly hint?: string;
}

export function describeApplyFailure(error: ErrorData): ApplyFailure {
  return {
    conflict: error.code === 'CONFLICT',
    message: error.message,
    ...(error.detail !== undefined ? { detail: error.detail } : {}),
    ...(error.hint !== undefined ? { hint: error.hint } : {}),
  };
}
