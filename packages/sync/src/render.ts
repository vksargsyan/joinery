import type {
  CheckDef,
  ColumnDef,
  EventDef,
  ExtensionDef,
  ForeignKeyDef,
  IndexColumn,
  IndexDef,
  KeyDef,
  Partitioning,
  RoutineDef,
  SchemaDef,
  SequenceDef,
  SqlDialect,
  TableDef,
  TriggerDef,
  TypeDef,
  ViewDef,
} from '@querybara/core';
import { quoteIdent, quoteQualified, quoteString } from '@querybara/sql-tools';

import { trimStatement, wrapParens } from './sql-text';

/**
 * DDL rendering for every snapshot object, per dialect. The sync engine, the table designer
 * and ER forward engineering share it. Statements carry no trailing semicolon; use
 * `formatScript` to join them into a runnable script.
 *
 * Rendering follows the snapshot producer conventions (see @querybara/core schema.ts) so that
 * re-introspecting the created object yields the snapshot it was rendered from: types and
 * defaults are emitted verbatim, PostgreSQL view bodies and routine definitions as reported by
 * the server, MySQL DEFINER only when asked for.
 */
export interface RenderOptions {
  /** PostgreSQL schema that qualifies object names; ignored for MySQL and MariaDB. */
  readonly schema?: string;
  /** Leave out constraint and index names that match the engine's generated pattern. */
  readonly omitGeneratedNames?: boolean;
  /** Leave out MySQL AUTO_INCREMENT=n (default true). */
  readonly ignoreAutoIncrement?: boolean;
  /** Leave out MySQL DEFINER (default true). */
  readonly ignoreDefiner?: boolean;
  /** Leave out PostgreSQL OWNER TO (default true). */
  readonly ignoreOwnership?: boolean;
  readonly ignoreComments?: boolean;
  /** Leave out partitioning (MySQL clause, PostgreSQL partitions). */
  readonly ignorePartitions?: boolean;
  /** Include foreign keys in CREATE TABLE (default true; the sync script adds them later). */
  readonly includeForeignKeys?: boolean;
  /** MySQL: leave out table and column collations (compare option "ignore collation"). */
  readonly omitCollation?: boolean;
}

const isPg = (dialect: SqlDialect): boolean => dialect === 'postgres';

/** A schema-qualified name for PostgreSQL, a bare quoted name for MySQL/MariaDB. */
export function objectName(name: string, dialect: SqlDialect, schema?: string): string {
  return isPg(dialect) ? quoteQualified([schema, name], dialect) : quoteIdent(name, dialect);
}

function columnList(columns: readonly string[], dialect: SqlDialect): string {
  return columns.map((c) => quoteIdent(c, dialect)).join(', ');
}

function stringLiteral(value: string, dialect: SqlDialect): string {
  return quoteString(value, dialect);
}

const escapeRe = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ---------------------------------------------------------------------------------------------
// Generated names

/**
 * True when `name` is what the engine generates for an unnamed constraint or index, so a
 * script may leave it out (with ignoreNames) instead of risking a clash with the target's own
 * numbering. PostgreSQL: `<table>_pkey`, `<table>_<cols>_key`, `<table>_<cols>_fkey`,
 * `<table>_<col>_check`, `<table>_<cols>_idx` (plus the numeric suffix added on clashes).
 * MySQL/MariaDB: `PRIMARY`, `<table>_ibfk_<n>`, `<table>_chk_<n>` (MariaDB: `CONSTRAINT_<n>`),
 * and indexes named after their first column or after the foreign key they back.
 */
