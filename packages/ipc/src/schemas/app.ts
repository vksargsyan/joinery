import {
  connectionProfileSchema,
  engineIdSchema,
  secretPolicySchema,
  secretRefsOf,
} from '@joinery/core';
import { z } from 'zod';

import { idSchema } from './common';
import { pageSizeSchema } from './results';

/**
 * Schemas for the app-level data the renderer exchanges with the main process: profiles as they
 * may cross, folders, query history, settings and app info.
 */

/**
 * SecretRef ids that cross the renderer boundary are opaque UUIDs (mint them with core's
 * `newId()`). Anything else could be the secret itself typed into the wrong field.
 */
export const secretRefIdSchema = z.uuid();

/** A secret value on its way to main for sealing. Only ever an input, never an output. */
export const secretValueSchema = z.string().max(65_536);

/** Secrets for one call only (Test Connection before saving, "ask every time"), by SecretRef id. */
export const transientSecretsSchema = z.record(secretRefIdSchema, secretValueSchema);

const URI_USERINFO_PASSWORD = /^[a-z][a-z0-9+.-]*:\/\/[^/?#@]*:[^/?#@]*@/i;
const URI_SECRET_PARAM =
  /[?&;](?:password|passwd|pwd|pass|sslpassword|secret|token|api[-_]?key|access[-_]?key)=/i;

/** True when a connection URI or node URL carries a password or token. */
export function uriCarriesSecret(uri: string): boolean {
  return URI_USERINFO_PASSWORD.test(uri) || URI_SECRET_PARAM.test(uri);
}

/**
 * A connection profile as it may cross IPC, in either direction (spec §4: secrets never live in
 * the profile). On top of core's profile schema it rejects the two places a secret value could
 * still hide (a password inside an endpoint URI, and a secret typed in as a SecretRef id), and
 * like every zod object it strips unknown keys, so nothing outside the schema is stored or sent.
 * Error messages never echo the offending value.
 */
export const safeProfileSchema = connectionProfileSchema.superRefine((profile, ctx) => {
  const { endpoint } = profile;
  if (endpoint.kind === 'uri' && uriCarriesSecret(endpoint.uri)) {
    ctx.addIssue({
      code: 'custom',
      path: ['endpoint', 'uri'],
      message: 'The URI must not carry a password or token; store it as a secret',
    });
  }
  if (endpoint.kind === 'urls') {
    endpoint.urls.forEach((url, index) => {
      if (uriCarriesSecret(url)) {
        ctx.addIssue({
          code: 'custom',
          path: ['endpoint', 'urls', index],
          message: 'The URL must not carry a password or token; store it as a secret',
        });
      }
    });
  }
  if (secretRefsOf(profile).some((ref) => !secretRefIdSchema.safeParse(ref.id).success)) {
    ctx.addIssue({ code: 'custom', message: 'Secret reference ids must be UUIDs (newId())' });
  }
});

const timestampSchema = z.iso.datetime({ offset: true });

/**
 * Optimistic concurrency, as @joinery/storage implements it: a write fails unless the stored row
 * version equals this (0: the row must not exist yet), so the app and joinery-cli never silently
 * overwrite each other's edits.
 */
export const expectedVersionSchema = z.number().int().nonnegative();
const versionSchema = z.number().int().positive();

/** A profile as main returns it: `safeProfileSchema` plus the stored row version. */
export const storedProfileSchema = safeProfileSchema.extend({ version: versionSchema });
export type StoredProfile = z.infer<typeof storedProfileSchema>;

const folderNameSchema = z.string().trim().min(1).max(200);

/** A folder in the connection tree (spec §4); folders nest. */
export const folderSchema = z.object({
  id: idSchema,
  /** The containing folder, or null at the root. */
  parentId: idSchema.nullable(),
  name: folderNameSchema,
  /** Position among siblings; ties sort by name. */
  sortOrder: z.number().int(),
  version: versionSchema,
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});
export type Folder = z.infer<typeof folderSchema>;

/** Creates a folder (no `id`, or an id not stored yet) or updates one. */
export const folderSaveInputSchema = z.object({
  id: idSchema.optional(),
  name: folderNameSchema,
  parentId: idSchema.nullable().default(null),
  sortOrder: z.number().int().default(0),
  expectedVersion: expectedVersionSchema.optional(),
});
export type FolderSaveInput = z.input<typeof folderSaveInputSchema>;

export const queryStatusSchema = z.enum(['success', 'error', 'cancelled']);
export type QueryStatus = z.infer<typeof queryStatusSchema>;

/** One run in the query history (spec §6): text, connection, database, duration, rows, status. */
export const historyEntrySchema = z.object({
  id: idSchema,
  profileId: idSchema,
  /** The database (or MongoDB database, Redis DB index...) the statement ran in. */
  database: z.string().nullable(),
  text: z.string().min(1),
  status: queryStatusSchema,
  /** The error message of a failed run. */
  error: z.string().nullable(),
  durationMs: z.number().nonnegative().nullable(),
  /** Rows returned, or rows affected by a write. */
  rowCount: z.number().int().nonnegative().nullable(),
  executedAt: timestampSchema,
});
export type HistoryEntry = z.infer<typeof historyEntrySchema>;

/** A run to record; main assigns the id, and `executedAt` defaults to now. */
export const historyAddInputSchema = z.object({
  profileId: idSchema,
  database: z.string().nullable().default(null),
  text: z.string().min(1),
  status: queryStatusSchema,
  error: z.string().nullable().default(null),
  durationMs: z.number().nonnegative().nullable().default(null),
  rowCount: z.number().int().nonnegative().nullable().default(null),
  executedAt: timestampSchema.optional(),
});
export type HistoryAddInput = z.input<typeof historyAddInputSchema>;

const historyPageOptions = {
  profileId: idSchema.optional(),
  limit: z.number().int().min(1).max(1000).default(100),
  /** `nextCursor` of the previous page. */
  cursor: z.string().min(1).max(256).optional(),
};

export const historyListInputSchema = z.object(historyPageOptions).prefault({});

/** Every whitespace-separated term must occur in the statement text, case-insensitively. */
export const historySearchInputSchema = z.object({
  query: z.string().trim().min(1).max(1000),
  ...historyPageOptions,
});

/** A page of history, newest first. */
export const historyPageSchema = z.object({
  entries: z.array(historyEntrySchema),
  /** Pass as `cursor` for the next (older) page; null on the last page. */
  nextCursor: z.string().nullable(),
});
export type HistoryPage = z.infer<typeof historyPageSchema>;

export const appSettingsSchema = z.object({
  theme: z.enum(['system', 'light', 'dark', 'high-contrast']),
  /** BCP 47 tag; English at launch (spec §18). */
  locale: z.string().min(2).max(35),
  /** Opt-in only (spec §18). */
  telemetry: z.boolean(),
  updateChannel: z.enum(['stable', 'beta']),
  editor: z.object({
    fontSize: z.number().int().min(8).max(48),
    tabSize: z.number().int().min(1).max(16),
    vimKeymap: z.boolean(),
    minimap: z.boolean(),
    formatOnSave: z.boolean(),
  }),
  results: z.object({
    /** Rows per fetched page. */
    pageSize: pageSizeSchema,
    /** Rows a result tab loads before Fetch All. */
    rowLimit: z.number().int().positive(),
  }),
  connections: z.object({
    /** Open connections past which connection hosts are pooled into shared hosts (spec §3). */
    hostPoolCap: z.number().int().min(1).max(64),
  }),
});
export type AppSettings = z.infer<typeof appSettingsSchema>;

/** A partial update to the settings, merged by main; nested groups may be partial too. */
export const appSettingsPatchSchema = z.deepPartial(appSettingsSchema);
export type AppSettingsPatch = z.infer<typeof appSettingsPatchSchema>;

export const DEFAULT_APP_SETTINGS: AppSettings = {
  theme: 'system',
  locale: 'en',
  telemetry: false,
  updateChannel: 'stable',
  editor: { fontSize: 13, tabSize: 2, vimKeymap: false, minimap: true, formatOnSave: false },
  results: { pageSize: 1000, rowLimit: 10_000 },
  connections: { hostPoolCap: 8 },
};

export const appInfoSchema = z.object({
  name: z.string(),
  version: z.string(),
  /** process.platform: darwin, win32, linux. */
  platform: z.string(),
  arch: z.string(),
  versions: z.object({
    electron: z.string().optional(),
    chrome: z.string().optional(),
    node: z.string(),
  }),
});
export type AppInfo = z.infer<typeof appInfoSchema>;

/**
 * What a pasted connection URI (spec §4) turned into. The profile is a draft with a fresh id and
 * timestamps that nothing has stored yet. The URI's password is not returned (no method hands a
 * secret to the renderer): `passwordFound` tells the renderer, which has the URI it pasted, that
 * there is one to move into the password field.
 */
export const parsedConnectionUriSchema = z.object({
  profile: safeProfileSchema,
  passwordFound: z.boolean(),
  /** Query parameters that were dropped (secret-bearing, or not mappable for the engine). */
  ignoredParams: z.array(z.string()),
});
export type ParsedConnectionUriResult = z.infer<typeof parsedConnectionUriSchema>;

export const parseUriInputSchema = z.object({
  uri: z.string().trim().min(1).max(8192),
  /** Needed for http(s) URLs; picks MariaDB for a mysql:// URI. */
  engine: engineIdSchema.optional(),
});

/**
 * Which of a profile's secrets main has no usable value for, so the renderer knows what to ask
 * before `openConnection`. References only: ids and policies, never a value.
 */
export const secretStatusSchema = z.object({
  /** Secrets with the `save` policy can be sealed on this machine (spec §4, safeStorage). */
  canSave: z.boolean(),
  missing: z.array(
    z.object({
      refId: secretRefIdSchema,
      policy: secretPolicySchema,
      /** A saved value exists but cannot be unsealed (other machine, new keychain). */
      unreadable: z.boolean(),
    }),
  ),
});
export type SecretStatus = z.infer<typeof secretStatusSchema>;

/** Lifecycle of a connection host as main supervises it (spec §18: crashed hosts restart). */
export const connectionStateSchema = z.enum([
  'connecting',
  'ready',
  'restarting',
  'failed',
  'closed',
]);
export type ConnectionState = z.infer<typeof connectionStateSchema>;

/**
 * A connection host changed state. After `restarting` the renderer's port to that host is dead;
 * once the host is `ready` again, `openConnection` hands out a fresh one.
 */
export const connectionEventSchema = z.object({
  connectionId: idSchema,
  profileId: idSchema,
  state: connectionStateSchema,
  /** The restart attempt, counting from 1, while `restarting`. */
  attempt: z.number().int().positive().optional(),
  /** Why the host stopped or failed; safe to show. */
  message: z.string().optional(),
});
export type ConnectionEvent = z.infer<typeof connectionEventSchema>;

/** An https link to open in the system browser; main checks it again (spec §18). */
export const externalUrlSchema = z.url({ protocol: /^https$/ }).max(2048);

export const openFileInputSchema = z.object({
  title: z.string().max(200).optional(),
  filters: z
    .array(
      z.object({
        name: z.string().min(1).max(100),
        extensions: z.array(z.string().regex(/^(\*|[A-Za-z0-9]{1,16})$/)).min(1),
      }),
    )
    .max(16)
    .optional(),
});
