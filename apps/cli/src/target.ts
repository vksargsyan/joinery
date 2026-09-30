import {
  ENGINES,
  connectionProfileSchema,
  type ConnectionProfile,
  type ResolvedProfile,
  type SecretRef,
  type TlsMode,
} from '@joinery/core';
import { safetyPolicyFor, type SafetyPolicy } from '@joinery/sql-tools';
import { parseConnectionUri, type Store, type StoredProfile } from '@joinery/storage';

import type { Prompter } from './context';
import { CliError } from './errors';
import type { Reporter } from './reporter';
import type { StoreHandle } from './store';
import {
  PROXY_PASSWORD_ENV,
  SSH_KEY_PASSPHRASE_ENV,
  SSH_PASSWORD_ENV,
  applyTunnelFlags,
  describeRoute,
  hasRouteFlags,
  hopLabel,
  type TunnelFlags,
} from './tunnels';

/**
 * Targets: every command's connection argument is a saved profile (name or id) or a connection
 * URI. URI passwords are used for the run only and never stored. Otherwise the password comes
 * from the profile's saved secret, JOINERY_PASSWORD_<PROFILE> / JOINERY_PASSWORD, or a hidden
 * prompt; without a terminal and without a password the command fails and says how to pass one.
 *
 * A saved profile's SSH tunnel and proxy come with it; their missing secrets are read from
 * JOINERY_SSH_PASSWORD, JOINERY_SSH_KEY_PASSPHRASE and JOINERY_PROXY_PASSWORD or asked for. A URI
 * target gets its tunnel and proxy from the command line (`--ssh`, `--proxy`, see tunnels.ts).
 *
 * An `http://` or `https://` URL is an Elasticsearch node. It can log in with the URL's
 * user and password, or with an API key from JOINERY_API_KEY; a saved profile's API key or
 * bearer token comes from its secret, JOINERY_API_KEY / JOINERY_BEARER_TOKEN, or a prompt.
 */

/** Per-run overrides applied on top of the profile or URI. */
export interface TargetOverrides {
  /** --tls: TLS mode for this run. */
  readonly tls?: TlsMode;
  /** --database: the database to connect to. */
  readonly database?: string;
  /** --read-only: refuse writes on this run whatever the profile says. */
  readonly readOnly?: boolean;
  /** --ssh, --proxy and the host key flags. The route flags apply to URI targets only. */
  readonly tunnel?: TunnelFlags;
}

/** A resolved connection target, ready to connect. Its secrets never print. */
export interface Target {
  readonly kind: 'profile' | 'uri';
  /** What to call it in messages: the profile name, or engine + host/database for a URI. */
  readonly label: string;
  readonly profile: ConnectionProfile;
  readonly secrets: Readonly<Record<string, string>>;
  readonly policy: SafetyPolicy;
  /**
   * The login password is known (URI, saved secret, environment or prompt). When false the
   * connection is tried without one, and an authentication failure can prompt and retry.
   */
  readonly passwordKnown: boolean;
  /** Where --read-only came from, for the refusal message. */
  readonly readOnlySource?: 'profile' | 'flag';
}

export interface TargetDeps {
  readonly store: StoreHandle;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly prompter: Prompter;
  readonly reporter: Reporter;
}

const URI_RE = /^(?:jdbc:)?[a-z][a-z0-9+.-]*:\/\//i;
/** The engines joinery-cli connects to. */
const CLI_ENGINES: ReadonlySet<string> = new Set([
  'postgres',
  'mysql',
  'mariadb',
  'mongodb',
  'redis',
  'elasticsearch',
]);
const SQL_SCHEMES = new Set(['postgres', 'postgresql', 'mysql', 'mariadb']);
/** MongoDB URIs work with `test` and `query` (the SQL commands refuse them when they connect). */
const MONGO_SCHEMES = new Set(['mongodb', 'mongodb+srv']);
/** Redis URIs work with `test` and `query` too (as @joinery/storage parses them). */
export const REDIS_SCHEMES: ReadonlySet<string> = new Set([
  'redis',
  'rediss',
  'redis+sentinel',
  'rediss+sentinel',
]);
/** Elasticsearch node URLs work with `test` and `query`. */
export const SEARCH_SCHEMES: ReadonlySet<string> = new Set(['http', 'https']);
/** SecretRef id for a password the CLI adds to a profile or URI that had none. */
export const CLI_PASSWORD_REF = 'joinery-cli-password';
/** SecretRef id for the API key JOINERY_API_KEY gives an http(s):// URL target. */
export const CLI_API_KEY_REF = 'joinery-cli-api-key';
/** The variables that supply a search profile's API key or bearer token. */
export const API_KEY_ENV = 'JOINERY_API_KEY';
export const BEARER_TOKEN_ENV = 'JOINERY_BEARER_TOKEN';

