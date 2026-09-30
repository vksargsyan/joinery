import type {
  CheckDef,
  ColumnDef,
  EventDef,
  ExtensionDef,
  ForeignKeyDef,
  IndexDef,
  KeyDef,
  RoutineDef,
  SchemaDef,
  SchemaSnapshot,
  SequenceDef,
  SqlDialect,
  TableDef,
  TriggerDef,
  TypeDef,
  ViewDef,
} from '@joinery/core';

import type { CompareOptions, ResolvedCompareOptions } from './options';
import { resolveCompareOptions } from './options';
import { pgIndexDefinitionBody, stripMysqlDefiner } from './render';
import { normalizeSql, pgBaseType, stripOuterParens, tokenizeSql, trimStatement } from './sql-text';
import { canonicalType, isMysqlTextType, isNumericType } from './types';

/**
 * Normalisation (spec §13, step 2): canonical, comparable forms of snapshot objects. The diff
 * compares these forms; scripts always use the original text. Every rule is idempotent, so
 * normalising a normalised snapshot changes nothing.
 */

export interface NormalizeContext {
  /** Dialect of the snapshot being normalised. */
  readonly dialect: SqlDialect;
  readonly options: ResolvedCompareOptions;
  /** Snapshot database name (MySQL qualifications of it are dropped from definitions). */
  readonly database: string;
  /** Comparing MySQL with MariaDB: apply the cross-family equivalences. */
  readonly crossFamily: boolean;
  /** Database default collation (PostgreSQL), which columns inherit. */
  readonly databaseCollation?: string;
  /** Old → new identifiers the script renames (PostgreSQL definitions follow renames). */
  readonly renamedIdentifiers?: ReadonlyMap<string, string>;
  /** Column types of the table whose expressions are normalised (see `tableContext`). */
  readonly columnTypes?: ReadonlyMap<string, string>;
}

/**
 * The normalisation context for one side of a comparison: its dialect, the resolved options and
 * the facts the rules need (database name, default collation). `crossFamily` turns on the
 * MySQL ↔ MariaDB equivalences.
 */
export function contextFor(
  snapshot: SchemaSnapshot,
  options: ResolvedCompareOptions,
  crossFamily = false,
): NormalizeContext {
  const dialect =
    snapshot.engine === 'postgres'
      ? 'postgres'
      : snapshot.engine === 'mariadb'
        ? 'mariadb'
        : 'mysql';
  const databaseCollation =
    snapshot.options.collation ?? snapshot.options.lc_collate ?? snapshot.options.collate;
  return {
    dialect,
    options,
    database: snapshot.database,
    crossFamily,
    ...(databaseCollation !== undefined ? { databaseCollation } : {}),
  };
}

const isPg = (ctx: NormalizeContext): boolean => ctx.dialect === 'postgres';

const tableContexts = new WeakMap<TableDef, WeakMap<NormalizeContext, NormalizeContext>>();

/**
 * The context for the expressions of one table (checks, index expressions and predicates,
 * generated columns). On PostgreSQL it knows the table's column types, so redundant casts of
 * literals compared with a column are dropped, as the server prints them (`price > 0` reads
 * back as `(price > (0)::numeric)`). Columns are keyed as normalised text spells them, after
 * the context's renames.
 */
export function tableContext(table: TableDef, ctx: NormalizeContext): NormalizeContext {
  if (!isPg(ctx)) return ctx;
  let byContext = tableContexts.get(table);
  if (byContext === undefined) tableContexts.set(table, (byContext = new WeakMap()));
  const cached = byContext.get(ctx);
  if (cached !== undefined) return cached;
  const columnTypes = new Map<string, string>();
  for (const column of table.columns) {
    const name = ctx.renamedIdentifiers?.get(column.name) ?? column.name;
    const spelled = /^[a-z_][a-z0-9_$]*$/.test(name) ? name : `"${name.replaceAll('"', '""')}"`;
    columnTypes.set(spelled, pgBaseType(column.dataType));
  }
  const result = { ...ctx, columnTypes };
  byContext.set(ctx, result);
  return result;
}

/** Folds a name when name case is ignored. */
export function nameKey(
  name: string,
  options: Pick<ResolvedCompareOptions, 'ignoreNameCase'>,
): string {
  return options.ignoreNameCase ? name.toLowerCase() : name;
}

function sqlText(text: string, ctx: NormalizeContext, keepComments = false): string {
  return normalizeSql(text, ctx.dialect, {
    foldIdentifiers: ctx.options.ignoreNameCase,
    keepComments,
    ...(isPg(ctx) ? {} : { stripQualifier: ctx.database }),
    ...(ctx.renamedIdentifiers !== undefined ? { renamedIdentifiers: ctx.renamedIdentifiers } : {}),
    ...(ctx.columnTypes !== undefined ? { columnTypes: ctx.columnTypes } : {}),
  });
}

