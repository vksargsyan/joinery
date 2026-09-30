import type {
  CheckDef,
  ColumnDef,
  ForeignKeyDef,
  IndexDef,
  KeyDef,
  TableDef,
  TriggerDef,
} from '@joinery/core';
import { quoteIdent, quoteString } from '@joinery/sql-tools';

import type { SyncWarning } from '../model';
import {
  canonicalCharset,
  canonicalCheck,
  canonicalColumn,
  canonicalForeignKey,
  canonicalIndex,
  canonicalKey,
  canonicalTableOptions,
  canonicalTrigger,
  canonicalExpression,
  isMariadbJsonCheck,
  mysqlTriggerBodyUsesRenames,
  nameKey,
  OPTIONAL_TABLE_OPTIONS,
  tableContext,
} from '../normalize';
import type { CanonicalColumn, NormalizeContext } from '../normalize';
import {
  isGeneratedName,
  mariadbColumnCheck,
  pgStorageEntries,
  pgStorageParameters,
  renderCheck,
  renderColumn,
  renderDropTrigger,
  renderForeignKey,
  renderMysqlIndexClause,
  renderOwnedBy,
  renderPartitionClause,
  renderPgComment,
  renderPgCreateIndex,
  renderPgPartition,
  renderPrimaryKey,
  renderTableStatements,
  renderTrigger,
  renderUnique,
} from '../render';
import { referencedNames, tokenizeSql } from '../sql-text';
import { canonicalType, isMysqlTextType, typeChangeRisk } from '../types';
import { PHASE, step } from './builder';
import type { OpDraft, StepDraft } from './builder';
import type { DiffContext } from './context';
import { displayName, findRename, key, noteRename, qualified, tableKey, typeRefs } from './context';
import type { TablePair } from './pairs';

const json = (value: unknown): string => JSON.stringify(value);

function show(value: unknown): string {
  if (value === null || value === undefined) return '(none)';
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

/** Field-by-field differences between two canonical objects, as `field: target → source`. */
export function describeChanges(
  target: object,
  source: object,
  labels: Record<string, string> = {},
): string[] {
  const keys = new Set([...Object.keys(target), ...Object.keys(source)]);
  const out: string[] = [];
  for (const k of keys) {
    const a = (target as Record<string, unknown>)[k];
    const b = (source as Record<string, unknown>)[k];
    if (json(a) !== json(b)) out.push(`${labels[k] ?? k}: ${show(a)} → ${show(b)}`);
  }
  return out;
}

function tableStatementName(ctx: DiffContext, pair: TablePair, phase: number): string {
  return qualified(ctx, pair.schema.name, phase >= PHASE.renameTable ? pair.after : pair.before);
}

function tableDisplay(ctx: DiffContext, pair: TablePair, ...rest: string[]): string {
  return displayName(ctx, pair.schema.name, pair.after, ...rest);
}

function relKeys(pair: TablePair): string[] {
  const keys = [key.rel(pair.schema.key, pair.before)];
  if (pair.after !== pair.before) keys.push(key.rel(pair.schema.key, pair.after));
  return keys;
}

function colKeys(pair: TablePair, column: string, renamedTo?: string): string[] {
  const keys = new Set([
    key.col(pair.schema.key, pair.before, column),
    key.col(pair.schema.key, pair.after, column),
  ]);
  if (renamedTo !== undefined) keys.add(key.col(pair.schema.key, pair.after, renamedTo));
  return [...keys];
}

function schemaRefs(ctx: DiffContext, pair: TablePair): string[] {
  return ctx.pg ? [key.schema(pair.schema.name)] : [];
}

function renderOptions(ctx: DiffContext, schema: string) {
  return {
    omitCollation: ctx.options.ignoreCollation && !ctx.pg,
    ...(ctx.pg ? { schema } : {}),
    omitGeneratedNames: ctx.options.ignoreNames,
    ignoreAutoIncrement: ctx.options.ignoreAutoIncrement,
    ignoreDefiner: ctx.options.ignoreDefiner,
    ignoreOwnership: ctx.options.ignoreOwnership,
    ignoreComments: ctx.options.ignoreComments,
    ignorePartitions: ctx.options.ignorePartitions,
  };
}

/** Full DDL of a table for the side-by-side view. */
export function tableDdl(ctx: DiffContext, table: TableDef, schema: string): string {
  const statements = renderTableStatements(table, ctx.dialect, {
    ...renderOptions(ctx, schema),
    omitGeneratedNames: false,
    ignoreAutoIncrement: true,
  });
  for (const trigger of table.triggers) statements.push(renderTrigger(trigger, ctx.dialect));
  return statements.map((s) => `${s};`).join('\n\n');
}

/**
 * Adapts a source table for a target of the other MySQL family: MariaDB's JSON alias
 * (LONGTEXT + json_valid check) becomes a real JSON column for MySQL.
 */
export function adaptTable(ctx: DiffContext, table: TableDef): TableDef {
  if (!(ctx.crossFamily && ctx.source.engine === 'mariadb' && ctx.dialect === 'mysql'))
    return table;
  const jsonColumns = new Set(
    table.columns
      .filter(
        (c) =>
          /^longtext$/i.test(c.dataType.trim()) &&
          table.checks.some((k) => isMariadbJsonCheck(k, c)),
      )
      .map((c) => c.name),
  );
  if (jsonColumns.size === 0) return table;
  return {
    ...table,
    columns: table.columns.map((c) => {
      if (!jsonColumns.has(c.name)) return c;
      const { charset: _charset, collation: _collation, ...rest } = c;
      return { ...rest, dataType: 'json' };
    }),
    checks: table.checks.filter(
      (k) => !table.columns.some((c) => jsonColumns.has(c.name) && isMariadbJsonCheck(k, c)),
    ),
  };
}

function crossFamilyColumnWarnings(ctx: DiffContext, column: ColumnDef): SyncWarning[] {
  if (!ctx.crossFamily) return [];
  const warnings: SyncWarning[] = [];
  const collation = ctx.options.ignoreCollation ? '' : (column.collation?.toLowerCase() ?? '');
  if (ctx.dialect === 'mariadb' && collation.includes('_0900_')) {
    warnings.push({
      code: 'cross-family',
      message: `MySQL collation ${column.collation} may not exist on MariaDB`,
    });
  }
  if (ctx.dialect === 'mysql' && collation.includes('uca1400')) {
    warnings.push({
      code: 'cross-family',
      message: `MariaDB collation ${column.collation} does not exist on MySQL`,
    });
  }
  if (ctx.dialect === 'mysql' && /^(uuid|inet4|inet6|xmltype)\b/i.test(column.dataType.trim())) {
    warnings.push({
      code: 'cross-family',
      message: `MariaDB type ${column.dataType} does not exist on MySQL`,
    });
  }
  return warnings;
}

// ---------------------------------------------------------------------------------------------
// Create and drop

/** Statements that attach new sequences to the columns that own them. */
function ownedSequenceStatements(
  ctx: DiffContext,
  pair: TablePair,
  column: string,
): { statements: string[]; refs: string[] } {
  if (!ctx.pg) return { statements: [], refs: [] };
  const entry = ctx.state.newOwnedSequences.get(
    `${pair.schema.key.toLowerCase()}.${pair.after.toLowerCase()}.${column.toLowerCase()}`,
  );
  if (entry === undefined) return { statements: [], refs: [] };
  return {
    statements: [
      `ALTER SEQUENCE ${qualified(ctx, entry.schema.name, entry.sequence.name)} OWNED BY ${renderOwnedBy(`${pair.after}.${column}`, ctx.dialect, pair.schema.name)}`,
    ],
    refs: [key.rel(entry.schema.key, entry.sequence.name)],
  };
}

function columnRefs(ctx: DiffContext, pair: TablePair, column: ColumnDef): string[] {
  const refs = typeRefs(column.dataType, pair.schema.key, ctx.refs, ctx.dialect);
  refs.push(...ctx.refs.resolve(column.default ?? undefined, ctx.dialect));
  if (column.generated !== undefined)
    refs.push(...ctx.refs.resolve(column.generated.expression, ctx.dialect));
  return refs;
}

export function createTable(ctx: DiffContext, pair: TablePair): void {
  const source = adaptTable(ctx, pair.source!);
  const schema = pair.schema.name;
  const statements = renderTableStatements(source, ctx.dialect, {
    ...renderOptions(ctx, schema),
    includeForeignKeys: false,
  });
  const refs = [...schemaRefs(ctx, pair)];
  const provides = [key.rel(pair.schema.key, source.name)];
  for (const column of source.columns) {
    provides.push(key.col(pair.schema.key, source.name, column.name));
    refs.push(...columnRefs(ctx, pair, column));
    const owned = ownedSequenceStatements(ctx, pair, column.name);
    statements.push(...owned.statements);
    refs.push(...owned.refs);
  }
  for (const check of source.checks) refs.push(...ctx.refs.resolve(check.expression, ctx.dialect));
  for (const index of source.indexes) {
    provides.push(key.rel(pair.schema.key, index.name));
    refs.push(
      ...ctx.refs.resolve(index.definition, ctx.dialect).filter((k) => k.startsWith('fn:')),
    );
  }
  const warnings: SyncWarning[] = [
    ...crossFamilyColumnWarnings(ctx, {
      name: '',
      ordinal: 1,
      dataType: '',
      nullable: true,
      default: null,
      autoIncrement: false,
      ...(source.options.collation !== undefined ? { collation: source.options.collation } : {}),
    }),
    ...source.columns.flatMap((c) => crossFamilyColumnWarnings(ctx, c)),
  ];
  if (source.kind === 'foreign') {
    ctx.builder.add({
      id: `table:${tableDisplay(ctx, pair)}:create`,
      kind: 'create',
      objectKind: 'table',
      name: source.name,
      qualifiedName: tableDisplay(ctx, pair),
      ...(ctx.pg ? { schema } : {}),
      steps: [],
      sourceDdl: tableDdl(ctx, source, schema),
      unsupported: true,
      warnings: [
        {
          code: 'unsupported',
          message: 'Foreign tables need their server and options; create them manually',
        },
      ],
    });
    return;
  }
  ctx.builder.add({
    id: `table:${tableDisplay(ctx, pair)}:create`,
    kind: 'create',
    objectKind: 'table',
    name: source.name,
    qualifiedName: tableDisplay(ctx, pair),
    ...(ctx.pg ? { schema } : {}),
    steps: [step(PHASE.createTable, statements, { provides, refs })],
    sourceDdl: tableDdl(ctx, source, schema),
    warnings,
  });
  for (const fk of source.foreignKeys) addForeignKey(ctx, pair, fk);
  for (const trigger of source.triggers) createTrigger(ctx, pair, trigger);
}

export function dropTable(ctx: DiffContext, pair: TablePair): OpDraft {
  const target = pair.target!;
  const targetRefs: string[] = [];
  for (const column of target.columns) targetRefs.push(...columnRefs(ctx, pair, column));
  for (const fk of target.foreignKeys)
    targetRefs.push(key.rel(fk.refSchema ?? pair.schema.key, fk.refTable));
  const op = ctx.builder.add({
    id: `table:${tableDisplay(ctx, pair)}:drop`,
    kind: 'drop',
    objectKind: 'table',
    name: target.name,
    qualifiedName: tableDisplay(ctx, pair),
    ...(ctx.pg ? { schema: pair.schema.name } : {}),
    steps: [
      step(PHASE.dropTable, [`DROP TABLE ${tableStatementName(ctx, pair, PHASE.dropTable)}`], {
        removes: [...relKeys(pair), ...target.indexes.map((i) => key.rel(pair.schema.key, i.name))],
        targetRefs,
      }),
    ],
    targetDdl: tableDdl(ctx, target, pair.schema.name),
    destructive: true,
    warnings: [
      { code: 'data-loss', message: `Drops table ${tableDisplay(ctx, pair)} and all of its rows` },
    ],
  });
  // Its foreign keys go with it: keys they reference can only be dropped after the table.
  for (const fk of target.foreignKeys)
    ctx.state.foreignKeys.push({ table: pair, target: fk, op, dropStep: 0 });
  return op;
}

// ---------------------------------------------------------------------------------------------
// Alter

export function alterTable(ctx: DiffContext, pair: TablePair): void {
  const source = adaptTable(ctx, pair.source!);
  const target = pair.target!;
  if (pair.renamed) renameTable(ctx, pair);
  if (source.kind !== target.kind || partitionShapeChanged(ctx, source, target)) {
    ctx.builder.add({
      id: `table:${tableDisplay(ctx, pair)}:recreate`,
      kind: 'alter',
      objectKind: 'table',
      name: source.name,
      qualifiedName: tableDisplay(ctx, pair),
      ...(ctx.pg ? { schema: pair.schema.name } : {}),
      steps: [],
      sourceDdl: tableDdl(ctx, source, pair.schema.name),
      targetDdl: tableDdl(ctx, target, pair.schema.name),
      unsupported: true,
      changes: [`kind: ${target.kind} → ${source.kind}`],
      warnings: [
        {
          code: 'unsupported',
          message:
            'Changing between a plain, partitioned or foreign table (or the partition key) needs the table rebuilt and its rows copied; do it manually',
        },
      ],
    });
  }
  const pairWithSource: TablePair = { ...pair, source };
  diffColumns(ctx, pairWithSource);
  diffPrimaryKey(ctx, pairWithSource);
  diffUniques(ctx, pairWithSource);
  diffIndexes(ctx, pairWithSource);
  diffChecks(ctx, pairWithSource);
  diffForeignKeys(ctx, pairWithSource);
  diffTriggers(ctx, pairWithSource);
  diffTableOptions(ctx, pairWithSource);
  diffPartitions(ctx, pairWithSource);
}

function partitionShapeChanged(ctx: DiffContext, source: TableDef, target: TableDef): boolean {
  if (!ctx.pg) return false;
  const a = source.partitioning;
  const b = target.partitioning;
  if (a === undefined || b === undefined) return a !== b;
  return (
    a.method.toUpperCase() !== b.method.toUpperCase() ||
    canonicalExpression(a.key, ctx.src) !== canonicalExpression(b.key, ctx.tgt)
  );
}

function renameTable(ctx: DiffContext, pair: TablePair): void {
  const statement = ctx.pg
    ? `ALTER TABLE ${qualified(ctx, pair.schema.name, pair.before)} RENAME TO ${quoteIdent(pair.after, ctx.dialect)}`
    : `RENAME TABLE ${quoteIdent(pair.before, ctx.dialect)} TO ${quoteIdent(pair.after, ctx.dialect)}`;
  const provides = [key.rel(pair.schema.key, pair.after)];
  for (const column of pair.source!.columns)
    provides.push(key.col(pair.schema.key, pair.after, column.name));
  const op = ctx.builder.add({
    id: `table:${tableDisplay(ctx, pair)}:rename`,
    kind: 'rename',
    objectKind: 'table',
    name: pair.after,
    qualifiedName: tableDisplay(ctx, pair),
    ...(ctx.pg ? { schema: pair.schema.name } : {}),
    steps: [
      step(PHASE.renameTable, [statement], {
        removes: [key.rel(pair.schema.key, pair.before)],
        provides,
      }),
    ],
    changes: [`name: ${pair.before} → ${pair.after}`],
  });
  noteRename(ctx.state, pair.after, op);
}

// ---------------------------------------------------------------------------------------------
// Columns

interface ColumnMatch {
  readonly source?: ColumnDef;
  readonly target?: ColumnDef;
  /** Target name when a user rename maps it. */
  readonly renamedFrom?: string;
}

function matchColumns(ctx: DiffContext, pair: TablePair): ColumnMatch[] {
  const source = pair.source!;
  const target = pair.target!;
  const targetByKey = new Map<string, ColumnDef>();
  for (const column of target.columns) {
    targetByKey.set(
      nameKey(pair.columnRenames.get(column.name) ?? column.name, ctx.options),
      column,
    );
  }
  const used = new Set<ColumnDef>();
  const matches: ColumnMatch[] = [];
  for (const column of source.columns) {
    const match = targetByKey.get(nameKey(column.name, ctx.options));
    if (match !== undefined) {
      used.add(match);
      const renamed = pair.columnRenames.has(match.name);
      matches.push({
        source: column,
        target: match,
        ...(renamed ? { renamedFrom: match.name } : {}),
      });
    } else {
      matches.push({ source: column });
    }
  }
  for (const column of target.columns) if (!used.has(column)) matches.push({ target: column });
  return matches;
}

/** The charset/collation a MySQL column effectively has, written explicitly in MODIFY/ADD. */
function effectiveMysqlCharset(
  column: ColumnDef,
  table: TableDef,
): { charset?: string; collation?: string } {
  if (!isMysqlTextType(column.dataType.toLowerCase().trim())) return {};
  const tableCharset = table.options.charset;
  const charset =
    column.charset ??
    (column.collation !== undefined ? column.collation.split('_')[0] : tableCharset);
  const collation =
    column.collation ??
    (charset !== undefined && canonicalCharset(charset) === canonicalCharset(tableCharset)
      ? table.options.collation
      : undefined);
  return {
    ...(charset !== undefined ? { charset } : {}),
    ...(collation !== undefined ? { collation } : {}),
  };
}

/**
 * A MariaDB target's column-level check of `column` (see `mariadbColumnCheck`); scripts treat
 * it as part of the column. Under the cross-family compare the JSON alias check of a MariaDB
 * side reads as the json type instead, and MariaDB adds it back for a json column by itself.
 */
function columnCheck(
  ctx: DiffContext,
  table: TableDef,
  nctx: NormalizeContext,
  column: ColumnDef,
): CheckDef | undefined {
  if (ctx.dialect !== 'mariadb') return undefined;
  const check = mariadbColumnCheck(table, column.name);
  if (
    check !== undefined &&
    nctx.crossFamily &&
    nctx.dialect === 'mariadb' &&
    isMariadbJsonCheck(check, column) &&
    canonicalType(column.dataType, nctx.dialect) === 'longtext'
  ) {
    return undefined;
  }
  return check;
}

/**
 * A MySQL column for ADD/MODIFY/CHANGE with its charset and collation written out, so the
 * result does not depend on the table default at that moment. When collations are ignored, the
 * target table's collation is used for the same charset (none otherwise). On MariaDB the
 * column's own check is written too: MODIFY and CHANGE would otherwise drop it.
 */
function mysqlColumnSql(
  ctx: DiffContext,
  pair: TablePair,
  column: ColumnDef,
  omitAutoIncrement = false,
): string {
  const effective = effectiveMysqlCharset(column, pair.source!);
  const check = columnCheck(ctx, pair.source!, ctx.src, column)?.expression;
  const checkOption = check !== undefined ? { check } : {};
  if (ctx.options.ignoreCollation) {
    const target = pair.target;
    const sameCharset =
      target !== undefined &&
      effective.charset !== undefined &&
      canonicalCharset(effective.charset) === canonicalCharset(target.options.charset);
    const { collation: _ignored, ...charsetOnly } = effective;
    return renderColumn(column, ctx.dialect, {
      ...charsetOnly,
      ...(sameCharset && target.options.collation !== undefined
        ? { collation: target.options.collation }
        : { omitCollation: true }),
      omitAutoIncrement,
      ...checkOption,
    });
  }
  return renderColumn(column, ctx.dialect, { ...effective, omitAutoIncrement, ...checkOption });
}

/** Longest common subsequence of two name lists (the columns that keep their relative order). */
function lcs(a: readonly string[], b: readonly string[]): Set<string> {
  const dp: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0),
  );
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const keep = new Set<string>();
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      keep.add(a[i]!);
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) i++;
    else j++;
  }
  return keep;
}

