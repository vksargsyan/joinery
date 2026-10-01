import { z } from 'zod';

/**
 * Auto-update status (spec §20, "Packaging and updates"): what main's updater is doing, for the
 * About box and the "update ready" notice. The renderer only reads it and asks for a check or a
 * restart; the updater itself (electron-updater, with its signature checks) runs in main.
 */

export const updateChannelSchema = z.enum(['stable', 'beta']);
export type UpdateChannel = z.infer<typeof updateChannelSchema>;

/**
 * Why updates are off: a development run; a test build, which carries no update feed; an
 * administrator's policy; a Windows build without a code-signing publisher to check downloads
 * against; or an installation the updater cannot replace (MSI, zip, an unpacked folder).
 */
export const updatesOffReasonSchema = z.enum([
  'development',
  'test-build',
  'policy',
  'unsigned',
  'unsupported-install',
]);
export type UpdatesOffReason = z.infer<typeof updatesOffReasonSchema>;

const versionSchema = z.string().min(1).max(100);

export const updateStateSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('off'), reason: updatesOffReasonSchema }),
  /** On, and no check has run yet. */
  z.object({ state: z.literal('idle') }),
  z.object({ state: z.literal('checking') }),
  z.object({ state: z.literal('up-to-date') }),
  /** A newer version was found and is downloading in the background. */
  z.object({
    state: z.literal('downloading'),
    version: versionSchema,
    percent: z.number().min(0).max(100),
  }),
  /**
   * Downloaded and verified: it installs on restart, and also when the app next quits unless
   * installing needs an administrator's password (deb and rpm packages).
   */
  z.object({ state: z.literal('ready'), version: versionSchema, installsOnQuit: z.boolean() }),
  z.object({ state: z.literal('error'), message: z.string().max(500) }),
]);
export type UpdateState = z.infer<typeof updateStateSchema>;

export const updateStatusSchema = z.object({
  currentVersion: versionSchema,
  /** The channel in use: the user's choice, unless a policy sets it. */
  channel: updateChannelSchema,
  /** Checks run on their own, at start-up and every few hours. */
  autoCheck: z.boolean(),
  /** What an administrator's policy decided (the settings it covers cannot be changed). */
  managed: z.object({ disabled: z.boolean(), channel: z.boolean() }),
  state: updateStateSchema,
  /** The release notes of the version downloading or ready, or of this one. */
  releaseNotesUrl: z
    .url({ protocol: /^https$/ })
    .max(2048)
    .optional(),
  lastCheckedAt: z.iso.datetime({ offset: true }).optional(),
  /**
   * Counts the checks a user asked for (menu or About box). A page shows the outcome of a
   * check, "up to date" included, only when this moved: background checks stay quiet.
   */
  requestId: z.number().int().nonnegative(),
});
export type UpdateStatus = z.infer<typeof updateStatusSchema>;

/** Commands from main: the menu's About, and the window entering or leaving full screen. */
export const appCommandSchema = z.object({
  command: z.enum([
    'about',
    'enter-full-screen',
    'leave-full-screen',
    'command-palette',
    'quick-open',
    'keyboard-shortcuts',
  ]),
});
export type AppCommand = z.infer<typeof appCommandSchema>;

/**
 * What the window's own menu bar (Windows and Linux, where the native one hides with the title
 * bar) asks main to do: the Edit, View and Window roles, quitting, and the Help items.
 */
export const windowMenuCommandSchema = z.enum([
  'undo',
  'redo',
  'cut',
  'copy',
  'paste',
  'selectAll',
  'reload',
  'toggleDevTools',
  'resetZoom',
  'zoomIn',
  'zoomOut',
  'toggleFullScreen',
  'minimize',
  'close',
  'quit',
  'checkForUpdates',
  'releaseNotes',
]);
export type WindowMenuCommand = z.infer<typeof windowMenuCommandSchema>;
