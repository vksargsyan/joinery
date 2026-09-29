import {
  JoineryError,
  newId,
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

/**
 * One open connection (spec §3): a driver adapter, a metadata session opened at start (it proves
 * the profile connects and answers `serverInfo`/`ping`), and one session per query tab or
 * explorer. Each MessagePort main transfers gets its own server; sessions belong to the port that
 * opened them and are closed when it goes away, so a reloaded or closed window leaks nothing.
 */
export class ConnectionHost {
  readonly #adapter: DriverAdapter;
  readonly #resolved: ResolvedProfile;
  readonly #sessions = new Map<string, { readonly session: Session; readonly owner: symbol }>();
  #meta: Session | undefined;
  #info: ServerInfo | undefined;

  constructor(adapter: DriverAdapter, resolved: ResolvedProfile) {
    this.#adapter = adapter;
    this.#resolved = resolved;
  }

  /** Connects the metadata session. Rejects with the driver's error (AUTH_FAILED, TLS_FAILED...). */
  async start(): Promise<ServerInfo> {
    const session = await this.#adapter.connect(this.#resolved);
    this.#meta = session;
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

  /** Closes every session (open transactions roll back with them). */
  async shutdown(): Promise<void> {
    const sessions = [...this.#sessions.values()].map((entry) => entry.session);
    this.#sessions.clear();
    if (this.#meta) sessions.push(this.#meta);
    this.#meta = undefined;
    await Promise.allSettled(sessions.map((session) => session.close()));
  }

  get sessionCount(): number {
    return this.#sessions.size;
  }

  async #closeOwnedBy(owner: symbol): Promise<void> {
    const owned = [...this.#sessions].filter(([, entry]) => entry.owner === owner);
    for (const [id] of owned) this.#sessions.delete(id);
    await Promise.allSettled(owned.map(([, entry]) => entry.session.close()));
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
    return this.#meta;
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
        const session = await this.#adapter.connect(this.#profileFor(database));
        const sessionId = newId();
        this.#sessions.set(sessionId, { session, owner });
        return { sessionId };
      },
      closeSession: async ({ sessionId }) => {
        const entry = this.#sessions.get(sessionId);
        if (!entry) return;
        this.#sessions.delete(sessionId);
        await entry.session.close();
      },
      execute: ({ sessionId, text, executionId, params, pageSize }, { signal }) =>
        this.#session(sessionId).execute(text, {
          executionId,
          signal,
          ...(params === undefined ? {} : { params }),
          ...(pageSize === undefined ? {} : { pageSize }),
        }),
      cancel: ({ sessionId, executionId }) => this.#session(sessionId).cancel(executionId),
      introspect: ({ sessionId, scope }) => this.#session(sessionId).introspect(scope),
      browse: ({ sessionId, path }) => this.#session(sessionId).browse(path),
      explain: ({ sessionId, text, options }) => {
        const session = this.#session(sessionId);
        if (!session.explain) throw unsupported('EXPLAIN');
        return session.explain(text, options);
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
      ping: async (input) => {
        const id = input?.sessionId;
        await (id === undefined ? this.#metaSession() : this.#session(id)).ping();
      },
      serverInfo: () => {
        if (!this.#info)
          throw new JoineryError({ code: 'CONNECTION_FAILED', message: 'Not connected' });
        return this.#info;
      },
    };
  }
}
