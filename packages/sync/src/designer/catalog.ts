import { atLeast } from '@joinery/core';
import type { SchemaSnapshot, SqlDialect, SqlEngineId } from '@joinery/core';

import { canonicalPgType } from '../types';
import { pgIdent } from './names';

/**
 * The type catalogue behind the designer's type dropdown (spec §8: engine-specific types), and
 * `parseType` / `formatType`, which convert between a column's `dataType` text and its parts.
 * `formatType` writes the snapshot spelling — PostgreSQL format_type(), MySQL COLUMN_TYPE — so
 * a type picked in the designer compares equal to the same type read back from the server.
 */

export type TypeCategory =
  'numeric' | 'text' | 'binary' | 'date-time' | 'json' | 'spatial' | 'other';

export type TypeParameterName =
  /** Characters, bytes or bits; vector dimensions. */
  | 'length'
  | 'precision'
  | 'scale'
  /** Fractional seconds precision. */
  | 'fsp'
  /** ENUM / SET labels. */
  | 'values'
  /** PostgreSQL interval fields, e.g. `day to second`. */
  | 'fields'
  /** MySQL integer display width (deprecated since 8.0.17, still reported by MariaDB). */
  | 'displayWidth';

/** A parameter the type takes in parentheses (or, for interval fields, after its name). */
export interface TypeParameter {
  readonly name: TypeParameterName;
  readonly required: boolean;
  readonly min?: number;
  readonly max?: number;
  /** What the server assumes when the parameter is left out. */
  readonly default?: number;
}

/** A PostgreSQL enum, domain, composite or range type from the schema. */
export interface UserTypeInfo {
  readonly kind: 'enum' | 'domain' | 'composite' | 'range';
  readonly schema: string;
  /** Enum labels in order. */
  readonly values: readonly string[];
}

/** One entry of the type dropdown. */
export interface TypeCatalogEntry {
  /** The name `formatType` writes: "character varying", "int", "public.mood". */
  readonly name: string;
  readonly category: TypeCategory;
  readonly parameters: readonly TypeParameter[];
  /** Other spellings `parseType` accepts ("varchar", "int4", "integer"...). */
  readonly aliases: readonly string[];
  /** MySQL numerics: UNSIGNED and ZEROFILL apply. */
  readonly unsigned: boolean;
  readonly zerofill: boolean;
  /** Can number itself: MySQL AUTO_INCREMENT, PostgreSQL identity. */
  readonly autoIncrement: boolean;
  /** MySQL string types take CHARACTER SET; collatable types take COLLATE. */
  readonly charset: boolean;
  readonly collation: boolean;
  /** PostgreSQL: usable as an array element type (`integer[]`). */
  readonly array: boolean;
  /** Not a real type: PostgreSQL serial types expand to an integer with an owned sequence. */
  readonly pseudo: boolean;
  /** Why the type or one of its forms is discouraged, when it is. */
  readonly deprecated?: string;
  /** PostgreSQL extension that provides the type. */
  readonly extension?: string;
  readonly userType?: UserTypeInfo;
  readonly description: string;
}

/** A `dataType` split into its parts. `formatType(parseType(t))` returns `t` for snapshot text. */
export interface ParsedType {
  /** Catalogue name (aliases resolved), or the text as written for unknown and user types. */
  readonly name: string;
  readonly length?: number;
  readonly precision?: number;
  readonly scale?: number;
  readonly fsp?: number;
  readonly values?: readonly string[];
  readonly fields?: string;
  readonly displayWidth?: number;
  readonly unsigned?: boolean;
  readonly zerofill?: boolean;
  /** PostgreSQL array dimensions; 0 or absent for a scalar. */
  readonly arrayDimensions?: number;
  /** Arguments the catalogue does not model, verbatim: `geometry(Point,4326)`, `vector(3)`. */
  readonly modifier?: string;
}

// ---------------------------------------------------------------------------------------------
// Catalogue data

