import type {
  ForeignKeyDef,
  RoutineDef,
  SchemaSnapshot,
  SequenceDef,
  SqlDialect,
  TypeDef,
} from '@querybara/core';

import type { Ident } from './names';

/**
 * The autocomplete catalog (spec §6): schema snapshots from the metadata cache, indexed for the
 * lookups completion makes on every keystroke. Building one is linear in the number of objects
 * and copies nothing per column (column name maps are built on first use), so 10,000 tables of
 * 30 columns build in a few tens of milliseconds; every lookup is a Map hit.
 *
 * Name rules follow the server. PostgreSQL stores names exactly and folds unquoted identifiers to
 * lower case. MySQL and MariaDB compare database and table names per `lower_case_table_names`
 * (0: case-sensitive, the Linux default; 1 and 2: case-insensitive) and columns and routines
 * case-insensitively. When the exact rule finds nothing, lookups fall back to a case-insensitive
 * match, so a name typed in the wrong case still completes its columns.
 */

export interface CatalogOptions {
  /** Defaults to the first snapshot's engine (PostgreSQL when there are no snapshots). */
  readonly dialect?: SqlDialect;
  /**
   * The database the session uses. MySQL/MariaDB resolve unqualified names in it (USE);
   * PostgreSQL resolves `schema.table` in it. Defaults to the first snapshot's database.
   */
  readonly currentDatabase?: string;
  /**
   * PostgreSQL search_path, in order (default `["$user", "public"]`). `$user` stands for `user`
   * and is skipped without it. MySQL and MariaDB ignore it.
   */
  readonly searchPath?: readonly string[];
  /** The session user, for `$user` in the search path. */
  readonly user?: string;
  /** MySQL/MariaDB lower_case_table_names (default 0: database and table names are case-sensitive). */
  readonly lowerCaseTableNames?: 0 | 1 | 2;
}

export type CatalogRelationKind = 'table' | 'view' | 'materialized-view';

export interface CatalogColumn {
  readonly name: string;
  /** The type as the engine prints it; views carry no types. */
  readonly dataType?: string;
  readonly nullable?: boolean;
  readonly comment?: string;
}

export interface CatalogDatabase {
  readonly name: string;
  readonly schemas: readonly CatalogSchema[];
}

export interface CatalogSchema {
  readonly name: string;
  readonly database: CatalogDatabase;
  readonly relations: readonly CatalogRelation[];
  readonly routines: readonly CatalogRoutine[];
  readonly sequences: readonly SequenceDef[];
  readonly types: readonly TypeDef[];
  readonly comment?: string;
}

export interface CatalogRelation {
  readonly name: string;
  readonly kind: CatalogRelationKind;
  readonly schema: CatalogSchema;
  readonly columns: readonly CatalogColumn[];
  readonly primaryKey: readonly string[];
  readonly foreignKeys: readonly ForeignKeyDef[];
  readonly comment?: string;
}

export interface CatalogRoutine {
  readonly name: string;
  readonly schema: CatalogSchema;
  readonly def: RoutineDef;
}

/** A foreign key seen from either end. */
export interface CatalogForeignKey {
  readonly name: string;
  readonly from: CatalogRelation;
  readonly columns: readonly string[];
  readonly to: CatalogRelation;
  readonly refColumns: readonly string[];
}

type NameKind = 'database' | 'relation' | 'column' | 'routine';

/** A name → value index with the server's rule plus a case-insensitive fallback. */
class NameIndex<T> {
  private readonly exact = new Map<string, T>();
  private readonly loose = new Map<string, T>();

  constructor(
    private readonly rules: NameRules,
    private readonly kind: NameKind,
  ) {}

  add(name: string, value: T): void {
    const key = this.rules.storeKey(name, this.kind);
    if (!this.exact.has(key)) this.exact.set(key, value);
    const lower = name.toLowerCase();
    if (!this.loose.has(lower)) this.loose.set(lower, value);
  }

  /** By an identifier from SQL text (folded per the dialect). */
  find(ident: Ident): T | undefined {
    return (
      this.exact.get(this.rules.lookupKey(ident, this.kind)) ??
      this.loose.get(ident.name.toLowerCase())
    );
  }

  /** By an exact name from a snapshot. */
  get(name: string): T | undefined {
    return this.exact.get(this.rules.storeKey(name, this.kind));
  }
}

class NameRules {
  private readonly postgres: boolean;
  private readonly foldTables: boolean;