/** True when the argument is a connection URI rather than a profile name. */
export function isConnectionUri(spec: string): boolean {
  return URI_RE.test(spec.trim());
}

/**
 * Hides passwords in anything URI-shaped, for logs and messages: `user:secret@` becomes
 * `user:***@` and password-like query parameters are masked.
 */
export function redactUri(text: string): string {
  return text
    .replace(/(\/\/[^/@\s:]*):[^@\s/]*@/g, '$1:***@')
    .replace(/([?&](?:password|pass|pwd|sslpassword|token|secret)=)[^&\s]*/gi, '$1***');
}

/** JOINERY_PASSWORD_<PROFILE>: the profile name upper-cased, other characters as `_`. */
export function passwordEnvName(profileName: string): string {
  const suffix = profileName
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return `JOINERY_PASSWORD_${suffix}`;
}

/** Resolves a command-line target into a connectable profile with its secrets. */
export async function resolveTarget(
  spec: string,
  overrides: TargetOverrides,
  deps: TargetDeps,
): Promise<Target> {
  const target = isConnectionUri(spec)
    ? await resolveUri(spec, overrides, deps)
    : await resolveProfile(spec, overrides, deps);
  const route = describeRoute(target.profile);
  deps.reporter.debug(
    `target ${target.label}: ${target.profile.engine}, ${describeEndpoint(target.profile)}${route ? ` via ${route}` : ''}, tls ${target.profile.tls.mode}, password ${target.passwordKnown ? 'provided' : 'not provided'}`,
  );
  return target;
}

/** The profile plus its secrets, as the driver adapters take them. */
export function resolvedProfile(target: Target): ResolvedProfile {
  return { profile: target.profile, secrets: target.secrets };
}

/** The same target with a login password (from a prompt after an authentication failure). */
export function withPassword(target: Target, password: string): Target {
  const auth = target.profile.auth;
  const ref = (auth.method === 'password' ? auth.password : undefined) ?? {
    id: CLI_PASSWORD_REF,
    policy: 'ask' as const,
  };
  const user = 'user' in auth ? auth.user : undefined;
  const mechanism = auth.method === 'password' ? auth.mechanism : undefined;
  const profile: ConnectionProfile = {
    ...target.profile,
    auth: {
      method: 'password',
      ...(user !== undefined ? { user } : {}),
      ...(mechanism !== undefined ? { mechanism } : {}),
      password: ref,
    },
  };
  return {
    ...target,
    profile,
    secrets: secretMap([...Object.entries(target.secrets), [ref.id, password]]),
    passwordKnown: true,
  };
}

/** A one-line endpoint description without secrets: host:port, socket path or URI. */
export function describeEndpoint(profile: ConnectionProfile): string {
  const endpoint = profile.endpoint;
  switch (endpoint.kind) {
    case 'host':
      return `${endpoint.host}:${endpoint.port}`;
    case 'socket':
      return endpoint.path;
    case 'uri':
      return redactUri(endpoint.uri);
    case 'hosts':
      return `${endpoint.hosts.map((h) => `${h.host}:${h.port}`).join(',')}${endpoint.replicaSet ? ` (replica set ${endpoint.replicaSet})` : ''}`;
    case 'srv':
      return `${endpoint.host} (SRV)`;
    case 'sentinel':
      return `${endpoint.sentinels.map((h) => `${h.host}:${h.port}`).join(',')} (Sentinel master ${endpoint.masterName})`;
    case 'cluster':
      return `${endpoint.seeds.map((h) => `${h.host}:${h.port}`).join(',')} (Cluster)`;
    case 'urls':
      return endpoint.urls.map(redactUri).join(', ');
    case 'cloudId':
      return `Elastic Cloud deployment ${endpoint.cloudId.split(':')[0] ?? ''}`.trimEnd();
  }
}

