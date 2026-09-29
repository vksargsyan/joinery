import { JoineryError } from '@joinery/core';
import {
  member,
  nodeText,
  numberAt,
  parseJsonTree,
  parseSearchReply,
  stringAt,
  type JsonNode,
  type SearchBulkItem,
  type SearchBulkResult,
  type SearchByQueryResult,
  type SearchDocument,
  type SearchPage,
  type SearchWriteResult,
} from '@joinery/search-tools';

import { queryString, segment, type SearchContext } from './context';
import { mapResponseError } from './errors';
import { assertJsonObject } from './indices';
import type {
  ConcurrencyOptions,
  DeleteByQueryOptions,
  IndexDocumentOptions,
  SearchOpOptions,
  SearchPagingOptions,
  WriteOptions,
} from './types';

/**
 * Document services (spec §11): paged search (a point in time with search_after, or a scroll),
 * count, read by id, index / update / delete with optimistic concurrency, bulk and delete by
 * query. Documents and queries stay JSON text: bodies are assembled from the caller's member
 * texts, so no value is ever re-serialised.
 */

const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 10_000;

/** An object's members as raw "key": value texts, except the ones named. */
function membersExcept(text: string, node: JsonNode, drop: ReadonlySet<string>): string[] {
  if (node.type !== 'object') return [];
  return node.members
    .filter((m) => !drop.has(m.key))
    .map((m) => `${JSON.stringify(m.key)}: ${nodeText(text, m.value)}`);
}

function objectText(members: readonly string[]): string {
  return `{${members.join(', ')}}`;
}

function parseBody(body: string | undefined, what: string): { text: string; node: JsonNode } {
  const text = body === undefined || body.trim() === '' ? '{}' : body;
  assertJsonObject(text, what);
  return { text, node: parseJsonTree(text) };
}

/** The sort of a paged search, with the tiebreaker search_after needs. */
function pagingSort(
  ctx: SearchContext,
  text: string,
  node: JsonNode,
  mode: 'pit' | 'scroll',
): string {
  const sort = member(node, 'sort');
  const opensearch = ctx.facts.distribution === 'opensearch';
  if (mode === 'scroll') return sort ? nodeText(text, sort) : '["_doc"]';
  const tiebreaker = ctx.facts.capabilities.shardDocSort ? '{"_shard_doc": "asc"}' : '"_doc"';
  if (!sort) return `[${tiebreaker}]`;
  // Elasticsearch adds _shard_doc under a point in time itself; OpenSearch needs it spelled out.
  if (!opensearch) return nodeText(text, sort);
  const items =
    sort.type === 'array' ? sort.items.map((i) => nodeText(text, i)) : [nodeText(text, sort)];
  if (items.some((item) => item.includes('_shard_doc'))) return `[${items.join(', ')}]`;
  return `[${[...items, tiebreaker].join(', ')}]`;
}

/** Opens a point in time; undefined when the cluster refuses (the caller then scrolls). */
async function openPit(
  ctx: SearchContext,
  target: string,
  keepAlive: string,
  opts: SearchOpOptions,
): Promise<string | undefined> {
  const opensearch = ctx.facts.distribution === 'opensearch';
  const path = opensearch
    ? `/${segment(target)}/_search/point_in_time`
    : `/${segment(target)}/_pit`;
  const response = await ctx.send({ method: 'POST', path, query: `keep_alive=${keepAlive}` }, opts);
  if (response.status >= 200 && response.status < 300) {
    const root = parseJsonTree(response.body);
    return stringAt(root, opensearch ? 'pit_id' : 'id');
  }
  // A missing index is the caller's error; anything else (no privilege, no such API) scrolls.
  if (/index_not_found_exception/.test(response.body)) {
    throw mapResponseError(response.status, response.body, ctx.errorContext());
  }
  return undefined;
}

async function closePit(ctx: SearchContext, id: string): Promise<void> {
  const opensearch = ctx.facts.distribution === 'opensearch';
  await ctx.http
    .request({
      method: 'DELETE',
      path: opensearch ? '/_search/point_in_time' : '/_pit',
      body: opensearch ? JSON.stringify({ pit_id: [id] }) : JSON.stringify({ id }),
      timeoutMs: 10_000,
    })
    .catch(() => undefined);
}

