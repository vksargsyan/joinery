import type { SqlDialect } from '@querybara/core';

/**
 * A dialect-aware SQL lexer shared by the splitter, parameter finder, safety analysis, formatter
 * and the editor's language worker. It never throws: malformed input (an unterminated string,
 * comment or quoted identifier) extends to the end of the text and is flagged `unterminated`.
 *
 * Offsets are UTF-16 code unit indices into the input, the same unit Monaco and String#slice use.
 */

export type TokenKind =
  | 'whitespace'
  /** `-- ...`, and `# ...` in MySQL/MariaDB. Ends before the line break. */
  | 'line-comment'
  /** `/* ... *\/`, nested in PostgreSQL. Includes MySQL optimizer hints (`/*+ ... *\/`). */
  | 'block-comment'
  /** MySQL `/*! ... *\/` and MariaDB `/*M! ... *\/`: comments the server executes. */
  | 'executable-comment'
  /** Any single-quoted literal (with its E, U&, N, X or B prefix) and MySQL double-quoted strings. */
  | 'string'
  /** PostgreSQL `$tag$ ... $tag$`. */
  | 'dollar-string'
  /** PostgreSQL `"..."` and `U&"..."`, MySQL `` `...` ``. */
  | 'quoted-identifier'
  /** Keywords and unquoted identifiers alike. */
  | 'word'
  | 'number'
  /** `$1`, `:name`, and `?` in MySQL/MariaDB (in PostgreSQL `?` is a jsonb operator). */
  | 'parameter'
  /** MySQL/MariaDB `@user_var` and `@@system_var`. */
  | 'variable'
  | 'operator'
  /** `( ) [ ] { } , . ;` and a lone `:`. `;` is a `delimiter` while it is the delimiter. */
  | 'punctuation'
  /** The current statement delimiter: `;`, or whatever a MySQL DELIMITER command set. */
  | 'delimiter'
  /** A MySQL client `DELIMITER <string>` line. The client consumes it; the server never sees it. */
  | 'client-command'
  /** A character that starts no token, such as a stray backslash. */
  | 'other';

export interface Token {
  readonly kind: TokenKind;
  readonly text: string;
  readonly start: number;
  /** Exclusive. */
  readonly end: number;
  /** A string, quoted identifier or comment that reached the end of the input unclosed. */
  readonly unterminated?: boolean;
}

export interface TokenizeOptions {
  /** The delimiter in effect at the start of the text. Defaults to `;`. */
  readonly delimiter?: string;
}

/** Whitespace and ordinary comments: tokens the server ignores. Executable comments are not trivia. */
export function isTrivia(kind: TokenKind): boolean {
  return kind === 'whitespace' || kind === 'line-comment' || kind === 'block-comment';
}

/** Splits the whole text into tokens. Concatenating the token texts gives back the input. */
export function tokenize(text: string, dialect: SqlDialect, options?: TokenizeOptions): Token[] {
  const scanner = new Scanner(dialect, options?.delimiter);
  scanner.load(text, 0, true);
  const tokens: Token[] = [];
  while (scanner.scan() === 'token') {
    const token: {
      kind: TokenKind;
      text: string;
      start: number;
      end: number;
      unterminated?: boolean;
    } = {
      kind: scanner.kind,
      text: text.slice(scanner.start, scanner.end),
      start: scanner.start,
      end: scanner.end,
    };
    if (scanner.unterminated) token.unterminated = true;
    tokens.push(token);
  }
  return tokens;
}

/** Tokens other than trivia, in order. */
export function significantTokens(
  text: string,
  dialect: SqlDialect,
  options?: TokenizeOptions,
): Token[] {
  return tokenize(text, dialect, options).filter((token) => !isTrivia(token.kind));
}

/** True for characters that can continue an unquoted identifier (letters, digits, `_`, `$`). */
function isIdentifierPart(code: number): boolean {
  return (
    (code >= 97 && code <= 122) ||
    (code >= 65 && code <= 90) ||
    (code >= 48 && code <= 57) ||
    code === 95 ||
    code === 36 ||
    (code >= 0x80 && code !== BOM)
  );
}

