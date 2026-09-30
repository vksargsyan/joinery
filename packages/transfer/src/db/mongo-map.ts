import { atLeast, type CellValue, type SqlDialect } from '@joinery/core';
import {
  Binary,
  Decimal128,
  EJSON,
  Int32,
  Long,
  ObjectId,
  UUID,
  bsonTag,
  bsonTypeOf,
  isBsonDocument,
  type BsonTypeName,
  type BsonValue,
  type SchemaAnalysis,
  type SchemaField,
} from '@joinery/mongo-tools';
import { parseType } from '@joinery/sync';

import { ConversionError, targetKind } from '../mapping';
import { jsonText, type SourceCell } from '../types';
import { UniqueNames, safeColumnName } from './names';
import type { ColumnOverride, FieldShape, PlannedColumn } from './spec';
import { hexText } from './values';

/**
 * The document ↔ row mapping (spec §12). SQL → MongoDB: one document per row with typed
 * values (integers as Int32/Int64, decimals as Decimal128, dates as dates, binary as BinData,
 * JSON columns as documents), optionally with child rows embedded as arrays of sub-documents.
 * MongoDB → SQL: nested fields flatten to columns (`address.city` → `address_city`), arrays
 * become child tables with a parent key or JSON columns, as chosen per field, with types
 * inferred from a sample (`@joinery/mongo-tools` schema analysis).
 */

// ---------------------------------------------------------------------------------------------
// SQL → MongoDB

/** The BSON types a SQL column can be written as. `json` parses JSON text into documents. */
export const MONGO_FIELD_TYPES = [
  'string',
  'int',
  'long',
  'double',
  'decimal',
  'bool',
  'date',
  'binData',
  'uuid',
  'objectId',
  'json',
] as const;
export type MongoFieldType = (typeof MONGO_FIELD_TYPES)[number];

export function isMongoFieldType(value: string): value is MongoFieldType {
  return (MONGO_FIELD_TYPES as readonly string[]).includes(value);
}

/** The BSON type a SQL column's values get by default. */
export function mongoFieldType(dataType: string, dialect: SqlDialect): MongoFieldType {
  const type = parseType(dataType, dialect);
  if (type !== undefined && (type.arrayDimensions ?? 0) > 0) return 'json';
  if (dialect !== 'postgres' && type !== undefined) {
    if (
      (type.name === 'tinyint' && type.displayWidth === 1) ||
      (type.name === 'bit' && (type.length ?? 1) === 1)
    ) {
      return 'bool';
    }
    if (type.name === 'bigint' && type.unsigned === true) return 'decimal';
    if (type.name === 'int' && type.unsigned === true) return 'long';
    if (type.name === 'bit' || type.name === 'year') return type.name === 'year' ? 'int' : 'long';
  }
  switch (targetKind(dataType, dialect)) {
    case 'integer':
      return type !== undefined && /^(big|int8)/.test(type.name) ? 'long' : 'int';
    case 'decimal':
      return 'decimal';
    case 'float':
      return 'double';
    case 'boolean':
      return 'bool';
    case 'date':
    case 'datetime':
    case 'timestamp':
      return 'date';
    case 'json':
      return 'json';
    case 'binary':
      return type !== undefined && /geometry|point|polygon|linestring/.test(type.name)
        ? 'string'
        : 'binData';
    case 'uuid':
      return 'uuid';
    default:
      return 'string';
  }
}

const INT32_MIN = -2147483648;
const INT32_MAX = 2147483647;
const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;

function fail(message: string): never {
  throw new ConversionError(message);
}

function text(value: CellValue): string {
  if (value instanceof Uint8Array) return hexText(value);
  if (typeof value === 'object' && value !== null) fail('A large value was only previewed');
  return String(value);
}

function toLong(value: CellValue): Long {
  let big: bigint;
  if (typeof value === 'bigint') big = value;
  else if (typeof value === 'number' && Number.isInteger(value)) big = BigInt(value);
  else if (typeof value === 'string' && /^[+-]?\d+$/.test(value.trim())) big = BigInt(value.trim());
  else if (typeof value === 'boolean') big = value ? 1n : 0n;
  else return fail(`${text(value)} is not an integer`);
  if (big < INT64_MIN || big > INT64_MAX) fail(`${big} does not fit in a 64-bit integer`);
  return Long.fromBigInt(big);
}

