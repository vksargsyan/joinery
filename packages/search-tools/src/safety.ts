import { member, parseJsonTree, type JsonNode } from './json';
import type { HttpMethod } from './console/parser';

/**
 * What an Elasticsearch request does, for the write rules (spec §4): whether it
 * can change data or cluster state, and whether it is destructive (it deletes or closes data,
 * or rewrites documents in bulk). Blocking operations (a write or read block on an index, set
 * directly or through its settings) count as destructive too: they always ask. The connection
 * host enforces the rules with this, the console and joinery-cli ask with it first. Unknown
 * requests that are not GET or HEAD count as writes.
 */

export interface RequestSafety {
  /** The request can change data, mappings, settings or cluster state. */
  readonly writes: boolean;
  /** Why the request is destructive; undefined when it is not. */
  readonly destructive?: string;
  /** "DELETE /orders", for messages. */
  readonly label: string;
}

/** Endpoints that only read, whatever the method (POST _search, POST _count...). */
const READ_SEGMENTS = new Set([
  '_search',
  '_msearch',
  '_count',
  '_validate',
  '_explain',
  '_field_caps',
  '_mget',
  '_termvectors',
  '_mtermvectors',
  '_rank_eval',
  '_render',
  '_analyze',
  '_knn_search',
  '_terms_enum',
  '_search_shards',
  '_resolve',
  '_has_privileges',
  '_simulate',
  '_simulate_index',
  '_query',
  '_eql',
  '_async_search',
  '_pit',
  '_graph',
  '_sql',
]);

/** A path's segments, percent-decoded, without empty ones. */
function segmentsOf(path: string): string[] {
  return path
    .split('?')[0]!
    .split('/')
    .filter((s) => s !== '')
    .map((s) => {
      try {
        return decodeURIComponent(s);
      } catch {
        return s;
      }
    });
}

/** The API segments of a path: the ones naming an endpoint ("_all" is an index pattern). */
function apiSegments(segments: readonly string[]): string[] {
  return segments.filter((s) => s.startsWith('_') && s !== '_all');
}

function bulkDeletes(body: string | undefined): boolean {
  if (body === undefined) return false;
  for (const line of body.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      const node = parseJsonTree(trimmed);
      if (node.type === 'object' && node.members[0]?.key === 'delete') return true;
    } catch {
      // The server reports the malformed line.
    }
  }
  return false;
}

/** The blocks a settings body turns on ("write", "read_only"...), flat or nested keys alike. */
export function blocksSetIn(body: string | undefined): string[] {
  if (body === undefined || body.trim() === '') return [];
  let root: JsonNode;
  try {
    root = parseJsonTree(body);
  } catch {
    return [];
  }
  const found: string[] = [];
  const walk = (node: JsonNode, path: string): void => {
    if (node.type === 'object') {
      for (const m of node.members) walk(m.value, path === '' ? m.key : `${path}.${m.key}`);
      return;
    }
    const on =
      (node.type === 'boolean' && node.value) || (node.type === 'string' && node.value === 'true');
    const match = /(?:^|\.)blocks\.([a-z_]+)$/.exec(path);
    if (on && match) found.push(match[1]!);
  };
  walk(root, '');
  return found;
}

/** Whether an `_aliases` body deletes indices (a `remove_index` action). */
function removesIndices(body: string | undefined): boolean {
  if (body === undefined) return false;
  try {
    const actions = member(parseJsonTree(body), 'actions');
    return (
      actions?.type === 'array' &&
      actions.items.some(
        (a) => a.type === 'object' && a.members.some((m) => m.key === 'remove_index'),
      )
    );
  } catch {
    return false;
  }
}