function isIdentifierStart(code: number): boolean {
  return (
    (code >= 97 && code <= 122) ||
    (code >= 65 && code <= 90) ||
    code === 95 ||
    (code >= 0x80 && code !== BOM)
  );
}

function isDigit(code: number): boolean {
  return code >= 48 && code <= 57;
}

function isHexDigit(code: number): boolean {
  return isDigit(code) || (code >= 97 && code <= 102) || (code >= 65 && code <= 70);
}

const TAB = 9;
const LF = 10;
const VT = 11;
const FF = 12;
const CR = 13;
const SPACE = 32;
const BANG = 33;
const DQUOTE = 34;
const HASH = 35;
const DOLLAR = 36;
const AMP = 38;
const QUOTE = 39;
const STAR = 42;
const PLUS = 43;
const MINUS = 45;
const DOT = 46;
const SLASH = 47;
const COLON = 58;
const EQUALS = 61;
const QUESTION = 63;
const AT = 64;
const BACKSLASH = 92;
const BACKTICK = 96;
const BOM = 0xfeff;

/** peek() results past the end: the input has ended, or more input may still arrive. */
const EOF = -1;
const NEED = -2;

function isSpace(code: number): boolean {
  return code === SPACE || code === TAB || code === FF || code === VT || code === BOM;
}

function isPunctuation(code: number): boolean {
  // ( ) , . ; [ ] { }
  return (
    code === 40 ||
    code === 41 ||
    code === 44 ||
    code === DOT ||
    code === 59 ||
    code === 91 ||
    code === 93 ||
    code === 123 ||
    code === 125
  );
}

/** PostgreSQL operator characters: + - * / < > = ~ ! @ # % ^ & | ` ? */
function isPgOperatorChar(code: number): boolean {
  switch (code) {
    case PLUS:
    case MINUS:
    case STAR:
    case SLASH:
    case 60:
    case 62:
    case EQUALS:
    case 126:
    case BANG:
    case AT:
    case HASH:
    case 37:
    case 94:
    case AMP:
    case 124:
    case BACKTICK:
    case QUESTION:
      return true;
    default:
      return false;
  }
}

/** MySQL operator characters: + - * / < > = ~ ! % ^ & | */
function isMysqlOperatorChar(code: number): boolean {
  switch (code) {
    case PLUS:
    case MINUS:
    case STAR:
    case SLASH:
    case 60:
    case 62:
    case EQUALS:
    case 126:
    case BANG:
    case 37:
    case 94:
    case AMP:
    case 124:
      return true;
    default:
      return false;
  }
}

/** A long token whose body continues past the end of the current window. */
type Continuation =
  | {
      readonly type: 'quoted';
      readonly kind: 'string' | 'quoted-identifier';
      readonly start: number;
      readonly quote: number;
      readonly backslash: boolean;
    }
  | {
      readonly type: 'block';
      readonly kind: 'block-comment' | 'executable-comment';
      readonly start: number;
      depth: number;
    }
  | { readonly type: 'line'; readonly start: number }
  | { readonly type: 'dollar'; readonly start: number; readonly tag: string };

export type ScanResult = 'token' | 'more' | 'eof';

/**
 * The resumable scanner behind `tokenize` and the splitters. It works on a window of the input
 * (`load`). When a token might continue past the end of a non-final window it answers 'more' and
 * the caller reloads a window starting at `resumeOffset`; long bodies (strings, comments, dollar
 * quotes) resume mid-token, so a huge literal is scanned once however the input is chunked.
 *
 * Internal: exported for the splitter, not from the package entry point.
 */
export class Scanner {
  private readonly mysqlFamily: boolean;
  private readonly mariadb: boolean;
  private readonly postgres: boolean;

  private src = '';
  private base = 0;
  private pos = 0;
  private final = false;
  /** Code of the character before the next token (-1 at the start of input). */
  private prevCode = -1;
  private cont: Continuation | null = null;
  private delimiterValue: string;
  private delimiterCode: number;
  /** A significant token has been seen since the last delimiter (MySQL DELIMITER rule). */
  private dirty = false;

