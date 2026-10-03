import { isIP } from 'node:net';

import {
  ENDPOINT_KINDS,
  ENGINES,
  QuerybaraError,
  type ResolvedProfile,
  type SqlEngineId,
} from '@querybara/core';

/** Where the driver opens its socket, after tunnels and URIs are resolved. */
export type NetworkTarget =
  | {
      readonly kind: 'tcp';
      readonly host: string;
      readonly port: number;
      /**
       * The name the server certificate must carry. It is the profile host even when an SSH
       * tunnel makes the driver connect to 127.0.0.1, so verify-full still checks the real server.
       */
      readonly tlsHost: string;
    }
  | { readonly kind: 'socket'; readonly path: string };

/** A resolved endpoint: the socket target plus whatever a URI endpoint carried. */
export interface ResolvedEndpoint {
  readonly target: NetworkTarget;
  readonly user?: string;
  /** Only when a URI still held one; profiles normally keep passwords as secrets. */
  readonly password?: string;
  readonly database?: string;
  /** URI query parameters, decoded. */
  readonly params: Readonly<Record<string, string>>;
  /** True when an SSH tunnel's local forward replaced the profile endpoint. */
  readonly tunnelled: boolean;
}

/** The parts of a database URI the SQL drivers use. */
export interface ParsedConnectionUri {
  readonly scheme: string;
  readonly host?: string;
  readonly port?: number;
  readonly user?: string;
  readonly password?: string;
  readonly database?: string;
  readonly params: Readonly<Record<string, string>>;
}

const URI_SCHEMES: Readonly<Record<SqlEngineId, readonly string[]>> = {
  postgres: ['postgres', 'postgresql'],
  mysql: ['mysql', 'mysqlx', 'mariadb'],
  mariadb: ['mariadb', 'mysql'],
};

function invalidUri(reason: string): QuerybaraError {
  // The URI itself is never echoed: a pasted one may still hold a password.
  return new QuerybaraError({
    code: 'VALIDATION_FAILED',
    message: `The connection URI is not valid: ${reason}`,
    hint: 'Use the form scheme://user@host:port/database',
  });
}

function decode(part: string): string {
  try {
    return decodeURIComponent(part);
  } catch {
    throw invalidUri('it contains a malformed percent-escape');
  }
}

/**
 * Parses a `postgres://`, `mysql://` or `mariadb://` URI. Single host only: multi-host URIs are
 * rejected with VALIDATION_FAILED. IPv6 hosts may be bracketed.
 */
