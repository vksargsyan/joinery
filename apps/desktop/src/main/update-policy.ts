import { posix, win32 } from 'node:path';

import { updateChannelSchema, type UpdateChannel, type UpdatesOffReason } from '@joinery/ipc';
import { z } from 'zod';

/**
 * The rules of auto-update (spec §20), kept free of Electron and of I/O so each is unit-tested:
 * the administrator's policy switch for managed fleets, what kind of installation this is, the
 * update feed electron-builder baked into the build, and from those whether the updater may run
 * at all. `updates.ts` drives electron-updater with the outcome.
 */

/** Where releases are published (electron-builder.yml `publish`). */
export const RELEASES_PAGE = 'https://github.com/vksargsyan/joinery/releases';

/** Setting this to 1 (or true, yes, on) turns updates off for everyone on the machine. */
export const DISABLE_UPDATES_ENV = 'JOINERY_DISABLE_UPDATES';

/** What an administrator decided, merged from every source that exists. */
export interface UpdatePolicy {
  readonly disabled: boolean;
  /** A channel the user cannot change. */
  readonly channel?: UpdateChannel;
  /** The sources that decided something, for the log. */
  readonly sources: readonly string[];
}

/** One source's decisions. */
export interface PolicyLayer {
  readonly source: string;
  readonly disabled?: boolean;
  readonly channel?: UpdateChannel;
}

export const NO_POLICY: UpdatePolicy = { disabled: false, sources: [] };

const TRUE = /^(?:1|true|yes|on)$/i;

/** The environment variable: it can only turn updates off. */
export function policyFromEnv(env: Readonly<Record<string, string | undefined>>): PolicyLayer {
  const value = env[DISABLE_UPDATES_ENV]?.trim() ?? '';
  return TRUE.test(value) ? { source: DISABLE_UPDATES_ENV, disabled: true } : { source: 'env' };
}

/**
 * The JSON policy file: `{ "disableUpdates": true }` and/or `{ "updateChannel": "stable" }`.
 * Unknown keys are ignored. A file that exists but cannot be read as a policy turns updates off:
 * an administrator who wrote one meant to restrict something.
 */
export const policyFileSchema = z.looseObject({
  disableUpdates: z.boolean().optional(),
  updateChannel: updateChannelSchema.optional(),
});

export function parsePolicyFile(text: string, source: string): PolicyLayer {
  let parsed: z.infer<typeof policyFileSchema>;
  try {
    parsed = policyFileSchema.parse(JSON.parse(text));
  } catch {
    return { source: `${source} (unreadable)`, disabled: true };
  }
  return {
    source,
    ...(parsed.disableUpdates === undefined ? {} : { disabled: parsed.disableUpdates }),
    ...(parsed.updateChannel === undefined ? {} : { channel: parsed.updateChannel }),
  };
}

/**
 * `reg query HKLM\SOFTWARE\Policies\Joinery` output (Group Policy, Intune): a `DisableUpdates`
 * REG_DWORD (1 turns updates off) and an `UpdateChannel` REG_SZ (`stable` or `beta`).
 */
export function parseRegistryPolicy(output: string, source: string): PolicyLayer {
  const values = new Map<string, { type: string; data: string }>();
  for (const line of output.split(/\r?\n/)) {
    const match = /^\s+(\S+)\s+(REG_\w+)\s*(.*?)\s*$/.exec(line);
    if (match) values.set(match[1]!.toLowerCase(), { type: match[2]!, data: match[3]! });
  }
  const layer: { source: string; disabled?: boolean; channel?: UpdateChannel } = { source };
  const disable = values.get('disableupdates');
  if (disable) {
    const number = disable.type === 'REG_DWORD' ? Number.parseInt(disable.data, 16) : NaN;
    layer.disabled = Number.isNaN(number) ? TRUE.test(disable.data) : number !== 0;
  }
  const channel = updateChannelSchema.safeParse(values.get('updatechannel')?.data.toLowerCase());
  if (channel.success) layer.channel = channel.data;
  return layer;
}

/**
 * macOS managed preferences for `dev.joinery.desktop` (a configuration profile from an MDM),
 * converted to JSON: `DisableUpdates` (boolean) and `UpdateChannel` (string).
 */
export function parseManagedPreferences(value: unknown, source: string): PolicyLayer {
  const layer: { source: string; disabled?: boolean; channel?: UpdateChannel } = { source };
  if (typeof value !== 'object' || value === null) return { source, disabled: true };
  const record = value as Record<string, unknown>;
  if (typeof record['DisableUpdates'] === 'boolean') layer.disabled = record['DisableUpdates'];
  const channel = updateChannelSchema.safeParse(record['UpdateChannel']);
  if (channel.success) layer.channel = channel.data;
  return layer;
}

