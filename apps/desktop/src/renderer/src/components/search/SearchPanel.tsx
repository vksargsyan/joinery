import { getSearchPanel } from '../../state/search/panels';
import { ConsolePanel } from './ConsolePanel';

/**
 * An Elasticsearch / OpenSearch dock panel (spec §11). Today the console; index, document and
 * administration panels join it.
 */
export function SearchPanel(props: { readonly panelId: string }) {
  const panel = getSearchPanel(props.panelId);
  if (!panel) return <p className="p-4 text-sm text-muted">This panel was closed.</p>;
  return <ConsolePanel console={panel} />;
}
