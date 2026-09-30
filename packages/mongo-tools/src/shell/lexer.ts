import { ShellParseError } from './errors';

/**
 * The tokenizer for mongosh-style literals. It knows no operators beyond the punctuation a
 * literal needs, so a `/` that does not open a comment always starts a regular expression.
 */

export type TokenKind = 'punct' | 'ident' | 'string' | 'number' | 'regex' | 'eof';

export interface Token {
  readonly kind: TokenKind;
  /**
   * Punctuation character, identifier name, decoded string, number literal text (without
   * separators) or regular expression pattern.
   */
  readonly value: string;
  /** Regular expression flags. */
  readonly flags?: string;
  /** 0-based offsets into the text. */
  readonly start: number;
  readonly end: number;
}

const PUNCT = new Set(['{', '}', '[', ']', '(', ')', ',', ':', '.', ';', '-', '+']);
const ID_START = /[\p{ID_Start}$_]/u;
const ID_CONTINUE = /[\p{ID_Continue}$‌‍]/u;

function isLineTerminator(c: string): boolean {
  return c === '\n' || c === '\r' || c === ' ' || c === ' ';
}

function isWhitespace(c: string): boolean {
  return (
    c === ' ' ||
    c === '\t' ||
    c === '\v' ||
    c === '\f' ||
    c === ' ' ||
    c === '﻿' ||
    isLineTerminator(c) ||
    /\p{Zs}/u.test(c)
  );
}

function isDigit(c: string | undefined): boolean {
  return c !== undefined && c >= '0' && c <= '9';
}

export class Lexer {
  private pos = 0;
  private peeked: Token | undefined;

  constructor(readonly text: string) {}

  fail(offset: number, reason: string, hint?: string): never {
    throw new ShellParseError(this.text, offset, reason, hint);
  }

  peek(): Token {
    this.peeked ??= this.scan();
    return this.peeked;
  }

  next(): Token {
    const token = this.peek();
    this.peeked = undefined;
    return token;
  }

  /** The code point at `pos` as a string (one or two UTF-16 units). */
  private charAt(pos: number): string {
    const code = this.text.codePointAt(pos);
    return code === undefined ? '' : String.fromCodePoint(code);
  }

  private skipTrivia(): void {
    const text = this.text;
    while (this.pos < text.length) {
      const c = text[this.pos]!;
      if (isWhitespace(c)) {
        this.pos += 1;
      } else if (c === '/' && text[this.pos + 1] === '/') {
        this.pos += 2;
        while (this.pos < text.length && !isLineTerminator(text[this.pos]!)) this.pos += 1;
      } else if (c === '/' && text[this.pos + 1] === '*') {
        const close = text.indexOf('*/', this.pos + 2);
        if (close === -1) this.fail(this.pos, 'Unterminated comment');
        this.pos = close + 2;
      } else {
        return;
      }
    }
  }

  private scan(): Token {
    this.skipTrivia();
    const text = this.text;
    const start = this.pos;
    if (start >= text.length) return { kind: 'eof', value: '', start, end: start };
    const c = text[start]!;
    if (c === '"' || c === "'" || c === '`') return this.scanString(c);
    if (isDigit(c) || (c === '.' && isDigit(text[start + 1]))) return this.scanNumber();
    if (c === '/') return this.scanRegex();
    if (PUNCT.has(c)) {
      this.pos += 1;
      return { kind: 'punct', value: c, start, end: this.pos };
    }
    const ch = this.charAt(start);
    if (ID_START.test(ch) || ch === '\\') return this.scanIdentifier();
    return this.fail(start, `Unexpected character ${JSON.stringify(ch)}`);
  }

  private scanIdentifier(): Token {
    const start = this.pos;
    let name = '';
    while (this.pos < this.text.length) {
      const ch = this.charAt(this.pos);
      if (ch === '\\') {
        this.fail(this.pos, 'Escapes are not supported in names; quote the name instead');
      }
      if (!(name === '' ? ID_START.test(ch) : ID_CONTINUE.test(ch))) break;
      name += ch;
      this.pos += ch.length;
    }
    return { kind: 'ident', value: name, start, end: this.pos };
  }

