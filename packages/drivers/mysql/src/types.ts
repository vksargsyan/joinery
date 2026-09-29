import type { CellValue, ColumnKind, ColumnMeta } from '@joinery/core';
import { parseInteger, toBytes } from '@joinery/driver-sql-base';
import type { FieldPacket, TypeCast } from 'mysql2';

/**
 * MySQL / MariaDB value mapping and column metadata.
 *
 * With the connection options set in config.ts (dateStrings, bigNumberStrings, jsonStrings,
 * decimalNumbers off), mysql2 already returns dates, times, decimals and JSON as the server's
 * text, in both the text and the binary (prepared statement) protocol. The type cast finishes
 * the job: BIGINT becomes number or bigint, BIT becomes an integer, binary strings, BLOBs,
 * GEOMETRY and VECTOR become standalone Uint8Arrays. TINYINT(1) stays a number.
 */

/** Big-endian BIT(n) bytes → integer. */
export function bitsToInteger(bytes: Uint8Array): number | bigint {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value;
}

/** Finishes mysql2's decoding of one value (see the module comment). */
export function toCellValue(type: string, value: unknown): CellValue {
  if (value === null || value === undefined) return null;
  if (type === 'LONGLONG') {
    if (typeof value === 'string') return parseInteger(value);
    if (typeof value === 'number' || typeof value === 'bigint') return value;
  }
  if (type === 'BIT' && value instanceof Uint8Array) return bitsToInteger(value);
  if (value instanceof Uint8Array) return toBytes(value);
  if (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    typeof value === 'bigint'
  ) {
    return value;
  }
  return String(value);
}

export const mysqlTypeCast: TypeCast = (field, next): CellValue => {
  // Raw bytes: mysql2 would otherwise parse geometry into objects and vectors into arrays.
  if (field.type === 'GEOMETRY' || field.type === 'VECTOR') {
    const bytes = field.buffer();
    return bytes === null ? null : toBytes(bytes);
  }
  return toCellValue(field.type, next());
};

/** MySQL column type codes (protocol ColumnDefinition). */
const T = {
  DECIMAL: 0,
  TINY: 1,
  SHORT: 2,
  LONG: 3,
  FLOAT: 4,
  DOUBLE: 5,
  NULL: 6,
  TIMESTAMP: 7,
  LONGLONG: 8,
  INT24: 9,
  DATE: 10,
  TIME: 11,
  DATETIME: 12,
  YEAR: 13,
  NEWDATE: 14,
  VARCHAR: 15,
  BIT: 16,
  VECTOR: 242,
  JSON: 245,
  NEWDECIMAL: 246,
  ENUM: 247,
  SET: 248,
  TINY_BLOB: 249,
  MEDIUM_BLOB: 250,
  LONG_BLOB: 251,
  BLOB: 252,
  VAR_STRING: 253,
  STRING: 254,
  GEOMETRY: 255,
} as const;

const FLAG_NOT_NULL = 1;
const FLAG_UNSIGNED = 32;
const FLAG_ENUM = 256;
const FLAG_SET = 2048;
const BINARY_CHARSET = 63;
/** utf8mb3 collation ids; every other utf8 collation is utf8mb4. */
const UTF8MB3 = new Set([33, 76, 83, 223, ...Array.from({ length: 24 }, (_, i) => 192 + i)]);

function maxBytesPerChar(field: FieldPacket): number {
  const charset = field.characterSet ?? 0;
  switch (field.encoding) {
    case 'utf8':
      return UTF8MB3.has(charset) ? 3 : 4;
    case 'ucs2':
      return 2;
    case 'utf16':
    case 'utf16le':
    case 'utf32':
    case 'gb18030':
      return 4;
    case 'eucjp':
    case 'ujis':
      return 3;
    case 'big5':
    case 'gbk':
    case 'gb2312':
    case 'sjis':
    case 'cp932':
    case 'euckr':
      return 2;
    default:
      return 1;
  }
}

function chars(field: FieldPacket, binary: boolean): string {
  const bytes = field.columnLength ?? 0;
  const per = binary ? 1 : maxBytesPerChar(field);
  return bytes % per === 0 ? `(${bytes / per})` : '';
}

function flagsOf(field: FieldPacket): number {
  return typeof field.flags === 'number' ? field.flags : 0;
}

