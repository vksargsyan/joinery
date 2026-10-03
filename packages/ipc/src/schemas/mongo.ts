import type { PlanNode } from '@querybara/core';
import type {
  BsonTypeName,
  ChangeEvent,
  CollModSpec,
  CollectionInfo,
  CollectionStats,
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
  IndexKind,
  IndexSpec,
  InsertManyResult,
  InsertOneResult,
  MongoServerInfo,
  Namespace,
  Privilege,
  RoleInfo,
  RoleRef,
  RoleSpec,
  SchemaAnalysis,
  SchemaAnalysisOptions,
  SchemaField,
  ServerStatusSummary,
  StagePreview,
  TimeSeriesOptions,
  TopEntry,
  TopologyMember,
  UpdateUserSpec,
  UserInfo,
  ValidationAction,
  ValidationLevel,
  WatchScope,
  WriteSummary,
} from '@querybara/mongo-tools';
import { z } from 'zod';

import { idSchema } from './common';
import { planNodeSchema } from './driver';
import { pageSizeSchema } from './results';

/**
 * Zod schemas for the MongoDB module (spec §9): the document, index, collection, schema, change
 * stream, GridFS, user and admin services of a MongoDB session, as they cross from the renderer
 * to the connection host. Every document, filter, pipeline and BSON value is canonical Extended
 * JSON text (mongo-tools' `toEjson`), so nothing here holds a bson instance.
 *
 * Each result schema is annotated with its @querybara/mongo-tools wire type as both input and
 * output, so a drift between the driver's shapes and these schemas fails to compile.
 */

/** Extended JSON text of a document, filter, pipeline or value. */
const ejsonSchema = z.string().min(1);
const nameSchema = z.string().min(1).max(255);
const countSchema = z.number().int().nonnegative();
const millisSchema = z.number().int().positive();

export const mongoNamespaceSchema: z.ZodType<Namespace, Namespace> = z.object({
  db: nameSchema,
  collection: nameSchema,
});

export const mongoFindQuerySchema: z.ZodType<FindQuery, FindQuery> = z.object({
  filter: ejsonSchema.optional(),
  projection: ejsonSchema.optional(),
  sort: ejsonSchema.optional(),
  skip: countSchema.optional(),
  limit: countSchema.optional(),
  collation: ejsonSchema.optional(),
  hint: ejsonSchema.optional(),
  maxTimeMS: millisSchema.optional(),
});

export const mongoDocumentPageSchema: z.ZodType<DocumentPage, DocumentPage> = z.object({
  documents: z.array(z.string()),
});

export const mongoInsertOneResultSchema: z.ZodType<InsertOneResult, InsertOneResult> = z.object({
  insertedId: z.string(),
});

export const mongoInsertManyResultSchema: z.ZodType<InsertManyResult, InsertManyResult> = z.object({
  insertedCount: countSchema,
  insertedIds: z.array(z.string()),
});

export const mongoWriteSummarySchema: z.ZodType<WriteSummary, WriteSummary> = z.object({
  dryRun: z.boolean(),
  matchedCount: countSchema,
  modifiedCount: countSchema,
  deletedCount: countSchema,
  upsertedId: z.string().optional(),
});

export const mongoExplainVerbositySchema: z.ZodType<ExplainVerbosity, ExplainVerbosity> = z.enum([
  'queryPlanner',
  'executionStats',
  'allPlansExecution',
]);

export const mongoExplainTargetSchema: z.ZodType<ExplainTarget, ExplainTarget> =
  z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('find'), query: mongoFindQuerySchema }),
    z.object({ kind: z.literal('aggregate'), pipeline: ejsonSchema }),
  ]);

export const mongoExplainSummarySchema: z.ZodType<ExplainSummary, ExplainSummary> = z.object({
  nReturned: z.number().optional(),
  executionTimeMillis: z.number().optional(),
  totalKeysExamined: z.number().optional(),
  totalDocsExamined: z.number().optional(),
  collectionScan: z.boolean(),
  indexes: z.array(z.string()),
});

