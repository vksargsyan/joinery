import { readFileSync } from 'node:fs';

import { QuerybaraError, type HostPort, type ResolvedProfile } from '@querybara/core';
import {
  buildTlsSettings,
  describeTarget,
  type FileReader,
  type NetworkTarget,
  type TlsSettings,
} from '@querybara/driver-sql-base';
import { needsTransport, nodeRouteOf, tunnelReach, type NodeRoute } from '@querybara/tunnel';
import type { ConnectionOptions as TlsConnectionOptions } from 'node:tls';

import type { RedisTopology } from './types';

/** The parts of a `redis://`, `rediss://`, `valkey://` or `unix://` URI the driver uses. */
export interface ParsedRedisUri {
  readonly tls: boolean;
  readonly host?: string;
  readonly port?: number;
  readonly socketPath?: string;
  readonly user?: string;
  /** Parsed so it can be redacted or moved to a secret; the driver never uses it. */
  readonly password?: string;
  readonly database?: number;
}

const DEFAULT_PORT = 6379;

function invalidUri(reason: string): QuerybaraError {
  // The URI itself is never echoed: a pasted one may still hold a password.
  return new QuerybaraError({
    code: 'VALIDATION_FAILED',
    message: `The Redis URI is not valid: ${reason}`,
    hint: 'Use redis://[user@]host[:port][/db] (rediss:// for TLS) or unix:///path/to/redis.sock',
  });
}

function decode(part: string): string {
  try {
    return decodeURIComponent(part);
  } catch {
    throw invalidUri('it contains a malformed percent-escape');
  }
}

function parseDatabase(text: string, what: string): number {
  if (!/^\d+$/.test(text.trim())) {
    throw new QuerybaraError({
      code: 'VALIDATION_FAILED',
      message: `The ${what} "${text}" is not a logical database number`,
      hint: 'Use a number from 0 to the server’s "databases" setting minus one (0-15 by default)',
    });
  }
  return Number(text.trim());
}

/**
 * Parses a Redis URI: `redis://[[user]:password@]host[:port][/db]`, `rediss://` for TLS
 * (also `valkey://`, `valkeys://`), and `unix:///path?db=N` for a socket. `?db=` works on any
 * form. Single host only.
 */
export function parseRedisUri(uri: string): ParsedRedisUri {
  const text = uri.trim();
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(text)?.[1]?.toLowerCase();
  if (!scheme) throw invalidUri('it has no scheme');
  if (!['redis', 'rediss', 'valkey', 'valkeys', 'unix', 'redis+unix'].includes(scheme)) {
    throw invalidUri(`"${scheme}://" is not a Redis scheme (use redis://, rediss:// or unix://)`);
  }
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw invalidUri('it could not be parsed (multiple hosts are not supported)');
  }
  const out: { -readonly [K in keyof ParsedRedisUri]: ParsedRedisUri[K] } = {
    tls: scheme === 'rediss' || scheme === 'valkeys',
  };
  if (url.username) out.user = decode(url.username);
  if (url.password) out.password = decode(url.password);
  const dbParam = url.searchParams.get('db');
  if (scheme === 'unix' || scheme === 'redis+unix') {
    const path = decode(url.pathname);
    if (!path) throw invalidUri('the socket path is missing');
    out.socketPath = path;
  } else {
    const host = url.hostname.replace(/^\[(.*)\]$/, '$1');
    if (host) out.host = decode(host);
    if (url.port) out.port = Number(url.port);
    const path = url.pathname.replace(/^\//, '');
    if (path) out.database = parseDatabase(decode(path), 'URI database');
  }
  if (dbParam !== null) out.database = parseDatabase(dbParam, 'URI database');
  return out;
}

/** The URI with any password removed, for storing and showing. */
export function redactRedisUri(uri: string): string {
  try {
    const url = new URL(uri.trim());
    if (!url.password) return uri.trim();
    url.password = '';
    return url.toString().replace(/:@/, '@');
  } catch {
    return uri.trim().replace(/\/\/([^/@:]*):[^/@]*@/, '//$1@');
  }
}

