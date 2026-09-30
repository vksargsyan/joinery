import type { SchemaSnapshot, TableDef } from '@joinery/core';
import {
  compareSchemas,
  generateScript,
  validateTable,
  type DiffSummary,
  type SyncOperation,
  type SyncWarning,
} from '@joinery/sync';

import { editedSchema, modelChanges, renameRules, type EditContext, type ModelState } from './edit';

/**
 * What an edited ER model does to the database (spec §8, forward engineering): the structure
 * compare of the model against the live schema it started from, with the rename rules its
 * origins give, as a script to review and run, and the table designer's validation of every
 * table the model adds or changes. The script comes from the same engine as structure sync
 * and the table designer, so its order, its dependency handling and its destructive flags are
 * theirs. Pure.
 */

export interface ModelScript {
  readonly operations: readonly SyncOperation[];
  readonly summary: DiffSummary;
  /** Plain statements in execution order, for running. */
  readonly statements: readonly string[];
  /** The runnable script with a comment per operation, for reading, copying and saving. */
  readonly text: string;
  /** PostgreSQL: the script is one transaction. */
  readonly transactional: boolean;
  readonly warnings: readonly SyncWarning[];
  /** Operations that lose data (drops, narrowing type changes). */
  readonly destructive: readonly SyncOperation[];
}

export function modelScript(
  state: ModelState,
  base: SchemaSnapshot,
  context: EditContext,
): ModelScript {
  const { diff, summary } = compareSchemas(state.snapshot, base, {
    renames: renameRules(state, context),
  });
  const script = generateScript(diff, { include: 'all', header: false, comments: true });
  // A table the script creates has no rows yet: what existing rows could break does not apply.
  const created = new Set(
    diff.operations
      .filter((op) => op.kind === 'create' && op.objectKind === 'table')
      .map((op) => op.qualifiedName),
  );
  const seen = new Set<string>();
  const warnings: SyncWarning[] = [];
  for (const warning of [
    ...diff.warnings,
    ...script.warnings,
    ...diff.operations
      .filter((op) => op.parent === undefined || !created.has(op.parent))
      .flatMap((op) => op.warnings),
  ]) {
    const key = `${warning.code}\u0000${warning.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    warnings.push(warning);
  }
  return {
    operations: diff.operations,
    summary,
    statements: script.statements,
    text: script.statements.length > 0 ? script.text : '',
    transactional: script.transactional,
    warnings,
    destructive: diff.operations.filter((op) => op.destructive),
  };
}

export interface ModelIssue {
  readonly table: string;
  /** The column the issue is about, when it is about one. */
  readonly column?: string;
  readonly code: string;
  readonly message: string;
  readonly severity: 'error' | 'warning';
}

function withTableAsLive(
  snapshot: SchemaSnapshot,
  context: EditContext,
  name: string,
  live: TableDef | null,
): SchemaSnapshot {
  const schema = editedSchema(snapshot, context);
  return {
    ...snapshot,
    schemas: snapshot.schemas.map((s) =>
      s !== schema
        ? s
        : {
            ...s,
            tables: live
              ? s.tables.map((t) => (t.name === name ? live : t))
              : s.tables.filter((t) => t.name !== name),
          },
    ),
  };
}

/** The column a designer issue path points at: `columns[3].dataType` → the fourth column. */
function columnOf(table: TableDef, path: string): string | undefined {
  const match = /^columns\[(\d+)\]/.exec(path);
  return match ? table.columns[Number(match[1])]?.name : undefined;
}

/**
 * The table designer's validation of each table the model adds or changes: types and their
 * parameters for the engine and version, defaults, keys, and foreign keys against the keys and
 * types they reference.
 */
export function validateModel(
  state: ModelState,
  base: SchemaSnapshot,
  context: EditContext,
  serverVersion?: string,
): ModelIssue[] {
  const changes = modelChanges(state, base, context);
  const live = editedSchema(base, context);
  const issues: ModelIssue[] = [];
  for (const table of editedSchema(state.snapshot, context).tables) {
    if (!changes.tables.has(table.name)) continue;
    const origin = state.tableOrigins[table.name];
    const liveTable = origin ? (live.tables.find((t) => t.name === origin) ?? null) : null;
    const renames = Object.fromEntries(
      Object.entries(state.columnOrigins[table.name] ?? {}).flatMap(([name, from]) =>
        liveTable && from !== null && from !== name ? [[from, name]] : [],
      ),
    );
    // The designer checks a table against the schema around it as it stands before the save:
    // the rest of the model, with this table as it is live (or not there yet).
    const around = withTableAsLive(state.snapshot, context, table.name, liveTable);
    const found = validateTable(
      table,
      {
        engine: context.engine,
        schema: context.schema,
        snapshot: around,
        ...(serverVersion === undefined ? {} : { serverVersion }),
        renames: { columns: renames },
      },
      liveTable,
    );
    for (const issue of found) {
      const column = columnOf(table, issue.path);
      issues.push({
        table: table.name,
        ...(column === undefined ? {} : { column }),
        code: issue.code,
        message: issue.message,
        severity: issue.severity,
      });
    }
  }
  return issues;
}