// ---------------------------------------------------------------------------------------------

async function resolveUri(
  spec: string,
  overrides: TargetOverrides,
  deps: TargetDeps,
): Promise<Target> {
  const scheme = /^(?:jdbc:)?([a-z][a-z0-9+.-]*):/i.exec(spec.trim())?.[1]?.toLowerCase() ?? '';
  const search = SEARCH_SCHEMES.has(scheme);
  if (
    !SQL_SCHEMES.has(scheme) &&
    !MONGO_SCHEMES.has(scheme) &&
    !REDIS_SCHEMES.has(scheme) &&
    !search
  ) {
    throw new CliError(`joinery-cli does not support "${scheme}://" URIs`, {
      code: 'NOT_SUPPORTED',
      hint: 'Use a postgres://, postgresql://, mysql://, mariadb://, mongodb://, mongodb+srv://, redis://, rediss://, http:// or https:// URI, or a saved profile name',
    });
  }
  const parsed = parseConnectionUri(spec);
  if (parsed.ignoredParams.length > 0) {
    deps.reporter.warn(`ignored URI parameters: ${parsed.ignoredParams.join(', ')}`);
  }
  const now = new Date().toISOString();
  let profile = connectionProfileSchema.parse({
    ...parsed.profile,
    id: 'uri',
    createdAt: now,
    updatedAt: now,
  });
  profile = applyOverrides(profile, overrides);
  let tunnelSecrets: [string, string][] = [];
  if (hasRouteFlags(overrides.tunnel)) {
    const tunnelled = await applyTunnelFlags(profile, overrides.tunnel ?? {}, deps);
    profile = tunnelled.profile;
    tunnelSecrets = tunnelled.secrets;
  }
  const label = `${ENGINES[profile.engine].displayName} ${profile.name}`;
  let target: Target = {
    kind: 'uri',
    label,
    profile,
    secrets: secretMap(tunnelSecrets),
    policy: policyFor(profile, overrides),
    passwordKnown: false,
    ...(overrides.readOnly ? { readOnlySource: 'flag' as const } : {}),
  };
  const apiKey = deps.env[API_KEY_ENV];
  if (search && profile.auth.method === 'none' && apiKey !== undefined && apiKey !== '') {
    return withApiKey(target, apiKey);
  }
  const password = parsed.password ?? deps.env['JOINERY_PASSWORD'];
  if (password !== undefined) target = withPassword(target, password);
  return target;
}

/** A search URL target that logs in with an API key (JOINERY_API_KEY). */
function withApiKey(target: Target, apiKey: string): Target {
  const ref = { id: CLI_API_KEY_REF, policy: 'ask' as const };
  return {
    ...target,
    profile: { ...target.profile, auth: { method: 'apiKey', apiKey: ref } },
    secrets: secretMap([...Object.entries(target.secrets), [ref.id, apiKey]]),
    passwordKnown: true,
  };
}

