import { newId } from '@querybara/core';
import type { RpcStream } from '@querybara/ipc';
import {
  SqlTranslationError,
  formatShell,
  sqlName,
  sqlToMql,
  toEjson,
  toFindQuery,
  type DocumentPage,
  type ExportTarget,
  type Namespace,
  type SqlTranslation,
} from '@querybara/mongo-tools';
import { useStore } from 'zustand';
import { createStore, type StoreApi } from 'zustand/vanilla';

import { errorInfo, errorMessage } from '../../lib/errors';
import { mainApi } from '../../lib/main-client';
import { queryClient } from '../data';
import { patchPanel } from '../panels';
import { SessionLane } from '../session-lane';
import type { CollectionTarget, Notice } from './collection-view';
import { fieldsOf, type QueryFields } from './query-bar';
import { DocumentResults } from './results';

/**
 * SQL on MongoDB (spec §9, "Query tools"): a SELECT typed against a database is translated to
 * find() or aggregate() as it is typed (`sqlToMql`, in the renderer: nothing is sent to translate
 * it), the translation is shown beside it, and Run streams the documents into the tree, table and
 * JSON views, with the table's columns in the select list's order. SQL the translator cannot
 * read is marked where it fails; valid SQL it does not cover (a subquery, UNION...) says so. The
 * translation opens in the collection view (a find) or the aggregation editor (a pipeline), and
 * code export takes it as it is. Only SELECTs translate, so nothing here writes; runs go to the
 * query history.
 */

export interface SqlQueryTarget {
  readonly profileId: string;
  /** The database the FROM collections are in. */
  readonly db: string;
  readonly text?: string;
}

/** Why the SQL does not translate: where (to underline) and what to say. */
export interface SqlIssue {
  /** 0-based UTF-16 offsets; `end` exclusive. */
  readonly offset: number;
  readonly end: number;
  /** The reason with its line and column. */
  readonly message: string;
  readonly hint?: string;
  /** Valid SQL the translator does not cover, rather than a mistake. */
  readonly unsupported: boolean;
}

export interface SqlQueryState {
  readonly database: string;
  /** Databases to pick from (the server's list). */
  readonly databases: readonly string[];
  readonly text: string;
  /** The current text's translation; undefined while it is empty or does not translate. */
  readonly translation: SqlTranslation | undefined;
  readonly issue: SqlIssue | undefined;
  readonly running: boolean;
  /** The translation the results came from; undefined before the first run. */
  readonly ran: SqlTranslation | undefined;
  readonly durationMs: number | undefined;
  readonly notice: Notice | undefined;
}

/** Documents per page pulled from the cursor. */
export const SQL_PAGE_SIZE = 100;
/** Pause after typing before the translation follows (so a half-typed word is not an error). */
export const TRANSLATE_DELAY_MS = 200;

export const SQL_EXAMPLE = 'SELECT name, total FROM orders WHERE total > 100 ORDER BY total DESC';

/** What a SQL text becomes: its translation, the reason it has none, or neither when blank. */
export function translateSql(text: string): {
  readonly translation?: SqlTranslation;
  readonly issue?: SqlIssue;
} {
  if (text.trim() === '') return {};
  try {
    return { translation: sqlToMql(text) };
  } catch (error) {
    if (error instanceof SqlTranslationError) {
      return {
        issue: {
          offset: error.offset,
          end: error.end,
          message: error.message,
          ...(error.hint !== undefined ? { hint: error.hint } : {}),
          unsupported: error.code === 'NOT_SUPPORTED',
        },
      };
    }
    return {
      issue: { offset: 0, end: text.length, message: errorMessage(error), unsupported: false },
    };
  }
}

/** The query a SQL tab opened on a collection starts with. */
export function starterSql(collection: string): string {
  return `SELECT *\nFROM ${sqlName(collection)}\nLIMIT 100`;
}

/**
 * Whether a query history entry of a MongoDB connection is SQL (it reopens in a SQL tab) rather
 * than a console command document: its first word, after comments, is SELECT.
 */
export function looksLikeSql(text: string): boolean {
  const body = text.replace(/^(\s*(--[^\n]*(\n|$)|\/\*[\s\S]*?\*\/))*\s*/, '');
  return /^select\b/i.test(body);
}

/** A translation as code export takes it. */
export function exportTargetOf(translation: SqlTranslation): ExportTarget {
  return translation.kind === 'find'
    ? { kind: 'find', collection: translation.collection, query: translation.query }
    : { kind: 'aggregate', collection: translation.collection, pipeline: translation.pipeline };
}

