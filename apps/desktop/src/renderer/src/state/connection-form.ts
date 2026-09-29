import {
  ENDPOINT_KINDS,
  ENGINES,
  environmentSchema,
  isSqlEngine,
  newId,
  tlsModeSchema,
  type Auth,
  type ConnectionOptions,
  type ConnectionProfile,
  type ConnectionProfileInput,
  type EngineId,
  type HostPort,
  type ProxyOptions,
  type SecretPolicy,
  type SecretRef,
  type SshAuth,
  type SshTunnel,
} from '@joinery/core';
import { uriCarriesSecret, type ParsedConnectionUriResult } from '@joinery/ipc';
import { z } from 'zod';

import { READ_PREFERENCES, passwordFromUri, uriHosts, uriScheme } from './connection-uri';

export { passwordFromUri, READ_PREFERENCES, type ReadPreference } from './connection-uri';

/**
 * The connection dialog's form model (spec §4) and its mapping to and from a profile. The form is
 * flat strings, booleans and host rows, which is what inputs produce; `formToProfile` builds the
 * profile the main contract validates again. Fields the dialog does not show (tags, other
 * options) are carried over from the edited profile unchanged.
 *
 * Every secret (the password, SSH passwords and key passphrases, the proxy password) is typed
 * into the form and leaves it as a `SecretField`: a reference with its policy plus the typed
 * value, which the dialog hands to main and never gets back.
 */

/** Engines the dialog can configure today; the others are listed as coming soon. */
export const DIALOG_ENGINES = [
  'postgres',
  'mysql',
  'mariadb',
  'mongodb',
  'redis',
  'elasticsearch',
  'opensearch',
] as const;
export type DialogEngine = (typeof DIALOG_ENGINES)[number];
export const COMING_SOON_ENGINES: readonly EngineId[] = [];

/** Elasticsearch and OpenSearch: node URLs or a Cloud ID, and HTTP sign-ins (spec §4, §11). */
export const SEARCH_DIALOG_ENGINES = ['elasticsearch', 'opensearch'] as const;
export type SearchDialogEngine = (typeof SEARCH_DIALOG_ENGINES)[number];

export function isSearchDialogEngine(engine: EngineId): engine is SearchDialogEngine {
  return engine === 'elasticsearch' || engine === 'opensearch';
}

/** Every endpoint form the dialog's engines accept (core's `ENDPOINT_KINDS` says which). */
export const FORM_ENDPOINT_KINDS = [
  'host',
  'socket',
  'uri',
  'hosts',
  'srv',
  'sentinel',
  'cluster',
  'urls',
  'cloudId',
] as const;
export type FormEndpointKind = (typeof FORM_ENDPOINT_KINDS)[number];

/** The endpoint forms an engine accepts, in the order the dialog lists them. */
export function endpointKindsFor(engine: DialogEngine): readonly FormEndpointKind[] {
  return FORM_ENDPOINT_KINDS_BY_ENGINE[engine];
}

const FORM_ENDPOINT_KINDS_BY_ENGINE: Readonly<Record<DialogEngine, readonly FormEndpointKind[]>> = {
  postgres: ENDPOINT_KINDS.postgres.filter(isFormEndpointKind),
  mysql: ENDPOINT_KINDS.mysql.filter(isFormEndpointKind),
  mariadb: ENDPOINT_KINDS.mariadb.filter(isFormEndpointKind),
  mongodb: ENDPOINT_KINDS.mongodb.filter(isFormEndpointKind),
  redis: ENDPOINT_KINDS.redis.filter(isFormEndpointKind),
  elasticsearch: ENDPOINT_KINDS.elasticsearch.filter(isFormEndpointKind),
  opensearch: ENDPOINT_KINDS.opensearch.filter(isFormEndpointKind),
};

function isFormEndpointKind(kind: string): kind is FormEndpointKind {
  return (FORM_ENDPOINT_KINDS as readonly string[]).includes(kind);
}

export const AUTH_METHODS = ['none', 'password', 'clientCertificate', 'apiKey', 'bearer'] as const;
export type FormAuthMethod = (typeof AUTH_METHODS)[number];

/**
 * How each engine's users sign in, as the dialog offers it (spec §4). SQL engines always take a
 * user and an optional password; the method is not shown for them.
 */
export const ENGINE_AUTH_METHODS: Readonly<Record<DialogEngine, readonly FormAuthMethod[]>> = {
  postgres: ['password'],
  mysql: ['password'],
  mariadb: ['password'],
  mongodb: ['none', 'password', 'clientCertificate'],
  redis: ['none', 'password'],
  // OpenSearch has no API keys; its security plugin takes basic auth and JWT bearer tokens.
  elasticsearch: ['none', 'password', 'apiKey', 'bearer'],
  opensearch: ['none', 'password', 'bearer'],
};

/**
 * MongoDB SASL mechanisms for a user and password. PLAIN is LDAP, whose users live in the
 * `$external` database; '' lets the driver negotiate with the server (SCRAM-SHA-256 when the
 * user has such credentials, else SCRAM-SHA-1), which is what a URI without authMechanism means.
 */
export const MONGO_MECHANISMS = ['SCRAM-SHA-256', 'SCRAM-SHA-1', 'PLAIN', ''] as const;

/** The database that holds LDAP and X.509 users in MongoDB. */
export const EXTERNAL_AUTH_SOURCE = '$external';

/** Redis Sentinel's default port. */
export const SENTINEL_PORT = 26379;

export const PASSWORD_MODES = ['save', 'session', 'ask', 'none'] as const;
export type PasswordMode = (typeof PASSWORD_MODES)[number];

/** Storage policies for a secret the profile cannot do without (an SSH password). */
export const SECRET_MODES = ['save', 'session', 'ask'] as const;

export const SSH_AUTH_METHODS = ['password', 'privateKey', 'agent'] as const;
export type SshAuthMethod = (typeof SSH_AUTH_METHODS)[number];

export const PROXY_KINDS = ['none', 'socks5', 'http'] as const;

/** At most this many hops: jump hosts plus the SSH server that forwards to the database. */
export const MAX_SSH_HOPS = 8;