async function resolveProfile(
  spec: string,
  overrides: TargetOverrides,
  deps: TargetDeps,
): Promise<Target> {
  const store = deps.store.open({ create: false });
  if (!store) {
    throw new CliError(`No profile named "${redactUri(spec)}"`, {
      code: 'NOT_FOUND',
      hint: `There is no local store at ${deps.store.location.path}. Add a profile with "joinery profiles add", point --store at the desktop app's store, or pass a connection URI (postgres://, mysql://, mariadb://)`,
    });
  }
  const stored = findProfile(store, spec);
  const profile = applyOverrides(stripVersion(stored), overrides);
  if (hasRouteFlags(overrides.tunnel)) {
    deps.reporter.warn(
      `--ssh, --ssh-key, --ssh-agent, --ssh-password-env and --proxy apply to URI targets; "${profile.name}" uses its saved SSH and proxy settings`,
    );
  }
  if (!CLI_ENGINES.has(profile.engine)) {
    throw new CliError(
      `Profile "${profile.name}" is a ${ENGINES[profile.engine].displayName} connection; joinery-cli supports PostgreSQL, MySQL, MariaDB, MongoDB, Redis and Elasticsearch`,
      { code: 'NOT_SUPPORTED' },
    );
  }
  const resolved = store.secrets.resolve(profile);
  const secrets: [string, string][] = Object.entries(resolved.secrets);
  const unreadable = new Set(resolved.unreadable.map((ref) => ref.id));
  const auth = profile.auth;
  const passwordRef = auth.method === 'password' ? auth.password : undefined;
  const tunnelSecrets = tunnelSecretsOf(profile);
  const tokenRef =
    auth.method === 'apiKey'
      ? { ref: auth.apiKey, what: 'API key', env: API_KEY_ENV }
      : auth.method === 'bearer'
        ? { ref: auth.token, what: 'bearer token', env: BEARER_TOKEN_ENV }
        : undefined;

  for (const ref of resolved.missing) {
    if (passwordRef && ref.id === passwordRef.id) {
      secrets.push([ref.id, await missingPassword(profile, ref, unreadable.has(ref.id), deps)]);
    } else if (tokenRef && ref.id === tokenRef.ref.id) {
      const value = await missingSecret(
        profile,
        tokenRef.what,
        tokenRef.env,
        unreadable.has(ref.id),
        deps,
      );
      secrets.push([ref.id, value]);
    } else if (profile.tls.keyPassphrase && ref.id === profile.tls.keyPassphrase.id) {
      const value = await missingSecret(
        profile,
        'TLS key passphrase',
        'JOINERY_TLS_KEY_PASSPHRASE',
        unreadable.has(ref.id),
        deps,
      );
      secrets.push([ref.id, value]);
    } else {
      const tunnel = tunnelSecrets.get(ref.id);
      if (tunnel) {
        secrets.push([
          ref.id,
          await missingSecret(profile, tunnel.what, tunnel.env, unreadable.has(ref.id), deps),
        ]);
      }
    }
  }

  const target: Target = {
    kind: 'profile',
    label: profile.name,
    profile,
    secrets: secretMap(secrets),
    policy: policyFor(profile, overrides),
    // A saved reference was resolved above; certificate and IAM logins need no password. A
    // profile with no password reference connects without one unless the environment has one.
    passwordKnown:
      passwordRef !== undefined || (auth.method !== 'password' && auth.method !== 'none'),
    ...(overrides.readOnly
      ? { readOnlySource: 'flag' as const }
      : profile.presentation.readOnly
        ? { readOnlySource: 'profile' as const }
        : {}),
  };
  const envPassword = target.passwordKnown ? undefined : passwordFromEnv(profile, deps.env);
  return envPassword !== undefined ? withPassword(target, envPassword) : target;
}

/** What each SSH and proxy secret of a profile is, and the variable that can supply it. */
function tunnelSecretsOf(
  profile: ConnectionProfile,
): Map<string, { readonly what: string; readonly env: string }> {
  const secrets = new Map<string, { readonly what: string; readonly env: string }>();
  for (const hop of profile.ssh?.hops ?? []) {
    if (hop.auth.method === 'password') {
      secrets.set(hop.auth.password.id, {
        what: `SSH password (${hopLabel(hop)})`,
        env: SSH_PASSWORD_ENV,
      });
    } else if (hop.auth.method === 'privateKey' && hop.auth.passphrase) {
      secrets.set(hop.auth.passphrase.id, {
        what: `SSH key passphrase (${hop.auth.keyPath})`,
        env: SSH_KEY_PASSPHRASE_ENV,
      });
    }
  }
  if (profile.proxy?.password) {
    secrets.set(profile.proxy.password.id, {
      what: `proxy password (${hopLabel(profile.proxy)})`,
      env: PROXY_PASSWORD_ENV,
    });
  }
  return secrets;
}

/** Finds a profile by id, then exact name, then name ignoring case; ambiguity is an error. */
export function findProfile(store: Store, spec: string): StoredProfile {
  const byId = store.profiles.get(spec);
  if (byId) return byId;
  const all = store.profiles.list();
  let matches = all.filter((p) => p.name === spec);
  if (matches.length === 0) {
    const lower = spec.toLowerCase();
    matches = all.filter((p) => p.name.toLowerCase() === lower);
  }
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) {
    throw new CliError(`${matches.length} profiles are named "${spec}"`, {
      hint: `Use the profile id instead: ${matches.map((p) => p.id).join(', ')}`,
    });
  }
  throw new CliError(`No profile named "${redactUri(spec)}"`, {
    code: 'NOT_FOUND',
    hint:
      all.length > 0
        ? 'Run "joinery profiles list" to see the saved profiles, or pass a connection URI'
        : 'No profiles are saved yet; add one with "joinery profiles add", or pass a connection URI',
  });
}

