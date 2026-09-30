import type { Readable, Writable } from 'node:stream';

import {
  JoineryError,
  capabilitiesFor,
  type BrowseNode,
  type Capabilities,
  type ExecOptions,
  type ExplainOptions,
  type IntrospectScope,
  type PlanNode,
  type ResolvedProfile,
  type ResultChunk,
  type SchemaSnapshot,
  type Session,
} from '@joinery/core';
import type {
  ChangeEvent,
  CollectionInfo,
  CollModSpec,
  CreateCollectionSpec,
  CreateUserSpec,
  DocumentPage,
  ExplainTarget,
  ExplainVerbosity,
  FindQuery,
  GridFsBucketRef,
  GridFsFileInfo,
  IndexInfo,
  IndexSpec,
  InsertManyResult,
  InsertOneResult,
  MongoServerInfo,
  Namespace,
  RoleInfo,
  RoleRef,
  RoleSpec,
  SchemaAnalysis,
  ServerStatusSummary,
  StagePreview,
  TopEntry,
  TopologyKind,
  UpdateUserSpec,
  UserInfo,
  WatchScope,
  WriteSummary,
} from '@joinery/mongo-tools';
import { MongoClient } from 'mongodb';

import * as admin from './admin';
import { browseMongo } from './browse';
import { buildMongoClientPlan, type MongoClientPlan } from './config';
import { MongoContext, checkDatabaseName } from './context';
import * as documents from './documents';
import { mapMongoError } from './errors';
import { executeCommand, parseCommand } from './execute';
import * as gridfs from './gridfs';
import { introspectMongo } from './introspect';
import type {
  AggregateOptions,
  AnalyzeSchemaOptions,
  CurrentOpOptions,
  CursorOptions,
  ExplainResult,
  GridFsDownloadOptions,
  GridFsListOptions,
  GridFsUploadOptions,
  MongoOpOptions,
  MongoSession,
  PreviewStageOptions,
  UpdateManyOptions,
  WatchOptions,
  WriteOptions,
} from './types';
import { watch } from './watch';

/** Capabilities of a MongoDB server with the given topology (spec §2). */
export function mongoCapabilities(
  serverVersion: string | undefined,
  topology: TopologyKind,
): Capabilities {
  const base = capabilitiesFor('mongodb', serverVersion);
  const clustered =
    topology === 'replicaSet' || topology === 'sharded' || topology === 'loadBalanced';
  return {
    ...base,
    explainFormats: ['json', 'analyze'],
    queryCancel: true,
    serverSideCursors: true,
    transactions: clustered,
    changeStreams: clustered,
    clusterMode: topology === 'sharded',
  };
}

/** Narrows a Session to the MongoDB session with its document services. */
export function isMongoSession(session: Session): session is MongoSession {
  return session.engine === 'mongodb' && session instanceof MongoDbSession;
}

/**
 * One MongoDB connection (a MongoClient with a small pool) behind the Session contract, plus
 * the document services (see MongoSession). Operations run concurrently on the pool; each
 * cancellable one runs in its own ClientSession, so `cancel` kills exactly that operation
 * (killSessions from another pooled connection). A transaction pins every operation to its
 * session and runs them one at a time (open cursors excepted); cancelling an operation inside
 * it aborts the transaction on the server, so the commit then fails with CONFLICT.
 */
export class MongoDbSession implements MongoSession {
  readonly engine = 'mongodb' as const;
  private database: string;

  private constructor(
    private readonly ctx: MongoContext,
    readonly serverVersion: string,
    readonly topology: TopologyKind,
  ) {
    this.database = ctx.plan.defaultDatabase;
  }

  /** Connects, reads the topology and version, and checks the default database name. */
  static async open(resolved: ResolvedProfile): Promise<MongoDbSession> {
    const plan: MongoClientPlan = buildMongoClientPlan(resolved);
    checkDatabaseName(plan.defaultDatabase);
    const errorContext = {
      where: plan.where,
      secrets: plan.secrets,
      ...(plan.replicaSet !== undefined ? { replicaSet: plan.replicaSet } : {}),
      ...(plan.options.serverSelectionTimeoutMS !== undefined
        ? { timeoutMs: plan.options.serverSelectionTimeoutMS }
        : {}),
    };
    let client: MongoClient;
    try {
      client = new MongoClient(plan.url, plan.options);
    } catch (error) {
      throw mapMongoError(error, errorContext);
    }
    try {
      await client.connect();
      const adminDb = client.db('admin');
      const [hello, build] = await Promise.all([
        adminDb.command({ hello: 1 }),
        adminDb.command({ buildInfo: 1 }),
      ]);
      const ctx = new MongoContext(client, plan, resolved.profile.options.queryTimeoutMs);
      return new MongoDbSession(ctx, String(build['version'] ?? ''), admin.topologyOf(hello));
    } catch (error) {
      await client.close().catch(() => undefined);
      throw mapMongoError(error, errorContext);
    }
  }

