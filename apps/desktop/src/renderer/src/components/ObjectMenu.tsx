import type { BrowseNode, SqlDialect } from '@joinery/core';
import type { StoredProfile } from '@joinery/ipc';
import { DropdownMenu } from 'radix-ui';
import { create } from 'zustand';

import type { DesignerTarget } from '../state/designer';
import { openErDiagram } from '../state/er-diagram/panels';
import {
  isDesignableTable,
  newTableLocation,
  opensData,
  selectStatementFor,
  tableLocation,
  tablesFolderPath,
} from '../state/explorer';
import { refreshObjects } from '../state/metadata';
import { openQueryBuilder } from '../state/query-builder/panels';
import { openServerTools } from '../state/server-tools/panels';
import { openDataCompare, openStructureCompare } from '../state/sync/panels';
import { openTransferFrom } from '../state/transfer-db/api';
import { openExportTables, openImportWizard, openRunSqlFile } from '../state/transfer-dialogs';
import { BackupMenuItems } from './backup/BackupDialogs';
import { DropTableDialog } from './designer/ReviewDialogs';
import { useWorkspace } from '../state/workspace';
import { currentDock, openQueryTab, openTableData, openTableDesigner } from './dock';
import { MenuItem } from './MenuItem';

/**
 * What a SQL object offers, in the explorer tree and in the Objects view alike: opening its rows,
 * the table designer, import, export, maintenance, transfer, query builder, ER diagram, compare,
 * backup, refresh and drop. The object's node (a path from the explorer) says what applies.
 */

/** The table the "Drop table…" review is open for. */
export const useDropRequest = create<{
  readonly target?: DesignerTarget & { readonly name: string };
}>()(() => ({}));

export function DropTableHost() {
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

/** The query tab each view's rows opened in, so opening them again brings it back. */
const viewTabs = new Map<string, string>();

/**
 * Opens a table's data view, or a view's rows in a query tab; nothing for other objects. Either
 * way an open one is brought forward rather than opened twice.
 */
export function openObjectData(
  profile: StoredProfile,
  node: BrowseNode,
  dialect: SqlDialect,
): void {
  const table = isDesignableTable(node, dialect) ? tableLocation(node, dialect) : undefined;
  if (table) {
    openTableData({ profileId: profile.id, ...table });
    return;
  }
  if (!opensData(node)) return;
  const key = JSON.stringify([profile.id, ...node.path]);
  const open = viewTabs.get(key);
  if (open !== undefined && useWorkspace.getState().tabs[open]) {
    currentDock()?.getPanel(open)?.api.setActive();
    return;
  }
  viewTabs.set(
    key,
    openQueryTab({
      profileId: profile.id,
      title: node.name,
      text: selectStatementFor(node, dialect),
      run: true,
    }),
  );
}

/** The designer for a table, or for a new table where the node allows one. */
export function designerTarget(
  profile: StoredProfile,
  node: BrowseNode,
  dialect: SqlDialect,
  name: string | null,
): DesignerTarget | undefined {
  const location =
    (isDesignableTable(node, dialect) ? tableLocation(node, dialect) : undefined) ??
    newTableLocation(node, dialect);
  return (
    location && {
      profileId: profile.id,
      database: location.database,
      schema: location.schema,
      name,
      tablesPath: tablesFolderPath({ ...location, name: '' }, dialect),
    }
  );
}

/** Asks to drop a table (the review dialog shows the statement first). */
export function requestDropTable(
  profile: StoredProfile,
  node: BrowseNode,
  dialect: SqlDialect,
): void {
  const target = designerTarget(profile, node, dialect, node.name);
  if (target && isDesignableTable(node, dialect)) {
    useDropRequest.setState({ target: { ...target, name: node.name } });
  }
}

/** Whether the node has a menu at all. */
export function hasObjectMenu(node: BrowseNode, dialect: SqlDialect): boolean {
  return opensData(node) || node.hasChildren || newTableLocation(node, dialect) !== undefined;
}

export function ObjectMenuItems(props: {
  readonly node: BrowseNode;
  readonly profile: StoredProfile;
  readonly dialect: SqlDialect;
}) {
  const { node, profile, dialect } = props;
  const table = isDesignableTable(node, dialect) ? tableLocation(node, dialect) : undefined;
  const newTable = newTableLocation(node, dialect);
  const openData = (): void => openObjectData(profile, node, dialect);
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
    <>
      {table ? (
        <>
          <MenuItem icon="table" onSelect={openData}>
            Open data
          </MenuItem>
          <MenuItem icon="design" onSelect={() => openTableDesigner(designTarget(table.name)!)}>
            Design table
          </MenuItem>
          <MenuItem icon="import" onSelect={() => openImportWizard(profile, table, table.name)}>
            Import data…
          </MenuItem>
          <MenuItem
            icon="export"
            onSelect={() =>
              openExportTables(profile, table, [table.name], tablesFolderPath(table, dialect))
            }
          >
            Export…
          </MenuItem>
          <MenuItem
            icon="wrench"
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
            icon="transfer"
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
        opensData(node) && (
          <MenuItem icon="table" onSelect={openData}>
            Open rows
          </MenuItem>
        )
      )}
      {newTable && (
        <>
          <MenuItem
            icon="table-new"
            onSelect={() => openTableDesigner(designTarget(null, newTable)!)}
          >
            New table…
          </MenuItem>
          <MenuItem icon="import" onSelect={() => openImportWizard(profile, newTable, null)}>
            Import into new table…
          </MenuItem>
          <MenuItem
            icon="export"
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
            icon="transfer"
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
        <MenuItem icon="file-run" onSelect={() => openRunSqlFile(profile, node.name)}>
          Run SQL file…
        </MenuItem>
      )}
      {node.kind === 'database' && node.path.length === 1 && (
        <MenuItem
          icon="builder"
          onSelect={() => openQueryBuilder({ profileId: profile.id, database: node.name })}
        >
          New query builder
        </MenuItem>
      )}
      {node.kind === 'database' && node.path.length === 1 && (
        <MenuItem
          icon="diagram"
          onSelect={() => openErDiagram({ profileId: profile.id, database: node.name })}
        >
          ER diagram
        </MenuItem>
      )}
      {node.kind === 'schema' && dialect === 'postgres' && node.path.length === 2 && (
        <MenuItem
          icon="builder"
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
          icon="diagram"
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
        <MenuItem icon="refresh" onSelect={() => refreshObjects(profile.id, node.path)}>
          Refresh
        </MenuItem>
      )}
      {table && (
        <>
          <DropdownMenu.Separator className="my-1 h-px bg-border" />
          <MenuItem
            icon="trash"
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
  );
}

/** "Compare structure with…" and "Compare data with…" (spec §13), from this source. */
export function CompareItems(props: {
  readonly source: {
    readonly profileId: string;
    readonly database: string;
    readonly schemas?: string;
  };
}) {
  return (
    <>
      <DropdownMenu.Separator className="my-1 h-px bg-border" />
      <MenuItem icon="compare" onSelect={() => openStructureCompare({ source: props.source })}>
        Compare structure with…
      </MenuItem>
      <MenuItem icon="compare-rows" onSelect={() => openDataCompare({ source: props.source })}>
        Compare data with…
      </MenuItem>
    </>
  );
}
