import type { BrowseNode } from '@querybara/core';
import type { StoredProfile } from '@querybara/ipc';
import { DropdownMenu } from 'radix-ui';
import { useState, type ReactNode } from 'react';

import { errorMessage } from '../../lib/errors';
import { formatCount } from '../../lib/format';
import { confirm } from '../../state/dialogs';
import { loadChildren, pathKey, toggleNode, useExplorer } from '../../state/explorer';
import {
  deleteRequest,
  deleteSearchObject,
  describeSearchObject,
  healthOf,
  searchObjectOf,
  searchText,
  type SearchObject,
} from '../../state/search/explorer';
import { MenuItem } from '../MenuItem';
import { Row } from '../Sidebar';
import { Icon, cx } from '../ui';
import { CreateIndexDialog } from './CreateIndexDialog';
import { openSearchConsole, openSearchTool } from './open';
import { formatBytes } from './parts';

/**
 * An Elasticsearch connection's object tree (spec §5): Indices with their health
 * badge, documents and size; Data streams with their backing index count; Aliases with the
 * indices they point at; then the Console, SQL, Cluster, Templates and pipelines, and
 * Snapshots. Double-click (or Enter) on an index, alias or data stream opens its document
 * grid; the menu opens the index panel or a console that searches it, refreshes, creates an
 * index (on the Indices folder) and deletes an index or data stream after showing the exact
 * request.
 */

type SearchIconName =
  'index' | 'stream' | 'alias' | 'console' | 'sql' | 'cluster' | 'template' | 'snapshot';

function SearchIcon({ name }: { readonly name: SearchIconName }) {
  const paths: Record<SearchIconName, ReactNode> = {
    index: (
      <>
        <rect x="3" y="2.5" width="10" height="11" rx="1" stroke="currentColor" fill="none" />
        <path d="M5.5 5.5h5M5.5 8h5M5.5 10.5h3" stroke="currentColor" />
      </>
    ),
    stream: (
      <path
        d="M2 5c2-1.5 4-1.5 6 0s4 1.5 6 0M2 8c2-1.5 4-1.5 6 0s4 1.5 6 0M2 11c2-1.5 4-1.5 6 0s4 1.5 6 0"
        stroke="currentColor"
        fill="none"
      />
    ),
    alias: (
      <path
        d="M6.5 9.5l3-3M5 7.5L3.5 9a2 2 0 0 0 3 3L8 10.5M11 8.5L12.5 7a2 2 0 0 0-3-3L8 5.5"
        stroke="currentColor"
        fill="none"
      />
    ),
    console: (
      <path
        d="M3 4.5l3.5 3.5L3 11.5M8 11.5h5"
        stroke="currentColor"
        fill="none"
        strokeWidth="1.3"
      />
    ),
    sql: (
      <>
        <ellipse cx="8" cy="4" rx="5" ry="1.8" stroke="currentColor" fill="none" />
        <path
          d="M3 4v8c0 1 2.2 1.8 5 1.8s5-.8 5-1.8V4M3 8c0 1 2.2 1.8 5 1.8s5-.8 5-1.8"
          stroke="currentColor"
          fill="none"
        />
      </>
    ),
    cluster: (
      <>
        <circle cx="8" cy="4" r="1.8" stroke="currentColor" fill="none" />
        <circle cx="4" cy="11.5" r="1.8" stroke="currentColor" fill="none" />
        <circle cx="12" cy="11.5" r="1.8" stroke="currentColor" fill="none" />
        <path d="M7 5.5L5 10M9 5.5l2 4.5M5.8 11.5h4.4" stroke="currentColor" fill="none" />
      </>
    ),
    template: (
      <>
        <rect
          x="2.5"
          y="2.5"
          width="11"
          height="11"
          rx="1"
          stroke="currentColor"
          fill="none"
          strokeDasharray="2 1.5"
        />
        <path d="M5 6h6M5 9h4" stroke="currentColor" />
      </>
    ),
    snapshot: (
      <>
        <rect x="2" y="4.5" width="12" height="8.5" rx="1" stroke="currentColor" fill="none" />
        <circle cx="8" cy="8.7" r="2.3" stroke="currentColor" fill="none" />
        <path d="M5.5 4.5l1-1.5h3l1 1.5" stroke="currentColor" fill="none" />
      </>
    ),
  };
  return (
    <svg
      viewBox="0 0 16 16"
      aria-hidden="true"
      strokeWidth={1.3}
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-4 w-4 shrink-0 text-muted"
    >
      {paths[name]}
    </svg>
  );
}

