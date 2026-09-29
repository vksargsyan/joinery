import { hasWeakTls, isSqlEngine, type BrowseNode, type SqlDialect } from '@joinery/core';
import type { Folder, StoredProfile } from '@joinery/ipc';
import { useQueryClient } from '@tanstack/react-query';
import { DropdownMenu } from 'radix-ui';
import { useState, type KeyboardEvent, type ReactNode } from 'react';
import { create } from 'zustand';

import { errorMessage } from '../lib/errors';
import { mainApi } from '../lib/main-client';
import { connect, disconnect, useConnections } from '../state/connections';
import { keys, useFolders, useProfiles } from '../state/data';
import { confirm } from '../state/dialogs';
import {
  isDesignableTable,
  loadChildren,
  newTableLocation,
  opensData,
  pathKey,
  resetExplorer,
  selectStatementFor,
  tableLocation,
  tablesFolderPath,
  toggleNode,
  useExplorer,
} from '../state/explorer';
import { refreshObjects } from '../state/metadata';
import { hasServerTools, openServerTools } from '../state/server-tools/panels';
import type { DesignerTarget } from '../state/designer';
import { openExportTables, openImportWizard, openRunSqlFile } from '../state/transfer-dialogs';
import { openDataCompare, openStructureCompare } from '../state/sync/panels';
import { openTransferFrom } from '../state/transfer-db/api';
import { DropTableDialog } from './designer/ReviewDialogs';
import { MongoTree } from './mongo/MongoTree';
import { RedisTree, openRedisTool } from './redis/RedisTree';
import { openQueryTab, openTableData, openTableDesigner } from './dock';
import type { ConnectionDialogMode } from './ConnectionDialog';
import { Button, EnvironmentBadge, Icon, cx } from './ui';

/**
 * The connections sidebar (spec §4, §5): profiles grouped by folder with their environment, and
 * under each open connection its lazily loaded object tree. Keyboard: arrows move, Right/Left
 * expand and collapse, Enter opens. Tables open in the data view and the table designer
 * (spec §7, §8); views and other relations open their rows in a query tab.
 */

/** The table the "Drop table…" review is open for. */
const useDropRequest = create<{
  readonly target?: DesignerTarget & { readonly name: string };
}>()(() => ({}));

function DropTableHost() {
  const target = useDropRequest((state) => state.target);
  if (!target) return null;
  return (
    <DropTableDialog
      target={target}
      onClose={() => useDropRequest.setState({ target: undefined })}
      onDropped={() => undefined}
    />
  );
}

