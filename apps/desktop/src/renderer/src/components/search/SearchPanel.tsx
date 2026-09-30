import { AdminView } from '../../state/search/admin';
import { ClusterView } from '../../state/search/cluster';
import { DocumentsView } from '../../state/search/documents';
import { IndexView } from '../../state/search/index-view';
import { getSearchPanel } from '../../state/search/panels';
import { SnapshotsView } from '../../state/search/snapshots';
import { SqlView } from '../../state/search/sql';
import { AdminPanel } from './AdminPanel';
import { ClusterPanel } from './ClusterPanel';
import { ConsolePanel } from './ConsolePanel';
import { DocumentsPanel } from './DocumentsPanel';
import { IndexPanel } from './IndexPanel';
import { SnapshotsPanel } from './SnapshotsPanel';
import { SqlPanel } from './SqlPanel';

/**
 * An Elasticsearch dock panel (spec §11): a console, a document grid, an index, the
 * SQL and ES|QL editor, the cluster, templates and pipelines, or snapshots.
 */
export function SearchPanel(props: { readonly panelId: string }) {
  const panel = getSearchPanel(props.panelId);
  if (!panel) return <p className="p-4 text-sm text-muted">This panel was closed.</p>;
  if (panel instanceof DocumentsView) return <DocumentsPanel view={panel} />;
  if (panel instanceof IndexView) return <IndexPanel view={panel} />;
  if (panel instanceof SqlView) return <SqlPanel view={panel} />;
  if (panel instanceof ClusterView) return <ClusterPanel view={panel} />;
  if (panel instanceof AdminView) return <AdminPanel view={panel} />;
  if (panel instanceof SnapshotsView) return <SnapshotsPanel view={panel} />;
  return <ConsolePanel console={panel} />;
}
