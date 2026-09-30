import type { SchemaDef, SchemaSnapshot, TableDef } from '@joinery/core';

import type { TableRef } from './sql';

/**
 * Table pairing for a whole-database data compare (spec §13, data sync step 1): tables pair by
 * name, and only a pair whose two tables share a primary or unique NOT NULL key can be compared
 * row by row. Everything else is reported with the reason it was left out, so the UI can say
 * why. `dataSyncOrder` orders the pairs by the target's foreign keys for applying.
 */

/** Two tables data compare can walk key by key. */
export interface DataTablePair {
  readonly source: TableRef;
  readonly target: TableRef;
  /** `schema.table` on PostgreSQL, the table name on MySQL and MariaDB. */
  readonly name: string;
  /** Key columns, by source name. */
  readonly keyColumns: readonly string[];
  /** The key is the source's primary key, or a unique NOT NULL key. */
  readonly keyKind: 'primary' | 'unique';
  /** Columns both tables have (source names, in source order), the key included. */
  readonly commonColumns: readonly string[];
  /** Columns only one side has; they are never compared. */
  readonly sourceOnlyColumns: readonly string[];
  readonly targetOnlyColumns: readonly string[];
}

/** A table left out of the compare, and why. */
export interface SkippedDataTable {
  readonly name: string;
  readonly reason: string;
}

export interface DataTablePairing {
  readonly pairs: DataTablePair[];
  readonly skipped: SkippedDataTable[];
}

export interface DataPairingOptions {
  /**
   * Only these tables (by the pair name: `schema.table` on PostgreSQL); every table when
   * absent. Names that match no table are reported as skipped.
   */
  readonly tables?: readonly string[];
}

interface CandidateKey {
  readonly columns: readonly string[];
  readonly kind: 'primary' | 'unique';
}

const lower = (names: readonly string[]): string =>
  names
    .map((n) => n.toLowerCase())
    .sort()
    .join('\u0000');

/** The primary key, then unique constraints and plain unique indexes over NOT NULL columns. */
function candidateKeys(table: TableDef): CandidateKey[] {
  const notNull = (columns: readonly string[]): boolean =>
    columns.every((name) => table.columns.find((c) => c.name === name)?.nullable === false);
  const keys: CandidateKey[] = [];
  if (table.primaryKey) keys.push({ columns: table.primaryKey.columns, kind: 'primary' });
  for (const unique of table.uniques) {
    if (notNull(unique.columns)) keys.push({ columns: unique.columns, kind: 'unique' });
  }
  for (const index of table.indexes) {
    if (!index.unique || index.where !== undefined) continue;
    const names = index.columns.map((c) =>
      c.name !== null && c.expression === undefined && c.length === undefined ? c.name : null,
    );
    if (names.every((n): n is string => n !== null) && notNull(names)) {
      keys.push({ columns: names, kind: 'unique' });
    }
  }
  return keys;
}

/** Tables whose rows are read through another table: PostgreSQL partitions. */
function partitionNames(schema: SchemaDef): Set<string> {
  const names = new Set<string>();
  for (const table of schema.tables) {
    for (const partition of table.partitioning?.partitions ?? []) names.add(partition.name);
  }
  return names;
}

function findByName<T extends { readonly name: string }>(
  items: readonly T[],
  name: string,
  caseInsensitive: boolean,
): T | undefined {
  return (
    items.find((item) => item.name === name) ??
    (caseInsensitive
      ? items.find((item) => item.name.toLowerCase() === name.toLowerCase())
      : undefined)
  );
}

function pairTable(
  source: TableDef,
  target: TableDef,
  refs: { readonly source: TableRef; readonly target: TableRef; readonly name: string },
): DataTablePair | SkippedDataTable {
  const sourceKeys = candidateKeys(source);
  const targetKeys = candidateKeys(target);
  if (sourceKeys.length === 0) {
    return { name: refs.name, reason: 'The source table has no primary or unique NOT NULL key' };
  }
  if (targetKeys.length === 0) {
    return { name: refs.name, reason: 'The target table has no primary or unique NOT NULL key' };
  }
  const targetKeySets = new Set(targetKeys.map((key) => lower(key.columns)));
  const key = sourceKeys.find((candidate) => targetKeySets.has(lower(candidate.columns)));
  if (!key) {
    return {
      name: refs.name,
      reason: 'The tables have no primary or unique NOT NULL key over the same columns',
    };
  }
  const targetNames = new Set(target.columns.map((c) => c.name.toLowerCase()));
  const sourceNames = new Set(source.columns.map((c) => c.name.toLowerCase()));
  const ordered = [...source.columns].sort((a, b) => a.ordinal - b.ordinal);
  return {
    ...refs,
    keyColumns: [...key.columns],
    keyKind: key.kind,
    commonColumns: ordered.filter((c) => targetNames.has(c.name.toLowerCase())).map((c) => c.name),
    sourceOnlyColumns: ordered
      .filter((c) => !targetNames.has(c.name.toLowerCase()))
      .map((c) => c.name),
    targetOnlyColumns: [...target.columns]
      .sort((a, b) => a.ordinal - b.ordinal)
      .filter((c) => !sourceNames.has(c.name.toLowerCase()))
      .map((c) => c.name),
  };
}

