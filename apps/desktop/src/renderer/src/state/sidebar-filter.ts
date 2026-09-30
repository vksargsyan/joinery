import type { Environment, EngineId } from '@joinery/core';
import type { Folder, StoredProfile } from '@joinery/ipc';
import { create } from 'zustand';

/**
 * What the connection tree shows: the search at the bottom of the side bar (connection and
 * folder names) and the filter next to it (engines, environments, connected only), as Navicat
 * narrows its connection list. A connection shows when it passes the filter and its name, or
 * its folder's name, contains the search; a folder shows when it holds a connection that shows,
 * and while searching every folder shown is open. Both last while the app runs.
 */

export interface SidebarFilter {
  readonly engines: readonly EngineId[];
  readonly environments: readonly Environment[];
  readonly connectedOnly: boolean;
}

export const NO_FILTER: SidebarFilter = { engines: [], environments: [], connectedOnly: false };

export interface SidebarView {
  readonly search: string;
  readonly filter: SidebarFilter;
}

export const useSidebarView = create<SidebarView>(() => ({ search: '', filter: NO_FILTER }));

export function setSidebarSearch(search: string): void {
  useSidebarView.setState({ search });
}

export function setSidebarFilter(patch: Partial<SidebarFilter>): void {
  useSidebarView.setState((state) => ({ filter: { ...state.filter, ...patch } }));
}

export function clearSidebarFilter(): void {
  useSidebarView.setState({ filter: NO_FILTER });
}

export function filterActive(filter: SidebarFilter): boolean {
  return filter.engines.length > 0 || filter.environments.length > 0 || filter.connectedOnly;
}

/** Adds or removes a value from a filter list. */
export function toggled<T>(list: readonly T[], value: T): T[] {
  return list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
}

export interface VisibleTree {
  /** Connections outside any folder. */
  readonly root: readonly StoredProfile[];
  /** Folders that show, each with the connections that show in it. */
  readonly folders: readonly {
    readonly folder: Folder;
    readonly profiles: readonly StoredProfile[];
  }[];
  /** Nothing matches (the tree is empty only because of the search or the filter). */
  readonly empty: boolean;
}

function contains(text: string, search: string): boolean {
  return text.toLowerCase().includes(search.toLowerCase());
}

export function visibleTree(
  profiles: readonly StoredProfile[],
  folders: readonly Folder[],
  connected: (profileId: string) => boolean,
  view: SidebarView,
): VisibleTree {
  const search = view.search.trim();
  const { filter } = view;
  const passes = (profile: StoredProfile): boolean =>
    (filter.engines.length === 0 || filter.engines.includes(profile.engine)) &&
    (filter.environments.length === 0 ||
      filter.environments.includes(profile.presentation.environment)) &&
    (!filter.connectedOnly || connected(profile.id));
  const folderName = new Map(folders.map((f) => [f.id, f.name]));
  const shows = (profile: StoredProfile): boolean => {
    if (!passes(profile)) return false;
    if (search === '') return true;
    const folder = profile.presentation.folderId;
    return (
      contains(profile.name, search) ||
      (folder !== null && contains(folderName.get(folder) ?? '', search))
    );
  };
  const shown = profiles.filter(shows);
  const narrowed = search !== '' || filterActive(filter);
  const byFolder = new Map<string, StoredProfile[]>();
  const root: StoredProfile[] = [];
  for (const profile of shown) {
    const folder = profile.presentation.folderId;
    if (folder === null || !folderName.has(folder)) root.push(profile);
    else byFolder.set(folder, [...(byFolder.get(folder) ?? []), profile]);
  }
  const visibleFolders = folders
    .filter((folder) => !narrowed || (byFolder.get(folder.id)?.length ?? 0) > 0)
    .map((folder) => ({ folder, profiles: byFolder.get(folder.id) ?? [] }));
  return {
    root,
    folders: visibleFolders,
    empty: narrowed && profiles.length > 0 && shown.length === 0,
  };
}

/** A name split around the first match of the search, for highlighting. */
export function matchParts(
  text: string,
  search: string,
): { readonly before: string; readonly match: string; readonly after: string } | undefined {
  const needle = search.trim();
  if (needle === '') return undefined;
  const at = text.toLowerCase().indexOf(needle.toLowerCase());
  if (at < 0) return undefined;
  return {
    before: text.slice(0, at),
    match: text.slice(at, at + needle.length),
    after: text.slice(at + needle.length),
  };
}
