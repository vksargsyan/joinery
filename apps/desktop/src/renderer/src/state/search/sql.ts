import { newId } from '@joinery/core';
import type { RpcStream } from '@joinery/ipc';
import {
  aggregationsOf,
  formatJson,
  parseSearchError,
  type SearchTable,
  type SearchTableColumn,
} from '@joinery/search-tools';

import { errorInfo, errorMessage } from '../../lib/errors';
import { mainApi } from '../../lib/main-client';
import { queryClient } from '../data';
import { patchPanel } from '../panels';
import { BASE_STATE, SearchView, type SearchViewState } from './view';

/**
 * The SQL and ES|QL editor (spec §11): SQL through the SQL API, paged with the server's cursor
 * as the results scroll; ES|QL on clusters that have it
 * (a capability flag, not a version check); and "Translate to DSL", which shows the Query DSL a
 * SQL query becomes, runs it as a search, and shows its aggregations as a tree and a flattened
 * table. Runs go to the query history.
 */

export type SqlMode = 'sql' | 'esql';

export interface SqlTarget {
  readonly profileId: string;
  readonly text?: string;
  readonly mode?: SqlMode;
}

export interface DslRun {
  readonly running: boolean;
  readonly status?: number;
  /** The response, re-indented. */
  readonly body?: string;
  readonly aggregations?: string;
  readonly error?: string;
}

export interface SqlState extends SearchViewState {
  readonly mode: SqlMode;
  readonly running: boolean;
  readonly columns: readonly SearchTableColumn[];
  readonly rows: readonly (readonly string[])[];
  readonly more: boolean;
  readonly loadingMore: boolean;
  readonly partial: boolean;
  readonly durationMs: number | undefined;
  readonly error: string | undefined;
  readonly translating: boolean;
  readonly translation:
    | {
        /** The DSL, re-indented; undefined when the reply holds none. */
        readonly dsl: string | undefined;
        readonly target: string | undefined;
        /** The server's reply, re-indented. */
        readonly raw: string;
      }
    | undefined;
  readonly dslRun: DslRun | undefined;
}

/** Rows per page the server's cursor reads. */
export const SQL_FETCH_SIZE = 500;

export const SQL_WELCOME = '-- Run with Ctrl/Cmd+Enter\nSHOW TABLES';
export const ESQL_WELCOME = '// Run with Ctrl/Cmd+Enter\nFROM * | LIMIT 10';

function pretty(text: string): string {
  try {
    return formatJson(text);
  } catch {
    return text;
  }
}

export class SqlView extends SearchView<SqlState> {
  readonly target: SqlTarget;
  #stream: RpcStream<SearchTable> | undefined;
  #runId = 0;
  #execution: { readonly id: string; readonly controller: AbortController } | undefined;

  constructor(id: string, target: SqlTarget) {
    super(id, target.profileId, {
      ...BASE_STATE,
      mode: target.mode ?? 'sql',
      running: false,
      columns: [],
      rows: [],
      more: false,
      loadingMore: false,
      partial: false,
      durationMs: undefined,
      error: undefined,
      translating: false,
      translation: undefined,
      dslRun: undefined,
    });
    this.target = target;
  }

  async init(): Promise<void> {
    await this.loadBasics();
    const caps = this.state.info?.capabilities;
    // Open on what the cluster has: SQL first, ES|QL when there is no SQL.
    if (caps && !caps.sql && caps.esql && this.target.mode === undefined) {
      this.set({ mode: 'esql' });
    }
  }

  /** What the cluster offers: undefined until known (both are then offered). */
  get supports(): { readonly sql: boolean; readonly esql: boolean } {
    const caps = this.state.info?.capabilities;
    return { sql: caps ? caps.sql : true, esql: caps ? caps.esql : true };
  }

  setMode(mode: SqlMode): void {
    this.set({ mode, translation: undefined, dslRun: undefined });
  }