/** Canonical expression: normalised text without enclosing parentheses. */
export function canonicalExpression(text: string, ctx: NormalizeContext): string {
  return stripOuterParens(sqlText(text, ctx), ctx.dialect);
}

function comment(value: string | undefined, ctx: NormalizeContext): string | undefined {
  if (ctx.options.ignoreComments || value === undefined || value === '') return undefined;
  return value;
}

function owner(value: string | undefined, ctx: NormalizeContext): string | undefined {
  return ctx.options.ignoreOwnership || !isPg(ctx) ? undefined : value;
}

// ---------------------------------------------------------------------------------------------
// Charset and collation

/** MySQL 8.0.29+ reports utf8 as utf8mb3; both names mean the same charset. */
export function canonicalCharset(charset: string | undefined): string | undefined {
  if (charset === undefined || charset === '') return undefined;
  const lower = charset.toLowerCase();
  return lower === 'utf8' ? 'utf8mb3' : lower;
}

export function canonicalCollation(collation: string | undefined): string | undefined {
  if (collation === undefined || collation === '') return undefined;
  return collation.toLowerCase().replace(/^utf8_/, 'utf8mb3_');
}

function charsetOfCollation(collation: string): string {
  return canonicalCharset(collation.split('_')[0]!)!;
}

function pgCollation(collation: string | undefined, ctx: NormalizeContext): string | undefined {
  if (collation === undefined || ctx.options.ignoreCollation) return undefined;
  const bare = collation.replace(/^pg_catalog\./, '').replace(/^"(.*)"$/, '$1');
  if (bare === 'default' || bare === ctx.databaseCollation) return undefined;
  return bare;
}

// ---------------------------------------------------------------------------------------------
// Defaults

const MYSQL_NOW = /^(?:current_timestamp|now|localtime|localtimestamp)\s*(?:\(\s*(\d*)\s*\))?$/i;
const PG_NOW = /^(?:now\s*\(\s*\)|current_timestamp|transaction_timestamp\s*\(\s*\))$/i;

/**
 * Strips `::type` casts from a lone literal when the cast is to the column's own type or to a
 * string type — PostgreSQL prints `'abc'::character varying` for a varchar default and `'abc'`
 * elsewhere, and a model file may write either.
 */