export function isGeneratedName(
  kind: 'primary-key' | 'unique' | 'foreign-key' | 'check' | 'index',
  name: string,
  table: TableDef,
  dialect: SqlDialect,
  columns: readonly string[] = [],
): boolean {
  const t = escapeRe(table.name);
  if (isPg(dialect)) {
    const cols = columns.map(escapeRe).join('_');
    switch (kind) {
      case 'primary-key':
        return new RegExp(`^${t}_pkey\\d*$`).test(name);
      case 'unique':
        return new RegExp(`^${t}_${cols}_key\\d*$`).test(name);
      case 'foreign-key':
        return new RegExp(`^${t}_${cols}_fkey\\d*$`).test(name);
      case 'check':
        return new RegExp(`^${t}(_.+)?_check\\d*$`).test(name);
      case 'index':
        return new RegExp(`^${t}_.*idx\\d*$`).test(name);
    }
  }
  switch (kind) {
    case 'primary-key':
      return true;
    case 'foreign-key':
      return new RegExp(`^${t}_ibfk_\\d+$`).test(name);
    case 'check':
      return new RegExp(`^${t}_chk_\\d+$`).test(name) || /^CONSTRAINT_\d+$/.test(name);
    case 'unique':
    case 'index': {
      const first = columns[0];
      if (first !== undefined && new RegExp(`^${escapeRe(first)}(_\\d+)?$`).test(name)) return true;
      return table.foreignKeys.some(
        (fk) => fk.name === name && fk.columns.every((c, i) => columns[i] === c),
      );
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Columns

/** Per-column rendering switches for ALTER statements. */
export interface ColumnRenderOptions {
  /** MySQL: write this charset/collation even when the column inherits them. */
  readonly charset?: string;
  readonly collation?: string;
  /** Leave out MySQL AUTO_INCREMENT (added later with its key). */
  readonly omitAutoIncrement?: boolean;
  /** MySQL: leave out COLLATE (collations are ignored; the charset's default applies). */
  readonly omitCollation?: boolean;
  /** MariaDB: the column-level CHECK condition (see `mariadbColumnCheck`), written last. */
  readonly check?: string;
}

/**
 * MariaDB keeps a CHECK written in a column definition with the column and names it after the
 * column (the JSON alias adds one: `CHECK (json_valid(col))`). It cannot be dropped with DROP
 * CONSTRAINT, disappears with the column, and MODIFY COLUMN without it removes it. Snapshots
 * list it among the table's checks under the column's name, so on MariaDB the check named
 * after a column is treated as that column's own: scripts write it inside the column
 * definition (CREATE TABLE, ADD, MODIFY, CHANGE) and never as a table constraint.
 */
export function mariadbColumnCheck(table: TableDef, column: string): CheckDef | undefined {
  const name = column.toLowerCase();
  return table.checks.find((check) => check.name.toLowerCase() === name);
}

/** One column definition: `"name" type ...` as it appears in CREATE TABLE and ADD COLUMN. */
export function renderColumn(
  column: ColumnDef,
  dialect: SqlDialect,
  options: ColumnRenderOptions = {},
): string {
  const parts = [quoteIdent(column.name, dialect), column.dataType];
  if (isPg(dialect)) {
    if (column.collation !== undefined)
      parts.push(`COLLATE ${quoteIdent(column.collation, dialect)}`);
    if (column.default !== null && column.generated === undefined) {
      parts.push(`DEFAULT ${column.default}`);
    }
    if (column.identity !== undefined) {
      const generation = column.identity.generation === 'always' ? 'ALWAYS' : 'BY DEFAULT';
      const seqOptions: string[] = [];
      if (column.identity.start !== undefined)
        seqOptions.push(`START WITH ${column.identity.start}`);
      if (column.identity.increment !== undefined) {
        seqOptions.push(`INCREMENT BY ${column.identity.increment}`);
      }
      parts.push(
        `GENERATED ${generation} AS IDENTITY${seqOptions.length > 0 ? ` (${seqOptions.join(' ')})` : ''}`,
      );
    }
    if (column.generated !== undefined) {
      parts.push(`GENERATED ALWAYS AS ${wrapParens(column.generated.expression, dialect)} STORED`);
    }
    if (!column.nullable) parts.push('NOT NULL');
    return parts.join(' ');
  }

  const charset = options.charset ?? column.charset;
  const collation = options.omitCollation ? undefined : (options.collation ?? column.collation);
  if (charset !== undefined) parts.push(`CHARACTER SET ${charset}`);
  if (collation !== undefined) parts.push(`COLLATE ${collation}`);
  if (column.generated !== undefined) {
    parts.push(
      `GENERATED ALWAYS AS ${wrapParens(column.generated.expression, dialect)} ${
        column.generated.stored ? 'STORED' : 'VIRTUAL'
      }`,
    );
  }
  // MariaDB rejects NULL/NOT NULL on generated columns.
  if (!(column.generated !== undefined && dialect === 'mariadb')) {
    if (!column.nullable) parts.push('NOT NULL');
    else if (/^timestamp\b/i.test(column.dataType)) parts.push('NULL');
  }
  if (column.default !== null && column.generated === undefined) {
    parts.push(`DEFAULT ${column.default}`);
  }
  if (column.onUpdate !== undefined) parts.push(`ON UPDATE ${column.onUpdate}`);
  if (column.autoIncrement && !options.omitAutoIncrement) parts.push('AUTO_INCREMENT');
  if (column.comment !== undefined && column.comment !== '') {
    parts.push(`COMMENT ${stringLiteral(column.comment, dialect)}`);
  }
  if (options.check !== undefined) parts.push(`CHECK ${wrapParens(options.check, dialect)}`);
  return parts.join(' ');
}

// ---------------------------------------------------------------------------------------------
// Keys, indexes, constraints

function constraintPrefix(name: string | undefined, dialect: SqlDialect): string {
  return name === undefined ? '' : `CONSTRAINT ${quoteIdent(name, dialect)} `;
}

/** PRIMARY KEY clause (named CONSTRAINT on PostgreSQL). */
export function renderPrimaryKey(key: KeyDef, dialect: SqlDialect, omitName = false): string {
  if (!isPg(dialect)) return `PRIMARY KEY (${columnList(key.columns, dialect)})`;
  return `${constraintPrefix(omitName ? undefined : key.name, dialect)}PRIMARY KEY (${columnList(key.columns, dialect)})`;
}

/** UNIQUE constraint clause (PostgreSQL) or UNIQUE KEY (MySQL model files). */
export function renderUnique(key: KeyDef, dialect: SqlDialect, omitName = false): string {
  if (!isPg(dialect)) {
    return `UNIQUE KEY ${omitName ? '' : `${quoteIdent(key.name, dialect)} `}(${columnList(key.columns, dialect)})`;
  }
  return `${constraintPrefix(omitName ? undefined : key.name, dialect)}UNIQUE (${columnList(key.columns, dialect)})`;
}

/** CHECK constraint clause; the expression is wrapped in parentheses when needed. */
export function renderCheck(check: CheckDef, dialect: SqlDialect, omitName = false): string {
  return `${constraintPrefix(omitName ? undefined : check.name, dialect)}CHECK ${wrapParens(check.expression, dialect)}`;
}

/**
 * FOREIGN KEY clause. PostgreSQL references are schema-qualified (the referenced table is in
 * `schema` unless `refSchema` says otherwise); defaults (NO ACTION, MATCH SIMPLE) are omitted.
 */
export function renderForeignKey(
  fk: ForeignKeyDef,
  dialect: SqlDialect,
  schema?: string,
  omitName = false,
): string {
  const ref = isPg(dialect)
    ? quoteQualified([fk.refSchema ?? schema, fk.refTable], dialect)
    : quoteQualified([fk.refSchema, fk.refTable], dialect);
  const parts = [
    `${constraintPrefix(omitName ? undefined : fk.name, dialect)}FOREIGN KEY (${columnList(fk.columns, dialect)})`,
    `REFERENCES ${ref} (${columnList(fk.refColumns, dialect)})`,
  ];
  if (isPg(dialect) && fk.match === 'FULL') parts.push('MATCH FULL');
  if (fk.onUpdate !== 'NO ACTION') parts.push(`ON UPDATE ${fk.onUpdate}`);
  if (fk.onDelete !== 'NO ACTION') parts.push(`ON DELETE ${fk.onDelete}`);
  if (isPg(dialect) && fk.deferrable === 'initially-immediate') parts.push('DEFERRABLE');
  if (isPg(dialect) && fk.deferrable === 'initially-deferred') {
    parts.push('DEFERRABLE INITIALLY DEFERRED');
  }
  return parts.join(' ');
}

function renderIndexPart(part: IndexColumn, dialect: SqlDialect): string {
  let text: string;
  if (part.name !== null) {
    text = quoteIdent(part.name, dialect);
    if (part.length !== undefined && !isPg(dialect)) text += `(${part.length})`;
  } else {
    text = `(${part.expression ?? ''})`;
  }
  if (isPg(dialect)) {
    if (part.collation !== undefined) text += ` COLLATE ${quoteIdent(part.collation, dialect)}`;
    if (part.opclass !== undefined) text += ` ${part.opclass}`;
  }
  if (part.order === 'desc') text += ' DESC';
  if (isPg(dialect) && part.nulls !== undefined) {
    const defaultNulls = part.order === 'desc' ? 'first' : 'last';
    if (part.nulls !== defaultNulls) text += ` NULLS ${part.nulls.toUpperCase()}`;
  }
  return text;
}

/** MySQL/MariaDB index clause as it appears in CREATE TABLE and after ALTER TABLE ... ADD. */
export function renderMysqlIndexClause(
  index: IndexDef,
  dialect: SqlDialect,
  omitName = false,
): string {
  const method = index.method?.toLowerCase();
  const prefix =
    method === 'fulltext'
      ? 'FULLTEXT KEY'
      : method === 'spatial'
        ? 'SPATIAL KEY'
        : index.unique
          ? 'UNIQUE KEY'
          : 'KEY';
  const parts = [
    `${prefix} ${omitName ? '' : `${quoteIdent(index.name, dialect)} `}(${index.columns
      .map((c) => renderIndexPart(c, dialect))
      .join(', ')})`,
  ];
  if (method === 'hash' || method === 'rtree') parts.push(`USING ${method.toUpperCase()}`);
  if (index.comment !== undefined && index.comment !== '') {
    parts.push(`COMMENT ${stringLiteral(index.comment, dialect)}`);
  }
  if (index.invisible) parts.push(dialect === 'mariadb' ? 'IGNORED' : 'INVISIBLE');
  return parts.join(' ');
}

const PG_INDEX_HEAD =
  /^\s*CREATE\s+(UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?("(?:[^"]|"")+"|[^\s(]+)\s+ON\s+/i;

/** CREATE INDEX for PostgreSQL, from the server's definition when the snapshot has one. */
export function renderPgCreateIndex(
  index: IndexDef,
  table: string,
  schema: string | undefined,
  omitName = false,
): string {
  if (index.definition !== undefined && PG_INDEX_HEAD.test(index.definition)) {
    const definition = trimStatement(index.definition);
    return omitName
      ? definition.replace(
          PG_INDEX_HEAD,
          (_m, unique: string | undefined) => `CREATE ${unique ?? ''}INDEX ON `,
        )
      : definition;
  }
  const parts = [
    `CREATE ${index.unique ? 'UNIQUE ' : ''}INDEX ${omitName ? '' : `${quoteIdent(index.name, 'postgres')} `}ON ${objectName(table, 'postgres', schema)}`,
  ];
  if (index.method !== undefined) parts.push(`USING ${index.method}`);
  parts.push(`(${index.columns.map((c) => renderIndexPart(c, 'postgres')).join(', ')})`);
  if (index.include.length > 0) parts.push(`INCLUDE (${columnList(index.include, 'postgres')})`);
  if (index.where !== undefined) parts.push(`WHERE ${wrapParens(index.where, 'postgres')}`);
  return parts.join(' ');
}

/** Splits a PostgreSQL index definition into its parts after "ON <table>", for comparing. */
export function pgIndexDefinitionBody(
  definition: string,
): { unique: boolean; body: string } | null {
  const match = PG_INDEX_HEAD.exec(definition);
  if (!match) return null;
  let rest = trimStatement(definition.slice(match[0].length));
  rest = rest.replace(/^ONLY\s+/i, '');
  const table = /^(?:"(?:[^"]|"")+"|[^\s."(]+)(?:\.(?:"(?:[^"]|"")+"|[^\s."(]+))?/.exec(rest);
  if (table) rest = rest.slice(table[0].length);
  return { unique: match[1] !== undefined, body: rest.trim() };
}

