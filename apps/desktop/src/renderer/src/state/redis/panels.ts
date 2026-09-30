import { JoineryError, newId } from '@joinery/core';
import type { RedisSessionInfo } from '@joinery/ipc';
import { bytesKey, displayBytes, type CommandCatalog, type RedisBytes } from '@joinery/redis-tools';
import { create } from 'zustand';

import { currentDock } from '../../components/dock';
import type { HostClient } from '../../lib/main-client';
import {
  decideRedisSafety,
  formatCommandLine,
  redisWritePolicy,
  type RedisOperation,
} from '../../../../shared/redis-safety';
import { connect } from '../connections';
import { profileById } from '../data';
import { confirm } from '../dialogs';
import { panelWithKey, patchPanel, registerPanel, unregisterPanel } from '../panels';
import { SessionLane } from '../session-lane';

/**
 * The Redis panels (spec §10): the key browser, value editors, the CLI and the server tools,
 * each a dock panel with its own session on the connection host (in its logical database), so
 * a SELECT or MULTI typed in the CLI never affects another panel. Also the per-connection facts
 * every panel needs (server, nodes, command catalog) and the write confirmation.
 */

export type RedisTool =
  | 'keys'
  | 'value'
  | 'cli'
  | 'pubsub'
  | 'dashboard'
  | 'config'
  | 'slowlog'
  | 'clients'
  | 'latency'
  | 'monitor'
  | 'bigkeys'
  | 'acl'
  | 'topology'
  | 'search';

export const TOOL_TITLES: Readonly<Record<RedisTool, string>> = {
  keys: 'Keys',
  value: 'Value',
  cli: 'CLI',
  pubsub: 'Pub/Sub',
  dashboard: 'INFO dashboard',
  config: 'Configuration',
  slowlog: 'Slow log',
  clients: 'Clients',
  latency: 'Latency',
  monitor: 'Monitor',
  bigkeys: 'Big keys',
  acl: 'ACL users',
  topology: 'Topology',
  search: 'Search indexes',
};

/** What a Redis panel shows. */
export interface RedisPanelTarget {
  readonly profileId: string;
  readonly profileName: string;
  readonly tool: RedisTool;
  /** The logical database (standalone and Sentinel); undefined in Cluster mode. */
  readonly database?: number;
  /** Cluster: the node a key browser lists; all primaries when absent. */
  readonly node?: string;
  /** The value editor's key. */
  readonly key?: Uint8Array;
  /** The key browser's first filter, in display form. */
  readonly pattern?: string;
  /** The CLI's first command line (a command from the history, not run yet). */
  readonly line?: string;
}

interface RedisPanelsState {
  readonly targets: Readonly<Record<string, RedisPanelTarget>>;
}

export const useRedisPanels = create<RedisPanelsState>()(() => ({ targets: {} }));

const lanes = new Map<string, SessionLane>();
const disposers = new Map<string, (() => void)[]>();

function panelKeyOf(target: RedisPanelTarget): string | undefined {
  // Every CLI is its own tab ("New query" opens another); other tools open once per target.
  if (target.tool === 'cli') return undefined;
  return [
    'redis',
    target.profileId,
    target.tool,
    target.database ?? '',
    target.node ?? '',
    target.key ? bytesKey(target.key) : (target.pattern ?? ''),
  ].join('\u0000');
}

export function panelTitle(target: RedisPanelTarget): string {
  const db =
    target.database !== undefined && target.database !== 0 ? ` [db${target.database}]` : '';
  switch (target.tool) {
    case 'value':
      return `${target.key ? displayBytes(target.key) : 'Value'}${db}`;
    case 'keys':
      return `${target.pattern ? target.pattern : 'Keys'}${db} · ${target.profileName}`;
    default:
      return `${TOOL_TITLES[target.tool]} · ${target.profileName}`;
  }
}

/** Opens a Redis panel, or focuses the one already showing the same thing. */
export function openRedisPanel(target: RedisPanelTarget): string {
  const key = panelKeyOf(target);
  const open = key !== undefined ? panelWithKey(key) : undefined;
  if (open) {
    currentDock()?.getPanel(open.id)?.api.setActive();
    return open.id;
  }
  const id = newId();
  const title = panelTitle(target);
  registerPanel({
    id,
    kind: 'redis',
    profileId: target.profileId,
    title,
    ...(key !== undefined ? { key } : {}),
  });
  useRedisPanels.setState((state) => ({ targets: { ...state.targets, [id]: target } }));
  currentDock()?.addPanel({
    id,
    component: 'redis',
    tabComponent: 'panelTab',
    title,
    params: { panelId: id },
    renderer: 'always',
  });
  return id;
}

/** Changes what a panel shows (a renamed key): its title and target. */
export function retargetPanel(panelId: string, patch: Partial<RedisPanelTarget>): void {
  const current = useRedisPanels.getState().targets[panelId];
  if (!current) return;
  const target = { ...current, ...patch };
  const title = panelTitle(target);
  const key = panelKeyOf(target);
  useRedisPanels.setState((state) => ({ targets: { ...state.targets, [panelId]: target } }));
  patchPanel(panelId, { title, ...(key !== undefined ? { key } : {}) });
  currentDock()?.getPanel(panelId)?.api.setTitle(title);
}

/** The panel's session lane (opened on first use in the panel's database). */
export function panelLane(panelId: string): SessionLane {
  let lane = lanes.get(panelId);
  if (!lane) {
    const target = useRedisPanels.getState().targets[panelId];
    if (!target) throw new JoineryError({ code: 'NOT_FOUND', message: 'The panel was closed' });
    lane = new SessionLane(
      target.profileId,
      target.database === undefined ? undefined : String(target.database),
    );
    lanes.set(panelId, lane);
  }
  return lane;
}

