import { QuerybaraError } from '@querybara/core';
import type {
  Binary,
  BSONRegExp,
  BSONSymbol,
  Code,
  DBRef,
  Decimal128,
  Double,
  Int32,
  Long,
  ObjectId,
  Timestamp,
} from 'bson';

import { bsonTag, bsonTypeOf, type BsonDocument, type BsonValue } from '../bson';
import type { QueryModel } from '../find-text';

/** The languages code export writes (spec §9, query tools). */
export type CodeLanguage = 'node' | 'python' | 'java' | 'csharp' | 'go' | 'php';

/**
 * A query to export: a find() or an aggregate() on a collection, in the data forms the rest of
 * this package uses. An `SqlTranslation` is one as it is.
 */
export type ExportTarget =
  | { readonly kind: 'find'; readonly collection: string; readonly query: QueryModel }
  | {
      readonly kind: 'aggregate';
      readonly collection: string;
      readonly pipeline: readonly BsonDocument[];
    };

export interface CodeExportOptions {
  /** The database the collection is in. */
  readonly database: string;
}

/** The environment variable every snippet reads the connection string from. */
export const URI_VARIABLE = 'MONGODB_URI';
export const URI_EXAMPLE = 'mongodb://localhost:27017';

/** A BSON value sorted by what each language has to write for it. */
export type Classified =
  | { readonly type: 'null' }
  | { readonly type: 'bool'; readonly value: boolean }
  | { readonly type: 'string'; readonly value: string }
  | { readonly type: 'int32'; readonly value: number }
  | { readonly type: 'int64'; readonly value: bigint }
  | { readonly type: 'double'; readonly value: number }
  | { readonly type: 'decimal'; readonly value: string }
  | { readonly type: 'objectId'; readonly hex: string }
  | { readonly type: 'date'; readonly date: Date }
  | {
      readonly type: 'binary';
      readonly subtype: number;
      readonly base64: string;
      readonly bytes: Uint8Array;
    }
  | { readonly type: 'uuid'; readonly uuid: string; readonly hex: string }
  | { readonly type: 'regex'; readonly pattern: string; readonly flags: string }
  | { readonly type: 'timestamp'; readonly t: number; readonly i: number }
  | { readonly type: 'minKey' }
  | { readonly type: 'maxKey' }
  | { readonly type: 'symbol'; readonly value: string }
  | { readonly type: 'code'; readonly code: string; readonly scope?: BsonDocument }
  | {
      readonly type: 'dbref';
      readonly collection: string;
      readonly id: BsonValue;
      readonly db?: string;
    }
  | { readonly type: 'document'; readonly entries: readonly (readonly [string, BsonValue])[] }
  | { readonly type: 'array'; readonly items: readonly BsonValue[] };

const REGEX_FLAGS = 'ilmsux';

/** BSON regular expression options: known flags only, sorted as BSON requires. */
function bsonRegexFlags(flags: string): string {
  return [...new Set(flags)]
    .filter((flag) => REGEX_FLAGS.includes(flag))
    .sort()
    .join('');
}

