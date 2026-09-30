import { connectionProfileSchema, type ConnectionProfileInput } from '@joinery/core';
import { storedProfileSchema, type Folder, type StoredProfile } from '@joinery/ipc';
import { afterEach, describe, expect, it } from 'vitest';

import {
  NO_FILTER,
  clearSidebarFilter,
  filterActive,
  matchParts,
  setSidebarFilter,
  setSidebarSearch,
  toggled,
  useSidebarView,
  visibleTree,
  type SidebarView,
} from '../src/renderer/src/state/sidebar-filter';
import { profileInput } from './helpers';

/** The side bar's search and filter (Navicat's): what the connection tree shows. */

const NOW = '2026-10-01T10:00:00.000Z';

function stored(
  overrides: Partial<ConnectionProfileInput> & {
    readonly folderId?: string;
    readonly environment?: string;
  },
): StoredProfile {
  const { folderId = null, environment = 'dev', ...rest } = overrides;
  return storedProfileSchema.parse({
    ...connectionProfileSchema.parse(
      profileInput({
        ...rest,
        presentation: {
          folderId,
          tags: [],
          environment,
          readOnly: false,
          confirmWrites: false,
        } as ConnectionProfileInput['presentation'],
      }),
    ),
    version: 1,
  });
}

function folder(id: string, name: string): Folder {
  return { id, parentId: null, name, sortOrder: 0, version: 1, createdAt: NOW, updatedAt: NOW };
}

const SHOP = stored({ id: 'shop', name: 'Shop', engine: 'postgres' });
const BILLING = stored({
  id: 'billing',
  name: 'Billing',
  engine: 'mysql',
  endpoint: { kind: 'host', host: 'h', port: 3306 },
  environment: 'production',
  folderId: 'f-prod',
});
const CACHE = stored({
  id: 'cache',
  name: 'Sessions cache',
  engine: 'redis',
  endpoint: { kind: 'host', host: 'h', port: 6379 },
  auth: { method: 'none' },
  folderId: 'f-dev',
});
const PROFILES = [SHOP, BILLING, CACHE];
const FOLDERS = [folder('f-prod', 'Production'), folder('f-dev', 'Tools')];

const view = (patch: Partial<SidebarView> = {}): SidebarView => ({
  search: '',
  filter: NO_FILTER,
  ...patch,
});
const none = (): boolean => false;
const names = (tree: ReturnType<typeof visibleTree>) => ({
  root: tree.root.map((p) => p.name),
  folders: tree.folders.map((f) => [f.folder.name, f.profiles.map((p) => p.name)]),
  empty: tree.empty,
});

afterEach(() => {
  setSidebarSearch('');
  clearSidebarFilter();
});

describe('visibleTree', () => {
  it('shows everything, empty folders too, when nothing narrows it', () => {
    const tree = visibleTree(PROFILES, [...FOLDERS, folder('f-empty', 'Empty')], none, view());
    expect(names(tree)).toEqual({
      root: ['Shop'],
      folders: [
        ['Production', ['Billing']],
        ['Tools', ['Sessions cache']],
        ['Empty', []],
      ],
      empty: false,
    });
  });

  it('matches connection names regardless of case, and hides folders without a match', () => {
    const tree = visibleTree(PROFILES, FOLDERS, none, view({ search: '  CACHE ' }));
    expect(names(tree)).toEqual({
      root: [],
      folders: [['Tools', ['Sessions cache']]],
      empty: false,
    });
  });

  it('shows every connection of a folder whose name matches', () => {
    const tree = visibleTree(PROFILES, FOLDERS, none, view({ search: 'produc' }));
    expect(names(tree).folders).toEqual([['Production', ['Billing']]]);
  });

  it('filters by engine and by environment', () => {
    expect(
      names(
        visibleTree(
          PROFILES,
          FOLDERS,
          none,
          view({ filter: { ...NO_FILTER, engines: ['redis', 'postgres'] } }),
        ),
      ),
    ).toEqual({ root: ['Shop'], folders: [['Tools', ['Sessions cache']]], empty: false });
    expect(
      names(
        visibleTree(
          PROFILES,
          FOLDERS,
          none,
          view({ filter: { ...NO_FILTER, environments: ['production'] } }),
        ),
      ),
    ).toEqual({ root: [], folders: [['Production', ['Billing']]], empty: false });
  });

  it('keeps only the connected ones with "connected only"', () => {
    const connected = (id: string): boolean => id === 'billing';
    const tree = visibleTree(
      PROFILES,
      FOLDERS,
      connected,
      view({ filter: { ...NO_FILTER, connectedOnly: true } }),
    );
    expect(names(tree).folders).toEqual([['Production', ['Billing']]]);
  });

  it('says so when nothing matches, but not when there are no connections', () => {
    expect(visibleTree(PROFILES, FOLDERS, none, view({ search: 'nothing' })).empty).toBe(true);
    expect(visibleTree([], FOLDERS, none, view({ search: 'nothing' })).empty).toBe(false);
  });

  it('puts a connection whose folder is gone at the top level', () => {
    const orphan = stored({ id: 'o', name: 'Orphan', folderId: 'f-gone' });
    expect(names(visibleTree([orphan], FOLDERS, none, view())).root).toEqual(['Orphan']);
  });
});

describe('matchParts', () => {
  it('splits a name around the first match, keeping its case', () => {
    expect(matchParts('Sessions cache', 'SS')).toEqual({
      before: 'Se',
      match: 'ss',
      after: 'ions cache',
    });
  });

  it('has nothing to highlight without a search or a match', () => {
    expect(matchParts('Shop', ' ')).toBeUndefined();
    expect(matchParts('Shop', 'x')).toBeUndefined();
  });
});

describe('the view state', () => {
  it('patches and clears the filter, and toggles values in its lists', () => {
    expect(filterActive(useSidebarView.getState().filter)).toBe(false);
    setSidebarFilter({ engines: toggled([], 'redis') });
    setSidebarFilter({ connectedOnly: true });
    expect(useSidebarView.getState().filter).toEqual({
      engines: ['redis'],
      environments: [],
      connectedOnly: true,
    });
    expect(filterActive(useSidebarView.getState().filter)).toBe(true);
    expect(toggled(['redis', 'mysql'], 'redis')).toEqual(['mysql']);
    clearSidebarFilter();
    expect(useSidebarView.getState().filter).toBe(NO_FILTER);
  });
});