function canonicalTargetColumn(
  ctx: DiffContext,
  pair: TablePair,
  column: ColumnDef,
): CanonicalColumn {
  return canonicalColumn(column, pair.target!, ctx.tgt, ctx.pg ? pair.schema.name : undefined);
}

function canonicalSourceColumn(
  ctx: DiffContext,
  pair: TablePair,
  column: ColumnDef,
): CanonicalColumn {
  return canonicalColumn(column, pair.source!, ctx.src, ctx.pg ? pair.schema.name : undefined);
}

function diffColumns(ctx: DiffContext, pair: TablePair): void {
  const matches = matchColumns(ctx, pair);
  const source = pair.source!;
  const positionOps = new Map<string, OpDraft>();

  // MySQL column order: columns outside the longest common subsequence move (spec: AFTER/FIRST).
  const moved = new Set<string>();
  const positioned = !ctx.pg && !ctx.options.ignoreColumnOrder;
  if (positioned) {
    const kept = matches.filter((m) => m.source !== undefined && m.target !== undefined);
    const targetOrder = [...kept]
      .sort((a, b) => a.target!.ordinal - b.target!.ordinal)
      .map((m) => nameKey(m.source!.name, ctx.options));
    const sourceOrder = kept.map((m) => nameKey(m.source!.name, ctx.options));
    const stable = lcs(targetOrder, sourceOrder);
    for (const name of sourceOrder) if (!stable.has(name)) moved.add(name);
  }
  const positionClause = (column: ColumnDef): string => {
    const index = source.columns.indexOf(column);
    return index === 0
      ? ' FIRST'
      : ` AFTER ${quoteIdent(source.columns[index - 1]!.name, ctx.dialect)}`;
  };

  for (const match of matches) {
    if (match.source === undefined) dropColumn(ctx, pair, match.target!);
  }
  for (const match of matches) {
    if (match.source === undefined) continue;
    const column = match.source;
    const previous = source.columns[source.columns.indexOf(column) - 1];
    let op: OpDraft | undefined;
    if (match.target === undefined) {
      op = addColumn(ctx, pair, column, positioned ? positionClause(column) : '');
    } else {
      const isMoved = moved.has(nameKey(column.name, ctx.options));
      op = alterColumn(
        ctx,
        pair,
        match,
        isMoved ? positionClause(column) : '',
        positioned ? positionClause(column) : '',
      );
    }
    if (op !== undefined) positionOps.set(nameKey(column.name, ctx.options), op);
    if (op !== undefined && match.renamedFrom !== undefined) noteRename(ctx.state, column.name, op);
    // AFTER needs the previous column in place first.
    if (positioned && op !== undefined && previous !== undefined) {
      const previousOp = positionOps.get(nameKey(previous.name, ctx.options));
      if (previousOp !== undefined) {
        ctx.builder.order(previousOp, previousOp.steps.length - 1, op, op.steps.length - 1);
        if (previousOp.kind === 'create') op.requires.add(previousOp.id);
      }
    }
  }
}

function dropColumn(ctx: DiffContext, pair: TablePair, column: ColumnDef): void {
  const keys = colKeys(pair, column.name);
  const op = ctx.builder.add({
    id: `column:${tableDisplay(ctx, pair, column.name)}:drop`,
    kind: 'drop',
    objectKind: 'column',
    name: column.name,
    qualifiedName: tableDisplay(ctx, pair, column.name),
    parent: tableDisplay(ctx, pair),
    ...(ctx.pg ? { schema: pair.schema.name } : {}),
    steps: [
      step(
        PHASE.dropColumn,
        [
          `ALTER TABLE ${tableStatementName(ctx, pair, PHASE.dropColumn)} DROP COLUMN ${quoteIdent(column.name, ctx.dialect)}`,
        ],
        { removes: keys, targetRefs: columnRefs(ctx, pair, column), refs: relKeys(pair) },
      ),
    ],
    targetDdl: renderColumn(column, ctx.dialect),
    destructive: true,
    warnings: [
      {
        code: 'data-loss',
        message: `Drops column ${tableDisplay(ctx, pair, column.name)} and its data`,
      },
    ],
  });
  if (ctx.pg)
    ctx.state.blockers.push({
      op,
      step: 0,
      keys,
      reason: `${tableDisplay(ctx, pair, column.name)} is dropped`,
    });
}

function addColumn(
  ctx: DiffContext,
  pair: TablePair,
  column: ColumnDef,
  position: string,
): OpDraft {
  const table = tableStatementName(ctx, pair, PHASE.addColumn);
  const warnings: SyncWarning[] = crossFamilyColumnWarnings(ctx, column);
  if (
    !column.nullable &&
    column.default === null &&
    column.identity === undefined &&
    column.generated === undefined &&
    !column.autoIncrement
  ) {
    warnings.push({
      code: 'may-fail',
      message: 'Adding a NOT NULL column without a default fails when the table has rows',
    });
  }
  let statement: string;
  if (ctx.pg) {
    statement = `ALTER TABLE ${table} ADD COLUMN ${renderColumn(column, ctx.dialect)}`;
  } else {
    statement = `ALTER TABLE ${table} ADD COLUMN ${mysqlColumnSql(ctx, pair, column)}${position}`;
    const pk = pair.source!.primaryKey;
    if (column.autoIncrement && pk !== undefined && pk.columns.includes(column.name)) {
      // An AUTO_INCREMENT column must be a key in the same statement.
      const targetPk = pair.target!.primaryKey;
      statement += `${targetPk !== undefined ? ', DROP PRIMARY KEY' : ''}, ADD ${renderPrimaryKey(pk, ctx.dialect)}`;
      ctx.state.foldedPrimaryKeys.add(pair);
    }
  }
  const owned = ownedSequenceStatements(ctx, pair, column.name);
  return ctx.builder.add({
    id: `column:${tableDisplay(ctx, pair, column.name)}:create`,
    kind: 'create',
    objectKind: 'column',
    name: column.name,
    qualifiedName: tableDisplay(ctx, pair, column.name),
    parent: tableDisplay(ctx, pair),
    ...(ctx.pg ? { schema: pair.schema.name } : {}),
    steps: [
      step(PHASE.addColumn, [statement, ...owned.statements], {
        provides: colKeys(pair, column.name),
        refs: [...relKeys(pair).slice(-1), ...columnRefs(ctx, pair, column), ...owned.refs],
      }),
    ],
    sourceDdl: renderColumn(column, ctx.dialect),
    warnings,
  });
}

/**
 * MySQL and MariaDB cannot MODIFY a column between VIRTUAL and STORED or between VIRTUAL and
 * not generated ("not supported for generated columns"); such a column is dropped and added.
 */
function mysqlNeedsReadd(target: ColumnDef, source: ColumnDef): boolean {
  const kind = (c: ColumnDef): string =>
    c.generated === undefined ? 'plain' : c.generated.stored ? 'stored' : 'virtual';
  const a = kind(target);
  const b = kind(source);
  return a !== b && (a === 'virtual' || b === 'virtual');
}

/**
 * `position` moves the column (MySQL AFTER/FIRST); `placement` is where the column belongs,
 * used when it has to be dropped and added again.
 */
