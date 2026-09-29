import {
  ENGINES,
  JoineryError,
  connectionOptionsSchema,
  connectionProfileSchema,
  newId,
  type ConnectionProfileInput,
  type EngineId,
  type TlsMode,
} from '@joinery/core';
import { z } from 'zod';

import { defineHiddenSecret } from '../internal/redact';

/** A profile without the fields the store assigns; `ProfileRepository.save` takes it as is. */
export type ConnectionProfileDraft = Omit<ConnectionProfileInput, 'id' | 'createdAt' | 'updatedAt'>;

export interface ParseConnectionUriOptions {
  /**
   * The engine behind the URI. Required for http(s):// URLs (elasticsearch or opensearch);
   * picks MariaDB for a mysql:// URI. Must agree with the scheme otherwise.
   */
  readonly engine?: EngineId;
  /** Profile name; defaults to host[:port][/database]. */
  readonly name?: string;
}

export interface ParsedConnectionUri {
  /**
   * The profile. When the URI holds more than the structured fields can express (several
   * PostgreSQL hosts, MongoDB options such as readPreference), the endpoint is a `uri` endpoint
   * keeping the whole URI minus secrets, so nothing is silently dropped.
   */
  readonly profile: ConnectionProfileDraft;
  /**
   * The password from the URI. When present, `profile.auth.password` holds a fresh SecretRef
   * (policy "save") to store it under. Non-enumerable: JSON, inspect and spread skip it.
   */
  readonly password?: string;
  /**
   * Query parameters that were dropped: secret-bearing ones always, and for engines without a
   * `uri` endpoint (Elasticsearch, OpenSearch) every one Joinery could not map.
   */
  readonly ignoredParams: readonly string[];
}

/**
 * Parses a pasted connection URI (spec §4, "Import from ... pasted URIs") for PostgreSQL
 * (`postgres://`, `postgresql://`, `jdbc:postgresql://`), MySQL and MariaDB (`mysql://`,
 * `mariadb://`), MongoDB (`mongodb://`, `mongodb+srv://`), Redis (`redis://`, `rediss://`,
 * `redis+sentinel://`, `unix://`) and Elasticsearch / OpenSearch (`http://`, `https://` with
 * `options.engine`).
 *
 * TLS settings stated by the URI (sslmode, ssl-mode, ssl, tls, rediss://, https://) are mapped
 * to the profile's TLS mode; when the URI says nothing, the profile keeps Joinery's safe default
 * (verify-full). Error messages never quote the URI, which may contain a password.
 */
export function parseConnectionUri(
  uri: string,
  options: ParseConnectionUriOptions = {},
): ParsedConnectionUri {
  const parts = splitUri(uri);
  const engine = engineFor(parts.scheme, options.engine);
  const params = new Params(parts.params);
  const built = buildDraft(engine, parts, params);
  const secretNames = params.unusedSecretNames();
  const ignoredParams = built.keepsUri ? secretNames : [...params.unusedNames(), ...secretNames];

  const draft: ConnectionProfileDraft = {
    name: options.name ?? built.name,
    engine,
    endpoint: built.keepsUri ? { kind: 'uri', uri: sanitizedUri(parts, params) } : built.endpoint,
    ...(built.auth ? { auth: built.auth } : {}),
    ...(built.tls ? { tls: built.tls } : {}),
    ...(Object.keys(built.options).length > 0 ? { options: built.options } : {}),
  };
  const check = connectionProfileSchema.safeParse({
    ...draft,
    id: 'draft',
    createdAt: EPOCH,
    updatedAt: EPOCH,
  });
  if (!check.success) {
    throw new JoineryError({
      code: 'VALIDATION_FAILED',
      message: 'The connection URI does not describe a usable connection',
      detail: z.prettifyError(check.error),
    });
  }
  const result: ParsedConnectionUri = { profile: draft, ignoredParams };
  defineHiddenSecret(result, 'password', built.password);
  return result;
}

const EPOCH = '1970-01-01T00:00:00.000Z';

type Draft = ConnectionProfileDraft;
type EndpointDraft = Draft['endpoint'];
type AuthDraft = NonNullable<Draft['auth']>;
type TlsDraft = NonNullable<Draft['tls']>;
type OptionsDraft = NonNullable<Draft['options']>;

interface BuiltProfile {
  readonly name: string;
  readonly endpoint: EndpointDraft;
  /** Use a `uri` endpoint: the structured fields cannot express everything in the URI. */
  readonly keepsUri: boolean;
  readonly auth: AuthDraft | undefined;
  readonly tls: TlsDraft | undefined;
  readonly options: OptionsDraft;
  readonly password: string | undefined;
}

