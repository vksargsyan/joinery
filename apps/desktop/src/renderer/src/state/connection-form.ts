import {
  ENGINES,
  environmentSchema,
  newId,
  tlsModeSchema,
  type ConnectionProfile,
  type ConnectionProfileInput,
  type EngineId,
  type ProxyOptions,
  type SecretPolicy,
  type SecretRef,
  type SshAuth,
  type SshTunnel,
} from '@joinery/core';
import { uriCarriesSecret } from '@joinery/ipc';
import { z } from 'zod';

/**
 * The connection dialog's form model (spec §4) and its mapping to and from a profile. The form is
 * flat strings and booleans, which is what inputs produce; `formToProfile` builds the profile the
 * main contract validates again. Fields the dialog does not show (tags, other options) are
 * carried over from the edited profile unchanged.
 *
 * Every secret (the password, SSH passwords and key passphrases, the proxy password) is typed
 * into the form and leaves it as a `SecretField`: a reference with its policy plus the typed
 * value, which the dialog hands to main and never gets back.
 */

/** Engines the dialog can configure today; the others are listed as coming soon. */
export const DIALOG_ENGINES = ['postgres', 'mysql', 'mariadb'] as const;
export type DialogEngine = (typeof DIALOG_ENGINES)[number];
export const COMING_SOON_ENGINES: readonly EngineId[] = [
  'mongodb',
  'redis',
  'elasticsearch',
  'opensearch',
];

export const PASSWORD_MODES = ['save', 'session', 'ask', 'none'] as const;
export type PasswordMode = (typeof PASSWORD_MODES)[number];

/** Storage policies for a secret the profile cannot do without (an SSH password). */
export const SECRET_MODES = ['save', 'session', 'ask'] as const;

export const SSH_AUTH_METHODS = ['password', 'privateKey', 'agent'] as const;
export type SshAuthMethod = (typeof SSH_AUTH_METHODS)[number];

export const PROXY_KINDS = ['none', 'socks5', 'http'] as const;

/** At most this many hops: jump hosts plus the SSH server that forwards to the database. */
export const MAX_SSH_HOPS = 8;

const portText = z
  .string()
  .trim()
  .refine((value) => /^\d{1,5}$/.test(value) && Number(value) >= 1 && Number(value) <= 65535, {
    message: 'Port must be a number from 1 to 65535',
  });

function isPort(value: string): boolean {
  return portText.safeParse(value).success;
}

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

export const connectionFormSchema = z
  .object({
    name: z.string().trim().min(1, 'Give the connection a name').max(200),
    engine: z.enum(DIALOG_ENGINES),
    endpointKind: z.enum(['host', 'socket', 'uri']),
    host: z.string().trim().max(255),
    port: z.string().trim(),
    socketPath: z.string().trim().max(1024),
    uri: z.string().trim().max(8192),
    database: z.string().trim().max(255),
    user: z.string().trim().max(255),
    /** Typed password; empty while editing keeps the stored one. */
    password: z.string().max(65_536),
    passwordMode: z.enum(PASSWORD_MODES),
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
    if (form.endpointKind === 'host') {
      if (form.host === '')
        ctx.addIssue({ code: 'custom', path: ['host'], message: 'Enter a host' });
      if (!portText.safeParse(form.port).success) {
        ctx.addIssue({ code: 'custom', path: ['port'], message: 'Port must be 1 to 65535' });
      }
    }
    if (form.endpointKind === 'socket' && form.socketPath === '') {
      ctx.addIssue({ code: 'custom', path: ['socketPath'], message: 'Enter the socket path' });
    }
    if (form.endpointKind === 'uri') {
      if (form.uri === '') ctx.addIssue({ code: 'custom', path: ['uri'], message: 'Enter a URI' });
      else if (uriCarriesSecret(form.uri)) {
        ctx.addIssue({
          code: 'custom',
          path: ['uri'],
          message: 'Remove the password from the URI and put it in the password field',
        });
      }
    }
    const tunnelled = form.sshEnabled || form.proxyKind !== 'none';
    if (tunnelled && form.endpointKind === 'socket') {
      ctx.addIssue({
        code: 'custom',
        path: ['socketPath'],
        message:
          'A Unix socket cannot be reached through an SSH tunnel or a proxy; use the host and port the SSH server sees',
      });
    }
    if (form.sshEnabled) {
      if (form.sshHops.length === 0) {
        ctx.addIssue({ code: 'custom', path: ['sshHops'], message: 'Add the SSH server' });
      }
      form.sshHops.forEach((hop, index) => {
        const at = (field: keyof SshHopFormValues, message: string): void =>
          ctx.addIssue({ code: 'custom', path: ['sshHops', index, field], message });
        if (hop.host === '') at('host', 'Enter the SSH host');
        if (!isPort(hop.port)) at('port', 'Port must be 1 to 65535');
        if (hop.user === '') at('user', 'Enter the SSH user');
        if (hop.authMethod === 'privateKey' && hop.keyPath === '') {
          at('keyPath', 'Choose the private key file');
        }
      });
      const keepAlive = Number(form.sshKeepAlive);
      if (!/^\d+(\.\d+)?$/.test(form.sshKeepAlive) || keepAlive > 3600) {
        ctx.addIssue({
          code: 'custom',
          path: ['sshKeepAlive'],
          message: 'Keep-alive is 0 (off) to 3600 seconds',
        });
      }
    }
    if (form.proxyKind !== 'none') {
      if (form.proxyHost === '') {
        ctx.addIssue({ code: 'custom', path: ['proxyHost'], message: 'Enter the proxy host' });
      }
      if (!isPort(form.proxyPort)) {
        ctx.addIssue({ code: 'custom', path: ['proxyPort'], message: 'Port must be 1 to 65535' });
      }
    }
  });

