import {
  newId,
  type CheckDef,
  type ColumnDef,
  type ForeignKeyDef,
  type IndexDef,
  type KeyDef,
  type Partitioning,
  type SqlEngineId,
  type TableDef,
  type TriggerDef,
} from '@querybara/core';
import { emptyTable, newColumn, type DesignRenames, type ValidationIssue } from '@querybara/sync';

/**
 * The table designer's form (spec §8): the edited table as rows the user adds, removes,
 * reorders and renames. Every row keeps a stable id and the name it has on the server
 * (`liveName`, null for rows added in the designer), so a renamed row becomes a RENAME and
 * not a drop and an add: `renamesOf` hands the engine exactly the renames the user made.
 * Renaming a column also renames it in the keys, indexes and foreign keys that use it.
 */

export interface FormRow<T> {
  readonly id: string;
  /** The name on the server, or null for a row added in the designer. */
  readonly liveName: string | null;
  readonly def: T;
}

export interface DesignerForm {
  readonly engine: SqlEngineId;
  /** The table's name on the server, or null for a new table. */
  readonly liveName: string | null;
  readonly name: string;
  readonly kind: TableDef['kind'];
  readonly comment: string;
  readonly options: Readonly<Record<string, string>>;
  readonly owner?: string;
  readonly columns: readonly FormRow<ColumnDef>[];
  readonly primaryKey: FormRow<KeyDef> | null;
  readonly uniques: readonly FormRow<KeyDef>[];
  readonly indexes: readonly FormRow<IndexDef>[];
  readonly foreignKeys: readonly FormRow<ForeignKeyDef>[];
  readonly checks: readonly FormRow<CheckDef>[];
  readonly triggers: readonly FormRow<TriggerDef>[];
  readonly partitioning: Partitioning | null;
}

export type ListName = 'uniques' | 'indexes' | 'foreignKeys' | 'checks' | 'triggers';

type ListDef<L extends ListName> = DesignerForm[L][number]['def'];

function row<T extends { readonly name: string }>(def: T, live: boolean): FormRow<T> {
  return { id: newId(), liveName: live ? def.name : null, def };
}

/** The form for `table`; `live` says it exists on the server, so its names are live names. */
export function formFromTable(
  table: TableDef,
  engine: SqlEngineId,
  options: { readonly live: boolean },
): DesignerForm {
  const live = options.live;
  return {
    engine,
    liveName: live ? table.name : null,
    name: table.name,
    kind: table.kind,
    comment: table.comment ?? '',
    options: { ...table.options },
    ...(table.owner !== undefined ? { owner: table.owner } : {}),
    columns: [...table.columns].sort((a, b) => a.ordinal - b.ordinal).map((c) => row(c, live)),
    primaryKey: table.primaryKey ? row(table.primaryKey, live) : null,
    uniques: table.uniques.map((u) => row(u, live)),
    indexes: table.indexes.map((x) => row(x, live)),
    foreignKeys: table.foreignKeys.map((fk) => row(fk, live)),
    checks: table.checks.map((c) => row(c, live)),
    triggers: table.triggers.map((t) => row(t, live)),
    partitioning: table.partitioning ?? null,
  };
}

/** The primary key name a new key gets: PostgreSQL `<table>_pkey`, MySQL PRIMARY. */
export function primaryKeyName(engine: SqlEngineId, table: string): string {
  return engine === 'postgres' ? `${table}_pkey` : 'PRIMARY';
}

/**
 * A new table's form: an `id` key column that numbers itself (PostgreSQL identity, MySQL
 * AUTO_INCREMENT) and the engine's defaults (InnoDB and the database charset on MySQL).
 */
export function newTableForm(
  engine: SqlEngineId,
  name: string,
  defaults: { readonly charset?: string; readonly collation?: string } = {},
): DesignerForm {
  const base = emptyTable(engine, name, defaults);
  const id: ColumnDef = {
    name: 'id',
    ordinal: 1,
    dataType: 'bigint',
    nullable: false,
    default: null,
    autoIncrement: engine !== 'postgres',
    ...(engine === 'postgres' ? { identity: { generation: 'by-default' as const } } : {}),
  };
  return formFromTable(
    { ...base, columns: [id], primaryKey: { name: primaryKeyName(engine, name), columns: ['id'] } },
    engine,
    { live: false },
  );
}

/**
 * Renames the table. While it is new, a primary key still named after the old name follows
 * (PostgreSQL key names are relations, so `<table>_pkey` should match the table).
 */
export function renameTable(form: DesignerForm, name: string): DesignerForm {
  const key = form.primaryKey;
  const follows =
    form.liveName === null &&
    key !== null &&
    key.def.name === primaryKeyName(form.engine, form.name);
  return {
    ...form,
    name,
    ...(follows
      ? { primaryKey: { ...key, def: { ...key.def, name: primaryKeyName(form.engine, name) } } }
      : {}),
  };
}

