import type { SearchCapabilities, SearchDistribution } from './capabilities';
import type { HttpMethod } from './console/parser';

/**
 * The Elasticsearch and OpenSearch module's wire types (spec §11): what the driver's services
 * return and what crosses from the connection host to the renderer. Documents, mappings,
 * settings, queries and raw responses are JSON text, never parsed values, so large integers and
 * the server's formatting survive every process boundary (ADR 0010). Everything else is plain
 * structured-clone-safe data.
 */

/** JSON text: a document `_source`, a query body, a mapping, a raw response. */
export type JsonText = string;

/** One HTTP request, as the console and `request` send it. */
export interface SearchRequest {
  readonly method: HttpMethod;
  /** The path with a leading slash, e.g. "/orders/_search"; percent-encoded where needed. */
  readonly path: string;
  /** The query string without "?", e.g. "size=5&pretty". */
  readonly query?: string;
  /** JSON text, or NDJSON lines each ending in "\n". */
  readonly body?: string;
  /** How the body is sent: application/json (the default) or application/x-ndjson. */
  readonly bodyKind?: 'json' | 'ndjson';
}

/** The server's answer to a SearchRequest, whatever its status. */
export interface SearchResponse {
  readonly status: number;
  /** The media type of the body, e.g. "application/json" or "text/plain". */
  readonly contentType: string;
  /** The body as text (empty for HEAD). */
  readonly body: string;
  readonly durationMs: number;
  /** Deprecation and other warnings from the `Warning` headers. */
  readonly warnings: readonly string[];
  /** The body was longer than the size limit and was cut. */
  readonly truncated: boolean;
}

/** `GET /` plus the licence and plugins: what the cluster is. */
export interface SearchClusterInfo {
  readonly distribution: SearchDistribution;
  /** e.g. "9.4.0". */
  readonly version: string;
  readonly clusterName: string;
  readonly clusterUuid?: string;
  /** The node that answered. */
  readonly nodeName?: string;
  /** Elasticsearch's build flavour ("default" or "oss"). */
  readonly buildFlavor?: string;
  readonly luceneVersion?: string;
  /** Elasticsearch's licence, when the user may read it. */
  readonly license?: {
    readonly type: string;
    readonly status: string;
    /** ISO timestamp; absent for licences that never expire. */
    readonly expiresAt?: string;
  };
  /** Installed plugin components (distinct), when the user may list them. */
  readonly plugins: readonly string[];
  readonly capabilities: SearchCapabilities;
}

export type SearchHealthStatus = 'green' | 'yellow' | 'red';

/** `GET /_cluster/health`. */
export interface SearchClusterHealth {
  readonly clusterName: string;
  readonly status: SearchHealthStatus;
  readonly timedOut: boolean;
  readonly nodes: number;
  readonly dataNodes: number;
  readonly activePrimaryShards: number;
  readonly activeShards: number;
  readonly relocatingShards: number;
  readonly initializingShards: number;
  readonly unassignedShards: number;
  readonly pendingTasks: number;
  readonly activeShardsPercent: number;
}

/** One node from `_cat/nodes`. Percentages are null when the node does not report them. */
export interface SearchNodeSummary {
  readonly name: string;
  readonly ip: string;
  /** Role letters as _cat prints them, e.g. "cdfhilmrstw". */
  readonly roles: string;
  /** The elected master (cluster manager). */
  readonly master: boolean;
  readonly heapPercent: number | null;
  readonly ramPercent: number | null;
  readonly cpuPercent: number | null;
  readonly load1m: number | null;
  readonly diskUsedPercent: number | null;
  readonly version: string;
}

/** One index from `_cat/indices`. */
export interface SearchIndexSummary {
  readonly name: string;
  readonly uuid?: string;
  /** Closed indices may report no health. */
  readonly health: SearchHealthStatus | null;
  readonly status: 'open' | 'close';
  readonly primaries: number;
  readonly replicas: number;
  readonly docsCount: number | null;
  readonly docsDeleted: number | null;
  readonly storeSizeBytes: number | null;
  readonly primaryStoreSizeBytes: number | null;
  /** ISO timestamp. */
  readonly createdAt?: string;
}

/** One alias of one index. */
export interface SearchAliasInfo {
  readonly alias: string;
  readonly index: string;
  /** The alias filters the documents it shows. */
  readonly filtered: boolean;
  readonly indexRouting?: string;
  readonly searchRouting?: string;
  /** null when the alias leaves it unset. */
  readonly isWriteIndex: boolean | null;
  readonly hidden: boolean;
}

