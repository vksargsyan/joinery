import type { RequestSafety, SearchClusterInfo } from '@querybara/search-tools';
import { useStore } from 'zustand';
import { createStore, type StoreApi } from 'zustand/vanilla';

import {
  decideSearchWrite,
  searchWritePolicy,
  type SearchWritePolicy,
} from '../../../../shared/search-writes';
import { errorMessage } from '../../lib/errors';
import type { HostClient } from '../../lib/main-client';
import { profileById } from '../data';
import { confirm } from '../dialogs';
import { patchPanel } from '../panels';
import { SessionLane } from '../session-lane';

/**
 * What the Elasticsearch panels share (spec §11): a session of their own, the
 * profile's write rules, what the cluster is (its capability flags gate every feature), a
 * notice line, and the confirmation before a write. The page asks with the same rules the
 * connection host enforces (shared/search-writes), then sends `confirmed`; the host checks
 * again whatever the page sends.
 */

export interface Notice {
  readonly kind: 'info' | 'success' | 'error';
  readonly text: string;
}

export interface SearchViewState {
  readonly notice: Notice | undefined;
  readonly policy: SearchWritePolicy | undefined;
  /** What the cluster is; undefined until read (or when the user may not read it). */
  readonly info: SearchClusterInfo | undefined;
}

export const BASE_STATE: SearchViewState = {
  notice: undefined,
  policy: undefined,
  info: undefined,
};

/** A write the user asked for: what the confirmation shows. */
export interface WriteRequest {
  readonly safety: Pick<RequestSafety, 'writes' | 'destructive'>;
  /** The dialog's title: "Delete the index orders?". */
  readonly title: string;
  /** The exact request(s), shown in a monospace block. */
  readonly detail: string;
  readonly confirmLabel: string;
}

export abstract class SearchView<S extends SearchViewState> {
  readonly id: string;
  readonly profileId: string;
  readonly store: StoreApi<S>;
  protected readonly lane: SessionLane;

  constructor(id: string, profileId: string, initial: S) {
    this.id = id;
    this.profileId = profileId;
    this.store = createStore<S>()(() => initial);
    this.lane = new SessionLane(profileId);
  }

  get state(): S {
    return this.store.getState();
  }

  protected set(patch: Partial<S>): void {
    this.store.setState(patch);
  }

  /** Runs a task on the panel's session. */
  protected call<T>(task: (host: HostClient, sessionId: string) => Promise<T>): Promise<T> {
    return this.lane.run(task);
  }

  /** Reads the profile's write rules and what the cluster is. */
  protected async loadBasics(): Promise<void> {
    const profile = await profileById(this.profileId);
    if (profile) this.set({ policy: searchWritePolicy(profile) } as Partial<S>);
    try {
      const info = await this.call((host, sessionId) => host.search.clusterInfo({ sessionId }));
      this.set({ info } as Partial<S>);
    } catch {
      // A user without the monitor privilege: panels work with conservative flags.
    }
  }

  get readOnly(): boolean {
    return this.state.policy?.readOnly ?? false;
  }

  notify(kind: Notice['kind'], text: string): void {
    this.set({ notice: { kind, text } } as Partial<S>);
  }

  dismissNotice(): void {
    this.set({ notice: undefined } as Partial<S>);
  }

  /**
   * Applies the write rules before a write: refused on a read-only profile (a notice says so),
   * asked for when it is destructive or the profile confirms writes. Resolves with the
   * `confirmed` flag to send, or undefined when it must not run.
   */
  protected async guard(request: WriteRequest): Promise<boolean | undefined> {
    const policy = this.state.policy ?? {
      readOnly: false,
      confirmWrites: false,
      production: false,
      profileName: '',
    };
    const decision = decideSearchWrite(request.safety, policy);
    if (decision.action === 'refuse') {
      this.notify('error', decision.reason);
      return undefined;
    }
    if (decision.action === 'run') return false;
    const ok = await confirm({
      title: request.title,
      message: decision.reason,
      detail: request.detail,
      confirmLabel: request.confirmLabel,
      danger: decision.destructive || policy.production,
    });
    return ok ? true : undefined;
  }

  /** Runs `task` with the panel marked busy; a failure becomes an error notice. */
  protected async busy<T>(task: () => Promise<T>): Promise<T | undefined> {
    patchPanel(this.id, { busy: true });
    try {
      return await task();
    } catch (error) {
      this.notify('error', errorMessage(error));
      return undefined;
    } finally {
      patchPanel(this.id, { busy: false });
    }
  }

  async dispose(): Promise<void> {
    await this.lane.close();
  }
}

/** Subscribes a component to part of a panel's state. */
export function useSearchView<S extends SearchViewState, T>(
  view: SearchView<S>,
  selector: (state: S) => T,
): T {
  return useStore(view.store, selector);
}
