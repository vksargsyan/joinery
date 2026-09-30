import { atLeast, type SqlDialect, type TypeDef } from '@joinery/core';
import { formatType, parseType, type ParsedType } from '@joinery/sync';

/**
 * The type mapping table per engine pair (spec §12): which target column type each source
 * type gets when a table moves between PostgreSQL, MySQL and MariaDB. The wizard shows the
 * pick for every column and lets the user change it; this is the default.
 *
 * Rules favour keeping every value over the tightest type: unsigned integers widen,
 * unconstrained numerics become the widest decimal, PostgreSQL `text` becomes `longtext`,
 * timestamps with a time zone are stored as UTC. Types with no counterpart are read in a form
 * the target takes (`read`): arrays as JSON, money as numeric, spatial values as WKT text.
 * Within one dialect the type is kept verbatim.
 */

/** How the source column is read so the target can take it (a SELECT expression). */
export type ReadForm = 'json' | 'numeric' | 'wkt' | 'text';

export interface TypeMapping {
  /** The target column type, spelled as the target's introspection prints it. */
  readonly dataType: string;
  /** Why, or what to watch out for (shown next to the type). */
  readonly note?: string;
  readonly read?: ReadForm;
}

/** A PostgreSQL enum, domain, composite or range type, with its schema. */
export interface SourceUserType extends TypeDef {
  readonly schema: string;
}

export interface TypeMappingContext {
  readonly from: SqlDialect;
  readonly to: SqlDialect;
  /** The target server's version: MariaDB has `uuid` from 10.7 and `inet4`/`inet6` from 10.10. */
  readonly targetVersion?: string;
  /** The column is in a key or index on the target (MySQL cannot index long text without a prefix). */
  readonly key?: boolean;
  /** PostgreSQL user types of the source, by qualified name (`public.mood`). */
  readonly userTypes?: ReadonlyMap<string, SourceUserType>;
  /** A MariaDB JSON column (`longtext` with a `json_valid` check). */
  readonly json?: boolean;
}

/** True for dialects of the MySQL family. */
function mysqlFamily(dialect: SqlDialect): boolean {
  return dialect === 'mysql' || dialect === 'mariadb';
}

function mariadbAtLeast(version: string | undefined, minimum: string): boolean {
  return version !== undefined && atLeast(version, minimum);
}

/** `CREATE DOMAIN d AS integer CHECK ...` → `integer`. */
export function domainBaseType(definition: string): string | undefined {
  const match =
    /\bAS\s+(.+?)(?:\s+(?:COLLATE|DEFAULT|CONSTRAINT|NOT\s+NULL|NULL|CHECK)\b|;|$)/is.exec(
      definition,
    );
  return match?.[1]?.trim();
}

/** A MySQL/MariaDB string type that holds `chars` characters of utf8mb4 and can be indexed. */
function mysqlText(chars: number | undefined, key: boolean): TypeMapping {
  if (key) {
    const n = chars === undefined ? 255 : Math.min(chars, 768);
    return {
      dataType: `varchar(${n})`,
      ...(chars === undefined || chars > 768
        ? { note: `A key column: MySQL indexes at most ${n} characters, longer values fail` }
        : {}),
    };
  }
  if (chars === undefined) return { dataType: 'longtext' };
  if (chars <= 2000) return { dataType: `varchar(${chars})` };
  if (chars <= 16_383) return { dataType: 'text' };
  if (chars <= 4_194_303) return { dataType: 'mediumtext' };
  return { dataType: 'longtext' };
}

function mysqlDecimal(precision: number | undefined, scale: number | undefined): TypeMapping {
  if (precision === undefined) {
    return {
      dataType: 'decimal(65,30)',
      note: 'An unconstrained numeric becomes decimal(65,30): more digits fail',
    };
  }
  const s = scale ?? 0;
  if (precision <= 65 && s <= 30) return { dataType: `decimal(${precision},${s})` };
  return {
    dataType: `decimal(65,${Math.min(s, 30)})`,
    note: `MySQL decimals have at most 65 digits (30 after the point)`,
  };
}

/** Fractional seconds as MySQL takes them (0–6). */
function fsp(value: number | undefined, fallback: number): number {
  return Math.min(6, Math.max(0, value ?? fallback));
}

function mysqlTemporal(name: 'datetime' | 'time', digits: number): string {
  return digits > 0 ? `${name}(${digits})` : name;
}