/** An explained query: the normalised plan tree, its totals and the raw explain output. */
export interface MongoExplainResult {
  readonly plan: PlanNode;
  readonly summary: ExplainSummary;
  /** Canonical Extended JSON of the server's explain output. */
  readonly raw: string;
}

export const mongoExplainResultSchema: z.ZodType<MongoExplainResult, MongoExplainResult> = z.object(
  {
    plan: planNodeSchema,
    summary: mongoExplainSummarySchema,
    raw: z.string(),
  },
);

export const mongoStagePreviewSchema: z.ZodType<StagePreview, StagePreview> = z.object({
  documents: z.array(z.string()),
  pipeline: z.string(),
  sampled: z.boolean(),
  skippedStages: z.array(z.number().int().nonnegative()),
  durationMs: z.number().nonnegative(),
});

const indexKindSchema: z.ZodType<IndexKind, IndexKind> = z.enum([
  'single',
  'compound',
  'text',
  '2dsphere',
  '2d',
  'hashed',
  'wildcard',
  'clustered',
]);

export const mongoIndexInfoSchema: z.ZodType<IndexInfo, IndexInfo> = z.object({
  name: z.string(),
  keys: z.string(),
  kind: indexKindSchema,
  unique: z.boolean(),
  sparse: z.boolean(),
  hidden: z.boolean(),
  expireAfterSeconds: z.number().optional(),
  partialFilterExpression: z.string().optional(),
  collation: z.string().optional(),
  wildcardProjection: z.string().optional(),
  spec: z.string(),
  size: z.number().optional(),
  usageOps: z.number().optional(),
  usageSince: z.string().optional(),
  building: z.boolean().optional(),
});

export const mongoIndexSpecSchema: z.ZodType<IndexSpec, IndexSpec> = z.object({
  keys: ejsonSchema,
  name: nameSchema.optional(),
  unique: z.boolean().optional(),
  sparse: z.boolean().optional(),
  hidden: z.boolean().optional(),
  expireAfterSeconds: countSchema.optional(),
  partialFilterExpression: ejsonSchema.optional(),
  collation: ejsonSchema.optional(),
  wildcardProjection: ejsonSchema.optional(),
  weights: ejsonSchema.optional(),
  defaultLanguage: z.string().min(1).optional(),
  languageOverride: z.string().min(1).optional(),
  textIndexVersion: z.number().int().positive().optional(),
  '2dsphereIndexVersion': z.number().int().positive().optional(),
  bits: z.number().int().positive().optional(),
  min: z.number().optional(),
  max: z.number().optional(),
});

const timeSeriesOptionsSchema: z.ZodType<TimeSeriesOptions, TimeSeriesOptions> = z.object({
  timeField: nameSchema,
  metaField: nameSchema.optional(),
  granularity: z.enum(['seconds', 'minutes', 'hours']).optional(),
  bucketMaxSpanSeconds: z.number().int().positive().optional(),
  bucketRoundingSeconds: z.number().int().positive().optional(),
});

const validationLevelSchema: z.ZodType<ValidationLevel, ValidationLevel> = z.enum([
  'off',
  'strict',
  'moderate',
]);
const validationActionSchema: z.ZodType<ValidationAction, ValidationAction> = z.enum([
  'error',
  'warn',
  'errorAndLog',
]);

export const mongoCreateCollectionSpecSchema: z.ZodType<
  CreateCollectionSpec,
  CreateCollectionSpec
> = z.object({
  capped: z
    .object({ size: z.number().int().positive(), max: z.number().int().positive().optional() })
    .optional(),
  timeseries: timeSeriesOptionsSchema.optional(),
  expireAfterSeconds: countSchema.optional(),
  clustered: z.object({ name: nameSchema.optional() }).optional(),
  collation: ejsonSchema.optional(),
  validator: ejsonSchema.optional(),
  validationLevel: validationLevelSchema.optional(),
  validationAction: validationActionSchema.optional(),
});

