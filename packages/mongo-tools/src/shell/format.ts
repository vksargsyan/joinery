import {
  Long,
  type Binary,
  type BSONRegExp,
  type BSONSymbol,
  type Code,
  type DBRef,
  type Decimal128,
  type Double,
  type Int32,
  type ObjectId,
  type Timestamp,
} from 'bson';

import { bsonTag, isInt32Number, isInt64Number, type BsonDocument, type BsonValue } from '../bson';

/**
 * Prints BSON values the way mongosh displays them, as text `parseShell` reads back to the same
 * value (format → parse is the identity on canonical Extended JSON). Where mongosh's display is
 * lossy the output is explicit instead: a Double with an integral value prints as `1.0`, and a
 * regular expression that cannot be written as a literal prints as `BSONRegExp('…', '…')`.
 */

export interface FormatShellOptions {
  /** Spaces per nesting level; default 2. */
  readonly indent?: number;
  /**
   * Documents and arrays that fit in this many columns (including indentation) print on one
   * line; default 80. `Infinity` prints everything on one line.
   */
  readonly lineWidth?: number;
  /** Strings longer than this are cut with "…" (the output then no longer parses back). */
  readonly maxStringLength?: number;
}

const IDENTIFIER = /^[\p{ID_Start}$_][\p{ID_Continue}$‌‍]*$/u;

/** Quotes a string with single quotes, escaping what JavaScript needs. */
export function quoteShellString(value: string): string {
  let out = "'";
  for (let i = 0; i < value.length; i++) {
    const c = value[i]!;
    const code = value.charCodeAt(i);
    switch (c) {
      case "'":
        out += "\\'";
        break;
      case '\\':
        out += '\\\\';
        break;
      case '\n':
        out += '\\n';
        break;
      case '\r':
        out += '\\r';
        break;
      case '\t':
        out += '\\t';
        break;
      default:
        if (code < 0x20 || code === 0x7f || code === 0x2028 || code === 0x2029) {
          out += `\\u${code.toString(16).padStart(4, '0')}`;
        } else if (code >= 0xd800 && code <= 0xdfff) {
          // Lone surrogates survive only as escapes; pairs are copied as they are.
          const next = value.charCodeAt(i + 1);
          if (code <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
            out += c + value[i + 1]!;
            i += 1;
          } else {
            out += `\\u${code.toString(16).padStart(4, '0')}`;
          }
        } else {
          out += c;
        }
    }
  }
  return `${out}'`;
}

/** A field name as a key: bare when it is an identifier, quoted otherwise. */
export function formatKey(key: string): string {
  return IDENTIFIER.test(key) ? key : quoteShellString(key);
}

/** A Double's text: integral values keep a ".0" so they read back as Double. */
export function formatDouble(n: number): string {
  if (Number.isNaN(n)) return 'NaN';
  if (n === Infinity) return 'Infinity';
  if (n === -Infinity) return '-Infinity';
  if (Object.is(n, -0)) return '-0.0';
  const text = String(n);
  return /[.eE]/.test(text) ? text : `${text}.0`;
}

/**
 * True when `pattern` can be written as a JavaScript regular expression literal that the lexer
 * reads back unchanged: no line breaks, no unescaped `/` outside a class, not empty, not
 * starting with `*` (that would open a comment) and not ending in a lone backslash.
 */
function literalPattern(pattern: string): boolean {
  if (pattern === '' || pattern.startsWith('*')) return false;
  let inClass = false;
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === '\n' || c === '\r' || c === ' ' || c === ' ') return false;
    if (c === '\\') {
      const next = pattern[i + 1];
      if (next === undefined || next === '\n' || next === '\r') return false;
      if (next === ' ' || next === ' ') return false;
      i += 1;
      continue;
    }
    if (c === '[') inClass = true;
    else if (c === ']') inClass = false;
    else if (c === '/' && !inClass) return false;
  }
  // An unclosed class would swallow the closing slash.
  return !inClass;
}

function formatRegex(pattern: string, flags: string): string {
  if (literalPattern(pattern)) return `/${pattern}/${flags}`;
  return `BSONRegExp(${quoteShellString(pattern)}, ${quoteShellString(flags)})`;
}

function formatDate(date: Date): string {
  if (Number.isNaN(date.getTime())) return 'new Date(NaN)';
  return `ISODate(${quoteShellString(date.toISOString())})`;
}

class Formatter {
  private readonly indent: number;
  private readonly width: number;
  private readonly maxString: number;

  constructor(options: FormatShellOptions) {
    this.indent = options.indent ?? 2;
    this.width = options.lineWidth ?? 80;
    this.maxString = options.maxStringLength ?? Infinity;
  }

  string(value: string): string {
    if (value.length > this.maxString)
      return `${quoteShellString(value.slice(0, this.maxString))}…`;
    return quoteShellString(value);
  }

