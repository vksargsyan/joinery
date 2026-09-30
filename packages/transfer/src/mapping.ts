import {
  JoineryError,
  tableDefSchema,
  type CellValue,
  type ColumnDef,
  type SqlDialect,
  type TableDef,
} from '@joinery/core';
import { canonicalType } from '@joinery/sync';

import type { DateOrder, InferredColumn } from './infer';
import { isJsonText, type SourceCell } from './types';

/**
 * Column mapping (spec §12): matching file columns to table columns, converting each cell to
 * what the target column takes, and inferring a table for "create a new table from the file".
 *
 * Conversions produce CellValues by the driver conventions (@joinery/core results.ts):
 * integers as number or bigint, decimals and dates as text, booleans as boolean, JSON as its
 * text, binary as Uint8Array. They validate what they transform and fail with a message that
 * names the value; everything else is left for the server to judge.
 */

/** One file column feeding one table column. */
export interface ColumnMapping {
  /** Source column name, as the reader reports it. */
  readonly source: string;
  /** Target column name, exactly as in the table. */
  readonly target: string;
}

/** Name folding for auto-match: case, spaces, underscores and hyphens do not count. */
export function matchKey(name: string): string {
  return name.toLowerCase().replace(/[\s_-]+/g, '');
}

/**
 * Pairs source columns with table columns: exact names first, then case-insensitive, then
 * ignoring spaces, underscores and hyphens. Each column is used at most once; unmatched
 * columns are left out (unmatched table columns get their defaults).
 */
export function autoMatch(
  sourceColumns: readonly string[],
  target: TableDef | readonly string[],
): ColumnMapping[] {
  const targets = Array.isArray(target)
    ? (target as readonly string[])
    : (target as TableDef).columns.map((c) => c.name);
  const mapping: ColumnMapping[] = [];
  const usedSources = new Set<string>();
  const usedTargets = new Set<string>();
  const passes: ((name: string) => string)[] = [
    (name) => name,
    (name) => name.toLowerCase(),
    matchKey,
  ];
  for (const fold of passes) {
    const byKey = new Map<string, string>();
    for (const name of targets) {
      if (usedTargets.has(name)) continue;
      const key = fold(name);
      if (!byKey.has(key)) byKey.set(key, name);
    }
    for (const source of sourceColumns) {
      if (usedSources.has(source)) continue;
      const name = byKey.get(fold(source));
      if (name === undefined || usedTargets.has(name)) continue;
      mapping.push({ source, target: name });
      usedSources.add(source);
      usedTargets.add(name);
    }
  }
  const order = new Map(sourceColumns.map((name, i) => [name, i]));
  return mapping.sort((a, b) => order.get(a.source)! - order.get(b.source)!);
}

// ---------------------------------------------------------------------------------------------
// Target kinds and conversions

export const TARGET_KINDS = [
  'integer',
  'decimal',
  'float',
  'boolean',
  'date',
  'time',
  'datetime',
  'timestamp',
  'json',
  'binary',
  'uuid',
  'text',
] as const;
/** What a conversion aims for; `text` also covers types passed through as text (arrays...). */
export type TargetKind = (typeof TARGET_KINDS)[number];

/** The conversion target for a column type as the snapshot writes it. */
export function targetKind(dataType: string, dialect: SqlDialect): TargetKind {
  const type = canonicalType(dataType, dialect);
  if (dialect === 'postgres') {
    if (type.endsWith('[]')) return 'text';
    const base = type.replace(/\(.*?\)/, '');
    switch (base) {
      case 'smallint':
      case 'integer':
      case 'bigint':
      case 'oid':
        return 'integer';
      case 'numeric':
        return 'decimal';
      case 'real':
      case 'double precision':
        return 'float';
      case 'boolean':
        return 'boolean';
      case 'date':
        return 'date';
      case 'json':
      case 'jsonb':
        return 'json';
      case 'bytea':
        return 'binary';
      case 'uuid':
        return 'uuid';
      case 'timestamp with time zone':
        return 'timestamp';
      case 'timestamp without time zone':
        return 'datetime';
      case 'time with time zone':
      case 'time without time zone':
        return 'time';
      default:
        return 'text';
    }
  }
  const base = type.replace(/\(.*?\)/, '').replace(/ (unsigned|zerofill)/g, '');
  switch (base) {
    case 'tinyint':
    case 'smallint':
    case 'mediumint':
    case 'int':
    case 'bigint':
    case 'year':
    case 'bit':
      return 'integer';
    case 'decimal':
      return 'decimal';
    case 'float':
    case 'double':
      return 'float';
    case 'date':
      return 'date';
    case 'datetime':
      return 'datetime';
    case 'timestamp':
      return 'timestamp';
    case 'time':
      return 'time';
    case 'json':
      return 'json';
    case 'uuid':
      return 'uuid';
    case 'binary':
    case 'varbinary':
    case 'tinyblob':
    case 'blob':
    case 'mediumblob':
    case 'longblob':
    case 'geometry':
    case 'point':
    case 'linestring':
    case 'polygon':
    case 'multipoint':
    case 'multilinestring':
    case 'multipolygon':
    case 'geometrycollection':
      return 'binary';
    default:
      return 'text';
  }
}

