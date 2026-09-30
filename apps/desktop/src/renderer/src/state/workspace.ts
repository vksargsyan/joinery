import { newId, type ColumnMeta, type ExplainResult } from '@joinery/core';
import type { RpcStream } from '@joinery/ipc';
import type { ResultChunk } from '@joinery/core';
import { create } from 'zustand';

import type { HostClient } from '../lib/main-client';
import type { ColumnLayout } from './grid-layout';
import type { ResultSetBuffer, StatementResult } from './results';

/**
 * Query tabs (spec §6): what each tab shows, in a Zustand store, plus per-tab runtime objects
 * (session, open result stream, editor handle, row buffers) that are not UI state and live in
 * plain maps next to it.
 */

export const DEFAULT_ROW_LIMIT = 1_000;

export interface ResultView {
  readonly id: string;
  readonly title: string;
  readonly statementIndex: number;
  readonly resultIndex: number;
  readonly columns: readonly ColumnMeta[];
  /** Rows loaded into the grid. */
  readonly rowCount: number;
  /** The result stream is paused at the row limit with more rows to fetch. */
  readonly hasMore: boolean;
  /** Stopped at the row limit and closed because a later statement needed the session. */
  readonly truncated: boolean;
  readonly fetching: boolean;
  readonly version: number;
  /** Hidden, reordered, pinned and resized columns (keys are column positions); natural if unset. */
  readonly layout?: ColumnLayout | undefined;
}

export type MessageKind = 'info' | 'success' | 'notice' | 'warning' | 'error';

export interface MessageEntry {
  readonly id: string;
  readonly kind: MessageKind;
  readonly text: string;
  readonly detail?: string;
  readonly statementIndex?: number;
  /** Absolute range in the editor text to highlight. */
  readonly range?: { readonly start: number; readonly end: number };
  readonly at: string;
}

/** The tab's visual explain (spec §6): the last EXPLAIN run and its plan. */
export interface ExplainTabState {
  readonly status: 'running' | 'done' | 'error';
  readonly analyze: boolean;
  /** PostgreSQL BUFFERS: also the choice for the next run. */
  readonly buffers: boolean;
  /** The statement explained, as it was sent (parameters bound). */
  readonly statement: string;
  readonly result?: ExplainResult;
  readonly error?: string;
  readonly at: string;
}

export interface QueryTab {
  readonly id: string;
  readonly profileId: string;
  readonly title: string;
  readonly initialText: string;
  /** Where the caret starts (a restored tab's saved caret). */
  readonly initialCursor?: number | undefined;
  readonly autoCommit: boolean;
  readonly inTransaction: boolean;
  readonly running: boolean;
  readonly cancelling: boolean;
  readonly results: readonly ResultView[];
  readonly messages: readonly MessageEntry[];
  /** 'messages', 'plan' or a ResultView id. */
  readonly activePane: string;
  readonly rowLimit: number;
  readonly errorMarker?: { readonly start: number; readonly end: number; readonly message: string };
  readonly explain?: ExplainTabState | undefined;
  /** The database the tab's session connects to; the connection's own when unset. */
  readonly database?: string | undefined;
}

interface WorkspaceState {
  readonly tabs: Readonly<Record<string, QueryTab>>;
  readonly order: readonly string[];
  readonly activeTabId: string | undefined;
  readonly historyOpen: boolean;
}

export const useWorkspace = create<WorkspaceState>()(() => ({
  tabs: {},
  order: [],
  activeTabId: undefined,
  historyOpen: false,
}));

export function getTab(tabId: string): QueryTab | undefined {
  return useWorkspace.getState().tabs[tabId];
}

export function patchTab(
  tabId: string,
  patch: Partial<QueryTab> | ((tab: QueryTab) => Partial<QueryTab>),
): void {
  useWorkspace.setState((state) => {
    const tab = state.tabs[tabId];
    if (!tab) return state;
    const next = typeof patch === 'function' ? patch(tab) : patch;
    return { tabs: { ...state.tabs, [tabId]: { ...tab, ...next } } };
  });
}

