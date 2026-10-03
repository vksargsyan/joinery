import type { BrowseNode, BrowseNodeKind, SqlDialect } from '@querybara/core';
import { quoteQualified } from '@querybara/sql-tools';
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

/**
 * Reloads the loaded folders whose paths `matches` (the structure under them changed, spec §5):
 * expanded ones now, collapsed ones on their next expand.
 */
export function reloadChildren(profileId: string, matches: (path: string[]) => boolean): void {
  const { children, expanded } = useExplorer.getState();
  const stale: string[] = [];
  for (const key of Object.keys(children[profileId] ?? {})) {
    const path = JSON.parse(key) as string[];
    if (!matches(path)) continue;
    if (path.length === 0 || expanded[profileId]?.[key]) void loadChildren(profileId, path);
    else stale.push(key);
  }
  if (stale.length === 0) return;
  useExplorer.setState((current) => {
    const kept = { ...current.children[profileId] };
    for (const key of stale) delete kept[key];
    return { children: { ...current.children, [profileId]: kept } };
  });
}

/** Whether a connection's own tree is open (kept here, so it survives a move to a folder). */
export function useProfileExpanded(profileId: string): boolean {
  return useExplorer((state) => state.expanded[profileId]?.[pathKey([])] === true);
}

export function setProfileExpanded(profileId: string, expanded: boolean): void {
  useExplorer.setState((current) => ({
    expanded: {
      ...current.expanded,
      [profileId]: { ...current.expanded[profileId], [pathKey([])]: expanded },
    },
  }));
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

/** Where a table node lives: the database, the schema (the database on MySQL) and its name. */
export interface TableLocation {
  readonly database: string;
  readonly schema: string;
  readonly name: string;
}

/**
 * The location of a table node. PostgreSQL paths are database / schema / folder / object;
 * MySQL and MariaDB paths are database / folder / object.
 */
export function tableLocation(node: BrowseNode, dialect: SqlDialect): TableLocation | undefined {
  const name = node.path.at(-1);
  const database = node.path[0];
  const schema = dialect === 'postgres' ? node.path[1] : node.path[0];
  if (name === undefined || database === undefined || schema === undefined) return undefined;
  return { database, schema, name };
}

/** Whether a node opens in the table data view and designer (a table, not a view). */
export function isDesignableTable(node: BrowseNode, dialect: SqlDialect): boolean {
  const folder = node.path.at(-2);
  return node.kind === 'table' && folder === 'tables' && tableLocation(node, dialect) !== undefined;
}

/** The explorer folder listing the tables of a schema (refreshed after a designer saves). */
export function tablesFolderPath(location: TableLocation, dialect: SqlDialect): string[] {
  return dialect === 'postgres'
    ? [location.database, location.schema, 'tables']
    : [location.database, 'tables'];
}

/**
 * Where "New table…" on a node creates the table: the tables folder, a PostgreSQL schema or a
 * MySQL/MariaDB database. Undefined for other nodes.
 */
export function newTableLocation(
  node: BrowseNode,
  dialect: SqlDialect,
): Omit<TableLocation, 'name'> | undefined {
  const [database, second, third] = node.path;
  if (database === undefined) return undefined;
  if (dialect === 'postgres') {
    if (second === undefined) return undefined;
    if (node.kind === 'schema' && node.path.length === 2) return { database, schema: second };
    if (node.kind === 'folder' && node.path.length === 3 && third === 'tables') {
      return { database, schema: second };
    }
    return undefined;
  }
  if (node.kind === 'database' && node.path.length === 1) return { database, schema: database };
  if (node.kind === 'folder' && node.path.length === 2 && second === 'tables') {
    return { database, schema: database };
  }
  return undefined;
}
