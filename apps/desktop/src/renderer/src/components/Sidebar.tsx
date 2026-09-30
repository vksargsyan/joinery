import {
  ENGINES,
  hasWeakTls,
  isSqlEngine,
  type BrowseNode,
  type EngineId,
  type Environment,
  type SqlDialect,
} from '@joinery/core';
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
import {
  clearSidebarFilter,
  filterActive,
  matchParts,
  setSidebarFilter,
  setSidebarSearch,
  toggled,
  useSidebarView,
  visibleTree,
} from '../state/sidebar-filter';
import { hasServerTools, openServerTools } from '../state/server-tools/panels';
import type { DesignerTarget } from '../state/designer';
import { openExportTables, openImportWizard, openRunSqlFile } from '../state/transfer-dialogs';
import { openDataCompare, openStructureCompare } from '../state/sync/panels';
import { openTransferFrom } from '../state/transfer-db/api';
import { openErDiagram } from '../state/er-diagram/panels';
import { openQueryBuilder } from '../state/query-builder/panels';
import { EngineIcon } from './EngineIcon';
import { BackupMenuItems } from './backup/BackupDialogs';
import { DropTableDialog } from './designer/ReviewDialogs';
import { MongoTree } from './mongo/MongoTree';
import { RedisTree, openRedisTool } from './redis/RedisTree';
import { SearchTree } from './search/SearchTree';
import { openQueryTab, openTableData, openTableDesigner } from './dock';
import type { ConnectionDialogMode } from './ConnectionDialog';
import { Button, EnvironmentBadge, Icon, cx } from './ui';

/**
 * The connections sidebar (spec §4, §5): profiles grouped by folder with their environment, and
 * under each open connection its lazily loaded object tree. Keyboard: arrows move, Right/Left
 * expand and collapse, Enter opens. Tables open in the data view and the table designer
 * (spec §7, §8); views and other relations open their rows in a query tab.
 *
 * As in Navicat, a click selects a connection and a double-click (or Enter) connects it, with a
 * spinner by its name while it connects; only a connected one has a chevron. The header's menu
 * creates connections and folders and closes every open connection; the search and the filter
 * at the bottom narrow the list (state/sidebar-filter.ts).
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
  const view = useSidebarView();
  const statuses = useConnections((state) => state.byProfile);
  const connected = (id: string): boolean => statuses[id]?.status === 'ready';
  // Open connections; one still connecting finishes (or fails) on its own.
  const open = Object.values(statuses).filter((c) => c.status === 'ready' || c.status === 'lost');

  const newFolder = async (): Promise<void> => {
    const name = `Folder ${(folders.data?.length ?? 0) + 1}`;
    try {
      await mainApi().folders.save({ name });
      await queryClient.invalidateQueries({ queryKey: keys.folders });
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const closeAll = async (): Promise<void> => {
    await Promise.all(
      open.map(async (c) => {
        resetExplorer(c.profileId);
        await disconnect(c.profileId).catch(() => undefined);
      }),
    );
  };

  const tree = visibleTree(profiles.data ?? [], folders.data ?? [], connected, view);
  const searching = view.search.trim() !== '';

  return (
    <aside
      className="flex h-full min-w-0 flex-col border-r border-border bg-panel"
      aria-label="Connections"
    >
      <div className="flex h-[35px] shrink-0 items-center gap-1 pr-1 pl-3">
        <h2 className="flex-1 text-[11px] font-semibold tracking-wide text-fg uppercase">
          Connections
        </h2>
        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <button
              type="button"
              aria-label="Connection actions"
              title="Connection actions"
              className="flex h-[22px] w-[22px] items-center justify-center rounded-sm text-muted hover:bg-hover hover:text-fg data-[state=open]:bg-pressed data-[state=open]:text-fg"
            >
              <Icon name="kebab" />
            </button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content
              align="end"
              className="z-50 min-w-56 rounded-md border border-border bg-raised p-1 text-[13px] shadow-widget"
            >
              <MenuItem onSelect={() => props.onEdit({ kind: 'create' })}>
                <IconLabel icon="connection-new">New connection</IconLabel>
              </MenuItem>
              <MenuItem onSelect={() => void newFolder()}>
                <IconLabel icon="folder-new">New folder</IconLabel>
              </MenuItem>
              <DropdownMenu.Separator className="my-1 h-px bg-border" />
              <MenuItem disabled={open.length === 0} onSelect={() => void closeAll()}>
                <IconLabel icon="disconnect">
                  Close all connections
                  {open.length > 0 && (
                    <span className="ml-auto text-xs text-faint">{open.length}</span>
                  )}
                </IconLabel>
              </MenuItem>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      </div>
      {error && (
        <p role="alert" className="px-3 py-2 text-xs text-danger">
          {error}
        </p>
      )}
      <div
        role="tree"
        aria-label="Connections and objects"
        className="min-h-0 flex-1 overflow-auto pb-1"
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
        {tree.empty && (
          <div className="px-3 py-6 text-center text-xs text-muted" data-testid="sidebar-no-match">
            <p>No connection matches.</p>
            <Button
              className="mt-3"
              size="sm"
              onClick={() => {
                setSidebarSearch('');
                clearSidebarFilter();
              }}
            >
              Show all connections
            </Button>
          </div>
        )}
        {tree.root.map((profile) => (
          <ProfileItem
            key={profile.id}
            profile={profile}
            search={view.search}
            onEdit={props.onEdit}
            onError={setError}
          />
        ))}
        {tree.folders.map(({ folder, profiles: inFolder }) => (
          <FolderItem
            key={folder.id}
            folder={folder}
            profiles={inFolder}
            search={view.search}
            forceOpen={searching}
            onEdit={props.onEdit}
            onError={setError}
          />
        ))}
      </div>
      <SearchBar />
      <DropTableHost />
    </aside>
  );
}

/** An icon and its label in a menu item. */
function IconLabel(props: {
  readonly icon: Parameters<typeof Icon>[0]['name'];
  readonly children: ReactNode;
}) {
  return (
    <span className="flex w-full items-center gap-2">
      <Icon name={props.icon} className="text-muted" />
      {props.children}
    </span>
  );
}