/** At most this many rows in a host list, Sentinel list or cluster seed list. */
export const MAX_HOST_ROWS = 50;

const portText = z
  .string()
  .trim()
  .refine((value) => /^\d{1,5}$/.test(value) && Number(value) >= 1 && Number(value) <= 65535, {
    message: 'Port must be a number from 1 to 65535',
  });

function isPort(value: string): boolean {
  return portText.safeParse(value).success;
}

/** A Redis logical database: a non-negative integer (0 to 15 on a default server). */
function isRedisDatabase(value: string): boolean {
  return /^\d{1,10}$/.test(value) && Number(value) <= 2_147_483_647;
}

/** MongoDB database names: under 64 characters, none of / \ . " $ space or NUL. */
function isMongoDatabaseName(value: string): boolean {
  return value.length < 64 && !/[/\\. "$\0]/.test(value);
}

const MONGO_NAME_MESSAGE =
  'A MongoDB database name has fewer than 64 characters and no spaces or / \\ . " $';

/** One Elasticsearch / OpenSearch node URL, as the dialog edits it (an object for the row list). */
export const urlRowSchema = z.object({ url: z.string().trim().max(2048) });
export type UrlRowValues = z.infer<typeof urlRowSchema>;

/** One host of a MongoDB host list, a Redis cluster seed or a Sentinel, as the dialog edits it. */
export const hostRowSchema = z.object({
  host: z.string().trim().max(255),
  port: z.string().trim(),
});
export type HostRowValues = z.infer<typeof hostRowSchema>;

/** One SSH hop as the dialog edits it; the last one forwards to the database. */
export const sshHopFormSchema = z.object({
  host: z.string().trim().max(255),
  port: z.string().trim(),
  user: z.string().trim().max(255),
  authMethod: z.enum(SSH_AUTH_METHODS),
  /** Typed SSH password; empty while editing keeps the stored one. */
  password: z.string().max(65_536),
  passwordMode: z.enum(SECRET_MODES),
  keyPath: z.string().trim().max(4096),
  /** Typed key passphrase; empty while editing keeps the stored one. */
  passphrase: z.string().max(65_536),
  /** `none` for a key without a passphrase. */
  passphraseMode: z.enum(PASSWORD_MODES),
});
export type SshHopFormValues = z.infer<typeof sshHopFormSchema>;

/**
 * How a MongoDB or Redis topology goes through an SSH tunnel or a proxy, for the dialog to
 * explain next to those sections (ADR 0008): every server the others announce is reached
 * through the tunnel by that name, resolved on the far side; only SRV records are looked up on
 * this computer.
 */
export function tunnelLimitation(engine: DialogEngine): string | undefined {
  if (engine === 'mongodb') {
    return 'Through an SSH tunnel or a proxy, Host and port talks to that one server. A host list, SRV record or replica set URI reaches every member through it, by the name the member announces as the SSH server or proxy resolves it; the SRV record itself is looked up on this computer.';
  }
  if (engine === 'redis') {
    return 'Through an SSH tunnel or a proxy, Sentinel and Cluster reach every node through it, by the address the node announces as the SSH server or proxy sees it.';
  }
  if (isSearchDialogEngine(engine)) {
    return 'Through an SSH tunnel or a proxy, Joinery reaches one node: list a single URL (or use a Cloud ID). It does not discover other nodes through a tunnel.';
  }
  return undefined;
}

export const connectionFormSchema = z
  .object({
    name: z.string().trim().min(1, 'Give the connection a name').max(200),
    engine: z.enum(DIALOG_ENGINES),
    endpointKind: z.enum(FORM_ENDPOINT_KINDS),
    /** The host of a host endpoint, or the SRV host name of a mongodb+srv endpoint. */
    host: z.string().trim().max(255),
    port: z.string().trim(),
    socketPath: z.string().trim().max(1024),
    uri: z.string().trim().max(8192),
    /** MongoDB host list or Redis cluster seeds. */
    hostList: z.array(hostRowSchema).max(MAX_HOST_ROWS),
    /** Elasticsearch / OpenSearch node URLs. */
    urls: z.array(urlRowSchema).max(MAX_HOST_ROWS),
    /** Elastic Cloud deployment id. */
    cloudId: z.string().trim().max(2048),
    /** Elasticsearch / OpenSearch: discover the other nodes from the listed ones. */
    sniff: z.boolean(),
    /** MongoDB replica set name for a host list; optional. */
    replicaSet: z.string().trim().max(255),
    sentinels: z.array(hostRowSchema).max(MAX_HOST_ROWS),
    /** The master the Sentinels watch. */
    masterName: z.string().trim().max(255),
    /** SQL and MongoDB default database; Redis logical database number. */
    database: z.string().trim().max(255),
    /** MongoDB and Redis only: SQL engines always sign in with a user and optional password. */
    authMethod: z.enum(AUTH_METHODS),
    user: z.string().trim().max(1024),
    /** Typed password; empty while editing keeps the stored one. */
    password: z.string().max(65_536),
    passwordMode: z.enum(PASSWORD_MODES),
    /** SASL mechanism or auth plugin; the dialog edits it for MongoDB and keeps it otherwise. */
    mechanism: z.string().trim().max(64),
    /** MongoDB: the database holding the user; empty uses the driver's default (admin). */
    authSource: z.string().trim().max(255),
    directConnection: z.boolean(),
    /** MongoDB: empty uses the driver's default (primary). */
    readPreference: z.union([z.literal(''), z.enum(READ_PREFERENCES)]),
    /** Redis key browser delimiter; empty uses ":". Not trimmed: a space is a delimiter too. */
    keyDelimiter: z.string().max(16, 'Use a delimiter of at most 16 characters'),
    tlsMode: tlsModeSchema,
    caPath: z.string().trim().max(4096),
    certPath: z.string().trim().max(4096),
    keyPath: z.string().trim().max(4096),
    environment: environmentSchema,
    readOnly: z.boolean(),
    confirmWrites: z.boolean(),
    color: z.union([z.literal(''), z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Use a #rrggbb colour')]),
    folderId: z.string(),
    sshEnabled: z.boolean(),
    /** Jump hosts in the order Joinery connects to them, then the SSH server. */
    sshHops: z.array(sshHopFormSchema).max(MAX_SSH_HOPS),
    /** Seconds between keep-alive messages; 0 turns them off. */
    sshKeepAlive: z.string().trim(),
    proxyKind: z.enum(PROXY_KINDS),
    proxyHost: z.string().trim().max(255),
    proxyPort: z.string().trim(),
    proxyUser: z.string().trim().max(255),
    /** Typed proxy password; empty while editing keeps the stored one. */
    proxyPassword: z.string().max(65_536),
    proxyPasswordMode: z.enum(PASSWORD_MODES),
  })
  .superRefine((form, ctx) => {
    const issue = (path: (string | number)[], message: string): void =>
      ctx.addIssue({ code: 'custom', path, message });
    endpointIssues(form, issue);
    authIssues(form, issue);
    optionIssues(form, issue);
    tunnelIssues(form, issue);
    searchIssues(form, issue);
  });

export type ConnectionFormValues = z.infer<typeof connectionFormSchema>;

type IssueAt = (path: (string | number)[], message: string) => void;

function rowIssues(rows: readonly HostRowValues[], field: string, issue: IssueAt): void {
  rows.forEach((row, index) => {
    if (row.host === '') issue([field, index, 'host'], 'Enter a host');
    if (!isPort(row.port)) issue([field, index, 'port'], 'Port must be 1 to 65535');
  });
}

function endpointIssues(form: ConnectionFormValues, issue: IssueAt): void {
  if (!endpointKindsFor(form.engine).includes(form.endpointKind)) {
    issue(['endpointKind'], `${ENGINES[form.engine].displayName} cannot connect this way`);
    return;
  }
  switch (form.endpointKind) {
    case 'host':
      if (form.host === '') issue(['host'], 'Enter a host');
      if (!isPort(form.port)) issue(['port'], 'Port must be 1 to 65535');
      break;
    case 'srv':
      if (form.host === '') issue(['host'], 'Enter the SRV host name');
      else if (/[:/,@?]/.test(form.host)) {
        issue(['host'], 'Enter the host name only: mongodb+srv takes no port, user or scheme');
      }
      break;
    case 'socket':
      if (form.socketPath === '') issue(['socketPath'], 'Enter the socket path');
      break;
    case 'hosts':
    case 'cluster':
      if (form.hostList.length === 0) issue(['hostList'], 'Add at least one host');
      rowIssues(form.hostList, 'hostList', issue);
      break;
    case 'sentinel':
      if (form.sentinels.length === 0) issue(['sentinels'], 'Add at least one Sentinel');
      rowIssues(form.sentinels, 'sentinels', issue);
      if (form.masterName === '') {
        issue(['masterName'], 'Enter the name of the master the Sentinels watch');
      }
      break;
    case 'uri':
      uriIssues(form, issue);
      break;
  }
}

function uriIssues(form: ConnectionFormValues, issue: IssueAt): void {
  if (form.uri === '') {
    issue(['uri'], 'Enter a URI');
    return;
  }
  if (uriCarriesSecret(form.uri)) {
    issue(['uri'], 'Remove the password from the URI and put it in the password field');
    return;
  }
  const scheme = uriScheme(form.uri) ?? '';
  if (form.engine === 'mongodb' && scheme !== 'mongodb' && scheme !== 'mongodb+srv') {
    issue(['uri'], 'A MongoDB URI starts with mongodb:// or mongodb+srv://');
  }
  if (form.engine === 'redis') {
    if (scheme !== 'redis' && scheme !== 'rediss') {
      issue(['uri'], 'A Redis URI starts with redis:// or rediss:// (TLS)');
    } else if (scheme === 'rediss' && form.tlsMode === 'disable') {
      issue(['tlsMode'], 'A rediss:// URI connects with TLS: choose a TLS mode, or use redis://');
    } else if (scheme === 'redis' && form.tlsMode !== 'disable') {
      issue(
        ['tlsMode'],
        'A redis:// URI connects without TLS: choose Disable TLS, or use rediss://',
      );
    }
  }
}

function authIssues(form: ConnectionFormValues, issue: IssueAt): void {
  if (isSqlEngine(form.engine)) return;
  if (!ENGINE_AUTH_METHODS[form.engine].includes(form.authMethod)) {
    issue(['authMethod'], `${ENGINES[form.engine].displayName} does not offer this sign-in`);
    return;
  }
  if (form.engine === 'mongodb' && form.authMethod === 'password' && form.user === '') {
    issue(['user'], 'Enter the user name');
  }
  if (form.authMethod === 'clientCertificate') {
    if (form.tlsMode === 'disable') issue(['tlsMode'], 'X.509 authentication needs TLS');
    if (form.certPath === '') issue(['certPath'], 'Choose the client certificate');
    if (form.keyPath === '') {
      issue(['keyPath'], 'Choose the client key (the same file when the PEM holds both)');
    }
  }
}

function optionIssues(form: ConnectionFormValues, issue: IssueAt): void {
  if (form.engine === 'redis' && showsDatabase(form) && form.database !== '') {
    if (!isRedisDatabase(form.database)) {
      issue(['database'], 'Enter a database number (0 to 15 on a default server)');
    }
  }
  if (form.engine === 'mongodb' && form.endpointKind !== 'uri') {
    if (form.database !== '' && !isMongoDatabaseName(form.database)) {
      issue(['database'], MONGO_NAME_MESSAGE);
    }
    if (
      showsAuthSource(form) &&
      form.authSource !== '' &&
      form.authSource !== EXTERNAL_AUTH_SOURCE &&
      !isMongoDatabaseName(form.authSource)
    ) {
      issue(['authSource'], MONGO_NAME_MESSAGE);
    }
  }
}

function tunnelIssues(form: ConnectionFormValues, issue: IssueAt): void {
  if (form.sshEnabled || form.proxyKind !== 'none') tunnelledEndpointIssues(form, issue);
  if (form.sshEnabled) sshIssues(form, issue);
  if (form.proxyKind !== 'none') {
    if (form.proxyHost === '') issue(['proxyHost'], 'Enter the proxy host');
    if (!isPort(form.proxyPort)) issue(['proxyPort'], 'Port must be 1 to 65535');
  }
}

/**
 * What a tunnel or proxy cannot carry: a Unix socket, and a Redis URI with several hosts (use
 * Sentinel or Cluster, whose nodes it reaches). MongoDB host lists, SRV names and replica set
 * URIs, Redis Sentinel and Cluster all go through it (ADR 0008).
 */
function tunnelledEndpointIssues(form: ConnectionFormValues, issue: IssueAt): void {
  if (form.endpointKind === 'socket') {
    issue(
      ['socketPath'],
      'A Unix socket cannot be reached through an SSH tunnel or a proxy; use the host and port the SSH server sees',
    );
  } else if (
    form.engine === 'redis' &&
    form.endpointKind === 'uri' &&
    uriHosts(form.uri).length > 1
  ) {
    issue(
      ['uri'],
      'Only a single-host URI can go through an SSH tunnel or a proxy; for several nodes, connect with Sentinel or Cluster',
    );
  }
}

function sshIssues(form: ConnectionFormValues, issue: IssueAt): void {
  if (form.sshHops.length === 0) issue(['sshHops'], 'Add the SSH server');
  form.sshHops.forEach((hop, index) => {
    const at = (field: keyof SshHopFormValues, message: string): void =>
      issue(['sshHops', index, field], message);
    if (hop.host === '') at('host', 'Enter the SSH host');
    if (!isPort(hop.port)) at('port', 'Port must be 1 to 65535');
    if (hop.user === '') at('user', 'Enter the SSH user');
    if (hop.authMethod === 'privateKey' && hop.keyPath === '') {
      at('keyPath', 'Choose the private key file');
    }
  });
  const keepAlive = Number(form.sshKeepAlive);
  if (!/^\d+(\.\d+)?$/.test(form.sshKeepAlive) || keepAlive > 3600) {
    issue(['sshKeepAlive'], 'Keep-alive is 0 (off) to 3600 seconds');
  }
}

/** The scheme a node URL states ('http' or 'https'), or undefined without one. */
export function nodeUrlScheme(url: string): string | undefined {
  return /^([a-z][a-z0-9+.-]*):\/\//i.exec(url.trim())?.[1]?.toLowerCase();
}

/**
 * Whether a Cloud ID can be read: "name:base64(host$es-id$kibana-id)". The page cannot see the
 * cluster, so this only checks the shape.
 */
export function isCloudId(value: string): boolean {
  const encoded = value.slice(value.indexOf(':') + 1).trim();
  try {
    const [host, esId] = atob(encoded).split('$');
    return Boolean(host) && Boolean(esId);
  } catch {
    return false;
  }
}

/**
 * Elasticsearch and OpenSearch (spec §4): node URLs (http or https, no password in them, one
 * scheme for all, and the TLS mode following it as Redis's rediss:// does), or a Cloud ID; a
 * user for basic authentication; a stored API key or token; one URL through a tunnel.
 */
function searchIssues(form: ConnectionFormValues, issue: IssueAt): void {
  if (!isSearchDialogEngine(form.engine)) return;
  if (form.endpointKind === 'urls') {
    if (form.urls.length === 0) issue(['urls'], 'Add at least one node URL');
    const schemes = new Set<string>();
    form.urls.forEach((row, index) => {
      const at = (message: string): void => issue(['urls', index, 'url'], message);
      if (row.url === '') {
        at('Enter a URL such as https://localhost:9200');
        return;
      }
      const scheme = nodeUrlScheme(row.url);
      if (scheme !== undefined && scheme !== 'http' && scheme !== 'https') {
        at('A node URL starts with http:// or https://');
        return;
      }
      let url: URL;
      try {
        url = new URL(scheme ? row.url : `https://${row.url}`);
      } catch {
        at('This is not a valid URL');
        return;
      }
      if (url.password) {
        at('Remove the password from the URL and put it in the password field');
        return;
      }
      schemes.add(scheme ?? (form.tlsMode === 'disable' ? 'http' : 'https'));
    });
    if (schemes.size > 1) {
      issue(['urls'], 'Use the same scheme (http:// or https://) for every node');
    } else if (schemes.has('https') && form.tlsMode === 'disable') {
      issue(['tlsMode'], 'An https:// URL connects with TLS: choose a TLS mode, or use http://');
    } else if (schemes.has('http') && form.tlsMode !== 'disable') {
      issue(
        ['tlsMode'],
        'An http:// URL connects without TLS: choose Disable TLS, or use https://',
      );
    }
    if ((form.sshEnabled || form.proxyKind !== 'none') && form.urls.length > 1) {
      issue(
        ['urls'],
        'Only one node URL can go through an SSH tunnel or a proxy: Joinery reaches that one node through it',
      );
    }
  } else if (form.endpointKind === 'cloudId') {
    if (form.cloudId === '') issue(['cloudId'], 'Paste the Cloud ID of the deployment');
    else if (!isCloudId(form.cloudId)) {
      issue(
        ['cloudId'],
        'This is not a Cloud ID: copy it from the deployment page in Elastic Cloud',
      );
    }
    if (form.tlsMode === 'disable') {
      issue(['tlsMode'], 'Elastic Cloud connects with TLS: choose a TLS mode');
    }
  }
  if (form.authMethod === 'password' && form.user === '') {
    issue(['user'], 'Enter the user name, e.g. elastic');
  }
  if (
    (form.authMethod === 'apiKey' || form.authMethod === 'bearer') &&
    form.passwordMode === 'none'
  ) {
    issue(
      ['passwordMode'],
      form.authMethod === 'apiKey'
        ? 'Choose how Joinery keeps the API key'
        : 'Choose how Joinery keeps the token',
    );
  }
}

/**
 * Whether the form edits the default database. A URI names its own; a Redis cluster has only
 * database 0.
 */
export function showsDatabase(
  form: Pick<ConnectionFormValues, 'engine' | 'endpointKind'>,
): boolean {
  if (form.endpointKind === 'uri' || isSearchDialogEngine(form.engine)) return false;
  return !(form.engine === 'redis' && form.endpointKind === 'cluster');
}

/**
 * Whether the form edits MongoDB's authentication database: for a user and SCRAM password. LDAP
 * and X.509 users always live in `$external`.
 */
export function showsAuthSource(
  form: Pick<ConnectionFormValues, 'engine' | 'endpointKind' | 'authMethod' | 'mechanism'>,
): boolean {
  return (
    form.engine === 'mongodb' &&
    form.endpointKind !== 'uri' &&
    form.authMethod === 'password' &&
    form.mechanism !== 'PLAIN'
  );
}

/** A new SSH hop: port 22, password authentication. */
export function defaultSshHop(): SshHopFormValues {
  return {
    host: '',
    port: '22',
    user: '',
    authMethod: 'password',
    password: '',
    passwordMode: 'save',
    keyPath: '',
    passphrase: '',
    passphraseMode: 'none',
  };
}

/** A new row of a host list or cluster seed list: localhost on the engine's port. */
export function defaultHostRow(engine: DialogEngine): HostRowValues {
  return { host: 'localhost', port: String(ENGINES[engine].defaultPort) };
}

/** A new row of a Sentinel list: localhost on Sentinel's port. */
export function defaultSentinelRow(): HostRowValues {
  return { host: 'localhost', port: String(SENTINEL_PORT) };
}

/** Sign-in method of a new form: SQL takes a user and password, MongoDB and Redis start open. */
const DEFAULT_AUTH_METHOD: Readonly<Record<DialogEngine, FormAuthMethod>> = {
  postgres: 'password',
  mysql: 'password',
  mariadb: 'password',
  mongodb: 'none',
  redis: 'none',
  // Elasticsearch 8 and later have security on by default; OpenSearch often runs without it.
  elasticsearch: 'password',
  opensearch: 'none',
};

/** A new node URL row: the engine's port on localhost, over https. */
export function defaultUrlRow(): UrlRowValues {
  return { url: 'https://localhost:9200' };
}

export function defaultFormValues(engine: DialogEngine = 'postgres'): ConnectionFormValues {
  return {
    name: '',
    engine,
    endpointKind: isSearchDialogEngine(engine) ? 'urls' : 'host',
    host: 'localhost',
    port: String(ENGINES[engine].defaultPort),
    socketPath: '',
    uri: '',
    hostList: [defaultHostRow(engine)],
    urls: [defaultUrlRow()],
    cloudId: '',
    sniff: false,
    replicaSet: '',
    sentinels: [defaultSentinelRow()],
    masterName: '',
    database: '',
    authMethod: DEFAULT_AUTH_METHOD[engine],
    user: '',
    password: '',
    passwordMode: 'save',
    mechanism: engine === 'mongodb' ? 'SCRAM-SHA-256' : '',
    authSource: '',
    directConnection: false,
    readPreference: '',
    keyDelimiter: ':',
    tlsMode: 'verify-full',
    caPath: '',
    certPath: '',
    keyPath: '',
    environment: 'dev',
    readOnly: false,
    confirmWrites: false,
    color: '',
    folderId: '',
    sshEnabled: false,
    sshHops: [defaultSshHop()],
    sshKeepAlive: '15',
    proxyKind: 'none',
    proxyHost: '',
    proxyPort: '1080',
    proxyUser: '',
    proxyPassword: '',
    proxyPasswordMode: 'none',
  };
}

export function isDialogEngine(engine: EngineId): engine is DialogEngine {
  return (DIALOG_ENGINES as readonly EngineId[]).includes(engine);
}

/**
 * The form after the user picks another engine. What every engine shares (name, host, user,
 * password, TLS, tunnel, presentation) stays; engine-specific fields go back to the new engine's
 * defaults: an endpoint form it lacks becomes host and port, the port follows when it still held
 * the old engine's default, and host lists, sign-in method and options start over. MySQL and
 * MariaDB, or PostgreSQL, keep a URI, socket and database typed for either.
 */
export function switchEngine(
  values: ConnectionFormValues,
  engine: DialogEngine,
): ConnectionFormValues {
  if (engine === values.engine) return values;
  const fresh = defaultFormValues(engine);
  const bothSql = isSqlEngine(values.engine) && isSqlEngine(engine);
  return {
    ...values,
    engine,
    endpointKind: endpointKindsFor(engine).includes(values.endpointKind)
      ? values.endpointKind
      : endpointKindsFor(engine)[0]!,
    port: values.port === String(ENGINES[values.engine].defaultPort) ? fresh.port : values.port,
    socketPath: bothSql ? values.socketPath : '',
    uri: bothSql ? values.uri : '',
    hostList: fresh.hostList,
    replicaSet: '',
    sentinels: fresh.sentinels,
    masterName: '',
    database: bothSql ? values.database : '',
    authMethod: ENGINE_AUTH_METHODS[engine].includes(values.authMethod)
      ? values.authMethod
      : fresh.authMethod,
    mechanism: fresh.mechanism,
    authSource: '',
    directConnection: false,
    readPreference: '',
    keyDelimiter: fresh.keyDelimiter,
    // Elasticsearch and OpenSearch keep their node URLs between each other.
    urls:
      isSearchDialogEngine(values.engine) && isSearchDialogEngine(engine)
        ? values.urls
        : fresh.urls,
    cloudId: engine === 'elasticsearch' ? values.cloudId : '',
    sniff: isSearchDialogEngine(engine) ? values.sniff : false,
  };
}

/**
 * The form after the user picks another way to connect. An SRV record implies TLS, as in MongoDB
 * drivers, so choosing it turns TLS back on (the user may turn it off again). A host or seed list
 * still holding its default row starts from the single host typed so far, and the single host,
 * while untouched, from the list's first row.
 */
export function switchEndpointKind(
  values: ConnectionFormValues,
  kind: FormEndpointKind,
): ConnectionFormValues {
  const next: ConnectionFormValues = { ...values, endpointKind: kind };
  if (kind === 'srv' && values.tlsMode === 'disable') next.tlsMode = 'verify-full';
  const [only, ...others] = values.hostList;
  const pristine =
    others.length === 0 &&
    (only === undefined || only.host === '' || sameRow(only, defaultHostRow(values.engine)));
  if ((kind === 'hosts' || kind === 'cluster') && values.endpointKind === 'host' && pristine) {
    next.hostList = [{ host: values.host, port: values.port }];
  }
  const fromList = values.endpointKind === 'hosts' || values.endpointKind === 'cluster';
  const untouched =
    (values.host === '' || values.host === 'localhost') &&
    values.port === String(ENGINES[values.engine].defaultPort);
  if (kind === 'host' && fromList && untouched && only !== undefined && only.host !== '') {
    next.host = only.host;
    next.port = only.port;
  }
  return next;
}

function sameRow(a: HostRowValues, b: HostRowValues): boolean {
  return a.host === b.host && a.port === b.port;
}

function rowsFrom(hosts: readonly HostPort[]): HostRowValues[] {
  return hosts.map((host) => ({ host: host.host, port: String(host.port) }));
}

function hostsFrom(rows: readonly HostRowValues[]): HostPort[] {
  return rows.map((row) => ({ host: row.host, port: Number(row.port) }));
}

/** Form values for an existing (or parsed) profile. The password field starts empty. */
export function profileToForm(profile: ConnectionProfile): ConnectionFormValues {
  const engine = isDialogEngine(profile.engine) ? profile.engine : 'postgres';
  const values = defaultFormValues(engine);
  const { endpoint, auth, tls, presentation, options } = profile;
  values.endpointKind = endpoint.kind;
  if (endpoint.kind === 'urls') {
    values.urls = endpoint.urls.map((url) => ({ url }));
  } else if (endpoint.kind === 'cloudId') {
    values.cloudId = endpoint.cloudId;
  } else if (endpoint.kind === 'host') {
    values.host = endpoint.host;
    values.port = String(endpoint.port);
  } else if (endpoint.kind === 'socket') {
    values.socketPath = endpoint.path;
  } else if (endpoint.kind === 'uri') {
    values.uri = endpoint.uri;
  } else if (endpoint.kind === 'hosts') {
    values.hostList = rowsFrom(endpoint.hosts);
    values.replicaSet = endpoint.replicaSet ?? '';
  } else if (endpoint.kind === 'srv') {
    values.host = endpoint.host;
  } else if (endpoint.kind === 'sentinel') {
    values.sentinels = rowsFrom(endpoint.sentinels);
    values.masterName = endpoint.masterName;
  } else if (endpoint.kind === 'cluster') {
    values.hostList = rowsFrom(endpoint.seeds);
  }
  let passwordMode: PasswordMode = 'none';
  if (auth.method === 'password') {
    values.user = auth.user ?? '';
    values.mechanism = auth.mechanism ?? '';
    passwordMode = auth.password ? auth.password.policy : 'none';
  } else if (auth.method === 'clientCertificate') {
    values.user = auth.user ?? '';
  } else if (auth.method === 'apiKey') {
    passwordMode = auth.apiKey.policy;
  } else if (auth.method === 'bearer') {
    passwordMode = auth.token.policy;
  }
  const method = ENGINE_AUTH_METHODS[engine].find((known) => known === auth.method);
  if (method !== undefined) values.authMethod = method;
  return {
    ...values,
    name: profile.name,
    database: options.defaultDatabase ?? '',
    passwordMode,
    authSource: options.authSource ?? '',
    directConnection: options.directConnection === true,
    readPreference: options.readPreference ?? '',
    keyDelimiter: options.keyDelimiter ?? '',
    sniff: options.sniff === true,
    tlsMode: tls.mode,
    caPath: tls.caPath ?? '',
    certPath: tls.certPath ?? '',
    keyPath: tls.keyPath ?? '',
    environment: presentation.environment,
    readOnly: presentation.readOnly,
    confirmWrites: presentation.confirmWrites,
    color: presentation.color ?? '',
    folderId: presentation.folderId ?? '',
    ...sshToForm(profile.ssh),
    ...proxyToForm(profile.proxy),
  };
}

function sshToForm(
  ssh: SshTunnel | undefined,
): Pick<ConnectionFormValues, 'sshEnabled' | 'sshHops' | 'sshKeepAlive'> {
  if (!ssh) return { sshEnabled: false, sshHops: [defaultSshHop()], sshKeepAlive: '15' };
  return {
    sshEnabled: true,
    sshHops: ssh.hops.map((hop) => {
      const values: SshHopFormValues = {
        ...defaultSshHop(),
        host: hop.host,
        port: String(hop.port),
        user: hop.user,
        authMethod: hop.auth.method,
      };
      if (hop.auth.method === 'password') values.passwordMode = hop.auth.password.policy;
      if (hop.auth.method === 'privateKey') {
        values.keyPath = hop.auth.keyPath;
        values.passphraseMode = hop.auth.passphrase?.policy ?? 'none';
      }
      return values;
    }),
    sshKeepAlive: String(ssh.keepAliveIntervalMs / 1000),
  };
}

function proxyToForm(
  proxy: ProxyOptions | undefined,
): Pick<
  ConnectionFormValues,
  'proxyKind' | 'proxyHost' | 'proxyPort' | 'proxyUser' | 'proxyPassword' | 'proxyPasswordMode'
> {
  if (!proxy) {
    return {
      proxyKind: 'none',
      proxyHost: '',
      proxyPort: '1080',
      proxyUser: '',
      proxyPassword: '',
      proxyPasswordMode: 'none',
    };
  }
  return {
    proxyKind: proxy.kind,
    proxyHost: proxy.host,
    proxyPort: String(proxy.port),
    proxyUser: proxy.user ?? '',
    proxyPassword: '',
    proxyPasswordMode: proxy.password?.policy ?? 'none',
  };
}

/** One of the profile's secrets as the form has it: the reference and what was typed. */
export interface SecretField {
  readonly ref: SecretRef;
  /** The typed value; empty keeps the stored one (unless the policy is `ask`). */
  readonly value: string;
  /** The policy the edited profile had for this reference, if it had it. */
  readonly previousPolicy: SecretPolicy | undefined;
}

export interface ProfileFromForm {
  readonly profile: ConnectionProfileInput;
  /** The password SecretRef, when the profile has one. */
  readonly passwordRef: { readonly id: string; readonly policy: SecretPolicy } | undefined;
  /** Every secret the profile references, the password included, with the typed values. */
  readonly secrets: readonly SecretField[];
}

/** The typed secrets by reference id, for a single call (Test Connection). */
export function typedSecrets(fields: readonly SecretField[]): Record<string, string> | undefined {
  const typed = fields.filter((field) => field.value !== '');
  return typed.length === 0
    ? undefined
    : Object.fromEntries(typed.map((field) => [field.ref.id, field.value]));
}

function optional(value: string): string | undefined {
  return value === '' ? undefined : value;
}

/**
 * Builds the profile to save or test. `existing` is the profile being edited: its id, creation
 * time, secret reference ids and every field the dialog does not show are kept.
 */
export function formToProfile(
  form: ConnectionFormValues,
  existing?: ConnectionProfile,
  now: () => string = () => new Date().toISOString(),
): ProfileFromForm {
  const usesPassword =
    isSqlEngine(form.engine) ||
    form.authMethod === 'password' ||
    form.authMethod === 'apiKey' ||
    form.authMethod === 'bearer';
  const previousRef = previousSecretRef(existing?.auth);
  const passwordRef =
    !usesPassword || form.passwordMode === 'none'
      ? undefined
      : { id: previousRef?.id ?? newId(), policy: form.passwordMode };
  const secrets: SecretField[] = [];
  if (passwordRef) {
    secrets.push({ ref: passwordRef, value: form.password, previousPolicy: previousRef?.policy });
  }
  const ssh = form.sshEnabled ? sshFromForm(form, existing?.ssh, secrets) : undefined;
  const proxy =
    form.proxyKind === 'none' ? undefined : proxyFromForm(form, existing?.proxy, secrets);

  const timestamp = now();
  const { ssh: _ssh, proxy: _proxy, ...kept } = existing ?? {};
  const profile: ConnectionProfileInput = {
    ...kept,
    ...(ssh ? { ssh } : {}),
    ...(proxy ? { proxy } : {}),
    id: existing?.id ?? newId(),
    name: form.name,
    engine: form.engine,
    endpoint: endpointFromForm(form),
    auth: authFromForm(form, passwordRef),
    tls: {
      ...(existing?.tls ?? {}),
      mode: form.tlsMode,
      caPath: optional(form.caPath),
      certPath: optional(form.certPath),
      keyPath: optional(form.keyPath),
    },
    options: optionsFromForm(form, existing?.options),
    presentation: {
      ...(existing?.presentation ?? {}),
      folderId: form.folderId === '' ? null : form.folderId,
      environment: form.environment,
      readOnly: form.readOnly,
      confirmWrites: form.confirmWrites,
      color: optional(form.color),
    },
    createdAt: existing?.createdAt ?? timestamp,
    updatedAt: timestamp,
  };
  return { profile, passwordRef, secrets };
}

/** The secret reference of the edited profile's sign-in (password, API key or token). */
function previousSecretRef(auth: Auth | undefined): SecretRef | undefined {
  switch (auth?.method) {
    case 'password':
      return auth.password;
    case 'apiKey':
      return auth.apiKey;
    case 'bearer':
      return auth.token;
    default:
      return undefined;
  }
}

function endpointFromForm(form: ConnectionFormValues): ConnectionProfile['endpoint'] {
  switch (form.endpointKind) {
    case 'urls':
      return { kind: 'urls', urls: form.urls.map((row) => row.url) };
    case 'cloudId':
      return { kind: 'cloudId', cloudId: form.cloudId };
    case 'host':
      return { kind: 'host', host: form.host, port: Number(form.port) };
    case 'socket':
      return { kind: 'socket', path: form.socketPath };
    case 'uri':
      return { kind: 'uri', uri: form.uri };
    case 'hosts':
      return {
        kind: 'hosts',
        hosts: hostsFrom(form.hostList),
        ...(form.replicaSet === '' ? {} : { replicaSet: form.replicaSet }),
      };
    case 'srv':
      return { kind: 'srv', host: form.host };
    case 'sentinel':
      return {
        kind: 'sentinel',
        sentinels: hostsFrom(form.sentinels),
        masterName: form.masterName,
      };
    case 'cluster':
      return { kind: 'cluster', seeds: hostsFrom(form.hostList) };
  }
}

function authFromForm(form: ConnectionFormValues, passwordRef: SecretRef | undefined): Auth {
  const user = form.user === '' ? {} : { user: form.user };
  const method = isSqlEngine(form.engine) ? 'password' : form.authMethod;
  switch (method) {
    case 'none':
      return { method: 'none' };
    case 'password':
      return {
        method: 'password',
        ...user,
        ...(passwordRef ? { password: passwordRef } : {}),
        ...(form.mechanism === '' ? {} : { mechanism: form.mechanism }),
      };
    case 'clientCertificate':
      return { method: 'clientCertificate', ...user };
    // Validation requires a storage policy, so the reference exists.
    case 'apiKey':
      return { method: 'apiKey', apiKey: passwordRef ?? { id: newId(), policy: 'ask' } };
    case 'bearer':
      return { method: 'bearer', token: passwordRef ?? { id: newId(), policy: 'ask' } };
  }
}

/**
 * The profile's options: everything the dialog does not show is kept, the engine's own options
 * come from the form, and another engine's options are dropped. What a URI endpoint states
 * itself (database, MongoDB's authSource, readPreference, directConnection) is not edited next to
 * it: the edited profile's values stay.
 */
function optionsFromForm(
  form: ConnectionFormValues,
  existing: ConnectionOptions | undefined,
): NonNullable<ConnectionProfileInput['options']> {
  const {
    authSource: previousAuthSource,
    directConnection: previousDirect,
    readPreference: previousReadPreference,
    keyDelimiter: _keyDelimiter,
    sniff: _sniff,
    ...shared
  } = existing ?? {};
  const viaUri = form.endpointKind === 'uri';
  const options: NonNullable<ConnectionProfileInput['options']> = {
    ...shared,
    defaultDatabase: viaUri
      ? existing?.defaultDatabase
      : showsDatabase(form)
        ? optional(form.database)
        : undefined,
  };
  if (form.engine === 'mongodb') {
    options.authSource = viaUri ? previousAuthSource : mongoAuthSource(form);
    options.readPreference = viaUri
      ? previousReadPreference
      : form.readPreference === ''
        ? undefined
        : form.readPreference;
    options.directConnection = viaUri
      ? previousDirect
      : form.endpointKind !== 'host'
        ? undefined
        : form.directConnection
          ? true
          : previousDirect === false
            ? false
            : undefined;
  }
  if (form.engine === 'redis') options.keyDelimiter = optional(form.keyDelimiter);
  if (isSearchDialogEngine(form.engine) && form.endpointKind === 'urls' && form.sniff) {
    options.sniff = true;
  }
  return options;
}

/**
 * MongoDB's authSource for the form's sign-in: what the user typed for SCRAM, `$external` for
 * LDAP (the only place LDAP users can be), and for X.509 only an explicit `$external` (its
 * default; any other database would be refused by the driver).
 */
function mongoAuthSource(form: ConnectionFormValues): string | undefined {
  if (form.authMethod === 'password') {
    return form.mechanism === 'PLAIN' ? EXTERNAL_AUTH_SOURCE : optional(form.authSource);
  }
  if (form.authMethod === 'clientCertificate') {
    return form.authSource === EXTERNAL_AUTH_SOURCE ? EXTERNAL_AUTH_SOURCE : undefined;
  }
  return undefined;
}

/** A reference for a secret, keeping the id the edited profile had for it. */
function secretFor(
  secrets: SecretField[],
  previous: SecretRef | undefined,
  policy: SecretPolicy,
  value: string,
): SecretRef {
  const ref = { id: previous?.id ?? newId(), policy };
  secrets.push({ ref, value, previousPolicy: previous?.policy });
  return ref;
}

function sshFromForm(
  form: ConnectionFormValues,
  existing: SshTunnel | undefined,
  secrets: SecretField[],
): SshTunnel {
  return {
    hops: form.sshHops.map((hop, index) => {
      const previous = existing?.hops[index]?.auth;
      let auth: SshAuth;
      if (hop.authMethod === 'password') {
        const ref = previous?.method === 'password' ? previous.password : undefined;
        auth = {
          method: 'password',
          password: secretFor(secrets, ref, hop.passwordMode, hop.password),
        };
      } else if (hop.authMethod === 'privateKey') {
        const ref = previous?.method === 'privateKey' ? previous.passphrase : undefined;
        auth = {
          method: 'privateKey',
          keyPath: hop.keyPath,
          ...(hop.passphraseMode === 'none'
            ? {}
            : { passphrase: secretFor(secrets, ref, hop.passphraseMode, hop.passphrase) }),
        };
      } else {
        auth = { method: 'agent' };
      }
      return { host: hop.host, port: Number(hop.port), user: hop.user, auth };
    }),
    keepAliveIntervalMs: Math.round(Number(form.sshKeepAlive) * 1000),
  };
}

function proxyFromForm(
  form: ConnectionFormValues,
  existing: ProxyOptions | undefined,
  secrets: SecretField[],
): ProxyOptions {
  const kind = form.proxyKind === 'http' ? 'http' : 'socks5';
  return {
    kind,
    host: form.proxyHost,
    port: Number(form.proxyPort),
    ...(form.proxyUser === '' ? {} : { user: form.proxyUser }),
    ...(form.proxyPasswordMode === 'none'
      ? {}
      : {
          password: secretFor(
            secrets,
            existing?.password,
            form.proxyPasswordMode,
            form.proxyPassword,
          ),
        }),
  };
}

/** Main's `profiles.parseUri`, passed in so the fill can run (and be tested) without main. */
export type ParseUri = (input: {
  readonly uri: string;
  readonly engine?: EngineId;
}) => Promise<ParsedConnectionUriResult>;

export interface FilledFromUri {
  readonly values: ConnectionFormValues;
  /** Query parameters the profile could not hold, secret-bearing ones included. */
  readonly ignoredParams: readonly string[];
}

/** What "Fill from URI" needs besides the pasted text. */
export interface FillFromUriOptions {
  /** The engine chosen when the fill starts: MariaDB claims a mysql:// URI. */
  readonly engine: DialogEngine;
  readonly parse: ParseUri;
  /**
   * The form as it is when the parsed profile is back. Called after every parse, so a name the
   * user typed meanwhile is kept rather than replaced by the URI's.
   */
  readonly current: () => ConnectionFormValues;
  /** Secrets can be saved on this system; a found password is otherwise kept for the session. */
  readonly canSave: boolean;
}

/**
 * The form after "Fill from URI". Main parses the URI into a draft profile and says whether it
 * held a password, which is then taken from the pasted text here (main never sends one back).
 * The name (unless empty) and the presentation fields stay as the user set them.
 */
export async function formFromUri(
  text: string,
  options: FillFromUriOptions,
): Promise<FilledFromUri> {
  const { parse, canSave } = options;
  const uri = text.trim();
  // An http(s) URL can be either search engine: the chosen one, else Elasticsearch.
  const engine =
    options.engine === 'mariadb' && /^mysql:/i.test(uri)
      ? 'mariadb'
      : /^https?:/i.test(uri)
        ? isSearchDialogEngine(options.engine)
          ? options.engine
          : 'elasticsearch'
        : undefined;
  const parsed = await parse({ uri, ...(engine ? { engine } : {}) });
  const profile = parsed.profile;
  // Read the fields to keep only now: the user may have typed a name while main parsed.
  const current = options.current();
  const next = profileToForm(profile);
  const password = parsed.passwordFound ? passwordFromUri(uri) : undefined;
  return {
    values: {
      ...next,
      name: current.name === '' ? next.name : current.name,
      environment: current.environment,
      readOnly: current.readOnly,
      confirmWrites: current.confirmWrites,
      color: current.color,
      folderId: current.folderId,
      password: password ?? '',
      passwordMode: password === undefined ? current.passwordMode : canSave ? 'save' : 'session',
    },
    ignoredParams: parsed.ignoredParams,
  };
}
