/**
 * Shapes the MongoDB driver's document services take and return, shared with the renderer and
 * the IPC layer. Every document, filter, pipeline and BSON value in them is canonical Extended
 * JSON v2 text (see `toEjson`), so they survive structured clone losslessly; nothing here holds
 * a bson class instance.
 */

/** A collection (or view) in a database. */
export interface Namespace {
  readonly db: string;
  readonly collection: string;
}

/** A find() query; the documents are Extended JSON text. */
export interface FindQuery {
  readonly filter?: string;
  readonly projection?: string;
  readonly sort?: string;
  readonly skip?: number;
  readonly limit?: number;
  readonly collation?: string;
  /** Extended JSON of an index key pattern or of an index name (a JSON string). */
  readonly hint?: string;
  readonly maxTimeMS?: number;
}

/** One page of documents from a cursor, as canonical Extended JSON. */
export interface DocumentPage {
  readonly documents: readonly string[];
}

export interface InsertOneResult {
  /** Extended JSON of the inserted `_id`. */
  readonly insertedId: string;
}

export interface InsertManyResult {
  readonly insertedCount: number;
  /** Extended JSON of each inserted `_id`, in input order. */
  readonly insertedIds: readonly string[];
}

/** An update or delete; a dry run reports only `matchedCount` and changes nothing. */
export interface WriteSummary {
  readonly dryRun: boolean;
  readonly matchedCount: number;
  readonly modifiedCount: number;
  readonly deletedCount: number;
  /** Extended JSON of the upserted `_id`, when an upsert inserted a document. */
  readonly upsertedId?: string;
}

export type ExplainVerbosity = 'queryPlanner' | 'executionStats' | 'allPlansExecution';

/** What to explain: a find query or an aggregation pipeline (Extended JSON array). */
export type ExplainTarget =
  | { readonly kind: 'find'; readonly query: FindQuery }
  | { readonly kind: 'aggregate'; readonly pipeline: string };

/** Totals from executionStats (when the verbosity ran the query). */
export interface ExplainSummary {
  readonly nReturned?: number;
  readonly executionTimeMillis?: number;
  readonly totalKeysExamined?: number;
  readonly totalDocsExamined?: number;
  /** Some stage scans the whole collection (COLLSCAN). */
  readonly collectionScan: boolean;
  /** Index names the winning plan uses. */
  readonly indexes: readonly string[];
}

/** Per-stage preview of an aggregation pipeline (spec §9, aggregation editor). */
export interface StagePreview {
  readonly documents: readonly string[];
  /** Extended JSON of the pipeline that actually ran (sampling stage included). */
  readonly pipeline: string;
  /** The input was cut to a sample. */
  readonly sampled: boolean;
  /** Stage indexes left out: disabled ones, and $out/$merge (a preview never writes). */
  readonly skippedStages: readonly number[];
  readonly durationMs: number;
}

export type IndexKind =
  'single' | 'compound' | 'text' | '2dsphere' | '2d' | 'hashed' | 'wildcard' | 'clustered';

/** An index as the index manager lists it. */
export interface IndexInfo {
  readonly name: string;
  /** Extended JSON of the key pattern, e.g. {"a":{"$numberInt":"1"}}. */
  readonly keys: string;
  readonly kind: IndexKind;
  readonly unique: boolean;
  readonly sparse: boolean;
  readonly hidden: boolean;
  /** TTL in seconds. */
  readonly expireAfterSeconds?: number;
  readonly partialFilterExpression?: string;
  readonly collation?: string;
  readonly wildcardProjection?: string;
  /** Extended JSON of the whole index specification as the server reports it. */
  readonly spec: string;
  /** Bytes on disk, from $collStats (when available). */
  readonly size?: number;
  /** Operations that used the index since `usageSince`, from $indexStats (when available). */
  readonly usageOps?: number;
  /** ISO-8601 time the usage counter started. */
  readonly usageSince?: string;
  /** The index is still being built. */
  readonly building?: boolean;
}