export interface ConversionOptions {
  /**
   * Empty or blank text becomes NULL for columns that cannot hold it: numbers, booleans,
   * dates, uuids, JSON from text sources (default true). Text and binary keep it.
   */
  readonly emptyAsNull?: boolean;
  /** How `03/04/2024` reads (default 'dmy'); ISO dates are always year-month-day. */
  readonly dateOrder?: DateOrder;
  /**
   * How text becomes binary: `auto` (default) reads `\x` or `0x` hex, then base64 (JSON
   * sources: base64 unless `\x`), then UTF-8; or always `hex`, `base64` or `utf8`.
   */
  readonly binaryFormat?: 'auto' | 'hex' | 'base64' | 'utf8';
  /** The source is JSON: strings are JSON strings, so a JSON column gets them quoted. */
  readonly jsonSource?: boolean;
  /**
   * The server version, for MySQL datetime literals: MySQL 8.0.19+ accepts UTC offsets and
   * keeps them; MariaDB and older MySQL get the value converted to UTC.
   */
  readonly serverVersion?: string;
}

/** A value a column cannot take; the importer adds the row and column. */
export class ConversionError extends Error {
  override readonly name = 'ConversionError';
}

/** Converts one source cell for one column. */
export type Converter = (value: SourceCell | undefined) => CellValue;

const INTEGER_RE = /^[+-]?\d+$/;
const NUMERIC_RE = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;
const SPECIAL_NUMERIC_RE = /^[+-]?(?:nan|inf|infinity)$/i;
const TRUE_WORDS = new Set(['true', 't', 'yes', 'y', 'on', '1']);
const FALSE_WORDS = new Set(['false', 'f', 'no', 'n', 'off', '0']);
const HEX_RE = /^(?:[0-9a-fA-F]{2})*$/;
const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function preview(value: string): string {
  return value.length > 40 ? `${value.slice(0, 40)}…` : value;
}

function fail(message: string): never {
  throw new ConversionError(message);
}

/** Integer text or number → number, or bigint beyond 2^53. */
function integerFromText(text: string): number | bigint {
  const n = Number(text);
  if (Number.isSafeInteger(n)) return n;
  return BigInt(text.replace(/^\+/, ''));
}

function toInteger(value: SourceCell): CellValue {
  if (typeof value === 'number') {
    if (Number.isInteger(value)) return value;
    return fail(`${value} is not an integer`);
  }
  if (typeof value === 'bigint') {
    return value >= -BigInt(Number.MAX_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)
      ? Number(value)
      : value;
  }
  if (typeof value === 'boolean') return value ? 1 : 0;
  const text = (isJsonText(value) ? value.$json : (value as string)).trim();
  if (INTEGER_RE.test(text)) return integerFromText(text);
  // 5.0 and 5e3 are integers written another way.
  const zeroFraction = /^([+-]?\d+)\.0*$/.exec(text);
  if (zeroFraction) return integerFromText(zeroFraction[1]!);
  if (NUMERIC_RE.test(text) && /e/i.test(text) && Number.isSafeInteger(Number(text))) {
    return Number(text);
  }
  const lower = text.toLowerCase();
  if (TRUE_WORDS.has(lower) && lower !== '1') return 1;
  if (FALSE_WORDS.has(lower) && lower !== '0') return 0;
  return fail(`"${preview(text)}" is not an integer`);
}

