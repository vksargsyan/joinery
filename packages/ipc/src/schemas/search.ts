import {
  HTTP_METHODS,
  type HttpMethod,
  type SearchAliasInfo,
  type SearchBulkItem,
  type SearchBulkResult,
  type SearchByQueryResult,
  type SearchCapabilities,
  type SearchClusterHealth,
  type SearchClusterInfo,
  type SearchDataStreamInfo,
  type SearchDocument,
  type SearchHit,
  type SearchIndexSummary,
  type SearchNodeSummary,
  type SearchPage,
  type SearchRequest,
  type SearchResponse,
  type SearchWriteResult,
} from '@joinery/search-tools';
import { z } from 'zod';

import { idSchema } from './common';

/**
 * Zod schemas for the Elasticsearch and OpenSearch module (spec §11), as its calls cross from
 * the renderer to the connection host. Documents, queries, mappings, settings and responses
 * are JSON text (ADR 0010), so nothing here holds a parsed document.
 *
 * Each result schema is annotated with its @joinery/search-tools wire type as both input and
 * output, so a drift between the driver's shapes and these schemas fails to compile.
 */

/** JSON text of a document, query, mapping, settings or response. */
const jsonTextSchema = z
  .string()
  .min(1)
  .max(100 * 1024 * 1024);
const nameSchema = z.string().min(1).max(512);
const countSchema = z.number().int().nonnegative();
const healthSchema = z.enum(['green', 'yellow', 'red']);

export const httpMethodSchema: z.ZodType<HttpMethod, HttpMethod> = z.enum(HTTP_METHODS);

export const searchRequestSchema: z.ZodType<SearchRequest, SearchRequest> = z.object({
  method: httpMethodSchema,
  path: z.string().min(1).max(8_192).startsWith('/'),
  query: z.string().max(8_192).optional(),
  body: z
    .string()
    .max(100 * 1024 * 1024)
    .optional(),
  bodyKind: z.enum(['json', 'ndjson']).optional(),
});

export const searchResponseSchema: z.ZodType<SearchResponse, SearchResponse> = z.object({
  status: z.number().int(),
  contentType: z.string(),
  body: z.string(),
  durationMs: z.number().nonnegative(),
  warnings: z.array(z.string()),
  truncated: z.boolean(),
});

export const searchCapabilitiesSchema: z.ZodType<SearchCapabilities, SearchCapabilities> = z.object(
  {
    esql: z.boolean(),
    sql: z.enum(['elasticsearch', 'opensearch']).nullable(),
    ppl: z.boolean(),
    dataStreams: z.boolean(),
    lifecycle: z.enum(['ilm', 'ism']).nullable(),
    pointInTime: z.boolean(),
    shardDocSort: z.boolean(),
    searchAfter: z.boolean(),
    asyncSearch: z.boolean(),
    composableTemplates: z.boolean(),
    security: z.enum(['elasticsearch', 'opensearch']).nullable(),
  },
);

export const searchClusterInfoSchema: z.ZodType<SearchClusterInfo, SearchClusterInfo> = z.object({
  distribution: z.enum(['elasticsearch', 'opensearch']),
  version: z.string(),
  clusterName: z.string(),
  clusterUuid: z.string().optional(),
  nodeName: z.string().optional(),
  buildFlavor: z.string().optional(),
  luceneVersion: z.string().optional(),
  license: z
    .object({ type: z.string(), status: z.string(), expiresAt: z.string().optional() })
    .optional(),
  plugins: z.array(z.string()),
  capabilities: searchCapabilitiesSchema,
});

export const searchClusterHealthSchema: z.ZodType<SearchClusterHealth, SearchClusterHealth> =
  z.object({
    clusterName: z.string(),
    status: healthSchema,
    timedOut: z.boolean(),
    nodes: countSchema,
    dataNodes: countSchema,
    activePrimaryShards: countSchema,
    activeShards: countSchema,
    relocatingShards: countSchema,
    initializingShards: countSchema,
    unassignedShards: countSchema,
    pendingTasks: countSchema,
    activeShardsPercent: z.number(),
  });

