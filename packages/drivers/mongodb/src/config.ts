import { isIP } from 'node:net';

import { ENGINES, JoineryError, type HostPort, type ResolvedProfile } from '@joinery/core';
import {
  assertSupportedNetwork,
  buildTlsSettings,
  type FileReader,
  type TlsSettings,
} from '@joinery/driver-sql-base';
import { nodeRouteOf, tunnelReach } from '@joinery/tunnel';
import type { AuthMechanism, MongoClientOptions } from 'mongodb';

/** Everything needed to open a MongoClient for a profile. */
export interface MongoClientPlan {
  /** The connection string, without credentials (they go in `options.auth`). */
  readonly url: string;
  readonly options: MongoClientOptions;
  readonly tls: TlsSettings;
  /** The seed hosts, or the SRV name, for messages and Test Connection. */
  readonly seeds: readonly HostPort[];
  readonly srv: boolean;
  /** "host:port[, host:port]" (never credentials), for messages. */
  readonly where: string;
  /** The session's initial database: the profile's default, the URI's, else "test". */
  readonly defaultDatabase: string;
  /** Through an SSH tunnel or proxy (endpointOverride, and `routed` for several servers). */
  readonly tunnelled: boolean;
  /**
   * Every server reached through the tunnel's SOCKS5 endpoint (a host list, SRV name or replica
   * set URI behind a tunnel or proxy); otherwise a tunnel reaches one host, connected directly.
   */
  readonly routed: boolean;
  /** The replica set name the profile asks for, if any. */
  readonly replicaSet?: string;
  /** Secret values that must never appear in messages. */
  readonly secrets: readonly string[];
}

/** The parts of a `mongodb://` or `mongodb+srv://` URI. */
export interface MongoUriParts {
  readonly srv: boolean;
  readonly user?: string;
  readonly password?: string;
  /** Comma-separated host list as written. */
  readonly hosts: string;
  readonly database?: string;
  /** The query string without "?". */
  readonly query: string;
}

function invalidUri(reason: string): JoineryError {
  // The URI itself is never quoted: it may hold a password.
  return new JoineryError({
    code: 'VALIDATION_FAILED',
    message: `The MongoDB connection string is not valid: ${reason}`,
    hint: 'Use the form mongodb://host:port/database?options or mongodb+srv://cluster.example.net',
  });
}

function decode(part: string): string {
  try {
    return decodeURIComponent(part);
  } catch {
    throw invalidUri('it contains a malformed percent-escape');
  }
}

/** Splits a MongoDB connection string into credentials, hosts, database and options. */
export function splitMongoUri(uri: string): MongoUriParts {
  const trimmed = uri.trim();
  const match = /^(mongodb(?:\+srv)?):\/\//i.exec(trimmed);
  if (!match) throw invalidUri('it must start with mongodb:// or mongodb+srv://');
  const rest = trimmed.slice(match[0].length);
  const authorityEnd = rest.search(/[/?]/);
  const authority = authorityEnd === -1 ? rest : rest.slice(0, authorityEnd);
  const tail = authorityEnd === -1 ? '' : rest.slice(authorityEnd);
  const at = authority.lastIndexOf('@');
  const userinfo = at === -1 ? undefined : authority.slice(0, at);
  const hosts = at === -1 ? authority : authority.slice(at + 1);
  if (hosts === '') throw invalidUri('it names no host');
  const queryStart = tail.indexOf('?');
  const path = (queryStart === -1 ? tail : tail.slice(0, queryStart)).replace(/^\//, '');
  const query = queryStart === -1 ? '' : tail.slice(queryStart + 1);
  const parts: { -readonly [K in keyof MongoUriParts]: MongoUriParts[K] } = {
    srv: match[1]!.toLowerCase() === 'mongodb+srv',
    hosts,
    query,
  };
  if (userinfo !== undefined) {
    const colon = userinfo.indexOf(':');
    const user = colon === -1 ? userinfo : userinfo.slice(0, colon);
    if (user !== '') parts.user = decode(user);
    if (colon !== -1) parts.password = decode(userinfo.slice(colon + 1));
  }
  if (path !== '') parts.database = decode(path);
  return parts;
}

/** Parses "a:1,b,[::1]:3" into host/port pairs (the default port when none is given). */
export function parseHostList(
  hosts: string,
  defaultPort = ENGINES.mongodb.defaultPort,
): HostPort[] {
  return hosts.split(',').map((entry) => {
    const bracketed = /^\[([^\]]+)\](?::(\d+))?$/.exec(entry);
    if (bracketed) {
      return { host: bracketed[1]!, port: bracketed[2] ? Number(bracketed[2]) : defaultPort };
    }
    const colon = entry.lastIndexOf(':');
    if (colon !== -1 && entry.indexOf(':') === colon) {
      const port = Number(entry.slice(colon + 1));
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw invalidUri(`"${entry.slice(0, colon)}" has an invalid port`);
      }
      return { host: decode(entry.slice(0, colon)), port };
    }
    return { host: decode(entry), port: defaultPort };
  });
}