  constructor(dialect: SqlDialect, lowerCaseTableNames: 0 | 1 | 2) {
    this.postgres = dialect === 'postgres';
    this.foldTables = lowerCaseTableNames !== 0;
  }

  /** Key of a name stored in a snapshot. */
  storeKey(name: string, kind: NameKind): string {
    if (this.postgres) return name;
    if (kind === 'column' || kind === 'routine' || this.foldTables) return name.toLowerCase();
    return name;
  }

  /** Key an identifier written in SQL looks up. */
  lookupKey(ident: Ident, kind: NameKind): string {
    if (this.postgres) return ident.quoted ? ident.name : ident.name.toLowerCase();
    return this.storeKey(ident.name, kind);
  }
}

class Database implements CatalogDatabase {
  readonly schemas: SchemaNode[] = [];
  readonly schemaIndex: NameIndex<SchemaNode>;

  constructor(
    readonly name: string,
    rules: NameRules,
  ) {
    this.schemaIndex = new NameIndex(rules, 'database');
  }
}

class SchemaNode implements CatalogSchema {
  readonly relations: RelationNode[] = [];
  readonly routines: CatalogRoutine[] = [];
  readonly sequences: SequenceDef[] = [];
  readonly types: TypeDef[] = [];
  readonly relationIndex: NameIndex<RelationNode>;
  readonly routineIndex: NameIndex<CatalogRoutine[]>;
  readonly comment?: string;

  constructor(
    readonly name: string,
    readonly database: Database,
    rules: NameRules,
    comment: string | undefined,
  ) {
    this.relationIndex = new NameIndex(rules, 'relation');
    this.routineIndex = new NameIndex(rules, 'routine');
    if (comment !== undefined) this.comment = comment;
  }
}

const NO_STRINGS: readonly string[] = [];
const NO_KEYS: readonly ForeignKeyDef[] = [];

class RelationNode implements CatalogRelation {
  private columnIndex: NameIndex<CatalogColumn> | undefined;
  readonly comment?: string;

  constructor(
    readonly name: string,
    readonly kind: CatalogRelationKind,
    readonly schema: SchemaNode,
    readonly columns: readonly CatalogColumn[],
    readonly primaryKey: readonly string[],
    readonly foreignKeys: readonly ForeignKeyDef[],
    comment: string | undefined,
    private readonly rules: NameRules,
  ) {
    if (comment !== undefined) this.comment = comment;
  }

  column(ident: Ident): CatalogColumn | undefined {
    if (!this.columnIndex) {
      this.columnIndex = new NameIndex(this.rules, 'column');
      for (const column of this.columns) this.columnIndex.add(column.name, column);
    }
    return this.columnIndex.find(ident);
  }
}

/**
 * The index complete() and signatureHelp() look names up in. Build it with buildCatalog() where
 * it is used (the language worker): it is a class instance, so it does not survive postMessage;
 * send the plain snapshots instead. Read-only after construction.
 */
export class Catalog {
  readonly dialect: SqlDialect;
  readonly databases: readonly CatalogDatabase[];
  /** The database unqualified names resolve in, if any snapshot matches it. */
  readonly currentDatabase: CatalogDatabase | undefined;
  /**
   * Schemas whose objects need no qualification, in resolution order: the search path
   * (PostgreSQL) or the current database (MySQL/MariaDB).
   */
  readonly searchPath: readonly CatalogSchema[];
  /** Relations and routines summed over every schema. */
  readonly size: { readonly relations: number; readonly routines: number };

  private readonly rules: NameRules;
  private readonly databaseIndex: NameIndex<Database>;
  /** Schemas a one-part qualifier names: PostgreSQL's current database, every MySQL database. */
  private readonly topSchemas: readonly SchemaNode[];
  private readonly topSchemaIndex: NameIndex<SchemaNode>;
  private readonly relationsByName: NameIndex<RelationNode>;
  private readonly routinesByName: NameIndex<CatalogRoutine[]>;
  private readonly incoming = new Map<string, { from: RelationNode; fk: ForeignKeyDef }[]>();