/** Classifies a request (see RequestSafety). */
export function classifyRequest(request: {
  readonly method: HttpMethod | string;
  readonly path: string;
  readonly body?: string;
}): RequestSafety {
  const method = request.method.toUpperCase();
  const segments = segmentsOf(request.path);
  const apis = apiSegments(segments);
  const label = `${method} /${segments.join('/')}`;
  const has = (name: string): boolean => apis.includes(name);
  if (method === 'GET' || method === 'HEAD') return { writes: false, label };
  // The allocation explain API reads, whatever its method.
  if (has('_cluster') && segments.includes('allocation') && segments.includes('explain')) {
    return { writes: false, label };
  }

  if (method === 'DELETE') {
    // Clearing a scroll, a point in time or a stored async search frees server resources only.
    if (
      (has('_search') && segments.includes('scroll')) ||
      has('_pit') ||
      has('_async_search') ||
      (has('_sql') && segments.includes('close'))
    ) {
      return { writes: false, label };
    }
    return { writes: true, destructive: deleteReason(segments, apis), label };
  }

  if (has('_close')) {
    return {
      writes: true,
      destructive: 'closes indices: they cannot be searched or written until reopened',
      label,
    };
  }
  if (has('_delete_by_query')) {
    return { writes: true, destructive: 'deletes every document the query matches', label };
  }
  if (has('_update_by_query')) {
    return { writes: true, destructive: 'changes every document the query matches', label };
  }
  if (has('_forcemerge')) {
    return {
      writes: true,
      destructive: 'force-merges segments: heavy I/O, and deleted documents are gone for good',
      label,
    };
  }
  if (has('_bulk')) {
    return bulkDeletes(request.body)
      ? { writes: true, destructive: 'deletes documents (bulk delete actions)', label }
      : { writes: true, label };
  }
  if (has('_shutdown') || (has('_nodes') && segments.includes('shutdown'))) {
    return { writes: true, destructive: 'shuts down nodes', label };
  }
  if (has('_features') && has('_reset')) {
    return { writes: true, destructive: 'resets system features and deletes their state', label };
  }
  if (has('_snapshot') && has('_restore')) {
    return {
      writes: true,
      destructive: 'restores indices from a snapshot, replacing closed indices of the same name',
      label,
    };
  }
  if (has('_snapshot') && has('_cleanup')) {
    return {
      writes: true,
      destructive: 'deletes repository data that no snapshot refers to',
      label,
    };
  }
  if (has('_aliases') && removesIndices(request.body)) {
    return { writes: true, destructive: 'deletes indices (a remove_index action)', label };
  }
  if (has('_block')) {
    return {
      writes: true,
      destructive: 'blocks the index: writes (or reads) fail until the block is removed',
      label,
    };
  }
  if (has('_settings')) {
    const blocks = blocksSetIn(request.body);
    if (blocks.length > 0) {
      return {
        writes: true,
        destructive: `blocks the index (${blocks.join(', ')}): it refuses those operations until the block is removed`,
        label,
      };
    }
  }
  if (apis.some((a) => READ_SEGMENTS.has(a))) {
    // _search/scroll and _search/template read too; _pit opens a point in time; SQL only reads.
    return { writes: false, label };
  }
  return { writes: true, label };
}

function deleteReason(segments: readonly string[], apis: readonly string[]): string {
  if (apis.length === 0) {
    const everything = segments.length === 0 || segments.some((s) => s === '_all' || s === '*');
    return everything ? 'deletes every index' : 'deletes the index and all its documents';
  }
  if (apis.includes('_doc') || apis.includes('_create')) return 'deletes the document';
  if (apis.includes('_data_stream')) return 'deletes the data stream and its backing indices';
  if (apis.includes('_snapshot')) {
    // DELETE /_snapshot/<repo> unregisters the repository; /_snapshot/<repo>/<snapshot> deletes.
    const at = segments.indexOf('_snapshot');
    return segments.length - at > 2
      ? 'deletes the snapshot (its data in the repository is gone)'
      : 'unregisters the snapshot repository (its files stay where they are)';
  }
  if (apis.includes('_alias') || apis.includes('_aliases')) return 'removes aliases';
  const api = apis[0]!;
  const known = DELETE_REASONS[api];
  if (known) return known;
  const what = api.replace(/^_/, '').replace(/_/g, ' ');
  return `deletes ${what === '' ? 'data' : what}`;
}

const DELETE_REASONS: Readonly<Record<string, string>> = {
  _ingest: 'deletes the ingest pipeline',
  _ilm: 'deletes the lifecycle policy',
  _index_template: 'deletes the index template',
  _component_template: 'deletes the component template',
  _template: 'deletes the index template',
  _security: 'deletes security objects (users, roles or API keys)',
  _scripts: 'deletes the stored script',
  _tasks: 'deletes tasks',
  _transform: 'deletes the transform',
  _ml: 'deletes machine learning objects',
};
