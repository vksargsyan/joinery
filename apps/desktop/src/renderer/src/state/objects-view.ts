import { newId, type BrowseNode, type EngineId } from '@joinery/core';
import { create } from 'zustand';

import { currentDock } from '../components/dock';
import { loadChildren, pathKey, useExplorer } from './explorer';
import { objectsPathFor } from './objects-model';
import { panelWithKey, patchPanel, registerPanel, unregisterPanel } from './panels';

/**
 * The Objects view, as Navicat's: one tab listing what the node chosen in the explorer holds,
 * with each object's statistics (rows, sizes, engine, dates, owner, comment). It adds to the
 * tree and never replaces it: a click on a database, a schema or a folder still expands it, and
 * also shows its objects here. A MySQL or MariaDB database and a PostgreSQL schema list their
 * tables, a PostgreSQL database its schemas, a MongoDB database its collections, and a folder
 * its objects (state/objects-model.ts).
 *
 * It reads the explorer's own cache (`browse` already carries the statistics), so the tree and
 * the view load, refresh and fail together.
 */

export interface ObjectsLocation {
  readonly profileId: string;
  /** The explorer path whose children the view lists. */
  readonly path: readonly string[];
  /** Display names along the path, for the breadcrumb. */
  readonly trail: readonly string[];
  /** The tree node that was clicked (a schema lists its tables folder), marked in the tree. */
  readonly source: readonly string[];
}

interface ObjectsViewState {
  readonly location?: ObjectsLocation;
}

export const useObjectsView = create<ObjectsViewState>()(() => ({}));

const PANEL_KEY = 'objects';

/** A folder id ("tables") as the tree shows it when its node is not loaded ("Tables"). */
function folderLabel(segment: string): string {
  return segment.charAt(0).toUpperCase() + segment.slice(1).replaceAll('-', ' ');
}

/** The names along a path, from the tree's loaded nodes where it has them. */
function trailFor(profileId: string, path: readonly string[]): string[] {
  const loaded = useExplorer.getState().children[profileId] ?? {};
  return path.map((segment, index) => {
    const parent = pathKey(path.slice(0, index));
    const node = loaded[parent]?.nodes?.find(
      (candidate) => candidate.path.length === index + 1 && candidate.path[index] === segment,
    );
    return node?.name ?? folderLabel(segment);
  });
}

/** Shows a node's objects in the Objects tab, opening the tab (or bringing it forward). */
export function showObjects(profileId: string, node: BrowseNode, engine: EngineId): void {
  const path = objectsPathFor(node, engine);
  if (path === undefined) return;
  useObjectsView.setState({
    location: { profileId, path, trail: trailFor(profileId, path), source: node.path },
  });
  const loaded = useExplorer.getState().children[profileId]?.[pathKey(path)];
  if (!loaded || (loaded.error !== undefined && !loaded.loading))
    void loadChildren(profileId, path);
  openObjectsPanel(profileId);
}

function openObjectsPanel(profileId: string): void {
  const open = panelWithKey(PANEL_KEY);
  if (open) {
    // The production frame follows the connection the view shows.
    patchPanel(open.id, { profileId });
    currentDock()?.getPanel(open.id)?.api.setActive();
    return;
  }
  const id = newId();
  registerPanel({ id, kind: 'objects', profileId, title: 'Objects', key: PANEL_KEY });
  currentDock()?.addPanel({
    id,
    component: 'objects',
    tabComponent: 'panelTab',
    title: 'Objects',
    params: { panelId: id },
    renderer: 'always',
  });
}

export function disposeObjectsPanel(panelId: string): void {
  unregisterPanel(panelId);
  useObjectsView.setState({ location: undefined });
}