/** "host:port" with IPv6 hosts bracketed. */
export function hostPortText({ host, port }: HostPort): string {
  return `${isIP(host) === 6 ? `[${host}]` : host}:${port}`;
}

function queryParams(query: string): URLSearchParams {
  return new URLSearchParams(query);
}

const PASSWORD_MECHANISMS: Readonly<Record<string, AuthMechanism>> = {
  DEFAULT: 'DEFAULT',
  'SCRAM-SHA-1': 'SCRAM-SHA-1',
  'SCRAM-SHA-256': 'SCRAM-SHA-256',
  PLAIN: 'PLAIN',
  LDAP: 'PLAIN',
};

/**
 * Builds the MongoClient connection string and options for a resolved profile (spec §4):
 *
 * - Endpoints: `host`, `hosts` (+ replica set), `srv` (mongodb+srv) and `uri` (credentials are
 *   taken out of the string and passed as options).
 * - Tunnels (ADR 0008): a single host behind an SSH tunnel or proxy (`endpointOverride` alone)
 *   is connected to through the forward with `directConnection: true`. A host list, SRV name
 *   or replica set URI behind one comes with a node route (`nodeRouteOf`): the client keeps the
 *   profile's own seeds and sends every connection through the route's SOCKS5 endpoint
 *   (`proxyHost`...), so it discovers the members and reaches them by the names they
 *   announce, resolved on the far side. SRV and TXT records are still looked up locally.
 * - Auth: `none`; `password` with SCRAM-SHA-1/256 (or LDAP as PLAIN in `$external`) from
 *   `mechanism`; `clientCertificate` as MONGODB-X509 from the TLS certificate.
 * - TLS: disable → no TLS; require → tlsAllowInvalidCertificates; verify-ca →
 *   tlsAllowInvalidHostnames; verify-full → full checks (pinned to the profile host name when
 *   tunnelled or when a server name override is set). CA, client certificate, key and key
 *   passphrase come from the profile; secrets only from `resolved.secrets`.
 * - Options: authSource, directConnection, readPreference, connect timeout (also the server
 *   selection timeout, so a dead server fails as fast as a refused one), idle timeout,
 *   application name and default database.
 */
