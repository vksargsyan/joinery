import type { CellValue, ColumnKind, ColumnMeta } from '@querybara/core';
import { parseInteger } from '@querybara/driver-sql-base';
import type { CustomTypesConfig, FieldDef } from 'pg';

/**
 * PostgreSQL type OIDs, value parsing and column metadata.
 *
 * Every value arrives in text format. Parsers produce CellValues: int2/int4/oid as numbers,
 * int8 as number or bigint, float4/float8 as numbers (NaN and ±Infinity included), bool as
 * boolean, bytea as Uint8Array; everything else (numeric, dates, times, intervals, JSON, arrays,
 * ranges, composites) stays the server's text.
 */

type Parser = (text: string) => CellValue;

const identity: Parser = (text) => text;

/** Decodes bytea in either output format: hex (`\x0102`) or the legacy escape format. */
export function parseBytea(text: string): Uint8Array {
  if (text.startsWith('\\x')) return Uint8Array.from(Buffer.from(text.slice(2), 'hex'));
  const bytes: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    if (ch !== 0x5c) {
      bytes.push(ch);
    } else if (text[i + 1] === '\\') {
      bytes.push(0x5c);
      i++;
    } else {
      bytes.push(parseInt(text.slice(i + 1, i + 4), 8));
      i += 3;
    }
  }
  return Uint8Array.from(bytes);
}

const PARSERS: Readonly<Record<number, Parser>> = {
  16: (text) => text === 't',
  17: parseBytea,
  20: parseInteger,
  21: Number,
  23: Number,
  26: Number,
  700: Number,
  701: Number,
};

/** Per-client type parsers (pg `types` option): no global pg-types mutation. */
export const pgTypeParsers: CustomTypesConfig = {
  getTypeParser: ((oid: number) => PARSERS[oid] ?? identity) as CustomTypesConfig['getTypeParser'],
};

/** Built-in types: OID → [pg type name, kind]. Array types map to their element OID. */
const BUILTIN: Readonly<Record<number, readonly [string, ColumnKind]>> = {
  16: ['bool', 'boolean'],
  17: ['bytea', 'binary'],
  18: ['char', 'string'],
  19: ['name', 'string'],
  20: ['int8', 'bigint'],
  21: ['int2', 'integer'],
  23: ['int4', 'integer'],
  24: ['regproc', 'string'],
  25: ['text', 'string'],
  26: ['oid', 'integer'],
  28: ['xid', 'string'],
  29: ['cid', 'string'],
  114: ['json', 'json'],
  142: ['xml', 'string'],
  194: ['pg_node_tree', 'string'],
  600: ['point', 'geometry'],
  601: ['lseg', 'geometry'],
  602: ['path', 'geometry'],
  603: ['box', 'geometry'],
  604: ['polygon', 'geometry'],
  628: ['line', 'geometry'],
  650: ['cidr', 'string'],
  700: ['float4', 'float'],
  701: ['float8', 'float'],
  705: ['unknown', 'string'],
  718: ['circle', 'geometry'],
  774: ['macaddr8', 'string'],
  790: ['money', 'decimal'],
  829: ['macaddr', 'string'],
  869: ['inet', 'string'],
  1033: ['aclitem', 'string'],
  1042: ['bpchar', 'string'],
  1043: ['varchar', 'string'],
  1082: ['date', 'date'],
  1083: ['time', 'time'],
  1114: ['timestamp', 'datetime'],
  1184: ['timestamptz', 'timestamp'],
  1186: ['interval', 'interval'],
  1266: ['timetz', 'time'],
  1560: ['bit', 'string'],
  1562: ['varbit', 'string'],
  1700: ['numeric', 'decimal'],
  1790: ['refcursor', 'string'],
  2202: ['regprocedure', 'string'],
  2205: ['regclass', 'string'],
  2206: ['regtype', 'string'],
  2249: ['record', 'unknown'],
  2278: ['void', 'unknown'],
  2950: ['uuid', 'uuid'],
  3220: ['pg_lsn', 'string'],
  3614: ['tsvector', 'string'],
  3615: ['tsquery', 'string'],
  3802: ['jsonb', 'json'],
  3904: ['int4range', 'string'],
  3906: ['numrange', 'string'],
  3908: ['tsrange', 'string'],
  3910: ['tstzrange', 'string'],
  3912: ['daterange', 'string'],
  3926: ['int8range', 'string'],
  4072: ['jsonpath', 'string'],
};

