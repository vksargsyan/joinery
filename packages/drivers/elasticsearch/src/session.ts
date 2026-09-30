import {
  capabilitiesFor,
  type BrowseNode,
  type Capabilities,
  type ExecOptions,
  type IntrospectScope,
  type ResolvedProfile,
  type ResultChunk,
  type SchemaSnapshot,
  type Session,
} from '@joinery/core';
import type {
  SearchAliasInfo,
  SearchBulkResult,
  SearchByQueryResult,
  SearchCapabilities,
  SearchClusterHealth,
  SearchClusterInfo,
  SearchDataStreamInfo,
  SearchDocument,
  SearchIndexSummary,
  SearchNodeSummary,
  SearchPage,
  SearchRequest,
  SearchResponse,
  SearchWriteResult,
  SearchAllocationExplain,
  SearchDiskAllocation,
  SearchResourceInfo,
  SearchResourceKind,
  SearchShardInfo,
  SearchSimulatedDocument,
  SearchSnapshotInfo,
  SearchTable,
  SearchTaskStatus,
} from '@joinery/search-tools';

import * as admin from './admin';
import { browseSearch } from './browse';
import * as cluster from './cluster';
import { buildSearchClientPlan, type SearchClientPlan } from './config';
import { SearchContext } from './context';
import * as documents from './documents';
import { mapTransportError } from './errors';
import { executeConsole, sendRequest } from './execute';
import { SearchHttpClient } from './http';
import * as indices from './indices';
import { introspectSearch } from './introspect';
import { sniffNodes } from './sniff';
import * as sql from './sql';
import type {
  ConcurrencyOptions,
  DeleteByQueryOptions,
  ForceMergeOptions,
  GetSettingsOptions,
  IndexDocumentOptions,
  ListIndicesOptions,
  ReindexOptions,
  RequestOptions,
  ResizeOptions,
  SearchOpOptions,
  SearchPagingOptions,
  SearchSession,
  SimulatePipelineOptions,
  SnapshotCreateOptions,
  SnapshotRestoreOptions,
  SqlQueryOptions,
  SqlTranslation,
  WriteOptions,
} from './types';

/** Core capabilities of a search cluster: cancellable requests, a cluster of nodes. */
export function searchCoreCapabilities(serverVersion?: string): Capabilities {
  return capabilitiesFor('elasticsearch', serverVersion);
}

/** Narrows a Session to the Elasticsearch session with its services. */
export function isSearchSession(session: Session): session is SearchSession {
  return session.engine === 'elasticsearch' && session instanceof ElasticSearchSession;
}

/**
 * One Elasticsearch "connection": an HTTP client over the profile's nodes (a
 * keep-alive agent each) behind the Session contract, plus the services of SearchSession. HTTP
 * has no session state, so calls run concurrently; `cancel` aborts a call's request and
 * cancels the server tasks it started.
 */
export class ElasticSearchSession implements SearchSession {
  readonly engine = 'elasticsearch';
  readonly inTransaction = false;

  private constructor(
    private readonly ctx: SearchContext,
    readonly serverVersion: string,
    private readonly clusterName: string,
  ) {}

  /** Connects: `GET /` (proves the URL and the credentials), then sniffing. */
  static async open(resolved: ResolvedProfile): Promise<ElasticSearchSession> {
    const plan: SearchClientPlan = buildSearchClientPlan(resolved);
    const http = new SearchHttpClient(plan);
    const errorContext = {
      where: plan.where,
      secrets: plan.secrets,
      authMethod: plan.authMethod,
      ...(plan.user !== undefined ? { user: plan.user } : {}),
    };
    try {
      const { root, facts } = await cluster.detectServer(http, errorContext);
      if (plan.sniff) await sniffNodes(http, resolved).catch(() => undefined);
      const ctx = new SearchContext(http, plan, facts);
      return new ElasticSearchSession(ctx, root.version, root.clusterName);
    } catch (error) {
      http.close();
      throw mapTransportError(error, errorContext);
    }
  }

  get searchCapabilities(): SearchCapabilities {
    return this.ctx.facts.capabilities;
  }

  capabilities(): Capabilities {
    return searchCoreCapabilities(this.serverVersion || undefined);
  }

  execute(text: string, opts: ExecOptions): AsyncIterable<ResultChunk> {
    return executeConsole(this.ctx, text, opts);
  }

  async cancel(executionId: string): Promise<void> {
    await this.ctx.cancel(executionId);
  }

  introspect(_scope: IntrospectScope = {}): Promise<SchemaSnapshot> {
    return introspectSearch(this.ctx, this.clusterName || 'cluster');
  }

  browse(path: readonly string[]): Promise<BrowseNode[]> {
    return browseSearch(this.ctx, path);
  }

