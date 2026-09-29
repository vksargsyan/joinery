import type {
  ColumnDef,
  ColumnKind,
  ColumnMeta,
  SchemaSnapshot,
  SqlDialect,
  TableDef,
  TypeDef,
} from '@joinery/core';

/**
 * What the data grid knows about one column: its kind for editors and filters, the limits the
 * value parser checks, and whether it can be written. Built from the schema snapshot
 * (`describeColumns`) for table data, or from result metadata (`columnFromMeta`) for query
 * results, which carry less (no defaults, no enum labels).
 */
export interface ColumnInfo {
  readonly name: string;
  /** The dialect the type names and value rules belong to. */
  readonly dialect: SqlDialect;
  /** The type as the engine prints it: format_type() on PostgreSQL, COLUMN_TYPE on MySQL. */
  readonly dataType: string;
  readonly kind: ColumnKind;
  readonly nullable: boolean;
  /** A default, identity, auto-increment or generated value exists: INSERT may leave it out. */
  readonly hasDefault: boolean;
  /** MySQL AUTO_INCREMENT, PostgreSQL identity or serial. */
  readonly autoIncrement: boolean;
  /** Computed by the server (GENERATED ... AS); only DEFAULT can be written to it. */
  readonly generated: boolean;
  /** Why the column cannot take typed values, when it cannot. DEFAULT is still allowed. */
  readonly readOnly?: string;
  readonly unsigned?: boolean;
  /** Characters for char/varchar, bytes for binary/varbinary, bits for bit(n). */
  readonly length?: number;
  /** Decimal precision and scale. */
  readonly precision?: number;
  readonly scale?: number;
  /** Allowed labels in declaration order: MySQL enum/set, PostgreSQL enum types. */
  readonly enumValues?: readonly string[];
  /** MySQL SET: the value is a comma-separated subset of `enumValues`. */
  readonly multiple?: boolean;
  /** MySQL tinyint(1) / bit(1): an integer column the editor shows as a boolean toggle. */
  readonly booleanLike?: boolean;
  /** Element type of a PostgreSQL array. */
  readonly element?: ColumnInfo;
  /** timestamptz / timetz. */
  readonly withTimeZone?: boolean;
  /** MySQL/MariaDB character set and collation in effect (column or table default). */
  readonly charset?: string;
  readonly collation?: string;
}

/** Type facts parsed from a type name, before the column's own flags are added. */
interface TypeFacts {
  kind: ColumnKind;
  unsigned?: boolean;
  length?: number;
  precision?: number;
  scale?: number;
  enumValues?: readonly string[];
  multiple?: boolean;
  booleanLike?: boolean;
  element?: ColumnInfo;
  withTimeZone?: boolean;
}

/** Resolves a PostgreSQL user type name ("public.mood") to its definition. */
type TypeResolver = (schema: string | undefined, name: string) => TypeDef | undefined;

const PG_KINDS: Readonly<Record<string, ColumnKind>> = {
  smallint: 'integer',
  int2: 'integer',
  integer: 'integer',
  int: 'integer',
  int4: 'integer',
  oid: 'integer',
  smallserial: 'integer',
  serial: 'integer',
  bigint: 'bigint',
  int8: 'bigint',
  bigserial: 'bigint',
  numeric: 'decimal',
  decimal: 'decimal',
  money: 'decimal',
  real: 'float',
  float4: 'float',
  'double precision': 'float',
  float8: 'float',
  float: 'float',
  boolean: 'boolean',
  bool: 'boolean',
  text: 'string',
  'character varying': 'string',
  varchar: 'string',
  character: 'string',
  char: 'string',
  bpchar: 'string',
  '"char"': 'string',
  name: 'string',
  citext: 'string',
  xml: 'string',
  inet: 'string',
  cidr: 'string',
  macaddr: 'string',
  macaddr8: 'string',
  bit: 'string',
  'bit varying': 'string',
  varbit: 'string',
  tsvector: 'string',
  tsquery: 'string',
  jsonpath: 'string',
  pg_lsn: 'string',
  int4range: 'string',
  int8range: 'string',
  numrange: 'string',
  tsrange: 'string',
  tstzrange: 'string',
  daterange: 'string',
  bytea: 'binary',
  date: 'date',
  time: 'time',
  'time without time zone': 'time',
  'time with time zone': 'time',
  timetz: 'time',
  timestamp: 'datetime',
  'timestamp without time zone': 'datetime',
  'timestamp with time zone': 'timestamp',
  timestamptz: 'timestamp',
  interval: 'interval',
  json: 'json',
  jsonb: 'json',
  uuid: 'uuid',
  point: 'geometry',
  line: 'geometry',
  lseg: 'geometry',
  box: 'geometry',
  path: 'geometry',
  polygon: 'geometry',
  circle: 'geometry',
  geometry: 'geometry',
  geography: 'geometry',
};

