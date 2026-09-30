import {
  Binary,
  BSONRegExp,
  BSONSymbol,
  Code,
  DBRef,
  Decimal128,
  Double,
  Int32,
  Long,
  MaxKey,
  MinKey,
  ObjectId,
  Timestamp,
  UUID,
} from 'bson';

import { bsonTag, isBsonDocument, type BsonDocument, type BsonValue } from '../bson';
import { Lexer, type Token } from './lexer';

/**
 * A parser for values written the way mongosh accepts them: JavaScript object and array
 * literals with unquoted keys, single or double quotes, trailing commas and comments; the
 * shell's constructors (ObjectId, ISODate, new Date, NumberInt, NumberLong, NumberDecimal,
 * Double, UUID, BinData, Timestamp, MinKey, MaxKey, DBRef, Code...); regular expression
 * literals; and canonical or relaxed Extended JSON objects ({ "$oid": ... }). Nothing is
 * evaluated: there is no `eval` or `Function`, and anything beyond literals (variables,
 * arithmetic, function calls other than the constructors) is a parse error.
 *
 * Number typing, chosen to be lossless and to agree with Extended JSON:
 * - an integer literal is an Int32 when it fits, else an Int64 (Long), else a Double;
 * - a decimal point or an exponent makes a Double (`1.0` stays a Double, unlike in mongosh);
 * - `123n` is an Int64; NaN and Infinity are Doubles.
 *
 * Other choices: `undefined` becomes null (as the driver serialises it); `Date(...)` without
 * `new` builds a Date like `new Date(...)`; ISODate strings without a zone are UTC, while
 * `new Date("...")` follows JavaScript (date-times without a zone are local time).
 */

export interface ShellParseOptions {
  /** Deepest nesting of documents, arrays and calls; default 200. */
  readonly maxDepth?: number;
  /** The clock for ObjectId(), ISODate(), new Date() and UUID() without arguments. */
  readonly now?: () => Date;
}

const INT32_MIN = -2147483648n;
const INT32_MAX = 2147483647n;
const INT64_MIN = -9223372036854775808n;
const INT64_MAX = 9223372036854775807n;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const HEX = /^(?:[0-9a-fA-F]{2})*$/;
const REGEX_FLAGS = /^[imxslu]*$/;
const ISO_DATE =
  /^(\d{4})-?(\d{2})-?(\d{2})(?:[T ](\d{2})(?::?(\d{2})(?::?(\d{2})(?:\.(\d+))?)?)?(Z|([+-])(\d{2}):?(\d{2})?)?)?$/;
const EXTENDED_ISO_DATE = /^[+-]\d{6}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

interface Arg {
  readonly value: BsonValue;
  readonly start: number;
}

/** Normalises a regular expression's flags into BSON order, rejecting unsupported ones. */
function bsonFlags(flags: string): string | undefined {
  if (!REGEX_FLAGS.test(flags)) return undefined;
  return [...new Set(flags)].sort().join('');
}

/** An integer from a numeric BSON value, or undefined when it is not a whole number. */
function integerOf(value: BsonValue): bigint | undefined {
  if (typeof value === 'number') return Number.isInteger(value) ? BigInt(value) : undefined;
  switch (bsonTag(value)) {
    case 'Int32':
    case 'Double': {
      const n = (value as Int32 | Double).value;
      return Number.isInteger(n) ? BigInt(n) : undefined;
    }
    case 'Long':
      return (value as Long).toBigInt();
    default:
      return undefined;
  }
}

/** A JS number from a numeric BSON value. */
function numberOf(value: BsonValue): number | undefined {
  if (typeof value === 'number') return value;
  switch (bsonTag(value)) {
    case 'Int32':
    case 'Double':
      return (value as Int32 | Double).value;
    case 'Long':
      return (value as Long).toNumber();
    default:
      return undefined;
  }
}