type Draft = Partial<Omit<TypeCatalogEntry, 'name' | 'category' | 'description'>> & {
  /** Oldest server version with the type, per engine family member ("*" = every version). */
  readonly since?: Readonly<Partial<Record<SqlEngineId, string>>>;
};

interface Spec {
  readonly name: string;
  readonly category: TypeCategory;
  readonly description: string;
  readonly draft: Draft;
}

const spec = (
  name: string,
  category: TypeCategory,
  description: string,
  draft: Draft = {},
): Spec => ({ name, category, description, draft });

const length = (min: number, max: number, required = false, fallback?: number): TypeParameter => ({
  name: 'length',
  required,
  min,
  max,
  ...(fallback !== undefined ? { default: fallback } : {}),
});
const fsp = (fallback: number): TypeParameter => ({
  name: 'fsp',
  required: false,
  min: 0,
  max: 6,
  default: fallback,
});
const displayWidth: TypeParameter = { name: 'displayWidth', required: false, min: 1, max: 255 };

const PG_TEXT = { collation: true, array: true };
const PG_INT = { autoIncrement: true, array: true };

function pgSpecs(version: string | undefined): Spec[] {
  const negativeScale = version === undefined || atLeast(version, '15');
  return [
    spec('smallint', 'numeric', '2-byte integer', { aliases: ['int2'], ...PG_INT }),
    spec('integer', 'numeric', '4-byte integer', { aliases: ['int', 'int4'], ...PG_INT }),
    spec('bigint', 'numeric', '8-byte integer', { aliases: ['int8'], ...PG_INT }),
    spec('numeric', 'numeric', 'Exact decimal with optional precision and scale', {
      aliases: ['decimal'],
      array: true,
      parameters: [
        { name: 'precision', required: false, min: 1, max: 1000 },
        { name: 'scale', required: false, min: negativeScale ? -1000 : 0, max: 1000, default: 0 },
      ],
    }),
    spec('real', 'numeric', '4-byte floating point', { aliases: ['float4'], array: true }),
    spec('double precision', 'numeric', '8-byte floating point', {
      aliases: ['float8', 'float'],
      array: true,
    }),
    spec('money', 'numeric', 'Currency amount (locale-dependent)', { array: true }),
    spec('smallserial', 'numeric', 'smallint with an owned sequence default', {
      aliases: ['serial2'],
      autoIncrement: true,
      pseudo: true,
    }),
    spec('serial', 'numeric', 'integer with an owned sequence default', {
      aliases: ['serial4'],
      autoIncrement: true,
      pseudo: true,
    }),
    spec('bigserial', 'numeric', 'bigint with an owned sequence default', {
      aliases: ['serial8'],
      autoIncrement: true,
      pseudo: true,
    }),
    spec('character varying', 'text', 'Variable-length text with an optional limit', {
      aliases: ['varchar'],
      parameters: [length(1, 10485760)],
      ...PG_TEXT,
    }),
    spec('character', 'text', 'Fixed-length, blank-padded text', {
      aliases: ['char', 'bpchar'],
      parameters: [length(1, 10485760, false, 1)],
      ...PG_TEXT,
    }),
    spec('text', 'text', 'Variable-length text', PG_TEXT),
    spec('name', 'other', '63-byte internal name type', { array: true }),
    spec('"char"', 'other', 'Single-byte internal type', { array: true }),
    spec('bytea', 'binary', 'Binary string', { array: true }),
    spec('bit', 'binary', 'Fixed-length bit string', {
      parameters: [length(1, 83886080, false, 1)],
      array: true,
    }),
    spec('bit varying', 'binary', 'Variable-length bit string', {
      aliases: ['varbit'],
      parameters: [length(1, 83886080)],
      array: true,
    }),
    spec('date', 'date-time', 'Calendar date', { array: true }),
    spec('time without time zone', 'date-time', 'Time of day', {
      aliases: ['time'],
      parameters: [fsp(6)],
      array: true,
    }),
    spec('time with time zone', 'date-time', 'Time of day with time zone', {
      aliases: ['timetz'],
      parameters: [fsp(6)],
      array: true,
      deprecated: 'time with time zone is discouraged by PostgreSQL; use timestamp with time zone',
    }),
    spec('timestamp without time zone', 'date-time', 'Date and time', {
      aliases: ['timestamp'],
      parameters: [fsp(6)],
      array: true,
    }),
    spec('timestamp with time zone', 'date-time', 'Point in time, shown in the session zone', {
      aliases: ['timestamptz'],
      parameters: [fsp(6)],
      array: true,
    }),
    spec('interval', 'date-time', 'Time span', {
      parameters: [{ name: 'fields', required: false }, fsp(6)],
      array: true,
    }),
    spec('json', 'json', 'JSON text, stored as written', { array: true }),
    spec('jsonb', 'json', 'Binary JSON', { array: true, since: { postgres: '9.4' } }),
    spec('jsonpath', 'json', 'SQL/JSON path expression', {
      array: true,
      since: { postgres: '12' },
    }),
    ...['point', 'line', 'lseg', 'box', 'path', 'polygon', 'circle'].map((name) =>
      spec(name, 'spatial', `Geometric ${name}`, { array: true }),
    ),
    spec('boolean', 'other', 'true / false', { aliases: ['bool'], array: true }),
    spec('uuid', 'other', 'Universally unique identifier', { array: true }),
    spec('xml', 'other', 'XML document or fragment', { array: true }),
    spec('inet', 'other', 'IPv4 or IPv6 host address', { array: true }),
    spec('cidr', 'other', 'IPv4 or IPv6 network', { array: true }),
    spec('macaddr', 'other', 'MAC address', { array: true }),
    spec('macaddr8', 'other', 'MAC address (EUI-64)', { array: true, since: { postgres: '10' } }),
    spec('tsvector', 'other', 'Text search document', { array: true }),
    spec('tsquery', 'other', 'Text search query', { array: true }),
    ...['int4range', 'int8range', 'numrange', 'tsrange', 'tstzrange', 'daterange'].map((name) =>
      spec(name, 'other', 'Range', { array: true }),
    ),
    ...[
      'int4multirange',
      'int8multirange',
      'nummultirange',
      'tsmultirange',
      'tstzmultirange',
      'datemultirange',
    ].map((name) => spec(name, 'other', 'Multirange', { array: true, since: { postgres: '14' } })),
    spec('pg_lsn', 'other', 'Write-ahead log location', { array: true }),
    spec('pg_snapshot', 'other', 'Transaction snapshot', {
      array: true,
      since: { postgres: '13' },
    }),
    spec('txid_snapshot', 'other', 'Transaction snapshot (legacy)', { array: true }),
    spec('oid', 'other', 'Object identifier', { array: true }),
  ];
}

