import type {
  ColumnDef,
  ForeignKeyDef,
  KeyDef,
  ReferentialAction,
  SchemaDef,
  SchemaSnapshot,
  SqlEngineId,
  TableDef,
} from '@joinery/core';
import { emptyTable, formatType, newColumn, parseType, type RenameRule } from '@joinery/sync';

/**
 * Editing an ER model (spec §8, ER modelling: forward engineering): the edits a diagram makes
 * to one schema of a database snapshot, as pure functions from one model state to the next, so
 * undo and redo are a stack of states. A model remembers the live name of every table and
 * column it started from ("origins"), so a rename reaches the structure compare as a rename
 * rule, not a drop and a create. Edits keep the model consistent: renaming or dropping a
 * column or table follows it into keys and foreign keys, here and in the tables that
 * reference it. What the server would refuse (types, defaults, key rules) is left to the table
 * designer's validation. Pure.
 */

export interface ModelState {
  /** The whole database; only the edited schema changes. */
  readonly snapshot: SchemaSnapshot;
  /** Live name of each table of the edited schema by its model name; null for a new table. */
  readonly tableOrigins: Readonly<Record<string, string | null>>;
  /** Live name of each column by model table and column name; null for a new column. */
  readonly columnOrigins: Readonly<Record<string, Readonly<Record<string, string | null>>>>;
}

export interface EditContext {
  readonly engine: SqlEngineId;
  /** The edited schema's name in the snapshot (MySQL/MariaDB: the database). */
  readonly schema: string;
}

/** An edit the model refuses, with what to tell the user. */
export class EditError extends Error {
  override readonly name = 'EditError';
}

/**
 * A type as the server spells it in snapshots ("varchar(20)" → "character varying(20)" on
 * PostgreSQL), so an edit to the same type is no change; what does not parse is kept as typed
 * for the validation to report.
 */
export function spelledType(engine: SqlEngineId, text: string): string {
  const parsed = parseType(text, engine);
  return parsed ? formatType(parsed, engine) : text;
}

export interface ColumnPatch {
  readonly name?: string;
  readonly dataType?: string;
  readonly nullable?: boolean;
  /** An SQL expression, or null for none. */
  readonly default?: string | null;
  readonly comment?: string | null;
  /** Identity (PostgreSQL, BY DEFAULT) or AUTO_INCREMENT (MySQL, MariaDB). */
  readonly autoIncrement?: boolean;
}

export interface RelationPatch {
  readonly onDelete?: ReferentialAction;
  readonly onUpdate?: ReferentialAction;
}

// ---------------------------------------------------------------------------------------------
// Reading the model

/** The edited schema of a snapshot. */
export function editedSchema(snapshot: SchemaSnapshot, context: EditContext): SchemaDef {
  const schema =
    snapshot.schemas.find((s) => s.name === context.schema) ??
    (context.engine === 'postgres' ? undefined : snapshot.schemas[0]);
  if (!schema) throw new EditError(`The schema ${context.schema} is not in the database`);
  return schema;
}

export function findTable(state: ModelState, context: EditContext, name: string): TableDef {
  const table = editedSchema(state.snapshot, context).tables.find((t) => t.name === name);
  if (!table) throw new EditError(`There is no table ${name}`);
  return table;
}

/** Starts a model from the live database. */
export function startModel(snapshot: SchemaSnapshot, context: EditContext): ModelState {
  const schema = editedSchema(snapshot, context);
  return {
    snapshot,
    tableOrigins: Object.fromEntries(schema.tables.map((t) => [t.name, t.name])),
    columnOrigins: Object.fromEntries(
      schema.tables.map((t) => [
        t.name,
        Object.fromEntries(t.columns.map((c) => [c.name, c.name])),
      ]),
    ),
  };
}

/** The longest name the engine takes. */
export function maxNameLength(engine: SqlEngineId): number {
  return engine === 'postgres' ? 63 : 64;
}

const same = (engine: SqlEngineId, a: string, b: string): boolean =>
  engine === 'postgres' ? a === b : a.toLowerCase() === b.toLowerCase();

