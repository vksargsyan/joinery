import {
  aliasActions,
  classifyRequest,
  compactJson,
  copyableSettings,
  formatJson,
  mappingFields,
  mappingRoot,
  nextIndexName,
  nodeText,
  planMappingChange,
  reindexPlan,
  type MappingField,
  type MappingPlan,
  type ReindexCutover,
  type ReindexPlan,
  type SearchAliasInfo,
  type SearchIndexSummary,
} from '@joinery/search-tools';

import { errorMessage } from '../../lib/errors';
import { formatCount } from '../../lib/format';
import { loadChildren } from '../explorer';
import { runReindexPlan, type ReindexRunState } from './reindex-run';
import { BASE_STATE, SearchView, type SearchViewState } from './view';

/**
 * One index's panel (spec §11): its health, documents, size and shards; open, close, refresh,
 * flush, force merge, clone, shrink and delete (destructive and blocking ones ask, and the
 * connection host checks again); its settings; its aliases; and the mapping editor. The editor
 * compares the proposed mapping with the current one: new fields apply in place, while a change
 * to an existing field cannot, so it offers a reindex plan instead (a new index with the
 * mapping, `_reindex` as a server task with live progress and cancel, then the aliases moved in
 * one call).
 */

export interface IndexTarget {
  readonly profileId: string;
  readonly index: string;
}

export type IndexTab = 'overview' | 'mappings' | 'settings' | 'aliases';

export type IndexAction = 'open' | 'close' | 'refresh' | 'flush' | 'forceMerge' | 'delete';

export interface ResizeRequest {
  readonly kind: 'clone' | 'shrink';
  readonly target: string;
  /** Shrink: the new number of primary shards (a factor of the current one). */
  readonly shards?: number;
  /** Lift the source's write block afterwards. */
  readonly unblockSource: boolean;
}

export interface IndexViewState extends SearchViewState {
  readonly tab: IndexTab;
  readonly loading: boolean;
  readonly summary: SearchIndexSummary | undefined;
  /** The index's settings, re-indented. */
  readonly settingsText: string | undefined;
  /** The current mapping (the `mappings` object), re-indented. */
  readonly mappingText: string | undefined;
  readonly fields: readonly MappingField[];
  readonly aliases: readonly SearchAliasInfo[];
  /** Every index name, for proposing a free name. */
  readonly indexNames: readonly string[];
  /** The mapping editor's text and what it would change. */
  readonly proposedText: string;
  readonly plan: MappingPlan | undefined;
  readonly planError: string | undefined;
  /** The reindex plan being reviewed, before it runs. */
  readonly reindex:
    | {
        readonly target: string;
        readonly cutover: ReindexCutover['kind'];
        readonly plan: ReindexPlan | undefined;
        readonly error: string | undefined;
      }
    | undefined;
  readonly run: ReindexRunState | undefined;
  readonly settingsDraft: string;
}

export class IndexView extends SearchView<IndexViewState> {
  readonly target: IndexTarget;
  #cancelRun = false;

  constructor(id: string, target: IndexTarget) {
    super(id, target.profileId, {
      ...BASE_STATE,
      tab: 'overview',
      loading: false,
      summary: undefined,
      settingsText: undefined,
      mappingText: undefined,
      fields: [],
      aliases: [],
      indexNames: [],
      proposedText: '',
      plan: undefined,
      planError: undefined,
      reindex: undefined,
      run: undefined,
      settingsDraft: '',
    });
    this.target = target;
  }

  get index(): string {
    return this.target.index;
  }

  async init(): Promise<void> {
    await this.loadBasics();
    await this.reload();
  }

  setTab(tab: IndexTab): void {
    this.set({ tab });
  }

  /** Reads the index's summary, settings, mapping and aliases again. */
  async reload(): Promise<void> {
    this.set({ loading: true });
    try {
      const [indices, settings, mapping, aliases] = await this.call((host, sessionId) =>
        Promise.all([
          host.search.indices.list({ sessionId, includeHidden: true }),
          host.search.indices.getSettings({ sessionId, index: this.index }),
          host.search.indices.getMapping({ sessionId, index: this.index }),
          host.search.aliases.list({ sessionId, includeHidden: true }),
        ]),
      );
      const root = mappingRoot(mapping);
      const mappingText = root ? formatJson(nodeText(mapping, root)) : '{}';
      const settingsText = formatJson(settings);
      this.set({
        summary: indices.find((i) => i.name === this.index),
        indexNames: indices.map((i) => i.name),
        settingsText,
        mappingText,
        fields: mappingFields(mapping),
        aliases: aliases.filter((a) => a.index === this.index),
        proposedText: this.state.proposedText === '' ? mappingText : this.state.proposedText,
        settingsDraft:
          this.state.settingsDraft === ''
            ? '{\n  "index": {\n    \n  }\n}'
            : this.state.settingsDraft,
      });
    } catch (error) {
      this.notify('error', errorMessage(error));
    } finally {
      this.set({ loading: false });
    }
  }