  kind: TokenKind = 'whitespace';
  start = 0;
  end = 0;
  unterminated = false;

  constructor(dialect: SqlDialect, delimiter = ';') {
    this.mysqlFamily = dialect !== 'postgres';
    this.mariadb = dialect === 'mariadb';
    this.postgres = dialect === 'postgres';
    this.delimiterValue = delimiter;
    this.delimiterCode = delimiter.length > 0 ? delimiter.charCodeAt(0) : -1;
  }

  get delimiter(): string {
    return this.delimiterValue;
  }

  /** Absolute offset the next window must start at. */
  get resumeOffset(): number {
    return this.base + this.pos;
  }

  /** Absolute start of a long token still in progress, if any. */
  get pendingTokenStart(): number | undefined {
    return this.cont?.start;
  }

  /** Replaces the window. `text` starts at absolute offset `base`, which must be resumeOffset. */
  load(text: string, base: number, final: boolean): void {
    this.src = text;
    this.base = base;
    this.pos = 0;
    this.final = final;
  }

  /** Text of the current token; only valid for tokens that started in this window. */
  tokenText(): string {
    return this.src.slice(this.start - this.base, this.end - this.base);
  }

  scan(): ScanResult {
    if (this.cont) return this.continueBody(this.cont, this.pos);
    const src = this.src;
    const p = this.pos;
    if (p >= src.length) return this.final ? 'eof' : 'more';
    const c = src.charCodeAt(p);

    if (
      this.mysqlFamily &&
      !this.dirty &&
      (this.prevCode === -1 || this.prevCode === LF || this.prevCode === CR) &&
      (c === SPACE || c === TAB || c === 100 || c === 68)
    ) {
      const command = this.scanClientCommand(p);
      if (command !== 'no') return command;
    }

    if (c === this.delimiterCode) {
      const match = this.delimiterAt(p);
      if (match === NEED) return 'more';
      if (match === 1) {
        this.dirty = false;
        return this.finish('delimiter', p, p + this.delimiterValue.length);
      }
    }

    if (c === LF) return this.finish('whitespace', p, p + 1);
    if (isSpace(c) || c === CR) return this.scanWhitespace(p);

    switch (c) {
      case QUOTE:
        return this.startQuoted(p, p + 1, 'string', QUOTE, this.mysqlFamily);
      case DQUOTE:
        return this.mysqlFamily
          ? this.startQuoted(p, p + 1, 'string', DQUOTE, true)
          : this.startQuoted(p, p + 1, 'quoted-identifier', DQUOTE, false);
      case BACKTICK:
        if (this.mysqlFamily)
          return this.startQuoted(p, p + 1, 'quoted-identifier', BACKTICK, false);
        break;
      case MINUS: {
        const next = this.peek(p + 1);
        if (next === NEED) return 'more';
        if (next === MINUS) {
          if (this.postgres) return this.startLineComment(p, 2);
          // MySQL: "--" starts a comment only when followed by whitespace, a control char or EOF.
          const third = this.peek(p + 2);
          if (third === NEED) return 'more';
          if (third === EOF || third <= SPACE || third === 127) return this.startLineComment(p, 2);
        }
        break;
      }
      case HASH:
        if (this.mysqlFamily) return this.startLineComment(p, 1);
        break;
      case SLASH: {
        const next = this.peek(p + 1);
        if (next === NEED) return 'more';
        if (next === STAR) return this.startBlockComment(p);
        break;
      }
      case DOLLAR:
        return this.scanDollar(p);
      case COLON:
        return this.scanColon(p);
      case QUESTION:
        if (this.mysqlFamily) return this.finishSignificant('parameter', p, p + 1);
        break;
      case AT:
        if (this.mysqlFamily) return this.scanVariable(p);
        break;
      default:
        break;
    }

    if (isDigit(c)) return this.scanNumber(p);
    if (c === DOT) {
      const next = this.peek(p + 1);
      if (next === NEED) return 'more';
      if (isDigit(next)) return this.scanNumber(p);
      return this.finishSignificant('punctuation', p, p + 1);
    }
    if (isPunctuation(c)) return this.finishSignificant('punctuation', p, p + 1);
    if (isIdentifierStart(c)) return this.scanWord(p);
    if (this.postgres ? isPgOperatorChar(c) : isMysqlOperatorChar(c)) return this.scanOperator(p);
    return this.finishSignificant('other', p, p + 1);
  }

