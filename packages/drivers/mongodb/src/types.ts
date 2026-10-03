import type { Readable, Writable } from 'node:stream';

import type { ExplainOptions, PlanNode, Session } from '@querybara/core';
import type {
  ChangeEvent,
  CollectionInfo,
  CollModSpec,
  CreateCollectionSpec,
  CreateUserSpec,
  DocumentPage,
  ExplainSummary,
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
  SchemaAnalysisOptions,
  ServerStatusSummary,
  StagePreview,
  TopEntry,
  UpdateUserSpec,
  UserInfo,
  WatchScope,
  WriteSummary,
} from '@querybara/mongo-tools';

/** Options every potentially long document operation takes. */
export interface MongoOpOptions {
  readonly signal?: AbortSignal;
  /** Registers the operation so `session.cancel(executionId)` stops it. */
  readonly executionId?: string;
  /** Server-side time limit; defaults to the profile's query timeout. */
  readonly maxTimeMS?: number;
}

export interface CursorOptions extends MongoOpOptions {
  /** Documents per page (and per server batch); default 1,000. */
  readonly pageSize?: number;
}

export interface AggregateOptions extends CursorOptions {
  readonly allowDiskUse?: boolean;
  readonly collation?: string;
  /** Extended JSON of an index key pattern or name. */
  readonly hint?: string;
}

export interface PreviewStageOptions extends MongoOpOptions {
  /** Input documents taken for the preview; default 1,000. */
  readonly sampleSize?: number;
  /** `limit` (default, the first N) or `sample` ($sample, random). */
  readonly sampling?: 'limit' | 'sample';
  /** Indexes of stages switched off in the editor. */
  readonly disabled?: readonly number[];
  /** Most documents returned; default 20. */
  readonly limit?: number;
}

export interface WriteOptions extends MongoOpOptions {
  /** Count the matching documents and change nothing (spec §9: preview of the matched count). */
  readonly dryRun?: boolean;
}

export interface UpdateManyOptions extends WriteOptions {
  readonly upsert?: boolean;
  /** Extended JSON array of array filters. */
  readonly arrayFilters?: string;
  readonly collation?: string;
  readonly hint?: string;
}

export interface WatchOptions {
  readonly fullDocument?: 'default' | 'updateLookup' | 'whenAvailable' | 'required';
  readonly fullDocumentBeforeChange?: 'off' | 'whenAvailable' | 'required';
  /** Extended JSON of a resume token from an earlier event. */
  readonly resumeAfter?: string;
  readonly startAfter?: string;
  /** Extended JSON of a Timestamp. */
  readonly startAtOperationTime?: string;
  readonly batchSize?: number;
  /** How long the server waits for new events per round trip; default 1,000 ms. */
  readonly maxAwaitTimeMS?: number;
  readonly signal?: AbortSignal;
}

export interface GridFsListOptions extends CursorOptions {
  readonly filter?: string;
  readonly sort?: string;
  readonly skip?: number;
  readonly limit?: number;
}

export interface GridFsUploadOptions {
  readonly filename: string;
  /** Stored as `metadata.contentType` (the GridFS spec's recommendation). */
  readonly contentType?: string;
  /** Extended JSON document. */
  readonly metadata?: string;
  readonly chunkSizeBytes?: number;
  /** Extended JSON of the file id; a new ObjectId by default. */
  readonly id?: string;
  readonly signal?: AbortSignal;
}

export interface GridFsDownloadOptions {
  /** Byte range, end exclusive. */
  readonly start?: number;
  readonly end?: number;
  readonly signal?: AbortSignal;
}

export interface AnalyzeSchemaOptions extends MongoOpOptions, SchemaAnalysisOptions {
  /** Documents sampled with $sample; default 1,000. */
  readonly sampleSize?: number;
  /** Extended JSON filter applied before sampling. */
  readonly filter?: string;
}

export interface CurrentOpOptions {
  /** Extended JSON filter on the operation documents, e.g. {"secs_running": {"$gt": 5}}. */
  readonly filter?: string;
  readonly allUsers?: boolean;
  readonly idleConnections?: boolean;
  /** Most operations returned; default 1,000. */
  readonly limit?: number;
}

export interface ExplainResult {
  readonly plan: PlanNode;
  readonly summary: ExplainSummary;
  /** The raw explain output as canonical Extended JSON. */
  readonly raw: string;
}

/** A source of bytes for a GridFS upload. */
export type UploadSource = Uint8Array | Readable | AsyncIterable<Uint8Array>;

/**
 * A MongoDB session: the generic Session contract (execute runs command documents against the
 * current database) plus the document services the MongoDB module needs (spec §9). Every
 * document, filter, pipeline and value goes in and comes out as canonical Extended JSON text.
 * Long operations take a signal and an execution id for `cancel`.
 */
export interface MongoSession extends Session {
  readonly engine: 'mongodb';
  /** The database `execute` runs commands against; see `useDatabase`. */
  readonly currentDatabase: string;
  useDatabase(name: string): Promise<void>;
  /** Explains a command document (queryPlanner, or executionStats with `analyze`). */
  explain(text: string, opts?: ExplainOptions): Promise<PlanNode>;
  /** Transactions need a replica set or a sharded cluster (NOT_SUPPORTED on a standalone). */
  begin(): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  serverInfo(): Promise<MongoServerInfo>;