// ---------------------------------------------------------------------------------------------
// Splitting

interface HostSpec {
  /** Decoded host name, IP (IPv6 without brackets) or socket path; '' when omitted. */
  readonly host: string;
  readonly port: number | undefined;
  readonly ipv6: boolean;
}

interface UriParts {
  /** Lower case, without a `jdbc:` prefix. */
  readonly scheme: string;
  readonly user: string | undefined;
  readonly password: string | undefined;
  readonly hosts: readonly HostSpec[];
  /** The host list exactly as written, for rebuilding the URI. */
  readonly rawHosts: string;
  /** Decoded path without the leading slash. */
  readonly path: string;
  /** The path exactly as written, with its leading slash; '' when absent. */
  readonly rawPath: string;
  readonly params: readonly (readonly [string, string])[];
}

function invalid(reason: string): JoineryError {
  return new JoineryError({
    code: 'VALIDATION_FAILED',
    message: `Invalid connection URI: ${reason}`,
  });
}

function decode(text: string, what: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    throw invalid(`the ${what} has invalid percent-encoding`);
  }
}

function splitUri(input: string): UriParts {
  let text = input.trim();
  if (/^jdbc:/i.test(text)) text = text.slice('jdbc:'.length);
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(text);
  if (!scheme?.[1]) throw invalid('it must start with a scheme such as postgres://');
  let rest = text.slice(scheme[0].length);
  const hash = rest.indexOf('#');
  if (hash >= 0) rest = rest.slice(0, hash);
  let query = '';
  const question = rest.indexOf('?');
  if (question >= 0) {
    query = rest.slice(question + 1);
    rest = rest.slice(0, question);
  }
  const authorityEnd = findAuthorityEnd(rest);
  const authority = rest.slice(0, authorityEnd);
  const rawPath = rest.slice(authorityEnd);
  const at = authority.lastIndexOf('@');
  const userinfo = at >= 0 ? authority.slice(0, at) : undefined;
  const rawHosts = at >= 0 ? authority.slice(at + 1) : authority;

  let user: string | undefined;
  let password: string | undefined;
  if (userinfo !== undefined) {
    const colon = userinfo.indexOf(':');
    user = decode(colon >= 0 ? userinfo.slice(0, colon) : userinfo, 'user name');
    password = colon >= 0 ? decode(userinfo.slice(colon + 1), 'password') : undefined;
  }
  return {
    scheme: scheme[1].toLowerCase(),
    user: user === '' ? undefined : user,
    password: password === '' ? undefined : password,
    hosts: rawHosts === '' ? [] : rawHosts.split(',').map(parseHost),
    rawHosts,
    path: rawPath.length > 1 ? decode(rawPath.slice(1), 'path') : '',
    rawPath,
    params: parseQuery(query),
  };
}

/** The authority ends at the first '/' outside parentheses (MySQL writes sockets as `(/path)`). */
function findAuthorityEnd(rest: string): number {
  let depth = 0;
  for (let index = 0; index < rest.length; index++) {
    const ch = rest[index];
    if (ch === '(') depth++;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    else if (ch === '/' && depth === 0) return index;
  }
  return rest.length;
}

function parseHost(raw: string): HostSpec {
  if (raw.startsWith('[')) {
    const close = raw.indexOf(']');
    if (close < 0) throw invalid('an IPv6 address is missing its closing bracket');
    const after = raw.slice(close + 1);
    if (after !== '' && !after.startsWith(':')) throw invalid('a host is malformed');
    return {
      host: decode(raw.slice(1, close), 'host'),
      port: parsePort(after.slice(1)),
      ipv6: true,
    };
  }
  if (raw.startsWith('(') && raw.endsWith(')')) {
    return { host: decode(raw.slice(1, -1), 'host'), port: undefined, ipv6: false };
  }
  const colons = raw.split(':').length - 1;
  if (colons > 1) return { host: decode(raw, 'host'), port: undefined, ipv6: true };
  const colon = raw.indexOf(':');
  if (colon < 0) return { host: decode(raw, 'host'), port: undefined, ipv6: false };
  return {
    host: decode(raw.slice(0, colon), 'host'),
    port: parsePort(raw.slice(colon + 1)),
    ipv6: false,
  };
}