// ---------------------------------------------------------------------------------------------
// Tables

/** `PARTITION BY ...` with MySQL partition definitions (PostgreSQL partitions are tables). */
export function renderPartitionClause(partitioning: Partitioning, dialect: SqlDialect): string {
  const head = `PARTITION BY ${partitioning.method.toUpperCase()} ${wrapParens(partitioning.key, dialect)}`;
  if (isPg(dialect) || partitioning.partitions.length === 0) return head;
  const method = partitioning.method.toUpperCase();
  const parts = partitioning.partitions.map((p) => {
    const name = `PARTITION ${quoteIdent(p.name, dialect)}`;
    if (p.bound === undefined || p.bound === '') return name;
    if (/^VALUES\b/i.test(p.bound)) return `${name} ${p.bound}`;
    if (method.startsWith('LIST')) return `${name} VALUES IN (${p.bound})`;
    return /^MAXVALUE$/i.test(p.bound.trim())
      ? `${name} VALUES LESS THAN MAXVALUE`
      : `${name} VALUES LESS THAN ${wrapParens(p.bound, dialect)}`;
  });
  if (method.startsWith('HASH') || method.startsWith('KEY') || method.startsWith('LINEAR')) {
    return `${head} PARTITIONS ${partitioning.partitions.length}`;
  }
  return `${head}\n(${parts.join(',\n ')})`;
}

