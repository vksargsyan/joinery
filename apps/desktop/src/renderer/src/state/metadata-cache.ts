import { JoineryError, type SchemaSnapshot, type SqlDialect } from '@joinery/core';

import { errorMessage } from '../lib/errors';
import {
  effectsOfRun,
  type ConnectionFacts,
  type RanStatement,
  type RunEffects,
} from './session-facts';

/**
 * The app's one schema metadata cache, per connection (spec §5: a metadata cache per connection
 * in SQLite feeds autocomplete; §8: the designers share it). It serves the table views and the
 * designer (`snapshot`) and feeds autocomplete (`MetadataSink.publish`).
 *
 * When a connection opens, its snapshots cached in the local store go to autocomplete at once,
 * so completion works immediately; then the connection's session facts are read and the
 * snapshots refreshed from the server in the background and stored again. A snapshot the
 * designer or a table view asks for is always one read from the server since the last change
 * Joinery knows of, never the stored copy.
 *
 * Large servers are never introspected whole: PostgreSQL loads the connected database (the
 * others cannot be queried from it, so they load only when a designer or table view asks),
 * MySQL/MariaDB the current database plus each database the user expands in the explorer,
 * switches to with USE, names as a qualifier or opens a table in. Refreshes follow DDL run from
 * Joinery (at COMMIT inside a PostgreSQL transaction), designer saves and drops (`invalidate`)
 * and the explorer's Refresh. `MetadataSink.changed` reports structure that changed, so open
 * views reload their definitions and the explorer its folders.
 *
 * Everything that touches the app (the store, connection hosts, the worker, the UI) comes in
 * through `MetadataSource` and `MetadataSink`, so the decisions are testable on their own.
 */

/** Where metadata comes from: the local store through main, and the connection host. */
export interface MetadataSource {
  /** Cached snapshots of a profile (every database cached for it). */
  loadCached(profileId: string): Promise<readonly SchemaSnapshot[]>;
  /** Stores a fresh snapshot in the local cache. */
  store(profileId: string, snapshot: SchemaSnapshot): Promise<void>;
  /** Drops a database's cached snapshot. */
  drop(profileId: string, database: string): Promise<void>;
  /** The connection's session facts (and MySQL's database list), from small queries. */
  facts(profileId: string, dialect: SqlDialect): Promise<ConnectionFacts>;
  /** Introspects one database, or (PostgreSQL) some of its schemas. */
  introspect(
    profileId: string,
    dialect: SqlDialect,
    database: string,
    schemas?: readonly string[],
  ): Promise<SchemaSnapshot>;
}

/** A change to the snapshots the language worker holds for a profile. */
export interface SnapshotChange {
  readonly put?: readonly SchemaSnapshot[];
  readonly remove?: readonly string[];
  /** MySQL/MariaDB: every database on the server (unloaded ones complete as names only). */
  readonly databases?: readonly string[];
}

export interface MetadataStatus {
  /** Snapshots are being read or refreshed. */
  readonly loading: boolean;
  /** Why the last load failed; cleared by the next success. */
  readonly error?: string;
}

/** Structure that changed on the server. */
export interface StructureChange {
  /** Databases whose snapshots changed. */
  readonly databases: readonly string[];
  /** Databases were created or dropped. */
  readonly list: boolean;
}

/** Where metadata goes: autocomplete, the views and the UI. */
export interface MetadataSink {
  /** Snapshots autocomplete uses: PostgreSQL's connected database, every loaded MySQL database. */
  publish(profileId: string, change: SnapshotChange): void;
  forget(profileId: string): void;
  status(profileId: string, status: MetadataStatus): void;
  changed(profileId: string, change: StructureChange): void;
}

/** When an introspection reports its database as changed. */
type Notify = 'if-different' | 'always';

interface Job {
  again: boolean;
  notify: Notify | undefined;
  error: unknown;
  promise: Promise<void>;
}

interface Entry {
  readonly snapshot: SchemaSnapshot;
  /** Read from the server since the last change Joinery knows of (not the stored copy). */
  readonly fresh: boolean;
}

interface ProfileState {
  readonly dialect: SqlDialect;
  facts: ConnectionFacts | undefined;
  readonly factsRead: Promise<void>;
  readonly entries: Map<string, Entry>;
  /** MySQL/MariaDB databases the user expanded or used before the facts were read. */
  readonly wanted: Set<string>;
  readonly jobs: Map<string, Job>;
  /** Databases DDL changed inside a still-open transaction, per tab, refreshed on COMMIT. */
  readonly deferred: Map<string, Set<string>>;
  busy: number;
  error: string | undefined;
  closed: boolean;
  failed: boolean;
  started: Promise<void>;
}

