import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { QuerybaraError } from '@querybara/core';
import type {
  AppCommand,
  AppSettings,
  HandlersOf,
  UpdateChannel,
  UpdateState,
  UpdateStatus,
  mainContract,
} from '@querybara/ipc';
import type { AppUpdater, Logger } from 'electron-updater';

import {
  detectInstallKind,
  effectiveChannel,
  installsOnQuit,
  NO_POLICY,
  parseUpdateFeed,
  readUpdatePolicy,
  releaseNotesUrl,
  updateAvailability,
  updaterOptions,
  type InstallKind,
  type UpdateAvailability,
  type UpdateFeed,
  type UpdatePolicy,
} from './update-policy';

/**
 * Auto-update (spec §20) through electron-updater: stable and beta channels, staged rollout
 * (the `stagingPercentage` of each release's metadata, which electron-updater honours), and the
 * policy switch of update-policy.ts. Updates download in the background and install on restart
 * or quit; the page shows a "ready, restart" notice. electron-updater verifies each download:
 * its SHA-512 from the release metadata everywhere, the Authenticode publisher on Windows, and
 * Squirrel.Mac the code signature on macOS.
 *
 * `UpdateController` has no Electron or network code of its own: it drives an `UpdaterPort`,
 * which `electronUpdater()` implements over electron-updater and the tests fake.
 */

/** What the controller needs from an updater. */
export interface UpdaterPort {
  configure(options: {
    readonly channel: 'latest' | 'beta';
    readonly allowPrerelease: boolean;
  }): void;
  /** Checks, and downloads what it finds; outcomes arrive as events. */
  check(): Promise<void>;
  quitAndInstall(): void;
}

/** The updater's events, as the controller consumes them. */
export interface UpdaterEvents {
  checking(): void;
  available(version: string): void;
  notAvailable(): void;
  progress(percent: number): void;
  downloaded(version: string): void;
  error(error: unknown): void;
}

/** What start-up found out: whether updates may run, the policy, the feed, the installation. */
export interface UpdateEnvironment {
  readonly availability: UpdateAvailability;
  readonly policy: UpdatePolicy;
  readonly feed?: UpdateFeed;
  readonly install: InstallKind;
}

export type UpdaterFactory = (
  events: UpdaterEvents,
  environment: UpdateEnvironment,
) => Promise<UpdaterPort>;

export type UpdateSettings = Pick<AppSettings, 'updateChannel' | 'updateAutoCheck'>;

export interface UpdateControllerOptions {
  readonly currentVersion: string;
  readonly settings: UpdateSettings;
  /** Resolved once at start-up (policy files, the feed); checks wait for it. */
  readonly environment: UpdateEnvironment | Promise<UpdateEnvironment>;
  readonly createUpdater: UpdaterFactory;
  /** First automatic check after start-up (default 30 s: start-up comes first). */
  readonly firstCheckDelayMs?: number;
  /** Between automatic checks (default 4 hours). */
  readonly checkIntervalMs?: number;
  readonly now?: () => Date;
  readonly log?: (message: string) => void;
  /** Called just before the app quits to install a downloaded update. */
  readonly beforeInstall?: () => void;
}

/** The page-facing side of the updater, as the main contract's handlers use it. */
export interface UpdatesService {
  status(): UpdateStatus;
  subscribe(listener: (status: UpdateStatus) => void): () => void;
  check(): Promise<void>;
  install(): void;
}

/**
 * One line of an updater error, without stacks or feed dumps. A repository with no production
 * release yet is not a failure: electron-updater's GitHub provider reports it as
 * ERR_UPDATER_LATEST_VERSION_NOT_FOUND, but wraps that in ERR_UPDATER_INVALID_RELEASE_FEED
 * ("Cannot parse releases feed: Error: Unable to find latest version on GitHub...") when it
 * happens while reading the feed, so the message is checked too.
 */
export function updateErrorMessage(error: unknown): string {
  const code =
    typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : '';
  const message = error instanceof Error ? error.message : String(error);
  if (
    code === 'ERR_UPDATER_LATEST_VERSION_NOT_FOUND' ||
    code === 'ERR_UPDATER_NO_PUBLISHED_VERSIONS' ||
    message.startsWith('No published versions') ||
    message.includes('Unable to find latest version on GitHub')
  ) {
    return 'No release was found on the update server';
  }
  if (code === 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND') {
    return 'The latest release has no update for this platform yet';
  }
  const line = message.split('\n')[0]?.trim() ?? '';
  return (line === '' ? 'The update check failed' : line).slice(0, 300);
}