/** What a value is, for printing (numbers are typed as Extended JSON types them). */
export function classify(value: BsonValue): Classified {
  if (value === null || value === undefined) return { type: 'null' };
  switch (typeof value) {
    case 'boolean':
      return { type: 'bool', value };
    case 'string':
      return { type: 'string', value };
    case 'number': {
      const type = bsonTypeOf(value);
      if (type === 'int') return { type: 'int32', value };
      if (type === 'long') return { type: 'int64', value: BigInt(value) };
      return { type: 'double', value };
    }
    case 'bigint':
      return { type: 'int64', value: BigInt.asIntN(64, value) };
    default:
      break;
  }
  if (Array.isArray(value)) return { type: 'array', items: value };
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw new QuerybaraError({
        code: 'VALIDATION_FAILED',
        message: 'An invalid date cannot be exported',
      });
    }
    return { type: 'date', date: value };
  }
  if (value instanceof RegExp) {
    return { type: 'regex', pattern: value.source, flags: bsonRegexFlags(value.flags) };
  }
  switch (bsonTag(value)) {
    case undefined:
      return { type: 'document', entries: Object.entries(value as BsonDocument) };
    case 'ObjectId':
      return { type: 'objectId', hex: (value as ObjectId).toHexString() };
    case 'Int32':
      return { type: 'int32', value: (value as Int32).value };
    case 'Double':
      return { type: 'double', value: (value as Double).value };
    case 'Long':
      return { type: 'int64', value: (value as Long).toBigInt() };
    case 'Decimal128':
      return { type: 'decimal', value: (value as Decimal128).toString() };
    case 'Binary': {
      const binary = value as Binary;
      if (binary.sub_type === 4 && binary.length() === 16) {
        const hex = binary.toString('hex');
        const uuid = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
        return { type: 'uuid', uuid, hex };
      }
      return {
        type: 'binary',
        subtype: binary.sub_type,
        base64: binary.toString('base64'),
        bytes: binary.value(),
      };
    }
    case 'Timestamp': {
      const ts = value as Timestamp;
      return { type: 'timestamp', t: ts.t, i: ts.i };
    }
    case 'MinKey':
      return { type: 'minKey' };
    case 'MaxKey':
      return { type: 'maxKey' };
    case 'BSONRegExp': {
      const regex = value as BSONRegExp;
      return { type: 'regex', pattern: regex.pattern, flags: bsonRegexFlags(regex.options) };
    }
    case 'BSONSymbol':
      return { type: 'symbol', value: (value as BSONSymbol).value };
    case 'Code': {
      const code = value as Code;
      return code.scope === null || code.scope === undefined
        ? { type: 'code', code: code.code }
        : { type: 'code', code: code.code, scope: code.scope as BsonDocument };
    }
    case 'DBRef': {
      const ref = value as DBRef;
      const fields = ref.fields as BsonDocument;
      if (Object.keys(fields).length > 0) {
        // Extra fields only survive in the document form.
        const doc: BsonDocument = { $ref: ref.collection, $id: ref.oid as BsonValue };
        if (ref.db) doc['$db'] = ref.db;
        return { type: 'document', entries: [...Object.entries(doc), ...Object.entries(fields)] };
      }
      return {
        type: 'dbref',
        collection: ref.collection,
        id: ref.oid as BsonValue,
        ...(ref.db ? { db: ref.db } : {}),
      };
    }
    default:
      return { type: 'string', value: String(value) };
  }
}

/**
 * A string as the server will store it: BSON strings are UTF-8, so a lone UTF-16 surrogate
 * (which no other language's string literal can hold) becomes U+FFFD, as the drivers encode it.
 */
export function wellFormed(value: string): string {
  let out = '';
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        out += value[i]! + value[i + 1]!;
        i += 1;
        continue;
      }
      out += '�';
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      out += '�';
    } else {
      out += value[i]!;
    }
  }
  return out;
}

/** A character a string literal must escape: C0 and C1 controls, DEL, line separators, BOM. */
export function needsEscape(code: number): boolean {
  return (
    code < 0x20 ||
    (code >= 0x7f && code <= 0x9f) ||
    code === 0x2028 ||
    code === 0x2029 ||
    code === 0xfeff
  );
}

/**
 * A quoted string literal: `named` escapes (quote, backslash, `\n`...) first, then
 * `escape(code)` for any other character `needsEscape` flags. Lone surrogates become U+FFFD.
 */
export function quoteString(
  value: string,
  quote: string,
  named: Readonly<Record<string, string>>,
  escape: (code: number) => string,
): string {
  let out = quote;
  for (const char of wellFormed(value)) {
    const mapped = named[char];
    if (mapped !== undefined) out += mapped;
    else if (needsEscape(char.codePointAt(0)!)) out += escape(char.codePointAt(0)!);
    else out += char;
  }
  return out + quote;
}

