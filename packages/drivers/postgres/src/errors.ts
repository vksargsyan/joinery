import { JoineryError } from '@joinery/core';
import {
  codePointOffsetToIndex,
  errorMessage,
  errorProp,
  mapNetworkError,
} from '@joinery/driver-sql-base';

/** What was happening when a pg error occurred, for picking the right code and position. */
export interface PgErrorContext {
  /** Endpoint description for connection errors ("db.example.com:5432"). */
  readonly where: string;
  /** Statement text, to turn PostgreSQL's 1-based character position into a 0-based offset. */
  readonly statement?: string;
  /** This session asked the server to cancel the statement. */
  readonly cancelRequested?: boolean;
  /** The error happened while connecting. */
  readonly connecting?: boolean;
}

const AUTH_STATES = new Set(['28000', '28P01']);
const CONNECTION_STATES = new Set([
  '57P01',
  '57P02',
  '57P03',
  '53300',
  '08000',
  '08001',
  '08004',
  '08006',
]);

/** SQLSTATE of a server error; pg's DatabaseError carries it as `code`. */
function sqlState(error: unknown): string | undefined {
  const code = errorProp(error, 'code');
  if (code === undefined || !/^[0-9A-Z]{5}$/.test(code)) return undefined;
  // Server errors carry a severity; Node system errors (ECONNRESET) never match the pattern.
  return errorProp(error, 'severity') !== undefined ? code : undefined;
}

/**
 * Maps anything pg throws to a JoineryError: server errors by SQLSTATE (with detail, hint and
 * a 0-based position), then network and TLS failures, then pg's own client errors.
 */
export function mapPgError(error: unknown, context: PgErrorContext): JoineryError {
  if (error instanceof JoineryError) return error;
  const cause = { cause: error };
  const message = errorMessage(error);
  const state = sqlState(error);

  if (state !== undefined) {
    const base = {
      message,
      sqlState: state,
      engineCode: state,
      ...(errorProp(error, 'detail') !== undefined ? { detail: errorProp(error, 'detail')! } : {}),
      ...(errorProp(error, 'hint') !== undefined ? { hint: errorProp(error, 'hint')! } : {}),
    };
    if (AUTH_STATES.has(state)) {
      return new JoineryError(
        {
          ...base,
          code: 'AUTH_FAILED',
          hint:
            base.hint ??
            (message.includes('pg_hba.conf')
              ? 'The server does not accept this user from this address; check pg_hba.conf or the TLS mode'
              : 'Check the user name and password'),
        },
        cause,
      );
    }
    if (state === '3D000' && context.connecting) {
      return new JoineryError(
        { ...base, code: 'NOT_FOUND', hint: 'Check the default database in the profile' },
        cause,
      );
    }
    if (state === '57014') {
      if (context.cancelRequested) {
        return new JoineryError({ ...base, code: 'CANCELLED', message: 'Query cancelled' }, cause);
      }
      if (/statement timeout/i.test(message)) {
        return new JoineryError(
          { ...base, code: 'TIMEOUT', hint: 'The statement ran longer than the query timeout' },
          cause,
        );
      }
      return new JoineryError({ ...base, code: 'CANCELLED' }, cause);
    }
    if (CONNECTION_STATES.has(state)) {
      return new JoineryError({ ...base, code: 'CONNECTION_FAILED' }, cause);
    }
    const position = Number(errorProp(error, 'position'));
    const withPosition =
      Number.isInteger(position) && position > 0 && context.statement !== undefined
        ? { position: codePointOffsetToIndex(context.statement, position - 1) }
        : {};
    return new JoineryError({ ...base, ...withPosition, code: 'SQL_ERROR' }, cause);
  }

  const network = mapNetworkError(error, context.where);
  if (network) return network;

  if (/timeout/i.test(message)) {
    return new JoineryError(
      {
        code: 'TIMEOUT',
        message: context.connecting ? `Timed out connecting to ${context.where}` : message,
        hint: 'Check the host, port and firewall rules, or raise the connect timeout',
      },
      cause,
    );
  }
  if (/password must be a string/i.test(message)) {
    return new JoineryError(
      {
        code: 'AUTH_FAILED',
        message: 'The server asked for a password, but none was provided',
        hint: 'Enter the password in the profile',
      },
      cause,
    );
  }
  if (/SASL|SCRAM/.test(message)) {
    return new JoineryError(
      { code: 'AUTH_FAILED', message, hint: 'Check the user name and password' },
      cause,
    );
  }
  if (/terminated|not queryable|Connection terminated|ended/i.test(message)) {
    return new JoineryError(
      {
        code: 'CONNECTION_FAILED',
        message: context.connecting
          ? `The server at ${context.where} closed the connection during login`
          : 'The connection to the server was lost',
        hint: context.connecting
          ? 'Check the TLS mode (the server may require or refuse TLS) and the server log'
          : 'Reconnect; if it keeps happening, check the server log',
      },
      cause,
    );
  }
  return new JoineryError(
    { code: context.connecting ? 'CONNECTION_FAILED' : 'INTERNAL', message },
    cause,
  );
}