export class UpdateController implements UpdatesService {
  readonly #options: UpdateControllerOptions;
  readonly #listeners = new Set<(status: UpdateStatus) => void>();
  #environment: UpdateEnvironment | undefined;
  #state: UpdateState = { state: 'idle' };
  #settings: UpdateSettings;
  #requestId = 0;
  #lastCheckedAt: string | undefined;
  #version: string | undefined;
  #updater: Promise<UpdaterPort> | undefined;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #disposed = false;

  constructor(options: UpdateControllerOptions) {
    this.#options = options;
    this.#settings = options.settings;
  }

  /** Resolves the environment, then schedules the first automatic check if it may run. */
  async start(): Promise<void> {
    const environment = await this.#resolve();
    const { availability, policy } = environment;
    const sources = policy.sources.length > 0 ? ` (policy: ${policy.sources.join(', ')})` : '';
    this.#log(
      availability.enabled
        ? `on, ${this.#channel()} channel${sources}`
        : `off: ${availability.reason}${sources}`,
    );
    this.#set(
      availability.enabled ? { state: 'idle' } : { state: 'off', reason: availability.reason },
    );
    this.#schedule(this.#options.firstCheckDelayMs ?? 30_000);
  }

  status(): UpdateStatus {
    const policy = this.#environment?.policy ?? NO_POLICY;
    const feed = this.#environment?.feed;
    const notesFor =
      this.#state.state === 'downloading' || this.#state.state === 'ready'
        ? this.#state.version
        : this.#options.currentVersion;
    return {
      currentVersion: this.#options.currentVersion,
      channel: this.#channel(),
      autoCheck: this.#settings.updateAutoCheck,
      managed: { disabled: policy.disabled, channel: policy.channel !== undefined },
      state: this.#state,
      ...(feed === undefined ? {} : { releaseNotesUrl: releaseNotesUrl(feed, notesFor) }),
      ...(this.#lastCheckedAt === undefined ? {} : { lastCheckedAt: this.#lastCheckedAt }),
      requestId: this.#requestId,
    };
  }

  subscribe(listener: (status: UpdateStatus) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** A check the user asked for: its outcome is shown even when there is nothing new. */
  async check(): Promise<void> {
    this.#requestId++;
    await this.#check();
    // Answered with the current state when no check ran (off, busy, ready).
    this.#emit();
  }

  /** Takes a settings change: a new channel reconfigures the updater, auto-check re-plans. */
  applySettings(settings: UpdateSettings): void {
    const before = this.#channel();
    const wasAuto = this.#settings.updateAutoCheck;
    this.#settings = settings;
    if (this.#channel() !== before && this.#updater) {
      const channel = this.#channel();
      void this.#updater.then((updater) => updater.configure(updaterOptions(channel)));
    }
    if (settings.updateAutoCheck && !wasAuto) {
      this.#schedule(this.#options.firstCheckDelayMs ?? 30_000);
    }
    if (!settings.updateAutoCheck) this.#clearTimer();
    this.#emit();
  }

  install(): void {
    if (this.#state.state !== 'ready' || !this.#updater) {
      throw new QuerybaraError({ code: 'NOT_FOUND', message: 'No update is ready to install' });
    }
    this.#options.beforeInstall?.();
    void this.#updater.then((updater) => updater.quitAndInstall());
  }

  dispose(): void {
    this.#disposed = true;
    this.#clearTimer();
    this.#listeners.clear();
  }

  async #resolve(): Promise<UpdateEnvironment> {
    this.#environment ??= await this.#options.environment;
    return this.#environment;
  }

  #channel(): UpdateChannel {
    return effectiveChannel(this.#settings.updateChannel, this.#environment?.policy ?? NO_POLICY);
  }

  async #check(): Promise<void> {
    const { availability } = await this.#resolve();
    const busy = ['checking', 'downloading', 'ready'].includes(this.#state.state);
    if (!availability.enabled || busy || this.#disposed) return;
    this.#clearTimer();
    this.#set({ state: 'checking' });
    try {
      const updater = await this.#port(await this.#resolve());
      updater.configure(updaterOptions(this.#channel()));
      await updater.check();
      // Without an event (an updater that stays quiet), there was nothing new.
      if (this.#state.state === 'checking') this.#set({ state: 'up-to-date' });
    } catch (error) {
      this.#failed(error);
    } finally {
      this.#lastCheckedAt = (this.#options.now?.() ?? new Date()).toISOString();
      this.#emit();
      this.#schedule(this.#options.checkIntervalMs ?? 4 * 60 * 60 * 1000);
    }
  }

  #port(environment: UpdateEnvironment): Promise<UpdaterPort> {
    this.#updater ??= this.#options.createUpdater(
      {
        checking: () => {
          if (this.#state.state !== 'downloading') this.#set({ state: 'checking' });
        },
        available: (version) => {
          this.#version = version;
          this.#set({ state: 'downloading', version, percent: 0 });
        },
        notAvailable: () => this.#set({ state: 'up-to-date' }),
        progress: (percent) => {
          const version = this.#version;
          if (version === undefined || this.#state.state !== 'downloading') return;
          this.#set({
            state: 'downloading',
            version,
            percent: Math.min(100, Math.max(0, percent)),
          });
        },
        downloaded: (version) => {
          this.#log(`version ${version} is ready to install`);
          this.#set({
            state: 'ready',
            version,
            installsOnQuit: installsOnQuit(environment.install),
          });
        },
        error: (error) => this.#failed(error),
      },
      environment,
    );
    return this.#updater;
  }

  #failed(error: unknown): void {
    if (this.#state.state === 'ready') return;
    const message = updateErrorMessage(error);
    this.#log(`check failed: ${message}`);
    this.#set({ state: 'error', message });
    // A download that fails after its check finished still gets its next check.
    this.#schedule(this.#options.checkIntervalMs ?? 4 * 60 * 60 * 1000);
  }

  #schedule(delayMs: number): void {
    this.#clearTimer();
    const enabled = this.#environment?.availability.enabled === true;
    if (!enabled || !this.#settings.updateAutoCheck || this.#disposed) return;
    if (this.#state.state === 'ready') return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      void this.#check();
    }, delayMs);
    this.#timer.unref?.();
  }

  #clearTimer(): void {
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  #set(state: UpdateState): void {
    this.#state = state;
    this.#emit();
  }

  #emit(): void {
    const status = this.status();
    for (const listener of this.#listeners) listener(status);
  }

  #log(message: string): void {
    this.#options.log?.(message);
  }
}