/**
 * Pairs the tables of two snapshots for data compare. PostgreSQL tables pair by schema and
 * name; MySQL and MariaDB compare one database on each side, so tables pair by name alone (a
 * case-only difference still pairs, as lower_case_table_names differs between servers). A
 * cross-engine compare pairs the one schema of each snapshot the same way. Partitions pair
 * through their parent table, and foreign tables are left out.
 */
export function pairDataTables(
  source: SchemaSnapshot,
  target: SchemaSnapshot,
  options: DataPairingOptions = {},
): DataTablePairing {
  const sourcePg = source.engine === 'postgres';
  const targetPg = target.engine === 'postgres';
  const pg = sourcePg && targetPg;
  const wanted = options.tables === undefined ? undefined : new Set(options.tables);
  const pairs: DataTablePair[] = [];
  const skipped: SkippedDataTable[] = [];
  const seen = new Set<string>();
  const schemaPairs: { source?: SchemaDef; target?: SchemaDef }[] = pg
    ? [
        ...source.schemas.map((s) => ({
          source: s,
          ...(target.schemas.find((t) => t.name === s.name)
            ? { target: target.schemas.find((t) => t.name === s.name)! }
            : {}),
        })),
        ...target.schemas
          .filter((t) => !source.schemas.some((s) => s.name === t.name))
          .map((t) => ({ target: t })),
      ]
    : [
        {
          ...(source.schemas[0] ? { source: source.schemas[0] } : {}),
          ...(target.schemas[0] ? { target: target.schemas[0] } : {}),
        },
      ];

  for (const { source: sourceSchema, target: targetSchema } of schemaPairs) {
    const sourceParts = sourcePg && sourceSchema ? partitionNames(sourceSchema) : new Set<string>();
    const targetParts = targetPg && targetSchema ? partitionNames(targetSchema) : new Set<string>();
    const display = (table: string, schema: SchemaDef | undefined): string =>
      pg && schema ? `${schema.name}.${table}` : table;
    const matched = new Set<TableDef>();
    for (const table of sourceSchema?.tables ?? []) {
      const name = display(table.name, sourceSchema);
      if (wanted && !wanted.has(name)) continue;
      seen.add(name);
      if (sourceParts.has(table.name)) {
        skipped.push({ name, reason: 'A partition: its rows are compared with its parent table' });
        continue;
      }
      if (table.kind === 'foreign') {
        skipped.push({ name, reason: 'A foreign table' });
        continue;
      }
      const other = targetSchema ? findByName(targetSchema.tables, table.name, !pg) : undefined;
      if (!other) {
        skipped.push({ name, reason: 'Only in the source' });
        continue;
      }
      matched.add(other);
      if (other.kind === 'foreign') {
        skipped.push({ name, reason: 'A foreign table in the target' });
        continue;
      }
      const paired = pairTable(table, other, {
        source: {
          ...(sourcePg && sourceSchema ? { schema: sourceSchema.name } : {}),
          name: table.name,
        },
        target: {
          ...(targetPg && targetSchema ? { schema: targetSchema.name } : {}),
          name: other.name,
        },
        name,
      });
      if ('reason' in paired) skipped.push(paired);
      else pairs.push(paired);
    }
    for (const table of targetSchema?.tables ?? []) {
      if (matched.has(table)) continue;
      const name = display(table.name, targetSchema);
      if (wanted && !wanted.has(name)) continue;
      if (targetParts.has(table.name)) continue;
      seen.add(name);
      skipped.push({ name, reason: 'Only in the target' });
    }
  }
  for (const name of wanted ?? []) {
    if (!seen.has(name)) skipped.push({ name, reason: 'No such table on either side' });
  }
  return { pairs, skipped };
}

/**
 * The order to apply data changes in (spec §13, data sync step 7): each pair after the pairs
 * whose target tables it references by foreign key, so inserts reach parents before children;
 * deletes run in the reverse order. Cycles and self-references keep their original order.
 * Returns indexes into `pairs`.
 */
export function dataSyncOrder(pairs: readonly DataTablePair[], target: SchemaSnapshot): number[] {
  const pg = target.engine === 'postgres';
  const keyOf = (schema: string | undefined, table: string): string =>
    pg ? `${schema ?? ''}\u0000${table}` : table.toLowerCase();
  const indexByTable = new Map<string, number>();
  pairs.forEach((pair, index) =>
    indexByTable.set(keyOf(pair.target.schema, pair.target.name), index),
  );
  const parents = pairs.map(() => new Set<number>());
  for (const schema of target.schemas) {
    for (const table of schema.tables) {
      const child = indexByTable.get(keyOf(pg ? schema.name : undefined, table.name));
      if (child === undefined) continue;
      for (const fk of table.foreignKeys) {
        const parent = indexByTable.get(
          keyOf(pg ? (fk.refSchema ?? schema.name) : undefined, fk.refTable),
        );
        if (parent !== undefined && parent !== child) parents[child]!.add(parent);
      }
    }
  }
  const order: number[] = [];
  const placed = new Set<number>();
  let progress = true;
  while (placed.size < pairs.length && progress) {
    progress = false;
    for (let i = 0; i < pairs.length; i++) {
      if (placed.has(i)) continue;
      if ([...parents[i]!].every((p) => placed.has(p))) {
        order.push(i);
        placed.add(i);
        progress = true;
      }
    }
  }
  for (let i = 0; i < pairs.length; i++) if (!placed.has(i)) order.push(i);
  return order;
}
