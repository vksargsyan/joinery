import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { DatabaseSync, StatementSync } from 'node:sqlite';

/**
 * The SQLite access layer (ADR 0002). Repositories talk to this small synchronous interface
 * only; this file is the one place that touches `node:sqlite`, so moving to better-sqlite3 later
 * means one new implementation of `SqliteDatabase`.
 *
 * `node:sqlite` is loaded when the first database opens, not imported: Node warns that SQLite
 * is experimental as the module loads, and a program that hides the warning (the CLI) can only
 * do so once its own code runs. A static import loads it while the program's imports are still
 * being linked, and the other modules loading from disk let the warning out before then.
 */

/** A value SQLite binds or returns. BLOBs come back as Uint8Array. */
export type SqlValue = null | number | bigint | string | Uint8Array;

/** Positional (`?`) or named (`:name`, `$name`, `@name`) parameters; keys may omit the prefix. */
export type SqlParams = readonly SqlValue[] | Readonly<Record<string, SqlValue>>;

export type SqlRow = Readonly<Record<string, SqlValue>>;

export interface RunResult {
  /** Rows inserted, updated or deleted by the statement. */
  readonly changes: number;
  readonly lastInsertRowid: number;
}

export interface SqliteStatement {
  run(params?: SqlParams): RunResult;
  get(params?: SqlParams): SqlRow | undefined;
  all(params?: SqlParams): SqlRow[];
  /** Streams rows; finish or `return()` the iterator before reusing the statement. */
  iterate(params?: SqlParams): IterableIterator<SqlRow>;
}

export interface SqliteDatabase {
  /** The file path, or ':memory:'. */
  readonly location: string;
  readonly isOpen: boolean;
  /** True inside `transaction()`. */
  readonly inTransaction: boolean;
  /** Prepares (and caches) a statement. */
  prepare(sql: string): SqliteStatement;
  run(sql: string, params?: SqlParams): RunResult;
  get(sql: string, params?: SqlParams): SqlRow | undefined;
  all(sql: string, params?: SqlParams): SqlRow[];
  /** Streams rows through a fresh statement, so it never disturbs cached ones. */
  iterate(sql: string, params?: SqlParams): IterableIterator<SqlRow>;
  /** Runs one or more statements without parameters (DDL, pragmas). */
  exec(sql: string): void;
  /**
   * Runs `fn` in a transaction: commits when it returns, rolls back and rethrows when it throws.
   * Nested calls become savepoints, so an inner failure the caller catches undoes only the inner
   * work. `fn` must be synchronous; returning a promise is an error and rolls back.
   * The outermost level uses BEGIN IMMEDIATE so two processes (desktop and CLI) never deadlock
   * upgrading a read lock.
   */
  transaction<T>(fn: () => T): T;
  /** Closes the database; later calls are no-ops. */
  close(): void;
}

export interface OpenDatabaseOptions {
  readonly readOnly?: boolean;
  /** How long to wait for another process's lock before failing with SQLITE_BUSY. */
  readonly busyTimeoutMs?: number;
}

const DEFAULT_BUSY_TIMEOUT_MS = 5_000;
const STATEMENT_CACHE_SIZE = 128;

/**
 * Opens (creating when needed) a SQLite database at `location`, or an in-memory one for
 * ':memory:'. File databases use WAL so readers never block the writer, foreign keys are
 * enforced, and a newly created file is readable by its owner only (it holds sealed secrets
 * and connection details).
 */
export function openDatabase(location: string, options: OpenDatabaseOptions = {}): SqliteDatabase {
  const memory = location === ':memory:';
  const readOnly = options.readOnly ?? false;
  const busyTimeoutMs = options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS;
  if (!Number.isInteger(busyTimeoutMs) || busyTimeoutMs < 0) {
    throw new RangeError('busyTimeoutMs must be a non-negative integer');
  }
  let created = false;
  if (!memory && !readOnly) {
    mkdirSync(dirname(location), { recursive: true });
    created = !existsSync(location);
  }
  const { DatabaseSync: Database } = process.getBuiltinModule('node:sqlite');
  const db = new Database(location, { readOnly, enableForeignKeyConstraints: true });
  try {
    db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
    db.exec('PRAGMA foreign_keys = ON');
    if (!memory && !readOnly) {
      db.exec('PRAGMA journal_mode = WAL');
      // NORMAL is durable across application crashes in WAL mode; only an OS crash can lose
      // the last transactions, which is fine for a local app store.
      db.exec('PRAGMA synchronous = NORMAL');
      // SQLite gives the -wal and -shm files the main file's permissions.
      if (created && process.platform !== 'win32') chmodSync(location, 0o600);
    }
  } catch (error) {
    db.close();
    throw error;
  }
  return new NodeSqliteDatabase(db, location);
}