function stripLiteralCasts(text: string, columnType: string, dialect: SqlDialect): string {
  const tokens = tokenizeSql(text, dialect).filter((t) => t.kind !== 'ws');
  let i: number;
  let literal: string;
  const first = tokens[0];
  if (first === undefined) return text;
  if (first.kind === 'string' || first.kind === 'number') {
    literal = first.text;
    i = 1;
  } else if (
    first.text === '(' &&
    tokens[2]?.text === ')' &&
    (tokens[1]?.kind === 'number' || tokens[1]?.kind === 'string')
  ) {
    literal = tokens[1].text;
    i = 3;
  } else if (first.text === '-' && tokens[1]?.kind === 'number') {
    literal = `-${tokens[1].text}`;
    i = 2;
  } else {
    return text;
  }
  if (i === tokens.length) return literal;
  if (tokens[i]?.text !== '::') return text;
  const castType = tokens
    .slice(i + 1)
    .map((t) => t.text)
    .join(' ')
    .replace(/\s*([()[\],.])\s*/g, '$1')
    .replace(/::.*$/, '');
  if (tokens.slice(i + 1).some((t) => t.text === '::')) return text;
  const canonicalCast = canonicalType(castType, dialect);
  const stringTypes = /^(text|character varying|character|name|bpchar|varchar)(\(|$)/;
  if (
    canonicalCast === columnType ||
    stringTypes.test(canonicalCast) ||
    canonicalCast === 'unknown'
  ) {
    return literal;
  }
  return text;
}

/**
 * Canonical default expression. Rules:
 * - `NULL` (any case, with or without a cast) is the same as no default;
 * - PostgreSQL: redundant casts on literals are dropped (`'abc'::text` = `'abc'`), `now()` =
 *   `CURRENT_TIMESTAMP` = `transaction_timestamp()`, and `nextval('<own schema>.seq'::regclass)`
 *   = `nextval('seq'::regclass)`;
 * - MySQL/MariaDB: `CURRENT_TIMESTAMP` = `current_timestamp()` = `now()` = `LOCALTIMESTAMP`
 *   (with the same precision), a quoted number on a numeric column equals the bare number, and
 *   enclosing parentheses of expression defaults are ignored (MariaDB omits them);
 * - then whitespace and keyword case as for any expression.
 */
export function canonicalDefault(
  expression: string | null | undefined,
  columnType: string,
  ctx: NormalizeContext,
  schema?: string,
): string | null {
  if (expression === null || expression === undefined) return null;
  let text = expression.trim();
  if (text === '' || /^null(\s*::.*)?$/i.test(text)) return null;
  if (isPg(ctx)) {
    text = stripLiteralCasts(text, columnType, ctx.dialect);
    if (PG_NOW.test(text)) return 'current_timestamp';
    if (schema !== undefined) {
      const qualified = new RegExp(
        `nextval\\('("?)${schema.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\1\\.`,
        'g',
      );
      text = text.replace(qualified, "nextval('");
    }
    const renames = ctx.renamedIdentifiers;
    if (renames !== undefined) {
      text = text.replace(/nextval\('([A-Za-z_][\w$]*)'::regclass\)/g, (match, name: string) =>
        renames.has(name) ? `nextval('${renames.get(name)!}'::regclass)` : match,
      );
    }
  } else {
    text = stripOuterParens(text, ctx.dialect);
    const now = MYSQL_NOW.exec(text);
    if (now) {
      const precision =
        now[1] !== undefined && now[1] !== '' && now[1] !== '0' ? `(${now[1]})` : '';
      return `current_timestamp${precision}`;
    }
    const quotedNumber = /^'([+-]?\d+(?:\.\d+)?)'$/.exec(text);
    if (quotedNumber && isNumericType(columnType, ctx.dialect)) text = quotedNumber[1]!;
  }
  if (/^[+-]?\d+(\.\d+)?$/.test(text)) return text.replace(/^\+/, '');
  return canonicalExpression(text, ctx);
}

// ---------------------------------------------------------------------------------------------
// Columns and tables

export interface CanonicalColumn {
  readonly type: string;
  readonly nullable: boolean;
  readonly default: string | null;
  readonly generated: { readonly expression: string; readonly stored: boolean } | null;
  readonly identity: {
    readonly generation: string;
    readonly start: string;
    readonly increment: string;
  } | null;
  readonly autoIncrement: boolean;
  readonly charset: string | null;
  readonly collation: string | null;
  readonly onUpdate: string | null;
  readonly comment: string | null;
}

/** The MariaDB JSON alias: LONGTEXT with a CHECK (json_valid(`col`)) named after the column. */
export function isMariadbJsonCheck(check: CheckDef, column: ColumnDef): boolean {
  if (check.name !== column.name) return false;
  const canonical = normalizeSql(check.expression, 'mariadb').replace(/\s+/g, '');
  const name = column.name.replaceAll('`', '``');
  return canonical === `json_valid(${column.name})` || canonical === `json_valid(\`${name}\`)`;
}

function mariadbJsonColumns(table: TableDef, ctx: NormalizeContext): Set<string> {
  const result = new Set<string>();
  if (!(ctx.crossFamily && ctx.dialect === 'mariadb')) return result;
  for (const column of table.columns) {
    if (canonicalType(column.dataType, ctx.dialect) !== 'longtext') continue;
    if (table.checks.some((check) => isMariadbJsonCheck(check, column))) result.add(column.name);
  }
  return result;
}

/**
 * Canonical column. MySQL charset/collation are resolved to their effective values (inherited
 * from the table when not set), so a table default change and an explicit column value compare
 * correctly; PostgreSQL collations equal to the database default are dropped. Under the
 * cross-family compare, MariaDB's JSON alias (LONGTEXT + json_valid check) reads as `json`.
 */
export function canonicalColumn(
  column: ColumnDef,
  table: TableDef,
  ctx: NormalizeContext,
  schema?: string,
): CanonicalColumn {
  let type = canonicalType(column.dataType, ctx.dialect);
  const json = mariadbJsonColumns(table, ctx).has(column.name);
  if (json) type = 'json';
  let charset: string | null = null;
  let collation: string | null = null;
  if (isPg(ctx)) {
    collation = pgCollation(column.collation, ctx) ?? null;
  } else if (isMysqlTextType(type) && !json) {
    const tableCharset = canonicalCharset(table.options.charset);
    const tableCollation = canonicalCollation(table.options.collation);
    const own = canonicalCollation(column.collation);
    const effectiveCharset =
      canonicalCharset(column.charset) ??
      (own !== undefined ? charsetOfCollation(own) : tableCharset);
    charset = effectiveCharset ?? null;
    if (!ctx.options.ignoreCollation) {
      collation =
        own ??
        (effectiveCharset === tableCharset
          ? tableCollation
          : `default:${effectiveCharset ?? ''}`) ??
        null;
    }
  }
  return {
    type,
    nullable: column.nullable,
    default:
      column.generated !== undefined ? null : canonicalDefault(column.default, type, ctx, schema),
    generated:
      column.generated === undefined
        ? null
        : {
            expression: canonicalExpression(column.generated.expression, tableContext(table, ctx)),
            stored: column.generated.stored,
          },
    identity:
      column.identity === undefined
        ? null
        : {
            generation: column.identity.generation,
            start: column.identity.start ?? '1',
            increment: column.identity.increment ?? '1',
          },
    autoIncrement: column.autoIncrement,
    charset,
    collation,
    onUpdate:
      column.onUpdate === undefined ? null : canonicalDefault(column.onUpdate, type, ctx, schema),
    comment: comment(column.comment, ctx) ?? null,
  };
}

/**
 * Canonical MySQL/MariaDB row format. The servers report ROW_FORMAT only when it was declared
 * (never DEFAULT), and InnoDB stores a table without one in innodb_default_row_format, DYNAMIC
 * on every supported version (MySQL 5.7.9+, MariaDB 10.2.2+): for InnoDB (the default engine)
 * a missing or DEFAULT row format is DYNAMIC. Other engines choose from the columns, so there
 * a missing one stays unknown.
 */
function canonicalRowFormat(
  rowFormat: string | undefined,
  engine: string | undefined,
): string | undefined {
  const declared = rowFormat === undefined || rowFormat === 'default' ? undefined : rowFormat;
  if (engine !== undefined && engine !== 'innodb') return declared;
  return declared ?? 'dynamic';
}

/**
 * Canonical table-level attributes: MySQL engine (compared only when both sides report it),
 * row format (see canonicalRowFormat; compared only when known on both sides), charset,
 * collation, AUTO_INCREMENT counter (unless ignored) and comment; PostgreSQL tablespace,
 * storage parameters, comment and owner.
 */
export function canonicalTableOptions(
  table: TableDef,
  ctx: NormalizeContext,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [rawKey, value] of Object.entries(table.options)) {
    const key = isPg(ctx) ? rawKey : rawKey.toLowerCase().replace(/_/g, '');
    if (!isPg(ctx)) {
      if (key === 'autoincrement' && ctx.options.ignoreAutoIncrement) continue;
      if (key === 'collation') {
        if (!ctx.options.ignoreCollation) out.collation = canonicalCollation(value) ?? '';
        continue;
      }
      if (key === 'charset') {
        out.charset = canonicalCharset(value) ?? '';
        continue;
      }
      out[key] = key === 'engine' || key === 'rowformat' ? value.toLowerCase() : value;
      continue;
    }
    if (key === 'tablespace' && (value === 'pg_default' || value === '')) continue;
    out[key] = value;
  }
  if (!isPg(ctx)) {
    const rowFormat = canonicalRowFormat(out.rowformat, out.engine);
    if (rowFormat === undefined) delete out.rowformat;
    else out.rowformat = rowFormat;
  }
  const c = comment(table.comment, ctx);
  if (c !== undefined) out.comment = c;
  const o = owner(table.owner, ctx);
  if (o !== undefined) out.owner = o;
  return out;
}

