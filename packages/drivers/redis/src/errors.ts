import { JoineryError, cancelledError, type ErrorCode } from '@joinery/core';
import { errorMessage, errorProp, mapNetworkError } from '@joinery/driver-sql-base';

/** Where an error happened, for the message: "host:port" or a description; never secrets. */
export interface RedisErrorContext {
  readonly where: string;
  /** Connecting (auth and permission errors fail the login) or running a command. */
  readonly phase: 'connect' | 'command';
  /** Upper-case command name, for permission hints. */
  readonly command?: string;
  /** Sentinel master name, for the "no such master" hint. */
  readonly masterName?: string;
}

/** True for an error reply from the server (as opposed to a network or client error). */
export function isReplyError(error: unknown): error is Error {
  return error instanceof Error && error.name === 'ReplyError';
}

/** The reply's error prefix: "WRONGTYPE", "NOPERM", "ERR"... */
export function replyErrorCode(message: string): string | undefined {
  return /^([A-Z][A-Z_-]+)\b/.exec(message)?.[1];
}

function joinery(
  code: ErrorCode,
  message: string,
  hint: string | undefined,
  cause: unknown,
  engineCode?: string,
): JoineryError {
  return new JoineryError(
    {
      code,
      message,
      ...(hint !== undefined ? { hint } : {}),
      ...(engineCode !== undefined ? { engineCode } : {}),
    },
    { cause },
  );
}

/** Maps an error reply by its prefix; hints name the fix. */
function mapReply(message: string, ctx: RedisErrorContext, cause: unknown): JoineryError {
  const code = replyErrorCode(message);
  const command = ctx.command ? ctx.command.toLowerCase() : undefined;
  switch (code) {
    case 'WRONGPASS':
      return joinery(
        'AUTH_FAILED',
        `${ctx.where} rejected the user name or password`,
        'Check the user name and password; an ACL user must also be enabled ("on")',
        cause,
        code,
      );
    case 'NOAUTH':
      return joinery(
        'AUTH_FAILED',
        `${ctx.where} requires authentication`,
        'Choose password authentication and enter the password (and the ACL user name if the server uses ACL users)',
        cause,
        code,
      );
    case 'NOPERM':
      return joinery(
        ctx.phase === 'connect' ? 'AUTH_FAILED' : 'SQL_ERROR',
        message,
        `The ACL user may not run ${command ? `"${command}"` : 'this command'} or access this key: grant it (e.g. ACL SETUSER <user> +${command ?? '<command>'} ~<pattern>) or connect as another user`,
        cause,
        code,
      );
    case 'DENIED':
      return joinery(
        'CONNECTION_FAILED',
        `${ctx.where} is running in protected mode and refuses remote clients`,
        'Set a password (requirepass or an ACL user) on the server, bind it to the right interface, or connect through an SSH tunnel to the server itself',
        cause,
        code,
      );
    case 'CLUSTERDOWN':
      return joinery(
        'CONNECTION_FAILED',
        `The cluster is down: ${message}`,
        'Some hash slots are not served or most primaries are unreachable; check CLUSTER INFO and the failing nodes',
        cause,
        code,
      );
    case 'LOADING':
      return joinery(
        'CONNECTION_FAILED',
        'The server is still loading its dataset into memory',
        'Retry in a moment',
        cause,
        code,
      );
    case 'MASTERDOWN':
      return joinery(
        'CONNECTION_FAILED',
        message,
        'The replica lost its link to the primary; connect to the primary or wait for the link',
        cause,
        code,
      );
    case 'READONLY':
      return joinery(
        'SQL_ERROR',
        message,
        'This node is a read-only replica: connect to the primary (or through Sentinel) to write',
        cause,
        code,
      );
    case 'MOVED':
    case 'ASK':
      return joinery(
        'SQL_ERROR',
        message,
        'The key lives on another cluster node: connect with a Cluster endpoint so Joinery follows redirections',
        cause,
        code,
      );
    case 'CROSSSLOT':
      return joinery(
        'SQL_ERROR',
        message,
        'In a cluster all keys of one command must hash to the same slot; use a hash tag such as {user:42}',
        cause,
        code,
      );
    case 'BUSY':
      return joinery(
        'SQL_ERROR',
        message,
        'A script or function is running; wait for it or stop it with SCRIPT KILL / FUNCTION KILL',
        cause,
        code,
      );
    default:
      if (/unknown command/i.test(message) && command) {
        return joinery(
          'SQL_ERROR',
          message,
          'The command does not exist on this server (check the spelling, the server version and loaded modules), or it was renamed away',
          cause,
          code,
        );
      }
      return joinery('SQL_ERROR', message, undefined, cause, code);
  }
}