export function Sidebar(props: { readonly onEdit: (mode: ConnectionDialogMode) => void }) {
  const profiles = useProfiles();
  const folders = useFolders();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string>();

  const newFolder = async (): Promise<void> => {
    const name = `Folder ${(folders.data?.length ?? 0) + 1}`;
    try {
      await mainApi().folders.save({ name });
      await queryClient.invalidateQueries({ queryKey: keys.folders });
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const grouped = new Map<string | null, StoredProfile[]>();
  for (const profile of profiles.data ?? []) {
    const key = profile.presentation.folderId;
    grouped.set(key, [...(grouped.get(key) ?? []), profile]);
  }

  return (
    <aside
      className="flex h-full min-w-0 flex-col border-r border-border bg-panel"
      aria-label="Connections"
    >
      <div className="flex items-center gap-1 border-b border-border px-2 py-1.5">
        <h2 className="flex-1 text-xs font-semibold tracking-wide text-muted uppercase">
          Connections
        </h2>
        <Button size="sm" variant="ghost" onClick={() => void newFolder()} aria-label="New folder">
          <Icon name="folder" />
        </Button>
        <Button
          size="sm"
          variant="primary"
          onClick={() => props.onEdit({ kind: 'create' })}
          aria-label="New connection"
        >
          <Icon name="plus" />
          New
        </Button>
      </div>
      {error && (
        <p role="alert" className="px-3 py-2 text-xs text-danger">
          {error}
        </p>
      )}
      <div
        role="tree"
        aria-label="Connections and objects"
        className="min-h-0 flex-1 overflow-auto py-1"
      >
        {profiles.isLoading && <p className="px-3 py-2 text-xs text-muted">Loading…</p>}
        {profiles.data?.length === 0 && (
          <div className="px-3 py-6 text-center text-xs text-muted">
            <p>No connections yet.</p>
            <Button
              className="mt-3"
              variant="primary"
              onClick={() => props.onEdit({ kind: 'create' })}
            >
              Create a connection
            </Button>
          </div>
        )}
        {(grouped.get(null) ?? []).map((profile) => (
          <ProfileItem
            key={profile.id}
            profile={profile}
            onEdit={props.onEdit}
            onError={setError}
          />
        ))}
        {(folders.data ?? []).map((folder) => (
          <FolderItem
            key={folder.id}
            folder={folder}
            profiles={grouped.get(folder.id) ?? []}
            onEdit={props.onEdit}
            onError={setError}
          />
        ))}
      </div>
      <DropTableHost />
    </aside>
  );
}

function FolderItem(props: {
  readonly folder: Folder;
  readonly profiles: readonly StoredProfile[];
  readonly onEdit: (mode: ConnectionDialogMode) => void;
  readonly onError: (message: string) => void;
}) {
  const [open, setOpen] = useState(true);
  const [renaming, setRenaming] = useState(false);
  const queryClient = useQueryClient();
  const rename = async (name: string): Promise<void> => {
    setRenaming(false);
    if (name.trim() === '' || name === props.folder.name) return;
    try {
      await mainApi().folders.save({
        id: props.folder.id,
        name,
        parentId: props.folder.parentId,
        sortOrder: props.folder.sortOrder,
        expectedVersion: props.folder.version,
      });
      await queryClient.invalidateQueries({ queryKey: keys.folders });
    } catch (e) {
      props.onError(errorMessage(e));
    }
  };
  const remove = async (): Promise<void> => {
    const ok = await confirm({
      title: `Delete folder "${props.folder.name}"?`,
      message: 'Its connections move up to the top level.',
      confirmLabel: 'Delete folder',
      danger: true,
    });
    if (!ok) return;
    try {
      await mainApi().folders.delete({ id: props.folder.id });
      await queryClient.invalidateQueries({ queryKey: keys.folders });
      await queryClient.invalidateQueries({ queryKey: keys.profiles });
    } catch (e) {
      props.onError(errorMessage(e));
    }
  };
  return (
    <div role="treeitem" aria-expanded={open} aria-selected={false}>
      <Row
        depth={0}
        onToggle={() => setOpen(!open)}
        expanded={open}
        expandable
        label={
          renaming ? (
            <input
              autoFocus
              defaultValue={props.folder.name}
              className="w-full rounded border border-accent bg-panel-2 px-1 text-[13px]"
              onBlur={(event) => void rename(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void rename(event.currentTarget.value);
                if (event.key === 'Escape') setRenaming(false);
              }}
            />
          ) : (
            <span className="flex items-center gap-1.5 font-medium">
              <Icon name="folder" className="text-muted" />
              {props.folder.name}
            </span>
          )
        }
        menu={
          <>
            <MenuItem onSelect={() => props.onEdit({ kind: 'create', folderId: props.folder.id })}>
              New connection here
            </MenuItem>
            <MenuItem onSelect={() => setRenaming(true)}>Rename</MenuItem>
            <MenuItem danger onSelect={() => void remove()}>
              Delete folder
            </MenuItem>
          </>
        }
      />
      {open && (
        <div role="group">
          {props.profiles.map((profile) => (
            <ProfileItem
              key={profile.id}
              profile={profile}
              depth={1}
              onEdit={props.onEdit}
              onError={props.onError}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ProfileItem(props: {
  readonly profile: StoredProfile;
  readonly depth?: number;
  readonly onEdit: (mode: ConnectionDialogMode) => void;
  readonly onError: (message: string) => void;
}) {
  const { profile } = props;
  const depth = props.depth ?? 0;
  const connection = useConnections((state) => state.byProfile[profile.id]);
  const rootNodes = useExplorer((state) => state.children[profile.id]?.[pathKey([])]);
  const queryClient = useQueryClient();
  const [expanded, setExpanded] = useState(false);
  const connected = connection?.status === 'ready';

  const open = async (): Promise<void> => {
    try {
      await connect(profile.id);
      setExpanded(true);
      void loadChildren(profile.id, []);
    } catch (e) {
      const message = errorMessage(e);
      if (message !== 'Cancelled') props.onError(`${profile.name}: ${message}`);
    }
  };
  const close = async (): Promise<void> => {
    setExpanded(false);
    resetExplorer(profile.id);
    await disconnect(profile.id).catch(() => undefined);
  };
  const newQuery = async (): Promise<void> => {
    if (profile.engine === 'redis') {
      openRedisTool(profile, 'cli');
      return;
    }
    openQueryTab({ profileId: profile.id, title: `${profile.name} query` });
  };
  const remove = async (): Promise<void> => {
    const ok = await confirm({
      title: `Delete "${profile.name}"?`,
      message: 'The connection, its saved passwords and its query history are deleted.',
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    try {
      await close();
      await mainApi().profiles.delete({ id: profile.id });
      await queryClient.invalidateQueries({ queryKey: keys.profiles });
    } catch (e) {
      props.onError(errorMessage(e));
    }
  };

  const status =
    connection?.status === 'ready'
      ? 'Connected'
      : connection?.status === 'connecting'
        ? 'Connecting…'
        : connection?.status === 'lost'
          ? 'Connection lost'
          : connection?.status === 'failed'
            ? 'Failed'
            : 'Not connected';

  return (
    <div role="treeitem" aria-expanded={expanded} aria-selected={false} aria-label={profile.name}>
      <Row
        depth={depth}
        expandable
        expanded={expanded}
        onToggle={() => {
          if (expanded) setExpanded(false);
          else if (connected) {
            setExpanded(true);
            if (!rootNodes) void loadChildren(profile.id, []);
          } else void open();
        }}
        onActivate={() => void (connected ? newQuery() : open())}
        label={
          <span className="flex min-w-0 items-center gap-1.5">
            <span
              aria-hidden="true"
              className={cx(
                'h-2 w-2 shrink-0 rounded-full',
                connected
                  ? 'bg-success'
                  : connection?.status === 'lost' || connection?.status === 'failed'
                    ? 'bg-danger'
                    : 'bg-border',
              )}
              style={
                profile.presentation.color
                  ? { outline: `2px solid ${profile.presentation.color}` }
                  : undefined
              }
            />
            <Icon name="database" className="text-muted" />
            <span className="truncate" data-testid="profile-name">
              {profile.name}
            </span>
            <EnvironmentBadge environment={profile.presentation.environment} />
            {profile.presentation.readOnly && (
              <span className="rounded bg-panel-2 px-1 text-[10px] text-muted" title="Read-only">
                RO
              </span>
            )}
            {hasWeakTls(profile) && (
              <span
                className="text-warning"
                title={
                  profile.tls.mode === 'disable'
                    ? 'TLS is disabled for this connection'
                    : 'The server certificate is not fully verified'
                }
              >
                <Icon name="warning" className="h-3.5 w-3.5" />
                <span className="sr-only">Weak TLS</span>
              </span>
            )}
            <span className="sr-only">{status}</span>
          </span>
        }
        menu={
          <>
            {connected ? (
              <>
                <MenuItem onSelect={() => void newQuery()}>
                  {profile.engine === 'redis' ? 'Open CLI' : 'New query tab'}
                </MenuItem>
                {isSqlEngine(profile.engine) && (
                  <MenuItem onSelect={() => openRunSqlFile(profile)}>Run SQL file…</MenuItem>
                )}
                {hasServerTools(profile.engine) && (
                  <MenuItem onSelect={() => openServerTools(profile)}>Server tools</MenuItem>
                )}
                {(isSqlEngine(profile.engine) ||
                  profile.engine === 'mongodb' ||
                  profile.engine === 'redis') && (
                  <MenuItem onSelect={() => openTransferFrom(profile)}>Transfer data to…</MenuItem>
                )}
                <MenuItem onSelect={() => refreshObjects(profile.id, [])}>Refresh objects</MenuItem>
                <MenuItem onSelect={() => void close()}>Disconnect</MenuItem>
              </>
            ) : (
              <MenuItem onSelect={() => void open()}>Connect</MenuItem>
            )}
            {isSqlEngine(profile.engine) && (
              <CompareItems
                source={{
                  profileId: profile.id,
                  database: profile.options.defaultDatabase ?? '',
                }}
              />
            )}
            <DropdownMenu.Separator className="my-1 h-px bg-border" />
            <MenuItem onSelect={() => props.onEdit({ kind: 'edit', profile })}>Edit…</MenuItem>
            <MenuItem onSelect={() => props.onEdit({ kind: 'duplicate', profile })}>
              Duplicate…
            </MenuItem>
            <MenuItem danger onSelect={() => void remove()}>
              Delete
            </MenuItem>
          </>
        }
      />
      {connection?.status === 'failed' && connection.error && (
        <p className="px-3 py-1 text-xs text-danger" style={{ paddingLeft: 28 + depth * 14 }}>
          {connection.error}
        </p>
      )}
      {expanded && connected && isSqlEngine(profile.engine) && (
        <div role="group">
          <NodeChildren profile={profile} dialect={profile.engine} path={[]} depth={depth + 1} />
        </div>
      )}
      {expanded && connected && profile.engine === 'mongodb' && (
        <div role="group">
          <MongoTree profile={profile} depth={depth + 1} onError={props.onError} />
        </div>
      )}
      {expanded && connected && profile.engine === 'redis' && (
        <div role="group">
          <RedisTree profile={profile} depth={depth + 1} />
        </div>
      )}
    </div>
  );
}

function NodeChildren(props: {
  readonly profile: StoredProfile;
  readonly dialect: SqlDialect;
  readonly path: readonly string[];
  readonly depth: number;
}) {
  const state = useExplorer((s) => s.children[props.profile.id]?.[pathKey(props.path)]);
  if (!state || (state.loading && !state.nodes)) {
    return (
      <p className="py-1 text-xs text-muted" style={{ paddingLeft: 12 + props.depth * 14 }}>
        Loading…
      </p>
    );
  }
  if (state.error) {
    return (
      <p className="py-1 text-xs text-danger" style={{ paddingLeft: 12 + props.depth * 14 }}>
        {state.error}
      </p>
    );
  }
  if (state.nodes?.length === 0) {
    return (
      <p className="py-1 text-xs text-muted" style={{ paddingLeft: 12 + props.depth * 14 }}>
        Empty
      </p>
    );
  }
  return (
    <>
      {state.nodes?.map((node) => (
        <ObjectNode
          key={pathKey(node.path)}
          node={node}
          profile={props.profile}
          dialect={props.dialect}
          depth={props.depth}
        />
      ))}
    </>
  );
}

function ObjectNode(props: {
  readonly node: BrowseNode;
  readonly profile: StoredProfile;
  readonly dialect: SqlDialect;
  readonly depth: number;
}) {
  const { node, profile, dialect } = props;
  const expanded = useExplorer((s) => s.expanded[profile.id]?.[pathKey(node.path)] === true);
  const table = isDesignableTable(node, dialect) ? tableLocation(node, dialect) : undefined;
  const newTable = newTableLocation(node, dialect);
  const openData = (): void => {
    if (table) {
      openTableData({ profileId: profile.id, ...table });
      return;
    }
    if (!opensData(node)) return;
    openQueryTab({
      profileId: profile.id,
      title: node.name,
      text: selectStatementFor(node, dialect),
      run: true,
    });
  };
  const designTarget = (
    name: string | null,
    location = table ?? newTable,
  ): DesignerTarget | undefined =>
    location && {
      profileId: profile.id,
      database: location.database,
      schema: location.schema,
      name,
      tablesPath: tablesFolderPath({ ...location, name: '' }, dialect),
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
        onActivate={opensData(node) ? openData : undefined}
        title={opensData(node) ? 'Double-click to open the rows' : undefined}
        label={
          <span className="flex min-w-0 items-center gap-1.5">
            <Icon
              name={
                node.kind === 'folder'
                  ? 'folder'
                  : node.kind === 'database' || node.kind === 'schema'
                    ? 'database'
                    : 'table'
              }
              className="text-muted"
            />
            <span className="truncate">{node.name}</span>
          </span>
        }
        menu={
          opensData(node) || node.hasChildren || newTable ? (
            <>
              {table ? (
                <>
                  <MenuItem onSelect={openData}>Open data</MenuItem>
                  <MenuItem onSelect={() => openTableDesigner(designTarget(table.name)!)}>
                    Design table
                  </MenuItem>
                  <MenuItem onSelect={() => openImportWizard(profile, table, table.name)}>
                    Import data…
                  </MenuItem>
                  <MenuItem
                    onSelect={() =>
                      openExportTables(
                        profile,
                        table,
                        [table.name],
                        tablesFolderPath(table, dialect),
                      )
                    }
                  >
                    Export…
                  </MenuItem>
                  <MenuItem
                    onSelect={() =>
                      openServerTools(profile, {
                        tab: 'maintenance',
                        focus: {
                          database: table.database,
                          container: table.schema,
                          name: table.name,
                        },
                      })
                    }
                  >
                    Maintenance…
                  </MenuItem>
                  <MenuItem
                    onSelect={() =>
                      openTransferFrom(profile, {
                        database: table.database,
                        schema: table.schema,
                        objects: [table.name],
                      })
                    }
                  >
                    Transfer data to…
                  </MenuItem>
                </>
              ) : (
                opensData(node) && <MenuItem onSelect={openData}>Open rows</MenuItem>
              )}
              {newTable && (
                <>
                  <MenuItem onSelect={() => openTableDesigner(designTarget(null, newTable)!)}>
                    New table…
                  </MenuItem>
                  <MenuItem onSelect={() => openImportWizard(profile, newTable, null)}>
                    Import into new table…
                  </MenuItem>
                  <MenuItem
                    onSelect={() =>
                      openExportTables(
                        profile,
                        newTable,
                        [],
                        tablesFolderPath({ ...newTable, name: '' }, dialect),
                      )
                    }
                  >
                    Export tables…
                  </MenuItem>
                  <MenuItem
                    onSelect={() =>
                      openTransferFrom(profile, {
                        database: newTable.database,
                        schema: newTable.schema,
                      })
                    }
                  >
                    Transfer data to…
                  </MenuItem>
                </>
              )}
              {node.kind === 'database' && (
                <MenuItem onSelect={() => openRunSqlFile(profile, node.name)}>
                  Run SQL file…
                </MenuItem>
              )}
              {node.kind === 'database' && node.path.length === 1 && (
                <CompareItems source={{ profileId: profile.id, database: node.name }} />
              )}
              {node.kind === 'schema' && dialect === 'postgres' && node.path.length === 2 && (
                <CompareItems
                  source={{
                    profileId: profile.id,
                    database: node.path[0] ?? '',
                    schemas: node.name,
                  }}
                />
              )}
              {node.hasChildren && (
                <MenuItem onSelect={() => refreshObjects(profile.id, node.path)}>Refresh</MenuItem>
              )}
              {table && (
                <>
                  <DropdownMenu.Separator className="my-1 h-px bg-border" />
                  <MenuItem
                    danger
                    onSelect={() =>
                      useDropRequest.setState({
                        target: { ...designTarget(table.name)!, name: table.name },
                      })
                    }
                  >
                    Drop table…
                  </MenuItem>
                </>
              )}
            </>
          ) : undefined
        }
      />
      {expanded && node.hasChildren && (
        <div role="group">
          <NodeChildren
            profile={profile}
            dialect={props.dialect}
            path={node.path}
            depth={props.depth + 1}
          />
        </div>
      )}
    </div>
  );
}

/** "Compare structure with…" and "Compare data with…" (spec §13), from this source. */
function CompareItems(props: {
  readonly source: {
    readonly profileId: string;
    readonly database: string;
    readonly schemas?: string;
  };
}) {
  return (
    <>
      <DropdownMenu.Separator className="my-1 h-px bg-border" />
      <MenuItem onSelect={() => openStructureCompare({ source: props.source })}>
        Compare structure with…
      </MenuItem>
      <MenuItem onSelect={() => openDataCompare({ source: props.source })}>
        Compare data with…
      </MenuItem>
    </>
  );
}

/**
 * One tree row: indent, disclosure chevron, label, and an actions menu, which the "Actions"
 * button and a right-click open.
 */
export function Row(props: {
  readonly depth: number;
  readonly label: ReactNode;
  readonly expandable: boolean;
  readonly expanded: boolean;
  readonly onToggle: () => void;
  readonly onActivate?: (() => void) | undefined;
  readonly menu?: ReactNode;
  readonly title?: string | undefined;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const row = event.currentTarget;
    const rows = [
      ...(row.closest('[role="tree"]')?.querySelectorAll<HTMLElement>('[data-tree-row]') ?? []),
    ];
    const index = rows.indexOf(row);
    switch (event.key) {
      case 'ArrowDown':
        rows[index + 1]?.focus();
        break;
      case 'ArrowUp':
        rows[index - 1]?.focus();
        break;
      case 'ArrowRight':
        if (props.expandable && !props.expanded) props.onToggle();
        else rows[index + 1]?.focus();
        break;
      case 'ArrowLeft':
        if (props.expandable && props.expanded) props.onToggle();
        break;
      case 'Enter':
        if (props.onActivate) props.onActivate();
        else props.onToggle();
        break;
      default:
        return;
    }
    event.preventDefault();
  };
  return (
    <div
      data-tree-row
      tabIndex={0}
      title={props.title}
      className="group flex h-7 cursor-default items-center gap-1 pr-1 text-[13px] hover:bg-hover focus:bg-hover focus:outline-none"
      style={{ paddingLeft: 6 + props.depth * 14 }}
      onClick={props.onToggle}
      onDoubleClick={props.onActivate}
      onKeyDown={onKeyDown}
      onContextMenu={
        props.menu
          ? (event) => {
              event.preventDefault();
              setMenuOpen(true);
            }
          : undefined
      }
    >
      <span className="w-4 text-muted">
        {props.expandable && (
          <Icon name={props.expanded ? 'chevron-down' : 'chevron-right'} className="h-3 w-3" />
        )}
      </span>
      <span className="min-w-0 flex-1">{props.label}</span>
      {props.menu && (
        <DropdownMenu.Root open={menuOpen} onOpenChange={setMenuOpen}>
          <DropdownMenu.Trigger asChild>
            <button
              type="button"
              aria-label="Actions"
              className="rounded p-0.5 text-muted opacity-0 group-hover:opacity-100 group-focus:opacity-100 hover:bg-panel-2 focus:opacity-100 data-[state=open]:opacity-100"
              onClick={(event) => event.stopPropagation()}
              onDoubleClick={(event) => event.stopPropagation()}
            >
              <Icon name="more" />
            </button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content
              align="start"
              className="z-50 min-w-44 rounded border border-border bg-panel p-1 text-[13px] shadow-xl"
              // The menu is portalled, but React events still bubble to the row: a click on an
              // item would toggle the row and menu keys would move through the tree.
              onClick={(event) => event.stopPropagation()}
              onDoubleClick={(event) => event.stopPropagation()}
              onKeyDown={(event) => event.stopPropagation()}
            >
              {props.menu}
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      )}
    </div>
  );
}

export function MenuItem(props: {
  readonly children: ReactNode;
  readonly onSelect: () => void;
  readonly danger?: boolean;
}) {
  return (
    <DropdownMenu.Item
      onSelect={props.onSelect}
      className={cx(
        'cursor-default rounded px-2 py-1.5 outline-none data-[highlighted]:bg-hover',
        props.danger && 'text-danger',
      )}
    >
      {props.children}
    </DropdownMenu.Item>
  );
}