/** Keys compared only when both sides report them (see canonicalTableOptions). */
export const OPTIONAL_TABLE_OPTIONS = new Set(['engine', 'rowformat']);

export function canonicalKey(key: KeyDef, ctx: NormalizeContext): { columns: string[] } {
  return { columns: key.columns.map((c) => nameKey(c, ctx.options)) };
}

export interface CanonicalIndex {
  readonly unique: boolean;
  /** Canonical PostgreSQL definition body (after "ON <table>") when compared by definition. */
  readonly body?: string;
  readonly method?: string;
  readonly columns?: readonly string[];
  readonly where?: string | null;
  readonly include?: readonly string[];
  readonly invisible: boolean;
  readonly comment: string | null;
}

function canonicalIndexPart(part: IndexDef['columns'][number], ctx: NormalizeContext): string {
  const base =
    part.name !== null
      ? nameKey(part.name, ctx.options)
      : `(${canonicalExpression(part.expression ?? '', ctx)})`;
  const nulls = part.nulls ?? (isPg(ctx) ? (part.order === 'desc' ? 'first' : 'last') : undefined);
  return [
    base,
    part.length !== undefined ? `(${part.length})` : '',
    part.collation !== undefined ? ` collate ${part.collation}` : '',
    part.opclass !== undefined ? ` ${part.opclass.toLowerCase()}` : '',
    part.order === 'desc' ? ' desc' : '',
    nulls !== undefined && isPg(ctx) ? ` nulls ${nulls}` : '',
  ].join('');
}

/**
 * Canonical index. PostgreSQL indexes compare by their server definition (minus the name and
 * table) when both sides have one; otherwise by structure: method (btree by default), key
 * parts, predicate, INCLUDE columns, visibility and comment.
 */
export function canonicalIndex(
  index: IndexDef,
  ctx: NormalizeContext,
  byDefinition: boolean,
): CanonicalIndex {
  const shared = {
    unique: index.unique,
    invisible: index.invisible,
    comment: comment(index.comment, ctx) ?? null,
  };
  if (byDefinition && index.definition !== undefined) {
    const parsed = pgIndexDefinitionBody(index.definition);
    if (parsed !== null)
      return { ...shared, unique: parsed.unique, body: sqlText(parsed.body, ctx) };
  }
  return {
    ...shared,
    method: (index.method ?? 'btree').toLowerCase(),
    columns: index.columns.map((c) => canonicalIndexPart(c, ctx)),
    where: index.where === undefined ? null : canonicalExpression(index.where, ctx),
    include: index.include.map((c) => nameKey(c, ctx.options)),
  };
}