/** A new index (spec §9 index manager). Document-valued options are Extended JSON. */
export interface IndexSpec {
  /** Key pattern, e.g. {"a": 1, "b": -1}, {"loc": "2dsphere"}, {"$**": 1}. */
  readonly keys: string;
  readonly name?: string;
  readonly unique?: boolean;
  readonly sparse?: boolean;
  readonly hidden?: boolean;
  /** TTL index: seconds after the indexed date. */
  readonly expireAfterSeconds?: number;
  readonly partialFilterExpression?: string;
  readonly collation?: string;
  /** Wildcard index projection, e.g. {"a": 1, "b.c": 1}. */
  readonly wildcardProjection?: string;
  /** Text index weights, e.g. {"title": 10, "body": 1}. */
  readonly weights?: string;
  readonly defaultLanguage?: string;
  readonly languageOverride?: string;
  readonly textIndexVersion?: number;
  readonly '2dsphereIndexVersion'?: number;
  readonly bits?: number;
  readonly min?: number;
  readonly max?: number;
}

export type CollectionType = 'collection' | 'view' | 'timeseries';

export interface TimeSeriesOptions {
  readonly timeField: string;
  readonly metaField?: string;
  readonly granularity?: 'seconds' | 'minutes' | 'hours';
  readonly bucketMaxSpanSeconds?: number;
  readonly bucketRoundingSeconds?: number;
}

export type ValidationLevel = 'off' | 'strict' | 'moderate';
export type ValidationAction = 'error' | 'warn' | 'errorAndLog';

/** Options for a new collection; document-valued ones are Extended JSON. */
export interface CreateCollectionSpec {
  readonly capped?: { readonly size: number; readonly max?: number };
  readonly timeseries?: TimeSeriesOptions;
  /** Time series or clustered collections: delete documents this many seconds old. */
  readonly expireAfterSeconds?: number;
  /** A clustered collection keyed on _id (MongoDB 5.3+). */
  readonly clustered?: { readonly name?: string };
  readonly collation?: string;
  readonly validator?: string;
  readonly validationLevel?: ValidationLevel;
  readonly validationAction?: ValidationAction;
}

/** collMod changes; omitted fields stay as they are. */
export interface CollModSpec {
  readonly validator?: string;
  readonly validationLevel?: ValidationLevel;
  readonly validationAction?: ValidationAction;
  /** Seconds, or 'off' to stop expiring (time series and clustered collections). */
  readonly expireAfterSeconds?: number | 'off';
}

export interface CollectionStats {
  readonly count?: number;
  /** Uncompressed data size in bytes. */
  readonly size?: number;
  readonly storageSize?: number;
  readonly avgObjSize?: number;
  readonly totalIndexSize?: number;
  readonly indexCount?: number;
}

export interface CollectionInfo {
  readonly name: string;
  readonly type: CollectionType;
  /** Extended JSON of the listCollections options (validator, capped, collation, viewOn...). */
  readonly options: string;
  readonly readOnly: boolean;
  readonly capped: boolean;
  readonly validator?: string;
  readonly validationLevel?: ValidationLevel;
  readonly validationAction?: ValidationAction;
  readonly collation?: string;
  readonly timeseries?: TimeSeriesOptions;
  readonly expireAfterSeconds?: number;
  readonly viewOn?: string;
  readonly pipeline?: string;
  readonly clustered: boolean;
  /** Collection statistics; absent for views or without the privilege. */
  readonly stats?: CollectionStats;
}

/** Where a change stream listens. */
export type WatchScope =
  | { readonly kind: 'cluster' }
  | { readonly kind: 'database'; readonly db: string }
  | { readonly kind: 'collection'; readonly ns: Namespace };

/** One change event (spec §9 change stream viewer). */
export interface ChangeEvent {
  readonly operationType: string;
  /** Extended JSON of the whole event. */
  readonly event: string;
  /** Extended JSON of the resume token; pass it back as `resumeAfter` to continue later. */
  readonly resumeToken: string;
  readonly ns?: { readonly db: string; readonly collection?: string };
  readonly documentKey?: string;
  /** ISO-8601 cluster time of the event. */
  readonly clusterTime?: string;
}

