import { JoineryError } from '@joinery/core';

import { jsonText, type SourceCell } from './types';

/**
 * Streaming JSON (spec §12): a top-level array of rows, or JSON Lines, read chunk by chunk.
 * An incremental scanner finds where each top-level element ends, tracking nesting, strings
 * and escapes across chunk boundaries, and only then parses that element; memory holds one
 * element, never the document.
 *
 * Inside an element, objects become rows. Their scalar members are parsed (integers beyond
 * 2^53 as bigint; numbers a JavaScript number would not reproduce digit for digit, such as
 * `1.50` or 30-digit decimals, stay JsonText), and nested objects and arrays are kept as their
 * exact source text (JsonText) for a JSON column.
 */

/** One top-level element: an object (a row), an array (a positional row) or a scalar. */
export type JsonElement =
  | { readonly kind: 'object'; readonly keys: string[]; readonly values: SourceCell[] }
  | { readonly kind: 'array'; readonly values: SourceCell[] }
  | { readonly kind: 'scalar'; readonly value: SourceCell };

export interface JsonElements {
  readonly elements: JsonElement[];
  /** 1-based line where each element starts. */
  readonly lines: number[];
  /** JSON Lines only: lines that did not parse. */
  readonly errors: { readonly line: number; readonly message: string }[];
}

function syntaxError(message: string, line: number): JoineryError {
  return new JoineryError({
    code: 'VALIDATION_FAILED',
    message: `Invalid JSON on line ${line}: ${message}`,
  });
}

class LocalSyntaxError extends Error {
  constructor(
    message: string,
    readonly offset: number,
  ) {
    super(message);
  }
}

function countNewlines(text: string, from: number, to: number): number {
  let count = 0;
  for (let at = text.indexOf('\n', from); at >= 0 && at < to; at = text.indexOf('\n', at + 1)) {
    count++;
  }
  return count;
}

const isDigit = (c: number): boolean => c >= 48 && c <= 57;

/** Parses one complete element from its text. */
class ElementParser {
  private pos = 0;

  constructor(private readonly s: string) {}

  element(): JsonElement {
    this.ws();
    const c = this.s.charCodeAt(this.pos);
    let element: JsonElement;
    if (c === 123) element = this.object();
    else if (c === 91) element = this.array();
    else element = { kind: 'scalar', value: this.cell() };
    this.ws();
    if (this.pos < this.s.length) this.fail('unexpected text after the value');
    return element;
  }

  private fail(message: string): never {
    throw new LocalSyntaxError(message, this.pos);
  }

  private ws(): void {
    const s = this.s;
    let p = this.pos;
    for (;;) {
      const c = s.charCodeAt(p);
      if (c === 32 || c === 10 || c === 13 || c === 9) p++;
      else break;
    }
    this.pos = p;
  }

  private expect(code: number, what: string): void {
    if (this.s.charCodeAt(this.pos) !== code) this.fail(`expected ${what}`);
    this.pos++;
  }

  private object(): JsonElement {
    const keys: string[] = [];
    const values: SourceCell[] = [];
    this.pos++;
    this.ws();
    if (this.s.charCodeAt(this.pos) === 125) {
      this.pos++;
      return { kind: 'object', keys, values };
    }
    for (;;) {
      this.ws();
      if (this.s.charCodeAt(this.pos) !== 34) this.fail('expected a member name in double quotes');
      const key = this.string();
      this.ws();
      this.expect(58, "':'");
      this.ws();
      const value = this.cell();
      const existing = keys.indexOf(key);
      if (existing >= 0) values[existing] = value;
      else {
        keys.push(key);
        values.push(value);
      }
      this.ws();
      const c = this.s.charCodeAt(this.pos);
      this.pos++;
      if (c === 44) continue;
      if (c === 125) return { kind: 'object', keys, values };
      this.pos--;
      this.fail("expected ',' or '}'");
    }
  }

  private array(): JsonElement {
    const values: SourceCell[] = [];
    this.pos++;
    this.ws();
    if (this.s.charCodeAt(this.pos) === 93) {
      this.pos++;
      return { kind: 'array', values };
    }
    for (;;) {
      this.ws();
      values.push(this.cell());
      this.ws();
      const c = this.s.charCodeAt(this.pos);
      this.pos++;
      if (c === 44) continue;
      if (c === 93) return { kind: 'array', values };
      this.pos--;
      this.fail("expected ',' or ']'");
    }
  }

