import type { IndexDef, RoutineDef, SequenceDef, TypeDef, ViewDef } from '@joinery/core';
import { quoteIdent, quoteString } from '@joinery/sql-tools';

import type { SyncWarning } from '../model';
import {
  canonicalEvent,
  canonicalExtension,
  canonicalIndex,
  canonicalRoutine,
  canonicalSchema,
  canonicalSequence,
  canonicalTypeDef,
  canonicalView,
  nameKey,
} from '../normalize';
import {
  pgRoutineIdentity,
  renderDropRoutine,
  renderEvent,
  renderExtension,
  renderOwnedBy,
  renderPgComment,
  renderPgCreateIndex,
  renderRoutine,
  renderSchema,
  renderSequence,
  renderType,
  renderView,
} from '../render';
import { normalizeSql, tokenizeSql, trimStatement } from '../sql-text';
import { PHASE, step } from './builder';
import type { OpDraft, StepDraft } from './builder';
import type { DiffContext } from './context';
import { displayName, key, qualified, tableKey } from './context';
import { pairByName, pairViews } from './pairs';
import type { SchemaPair, ViewPair } from './pairs';
import { describeChanges } from './tables';

const json = (value: unknown): string => JSON.stringify(value);

function statementsDdl(statements: readonly string[]): string {
  return statements.map((s) => `${s};`).join('\n\n');
}

function schemaRef(ctx: DiffContext, schema: SchemaPair): string[] {
  return ctx.pg ? [key.schema(schema.name)] : [];
}

// ---------------------------------------------------------------------------------------------
// Extensions and schemas (PostgreSQL)

export function diffExtensions(ctx: DiffContext): void {
  if (!ctx.pg) return;
  for (const { source, target } of pairByName(
    ctx.source.extensions,
    ctx.target.extensions,
    ctx.options,
  )) {
    const name = (source ?? target)!.name;
    const base = { objectKind: 'extension' as const, name, qualifiedName: name };
    if (source !== undefined && target === undefined) {
      ctx.builder.add({
        ...base,
        id: `extension:${name}:create`,
        kind: 'create',
        steps: [
          step(
            PHASE.createExtension,
            [renderExtension(source, !ctx.options.ignoreExtensionVersions)],
            {
              provides: [key.extension(name)],
              refs: source.schema !== undefined ? [key.schema(source.schema)] : [],
            },
          ),
        ],
        sourceDdl: renderExtension(source),
      });
    } else if (source === undefined && target !== undefined) {
      ctx.builder.add({
        ...base,
        id: `extension:${name}:drop`,
        kind: 'drop',
        steps: [
          step(PHASE.dropExtension, [`DROP EXTENSION ${quoteIdent(name, 'postgres')}`], {
            removes: [key.extension(name)],
          }),
        ],
        targetDdl: renderExtension(target),
        destructive: true,
        warnings: [
          {
            code: 'data-loss',
            message: `Drops extension ${name}; objects that depend on it make the drop fail`,
          },
        ],
      });
    } else if (source !== undefined && target !== undefined) {
      const a = canonicalExtension(target, ctx.tgt);
      const b = canonicalExtension(source, ctx.src);
      if (json(a) === json(b)) continue;
      const statements: string[] = [];
      if (a.version !== b.version && source.version !== undefined) {
        statements.push(
          `ALTER EXTENSION ${quoteIdent(name, 'postgres')} UPDATE TO ${quoteString(source.version, 'postgres')}`,
        );
      }
      if (a.schema !== b.schema && source.schema !== undefined) {
        statements.push(
          `ALTER EXTENSION ${quoteIdent(name, 'postgres')} SET SCHEMA ${quoteIdent(source.schema, 'postgres')}`,
        );
      }
      if (statements.length === 0) continue;
      ctx.builder.add({
        ...base,
        id: `extension:${name}:alter`,
        kind: 'alter',
        steps: [step(PHASE.alterExtension, statements, { provides: [key.extension(name)] })],
        sourceDdl: renderExtension(source),
        targetDdl: renderExtension(target),
        changes: describeChanges(a, b),
        warnings: [
          {
            code: 'may-fail',
            message: 'The extension version must be installed on the target server',
          },
        ],
      });
    }
  }
}

export function createSchema(ctx: DiffContext, schema: SchemaPair): void {
  const statements = renderSchema(schema.source!, {
    ignoreOwnership: ctx.options.ignoreOwnership,
    ignoreComments: ctx.options.ignoreComments,
  });
  ctx.builder.add({
    id: `schema:${schema.name}:create`,
    kind: 'create',
    objectKind: 'schema',
    name: schema.name,
    qualifiedName: schema.name,
    steps: [step(PHASE.createSchema, statements, { provides: [key.schema(schema.name)] })],
    sourceDdl: statementsDdl(statements),
  });
}

export function dropSchema(ctx: DiffContext, schema: SchemaPair): void {
  ctx.builder.add({
    id: `schema:${schema.name}:drop`,
    kind: 'drop',
    objectKind: 'schema',
    name: schema.name,
    qualifiedName: schema.name,
    steps: [
      step(PHASE.dropSchema, [`DROP SCHEMA ${quoteIdent(schema.name, 'postgres')}`], {
        removes: [key.schema(schema.name)],
      }),
    ],
    targetDdl: `CREATE SCHEMA ${quoteIdent(schema.name, 'postgres')};`,
    destructive: true,
    warnings: [
      {
        code: 'data-loss',
        message: `Drops schema ${schema.name}; it must be empty once the other drops have run`,
      },
    ],
  });
}

