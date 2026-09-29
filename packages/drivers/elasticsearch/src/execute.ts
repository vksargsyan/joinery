import {
  JoineryError,
  toColumnChunk,
  type ColumnMeta,
  type ExecOptions,
  type ResultChunk,
} from '@joinery/core';
import {
  issuesOf,
  parseConsole,
  sourceOffset,
  type SearchRequest,
  type SearchResponse,
} from '@joinery/search-tools';

import type { SearchContext } from './context';
import { mapResponseError } from './errors';
import { contentTypeOf, warningsOf } from './http';
import type { RequestOptions } from './types';

/** The one column of every `execute` result: each request's response body. */
export const RESPONSE_COLUMN: ColumnMeta = {
  name: 'response',
  nativeType: 'json',
  kind: 'json',
};

/** Bytes of a console response kept; the rest is cut (and flagged). */
export const CONSOLE_MAX_BYTES = 32 * 1024 * 1024;

/** See SearchSession.request. */
export async function sendRequest(
  ctx: SearchContext,
  request: SearchRequest,
  opts: RequestOptions = {},
): Promise<SearchResponse> {
  const contentType = request.bodyKind === 'ndjson' ? 'application/x-ndjson' : 'application/json';
  const response = await ctx.send(
    {
      method: request.method,
      path: request.path.startsWith('/') ? request.path : `/${request.path}`,
      ...(request.query ? { query: request.query } : {}),
      ...(request.body !== undefined ? { body: request.body, contentType } : {}),
      maxBytes: opts.maxBytes ?? CONSOLE_MAX_BYTES,
    },
    opts,
  );
  return {
    status: response.status,
    contentType: contentTypeOf(response.headers),
    body: response.body,
    durationMs: response.durationMs,
    warnings: warningsOf(response.headers),
    truncated: response.truncated,
  };
}

/** Rows a by-query or write response reports as affected, for the status chunk. */
function affected(body: string): number | null {
  const pick = (key: string): number | undefined => {
    const match = new RegExp(`"${key}"\\s*:\\s*(\\d+)`).exec(body);
    return match ? Number(match[1]) : undefined;
  };
  return pick('deleted') ?? pick('updated') ?? pick('created') ?? null;
}

/**
 * The generic Session.execute: runs Kibana console text (one or more requests) in order, each
 * as its own result set with one `response` cell holding the body as text. Deprecation warnings
 * become notices. A failing request throws its mapped error (whose `detail` is the error body)
 * and stops the rest, as a SQL script stops at a failing statement.
 */
export async function* executeConsole(
  ctx: SearchContext,
  text: string,
  opts: ExecOptions,
): AsyncGenerator<ResultChunk> {
  const started = performance.now();
  if (
    opts.params !== undefined &&
    (Array.isArray(opts.params) ? opts.params.length > 0 : Object.keys(opts.params).length > 0)
  ) {
    throw new JoineryError({
      code: 'NOT_SUPPORTED',
      message: 'Console requests take no parameters; write the values into the request',
    });
  }
  const parse = parseConsole(text);
  if (parse.requests.length === 0) {
    const issue = parse.issues[0];
    throw new JoineryError({
      code: 'VALIDATION_FAILED',
      message: issue?.message ?? 'No request to run: write one such as GET /_search',
      ...(issue ? { position: issue.start } : {}),
    });
  }
  const invalid = parse.requests.find((r) => r.invalid);
  if (invalid) {
    const issue = issuesOf(parse, invalid)[0];
    throw new JoineryError({
      code: 'VALIDATION_FAILED',
      message: `${invalid.method} ${invalid.path}: ${issue?.message ?? 'the request is not valid'}`,
      ...(issue ? { position: issue.start } : {}),
    });
  }
  let rowCount = 0;
  for (const [index, request] of parse.requests.entries()) {
    const response = await sendRequest(
      ctx,
      {
        method: request.method,
        path: request.path,
        ...(request.query ? { query: request.query } : {}),
        ...(request.body !== undefined ? { body: request.body } : {}),
        ...(request.bodyKind === 'ndjson' ? { bodyKind: 'ndjson' as const } : {}),
      },
      { executionId: opts.executionId, ...(opts.signal ? { signal: opts.signal } : {}) },
    );
    if (response.status < 200 || response.status >= 300) {
      const error = mapResponseError(
        response.status,
        response.body,
        ctx.errorContext(request.body !== undefined ? { requestBody: request.body } : {}),
      );
      const offset =
        error.position !== undefined && request.body !== undefined
          ? sourceOffset(request.bodyMap, error.position)
          : undefined;
      throw new JoineryError(
        {
          ...error.toJSON(),
          message: `${request.method} ${request.path}: ${error.message}`,
          ...(offset !== undefined ? { position: offset } : {}),
        },
        { cause: error },
      );
    }
    yield { type: 'columns', resultIndex: index, columns: [RESPONSE_COLUMN] };
    yield toColumnChunk(index, 1, [[response.body]]);
    rowCount += 1;
    for (const warning of response.warnings) {
      yield { type: 'notice', severity: 'warning', message: warning };
    }
    if (response.truncated) {
      yield {
        type: 'notice',
        severity: 'warning',
        message: `The response was cut at ${CONSOLE_MAX_BYTES / 1024 / 1024} MiB`,
      };
    }
    yield {
      type: 'status',
      command: `${request.method} ${request.path} → ${response.status}`,
      rowsAffected:
        request.method === 'GET' || request.method === 'HEAD' ? null : affected(response.body),
    };
  }
  yield { type: 'end', durationMs: Math.round(performance.now() - started), rowCount };
}
