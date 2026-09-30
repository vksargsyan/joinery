import {
  classifyRequest,
  formatJson,
  restoreBody,
  restoredNames,
  snapshotBody,
  type RestoreOptions,
  type SearchResourceInfo,
  type SearchSnapshotInfo,
} from '@joinery/search-tools';

import { errorMessage } from '../../lib/errors';
import { formatCount } from '../../lib/format';
import { loadChildren } from '../explorer';
import { BASE_STATE, SearchView, type SearchViewState } from './view';

/**
 * Snapshot repositories and snapshots (spec §11): register a repository (a shared file system
 * path the nodes allow in `path.repo`, or a read-only URL), verify it, and list its snapshots;
 * create a snapshot of chosen indices, restore one (with a rename pattern, so a restore can sit
 * beside the live indices), and delete one. Snapshots run on the server; the list refreshes
 * while one is in progress. Restores and deletes are destructive and always ask.
 */

export interface SnapshotsState extends SearchViewState {
  readonly loading: boolean;
  readonly repositories: readonly SearchResourceInfo[];
  readonly repository: string | undefined;
  readonly snapshots: readonly SearchSnapshotInfo[];
  readonly loadingSnapshots: boolean;
  readonly indexNames: readonly string[];
}

/** How often the list refreshes while a snapshot runs. */
const POLL_MS = 2000;

/** A repository definition from the dialog's fields. */
export function repositoryBody(type: 'fs' | 'url', location: string, readonly: boolean): string {
  const setting = type === 'fs' ? 'location' : 'url';
  return `{"type": ${JSON.stringify(type)}, "settings": {${JSON.stringify(setting)}: ${JSON.stringify(location)}${type === 'fs' && readonly ? ', "readonly": true' : ''}}}`;
}

export class SnapshotsView extends SearchView<SnapshotsState> {
  #poll: ReturnType<typeof setTimeout> | undefined;
  #disposed = false;

  constructor(id: string, profileId: string) {
    super(id, profileId, {
      ...BASE_STATE,
      loading: false,
      repositories: [],
      repository: undefined,
      snapshots: [],
      loadingSnapshots: false,
      indexNames: [],
    });
  }

  async init(): Promise<void> {
    await this.loadBasics();
    await this.reload();
  }

  async reload(): Promise<void> {
    this.set({ loading: true });
    try {
      const [repositories, indices] = await this.call((host, sessionId) =>
        Promise.all([
          host.search.resources.list({ sessionId, kind: 'snapshot-repository' }),
          host.search.indices.list({ sessionId }),
        ]),
      );
      const repository =
        this.state.repository !== undefined &&
        repositories.some((r) => r.name === this.state.repository)
          ? this.state.repository
          : repositories[0]?.name;
      this.set({ repositories, repository, indexNames: indices.map((i) => i.name) });
      await this.loadSnapshots();
    } catch (error) {
      this.notify('error', errorMessage(error));
    } finally {
      this.set({ loading: false });
    }
  }

  async selectRepository(name: string): Promise<void> {
    this.set({ repository: name, snapshots: [] });
    await this.loadSnapshots();
  }

  async loadSnapshots(): Promise<void> {
    const repository = this.state.repository;
    if (repository === undefined) {
      this.set({ snapshots: [] });
      return;
    }
    this.set({ loadingSnapshots: true });
    try {
      const snapshots = await this.call((host, sessionId) =>
        host.search.snapshots.list({ sessionId, repository }),
      );
      if (this.state.repository === repository) this.set({ snapshots });
      this.#schedule();
    } catch (error) {
      this.notify('error', errorMessage(error));
    } finally {
      this.set({ loadingSnapshots: false });
    }
  }