export function alterSchema(ctx: DiffContext, schema: SchemaPair): void {
  const a = canonicalSchema(schema.target!, ctx.tgt);
  const b = canonicalSchema(schema.source!, ctx.src);
  if (json(a) === json(b)) return;
  const name = quoteIdent(schema.name, 'postgres');
  const statements: string[] = [];
  if (a.comment !== b.comment)
    statements.push(renderPgComment(`SCHEMA ${name}`, schema.source!.comment));
  if (a.owner !== b.owner && schema.source!.owner !== undefined) {
    statements.push(
      `ALTER SCHEMA ${name} OWNER TO ${quoteIdent(schema.source!.owner, 'postgres')}`,
    );
  }
  ctx.builder.add({
    id: `schema:${schema.name}:alter`,
    kind: 'alter',
    objectKind: 'schema',
    name: schema.name,
    qualifiedName: schema.name,
    steps: [step(PHASE.createSchema, statements, { refs: [key.schema(schema.name)] })],
    changes: describeChanges(a, b),
  });
}

// ---------------------------------------------------------------------------------------------
// Types (PostgreSQL)

/** Target columns whose type is the given user type (plain or array). */
function columnsOfType(ctx: DiffContext, schema: SchemaPair, type: TypeDef) {
  const names = new Set(
    [
      type.name,
      `${schema.name}.${type.name}`,
      `"${type.name}"`,
      `${quoteIdent(schema.name, 'postgres')}.${quoteIdent(type.name, 'postgres')}`,
    ].map((n) => n.toLowerCase()),
  );
  const result: { table: (typeof ctx.state.tables)[number]; column: string; array: boolean }[] = [];
  for (const pair of ctx.state.tables) {
    if (pair.target === undefined || pair.source === undefined) continue;
    for (const column of pair.target.columns) {
      const bare = column.dataType
        .replace(/(\[\d*\])+$/, '')
        .trim()
        .toLowerCase();
      if (!names.has(bare)) continue;
      const sourceColumn = pair.source.columns.find(
        (c) =>
          nameKey(c.name, ctx.options) ===
          nameKey(pair.columnRenames.get(column.name) ?? column.name, ctx.options),
      );
      if (
        sourceColumn === undefined ||
        sourceColumn.dataType.trim().toLowerCase() !== column.dataType.trim().toLowerCase()
      )
        continue;
      result.push({
        table: pair,
        column: column.name,
        array: column.dataType.trim().endsWith(']'),
      });
    }
  }
  return result;
}

function isSubsequence(small: readonly string[], big: readonly string[]): boolean {
  let i = 0;
  for (const value of big) if (i < small.length && small[i] === value) i++;
  return i === small.length;
}

export function diffTypes(ctx: DiffContext, schema: SchemaPair): void {
  if (!ctx.pg) return;
  for (const { source, target } of pairByName(
    schema.source?.types ?? [],
    schema.target?.types ?? [],
    ctx.options,
  )) {
    const type = (source ?? target)!;
    const display = displayName(ctx, schema.name, type.name);
    const typeKey = key.type(schema.key, type.name);
    const base = {
      objectKind: 'type' as const,
      name: type.name,
      qualifiedName: display,
      schema: schema.name,
    };
    const render = (t: TypeDef): string[] =>
      renderType(t, 'postgres', {
        schema: schema.name,
        ignoreOwnership: ctx.options.ignoreOwnership,
        ignoreComments: ctx.options.ignoreComments,
      });
    const keyword = type.kind === 'domain' ? 'DOMAIN' : 'TYPE';
    const name = qualified(ctx, schema.name, type.name);
    if (source !== undefined && target === undefined) {
      ctx.builder.add({
        ...base,
        id: `type:${display}:create`,
        kind: 'create',
        steps: [
          step(PHASE.createType, render(source), {
            provides: [typeKey],
            refs: [
              ...schemaRef(ctx, schema),
              ...ctx.refs.resolve(source.definition, 'postgres').filter((k) => k !== typeKey),
            ],
          }),
        ],
        sourceDdl: statementsDdl(render(source)),
      });
      continue;
    }
    if (source === undefined && target !== undefined) {
      ctx.builder.add({
        ...base,
        id: `type:${display}:drop`,
        kind: 'drop',
        steps: [
          step(PHASE.dropType, [`DROP ${keyword} ${name}`], {
            removes: [typeKey],
            targetRefs: schemaRef(ctx, schema),
          }),
        ],
        targetDdl: statementsDdl(render(target)),
        destructive: true,
        warnings: [{ code: 'data-loss', message: `Drops type ${display}` }],
      });
      continue;
    }
    const a = canonicalTypeDef(target!, ctx.tgt);
    const b = canonicalTypeDef(source!, ctx.src);
    if (json(a) === json(b)) continue;
    const ddl = {
      sourceDdl: statementsDdl(render(source!)),
      targetDdl: statementsDdl(render(target!)),
    };
    const changes = describeChanges(a, b);
    const steps: StepDraft[] = [];
    const warnings: SyncWarning[] = [];
    let destructive = false;
    let unsupported = false;

    if (json(a.values) !== json(b.values) || a.definition !== b.definition || a.kind !== b.kind) {
      if (a.kind === 'enum' && b.kind === 'enum' && isSubsequence(a.values, b.values)) {
        const statements: string[] = [];
        const existing = new Set(a.values);
        b.values.forEach((label, i) => {
          if (existing.has(label)) return;
          const literal = quoteString(label, 'postgres');
          if (i > 0) {
            statements.push(
              `ALTER TYPE ${name} ADD VALUE IF NOT EXISTS ${literal} AFTER ${quoteString(b.values[i - 1]!, 'postgres')}`,
            );
          } else {
            const next = b.values.find((v) => existing.has(v));
            statements.push(
              `ALTER TYPE ${name} ADD VALUE IF NOT EXISTS ${literal}${next !== undefined ? ` BEFORE ${quoteString(next, 'postgres')}` : ''}`,
            );
          }
        });
        steps.push(
          step(PHASE.preTransaction, statements, { preTransaction: true, provides: [typeKey] }),
        );
        warnings.push({
          code: 'non-transactional',
          message:
            'Runs before the transaction: PostgreSQL cannot use a new enum label in the transaction that adds it',
        });
      } else if (a.kind === 'enum' && b.kind === 'enum') {
        const recreated = recreateEnum(ctx, schema, source!, target!);
        steps.push(recreated.step);
        warnings.push(...recreated.warnings);
        destructive = recreated.destructive;
        const op = ctx.builder.add({
          ...base,
          id: `type:${display}:alter`,
          kind: 'alter',
          steps,
          ...ddl,
          changes,
          warnings,
          destructive,
        });
        if (recreated.blockKeys.length > 0) {
          ctx.state.blockers.push({
            op,
            step: 0,
            keys: recreated.blockKeys,
            reason: `type ${display} is recreated`,
          });
        }
        continue;
      } else if (isTypeUsed(ctx, target!)) {
        unsupported = true;
        warnings.push({
          code: 'unsupported',
          message: `Type ${display} is used by columns; change it manually`,
        });
      } else {
        steps.push(
          step(PHASE.createType, [`DROP ${keyword} ${name}`, ...render(source!)], {
            provides: [typeKey],
            removes: [],
            refs: ctx.refs.resolve(source!.definition, 'postgres').filter((k) => k !== typeKey),
          }),
        );
      }
    } else {
      const statements: string[] = [];
      if (a.comment !== b.comment)
        statements.push(renderPgComment(`${keyword} ${name}`, source!.comment));
      if (a.owner !== b.owner && source!.owner !== undefined)
        statements.push(
          `ALTER ${keyword} ${name} OWNER TO ${quoteIdent(source!.owner, 'postgres')}`,
        );
      steps.push(step(PHASE.createType, statements, { refs: [typeKey] }));
    }
    ctx.builder.add({
      ...base,
      id: `type:${display}:alter`,
      kind: 'alter',
      steps: unsupported ? [] : steps,
      ...ddl,
      changes,
      warnings,
      destructive,
      ...(unsupported ? { unsupported: true } : {}),
    });
  }
}