/** Everything needed to open ioredis connections for a profile. */
export interface RedisConnectionPlan {
  readonly topology: RedisTopology;
  /** Standalone: the socket target. Sentinel / Cluster: the first sentinel or seed. */
  readonly target: NetworkTarget;
  /** Every host the driver may contact first: the target, the sentinels or the seeds. */
  readonly seeds: readonly NetworkTarget[];
  readonly masterName?: string;
  readonly user?: string;
  readonly password?: string;
  /** Logical database (0 in Cluster mode). */
  readonly database: number;
  readonly tls: TlsSettings;
  /** Node TLS options for ioredis, or undefined without TLS. */
  readonly tlsOptions?: TlsConnectionOptions;
  readonly connectTimeoutMs: number;
  readonly commandTimeoutMs?: number;
  readonly keepAlive: boolean;
  /** CLIENT SETNAME value (spaces and control characters replaced). */
  readonly connectionName: string;
  /** "host:port", a socket path, or a description of the sentinels / seeds; never a secret. */
  readonly where: string;
  /** An SSH tunnel or proxy replaced the endpoint. */
  readonly tunnelled: boolean;
  /**
   * Sentinel or Cluster behind an SSH tunnel or proxy: reaches every node by the address it
   * announces (see RedisConnection, which maps them onto forwards with ioredis's NAT map).
   */
  readonly nodeRoute?: NodeRoute;
}

/** CLIENT SETNAME refuses spaces, newlines and other special characters. */
export function connectionNameFor(applicationName: string): string {
  const name = applicationName.replace(/[^\x21-\x7e]+/g, '-').replace(/^-+|-+$/g, '');
  return name || 'Querybara';
}

function tcp(host: string, port: number, tlsHost = host): NetworkTarget {
  return { kind: 'tcp', host, port, tlsHost };
}

function hostPorts(list: readonly HostPort[]): string {
  return list.map((h) => describeTarget(tcp(h.host, h.port))).join(', ');
}

/**
 * Builds the connection plan from a resolved profile: endpoint (host, socket, URI, Sentinel
 * list, cluster seeds, or a tunnel's local end), credentials from the unsealed secrets, TLS,
 * the logical database and session options.
 *
 * - Passwords come only from `resolved.secrets`, never from a URI.
 * - Behind an SSH tunnel or proxy, a host or URI connects to the tunnel's local end; Sentinel
 *   and Cluster need the tunnel's node route (`nodeRoute`), through which every node the
 *   servers announce is reached (ADR 0008).
 * - Sentinels get the same credentials and TLS settings as the master.
 * - `rediss://` turns TLS on; a profile TLS mode of `disable` then becomes `verify-full`.
 * - With several hosts and verify-full, each node's certificate is checked against the host
 *   Querybara connects to (or the TLS server name override, when set).
 */
