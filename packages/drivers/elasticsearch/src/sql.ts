import { QuerybaraError } from '@querybara/core';
import {
  esqlRequest,
  parseTableReply,
  sqlCloseRequest,
  sqlCursorRequest,
  sqlFromTarget,
  sqlRequest,
  sqlTranslateRequest,
  translatedDsl,
  type SearchRequest,
  type SearchTable,
} from '@querybara/search-tools';

import type { SearchContext } from './context';
import type { SearchOpOptions, SqlQueryOptions, SqlTranslation } from './types';

/**
 * SQL and ES|QL (spec §11): SQL through the SQL API, paged with the server's cursor (closed
 * when the reader stops early), "Translate to DSL", and ES|QL where the cluster has it. Which
 * of them a cluster offers is a capability flag.
 */

function checkSql(ctx: SearchContext): void {
  if (!ctx.facts.capabilities.sql) {
    throw new QuerybaraError({
      code: 'NOT_SUPPORTED',
      message: 'This Elasticsearch cluster has no SQL API (the OSS distribution lacks it)',
    });
  }
}

async function send(ctx: SearchContext, request: SearchRequest, opts: SearchOpOptions) {
  return ctx.json(
    {
      method: request.method,
      path: request.path,
      ...(request.query !== undefined ? { query: request.query } : {}),
      ...(request.body !== undefined ? { body: request.body } : {}),
    },
    opts,
  );
}

/** See SearchSession.sql. */
export async function* sqlQuery(
  ctx: SearchContext,
  query: string,
  opts: SqlQueryOptions = {},
): AsyncGenerator<SearchTable> {
  checkSql(ctx);
  if (query.trim() === '') {
    throw new QuerybaraError({ code: 'VALIDATION_FAILED', message: 'Write a SQL query to run' });
  }
  const maxRows = opts.maxRows ?? Number.POSITIVE_INFINITY;
  const first = await send(
    ctx,
    sqlRequest(query, {
      ...(opts.fetchSize !== undefined ? { fetchSize: opts.fetchSize } : {}),
      ...(opts.timeZone !== undefined ? { timeZone: opts.timeZone } : {}),
    }),
    opts,
  );
  let page = parseTableReply(first.text);
  const columns = page.columns;
  let cursor = page.cursor;
  let read = 0;
  try {
    for (;;) {
      const rows = page.rows.slice(0, Math.max(0, maxRows - read));
      read += rows.length;
      const done = cursor === undefined || read >= maxRows;
      const { cursor: _cursor, ...rest } = page;
      // The cursor stays in the driver; the page only says whether more follow.
      yield { ...rest, columns, rows, ...(done ? {} : { more: true }) };
      if (done || cursor === undefined) return;
      const next = await send(ctx, sqlCursorRequest(cursor), opts);
      page = parseTableReply(next.text);
      // The last page answers without a cursor: the server closed it.
      cursor = page.cursor;
      if (page.rows.length === 0) return;
    }
  } finally {
    if (cursor !== undefined) {
      const close = sqlCloseRequest(cursor);
      await ctx.http
        .request({ method: close.method, path: close.path, body: close.body!, timeoutMs: 10_000 })
        .catch(() => undefined);
    }
  }
}

/** See SearchSession.translateSql. */
export async function translateSql(
  ctx: SearchContext,
  query: string,
  opts: SearchOpOptions = {},
): Promise<SqlTranslation> {
  checkSql(ctx);
  const { text } = await send(ctx, sqlTranslateRequest(query), opts);
  const dsl = translatedDsl(text);
  const target = sqlFromTarget(query);
  return {
    ...(dsl !== undefined ? { dsl } : {}),
    ...(target !== undefined ? { target } : {}),
    raw: text,
  };
}

/** See SearchSession.esql. */
export async function esql(
  ctx: SearchContext,
  query: string,
  opts: SearchOpOptions = {},
): Promise<SearchTable> {
  if (!ctx.facts.capabilities.esql) {
    throw new QuerybaraError({
      code: 'NOT_SUPPORTED',
      message: 'This cluster has no ES|QL (Elasticsearch 8.11 and later have it)',
    });
  }
  if (query.trim() === '') {
    throw new QuerybaraError({ code: 'VALIDATION_FAILED', message: 'Write an ES|QL query to run' });
  }
  const { text } = await send(ctx, esqlRequest(query), opts);
  return parseTableReply(text);
}