/** PostgreSQL → MySQL or MariaDB. */
function fromPostgres(type: ParsedType, context: TypeMappingContext): TypeMapping {
  const key = context.key === true;
  const mariadb = context.to === 'mariadb';
  if ((type.arrayDimensions ?? 0) > 0) {
    return { dataType: 'json', read: 'json', note: 'Arrays are copied as JSON arrays' };
  }
  const user = context.userTypes?.get(type.name);
  if (user !== undefined) {
    if (user.kind === 'enum' && user.values.length > 0) {
      return { dataType: formatType({ name: 'enum', values: user.values }, context.to) };
    }
    if (user.kind === 'domain') {
      const base = domainBaseType(user.definition);
      const parsed = base !== undefined ? parseType(base, 'postgres') : undefined;
      if (parsed !== undefined) return fromPostgres(parsed, { ...context, userTypes: new Map() });
    }
    return { ...mysqlText(undefined, key), read: 'text', note: `${type.name} is copied as text` };
  }
  switch (type.name) {
    case 'smallint':
      return { dataType: 'smallint' };
    case 'integer':
      return { dataType: 'int' };
    case 'bigint':
    case 'oid':
      return { dataType: 'bigint' };
    case 'numeric':
      return mysqlDecimal(type.precision, type.scale);
    case 'real':
      return { dataType: 'float' };
    case 'double precision':
      return { dataType: 'double' };
    case 'money':
      return { dataType: 'decimal(19,2)', read: 'numeric' };
    case 'boolean':
      return { dataType: 'tinyint(1)' };
    case 'character varying':
      return mysqlText(type.length, key);
    case 'character':
      return (type.length ?? 1) <= 255
        ? { dataType: `char(${type.length ?? 1})` }
        : mysqlText(type.length, key);
    case '"char"':
      return { dataType: 'char(1)' };
    case 'name':
      return { dataType: 'varchar(64)' };
    case 'text':
    case 'citext':
    case 'xml':
    case 'tsvector':
    case 'tsquery':
    case 'jsonpath':
      return mysqlText(undefined, key);
    case 'bytea':
      return key
        ? {
            dataType: 'varbinary(255)',
            note: 'A key column: MySQL indexes at most 255 bytes here, longer values fail',
          }
        : { dataType: 'longblob' };
    case 'date':
      return { dataType: 'date' };
    case 'timestamp without time zone':
      return { dataType: mysqlTemporal('datetime', fsp(type.fsp, 6)) };
    case 'timestamp with time zone':
      return {
        dataType: mysqlTemporal('datetime', fsp(type.fsp, 6)),
        note: 'Stored as UTC: MySQL has no timestamp with a time zone past 2038',
      };
    case 'time without time zone':
      return { dataType: mysqlTemporal('time', fsp(type.fsp, 6)) };
    case 'time with time zone':
      return {
        dataType: mysqlTemporal('time', fsp(type.fsp, 6)),
        note: 'The UTC offset is dropped',
      };
    case 'interval':
      return { dataType: 'varchar(100)', note: 'Intervals are copied as PostgreSQL text' };
    case 'json':
    case 'jsonb':
      return { dataType: 'json' };
    case 'uuid':
      return mariadb && mariadbAtLeast(context.targetVersion, '10.7')
        ? { dataType: 'uuid' }
        : { dataType: 'char(36)' };
    case 'inet':
    case 'cidr':
      return mariadb && mariadbAtLeast(context.targetVersion, '10.10') && type.name === 'inet'
        ? { dataType: 'inet6', note: 'IPv4 addresses read as IPv4-mapped IPv6' }
        : { dataType: 'varchar(43)' };
    case 'macaddr':
      return { dataType: 'varchar(17)' };
    case 'macaddr8':
      return { dataType: 'varchar(23)' };
    case 'bit':
    case 'bit varying':
      return type.length !== undefined && type.length <= 2000
        ? { dataType: `varchar(${type.length})`, note: 'Bit strings are copied as 0/1 text' }
        : { dataType: 'longtext', note: 'Bit strings are copied as 0/1 text' };
    case 'point':
    case 'line':
    case 'lseg':
    case 'box':
    case 'path':
    case 'polygon':
    case 'circle':
      return { dataType: 'longtext', note: 'Geometric values are copied as PostgreSQL text' };
    case 'int4range':
    case 'int8range':
    case 'numrange':
    case 'tsrange':
    case 'tstzrange':
    case 'daterange':
      return { dataType: 'varchar(255)', note: 'Ranges are copied as PostgreSQL text' };
    default:
      if (/(^|\.)(geometry|geography)$/.test(type.name)) {
        return { dataType: 'longtext', read: 'wkt', note: 'Spatial values are copied as WKT' };
      }
      return {
        ...mysqlText(undefined, key),
        read: 'text',
        note: `${type.name} has no MySQL counterpart; copied as text`,
      };
  }
}

