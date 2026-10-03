import type {
  ColumnDef,
  ForeignKeyDef,
  IndexDef,
  SchemaDef,
  SchemaSnapshot,
  SequenceDef,
  SqlDialect,
  SqlEngineId,
  TableDef,
  ViewDef,
} from '@querybara/core';
import { quoteIdent } from '@querybara/sql-tools';

import { canonicalCharset } from '../normalize';
import { objectName, pgIndexDefinitionBody } from '../render';
import { isSqlKeyword, referencedNames, tokenizeSql } from '../sql-text';
import { findType, formatType, parseType, pgQualifiedType, typeCatalog } from './catalog';
import type { TypeCatalogEntry } from './catalog';
import { isReservedWord, maxIdentifierLength } from './names';
import type { DesignContext, ValidationIssue } from './types';

/**
 * Everything the designer derives once per call: the dialect, the accepted renames, the edited
 * table adapted to the snapshot producer conventions, and the live schema around it.
 */
export interface Prepared {
  readonly engine: SqlEngineId;
  readonly dialect: SqlDialect;
  readonly pg: boolean;
  readonly version: string | undefined;
  /** PostgreSQL schema or MySQL database of the table. */
  readonly schema: string;
  readonly snapshot: SchemaSnapshot | undefined;
  /** The schema holding the table in the snapshot (without the live table's own entry). */
  readonly schemaDef: SchemaDef | undefined;
  readonly live: TableDef | null;
  /** The edited table as the user left it. */
  readonly edited: TableDef;
  /** The edited table as it is compared and saved. */
  readonly table: TableDef;
  /** Live column name → edited name, for renames the sync engine can script. */
  readonly columnRenames: ReadonlyMap<string, string>;
  /** Old → new identifiers the script renames (table and columns): definitions follow them. */
  readonly identifierRenames: ReadonlyMap<string, string>;
  /** Owned sequences added for PostgreSQL serial columns. */
  readonly sequences: readonly SequenceDef[];
  readonly catalog: readonly TypeCatalogEntry[];
  /** Problems found while preparing (bad renames...). */
  readonly issues: readonly ValidationIssue[];
}

const clone = <T>(value: T): T => structuredClone(value);

/** The snapshot schema that holds the designed table. */
function contextSchema(context: DesignContext): SchemaDef | undefined {
  const schemas = context.snapshot?.schemas ?? [];
  const exact = schemas.find((s) => s.name === context.schema);
  if (exact !== undefined) return exact;
  if (context.engine !== 'postgres' && schemas.length === 1) return schemas[0];
  return undefined;
}

// ---------------------------------------------------------------------------------------------
// Following renames in SQL text

function bareIdentifier(name: string, dialect: SqlDialect): string {
  const simple = dialect === 'postgres' ? /^[a-z_][a-z0-9_$]*$/ : /^[A-Za-z_][A-Za-z0-9_$]*$/;
  return simple.test(name) && !isSqlKeyword(name) && !isReservedWord(name, dialect)
    ? name
    : quoteIdent(name, dialect);
}

/**
 * Substitutes renamed identifiers in SQL text the way the sync engine's normalisation does for
 * the live side (every word or quoted identifier equal to an old name), keeping the rest of the
 * text as written. PostgreSQL rewrites dependent definitions itself on rename; mirroring its
 * effect on the desired side keeps the diff from re-creating them.
 */
export function renameIdentifiers(
  text: string,
  dialect: SqlDialect,
  renames: ReadonlyMap<string, string>,
): string {
  if (renames.size === 0) return text;
  let changed = false;
  const out = tokenizeSql(text, dialect).map((token) => {
    let to: string | undefined;
    if (token.kind === 'word') {
      const folded =
        dialect === 'postgres' || isSqlKeyword(token.text) ? token.text.toLowerCase() : token.text;
      to = renames.get(folded);
      if (to !== undefined) {
        changed = true;
        return bareIdentifier(to, dialect);
      }
    } else if (token.kind === 'quoted-ident') {
      to = renames.get(token.value ?? '');
      if (to !== undefined) {
        changed = true;
        return quoteIdent(to, dialect);
      }
    }
    return token.text;
  });
  return changed ? out.join('') : text;
}

