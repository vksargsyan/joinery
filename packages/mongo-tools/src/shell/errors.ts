import { QuerybaraError } from '@querybara/core';

/** A 1-based line and column in the parsed text. */
export interface TextLocation {
  readonly line: number;
  readonly column: number;
}

/** The 1-based line and column of a 0-based offset (columns count UTF-16 code units). */
export function locationAt(text: string, offset: number): TextLocation {
  let line = 1;
  let lineStart = 0;
  const end = Math.min(Math.max(offset, 0), text.length);
  for (let i = 0; i < end; i++) {
    const c = text.charCodeAt(i);
    if (c === 10 || (c === 13 && text.charCodeAt(i + 1) !== 10) || c === 0x2028 || c === 0x2029) {
      line += 1;
      lineStart = i + 1;
    }
  }
  return { line, column: end - lineStart + 1 };
}

/**
 * A syntax error in shell or Extended JSON text: VALIDATION_FAILED with the 0-based `position`
 * (so it survives the trip across processes) plus the 1-based line and column for messages.
 * The message ends with "(line L, column C)"; `reason` is the message without the location.
 */
export class ShellParseError extends QuerybaraError {
  readonly offset: number;
  readonly line: number;
  readonly column: number;
  readonly reason: string;

  constructor(text: string, offset: number, reason: string, hint?: string) {
    const { line, column } = locationAt(text, offset);
    super({
      code: 'VALIDATION_FAILED',
      message: `${reason} (line ${line}, column ${column})`,
      position: Math.min(Math.max(offset, 0), text.length),
      ...(hint !== undefined ? { hint } : {}),
    });
    this.name = 'ShellParseError';
    this.offset = Math.min(Math.max(offset, 0), text.length);
    this.line = line;
    this.column = column;
    this.reason = reason;
  }

  static override is(value: unknown): value is ShellParseError {
    return value instanceof ShellParseError;
  }
}
