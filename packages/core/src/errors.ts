import { z } from 'zod';

export const ERROR_CODES = [
  'CONNECTION_FAILED',
  'AUTH_FAILED',
  'TLS_FAILED',
  'SSH_FAILED',
  'TIMEOUT',
  'CANCELLED',
  'SQL_ERROR',
  'NOT_SUPPORTED',
  'NOT_FOUND',
  /** Optimistic concurrency: the item changed since the caller read it. */
  'CONFLICT',
  'READ_ONLY',
  'CONFIRMATION_REQUIRED',
  'VALIDATION_FAILED',
  'INTERNAL',
] as const;

export const errorCodeSchema = z.enum(ERROR_CODES);
export type ErrorCode = z.infer<typeof errorCodeSchema>;

/** The serialisable form of an error, as it crosses process boundaries. */
export const errorDataSchema = z.object({
  code: errorCodeSchema,
  message: z.string(),
  /** Longer server-provided detail. */
  detail: z.string().optional(),
  /** What the user can do about it. */
  hint: z.string().optional(),
  /** SQLSTATE, when the server sent one. */
  sqlState: z.string().optional(),
  /** Engine-native error code, e.g. MySQL 1064 or ER_PARSE_ERROR. */
  engineCode: z.union([z.string(), z.number()]).optional(),
  /** 0-based character offset of the error in the statement text. */
  position: z.number().int().nonnegative().optional(),
});
export type ErrorData = z.infer<typeof errorDataSchema>;

export class QuerybaraError extends Error {
  readonly code: ErrorCode;
  readonly detail: string | undefined;
  readonly hint: string | undefined;
  readonly sqlState: string | undefined;
  readonly engineCode: string | number | undefined;
  readonly position: number | undefined;

  constructor(data: ErrorData, options?: { cause?: unknown }) {
    super(data.message, options);
    this.name = 'QuerybaraError';
    this.code = data.code;
    this.detail = data.detail;
    this.hint = data.hint;
    this.sqlState = data.sqlState;
    this.engineCode = data.engineCode;
    this.position = data.position;
  }

  static is(value: unknown): value is QuerybaraError {
    return value instanceof QuerybaraError;
  }

  toJSON(): ErrorData {
    const data: ErrorData = { code: this.code, message: this.message };
    if (this.detail !== undefined) data.detail = this.detail;
    if (this.hint !== undefined) data.hint = this.hint;
    if (this.sqlState !== undefined) data.sqlState = this.sqlState;
    if (this.engineCode !== undefined) data.engineCode = this.engineCode;
    if (this.position !== undefined) data.position = this.position;
    return data;
  }
}

/** Serialisable data for any thrown value; unknown errors become INTERNAL. */
export function toErrorData(error: unknown): ErrorData {
  if (error instanceof QuerybaraError) return error.toJSON();
  if (error instanceof Error) {
    if (error.name === 'AbortError') return { code: 'CANCELLED', message: 'Cancelled' };
    return { code: 'INTERNAL', message: error.message };
  }
  return { code: 'INTERNAL', message: String(error) };
}

/** Rebuilds a QuerybaraError on the receiving side of a process boundary. */
export function fromErrorData(data: ErrorData): QuerybaraError {
  return new QuerybaraError(data);
}

export function cancelledError(message = 'Cancelled'): QuerybaraError {
  return new QuerybaraError({ code: 'CANCELLED', message });
}
