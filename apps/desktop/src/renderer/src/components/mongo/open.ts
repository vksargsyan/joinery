import type { CollectionTarget } from '../../state/mongo/collection-view';
import {
  createCollectionPanel,
  createConsolePanel,
  createToolPanel,
  getMongoPanel,
  type ToolPanelRequest,
} from '../../state/mongo/panels';
import { UsersRoles } from '../../state/mongo/users';
import { currentDock } from '../dock';

/**
 * Opens the MongoDB module's panels in the dock: a collection's view (or focuses the open one),
 * a command console (the "query tab" of a MongoDB connection) and the tool panels.
 */

function addToDock(id: string, title: string): void {
  currentDock()?.addPanel({
    id,
    component: 'mongo',
    tabComponent: 'panelTab',
    title,
    params: { panelId: id },
    renderer: 'always',
  });
}

/** Opens a collection, view or time series collection in the collection view. */
export function openMongoCollection(target: CollectionTarget): string {
  const { id, opened } = createCollectionPanel(target);
  if (opened) addToDock(id, target.collection);
  else currentDock()?.getPanel(id)?.api.setActive();
  return id;
}

/** Opens a command console on a connection, optionally on a database and with text. */
export function openMongoConsole(options: {
  readonly profileId: string;
  readonly title: string;
  readonly database?: string;
  readonly text?: string;
}): string {
  const title = options.database
    ? `${options.database} console`
    : options.title.replace(/ query$/, ' console');
  const id = createConsolePanel(
    {
      profileId: options.profileId,
      database: options.database,
      ...(options.text !== undefined ? { text: options.text } : {}),
    },
    title,
  );
  addToDock(id, title);
  return id;
}

/**
 * Opens a MongoDB tool panel (aggregation editor, indexes, schema, options, change stream,
 * GridFS files, users and roles), or focuses the one already open on the same object.
 */
export function openMongoTool(request: ToolPanelRequest): string {
  const { id, opened, title } = createToolPanel(request);
  if (opened) {
    addToDock(id, title);
    return id;
  }
  currentDock()?.getPanel(id)?.api.setActive();
  const panel = getMongoPanel(id);
  if (request.tool === 'users' && panel instanceof UsersRoles) {
    panel.setTab(request.target.tab);
    if (request.target.select !== undefined) {
      if (request.target.tab === 'users') panel.selectUser(request.target.select);
      else panel.selectRole(request.target.select);
    }
  }
  return id;
}