const MYSQL_KINDS: Readonly<Record<string, ColumnKind>> = {
  tinyint: 'integer',
  smallint: 'integer',
  mediumint: 'integer',
  int: 'integer',
  integer: 'integer',
  bigint: 'bigint',
  bit: 'integer',
  year: 'integer',
  bool: 'boolean',
  boolean: 'boolean',
  decimal: 'decimal',
  numeric: 'decimal',
  dec: 'decimal',
  fixed: 'decimal',
  float: 'float',
  double: 'float',
  'double precision': 'float',
  real: 'float',
  date: 'date',
  time: 'time',
  datetime: 'datetime',
  timestamp: 'timestamp',
  char: 'string',
  varchar: 'string',
  tinytext: 'string',
  text: 'string',
  mediumtext: 'string',
  longtext: 'string',
  inet4: 'string',
  inet6: 'string',
  binary: 'binary',
  varbinary: 'binary',
  tinyblob: 'binary',
  blob: 'binary',
  mediumblob: 'binary',
  longblob: 'binary',
  vector: 'binary',
  enum: 'enum',
  set: 'enum',
  json: 'json',
  uuid: 'uuid',
  geometry: 'geometry',
  point: 'geometry',
  linestring: 'geometry',
  polygon: 'geometry',
  multipoint: 'geometry',
  multilinestring: 'geometry',
  multipolygon: 'geometry',
  geometrycollection: 'geometry',
  geomcollection: 'geometry',
};

/** Labels of `enum('a','b''c')` / `set(...)`: quotes doubled or backslash-escaped. */
export function parseEnumLabels(list: string): string[] {
  const labels: string[] = [];
  let i = 0;
  while (i < list.length) {
    const quote = list[i];
    if (quote !== "'" && quote !== '"') {
      i++;
      continue;
    }
    let label = '';
    i++;
    while (i < list.length) {
      const ch = list[i]!;
      if (ch === '\\' && i + 1 < list.length) {
        const next = list[i + 1]!;
        label += next === 'n' ? '\n' : next === 't' ? '\t' : next === '0' ? '\0' : next;
        i += 2;
      } else if (ch === quote && list[i + 1] === quote) {
        label += quote;
        i += 2;
      } else if (ch === quote) {
        i++;
        break;
      } else {
        label += ch;
        i++;
      }
    }
    labels.push(label);
  }
  return labels;
}

/** Splits "a.b" / "\"My Schema\".\"Mood\"" into unquoted parts. */
function splitQualified(name: string): string[] {
  const parts: string[] = [];
  let current = '';
  let quoted = false;
  for (let i = 0; i < name.length; i++) {
    const ch = name[i]!;
    if (quoted) {
      if (ch === '"' && name[i + 1] === '"') {
        current += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else current += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === '.') {
      parts.push(current);
      current = '';
    } else current += ch;
  }
  parts.push(current);
  return parts;
}

function numbersIn(modifier: string | undefined): number[] {
  if (modifier === undefined) return [];
  return modifier
    .split(',')
    .map((part) => Number(part.trim()))
    .filter((n) => Number.isInteger(n));
}

function pgFacts(raw: string, resolve: TypeResolver | undefined, depth = 0): TypeFacts {
  const text = raw.trim();
  const array = /^(.*?)((?:\[\d*\])+)$/s.exec(text);
  if (array) {
    const elementType = array[1]!.trim();
    const facts = pgFacts(elementType, resolve, depth + 1);
    return { kind: 'array', element: infoFromFacts(elementType, facts) };
  }
  const modifier = /\(([^)]*)\)/.exec(text)?.[1];
  const base = text
    .replace(/\([^)]*\)/, '')
    .replace(/\s+/g, ' ')
    .trim();
  const lower = base.toLowerCase();
  const withTimeZone =
    / with time zone$/.test(lower) || lower === 'timetz' || lower === 'timestamptz';
  const known = PG_KINDS[lower] ?? (lower.startsWith('interval') ? 'interval' : undefined);
  if (known !== undefined) {
    const facts: TypeFacts = { kind: known };
    const numbers = numbersIn(modifier);
    if (known === 'decimal' && numbers.length > 0 && lower !== 'money') {
      facts.precision = numbers[0]!;
      facts.scale = numbers[1] ?? 0;
    }
    if (known === 'string' && numbers.length > 0) facts.length = numbers[0]!;
    if (withTimeZone) facts.withTimeZone = true;
    return facts;
  }
  const parts = splitQualified(base);
  const name = parts[parts.length - 1]!;
  const schema = parts.length > 1 ? parts[parts.length - 2] : undefined;
  if (['geometry', 'geography'].includes(name.toLowerCase())) return { kind: 'geometry' };
  const type = resolve?.(schema, name);
  if (type?.kind === 'enum') return { kind: 'enum', enumValues: type.values };
  if (type?.kind === 'domain' && depth < 8) {
    const base =
      /\bAS\s+(.+?)(?:\s+(?:COLLATE|DEFAULT|CONSTRAINT|NOT\s+NULL|NULL|CHECK)\b.*)?$/is.exec(
        type.definition,
      )?.[1];
    if (base !== undefined) return pgFacts(base, resolve, depth + 1);
  }
  return { kind: 'unknown' };
}

