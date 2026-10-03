import { QuerybaraError, type ErrorCode } from '@querybara/core';

/**
 * Error mapping for tunnels and proxies. Every message names hosts, ports, user names and key
 * paths (none of which are secrets) and never a password, passphrase or key material.
 */

/** Reads a string or number property from an unknown thrown value. */
export function errorProp(error: unknown, key: string): string | undefined {
  if (typeof error !== 'object' || error === null || !(key in error)) return undefined;
  const value: unknown = (error as Record<string, unknown>)[key];
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  return undefined;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function tunnelError(
  code: ErrorCode,
  message: string,
  hint: string,
  cause?: unknown,
  engineCode?: string,
): QuerybaraError {
  return new QuerybaraError(
    { code, message, hint, ...(engineCode !== undefined ? { engineCode } : {}) },
    cause === undefined ? undefined : { cause },
  );
}

/** "user@host:port", with IPv6 hosts bracketed. */
export function hostLabel(host: string, port: number, user?: string): string {
  const bracketed = host.includes(':') ? `[${host}]` : host;
  return `${user !== undefined ? `${user}@` : ''}${bracketed}:${port}`;
}

const DNS_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'EAI_NONAME', 'EAI_FAIL', 'EAI_NODATA']);
const UNREACHABLE_CODES = new Set(['EHOSTUNREACH', 'ENETUNREACH', 'EHOSTDOWN', 'ENETDOWN']);
const RESET_CODES = new Set(['ECONNRESET', 'EPIPE', 'ECONNABORTED']);

/** The Node network error code, also when a library only kept it in the message. */
function networkCode(error: unknown): string | undefined {
  const code = errorProp(error, 'code');
  if (code !== undefined && /^E[A-Z_]+$/.test(code)) return code;
  return /\b(E(?:CONNREFUSED|NOTFOUND|AI_AGAIN|HOSTUNREACH|NETUNREACH|TIMEDOUT|CONNRESET|PIPE))\b/.exec(
    errorMessage(error),
  )?.[1];
}

/**
 * Maps a TCP-level failure reaching `where` (an SSH server or a proxy) to CONNECTION_FAILED with a
 * hint. `what` names the kind of server for the message, e.g. "SSH server" or "SOCKS5 proxy".
 */
export function mapSocketError(error: unknown, what: string, where: string): QuerybaraError {
  const code = networkCode(error);
  const fail = (message: string, hint: string) =>
    tunnelError('CONNECTION_FAILED', message, hint, error, code);
  if (code !== undefined && DNS_CODES.has(code)) {
    return fail(
      `Could not resolve the host name of the ${what} ${where}`,
      'Check the host name for typos and that this computer can reach your DNS (VPN, network)',
    );
  }
  if (code === 'ECONNREFUSED') {
    return fail(
      `Connection to the ${what} ${where} was refused`,
      `Check that the ${what} is running and listening on this host and port, and that no firewall blocks it`,
    );
  }
  if (code !== undefined && UNREACHABLE_CODES.has(code)) {
    return fail(
      `The ${what} ${where} is unreachable from this computer`,
      'Check your network or VPN connection',
    );
  }
  if (code === 'ETIMEDOUT') {
    return fail(
      `Timed out connecting to the ${what} ${where}`,
      'Check the host, port and firewall rules, or raise the connect timeout',
    );
  }
  if (code !== undefined && RESET_CODES.has(code)) {
    return fail(
      `The ${what} ${where} closed the connection unexpectedly`,
      `Check that ${where} really is a ${what}`,
    );
  }
  return fail(
    `Could not connect to the ${what} ${where}: ${errorMessage(error)}`,
    `Check the ${what} host and port`,
  );
}

/** A connect timeout that an SSH or proxy handshake ran into. */
export function timeoutError(
  code: 'SSH_FAILED' | 'CONNECTION_FAILED',
  what: string,
  where: string,
  timeoutMs: number,
): QuerybaraError {
  return tunnelError(
    code,
    `The ${what} ${where} did not answer within ${Math.round(timeoutMs / 100) / 10} s`,
    `Check that ${where} is the right host and port and is reachable, or raise the connect timeout`,
    undefined,
    'ETIMEDOUT',
  );
}
