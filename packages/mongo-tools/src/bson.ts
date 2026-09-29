import {
  Binary,
  BSONRegExp,
  BSONSymbol,
  Code,
  DBRef,
  Decimal128,
  Double,
  EJSON,
  Int32,
  Long,
  MaxKey,
  MinKey,
  ObjectId,
  Timestamp,
} from 'bson';
import { JoineryError } from '@joinery/core';

/**
 * The BSON value model shared by the renderer and the driver. Values are what
 * `EJSON.parse(text, { relaxed: false })` returns: numbers keep their BSON type as Int32, Double
 * and Long instances, dates are JS Dates, and the other BSON types are the `bson` package's
 * classes. Plain JS numbers (and RegExps) are accepted too, as the driver's default
 * deserialisation produces them.
 *
 * Values never cross a process boundary as objects: they travel as canonical Extended JSON v2
 * text (`toEjson`), which is lossless and structured-clone safe.
 */

export {
  Binary,
  BSONRegExp,
  BSONSymbol,
  Code,
  DBRef,
  Decimal128,
  Double,
  EJSON,
  Int32,
  Long,
  MaxKey,
  MinKey,
  ObjectId,
  Timestamp,
};
export { UUID } from 'bson';

/** A BSON document: an ordered map of field names to values. */
export interface BsonDocument {
  [key: string]: BsonValue;
}

export type BsonValue =
  | null
  | boolean
  | number
  | string
  | Date
  | RegExp
  | BsonDocument
  | BsonValue[]
  | ObjectId
  | Int32
  | Double
  | Long
  | Decimal128
  | Binary
  | Timestamp
  | MinKey
  | MaxKey
  | BSONRegExp
  | BSONSymbol
  | DBRef
  | Code;

/**
 * BSON type names as MongoDB's `$type` operator and `$jsonSchema` `bsonType` spell them, plus
 * `uuid` for binary subtype 4 (still `binData` to the server).
 */
export const BSON_TYPE_NAMES = [
  'double',
  'string',
  'object',
  'array',
  'binData',
  'uuid',
  'undefined',
  'objectId',
  'bool',
  'date',
  'null',
  'regex',
  'dbPointer',
  'javascript',
  'symbol',
  'int',
  'timestamp',
  'long',
  'decimal',
  'minKey',
  'maxKey',
] as const;
export type BsonTypeName = (typeof BSON_TYPE_NAMES)[number];

/** Display facts for a BSON type: the renderer's label, icon id and the server's type number. */
export interface BsonTypeInfo {
  readonly name: BsonTypeName;
  /** The name users know from the shell and Extended JSON, e.g. "ObjectId", "Int32". */
  readonly label: string;
  /** A symbolic icon id for the renderer's icon set. */
  readonly icon: string;
  /** The BSON element type number (`$type` accepts it). */
  readonly number: number;
  /** The value sorts and compares as a number. */
  readonly numeric: boolean;
}

export const BSON_TYPES: Readonly<Record<BsonTypeName, BsonTypeInfo>> = {
  double: { name: 'double', label: 'Double', icon: 'number', number: 1, numeric: true },
  string: { name: 'string', label: 'String', icon: 'string', number: 2, numeric: false },
  object: { name: 'object', label: 'Object', icon: 'object', number: 3, numeric: false },
  array: { name: 'array', label: 'Array', icon: 'array', number: 4, numeric: false },
  binData: { name: 'binData', label: 'Binary', icon: 'binary', number: 5, numeric: false },
  uuid: { name: 'uuid', label: 'UUID', icon: 'uuid', number: 5, numeric: false },
  undefined: { name: 'undefined', label: 'Undefined', icon: 'null', number: 6, numeric: false },
  objectId: { name: 'objectId', label: 'ObjectId', icon: 'key', number: 7, numeric: false },
  bool: { name: 'bool', label: 'Boolean', icon: 'boolean', number: 8, numeric: false },
  date: { name: 'date', label: 'Date', icon: 'date', number: 9, numeric: false },
  null: { name: 'null', label: 'Null', icon: 'null', number: 10, numeric: false },
  regex: { name: 'regex', label: 'Regular expression', icon: 'regex', number: 11, numeric: false },
  dbPointer: { name: 'dbPointer', label: 'DBPointer', icon: 'link', number: 12, numeric: false },
  javascript: { name: 'javascript', label: 'Code', icon: 'code', number: 13, numeric: false },
  symbol: { name: 'symbol', label: 'Symbol', icon: 'string', number: 14, numeric: false },
  int: { name: 'int', label: 'Int32', icon: 'number', number: 16, numeric: true },
  timestamp: { name: 'timestamp', label: 'Timestamp', icon: 'clock', number: 17, numeric: false },
  long: { name: 'long', label: 'Int64', icon: 'number', number: 18, numeric: true },
  decimal: { name: 'decimal', label: 'Decimal128', icon: 'number', number: 19, numeric: true },
  minKey: { name: 'minKey', label: 'MinKey', icon: 'bound', number: -1, numeric: false },
  maxKey: { name: 'maxKey', label: 'MaxKey', icon: 'bound', number: 127, numeric: false },
};

