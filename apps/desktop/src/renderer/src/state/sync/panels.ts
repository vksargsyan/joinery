import { newId, requiresWriteConfirmation } from '@joinery/core';
import type { SavedComparison, StoredProfile } from '@joinery/ipc';
import { create } from 'zustand';

import { currentDock } from '../../components/dock';
import { cachedProfile } from '../data';
import { patchPanel, registerPanel, unregisterPanel } from '../panels';
import { appSyncApi } from './api';
import { DataCompare, type DataCompareInit } from './data';
import type { ProfileLookup, SideDraft, SideProfile } from './sides';
import { StructureCompare, type StructureCompareInit } from './structure';

/**
 * The compare panels (spec §13): each structure or data compare is a dock panel with its own
 * view model. Opened from the explorer (a connection, a database, a schema), from the window's
 * Compare menu, or from a saved comparison; closing one forgets its comparison in main.
 */

export type SyncPanelModel =
  | { readonly kind: 'structure'; readonly model: StructureCompare }
  | { readonly kind: 'data'; readonly model: DataCompare };

interface SyncPanelsState {
  readonly panels: Readonly<Record<string, SyncPanelModel>>;
  /** The saved comparisons list is open. */
  readonly savedOpen: boolean;
}

export const useSyncPanels = create<SyncPanelsState>()(() => ({ panels: {}, savedOpen: false }));

const unsubscribers = new Map<string, () => void>();

/** A connection as the compare setup sees it, from the cached profile list. */
export function sideProfile(profile: StoredProfile): SideProfile {
  return {
    id: profile.id,
    name: profile.name,
    engine: profile.engine,
    defaultDatabase: profile.options.defaultDatabase,
    readOnly: profile.presentation.readOnly,
    production: profile.presentation.environment === 'production',
    confirmWrites: requiresWriteConfirmation(profile),
  };
}

export const appProfileLookup: ProfileLookup = (profileId) => {
  const profile = cachedProfile(profileId);
  return profile ? sideProfile(profile) : undefined;
};

function open(
  entry: SyncPanelModel,
  title: string,
  sides: () => { source: SideDraft; target: SideDraft; busy: boolean },
): string {
  const id = newId();
  const now = sides();
  registerPanel({
    id,
    kind: 'sync',
    profileId: now.target.profileId ?? now.source.profileId ?? '',
    title,
  });
  useSyncPanels.setState((state) => ({ panels: { ...state.panels, [id]: entry } }));
  // The window frames the panel in red when its target is a production connection (spec §4).
  unsubscribers.set(
    id,
    entry.model.store.subscribe(() => {
      const next = sides();
      patchPanel(id, {
        profileId: next.target.profileId ?? next.source.profileId ?? '',
        busy: next.busy,
      });
    }),
  );
  currentDock()?.addPanel({
    id,
    component: 'sync',
    tabComponent: 'panelTab',
    title,
    params: { panelId: id },
    renderer: 'always',
  });
  return id;
}

/** Opens a structure compare, from a connection, database or schema, or empty. */
export function openStructureCompare(init: StructureCompareInit = {}, title?: string): string {
  const model = new StructureCompare(init, appSyncApi(), appProfileLookup);
  return open({ kind: 'structure', model }, title ?? 'Structure compare', () => ({
    source: model.state.source,
    target: model.state.target,
    busy: model.state.running !== undefined,
  }));
}

/** Opens a data compare, from a connection, database or schema, or empty. */
export function openDataCompare(init: DataCompareInit = {}, title?: string): string {
  const model = new DataCompare(init, appSyncApi(), appProfileLookup);
  return open({ kind: 'data', model }, title ?? 'Data compare', () => ({
    source: model.state.source,
    target: model.state.target,
    busy: model.state.running !== undefined,
  }));
}

function savedSide(side: SavedComparison['source']): Partial<SideDraft> {
  return {
    ...(side.profileId !== null ? { profileId: side.profileId } : {}),
    database: side.database ?? '',
    schemas: (side.schemas ?? []).join(', '),
  };
}

/** Reopens a saved comparison in a new panel. */
export function openSavedComparison(saved: SavedComparison): string {
  const common = {
    source: savedSide(saved.source),
    target: savedSide(saved.target),
    saved: { id: saved.id, name: saved.name },
  };
  return saved.kind === 'structure'
    ? openStructureCompare(
        { ...common, ...(saved.structure !== undefined ? { options: saved.structure } : {}) },
        saved.name,
      )
    : openDataCompare(
        { ...common, ...(saved.data !== undefined ? { settings: saved.data } : {}) },
        saved.name,
      );
}

export function syncPanel(panelId: string): SyncPanelModel | undefined {
  return useSyncPanels.getState().panels[panelId];
}

/** Frees a closed panel's view model and the comparison main keeps for it. */
export function disposeSyncPanel(panelId: string): void {
  const entry = syncPanel(panelId);
  unsubscribers.get(panelId)?.();
  unsubscribers.delete(panelId);
  entry?.model.dispose();
  useSyncPanels.setState((state) => {
    const { [panelId]: _gone, ...panels } = state.panels;
    return { panels };
  });
  unregisterPanel(panelId);
}

export function showSavedComparisons(open: boolean): void {
  useSyncPanels.setState({ savedOpen: open });
}
