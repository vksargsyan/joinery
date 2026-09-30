import {
  JoineryError,
  MASKED_SECRET,
  newId,
  rowAt,
  type CellValue,
  type ServerNotice,
  type Session,
} from '@joinery/core';
import type { Row } from '@joinery/driver-sql-base';

/**
 * Runs the server tools' statements through the Session contract, so they queue behind (and
 * never interleave with) anything else on the session and share its error mapping.
 */

/**
 * A statement to run and the text shown for it: `shown` has every secret (a password) masked,
 * and `secrets` lists them so an error message can be cleaned too.
 */
export interface ToolStatement {
  readonly sql: string;
  readonly shown: string;
  readonly secrets: readonly string[];
}

export function statement(sql: string): ToolStatement {
  return { sql, shown: sql, secrets: [] };
}

export interface StatementOutput {
  readonly columns: readonly string[];
  readonly rows: readonly Row[];
  readonly notices: readonly ServerNotice[];
  readonly rowsAffected: number | null;
}

export class SqlRunner {
  constructor(private readonly session: Session) {}

  /** Rows of a read query, keyed by column name. */
  async rows(sql: string, params: readonly CellValue[] = []): Promise<Row[]> {
    return (await this.run(sql, params)).rows as Row[];
  }

  /** The first row, or undefined. */
  async row(sql: string, params: readonly CellValue[] = []): Promise<Row | undefined> {
    return (await this.rows(sql, params))[0];
  }

  /**
   * Runs one statement to completion: its first result's rows, the server's notices (VACUUM
   * VERBOSE output, warnings) and the affected-row count.
   */
  async run(
    sql: string,
    params: readonly CellValue[] = [],
    signal?: AbortSignal,
  ): Promise<StatementOutput> {
    let columns: string[] = [];
    const rows: Row[] = [];
    const notices: ServerNotice[] = [];
    let rowsAffected: number | null = null;
    for await (const chunk of this.session.execute(sql, {
      executionId: newId(),
      ...(params.length > 0 ? { params } : {}),
      ...(signal ? { signal } : {}),
    })) {
      if (chunk.type === 'columns' && chunk.resultIndex === 0) {
        columns = chunk.columns.map((c) => c.name);
      } else if (chunk.type === 'rows' && chunk.resultIndex === 0) {
        for (let r = 0; r < chunk.rowCount; r++) {
          const values = rowAt(chunk, r);
          rows.push(Object.fromEntries(columns.map((name, i) => [name, values[i] ?? null])));
        }
      } else if (chunk.type === 'notice') {
        notices.push({
          level: chunk.severity === 'warning' ? 'warning' : 'info',
          message: chunk.message,
        });
      } else if (chunk.type === 'status' && chunk.rowsAffected !== null) {
        rowsAffected = chunk.rowsAffected;
      }
    }
    return { columns, rows, notices, rowsAffected };
  }

  /** Runs a tool statement; a failure never repeats the password it carried. */
  async runStatement(stmt: ToolStatement, signal?: AbortSignal): Promise<StatementOutput> {
    try {
      return await this.run(stmt.sql, [], signal);
    } catch (error) {
      throw maskError(error, stmt);
    }
  }
}

/** The error with every secret of `stmt` replaced by the mask. */
export function maskError(error: unknown, stmt: ToolStatement): unknown {
  if (!(error instanceof JoineryError) || stmt.secrets.length === 0) return error;
  const clean = (text: string): string =>
    stmt.secrets.reduce(
      (out, secret) => (secret === '' ? out : out.replaceAll(secret, MASKED_SECRET)),
      text,
    );
  const data = error.toJSON();
  return new JoineryError({
    ...data,
    message: clean(data.message),
    ...(data.detail !== undefined ? { detail: clean(data.detail) } : {}),
    ...(data.hint !== undefined ? { hint: clean(data.hint) } : {}),
  });
}

/** Adds a hint to an error of one of `codes` (SQLSTATEs or engine codes); others pass through. */
export function withHint(
  error: unknown,
  codes: readonly (string | number)[],
  hint: string,
  message?: string,
): unknown {
  if (!(error instanceof JoineryError)) return error;
  const matches = [error.sqlState, error.engineCode].some(
    (code) => code !== undefined && codes.includes(code),
  );
  if (!matches) return error;
  return new JoineryError({
    ...error.toJSON(),
    ...(message !== undefined ? { message } : {}),
    hint,
  });
}