export const mongoCollModSpecSchema: z.ZodType<CollModSpec, CollModSpec> = z.object({
  validator: ejsonSchema.optional(),
  validationLevel: validationLevelSchema.optional(),
  validationAction: validationActionSchema.optional(),
  expireAfterSeconds: z.union([countSchema, z.literal('off')]).optional(),
});

const collectionStatsSchema: z.ZodType<CollectionStats, CollectionStats> = z.object({
  count: z.number().optional(),
  size: z.number().optional(),
  storageSize: z.number().optional(),
  avgObjSize: z.number().optional(),
  totalIndexSize: z.number().optional(),
  indexCount: z.number().optional(),
});

export const mongoCollectionInfoSchema: z.ZodType<CollectionInfo, CollectionInfo> = z.object({
  name: z.string(),
  type: z.enum(['collection', 'view', 'timeseries']),
  options: z.string(),
  readOnly: z.boolean(),
  capped: z.boolean(),
  validator: z.string().optional(),
  validationLevel: validationLevelSchema.optional(),
  validationAction: validationActionSchema.optional(),
  collation: z.string().optional(),
  timeseries: timeSeriesOptionsSchema.optional(),
  expireAfterSeconds: z.number().optional(),
  viewOn: z.string().optional(),
  pipeline: z.string().optional(),
  clustered: z.boolean(),
  stats: collectionStatsSchema.optional(),
});

/**
 * BSON type names as mongo-tools spells them, listed here so this package needs mongo-tools'
 * types only (no bson at run time in main); the check below fails to compile if one is missing.
 */
const BSON_TYPE_NAMES = [
  'double',
  'string',
  'object',
  'array',
  'binData',
  'uuid',
  'undefined',
  'objectId',
  'bool',
  'date',
  'null',
  'regex',
  'dbPointer',
  'javascript',
  'symbol',
  'int',
  'timestamp',
  'long',
  'decimal',
  'minKey',
  'maxKey',
] as const satisfies readonly BsonTypeName[];
type _EveryBsonType =
  Exclude<BsonTypeName, (typeof BSON_TYPE_NAMES)[number]> extends never ? true : never;
const _everyBsonType: _EveryBsonType = true;

const bsonTypeNameSchema = z.enum(BSON_TYPE_NAMES);

export const mongoSchemaFieldSchema: z.ZodType<SchemaField, SchemaField> = z.object({
  name: z.string(),
  path: z.string(),
  queryPath: z.string(),
  count: countSchema,
  documents: countSchema,
  share: z.number(),
  presence: z.number(),
  types: z.array(z.object({ type: bsonTypeNameSchema, count: countSchema })),
  topValues: z.array(z.object({ value: z.string(), display: z.string(), count: countSchema })),
  topValuesExact: z.boolean(),
  distinctValues: countSchema.optional(),
  get fields(): z.ZodArray<z.ZodType<SchemaField, SchemaField>> {
    return z.array(mongoSchemaFieldSchema);
  },
  get items(): z.ZodOptional<z.ZodType<SchemaField, SchemaField>> {
    return mongoSchemaFieldSchema.optional();
  },
  arrayLengths: z.object({ min: z.number(), max: z.number(), average: z.number() }).optional(),
  documentValues: countSchema,
});

export const mongoSchemaAnalysisSchema: z.ZodType<SchemaAnalysis, SchemaAnalysis> = z.object({
  documentCount: countSchema,
  fields: z.array(mongoSchemaFieldSchema),
  truncated: z.boolean(),
});

export const mongoSchemaAnalysisOptionsSchema: z.ZodType<
  SchemaAnalysisOptions & {
    readonly sampleSize?: number;
    readonly filter?: string;
    readonly maxTimeMS?: number;
  }
> = z.object({
  sampleSize: z.number().int().min(1).max(100_000).optional(),
  filter: ejsonSchema.optional(),
  maxTimeMS: millisSchema.optional(),
  maxFields: z.number().int().positive().optional(),
  maxDepth: z.number().int().positive().optional(),
  maxArrayItems: z.number().int().positive().optional(),
  topValues: z.number().int().nonnegative().optional(),
  maxValueLength: z.number().int().positive().optional(),
});