export interface CanonicalForeignKey {
  readonly columns: readonly string[];
  readonly refSchema: string | null;
  readonly refTable: string;
  readonly refColumns: readonly string[];
  readonly onUpdate: string;
  readonly onDelete: string;
  readonly match: string;
  readonly deferrable: string;
}

/**
 * Canonical foreign key. InnoDB treats RESTRICT and NO ACTION identically, so MySQL/MariaDB
 * fold them; PostgreSQL keeps them apart (they differ for deferred checks). MATCH SIMPLE and
 * NOT DEFERRABLE are the defaults.
 */
export function canonicalForeignKey(
  fk: ForeignKeyDef,
  ctx: NormalizeContext,
  ownSchema: string | undefined,
  refTableName: (schema: string | undefined, table: string) => string = (_s, t) => t,
): CanonicalForeignKey {
  const action = (a: string): string => (!isPg(ctx) && a === 'RESTRICT' ? 'NO ACTION' : a);
  const refSchema = isPg(ctx) ? (fk.refSchema ?? ownSchema ?? null) : (fk.refSchema ?? null);
  return {
    columns: fk.columns.map((c) => nameKey(c, ctx.options)),
    refSchema: refSchema === null ? null : nameKey(refSchema, ctx.options),
    refTable: nameKey(refTableName(fk.refSchema ?? ownSchema, fk.refTable), ctx.options),
    refColumns: fk.refColumns.map((c) => nameKey(c, ctx.options)),
    onUpdate: action(fk.onUpdate),
    onDelete: action(fk.onDelete),
    match: isPg(ctx) ? (fk.match ?? 'SIMPLE') : 'SIMPLE',
    deferrable: isPg(ctx) ? (fk.deferrable ?? 'not-deferrable') : 'not-deferrable',
  };
}

export function canonicalCheck(check: CheckDef, ctx: NormalizeContext): { expression: string } {
  return { expression: canonicalExpression(check.expression, ctx) };
}

export function canonicalTrigger(
  trigger: TriggerDef,
  ctx: NormalizeContext,
): { definition: string } {
  const definition = isPg(ctx) ? trigger.definition : stripMysqlDefiner(trigger.definition);
  return { definition: sqlText(trimStatement(definition), ctx, true) };
}

/** The statement a MySQL/MariaDB trigger runs: its definition after FOR EACH ROW. */
function mysqlTriggerBody(definition: string, ctx: NormalizeContext): string {
  const last: string[] = [];
  let offset = 0;
  for (const token of tokenizeSql(definition, ctx.dialect)) {
    offset += token.text.length;
    if (token.kind === 'ws' || token.kind === 'comment') continue;
    last.push(token.kind === 'word' ? token.text.toLowerCase() : token.text);
    if (last.length > 3) last.shift();
    if (last.join(' ') === 'for each row') return definition.slice(offset);
  }
  return definition;
}

/**
 * True when the body of a MySQL/MariaDB trigger mentions an identifier the script renames.
 * Those servers move a trigger with its table (the ON clause follows a table rename) but keep
 * the body as written, so such a trigger breaks unless it is re-created with the new names.
 */
export function mysqlTriggerBodyUsesRenames(trigger: TriggerDef, ctx: NormalizeContext): boolean {
  if (isPg(ctx) || ctx.renamedIdentifiers === undefined) return false;
  const body = mysqlTriggerBody(trigger.definition, ctx);
  const { renamedIdentifiers: _renames, ...plain } = ctx;
  return sqlText(body, ctx, true) !== sqlText(body, plain, true);
}

// ---------------------------------------------------------------------------------------------
// Views, routines, sequences, types, events, schemas, extensions