  async ping(): Promise<void> {
    // HEAD / needs the same privilege as GET /; the cluster health is readable by more users.
    const response = await this.ctx.send({ method: 'HEAD', path: '/' });
    if (response.status === 200 || response.status === 403) return;
    await this.ctx.call({ method: 'GET', path: '/' });
  }

  async close(): Promise<void> {
    if (this.ctx.closed) return;
    this.ctx.closed = true;
    for (const [id, execution] of this.ctx.executions) {
      execution.controller.abort();
      this.ctx.executions.delete(id);
    }
    this.ctx.http.close();
  }

  // Cluster

  clusterInfo(opts?: SearchOpOptions): Promise<SearchClusterInfo> {
    return cluster.clusterInfo(this.ctx, opts);
  }

  clusterHealth(
    opts?: SearchOpOptions & {
      readonly index?: string;
      readonly waitForStatus?: 'green' | 'yellow';
    },
  ): Promise<SearchClusterHealth> {
    return cluster.clusterHealth(this.ctx, opts);
  }

  nodes(opts?: SearchOpOptions): Promise<SearchNodeSummary[]> {
    return cluster.nodes(this.ctx, opts);
  }

  nodeStats(opts?: SearchOpOptions & { readonly metrics?: readonly string[] }): Promise<string> {
    return cluster.nodeStats(this.ctx, opts);
  }

  // Indices

  listIndices(opts?: ListIndicesOptions): Promise<SearchIndexSummary[]> {
    return indices.listIndices(this.ctx, opts);
  }

  createIndex(name: string, body?: string, opts?: SearchOpOptions): Promise<void> {
    return indices.createIndex(this.ctx, name, body, opts);
  }

  deleteIndices(names: readonly string[], opts?: SearchOpOptions): Promise<void> {
    return indices.deleteIndices(this.ctx, names, opts);
  }

  openIndices(names: readonly string[], opts?: SearchOpOptions): Promise<void> {
    return indices.indexAction(this.ctx, '_open', names, opts);
  }

  closeIndices(names: readonly string[], opts?: SearchOpOptions): Promise<void> {
    return indices.indexAction(this.ctx, '_close', names, opts);
  }

  refresh(names: readonly string[], opts?: SearchOpOptions): Promise<void> {
    return indices.indexAction(this.ctx, '_refresh', names, opts);
  }

  flush(names: readonly string[], opts?: SearchOpOptions): Promise<void> {
    return indices.indexAction(this.ctx, '_flush', names, opts);
  }

  forceMerge(names: readonly string[], opts?: ForceMergeOptions): Promise<void> {
    return indices.forceMerge(this.ctx, names, opts);
  }

  getMapping(index: string, opts?: SearchOpOptions): Promise<string> {
    return indices.getMapping(this.ctx, index, opts);
  }

  putMapping(index: string, body: string, opts?: SearchOpOptions): Promise<void> {
    return indices.putMapping(this.ctx, index, body, opts);
  }

  getSettings(index: string, opts?: GetSettingsOptions): Promise<string> {
    return indices.getSettings(this.ctx, index, opts);
  }

  putSettings(index: string, body: string, opts?: SearchOpOptions): Promise<void> {
    return indices.putSettings(this.ctx, index, body, opts);
  }

  listAliases(
    opts?: SearchOpOptions & { readonly includeHidden?: boolean },
  ): Promise<SearchAliasInfo[]> {
    return indices.listAliases(this.ctx, opts);
  }

  updateAliases(actions: string, opts?: SearchOpOptions): Promise<void> {
    return indices.updateAliases(this.ctx, actions, opts);
  }

  listDataStreams(
    opts?: SearchOpOptions & { readonly includeHidden?: boolean },
  ): Promise<SearchDataStreamInfo[]> {
    return indices.listDataStreams(this.ctx, opts);
  }

  // Documents

  search(target: string, body?: string, opts?: SearchPagingOptions): AsyncIterable<SearchPage> {
    return documents.search(this.ctx, target, body, opts);
  }

  count(target: string, query?: string, opts?: SearchOpOptions): Promise<number> {
    return documents.count(this.ctx, target, query, opts);
  }

  getDocument(
    index: string,
    id: string,
    opts?: SearchOpOptions & { readonly routing?: string },
  ): Promise<SearchDocument> {
    return documents.getDocument(this.ctx, index, id, opts);
  }

  indexDocument(
    index: string,
    source: string,
    opts?: IndexDocumentOptions,
  ): Promise<SearchWriteResult> {
    return documents.indexDocument(this.ctx, index, source, opts);
  }

  updateDocument(
    index: string,
    id: string,
    doc: string,
    opts?: WriteOptions & ConcurrencyOptions,
  ): Promise<SearchWriteResult> {
    return documents.updateDocument(this.ctx, index, id, doc, opts);
  }