function checkName(engine: SqlEngineId, name: string, what: string): string {
  const trimmed = name.trim();
  if (trimmed === '') throw new EditError(`A ${what} needs a name`);
  if (trimmed.length > maxNameLength(engine)) {
    throw new EditError(`A ${what} name can be ${maxNameLength(engine)} characters at most`);
  }
  return trimmed;
}

/** "name", else "name_2", "name_3"… not in `taken`, cut to the engine's length. */
function freshName(engine: SqlEngineId, base: string, taken: readonly string[]): string {
  const max = maxNameLength(engine);
  const used = (name: string): boolean => taken.some((t) => same(engine, t, name));
  const first = base.slice(0, max);
  if (!used(first)) return first;
  for (let n = 2; ; n++) {
    const suffix = `_${n}`;
    const name = `${base.slice(0, max - suffix.length)}${suffix}`;
    if (!used(name)) return name;
  }
}

/** Names that share the namespace of constraints: per schema on PostgreSQL, per database on MySQL. */
function constraintNames(schema: SchemaDef): string[] {
  return schema.tables.flatMap((t) => [
    ...(t.primaryKey ? [t.primaryKey.name] : []),
    ...t.uniques.map((u) => u.name),
    ...t.foreignKeys.map((f) => f.name),
    ...t.indexes.map((i) => i.name),
    ...t.checks.map((c) => c.name),
  ]);
}

// ---------------------------------------------------------------------------------------------
// Writing the model

function withSchema(
  state: ModelState,
  context: EditContext,
  change: (schema: SchemaDef) => SchemaDef,
): SchemaSnapshot {
  const target = editedSchema(state.snapshot, context);
  return {
    ...state.snapshot,
    schemas: state.snapshot.schemas.map((s) => (s === target ? change(s) : s)),
  };
}

function withTable(
  state: ModelState,
  context: EditContext,
  name: string,
  change: (table: TableDef) => TableDef,
): SchemaSnapshot {
  findTable(state, context, name);
  return withSchema(state, context, (schema) => ({
    ...schema,
    tables: schema.tables.map((t) => (t.name === name ? change(t) : t)),
  }));
}

function renumber(columns: readonly ColumnDef[]): ColumnDef[] {
  return columns.map((column, i) => ({ ...column, ordinal: i + 1 }));
}

/** Does a foreign key of the edited schema point at `table`? */
function pointsAt(fk: ForeignKeyDef, context: EditContext, table: string): boolean {
  if (fk.refTable !== table) return false;
  return context.engine !== 'postgres' || (fk.refSchema ?? context.schema) === context.schema;
}

/**
 * Foreign keys of the other schemas that point at a table of the edited one (PostgreSQL:
 * `sales.invoices` referencing `public.orders`), passed through `change`: renamed with it, or
 * dropped (null) with it, as the server would require.
 */
function followReferences(
  snapshot: SchemaSnapshot,
  context: EditContext,
  table: string,
  change: (fk: ForeignKeyDef) => ForeignKeyDef | null,
): SchemaSnapshot {
  if (context.engine !== 'postgres') return snapshot;
  return {
    ...snapshot,
    schemas: snapshot.schemas.map((schema) =>
      schema.name === context.schema
        ? schema
        : {
            ...schema,
            tables: schema.tables.map((t) => ({
              ...t,
              foreignKeys: t.foreignKeys.flatMap((fk) => {
                if (fk.refTable !== table || (fk.refSchema ?? schema.name) !== context.schema) {
                  return [fk];
                }
                const next = change(fk);
                return next ? [next] : [];
              }),
            })),
          },
    ),
  };
}

/** Is `table.column` referenced by a foreign key anywhere in the database? */
function isReferenced(
  snapshot: SchemaSnapshot,
  context: EditContext,
  table: string,
  column: string,
): boolean {
  return snapshot.schemas.some((schema) =>
    schema.tables.some((t) =>
      t.foreignKeys.some(
        (fk) =>
          fk.refTable === table &&
          fk.refColumns.includes(column) &&
          (context.engine !== 'postgres' || (fk.refSchema ?? schema.name) === context.schema),
      ),
    ),
  );
}

function omit<T>(record: Readonly<Record<string, T>>, key: string): Record<string, T> {
  const { [key]: _gone, ...rest } = record;
  return rest;
}

