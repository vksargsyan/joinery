import type { ReferentialAction, SchemaSnapshot, SqlDialect } from '@joinery/core';

/**
 * The entity-relationship diagram of a database or schema (spec §8, "ER diagrams"): its tables
 * with their columns and keys, and a relationship per foreign key with crow's-foot ends read
 * from the schema: the referenced end is "exactly one" when every referencing column is NOT
 * NULL and "zero or one" otherwise; the referencing end is "zero or many", or "zero or one" when
 * its columns are the primary key or a unique key (a one-to-one relationship). Tables a foreign
 * key reaches outside the diagram's schemas show as stubs. Box sizes are computed here, not
 * measured on screen, so the layout, the canvas and the exported image agree. Pure.
 */

export type ErTableKind = 'table' | 'partitioned' | 'foreign' | 'view' | 'materialized-view';

export interface ErColumn {
  readonly name: string;
  /** The type as the engine prints it; views carry none. */
  readonly type: string | undefined;
  readonly nullable: boolean;
  readonly primaryKey: boolean;
  readonly foreignKey: boolean;
  /** In a unique key (not the primary key). */
  readonly unique: boolean;
}

export interface ErTable {
  /** Unique within the diagram (schema and name). */
  readonly id: string;
  readonly schema: string;
  readonly name: string;
  readonly kind: ErTableKind;
  readonly columns: readonly ErColumn[];
  /** A table of another schema that a foreign key reaches: only the referenced columns. */
  readonly external: boolean;
  readonly comment?: string;
}

/** A relationship end, crow's-foot style. */
export type ErEnd = 'one' | 'zero-or-one' | 'zero-or-many';

export interface ErRelation {
  readonly id: string;
  /** The foreign key's name. */
  readonly name: string;
  /** The referencing table and its columns. */
  readonly child: string;
  readonly childColumns: readonly string[];
  /** The referenced table and its columns. */
  readonly parent: string;
  readonly parentColumns: readonly string[];
  readonly childEnd: 'zero-or-many' | 'zero-or-one';
  readonly parentEnd: 'one' | 'zero-or-one';
  readonly onDelete: ReferentialAction;
  readonly onUpdate: ReferentialAction;
}

export interface ErDiagram {
  readonly dialect: SqlDialect;
  readonly database: string;
  /** The schemas the diagram shows (MySQL and MariaDB: the database). */
  readonly schemas: readonly string[];
  readonly tables: readonly ErTable[];
  readonly relations: readonly ErRelation[];
}

export interface ErDiagramOptions {
  /** PostgreSQL: one schema; every schema of the snapshot when unset. */
  readonly schema?: string;
  readonly includeViews?: boolean;
}

/** The id of a table in a diagram. */
export function tableId(schema: string, name: string): string {
  return JSON.stringify([schema, name]);
}

/** "orders", or "sales.orders" when the diagram shows several schemas or the table is outside. */
export function tableLabel(diagram: Pick<ErDiagram, 'schemas'>, table: ErTable): string {
  return diagram.schemas.length > 1 || table.external
    ? `${table.schema}.${table.name}`
    : table.name;
}

function sameColumns(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((column) => b.includes(column));
}

