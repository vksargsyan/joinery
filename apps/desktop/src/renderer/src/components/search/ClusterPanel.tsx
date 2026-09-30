import { watermarkPercent } from '@joinery/search-tools';

import { formatCount, formatDuration } from '../../lib/format';
import {
  shardKey,
  visibleShards,
  type ClusterTab,
  type ClusterView,
} from '../../state/search/cluster';
import { useSearchView } from '../../state/search/view';
import { Button, Input, Modal, cx } from '../ui';
import { Facts, NoticeBar, Tabs, Toolbar, UsageBar, formatBytes } from './parts';
import { HealthBadge } from './SearchTree';

/**
 * The cluster panel (spec §11): health and nodes, shard allocation (problems first, with an
 * explanation for any shard), the disk watermarks against each node's disk, and the running
 * tasks with cancel.
 */

const TABS: readonly { id: ClusterTab; label: string }[] = [
  { id: 'overview', label: 'Health and nodes' },
  { id: 'shards', label: 'Shards' },
  { id: 'disk', label: 'Disk' },
  { id: 'tasks', label: 'Tasks' },
];

export function ClusterPanel({ view }: { readonly view: ClusterView }) {
  const tab = useSearchView(view, (s) => s.tab);
  const loading = useSearchView(view, (s) => s.loading);
  return (
    <div className="flex h-full flex-col bg-bg" data-testid="search-cluster">
      <Tabs tabs={TABS} active={tab} onSelect={(id) => view.setTab(id)} label="Cluster" />
      <Toolbar label="Cluster" onRefresh={() => void view.reload()} loading={loading} />
      <NoticeBar view={view} />
      <div className="min-h-0 flex-1 overflow-auto">
        {tab === 'overview' && <Overview view={view} />}
        {tab === 'shards' && <Shards view={view} />}
        {tab === 'disk' && <Disk view={view} />}
        {tab === 'tasks' && <Tasks view={view} />}
      </div>
      <ExplainDialog view={view} />
    </div>
  );
}