function parsePort(text: string): number | undefined {
  if (text === '') return undefined;
  const port = /^\d{1,5}$/.test(text) ? Number(text) : NaN;
  if (!(port >= 1 && port <= 65535)) throw invalid('a port is not a number from 1 to 65535');
  return port;
}

function parseQuery(query: string): [string, string][] {
  const params: [string, string][] = [];
  for (const piece of query.split('&')) {
    if (piece === '') continue;
    const equals = piece.indexOf('=');
    const key = decode(equals >= 0 ? piece.slice(0, equals) : piece, 'query string');
    const value = equals >= 0 ? decode(piece.slice(equals + 1), 'query string') : '';
    params.push([key, value]);
  }
  return params;
}

/** Parameter names whose values are secrets: never kept in a stored URI. */
const SECRET_PARAMS = new Set([
  'password',
  'pass',
  'pwd',
  'sslpassword',
  'tlscertificatekeyfilepassword',
  'sslpemkeypassword',
  'apikey',
  'api_key',
  'token',
  'access_token',
  'auth_token',
  'secret',
  'proxypassword',
]);

function isSecretParam(name: string): boolean {
  return SECRET_PARAMS.has(name.toLowerCase());
}

/** Query parameters, matched case-insensitively, remembering which ones were used. */
class Params {
  #entries: readonly (readonly [string, string])[];
  readonly #used = new Set<number>();
  /** Secrets taken out of a parameter's value (see `removeSecret`), reported as ignored. */
  readonly #removed = new Set<string>();
  /** Entries left empty by `removeSecret`, dropped from a rebuilt URI. */
  readonly #dropped = new Set<number>();

  constructor(entries: readonly (readonly [string, string])[]) {
    this.#entries = entries;
  }

  /**
   * Takes a secret out of the value of parameter `name` (e.g. AWS_SESSION_TOKEN inside
   * authMechanismProperties): `clean` returns the value without it, '' when nothing is left
   * (the parameter is then dropped), or undefined when the value holds no secret. The secret is
   * reported as `reported` among the ignored parameters.
   */
  removeSecret(name: string, reported: string, clean: (value: string) => string | undefined): void {
    const wanted = name.toLowerCase();
    let removed = false;
    this.#entries = this.#entries.flatMap(([entry, value], index) => {
      if (entry.toLowerCase() !== wanted) return [[entry, value] as const];
      const cleaned = clean(value);
      if (cleaned === undefined) return [[entry, value] as const];
      removed = true;
      if (cleaned === '') {
        this.#used.add(index);
        this.#dropped.add(index);
      }
      return [[entry, cleaned] as const];
    });
    if (removed) this.#removed.add(reported);
  }

  /** The last value of any of `names`, marking them used. */
  take(...names: string[]): string | undefined {
    return this.#find(names, true);
  }

  /** Like `take`, without marking. */
  peek(...names: string[]): string | undefined {
    return this.#find(names, false);
  }

  /** Non-secret parameters nothing used. */
  unusedNames(): string[] {
    return this.#unused().filter((name) => !isSecretParam(name));
  }

  unusedSecretNames(): string[] {
    return [...this.#unused().filter(isSecretParam), ...this.#removed];
  }

  /** Every non-secret parameter, for rebuilding a URI. */
  publicEntries(): (readonly [string, string])[] {
    return this.#entries.filter(
      ([name], index) => !isSecretParam(name) && !this.#dropped.has(index),
    );
  }

  #find(names: string[], mark: boolean): string | undefined {
    const wanted = new Set(names.map((name) => name.toLowerCase()));
    let value: string | undefined;
    this.#entries.forEach(([name, entryValue], index) => {
      if (!wanted.has(name.toLowerCase())) return;
      if (mark) this.#used.add(index);
      value = entryValue;
    });
    return value;
  }

  #unused(): string[] {
    return [
      ...new Set(this.#entries.filter((_, index) => !this.#used.has(index)).map(([name]) => name)),
    ];
  }
}

/** The URI with the password and secret parameters removed, for a `uri` endpoint. */
function sanitizedUri(parts: UriParts, params: Params): string {
  const userinfo = parts.user === undefined ? '' : `${encodeURIComponent(parts.user)}@`;
  const query = params
    .publicEntries()
    .map(([name, value]) => `${encodeURIComponent(name)}=${encodeURIComponent(value)}`)
    .join('&');
  return `${parts.scheme}://${userinfo}${parts.rawHosts}${parts.rawPath}${query ? `?${query}` : ''}`;
}

// ---------------------------------------------------------------------------------------------
// Engines