/** SQL date and time text (the sessions run in UTC) as a Date. */
function toDate(value: CellValue): Date | null {
  if (typeof value !== 'string') {
    if (typeof value === 'number') return new Date(value);
    return fail(`${text(value)} is not a date`);
  }
  let t = value.trim();
  if (/^0000-00-00/.test(t)) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) t = `${t}T00:00:00Z`;
  else {
    t = t.replace(' ', 'T');
    const zone = /([+-]\d{2})(:?\d{2})?$/.exec(t);
    if (zone) t = `${t.slice(0, zone.index)}${zone[1]}:${(zone[2] ?? '00').replace(':', '')}`;
    else if (!/z$/i.test(t)) t = `${t}Z`;
  }
  const date = new Date(t);
  return Number.isNaN(date.getTime()) ? fail(`"${value}" is not a date`) : date;
}

/** One SQL cell as a BSON value of the given type. NULL stays null. */
export function toBsonValue(value: CellValue, type: MongoFieldType): BsonValue {
  if (value === null) return null;
  switch (type) {
    case 'string':
      return text(value);
    case 'int': {
      if (
        typeof value === 'number' &&
        Number.isInteger(value) &&
        value >= INT32_MIN &&
        value <= INT32_MAX
      ) {
        return new Int32(value);
      }
      if (typeof value === 'boolean') return new Int32(value ? 1 : 0);
      const long = toLong(value);
      return long.greaterThan(INT32_MAX) || long.lessThan(INT32_MIN)
        ? long
        : new Int32(long.toNumber());
    }
    case 'long':
      return toLong(value);
    case 'double': {
      const n = typeof value === 'number' ? value : Number(text(value));
      return Number.isNaN(n) && !/nan/i.test(text(value))
        ? fail(`${text(value)} is not a number`)
        : n;
    }
    case 'decimal':
      try {
        return Decimal128.fromString(text(value).trim());
      } catch {
        return fail(`${text(value)} does not fit in a Decimal128`);
      }
    case 'bool':
      if (typeof value === 'boolean') return value;
      if (typeof value === 'number') return value !== 0;
      if (typeof value === 'bigint') return value !== 0n;
      if (/^(t|true|1|y|yes)$/i.test(text(value))) return true;
      if (/^(f|false|0|n|no)$/i.test(text(value))) return false;
      return fail(`${text(value)} is not a boolean`);
    case 'date':
      return toDate(value);
    case 'binData':
      return new Binary(
        value instanceof Uint8Array ? value : new TextEncoder().encode(text(value)),
      );
    case 'uuid':
      if (value instanceof Uint8Array && value.length === 16) return new UUID(value);
      try {
        return new UUID(text(value).trim());
      } catch {
        return fail(`${text(value)} is not a UUID`);
      }
    case 'objectId':
      return ObjectId.isValid(text(value))
        ? new ObjectId(text(value))
        : fail(`${text(value)} is not an ObjectId`);
    case 'json':
      try {
        return JSON.parse(text(value)) as BsonValue;
      } catch {
        return fail(`${text(value).slice(0, 40)} is not JSON`);
      }
  }
}

// ---------------------------------------------------------------------------------------------
// MongoDB → SQL

/** A column of a flattened table. */
export interface FlatColumn {
  /** Where the value is: field names from the document (or array element) root. */
  readonly path: readonly string[];
  readonly name: string;
  readonly dataType: string;
  /** Copied as JSON text (a sub-document or array kept whole). */
  readonly json: boolean;
  readonly nullable: boolean;
}

/** A target table: the collection's own, or a child table for an array field. */
export interface FlatTable {
  readonly name: string;
  /** `orders`, or `orders.items` for a child table. */
  readonly source: string;
  /** Child tables: the array's path in the parent document. */
  readonly arrayPath?: readonly string[];
  /** Child tables: the parent key column (the parent's `_id`) and the position column. */
  readonly parentKey?: string;
  readonly position?: string;
  /** Child tables of scalar arrays: the element is the value column. */
  readonly scalarElements?: boolean;
  readonly columns: readonly FlatColumn[];
  readonly primaryKey: readonly string[];
  readonly planned: readonly PlannedColumn[];
}

export interface FlattenOptions {
  readonly collection: string;
  /** The main table's name. */
  readonly table: string;
  readonly dialect: SqlDialect;
  readonly targetVersion?: string;
  readonly overrides?: readonly ColumnOverride[];
}