function mysqlFacts(raw: string): TypeFacts {
  const text = raw.trim();
  const lower = text.toLowerCase();
  const name =
    /^[a-z0-9_ ]+?(?=\(|\s+unsigned|\s+signed|\s+zerofill|$)/.exec(lower)?.[0]?.trim() ?? lower;
  const kind = MYSQL_KINDS[name];
  if (kind === undefined) return { kind: 'unknown' };
  const open = text.indexOf('(');
  const close = text.lastIndexOf(')');
  const modifier = open >= 0 && close > open ? text.slice(open + 1, close) : undefined;
  if (name === 'enum' || name === 'set') {
    const facts: TypeFacts = { kind: 'enum' };
    if (modifier !== undefined) facts.enumValues = parseEnumLabels(modifier);
    if (name === 'set') facts.multiple = true;
    return facts;
  }
  const facts: TypeFacts = { kind };
  if (/\bunsigned\b/.test(lower.slice(close >= 0 ? close : 0))) facts.unsigned = true;
  const numbers = numbersIn(modifier);
  if ((name === 'tinyint' && numbers[0] === 1) || name === 'bool' || name === 'boolean') {
    facts.kind = 'boolean';
    facts.booleanLike = true;
  }
  if (name === 'bit') {
    facts.length = numbers[0] ?? 1;
    if (facts.length === 1) facts.booleanLike = true;
  }
  if (kind === 'decimal') {
    facts.precision = numbers[0] ?? 10;
    facts.scale = numbers[1] ?? 0;
  }
  if (['char', 'varchar', 'binary', 'varbinary'].includes(name)) {
    facts.length = numbers[0] ?? 1;
  }
  return facts;
}

function infoFromFacts(dataType: string, facts: TypeFacts): ColumnInfo {
  return {
    name: '',
    dialect: 'postgres',
    dataType,
    nullable: true,
    hasDefault: false,
    autoIncrement: false,
    generated: false,
    ...facts,
  };
}

/** The kind and limits a type name implies, for any dialect. */
function factsFor(dataType: string, dialect: SqlDialect, resolve?: TypeResolver): TypeFacts {
  return dialect === 'postgres' ? pgFacts(dataType, resolve) : mysqlFacts(dataType);
}

/** The ColumnKind of a type name as the snapshot or result metadata prints it. */
export function kindForDataType(dataType: string, dialect: SqlDialect): ColumnKind {
  return factsFor(dataType, dialect).kind;
}

/** Context for reading column types from a schema snapshot. */
export interface DescribeColumnsOptions {
  readonly dialect: SqlDialect;
  /** Snapshot the table came from: resolves PostgreSQL enum and domain types. */
  readonly snapshot?: SchemaSnapshot;
  /** The table's schema, searched first for unqualified type names. */
  readonly schema?: string;
}

function typeResolver(options: DescribeColumnsOptions): TypeResolver | undefined {
  const snapshot = options.snapshot;
  if (snapshot === undefined) return undefined;
  return (schema, name) => {
    const order = snapshot.schemas
      .filter((s) => schema === undefined || s.name === schema)
      .sort((a, b) => Number(b.name === options.schema) - Number(a.name === options.schema));
    for (const s of order) {
      const type = s.types.find((t) => t.name === name);
      if (type) return type;
    }
    return undefined;
  };
}

function isMariadbJson(table: TableDef, column: ColumnDef): boolean {
  const escaped = column.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`^json_valid\\(\`?${escaped}\`?\\)$`, 'i');
  return table.checks.some((check) => pattern.test(check.expression.trim()));
}

