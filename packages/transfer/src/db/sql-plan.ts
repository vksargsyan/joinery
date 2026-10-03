import {
  tableDefSchema,
  type CheckDef,
  type ColumnDef,
  type ForeignKeyDef,
  type IndexDef,
  type KeyDef,
  type SchemaDef,
  type SchemaSnapshot,
  type SqlDialect,
  type TableDef,
} from '@querybara/core';
import { quoteIdent, quoteQualified, quoteString } from '@querybara/sql-tools';
import {
  parseType,
  renderForeignKey,
  renderMysqlIndexClause,
  renderPgCreateIndex,
  renderPrimaryKey,
  renderTableStatements,
  renderType,
  renderUnique,
} from '@querybara/sync';

import type { ColumnMapping } from '../mapping';
import { qualifiedTable } from '../statements';
import { UniqueNames, fitIdentifier, isSafeDataType } from './names';
import type {
  ColumnOverride,
  DbTableMode,
  DbTransferOptions,
  PlannedColumn,
  PlannedTable,
  TransferObjectSpec,
} from './spec';
import {
  domainBaseType,
  isIntegerType,
  mapSqlType,
  readExpression,
  type ReadForm,
  type SourceUserType,
} from './type-map';
import { sqlCellAdapter, type CellAdapter } from './values';

/**
 * Planning a SQL → SQL transfer (spec §12): each source table becomes a target table built
 * with the engine pair's type mapping and the user's overrides, or an existing table filled by
 * matching column names. The DDL comes from @querybara/sync's renderers, so a created table reads
 * back exactly as the table designer would have made it. Keys, indexes and foreign keys that
 * slow a load down are split off to run after the data: on PostgreSQL the primary key too; on
 * MySQL and MariaDB the primary key stays in CREATE TABLE, since InnoDB clusters rows by it and
 * adding it later would rebuild the table.
 */

/** Everything the loader needs about one table. */
export interface SqlTableLoad {
  readonly planned: PlannedTable;
  readonly source: TableDef;
  /** The target table's definition as loaded into (created or existing). */
  readonly target: TableDef;
  /** SELECT on the source, with each column read in the form the target takes. */
  readonly select: string;
  readonly selectColumns: readonly string[];
  readonly adapters: readonly CellAdapter[];
  readonly mapping: readonly ColumnMapping[];
  /** After the load, on the target: keys and indexes. */
  readonly finish: readonly string[];
  /** Target columns whose sequence or AUTO_INCREMENT counter moves past the data. */
  readonly counters: readonly string[];
}

export interface SqlPlan {
  readonly tables: readonly SqlTableLoad[];
  /** Target statements before any data: schema, types, drops, creates, truncates. */
  readonly before: readonly string[];
  /** Foreign keys, added once every table is loaded (with the tables they join). */
  readonly foreignKeys: readonly {
    readonly table: string;
    readonly refTable: string;
    readonly sql: string;
  }[];
  readonly problems: readonly string[];
  readonly warnings: readonly string[];
}

export interface SqlPlanInput {
  readonly from: SqlDialect;
  readonly to: SqlDialect;
  readonly targetVersion: string;
  readonly sourceSchema: string | undefined;
  readonly targetSchema: string | undefined;
  readonly source: SchemaSnapshot;
  readonly target: SchemaSnapshot;
  readonly objects: readonly TransferObjectSpec[];
  readonly options: DbTransferOptions;
  /** Source row estimates by table name. */
  readonly rows?: ReadonlyMap<string, number>;
}

function schemaOf(snapshot: SchemaSnapshot, name: string | undefined): SchemaDef | undefined {
  return name === undefined ? snapshot.schemas[0] : snapshot.schemas.find((s) => s.name === name);
}

/** The table named `name`: exactly, else (MySQL, case-insensitive servers) ignoring case. */
function findTable(
  schema: SchemaDef | undefined,
  name: string,
  dialect: SqlDialect,
): TableDef | undefined {
  const tables = schema?.tables ?? [];
  return (
    tables.find((t) => t.name === name) ??
    (dialect === 'postgres'
      ? undefined
      : tables.find((t) => t.name.toLowerCase() === name.toLowerCase()))
  );
}

/** PostgreSQL user types of a snapshot, by qualified name. */
function userTypesOf(snapshot: SchemaSnapshot): Map<string, SourceUserType> {
  const types = new Map<string, SourceUserType>();
  for (const schema of snapshot.schemas) {
    for (const type of schema.types) {
      types.set(`${quotedPart(schema.name)}.${quotedPart(type.name)}`, {
        ...type,
        schema: schema.name,
      });
    }
  }
  return types;
}

