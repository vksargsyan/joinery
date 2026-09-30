import { isSqlEngine, type BrowseNode, type EngineId } from '@joinery/core';
import type { StoredProfile } from '@joinery/ipc';
import { DropdownMenu } from 'radix-ui';
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from 'react';

import { errorMessage } from '../lib/errors';
import { connect, useConnections } from '../state/connections';
import { useProfiles } from '../state/data';
import {
  isDesignableTable,
  loadChildren,
  newTableLocation,
  opensData,
  pathKey,
  tableLocation,
  tablesFolderPath,
  useExplorer,
} from '../state/explorer';
import {
  columnsFor,
  countLabel,
  formatCell,
  objectsPathFor,
  sortObjects,
  totalSize,
  type ObjectColumn,
  type ObjectSort,
} from '../state/objects-model';
import { showObjects, useObjectsView } from '../state/objects-view';
import { formatBytes } from '../state/redis/value-model';
import { openCreateCollection } from '../state/mongo/create-dialogs';
import { openExportTables, openImportWizard } from '../state/transfer-dialogs';
import { EngineIcon } from './EngineIcon';
import { Highlighted } from './Highlighted';
import { ObjectMenuItems, designerTarget, openObjectData, requestDropTable } from './ObjectMenu';
import { openTableDesigner } from './dock';
import { MongoNodeMenu, iconFor, mongoNodeOpener, opensDocuments } from './mongo/MongoTree';
import { Button, Icon, cx, type IconName } from './ui';

/**
 * The Objects tab (state/objects-view.ts): what the chosen explorer node holds, one row per
 * object with its statistics, for SQL engines and MongoDB. A click selects (Cmd/Ctrl adds, Shift
 * extends); a double-click or Enter opens a table's data, a view's rows or a collection's
 * documents, or goes into a schema or a database. The toolbar and the right-click menu offer
 * what the tree's menu does; the search narrows by name.
 */

const WIDTHS: Readonly<Record<ObjectColumn['format'], string>> = {
  count: '104px',
  bytes: '96px',
  time: '168px',
  flag: '96px',
  text: '140px',
};

function kindIcon(node: BrowseNode): { name: IconName; className: string } {
  if (node.kind === 'database' || node.kind === 'schema') {
    return { name: 'database', className: 'text-lilac' };
  }
  if (node.kind === 'folder') return { name: 'folder', className: 'text-muted' };
  if (node.kind === 'function' || node.kind === 'procedure') {
    return { name: 'file-run', className: 'text-muted' };
  }
  return { name: 'table', className: 'text-muted' };
}

export function ObjectsPanel() {
  const location = useObjectsView((state) => state.location);
  const profiles = useProfiles();
  const profile = profiles.data?.find((candidate) => candidate.id === location?.profileId);
  if (!location || !profile || !(isSqlEngine(profile.engine) || profile.engine === 'mongodb')) {
    return (
      <Centered>
        <Icon name="table" className="h-6 w-6 text-faint" />
        <p className="mt-2 text-[13px] text-fg">No objects to show</p>
        <p className="mt-1 text-xs text-muted">
          Click a database, a schema or a folder in the side bar to list what it holds.
        </p>
      </Centered>
    );
  }
  return (
    <ObjectsList
      key={`${profile.id}\u0000${pathKey(location.path)}`}
      profile={profile}
      engine={profile.engine}
      path={location.path}
      trail={location.trail}
    />
  );
}

function Centered(props: { readonly children: ReactNode }) {
  return (
    <div className="flex h-full flex-col items-center justify-center bg-bg px-6 text-center">
      {props.children}
    </div>
  );
}

