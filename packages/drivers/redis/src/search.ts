import { JoineryError } from '@joinery/core';
import {
  hashFields,
  jsonFields,
  parseSearchInfo,
  parseSearchReply,
  searchCreateArgs,
  suggestSearchFields,
  type SearchFieldSuggestion,
  type SearchIndexDefinition,
  type SearchIndexInfo,
  type SearchKeyType,
  type SearchResult,
} from '@joinery/redis-tools';

import type { Arg } from './client';
import type { RedisContext } from './context';
import { asArray, asBytes, asText, toRedisReply } from './replies';
import type { SearchQueryOptions, SearchSuggestOptions } from './types';

/**
 * RediSearch, the Redis Query Engine (Redis 8, Redis Stack; valkey-search): indexes listed,
 * described, queried, explained, created and dropped with FT.* commands on one node (the
 * target node, or the first primary: an index lives on each shard that holds its keys), and
 * fields suggested from sample keys for a new index. Replies are read by redis-tools.
 */

/** "unknown command" for FT.*: the module is not loaded. */
function notLoaded(error: unknown): never {
  if (error instanceof JoineryError && /unknown command/i.test(error.message)) {
    throw new JoineryError(
      {
        code: 'NOT_SUPPORTED',
        message: 'The search module (Redis Query Engine) is not loaded on this server',
        hint: 'Redis 8 and Redis Stack include it; for Valkey, load valkey-search',
      },
      { cause: error },
    );
  }
  throw error;
}

async function ft(ctx: RedisContext, args: readonly Arg[], node?: string): Promise<unknown> {
  return ctx.call(args, ctx.nodeFor(node)).catch(notLoaded);
}

export async function searchIndexes(ctx: RedisContext, node?: string): Promise<string[]> {
  const reply = await ft(ctx, ['FT._LIST'], node);
  return asArray(reply)
    .map((name) => asText(name) ?? '')
    .filter((name) => name !== '')
    .sort((a, b) => a.localeCompare(b));
}

export async function searchInfo(
  ctx: RedisContext,
  index: string,
  node?: string,
): Promise<SearchIndexInfo> {
  return parseSearchInfo(toRedisReply(await ft(ctx, ['FT.INFO', index], node)));
}

/** FT.SEARCH's arguments for a query and its options. */
export function searchQueryArgs(
  index: string,
  query: string,
  options: SearchQueryOptions = {},
): Arg[] {
  const args: Arg[] = ['FT.SEARCH', index, query];
  if (options.verbatim === true) args.push('VERBATIM');
  if (options.noContent === true) args.push('NOCONTENT');
  if (options.withScores === true) args.push('WITHSCORES');
  if (options.noContent !== true && options.returnFields && options.returnFields.length > 0) {
    args.push('RETURN', options.returnFields.length, ...options.returnFields);
  }
  if (options.sortBy !== undefined && options.sortBy !== '') {
    args.push('SORTBY', options.sortBy, options.sortDescending === true ? 'DESC' : 'ASC');
  }
  args.push('LIMIT', options.offset ?? 0, options.limit ?? 10);
  const params = Object.entries(options.params ?? {});
  if (params.length > 0) args.push('PARAMS', params.length * 2, ...params.flat());
  if (options.dialect !== undefined) args.push('DIALECT', options.dialect);
  if (options.timeoutMs !== undefined) args.push('TIMEOUT', options.timeoutMs);
  return args;
}

export async function searchQuery(
  ctx: RedisContext,
  index: string,
  query: string,
  options: SearchQueryOptions = {},
): Promise<SearchResult & { readonly durationMs: number }> {
  const started = performance.now();
  const reply = await ft(ctx, searchQueryArgs(index, query, options), options.node);
  return {
    ...parseSearchReply(toRedisReply(reply), {
      withScores: options.withScores === true,
      noContent: options.noContent === true,
    }),
    durationMs: Math.round(performance.now() - started),
  };
}

/** FT.EXPLAIN: how the engine reads a query, as its tree in text. */
export async function searchExplain(
  ctx: RedisContext,
  index: string,
  query: string,
  options: { readonly dialect?: number; readonly node?: string } = {},
): Promise<string> {
  const args: Arg[] = ['FT.EXPLAIN', index, query];
  if (options.dialect !== undefined) args.push('DIALECT', options.dialect);
  return asText(await ft(ctx, args, options.node)) ?? '';
}

export async function searchCreate(
  ctx: RedisContext,
  definition: SearchIndexDefinition,
  node?: string,
): Promise<void> {
  await ft(ctx, ['FT.CREATE', ...searchCreateArgs(definition)], node);
}

/** FT.DROPINDEX; with `deleteDocuments` (DD) the indexed keys are deleted too. */
export async function searchDrop(
  ctx: RedisContext,
  index: string,
  deleteDocuments: boolean,
  node?: string,
): Promise<void> {
  await ft(ctx, ['FT.DROPINDEX', index, ...(deleteDocuments ? ['DD'] : [])], node);
}

const SAMPLE = 50;

/**
 * Fields for a new index from up to `sample` keys under `prefix` (hashes or JSON documents):
 * each field or path with the type its values suggest. SCAN stops after 10,000 keys looked at.
 */
export async function searchSuggest(
  ctx: RedisContext,
  keyType: SearchKeyType,
  prefix: string,
  options: SearchSuggestOptions = {},
): Promise<SearchFieldSuggestion[]> {
  const node = ctx.nodeFor(options.node);
  const want = Math.max(1, Math.min(options.sample ?? SAMPLE, 500));
  const match = `${prefix.replace(/[*?[\]\\]/g, (ch) => `\\${ch}`)}*`;
  const type = keyType === 'JSON' ? 'ReJSON-RL' : 'hash';
  const keys: Uint8Array[] = [];
  let cursor = '0';
  let looked = 0;
  do {
    const [next, found] = asArray(
      await ctx.call(['SCAN', cursor, 'MATCH', match, 'COUNT', 500, 'TYPE', type], node),
    );
    cursor = asText(next) ?? '0';
    const batch = asArray(found);
    looked += 500;
    for (const key of batch) {
      const bytes = asBytes(key);
      if (bytes && keys.length < want) keys.push(bytes);
    }
  } while (cursor !== '0' && keys.length < want && looked < 10_000);

  const documents: [string, string][][] = [];
  for (const key of keys) {
    if (keyType === 'HASH') {
      const flat = asArray(await ctx.call(['HGETALL', key]));
      const pairs: [Uint8Array, Uint8Array][] = [];
      for (let i = 0; i + 1 < flat.length; i += 2) {
        const field = asBytes(flat[i]);
        const value = asBytes(flat[i + 1]);
        if (field && value) pairs.push([field, value]);
      }
      documents.push(hashFields(pairs));
    } else {
      const json = asText(await ctx.call(['JSON.GET', key, '$']).catch(() => null));
      if (json !== null) documents.push(jsonFields(json));
    }
  }
  return suggestSearchFields(documents, keyType);
}
