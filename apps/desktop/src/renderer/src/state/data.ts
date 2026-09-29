import type { HistoryPage, StoredProfile } from '@joinery/ipc';
import { QueryClient, useQuery } from '@tanstack/react-query';

import { mainApi } from '../lib/main-client';

/**
 * Backend data through TanStack Query (spec §19): profiles, folders, settings and history are
 * cached here and invalidated after writes; UI-only state lives in the Zustand stores.
 */

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 30_000, refetchOnWindowFocus: false, retry: false },
    mutations: { retry: false },
  },
});

export const keys = {
  profiles: ['profiles'] as const,
  folders: ['folders'] as const,
  settings: ['settings'] as const,
  canSave: ['secrets', 'canSave'] as const,
  history: (query: string, profileId: string | undefined) =>
    ['history', query, profileId ?? ''] as const,
};

export function useProfiles() {
  return useQuery({ queryKey: keys.profiles, queryFn: () => mainApi().profiles.list() });
}

export function useFolders() {
  return useQuery({ queryKey: keys.folders, queryFn: () => mainApi().folders.list() });
}

export function useSettings() {
  return useQuery({ queryKey: keys.settings, queryFn: () => mainApi().settings.get() });
}

/** Whether secrets with the "save" policy can be stored on this machine. */
export function useCanSaveSecrets() {
  return useQuery({
    queryKey: keys.canSave,
    queryFn: async () => (await mainApi().profiles.secretStatus({})).canSave,
  });
}

export function useHistory(query: string, profileId: string | undefined) {
  return useQuery({
    queryKey: keys.history(query, profileId),
    queryFn: (): Promise<HistoryPage> => {
      const scope = profileId === undefined ? {} : { profileId };
      const trimmed = query.trim();
      return trimmed === ''
        ? mainApi().history.list({ ...scope, limit: 200 })
        : mainApi().history.search({ query: trimmed, ...scope, limit: 200 });
    },
    staleTime: 0,
  });
}

/** A profile from the cache, fetching the list when needed. */
export async function profileById(id: string): Promise<StoredProfile | undefined> {
  const profiles = await queryClient.fetchQuery({
    queryKey: keys.profiles,
    queryFn: () => mainApi().profiles.list(),
  });
  return profiles.find((profile) => profile.id === id);
}

/** The cached profile, synchronously (undefined before the list has loaded). */
export function cachedProfile(id: string): StoredProfile | undefined {
  return queryClient.getQueryData<StoredProfile[]>(keys.profiles)?.find((p) => p.id === id);
}
