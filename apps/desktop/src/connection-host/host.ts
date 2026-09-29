import {
  JoineryError,
  isSqlEngine,
  newId,
  type ConnectionProfile,
  type DriverAdapter,
  type ResolvedProfile,
  type Session,
} from '@joinery/core';
import {
  connectionHostContract,
  serve,
  type HandlersOf,
  type PortLike,
  type ServerInfo,
} from '@joinery/ipc';
import { analyzeStatement } from '@joinery/sql-tools';
import { applyChanges } from '@joinery/table-data';
import type { TransportSession } from '@joinery/tunnel';

import { redisWritePolicy } from '../shared/redis-safety';
import { searchWritePolicy } from '../shared/search-writes';
import { executeRedisGuarded, isRedisSession, redisHandlers } from './redis';
import { executeSearchGuarded, searchHandlers } from './search';

import type { HostRequest } from '../shared/host-protocol';
import { mongoHandlers } from './mongo';
import { runHostRequest, type HostRequestOptions } from './mongo-files';
import { serverToolsHandlers } from './server-tools';

/** Opens a driver session, through the profile's SSH tunnel or proxy when it has one. */
export type SessionOpener = (resolved: ResolvedProfile) => Promise<TransportSession>;

export interface ConnectionHostOptions {
  /** How sessions open; the adapter directly by default. The app passes the process's tunnels. */
  readonly open?: SessionOpener;
  /**
   * The SSH session under the tunnel dropped, taking every session of this host with it. Called
   * once; main then restarts the host, which reopens the tunnel.
   */
  readonly onTransportLost?: (error: JoineryError) => void;
}

/** A driver session and how to close it (and release its tunnel). */
interface OpenedSession {
  readonly session: Session;
  readonly close: () => Promise<void>;
}

/**
 * One open connection (spec §3): a driver adapter, a metadata session opened at start (it proves
 * the profile connects and answers `serverInfo`/`ping`), and one session per query tab or
 * explorer. Each MessagePort main transfers gets its own server; sessions belong to the port that
 * opened them and are closed when it goes away, so a reloaded or closed window leaks nothing.
 */
export class ConnectionHost {
  readonly #adapter: DriverAdapter;
  readonly #resolved: ResolvedProfile;
  readonly #sessions = new Map<string, OpenedSession & { readonly owner: symbol }>();
  readonly #open: SessionOpener;
  readonly #onTransportLost: ((error: JoineryError) => void) | undefined;
  #meta: OpenedSession | undefined;
  #info: ServerInfo | undefined;
  #lost = false;

  constructor(
    adapter: DriverAdapter,
    resolved: ResolvedProfile,
    options: ConnectionHostOptions = {},
  ) {
    this.#adapter = adapter;
    this.#resolved = resolved;
    this.#open = options.open ?? ((profile) => this.#connectDirect(profile));
    this.#onTransportLost = options.onTransportLost;
  }

