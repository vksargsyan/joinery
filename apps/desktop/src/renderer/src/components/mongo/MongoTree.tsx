import type { BrowseNode } from '@joinery/core';
import type { StoredProfile } from '@joinery/ipc';
import { formatShellInline, fromEjson } from '@joinery/mongo-tools';
import { DropdownMenu } from 'radix-ui';
import type { ReactNode } from 'react';

import { errorMessage } from '../../lib/errors';
import { formatCount } from '../../lib/format';
import { confirm } from '../../state/dialogs';
import { loadChildren, pathKey, toggleNode, useExplorer } from '../../state/explorer';
import {
  describeObject,
  dropCommand,
  dropMongoObject,
  mongoObjectOf,
  opensCollection,
  type MongoObject,
} from '../../state/mongo/explorer';
import { openCreateCollection, openCreateView } from '../../state/mongo/create-dialogs';
import { openServerTools } from '../../state/server-tools/panels';
import { openTransferFrom } from '../../state/transfer-db/api';
import { MenuItem, Row } from '../Sidebar';
import { Icon } from '../ui';
import { MongoCreateDialogs } from './CreateDialogs';
import { openMongoCollection, openMongoConsole, openMongoTool } from './open';

/**
 * A MongoDB connection's object tree (spec §5): databases, then collections, views, time series
 * collections, GridFS buckets, users and roles, with each collection's indexes. Double-click (or
 * Enter) opens a collection or view in the collection view, a bucket in the GridFS browser and a
 * user or role in the users and roles editor; the menu opens a console and the tool panels
 * (aggregation, indexes, schema, options, change streams), creates collections and views,
 * refreshes, and drops objects after showing the exact command.
 */

type MongoIconName = 'collection' | 'view' | 'time-series' | 'bucket' | 'index' | 'user' | 'role';

function MongoIcon({ name }: { readonly name: MongoIconName }) {
  const paths: Record<MongoIconName, ReactNode> = {
    collection: (
      <>
        <rect x="3" y="2.5" width="10" height="3" rx="0.8" stroke="currentColor" fill="none" />
        <rect x="3" y="6.5" width="10" height="3" rx="0.8" stroke="currentColor" fill="none" />
        <rect x="3" y="10.5" width="10" height="3" rx="0.8" stroke="currentColor" fill="none" />
      </>
    ),
    view: (
      <>
        <path
          d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8 12.1 12.5 8 12.5 1.5 8 1.5 8z"
          stroke="currentColor"
          fill="none"
        />
        <circle cx="8" cy="8" r="2" stroke="currentColor" fill="none" />
      </>
    ),
    'time-series': (
      <path
        d="M2 12.5l3.5-4 3 2.5L14 4M2 14h12"
        stroke="currentColor"
        fill="none"
        strokeWidth="1.2"
      />
    ),
    bucket: (
      <>
        <path d="M2.5 5.5h11v8h-11z" stroke="currentColor" fill="none" />
        <path d="M2 3h12v2.5H2z" stroke="currentColor" fill="none" />
      </>
    ),
    index: (
      <>
        <circle cx="5.5" cy="8" r="3" stroke="currentColor" fill="none" />
        <path d="M8.5 8H14M12 8v2.5" stroke="currentColor" fill="none" />
      </>
    ),
    user: (
      <>
        <circle cx="8" cy="5.5" r="2.5" stroke="currentColor" fill="none" />
        <path d="M3 14c.5-3 2.5-4.5 5-4.5s4.5 1.5 5 4.5" stroke="currentColor" fill="none" />
      </>
    ),
    role: (
      <path
        d="M8 1.8l5 2v4c0 3.2-2.2 5.4-5 6.4-2.8-1-5-3.2-5-6.4v-4z"
        stroke="currentColor"
        fill="none"
      />
    ),
  };
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" className="h-4 w-4 shrink-0 text-muted">
      {paths[name]}
    </svg>
  );
}

function iconFor(node: BrowseNode) {
  switch (node.kind) {
    case 'database':
      return <Icon name="database" className="text-muted" />;
    case 'collection':
      return <MongoIcon name="collection" />;
    case 'view':
      return <MongoIcon name="view" />;
    case 'time-series':
      return <MongoIcon name="time-series" />;
    case 'gridfs-bucket':
      return <MongoIcon name="bucket" />;
    case 'index':
      return <MongoIcon name="index" />;
    case 'user':
      return <MongoIcon name="user" />;
    case 'role':
      return <MongoIcon name="role" />;
    default:
      return <Icon name="folder" className="text-muted" />;
  }
}

/** A short figure beside a node: documents, files, or an index's keys. */
function detailOf(node: BrowseNode): string | undefined {
  const detail = node.detail ?? {};
  if (typeof detail['count'] === 'number') return formatCount(detail['count']);
  if (typeof detail['files'] === 'number') {
    return `${formatCount(detail['files'])} ${detail['files'] === 1 ? 'file' : 'files'}`;
  }
  if (node.kind === 'index' && typeof detail['keys'] === 'string') {
    try {
      return formatShellInline(fromEjson(detail['keys'], 'index keys'));
    } catch {
      return detail['keys'];
    }
  }
  return undefined;
}

