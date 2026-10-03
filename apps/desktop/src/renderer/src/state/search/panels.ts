import { newId } from '@querybara/core';

import { panelWithKey, registerPanel } from '../panels';
import { AdminView, type AdminTab } from './admin';
import { ClusterView } from './cluster';
import { SearchConsole, type ConsoleTarget } from './console';
import { DocumentsView, type DocumentsTarget } from './documents';
import { IndexView } from './index-view';
import { SnapshotsView } from './snapshots';
import { SqlView, type SqlMode } from './sql';

/**
 * The Elasticsearch module's dock panels: consoles, document grids, index panels,
 * the SQL and ES|QL editor, and the cluster, templates-and-pipelines and snapshot panels. The
 * dock renders them through one `search` panel component; this registry holds each panel's
 * state and disposes it (closing its session) when the panel closes.
 */

export type SearchPanel =
  SearchConsole | DocumentsView | IndexView | SqlView | ClusterView | AdminView | SnapshotsView;

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

/** The tool panels, each opened once per object (opening it again focuses it). */
export type SearchToolRequest =
  | { readonly tool: 'documents'; readonly target: DocumentsTarget }
  | { readonly tool: 'index'; readonly profileId: string; readonly index: string }
  | { readonly tool: 'sql'; readonly profileId: string; readonly mode?: SqlMode }
  | { readonly tool: 'cluster'; readonly profileId: string }
  | { readonly tool: 'admin'; readonly profileId: string; readonly tab?: AdminTab }
  | { readonly tool: 'snapshots'; readonly profileId: string };

function profileOf(request: SearchToolRequest): string {
  return request.tool === 'documents' ? request.target.profileId : request.profileId;
}

/** What a tool panel shows, so opening the same thing again focuses it. */
export function searchToolKey(request: SearchToolRequest): string {
  const parts =
    request.tool === 'documents'
      ? [request.target.target]
      : request.tool === 'index'
        ? [request.index]
        : [];
  return ['search', request.tool, profileOf(request), ...parts].join('\u0000');
}

/** The tab title of a tool panel. */
export function searchToolTitle(request: SearchToolRequest, profileName: string): string {
  switch (request.tool) {
    case 'documents':
      return request.target.target;
    case 'index':
      return `${request.index} (index)`;
    case 'sql':
      return `${profileName} SQL`;
    case 'cluster':
      return `${profileName} cluster`;
    case 'admin':
      return `${profileName} templates and pipelines`;
    case 'snapshots':
      return `${profileName} snapshots`;
  }
}

function createTool(id: string, request: SearchToolRequest): SearchPanel {
  switch (request.tool) {
    case 'documents':
      return new DocumentsView(id, request.target);
    case 'index':
      return new IndexView(id, { profileId: request.profileId, index: request.index });
    case 'sql':
      return new SqlView(id, {
        profileId: request.profileId,
        ...(request.mode ? { mode: request.mode } : {}),
      });
    case 'cluster':
      return new ClusterView(id, request.profileId);
    case 'admin':
      return new AdminView(id, {
        profileId: request.profileId,
        ...(request.tab ? { tab: request.tab } : {}),
      });
    case 'snapshots':
      return new SnapshotsView(id, request.profileId);
  }
}

/**
 * Creates a tool panel's state and registers it; returns its id, or the open panel's id when
 * the same tool is already open on the object (`opened: false`).
 */
export function createSearchTool(
  request: SearchToolRequest,
  profileName: string,
): { readonly id: string; readonly opened: boolean; readonly title: string } {
  const key = searchToolKey(request);
  const title = searchToolTitle(request, profileName);
  const open = panelWithKey(key);
  if (open) return { id: open.id, opened: false, title };
  const id = newId();
  registerPanel({ id, kind: 'search', profileId: profileOf(request), title, key });
  const panel = createTool(id, request);
  panels.set(id, panel);
  void panel.init();
  return { id, opened: true, title };
}

/** Closes a panel's session (the panel closed). */
export function disposeSearchPanel(id: string): void {
  const panel = panels.get(id);
  panels.delete(id);
  void panel?.dispose();
}