/** One data stream from `GET /_data_stream`. */
export interface SearchDataStreamInfo {
  readonly name: string;
  readonly health: SearchHealthStatus | null;
  readonly generation: number;
  /** Backing indices, oldest first. */
  readonly indices: readonly string[];
  readonly template?: string;
  readonly lifecyclePolicy?: string;
  readonly timestampField: string;
  readonly hidden: boolean;
  readonly system: boolean;
}

/** One hit of a search. JSON parts are text, exactly as the server sent them. */
export interface SearchHit {
  readonly index: string;
  readonly id: string;
  readonly score: number | null;
  readonly source?: JsonText;
  /** The `fields` section (docvalue and stored fields). */
  readonly fields?: JsonText;
  readonly highlight?: JsonText;
  /** The sort values (a JSON array): the search_after key of the hit. */
  readonly sort?: JsonText;
  readonly seqNo?: number;
  readonly primaryTerm?: number;
  readonly version?: number;
  readonly routing?: string;
}

/** One page of a paged search (see the driver's `search`). */
export interface SearchPage {
  readonly hits: readonly SearchHit[];
  /** The total on the first page (a lower bound when `relation` is "gte"). */
  readonly total?: { readonly value: number; readonly relation: 'eq' | 'gte' };
  readonly took: number;
  readonly timedOut: boolean;
  /** Aggregation results (JSON text), on the first page only. */
  readonly aggregations?: JsonText;
  /** How the pages are read: a point in time with search_after, a scroll, or one page. */
  readonly paging: 'pit' | 'scroll' | 'single';
}

/** A document read by id. */
export interface SearchDocument {
  readonly index: string;
  readonly id: string;
  readonly found: boolean;
  readonly seqNo?: number;
  readonly primaryTerm?: number;
  readonly version?: number;
  readonly routing?: string;
  readonly source?: JsonText;
}

/** The outcome of indexing, updating or deleting one document. */
export interface SearchWriteResult {
  readonly index: string;
  readonly id: string;
  /** "created", "updated", "deleted", "noop" or "not_found". */
  readonly result: string;
  readonly seqNo?: number;
  readonly primaryTerm?: number;
  readonly version?: number;
}

/** One item of a bulk request's reply. */
export interface SearchBulkItem {
  readonly action: 'index' | 'create' | 'update' | 'delete';
  readonly index: string;
  readonly id: string | null;
  readonly status: number;
  readonly result?: string;
  readonly error?: { readonly type: string; readonly reason: string };
}

export interface SearchBulkResult {
  readonly took: number;
  /** At least one item failed. */
  readonly errors: boolean;
  readonly items: readonly SearchBulkItem[];
}

/** The outcome of a delete-by-query (or its dry run, which only counts). */
export interface SearchByQueryResult {
  readonly dryRun: boolean;
  /** Documents matched. */
  readonly total: number;
  readonly deleted: number;
  readonly versionConflicts: number;
  readonly failures: number;
  readonly took: number;
  readonly timedOut: boolean;
}

/** A server task (reindex, update or delete by query...) as `GET /_tasks/<id>` reports it. */
export interface SearchTaskStatus {
  /** "node:number". */
  readonly id: string;
  /** e.g. "indices:data/write/reindex". */
  readonly action: string;
  readonly description?: string;
  readonly completed: boolean;
  readonly cancellable: boolean;
  readonly cancelled: boolean;
  /** ISO timestamp. */
  readonly startedAt?: string;
  readonly runningTimeMs?: number;
  /** Progress of a by-query or reindex task (the `status` object). */
  readonly progress?: {
    readonly total: number;
    readonly created: number;
    readonly updated: number;
    readonly deleted: number;
    readonly noops: number;
    readonly versionConflicts: number;
    readonly batches: number;
  };
  /** Failures reported in the finished task's response. */
  readonly failures: number;
  /** The first failure's or the task error's reason. */
  readonly error?: string;
}

/** One shard copy from `_cat/shards`. */
export interface SearchShardInfo {
  readonly index: string;
  readonly shard: number;
  readonly primary: boolean;
  /** "STARTED", "INITIALIZING", "RELOCATING" or "UNASSIGNED". */
  readonly state: string;
  readonly node: string | null;
  readonly docs: number | null;
  readonly storeBytes: number | null;
  /** Why an unassigned shard is unassigned ("NODE_LEFT", "INDEX_CREATED"...). */
  readonly unassignedReason?: string;
}