/** The aggregation editor's text of a translated pipeline. */
export function pipelineTextOf(translation: SqlTranslation): string | undefined {
  return translation.kind === 'aggregate' ? formatShell([...translation.pipeline]) : undefined;
}

export class SqlQuery {
  readonly id: string;
  readonly target: SqlQueryTarget;
  readonly store: StoreApi<SqlQueryState>;
  /** SQL results read best as a table. */
  readonly results = new DocumentResults({ mode: 'table' });
  readonly #lane: SessionLane;
  #stream: RpcStream<DocumentPage> | undefined;
  #execution: { readonly id: string; readonly controller: AbortController } | undefined;
  #runId = 0;
  #timer: ReturnType<typeof setTimeout> | undefined;

  constructor(id: string, target: SqlQueryTarget) {
    this.id = id;
    this.target = target;
    const text = target.text ?? '';
    this.store = createStore<SqlQueryState>()(() => ({
      database: target.db,
      databases: [target.db],
      text,
      translation: undefined,
      issue: undefined,
      ...translateSql(text),
      running: false,
      ran: undefined,
      durationMs: undefined,
      notice: undefined,
    }));
    this.#lane = new SessionLane(target.profileId, target.db);
  }

  get state(): SqlQueryState {
    return this.store.getState();
  }

