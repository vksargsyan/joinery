import { newId } from '@joinery/core';

import { panelWithKey, registerPanel } from '../panels';
import { CollectionView, type CollectionTarget } from './collection-view';
import { MongoConsole, type ConsoleTarget } from './console';

/**
 * The MongoDB module's dock panels: collection views and command consoles. The dock renders
 * both through one `mongo` panel component; this registry holds each panel's state object and
 * disposes it (closing its session) when the panel closes.
 */

export type MongoPanel = CollectionView | MongoConsole;

const panels = new Map<string, MongoPanel>();

export function getMongoPanel(id: string): MongoPanel | undefined {
  return panels.get(id);
}

/** The key of a collection's view (see `PanelInfo.key`): opening it again focuses it. */
export function collectionKey(target: CollectionTarget): string {
  return ['mongo', target.profileId, target.db, target.collection].join('\u0000');
}

/**
 * Creates the state of a collection view and registers its panel; returns the panel id, or the
 * open view's id when the collection is already open (`opened: false`).
 */
export function createCollectionPanel(target: CollectionTarget): {
  readonly id: string;
  readonly opened: boolean;
} {
  const key = collectionKey(target);
  const open = panelWithKey(key);
  if (open) return { id: open.id, opened: false };
  const id = newId();
  registerPanel({ id, kind: 'mongo', profileId: target.profileId, title: target.collection, key });
  const view = new CollectionView(id, target);
  panels.set(id, view);
  void view.init();
  return { id, opened: true };
}

/** Creates a console's state and registers its panel. */
export function createConsolePanel(target: ConsoleTarget, title: string): string {
  const id = newId();
  registerPanel({ id, kind: 'mongo', profileId: target.profileId, title });
  const console = new MongoConsole(id, target);
  panels.set(id, console);
  void console.init();
  return id;
}

/** Closes a panel's session (the panel closed). */
export function disposeMongoPanel(id: string): void {
  const panel = panels.get(id);
  panels.delete(id);
  void panel?.dispose();
}
