import { newId } from '@joinery/core';
import { distributionName, type SearchDistribution } from '@joinery/search-tools';
import { useStore } from 'zustand';
import { createStore, type StoreApi } from 'zustand/vanilla';

import { searchWritePolicy, type SearchWritePolicy } from '../../../../shared/search-writes';
import { errorInfo, errorMessage } from '../../lib/errors';
import { mainApi } from '../../lib/main-client';
import { profileById, queryClient } from '../data';
import { confirm } from '../dialogs';
import { reloadChildren } from '../explorer';
import { patchPanel } from '../panels';
import { SessionLane } from '../session-lane';
import {
  ConsoleHistory,
  failureView,
  plannedRequests,
  runRequests,
  type ConsoleResponseView,
  type PlannedRequest,
} from './console-flow';

/**
 * The Elasticsearch / OpenSearch console (spec §11), Kibana Dev Tools' working set: requests in
 * console syntax, the one at the cursor (or every one a selection touches) sent with
 * Ctrl/Cmd+Enter, each response shown re-indented with its status, time and warnings. The write
 * rules apply before each request (read-only refuses, destructive and production writes ask),
 * and the connection host checks them again. Runs go to the query history and to the console's
 * own history; index names feed autocomplete.
 */

export const WELCOME = `# Send the request at the cursor with Ctrl/Cmd+Enter
GET /_cluster/health

GET /_search
{
  "query": {
    "match_all": {}
  }
}
`;

export interface ConsoleTarget {
  readonly profileId: string;
  readonly text?: string;
}

export interface SearchConsoleState {
  readonly running: boolean;
  /** The responses of the last run, in order. */
  readonly responses: readonly ConsoleResponseView[];
  /** A server-reported error position to mark in the editor. */
  readonly errorMarker: { readonly offset: number; readonly message: string } | undefined;
  readonly historyOpen: boolean;
  readonly history: readonly string[];
  /** Index, alias and data stream names for autocomplete. */
  readonly names: readonly string[];
  readonly distribution: SearchDistribution | undefined;
  readonly serverVersion: string | undefined;
  readonly policy: SearchWritePolicy | undefined;
}

export class SearchConsole {
  readonly id: string;
  readonly target: ConsoleTarget;
  readonly store: StoreApi<SearchConsoleState>;
  readonly #lane: SessionLane;
  readonly #history = new ConsoleHistory();
  #execution: { readonly id: string; readonly controller: AbortController } | undefined;

  constructor(id: string, target: ConsoleTarget) {
    this.id = id;
    this.target = target;
    this.store = createStore<SearchConsoleState>()(() => ({
      running: false,
      responses: [],
      errorMarker: undefined,
      historyOpen: false,
      history: [],
      names: [],
      distribution: undefined,
      serverVersion: undefined,
      policy: undefined,
    }));
    this.#lane = new SessionLane(target.profileId);
  }

  get state(): SearchConsoleState {
    return this.store.getState();
  }