function ObjectsList(props: {
  readonly profile: StoredProfile;
  readonly engine: EngineId;
  readonly path: readonly string[];
  readonly trail: readonly string[];
}) {
  const { profile, engine, path } = props;
  const mongo = engine === 'mongodb';
  // SQL helpers take the dialect; MongoDB has its own menu and actions.
  const dialect = isSqlEngine(engine) ? engine : 'postgres';
  const status = useConnections((state) => state.byProfile[profile.id]?.status);
  const state = useExplorer((s) => s.children[profile.id]?.[pathKey(path)]);
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<ObjectSort>({ key: 'name', descending: false });
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [anchor, setAnchor] = useState<string>();
  const [cursor, setCursor] = useState<string>();
  const [menu, setMenu] = useState<{ x: number; y: number; node: BrowseNode }>();
  const [connectError, setConnectError] = useState<string>();
  const [actionError, setActionError] = useState<string>();
  const grid = useRef<HTMLDivElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const connected = status === 'ready';

  // Loads the list when the view opens on a connected server (the tree may not have yet).
  useEffect(() => {
    if (connected && !state) void loadChildren(profile.id, path);
  }, [connected, state, profile.id, path]);

  const nodes = useMemo(() => state?.nodes ?? [], [state?.nodes]);
  const needle = search.trim().toLowerCase();
  const shown = useMemo(
    () =>
      sortObjects(
        needle === '' ? nodes : nodes.filter((node) => node.name.toLowerCase().includes(needle)),
        sort,
      ),
    [nodes, needle, sort],
  );
  const columns = useMemo(() => columnsFor(nodes), [nodes]);
  // Name and statistics keep their width; the comment (or an empty filler) takes the rest.
  const hasComment = columns.some((column) => column.key === 'comment');
  const template = [
    'minmax(220px, 360px)',
    ...columns.map((column) =>
      column.key === 'comment' ? 'minmax(200px, 1fr)' : WIDTHS[column.format],
    ),
    ...(hasComment ? [] : ['1fr']),
  ].join(' ');

  const key = (node: BrowseNode): string => pathKey(node.path);
  const picked = shown.filter((node) => selected.has(key(node)));
  const single = picked.length === 1 ? picked[0] : undefined;
  const container: BrowseNode = {
    kind: path.length === 1 ? 'database' : 'folder',
    name: props.trail.at(-1) ?? '',
    path,
    hasChildren: true,
  };
  const newTable = mongo ? undefined : newTableLocation(container, dialect);
  const tables = mongo ? [] : picked.filter((node) => isDesignableTable(node, dialect));
  const designable = !mongo && single !== undefined && isDesignableTable(single, dialect);
  const openable = (node: BrowseNode): boolean => (mongo ? opensDocuments(node) : opensData(node));
  // A MongoDB database's collections folder takes a new collection.
  const mongoDb = mongo && path[1] === 'collections' ? path[0] : undefined;

  const select = (
    node: BrowseNode,
    event?: { shiftKey: boolean; metaKey: boolean; ctrlKey: boolean },
  ): void => {
    const id = key(node);
    setCursor(id);
    if (event?.shiftKey && anchor !== undefined) {
      const from = shown.findIndex((candidate) => key(candidate) === anchor);
      const to = shown.indexOf(node);
      const [start, end] = from < to ? [from, to] : [to, from];
      setSelected(new Set(shown.slice(Math.max(start, 0), end + 1).map(key)));
      return;
    }
    setAnchor(id);
    if (event?.metaKey || event?.ctrlKey) {
      const next = new Set(selected);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      setSelected(next);
      return;
    }
    setSelected(new Set([id]));
  };

  /** Opens an object's rows or documents, or goes into a container (a schema's tables). */
  const open = (node: BrowseNode): void => {
    if (objectsPathFor(node, engine) !== undefined) {
      showObjects(profile.id, node, engine);
      return;
    }
    if (mongo) mongoNodeOpener(profile, node)?.();
    else openObjectData(profile, node, dialect);
  };

  /** Opens the object's menu at a point on screen (the panel is its own containing block). */
  const openMenu = (node: BrowseNode, x: number, y: number): void => {
    if (!selected.has(key(node))) select(node);
    const box = root.current?.getBoundingClientRect();
    setMenu({ x: x - (box?.left ?? 0), y: y - (box?.top ?? 0), node });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (shown.length === 0) return;
    const index = shown.findIndex((node) => key(node) === cursor);
    const move = (to: number): void => {
      const node = shown[Math.max(0, Math.min(shown.length - 1, to))]!;
      select(node, { shiftKey: event.shiftKey, metaKey: false, ctrlKey: false });
      grid.current
        ?.querySelector(`[data-row="${CSS.escape(key(node))}"]`)
        ?.scrollIntoView({ block: 'nearest' });
    };
    switch (event.key) {
      case 'ArrowDown':
        move(index + 1);
        break;
      case 'ArrowUp':
        move(index < 0 ? 0 : index - 1);
        break;
      case 'Home':
        move(0);
        break;
      case 'End':
        move(shown.length - 1);
        break;
      case 'Enter': {
        const node = shown[index];
        if (node) open(node);
        break;
      }
      case 'Escape':
        setSelected(new Set());
        break;
      case 'a':
        if (!event.metaKey && !event.ctrlKey) return;
        setSelected(new Set(shown.map(key)));
        break;
      case 'ContextMenu':
      case 'F10': {
        if (event.key === 'F10' && !event.shiftKey) return;
        const node = shown[index];
        const row = node
          ? grid.current?.querySelector(`[data-row="${CSS.escape(key(node))}"]`)
          : undefined;
        if (node && row) {
          const box = row.getBoundingClientRect();
          openMenu(node, box.left + 24, box.bottom);
        }
        break;
      }
      default:
        return;
    }
    event.preventDefault();
  };

  const toggleSort = (column: string): void =>
    setSort((current) =>
      current.key === column
        ? { key: column, descending: !current.descending }
        : { key: column, descending: false },
    );

  const size = totalSize(shown);
  const tool = (icon: IconName, label: string, onClick: () => void, disabled = false) => (
    <Button
      variant="quiet"
      size="sm"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="w-[26px] px-0"
    >
      <Icon name={icon} />
    </Button>
  );

  return (
    <div
      ref={root}
      className="relative flex h-full min-h-0 flex-col bg-bg"
      data-testid="objects-panel"
    >
      <div className="flex h-[35px] shrink-0 items-center gap-1 border-b border-border px-2">
        <nav aria-label="Location" className="flex min-w-0 items-center gap-1 pr-2 text-xs">
          <EngineIcon engine={profile.engine} className="h-3.5 w-3.5" />
          <span className="truncate text-muted">{profile.name}</span>
          {props.trail.map((segment, index) => (
            <span key={`${index}-${segment}`} className="flex min-w-0 items-center gap-1">
              <Icon name="chevron-right" className="h-3 w-3 text-faint" />
              <span
                className={cx(
                  'truncate',
                  index === props.trail.length - 1 ? 'font-medium text-fg' : 'text-muted',
                )}
              >
                {segment}
              </span>
            </span>
          ))}
        </nav>
        <span aria-hidden="true" className="mx-1 h-4 w-px bg-border" />
        <div role="toolbar" aria-label="Object actions" className="flex items-center gap-0.5">
          {tool(
            'table',
            'Open',
            () => picked.filter(openable).forEach((node) => open(node)),
            !picked.some(openable),
          )}
          {mongo ? (
            <>
              {tool(
                'table-new',
                'New collection',
                () => mongoDb !== undefined && openCreateCollection(profile.id, mongoDb),
                mongoDb === undefined || profile.presentation.readOnly,
              )}
              <span aria-hidden="true" className="mx-1 h-4 w-px bg-border" />
            </>
          ) : (
            <>
              {tool(
                'design',
                'Design table',
                () => {
                  const target = single && designerTarget(profile, single, dialect, single.name);
                  if (target) openTableDesigner(target);
                },
                !designable,
              )}
              {tool(
                'table-new',
                'New table',
                () => {
                  const target = designerTarget(profile, container, dialect, null);
                  if (target) openTableDesigner(target);
                },
                !newTable,
              )}
              {tool(
                'trash',
                'Drop table',
                () => single && requestDropTable(profile, single, dialect),
                !designable,
              )}
              <span aria-hidden="true" className="mx-1 h-4 w-px bg-border" />
              {tool(
                'import',
                'Import data',
                () => {
                  const table = single && tableLocation(single, dialect);
                  if (single && table && isDesignableTable(single, dialect)) {
                    openImportWizard(profile, table, table.name);
                  } else if (newTable) openImportWizard(profile, newTable, null);
                },
                !newTable && !(single && isDesignableTable(single, dialect)),
              )}
              {tool(
                'export',
                'Export tables',
                () => {
                  const location = newTable ?? (tables[0] && tableLocation(tables[0], dialect));
                  if (!location) return;
                  openExportTables(
                    profile,
                    location,
                    tables.map((node) => node.name),
                    tablesFolderPath({ ...location, name: '' }, dialect),
                  );
                },
                !newTable && tables.length === 0,
              )}
              <span aria-hidden="true" className="mx-1 h-4 w-px bg-border" />
            </>
          )}
          {tool('refresh', 'Refresh', () => void loadChildren(profile.id, path), !connected)}
        </div>
        <span className="flex-1" />
        <label className="flex h-[24px] w-56 items-center gap-1.5 rounded-sm border border-border bg-deep px-1.5 focus-within:border-focus">
          <Icon name="search" className="h-3.5 w-3.5 text-faint" />
          <input
            type="text"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') setSearch('');
              if (event.key === 'ArrowDown') {
                event.preventDefault();
                grid.current?.focus();
                if (shown[0]) select(shown[0]);
              }
            }}
            placeholder="Search"
            aria-label="Search objects"
            spellCheck={false}
            className="min-w-0 flex-1 bg-transparent text-xs text-fg outline-none! placeholder:text-faint"
          />
        </label>
      </div>

      {!connected ? (
        <Centered>
          <p className="text-[13px] text-fg">
            {status === 'connecting'
              ? `Connecting to ${profile.name}…`
              : `${profile.name} is not connected`}
          </p>
          {status !== 'connecting' && (
            <Button
              className="mt-3"
              variant="primary"
              onClick={() => {
                setConnectError(undefined);
                connect(profile.id).catch((error: unknown) => {
                  const message = errorMessage(error);
                  if (message !== 'Cancelled') setConnectError(message);
                });
              }}
            >
              Connect
            </Button>
          )}
          {connectError && <p className="mt-2 text-xs text-danger">{connectError}</p>}
        </Centered>
      ) : state?.error && !state.nodes ? (
        <Centered>
          <p role="alert" className="text-[13px] text-danger">
            {state.error}
          </p>
          <Button className="mt-3" onClick={() => void loadChildren(profile.id, path)}>
            Try again
          </Button>
        </Centered>
      ) : (
        <div
          ref={grid}
          role="grid"
          aria-label="Objects"
          aria-multiselectable="true"
          aria-rowcount={shown.length + 1}
          aria-busy={state?.loading === true}
          tabIndex={0}
          onKeyDown={onKeyDown}
          onFocus={() => {
            if (cursor === undefined && shown[0]) setCursor(key(shown[0]));
          }}
          className="min-h-0 flex-1 overflow-auto outline-none"
        >
          <div className="min-w-max">
            <div
              role="row"
              className="sticky top-0 z-10 grid h-[24px] border-b border-border bg-panel text-[11px] font-medium text-muted"
              style={{ gridTemplateColumns: template }}
            >
              {[{ key: 'name', label: 'Name', format: 'text' as const }, ...columns].map(
                (column) => {
                  const active = sort.key === column.key;
                  const numeric = column.format === 'count' || column.format === 'bytes';
                  return (
                    <div
                      key={column.key}
                      role="columnheader"
                      aria-sort={active ? (sort.descending ? 'descending' : 'ascending') : 'none'}
                      className="border-r border-border/60 last:border-r-0"
                    >
                      <button
                        type="button"
                        tabIndex={-1}
                        onClick={() => toggleSort(column.key)}
                        className={cx(
                          'flex h-full w-full items-center gap-1 px-2 hover:bg-hover hover:text-fg',
                          numeric && 'justify-end',
                          active && 'text-fg',
                        )}
                      >
                        <span className="truncate">{column.label}</span>
                        {active && (
                          <Icon
                            name="chevron-down"
                            className={cx('h-3 w-3 shrink-0', !sort.descending && 'rotate-180')}
                          />
                        )}
                      </button>
                    </div>
                  );
                },
              )}
            </div>
            {state?.loading && !state.nodes
              ? Array.from({ length: 8 }, (_, index) => (
                  <div
                    key={index}
                    className="flex h-[24px] items-center gap-3 px-2"
                    aria-hidden="true"
                  >
                    <span className="h-3 w-3 rounded-sm bg-hover" />
                    <span
                      className="h-2.5 animate-pulse rounded-sm bg-hover"
                      style={{ width: `${120 + ((index * 53) % 140)}px` }}
                    />
                  </div>
                ))
              : shown.map((node) => {
                  const id = key(node);
                  const isSelected = selected.has(id);
                  const icon = kindIcon(node);
                  const glyph = mongo ? (
                    iconFor(node)
                  ) : (
                    <Icon name={icon.name} className={icon.className} />
                  );
                  return (
                    <div
                      key={id}
                      role="row"
                      data-row={id}
                      aria-selected={isSelected}
                      onMouseDown={(event: MouseEvent) => {
                        if (event.button === 0) select(node, event);
                      }}
                      onDoubleClick={() => open(node)}
                      onContextMenu={(event) => {
                        event.preventDefault();
                        openMenu(node, event.clientX, event.clientY);
                      }}
                      className={cx(
                        'grid h-[24px] cursor-default items-center text-[13px] [content-visibility:auto]',
                        isSelected
                          ? 'bg-list-active text-fg'
                          : 'text-muted hover:bg-list-hover hover:text-fg',
                        id === cursor && 'outline outline-1 -outline-offset-1 outline-focus',
                      )}
                      style={{ gridTemplateColumns: template }}
                    >
                      <div role="gridcell" className="flex min-w-0 items-center gap-1.5 px-2">
                        {glyph}
                        <span className="truncate text-fg">
                          <Highlighted text={node.name} search={search} />
                        </span>
                      </div>
                      {columns.map((column) => {
                        const text = formatCell(node.detail?.[column.key], column.format);
                        const numeric = column.format === 'count' || column.format === 'bytes';
                        return (
                          <div
                            key={column.key}
                            role="gridcell"
                            title={column.key === 'comment' && text !== '' ? text : undefined}
                            className={cx(
                              'truncate px-2 tabular-nums',
                              numeric && 'text-right',
                              column.key === 'comment' && 'text-faint',
                            )}
                          >
                            {text}
                          </div>
                        );
                      })}
                    </div>
                  );
                })}
            {state?.nodes && shown.length === 0 && (
              <p className="px-3 py-6 text-center text-xs text-muted">
                {needle === '' ? 'Nothing here yet.' : `No object matches “${search.trim()}”.`}
              </p>
            )}
          </div>
        </div>
      )}

      <div
        role="status"
        data-testid="objects-status"
        className="flex h-[22px] shrink-0 items-center gap-2 border-t border-border bg-panel px-3 text-[11px] text-muted"
      >
        {state?.nodes && (
          <>
            <span>
              {needle === ''
                ? countLabel(nodes)
                : `${shown.length.toLocaleString()} of ${countLabel(nodes)}`}
            </span>
            {picked.length > 0 && <span>· {picked.length.toLocaleString()} selected</span>}
            {size !== undefined && <span>· {formatBytes(size)}</span>}
          </>
        )}
        {actionError && (
          <span role="alert" className="truncate text-danger">
            {actionError}
          </span>
        )}
        {state?.loading && state.nodes && <span className="ml-auto">Refreshing…</span>}
      </div>

      {menu && (
        <DropdownMenu.Root open onOpenChange={(open) => !open && setMenu(undefined)}>
          <DropdownMenu.Trigger asChild>
            <span
              aria-hidden="true"
              className="pointer-events-none absolute h-0 w-0"
              style={{ left: menu.x, top: menu.y }}
            />
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content
              align="start"
              className="z-50 min-w-44 rounded border border-border bg-raised p-1 text-[13px] shadow-widget"
              onKeyDown={(event) => event.stopPropagation()}
              onCloseAutoFocus={(event) => {
                event.preventDefault();
                grid.current?.focus();
              }}
            >
              {mongo ? (
                <MongoNodeMenu node={menu.node} profile={profile} onError={setActionError} />
              ) : (
                <ObjectMenuItems node={menu.node} profile={profile} dialect={dialect} />
              )}
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      )}
    </div>
  );
}