const SCHEME_ENGINES: Readonly<Record<string, readonly EngineId[]>> = {
  postgres: ['postgres'],
  postgresql: ['postgres'],
  mysql: ['mysql', 'mariadb'],
  mariadb: ['mariadb'],
  mongodb: ['mongodb'],
  'mongodb+srv': ['mongodb'],
  redis: ['redis'],
  rediss: ['redis'],
  'redis+sentinel': ['redis'],
  'rediss+sentinel': ['redis'],
  unix: ['redis'],
  'redis+unix': ['redis'],
  'redis+socket': ['redis'],
  http: ['elasticsearch', 'opensearch'],
  https: ['elasticsearch', 'opensearch'],
};

function engineFor(scheme: string, requested: EngineId | undefined): EngineId {
  const engines = SCHEME_ENGINES[scheme];
  if (!engines) throw invalid(`the scheme "${scheme}" is not supported`);
  if (requested !== undefined) {
    if (!engines.includes(requested)) {
      throw invalid(
        `a ${scheme}:// URI cannot describe a ${ENGINES[requested].displayName} server`,
      );
    }
    return requested;
  }
  if (engines.length > 1 && (scheme === 'http' || scheme === 'https')) {
    throw invalid('say whether the URL points to Elasticsearch or OpenSearch');
  }
  const [first] = engines;
  if (!first) throw invalid(`the scheme "${scheme}" is not supported`);
  return first;
}

function buildDraft(engine: EngineId, parts: UriParts, params: Params): BuiltProfile {
  switch (engine) {
    case 'postgres':
      return buildPostgres(parts, params);
    case 'mysql':
    case 'mariadb':
      return buildMysql(engine, parts, params);
    case 'mongodb':
      return buildMongo(parts, params);
    case 'redis':
      return buildRedis(parts, params);
    case 'elasticsearch':
    case 'opensearch':
      return buildSearch(engine, parts);
  }
}

function buildPostgres(parts: UriParts, params: Params): BuiltProfile {
  let hosts = parts.hosts;
  const hostParam = params.take('host');
  if (hostParam !== undefined) {
    hosts = hostParam
      .split(',')
      .map((host) => ({ host, port: undefined, ipv6: host.includes(':') }));
  }
  const portParam = params.take('port');
  if (portParam !== undefined) {
    const ports = portParam.split(',').map(parsePort);
    const base: readonly HostSpec[] =
      hosts.length > 0 ? hosts : [{ host: '', port: undefined, ipv6: false }];
    hosts = base.map((host, index) => ({
      ...host,
      port: ports.length === 1 ? ports[0] : ports[index],
    }));
  }
  const database = params.take('dbname') ?? nonEmpty(parts.path);
  const user = parts.user ?? params.take('user');
  const password = parts.password ?? nonEmpty(params.take('password'));

  const sslmode = params.take('sslmode');
  const ssl = params.take('ssl');
  const tls = tlsDraft(
    sslmode !== undefined ? tlsModeFrom(sslmode) : ssl !== undefined ? jdbcSsl(ssl) : undefined,
    params.take('sslrootcert'),
    params.take('sslcert'),
    params.take('sslkey'),
  );

  const options: OptionsDraft = {};
  const timeout = params.take('connect_timeout', 'connectTimeout', 'loginTimeout');
  if (timeout !== undefined) setSeconds(options, 'connectTimeoutMs', timeout);
  const applicationName = params.take('application_name', 'ApplicationName');
  if (applicationName) options.applicationName = applicationName;
  const encoding = params.take('client_encoding');
  if (encoding) options.charset = encoding;
  const keepalives = params.take('keepalives');
  if (keepalives !== undefined) options.keepAlive = parseBoolean(keepalives, 'keepalives');
  if (database) options.defaultDatabase = database;

  const [first] = hosts;
  const host = first?.host ?? '';
  const port = first?.port;
  const socket = host.startsWith('/') || host.startsWith('@');
  // libpq takes the socket directory; a non-default port names the socket file inside it.
  const socketPath =
    port === undefined || port === ENGINES.postgres.defaultPort
      ? host
      : `${host.replace(/\/+$/, '')}/.s.PGSQL.${port}`;
  return {
    name: profileName(socket ? 'localhost' : host || 'localhost', port, 'postgres', database),
    endpoint: socket
      ? { kind: 'socket', path: socketPath }
      : { kind: 'host', host: host || 'localhost', port: port ?? ENGINES.postgres.defaultPort },
    keepsUri: hosts.length > 1 || params.unusedNames().length > 0,
    auth: passwordAuth(user, password),
    tls,
    options,
    password,
  };
}

