import {
  JoineryError,
  connectionProfileSchema,
  newId,
  secretRefsOf,
  type ConnectionProfile,
} from '@joinery/core';
import {
  DEFAULT_APP_SETTINGS,
  appSettingsPatchSchema,
  appSettingsSchema,
  type WindowMenuCommand,
  type AppCommand,
  type AppInfo,
  type AppSettings,
  type AppSettingsPatch,
  type ConnectionEvent,
  type HandlersOf,
  type HostKeyPromptEvent,
  type mainContract,
} from '@joinery/ipc';
import {
  parseConnectionUri,
  type PreviousRun,
  type Store,
  type StoredProfile,
} from '@joinery/storage';

import type { PortPayload } from '../shared/bridge';
import { runConnectionCheck } from './checker';
import { hostKeyPromptEvents, type HostKeyBroker } from './host-keys';
import type { HostProcessFactory } from './host-process';
import type { JobManager } from './jobs';
import { FileGrants, fileDialogHandlers, jobHandlers, type FileDialogs } from './jobs-api';
import { resolveProfile } from './secrets';
import { erModelHandlers } from './er-models';
import type { MenuCommands } from './menu';
import { scheduleHandlers, type ScheduleEvents } from './schedules-api';
import type { Scheduler } from './scheduler';
import { metadataHandlers, snippetHandlers } from './metadata';
import { mongoMainHandlers } from './mongo-api';
import { transferDbHandlers } from './transfer-db-api';
import { backupMainHandlers } from './backup-api';
import { redisDumpHandlers } from './redis-dump-api';
import { isSafeExternalUrl } from './security';
import type { ConnectionSupervisor } from './supervisor';
import type { SyncService } from './sync';
import { syncHandlers } from './sync-api';
import { autosaveHandlers, gridViewHandlers } from './workspace-api';
import { subscriptionStream, updateHandlers, type UpdatesService } from './updates';

/**
 * The main contract's handlers (spec §3): profiles, folders, secrets, connections, history,
 * settings. The server validates every request and response against the contract; the rules
 * here are about what may cross at all. Secrets flow in only: `secrets.set` and the `secrets`
 * of a single call go into the SecretStore or straight to a connection host, and no handler
 * returns one.
 */

export interface OpenFileOptions {
  readonly title?: string | undefined;
  readonly filters?: readonly { readonly name: string; readonly extensions: readonly string[] }[];
}

/** What the handlers need from the app, shared by every window. */
export interface MainServices<P> {
  readonly store: Store;
  readonly supervisor: ConnectionSupervisor<P>;
  /** Starts connection host processes (used directly for Test Connection). */
  readonly spawnHost: HostProcessFactory<P>;
  /** A new MessageChannelMain: `local` goes to a host, `remote` to the renderer. */
  readonly createChannel: () => { readonly local: P; readonly remote: P };
  readonly appInfo: () => AppInfo;
  /** Opens a URL already checked by `isSafeExternalUrl` in the system browser. */
  readonly openExternal: (url: string) => Promise<void>;
  /** Settings used when none are stored. */
  readonly defaultSettings?: AppSettings;
  /**
   * Asks the user about SSH host keys and keeps the known-hosts file. Without it (tests), no
   * question is ever asked and every unknown host key is refused.
   */
  readonly hostKeys?: HostKeyBroker;
  /** Where PuTTY keys converted on import are saved (owner-only); `<userData>/ssh-keys`. */
  readonly keysDir?: string;
  /** Runs import, export and SQL file jobs in the job runner; without it jobs are refused. */
  readonly jobs?: JobManager;
  /** Structure and data compare on the job runner (spec §13); without it they are refused. */
  readonly sync?: SyncService;
  /** Runs scheduled jobs while Joinery is open; absent in tests that do not need it. */
  readonly scheduler?: Scheduler;
  readonly scheduleEvents?: ScheduleEvents;
  /** How the app's previous run ended (`unclean` after a crash), for editor restore. */
  readonly previousRun?: PreviousRun['ended'];
  /** Auto-update (spec §20); without it the status reports updates off. */
  readonly updates?: UpdatesService;
  /** Check for Updates and Release Notes, shared by the native and the window menus. */
  readonly menuCommands?: Pick<MenuCommands, 'checkForUpdates' | 'releaseNotes'>;
  /** A development run: the window menu may reload and open the developer tools. */
  readonly development?: boolean;
  /** Commands from the application menu for the page (About). */
  readonly appCommands?: {
    subscribe(listener: (command: AppCommand) => void): () => void;
  };
  /** Told the full settings after every change (the updater follows its channel). */
  readonly onSettingsChanged?: (settings: AppSettings) => void;
}

