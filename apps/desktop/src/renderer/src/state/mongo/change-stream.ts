import type { RpcStream } from '@joinery/ipc';
import {
  formatShell,
  formatShellInline,
  fromEjson,
  isBsonDocument,
  parseShell,
  toEjson,
  type BsonValue,
  type ChangeEvent,
  type WatchScope,
} from '@joinery/mongo-tools';
import { useStore } from 'zustand';
import { createStore, type StoreApi } from 'zustand/vanilla';

import { errorInfo, errorMessage } from '../../lib/errors';
import { patchPanel } from '../panels';
import { SessionLane } from '../session-lane';
import { issueOf, type TextIssue } from './query-bar';

/**
 * The change stream viewer (spec §9): tails a collection, a database or the whole deployment
 * and lists inserts, updates, replaces and deletes as they happen, with the document key, the
 * updated and removed fields and the full document in a detail pane. Pausing closes the stream
 * but keeps the last resume token, so resuming picks up every change made meanwhile; stopping
 * forgets it. Standalone servers have no change streams, which the viewer says up front.
 */

// ---------------------------------------------------------------------------------------------
// The event log

export interface ChangeEntry {
  /** Arrival order, from 1. */
  readonly seq: number;
  readonly operationType: string;
  /** "db.collection" (or the database for database-level events). */
  readonly namespace: string | undefined;
  /** The document key as mongosh prints it: the _id, or the whole key when it has more. */
  readonly documentKey: string | undefined;
  /** Updated fields of an update, as a mongosh document. */
  readonly updatedFields: string | undefined;
  readonly removedFields: readonly string[];
  /** The full document (inserts, replaces, and updates with the lookup on), in mongosh. */
  readonly fullDocument: string | undefined;
  /** ISO time of the change. */
  readonly clusterTime: string | undefined;
  /** Canonical Extended JSON of the whole event. */
  readonly event: string;
  readonly resumeToken: string;
}

export interface ChangeLog {
  /** Oldest first; at most `capacity`. */
  readonly entries: readonly ChangeEntry[];
  /** Events dropped from the front to stay within the capacity. */
  readonly dropped: number;
  /** Events seen per operation type (dropped ones included). */
  readonly counts: Readonly<Record<string, number>>;
  readonly lastSeq: number;
}

export const EMPTY_CHANGE_LOG: ChangeLog = { entries: [], dropped: 0, counts: {}, lastSeq: 0 };

/** Events the viewer keeps. */
export const CHANGE_LOG_CAPACITY = 1000;

function field(event: BsonValue, key: string): BsonValue | undefined {
  return isBsonDocument(event) ? event[key] : undefined;
}

/** One event as the list and the detail pane show it. */
export function changeEntry(event: ChangeEvent, seq: number): ChangeEntry {
  let parsed: BsonValue = {};
  try {
    parsed = fromEjson(event.event, 'change event');
  } catch {
    // Shown from the wire fields only.
  }
  const key =
    event.documentKey !== undefined ? fromEjson(event.documentKey, 'document key') : undefined;
  const keyText =
    key === undefined
      ? undefined
      : isBsonDocument(key) && Object.keys(key).length === 1 && key['_id'] !== undefined
        ? formatShellInline(key['_id'])
        : formatShellInline(key);
  const update = field(parsed, 'updateDescription');
  const updated = field(update ?? {}, 'updatedFields');
  const removed = field(update ?? {}, 'removedFields');
  const full = field(parsed, 'fullDocument');
  return {
    seq,
    operationType: event.operationType,
    namespace: event.ns
      ? event.ns.collection !== undefined
        ? `${event.ns.db}.${event.ns.collection}`
        : event.ns.db
      : undefined,
    documentKey: keyText,
    updatedFields: updated !== undefined ? formatShellInline(updated) : undefined,
    removedFields: Array.isArray(removed) ? removed.map((name) => String(name)) : [],
    fullDocument: full !== undefined && full !== null ? formatShell(full) : undefined,
    clusterTime: event.clusterTime,
    event: event.event,
    resumeToken: event.resumeToken,
  };
}

