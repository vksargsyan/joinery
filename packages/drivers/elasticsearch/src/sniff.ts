import type { ResolvedProfile } from '@joinery/core';
import { member, parseJsonTree, stringAt } from '@joinery/search-tools';

import { buildNodeTarget, type SearchNodeTarget } from './config';
import type { SearchHttpClient } from './http';

/**
 * Sniffing (spec §4, off by default): asks the cluster for its nodes' HTTP publish addresses
 * (`GET /_nodes/_all/http`) and spreads requests over them. Nodes keep the scheme, path prefix
 * and TLS settings of the first listed URL. Addresses are "ip:port" or "host/ip:port"; the host
 * name is used when there is one, so TLS can verify it.
 */

/** The host and port of a publish address; undefined when it cannot be read. */
export function parsePublishAddress(address: string): { host: string; port: number } | undefined {
  const slash = address.indexOf('/');
  const named = slash > 0 ? address.slice(0, slash) : undefined;
  const rest = slash === -1 ? address : address.slice(slash + 1);
  const match = /^\[?([^\]]+?)\]?:(\d+)$/.exec(rest);
  if (!match) return undefined;
  return { host: named ?? match[1]!, port: Number(match[2]) };
}

/** Replaces the client's node list with the cluster's HTTP nodes; returns the new list. */
export async function sniffNodes(
  http: SearchHttpClient,
  resolved: ResolvedProfile,
): Promise<readonly SearchNodeTarget[]> {
  const response = await http.request({
    method: 'GET',
    path: '/_nodes/_all/http',
    timeoutMs: 10_000,
  });
  if (response.status !== 200) return http.nodes;
  const root = parseJsonTree(response.body);
  const nodes = member(root, 'nodes');
  if (nodes?.type !== 'object') return http.nodes;
  const first = http.nodes[0]!;
  const targets: SearchNodeTarget[] = [];
  for (const node of nodes.members) {
    const address = stringAt(node.value, 'http', 'publish_address');
    const parsed = address === undefined ? undefined : parsePublishAddress(address);
    if (!parsed) continue;
    targets.push(
      buildNodeTarget(resolved, {
        protocol: first.protocol,
        host: parsed.host,
        port: parsed.port,
        pathPrefix: first.pathPrefix,
      }),
    );
  }
  if (targets.length > 0) http.replaceNodes(targets);
  return http.nodes;
}