function toDecimal(value: SourceCell): CellValue {
  if (typeof value === 'number') {
    return Number.isFinite(value)
      ? String(value)
      : Number.isNaN(value)
        ? 'NaN'
        : value > 0
          ? 'Infinity'
          : '-Infinity';
  }
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'boolean') return value ? '1' : '0';
  const text = (isJsonText(value) ? value.$json : (value as string)).trim();
  if (NUMERIC_RE.test(text) || SPECIAL_NUMERIC_RE.test(text)) return text;
  return fail(`"${preview(text)}" is not a number`);
}

function toFloat(value: SourceCell): CellValue {
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'boolean') return value ? 1 : 0;
  const text = (isJsonText(value) ? value.$json : (value as string)).trim();
  if (NUMERIC_RE.test(text)) return Number(text);
  if (SPECIAL_NUMERIC_RE.test(text)) {
    const lower = text.toLowerCase();
    if (lower.includes('nan')) return Number.NaN;
    return lower.startsWith('-') ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY;
  }
  return fail(`"${preview(text)}" is not a number`);
}

function toBoolean(value: SourceCell): CellValue {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number' && (value === 0 || value === 1)) return value === 1;
  const text = String(isJsonText(value) ? value.$json : value)
    .trim()
    .toLowerCase();
  if (TRUE_WORDS.has(text)) return true;
  if (FALSE_WORDS.has(text)) return false;
  return fail(`"${preview(text)}" is not a boolean`);
}

const SLASH_DATE = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})(.*)$/;
const ISO_DATETIME =
  /^(\d{4}-\d{2}-\d{2})[T ](\d{1,2}:\d{2}(?::\d{2}(?:[.,]\d+)?)?)\s*(Z|[+-]\d{2}(?::?\d{2})?)?$/i;

/** Rewrites `03/04/2024[ time]` as ISO text for the given order. */
function isoDate(text: string, order: DateOrder): string {
  const m = SLASH_DATE.exec(text);
  if (!m || order === 'ymd') return text;
  const [a, b, year, rest] = [m[1]!, m[2]!, m[3]!, m[4]!];
  const [day, month] = order === 'dmy' ? [a, b] : [b, a];
  return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}${rest}`;
}

function pad(n: number, width = 2): string {
  return String(n).padStart(width, '0');
}

/** `Z`, `+05`, `+0530`, `+05:30` → minutes east of UTC. */
function offsetMinutes(zone: string): number {
  if (zone.toUpperCase() === 'Z') return 0;
  const sign = zone.startsWith('-') ? -1 : 1;
  const digits = zone.slice(1).replace(':', '');
  return sign * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2) || '0'));
}

function mysqlSupportsOffsets(version: string | undefined): boolean {
  if (version === undefined || /mariadb/i.test(version)) return false;
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!m) return false;
  const [major, minor, patch] = [Number(m[1]), Number(m[2]), Number(m[3])];
  return major > 8 || (major === 8 && (minor > 0 || patch >= 19));
}

/**
 * A MySQL/MariaDB datetime literal: `T` becomes a space; a UTC offset is kept in MySQL 8.0.19+
 * form (`+HH:MM`) or, where the server has no offsets, applied to give UTC wall-clock time.
 */
function mysqlDateTime(text: string, offsets: boolean): string {
  const m = ISO_DATETIME.exec(text);
  if (!m) return text;
  const [date, time, zone] = [m[1]!, m[2]!, m[3]];
  if (zone === undefined) return `${date} ${time}`;
  const minutes = offsetMinutes(zone);
  if (offsets) {
    const abs = Math.abs(minutes);
    return `${date} ${time}${minutes < 0 ? '-' : '+'}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
  }
  const [hms = '', fraction] = time.split(/[.,]/);
  const [h = '0', mi = '0', s = '0'] = hms.split(':');
  const [y, mo, d] = date.split('-').map(Number) as [number, number, number];
  const utc = new Date(Date.UTC(y, mo - 1, d, Number(h), Number(mi) - minutes, Number(s)));
  const year = utc.getUTCFullYear();
  const out = `${pad(year, 4)}-${pad(utc.getUTCMonth() + 1)}-${pad(utc.getUTCDate())} ${pad(utc.getUTCHours())}:${pad(utc.getUTCMinutes())}:${pad(utc.getUTCSeconds())}`;
  return fraction === undefined ? out : `${out}.${fraction}`;
}