/**
 * Points an electron-updater instance at a channel (`updaterOptions`). Setting its `channel`
 * also allows downgrades, which this turns off again: leaving beta must not install an older
 * stable version.
 */
export function configureChannel(
  updater: Pick<AppUpdater, 'channel' | 'allowPrerelease' | 'allowDowngrade'>,
  options: { readonly channel: 'latest' | 'beta'; readonly allowPrerelease: boolean },
): void {
  updater.channel = options.channel;
  updater.allowPrerelease = options.allowPrerelease;
  updater.allowDowngrade = false;
}

/**
 * An `UpdaterPort` over electron-updater, loaded on first use (start-up does not pay for it).
 * The updater class follows the installation kind that `detectInstallKind` found: NSIS on
 * Windows, Squirrel.Mac on macOS, and the AppImage, deb or rpm updater on Linux.
 */
export function electronUpdater(logger: Logger): UpdaterFactory {
  return async (events, { install }) => {
    const updaters = await import('electron-updater');
    const updater: AppUpdater =
      install === 'nsis'
        ? new updaters.NsisUpdater()
        : install === 'mac-app'
          ? new updaters.MacUpdater()
          : install === 'deb'
            ? new updaters.DebUpdater()
            : install === 'rpm'
              ? new updaters.RpmUpdater()
              : new updaters.AppImageUpdater();
    updater.logger = logger;
    updater.autoDownload = true;
    updater.autoInstallOnAppQuit = installsOnQuit(install);
    updater.on('checking-for-update', () => events.checking());
    updater.on('update-available', (info) => events.available(info.version));
    updater.on('update-not-available', () => events.notAvailable());
    updater.on('download-progress', (progress) => events.progress(progress.percent));
    updater.on('update-downloaded', (info) => events.downloaded(info.version));
    updater.on('error', (error) => events.error(error));
    return {
      configure: (options) => configureChannel(updater, options),
      check: async () => {
        const result = await updater.checkForUpdates();
        // The download runs on; its outcome arrives as events.
        void result?.downloadPromise?.catch(() => undefined);
      },
      // Silent install, then start the new version.
      quitAndInstall: () => updater.quitAndInstall(true, true),
    };
  };
}

/** Where the process runs, as start-up reads it (Electron's app and process globals). */
export interface UpdateHost {
  readonly packaged: boolean;
  readonly version: string;
  readonly platform: NodeJS.Platform;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly execPath: string;
  readonly resourcesPath: string;
}

/**
 * Finds out whether updates may run here: the policy, the installation and the feed baked into
 * the build (`resources/app-update.yml`, which only release builds carry).
 */