export const mongoWatchScopeSchema: z.ZodType<WatchScope, WatchScope> = z.discriminatedUnion(
  'kind',
  [
    z.object({ kind: z.literal('cluster') }),
    z.object({ kind: z.literal('database'), db: nameSchema }),
    z.object({ kind: z.literal('collection'), ns: mongoNamespaceSchema }),
  ],
);

export const mongoWatchOptionsSchema = z.object({
  fullDocument: z.enum(['default', 'updateLookup', 'whenAvailable', 'required']).optional(),
  fullDocumentBeforeChange: z.enum(['off', 'whenAvailable', 'required']).optional(),
  resumeAfter: ejsonSchema.optional(),
  startAfter: ejsonSchema.optional(),
  startAtOperationTime: ejsonSchema.optional(),
  batchSize: z.number().int().positive().optional(),
  maxAwaitTimeMS: millisSchema.optional(),
});

export const mongoChangeEventSchema: z.ZodType<ChangeEvent, ChangeEvent> = z.object({
  operationType: z.string(),
  event: z.string(),
  resumeToken: z.string(),
  ns: z.object({ db: z.string(), collection: z.string().optional() }).optional(),
  documentKey: z.string().optional(),
  clusterTime: z.string().optional(),
});

export const mongoGridFsBucketSchema: z.ZodType<GridFsBucketRef, GridFsBucketRef> = z.object({
  db: nameSchema,
  bucket: nameSchema,
});

export const mongoGridFsFileSchema: z.ZodType<GridFsFileInfo, GridFsFileInfo> = z.object({
  id: z.string(),
  filename: z.string(),
  length: z.number().nonnegative(),
  chunkSize: z.number().nonnegative(),
  uploadDate: z.string(),
  contentType: z.string().optional(),
  metadata: z.string().optional(),
});

/** Bytes the renderer may read from a GridFS file directly (a preview); larger ones go by path. */
export const GRIDFS_READ_LIMIT = 4 * 1024 * 1024;

export const mongoRoleRefSchema: z.ZodType<RoleRef, RoleRef> = z.object({
  role: nameSchema,
  db: nameSchema,
});

export const mongoPrivilegeSchema: z.ZodType<Privilege, Privilege> = z.object({
  resource: z.union([
    z.object({ db: z.string(), collection: z.string() }),
    z.object({ cluster: z.literal(true) }),
    z.object({ anyResource: z.literal(true) }),
  ]),
  actions: z.array(z.string().min(1)),
});

export const mongoUserInfoSchema: z.ZodType<UserInfo, UserInfo> = z.object({
  user: z.string(),
  db: z.string(),
  roles: z.array(mongoRoleRefSchema),
  inheritedRoles: z.array(mongoRoleRefSchema).optional(),
  inheritedPrivileges: z.array(mongoPrivilegeSchema).optional(),
  mechanisms: z.array(z.string()).optional(),
  customData: z.string().optional(),
});

export const mongoRoleInfoSchema: z.ZodType<RoleInfo, RoleInfo> = z.object({
  role: z.string(),
  db: z.string(),
  isBuiltin: z.boolean(),
  roles: z.array(mongoRoleRefSchema),
  inheritedRoles: z.array(mongoRoleRefSchema).optional(),
  privileges: z.array(mongoPrivilegeSchema).optional(),
  inheritedPrivileges: z.array(mongoPrivilegeSchema).optional(),
});

const scramSchema = z.enum(['SCRAM-SHA-1', 'SCRAM-SHA-256']);

/** A new user. The password is an input only (it goes to the server, never comes back). */
export const mongoCreateUserSpecSchema: z.ZodType<CreateUserSpec, CreateUserSpec> = z.object({
  user: nameSchema,
  password: z.string().min(1).max(65_536).optional(),
  roles: z.array(mongoRoleRefSchema),
  customData: ejsonSchema.optional(),
  mechanisms: z.array(scramSchema).optional(),
});