  /** Keeps the list fresh while a snapshot is in progress. */
  #schedule(): void {
    if (this.#poll !== undefined) clearTimeout(this.#poll);
    this.#poll = undefined;
    if (this.#disposed || !this.state.snapshots.some((s) => s.state === 'IN_PROGRESS')) return;
    this.#poll = setTimeout(() => void this.loadSnapshots(), POLL_MS);
  }

  // -------------------------------------------------------------------------------------------
  // Repositories

  async createRepository(name: string, body: string): Promise<boolean> {
    const path = `/_snapshot/${name}`;
    const confirmed = await this.guard({
      safety: { writes: true },
      title: `Register the repository ${name}?`,
      detail: `PUT ${path}\n${formatJson(body)}`,
      confirmLabel: 'Register',
    });
    if (confirmed === undefined) return false;
    const done = await this.busy(async () => {
      await this.call((host, sessionId) =>
        host.search.resources.put({
          sessionId,
          kind: 'snapshot-repository',
          name,
          body,
          confirmed,
        }),
      );
      this.set({ repository: name });
      await this.reload();
      this.notify('success', `Registered ${name}`);
      return true;
    });
    return done === true;
  }

  async deleteRepository(name: string): Promise<void> {
    const request = { method: 'DELETE' as const, path: `/_snapshot/${name}` };
    const confirmed = await this.guard({
      safety: classifyRequest(request),
      title: `Unregister the repository ${name}?`,
      detail: `DELETE ${request.path}`,
      confirmLabel: 'Unregister',
    });
    if (confirmed === undefined) return;
    await this.busy(async () => {
      await this.call((host, sessionId) =>
        host.search.resources.delete({ sessionId, kind: 'snapshot-repository', name, confirmed }),
      );
      if (this.state.repository === name) this.set({ repository: undefined });
      await this.reload();
      this.notify('success', `Unregistered ${name}`);
    });
  }

  async verifyRepository(name: string): Promise<void> {
    const confirmed = await this.guard({
      safety: { writes: true },
      title: `Verify the repository ${name}?`,
      detail: `POST /_snapshot/${name}/_verify`,
      confirmLabel: 'Verify',
    });
    if (confirmed === undefined) return;
    await this.busy(async () => {
      const nodes = await this.call((host, sessionId) =>
        host.search.snapshots.verifyRepository({ sessionId, repository: name, confirmed }),
      );
      this.notify(
        'success',
        `${name} works on ${nodes.length === 1 ? nodes[0] : `${formatCount(nodes.length)} nodes`}`,
      );
    });
  }

  // -------------------------------------------------------------------------------------------
  // Snapshots

  async createSnapshot(input: {
    readonly name: string;
    readonly indices: readonly string[];
    readonly includeGlobalState: boolean;
  }): Promise<boolean> {
    const repository = this.state.repository;
    if (repository === undefined) return false;
    const body = snapshotBody({
      indices: input.indices,
      includeGlobalState: input.includeGlobalState,
    });
    const confirmed = await this.guard({
      safety: { writes: true },
      title: `Create the snapshot ${input.name}?`,
      detail: `PUT /_snapshot/${repository}/${input.name}\n${formatJson(body)}`,
      confirmLabel: 'Create',
    });
    if (confirmed === undefined) return false;
    const done = await this.busy(async () => {
      await this.call((host, sessionId) =>
        host.search.snapshots.create({
          sessionId,
          repository,
          snapshot: input.name,
          indices: [...input.indices],
          includeGlobalState: input.includeGlobalState,
          confirmed,
        }),
      );
      await this.loadSnapshots();
      this.notify('success', `Started the snapshot ${input.name}`);
      return true;
    });
    return done === true;
  }

  /** What a restore would name each index, or why the rename pattern is wrong. */
  preview(indices: readonly string[], options: RestoreOptions): string[] | undefined {
    return restoredNames(indices, options.renamePattern, options.renameReplacement);
  }

  async restoreSnapshot(snapshot: string, options: RestoreOptions): Promise<boolean> {
    const repository = this.state.repository;
    if (repository === undefined) return false;
    const path = `/_snapshot/${repository}/${snapshot}/_restore`;
    const body = restoreBody(options);
    const confirmed = await this.guard({
      safety: classifyRequest({ method: 'POST', path, body }),
      title: `Restore ${snapshot}?`,
      detail: `POST ${path}\n${formatJson(body)}`,
      confirmLabel: 'Restore',
    });
    if (confirmed === undefined) return false;
    const done = await this.busy(async () => {
      await this.call((host, sessionId) =>
        host.search.snapshots.restore({
          sessionId,
          repository,
          snapshot,
          ...(options.indices ? { indices: [...options.indices] } : {}),
          ...(options.renamePattern !== undefined ? { renamePattern: options.renamePattern } : {}),
          ...(options.renameReplacement !== undefined
            ? { renameReplacement: options.renameReplacement }
            : {}),
          ...(options.includeGlobalState !== undefined
            ? { includeGlobalState: options.includeGlobalState }
            : {}),
          ...(options.includeAliases !== undefined
            ? { includeAliases: options.includeAliases }
            : {}),
          confirmed,
        }),
      );
      void loadChildren(this.profileId, ['indices']);
      this.notify('success', `Restoring ${snapshot}: the indices recover in the background`);
      return true;
    });
    return done === true;
  }

  async deleteSnapshot(snapshot: string): Promise<void> {
    const repository = this.state.repository;
    if (repository === undefined) return;
    const confirmed = await this.guard({
      safety: classifyRequest({ method: 'DELETE', path: `/_snapshot/${repository}/${snapshot}` }),
      title: `Delete the snapshot ${snapshot}?`,
      detail: `DELETE /_snapshot/${repository}/${snapshot}`,
      confirmLabel: 'Delete',
    });
    if (confirmed === undefined) return;
    await this.busy(async () => {
      await this.call((host, sessionId) =>
        host.search.snapshots.delete({ sessionId, repository, snapshot, confirmed }),
      );
      await this.loadSnapshots();
      this.notify('success', `Deleted ${snapshot}`);
    });
  }

  override async dispose(): Promise<void> {
    this.#disposed = true;
    if (this.#poll !== undefined) clearTimeout(this.#poll);
    await super.dispose();
  }
}