/** Types common PostgreSQL extensions add, keyed by extension name. */
const PG_EXTENSION_TYPES: Readonly<Record<string, readonly Spec[]>> = {
  citext: [spec('citext', 'text', 'Case-insensitive text', { ...PG_TEXT })],
  hstore: [spec('hstore', 'other', 'Key/value pairs', { array: true })],
  ltree: [spec('ltree', 'other', 'Label tree path', { array: true })],
  vector: [
    spec('vector', 'other', 'pgvector embedding', {
      parameters: [length(1, 16000)],
      array: true,
    }),
  ],
  postgis: [
    spec('geometry', 'spatial', 'PostGIS geometry', { array: true }),
    spec('geography', 'spatial', 'PostGIS geography', { array: true }),
  ],
};

const MY_NUM = { unsigned: true, zerofill: true };
const MY_TEXT = { charset: true, collation: true };
const INT_DEPRECATION = 'Integer display widths are deprecated (MySQL 8.0.17) and ignored';

function mysqlSpecs(engine: 'mysql' | 'mariadb', version: string | undefined): Spec[] {
  const mysql8 = engine === 'mysql' && (version === undefined || atLeast(version, '8.0.17'));
  const floatNote = mysql8
    ? 'UNSIGNED, ZEROFILL and (M,D) on floating-point types are deprecated (MySQL 8.0.17)'
    : undefined;
  const int = (name: string, bytes: number, aliases: string[]): Spec =>
    spec(name, 'numeric', `${bytes}-byte integer`, {
      aliases,
      parameters: [displayWidth],
      autoIncrement: true,
      ...MY_NUM,
      ...(mysql8 ? { deprecated: INT_DEPRECATION } : {}),
    });
  return [
    int('tinyint', 1, ['int1', 'bool', 'boolean']),
    int('smallint', 2, ['int2']),
    int('mediumint', 3, ['int3', 'middleint']),
    int('int', 4, ['integer', 'int4']),
    int('bigint', 8, ['int8']),
    spec('decimal', 'numeric', 'Exact decimal', {
      aliases: ['dec', 'numeric', 'fixed'],
      parameters: [
        { name: 'precision', required: false, min: 1, max: 65, default: 10 },
        { name: 'scale', required: false, min: 0, max: 30, default: 0 },
      ],
      ...MY_NUM,
      ...(mysql8 ? { deprecated: 'UNSIGNED on DECIMAL is deprecated (MySQL 8.0.17)' } : {}),
    }),
    spec('float', 'numeric', '4-byte floating point', {
      aliases: ['float4'],
      parameters: [
        { name: 'precision', required: false, min: 0, max: 255 },
        { name: 'scale', required: false, min: 0, max: 30 },
      ],
      ...MY_NUM,
      ...(floatNote !== undefined ? { deprecated: floatNote } : {}),
    }),
    spec('double', 'numeric', '8-byte floating point', {
      aliases: ['double precision', 'real', 'float8'],
      parameters: [
        { name: 'precision', required: false, min: 1, max: 255 },
        { name: 'scale', required: false, min: 0, max: 30 },
      ],
      ...MY_NUM,
      ...(floatNote !== undefined ? { deprecated: floatNote } : {}),
    }),
    spec('bit', 'numeric', 'Bit field', { parameters: [length(1, 64, false, 1)] }),
    spec('char', 'text', 'Fixed-length text', {
      aliases: ['character', 'nchar', 'national char', 'national character'],
      parameters: [length(0, 255, false, 1)],
      ...MY_TEXT,
    }),
    spec('varchar', 'text', 'Variable-length text', {
      aliases: ['character varying', 'nvarchar', 'national varchar', 'varcharacter'],
      parameters: [length(0, 65535, true)],
      ...MY_TEXT,
    }),
    spec('tinytext', 'text', 'Text up to 255 bytes', MY_TEXT),
    spec('text', 'text', 'Text up to 64 KB', { parameters: [length(0, 4294967295)], ...MY_TEXT }),
    spec('mediumtext', 'text', 'Text up to 16 MB', {
      aliases: ['long', 'long varchar'],
      ...MY_TEXT,
    }),
    spec('longtext', 'text', 'Text up to 4 GB', MY_TEXT),
    spec('enum', 'text', 'One of a list of labels', {
      parameters: [{ name: 'values', required: true, min: 1, max: 65535 }],
      ...MY_TEXT,
    }),
    spec('set', 'text', 'Any combination of up to 64 labels', {
      parameters: [{ name: 'values', required: true, min: 1, max: 64 }],
      ...MY_TEXT,
    }),
    spec('binary', 'binary', 'Fixed-length bytes', { parameters: [length(0, 255, false, 1)] }),
    spec('varbinary', 'binary', 'Variable-length bytes', { parameters: [length(0, 65535, true)] }),
    spec('tinyblob', 'binary', 'Bytes up to 255'),
    spec('blob', 'binary', 'Bytes up to 64 KB', { parameters: [length(0, 4294967295)] }),
    spec('mediumblob', 'binary', 'Bytes up to 16 MB', { aliases: ['long varbinary'] }),
    spec('longblob', 'binary', 'Bytes up to 4 GB'),
    spec('date', 'date-time', 'Calendar date'),
    spec('time', 'date-time', 'Time of day or duration', { parameters: [fsp(0)] }),
    spec('datetime', 'date-time', 'Date and time', { parameters: [fsp(0)] }),
    spec('timestamp', 'date-time', 'Point in time (UTC-stored, 1970-2038)', {
      parameters: [fsp(0)],
    }),
    spec('year', 'date-time', 'Year', {
      parameters: [{ name: 'displayWidth', required: false, min: 4, max: 4 }],
      ...(mysql8 ? { deprecated: 'YEAR(4) is deprecated (MySQL 8.0.19); use YEAR' } : {}),
    }),
    spec(
      'json',
      'json',
      engine === 'mariadb' ? 'Alias of LONGTEXT with a JSON_VALID check' : 'JSON document',
      { since: { mysql: '5.7.8', mariadb: '10.2.7' } },
    ),
    spec('geometry', 'spatial', 'Any geometry'),
    spec('point', 'spatial', 'Point'),
    spec('linestring', 'spatial', 'Line string'),
    spec('polygon', 'spatial', 'Polygon'),
    spec('multipoint', 'spatial', 'Collection of points'),
    spec('multilinestring', 'spatial', 'Collection of line strings'),
    spec('multipolygon', 'spatial', 'Collection of polygons'),
    spec('geometrycollection', 'spatial', 'Collection of geometries', {
      aliases: ['geomcollection'],
    }),
    spec('uuid', 'other', 'UUID', { since: { mariadb: '10.7' } }),
    spec('inet4', 'other', 'IPv4 address', { since: { mariadb: '10.10' } }),
    spec('inet6', 'other', 'IPv6 address', { since: { mariadb: '10.5' } }),
    spec('vector', 'other', 'Embedding vector', {
      parameters: [length(1, 16383, true)],
      since: { mysql: '9.0', mariadb: '11.7' },
    }),
  ];
}