function toTemporal(
  value: SourceCell,
  kind: 'date' | 'datetime' | 'timestamp' | 'time',
  dialect: SqlDialect,
  options: ConversionOptions,
): CellValue {
  if (typeof value !== 'string') {
    if (isJsonText(value)) return fail(`${preview(value.$json)} is not a ${kind}`);
    return fail(`${String(value)} is not a ${kind}`);
  }
  let text = value.trim();
  if (kind === 'time') return text;
  text = isoDate(text, options.dateOrder ?? 'dmy');
  if (dialect !== 'postgres' && kind !== 'date') {
    text = mysqlDateTime(text, mysqlSupportsOffsets(options.serverVersion));
  }
  return text;
}

function toJson(value: SourceCell, options: ConversionOptions): CellValue {
  if (isJsonText(value)) return value.$json;
  if (typeof value === 'string') return options.jsonSource === true ? JSON.stringify(value) : value;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return fail(`${value} cannot be stored as JSON`);
    return String(value);
  }
  return String(value);
}

function hexBytes(text: string): Uint8Array | undefined {
  const digits = text.replace(/^(?:\\x|0x)/i, '');
  return HEX_RE.test(digits) ? Uint8Array.from(Buffer.from(digits, 'hex')) : undefined;
}

function base64Bytes(text: string): Uint8Array | undefined {
  const compact = text.replace(/\s+/g, '');
  return BASE64_RE.test(compact) ? Uint8Array.from(Buffer.from(compact, 'base64')) : undefined;
}

function toBinary(value: SourceCell, options: ConversionOptions): CellValue {
  if (typeof value !== 'string') return fail('binary columns take hex or base64 text');
  const format = options.binaryFormat ?? 'auto';
  const text = value.trim();
  switch (format) {
    case 'hex':
      return hexBytes(text) ?? fail(`"${preview(text)}" is not hex`);
    case 'base64':
      return base64Bytes(text) ?? fail(`"${preview(text)}" is not base64`);
    case 'utf8':
      return new TextEncoder().encode(value);
    default: {
      if (/^\\x/i.test(text)) return hexBytes(text) ?? fail(`"${preview(text)}" is not hex`);
      if (options.jsonSource !== true && /^0x/i.test(text)) {
        const bytes = hexBytes(text);
        if (bytes !== undefined) return bytes;
      }
      return base64Bytes(text) ?? new TextEncoder().encode(value);
    }
  }
}

function toText(value: SourceCell): CellValue {
  if (typeof value === 'string') return value;
  if (isJsonText(value)) return value.$json;
  if (typeof value === 'number') return Object.is(value, -0) ? '0' : String(value);
  return String(value);
}

/** The converter for one target column. NULL stays NULL; see `emptyAsNull` for empty text. */
export function converterFor(
  column: Pick<ColumnDef, 'dataType' | 'name'>,
  dialect: SqlDialect,
  options: ConversionOptions = {},
): Converter {
  const kind = targetKind(column.dataType, dialect);
  // Empty text is a value for text and binary columns, and a JSON string for JSON sources.
  const emptyAsNull =
    options.emptyAsNull !== false &&
    kind !== 'text' &&
    kind !== 'binary' &&
    !(kind === 'json' && options.jsonSource === true);
  let convert: (value: SourceCell) => CellValue;
  switch (kind) {
    case 'integer':
      convert = toInteger;
      break;
    case 'decimal':
      convert = toDecimal;
      break;
    case 'float':
      convert = toFloat;
      break;
    case 'boolean':
      convert = toBoolean;
      break;
    case 'date':
    case 'datetime':
    case 'timestamp':
    case 'time':
      convert = (value) => toTemporal(value, kind, dialect, options);
      break;
    case 'json':
      convert = (value) => toJson(value, options);
      break;
    case 'binary':
      convert = (value) => toBinary(value, options);
      break;
    case 'uuid':
      convert = (value) => (typeof value === 'string' ? value.trim() : toText(value));
      break;
    default:
      convert = toText;
  }
  return (value) => {
    if (value === null || value === undefined) return null;
    if (emptyAsNull && typeof value === 'string' && value.trim() === '') return null;
    return convert(value);
  };
}

// ---------------------------------------------------------------------------------------------
// Create a table from the file