/** Replaces the panel's lane (the key browser moved to another database). */
export function resetPanelLane(panelId: string): void {
  void lanes.get(panelId)?.close();
  lanes.delete(panelId);
}

/** Runs `dispose` when the panel closes (stops streams, timers). */
export function onPanelDispose(panelId: string, dispose: () => void): () => void {
  const list = disposers.get(panelId) ?? [];
  list.push(dispose);
  disposers.set(panelId, list);
  return () => {
    const now = disposers.get(panelId);
    if (now)
      disposers.set(
        panelId,
        now.filter((d) => d !== dispose),
      );
  };
}

/** Frees a closed panel: its streams, timers and session. */
export function disposeRedisPanel(panelId: string): void {
  for (const dispose of disposers.get(panelId) ?? []) dispose();
  disposers.delete(panelId);
  resetPanelLane(panelId);
  useRedisPanels.setState((state) => {
    const { [panelId]: _gone, ...targets } = state.targets;
    return { targets };
  });
  unregisterPanel(panelId);
}

/** Runs one task on a short-lived session in `database` (tree actions outside any panel). */
export async function withDatabaseSession<T>(
  profileId: string,
  database: number | undefined,
  task: (host: HostClient, sessionId: string) => Promise<T>,
): Promise<T> {
  const lane = new SessionLane(profileId, database === undefined ? undefined : String(database));
  try {
    return await lane.run(task);
  } finally {
    void lane.close();
  }
}

/** Opens the host session of a lane and returns it, for streams that outlive a lane task. */
export function laneSession(lane: SessionLane): Promise<{ host: HostClient; sessionId: string }> {
  return lane.run(async (host, sessionId) => ({ host, sessionId }));
}

// ---------------------------------------------------------------------------------------------
// Connection facts

export interface RedisConnectionFacts {
  readonly info: RedisSessionInfo;
  /** The command catalog; undefined when the server refuses COMMAND DOCS and COMMAND INFO. */
  readonly catalog: CommandCatalog | undefined;
}

const metaLanes = new Map<string, SessionLane>();
const facts = new Map<string, { generation: number; facts: Promise<RedisConnectionFacts> }>();

/** A session per connection for the facts below (and anything else panel-independent). */
export function metaLane(profileId: string): SessionLane {
  let lane = metaLanes.get(profileId);
  if (!lane) {
    lane = new SessionLane(profileId);
    metaLanes.set(profileId, lane);
  }
  return lane;
}

/** Server, nodes and command catalog of a connection, loaded once per connection. */
export async function connectionFacts(profileId: string): Promise<RedisConnectionFacts> {
  const connection = await connect(profileId);
  const known = facts.get(profileId);
  if (known && known.generation === connection.generation) return known.facts;
  const loading = metaLane(profileId).run(async (host, sessionId) => {
    const [info, catalog] = await Promise.all([
      host.redis.session({ sessionId }),
      host.redis.commandDocs({ sessionId }).catch(() => undefined),
    ]);
    return { info, catalog };
  });
  facts.set(profileId, { generation: connection.generation, facts: loading });
  loading.catch(() => {
    if (facts.get(profileId)?.facts === loading) facts.delete(profileId);
  });
  return loading;
}

// ---------------------------------------------------------------------------------------------
// Writes

export interface RedisWriteRequest<T> {
  readonly profileId: string;
  readonly operation: RedisOperation;
  /** The confirmation's title: "Delete key?". */
  readonly title: string;
  /** The commands the write sends, shown exactly in the confirmation. */
  readonly commands: readonly (readonly RedisBytes[])[];
  readonly confirmLabel?: string;
  /** Sends the write; `confirmed` tells the host the user agreed. */
  readonly run: (confirmed: boolean) => Promise<T>;
}

/**
 * Runs a write under the profile's rules (spec §4): refused with READ_ONLY on a read-only
 * profile; after a confirmation that shows the exact commands when it is destructive or the
 * profile confirms writes. Resolves undefined when the user declines.
 */
export async function redisWrite<T>(request: RedisWriteRequest<T>): Promise<T | undefined> {
  const profile = await profileById(request.profileId);
  if (!profile)
    throw new JoineryError({ code: 'NOT_FOUND', message: 'The connection was deleted' });
  const decision = decideRedisSafety(request.operation, redisWritePolicy(profile));
  if (decision.action === 'refuse') {
    throw new JoineryError({ code: 'READ_ONLY', message: decision.reason });
  }
  if (decision.action === 'confirm') {
    const production = profile.presentation.environment === 'production';
    const ok = await confirm({
      title: request.title,
      message: decision.destructive
        ? `This ${decision.reason}${production ? ' on a production connection' : ''}.`
        : `${decision.reason}.`,
      detail: request.commands.map((args) => formatCommandLine(args)).join('\n'),
      confirmLabel: request.confirmLabel ?? 'Run',
      danger: decision.destructive || production,
    });
    if (!ok) return undefined;
  }
  return request.run(decision.action === 'confirm');
}

// ---------------------------------------------------------------------------------------------
// Key changes

/** A key created, renamed or deleted from a panel, so the other panels can follow. */
export interface KeyChange {
  readonly profileId: string;
  /** The logical database (undefined in Cluster mode). */
  readonly database: number | undefined;
  readonly kind: 'created' | 'changed' | 'renamed' | 'deleted';
  readonly key: Uint8Array;
  /** The new name, for `renamed`. */
  readonly newKey?: Uint8Array;
}

const keyListeners = new Set<(change: KeyChange) => void>();

export function onKeyChange(listener: (change: KeyChange) => void): () => void {
  keyListeners.add(listener);
  return () => keyListeners.delete(listener);
}

export function emitKeyChange(change: KeyChange): void {
  for (const listener of keyListeners) listener(change);
}
