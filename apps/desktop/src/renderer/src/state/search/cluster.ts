import type {
  SearchAllocationExplain,
  SearchClusterHealth,
  SearchDiskAllocation,
  SearchNodeSummary,
  SearchShardInfo,
  SearchTaskStatus,
} from '@querybara/search-tools';

import { errorInfo, errorMessage } from '../../lib/errors';
import { BASE_STATE, SearchView, type SearchViewState } from './view';

/**
 * The cluster panel (spec §11): health, the nodes with heap, CPU, load and disk, shard
 * allocation with an explanation for any shard (unassigned ones first), the disk watermarks
 * against each node's disk, and the running tasks with cancel.
 */

export type ClusterTab = 'overview' | 'shards' | 'disk' | 'tasks';

export interface ClusterState extends SearchViewState {
  readonly tab: ClusterTab;
  readonly loading: boolean;
  readonly health: SearchClusterHealth | undefined;
  readonly nodes: readonly SearchNodeSummary[];
  readonly shards: readonly SearchShardInfo[];
  /** Show only shards that are not started. */
  readonly problemsOnly: boolean;
  readonly shardFilter: string;
  readonly disk: SearchDiskAllocation | undefined;
  readonly tasks: readonly SearchTaskStatus[];
  readonly explain:
    | {
        readonly shard:
          { readonly index: string; readonly shard: number; readonly primary: boolean } | undefined;
        readonly loading: boolean;
        readonly result: SearchAllocationExplain | undefined;
        readonly error: string | undefined;
      }
    | undefined;
}

/** A shard's key in the list. */
export function shardKey(
  shard: Pick<SearchShardInfo, 'index' | 'shard' | 'primary' | 'node'>,
): string {
  return `${shard.index}\u0000${shard.shard}\u0000${shard.primary ? 'p' : 'r'}\u0000${shard.node ?? ''}`;
}

/** The shards the list shows: problems first, then by index and shard. */
export function visibleShards(
  shards: readonly SearchShardInfo[],
  filter: string,
  problemsOnly: boolean,
): SearchShardInfo[] {
  const needle = filter.trim().toLowerCase();
  const rank = (s: SearchShardInfo): number =>
    s.state === 'UNASSIGNED' ? 0 : s.state === 'STARTED' ? 2 : 1;
  return shards
    .filter((s) => (problemsOnly ? s.state !== 'STARTED' : true))
    .filter((s) => needle === '' || s.index.toLowerCase().includes(needle))
    .sort(
      (a, b) =>
        rank(a) - rank(b) ||
        a.index.localeCompare(b.index) ||
        a.shard - b.shard ||
        Number(b.primary) - Number(a.primary),
    );
}

export class ClusterView extends SearchView<ClusterState> {
  constructor(id: string, profileId: string) {
    super(id, profileId, {
      ...BASE_STATE,
      tab: 'overview',
      loading: false,
      health: undefined,
      nodes: [],
      shards: [],
      problemsOnly: false,
      shardFilter: '',
      disk: undefined,
      tasks: [],
      explain: undefined,
    });
  }

  async init(): Promise<void> {
    await this.loadBasics();
    await this.reload();
  }

  setTab(tab: ClusterTab): void {
    this.set({ tab });
    if (tab === 'tasks') void this.loadTasks();
  }

  setProblemsOnly(problemsOnly: boolean): void {
    this.set({ problemsOnly });
  }

  setShardFilter(shardFilter: string): void {
    this.set({ shardFilter });
  }

  /** Reads health, nodes, shards and disk again; each part fails on its own. */
  async reload(): Promise<void> {
    this.set({ loading: true, notice: undefined });
    const problems: string[] = [];
    const attempt = async <T>(what: string, task: () => Promise<T>): Promise<T | undefined> => {
      try {
        return await task();
      } catch (error) {
        problems.push(`${what}: ${errorMessage(error)}`);
        return undefined;
      }
    };
    const [health, nodes, shards, disk] = await Promise.all([
      attempt('Health', () =>
        this.call((host, sessionId) => host.search.clusterHealth({ sessionId })),
      ),
      attempt('Nodes', () => this.call((host, sessionId) => host.search.nodes({ sessionId }))),
      attempt('Shards', () =>
        this.call((host, sessionId) => host.search.allocation.shards({ sessionId })),
      ),
      attempt('Disk', () =>
        this.call((host, sessionId) => host.search.allocation.disk({ sessionId })),
      ),
    ]);
    this.set({
      loading: false,
      ...(health ? { health } : {}),
      ...(nodes ? { nodes } : {}),
      ...(shards ? { shards } : {}),
      ...(disk ? { disk } : {}),
    });
    if (problems.length > 0) this.notify('error', problems.join(' · '));
    if (this.state.tab === 'tasks') await this.loadTasks();
  }

  async loadTasks(): Promise<void> {
    try {
      const tasks = await this.call((host, sessionId) => host.search.tasks.list({ sessionId }));
      this.set({ tasks });
    } catch (error) {
      this.notify('error', errorMessage(error));
    }
  }

  /** Explains a shard's allocation; without one, the first unassigned shard. */
  async explainShard(shard?: { index: string; shard: number; primary: boolean }): Promise<void> {
    this.set({ explain: { shard, loading: true, result: undefined, error: undefined } });
    try {
      const result = await this.call((host, sessionId) =>
        host.search.allocation.explain({ sessionId, ...(shard ? { shard } : {}) }),
      );
      this.set({ explain: { shard, loading: false, result, error: undefined } });
    } catch (error) {
      const info = errorInfo(error);
      this.set({
        explain: {
          shard,
          loading: false,
          result: undefined,
          error: info.hint ? `${info.message}. ${info.hint}` : info.message,
        },
      });
    }
  }

  closeExplain(): void {
    this.set({ explain: undefined });
  }

  /** Cancels a task after a confirmation (the write rules apply). */
  async cancelTask(task: SearchTaskStatus): Promise<void> {
    const confirmed = await this.guard({
      safety: { writes: true },
      title: `Cancel the task ${task.id}?`,
      detail: `POST /_tasks/${task.id}/_cancel\n${task.description ?? task.action}`,
      confirmLabel: 'Cancel the task',
    });
    if (confirmed === undefined) return;
    await this.busy(async () => {
      await this.call((host, sessionId) =>
        host.search.tasks.cancel({ sessionId, taskId: task.id, confirmed }),
      );
      await this.loadTasks();
      this.notify('success', `Asked ${task.id} to stop`);
    });
  }
}