async function clearScroll(ctx: SearchContext, id: string): Promise<void> {
  await ctx.http
    .request({
      method: 'DELETE',
      path: '/_search/scroll',
      body: JSON.stringify({ scroll_id: [id] }),
      timeoutMs: 10_000,
    })
    .catch(() => undefined);
}

function limitPage(
  page: ReturnType<typeof parseSearchReply>,
  remaining: number,
): ReturnType<typeof parseSearchReply> {
  return page.hits.length > remaining ? { ...page, hits: page.hits.slice(0, remaining) } : page;
}

function toPage(
  page: ReturnType<typeof parseSearchReply>,
  paging: SearchPage['paging'],
  first: boolean,
): SearchPage {
  const { scrollId: _scroll, pitId: _pit, aggregations, total, ...rest } = page;
  return {
    ...rest,
    ...(first && total ? { total } : {}),
    ...(first && aggregations !== undefined ? { aggregations } : {}),
    paging,
  };
}

/** See SearchSession.search. */
export async function* search(
  ctx: SearchContext,
  target: string,
  body: string | undefined,
  opts: SearchPagingOptions = {},
): AsyncGenerator<SearchPage> {
  const { text, node } = parseBody(body, 'search body');
  const userSize = numberAt(node, 'size');
  const maxHits = opts.maxHits ?? userSize ?? Number.POSITIVE_INFINITY;
  const pageSize = Math.max(
    1,
    Math.min(MAX_PAGE_SIZE, Math.floor(opts.pageSize ?? DEFAULT_PAGE_SIZE), Math.max(1, maxHits)),
  );
  const keepAlive = opts.keepAlive ?? '2m';
  const seqNo = opts.seqNoPrimaryTerm ?? true;
  let mode = opts.paging ?? 'auto';
  // A body that pages itself (from, search_after, a PIT) is run as it is: one page.
  if (member(node, 'from') || member(node, 'search_after') || member(node, 'pit')) mode = 'single';
  if (mode === 'auto') mode = ctx.facts.capabilities.pointInTime ? 'pit' : 'scroll';

  if (mode === 'single') {
    const members = membersExcept(text, node, new Set(['seq_no_primary_term']));
    if (userSize === undefined) members.push(`"size": ${Math.min(pageSize, maxHits)}`);
    if (seqNo) members.push('"seq_no_primary_term": true');
    const { text: reply } = await ctx.json(
      { method: 'POST', path: `/${segment(target)}/_search`, body: objectText(members) },
      opts,
    );
    yield toPage(parseSearchReply(reply), 'single', true);
    return;
  }

  const plan = { pageSize, maxHits, keepAlive, seqNo };
  if (mode === 'pit') {
    const pit = await openPit(ctx, target, keepAlive, opts);
    if (pit !== undefined) {
      let started = false;
      try {
        for await (const page of pitPages(ctx, pit, text, node, plan, opts)) {
          started = true;
          yield page;
        }
        return;
      } catch (error) {
        // A server without the _shard_doc tiebreaker refuses the first page: scroll instead.
        const refused =
          !started &&
          error instanceof JoineryError &&
          /_shard_doc/.test(`${error.message} ${error.detail ?? ''}`);
        if (!refused) throw error;
      }
    }
  }
  yield* scrollPages(ctx, target, text, node, plan, opts);
}

interface PagingPlan {
  readonly pageSize: number;
  readonly maxHits: number;
  readonly keepAlive: string;
  readonly seqNo: boolean;
}

async function* pitPages(
  ctx: SearchContext,
  pitId: string,
  text: string,
  node: JsonNode,
  plan: PagingPlan,
  opts: SearchOpOptions,
): AsyncGenerator<SearchPage> {
  let id = pitId;
  const sort = pagingSort(ctx, text, node, 'pit');
  const base = membersExcept(
    text,
    node,
    new Set(['size', 'sort', 'pit', 'search_after', 'seq_no_primary_term']),
  );
  const withoutAggs = membersExcept(
    text,
    node,
    new Set(['size', 'sort', 'pit', 'search_after', 'seq_no_primary_term', 'aggs', 'aggregations']),
  );
  let searchAfter: string | undefined;
  let yielded = 0;
  let first = true;
  try {
    while (yielded < plan.maxHits) {
      const size = Math.min(plan.pageSize, plan.maxHits - yielded);
      const members = [
        ...(first ? base : withoutAggs),
        `"size": ${size}`,
        `"sort": ${sort}`,
        `"pit": {"id": ${JSON.stringify(id)}, "keep_alive": ${JSON.stringify(plan.keepAlive)}}`,
        ...(plan.seqNo ? ['"seq_no_primary_term": true'] : []),
        ...(searchAfter !== undefined ? [`"search_after": ${searchAfter}`] : []),
        ...(first ? [] : ['"track_total_hits": false']),
      ];
      const { text: reply } = await ctx.json(
        { method: 'POST', path: '/_search', body: objectText(members) },
        opts,
      );
      const page = limitPage(parseSearchReply(reply), plan.maxHits - yielded);
      if (page.pitId !== undefined) id = page.pitId;
      yield toPage(page, 'pit', first);
      first = false;
      yielded += page.hits.length;
      const last = page.hits[page.hits.length - 1];
      if (page.hits.length < size || last?.sort === undefined) break;
      searchAfter = last.sort;
    }
  } finally {
    await closePit(ctx, id);
  }
}

