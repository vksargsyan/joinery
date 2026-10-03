import { QuerybaraError } from '@querybara/core';
import {
  booleanAt,
  numberAt,
  parseJsonTree,
  searchCapabilities,
  stringAt,
  type JsonNode,
  type SearchClusterHealth,
  type SearchClusterInfo,
  type SearchHealthStatus,
  type SearchNodeSummary,
} from '@querybara/search-tools';

import { mapResponseError } from './errors';
import type { SearchContext, ServerFacts } from './context';
import { queryString } from './context';
import type { SearchHttpClient } from './http';
import type { SearchOpOptions } from './types';

/**
 * Cluster services (spec §11): what the server is (`GET /`, the licence, the plugins), its
 * health, and its nodes.
 */

/** What `GET /` says about the server. */
export interface RootInfo {
  readonly version: string;
  readonly clusterName: string;
  readonly clusterUuid?: string;
  readonly nodeName?: string;
  readonly buildFlavor?: string;
  readonly luceneVersion?: string;
  /** The server sent Elastic's product header (Elasticsearch 7.14 and later). */
  readonly elasticProduct: boolean;
  /**
   * The user may not read `GET /` (it needs the monitor privilege), so the version is unknown
   * ('') and the capabilities are the conservative ones.
   */
  readonly restricted?: boolean;
}

/** Reads `GET /`: the version, the cluster and the build flavour. */
export function parseRoot(body: string, headers: Readonly<Record<string, unknown>>): RootInfo {
  let root: JsonNode;
  try {
    root = parseJsonTree(body);
  } catch {
    throw new QuerybaraError({
      code: 'CONNECTION_FAILED',
      message: 'The server did not answer GET / with JSON: it is not Elasticsearch',
      hint: 'Check the URL: it should point at the HTTP port of a node (usually 9200)',
    });
  }
  const number = stringAt(root, 'version', 'number');
  if (number === undefined) {
    throw new QuerybaraError({
      code: 'CONNECTION_FAILED',
      message: 'The server answered GET / without a version: it is not Elasticsearch',
      hint: 'Check the URL: it should point at the HTTP port of a node (usually 9200)',
    });
  }
  const clusterUuid = stringAt(root, 'cluster_uuid');
  const nodeName = stringAt(root, 'name');
  const buildFlavor = stringAt(root, 'version', 'build_flavor');
  const luceneVersion = stringAt(root, 'version', 'lucene_version');
  return {
    version: number,
    clusterName: stringAt(root, 'cluster_name') ?? '',
    ...(clusterUuid !== undefined ? { clusterUuid } : {}),
    ...(nodeName !== undefined ? { nodeName } : {}),
    ...(buildFlavor !== undefined ? { buildFlavor } : {}),
    ...(luceneVersion !== undefined ? { luceneVersion } : {}),
    elasticProduct: headers['x-elastic-product'] === 'Elasticsearch',
  };
}

/** The installed plugin components, or [] when the user may not list them. */
export async function readPlugins(
  http: Pick<SearchHttpClient, 'request'>,
  signal?: AbortSignal,
): Promise<string[]> {
  try {
    const response = await http.request({
      method: 'GET',
      path: '/_cat/plugins',
      query: 'format=json&h=component',
      ...(signal ? { signal } : {}),
    });
    if (response.status !== 200) return [];
    const root = parseJsonTree(response.body);
    if (root.type !== 'array') return [];
    return [
      ...new Set(root.items.map((item) => stringAt(item, 'component') ?? '').filter(Boolean)),
    ];
  } catch {
    return [];
  }
}

/**
 * Reads the server at session start: `GET /`, which also proves the credentials, so the
 * capability flags are right from the first call.
 */
export async function detectServer(
  http: SearchHttpClient,
  context: Parameters<typeof mapResponseError>[2],
): Promise<{ root: RootInfo; facts: ServerFacts }> {
  const response = await http.request({ method: 'GET', path: '/' });
  let root: RootInfo;
  if (response.status === 403) {
    // Authenticated, but without the monitor privilege: the version stays unknown.
    root = {
      version: '',
      clusterName: '',
      elasticProduct: response.headers['x-elastic-product'] === 'Elasticsearch',
      restricted: true,
    };
  } else if (response.status !== 200) {
    throw mapResponseError(response.status, response.body, context);
  } else {
    root = parseRoot(response.body, response.headers);
  }
  const facts: ServerFacts = {
    version: root.version,
    ...(root.buildFlavor !== undefined ? { buildFlavor: root.buildFlavor } : {}),
    capabilities: searchCapabilities({
      version: root.version,
      ...(root.buildFlavor !== undefined ? { buildFlavor: root.buildFlavor } : {}),
      securityEnabled: context.authMethod !== undefined && context.authMethod !== 'none',
    }),
  };
  return { root, facts };
}