  /**
   * Connects the metadata session (and the tunnel, when the profile has one). Rejects with the
   * driver's or the tunnel's error (AUTH_FAILED, TLS_FAILED, SSH_FAILED...).
   */
  async start(): Promise<ServerInfo> {
    const opened = await this.#connect(this.#resolved);
    this.#meta = opened;
    const session = opened.session;
    this.#info = {
      engine: session.engine,
      serverVersion: session.serverVersion,
      capabilities: session.capabilities(),
    };
    return this.#info;
  }

  /** Serves the connection host contract on `port` until it closes. */
  attach(port: PortLike): { dispose(): void } {
    const owner = Symbol('port');
    const server = serve(port, connectionHostContract, this.#handlers(owner));
    let disposed = false;
    const dispose = (): void => {
      if (disposed) return;
      disposed = true;
      unsubscribe();
      server.dispose();
      void this.#closeOwnedBy(owner);
    };
    const unsubscribe = port.onClose(dispose);
    return { dispose };
  }

  /**
   * Closes every session (open transactions roll back with them); the last one to close
   * releases the tunnel.
   */
  async shutdown(): Promise<void> {
    const sessions: OpenedSession[] = [...this.#sessions.values()];
    this.#sessions.clear();
    if (this.#meta) sessions.push(this.#meta);
    this.#meta = undefined;
    await Promise.allSettled(sessions.map((opened) => opened.close()));
  }

  get sessionCount(): number {
    return this.#sessions.size;
  }

  /** Runs file work main hands over (GridFS uploads and downloads by path) on the metadata session. */
  request(request: HostRequest, options: HostRequestOptions): Promise<unknown> {
    return runHostRequest(this.#metaSession(), request, options);
  }

  async #closeOwnedBy(owner: symbol): Promise<void> {
    const owned = [...this.#sessions].filter(([, entry]) => entry.owner === owner);
    for (const [id] of owned) this.#sessions.delete(id);
    await Promise.allSettled(owned.map(([, entry]) => entry.close()));
  }

  async #connectDirect(resolved: ResolvedProfile): Promise<TransportSession> {
    const session = await this.#adapter.connect(resolved);
    return { session, close: () => session.close() };
  }

  /** Opens a session and watches its tunnel for a dropped SSH session. */
  async #connect(resolved: ResolvedProfile): Promise<OpenedSession> {
    const opened = await this.#open(resolved);
    opened.transport?.onError((error) => {
      if (error.engineCode !== 'SSH_DISCONNECTED' || this.#lost) return;
      this.#lost = true;
      this.#onTransportLost?.(error);
    });
    return { session: opened.session, close: () => opened.close() };
  }

  /**
   * Replaces a session's connection with a new one under the same id, in `database` (a Redis
   * CLI command is cancelled by dropping its connection). The session is forgotten when the new
   * connection cannot open, so the next call reopens one.
   */
  async #resetSession(sessionId: string, database: number): Promise<void> {
    const entry = this.#sessions.get(sessionId);
    if (!entry) return;
    await entry.close().catch(() => undefined);
    try {
      const opened = await this.#connect(this.#profileFor(String(database)));
      if (this.#sessions.get(sessionId) === entry) {
        this.#sessions.set(sessionId, { ...opened, owner: entry.owner });
      } else {
        await opened.close();
      }
    } catch (error) {
      if (this.#sessions.get(sessionId) === entry) this.#sessions.delete(sessionId);
      throw error;
    }
  }

  #session(sessionId: string): Session {
    const entry = this.#sessions.get(sessionId);
    if (!entry) {
      throw new JoineryError({
        code: 'NOT_FOUND',
        message: 'The session is closed',
        hint: 'Run the statement again to open a new session.',
      });
    }
    return entry.session;
  }

  #metaSession(): Session {
    if (!this.#meta)
      throw new JoineryError({ code: 'CONNECTION_FAILED', message: 'Not connected' });
    return this.#meta.session;
  }

  #profileFor(database: string | undefined): ResolvedProfile {
    if (database === undefined) return this.#resolved;
    const { profile } = this.#resolved;
    return {
      ...this.#resolved,
      profile: { ...profile, options: { ...profile.options, defaultDatabase: database } },
    };
  }

  #handlers(owner: symbol): HandlersOf<typeof connectionHostContract> {
    const unsupported = (what: string): JoineryError =>
      new JoineryError({
        code: 'NOT_SUPPORTED',
        message: `${what} is not supported for this engine`,
      });
    return {
      openSession: async ({ database }) => {
        const opened = await this.#connect(this.#profileFor(database));
        const sessionId = newId();
        this.#sessions.set(sessionId, { ...opened, owner });
        return { sessionId };
      },
      closeSession: async ({ sessionId }) => {
        const entry = this.#sessions.get(sessionId);
        if (!entry) return;
        this.#sessions.delete(sessionId);
        await entry.close();
      },
      execute: ({ sessionId, text, executionId, params, pageSize }, { signal }) => {
        const session = this.#session(sessionId);
        const options = {
          executionId,
          signal,
          ...(params === undefined ? {} : { params }),
          ...(pageSize === undefined ? {} : { pageSize }),
        };
        if (isRedisSession(session)) {
          return executeRedisGuarded(
            session,
            text,
            options,
            redisWritePolicy(this.#resolved.profile),
          );
        }
        if (session.engine === 'elasticsearch' || session.engine === 'opensearch') {
          return executeSearchGuarded(
            session,
            text,
            options,
            searchWritePolicy(this.#resolved.profile),
          );
        }
        return session.execute(text, options);
      },
      cancel: ({ sessionId, executionId }) => this.#session(sessionId).cancel(executionId),
      introspect: ({ sessionId, scope }) => this.#session(sessionId).introspect(scope),
      browse: ({ sessionId, path }) => this.#session(sessionId).browse(path),
      explain: ({ sessionId, text, options }) => {
        const session = this.#session(sessionId);
        if (!session.explain) throw unsupported('EXPLAIN');
        return session.explain(text, options);
      },
      explainPlan: ({ sessionId, text, options, confirmed }) => {
        const session = this.#session(sessionId);
        if (!session.explainPlan) throw unsupported('EXPLAIN');
        if (options?.analyze) checkExplainAnalyze(this.#resolved.profile, text, confirmed === true);
        return session.explainPlan(text, options);
      },
      begin: async ({ sessionId }) => {
        const session = this.#session(sessionId);
        if (!session.begin) throw unsupported('Transactions');
        await session.begin();
      },
      commit: async ({ sessionId }) => {
        const session = this.#session(sessionId);
        if (!session.commit) throw unsupported('Transactions');
        await session.commit();
      },
      rollback: async ({ sessionId }) => {
        const session = this.#session(sessionId);
        if (!session.rollback) throw unsupported('Transactions');
        await session.rollback();
      },
      sessionState: ({ sessionId }) => ({
        inTransaction: this.#session(sessionId).inTransaction,
      }),
      applyChanges: ({ sessionId, plan }, { signal }) => {
        // The grid refuses too; this keeps a read-only profile read-only whatever the page sends.
        if (this.#resolved.profile.presentation.readOnly) {
          throw new JoineryError({
            code: 'READ_ONLY',
            message: 'This connection is read-only, so the changes were not applied',
          });
        }
        return applyChanges(this.#session(sessionId), plan, { signal });
      },
      ping: async (input) => {
        const id = input?.sessionId;
        await (id === undefined ? this.#metaSession() : this.#session(id)).ping();
      },
      serverInfo: () => {
        if (!this.#info)
          throw new JoineryError({ code: 'CONNECTION_FAILED', message: 'Not connected' });
        return this.#info;
      },
      redis: redisHandlers({
        policy: redisWritePolicy(this.#resolved.profile),
        session: (sessionId) => this.#session(sessionId),
        resetSession: (sessionId, database) => this.#resetSession(sessionId, database),
      }),
      mongo: mongoHandlers({
        session: (sessionId) => this.#session(sessionId),
        profile: this.#resolved.profile,
      }),
      serverTools: serverToolsHandlers({
        session: (sessionId) => this.#session(sessionId),
        profile: this.#resolved.profile,
      }),
      search: searchHandlers({
        session: (sessionId) => this.#session(sessionId),
        profile: this.#resolved.profile,
        policy: searchWritePolicy(this.#resolved.profile),
      }),
    };
  }
}

/**
 * The write rules for EXPLAIN ANALYZE, which executes the statement (spec §4, §6), enforced here
 * whatever the page sends. The drivers roll the statement back, but a read-only profile still
 * refuses a statement that writes (sequences advance, non-transactional tables keep changes),
 * and every other profile needs the user's confirmation first.
 */
export function checkExplainAnalyze(
  profile: ConnectionProfile,
  text: string,
  confirmed: boolean,
): void {
  if (!isSqlEngine(profile.engine)) return;
  if (!analyzeStatement(text, profile.engine).isWrite) return;
  if (profile.presentation.readOnly) {
    throw new JoineryError({
      code: 'READ_ONLY',
      message:
        'This connection is read-only, and EXPLAIN ANALYZE would run a statement that writes',
      hint: 'Explain it without ANALYZE to see the estimated plan.',
    });
  }
  if (!confirmed) {
    throw new JoineryError({
      code: 'CONFIRMATION_REQUIRED',
      message: 'EXPLAIN ANALYZE of a statement that writes needs confirmation',
    });
  }
}