/** The column type a new table gets for an inferred column. */
export function sqlTypeFor(column: InferredColumn, dialect: SqlDialect): string {
  const pg = dialect === 'postgres';
  switch (column.type) {
    case 'boolean':
      return pg ? 'boolean' : 'tinyint(1)';
    case 'integer':
      return pg ? 'integer' : 'int';
    case 'bigint':
      return 'bigint';
    case 'decimal': {
      const scale = column.scale ?? 0;
      const precision = Math.max(column.precision ?? 1, scale, 1);
      if (pg) return precision > 1000 ? 'numeric' : `numeric(${precision},${scale})`;
      return precision > 65 || scale > 30 ? 'double' : `decimal(${precision},${scale})`;
    }
    case 'float':
      return pg ? 'double precision' : 'double';
    case 'date':
      return 'date';
    case 'timestamp': {
      const digits = column.fractionalDigits ?? 0;
      if (pg) {
        return column.withTimeZone === true
          ? 'timestamp with time zone'
          : 'timestamp without time zone';
      }
      return digits > 0 ? `datetime(${digits})` : 'datetime';
    }
    case 'uuid':
      return pg ? 'uuid' : 'char(36)';
    case 'json':
      return pg ? 'jsonb' : 'json';
    case 'time': {
      const digits = column.fractionalDigits ?? 0;
      return digits > 0 ? `time(${digits})` : 'time';
    }
    case 'binary':
      return pg ? 'bytea' : 'longblob';
    default: {
      if (pg) return 'text';
      if (column.maxLength <= 255) return 'varchar(255)';
      if (column.maxLength <= 16383) return 'text';
      if (column.maxLength <= 4194303) return 'mediumtext';
      return 'longtext';
    }
  }
}

export interface TableFromColumnsOptions {
  /** Name of the new table. */
  readonly name: string;
  readonly dialect: SqlDialect;
  /** Source columns that form the primary key (made NOT NULL). */
  readonly primaryKey?: readonly string[];
  /** Keep NOT NULL where the sample had no nulls (default false: every column nullable). */
  readonly notNullFromSample?: boolean;
  /** Override the type of some columns, by source column name. */
  readonly types?: Readonly<Record<string, string>>;
}

const MAX_NAME: Readonly<Record<SqlDialect, number>> = { postgres: 63, mysql: 64, mariadb: 64 };

/**
 * A table definition for importing a file into a new table, with the mapping from the file's
 * columns. Names are trimmed, cut to the engine's limit and made unique; render the table
 * with @joinery/sync's `renderTableStatements` (or run it with `createTable`).
 */
export function tableFromColumns(
  columns: readonly InferredColumn[],
  options: TableFromColumnsOptions,
): { table: TableDef; mapping: ColumnMapping[] } {
  const limit = MAX_NAME[options.dialect];
  const taken = new Set<string>();
  const mapping: ColumnMapping[] = [];
  const keys = new Set(options.primaryKey ?? []);
  const defs = columns.map((column, i) => {
    let base = column.name.trim() || `column${i + 1}`;
    base = [...base].slice(0, limit).join('');
    let name = base;
    for (let n = 2; taken.has(name.toLowerCase()); n++) {
      const suffix = `_${n}`;
      name = [...base].slice(0, limit - suffix.length).join('') + suffix;
    }
    taken.add(name.toLowerCase());
    mapping.push({ source: column.name, target: name });
    const key = keys.has(column.name);
    return {
      name,
      ordinal: i + 1,
      dataType: options.types?.[column.name] ?? sqlTypeFor(column, options.dialect),
      nullable: !key && (options.notNullFromSample !== true || column.nullable),
      default: null,
      autoIncrement: false,
    };
  });
  const missing = [...keys].filter((k) => !columns.some((c) => c.name === k));
  if (missing.length > 0) {
    throw new JoineryError({
      code: 'VALIDATION_FAILED',
      message: `Primary key column ${missing.map((m) => `"${m}"`).join(', ')} is not in the file`,
    });
  }
  const primaryKey =
    keys.size > 0
      ? {
          name: options.dialect === 'postgres' ? `${options.name}_pkey` : 'PRIMARY',
          columns: mapping.filter((m) => keys.has(m.source)).map((m) => m.target),
        }
      : undefined;
  const table = tableDefSchema.parse({
    name: options.name,
    columns: defs,
    ...(primaryKey !== undefined ? { primaryKey } : {}),
  });
  return { table, mapping };
}
