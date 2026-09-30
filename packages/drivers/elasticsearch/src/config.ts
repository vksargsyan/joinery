import { readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import type { ConnectionOptions as TlsConnectionOptions } from 'node:tls';

import { ENGINES, JoineryError, type ResolvedProfile, type TlsMode } from '@joinery/core';
import { buildTlsSettings, type FileReader, type TlsSettings } from '@joinery/driver-sql-base';
import { cloudIdUrl, needsTransport, tunnelTarget } from '@joinery/tunnel';

/** One node the client sends requests to. */
export interface SearchNodeTarget {
  readonly protocol: 'http:' | 'https:';
  /** Where the socket connects: the node, or an SSH tunnel's (or proxy's) local end. */
  readonly host: string;
  readonly port: number;
  /** The node's own "host:port", sent as the Host header even through a tunnel. */
  readonly hostHeader: string;
  /** A path prefix of a node behind a reverse proxy, e.g. "/es" ('' when none). */
  readonly pathPrefix: string;
  /** "https://es1.example.com:9200" (never credentials), for messages. */
  readonly label: string;
  /** Node TLS options for https nodes; undefined for http. */
  readonly tls?: TlsConnectionOptions;
  readonly tlsSettings?: TlsSettings;
}

export type SearchAuthMethod = 'none' | 'basic' | 'apiKey' | 'bearer' | 'certificate';

/** Everything needed to talk to a cluster for a profile. */
export interface SearchClientPlan {
  readonly nodes: readonly SearchNodeTarget[];
  /** The Authorization header value; a secret. */
  readonly authorization?: string;
  readonly authMethod: SearchAuthMethod;
  readonly user?: string;
  readonly connectTimeoutMs: number;
  /** A time limit for each request; none when the profile sets no query timeout. */
  readonly requestTimeoutMs?: number;
  readonly keepAlive: boolean;
  /** Discover the other nodes from the listed ones (never through a tunnel or for a Cloud ID). */
  readonly sniff: boolean;
  /** Sent as User-Agent and X-Opaque-Id prefix (the application name). */
  readonly applicationName: string;
  /** "https://a:9200, https://b:9200", or the Cloud ID's deployment; never credentials. */
  readonly where: string;
  /** Through an SSH tunnel or proxy (one node, reached at the tunnel's local end). */
  readonly tunnelled: boolean;
  readonly cloud: boolean;
  /** Secret values (and the encoded Authorization header) that must never appear in messages. */
  readonly secrets: readonly string[];
}

function invalid(message: string, hint: string): JoineryError {
  return new JoineryError({ code: 'VALIDATION_FAILED', message, hint });
}

/** A node URL parsed: scheme (http unless TLS is on), host, port and path prefix. */
export interface ParsedNodeUrl {
  readonly protocol: 'http:' | 'https:';
  readonly host: string;
  readonly port: number;
  readonly pathPrefix: string;
  /** A user name written into the URL ("https://elastic@host"). */
  readonly user?: string;
}

/**
 * Parses a node URL as typed in the profile. A URL without a scheme is https unless the
 * profile's TLS mode is `disable`; without a port it is the scheme's (443 or 80), as every
 * Elasticsearch client reads it. A password in the URL is refused: profiles keep it as a
 * secret. The URL itself is never echoed (it may hold one).
 */
export function parseNodeUrl(url: string, tlsMode: TlsMode): ParsedNodeUrl {
  const text = url.trim();
  if (text === '') throw invalid('A node URL is empty', 'Enter a URL such as https://host:9200');
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(text)?.[1]?.toLowerCase();
  if (scheme !== undefined && scheme !== 'http' && scheme !== 'https') {
    throw invalid(
      `A node URL uses "${scheme}://"`,
      'Elasticsearch URLs start with http:// or https://',
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(scheme ? text : `${tlsMode === 'disable' ? 'http' : 'https'}://${text}`);
  } catch {
    throw invalid('A node URL is not valid', 'Use the form https://host:9200');
  }
  if (parsed.password) {
    throw invalid(
      'A node URL holds a password',
      'Remove it from the URL and enter it in the password field, which keeps it in the keychain',
    );
  }
  const protocol = parsed.protocol === 'http:' ? 'http:' : 'https:';
  const host = parsed.hostname.replace(/^\[(.*)\]$/, '$1');
  if (host === '') throw invalid('A node URL has no host', 'Use the form https://host:9200');
  const port = parsed.port ? Number(parsed.port) : protocol === 'http:' ? 80 : 443;
  const pathPrefix = parsed.pathname.replace(/\/+$/, '');
  return {
    protocol,
    host,
    port,
    pathPrefix,
    ...(parsed.username ? { user: decodeURIComponent(parsed.username) } : {}),
  };
}

/** "host:port" with IPv6 hosts bracketed. */
export function hostPort(host: string, port: number): string {
  return `${isIP(host) === 6 ? `[${host}]` : host}:${port}`;
}

function originLabel(protocol: string, host: string, port: number, prefix: string): string {
  return `${protocol}//${hostPort(host, port)}${prefix}`;
}

/** Base64 of UTF-8 text (Basic credentials, API keys given as id:key). */
function base64(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64');
}

function secret(resolved: ResolvedProfile, id: string, what: string): string {
  const value = resolved.secrets[id];
  if (value === undefined) {
    throw new JoineryError({
      code: 'AUTH_FAILED',
      message: `The ${what} for this connection was not provided`,
      hint: `Enter the ${what}, or save it in the profile`,
    });
  }
  return value;
}

/**
 * The target of one node: its socket address (the tunnel's local end when there is one), its
 * own name for the Host header, and for https its TLS options, checked against its own name.
 */
export function buildNodeTarget(
  resolved: ResolvedProfile,
  node: ParsedNodeUrl,
  override?: { readonly host: string; readonly port: number },
  readFile: FileReader = readFileSync,
): SearchNodeTarget {
  const { profile } = resolved;
  const label = originLabel(node.protocol, node.host, node.port, node.pathPrefix);
  const socketHost = override?.host ?? node.host;
  const socketPort = override?.port ?? node.port;
  const base = {
    protocol: node.protocol,
    host: socketHost,
    port: socketPort,
    hostHeader: hostPort(node.host, node.port),
    pathPrefix: node.pathPrefix,
    label,
  };
  if (node.protocol === 'http:') return base;
  // An https URL asks for TLS even when the profile left it off (as rediss:// does for Redis).
  const https: ResolvedProfile =
    profile.tls.mode === 'disable'
      ? { ...resolved, profile: { ...profile, tls: { ...profile.tls, mode: 'verify-full' } } }
      : resolved;
  const tlsSettings = buildTlsSettings(
    https,
    { kind: 'tcp', host: socketHost, port: socketPort, tlsHost: node.host },
    readFile,
  );
  return { ...base, ...(tlsSettings.options ? { tls: tlsSettings.options } : {}), tlsSettings };
}

/**
 * Builds the client plan for a resolved profile (spec §4):
 *
 * - Endpoints: the `urls` list, or a Cloud ID (Elasticsearch only), which names one https
 *   endpoint. The URL scheme decides TLS: https nodes use the profile's TLS mode (a mode of
 *   `disable` becomes verify-full, as rediss:// does for Redis), http nodes have none.
 * - Tunnels: with `endpointOverride` (an SSH tunnel or proxy) the single node is reached at the
 *   tunnel's local end, keeping its own name for the Host header and TLS verification.
 * - Auth: none; basic (user and password); an API key (`id:key` is encoded, an encoded key is
 *   sent as is); a bearer token; or a TLS client certificate (PKI realm), with no header.
 *   Secrets come only from `resolved.secrets`.
 * - Options: connect timeout, query timeout as the request timeout, keep-alive, sniffing (off
 *   by default, never through a tunnel or for a Cloud ID) and the application name.
 */
export function buildSearchClientPlan(
  resolved: ResolvedProfile,
  options: { readonly readFile?: FileReader } = {},
): SearchClientPlan {
  const { profile } = resolved;
  if (profile.engine !== 'elasticsearch') {
    throw new JoineryError({
      code: 'VALIDATION_FAILED',
      message: `The Elasticsearch adapter cannot open a ${ENGINES[profile.engine].displayName} profile`,
    });
  }
  const transport = needsTransport(profile);
  if (transport) {
    // Throws NOT_SUPPORTED with a hint for several URLs.
    tunnelTarget(profile);
    if (!resolved.endpointOverride) {
      throw new JoineryError({
        code: 'NOT_SUPPORTED',
        message: profile.ssh
          ? 'This profile uses an SSH tunnel, but no tunnel is open for it'
          : 'This profile uses a proxy, but no proxy route is open for it',
        hint: 'Tunnels and proxies are opened by the connection host; connect through it rather than calling the driver directly',
      });
    }
  }
  const override = transport ? resolved.endpointOverride : undefined;
  const endpoint = profile.endpoint;
  let urls: string[];
  let cloud = false;
  switch (endpoint.kind) {
    case 'urls':
      urls = endpoint.urls;
      break;
    case 'cloudId':
      urls = [cloudIdUrl(endpoint.cloudId)];
      cloud = true;
      break;
    default:
      throw new JoineryError({
        code: 'NOT_SUPPORTED',
        message: `${ENGINES[profile.engine].displayName} does not accept a "${endpoint.kind}" endpoint`,
        hint: 'Use node URLs such as https://host:9200 (or a Cloud ID for Elastic Cloud)',
      });
  }
  if (urls.length === 0) throw invalid('No node URL is set', 'Add at least one URL');
  const parsedUrls = urls.map((url) => parseNodeUrl(url, cloud ? 'verify-full' : profile.tls.mode));
  const readFile = options.readFile ?? readFileSync;

  const nodes = parsedUrls.map((node) => buildNodeTarget(resolved, node, override, readFile));

  const auth = profile.auth;
  const secrets = Object.values(resolved.secrets).filter((value) => value.length > 0);
  let authorization: string | undefined;
  let authMethod: SearchAuthMethod = 'none';
  let user: string | undefined = parsedUrls[0]?.user;
  switch (auth.method) {
    case 'none':
      break;
    case 'password': {
      user = auth.user ?? user;
      if (user === undefined) {
        throw invalid('Basic authentication needs a user name', 'Enter the user, e.g. elastic');
      }
      const password = auth.password ? secret(resolved, auth.password.id, 'password') : '';
      authorization = `Basic ${base64(`${user}:${password}`)}`;
      authMethod = 'basic';
      break;
    }
    case 'apiKey': {
      const key = secret(resolved, auth.apiKey.id, 'API key').trim();
      // "id:api_key" is encoded; the encoded form Elasticsearch shows is sent as is.
      authorization = `ApiKey ${key.includes(':') ? base64(key) : key}`;
      authMethod = 'apiKey';
      break;
    }
    case 'bearer':
      authorization = `Bearer ${secret(resolved, auth.token.id, 'token').trim()}`;
      authMethod = 'bearer';
      break;
    case 'clientCertificate':
      if (!nodes.some((node) => node.protocol === 'https:') || !profile.tls.certPath) {
        throw invalid(
          'Certificate authentication needs https and a client certificate',
          'Use https:// URLs and set the client certificate and key under TLS',
        );
      }
      user = auth.user;
      authMethod = 'certificate';
      break;
  }
  if (authorization !== undefined)
    secrets.push(authorization.slice(authorization.indexOf(' ') + 1));

  const opts = profile.options;
  const where = cloud
    ? `Elastic Cloud ${nodes[0]!.label}`
    : override
      ? `${nodes[0]!.label} (through the tunnel)`
      : nodes.map((node) => node.label).join(', ');
  return {
    nodes,
    ...(authorization !== undefined ? { authorization } : {}),
    authMethod,
    ...(user !== undefined ? { user } : {}),
    connectTimeoutMs: opts.connectTimeoutMs,
    ...(opts.queryTimeoutMs !== undefined ? { requestTimeoutMs: opts.queryTimeoutMs } : {}),
    keepAlive: opts.keepAlive,
    sniff: opts.sniff === true && !override && !cloud,
    applicationName: opts.applicationName,
    where,
    tunnelled: override !== undefined,
    cloud,
    secrets,
  };
}

/**
 * Removes secrets from a message: credentials written into URLs, Authorization header values,
 * and every secret the profile holds (short ones only where they stand alone).
 */
export function redactSecrets(text: string, secrets: readonly string[]): string {
  let out = text
    .replace(/(https?:\/\/)[^@/\s]*@/gi, '$1<credentials>@')
    .replace(/\b(Basic|ApiKey|Bearer)\s+[A-Za-z0-9+/=._~-]+/g, '$1 ***');
  for (const value of secrets) {
    if (value.length >= 4) {
      out = out.split(value).join('***');
    } else if (value.length > 0) {
      const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      out = out.replace(new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'gu'), '***');
    }
  }
  return out;
}