/** What differs per window: where its ports go and which window owns its dialogs. */
export interface WindowServices<P> extends FileDialogs {
  readonly sendPort: (payload: PortPayload, port: P) => void;
  readonly openFile: (options: OpenFileOptions) => Promise<string | null>;
  /** Runs a window menu item on this window (Edit, View and Window roles, quitting). */
  readonly runMenu?: (command: WindowMenuCommand) => void;
}

const SETTINGS_KEY = 'app';

function notFound(what: string, id: string): JoineryError {
  return new JoineryError({ code: 'NOT_FOUND', message: `${what} ${id} was not found` });
}

function mergeSettings(base: AppSettings, patch: AppSettingsPatch): AppSettings {
  return {
    ...base,
    ...stripUndefined({
      theme: patch.theme,
      locale: patch.locale,
      telemetry: patch.telemetry,
      updateChannel: patch.updateChannel,
      updateAutoCheck: patch.updateAutoCheck,
    }),
    editor: { ...base.editor, ...stripUndefined(patch.editor ?? {}) },
    results: { ...base.results, ...stripUndefined(patch.results ?? {}) },
    connections: { ...base.connections, ...stripUndefined(patch.connections ?? {}) },
    schedules: { ...base.schedules, ...stripUndefined(patch.schedules ?? {}) },
    // A list is replaced whole: removing an override must be possible.
    keybindings:
      patch.keybindings === undefined
        ? base.keybindings
        : (patch.keybindings as AppSettings['keybindings']),
  };
}

function stripUndefined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;
}

/** The stored settings over the defaults, so settings added later get their default. */
export function readAppSettings(
  store: Pick<Store, 'settings'>,
  defaults: AppSettings,
): AppSettings {
  const stored = store.settings.get(SETTINGS_KEY, appSettingsPatchSchema);
  if (stored === undefined) return defaults;
  const merged = appSettingsSchema.safeParse(mergeSettings(defaults, stored));
  return merged.success ? merged.data : defaults;
}

/** Saves a change to the settings over what is stored; returns the settings now in force. */
export function writeAppSettings(
  store: Pick<Store, 'settings'>,
  defaults: AppSettings,
  patch: AppSettingsPatch,
): AppSettings {
  const next = appSettingsSchema.parse(mergeSettings(readAppSettings(store, defaults), patch));
  store.settings.set(SETTINGS_KEY, next);
  return next;
}