/** A snapshot's structure, without the time it was read. */
function structureOf(snapshot: SchemaSnapshot): string {
  const { capturedAt: _capturedAt, ...structure } = snapshot;
  return JSON.stringify(structure);
}

export class MetadataCache {
  readonly #profiles = new Map<string, ProfileState>();

  constructor(
    private readonly source: MetadataSource,
    private readonly sink: MetadataSink,
  ) {}

  /**
   * Starts loading a connection's metadata; repeated calls join the first until it fails. The
   * promise settles once the cache is published and the first refresh is done; it never rejects.
   */
  open(profileId: string, dialect: SqlDialect): Promise<void> {
    return this.#open(profileId, dialect).started;
  }

  #open(profileId: string, dialect: SqlDialect): ProfileState {
    const existing = this.#profiles.get(profileId);
    if (existing && existing.dialect === dialect && !existing.failed) return existing;
    if (existing) this.close(profileId);
    let factsRead = (): void => {};
    const state: ProfileState = {
      dialect,
      facts: undefined,
      factsRead: new Promise<void>((resolve) => {
        factsRead = resolve;
      }),
      entries: new Map(),
      wanted: new Set(),
      jobs: new Map(),
      deferred: new Map(),
      busy: 0,
      error: undefined,
      closed: false,
      failed: false,
      started: Promise.resolve(),
    };
    this.#profiles.set(profileId, state);
    state.started = this.#start(profileId, state).finally(factsRead);
    return state;
  }

  /** Forgets a connection's metadata (it was closed); the local store keeps its copy. */
  close(profileId: string): void {
    const state = this.#profiles.get(profileId);
    if (!state) return;
    state.closed = true;
    this.#profiles.delete(profileId);
    this.sink.forget(profileId);
    this.sink.status(profileId, { loading: false });
  }

  /** The connection's session facts, once read. */
  facts(profileId: string): ConnectionFacts | undefined {
    return this.#profiles.get(profileId)?.facts;
  }

  /** Databases whose snapshots are held. */
  loaded(profileId: string): readonly string[] {
    return [...(this.#profiles.get(profileId)?.entries.keys() ?? [])];
  }

  /**
   * A snapshot read from the server since the last known change, for the designer and table
   * views: the held one when fresh, else the read already running, else a new read (kept,
   * published and stored). PostgreSQL `schemas` narrow a read when nothing better is at hand;
   * such a partial snapshot is returned but not kept. The connection's default database when
   * `database` is left out. Rejects with the introspection's error.
   */
  async snapshot(
    profileId: string,
    dialect: SqlDialect,
    scope: { readonly database?: string; readonly schemas?: readonly string[] } = {},
  ): Promise<SchemaSnapshot> {
    const state = this.#open(profileId, dialect);
    await state.factsRead;
    const database = scope.database ?? state.facts?.database;
    if (database === undefined) {
      throw state.failed
        ? new JoineryError({ code: 'CONNECTION_FAILED', message: state.error ?? 'Not connected' })
        : new JoineryError({ code: 'NOT_FOUND', message: 'No database is selected' });
    }
    const held = state.entries.get(database);
    if (held?.fresh) return held.snapshot;
    if (
      dialect === 'postgres' &&
      scope.schemas !== undefined &&
      !held &&
      !state.jobs.has(database)
    ) {
      return this.source.introspect(profileId, dialect, database, scope.schemas);
    }
    if (dialect !== 'postgres') state.wanted.add(database);
    const job = this.#introspect(profileId, state, database);
    await job.promise;
    const read = state.entries.get(database);
    if (read?.fresh) return read.snapshot;
    throw (
      job.error ?? new JoineryError({ code: 'CANCELLED', message: 'The connection was closed' })
    );
  }

  /**
   * MySQL/MariaDB: makes sure a database the user expanded or used is loaded, from the store or
   * the server. Resolves once completion can use it (at once when stored); never rejects.
   */
  use(profileId: string, database: string): Promise<void> {
    const state = this.#profiles.get(profileId);
    if (!state || state.dialect === 'postgres') return Promise.resolve();
    const known = state.facts?.databases;
    if (known && !known.includes(database)) return Promise.resolve();
    const held = state.entries.get(database);
    if (held?.fresh) return Promise.resolve();
    state.wanted.add(database);
    if (!state.facts) return Promise.resolve();
    const job = this.#introspect(profileId, state, database);
    return held ? Promise.resolve() : job.promise;
  }

  /**
   * Reads snapshots again (the explorer's Refresh): the given databases, or everything held
   * plus MySQL's database list. Reports only what actually changed.
   */
  async refresh(profileId: string, databases?: readonly string[]): Promise<void> {
    const state = this.#profiles.get(profileId);
    if (!state?.facts) return;
    const known = state.facts.databases;
    const targets = (databases ?? this.#held(state)).filter((database) =>
      state.dialect === 'postgres'
        ? database === state.facts?.database || state.entries.has(database)
        : !known || known.includes(database),
    );
    await Promise.all([
      databases === undefined && state.dialect !== 'postgres'
        ? this.#refreshDatabaseList(profileId, state, [])
        : undefined,
      ...targets.map(
        (database) => this.#introspect(profileId, state, database, 'if-different').promise,
      ),
    ]);
  }

  /**
   * The structure changed through Joinery (a designer save or a drop): every held snapshot is
   * stale at once, so the next `snapshot` waits for the new read, and all are read again. False
   * when nothing is held, so nothing will report the change.
   */
  invalidate(profileId: string): boolean {
    const state = this.#profiles.get(profileId);
    if (!state) return false;
    const databases = new Set([...state.entries.keys(), ...state.jobs.keys()]);
    for (const database of databases) {
      const entry = state.entries.get(database);
      if (entry) state.entries.set(database, { snapshot: entry.snapshot, fresh: false });
      void this.#introspect(profileId, state, database, 'always');
    }
    return databases.size > 0;
  }

  /**
   * What a run in a query tab changed (spec §5: refresh after DDL run from Joinery). DDL inside
   * an open PostgreSQL transaction is refreshed when the tab commits, since the metadata session
   * cannot see it before. Returns the effects so the caller can track the tab's USE/search_path.
   */
  afterRun(
    profileId: string,
    run: {
      readonly tabId: string;
      readonly statements: readonly RanStatement[];
      /** The tab's current database when the run started. */
      readonly database: string | undefined;
      /** The tab is inside a transaction after the run. */
      readonly inTransaction: boolean;
    },
  ): RunEffects | undefined {
    const state = this.#profiles.get(profileId);
    if (!state) return undefined;
    const effects = effectsOfRun({
      dialect: state.dialect,
      statements: run.statements,
      database: run.database ?? state.facts?.database,
      loaded: [...state.entries.keys()],
    });
    const pending = state.deferred.get(run.tabId);
    if (effects.stale.length > 0 && state.dialect === 'postgres' && run.inTransaction) {
      const deferred = pending ?? new Set<string>();
      for (const database of effects.stale) deferred.add(database);
      state.deferred.set(run.tabId, deferred);
    } else {
      // A typed COMMIT (or ROLLBACK: a needless refresh is harmless) ended a deferring transaction.
      const stale = new Set([...effects.stale, ...(run.inTransaction ? [] : (pending ?? []))]);
      if (!run.inTransaction) state.deferred.delete(run.tabId);
      this.#afterDdl(profileId, state, [...stale], effects);
    }
    if (effects.session?.database !== undefined) {
      void this.use(profileId, effects.session.database);
    }
    return effects;
  }

  /** A tab's transaction ended: DDL it deferred is refreshed on commit, dropped on rollback. */
  afterTransaction(profileId: string, tabId: string, committed: boolean): void {
    const state = this.#profiles.get(profileId);
    const pending = state?.deferred.get(tabId);
    if (!state || !pending) return;
    state.deferred.delete(tabId);
    if (committed) this.#afterDdl(profileId, state, [...pending]);
  }

  #afterDdl(
    profileId: string,
    state: ProfileState,
    stale: readonly string[],
    effects?: RunEffects,
  ): void {
    for (const database of stale) {
      const entry = state.entries.get(database);
      if (entry) state.entries.set(database, { snapshot: entry.snapshot, fresh: false });
      void this.#introspect(profileId, state, database, 'always');
    }
    if (!effects?.databaseList) return;
    if (state.dialect === 'postgres') {
      for (const database of effects.dropped) this.#remove(profileId, state, database);
      this.sink.changed(profileId, { databases: [], list: true });
    } else {
      void this.#refreshDatabaseList(profileId, state, effects.dropped);
    }
  }

  /** Databases a full refresh reads again: the current one and everything held. */
  #held(state: ProfileState): string[] {
    const names = new Set(state.entries.keys());
    if (state.facts?.database !== undefined) names.add(state.facts.database);
    return [...names];
  }

  /** Autocomplete uses this database's snapshot. */
  #completes(state: ProfileState, database: string): boolean {
    return (
      state.dialect !== 'postgres' || state.facts === undefined || database === state.facts.database
    );
  }

  async #start(profileId: string, state: ProfileState): Promise<void> {
    this.#busy(profileId, state, 1);
    try {
      const cached = this.source.loadCached(profileId).then(
        (snapshots) => {
          if (state.closed) return;
          const stored = snapshots.filter((snapshot) => !state.entries.has(snapshot.database));
          if (stored.length === 0) return;
          for (const snapshot of stored) {
            state.entries.set(snapshot.database, { snapshot, fresh: false });
          }
          this.sink.publish(profileId, { put: stored });
        },
        () => undefined,
      );
      const facts = await this.source.facts(profileId, state.dialect);
      await cached;
      if (state.closed) return;
      state.facts = facts;
      const known = facts.databases;
      // PostgreSQL completes in the connected database only; MySQL databases may be gone.
      const unused = [...state.entries.keys()].filter((database) =>
        state.dialect === 'postgres'
          ? database !== facts.database && !state.entries.get(database)?.fresh
          : known !== undefined && !known.includes(database),
      );
      for (const database of unused) state.entries.delete(database);
      if (unused.length > 0 || known) {
        this.sink.publish(profileId, {
          ...(unused.length > 0 ? { remove: unused } : {}),
          ...(known ? { databases: known } : {}),
        });
      }
      if (state.dialect !== 'postgres') {
        for (const database of unused) void this.source.drop(profileId, database).catch(() => {});
      }
      const targets = new Set<string>();
      if (facts.database !== undefined) targets.add(facts.database);
      if (state.dialect !== 'postgres') {
        for (const database of state.wanted) {
          if (!known || known.includes(database)) targets.add(database);
        }
      }
      await Promise.all(
        [...targets].map((database) => this.#introspect(profileId, state, database).promise),
      );
    } catch (error) {
      state.failed = true;
      state.error = errorMessage(error);
    } finally {
      this.#busy(profileId, state, -1);
    }
  }

  /** Re-reads MySQL's database list; databases no longer there leave the cache. */
  async #refreshDatabaseList(
    profileId: string,
    state: ProfileState,
    dropped: readonly string[],
  ): Promise<void> {
    this.#busy(profileId, state, 1);
    try {
      for (const database of dropped) this.#remove(profileId, state, database);
      const facts = await this.source.facts(profileId, state.dialect);
      if (state.closed) return;
      state.facts = facts;
      const known = facts.databases ?? [];
      const gone = [...state.entries.keys()].filter((database) => !known.includes(database));
      for (const database of gone) this.#remove(profileId, state, database);
      this.sink.publish(profileId, { databases: known });
      this.sink.changed(profileId, { databases: [], list: true });
    } catch (error) {
      state.error = errorMessage(error);
    } finally {
      this.#busy(profileId, state, -1);
    }
  }

  #remove(profileId: string, state: ProfileState, database: string): void {
    state.wanted.delete(database);
    if (!state.entries.delete(database)) return;
    this.sink.publish(profileId, { remove: [database] });
    void this.source.drop(profileId, database).catch(() => {});
  }

  /**
   * Introspects one database, keeps, publishes and stores the result. A request while the same
   * database is being read runs it once more afterwards, since the running read may predate the
   * change; `always` reports the database as changed when done, `if-different` only when its
   * structure differs from the fresh snapshot held before (one a view may have loaded).
   */
  #introspect(profileId: string, state: ProfileState, database: string, notify?: Notify): Job {
    const running = state.jobs.get(database);
    if (running) {
      running.again = true;
      if (notify === 'always' || running.notify === undefined) running.notify = notify;
      return running;
    }
    const job: Job = { again: false, notify, error: undefined, promise: Promise.resolve() };
    job.promise = this.#runJob(profileId, state, database, job);
    state.jobs.set(database, job);
    return job;
  }

  async #runJob(profileId: string, state: ProfileState, database: string, job: Job): Promise<void> {
    this.#busy(profileId, state, 1);
    const held = state.entries.get(database);
    const before = held?.fresh ? held.snapshot : undefined;
    let snapshot: SchemaSnapshot | undefined;
    try {
      do {
        job.again = false;
        snapshot = await this.source.introspect(profileId, state.dialect, database);
        if (state.closed) return;
        state.entries.set(database, { snapshot, fresh: true });
        state.error = undefined;
        if (this.#completes(state, database)) {
          this.sink.publish(profileId, { put: [snapshot] });
          await this.source.store(profileId, snapshot).catch(() => {});
        }
      } while (job.again && !state.closed);
      const changed =
        job.notify === 'always' ||
        (job.notify === 'if-different' &&
          before !== undefined &&
          structureOf(before) !== structureOf(snapshot));
      if (changed) this.sink.changed(profileId, { databases: [database], list: false });
    } catch (error) {
      job.error = error;
      state.error = errorMessage(error);
    } finally {
      state.jobs.delete(database);
      this.#busy(profileId, state, -1);
    }
  }

  #busy(profileId: string, state: ProfileState, delta: 1 | -1): void {
    state.busy += delta;
    if (state.closed) return;
    const loading = state.busy > 0;
    this.sink.status(profileId, {
      loading,
      ...(!loading && state.error !== undefined ? { error: state.error } : {}),
    });
  }
}