/** Adds events to the log, dropping the oldest past `capacity`. */
export function appendChanges(
  log: ChangeLog,
  events: readonly ChangeEvent[],
  capacity = CHANGE_LOG_CAPACITY,
): ChangeLog {
  if (events.length === 0) return log;
  const counts = { ...log.counts };
  let seq = log.lastSeq;
  const added = events.map((event) => {
    seq += 1;
    counts[event.operationType] = (counts[event.operationType] ?? 0) + 1;
    return changeEntry(event, seq);
  });
  const all = [...log.entries, ...added];
  const over = Math.max(0, all.length - capacity);
  return {
    entries: over > 0 ? all.slice(over) : all,
    dropped: log.dropped + over,
    counts,
    lastSeq: seq,
  };
}

/**
 * The optional pipeline typed by the user: a `$match` filter document (`{ operationType:
 * 'insert' }`) or a whole pipeline array. Empty means every change.
 */
export function watchPipeline(
  text: string,
): { pipeline: string | undefined } | { issue: TextIssue } {
  if (text.trim() === '') return { pipeline: undefined };
  try {
    const value = parseShell(text);
    if (Array.isArray(value)) {
      if (!value.every(isBsonDocument)) throw new Error('Every pipeline stage must be a document');
      return { pipeline: toEjson(value) };
    }
    if (!isBsonDocument(value))
      throw new Error('Type a $match filter document or a pipeline array');
    const keys = Object.keys(value);
    const stage = keys.length === 1 && keys[0]!.startsWith('$') ? value : { $match: value };
    return { pipeline: toEjson([stage]) };
  } catch (error) {
    return { issue: issueOf(text, error) };
  }
}

/** What the viewer's title calls the scope. */
export function scopeLabel(scope: WatchScope): string {
  return scope.kind === 'cluster'
    ? 'the whole deployment'
    : scope.kind === 'database'
      ? `database ${scope.db}`
      : `${scope.ns.db}.${scope.ns.collection}`;
}

// ---------------------------------------------------------------------------------------------
// The viewer

export interface ChangeStreamTarget {
  readonly profileId: string;
  readonly scope: WatchScope;
}

export type WatchStatus = 'stopped' | 'watching' | 'paused' | 'error';

export interface ChangeStreamState {
  readonly scope: WatchScope;
  readonly status: WatchStatus;
  readonly pipelineText: string;
  readonly pipelineIssue: TextIssue | undefined;
  /** Look up the current full document for updates (fullDocument: 'updateLookup'). */
  readonly fullDocument: boolean;
  readonly log: ChangeLog;
  readonly selected: number | undefined;
  /** Where a resume continues; kept by pause, forgotten by stop. */
  readonly resumeToken: string | undefined;
  readonly error: string | undefined;
  /** The deployment is a standalone server: there are no change streams. */
  readonly standalone: boolean;
  readonly startedAt: string | undefined;
}

export class ChangeStreamViewer {
  readonly id: string;
  readonly target: ChangeStreamTarget;
  readonly store: StoreApi<ChangeStreamState>;
  readonly #lane: SessionLane;
  #controller: AbortController | undefined;
  #stream: RpcStream<ChangeEvent> | undefined;

  constructor(id: string, target: ChangeStreamTarget) {
    this.id = id;
    this.target = target;
    this.store = createStore<ChangeStreamState>()(() => ({
      scope: target.scope,
      status: 'stopped',
      pipelineText: '',
      pipelineIssue: undefined,
      fullDocument: true,
      log: EMPTY_CHANGE_LOG,
      selected: undefined,
      resumeToken: undefined,
      error: undefined,
      standalone: false,
      startedAt: undefined,
    }));
    const db =
      target.scope.kind === 'database'
        ? target.scope.db
        : target.scope.kind === 'collection'
          ? target.scope.ns.db
          : undefined;
    this.#lane = new SessionLane(target.profileId, db);
  }

  get state(): ChangeStreamState {
    return this.store.getState();
  }

