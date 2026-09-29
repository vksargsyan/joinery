import { createSearchConsole } from '../../state/search/panels';
import { currentDock } from '../dock';

/** Opens the Elasticsearch / OpenSearch panels in the dock. */

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
  currentDock()?.addPanel({
    id,
    component: 'search',
    tabComponent: 'panelTab',
    title,
    params: { panelId: id },
    renderer: 'always',
  });
  return id;
}