  /** A member value: scalars parsed, nested structures as their source text. */
  private cell(): SourceCell {
    const c = this.s.charCodeAt(this.pos);
    if (c === 34) return this.string();
    if (c === 123 || c === 91) {
      const start = this.pos;
      this.skip();
      return jsonText(this.s.slice(start, this.pos));
    }
    if (c === 45 || isDigit(c)) return this.number();
    return this.literal();
  }

  private literal(): boolean | null {
    const s = this.s;
    if (s.startsWith('true', this.pos)) {
      this.pos += 4;
      return true;
    }
    if (s.startsWith('false', this.pos)) {
      this.pos += 5;
      return false;
    }
    if (s.startsWith('null', this.pos)) {
      this.pos += 4;
      return null;
    }
    return this.pos >= s.length
      ? this.fail('unexpected end of input')
      : this.fail('unexpected character');
  }

  /** Scans a number and returns its end offset; `integer` reports the syntax seen. */
  private scanNumber(): { end: number; integer: boolean } {
    const s = this.s;
    let p = this.pos;
    let integer = true;
    if (s.charCodeAt(p) === 45) p++;
    if (s.charCodeAt(p) === 48) p++;
    else if (isDigit(s.charCodeAt(p))) while (isDigit(s.charCodeAt(p))) p++;
    else this.fail('invalid number');
    if (s.charCodeAt(p) === 46) {
      integer = false;
      p++;
      if (!isDigit(s.charCodeAt(p))) {
        this.pos = p;
        this.fail('invalid number');
      }
      while (isDigit(s.charCodeAt(p))) p++;
    }
    const e = s.charCodeAt(p);
    if (e === 101 || e === 69) {
      integer = false;
      p++;
      const sign = s.charCodeAt(p);
      if (sign === 43 || sign === 45) p++;
      if (!isDigit(s.charCodeAt(p))) {
        this.pos = p;
        this.fail('invalid number');
      }
      while (isDigit(s.charCodeAt(p))) p++;
    }
    return { end: p, integer };
  }

  private number(): SourceCell {
    const { end, integer } = this.scanNumber();
    const text = this.s.slice(this.pos, end);
    this.pos = end;
    const n = Number(text);
    if (integer) return Number.isSafeInteger(n) ? n : BigInt(text);
    return String(n) === text ? n : jsonText(text);
  }

  private string(): string {
    const s = this.s;
    const start = this.pos + 1;
    let p = start;
    for (;;) {
      const c = s.charCodeAt(p);
      if (c === 34) {
        this.pos = p + 1;
        return s.slice(start, p);
      }
      if (c === 92) break;
      if (Number.isNaN(c)) {
        this.pos = p;
        this.fail('unterminated string');
      }
      p++;
    }
    let out = s.slice(start, p);
    for (;;) {
      const c = s.charCodeAt(p);
      if (c === 34) {
        this.pos = p + 1;
        return out;
      }
      if (Number.isNaN(c)) {
        this.pos = p;
        this.fail('unterminated string');
      }
      if (c !== 92) {
        const next = s.indexOf('"', p);
        const slash = s.indexOf('\\', p);
        const stop = next < 0 ? s.length : slash >= 0 && slash < next ? slash : next;
        out += s.slice(p, stop);
        p = stop;
        continue;
      }
      const e = s[p + 1];
      p += 2;
      switch (e) {
        case '"':
        case '\\':
        case '/':
          out += e;
          break;
        case 'b':
          out += '\b';
          break;
        case 'f':
          out += '\f';
          break;
        case 'n':
          out += '\n';
          break;
        case 'r':
          out += '\r';
          break;
        case 't':
          out += '\t';
          break;
        case 'u': {
          const hex = s.slice(p, p + 4);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
            this.pos = p;
            this.fail('invalid \\u escape');
          }
          out += String.fromCharCode(parseInt(hex, 16));
          p += 4;
          break;
        }
        default:
          this.pos = p - 1;
          this.fail('invalid escape sequence');
      }
    }
  }

  /** Skips one value, validating it. */
  private skip(): void {
    const c = this.s.charCodeAt(this.pos);
    if (c === 34) {
      this.string();
    } else if (c === 123) {
      this.pos++;
      this.ws();
      if (this.s.charCodeAt(this.pos) === 125) {
        this.pos++;
        return;
      }
      for (;;) {
        this.ws();
        if (this.s.charCodeAt(this.pos) !== 34)
          this.fail('expected a member name in double quotes');
        this.string();
        this.ws();
        this.expect(58, "':'");
        this.ws();
        this.skip();
        this.ws();
        const next = this.s.charCodeAt(this.pos);
        this.pos++;
        if (next === 44) continue;
        if (next === 125) return;
        this.pos--;
        this.fail("expected ',' or '}'");
      }
    } else if (c === 91) {
      this.pos++;
      this.ws();
      if (this.s.charCodeAt(this.pos) === 93) {
        this.pos++;
        return;
      }
      for (;;) {
        this.ws();
        this.skip();
        this.ws();
        const next = this.s.charCodeAt(this.pos);
        this.pos++;
        if (next === 44) continue;
        if (next === 93) return;
        this.pos--;
        this.fail("expected ',' or ']'");
      }
    } else if (c === 45 || isDigit(c)) {
      this.pos = this.scanNumber().end;
    } else {
      this.literal();
    }
  }
}

