import type { Capabilities, ExplainFormat } from './capabilities';
import type { EngineId } from './engines';
import type { ConnectionProfile } from './profile';
import type { ExecOptions, QueryParams, ResultChunk } from './results';
import type { SchemaObjectKind, SchemaSnapshot } from './schema';

/**
 * The driver adapter contract (spec §3). Every engine sits behind it; the connection host, the
 * job runner, joinery-cli and the tests all drive engines through it and nothing else.
 */

/**
 * A profile with its secrets unsealed. Exists only inside the connection host or the CLI:
 * the renderer never sees one.
 */
export interface ResolvedProfile {
  readonly profile: ConnectionProfile;
  /** Unsealed secret values keyed by SecretRef.id. */
  readonly secrets: Readonly<Record<string, string>>;
  /** Set by the tunnel layer: connect here instead of the profile endpoint (SSH local forward). */
  readonly endpointOverride?: { readonly host: string; readonly port: number };
}

export interface IntrospectScope {
  /** Database to introspect; defaults to the session's current database. */
  readonly database?: string;
  /** PostgreSQL schemas to include; defaults to every non-system schema. */
  readonly schemas?: readonly string[];
  /** Object kinds to include; defaults to all. */
  readonly include?: readonly SchemaObjectKind[];
}

export const BROWSE_NODE_KINDS = [
  'database',
  'schema',
  'folder',
  'table',
  'partition',
  'view',
  'materialized-view',
  'function',
  'procedure',
  'trigger',
  'event',
  'sequence',
  'type',
  'extension',
  'foreign-table',
  'user',
  'role',
  'column',
  'index',
  'collection',
  /** MongoDB time series collection. */
  'time-series',
  /** MongoDB GridFS bucket (its `.files` and `.chunks` collections shown as one node). */
  'gridfs-bucket',
  /** A Redis key-name prefix: one level of the namespace tree split on the delimiter. */
  'namespace',
  'key',
  /** A cluster node or shard (Redis Cluster primary, MongoDB shard). */
  'node',
  /** An Elasticsearch / OpenSearch data stream. */
  'data-stream',
  /** An Elasticsearch / OpenSearch alias. */
  'alias',
  'other',
] as const;
export type BrowseNodeKind = (typeof BROWSE_NODE_KINDS)[number];

/** One node of the lazily loaded object explorer tree (spec §5). */
export interface BrowseNode {
  readonly kind: BrowseNodeKind;
  readonly name: string;
  /** Path from the root, including this node's own segment; pass it back to `browse` to expand. */
  readonly path: readonly string[];
  readonly hasChildren: boolean;
  /** Extra columns for the object list pane: row estimate, sizes, engine, comment... */
  readonly detail?: Readonly<Record<string, string | number | null>>;
}

export interface ExplainOptions {
  readonly format?: ExplainFormat;
  /** Actually run the statement (EXPLAIN ANALYZE). Callers must apply the write safety check. */
  readonly analyze?: boolean;
  readonly buffers?: boolean;
  readonly params?: QueryParams;
}

/**
 * A normalised plan node for the visual explain tree (spec §6). Row counts and times are per
 * loop, as PostgreSQL reports them; multiply by `loops` for the node's total.
 */
export interface PlanNode {
  readonly id: string;
  /** e.g. "Seq Scan", "Hash Join", "table scan". */
  readonly operation: string;
  readonly relation?: string;
  readonly index?: string;
  readonly startupCost?: number;
  readonly totalCost?: number;
  readonly estimatedRows?: number;
  readonly actualRows?: number;
  readonly actualTimeMs?: number;
  readonly loops?: number;
  readonly detail: Readonly<Record<string, string | number | boolean | null>>;
  readonly children: readonly PlanNode[];
}

/**
 * A plan with the server's own EXPLAIN output next to it, for the visual explain's raw view
 * (spec §6): the tree is normalised, `raw` is exactly what the server printed.
 */
export interface ExplainResult {
  readonly plan: PlanNode;
  /** EXPLAIN JSON text, or MySQL's EXPLAIN ANALYZE tree text. */
  readonly raw: string;
  readonly rawFormat: 'json' | 'text';
  /** The statement was executed (ANALYZE) inside a transaction or savepoint rolled back after. */
  readonly rolledBack: boolean;
}

export interface Session {
  readonly engine: EngineId;
  /** The server's version banner, e.g. "16.4" or "10.11.6-MariaDB". */
  readonly serverVersion: string;
  capabilities(): Capabilities;

  /**
   * Runs exactly one statement (callers split scripts with @joinery/sql-tools) and streams
   * its results. See ResultChunk for the event order and cursor semantics.
   */
  execute(text: string, opts: ExecOptions): AsyncIterable<ResultChunk>;
  /** Cancels a running execution from a separate control connection. No-op if it finished. */
  cancel(executionId: string): Promise<void>;

  introspect(scope?: IntrospectScope): Promise<SchemaSnapshot>;
  /** Children of a tree node; `[]` lists the root level (databases). */
  browse(path: readonly string[]): Promise<BrowseNode[]>;
  explain?(text: string, opts?: ExplainOptions): Promise<PlanNode>;
  /** `explain` plus the server's raw output; engines with `explain` should offer both. */
  explainPlan?(text: string, opts?: ExplainOptions): Promise<ExplainResult>;

  begin?(): Promise<void>;
  commit?(): Promise<void>;
  rollback?(): Promise<void>;
  /** True while an explicit transaction is open on this session. */
  readonly inTransaction: boolean;

  /** Switches the session's current database (MySQL USE) or search_path schema. */
  useDatabase?(name: string): Promise<void>;
  ping(): Promise<void>;
  close(): Promise<void>;
}

export interface DriverAdapter {
  readonly engine: EngineId;
  /** Capabilities for a server version, before connecting. Sessions refine them. */
  capabilities(serverVersion?: string): Capabilities;
  connect(profile: ResolvedProfile): Promise<Session>;
  /** Test Connection (spec §4): runs the steps in order and stops at the first failure. */
  checkConnection?(profile: ResolvedProfile): AsyncIterable<ConnectionCheckResult>;
}

/** Test Connection steps, in order (spec §4). */
export const CONNECTION_CHECK_STEPS = [
  'dns',
  'tcp',
  'ssh',
  'tls',
  'auth',
  'ping',
  'version',
] as const;
export type ConnectionCheckStep = (typeof CONNECTION_CHECK_STEPS)[number];

export interface ConnectionCheckResult {
  readonly step: ConnectionCheckStep;
  readonly status: 'ok' | 'failed' | 'skipped';
  readonly durationMs: number;
  readonly message?: string;
  /** A fix hint for the failing step. */
  readonly hint?: string;
}