  // -------------------------------------------------------------------------------------------
  // Actions

  /** Open, close, refresh, flush, force merge or delete, under the write rules. */
  async act(action: IndexAction): Promise<void> {
    const index = this.index;
    const requests: Record<
      IndexAction,
      { method: 'POST' | 'DELETE'; path: string; title: string; label: string }
    > = {
      open: { method: 'POST', path: `/${index}/_open`, title: `Open ${index}?`, label: 'Open' },
      close: { method: 'POST', path: `/${index}/_close`, title: `Close ${index}?`, label: 'Close' },
      refresh: {
        method: 'POST',
        path: `/${index}/_refresh`,
        title: `Refresh ${index}?`,
        label: 'Refresh',
      },
      flush: { method: 'POST', path: `/${index}/_flush`, title: `Flush ${index}?`, label: 'Flush' },
      forceMerge: {
        method: 'POST',
        path: `/${index}/_forcemerge?max_num_segments=1`,
        title: `Force-merge ${index}?`,
        label: 'Force merge',
      },
      delete: { method: 'DELETE', path: `/${index}`, title: `Delete ${index}?`, label: 'Delete' },
    };
    const request = requests[action];
    const confirmed = await this.guard({
      safety: classifyRequest(request),
      title: request.title,
      detail: `${request.method} ${request.path}`,
      confirmLabel: request.label,
    });
    if (confirmed === undefined) return;
    const names = [index];
    await this.busy(async () => {
      await this.call(async (host, sessionId) => {
        switch (action) {
          case 'open':
            return host.search.indices.open({ sessionId, names, confirmed });
          case 'close':
            return host.search.indices.close({ sessionId, names, confirmed });
          case 'refresh':
            return host.search.indices.refresh({ sessionId, names, confirmed });
          case 'flush':
            return host.search.indices.flush({ sessionId, names, confirmed });
          case 'forceMerge':
            return host.search.indices.forceMerge({
              sessionId,
              names,
              maxNumSegments: 1,
              confirmed,
              timeoutMs: 3_600_000,
            });
          case 'delete':
            return host.search.indices.delete({ sessionId, names, confirmed });
        }
      });
      const past: Record<IndexAction, string> = {
        open: 'Opened',
        close: 'Closed',
        refresh: 'Refreshed',
        flush: 'Flushed',
        forceMerge: 'Force-merged',
        delete: 'Deleted',
      };
      void loadChildren(this.profileId, ['indices']);
      if (action !== 'delete') await this.reload();
      this.notify('success', `${past[action]} ${index}`);
    });
  }

  /** Clones or shrinks the index into a new one, blocking the source's writes first. */
  async resize(request: ResizeRequest): Promise<boolean> {
    const settings =
      request.kind === 'shrink' && request.shards !== undefined
        ? `{"index.number_of_shards": ${request.shards}}`
        : undefined;
    const steps = [
      `PUT /${this.index}/_settings\n{"index.blocks.write": true}`,
      `POST /${this.index}/_${request.kind}/${request.target}${settings ? `\n{"settings": ${settings}}` : ''}`,
      ...(request.unblockSource
        ? [`PUT /${this.index}/_settings\n{"index.blocks.write": null}`]
        : []),
    ];
    const confirmed = await this.guard({
      safety: { writes: true, destructive: `blocks writes to ${this.index} while it is copied` },
      title: `${request.kind === 'clone' ? 'Clone' : 'Shrink'} ${this.index} into ${request.target}?`,
      detail: steps.join('\n\n'),
      confirmLabel: request.kind === 'clone' ? 'Clone' : 'Shrink',
    });
    if (confirmed === undefined) return false;
    const done = await this.busy(async () => {
      await this.call((host, sessionId) =>
        host.search.indexAdmin.resize({
          sessionId,
          kind: request.kind,
          source: this.index,
          target: request.target,
          ...(settings !== undefined ? { settings } : {}),
          blockSource: true,
          unblockSource: request.unblockSource,
          confirmed,
          timeoutMs: 600_000,
        }),
      );
      void loadChildren(this.profileId, ['indices']);
      await this.reload();
      this.notify(
        'success',
        `${request.kind === 'clone' ? 'Cloned' : 'Shrank'} ${this.index} into ${request.target}`,
      );
      return true;
    });
    return done === true;
  }

