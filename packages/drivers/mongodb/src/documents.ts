import { DEFAULT_PAGE_SIZE, JoineryError } from '@joinery/core';
import {
  Int32,
  SchemaAnalyzer,
  buildStagePreview,
  isBsonDocument,
  toEjson,
  type BsonDocument,
  type DocumentPage,
  type ExplainTarget,
  type ExplainVerbosity,
  type FindQuery,
  type InsertManyResult,
  type InsertOneResult,
  type Namespace,
  type SchemaAnalysis,
  type StagePreview,
  type WriteSummary,
} from '@joinery/mongo-tools';
import type {
  AbstractCursor,
  ClientSession,
  CollationOptions,
  Document,
  Filter,
  FindOptions,
  Sort,
} from 'mongodb';

import {
  RAW_BSON,
  documentArg,
  documentsArg,
  driverDoc,
  ejson,
  hintArg,
  valueArg,
  type MongoContext,
} from './context';
import { normaliseExplain } from './explain';
import type {
  AggregateOptions,
  AnalyzeSchemaOptions,
  CursorOptions,
  ExplainResult,
  MongoOpOptions,
  PreviewStageOptions,
  UpdateManyOptions,
  WriteOptions,
} from './types';

/**
 * The document services of a MongoDB session (spec §9): find, count, aggregate with per-stage
 * preview, writes with dry runs and optimistic replace, explain and schema analysis. Inputs and
 * outputs are canonical Extended JSON; every call is bounded and cancellable.
 */

function pageSizeOf(opts: CursorOptions | undefined): number {
  return Math.max(1, Math.floor(opts?.pageSize ?? DEFAULT_PAGE_SIZE));
}

/** Pulls a cursor a page at a time; the cursor's batches follow the page size. */
async function* pages(
  cursor: AbstractCursor<Document>,
  size: number,
): AsyncGenerator<DocumentPage> {
  let documents: string[] = [];
  for await (const doc of cursor) {
    documents.push(ejson(doc));
    if (documents.length >= size) {
      yield { documents };
      documents = [];
    }
  }
  if (documents.length > 0) yield { documents };
}

function summary(partial: Partial<WriteSummary> & { dryRun: boolean }): WriteSummary {
  return { matchedCount: 0, modifiedCount: 0, deletedCount: 0, ...partial };
}

export function find(
  ctx: MongoContext,
  ns: Namespace,
  query: FindQuery,
  opts: CursorOptions = {},
): AsyncIterable<DocumentPage> {
  const size = pageSizeOf(opts);
  return ctx.stream(opts, async function* (exec) {
    const options: FindOptions = {
      session: exec.session,
      batchSize: size,
      ...ctx.maxTime({
        ...opts,
        ...(query.maxTimeMS !== undefined ? { maxTimeMS: query.maxTimeMS } : {}),
      }),
    };
    if (query.projection !== undefined)
      options.projection = documentArg(query.projection, 'projection');
    if (query.sort !== undefined) options.sort = driverDoc<Sort>(documentArg(query.sort, 'sort'));
    if (query.skip !== undefined) options.skip = query.skip;
    if (query.limit !== undefined) options.limit = query.limit;
    if (query.collation !== undefined) {
      options.collation = driverDoc<CollationOptions>(documentArg(query.collation, 'collation'));
    }
    const hint = hintArg(query.hint);
    if (hint !== undefined) options.hint = hint;
    const cursor = exec.track(
      ctx.collection(ns).find(documentArg(query.filter, 'filter'), options),
    );
    yield* pages(cursor, size);
  });
}

export function count(
  ctx: MongoContext,
  ns: Namespace,
  filter: string | undefined,
  opts: MongoOpOptions = {},
): Promise<number> {
  return ctx.run(opts, (exec) =>
    ctx.plainCollection(ns).countDocuments(documentArg(filter, 'filter'), {
      session: exec.session,
      ...ctx.maxTime(opts),
    }),
  );
}

export function estimatedCount(
  ctx: MongoContext,
  ns: Namespace,
  opts: MongoOpOptions = {},
): Promise<number> {
  // estimatedDocumentCount cannot run in a transaction; it reads collection metadata only.
  return ctx.run(opts, () => ctx.plainCollection(ns).estimatedDocumentCount(ctx.maxTime(opts)));
}

