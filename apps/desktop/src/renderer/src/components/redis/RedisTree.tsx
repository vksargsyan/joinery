import type { BrowseNode } from '@joinery/core';
import type { StoredProfile } from '@joinery/ipc';
import { parseDisplayBytes, utf8Bytes } from '@joinery/redis-tools';
import { useState } from 'react';

import { formatCount } from '../../lib/format';
import { destructive } from '../../../../shared/redis-safety';
import { loadChildren, pathKey, toggleNode, useExplorer } from '../../state/explorer';
import { openDumpAnalysis } from '../../state/redis/dump';
import { namespacePattern } from '../../state/redis/key-browser';
import { openTransferFrom } from '../../state/transfer-db/api';
import {
  TOOL_TITLES,
  emitKeyChange,
  openRedisPanel,
  redisWrite,
  withDatabaseSession,
  type RedisTool,
} from '../../state/redis/panels';
import { BackupMenuItems } from '../backup/BackupDialogs';
import { MenuItem, Row } from '../Sidebar';
import { Icon } from '../ui';
import { TypeBadge } from './common';

/**
 * A Redis connection's explorer tree (spec §5): logical databases with their key counts (or
 * Cluster primaries), then the namespace tree on the connection's delimiter, loaded a level at
 * a time with bounded SCAN work (a marker says when a level was cut short), and keys with their
 * type. Opening a key opens its value editor; opening a database or a namespace opens the key
 * browser filtered to it. The tools sit in their own folder.
 */

const TOOLS: readonly RedisTool[] = [
  'keys',
  'cli',
  'pubsub',
  'dashboard',
  'config',
  'slowlog',
  'clients',
  'latency',
  'monitor',
  'bigkeys',
  'acl',
  'topology',
];

/** Opens a tool for a connection (database 0, all nodes). */
export function openRedisTool(profile: StoredProfile, tool: RedisTool): string {
  return openRedisPanel({ profileId: profile.id, profileName: profile.name, tool });
}

/** The logical database of a tree path ("db3" → 3), undefined for a Cluster node. */
function databaseOf(path: readonly string[]): number | undefined {
  const match = /^db(\d+)$/.exec(path[0] ?? '');
  return match ? Number(match[1]) : undefined;
}

function nodeOf(path: readonly string[]): string | undefined {
  return databaseOf(path) === undefined ? path[0] : undefined;
}

export function RedisTree(props: { readonly profile: StoredProfile; readonly depth: number }) {
  const [toolsOpen, setToolsOpen] = useState(false);
  const { profile, depth } = props;
  return (
    <>
      <Children profile={profile} path={[]} depth={depth} />
      <div role="treeitem" aria-expanded={toolsOpen} aria-selected={false}>
        <Row
          depth={depth}
          expandable
          expanded={toolsOpen}
          onToggle={() => setToolsOpen(!toolsOpen)}
          label={
            <span className="flex items-center gap-1.5">
              <Icon name="folder" className="text-muted" />
              Tools
            </span>
          }
        />
        {toolsOpen && (
          <div role="group">
            {TOOLS.map((tool) => (
              <div role="treeitem" aria-selected={false} key={tool}>
                <Row
                  depth={depth + 1}
                  expandable={false}
                  expanded={false}
                  onToggle={() => openRedisTool(profile, tool)}
                  onActivate={() => openRedisTool(profile, tool)}
                  label={<span className="truncate">{TOOL_TITLES[tool]}</span>}
                />
              </div>
            ))}
            {/* Offline: a dump file, from this server or any other. */}
            <div role="treeitem" aria-selected={false}>
              <Row
                depth={depth + 1}
                expandable={false}
                expanded={false}
                onToggle={() => openDumpAnalysis()}
                onActivate={() => openDumpAnalysis()}
                label={<span className="truncate">Dump analysis</span>}
              />
            </div>
          </div>
        )}
      </div>
    </>
  );
}

function Children(props: {
  readonly profile: StoredProfile;
  readonly path: readonly string[];
  readonly depth: number;
  /** The key browser pattern of the namespace these children are in. */
  readonly pattern?: string;
}) {
  const state = useExplorer((s) => s.children[props.profile.id]?.[pathKey(props.path)]);
  const indent = { paddingLeft: 12 + props.depth * 14 };
  if (!state || (state.loading && !state.nodes)) {
    return (
      <p className="py-1 text-xs text-muted" style={indent}>
        Loading…
      </p>
    );
  }
  if (state.error) {
    return (
      <p className="py-1 text-xs text-danger" style={indent}>
        {state.error}
      </p>
    );
  }
  if (state.nodes?.length === 0) {
    return (
      <p className="py-1 text-xs text-muted" style={indent}>
        No keys
      </p>
    );
  }
  return (
    <>
      {state.nodes?.map((node) => (
        <TreeNode
          key={pathKey(node.path)}
          node={node}
          profile={props.profile}
          depth={props.depth}
          {...(props.pattern !== undefined ? { parentPattern: props.pattern } : {})}
        />
      ))}
    </>
  );
}