function available(draft: Draft, engine: SqlEngineId, version: string | undefined): boolean {
  if (draft.since === undefined) return true;
  const minimum = draft.since[engine];
  if (minimum === undefined) return false;
  return version === undefined || atLeast(version, minimum);
}

function build(s: Spec): TypeCatalogEntry {
  const d = s.draft;
  return {
    name: s.name,
    category: s.category,
    parameters: d.parameters ?? [],
    aliases: d.aliases ?? [],
    unsigned: d.unsigned ?? false,
    zerofill: d.zerofill ?? false,
    autoIncrement: d.autoIncrement ?? false,
    charset: d.charset ?? false,
    collation: d.collation ?? false,
    array: d.array ?? false,
    pseudo: d.pseudo ?? false,
    ...(d.deprecated !== undefined ? { deprecated: d.deprecated } : {}),
    ...(d.extension !== undefined ? { extension: d.extension } : {}),
    ...(d.userType !== undefined ? { userType: d.userType } : {}),
    description: s.description,
  };
}

/** A PostgreSQL qualified type name as format_type() prints it with an empty search_path. */
export function pgQualifiedType(schema: string, name: string): string {
  return `${pgIdent(schema)}.${pgIdent(name)}`;
}

/**
 * The types the designer offers for an engine and server version: built-in types (those newer
 * than the server left out) and, for PostgreSQL, the enum, domain, composite and range types
 * of every schema in `snapshot` plus the types of its installed extensions. PostgreSQL user
 * types are schema-qualified, as the snapshot spells them.
 */