/** A name with the search's match in rust (Kiln's tree filter highlight). */
function Highlighted(props: { readonly text: string; readonly search: string }) {
  const parts = matchParts(props.text, props.search);
  if (!parts) return <>{props.text}</>;
  return (
    <>
      {parts.before}
      <mark className="bg-transparent font-semibold text-rust">{parts.match}</mark>
      {parts.after}
    </>
  );
}

/** The bottom of the side bar: the search, and the filter by engine, environment and state. */
function SearchBar() {
  const search = useSidebarView((s) => s.search);
  return (
    <div className="flex shrink-0 items-center gap-1 border-t border-border px-2 py-1.5">
      <label className="flex h-[26px] min-w-0 flex-1 items-center gap-1.5 rounded-sm border border-border bg-deep px-1.5 focus-within:border-focus">
        <Icon name="search" className="h-3.5 w-3.5 text-faint" />
        <input
          type="text"
          value={search}
          onChange={(event) => setSidebarSearch(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') setSidebarSearch('');
          }}
          placeholder="Search"
          aria-label="Search connections"
          spellCheck={false}
          className="min-w-0 flex-1 bg-transparent text-[13px] text-fg placeholder:text-faint focus:outline-none"
          data-testid="sidebar-search"
        />
        {search !== '' && (
          <button
            type="button"
            aria-label="Clear the search"
            title="Clear the search"
            onClick={() => setSidebarSearch('')}
            className="rounded-sm p-0.5 text-muted hover:bg-hover hover:text-fg"
          >
            <Icon name="close" className="h-3 w-3" />
          </button>
        )}
      </label>
      <FilterMenu />
    </div>
  );
}

const ENGINE_ORDER: readonly EngineId[] = [
  'postgres',
  'mysql',
  'mariadb',
  'mongodb',
  'redis',
  'elasticsearch',
];
const ENVIRONMENT_ORDER: readonly Environment[] = ['dev', 'test', 'staging', 'production'];