export function hex4(code: number): string {
  return code.toString(16).padStart(4, '0');
}

/** A C-family double-quoted literal (Java, C#, Go): `\uXXXX` for other controls. */
export function quoteC(value: string): string {
  return quoteString(
    value,
    '"',
    { '"': '\\"', '\\': '\\\\', '\n': '\\n', '\r': '\\r', '\t': '\\t' },
    (code) => `\\u${hex4(code)}`,
  );
}

export interface ListLayout {
  /** Text before the items, e.g. `[` or `new BsonArray {`. */
  readonly open: string;
  readonly close: string;
  /** Opening text when the items go on separate lines (defaults to `open`). */
  readonly openMultiline?: string;
  /** Spaces inside the brackets on one line: `{ a }` rather than `{a}`. */
  readonly pad?: boolean;
  /** A comma after the last item on separate lines. */
  readonly trailingComma?: boolean;
}

/**
 * Lays out items on one line when they fit in `width` columns (counting `indent` per level and
 * `used` columns already on the line), else one per line indented one level deeper. Items must
 * be printed at `level + 1`; one containing a line break forces the multi-line form.
 */
export function layoutList(
  items: readonly string[],
  layout: ListLayout,
  indent: string,
  level: number,
  used = 0,
  width = 90,
): string {
  const pad = layout.pad ? ' ' : '';
  const inline = `${layout.open}${pad}${items.join(', ')}${pad}${layout.close}`;
  const column = indentWidth(indent) * level + used;
  if (items.length === 0) return `${layout.open}${layout.close}`;
  if (!items.some((item) => item.includes('\n')) && column + inline.length <= width) return inline;
  const inner = indent.repeat(level + 1);
  const body = items.map((item) => inner + item).join(',\n');
  return `${layout.openMultiline ?? layout.open}\n${body}${layout.trailingComma ? ',' : ''}\n${indent.repeat(level)}${layout.close}`;
}

export function indentWidth(indent: string): number {
  return indent === '\t' ? 4 : indent.length;
}

/** UTC date parts of a date (month 1-12). */
export function dateParts(date: Date): {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
  readonly millisecond: number;
} {
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
    hour: date.getUTCHours(),
    minute: date.getUTCMinutes(),
    second: date.getUTCSeconds(),
    millisecond: date.getUTCMilliseconds(),
  };
}

/** True when a Timestamp part fits a signed 32-bit int (some drivers take ints). */
export function fitsInt32(n: number): boolean {
  return n <= 0x7fffffff;
}

/** A Timestamp as one signed 64-bit value (t in the high word), for drivers that take a long. */
export function timestampLong(t: number, i: number): bigint {
  return BigInt.asIntN(64, (BigInt(t) << 32n) | BigInt(i));
}

/** Collation fields in the order `Collation` documents list them. */
export const COLLATION_FIELDS = [
  'locale',
  'caseLevel',
  'caseFirst',
  'strength',
  'numericOrdering',
  'alternate',
  'maxVariable',
  'normalization',
  'backwards',
] as const;

/** A collation document's known fields, as JS values (unknown fields are left out). */
export function collationFields(collation: BsonDocument): Map<string, string | number | boolean> {
  const out = new Map<string, string | number | boolean>();
  for (const name of COLLATION_FIELDS) {
    if (!(name in collation)) continue;
    const value = classify(collation[name]!);
    if (value.type === 'string' || value.type === 'bool') out.set(name, value.value);
    else if (value.type === 'int32' || value.type === 'double') out.set(name, value.value);
    else if (value.type === 'int64') out.set(name, Number(value.value));
  }
  return out;
}

/** A document that is present and has at least one field. */
export function hasContent(doc: BsonDocument | undefined): doc is BsonDocument {
  return doc !== undefined && Object.keys(doc).length > 0;
}