export const mongoUpdateUserSpecSchema: z.ZodType<UpdateUserSpec, UpdateUserSpec> = z.object({
  password: z.string().min(1).max(65_536).optional(),
  roles: z.array(mongoRoleRefSchema).optional(),
  customData: ejsonSchema.optional(),
  mechanisms: z.array(scramSchema).optional(),
});

export const mongoRoleSpecSchema: z.ZodType<RoleSpec, RoleSpec> = z.object({
  role: nameSchema,
  privileges: z.array(mongoPrivilegeSchema),
  roles: z.array(mongoRoleRefSchema),
});

const topologyMemberSchema: z.ZodType<TopologyMember, TopologyMember> = z.object({
  host: z.string(),
  state: z.string(),
  healthy: z.boolean(),
  self: z.boolean().optional(),
});

export const mongoServerInfoSchema: z.ZodType<MongoServerInfo, MongoServerInfo> = z.object({
  version: z.string(),
  topology: z.enum(['standalone', 'replicaSet', 'sharded', 'loadBalanced', 'unknown']),
  setName: z.string().optional(),
  members: z.array(topologyMemberSchema),
  storageEngine: z.string().optional(),
  modules: z.array(z.string()),
  maxWireVersion: z.number().optional(),
});

export const mongoServerStatusSchema: z.ZodType<ServerStatusSummary, ServerStatusSummary> =
  z.object({
    host: z.string(),
    version: z.string(),
    uptimeSeconds: z.number(),
    connections: z.object({ current: z.number(), available: z.number() }).optional(),
    opcounters: z.record(z.string(), z.number()).optional(),
    memoryMb: z.object({ resident: z.number(), virtual: z.number() }).optional(),
    network: z
      .object({ bytesIn: z.number(), bytesOut: z.number(), requests: z.number() })
      .optional(),
    raw: z.string(),
  });

export const mongoTopEntrySchema: z.ZodType<TopEntry, TopEntry> = z.object({
  ns: z.string(),
  totals: z.record(z.string(), z.object({ time: z.number(), count: z.number() })),
});

// ---------------------------------------------------------------------------------------------
// Inputs. Every method names the session it runs on; writes carry the user's confirmation.

/** The session a MongoDB call runs on. */
export const mongoSessionRefSchema = z.object({ sessionId: idSchema });

/**
 * The page's confirmation of a write (spec §4, §6): needed for destructive operations (drops,
 * bulk updates and deletes, index drops) on every profile, and for every write on production
 * profiles and profiles that confirm writes. The connection host refuses writes on read-only
 * profiles whatever this says.
 */
export const confirmedSchema = z.boolean().optional();

/** Long operations: an execution id for `cancel`, and a server-side time limit. */
const operationFields = {
  executionId: idSchema.optional(),
  maxTimeMS: millisSchema.optional(),
};

const inNamespace = { sessionId: idSchema, ns: mongoNamespaceSchema };

export const mongoFindInputSchema = z.object({
  ...inNamespace,
  query: mongoFindQuerySchema,
  /** Documents per page, up to 1,000 (the default). */
  pageSize: pageSizeSchema.optional(),
  executionId: idSchema.optional(),
});

export const mongoCountInputSchema = z.object({
  ...inNamespace,
  filter: ejsonSchema.optional(),
  ...operationFields,
});

export const mongoAggregateInputSchema = z.object({
  ...inNamespace,
  pipeline: ejsonSchema,
  pageSize: pageSizeSchema.optional(),
  allowDiskUse: z.boolean().optional(),
  collation: ejsonSchema.optional(),
  hint: ejsonSchema.optional(),
  /** A pipeline ending in $out or $merge writes. */
  confirmed: confirmedSchema,
  ...operationFields,
});

