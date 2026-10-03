import { QuerybaraError } from '@querybara/core';

/**
 * CSV and TSV (RFC 4180, spec §12). The parser is incremental: text is pushed in chunks of any
 * size and split anywhere (inside quotes, between CR and LF), and completed records come out
 * with the line they started on. Memory holds one partial record, never the file.
 *
 * Rules, beyond RFC 4180's quoted fields with doubled quotes and embedded line breaks:
 * - records end at LF, CRLF or a lone CR;
 * - an `escape` character other than the quote makes the next character literal, inside and
 *   outside quotes (MySQL `FIELDS ESCAPED BY '\\'`); doubled quotes are accepted as well;
 * - the NULL marker matches an unquoted field's raw text only, so `""` stays an empty string
 *   when the marker is empty (PostgreSQL COPY CSV semantics);
 * - text after a closing quote is kept (`"ab"c` → `abc`); a quote inside an unquoted field is
 *   literal;
 * - empty lines are skipped, except in single-column files where an empty line is a row.
 */

export interface CsvDialect {
  /** Field separator: one character. */
  readonly delimiter: string;
  /** Quote character, or null for no quoting. */
  readonly quote: string | null;
  /** Escape character: the quote itself (doubled quotes, the default), `\\`, or null. */
  readonly escape: string | null;
  /** Text of an unquoted field that means NULL (`''`, `\\N`, `NULL`), or null for none. */
  readonly nullMarker: string | null;
}

export interface CsvParseOptions extends Partial<CsvDialect> {
  /** 'auto' (default): skip empty lines unless the first record has a single field. */
  readonly emptyLines?: 'skip' | 'keep' | 'auto';
  /** Longest field accepted, in characters; guards against a stray quote swallowing a file. */
  readonly maxFieldLength?: number;
}

export type CsvField = string | null;

/** Records completed by one `push` or `end`, with the 1-based line each one starts on. */
export interface CsvRecords {
  readonly records: CsvField[][];
  readonly lines: number[];
}

const LF = 10;
const CR = 13;

const enum State {
  FieldStart,
  Unquoted,
  UnquotedEscape,
  Quoted,
  QuotedEscape,
  QuoteSeen,
  AfterQuoted,
  AfterCr,
}

function charCode(value: string | null | undefined, name: string): number {
  if (value === null || value === undefined) return -1;
  if (value.length !== 1) {
    throw new QuerybaraError({
      code: 'VALIDATION_FAILED',
      message: `The CSV ${name} must be a single character`,
    });
  }
  return value.charCodeAt(0);
}

/** Fills in defaults and validates a CSV dialect. */
export function csvDialect(options: Partial<CsvDialect> = {}): CsvDialect {
  const delimiter = options.delimiter ?? ',';
  const quote = options.quote === undefined ? '"' : options.quote;
  const escape = options.escape === undefined ? quote : options.escape;
  const d = charCode(delimiter, 'delimiter');
  const q = charCode(quote, 'quote');
  const e = charCode(escape, 'escape character');
  if (d === q || d === e || d === LF || d === CR || q === LF || q === CR) {
    throw new QuerybaraError({
      code: 'VALIDATION_FAILED',
      message:
        'The CSV delimiter, quote and escape characters must differ from each other and from line breaks',
    });
  }
  return {
    delimiter,
    quote,
    escape,
    nullMarker: options.nullMarker === undefined ? '' : options.nullMarker,
  };
}

/** Incremental CSV parser; see the module comment for the rules. */
export class CsvParser {
  private readonly d: number;
  private readonly q: number;
  private readonly e: number;
  /** Escape character other than the quote (backslash mode), else -1. */
  private readonly be: number;
  private readonly nullMarker: string | null;
  private readonly maxFieldLength: number;
  private emptyLines: 'skip' | 'keep' | 'auto';

  private state = State.FieldStart;
  private fields: CsvField[] = [];
  /** Current field text carried over from earlier chunks (raw for unquoted fields). */
  private acc = '';
  private escaped = false;
  /** Characters consumed before the current chunk. */
  private offset = 0;
  /** Absolute offset of the last CR seen, so CRLF counts as one line break. */
  private lastCr = -2;
  private line = 1;
  private recordLine = 1;
  private sawRecord = false;
  private ended = false;

