import type { SchemaSnapshot, SqlDialect, SqlEngineId, TableDef } from '@querybara/core';
import type { CompletionResult, SignatureHelp, SqlDiagnostic } from '@querybara/sql-tools';
import type { ValidationIssue } from '@querybara/sync';

import type {
  CompleteRequest,
  LanguageRequest,
  LanguageResponse,
  LanguageTask,
  SignatureRequest,
} from '../workers/language-service';

/**
 * The renderer's side of the language worker (spec §6): requests matched to replies by id, and
 * cancelled when their AbortSignal fires (Monaco's cancellation token), so a stale completion
 * never runs if it is still queued. It also keeps the snapshots it sent per connection, so a
 * worker that died is replaced and refilled on the next request; until then requests answer
 * nothing, which costs only the suggestions.
 */

/** What the client needs of a Worker (a real one, or the service in-process in tests). */
export interface WorkerLike {
  postMessage(message: LanguageRequest): void;
  addEventListener(type: 'message', listener: (event: { data: LanguageResponse }) => void): void;
  addEventListener(type: 'error', listener: () => void): void;
  terminate(): void;
}

type Pending = (response: LanguageResponse | undefined) => void;

interface ProfileSnapshots {
  readonly snapshots: Map<string, SchemaSnapshot>;
  databases?: readonly string[];
}

type TaskInput<T extends LanguageTask> = Omit<T, 'id' | 'type'>;
type WithoutId<T> = T extends unknown ? Omit<T, 'id'> : never;

export class LanguageClient {
  readonly #create: () => WorkerLike;
  #worker: WorkerLike | undefined;
  #nextId = 1;
  readonly #pending = new Map<number, Pending>();
  readonly #profiles = new Map<string, ProfileSnapshots>();

  constructor(create: () => WorkerLike) {
    this.#create = create;
  }

  /** Updates a connection's snapshots in the worker (upsert by database, remove, database list). */
  setSnapshots(
    profileId: string,
    change: {
      readonly put?: readonly SchemaSnapshot[];
      readonly remove?: readonly string[];
      readonly databases?: readonly string[];
    },
  ): void {
    let profile = this.#profiles.get(profileId);
    if (!profile) {
      profile = { snapshots: new Map() };
      this.#profiles.set(profileId, profile);
    }
    for (const database of change.remove ?? []) profile.snapshots.delete(database);
    for (const snapshot of change.put ?? []) profile.snapshots.set(snapshot.database, snapshot);
    if (change.databases) profile.databases = change.databases;
    // A worker that is not running gets everything when it starts.
    this.#worker?.postMessage({ type: 'snapshots', profileId, ...change });
  }

  /** Drops a connection's snapshots. */
  forget(profileId: string): void {
    this.#profiles.delete(profileId);
    this.#worker?.postMessage({ type: 'forget', profileId });
  }

  /** Completions, or undefined when cancelled or the worker failed. */
  async complete(
    request: TaskInput<CompleteRequest>,
    signal?: AbortSignal,
  ): Promise<CompletionResult | undefined> {
    const response = await this.#request({ ...request, type: 'complete' }, signal);
    return response?.type === 'complete' ? response.result : undefined;
  }

  /** Signature help at the offset, or undefined outside a known call. */
  async signatureHelp(
    request: TaskInput<SignatureRequest>,
    signal?: AbortSignal,
  ): Promise<SignatureHelp | undefined> {
    const response = await this.#request({ ...request, type: 'signature' }, signal);
    return response?.type === 'signature' ? (response.result ?? undefined) : undefined;
  }

  /** Syntax errors in `text`, at most one per statement. Never rejects. */
  async diagnose(
    text: string,
    dialect: SqlDialect,
    options: { readonly channel?: string; readonly signal?: AbortSignal } = {},
  ): Promise<readonly SqlDiagnostic[]> {
    const response = await this.#request(
      {
        type: 'diagnose',
        text,
        dialect,
        ...(options.channel === undefined ? {} : { channel: options.channel }),
      },
      options.signal,
    );
    return response?.type === 'diagnose' ? response.diagnostics : [];
  }

  /** Syntax errors in a designed table's expressions (`diagnoseTable`). Never rejects. */
  async diagnoseTable(
    table: TableDef,
    engine: SqlEngineId,
    schema: string,
  ): Promise<readonly ValidationIssue[]> {
    const response = await this.#request(
      { type: 'diagnose-table', table, engine, schema },
      undefined,
    );
    return response?.type === 'diagnose-table' ? response.issues : [];
  }

  /** Stops the worker; the next request starts a new one. */
  dispose(): void {
    this.#worker?.terminate();
    this.#worker = undefined;
    for (const resolve of this.#pending.values()) resolve(undefined);
    this.#pending.clear();
  }

  #request(
    task: WithoutId<LanguageTask>,
    signal: AbortSignal | undefined,
  ): Promise<LanguageResponse | undefined> {
    if (signal?.aborted) return Promise.resolve(undefined);
    const id = this.#nextId++;
    const worker = this.#start();
    return new Promise((resolve) => {
      const onAbort = (): void => {
        if (!this.#pending.has(id)) return;
        this.#pending.delete(id);
        resolve(undefined);
        worker.postMessage({ type: 'cancel', id });
      };
      this.#pending.set(id, (response) => {
        signal?.removeEventListener('abort', onAbort);
        resolve(response);
      });
      signal?.addEventListener('abort', onAbort, { once: true });
      worker.postMessage({ ...task, id });
    });
  }

  #start(): WorkerLike {
    if (this.#worker) return this.#worker;
    const worker = this.#create();
    worker.addEventListener('message', (event) => {
      const resolve = this.#pending.get(event.data.id);
      this.#pending.delete(event.data.id);
      resolve?.(
        event.data.type === 'cancelled' || event.data.type === 'error' ? undefined : event.data,
      );
    });
    worker.addEventListener('error', () => {
      if (this.#worker !== worker) return;
      this.dispose();
    });
    this.#worker = worker;
    for (const [profileId, profile] of this.#profiles) {
      worker.postMessage({
        type: 'snapshots',
        profileId,
        replace: true,
        put: [...profile.snapshots.values()],
        ...(profile.databases ? { databases: profile.databases } : {}),
      });
    }
    return worker;
  }
}