export async function readUpdateEnvironment(host: UpdateHost): Promise<UpdateEnvironment> {
  const policy = await readUpdatePolicy({
    platform: host.platform,
    env: host.env,
    readers: {
      readFile: (path) => readFile(path, 'utf8').catch(() => undefined),
      run: (file, args) =>
        new Promise((resolve) => {
          execFile(file, [...args], { timeout: 10_000, windowsHide: true }, (error, stdout) =>
            resolve(error ? undefined : stdout),
          );
        }),
    },
  });
  let feed: UpdateFeed | undefined;
  const feedText = host.packaged
    ? await readFile(join(host.resourcesPath, 'app-update.yml'), 'utf8').catch(() => undefined)
    : undefined;
  if (feedText !== undefined) {
    const { load } = await import('js-yaml');
    try {
      feed = parseUpdateFeed(load(feedText));
    } catch {
      feed = undefined;
    }
  }
  const install = detectInstallKind({
    platform: host.platform,
    execPath: host.execPath,
    resourcesPath: host.resourcesPath,
    env: host.env,
    exists: existsSync,
    readText: (path) => {
      try {
        return readFileSync(path, 'utf8');
      } catch {
        return undefined;
      }
    },
  });
  const availability = updateAvailability({
    packaged: host.packaged,
    policy,
    feed,
    platform: host.platform,
    install,
  });
  return { availability, policy, install, ...(feed === undefined ? {} : { feed }) };
}

/**
 * The app's updater: reads the environment in the background and uses electron-updater, which
 * logs only its warnings and errors.
 */
export function createUpdates(options: {
  readonly host: UpdateHost;
  readonly settings: UpdateSettings;
  readonly log: (message: string) => void;
  readonly beforeInstall?: () => void;
}): UpdateController {
  const quiet = (): void => undefined;
  return new UpdateController({
    currentVersion: options.host.version,
    settings: options.settings,
    // Reading the environment never fails the app: an error leaves updates off.
    environment: readUpdateEnvironment(options.host).catch((error: unknown) => {
      options.log(`cannot tell whether updates may run: ${updateErrorMessage(error)}`);
      return {
        availability: { enabled: false, reason: 'unsupported-install' },
        policy: NO_POLICY,
        install: 'linux-other',
      } satisfies UpdateEnvironment;
    }),
    createUpdater: electronUpdater({
      info: quiet,
      warn: (message: unknown) => options.log(`updater: ${String(message)}`),
      error: (message: unknown) => options.log(`updater: ${updateErrorMessage(message)}`),
    }),
    log: options.log,
    ...(options.beforeInstall !== undefined ? { beforeInstall: options.beforeInstall } : {}),
  });
}

/** Relays menu commands (About...) to every window that listens. */
export class AppCommands {
  readonly #listeners = new Set<(command: AppCommand) => void>();

  send(command: AppCommand['command']): void {
    for (const listener of this.#listeners) listener({ command });
  }

  subscribe(listener: (command: AppCommand) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
}

/**
 * Turns a subscription into a stream for the main contract: `initial` first, then each value,
 * until the caller stops.
 */
export async function* subscriptionStream<T>(
  subscribe: (listener: (value: T) => void) => () => void,
  signal: AbortSignal,
  initial: readonly T[] = [],
): AsyncGenerator<T> {
  const queue: T[] = [...initial];
  let wake: (() => void) | undefined;
  const unsubscribe = subscribe((value) => {
    queue.push(value);
    wake?.();
  });
  const onAbort = (): void => wake?.();
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    while (!signal.aborted) {
      const next = queue.shift();
      if (next !== undefined) {
        yield next;
        continue;
      }
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
      wake = undefined;
    }
  } finally {
    unsubscribe();
    signal.removeEventListener('abort', onAbort);
  }
}

/** The status when no updater runs at all (tests, a window without the service). */
function offStatus(currentVersion: string): UpdateStatus {
  return {
    currentVersion,
    channel: 'stable',
    autoCheck: false,
    managed: { disabled: false, channel: false },
    state: { state: 'off', reason: 'development' },
    requestId: 0,
  };
}

/** The main contract's `updates.*` handlers. */
export function updateHandlers(
  service: UpdatesService | undefined,
  currentVersion: () => string,
): HandlersOf<typeof mainContract>['updates'] {
  return {
    status: (_input, { signal }) =>
      service
        ? subscriptionStream((listener) => service.subscribe(listener), signal, [service.status()])
        : subscriptionStream<UpdateStatus>(() => () => undefined, signal, [
            offStatus(currentVersion()),
          ]),
    check: async () => {
      await service?.check();
    },
    install: () => {
      if (!service) {
        throw new QuerybaraError({ code: 'NOT_FOUND', message: 'No update is ready to install' });
      }
      service.install();
    },
  };
}