  /** Code at window index i; EOF past the end of final input, NEED when more input may follow. */
  private peek(i: number): number {
    if (i < this.src.length) return this.src.charCodeAt(i);
    return this.final ? EOF : NEED;
  }

  /** 1 if the delimiter starts at p, 0 if not, NEED if the window ends inside a partial match. */
  private delimiterAt(p: number): number {
    const delimiter = this.delimiterValue;
    const src = this.src;
    for (let k = 0; k < delimiter.length; k++) {
      if (p + k >= src.length) return this.final ? 0 : NEED;
      if (src.charCodeAt(p + k) !== delimiter.charCodeAt(k)) return 0;
    }
    return 1;
  }

  /** True when the delimiter starts at i inside a run (words, numbers, operators). */
  private runStopsAt(i: number, code: number): boolean | typeof NEED {
    if (code !== this.delimiterCode) return false;
    const match = this.delimiterAt(i);
    return match === NEED ? NEED : match === 1;
  }

  private finish(kind: TokenKind, relStart: number, relEnd: number, unterminated = false): 'token' {
    return this.finishAbs(kind, this.base + relStart, relEnd, unterminated);
  }

  private finishSignificant(kind: TokenKind, relStart: number, relEnd: number): 'token' {
    this.dirty = true;
    return this.finish(kind, relStart, relEnd);
  }

  private finishAbs(
    kind: TokenKind,
    absStart: number,
    relEnd: number,
    unterminated = false,
  ): 'token' {
    this.kind = kind;
    this.start = absStart;
    this.end = this.base + relEnd;
    this.unterminated = unterminated;
    // A token that ends at the very start of the window keeps the prevCode set by suspend().
    if (relEnd > 0) this.prevCode = this.src.charCodeAt(relEnd - 1);
    this.pos = relEnd;
    return 'token';
  }

  /** Parks a long token: the next window starts at `resumeAt` inside its body. */
  private suspend(cont: Continuation, resumeAt: number): 'more' {
    this.cont = cont;
    if (resumeAt > 0) this.prevCode = this.src.charCodeAt(resumeAt - 1);
    this.pos = resumeAt;
    return 'more';
  }

  private scanWhitespace(p: number): ScanResult {
    let i = p;
    for (;;) {
      const code = this.peek(i);
      if (code === NEED) return 'more';
      if (code === LF) return this.finish('whitespace', p, i + 1);
      if (code === CR) {
        const next = this.peek(i + 1);
        if (next === NEED) return 'more';
        return this.finish('whitespace', p, next === LF ? i + 2 : i + 1);
      }
      if (!isSpace(code)) return this.finish('whitespace', p, i);
      i++;
    }
  }

