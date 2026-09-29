import { JoineryError, type ErrorCode, type ErrorData } from '@joinery/core';
import { mapNetworkError, tlsHint } from '@joinery/driver-sql-base';
import { offsetOfLineColumn, parseSearchError, type SearchErrorInfo } from '@joinery/search-tools';

import { redactSecrets, type SearchAuthMethod } from './config';
import { HttpTransportError } from './http';

/**
 * Maps what can go wrong talking to Elasticsearch or OpenSearch to JoineryErrors with a fix hint
 * (spec §4): network and TLS failures, and the server's HTTP errors — authentication (401),
 * missing privileges and read-only blocks (403), missing indices (404), version conflicts (409),
 * circuit breakers and rejected executions (429), timeouts, and request syntax errors with the
 * position the server reports. Messages never hold a secret: the profile's secret values are
 * redacted from everything the server or Node says.
 */

export interface SearchErrorContext {
  /** "https://es1:9200" or the Cloud ID's endpoint: where the request went. */
  readonly where: string;
  readonly secrets: readonly string[];
  readonly authMethod?: SearchAuthMethod;
  readonly user?: string;
  /** The caller asked to cancel (an abort then reads as CANCELLED, not a network error). */
  readonly cancelRequested?: boolean;
  /** The body sent, so a syntax error's line and column become an offset in it (`position`). */
  readonly requestBody?: string;
}

function authHint(method: SearchAuthMethod | undefined): string {
  switch (method) {
    case 'basic':
      return 'Check the user name and password';
    case 'apiKey':
      return 'Check the API key: it may be wrong, expired or invalidated. Paste the encoded key, or id:api_key';
    case 'bearer':
      return 'Check the token: it may be wrong or expired';
    case 'certificate':
      return 'Check that the client certificate is trusted by the PKI realm and maps to a user';
    default:
      return 'The cluster needs credentials: choose basic authentication, an API key or a token';
  }
}

/** A readable "status: reason" for a failing request, from its error body. */
function reasonOf(info: SearchErrorInfo | undefined, status: number): string {
  if (!info) return `HTTP ${status}`;
  const detail = info.causedBy && !info.reason.includes(info.causedBy) ? `: ${info.causedBy}` : '';
  return `${info.reason}${detail}`;
}

/**
 * The JoineryError for a failing HTTP response. `detail` holds the raw error body (redacted),
 * so the console and the logs can show everything the server said.
 */
