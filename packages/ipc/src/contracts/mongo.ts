import { z } from 'zod';

import { idSchema } from '../schemas/common';
import {
  GRIDFS_READ_LIMIT,
  confirmedSchema,
  mongoAggregateInputSchema,
  mongoChangeEventSchema,
  mongoCollModSpecSchema,
  mongoCollectionInfoSchema,
  mongoCountInputSchema,
  mongoCreateCollectionSpecSchema,
  mongoCreateUserSpecSchema,
  mongoDeleteManyInputSchema,
  mongoDocumentPageSchema,
  mongoExplainResultSchema,
  mongoExplainTargetSchema,
  mongoExplainVerbositySchema,
  mongoFindInputSchema,
  mongoGridFsBucketSchema,
  mongoGridFsDownloadInputSchema,
  mongoGridFsFileSchema,
  mongoGridFsTransferProgressSchema,
  mongoGridFsUploadInputSchema,
  mongoIndexInfoSchema,
  mongoIndexSpecSchema,
  mongoInsertManyResultSchema,
  mongoInsertOneResultSchema,
  mongoListFilesInputSchema,
  mongoNamespaceSchema,
  mongoPreviewStageInputSchema,
  mongoPrivilegeSchema,
  mongoRoleInfoSchema,
  mongoRoleRefSchema,
  mongoPipelineScopeSchema,
  mongoRoleSpecSchema,
  mongoSavePipelineInputSchema,
  mongoSavedPipelineSchema,
  mongoSchemaAnalysisOptionsSchema,
  mongoSchemaAnalysisSchema,
  mongoServerInfoSchema,
  mongoServerStatusSchema,
  mongoSessionRefSchema,
  mongoStagePreviewSchema,
  mongoTopEntrySchema,
  mongoUpdateManyInputSchema,
  mongoUpdateUserSpecSchema,
  mongoUserInfoSchema,
  mongoWatchOptionsSchema,
  mongoWatchScopeSchema,
  mongoWriteSummarySchema,
  mongoWriteTextInputSchema,
} from '../schemas/mongo';

/**
 * The `mongo.*` namespace of the connection host contract (spec §9): every service of a
 * MongoDB session, on a session opened with `openSession`. Documents cross as canonical
 * Extended JSON text; cursors (find, aggregate, GridFS listings) and change streams are
 * streams, so pages are fetched as the renderer pulls and stopping early closes the cursor.
 *
 * Write rules (spec §4) are checked by the host whatever the page sends: a read-only profile
 * refuses every write with READ_ONLY (dry runs still count); destructive operations need
 * `confirmed` on every profile, and every write needs it on production profiles and profiles
 * that confirm writes (CONFIRMATION_REQUIRED otherwise). Engines other than MongoDB answer
 * NOT_SUPPORTED.
 */

const sessionId = idSchema;
const ns = mongoNamespaceSchema;
const db = z.string().min(1).max(255);
const name = z.string().min(1).max(255);
const ejson = z.string().min(1);
const done = z.void();
const inNs = { sessionId, ns };

