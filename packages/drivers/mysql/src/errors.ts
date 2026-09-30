import { JoineryError } from '@joinery/core';
import { errorMessage, errorProp, mapNetworkError, tlsHint } from '@joinery/driver-sql-base';

import { syntaxErrorPosition } from './dialect';

/** What was happening when a mysql2 error occurred. */
export interface MysqlErrorContext {
  /** Endpoint description for connection errors ("db.example.com:3306"). */
  readonly where: string;
  /** Statement text, to locate syntax errors. */
  readonly statement?: string;
  /** This session asked the server to kill the statement. */
  readonly cancelRequested?: boolean;
  /** The error happened while connecting. */
  readonly connecting?: boolean;
}

const AUTH_ERRNOS = new Set([1045, 1698, 1251, 1130, 1862, 1820]);
const TIMEOUT_ERRNOS = new Set([3024, 1969, 1907]);
const LOST_ERRNOS = new Set([2006, 2013, 1053, 1927, 1152, 1153]);
const LOST_CODES = new Set([
  'PROTOCOL_CONNECTION_LOST',
  'PROTOCOL_ENQUEUE_AFTER_FATAL_ERROR',
  'PROTOCOL_ENQUEUE_AFTER_QUIT',
]);

/**
 * Maps anything mysql2 throws to a JoineryError: server errors by errno (with SQLSTATE and the
 * syntax error position), then network and TLS failures, then mysql2's own protocol errors.
 */
export function mapMysqlError(error: unknown, context: MysqlErrorContext): JoineryError {
  if (error instanceof JoineryError) return error;
  const cause = { cause: error };
  const errno = Number(errorProp(error, 'errno'));
  const code = errorProp(error, 'code');
  const sqlState = errorProp(error, 'sqlState');
  const message = errorProp(error, 'sqlMessage') ?? errorMessage(error);

  if (Number.isInteger(errno) && ((errno >= 1000 && errno < 2000) || errno >= 3000)) {
    const base = {
      message,
      engineCode: errno,
      ...(sqlState !== undefined && sqlState !== '' ? { sqlState } : {}),
    };
    if (AUTH_ERRNOS.has(errno) || (errno === 1044 && context.connecting)) {
      return new JoineryError(
        {
          ...base,
          code: 'AUTH_FAILED',
          hint:
            errno === 1130
              ? 'The server does not accept this user from this host; check the account host pattern'
              : errno === 1251
                ? 'The server uses an authentication plugin this client does not support'
                : 'Check the user name and password',
        },
        cause,
      );
    }
    if (errno === 1049 && context.connecting) {
      return new JoineryError(
        { ...base, code: 'NOT_FOUND', hint: 'Check the default database in the profile' },
        cause,
      );
    }
    if (errno === 1317) {
      return new JoineryError(
        {
          ...base,
          code: 'CANCELLED',
          ...(context.cancelRequested ? { message: 'Query cancelled' } : {}),
        },
        cause,
      );
    }
    if (TIMEOUT_ERRNOS.has(errno)) {
      return new JoineryError(
        { ...base, code: 'TIMEOUT', hint: 'The statement ran longer than the query timeout' },
        cause,
      );
    }
    if (errno === 1040 || errno === 1129 || LOST_ERRNOS.has(errno)) {
      return new JoineryError({ ...base, code: 'CONNECTION_FAILED' }, cause);
    }
    const position =
      context.statement !== undefined ? syntaxErrorPosition(message, context.statement) : undefined;
    return new JoineryError(
      { ...base, code: 'SQL_ERROR', ...(position !== undefined ? { position } : {}) },
      cause,
    );
  }

  if (code === 'HANDSHAKE_NO_SSL_SUPPORT') {
    return new JoineryError(
      {
        code: 'TLS_FAILED',
        message: `The server at ${context.where} does not support TLS`,
        hint: "Enable TLS on the server, or set the profile's TLS mode to 'disable'",
        engineCode: code,
      },
      cause,
    );
  }
  if (code === 'HANDSHAKE_SSL_ERROR') {
    return new JoineryError(
      {
        code: 'TLS_FAILED',
        message: `TLS negotiation with ${context.where} failed: ${message}`,
        hint: tlsHint(message),
        engineCode: code,
      },
      cause,
    );
  }
  if (code === 'PROTOCOL_SEQUENCE_TIMEOUT' || (code === 'ETIMEDOUT' && context.connecting)) {
    return new JoineryError(
      {
        code: 'TIMEOUT',
        message: context.connecting ? `Timed out connecting to ${context.where}` : message,
        hint: 'Check the host, port and firewall rules, or raise the connect timeout',
        engineCode: code,
      },
      cause,
    );
  }
  if ((code !== undefined && LOST_CODES.has(code)) || LOST_ERRNOS.has(errno)) {
    return new JoineryError(
      {
        code: 'CONNECTION_FAILED',
        message: context.connecting
          ? `The server at ${context.where} closed the connection during login`
          : 'The connection to the server was lost',
        hint: context.connecting
          ? 'Check the TLS mode (the server may require TLS) and the server log'
          : 'Reconnect; if it keeps happening, check the server log',
        engineCode: code ?? errno,
      },
      cause,
    );
  }
  const network = mapNetworkError(error, context.where);
  if (network) return network;
  return new JoineryError(
    { code: context.connecting ? 'CONNECTION_FAILED' : 'INTERNAL', message },
    cause,
  );
}

/** True when mysql2 marked the error fatal: the connection cannot be used any more. */
export function isFatal(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'fatal' in error && error.fatal === true;
}
