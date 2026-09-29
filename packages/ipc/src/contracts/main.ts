import { z } from 'zod';

import { defineContract } from '../contract';
import { mongoMainContractShape } from './mongo';
import { syncMainContractShape } from './sync';
import { autosaveMainContractShape, gridViewsMainContractShape } from './workspace';
import { transferDbMainContractShape } from './transfer-db';
import {
  appInfoSchema,
  appSettingsPatchSchema,
  appSettingsSchema,
  connectionEventSchema,
  expectedVersionSchema,
  externalUrlSchema,
  folderSaveInputSchema,
  folderSchema,
  historyAddInputSchema,
  historyEntrySchema,
  historyListInputSchema,
  historyPageSchema,
  historySearchInputSchema,
  hostKeyAnswerSchema,
  hostKeyPromptEventSchema,
  inspectKeyInputSchema,
  openFileInputSchema,
  parsedConnectionUriSchema,
  parseUriInputSchema,
  privateKeyInfoSchema,
  safeProfileSchema,
  secretRefIdSchema,
  secretStatusSchema,
  secretValueSchema,
  storedProfileSchema,
  transientSecretsSchema,
} from '../schemas/app';
import { idSchema, taskProgressSchema } from '../schemas/common';
import { connectionCheckResultSchema } from '../schemas/driver';
import {
  autoMatchInputSchema,
  columnMappingSchema,
  jobEventSchema,
  jobInfoSchema,
  jobStartInputSchema,
  newTablePlanInputSchema,
  newTablePlanSchema,
  openDirectoryInputSchema,
  saveFileInputSchema,
  transferPreviewInputSchema,
  transferPreviewSchema,
  transferProfileSaveSchema,
  transferProfileSchema,
} from '../schemas/jobs';
import {
  cachedSnapshotInfoSchema,
  cachedSnapshotSchema,
  metadataGetInputSchema,
  metadataInvalidateInputSchema,
  metadataPutInputSchema,
  snippetListInputSchema,
  snippetSchema,
} from '../schemas/metadata';

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
    /**
     * Parses a pasted connection URI into a draft profile (spec §4), in main so the renderer and
     * joinery-cli share one parser. The URI's password stays out of the result.
     */
    parseUri: { input: parseUriInputSchema, output: parsedConnectionUriSchema },
    /**
     * Which of the profile's secrets have no usable value (ask-every-time, session secrets after
     * a restart, unreadable sealed values), so the renderer can prompt before `openConnection`.
     * Without `profileId` it only reports whether secrets can be saved on this machine.
     */
    secretStatus: {
      input: z.object({ profileId: idSchema.optional() }),
      output: secretStatusSchema,
    },
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
  /**
   * State changes of every connection host (connecting, ready, restarting after a crash,
   * failed, closed), for as long as the caller reads. Lets the renderer show a crashed host and
   * offer Reconnect even while none of its calls are running.
   */
  connectionEvents: { input: z.void(), item: connectionEventSchema },
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
    /** Opens an https link in the system browser, after main checks it (spec §18). */
    openExternal: { input: z.object({ url: externalUrlSchema }), output: z.void() },
  },
  dialogs: {
    /** A native open-file dialog (TLS CA, certificate and key paths); null when cancelled. */
    openFile: { input: openFileInputSchema, output: z.object({ path: z.string().nullable() }) },
    /**
     * A native save dialog; null when cancelled. Jobs write only to paths picked here (or into
     * a folder picked with `openDirectory`), and read only files picked with `openFile`.
     */
    saveFile: { input: saveFileInputSchema, output: z.object({ path: z.string().nullable() }) },
    /** A native folder picker, for exports with one file per table; null when cancelled. */
    openDirectory: {
      input: openDirectoryInputSchema,
      output: z.object({ path: z.string().nullable() }),
    },
  },
  /**
   * Long jobs in the job runner process (spec §3, §12, §14): import, export and Run SQL File.
   * Main resolves the profile's secrets and hands them to the job runner only; the renderer
   * sees progress, summaries and logs.
   */
  jobs: {
    /**
     * Starts a job. Fails with READ_ONLY for an import on a read-only profile, and with
     * CONFIRMATION_REQUIRED when a write the profile or mode asks about was not confirmed.
     */
    start: { input: jobStartInputSchema, output: z.object({ jobId: idSchema }) },
    /** Cancels a running job; an import rolls back. Unknown or finished ids are ignored. */
    cancel: { input: z.object({ jobId: idSchema }), output: z.void() },
    /** Running jobs, then the job history, newest first. */
    list: { input: z.void(), output: z.array(jobInfoSchema) },
    /** Every job's changes and progress, for as long as the caller reads. */
    events: { input: z.void(), item: jobEventSchema },
    /** Forgets the finished jobs. */
    clear: { input: z.void(), output: z.void() },
  },
  /** What the import and export wizards ask of the job runner before a job starts (spec §12). */
  transfer: {
    /** Reads the start of a file: format, encoding, CSV dialect, header, sample rows, types. */
    preview: { input: transferPreviewInputSchema, output: transferPreviewSchema },
    /** Pairs file columns with table columns by name. */
    autoMatch: { input: autoMatchInputSchema, output: z.array(columnMappingSchema) },
    /** Columns and CREATE TABLE script for importing a file into a new table. */
    planTable: { input: newTablePlanInputSchema, output: newTablePlanSchema },
    /** Saved wizard settings (spec §12: every wizard can save its settings as a profile). */
    profiles: {
      list: { input: z.void(), output: z.array(transferProfileSchema) },
      save: { input: transferProfileSaveSchema, output: transferProfileSchema },
      delete: { input: byId, output: z.void() },
    },
  },
  hostKeys: {
    /**
     * Host key questions from connection hosts (spec §4), for as long as the caller reads: the
     * open ones first, then each one that opens or closes. A question nobody answers in time, or
     * one asked while no window reads, counts as cancelled and the connection is refused.
     */
    prompts: { input: z.void(), item: hostKeyPromptEventSchema },
    /** Answers an open question; unknown or closed ids are ignored. */
    answer: {
      input: z.object({ promptId: idSchema, answer: hostKeyAnswerSchema }),
      output: z.void(),
    },
  },
  ssh: {
    /**
     * Reads and checks an SSH private key file in main (never in the renderer): its format, type
     * and fingerprint, and whether it needs a passphrase. A wrong passphrase fails with
     * VALIDATION_FAILED. A PuTTY key is converted to PEM on import and saved with owner-only
     * permissions; `keyPath` then names the converted copy.
     */
    inspectKey: { input: inspectKeyInputSchema, output: privateKeyInfoSchema },
  },
  /**
   * The per-connection metadata cache in the local store (spec §5): schema snapshots the renderer
   * introspected through a connection host, kept so autocomplete works as soon as a connection
   * opens, before the background refresh finishes. One snapshot per (profile, database).
   */
  metadata: {
    /** Cached snapshots of a profile, ordered by database; unknown databases are left out. */
    get: { input: metadataGetInputSchema, output: z.array(cachedSnapshotSchema) },
    /** Stores (or replaces) a snapshot. Fails with NOT_FOUND for an unknown profile. */
    put: { input: metadataPutInputSchema, output: cachedSnapshotInfoSchema },
    /** Drops one database's snapshot, or all of the profile's; returns how many were dropped. */
    invalidate: {
      input: metadataInvalidateInputSchema,
      output: z.object({ dropped: z.number().int().nonnegative() }),
    },
  },
  snippets: {
    /** The snippet library (spec §6), ordered by name; with `engine`, those that apply to it. */
    list: { input: snippetListInputSchema, output: z.array(snippetSchema) },
  },
  /** MongoDB GridFS files moved by path through the window's file grants (spec §9). */
  mongo: mongoMainContractShape,
  /** Structure sync and data sync between two SQL connections (spec §13). */
  sync: syncMainContractShape,
  /** Saved table views (spec §7): column layout, sort and filter per profile and table. */
  gridViews: gridViewsMainContractShape,
  /** Editor autosave for crash restore (spec §18). */
  autosave: autosaveMainContractShape,
  /** The data transfer wizard's questions before a transfer job starts (spec §12). */
  transferDb: transferDbMainContractShape,
});

export type MainContract = typeof mainContract;
