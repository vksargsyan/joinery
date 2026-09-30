import type { Folder, StoredProfile } from '@joinery/ipc';
import { create } from 'zustand';

import { mainApi } from '../lib/main-client';
import { keys, queryClient } from './data';

/**
 * Folders of the connection tree (spec §4): making one (named "Folder N", then renamed in place)
 * and moving a connection into one, or out to the top level.
 */

/** The first "Folder N" no folder has yet. */
export function nextFolderName(folders: readonly Pick<Folder, 'name'>[]): string {
  const taken = new Set(folders.map((folder) => folder.name.trim().toLowerCase()));
  let n = folders.length + 1;
  while (taken.has(`folder ${n}`)) n += 1;
  return `Folder ${n}`;
}

/** A folder the tree is to rename in place as soon as it shows it (just made). */
export const useFolderRename = create<{ readonly folderId?: string }>()(() => ({}));

export function takeFolderRename(): void {
  useFolderRename.setState({ folderId: undefined });
}

/** Makes a folder and has the tree rename it in place. */
export async function createFolder(): Promise<Folder> {
  const folders =
    queryClient.getQueryData<Folder[]>(keys.folders) ?? (await mainApi().folders.list());
  const folder = await mainApi().folders.save({ name: nextFolderName(folders) });
  await queryClient.invalidateQueries({ queryKey: keys.folders });
  useFolderRename.setState({ folderId: folder.id });
  return folder;
}

/** Moves a connection into a folder, or to the top level with `null`. */
export async function moveToFolder(profile: StoredProfile, folderId: string | null): Promise<void> {
  if (profile.presentation.folderId === folderId) return;
  const { version, ...rest } = profile;
  await mainApi().profiles.save({
    profile: {
      ...rest,
      presentation: { ...rest.presentation, folderId },
      updatedAt: new Date().toISOString(),
    },
    expectedVersion: version,
  });
  await queryClient.invalidateQueries({ queryKey: keys.profiles });
}
