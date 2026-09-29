import type {
  ForeignKeyDef,
  SchemaSnapshot,
  SequenceDef,
  SqlDialect,
  TriggerDef,
} from '@joinery/core';

import type { NormalizeContext } from '../normalize';
import type { RenameRule, ResolvedCompareOptions } from '../options';
import { objectName } from '../render';
import { referencedNames } from '../sql-text';
import type { OpDraft, OperationBuilder } from './builder';
import type { SchemaPair, TablePair, ViewPair } from './pairs';

/**
 * Object keys identify things steps create, drop and reference, so the builder can order steps
 * and derive selection dependencies. They are lower-cased: a loose match only adds a harmless
 * ordering edge. Relations (tables, views, sequences, indexes) share one namespace, as they do
 * in both engine families.
 */
export const key = {
  schema: (schema: string): string => `schema:${schema.toLowerCase()}`,
  extension: (name: string): string => `ext:${name.toLowerCase()}`,
  rel: (schema: string, name: string): string =>
    `rel:${schema.toLowerCase()}.${name.toLowerCase()}`,
  col: (schema: string, table: string, column: string): string =>
    `col:${schema.toLowerCase()}.${table.toLowerCase()}.${column.toLowerCase()}`,
  type: (schema: string, name: string): string =>
    `type:${schema.toLowerCase()}.${name.toLowerCase()}`,
  fn: (schema: string, name: string): string => `fn:${schema.toLowerCase()}.${name.toLowerCase()}`,
  constraint: (schema: string, table: string, name: string): string =>
    `con:${schema.toLowerCase()}.${table.toLowerCase()}.${name.toLowerCase()}`,
  trigger: (schema: string, table: string, name: string): string =>
    `trg:${schema.toLowerCase()}.${table.toLowerCase()}.${name.toLowerCase()}`,
  event: (name: string): string => `event:${name.toLowerCase()}`,
};

type RefKind = 'rel' | 'type' | 'fn';

/** Every relation, type and routine name in both snapshots, for resolving definition references. */
export class ReferenceIndex {
  private readonly byName = new Map<string, Set<string>>();
  private readonly cache = new Map<string, string[]>();
  private readonly columns = new Map<string, Set<string>>();

  constructor(
    snapshots: readonly SchemaSnapshot[],
    private readonly schemaKey: (snapshot: SchemaSnapshot, schema: string) => string,
  ) {
    for (const snapshot of snapshots) {
      for (const schema of snapshot.schemas) {
        const s = schemaKey(snapshot, schema.name);
        for (const table of schema.tables) {
          this.addName('rel', s, table.name);
          this.addColumns(
            s,
            table.name,
            table.columns.map((c) => c.name),
          );
          for (const index of table.indexes) this.addName('rel', s, index.name);
        }
        for (const view of schema.views) {
          this.addName('rel', s, view.name);
          this.addColumns(s, view.name, view.columns);
        }
        for (const sequence of schema.sequences) this.addName('rel', s, sequence.name);
        for (const type of schema.types) this.addName('type', s, type.name);
        for (const routine of schema.routines) this.addName('fn', s, routine.name);
      }
    }
  }

  private addName(kind: RefKind, schema: string, name: string): void {
    const lower = name.toLowerCase();
    let set = this.byName.get(lower);
    if (!set) this.byName.set(lower, (set = new Set()));
    set.add(`${kind}:${schema.toLowerCase()}.${lower}`);
  }

  private addColumns(schema: string, table: string, columns: readonly string[]): void {
    const k = key.rel(schema, table);
    let set = this.columns.get(k);
    if (!set) this.columns.set(k, (set = new Set()));
    for (const c of columns) set.add(c.toLowerCase());
  }

  /**
   * Keys of the objects a definition mentions: relations, types and routines by name
   * (qualified names narrowed to their schema), plus the columns of mentioned relations whose
   * names also appear in the text.
   */
  resolve(text: string | undefined, dialect: SqlDialect): string[] {
    if (text === undefined || text === '') return [];
    const cacheKey = `${dialect}\u0000${text}`;
    const cached = this.cache.get(cacheKey);
    if (cached !== undefined) return cached;
    const result = this.resolveUncached(text, dialect);
    this.cache.set(cacheKey, result);
    return result;
  }

  private resolveUncached(text: string, dialect: SqlDialect): string[] {
    const refs = referencedNames(text, dialect);
    const words = new Set(refs.map((r) => r.name.toLowerCase()));
    const out = new Set<string>();
    for (const ref of refs) {
      const candidates = this.byName.get(ref.name.toLowerCase());
      if (!candidates) continue;
      for (const candidate of candidates) {
        if (ref.schema !== undefined) {
          const schemaPart = candidate.slice(
            candidate.indexOf(':') + 1,
            candidate.lastIndexOf('.'),
          );
          if (schemaPart !== ref.schema.toLowerCase()) continue;
        }
        out.add(candidate);
      }
    }
    for (const k of [...out]) {
      if (!k.startsWith('rel:')) continue;
      const columns = this.columns.get(k);
      if (!columns) continue;
      const [schema, table] = splitKey(k);
      for (const word of words) if (columns.has(word)) out.add(key.col(schema, table, word));
    }
    return [...out];
  }
}