/** MySQL or MariaDB → PostgreSQL. */
function toPostgres(type: ParsedType, context: TypeMappingContext): TypeMapping {
  if (context.json === true) return { dataType: 'jsonb' };
  const unsigned = type.unsigned === true;
  switch (type.name) {
    case 'tinyint':
      if (type.displayWidth === 1) {
        return { dataType: 'boolean', note: 'tinyint(1) is read as a boolean: 0 is false' };
      }
      return { dataType: 'smallint' };
    case 'smallint':
      return { dataType: unsigned ? 'integer' : 'smallint' };
    case 'mediumint':
      return { dataType: 'integer' };
    case 'int':
      return { dataType: unsigned ? 'bigint' : 'integer' };
    case 'bigint':
      return unsigned
        ? { dataType: 'numeric(20,0)', note: 'bigint unsigned needs numeric(20,0)' }
        : { dataType: 'bigint' };
    case 'decimal':
      return {
        dataType: formatType(
          { name: 'numeric', precision: type.precision ?? 10, scale: type.scale ?? 0 },
          'postgres',
        ),
      };
    case 'float':
      return { dataType: 'real' };
    case 'double':
      return { dataType: 'double precision' };
    case 'bit':
      if ((type.length ?? 1) === 1) return { dataType: 'boolean' };
      return (type.length ?? 1) <= 63
        ? { dataType: 'bigint', note: 'Bits are copied as their integer value' }
        : { dataType: 'numeric(20,0)', note: 'Bits are copied as their integer value' };
    case 'year':
      return { dataType: 'smallint' };
    case 'char':
      return { dataType: `character(${type.length ?? 1})` };
    case 'varchar':
      return { dataType: `character varying(${type.length ?? 255})` };
    case 'tinytext':
    case 'text':
    case 'mediumtext':
    case 'longtext':
      return { dataType: 'text' };
    case 'binary':
    case 'varbinary':
    case 'tinyblob':
    case 'blob':
    case 'mediumblob':
    case 'longblob':
    case 'vector':
      return { dataType: 'bytea' };
    case 'date':
      return { dataType: 'date' };
    case 'datetime':
      return {
        dataType: formatType(
          { name: 'timestamp without time zone', fsp: type.fsp ?? 0 },
          'postgres',
        ),
      };
    case 'timestamp':
      return {
        dataType: formatType({ name: 'timestamp with time zone', fsp: type.fsp ?? 0 }, 'postgres'),
      };
    case 'time':
      return {
        dataType: formatType({ name: 'time without time zone', fsp: type.fsp ?? 0 }, 'postgres'),
        note: 'Times outside 00:00–24:00 fail; choose interval for durations',
      };
    case 'json':
      return { dataType: 'jsonb' };
    case 'enum': {
      const longest = Math.max(1, ...(type.values ?? []).map((v) => [...v].length));
      return {
        dataType: `character varying(${longest})`,
        note: `Enum labels: ${(type.values ?? []).join(', ')}`,
      };
    }
    case 'set':
      return { dataType: 'text', note: 'Sets are copied as comma-separated text' };
    case 'uuid':
      return { dataType: 'uuid' };
    case 'inet4':
    case 'inet6':
      return { dataType: 'inet' };
    case 'geometry':
    case 'point':
    case 'linestring':
    case 'polygon':
    case 'multipoint':
    case 'multilinestring':
    case 'multipolygon':
    case 'geometrycollection':
      return { dataType: 'text', read: 'wkt', note: 'Spatial values are copied as WKT' };
    default:
      return { dataType: 'text', read: 'text', note: `${type.name} is copied as text` };
  }
}

/** MySQL ↔ MariaDB: the same types, less what one of them lacks. */
function withinMysqlFamily(
  text: string,
  type: ParsedType,
  context: TypeMappingContext,
): TypeMapping {
  if (context.json === true) return { dataType: 'json' };
  if (context.to === 'mysql') {
    switch (type.name) {
      case 'uuid':
        return { dataType: 'char(36)' };
      case 'inet4':
        return { dataType: 'varchar(15)' };
      case 'inet6':
        return { dataType: 'varchar(39)' };
      default:
        return { dataType: text };
    }
  }
  if (type.name === 'vector') return { dataType: 'longblob' };
  return { dataType: text };
}

/**
 * The target type of a column moving from `context.from` to `context.to`. `dataType` is the
 * source column's type as its snapshot prints it.
 */
export function mapSqlType(dataType: string, context: TypeMappingContext): TypeMapping {
  const { from, to } = context;
  if (from === to) return { dataType };
  const type = parseType(dataType, from);
  if (type === undefined) {
    return mysqlFamily(to)
      ? { ...mysqlText(undefined, context.key === true), read: 'text', note: 'Copied as text' }
      : { dataType: 'text', read: 'text', note: 'Copied as text' };
  }
  if (from === 'postgres') return fromPostgres(type, context);
  if (to === 'postgres') return toPostgres(type, context);
  return withinMysqlFamily(dataType, type, context);
}

/** True when a target type holds whole numbers (identity and AUTO_INCREMENT are allowed). */
export function isIntegerType(dataType: string, dialect: SqlDialect): boolean {
  const type = parseType(dataType, dialect);
  if (type === undefined || (type.arrayDimensions ?? 0) > 0) return false;
  return dialect === 'postgres'
    ? ['smallint', 'integer', 'bigint'].includes(type.name)
    : ['tinyint', 'smallint', 'mediumint', 'int', 'bigint'].includes(type.name) &&
        type.displayWidth !== 1;
}

/** The SELECT expression that reads `column` (already quoted) in the given form. */
export function readExpression(form: ReadForm, column: string, dialect: SqlDialect): string {
  switch (form) {
    case 'json':
      return dialect === 'postgres' ? `to_json(${column})::text` : column;
    case 'numeric':
      return dialect === 'postgres' ? `${column}::numeric` : column;
    case 'wkt':
      return `ST_AsText(${column})`;
    case 'text':
      return dialect === 'postgres' ? `${column}::text` : column;
  }
}
