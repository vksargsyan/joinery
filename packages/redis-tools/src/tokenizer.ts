import { QuerybaraError } from '@querybara/core';

import { utf8Text } from './bytes';

/**
 * The redis-cli command line tokenizer (a port of `sdssplitargs`): arguments are separated by
 * spaces; "double quotes" support `\n` `\r` `\t` `\b` `\a` `\xNN` and `\<char>` escapes;
 * 'single quotes' only `\'`; a closing quote must be followed by a space or the end of the
 * line; a quote in the middle of a word opens a quoted part of the same argument. Text outside
 * escapes is UTF-8, so arguments come back as bytes.
 */

export interface CliToken {
  /** The argument's bytes. */
  readonly bytes: Uint8Array;
  /** The bytes as text (lossy for invalid UTF-8). */
  readonly text: string;
  /** UTF-16 offsets of the token in the input, end exclusive (after a closing quote). */
  readonly start: number;
  readonly end: number;
  /** The token has a quoted part. */
  readonly quoted: boolean;
  /** An unquoted line break came before this token: it starts a new command. */
  readonly lineStart: boolean;
}

export interface TokenizeResult {
  readonly tokens: readonly CliToken[];
  /** Why the line is invalid, and where; redis-cli answers "Invalid argument(s)". */
  readonly error?: { readonly message: string; readonly position: number };
  /**
   * The input ended inside a quote. The last token holds what was typed so far; this is an
   * error for execution but normal while the user is still typing (autocomplete).
   */
  readonly unterminated: boolean;
}

/** C isspace() in the C locale. */
function isSpace(ch: string | undefined): boolean {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\v' || ch === '\f' || ch === '\r';
}

function isHex(ch: string | undefined): boolean {
  return ch !== undefined && /^[0-9a-fA-F]$/.test(ch);
}

const QUOTED_ESCAPES: Readonly<Record<string, number>> = {
  n: 0x0a,
  r: 0x0d,
  t: 0x09,
  b: 0x08,
  a: 0x07,
};

class ByteSink {
  private bytes: number[] = [];
  private readonly encoder = new TextEncoder();

  byte(value: number): void {
    this.bytes.push(value);
  }

  /** Appends the UTF-8 of the code point at `index`; returns the UTF-16 units consumed. */
  codePoint(line: string, index: number): number {
    const code = line.codePointAt(index)!;
    const width = code > 0xffff ? 2 : 1;
    const text = line.slice(index, index + width);
    if (code < 0x80) this.bytes.push(code);
    else for (const b of this.encoder.encode(text)) this.bytes.push(b);
    return width;
  }

  take(): Uint8Array {
    const out = Uint8Array.from(this.bytes);
    this.bytes = [];
    return out;
  }
}

/**
 * Tokenizes a command line (or several, separated by unquoted line breaks) the way redis-cli
 * does. Never throws: an invalid line reports `error`, and an unterminated quote at the end sets
 * `unterminated` and keeps the partial last token.
 */
export function tokenizeLine(line: string): TokenizeResult {
  const tokens: CliToken[] = [];
  const sink = new ByteSink();
  const n = line.length;
  let i = 0;
  let lineBreak = false;
  for (;;) {
    while (i < n && isSpace(line[i])) {
      if (line[i] === '\n') lineBreak = true;
      i += 1;
    }
    if (i >= n) return { tokens, unterminated: false };

    const start = i;
    let inDouble = false;
    let inSingle = false;
    let quoted = false;
    let endedByLineBreak = false;
    for (let done = false; !done;) {
      const ch = i < n ? line[i] : undefined;
      if (inDouble) {
        if (ch === '\\' && line[i + 1] === 'x' && isHex(line[i + 2]) && isHex(line[i + 3])) {
          sink.byte(parseInt(line.slice(i + 2, i + 4), 16));
          i += 4;
        } else if (ch === '\\' && i + 1 < n) {
          const escaped = line[i + 1]!;
          const simple = QUOTED_ESCAPES[escaped];
          if (simple !== undefined) {
            sink.byte(simple);
            i += 2;
          } else {
            i += 1 + sink.codePoint(line, i + 1);
          }
        } else if (ch === '"') {
          if (i + 1 < n && !isSpace(line[i + 1])) {
            return {
              tokens,
              error: {
                message: 'A closing quote must be followed by a space',
                position: i + 1,
              },
              unterminated: false,
            };
          }
          i += 1;
          done = true;
        } else if (ch === undefined) {
          tokens.push(token(sink.take(), start, n, true, lineBreak));
          return { tokens, unterminated: true };
        } else {
          i += sink.codePoint(line, i);
        }
      } else if (inSingle) {
        if (ch === '\\' && line[i + 1] === "'") {
          sink.byte(0x27);
          i += 2;
        } else if (ch === "'") {
          if (i + 1 < n && !isSpace(line[i + 1])) {
            return {
              tokens,
              error: {
                message: 'A closing quote must be followed by a space',
                position: i + 1,
              },
              unterminated: false,
            };
          }
          i += 1;
          done = true;
        } else if (ch === undefined) {
          tokens.push(token(sink.take(), start, n, true, lineBreak));
          return { tokens, unterminated: true };
        } else {
          i += sink.codePoint(line, i);
        }
      } else if (ch === undefined || ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') {
        done = true;
      } else if (ch === '"') {
        inDouble = true;
        quoted = true;
        i += 1;
      } else if (ch === "'") {
        inSingle = true;
        quoted = true;
        i += 1;
      } else {
        i += sink.codePoint(line, i);
      }
    }
    const end = i;
    // redis-cli consumes the separator that ended an unquoted word.
    if (i < n && !quoted) {
      endedByLineBreak = line[i] === '\n';
      i += 1;
    }
    tokens.push(token(sink.take(), start, end, quoted, lineBreak));
    lineBreak = endedByLineBreak;
  }
}

function token(
  bytes: Uint8Array,
  start: number,
  end: number,
  quoted: boolean,
  lineStart: boolean,
): CliToken {
  return { bytes, text: utf8Text(bytes), start, end, quoted, lineStart };
}

function invalid(line: string, result: TokenizeResult): QuerybaraError {
  const position = result.error?.position ?? line.length;
  return new QuerybaraError({
    code: 'VALIDATION_FAILED',
    message: `Invalid argument(s): ${result.error?.message ?? 'unterminated quote'}`,
    hint: 'Close every quote, and put a space after a closing quote',
    position,
  });
}

/**
 * Splits one command line into byte arguments exactly as redis-cli does. Throws
 * VALIDATION_FAILED (with the position) for unbalanced quotes or a quote followed by text.
 */
export function splitArgs(line: string): Uint8Array[] {
  const result = tokenizeLine(line);
  if (result.error || result.unterminated) throw invalid(line, result);
  return result.tokens.map((t) => t.bytes);
}

/**
 * Splits text holding several commands, one per line (line breaks inside quotes belong to the
 * argument), into their byte arguments. Blank lines are skipped.
 */
export function splitCommands(text: string): Uint8Array[][] {
  const result = tokenizeLine(text);
  if (result.error || result.unterminated) throw invalid(text, result);
  const commands: Uint8Array[][] = [];
  for (const t of result.tokens) {
    if (t.lineStart || commands.length === 0) commands.push([]);
    commands[commands.length - 1]!.push(t.bytes);
  }
  return commands;
}