async function* scrollPages(
  ctx: SearchContext,
  target: string,
  text: string,
  node: JsonNode,
  plan: PagingPlan,
  opts: SearchOpOptions,
): AsyncGenerator<SearchPage> {
  const members = [
    ...membersExcept(text, node, new Set(['size', 'sort', 'seq_no_primary_term'])),
    `"size": ${Math.min(plan.pageSize, plan.maxHits)}`,
    `"sort": ${pagingSort(ctx, text, node, 'scroll')}`,
    ...(plan.seqNo ? ['"seq_no_primary_term": true'] : []),
  ];
  let scrollId: string | undefined;
  let yielded = 0;
  try {
    const { text: reply } = await ctx.json(
      {
        method: 'POST',
        path: `/${segment(target)}/_search`,
        query: `scroll=${plan.keepAlive}`,
        body: objectText(members),
      },
      opts,
    );
    let page = limitPage(parseSearchReply(reply), plan.maxHits);
    scrollId = page.scrollId;
    yield toPage(page, 'scroll', true);
    yielded += page.hits.length;
    while (scrollId !== undefined && page.hits.length > 0 && yielded < plan.maxHits) {
      const next = await ctx.json(
        {
          method: 'POST',
          path: '/_search/scroll',
          body: JSON.stringify({ scroll: plan.keepAlive, scroll_id: scrollId }),
        },
        opts,
      );
      page = limitPage(parseSearchReply(next.text), plan.maxHits - yielded);
      scrollId = page.scrollId ?? scrollId;
      if (page.hits.length === 0) break;
      yield toPage(page, 'scroll', false);
      yielded += page.hits.length;
    }
  } finally {
    if (scrollId !== undefined) await clearScroll(ctx, scrollId);
  }
}

export async function count(
  ctx: SearchContext,
  target: string,
  query: string | undefined,
  opts: SearchOpOptions = {},
): Promise<number> {
  if (query !== undefined && query.trim() !== '') assertJsonObject(query, 'query');
  const { node } = await ctx.json(
    {
      method: 'POST',
      path: `/${segment(target)}/_count`,
      ...(query !== undefined && query.trim() !== '' ? { body: `{"query": ${query}}` } : {}),
    },
    opts,
  );
  return numberAt(node, 'count') ?? 0;
}

function documentOf(text: string, node: JsonNode): SearchDocument {
  const source = member(node, '_source');
  const seqNo = numberAt(node, '_seq_no');
  const primaryTerm = numberAt(node, '_primary_term');
  const version = numberAt(node, '_version');
  const routing = stringAt(node, '_routing');
  const found = member(node, 'found');
  return {
    index: stringAt(node, '_index') ?? '',
    id: stringAt(node, '_id') ?? '',
    found: found?.type === 'boolean' ? found.value : source !== undefined,
    ...(seqNo !== undefined ? { seqNo } : {}),
    ...(primaryTerm !== undefined ? { primaryTerm } : {}),
    ...(version !== undefined ? { version } : {}),
    ...(routing !== undefined ? { routing } : {}),
    ...(source !== undefined ? { source: nodeText(text, source) } : {}),
  };
}