/** A node's decision in an allocation explanation. */
export interface SearchAllocationDecision {
  readonly node: string;
  /** "yes", "no", "throttle", "worse_balance"... */
  readonly decision: string;
  /** The deciders that said no or throttle, as "decider: explanation". */
  readonly reasons: readonly string[];
}

/** `POST /_cluster/allocation/explain`, summarised, with the raw reply. */
export interface SearchAllocationExplain {
  readonly index: string;
  readonly shard: number;
  readonly primary: boolean;
  readonly currentState: string;
  readonly currentNode?: string;
  /** The one-line explanation the server gives (allocate or rebalance explanation). */
  readonly explanation?: string;
  /** "yes", "no", "throttled", "awaiting_info", "no_valid_shard_copy"... */
  readonly canAllocate?: string;
  readonly unassignedReason?: string;
  readonly unassignedDetails?: string;
  readonly decisions: readonly SearchAllocationDecision[];
  readonly raw: JsonText;
}

/** One node's disk as `_cat/allocation` reports it. */
export interface SearchNodeDisk {
  readonly node: string;
  readonly shards: number;
  readonly diskUsedBytes: number | null;
  readonly diskAvailableBytes: number | null;
  readonly diskTotalBytes: number | null;
  readonly diskPercent: number | null;
}

/** Disk watermarks and each node's disk, for the allocation view. */
export interface SearchDiskAllocation {
  /** `cluster.routing.allocation.disk.threshold_enabled`. */
  readonly thresholdEnabled: boolean;
  /** The watermark settings as set (e.g. "85%", "0.9", "500mb"). */
  readonly low: string;
  readonly high: string;
  readonly floodStage: string;
  /**
   * Elasticsearch 8.5+: on large disks a percentage watermark applies only until this much
   * space is free (e.g. flood stage at 95% or 100GB free, whichever leaves less).
   */
  readonly maxHeadroom?: {
    readonly low?: string;
    readonly high?: string;
    readonly floodStage?: string;
  };
  readonly nodes: readonly SearchNodeDisk[];
  /** Shards no node holds. */
  readonly unassignedShards: number;
}

/** The named JSON objects the admin panels edit. */
export const SEARCH_RESOURCE_KINDS = [
  'index-template',
  'component-template',
  'legacy-template',
  'lifecycle-policy',
  'ingest-pipeline',
  'snapshot-repository',
] as const;
export type SearchResourceKind = (typeof SEARCH_RESOURCE_KINDS)[number];

/** One named resource: a template, lifecycle policy, ingest pipeline or snapshot repository. */
export interface SearchResourceInfo {
  readonly kind: SearchResourceKind;
  readonly name: string;
  /** A few facts for the list ("index patterns", "priority", "phases"...), in display order. */
  readonly summary: readonly { readonly label: string; readonly value: string }[];
  /** The JSON its PUT takes, as the server holds it (read-only fields removed). */
  readonly body: JsonText;
  /** OpenSearch ISM policies are updated with optimistic concurrency. */
  readonly seqNo?: number;
  readonly primaryTerm?: number;
}

/** One snapshot of a repository. */
export interface SearchSnapshotInfo {
  readonly snapshot: string;
  readonly uuid?: string;
  /** "SUCCESS", "IN_PROGRESS", "PARTIAL", "FAILED", "INCOMPATIBLE". */
  readonly state: string;
  readonly indices: readonly string[];
  readonly dataStreams: readonly string[];
  /** ISO timestamps. */
  readonly startedAt?: string;
  readonly endedAt?: string;
  readonly durationMs?: number;
  readonly shardsTotal: number;
  readonly shardsFailed: number;
}

/** One processor's result in a verbose pipeline simulation. */
export interface SearchSimulatedProcessor {
  readonly processor: string;
  readonly tag?: string;
  /** "success", "error", "error_ignored", "skipped", "dropped". */
  readonly status: string;
  readonly error?: string;
  /** The document after this processor (`_source`, JSON text). */
  readonly source?: JsonText;
}

/** One document's way through a simulated ingest pipeline. */
export interface SearchSimulatedDocument {
  /** The document after the pipeline (its `_source`, JSON text), when it came through. */
  readonly source?: JsonText;
  /** Why the pipeline failed. */
  readonly error?: string;
  /** A drop processor removed it. */
  readonly dropped: boolean;
  /** With verbose simulation: each processor's result, in order. */
  readonly processors: readonly SearchSimulatedProcessor[];
}