  /** Runs the text in the current mode from the first page. */
  async run(text: string): Promise<void> {
    const query = text.trim();
    if (query === '' || this.state.running) return;
    const mode = this.state.mode;
    if (mode === 'sql' && !this.supports.sql) {
      this.set({ error: 'This cluster has no SQL (the OSS distribution lacks it).' });
      return;
    }
    if (mode === 'esql' && !this.supports.esql) {
      this.set({ error: 'This cluster has no ES|QL (Elasticsearch 8.11 and later have it).' });
      return;
    }
    const runId = ++this.#runId;
    await this.#closeStream();
    const execution = { id: newId(), controller: new AbortController() };
    this.#execution = execution;
    this.set({
      running: true,
      error: undefined,
      notice: undefined,
      columns: [],
      rows: [],
      more: false,
      partial: false,
      durationMs: undefined,
    });
    patchPanel(this.id, { busy: true });
    const started = performance.now();
    let failure: string | undefined;
    try {
      if (mode === 'esql') {
        const table = await this.call((host, sessionId) =>
          host.search.esql.query(
            { sessionId, query, executionId: execution.id },
            { signal: execution.controller.signal },
          ),
        );
        if (runId === this.#runId) {
          this.set({
            columns: table.columns,
            rows: table.rows,
            partial: table.partial === true,
          });
        }
      } else {
        this.#stream = await this.call(async (host, sessionId) =>
          host.search.sql.query(
            { sessionId, query, fetchSize: SQL_FETCH_SIZE, executionId: execution.id },
            { signal: execution.controller.signal },
          ),
        );
        await this.#pull(runId);
        failure = this.state.error;
      }
    } catch (error) {
      failure = errorInfo(error).code === 'CANCELLED' ? 'Cancelled' : errorMessage(error);
      if (runId === this.#runId) this.set({ error: failure });
    } finally {
      if (runId === this.#runId) {
        this.set({ running: false, durationMs: Math.round(performance.now() - started) });
        patchPanel(this.id, { busy: false });
      }
      if (this.#execution === execution) this.#execution = undefined;
    }
    void this.#record(query, failure, performance.now() - started);
  }

  async #pull(runId: number): Promise<void> {
    const stream = this.#stream;
    if (!stream || runId !== this.#runId) return;
    this.set({ loadingMore: true });
    try {
      const next = await stream.next();
      if (runId !== this.#runId) return;
      if (next.done) {
        this.#stream = undefined;
        this.set({ more: false });
        return;
      }
      const page = next.value;
      this.set({
        columns: this.state.columns.length > 0 ? this.state.columns : page.columns,
        rows: [...this.state.rows, ...page.rows],
        more: page.more === true,
      });
      if (page.more !== true) {
        await stream.return().catch(() => undefined);
        this.#stream = undefined;
      }
    } catch (error) {
      if (runId !== this.#runId) return;
      this.#stream = undefined;
      this.set({ more: false, error: errorMessage(error) });
    } finally {
      if (runId === this.#runId) this.set({ loadingMore: false });
    }
  }

  /** Reads the next page of SQL rows. */
  async loadMore(): Promise<void> {
    if (!this.state.more || this.state.loadingMore) return;
    await this.#pull(this.#runId);
  }

  /** Loads more when the table shows rows near the end of what is loaded. */
  onVisibleRows(lastVisible: number): void {
    if (lastVisible >= this.state.rows.length - 30) void this.loadMore();
  }

  async cancel(): Promise<void> {
    const execution = this.#execution;
    if (!execution) return;
    execution.controller.abort();
    const current = this.lane.current;
    if (current) {
      await current.host
        .cancel({ sessionId: current.sessionId, executionId: execution.id })
        .catch(() => undefined);
    }
  }

  async #closeStream(): Promise<void> {
    const stream = this.#stream;
    this.#stream = undefined;
    await stream?.return().catch(() => undefined);
  }

  // -------------------------------------------------------------------------------------------
  // Translate to DSL

  /** Translates the SQL to Query DSL. */
  async translate(text: string): Promise<void> {
    const query = text.trim();
    if (query === '' || !this.supports.sql) return;
    this.set({ translating: true, translation: undefined, dslRun: undefined, error: undefined });
    try {
      const translation = await this.call((host, sessionId) =>
        host.search.sql.translate({ sessionId, query }),
      );
      this.set({
        translation: {
          dsl: translation.dsl !== undefined ? pretty(translation.dsl) : undefined,
          target: translation.target,
          raw: pretty(translation.raw),
        },
      });
    } catch (error) {
      this.set({ error: errorMessage(error) });
    } finally {
      this.set({ translating: false });
    }
  }

  /** Runs the translated DSL as a search on the query's index and shows the response. */
  async runDsl(): Promise<void> {
    const translation = this.state.translation;
    if (!translation?.dsl || !translation.target) return;
    this.set({ dslRun: { running: true } });
    try {
      const response = await this.call((host, sessionId) =>
        host.search.request({
          sessionId,
          request: {
            method: 'POST',
            path: `/${encodeURIComponent(translation.target!)}/_search`,
            body: translation.dsl!,
          },
        }),
      );
      const aggregations = response.status < 300 ? aggregationsOf(response.body) : undefined;
      const info = response.status >= 300 ? parseSearchError(response.body) : undefined;
      this.set({
        dslRun: {
          running: false,
          status: response.status,
          body: pretty(response.body),
          ...(aggregations !== undefined ? { aggregations } : {}),
          ...(info ? { error: info.reason } : {}),
        },
      });
    } catch (error) {
      this.set({ dslRun: { running: false, error: errorMessage(error) } });
    }
  }

  /** Console text that runs the translated DSL (for "Open in console"). */
  consoleText(): string | undefined {
    const translation = this.state.translation;
    if (!translation?.dsl || !translation.target) return undefined;
    return `GET /${translation.target}/_search\n${translation.dsl}\n`;
  }

  async #record(text: string, error: string | undefined, durationMs: number): Promise<void> {
    try {
      await mainApi().history.add({
        profileId: this.profileId,
        database: null,
        text,
        status: error === undefined ? 'success' : error === 'Cancelled' ? 'cancelled' : 'error',
        error: error ?? null,
        durationMs: Math.round(durationMs),
        rowCount: this.state.rows.length,
      });
      await queryClient.invalidateQueries({ queryKey: ['history'] });
    } catch {
      // History is best effort.
    }
  }

  override async dispose(): Promise<void> {
    this.#runId++;
    this.#execution?.controller.abort();
    await this.#closeStream();
    await super.dispose();
  }
}