  deleteDocument(
    index: string,
    id: string,
    opts?: WriteOptions & ConcurrencyOptions,
  ): Promise<SearchWriteResult> {
    return documents.deleteDocument(this.ctx, index, id, opts);
  }

  bulk(
    ndjson: string,
    opts?: WriteOptions & { readonly index?: string },
  ): Promise<SearchBulkResult> {
    return documents.bulk(this.ctx, ndjson, opts);
  }

  deleteByQuery(
    target: string,
    query: string,
    opts?: DeleteByQueryOptions,
  ): Promise<SearchByQueryResult> {
    return documents.deleteByQuery(this.ctx, target, query, opts);
  }

  request(request: SearchRequest, opts?: RequestOptions): Promise<SearchResponse> {
    return sendRequest(this.ctx, request, opts);
  }

  // SQL and ES|QL

  sql(query: string, opts?: SqlQueryOptions): AsyncIterable<SearchTable> {
    return sql.sqlQuery(this.ctx, query, opts);
  }

  translateSql(query: string, opts?: SearchOpOptions): Promise<SqlTranslation> {
    return sql.translateSql(this.ctx, query, opts);
  }

  esql(query: string, opts?: SearchOpOptions): Promise<SearchTable> {
    return sql.esql(this.ctx, query, opts);
  }

  // Index administration and tasks

  resizeIndex(
    kind: 'clone' | 'shrink' | 'split',
    source: string,
    target: string,
    opts?: ResizeOptions,
  ): Promise<void> {
    return admin.resizeIndex(this.ctx, kind, source, target, opts);
  }

  startReindex(opts: ReindexOptions): Promise<{ readonly taskId: string }> {
    return admin.startReindex(this.ctx, opts);
  }

  getTask(taskId: string, opts?: SearchOpOptions): Promise<SearchTaskStatus> {
    return admin.getTask(this.ctx, taskId, opts);
  }

  listTasks(opts?: SearchOpOptions & { readonly actions?: string }): Promise<SearchTaskStatus[]> {
    return admin.listTasks(this.ctx, opts);
  }

  cancelTask(taskId: string, opts?: SearchOpOptions): Promise<void> {
    return admin.cancelTask(this.ctx, taskId, opts);
  }

  // Cluster allocation

  shards(opts?: SearchOpOptions & { readonly index?: string }): Promise<SearchShardInfo[]> {
    return admin.shards(this.ctx, opts);
  }

  allocationExplain(
    shard?: { readonly index: string; readonly shard: number; readonly primary: boolean },
    opts?: SearchOpOptions,
  ): Promise<SearchAllocationExplain> {
    return admin.allocationExplain(this.ctx, shard, opts);
  }

  diskAllocation(opts?: SearchOpOptions): Promise<SearchDiskAllocation> {
    return admin.diskAllocation(this.ctx, opts);
  }

  // Named resources, pipelines and snapshots

  listResources(
    kind: SearchResourceKind,
    opts?: SearchOpOptions & { readonly includeHidden?: boolean },
  ): Promise<SearchResourceInfo[]> {
    return admin.listResources(this.ctx, kind, opts);
  }

  putResource(
    kind: SearchResourceKind,
    name: string,
    body: string,
    opts?: SearchOpOptions,
  ): Promise<void> {
    return admin.putResource(this.ctx, kind, name, body, opts);
  }

  deleteResource(kind: SearchResourceKind, name: string, opts?: SearchOpOptions): Promise<void> {
    return admin.deleteResource(this.ctx, kind, name, opts);
  }

  simulatePipeline(
    pipeline: string | undefined,
    docs: string,
    opts?: SimulatePipelineOptions,
  ): Promise<SearchSimulatedDocument[]> {
    return admin.simulatePipeline(this.ctx, pipeline, docs, opts);
  }

  listSnapshots(repository: string, opts?: SearchOpOptions): Promise<SearchSnapshotInfo[]> {
    return admin.listSnapshots(this.ctx, repository, opts);
  }

  createSnapshot(
    repository: string,
    snapshot: string,
    opts?: SnapshotCreateOptions,
  ): Promise<void> {
    return admin.createSnapshot(this.ctx, repository, snapshot, opts);
  }

  restoreSnapshot(
    repository: string,
    snapshot: string,
    opts?: SnapshotRestoreOptions,
  ): Promise<void> {
    return admin.restoreSnapshot(this.ctx, repository, snapshot, opts);
  }

  deleteSnapshot(repository: string, snapshot: string, opts?: SearchOpOptions): Promise<void> {
    return admin.deleteSnapshot(this.ctx, repository, snapshot, opts);
  }

  verifyRepository(repository: string, opts?: SearchOpOptions): Promise<string[]> {
    return admin.verifyRepository(this.ctx, repository, opts);
  }
}
