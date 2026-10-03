import { QuerybaraError, type BrowseNode } from '@querybara/core';

import type { SearchContext } from './context';
import { listAliases, listDataStreams, listIndices } from './indices';

/**
 * The object explorer tree of a cluster (spec §5): Indices (with health, status, documents,
 * size and shards in `detail`), Data streams and Aliases. Folder segments are stable ids, so
 * later folders (templates, lifecycle policies, pipelines, snapshots) slot in beside them.
 */

export const SEARCH_FOLDERS = [
  { id: 'indices', name: 'Indices' },
  { id: 'data-streams', name: 'Data streams' },
  { id: 'aliases', name: 'Aliases' },
] as const;

export async function browseSearch(
  ctx: SearchContext,
  path: readonly string[],
): Promise<BrowseNode[]> {
  if (path.length === 0) {
    return SEARCH_FOLDERS.filter(
      (f) => f.id !== 'data-streams' || ctx.facts.capabilities.dataStreams,
    ).map((folder) => ({
      kind: 'folder',
      name: folder.name,
      path: [folder.id],
      hasChildren: true,
    }));
  }
  if (path.length > 1) return [];
  switch (path[0]) {
    case 'indices': {
      const indices = await listIndices(ctx);
      return indices.map((index) => ({
        kind: 'index',
        name: index.name,
        path: ['indices', index.name],
        hasChildren: false,
        detail: {
          health: index.health,
          status: index.status,
          docs: index.docsCount,
          size: index.storeSizeBytes,
          primaries: index.primaries,
          replicas: index.replicas,
        },
      }));
    }
    case 'data-streams': {
      const streams = await listDataStreams(ctx);
      return streams.map((stream) => ({
        kind: 'data-stream',
        name: stream.name,
        path: ['data-streams', stream.name],
        hasChildren: false,
        detail: {
          health: stream.health,
          generation: stream.generation,
          indices: stream.indices.length,
          template: stream.template ?? null,
          policy: stream.lifecyclePolicy ?? null,
        },
      }));
    }
    case 'aliases': {
      const aliases = await listAliases(ctx);
      const byName = new Map<string, string[]>();
      const writeIndex = new Map<string, string>();
      for (const alias of aliases) {
        byName.set(alias.alias, [...(byName.get(alias.alias) ?? []), alias.index]);
        if (alias.isWriteIndex) writeIndex.set(alias.alias, alias.index);
      }
      return [...byName].map(([name, indices]) => ({
        kind: 'alias',
        name,
        path: ['aliases', name],
        hasChildren: false,
        detail: {
          indices: indices.join(', '),
          count: indices.length,
          writeIndex: writeIndex.get(name) ?? null,
        },
      }));
    }
    default:
      throw new QuerybaraError({ code: 'NOT_FOUND', message: `No folder "${path[0]}"` });
  }
}
