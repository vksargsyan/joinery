import { newId, requiresWriteConfirmation, type ResultChunk } from '@querybara/core';
import type { RpcStream } from '@querybara/ipc';
import { useStore } from 'zustand';
import { createStore, type StoreApi } from 'zustand/vanilla';

import { errorInfo, errorMessage } from '../../lib/errors';
import { formatCount } from '../../lib/format';
import { mainApi } from '../../lib/main-client';
import { profileById, queryClient } from '../data';
import { confirm } from '../dialogs';
import { patchPanel } from '../panels';
import { SessionLane } from '../session-lane';
import { commandSafety } from './commands';
import { issueOf } from './query-bar';
import { DocumentResults } from './results';

/**
 * The MongoDB command console (spec §9): command documents such as `{ find: "orders", filter:
 * { total: { $gt: 100 } } }` in Extended JSON or shell syntax run through the session's
 * `execute` against the chosen database, and their documents show in the same tree, table and
 * JSON views as a collection's. Cursor replies (find, aggregate, listCollections...) stream a
 * page at a time and fetch more as the view scrolls. Every run is recorded in the query history,
 * and the write rules apply as in a SQL tab: read-only profiles refuse commands that write,
 * destructive commands ask, production profiles ask before every write.
 */

export interface ConsoleTarget {
  readonly profileId: string;
  /** The database commands run against; the session's default when undefined. */
  readonly database: string | undefined;
  readonly text?: string;
}

export interface ConsoleMessage {
  readonly id: string;
  readonly kind: 'info' | 'success' | 'warning' | 'error';
  readonly text: string;
  readonly detail?: string;
  readonly at: string;
}

export interface ConsoleState {
  readonly database: string | undefined;
  /** Databases to pick from (the server's list). */
  readonly databases: readonly string[];
  readonly running: boolean;
  readonly messages: readonly ConsoleMessage[];
  readonly pane: 'results' | 'messages';
  /** The command name of the result shown ("find", "ping"...). */
  readonly command: string | undefined;
  /** A syntax error to mark in the editor. */
  readonly errorMarker: { readonly offset: number; readonly message: string } | undefined;
  readonly readOnlyProfile: boolean;
  readonly production: boolean;
  readonly confirmWrites: boolean;
}

/** Documents per page pulled from a cursor reply. */
export const CONSOLE_PAGE_SIZE = 100;

export class MongoConsole {
  readonly id: string;
  readonly target: ConsoleTarget;
  readonly store: StoreApi<ConsoleState>;
  readonly results = new DocumentResults({ mode: 'tree' });
  readonly #lane: SessionLane;
  #stream: RpcStream<ResultChunk> | undefined;
  #pending: ResultChunk | undefined;
  #execution: { readonly id: string; readonly controller: AbortController } | undefined;
  #runId = 0;

  constructor(id: string, target: ConsoleTarget) {
    this.id = id;
    this.target = target;
    this.store = createStore<ConsoleState>()(() => ({
      database: target.database,
      databases: target.database ? [target.database] : [],
      running: false,
      messages: [],
      pane: 'messages',
      command: undefined,
      errorMarker: undefined,
      readOnlyProfile: false,
      production: false,
      confirmWrites: false,
    }));
    this.#lane = new SessionLane(target.profileId, target.database);
  }

  get state(): ConsoleState {
    return this.store.getState();
  }