export function MongoTree(props: {
  readonly profile: StoredProfile;
  readonly depth: number;
  readonly onError: (message: string) => void;
}) {
  return (
    <>
      <MongoChildren {...props} path={[]} />
      <MongoCreateDialogs profileId={props.profile.id} />
    </>
  );
}

/** Opens the tool panel a node stands for on double-click; undefined when it has none. */
function toolOpener(profileId: string, node: BrowseNode): (() => void) | undefined {
  const [db, folder, name] = node.path;
  if (db === undefined) return undefined;
  if (node.kind === 'gridfs-bucket' && name !== undefined) {
    return () => openMongoTool({ tool: 'gridfs', target: { profileId, db, bucket: name } });
  }
  if ((node.kind === 'user' || node.kind === 'role') && name !== undefined) {
    const tab = node.kind === 'user' ? 'users' : 'roles';
    return () => openMongoTool({ tool: 'users', target: { profileId, db, tab, select: name } });
  }
  if (node.kind === 'index' && folder !== undefined && name !== undefined) {
    return () => openMongoTool({ tool: 'indexes', target: { profileId, db, collection: name } });
  }
  return undefined;
}

/** The tool menu items of a node (collections, databases and folders). */
function ToolItems(props: { readonly profile: StoredProfile; readonly node: BrowseNode }) {
  const { profile, node } = props;
  const profileId = profile.id;
  const readOnly = profile.presentation.readOnly;
  const [db, folder, name, sub] = node.path;
  if (db === undefined) return null;
  const object = mongoObjectOf(node);
  if (
    object &&
    (object.kind === 'collection' || object.kind === 'view' || object.kind === 'time-series')
  ) {
    const target = { profileId, db, collection: object.name };
    return (
      <>
        <MenuItem onSelect={() => openMongoTool({ tool: 'aggregation', target })}>
          Aggregate…
        </MenuItem>
        {object.kind !== 'view' && (
          <MenuItem onSelect={() => openMongoTool({ tool: 'indexes', target })}>Indexes</MenuItem>
        )}
        <MenuItem
          onSelect={() =>
            openMongoTool({ tool: 'schema', target: { ...target, kind: object.kind } })
          }
        >
          Analyse schema
        </MenuItem>
        <MenuItem onSelect={() => openMongoTool({ tool: 'options', target })}>Options</MenuItem>
        {object.kind !== 'view' && (
          <MenuItem
            onSelect={() =>
              openServerTools(profile, {
                tab: 'maintenance',
                focus: { container: db, name: object.name },
              })
            }
          >
            Maintenance…
          </MenuItem>
        )}
        {object.kind !== 'view' && (
          <MenuItem
            onSelect={() =>
              openMongoTool({
                tool: 'changes',
                target: {
                  profileId,
                  scope: { kind: 'collection', ns: { db, collection: object.name } },
                },
              })
            }
          >
            Watch changes
          </MenuItem>
        )}
        {!readOnly && (
          <MenuItem onSelect={() => openCreateView(profileId, db, object.name)}>
            Create view on it…
          </MenuItem>
        )}
        <MenuItem
          onSelect={() => openTransferFrom(profile, { database: db, objects: [object.name] })}
        >
          Transfer data to…
        </MenuItem>
      </>
    );
  }
  if (node.kind === 'database') {
    return (
      <>
        {!readOnly && (
          <>
            <MenuItem onSelect={() => openCreateCollection(profileId, db)}>
              Create collection…
            </MenuItem>
            <MenuItem onSelect={() => openCreateView(profileId, db)}>Create view…</MenuItem>
          </>
        )}
        <MenuItem
          onSelect={() =>
            openMongoTool({
              tool: 'changes',
              target: { profileId, scope: { kind: 'database', db } },
            })
          }
        >
          Watch changes
        </MenuItem>
        <MenuItem
          onSelect={() =>
            openMongoTool({ tool: 'changes', target: { profileId, scope: { kind: 'cluster' } } })
          }
        >
          Watch the whole deployment
        </MenuItem>
        <MenuItem
          onSelect={() => openMongoTool({ tool: 'users', target: { profileId, db, tab: 'users' } })}
        >
          Users and roles
        </MenuItem>
        <MenuItem
          onSelect={() => openServerTools(profile, { tab: 'topQueries', focus: { container: db } })}
        >
          Profiler…
        </MenuItem>
        <MenuItem onSelect={() => openTransferFrom(profile, { database: db })}>
          Transfer data to…
        </MenuItem>
      </>
    );
  }
  if (node.kind !== 'folder') return null;
  if (sub === 'indexes' && name !== undefined) {
    return (
      <MenuItem
        onSelect={() =>
          openMongoTool({ tool: 'indexes', target: { profileId, db, collection: name } })
        }
      >
        Manage indexes
      </MenuItem>
    );
  }
  switch (folder) {
    case 'users':
    case 'roles':
      return (
        <MenuItem
          onSelect={() => openMongoTool({ tool: 'users', target: { profileId, db, tab: folder } })}
        >
          {folder === 'users' ? 'Manage users' : 'Manage roles'}
        </MenuItem>
      );
    case 'collections':
      return readOnly ? null : (
        <MenuItem onSelect={() => openCreateCollection(profileId, db)}>Create collection…</MenuItem>
      );
    case 'time-series':
      return readOnly ? null : (
        <MenuItem onSelect={() => openCreateCollection(profileId, db, 'timeseries')}>
          Create time series collection…
        </MenuItem>
      );
    case 'views':
      return readOnly ? null : (
        <MenuItem onSelect={() => openCreateView(profileId, db)}>Create view…</MenuItem>
      );
    default:
      return null;
  }
}