export function typeCatalog(
  engine: SqlEngineId,
  serverVersion?: string,
  snapshot?: SchemaSnapshot,
): TypeCatalogEntry[] {
  const version = serverVersion ?? snapshot?.serverVersion;
  const specs = engine === 'postgres' ? pgSpecs(version) : mysqlSpecs(engine, version);
  const entries = specs.filter((s) => available(s.draft, engine, version)).map(build);
  if (engine !== 'postgres' || snapshot === undefined) return entries;
  for (const extension of snapshot.extensions) {
    for (const s of PG_EXTENSION_TYPES[extension.name] ?? []) {
      const schema = extension.schema ?? 'public';
      entries.push(
        build({
          ...s,
          name: pgQualifiedType(schema, s.name),
          draft: { ...s.draft, aliases: [s.name], extension: extension.name },
        }),
      );
    }
  }
  for (const schema of snapshot.schemas) {
    for (const type of schema.types) {
      const base = type.kind === 'domain' ? domainBase(type.definition) : undefined;
      const collatable = base !== undefined && /\b(text|char|varchar|character)\b/i.test(base);
      entries.push(
        build({
          name: pgQualifiedType(schema.name, type.name),
          category: type.kind === 'enum' ? 'text' : 'other',
          description:
            type.kind === 'enum'
              ? `Enum: ${type.values.join(', ')}`
              : type.kind === 'domain'
                ? `Domain over ${base ?? 'a base type'}`
                : `${type.kind === 'composite' ? 'Composite' : 'Range'} type`,
          draft: {
            array: true,
            collation: type.kind === 'enum' ? false : collatable,
            userType: { kind: type.kind, schema: schema.name, values: type.values },
          },
        }),
      );
    }
  }
  return entries;
}