/** Non-null types of a field, most frequent first. */
function typesOf(field: SchemaField): BsonTypeName[] {
  return field.types.map((t) => t.type).filter((t) => t !== 'null' && t !== 'undefined');
}

function typeLabel(field: SchemaField): string {
  const types = field.types.map((t) => t.type);
  return types.length === 0 ? 'null' : types.join('|');
}

/** The SQL type for values of these BSON types; `json` when they are kept as JSON. */
export function sqlTypeForBson(
  types: readonly BsonTypeName[],
  dialect: SqlDialect,
  options: { readonly key?: boolean; readonly targetVersion?: string } = {},
): { readonly dataType: string; readonly json: boolean } {
  const pg = dialect === 'postgres';
  const set = new Set(types);
  const only = (...allowed: BsonTypeName[]): boolean =>
    set.size > 0 && [...set].every((t) => allowed.includes(t));
  const textType = options.key === true ? (pg ? 'text' : 'varchar(255)') : pg ? 'text' : 'longtext';
  if (set.size === 0) return { dataType: textType, json: false };
  if (only('int')) return { dataType: pg ? 'integer' : 'int', json: false };
  if (only('int', 'long')) return { dataType: 'bigint', json: false };
  if (only('int', 'long', 'double'))
    return { dataType: pg ? 'double precision' : 'double', json: false };
  if (only('int', 'long', 'double', 'decimal')) {
    return { dataType: pg ? 'numeric' : 'decimal(65,30)', json: false };
  }
  if (only('bool')) return { dataType: pg ? 'boolean' : 'tinyint(1)', json: false };
  if (only('date')) {
    return { dataType: pg ? 'timestamp(3) with time zone' : 'datetime(3)', json: false };
  }
  if (only('objectId')) return { dataType: pg ? 'character(24)' : 'char(24)', json: false };
  if (only('uuid')) {
    const native =
      pg ||
      (dialect === 'mariadb' &&
        options.targetVersion !== undefined &&
        atLeast(options.targetVersion, '10.7'));
    return { dataType: pg ? 'uuid' : native ? 'uuid' : 'char(36)', json: false };
  }
  if (only('binData', 'uuid')) return { dataType: pg ? 'bytea' : 'longblob', json: false };
  if (only('string', 'symbol')) return { dataType: textType, json: false };
  if (set.has('object') || set.has('array')) return { dataType: pg ? 'jsonb' : 'json', json: true };
  return { dataType: textType, json: false };
}

/**
 * The tables a collection flattens into, from a schema analysis of a sample. Sub-documents
 * become columns (unless their field is set to `json`), arrays of sub-documents become child
 * tables and arrays of scalars JSON columns (each field can be switched to the other).
 * Fields whose types are mixed (a sub-document here, a string there) are kept as JSON, so no
 * value is lost.
 */
