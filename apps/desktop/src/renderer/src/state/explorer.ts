import type { BrowseNode, BrowseNodeKind, SqlDialect } from '@joinery/core';
import { quoteQualified } from '@joinery/sql-tools';
import { create } from 'zustand';

import { errorMessage } from '../lib/errors';
import type { HostClient } from '../lib/main-client';
import { connect } from './connections';

/**
 * The object explorer (spec §5): a lazily loaded tree per connection. Children load on first
 * expand and on refresh, through one metadata session per connection that all tree requests
 * share.
 */

export interface ChildrenState {
  readonly nodes?: readonly BrowseNode[];
  readonly loading: boolean;
  readonly error?: string;
}

interface ExplorerState {
  /** profileId → path key → children. */
  readonly children: Readonly<Record<string, Readonly<Record<string, ChildrenState>>>>;
  /** profileId → path key → expanded. */
  readonly expanded: Readonly<Record<string, Readonly<Record<string, boolean>>>>;
}

export const useExplorer = create<ExplorerState>()(() => ({ children: {}, expanded: {} }));

export function pathKey(path: readonly string[]): string {
  return JSON.stringify(path);
}

const sessions = new Map<string, { host: HostClient; sessionId: string; generation: number }>();

async function explorerSession(
  profileId: string,
): Promise<{ host: HostClient; sessionId: string }> {
  const connection = await connect(profileId);
  const known = sessions.get(profileId);
  if (known && known.host === connection.host && known.generation === connection.generation) {
    return known;
  }
  if (!connection.host) throw new Error('Not connected');
  const { sessionId } = await connection.host.openSession({});
  const session = { host: connection.host, sessionId, generation: connection.generation };
  sessions.set(profileId, session);
  return session;
}

function setChildren(profileId: string, key: string, state: ChildrenState): void {
  useExplorer.setState((current) => ({
    children: {
      ...current.children,
      [profileId]: { ...current.children[profileId], [key]: state },
    },
  }));
}

/** Loads (or reloads) the children of `path`; `[]` is the root. */
export async function loadChildren(profileId: string, path: readonly string[]): Promise<void> {
  const key = pathKey(path);
  const previous = useExplorer.getState().children[profileId]?.[key];
  setChildren(profileId, key, {
    ...(previous?.nodes ? { nodes: previous.nodes } : {}),
    loading: true,
  });
  try {
    const { host, sessionId } = await explorerSession(profileId);
    const nodes = await host.browse({ sessionId, path });
    setChildren(profileId, key, { nodes, loading: false });
  } catch (error) {
    sessions.delete(profileId);
    setChildren(profileId, key, { loading: false, error: errorMessage(error) });
  }
}

export function toggleNode(profileId: string, node: BrowseNode): void {
  const key = pathKey(node.path);
  const open = useExplorer.getState().expanded[profileId]?.[key] === true;
  useExplorer.setState((current) => ({
    expanded: {
      ...current.expanded,
      [profileId]: { ...current.expanded[profileId], [key]: !open },
    },
  }));
  const loaded = useExplorer.getState().children[profileId]?.[key];
  if (!open && (!loaded || loaded.error)) void loadChildren(profileId, node.path);
}

/** Forgets the tree of a connection (disconnect, delete). */
export function resetExplorer(profileId: string): void {
  sessions.delete(profileId);
  useExplorer.setState((current) => {
    const { [profileId]: _children, ...children } = current.children;
    const { [profileId]: _expanded, ...expanded } = current.expanded;
    return { children, expanded };
  });
}

const DATA_KINDS: ReadonlySet<BrowseNodeKind> = new Set([
  'table',
  'view',
  'materialized-view',
  'foreign-table',
  'partition',
]);

/** Whether double-clicking the node opens its rows in a query tab. */
export function opensData(node: BrowseNode): boolean {
  return DATA_KINDS.has(node.kind);
}

/**
 * `SELECT * FROM <qualified name> LIMIT 1000` for a table-like node. PostgreSQL paths are
 * database / schema / folder / object; MySQL and MariaDB paths are database / folder / object.
 */
export function selectStatementFor(node: BrowseNode, dialect: SqlDialect, limit = 1000): string {
  const name = node.path.at(-1) ?? node.name;
  const container = dialect === 'postgres' ? node.path[1] : node.path[0];
  const qualified = quoteQualified([container, name], dialect);
  return `SELECT * FROM ${qualified} LIMIT ${limit};`;
}