/** The index health as a coloured dot; the word is in its tooltip and for screen readers. */
export function HealthBadge(props: { readonly health: 'green' | 'yellow' | 'red' | 'closed' }) {
  return (
    <span
      data-testid="health-badge"
      title={props.health === 'closed' ? 'Closed' : `Health ${props.health}`}
      className="flex shrink-0 items-center"
    >
      <span
        aria-hidden="true"
        className={cx(
          'h-2 w-2 rounded-full',
          props.health === 'green' && 'bg-success',
          props.health === 'yellow' && 'bg-warning',
          props.health === 'red' && 'bg-danger',
          props.health === 'closed' && 'border border-muted',
        )}
      />
      <span className="sr-only">{props.health}</span>
    </span>
  );
}

function iconFor(node: BrowseNode) {
  switch (node.kind) {
    case 'index':
      return <SearchIcon name="index" />;
    case 'data-stream':
      return <SearchIcon name="stream" />;
    case 'alias':
      return <SearchIcon name="alias" />;
    default:
      return <Icon name="folder" className="text-muted" />;
  }
}

/** A short figure beside a node: documents and size, backing indices, or the aliased indices. */
function detailOf(node: BrowseNode): string | undefined {
  const detail = node.detail ?? {};
  if (node.kind === 'index') {
    const docs = detail['docs'];
    const size = detail['size'];
    const parts = [
      ...(typeof docs === 'number' ? [`${formatCount(docs)} docs`] : []),
      ...(typeof size === 'number' ? [formatBytes(size)] : []),
    ];
    return parts.length > 0 ? parts.join(' · ') : undefined;
  }
  if (node.kind === 'data-stream' && typeof detail['indices'] === 'number') {
    return `${formatCount(detail['indices'])} ${detail['indices'] === 1 ? 'index' : 'indices'}`;
  }
  if (node.kind === 'alias' && typeof detail['indices'] === 'string') return detail['indices'];
  return undefined;
}

/** A tool row below the folders: double-click (or Enter) opens its panel. */
function ToolRow(props: {
  readonly depth: number;
  readonly icon: SearchIconName;
  readonly label: string;
  readonly kind: string;
  readonly onOpen: () => void;
}) {
  return (
    <div role="treeitem" aria-selected={false}>
      <Row
        depth={props.depth}
        expandable={false}
        expanded={false}
        onToggle={() => undefined}
        onActivate={props.onOpen}
        title={`Double-click to open ${props.label}`}
        label={
          <span className="flex min-w-0 items-center gap-1.5" data-search-kind={props.kind}>
            <SearchIcon name={props.icon} />
            <span className="truncate">{props.label}</span>
          </span>
        }
        menu={
          <MenuItem icon="open" onSelect={props.onOpen}>
            Open {props.label}
          </MenuItem>
        }
      />
    </div>
  );
}

export function SearchTree(props: {
  readonly profile: StoredProfile;
  readonly depth: number;
  readonly onError: (message: string) => void;
}) {
  const { profile, depth } = props;
  const [creating, setCreating] = useState(false);
  const openConsole = (): void => {
    openSearchConsole({ profileId: profile.id, title: `${profile.name} console` });
  };
  const profileId = profile.id;
  return (
    <>
      <SearchChildren {...props} path={[]} onCreateIndex={() => setCreating(true)} />
      <ToolRow depth={depth} icon="console" label="Console" kind="console" onOpen={openConsole} />
      <ToolRow
        depth={depth}
        icon="sql"
        label="SQL"
        kind="sql"
        onOpen={() => openSearchTool({ tool: 'sql', profileId })}
      />
      <ToolRow
        depth={depth}
        icon="cluster"
        label="Cluster"
        kind="cluster"
        onOpen={() => openSearchTool({ tool: 'cluster', profileId })}
      />
      <ToolRow
        depth={depth}
        icon="template"
        label="Templates and pipelines"
        kind="admin"
        onOpen={() => openSearchTool({ tool: 'admin', profileId })}
      />
      <ToolRow
        depth={depth}
        icon="snapshot"
        label="Snapshots"
        kind="snapshots"
        onOpen={() => openSearchTool({ tool: 'snapshots', profileId })}
      />
      {creating && (
        <CreateIndexDialog
          profileId={profileId}
          onClose={() => setCreating(false)}
          onCreated={(name) => openSearchTool({ tool: 'index', profileId, index: name })}
        />
      )}
    </>
  );
}