/** PostgreSQL CREATE TABLE ... PARTITION OF for one partition. */
export function renderPgPartition(
  parent: string,
  partition: { readonly name: string; readonly bound?: string },
  schema?: string,
): string {
  const bound = partition.bound?.trim() ?? 'DEFAULT';
  const clause = /^(FOR\s+VALUES|DEFAULT)\b/i.test(bound) ? bound : `FOR VALUES ${bound}`;
  return `CREATE TABLE ${objectName(partition.name, 'postgres', schema)} PARTITION OF ${objectName(parent, 'postgres', schema)} ${clause}`;
}

function mysqlTableOptions(table: TableDef, options: RenderOptions): string[] {
  const out: string[] = [];
  const o = table.options;
  if (o.engine !== undefined) out.push(`ENGINE=${o.engine}`);
  if (o.autoIncrement !== undefined && options.ignoreAutoIncrement === false) {
    out.push(`AUTO_INCREMENT=${o.autoIncrement}`);
  }
  if (o.charset !== undefined) out.push(`DEFAULT CHARSET=${o.charset}`);
  if (o.collation !== undefined && !options.omitCollation) out.push(`COLLATE=${o.collation}`);
  if (o.rowFormat !== undefined) out.push(`ROW_FORMAT=${o.rowFormat.toUpperCase()}`);
  if (table.comment !== undefined && table.comment !== '' && !options.ignoreComments) {
    out.push(`COMMENT=${stringLiteral(table.comment, 'mysql')}`);
  }
  return out;
}

