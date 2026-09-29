import type { Session } from '@joinery/core';
import type {
  JsonText,
  SearchAliasInfo,
  SearchBulkResult,
  SearchByQueryResult,
  SearchCapabilities,
  SearchClusterHealth,
  SearchClusterInfo,
  SearchDataStreamInfo,
  SearchDistribution,
  SearchDocument,
  SearchIndexSummary,
  SearchNodeSummary,
  SearchPage,
  SearchRequest,
  SearchResponse,
  SearchWriteResult,
} from '@joinery/search-tools';

/** What every service call can take: cancellation and a time limit. */
export interface SearchOpOptions {
  readonly signal?: AbortSignal;
  /** Registers the call so `session.cancel(executionId)` stops it (and its server task). */
  readonly executionId?: string;
  /** Overrides the profile's query timeout for this call. */
  readonly timeoutMs?: number;
}

/** When a write becomes visible to search: at once, after the next refresh, or when refreshed. */
export type RefreshPolicy = boolean | 'wait_for';

export interface WriteOptions extends SearchOpOptions {
  readonly refresh?: RefreshPolicy;
  readonly routing?: string;
}

/** Optimistic concurrency: the write applies only to this version of the document. */
export interface ConcurrencyOptions {
  readonly ifSeqNo?: number;
  readonly ifPrimaryTerm?: number;
}

export interface IndexDocumentOptions extends WriteOptions, ConcurrencyOptions {
  /** The document id; the server assigns one when absent. */
  readonly id?: string;
  /** `create` fails with CONFLICT when the id exists; `index` (the default) replaces. */
  readonly opType?: 'index' | 'create';
  readonly pipeline?: string;
}

export interface SearchPagingOptions extends SearchOpOptions {
  /** Hits per page; default 100, at most 10,000. */
  readonly pageSize?: number;
  /** Stop after this many hits in all. */
  readonly maxHits?: number;
  /** Ask for each hit's `_seq_no` and `_primary_term` (for optimistic edits). Default true. */
  readonly seqNoPrimaryTerm?: boolean;
  /**
   * How to page past the first page: a point in time with search_after where the cluster
   * supports it, else a scroll (`auto`, the default); or one page only (`single`).
   */
  readonly paging?: 'auto' | 'pit' | 'scroll' | 'single';
  /** How long the point in time or scroll lives between pages; default "2m". */
  readonly keepAlive?: string;
}

export interface ListIndicesOptions extends SearchOpOptions {
  /** An index pattern, e.g. "logs-*"; all indices by default. */
  readonly pattern?: string;
  /** Include hidden indices (dot-prefixed system indices, data stream backing indices). */
  readonly includeHidden?: boolean;
}

export interface ForceMergeOptions extends SearchOpOptions {
  readonly maxNumSegments?: number;
  readonly onlyExpungeDeletes?: boolean;
  readonly flush?: boolean;
}

export interface GetSettingsOptions extends SearchOpOptions {
  readonly includeDefaults?: boolean;
  readonly flatSettings?: boolean;
}

export interface DeleteByQueryOptions extends SearchOpOptions {
  /** Count the matching documents and delete nothing. */
  readonly dryRun?: boolean;
  readonly refresh?: boolean;
  /** `proceed` skips version conflicts instead of stopping at the first. */
  readonly conflicts?: 'abort' | 'proceed';
}

export interface RequestOptions extends SearchOpOptions {
  /** Bytes of response body to keep; longer ones are cut and flagged. Default 32 MiB. */
  readonly maxBytes?: number;
}

/**
 * An Elasticsearch or OpenSearch session: the generic Session contract (`execute` runs Kibana
 * console text, one result set per request with the JSON response) plus the services the
 * module needs (spec §11). Documents, queries, mappings and settings go in and come out as JSON
 * text. Every call takes a signal and an execution id for `cancel`.
 *
 * Services are grouped so later panels (templates, lifecycle, pipelines, snapshots, tasks,
 * SQL and ES|QL) add methods beside these without changing them.
 */
export interface SearchSession extends Session {
  readonly engine: 'elasticsearch' | 'opensearch';
  /** What the server is, which may differ from the profile's engine. */
  readonly distribution: SearchDistribution;
  readonly searchCapabilities: SearchCapabilities;