/** The primary key's name for a new table (MySQL/MariaDB always call it PRIMARY). */
function primaryKeyName(engine: SqlEngineId, table: string): string {
  return engine === 'postgres' ? `${table}_pkey`.slice(0, maxNameLength(engine)) : 'PRIMARY';
}

/** A surrogate key column: identity on PostgreSQL, AUTO_INCREMENT on MySQL and MariaDB. */
function idColumn(engine: SqlEngineId): ColumnDef {
  return {
    name: 'id',
    ordinal: 1,
    dataType: 'bigint',
    nullable: false,
    default: null,
    autoIncrement: engine !== 'postgres',
    ...(engine === 'postgres' ? { identity: { generation: 'by-default' as const } } : {}),
  };
}

/** Adds a table with an `id` primary key; returns the model and the table's name. */
export function addTable(
  state: ModelState,
  context: EditContext,
  name?: string,
): { readonly state: ModelState; readonly name: string } {
  const schema = editedSchema(state.snapshot, context);
  const taken = [...schema.tables.map((t) => t.name), ...schema.views.map((v) => v.name)];
  const chosen =
    name === undefined
      ? freshName(context.engine, 'new_table', taken)
      : checkName(context.engine, name, 'table');
  if (taken.some((t) => same(context.engine, t, chosen))) {
    throw new EditError(`There is already a table or view named ${chosen}`);
  }
  const table: TableDef = {
    ...emptyTable(context.engine, chosen),
    columns: [idColumn(context.engine)],
    primaryKey: { name: primaryKeyName(context.engine, chosen), columns: ['id'] },
  };
  return {
    name: chosen,
    state: {
      snapshot: withSchema(state, context, (s) => ({ ...s, tables: [...s.tables, table] })),
      tableOrigins: { ...state.tableOrigins, [chosen]: null },
      columnOrigins: { ...state.columnOrigins, [chosen]: { id: null } },
    },
  };
}

export function renameTable(
  state: ModelState,
  context: EditContext,
  from: string,
  to: string,
): ModelState {
  const name = checkName(context.engine, to, 'table');
  if (name === from) return state;
  const schema = editedSchema(state.snapshot, context);
  const taken = [...schema.tables.map((t) => t.name), ...schema.views.map((v) => v.name)];
  if (taken.some((t) => t !== from && same(context.engine, t, name))) {
    throw new EditError(`There is already a table or view named ${name}`);
  }
  const isNew = state.tableOrigins[from] === null;
  const snapshot = withSchema(state, context, (s) => ({
    ...s,
    tables: s.tables.map((table) => {
      const foreignKeys = table.foreignKeys.map((fk) =>
        pointsAt(fk, context, from) ? { ...fk, refTable: name } : fk,
      );
      if (table.name !== from) return { ...table, foreignKeys };
      // A new table's generated key name follows the table's.
      const primaryKey =
        isNew && table.primaryKey?.name === primaryKeyName(context.engine, from)
          ? { ...table.primaryKey, name: primaryKeyName(context.engine, name) }
          : table.primaryKey;
      return { ...table, name, foreignKeys, ...(primaryKey ? { primaryKey } : {}) };
    }),
  }));
  return {
    snapshot: followReferences(snapshot, context, from, (fk) => ({ ...fk, refTable: name })),
    tableOrigins: { ...omit(state.tableOrigins, from), [name]: state.tableOrigins[from] ?? null },
    columnOrigins: { ...omit(state.columnOrigins, from), [name]: state.columnOrigins[from] ?? {} },
  };
}

/** Drops a table and the foreign keys that reference it. */
export function dropTable(state: ModelState, context: EditContext, name: string): ModelState {
  findTable(state, context, name);
  const snapshot = withSchema(state, context, (s) => ({
    ...s,
    tables: s.tables
      .filter((t) => t.name !== name)
      .map((t) => ({
        ...t,
        foreignKeys: t.foreignKeys.filter((fk) => !pointsAt(fk, context, name)),
      })),
  }));
  return {
    snapshot: followReferences(snapshot, context, name, () => null),
    tableOrigins: omit(state.tableOrigins, name),
    columnOrigins: omit(state.columnOrigins, name),
  };
}

export function setTableComment(
  state: ModelState,
  context: EditContext,
  table: string,
  comment: string | null,
): ModelState {
  const text = comment?.trim() ?? '';
  return {
    ...state,
    snapshot: withTable(state, context, table, ({ comment: _old, ...t }) =>
      text === '' ? t : { ...t, comment: text },
    ),
  };
}