  /**
   * MySQL client `DELIMITER <string>`: first word of a line, recognised only between statements
   * (like the mysql client, which honours it only while its statement buffer is empty).
   */
  private scanClientCommand(p: number): ScanResult | 'no' {
    let i = p;
    let code = this.peek(i);
    while (code === SPACE || code === TAB) code = this.peek(++i);
    if (code === NEED) return 'more';
    const keyword = 'delimiter';
    for (let k = 0; k < keyword.length; k++) {
      code = this.peek(i + k);
      if (code === NEED) return 'more';
      if ((code | 0x20) !== keyword.charCodeAt(k)) return 'no';
    }
    i += keyword.length;
    code = this.peek(i);
    if (code === NEED) return 'more';
    if (code !== SPACE && code !== TAB) return 'no';
    while (code === SPACE || code === TAB) code = this.peek(++i);
    if (code === NEED) return 'more';
    if (code === EOF || code === LF || code === CR) return 'no';
    const argStart = i;
    while (
      code !== EOF &&
      code !== NEED &&
      code !== SPACE &&
      code !== TAB &&
      code !== LF &&
      code !== CR
    ) {
      code = this.peek(++i);
    }
    if (code === NEED) return 'more';
    const argEnd = i;
    while (code !== EOF && code !== NEED && code !== LF && code !== CR) code = this.peek(++i);
    if (code === NEED) return 'more';
    let arg = this.src.slice(argStart, argEnd);
    const first = arg.charCodeAt(0);
    if (
      arg.length >= 2 &&
      (first === QUOTE || first === DQUOTE || first === BACKTICK) &&
      arg.charCodeAt(arg.length - 1) === first
    ) {
      arg = arg.slice(1, -1);
    }
    if (arg.length > 0) {
      this.delimiterValue = arg;
      this.delimiterCode = arg.charCodeAt(0);
    }
    this.dirty = false;
    return this.finish('client-command', p, i);
  }

  private startQuoted(
    p: number,
    bodyFrom: number,
    kind: 'string' | 'quoted-identifier',
    quote: number,
    backslash: boolean,
  ): ScanResult {
    this.dirty = true;
    return this.scanQuotedBody(
      { type: 'quoted', kind, start: this.base + p, quote, backslash },
      bodyFrom,
    );
  }

  private startLineComment(p: number, openerLength: number): ScanResult {
    return this.scanLineBody({ type: 'line', start: this.base + p }, p + openerLength);
  }

  private startBlockComment(p: number): ScanResult {
    // p points at "/*". MySQL: "/*!" executes; MariaDB also "/*M!". PostgreSQL nests.
    let kind: 'block-comment' | 'executable-comment' = 'block-comment';
    if (this.mysqlFamily) {
      const third = this.peek(p + 2);
      if (third === NEED) return 'more';
      if (third === BANG) kind = 'executable-comment';
      else if (this.mariadb && third === 77) {
        const fourth = this.peek(p + 3);
        if (fourth === NEED) return 'more';
        if (fourth === BANG) kind = 'executable-comment';
      }
    }
    if (kind === 'executable-comment') this.dirty = true;
    return this.scanBlockBody({ type: 'block', kind, start: this.base + p, depth: 1 }, p + 2);
  }

  private continueBody(cont: Continuation, from: number): ScanResult {
    this.cont = null;
    switch (cont.type) {
      case 'quoted':
        return this.scanQuotedBody(cont, from);
      case 'block':
        return this.scanBlockBody(cont, from);
      case 'line':
        return this.scanLineBody(cont, from);
      case 'dollar':
        return this.scanDollarBody(cont, from);
    }
  }

  private scanQuotedBody(cont: Continuation & { type: 'quoted' }, from: number): ScanResult {
    const src = this.src;
    const n = src.length;
    const { quote, backslash } = cont;
    let i = from;
    while (i < n) {
      const code = src.charCodeAt(i);
      if (code === quote) {
        if (i + 1 >= n) {
          if (!this.final) return this.suspend(cont, i);
          return this.finishAbs(cont.kind, cont.start, i + 1);
        }
        if (src.charCodeAt(i + 1) === quote) {
          i += 2;
          continue;
        }
        return this.finishAbs(cont.kind, cont.start, i + 1);
      }
      if (code === BACKSLASH && backslash) {
        if (i + 1 >= n && !this.final) return this.suspend(cont, i);
        i += 2;
        continue;
      }
      i++;
    }
    if (!this.final) return this.suspend(cont, n);
    return this.finishAbs(cont.kind, cont.start, n, true);
  }