/** True when any target column uses the type (plain or array). */
function isTypeUsed(ctx: DiffContext, type: TypeDef): boolean {
  const needle = type.name.toLowerCase();
  return ctx.state.tables.some(
    (pair) =>
      pair.target?.columns.some((c) => {
        const bare = c.dataType
          .replace(/(\[\d*\])+$/, '')
          .trim()
          .toLowerCase();
        return bare.split('.').pop()!.replace(/"/g, '') === needle;
      }) ?? false,
  );
}

/**
 * Rebuilds an enum whose labels were removed or reordered: rename the old type, create the new
 * one, convert every column through text, drop the old type.
 */
function recreateEnum(ctx: DiffContext, schema: SchemaPair, source: TypeDef, target: TypeDef) {
  const name = qualified(ctx, schema.name, target.name);
  const oldName = `${target.name}__joinery_old`;
  const statements = [
    `ALTER TYPE ${name} RENAME TO ${quoteIdent(oldName, 'postgres')}`,
    `CREATE TYPE ${name} AS ENUM (${source.values.map((v) => quoteString(v, 'postgres')).join(', ')})`,
  ];
  const blockKeys: string[] = [];
  const refs: string[] = [];
  for (const { table, column, array } of columnsOfType(ctx, schema, target)) {
    const tableName = qualified(ctx, table.schema.name, table.after);
    const sourceColumn = table.source!.columns.find(
      (c) =>
        nameKey(c.name, ctx.options) ===
        nameKey(table.columnRenames.get(column) ?? column, ctx.options),
    )!;
    const col = quoteIdent(sourceColumn.name, 'postgres');
    const targetColumn = table.target!.columns.find((c) => c.name === column)!;
    if (targetColumn.default !== null)
      statements.push(`ALTER TABLE ${tableName} ALTER COLUMN ${col} DROP DEFAULT`);
    statements.push(
      `ALTER TABLE ${tableName} ALTER COLUMN ${col} TYPE ${sourceColumn.dataType} USING ${col}::text${array ? '[]' : ''}::${sourceColumn.dataType}`,
    );
    if (sourceColumn.default !== null)
      statements.push(
        `ALTER TABLE ${tableName} ALTER COLUMN ${col} SET DEFAULT ${sourceColumn.default}`,
      );
    blockKeys.push(
      key.col(table.schema.key, table.before, column),
      key.col(table.schema.key, table.after, sourceColumn.name),
    );
    refs.push(
      key.rel(table.schema.key, table.after),
      key.col(table.schema.key, table.after, sourceColumn.name),
    );
  }
  statements.push(`DROP TYPE ${qualified(ctx, schema.name, oldName)}`);
  const removed = target.values.filter((v) => !source.values.includes(v));
  const warnings: SyncWarning[] = [
    {
      code: 'info',
      message:
        'The enum is recreated and its columns converted through text; functions using it must be recreated too',
    },
  ];
  if (removed.length > 0) {
    warnings.push({
      code: 'data-loss',
      message: `Rows holding ${removed.map((v) => `'${v}'`).join(', ')} make the conversion fail`,
    });
  }
  return {
    step: step(PHASE.recreateType, statements, {
      provides: [key.type(schema.key, target.name), ...blockKeys],
      refs,
    }),
    warnings,
    destructive: removed.length > 0,
    blockKeys,
  };
}

// ---------------------------------------------------------------------------------------------
// Sequences

/** "table.column", or "schema.table.column" when the table is in another schema. */
function parseOwnedBy(
  ownedBy: string | undefined,
): { schema?: string; table: string; column: string } | undefined {
  if (ownedBy === undefined) return undefined;
  const parts = ownedBy.split('.');
  if (parts.length === 2) return { table: parts[0]!, column: parts[1]! };
  if (parts.length === 3) return { schema: parts[0]!, table: parts[1]!, column: parts[2]! };
  return undefined;
}

/**
 * Sequences whose owning column is renamed or moved with a renamed table: PostgreSQL keeps the
 * old serial sequence name, so a rename (not drop + create, which would restart numbering) is
 * what makes the target match. Returns target name → source name.
 */
export function sequenceRenames(
  ctx: Pick<DiffContext, 'options' | 'state'>,
  schema: SchemaPair,
): Map<string, string> {
  const renames = new Map<string, string>();
  const sources = schema.source?.sequences ?? [];
  const targets = schema.target?.sequences ?? [];
  const sourceNames = new Set(sources.map((q) => nameKey(q.name, ctx.options)));
  const targetNames = new Set(targets.map((q) => nameKey(q.name, ctx.options)));
  const taken = new Set<SequenceDef>();
  for (const target of targets) {
    if (sourceNames.has(nameKey(target.name, ctx.options))) continue;
    const owner = parseOwnedBy(target.ownedBy);
    if (owner === undefined) continue;
    const table = ctx.state.tablesByTarget.get(tableKey(owner.schema ?? schema.key, owner.table));
    if (table === undefined || table.source === undefined) continue;
    const column = table.columnRenames.get(owner.column) ?? owner.column;
    const mapped =
      owner.schema !== undefined
        ? `${owner.schema}.${table.after}.${column}`
        : `${table.after}.${column}`;
    const source = sources.find(
      (q) =>
        !taken.has(q) &&
        !targetNames.has(nameKey(q.name, ctx.options)) &&
        q.ownedBy !== undefined &&
        nameKey(q.ownedBy, ctx.options) === nameKey(mapped, ctx.options),
    );
    if (source === undefined) continue;
    taken.add(source);
    renames.set(target.name, source.name);
  }
  return renames;
}

export function diffSequences(ctx: DiffContext, schema: SchemaPair): void {
  const renames = sequenceRenames(ctx, schema);
  const pairs = pairByName(
    schema.source?.sequences ?? [],
    schema.target?.sequences ?? [],
    ctx.options,
    (t) => renames.get(t.name),
  );
  for (const { source, target, renamed } of pairs) {
    const sequence = (source ?? target)!;
    const display = displayName(ctx, schema.name, sequence.name);
    const seqKey = key.rel(schema.key, sequence.name);
    const name = qualified(ctx, schema.name, sequence.name);
    const render = (s: SequenceDef): string[] =>
      renderSequence(s, ctx.dialect, {
        ...(ctx.pg ? { schema: schema.name } : {}),
        ignoreOwnership: ctx.options.ignoreOwnership,
      });
    const base = {
      objectKind: 'sequence' as const,
      name: sequence.name,
      qualifiedName: display,
      ...(ctx.pg ? { schema: schema.name } : {}),
    };
    if (ctx.dialect === 'mysql') {
      if (source !== undefined) {
        ctx.builder.add({
          ...base,
          id: `sequence:${display}:create`,
          kind: target === undefined ? 'create' : 'alter',
          steps: [],
          sourceDdl: statementsDdl(render(source)),
          unsupported: true,
          warnings: [{ code: 'unsupported', message: 'MySQL has no sequences' }],
        });
      }
      continue;
    }
    if (source !== undefined && target === undefined) {
      const statements = render(source);
      const owner = parseOwnedBy(source.ownedBy);
      const refs = [...schemaRef(ctx, schema)];
      if (ctx.pg && owner !== undefined) {
        const ownerSchema = owner.schema ?? schema.key;
        const table = ctx.state.tablesBySource.get(tableKey(ownerSchema, owner.table));
        const columnExists =
          table?.target !== undefined &&
          table.target.columns.some(
            (c) =>
              nameKey(table.columnRenames.get(c.name) ?? c.name, ctx.options) ===
              nameKey(owner.column, ctx.options),
          );
        if (columnExists) {
          statements.push(
            `ALTER SEQUENCE ${name} OWNED BY ${renderOwnedBy(source.ownedBy, ctx.dialect, schema.name)}`,
          );
        } else {
          ctx.state.newOwnedSequences.set(
            `${ownerSchema.toLowerCase()}.${owner.table.toLowerCase()}.${owner.column.toLowerCase()}`,
            { sequence: source, schema },
          );
        }
      }
      ctx.builder.add({
        ...base,
        id: `sequence:${display}:create`,
        kind: 'create',
        steps: [step(PHASE.createSequence, statements, { provides: [seqKey], refs })],
        sourceDdl: statementsDdl(render(source)),
      });
      continue;
    }
    if (source === undefined && target !== undefined) {
      ctx.builder.add({
        ...base,
        id: `sequence:${display}:drop`,
        kind: 'drop',
        steps: [
          step(PHASE.dropSequence, [`DROP SEQUENCE IF EXISTS ${name}`], {
            removes: [seqKey],
            targetRefs: schemaRef(ctx, schema),
          }),
        ],
        targetDdl: statementsDdl(render(target)),
        destructive: true,
        warnings: [
          { code: 'data-loss', message: `Drops sequence ${display} and its current value` },
        ],
      });
      continue;
    }
    const renameSteps: StepDraft[] = [];
    if (renamed) {
      renameSteps.push(
        step(
          PHASE.renameTable,
          [
            ctx.pg
              ? `ALTER SEQUENCE ${qualified(ctx, schema.name, target!.name)} RENAME TO ${quoteIdent(source!.name, ctx.dialect)}`
              : `RENAME TABLE ${quoteIdent(target!.name, ctx.dialect)} TO ${quoteIdent(source!.name, ctx.dialect)}`,
          ],
          { removes: [key.rel(schema.key, target!.name)], provides: [seqKey] },
        ),
      );
    }
    const mappedTarget = renamed ? { ...target!, ownedBy: source!.ownedBy } : target!;
    const a = canonicalSequence(mappedTarget, ctx.tgt);
    const b = canonicalSequence(source!, ctx.src);
    if (json(a) === json(b)) {
      if (renameSteps.length > 0) {
        ctx.builder.add({
          ...base,
          id: `sequence:${display}:rename`,
          kind: 'rename',
          steps: renameSteps,
          changes: [`name: ${target!.name} → ${source!.name}`],
        });
      }
      continue;
    }
    const s = source!;
    const clauses: string[] = [];
    if (a.dataType !== b.dataType && s.dataType !== undefined) clauses.push(`AS ${s.dataType}`);
    if (a.increment !== b.increment) clauses.push(`INCREMENT BY ${s.increment}`);
    if (a.minValue !== b.minValue)
      clauses.push(
        s.minValue !== undefined ? `MINVALUE ${s.minValue}` : ctx.pg ? 'NO MINVALUE' : 'NOMINVALUE',
      );
    if (a.maxValue !== b.maxValue)
      clauses.push(
        s.maxValue !== undefined ? `MAXVALUE ${s.maxValue}` : ctx.pg ? 'NO MAXVALUE' : 'NOMAXVALUE',
      );
    if (a.start !== b.start) clauses.push(`START WITH ${s.start}`);
    if (a.cache !== b.cache) clauses.push(`CACHE ${b.cache}`);
    if (a.cycle !== b.cycle) clauses.push(s.cycle ? 'CYCLE' : ctx.pg ? 'NO CYCLE' : 'NOCYCLE');
    const statements: string[] = [];
    if (clauses.length > 0) statements.push(`ALTER SEQUENCE ${name} ${clauses.join(' ')}`);
    if (ctx.pg && a.ownedBy !== b.ownedBy)
      statements.push(
        `ALTER SEQUENCE ${name} OWNED BY ${renderOwnedBy(s.ownedBy, ctx.dialect, schema.name)}`,
      );
    if (ctx.pg && a.owner !== b.owner && s.owner !== undefined)
      statements.push(`ALTER SEQUENCE ${name} OWNER TO ${quoteIdent(s.owner, ctx.dialect)}`);
    if (statements.length === 0 && renameSteps.length === 0) continue;
    const owner = parseOwnedBy(s.ownedBy);
    ctx.builder.add({
      ...base,
      id: `sequence:${display}:alter`,
      kind: 'alter',
      steps: [
        ...renameSteps,
        step(PHASE.alterSequence, statements, {
          provides: [seqKey],
          refs:
            owner !== undefined
              ? [
                  key.rel(owner.schema ?? schema.key, owner.table),
                  key.col(owner.schema ?? schema.key, owner.table, owner.column),
                ]
              : [],
        }),
      ],
      sourceDdl: statementsDdl(render(s)),
      targetDdl: statementsDdl(render(target!)),
      changes: describeChanges(a, b),
    });
  }
}

// ---------------------------------------------------------------------------------------------
// Views

function viewDdl(ctx: DiffContext, schema: SchemaPair, view: ViewDef): string {
  return statementsDdl(
    renderView(view, ctx.dialect, {
      schema: schema.name,
      orReplace: false,
      ignoreDefiner: ctx.options.ignoreDefiner,
      ignoreOwnership: true,
      ignoreComments: false,
    }),
  );
}

function viewStatements(
  ctx: DiffContext,
  schema: SchemaPair,
  view: ViewDef,
  orReplace: boolean,
): string[] {
  return renderView(view, ctx.dialect, {
    ...(ctx.pg ? { schema: schema.name } : {}),
    orReplace,
    ignoreDefiner: ctx.options.ignoreDefiner,
    ignoreOwnership: ctx.options.ignoreOwnership,
    ignoreComments: ctx.options.ignoreComments,
  });
}

function viewKeys(ctx: DiffContext, schema: SchemaPair, name: string, view: ViewDef): string[] {
  return [
    key.rel(schema.key, name),
    ...view.columns.map((c) => key.col(schema.key, name, c)),
    ...view.indexes.map((i) => key.rel(schema.key, i.name)),
  ];
}

export function createViewStep(ctx: DiffContext, pair: ViewPair, orReplace: boolean): StepDraft {
  const view = pair.source!;
  return step(PHASE.createView, viewStatements(ctx, pair.schema, view, orReplace), {
    provides: viewKeys(ctx, pair.schema, pair.after, view),
    refs: [
      ...schemaRef(ctx, pair.schema),
      ...ctx.refs
        .resolve(view.definition, ctx.dialect)
        .filter((k) => k !== key.rel(pair.schema.key, pair.after)),
    ],
  });
}

export function dropViewStep(ctx: DiffContext, pair: ViewPair): StepDraft {
  const view = pair.target!;
  const kind = view.materialized ? 'MATERIALIZED VIEW' : 'VIEW';
  return step(PHASE.dropView, [`DROP ${kind} ${qualified(ctx, pair.schema.name, pair.before)}`], {
    removes: viewKeys(ctx, pair.schema, pair.before, view),
    targetRefs: ctx.refs
      .resolve(view.definition, ctx.dialect)
      .filter((k) => k !== key.rel(pair.schema.key, pair.before)),
  });
}

/** CREATE OR REPLACE VIEW keeps existing columns in place: the old list must prefix the new one. */
function replaceable(source: ViewDef, target: ViewDef): boolean {
  if (source.materialized || target.materialized) return false;
  if (source.columns.length === 0 || target.columns.length === 0) return false;
  return target.columns.every((c, i) => source.columns[i] === c);
}

export function diffViews(ctx: DiffContext, schema: SchemaPair): void {
  for (const pair of pairViews(schema, ctx.options, ctx.pg)) {
    const view = (pair.source ?? pair.target)!;
    const display = displayName(ctx, schema.name, pair.after);
    const objectKind = view.materialized ? ('materialized-view' as const) : ('view' as const);
    const base = {
      objectKind,
      name: pair.after,
      qualifiedName: display,
      ...(ctx.pg ? { schema: schema.name } : {}),
    };
    const entry: { pair: ViewPair; op?: OpDraft; dropStep?: number; createStep?: number } = {
      pair,
    };
    if (pair.target !== undefined) ctx.state.views.set(key.rel(schema.key, pair.before), entry);
    if (pair.source !== undefined && pair.target === undefined) {
      entry.op = ctx.builder.add({
        ...base,
        id: `${objectKind}:${display}:create`,
        kind: 'create',
        steps: [createViewStep(ctx, pair, false)],
        sourceDdl: viewDdl(ctx, schema, pair.source),
      });
      entry.createStep = 0;
      continue;
    }
    if (pair.source === undefined) {
      entry.op = ctx.builder.add({
        ...base,
        id: `${objectKind}:${display}:drop`,
        kind: 'drop',
        steps: [dropViewStep(ctx, pair)],
        targetDdl: viewDdl(ctx, schema, pair.target!),
        destructive: true,
        warnings: [
          {
            code: 'data-loss',
            message: `Drops ${objectKind === 'view' ? 'view' : 'materialized view'} ${display}`,
          },
        ],
      });
      entry.dropStep = 0;
      continue;
    }
    const source = pair.source;
    const target = pair.target!;
    const ddl = {
      sourceDdl: viewDdl(ctx, schema, source),
      targetDdl: viewDdl(ctx, schema, target),
    };
    const steps: StepDraft[] = [];
    const changes: string[] = [];
    const a = canonicalView(target, ctx.pg ? ctx.tgt : ctx.tgtPlain);
    const b = canonicalView(source, ctx.src);
    const columnsChanged =
      a.columns.length > 0 && b.columns.length > 0 && json(a.columns) !== json(b.columns);
    const bodyChanged =
      columnsChanged ||
      a.definition !== b.definition ||
      a.materialized !== b.materialized ||
      a.checkOption !== b.checkOption ||
      json(a.options) !== json(b.options);
    const recreate = bodyChanged && ctx.pg && !replaceable(source, target);
    if (pair.renamed) {
      changes.push(`name: ${pair.before} → ${pair.after}`);
      if (!recreate) {
        const renameKind = target.materialized ? 'MATERIALIZED VIEW' : 'VIEW';
        steps.push(
          step(
            PHASE.renameTable,
            [
              ctx.pg
                ? `ALTER ${renameKind} ${qualified(ctx, schema.name, pair.before)} RENAME TO ${quoteIdent(pair.after, ctx.dialect)}`
                : `RENAME TABLE ${quoteIdent(pair.before, ctx.dialect)} TO ${quoteIdent(pair.after, ctx.dialect)}`,
            ],
            {
              removes: [key.rel(schema.key, pair.before)],
              provides: [key.rel(schema.key, pair.after)],
            },
          ),
        );
      }
    }
    const comparable = a.columns.length > 0 && b.columns.length > 0;
    changes.push(
      ...describeChanges(
        comparable ? a : { ...a, columns: [] },
        comparable ? b : { ...b, columns: [] },
      ).map((c) => (c.startsWith('definition:') ? 'definition changed' : c)),
    );
    const name = qualified(ctx, schema.name, pair.after);
    if (recreate) {
      entry.dropStep = steps.length;
      steps.push(dropViewStep(ctx, pair));
      entry.createStep = steps.length;
      steps.push(createViewStep(ctx, pair, false));
    } else if (bodyChanged) {
      entry.createStep = steps.length;
      steps.push(createViewStep(ctx, pair, true));
    } else if (ctx.pg && (a.comment !== b.comment || a.owner !== b.owner)) {
      const kind = source.materialized ? 'MATERIALIZED VIEW' : 'VIEW';
      const statements: string[] = [];
      if (a.comment !== b.comment)
        statements.push(renderPgComment(`${kind} ${name}`, source.comment));
      if (a.owner !== b.owner && source.owner !== undefined)
        statements.push(`ALTER ${kind} ${name} OWNER TO ${quoteIdent(source.owner, ctx.dialect)}`);
      steps.push(step(PHASE.createView, statements, { refs: [key.rel(schema.key, pair.after)] }));
    }
    if (steps.length > 0) {
      entry.op = ctx.builder.add({
        ...base,
        id: `${objectKind}:${display}:${steps.length === 1 && pair.renamed ? 'rename' : 'alter'}`,
        kind: steps.length === 1 && pair.renamed ? 'rename' : 'alter',
        steps,
        ...ddl,
        changes,
      });
      if (entry.dropStep !== undefined) {
        ctx.state.blockers.push({
          op: entry.op,
          step: entry.dropStep,
          keys: viewKeys(ctx, schema, pair.before, target),
          reason: `${display} is recreated`,
        });
      }
    }
    if (ctx.pg && source.materialized && target.materialized && entry.dropStep === undefined) {
      diffViewIndexes(ctx, pair);
    }
  }
}

function diffViewIndexes(ctx: DiffContext, pair: ViewPair): void {
  const schema = pair.schema;
  const canon = (index: IndexDef, side: 'source' | 'target'): string => {
    const c = canonicalIndex(
      index,
      side === 'source' ? ctx.src : ctx.tgt,
      index.definition !== undefined,
    );
    return json(ctx.options.ignoreNames ? c : { ...c, name: nameKey(index.name, ctx.options) });
  };
  const targets = [...pair.target!.indexes];
  for (const index of pair.source!.indexes) {
    const match = targets.findIndex((t) => canon(t, 'target') === canon(index, 'source'));
    if (match !== -1) {
      targets.splice(match, 1);
      continue;
    }
    const display = displayName(ctx, schema.name, pair.after, index.name);
    ctx.builder.add({
      id: `index:${display}:create`,
      kind: 'create',
      objectKind: 'index',
      name: index.name,
      qualifiedName: display,
      parent: displayName(ctx, schema.name, pair.after),
      schema: schema.name,
      steps: [
        step(PHASE.createView, [renderPgCreateIndex(index, pair.after, schema.name)], {
          provides: [key.rel(schema.key, index.name)],
          refs: [key.rel(schema.key, pair.after)],
        }),
      ],
      sourceDdl: renderPgCreateIndex(index, pair.after, schema.name),
    });
  }
  for (const index of targets) {
    const display = displayName(ctx, schema.name, pair.after, index.name);
    ctx.builder.add({
      id: `index:${display}:drop`,
      kind: 'drop',
      objectKind: 'index',
      name: index.name,
      qualifiedName: display,
      parent: displayName(ctx, schema.name, pair.after),
      schema: schema.name,
      steps: [
        step(PHASE.dropConstraint, [`DROP INDEX ${qualified(ctx, schema.name, index.name)}`], {
          removes: [key.rel(schema.key, index.name)],
        }),
      ],
      targetDdl: renderPgCreateIndex(index, pair.before, schema.name),
    });
  }
}

// ---------------------------------------------------------------------------------------------
// Routines

/**
 * The parameter list of a PostgreSQL CREATE FUNCTION/PROCEDURE statement, with names, modes and
 * defaults. CREATE OR REPLACE cannot rename parameters or remove defaults, so a change here means
 * drop + create even when the argument types are the same.
 */
export function routineArguments(definition: string): string {
  const tokens = tokenizeSql(definition, 'postgres');
  let depth = 0;
  let start = -1;
  let offset = 0;
  for (const token of tokens) {
    if (token.kind === 'dollar-string') return '';
    if (token.kind === 'punct' && token.text === '(') {
      if (depth === 0 && start === -1) start = offset + 1;
      depth++;
    } else if (token.kind === 'punct' && token.text === ')') {
      depth--;
      if (depth === 0 && start !== -1) return definition.slice(start, offset);
    }
    offset += token.text.length;
  }
  return '';
}

function routineKey(ctx: DiffContext, routine: RoutineDef, side: 'source' | 'target'): string {
  if (!ctx.pg)
    return `${routine.kind === 'procedure' ? 'procedure' : 'function'}:${nameKey(routine.name, ctx.options)}`;
  return `${nameKey(routine.name, ctx.options)}(${canonicalRoutine(routine, side === 'source' ? ctx.src : ctx.tgt).signature})`;
}

function routineDisplay(ctx: DiffContext, schema: SchemaPair, routine: RoutineDef): string {
  return ctx.pg
    ? `${displayName(ctx, schema.name, routine.name)}(${routine.signature})`
    : routine.name;
}

function routineStatements(
  ctx: DiffContext,
  schema: SchemaPair,
  routine: RoutineDef,
  orReplace: boolean,
): string[] {
  return renderRoutine(routine, ctx.dialect, {
    ...(ctx.pg ? { schema: schema.name } : {}),
    orReplace,
    ignoreDefiner: ctx.options.ignoreDefiner,
    ignoreOwnership: ctx.options.ignoreOwnership,
    ignoreComments: ctx.options.ignoreComments,
  });
}

function routineRefs(ctx: DiffContext, schema: SchemaPair, routine: RoutineDef): string[] {
  const own = key.fn(schema.key, routine.name);
  return [
    ...schemaRef(ctx, schema),
    ...ctx.refs
      .resolve(`${routine.signature} ${routine.returns ?? ''} ${routine.definition}`, ctx.dialect)
      .filter((k) => k !== own),
  ];
}

export function diffRoutines(ctx: DiffContext, schema: SchemaPair): void {
  const sources = schema.source?.routines ?? [];
  const targets = schema.target?.routines ?? [];
  const targetByKey = new Map(targets.map((r) => [routineKey(ctx, r, 'target'), r]));
  const pairs: { source?: RoutineDef; target?: RoutineDef }[] = [];
  const used = new Set<RoutineDef>();
  const unmatchedSources: RoutineDef[] = [];
  for (const source of sources) {
    const target = targetByKey.get(routineKey(ctx, source, 'source'));
    if (target !== undefined && !used.has(target)) {
      used.add(target);
      pairs.push({ source, target });
    } else {
      unmatchedSources.push(source);
    }
  }
  // A single overload on each side with the same name: its signature changed.
  for (const source of unmatchedSources) {
    const sameName = (r: RoutineDef): boolean =>
      nameKey(r.name, ctx.options) === nameKey(source.name, ctx.options) && r.kind === source.kind;
    const candidates = targets.filter((t) => !used.has(t) && sameName(t));
    if (candidates.length === 1 && unmatchedSources.filter(sameName).length === 1) {
      used.add(candidates[0]!);
      pairs.push({ source, target: candidates[0]! });
    } else {
      pairs.push({ source });
    }
  }
  for (const target of targets) if (!used.has(target)) pairs.push({ target });

  for (const { source, target } of pairs) {
    const routine = (source ?? target)!;
    const display = routineDisplay(ctx, schema, routine);
    const fnKey = key.fn(schema.key, routine.name);
    const base = {
      objectKind: 'routine' as const,
      name: routine.name,
      qualifiedName: display,
      ...(ctx.pg ? { schema: schema.name } : {}),
    };
    const createStep = (r: RoutineDef, orReplace: boolean): StepDraft =>
      step(PHASE.createRoutine, routineStatements(ctx, schema, r, orReplace), {
        provides: [fnKey],
        refs: routineRefs(ctx, schema, r),
      });
    const dropStep = (r: RoutineDef): StepDraft =>
      step(
        PHASE.dropRoutine,
        [renderDropRoutine(r, ctx.dialect, ctx.pg ? schema.name : undefined)],
        {
          removes: [fnKey],
          targetRefs: routineRefs(ctx, schema, r),
        },
      );
    const ddlOf = (r: RoutineDef): string =>
      statementsDdl(routineStatements(ctx, schema, r, false));
    if (source !== undefined && target === undefined) {
      ctx.builder.add({
        ...base,
        id: `routine:${display}:create`,
        kind: 'create',
        steps: [createStep(source, false)],
        sourceDdl: ddlOf(source),
      });
      continue;
    }
    if (source === undefined) {
      const op = ctx.builder.add({
        ...base,
        id: `routine:${display}:drop`,
        kind: 'drop',
        steps: [dropStep(target!)],
        targetDdl: ddlOf(target!),
        destructive: true,
        warnings: [{ code: 'data-loss', message: `Drops ${routine.kind} ${display} and its code` }],
      });
      if (ctx.pg)
        ctx.state.blockers.push({ op, step: 0, keys: [fnKey], reason: `${display} is dropped` });
      continue;
    }
    const a = canonicalRoutine(target!, ctx.pg ? ctx.tgt : ctx.tgtPlain);
    const b = canonicalRoutine(source, ctx.src);
    if (json(a) === json(b)) continue;
    const changes = describeChanges(a, b).map((c) =>
      c.startsWith('definition:') ? 'definition changed' : c,
    );
    const ddl = { sourceDdl: ddlOf(source), targetDdl: ddlOf(target!) };
    const codeChanged =
      a.definition !== b.definition ||
      a.signature !== b.signature ||
      a.returns !== b.returns ||
      a.kind !== b.kind ||
      a.definer !== b.definer;
    if (!ctx.pg) {
      ctx.builder.add({
        ...base,
        id: `routine:${display}:alter`,
        kind: 'alter',
        steps: [
          step(
            PHASE.createRoutine,
            [
              renderDropRoutine(target!, ctx.dialect),
              ...routineStatements(ctx, schema, source, false),
            ],
            { provides: [fnKey], refs: routineRefs(ctx, schema, source) },
          ),
        ],
        ...ddl,
        changes,
      });
      continue;
    }
    if (!codeChanged) {
      const identity = `${source.kind === 'procedure' ? 'PROCEDURE' : source.kind === 'aggregate' ? 'AGGREGATE' : 'FUNCTION'} ${pgRoutineIdentity(source, schema.name)}`;
      const statements: string[] = [];
      if (a.comment !== b.comment) statements.push(renderPgComment(identity, source.comment));
      if (a.owner !== b.owner && source.owner !== undefined)
        statements.push(`ALTER ${identity} OWNER TO ${quoteIdent(source.owner, 'postgres')}`);
      ctx.builder.add({
        ...base,
        id: `routine:${display}:alter`,
        kind: 'alter',
        steps: [step(PHASE.createRoutine, statements, { refs: [fnKey] })],
        ...ddl,
        changes,
      });
      continue;
    }
    const sameArguments =
      normalizeSql(routineArguments(target!.definition), 'postgres') ===
      normalizeSql(routineArguments(source.definition), 'postgres');
    if (
      a.signature === b.signature &&
      a.returns === b.returns &&
      a.kind === b.kind &&
      sameArguments &&
      source.kind !== 'aggregate'
    ) {
      ctx.builder.add({
        ...base,
        id: `routine:${display}:alter`,
        kind: 'alter',
        steps: [createStep(source, true)],
        ...ddl,
        changes,
      });
      continue;
    }
    const op = ctx.builder.add({
      ...base,
      id: `routine:${display}:alter`,
      kind: 'alter',
      steps: [dropStep(target!), createStep(source, false)],
      ...ddl,
      changes,
      warnings: [
        {
          code: 'info',
          message: 'The signature or result type changed: the routine is dropped and re-created',
        },
      ],
    });
    ctx.state.blockers.push({ op, step: 0, keys: [fnKey], reason: `${display} is re-created` });
  }
}

// ---------------------------------------------------------------------------------------------
// Events (MySQL, MariaDB)

export function diffEvents(ctx: DiffContext, schema: SchemaPair): void {
  if (ctx.pg) return;
  for (const { source, target } of pairByName(
    schema.source?.events ?? [],
    schema.target?.events ?? [],
    ctx.options,
  )) {
    const event = (source ?? target)!;
    const name = quoteIdent(event.name, ctx.dialect);
    const base = { objectKind: 'event' as const, name: event.name, qualifiedName: event.name };
    const eventKey = key.event(event.name);
    if (source !== undefined && target === undefined) {
      ctx.builder.add({
        ...base,
        id: `event:${event.name}:create`,
        kind: 'create',
        steps: [
          step(PHASE.createEvent, [renderEvent(source)], {
            provides: [eventKey],
            refs: ctx.refs.resolve(source.definition, ctx.dialect),
          }),
        ],
        sourceDdl: `${renderEvent(source)};`,
      });
      continue;
    }
    if (source === undefined) {
      ctx.builder.add({
        ...base,
        id: `event:${event.name}:drop`,
        kind: 'drop',
        steps: [step(PHASE.dropEvent, [`DROP EVENT IF EXISTS ${name}`], { removes: [eventKey] })],
        targetDdl: `${renderEvent(target!)};`,
        destructive: true,
        warnings: [{ code: 'data-loss', message: `Drops event ${event.name} and its code` }],
      });
      continue;
    }
    const a = canonicalEvent(target!, ctx.tgtPlain);
    const b = canonicalEvent(source, ctx.src);
    if (json(a) === json(b)) continue;
    const statements =
      a.definition === b.definition
        ? [`ALTER EVENT ${name} ${source.enabled ? 'ENABLE' : 'DISABLE'}`]
        : [`DROP EVENT IF EXISTS ${name}`, trimStatement(renderEvent(source))];
    ctx.builder.add({
      ...base,
      id: `event:${event.name}:alter`,
      kind: 'alter',
      steps: [
        step(PHASE.createEvent, statements, {
          provides: [eventKey],
          refs: ctx.refs.resolve(source.definition, ctx.dialect),
        }),
      ],
      sourceDdl: `${renderEvent(source)};`,
      targetDdl: `${renderEvent(target!)};`,
      changes:
        a.definition === b.definition
          ? [`enabled: ${String(a.enabled)} → ${String(b.enabled)}`]
          : ['definition changed'],
    });
  }
}