/** A name as PostgreSQL's format_type prints it inside a qualified name. */
function quotedPart(name: string): string {
  return /^[a-z_][a-z0-9_$]*$/.test(name) ? name : `"${name.replace(/"/g, '""')}"`;
}

/** A MariaDB JSON column: `longtext` with a `json_valid` check named after it. */
function isMariadbJson(table: TableDef, column: ColumnDef, dialect: SqlDialect): boolean {
  if (dialect !== 'mariadb' || !/text$/i.test(column.dataType)) return false;
  const check = table.checks.find((c) => c.name.toLowerCase() === column.name.toLowerCase());
  return check !== undefined && /json_valid/i.test(check.expression);
}

/** Columns that end up in a key or index of the target. */
function keyColumnsOf(table: TableDef, from: SqlDialect, to: SqlDialect): Set<string> {
  const keys = new Set<string>(table.primaryKey?.columns ?? []);
  for (const unique of table.uniques) for (const c of unique.columns) keys.add(c);
  for (const index of table.indexes) {
    // Indexes the target will not get do not count.
    const dropped =
      from !== to &&
      (index.where !== undefined ||
        index.columns.some((c) => c.name === null) ||
        (to !== 'postgres' && PG_ONLY_METHODS.has(index.method?.toLowerCase() ?? '')));
    if (dropped) continue;
    for (const c of index.columns) if (c.name !== null) keys.add(c.name);
  }
  return keys;
}

const CURRENT_TIMESTAMP = /^(?:current_timestamp|now|localtimestamp)(?:\s*\(\s*(\d*)\s*\))?$/i;
const NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i;

/**
 * A default expression that means the same on the target: numbers, strings, booleans, NULL
 * and the current timestamp. Other expressions are left out (the data is copied anyway).
 */
function translateDefault(
  text: string,
  from: SqlDialect,
  to: SqlDialect,
  targetType: string,
): string | null | undefined {
  if (from === to) return text;
  let value = text.trim();
  // PostgreSQL casts its literals: 'abc'::character varying, (0)::numeric.
  value = value.replace(/::[\w\s."[\]()]+$/, '').trim();
  while (/^\(.*\)$/.test(value)) value = value.slice(1, -1).trim();
  const kind = parseType(targetType, to)?.name ?? '';
  const boolTarget =
    to === 'postgres' ? kind === 'boolean' : kind === 'tinyint' && /\(1\)/.test(targetType);
  if (/^null$/i.test(value)) return 'NULL';
  const now = CURRENT_TIMESTAMP.exec(value);
  if (now) {
    const digits = /\((\d+)\)/.exec(targetType)?.[1];
    if (to === 'postgres') return 'CURRENT_TIMESTAMP';
    return digits !== undefined && digits !== '0'
      ? `CURRENT_TIMESTAMP(${digits})`
      : 'CURRENT_TIMESTAMP';
  }
  if (/^(true|false)$/i.test(value)) {
    const truth = value.toLowerCase() === 'true';
    return to === 'postgres' ? (truth ? 'true' : 'false') : truth ? '1' : '0';
  }
  let literal: string | undefined;
  if (NUMBER.test(value)) literal = value;
  else if (/^'(?:[^'\\]|''|\\.)*'$/s.test(value)) {
    const inner = value.slice(1, -1).replace(/''/g, "'");
    const unescaped = from === 'postgres' ? inner : inner.replace(/\\(.)/g, '$1');
    literal = quoteString(unescaped, to);
    if (boolTarget && /^'[01]'$/.test(literal)) literal = literal.slice(1, -1);
  }
  if (literal === undefined) return undefined;
  if (boolTarget && to === 'postgres' && /^[01]$/.test(literal))
    return literal === '1' ? 'true' : 'false';
  return literal;
}

