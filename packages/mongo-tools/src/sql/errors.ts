import { JoineryError } from '@joinery/core';

import { locationAt } from '../shell/errors';

/**
 * Why a statement could not be translated. INTERNAL means a translator bug (an unexpected
 * exception, wrapped so that callers still get this error type).
 */
export type SqlTranslationErrorCode = 'VALIDATION_FAILED' | 'NOT_SUPPORTED' | 'INTERNAL';

/**
 * The one error `sqlToMql` throws. VALIDATION_FAILED is a mistake in the statement (a syntax
 * error, a column missing from GROUP BY); NOT_SUPPORTED is valid SQL the translator does not
 * cover (a subquery, UNION, a window or scalar function, RIGHT JOIN...).
 *
 * `offset` and `end` are 0-based UTF-16 offsets of the text to underline (`end` exclusive, never
 * before `offset`); `position` carries `offset` across processes. The message ends with
 * "(line L, column C)"; `reason` is the message without it.
 */
export class SqlTranslationError extends JoineryError {
  override readonly code: SqlTranslationErrorCode;
  readonly offset: number;
  readonly end: number;
  readonly line: number;
  readonly column: number;
  readonly reason: string;

  constructor(
    sql: string,
    code: SqlTranslationErrorCode,
    range: { readonly start: number; readonly end: number },
    reason: string,
    hint?: string,
  ) {
    const offset = Math.min(Math.max(range.start, 0), sql.length);
    const end = Math.min(Math.max(range.end, offset), sql.length);
    const { line, column } = locationAt(sql, offset);
    super({
      code,
      message: `${reason} (line ${line}, column ${column})`,
      position: offset,
      ...(hint !== undefined ? { hint } : {}),
    });
    this.name = 'SqlTranslationError';
    this.code = code;
    this.offset = offset;
    this.end = end;
    this.line = line;
    this.column = column;
    this.reason = reason;
  }

  static override is(value: unknown): value is SqlTranslationError {
    return value instanceof SqlTranslationError;
  }
}
