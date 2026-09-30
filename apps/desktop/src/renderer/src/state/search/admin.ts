import {
  aliasActions,
  aliasSwapActions,
  classifyRequest,
  compactJson,
  formatJson,
  resourcePath,
  resourcePutRequest,
  type SearchAliasInfo,
  type SearchResourceInfo,
  type SearchResourceKind,
  type SearchSimulatedDocument,
} from '@joinery/search-tools';

import { errorMessage } from '../../lib/errors';
import { loadChildren } from '../explorer';
import { BASE_STATE, SearchView, type SearchViewState } from './view';

/**
 * Templates, lifecycle policies, pipelines and aliases (spec §11), one tab each: aliases with
 * add, remove and an atomic swap; index, component and legacy templates; ILM policies, where
 * the cluster has index lifecycle management; and ingest pipelines with a
 * simulate panel that runs sample documents through the edited pipeline, processor by
 * processor. Each resource is edited as the JSON its PUT takes; saving and deleting follow the
 * write rules.
 */

export type AdminTab = 'aliases' | SearchResourceKind;

export interface AdminTarget {
  readonly profileId: string;
  readonly tab?: AdminTab;
}

/** What a tab calls its resources. */
export const RESOURCE_LABELS: Readonly<Record<SearchResourceKind, { one: string; many: string }>> =
  {
    'index-template': { one: 'index template', many: 'Index templates' },
    'component-template': { one: 'component template', many: 'Component templates' },
    'legacy-template': { one: 'legacy template', many: 'Legacy templates' },
    'lifecycle-policy': { one: 'lifecycle policy', many: 'Lifecycle policies' },
    'ingest-pipeline': { one: 'ingest pipeline', many: 'Ingest pipelines' },
    'snapshot-repository': { one: 'snapshot repository', many: 'Snapshot repositories' },
  };

/** The body a new resource starts from. */
export function resourceTemplate(kind: SearchResourceKind): string {
  switch (kind) {
    case 'index-template':
      return '{\n  "index_patterns": ["logs-*"],\n  "priority": 100,\n  "template": {\n    "settings": { "number_of_shards": 1 },\n    "mappings": { "properties": {} }\n  }\n}';
    case 'component-template':
      return '{\n  "template": {\n    "settings": {},\n    "mappings": { "properties": {} }\n  }\n}';
    case 'legacy-template':
      return '{\n  "index_patterns": ["logs-*"],\n  "order": 0,\n  "settings": {},\n  "mappings": { "properties": {} }\n}';
    case 'lifecycle-policy':
      return '{\n  "policy": {\n    "phases": {\n      "hot": { "actions": { "rollover": { "max_age": "7d" } } },\n      "delete": { "min_age": "30d", "actions": { "delete": {} } }\n    }\n  }\n}';
    case 'ingest-pipeline':
      return '{\n  "description": "",\n  "processors": [\n    { "set": { "field": "ingested", "value": "{{_ingest.timestamp}}" } }\n  ]\n}';
    case 'snapshot-repository':
      return '{\n  "type": "fs",\n  "settings": { "location": "" }\n}';
  }
}

export interface AdminState extends SearchViewState {
  readonly tab: AdminTab;
  readonly loading: boolean;
  readonly resources: readonly SearchResourceInfo[];
  readonly aliases: readonly SearchAliasInfo[];
  readonly indexNames: readonly string[];
  /** The resource being edited: an existing one or a new one (`isNew`). */
  readonly selected:
    | {
        readonly name: string;
        readonly isNew: boolean;
        readonly text: string;
      }
    | undefined;
  /** The pipeline simulator's documents and results. */
  readonly simulateDocs: string;
  readonly simulating: boolean;
  readonly simulation: readonly SearchSimulatedDocument[] | undefined;
  readonly simulateError: string | undefined;
}

export class AdminView extends SearchView<AdminState> {
  constructor(id: string, target: AdminTarget) {
    super(id, target.profileId, {
      ...BASE_STATE,
      tab: target.tab ?? 'aliases',
      loading: false,
      resources: [],
      aliases: [],
      indexNames: [],
      selected: undefined,
      simulateDocs: '[\n  { "message": "Hello" }\n]',
      simulating: false,
      simulation: undefined,
      simulateError: undefined,
    });
  }