  /** Changes settings of the open index (the settings editor). */
  async putSettings(body: string): Promise<void> {
    const request = { method: 'PUT' as const, path: `/${this.index}/_settings`, body };
    let compact: string;
    try {
      compact = compactJson(body);
    } catch (error) {
      this.notify('error', `The settings are not valid JSON: ${errorMessage(error)}`);
      return;
    }
    const confirmed = await this.guard({
      safety: classifyRequest(request),
      title: `Change the settings of ${this.index}?`,
      detail: `PUT ${request.path}\n${formatJson(compact)}`,
      confirmLabel: 'Apply',
    });
    if (confirmed === undefined) return;
    await this.busy(async () => {
      await this.call((host, sessionId) =>
        host.search.indices.putSettings({ sessionId, index: this.index, body: compact, confirmed }),
      );
      await this.reload();
      this.notify('success', 'Settings applied');
    });
  }

  setSettingsDraft(text: string): void {
    this.set({ settingsDraft: text });
  }

  // -------------------------------------------------------------------------------------------
  // Mapping editor

  setProposed(text: string): void {
    this.set({ proposedText: text, plan: undefined, planError: undefined, reindex: undefined });
  }

  /** Compares the proposed mapping with the current one. */
  check(): MappingPlan | undefined {
    try {
      const plan = planMappingChange(this.state.mappingText ?? '{}', this.state.proposedText);
      this.set({ plan, planError: undefined });
      return plan;
    } catch (error) {
      this.set({ plan: undefined, planError: errorMessage(error) });
      return undefined;
    }
  }

  /** Applies a proposed mapping that changes nothing existing (`PUT /<index>/_mapping`). */
  async applyMapping(): Promise<void> {
    const plan = this.check();
    if (!plan) return;
    if (!plan.inPlace || plan.putBody === undefined) {
      this.notify(
        'error',
        'Existing fields change: this mapping needs a reindex into a new index.',
      );
      return;
    }
    if (plan.changes.length === 0) {
      this.notify('info', 'The mapping is unchanged.');
      return;
    }
    const confirmed = await this.guard({
      safety: { writes: true },
      title: `Change the mapping of ${this.index}?`,
      detail: `PUT /${this.index}/_mapping\n${formatJson(plan.putBody)}`,
      confirmLabel: 'Apply',
    });
    if (confirmed === undefined) return;
    await this.busy(async () => {
      await this.call((host, sessionId) =>
        host.search.indices.putMapping({
          sessionId,
          index: this.index,
          body: plan.putBody!,
          confirmed,
        }),
      );
      this.set({ proposedText: '', plan: undefined });
      await this.reload();
      this.notify('success', `Mapping applied: ${formatCount(plan.changes.length)} changes`);
    });
  }

  /** Opens the reindex plan for the proposed mapping (or for a plain copy). */
  openReindex(): void {
    const aliases = this.state.aliases.map((a) => a.alias);
    const target = nextIndexName(this.index, this.state.indexNames);
    this.set({
      reindex: {
        target,
        cutover: aliases.length > 0 ? 'aliases' : 'none',
        plan: undefined,
        error: undefined,
      },
    });
    this.#planReindex();
  }

  setReindexTarget(target: string): void {
    const current = this.state.reindex;
    if (!current) return;
    this.set({ reindex: { ...current, target } });
    this.#planReindex();
  }

  setReindexCutover(cutover: ReindexCutover['kind']): void {
    const current = this.state.reindex;
    if (!current) return;
    this.set({ reindex: { ...current, cutover } });
    this.#planReindex();
  }