export interface GridFsBucketRef {
  readonly db: string;
  /** Bucket name, "fs" by default. */
  readonly bucket: string;
}

export interface GridFsFileInfo {
  /** Extended JSON of the file's _id. */
  readonly id: string;
  readonly filename: string;
  readonly length: number;
  readonly chunkSize: number;
  /** ISO-8601 upload time. */
  readonly uploadDate: string;
  readonly contentType?: string;
  readonly metadata?: string;
}

export interface RoleRef {
  readonly role: string;
  readonly db: string;
}

/** A privilege: actions on a resource (a database/collection pair, the cluster, or anything). */
export interface Privilege {
  readonly resource:
    | { readonly db: string; readonly collection: string }
    | { readonly cluster: true }
    | { readonly anyResource: true };
  readonly actions: readonly string[];
}

export interface UserInfo {
  readonly user: string;
  readonly db: string;
  readonly roles: readonly RoleRef[];
  readonly inheritedRoles?: readonly RoleRef[];
  readonly inheritedPrivileges?: readonly Privilege[];
  readonly mechanisms?: readonly string[];
  readonly customData?: string;
}

export interface RoleInfo {
  readonly role: string;
  readonly db: string;
  readonly isBuiltin: boolean;
  readonly roles: readonly RoleRef[];
  readonly inheritedRoles?: readonly RoleRef[];
  readonly privileges?: readonly Privilege[];
  readonly inheritedPrivileges?: readonly Privilege[];
}

export interface CreateUserSpec {
  readonly user: string;
  /** Omit for users that authenticate externally (X.509, LDAP) in $external. */
  readonly password?: string;
  readonly roles: readonly RoleRef[];
  readonly customData?: string;
  readonly mechanisms?: readonly ('SCRAM-SHA-1' | 'SCRAM-SHA-256')[];
}

export interface UpdateUserSpec {
  readonly password?: string;
  /** Replaces the user's roles. */
  readonly roles?: readonly RoleRef[];
  readonly customData?: string;
  readonly mechanisms?: readonly ('SCRAM-SHA-1' | 'SCRAM-SHA-256')[];
}

export interface RoleSpec {
  readonly role: string;
  readonly privileges: readonly Privilege[];
  readonly roles: readonly RoleRef[];
}

export type TopologyKind = 'standalone' | 'replicaSet' | 'sharded' | 'loadBalanced' | 'unknown';

export interface TopologyMember {
  readonly host: string;
  /** PRIMARY, SECONDARY, ARBITER, shard name... */
  readonly state: string;
  readonly healthy: boolean;
  /** The member this session talks to. */
  readonly self?: boolean;
}

/** What the UI shows about the connected deployment. */
export interface MongoServerInfo {
  readonly version: string;
  readonly topology: TopologyKind;
  readonly setName?: string;
  readonly members: readonly TopologyMember[];
  readonly storageEngine?: string;
  /** e.g. ["enterprise"]. */
  readonly modules: readonly string[];
  readonly maxWireVersion?: number;
}

export interface ServerStatusSummary {
  readonly host: string;
  readonly version: string;
  readonly uptimeSeconds: number;
  readonly connections?: { readonly current: number; readonly available: number };
  readonly opcounters?: Readonly<Record<string, number>>;
  readonly memoryMb?: { readonly resident: number; readonly virtual: number };
  readonly network?: {
    readonly bytesIn: number;
    readonly bytesOut: number;
    readonly requests: number;
  };
  /** Extended JSON of the full serverStatus reply. */
  readonly raw: string;
}

export interface TopEntry {
  readonly ns: string;
  /** Microseconds spent and operation counts per category (total, readLock, writeLock...). */
  readonly totals: Readonly<Record<string, { readonly time: number; readonly count: number }>>;
}
