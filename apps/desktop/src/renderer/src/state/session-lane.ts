import { JoineryError, newId, rowAt, type CellValue, type ColumnMeta } from '@joinery/core';

import { errorInfo } from '../lib/errors';
import type { HostClient } from '../lib/main-client';
import { connect } from './connections';

/**
 * A session on a connection host that runs one task at a time (spec §4: each data view and
 * designer has its own session, so transactions never leak between them). The session opens on
 * first use and again after the connection was replaced; a task that finds it gone drops it, so
 * the next task opens a new one.
 */

export interface QueryResult {
  readonly columns: readonly ColumnMeta[];
  /** The first result set's rows. */
  readonly rows: CellValue[][];
  readonly rowsAffected: number | null;
}

export interface Statement {
  readonly sql: string;
  readonly params?: readonly CellValue[];
}

/** Runs one statement to completion and collects its first result set. */
export async function collect(
  host: HostClient,
  sessionId: string,
  statement: Statement,
  options: { readonly signal?: AbortSignal; readonly executionId?: string } = {},
): Promise<QueryResult> {
  const params = statement.params ?? [];
  const stream = host.execute(
    {
      sessionId,
      text: statement.sql,
      executionId: options.executionId ?? newId(),
      ...(params.length > 0 ? { params: [...params] } : {}),
    },
    options.signal ? { signal: options.signal } : {},
  );
  let columns: readonly ColumnMeta[] = [];
  const rows: CellValue[][] = [];
  let rowsAffected: number | null = null;
  for await (const chunk of stream) {
    if (chunk.type === 'columns' && chunk.resultIndex === 0) columns = chunk.columns;
    else if (chunk.type === 'rows' && chunk.resultIndex === 0) {
      for (let r = 0; r < chunk.rowCount; r++) rows.push(rowAt(chunk, r));
    } else if (chunk.type === 'status' && chunk.rowsAffected !== null) {
      rowsAffected = chunk.rowsAffected;
    }
  }
  return { columns, rows, rowsAffected };
}

export class SessionLane {
  readonly #profileId: string;
  readonly #database: string | undefined;
  #host: HostClient | undefined;
  #sessionId: string | undefined;
  #generation: number | undefined;
  #queue: Promise<unknown> = Promise.resolve();
  #closed = false;

  constructor(profileId: string, database?: string) {
    this.#profileId = profileId;
    this.#database = database;
  }

  /** The open session, if any (to cancel what runs on it). */
  get current(): { readonly host: HostClient; readonly sessionId: string } | undefined {
    return this.#host && this.#sessionId
      ? { host: this.#host, sessionId: this.#sessionId }
      : undefined;
  }

  /** Runs `task` after the tasks queued before it, on the lane's session. */
  run<T>(task: (host: HostClient, sessionId: string) => Promise<T>): Promise<T> {
    const next = this.#queue.then(async () => {
      if (this.#closed) {
        throw new JoineryError({ code: 'CANCELLED', message: 'The view was closed' });
      }
      const { host, sessionId } = await this.#ensure();
      try {
        return await task(host, sessionId);
      } catch (error) {
        const code = errorInfo(error).code;
        if (code === 'CONNECTION_FAILED' || code === 'NOT_FOUND') this.#sessionId = undefined;
        throw error;
      }
    });
    this.#queue = next.catch(() => undefined);
    return next;
  }

  /** Closes the session; later tasks fail with CANCELLED. */
  async close(): Promise<void> {
    this.#closed = true;
    const current = this.current;
    this.#sessionId = undefined;
    if (current) await current.host.closeSession({ sessionId: current.sessionId }).catch(() => {});
  }

  async #ensure(): Promise<{ host: HostClient; sessionId: string }> {
    const connection = await connect(this.#profileId);
    const host = connection.host;
    if (!host) throw new JoineryError({ code: 'CONNECTION_FAILED', message: 'Not connected' });
    if (
      this.#sessionId !== undefined &&
      this.#host === host &&
      this.#generation === connection.generation
    ) {
      return { host, sessionId: this.#sessionId };
    }
    const { sessionId } = await host.openSession(
      this.#database === undefined ? {} : { database: this.#database },
    );
    this.#host = host;
    this.#sessionId = sessionId;
    this.#generation = connection.generation;
    return { host, sessionId };
  }
}