function viewOptions(view: ViewDef, ctx: NormalizeContext): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [rawKey, value] of Object.entries(view.options)) {
    if (isPg(ctx)) {
      if (rawKey === 'check_option') continue;
      out[rawKey] = value.toLowerCase();
      continue;
    }
    const key = rawKey.toLowerCase().replace(/[_\s]/g, '');
    if (key === 'definer') {
      if (!ctx.options.ignoreDefiner) out.definer = value.replace(/[`']/g, '');
      continue;
    }
    const normalizedKey = key === 'sqlsecurity' || key === 'securitytype' ? 'security' : key;
    out[normalizedKey] = value.toUpperCase();
  }
  if (!isPg(ctx)) {
    if (out.algorithm === 'UNDEFINED') delete out.algorithm;
    if (out.security === 'DEFINER') delete out.security;
  }
  return out;
}

export interface CanonicalView {
  readonly materialized: boolean;
  readonly definition: string;
  /** Output column names; PostgreSQL keeps them when a referenced column is renamed. */
  readonly columns: readonly string[];
  readonly checkOption: string | null;
  readonly options: Record<string, string>;
  readonly comment: string | null;
  readonly owner: string | null;
}

export function canonicalView(view: ViewDef, ctx: NormalizeContext): CanonicalView {
  return {
    materialized: view.materialized,
    definition: sqlText(trimStatement(view.definition), ctx),
    columns: view.columns.map((c) => nameKey(c, ctx.options)),
    checkOption: view.checkOption ?? null,
    options: viewOptions(view, ctx),
    comment: comment(view.comment, ctx) ?? null,
    owner: owner(view.owner, ctx) ?? null,
  };
}

export interface CanonicalRoutine {
  readonly kind: string;
  readonly signature: string;
  readonly returns: string | null;
  readonly definition: string;
  readonly definer: string | null;
  readonly comment: string | null;
  readonly owner: string | null;
}

export function canonicalRoutine(routine: RoutineDef, ctx: NormalizeContext): CanonicalRoutine {
  const language = routine.language?.toLowerCase();
  const sqlBody = language === undefined || language === 'sql' || language === 'plpgsql';
  const definition = isPg(ctx) ? routine.definition : stripMysqlDefiner(routine.definition);
  return {
    kind: routine.kind,
    signature: sqlText(routine.signature, ctx),
    returns: routine.returns === undefined ? null : sqlText(routine.returns, ctx),
    definition: normalizeSql(trimStatement(definition), ctx.dialect, {
      foldIdentifiers: ctx.options.ignoreNameCase,
      keepComments: true,
      normalizeDollarBodies: sqlBody,
      ...(isPg(ctx) ? {} : { stripQualifier: ctx.database }),
    }),
    definer:
      isPg(ctx) || ctx.options.ignoreDefiner || routine.definer === undefined
        ? null
        : routine.definer.replace(/[`']/g, ''),
    comment: comment(routine.comment, ctx) ?? null,
    owner: owner(routine.owner, ctx) ?? null,
  };
}

const PG_SEQUENCE_LIMITS: Readonly<Record<string, readonly [string, string]>> = {
  smallint: ['-32768', '32767'],
  integer: ['-2147483648', '2147483647'],
  bigint: ['-9223372036854775808', '9223372036854775807'],
};

export interface CanonicalSequence {
  readonly dataType: string | null;
  readonly start: string;
  readonly increment: string;
  readonly minValue: string;
  readonly maxValue: string;
  readonly cache: string;
  readonly cycle: boolean;
  readonly ownedBy: string | null;
  readonly owner: string | null;
}

/** Canonical sequence; missing bounds take the engine defaults for the sequence's type. */
export function canonicalSequence(sequence: SequenceDef, ctx: NormalizeContext): CanonicalSequence {
  const ascending = !sequence.increment.trim().startsWith('-');
  let dataType: string | null = null;
  let min: string;
  let max: string;
  let cache: string;
  if (isPg(ctx)) {
    dataType = canonicalType(sequence.dataType ?? 'bigint', ctx.dialect);
    const limits = PG_SEQUENCE_LIMITS[dataType] ?? PG_SEQUENCE_LIMITS.bigint!;
    min = sequence.minValue ?? (ascending ? '1' : limits[0]);
    max = sequence.maxValue ?? (ascending ? limits[1] : '-1');
    cache = sequence.cache ?? '1';
  } else {
    min = sequence.minValue ?? (ascending ? '1' : '-9223372036854775807');
    max = sequence.maxValue ?? (ascending ? '9223372036854775806' : '-1');
    cache = sequence.cache ?? '1000';
  }
  return {
    dataType,
    start: sequence.start,
    increment: sequence.increment,
    minValue: min,
    maxValue: max,
    cache,
    cycle: sequence.cycle,
    ownedBy: sequence.ownedBy === undefined ? null : nameKey(sequence.ownedBy, ctx.options),
    owner: owner(sequence.owner, ctx) ?? null,
  };
}

export interface CanonicalType {
  readonly kind: string;
  readonly values: readonly string[];
  readonly definition: string | null;
  readonly comment: string | null;
  readonly owner: string | null;
}

export function canonicalTypeDef(type: TypeDef, ctx: NormalizeContext): CanonicalType {
  return {
    kind: type.kind,
    values: type.kind === 'enum' ? [...type.values] : [],
    definition: type.kind === 'enum' ? null : sqlText(trimStatement(type.definition), ctx),
    comment: comment(type.comment, ctx) ?? null,
    owner: owner(type.owner, ctx) ?? null,
  };
}

/** Canonical event: ENABLE/DISABLE is compared through `enabled`, not the definition text. */
export function canonicalEvent(
  event: EventDef,
  ctx: NormalizeContext,
): { definition: string; enabled: boolean } {
  const definition = sqlText(trimStatement(stripMysqlDefiner(event.definition)), ctx, true).replace(
    / (?:enable|disable(?: on (?:slave|replica))?) do /,
    ' do ',
  );
  return { definition, enabled: event.enabled };
}

export function canonicalSchema(
  schema: SchemaDef,
  ctx: NormalizeContext,
): { comment: string | null; owner: string | null } {
  return { comment: comment(schema.comment, ctx) ?? null, owner: owner(schema.owner, ctx) ?? null };
}

export function canonicalExtension(
  extension: ExtensionDef,
  ctx: NormalizeContext,
): { schema: string | null; version: string | null } {
  return {
    schema: extension.schema ?? null,
    version: ctx.options.ignoreExtensionVersions ? null : (extension.version ?? null),
  };
}

// ---------------------------------------------------------------------------------------------
// Whole snapshots

function normalizeIndex(index: IndexDef, ctx: NormalizeContext, byDefinition: boolean): IndexDef {
  const c = canonicalIndex(index, ctx, byDefinition);
  const out: IndexDef = {
    name: ctx.options.ignoreNames ? '' : nameKey(index.name, ctx.options),
    columns: index.columns.map((part) => {
      const nulls =
        part.nulls ?? (isPg(ctx) ? (part.order === 'desc' ? 'first' : 'last') : undefined);
      const normalized: IndexDef['columns'][number] = {
        name: part.name === null ? null : nameKey(part.name, ctx.options),
        order: part.order,
      };
      if (part.expression !== undefined)
        normalized.expression = canonicalExpression(part.expression, ctx);
      if (part.length !== undefined) normalized.length = part.length;
      if (nulls !== undefined && isPg(ctx)) normalized.nulls = nulls;
      if (part.collation !== undefined) normalized.collation = part.collation;
      if (part.opclass !== undefined) normalized.opclass = part.opclass.toLowerCase();
      return normalized;
    }),
    unique: c.unique,
    include: [...(c.include ?? index.include.map((i) => nameKey(i, ctx.options)))],
    invisible: c.invisible,
  };
  // A canonical definition that re-parses to itself: "CREATE [UNIQUE] INDEX _ ON _ <body>".
  if (c.body !== undefined)
    out.definition = `CREATE ${c.unique ? 'UNIQUE ' : ''}INDEX _ ON _ ${c.body}`;
  if (c.method !== undefined) out.method = c.method;
  else if (index.method !== undefined) out.method = index.method.toLowerCase();
  if (c.where !== undefined && c.where !== null) out.where = c.where;
  else if (index.where !== undefined) out.where = canonicalExpression(index.where, ctx);
  if (c.comment !== null) out.comment = c.comment;
  return out;
}

function normalizeTable(
  table: TableDef,
  ctx: NormalizeContext,
  schema: string | undefined,
): TableDef {
  const json = mariadbJsonColumns(table, ctx);
  const byDefinition = isPg(ctx);
  const expressions = tableContext(table, ctx);
  const columns = table.columns.map((column, i) => {
    const c = canonicalColumn(column, table, ctx, schema);
    const out: ColumnDef = {
      name: nameKey(column.name, ctx.options),
      ordinal: ctx.options.ignoreColumnOrder || isPg(ctx) ? i + 1 : column.ordinal,
      dataType: c.type,
      nullable: c.nullable,
      default: c.default,
      autoIncrement: c.autoIncrement,
    };
    if (c.generated !== null) out.generated = c.generated;
    if (c.identity !== null) {
      out.identity = {
        generation: c.identity.generation === 'always' ? 'always' : 'by-default',
        start: c.identity.start,
        increment: c.identity.increment,
      };
    }
    if (c.charset !== null) out.charset = c.charset;
    if (c.collation !== null) out.collation = c.collation;
    if (c.onUpdate !== null) out.onUpdate = c.onUpdate;
    if (c.comment !== null) out.comment = c.comment;
    return out;
  });
  const options = canonicalTableOptions(table, ctx);
  const tableComment = options.comment;
  delete options.comment;
  delete options.owner;
  const normalized: TableDef = {
    name: nameKey(table.name, ctx.options),
    kind: table.kind,
    columns,
    uniques: table.uniques.map((u) => ({
      name: ctx.options.ignoreNames ? '' : u.name,
      columns: canonicalKey(u, ctx).columns,
    })),
    indexes: table.indexes.map((index) => normalizeIndex(index, expressions, byDefinition)),
    foreignKeys: table.foreignKeys.map((fk) => {
      const c = canonicalForeignKey(fk, ctx, schema);
      const out: ForeignKeyDef = {
        name: ctx.options.ignoreNames ? '' : fk.name,
        columns: [...c.columns],
        refTable: c.refTable,
        refColumns: [...c.refColumns],
        onUpdate: c.onUpdate as ForeignKeyDef['onUpdate'],
        onDelete: c.onDelete as ForeignKeyDef['onDelete'],
      };
      if (isPg(ctx)) {
        out.match = c.match as NonNullable<ForeignKeyDef['match']>;
        out.deferrable = c.deferrable as NonNullable<ForeignKeyDef['deferrable']>;
      }
      if (c.refSchema !== null && c.refSchema !== schema) out.refSchema = c.refSchema;
      return out;
    }),
    checks: table.checks
      .filter(
        (check) =>
          !table.columns.some((col) => json.has(col.name) && isMariadbJsonCheck(check, col)),
      )
      .map((check) => ({
        name: ctx.options.ignoreNames ? '' : check.name,
        expression: canonicalCheck(check, expressions).expression,
      })),
    triggers: table.triggers.map((t) => ({
      ...t,
      definition: canonicalTrigger(t, ctx).definition,
    })),
    options,
  };
  if (table.primaryKey !== undefined) {
    normalized.primaryKey = {
      name: ctx.options.ignoreNames || !isPg(ctx) ? '' : table.primaryKey.name,
      columns: canonicalKey(table.primaryKey, ctx).columns,
    };
  }
  if (table.partitioning !== undefined && !(ctx.options.ignorePartitions && !isPg(ctx))) {
    normalized.partitioning = {
      method: table.partitioning.method.toUpperCase(),
      key: canonicalExpression(table.partitioning.key, ctx),
      partitions: ctx.options.ignorePartitions
        ? []
        : table.partitioning.partitions.map((p) => ({ ...p })),
    };
  }
  if (tableComment !== undefined) normalized.comment = tableComment;
  const tableOwner = owner(table.owner, ctx);
  if (tableOwner !== undefined) normalized.owner = tableOwner;
  return normalized;
}

/**
 * A copy of the snapshot in canonical form: the same shape, with types, defaults, expressions
 * and definitions replaced by what the diff compares, ignored attributes removed and generated
 * names blanked when names are ignored. Useful for tests, debugging and caching; the diff
 * itself compares canonical forms object by object.
 */
export function normalizeSnapshot(
  snapshot: SchemaSnapshot,
  options: CompareOptions = {},
  crossFamily = false,
): SchemaSnapshot {
  const resolved = resolveCompareOptions(options);
  const ctx = contextFor(snapshot, resolved, crossFamily);
  const pg = isPg(ctx);
  return {
    ...snapshot,
    options: { ...snapshot.options },
    extensions: snapshot.extensions.map((e) => {
      const c = canonicalExtension(e, ctx);
      const out: ExtensionDef = { name: e.name };
      if (c.schema !== null) out.schema = c.schema;
      if (c.version !== null) out.version = c.version;
      return out;
    }),
    schemas: snapshot.schemas.map((schema) => {
      const schemaName = pg ? schema.name : undefined;
      const s = canonicalSchema(schema, ctx);
      const out: SchemaDef = {
        name: nameKey(schema.name, resolved),
        tables: schema.tables.map((t) => normalizeTable(t, ctx, schemaName)),
        views: schema.views.map((v) => {
          const c = canonicalView(v, ctx);
          const view: ViewDef = {
            name: nameKey(v.name, resolved),
            materialized: c.materialized,
            definition: c.definition,
            columns: [...v.columns],
            options: c.options,
            indexes: v.indexes.map((index) =>
              normalizeIndex(index, ctx, index.definition !== undefined),
            ),
          };
          if (c.checkOption !== null)
            view.checkOption = c.checkOption as NonNullable<ViewDef['checkOption']>;
          if (c.comment !== null) view.comment = c.comment;
          if (c.owner !== null) view.owner = c.owner;
          return view;
        }),
        routines: schema.routines.map((r) => {
          const c = canonicalRoutine(r, ctx);
          const routine: RoutineDef = {
            name: nameKey(r.name, resolved),
            kind: r.kind,
            signature: c.signature,
            definition: c.definition,
          };
          if (c.returns !== null) routine.returns = c.returns;
          if (r.language !== undefined) routine.language = r.language.toLowerCase();
          if (c.definer !== null) routine.definer = c.definer;
          if (c.comment !== null) routine.comment = c.comment;
          if (c.owner !== null) routine.owner = c.owner;
          return routine;
        }),
        sequences: schema.sequences.map((q) => {
          const c = canonicalSequence(q, ctx);
          const sequence: SequenceDef = {
            name: nameKey(q.name, resolved),
            start: c.start,
            increment: c.increment,
            minValue: c.minValue,
            maxValue: c.maxValue,
            cache: c.cache,
            cycle: c.cycle,
          };
          if (c.dataType !== null) sequence.dataType = c.dataType;
          if (c.ownedBy !== null) sequence.ownedBy = c.ownedBy;
          if (c.owner !== null) sequence.owner = c.owner;
          return sequence;
        }),
        types: schema.types.map((t) => {
          const c = canonicalTypeDef(t, ctx);
          const type: TypeDef = {
            name: nameKey(t.name, resolved),
            kind: t.kind,
            values: [...c.values],
            definition: c.definition ?? '',
          };
          if (c.comment !== null) type.comment = c.comment;
          if (c.owner !== null) type.owner = c.owner;
          return type;
        }),
        events: schema.events.map((e) => ({
          name: nameKey(e.name, resolved),
          ...canonicalEvent(e, ctx),
        })),
      };
      if (s.comment !== null) out.comment = s.comment;
      if (s.owner !== null) out.owner = s.owner;
      return out;
    }),
  };
}