  async init(): Promise<void> {
    await this.loadBasics();
    await this.reload();
  }

  /** The tabs the cluster supports (capability flags). */
  get tabs(): AdminTab[] {
    const caps = this.state.info?.capabilities;
    return [
      'aliases',
      ...(caps?.composableTemplates !== false
        ? (['index-template', 'component-template'] as const)
        : []),
      'legacy-template',
      ...(caps === undefined || caps.lifecycle ? (['lifecycle-policy'] as const) : []),
      'ingest-pipeline',
    ];
  }

  async setTab(tab: AdminTab): Promise<void> {
    this.set({
      tab,
      selected: undefined,
      resources: [],
      simulation: undefined,
      simulateError: undefined,
    });
    await this.reload();
  }

  async reload(): Promise<void> {
    const tab = this.state.tab;
    this.set({ loading: true });
    try {
      if (tab === 'aliases') {
        const [aliases, indices] = await this.call((host, sessionId) =>
          Promise.all([
            host.search.aliases.list({ sessionId }),
            host.search.indices.list({ sessionId }),
          ]),
        );
        if (this.state.tab === tab) {
          this.set({ aliases, indexNames: indices.map((i) => i.name) });
        }
      } else {
        const resources = await this.call((host, sessionId) =>
          host.search.resources.list({ sessionId, kind: tab }),
        );
        if (this.state.tab === tab) this.set({ resources });
      }
    } catch (error) {
      this.notify('error', errorMessage(error));
    } finally {
      this.set({ loading: false });
    }
  }

  // -------------------------------------------------------------------------------------------
  // Resources

  select(name: string): void {
    const resource = this.state.resources.find((r) => r.name === name);
    if (!resource) return;
    this.set({
      selected: { name, isNew: false, text: formatJson(resource.body) },
      simulation: undefined,
      simulateError: undefined,
    });
  }

  startNew(): void {
    const tab = this.state.tab;
    if (tab === 'aliases') return;
    this.set({
      selected: { name: '', isNew: true, text: resourceTemplate(tab) },
      simulation: undefined,
    });
  }

  setName(name: string): void {
    const selected = this.state.selected;
    if (selected?.isNew) this.set({ selected: { ...selected, name } });
  }

  setText(text: string): void {
    const selected = this.state.selected;
    if (selected) this.set({ selected: { ...selected, text } });
  }

  /** Saves the edited resource (create or replace), under the write rules. */
  async save(): Promise<boolean> {
    const tab = this.state.tab;
    const selected = this.state.selected;
    if (tab === 'aliases' || !selected) return false;
    const name = selected.name.trim();
    if (name === '') {
      this.notify('error', `Name the ${RESOURCE_LABELS[tab].one}.`);
      return false;
    }
    let body: string;
    try {
      body = compactJson(selected.text);
    } catch (error) {
      this.notify('error', `The definition is not valid JSON: ${errorMessage(error)}`);
      return false;
    }
    const request = resourcePutRequest(tab, name, body);
    const confirmed = await this.guard({
      safety: { writes: true },
      title: `${selected.isNew ? 'Create' : 'Replace'} the ${RESOURCE_LABELS[tab].one} ${name}?`,
      detail: `PUT ${request.path}\n${formatJson(body)}`,
      confirmLabel: 'Save',
    });
    if (confirmed === undefined) return false;
    const done = await this.busy(async () => {
      await this.call((host, sessionId) =>
        host.search.resources.put({
          sessionId,
          kind: tab,
          name,
          body,
          confirmed,
        }),
      );
      this.set({ selected: { name, isNew: false, text: formatJson(body) } });
      await this.reload();
      this.notify('success', `Saved the ${RESOURCE_LABELS[tab].one} ${name}`);
      return true;
    });
    return done === true;
  }