  #planReindex(): void {
    const current = this.state.reindex;
    if (!current) return;
    const aliases = this.state.aliases.map((a) => a.alias);
    const cutover: ReindexCutover =
      current.cutover === 'aliases'
        ? { kind: 'aliases', aliases }
        : current.cutover === 'replace'
          ? { kind: 'replace' }
          : { kind: 'none' };
    try {
      if (this.state.indexNames.includes(current.target)) {
        throw new Error(`${current.target} exists already; choose a new name`);
      }
      const plan = reindexPlan({
        source: this.index,
        target: current.target,
        mappings:
          this.state.proposedText.trim() === ''
            ? (this.state.mappingText ?? '{}')
            : this.state.proposedText,
        settings: copyableSettings(this.state.settingsText ?? '{}'),
        cutover,
      });
      this.set({ reindex: { ...current, plan, error: undefined } });
    } catch (error) {
      this.set({ reindex: { ...current, plan: undefined, error: errorMessage(error) } });
    }
  }

  closeReindex(): void {
    this.set({ reindex: undefined });
  }

  /** Runs the reviewed reindex plan after one confirmation for all its steps. */
  async runReindex(): Promise<void> {
    const plan = this.state.reindex?.plan;
    const target = this.state.reindex?.target;
    if (!plan || !target || this.state.run?.status === 'running') return;
    const destructive = plan.steps.find((s) => s.destructive !== undefined)?.destructive;
    const confirmed = await this.guard({
      safety: { writes: true, ...(destructive !== undefined ? { destructive } : {}) },
      title: `Reindex ${this.index} into ${target}?`,
      detail: plan.consoleText,
      confirmLabel: 'Run the plan',
    });
    if (confirmed === undefined) return;
    this.#cancelRun = false;
    this.set({ reindex: undefined });
    const source = this.index;
    const final = await runReindexPlan(
      plan,
      {
        run: (step) =>
          this.call(async (host, sessionId) => {
            if (step.kind === 'create') {
              await host.search.indices.create({
                sessionId,
                name: target,
                body: step.request.body!,
                confirmed,
              });
            } else if (step.kind === 'refresh') {
              await host.search.indices.refresh({ sessionId, names: [target], confirmed });
            } else {
              await host.search.aliases.update({
                sessionId,
                actions: step.request.body!,
                confirmed: true,
              });
            }
          }),
        start: () =>
          this.call(async (host, sessionId) => {
            const { taskId } = await host.search.indexAdmin.reindex({
              sessionId,
              source: [source],
              dest: target,
              confirmed,
            });
            return taskId;
          }),
        task: (taskId) =>
          this.call((host, sessionId) => host.search.tasks.get({ sessionId, taskId })),
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        cancelled: () => this.#cancelRun,
      },
      (run) => this.set({ run }),
    );
    void loadChildren(this.profileId, ['indices']);
    void loadChildren(this.profileId, ['aliases']);
    if (final.status === 'done') {
      this.set({ proposedText: '', plan: undefined });
      await this.reload();
      this.notify('success', `Reindexed ${source} into ${target}`);
    }
  }

  /** Cancels the running reindex task (the plan stops before moving aliases). */
  async cancelReindex(): Promise<void> {
    const run = this.state.run;
    if (!run || run.status !== 'running' || run.taskId === undefined) return;
    this.#cancelRun = true;
    try {
      await this.call((host, sessionId) =>
        host.search.tasks.cancel({ sessionId, taskId: run.taskId!, confirmed: true }),
      );
    } catch (error) {
      this.notify('error', errorMessage(error));
    }
  }

  dismissRun(): void {
    if (this.state.run?.status !== 'running') this.set({ run: undefined });
  }

  // -------------------------------------------------------------------------------------------
  // Aliases of this index

  /** Adds an alias to this index. */
  async addAlias(alias: string, isWriteIndex: boolean): Promise<void> {
    const actions = aliasActions(
      [{ index: this.index, alias, ...(isWriteIndex ? { isWriteIndex: true } : {}) }],
      [],
    );
    await this.#aliases(actions, `Add the alias ${alias} to ${this.index}?`);
  }

  async removeAlias(alias: string): Promise<void> {
    const actions = aliasActions([], [{ index: this.index, alias }]);
    await this.#aliases(actions, `Remove the alias ${alias} from ${this.index}?`);
  }

  async #aliases(actions: string, title: string): Promise<void> {
    const confirmed = await this.guard({
      safety: classifyRequest({ method: 'POST', path: '/_aliases', body: actions }),
      title,
      detail: `POST /_aliases\n${formatJson(actions)}`,
      confirmLabel: 'Apply',
    });
    if (confirmed === undefined) return;
    await this.busy(async () => {
      await this.call((host, sessionId) =>
        host.search.aliases.update({ sessionId, actions, confirmed }),
      );
      void loadChildren(this.profileId, ['aliases']);
      await this.reload();
      this.notify('success', 'Aliases changed');
    });
  }
}
