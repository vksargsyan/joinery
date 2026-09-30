import { JoineryError } from '@joinery/core';
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
  type SqlDialect,
} from '@joinery/search-tools';

import type { SearchContext } from './context';
import type { SearchOpOptions, SqlQueryOptions, SqlTranslation } from './types';

/**
 * SQL and ES|QL (spec §11): SQL through Elasticsearch's SQL API or OpenSearch's SQL plugin,
 * paged with the server's cursor (closed when the reader stops early), "Translate to DSL", and
 * ES|QL where the cluster has it. Which of them a cluster offers is a capability flag.
 */

function dialectOf(ctx: SearchContext): SqlDialect {
  const dialect = ctx.facts.capabilities.sql;
  if (dialect === null) {
    throw new JoineryError({
      code: 'NOT_SUPPORTED',
      message:
        ctx.facts.distribution === 'opensearch'
          ? 'This OpenSearch cluster has no SQL plugin (opensearch-sql)'
          : 'This Elasticsearch cluster has no SQL API (the OSS distribution lacks it)',
    });
  }
  return dialect;
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
  const dialect = dialectOf(ctx);
  if (query.trim() === '') {
    throw new JoineryError({ code: 'VALIDATION_FAILED', message: 'Write a SQL query to run' });
  }
  const maxRows = opts.maxRows ?? Number.POSITIVE_INFINITY;
  const first = await send(
    ctx,
    sqlRequest(dialect, query, {
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
      const next = await send(ctx, sqlCursorRequest(dialect, cursor), opts);
      page = parseTableReply(next.text);
      // The last page answers without a cursor: the server closed it.
      cursor = page.cursor;
      if (page.rows.length === 0) return;
    }
  } finally {
    if (cursor !== undefined) {
      const close = sqlCloseRequest(dialect, cursor);
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
  const dialect = dialectOf(ctx);
  const { text } = await send(ctx, sqlTranslateRequest(dialect, query), opts);
  const dsl = translatedDsl(dialect, text);
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
    throw new JoineryError({
      code: 'NOT_SUPPORTED',
      message: 'This cluster has no ES|QL (Elasticsearch 8.11 and later have it)',
    });
  }
  if (query.trim() === '') {
    throw new JoineryError({ code: 'VALIDATION_FAILED', message: 'Write an ES|QL query to run' });
  }
  const { text } = await send(ctx, esqlRequest(query), opts);
  return parseTableReply(text);
}
