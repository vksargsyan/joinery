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
 * SQL and ES|QL (spec §11): the requests for Elasticsearch's SQL API (`/_sql`), OpenSearch's
 * SQL plugin (`/_plugins/_sql`) and ES|QL (`/_query`), and one reader for their three reply
 * shapes. Cells stay JSON text as the server wrote them, so a 64-bit number is shown exactly.
 * "Translate to DSL" uses `_sql/translate` (Elasticsearch) or the plugin's `_explain`
 * (OpenSearch), whose DSL sits inside the plan it prints.
 */

/** Which SQL endpoint a cluster has (SearchCapabilities.sql). */
export type SqlDialect = 'elasticsearch' | 'opensearch';

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
  /** Rows in all, when the server says (OpenSearch). */
  readonly total?: number;
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
  /** The server's reply as it came (a plan, on OpenSearch). */
  readonly raw: string;
}

export interface SqlRequestOptions {
  /** Rows per page (the cursor reads the next ones); default 1,000. */
  readonly fetchSize?: number;
  /** Elasticsearch only: the time zone dates are shown in, e.g. "Europe/Paris". */
  readonly timeZone?: string;
}

/** The request that runs a SQL query. */
export function sqlRequest(
  dialect: SqlDialect,
  query: string,
  options: SqlRequestOptions = {},
): SearchRequest {
  const members = [
    `"query": ${JSON.stringify(query)}`,
    `"fetch_size": ${Math.max(1, Math.floor(options.fetchSize ?? 1000))}`,
    ...(dialect === 'elasticsearch' && options.timeZone
      ? [`"time_zone": ${JSON.stringify(options.timeZone)}`]
      : []),
  ];
  return dialect === 'opensearch'
    ? {
        method: 'POST',
        path: '/_plugins/_sql',
        query: 'format=jdbc',
        body: `{${members.join(', ')}}`,
      }
    : { method: 'POST', path: '/_sql', query: 'format=json', body: `{${members.join(', ')}}` };
}

/** The request that reads the next page of a SQL cursor. */
export function sqlCursorRequest(dialect: SqlDialect, cursor: string): SearchRequest {
  const body = `{"cursor": ${JSON.stringify(cursor)}}`;
  return dialect === 'opensearch'
    ? { method: 'POST', path: '/_plugins/_sql', query: 'format=jdbc', body }
    : { method: 'POST', path: '/_sql', query: 'format=json', body };
}

/** The request that releases a SQL cursor before its last page. */
export function sqlCloseRequest(dialect: SqlDialect, cursor: string): SearchRequest {
  return {
    method: 'POST',
    path: dialect === 'opensearch' ? '/_plugins/_sql/close' : '/_sql/close',
    body: `{"cursor": ${JSON.stringify(cursor)}}`,
  };
}

/** The request that translates SQL to Query DSL (or, on OpenSearch, explains it). */
export function sqlTranslateRequest(dialect: SqlDialect, query: string): SearchRequest {
  return {
    method: 'POST',
    path: dialect === 'opensearch' ? '/_plugins/_sql/_explain' : '/_sql/translate',
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
 * Reads a SQL or ES|QL reply: Elasticsearch SQL (`columns` on the first page, `rows`,
 * `cursor`), the OpenSearch plugin's JDBC format (`schema`, `datarows`, `total`, `cursor`) and
 * ES|QL (`columns`, `values`, `is_partial`, `took`). Later SQL pages carry no columns; the
 * caller keeps the first page's.
 */
export function parseTableReply(body: string): SearchTable {
  const root = parseJsonTree(body);
  const cursor = stringAt(root, 'cursor');
  const took = numberAt(root, 'took');
  if (member(root, 'datarows') !== undefined || member(root, 'schema') !== undefined) {
    const total = numberAt(root, 'total');
    return {
      columns: columnsOf(member(root, 'schema')),
      rows: rowsOf(body, member(root, 'datarows')),
      ...(cursor !== undefined && cursor !== '' ? { cursor } : {}),
      ...(total !== undefined ? { total } : {}),
    };
  }
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
 * `FROM "logs-*"`, `FROM logs`, or a backquoted name.
 */
export function sqlFromTarget(query: string): string | undefined {
  const match = /\bFROM\s+(?:"((?:[^"]|"")+)"|`([^`]+)`|([^\s,;()]+))/i.exec(query);
  if (!match) return undefined;
  const name = match[1]?.replace(/""/g, '"') ?? match[2] ?? match[3];
  return name === undefined || name === '' ? undefined : name;
}

/**
 * The Query DSL a translate or explain reply holds. Elasticsearch's `_sql/translate` answers
 * with the search body itself; OpenSearch's `_explain` prints its plan, where the legacy
 * engine returns the DSL at the top and the new one embeds it as `sourceBuilder={...}` in a
 * scan's description. Undefined when no DSL can be found (the plan is then shown as is).
 */
export function translatedDsl(dialect: SqlDialect, body: string): string | undefined {
  let root: JsonNode;
  try {
    root = parseJsonTree(body);
  } catch {
    return undefined;
  }
  if (root.type !== 'object') return undefined;
  const looksLikeDsl = (node: JsonNode): boolean =>
    node.type === 'object' &&
    ['query', 'size', 'from', '_source', 'sort', 'aggregations', 'aggs', 'fields'].some(
      (key) => member(node, key) !== undefined,
    );
  if (dialect === 'elasticsearch' || looksLikeDsl(root)) {
    return looksLikeDsl(root) ? body : undefined;
  }
  // Every string of the plan, depth first, until one embeds a source builder.
  const strings: string[] = [];
  const collect = (node: JsonNode): void => {
    if (node.type === 'string') strings.push(node.value);
    else if (node.type === 'object') node.members.forEach((m) => collect(m.value));
    else if (node.type === 'array') node.items.forEach(collect);
  };
  collect(root);
  for (const value of strings) {
    const at = value.indexOf('sourceBuilder=');
    if (at < 0) continue;
    const start = value.indexOf('{', at);
    if (start < 0) continue;
    const dsl = balancedObject(value, start);
    if (dsl !== undefined) return dsl;
  }
  return undefined;
}

/** The JSON object starting at `start` in `text`, if it is complete and valid. */
function balancedObject(text: string, start: number): string | undefined {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const char = text[i];
    if (inString) {
      if (char === '\\') i++;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{') depth++;
    else if (char === '}') {
      depth--;
      if (depth === 0) {
        const candidate = text.slice(start, i + 1);
        try {
          parseJsonTree(candidate);
          return candidate;
        } catch {
          return undefined;
        }
      }
    }
  }
  return undefined;
}