function FilterMenu() {
  const filter = useSidebarView((s) => s.filter);
  const active = filterActive(filter);
  const keepOpen = (event: Event): void => event.preventDefault();
  const CHECK =
    'relative flex cursor-default items-center gap-2 rounded-sm py-1 pr-2 pl-7 outline-none data-[highlighted]:bg-list-active';
  const Indicator = () => (
    <DropdownMenu.ItemIndicator className="absolute left-2 text-rust">
      <Icon name="check" className="h-3.5 w-3.5" />
    </DropdownMenu.ItemIndicator>
  );
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          aria-label="Filter connections"
          title="Filter connections"
          aria-pressed={active}
          className="relative flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-sm text-muted hover:bg-hover hover:text-fg aria-pressed:bg-badge aria-pressed:text-rust data-[state=open]:bg-pressed"
          data-testid="sidebar-filter"
        >
          <Icon name="filter" />
          {active && (
            <span
              aria-hidden="true"
              className="absolute top-1 right-1 h-1.5 w-1.5 rounded-full bg-rust"
            />
          )}
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          side="top"
          align="end"
          className="z-50 min-w-56 rounded-md border border-border bg-raised p-1 text-[13px] shadow-widget"
        >
          <DropdownMenu.Label className="px-2 pt-1 pb-0.5 text-[10px] font-semibold tracking-wide text-muted uppercase">
            Engines
          </DropdownMenu.Label>
          {ENGINE_ORDER.map((engine) => (
            <DropdownMenu.CheckboxItem
              key={engine}
              checked={filter.engines.includes(engine)}
              onCheckedChange={() => setSidebarFilter({ engines: toggled(filter.engines, engine) })}
              onSelect={keepOpen}
              className={CHECK}
            >
              <Indicator />
              <EngineIcon engine={engine} />
              {ENGINES[engine].displayName}
            </DropdownMenu.CheckboxItem>
          ))}
          <DropdownMenu.Separator className="my-1 h-px bg-border" />
          <DropdownMenu.Label className="px-2 pt-1 pb-0.5 text-[10px] font-semibold tracking-wide text-muted uppercase">
            Environments
          </DropdownMenu.Label>
          {ENVIRONMENT_ORDER.map((environment) => (
            <DropdownMenu.CheckboxItem
              key={environment}
              checked={filter.environments.includes(environment)}
              onCheckedChange={() =>
                setSidebarFilter({ environments: toggled(filter.environments, environment) })
              }
              onSelect={keepOpen}
              className={CHECK}
            >
              <Indicator />
              <EnvironmentBadge environment={environment} />
            </DropdownMenu.CheckboxItem>
          ))}
          <DropdownMenu.Separator className="my-1 h-px bg-border" />
          <DropdownMenu.CheckboxItem
            checked={filter.connectedOnly}
            onCheckedChange={(checked) => setSidebarFilter({ connectedOnly: checked })}
            onSelect={keepOpen}
            className={CHECK}
          >
            <Indicator />
            <Icon name="plug" className="text-muted" />
            Connected only
          </DropdownMenu.CheckboxItem>
          <DropdownMenu.Separator className="my-1 h-px bg-border" />
          <MenuItem disabled={!active} onSelect={() => clearSidebarFilter()}>
            <IconLabel icon="close">Clear the filter</IconLabel>
          </MenuItem>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

function FolderItem(props: {
  readonly folder: Folder;
  readonly profiles: readonly StoredProfile[];
  readonly search: string;
  /** While searching, a folder that shows is open. */
  readonly forceOpen: boolean;
  readonly onEdit: (mode: ConnectionDialogMode) => void;
  readonly onError: (message: string) => void;
}) {
  const [userOpen, setOpen] = useState(true);
  const open = userOpen || props.forceOpen;
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
              <Highlighted text={props.folder.name} search={props.search} />
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
              search={props.search}
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
  readonly search: string;
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
  const connecting = connection?.status === 'connecting';

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
    <div
      role="treeitem"
      aria-expanded={connected ? expanded : undefined}
      aria-selected={false}
      aria-label={profile.name}
    >
      <Row
        depth={depth}
        // Opens with a double-click (or Enter); the chevron shows once connected.
        expandable={connected}
        expanded={expanded}
        clickToggles={false}
        onToggle={() => {
          if (!connected) return;
          setExpanded(!expanded);
          if (!expanded && !rootNodes) void loadChildren(profile.id, []);
        }}
        onActivate={() => {
          if (connected) {
            setExpanded(!expanded);
            if (!expanded && !rootNodes) void loadChildren(profile.id, []);
          } else if (!connecting) void open();
        }}
        label={
          <span className="flex min-w-0 items-center gap-1.5">
            {profile.presentation.color && (
              <span
                aria-hidden="true"
                className="h-2 w-2 shrink-0 rounded-full"
                style={{ background: profile.presentation.color }}
              />
            )}
            <EngineIcon
              engine={profile.engine}
              className={cx(!connected && 'opacity-60 saturate-50')}
            />
            <span className="truncate" data-testid="profile-name">
              <Highlighted text={profile.name} search={props.search} />
            </span>
            {connecting && (
              <span
                role="status"
                aria-label="Connecting"
                data-testid="profile-connecting"
                className="h-3 w-3 shrink-0 animate-spin rounded-full border-[1.5px] border-rust/25 border-t-rust"
              />
            )}
            {(connection?.status === 'lost' || connection?.status === 'failed') && (
              <span
                aria-hidden="true"
                title={connection.status === 'lost' ? 'Connection lost' : 'Failed to connect'}
                className="h-1.5 w-1.5 shrink-0 rounded-full bg-danger"
              />
            )}
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
                  {profile.engine === 'redis'
                    ? 'Open CLI'
                    : profile.engine === 'elasticsearch'
                      ? 'Open console'
                      : 'New query tab'}
                </MenuItem>
                {isSqlEngine(profile.engine) && (
                  <MenuItem onSelect={() => openRunSqlFile(profile)}>Run SQL file…</MenuItem>
                )}
                {isSqlEngine(profile.engine) && (
                  <MenuItem onSelect={() => openQueryBuilder({ profileId: profile.id })}>
                    New query builder
                  </MenuItem>
                )}
                {isSqlEngine(profile.engine) && (
                  <MenuItem onSelect={() => openErDiagram({ profileId: profile.id })}>
                    ER diagram
                  </MenuItem>
                )}
                {hasServerTools(profile.engine) && (
                  <MenuItem onSelect={() => openServerTools(profile)}>Server tools</MenuItem>
                )}
                {(isSqlEngine(profile.engine) ||
                  profile.engine === 'mongodb' ||
                  profile.engine === 'redis') && (
                  <MenuItem onSelect={() => openTransferFrom(profile)}>Transfer data to…</MenuItem>
                )}
                <BackupMenuItems profile={profile} />
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
      {expanded && connected && profile.engine === 'elasticsearch' && (
        <div role="group">
          <SearchTree profile={profile} depth={depth + 1} onError={props.onError} />
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
              className={
                node.kind === 'database' || node.kind === 'schema' ? 'text-lilac' : 'text-muted'
              }
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
                <MenuItem
                  onSelect={() => openQueryBuilder({ profileId: profile.id, database: node.name })}
                >
                  New query builder
                </MenuItem>
              )}
              {node.kind === 'database' && node.path.length === 1 && (
                <MenuItem
                  onSelect={() => openErDiagram({ profileId: profile.id, database: node.name })}
                >
                  ER diagram
                </MenuItem>
              )}
              {node.kind === 'schema' && dialect === 'postgres' && node.path.length === 2 && (
                <MenuItem
                  onSelect={() =>
                    openQueryBuilder({
                      profileId: profile.id,
                      database: node.path[0],
                      schema: node.name,
                    })
                  }
                >
                  New query builder
                </MenuItem>
              )}
              {node.kind === 'schema' && dialect === 'postgres' && node.path.length === 2 && (
                <MenuItem
                  onSelect={() =>
                    openErDiagram({
                      profileId: profile.id,
                      database: node.path[0],
                      schema: node.name,
                    })
                  }
                >
                  ER diagram
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
              {((node.kind === 'database' && node.path.length === 1) ||
                (node.kind === 'schema' && node.path.length === 2)) && (
                <BackupMenuItems
                  profile={profile}
                  location={{ database: node.path[0], schema: node.path[1] }}
                  restore={node.kind === 'database'}
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
  /** A click on the row toggles it (the default); otherwise only the chevron does. */
  readonly clickToggles?: boolean;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const clickToggles = props.clickToggles ?? true;
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
      className="group flex h-[22px] cursor-default items-center gap-1 pr-1 text-[13px] text-muted hover:bg-list-hover hover:text-fg focus:bg-list-focus focus:text-fg focus:outline focus:outline-1 focus:-outline-offset-1 focus:outline-focus"
      style={{ paddingLeft: 6 + props.depth * 14 }}
      onClick={clickToggles ? props.onToggle : undefined}
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
      <span
        data-tree-chevron
        className="flex w-4 shrink-0 justify-center text-muted"
        onClick={
          !clickToggles && props.expandable
            ? (event) => {
                event.stopPropagation();
                props.onToggle();
              }
            : undefined
        }
        onDoubleClick={
          !clickToggles && props.expandable ? (event) => event.stopPropagation() : undefined
        }
      >
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
              className="rounded-sm p-0.5 text-muted opacity-0 group-hover:opacity-100 group-focus:opacity-100 hover:bg-hover hover:text-fg focus:opacity-100 data-[state=open]:opacity-100"
              onClick={(event) => event.stopPropagation()}
              onDoubleClick={(event) => event.stopPropagation()}
            >
              <Icon name="more" />
            </button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content
              align="start"
              className="z-50 min-w-44 rounded border border-border bg-raised p-1 text-[13px] shadow-widget"
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
  readonly disabled?: boolean;
}) {
  return (
    <DropdownMenu.Item
      onSelect={props.onSelect}
      disabled={props.disabled}
      className={cx(
        'cursor-default rounded px-2 py-1.5 outline-none data-[disabled]:opacity-40 data-[highlighted]:bg-list-active',
        props.danger && 'text-danger',
      )}
    >
      {props.children}
    </DropdownMenu.Item>
  );
}