export function buildMongoClientPlan(
  resolved: ResolvedProfile,
  opts: { readonly readFile?: FileReader } = {},
): MongoClientPlan {
  const { profile } = resolved;
  if (profile.engine !== 'mongodb') {
    throw new JoineryError({
      code: 'VALIDATION_FAILED',
      message: `The MongoDB adapter cannot open a ${ENGINES[profile.engine].displayName} profile`,
    });
  }
  assertSupportedNetwork(resolved);
  // Behind a tunnel: one forwarded host, or every member through the node route.
  const reach = resolved.endpointOverride ? tunnelReach(profile) : undefined;
  const route = reach?.kind === 'nodes' ? nodeRouteOf(resolved) : undefined;
  if (reach?.kind === 'nodes' && !route) {
    throw new JoineryError({
      code: 'NOT_SUPPORTED',
      message:
        'This profile reaches several MongoDB servers through its tunnel, but only one forwarded host was given',
      hint: 'Open it through the connection host, which reaches every member through the tunnel (see connectThroughTransport)',
    });
  }
  const override = reach?.kind === 'host' ? resolved.endpointOverride : undefined;
  const tunnelledTo = reach?.kind === 'host' ? reach.target : undefined;
  const options = profile.options;
  const endpoint = profile.endpoint;
  const secrets = Object.values(resolved.secrets).filter((value) => value.length > 0);

  let seeds: HostPort[];
  let srv = false;
  let uriParts: MongoUriParts | undefined;
  let replicaSet: string | undefined;
  switch (endpoint.kind) {
    case 'host':
      seeds = [{ host: endpoint.host, port: endpoint.port }];
      break;
    case 'hosts':
      seeds = endpoint.hosts.map((h) => ({ host: h.host, port: h.port }));
      replicaSet = endpoint.replicaSet;
      break;
    case 'srv':
      seeds = [{ host: endpoint.host, port: ENGINES.mongodb.defaultPort }];
      srv = true;
      break;
    case 'uri':
      uriParts = splitMongoUri(endpoint.uri);
      srv = uriParts.srv;
      seeds = srv
        ? [{ host: uriParts.hosts, port: ENGINES.mongodb.defaultPort }]
        : parseHostList(uriParts.hosts);
      replicaSet = queryParams(uriParts.query).get('replicaSet') ?? undefined;
      if (uriParts.password !== undefined) secrets.push(uriParts.password);
      break;
    default:
      throw new JoineryError({
        code: 'NOT_SUPPORTED',
        message: `MongoDB does not accept a "${endpoint.kind}" endpoint`,
        hint: 'Use a host, a host list, an SRV name or a mongodb:// connection string',
      });
  }

  const database = options.defaultDatabase ?? uriParts?.database ?? 'test';
  const path = uriParts?.database !== undefined ? `/${encodeURIComponent(uriParts.database)}` : '/';
  const query = uriParts?.query ? `?${uriParts.query}` : '';
  let url: string;
  if (override) {
    url = `mongodb://${hostPortText(override)}${path}${query}`;
  } else if (srv) {
    url = `mongodb+srv://${uriParts?.hosts ?? seeds[0]!.host}${path}${query}`;
  } else {
    url = `mongodb://${seeds.map(hostPortText).join(',')}${path}${query}`;
  }

  const client: MongoClientOptions = {
    appName: options.applicationName,
    connectTimeoutMS: options.connectTimeoutMs,
    serverSelectionTimeoutMS: options.connectTimeoutMs,
    maxPoolSize: 10,
    monitorCommands: false,
  };
  if (options.idleTimeoutMs !== undefined) client.maxIdleTimeMS = options.idleTimeoutMs;
  if (replicaSet !== undefined && endpoint.kind === 'hosts') client.replicaSet = replicaSet;
  if (override) client.directConnection = true;
  else if (options.directConnection !== undefined)
    client.directConnection = options.directConnection;
  if (route) {
    // The driver opens every connection (monitoring and pool, to each member) through here.
    const socks = route.socks5;
    client.proxyHost = socks.host;
    client.proxyPort = socks.port;
    client.proxyUsername = socks.user;
    client.proxyPassword = socks.password;
    secrets.push(socks.password);
  }
  if (options.readPreference !== undefined) client.readPreference = options.readPreference;

  const tlsHost = tunnelledTo?.host ?? seeds[0]!.host;
  const tls = buildTlsSettings(
    resolved,
    {
      kind: 'tcp',
      host: override?.host ?? seeds[0]!.host,
      port: override?.port ?? seeds[0]!.port,
      tlsHost,
    },
    opts.readFile,
  );
  Object.assign(
    client,
    tlsOptions(tls, profile.tls.servername !== undefined || override !== undefined),
  );
  Object.assign(client, authOptions(resolved, uriParts));

  const named = srv
    ? `${uriParts?.hosts ?? seeds[0]!.host} (SRV)`
    : seeds.map(hostPortText).join(', ');
  const where = override
    ? `${hostPortText(override)} (tunnel to ${hostPortText(tunnelledTo!)})`
    : route
      ? `${named} through the tunnel`
      : named;
  return {
    url,
    options: client,
    tls,
    seeds,
    srv,
    where,
    defaultDatabase: database,
    tunnelled: override !== undefined || route !== undefined,
    routed: route !== undefined,
    ...(replicaSet !== undefined ? { replicaSet } : {}),
    secrets,
  };
}

/**
 * The driver's TLS options for a TLS mode. `pinned` keeps buildTlsSettings' server name and
 * identity check (the profile host behind a tunnel, or an explicit override); otherwise each
 * member's certificate is checked against its own host name, which a host list or SRV needs.
 */
