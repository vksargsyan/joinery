import type { BrowseNode } from '@querybara/core';
import { formatConsoleRequest } from '@querybara/search-tools';

import { loadChildren } from '../explorer';
import { SessionLane } from '../session-lane';

/**
 * The Elasticsearch object explorer (spec §5): what a tree node from the driver's
 * `browse` stands for, the console text that searches it, and the request a delete sends
 * (shown before it runs). Paths are folder / name, the folder segments the driver's stable ids
 * (indices, data-streams, aliases).
 */

export type SearchObject =
  | { readonly kind: 'index'; readonly name: string; readonly status: 'open' | 'close' }
  | { readonly kind: 'data-stream' | 'alias'; readonly name: string };

/** The object a node stands for; undefined for folders. */
export function searchObjectOf(node: BrowseNode): SearchObject | undefined {
  const [folder, name] = node.path;
  if (name === undefined) return undefined;
  if (folder === 'indices' && node.kind === 'index') {
    return { kind: 'index', name, status: node.detail?.['status'] === 'close' ? 'close' : 'open' };
  }
  if (folder === 'data-streams' && node.kind === 'data-stream')
    return { kind: 'data-stream', name };
  if (folder === 'aliases' && node.kind === 'alias') return { kind: 'alias', name };
  return undefined;
}

/** Console text that searches the object's documents. */
export function searchText(object: SearchObject): string {
  return `${formatConsoleRequest({
    method: 'GET',
    // Index, alias and data stream names hold no characters a console path must escape.
    path: `/${object.name}/_search`,
    body: '{\n  "query": {\n    "match_all": {}\n  }\n}',
    bodyKind: 'json',
  })}\n`;
}

/** The request that deletes the object (what the confirmation shows), if it can be deleted. */
export function deleteRequest(
  object: SearchObject,
): { method: 'DELETE'; path: string } | undefined {
  switch (object.kind) {
    case 'index':
      return { method: 'DELETE', path: `/${encodeURIComponent(object.name)}` };
    case 'data-stream':
      return { method: 'DELETE', path: `/_data_stream/${encodeURIComponent(object.name)}` };
    case 'alias':
      return undefined;
  }
}

/** What the confirmation calls the object: "index orders". */
export function describeSearchObject(object: SearchObject): string {
  return `${object.kind === 'data-stream' ? 'data stream' : object.kind} ${object.name}`;
}

/** The health of a node as the tree badge shows it. */
export function healthOf(node: BrowseNode): 'green' | 'yellow' | 'red' | 'closed' | undefined {
  const detail = node.detail ?? {};
  if (detail['status'] === 'close') return 'closed';
  const health = detail['health'];
  return health === 'green' || health === 'yellow' || health === 'red' ? health : undefined;
}

/** One session per connection for the explorer's own actions (deletes), opened on first use. */
const lanes = new Map<string, SessionLane>();

function laneFor(profileId: string): SessionLane {
  let lane = lanes.get(profileId);
  if (!lane) {
    lane = new SessionLane(profileId);
    lanes.set(profileId, lane);
  }
  return lane;
}

/**
 * Deletes the object after the user confirmed its request, then reloads its folder. The
 * connection host applies the write rules again (a read-only profile refuses).
 */
export async function deleteSearchObject(profileId: string, object: SearchObject): Promise<void> {
  const request = deleteRequest(object);
  if (!request) return;
  await laneFor(profileId).run(async (host, sessionId) => {
    if (object.kind === 'index') {
      await host.search.indices.delete({ sessionId, names: [object.name], confirmed: true });
      return;
    }
    const response = await host.search.request({ sessionId, request, confirmed: true });
    if (response.status >= 300) {
      throw new Error(`${request.method} ${request.path} answered ${response.status}`);
    }
  });
  await loadChildren(profileId, [object.kind === 'index' ? 'indices' : 'data-streams']);
}