function isPositional(params: SqlParams): params is readonly SqlValue[] {
  return Array.isArray(params);
}

function toRunResult(result: {
  changes: number | bigint;
  lastInsertRowid: number | bigint;
}): RunResult {
  return { changes: Number(result.changes), lastInsertRowid: Number(result.lastInsertRowid) };
}

class NodeSqliteStatement implements SqliteStatement {
  readonly #statement: StatementSync;

  constructor(statement: StatementSync) {
    this.#statement = statement;
  }

  run(params?: SqlParams): RunResult {
    const statement = this.#statement;
    if (params === undefined) return toRunResult(statement.run());
    return toRunResult(isPositional(params) ? statement.run(...params) : statement.run(params));
  }

  get(params?: SqlParams): SqlRow | undefined {
    const statement = this.#statement;
    if (params === undefined) return statement.get();
    return isPositional(params) ? statement.get(...params) : statement.get(params);
  }

  all(params?: SqlParams): SqlRow[] {
    const statement = this.#statement;
    if (params === undefined) return statement.all();
    return isPositional(params) ? statement.all(...params) : statement.all(params);
  }

  iterate(params?: SqlParams): IterableIterator<SqlRow> {
    const statement = this.#statement;
    if (params === undefined) return statement.iterate();
    return isPositional(params) ? statement.iterate(...params) : statement.iterate(params);
  }
}

class NodeSqliteDatabase implements SqliteDatabase {
  readonly location: string;
  readonly #db: DatabaseSync;
  readonly #statements = new Map<string, NodeSqliteStatement>();
  #depth = 0;
  #closed = false;

  constructor(db: DatabaseSync, location: string) {
    this.#db = db;
    this.location = location;
  }

  get isOpen(): boolean {
    return !this.#closed;
  }

  get inTransaction(): boolean {
    return this.#depth > 0;
  }

  prepare(sql: string): SqliteStatement {
    const cached = this.#statements.get(sql);
    if (cached) {
      // Refresh recency so the cache evicts the least recently used statement.
      this.#statements.delete(sql);
      this.#statements.set(sql, cached);
      return cached;
    }
    const statement = new NodeSqliteStatement(this.#db.prepare(sql));
    this.#statements.set(sql, statement);
    if (this.#statements.size > STATEMENT_CACHE_SIZE) {
      const oldest = this.#statements.keys().next();
      if (!oldest.done) this.#statements.delete(oldest.value);
    }
    return statement;
  }

  run(sql: string, params?: SqlParams): RunResult {
    return this.prepare(sql).run(params);
  }

  get(sql: string, params?: SqlParams): SqlRow | undefined {
    return this.prepare(sql).get(params);
  }

  all(sql: string, params?: SqlParams): SqlRow[] {
    return this.prepare(sql).all(params);
  }

  iterate(sql: string, params?: SqlParams): IterableIterator<SqlRow> {
    return new NodeSqliteStatement(this.#db.prepare(sql)).iterate(params);
  }

  exec(sql: string): void {
    this.#db.exec(sql);
  }

  transaction<T>(fn: () => T): T {
    const depth = this.#depth;
    const savepoint = `joinery_savepoint_${depth}`;
    this.#db.exec(depth === 0 ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${savepoint}`);
    this.#depth = depth + 1;
    try {
      const result = fn();
      if (isThenable(result)) {
        throw new TypeError('transaction() needs a synchronous callback; it returned a promise');
      }
      this.#db.exec(depth === 0 ? 'COMMIT' : `RELEASE ${savepoint}`);
      return result;
    } catch (error) {
      try {
        this.#db.exec(depth === 0 ? 'ROLLBACK' : `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`);
      } catch {
        // SQLite already rolled back on its own (e.g. SQLITE_FULL); keep the original error.
      }
      throw error;
    } finally {
      this.#depth = depth;
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#statements.clear();
    this.#db.close();
  }
}

function isThenable(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    'then' in value &&
    typeof value.then === 'function'
  );
}