  /** The value on one line, or undefined once it grows past `budget` characters. */
  inline(value: BsonValue, budget: number): string | undefined {
    if (budget < 0) return undefined;
    if (Array.isArray(value)) {
      if (value.length === 0) return '[]';
      let out = '[ ';
      for (let i = 0; i < value.length; i++) {
        const item = this.inline(value[i]!, budget - out.length);
        if (item === undefined) return undefined;
        out += (i > 0 ? ', ' : '') + item;
        if (out.length > budget) return undefined;
      }
      return `${out} ]`;
    }
    const scalar = this.scalar(value, budget);
    if (scalar !== undefined) return scalar.length > budget ? undefined : scalar;
    const doc = value as BsonDocument;
    const keys = Object.keys(doc);
    if (keys.length === 0) return '{}';
    let out = '{ ';
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i]!;
      const prefix = `${i > 0 ? ', ' : ''}${formatKey(key)}: `;
      const item = this.inline(doc[key]!, budget - out.length - prefix.length);
      if (item === undefined) return undefined;
      out += prefix + item;
      if (out.length > budget) return undefined;
    }
    return `${out} }`;
  }

  /** A non-container value's text; undefined for documents and arrays. */
  scalar(value: BsonValue, budget = Infinity): string | undefined {
    if (value === null || value === undefined) return 'null';
    switch (typeof value) {
      case 'string':
        return this.string(value);
      case 'boolean':
        return String(value);
      case 'number':
        // As Extended JSON types a JS number: Int32, else Int64 when integral, else Double.
        if (isInt32Number(value)) return String(value);
        if (isInt64Number(value)) return `Long('${Long.fromNumber(value).toString()}')`;
        return formatDouble(value);
      case 'bigint':
        return `Long('${String(value)}')`;
      default:
        break;
    }
    if (value instanceof Date) return formatDate(value);
    if (value instanceof RegExp) return formatRegex(value.source, value.flags);
    switch (bsonTag(value)) {
      case undefined:
        return undefined;
      case 'ObjectId':
        return `ObjectId('${(value as ObjectId).toHexString()}')`;
      case 'Int32':
        return String((value as Int32).value);
      case 'Double':
        return formatDouble((value as Double).value);
      case 'Long':
        return `Long('${(value as Long).toString()}')`;
      case 'Decimal128':
        return `Decimal128('${(value as Decimal128).toString()}')`;
      case 'Binary': {
        const binary = value as Binary;
        if (binary.sub_type === 4 && binary.length() === 16) {
          const hex = binary.toString('hex');
          return `UUID('${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}')`;
        }
        return `Binary.createFromBase64('${binary.toString('base64')}', ${binary.sub_type})`;
      }
      case 'Timestamp': {
        const ts = value as Timestamp;
        return `Timestamp({ t: ${ts.t}, i: ${ts.i} })`;
      }
      case 'MinKey':
        return 'MinKey()';
      case 'MaxKey':
        return 'MaxKey()';
      case 'BSONRegExp': {
        const re = value as BSONRegExp;
        return formatRegex(re.pattern, re.options);
      }
      case 'BSONSymbol':
        return `BSONSymbol(${this.string((value as BSONSymbol).value)})`;
      case 'Code': {
        const code = value as Code;
        if (code.scope === null || code.scope === undefined)
          return `Code(${this.string(code.code)})`;
        const scope =
          this.inline(code.scope as BsonDocument, budget) ??
          this.block(code.scope as BsonDocument, 0);
        return `Code(${this.string(code.code)}, ${scope})`;
      }
      case 'DBRef': {
        const ref = value as DBRef;
        const fields = ref.fields as BsonDocument;
        if (Object.keys(fields).length > 0) {
          // Extra fields only survive as the Extended JSON form.
          const doc: BsonDocument = { $ref: ref.collection, $id: ref.oid as BsonValue };
          if (ref.db) doc['$db'] = ref.db;
          Object.assign(doc, fields);
          return this.inline(doc, Infinity);
        }
        const id = this.inline(ref.oid as BsonValue, Infinity);
        return `DBRef(${this.string(ref.collection)}, ${id}${ref.db ? `, ${this.string(ref.db)}` : ''})`;
      }
      default:
        return `${String(bsonTag(value))}(${this.string(String(value))})`;
    }
  }

  /** A document or array over several lines, indented `level` deep. */
  block(value: BsonDocument | BsonValue[], level: number): string {
    const pad = ' '.repeat(this.indent * (level + 1));
    const close = ' '.repeat(this.indent * level);
    if (Array.isArray(value)) {
      if (value.length === 0) return '[]';
      const items = value.map((item) => pad + this.format(item, level + 1, pad.length));
      return `[\n${items.join(',\n')}\n${close}]`;
    }
    const keys = Object.keys(value);
    if (keys.length === 0) return '{}';
    const items = keys.map((key) => {
      const prefix = `${pad}${formatKey(key)}: `;
      return prefix + this.format(value[key]!, level + 1, prefix.length);
    });
    return `{\n${items.join(',\n')}\n${close}}`;
  }

  /** A value starting at column `column`, indented `level` deep. */
  format(value: BsonValue, level: number, column: number): string {
    const scalar = this.scalar(value);
    if (scalar !== undefined) return scalar;
    const inline = this.inline(value, this.width - column);
    if (inline !== undefined) return inline;
    return this.block(value as BsonDocument | BsonValue[], level);
  }
}

/** Prints a value as mongosh-style shell text (see the module comment). */
export function formatShell(value: BsonValue, options: FormatShellOptions = {}): string {
  return new Formatter(options).format(value, 0, 0);
}

/** One-line shell text of a value, for tables, tooltips and generated find() text. */
export function formatShellInline(value: BsonValue, options: FormatShellOptions = {}): string {
  return new Formatter({ ...options, lineWidth: Infinity }).format(value, 0, 0);
}