function buildMysql(engine: 'mysql' | 'mariadb', parts: UriParts, params: Params): BuiltProfile {
  const database = nonEmpty(parts.path) ?? params.take('database', 'dbname');
  const user = parts.user ?? params.take('user');
  const password = parts.password ?? nonEmpty(params.take('password'));
  const socketParam = params.take('socket', 'socketPath', 'unix_socket');

  const sslMode = params.take('ssl-mode', 'sslmode', 'ssl_mode');
  const ssl = params.take('ssl');
  const useSsl = params.take('useSSL');
  const sslAccept = params.take('sslaccept');
  const mode =
    sslMode !== undefined
      ? tlsModeFrom(sslMode)
      : ssl !== undefined
        ? mysqlSsl(ssl)
        : sslAccept !== undefined
          ? prismaSslAccept(sslAccept)
          : useSsl !== undefined
            ? parseBoolean(useSsl, 'useSSL')
              ? 'require'
              : 'disable'
            : undefined;
  const tls = tlsDraft(
    mode,
    params.take('ssl-ca', 'sslca', 'ssl_ca', 'sslrootcert'),
    params.take('ssl-cert', 'sslcert', 'ssl_cert'),
    params.take('ssl-key', 'sslkey', 'ssl_key'),
  );

  const options: OptionsDraft = {};
  const charset = params.take('charset');
  if (charset) options.charset = charset;
  const timeZone = params.take('timezone', 'time_zone', 'serverTimezone');
  if (timeZone) options.timeZone = timeZone;
  const timeoutMs = params.take('connectTimeout');
  if (timeoutMs !== undefined) setMilliseconds(options, 'connectTimeoutMs', timeoutMs);
  const timeoutSeconds = params.take('connect_timeout', 'connect-timeout');
  if (timeoutSeconds !== undefined) setSeconds(options, 'connectTimeoutMs', timeoutSeconds);
  if (database) options.defaultDatabase = database;

  const [first] = parts.hosts;
  const socketPath = socketParam ?? (first?.host.startsWith('/') ? first.host : undefined);
  const host = first?.host || 'localhost';
  const port = first?.port;
  return {
    name: profileName(socketPath ? 'localhost' : host, port, engine, database),
    endpoint: socketPath
      ? { kind: 'socket', path: socketPath }
      : { kind: 'host', host, port: port ?? ENGINES[engine].defaultPort },
    keepsUri: parts.hosts.length > 1 || params.unusedNames().length > 0,
    auth: passwordAuth(user, password),
    tls,
    options,
    password,
  };
}

/** Mechanisms whose credentials live in the `$external` database. */
const EXTERNAL_MECHANISMS = new Set([
  'MONGODB-X509',
  'PLAIN',
  'GSSAPI',
  'MONGODB-AWS',
  'MONGODB-OIDC',
]);
/** Mechanisms the profile's auth can express. */
const MAPPED_MECHANISMS = new Set([
  'SCRAM-SHA-1',
  'SCRAM-SHA-256',
  'PLAIN',
  'MONGODB-X509',
  'MONGODB-AWS',
]);
/** Read preference modes a profile holds, in the driver's spelling. */
const READ_PREFERENCES = connectionOptionsSchema.shape.readPreference.unwrap().options;
/**
 * The region an AWS IAM profile made from a URI records. MONGODB-AWS takes its credentials and
 * STS endpoint from the AWS SDK's chain, not from the profile, so this only fills the field.
 */
const AWS_DEFAULT_REGION = 'us-east-1';

