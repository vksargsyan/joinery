import { QuerybaraError, cancelledError, newId } from '@querybara/core';
import { SessionGate } from '@querybara/driver-sql-base';
import {
  fromEjson,
  isBsonDocument,
  parseShell,
  parseShellDocument,
  parseShellPipeline,
  toEjson,
  type BsonDocument,
  type BsonValue,
  type Namespace,
} from '@querybara/mongo-tools';
import type {
  BSONSerializeOptions,
  ClientSession,
  Collection,
  Db,
  Document,
  MongoClient,
} from 'mongodb';

import type { MongoClientPlan } from './config';
import { mapMongoError } from './errors';
import type { MongoOpOptions } from './types';

/**
 * Deserialisation for user data: numbers keep their BSON type (Int32, Double, Long), binary
 * stays Binary and regular expressions stay BSONRegExp, so canonical Extended JSON is lossless.
 */
export const RAW_BSON: BSONSerializeOptions = {
  promoteValues: false,
  promoteLongs: false,
  promoteBuffers: false,
  bsonRegExp: true,
};

/** Something an execution can close when cancelled: a cursor or a change stream. */
interface Closeable {
  close(): Promise<void>;
}

/**
 * One cancellable operation. It runs in its own ClientSession (or the open transaction's), so
 * cancelling is `killSessions` for that session from another pooled connection: the server
 * interrupts whatever the session is running and kills its cursors.
 */
export class Execution {
  cancelled = false;
  private closeables = new Set<Closeable>();

  constructor(
    private readonly ctx: MongoContext,
    readonly id: string,
    readonly session: ClientSession,
    readonly ownsSession: boolean,
  ) {}

  track<T extends Closeable>(closeable: T): T {
    this.closeables.add(closeable);
    return closeable;
  }

  async cancel(): Promise<void> {
    if (this.cancelled) return;
    this.cancelled = true;
    let lsid: ClientSession['id'];
    try {
      lsid = this.session.id;
    } catch {
      lsid = undefined;
    }
    await Promise.all([
      lsid
        ? this.ctx.client
            .db('admin')
            .command({ killSessions: [{ id: lsid.id }] })
            .catch(() => undefined)
        : undefined,
      ...[...this.closeables].map((c) => c.close().catch(() => undefined)),
    ]);
    if (!this.ownsSession) this.ctx.transactionInterrupted = true;
  }

  async finish(): Promise<void> {
    this.ctx.executions.delete(this.id);
    for (const closeable of this.closeables) await closeable.close().catch(() => undefined);
    this.closeables.clear();
    if (this.ownsSession) await this.session.endSession().catch(() => undefined);
  }
}

/** The shared state behind a MongoDB session and its services. */
export class MongoContext {
  readonly executions = new Map<string, Execution>();
  readonly gate = new SessionGate();
  /** The open transaction's session. */
  transaction: ClientSession | undefined;
  /** An operation inside the transaction was cancelled, which aborted it on the server. */
  transactionInterrupted = false;
  closed = false;

  constructor(
    readonly client: MongoClient,
    readonly plan: MongoClientPlan,
    readonly queryTimeoutMs: number | undefined,
  ) {}

  map(error: unknown, exec?: Execution): QuerybaraError {
    return mapMongoError(error, {
      where: this.plan.where,
      secrets: this.plan.secrets,
      cancelRequested: exec?.cancelled === true,
      ...(this.plan.replicaSet !== undefined ? { replicaSet: this.plan.replicaSet } : {}),
      ...(this.plan.options.serverSelectionTimeoutMS !== undefined
        ? { timeoutMs: this.plan.options.serverSelectionTimeoutMS }
        : {}),
    });
  }

  assertOpen(): void {
    if (this.closed) {
      throw new QuerybaraError({ code: 'CONNECTION_FAILED', message: 'The session is closed' });
    }
  }

  db(name: string): Db {
    return this.client.db(checkDatabaseName(name));
  }

  /** A database handle whose reads keep BSON types (see RAW_BSON). */
  rawDb(name: string): Db {
    return this.client.db(checkDatabaseName(name), RAW_BSON);
  }

  /** A collection whose reads keep BSON types: for returning user documents. */
  collection(ns: Namespace): Collection<Document> {
    return this.rawDb(ns.db).collection(checkCollectionName(ns.collection));
  }

  /**
   * A collection with the driver's default deserialisation, for writes and counts: their
   * results (matchedCount, n...) must be plain numbers.
   */
  plainCollection(ns: Namespace): Collection<Document> {
    return this.db(ns.db).collection(checkCollectionName(ns.collection));
  }

  /** The session an operation runs in: the transaction's, or undefined (driver-managed). */
  sessionOption(): { session?: ClientSession } {
    return this.transaction ? { session: this.transaction } : {};
  }

  maxTime(opts: MongoOpOptions | undefined): { maxTimeMS?: number } {
    const ms = opts?.maxTimeMS ?? this.queryTimeoutMs;
    return ms !== undefined ? { maxTimeMS: ms } : {};
  }