function SearchChildren(props: {
  readonly profile: StoredProfile;
  readonly path: readonly string[];
  readonly depth: number;
  readonly onError: (message: string) => void;
  readonly onCreateIndex: () => void;
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
        Empty
      </p>
    );
  }
  return (
    <>
      {state.nodes?.map((node) => (
        <SearchNode
          key={pathKey(node.path)}
          node={node}
          profile={props.profile}
          depth={props.depth}
          onError={props.onError}
          onCreateIndex={props.onCreateIndex}
        />
      ))}
    </>
  );
}

function SearchNode(props: {
  readonly node: BrowseNode;
  readonly profile: StoredProfile;
  readonly depth: number;
  readonly onError: (message: string) => void;
  readonly onCreateIndex: () => void;
}) {
  const { node, profile } = props;
  const expanded = useExplorer((s) => s.expanded[profile.id]?.[pathKey(node.path)] === true);
  const object = searchObjectOf(node);
  const health = healthOf(node);
  const detail = detailOf(node);
  const readOnly = profile.presentation.readOnly;
  const request = object && !readOnly ? deleteRequest(object) : undefined;
  const indicesFolder = node.path.length === 1 && node.path[0] === 'indices';

  const search = (target: SearchObject): void => {
    openSearchConsole({
      profileId: profile.id,
      title: `${target.name} console`,
      text: searchText(target),
    });
  };
  const browse = (target: SearchObject): void => {
    openSearchTool({
      tool: 'documents',
      target: { profileId: profile.id, target: target.name, kind: target.kind },
    });
  };
  const manage = (target: SearchObject): void => {
    openSearchTool({ tool: 'index', profileId: profile.id, index: target.name });
  };
  const remove = async (target: SearchObject, text: string): Promise<void> => {
    const ok = await confirm({
      title: `Delete ${describeSearchObject(target)}?`,
      message:
        target.kind === 'data-stream'
          ? 'The data stream and all its backing indices are deleted. This cannot be undone. This sends:'
          : 'The index and all its documents are deleted. This cannot be undone. This sends:',
      detail: text,
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    try {
      await deleteSearchObject(profile.id, target);
    } catch (error) {
      props.onError(`${profile.name}: ${errorMessage(error)}`);
    }
  };

  return (
    <div
      role="treeitem"
      aria-expanded={node.hasChildren ? expanded : undefined}
      aria-selected={false}
    >
      <Row
        depth={props.depth}
        expandable={node.hasChildren}
        expanded={expanded}
        onToggle={() => toggleNode(profile.id, node)}
        onActivate={object ? () => browse(object) : undefined}
        title={object ? 'Double-click to browse its documents' : undefined}
        label={
          <span className="flex min-w-0 items-center gap-1.5" data-search-kind={node.kind}>
            {iconFor(node)}
            <span className="truncate">{node.name}</span>
            {health && <HealthBadge health={health} />}
            {detail !== undefined && (
              <span className="ml-auto max-w-[45%] shrink-0 truncate pl-1 font-mono text-[10px] text-muted">
                {detail}
              </span>
            )}
          </span>
        }
        menu={
          <>
            {object && (
              <MenuItem icon="table" onSelect={() => browse(object)}>
                Browse documents
              </MenuItem>
            )}
            {object?.kind === 'index' && (
              <MenuItem icon="open" onSelect={() => manage(object)}>
                Open index (mappings, settings…)
              </MenuItem>
            )}
            {object && (
              <MenuItem icon="query" onSelect={() => search(object)}>
                Search in console
              </MenuItem>
            )}
            {indicesFolder && !readOnly && (
              <MenuItem icon="table-new" onSelect={props.onCreateIndex}>
                Create index…
              </MenuItem>
            )}
            {node.hasChildren && (
              <MenuItem icon="refresh" onSelect={() => void loadChildren(profile.id, node.path)}>
                Refresh
              </MenuItem>
            )}
            {!object && !node.hasChildren && (
              <MenuItem icon="refresh" onSelect={() => void loadChildren(profile.id, [])}>
                Refresh
              </MenuItem>
            )}
            {object && request && (
              <>
                <DropdownMenu.Separator className="my-1 h-px bg-border" />
                <MenuItem
                  icon="trash"
                  danger
                  onSelect={() => void remove(object, `${request.method} ${request.path}`)}
                >
                  {object.kind === 'data-stream' ? 'Delete data stream…' : 'Delete index…'}
                </MenuItem>
              </>
            )}
          </>
        }
      />
      {expanded && node.hasChildren && (
        <div role="group">
          <SearchChildren
            profile={profile}
            path={node.path}
            depth={props.depth + 1}
            onError={props.onError}
            onCreateIndex={props.onCreateIndex}
          />
        </div>
      )}
    </div>
  );
}