  find(ns: Namespace, query: FindQuery, opts?: CursorOptions): AsyncIterable<DocumentPage>;
  count(ns: Namespace, filter?: string, opts?: MongoOpOptions): Promise<number>;
  estimatedCount(ns: Namespace, opts?: MongoOpOptions): Promise<number>;
  aggregate(ns: Namespace, pipeline: string, opts?: AggregateOptions): AsyncIterable<DocumentPage>;
  previewStage(
    ns: Namespace,
    pipeline: string,
    stageIndex: number,
    opts?: PreviewStageOptions,
  ): Promise<StagePreview>;

  insertOne(ns: Namespace, document: string, opts?: MongoOpOptions): Promise<InsertOneResult>;
  insertMany(
    ns: Namespace,
    documents: string,
    opts?: MongoOpOptions & { readonly ordered?: boolean },
  ): Promise<InsertManyResult>;
  /**
   * Replaces the document with `original`'s _id, only while the stored document still equals
   * `original`; otherwise throws CONFLICT whose `detail` is the current document (canonical
   * Extended JSON), or NOT_FOUND when it was deleted.
   */
  replaceOne(
    ns: Namespace,
    original: string,
    replacement: string,
    opts?: MongoOpOptions,
  ): Promise<WriteSummary>;
  updateMany(
    ns: Namespace,
    filter: string,
    update: string,
    opts?: UpdateManyOptions,
  ): Promise<WriteSummary>;
  deleteOne(ns: Namespace, id: string, opts?: WriteOptions): Promise<WriteSummary>;
  deleteMany(ns: Namespace, filter: string, opts?: WriteOptions): Promise<WriteSummary>;
  explainQuery(
    ns: Namespace,
    target: ExplainTarget,
    verbosity?: ExplainVerbosity,
    opts?: MongoOpOptions,
  ): Promise<ExplainResult>;

  listIndexes(ns: Namespace): Promise<IndexInfo[]>;
  createIndex(ns: Namespace, spec: IndexSpec): Promise<string>;
  dropIndex(ns: Namespace, name: string): Promise<void>;
  setIndexHidden(ns: Namespace, name: string, hidden: boolean): Promise<void>;

  collectionInfo(ns: Namespace): Promise<CollectionInfo>;
  createCollection(ns: Namespace, spec?: CreateCollectionSpec): Promise<void>;
  createView(
    ns: Namespace,
    viewOn: string,
    pipeline: string,
    opts?: { readonly collation?: string },
  ): Promise<void>;
  collMod(ns: Namespace, changes: CollModSpec): Promise<void>;
  renameCollection(
    ns: Namespace,
    to: string,
    opts?: { readonly dropTarget?: boolean },
  ): Promise<void>;
  dropCollection(ns: Namespace): Promise<void>;
  dropDatabase(db: string): Promise<void>;

  analyzeSchema(ns: Namespace, opts?: AnalyzeSchemaOptions): Promise<SchemaAnalysis>;

  watch(scope: WatchScope, pipeline?: string, opts?: WatchOptions): AsyncIterable<ChangeEvent>;

  listBuckets(db: string): Promise<string[]>;
  listFiles(
    bucket: GridFsBucketRef,
    opts?: GridFsListOptions,
  ): AsyncIterable<{ readonly files: readonly GridFsFileInfo[] }>;
  uploadFile(
    bucket: GridFsBucketRef,
    source: UploadSource,
    opts: GridFsUploadOptions,
  ): Promise<string>;
  downloadFile(
    bucket: GridFsBucketRef,
    id: string,
    opts?: GridFsDownloadOptions,
  ): AsyncIterable<Uint8Array>;
  /** Streams a file into `destination` and resolves with the byte count. */
  downloadFileTo(
    bucket: GridFsBucketRef,
    id: string,
    destination: Writable,
    opts?: GridFsDownloadOptions,
  ): Promise<number>;
  deleteFile(bucket: GridFsBucketRef, id: string): Promise<void>;
  renameFile(bucket: GridFsBucketRef, id: string, filename: string): Promise<void>;

  usersInfo(
    db: string,
    opts?: { readonly user?: string; readonly showPrivileges?: boolean },
  ): Promise<UserInfo[]>;
  rolesInfo(
    db: string,
    opts?: {
      readonly role?: string;
      readonly showPrivileges?: boolean;
      readonly showBuiltinRoles?: boolean;
    },
  ): Promise<RoleInfo[]>;
  createUser(db: string, spec: CreateUserSpec): Promise<void>;
  updateUser(db: string, user: string, spec: UpdateUserSpec): Promise<void>;
  dropUser(db: string, user: string): Promise<void>;
  createRole(db: string, spec: RoleSpec): Promise<void>;
  updateRole(
    db: string,
    role: string,
    spec: Partial<Pick<RoleSpec, 'privileges' | 'roles'>>,
  ): Promise<void>;
  dropRole(db: string, role: string): Promise<void>;
  grantRoles(db: string, user: string, roles: readonly RoleRef[]): Promise<void>;
  revokeRoles(db: string, user: string, roles: readonly RoleRef[]): Promise<void>;

  /** Operations in progress ($currentOp), as canonical Extended JSON documents. */
  currentOp(opts?: CurrentOpOptions): Promise<string[]>;
  killOp(opid: number | string): Promise<void>;
  serverStatus(): Promise<ServerStatusSummary>;
  /** Per-collection time and counts (the `top` command; mongod only). */
  top(): Promise<TopEntry[]>;
}