/** The edited TableDef: rows in form order, ordinals from that order. */
export function tableFromForm(form: DesignerForm): TableDef {
  const comment = form.comment.trim() === '' ? undefined : form.comment;
  return {
    name: form.name,
    kind: form.kind,
    columns: form.columns.map((c, i) => ({ ...c.def, ordinal: i + 1 })),
    ...(form.primaryKey ? { primaryKey: form.primaryKey.def } : {}),
    uniques: form.uniques.map((u) => u.def),
    indexes: form.indexes.map((x) => x.def),
    foreignKeys: form.foreignKeys.map((fk) => fk.def),
    checks: form.checks.map((c) => c.def),
    triggers: form.triggers.map((t) => t.def),
    ...(form.partitioning ? { partitioning: form.partitioning } : {}),
    options: { ...form.options },
    ...(comment !== undefined ? { comment } : {}),
    ...(form.owner !== undefined ? { owner: form.owner } : {}),
  };
}

function renamed(rows: readonly FormRow<{ readonly name: string }>[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const r of rows) {
    if (r.liveName !== null && r.liveName !== r.def.name) out[r.liveName] = r.def.name;
  }
  return out;
}

/** The renames the user made, live name → edited name, for `designTable`. */
export function renamesOf(form: DesignerForm): DesignRenames {
  const columns = renamed(form.columns);
  const indexes = renamed(form.indexes);
  const constraints = renamed([
    ...(form.primaryKey ? [form.primaryKey] : []),
    ...form.uniques,
    ...form.checks,
    ...form.foreignKeys,
  ]);
  return {
    ...(Object.keys(columns).length > 0 ? { columns } : {}),
    ...(Object.keys(indexes).length > 0 ? { indexes } : {}),
    ...(Object.keys(constraints).length > 0 ? { constraints } : {}),
  };
}

/** Whether the form differs from `initial` (unsaved changes). */
export function isDirty(form: DesignerForm, initial: DesignerForm): boolean {
  return JSON.stringify(tableFromForm(form)) !== JSON.stringify(tableFromForm(initial));
}

function mapNames(names: readonly string[], from: string, to: string | null): string[] {
  const out: string[] = [];
  for (const name of names) {
    if (name !== from) out.push(name);
    else if (to !== null) out.push(to);
  }
  return out;
}

/**
 * Follows a column rename (`to`) or removal (`to` null) through the keys, indexes and foreign
 * keys that name it. A key or index left without columns is dropped; so is a foreign key that
 * loses a column, since its columns pair with the referenced ones.
 */
function followColumn(form: DesignerForm, from: string, to: string | null): DesignerForm {
  const key = (r: FormRow<KeyDef>): FormRow<KeyDef> => ({
    ...r,
    def: { ...r.def, columns: mapNames(r.def.columns, from, to) },
  });
  const primary = form.primaryKey ? key(form.primaryKey) : null;
  const indexes = form.indexes
    .map((r) => ({
      ...r,
      def: {
        ...r.def,
        columns: r.def.columns
          .filter((part) => to !== null || part.name !== from)
          .map((part) => (part.name === from ? { ...part, name: to } : part)),
        include: mapNames(r.def.include, from, to),
      },
    }))
    .filter((r) => r.def.columns.length > 0);
  const foreignKeys = form.foreignKeys
    .filter((r) => to !== null || !r.def.columns.includes(from))
    .map((r) => ({ ...r, def: { ...r.def, columns: mapNames(r.def.columns, from, to) } }));
  return {
    ...form,
    primaryKey: primary && primary.def.columns.length > 0 ? primary : null,
    uniques: form.uniques.map(key).filter((r) => r.def.columns.length > 0),
    indexes,
    foreignKeys,
  };
}

/** Renames a column row; the row keeps its identity, so saving renames the live column. */
export function renameColumn(form: DesignerForm, id: string, name: string): DesignerForm {
  const target = form.columns.find((c) => c.id === id);
  if (!target || target.def.name === name) return form;
  const others = form.columns.filter((c) => c.id !== id && c.def.name === target.def.name);
  const next: DesignerForm = {
    ...form,
    columns: form.columns.map((c) => (c.id === id ? { ...c, def: { ...c.def, name } } : c)),
  };
  // A duplicate name shared with another row: the references stay with that row.
  return others.length > 0 ? next : followColumn(next, target.def.name, name);
}