  /** @internal Use buildCatalog. */
  constructor(snapshots: readonly SchemaSnapshot[], options: CatalogOptions = {}) {
    const first = snapshots[0];
    const dialect =
      options.dialect ??
      (first && (first.engine === 'mysql' || first.engine === 'mariadb')
        ? first.engine
        : 'postgres');
    this.dialect = dialect;
    const rules = new NameRules(dialect, options.lowerCaseTableNames ?? 0);
    this.rules = rules;
    this.databaseIndex = new NameIndex(rules, 'database');
    this.relationsByName = new NameIndex(rules, 'relation');
    this.routinesByName = new NameIndex(rules, 'routine');
    const postgres = dialect === 'postgres';

    const databases: Database[] = [];
    let relationCount = 0;
    let routineCount = 0;
    for (const snapshot of snapshots) {
      let database = this.databaseIndex.get(snapshot.database);
      if (!database) {
        database = new Database(snapshot.database, rules);
        databases.push(database);
        this.databaseIndex.add(snapshot.database, database);
      }
      for (const schemaDef of snapshot.schemas) {
        let schema = database.schemaIndex.get(schemaDef.name);
        if (!schema) {
          schema = new SchemaNode(schemaDef.name, database, rules, schemaDef.comment);
          database.schemas.push(schema);
          database.schemaIndex.add(schemaDef.name, schema);
        }
        for (const table of schemaDef.tables) {
          const relation = new RelationNode(
            table.name,
            'table',
            schema,
            table.columns,
            table.primaryKey?.columns ?? NO_STRINGS,
            table.foreignKeys,
            table.comment,
            rules,
          );
          this.addRelation(schema, relation);
          for (const fk of table.foreignKeys) {
            const key = this.relationKey(database.name, fk.refSchema ?? schema.name, fk.refTable);
            let list = this.incoming.get(key);
            if (!list) this.incoming.set(key, (list = []));
            list.push({ from: relation, fk });
          }
        }
        for (const view of schemaDef.views) {
          const relation = new RelationNode(
            view.name,
            view.materialized ? 'materialized-view' : 'view',
            schema,
            view.columns.map((name) => ({ name })),
            NO_STRINGS,
            NO_KEYS,
            view.comment,
            rules,
          );
          this.addRelation(schema, relation);
        }
        for (const def of schemaDef.routines) {
          const routine: CatalogRoutine = { name: def.name, schema, def };
          schema.routines.push(routine);
          addOverload(schema.routineIndex, routine);
          addOverload(this.routinesByName, routine);
        }
        for (const sequence of schemaDef.sequences) schema.sequences.push(sequence);
        for (const type of schemaDef.types) schema.types.push(type);
        relationCount += schemaDef.tables.length + schemaDef.views.length;
        routineCount += schemaDef.routines.length;
      }
    }
    this.databases = databases;
    this.size = { relations: relationCount, routines: routineCount };

    const currentName = options.currentDatabase ?? first?.database;
    const current = currentName === undefined ? undefined : this.databaseIndex.get(currentName);
    this.currentDatabase = current;

    if (postgres) {
      this.topSchemas = current?.schemas ?? [];
      this.topSchemaIndex = current?.schemaIndex ?? new NameIndex(rules, 'database');
      const path: SchemaNode[] = [];
      for (const entry of options.searchPath ?? ['$user', 'public']) {
        const name = entry === '$user' || entry === '"$user"' ? options.user : entry;
        if (name === undefined) continue;
        const schema = current?.schemaIndex.get(name);
        if (schema && !path.includes(schema)) path.push(schema);
      }
      this.searchPath = path;
    } else {
      const top: SchemaNode[] = [];
      const index = new NameIndex<SchemaNode>(rules, 'database');
      for (const database of databases) {
        for (const schema of database.schemas) {
          top.push(schema);
          index.add(schema.name, schema);
        }
      }
      this.topSchemas = top;
      this.topSchemaIndex = index;
      this.searchPath = current ? current.schemas : [];
    }
  }

  /** Schemas a single qualifier can name (`x.` → schema x in PostgreSQL, database x in MySQL). */
  schemas(): readonly CatalogSchema[] {
    return this.topSchemas;
  }

  findDatabase(ident: Ident): CatalogDatabase | undefined {
    return this.databaseIndex.find(ident);
  }

  /** A schema by one-part (`schema`) or, in PostgreSQL, two-part (`database.schema`) name. */
  findSchema(parts: readonly Ident[]): CatalogSchema | undefined {
    if (parts.length === 1) return this.topSchemaIndex.find(parts[0]!);
    if (parts.length === 2 && this.dialect === 'postgres') {
      const database = this.databaseIndex.find(parts[0]!) as Database | undefined;
      return database?.schemaIndex.find(parts[1]!);
    }
    return undefined;
  }