export async function getDocument(
  ctx: SearchContext,
  index: string,
  id: string,
  opts: SearchOpOptions & { readonly routing?: string } = {},
): Promise<SearchDocument> {
  const request = {
    method: 'GET',
    path: `/${segment(index)}/_doc/${segment(id)}`,
    query: queryString({ routing: opts.routing }),
  };
  const response = await ctx.send(request, opts);
  // A missing document is an answer (found: false); a missing index is an error.
  if (response.status === 404 && /"found"\s*:\s*false/.test(response.body)) {
    return { index, id, found: false };
  }
  if (response.status < 200 || response.status >= 300) await ctx.call(request, opts);
  return documentOf(response.body, parseJsonTree(response.body));
}

function writeResultOf(node: JsonNode): SearchWriteResult {
  const seqNo = numberAt(node, '_seq_no');
  const primaryTerm = numberAt(node, '_primary_term');
  const version = numberAt(node, '_version');
  return {
    index: stringAt(node, '_index') ?? '',
    id: stringAt(node, '_id') ?? '',
    result: stringAt(node, 'result') ?? '',
    ...(seqNo !== undefined ? { seqNo } : {}),
    ...(primaryTerm !== undefined ? { primaryTerm } : {}),
    ...(version !== undefined ? { version } : {}),
  };
}

function writeQuery(
  opts: WriteOptions & ConcurrencyOptions,
  extra: Record<string, string | undefined> = {},
): string {
  return queryString({
    if_seq_no: opts.ifSeqNo,
    if_primary_term: opts.ifPrimaryTerm,
    refresh: opts.refresh === undefined ? undefined : String(opts.refresh),
    routing: opts.routing,
    ...extra,
  });
}

/**
 * Runs a write that may fail on optimistic concurrency. A version conflict becomes CONFLICT
 * whose detail is the current document (JSON text of `GET /<index>/_doc/<id>`), or NOT_FOUND
 * when the document is gone.
 */
