import { member, nodeAt, nodeText, numberAt, parseJsonTree, stringAt, type JsonNode } from './json';
import type { SearchHit, SearchPage } from './wire';

/**
 * Readers for Elasticsearch replies that keep documents as text: a search
 * reply's hits with their `_source` sliced out of the reply, and the error object every failing
 * request returns. Shared by the driver and the renderer.
 */

/** The error a failing request returned, as far as it can be read. */
export interface SearchErrorInfo {
  /** e.g. "index_not_found_exception"; "" when the body has none. */
  readonly type: string;
  readonly reason: string;
  /** The first root cause's type and reason, when it differs from the error itself. */
  readonly rootCause?: { readonly type: string; readonly reason: string };
  /** The deepest `caused_by` reason, which often says what is really wrong. */
  readonly causedBy?: string;
  /** 1-based position in the request body of a parse error. */
  readonly line?: number;
  readonly column?: number;
  /** The index named by the error, when there is one. */
  readonly index?: string;
}

function tree(text: string): JsonNode | undefined {
  try {
    return parseJsonTree(text);
  } catch {
    return undefined;
  }
}

/** A position written as "[3:1]" or "line: 3, column: 1" in a reason. */
function positionIn(reason: string): { line: number; column: number } | undefined {
  const bracket = /^\[(\d+):(\d+)\]/.exec(reason);
  if (bracket) return { line: Number(bracket[1]), column: Number(bracket[2]) };
  const words = /line: (\d+), column: (\d+)/.exec(reason);
  if (words) return { line: Number(words[1]), column: Number(words[2]) };
  return undefined;
}

/**
 * Reads the error of a failing request: Elasticsearch's
 * `{"error": {"type", "reason", "root_cause": [...], "caused_by": {...}}, "status"}`, the plain
 * `{"error": "no handler found..."}` form, and non-JSON bodies. Undefined for an empty body.
 */
export function parseSearchError(body: string): SearchErrorInfo | undefined {
  const text = body.trim();
  if (text === '') return undefined;
  const root = tree(text);
  if (!root) return { type: '', reason: text.slice(0, 500) };
  const error = member(root, 'error');
  if (error?.type === 'string') return { type: '', reason: error.value };
  if (error?.type !== 'object') {
    const message = stringAt(root, 'message') ?? stringAt(root, 'reason');
    return message !== undefined ? { type: '', reason: message } : undefined;
  }
  const type = stringAt(error, 'type') ?? '';
  const reason = stringAt(error, 'reason') ?? type;
  const cause = nodeAt(error, ['root_cause', 0]);
  const rootType = stringAt(cause, 'type');
  const rootReason = stringAt(cause, 'reason');
  let deepest: string | undefined;
  for (let c = member(error, 'caused_by'); c !== undefined; c = member(c, 'caused_by')) {
    deepest = stringAt(c, 'reason') ?? deepest;
  }
  const line = numberAt(error, 'line') ?? numberAt(cause, 'line');
  const column = numberAt(error, 'col') ?? numberAt(cause, 'col');
  const position =
    line !== undefined && column !== undefined
      ? { line, column }
      : (positionIn(reason) ?? (deepest !== undefined ? positionIn(deepest) : undefined));
  const index = stringAt(error, 'index') ?? stringAt(cause, 'index');
  return {
    type,
    reason,
    ...(rootType !== undefined && (rootType !== type || rootReason !== reason)
      ? { rootCause: { type: rootType, reason: rootReason ?? rootType } }
      : {}),
    ...(deepest !== undefined && deepest !== reason ? { causedBy: deepest } : {}),
    ...(position ? { line: position.line, column: position.column } : {}),
    ...(index !== undefined ? { index } : {}),
  };
}

function hitOf(text: string, node: JsonNode): SearchHit {
  const raw = (key: string): string | undefined => {
    const value = member(node, key);
    return value === undefined || value.type === 'null' ? undefined : nodeText(text, value);
  };
  const score = member(node, '_score');
  const seqNo = numberAt(node, '_seq_no');
  const primaryTerm = numberAt(node, '_primary_term');
  const version = numberAt(node, '_version');
  const routing = stringAt(node, '_routing');
  const source = raw('_source');
  const fields = raw('fields');
  const highlight = raw('highlight');
  const sort = raw('sort');
  return {
    index: stringAt(node, '_index') ?? '',
    id: stringAt(node, '_id') ?? '',
    score: score?.type === 'number' ? Number(score.text) : null,
    ...(source !== undefined ? { source } : {}),
    ...(fields !== undefined ? { fields } : {}),
    ...(highlight !== undefined ? { highlight } : {}),
    ...(sort !== undefined ? { sort } : {}),
    ...(seqNo !== undefined ? { seqNo } : {}),
    ...(primaryTerm !== undefined ? { primaryTerm } : {}),
    ...(version !== undefined ? { version } : {}),
    ...(routing !== undefined ? { routing } : {}),
  };
}

/** A search reply's hits and totals (see SearchPage); `paging` is filled in by the caller. */
export function parseSearchReply(body: string): Omit<SearchPage, 'paging'> & {
  /** The scroll id (a scroll search) or the point in time id to pass on. */
  readonly scrollId?: string;
  readonly pitId?: string;
} {
  const root = parseJsonTree(body);
  const hitsNode = nodeAt(root, ['hits', 'hits']);
  const hits = hitsNode?.type === 'array' ? hitsNode.items.map((h) => hitOf(body, h)) : [];
  const totalNode = nodeAt(root, ['hits', 'total']);
  let total: SearchPage['total'];
  if (totalNode?.type === 'number') total = { value: Number(totalNode.text), relation: 'eq' };
  else if (totalNode?.type === 'object') {
    total = {
      value: numberAt(totalNode, 'value') ?? 0,
      relation: stringAt(totalNode, 'relation') === 'gte' ? 'gte' : 'eq',
    };
  }
  const aggregations = member(root, 'aggregations');
  const timedOut = member(root, 'timed_out');
  const scrollId = stringAt(root, '_scroll_id');
  const pitId = stringAt(root, 'pit_id');
  return {
    hits,
    ...(total ? { total } : {}),
    took: numberAt(root, 'took') ?? 0,
    timedOut: timedOut?.type === 'boolean' && timedOut.value,
    ...(aggregations ? { aggregations: nodeText(body, aggregations) } : {}),
    ...(scrollId !== undefined ? { scrollId } : {}),
    ...(pitId !== undefined ? { pitId } : {}),
  };
}