export function mapResponseError(
  status: number,
  body: string,
  context: SearchErrorContext,
): JoineryError {
  const info = parseSearchError(body);
  const redact = (text: string): string => redactSecrets(text, context.secrets);
  const type = info?.type ?? '';
  const reason = redact(reasonOf(info, status));
  const detail =
    body.trim() === ''
      ? undefined
      : redact(body.length > 8_000 ? `${body.slice(0, 8_000)}…` : body);
  const make = (code: ErrorCode, extra: Partial<ErrorData> = {}): JoineryError =>
    new JoineryError({
      code,
      message: reason,
      ...(type !== '' ? { engineCode: type } : { engineCode: status }),
      ...(detail !== undefined ? { detail } : {}),
      ...extra,
    });

  if (status === 401) {
    return make('AUTH_FAILED', {
      message: `Authentication failed at ${context.where}${context.user ? ` for ${context.user}` : ''}`,
      hint: authHint(context.authMethod),
    });
  }
  if (
    type === 'cluster_block_exception' ||
    /blocked by: \[(FORBIDDEN|TOO_MANY_REQUESTS)\/\d+\//.test(reason)
  ) {
    const flood = /flood[- ]stage|read-only-allow-delete|disk usage exceeded/i.test(reason);
    return make('READ_ONLY', {
      hint: flood
        ? 'The disk passed the flood-stage watermark, so the index became read-only. Free disk space; the block lifts by itself (older versions: reset index.blocks.read_only_allow_delete)'
        : 'The index or cluster has a write block (index.blocks.write or read_only); remove the block in its settings to write',
    });
  }
  if (status === 403 || type === 'security_exception') {
    return make('SQL_ERROR', {
      hint: 'The user lacks a privilege this request needs; ask an administrator for a role that grants it',
    });
  }
  if (type === 'index_not_found_exception' || (status === 404 && /no such index/.test(reason))) {
    return make('NOT_FOUND', {
      hint: 'Check the index, alias or data stream name (names are lower case), or create the index first',
    });
  }
  if (type === 'version_conflict_engine_exception' || status === 409) {
    return make('CONFLICT', {
      hint: 'The document changed since it was read; read it again and repeat the change',
    });
  }
  if (type === 'resource_already_exists_exception') {
    return make('VALIDATION_FAILED', {
      hint: 'Choose another name, or delete the existing one first',
    });
  }
  if (type === 'circuit_breaking_exception') {
    return make('SQL_ERROR', {
      hint: 'A circuit breaker stopped the request to protect node memory: narrow the query (smaller aggregations or pages), or retry when the cluster is less busy',
    });
  }
  if (
    status === 429 ||
    type === 'es_rejected_execution_exception' ||
    type === 'rejected_execution_exception'
  ) {
    return make('SQL_ERROR', {
      hint: 'The cluster is overloaded and rejected the request; retry in a moment or send less at once',
    });
  }
  if (
    status === 408 ||
    status === 504 ||
    type === 'timeout_exception' ||
    type === 'process_cluster_event_timeout_exception'
  ) {
    return make('TIMEOUT', {
      hint: 'The cluster did not finish in time; retry, or raise the timeout',
    });
  }
  if (type === 'task_cancelled_exception') {
    return new JoineryError({ code: 'CANCELLED', message: 'The request was cancelled' });
  }
  if (
    status === 503 ||
    type === 'master_not_discovered_exception' ||
    type === 'no_shard_available_action_exception'
  ) {
    return make('CONNECTION_FAILED', {
      hint: 'The cluster is not ready (no elected master, or shards are unavailable); check the cluster health',
    });
  }
  if (status === 404) {
    return make('NOT_FOUND', {
      hint: /no handler found/.test(reason)
        ? 'This server has no such endpoint; check the path and method, and the version and plugins it needs'
        : 'Check the path and names in the request',
    });
  }
  if (status === 405 || /no handler found/.test(reason)) {
    return make('NOT_SUPPORTED', {
      hint: 'This server has no such endpoint for the method; check the path, the method, and the version and plugins it needs',
    });
  }
  // A syntax error in the body: its position, as an offset into the body sent.
  const sent = context.requestBody;
  const position =
    info?.line !== undefined && info.column !== undefined && sent !== undefined
      ? offsetOfLineColumn(sent, info.line, info.column)
      : undefined;
  return make('SQL_ERROR', position !== undefined ? { position } : {});
}

/** Maps a transport failure (no HTTP response) or anything thrown. */
export function mapTransportError(error: unknown, context: SearchErrorContext): JoineryError {
  if (error instanceof JoineryError) return error;
  const name = error instanceof Error ? error.name : '';
  if (context.cancelRequested || name === 'AbortError') {
    return new JoineryError({ code: 'CANCELLED', message: 'Cancelled' }, { cause: error });
  }
  const redact = (text: string): string => redactSecrets(text, context.secrets);
  if (error instanceof HttpTransportError) {
    const where = error.node.label;
    if (error.code === 'REQUEST_TIMEOUT') {
      return new JoineryError(
        {
          code: 'TIMEOUT',
          message: redact(error.message),
          hint: 'The query timeout of the connection ran out; raise it in the connection options, or narrow the request',
          engineCode: error.code,
        },
        { cause: error },
      );
    }
    if (error.code === 'CONNECT_TIMEOUT') {
      return new JoineryError(
        {
          code: 'TIMEOUT',
          message: `Timed out connecting to ${where}`,
          hint: 'Check the URL, the port and firewall rules, or raise the connect timeout',
          engineCode: error.code,
        },
        { cause: error },
      );
    }
    const cause = error.cause ?? error;
    const mapped = mapNetworkError(cause, where);
    if (mapped) {
      return new JoineryError(
        { ...mapped.toJSON(), message: redact(mapped.message) },
        { cause: error },
      );
    }
    if (/HPE_|Parse Error|wrong version number|packet length too long/i.test(error.message)) {
      return new JoineryError(
        {
          code: 'CONNECTION_FAILED',
          message: `${where} did not answer as an HTTP${where.startsWith('https') ? 'S' : ''} server`,
          hint: where.startsWith('https')
            ? 'The node may not have TLS on its HTTP port: try http:// in the URL'
            : 'The node may require TLS: try https:// in the URL',
          engineCode: error.code,
        },
        { cause: error },
      );
    }
    return new JoineryError(
      {
        code: 'CONNECTION_FAILED',
        message: redact(`${where}: ${error.message}`),
        engineCode: error.code,
      },
      { cause: error },
    );
  }
  const network = mapNetworkError(error, context.where);
  if (network) {
    return new JoineryError(
      { ...network.toJSON(), message: redact(network.message) },
      { cause: error },
    );
  }
  const message = error instanceof Error ? error.message : String(error);
  if (/certificate|ssl|tls/i.test(message)) {
    return new JoineryError(
      {
        code: 'TLS_FAILED',
        message: redact(`TLS negotiation with ${context.where} failed: ${message}`),
        hint: tlsHint(message),
      },
      { cause: error },
    );
  }
  return new JoineryError({ code: 'INTERNAL', message: redact(message) }, { cause: error });
}