// ---------------------------------------------------------------------------------------------
// Columns

/** Adds a column (nullable varchar(255) unless given); returns the model and its name. */
export function addColumn(
  state: ModelState,
  context: EditContext,
  table: string,
  column?: Partial<ColumnDef>,
): { readonly state: ModelState; readonly name: string } {
  const def = findTable(state, context, table);
  if (column?.name !== undefined) {
    const name = checkName(context.engine, column.name, 'column');
    if (def.columns.some((c) => same(context.engine, c.name, name))) {
      throw new EditError(`${table} already has a column ${name}`);
    }
  }
  const base = newColumn(context.engine, def, column?.name?.trim());
  const added: ColumnDef = {
    ...base,
    ...column,
    name: base.name,
    ordinal: def.columns.length + 1,
    dataType: spelledType(context.engine, column?.dataType ?? base.dataType),
  };
  return {
    name: added.name,
    state: {
      ...state,
      snapshot: withTable(state, context, table, (t) => ({ ...t, columns: [...t.columns, added] })),
      columnOrigins: {
        ...state.columnOrigins,
        [table]: { ...state.columnOrigins[table], [added.name]: null },
      },
    },
  };
}

function renameInKey<K extends { columns: readonly string[] }>(
  key: K,
  from: string,
  to: string,
): K {
  return { ...key, columns: key.columns.map((c) => (c === from ? to : c)) };
}

export function updateColumn(
  state: ModelState,
  context: EditContext,
  table: string,
  column: string,
  patch: ColumnPatch,
): ModelState {
  const def = findTable(state, context, table);
  const current = def.columns.find((c) => c.name === column);
  if (!current) throw new EditError(`${table} has no column ${column}`);
  const name = patch.name === undefined ? column : checkName(context.engine, patch.name, 'column');
  if (
    name !== column &&
    def.columns.some((c) => c.name !== column && same(context.engine, c.name, name))
  ) {
    throw new EditError(`${table} already has a column ${name}`);
  }
  const inPrimaryKey = def.primaryKey?.columns.includes(column) === true;
  if (patch.nullable === true && inPrimaryKey) {
    throw new EditError('A primary key column cannot allow NULL');
  }
  const dataType = patch.dataType?.trim();
  if (dataType === '') throw new EditError('A column needs a type');

  let next: ColumnDef = { ...current, name };
  if (dataType !== undefined) next = { ...next, dataType: spelledType(context.engine, dataType) };
  if (patch.nullable !== undefined) next = { ...next, nullable: patch.nullable };
  if (patch.default !== undefined) {
    const text = patch.default?.trim() ?? '';
    next = { ...next, default: text === '' ? null : text };
  }
  if (patch.comment !== undefined) {
    const { comment: _old, ...rest } = next;
    const text = patch.comment?.trim() ?? '';
    next = text === '' ? rest : { ...rest, comment: text };
  }
  if (patch.autoIncrement !== undefined) {
    if (context.engine === 'postgres') {
      const { identity: _old, ...rest } = next;
      next = patch.autoIncrement ? { ...rest, identity: { generation: 'by-default' } } : rest;
    } else {
      next = { ...next, autoIncrement: patch.autoIncrement };
    }
    if (patch.autoIncrement) next = { ...next, default: null, nullable: false };
  }

  const renamed = name !== column;
  const snapshot = withSchema(state, context, (s) => ({
    ...s,
    tables: s.tables.map((t) => {
      if (t.name !== table) {
        if (!renamed) return t;
        return {
          ...t,
          foreignKeys: t.foreignKeys.map((fk) =>
            pointsAt(fk, context, table)
              ? { ...fk, refColumns: fk.refColumns.map((c) => (c === column ? name : c)) }
              : fk,
          ),
        };
      }
      const columns = t.columns.map((c) => (c.name === column ? next : c));
      if (!renamed) return { ...t, columns };
      return {
        ...t,
        columns,
        ...(t.primaryKey ? { primaryKey: renameInKey(t.primaryKey, column, name) } : {}),
        uniques: t.uniques.map((u) => renameInKey(u, column, name)),
        indexes: t.indexes.map((i) => ({
          ...i,
          columns: i.columns.map((c) => (c.name === column ? { ...c, name } : c)),
        })),
        foreignKeys: t.foreignKeys.map((fk) => {
          const own = renameInKey(fk, column, name);
          return t.name === table && pointsAt(fk, context, table)
            ? { ...own, refColumns: own.refColumns.map((c) => (c === column ? name : c)) }
            : own;
        }),
      };
    }),
  }));
  const origins = state.columnOrigins[table] ?? {};
  return {
    ...state,
    snapshot: renamed
      ? followReferences(snapshot, context, table, (fk) => ({
          ...fk,
          refColumns: fk.refColumns.map((c) => (c === column ? name : c)),
        }))
      : snapshot,
    columnOrigins: renamed
      ? {
          ...state.columnOrigins,
          [table]: { ...omit(origins, column), [name]: origins[column] ?? null },
        }
      : state.columnOrigins,
  };
}