/** The `_bsontype` tag of a bson class instance, or undefined for anything else. */
export function bsonTag(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const tag: unknown = (value as { _bsontype?: unknown })._bsontype;
  return typeof tag === 'string' ? tag : undefined;
}

/** A plain document (not an array, Date, RegExp or bson class instance). */
export function isBsonDocument(value: unknown): value is BsonDocument {
  if (typeof value !== 'object' || value === null) return false;
  if (Array.isArray(value) || value instanceof Date || value instanceof RegExp) return false;
  return bsonTag(value) === undefined;
}

const INT32_MIN = -2147483648;
const INT32_MAX = 2147483647;

/** A JS number serialises as Int32 when it is an integer in range (and not -0), else Double. */
export function isInt32Number(value: number): boolean {
  return (
    Number.isInteger(value) && value >= INT32_MIN && value <= INT32_MAX && !Object.is(value, -0)
  );
}

/**
 * An integral JS number outside Int32 range that Extended JSON types as Int64 (a JS number is
 * typed the way `EJSON.stringify` types it, since values cross processes as Extended JSON).
 */
export function isInt64Number(value: number): boolean {
  return (
    Number.isInteger(value) &&
    !isInt32Number(value) &&
    !Object.is(value, -0) &&
    Math.abs(value) < 2 ** 63
  );
}

/** The BSON type of a value, as `$type` names it (UUIDs as `uuid`). */
export function bsonTypeOf(value: unknown): BsonTypeName {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  switch (typeof value) {
    case 'string':
      return 'string';
    case 'boolean':
      return 'bool';
    case 'number':
      return isInt32Number(value) ? 'int' : isInt64Number(value) ? 'long' : 'double';
    case 'bigint':
      return 'long';
    case 'object':
      break;
    default:
      return 'undefined';
  }
  if (Array.isArray(value)) return 'array';
  if (value instanceof Date) return 'date';
  if (value instanceof RegExp) return 'regex';
  switch (bsonTag(value)) {
    case undefined:
      return 'object';
    case 'ObjectId':
      return 'objectId';
    case 'Int32':
      return 'int';
    case 'Double':
      return 'double';
    case 'Long':
      return 'long';
    case 'Decimal128':
      return 'decimal';
    case 'Binary':
      return (value as Binary).sub_type === Binary.SUBTYPE_UUID ? 'uuid' : 'binData';
    case 'Timestamp':
      return 'timestamp';
    case 'MinKey':
      return 'minKey';
    case 'MaxKey':
      return 'maxKey';
    case 'BSONRegExp':
      return 'regex';
    case 'BSONSymbol':
      return 'symbol';
    case 'DBRef':
      return 'object';
    case 'Code':
      return 'javascript';
    default:
      return 'object';
  }
}

/** The server's `$type` / `bsonType` name: `uuid` is `binData` to the server. */
export function serverTypeName(type: BsonTypeName): Exclude<BsonTypeName, 'uuid'> {
  return type === 'uuid' ? 'binData' : type;
}

/**
 * Canonical Extended JSON v2 text of a value: lossless (Int32 vs Int64 vs Double, Decimal128,
 * dates, binary subtypes) and safe to send across processes.
 */
export function toEjson(value: unknown): string {
  return EJSON.stringify(value, { relaxed: false });
}

/**
 * Parses Extended JSON text (canonical or relaxed) into BSON values, keeping number types.
 * Malformed text fails with VALIDATION_FAILED naming `what` ("filter", "document"...).
 */
export function fromEjson(text: string, what = 'value'): BsonValue {
  try {
    return EJSON.parse(text, { relaxed: false }) as BsonValue;
  } catch (error) {
    throw new JoineryError(
      {
        code: 'VALIDATION_FAILED',
        message: `The ${what} is not valid Extended JSON: ${error instanceof Error ? error.message : String(error)}`,
      },
      { cause: error },
    );
  }
}