export type ConnectionFormValues = z.infer<typeof connectionFormSchema>;

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

export function defaultFormValues(engine: DialogEngine = 'postgres'): ConnectionFormValues {
  return {
    name: '',
    engine,
    endpointKind: 'host',
    host: 'localhost',
    port: String(ENGINES[engine].defaultPort),
    socketPath: '',
    uri: '',
    database: '',
    user: '',
    password: '',
    passwordMode: 'save',
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

/** Form values for an existing (or parsed) profile. The password field starts empty. */
export function profileToForm(profile: ConnectionProfile): ConnectionFormValues {
  const engine = isDialogEngine(profile.engine) ? profile.engine : 'postgres';
  const values = defaultFormValues(engine);
  const { endpoint, auth, tls, presentation, options } = profile;
  if (endpoint.kind === 'host') {
    values.endpointKind = 'host';
    values.host = endpoint.host;
    values.port = String(endpoint.port);
  } else if (endpoint.kind === 'socket') {
    values.endpointKind = 'socket';
    values.socketPath = endpoint.path;
  } else if (endpoint.kind === 'uri') {
    values.endpointKind = 'uri';
    values.uri = endpoint.uri;
  }
  let passwordMode: PasswordMode = 'none';
  if (auth.method === 'password') {
    values.user = auth.user ?? '';
    passwordMode = auth.password ? auth.password.policy : 'none';
  }
  return {
    ...values,
    name: profile.name,
    database: options.defaultDatabase ?? '',
    passwordMode,
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
  const endpoint: ConnectionProfile['endpoint'] =
    form.endpointKind === 'host'
      ? { kind: 'host', host: form.host, port: Number(form.port) }
      : form.endpointKind === 'socket'
        ? { kind: 'socket', path: form.socketPath }
        : { kind: 'uri', uri: form.uri };

  const previousRef = existing?.auth.method === 'password' ? existing.auth.password : undefined;
  const passwordRef =
    form.passwordMode === 'none'
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
    endpoint,
    auth: {
      method: 'password',
      ...(form.user === '' ? {} : { user: form.user }),
      ...(passwordRef ? { password: passwordRef } : {}),
    },
    tls: {
      ...(existing?.tls ?? {}),
      mode: form.tlsMode,
      caPath: optional(form.caPath),
      certPath: optional(form.certPath),
      keyPath: optional(form.keyPath),
    },
    options: {
      ...(existing?.options ?? {}),
      defaultDatabase:
        form.endpointKind === 'uri' ? existing?.options.defaultDatabase : optional(form.database),
    },
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

/**
 * The password in a pasted URI, which the page still has: main's parser never sends it back
 * (secrets only flow towards main). Handles `scheme://user:password@host` and `password=`.
 */
export function passwordFromUri(uri: string): string | undefined {
  const userinfo = /^[a-z][a-z0-9+.-]*:\/\/([^/?#@]*)@/i.exec(uri.trim())?.[1];
  const colon = userinfo?.indexOf(':') ?? -1;
  if (userinfo !== undefined && colon >= 0) return safeDecode(userinfo.slice(colon + 1));
  const param = /[?&;](?:password|passwd|pwd|pass)=([^&;#]*)/i.exec(uri)?.[1];
  return param === undefined ? undefined : safeDecode(param.replaceAll('+', ' '));
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