/** Drops a column, the keys and indexes it is part of, and the foreign keys through it. */
export function dropColumn(
  state: ModelState,
  context: EditContext,
  table: string,
  column: string,
): ModelState {
  const def = findTable(state, context, table);
  if (!def.columns.some((c) => c.name === column))
    throw new EditError(`${table} has no column ${column}`);
  if (def.columns.length === 1) throw new EditError('A table needs at least one column');
  const snapshot = withSchema(state, context, (s) => ({
    ...s,
    tables: s.tables.map((t) => {
      const incoming = (fk: ForeignKeyDef): boolean =>
        pointsAt(fk, context, table) && fk.refColumns.includes(column);
      if (t.name !== table)
        return { ...t, foreignKeys: t.foreignKeys.filter((fk) => !incoming(fk)) };
      const { primaryKey, ...rest } = t;
      return {
        ...rest,
        columns: renumber(t.columns.filter((c) => c.name !== column)),
        ...(primaryKey && !primaryKey.columns.includes(column) ? { primaryKey } : {}),
        uniques: t.uniques.filter((u) => !u.columns.includes(column)),
        indexes: t.indexes.filter((i) => !i.columns.some((c) => c.name === column)),
        foreignKeys: t.foreignKeys.filter((fk) => !fk.columns.includes(column) && !incoming(fk)),
      };
    }),
  }));
  return {
    ...state,
    snapshot: followReferences(snapshot, context, table, (fk) =>
      fk.refColumns.includes(column) ? null : fk,
    ),
    columnOrigins: {
      ...state.columnOrigins,
      [table]: omit(state.columnOrigins[table] ?? {}, column),
    },
  };
}

/** Moves a column to position `index` (0-based) in its table. */
export function moveColumn(
  state: ModelState,
  context: EditContext,
  table: string,
  column: string,
  index: number,
): ModelState {
  const def = findTable(state, context, table);
  const from = def.columns.findIndex((c) => c.name === column);
  if (from < 0) throw new EditError(`${table} has no column ${column}`);
  const to = Math.max(0, Math.min(def.columns.length - 1, index));
  if (to === from) return state;
  const columns = [...def.columns];
  const [moved] = columns.splice(from, 1);
  columns.splice(to, 0, moved!);
  return {
    ...state,
    snapshot: withTable(state, context, table, (t) => ({ ...t, columns: renumber(columns) })),
  };
}

// ---------------------------------------------------------------------------------------------
// Keys

/** Adds a column to the primary key, or takes it out. Key columns become NOT NULL. */
export function togglePrimaryKey(
  state: ModelState,
  context: EditContext,
  table: string,
  column: string,
): ModelState {
  const def = findTable(state, context, table);
  if (!def.columns.some((c) => c.name === column))
    throw new EditError(`${table} has no column ${column}`);
  const key = def.primaryKey;
  const inKey = key?.columns.includes(column) === true;
  const columns = inKey
    ? key!.columns.filter((c) => c !== column)
    : [...(key?.columns ?? []), column];
  const referenced = isReferenced(state.snapshot, context, table, column);
  if (inKey && referenced) {
    throw new EditError(
      `A foreign key references ${table}.${column}; drop that relationship first`,
    );
  }
  return {
    ...state,
    snapshot: withTable(state, context, table, ({ primaryKey: _old, ...t }) => ({
      ...t,
      columns: inKey
        ? t.columns
        : t.columns.map((c) => (c.name === column ? { ...c, nullable: false } : c)),
      ...(columns.length > 0
        ? { primaryKey: { name: key?.name ?? primaryKeyName(context.engine, table), columns } }
        : {}),
      // A single-column unique key on a column now in the primary key says nothing more.
      uniques: inKey
        ? t.uniques
        : t.uniques.filter(
            (u) => !(u.columns.length === 1 && u.columns[0] === column && columns.length === 1),
          ),
    })),
  };
}