export const mongoPreviewStageInputSchema = z.object({
  ...inNamespace,
  pipeline: ejsonSchema,
  stageIndex: z.number().int().nonnegative(),
  sampleSize: z.number().int().min(1).max(100_000).optional(),
  sampling: z.enum(['limit', 'sample']).optional(),
  disabled: z.array(z.number().int().nonnegative()).optional(),
  limit: z.number().int().min(1).max(1_000).optional(),
  ...operationFields,
});

export const mongoUpdateManyInputSchema = z.object({
  ...inNamespace,
  filter: ejsonSchema,
  update: ejsonSchema,
  upsert: z.boolean().optional(),
  arrayFilters: ejsonSchema.optional(),
  collation: ejsonSchema.optional(),
  hint: ejsonSchema.optional(),
  /** Count the matching documents and change nothing (spec §9: the matched count first). */
  dryRun: z.boolean().optional(),
  confirmed: confirmedSchema,
  ...operationFields,
});

export const mongoDeleteManyInputSchema = z.object({
  ...inNamespace,
  filter: ejsonSchema,
  dryRun: z.boolean().optional(),
  confirmed: confirmedSchema,
  ...operationFields,
});

export const mongoListFilesInputSchema = z.object({
  sessionId: idSchema,
  bucket: mongoGridFsBucketSchema,
  filter: ejsonSchema.optional(),
  sort: ejsonSchema.optional(),
  skip: countSchema.optional(),
  limit: countSchema.optional(),
  pageSize: pageSizeSchema.optional(),
});

/** A GridFS file moved by path in main (upload reads it, download writes it). */
export const mongoGridFsTransferProgressSchema = z.object({
  bytes: countSchema,
  total: countSchema.optional(),
});

export const mongoGridFsUploadInputSchema = z.object({
  connectionId: idSchema,
  bucket: mongoGridFsBucketSchema,
  /** A file this window picked with `dialogs.openFile`. */
  path: z.string().min(1).max(4096),
  /** Defaults to the file's base name. */
  filename: z.string().min(1).max(1024).optional(),
  contentType: z.string().min(1).max(255).optional(),
  metadata: ejsonSchema.optional(),
  chunkSizeBytes: z
    .number()
    .int()
    .min(1024)
    .max(15 * 1024 * 1024)
    .optional(),
  confirmed: confirmedSchema,
});

export const mongoGridFsDownloadInputSchema = z.object({
  connectionId: idSchema,
  bucket: mongoGridFsBucketSchema,
  /** Extended JSON of the file's _id. */
  id: ejsonSchema,
  /** Where this window's `dialogs.saveFile` said to write. */
  path: z.string().min(1).max(4096),
});

// ---------------------------------------------------------------------------------------------
// Main: saved aggregation pipelines and exported text.

/** A collection's saved pipelines are listed by where they run. */
export const mongoPipelineScopeSchema = z.object({
  profileId: idSchema,
  db: nameSchema,
  collection: nameSchema,
});

/**
 * A named aggregation pipeline saved for one collection (spec §9, aggregation editor), kept as
 * a saved query of the local store. `text` is the editor's pipeline text in mongosh syntax,
 * disabled stages included as `//` comments.
 */
export const mongoSavedPipelineSchema = z.object({
  id: idSchema,
  name: z.string().trim().min(1).max(200),
  text: z.string().max(1_000_000),
  updatedAt: z.string(),
});
export type MongoSavedPipeline = z.infer<typeof mongoSavedPipelineSchema>;

/** Saves a pipeline: a new one without `id`, or replaces the text and name of `id`. */
export const mongoSavePipelineInputSchema = mongoPipelineScopeSchema.extend({
  id: idSchema.optional(),
  name: z.string().trim().min(1).max(200),
  text: z.string().max(1_000_000),
});

/** Most bytes of exported text (a JSON Schema, a validator) main writes for the renderer. */
export const EXPORT_TEXT_LIMIT = 16 * 1024 * 1024;

/** Text written where this window's `dialogs.saveFile` pointed. */
export const mongoWriteTextInputSchema = z.object({
  path: z.string().min(1).max(4096),
  text: z.string().max(EXPORT_TEXT_LIMIT),
});