  async remove(name: string): Promise<void> {
    const tab = this.state.tab;
    if (tab === 'aliases') return;
    const request = {
      method: 'DELETE' as const,
      path: resourcePath(tab, name),
    };
    const confirmed = await this.guard({
      safety: classifyRequest(request),
      title: `Delete the ${RESOURCE_LABELS[tab].one} ${name}?`,
      detail: `DELETE ${request.path}`,
      confirmLabel: 'Delete',
    });
    if (confirmed === undefined) return;
    await this.busy(async () => {
      await this.call((host, sessionId) =>
        host.search.resources.delete({ sessionId, kind: tab, name, confirmed }),
      );
      if (this.state.selected?.name === name) this.set({ selected: undefined });
      await this.reload();
      this.notify('success', `Deleted the ${RESOURCE_LABELS[tab].one} ${name}`);
    });
  }

  // -------------------------------------------------------------------------------------------
  // Pipeline simulation

  setSimulateDocs(text: string): void {
    this.set({ simulateDocs: text });
  }

  /** Runs the sample documents through the edited pipeline (not the stored one). */
  async simulate(): Promise<void> {
    const selected = this.state.selected;
    if (this.state.tab !== 'ingest-pipeline' || !selected) return;
    let pipeline: string;
    try {
      pipeline = compactJson(selected.text);
    } catch (error) {
      this.set({ simulateError: `The pipeline is not valid JSON: ${errorMessage(error)}` });
      return;
    }
    this.set({ simulating: true, simulateError: undefined });
    try {
      const simulation = await this.call((host, sessionId) =>
        host.search.pipelines.simulate({
          sessionId,
          pipeline,
          docs: this.state.simulateDocs,
          verbose: true,
        }),
      );
      this.set({ simulation });
    } catch (error) {
      this.set({ simulation: undefined, simulateError: errorMessage(error) });
    } finally {
      this.set({ simulating: false });
    }
  }

  // -------------------------------------------------------------------------------------------
  // Aliases

  async #aliases(actions: string, title: string): Promise<boolean> {
    const confirmed = await this.guard({
      safety: classifyRequest({ method: 'POST', path: '/_aliases', body: actions }),
      title,
      detail: `POST /_aliases\n${formatJson(actions)}`,
      confirmLabel: 'Apply',
    });
    if (confirmed === undefined) return false;
    const done = await this.busy(async () => {
      await this.call((host, sessionId) =>
        host.search.aliases.update({ sessionId, actions, confirmed }),
      );
      void loadChildren(this.profileId, ['aliases']);
      await this.reload();
      this.notify('success', 'Aliases changed');
      return true;
    });
    return done === true;
  }

  /** Adds an alias to indices (optionally the write index, with a filter). */
  async addAlias(input: {
    readonly alias: string;
    readonly indices: readonly string[];
    readonly isWriteIndex: boolean;
    readonly filter: string;
  }): Promise<boolean> {
    const alias = input.alias.trim();
    if (alias === '' || input.indices.length === 0) {
      this.notify('error', 'Name the alias and at least one index.');
      return false;
    }
    let actions: string;
    try {
      actions = aliasActions(
        input.indices.map((index, i) => ({
          index,
          alias,
          ...(input.isWriteIndex && i === 0 ? { isWriteIndex: true } : {}),
          ...(input.filter.trim() !== '' ? { filter: input.filter } : {}),
        })),
        [],
      );
    } catch (error) {
      this.notify('error', `The filter is not valid JSON: ${errorMessage(error)}`);
      return false;
    }
    return this.#aliases(actions, `Add the alias ${alias}?`);
  }

  async removeAlias(alias: string, index: string): Promise<boolean> {
    return this.#aliases(aliasActions([], [{ index, alias }]), `Remove ${alias} from ${index}?`);
  }

  /** Moves an alias from every index it points at to `to`, in one atomic call. */
  async swapAlias(alias: string, to: string): Promise<boolean> {
    const from = this.state.aliases.filter((a) => a.alias === alias).map((a) => a.index);
    if (to === '' || (from.length === 1 && from[0] === to)) return false;
    return this.#aliases(aliasSwapActions(alias, from, to), `Move ${alias} to ${to}?`);
  }
}
