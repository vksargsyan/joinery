import { useRedisPanels } from '../../state/redis/panels';
import { CliPanel } from './CliPanel';
import { KeyBrowserPanel } from './KeyBrowserPanel';
import { DashboardPanel } from './tools/DashboardPanel';
import { PubSubPanel } from './tools/PubSubPanel';
import {
  AclPanel,
  BigKeysPanel,
  ClientsPanel,
  LatencyPanel,
  MonitorPanel,
  SlowLogPanel,
  TopologyPanel,
} from './tools/ServerTools';
import { ValueEditorPanel } from './ValueEditorPanel';

/** A Redis dock panel (spec §10): the key browser, a value editor, the CLI or a server tool. */
export function RedisPanel(props: { readonly panelId: string }) {
  const target = useRedisPanels((state) => state.targets[props.panelId]);
  if (!target) return <p className="p-4 text-sm text-muted">This panel was closed.</p>;
  const tool = { panelId: props.panelId, target };
  switch (target.tool) {
    case 'keys':
      return <KeyBrowserPanel {...tool} />;
    case 'value':
      return <ValueEditorPanel {...tool} />;
    case 'cli':
      return <CliPanel {...tool} />;
    case 'pubsub':
      return <PubSubPanel {...tool} />;
    case 'dashboard':
      return <DashboardPanel {...tool} />;
    case 'slowlog':
      return <SlowLogPanel {...tool} />;
    case 'clients':
      return <ClientsPanel {...tool} />;
    case 'latency':
      return <LatencyPanel {...tool} />;
    case 'monitor':
      return <MonitorPanel {...tool} />;
    case 'bigkeys':
      return <BigKeysPanel {...tool} />;
    case 'acl':
      return <AclPanel {...tool} />;
    case 'topology':
      return <TopologyPanel {...tool} />;
  }
}
