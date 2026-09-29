import { JoineryError, connectionProfileSchema, newId, secretRefsOf } from '@joinery/core';
import {
  DEFAULT_APP_SETTINGS,
  appSettingsPatchSchema,
  appSettingsSchema,
  type AppInfo,
  type AppSettings,
  type AppSettingsPatch,
  type ConnectionEvent,
  type HandlersOf,
  type mainContract,
} from '@joinery/ipc';
import { parseConnectionUri, type Store, type StoredProfile } from '@joinery/storage';

import type { PortPayload } from '../shared/bridge';
import { runConnectionCheck } from './checker';
import type { HostProcessFactory } from './host-process';
import { resolveProfile } from './secrets';
import { isSafeExternalUrl } from './security';
import type { ConnectionSupervisor } from './supervisor';

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
}

/** What differs per window: where its ports go and which window owns its dialogs. */
export interface WindowServices<P> {
  readonly sendPort: (payload: PortPayload, port: P) => void;
  readonly openFile: (options: OpenFileOptions) => Promise<string | null>;
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
    }),
    editor: { ...base.editor, ...stripUndefined(patch.editor ?? {}) },
    results: { ...base.results, ...stripUndefined(patch.results ?? {}) },
    connections: { ...base.connections, ...stripUndefined(patch.connections ?? {}) },
  };
}

function stripUndefined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;
}

export function createMainHandlers<P>(
  services: MainServices<P>,
  window: WindowServices<P>,
): HandlersOf<typeof mainContract> {
  const { store, supervisor } = services;
  const defaults = services.defaultSettings ?? DEFAULT_APP_SETTINGS;

  const requireProfile = (id: string): StoredProfile => {
    const profile = store.profiles.get(id);
    if (!profile) throw notFound('Profile', id);
    return profile;
  };

  // Stored settings are a patch over the defaults, so settings added later get their default.
  const readSettings = (): AppSettings => {
    const stored = store.settings.get(SETTINGS_KEY, appSettingsPatchSchema);
    if (stored === undefined) return defaults;
    const merged = appSettingsSchema.safeParse(mergeSettings(defaults, stored));
    return merged.success ? merged.data : defaults;
  };

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
        const resolved = store.secrets.resolve(requireProfile(profileId));
        const unreadable = new Set(resolved.unreadable.map((ref) => ref.id));
        return {
          canSave,
          missing: resolved.missing.map((ref) => ({
            refId: ref.id,
            policy: ref.policy,
            unreadable: unreadable.has(ref.id),
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
        const next = appSettingsSchema.parse(mergeSettings(readSettings(), patch));
        store.settings.set(SETTINGS_KEY, next);
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
    },

    dialogs: {
      openFile: async (options) => ({ path: await window.openFile(options) }),
    },
  };
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