function alterColumn(
  ctx: DiffContext,
  pair: TablePair,
  match: ColumnMatch,
  position: string,
  placement: string,
): OpDraft | undefined {
  const column = match.source!;
  const target = match.target!;
  const a = canonicalTargetColumn(ctx, pair, target);
  const b = canonicalSourceColumn(ctx, pair, column);
  const changes = describeChanges(a, b);
  const targetCheck = columnCheck(ctx, pair.target!, ctx.tgt, target);
  const sourceCheck = columnCheck(ctx, pair.source!, ctx.src, column);
  const checkChanged =
    (targetCheck && canonicalCheck(targetCheck, ctx.tgt).expression) !==
    (sourceCheck && canonicalCheck(sourceCheck, ctx.src).expression);
  if (checkChanged) {
    changes.push(`check: ${show(targetCheck?.expression)} → ${show(sourceCheck?.expression)}`);
  }
  if (match.renamedFrom !== undefined)
    changes.unshift(`name: ${match.renamedFrom} → ${column.name}`);
  if (position !== '') changes.push(`position:${position.toLowerCase()}`);
  if (changes.length === 0) return undefined;

  const warnings: SyncWarning[] = crossFamilyColumnWarnings(ctx, column);
  if (checkChanged && sourceCheck !== undefined) {
    warnings.push({
      code: 'may-fail',
      message: 'Adding the check fails if existing rows violate it',
    });
  }
  let destructive = false;
  const risk = a.type !== b.type ? typeChangeRisk(a.type, b.type, ctx.dialect) : null;
  if (risk !== null) {
    if (risk.lossy) destructive = true;
    warnings.push({ code: risk.lossy ? 'data-loss' : 'may-fail', message: risk.message });
  }
  if (!ctx.pg && a.charset !== b.charset && a.charset !== null && b.charset !== 'utf8mb4') {
    destructive = true;
    warnings.push({
      code: 'data-loss',
      message: `Converting from ${a.charset} to ${b.charset ?? 'the table default'} can lose characters`,
    });
  }
  if (a.nullable && !b.nullable) {
    warnings.push({ code: 'may-fail', message: 'SET NOT NULL fails if the column holds NULLs' });
  }
  const keys = colKeys(pair, target.name, column.name);
  const refs = [...relKeys(pair).slice(-1), ...columnRefs(ctx, pair, column)];
  const targetRefs = columnRefs(ctx, pair, target);
  const reshapes =
    a.type !== b.type ||
    a.charset !== b.charset ||
    a.collation !== b.collation ||
    json(a.generated) !== json(b.generated);
  const reshapedKey = tableKey(pair.schema.key, `${pair.after}.${column.name}`);
  const base = {
    id: `column:${tableDisplay(ctx, pair, column.name)}:${match.renamedFrom !== undefined && changes.length === 1 ? 'rename' : 'alter'}`,
    kind: (match.renamedFrom !== undefined && changes.length === 1 ? 'rename' : 'alter') as
      'rename' | 'alter',
    objectKind: 'column' as const,
    name: column.name,
    qualifiedName: tableDisplay(ctx, pair, column.name),
    parent: tableDisplay(ctx, pair),
    ...(ctx.pg ? { schema: pair.schema.name } : {}),
    sourceDdl: renderColumn(column, ctx.dialect),
    targetDdl: renderColumn(target, ctx.dialect),
    changes,
  };

  // Names equal but for case (ignoreNameCase) keep the target's spelling: MODIFY would change it.
  const written: ColumnDef =
    match.renamedFrom === undefined && column.name !== target.name
      ? { ...column, name: target.name }
      : column;
  if (!ctx.pg && mysqlNeedsReadd(target, column)) {
    const table = tableStatementName(ctx, pair, PHASE.alterColumn);
    const phase = placement !== '' ? PHASE.addColumn : PHASE.alterColumn;
    warnings.push({
      code: 'info',
      message:
        'The column is dropped and re-added; indexes and checks on it are re-created after it',
    });
    if (target.generated === undefined || column.generated === undefined) {
      destructive = true;
      warnings.push({
        code: 'data-loss',
        message:
          column.generated === undefined
            ? 'The computed values are not kept: the column starts out with its default'
            : 'Stored values are replaced by the generation expression',
      });
    }
    const op = ctx.builder.add({
      ...base,
      steps: [
        step(
          phase,
          [
            `ALTER TABLE ${table} DROP COLUMN ${quoteIdent(target.name, ctx.dialect)}`,
            `ALTER TABLE ${table} ADD COLUMN ${mysqlColumnSql(ctx, pair, written)}${placement}`,
          ],
          {
            provides: keys,
            refs,
            targetRefs,
            ...(match.renamedFrom !== undefined
              ? { removes: colKeys(pair, match.renamedFrom) }
              : {}),
          },
        ),
      ],
      destructive,
      warnings,
    });
    ctx.state.readdedColumns.set(tableKey(pair.schema.key, `${pair.after}.${column.name}`), {
      op,
      step: 0,
    });
    ctx.state.retypedColumns.push({ table: pair, column: target.name, op });
    return op;
  }

  if (!ctx.pg) {
    // AUTO_INCREMENT needs a key on the column: it is removed before the target's keys are
    // dropped and added after the source's keys exist.
    const gains = !a.autoIncrement && b.autoIncrement;
    const loses = a.autoIncrement && !b.autoIncrement;
    /** Keys of a table that include the column named `name`: what AUTO_INCREMENT relies on. */
    const autoKeys = (t: TableDef, name: string): string[] => {
      const has = (c: string | null): boolean =>
        c !== null && nameKey(c, ctx.options) === nameKey(name, ctx.options);
      return [
        ...(t.primaryKey?.columns.some(has)
          ? [key.constraint(pair.schema.key, pair.after, t.primaryKey.name)]
          : []),
        ...t.indexes
          .filter((i) => i.columns.some((c) => has(c.name)))
          .map((i) => key.rel(pair.schema.key, i.name)),
      ];
    };
    const onlyAutoIncrement =
      json({ ...a, autoIncrement: false }) === json({ ...b, autoIncrement: false }) &&
      !checkChanged &&
      position === '' &&
      match.renamedFrom === undefined;
    const steps: StepDraft[] = [];
    if (loses) {
      const effective = effectiveMysqlCharset(target, pair.target!);
      const check = columnCheck(ctx, pair.target!, ctx.tgt, target)?.expression;
      steps.push(
        step(
          PHASE.dropForeignKey,
          [
            `ALTER TABLE ${tableStatementName(ctx, pair, PHASE.dropForeignKey)} MODIFY COLUMN ${renderColumn(target, ctx.dialect, { ...effective, omitAutoIncrement: true, ...(check !== undefined ? { check } : {}) })}`,
          ],
          { targetRefs: autoKeys(pair.target!, target.name) },
        ),
      );
    }
    if (!onlyAutoIncrement) {
      const table = tableStatementName(ctx, pair, PHASE.alterColumn);
      const definition = mysqlColumnSql(ctx, pair, written, gains);
      const statement =
        match.renamedFrom !== undefined
          ? `ALTER TABLE ${table} CHANGE COLUMN ${quoteIdent(match.renamedFrom, ctx.dialect)} ${definition}${position}`
          : `ALTER TABLE ${table} MODIFY COLUMN ${definition}${position}`;
      steps.push(
        step(position !== '' ? PHASE.addColumn : PHASE.alterColumn, [statement], {
          provides: keys,
          refs,
          targetRefs,
          ...(match.renamedFrom !== undefined ? { removes: colKeys(pair, match.renamedFrom) } : {}),
        }),
      );
    }
    if (gains) {
      steps.push(
        step(
          PHASE.alterTable,
          [
            `ALTER TABLE ${tableStatementName(ctx, pair, PHASE.alterTable)} MODIFY COLUMN ${mysqlColumnSql(ctx, pair, written)}`,
          ],
          { refs: [...refs, ...autoKeys(pair.source!, column.name)] },
        ),
      );
    }
    const op = ctx.builder.add({ ...base, steps, destructive, warnings });
    if (reshapes) {
      ctx.state.reshapedColumns.set(reshapedKey, op);
      ctx.state.retypedColumns.push({ table: pair, column: target.name, op });
    }
    return op;
  }

  const steps: StepDraft[] = [];
  if (match.renamedFrom !== undefined) {
    steps.push(
      step(
        PHASE.renameColumn,
        [
          `ALTER TABLE ${tableStatementName(ctx, pair, PHASE.renameColumn)} RENAME COLUMN ${quoteIdent(match.renamedFrom, ctx.dialect)} TO ${quoteIdent(column.name, ctx.dialect)}`,
        ],
        { removes: colKeys(pair, match.renamedFrom), provides: keys },
      ),
    );
  }
  const statements = pgColumnStatements(ctx, pair, target, column, a, b, warnings);
  if (statements.destructive) destructive = true;
  if (statements.dropIdentity !== undefined) {
    // The identity's implicit sequence (<table>_<column>_seq) goes with it, so a new sequence
    // of the same name (identity → serial) is created after this step.
    steps.push(
      step(PHASE.alterColumn, [statements.dropIdentity], {
        removes: [key.rel(pair.schema.key, `${pair.before}_${target.name}_seq`)],
        refs: relKeys(pair).slice(-1),
      }),
    );
  }
  if (statements.list.length > 0) {
    steps.push(step(PHASE.alterColumn, statements.list, { provides: keys, refs, targetRefs }));
  }
  if (steps.length === 0) return undefined;
  const op = ctx.builder.add({ ...base, steps, destructive, warnings });
  if (reshapes) ctx.state.reshapedColumns.set(reshapedKey, op);
  if (statements.readded) {
    ctx.state.readdedColumns.set(tableKey(pair.schema.key, `${pair.after}.${column.name}`), {
      op,
      step: steps.length - 1,
    });
  }
  if (statements.blocking) {
    ctx.state.blockers.push({
      op,
      step: steps.length - 1,
      keys: colKeys(pair, target.name, column.name),
      reason: `${tableDisplay(ctx, pair, column.name)} changes type`,
    });
  }
  return op;
}

/** PostgreSQL ALTER COLUMN statements, one subcommand per statement in a safe order. */
function pgColumnStatements(
  ctx: DiffContext,
  pair: TablePair,
  target: ColumnDef,
  column: ColumnDef,
  a: CanonicalColumn,
  b: CanonicalColumn,
  warnings: SyncWarning[],
): {
  list: string[];
  blocking: boolean;
  destructive: boolean;
  readded?: boolean;
  dropIdentity?: string;
} {
  const table = tableStatementName(ctx, pair, PHASE.alterColumn);
  const col = quoteIdent(column.name, ctx.dialect);
  const alter = (clause: string): string => `ALTER TABLE ${table} ALTER COLUMN ${col} ${clause}`;
  const list: string[] = [];
  let blocking = false;
  let destructive = false;

  const generatedChanged = json(a.generated) !== json(b.generated);
  if (generatedChanged && b.generated !== null) {
    if (a.generated !== null && a.generated.stored === b.generated.stored && pgMajor(ctx) >= 17) {
      list.push(alter(`SET EXPRESSION AS (${column.generated!.expression})`));
    } else {
      // Before PostgreSQL 17 a generation expression can only change by re-adding the column.
      list.push(`ALTER TABLE ${table} DROP COLUMN ${col}`);
      list.push(`ALTER TABLE ${table} ADD COLUMN ${renderColumn(column, ctx.dialect)}`);
      warnings.push({
        code: 'info',
        message:
          'The column is dropped and re-added; indexes, keys and checks on it are re-created after it',
      });
      if (a.generated === null) {
        destructive = true;
        warnings.push({
          code: 'data-loss',
          message: 'Stored values are replaced by the generation expression',
        });
      }
      if (column.comment !== undefined && column.comment !== '' && !ctx.options.ignoreComments) {
        list.push(renderPgComment(`COLUMN ${table}.${col}`, column.comment));
      }
      return { list, blocking: true, destructive, readded: true };
    }
  } else if (generatedChanged && a.generated !== null) {
    list.push(alter('DROP EXPRESSION'));
  }

  const typeChanged = a.type !== b.type;
  const collationChanged = a.collation !== b.collation;
  const defaultChanged = a.default !== b.default;
  const identityChanged = json(a.identity) !== json(b.identity);

  const dropIdentity =
    a.identity !== null && b.identity === null ? alter('DROP IDENTITY') : undefined;
  const dropDefaultFirst =
    a.default !== null && (typeChanged || (b.identity !== null && a.identity === null));
  if (dropDefaultFirst) list.push(alter('DROP DEFAULT'));
  if (typeChanged || collationChanged) {
    const risk = typeChanged ? typeChangeRisk(a.type, b.type, ctx.dialect) : null;
    const using = typeChanged && risk !== null ? ` USING ${col}::${column.dataType}` : '';
    const collate =
      column.collation !== undefined
        ? ` COLLATE ${quoteIdent(column.collation, ctx.dialect)}`
        : collationChanged
          ? ' COLLATE "default"'
          : '';
    list.push(alter(`TYPE ${column.dataType}${collate}${using}`));
    if (typeChanged) blocking = true;
  }
  if (a.nullable !== b.nullable) list.push(alter(b.nullable ? 'DROP NOT NULL' : 'SET NOT NULL'));
  if (identityChanged && b.identity !== null) {
    const identity = column.identity!;
    if (a.identity === null) {
      const generation = identity.generation === 'always' ? 'ALWAYS' : 'BY DEFAULT';
      const options: string[] = [];
      if (identity.start !== undefined) options.push(`START WITH ${identity.start}`);
      if (identity.increment !== undefined) options.push(`INCREMENT BY ${identity.increment}`);
      list.push(
        alter(
          `ADD GENERATED ${generation} AS IDENTITY${options.length > 0 ? ` (${options.join(' ')})` : ''}`,
        ),
      );
      if (a.default !== null && /nextval/i.test(a.default)) {
        // Converting a serial: continue numbering after the existing rows.
        list.push(
          `SELECT setval(pg_get_serial_sequence(${quoteString(table, 'postgres')}, ${quoteString(column.name, 'postgres')}), coalesce(max(${col}), 0) + 1, false) FROM ${table}`,
        );
        warnings.push({
          code: 'info',
          message: 'The new identity continues after the highest existing value',
        });
      }
    } else {
      const clauses: string[] = [];
      if (a.identity.generation !== b.identity.generation) {
        clauses.push(`SET GENERATED ${identity.generation === 'always' ? 'ALWAYS' : 'BY DEFAULT'}`);
      }
      if (a.identity.start !== b.identity.start) clauses.push(`SET START WITH ${b.identity.start}`);
      if (a.identity.increment !== b.identity.increment)
        clauses.push(`SET INCREMENT BY ${b.identity.increment}`);
      if (clauses.length > 0) list.push(alter(clauses.join(' ')));
    }
  }
  if (b.generated === null && (defaultChanged || dropDefaultFirst)) {
    if (column.default !== null) list.push(alter(`SET DEFAULT ${column.default}`));
    else if (!dropDefaultFirst && a.default !== null) list.push(alter('DROP DEFAULT'));
  }
  if (a.comment !== b.comment) {
    list.push(renderPgComment(`COLUMN ${table}.${col}`, column.comment));
  }
  return { list, blocking, destructive, ...(dropIdentity !== undefined ? { dropIdentity } : {}) };
}

