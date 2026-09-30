import { cachedProfile } from '../../state/data';
import {
  createSearchConsole,
  createSearchTool,
  getSearchPanel,
  type SearchToolRequest,
} from '../../state/search/panels';
import { AdminView } from '../../state/search/admin';
import { currentDock } from '../dock';

/** Opens the Elasticsearch / OpenSearch panels in the dock. */

function addToDock(id: string, title: string): void {
  currentDock()?.addPanel({
    id,
    component: 'search',
    tabComponent: 'panelTab',
    title,
    params: { panelId: id },
    renderer: 'always',
  });
}

/** Opens a console on a connection (its "query tab"), optionally with text. */
export function openSearchConsole(options: {
  readonly profileId: string;
  readonly title: string;
  readonly text?: string;
}): string {
  const title = options.title.replace(/ query$/, ' console');
  const id = createSearchConsole(
    { profileId: options.profileId, ...(options.text !== undefined ? { text: options.text } : {}) },
    title,
  );
  addToDock(id, title);
  return id;
}

/**
 * Opens a tool panel (documents, an index, SQL, cluster, templates and pipelines, snapshots),
 * or focuses the one already open on the same object.
 */
export function openSearchTool(request: SearchToolRequest): string {
  const profileId = request.tool === 'documents' ? request.target.profileId : request.profileId;
  const profileName = cachedProfile(profileId)?.name ?? 'Cluster';
  const { id, opened, title } = createSearchTool(request, profileName);
  if (opened) {
    addToDock(id, title);
    return id;
  }
  currentDock()?.getPanel(id)?.api.setActive();
  const panel = getSearchPanel(id);
  if (request.tool === 'admin' && request.tab && panel instanceof AdminView) {
    void panel.setTab(request.tab);
  }
  return id;
}