  #set(patch: Partial<SearchConsoleState>): void {
    this.store.setState(patch);
  }

  /** Reads the profile's write rules, what the server is, and the names to complete. */
  async init(): Promise<void> {
    const profile = await profileById(this.target.profileId);
    if (profile) this.#set({ policy: searchWritePolicy(profile) });
    try {
      const info = await this.#lane.run((host, sessionId) =>
        host.search.clusterInfo({ sessionId }),
      );
      this.#set({ distribution: info.distribution, serverVersion: info.version });
    } catch {
      // A user without the monitor privilege: the console still works.
    }
    await this.loadNames();
  }

  /** Reloads the index, alias and data stream names autocomplete offers. */
  async loadNames(): Promise<void> {
    try {
      const names = await this.#lane.run(async (host, sessionId) => {
        const [indices, aliases, streams] = await Promise.all([
          host.search.indices.list({ sessionId }),
          host.search.aliases.list({ sessionId }).catch(() => []),
          host.search.dataStreams.list({ sessionId }).catch(() => []),
        ]);
        return [
          ...new Set([
            ...indices.map((i) => i.name),
            ...aliases.map((a) => a.alias),
            ...streams.map((s) => s.name),
          ]),
        ].sort();
      });
      this.#set({ names });
    } catch {
      // Autocomplete without names still offers the endpoints.
    }
  }

  /** The distribution's name for messages, "Elasticsearch" until it is known. */
  get productName(): string {
    return distributionName(this.state.distribution ?? 'elasticsearch');
  }

  /**
   * Sends the request at `start` (or every request in [start, end)) under the write rules and
   * shows the responses.
   */
  async run(text: string, start: number, end = start): Promise<void> {
    if (this.state.running) return;
    const planned = plannedRequests(text, start, end);
    if (planned.length === 0) {
      this.#set({
        responses: [
          {
            label: 'No request',
            body: 'Put the cursor in a request (such as GET /_search) to send it.',
            contentType: 'text/plain',
            durationMs: 0,
            warnings: [],
            truncated: false,
            error: 'No request at the cursor',
          },
        ],
      });
      return;
    }
    const policy = this.state.policy ?? {
      readOnly: false,
      confirmWrites: false,
      production: false,
      profileName: '',
    };
    const execution = { id: newId(), controller: new AbortController() };
    this.#execution = execution;
    this.#set({ running: true, responses: [], errorMarker: undefined });
    patchPanel(this.id, { busy: true });
    const views: ConsoleResponseView[] = [];
    let wrote = false;
    try {
      await runRequests(planned, {
        policy,
        confirm: (item, decision) =>
          confirm({
            title: policy.production ? 'Send on a production connection?' : `Send ${item.label}?`,
            message: decision.reason,
            detail: item.text,
            confirmLabel: 'Send',
            danger: decision.destructive,
          }),
        send: (item, confirmed) =>
          this.#lane.run((host, sessionId) =>
            host.search.request(
              { sessionId, request: item.wire, confirmed, executionId: execution.id },
              { signal: execution.controller.signal },
            ),
          ),
        onResult: (view, item) => {
          views.push(view);
          this.#set({
            responses: [...views],
            ...(view.errorOffset !== undefined
              ? { errorMarker: { offset: view.errorOffset, message: view.error ?? 'Error' } }
              : {}),
          });
          if (view.status !== undefined) {
            this.#history.push(item.text);
            if (item.wire.method !== 'GET' && item.wire.method !== 'HEAD' && view.status < 300) {
              wrote = true;
            }
          }
          void this.#record(item, view);
        },
      });
    } catch (error) {
      const info = errorInfo(error);
      const failed = planned[views.length];
      if (failed) {
        const view = failureView(
          failed,
          info.code === 'CANCELLED' ? 'Cancelled' : errorMessage(error),
        );
        views.push(view);
        this.#set({ responses: [...views] });
        void this.#record(failed, view);
      }
    } finally {
      if (this.#execution === execution) this.#execution = undefined;
      this.#set({ running: false, history: this.#history.entries });
      patchPanel(this.id, { busy: false });
    }
    if (wrote) {
      // Indices may have come or gone: refresh the explorer and the names autocomplete offers.
      reloadChildren(this.target.profileId, () => true);
      void this.loadNames();
    }
  }

  /** Cancels the running request (and the server task it started). */
  async cancel(): Promise<void> {
    const execution = this.#execution;
    if (!execution) return;
    execution.controller.abort();
    const current = this.#lane.current;
    if (current) {
      await current.host
        .cancel({ sessionId: current.sessionId, executionId: execution.id })
        .catch(() => undefined);
    }
  }

  setHistoryOpen(open: boolean): void {
    this.#set({ historyOpen: open });
  }

  async #record(item: PlannedRequest, view: ConsoleResponseView): Promise<void> {
    try {
      await mainApi().history.add({
        profileId: this.target.profileId,
        database: null,
        text: item.text,
        status:
          view.status === undefined
            ? view.error === 'Cancelled'
              ? 'cancelled'
              : 'error'
            : view.status < 400
              ? 'success'
              : 'error',
        error: view.error ?? null,
        durationMs: view.durationMs,
        rowCount: 0,
      });
      await queryClient.invalidateQueries({ queryKey: ['history'] });
    } catch {
      // History is best effort: a run never fails because it could not be recorded.
    }
  }

  async dispose(): Promise<void> {
    this.#execution?.controller.abort();
    await this.#lane.close();
  }
}

/** Subscribes a component to part of a console's state. */
export function useSearchConsole<T>(
  console: SearchConsole,
  selector: (state: SearchConsoleState) => T,
): T {
  return useStore(console.store, selector);
}