function pgMajor(ctx: DiffContext): number {
  const match = /^(\d+)/.exec(ctx.targetVersion ?? '');
  return match ? Number(match[1]) : 0;
}

// ---------------------------------------------------------------------------------------------
// Keys, indexes and constraints: shared matching

/**
 * The re-added column (see pgColumnStatements) an unchanged index or constraint uses, if any:
 * PostgreSQL dropped it together with the column, so it must be created again.
 */
function readdedColumn(
  ctx: DiffContext,
  pair: TablePair,
  columns: readonly string[],
  text?: string,
): { op: OpDraft; step: number; column: string } | undefined {
  if (ctx.state.readdedColumns.size === 0) return undefined;
  const words = new Set(
    text === undefined ? [] : referencedNames(text, ctx.dialect).map((r) => r.name.toLowerCase()),
  );
  for (const column of pair.source!.columns) {
    const entry = ctx.state.readdedColumns.get(
      tableKey(pair.schema.key, `${pair.after}.${column.name}`),
    );
    if (entry === undefined) continue;
    if (columns.includes(column.name) || words.has(column.name.toLowerCase())) {
      return { ...entry, column: column.name };
    }
  }
  return undefined;
}

/**
 * Column alters an expression (index expression or predicate, check condition) needs: its
 * meaning depends on the column's type, e.g. `WHERE f > 0` only works once f is a number.
 * Unticking such an alter unticks the index or check, so the default selection still deploys.
 */
function expressionNeeds(ctx: DiffContext, pair: TablePair, texts: readonly string[]): string[] {
  if (ctx.state.reshapedColumns.size === 0) return [];
  const words = new Set(
    texts.flatMap((text) => referencedNames(text, ctx.dialect).map((r) => r.name.toLowerCase())),
  );
  const needs: string[] = [];
  for (const column of pair.source!.columns) {
    if (!words.has(column.name.toLowerCase())) continue;
    const op = ctx.state.reshapedColumns.get(
      tableKey(pair.schema.key, `${pair.after}.${column.name}`),
    );
    if (op !== undefined) needs.push(op.id);
  }
  return needs;
}

/** The expressions of an index: expression parts and the partial-index predicate. */
function indexExpressions(index: IndexDef): string[] {
  return [
    ...index.columns.flatMap((c) => (c.expression !== undefined ? [c.expression] : [])),
    ...(index.where !== undefined ? [index.where] : []),
  ];
}

/**
 * Re-creates an unchanged index or constraint that a re-added column took with it. PostgreSQL
 * drops it together with the column. MySQL and MariaDB would keep a multi-column index without
 * the column and refuse to drop a column a check uses, so `dropStatements` drop it first.
 */
function recreateAfterReadd(
  ctx: DiffContext,
  pair: TablePair,
  objectKind: 'primary-key' | 'unique' | 'index' | 'check',
  name: string,
  readd: { op: OpDraft; step: number; column: string },
  statements: string[],
  refs: string[],
  dropStatements: string[] = [],
): OpDraft {
  const steps: StepDraft[] = [];
  if (dropStatements.length > 0) steps.push(step(PHASE.dropConstraint, dropStatements));
  steps.push(step(PHASE.addConstraint, statements, { refs }));
  const op = subOp(ctx, pair, objectKind, name, 'alter', steps, {
    reason: `Re-created because ${tableDisplay(ctx, pair, readd.column)} is re-added`,
    warnings: [{ code: 'rebuild', message: 'Dropped with its column and created again' }],
    requires: new Set([readd.op.id]),
  });
  if (dropStatements.length > 0) ctx.builder.order(op, 0, readd.op, readd.step);
  ctx.builder.order(readd.op, readd.step, op, steps.length - 1);
  return op;
}

interface SubMatch<T> {
  readonly source?: T;
  readonly target?: T;
  /** Names differ but the definitions match (user rule or detected). */
  readonly renamed: boolean;
}

/**
 * Pairs indexes or constraints. With ignoreNames they pair by definition first; otherwise by
 * name, then user rename rules, then (when the engine can rename them) identical definitions.
 */
function matchSubObjects<T extends { name: string }>(
  ctx: DiffContext,
  pair: TablePair,
  kind: 'index' | 'constraint',
  sources: readonly T[],
  targets: readonly T[],
  canonSource: (item: T) => string,
  canonTarget: (item: T) => string,
  renamable: boolean,
): SubMatch<T>[] {
  const result: SubMatch<T>[] = [];
  const usedSources = new Set<T>();
  const usedTargets = new Set<T>();
  const take = (source: T | undefined, target: T | undefined, renamed: boolean): void => {
    if (source !== undefined) usedSources.add(source);
    if (target !== undefined) usedTargets.add(target);
    result.push({
      ...(source !== undefined ? { source } : {}),
      ...(target !== undefined ? { target } : {}),
      renamed,
    });
  };
  const byDefinition = (renamed: boolean): void => {
    for (const source of sources) {
      if (usedSources.has(source)) continue;
      const canon = canonSource(source);
      const target = targets.find((t) => !usedTargets.has(t) && canonTarget(t) === canon);
      if (target !== undefined)
        take(
          source,
          target,
          renamed && nameKey(target.name, ctx.options) !== nameKey(source.name, ctx.options),
        );
    }
  };
  const byName = (): void => {
    for (const source of sources) {
      if (usedSources.has(source)) continue;
      const target = targets.find(
        (t) =>
          !usedTargets.has(t) && nameKey(t.name, ctx.options) === nameKey(source.name, ctx.options),
      );
      if (target !== undefined) take(source, target, false);
    }
  };
  if (ctx.options.ignoreNames) {
    byDefinition(false);
    byName();
  } else {
    const schema = ctx.pg ? pair.schema.name : undefined;
    for (const target of targets) {
      const rule = findRename(ctx.options.renames, kind, schema, target.name, [
        pair.before,
        pair.after,
      ]);
      if (rule === undefined) continue;
      const source = sources.find(
        (s) =>
          !usedSources.has(s) && nameKey(s.name, ctx.options) === nameKey(rule.to, ctx.options),
      );
      if (source !== undefined) take(source, target, true);
    }
    byName();
    if (renamable && ctx.options.detectRenames) byDefinition(true);
  }
  for (const source of sources) if (!usedSources.has(source)) take(source, undefined, false);
  for (const target of targets) if (!usedTargets.has(target)) take(undefined, target, false);
  return result;
}

function mapColumns(pair: TablePair, columns: readonly string[]): string[] {
  return columns.map((c) => pair.columnRenames.get(c) ?? c);
}

function omitName(
  ctx: DiffContext,
  kind: Parameters<typeof isGeneratedName>[0],
  name: string,
  table: TableDef,
  columns: readonly string[],
): boolean {
  return ctx.options.ignoreNames && isGeneratedName(kind, name, table, ctx.dialect, columns);
}

function subOp(
  ctx: DiffContext,
  pair: TablePair,
  objectKind: 'primary-key' | 'unique' | 'index' | 'check' | 'foreign-key' | 'trigger',
  name: string,
  action: 'create' | 'drop' | 'alter' | 'rename',
  steps: StepDraft[],
  extra: Partial<OpDraft> = {},
): OpDraft {
  return ctx.builder.add({
    id: `${objectKind}:${tableDisplay(ctx, pair, name)}:${action}`,
    kind: action,
    objectKind,
    name,
    qualifiedName: tableDisplay(ctx, pair, name),
    parent: tableDisplay(ctx, pair),
    ...(ctx.pg ? { schema: pair.schema.name } : {}),
    steps,
    ...extra,
  });
}

function renameConstraintStep(
  ctx: DiffContext,
  pair: TablePair,
  from: string,
  to: string,
  removes: string[],
  provides: string[],
): StepDraft {
  return step(
    PHASE.renameConstraint,
    [
      `ALTER TABLE ${tableStatementName(ctx, pair, PHASE.renameConstraint)} RENAME CONSTRAINT ${quoteIdent(from, ctx.dialect)} TO ${quoteIdent(to, ctx.dialect)}`,
    ],
    { removes, provides },
  );
}

// ---------------------------------------------------------------------------------------------
// Primary keys and unique constraints

function keyColumnsKeys(pair: TablePair, columns: readonly string[]): string[] {
  return columns.flatMap((c) => colKeys(pair, c));
}

function diffPrimaryKey(ctx: DiffContext, pair: TablePair): void {
  if (ctx.state.foldedPrimaryKeys.has(pair)) return;
  const source = pair.source!.primaryKey;
  const target = pair.target!.primaryKey;
  if (source === undefined && target === undefined) return;
  const name = source?.name ?? target!.name;
  const table = pair.source!;
  const sourceDdl = source !== undefined ? renderPrimaryKey(source, ctx.dialect) : undefined;
  const targetDdl = target !== undefined ? renderPrimaryKey(target, ctx.dialect) : undefined;
  const ddl = {
    ...(sourceDdl !== undefined ? { sourceDdl } : {}),
    ...(targetDdl !== undefined ? { targetDdl } : {}),
  };
  const conKey = (n: string): string => key.constraint(pair.schema.key, pair.after, n);
  const dropSql = (at: number): string =>
    ctx.pg
      ? `ALTER TABLE ${tableStatementName(ctx, pair, at)} DROP CONSTRAINT ${quoteIdent(target!.name, ctx.dialect)}`
      : `ALTER TABLE ${tableStatementName(ctx, pair, at)} DROP PRIMARY KEY`;
  const addClause = (): string =>
    renderPrimaryKey(
      source!,
      ctx.dialect,
      omitName(ctx, 'primary-key', source!.name, table, source!.columns),
    );

  if (source !== undefined && target !== undefined) {
    const sameColumns =
      json(canonicalKey(source, ctx.src)) ===
      json(canonicalKey({ ...target, columns: mapColumns(pair, target.columns) }, ctx.tgt));
    const readdPk = sameColumns ? readdedColumn(ctx, pair, source.columns) : undefined;
    if (readdPk !== undefined) {
      recreateAfterReadd(
        ctx,
        pair,
        'primary-key',
        source.name,
        readdPk,
        [`ALTER TABLE ${tableStatementName(ctx, pair, PHASE.addConstraint)} ADD ${addClause()}`],
        keyColumnsKeys(pair, source.columns),
        ctx.pg ? [] : [dropSql(PHASE.dropConstraint)],
      );
      ctx.state.keyDrops.push({
        table: pair,
        columns: target.columns,
        op: readdPk.op,
        step: readdPk.step,
      });
      return;
    }
    if (sameColumns) {
      if (
        ctx.pg &&
        !ctx.options.ignoreNames &&
        nameKey(source.name, ctx.options) !== nameKey(target.name, ctx.options)
      ) {
        subOp(
          ctx,
          pair,
          'primary-key',
          source.name,
          'rename',
          [
            renameConstraintStep(
              ctx,
              pair,
              target.name,
              source.name,
              [conKey(target.name)],
              [conKey(source.name)],
            ),
          ],
          {
            ...ddl,
            changes: [`name: ${target.name} → ${source.name}`],
          },
        );
      }
      return;
    }
    const changes = [`columns: (${target.columns.join(', ')}) → (${source.columns.join(', ')})`];
    const droppedColumn = target.columns.some(
      (c) =>
        !pair.source!.columns.some(
          (s) =>
            nameKey(s.name, ctx.options) === nameKey(pair.columnRenames.get(c) ?? c, ctx.options),
        ),
    );
    let op: OpDraft;
    if (!ctx.pg && !droppedColumn) {
      op = subOp(
        ctx,
        pair,
        'primary-key',
        name,
        'alter',
        [
          step(
            PHASE.addConstraint,
            [
              `ALTER TABLE ${tableStatementName(ctx, pair, PHASE.addConstraint)} DROP PRIMARY KEY, ADD ${addClause()}`,
            ],
            {
              provides: [conKey(source.name)],
              refs: keyColumnsKeys(pair, source.columns),
            },
          ),
        ],
        { ...ddl, changes },
      );
      ctx.state.keyDrops.push({ table: pair, columns: target.columns, op, step: 0 });
      return;
    }
    op = subOp(
      ctx,
      pair,
      'primary-key',
      name,
      'alter',
      [
        step(PHASE.dropConstraint, [dropSql(PHASE.dropConstraint)], {
          removes: [conKey(target.name)],
        }),
        step(
          PHASE.addConstraint,
          [`ALTER TABLE ${tableStatementName(ctx, pair, PHASE.addConstraint)} ADD ${addClause()}`],
          {
            provides: [conKey(source.name)],
            refs: keyColumnsKeys(pair, source.columns),
          },
        ),
      ],
      { ...ddl, changes },
    );
    ctx.state.keyDrops.push({ table: pair, columns: target.columns, op, step: 0 });
    return;
  }
  if (source !== undefined) {
    subOp(
      ctx,
      pair,
      'primary-key',
      name,
      'create',
      [
        step(
          PHASE.addConstraint,
          [`ALTER TABLE ${tableStatementName(ctx, pair, PHASE.addConstraint)} ADD ${addClause()}`],
          {
            provides: [conKey(source.name)],
            refs: keyColumnsKeys(pair, source.columns),
          },
        ),
      ],
      ddl,
    );
    return;
  }
  const op = subOp(
    ctx,
    pair,
    'primary-key',
    name,
    'drop',
    [
      step(PHASE.dropConstraint, [dropSql(PHASE.dropConstraint)], {
        removes: [conKey(target!.name)],
      }),
    ],
    ddl,
  );
  ctx.state.keyDrops.push({ table: pair, columns: target!.columns, op, step: 0 });
}