function buildMongo(parts: UriParts, params: Params): BuiltProfile {
  const srv = parts.scheme === 'mongodb+srv';
  const database = nonEmpty(parts.path);
  const user = parts.user;
  const password = parts.password;
  const replicaSet = params.take('replicaSet');

  const tlsFlag = params.take('tls', 'ssl');
  const insecure = optionalBoolean(params.take('tlsInsecure'), 'tlsInsecure');
  const invalidCerts = optionalBoolean(
    params.take('tlsAllowInvalidCertificates', 'sslAllowInvalidCertificates'),
    'tlsAllowInvalidCertificates',
  );
  const invalidHosts = optionalBoolean(
    params.take('tlsAllowInvalidHostnames', 'sslAllowInvalidHostnames'),
    'tlsAllowInvalidHostnames',
  );
  let mode: TlsMode | undefined;
  if (tlsFlag !== undefined && !parseBoolean(tlsFlag, 'tls')) mode = 'disable';
  else if (insecure || invalidCerts) mode = 'require';
  else if (invalidHosts) mode = 'verify-ca';
  else if (tlsFlag !== undefined) mode = 'verify-full';
  const certificateKey = params.take('tlsCertificateKeyFile', 'sslPEMKeyFile');
  const tls = tlsDraft(mode, params.take('tlsCAFile', 'sslCA'), certificateKey, certificateKey);

  const mechanism = params.peek('authMechanism')?.toUpperCase();
  if (mechanism === undefined || MAPPED_MECHANISMS.has(mechanism)) params.take('authMechanism');
  const external = mechanism !== undefined && EXTERNAL_MECHANISMS.has(mechanism);
  // Where the URI authenticates: its authSource, else (for a login with a user name) the
  // database it names, as MongoDB connection strings define it. An SRV record's TXT entry may
  // name one, so a mongodb+srv:// URI without authSource leaves it to the record.
  const statedAuthSource = params.take('authSource');
  const authSource =
    statedAuthSource ?? (external || srv || user === undefined ? undefined : database);
  // A TXT record's (or the driver's) AWS session token lives inside another option's value.
  params.removeSecret('authMechanismProperties', 'AWS_SESSION_TOKEN', (value) => {
    const properties = value.split(',');
    const kept = properties.filter((property) => !/^\s*AWS_SESSION_TOKEN\s*:/i.test(property));
    return kept.length === properties.length ? undefined : kept.join(',');
  });

  // Options the profile holds in its own fields; a URI kept whole carries them itself.
  const lifted: Pick<OptionsDraft, 'authSource' | 'readPreference' | 'directConnection'> = {};
  // The profile's default is $external for certificate, LDAP and AWS logins, admin otherwise;
  // stating it where the URI names no database (or for an external login) changes nothing.
  const profileAuthSource = external ? '$external' : 'admin';
  if (authSource && !(authSource === profileAuthSource && (external || database === undefined))) {
    lifted.authSource = authSource;
  }
  const readPreference = params.peek('readPreference')?.toLowerCase();
  const preference = READ_PREFERENCES.find((mode) => mode.toLowerCase() === readPreference);
  if (preference) {
    params.take('readPreference');
    lifted.readPreference = preference;
  }

  const options: OptionsDraft = {};
  const appName = params.take('appName');
  if (appName) options.applicationName = appName;
  const connectTimeout = params.take('connectTimeoutMS');
  if (connectTimeout !== undefined) setMilliseconds(options, 'connectTimeoutMs', connectTimeout);
  const idleTimeout = params.take('maxIdleTimeMS');
  if (idleTimeout !== undefined) setMilliseconds(options, 'idleTimeoutMs', idleTimeout);
  if (database) options.defaultDatabase = database;
  // Current drivers' defaults: stating them changes nothing.
  if (params.peek('retryWrites')?.toLowerCase() === 'true') params.take('retryWrites');
  if (params.peek('retryReads')?.toLowerCase() === 'true') params.take('retryReads');
  if (params.peek('w')?.toLowerCase() === 'majority') params.take('w');

  const auth: AuthDraft | undefined =
    mechanism === 'MONGODB-X509'
      ? { method: 'clientCertificate', ...(user ? { user } : {}) }
      : mechanism === 'MONGODB-AWS'
        ? { method: 'awsIam', region: AWS_DEFAULT_REGION, ...(user ? { user } : {}) }
        : passwordAuth(user, password, mechanism);

  const hosts = parts.hosts;
  const [first] = hosts;
  if (!first || first.host === '') throw invalid('a MongoDB URI needs at least one host');
  let endpoint: EndpointDraft;
  if (srv) {
    if (hosts.length !== 1 || first.port !== undefined) {
      throw invalid('a mongodb+srv:// URI takes exactly one host name and no port');
    }
    endpoint = { kind: 'srv', host: first.host };
  } else if (hosts.length === 1 && replicaSet === undefined) {
    endpoint = { kind: 'host', host: first.host, port: first.port ?? ENGINES.mongodb.defaultPort };
    // Only a single host can be connected to directly; elsewhere the option stays in the URI.
    const direct = params.peek('directConnection')?.toLowerCase();
    if (direct === 'true' || direct === 'false') {
      params.take('directConnection');
      lifted.directConnection = direct === 'true';
    }
  } else {
    endpoint = {
      kind: 'hosts',
      hosts: hosts.map((host) => ({
        host: host.host,
        port: host.port ?? ENGINES.mongodb.defaultPort,
      })),
      ...(replicaSet ? { replicaSet } : {}),
    };
  }
  const keepsUri =
    params.unusedNames().length > 0 ||
    hosts.some((host) => host.host.startsWith('/') || host.host.endsWith('.sock'));
  return {
    name: profileName(first.host, first.port, 'mongodb', database),
    endpoint,
    keepsUri,
    auth,
    tls,
    options: keepsUri ? options : { ...lifted, ...options },
    // X.509 authenticates with the certificate and MONGODB-AWS with the AWS SDK's credentials
    // (a URI's password is then an AWS secret key, which a profile never keeps).
    password: auth?.method === 'password' ? password : undefined,
  };
}