  /**
   * A table or view by the name SQL text uses for it: `name` resolves through the search path
   * (then any schema, as a fallback), `schema.name` and `database.schema.name` directly.
   */
  findRelation(parts: readonly Ident[]): CatalogRelation | undefined {
    const name = parts[parts.length - 1];
    if (!name || parts.length > 3) return undefined;
    if (parts.length > 1) {
      const schema = this.findSchema(parts.slice(0, -1)) as SchemaNode | undefined;
      return schema?.relationIndex.find(name);
    }
    for (const schema of this.searchPath as readonly SchemaNode[]) {
      const found = schema.relationIndex.find(name);
      if (found) return found;
    }
    return this.relationsByName.find(name);
  }

  /** A table or view by its exact snapshot names. */
  relation(schemaName: string, name: string, databaseName?: string): CatalogRelation | undefined {
    const database = (
      databaseName === undefined ? this.currentDatabase : this.databaseIndex.get(databaseName)
    ) as Database | undefined;
    if (this.dialect !== 'postgres') {
      return this.topSchemaIndex.get(schemaName)?.relationIndex.get(name);
    }
    return database?.schemaIndex.get(schemaName)?.relationIndex.get(name);
  }

  /** A column of `relation` by the identifier SQL text uses for it. */
  findColumn(relation: CatalogRelation, ident: Ident): CatalogColumn | undefined {
    return (relation as RelationNode).column(ident);
  }

  /** Routines (all overloads) by name: `name` through the search path, then anywhere; or `schema.name`. */
  findRoutines(parts: readonly Ident[]): readonly CatalogRoutine[] {
    const name = parts[parts.length - 1];
    if (!name) return [];
    if (parts.length > 1) {
      const schema = this.findSchema(parts.slice(0, -1)) as SchemaNode | undefined;
      return schema?.routineIndex.find(name) ?? [];
    }
    for (const schema of this.searchPath as readonly SchemaNode[]) {
      const found = schema.routineIndex.find(name);
      if (found) return found;
    }
    return this.routinesByName.find(name) ?? [];
  }

  /** True when an unqualified reference to `relation` resolves to it. */
  isVisible(relation: CatalogRelation): boolean {
    for (const schema of this.searchPath as readonly SchemaNode[]) {
      const found = schema.relationIndex.get(relation.name);
      if (found) return found === relation;
    }
    return false;
  }

  /** Foreign keys of `relation` whose referenced table is in the catalog. */
  foreignKeysFrom(relation: CatalogRelation): CatalogForeignKey[] {
    const out: CatalogForeignKey[] = [];
    const schema = relation.schema;
    for (const fk of relation.foreignKeys) {
      const to = this.relation(fk.refSchema ?? schema.name, fk.refTable, schema.database.name);
      if (to) {
        out.push({
          name: fk.name,
          from: relation,
          columns: fk.columns,
          to,
          refColumns: fk.refColumns,
        });
      }
    }
    return out;
  }

  /** Foreign keys of other tables that reference `relation`. */
  foreignKeysTo(relation: CatalogRelation): CatalogForeignKey[] {
    const schema = relation.schema;
    const key = this.relationKey(schema.database.name, schema.name, relation.name);
    return (this.incoming.get(key) ?? []).map(({ from, fk }) => ({
      name: fk.name,
      from,
      columns: fk.columns,
      to: relation,
      refColumns: fk.refColumns,
    }));
  }

  private addRelation(schema: SchemaNode, relation: RelationNode): void {
    schema.relations.push(relation);
    schema.relationIndex.add(relation.name, relation);
    this.relationsByName.add(relation.name, relation);
  }

  /** Identity of a relation by exact names; MySQL/MariaDB schemas are their databases. */
  private relationKey(database: string, schema: string, name: string): string {
    const rules = this.rules;
    const tail = `${rules.storeKey(schema, 'database')}\u0000${rules.storeKey(name, 'relation')}`;
    return this.dialect === 'postgres' ? `${database}\u0000${tail}` : tail;
  }
}

function addOverload(index: NameIndex<CatalogRoutine[]>, routine: CatalogRoutine): void {
  const existing = index.get(routine.name);
  if (existing) existing.push(routine);
  else index.add(routine.name, [routine]);
}

/**
 * Indexes schema snapshots (from the metadata cache) for complete() and signatureHelp().
 * Pass every snapshot the connection has loaded: MySQL/MariaDB one per database, PostgreSQL the
 * connected database's (others are reachable by three-part names only). Rebuild when the cache
 * refreshes; a catalog never changes.
 */
export function buildCatalog(
  snapshots: readonly SchemaSnapshot[],
  options?: CatalogOptions,
): Catalog {
  return new Catalog(snapshots, options);
}