export function flattenCollection(analysis: SchemaAnalysis, options: FlattenOptions): FlatTable[] {
  const { dialect } = options;
  const overrides = new Map((options.overrides ?? []).map((o) => [o.source, o]));
  const tableNames = new UniqueNames(dialect, [options.table]);
  const children: FlatTable[] = [];
  const idField = analysis.fields.find((f) => f.name === '_id');
  const idType = idField
    ? sqlTypeForBson(typesOf(idField), dialect, {
        key: true,
        ...(options.targetVersion ? { targetVersion: options.targetVersion } : {}),
      })
    : { dataType: dialect === 'postgres' ? 'character(24)' : 'char(24)', json: false };
  const idOverride = overrides.get('_id');
  const idDataType = idOverride?.dataType?.trim() || idType.dataType;

  interface Builder {
    readonly names: UniqueNames;
    readonly columns: FlatColumn[];
    readonly planned: PlannedColumn[];
    /** Child tables name columns from the element: `items[].sku` is `sku`. */
    readonly strip: string;
  }

  const column = (
    builder: Builder,
    field: SchemaField,
    path: readonly string[],
    display: string,
    json: boolean,
    key: boolean,
  ): void => {
    const override = overrides.get(display);
    const inferred = json
      ? { dataType: dialect === 'postgres' ? 'jsonb' : 'json', json: true }
      : sqlTypeForBson(typesOf(field), dialect, {
          key,
          ...(options.targetVersion ? { targetVersion: options.targetVersion } : {}),
        });
    const requested = override?.dataType?.trim();
    const dataType = requested !== undefined && requested !== '' ? requested : inferred.dataType;
    const relative =
      builder.strip !== '' && display.startsWith(builder.strip)
        ? display.slice(builder.strip.length)
        : display;
    const name = builder.names.claim(override?.target?.trim() || safeColumnName(relative, dialect));
    const skipped = override?.skip === true && !key;
    const nullable = !key;
    builder.planned.push({
      source: display,
      target: name,
      sourceType: typeLabel(field),
      targetType: dataType,
      defaultType: inferred.dataType,
      nullable,
      key,
      editable: true,
      skipped,
      ...(json && (typesOf(field).includes('object') || typesOf(field).includes('array'))
        ? { shape: 'json' as FieldShape }
        : {}),
      ...(inferred.json && !json ? { note: 'Mixed types: kept as JSON' } : {}),
    });
    if (skipped) return;
    builder.columns.push({ path, name, dataType, json: inferred.json, nullable });
  };

  const walk = (
    builder: Builder,
    fields: readonly SchemaField[],
    path: readonly string[],
    display: string,
    depth: number,
  ): void => {
    for (const field of fields) {
      if (depth === 0 && field.name === '_id') continue;
      const fieldPath = [...path, field.name];
      const fieldDisplay = display === '' ? field.name : `${display}.${field.name}`;
      const types = typesOf(field);
      const override = overrides.get(fieldDisplay);
      const onlyObject =
        types.length > 0 && types.every((t) => t === 'object') && field.fields.length > 0;
      const onlyArray = types.length > 0 && types.every((t) => t === 'array');
      if (onlyArray) {
        const items = field.items;
        const itemTypes = items ? typesOf(items) : [];
        const documents =
          itemTypes.length > 0 &&
          itemTypes.every((t) => t === 'object') &&
          (items?.fields.length ?? 0) > 0;
        const shape: FieldShape = override?.shape ?? (documents && depth === 0 ? 'child' : 'json');
        if (shape === 'child' && depth === 0 && override?.skip !== true && items !== undefined) {
          builder.planned.push({
            source: fieldDisplay,
            target: '',
            sourceType: typeLabel(field),
            targetType: '',
            defaultType: '',
            nullable: true,
            key: false,
            editable: true,
            skipped: false,
            shape: 'child',
            note: 'A child table',
          });
          children.push(childTable(items, fieldPath, fieldDisplay, documents));
          continue;
        }
        column(builder, field, fieldPath, fieldDisplay, true, false);
        continue;
      }
      if (onlyObject && (override?.shape ?? 'columns') === 'columns' && override?.skip !== true) {
        builder.planned.push({
          source: fieldDisplay,
          target: '',
          sourceType: typeLabel(field),
          targetType: '',
          defaultType: '',
          nullable: true,
          key: false,
          editable: true,
          skipped: false,
          shape: 'columns',
          note: 'Flattened into columns',
        });
        walk(builder, field.fields, fieldPath, fieldDisplay, depth + 1);
        continue;
      }
      column(
        builder,
        field,
        fieldPath,
        fieldDisplay,
        onlyObject || override?.shape === 'json',
        false,
      );
    }
  };

  const childTable = (
    items: SchemaField,
    arrayPath: readonly string[],
    display: string,
    documents: boolean,
  ): FlatTable => {
    const name = tableNames.claim(
      overrides.get(display)?.target?.trim() ||
        `${options.table}_${safeColumnName(display, dialect)}`,
    );
    const builder: Builder = {
      names: new UniqueNames(dialect),
      columns: [],
      planned: [],
      strip: `${display}[].`,
    };
    const parentKey = builder.names.claim(`${options.table}_id`);
    const position = builder.names.claim('position');
    builder.planned.push(
      {
        source: `${display}[]._parent`,
        target: parentKey,
        sourceType: idField ? typeLabel(idField) : 'objectId',
        targetType: idDataType,
        defaultType: idDataType,
        nullable: false,
        key: true,
        editable: false,
        skipped: false,
        note: `The parent's _id`,
      },
      {
        source: `${display}[]._index`,
        target: position,
        sourceType: 'int',
        targetType: 'integer',
        defaultType: 'integer',
        nullable: false,
        key: true,
        editable: false,
        skipped: false,
        note: 'Position in the array, from 0',
      },
    );
    if (documents) {
      walk(builder, items.fields, [], `${display}[]`, 1);
    } else {
      column(builder, items, [], `${display}[]`, false, false);
      const last = builder.columns.at(-1);
      if (last !== undefined && last.name !== 'value') {
        // The element itself: named `value` unless the user renamed it.
        const override = overrides.get(`${display}[]`);
        if (override?.target === undefined) {
          builder.columns[builder.columns.length - 1] = {
            ...last,
            name: builder.names.claim('value'),
          };
          const planned = builder.planned.at(-1)!;
          builder.planned[builder.planned.length - 1] = {
            ...planned,
            target: builder.columns.at(-1)!.name,
          };
        }
      }
    }
    return {
      name,
      source: `${options.collection}.${display}`,
      arrayPath,
      parentKey,
      position,
      scalarElements: !documents,
      columns: [
        { path: [], name: parentKey, dataType: idDataType, json: false, nullable: false },
        {
          path: [],
          name: position,
          dataType: dialect === 'postgres' ? 'integer' : 'int',
          json: false,
          nullable: false,
        },
        ...builder.columns,
      ],
      primaryKey: [parentKey, position],
      planned: builder.planned,
    };
  };

  const main: Builder = { names: new UniqueNames(dialect), columns: [], planned: [], strip: '' };
  const idName = main.names.claim(idOverride?.target?.trim() || '_id');
  main.planned.push({
    source: '_id',
    target: idName,
    sourceType: idField ? typeLabel(idField) : 'objectId',
    targetType: idDataType,
    defaultType: idType.dataType,
    nullable: false,
    key: true,
    editable: true,
    skipped: false,
  });
  main.columns.push({
    path: ['_id'],
    name: idName,
    dataType: idDataType,
    json: idType.json,
    nullable: false,
  });
  walk(main, analysis.fields, [], '', 0);
  return [
    {
      name: options.table,
      source: options.collection,
      columns: main.columns,
      primaryKey: [idName],
      planned: main.planned,
    },
    ...children,
  ];
}