  constructor(options: CsvParseOptions = {}) {
    const dialect = csvDialect(options);
    this.d = dialect.delimiter.charCodeAt(0);
    this.q = charCode(dialect.quote, 'quote');
    this.e = charCode(dialect.escape, 'escape character');
    this.be = this.e !== this.q ? this.e : -1;
    this.nullMarker = dialect.nullMarker;
    this.emptyLines = options.emptyLines ?? 'auto';
    this.maxFieldLength = options.maxFieldLength ?? 256 * 1024 * 1024;
  }

  /** Parses the next chunk and returns the records it completed. */
  push(text: string): CsvRecords {
    if (this.ended) throw new Error('CsvParser.push() called after end()');
    const out: CsvRecords = { records: [], lines: [] };
    this.parse(text, out);
    this.offset += text.length;
    if (this.acc.length > this.maxFieldLength) {
      throw new QuerybaraError({
        code: 'VALIDATION_FAILED',
        message: `A field starting on line ${this.recordLine} is longer than ${this.maxFieldLength} characters`,
        hint: 'Check the quote character: an unbalanced quote makes the rest of the file one field',
      });
    }
    return out;
  }

  /** Signals the end of input and returns the last record, if any. */
  end(): CsvRecords {
    const out: CsvRecords = { records: [], lines: [] };
    if (this.ended) return out;
    this.ended = true;
    switch (this.state) {
      case State.Quoted:
      case State.QuotedEscape:
        throw new QuerybaraError({
          code: 'VALIDATION_FAILED',
          message: `Unterminated quoted field in the record starting on line ${this.recordLine}`,
          hint: 'Check the quote and escape characters',
        });
      case State.Unquoted:
      case State.UnquotedEscape:
        this.fields.push(this.unquoted(this.acc));
        this.emit(out);
        break;
      case State.QuoteSeen:
      case State.AfterQuoted:
        this.fields.push(this.acc);
        this.emit(out);
        break;
      case State.FieldStart:
        if (this.fields.length > 0) {
          this.fields.push(this.unquoted(''));
          this.emit(out);
        }
        break;
      case State.AfterCr:
        break;
    }
    this.acc = '';
    return out;
  }

  private unquoted(raw: string): CsvField {
    const escaped = this.escaped;
    this.escaped = false;
    if (this.nullMarker !== null && raw === this.nullMarker) return null;
    return escaped ? unescapeRaw(raw, String.fromCharCode(this.be)) : raw;
  }

  private emit(out: CsvRecords): void {
    const fields = this.fields;
    this.fields = [];
    if (!this.sawRecord) {
      this.sawRecord = true;
      if (this.emptyLines === 'auto') this.emptyLines = fields.length === 1 ? 'keep' : 'skip';
    }
    out.records.push(fields);
    out.lines.push(this.recordLine);
  }

  /** A line break at absolute offset `at`: counts it unless it is the LF of a CRLF. */
  private lineBreak(code: number, at: number): void {
    if (code === CR) {
      this.line++;
      this.lastCr = at;
    } else if (this.lastCr !== at - 1) {
      this.line++;
    }
  }

  /** End of record at `text[i]` (CR or LF), with the record's last field already pushed. */
  private endRecord(code: number, i: number, out: CsvRecords): State {
    this.emit(out);
    this.lineBreak(code, this.offset + i);
    this.recordLine = this.line;
    return code === CR ? State.AfterCr : State.FieldStart;
  }