/** Is the column alone a unique key? */
export function isUnique(table: TableDef, column: string): boolean {
  return table.uniques.some((u) => u.columns.length === 1 && u.columns[0] === column);
}

/** Makes the column unique on its own, or removes that unique key. */
export function toggleUnique(
  state: ModelState,
  context: EditContext,
  table: string,
  column: string,
): ModelState {
  const def = findTable(state, context, table);
  if (!def.columns.some((c) => c.name === column))
    throw new EditError(`${table} has no column ${column}`);
  if (isUnique(def, column)) {
    return {
      ...state,
      snapshot: withTable(state, context, table, (t) => ({
        ...t,
        uniques: t.uniques.filter((u) => !(u.columns.length === 1 && u.columns[0] === column)),
      })),
    };
  }
  const schema = editedSchema(state.snapshot, context);
  const taken =
    context.engine === 'postgres'
      ? constraintNames(schema)
      : [
          ...def.indexes.map((i) => i.name),
          ...def.uniques.map((u) => u.name),
          ...def.foreignKeys.map((f) => f.name),
        ];
  const name = freshName(
    context.engine,
    context.engine === 'postgres' ? `${table}_${column}_key` : column,
    taken,
  );
  const key: KeyDef = { name, columns: [column] };
  return {
    ...state,
    snapshot: withTable(state, context, table, (t) => ({ ...t, uniques: [...t.uniques, key] })),
  };
}

// ---------------------------------------------------------------------------------------------
// Relationships

/** The columns a foreign key to `table` references by default: its primary key, else a unique key. */
export function referenceableKey(table: TableDef): readonly string[] | undefined {
  return table.primaryKey?.columns ?? table.uniques[0]?.columns;
}

function isKey(table: TableDef, columns: readonly string[]): boolean {
  const keys = [
    ...(table.primaryKey ? [table.primaryKey.columns] : []),
    ...table.uniques.map((u) => u.columns),
  ];
  return keys.some((key) => key.length === columns.length && key.every((c) => columns.includes(c)));
}

/** "customer" for "customers", "category" for "categories": to name a referencing column. */
export function singular(name: string): string {
  if (/[^s]ies$/i.test(name)) return `${name.slice(0, -3)}y`;
  if (/(ss|x|ch|sh|us)es$/i.test(name)) return name.slice(0, -2);
  if (/[^su]s$/i.test(name) && !/is$/i.test(name)) return name.slice(0, -1);
  return name;
}

/** A type a referencing column can take: identity and AUTO_INCREMENT stay on the key. */
function referencingColumn(
  engine: SqlEngineId,
  parent: ColumnDef,
  name: string,
  nullable: boolean,
): Partial<ColumnDef> {
  const serial: Record<string, string> = {
    serial: 'integer',
    bigserial: 'bigint',
    smallserial: 'smallint',
  };
  return {
    name,
    dataType:
      engine === 'postgres' ? (serial[parent.dataType] ?? parent.dataType) : parent.dataType,
    nullable,
    default: null,
    autoIncrement: false,
  };
}

export interface AddRelationInput {
  /** The referencing table. */
  readonly child: string;
  /** Its columns; new ones named after the parent are added when left out. */
  readonly childColumns?: readonly string[];
  /** The referenced table. */
  readonly parent: string;
  /** Its columns; its primary key (or first unique key) when left out. */
  readonly parentColumns?: readonly string[];
  readonly onDelete?: ReferentialAction;
  readonly onUpdate?: ReferentialAction;
}

/**
 * Adds a foreign key from `child` to `parent`; returns the model, the key's name and the
 * columns it added to the child. New columns are NOT NULL in a new table and nullable in a
 * live one (adding a NOT NULL column to a table with rows fails).
 */