function diffUniques(ctx: DiffContext, pair: TablePair): void {
  const table = pair.source!;
  const canonSource = (k: KeyDef): string => json(canonicalKey(k, ctx.src));
  const canonTarget = (k: KeyDef): string =>
    json(canonicalKey({ ...k, columns: mapColumns(pair, k.columns) }, ctx.tgt));
  const matches = matchSubObjects(
    ctx,
    pair,
    'constraint',
    pair.source!.uniques,
    pair.target!.uniques,
    canonSource,
    canonTarget,
    ctx.pg,
  );
  const conKey = (n: string): string =>
    ctx.pg ? key.constraint(pair.schema.key, pair.after, n) : key.rel(pair.schema.key, n);
  const add = (k: KeyDef): string => {
    const clause = renderUnique(k, ctx.dialect, omitName(ctx, 'unique', k.name, table, k.columns));
    return `ALTER TABLE ${tableStatementName(ctx, pair, PHASE.addConstraint)} ADD ${clause}`;
  };
  const drop = (k: KeyDef): string =>
    ctx.pg
      ? `ALTER TABLE ${tableStatementName(ctx, pair, PHASE.dropConstraint)} DROP CONSTRAINT ${quoteIdent(k.name, ctx.dialect)}`
      : `ALTER TABLE ${tableStatementName(ctx, pair, PHASE.dropConstraint)} DROP INDEX ${quoteIdent(k.name, ctx.dialect)}`;
  for (const m of matches) {
    const sourceDdl = m.source !== undefined ? renderUnique(m.source, ctx.dialect) : undefined;
    const targetDdl = m.target !== undefined ? renderUnique(m.target, ctx.dialect) : undefined;
    const ddl = {
      ...(sourceDdl !== undefined ? { sourceDdl } : {}),
      ...(targetDdl !== undefined ? { targetDdl } : {}),
    };
    if (m.source !== undefined && m.target !== undefined) {
      const readdUnique =
        canonSource(m.source) === canonTarget(m.target)
          ? readdedColumn(ctx, pair, m.source.columns)
          : undefined;
      if (readdUnique !== undefined) {
        recreateAfterReadd(
          ctx,
          pair,
          'unique',
          m.source.name,
          readdUnique,
          [add(m.source)],
          keyColumnsKeys(pair, m.source.columns),
          ctx.pg ? [] : [drop(m.target)],
        );
        ctx.state.keyDrops.push({
          table: pair,
          columns: m.target.columns,
          op: readdUnique.op,
          step: readdUnique.step,
        });
        continue;
      }
      if (canonSource(m.source) === canonTarget(m.target)) {
        if (m.renamed && !ctx.options.ignoreNames) {
          const renameStep = ctx.pg
            ? renameConstraintStep(
                ctx,
                pair,
                m.target.name,
                m.source.name,
                [conKey(m.target.name)],
                [conKey(m.source.name)],
              )
            : step(
                PHASE.renameConstraint,
                [
                  `ALTER TABLE ${tableStatementName(ctx, pair, PHASE.renameConstraint)} RENAME INDEX ${quoteIdent(m.target.name, ctx.dialect)} TO ${quoteIdent(m.source.name, ctx.dialect)}`,
                ],
                { removes: [conKey(m.target.name)], provides: [conKey(m.source.name)] },
              );
          subOp(ctx, pair, 'unique', m.source.name, 'rename', [renameStep], {
            ...ddl,
            changes: [`name: ${m.target.name} → ${m.source.name}`],
          });
        }
        continue;
      }
      const op = subOp(
        ctx,
        pair,
        'unique',
        m.source.name,
        'alter',
        [
          step(PHASE.dropConstraint, [drop(m.target)], { removes: [conKey(m.target.name)] }),
          step(PHASE.addConstraint, [add(m.source)], {
            provides: [conKey(m.source.name)],
            refs: keyColumnsKeys(pair, m.source.columns),
          }),
        ],
        {
          ...ddl,
          changes: [`columns: (${m.target.columns.join(', ')}) → (${m.source.columns.join(', ')})`],
        },
      );
      ctx.state.keyDrops.push({ table: pair, columns: m.target.columns, op, step: 0 });
    } else if (m.source !== undefined) {
      subOp(
        ctx,
        pair,
        'unique',
        m.source.name,
        'create',
        [
          step(PHASE.addConstraint, [add(m.source)], {
            provides: [conKey(m.source.name)],
            refs: keyColumnsKeys(pair, m.source.columns),
          }),
        ],
        ddl,
      );
    } else {
      const op = subOp(
        ctx,
        pair,
        'unique',
        m.target!.name,
        'drop',
        [step(PHASE.dropConstraint, [drop(m.target!)], { removes: [conKey(m.target!.name)] })],
        ddl,
      );
      ctx.state.keyDrops.push({ table: pair, columns: m.target!.columns, op, step: 0 });
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Indexes

function indexColumns(index: IndexDef): string[] {
  return index.columns.map((c) => c.name ?? '');
}

function mapIndex(pair: TablePair, index: IndexDef): IndexDef {
  if (pair.columnRenames.size === 0) return index;
  return {
    ...index,
    columns: index.columns.map((c) =>
      c.name !== null ? { ...c, name: pair.columnRenames.get(c.name) ?? c.name } : c,
    ),
    include: mapColumns(pair, index.include),
  };
}

/** MySQL: a foreign key that stays and needs this index (its columns lead the index). */
function backsRetainedForeignKey(ctx: DiffContext, pair: TablePair, index: IndexDef): boolean {
  if (ctx.pg) return false;
  const columns = indexColumns(index);
  return pair.target!.foreignKeys.some(
    (fk) =>
      fk.columns.every((c, i) => columns[i] === c) &&
      pair.source!.foreignKeys.some(
        (s) => fkSourceCanon(ctx, pair, s) === fkTargetCanon(ctx, pair, fk),
      ) &&
      !pair.target!.indexes.some(
        (other) => other !== index && fk.columns.every((c, i) => indexColumns(other)[i] === c),
      ),
  );
}

function diffIndexes(ctx: DiffContext, pair: TablePair): void {
  const table = pair.source!;
  const byDefinition =
    ctx.pg &&
    [...pair.source!.indexes, ...pair.target!.indexes].every((i) => i.definition !== undefined);
  const src = tableContext(pair.source!, ctx.src);
  const tgt = tableContext(pair.target!, ctx.tgt);
  const canonSource = (i: IndexDef, withComment = true): string => {
    const c = canonicalIndex(i, src, byDefinition);
    return json(withComment ? c : { ...c, comment: null, invisible: false });
  };
  const canonTarget = (i: IndexDef, withComment = true): string => {
    const c = canonicalIndex(mapIndex(pair, i), tgt, byDefinition);
    return json(withComment ? c : { ...c, comment: null, invisible: false });
  };
  const matches = matchSubObjects(
    ctx,
    pair,
    'index',
    pair.source!.indexes,
    pair.target!.indexes,
    (i) => canonSource(i),
    (i) => canonTarget(i),
    true,
  );
  const idxKey = (n: string): string => key.rel(pair.schema.key, n);
  const createSql = (index: IndexDef): string => {
    const omit = omitName(ctx, 'index', index.name, table, indexColumns(index));
    return ctx.pg
      ? renderPgCreateIndex(index, pair.after, pair.schema.name, omit)
      : `ALTER TABLE ${tableStatementName(ctx, pair, PHASE.addConstraint)} ADD ${renderMysqlIndexClause(index, ctx.dialect, omit)}`;
  };
  const createStatements = (index: IndexDef): string[] => {
    const statements = [createSql(index)];
    if (
      ctx.pg &&
      index.comment !== undefined &&
      index.comment !== '' &&
      !ctx.options.ignoreComments
    ) {
      statements.push(
        renderPgComment(`INDEX ${qualified(ctx, pair.schema.name, index.name)}`, index.comment),
      );
    }
    return statements;
  };
  const dropSql = (index: IndexDef): string =>
    ctx.pg
      ? `DROP INDEX ${qualified(ctx, pair.schema.name, index.name)}`
      : `ALTER TABLE ${tableStatementName(ctx, pair, PHASE.dropConstraint)} DROP INDEX ${quoteIdent(index.name, ctx.dialect)}`;
  const ddlOf = (index: IndexDef): string =>
    ctx.pg
      ? renderPgCreateIndex(index, pair.after, pair.schema.name)
      : renderMysqlIndexClause(index, ctx.dialect);
  const refsOf = (index: IndexDef): string[] => [
    ...keyColumnsKeys(
      pair,
      indexColumns(index).filter((c) => c !== ''),
    ),
    ...ctx.refs
      .resolve(
        index.definition ?? index.columns.map((c) => c.expression ?? '').join(' '),
        ctx.dialect,
      )
      .filter((k) => k.startsWith('fn:') || k.startsWith('col:')),
  ];

  for (const m of matches) {
    const ddl = {
      ...(m.source !== undefined ? { sourceDdl: ddlOf(m.source) } : {}),
      ...(m.target !== undefined ? { targetDdl: ddlOf(m.target) } : {}),
    };
    if (m.source !== undefined && m.target !== undefined) {
      const source = m.source;
      const target = m.target;
      const same = canonSource(source) === canonTarget(target);
      const sameShape = canonSource(source, false) === canonTarget(target, false);
      const steps: StepDraft[] = [];
      const changes: string[] = [];
      const renamed =
        !ctx.options.ignoreNames &&
        nameKey(source.name, ctx.options) !== nameKey(target.name, ctx.options) &&
        (same || sameShape);
      if (renamed) {
        steps.push(
          step(
            PHASE.renameConstraint,
            [
              ctx.pg
                ? `ALTER INDEX ${qualified(ctx, pair.schema.name, target.name)} RENAME TO ${quoteIdent(source.name, ctx.dialect)}`
                : `ALTER TABLE ${tableStatementName(ctx, pair, PHASE.renameConstraint)} RENAME INDEX ${quoteIdent(target.name, ctx.dialect)} TO ${quoteIdent(source.name, ctx.dialect)}`,
            ],
            { removes: [idxKey(target.name)], provides: [idxKey(source.name)] },
          ),
        );
        changes.push(`name: ${target.name} → ${source.name}`);
      }
      const readdIndex = same
        ? readdedColumn(
            ctx,
            pair,
            indexColumns(source),
            [
              source.definition ?? '',
              source.where ?? '',
              ...source.columns.map((c) => c.expression ?? ''),
            ].join(' '),
          )
        : undefined;
      if (readdIndex !== undefined) {
        recreateAfterReadd(
          ctx,
          pair,
          'index',
          source.name,
          readdIndex,
          createStatements(source),
          refsOf(source),
          ctx.pg ? [] : [dropSql(target)],
        );
        if (target.unique) {
          ctx.state.keyDrops.push({
            table: pair,
            columns: indexColumns(target),
            op: readdIndex.op,
            step: readdIndex.step,
          });
        }
        continue;
      }
      if (same) {
        if (steps.length > 0)
          subOp(ctx, pair, 'index', source.name, 'rename', steps, { ...ddl, changes });
        continue;
      }
      if (sameShape) {
        // Only the comment or visibility differs.
        const statements: string[] = [];
        if (ctx.pg) {
          statements.push(
            renderPgComment(
              `INDEX ${qualified(ctx, pair.schema.name, source.name)}`,
              source.comment,
            ),
          );
          changes.push(`comment: ${show(target.comment)} → ${show(source.comment)}`);
        } else if (
          source.invisible !== target.invisible &&
          (source.comment ?? '') === (target.comment ?? '')
        ) {
          const visibility =
            ctx.dialect === 'mariadb'
              ? source.invisible
                ? 'IGNORED'
                : 'NOT IGNORED'
              : source.invisible
                ? 'INVISIBLE'
                : 'VISIBLE';
          statements.push(
            `ALTER TABLE ${tableStatementName(ctx, pair, PHASE.alterTable)} ALTER INDEX ${quoteIdent(source.name, ctx.dialect)} ${visibility}`,
          );
          changes.push(`invisible: ${target.invisible} → ${source.invisible}`);
        }
        if (statements.length > 0) {
          steps.push(step(PHASE.alterTable, statements, { refs: [idxKey(source.name)] }));
          subOp(ctx, pair, 'index', source.name, 'alter', steps, { ...ddl, changes });
          continue;
        }
      }
      changes.push('definition changed');
      const drop = dropSql(target);
      const needs = { requires: new Set(expressionNeeds(ctx, pair, indexExpressions(source))) };
      const op =
        backsRetainedForeignKey(ctx, pair, target) &&
        nameKey(source.name, ctx.options) === nameKey(target.name, ctx.options)
          ? subOp(
              ctx,
              pair,
              'index',
              source.name,
              'alter',
              [
                step(
                  PHASE.addConstraint,
                  [`${drop}, ADD ${renderMysqlIndexClause(source, ctx.dialect)}`],
                  {
                    provides: [idxKey(source.name)],
                    refs: refsOf(source),
                  },
                ),
              ],
              { ...ddl, changes, ...needs },
            )
          : subOp(
              ctx,
              pair,
              'index',
              source.name,
              'alter',
              [
                step(PHASE.dropConstraint, [drop], { removes: [idxKey(target.name)] }),
                step(PHASE.addConstraint, createStatements(source), {
                  provides: [idxKey(source.name)],
                  refs: refsOf(source),
                }),
              ],
              { ...ddl, changes, ...needs },
            );
      if (target.unique)
        ctx.state.keyDrops.push({ table: pair, columns: indexColumns(target), op, step: 0 });
    } else if (m.source !== undefined) {
      subOp(
        ctx,
        pair,
        'index',
        m.source.name,
        'create',
        [
          step(PHASE.addConstraint, createStatements(m.source), {
            provides: [idxKey(m.source.name)],
            refs: refsOf(m.source),
          }),
        ],
        {
          ...ddl,
          requires: new Set(expressionNeeds(ctx, pair, indexExpressions(m.source))),
        },
      );
    } else {
      const target = m.target!;
      const op = subOp(
        ctx,
        pair,
        'index',
        target.name,
        'drop',
        [step(PHASE.dropConstraint, [dropSql(target)], { removes: [idxKey(target.name)] })],
        ddl,
      );
      if (target.unique)
        ctx.state.keyDrops.push({ table: pair, columns: indexColumns(target), op, step: 0 });
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Checks

function diffChecks(ctx: DiffContext, pair: TablePair): void {
  const table = pair.source!;
  const jsonChecks = (t: TableDef, nctx: NormalizeContext): CheckDef[] =>
    t.checks.filter(
      (check) =>
        !(
          nctx.crossFamily &&
          nctx.dialect === 'mariadb' &&
          t.columns.some(
            (c) => isMariadbJsonCheck(check, c) && /^longtext$/i.test(c.dataType.trim()),
          )
        ),
    );
  // MariaDB column-level checks change with their column (see columnCheck).
  const tableChecks = (t: TableDef, nctx: NormalizeContext): CheckDef[] =>
    jsonChecks(t, nctx).filter(
      (check) =>
        !(
          ctx.dialect === 'mariadb' &&
          t.columns.some((c) => mariadbColumnCheck(t, c.name) === check)
        ),
    );
  const sources = tableChecks(pair.source!, ctx.src);
  const targets = tableChecks(pair.target!, ctx.tgt);
  const src = tableContext(pair.source!, ctx.src);
  const tgt = tableContext(pair.target!, ctx.tgt);
  const canonSource = (c: CheckDef): string => json(canonicalCheck(c, src));
  const canonTarget = (c: CheckDef): string => json(canonicalCheck(c, tgt));
  const matches = matchSubObjects(
    ctx,
    pair,
    'constraint',
    sources,
    targets,
    canonSource,
    canonTarget,
    ctx.pg,
  );
  const conKey = (n: string): string => key.constraint(pair.schema.key, pair.after, n);
  const add = (c: CheckDef): string =>
    `ALTER TABLE ${tableStatementName(ctx, pair, PHASE.addConstraint)} ADD ${renderCheck(c, ctx.dialect, omitName(ctx, 'check', c.name, table, []))}`;
  const drop = (c: CheckDef): string => {
    const t = tableStatementName(ctx, pair, PHASE.dropConstraint);
    const name = quoteIdent(c.name, ctx.dialect);
    return ctx.dialect === 'mysql'
      ? `ALTER TABLE ${t} DROP CHECK ${name}`
      : `ALTER TABLE ${t} DROP CONSTRAINT ${name}`;
  };
  const refsOf = (c: CheckDef): string[] => ctx.refs.resolve(c.expression, ctx.dialect);
  for (const m of matches) {
    const ddl = {
      ...(m.source !== undefined ? { sourceDdl: renderCheck(m.source, ctx.dialect) } : {}),
      ...(m.target !== undefined ? { targetDdl: renderCheck(m.target, ctx.dialect) } : {}),
    };
    if (m.source !== undefined && m.target !== undefined) {
      const readdCheck =
        canonSource(m.source) === canonTarget(m.target)
          ? readdedColumn(ctx, pair, [], m.source.expression)
          : undefined;
      if (readdCheck !== undefined) {
        recreateAfterReadd(
          ctx,
          pair,
          'check',
          m.source.name,
          readdCheck,
          [add(m.source)],
          refsOf(m.source),
          ctx.pg ? [] : [drop(m.target)],
        );
        continue;
      }
      const checkRenamed =
        !ctx.options.ignoreNames &&
        nameKey(m.source.name, ctx.options) !== nameKey(m.target.name, ctx.options);
      // MySQL cannot rename a check: a renamed one is dropped and added again below.
      if (canonSource(m.source) === canonTarget(m.target) && (ctx.pg || !checkRenamed)) {
        if (checkRenamed) {
          subOp(
            ctx,
            pair,
            'check',
            m.source.name,
            'rename',
            [
              renameConstraintStep(
                ctx,
                pair,
                m.target.name,
                m.source.name,
                [conKey(m.target.name)],
                [conKey(m.source.name)],
              ),
            ],
            { ...ddl, changes: [`name: ${m.target.name} → ${m.source.name}`] },
          );
        }
        continue;
      }
      subOp(
        ctx,
        pair,
        'check',
        m.source.name,
        'alter',
        [
          step(PHASE.dropConstraint, [drop(m.target)], { removes: [conKey(m.target.name)] }),
          step(PHASE.addConstraint, [add(m.source)], {
            provides: [conKey(m.source.name)],
            refs: refsOf(m.source),
          }),
        ],
        {
          ...ddl,
          changes:
            canonSource(m.source) === canonTarget(m.target)
              ? [`name: ${m.target.name} → ${m.source.name}`]
              : [`expression: ${m.target.expression} → ${m.source.expression}`],
          warnings: [
            { code: 'may-fail', message: 'Adding the check fails if existing rows violate it' },
          ],
          requires: new Set(expressionNeeds(ctx, pair, [m.source.expression])),
        },
      );
    } else if (m.source !== undefined) {
      subOp(
        ctx,
        pair,
        'check',
        m.source.name,
        'create',
        [
          step(PHASE.addConstraint, [add(m.source)], {
            provides: [conKey(m.source.name)],
            refs: refsOf(m.source),
          }),
        ],
        {
          ...ddl,
          warnings: [
            { code: 'may-fail', message: 'Adding the check fails if existing rows violate it' },
          ],
          requires: new Set(expressionNeeds(ctx, pair, [m.source.expression])),
        },
      );
    } else {
      subOp(
        ctx,
        pair,
        'check',
        m.target!.name,
        'drop',
        [
          step(PHASE.dropConstraint, [drop(m.target!)], {
            removes: [conKey(m.target!.name)],
            targetRefs: refsOf(m.target!),
          }),
        ],
        ddl,
      );
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Foreign keys

function fkSourceCanon(ctx: DiffContext, pair: TablePair, fk: ForeignKeyDef): string {
  return json(canonicalForeignKey(fk, ctx.src, ctx.pg ? pair.schema.name : undefined));
}

function fkTargetCanon(ctx: DiffContext, pair: TablePair, fk: ForeignKeyDef): string {
  const refSchema = fk.refSchema ?? pair.schema.name;
  const refPair = ctx.state.tablesByTarget.get(tableKey(ctx.pg ? refSchema : '', fk.refTable));
  const mapped: ForeignKeyDef = {
    ...fk,
    columns: mapColumns(pair, fk.columns),
    refColumns: refPair !== undefined ? mapColumns(refPair, fk.refColumns) : fk.refColumns,
  };
  return json(
    canonicalForeignKey(mapped, ctx.tgt, ctx.pg ? pair.schema.name : undefined, (_s, table) =>
      refPair !== undefined && refPair.before === table ? refPair.after : table,
    ),
  );
}

function fkRefKeys(ctx: DiffContext, pair: TablePair, fk: ForeignKeyDef): string[] {
  const refSchema = ctx.pg ? (fk.refSchema ?? pair.schema.name) : '';
  return [
    key.rel(refSchema, fk.refTable),
    ...fk.refColumns.map((c) => key.col(refSchema, fk.refTable, c)),
    ...keyColumnsKeys(pair, fk.columns),
  ];
}

function fkConKey(pair: TablePair, name: string): string {
  return key.constraint(pair.schema.key, pair.after, `fk:${name}`);
}

function addForeignKeyStep(ctx: DiffContext, pair: TablePair, fk: ForeignKeyDef): StepDraft {
  const table = pair.source!;
  const clause = renderForeignKey(
    fk,
    ctx.dialect,
    ctx.pg ? pair.schema.name : undefined,
    omitName(ctx, 'foreign-key', fk.name, table, fk.columns),
  );
  return step(
    PHASE.addForeignKey,
    [`ALTER TABLE ${tableStatementName(ctx, pair, PHASE.addForeignKey)} ADD ${clause}`],
    {
      provides: [fkConKey(pair, fk.name)],
      refs: fkRefKeys(ctx, pair, fk),
    },
  );
}

function dropForeignKeyStep(ctx: DiffContext, pair: TablePair, fk: ForeignKeyDef): StepDraft {
  const t = tableStatementName(ctx, pair, PHASE.dropForeignKey);
  const name = quoteIdent(fk.name, ctx.dialect);
  const refSchema = ctx.pg ? (fk.refSchema ?? pair.schema.name) : '';
  return step(
    PHASE.dropForeignKey,
    [
      ctx.pg
        ? `ALTER TABLE ${t} DROP CONSTRAINT ${name}`
        : `ALTER TABLE ${t} DROP FOREIGN KEY ${name}`,
    ],
    {
      removes: [fkConKey(pair, fk.name)],
      targetRefs: [key.rel(refSchema, fk.refTable)],
    },
  );
}

function addForeignKey(ctx: DiffContext, pair: TablePair, fk: ForeignKeyDef): void {
  const op = subOp(
    ctx,
    pair,
    'foreign-key',
    fk.name,
    'create',
    [addForeignKeyStep(ctx, pair, fk)],
    {
      sourceDdl: renderForeignKey(fk, ctx.dialect, ctx.pg ? pair.schema.name : undefined),
      warnings: [
        {
          code: 'may-fail',
          message: 'Adding the foreign key fails if existing rows have no matching parent',
        },
      ],
    },
  );
  ctx.state.foreignKeys.push({ table: pair, source: fk, op });
}

function diffForeignKeys(ctx: DiffContext, pair: TablePair): void {
  const matches = matchSubObjects(
    ctx,
    pair,
    'constraint',
    pair.source!.foreignKeys,
    pair.target!.foreignKeys,
    (fk) => fkSourceCanon(ctx, pair, fk),
    (fk) => fkTargetCanon(ctx, pair, fk),
    ctx.pg,
  );
  const schema = ctx.pg ? pair.schema.name : undefined;
  for (const m of matches) {
    const ddl = {
      ...(m.source !== undefined
        ? { sourceDdl: renderForeignKey(m.source, ctx.dialect, schema) }
        : {}),
      ...(m.target !== undefined
        ? { targetDdl: renderForeignKey(m.target, ctx.dialect, schema) }
        : {}),
    };
    if (m.source !== undefined && m.target !== undefined) {
      const fkRenamed =
        !ctx.options.ignoreNames &&
        nameKey(m.source.name, ctx.options) !== nameKey(m.target.name, ctx.options);
      // MySQL cannot rename a foreign key: a renamed one is dropped and added again below.
      if (
        fkSourceCanon(ctx, pair, m.source) === fkTargetCanon(ctx, pair, m.target) &&
        (ctx.pg || !fkRenamed)
      ) {
        if (fkRenamed) {
          const op = subOp(
            ctx,
            pair,
            'foreign-key',
            m.source.name,
            'rename',
            [
              renameConstraintStep(
                ctx,
                pair,
                m.target.name,
                m.source.name,
                [fkConKey(pair, m.target.name)],
                [fkConKey(pair, m.source.name)],
              ),
            ],
            { ...ddl, changes: [`name: ${m.target.name} → ${m.source.name}`] },
          );
          ctx.state.foreignKeys.push({ table: pair, source: m.source, target: m.target, op });
        } else {
          ctx.state.foreignKeys.push({ table: pair, source: m.source, target: m.target });
        }
        continue;
      }
      const op = subOp(
        ctx,
        pair,
        'foreign-key',
        m.source.name,
        'alter',
        [dropForeignKeyStep(ctx, pair, m.target), addForeignKeyStep(ctx, pair, m.source)],
        {
          ...ddl,
          changes: [
            ...(fkRenamed ? [`name: ${m.target.name} → ${m.source.name}`] : []),
            ...describeChanges(
              JSON.parse(fkTargetCanon(ctx, pair, m.target)) as object,
              JSON.parse(fkSourceCanon(ctx, pair, m.source)) as object,
            ),
          ],
        },
      );
      ctx.state.foreignKeys.push({
        table: pair,
        source: m.source,
        target: m.target,
        op,
        dropStep: 0,
      });
    } else if (m.source !== undefined) {
      addForeignKey(ctx, pair, m.source);
    } else {
      const op = subOp(
        ctx,
        pair,
        'foreign-key',
        m.target!.name,
        'drop',
        [dropForeignKeyStep(ctx, pair, m.target!)],
        ddl,
      );
      ctx.state.foreignKeys.push({ table: pair, target: m.target!, op, dropStep: 0 });
    }
  }
}

/**
 * Foreign keys of dropped tables that point at other dropped tables are dropped first, so the
 * tables can go in any order (PostgreSQL refuses to drop a referenced table).
 */
export function dropForeignKeysBetweenDroppedTables(
  ctx: DiffContext,
  dropped: readonly { pair: TablePair; op: OpDraft }[],
): void {
  const droppedKeys = new Map(dropped.map((d) => [tableKey(d.pair.schema.key, d.pair.before), d]));
  for (const { pair } of dropped) {
    for (const fk of pair.target!.foreignKeys) {
      const refKey = tableKey(ctx.pg ? (fk.refSchema ?? pair.schema.name) : '', fk.refTable);
      const referenced = droppedKeys.get(refKey);
      if (referenced === undefined || referenced.pair === pair) continue;
      const op = subOp(
        ctx,
        pair,
        'foreign-key',
        fk.name,
        'drop',
        [dropForeignKeyStep(ctx, pair, fk)],
        {
          targetDdl: renderForeignKey(fk, ctx.dialect, ctx.pg ? pair.schema.name : undefined),
          reason: `Lets ${displayName(ctx, referenced.pair.schema.name, referenced.pair.before)} be dropped`,
        },
      );
      referenced.op.requires.add(op.id);
      ctx.builder.order(op, 0, referenced.op, 0);
    }
  }
}

/**
 * Keys dropped or recreated while foreign keys still reference them: the foreign keys are
 * dropped first and re-added after (PostgreSQL refuses otherwise).
 */
export function rebuildReferencingForeignKeys(ctx: DiffContext): void {
  for (const drop of ctx.state.keyDrops) {
    const refSchema = drop.table.schema.name;
    const columns = [...drop.columns].sort().join(',');
    for (const entry of ctx.state.foreignKeys) {
      const fk = entry.target;
      if (fk === undefined) continue;
      const fkRefSchema = ctx.pg ? (fk.refSchema ?? entry.table.schema.name) : '';
      if (
        tableKey(fkRefSchema, fk.refTable) !== tableKey(ctx.pg ? refSchema : '', drop.table.before)
      )
        continue;
      if ([...fk.refColumns].sort().join(',') !== columns) continue;
      if (entry.op !== undefined && entry.dropStep !== undefined) {
        ctx.builder.order(entry.op, entry.dropStep, drop.op, drop.step);
        if (entry.op !== drop.op) drop.op.requires.add(entry.op.id);
        continue;
      }
      if (entry.source === undefined) continue;
      const op = subOp(
        ctx,
        entry.table,
        'foreign-key',
        entry.source.name,
        'alter',
        [
          dropForeignKeyStep(ctx, entry.table, fk),
          addForeignKeyStep(ctx, entry.table, entry.source),
        ],
        {
          sourceDdl: renderForeignKey(
            entry.source,
            ctx.dialect,
            ctx.pg ? entry.table.schema.name : undefined,
          ),
          targetDdl: renderForeignKey(
            fk,
            ctx.dialect,
            ctx.pg ? entry.table.schema.name : undefined,
          ),
          reason: `Rebuilt because the key it references on ${displayName(ctx, drop.table.schema.name, drop.table.after)} changes`,
          warnings: [
            {
              code: 'rebuild',
              message: 'Dropped and re-added around the change of the referenced key',
            },
          ],
          requires: new Set([drop.op.id]),
        },
      );
      entry.op = op;
      entry.dropStep = 0;
      ctx.builder.order(op, 0, drop.op, drop.step);
      drop.op.requires.add(op.id);
    }
  }
}

/**
 * MySQL and MariaDB refuse to change the type of a column a foreign key uses, on either end
 * ("Cannot change column used in a foreign key constraint"), even with FOREIGN_KEY_CHECKS = 0.
 * Such foreign keys are dropped before the column changes and added again after it.
 */
export function rebuildForeignKeysOfRetypedColumns(ctx: DiffContext): void {
  const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();
  for (const retype of ctx.state.retypedColumns) {
    for (const entry of ctx.state.foreignKeys) {
      const fk = entry.target;
      if (fk === undefined) continue;
      const referencing =
        entry.table === retype.table && fk.columns.some((c) => same(c, retype.column));
      const referenced =
        fk.refSchema === undefined &&
        same(fk.refTable, retype.table.before) &&
        fk.refColumns.some((c) => same(c, retype.column));
      if (!referencing && !referenced) continue;
      if (entry.op !== undefined && entry.dropStep !== undefined) {
        ctx.builder.order(entry.op, entry.dropStep, retype.op, 0);
        if (entry.op !== retype.op) retype.op.requires.add(entry.op.id);
        continue;
      }
      if (entry.source === undefined) continue;
      const op = subOp(
        ctx,
        entry.table,
        'foreign-key',
        entry.source.name,
        'alter',
        [
          dropForeignKeyStep(ctx, entry.table, fk),
          addForeignKeyStep(ctx, entry.table, entry.source),
        ],
        {
          sourceDdl: renderForeignKey(entry.source, ctx.dialect),
          targetDdl: renderForeignKey(fk, ctx.dialect),
          reason: `Rebuilt because ${displayName(ctx, retype.table.schema.name, retype.table.after, retype.column)} changes type`,
          warnings: [
            { code: 'rebuild', message: 'Dropped and re-added around the column type change' },
          ],
          requires: new Set([retype.op.id]),
        },
      );
      entry.op = op;
      entry.dropStep = 0;
      ctx.builder.order(op, 0, retype.op, 0);
      ctx.builder.order(retype.op, retype.op.steps.length - 1, op, 1);
      retype.op.requires.add(op.id);
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Triggers

function createTrigger(ctx: DiffContext, pair: TablePair, trigger: TriggerDef): void {
  const op = subOp(
    ctx,
    pair,
    'trigger',
    trigger.name,
    'create',
    [createTriggerStep(ctx, pair, trigger)],
    {
      sourceDdl: renderTrigger(trigger, ctx.dialect),
    },
  );
  ctx.state.triggers.push({ table: pair, source: trigger, op });
}

export function createTriggerStep(
  ctx: DiffContext,
  pair: TablePair,
  trigger: TriggerDef,
): StepDraft {
  return step(PHASE.createTrigger, [renderTrigger(trigger, ctx.dialect)], {
    provides: [key.trigger(pair.schema.key, pair.after, trigger.name)],
    refs: [...relKeys(pair).slice(-1), ...ctx.refs.resolve(trigger.definition, ctx.dialect)],
  });
}

export function dropTriggerStep(ctx: DiffContext, pair: TablePair, trigger: TriggerDef): StepDraft {
  return step(
    PHASE.dropTrigger,
    [renderDropTrigger(trigger, pair.before, ctx.dialect, ctx.pg ? pair.schema.name : undefined)],
    {
      removes: [key.trigger(pair.schema.key, pair.before, trigger.name)],
      targetRefs: ctx.refs.resolve(trigger.definition, ctx.dialect),
    },
  );
}

function diffTriggers(ctx: DiffContext, pair: TablePair): void {
  const byName = new Map(pair.target!.triggers.map((t) => [nameKey(t.name, ctx.options), t]));
  const seen = new Set<TriggerDef>();
  for (const trigger of pair.source!.triggers) {
    const target = byName.get(nameKey(trigger.name, ctx.options));
    if (target === undefined) {
      createTrigger(ctx, pair, trigger);
      continue;
    }
    seen.add(target);
    const a = canonicalTrigger(target, ctx.tgt).definition;
    const b = canonicalTrigger(trigger, ctx.src).definition;
    if (a === b && mysqlTriggerBodyUsesRenames(target, ctx.tgt)) {
      rebuildRenamedTrigger(ctx, pair, trigger, target);
      continue;
    }
    if (a === b) {
      ctx.state.triggers.push({ table: pair, source: trigger, target });
      continue;
    }
    const op = subOp(
      ctx,
      pair,
      'trigger',
      trigger.name,
      'alter',
      [dropTriggerStep(ctx, pair, target), createTriggerStep(ctx, pair, trigger)],
      {
        sourceDdl: renderTrigger(trigger, ctx.dialect),
        targetDdl: renderTrigger(target, ctx.dialect),
        changes: ['definition changed'],
      },
    );
    ctx.state.triggers.push({ table: pair, source: trigger, target, op, dropStep: 0 });
  }
  for (const target of pair.target!.triggers) {
    if (seen.has(target)) continue;
    const op = subOp(
      ctx,
      pair,
      'trigger',
      target.name,
      'drop',
      [dropTriggerStep(ctx, pair, target)],
      {
        targetDdl: renderTrigger(target, ctx.dialect),
        destructive: true,
        warnings: [{ code: 'data-loss', message: `Drops trigger ${target.name} and its code` }],
      },
    );
    ctx.state.triggers.push({ table: pair, target, op, dropStep: 0 });
  }
}

/**
 * A MySQL/MariaDB trigger equal to its source once renames are applied, whose body uses a
 * renamed column or table: the server does not rewrite the body, so it is re-created from the
 * source definition after the renames (see `orderTriggersAfterRenames`).
 */
function rebuildRenamedTrigger(
  ctx: DiffContext,
  pair: TablePair,
  trigger: TriggerDef,
  target: TriggerDef,
): void {
  const server = ctx.dialect === 'mariadb' ? 'MariaDB' : 'MySQL';
  const op = subOp(
    ctx,
    pair,
    'trigger',
    trigger.name,
    'alter',
    [dropTriggerStep(ctx, pair, target), createTriggerStep(ctx, pair, trigger)],
    {
      id: `trigger:${tableDisplay(ctx, pair, trigger.name)}:rebuild`,
      sourceDdl: renderTrigger(trigger, ctx.dialect),
      targetDdl: renderTrigger(target, ctx.dialect),
      changes: ['definition follows the rename'],
      reason: 'Re-created because its body uses a renamed column or table',
      warnings: [
        {
          code: 'rebuild',
          message: `${server} does not update trigger bodies when a column or table is renamed: the trigger is re-created with the new names`,
        },
      ],
    },
  );
  ctx.state.triggers.push({ table: pair, source: trigger, target, op, dropStep: 0 });
}

/**
 * MySQL/MariaDB check the NEW and OLD columns of a trigger when it is created, so a trigger
 * created from the source definition needs every rename that gives a name it uses (a column
 * rename that also changes the type is an alter, which step references alone do not require).
 */
export function orderTriggersAfterRenames(ctx: DiffContext): void {
  if (ctx.state.renamedBy.size === 0) return;
  for (const entry of ctx.state.triggers) {
    if (entry.op === undefined || entry.source === undefined) continue;
    const names = new Set(
      referencedNames(entry.source.definition, ctx.dialect).map((r) => r.name.toLowerCase()),
    );
    for (const name of names) {
      for (const op of ctx.state.renamedBy.get(name) ?? []) {
        if (op !== entry.op) entry.op.requires.add(op.id);
      }
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Table options, comments, partitions

function diffTableOptions(ctx: DiffContext, pair: TablePair): void {
  const source = pair.source!;
  const target = pair.target!;
  const a = canonicalTableOptions(target, ctx.tgt);
  const b = canonicalTableOptions(source, ctx.src);
  for (const optional of OPTIONAL_TABLE_OPTIONS) {
    if (a[optional] === undefined || b[optional] === undefined) {
      delete a[optional];
      delete b[optional];
    }
  }
  const changes = describeChanges(a, b);
  if (changes.length === 0) return;
  const changed = (k: string): boolean => a[k] !== b[k];
  const table = tableStatementName(ctx, pair, PHASE.alterTable);
  const statements: string[] = [];
  if (!ctx.pg) {
    const clauses: string[] = [];
    const o = source.options;
    if (changed('engine') && o.engine !== undefined) clauses.push(`ENGINE=${o.engine}`);
    if (changed('charset') || changed('collation')) {
      if (o.charset !== undefined) clauses.push(`DEFAULT CHARSET=${o.charset}`);
      if (o.collation !== undefined && !ctx.options.ignoreCollation) {
        clauses.push(`COLLATE=${o.collation}`);
      }
    }
    if (changed('rowformat')) {
      const declared = Object.entries(o).find(
        ([k]) => k.toLowerCase().replace(/_/g, '') === 'rowformat',
      )?.[1];
      clauses.push(`ROW_FORMAT=${(declared ?? 'DEFAULT').toUpperCase()}`);
    }
    if (changed('autoincrement') && o.autoIncrement !== undefined)
      clauses.push(`AUTO_INCREMENT=${o.autoIncrement}`);
    if (changed('comment'))
      clauses.push(`COMMENT=${quoteString(source.comment ?? '', ctx.dialect)}`);
    if (clauses.length > 0) statements.push(`ALTER TABLE ${table} ${clauses.join(' ')}`);
  } else {
    const sourceParams = new Map(pgStorageEntries(source));
    const targetParams = new Map(pgStorageEntries(target));
    const set = [...sourceParams].filter(([k, v]) => targetParams.get(k) !== v);
    const reset = [...targetParams.keys()].filter((k) => !sourceParams.has(k));
    if (set.length > 0) statements.push(`ALTER TABLE ${table} SET (${pgStorageParameters(set)})`);
    if (reset.length > 0) statements.push(`ALTER TABLE ${table} RESET (${reset.join(', ')})`);
    if (changed('tablespace')) {
      statements.push(
        `ALTER TABLE ${table} SET TABLESPACE ${quoteIdent(source.options.tablespace ?? 'pg_default', ctx.dialect)}`,
      );
    }
    if (changed('comment')) statements.push(renderPgComment(`TABLE ${table}`, source.comment));
    if (changed('owner') && source.owner !== undefined) {
      statements.push(`ALTER TABLE ${table} OWNER TO ${quoteIdent(source.owner, ctx.dialect)}`);
    }
  }
  if (statements.length === 0) return;
  const warnings: SyncWarning[] = [];
  if (!ctx.pg && changed('engine'))
    warnings.push({ code: 'info', message: 'Changing the engine rebuilds the table' });
  const counter = (value: string | undefined): bigint | undefined =>
    value !== undefined && /^\d+$/.test(value) ? BigInt(value) : undefined;
  const from = counter(target.options.autoIncrement);
  const to = counter(source.options.autoIncrement);
  if (!ctx.pg && changed('autoincrement') && from !== undefined && to !== undefined && to < from) {
    // The server sets the counter to at least the highest existing value + 1.
    warnings.push({
      code: 'may-fail',
      message: `AUTO_INCREMENT cannot go below the highest existing ${source.name} value + 1; with larger values in the table the counter stays there and the tables keep differing`,
    });
  }
  ctx.builder.add({
    id: `table:${tableDisplay(ctx, pair)}:alter`,
    kind: 'alter',
    objectKind: 'table',
    name: source.name,
    qualifiedName: tableDisplay(ctx, pair),
    ...(ctx.pg ? { schema: pair.schema.name } : {}),
    steps: [step(PHASE.alterTable, statements, { refs: relKeys(pair).slice(-1) })],
    sourceDdl: tableDdl(ctx, source, pair.schema.name),
    targetDdl: tableDdl(ctx, target, pair.schema.name),
    changes,
    warnings,
  });
}

type BoundValue =
  { readonly kind: 'min' | 'max' } | { readonly kind: 'value'; readonly value: string | number };

/** The parenthesised value lists of a PostgreSQL partition bound, e.g. FROM (a) TO (b). */
function boundLists(bound: string): BoundValue[][] | undefined {
  const tokens = tokenizeSql(bound, 'postgres').filter(
    (t) => t.kind !== 'ws' && t.kind !== 'comment',
  );
  const lists: BoundValue[][] = [];
  let current: BoundValue[] | undefined;
  let item: string[] = [];
  const flush = (): boolean => {
    const text = item.join('');
    item = [];
    if (text === '') return true;
    if (/^minvalue$/i.test(text)) current!.push({ kind: 'min' });
    else if (/^maxvalue$/i.test(text)) current!.push({ kind: 'max' });
    else if (/^-?\d+(\.\d+)?$/.test(text)) current!.push({ kind: 'value', value: Number(text) });
    else if (/^'(?:[^']|'')*'(::[\w ]+)?$/.test(text))
      current!.push({
        kind: 'value',
        value: text.slice(1, text.lastIndexOf("'")).replaceAll("''", "'"),
      });
    else return false;
    return true;
  };
  for (const t of tokens) {
    if (t.text === '(') {
      if (current !== undefined) return undefined;
      current = [];
    } else if (t.text === ')') {
      if (current === undefined || !flush()) return undefined;
      lists.push(current);
      current = undefined;
    } else if (current !== undefined) {
      if (t.text === ',') {
        if (!flush()) return undefined;
      } else {
        item.push(t.text);
      }
    }
  }
  return lists;
}

function compareBound(a: BoundValue, b: BoundValue): number {
  const rank = (v: BoundValue): number => (v.kind === 'min' ? -1 : v.kind === 'max' ? 1 : 0);
  if (a.kind !== 'value' || b.kind !== 'value') return rank(a) - rank(b);
  if (typeof a.value === 'number' && typeof b.value === 'number') return a.value - b.value;
  const x = String(a.value);
  const y = String(b.value);
  return x < y ? -1 : x > y ? 1 : 0;
}

/**
 * Whether two PostgreSQL partitions of one table could claim the same rows, so creating one
 * needs the other dropped first. Single-column range and list bounds with literal values and
 * hash bounds are compared; anything else counts as overlapping.
 */
export function partitionsOverlap(a: string | undefined, b: string | undefined): boolean {
  const isDefault = (x: string | undefined): boolean =>
    x === undefined || /^\s*default\s*$/i.test(x);
  if (isDefault(a) || isDefault(b)) return isDefault(a) && isDefault(b);
  const hash = (x: string): [number, number] | undefined => {
    const m = /modulus\s+(\d+)\s*,\s*remainder\s+(\d+)/i.exec(x);
    return m ? [Number(m[1]), Number(m[2])] : undefined;
  };
  const ha = hash(a!);
  const hb = hash(b!);
  if (ha !== undefined && hb !== undefined) {
    const gcd = (x: number, y: number): number => (y === 0 ? x : gcd(y, x % y));
    const g = gcd(ha[0], hb[0]);
    return ha[1] % g === hb[1] % g;
  }
  const la = boundLists(a!);
  const lb = boundLists(b!);
  if (la === undefined || lb === undefined) return true;
  const range = (x: string): boolean => /\bfrom\b/i.test(x) && /\bto\b/i.test(x);
  if (range(a!) && range(b!) && la.length === 2 && lb.length === 2) {
    if ([...la, ...lb].some((list) => list.length !== 1)) return true;
    const [fromA, toA] = [la[0]![0]!, la[1]![0]!];
    const [fromB, toB] = [lb[0]![0]!, lb[1]![0]!];
    return compareBound(fromA, toB) < 0 && compareBound(fromB, toA) < 0;
  }
  if (/\bin\b/i.test(a!) && /\bin\b/i.test(b!) && la.length === 1 && lb.length === 1) {
    return la[0]!.some((x) => lb[0]!.some((y) => compareBound(x, y) === 0));
  }
  return true;
}

function diffPartitions(ctx: DiffContext, pair: TablePair): void {
  const source = pair.source!;
  const target = pair.target!;
  if (ctx.pg) {
    if (
      ctx.options.ignorePartitions ||
      source.partitioning === undefined ||
      target.partitioning === undefined
    )
      return;
    if (partitionShapeChanged(ctx, source, target)) return;
    const targetParts = new Map(
      target.partitioning.partitions.map((p) => [nameKey(p.name, ctx.options), p]),
    );
    const sourceParts = new Set(
      source.partitioning.partitions.map((p) => nameKey(p.name, ctx.options)),
    );
    const bound = (b: string | undefined): string => canonicalExpression(b ?? 'DEFAULT', ctx.src);
    for (const partition of source.partitioning.partitions) {
      const existing = targetParts.get(nameKey(partition.name, ctx.options));
      const create = step(
        PHASE.createPartition,
        [renderPgPartition(pair.after, partition, pair.schema.name)],
        {
          provides: [key.rel(pair.schema.key, partition.name)],
          refs: relKeys(pair).slice(-1),
        },
      );
      const display = displayName(ctx, pair.schema.name, partition.name);
      const base = {
        objectKind: 'partition' as const,
        name: partition.name,
        qualifiedName: display,
        parent: tableDisplay(ctx, pair),
        schema: pair.schema.name,
        sourceDdl: renderPgPartition(pair.after, partition, pair.schema.name),
      };
      if (existing === undefined) {
        // A new partition cannot overlap one that stays: it needs those drops.
        const overlapping = target.partitioning.partitions
          .filter((p) => !sourceParts.has(nameKey(p.name, ctx.options)))
          .filter((p) => partitionsOverlap(p.bound, partition.bound))
          .map((p) => `partition:${displayName(ctx, pair.schema.name, p.name)}:drop`);
        ctx.builder.add({
          ...base,
          id: `partition:${display}:create`,
          kind: 'create',
          steps: [create],
          requires: new Set(overlapping),
        });
      } else if (bound(existing.bound) !== bound(partition.bound)) {
        ctx.builder.add({
          ...base,
          id: `partition:${display}:alter`,
          kind: 'alter',
          targetDdl: renderPgPartition(pair.before, existing, pair.schema.name),
          steps: [
            step(
              PHASE.dropTable,
              [`DROP TABLE ${qualified(ctx, pair.schema.name, existing.name)}`],
              { removes: [key.rel(pair.schema.key, existing.name)] },
            ),
            create,
          ],
          destructive: true,
          changes: [`bound: ${existing.bound ?? 'DEFAULT'} → ${partition.bound ?? 'DEFAULT'}`],
          warnings: [
            { code: 'data-loss', message: `Recreating partition ${display} drops its rows` },
          ],
        });
      }
    }
    for (const partition of target.partitioning.partitions) {
      if (sourceParts.has(nameKey(partition.name, ctx.options))) continue;
      const display = displayName(ctx, pair.schema.name, partition.name);
      ctx.builder.add({
        id: `partition:${display}:drop`,
        kind: 'drop',
        objectKind: 'partition',
        name: partition.name,
        qualifiedName: display,
        parent: tableDisplay(ctx, pair),
        schema: pair.schema.name,
        targetDdl: renderPgPartition(pair.before, partition, pair.schema.name),
        steps: [
          step(
            PHASE.dropTable,
            [`DROP TABLE ${qualified(ctx, pair.schema.name, partition.name)}`],
            { removes: [key.rel(pair.schema.key, partition.name)] },
          ),
        ],
        destructive: true,
        warnings: [{ code: 'data-loss', message: `Drops partition ${display} and its rows` }],
      });
    }
    return;
  }
  if (ctx.options.ignorePartitions) return;
  const canon = (t: TableDef, nctx: NormalizeContext): string =>
    t.partitioning === undefined
      ? ''
      : json({
          method: t.partitioning.method.toUpperCase(),
          key: canonicalExpression(t.partitioning.key, nctx),
          partitions: t.partitioning.partitions.map((p) => [
            p.name,
            p.bound === undefined ? null : canonicalExpression(p.bound, nctx),
          ]),
        });
  if (canon(source, ctx.src) === canon(target, ctx.tgt)) return;
  const table = tableStatementName(ctx, pair, PHASE.alterTable);
  const partitionClause =
    source.partitioning === undefined
      ? ''
      : renderPartitionClause(source.partitioning, ctx.dialect);
  ctx.builder.add({
    id: `partition:${tableDisplay(ctx, pair)}:alter`,
    kind: 'alter',
    objectKind: 'partition',
    name: source.name,
    qualifiedName: tableDisplay(ctx, pair),
    parent: tableDisplay(ctx, pair),
    steps: [
      step(
        PHASE.alterTable,
        [
          source.partitioning === undefined
            ? `ALTER TABLE ${table} REMOVE PARTITIONING`
            : `ALTER TABLE ${table} ${partitionClause}`,
        ],
        {
          refs: relKeys(pair).slice(-1),
        },
      ),
    ],
    changes: ['partitioning changed'],
    warnings: [
      {
        code: 'may-fail',
        message: 'Repartitioning rebuilds the table and fails if rows fall outside every partition',
      },
    ],
  });
}

// ---------------------------------------------------------------------------------------------
// Objects that use a routine the script drops or re-creates (PostgreSQL)

/** A step that must run before a routine can be dropped, and why. */
export interface RoutineBlocker {
  readonly op: OpDraft;
  readonly step: number;
  readonly keys: readonly string[];
  readonly reason: string;
}

/**
 * PostgreSQL refuses to drop a routine that a check, an index or a column default uses. For a
 * routine dropped or re-created by `blocker`, those objects are dropped before it: an operation
 * that already changes or drops one just runs its drop first; an unchanged one gets a rebuild
 * operation that drops it and creates it again from the source after the routine exists.
 */
export function rebuildRoutineDependents(ctx: DiffContext, blocker: RoutineBlocker): void {
  const keys = new Set(blocker.keys.filter((k) => k.startsWith('fn:')));
  if (keys.size === 0) return;
  const uses = (text: string | undefined): boolean =>
    text !== undefined && ctx.refs.resolve(text, 'postgres').some((k) => keys.has(k));
  const first = (op: OpDraft): void => {
    ctx.builder.order(op, 0, blocker.op, blocker.step);
    blocker.op.requires.add(op.id);
  };
  for (const pair of ctx.state.tables) {
    const source = pair.source;
    const target = pair.target;
    if (source === undefined || target === undefined) continue;
    const existing = (objectKind: string, names: readonly string[]): OpDraft | undefined => {
      for (const name of names) {
        for (const action of ['alter', 'drop', 'rebuild']) {
          const op = ctx.builder.get(`${objectKind}:${tableDisplay(ctx, pair, name)}:${action}`);
          if (op !== undefined) return op;
        }
      }
      return undefined;
    };
    const rebuild = (
      objectKind: 'check' | 'index' | 'column',
      name: string,
      drop: string[],
      create: string[],
      provides: string[],
    ): void => {
      const display = tableDisplay(ctx, pair, name);
      const op = ctx.builder.add({
        id: `${objectKind}:${display}:rebuild`,
        kind: 'alter',
        objectKind,
        name,
        qualifiedName: display,
        parent: tableDisplay(ctx, pair),
        schema: pair.schema.name,
        steps: [
          step(PHASE.dropConstraint, drop, { removes: provides }),
          step(PHASE.addConstraint, create, {
            provides,
            refs: [...keys, ...relKeys(pair).slice(-1)],
          }),
        ],
        reason: `Rebuilt because ${blocker.reason}`,
        warnings: [
          { code: 'rebuild', message: `Dropped and re-created because ${blocker.reason}` },
        ],
        requires: new Set([blocker.op.id]),
      });
      first(op);
    };
    const table = (phase: number): string => tableStatementName(ctx, pair, phase);

    for (const check of target.checks) {
      if (!uses(check.expression)) continue;
      const canon = json(canonicalCheck(check, tableContext(target, ctx.tgt)));
      const canonSource = (c: CheckDef): string =>
        json(canonicalCheck(c, tableContext(source, ctx.src)));
      const match =
        source.checks.find(
          (c) =>
            nameKey(c.name, ctx.options) === nameKey(check.name, ctx.options) &&
            canonSource(c) === canon,
        ) ?? source.checks.find((c) => canonSource(c) === canon);
      const op = existing('check', match !== undefined ? [match.name, check.name] : [check.name]);
      if (op !== undefined) {
        if (op.steps[0]?.removes.length) first(op);
        continue;
      }
      if (match === undefined) continue;
      rebuild(
        'check',
        match.name,
        [
          `ALTER TABLE ${table(PHASE.dropConstraint)} DROP CONSTRAINT ${quoteIdent(check.name, 'postgres')}`,
        ],
        [`ALTER TABLE ${table(PHASE.addConstraint)} ADD ${renderCheck(match, 'postgres')}`],
        [key.constraint(pair.schema.key, pair.after, match.name)],
      );
    }

    for (const index of target.indexes) {
      if (!uses(index.definition ?? indexExpressions(index).join(' '))) continue;
      const match = source.indexes.find(
        (i) => nameKey(i.name, ctx.options) === nameKey(index.name, ctx.options),
      );
      const op = existing('index', [index.name]);
      if (op !== undefined) {
        if (op.steps[0]?.removes.length) first(op);
        continue;
      }
      if (match === undefined) continue;
      const create = [renderPgCreateIndex(match, pair.after, pair.schema.name)];
      if (match.comment !== undefined && match.comment !== '' && !ctx.options.ignoreComments) {
        create.push(
          renderPgComment(`INDEX ${qualified(ctx, pair.schema.name, match.name)}`, match.comment),
        );
      }
      rebuild(
        'index',
        match.name,
        [`DROP INDEX ${qualified(ctx, pair.schema.name, index.name)}`],
        create,
        [key.rel(pair.schema.key, match.name)],
      );
    }

    for (const column of target.columns) {
      if (column.generated !== undefined || !uses(column.default ?? undefined)) continue;
      const match = source.columns.find(
        (c) =>
          nameKey(c.name, ctx.options) ===
          nameKey(pair.columnRenames.get(column.name) ?? column.name, ctx.options),
      );
      if (match === undefined || match.default === null) continue;
      const a = canonicalColumn(column, target, ctx.tgt, pair.schema.name);
      const b = canonicalColumn(match, source, ctx.src, pair.schema.name);
      // A changed default is replaced by the column's own operation before the routine drops.
      if (a.default !== b.default) continue;
      const col = quoteIdent(match.name, 'postgres');
      rebuild(
        'column',
        match.name,
        [
          `ALTER TABLE ${table(PHASE.dropConstraint)} ALTER COLUMN ${quoteIdent(column.name, 'postgres')} DROP DEFAULT`,
        ],
        [
          `ALTER TABLE ${table(PHASE.addConstraint)} ALTER COLUMN ${col} SET DEFAULT ${match.default}`,
        ],
        [],
      );
    }
  }
}
