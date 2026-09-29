import type { TableDef } from '@joinery/core';

import { diffSchemas } from '../diff/index';
import { PHASE } from '../diff/builder';
import type { SchemaDiff, SyncOperation, SyncWarning } from '../model';
import type { CompareOptions, RenameRule } from '../options';
import { renderDropTrigger, renderTrigger } from '../render';
import { generateScript } from '../script';
import { setAllSelected } from '../selection';
import { analyzeDataLoss, dropTableDataLoss } from './data-loss';
import {
  buildSnapshots,
  dependentViews,
  prepare,
  referencingTables,
  renameIdentifiers,
} from './prepare';
import type { Prepared } from './prepare';
import type { DataLossWarning, DesignContext, TableDesign, ValidationIssue } from './types';
import { validatePrepared } from './validate';

/**
 * The table designer's Save (spec §8): the diff of the edited table against the live one,
 * computed by the structure sync engine over snapshots that hold the table and what surrounds
 * it, so the ALTER script, its ordering and its dependency handling are the sync engine's.
 */

function renameRules(p: Prepared, context: DesignContext): RenameRule[] {
  const schema = p.pg ? (p.schemaDef?.name ?? p.schema) : undefined;
  const scope = schema !== undefined ? { schema } : {};
  const table = p.table.name;
  const rules: RenameRule[] = [];
  if (p.live !== null && p.live.name !== table) {
    rules.push({ objectKind: 'table', ...scope, from: p.live.name, to: table });
  }
  for (const [from, to] of p.columnRenames) {
    rules.push({ objectKind: 'column', ...scope, table, from, to });
  }
  const names = { ...context.renames?.indexes, ...context.renames?.constraints };
  for (const [from, to] of Object.entries(names)) {
    if (from === to) continue;
    rules.push({ objectKind: 'index', ...scope, table, from, to });
    rules.push({ objectKind: 'constraint', ...scope, table, from, to });
  }
  return rules;
}

function compareOptions(p: Prepared, context: DesignContext): CompareOptions {
  const given = context.options?.compare ?? {};
  return {
    ignoreAutoIncrement: false,
    ...given,
    renames: [...renameRules(p, context), ...(given.renames ?? [])],
  };
}

/**
 * MySQL and MariaDB keep trigger bodies as written: renaming a column a trigger uses leaves the
 * trigger failing. The sync engine reads such triggers as following the rename (as PostgreSQL
 * does), so the designer re-creates them itself, after the rename, from the edited definition.
 */
function rebuildMysqlTriggers(p: Prepared, diff: SchemaDiff): SchemaDiff {
  const live = p.live;
  if (p.pg || live === null || p.columnRenames.size === 0) return diff;
  const extra: SyncOperation[] = [];
  const renameOps = diff.operations
    .filter((op) => op.objectKind === 'column' && [...p.columnRenames.values()].includes(op.name))
    .map((op) => op.id);
  for (const trigger of live.triggers) {
    if (renameIdentifiers(trigger.definition, p.dialect, p.columnRenames) === trigger.definition)
      continue;
    const edited = p.table.triggers.find((t) => t.name === trigger.name);
    if (edited === undefined) continue;
    if (diff.operations.some((op) => op.objectKind === 'trigger' && op.name === trigger.name))
      continue;
    const drop = renderDropTrigger(trigger, p.table.name, p.dialect);
    const create = renderTrigger(edited, p.dialect);
    extra.push({
      id: `trigger:${p.table.name}.${trigger.name}:rebuild`,
      kind: 'alter',
      objectKind: 'trigger',
      name: trigger.name,
      qualifiedName: `${p.table.name}.${trigger.name}`,
      parent: p.table.name,
      statements: [drop, create],
      sourceDdl: create,
      targetDdl: renderTrigger(trigger, p.dialect),
      destructive: false,
      selected: true,
      dependsOn: renameOps,
      warnings: [
        {
          code: 'rebuild',
          message: `${p.dialect === 'mariadb' ? 'MariaDB' : 'MySQL'} does not update trigger bodies when a column is renamed: the trigger is re-created with the new names`,
        },
      ],
      changes: ['definition follows the column rename'],
      reason: 'Re-created because a column it uses is renamed',
      steps: [
        { phase: PHASE.dropTrigger, statements: [drop] },
        { phase: PHASE.createTrigger, statements: [create] },
      ],
    });
  }
  if (extra.length === 0) return diff;
  const base = diff.operations.length;
  return {
    ...diff,
    operations: [...diff.operations, ...extra],
    order: [
      ...diff.order,
      ...extra.flatMap((_op, k) => [[base + k, 0] as const, [base + k, 1] as const]),
    ],
    identical: false,
  };
}

function collectWarnings(diff: SchemaDiff, scriptWarnings: readonly SyncWarning[]): SyncWarning[] {
  const seen = new Set<string>();
  const out: SyncWarning[] = [];
  const add = (w: SyncWarning): void => {
    const k = `${w.code}\u0000${w.message}`;
    if (seen.has(k)) return;
    seen.add(k);
    out.push(w);
  };
  scriptWarnings.forEach(add);
  for (const op of diff.operations) for (const w of op.warnings) add(w);
  return out;
}