/** PostgreSQL storage parameter list, e.g. `fillfactor=70, autovacuum_enabled=false`. */
export function pgStorageParameters(entries: readonly (readonly [string, string])[]): string {
  return entries
    .map(([key, value]) => {
      const name = key
        .split('.')
        .map((part) => (/^[a-z_][a-z0-9_]*$/.test(part) ? part : quoteIdent(part, 'postgres')))
        .join('.');
      const literal = /^[A-Za-z0-9_.+-]+$/.test(value) ? value : quoteString(value, 'postgres');
      return `${name}=${literal}`;
    })
    .join(', ');
}

/** PostgreSQL storage parameters of a table (its options except tablespace), sorted. */
export function pgStorageEntries(table: TableDef): (readonly [string, string])[] {
  return Object.entries(table.options)
    .filter(([key]) => key !== 'tablespace')
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * CREATE TABLE with columns, primary key, unique constraints (PostgreSQL) or unique and plain
 * indexes (MySQL), checks and, unless disabled, foreign keys. PostgreSQL indexes, comments and
 * partitions are separate statements: see `renderTableStatements`.
 */
export function renderCreateTable(
  table: TableDef,
  dialect: SqlDialect,
  options: RenderOptions = {},
): string {
  const pg = isPg(dialect);
  const omit = options.omitGeneratedNames === true;
  const columnChecks = new Set<CheckDef>();
  const lines: string[] = table.columns.map((c) => {
    const check = dialect === 'mariadb' ? mariadbColumnCheck(table, c.name) : undefined;
    if (check !== undefined) columnChecks.add(check);
    return renderColumn(c, dialect, {
      ...(options.omitCollation === true && !pg ? { omitCollation: true } : {}),
      ...(check !== undefined ? { check: check.expression } : {}),
    });
  });
  if (table.primaryKey !== undefined) {
    lines.push(
      renderPrimaryKey(
        table.primaryKey,
        dialect,
        omit && isGeneratedName('primary-key', table.primaryKey.name, table, dialect),
      ),
    );
  }
  for (const key of table.uniques) {
    lines.push(
      renderUnique(
        key,
        dialect,
        omit && isGeneratedName('unique', key.name, table, dialect, key.columns),
      ),
    );
  }
  if (!pg) {
    for (const index of table.indexes) {
      const cols = index.columns.map((c) => c.name ?? '');
      lines.push(
        renderMysqlIndexClause(
          index,
          dialect,
          omit && isGeneratedName('index', index.name, table, dialect, cols),
        ),
      );
    }
  }
  if (options.includeForeignKeys !== false) {
    for (const fk of table.foreignKeys) {
      lines.push(
        renderForeignKey(
          fk,
          dialect,
          options.schema,
          omit && isGeneratedName('foreign-key', fk.name, table, dialect, fk.columns),
        ),
      );
    }
  }
  for (const check of table.checks) {
    if (columnChecks.has(check)) continue;
    lines.push(
      renderCheck(check, dialect, omit && isGeneratedName('check', check.name, table, dialect)),
    );
  }
  let sql = `CREATE TABLE ${objectName(table.name, dialect, options.schema)} (\n  ${lines.join(',\n  ')}\n)`;
  if (pg) {
    if (table.partitioning !== undefined)
      sql += ` ${renderPartitionClause(table.partitioning, dialect)}`;
    const storage = pgStorageEntries(table);
    if (storage.length > 0) sql += ` WITH (${pgStorageParameters(storage)})`;
    if (table.options.tablespace !== undefined) {
      sql += ` TABLESPACE ${quoteIdent(table.options.tablespace, dialect)}`;
    }
    return sql;
  }
  const tableOptions = mysqlTableOptions(table, options);
  if (tableOptions.length > 0) sql += ` ${tableOptions.join(' ')}`;
  if (table.partitioning !== undefined && !options.ignorePartitions) {
    sql += `\n${renderPartitionClause(table.partitioning, dialect)}`;
  }
  return sql;
}

/** COMMENT ON <target> IS ...; an empty or missing comment removes it. */
export function renderPgComment(target: string, comment: string | undefined | null): string {
  return `COMMENT ON ${target} IS ${
    comment === undefined || comment === null || comment === ''
      ? 'NULL'
      : quoteString(comment, 'postgres')
  }`;
}

/**
 * Every statement that creates a table: CREATE TABLE, then (PostgreSQL) its partitions,
 * indexes, comments and owner. Triggers are left to `renderTrigger`: they usually need
 * functions that are created later.
 */
export function renderTableStatements(
  table: TableDef,
  dialect: SqlDialect,
  options: RenderOptions = {},
): string[] {
  const statements = [renderCreateTable(table, dialect, options)];
  if (!isPg(dialect)) return statements;
  const name = objectName(table.name, dialect, options.schema);
  if (table.partitioning !== undefined && !options.ignorePartitions) {
    for (const partition of table.partitioning.partitions) {
      statements.push(renderPgPartition(table.name, partition, options.schema));
    }
  }
  for (const index of table.indexes) {
    const cols = index.columns.map((c) => c.name ?? '');
    statements.push(
      renderPgCreateIndex(
        index,
        table.name,
        options.schema,
        options.omitGeneratedNames === true &&
          isGeneratedName('index', index.name, table, dialect, cols),
      ),
    );
  }
  if (!options.ignoreComments) {
    if (table.comment !== undefined && table.comment !== '') {
      statements.push(renderPgComment(`TABLE ${name}`, table.comment));
    }
    for (const column of table.columns) {
      if (column.comment !== undefined && column.comment !== '') {
        statements.push(
          renderPgComment(`COLUMN ${name}.${quoteIdent(column.name, dialect)}`, column.comment),
        );
      }
    }
    for (const index of table.indexes) {
      if (index.comment !== undefined && index.comment !== '') {
        statements.push(
          renderPgComment(
            `INDEX ${objectName(index.name, dialect, options.schema)}`,
            index.comment,
          ),
        );
      }
    }
  }
  if (options.ignoreOwnership === false && table.owner !== undefined) {
    statements.push(`ALTER TABLE ${name} OWNER TO ${quoteIdent(table.owner, dialect)}`);
  }
  return statements;
}

// ---------------------------------------------------------------------------------------------
// Views, routines, triggers, events

function mysqlOption(
  options: Readonly<Record<string, string>>,
  ...keys: string[]
): string | undefined {
  for (const [key, value] of Object.entries(options)) {
    if (keys.includes(key.toLowerCase().replace(/[_\s]/g, ''))) return value;
  }
  return undefined;
}

/** `user@host` as MySQL account syntax: `user`@`host`. Already quoted values pass through. */
export function mysqlAccount(definer: string): string {
  if (/[`']/.test(definer)) return definer;
  const at = definer.lastIndexOf('@');
  if (at === -1) return quoteIdent(definer, 'mysql');
  return `${quoteIdent(definer.slice(0, at), 'mysql')}@${quoteIdent(definer.slice(at + 1), 'mysql')}`;
}

/** View rendering options. */
export interface ViewRenderOptions extends RenderOptions {
  /** PostgreSQL: CREATE OR REPLACE VIEW (MySQL always uses it). */
  readonly orReplace?: boolean;
}

/** CREATE VIEW (and, for PostgreSQL, materialised view indexes, comment and owner). */
export function renderView(
  view: ViewDef,
  dialect: SqlDialect,
  options: ViewRenderOptions = {},
): string[] {
  const name = objectName(view.name, dialect, options.schema);
  const body = trimStatement(view.definition);
  if (!isPg(dialect)) {
    const parts = ['CREATE OR REPLACE'];
    const algorithm = mysqlOption(view.options, 'algorithm');
    if (algorithm !== undefined) parts.push(`ALGORITHM=${algorithm.toUpperCase()}`);
    const definer = mysqlOption(view.options, 'definer');
    if (definer !== undefined && options.ignoreDefiner === false) {
      parts.push(`DEFINER=${mysqlAccount(definer)}`);
    }
    const security = mysqlOption(view.options, 'security', 'sqlsecurity', 'securitytype');
    if (security !== undefined) parts.push(`SQL SECURITY ${security.toUpperCase()}`);
    parts.push(`VIEW ${name} AS ${body}`);
    if (view.checkOption !== undefined) parts.push(`WITH ${view.checkOption} CHECK OPTION`);
    return [parts.join(' ')];
  }

  const statements: string[] = [];
  const reloptions = Object.entries(view.options)
    .filter(([key]) => key !== 'check_option' && key !== 'tablespace')
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const withClause = reloptions.length > 0 ? ` WITH (${pgStorageParameters(reloptions)})` : '';
  if (view.materialized) {
    const tablespace =
      view.options.tablespace !== undefined
        ? ` TABLESPACE ${quoteIdent(view.options.tablespace, dialect)}`
        : '';
    statements.push(
      `CREATE MATERIALIZED VIEW ${name}${withClause}${tablespace} AS\n${body}\nWITH DATA`,
    );
    for (const index of view.indexes) {
      statements.push(renderPgCreateIndex(index, view.name, options.schema));
    }
  } else {
    const check = view.checkOption !== undefined ? `\nWITH ${view.checkOption} CHECK OPTION` : '';
    statements.push(
      `CREATE ${options.orReplace ? 'OR REPLACE ' : ''}VIEW ${name}${withClause} AS\n${body}${check}`,
    );
  }
  const kind = view.materialized ? 'MATERIALIZED VIEW' : 'VIEW';
  if (!options.ignoreComments && view.comment !== undefined && view.comment !== '') {
    statements.push(renderPgComment(`${kind} ${name}`, view.comment));
  }
  if (!options.ignoreComments) {
    for (const index of view.indexes) {
      if (index.comment !== undefined && index.comment !== '') {
        statements.push(
          renderPgComment(
            `INDEX ${objectName(index.name, dialect, options.schema)}`,
            index.comment,
          ),
        );
      }
    }
  }
  if (options.ignoreOwnership === false && view.owner !== undefined) {
    statements.push(`ALTER ${kind} ${name} OWNER TO ${quoteIdent(view.owner, dialect)}`);
  }
  return statements;
}

const MYSQL_DEFINER_CLAUSE =
  /^(\s*CREATE\s+)(?:OR\s+REPLACE\s+)?DEFINER\s*=\s*(?:`(?:[^`]|``)*`|'(?:[^']|'')*'|[^\s@]+)(?:@(?:`(?:[^`]|``)*`|'(?:[^']|'')*'|\S+))?\s+/i;

/** Removes a DEFINER clause from a MySQL CREATE statement. */
export function stripMysqlDefiner(definition: string): string {
  return definition.replace(MYSQL_DEFINER_CLAUSE, '$1');
}

/** Adds OR REPLACE after CREATE unless present. */
export function withOrReplace(definition: string): string {
  if (/^\s*CREATE\s+OR\s+REPLACE\b/i.test(definition)) return definition;
  return definition.replace(/^\s*CREATE\s+/i, 'CREATE OR REPLACE ');
}

/** The identity used by PostgreSQL DROP/COMMENT ON FUNCTION: `"schema"."name"(signature)`. */
export function pgRoutineIdentity(routine: RoutineDef, schema?: string): string {
  return `${objectName(routine.name, 'postgres', schema)}(${routine.signature})`;
}

function pgRoutineKeyword(routine: RoutineDef): string {
  return routine.kind === 'procedure'
    ? 'PROCEDURE'
    : routine.kind === 'aggregate'
      ? 'AGGREGATE'
      : 'FUNCTION';
}

/** CREATE FUNCTION/PROCEDURE from the stored definition, plus comment/owner (PostgreSQL). */
export function renderRoutine(
  routine: RoutineDef,
  dialect: SqlDialect,
  options: RenderOptions & { readonly orReplace?: boolean } = {},
): string[] {
  let definition = trimStatement(routine.definition);
  if (!isPg(dialect)) {
    definition = stripMysqlDefiner(definition);
    if (options.ignoreDefiner === false && routine.definer !== undefined) {
      definition = definition.replace(
        /^\s*CREATE\s+/i,
        `CREATE DEFINER=${mysqlAccount(routine.definer)} `,
      );
    }
    return [definition];
  }
  const statements = [options.orReplace === false ? definition : withOrReplace(definition)];
  const identity = `${pgRoutineKeyword(routine)} ${pgRoutineIdentity(routine, options.schema)}`;
  if (!options.ignoreComments && routine.comment !== undefined && routine.comment !== '') {
    statements.push(renderPgComment(identity, routine.comment));
  }
  if (options.ignoreOwnership === false && routine.owner !== undefined) {
    statements.push(`ALTER ${identity} OWNER TO ${quoteIdent(routine.owner, dialect)}`);
  }
  return statements;
}

/** DROP FUNCTION/PROCEDURE; PostgreSQL identifies the overload by its signature. */
export function renderDropRoutine(
  routine: RoutineDef,
  dialect: SqlDialect,
  schema?: string,
): string {
  if (!isPg(dialect)) {
    return `DROP ${routine.kind === 'procedure' ? 'PROCEDURE' : 'FUNCTION'} IF EXISTS ${quoteIdent(routine.name, dialect)}`;
  }
  return `DROP ${pgRoutineKeyword(routine)} ${pgRoutineIdentity(routine, schema)}`;
}

/** CREATE TRIGGER from the stored definition (MySQL DEFINER removed). */
export function renderTrigger(trigger: TriggerDef, dialect: SqlDialect): string {
  const definition = trimStatement(trigger.definition);
  return isPg(dialect) ? definition : stripMysqlDefiner(definition);
}

/** DROP TRIGGER; PostgreSQL triggers are named per table. */
export function renderDropTrigger(
  trigger: TriggerDef,
  table: string,
  dialect: SqlDialect,
  schema?: string,
): string {
  return isPg(dialect)
    ? `DROP TRIGGER ${quoteIdent(trigger.name, dialect)} ON ${objectName(table, dialect, schema)}`
    : `DROP TRIGGER IF EXISTS ${quoteIdent(trigger.name, dialect)}`;
}

/** CREATE EVENT from the stored definition, without DEFINER. */
export function renderEvent(event: EventDef): string {
  return stripMysqlDefiner(trimStatement(event.definition));
}

// ---------------------------------------------------------------------------------------------
// Sequences, types, schemas, extensions

/** CREATE SEQUENCE with every parameter written out (PostgreSQL, MariaDB). */
export function renderSequence(
  sequence: SequenceDef,
  dialect: SqlDialect,
  options: RenderOptions = {},
): string[] {
  const parts = [`CREATE SEQUENCE ${objectName(sequence.name, dialect, options.schema)}`];
  if (isPg(dialect) && sequence.dataType !== undefined) parts.push(`AS ${sequence.dataType}`);
  parts.push(`INCREMENT BY ${sequence.increment}`);
  if (sequence.minValue !== undefined) parts.push(`MINVALUE ${sequence.minValue}`);
  if (sequence.maxValue !== undefined) parts.push(`MAXVALUE ${sequence.maxValue}`);
  parts.push(`START WITH ${sequence.start}`);
  if (sequence.cache !== undefined) parts.push(`CACHE ${sequence.cache}`);
  parts.push(
    isPg(dialect) ? (sequence.cycle ? 'CYCLE' : 'NO CYCLE') : sequence.cycle ? 'CYCLE' : 'NOCYCLE',
  );
  const statements = [parts.join(' ')];
  if (isPg(dialect) && options.ignoreOwnership === false && sequence.owner !== undefined) {
    statements.push(
      `ALTER SEQUENCE ${objectName(sequence.name, dialect, options.schema)} OWNER TO ${quoteIdent(sequence.owner, dialect)}`,
    );
  }
  return statements;
}

/**
 * `"schema"."table"."column"` for ALTER SEQUENCE ... OWNED BY, or NONE. `ownedBy` is
 * "table.column", or "schema.table.column" for a table in another schema.
 */
export function renderOwnedBy(
  ownedBy: string | undefined,
  dialect: SqlDialect,
  schema?: string,
): string {
  if (ownedBy === undefined) return 'NONE';
  const parts = ownedBy.split('.');
  if (parts.length === 3) return quoteQualified(parts, dialect);
  if (parts.length !== 2) return 'NONE';
  return `${objectName(parts[0]!, dialect, schema)}.${quoteIdent(parts[1]!, dialect)}`;
}

/** CREATE TYPE (enums from their labels, other kinds from the stored definition). */
export function renderType(
  type: TypeDef,
  dialect: SqlDialect,
  options: RenderOptions = {},
): string[] {
  const name = objectName(type.name, dialect, options.schema);
  const statements =
    type.kind === 'enum'
      ? [
          `CREATE TYPE ${name} AS ENUM (${type.values.map((v) => quoteString(v, dialect)).join(', ')})`,
        ]
      : [trimStatement(type.definition)];
  const keyword = type.kind === 'domain' ? 'DOMAIN' : 'TYPE';
  if (!options.ignoreComments && type.comment !== undefined && type.comment !== '') {
    statements.push(renderPgComment(`${keyword} ${name}`, type.comment));
  }
  if (options.ignoreOwnership === false && type.owner !== undefined) {
    statements.push(`ALTER ${keyword} ${name} OWNER TO ${quoteIdent(type.owner, dialect)}`);
  }
  return statements;
}

/** CREATE SCHEMA (PostgreSQL), with owner and comment when compared. */
export function renderSchema(schema: SchemaDef, options: RenderOptions = {}): string[] {
  const name = quoteIdent(schema.name, 'postgres');
  const statements = [
    options.ignoreOwnership === false && schema.owner !== undefined
      ? `CREATE SCHEMA ${name} AUTHORIZATION ${quoteIdent(schema.owner, 'postgres')}`
      : `CREATE SCHEMA ${name}`,
  ];
  if (!options.ignoreComments && schema.comment !== undefined && schema.comment !== '') {
    statements.push(renderPgComment(`SCHEMA ${name}`, schema.comment));
  }
  return statements;
}

/** CREATE EXTENSION IF NOT EXISTS, pinned to the snapshot version unless told otherwise. */
export function renderExtension(extension: ExtensionDef, withVersion = true): string {
  const parts = [`CREATE EXTENSION IF NOT EXISTS ${quoteIdent(extension.name, 'postgres')}`];
  if (extension.schema !== undefined)
    parts.push(`WITH SCHEMA ${quoteIdent(extension.schema, 'postgres')}`);
  if (withVersion && extension.version !== undefined) {
    parts.push(`VERSION ${quoteString(extension.version, 'postgres')}`);
  }
  return parts.join(' ');
}