export const mongoHostContractShape = {
  /** Version, topology and members of the deployment. */
  serverInfo: { input: mongoSessionRefSchema, output: mongoServerInfoSchema },
  /** The database the session's `execute` runs commands against (the console's `use`). */
  useDatabase: { input: z.object({ sessionId, database: db }), output: done },

  /** Streams a find() a page at a time (the page is the server batch). */
  find: { input: mongoFindInputSchema, item: mongoDocumentPageSchema },
  /** Exact count of the documents matching a filter (countDocuments). */
  count: { input: mongoCountInputSchema, output: z.object({ count: z.number().nonnegative() }) },
  /** The collection's size from its metadata, without reading documents. */
  estimatedCount: {
    input: z.object({ ...inNs, maxTimeMS: z.number().int().positive().optional() }),
    output: z.object({ count: z.number().nonnegative() }),
  },
  /** Streams an aggregation pipeline's results; a pipeline ending in $out/$merge is a write. */
  aggregate: { input: mongoAggregateInputSchema, item: mongoDocumentPageSchema },
  /** The output of a pipeline up to one stage, on a sample (the aggregation editor's preview). */
  previewStage: { input: mongoPreviewStageInputSchema, output: mongoStagePreviewSchema },

  insertOne: {
    input: z.object({ ...inNs, document: ejson, confirmed: confirmedSchema }),
    output: mongoInsertOneResultSchema,
  },
  /** `documents` is an Extended JSON array. */
  insertMany: {
    input: z.object({
      ...inNs,
      documents: ejson,
      ordered: z.boolean().optional(),
      confirmed: confirmedSchema,
    }),
    output: mongoInsertManyResultSchema,
  },
  /**
   * Replaces a document only while it still equals `original` (optimistic concurrency): fails
   * with CONFLICT whose `detail` is the current document, or NOT_FOUND when it was deleted.
   */
  replaceOne: {
    input: z.object({ ...inNs, original: ejson, replacement: ejson, confirmed: confirmedSchema }),
    output: mongoWriteSummarySchema,
  },
  /** A bulk update by filter (destructive: needs `confirmed` unless `dryRun`). */
  updateMany: { input: mongoUpdateManyInputSchema, output: mongoWriteSummarySchema },
  /** Deletes the document with this _id (Extended JSON). */
  deleteOne: {
    input: z.object({
      ...inNs,
      id: ejson,
      dryRun: z.boolean().optional(),
      confirmed: confirmedSchema,
    }),
    output: mongoWriteSummarySchema,
  },
  /** A bulk delete by filter (destructive: needs `confirmed` unless `dryRun`). */
  deleteMany: { input: mongoDeleteManyInputSchema, output: mongoWriteSummarySchema },
  /** Explains a find or an aggregation (queryPlanner by default; executionStats runs it). */
  explain: {
    input: z.object({
      ...inNs,
      target: mongoExplainTargetSchema,
      verbosity: mongoExplainVerbositySchema.optional(),
      maxTimeMS: z.number().int().positive().optional(),
    }),
    output: mongoExplainResultSchema,
  },
  /** Schema analysis on a $sample of the collection (spec §9). */
  analyzeSchema: {
    input: z.object({ ...inNs, options: mongoSchemaAnalysisOptionsSchema.optional() }),
    output: mongoSchemaAnalysisSchema,
  },
  /** Tails a change stream until the caller stops (replica sets and sharded clusters). */
  watch: {
    input: z.object({
      sessionId,
      scope: mongoWatchScopeSchema,
      pipeline: ejson.optional(),
      options: mongoWatchOptionsSchema.optional(),
    }),
    item: mongoChangeEventSchema,
  },

  indexes: {
    list: { input: z.object(inNs), output: z.array(mongoIndexInfoSchema) },
    /** Returns the new index's name. */
    create: {
      input: z.object({ ...inNs, spec: mongoIndexSpecSchema, confirmed: confirmedSchema }),
      output: z.object({ name: z.string() }),
    },
    /** Destructive: needs `confirmed`. */
    drop: { input: z.object({ ...inNs, name, confirmed: confirmedSchema }), output: done },
    setHidden: {
      input: z.object({ ...inNs, name, hidden: z.boolean(), confirmed: confirmedSchema }),
      output: done,
    },
  },

  collections: {
    info: { input: z.object(inNs), output: mongoCollectionInfoSchema },
    create: {
      input: z.object({
        ...inNs,
        spec: mongoCreateCollectionSpecSchema.optional(),
        confirmed: confirmedSchema,
      }),
      output: done,
    },
    createView: {
      input: z.object({
        ...inNs,
        viewOn: name,
        pipeline: ejson,
        collation: ejson.optional(),
        confirmed: confirmedSchema,
      }),
      output: done,
    },
    /** Validation rules and expiry (collMod). */
    collMod: {
      input: z.object({ ...inNs, changes: mongoCollModSpecSchema, confirmed: confirmedSchema }),
      output: done,
    },
    /** Renames within the database; destructive with `dropTarget`. */
    rename: {
      input: z.object({
        ...inNs,
        to: name,
        dropTarget: z.boolean().optional(),
        confirmed: confirmedSchema,
      }),
      output: done,
    },
    /** Drops a collection or view. Destructive: needs `confirmed`. */
    drop: { input: z.object({ ...inNs, confirmed: confirmedSchema }), output: done },
    /** Drops a whole database. Destructive: needs `confirmed`. */
    dropDatabase: { input: z.object({ sessionId, db, confirmed: confirmedSchema }), output: done },
  },

  gridfs: {
    /** Bucket names of a database (pairs of `<bucket>.files` / `<bucket>.chunks`). */
    buckets: { input: z.object({ sessionId, db }), output: z.array(z.string()) },
    /** Streams the bucket's files a page at a time. */
    list: {
      input: mongoListFilesInputSchema,
      item: z.object({ files: z.array(mongoGridFsFileSchema) }),
    },
    /**
     * The start of a file's bytes, for a preview: at most `maxBytes` (up to 4 MiB). Whole
     * files move by path through main (`mongo.gridfs.upload` / `download` in the main contract).
     */
    read: {
      input: z.object({
        sessionId,
        bucket: mongoGridFsBucketSchema,
        id: ejson,
        maxBytes: z.number().int().min(1).max(GRIDFS_READ_LIMIT).optional(),
      }),
      output: z.object({
        bytes: z.custom<Uint8Array>((value) => value instanceof Uint8Array, 'Expected bytes'),
        /** The file is longer than what was read. */
        truncated: z.boolean(),
      }),
    },
    /** Deletes a file and its chunks. Destructive: needs `confirmed`. */
    delete: {
      input: z.object({
        sessionId,
        bucket: mongoGridFsBucketSchema,
        id: ejson,
        confirmed: confirmedSchema,
      }),
      output: done,
    },
    rename: {
      input: z.object({
        sessionId,
        bucket: mongoGridFsBucketSchema,
        id: ejson,
        filename: z.string().min(1).max(1024),
        confirmed: confirmedSchema,
      }),
      output: done,
    },
  },

  users: {
    /** usersInfo on a database, optionally one user, with privileges when asked. */
    list: {
      input: z.object({
        sessionId,
        db,
        user: name.optional(),
        showPrivileges: z.boolean().optional(),
      }),
      output: z.array(mongoUserInfoSchema),
    },
    create: {
      input: z.object({
        sessionId,
        db,
        spec: mongoCreateUserSpecSchema,
        confirmed: confirmedSchema,
      }),
      output: done,
    },
    update: {
      input: z.object({
        sessionId,
        db,
        user: name,
        spec: mongoUpdateUserSpecSchema,
        confirmed: confirmedSchema,
      }),
      output: done,
    },
    /** Destructive: needs `confirmed`. */
    drop: {
      input: z.object({ sessionId, db, user: name, confirmed: confirmedSchema }),
      output: done,
    },
    grantRoles: {
      input: z.object({
        sessionId,
        db,
        user: name,
        roles: z.array(mongoRoleRefSchema).min(1),
        confirmed: confirmedSchema,
      }),
      output: done,
    },
    revokeRoles: {
      input: z.object({
        sessionId,
        db,
        user: name,
        roles: z.array(mongoRoleRefSchema).min(1),
        confirmed: confirmedSchema,
      }),
      output: done,
    },
  },

  roles: {
    list: {
      input: z.object({
        sessionId,
        db,
        role: name.optional(),
        showPrivileges: z.boolean().optional(),
        showBuiltinRoles: z.boolean().optional(),
      }),
      output: z.array(mongoRoleInfoSchema),
    },
    create: {
      input: z.object({ sessionId, db, spec: mongoRoleSpecSchema, confirmed: confirmedSchema }),
      output: done,
    },
    update: {
      input: z.object({
        sessionId,
        db,
        role: name,
        spec: z.object({
          privileges: z.array(mongoPrivilegeSchema).optional(),
          roles: z.array(mongoRoleRefSchema).optional(),
        }),
        confirmed: confirmedSchema,
      }),
      output: done,
    },
    /** Destructive: needs `confirmed`. */
    drop: {
      input: z.object({ sessionId, db, role: name, confirmed: confirmedSchema }),
      output: done,
    },
  },

  admin: {
    /** Operations in progress ($currentOp) as Extended JSON documents. */
    currentOp: {
      input: z.object({
        sessionId,
        filter: ejson.optional(),
        allUsers: z.boolean().optional(),
        idleConnections: z.boolean().optional(),
        limit: z.number().int().min(1).max(10_000).optional(),
      }),
      output: z.array(z.string()),
    },
    /** Kills an operation. Destructive: needs `confirmed`. */
    killOp: {
      input: z.object({
        sessionId,
        opid: z.union([z.number().int(), z.string().min(1).max(255)]),
        confirmed: confirmedSchema,
      }),
      output: done,
    },
    serverStatus: { input: mongoSessionRefSchema, output: mongoServerStatusSchema },
    /** Per-collection time and counts (mongod only). */
    top: { input: mongoSessionRefSchema, output: z.array(mongoTopEntrySchema) },
  },
} as const;

