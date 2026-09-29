import { useSyncPanels } from '../../state/sync/panels';
import { DataComparePanel } from './DataComparePanel';
import { StructureComparePanel } from './StructureComparePanel';

/** A compare dock panel (spec §13): structure compare or data compare. */
export function SyncPanel(props: { readonly panelId: string }) {
  const entry = useSyncPanels((state) => state.panels[props.panelId]);
  if (!entry) return <p className="p-4 text-sm text-muted">This comparison was closed.</p>;
  return entry.kind === 'structure' ? (
    <StructureComparePanel model={entry.model} />
  ) : (
    <DataComparePanel model={entry.model} />
  );
}