/** Built-in array OID → element OID. */
const BUILTIN_ARRAYS: Readonly<Record<number, number>> = {
  143: 142,
  199: 114,
  651: 650,
  1000: 16,
  1001: 17,
  1002: 18,
  1003: 19,
  1005: 21,
  1007: 23,
  1009: 25,
  1014: 1042,
  1015: 1043,
  1016: 20,
  1017: 600,
  1021: 700,
  1022: 701,
  1028: 26,
  1040: 829,
  1041: 869,
  1115: 1114,
  1182: 1082,
  1183: 1083,
  1185: 1184,
  1187: 1186,
  1231: 1700,
  1270: 1266,
  1561: 1560,
  1563: 1562,
  2951: 2950,
  3807: 3802,
  3905: 3904,
};

/** A non-built-in type, looked up from pg_type. */
export interface TypeInfo {
  readonly name: string;
  readonly kind: ColumnKind;
}

/** A relation a result column comes from, looked up from pg_class. */
export interface RelationInfo {
  readonly schema: string;
  readonly table: string;
  /** attnums with NOT NULL. */
  readonly notNull: ReadonlySet<number>;
}

/** Whether column metadata for this OID needs a catalog lookup. */
export function isBuiltinType(oid: number): boolean {
  return oid in BUILTIN || oid in BUILTIN_ARRAYS;
}

/** ColumnKind for a pg_type category (typcategory) and type name. */
export function kindForCategory(category: string, typtype: string, name: string): ColumnKind {
  if (typtype === 'e') return 'enum';
  if (name === 'geometry' || name === 'geography') return 'geometry';
  switch (category) {
    case 'A':
      return 'array';
    case 'B':
      return 'boolean';
    case 'D':
      return 'datetime';
    case 'E':
      return 'enum';
    case 'G':
      return 'geometry';
    case 'N':
      return 'decimal';
    case 'S':
    case 'I':
    case 'R':
    case 'V':
      return 'string';
    case 'T':
      return 'interval';
    default:
      return 'unknown';
  }
}

/** The type modifier suffix for built-ins that carry one: varchar(255), numeric(10,2)... */
function modifier(oid: number, typmod: number): string {
  if (typmod < 0) return '';
  switch (oid) {
    case 1042:
    case 1043:
      return `(${typmod - 4})`;
    case 1560:
    case 1562:
      return `(${typmod})`;
    case 1700: {
      const mod = typmod - 4;
      return `(${(mod >> 16) & 0xffff},${mod & 0xffff})`;
    }
    case 1083:
    case 1114:
    case 1184:
    case 1266:
      return `(${typmod})`;
    default:
      return '';
  }
}

/**
 * Column metadata for one result field. `types` and `relations` hold lookups for non-built-in
 * type OIDs and for source tables; missing entries degrade to `unknown` / no table.
 */
export function columnMeta(
  field: FieldDef,
  types: ReadonlyMap<number, TypeInfo>,
  relations: ReadonlyMap<number, RelationInfo>,
): ColumnMeta {
  const oid = field.dataTypeID;
  let nativeType: string;
  let kind: ColumnKind;
  const builtin = BUILTIN[oid];
  const element = BUILTIN_ARRAYS[oid];
  if (builtin) {
    nativeType = builtin[0] + modifier(oid, field.dataTypeModifier);
    kind = builtin[1];
  } else if (element !== undefined) {
    nativeType = `${BUILTIN[element]![0]}${modifier(element, field.dataTypeModifier)}[]`;
    kind = 'array';
  } else {
    const info = types.get(oid);
    nativeType = info?.name ?? `oid:${oid}`;
    kind = info?.kind ?? 'unknown';
  }
  const meta: { -readonly [K in keyof ColumnMeta]: ColumnMeta[K] } = {
    name: field.name,
    nativeType,
    kind,
  };
  const relation = field.tableID ? relations.get(field.tableID) : undefined;
  if (relation) {
    meta.table = relation.table;
    meta.schema = relation.schema;
    if (field.columnID > 0) meta.nullable = !relation.notNull.has(field.columnID);
  }
  return meta;
}
