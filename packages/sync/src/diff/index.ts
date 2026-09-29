import { JoineryError } from '@joinery/core';
import type { SchemaSnapshot, SqlDialect } from '@joinery/core';

import type { SchemaDiff, SyncWarning } from '../model';
import { contextFor } from '../normalize';
import type { CompareOptions } from '../options';
import { resolveCompareOptions } from '../options';
import { OperationBuilder } from './builder';
import type { OpDraft } from './builder';
import type { DiffContext, DiffState } from './context';
import { displayName, key, ReferenceIndex, tableKey } from './context';
import {
  alterSchema,
  createSchema,
  createViewStep,
  diffEvents,
  diffExtensions,
  diffRoutines,
  diffSequences,
  diffTypes,
  sequenceRenames,
  diffViews,
  dropSchema,
  dropViewStep,
} from './objects';
import { pairByName, pairTables } from './pairs';
import type { SchemaPair, TablePair } from './pairs';
import {
  alterTable,
  createTable,
  createTriggerStep,
  dropForeignKeysBetweenDroppedTables,
  dropTable,
  dropTriggerStep,
  rebuildReferencingForeignKeys,
} from './tables';

const MYSQL_FAMILY = new Set(['mysql', 'mariadb']);

function dialectOf(engine: string): SqlDialect {
  if (engine === 'postgres' || engine === 'mysql' || engine === 'mariadb') return engine;
  throw new JoineryError({
    code: 'NOT_SUPPORTED',
    message: `Structure sync does not support ${engine}`,
    hint: 'Structure sync compares MySQL, MariaDB and PostgreSQL databases.',
  });
}

function pairSchemas(
  source: SchemaSnapshot,
  target: SchemaSnapshot,
  pg: boolean,
  ctxOptions: ReturnType<typeof resolveCompareOptions>,
): SchemaPair[] {
  if (!pg && source.schemas.length <= 1 && target.schemas.length <= 1) {
    // MySQL/MariaDB: one schema per snapshot, named after the database; the names usually differ.
    const s = source.schemas[0];
    const t = target.schemas[0];
    if (s === undefined && t === undefined) return [];
    return [
      {
        ...(s !== undefined ? { source: s } : {}),
        ...(t !== undefined ? { target: t } : {}),
        name: (t ?? s)!.name,
        key: '',
      },
    ];
  }
  return pairByName(source.schemas, target.schemas, ctxOptions).map(({ source: s, target: t }) => ({
    ...(s !== undefined ? { source: s } : {}),
    ...(t !== undefined ? { target: t } : {}),
    name: (t ?? s)!.name,
    key: pg ? (t ?? s)!.name : '',
  }));
}

/**
 * Structure diff (spec §13, steps 2-6): normalises both snapshots, matches objects, and turns
 * the differences into ordered operations that make the target match the source.
 *
 * Supported pairs: PostgreSQL → PostgreSQL, MySQL → MySQL, MariaDB → MariaDB, and MySQL ↔
 * MariaDB with warnings. Anything else throws NOT_SUPPORTED.
 */