/**
 * Rewrites references to a renamed table and its renamed columns in a MySQL view or trigger,
 * which MySQL does not update by itself: qualified `t.col` and `NEW.col`/`OLD.col` members,
 * bare table names and bare column names. Aliases (`AS name`) keep their names, so a view's
 * output columns do not change.
 */
export function renameReferences(
  text: string,
  dialect: SqlDialect,
  table: { readonly from: string; readonly to: string },
  columns: ReadonlyMap<string, string>,
): string {
  const tokens = tokenizeSql(text, dialect);
  const significant = tokens
    .map((t, i) => ({ t, i }))
    .filter(({ t }) => t.kind !== 'ws' && t.kind !== 'comment');
  const nameOf = (i: number): string | undefined => {
    const t = tokens[i];
    if (t === undefined) return undefined;
    if (t.kind === 'quoted-ident') return t.value ?? '';
    if (t.kind === 'word') return t.text;
    return undefined;
  };
  const same = (a: string | undefined, b: string): boolean =>
    a !== undefined && (a === b || a.toLowerCase() === b.toLowerCase());
  const tableNames = [table.from, table.to];
  // Aliases of the table: `FROM t x`, `JOIN t AS x`.
  significant.forEach(({ i }, k) => {
    const name = nameOf(i);
    if (name === undefined || !tableNames.some((n) => same(name, n))) return;
    if (significant[k + 1]?.t.text === '.') return;
    let next = significant[k + 1];
    if (next?.t.kind === 'word' && next.t.text.toLowerCase() === 'as') next = significant[k + 2];
    if (next === undefined) return;
    const alias = nameOf(next.i);
    if (alias === undefined || (next.t.kind === 'word' && isSqlKeyword(alias))) return;
    if (
      /^(where|join|inner|left|right|full|cross|on|using|group|order|limit|union|set|for|natural|straight_join|window|having|lateral)$/i.test(
        alias,
      )
    )
      return;
    tableNames.push(alias);
  });
  const replaced = new Map<number, string>();
  significant.forEach(({ t, i }, k) => {
    const name = nameOf(i);
    if (name === undefined) return;
    const prev = significant[k - 1]?.t;
    const next = significant[k + 1]?.t;
    const write = (to: string): void => {
      replaced.set(
        i,
        t.kind === 'quoted-ident' ? quoteIdent(to, dialect) : bareIdentifier(to, dialect),
      );
    };
    if (prev?.kind === 'word' && prev.text.toLowerCase() === 'as') return;
    if (prev?.text === '.') {
      const qualifier = nameOf(significant[k - 2]?.i ?? -1);
      const ownTable =
        tableNames.some((n) => same(qualifier, n)) ||
        same(qualifier, 'new') ||
        same(qualifier, 'old');
      const to = ownTable ? columns.get(name) : undefined;
      if (to !== undefined) write(to);
      return;
    }
    if (next?.text === '.') {
      if (same(name, table.from) && table.from !== table.to) write(table.to);
      return;
    }
    if (tableNames.slice(2).some((alias) => same(name, alias))) return;
    if (name === table.from && table.from !== table.to) {
      write(table.to);
      return;
    }
    const to = columns.get(name);
    if (to !== undefined) write(to);
  });
  if (replaced.size === 0) return text;
  return tokens.map((t, i) => replaced.get(i) ?? t.text).join('');
}

/** Applies `fn` to every SQL expression of a table (defaults, generated, checks, indexes...). */
function mapTableSql(table: TableDef, fn: (text: string) => string): TableDef {
  return {
    ...table,
    columns: table.columns.map((c) => ({
      ...c,
      default: c.default === null ? null : fn(c.default),
      ...(c.generated !== undefined
        ? { generated: { ...c.generated, expression: fn(c.generated.expression) } }
        : {}),
      ...(c.onUpdate !== undefined ? { onUpdate: fn(c.onUpdate) } : {}),
    })),
    checks: table.checks.map((k) => ({ ...k, expression: fn(k.expression) })),
    indexes: table.indexes.map((index) => ({
      ...index,
      columns: index.columns.map((part) =>
        part.expression !== undefined ? { ...part, expression: fn(part.expression) } : part,
      ),
      ...(index.where !== undefined ? { where: fn(index.where) } : {}),
      ...(index.definition !== undefined ? { definition: fn(index.definition) } : {}),
    })),
    triggers: table.triggers.map((t) => ({ ...t, definition: fn(t.definition) })),
    ...(table.partitioning !== undefined
      ? {
          partitioning: {
            ...table.partitioning,
            key: fn(table.partitioning.key),
            partitions: table.partitioning.partitions.map((p) =>
              p.bound !== undefined ? { ...p, bound: fn(p.bound) } : p,
            ),
          },
        }
      : {}),
  };
}