/** Changes a column's attributes other than its name. */
export function updateColumn(
  form: DesignerForm,
  id: string,
  patch: Partial<Omit<ColumnDef, 'name' | 'ordinal'>>,
): DesignerForm {
  return {
    ...form,
    columns: form.columns.map((c) => {
      if (c.id !== id) return c;
      const def: ColumnDef = { ...c.def, ...patch };
      // Optional attributes set to undefined are removed rather than kept as `undefined`.
      for (const [k, v] of Object.entries(patch)) {
        if (v === undefined) delete (def as Partial<ColumnDef>)[k as keyof ColumnDef];
      }
      return { ...c, def };
    }),
  };
}

/** Appends a new column row (a nullable varchar with an unused name) and returns its id. */
export function addColumn(form: DesignerForm): { form: DesignerForm; id: string } {
  const def = newColumn(form.engine, tableFromForm(form));
  const added = row(def, false);
  return { form: { ...form, columns: [...form.columns, added] }, id: added.id };
}

/** Removes a column row and its uses in keys, indexes and foreign keys. */
export function removeColumn(form: DesignerForm, id: string): DesignerForm {
  const target = form.columns.find((c) => c.id === id);
  if (!target) return form;
  const next = { ...form, columns: form.columns.filter((c) => c.id !== id) };
  const shared = next.columns.some((c) => c.def.name === target.def.name);
  return shared ? next : followColumn(next, target.def.name, null);
}

/** Moves a column row up (-1) or down (+1). */
export function moveColumn(form: DesignerForm, id: string, delta: -1 | 1): DesignerForm {
  const from = form.columns.findIndex((c) => c.id === id);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= form.columns.length) return form;
  const columns = [...form.columns];
  const [moved] = columns.splice(from, 1);
  columns.splice(to, 0, moved!);
  return { ...form, columns };
}

/** Adds the column to the primary key or takes it out (the key is created or dropped as needed). */
export function togglePrimaryKey(form: DesignerForm, column: string): DesignerForm {
  const current = form.primaryKey;
  const inKey = current?.def.columns.includes(column) ?? false;
  // Key columns follow the column order of the table; a column joining the key is NOT NULL.
  const order = form.columns.map((c) => c.def.name);
  const columns = inKey
    ? (current?.def.columns ?? []).filter((c) => c !== column)
    : [...(current?.def.columns ?? []), column].sort((a, b) => order.indexOf(a) - order.indexOf(b));
  const key: FormRow<KeyDef> | null =
    columns.length === 0
      ? null
      : current
        ? { ...current, def: { ...current.def, columns } }
        : {
            id: newId(),
            liveName: null,
            def: { name: primaryKeyName(form.engine, form.name), columns },
          };
  return {
    ...form,
    primaryKey: key,
    columns: inKey
      ? form.columns
      : form.columns.map((c) =>
          c.def.name === column && c.def.nullable
            ? { ...c, def: { ...c.def, nullable: false } }
            : c,
        ),
  };
}

/** Appends a row to one of the lists (uniques, indexes, foreign keys, checks, triggers). */
export function addListRow<L extends ListName>(
  form: DesignerForm,
  list: L,
  def: ListDef<L>,
): DesignerForm {
  const added = { id: newId(), liveName: null, def };
  return { ...form, [list]: [...form[list], added] };
}

/** Replaces the definition of a list row; a changed name stays a rename of the same row. */
export function updateListRow<L extends ListName>(
  form: DesignerForm,
  list: L,
  id: string,
  def: ListDef<L>,
): DesignerForm {
  const rows = form[list] as readonly FormRow<ListDef<L>>[];
  return { ...form, [list]: rows.map((r) => (r.id === id ? { ...r, def } : r)) };
}

export function removeListRow(form: DesignerForm, list: ListName, id: string): DesignerForm {
  const rows = form[list] as readonly FormRow<unknown>[];
  return { ...form, [list]: rows.filter((r) => r.id !== id) };
}

/** A name not used yet by the table's rows of that list: `<table>_<suffix>`, `_2`... */
export function freshName(form: DesignerForm, list: ListName, suffix: string): string {
  const taken = new Set(
    (form[list] as readonly FormRow<{ name: string }>[]).map((r) => r.def.name),
  );
  const base = `${form.name}_${suffix}`;
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base}${n}`)) return `${base}${n}`;
}

/**
 * The issues about one place in the edited table: `path` itself and everything under it
 * (`columns[2]` covers `columns[2].dataType`).
 */
export function issuesAt(
  issues: readonly ValidationIssue[],
  path: string,
  options: { readonly exact?: boolean } = {},
): ValidationIssue[] {
  return issues.filter(
    (issue) =>
      issue.path === path ||
      (!options.exact && (issue.path.startsWith(`${path}.`) || issue.path.startsWith(`${path}[`))),
  );
}
