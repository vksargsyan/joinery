import { AggregationEditor } from '../../state/mongo/aggregation';
import { ChangeStreamViewer } from '../../state/mongo/change-stream';
import { CollectionOptions } from '../../state/mongo/collection-options';
import { CollectionView } from '../../state/mongo/collection-view';
import { GridFsBrowser } from '../../state/mongo/gridfs';
import { IndexManager } from '../../state/mongo/indexes';
import { getMongoPanel } from '../../state/mongo/panels';
import { SchemaPanelState } from '../../state/mongo/schema';
import { UsersRoles } from '../../state/mongo/users';
import { AggregationPanel } from './AggregationPanel';
import { ChangeStreamPanel } from './ChangeStreamPanel';
import { CollectionOptionsPanel } from './CollectionOptionsPanel';
import { CollectionPanel } from './CollectionPanel';
import { ConsolePanel } from './ConsolePanel';
import { GridFsPanel } from './GridFsPanel';
import { IndexesPanel } from './IndexesPanel';
import { SchemaPanel } from './SchemaPanel';
import { UsersPanel } from './UsersPanel';

/**
 * A MongoDB dock panel (spec §9): a collection view, a command console, or one of the tool
 * panels (aggregation, indexes, schema, options, change stream, GridFS, users and roles).
 */
export function MongoPanel(props: { readonly panelId: string }) {
  const panel = getMongoPanel(props.panelId);
  if (!panel) return <p className="p-4 text-sm text-muted">This panel was closed.</p>;
  if (panel instanceof CollectionView) return <CollectionPanel view={panel} />;
  if (panel instanceof AggregationEditor) return <AggregationPanel editor={panel} />;
  if (panel instanceof IndexManager) return <IndexesPanel manager={panel} />;
  if (panel instanceof SchemaPanelState) return <SchemaPanel panel={panel} />;
  if (panel instanceof CollectionOptions) return <CollectionOptionsPanel panel={panel} />;
  if (panel instanceof ChangeStreamViewer) return <ChangeStreamPanel viewer={panel} />;
  if (panel instanceof GridFsBrowser) return <GridFsPanel browser={panel} />;
  if (panel instanceof UsersRoles) return <UsersPanel panel={panel} />;
  return <ConsolePanel shell={panel} />;
}