// ---------------------------------------------------------------------------------------------
// Renames

function acceptRenames(
  live: TableDef | null,
  edited: TableDef,
  context: DesignContext,
  issues: ValidationIssue[],
): Map<string, string> {
  const accepted = new Map<string, string>();
  const requested = context.renames?.columns ?? {};
  for (const [from, to] of Object.entries(requested)) {
    if (from === to) continue;
    const path = `renames.columns.${from}`;
    if (live === null) {
      issues.push({
        path,
        code: 'rename-new-table',
        message: `A new table has no column ${from} to rename`,
        severity: 'error',
      });
      continue;
    }
    if (!live.columns.some((c) => c.name === from)) {
      issues.push({
        path,
        code: 'rename-unknown-column',
        message: `The live table has no column ${from} to rename`,
        severity: 'error',
      });
      continue;
    }
    if (!edited.columns.some((c) => c.name === to)) {
      issues.push({
        path,
        code: 'rename-unknown-column',
        message: `Column ${from} is renamed to ${to}, which is not in the edited table`,
        severity: 'error',
      });
      continue;
    }
    if (live.columns.some((c) => c.name === to)) {
      issues.push({
        path,
        code: 'rename-clash',
        message: `Column ${from} cannot take the name ${to} while the live table still has a column ${to}; rename one of them in a separate save`,
        severity: 'error',
      });
      continue;
    }
    accepted.set(from, to);
  }
  return accepted;
}

// ---------------------------------------------------------------------------------------------
// Adapting the edited table to the producer conventions

/** A column reference follows a rename when the edited table no longer has the old name. */
function followColumn(name: string, edited: TableDef, renames: ReadonlyMap<string, string>) {
  if (edited.columns.some((c) => c.name === name)) return name;
  return renames.get(name) ?? name;
}

function indexShape(index: IndexDef): string {
  return JSON.stringify({
    columns: index.columns.map((c) => ({
      name: c.name,
      expression: c.expression,
      order: c.order,
      length: c.length,
      nulls: c.nulls,
      collation: c.collation,
      opclass: c.opclass,
    })),
    unique: index.unique,
    method: index.method?.toLowerCase() ?? 'btree',
    where: index.where,
    include: index.include,
  });
}

/**
 * PostgreSQL indexes keep the server's CREATE INDEX text only while their structure still
 * matches the live index they came from; the text is then re-headed with the current index
 * and table names. A changed index is rendered from its structure.
 */
function adaptPgIndexes(
  table: TableDef,
  live: TableDef | null,
  context: DesignContext,
  renames: ReadonlyMap<string, string>,
  mirror: (text: string) => string,
): IndexDef[] {
  const indexRenames = new Map(
    Object.entries(context.renames?.indexes ?? {}).map(([from, to]) => [to, from]),
  );
  return table.indexes.map((index) => {
    if (index.definition === undefined) return index;
    const liveName = indexRenames.get(index.name) ?? index.name;
    const original = live?.indexes.find((i) => i.name === liveName);
    const mapped =
      original === undefined
        ? undefined
        : {
            ...original,
            columns: original.columns.map((c) =>
              c.name !== null
                ? { ...c, name: renames.get(c.name) ?? c.name }
                : { ...c, expression: mirror(c.expression ?? '') },
            ),
            include: original.include.map((c) => renames.get(c) ?? c),
            ...(original.where !== undefined ? { where: mirror(original.where) } : {}),
          };
    const parsed = pgIndexDefinitionBody(index.definition);
    if (mapped === undefined || parsed === null || indexShape(mapped) !== indexShape(index)) {
      const { definition: _stale, ...rest } = index;
      return rest;
    }
    return {
      ...index,
      definition: `CREATE ${index.unique ? 'UNIQUE ' : ''}INDEX ${quoteIdent(index.name, 'postgres')} ON ${objectName(table.name, 'postgres', context.schema)} ${parsed.body}`,
    };
  });
}