/** Native type name and kind for a result column, as far as the protocol tells. */
export function describeField(field: FieldPacket): { nativeType: string; kind: ColumnKind } {
  if (field.extendedFormat === 'json') return { nativeType: 'json', kind: 'json' };
  const extended = field.extendedTypeName;
  if (extended) {
    return {
      nativeType: extended,
      kind: extended === 'uuid' ? 'uuid' : extended.startsWith('inet') ? 'string' : 'geometry',
    };
  }
  const flags = flagsOf(field);
  const unsigned = flags & FLAG_UNSIGNED ? ' unsigned' : '';
  const binary = field.characterSet === BINARY_CHARSET;
  const length = field.columnLength ?? 0;
  const decimals = field.decimals;
  const fsp = decimals > 0 && decimals <= 6 ? `(${decimals})` : '';
  switch (field.columnType ?? field.type) {
    case T.TINY:
      return { nativeType: `tinyint${length === 1 ? '(1)' : ''}${unsigned}`, kind: 'integer' };
    case T.SHORT:
      return { nativeType: `smallint${unsigned}`, kind: 'integer' };
    case T.INT24:
      return { nativeType: `mediumint${unsigned}`, kind: 'integer' };
    case T.LONG:
      return { nativeType: `int${unsigned}`, kind: 'integer' };
    case T.LONGLONG:
      return { nativeType: `bigint${unsigned}`, kind: 'bigint' };
    case T.YEAR:
      return { nativeType: 'year', kind: 'integer' };
    case T.FLOAT:
      return { nativeType: `float${unsigned}`, kind: 'float' };
    case T.DOUBLE:
      return { nativeType: `double${unsigned}`, kind: 'float' };
    case T.DECIMAL:
    case T.NEWDECIMAL: {
      const precision = length - (decimals > 0 ? 1 : 0) - (unsigned ? 0 : 1);
      return { nativeType: `decimal(${precision},${decimals})${unsigned}`, kind: 'decimal' };
    }
    case T.DATE:
    case T.NEWDATE:
      return { nativeType: 'date', kind: 'date' };
    case T.TIME:
      return { nativeType: `time${fsp}`, kind: 'time' };
    case T.DATETIME:
      return { nativeType: `datetime${fsp}`, kind: 'datetime' };
    case T.TIMESTAMP:
      return { nativeType: `timestamp${fsp}`, kind: 'timestamp' };
    case T.BIT:
      return { nativeType: `bit(${length})`, kind: 'integer' };
    case T.JSON:
      return { nativeType: 'json', kind: 'json' };
    case T.GEOMETRY:
      return { nativeType: 'geometry', kind: 'geometry' };
    case T.VECTOR:
      return { nativeType: 'vector', kind: 'binary' };
    case T.NULL:
      return { nativeType: 'null', kind: 'unknown' };
    case T.ENUM:
      return { nativeType: 'enum', kind: 'enum' };
    case T.SET:
      return { nativeType: 'set', kind: 'enum' };
    case T.VARCHAR:
    case T.VAR_STRING:
      return binary
        ? { nativeType: `varbinary${chars(field, true)}`, kind: 'binary' }
        : { nativeType: `varchar${chars(field, false)}`, kind: 'string' };
    case T.STRING:
      if (flags & FLAG_ENUM) return { nativeType: 'enum', kind: 'enum' };
      if (flags & FLAG_SET) return { nativeType: 'set', kind: 'enum' };
      return binary
        ? { nativeType: `binary${chars(field, true)}`, kind: 'binary' }
        : { nativeType: `char${chars(field, false)}`, kind: 'string' };
    case T.TINY_BLOB:
    case T.MEDIUM_BLOB:
    case T.LONG_BLOB:
    case T.BLOB: {
      const size = binary ? length : length / maxBytesPerChar(field);
      const prefix =
        size <= 255 ? 'tiny' : size <= 65535 ? '' : size <= 16777215 ? 'medium' : 'long';
      return binary
        ? { nativeType: `${prefix}blob`, kind: 'binary' }
        : { nativeType: `${prefix}text`, kind: 'string' };
    }
    default:
      return { nativeType: 'unknown', kind: 'unknown' };
  }
}

/** ColumnMeta for a result column: type, and source table when the column comes from one. */
export function columnMeta(field: FieldPacket): ColumnMeta {
  const { nativeType, kind } = describeField(field);
  const meta: { -readonly [K in keyof ColumnMeta]: ColumnMeta[K] } = {
    name: field.name,
    nativeType,
    kind,
  };
  if (field.orgTable) {
    meta.table = field.orgTable;
    if (field.schema) meta.schema = field.schema;
    meta.nullable = (flagsOf(field) & FLAG_NOT_NULL) === 0;
  }
  return meta;
}