/** `nextval('seq'::regclass)`: a serial column. */
function isSerial(column: ColumnDef): boolean {
  return /^nextval\(/i.test(column.default ?? '');
}

/** An object named after its table (`orders_pkey`) follows the table's new name. */
function renamed(name: string, from: string, to: string): string {
  return from !== to && name.startsWith(from) ? `${to}${name.slice(from.length)}` : name;
}

interface Context {
  readonly input: SqlPlanInput;
  readonly userTypes: Map<string, SourceUserType>;
  readonly targetTypes: Map<string, SourceUserType>;
  /** PostgreSQL index and constraint names are unique per schema; MySQL FK and check names per database. */
  readonly schemaNames: UniqueNames;
  /** Enum types to create on a PostgreSQL target, by qualified name. */
  readonly createTypes: Map<string, string[]>;
}

interface Built {
  readonly table: TableDef;
  readonly columns: PlannedColumn[];
  /** Source column → its target column name. */
  readonly names: Map<string, string>;
  readonly finish: string[];
  readonly counters: string[];
  readonly warnings: string[];
  readonly problems: string[];
  readonly reads: Map<string, ReadForm>;
}

/** Builds the target definition of a table that is created. */
function buildTable(
  context: Context,
  source: TableDef,
  object: TransferObjectSpec,
  targetName: string,
): Built {
  const { from, to, targetVersion } = context.input;
  const same = from === to;
  const overrides = new Map((object.columns ?? []).map((o) => [o.source, o]));
  const keys = keyColumnsOf(source, from, to);
  const columnNames = new UniqueNames(to);
  const names = new Map<string, string>();
  const reads = new Map<string, ReadForm>();
  const warnings: string[] = [];
  const problems: string[] = [];
  const planned: PlannedColumn[] = [];
  const columns: ColumnDef[] = [];
  const counters: string[] = [];
  const pkColumns = new Set(source.primaryKey?.columns ?? []);

  for (const column of [...source.columns].sort((a, b) => a.ordinal - b.ordinal)) {
    const override: ColumnOverride | undefined = overrides.get(column.name);
    const json = isMariadbJson(source, column, from);
    const mapped = mapSqlType(column.dataType, {
      from,
      to,
      targetVersion,
      key: keys.has(column.name),
      userTypes: context.userTypes,
      json,
    });
    let defaultType = mapped.dataType;
    let note = mapped.note;
    // PostgreSQL → PostgreSQL user types: reuse the target's, create enums, flatten domains.
    if (same && to === 'postgres') {
      const user = context.userTypes.get(column.dataType.replace(/\[\]$/, ''));
      if (user !== undefined && !context.targetTypes.has(column.dataType.replace(/\[\]$/, ''))) {
        const schema = context.input.targetSchema ?? 'public';
        if (user.kind === 'enum') {
          const qualified = `${quotedPart(schema)}.${quotedPart(user.name)}`;
          if (!context.targetTypes.has(qualified))
            context.createTypes.set(qualified, [...user.values]);
          defaultType = column.dataType.endsWith('[]') ? `${qualified}[]` : qualified;
        } else if (user.kind === 'domain') {
          defaultType = domainBaseType(user.definition) ?? 'text';
          note = `The domain ${user.name} is not on the target; its base type is used`;
        } else {
          defaultType = 'text';
          note = `${user.name} is not on the target; copied as text`;
        }
      }
    }
    const requested = override?.dataType?.trim();
    const targetType = requested !== undefined && requested !== '' ? requested : defaultType;
    const target = columnNames.claim(override?.target?.trim() || column.name);
    const skipped = override?.skip === true;
    if (!isSafeDataType(targetType)) {
      problems.push(`"${targetType}" is not a column type Querybara can use (${column.name})`);
    }
    if (override?.target !== undefined && fitIdentifier(override.target, to) !== override.target) {
      warnings.push(`Column name ${override.target} was cut to ${target}`);
    }
    // A generated column is recomputed by a target of the same dialect; elsewhere its values are copied.
    const generated = same && column.generated !== undefined;
    planned.push({
      source: column.name,
      target,
      sourceType: column.dataType,
      targetType,
      defaultType,
      nullable: column.nullable,
      key: pkColumns.has(column.name),
      editable: true,
      skipped,
      ...(generated
        ? { note: 'Generated: the target computes it' }
        : note !== undefined && requested === undefined
          ? { note }
          : {}),
    });
    if (skipped) {
      if (pkColumns.has(column.name))
        warnings.push(`${column.name} is skipped, so the primary key is left out`);
      continue;
    }
    names.set(column.name, target);
    const numbering =
      column.identity !== undefined ||
      column.autoIncrement ||
      (from === 'postgres' && isSerial(column));
    const canNumber = numbering && isIntegerType(targetType, to);
    if (numbering && !canNumber && !generated) {
      warnings.push(
        `${column.name} numbered itself on the source; ${targetType} cannot, so new rows need their own values`,
      );
    }
    if (mapped.read !== undefined && requested === undefined) reads.set(column.name, mapped.read);
    const def: ColumnDef = {
      name: target,
      ordinal: columns.length + 1,
      dataType: targetType,
      nullable: column.nullable && !pkColumns.has(column.name),
      default: null,
      autoIncrement: false,
    };
    let result: ColumnDef = def;
    if (generated) {
      result = { ...def, generated: column.generated!, default: null };
    } else if (canNumber && to === 'postgres') {
      result = {
        ...def,
        nullable: false,
        identity: {
          generation: same && column.identity?.generation === 'always' ? 'always' : 'by-default',
        },
      };
      counters.push(target);
    } else if (canNumber) {
      // MySQL numbers only a key column; the primary key comes with CREATE TABLE.
      if (pkColumns.has(column.name) && source.primaryKey?.columns[0] === column.name) {
        result = { ...def, autoIncrement: true, nullable: false };
        counters.push(target);
      } else {
        warnings.push(
          `${column.name} is not the first primary key column, so it cannot be AUTO_INCREMENT`,
        );
      }
    } else if (column.default !== null && !isSerial(column)) {
      const value = translateDefault(column.default, from, to, targetType);
      if (value === undefined) {
        warnings.push(`The default of ${column.name} (${column.default}) is left out`);
      } else if (value !== null) {
        result = { ...def, default: value };
      }
    }
    if (same || (from !== 'postgres' && to !== 'postgres')) {
      if (column.charset !== undefined) result = { ...result, charset: column.charset };
      if (same && column.collation !== undefined)
        result = { ...result, collation: column.collation };
      if (column.onUpdate !== undefined) result = { ...result, onUpdate: column.onUpdate };
    } else if (column.onUpdate !== undefined) {
      warnings.push(`${column.name}: ON UPDATE ${column.onUpdate} is left out`);
    }
    if (column.comment !== undefined && column.comment !== '')
      result = { ...result, comment: column.comment };
    columns.push(result);
  }

  const mapCols = (list: readonly string[]): string[] | undefined => {
    const out: string[] = [];
    for (const name of list) {
      const target = names.get(name);
      if (target === undefined) return undefined;
      out.push(target);
    }
    return out;
  };
  const pgTarget = to === 'postgres';
  const schemaName = (name: string): string => context.schemaNames.claim(fitIdentifier(name, to));

  let primaryKey: KeyDef | undefined;
  if (source.primaryKey !== undefined) {
    const cols = mapCols(source.primaryKey.columns);
    if (cols !== undefined) {
      primaryKey = {
        name: pgTarget
          ? schemaName(
              from === 'postgres'
                ? renamed(source.primaryKey.name, source.name, targetName)
                : `${targetName}_pkey`,
            )
          : 'PRIMARY',
        columns: cols,
      };
    }
  }
  const uniques: KeyDef[] = [];
  const indexes: IndexDef[] = [];
  for (const unique of source.uniques) {
    const cols = mapCols(unique.columns);
    if (cols === undefined) continue;
    const name = renamed(unique.name, source.name, targetName);
    if (pgTarget) uniques.push({ name: schemaName(name), columns: cols });
    else
      indexes.push({
        name: fitIdentifier(name, to),
        columns: cols.map(indexColumn),
        unique: true,
        include: [],
        invisible: false,
      });
  }
  const tableIndexNames = new UniqueNames(to, primaryKey ? ['PRIMARY'] : []);
  const textTypes = new Map(columns.map((c) => [c.name, c.dataType]));
  for (const index of source.indexes) {
    const translated = translateIndex(index, context, source.name, targetName, names, textTypes);
    if (typeof translated === 'string') {
      warnings.push(translated);
      continue;
    }
    const name = pgTarget ? schemaName(translated.name) : tableIndexNames.claim(translated.name);
    indexes.push({ ...translated, name });
  }
  const checks: CheckDef[] = [];
  if (same) {
    for (const check of source.checks) {
      // MariaDB column checks stay named after their column.
      const own =
        from === 'mariadb' &&
        source.columns.some((c) => c.name.toLowerCase() === check.name.toLowerCase());
      if (own) {
        const target = names.get(
          source.columns.find((c) => c.name.toLowerCase() === check.name.toLowerCase())!.name,
        );
        if (target !== undefined && target === check.name) checks.push(check);
        continue;
      }
      checks.push({ ...check, name: schemaName(renamed(check.name, source.name, targetName)) });
    }
  } else if (source.checks.some((c) => !(from === 'mariadb' && /json_valid/i.test(c.expression)))) {
    warnings.push(
      'Check constraints are left out: their expressions are written for the source engine',
    );
  }

  const tableOptions: Record<string, string> = {};
  if (to !== 'postgres') {
    if (from !== 'postgres') {
      if (source.options['engine'] !== undefined) tableOptions['engine'] = source.options['engine'];
      if (source.options['charset'] !== undefined)
        tableOptions['charset'] = source.options['charset'];
      if (same && source.options['collation'] !== undefined)
        tableOptions['collation'] = source.options['collation'];
      if (same && source.options['rowFormat'] !== undefined)
        tableOptions['rowFormat'] = source.options['rowFormat'];
    } else {
      tableOptions['charset'] = 'utf8mb4';
    }
  } else if (same) {
    for (const [key, value] of Object.entries(source.options))
      if (key !== 'tablespace') tableOptions[key] = value;
  }

  const full = tableDefSchema.parse({
    name: targetName,
    columns,
    ...(primaryKey !== undefined ? { primaryKey } : {}),
    uniques,
    indexes,
    checks,
    options: tableOptions,
    ...(source.comment !== undefined && source.comment !== '' ? { comment: source.comment } : {}),
  });

  const defer = context.input.options.deferConstraints;
  const schema = context.input.targetSchema;
  const quoted = qualifiedTable(targetName, to, schema);
  const finish: string[] = [];
  let created: TableDef;
  if (pgTarget) {
    created = defer
      ? { ...full, primaryKey: undefined, uniques: [], indexes: [] }
      : { ...full, indexes: [] };
    if (defer) {
      if (full.primaryKey !== undefined)
        finish.push(`ALTER TABLE ${quoted} ADD ${renderPrimaryKey(full.primaryKey, to)}`);
      for (const unique of full.uniques)
        finish.push(`ALTER TABLE ${quoted} ADD ${renderUnique(unique, to)}`);
    }
    // Indexes follow the data whether or not the rest is deferred: cheaper than maintaining them.
    for (const index of full.indexes) finish.push(renderPgCreateIndex(index, targetName, schema));
  } else {
    created = defer ? { ...full, indexes: [] } : full;
    if (defer && full.indexes.length > 0) {
      finish.push(
        `ALTER TABLE ${quoted} ${full.indexes.map((index) => `ADD ${renderMysqlIndexClause(index, to)}`).join(', ')}`,
      );
    }
  }
  return {
    table: tableDefSchema.parse(created),
    columns: planned,
    names,
    finish,
    counters: context.input.options.resetSequences ? counters : [],
    warnings,
    problems,
    reads,
  };

  function indexColumn(name: string): IndexDef['columns'][number] {
    return { name, order: 'asc' };
  }
}

const PG_ONLY_METHODS = new Set(['gin', 'gist', 'brin', 'spgist', 'bloom']);
const MYSQL_LONG = /^(tiny|medium|long)?(text|blob)$/;

/** An index for the target, or why it is left out. */
function translateIndex(
  index: IndexDef,
  context: Context,
  sourceTable: string,
  targetTable: string,
  names: ReadonlyMap<string, string>,
  targetTypes: ReadonlyMap<string, string>,
): IndexDef | string {
  const { from, to } = context.input;
  const same = from === to;
  const columns: IndexDef['columns'] = [];
  for (const part of index.columns) {
    if (part.name === null) {
      if (!same)
        return `Index ${index.name} uses an expression, which is written for the source engine; left out`;
      columns.push(part);
      continue;
    }
    const name = names.get(part.name);
    if (name === undefined) return `Index ${index.name} uses a skipped column; left out`;
    let entry: IndexDef['columns'][number] = { ...part, name };
    if (!same) {
      entry = { name, order: part.order };
      const type = parseType(targetTypes.get(name) ?? '', to)?.name ?? '';
      if (to !== 'postgres' && MYSQL_LONG.test(type))
        entry = { ...entry, length: part.length ?? 255 };
      if (to !== 'postgres' && from !== 'postgres' && part.length !== undefined)
        entry = { ...entry, length: part.length };
    }
    columns.push(entry);
  }
  const method = index.method?.toLowerCase();
  let name = renamed(index.name, sourceTable, targetTable);
  if (same) {
    const { definition: _server, ...rest } = index;
    return { ...rest, name, columns, include: index.include.map((c) => names.get(c) ?? c) };
  }
  if (to !== 'postgres' && method !== undefined && PG_ONLY_METHODS.has(method)) {
    return `Index ${index.name} uses ${method}, which MySQL does not have; left out`;
  }
  if (to === 'postgres' && (method === 'fulltext' || method === 'spatial')) {
    return `Index ${index.name} is a ${method.toUpperCase()} index, which PostgreSQL does not have; left out`;
  }
  if (index.where !== undefined)
    return `Index ${index.name} is partial, which MySQL does not have; left out`;
  // MySQL index names are per table, PostgreSQL's per schema: prefix them with the table.
  if (to === 'postgres' && !name.toLowerCase().startsWith(`${targetTable.toLowerCase()}_`)) {
    name = `${targetTable}_${name}`;
  }
  const keep =
    from !== 'postgres' && to !== 'postgres' && (method === 'fulltext' || method === 'spatial');
  return {
    name,
    columns,
    unique: index.unique,
    include: [],
    invisible: false,
    ...(keep ? { method: index.method! } : {}),
    ...(index.comment !== undefined && to !== 'postgres' ? { comment: index.comment } : {}),
  };
}

/** The mapping into an existing table: source columns matched to target columns by name. */
function matchExisting(
  context: Context,
  source: TableDef,
  object: TransferObjectSpec,
  existing: TableDef,
): Built {
  const { to, options } = context.input;
  const overrides = new Map((object.columns ?? []).map((o) => [o.source, o]));
  const insertable = existing.columns.filter((c) => c.generated === undefined);
  const exact = new Map(insertable.map((c) => [c.name, c]));
  const folded = new Map(insertable.map((c) => [c.name.toLowerCase(), c]));
  const names = new Map<string, string>();
  const planned: PlannedColumn[] = [];
  const warnings: string[] = [];
  const used = new Set<string>();
  const pk = new Set(existing.primaryKey?.columns ?? []);
  for (const column of [...source.columns].sort((a, b) => a.ordinal - b.ordinal)) {
    const override = overrides.get(column.name);
    const wanted = override?.target?.trim() || column.name;
    const match = exact.get(wanted) ?? folded.get(wanted.toLowerCase());
    const skipped = override?.skip === true || match === undefined || used.has(match.name);
    planned.push({
      source: column.name,
      target: match?.name ?? wanted,
      sourceType: column.dataType,
      targetType: match?.dataType ?? '',
      defaultType: match?.dataType ?? '',
      nullable: match?.nullable ?? true,
      key: match !== undefined && pk.has(match.name),
      editable: false,
      skipped,
      ...(match === undefined ? { note: `${existing.name} has no column ${wanted}` } : {}),
    });
    if (skipped || match === undefined) continue;
    used.add(match.name);
    names.set(column.name, match.name);
  }
  const missing = insertable.filter(
    (c) =>
      !used.has(c.name) &&
      !c.nullable &&
      c.default === null &&
      c.identity === undefined &&
      !c.autoIncrement,
  );
  if (missing.length > 0) {
    warnings.push(
      `${missing.map((c) => c.name).join(', ')} ${missing.length === 1 ? 'is' : 'are'} NOT NULL without a default and not copied into; rows will fail`,
    );
  }
  const counters = options.resetSequences
    ? existing.columns
        .filter(
          (c) =>
            used.has(c.name) &&
            (c.identity !== undefined || c.autoIncrement || (to === 'postgres' && isSerial(c))),
        )
        .map((c) => c.name)
    : [];
  return {
    table: existing,
    columns: planned,
    names,
    finish: [],
    counters,
    warnings,
    problems: [],
    reads: new Map(),
  };
}

/**
 * Plans a SQL → SQL transfer from both sides' snapshots. Problems (a missing source table, a
 * table that exists in `create` mode, a drop or truncate that other tables' foreign keys
 * would block) are reported, not thrown.
 */
export function planSqlTransfer(input: SqlPlanInput): SqlPlan {
  const { from, to, options } = input;
  const sourceSchema = schemaOf(input.source, input.sourceSchema);
  const targetSchema = schemaOf(input.target, input.targetSchema);
  const context: Context = {
    input,
    userTypes: userTypesOf(input.source),
    targetTypes: userTypesOf(input.target),
    schemaNames: new UniqueNames(to),
    createTypes: new Map(),
  };
  const targetNames = new Map<string, string>();
  const plannedTargets = new Set<string>();
  const problems: string[] = [];
  const warnings: string[] = [];
  const tables: SqlTableLoad[] = [];
  const drops: string[] = [];
  const truncates: string[] = [];
  const creates: string[] = [];
  const dropping = new Set<string>();
  const emptying = new Set<string>();

  // Names the target already uses, except those of tables this transfer drops.
  const plannedDrops = new Set(
    input.objects
      .filter((o) => (o.mode ?? options.mode) === 'drop-create')
      .map((o) => (o.target ?? o.name).toLowerCase()),
  );
  for (const table of targetSchema?.tables ?? []) {
    if (plannedDrops.has(table.name.toLowerCase())) continue;
    if (to === 'postgres') {
      if (table.primaryKey) context.schemaNames.claim(table.primaryKey.name);
      for (const u of table.uniques) context.schemaNames.claim(u.name);
      for (const i of table.indexes) context.schemaNames.claim(i.name);
    } else {
      for (const fk of table.foreignKeys) context.schemaNames.claim(fk.name);
      for (const c of table.checks) context.schemaNames.claim(c.name);
    }
  }

  for (const object of input.objects) {
    const source = findTable(sourceSchema, object.name, from);
    const targetName = fitIdentifier(object.target?.trim() || object.name, to);
    const mode: DbTableMode = object.mode ?? options.mode;
    const base = { source: object.name, target: targetName, kind: 'table' as const };
    if (source === undefined) {
      const message = `Table ${object.name} was not found on the source`;
      problems.push(message);
      tables.push(
        emptyLoad({
          ...base,
          action: mode,
          exists: false,
          columns: [],
          problems: [message],
          warnings: [],
        }),
      );
      continue;
    }
    if (plannedTargets.has(targetName.toLowerCase())) {
      const message = `Two tables are transferred into ${targetName}`;
      problems.push(message);
    }
    plannedTargets.add(targetName.toLowerCase());
    targetNames.set(source.name, targetName);
    const existing = findTable(targetSchema, targetName, to);
    const tableProblems: string[] = [];
    if (existing !== undefined && mode === 'create') {
      tableProblems.push(
        `${targetName} already exists on the target; choose drop and create, truncate or append`,
      );
    }
    const intoExisting = existing !== undefined && (mode === 'truncate' || mode === 'append');
    const built = intoExisting
      ? matchExisting(context, source, object, existing)
      : buildTable(context, source, object, targetName);
    tableProblems.push(...built.problems);
    if (!built.columns.some((c) => !c.skipped))
      tableProblems.push(`No columns of ${object.name} are copied`);
    const action: DbTableMode = existing === undefined ? 'create' : mode;
    const quoted = qualifiedTable(targetName, to, input.targetSchema);
    if (existing !== undefined && mode === 'drop-create') {
      dropping.add(existing.name);
      drops.push(quoted);
    }
    if (!intoExisting && tableProblems.length === 0) {
      creates.push(
        ...renderTableStatements(built.table, to, {
          ...(to === 'postgres' && input.targetSchema !== undefined
            ? { schema: input.targetSchema }
            : {}),
          includeForeignKeys: false,
        }),
      );
    }
    if (existing !== undefined && mode === 'truncate') {
      emptying.add(existing.name);
      truncates.push(quoted);
    }
    // The source columns read, each in the form the target takes; generated targets compute theirs.
    const targetByName = new Map(built.table.columns.map((c) => [c.name, c]));
    const sourceByName = new Map(source.columns.map((c) => [c.name, c]));
    const q = (name: string): string => quoteIdent(name, from);
    const loadColumns = [...built.names.keys()].filter((name) => {
      const target = targetByName.get(built.names.get(name)!);
      return target !== undefined && target.generated === undefined;
    });
    const adapters = loadColumns.map((name) =>
      sqlCellAdapter(
        from,
        sourceByName.get(name)!.dataType,
        to,
        targetByName.get(built.names.get(name)!)!.dataType,
      ),
    );
    const mapping = loadColumns.map((name) => ({ source: name, target: built.names.get(name)! }));
    const select = `SELECT ${loadColumns
      .map((name) => {
        const form = built.reads.get(name);
        return form === undefined
          ? q(name)
          : `${readExpression(form, q(name), from)} AS ${q(name)}`;
      })
      .join(', ')} FROM ${qualifiedTable(source.name, from, input.sourceSchema)}`;
    const rows = input.rows?.get(source.name);
    const planned: PlannedTable = {
      ...base,
      action,
      exists: existing !== undefined,
      ...(rows !== undefined ? { rows } : {}),
      columns: built.columns,
      problems: tableProblems,
      warnings: built.warnings,
    };
    problems.push(...tableProblems.map((p) => `${object.name}: ${p}`));
    warnings.push(...built.warnings.map((w) => `${object.name}: ${w}`));
    tables.push({
      planned,
      source,
      target: built.table,
      select,
      selectColumns: loadColumns,
      adapters,
      mapping,
      finish: built.finish,
      counters: built.counters,
    });
  }

  // Foreign keys between transferred tables, added after every table has its data.
  const foreignKeys: { table: string; refTable: string; sql: string }[] = [];
  for (const load of tables) {
    const created = !load.planned.exists || load.planned.action === 'drop-create';
    if (load.planned.problems.length > 0 || !created) continue;
    const names = new Map(
      load.planned.columns.filter((c) => !c.skipped).map((c) => [c.source, c.target]),
    );
    for (const fk of load.source.foreignKeys) {
      const translated = translateForeignKey(fk, load, names, targetNames, tables, context);
      if (typeof translated === 'string') {
        warnings.push(`${load.planned.source}: ${translated}`);
        continue;
      }
      foreignKeys.push({
        table: load.planned.target,
        refTable: translated.refTable,
        sql: `ALTER TABLE ${qualifiedTable(load.planned.target, to, input.targetSchema)} ADD ${renderForeignKey(
          translated,
          to,
          to === 'postgres' ? input.targetSchema : undefined,
        )}`,
      });
    }
  }

  // Foreign keys of other target tables block dropping or emptying what they reference.
  if (to === 'postgres') {
    for (const table of targetSchema?.tables ?? []) {
      if (dropping.has(table.name) || emptying.has(table.name)) continue;
      for (const fk of table.foreignKeys) {
        if (fk.refSchema !== undefined && fk.refSchema !== input.targetSchema) continue;
        if (dropping.has(fk.refTable) || emptying.has(fk.refTable)) {
          const verb = dropping.has(fk.refTable) ? 'dropped' : 'emptied';
          problems.push(
            `${fk.refTable} cannot be ${verb}: ${table.name} references it (${fk.name}); transfer ${table.name} too, or append`,
          );
        }
      }
    }
  }

  const before: string[] = [];
  if (to === 'postgres' && input.targetSchema !== undefined && targetSchema === undefined) {
    before.push(`CREATE SCHEMA IF NOT EXISTS ${quoteIdent(input.targetSchema, 'postgres')}`);
  }
  if (drops.length > 0) {
    if (to === 'postgres') before.push(`DROP TABLE ${drops.join(', ')}`);
    else for (const name of drops) before.push(`DROP TABLE ${name}`);
  }
  for (const [qualified, values] of context.createTypes) {
    const dot = qualified.lastIndexOf('.');
    const name = unquotePart(qualified.slice(dot + 1));
    before.push(
      ...renderType(
        { name, kind: 'enum', values, definition: '' },
        'postgres',
        input.targetSchema !== undefined ? { schema: input.targetSchema } : {},
      ),
    );
  }
  before.push(...creates);
  if (truncates.length > 0) {
    if (to === 'postgres') before.push(`TRUNCATE TABLE ${truncates.join(', ')}`);
    else for (const name of truncates) before.push(`TRUNCATE TABLE ${name}`);
  }
  return { tables, before, foreignKeys, problems, warnings };
}

function unquotePart(part: string): string {
  return part.startsWith('"') ? part.slice(1, -1).replace(/""/g, '"') : part;
}

function emptyLoad(planned: PlannedTable): SqlTableLoad {
  const empty = tableDefSchema.parse({ name: planned.target, columns: [] });
  return {
    planned,
    source: empty,
    target: empty,
    select: '',
    selectColumns: [],
    adapters: [],
    mapping: [],
    finish: [],
    counters: [],
  };
}

/** A foreign key between transferred tables, or why it is left out. */
function translateForeignKey(
  fk: ForeignKeyDef,
  load: SqlTableLoad,
  names: ReadonlyMap<string, string>,
  targetNames: ReadonlyMap<string, string>,
  tables: readonly SqlTableLoad[],
  context: Context,
): ForeignKeyDef | string {
  const { from, to, sourceSchema } = context.input;
  if (fk.refSchema !== undefined && fk.refSchema !== sourceSchema) {
    return `Foreign key ${fk.name} references ${fk.refSchema}.${fk.refTable}, outside the transfer; left out`;
  }
  const refTarget = targetNames.get(fk.refTable);
  const ref = tables.find((t) => t.source.name === fk.refTable && t.planned.problems.length === 0);
  if (refTarget === undefined || ref === undefined) {
    return `Foreign key ${fk.name} references ${fk.refTable}, which is not transferred; left out`;
  }
  const refNames = new Map(
    ref.planned.columns.filter((c) => !c.skipped).map((c) => [c.source, c.target]),
  );
  const columns = fk.columns.map((c) => names.get(c));
  const refColumns = fk.refColumns.map((c) => refNames.get(c));
  if (columns.some((c) => c === undefined) || refColumns.some((c) => c === undefined)) {
    return `Foreign key ${fk.name} uses a skipped column; left out`;
  }
  let name = renamed(fk.name, load.source.name, load.planned.target);
  // MySQL foreign key names are per database: prefix them with the table.
  if (
    to !== 'postgres' &&
    from === 'postgres' &&
    !name.toLowerCase().startsWith(load.planned.target.toLowerCase())
  ) {
    name = `${load.planned.target}_${name}`;
  }
  const { refSchema: _schema, ...rest } = fk;
  return {
    ...rest,
    name:
      to === 'postgres'
        ? fitIdentifier(name, to)
        : context.schemaNames.claim(fitIdentifier(name, to)),
    columns: columns as string[],
    refTable: refTarget,
    refColumns: refColumns as string[],
    ...(to !== 'postgres' ? { match: undefined, deferrable: undefined } : {}),
  };
}

/** Quoted `schema.table` for messages and pg_get_serial_sequence. */
export function qualifiedName(table: string, dialect: SqlDialect, schema?: string): string {
  return dialect === 'postgres'
    ? quoteQualified([schema, table], dialect)
    : quoteIdent(table, dialect);
}