/** The base type of a CREATE DOMAIN statement ("CREATE DOMAIN d AS integer CHECK ..."). */
function domainBase(definition: string): string | undefined {
  const match =
    /\bAS\s+(.+?)(?:\s+(?:COLLATE|DEFAULT|CONSTRAINT|NOT\s+NULL|NULL|CHECK)\b|;|$)/is.exec(
      definition,
    );
  return match?.[1]?.trim();
}

/** The catalogue entry for a parsed type, by name or alias (case-insensitive outside quotes). */
export function findType(
  catalog: readonly TypeCatalogEntry[],
  type: ParsedType | string,
): TypeCatalogEntry | undefined {
  const name = typeof type === 'string' ? type : type.name;
  const key = name.includes('"') ? name : name.toLowerCase();
  return (
    catalog.find((e) => e.name === key) ??
    catalog.find((e) => e.aliases.includes(key)) ??
    catalog.find((e) => e.name.toLowerCase() === key)
  );
}

// ---------------------------------------------------------------------------------------------
// Parsing

const collapse = (text: string): string => text.trim().replace(/\s+/g, ' ');

/** Lower-cases outside quotes (enum labels, quoted names). */
function lowerOutsideQuotes(text: string): string {
  return text.replace(/('(?:[^'\\]|\\.|'')*'|"(?:[^"]|"")*"|`(?:[^`]|``)*`)|[^'"`]+/g, (part, q) =>
    q === undefined ? part.toLowerCase() : part,
  );
}

/** MySQL enum/set labels from their argument list: `'a','b''c'` → a, b'c. */
function parseLabels(args: string): string[] {
  return [...args.matchAll(/'((?:[^'\\]|\\.|'')*)'/g)].map((m) =>
    m[1]!.replace(/''/g, "'").replace(/\\(.)/g, (_all, ch: string) => ch),
  );
}

/** A label as MySQL COLUMN_TYPE prints it. */
function mysqlLabel(value: string): string {
  return `'${value.replaceAll('\\', '\\\\').replaceAll("'", "''")}'`;
}

const MYSQL_ALIASES: Readonly<Record<string, string>> = {
  integer: 'int',
  int1: 'tinyint',
  int2: 'smallint',
  int3: 'mediumint',
  int4: 'int',
  int8: 'bigint',
  middleint: 'mediumint',
  dec: 'decimal',
  numeric: 'decimal',
  fixed: 'decimal',
  'double precision': 'double',
  real: 'double',
  float4: 'float',
  float8: 'double',
  character: 'char',
  'national char': 'char',
  'national character': 'char',
  nchar: 'char',
  'character varying': 'varchar',
  'national varchar': 'varchar',
  'national character varying': 'varchar',
  nvarchar: 'varchar',
  varcharacter: 'varchar',
  long: 'mediumtext',
  'long varchar': 'mediumtext',
  'long varbinary': 'mediumblob',
  geomcollection: 'geometrycollection',
};