  private parse(text: string, out: CsvRecords): void {
    const n = text.length;
    const d = this.d;
    const q = this.q;
    const be = this.be;
    let state = this.state;
    let i = 0;
    let seg = 0;
    while (i < n) {
      switch (state) {
        case State.AfterCr: {
          if (text.charCodeAt(i) === LF) i++;
          state = State.FieldStart;
          break;
        }
        case State.FieldStart: {
          const c = text.charCodeAt(i);
          if (c === q) {
            state = State.Quoted;
            i++;
            seg = i;
          } else if (c === d) {
            this.fields.push(this.unquoted(''));
            i++;
          } else if (c === LF || c === CR) {
            if (this.fields.length > 0) {
              this.fields.push(this.unquoted(''));
              state = this.endRecord(c, i, out);
            } else if (this.emptyLines === 'keep') {
              this.fields.push(this.unquoted(''));
              state = this.endRecord(c, i, out);
            } else {
              this.lineBreak(c, this.offset + i);
              this.recordLine = this.line;
              state = c === CR ? State.AfterCr : State.FieldStart;
            }
            i++;
          } else {
            state = State.Unquoted;
            seg = i;
          }
          break;
        }
        case State.Unquoted: {
          let j = i;
          let c = 0;
          for (; j < n; j++) {
            c = text.charCodeAt(j);
            if (c === d || c === LF || c === CR || c === be) break;
          }
          if (j === n) {
            i = n;
            break;
          }
          if (c === be) {
            this.escaped = true;
            if (j + 1 < n) {
              const next = text.charCodeAt(j + 1);
              if (next === LF || next === CR) this.lineBreak(next, this.offset + j + 1);
              i = j + 2;
            } else {
              i = n;
              state = State.UnquotedEscape;
            }
            break;
          }
          const raw = this.acc.length > 0 ? this.acc + text.slice(seg, j) : text.slice(seg, j);
          this.acc = '';
          this.fields.push(this.unquoted(raw));
          if (c === d) {
            state = State.FieldStart;
          } else {
            state = this.endRecord(c, j, out);
          }
          i = j + 1;
          break;
        }
        case State.UnquotedEscape: {
          const c = text.charCodeAt(i);
          if (c === LF || c === CR) this.lineBreak(c, this.offset + i);
          state = State.Unquoted;
          i++;
          break;
        }
        case State.Quoted: {
          let j = i;
          let c = 0;
          for (; j < n; j++) {
            c = text.charCodeAt(j);
            if (c === q || c === be) break;
            if (c === LF || c === CR) this.lineBreak(c, this.offset + j);
          }
          if (j === n) {
            this.acc += text.slice(seg, n);
            i = n;
            break;
          }
          this.acc += text.slice(seg, j);
          if (c === be) {
            if (j + 1 < n) {
              const next = text.charCodeAt(j + 1);
              if (next === LF || next === CR) this.lineBreak(next, this.offset + j + 1);
              this.acc += text[j + 1]!;
              i = j + 2;
              seg = i;
            } else {
              state = State.QuotedEscape;
              i = n;
            }
            break;
          }
          // A quote: doubled (literal) or closing.
          if (j + 1 < n) {
            if (text.charCodeAt(j + 1) === q) {
              this.acc += text[j]!;
              i = j + 2;
              seg = i;
            } else {
              state = State.AfterQuoted;
              i = j + 1;
            }
          } else {
            state = State.QuoteSeen;
            i = n;
          }
          break;
        }
        case State.QuotedEscape: {
          const c = text.charCodeAt(i);
          if (c === LF || c === CR) this.lineBreak(c, this.offset + i);
          this.acc += text[i]!;
          i++;
          seg = i;
          state = State.Quoted;
          break;
        }
        case State.QuoteSeen: {
          if (text.charCodeAt(i) === q) {
            this.acc += text[i]!;
            i++;
            seg = i;
            state = State.Quoted;
          } else {
            state = State.AfterQuoted;
          }
          break;
        }
        case State.AfterQuoted: {
          const c = text.charCodeAt(i);
          if (c === d) {
            this.fields.push(this.acc);
            this.acc = '';
            state = State.FieldStart;
          } else if (c === LF || c === CR) {
            this.fields.push(this.acc);
            this.acc = '';
            state = this.endRecord(c, i, out);
          } else {
            this.acc += text[i]!;
          }
          i++;
          break;
        }
      }
    }
    if (state === State.Unquoted) this.acc += text.slice(seg, n);
    else if (state === State.UnquotedEscape) this.acc += text.slice(seg, n);
    this.state = state;
  }
}