/**
 * Merges layers, strongest first: any layer can turn updates off (no layer turns them back on),
 * and the first layer that names a channel sets it.
 */
export function mergePolicies(layers: readonly PolicyLayer[]): UpdatePolicy {
  const decided = layers.filter((l) => l.disabled !== undefined || l.channel !== undefined);
  const channel = layers.find((l) => l.channel !== undefined)?.channel;
  return {
    disabled: layers.some((l) => l.disabled === true),
    ...(channel === undefined ? {} : { channel }),
    sources: decided.map((l) => l.source),
  };
}

/** Where a platform keeps machine-wide policy, and the system tool that reads it. */
export interface PolicyLocations {
  /** A JSON policy file (macOS, Linux). */
  readonly file?: string;
  /** The Group Policy key (Windows), read with `regExe`. */
  readonly registryKey?: string;
  readonly regExe?: string;
  /** The MDM preference domain's file (macOS). */
  readonly managedPreferences?: string;
}

/**
 * Where each platform keeps machine-wide policy; only administrators can write these. Windows
 * has no policy file: standard users may create folders under %ProgramData%, so a file there
 * would let one user switch updates off for everyone.
 */
export function policyLocations(
  platform: string,
  env: Readonly<Record<string, string | undefined>>,
): PolicyLocations {
  if (platform === 'win32') {
    return {
      registryKey: 'HKLM\\SOFTWARE\\Policies\\Joinery',
      // By full path: the PATH of the process does not pick the tool.
      regExe: win32.join(env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'reg.exe'),
    };
  }
  if (platform === 'darwin') {
    return {
      file: '/Library/Application Support/Joinery/policy.json',
      managedPreferences: '/Library/Managed Preferences/dev.joinery.desktop.plist',
    };
  }
  return { file: posix.join('/etc', 'joinery', 'policy.json') };
}

/** File and process access for reading the policy; undefined means "not there". */
export interface PolicyReaders {
  readFile(path: string): Promise<string | undefined>;
  /** Runs a system tool; undefined when it fails or exits non-zero. */
  run(file: string, args: readonly string[]): Promise<string | undefined>;
}

/**
 * Reads every policy source of the platform: the registry (Windows) or managed preferences
 * (macOS), then the policy file (macOS, Linux), then the environment variable.
 */
export async function readUpdatePolicy(options: {
  readonly platform: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly readers: PolicyReaders;
}): Promise<UpdatePolicy> {
  const { platform, env, readers } = options;
  const where = policyLocations(platform, env);
  const layers: PolicyLayer[] = [];
  if (where.registryKey !== undefined && where.regExe !== undefined) {
    // reg.exe exits non-zero when the key does not exist: no policy.
    const output = await readers.run(where.regExe, ['query', where.registryKey]);
    if (output !== undefined) layers.push(parseRegistryPolicy(output, where.registryKey));
  }
  if (where.managedPreferences !== undefined) {
    const plist = await readers.readFile(where.managedPreferences);
    if (plist !== undefined) {
      const json = await readers.run('/usr/bin/plutil', [
        '-convert',
        'json',
        '-o',
        '-',
        where.managedPreferences,
      ]);
      let value: unknown;
      try {
        value = json === undefined ? undefined : JSON.parse(json);
      } catch {
        value = undefined;
      }
      layers.push(parseManagedPreferences(value, where.managedPreferences));
    }
  }
  if (where.file !== undefined) {
    const file = await readers.readFile(where.file);
    if (file !== undefined) layers.push(parsePolicyFile(file, where.file));
  }
  layers.push(policyFromEnv(env));
  return mergePolicies(layers);
}

/**
 * How the app was installed, which decides whether and how it can replace itself: the NSIS
 * installer (not the MSI or the portable zip), a macOS app bundle, an AppImage, or a deb or
 * rpm package. `linux-other` and `windows-other` are unpacked folders, zips and MSI installs.
 */
export type InstallKind =
  'mac-app' | 'nsis' | 'windows-other' | 'appimage' | 'deb' | 'rpm' | 'linux-other';