function splitKey(k: string): [string, string] {
  const body = k.slice(k.indexOf(':') + 1);
  const dot = body.lastIndexOf('.');
  return [body.slice(0, dot), body.slice(dot + 1)];
}

/** Keys for the types a column type mentions (user types, arrays of them). */
export function typeRefs(
  dataType: string,
  schema: string,
  index: ReferenceIndex,
  dialect: SqlDialect,
): string[] {
  if (dialect !== 'postgres') return [];
  const bare = dataType.replace(/(\[\d*\])+$/, '').replace(/\(.*\)$/, '');
  return index
    .resolve(bare, dialect)
    .filter((k) => k.startsWith('type:'))
    .concat(bare.includes('.') ? [] : [key.type(schema, bare.replace(/^"(.*)"$/, '$1'))]);
}

/** Where an object's drop step lives, so dependents can be ordered around it. */
export interface Registered<P> {
  readonly pair: P;
  op?: OpDraft;
  dropStep?: number;
  createStep?: number;
}

export interface ForeignKeyEntry {
  readonly table: TablePair;
  readonly source?: ForeignKeyDef;
  readonly target?: ForeignKeyDef;
  op?: OpDraft;
  dropStep?: number;
}

export interface TriggerEntry {
  readonly table: TablePair;
  readonly source?: TriggerDef;
  readonly target?: TriggerDef;
  op?: OpDraft;
  dropStep?: number;
}

/** A step that PostgreSQL refuses while views or triggers depend on the keys it changes. */
export interface Blocker {
  readonly op: OpDraft;
  readonly step: number;
  readonly keys: readonly string[];
  readonly reason: string;
}

/** Mutable bookkeeping shared by the per-object diffs and the dependency passes. */
export interface DiffState {
  readonly tables: TablePair[];
  /** By `schemaKey.name` (lower case) of the target table. */
  readonly tablesByTarget: Map<string, TablePair>;
  readonly tablesBySource: Map<string, TablePair>;
  readonly views: Map<string, Registered<ViewPair>>;
  readonly foreignKeys: ForeignKeyEntry[];
  readonly triggers: TriggerEntry[];
  readonly blockers: Blocker[];
  /** Keys (primary, unique) dropped or recreated: referencing foreign keys must be rebuilt. */
  readonly keyDrops: { table: TablePair; columns: readonly string[]; op: OpDraft; step: number }[];
  /** Sequences created by the script and owned by a column: `schemaKey.table.column` → sequence. */
  readonly newOwnedSequences: Map<string, { sequence: SequenceDef; schema: SchemaPair }>;
  /** Tables whose primary key was added together with an AUTO_INCREMENT column. */
  readonly foldedPrimaryKeys: Set<TablePair>;
  /** PostgreSQL columns dropped and re-added (`schemaKey.table.column`), with the step doing it. */
  readonly readdedColumns: Map<string, { op: OpDraft; step: number }>;
  /** Columns whose type, charset, collation or generation changes (`schemaKey.table.column`). */
  readonly reshapedColumns: Map<string, OpDraft>;
  /** MySQL/MariaDB columns changing type (target names): their foreign keys must step aside. */
  readonly retypedColumns: { table: TablePair; column: string; op: OpDraft }[];
}

export function tableKey(schemaKey: string, name: string): string {
  return `${schemaKey.toLowerCase()}.${name.toLowerCase()}`;
}

export interface DiffContext {
  readonly state: DiffState;
  readonly source: SchemaSnapshot;
  readonly target: SchemaSnapshot;
  /** Dialect of the generated script (the target's). */
  readonly dialect: SqlDialect;
  readonly pg: boolean;
  readonly options: ResolvedCompareOptions;
  readonly src: NormalizeContext;
  readonly tgt: NormalizeContext;
  readonly crossFamily: boolean;
  readonly builder: OperationBuilder;
  readonly refs: ReferenceIndex;
  /** Target normalisation without rename substitutions (MySQL views and routines do not follow renames). */
  readonly tgtPlain: NormalizeContext;
  readonly targetVersion?: string;
}

/** Display name: `schema.name` for PostgreSQL, `name` for MySQL/MariaDB. */
export function displayName(ctx: DiffContext, schema: string, ...names: string[]): string {
  return ctx.pg ? [schema, ...names].join('.') : names.join('.');
}

export function qualified(ctx: DiffContext, schema: string, name: string): string {
  return objectName(name, ctx.dialect, ctx.pg ? schema : undefined);
}

/** Finds the rename rule mapping a target object to a source object, if any. */
export function findRename(
  rules: readonly RenameRule[],
  objectKind: RenameRule['objectKind'],
  schema: string | undefined,
  targetName: string,
  tableNames: readonly string[] = [],
): RenameRule | undefined {
  return rules.find(
    (rule) =>
      rule.objectKind === objectKind &&
      rule.from === targetName &&
      (rule.schema === undefined || schema === undefined || rule.schema === schema) &&
      (rule.table === undefined || tableNames.includes(rule.table)),
  );
}
