import { QuerybaraError, newId, type Session, type SqlDialect } from '@querybara/core';
import { StatementSplitter, type SqlStatement } from '@querybara/sql-tools';

import { openInput, peekSource, type ByteSource } from './io';
import { dialectOf } from './session';
import { decodeSource, detectEncoding } from './text';
import type { TransferStatus } from './types';

/**
 * "Run SQL file" import (spec §12): the file streams through the editor's incremental
 * StatementSplitter (MySQL DELIMITER blocks, PostgreSQL dollar quoting, nested comments) and
 * each statement runs as it completes, so a multi-gigabyte dump never sits in memory.
 * Result rows of queries in the file are read and discarded.
 */

export interface SqlFileOptions {
  readonly session: Session;
  readonly source: ByteSource;
  /** Defaults to the session's engine. */
  readonly dialect?: SqlDialect;
  /** Detected from a byte order mark or UTF-8 validity when absent. */
  readonly encoding?: string;
  readonly decompress?: 'auto' | 'gzip' | 'none';
  /** `stop` (default) at the first failing statement, or `continue` and log it. */
  readonly onError?: 'stop' | 'continue';
  /**
   * `none` (default): statements run as the file says, its own BEGIN/COMMIT included.
   * `single`: the whole file runs in one transaction, rolled back on stop or cancel
   * (PostgreSQL wraps each statement in a savepoint when continuing past errors). DDL still
   * commits implicitly on MySQL and MariaDB.
   */
  readonly transaction?: 'none' | 'single';
  /** Errors kept in the summary (default 1000). */
  readonly errorLogLimit?: number;
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: SqlFileProgress) => void;
  readonly progressIntervalMs?: number;
}

export interface SqlFileProgress {
  /** Statements run so far, failed ones included. */
  readonly statements: number;
  readonly failed: number;
  readonly rowsAffected: number;
  /** Source bytes read (compressed bytes for gzip). */
  readonly bytes: number;
  readonly elapsedMs: number;
}

export interface SqlStatementError {
  /** 1-based index of the statement in the file. */
  readonly statement: number;
  /** 1-based line and column where it starts. */
  readonly line: number;
  readonly column: number;
  readonly message: string;
  /** The statement's first 200 characters. */
  readonly text: string;
}

export interface SqlFileSummary {
  readonly status: TransferStatus;
  readonly statements: number;
  readonly failed: number;
  readonly rowsAffected: number;
  readonly errors: readonly SqlStatementError[];
  readonly durationMs: number;
}

class Stop extends Error {
  constructor(readonly reason: 'failed' | 'cancelled') {
    super(reason);
  }
}

/** Runs a SQL file statement by statement; resolves with a summary for every outcome. */
export async function runSqlFile(options: SqlFileOptions): Promise<SqlFileSummary> {
  const { session, signal } = options;
  const dialect = dialectOf(session, options.dialect);
  const onError = options.onError ?? 'stop';
  const single = options.transaction === 'single';
  const errorLogLimit = options.errorLogLimit ?? 1000;
  const interval = options.progressIntervalMs ?? 250;
  if (single && session.inTransaction) {
    throw new QuerybaraError({
      code: 'VALIDATION_FAILED',
      message: 'The session already has an open transaction',
    });
  }
  // A transaction the caller opened is theirs to end; one the file (or `single`) opened is ours.
  const callerTransaction = session.inTransaction;
  const started = performance.now();
  const errors: SqlStatementError[] = [];
  let statements = 0;
  let failed = 0;
  let rowsAffected = 0;
  let lastProgress = 0;
  let count = (): number => 0;

  const emit = (force: boolean): void => {
    if (options.onProgress === undefined) return;
    const now = performance.now();
    if (!force && now - lastProgress < interval) return;
    lastProgress = now;
    options.onProgress({
      statements,
      failed,
      rowsAffected,
      bytes: count(),
      elapsedMs: Math.round(now - started),
    });
  };
  const control = async (sql: string): Promise<void> => {
    for await (const _chunk of session.execute(sql, { executionId: newId() })) {
      // drained
    }
  };
  const execute = async (text: string): Promise<void> => {
    for await (const chunk of session.execute(text, {
      executionId: newId(),
      ...(signal !== undefined ? { signal } : {}),
    })) {
      if (chunk.type === 'status' && chunk.rowsAffected !== null)
        rowsAffected += chunk.rowsAffected;
    }
  };
  const cancelled = (error: unknown): boolean =>
    signal?.aborted === true || (error instanceof QuerybaraError && error.code === 'CANCELLED');

  const runOne = async (statement: SqlStatement): Promise<void> => {
    if (signal?.aborted === true) throw new Stop('cancelled');
    statements++;
    const guard = single && onError === 'continue' && dialect === 'postgres';
    if (guard) await control('SAVEPOINT querybara_statement');
    try {
      await execute(statement.text);
      if (guard) await control('RELEASE SAVEPOINT querybara_statement');
    } catch (error) {
      if (cancelled(error)) throw new Stop('cancelled');
      if (guard) await control('ROLLBACK TO SAVEPOINT querybara_statement');
      failed++;
      if (errors.length < errorLogLimit) {
        errors.push({
          statement: statements,
          line: statement.line,
          column: statement.column,
          message: error instanceof Error ? error.message : String(error),
          text: statement.text.slice(0, 200),
        });
      }
      if (onError === 'stop') throw new Stop('failed');
    }
    emit(false);
  };

  let status: TransferStatus = 'completed';
  try {
    const input = await openInput(options.source, options.decompress ?? 'auto');
    count = input.count;
    let bytes = input.source;
    let encoding = options.encoding;
    if (encoding === undefined) {
      const peeked = await peekSource(bytes, 64 * 1024);
      encoding = detectEncoding(peeked.head, peeked.ended).encoding;
      bytes = peeked.source;
    }
    const splitter = new StatementSplitter(dialect);
    if (single) await control(dialect === 'postgres' ? 'BEGIN' : 'START TRANSACTION');
    for await (const text of decodeSource(bytes, encoding)) {
      for (const statement of splitter.push(text)) await runOne(statement);
    }
    for (const statement of splitter.end()) await runOne(statement);
    if (single) await control('COMMIT');
  } catch (error) {
    if (error instanceof Stop) status = error.reason;
    else if (cancelled(error)) status = 'cancelled';
    else {
      status = 'failed';
      if (errors.length < errorLogLimit) {
        errors.push({
          statement: statements,
          line: 0,
          column: 0,
          message: error instanceof Error ? error.message : String(error),
          text: '',
        });
      }
    }
    if (session.inTransaction && !callerTransaction) {
      await control('ROLLBACK').catch(() => undefined);
    }
  }
  emit(true);
  return {
    status,
    statements,
    failed,
    rowsAffected,
    errors,
    durationMs: Math.round(performance.now() - started),
  };
}
