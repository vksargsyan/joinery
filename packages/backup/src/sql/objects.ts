import type {
  RoutineDef,
  SchemaDef,
  SchemaSnapshot,
  SqlDialect,
  TableDef,
  TypeDef,
} from '@querybara/core';
import { quoteIdent, quoteQualified } from '@querybara/sql-tools';
import { diffSchemas, renderDropRoutine, type SyncOperation } from '@querybara/sync';

import type { BackupObjectKind } from '../archive/manifest';
import type { Selectable } from '../selection';

/**
 * The objects of a SQL backup, from the structure sync engine (spec §13): a snapshot compared
 * with an empty database yields one create operation per object with its DDL, in dependency
 * order, and the operations each one needs. Each becomes a backup object with statements that
 * run before the data (`pre`) or after it (`post`: foreign keys, triggers and events, so loading
 * rows neither trips a constraint nor fires a trigger; sequence positions and materialised view
 * refreshes are added later by the backup).
 */

export interface SqlObject extends Selectable {
  readonly pre: string[];
  readonly post: string[];
  /** Tables: the definition, for the data. */
  readonly table?: TableDef;
  /** How to remove the object when a restore replaces it; absent for schemas and extensions. */
  readonly drop?: string;
}

/** Created after the data. */
const POST_DATA: ReadonlySet<string> = new Set(['foreign-key', 'trigger', 'event']);

/** The snapshot with every object removed: what a fresh database looks like. */
export function emptyTarget(snapshot: SchemaSnapshot): SchemaSnapshot {
  const pg = snapshot.engine === 'postgres';
  return {
    ...snapshot,
    extensions: [],
    schemas: snapshot.schemas
      .filter((schema) => !pg || schema.name === 'public')
      .map((schema) => ({
        name: schema.name,
        tables: [],
        views: [],
        routines: [],
        sequences: [],
        types: [],
        events: [],
        ...(schema.comment !== undefined ? { comment: schema.comment } : {}),
        ...(schema.owner !== undefined ? { owner: schema.owner } : {}),
      })),
  };
}

export interface PlanOptions {
  /** Keep owners (PostgreSQL OWNER TO) and definers (MySQL DEFINER). Default false. */
  readonly ownership?: boolean;
}

export interface SqlPlan {
  readonly dialect: SqlDialect;
  readonly objects: SqlObject[];
  readonly warnings: string[];
}

function schemaOf(snapshot: SchemaSnapshot, name: string | undefined): SchemaDef | undefined {
  return name === undefined ? snapshot.schemas[0] : snapshot.schemas.find((s) => s.name === name);
}

/** Every object of the snapshot with its DDL, in creation order. */
export function planSqlObjects(snapshot: SchemaSnapshot, options: PlanOptions = {}): SqlPlan {
  const dialect = snapshot.engine as SqlDialect;
  const diff = diffSchemas(snapshot, emptyTarget(snapshot), {
    ignoreAutoIncrement: false,
    ignoreOwnership: options.ownership !== true,
    ignoreDefiner: options.ownership !== true,
  });
  const warnings: string[] = [];
  const parents = new Map<string, SyncOperation>();
  for (const op of diff.operations) {
    if (
      op.objectKind === 'table' ||
      op.objectKind === 'view' ||
      op.objectKind === 'materialized-view'
    ) {
      parents.set(op.qualifiedName, op);
    }
  }
  const objects: SqlObject[] = [];
  for (const op of diff.operations) {
    if (op.kind !== 'create') continue;
    if (op.statements.length === 0) {
      const why = op.warnings.find((w) => w.code === 'unsupported')?.message ?? 'no DDL';
      warnings.push(`${op.qualifiedName} is not backed up: ${why}`);
      continue;
    }
    const kind = op.objectKind as BackupObjectKind;
    const post = POST_DATA.has(kind);
    const parentOp = op.parent !== undefined ? parents.get(op.parent) : undefined;
    const parent = parentOp?.id;
    const table =
      kind === 'table'
        ? schemaOf(snapshot, op.schema)?.tables.find((t) => t.name === op.name)
        : undefined;
    const drop = dropStatement(op, snapshot, dialect, parentOp);
    objects.push({
      id: op.id,
      kind,
      ...(op.schema !== undefined ? { schema: op.schema } : {}),
      name: op.name,
      qualifiedName: op.qualifiedName,
      ...(parent !== undefined ? { parent } : {}),
      dependsOn: [...op.dependsOn],
      pre: post ? [] : [...op.statements],
      post: post ? [...op.statements] : [],
      ...(table !== undefined ? { table } : {}),
      ...(drop !== undefined ? { drop } : {}),
    });
  }
  return { dialect, objects, warnings };
}

function routineOf(snapshot: SchemaSnapshot, op: SyncOperation): RoutineDef | undefined {
  const schema = schemaOf(snapshot, op.schema);
  const routines = schema?.routines.filter((r) => r.name === op.name) ?? [];
  if (routines.length <= 1) return routines[0];
  // Overloads: the qualified name carries the signature, e.g. "s.f(integer, text)".
  return routines.find((r) => op.qualifiedName.endsWith(`(${r.signature})`)) ?? routines[0];
}

function typeOf(snapshot: SchemaSnapshot, op: SyncOperation): TypeDef | undefined {
  return schemaOf(snapshot, op.schema)?.types.find((t) => t.name === op.name);
}

/**
 * DROP ... IF EXISTS for an object a restore replaces (never CASCADE). Triggers and PostgreSQL
 * foreign keys get one too, so they can go before the functions and tables they reference;
 * MySQL restores run with foreign key checks off, which lets tables go in any order.
 */
function dropStatement(
  op: SyncOperation,
  snapshot: SchemaSnapshot,
  dialect: SqlDialect,
  parent: SyncOperation | undefined,
): string | undefined {
  const pg = dialect === 'postgres';
  const name = pg ? quoteQualified([op.schema, op.name], dialect) : quoteIdent(op.name, dialect);
  const parentName =
    parent === undefined
      ? undefined
      : pg
        ? quoteQualified([parent.schema, parent.name], dialect)
        : quoteIdent(parent.name, dialect);
  switch (op.objectKind) {
    case 'table':
      return `DROP TABLE IF EXISTS ${name}`;
    case 'view':
      return `DROP VIEW IF EXISTS ${name}`;
    case 'materialized-view':
      return `DROP MATERIALIZED VIEW IF EXISTS ${name}`;
    case 'sequence':
      return `DROP SEQUENCE IF EXISTS ${name}`;
    case 'type': {
      const type = typeOf(snapshot, op);
      return `DROP ${type?.kind === 'domain' ? 'DOMAIN' : 'TYPE'} IF EXISTS ${name}`;
    }
    case 'routine': {
      const routine = routineOf(snapshot, op);
      return routine ? renderDropRoutine(routine, dialect, pg ? op.schema : undefined) : undefined;
    }
    case 'event':
      return `DROP EVENT IF EXISTS ${name}`;
    case 'trigger':
      if (!pg) return `DROP TRIGGER IF EXISTS ${name}`;
      return parentName === undefined
        ? undefined
        : `DROP TRIGGER IF EXISTS ${quoteIdent(op.name, dialect)} ON ${parentName}`;
    case 'foreign-key':
      return pg && parentName !== undefined
        ? `ALTER TABLE IF EXISTS ${parentName} DROP CONSTRAINT IF EXISTS ${quoteIdent(op.name, dialect)}`
        : undefined;
    default:
      return undefined;
  }
}
