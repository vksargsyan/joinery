import type { CollectionTarget } from '../../state/mongo/collection-view';
import { createCollectionPanel, createConsolePanel } from '../../state/mongo/panels';
import { currentDock } from '../dock';

/**
 * Opens the MongoDB module's panels in the dock: a collection's view (or focuses the open one)
 * and a command console, the "query tab" of a MongoDB connection.
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
