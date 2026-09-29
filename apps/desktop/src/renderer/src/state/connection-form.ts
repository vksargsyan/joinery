import {
  ENGINES,
  environmentSchema,
  newId,
  tlsModeSchema,
  type ConnectionProfile,
  type ConnectionProfileInput,
  type EngineId,
  type SecretPolicy,
} from '@joinery/core';
import { uriCarriesSecret } from '@joinery/ipc';
import { z } from 'zod';

/**
 * The connection dialog's form model (spec §4) and its mapping to and from a profile. The form is
 * flat strings and booleans, which is what inputs produce; `formToProfile` builds the profile the
 * main contract validates again. Fields the dialog does not show (SSH, proxy, tags, other
 * options) are carried over from the edited profile unchanged.
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

const portText = z
  .string()
  .trim()
  .refine((value) => /^\d{1,5}$/.test(value) && Number(value) >= 1 && Number(value) <= 65535, {
    message: 'Port must be a number from 1 to 65535',
  });

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
  });

export type ConnectionFormValues = z.infer<typeof connectionFormSchema>;

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
  };
}

export interface ProfileFromForm {
  readonly profile: ConnectionProfileInput;
  /** The password SecretRef, when the profile has one. */
  readonly passwordRef: { readonly id: string; readonly policy: SecretPolicy } | undefined;
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

  const timestamp = now();
  const profile: ConnectionProfileInput = {
    ...(existing ?? {}),
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
  return { profile, passwordRef };
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
