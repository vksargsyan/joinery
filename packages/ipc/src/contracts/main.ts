import { z } from 'zod';

import { defineContract } from '../contract';
import {
  appInfoSchema,
  appSettingsPatchSchema,
  appSettingsSchema,
  expectedVersionSchema,
  folderSaveInputSchema,
  folderSchema,
  historyAddInputSchema,
  historyEntrySchema,
  historyListInputSchema,
  historyPageSchema,
  historySearchInputSchema,
  safeProfileSchema,
  secretRefIdSchema,
  secretValueSchema,
  storedProfileSchema,
  transientSecretsSchema,
} from '../schemas/app';
import { idSchema, taskProgressSchema } from '../schemas/common';
import { connectionCheckResultSchema } from '../schemas/driver';

const byId = z.object({ id: idSchema });

/**
 * Renderer ↔ main, through the preload bridge (spec §3, §18). Main validates every message
 * against this contract.
 *
 * Credentials flow one way. The renderer refers to connections by profile id; it may hand a typed
 * secret to main (`secrets.set`, or `secrets` on a single call) but no method returns one, and
 * profiles cross as `safeProfileSchema`, which has no field a secret value can live in.
 *
 * `openConnection` returns a connection id only. The desktop app transfers the MessagePort to the
 * connection host out of band (e.g. `webContents.postMessage('joinery:connection-port',
 * { connectionId }, [port])`), since ports cannot travel inside a validated payload; the renderer
 * then talks `connectionHostContract` over it.
 */
export const mainContract = defineContract({
  profiles: {
    list: { input: z.void(), output: z.array(storedProfileSchema) },
    /** Fails with NOT_FOUND for an unknown id. */
    get: { input: byId, output: storedProfileSchema },
    /**
     * Creates or replaces a profile (mint new ids and SecretRef ids with `newId()`) and returns
     * it as stored. With `expectedVersion`, fails unless the stored version still matches.
     */
    save: {
      input: z.object({
        profile: safeProfileSchema,
        expectedVersion: expectedVersionSchema.optional(),
      }),
      output: storedProfileSchema,
    },
    /** Deletes the profile and its stored secrets. */
    delete: { input: byId, output: z.void() },
  },
  folders: {
    list: { input: z.void(), output: z.array(folderSchema) },
    save: { input: folderSaveInputSchema, output: folderSchema },
    /** Deletes the folder; its profiles and subfolders move to its parent. */
    delete: { input: byId, output: z.void() },
  },
  secrets: {
    /**
     * Hands a typed secret to main, which seals it with safeStorage or keeps it for this app
     * session, per the SecretRef's policy in the profile. Write-only.
     */
    set: {
      input: z.object({ profileId: idSchema, refId: secretRefIdSchema, value: secretValueSchema }),
      output: z.void(),
    },
    /** Forgets one stored secret of a profile, or all of them when `refId` is absent. */
    clear: {
      input: z.object({ profileId: idSchema, refId: secretRefIdSchema.optional() }),
      output: z.void(),
    },
  },
  /**
   * Runs the stepwise check (spec §4: DNS, TCP, SSH, TLS, auth, ping, version) and streams one
   * result per step. Works on unsaved profiles: `secrets` supplies values typed in the dialog,
   * used for this check only. Cancel by aborting or leaving the loop.
   */
  testConnection: {
    input: z.object({ profile: safeProfileSchema, secrets: transientSecretsSchema.optional() }),
    item: connectionCheckResultSchema,
  },
  /**
   * Starts (or joins) the connection host for a saved profile. `secrets` answers "ask every time"
   * secrets for this connection only.
   */
  openConnection: {
    input: z.object({ profileId: idSchema, secrets: transientSecretsSchema.optional() }),
    output: z.object({ connectionId: idSchema }),
    progress: taskProgressSchema,
  },
  closeConnection: { input: z.object({ connectionId: idSchema }), output: z.void() },
  history: {
    list: { input: historyListInputSchema, output: historyPageSchema },
    search: { input: historySearchInputSchema, output: historyPageSchema },
    /** Records a run. The renderer records it: it is the one that sees the results. */
    add: { input: historyAddInputSchema, output: historyEntrySchema },
  },
  settings: {
    get: { input: z.void(), output: appSettingsSchema },
    /** Merges a partial update and returns the full settings. */
    set: { input: appSettingsPatchSchema, output: appSettingsSchema },
  },
  app: {
    info: { input: z.void(), output: appInfoSchema },
  },
});

export type MainContract = typeof mainContract;
