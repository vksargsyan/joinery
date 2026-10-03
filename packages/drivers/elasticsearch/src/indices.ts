import { QuerybaraError } from '@querybara/core';
import {
  booleanAt,
  member,
  nodeAt,
  numberAt,
  parseJsonTree,
  stringAt,
  type JsonNode,
  type SearchAliasInfo,
  type SearchDataStreamInfo,
  type SearchHealthStatus,
  type SearchIndexSummary,
} from '@querybara/search-tools';

import { indexList, queryString, segment, type SearchContext } from './context';
import type {
  ForceMergeOptions,
  GetSettingsOptions,
  ListIndicesOptions,
  SearchOpOptions,
} from './types';

/**
 * Index services (spec §11): the index list with health, status, documents, size and shards;
 * create, delete, open, close, refresh, flush and force merge; mappings and settings; aliases
 * and data streams. Bodies are JSON text, checked to be JSON before they are sent.
 */

/** Refuses text that is not a JSON object before a round trip. */
export function assertJsonObject(text: string, what: string): void {
  let node: JsonNode;
  try {
    node = parseJsonTree(text);
  } catch (error) {
    throw new QuerybaraError({
      code: 'VALIDATION_FAILED',
      message: `The ${what} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      ...(error instanceof Error && 'offset' in error && typeof error.offset === 'number'
        ? { position: error.offset }
        : {}),
    });
  }
  if (node.type !== 'object') {
    throw new QuerybaraError({
      code: 'VALIDATION_FAILED',
      message: `The ${what} must be a JSON object`,
    });
  }
}

function healthOf(value: string | undefined): SearchHealthStatus | null {
  return value === 'green' || value === 'yellow' || value === 'red' ? value : null;
}

function count(node: JsonNode, key: string): number | null {
  return numberAt(node, key) ?? null;
}

export async function listIndices(
  ctx: SearchContext,
  opts: ListIndicesOptions = {},
): Promise<SearchIndexSummary[]> {
  const pattern = opts.pattern ? segment(opts.pattern) : undefined;
  const { node } = await ctx.json(
    {
      method: 'GET',
      path: pattern ? `/_cat/indices/${pattern}` : '/_cat/indices',
      query: queryString({
        format: 'json',
        bytes: 'b',
        h: 'health,status,index,uuid,pri,rep,docs.count,docs.deleted,store.size,pri.store.size,creation.date',
        expand_wildcards: opts.includeHidden ? 'all' : 'open,closed',
        s: 'index',
      }),
    },
    opts,
  );
  if (node.type !== 'array') return [];
  return node.items.map((item) => {
    const created = numberAt(item, 'creation.date');
    const uuid = stringAt(item, 'uuid');
    return {
      name: stringAt(item, 'index') ?? '',
      ...(uuid !== undefined ? { uuid } : {}),
      health: healthOf(stringAt(item, 'health')),
      status: stringAt(item, 'status') === 'close' ? 'close' : 'open',
      primaries: numberAt(item, 'pri') ?? 0,
      replicas: numberAt(item, 'rep') ?? 0,
      docsCount: count(item, 'docs.count'),
      docsDeleted: count(item, 'docs.deleted'),
      storeSizeBytes: count(item, 'store.size'),
      primaryStoreSizeBytes: count(item, 'pri.store.size'),
      ...(created !== undefined ? { createdAt: new Date(created).toISOString() } : {}),
    };
  });
}

export async function createIndex(
  ctx: SearchContext,
  name: string,
  body: string | undefined,
  opts: SearchOpOptions = {},
): Promise<void> {
  if (body !== undefined && body.trim() !== '') assertJsonObject(body, 'index definition');
  await ctx.call(
    {
      method: 'PUT',
      path: `/${segment(name)}`,
      ...(body !== undefined && body.trim() !== '' ? { body } : {}),
    },
    opts,
  );
}

export async function deleteIndices(
  ctx: SearchContext,
  names: readonly string[],
  opts: SearchOpOptions = {},
): Promise<void> {
  await ctx.call({ method: 'DELETE', path: `/${indexList(names)}` }, opts);
}

/** Open, close, refresh or flush: `POST /<indices>/_<action>`. */
export async function indexAction(
  ctx: SearchContext,
  action: '_open' | '_close' | '_refresh' | '_flush',
  names: readonly string[],
  opts: SearchOpOptions = {},
): Promise<void> {
  await ctx.call({ method: 'POST', path: `/${indexList(names)}/${action}` }, opts);
}

export async function forceMerge(
  ctx: SearchContext,
  names: readonly string[],
  opts: ForceMergeOptions = {},
): Promise<void> {
  await ctx.call(
    {
      method: 'POST',
      path: `/${indexList(names)}/_forcemerge`,
      query: queryString({
        max_num_segments: opts.maxNumSegments,
        only_expunge_deletes: opts.onlyExpungeDeletes,
        flush: opts.flush,
      }),
    },
    opts,
  );
}

export async function getMapping(
  ctx: SearchContext,
  index: string,
  opts: SearchOpOptions = {},
): Promise<string> {
  return (await ctx.json({ method: 'GET', path: `/${segment(index)}/_mapping` }, opts)).text;
}

export async function putMapping(
  ctx: SearchContext,
  index: string,
  body: string,
  opts: SearchOpOptions = {},
): Promise<void> {
  assertJsonObject(body, 'mapping');
  await ctx.call({ method: 'PUT', path: `/${segment(index)}/_mapping`, body }, opts);
}

export async function getSettings(
  ctx: SearchContext,
  index: string,
  opts: GetSettingsOptions = {},
): Promise<string> {
  const query = queryString({
    include_defaults: opts.includeDefaults,
    flat_settings: opts.flatSettings,
  });
  return (
    await ctx.json(
      { method: 'GET', path: `/${segment(index)}/_settings`, ...(query ? { query } : {}) },
      opts,
    )
  ).text;
}

export async function putSettings(
  ctx: SearchContext,
  index: string,
  body: string,
  opts: SearchOpOptions = {},
): Promise<void> {
  assertJsonObject(body, 'settings');
  await ctx.call({ method: 'PUT', path: `/${segment(index)}/_settings`, body }, opts);
}

export async function listAliases(
  ctx: SearchContext,
  opts: SearchOpOptions & { readonly includeHidden?: boolean } = {},
): Promise<SearchAliasInfo[]> {
  const { node } = await ctx.json(
    {
      method: 'GET',
      path: '/_alias',
      ...(opts.includeHidden ? { query: 'expand_wildcards=all' } : {}),
    },
    opts,
  );
  const out: SearchAliasInfo[] = [];
  if (node.type !== 'object') return out;
  for (const index of node.members) {
    const aliases = member(index.value, 'aliases');
    if (aliases?.type !== 'object') continue;
    for (const alias of aliases.members) {
      const hidden = booleanAt(alias.value, 'is_hidden') ?? false;
      if (hidden && !opts.includeHidden) continue;
      const indexRouting = stringAt(alias.value, 'index_routing');
      const searchRouting = stringAt(alias.value, 'search_routing');
      out.push({
        alias: alias.key,
        index: index.key,
        filtered: member(alias.value, 'filter') !== undefined,
        ...(indexRouting !== undefined ? { indexRouting } : {}),
        ...(searchRouting !== undefined ? { searchRouting } : {}),
        isWriteIndex: booleanAt(alias.value, 'is_write_index') ?? null,
        hidden,
      });
    }
  }
  return out.sort((a, b) => a.alias.localeCompare(b.alias) || a.index.localeCompare(b.index));
}

export async function updateAliases(
  ctx: SearchContext,
  actions: string,
  opts: SearchOpOptions = {},
): Promise<void> {
  assertJsonObject(actions, 'alias actions');
  await ctx.call({ method: 'POST', path: '/_aliases', body: actions }, opts);
}

export async function listDataStreams(
  ctx: SearchContext,
  opts: SearchOpOptions & { readonly includeHidden?: boolean } = {},
): Promise<SearchDataStreamInfo[]> {
  if (!ctx.facts.capabilities.dataStreams) return [];
  const { node } = await ctx.json(
    {
      method: 'GET',
      path: '/_data_stream',
      ...(opts.includeHidden ? { query: 'expand_wildcards=all' } : {}),
    },
    opts,
  );
  const streams = member(node, 'data_streams');
  if (streams?.type !== 'array') return [];
  return streams.items.map((stream) => {
    const indices = member(stream, 'indices');
    const template = stringAt(stream, 'template');
    const policy = stringAt(stream, 'ilm_policy');
    return {
      name: stringAt(stream, 'name') ?? '',
      health: healthOf((stringAt(stream, 'status') ?? '').toLowerCase()),
      generation: numberAt(stream, 'generation') ?? 0,
      indices:
        indices?.type === 'array'
          ? indices.items.map((i) => stringAt(i, 'index_name') ?? '').filter(Boolean)
          : [],
      ...(template !== undefined ? { template } : {}),
      ...(policy !== undefined ? { lifecyclePolicy: policy } : {}),
      timestampField: stringAt(nodeAt(stream, ['timestamp_field']), 'name') ?? '@timestamp',
      hidden: booleanAt(stream, 'hidden') ?? false,
      system: booleanAt(stream, 'system') ?? false,
    };
  });
}
