import type { ForeignKeyDef, SchemaSnapshot, SqlDialect } from '@joinery/core';
import type { QueryJoin, QueryModel, QueryTable } from '@joinery/sql-tools';

/**
 * The tables the query builder offers (spec §8: the designers share the metadata cache): one
 * database's snapshot flattened into entries with their columns and foreign keys, the lookups
 * the builder makes (a model table's entry, the search list) and the joins foreign keys propose.
 * Pure.
 */

export interface CatalogColumn {
  readonly name: string;
  /** The type as the engine prints it; views carry none. */
  readonly dataType?: string | undefined;
  readonly primaryKey?: boolean | undefined;
}

export interface CatalogEntry {
  /** PostgreSQL schema, or the MySQL/MariaDB database. */
  readonly schema: string;
  readonly name: string;
  readonly kind: 'table' | 'view';
  readonly columns: readonly CatalogColumn[];
  readonly foreignKeys: readonly ForeignKeyDef[];
}

export interface BuilderCatalog {
  readonly dialect: SqlDialect;
  readonly database: string;
  /** Where a table name without schema resolves: the first search-path schema, or the database. */
  readonly defaultSchema: string;
  readonly entries: readonly CatalogEntry[];
}

/** Flattens a snapshot; tables and views of the default schema come first, then by name. */
export function builderCatalog(
  snapshot: SchemaSnapshot,
  dialect: SqlDialect,
  defaultSchema?: string,
): BuilderCatalog {
  const home =
    dialect === 'postgres'
      ? (defaultSchema ??
        (snapshot.schemas.some((s) => s.name === 'public')
          ? 'public'
          : (snapshot.schemas[0]?.name ?? 'public')))
      : snapshot.database;
  const entries: CatalogEntry[] = [];
  for (const schema of snapshot.schemas) {
    // MySQL/MariaDB snapshots hold the database as their one schema.
    const schemaName = dialect === 'postgres' ? schema.name : snapshot.database;
    for (const table of schema.tables) {
      const primary = new Set(table.primaryKey?.columns ?? []);
      entries.push({
        schema: schemaName,
        name: table.name,
        kind: 'table',
        columns: table.columns.map((column) => ({
          name: column.name,
          dataType: column.dataType,
          ...(primary.has(column.name) ? { primaryKey: true } : {}),
        })),
        foreignKeys: table.foreignKeys,
      });
    }
    for (const view of schema.views) {
      entries.push({
        schema: schemaName,
        name: view.name,
        kind: 'view',
        columns: view.columns.map((name) => ({ name })),
        foreignKeys: [],
      });
    }
  }
  entries.sort(
    (a, b) =>
      Number(b.schema === home) - Number(a.schema === home) ||
      a.schema.localeCompare(b.schema) ||
      a.name.localeCompare(b.name),
  );
  return { dialect, database: snapshot.database, defaultSchema: home, entries };
}

function same(catalog: BuilderCatalog, a: string, b: string): boolean {
  return catalog.dialect === 'postgres' ? a === b : a.toLowerCase() === b.toLowerCase();
}

/** The entry a model table names: by schema and name, the default schema when it has none. */
export function entryOf(catalog: BuilderCatalog, table: QueryTable): CatalogEntry | undefined {
  const schema = table.schema ?? catalog.defaultSchema;
  const matches = (entry: CatalogEntry, exact: boolean): boolean =>
    exact
      ? entry.schema === schema && entry.name === table.name
      : same(catalog, entry.schema, schema) && same(catalog, entry.name, table.name);
  return (
    catalog.entries.find((entry) => matches(entry, true)) ??
    catalog.entries.find((entry) => matches(entry, false))
  );
}

/** What the list shows: the name, qualified when it is not in the default schema. */
export function entryLabel(catalog: BuilderCatalog, entry: CatalogEntry): string {
  return entry.schema === catalog.defaultSchema ? entry.name : `${entry.schema}.${entry.name}`;
}

/** Entries whose label contains every word of the query, case-insensitively. */
export function searchEntries(catalog: BuilderCatalog, query: string): CatalogEntry[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [...catalog.entries];
  return catalog.entries.filter((entry) => {
    const label = `${entry.schema}.${entry.name}`.toLowerCase();
    return words.every((word) => label.includes(word));
  });
}

/** Column names of a model table, for parseQuery to attach unqualified columns. */
export function columnsOf(catalog: BuilderCatalog | undefined) {
  return (table: QueryTable): readonly string[] | undefined =>
    catalog ? entryOf(catalog, table)?.columns.map((column) => column.name) : undefined;
}

/** True when a foreign key of `from` references `to`. */
function references(
  catalog: BuilderCatalog,
  from: CatalogEntry,
  fk: ForeignKeyDef,
  to: CatalogEntry,
): boolean {
  return (
    same(catalog, fk.refSchema ?? from.schema, to.schema) && same(catalog, fk.refTable, to.name)
  );
}

/**
 * The joins foreign keys propose when `tableId` joins the model (spec §8: joins are drawn from
 * foreign keys): one INNER join to each table already there that it references or that
 * references it, the existing table on the left. Pairs already joined get none.
 */
export function proposeJoins(
  model: QueryModel,
  catalog: BuilderCatalog,
  tableId: string,
  newId: () => string,
): QueryJoin[] {
  const table = model.tables.find((t) => t.id === tableId);
  const entry = table && entryOf(catalog, table);
  if (!table || !entry) return [];
  const joined = new Set(
    model.joins
      .filter((join) => join.left === tableId || join.right === tableId)
      .map((join) => (join.left === tableId ? join.right : join.left)),
  );
  const proposals: QueryJoin[] = [];
  for (const other of model.tables) {
    if (other.id === tableId || joined.has(other.id)) continue;
    const otherEntry = entryOf(catalog, other);
    if (!otherEntry) continue;
    const outgoing = entry.foreignKeys.find((fk) => references(catalog, entry, fk, otherEntry));
    const incoming = otherEntry.foreignKeys.find((fk) =>
      references(catalog, otherEntry, fk, entry),
    );
    let pairs: [string, string][] | undefined;
    if (outgoing)
      pairs = outgoing.refColumns.map((column, i) => [column, outgoing.columns[i] ?? column]);
    else if (incoming)
      pairs = incoming.columns.map((column, i) => [column, incoming.refColumns[i] ?? column]);
    if (!pairs) continue;
    proposals.push({
      id: newId(),
      type: 'inner',
      left: other.id,
      right: tableId,
      conditions: pairs.map(([left, right]) => ({ left, operator: '=', right })),
    });
  }
  return proposals;
}