function Overview({ view }: { readonly view: ClusterView }) {
  const health = useSearchView(view, (s) => s.health);
  const nodes = useSearchView(view, (s) => s.nodes);
  const info = useSearchView(view, (s) => s.info);
  return (
    <div className="flex flex-col gap-4 p-4">
      {health && (
        <section aria-label="Health">
          <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold">
            <HealthBadge health={health.status} />
            <span data-testid="cluster-status">
              {health.clusterName}: {health.status}
            </span>
          </h3>
          <Facts
            items={[
              ...(info ? ([['Server', `${info.distribution} ${info.version}`]] as const) : []),
              ['Nodes', `${health.nodes} (${health.dataNodes} data)`],
              [
                'Active shards',
                `${formatCount(health.activeShards)} (${formatCount(health.activePrimaryShards)} primary) · ${health.activeShardsPercent.toFixed(1)}%`,
              ],
              ['Relocating', formatCount(health.relocatingShards)],
              ['Initializing', formatCount(health.initializingShards)],
              ['Unassigned', formatCount(health.unassignedShards)],
              ['Pending tasks', formatCount(health.pendingTasks)],
            ]}
          />
        </section>
      )}
      <section aria-label="Nodes">
        <h3 className="mb-2 text-sm font-semibold">Nodes</h3>
        <table className="w-full border-collapse text-xs" data-testid="cluster-nodes">
          <thead>
            <tr className="text-left text-muted">
              <th className="px-2 py-1">Name</th>
              <th className="px-2 py-1">Address</th>
              <th className="px-2 py-1">Roles</th>
              <th className="px-2 py-1">Heap</th>
              <th className="px-2 py-1">CPU</th>
              <th className="px-2 py-1">Load</th>
              <th className="px-2 py-1">Disk</th>
              <th className="px-2 py-1">Version</th>
            </tr>
          </thead>
          <tbody>
            {nodes.map((node) => (
              <tr key={node.name} className="border-t border-border">
                <td className="px-2 py-1 font-mono">
                  {node.name}
                  {node.master && (
                    <span className="ml-1 rounded bg-accent/15 px-1 text-[10px] text-accent">
                      master
                    </span>
                  )}
                </td>
                <td className="px-2 py-1 font-mono">{node.ip}</td>
                <td className="px-2 py-1 font-mono">{node.roles}</td>
                <td className="w-28 px-2 py-1">
                  <UsageBar percent={node.heapPercent} label={`${node.name} heap`} />
                </td>
                <td className="px-2 py-1">
                  {node.cpuPercent === null ? '—' : `${node.cpuPercent}%`}
                </td>
                <td className="px-2 py-1">{node.load1m === null ? '—' : node.load1m}</td>
                <td className="w-28 px-2 py-1">
                  <UsageBar percent={node.diskUsedPercent} label={`${node.name} disk`} />
                </td>
                <td className="px-2 py-1">{node.version}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}

function Shards({ view }: { readonly view: ClusterView }) {
  const shards = useSearchView(view, (s) => s.shards);
  const filter = useSearchView(view, (s) => s.shardFilter);
  const problemsOnly = useSearchView(view, (s) => s.problemsOnly);
  const shown = visibleShards(shards, filter, problemsOnly);
  const unassigned = shards.filter((s) => s.state === 'UNASSIGNED').length;
  return (
    <div className="flex flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-1.5 text-xs">
        <Input
          value={filter}
          onChange={(e) => view.setShardFilter(e.target.value)}
          placeholder="Filter by index"
          aria-label="Filter shards by index"
          className="h-7 w-56"
        />
        <label className="flex items-center gap-1">
          <input
            type="checkbox"
            checked={problemsOnly}
            onChange={(e) => view.setProblemsOnly(e.target.checked)}
          />
          Only shards that are not started
        </label>
        <span className="text-muted">
          {formatCount(shards.length)} shard copies · {formatCount(unassigned)} unassigned
        </span>
        <span className="flex-1" />
        <Button
          size="sm"
          variant="ghost"
          disabled={unassigned === 0}
          onClick={() => void view.explainShard()}
        >
          Explain the first unassigned
        </Button>
      </div>
      <table className="w-full border-collapse text-xs" data-testid="cluster-shards">
        <thead className="sticky top-0 bg-panel">
          <tr className="text-left text-muted">
            <th className="px-2 py-1">Index</th>
            <th className="px-2 py-1">Shard</th>
            <th className="px-2 py-1">Copy</th>
            <th className="px-2 py-1">State</th>
            <th className="px-2 py-1">Node</th>
            <th className="px-2 py-1">Documents</th>
            <th className="px-2 py-1">Size</th>
            <th className="px-2 py-1" aria-label="Explain" />
          </tr>
        </thead>
        <tbody>
          {shown.map((shard) => (
            <tr
              key={shardKey(shard)}
              className="border-t border-border"
              data-shard-state={shard.state}
            >
              <td className="px-2 py-0.5 font-mono">{shard.index}</td>
              <td className="px-2 py-0.5">{shard.shard}</td>
              <td className="px-2 py-0.5">{shard.primary ? 'primary' : 'replica'}</td>
              <td
                className={cx(
                  'px-2 py-0.5',
                  shard.state === 'UNASSIGNED'
                    ? 'text-danger'
                    : shard.state !== 'STARTED' && 'text-warning',
                )}
              >
                {shard.state.toLowerCase()}
                {shard.unassignedReason ? ` (${shard.unassignedReason})` : ''}
              </td>
              <td className="px-2 py-0.5 font-mono">{shard.node ?? '—'}</td>
              <td className="px-2 py-0.5">{shard.docs === null ? '—' : formatCount(shard.docs)}</td>
              <td className="px-2 py-0.5">
                {shard.storeBytes === null ? '—' : formatBytes(shard.storeBytes)}
              </td>
              <td className="px-2 py-0.5 text-right">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    void view.explainShard({
                      index: shard.index,
                      shard: shard.shard,
                      primary: shard.primary,
                    })
                  }
                >
                  Explain
                </Button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** "95%, or once less than 100GB is free" for a watermark with a headroom cap. */
function withHeadroom(watermark: string, headroom: string | undefined): string {
  return headroom !== undefined && headroom !== '-1'
    ? `${watermark}, or once less than ${headroom} is free`
    : watermark;
}

function Disk({ view }: { readonly view: ClusterView }) {
  const disk = useSearchView(view, (s) => s.disk);
  if (!disk) return <p className="p-4 text-xs text-muted">Loading…</p>;
  const marks = [
    { label: 'low', value: disk.low },
    { label: 'high', value: disk.high },
    { label: 'flood stage', value: disk.floodStage },
  ];
  const markers = marks.flatMap((m) => {
    const at = watermarkPercent(m.value);
    return at === undefined ? [] : [{ at, label: m.label }];
  });
  return (
    <div className="flex flex-col gap-4 p-4">
      <section aria-label="Watermarks">
        <h3 className="mb-2 text-sm font-semibold">Disk watermarks</h3>
        <Facts
          testId="cluster-watermarks"
          items={[
            [
              'Threshold checks',
              disk.thresholdEnabled ? 'on' : 'off: shards are allocated whatever the disk use',
            ],
            ['Low (no new replicas above)', withHeadroom(disk.low, disk.maxHeadroom?.low)],
            ['High (shards move away above)', withHeadroom(disk.high, disk.maxHeadroom?.high)],
            [
              'Flood stage (indices turn read-only above)',
              withHeadroom(disk.floodStage, disk.maxHeadroom?.floodStage),
            ],
            ['Unassigned shards', formatCount(disk.unassignedShards)],
          ]}
        />
        {markers.length < marks.length && (
          <p className="mt-1 text-[11px] text-muted">
            Watermarks given as free space (not percentages) depend on each disk&rsquo;s size, so
            the bars show only the percentage ones.
          </p>
        )}
      </section>
      <section aria-label="Node disks">
        <h3 className="mb-2 text-sm font-semibold">Node disks</h3>
        <table className="w-full border-collapse text-xs" data-testid="cluster-disks">
          <thead>
            <tr className="text-left text-muted">
              <th className="px-2 py-1">Node</th>
              <th className="px-2 py-1">Shards</th>
              <th className="w-1/3 px-2 py-1">Used</th>
              <th className="px-2 py-1">Used / total</th>
              <th className="px-2 py-1">Free</th>
            </tr>
          </thead>
          <tbody>
            {disk.nodes.map((node) => (
              <tr key={node.node} className="border-t border-border">
                <td className="px-2 py-1 font-mono">{node.node}</td>
                <td className="px-2 py-1">{formatCount(node.shards)}</td>
                <td className="px-2 py-1">
                  <UsageBar
                    percent={node.diskPercent}
                    markers={markers}
                    label={`${node.node} disk used`}
                  />
                </td>
                <td className="px-2 py-1">
                  {node.diskUsedBytes === null || node.diskTotalBytes === null
                    ? '—'
                    : `${formatBytes(node.diskUsedBytes)} / ${formatBytes(node.diskTotalBytes)} (${node.diskPercent ?? '?'}%)`}
                </td>
                <td className="px-2 py-1">
                  {node.diskAvailableBytes === null ? '—' : formatBytes(node.diskAvailableBytes)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}

function Tasks({ view }: { readonly view: ClusterView }) {
  const tasks = useSearchView(view, (s) => s.tasks);
  const readOnly = useSearchView(view, (s) => s.policy?.readOnly ?? false);
  return (
    <table className="w-full border-collapse text-xs" data-testid="cluster-tasks">
      <thead className="sticky top-0 bg-panel">
        <tr className="text-left text-muted">
          <th className="px-2 py-1">Task</th>
          <th className="px-2 py-1">Action</th>
          <th className="px-2 py-1">Running for</th>
          <th className="px-2 py-1">Progress</th>
          <th className="px-2 py-1">Description</th>
          <th className="px-2 py-1" aria-label="Cancel" />
        </tr>
      </thead>
      <tbody>
        {tasks.length === 0 && (
          <tr>
            <td colSpan={6} className="px-2 py-2 text-muted">
              No tasks are running.
            </td>
          </tr>
        )}
        {tasks.map((task) => (
          <tr key={task.id} className="border-t border-border">
            <td className="px-2 py-0.5 font-mono">{task.id}</td>
            <td className="px-2 py-0.5 font-mono">{task.action}</td>
            <td className="px-2 py-0.5">
              {task.runningTimeMs === undefined ? '—' : formatDuration(task.runningTimeMs)}
            </td>
            <td className="px-2 py-0.5">
              {task.progress
                ? `${formatCount(task.progress.created + task.progress.updated + task.progress.deleted)} / ${formatCount(task.progress.total)}`
                : ''}
            </td>
            <td className="max-w-96 truncate px-2 py-0.5" title={task.description}>
              {task.description ?? ''}
            </td>
            <td className="px-2 py-0.5 text-right">
              {task.cancellable && !task.cancelled && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-danger"
                  disabled={readOnly}
                  onClick={() => void view.cancelTask(task)}
                >
                  Cancel…
                </Button>
              )}
              {task.cancelled && <span className="text-muted">cancelling</span>}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function ExplainDialog({ view }: { readonly view: ClusterView }) {
  const explain = useSearchView(view, (s) => s.explain);
  if (!explain) return null;
  const result = explain.result;
  const title = explain.shard
    ? `Shard ${explain.shard.shard} of ${explain.shard.index} (${explain.shard.primary ? 'primary' : 'replica'})`
    : 'The first unassigned shard';
  return (
    <Modal
      open
      onOpenChange={(open) => !open && view.closeExplain()}
      title={`Allocation: ${title}`}
      width="w-[760px]"
      footer={
        <Button variant="primary" onClick={() => view.closeExplain()}>
          Close
        </Button>
      }
    >
      <div className="flex flex-col gap-3 text-xs" data-testid="allocation-explain">
        {explain.loading && <p className="text-muted">Asking the cluster…</p>}
        {explain.error && <p className="text-danger">{explain.error}</p>}
        {result && (
          <>
            <Facts
              items={[
                [
                  'Shard',
                  `${result.index} [${result.shard}] ${result.primary ? 'primary' : 'replica'}`,
                ],
                ['State', result.currentState],
                ...(result.currentNode ? ([['Node', result.currentNode]] as const) : []),
                ...(result.unassignedReason
                  ? ([['Unassigned because', result.unassignedReason]] as const)
                  : []),
                ...(result.unassignedDetails
                  ? ([['Details', result.unassignedDetails]] as const)
                  : []),
                ...(result.canAllocate ? ([['Can allocate', result.canAllocate]] as const) : []),
              ]}
            />
            {result.explanation && <p className="rounded bg-panel-2 p-2">{result.explanation}</p>}
            {result.decisions.length > 0 && (
              <table className="w-full border-collapse">
                <thead>
                  <tr className="text-left text-muted">
                    <th className="px-2 py-1">Node</th>
                    <th className="px-2 py-1">Decision</th>
                    <th className="px-2 py-1">Why</th>
                  </tr>
                </thead>
                <tbody>
                  {result.decisions.map((decision) => (
                    <tr key={decision.node} className="border-t border-border align-top">
                      <td className="px-2 py-1 font-mono">{decision.node}</td>
                      <td className={cx('px-2 py-1', decision.decision === 'no' && 'text-danger')}>
                        {decision.decision}
                      </td>
                      <td className="px-2 py-1">
                        {decision.reasons.map((reason) => (
                          <p key={reason}>{reason}</p>
                        ))}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}