export function createMainHandlers<P>(
  services: MainServices<P>,
  window: WindowServices<P>,
): HandlersOf<typeof mainContract> {
  const { store, supervisor } = services;
  const defaults = services.defaultSettings ?? DEFAULT_APP_SETTINGS;
  const files = new FileGrants();

  const requireProfile = (id: string): StoredProfile => {
    const profile = store.profiles.get(id);
    if (!profile) throw notFound('Profile', id);
    return profile;
  };

  const readSettings = (): AppSettings => readAppSettings(store, defaults);

  return {
    profiles: {
      list: () => store.profiles.list(),
      get: ({ id }) => requireProfile(id),
      save: ({ profile, expectedVersion }) =>
        store.profiles.save(profile, expectedVersion === undefined ? {} : { expectedVersion }),
      delete: ({ id }) => {
        supervisor.closeProfile(id);
        store.profiles.delete(id);
      },
      parseUri: ({ uri, engine }) => {
        const parsed = parseConnectionUri(uri, engine === undefined ? {} : { engine });
        const now = new Date().toISOString();
        const profile = connectionProfileSchema.parse({
          ...parsed.profile,
          id: newId(),
          createdAt: now,
          updatedAt: now,
        });
        return {
          profile,
          passwordFound: parsed.password !== undefined,
          ignoredParams: [...parsed.ignoredParams],
        };
      },
      secretStatus: ({ profileId }) => {
        const canSave = store.secrets.canSave();
        if (profileId === undefined) return { canSave, missing: [] };
        const profile = requireProfile(profileId);
        const resolved = store.secrets.resolve(profile);
        const unreadable = new Set(resolved.unreadable.map((ref) => ref.id));
        const labels = secretLabels(profile);
        return {
          canSave,
          missing: resolved.missing.map((ref) => ({
            refId: ref.id,
            policy: ref.policy,
            unreadable: unreadable.has(ref.id),
            ...(labels.has(ref.id) ? { label: labels.get(ref.id)!.slice(0, 300) } : {}),
          })),
        };
      },
    },

    folders: {
      list: () => store.folders.list(),
      save: ({ id, name, parentId, sortOrder, expectedVersion }) => {
        if (id !== undefined && store.folders.get(id)) {
          return store.folders.update(
            id,
            { name, parentId, sortOrder },
            expectedVersion === undefined ? {} : { expectedVersion },
          );
        }
        return store.folders.create({
          ...(id === undefined ? {} : { id }),
          name,
          parentId,
          sortOrder,
        });
      },
      delete: ({ id }) => {
        store.folders.delete(id);
      },
    },

    secrets: {
      set: ({ profileId, refId, value }) => {
        const ref = secretRefsOf(requireProfile(profileId)).find((r) => r.id === refId);
        if (!ref) throw notFound('Secret reference', refId);
        store.secrets.set(ref, value);
      },
      clear: ({ profileId, refId }) => {
        for (const ref of secretRefsOf(requireProfile(profileId))) {
          if (refId === undefined || ref.id === refId) store.secrets.delete(ref);
        }
      },
    },

    testConnection: ({ profile, secrets }, { signal }) =>
      runConnectionCheck(services.spawnHost, resolveProfile(store, profile, secrets ?? {}), {
        signal,
        ...(services.hostKeys ? { hostKeys: services.hostKeys } : {}),
      }),

    openConnection: async ({ profileId, secrets }, { progress }) => {
      const profile = requireProfile(profileId);
      progress({ phase: 'Connecting', completed: 0 });
      const opened = await supervisor.open(profileId, () =>
        resolveProfile(store, profile, secrets ?? {}, { requireAll: true }),
      );
      const { local, remote } = services.createChannel();
      supervisor.attach(opened.connectionId, local);
      window.sendPort({ kind: 'connection', connectionId: opened.connectionId }, remote);
      return { connectionId: opened.connectionId };
    },

    closeConnection: ({ connectionId }) => {
      supervisor.close(connectionId);
    },

    connectionEvents: (_input, { signal }) => connectionEvents(supervisor, signal),

    history: {
      list: (options) => store.history.list(options),
      search: ({ query, ...options }) => store.history.search(query, options),
      add: (entry) => store.history.append(entry),
    },

    settings: {
      get: () => readSettings(),
      set: (patch) => {
        const next = writeAppSettings(store, defaults, patch);
        services.onSettingsChanged?.(next);
        return next;
      },
    },

    app: {
      info: () => services.appInfo(),
      openExternal: async ({ url }) => {
        if (!isSafeExternalUrl(url)) {
          throw new JoineryError({ code: 'VALIDATION_FAILED', message: 'Only https links open' });
        }
        await services.openExternal(url);
      },
      commands: (_input, { signal }) =>
        subscriptionStream<AppCommand>(
          (listener) => services.appCommands?.subscribe(listener) ?? (() => undefined),
          signal,
        ),
      menu: ({ command }) => {
        if ((command === 'reload' || command === 'toggleDevTools') && !services.development) {
          throw new JoineryError({
            code: 'VALIDATION_FAILED',
            message: 'Reload and the developer tools are for development runs',
          });
        }
        if (command === 'checkForUpdates') services.menuCommands?.checkForUpdates();
        else if (command === 'releaseNotes') services.menuCommands?.releaseNotes();
        else window.runMenu?.(command);
      },
    },

    dialogs: {
      openFile: async (options) => {
        const path = await window.openFile(options);
        // A file the user picked is one this window's jobs may read (import, Run SQL File).
        if (path !== null) files.grantRead(path);
        return { path };
      },
      ...fileDialogHandlers(window, files),
    },

    hostKeys: {
      prompts: (_input, { signal }) => hostKeyEvents(services.hostKeys, signal),
      answer: ({ promptId, answer }) => {
        services.hostKeys?.answer(promptId, answer);
      },
    },

    ssh: {
      inspectKey: async ({ path, passphrase }) => {
        if (services.keysDir === undefined) {
          throw new JoineryError({
            code: 'NOT_SUPPORTED',
            message: 'Private keys cannot be checked here',
          });
        }
        // Loaded on first use: the key code brings ssh2, which start-up does not need.
        const { inspectPrivateKey } = await import('./ssh-keys');
        return inspectPrivateKey(path, passphrase, services.keysDir);
      },
    },

    erModels: erModelHandlers(store),
    schedules: scheduleHandlers(services, files),
    metadata: metadataHandlers(store),
    snippets: snippetHandlers(store),
    ...jobHandlers(services, files),
    mongo: mongoMainHandlers(services, files),
    sync: syncHandlers(services, files),
    gridViews: gridViewHandlers(store),
    autosave: autosaveHandlers(store, services.previousRun ?? 'none'),
    transferDb: transferDbHandlers(services),
    backup: backupMainHandlers(services, files),
    redisDump: redisDumpHandlers(services, files),
    updates: updateHandlers(services.updates, () => services.appInfo().version),
  };
}