export function aggregate(
  ctx: MongoContext,
  ns: Namespace,
  pipeline: string,
  opts: AggregateOptions = {},
): AsyncIterable<DocumentPage> {
  const size = pageSizeOf(opts);
  return ctx.stream(opts, async function* (exec) {
    const stages = documentsArg(pipeline, 'pipeline');
    const hint = hintArg(opts.hint);
    const cursor = exec.track(
      ctx.collection(ns).aggregate(stages, {
        session: exec.session,
        batchSize: size,
        ...ctx.maxTime(opts),
        ...(opts.allowDiskUse !== undefined ? { allowDiskUse: opts.allowDiskUse } : {}),
        ...(opts.collation !== undefined
          ? { collation: driverDoc<CollationOptions>(documentArg(opts.collation, 'collation')) }
          : {}),
        ...(hint !== undefined ? { hint } : {}),
      }),
    );
    yield* pages(cursor, size);
  });
}

/**
 * Previews the documents after stage `stageIndex` (spec §9, per-stage preview on a sample):
 * disabled stages are skipped, the input is cut to a sample after any stage that must run first,
 * $out and $merge never run, and the whole preview is bounded by maxTimeMS (default 10 s).
 */
export function previewStage(
  ctx: MongoContext,
  ns: Namespace,
  pipeline: string,
  stageIndex: number,
  opts: PreviewStageOptions = {},
): Promise<StagePreview> {
  return ctx.run(opts, async (exec) => {
    const started = performance.now();
    const plan = buildStagePreview(documentsArg(pipeline, 'pipeline'), stageIndex, {
      ...(opts.sampleSize !== undefined ? { sampleSize: opts.sampleSize } : {}),
      ...(opts.sampling !== undefined ? { sampling: opts.sampling } : {}),
      ...(opts.disabled !== undefined ? { disabled: opts.disabled } : {}),
      ...(opts.limit !== undefined ? { outputLimit: opts.limit } : {}),
    });
    const cursor = exec.track(
      ctx.collection(ns).aggregate([...plan.pipeline], {
        session: exec.session,
        maxTimeMS: opts.maxTimeMS ?? ctx.queryTimeoutMs ?? 10_000,
      }),
    );
    const documents = (await cursor.toArray()).map((doc) => ejson(doc));
    return {
      documents,
      pipeline: toEjson(plan.pipeline),
      sampled: plan.sampled,
      skippedStages: plan.skippedStages,
      durationMs: Math.round(performance.now() - started),
    };
  });
}

export function insertOne(
  ctx: MongoContext,
  ns: Namespace,
  document: string,
  opts: MongoOpOptions = {},
): Promise<InsertOneResult> {
  return ctx.run(opts, async (exec) => {
    const doc = documentArg(document, 'document');
    const result = await ctx.plainCollection(ns).insertOne(doc, { session: exec.session });
    return { insertedId: toEjson(result.insertedId) };
  });
}

export function insertMany(
  ctx: MongoContext,
  ns: Namespace,
  documents: string,
  opts: MongoOpOptions & { readonly ordered?: boolean } = {},
): Promise<InsertManyResult> {
  return ctx.run(opts, async (exec) => {
    const docs = documentsArg(documents, 'document');
    const result = await ctx
      .plainCollection(ns)
      .insertMany(docs, { session: exec.session, ordered: opts.ordered ?? true });
    const ids = docs.map((_, i) => toEjson(result.insertedIds[i]));
    return { insertedCount: result.insertedCount, insertedIds: ids };
  });
}

/**
 * Replaces a document only while it still equals the version the user edited: the filter is
 * its _id plus `$expr: { $eq: ['$$ROOT', { $literal: original }] }`, so the check and the write
 * are one atomic operation. When nothing matched, the current version is read back for the
 * CONFLICT error (or NOT_FOUND when the document is gone).
 */