export function erDiagram(
  snapshot: SchemaSnapshot,
  dialect: SqlDialect,
  options: ErDiagramOptions = {},
): ErDiagram {
  // MySQL/MariaDB snapshots hold the database as their one schema.
  const schemaName = (name: string): string => (dialect === 'postgres' ? name : snapshot.database);
  const shown = snapshot.schemas.filter(
    (schema) =>
      dialect !== 'postgres' || options.schema === undefined || schema.name === options.schema,
  );
  const schemas = [...new Set(shown.map((schema) => schemaName(schema.name)))];
  const tables = new Map<string, ErTable>();
  const relations: ErRelation[] = [];

  for (const schema of shown) {
    const home = schemaName(schema.name);
    for (const table of schema.tables) {
      const primary = table.primaryKey?.columns ?? [];
      const uniques = table.uniques.map((key) => key.columns);
      const referencing = new Set(table.foreignKeys.flatMap((fk) => fk.columns));
      const unique = new Set(uniques.flat());
      tables.set(tableId(home, table.name), {
        id: tableId(home, table.name),
        schema: home,
        name: table.name,
        kind: table.kind,
        external: false,
        ...(table.comment ? { comment: table.comment } : {}),
        columns: [...table.columns]
          .sort((a, b) => a.ordinal - b.ordinal)
          .map((column) => ({
            name: column.name,
            type: column.dataType,
            nullable: column.nullable,
            primaryKey: primary.includes(column.name),
            foreignKey: referencing.has(column.name),
            unique: unique.has(column.name) && !primary.includes(column.name),
          })),
      });
      for (const fk of table.foreignKeys) {
        const nullable = fk.columns.some(
          (name) => table.columns.find((column) => column.name === name)?.nullable !== false,
        );
        const oneToOne =
          sameColumns(fk.columns, primary) || uniques.some((key) => sameColumns(fk.columns, key));
        relations.push({
          id: JSON.stringify([home, table.name, fk.name]),
          name: fk.name,
          child: tableId(home, table.name),
          childColumns: fk.columns,
          parent: tableId(
            dialect === 'postgres' ? (fk.refSchema ?? schema.name) : snapshot.database,
            fk.refTable,
          ),
          parentColumns: fk.refColumns,
          childEnd: oneToOne ? 'zero-or-one' : 'zero-or-many',
          parentEnd: nullable ? 'zero-or-one' : 'one',
          onDelete: fk.onDelete,
          onUpdate: fk.onUpdate,
        });
      }
    }
    if (options.includeViews) {
      for (const view of schema.views) {
        tables.set(tableId(home, view.name), {
          id: tableId(home, view.name),
          schema: home,
          name: view.name,
          kind: view.materialized ? 'materialized-view' : 'view',
          external: false,
          ...(view.comment ? { comment: view.comment } : {}),
          columns: view.columns.map((name) => ({
            name,
            type: undefined,
            nullable: true,
            primaryKey: false,
            foreignKey: false,
            unique: false,
          })),
        });
      }
    }
  }

  // Tables reached outside the shown schemas become stubs with the referenced columns.
  for (const relation of relations) {
    if (tables.has(relation.parent)) continue;
    const [schema, name] = JSON.parse(relation.parent) as [string, string];
    const known = snapshot.schemas
      .find((s) => s.name === schema)
      ?.tables.find((t) => t.name === name);
    const columns = new Map<string, ErColumn>();
    for (const other of relations.filter((r) => r.parent === relation.parent)) {
      for (const column of other.parentColumns) {
        const def = known?.columns.find((c) => c.name === column);
        columns.set(column, {
          name: column,
          type: def?.dataType,
          nullable: def?.nullable ?? false,
          primaryKey: known?.primaryKey?.columns.includes(column) ?? false,
          foreignKey: false,
          unique: false,
        });
      }
    }
    tables.set(relation.parent, {
      id: relation.parent,
      schema,
      name,
      kind: 'table',
      external: true,
      columns: [...columns.values()],
    });
  }

  return {
    dialect,
    database: snapshot.database,
    schemas,
    tables: [...tables.values()].sort(
      (a, b) =>
        Number(a.external) - Number(b.external) ||
        a.schema.localeCompare(b.schema) ||
        a.name.localeCompare(b.name),
    ),
    relations: relations.sort((a, b) => a.id.localeCompare(b.id)),
  };
}

// ---------------------------------------------------------------------------------------------
// What a box shows

/** Which columns a box lists: all of them, the keys only, or none (the name alone). */
export type ColumnMode = 'all' | 'keys' | 'none';

export interface DisplayOptions {
  readonly columns: ColumnMode;
  readonly types: boolean;
}

/** Columns a relationship ends on, per table: they stay listed in "keys" mode. */
export function relationColumns(diagram: Pick<ErDiagram, 'relations'>): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const add = (table: string, columns: readonly string[]): void => {
    const set = out.get(table) ?? new Set<string>();
    columns.forEach((column) => set.add(column));
    out.set(table, set);
  };
  for (const relation of diagram.relations) {
    add(relation.child, relation.childColumns);
    add(relation.parent, relation.parentColumns);
  }
  return out;
}