  #set(patch: Partial<SqlQueryState>): void {
    this.store.setState(patch);
  }

  /** Lists the databases to pick from. */
  async init(): Promise<void> {
    try {
      const nodes = await this.#lane.run((host, sessionId) => host.browse({ sessionId, path: [] }));
      const names = nodes.filter((n) => n.kind === 'database').map((n) => n.name);
      this.#set({ databases: [...new Set([this.state.database, ...names])] });
    } catch (error) {
      this.#set({
        notice: { kind: 'error', text: `Databases could not be listed: ${errorMessage(error)}` },
      });
    }
  }

  setDatabase(database: string): void {
    this.#set({ database });
  }

  /** The SQL typed by the user; the translation follows after a short pause. */
  setText(text: string): void {
    if (text === this.state.text) return;
    this.#set({ text });
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => this.#translate(), TRANSLATE_DELAY_MS);
  }

  /** Translates the current text now (a run, an export or an open does not wait for the pause). */
  #translate(): SqlTranslation | undefined {
    clearTimeout(this.#timer);
    this.#timer = undefined;
    const { translation, issue } = translateSql(this.state.text);
    this.#set({ translation, issue });
    return translation;
  }

  /** The current translation, brought up to date with the text. */
  current(): SqlTranslation | undefined {
    return this.#timer === undefined ? this.state.translation : this.#translate();
  }

  // -------------------------------------------------------------------------------------------
  // Running and paging

  /** Runs the translation from the first page; an issue is shown instead of running. */
  async run(): Promise<void> {
    if (this.state.running) return;
    const text = this.state.text;
    const translation = this.current();
    const issue = this.state.issue;
    if (issue) {
      this.#set({
        notice: {
          kind: 'error',
          text: issue.unsupported ? issue.message : `Fix the SQL first: ${issue.message}`,
        },
      });
      return;
    }
    if (!translation) {
      this.#set({ notice: { kind: 'info', text: `Write a SELECT, e.g. ${SQL_EXAMPLE}` } });
      return;
    }
    const runId = ++this.#runId;
    await this.#closeStream();
    const execution = { id: newId(), controller: new AbortController() };
    this.#execution = execution;
    this.results.begin(async () => {
      await this.#fetch(runId).catch(() => undefined);
    }, translation.columns ?? []);
    this.#set({ running: true, ran: translation, durationMs: undefined, notice: undefined });
    patchPanel(this.id, { busy: true });
    const ns: Namespace = { db: this.state.database, collection: translation.collection };
    const started = performance.now();
    let status: 'success' | 'error' | 'cancelled' = 'success';
    let failure: string | undefined;
    let rows = 0;
    try {
      this.#stream = await this.#lane.run(async (host, sessionId) =>
        translation.kind === 'find'
          ? host.mongo.find(
              {
                sessionId,
                ns,
                query: toFindQuery(translation.query),
                pageSize: SQL_PAGE_SIZE,
                executionId: execution.id,
              },
              { signal: execution.controller.signal },
            )
          : host.mongo.aggregate(
              {
                sessionId,
                ns,
                pipeline: toEjson([...translation.pipeline]),
                pageSize: SQL_PAGE_SIZE,
                executionId: execution.id,
              },
              { signal: execution.controller.signal },
            ),
      );
      rows = await this.#fetch(runId);
    } catch (error) {
      const info = errorInfo(error);
      status = info.code === 'CANCELLED' ? 'cancelled' : 'error';
      failure = info.message;
      if (runId === this.#runId) {
        if (status === 'cancelled') {
          this.results.append([], false);
          this.#set({ notice: { kind: 'info', text: 'The query was cancelled.' } });
        } else {
          this.results.fail(errorMessage(error));
          this.#set({ notice: { kind: 'error', text: errorMessage(error) } });
        }
      }
    } finally {
      if (this.#execution === execution) this.#execution = undefined;
      if (runId === this.#runId) {
        this.#set({ running: false, durationMs: Math.round(performance.now() - started) });
        patchPanel(this.id, { busy: false });
      }
    }
    await this.#record(text, status, failure, Math.round(performance.now() - started), rows);
  }

  /** Pulls the next page of the current run; returns how many documents came. */
  async #fetch(runId: number): Promise<number> {
    const stream = this.#stream;
    if (!stream || runId !== this.#runId) return 0;
    this.results.setLoading(true);
    try {
      const next = await stream.next();
      if (runId !== this.#runId) return 0;
      if (next.done) {
        this.results.append([], false);
        this.#stream = undefined;
        return 0;
      }
      const documents = next.value.documents;
      this.results.append(documents, documents.length >= SQL_PAGE_SIZE);
      return documents.length;
    } catch (error) {
      this.#stream = undefined;
      if (runId === this.#runId && errorInfo(error).code !== 'CANCELLED') {
        this.results.fail(errorMessage(error));
      }
      throw error;
    }
  }

  async #closeStream(): Promise<void> {
    const stream = this.#stream;
    this.#stream = undefined;
    await stream?.return().catch(() => undefined);
  }

  /** Cancels the running query on the server. */
  async cancel(): Promise<void> {
    const execution = this.#execution;
    if (!execution) return;
    execution.controller.abort();
    const current = this.#lane.current;
    if (current) {
      await current.host
        .cancel({ sessionId: current.sessionId, executionId: execution.id })
        .catch(() => undefined);
    }
  }

  async #record(
    text: string,
    status: 'success' | 'error' | 'cancelled',
    error: string | undefined,
    durationMs: number,
    rowCount: number,
  ): Promise<void> {
    try {
      await mainApi().history.add({
        profileId: this.target.profileId,
        database: this.state.database,
        text,
        status,
        error: error ?? null,
        durationMs,
        rowCount,
      });
      await queryClient.invalidateQueries({ queryKey: ['history'] });
    } catch {
      // History is best effort: a run never fails because it could not be recorded.
    }
  }

  // -------------------------------------------------------------------------------------------
  // Where the translation goes next

  /**
   * The collection view a translated find() opens in, with the query bar's fields: the
   * collection's kind is asked for, since a view opens read-only. Undefined (with a notice) when
   * the SQL does not translate to a find().
   */
  async collectionDestination(): Promise<
    { readonly target: CollectionTarget; readonly fields: QueryFields } | undefined
  > {
    const translation = this.current();
    if (translation?.kind !== 'find') {
      this.#set({
        notice: {
          kind: 'error',
          text: translation
            ? 'This SQL needs an aggregation pipeline: open it in the aggregation editor.'
            : 'Write a SELECT that translates first.',
        },
      });
      return undefined;
    }
    const ns: Namespace = { db: this.state.database, collection: translation.collection };
    let kind: CollectionTarget['kind'] = 'collection';
    try {
      const info = await this.#lane.run((host, sessionId) =>
        host.mongo.collections.info({ sessionId, ns }),
      );
      kind = info.type === 'timeseries' ? 'time-series' : info.type;
    } catch (error) {
      if (errorInfo(error).code === 'NOT_FOUND') {
        this.#set({
          notice: {
            kind: 'error',
            text: `${ns.db}.${ns.collection} does not exist.`,
          },
        });
        return undefined;
      }
      // Anything else: open it as a collection; the view reports what goes wrong.
    }
    return {
      target: { profileId: this.target.profileId, db: ns.db, collection: ns.collection, kind },
      fields: fieldsOf(translation.query).fields,
    };
  }

  /** Records a notice the panel shows (a copy, an export, a failed open...). */
  note(notice: Notice | undefined): void {
    this.#set({ notice });
  }

  async dispose(): Promise<void> {
    clearTimeout(this.#timer);
    this.#runId++;
    this.#execution?.controller.abort();
    await this.#closeStream();
    await this.#lane.close();
  }
}

/** Subscribes a component to part of a SQL tab's state. */
export function useSqlQuery<T>(query: SqlQuery, selector: (state: SqlQueryState) => T): T {
  return useStore(query.store, selector);
}
