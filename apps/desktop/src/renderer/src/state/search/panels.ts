import { newId } from '@joinery/core';

import { registerPanel } from '../panels';
import { SearchConsole, type ConsoleTarget } from './console';

/**
 * The Elasticsearch / OpenSearch module's dock panels. Today the console; the index, document,
 * SQL and administration panels join this registry. The dock renders them through one `search`
 * panel component; this registry holds each panel's state and disposes it (closing its
 * session) when the panel closes.
 */

export type SearchPanel = SearchConsole;

const panels = new Map<string, SearchPanel>();

export function getSearchPanel(id: string): SearchPanel | undefined {
  return panels.get(id);
}

/** Creates a console's state and registers its panel; returns the panel id. */
export function createSearchConsole(target: ConsoleTarget, title: string): string {
  const id = newId();
  registerPanel({ id, kind: 'search', profileId: target.profileId, title });
  const console = new SearchConsole(id, target);
  panels.set(id, console);
  void console.init();
  return id;
}

/** Closes a panel's session (the panel closed). */
export function disposeSearchPanel(id: string): void {
  const panel = panels.get(id);
  panels.delete(id);
  void panel?.dispose();
}