const MYSQL_INTS = new Set(['tinyint', 'smallint', 'mediumint', 'int', 'bigint']);

function nums(args: string | undefined): number[] {
  if (args === undefined || args.trim() === '') return [];
  return args.split(',').map((a) => Number(a.trim()));
}

function parseMysqlType(text: string): ParsedType | undefined {
  const lowered = lowerOutsideQuotes(collapse(text));
  const match = /^([a-z][a-z0-9_ ]*?)\s*(?:\((.*)\))?((?:\s+(?:unsigned|signed|zerofill))*)$/s.exec(
    lowered,
  );
  if (!match) return undefined;
  let name = match[1]!.trim();
  const args = match[2];
  const modifiers = match[3]!.trim().split(/\s+/);
  const unsigned = modifiers.includes('unsigned') || modifiers.includes('zerofill');
  const zerofill = modifiers.includes('zerofill');
  const flags = {
    ...(unsigned ? { unsigned: true } : {}),
    ...(zerofill ? { zerofill: true } : {}),
  };
  if (name === 'bool' || name === 'boolean') {
    return args === undefined ? { name: 'tinyint', displayWidth: 1, ...flags } : undefined;
  }
  name = MYSQL_ALIASES[name] ?? name;
  if (name === 'enum' || name === 'set') {
    return { name, values: parseLabels(args ?? ''), ...flags };
  }
  const n = nums(args);
  if (n.some((v) => !Number.isFinite(v))) return { name, modifier: args!, ...flags };
  if (MYSQL_INTS.has(name) || name === 'year') {
    return { name, ...(n[0] !== undefined ? { displayWidth: n[0] } : {}), ...flags };
  }
  if (name === 'decimal' || name === 'float' || name === 'double') {
    return {
      name,
      ...(n[0] !== undefined ? { precision: n[0] } : {}),
      ...(n[1] !== undefined ? { scale: n[1] } : {}),
      ...flags,
    };
  }
  if (name === 'time' || name === 'datetime' || name === 'timestamp') {
    return { name, ...(n[0] !== undefined ? { fsp: n[0] } : {}), ...flags };
  }
  if (n.length > 1) return { name, modifier: args!, ...flags };
  return { name, ...(n[0] !== undefined ? { length: n[0] } : {}), ...flags };
}

const PG_ZONED = /^(time|timestamp)(?:\((\d+)\))? (with|without) time zone$/;
const PG_INTERVAL =
  /^interval(?: (year to month|day to hour|day to minute|day to second|hour to minute|hour to second|minute to second|year|month|day|hour|minute|second))?(?:\((\d+)\))?$/;
const PG_LENGTH_TYPES = new Set(['character varying', 'character', 'bit', 'bit varying']);

function parsePgType(text: string): ParsedType | undefined {
  const raw = collapse(text);
  if (raw === '') return undefined;
  const canonical = canonicalPgType(raw);
  let body = canonical;
  let dims = 0;
  while (body.endsWith('[]')) {
    dims++;
    body = body.slice(0, -2);
  }
  const array = dims > 0 ? { arrayDimensions: dims } : {};
  if (body === '"char"') return { name: body, ...array };
  if (body.includes('"') || body.includes('.')) {
    const open = openParenOutsideQuotes(body);
    if (open === -1) return { name: body, ...array };
    if (!body.endsWith(')')) return undefined;
    return { name: body.slice(0, open), modifier: body.slice(open + 1, -1), ...array };
  }
  const zoned = PG_ZONED.exec(body);
  if (zoned) {
    return {
      name: `${zoned[1]!} ${zoned[3]!} time zone`,
      ...(zoned[2] !== undefined ? { fsp: Number(zoned[2]) } : {}),
      ...array,
    };
  }
  const interval = PG_INTERVAL.exec(body);
  if (interval) {
    return {
      name: 'interval',
      ...(interval[1] !== undefined ? { fields: interval[1] } : {}),
      ...(interval[2] !== undefined ? { fsp: Number(interval[2]) } : {}),
      ...array,
    };
  }
  const match = /^([a-z_][a-z0-9_$ ]*?)(?:\((.*)\))?$/.exec(body);
  if (!match) return undefined;
  const name = match[1]!;
  const args = match[2];
  if (args === undefined) return { name, ...array };
  const n = nums(args);
  if (n.some((v) => !Number.isInteger(v))) return { name, modifier: args, ...array };
  if (name === 'numeric') {
    return {
      name,
      ...(n[0] !== undefined ? { precision: n[0] } : {}),
      ...(n[1] !== undefined ? { scale: n[1] } : {}),
      ...array,
    };
  }
  if (PG_LENGTH_TYPES.has(name) && n.length === 1) return { name, length: n[0]!, ...array };
  return { name, modifier: args, ...array };
}