  #set(patch: Partial<ConsoleState>): void {
    this.store.setState(patch);
  }

  #message(message: Omit<ConsoleMessage, 'id' | 'at'>): void {
    const entry: ConsoleMessage = { ...message, id: newId(), at: new Date().toISOString() };
    this.#set({ messages: [...this.state.messages, entry] });
  }

  /** Reads the profile's write rules and the list of databases. */
  async init(): Promise<void> {
    const profile = await profileById(this.target.profileId);
    if (profile) {
      this.#set({
        readOnlyProfile: profile.presentation.readOnly,
        production: profile.presentation.environment === 'production',
        confirmWrites: requiresWriteConfirmation(profile),
      });
    }
    try {
      const { nodes, current } = await this.#lane.run(async (host, sessionId) => ({
        nodes: await host.browse({ sessionId, path: [] }),
        current: (await host.mongo.serverInfo({ sessionId })).version,
      }));
      const databases = nodes.filter((n) => n.kind === 'database').map((n) => n.name);
      this.#set({ databases });
      if (this.state.database === undefined)
        this.#message({ kind: 'info', text: `MongoDB ${current}` });
    } catch (error) {
      this.#message({
        kind: 'warning',
        text: `Databases could not be listed: ${errorMessage(error)}`,
      });
    }
  }

  /** Switches the database commands run against (the shell's `use`). */
  async useDatabase(database: string): Promise<void> {
    this.#set({ database });
    try {
      await this.#lane.run((host, sessionId) => host.mongo.useDatabase({ sessionId, database }));
    } catch (error) {
      this.#message({ kind: 'error', text: errorMessage(error) });
    }
  }

  /** Runs `text` as one command document. */
  async run(text: string): Promise<void> {
    const command = text.trim();
    if (command === '' || this.state.running) return;
    const safety = commandSafety(command);
    const s = this.state;
    if (safety.writes && s.readOnlyProfile) {
      this.#message({
        kind: 'error',
        text: `This connection is read-only: ${safety.name ?? 'the command'} writes, so it was not run.`,
      });
      this.#set({ pane: 'messages' });
      return;
    }
    if (safety.destructive || (safety.writes && s.confirmWrites)) {
      const ok = await confirm({
        title: s.production ? 'Run on a production connection?' : `Run ${safety.name}?`,
        message: safety.destructive
          ? 'This command can remove or change a lot of data.'
          : 'This connection asks before every write.',
        detail: command,
        confirmLabel: 'Run anyway',
        danger: true,
      });
      if (!ok) return;
    }
    const runId = ++this.#runId;
    await this.#closeStream();
    const execution = { id: newId(), controller: new AbortController() };
    this.#execution = execution;
    this.results.begin(async () => {
      await this.#fetch(runId).catch(() => undefined);
    });
    this.#set({ running: true, errorMarker: undefined, command: safety.name });
    patchPanel(this.id, { busy: true });
    const started = performance.now();
    let rows = 0;
    let status: 'success' | 'error' | 'cancelled' = 'success';
    let failure: string | undefined;
    try {
      this.#stream = await this.#lane.run(async (host, sessionId) => {
        if (this.state.database !== undefined) {
          await host.mongo.useDatabase({ sessionId, database: this.state.database });
        }
        return host.execute(
          { sessionId, text: command, executionId: execution.id, pageSize: CONSOLE_PAGE_SIZE },
          { signal: execution.controller.signal },
        );
      });
      rows = await this.#fetch(runId);
      this.#set({ pane: 'results' });
    } catch (error) {
      const info = errorInfo(error);
      status = info.code === 'CANCELLED' ? 'cancelled' : 'error';
      failure = info.message;
      this.results.fail(errorMessage(error));
      this.#message({
        kind: 'error',
        text: errorMessage(error),
        ...(info.detail ? { detail: info.detail } : {}),
      });
      if (info.position !== undefined) {
        this.#set({ errorMarker: { offset: info.position, message: info.message } });
      } else if (info.code === 'VALIDATION_FAILED') {
        const issue = issueOf(command, error);
        if (issue.offset > 0)
          this.#set({ errorMarker: { offset: issue.offset, message: issue.message } });
      }
      this.#set({ pane: 'messages' });
    } finally {
      if (this.#execution === execution) this.#execution = undefined;
      this.#set({ running: false });
      patchPanel(this.id, { busy: false });
    }
    await this.#record(command, status, failure, Math.round(performance.now() - started), rows);
  }

  /**
   * Pulls chunks until a page of documents is in (or the reply ends) and returns how many came.
   * A cursor reply stays open for the next page; its status and timing are noted at the end.
   */
  async #fetch(runId: number): Promise<number> {
    const stream = this.#stream;
    if (!stream || runId !== this.#runId) return 0;
    this.results.setLoading(true);
    const page: string[] = [];
    try {
      for (;;) {
        const chunk = this.#pending ?? (await stream.next()).value;
        this.#pending = undefined;
        if (runId !== this.#runId) return 0;
        if (chunk === undefined) {
          this.#stream = undefined;
          this.results.append(page, false);
          return page.length;
        }
        if (chunk.type === 'rows') {
          if (page.length >= CONSOLE_PAGE_SIZE) {
            this.#pending = chunk;
            this.results.append(page, true);
            return page.length;
          }
          for (const cell of chunk.data[0] ?? []) if (typeof cell === 'string') page.push(cell);
        } else if (chunk.type === 'status') {
          const affected = chunk.rowsAffected;
          if (affected !== null) {
            this.#message({
              kind: 'success',
              text: `${chunk.command ?? 'Command'}: ${formatCount(affected)} ${affected === 1 ? 'document' : 'documents'} affected`,
            });
          }
        } else if (chunk.type === 'end') {
          this.#message({
            kind: 'success',
            text: `${this.state.command ?? 'Command'} ran in ${chunk.durationMs} ms · ${formatCount(chunk.rowCount)} ${chunk.rowCount === 1 ? 'document' : 'documents'}`,
          });
        } else if (chunk.type === 'notice') {
          this.#message({ kind: 'warning', text: chunk.message });
        }
      }
    } catch (error) {
      this.#stream = undefined;
      if (runId === this.#runId) this.results.fail(errorMessage(error));
      throw error;
    }
  }

  async #closeStream(): Promise<void> {
    const stream = this.#stream;
    this.#stream = undefined;
    this.#pending = undefined;
    await stream?.return().catch(() => undefined);
  }

  /** Cancels the running command on the server. */
  async cancel(): Promise<void> {
    const execution = this.#execution;
    const current = this.#lane.current;
    if (!execution) return;
    execution.controller.abort();
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
        database: this.state.database ?? null,
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

  setPane(pane: ConsoleState['pane']): void {
    this.#set({ pane });
  }

  async dispose(): Promise<void> {
    this.#runId++;
    this.#execution?.controller.abort();
    await this.#closeStream();
    await this.#lane.close();
  }
}

/** Subscribes a component to part of a console's state. */
export function useConsoleState<T>(console: MongoConsole, selector: (state: ConsoleState) => T): T {
  return useStore(console.store, selector);
}