/** Parses one complete JSON element (a JSON Lines line, a test value). */
export function parseJsonElement(text: string, line = 1): JsonElement {
  try {
    return new ElementParser(text).element();
  } catch (error) {
    if (error instanceof LocalSyntaxError) {
      throw syntaxError(error.message, line + countNewlines(text, 0, error.offset));
    }
    throw error;
  }
}

const enum Phase {
  /** Array mode: before '['. Sequence mode: between values. */
  Start,
  /** After '[' or ',': a value, or ']' (an empty array; a trailing comma is tolerated). */
  ExpectValue,
  InValue,
  /** After a value in the array: ',' or ']'. */
  AfterValue,
  Done,
}

const WHITESPACE = new Set([32, 9, 10, 13, 0xfeff]);

/**
 * Incremental JSON reader. `array` mode reads one top-level array and yields its elements;
 * `sequence` mode yields every top-level value of concatenated or newline-delimited JSON.
 */
export class JsonStreamParser {
  private phase = Phase.Start;
  private pieces: string[] = [];
  private depth = 0;
  private inString = false;
  private escape = false;
  private scalar = false;
  private line = 1;
  private elementLine = 1;
  private sawAnything = false;
  private ended = false;

  private mode: 'array' | 'sequence' | 'auto';

  /** `auto` reads an array when the input starts with '[' and a sequence of values otherwise. */
  constructor(mode: 'array' | 'sequence' | 'auto' = 'array') {
    this.mode = mode;
  }

  push(text: string): JsonElements {
    if (this.ended) throw new Error('JsonStreamParser.push() called after end()');
    const out: JsonElements = { elements: [], lines: [], errors: [] };
    this.parse(text, out);
    return out;
  }

  end(): JsonElements {
    const out: JsonElements = { elements: [], lines: [], errors: [] };
    if (this.ended) return out;
    this.ended = true;
    if (this.phase === Phase.InValue) {
      if (this.scalar) this.complete(this.pieces.join(''), out);
      else throw syntaxError('unexpected end of input inside a value', this.elementLine);
    }
    if (this.mode === 'array' && this.sawAnything && this.phase !== Phase.Done) {
      throw syntaxError("unexpected end of input: the array is missing its closing ']'", this.line);
    }
    return out;
  }

  private complete(text: string, out: JsonElements): void {
    this.pieces = [];
    out.elements.push(parseJsonElement(text, this.elementLine));
    out.lines.push(this.elementLine);
  }