function stripVersion(stored: StoredProfile): ConnectionProfile {
  const { version: _version, ...profile } = stored;
  return profile;
}

function applyOverrides(profile: ConnectionProfile, overrides: TargetOverrides): ConnectionProfile {
  let next = profile;
  if (overrides.tls !== undefined) next = { ...next, tls: { ...next.tls, mode: overrides.tls } };
  if (overrides.database !== undefined) {
    next = { ...next, options: { ...next.options, defaultDatabase: overrides.database } };
  }
  return next;
}

function policyFor(profile: ConnectionProfile, overrides: TargetOverrides): SafetyPolicy {
  const policy = safetyPolicyFor(profile);
  return overrides.readOnly ? { ...policy, readOnly: true } : policy;
}

function passwordFromEnv(
  profile: ConnectionProfile,
  env: Readonly<Record<string, string | undefined>>,
): string | undefined {
  return env[passwordEnvName(profile.name)] ?? env['JOINERY_PASSWORD'];
}

async function missingPassword(
  profile: ConnectionProfile,
  ref: SecretRef,
  unreadable: boolean,
  deps: TargetDeps,
): Promise<string> {
  const fromEnv = passwordFromEnv(profile, deps.env);
  if (fromEnv !== undefined) return fromEnv;
  const envName = passwordEnvName(profile.name);
  if (deps.prompter.interactive) {
    if (unreadable) {
      deps.reporter.info(
        `The saved password for "${profile.name}" cannot be read here (sealed by the desktop app's keychain, or JOINERY_PASSPHRASE is not set or differs).`,
      );
    }
    return deps.prompter.secret(`Password for ${profile.name}: `);
  }
  const why = unreadable
    ? "It is saved, but sealed with a key joinery-cli does not have here: the desktop app's OS keychain, or a JOINERY_PASSPHRASE that is not set or differs. "
    : ref.policy === 'save'
      ? ''
      : `The profile asks for it every time (policy "${ref.policy}"). `;
  throw new CliError(`The password for profile "${profile.name}" is not available`, {
    code: 'AUTH_FAILED',
    hint: `${why}Set ${envName} (or JOINERY_PASSWORD), or run in a terminal to be prompted`,
  });
}

async function missingSecret(
  profile: ConnectionProfile,
  what: string,
  envName: string,
  unreadable: boolean,
  deps: TargetDeps,
): Promise<string> {
  const fromEnv = deps.env[envName];
  if (fromEnv !== undefined) return fromEnv;
  if (deps.prompter.interactive) return deps.prompter.secret(`${what} for ${profile.name}: `);
  throw new CliError(`The ${what} for profile "${profile.name}" is not available`, {
    code: 'AUTH_FAILED',
    hint: `${unreadable ? 'The saved value cannot be read here. ' : ''}Set ${envName}, or run in a terminal to be prompted`,
  });
}

const INSPECT = Symbol.for('nodejs.util.inspect.custom');

/**
 * A frozen id → value map whose JSON, inspect and string forms hide the values, so a secret
 * cannot reach a log line through an accidental `JSON.stringify(target)`.
 */
export function secretMap(
  entries: Iterable<readonly [string, string]>,
): Readonly<Record<string, string>> {
  const record = Object.create(null) as Record<string, string>;
  for (const [id, value] of entries) record[id] = value;
  const ids = Object.keys(record);
  const redacted = (): Record<string, string> =>
    Object.fromEntries(ids.map((id) => [id, '[redacted]']));
  Object.defineProperties(record, {
    toJSON: { value: redacted, enumerable: false },
    toString: { value: () => `[secrets: ${ids.length}]`, enumerable: false },
    [INSPECT]: { value: redacted, enumerable: false },
  });
  return Object.freeze(record);
}