function buildRedis(parts: UriParts, params: Params): BuiltProfile {
  const scheme = parts.scheme;
  const sentinel = scheme.endsWith('+sentinel');
  const socket = scheme === 'unix' || scheme === 'redis+unix' || scheme === 'redis+socket';
  const secure = scheme.startsWith('rediss');
  const user = parts.user ?? params.take('username', 'user');
  const password = parts.password ?? nonEmpty(params.take('password'));

  let database: string | undefined;
  let masterName: string | undefined;
  if (sentinel) {
    const [master, db, ...extra] = parts.path.split('/');
    if (!master || extra.length > 0)
      throw invalid('a Sentinel URI needs the master name as its path');
    masterName = master;
    database = nonEmpty(db);
  } else if (!socket) {
    database = nonEmpty(parts.path);
  }
  database = params.take('db') ?? database;
  if (database !== undefined && !/^\d+$/.test(database)) {
    throw invalid('the Redis database must be a number');
  }

  const certReqs = params.take('ssl_cert_reqs')?.toLowerCase();
  const mode: TlsMode | undefined =
    certReqs === 'none' || certReqs === 'optional'
      ? 'require'
      : certReqs === 'required'
        ? 'verify-full'
        : secure
          ? 'verify-full'
          : 'disable';
  const tls = tlsDraft(
    mode,
    params.take('ssl_ca_certs'),
    params.take('ssl_certfile'),
    params.take('ssl_keyfile'),
  );
  const options: OptionsDraft = database !== undefined ? { defaultDatabase: database } : {};

  const [first] = parts.hosts;
  let endpoint: EndpointDraft;
  let name: string;
  if (socket) {
    if (parts.rawPath === '') throw invalid('a Unix socket URI needs the socket path');
    endpoint = { kind: 'socket', path: `/${parts.path}` };
    name = profileName('localhost', undefined, 'redis', database);
  } else if (sentinel) {
    endpoint = {
      kind: 'sentinel',
      sentinels: parts.hosts.map((host) => ({
        host: host.host || 'localhost',
        port: host.port ?? 26379,
      })),
      masterName: masterName ?? '',
    };
    name = masterName ?? 'sentinel';
  } else {
    const host = first?.host || 'localhost';
    endpoint = { kind: 'host', host, port: first?.port ?? ENGINES.redis.defaultPort };
    name = profileName(host, first?.port, 'redis', database);
  }
  return {
    name,
    endpoint,
    // Only plain redis:// and rediss:// URIs are kept whole; the other forms are not URIs
    // every Redis client understands.
    keepsUri:
      (scheme === 'redis' || scheme === 'rediss') &&
      (parts.hosts.length > 1 || params.unusedNames().length > 0),
    auth: passwordAuth(user, password),
    tls,
    options,
    password,
  };
}

/** Search engines have no URI endpoint, so every query parameter is reported as ignored. */
function buildSearch(engine: 'elasticsearch' | 'opensearch', parts: UriParts): BuiltProfile {
  if (parts.hosts.length === 0 || parts.hosts.some((host) => host.host === '')) {
    throw invalid('the URL needs a host');
  }
  const path = parts.rawPath === '/' ? '' : parts.rawPath;
  const urls = parts.hosts.map((host) => {
    const name = host.ipv6 ? `[${host.host}]` : host.host;
    return `${parts.scheme}://${name}${host.port === undefined ? '' : `:${host.port}`}${path}`;
  });
  const [first] = parts.hosts;
  return {
    name: first ? profileName(first.host, first.port, engine, undefined) : engine,
    endpoint: { kind: 'urls', urls },
    keepsUri: false,
    auth: passwordAuth(parts.user, parts.password),
    tls: { mode: parts.scheme === 'https' ? 'verify-full' : 'disable' },
    options: {},
    password: parts.password,
  };
}