export function tlsOptions(tls: TlsSettings, pinned: boolean): MongoClientOptions {
  if (tls.mode === 'disable' || !tls.options) return { tls: false };
  const source = tls.options;
  const out: MongoClientOptions = { tls: true };
  if (source.ca !== undefined) out.ca = source.ca;
  if (source.cert !== undefined) out.cert = source.cert;
  if (source.key !== undefined) out.key = source.key;
  if (source.passphrase !== undefined) out.passphrase = source.passphrase;
  switch (tls.mode) {
    case 'require':
      out.tlsAllowInvalidCertificates = true;
      break;
    case 'verify-ca':
      out.tlsAllowInvalidHostnames = true;
      break;
    case 'verify-full':
      if (pinned) {
        if (source.servername !== undefined) out.servername = source.servername;
        if (source.checkServerIdentity !== undefined) {
          out.checkServerIdentity = source.checkServerIdentity;
        }
      }
      break;
  }
  return out;
}

/** The driver's auth options for the profile's auth method (see buildMongoClientPlan). */
export function authOptions(
  resolved: ResolvedProfile,
  uri?: Pick<MongoUriParts, 'user' | 'password'>,
): MongoClientOptions {
  const { auth, tls, options } = resolved.profile;
  const withSource = (defaultSource?: string): MongoClientOptions => {
    const source = options.authSource ?? defaultSource;
    return source !== undefined ? { authSource: source } : {};
  };
  switch (auth.method) {
    case 'none':
      return {};
    case 'password': {
      const user = auth.user ?? uri?.user;
      let password: string | undefined;
      if (auth.password) {
        password = resolved.secrets[auth.password.id];
        if (password === undefined) {
          throw new JoineryError({
            code: 'AUTH_FAILED',
            message: 'The password for this connection was not provided',
            hint: 'Enter the password, or save it in the profile',
          });
        }
      } else {
        password = uri?.password;
      }
      const requested = auth.mechanism?.trim().toUpperCase();
      const mechanism =
        requested === undefined || requested === '' ? undefined : PASSWORD_MECHANISMS[requested];
      if (requested && mechanism === undefined) {
        throw new JoineryError({
          code: 'NOT_SUPPORTED',
          message: `The authentication mechanism "${auth.mechanism}" is not supported`,
          hint: 'Use SCRAM-SHA-256, SCRAM-SHA-1, or PLAIN for LDAP',
        });
      }
      if (user === undefined) return withSource();
      const out: MongoClientOptions = {
        auth: { username: user, ...(password !== undefined ? { password } : {}) },
        ...withSource(mechanism === 'PLAIN' ? '$external' : undefined),
      };
      if (mechanism !== undefined && mechanism !== 'DEFAULT') out.authMechanism = mechanism;
      return out;
    }
    case 'clientCertificate': {
      if (tls.mode === 'disable' || !tls.certPath) {
        throw new JoineryError({
          code: 'VALIDATION_FAILED',
          message: 'X.509 authentication needs TLS with a client certificate',
          hint: 'Turn TLS on and set the client certificate (and key) file',
        });
      }
      const user = auth.user ?? uri?.user;
      return {
        authMechanism: 'MONGODB-X509',
        authSource: '$external',
        ...(user !== undefined ? { auth: { username: user } } : {}),
      };
    }
    case 'apiKey':
    case 'bearer':
      throw new JoineryError({
        code: 'NOT_SUPPORTED',
        message: `"${auth.method}" authentication does not apply to MongoDB`,
        hint: 'Use password (SCRAM or LDAP) or X.509 authentication',
      });
  }
}

/**
 * Removes credentials and secret values from a message: the user info of any MongoDB URI,
 * secret-bearing URI options, and every secret the profile holds (short ones only where they
 * stand alone, so a two-letter password does not blank out every word).
 */
export function redactSecrets(text: string, secrets: readonly string[]): string {
  let out = text
    .replace(/(mongodb(?:\+srv)?:\/\/)[^@/\s]*@/gi, '$1<credentials>@')
    .replace(/((?:tlsCertificateKeyFilePassword|sslPEMKeyPassword)[=:])[^&,\s]*/gi, '$1***')
    // Mechanism properties can carry a session token among other key:value pairs.
    .replace(/(authMechanismProperties=)[^&\s]*/gi, '$1***');
  for (const secret of secrets) {
    if (secret.length >= 4) {
      out = out.split(secret).join('***');
    } else if (secret.length > 0) {
      const escaped = secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      out = out.replace(new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'gu'), '***');
    }
  }
  return out;
}