  // Cluster
  clusterInfo(opts?: SearchOpOptions): Promise<SearchClusterInfo>;
  clusterHealth(
    opts?: SearchOpOptions & {
      readonly index?: string;
      readonly waitForStatus?: 'green' | 'yellow';
    },
  ): Promise<SearchClusterHealth>;
  nodes(opts?: SearchOpOptions): Promise<SearchNodeSummary[]>;
  /** `GET /_nodes/stats` (optionally some metrics), as JSON text. */
  nodeStats(opts?: SearchOpOptions & { readonly metrics?: readonly string[] }): Promise<JsonText>;

  // Indices
  listIndices(opts?: ListIndicesOptions): Promise<SearchIndexSummary[]>;
  /** Creates an index; `body` is the JSON of its settings, mappings and aliases. */
  createIndex(name: string, body?: JsonText, opts?: SearchOpOptions): Promise<void>;
  deleteIndices(names: readonly string[], opts?: SearchOpOptions): Promise<void>;
  openIndices(names: readonly string[], opts?: SearchOpOptions): Promise<void>;
  closeIndices(names: readonly string[], opts?: SearchOpOptions): Promise<void>;
  refresh(names: readonly string[], opts?: SearchOpOptions): Promise<void>;
  flush(names: readonly string[], opts?: SearchOpOptions): Promise<void>;
  forceMerge(names: readonly string[], opts?: ForceMergeOptions): Promise<void>;
  /** `GET /<index>/_mapping` as JSON text. */
  getMapping(index: string, opts?: SearchOpOptions): Promise<JsonText>;
  /** Adds fields to a mapping (existing field mappings cannot change). */
  putMapping(index: string, body: JsonText, opts?: SearchOpOptions): Promise<void>;
  getSettings(index: string, opts?: GetSettingsOptions): Promise<JsonText>;
  putSettings(index: string, body: JsonText, opts?: SearchOpOptions): Promise<void>;

  // Aliases and data streams
  listAliases(
    opts?: SearchOpOptions & { readonly includeHidden?: boolean },
  ): Promise<SearchAliasInfo[]>;
  /** `POST /_aliases` with `{"actions": [...]}` (JSON text). */
  updateAliases(actions: JsonText, opts?: SearchOpOptions): Promise<void>;
  listDataStreams(
    opts?: SearchOpOptions & { readonly includeHidden?: boolean },
  ): Promise<SearchDataStreamInfo[]>;

  // Documents
  /**
   * Streams the hits of a search a page at a time: `body` is a search body (query, sort,
   * _source, aggregations...) as JSON text. Deep pages use a point in time with search_after
   * (a `_shard_doc` tiebreaker is added to the sort), or a scroll where points in time are not
   * available; both are released when the iteration ends.
   */
  search(target: string, body?: JsonText, opts?: SearchPagingOptions): AsyncIterable<SearchPage>;
  count(target: string, query?: JsonText, opts?: SearchOpOptions): Promise<number>;
  /** Reads a document by id; `found: false` when it does not exist (no error). */
  getDocument(
    index: string,
    id: string,
    opts?: SearchOpOptions & { readonly routing?: string },
  ): Promise<SearchDocument>;
  /**
   * Indexes a document. With `ifSeqNo`/`ifPrimaryTerm` it applies only to that version, and a
   * changed document fails with CONFLICT whose `detail` is the current document (JSON text).
   */
  indexDocument(
    index: string,
    source: JsonText,
    opts?: IndexDocumentOptions,
  ): Promise<SearchWriteResult>;
  /** Merges `doc` (JSON text of the fields to change) into the document. */
  updateDocument(
    index: string,
    id: string,
    doc: JsonText,
    opts?: WriteOptions & ConcurrencyOptions,
  ): Promise<SearchWriteResult>;
  deleteDocument(
    index: string,
    id: string,
    opts?: WriteOptions & ConcurrencyOptions,
  ): Promise<SearchWriteResult>;
  /** Sends NDJSON to `_bulk` (optionally with a default index). */
  bulk(
    ndjson: string,
    opts?: WriteOptions & { readonly index?: string },
  ): Promise<SearchBulkResult>;
  /** Deletes the documents a query matches, or counts them (`dryRun`). */
  deleteByQuery(
    target: string,
    query: JsonText,
    opts?: DeleteByQueryOptions,
  ): Promise<SearchByQueryResult>;

  /**
   * Sends one request as the console writes it and returns the response whatever its status
   * (the console shows error bodies too). Transport failures throw.
   */
  request(request: SearchRequest, opts?: RequestOptions): Promise<SearchResponse>;
}