export function detectInstallKind(input: {
  readonly platform: string;
  readonly execPath: string;
  readonly resourcesPath: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly exists: (path: string) => boolean;
  readonly readText: (path: string) => string | undefined;
}): InstallKind {
  if (input.platform === 'darwin') return 'mac-app';
  if (input.platform === 'win32') {
    // The NSIS installer puts its uninstaller next to the executable; the MSI and the zip do not.
    const exe = win32.basename(input.execPath, '.exe');
    const uninstaller = win32.join(win32.dirname(input.execPath), `Uninstall ${exe}.exe`);
    return input.exists(uninstaller) ? 'nsis' : 'windows-other';
  }
  // The AppImage runtime sets APPIMAGE; deb and rpm packages carry a package-type file.
  if (input.env['APPIMAGE']) return 'appimage';
  const type = input.readText(posix.join(input.resourcesPath, 'package-type'))?.trim();
  return type === 'deb' || type === 'rpm' ? type : 'linux-other';
}

/** The update feed electron-builder writes into `resources/app-update.yml`. */
export interface UpdateFeed {
  readonly owner: string;
  readonly repo: string;
  /** Code-signing publishers a Windows download must be signed by. */
  readonly publisherNames: readonly string[];
}

const feedSchema = z.looseObject({
  provider: z.literal('github'),
  owner: z.string().regex(/^[\w.-]+$/),
  repo: z.string().regex(/^[\w.-]+$/),
  publisherName: z.union([z.string(), z.array(z.string())]).optional(),
});

/** The feed from the parsed YAML, or undefined when it is not a GitHub feed this app knows. */
export function parseUpdateFeed(document: unknown): UpdateFeed | undefined {
  const parsed = feedSchema.safeParse(document);
  if (!parsed.success) return undefined;
  const { owner, repo, publisherName } = parsed.data;
  const names = publisherName === undefined ? [] : [publisherName].flat();
  return { owner, repo, publisherNames: names.filter((n) => n.trim() !== '') };
}

export type UpdateAvailability =
  { readonly enabled: true } | { readonly enabled: false; readonly reason: UpdatesOffReason };

/**
 * Whether the updater may run, in order: never in development; never against a policy; never
 * in a test build (only release builds carry an update feed); on Windows only when the feed
 * names the code-signing publisher, since electron-updater skips its Authenticode check
 * otherwise (macOS always checks the code signature, through Squirrel.Mac); and only for an
 * installation it knows how to replace.
 */
export function updateAvailability(input: {
  readonly packaged: boolean;
  readonly policy: UpdatePolicy;
  readonly feed: UpdateFeed | undefined;
  readonly platform: string;
  readonly install: InstallKind;
}): UpdateAvailability {
  if (!input.packaged) return { enabled: false, reason: 'development' };
  if (input.policy.disabled) return { enabled: false, reason: 'policy' };
  if (input.feed === undefined) return { enabled: false, reason: 'test-build' };
  if (input.platform === 'win32' && input.feed.publisherNames.length === 0) {
    return { enabled: false, reason: 'unsigned' };
  }
  const supported: readonly InstallKind[] = ['mac-app', 'nsis', 'appimage', 'deb', 'rpm'];
  if (!supported.includes(input.install)) return { enabled: false, reason: 'unsupported-install' };
  return { enabled: true };
}

/**
 * Whether a downloaded update also installs when the app quits. deb and rpm packages install
 * through the desktop's graphical sudo prompt, which should answer a click on "Restart now",
 * not appear unasked after the window has gone.
 */
export function installsOnQuit(install: InstallKind): boolean {
  return install !== 'deb' && install !== 'rpm';
}

/** The user's channel, unless the policy sets one. */
export function effectiveChannel(user: UpdateChannel, policy: UpdatePolicy): UpdateChannel {
  return policy.channel ?? user;
}

/**
 * electron-updater's options for a channel. Stable follows GitHub's latest release (never a
 * pre-release); beta takes the newest release of either kind. Leaving beta never downgrades:
 * the app stays on its beta until a newer stable version ships.
 */
export function updaterOptions(channel: UpdateChannel): {
  readonly channel: 'latest' | 'beta';
  readonly allowPrerelease: boolean;
} {
  return channel === 'beta'
    ? { channel: 'beta', allowPrerelease: true }
    : { channel: 'latest', allowPrerelease: false };
}

/**
 * Requests the updater's own session may make: https to GitHub, where the feed, the release
 * pages and the downloads (redirected to githubusercontent.com) live. Nothing else leaves.
 */
export function isAllowedUpdateUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const host = parsed.hostname.toLowerCase();
  return (
    parsed.protocol === 'https:' &&
    parsed.username === '' &&
    parsed.password === '' &&
    (host === 'github.com' ||
      host.endsWith('.github.com') ||
      host.endsWith('.githubusercontent.com'))
  );
}

/** The release page of a version. */
export function releaseNotesUrl(feed: UpdateFeed, version: string): string {
  return `https://github.com/${feed.owner}/${feed.repo}/releases/tag/v${encodeURIComponent(version)}`;
}