function integerValue(n: bigint): BsonValue {
  if (n >= INT32_MIN && n <= INT32_MAX) return new Int32(Number(n));
  if (n >= INT64_MIN && n <= INT64_MAX) return Long.fromBigInt(n);
  return new Double(Number(n));
}

/**
 * Parses an ISO-8601 date as mongosh's ISODate does (a missing zone means UTC), plus the
 * extended-year form Date#toISOString prints. Returns undefined when invalid.
 */
export function parseIsoDate(text: string): Date | undefined {
  if (EXTENDED_ISO_DATE.test(text)) {
    const date = new Date(text);
    return Number.isNaN(date.getTime()) ? undefined : date;
  }
  const m = ISO_DATE.exec(text);
  if (!m) return undefined;
  const [, y, mo, d, h, mi, s, frac, zone, sign, zh, zm] = m;
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  const hour = Number(h ?? 0);
  const minute = Number(mi ?? 0);
  const second = Number(s ?? 0);
  const ms = frac ? Number(frac.slice(0, 3).padEnd(3, '0')) : 0;
  if (month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59 || second > 59) {
    return undefined;
  }
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, ms);
  if (date.getUTCDate() !== day || date.getUTCMonth() !== month - 1) return undefined;
  if (zone && zone !== 'Z') {
    const offset = (Number(zh) * 60 + Number(zm ?? 0)) * 60_000;
    date.setTime(date.getTime() - (sign === '-' ? -offset : offset));
  }
  return Number.isNaN(date.getTime()) ? undefined : date;
}

