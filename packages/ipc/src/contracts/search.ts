import { z } from 'zod';

import { idSchema } from '../schemas/common';
import {
  searchAliasInfoSchema,
  searchBulkInputSchema,
  searchBulkResultSchema,
  searchByQueryResultSchema,
  searchClusterHealthSchema,
  searchClusterInfoSchema,
  searchConfirmedSchema,
  searchDataStreamInfoSchema,
  searchDeleteByQueryInputSchema,
  searchDeleteDocumentInputSchema,
  searchDocumentSchema,
  searchIndexDocumentInputSchema,
  searchIndexSummarySchema,
  searchIndicesInputSchema,
  searchNodeSummarySchema,
  searchPageSchema,
  searchRequestInputSchema,
  searchResponseSchema,
  searchSearchInputSchema,
  searchSessionRefSchema,
  searchUpdateDocumentInputSchema,
  searchWriteResultSchema,
} from '../schemas/search';

/**
 * The `search.*` namespace of the connection host contract (spec §11): the services of an
 * Elasticsearch or OpenSearch session opened with `openSession`. Documents, queries, mappings,
 * settings and responses cross as JSON text. Paged searches are streams: pages are fetched as
 * the renderer pulls, and stopping early releases the point in time or scroll.
 *
 * Write rules (spec §4) are checked by the host whatever the page sends: a read-only profile
 * refuses every write with READ_ONLY (dry runs and reads still run); destructive requests
 * (index and document deletes, close, delete by query, force merge, bulk deletes) need
 * `confirmed` on every profile, and every write needs it on production profiles and profiles
 * that confirm writes (CONFIRMATION_REQUIRED otherwise). The console's `request` is classified
 * the same way. Engines other than Elasticsearch and OpenSearch answer NOT_SUPPORTED.
 *
 * Namespaces group the services, so later panels (templates, lifecycle, pipelines, snapshots,
 * tasks, SQL and ES|QL) add their own beside these.
 */

const sessionId = idSchema;
const name = z.string().min(1).max(512);
const done = z.void();
const json = z.string();

export const searchHostContractShape = {
  /** Distribution, version, licence, plugins and capability flags of the cluster. */
  clusterInfo: { input: searchSessionRefSchema, output: searchClusterInfoSchema },
  clusterHealth: {
    input: z.object({ sessionId, index: name.optional() }),
    output: searchClusterHealthSchema,
  },
  nodes: { input: searchSessionRefSchema, output: z.array(searchNodeSummarySchema) },
  /** `GET /_nodes/stats` (optionally some metrics) as JSON text. */
  nodeStats: {
    input: z.object({ sessionId, metrics: z.array(name).max(32).optional() }),
    output: json,
  },

  indices: {
    list: {
      input: z.object({
        sessionId,
        pattern: name.optional(),
        includeHidden: z.boolean().optional(),
      }),
      output: z.array(searchIndexSummarySchema),
    },
    /** Creates an index from the JSON of its settings, mappings and aliases. */
    create: {
      input: z.object({
        sessionId,
        name,
        body: json.optional(),
        confirmed: searchConfirmedSchema,
      }),
      output: done,
    },
    /** Destructive: needs `confirmed`. */
    delete: { input: searchIndicesInputSchema, output: done },
    open: { input: searchIndicesInputSchema, output: done },
    /** Destructive: needs `confirmed`. */
    close: { input: searchIndicesInputSchema, output: done },
    refresh: { input: searchIndicesInputSchema, output: done },
    flush: { input: searchIndicesInputSchema, output: done },
    /** Destructive: needs `confirmed`. */
    forceMerge: {
      input: searchIndicesInputSchema.extend({
        maxNumSegments: z.number().int().positive().optional(),
        onlyExpungeDeletes: z.boolean().optional(),
      }),
      output: done,
    },
    getMapping: { input: z.object({ sessionId, index: name }), output: json },
    putMapping: {
      input: z.object({ sessionId, index: name, body: json, confirmed: searchConfirmedSchema }),
      output: done,
    },
    getSettings: {
      input: z.object({
        sessionId,
        index: name,
        includeDefaults: z.boolean().optional(),
        flatSettings: z.boolean().optional(),
      }),
      output: json,
    },
    putSettings: {
      input: z.object({ sessionId, index: name, body: json, confirmed: searchConfirmedSchema }),
      output: done,
    },
  },

  aliases: {
    list: {
      input: z.object({ sessionId, includeHidden: z.boolean().optional() }),
      output: z.array(searchAliasInfoSchema),
    },
    /** `POST /_aliases` with `{"actions": [...]}`. */
    update: {
      input: z.object({ sessionId, actions: json, confirmed: searchConfirmedSchema }),
      output: done,
    },
  },

  dataStreams: {
    list: {
      input: z.object({ sessionId, includeHidden: z.boolean().optional() }),
      output: z.array(searchDataStreamInfoSchema),
    },
  },

  documents: {
    /** Streams the hits of a search a page at a time (point in time or scroll). */
    search: { input: searchSearchInputSchema, item: searchPageSchema },
    count: {
      input: z.object({
        sessionId,
        target: name,
        query: json.optional(),
        executionId: idSchema.optional(),
      }),
      output: z.object({ count: z.number().nonnegative() }),
    },
    /** Reads a document by id; `found: false` when it does not exist. */
    get: {
      input: z.object({ sessionId, index: name, id: name, routing: z.string().optional() }),
      output: searchDocumentSchema,
    },
    /**
     * Indexes a document; with `ifSeqNo`/`ifPrimaryTerm` only over that version (CONFLICT, whose
     * `detail` is the current document, when it changed).
     */
    index: { input: searchIndexDocumentInputSchema, output: searchWriteResultSchema },
    update: { input: searchUpdateDocumentInputSchema, output: searchWriteResultSchema },
    /** Destructive: needs `confirmed`. */
    delete: { input: searchDeleteDocumentInputSchema, output: searchWriteResultSchema },
    /** NDJSON to `_bulk`; destructive when it holds delete actions. */
    bulk: { input: searchBulkInputSchema, output: searchBulkResultSchema },
    /** Destructive unless `dryRun` (which only counts). */
    deleteByQuery: { input: searchDeleteByQueryInputSchema, output: searchByQueryResultSchema },
  },

  /**
   * The console's request: sent as written and answered whatever its status (the console shows
   * error bodies too); transport failures reject. Classified for the write rules by method and
   * path.
   */
  request: { input: searchRequestInputSchema, output: searchResponseSchema },
};