export function visibleColumns(
  table: ErTable,
  mode: ColumnMode,
  related: ReadonlySet<string> | undefined,
): readonly ErColumn[] {
  if (mode === 'none') return [];
  if (mode === 'all' || table.external) return table.columns;
  return table.columns.filter(
    (column) =>
      column.primaryKey || column.foreignKey || column.unique || related?.has(column.name) === true,
  );
}

/** A column's key letters, as data modellers print them: P primary, F foreign, U unique. */
export type KeyLetter = 'P' | 'F' | 'U';

export function keyLetters(column: ErColumn): readonly KeyLetter[] {
  const letters: KeyLetter[] = [];
  if (column.primaryKey) letters.push('P');
  if (column.foreignKey) letters.push('F');
  if (column.unique) letters.push('U');
  return letters;
}

/** Box geometry, in canvas pixels. */
export const BOX = {
  header: 32,
  row: 22,
  padding: 6,
  minWidth: 180,
  maxWidth: 380,
  /** Average advance of a 12px UI font; generous so text rarely needs the ellipsis. */
  char: 7,
  /** Room for the key badge column and the gaps. */
  badge: 34,
} as const;

/** How big a table's box is with the given columns shown. */
export function boxSize(
  diagram: Pick<ErDiagram, 'schemas'>,
  table: ErTable,
  columns: readonly ErColumn[],
  types: boolean,
): { readonly width: number; readonly height: number } {
  const header = tableLabel(diagram, table).length * (BOX.char + 0.5) + 44;
  const rows = columns.map(
    (column) =>
      BOX.badge +
      column.name.length * BOX.char +
      (types && column.type ? column.type.length * 6.2 + 16 : 0) +
      16,
  );
  const width = Math.round(Math.min(BOX.maxWidth, Math.max(BOX.minWidth, header, ...rows)));
  const height = BOX.header + columns.length * BOX.row + (columns.length > 0 ? BOX.padding : 0);
  return { width, height };
}

/** Where a column's row sits in its box (its vertical centre), or the header's centre. */
export function anchorY(columns: readonly ErColumn[], name: string | undefined): number {
  const index = name === undefined ? -1 : columns.findIndex((column) => column.name === name);
  return index < 0 ? BOX.header / 2 : BOX.header + index * BOX.row + BOX.row / 2;
}

/** The relationships of a table, and the tables they connect it to. */
export function neighbourhood(
  diagram: Pick<ErDiagram, 'relations'>,
  table: string,
): { readonly relations: ReadonlySet<string>; readonly tables: ReadonlySet<string> } {
  const relations = new Set<string>();
  const tables = new Set<string>([table]);
  for (const relation of diagram.relations) {
    if (relation.child === table || relation.parent === table) {
      relations.add(relation.id);
      tables.add(relation.child);
      tables.add(relation.parent);
    }
  }
  return { relations, tables };
}

/** Tables whose name, or a column's name, contains the search text (case-insensitive). */
export function matchingTables(diagram: Pick<ErDiagram, 'tables'>, text: string): Set<string> {
  const needle = text.trim().toLowerCase();
  if (needle === '') return new Set();
  return new Set(
    diagram.tables
      .filter(
        (table) =>
          table.name.toLowerCase().includes(needle) ||
          table.columns.some((column) => column.name.toLowerCase().includes(needle)),
      )
      .map((table) => table.id),
  );
}

/** "one to many (orders.customer_id → customers.id)": what an edge says to a screen reader. */
export function describeRelation(diagram: ErDiagram, relation: ErRelation): string {
  const child = diagram.tables.find((t) => t.id === relation.child);
  const parent = diagram.tables.find((t) => t.id === relation.parent);
  const kind = relation.childEnd === 'zero-or-one' ? 'one to one' : 'one to many';
  const from = child ? tableLabel(diagram, child) : '?';
  const to = parent ? tableLabel(diagram, parent) : '?';
  return `${kind}: ${from} (${relation.childColumns.join(', ')}) references ${to} (${relation.parentColumns.join(', ')})`;
}