function MongoChildren(props: {
  readonly profile: StoredProfile;
  readonly path: readonly string[];
  readonly depth: number;
  readonly onError: (message: string) => void;
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
        <MongoNode
          key={pathKey(node.path)}
          node={node}
          profile={props.profile}
          depth={props.depth}
          onError={props.onError}
        />
      ))}
    </>
  );
}

function MongoNode(props: {
  readonly node: BrowseNode;
  readonly profile: StoredProfile;
  readonly depth: number;
  readonly onError: (message: string) => void;
}) {
  const { node, profile } = props;
  const expanded = useExplorer((s) => s.expanded[profile.id]?.[pathKey(node.path)] === true);
  const object = mongoObjectOf(node);
  const opens = opensCollection(node) && object !== undefined && 'name' in object;
  const readOnly = profile.presentation.readOnly;
  const command = object && !readOnly ? dropCommand(object) : undefined;
  const database = node.path[0];

  const tool = toolOpener(profile.id, node);
  const open = (): void => {
    if (!opens || object.kind === 'index') return;
    openMongoCollection({
      profileId: profile.id,
      db: object.db,
      collection: object.name,
      kind: object.kind as 'collection' | 'view' | 'time-series',
    });
  };
  const drop = async (target: MongoObject, text: string): Promise<void> => {
    const ok = await confirm({
      title: `Drop ${describeObject(target)}?`,
      message:
        target.kind === 'database'
          ? 'The database and everything in it are deleted. This runs:'
          : 'This cannot be undone. This runs:',
      detail: text,
      confirmLabel: 'Drop',
      danger: true,
    });
    if (!ok) return;
    try {
      await dropMongoObject(profile.id, target);
    } catch (error) {
      props.onError(`${profile.name}: ${errorMessage(error)}`);
    }
  };
  const detail = detailOf(node);
  const hasMenu =
    opens ||
    node.kind === 'database' ||
    node.hasChildren ||
    command !== undefined ||
    tool !== undefined;

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
        onActivate={opens ? open : tool}
        title={
          opens ? 'Double-click to open the documents' : tool ? 'Double-click to open' : undefined
        }
        label={
          <span className="flex min-w-0 items-center gap-1.5" data-mongo-kind={node.kind}>
            {iconFor(node)}
            <span className="truncate">{node.name}</span>
            {detail !== undefined && (
              <span className="ml-auto max-w-[45%] shrink-0 truncate pl-1 font-mono text-[10px] text-muted">
                {detail}
              </span>
            )}
          </span>
        }
        menu={
          hasMenu ? (
            <>
              {opens && <MenuItem onSelect={open}>Open documents</MenuItem>}
              {tool && (
                <MenuItem onSelect={tool}>
                  {node.kind === 'gridfs-bucket'
                    ? 'Open files'
                    : node.kind === 'index'
                      ? 'Manage indexes'
                      : 'Open in users and roles'}
                </MenuItem>
              )}
              <ToolItems profile={profile} node={node} />
              {database !== undefined && (node.kind === 'database' || opens) && (
                <MenuItem
                  onSelect={() =>
                    openMongoConsole({
                      profileId: profile.id,
                      title: `${database} console`,
                      database,
                    })
                  }
                >
                  Open console
                </MenuItem>
              )}
              {node.hasChildren && (
                <MenuItem onSelect={() => void loadChildren(profile.id, node.path)}>
                  Refresh
                </MenuItem>
              )}
              {object && command && (
                <>
                  <DropdownMenu.Separator className="my-1 h-px bg-border" />
                  <MenuItem danger onSelect={() => void drop(object, command)}>
                    {object.kind === 'database'
                      ? 'Drop database…'
                      : object.kind === 'index'
                        ? 'Drop index…'
                        : object.kind === 'view'
                          ? 'Drop view…'
                          : object.kind === 'user'
                            ? 'Drop user…'
                            : object.kind === 'role'
                              ? 'Drop role…'
                              : 'Drop collection…'}
                  </MenuItem>
                </>
              )}
            </>
          ) : undefined
        }
      />
      {expanded && node.hasChildren && (
        <div role="group">
          <MongoChildren
            profile={profile}
            path={node.path}
            depth={props.depth + 1}
            onError={props.onError}
          />
        </div>
      )}
    </div>
  );
}