  get currentDatabase(): string {
    return this.database;
  }

  get inTransaction(): boolean {
    return this.ctx.transaction !== undefined;
  }

  capabilities(): Capabilities {
    return mongoCapabilities(this.serverVersion, this.topology);
  }

  execute(text: string, opts: ExecOptions): AsyncIterable<ResultChunk> {
    return executeCommand(this.ctx, this.database, text, opts);
  }

  async cancel(executionId: string): Promise<void> {
    await this.ctx.executions.get(executionId)?.cancel();
  }

  introspect(scope: IntrospectScope = {}): Promise<SchemaSnapshot> {
    const database = scope.database ?? this.database;
    return this.ctx.exclusive(() => introspectMongo(this.ctx, database, scope, this.serverVersion));
  }

  browse(path: readonly string[]): Promise<BrowseNode[]> {
    return this.ctx.exclusive(() => browseMongo(this.ctx, path));
  }

  /**
   * Explains a command document (find, aggregate, count, distinct, update, delete...) against
   * the current database: queryPlanner, or executionStats with `analyze` (which runs the
   * query; writes are explained without being applied).
   */
  async explain(text: string, opts: ExplainOptions = {}): Promise<PlanNode> {
    const { command } = parseCommand(text);
    const result = await this.ctx.run({}, (exec) =>
      documents.explainCommand(
        this.ctx,
        this.database,
        command,
        opts.analyze ? 'executionStats' : 'queryPlanner',
        {
          session: exec.session,
        },
      ),
    );
    return result.plan;
  }

  async begin(): Promise<void> {
    if (!this.capabilities().transactions) {
      throw new JoineryError({
        code: 'NOT_SUPPORTED',
        message: 'Transactions are not available on a standalone server',
        hint: 'Transactions need a replica set or a sharded cluster (a one-member replica set works)',
      });
    }
    await this.ctx.gate.run(async () => {
      if (this.ctx.transaction) {
        throw new JoineryError({
          code: 'VALIDATION_FAILED',
          message: 'A transaction is already open',
        });
      }
      const session = this.ctx.client.startSession();
      session.startTransaction();
      this.ctx.transaction = session;
      this.ctx.transactionInterrupted = false;
    });
  }

  async commit(): Promise<void> {
    await this.finishTransaction('commit');
  }

  async rollback(): Promise<void> {
    await this.finishTransaction('rollback');
  }

  private async finishTransaction(how: 'commit' | 'rollback'): Promise<void> {
    await this.ctx.gate.run(async () => {
      const session = this.ctx.transaction;
      if (!session) {
        if (how === 'rollback') return;
        throw new JoineryError({ code: 'VALIDATION_FAILED', message: 'No transaction is open' });
      }
      this.ctx.transaction = undefined;
      const interrupted = this.ctx.transactionInterrupted;
      this.ctx.transactionInterrupted = false;
      try {
        if (how === 'commit') {
          if (interrupted) {
            throw new JoineryError({
              code: 'CONFLICT',
              message: 'The transaction was aborted when an operation in it was cancelled',
              hint: 'Start a new transaction and run the changes again',
            });
          }
          await session.commitTransaction();
        } else {
          await session.abortTransaction().catch((error: unknown) => {
            if (!interrupted) throw error;
          });
        }
      } catch (error) {
        if (how === 'commit') await session.abortTransaction().catch(() => undefined);
        throw this.ctx.map(error);
      } finally {
        await session.endSession().catch(() => undefined);
      }
    });
  }

  async useDatabase(name: string): Promise<void> {
    this.ctx.assertOpen();
    this.database = checkDatabaseName(name);
  }

  async ping(): Promise<void> {
    await this.ctx.exclusive(() => this.ctx.db('admin').command({ ping: 1 }));
  }