export const searchNodeSummarySchema: z.ZodType<SearchNodeSummary, SearchNodeSummary> = z.object({
  name: z.string(),
  ip: z.string(),
  roles: z.string(),
  master: z.boolean(),
  heapPercent: z.number().nullable(),
  ramPercent: z.number().nullable(),
  cpuPercent: z.number().nullable(),
  load1m: z.number().nullable(),
  diskUsedPercent: z.number().nullable(),
  version: z.string(),
});

export const searchIndexSummarySchema: z.ZodType<SearchIndexSummary, SearchIndexSummary> = z.object(
  {
    name: z.string(),
    uuid: z.string().optional(),
    health: healthSchema.nullable(),
    status: z.enum(['open', 'close']),
    primaries: countSchema,
    replicas: countSchema,
    docsCount: z.number().nullable(),
    docsDeleted: z.number().nullable(),
    storeSizeBytes: z.number().nullable(),
    primaryStoreSizeBytes: z.number().nullable(),
    createdAt: z.string().optional(),
  },
);

export const searchAliasInfoSchema: z.ZodType<SearchAliasInfo, SearchAliasInfo> = z.object({
  alias: z.string(),
  index: z.string(),
  filtered: z.boolean(),
  indexRouting: z.string().optional(),
  searchRouting: z.string().optional(),
  isWriteIndex: z.boolean().nullable(),
  hidden: z.boolean(),
});

export const searchDataStreamInfoSchema: z.ZodType<SearchDataStreamInfo, SearchDataStreamInfo> =
  z.object({
    name: z.string(),
    health: healthSchema.nullable(),
    generation: countSchema,
    indices: z.array(z.string()),
    template: z.string().optional(),
    lifecyclePolicy: z.string().optional(),
    timestampField: z.string(),
    hidden: z.boolean(),
    system: z.boolean(),
  });

export const searchHitSchema: z.ZodType<SearchHit, SearchHit> = z.object({
  index: z.string(),
  id: z.string(),
  score: z.number().nullable(),
  source: z.string().optional(),
  fields: z.string().optional(),
  highlight: z.string().optional(),
  sort: z.string().optional(),
  seqNo: z.number().int().optional(),
  primaryTerm: z.number().int().optional(),
  version: z.number().int().optional(),
  routing: z.string().optional(),
});

export const searchPageSchema: z.ZodType<SearchPage, SearchPage> = z.object({
  hits: z.array(searchHitSchema),
  total: z.object({ value: z.number(), relation: z.enum(['eq', 'gte']) }).optional(),
  took: z.number(),
  timedOut: z.boolean(),
  aggregations: z.string().optional(),
  paging: z.enum(['pit', 'scroll', 'single']),
});

export const searchDocumentSchema: z.ZodType<SearchDocument, SearchDocument> = z.object({
  index: z.string(),
  id: z.string(),
  found: z.boolean(),
  seqNo: z.number().int().optional(),
  primaryTerm: z.number().int().optional(),
  version: z.number().int().optional(),
  routing: z.string().optional(),
  source: z.string().optional(),
});

export const searchWriteResultSchema: z.ZodType<SearchWriteResult, SearchWriteResult> = z.object({
  index: z.string(),
  id: z.string(),
  result: z.string(),
  seqNo: z.number().int().optional(),
  primaryTerm: z.number().int().optional(),
  version: z.number().int().optional(),
});

const bulkItemSchema: z.ZodType<SearchBulkItem, SearchBulkItem> = z.object({
  action: z.enum(['index', 'create', 'update', 'delete']),
  index: z.string(),
  id: z.string().nullable(),
  status: z.number().int(),
  result: z.string().optional(),
  error: z.object({ type: z.string(), reason: z.string() }).optional(),
});

export const searchBulkResultSchema: z.ZodType<SearchBulkResult, SearchBulkResult> = z.object({
  took: z.number(),
  errors: z.boolean(),
  items: z.array(bulkItemSchema),
});

export const searchByQueryResultSchema: z.ZodType<SearchByQueryResult, SearchByQueryResult> =
  z.object({
    dryRun: z.boolean(),
    total: countSchema,
    deleted: countSchema,
    versionConflicts: countSchema,
    failures: countSchema,
    took: z.number(),
    timedOut: z.boolean(),
  });