async function concurrently<T>(
  ctx: SearchContext,
  index: string,
  id: string | undefined,
  opts: ConcurrencyOptions & SearchOpOptions & { readonly routing?: string },
  write: () => Promise<T>,
): Promise<T> {
  try {
    return await write();
  } catch (error) {
    if (
      !(error instanceof JoineryError) ||
      error.code !== 'CONFLICT' ||
      id === undefined ||
      opts.ifSeqNo === undefined
    ) {
      throw error;
    }
    const current = await getDocument(ctx, index, id, {
      ...(opts.routing !== undefined ? { routing: opts.routing } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
    }).catch(() => undefined);
    if (current && !current.found) {
      throw new JoineryError({
        code: 'NOT_FOUND',
        message: `The document ${id} in ${index} was deleted since it was read`,
      });
    }
    throw new JoineryError(
      {
        code: 'CONFLICT',
        message: `The document ${id} in ${index} changed since it was read`,
        hint: 'Reload it to see the current version, then apply the change again',
        ...(current?.source !== undefined ? { detail: currentDocumentText(current) } : {}),
        engineCode: 'version_conflict_engine_exception',
      },
      { cause: error },
    );
  }
}

/** The current version of a document as JSON text: its concurrency fields and `_source`. */
function currentDocumentText(document: SearchDocument): string {
  const members = [
    ...(document.seqNo !== undefined ? [`"_seq_no": ${document.seqNo}`] : []),
    ...(document.primaryTerm !== undefined ? [`"_primary_term": ${document.primaryTerm}`] : []),
    ...(document.version !== undefined ? [`"_version": ${document.version}`] : []),
    ...(document.source !== undefined ? [`"_source": ${document.source}`] : []),
  ];
  return objectText(members);
}

export async function indexDocument(
  ctx: SearchContext,
  index: string,
  source: string,
  opts: IndexDocumentOptions = {},
): Promise<SearchWriteResult> {
  assertJsonObject(source, 'document');
  const create = opts.opType === 'create';
  const path =
    opts.id === undefined
      ? `/${segment(index)}/_doc`
      : `/${segment(index)}/${create ? '_create' : '_doc'}/${segment(opts.id)}`;
  const query = writeQuery(opts, {
    pipeline: opts.pipeline,
    op_type: create && opts.id === undefined ? 'create' : undefined,
  });
  return concurrently(ctx, index, opts.id, opts, async () => {
    const { node } = await ctx.json(
      { method: opts.id === undefined ? 'POST' : 'PUT', path, query, body: source },
      opts,
    );
    return writeResultOf(node);
  });
}

export async function updateDocument(
  ctx: SearchContext,
  index: string,
  id: string,
  doc: string,
  opts: WriteOptions & ConcurrencyOptions = {},
): Promise<SearchWriteResult> {
  assertJsonObject(doc, 'document fields');
  return concurrently(ctx, index, id, opts, async () => {
    const { node } = await ctx.json(
      {
        method: 'POST',
        path: `/${segment(index)}/_update/${segment(id)}`,
        query: writeQuery(opts),
        body: `{"doc": ${doc}}`,
      },
      opts,
    );
    return writeResultOf(node);
  });
}

export async function deleteDocument(
  ctx: SearchContext,
  index: string,
  id: string,
  opts: WriteOptions & ConcurrencyOptions = {},
): Promise<SearchWriteResult> {
  return concurrently(ctx, index, id, opts, async () => {
    const request = {
      method: 'DELETE',
      path: `/${segment(index)}/_doc/${segment(id)}`,
      query: writeQuery(opts),
    };
    const response = await ctx.send(request, opts);
    // Deleting a missing document answers 404 with result "not_found": an answer, not an error.
    if (response.status === 404 && /"result"\s*:\s*"not_found"/.test(response.body)) {
      return writeResultOf(parseJsonTree(response.body));
    }
    if (response.status < 200 || response.status >= 300) await ctx.call(request, opts);
    return writeResultOf(parseJsonTree(response.body));
  });
}

const BULK_ACTIONS = new Set(['index', 'create', 'update', 'delete']);

export async function bulk(
  ctx: SearchContext,
  ndjson: string,
  opts: WriteOptions & { readonly index?: string } = {},
): Promise<SearchBulkResult> {
  const body = ndjson.endsWith('\n') ? ndjson : `${ndjson}\n`;
  const { node } = await ctx.json(
    {
      method: 'POST',
      path: opts.index ? `/${segment(opts.index)}/_bulk` : '/_bulk',
      query: queryString({
        refresh: opts.refresh === undefined ? undefined : String(opts.refresh),
        routing: opts.routing,
      }),
      body,
      contentType: 'application/x-ndjson',
    },
    opts,
  );
  const items: SearchBulkItem[] = [];
  const list = member(node, 'items');
  if (list?.type === 'array') {
    for (const item of list.items) {
      if (item.type !== 'object') continue;
      const entry = item.members[0];
      if (!entry || !BULK_ACTIONS.has(entry.key)) continue;
      const error = member(entry.value, 'error');
      const result = stringAt(entry.value, 'result');
      items.push({
        action: entry.key as SearchBulkItem['action'],
        index: stringAt(entry.value, '_index') ?? '',
        id: stringAt(entry.value, '_id') ?? null,
        status: numberAt(entry.value, 'status') ?? 0,
        ...(result !== undefined ? { result } : {}),
        ...(error !== undefined
          ? {
              error: {
                type: stringAt(error, 'type') ?? '',
                reason: stringAt(error, 'reason') ?? (error.type === 'string' ? error.value : ''),
              },
            }
          : {}),
      });
    }
  }
  const errors = member(node, 'errors');
  return {
    took: numberAt(node, 'took') ?? 0,
    errors: errors?.type === 'boolean' ? errors.value : items.some((i) => i.error),
    items,
  };
}

export async function deleteByQuery(
  ctx: SearchContext,
  target: string,
  query: string,
  opts: DeleteByQueryOptions = {},
): Promise<SearchByQueryResult> {
  assertJsonObject(query, 'query');
  if (opts.dryRun) {
    const total = await count(ctx, target, query, opts);
    return {
      dryRun: true,
      total,
      deleted: 0,
      versionConflicts: 0,
      failures: 0,
      took: 0,
      timedOut: false,
    };
  }
  const { node } = await ctx.json(
    {
      method: 'POST',
      path: `/${segment(target)}/_delete_by_query`,
      query: queryString({ refresh: opts.refresh, conflicts: opts.conflicts }),
      body: `{"query": ${query}}`,
    },
    opts,
  );
  const failures = member(node, 'failures');
  const timedOut = member(node, 'timed_out');
  return {
    dryRun: false,
    total: numberAt(node, 'total') ?? 0,
    deleted: numberAt(node, 'deleted') ?? 0,
    versionConflicts: numberAt(node, 'version_conflicts') ?? 0,
    failures: failures?.type === 'array' ? failures.items.length : 0,
    took: numberAt(node, 'took') ?? 0,
    timedOut: timedOut?.type === 'boolean' && timedOut.value,
  };
}