/** The value at a path of field names; undefined when a step is missing or not a document. */
export function valueAtPath(document: BsonValue, path: readonly string[]): BsonValue | undefined {
  let current: BsonValue | undefined = document;
  for (const name of path) {
    if (current === undefined || current === null || !isBsonDocument(current)) return undefined;
    current = Object.hasOwn(current, name) ? current[name] : undefined;
  }
  return current;
}

function relaxed(value: BsonValue): string {
  return EJSON.stringify(value, { relaxed: true });
}

/**
 * A BSON value as a cell for a SQL column: numbers stay numbers (Int64 beyond 2^53 as bigint),
 * Decimal128 as its exact text, dates as ISO-8601 UTC, ObjectIds as hex, UUIDs in their
 * canonical form, binary as hex; documents, arrays and other BSON types as relaxed Extended
 * JSON (JSON columns get them as JSON).
 */
export function bsonCell(value: BsonValue | undefined, json: boolean): SourceCell {
  if (value === undefined || value === null) return null;
  if (json) return jsonText(relaxed(value));
  switch (typeof value) {
    case 'string':
    case 'boolean':
    case 'number':
      return value;
    default:
      break;
  }
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new ConversionError('An invalid date');
    return value.toISOString();
  }
  switch (bsonTag(value)) {
    case 'Int32':
    case 'Double':
      return (value as Int32).value;
    case 'Long': {
      const long = value as Long;
      const big = long.toBigInt();
      return big >= BigInt(Number.MIN_SAFE_INTEGER) && big <= BigInt(Number.MAX_SAFE_INTEGER)
        ? Number(big)
        : big;
    }
    case 'Decimal128':
      return (value as Decimal128).toString();
    case 'ObjectId':
      return (value as ObjectId).toHexString();
    case 'Binary': {
      const binary = value as Binary;
      if (binary.sub_type === Binary.SUBTYPE_UUID && binary.length() === 16) {
        return binary.toUUID().toHexString(true);
      }
      return hexText(binary.value());
    }
    default:
      return bsonTypeOf(value) === 'object' || Array.isArray(value)
        ? jsonText(relaxed(value))
        : relaxed(value);
  }
}