const SERIALS: Readonly<Record<string, string>> = {
  smallserial: 'smallint',
  serial2: 'smallint',
  serial: 'integer',
  serial4: 'integer',
  bigserial: 'bigint',
  serial8: 'bigint',
};

/**
 * PostgreSQL serial columns become what the server makes of them: an integer type, NOT NULL,
 * and a default drawing from an owned sequence `<table>_<column>_seq` (an existing sequence the
 * live column owns is reused).
 */
function expandSerials(
  table: TableDef,
  live: TableDef | null,
  schemaDef: SchemaDef | undefined,
  schema: string,
  renames: ReadonlyMap<string, string>,
): { table: TableDef; sequences: SequenceDef[] } {
  const sequences: SequenceDef[] = [];
  const taken = new Set<string>([
    ...(schemaDef?.sequences ?? []).map((s) => s.name),
    ...(schemaDef?.tables ?? []).map((t) => t.name),
    ...(schemaDef?.views ?? []).map((v) => v.name),
  ]);
  const liveNameOf = (column: string): string => {
    for (const [from, to] of renames) if (to === column) return from;
    return column;
  };
  const columns = table.columns.map((column): ColumnDef => {
    const base = SERIALS[column.dataType.trim().toLowerCase()];
    if (base === undefined) return column;
    const owners = [live?.name, table.name]
      .filter((t): t is string => t !== undefined)
      .flatMap((t) => [`${t}.${liveNameOf(column.name)}`, `${t}.${column.name}`]);
    let sequence = schemaDef?.sequences.find(
      (s) => s.ownedBy !== undefined && owners.includes(s.ownedBy),
    );
    if (sequence === undefined) {
      const limit = maxIdentifierLength('postgres') - 4;
      let name = `${table.name}_${column.name}`.slice(0, limit) + '_seq';
      for (let n = 1; taken.has(name); n++)
        name = `${table.name}_${column.name}`.slice(0, limit) + `_seq${n}`;
      taken.add(name);
      sequence = {
        name,
        dataType: base,
        start: '1',
        increment: '1',
        cycle: false,
        ownedBy: `${table.name}.${column.name}`,
      };
      sequences.push(sequence);
    }
    return {
      ...column,
      dataType: base,
      nullable: false,
      default: `nextval('${pgQualifiedType(schema, sequence.name).replaceAll("'", "''")}'::regclass)`,
    };
  });
  return { table: { ...table, columns }, sequences };
}

/**
 * Types the catalogue knows are written the way the server reports them (format_type() /
 * COLUMN_TYPE): `varchar(20)` → `character varying(20)` on PostgreSQL, `integer` → `int` and
 * `bool` → `tinyint(1)` on MySQL. Unknown spellings are left for validation to report.
 */
function spellTypes(
  table: TableDef,
  catalog: readonly TypeCatalogEntry[],
  dialect: SqlDialect,
): TableDef {
  const spell = (dataType: string): string => {
    const parsed = parseType(dataType, dialect);
    if (parsed === undefined) return dataType;
    const entry = findType(catalog, parsed);
    if (entry === undefined || entry.pseudo) return dataType;
    return formatType({ ...parsed, name: entry.name }, dialect);
  };
  return { ...table, columns: table.columns.map((c) => ({ ...c, dataType: spell(c.dataType) })) };
}