  private parse(text: string, out: JsonElements): void {
    const n = text.length;
    let i = 0;
    /** Newlines are counted up to `counted`, lazily, when a line number is needed. */
    let counted = 0;
    const lineAt = (at: number): number => {
      this.line += countNewlines(text, counted, at);
      counted = at;
      return this.line;
    };
    let start = 0;
    while (i < n) {
      if (this.phase === Phase.InValue) {
        let end = -1;
        if (this.inString) {
          // A string: find its closing quote, skipping escapes.
          for (; i < n; i++) {
            const c = text.charCodeAt(i);
            if (this.escape) this.escape = false;
            else if (c === 92) this.escape = true;
            else if (c === 34) {
              this.inString = false;
              if (this.depth === 0) end = i + 1;
              i++;
              break;
            }
          }
        } else if (this.scalar) {
          for (; i < n; i++) {
            const c = text.charCodeAt(i);
            if (c === 44 || c === 93 || c === 125 || WHITESPACE.has(c)) {
              end = i;
              break;
            }
          }
        } else {
          for (; i < n; i++) {
            const c = text.charCodeAt(i);
            if (c === 34) {
              this.inString = true;
              i++;
              break;
            }
            if (c === 123 || c === 91) this.depth++;
            else if (c === 125 || c === 93) {
              this.depth--;
              if (this.depth === 0) {
                end = i + 1;
                i++;
                break;
              }
            }
          }
        }
        if (end < 0) continue;
        const piece = text.slice(start, end);
        const whole = this.pieces.length > 0 ? this.pieces.join('') + piece : piece;
        this.complete(whole, out);
        this.scalar = false;
        this.phase = this.mode === 'array' ? Phase.AfterValue : Phase.Start;
        i = end;
        continue;
      }
      const c = text.charCodeAt(i);
      if (WHITESPACE.has(c)) {
        i++;
        continue;
      }
      this.sawAnything = true;
      switch (this.phase) {
        case Phase.Start:
          if (this.mode === 'auto') this.mode = c === 91 ? 'array' : 'sequence';
          if (this.mode === 'array') {
            if (c !== 91) {
              throw syntaxError(
                'expected a top-level array of rows; use JSON Lines for one object per line',
                lineAt(i),
              );
            }
            this.phase = Phase.ExpectValue;
            i++;
          } else {
            start = i;
            i = this.startValue(c, i, lineAt(i));
          }
          break;
        case Phase.ExpectValue:
          if (c === 93) {
            this.phase = Phase.Done;
            i++;
          } else {
            start = i;
            i = this.startValue(c, i, lineAt(i));
          }
          break;
        case Phase.AfterValue:
          if (c === 44) this.phase = Phase.ExpectValue;
          else if (c === 93) this.phase = Phase.Done;
          else throw syntaxError("expected ',' or ']' after an array element", lineAt(i));
          i++;
          break;
        case Phase.Done:
          throw syntaxError('unexpected text after the top-level array', lineAt(i));
      }
    }
    if (this.phase === Phase.InValue) this.pieces.push(text.slice(start, n));
    lineAt(n);
  }

  /** Starts scanning a value whose first character `c` is at `at`; returns where to go on. */
  private startValue(c: number, at: number, line: number): number {
    const valid =
      c === 123 ||
      c === 91 ||
      c === 34 ||
      c === 45 ||
      isDigit(c) ||
      c === 116 ||
      c === 102 ||
      c === 110;
    if (!valid) throw syntaxError(`unexpected character '${String.fromCharCode(c)}'`, line);
    this.phase = Phase.InValue;
    this.elementLine = line;
    this.depth = 0;
    this.escape = false;
    this.inString = c === 34;
    this.scalar = c !== 123 && c !== 91 && c !== 34;
    // A string's opening quote is consumed here; containers count their own bracket.
    return c === 34 ? at + 1 : at;
  }
}

/**
 * JSON Lines: one value per line. A line that does not parse is reported in `errors` with its
 * line number and reading continues, so an import can skip it.
 */
export class JsonLinesParser {
  private partial = '';
  private line = 1;
  private ended = false;

  push(text: string): JsonElements {
    if (this.ended) throw new Error('JsonLinesParser.push() called after end()');
    const out: JsonElements = { elements: [], lines: [], errors: [] };
    let from = 0;
    for (let at = text.indexOf('\n'); at >= 0; at = text.indexOf('\n', from)) {
      const piece = text.slice(from, at);
      const line = this.partial.length > 0 ? this.partial + piece : piece;
      this.partial = '';
      this.parseLine(line, out);
      from = at + 1;
    }
    if (from < text.length) this.partial += text.slice(from);
    return out;
  }

  end(): JsonElements {
    const out: JsonElements = { elements: [], lines: [], errors: [] };
    if (this.ended) return out;
    this.ended = true;
    if (this.partial.length > 0) this.parseLine(this.partial, out);
    this.partial = '';
    return out;
  }

  private parseLine(raw: string, out: JsonElements): void {
    const line = this.line++;
    let text = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (line === 1 && text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    if (text.trim() === '') return;
    try {
      out.elements.push(parseJsonElement(text, line));
      out.lines.push(line);
    } catch (error) {
      out.errors.push({
        line,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