export function buildRedisConnectionPlan(
  resolved: ResolvedProfile,
  options: { readonly readFile?: FileReader } = {},
): RedisConnectionPlan {
  const { profile } = resolved;
  if (profile.engine !== 'redis') {
    throw new QuerybaraError({
      code: 'VALIDATION_FAILED',
      message: `The Redis adapter cannot open a ${profile.engine} profile`,
    });
  }
  const endpoint = profile.endpoint;
  // Opened by the tunnel layer, which also drops the proxy it went through from the profile.
  const opened = resolved.endpointOverride !== undefined;
  let nodeRoute: NodeRoute | undefined;
  let missingRoute = needsTransport(profile) && !opened;
  if (opened && endpoint.kind !== 'socket') {
    const reach = tunnelReach(profile);
    nodeRoute = reach.kind === 'nodes' ? nodeRouteOf(resolved) : undefined;
    if (reach.kind === 'nodes' && !nodeRoute) missingRoute = true;
  }
  if (missingRoute) {
    throw new QuerybaraError({
      code: 'NOT_SUPPORTED',
      message: profile.ssh
        ? 'This profile uses an SSH tunnel, but no tunnel is open for it'
        : 'This profile uses a proxy, but no proxy route is open for it',
      hint: 'Tunnels and proxies are opened by the connection host; connect through it rather than calling the driver directly',
    });
  }
  // A host or URI goes to the tunnel's local end; Sentinel and Cluster nodes through the route.
  const override = opened && !nodeRoute ? resolved.endpointOverride : undefined;

  let topology: RedisTopology = 'standalone';
  let target: NetworkTarget;
  let seeds: NetworkTarget[];
  let uri: ParsedRedisUri | undefined;
  let masterName: string | undefined;
  let where: string;
  switch (endpoint.kind) {
    case 'host':
      target = override
        ? tcp(override.host, override.port, endpoint.host)
        : tcp(endpoint.host, endpoint.port);
      seeds = [target];
      where = describeTarget(tcp(endpoint.host, endpoint.port));
      break;
    case 'socket':
      target = { kind: 'socket', path: endpoint.path };
      seeds = [target];
      where = endpoint.path;
      break;
    case 'uri': {
      uri = parseRedisUri(endpoint.uri);
      if (uri.socketPath) {
        target = { kind: 'socket', path: uri.socketPath };
        where = uri.socketPath;
      } else {
        const host = uri.host ?? 'localhost';
        const port = uri.port ?? DEFAULT_PORT;
        target = override ? tcp(override.host, override.port, host) : tcp(host, port);
        where = describeTarget(tcp(host, port));
      }
      seeds = [target];
      break;
    }
    case 'sentinel':
      topology = 'sentinel';
      masterName = endpoint.masterName;
      seeds = endpoint.sentinels.map((s) => tcp(s.host, s.port));
      target = seeds[0]!;
      where = `master "${endpoint.masterName}" via Sentinel ${hostPorts(endpoint.sentinels)}`;
      break;
    case 'cluster':
      topology = 'cluster';
      seeds = endpoint.seeds.map((s) => tcp(s.host, s.port));
      target = seeds[0]!;
      where = `cluster seeds ${hostPorts(endpoint.seeds)}`;
      break;
    default:
      throw new QuerybaraError({
        code: 'NOT_SUPPORTED',
        message: `Redis does not accept a "${endpoint.kind}" endpoint`,
        hint: 'Use a host and port, a Unix socket, a Sentinel list, cluster seeds or a redis:// URI',
      });
  }

  if (override && target.kind === 'socket') {
    throw new QuerybaraError({
      code: 'NOT_SUPPORTED',
      message: 'A Unix socket endpoint cannot be reached through an SSH tunnel or a proxy',
      hint: 'Use the host and TCP port of Redis as seen from the SSH server, or remove the tunnel',
    });
  }

  // Credentials come from the unsealed secrets only; a password left in a URI is ignored (the
  // connection host stores it as a secret when a URI is imported).
  const auth = profile.auth;
  let user: string | undefined = uri?.user || undefined;
  let password: string | undefined;
  switch (auth.method) {
    case 'none':
      break;
    case 'password':
      if (auth.user) user = auth.user;
      if (auth.password) {
        password = resolved.secrets[auth.password.id];
        if (password === undefined) {
          throw new QuerybaraError({
            code: 'AUTH_FAILED',
            message: 'The password for this connection was not provided',
            hint: 'Enter the password, or save it in the profile',
          });
        }
      }
      break;
    case 'clientCertificate':
      if (profile.tls.mode === 'disable' && !uri?.tls) {
        throw new QuerybaraError({
          code: 'VALIDATION_FAILED',
          message: 'Client certificate authentication needs TLS with a certificate and key file',
          hint: 'Turn TLS on and set the client certificate and key paths',
        });
      }
      if (auth.user) user = auth.user;
      password = undefined;
      break;
    default:
      throw new QuerybaraError({
        code: 'NOT_SUPPORTED',
        message: `"${auth.method}" authentication does not apply to Redis`,
        hint: 'Use password authentication (with an ACL user name if the server has ACL users)',
      });
  }

  // TLS. rediss:// asks for TLS even when the profile left it off.
  const tlsResolved: ResolvedProfile =
    uri?.tls && profile.tls.mode === 'disable'
      ? { ...resolved, profile: { ...profile, tls: { ...profile.tls, mode: 'verify-full' } } }
      : resolved;
  const tls = buildTlsSettings(tlsResolved, target, options.readFile ?? readFileSync);
  let tlsOptions = tls.options;
  if (
    tlsOptions &&
    topology !== 'standalone' &&
    tls.mode === 'verify-full' &&
    !profile.tls.servername
  ) {
    // Several hosts: let Node check each certificate against the host actually connected to.
    const { servername: _servername, checkServerIdentity: _check, ...rest } = tlsOptions;
    tlsOptions = rest;
  }

  const opts = profile.options;
  let database = 0;
  if (topology !== 'cluster') {
    if (opts.defaultDatabase !== undefined && opts.defaultDatabase.trim() !== '') {
      database = parseDatabase(opts.defaultDatabase, 'default database');
    } else if (uri?.database !== undefined) {
      database = uri.database;
    }
  }

  return {
    topology,
    target,
    seeds,
    ...(masterName !== undefined ? { masterName } : {}),
    ...(user !== undefined ? { user } : {}),
    ...(password !== undefined ? { password } : {}),
    database,
    tls,
    ...(tlsOptions ? { tlsOptions } : {}),
    connectTimeoutMs: opts.connectTimeoutMs,
    ...(opts.queryTimeoutMs !== undefined ? { commandTimeoutMs: opts.queryTimeoutMs } : {}),
    keepAlive: opts.keepAlive,
    connectionName: connectionNameFor(opts.applicationName),
    where: override || nodeRoute ? `${where} (through the tunnel)` : where,
    tunnelled: override !== undefined || nodeRoute !== undefined,
    ...(nodeRoute ? { nodeRoute } : {}),
  };
}
