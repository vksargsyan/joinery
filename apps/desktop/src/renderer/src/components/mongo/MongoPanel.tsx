import { CollectionView } from '../../state/mongo/collection-view';
import { getMongoPanel } from '../../state/mongo/panels';
import { CollectionPanel } from './CollectionPanel';
import { ConsolePanel } from './ConsolePanel';

/** A MongoDB dock panel: a collection view or a command console (spec §9). */
export function MongoPanel(props: { readonly panelId: string }) {
  const panel = getMongoPanel(props.panelId);
  if (!panel) return <p className="p-4 text-sm text-muted">This panel was closed.</p>;
  return panel instanceof CollectionView ? (
    <CollectionPanel view={panel} />
  ) : (
    <ConsolePanel shell={panel} />
  );
}