/** Defines a key as an own data property, so "__proto__" is a field like any other. */
function setField(doc: BsonDocument, key: string, value: BsonValue): void {
  if (key === '__proto__') {
    Object.defineProperty(doc, key, {
      value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  } else {
    doc[key] = value;
  }
}

interface Member {
  readonly key: string;
  readonly value: BsonValue;
}

export class ShellParser {
  readonly lexer: Lexer;
  private depth = 0;
  private readonly maxDepth: number;
  private readonly now: () => Date;

  constructor(
    readonly text: string,
    options: ShellParseOptions = {},
  ) {
    this.lexer = new Lexer(text);
    this.maxDepth = options.maxDepth ?? 200;
    this.now = options.now ?? (() => new Date());
  }

  fail(offset: number, reason: string, hint?: string): never {
    return this.lexer.fail(offset, reason, hint);
  }

  /** Consumes a punctuation token or fails with "Expected ...". */
  expect(punct: string, what = `'${punct}'`): Token {
    const token = this.lexer.next();
    if (token.kind !== 'punct' || token.value !== punct) this.unexpected(token, what);
    return token;
  }

  isPunct(token: Token, punct: string): boolean {
    return token.kind === 'punct' && token.value === punct;
  }

  unexpected(token: Token, expected: string): never {
    const found =
      token.kind === 'eof'
        ? 'the end of the text'
        : token.kind === 'string'
          ? 'a string'
          : token.kind === 'number'
            ? `the number ${token.value}`
            : token.kind === 'regex'
              ? 'a regular expression'
              : `'${token.value}'`;
    return this.fail(token.start, `Expected ${expected} but found ${found}`);
  }

  /** Skips optional semicolons and requires the end of the text. */
  expectEnd(): void {
    while (this.isPunct(this.lexer.peek(), ';')) this.lexer.next();
    const token = this.lexer.peek();
    if (token.kind !== 'eof') this.unexpected(token, 'the end of the text');
  }

  private enter(at: number): void {
    this.depth += 1;
    if (this.depth > this.maxDepth) {
      this.fail(at, `Nested more than ${this.maxDepth} levels deep`);
    }
  }

  parseValue(): BsonValue {
    const token = this.lexer.peek();
    switch (token.kind) {
      case 'punct':
        if (token.value === '{') return this.parseObject();
        if (token.value === '[') return this.parseArray();
        if (token.value === '-' || token.value === '+') return this.parseSigned();
        return this.unexpected(token, 'a value');
      case 'string':
        this.lexer.next();
        return token.value;
      case 'number':
        this.lexer.next();
        return this.numberLiteral(token, false);
      case 'regex': {
        this.lexer.next();
        const flags = bsonFlags(token.flags ?? '');
        if (flags === undefined) {
          this.fail(
            token.start,
            `Unsupported regular expression flags "${token.flags ?? ''}"`,
            'MongoDB supports the flags i, m, x, s, l and u',
          );
        }
        return new BSONRegExp(token.value, flags);
      }
      case 'ident':
        return this.parseIdentifier();
      case 'eof':
        return this.unexpected(token, 'a value');
    }
  }

  private parseSigned(): BsonValue {
    const sign = this.lexer.next();
    const negative = sign.value === '-';
    const token = this.lexer.next();
    if (token.kind === 'number') return this.numberLiteral(token, negative);
    if (token.kind === 'ident' && (token.value === 'Infinity' || token.value === 'NaN')) {
      const n = token.value === 'NaN' ? NaN : Infinity;
      return new Double(negative ? -n : n);
    }
    return this.unexpected(token, 'a number');
  }

  private numberLiteral(token: Token, negative: boolean): BsonValue {
    const raw = token.value;
    if (raw.endsWith('n')) {
      const n = BigInt(raw.slice(0, -1)) * (negative ? -1n : 1n);
      if (n < INT64_MIN || n > INT64_MAX)
        this.fail(token.start, 'The number is out of Int64 range');
      return Long.fromBigInt(n);
    }
    if (/^0[xob]/.test(raw)) return integerValue(BigInt(raw) * (negative ? -1n : 1n));
    if (raw.includes('.') || raw.includes('e')) {
      const n = Number(raw);
      return new Double(negative ? -n : n);
    }
    return integerValue(BigInt(raw) * (negative ? -1n : 1n));
  }

  private parseObject(): BsonValue {
    const open = this.expect('{');
    this.enter(open.start);
    const members: Member[] = [];
    const starts: number[] = [];
    for (;;) {
      const token = this.lexer.next();
      if (this.isPunct(token, '}')) break;
      let key: string;
      if (token.kind === 'ident' || token.kind === 'string') {
        key = token.value;
      } else if (token.kind === 'number' && !token.value.endsWith('n')) {
        key = String(Number(token.value));
      } else {
        this.unexpected(token, members.length === 0 ? "a field name or '}'" : 'a field name');
      }
      const colon = this.lexer.next();
      if (!this.isPunct(colon, ':')) {
        if (token.kind === 'ident' && this.isPunct(colon, '.')) {
          this.fail(token.start, 'Field names with dots must be quoted', `Write '${key}.…': …`);
        }
        this.unexpected(colon, "':'");
      }
      starts.push(token.start);
      members.push({ key, value: this.parseValue() });
      const after = this.lexer.next();
      if (this.isPunct(after, '}')) break;
      if (!this.isPunct(after, ',')) this.unexpected(after, "',' or '}'");
    }
    this.depth -= 1;
    return this.fromMembers(members, open.start);
  }

  private parseArray(): BsonValue[] {
    const open = this.expect('[');
    this.enter(open.start);
    const items: BsonValue[] = [];
    for (;;) {
      const token = this.lexer.peek();
      if (this.isPunct(token, ']')) {
        this.lexer.next();
        break;
      }
      if (this.isPunct(token, ',')) this.fail(token.start, 'Empty array elements are not allowed');
      items.push(this.parseValue());
      const after = this.lexer.next();
      if (this.isPunct(after, ']')) break;
      if (!this.isPunct(after, ',')) this.unexpected(after, "',' or ']'");
    }
    this.depth -= 1;
    return items;
  }

  private parseArgs(): Arg[] {
    const open = this.expect('(');
    this.enter(open.start);
    const args: Arg[] = [];
    for (;;) {
      const token = this.lexer.peek();
      if (this.isPunct(token, ')')) {
        this.lexer.next();
        break;
      }
      args.push({ start: token.start, value: this.parseValue() });
      const after = this.lexer.next();
      if (this.isPunct(after, ')')) break;
      if (!this.isPunct(after, ',')) this.unexpected(after, "',' or ')'");
    }
    this.depth -= 1;
    return args;
  }

  private parseIdentifier(): BsonValue {
    let token = this.lexer.next();
    const start = token.start;
    let isNew = false;
    if (token.value === 'new') {
      isNew = true;
      token = this.lexer.next();
      if (token.kind !== 'ident') this.unexpected(token, 'a constructor name');
    }
    let name = token.value;
    while (this.isPunct(this.lexer.peek(), '.')) {
      this.lexer.next();
      const part = this.lexer.next();
      if (part.kind !== 'ident') this.unexpected(part, 'a name');
      name += `.${part.value}`;
    }
    const args = this.isPunct(this.lexer.peek(), '(') ? this.parseArgs() : undefined;
    return this.construct(name, args, isNew, start);
  }

  private construct(name: string, args: Arg[] | undefined, isNew: boolean, at: number): BsonValue {
    const literal = (value: BsonValue): BsonValue => {
      if (args !== undefined || isNew) this.fail(at, `${name} is not a function`);
      return value;
    };
    switch (name) {
      case 'true':
        return literal(true);
      case 'false':
        return literal(false);
      case 'null':
      case 'undefined':
        return literal(null);
      case 'NaN':
        return literal(new Double(NaN));
      case 'Infinity':
        return literal(new Double(Infinity));
      case 'MinKey':
        if (args !== undefined && args.length > 0) this.fail(at, 'MinKey takes no arguments');
        return new MinKey();
      case 'MaxKey':
        if (args !== undefined && args.length > 0) this.fail(at, 'MaxKey takes no arguments');
        return new MaxKey();
    }
    if (args === undefined) {
      return this.fail(
        at,
        `Unknown name "${name}"`,
        'Quote strings, and write values with the shell constructors: ObjectId(...), ISODate(...), NumberLong(...)',
      );
    }
    const a: ArgReader = new ArgReader(this, name, args, at);
    switch (name) {
      case 'ObjectId':
      case 'ObjectID':
      case 'ObjectId.createFromHexString': {
        a.count(name === 'ObjectId.createFromHexString' ? 1 : 0, 1);
        if (args.length === 0) return new ObjectId();
        return this.objectId(a.string(0), args[0]!.start);
      }
      case 'ObjectId.createFromTime': {
        a.count(1, 1);
        return ObjectId.createFromTime(a.integer(0, 0n, 0xffffffffn));
      }
      case 'ISODate': {
        a.count(0, 1);
        if (args.length === 0) return this.now();
        const date = parseIsoDate(a.string(0));
        if (!date)
          this.fail(args[0]!.start, 'Invalid ISODate', 'Use the form 2024-01-31T12:00:00Z');
        return date;
      }
      case 'Date':
        return this.date(a, args);
      case 'NumberInt':
      case 'Int32': {
        a.count(1, 1);
        return new Int32(a.integer(0, INT32_MIN, INT32_MAX));
      }
      case 'NumberLong':
      case 'Long':
      case 'Long.fromString':
      case 'Long.fromNumber': {
        a.count(1, 1);
        return Long.fromBigInt(a.bigInteger(0, INT64_MIN, INT64_MAX));
      }
      case 'NumberDecimal':
      case 'Decimal128':
      case 'Decimal128.fromString': {
        a.count(1, 1);
        const raw = args[0]!.value;
        const n = numberOf(raw);
        const text = typeof raw === 'string' ? raw : n !== undefined ? String(n) : undefined;
        if (text === undefined) a.fail(0, 'expects a number or a numeric string');
        try {
          return Decimal128.fromString(text);
        } catch {
          return a.fail(0, 'expects a valid decimal number');
        }
      }
      case 'Double': {
        a.count(1, 1);
        const raw = args[0]!.value;
        const n = typeof raw === 'string' ? Number(raw.trim() === '' ? NaN : raw) : numberOf(raw);
        if (n === undefined || (typeof raw === 'string' && Number.isNaN(n) && raw !== 'NaN')) {
          a.fail(0, 'expects a number');
        }
        return new Double(n);
      }
      case 'UUID': {
        a.count(0, 1);
        if (args.length === 0) return new UUID();
        const text = a.string(0);
        if (
          !/^[0-9a-fA-F]{8}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{12}$/.test(
            text,
          )
        ) {
          a.fail(0, 'expects 32 hexadecimal digits, optionally with dashes');
        }
        return new UUID(text);
      }
      case 'BinData': {
        a.count(2, 2);
        return this.binary(a.string(1), 'base64', a.integer(0, 0n, 255n), args[1]!.start);
      }
      case 'HexData': {
        a.count(2, 2);
        return this.binary(a.string(1), 'hex', a.integer(0, 0n, 255n), args[1]!.start);
      }
      case 'MD5': {
        a.count(1, 1);
        const hex = a.string(0);
        if (!/^[0-9a-fA-F]{32}$/.test(hex)) a.fail(0, 'expects 32 hexadecimal digits');
        return this.binary(hex, 'hex', Binary.SUBTYPE_MD5, args[0]!.start);
      }
      case 'Binary.createFromBase64':
      case 'Binary.createFromHexString': {
        a.count(1, 2);
        const subtype = args.length > 1 ? a.integer(1, 0n, 255n) : 0;
        const encoding = name === 'Binary.createFromBase64' ? 'base64' : 'hex';
        return this.binary(a.string(0), encoding, subtype, args[0]!.start);
      }
      case 'Timestamp': {
        a.count(0, 2);
        if (args.length === 0) return new Timestamp({ t: 0, i: 0 });
        if (args.length === 1) {
          const doc = args[0]!.value;
          if (!isBsonDocument(doc) || !('t' in doc) || !('i' in doc)) {
            a.fail(0, 'expects { t: <seconds>, i: <increment> } or (t, i)');
          }
          return this.timestamp(doc['t']!, doc['i']!, args[0]!.start);
        }
        return this.timestamp(args[0]!.value, args[1]!.value, args[0]!.start);
      }
      case 'RegExp':
      case 'BSONRegExp': {
        a.count(1, 2);
        const first = args[0]!.value;
        if (bsonTag(first) === 'BSONRegExp' && args.length === 1) return first;
        const pattern = a.string(0);
        const flags = bsonFlags(args.length > 1 ? a.string(1) : '');
        if (flags === undefined) a.fail(1, 'supports the flags i, m, x, s, l and u');
        return new BSONRegExp(pattern, flags);
      }
      case 'DBRef': {
        a.count(2, 3);
        const collection = a.string(0);
        const db = args.length > 2 ? a.string(2) : undefined;
        return new DBRef(collection, this.dbRefId(args[1]!.value), db);
      }
      case 'Code': {
        a.count(1, 2);
        const code = a.string(0);
        if (args.length === 1) return new Code(code);
        const scope = args[1]!.value;
        if (!isBsonDocument(scope)) a.fail(1, 'expects a scope document');
        return new Code(code, scope);
      }
      case 'BSONSymbol': {
        a.count(1, 1);
        return new BSONSymbol(a.string(0));
      }
      default:
        return this.fail(
          at,
          `Unknown function "${name}"`,
          'Only literal values and the shell constructors (ObjectId, ISODate, NumberLong...) are supported',
        );
    }
  }

  private date(a: ArgReader, args: Arg[]): Date {
    a.count(0, 7);
    if (args.length === 0) return this.now();
    if (args.length === 1) {
      const raw = args[0]!.value;
      if (raw instanceof Date) return new Date(raw.getTime());
      const date = typeof raw === 'string' ? new Date(raw) : new Date(numberOf(raw) ?? NaN);
      if (typeof raw !== 'string' && numberOf(raw) === undefined) {
        a.fail(0, 'expects a date string or milliseconds since the epoch');
      }
      if (Number.isNaN(date.getTime())) a.fail(0, 'got an invalid date');
      return date;
    }
    const parts = args.map((_, i) => a.number(i));
    const [y, mo, d = 1, h = 0, mi = 0, s = 0, ms = 0] = parts as [number, number, ...number[]];
    const date = new Date(y, mo, d, h, mi, s, ms);
    if (Number.isNaN(date.getTime())) a.fail(0, 'got an invalid date');
    return date;
  }

  private objectId(hex: string, at: number): ObjectId {
    if (!/^[0-9a-fA-F]{24}$/.test(hex)) {
      this.fail(at, 'An ObjectId needs 24 hexadecimal digits');
    }
    return ObjectId.createFromHexString(hex);
  }

  private binary(
    data: string,
    encoding: 'base64' | 'hex',
    subtype: number,
    at: number,
  ): Binary | UUID {
    if (encoding === 'base64' ? !BASE64.test(data) : !HEX.test(data)) {
      this.fail(at, encoding === 'base64' ? 'Invalid base64 data' : 'Invalid hexadecimal data');
    }
    const binary =
      encoding === 'base64'
        ? Binary.createFromBase64(data, subtype)
        : Binary.createFromHexString(data, subtype);
    return subtype === Binary.SUBTYPE_UUID && binary.length() === 16 ? toUuid(binary) : binary;
  }

  private timestamp(t: BsonValue, i: BsonValue, at: number): Timestamp {
    const tt = integerOf(t);
    const ii = integerOf(i);
    if (tt === undefined || ii === undefined || tt < 0n || ii < 0n) {
      this.fail(at, 'Timestamp expects non-negative integers t and i');
    }
    if (tt > 0xffffffffn || ii > 0xffffffffn) this.fail(at, 'Timestamp parts must fit in 32 bits');
    return new Timestamp({ t: Number(tt), i: Number(ii) });
  }

  private dbRefId(value: BsonValue): ObjectId {
    // DBRef's $id may be any value; the bson class types it as ObjectId.
    return value as ObjectId;
  }

  /** Builds a document, or the BSON value an Extended JSON wrapper object stands for. */
  private fromMembers(members: readonly Member[], at: number): BsonValue {
    const wrapped = this.extendedJson(members, at);
    if (wrapped !== NOT_WRAPPER) return wrapped;
    const doc: BsonDocument = {};
    for (const { key, value } of members) setField(doc, key, value);
    return doc;
  }

  private extendedJson(members: readonly Member[], at: number): BsonValue | typeof NOT_WRAPPER {
    const first = members[0];
    if (first === undefined || !first.key.startsWith('$')) {
      if (!members.some((m) => m.key === '$ref')) return NOT_WRAPPER;
    }
    const byKey = new Map(members.map((m) => [m.key, m.value]));
    const keys = [...byKey.keys()].sort().join(',');
    const bad = (what: string): never => this.fail(at, `Invalid Extended JSON ${what}`);
    const str = (key: string): string => {
      const value = byKey.get(key);
      if (typeof value !== 'string') bad(`${key}: expected a string`);
      return value as string;
    };
    switch (keys) {
      case '$oid': {
        const hex = str('$oid');
        if (!/^[0-9a-fA-F]{24}$/.test(hex)) bad('$oid: expected 24 hexadecimal digits');
        return ObjectId.createFromHexString(hex);
      }
      case '$date': {
        const value = byKey.get('$date')!;
        if (typeof value === 'string') {
          const date = parseIsoDate(value) ?? new Date(value);
          if (Number.isNaN(date.getTime())) bad('$date: invalid date string');
          return date;
        }
        const ms = integerOf(value);
        if (ms === undefined) bad('$date: expected an ISO-8601 string or { $numberLong }');
        const date = new Date(Number(ms));
        if (Number.isNaN(date.getTime())) bad('$date: out of range');
        return date;
      }
      case '$numberInt': {
        const text = str('$numberInt');
        if (!/^-?\d+$/.test(text)) bad('$numberInt: expected an integer string');
        const n = BigInt(text);
        if (n < INT32_MIN || n > INT32_MAX) bad('$numberInt: out of Int32 range');
        return new Int32(Number(n));
      }
      case '$numberLong': {
        const text = str('$numberLong');
        if (!/^-?\d+$/.test(text)) bad('$numberLong: expected an integer string');
        const n = BigInt(text);
        if (n < INT64_MIN || n > INT64_MAX) bad('$numberLong: out of Int64 range');
        return Long.fromBigInt(n);
      }
      case '$numberDouble': {
        const text = str('$numberDouble');
        const n =
          text === 'Infinity' ? Infinity : text === '-Infinity' ? -Infinity : Number(text || 'x');
        if (Number.isNaN(n) && text !== 'NaN') bad('$numberDouble: expected a number string');
        return new Double(n);
      }
      case '$numberDecimal': {
        try {
          return Decimal128.fromString(str('$numberDecimal'));
        } catch {
          return bad('$numberDecimal: expected a decimal number string');
        }
      }
      case '$binary': {
        const value = byKey.get('$binary');
        if (!isBsonDocument(value)) bad('$binary: expected { base64, subType }');
        const doc = value as BsonDocument;
        const base64 = doc['base64'];
        const subType = doc['subType'];
        if (
          typeof base64 !== 'string' ||
          typeof subType !== 'string' ||
          Object.keys(doc).length !== 2
        ) {
          bad('$binary: expected { base64, subType }');
        }
        return this.ejsonBinary(base64 as string, subType as string, at);
      }
      case '$binary,$type':
        return this.ejsonBinary(str('$binary'), str('$type'), at);
      case '$uuid': {
        const text = str('$uuid');
        if (
          !/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(
            text,
          )
        ) {
          bad('$uuid: expected a hyphenated UUID');
        }
        return new UUID(text);
      }
      case '$timestamp': {
        const value = byKey.get('$timestamp');
        if (!isBsonDocument(value) || !('t' in value) || !('i' in value)) {
          bad('$timestamp: expected { t, i }');
        }
        const doc = value as BsonDocument;
        return this.timestamp(doc['t']!, doc['i']!, at);
      }
      case '$regularExpression': {
        const value = byKey.get('$regularExpression');
        const doc = isBsonDocument(value) ? value : undefined;
        const pattern = doc?.['pattern'];
        const options = doc?.['options'];
        if (typeof pattern !== 'string' || typeof options !== 'string') {
          bad('$regularExpression: expected { pattern, options }');
        }
        const flags = bsonFlags(options as string);
        if (flags === undefined) bad('$regularExpression: unsupported options');
        return new BSONRegExp(pattern as string, flags);
      }
      case '$minKey':
        return new MinKey();
      case '$maxKey':
        return new MaxKey();
      case '$symbol':
        return new BSONSymbol(str('$symbol'));
      case '$code':
        return new Code(str('$code'));
      case '$code,$scope': {
        const scope = byKey.get('$scope');
        if (!isBsonDocument(scope)) bad('$scope: expected a document');
        return new Code(str('$code'), scope as BsonDocument);
      }
      case '$dbPointer': {
        const value = byKey.get('$dbPointer');
        if (bsonTag(value) !== 'DBRef') bad('$dbPointer: expected { $ref, $id }');
        return value as DBRef;
      }
      case '$undefined':
        return null;
    }
    if (byKey.has('$ref') && byKey.has('$id')) {
      const ref = byKey.get('$ref');
      const db = byKey.get('$db');
      const extraDollar = members.some((m) => m.key.startsWith('$') && !DBREF_KEYS.has(m.key));
      if (typeof ref === 'string' && (db === undefined || typeof db === 'string') && !extraDollar) {
        const fields: BsonDocument = {};
        for (const { key, value } of members)
          if (!DBREF_KEYS.has(key)) setField(fields, key, value);
        return new DBRef(ref, this.dbRefId(byKey.get('$id')!), db as string | undefined, fields);
      }
    }
    return NOT_WRAPPER;
  }

  private ejsonBinary(base64: string, subType: string, at: number): Binary | UUID {
    if (!/^[0-9a-fA-F]{1,2}$/.test(subType)) {
      this.fail(at, 'Invalid Extended JSON $binary: subType must be one or two hex digits');
    }
    return this.binary(base64, 'base64', parseInt(subType, 16), at);
  }
}

const NOT_WRAPPER: unique symbol = Symbol('not an Extended JSON wrapper');
const DBREF_KEYS = new Set(['$ref', '$id', '$db']);

/** A 16-byte subtype 4 Binary as the UUID class, so it formats and types as a UUID. */
function toUuid(binary: Binary): UUID {
  return new UUID(binary.toString('hex'));
}

/** Reads and checks constructor arguments, failing at the argument's position. */
class ArgReader {
  constructor(
    private readonly parser: ShellParser,
    private readonly name: string,
    private readonly args: readonly Arg[],
    private readonly at: number,
  ) {}

  fail(index: number, reason: string): never {
    return this.parser.fail(this.args[index]?.start ?? this.at, `${this.name}() ${reason}`);
  }

  count(min: number, max: number): void {
    const n = this.args.length;
    if (n < min || n > max) {
      const expected = min === max ? `${min}` : `${min} to ${max}`;
      this.parser.fail(this.at, `${this.name}() takes ${expected} argument${max === 1 ? '' : 's'}`);
    }
  }

  string(index: number): string {
    const value = this.args[index]!.value;
    if (typeof value !== 'string') this.fail(index, `expects a string as argument ${index + 1}`);
    return value;
  }

  number(index: number): number {
    const n = numberOf(this.args[index]!.value);
    if (n === undefined) this.fail(index, `expects a number as argument ${index + 1}`);
    return n;
  }

  /** An integer in [min, max] from a number or a decimal string. */
  integer(index: number, min: bigint, max: bigint): number {
    return Number(this.bigInteger(index, min, max));
  }

  bigInteger(index: number, min: bigint, max: bigint): bigint {
    const value = this.args[index]!.value;
    const n =
      typeof value === 'string'
        ? /^\s*[+-]?\d+\s*$/.test(value)
          ? BigInt(value.trim())
          : undefined
        : integerOf(value);
    if (n === undefined) this.fail(index, `expects an integer as argument ${index + 1}`);
    if (n < min || n > max) this.fail(index, `argument ${index + 1} is out of range`);
    return n;
  }
}

/** Parses one shell literal (a document, array or any value) from the whole text. */
export function parseShell(text: string, options?: ShellParseOptions): BsonValue {
  const parser: ShellParser = new ShellParser(text, options);
  const value = parser.parseValue();
  parser.expectEnd();
  return value;
}

/** Parses a document (`{ ... }`); `what` names it in the error ("filter", "update"...). */
export function parseShellDocument(
  text: string,
  what = 'document',
  options?: ShellParseOptions,
): BsonDocument {
  const parser: ShellParser = new ShellParser(text, options);
  const start = parser.lexer.peek();
  const value = parser.parseValue();
  parser.expectEnd();
  if (!isBsonDocument(value)) parser.fail(start.start, `The ${what} must be a document { ... }`);
  return value;
}

/** Parses an aggregation pipeline: an array of stage documents. */
export function parseShellPipeline(text: string, options?: ShellParseOptions): BsonDocument[] {
  const parser: ShellParser = new ShellParser(text, options);
  const start = parser.lexer.peek();
  const value = parser.parseValue();
  parser.expectEnd();
  if (!Array.isArray(value)) parser.fail(start.start, 'The pipeline must be an array [ ... ]');
  value.forEach((stage) => {
    if (!isBsonDocument(stage)) parser.fail(start.start, 'Every pipeline stage must be a document');
  });
  return value as BsonDocument[];
}