/**
 * Maps anything ioredis throws or emits to a JoineryError with a fix hint: error replies by
 * prefix (WRONGPASS, NOAUTH, NOPERM, CLUSTERDOWN, protected mode...), Sentinel and Cluster
 * discovery failures, timeouts, closed connections, and network / TLS errors.
 */
export function mapRedisError(error: unknown, ctx: RedisErrorContext): JoineryError {
  if (error instanceof JoineryError) return error;
  if (error instanceof Error && error.name === 'AbortError') return cancelledError();
  const message = errorMessage(error);
  if (isReplyError(error)) return mapReply(message, ctx, error);

  // Sentinel discovery.
  if (/No such master with that name/i.test(message)) {
    return joinery(
      'CONNECTION_FAILED',
      `The Sentinels do not monitor a master named "${ctx.masterName ?? '?'}"`,
      'Check the master name in the profile; SENTINEL MASTERS on a Sentinel lists the names it monitors',
      error,
    );
  }
  if (/All sentinels are unreachable/i.test(message)) {
    const last = /Last error: (.*)$/.exec(message)?.[1];
    const inner = last ? replyErrorCode(last) : undefined;
    if (inner && inner !== 'ERR') return mapReply(last!, ctx, error);
    return joinery(
      'CONNECTION_FAILED',
      `No Sentinel could be reached or none knows the master (${ctx.where})`,
      'Check the Sentinel hosts and ports, that the Sentinels are running, and the Sentinel password (Joinery uses the profile credentials for them too)',
      error,
    );
  }
  // Cluster discovery.
  const embedded = /(WRONGPASS|NOAUTH|NOPERM|CLUSTERDOWN|DENIED)\b.*$/.exec(message);
  if (embedded && /slots cache|startup nodes|cluster/i.test(message)) {
    return mapReply(embedded[0], ctx, error);
  }
  if (/None of startup nodes is available|Failed to refresh slots cache/i.test(message)) {
    return joinery(
      'CONNECTION_FAILED',
      `None of the cluster seed nodes answered (${ctx.where})`,
      'Check the seed hosts and ports and that the servers run in cluster mode (cluster-enabled yes)',
      error,
    );
  }
  if (/Cluster state fail|CLUSTERDOWN/i.test(message)) {
    return joinery(
      'CONNECTION_FAILED',
      'The cluster reports state "fail"',
      'Some hash slots are not served or most primaries are unreachable; check CLUSTER INFO on the nodes',
      error,
    );
  }
  if (/Command timed out/i.test(message)) {
    return joinery(
      'TIMEOUT',
      `The command did not finish within the query timeout on ${ctx.where}`,
      'Raise the query timeout in the profile options, or make the command cheaper (SCAN instead of KEYS)',
      error,
    );
  }
  if (
    errorProp(error, 'name') === 'MaxRetriesPerRequestError' ||
    /Connection is closed/i.test(message)
  ) {
    return joinery(
      'CONNECTION_FAILED',
      `The connection to ${ctx.where} was closed`,
      'The server closed the connection (CLIENT KILL, timeout, restart or network); run the command again to reconnect',
      error,
    );
  }
  if (/wrong version number|packet length too long|unknown protocol/i.test(message)) {
    return joinery(
      'TLS_FAILED',
      `TLS negotiation with ${ctx.where} failed: ${message}`,
      'The server does not speak TLS on this port: turn TLS off in the profile, or use the server’s TLS port',
      error,
    );
  }
  const network = mapNetworkError(error, ctx.where);
  if (network) return network;
  return joinery(
    ctx.phase === 'connect' ? 'CONNECTION_FAILED' : 'INTERNAL',
    message,
    undefined,
    error,
  );
}

const PRIORITY: Readonly<Partial<Record<ErrorCode, number>>> = {
  AUTH_FAILED: 0,
  TLS_FAILED: 1,
  TIMEOUT: 3,
};

/**
 * ioredis rejects a failed connect with a generic "Connection is closed." and reports the cause
 * in 'error' events. Picks the most telling of all the errors seen: authentication, then TLS,
 * then anything specific, then the generic one.
 */
export function pickConnectError(
  thrown: unknown,
  events: readonly unknown[],
  ctx: RedisErrorContext,
): JoineryError {
  const candidates = [...events, thrown].map((e) => mapRedisError(e, ctx));
  const generic = (e: JoineryError): boolean => /was closed$/.test(e.message);
  const rank = (e: JoineryError): number =>
    PRIORITY[e.code] ?? (generic(e) ? 9 : e.code === 'CONNECTION_FAILED' ? 2 : 5);
  return candidates.reduce((best, e) => (rank(e) < rank(best) ? e : best));
}