export function addRelation(
  state: ModelState,
  context: EditContext,
  input: AddRelationInput,
): { readonly state: ModelState; readonly name: string; readonly added: readonly string[] } {
  const child = findTable(state, context, input.child);
  const parent = findTable(state, context, input.parent);
  const parentColumns = input.parentColumns ?? referenceableKey(parent);
  if (!parentColumns || parentColumns.length === 0) {
    throw new EditError(`${parent.name} has no primary or unique key to reference`);
  }
  for (const column of parentColumns) {
    if (!parent.columns.some((c) => c.name === column))
      throw new EditError(`${parent.name} has no column ${column}`);
  }
  if (!isKey(parent, parentColumns)) {
    throw new EditError(
      `${parent.name}.${parentColumns.join(', ')} is not a primary or unique key, so it cannot be referenced`,
    );
  }

  let next = state;
  let childColumns = input.childColumns;
  const added: string[] = [];
  if (childColumns === undefined) {
    const nullable = state.tableOrigins[child.name] !== null;
    childColumns = parentColumns.map((column) => {
      const base = `${singular(parent.name)}_${column}`;
      const table = findTable(next, context, child.name);
      const name = freshName(
        context.engine,
        base,
        table.columns.map((c) => c.name),
      );
      const parentColumn = parent.columns.find((c) => c.name === column)!;
      next = addColumn(
        next,
        context,
        child.name,
        referencingColumn(context.engine, parentColumn, name, nullable),
      ).state;
      added.push(name);
      return name;
    });
  }
  if (childColumns.length !== parentColumns.length) {
    throw new EditError('A foreign key needs as many columns as the key it references');
  }
  const childNow = findTable(next, context, child.name);
  for (const column of childColumns) {
    if (!childNow.columns.some((c) => c.name === column))
      throw new EditError(`${child.name} has no column ${column}`);
  }
  if (
    childNow.foreignKeys.some(
      (fk) =>
        pointsAt(fk, context, parent.name) &&
        fk.columns.length === childColumns!.length &&
        fk.columns.every((c, i) => c === childColumns![i]),
    )
  ) {
    throw new EditError(
      `${child.name}.${childColumns.join(', ')} already references ${parent.name}`,
    );
  }
  const schema = editedSchema(next.snapshot, context);
  const name = freshName(
    context.engine,
    `${child.name}_${childColumns.join('_')}_fkey`,
    constraintNames(schema),
  );
  const fk: ForeignKeyDef = {
    name,
    columns: [...childColumns],
    ...(context.engine === 'postgres' ? { refSchema: context.schema } : {}),
    refTable: parent.name,
    refColumns: [...parentColumns],
    onDelete: input.onDelete ?? 'NO ACTION',
    onUpdate: input.onUpdate ?? 'NO ACTION',
  };
  return {
    name,
    added,
    state: {
      ...next,
      snapshot: withTable(next, context, child.name, (t) => ({
        ...t,
        foreignKeys: [...t.foreignKeys, fk],
      })),
    },
  };
}

export function updateRelation(
  state: ModelState,
  context: EditContext,
  child: string,
  name: string,
  patch: RelationPatch,
): ModelState {
  const def = findTable(state, context, child);
  if (!def.foreignKeys.some((fk) => fk.name === name))
    throw new EditError(`${child} has no foreign key ${name}`);
  return {
    ...state,
    snapshot: withTable(state, context, child, (t) => ({
      ...t,
      foreignKeys: t.foreignKeys.map((fk) => (fk.name === name ? { ...fk, ...patch } : fk)),
    })),
  };
}

/** Drops a foreign key; its columns stay. */
export function dropRelation(
  state: ModelState,
  context: EditContext,
  child: string,
  name: string,
): ModelState {
  const def = findTable(state, context, child);
  if (!def.foreignKeys.some((fk) => fk.name === name))
    throw new EditError(`${child} has no foreign key ${name}`);
  return {
    ...state,
    snapshot: withTable(state, context, child, (t) => ({
      ...t,
      foreignKeys: t.foreignKeys.filter((fk) => fk.name !== name),
    })),
  };
}

// ---------------------------------------------------------------------------------------------
// What changed