  private scanBlockBody(cont: Continuation & { type: 'block' }, from: number): ScanResult {
    const src = this.src;
    const n = src.length;
    const nested = this.postgres;
    let i = from;
    while (i < n) {
      const code = src.charCodeAt(i);
      if (code === STAR || (nested && code === SLASH)) {
        if (i + 1 >= n) {
          if (!this.final) return this.suspend(cont, i);
          break;
        }
        const next = src.charCodeAt(i + 1);
        if (code === STAR && next === SLASH) {
          if (--cont.depth === 0) return this.finishAbs(cont.kind, cont.start, i + 2);
          i += 2;
          continue;
        }
        if (code === SLASH && next === STAR) {
          cont.depth++;
          i += 2;
          continue;
        }
      }
      i++;
    }
    if (!this.final) return this.suspend(cont, n);
    return this.finishAbs(cont.kind, cont.start, n, true);
  }

  private scanLineBody(cont: Continuation & { type: 'line' }, from: number): ScanResult {
    const src = this.src;
    const n = src.length;
    for (let i = from; i < n; i++) {
      const code = src.charCodeAt(i);
      if (code === LF || code === CR) return this.finishAbs('line-comment', cont.start, i);
    }
    if (!this.final) return this.suspend(cont, n);
    return this.finishAbs('line-comment', cont.start, n);
  }

  private scanDollarBody(cont: Continuation & { type: 'dollar' }, from: number): ScanResult {
    const close = this.src.indexOf(cont.tag, from);
    if (close >= 0) return this.finishAbs('dollar-string', cont.start, close + cont.tag.length);
    const n = this.src.length;
    // The tail may hold the first characters of the closing tag.
    if (!this.final) return this.suspend(cont, Math.max(from, n - cont.tag.length + 1));
    return this.finishAbs('dollar-string', cont.start, n, true);
  }

  /** `$tag$` quotes and `$n` parameters (PostgreSQL); `$n` parameters and `$`-words (MySQL). */
  private scanDollar(p: number): ScanResult {
    let i = p + 1;
    let code = this.peek(i);
    if (code === NEED) return 'more';
    if (isDigit(code)) {
      while (isDigit(code)) code = this.peek(++i);
      if (code === NEED) return 'more';
      if (this.mysqlFamily && isIdentifierPart(code)) return this.scanWord(p);
      return this.finishSignificant('parameter', p, i);
    }
    if (this.postgres) {
      if (code === DOLLAR || isIdentifierStart(code)) {
        while (code !== DOLLAR && (isIdentifierStart(code) || isDigit(code))) code = this.peek(++i);
        if (code === NEED) return 'more';
        if (code === DOLLAR) {
          const tag = this.src.slice(p, i + 1);
          this.dirty = true;
          return this.scanDollarBody({ type: 'dollar', start: this.base + p, tag }, i + 1);
        }
      }
      return this.finishSignificant('operator', p, p + 1);
    }
    if (isIdentifierPart(code)) return this.scanWord(p);
    return this.finishSignificant('other', p, p + 1);
  }

  /** `::` casts, `:=` assignments, `:name` parameters, otherwise a lone `:` (array slices, labels). */
  private scanColon(p: number): ScanResult {
    const next = this.peek(p + 1);
    if (next === NEED) return 'more';
    if (next === COLON || next === EQUALS) return this.finishSignificant('operator', p, p + 2);
    if (isIdentifierStart(next) && !isIdentifierPart(this.prevCode)) {
      let i = p + 2;
      let code = this.peek(i);
      while (isIdentifierPart(code) && code !== DOLLAR) code = this.peek(++i);
      if (code === NEED) return 'more';
      return this.finishSignificant('parameter', p, i);
    }
    return this.finishSignificant('punctuation', p, p + 1);
  }

  /** MySQL `@var`, `@@var`, `@@global.var`. A quoted name (`@'x'`) lexes as `@` then the quote. */
  private scanVariable(p: number): ScanResult {
    let i = p + 1;
    let code = this.peek(i);
    if (code === AT) code = this.peek(++i);
    while (code !== NEED && (isIdentifierPart(code) || code === DOT)) {
      const stop = this.runStopsAt(i, code);
      if (stop === NEED) return 'more';
      if (stop) break;
      code = this.peek(++i);
    }
    if (code === NEED) return 'more';
    return this.finishSignificant('variable', p, i);
  }