export function replaceOne(
  ctx: MongoContext,
  ns: Namespace,
  original: string,
  replacement: string,
  opts: MongoOpOptions = {},
): Promise<WriteSummary> {
  return ctx.run(opts, async (exec) => {
    const before = documentArg(original, 'original document');
    const after = documentArg(replacement, 'replacement document');
    if (!('_id' in before)) {
      throw new JoineryError({
        code: 'VALIDATION_FAILED',
        message: 'The edited document has no _id, so it cannot be replaced',
      });
    }
    if ('_id' in after && toEjson(after['_id']) !== toEjson(before['_id'])) {
      throw new JoineryError({
        code: 'VALIDATION_FAILED',
        message:
          'The _id of a document cannot change; insert a copy and delete the original instead',
      });
    }
    const result = await ctx.plainCollection(ns).replaceOne(
      driverDoc<Filter<Document>>({
        _id: before['_id']!,
        $expr: { $eq: ['$$ROOT', { $literal: before }] },
      }),
      after,
      { session: exec.session },
    );
    if (result.matchedCount === 1) {
      return summary({ dryRun: false, matchedCount: 1, modifiedCount: result.modifiedCount });
    }
    const current = await ctx
      .collection(ns)
      .findOne(driverDoc<Filter<Document>>({ _id: before['_id']! }), {
        session: exec.session,
      });
    if (current === null) {
      throw new JoineryError({
        code: 'NOT_FOUND',
        message: 'The document was deleted since it was read',
        hint: 'Refresh the results; insert it again if it is still needed',
      });
    }
    throw new JoineryError({
      code: 'CONFLICT',
      message: 'The document changed since it was read; it was not replaced',
      detail: ejson(current),
      hint: 'Review the current version and apply your edit to it',
    });
  });
}

function updateArg(text: string): BsonDocument | BsonDocument[] {
  const value = valueArg(text, 'update');
  if (Array.isArray(value)) {
    if (!value.every(isBsonDocument)) {
      throw new JoineryError({
        code: 'VALIDATION_FAILED',
        message: 'An update pipeline must be an array of stage documents',
      });
    }
    return value as BsonDocument[];
  }
  if (!isBsonDocument(value) || !Object.keys(value).every((key) => key.startsWith('$'))) {
    throw new JoineryError({
      code: 'VALIDATION_FAILED',
      message: 'The update must use update operators such as { $set: { ... } }, or be a pipeline',
      hint: 'To replace whole documents, edit them one at a time',
    });
  }
  return value;
}

export function updateMany(
  ctx: MongoContext,
  ns: Namespace,
  filter: string,
  update: string,
  opts: UpdateManyOptions = {},
): Promise<WriteSummary> {
  return ctx.run(opts, async (exec) => {
    const query = documentArg(filter, 'filter');
    const changes = updateArg(update);
    const collection = ctx.plainCollection(ns);
    const collation =
      opts.collation !== undefined
        ? { collation: driverDoc<CollationOptions>(documentArg(opts.collation, 'collation')) }
        : {};
    const hint = hintArg(opts.hint);
    if (opts.dryRun) {
      const matched = await collection.countDocuments(query, {
        session: exec.session,
        ...ctx.maxTime(opts),
        ...collation,
        ...(hint !== undefined ? { hint } : {}),
      });
      return summary({ dryRun: true, matchedCount: matched });
    }
    const result = await collection.updateMany(query, changes, {
      session: exec.session,
      ...collation,
      ...(hint !== undefined ? { hint } : {}),
      ...(opts.upsert !== undefined ? { upsert: opts.upsert } : {}),
      ...(opts.arrayFilters !== undefined
        ? { arrayFilters: documentsArg(opts.arrayFilters, 'array filter') }
        : {}),
    });
    return summary({
      dryRun: false,
      matchedCount: result.matchedCount,
      modifiedCount: result.modifiedCount,
      ...(result.upsertedId !== null && result.upsertedId !== undefined
        ? { upsertedId: toEjson(result.upsertedId) }
        : {}),
    });
  });
}

export function deleteOne(
  ctx: MongoContext,
  ns: Namespace,
  id: string,
  opts: WriteOptions = {},
): Promise<WriteSummary> {
  return ctx.run(opts, async (exec) => {
    const filter = driverDoc<Filter<Document>>({ _id: valueArg(id, '_id') });
    const collection = ctx.plainCollection(ns);
    if (opts.dryRun) {
      const matched = await collection.countDocuments(filter, { session: exec.session, limit: 1 });
      return summary({ dryRun: true, matchedCount: matched });
    }
    const result = await collection.deleteOne(filter, { session: exec.session });
    return summary({
      dryRun: false,
      matchedCount: result.deletedCount,
      deletedCount: result.deletedCount,
    });
  });
}

