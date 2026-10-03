import {
  aggregationsOf,
  bodyErrorOffset,
  booleanAt,
  formatConsoleRequest,
  formatJson,
  issuesOf,
  member,
  nodeAt,
  numberAt,
  parseConsole,
  parseJsonTree,
  parseSearchError,
  requestsIn,
  stringAt,
  type ConsoleRequest,
  type JsonNode,
  type SearchRequest,
  type SearchResponse,
} from '@querybara/search-tools';

import {
  decideSearchRequest,
  type SearchWriteDecision,
  type SearchWritePolicy,
} from '../../../../shared/search-writes';

/**
 * The console's run flow (spec §11), free of React and IPC so it can be tested: which requests
 * a run sends (the one at the cursor, or every one the selection touches), the write rules
 * before each (refuse, ask, run), and how a response is shown (JSON re-indented without
 * touching a token, text as it came, the error's reason and position).
 */

/** One request as the console shows and sends it. */
export interface PlannedRequest {
  readonly request: ConsoleRequest;
  /** "GET /orders/_search". */
  readonly label: string;
  /** What is sent. */
  readonly wire: SearchRequest;
  /** The console text of the request, for the history and confirmations. */
  readonly text: string;
  /** Why it cannot be sent (a syntax issue), when it cannot. */
  readonly problem?: { readonly offset: number; readonly message: string };
}

function labelOf(request: Pick<ConsoleRequest, 'method' | 'path' | 'query'>): string {
  return `${request.method} ${request.path}${request.query ? `?${request.query}` : ''}`;
}

/**
 * The requests a run sends: the one at the cursor (the last one starting before it), or with a
 * selection every request it touches. Empty when there is none.
 */
export function plannedRequests(text: string, start: number, end = start): PlannedRequest[] {
  const parse = parseConsole(text);
  return requestsIn(parse.requests, start, end).map((request) => {
    const issue = issuesOf(parse, request)[0];
    return {
      request,
      label: labelOf(request),
      wire: {
        method: request.method,
        path: request.path,
        ...(request.query ? { query: request.query } : {}),
        ...(request.body !== undefined ? { body: request.body } : {}),
        ...(request.bodyKind === 'ndjson' ? { bodyKind: 'ndjson' as const } : {}),
      },
      text: text.slice(request.start, request.end),
      ...(request.invalid
        ? {
            problem: {
              offset: issue?.start ?? request.start,
              message: issue?.message ?? 'The request is not valid',
            },
          }
        : {}),
    };
  });
}

/** What the response pane shows for one request. */
export interface ConsoleResponseView {
  readonly label: string;
  /** Undefined when no response came (refused, cancelled, the network failed). */
  readonly status?: number;
  /** Pretty JSON, or the body as it came (text/plain for _cat), or the failure. */
  readonly body: string;
  readonly contentType: string;
  readonly durationMs: number;
  readonly warnings: readonly string[];
  readonly truncated: boolean;
  /** The error's reason (and hint), for a failing status or a failure without a response. */
  readonly error?: string;
  /** Where the server says the body is wrong, as an offset of the console text. */
  readonly errorOffset?: number;
  /** What the response says in a few words: "3 hits", "created", "5 deleted"... */
  readonly summary?: string;
  /** The `aggregations` of a search response (JSON text), shown as a tree and a table. */
  readonly aggregations?: string;
}

const count = new Intl.NumberFormat('en-US');

/** A few words on what a JSON response says; undefined when there is nothing to say. */
export function summarize(body: string): string | undefined {
  let root: JsonNode;
  try {
    root = parseJsonTree(body);
  } catch {
    return undefined;
  }
  if (root.type !== 'object') return undefined;
  const total = nodeAt(root, ['hits', 'total']);
  if (total !== undefined) {
    const value = numberAt(total, 'value') ?? (total.type === 'number' ? Number(total.text) : 0);
    const more = stringAt(total, 'relation') === 'gte' ? '+' : '';
    return `${count.format(value)}${more} ${value === 1 && !more ? 'hit' : 'hits'}`;
  }
  const hitsCount = numberAt(root, 'count');
  if (hitsCount !== undefined && member(root, '_shards')) return `count ${count.format(hitsCount)}`;
  const items = member(root, 'items');
  if (items?.type === 'array') {
    const failed = items.items.filter((item) =>
      item.type === 'object' && item.members[0]
        ? member(item.members[0].value, 'error') !== undefined
        : false,
    ).length;
    return `${count.format(items.items.length)} items, ${failed === 0 ? 'no errors' : `${count.format(failed)} failed`}`;
  }
  const deleted = numberAt(root, 'deleted');
  if (deleted !== undefined && member(root, 'total')) return `${count.format(deleted)} deleted`;
  const updated = numberAt(root, 'updated');
  if (updated !== undefined && member(root, 'total')) return `${count.format(updated)} updated`;
  const result = stringAt(root, 'result');
  if (result !== undefined) return result.replace(/_/g, ' ');
  if (member(root, 'acknowledged')?.type === 'boolean') {
    return booleanAt(root, 'acknowledged') ? 'acknowledged' : 'not acknowledged';
  }
  const found = member(root, 'found');
  if (found?.type === 'boolean') return found.value ? 'found' : 'not found';
  const health = stringAt(root, 'status');
  if (health !== undefined && member(root, 'cluster_name')) return `cluster ${health}`;
  return undefined;
}