function unsupportedIssues(diff: SchemaDiff): ValidationIssue[] {
  return diff.operations
    .filter((op) => op.statements.length === 0 && op.warnings.some((w) => w.code === 'unsupported'))
    .map((op) => ({
      path: op.objectKind === 'table' ? 'kind' : op.objectKind,
      code: 'unsupported-change',
      message: op.warnings.find((w) => w.code === 'unsupported')!.message,
      severity: 'error' as const,
    }));
}

function finish(
  p: Prepared,
  context: DesignContext,
  diff: SchemaDiff,
  issues: ValidationIssue[],
  dataLoss: (operations: readonly SyncOperation[]) => DataLossWarning[],
): TableDesign {
  const options = context.options ?? {};
  const disableForeignKeyChecks = options.disableForeignKeyChecks ?? false;
  const script = generateScript(diff, {
    include: 'all',
    header: false,
    comments: options.comments ?? false,
    disableForeignKeyChecks,
  });
  const allIssues = [...issues, ...unsupportedIssues(diff)];
  const warnings = collectWarnings(diff, script.warnings);
  for (const issue of allIssues) {
    if (issue.code === 'reorder-unsupported')
      warnings.push({ code: 'unsupported', message: issue.message });
  }
  return {
    operations: diff.operations,
    script: script.statements.length > 0 ? script.text : '',
    statements: script.statements,
    warnings,
    dataLoss: dataLoss(diff.operations),
    valid: !allIssues.some((i) => i.severity === 'error'),
    issues: allIssues,
    transactional: script.transactional,
    unchanged: diff.operations.length === 0,
    table: p.table,
  };
}

function failed(p: Prepared, issues: ValidationIssue[], error: unknown): TableDesign {
  return {
    operations: [],
    script: '',
    statements: [],
    warnings: [],
    dataLoss: [],
    valid: false,
    issues: [
      ...issues,
      {
        path: '',
        code: 'internal',
        message: `The script could not be generated: ${error instanceof Error ? error.message : String(error)}`,
        severity: 'error',
      },
    ],
    transactional: p.pg,
    unchanged: false,
    table: p.table,
  };
}

/**
 * Computes what saving the designed table does (spec §8, "Save computes the diff against the
 * live table and shows the ALTER script first"). `live` is the table as the server has it, or
 * null for a new table (CREATE TABLE with its indexes, foreign keys and triggers). Renames come
 * only from `context.renames`, so a renamed column becomes RENAME COLUMN (MySQL: CHANGE COLUMN)
 * rather than a drop and an add. MySQL/MariaDB column order is applied with AFTER/FIRST;
 * PostgreSQL cannot reorder columns, which is reported instead of rebuilding the table.
 *
 * The result lists every operation (all part of the save), the script and its plain
 * statements (PostgreSQL in one transaction; MySQL's non-transactional DDL is flagged), the
 * warnings, the data-loss analysis for the confirmation dialog, and the validation issues:
 * `valid` is false while any is an error.
 */
export function designTable(
  live: TableDef | null,
  edited: TableDef,
  context: DesignContext,
): TableDesign {
  const p = prepare(live, edited, context);
  const issues = validatePrepared(p);
  let diff: SchemaDiff;
  try {
    const { source, target } = buildSnapshots(p);
    diff = setAllSelected(diffSchemas(source, target, compareOptions(p, context)), true);
    diff = rebuildMysqlTriggers(p, diff);
  } catch (error) {
    return failed(p, issues, error);
  }
  const disable = context.options?.disableForeignKeyChecks ?? false;
  return finish(p, context, diff, issues, (operations) => analyzeDataLoss(p, operations, disable));
}

/**
 * The script that drops a table, with its data-loss warning and what stops the drop: views
 * that depend on the table and foreign keys of other tables that reference it.
 */
export function designDropTable(live: TableDef, context: DesignContext): TableDesign {
  const p = prepare(live, live, context);
  const issues: ValidationIssue[] = [];
  const home = p.schemaDef?.name ?? p.schema;
  for (const { schema, view } of dependentViews(p, [{ schema: home, name: live.name }])) {
    issues.push({
      path: 'name',
      code: 'dependent-view',
      message: p.pg
        ? `View ${schema.name}.${view.name} depends on ${live.name}: drop it first`
        : `View ${view.name} uses ${live.name} and stops working`,
      severity: p.pg ? 'error' : 'warning',
    });
  }
  const disable = context.options?.disableForeignKeyChecks ?? false;
  for (const { schema, table } of referencingTables(p)) {
    for (const fk of table.foreignKeys.filter((f) => f.refTable === live.name)) {
      issues.push({
        path: 'name',
        code: 'referenced-table',
        message: `Foreign key ${p.pg ? `${schema.name}.` : ''}${table.name}.${fk.name} references ${live.name}: drop it first`,
        severity: !p.pg && disable ? 'warning' : 'error',
      });
    }
  }
  let diff: SchemaDiff;
  try {
    const { source, target } = buildSnapshots(p, 'drop');
    diff = setAllSelected(diffSchemas(source, target, compareOptions(p, context)), true);
  } catch (error) {
    return failed(p, issues, error);
  }
  return finish(p, context, diff, issues, () => dropTableDataLoss(p));
}