function openParenOutsideQuotes(text: string): number {
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '"') quoted = !quoted;
    else if (text[i] === '(' && !quoted) return i;
  }
  return -1;
}

/**
 * Splits a `dataType` into its parts, resolving aliases (PostgreSQL int4 → integer, varchar →
 * character varying, timestamptz → timestamp with time zone; MySQL integer → int, bool →
 * tinyint(1), numeric → decimal...). Returns undefined when the text is not shaped like a type.
 * The name is not checked against the catalogue: see `findType`.
 */
export function parseType(text: string, engine: SqlEngineId | SqlDialect): ParsedType | undefined {
  if (typeof text !== 'string') return undefined;
  if (/[;]|--|\/\*/.test(text)) return undefined;
  return engine === 'postgres' ? parsePgType(text) : parseMysqlType(text);
}

/**
 * Writes a parsed type in the snapshot spelling: PostgreSQL format_type() ("character
 * varying(20)", "timestamp(3) with time zone", "numeric(10,2)", "public.mood[]"), MySQL
 * COLUMN_TYPE ("int unsigned", "decimal(10,2)", "enum('a','b')", "datetime(3)").
 */
export function formatType(type: ParsedType, engine: SqlEngineId | SqlDialect): string {
  if (engine === 'postgres') {
    const arrays = '[]'.repeat(type.arrayDimensions ?? 0);
    const zoned = /^(time|timestamp) (with|without) time zone$/.exec(type.name);
    if (zoned) {
      const precision = type.fsp !== undefined ? `(${type.fsp})` : '';
      return `${zoned[1]!}${precision} ${zoned[2]!} time zone${arrays}`;
    }
    if (type.name === 'interval') {
      const fields = type.fields !== undefined ? ` ${type.fields}` : '';
      return `interval${fields}${type.fsp !== undefined ? `(${type.fsp})` : ''}${arrays}`;
    }
    if (type.name === 'numeric' && type.precision !== undefined) {
      return `numeric(${type.precision},${type.scale ?? 0})${arrays}`;
    }
    if (type.length !== undefined) return `${type.name}(${type.length})${arrays}`;
    if (type.modifier !== undefined) return `${type.name}(${type.modifier})${arrays}`;
    return `${type.name}${arrays}`;
  }
  let args = '';
  if (type.values !== undefined) args = `(${type.values.map(mysqlLabel).join(',')})`;
  else if (type.modifier !== undefined) args = `(${type.modifier})`;
  else if (type.displayWidth !== undefined) args = `(${type.displayWidth})`;
  else if (type.precision !== undefined) {
    args =
      type.name === 'decimal'
        ? `(${type.precision},${type.scale ?? 0})`
        : `(${type.precision}${type.scale !== undefined ? `,${type.scale}` : ''})`;
  } else if (type.fsp !== undefined) args = type.fsp === 0 ? '' : `(${type.fsp})`;
  else if (type.length !== undefined) args = `(${type.length})`;
  const zerofill = type.zerofill === true;
  const unsigned = type.unsigned === true || zerofill;
  return `${type.name}${args}${unsigned ? ' unsigned' : ''}${zerofill ? ' zerofill' : ''}`;
}