  async close(): Promise<void> {
    if (this.ctx.closed) return;
    const transaction = this.ctx.transaction;
    this.ctx.transaction = undefined;
    await Promise.all([...this.ctx.executions.values()].map((exec) => exec.cancel()));
    if (transaction) {
      await transaction.abortTransaction().catch(() => undefined);
      await transaction.endSession().catch(() => undefined);
    }
    this.ctx.closed = true;
    await this.ctx.client.close().catch(() => undefined);
  }

  serverInfo(): Promise<MongoServerInfo> {
    return admin.serverInfo(this.ctx);
  }

  // Documents

  find(ns: Namespace, query: FindQuery, opts?: CursorOptions): AsyncIterable<DocumentPage> {
    return documents.find(this.ctx, ns, query, opts);
  }

  count(ns: Namespace, filter?: string, opts?: MongoOpOptions): Promise<number> {
    return documents.count(this.ctx, ns, filter, opts);
  }

  estimatedCount(ns: Namespace, opts?: MongoOpOptions): Promise<number> {
    return documents.estimatedCount(this.ctx, ns, opts);
  }

  aggregate(ns: Namespace, pipeline: string, opts?: AggregateOptions): AsyncIterable<DocumentPage> {
    return documents.aggregate(this.ctx, ns, pipeline, opts);
  }

  previewStage(
    ns: Namespace,
    pipeline: string,
    stageIndex: number,
    opts?: PreviewStageOptions,
  ): Promise<StagePreview> {
    return documents.previewStage(this.ctx, ns, pipeline, stageIndex, opts);
  }

  insertOne(ns: Namespace, document: string, opts?: MongoOpOptions): Promise<InsertOneResult> {
    return documents.insertOne(this.ctx, ns, document, opts);
  }

  insertMany(
    ns: Namespace,
    docs: string,
    opts?: MongoOpOptions & { readonly ordered?: boolean },
  ): Promise<InsertManyResult> {
    return documents.insertMany(this.ctx, ns, docs, opts);
  }

  replaceOne(
    ns: Namespace,
    original: string,
    replacement: string,
    opts?: MongoOpOptions,
  ): Promise<WriteSummary> {
    return documents.replaceOne(this.ctx, ns, original, replacement, opts);
  }

  updateMany(
    ns: Namespace,
    filter: string,
    update: string,
    opts?: UpdateManyOptions,
  ): Promise<WriteSummary> {
    return documents.updateMany(this.ctx, ns, filter, update, opts);
  }

  deleteOne(ns: Namespace, id: string, opts?: WriteOptions): Promise<WriteSummary> {
    return documents.deleteOne(this.ctx, ns, id, opts);
  }

  deleteMany(ns: Namespace, filter: string, opts?: WriteOptions): Promise<WriteSummary> {
    return documents.deleteMany(this.ctx, ns, filter, opts);
  }

  explainQuery(
    ns: Namespace,
    target: ExplainTarget,
    verbosity?: ExplainVerbosity,
    opts?: MongoOpOptions,
  ): Promise<ExplainResult> {
    return documents.explainQuery(this.ctx, ns, target, verbosity, opts);
  }

  analyzeSchema(ns: Namespace, opts?: AnalyzeSchemaOptions): Promise<SchemaAnalysis> {
    return documents.analyzeSchema(this.ctx, ns, opts);
  }

  // Indexes and collections

  listIndexes(ns: Namespace): Promise<IndexInfo[]> {
    return admin.listIndexes(this.ctx, ns);
  }

  createIndex(ns: Namespace, spec: IndexSpec): Promise<string> {
    return admin.createIndex(this.ctx, ns, spec);
  }

  dropIndex(ns: Namespace, name: string): Promise<void> {
    return admin.dropIndex(this.ctx, ns, name);
  }

  setIndexHidden(ns: Namespace, name: string, hidden: boolean): Promise<void> {
    return admin.setIndexHidden(this.ctx, ns, name, hidden);
  }

  collectionInfo(ns: Namespace): Promise<CollectionInfo> {
    return admin.collectionInfo(this.ctx, ns);
  }

  createCollection(ns: Namespace, spec?: CreateCollectionSpec): Promise<void> {
    return admin.createCollection(this.ctx, ns, spec);
  }

  createView(
    ns: Namespace,
    viewOn: string,
    pipeline: string,
    opts?: { readonly collation?: string },
  ): Promise<void> {
    return admin.createView(this.ctx, ns, viewOn, pipeline, opts);
  }

  collMod(ns: Namespace, changes: CollModSpec): Promise<void> {
    return admin.collMod(this.ctx, ns, changes);
  }