// ---------------------------------------------------------------------------------------------
// Inputs. Every method names the session it runs on; writes carry the user's confirmation.

export const searchSessionRefSchema = z.object({ sessionId: idSchema });

/**
 * The page's confirmation of a write (spec §4): needed for destructive requests (index and
 * document deletes, close, delete by query, force merge) on every profile, and for every write
 * on production profiles and profiles that confirm writes. The connection host refuses writes
 * on read-only profiles whatever this says.
 */
export const searchConfirmedSchema = z.boolean().optional();

/** Cancellation and a time limit for calls that can take long. */
const operationFields = {
  executionId: idSchema.optional(),
  timeoutMs: z.number().int().positive().max(3_600_000).optional(),
};

const namesSchema = z.array(nameSchema).min(1).max(1_000);
const refreshSchema = z.union([z.boolean(), z.literal('wait_for')]);

const concurrencyFields = {
  ifSeqNo: z.number().int().nonnegative().optional(),
  ifPrimaryTerm: z.number().int().positive().optional(),
};

export const searchIndicesInputSchema = z.object({
  sessionId: idSchema,
  names: namesSchema,
  confirmed: searchConfirmedSchema,
  ...operationFields,
});

export const searchSearchInputSchema = z.object({
  sessionId: idSchema,
  /** Indices, aliases or data streams (a comma-separated list or pattern). */
  target: nameSchema,
  body: jsonTextSchema.optional(),
  /** Hits per page; default 100. */
  pageSize: z.number().int().min(1).max(10_000).optional(),
  maxHits: z.number().int().min(1).optional(),
  paging: z.enum(['auto', 'pit', 'scroll', 'single']).optional(),
  seqNoPrimaryTerm: z.boolean().optional(),
  ...operationFields,
});

export const searchIndexDocumentInputSchema = z.object({
  sessionId: idSchema,
  index: nameSchema,
  source: jsonTextSchema,
  id: nameSchema.optional(),
  opType: z.enum(['index', 'create']).optional(),
  pipeline: nameSchema.optional(),
  refresh: refreshSchema.optional(),
  routing: z.string().optional(),
  ...concurrencyFields,
  confirmed: searchConfirmedSchema,
});

export const searchUpdateDocumentInputSchema = z.object({
  sessionId: idSchema,
  index: nameSchema,
  id: nameSchema,
  doc: jsonTextSchema,
  refresh: refreshSchema.optional(),
  routing: z.string().optional(),
  ...concurrencyFields,
  confirmed: searchConfirmedSchema,
});

export const searchDeleteDocumentInputSchema = z.object({
  sessionId: idSchema,
  index: nameSchema,
  id: nameSchema,
  refresh: refreshSchema.optional(),
  routing: z.string().optional(),
  ...concurrencyFields,
  confirmed: searchConfirmedSchema,
});

export const searchBulkInputSchema = z.object({
  sessionId: idSchema,
  /** NDJSON lines (action and source lines). */
  ndjson: jsonTextSchema,
  index: nameSchema.optional(),
  refresh: refreshSchema.optional(),
  confirmed: searchConfirmedSchema,
  ...operationFields,
});

export const searchDeleteByQueryInputSchema = z.object({
  sessionId: idSchema,
  target: nameSchema,
  /** The query clause, e.g. {"term": {"status": "old"}}. */
  query: jsonTextSchema,
  /** Count the matching documents and delete nothing. */
  dryRun: z.boolean().optional(),
  refresh: z.boolean().optional(),
  conflicts: z.enum(['abort', 'proceed']).optional(),
  confirmed: searchConfirmedSchema,
  ...operationFields,
});

export const searchRequestInputSchema = z.object({
  sessionId: idSchema,
  request: searchRequestSchema,
  confirmed: searchConfirmedSchema,
  /** Bytes of response body to keep (default 32 MiB, at most 256 MiB). */
  maxBytes: z
    .number()
    .int()
    .positive()
    .max(256 * 1024 * 1024)
    .optional(),
  ...operationFields,
});