  #set(patch: Partial<ChangeStreamState>): void {
    this.store.setState(patch);
  }

  /** Finds out whether the deployment has change streams. */
  async init(): Promise<void> {
    try {
      const info = await this.#lane.run((host, sessionId) => host.mongo.serverInfo({ sessionId }));
      if (info.topology === 'standalone') this.#set({ standalone: true });
    } catch (error) {
      this.#set({ error: errorMessage(error) });
    }
  }

  setScope(scope: WatchScope): void {
    if (this.state.status === 'watching') return;
    this.#set({ scope, resumeToken: undefined, status: 'stopped' });
  }

  setPipelineText(text: string): void {
    const parsed = watchPipeline(text);
    this.#set({ pipelineText: text, pipelineIssue: 'issue' in parsed ? parsed.issue : undefined });
  }

  setFullDocument(fullDocument: boolean): void {
    this.#set({ fullDocument });
  }

  /** Starts watching (from the kept resume token after a pause). */
  async start(): Promise<void> {
    if (this.state.status === 'watching') return;
    if (this.state.standalone) {
      this.#set({ status: 'error', error: STANDALONE_TEXT });
      return;
    }
    const parsed = watchPipeline(this.state.pipelineText);
    if ('issue' in parsed) {
      this.#set({ pipelineIssue: parsed.issue });
      return;
    }
    const resumeAfter = this.state.resumeToken;
    const controller = new AbortController();
    this.#controller = controller;
    this.#set({
      status: 'watching',
      error: undefined,
      ...(resumeAfter === undefined ? { startedAt: new Date().toISOString() } : {}),
    });
    patchPanel(this.id, { busy: true });
    try {
      const stream = await this.#lane.run(async (host, sessionId) =>
        host.mongo.watch(
          {
            sessionId,
            scope: this.state.scope,
            ...(parsed.pipeline !== undefined ? { pipeline: parsed.pipeline } : {}),
            options: {
              fullDocument: this.state.fullDocument ? 'updateLookup' : 'default',
              ...(resumeAfter !== undefined ? { resumeAfter } : {}),
            },
          },
          { signal: controller.signal },
        ),
      );
      this.#stream = stream;
      for await (const event of stream) {
        if (this.#controller !== controller) break;
        this.#set({
          log: appendChanges(this.state.log, [event]),
          resumeToken: event.resumeToken,
        });
      }
      if (this.#controller === controller) this.#set({ status: 'stopped' });
    } catch (error) {
      if (this.#controller !== controller || controller.signal.aborted) return;
      const info = errorInfo(error);
      if (info.code === 'CANCELLED') {
        this.#set({ status: 'stopped' });
        return;
      }
      this.#set({
        status: 'error',
        error: info.code === 'NOT_SUPPORTED' ? STANDALONE_TEXT : errorMessage(error),
        ...(info.code === 'NOT_SUPPORTED' ? { standalone: true } : {}),
      });
    } finally {
      if (this.#controller === controller) {
        this.#controller = undefined;
        this.#stream = undefined;
        patchPanel(this.id, { busy: false });
      }
    }
  }

  async #close(): Promise<void> {
    const controller = this.#controller;
    const stream = this.#stream;
    this.#controller = undefined;
    this.#stream = undefined;
    controller?.abort();
    await stream?.return().catch(() => undefined);
    patchPanel(this.id, { busy: false });
  }

  /** Stops the stream and keeps the resume token, so `start` continues where it paused. */
  async pause(): Promise<void> {
    if (this.state.status !== 'watching') return;
    this.#set({ status: 'paused' });
    await this.#close();
  }

  /** Stops and forgets where it was: the next start sees only new changes. */
  async stop(): Promise<void> {
    this.#set({ status: 'stopped', resumeToken: undefined });
    await this.#close();
  }

  clear(): void {
    this.#set({
      log: { ...EMPTY_CHANGE_LOG, lastSeq: this.state.log.lastSeq },
      selected: undefined,
    });
  }

  select(seq: number | undefined): void {
    this.#set({ selected: seq });
  }

  async dispose(): Promise<void> {
    await this.#close();
    await this.#lane.close();
  }
}

export const STANDALONE_TEXT =
  'Change streams need a replica set or a sharded cluster; this server is a standalone. A one-member replica set works for development.';

export function useChangeStream<T>(
  viewer: ChangeStreamViewer,
  selector: (state: ChangeStreamState) => T,
): T {
  return useStore(viewer.store, selector);
}