  renameCollection(
    ns: Namespace,
    to: string,
    opts?: { readonly dropTarget?: boolean },
  ): Promise<void> {
    return admin.renameCollection(this.ctx, ns, to, opts);
  }

  dropCollection(ns: Namespace): Promise<void> {
    return admin.dropCollection(this.ctx, ns);
  }

  dropDatabase(db: string): Promise<void> {
    return admin.dropDatabase(this.ctx, db);
  }

  // Change streams

  watch(scope: WatchScope, pipeline?: string, opts?: WatchOptions): AsyncIterable<ChangeEvent> {
    return watch(this.ctx, this.topology, scope, pipeline, opts);
  }

  // GridFS

  listBuckets(db: string): Promise<string[]> {
    return gridfs.listBuckets(this.ctx, db);
  }

  listFiles(
    bucket: GridFsBucketRef,
    opts?: GridFsListOptions,
  ): AsyncIterable<{ readonly files: readonly GridFsFileInfo[] }> {
    return gridfs.listFiles(this.ctx, bucket, opts);
  }

  uploadFile(
    bucket: GridFsBucketRef,
    source: Uint8Array | Readable | AsyncIterable<Uint8Array>,
    opts: GridFsUploadOptions,
  ): Promise<string> {
    return gridfs.uploadFile(this.ctx, bucket, source, opts);
  }

  downloadFile(
    bucket: GridFsBucketRef,
    id: string,
    opts?: GridFsDownloadOptions,
  ): AsyncIterable<Uint8Array> {
    return gridfs.downloadFile(this.ctx, bucket, id, opts);
  }

  downloadFileTo(
    bucket: GridFsBucketRef,
    id: string,
    destination: Writable,
    opts?: GridFsDownloadOptions,
  ): Promise<number> {
    return gridfs.downloadFileTo(this.ctx, bucket, id, destination, opts);
  }

  deleteFile(bucket: GridFsBucketRef, id: string): Promise<void> {
    return gridfs.deleteFile(this.ctx, bucket, id);
  }

  renameFile(bucket: GridFsBucketRef, id: string, filename: string): Promise<void> {
    return gridfs.renameFile(this.ctx, bucket, id, filename);
  }

  // Users and roles

  usersInfo(
    db: string,
    opts?: { readonly user?: string; readonly showPrivileges?: boolean },
  ): Promise<UserInfo[]> {
    return admin.usersInfo(this.ctx, db, opts);
  }

  rolesInfo(
    db: string,
    opts?: {
      readonly role?: string;
      readonly showPrivileges?: boolean;
      readonly showBuiltinRoles?: boolean;
    },
  ): Promise<RoleInfo[]> {
    return admin.rolesInfo(this.ctx, db, opts);
  }

  createUser(db: string, spec: CreateUserSpec): Promise<void> {
    return admin.createUser(this.ctx, db, spec);
  }

  updateUser(db: string, user: string, spec: UpdateUserSpec): Promise<void> {
    return admin.updateUser(this.ctx, db, user, spec);
  }

  dropUser(db: string, user: string): Promise<void> {
    return admin.dropUser(this.ctx, db, user);
  }

  createRole(db: string, spec: RoleSpec): Promise<void> {
    return admin.createRole(this.ctx, db, spec);
  }

  updateRole(
    db: string,
    role: string,
    spec: Partial<Pick<RoleSpec, 'privileges' | 'roles'>>,
  ): Promise<void> {
    return admin.updateRole(this.ctx, db, role, spec);
  }

  dropRole(db: string, role: string): Promise<void> {
    return admin.dropRole(this.ctx, db, role);
  }

  grantRoles(db: string, user: string, roles: readonly RoleRef[]): Promise<void> {
    return admin.grantRoles(this.ctx, db, user, roles);
  }

  revokeRoles(db: string, user: string, roles: readonly RoleRef[]): Promise<void> {
    return admin.revokeRoles(this.ctx, db, user, roles);
  }

  // Admin reads

  currentOp(opts?: CurrentOpOptions): Promise<string[]> {
    return admin.currentOp(this.ctx, opts);
  }

  killOp(opid: number | string): Promise<void> {
    return admin.killOp(this.ctx, opid);
  }

  serverStatus(): Promise<ServerStatusSummary> {
    return admin.serverStatus(this.ctx);
  }

  top(): Promise<TopEntry[]> {
    return admin.top(this.ctx);
  }
}