/** Rename rules for the structure compare: the model's tables and columns under a new name. */
export function renameRules(state: ModelState, context: EditContext): RenameRule[] {
  const scope = context.engine === 'postgres' ? { schema: context.schema } : {};
  const rules: RenameRule[] = [];
  for (const [name, origin] of Object.entries(state.tableOrigins)) {
    if (origin !== null && origin !== name)
      rules.push({ objectKind: 'table', ...scope, from: origin, to: name });
  }
  for (const [table, columns] of Object.entries(state.columnOrigins)) {
    if (state.tableOrigins[table] === null) continue;
    for (const [name, origin] of Object.entries(columns)) {
      if (origin !== null && origin !== name) {
        rules.push({ objectKind: 'column', ...scope, table, from: origin, to: name });
      }
    }
  }
  return rules;
}

export type ChangeMark = 'new' | 'changed';

export interface ModelChanges {
  /** Tables new or changed, by model name. */
  readonly tables: ReadonlyMap<string, ChangeMark>;
  /** Columns new or changed, by model table name then column name. */
  readonly columns: ReadonlyMap<string, ReadonlyMap<string, ChangeMark>>;
  /** Live tables the model drops. */
  readonly dropped: readonly string[];
  readonly count: number;
}

function columnChanged(model: ColumnDef, live: ColumnDef): boolean {
  return (
    model.name !== live.name ||
    model.dataType !== live.dataType ||
    model.nullable !== live.nullable ||
    (model.default ?? null) !== (live.default ?? null) ||
    (model.comment ?? '') !== (live.comment ?? '') ||
    Boolean(model.autoIncrement) !== Boolean(live.autoIncrement) ||
    (model.identity?.generation ?? '') !== (live.identity?.generation ?? '')
  );
}

const keyText = (key: KeyDef | undefined): string =>
  key ? `${key.name}(${key.columns.join(',')})` : '';

/** What the model changes against the live schema, for marks on the diagram. */
export function modelChanges(
  state: ModelState,
  base: SchemaSnapshot,
  context: EditContext,
): ModelChanges {
  const model = editedSchema(state.snapshot, context);
  const live = editedSchema(base, context);
  const tables = new Map<string, ChangeMark>();
  const columns = new Map<string, Map<string, ChangeMark>>();
  let count = 0;
  for (const table of model.tables) {
    const origin = state.tableOrigins[table.name];
    const liveTable =
      origin === null || origin === undefined
        ? undefined
        : live.tables.find((t) => t.name === origin);
    if (!liveTable) {
      tables.set(table.name, 'new');
      count++;
      continue;
    }
    const marks = new Map<string, ChangeMark>();
    const origins = state.columnOrigins[table.name] ?? {};
    for (const column of table.columns) {
      const from = origins[column.name];
      const liveColumn =
        from === null || from === undefined
          ? undefined
          : liveTable.columns.find((c) => c.name === from);
      if (!liveColumn) marks.set(column.name, 'new');
      else if (columnChanged(column, liveColumn)) marks.set(column.name, 'changed');
    }
    const keptColumns = new Set(Object.values(origins));
    const droppedColumns = liveTable.columns.some((c) => !keptColumns.has(c.name));
    const order = (t: TableDef): string =>
      t.columns.map((c) => origins[c.name] ?? c.name).join(',');
    const changed =
      marks.size > 0 ||
      droppedColumns ||
      table.name !== liveTable.name ||
      (table.comment ?? '') !== (liveTable.comment ?? '') ||
      keyText(table.primaryKey) !== keyText(liveTable.primaryKey) ||
      table.uniques.map(keyText).join() !== liveTable.uniques.map(keyText).join() ||
      JSON.stringify(table.foreignKeys) !== JSON.stringify(liveTable.foreignKeys) ||
      (context.engine !== 'postgres' &&
        order(table) !== liveTable.columns.map((c) => c.name).join(','));
    if (marks.size > 0) columns.set(table.name, marks);
    if (changed) {
      tables.set(table.name, 'changed');
      count++;
    }
  }
  const kept = new Set(Object.values(state.tableOrigins));
  const dropped = live.tables.filter((t) => !kept.has(t.name)).map((t) => t.name);
  return { tables, columns, dropped, count: count + dropped.length };
}