/** The host key questions for one window; with no broker, nothing until the caller stops. */
async function* hostKeyEvents(
  broker: HostKeyBroker | undefined,
  signal: AbortSignal,
): AsyncGenerator<HostKeyPromptEvent> {
  if (broker) {
    yield* hostKeyPromptEvents(broker, signal);
    return;
  }
  await new Promise<void>((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener('abort', () => resolve(), { once: true });
  });
}

/** "ops@bastion:22", with an IPv6 host bracketed. */
function hostLabel(host: string, port: number, user?: string): string {
  return `${user === undefined ? '' : `${user}@`}${host.includes(':') ? `[${host}]` : host}:${port}`;
}

/** What each of a profile's secrets is for, so a prompt can say which one it asks for. */
function secretLabels(profile: ConnectionProfile): Map<string, string> {
  const labels = new Map<string, string>();
  const { auth, tls, ssh, proxy } = profile;
  if (auth.method === 'password' && auth.password) labels.set(auth.password.id, 'Password');
  if (auth.method === 'apiKey') labels.set(auth.apiKey.id, 'API key');
  if (auth.method === 'bearer') labels.set(auth.token.id, 'Token');
  if (tls.keyPassphrase) labels.set(tls.keyPassphrase.id, 'TLS client key passphrase');
  for (const hop of ssh?.hops ?? []) {
    const where = hostLabel(hop.host, hop.port, hop.user);
    if (hop.auth.method === 'password') {
      labels.set(hop.auth.password.id, `SSH password for ${where}`);
    } else if (hop.auth.method === 'privateKey' && hop.auth.passphrase) {
      labels.set(hop.auth.passphrase.id, `Passphrase of the SSH key ${hop.auth.keyPath}`);
    }
  }
  if (proxy?.password) {
    const kind = proxy.kind === 'http' ? 'HTTP' : 'SOCKS5';
    labels.set(
      proxy.password.id,
      `${kind} proxy password for ${hostLabel(proxy.host, proxy.port)}`,
    );
  }
  return labels;
}

/** Current states first, then every change, until the caller stops. */
async function* connectionEvents<P>(
  supervisor: ConnectionSupervisor<P>,
  signal: AbortSignal,
): AsyncGenerator<ConnectionEvent> {
  const queue: ConnectionEvent[] = supervisor.snapshot();
  let wake: (() => void) | undefined;
  const unsubscribe = supervisor.subscribe((event) => {
    queue.push(event);
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