/**
 * The `mongo.*` namespace of the main contract: GridFS files moved by path (spec §9, GridFS
 * browser). Main checks the path against the window's file grants (read for an upload, write
 * for a download, as for jobs) and the profile's write rules, then the connection's host streams
 * the file; the bytes never pass through the renderer. Also the aggregation editor's saved
 * pipelines (saved queries of the local store) and exported text such as a JSON Schema.
 */
export const mongoMainContractShape = {
  gridfs: {
    /** Uploads a file picked with `dialogs.openFile`; returns the new file's _id (Extended JSON). */
    upload: {
      input: mongoGridFsUploadInputSchema,
      output: z.object({ id: z.string() }),
      progress: mongoGridFsTransferProgressSchema,
    },
    /** Downloads a file to where `dialogs.saveFile` pointed; returns the bytes written. */
    download: {
      input: mongoGridFsDownloadInputSchema,
      output: z.object({ bytes: z.number().int().nonnegative() }),
      progress: mongoGridFsTransferProgressSchema,
    },
  },
  /** Named pipelines per collection (spec §9, aggregation editor), ordered by name. */
  pipelines: {
    list: { input: mongoPipelineScopeSchema, output: z.array(mongoSavedPipelineSchema) },
    save: { input: mongoSavePipelineInputSchema, output: mongoSavedPipelineSchema },
    /** Unknown ids are ignored. */
    delete: { input: z.object({ id: idSchema }), output: done },
  },
  /**
   * Writes exported text (a JSON Schema, a validator) to a path this window picked with
   * `dialogs.saveFile`; returns the bytes written.
   */
  writeText: {
    input: mongoWriteTextInputSchema,
    output: z.object({ bytes: z.number().int().nonnegative() }),
  },
} as const;
