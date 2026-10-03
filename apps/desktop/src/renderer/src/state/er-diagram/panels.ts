import { isSqlEngine, newId } from '@querybara/core';
import { create } from 'zustand';

import { currentDock } from '../../components/dock';
import { cachedProfile } from '../data';
import { useMetadata } from '../metadata';
import { panelWithKey, registerPanel, unregisterPanel } from '../panels';
import { ErDiagramView, type ErTarget } from './view';

/**
 * ER diagram panels (spec §8): one dock panel per database, or PostgreSQL schema, with its
 * ErDiagramView. Opening the same place again focuses the open diagram. A panel reloads when the
 * connection's metadata changes (a table designed, dropped or refreshed).
 */

interface ErPanelsState {
  readonly views: Readonly<Record<string, ErDiagramView>>;
}

export const useErDiagrams = create<ErPanelsState>()(() => ({ views: {} }));

const cleanups = new Map<string, () => void>();

export interface OpenErDiagramOptions {
  readonly profileId: string;
  readonly database?: string | undefined;
  readonly schema?: string | undefined;
}

/** Opens an ER diagram for a SQL connection; undefined for other engines. */
export function openErDiagram(options: OpenErDiagramOptions): string | undefined {
  const profile = cachedProfile(options.profileId);
  if (!profile || !isSqlEngine(profile.engine)) return undefined;
  const target: ErTarget = {
    profileId: profile.id,
    dialect: profile.engine,
    ...(options.database === undefined ? {} : { database: options.database }),
    ...(options.schema === undefined ? {} : { schema: options.schema }),
  };
  const key = ['er-diagram', profile.id, options.database ?? '', options.schema ?? ''].join(
    '\u0000',
  );
  const open = panelWithKey(key);
  if (open) {
    currentDock()?.getPanel(open.id)?.api.setActive();
    return open.id;
  }
  const id = newId();
  const place = options.schema ?? options.database ?? profile.name;
  const title = `ER diagram (${place})`;
  registerPanel({ id, kind: 'er-diagram', profileId: profile.id, title, key });
  const view = new ErDiagramView(id, target);
  useErDiagrams.setState((state) => ({ views: { ...state.views, [id]: view } }));
  const offMetadata = useMetadata.subscribe((state, previous) => {
    if (state.versions[profile.id] !== previous.versions[profile.id]) void view.load();
  });
  cleanups.set(id, offMetadata);
  void view.load();
  currentDock()?.addPanel({
    id,
    component: 'erDiagram',
    tabComponent: 'panelTab',
    title,
    params: { panelId: id },
    renderer: 'always',
  });
  return id;
}

export function erDiagramView(panelId: string): ErDiagramView | undefined {
  return useErDiagrams.getState().views[panelId];
}

/** Frees a closed panel's diagram. */
export function disposeErDiagram(panelId: string): void {
  // Unapplied changes still waiting to be kept are written now.
  erDiagramView(panelId)?.state.editor?.dispose();
  cleanups.get(panelId)?.();
  cleanups.delete(panelId);
  useErDiagrams.setState((state) => {
    const { [panelId]: _gone, ...views } = state.views;
    return { views };
  });
  unregisterPanel(panelId);
}