export function parseConnectionUri(uri: string, engine: SqlEngineId): ParsedConnectionUri {
  const match = /^([a-z][a-z0-9+.-]*):\/\//i.exec(uri.trim());
  if (!match) throw invalidUri('it has no scheme');
  const scheme = match[1]!.toLowerCase();
  if (!URI_SCHEMES[engine].includes(scheme)) {
    throw invalidUri(
      `"${scheme}://" is not a ${ENGINES[engine].displayName} scheme (use ${URI_SCHEMES[engine].join('://, ')}://)`,
    );
  }
  let url: URL;
  try {
    url = new URL(uri.trim());
  } catch {
    throw invalidUri('it could not be parsed (multiple hosts are not supported)');
  }
  const params: Record<string, string> = {};
  for (const [key, value] of url.searchParams) params[key] = value;
  const hostname = url.hostname.replace(/^\[(.*)\]$/, '$1');
  const database = url.pathname.replace(/^\//, '');
  const result: {
    -readonly [K in keyof ParsedConnectionUri]: ParsedConnectionUri[K];
  } = { scheme, params };
  if (hostname) result.host = decode(hostname);
  if (url.port) result.port = Number(url.port);
  if (url.username) result.user = decode(url.username);
  if (url.password) result.password = decode(url.password);
  if (database) result.database = decode(database);
  return result;
}

/**
 * Refuses network features the SQL adapters do not implement. SSH tunnels are opened by the
 * connection host, which then sets `endpointOverride`; without one the adapter cannot reach a
 * server that is only reachable through the tunnel.
 */
export function assertSupportedNetwork(resolved: ResolvedProfile): void {
  const { profile } = resolved;
  if (profile.ssh && !resolved.endpointOverride) {
    throw new QuerybaraError({
      code: 'NOT_SUPPORTED',
      message: 'This profile uses an SSH tunnel, but no tunnel is open for it',
      hint: 'SSH tunnels are opened by the connection host; connect through it rather than calling the driver directly',
    });
  }
  if (profile.proxy && !resolved.endpointOverride) {
    throw new QuerybaraError({
      code: 'NOT_SUPPORTED',
      message: `This profile uses ${profile.proxy.kind === 'http' ? 'an HTTP' : 'a SOCKS5'} proxy for ${ENGINES[profile.engine].displayName}, but no proxy route is open for it`,
      hint: 'Proxies are opened by the connection host; connect through it rather than calling the driver directly',
    });
  }
}

/**
 * Resolves the profile endpoint (host, socket or URI) and any tunnel override into the socket
 * the driver should open. Throws NOT_SUPPORTED for endpoint kinds or network features the SQL
 * adapters do not handle.
 */
export function resolveEndpoint(resolved: ResolvedProfile): ResolvedEndpoint {
  const { profile } = resolved;
  const engine = profile.engine;
  if (engine !== 'postgres' && engine !== 'mysql' && engine !== 'mariadb') {
    throw new QuerybaraError({
      code: 'NOT_SUPPORTED',
      message: `${ENGINES[engine].displayName} is not a SQL engine`,
    });
  }
  assertSupportedNetwork(resolved);
  const endpoint = profile.endpoint;
  if (!ENDPOINT_KINDS[engine].includes(endpoint.kind)) {
    throw new QuerybaraError({
      code: 'NOT_SUPPORTED',
      message: `${ENGINES[engine].displayName} does not accept a "${endpoint.kind}" endpoint`,
    });
  }
  const defaultPort = ENGINES[engine].defaultPort;
  const override = resolved.endpointOverride;

  let base: Omit<ResolvedEndpoint, 'tunnelled'>;
  switch (endpoint.kind) {
    case 'host':
      base = {
        target: { kind: 'tcp', host: endpoint.host, port: endpoint.port, tlsHost: endpoint.host },
        params: {},
      };
      break;
    case 'socket':
      base = { target: { kind: 'socket', path: endpoint.path }, params: {} };
      break;
    case 'uri': {
      const uri = parseConnectionUri(endpoint.uri, engine);
      // postgres:///db?host=/var/run/postgresql and mysql://u@localhost/db?socket=/tmp/mysql.sock
      const socketPath =
        uri.params['socket'] ??
        (uri.params['host']?.startsWith('/') ? uri.params['host'] : undefined) ??
        (uri.host?.startsWith('/') ? uri.host : undefined);
      const host = uri.host ?? uri.params['host'] ?? 'localhost';
      const port = uri.port ?? (uri.params['port'] ? Number(uri.params['port']) : defaultPort);
      const target: NetworkTarget = socketPath
        ? { kind: 'socket', path: socketPath }
        : { kind: 'tcp', host, port, tlsHost: host };
      base = {
        target,
        params: uri.params,
        ...(uri.user !== undefined ? { user: uri.user } : {}),
        ...(uri.password !== undefined ? { password: uri.password } : {}),
        ...(uri.database !== undefined ? { database: uri.database } : {}),
      };
      break;
    }
    default:
      throw new QuerybaraError({
        code: 'NOT_SUPPORTED',
        message: `${ENGINES[engine].displayName} does not accept a "${endpoint.kind}" endpoint`,
      });
  }

  if (!override) return { ...base, tunnelled: false };
  const tlsHost = base.target.kind === 'tcp' ? base.target.tlsHost : override.host;
  return {
    ...base,
    target: { kind: 'tcp', host: override.host, port: override.port, tlsHost },
    tunnelled: true,
  };
}

/** "host:port" or the socket path, for messages. Hosts and paths are not secrets. */
export function describeTarget(target: NetworkTarget): string {
  if (target.kind === 'socket') return target.path;
  const host = isIP(target.host) === 6 ? `[${target.host}]` : target.host;
  return `${host}:${target.port}`;
}