/** Removes escape characters from an unquoted field: each escapes the character after it. */
function unescapeRaw(raw: string, escape: string): string {
  let out = '';
  let from = 0;
  for (let at = raw.indexOf(escape); at >= 0; at = raw.indexOf(escape, at + 2)) {
    out += raw.slice(from, at);
    if (at + 1 < raw.length) out += raw[at + 1]!;
    from = at + 2;
  }
  return out + raw.slice(Math.min(from, raw.length));
}

/** Parses a complete CSV text; for tests and small inputs. */
export function parseCsv(text: string, options: CsvParseOptions = {}): CsvField[][] {
  const parser = new CsvParser(options);
  const { records } = parser.push(text);
  records.push(...parser.end().records);
  return records;
}

// ---------------------------------------------------------------------------------------------
// Writing

export const CSV_QUOTING = ['minimal', 'all', 'non-numeric', 'none'] as const;
/**
 * When fields are quoted: `minimal` only when needed (delimiter, quote, escape or line break
 * inside, or text equal to the NULL marker); `all` every non-NULL field; `non-numeric` every
 * field of a non-numeric column; `none` never (special characters are escaped when an escape
 * character other than the quote is set, and written as they are otherwise).
 */
export type CsvQuoting = (typeof CSV_QUOTING)[number];

export interface CsvWriteOptions extends Partial<CsvDialect> {
  readonly quoting?: CsvQuoting;
  readonly lineEnding?: '\n' | '\r\n';
}

const escapeRe = (text: string): string => text.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&');

/** Formats records as CSV lines; the counterpart of CsvParser for the same dialect. */
export class CsvFormatter {
  private readonly delimiter: string;
  private readonly quote: string;
  private readonly escape: string | null;
  private readonly nullMarker: string;
  private readonly quoting: CsvQuoting;
  readonly lineEnding: string;
  private readonly special: RegExp;
  private readonly inQuotes: RegExp | null;

  constructor(options: CsvWriteOptions = {}) {
    const dialect = csvDialect(options);
    this.delimiter = dialect.delimiter;
    this.quote = dialect.quote ?? '"';
    this.escape = dialect.escape;
    this.nullMarker = dialect.nullMarker ?? '';
    this.quoting = dialect.quote === null ? 'none' : (options.quoting ?? 'minimal');
    this.lineEnding = options.lineEnding ?? '\r\n';
    const chars = [this.delimiter, this.quote, '\r', '\n'];
    if (this.escape !== null && this.escape !== this.quote) chars.push(this.escape);
    this.special = new RegExp(`[${chars.map(escapeRe).join('')}]`);
    this.inQuotes =
      this.escape !== null && this.escape !== this.quote
        ? new RegExp(`[${escapeRe(this.quote)}${escapeRe(this.escape)}]`, 'g')
        : null;
  }

  /** One field; `numeric` marks a number column for the `non-numeric` policy. */
  field(value: string | null, numeric = false): string {
    if (value === null) return this.nullMarker;
    switch (this.quoting) {
      case 'all':
        return this.quoted(value);
      case 'non-numeric':
        return numeric && value !== this.nullMarker ? value : this.quoted(value);
      case 'none':
        return this.unquotedEscaped(value);
      default:
        return value === this.nullMarker || this.special.test(value) ? this.quoted(value) : value;
    }
  }

  /** One record including its line ending. */
  record(values: readonly (string | null)[], numeric?: readonly boolean[]): string {
    let line = '';
    for (let i = 0; i < values.length; i++) {
      if (i > 0) line += this.delimiter;
      line += this.field(values[i] ?? null, numeric?.[i] === true);
    }
    return line + this.lineEnding;
  }

  private quoted(value: string): string {
    const q = this.quote;
    if (this.inQuotes !== null) return q + value.replace(this.inQuotes, `${this.escape!}$&`) + q;
    return q + (value.includes(q) ? value.replaceAll(q, q + q) : value) + q;
  }

  private unquotedEscaped(value: string): string {
    const escape = this.escape;
    if (escape === null || escape === this.quote || !this.special.test(value)) return value;
    let out = '';
    for (const ch of value) {
      out +=
        ch === this.delimiter || ch === escape || ch === '\r' || ch === '\n' || ch === this.quote
          ? escape + ch
          : ch;
    }
    return out;
  }
}