  private scanNumber(): Token {
    const text = this.text;
    const start = this.pos;
    let raw = '';
    const digits = (valid: (c: string) => boolean): void => {
      let last = '';
      while (this.pos < text.length) {
        const ch = text[this.pos]!;
        if (ch === '_') {
          if (!valid(last) || !valid(text[this.pos + 1] ?? '')) {
            this.fail(this.pos, 'Numeric separators must sit between digits');
          }
          this.pos += 1;
          last = ch;
          continue;
        }
        if (!valid(ch)) break;
        raw += ch;
        last = ch;
        this.pos += 1;
      }
    };
    const prefix = text.slice(start, start + 2).toLowerCase();
    const radix = prefix === '0x' ? 16 : prefix === '0o' ? 8 : prefix === '0b' ? 2 : 10;
    if (radix !== 10) {
      raw = text.slice(start, start + 2).toLowerCase();
      this.pos += 2;
      const valid =
        radix === 16
          ? (ch: string) => /^[0-9a-fA-F]$/.test(ch)
          : radix === 8
            ? (ch: string) => /^[0-7]$/.test(ch)
            : (ch: string) => ch === '0' || ch === '1';
      const before = raw.length;
      digits(valid);
      if (raw.length === before) this.fail(start, 'Expected digits after the number prefix');
    } else {
      digits(isDigit);
      if (raw.length > 1 && raw[0] === '0') {
        this.fail(start, 'Numbers cannot start with 0', 'Remove the leading zeros');
      }
      if (text[this.pos] === '.') {
        raw += '.';
        this.pos += 1;
        digits(isDigit);
      }
      if (text[this.pos] === 'e' || text[this.pos] === 'E') {
        raw += 'e';
        this.pos += 1;
        if (text[this.pos] === '+' || text[this.pos] === '-') {
          raw += text[this.pos];
          this.pos += 1;
        }
        const before = raw.length;
        digits(isDigit);
        if (raw.length === before) this.fail(start, 'Expected digits in the exponent');
      }
    }
    if (text[this.pos] === 'n') {
      if (radix === 10 && (raw.includes('.') || raw.includes('e'))) {
        this.fail(start, 'A BigInt literal must be an integer');
      }
      raw += 'n';
      this.pos += 1;
    }
    const after = this.charAt(this.pos);
    if (after !== '' && (ID_CONTINUE.test(after) || after === '\\')) {
      this.fail(this.pos, 'Unexpected character after a number');
    }
    return { kind: 'number', value: raw, start, end: this.pos };
  }

  private scanString(quote: string): Token {
    const text = this.text;
    const start = this.pos;
    this.pos += 1;
    let value = '';
    for (;;) {
      if (this.pos >= text.length) this.fail(start, 'Unterminated string');
      const c = text[this.pos]!;
      if (c === quote) {
        this.pos += 1;
        return { kind: 'string', value, start, end: this.pos };
      }
      if (quote === '`' && c === '$' && text[this.pos + 1] === '{') {
        this.fail(this.pos, 'Template substitutions are not supported', 'Write the value itself');
      }
      if (c === '\\') {
        value += this.scanEscape(quote);
        continue;
      }
      if (quote !== '`' && (c === '\n' || c === '\r')) {
        this.fail(this.pos, 'Unterminated string', 'Use \\n for a line break inside a string');
      }
      value += c;
      this.pos += 1;
    }
  }

  /** Reads one escape sequence at `pos` (the backslash) and returns what it stands for. */
  private scanEscape(quote: string): string {
    const text = this.text;
    const at = this.pos;
    const c = text[at + 1];
    this.pos += 2;
    switch (c) {
      case undefined:
        return this.fail(at, 'Unterminated string');
      case 'n':
        return '\n';
      case 'r':
        return '\r';
      case 't':
        return '\t';
      case 'b':
        return '\b';
      case 'f':
        return '\f';
      case 'v':
        return '\v';
      case '0':
        if (isDigit(text[this.pos])) this.fail(at, 'Octal escapes are not supported');
        return '\0';
      case 'x': {
        const hex = text.slice(this.pos, this.pos + 2);
        if (!/^[0-9a-fA-F]{2}$/.test(hex)) this.fail(at, 'Invalid \\x escape');
        this.pos += 2;
        return String.fromCharCode(parseInt(hex, 16));
      }
      case 'u': {
        if (text[this.pos] === '{') {
          const close = text.indexOf('}', this.pos);
          const hex = close === -1 ? '' : text.slice(this.pos + 1, close);
          const code = /^[0-9a-fA-F]{1,6}$/.test(hex) ? parseInt(hex, 16) : NaN;
          if (!(code <= 0x10ffff)) this.fail(at, 'Invalid \\u{...} escape');
          this.pos = close + 1;
          return String.fromCodePoint(code);
        }
        const hex = text.slice(this.pos, this.pos + 4);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) this.fail(at, 'Invalid \\u escape');
        this.pos += 4;
        return String.fromCharCode(parseInt(hex, 16));
      }
      case '\r':
        if (text[this.pos] === '\n') this.pos += 1;
        return '';
      case '\n':
      case ' ':
      case ' ':
        return '';
      default:
        if (isDigit(c) && quote !== '`') this.fail(at, 'Octal escapes are not supported');
        // Identity escape; keep astral characters whole.
        this.pos = at + 1;
        {
          const ch = this.charAt(this.pos);
          this.pos += ch.length;
          return ch;
        }
    }
  }

  private scanRegex(): Token {
    const text = this.text;
    const start = this.pos;
    let pos = start + 1;
    let inClass = false;
    for (;;) {
      const c = text[pos];
      if (c === undefined || isLineTerminator(c)) {
        this.fail(start, 'Unterminated regular expression');
      }
      if (c === '\\') {
        const next = text[pos + 1];
        if (next === undefined || isLineTerminator(next)) {
          this.fail(start, 'Unterminated regular expression');
        }
        pos += 2;
        continue;
      }
      if (c === '[') inClass = true;
      else if (c === ']') inClass = false;
      else if (c === '/' && !inClass) break;
      pos += 1;
    }
    const pattern = text.slice(start + 1, pos);
    pos += 1;
    let flags = '';
    while (pos < text.length && /[A-Za-z]/.test(text[pos]!)) {
      flags += text[pos];
      pos += 1;
    }
    this.pos = pos;
    return { kind: 'regex', value: pattern, flags, start, end: pos };
  }
}