export function deleteMany(
  ctx: MongoContext,
  ns: Namespace,
  filter: string,
  opts: WriteOptions = {},
): Promise<WriteSummary> {
  return ctx.run(opts, async (exec) => {
    const query = documentArg(filter, 'filter');
    const collection = ctx.plainCollection(ns);
    if (opts.dryRun) {
      const matched = await collection.countDocuments(query, {
        session: exec.session,
        ...ctx.maxTime(opts),
      });
      return summary({ dryRun: true, matchedCount: matched });
    }
    const result = await collection.deleteMany(query, { session: exec.session });
    return summary({
      dryRun: false,
      matchedCount: result.deletedCount,
      deletedCount: result.deletedCount,
    });
  });
}

/** The command document for explaining a find query. */
export function findCommand(collection: string, query: FindQuery): BsonDocument {
  const command: BsonDocument = { find: collection, filter: documentArg(query.filter, 'filter') };
  if (query.projection !== undefined)
    command['projection'] = documentArg(query.projection, 'projection');
  if (query.sort !== undefined) command['sort'] = documentArg(query.sort, 'sort');
  if (query.skip !== undefined) command['skip'] = new Int32(query.skip);
  if (query.limit !== undefined) command['limit'] = new Int32(query.limit);
  if (query.collation !== undefined)
    command['collation'] = documentArg(query.collation, 'collation');
  const hint = hintArg(query.hint);
  if (hint !== undefined) command['hint'] = hint;
  if (query.maxTimeMS !== undefined) command['maxTimeMS'] = new Int32(query.maxTimeMS);
  return command;
}

/** Runs `explain` on a command document and normalises the output. */
export async function explainCommand(
  ctx: MongoContext,
  database: string,
  command: BsonDocument,
  verbosity: ExplainVerbosity,
  options: MongoOpOptions & { readonly session?: ClientSession },
): Promise<ExplainResult> {
  const raw = await ctx
    .db(database)
    .command(
      { explain: command, verbosity },
      { ...(options.session ? { session: options.session } : {}), ...ctx.maxTime(options) },
    );
  delete raw['$clusterTime'];
  delete raw['operationTime'];
  const { plan, summary: totals } = normaliseExplain(raw);
  return { plan, summary: totals, raw: ejson(raw) };
}

export function explainQuery(
  ctx: MongoContext,
  ns: Namespace,
  target: ExplainTarget,
  verbosity: ExplainVerbosity = 'queryPlanner',
  opts: MongoOpOptions = {},
): Promise<ExplainResult> {
  return ctx.run(opts, (exec) => {
    const command: BsonDocument =
      target.kind === 'find'
        ? findCommand(ns.collection, target.query)
        : {
            aggregate: ns.collection,
            pipeline: documentsArg(target.pipeline, 'pipeline'),
            cursor: {},
          };
    return explainCommand(ctx, ns.db, command, verbosity, { ...opts, session: exec.session });
  });
}

/**
 * Samples documents with $sample (after an optional filter) and analyses their structure with
 * mongo-tools' bounded analyzer: types, presence, top values and nesting per field path.
 */
export function analyzeSchema(
  ctx: MongoContext,
  ns: Namespace,
  opts: AnalyzeSchemaOptions = {},
): Promise<SchemaAnalysis> {
  return ctx.run(opts, async (exec) => {
    const size = Math.max(1, Math.min(Math.floor(opts.sampleSize ?? 1000), 100_000));
    const pipeline: Document[] = [];
    if (opts.filter !== undefined) pipeline.push({ $match: documentArg(opts.filter, 'filter') });
    pipeline.push({ $sample: { size } });
    const analyzer = new SchemaAnalyzer(opts);
    const cursor = exec.track(
      ctx.collection(ns).aggregate(pipeline, {
        session: exec.session,
        allowDiskUse: true,
        batchSize: 1000,
        ...ctx.maxTime(opts),
        ...RAW_BSON,
      }),
    );
    for await (const doc of cursor) analyzer.add(doc as BsonDocument);
    return analyzer.result();
  });
}