/** PostgreSQL user and extension types named without their schema get the snapshot's spelling. */
function qualifyPgTypes(
  table: TableDef,
  catalog: readonly TypeCatalogEntry[],
  schema: string,
): TableDef {
  const qualify = (dataType: string): string => {
    const parsed = parseType(dataType, 'postgres');
    if (parsed === undefined || parsed.name.includes('.') || parsed.name.includes('"')) {
      return dataType;
    }
    const builtin = findType(catalog, parsed);
    if (builtin !== undefined && builtin.userType === undefined && builtin.extension === undefined)
      return dataType;
    const own = catalog.find(
      (e) =>
        (e.userType !== undefined &&
          e.userType.schema === schema &&
          e.name.endsWith(`.${parsed.name}`)) ||
        (e.extension !== undefined && e.aliases.includes(parsed.name)),
    );
    if (own === undefined) return dataType;
    return dataType.trim().replace(/^[^([]+/, own.name);
  };
  return { ...table, columns: table.columns.map((c) => ({ ...c, dataType: qualify(c.dataType) })) };
}

/**
 * Partition bounds in the snapshot spelling: MySQL `VALUES LESS THAN (2025)`, `VALUES LESS THAN
 * MAXVALUE`, `VALUES IN (1,2)`; PostgreSQL `FOR VALUES ...` or `DEFAULT`. The designer's bound
 * field may hold just the value list.
 */
function spellPartitionBounds(table: TableDef, pg: boolean): TableDef {
  const partitioning = table.partitioning;
  if (partitioning === undefined) return table;
  const method = partitioning.method.trim().toUpperCase();
  const spell = (bound: string): string => {
    const text = bound.trim();
    if (pg) {
      if (/^(FOR\s+VALUES|DEFAULT)\b/i.test(text)) return text;
      return `FOR VALUES ${text}`;
    }
    if (/^VALUES\b/i.test(text)) return text;
    if (method.startsWith('LIST')) return `VALUES IN (${text.replace(/^\((.*)\)$/s, '$1')})`;
    if (/^MAXVALUE$/i.test(text)) return 'VALUES LESS THAN MAXVALUE';
    return `VALUES LESS THAN (${text.replace(/^\((.*)\)$/s, '$1')})`;
  };
  return {
    ...table,
    partitioning: {
      ...partitioning,
      partitions: partitioning.partitions.map((p) =>
        p.bound === undefined || p.bound.trim() === '' || (!pg && !/^(RANGE|LIST)/.test(method))
          ? p
          : { ...p, bound: spell(p.bound) },
      ),
    },
  };
}

/** The index MySQL creates for a foreign key without one whose leading columns it can use. */
function impliedMysqlIndexes(table: TableDef): IndexDef[] {
  const added: IndexDef[] = [];
  const leading = (columns: readonly (string | null)[], fk: ForeignKeyDef): boolean =>
    fk.columns.every((c, i) => columns[i] === c);
  for (const fk of table.foreignKeys) {
    const covered =
      (table.primaryKey !== undefined && leading(table.primaryKey.columns, fk)) ||
      [...table.indexes, ...added].some(
        (i) =>
          i.method?.toLowerCase() !== 'fulltext' &&
          leading(
            i.columns.map((c) => c.name),
            fk,
          ),
      );
    if (covered || fk.name === '') continue;
    if ([...table.indexes, ...added].some((i) => i.name === fk.name)) continue;
    added.push({
      name: fk.name,
      columns: fk.columns.map((name) => ({ name, order: 'asc' as const })),
      unique: false,
      include: [],
      invisible: false,
    });
  }
  return added;
}

/**
 * MariaDB's JSON is an alias: the column is stored as LONGTEXT COLLATE utf8mb4_bin with a
 * CHECK (json_valid(col)) named after it, and that is what the server reports back.
 */
function mariadbJsonAlias(table: TableDef): TableDef {
  const json = table.columns.filter((c) => /^json$/i.test(c.dataType.trim()));
  if (json.length === 0) return table;
  const checks = [...table.checks];
  const columns = table.columns.map((c) => {
    if (!json.includes(c)) return c;
    if (!checks.some((k) => k.name.toLowerCase() === c.name.toLowerCase())) {
      checks.push({ name: c.name, expression: `json_valid(${quoteIdent(c.name, 'mariadb')})` });
    }
    const { charset: _charset, ...rest } = c;
    const tableCharset = canonicalCharset(table.options.charset);
    return {
      ...rest,
      dataType: 'longtext',
      ...(tableCharset !== 'utf8mb4' ? { charset: 'utf8mb4' } : {}),
      collation: 'utf8mb4_bin',
    };
  });
  return { ...table, columns, checks };
}

/**
 * The edited table as the server will report it after saving, so that the diff compares like
 * with like and the next save against the re-read table is empty.
 */
function adaptTable(
  edited: TableDef,
  live: TableDef | null,
  context: DesignContext,
  dialect: SqlDialect,
  renames: ReadonlyMap<string, string>,
  identifierRenames: ReadonlyMap<string, string>,
  schemaDef: SchemaDef | undefined,
  catalog: readonly TypeCatalogEntry[],
): { table: TableDef; sequences: SequenceDef[] } {
  const pg = dialect === 'postgres';
  let table: TableDef = clone(edited);
  const follow = (name: string): string => followColumn(name, table, renames);
  const liveName = live?.name;
  const selfReference = (fk: ForeignKeyDef): boolean =>
    fk.refSchema === undefined && (fk.refTable === liveName || fk.refTable === table.name);
  table = {
    ...table,
    columns: table.columns.map((c, i) => ({ ...c, ordinal: i + 1 })),
    ...(table.primaryKey !== undefined
      ? { primaryKey: { ...table.primaryKey, columns: table.primaryKey.columns.map(follow) } }
      : {}),
    uniques: table.uniques.map((k) => ({ ...k, columns: k.columns.map(follow) })),
    indexes: table.indexes.map((index) => ({
      ...index,
      columns: index.columns.map((c) => (c.name !== null ? { ...c, name: follow(c.name) } : c)),
      include: index.include.map(follow),
    })),
    foreignKeys: table.foreignKeys.map((fk) => ({
      ...fk,
      columns: fk.columns.map(follow),
      ...(selfReference(fk) ? { refTable: table.name, refColumns: fk.refColumns.map(follow) } : {}),
    })),
  };
  table = mapTableSql(table, (text) => renameIdentifiers(text, dialect, identifierRenames));
  // Primary key and identity columns are NOT NULL whatever the column says: the server makes
  // them so, and reports them so.
  const keyColumns = new Set(table.primaryKey?.columns ?? []);
  table = {
    ...table,
    columns: table.columns.map((c) =>
      c.nullable && (keyColumns.has(c.name) || (pg && c.identity !== undefined))
        ? { ...c, nullable: false }
        : c,
    ),
  };
  table = spellPartitionBounds(table, pg);
  let sequences: SequenceDef[] = [];
  if (pg) {
    if (table.partitioning !== undefined && table.kind === 'table')
      table = { ...table, kind: 'partitioned' };
    table = qualifyPgTypes(table, catalog, context.schema);
    table = spellTypes(table, catalog, dialect);
    const expanded = expandSerials(table, live, schemaDef, context.schema, renames);
    const mirror = (text: string): string => renameIdentifiers(text, dialect, identifierRenames);
    table = {
      ...expanded.table,
      indexes: adaptPgIndexes(expanded.table, live, context, renames, mirror),
    };
    sequences = expanded.sequences;
  } else {
    table = spellTypes(table, catalog, dialect);
    table = {
      ...table,
      indexes: [
        ...table.indexes,
        ...table.uniques.map((k): IndexDef => ({
          name: k.name,
          columns: k.columns.map((name) => ({ name, order: 'asc' })),
          unique: true,
          include: [],
          invisible: false,
        })),
      ],
      uniques: [],
    };
    table = { ...table, indexes: [...table.indexes, ...impliedMysqlIndexes(table)] };
    const options = { ...table.options };
    const defaults = context.snapshot?.options ?? {};
    if (options.charset === undefined && options.collation === undefined) {
      const charset = live?.options.charset ?? defaults.charset;
      const collation = live?.options.collation ?? defaults.collation;
      if (charset !== undefined) options.charset = charset;
      if (collation !== undefined) options.collation = collation;
    }
    table = { ...table, options };
    if (dialect === 'mariadb') table = mariadbJsonAlias(table);
  }
  return { table, sequences };
}

// ---------------------------------------------------------------------------------------------

/** Derives everything the designer needs from the call's arguments. */
export function prepare(live: TableDef | null, edited: TableDef, context: DesignContext): Prepared {
  const engine = context.engine;
  const dialect: SqlDialect = engine;
  const pg = dialect === 'postgres';
  const version = context.serverVersion ?? context.snapshot?.serverVersion;
  const issues: ValidationIssue[] = [];
  const columnRenames = acceptRenames(live, edited, context, issues);
  const identifierRenames = new Map<string, string>();
  if (live !== null && live.name !== edited.name) identifierRenames.set(live.name, edited.name);
  for (const [from, to] of columnRenames) identifierRenames.set(from, to);
  const found = contextSchema(context);
  const schemaDef =
    found === undefined
      ? undefined
      : {
          ...found,
          tables: found.tables.filter((t) => t.name !== live?.name),
        };
  const catalog = typeCatalog(engine, version, context.snapshot);
  const { table, sequences } = adaptTable(
    edited,
    live,
    context,
    dialect,
    columnRenames,
    identifierRenames,
    schemaDef,
    catalog,
  );
  return {
    engine,
    dialect,
    pg,
    version,
    schema: context.schema,
    snapshot: context.snapshot,
    schemaDef,
    live,
    edited,
    table,
    columnRenames,
    identifierRenames,
    sequences,
    catalog,
    issues,
  };
}

// ---------------------------------------------------------------------------------------------
// The two snapshots the diff compares

/** Lower-cased `schema.name` key of a relation (the schema is '' on MySQL/MariaDB). */
function relKey(p: Prepared, schema: string, name: string): string {
  return `${p.pg ? schema.toLowerCase() : ''}.${name.toLowerCase()}`;
}

/** Views that depend on `tables` (directly or through other views), by schema. */
export function dependentViews(
  p: Prepared,
  tables: readonly { schema: string; name: string }[],
): { schema: SchemaDef; view: ViewDef }[] {
  const snapshot = p.snapshot;
  if (snapshot === undefined) return [];
  const keys = new Set(tables.map((t) => relKey(p, t.schema, t.name)));
  const found: { schema: SchemaDef; view: ViewDef }[] = [];
  let grew = true;
  while (grew) {
    grew = false;
    for (const schema of snapshot.schemas) {
      for (const view of schema.views) {
        const own = relKey(p, schema.name, view.name);
        if (keys.has(own)) continue;
        const refs = referencedNames(view.definition, p.dialect);
        const uses = refs.some((ref) =>
          keys.has(
            relKey(p, ref.schema !== undefined && p.pg ? ref.schema : schema.name, ref.name),
          ),
        );
        if (!uses) continue;
        keys.add(own);
        found.push({ schema, view });
        grew = true;
      }
    }
  }
  return found;
}

/** Tables of the snapshot with a foreign key to the live table. */
export function referencingTables(p: Prepared): { schema: SchemaDef; table: TableDef }[] {
  const live = p.live;
  if (live === null || p.snapshot === undefined) return [];
  const out: { schema: SchemaDef; table: TableDef }[] = [];
  for (const schema of p.snapshot.schemas) {
    if (!p.pg && schema.name !== p.schemaDef?.name) continue;
    for (const table of schema.tables) {
      if (schema.name === p.schemaDef?.name && table.name === live.name) continue;
      const refs = table.foreignKeys.some(
        (fk) =>
          fk.refTable === live.name &&
          (p.pg ? (fk.refSchema ?? schema.name) === p.schema : fk.refSchema === undefined),
      );
      if (refs) out.push({ schema, table });
    }
  }
  return out;
}

/** The snapshot table a foreign key of the designed table points at, if the snapshot has it. */
export function referencedTable(p: Prepared, fk: ForeignKeyDef): TableDef | undefined {
  if (fk.refSchema === undefined && fk.refTable === p.table.name) return p.table;
  if (fk.refSchema === undefined && p.live !== null && fk.refTable === p.live.name) return p.table;
  const schemaName = fk.refSchema ?? p.schemaDef?.name ?? p.schema;
  const schema =
    fk.refSchema === undefined
      ? p.schemaDef
      : p.snapshot?.schemas.find((s) => s.name === schemaName);
  return schema?.tables.find((t) => t.name === fk.refTable);
}

export interface Snapshots {
  readonly source: SchemaSnapshot;
  readonly target: SchemaSnapshot;
}

interface SchemaParts {
  tables: TableDef[];
  views: ViewDef[];
  sequences: SequenceDef[];
}

/**
 * The live and desired snapshots for the diff: the designed table, the tables its foreign keys
 * point at, the tables that reference it, the views that depend on it and the sequences of its
 * schema. Everything but the designed table is identical on both sides except where the save
 * changes it by itself: foreign keys of other tables follow the table and column renames, and
 * definitions mirror the sync engine's rename handling (MySQL views are rewritten, since MySQL
 * does not update them).
 */
export function buildSnapshots(p: Prepared, mode: 'design' | 'drop' = 'design'): Snapshots {
  const live = p.live;
  const snapshot = p.snapshot;
  const database = snapshot?.database ?? (p.pg ? 'postgres' : p.schema);
  const home = p.schemaDef?.name ?? p.schema;
  const sourceParts = new Map<string, SchemaParts>();
  const targetParts = new Map<string, SchemaParts>();
  const parts = (map: Map<string, SchemaParts>, schema: string): SchemaParts => {
    let entry = map.get(schema);
    if (!entry) map.set(schema, (entry = { tables: [], views: [], sequences: [] }));
    return entry;
  };
  parts(sourceParts, home);
  parts(targetParts, home);
  const mirror = (text: string): string => renameIdentifiers(text, p.dialect, p.identifierRenames);
  const mysqlTable = live !== null ? { from: live.name, to: p.table.name } : undefined;

  // An unreported MySQL ROW_FORMAT compares as the server default (see canonicalTableOptions).
  if (live !== null) parts(targetParts, home).tables.push(live);
  if (mode === 'design') parts(sourceParts, home).tables.push(p.table);

  const added = new Set<string>([relKey(p, home, live?.name ?? p.table.name)]);
  const addOther = (schema: string, table: TableDef): void => {
    const k = relKey(p, schema, table.name);
    if (added.has(k)) return;
    added.add(k);
    parts(targetParts, schema).tables.push(table);
    let source = mapTableSql(table, mirror);
    if (live !== null && mode === 'design') {
      source = {
        ...source,
        foreignKeys: source.foreignKeys.map((fk) => {
          const refSchema = p.pg ? (fk.refSchema ?? schema) : (fk.refSchema ?? home);
          if (fk.refTable !== live.name || (p.pg && refSchema !== home)) return fk;
          return {
            ...fk,
            refTable: p.table.name,
            refColumns: fk.refColumns.map((c) => p.columnRenames.get(c) ?? c),
          };
        }),
      };
    }
    parts(sourceParts, schema).tables.push(source);
  };
  for (const { schema, table } of referencingTables(p)) addOther(schema.name, table);
  if (snapshot !== undefined && mode === 'design') {
    for (const fk of [...p.table.foreignKeys, ...(live?.foreignKeys ?? [])]) {
      const schemaName = p.pg ? (fk.refSchema ?? home) : home;
      if (!p.pg && fk.refSchema !== undefined) continue;
      const schema = snapshot.schemas.find((s) => s.name === schemaName) ?? p.schemaDef;
      const table = schema?.tables.find((t) => t.name === fk.refTable);
      if (table === undefined || schema === undefined) continue;
      if (schemaName === home && table.name === live?.name) continue;
      addOther(schemaName, table);
    }
  }

  const tables = [{ schema: home, name: live?.name ?? p.table.name }];
  for (const { schema, view } of dependentViews(p, tables)) {
    parts(targetParts, schema.name).views.push(view);
    let definition = view.definition;
    if (mode === 'design') {
      definition = p.pg
        ? mirror(definition)
        : mysqlTable !== undefined
          ? renameReferences(definition, p.dialect, mysqlTable, p.columnRenames)
          : definition;
    }
    parts(sourceParts, schema.name).views.push({ ...view, definition });
  }
  if (p.pg || p.dialect === 'mariadb') {
    const sequences = p.schemaDef?.sequences ?? [];
    parts(targetParts, home).sequences.push(...sequences);
    parts(sourceParts, home).sequences.push(
      ...sequences,
      ...(mode === 'design' ? p.sequences : []),
    );
  }

  const toSnapshot = (map: Map<string, SchemaParts>): SchemaSnapshot => ({
    engine: p.engine,
    ...(p.version !== undefined ? { serverVersion: p.version } : {}),
    database,
    options: { ...(snapshot?.options ?? {}) },
    extensions: [],
    capturedAt: snapshot?.capturedAt ?? new Date(0).toISOString(),
    schemas: [...map].map(([name, content]) => {
      const original = snapshot?.schemas.find((s) => s.name === name);
      return {
        name,
        tables: content.tables,
        views: content.views,
        routines: [],
        sequences: content.sequences,
        types: [],
        events: [],
        ...(original?.comment !== undefined ? { comment: original.comment } : {}),
        ...(original?.owner !== undefined ? { owner: original.owner } : {}),
      };
    }),
  });
  return { source: toSnapshot(sourceParts), target: toSnapshot(targetParts) };
}