export async function clusterInfo(
  ctx: SearchContext,
  opts: SearchOpOptions = {},
): Promise<SearchClusterInfo> {
  const rootResponse = await ctx.call({ method: 'GET', path: '/' }, opts);
  const root = parseRoot(rootResponse.body, rootResponse.headers);
  const [plugins, license] = await Promise.all([
    readPlugins(ctx.http, opts.signal),
    root.buildFlavor !== 'oss' ? readLicense(ctx, opts) : Promise.resolve(undefined),
  ]);
  const capabilities = searchCapabilities({
    version: root.version,
    ...(root.buildFlavor !== undefined ? { buildFlavor: root.buildFlavor } : {}),
    securityEnabled: ctx.plan.authMethod !== 'none',
  });
  ctx.facts = { ...ctx.facts, capabilities };
  return {
    version: root.version,
    clusterName: root.clusterName,
    ...(root.clusterUuid !== undefined ? { clusterUuid: root.clusterUuid } : {}),
    ...(root.nodeName !== undefined ? { nodeName: root.nodeName } : {}),
    ...(root.buildFlavor !== undefined ? { buildFlavor: root.buildFlavor } : {}),
    ...(root.luceneVersion !== undefined ? { luceneVersion: root.luceneVersion } : {}),
    ...(license !== undefined ? { license } : {}),
    plugins,
    capabilities,
  };
}

/** Elasticsearch's licence, or undefined when it cannot be read (privileges, OSS). */
async function readLicense(
  ctx: SearchContext,
  opts: SearchOpOptions,
): Promise<SearchClusterInfo['license']> {
  try {
    const response = await ctx.send({ method: 'GET', path: '/_license' }, opts);
    if (response.status !== 200) return undefined;
    const root = parseJsonTree(response.body);
    const type = stringAt(root, 'license', 'type');
    const status = stringAt(root, 'license', 'status');
    if (type === undefined || status === undefined) return undefined;
    const expires = numberAt(root, 'license', 'expiry_date_in_millis');
    return {
      type,
      status,
      ...(expires !== undefined && expires > 0 && expires < 8.64e15
        ? { expiresAt: new Date(expires).toISOString() }
        : {}),
    };
  } catch (error) {
    if (error instanceof QuerybaraError && error.code === 'CANCELLED') throw error;
    return undefined;
  }
}

function health(value: string | undefined): SearchHealthStatus | null {
  return value === 'green' || value === 'yellow' || value === 'red' ? value : null;
}

export async function clusterHealth(
  ctx: SearchContext,
  opts: SearchOpOptions & {
    readonly index?: string;
    readonly waitForStatus?: 'green' | 'yellow';
  } = {},
): Promise<SearchClusterHealth> {
  const path = opts.index
    ? `/_cluster/health/${encodeURIComponent(opts.index)}`
    : '/_cluster/health';
  const { node } = await ctx.json(
    {
      method: 'GET',
      path,
      query: queryString({
        wait_for_status: opts.waitForStatus,
        timeout: opts.waitForStatus ? '30s' : undefined,
      }),
    },
    opts,
  );
  return {
    clusterName: stringAt(node, 'cluster_name') ?? '',
    status: health(stringAt(node, 'status')) ?? 'red',
    timedOut: booleanAt(node, 'timed_out') ?? false,
    nodes: numberAt(node, 'number_of_nodes') ?? 0,
    dataNodes: numberAt(node, 'number_of_data_nodes') ?? 0,
    activePrimaryShards: numberAt(node, 'active_primary_shards') ?? 0,
    activeShards: numberAt(node, 'active_shards') ?? 0,
    relocatingShards: numberAt(node, 'relocating_shards') ?? 0,
    initializingShards: numberAt(node, 'initializing_shards') ?? 0,
    unassignedShards: numberAt(node, 'unassigned_shards') ?? 0,
    pendingTasks: numberAt(node, 'number_of_pending_tasks') ?? 0,
    activeShardsPercent: numberAt(node, 'active_shards_percent_as_number') ?? 0,
  };
}

function percent(node: JsonNode, key: string): number | null {
  return numberAt(node, key) ?? null;
}

export async function nodes(
  ctx: SearchContext,
  opts: SearchOpOptions = {},
): Promise<SearchNodeSummary[]> {
  const { node } = await ctx.json(
    {
      method: 'GET',
      path: '/_cat/nodes',
      query:
        'format=json&h=name,ip,node.role,master,heap.percent,ram.percent,cpu,load_1m,disk.used_percent,version',
    },
    opts,
  );
  if (node.type !== 'array') return [];
  return node.items.map((item) => ({
    name: stringAt(item, 'name') ?? '',
    ip: stringAt(item, 'ip') ?? '',
    roles: stringAt(item, 'node.role') ?? '',
    master: stringAt(item, 'master') === '*',
    heapPercent: percent(item, 'heap.percent'),
    ramPercent: percent(item, 'ram.percent'),
    cpuPercent: percent(item, 'cpu'),
    load1m: percent(item, 'load_1m'),
    diskUsedPercent: percent(item, 'disk.used_percent'),
    version: stringAt(item, 'version') ?? '',
  }));
}

export async function nodeStats(
  ctx: SearchContext,
  opts: SearchOpOptions & { readonly metrics?: readonly string[] } = {},
): Promise<string> {
  const metrics = opts.metrics?.map(encodeURIComponent).join(',');
  const { text } = await ctx.json(
    { method: 'GET', path: metrics ? `/_nodes/stats/${metrics}` : '/_nodes/stats' },
    opts,
  );
  return text;
}