export function diffSchemas(
  source: SchemaSnapshot,
  target: SchemaSnapshot,
  options: CompareOptions = {},
): SchemaDiff {
  const sourceDialect = dialectOf(source.engine);
  const dialect = dialectOf(target.engine);
  const pg = dialect === 'postgres';
  if ((sourceDialect === 'postgres') !== pg) {
    throw new JoineryError({
      code: 'NOT_SUPPORTED',
      message: `Cannot sync structure from ${source.engine} to ${target.engine}`,
      hint: 'Move data between engine families with data transfer instead.',
    });
  }
  const resolved = resolveCompareOptions(options);
  const crossFamily =
    source.engine !== target.engine &&
    MYSQL_FAMILY.has(source.engine) &&
    MYSQL_FAMILY.has(target.engine);

  const schemas = pairSchemas(source, target, pg, resolved);
  const tables = schemas.flatMap((schema) => pairTables(schema, resolved, pg));

  const state: DiffState = {
    tables,
    tablesByTarget: new Map(),
    tablesBySource: new Map(),
    views: new Map(),
    foreignKeys: [],
    triggers: [],
    blockers: [],
    keyDrops: [],
    newOwnedSequences: new Map(),
    foldedPrimaryKeys: new Set(),
    readdedColumns: new Map(),
  };
  for (const pair of tables) {
    if (pair.target !== undefined)
      state.tablesByTarget.set(tableKey(pair.schema.key, pair.before), pair);
    if (pair.source !== undefined)
      state.tablesBySource.set(tableKey(pair.schema.key, pair.after), pair);
  }

  // Old → new names the script renames: PostgreSQL rewrites dependent definitions on rename.
  const renamed = new Map<string, string>();
  for (const pair of tables) {
    if (pair.renamed) renamed.set(pair.before, pair.after);
    for (const [from, to] of pair.columnRenames) renamed.set(from, to);
  }
  for (const rule of resolved.renames) {
    if (rule.objectKind === 'view') renamed.set(rule.from, rule.to);
  }
  for (const schema of schemas) {
    for (const [from, to] of sequenceRenames({ options: resolved, state }, schema))
      renamed.set(from, to);
  }
  const tgtPlain = contextFor(target, resolved, crossFamily);
  const ctx: DiffContext = {
    state,
    source,
    target,
    dialect,
    pg,
    options: resolved,
    src: contextFor(source, resolved, crossFamily),
    tgt: renamed.size > 0 ? { ...tgtPlain, renamedIdentifiers: renamed } : tgtPlain,
    tgtPlain,
    crossFamily,
    builder: new OperationBuilder(),
    refs: new ReferenceIndex([source, target], (_snapshot, schema) => (pg ? schema : '')),
    ...(target.serverVersion !== undefined ? { targetVersion: target.serverVersion } : {}),
  };

  diffExtensions(ctx);
  for (const schema of schemas) {
    if (!pg) continue;
    if (schema.source !== undefined && schema.target === undefined) createSchema(ctx, schema);
    else if (schema.source === undefined && schema.target !== undefined) dropSchema(ctx, schema);
    else alterSchema(ctx, schema);
  }
  for (const schema of schemas) {
    diffTypes(ctx, schema);
    diffSequences(ctx, schema);
  }
  const dropped: { pair: TablePair; op: OpDraft }[] = [];
  for (const pair of tables) {
    if (pair.source !== undefined && pair.target === undefined) createTable(ctx, pair);
    else if (pair.source === undefined && pair.target !== undefined)
      dropped.push({ pair, op: dropTable(ctx, pair) });
    else alterTable(ctx, pair);
  }
  for (const schema of schemas) {
    diffViews(ctx, schema);
    diffRoutines(ctx, schema);
    diffEvents(ctx, schema);
  }
  dropForeignKeysBetweenDroppedTables(ctx, dropped);
  rebuildReferencingForeignKeys(ctx);
  if (pg) rebuildDependents(ctx);
  // Dropping a schema needs everything in it dropped first.
  for (const op of ctx.builder.ops) {
    if (op.objectKind !== 'schema' || op.kind !== 'drop') continue;
    for (const other of ctx.builder.ops) {
      if (other !== op && other.kind === 'drop' && other.schema === op.name)
        op.requires.add(other.id);
    }
  }

  const { operations, order } = ctx.builder.finish();
  const warnings: SyncWarning[] = [];
  if (crossFamily) {
    warnings.push({
      code: 'cross-family',
      message: `Comparing ${source.engine} with ${target.engine}: types, collations, defaults and functions differ between the families; review every statement`,
    });
  }
  if (!pg && operations.length > 0) {
    warnings.push({
      code: 'non-transactional',
      message: `${target.engine === 'mariadb' ? 'MariaDB' : 'MySQL'} DDL is not transactional: a failure part-way leaves the target partly changed. Back up the target first.`,
    });
  }
  return {
    sourceEngine: source.engine,
    targetEngine: target.engine,
    dialect,
    sourceDatabase: source.database,
    targetDatabase: target.database,
    operations,
    order,
    warnings,
    options: resolved,
    identical: operations.length === 0,
  };
}

/**
 * PostgreSQL refuses to change a column type, drop a column, or drop a routine while views or
 * triggers depend on it. Dependent views (transitively) and triggers are dropped before the
 * blocking step and re-created after it from the source definition.
 */