function TreeNode(props: {
  readonly node: BrowseNode;
  readonly profile: StoredProfile;
  readonly depth: number;
  readonly parentPattern?: string;
}) {
  const { node, profile, depth } = props;
  const expanded = useExplorer((s) => s.expanded[profile.id]?.[pathKey(node.path)] === true);
  const database = databaseOf(node.path);
  const clusterNode = nodeOf(node.path);
  const detail = node.detail ?? {};
  const scope = {
    profileId: profile.id,
    profileName: profile.name,
    ...(database !== undefined ? { database } : {}),
  };
  const browse = (pattern?: string): void => {
    openRedisPanel({
      ...scope,
      tool: 'keys',
      ...(clusterNode !== undefined ? { node: clusterNode } : {}),
      ...(pattern !== undefined ? { pattern } : {}),
    });
  };

  if (node.kind === 'other') {
    return (
      <div role="treeitem" aria-selected={false}>
        <Row
          depth={depth}
          expandable={false}
          expanded={false}
          onToggle={() => browse(props.parentPattern)}
          title="Open the key browser for the rest"
          label={
            <span className="truncate text-xs text-muted italic" data-testid="partial-marker">
              {node.name}
            </span>
          }
        />
      </div>
    );
  }

  if (node.kind === 'key') {
    const key = parseDisplayBytes(typeof detail['key'] === 'string' ? detail['key'] : node.name);
    const open = (): void => {
      openRedisPanel({ ...scope, tool: 'value', key });
    };
    const remove = async (): Promise<void> => {
      const done = await redisWrite({
        profileId: profile.id,
        operation: destructive('deletes the key'),
        title: 'Delete key?',
        commands: [[utf8Bytes('UNLINK'), key]],
        confirmLabel: 'Delete',
        run: (confirmed) =>
          withDatabaseSession(profile.id, database, (host, sessionId) =>
            host.redis.key.delete({ sessionId, keys: [key], confirmed }),
          ),
      }).catch(() => undefined);
      if (!done) return;
      emitKeyChange({ profileId: profile.id, database, kind: 'deleted', key });
      void loadChildren(profile.id, node.path.slice(0, -1));
    };
    return (
      <div role="treeitem" aria-selected={false} aria-label={node.name}>
        <Row
          depth={depth}
          expandable={false}
          expanded={false}
          onToggle={open}
          onActivate={open}
          title="Open the value editor"
          label={
            <span className="flex min-w-0 items-center gap-1.5" data-testid="redis-key-node">
              <TypeBadge type={typeof detail['type'] === 'string' ? detail['type'] : ''} />
              <span className="truncate font-mono text-[12.5px]">{node.name}</span>
            </span>
          }
          menu={
            <>
              <MenuItem onSelect={open}>Open value</MenuItem>
              <MenuItem danger onSelect={() => void remove()}>
                Delete key…
              </MenuItem>
            </>
          }
        />
      </div>
    );
  }

  const keys = typeof detail['keys'] === 'number' ? detail['keys'] : undefined;
  const partial = detail['partial'] === 1;
  const prefix = typeof detail['prefix'] === 'string' ? detail['prefix'] : undefined;
  const pattern =
    node.kind === 'namespace' && prefix !== undefined
      ? namespacePattern(parseDisplayBytes(prefix))
      : undefined;
  return (
    <div
      role="treeitem"
      aria-expanded={node.hasChildren ? expanded : undefined}
      aria-selected={false}
      aria-label={node.name}
    >
      <Row
        depth={depth}
        expandable={node.hasChildren}
        expanded={expanded}
        onToggle={() => toggleNode(profile.id, node)}
        onActivate={() => browse(pattern)}
        title="Double-click to open the key browser"
        label={
          <span className="flex min-w-0 items-center gap-1.5">
            <Icon name={node.kind === 'namespace' ? 'folder' : 'database'} className="text-muted" />
            <span className="truncate font-mono text-[12.5px]">{node.name}</span>
            {keys !== undefined && (
              <span
                className="text-[11px] text-muted"
                title={partial ? 'At least this many keys (the scan was cut short)' : undefined}
              >
                {partial ? '≥' : ''}
                {formatCount(keys)}
              </span>
            )}
          </span>
        }
        menu={
          <>
            <MenuItem onSelect={() => browse(pattern)}>Browse keys</MenuItem>
            {node.kind !== 'namespace' && (
              <MenuItem
                onSelect={() =>
                  openRedisPanel({
                    profileId: profile.id,
                    profileName: profile.name,
                    tool: 'cli',
                    ...(database !== undefined ? { database } : {}),
                  })
                }
              >
                Open CLI here
              </MenuItem>
            )}
            {clusterNode === undefined && (
              <MenuItem
                onSelect={() =>
                  openTransferFrom(profile, {
                    ...(database !== undefined ? { database: String(database) } : {}),
                    ...(pattern !== undefined ? { pattern } : {}),
                  })
                }
              >
                Transfer keys to…
              </MenuItem>
            )}
            <BackupMenuItems
              profile={profile}
              location={{
                ...(database !== undefined ? { database: String(database) } : {}),
                ...(pattern !== undefined ? { pattern } : {}),
                ...(clusterNode !== undefined ? { node: clusterNode } : {}),
              }}
              restore={node.kind !== 'namespace'}
            />
            <MenuItem onSelect={() => void loadChildren(profile.id, node.path)}>Refresh</MenuItem>
          </>
        }
      />
      {expanded && node.hasChildren && (
        <div role="group">
          <Children
            profile={profile}
            path={node.path}
            depth={depth + 1}
            {...(pattern !== undefined ? { pattern } : {})}
          />
        </div>
      )}
    </div>
  );
}