/** "200 OK"-style text for a status. */
export function statusText(status: number): string {
  const names: Readonly<Record<number, string>> = {
    200: 'OK',
    201: 'Created',
    400: 'Bad Request',
    401: 'Unauthorized',
    403: 'Forbidden',
    404: 'Not Found',
    405: 'Method Not Allowed',
    409: 'Conflict',
    413: 'Payload Too Large',
    429: 'Too Many Requests',
    500: 'Internal Server Error',
    502: 'Bad Gateway',
    503: 'Service Unavailable',
    504: 'Gateway Timeout',
  };
  return `${status}${names[status] ? ` ${names[status]}` : ''}`;
}

/** The response pane's view of a response (see ConsoleResponseView). */
export function responseView(
  planned: PlannedRequest,
  response: SearchResponse,
): ConsoleResponseView {
  let body = response.body;
  if (response.contentType.includes('json') && body.trim() !== '' && !response.truncated) {
    try {
      body = formatJson(body);
    } catch {
      // Shown as it came.
    }
  }
  const failed = response.status >= 400;
  const info = failed ? parseSearchError(response.body) : undefined;
  const errorOffset =
    info?.line !== undefined && info.column !== undefined
      ? bodyErrorOffset(planned.request, info.line, info.column)
      : undefined;
  const summary = failed ? undefined : summarize(response.body);
  const aggregations = failed || response.truncated ? undefined : aggregationsOf(response.body);
  return {
    label: planned.label,
    status: response.status,
    body,
    contentType: response.contentType,
    durationMs: response.durationMs,
    warnings: response.warnings,
    truncated: response.truncated,
    ...(info
      ? {
          error:
            info.causedBy && !info.reason.includes(info.causedBy)
              ? `${info.reason}: ${info.causedBy}`
              : info.reason,
        }
      : {}),
    ...(errorOffset !== undefined ? { errorOffset } : {}),
    ...(summary !== undefined ? { summary } : {}),
    ...(aggregations !== undefined ? { aggregations } : {}),
  };
}

/** The pane's view of a request that got no response: the message shows above an empty body. */
export function failureView(planned: PlannedRequest, message: string): ConsoleResponseView {
  return {
    label: planned.label,
    body: '',
    contentType: 'text/plain',
    durationMs: 0,
    warnings: [],
    truncated: false,
    error: message,
  };
}

export interface RunDeps {
  readonly policy: SearchWritePolicy;
  /** Asks the user before a request the rules stop; resolves true to send it. */
  confirm(
    planned: PlannedRequest,
    decision: Extract<SearchWriteDecision, { action: 'confirm' }>,
  ): Promise<boolean>;
  /** Sends one request (with the confirmation the rules asked for). */
  send(planned: PlannedRequest, confirmed: boolean): Promise<SearchResponse>;
  /** Called with each request's view as it completes. */
  onResult(view: ConsoleResponseView, planned: PlannedRequest): void;
}

/**
 * Sends the planned requests in order under the write rules: a request with a syntax issue, a
 * refused write or a declined confirmation stops the run (and says why); a failing status does
 * not, as in Kibana. A thrown error (cancelled, network) stops the run and is rethrown.
 */
export async function runRequests(
  planned: readonly PlannedRequest[],
  deps: RunDeps,
): Promise<void> {
  for (const item of planned) {
    if (item.problem) {
      deps.onResult(failureView(item, item.problem.message), item);
      return;
    }
    const decision = decideSearchRequest(item.wire, deps.policy);
    if (decision.action === 'refuse') {
      deps.onResult(failureView(item, `${decision.reason}: ${item.label} was not sent`), item);
      return;
    }
    let confirmed = false;
    if (decision.action === 'confirm') {
      confirmed = await deps.confirm(item, decision);
      if (!confirmed) {
        deps.onResult(failureView(item, `${item.label} was not sent`), item);
        return;
      }
    }
    const response = await deps.send(item, confirmed);
    deps.onResult(responseView(item, response), item);
  }
}

/** The requests of a console history, newest first, without repeating the last one. */
export class ConsoleHistory {
  #entries: string[];

  constructor(
    entries: readonly string[] = [],
    private readonly limit = 100,
  ) {
    this.#entries = entries.slice(0, limit);
  }

  get entries(): readonly string[] {
    return this.#entries;
  }

  push(text: string): void {
    const entry = text.trim();
    if (entry === '' || this.#entries[0] === entry) return;
    this.#entries = [entry, ...this.#entries.filter((e) => e !== entry)].slice(0, this.limit);
  }
}

/** Re-indents the JSON bodies of the requests a selection (or the cursor) touches. */
export function autoIndent(text: string, start: number, end = start): string {
  const parse = parseConsole(text);
  const targets = requestsIn(parse.requests, start, end).filter(
    (r) => !r.invalid && r.body !== undefined && r.bodyKind === 'json',
  );
  let out = text;
  for (const request of [...targets].reverse()) {
    const formatted = formatConsoleRequest({
      method: request.method,
      path: request.path,
      query: request.query,
      body: formatJson(request.body!),
      bodyKind: 'json',
    });
    out = out.slice(0, request.start) + formatted + out.slice(request.end);
  }
  return out;
}