  /** Starts a cancellable execution (see Execution) and wires up its signal. */
  begin(opts: Pick<MongoOpOptions, 'executionId' | 'signal'> = {}): {
    exec: Execution;
    done: () => Promise<void>;
  } {
    this.assertOpen();
    if (opts.signal?.aborted) throw cancelledError();
    const id = opts.executionId ?? newId();
    if (this.executions.has(id)) {
      throw new QuerybaraError({
        code: 'VALIDATION_FAILED',
        message: `An operation with execution id "${id}" is already running`,
      });
    }
    const own = this.transaction === undefined;
    const session = this.transaction ?? this.client.startSession();
    const exec = new Execution(this, id, session, own);
    this.executions.set(id, exec);
    const onAbort = (): void => void exec.cancel();
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    return {
      exec,
      done: async () => {
        opts.signal?.removeEventListener('abort', onAbort);
        await exec.finish();
      },
    };
  }

  /** Runs one cancellable operation to completion, mapping its errors. */
  async run<T>(
    opts: MongoOpOptions | undefined,
    work: (exec: Execution) => Promise<T>,
  ): Promise<T> {
    const { exec, done } = this.begin(opts);
    try {
      // One session runs one operation at a time inside a transaction.
      const result = this.transaction ? await this.gate.run(() => work(exec)) : await work(exec);
      if (exec.cancelled) throw cancelledError('Query cancelled');
      return result;
    } catch (error) {
      throw this.map(error, exec);
    } finally {
      await done();
    }
  }

  /** Runs a cancellable operation that yields results as the consumer pulls them. */
  async *stream<T>(
    opts: MongoOpOptions | undefined,
    work: (exec: Execution) => AsyncGenerator<T>,
  ): AsyncGenerator<T> {
    const { exec, done } = this.begin(opts);
    try {
      for await (const item of work(exec)) {
        if (exec.cancelled) throw cancelledError('Query cancelled');
        yield item;
      }
      if (exec.cancelled) throw cancelledError('Query cancelled');
    } catch (error) {
      throw this.map(error, exec);
    } finally {
      await done();
    }
  }

  /** Runs a short operation, serialised while a transaction is open (one session, one op). */
  async exclusive<T>(work: () => Promise<T>): Promise<T> {
    this.assertOpen();
    try {
      return this.transaction ? await this.gate.run(work) : await work();
    } catch (error) {
      throw this.map(error);
    }
  }
}

/** Database names: non-empty, no "/\. "$*<>:|? or NUL (the server's rules). */
export function checkDatabaseName(name: string): string {
  if (name === '' || /[/\\. "$*<>:|?\0]/.test(name) || name.length > 63) {
    throw new QuerybaraError({
      code: 'VALIDATION_FAILED',
      message: `"${name}" is not a valid database name`,
      hint: 'Database names cannot be empty or contain spaces, dots, slashes, quotes, $, *, <, >, :, | or ?',
    });
  }
  return name;
}

/** Collection names: non-empty, no NUL, not starting with "$" (except the $cmd namespace). */
export function checkCollectionName(name: string): string {
  if (name === '' || name.includes('\0') || name.startsWith('$')) {
    throw new QuerybaraError({
      code: 'VALIDATION_FAILED',
      message: `"${name}" is not a valid collection name`,
    });
  }
  return name;
}

/** A document from Extended JSON (or shell syntax); `what` names it in errors. */
export function documentArg(text: string | undefined, what: string): BsonDocument {
  if (text === undefined || text.trim() === '') return {};
  return parseShellDocument(text, what);
}

/** An array of documents (a pipeline or insertMany input). */
export function documentsArg(text: string, what: string): BsonDocument[] {
  const value = parseShellPipeline(text);
  if (value.length === 0 && what !== 'pipeline') {
    throw new QuerybaraError({ code: 'VALIDATION_FAILED', message: `The ${what} list is empty` });
  }
  return value;
}

/** Any value from Extended JSON text (an _id, a hint, a resume token). */
export function valueArg(text: string, what: string): BsonValue {
  try {
    return parseShell(text);
  } catch {
    return fromEjson(text, what);
  }
}

/** A hint: an index name (a JSON string) or a key pattern. */
export function hintArg(text: string | undefined): string | BsonDocument | undefined {
  if (text === undefined) return undefined;
  const value = valueArg(text, 'hint');
  if (typeof value === 'string' || isBsonDocument(value)) return value;
  throw new QuerybaraError({
    code: 'VALIDATION_FAILED',
    message: 'The hint must be an index name or a key pattern',
  });
}

/**
 * A parsed document as one of the driver's structural types (Sort, CollationOptions, Filter...):
 * its values are already BSON values, only the static types differ.
 */
export function driverDoc<T>(doc: BsonDocument): T {
  return doc as unknown as T;
}

/** Canonical Extended JSON of a driver document. */
export function ejson(value: unknown): string {
  return toEjson(value);
}
