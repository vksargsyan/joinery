import {
  compactJson,
  member,
  nodeText,
  numberAt,
  parseJsonTree,
  readJsonString,
  stringAt,
  type JsonNode,
} from './json';
import type { SearchRequest } from './wire';

/**
 * SQL and ES|QL (spec §11): the requests for the SQL API (`/_sql`) and ES|QL (`/_query`), and
 * one reader for both reply shapes. Cells stay JSON text as the server wrote them, so a 64-bit
 * number is shown exactly. "Translate to DSL" uses `_sql/translate`, which answers with the
 * search body itself.
 */

export interface SearchTableColumn {
  readonly name: string;
  /** The server's type name: "keyword", "long", "datetime"... */
  readonly type: string;
}

/** A page of tabular results. */
export interface SearchTable {
  readonly columns: readonly SearchTableColumn[];
  /** Each cell is JSON text as the server wrote it: `"text"`, `12345678901234567890`, `null`. */
  readonly rows: readonly (readonly string[])[];
  /** More rows can be read with this cursor (SQL). */
  readonly cursor?: string;
  /** A paged stream has another page after this one (the cursor stays with the driver). */
  readonly more?: boolean;
  /** ES|QL answered from part of the data (a shard or cluster failed). */
  readonly partial?: boolean;
  readonly tookMs?: number;
}

/** "Translate to DSL": the Query DSL of a SQL query, and the index it reads. */
export interface SqlTranslation {
  /** The search body (JSON text); undefined when the server's plan holds none. */
  readonly dsl?: string;
  /** The index, alias or pattern of the query's FROM clause. */
  readonly target?: string;
  /** The server's reply as it came. */
  readonly raw: string;
}

export interface SqlRequestOptions {
  /** Rows per page (the cursor reads the next ones); default 1,000. */
  readonly fetchSize?: number;
  /** The time zone dates are shown in, e.g. "Europe/Paris". */
  readonly timeZone?: string;
}

/** The request that runs a SQL query. */
export function sqlRequest(query: string, options: SqlRequestOptions = {}): SearchRequest {
  const members = [
    `"query": ${JSON.stringify(query)}`,
    `"fetch_size": ${Math.max(1, Math.floor(options.fetchSize ?? 1000))}`,
    ...(options.timeZone ? [`"time_zone": ${JSON.stringify(options.timeZone)}`] : []),
  ];
  return { method: 'POST', path: '/_sql', query: 'format=json', body: `{${members.join(', ')}}` };
}

/** The request that reads the next page of a SQL cursor. */
export function sqlCursorRequest(cursor: string): SearchRequest {
  return {
    method: 'POST',
    path: '/_sql',
    query: 'format=json',
    body: `{"cursor": ${JSON.stringify(cursor)}}`,
  };
}

/** The request that releases a SQL cursor before its last page. */
export function sqlCloseRequest(cursor: string): SearchRequest {
  return { method: 'POST', path: '/_sql/close', body: `{"cursor": ${JSON.stringify(cursor)}}` };
}

/** The request that translates SQL to Query DSL. */
export function sqlTranslateRequest(query: string): SearchRequest {
  return {
    method: 'POST',
    path: '/_sql/translate',
    body: `{"query": ${JSON.stringify(query)}}`,
  };
}

/** The request that runs an ES|QL query. */
export function esqlRequest(query: string): SearchRequest {
  return {
    method: 'POST',
    path: '/_query',
    query: 'format=json',
    body: `{"query": ${JSON.stringify(query)}}`,
  };
}

function columnsOf(node: JsonNode | undefined): SearchTableColumn[] {
  if (node?.type !== 'array') return [];
  return node.items.map((item) => ({
    name: stringAt(item, 'name') ?? stringAt(item, 'alias') ?? '',
    type: stringAt(item, 'type') ?? '',
  }));
}

function rowsOf(text: string, node: JsonNode | undefined): string[][] {
  if (node?.type !== 'array') return [];
  return node.items.map((row) =>
    row.type === 'array' ? row.items.map((cell) => nodeText(text, cell)) : [nodeText(text, row)],
  );
}

/**
 * Reads a SQL or ES|QL reply: SQL (`columns` on the first page, `rows`, `cursor`) and ES|QL
 * (`columns`, `values`, `is_partial`, `took`). Later SQL pages carry no columns; the caller
 * keeps the first page's.
 */
export function parseTableReply(body: string): SearchTable {
  const root = parseJsonTree(body);
  const cursor = stringAt(root, 'cursor');
  const took = numberAt(root, 'took');
  const values = member(root, 'values');
  const partial = member(root, 'is_partial');
  return {
    columns: columnsOf(member(root, 'columns')),
    rows: rowsOf(body, values ?? member(root, 'rows')),
    ...(cursor !== undefined && cursor !== '' ? { cursor } : {}),
    ...(partial?.type === 'boolean' && partial.value ? { partial: true } : {}),
    ...(took !== undefined ? { tookMs: took } : {}),
  };
}

/** What a cell shows: a string's value, anything else as the server wrote it (compacted). */
export function cellDisplay(json: string): string {
  const trimmed = json.trim();
  if (trimmed.startsWith('"')) {
    try {
      return readJsonString(trimmed, 0).value;
    } catch {
      return trimmed;
    }
  }
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return compactJson(trimmed);
    } catch {
      return trimmed;
    }
  }
  return trimmed;
}

/**
 * The index a SQL query reads (its first FROM target), for running the translated DSL:
 * `FROM "logs-*"` or `FROM logs`.
 */
export function sqlFromTarget(query: string): string | undefined {
  const match = /\bFROM\s+(?:"((?:[^"]|"")+)"|([^\s,;()]+))/i.exec(query);
  if (!match) return undefined;
  const name = match[1]?.replace(/""/g, '"') ?? match[2];
  return name === undefined || name === '' ? undefined : name;
}

/**
 * The Query DSL of a `_sql/translate` reply: the reply is the search body itself. Undefined when
 * it does not read as one (the reply is then shown as is).
 */
export function translatedDsl(body: string): string | undefined {
  let root: JsonNode;
  try {
    root = parseJsonTree(body);
  } catch {
    return undefined;
  }
  return root.type === 'object' &&
    ['query', 'size', 'from', '_source', 'sort', 'aggregations', 'aggs', 'fields'].some(
      (key) => member(root, key) !== undefined,
    )
    ? body
    : undefined;
}