function rebuildDependents(ctx: DiffContext): void {
  const queue = [...ctx.state.blockers];
  const rebuiltViews = new Set<string>();
  const rebuiltTriggers = new Set<unknown>();
  while (queue.length > 0) {
    const blocker = queue.shift()!;
    const keys = new Set(blocker.keys);
    for (const [viewKey, entry] of ctx.state.views) {
      const view = entry.pair.target;
      if (view === undefined || entry.op === blocker.op) continue;
      const refs = ctx.refs.resolve(view.definition, 'postgres');
      if (!refs.some((r) => keys.has(r))) continue;
      const display = displayName(ctx, entry.pair.schema.name, entry.pair.after);
      if (entry.op !== undefined && entry.dropStep !== undefined) {
        ctx.builder.order(entry.op, entry.dropStep, blocker.op, blocker.step);
        blocker.op.requires.add(entry.op.id);
        continue;
      }
      if (entry.pair.source === undefined) continue;
      if (entry.op !== undefined) {
        // A rename, CREATE OR REPLACE or comment change turns into drop + create.
        entry.op.steps.splice(
          0,
          entry.op.steps.length,
          dropViewStep(ctx, entry.pair),
          createViewStep(ctx, entry.pair, false),
        );
        entry.op.kind = 'alter';
        entry.dropStep = 0;
        entry.createStep = 1;
        entry.op.warnings.push({
          code: 'rebuild',
          message: `Dropped and re-created because ${blocker.reason}`,
        });
      } else {
        const objectKind = view.materialized ? ('materialized-view' as const) : ('view' as const);
        entry.op = ctx.builder.add({
          id: `${objectKind}:${display}:rebuild`,
          kind: 'alter',
          objectKind,
          name: entry.pair.after,
          qualifiedName: display,
          schema: entry.pair.schema.name,
          steps: [dropViewStep(ctx, entry.pair), createViewStep(ctx, entry.pair, false)],
          reason: `Rebuilt because ${blocker.reason}`,
          warnings: [
            { code: 'rebuild', message: `Dropped and re-created because ${blocker.reason}` },
          ],
          requires: new Set([blocker.op.id]),
        });
        entry.dropStep = 0;
        entry.createStep = 1;
      }
      ctx.builder.order(entry.op, entry.dropStep, blocker.op, blocker.step);
      blocker.op.requires.add(entry.op.id);
      if (!rebuiltViews.has(viewKey)) {
        rebuiltViews.add(viewKey);
        queue.push({
          op: entry.op,
          step: entry.dropStep,
          keys: [
            viewKey,
            ...view.columns.map((c) => key.col(entry.pair.schema.key, entry.pair.before, c)),
          ],
          reason: `${display} is re-created`,
        });
      }
    }
    if (![...keys].some((k) => k.startsWith('fn:'))) continue;
    for (const entry of ctx.state.triggers) {
      const trigger = entry.target;
      if (trigger === undefined || rebuiltTriggers.has(entry)) continue;
      if (!ctx.refs.resolve(trigger.definition, 'postgres').some((r) => keys.has(r))) continue;
      rebuiltTriggers.add(entry);
      if (entry.op !== undefined && entry.dropStep !== undefined) {
        ctx.builder.order(entry.op, entry.dropStep, blocker.op, blocker.step);
        blocker.op.requires.add(entry.op.id);
        continue;
      }
      if (entry.source === undefined) continue;
      const display = displayName(ctx, entry.table.schema.name, entry.table.after, trigger.name);
      entry.op = ctx.builder.add({
        id: `trigger:${display}:rebuild`,
        kind: 'alter',
        objectKind: 'trigger',
        name: trigger.name,
        qualifiedName: display,
        parent: displayName(ctx, entry.table.schema.name, entry.table.after),
        schema: entry.table.schema.name,
        steps: [
          dropTriggerStep(ctx, entry.table, trigger),
          createTriggerStep(ctx, entry.table, entry.source),
        ],
        reason: `Rebuilt because ${blocker.reason}`,
        warnings: [
          { code: 'rebuild', message: `Dropped and re-created because ${blocker.reason}` },
        ],
        requires: new Set([blocker.op.id]),
      });
      entry.dropStep = 0;
      ctx.builder.order(entry.op, 0, blocker.op, blocker.step);
      blocker.op.requires.add(entry.op.id);
    }
  }
}