export function patchResult(tabId: string, resultId: string, patch: Partial<ResultView>): void {
  patchTab(tabId, (tab) => ({
    results: tab.results.map((result) =>
      result.id === resultId ? { ...result, ...patch } : result,
    ),
  }));
}

export function addMessage(tabId: string, message: Omit<MessageEntry, 'id' | 'at'>): void {
  const entry: MessageEntry = { ...message, id: newId(), at: new Date().toISOString() };
  patchTab(tabId, (tab) => ({ messages: [...tab.messages, entry] }));
}

/** What the editor component registers so the runner can read and mark the text. */
export interface EditorHandle {
  getText(): string;
  cursorOffset(): number;
  selection(): { start: number; end: number } | undefined;
  setText(text: string): void;
  focus(): void;
  /** Formats the whole text with sql-tools (undoable). */
  format(): void;
}

/** A result stream paused at the row limit, resumed by Fetch more. */
export interface OpenResult {
  readonly stream: RpcStream<ResultChunk>;
  readonly result: StatementResult;
  readonly statementIndex: number;
  readonly executionId: string;
  readonly startedAt: number;
  /** A rows chunk read to learn whether more rows exist, not shown yet. */
  pending: ResultChunk[];
  readonly record: (status: 'success' | 'error' | 'cancelled', error?: string) => void;
}

export interface TabRuntime {
  host: HostClient | undefined;
  sessionId: string | undefined;
  generation: number | undefined;
  execution: { readonly executionId: string; readonly controller: AbortController } | undefined;
  open: OpenResult | undefined;
  editor: EditorHandle | undefined;
}

const runtimes = new Map<string, TabRuntime>();
const buffers = new Map<string, ResultSetBuffer>();

export function runtimeOf(tabId: string): TabRuntime {
  let runtime = runtimes.get(tabId);
  if (!runtime) {
    runtime = {
      host: undefined,
      sessionId: undefined,
      generation: undefined,
      execution: undefined,
      open: undefined,
      editor: undefined,
    };
    runtimes.set(tabId, runtime);
  }
  return runtime;
}

export function forgetRuntime(tabId: string): void {
  runtimes.delete(tabId);
  const tab = getTab(tabId);
  for (const result of tab?.results ?? []) buffers.delete(result.id);
}

export function bufferOf(resultId: string): ResultSetBuffer | undefined {
  return buffers.get(resultId);
}

export function setBuffer(resultId: string, buffer: ResultSetBuffer): void {
  buffers.set(resultId, buffer);
}

export function dropBuffers(resultIds: Iterable<string>): void {
  for (const id of resultIds) buffers.delete(id);
}

/** Registers a new tab in the store and returns its id (the dock adds the panel). */
export function createTab(options: {
  readonly profileId: string;
  readonly title: string;
  readonly text?: string;
  readonly cursor?: number;
  /** An id to use (a panel that runs its queries through this tab); a new one otherwise. */
  readonly id?: string;
  readonly database?: string;
}): string {
  const id = options.id ?? newId();
  const tab: QueryTab = {
    id,
    profileId: options.profileId,
    title: options.title,
    initialText: options.text ?? '',
    ...(options.cursor === undefined ? {} : { initialCursor: options.cursor }),
    autoCommit: true,
    inTransaction: false,
    running: false,
    cancelling: false,
    results: [],
    messages: [],
    activePane: 'messages',
    rowLimit: DEFAULT_ROW_LIMIT,
    ...(options.database === undefined ? {} : { database: options.database }),
  };
  useWorkspace.setState((state) => ({
    tabs: { ...state.tabs, [id]: tab },
    order: [...state.order, id],
    activeTabId: id,
  }));
  return id;
}

export function removeTab(tabId: string): void {
  forgetRuntime(tabId);
  useWorkspace.setState((state) => {
    const { [tabId]: _removed, ...tabs } = state.tabs;
    const order = state.order.filter((id) => id !== tabId);
    return {
      tabs,
      order,
      activeTabId: state.activeTabId === tabId ? order.at(-1) : state.activeTabId,
    };
  });
}