// ---------------------------------------------------------------------------------------------
// Helpers

function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value === '' ? undefined : value;
}

function profileName(
  host: string,
  port: number | undefined,
  engine: EngineId,
  database: string | undefined,
): string {
  const portPart = port !== undefined && port !== ENGINES[engine].defaultPort ? `:${port}` : '';
  return `${host}${portPart}${database ? `/${database}` : ''}`;
}

function passwordAuth(
  user: string | undefined,
  password: string | undefined,
  mechanism?: string,
): AuthDraft | undefined {
  if (user === undefined && password === undefined && mechanism === undefined) return undefined;
  return {
    method: 'password',
    ...(user !== undefined ? { user } : {}),
    ...(password !== undefined ? { password: { id: newId(), policy: 'save' } } : {}),
    ...(mechanism !== undefined ? { mechanism } : {}),
  };
}

function tlsDraft(
  mode: TlsMode | undefined,
  caPath: string | undefined,
  certPath: string | undefined,
  keyPath: string | undefined,
): TlsDraft | undefined {
  const tls: TlsDraft = {
    ...(mode ? { mode } : {}),
    ...(caPath ? { caPath } : {}),
    ...(certPath ? { certPath } : {}),
    ...(keyPath ? { keyPath } : {}),
  };
  return Object.keys(tls).length > 0 ? tls : undefined;
}

/**
 * libpq sslmode and MySQL ssl-mode values. "prefer" (TLS if the server offers it) maps to
 * require, and "allow" (plaintext first) to disable: the nearest modes that do not silently
 * change which of the two the connection uses.
 */
const TLS_MODES: Readonly<Record<string, TlsMode>> = {
  disable: 'disable',
  disabled: 'disable',
  allow: 'disable',
  prefer: 'require',
  preferred: 'require',
  require: 'require',
  required: 'require',
  'verify-ca': 'verify-ca',
  'verify-full': 'verify-full',
  'verify-identity': 'verify-full',
};

function tlsModeFrom(value: string): TlsMode {
  const mode = TLS_MODES[value.toLowerCase().replaceAll('_', '-')];
  if (!mode) throw invalid('the SSL mode is not recognised');
  return mode;
}

/** pgJDBC `ssl=true` verifies the full certificate chain and host name. */
function jdbcSsl(value: string): TlsMode {
  return parseBoolean(value, 'ssl') ? 'verify-full' : 'disable';
}

/** mysql2 takes `ssl` as a boolean or a JSON object such as {"rejectUnauthorized":true}. */
function mysqlSsl(value: string): TlsMode {
  const trimmed = value.trim();
  if (!trimmed.startsWith('{')) return parseBoolean(trimmed, 'ssl') ? 'verify-full' : 'disable';
  let options: unknown;
  try {
    options = JSON.parse(trimmed);
  } catch {
    throw invalid('the ssl parameter is not valid JSON');
  }
  const rejectUnauthorized =
    typeof options === 'object' && options !== null && 'rejectUnauthorized' in options
      ? options.rejectUnauthorized
      : true;
  return rejectUnauthorized === false ? 'require' : 'verify-full';
}

/** Prisma's MySQL `sslaccept`. */
function prismaSslAccept(value: string): TlsMode {
  if (value === 'strict') return 'verify-full';
  if (value === 'accept_invalid_certs') return 'require';
  throw invalid('the sslaccept parameter is not recognised');
}

function parseBoolean(value: string, name: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
  if (['false', '0', 'no', 'off'].includes(normalized)) return false;
  throw invalid(`the ${name} parameter must be true or false`);
}

function optionalBoolean(value: string | undefined, name: string): boolean | undefined {
  return value === undefined ? undefined : parseBoolean(value, name);
}

function setSeconds(options: OptionsDraft, key: 'connectTimeoutMs', value: string): void {
  const seconds = Number(value);
  if (!/^\d+$/.test(value)) throw invalid('a timeout is not a whole number');
  // libpq: 0 means wait forever, which the profile expresses by the default.
  if (seconds > 0) options[key] = seconds * 1000;
}

function setMilliseconds(
  options: OptionsDraft,
  key: 'connectTimeoutMs' | 'idleTimeoutMs',
  value: string,
): void {
  if (!/^\d+$/.test(value)) throw invalid('a timeout is not a whole number');
  const ms = Number(value);
  if (ms > 0) options[key] = ms;
}