  private scanNumber(p: number): ScanResult {
    let i = p;
    let code = this.peek(i);
    const second = this.peek(p + 1);
    if (second === NEED) return 'more';
    if (
      code === 48 &&
      (second === 120 ||
        second === 88 ||
        second === 98 ||
        second === 66 ||
        second === 111 ||
        second === 79)
    ) {
      // 0x.., 0b.., 0o..
      const radix = second | 0x20;
      i = p + 2;
      code = this.peek(i);
      if (code === NEED) return 'more';
      const accept = (c: number): boolean =>
        c === 95 ||
        (radix === 120 ? isHexDigit(c) : radix === 98 ? c === 48 || c === 49 : c >= 48 && c <= 55);
      if (code !== NEED && accept(code)) {
        while (code !== NEED && accept(code)) code = this.peek(++i);
      } else {
        i = p + 1;
        code = this.peek(i);
      }
    } else {
      while (isDigit(code) || code === 95) code = this.peek(++i);
      if (code === DOT) {
        code = this.peek(++i);
        while (isDigit(code) || code === 95) code = this.peek(++i);
      }
      if (code === 101 || code === 69) {
        let j = i + 1;
        let exp = this.peek(j);
        if (exp === PLUS || exp === MINUS) exp = this.peek(++j);
        if (exp === NEED) return 'more';
        if (isDigit(exp)) {
          i = j;
          code = exp;
          while (isDigit(code)) code = this.peek(++i);
        }
      }
    }
    if (code === NEED) return 'more';
    // MySQL identifiers may start with digits: 2fa_codes, 1abc.
    if (this.mysqlFamily && isIdentifierPart(code)) return this.scanWord(p);
    return this.finishSignificant('number', p, i);
  }

  private scanWord(p: number): ScanResult {
    const first = this.src.charCodeAt(p);
    // Prefixed literals: E'..', N'..', X'..', B'..', U&'..' / U&"..".
    const second = this.peek(p + 1);
    if (second === NEED) return 'more';
    if (second === QUOTE) {
      const lower = first | 0x20;
      if (this.postgres && lower === 101) return this.startQuoted(p, p + 2, 'string', QUOTE, true);
      if (lower === 110 || lower === 120 || lower === 98) {
        return this.startQuoted(p, p + 2, 'string', QUOTE, this.mysqlFamily);
      }
    }
    if (this.postgres && (first | 0x20) === 117 && second === AMP) {
      const third = this.peek(p + 2);
      if (third === NEED) return 'more';
      if (third === QUOTE) return this.startQuoted(p, p + 3, 'string', QUOTE, false);
      if (third === DQUOTE) return this.startQuoted(p, p + 3, 'quoted-identifier', DQUOTE, false);
    }
    let i = p + 1;
    let code = second;
    while (code !== NEED && isIdentifierPart(code)) {
      const stop = this.runStopsAt(i, code);
      if (stop === NEED) return 'more';
      if (stop) break;
      code = this.peek(++i);
    }
    if (code === NEED) return 'more';
    return this.finishSignificant('word', p, i);
  }

  private scanOperator(p: number): ScanResult {
    const isOperatorChar = this.postgres ? isPgOperatorChar : isMysqlOperatorChar;
    let i = p + 1;
    let code = this.peek(i);
    while (code !== NEED && isOperatorChar(code)) {
      const stop = this.runStopsAt(i, code);
      if (stop === NEED) return 'more';
      if (stop) break;
      // A comment start ends the operator: "--", "/*" (and MySQL "-- ").
      if (code === MINUS || code === SLASH) {
        const next = this.peek(i + 1);
        if (next === NEED) return 'more';
        if (code === SLASH && next === STAR) break;
        if (code === MINUS && next === MINUS) {
          if (this.postgres) break;
          const third = this.peek(i + 2);
          if (third === NEED) return 'more';
          if (third === EOF || third <= SPACE || third === 127) break;
        }
      }
      code = this.peek(++i);
    }
    if (code === NEED) return 'more';
    return this.finishSignificant('operator', p, i);
  }
}