/** One column of a table from the schema snapshot. */
export function describeColumn(
  table: TableDef,
  column: ColumnDef,
  options: DescribeColumnsOptions,
): ColumnInfo {
  const dialect = options.dialect;
  const facts = factsFor(column.dataType, dialect, typeResolver(options));
  if (
    dialect !== 'postgres' &&
    facts.kind === 'string' &&
    /text$/i.test(column.dataType) &&
    isMariadbJson(table, column)
  ) {
    facts.kind = 'json';
  }
  const serial = column.default !== null && /^nextval\(/i.test(column.default);
  const autoIncrement = column.autoIncrement || column.identity !== undefined || serial;
  const generated = column.generated !== undefined;
  const info: { -readonly [K in keyof ColumnInfo]: ColumnInfo[K] } = {
    name: column.name,
    dialect,
    dataType: column.dataType,
    nullable: column.nullable,
    hasDefault: column.default !== null || autoIncrement || generated,
    autoIncrement,
    generated,
    ...facts,
  };
  if (generated) info.readOnly = 'The column is generated by the server';
  else if (column.identity?.generation === 'always')
    info.readOnly = 'The column is GENERATED ALWAYS AS IDENTITY';
  else if (dialect !== 'postgres' && facts.kind === 'geometry')
    info.readOnly = 'Geometry values cannot be edited as text';
  if (dialect !== 'postgres') {
    const charset = column.charset ?? table.options['charset'];
    const collation = column.collation ?? (column.charset ? undefined : table.options['collation']);
    if (charset !== undefined) info.charset = charset;
    if (collation !== undefined) info.collation = collation;
  } else if (column.collation !== undefined) {
    info.collation = column.collation;
  }
  return info;
}

/** The columns of a table, in ordinal order, ready for the grid, filters and editors. */
export function describeColumns(table: TableDef, options: DescribeColumnsOptions): ColumnInfo[] {
  return [...table.columns]
    .sort((a, b) => a.ordinal - b.ordinal)
    .map((column) => describeColumn(table, column, options));
}

/**
 * A column of a query result. Result metadata has no defaults or enum labels, so it is less
 * precise than `describeColumns`; the kind reported by the driver wins over the type name.
 */
export function columnFromMeta(meta: ColumnMeta, dialect: SqlDialect): ColumnInfo {
  const facts = factsFor(meta.nativeType, dialect);
  if (facts.kind === 'unknown' || (facts.kind !== meta.kind && !facts.booleanLike)) {
    facts.kind = meta.kind;
  }
  const info: { -readonly [K in keyof ColumnInfo]: ColumnInfo[K] } = {
    name: meta.name,
    dialect,
    dataType: meta.nativeType,
    nullable: meta.nullable ?? true,
    hasDefault: false,
    autoIncrement: false,
    generated: false,
    ...facts,
  };
  if (dialect !== 'postgres' && facts.kind === 'geometry')
    info.readOnly = 'Geometry values cannot be edited as text';
  return info;
}

/** MySQL FLOAT (single precision), which compares as DOUBLE unless the operand is cast. */
export function isSingleFloat(column: ColumnInfo, dialect: SqlDialect): boolean {
  return (
    dialect !== 'postgres' && column.kind === 'float' && /^float\b/i.test(column.dataType.trim())
  );
}

const PG_TEXT_COMPARED = new Set([
  'json',
  'xml',
  'point',
  'line',
  'lseg',
  'box',
  'path',
  'polygon',
  'circle',
]);

function pgBaseName(column: ColumnInfo): string {
  return column.dataType
    .replace(/\([^)]*\)/, '')
    .replace(/(\[\d*\])+$/, '')
    .trim()
    .toLowerCase();
}

/**
 * PostgreSQL types without an equality operator worth using (json, xml, the geometric types,
 * and arrays of them): matched on their text form, which is exactly what the driver returns.
 */
export function comparedAsText(column: ColumnInfo, dialect: SqlDialect): boolean {
  if (dialect !== 'postgres') return false;
  return PG_TEXT_COMPARED.has(pgBaseName(column));
}

/**
 * Whether ORDER BY works on the column. PostgreSQL cannot order json, xml or the built-in
 * geometric types; MySQL and MariaDB order everything.
 */
export function canSort(column: ColumnInfo, dialect: SqlDialect): boolean {
  return !comparedAsText(column, dialect);
}
