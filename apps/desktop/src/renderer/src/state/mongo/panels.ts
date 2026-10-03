import { newId } from '@querybara/core';
import type { WatchScope } from '@querybara/mongo-tools';

import { panelWithKey, registerPanel } from '../panels';
import { AggregationEditor, type AggregationTarget } from './aggregation';
import { ChangeStreamViewer } from './change-stream';
import { CollectionOptions, type CollectionOptionsTarget } from './collection-options';
import { CollectionView, type CollectionTarget } from './collection-view';
import { MongoConsole, type ConsoleTarget } from './console';
import { GridFsBrowser, type GridFsTarget } from './gridfs';
import { IndexManager, type IndexManagerTarget } from './indexes';
import type { QueryFields } from './query-bar';
import { SchemaPanelState, type SchemaTarget } from './schema';
import { SqlQuery, type SqlQueryTarget } from './sql-query';
import { UsersRoles, type UsersRolesTarget } from './users';

/**
 * The MongoDB module's dock panels: collection views, command consoles, SQL tabs and the tool
 * panels (aggregation editor, index manager, schema analysis, collection options, change streams,
 * GridFS, users and roles). The dock renders them all through one `mongo` panel component; this
 * registry holds each panel's state object and disposes it (closing its session) when the
 * panel closes.
 */

export type MongoPanel =
  | CollectionView
  | MongoConsole
  | SqlQuery
  | AggregationEditor
  | IndexManager
  | SchemaPanelState
  | CollectionOptions
  | ChangeStreamViewer
  | GridFsBrowser
  | UsersRoles;

const panels = new Map<string, MongoPanel>();

export function getMongoPanel(id: string): MongoPanel | undefined {
  return panels.get(id);
}

/** The key of a collection's view (see `PanelInfo.key`): opening it again focuses it. */
export function collectionKey(target: CollectionTarget): string {
  return ['mongo', target.profileId, target.db, target.collection].join('\u0000');
}

/**
 * Creates the state of a collection view and registers its panel, its query bar starting from
 * `fields`; returns the panel id, or the open view's id when the collection is already open
 * (`opened: false`).
 */
export function createCollectionPanel(
  target: CollectionTarget,
  fields?: QueryFields,
): {
  readonly id: string;
  readonly opened: boolean;
} {
  const key = collectionKey(target);
  const open = panelWithKey(key);
  if (open) return { id: open.id, opened: false };
  const id = newId();
  registerPanel({ id, kind: 'mongo', profileId: target.profileId, title: target.collection, key });
  const view = new CollectionView(id, target, fields);
  panels.set(id, view);
  void view.init();
  return { id, opened: true };
}

/** Creates a console's state and registers its panel. */
export function createConsolePanel(target: ConsoleTarget, title: string): string {
  const id = newId();
  registerPanel({ id, kind: 'mongo', profileId: target.profileId, title });
  const console = new MongoConsole(id, target);
  panels.set(id, console);
  void console.init();
  return id;
}

/** Creates a SQL tab's state and registers its panel. */
export function createSqlPanel(target: SqlQueryTarget, title: string): string {
  const id = newId();
  registerPanel({ id, kind: 'mongo', profileId: target.profileId, title });
  const query = new SqlQuery(id, target);
  panels.set(id, query);
  void query.init();
  return id;
}

/** The tool panels, each opened once per object (opening it again focuses it). */
export type ToolPanelRequest =
  | { readonly tool: 'aggregation'; readonly target: AggregationTarget }
  | { readonly tool: 'indexes'; readonly target: IndexManagerTarget }
  | { readonly tool: 'schema'; readonly target: SchemaTarget }
  | { readonly tool: 'options'; readonly target: CollectionOptionsTarget }
  | {
      readonly tool: 'changes';
      readonly target: { readonly profileId: string; readonly scope: WatchScope };
    }
  | { readonly tool: 'gridfs'; readonly target: GridFsTarget }
  | { readonly tool: 'users'; readonly target: UsersRolesTarget };

function scopeKey(scope: WatchScope): string[] {
  return scope.kind === 'cluster'
    ? []
    : scope.kind === 'database'
      ? [scope.db]
      : [scope.ns.db, scope.ns.collection];
}

/** What a tool panel shows, so opening the same thing again focuses it. */
export function toolKey(request: ToolPanelRequest): string {
  const { tool, target } = request;
  const parts =
    tool === 'changes'
      ? scopeKey(request.target.scope)
      : tool === 'gridfs'
        ? [request.target.db, request.target.bucket]
        : tool === 'users'
          ? [request.target.db]
          : [request.target.db, request.target.collection];
  return ['mongo', tool, target.profileId, ...parts].join('\u0000');
}

/** The tab title of a tool panel. */
export function toolTitle(request: ToolPanelRequest): string {
  switch (request.tool) {
    case 'aggregation':
      return `${request.target.collection} pipeline`;
    case 'indexes':
      return `${request.target.collection} indexes`;
    case 'schema':
      return `${request.target.collection} schema`;
    case 'options':
      return `${request.target.collection} options`;
    case 'changes': {
      const scope = request.target.scope;
      return `Changes: ${scope.kind === 'cluster' ? 'deployment' : scope.kind === 'database' ? scope.db : scope.ns.collection}`;
    }
    case 'gridfs':
      return `${request.target.bucket} files`;
    case 'users':
      return `${request.target.db} users and roles`;
  }
}

function createTool(id: string, request: ToolPanelRequest): MongoPanel {
  switch (request.tool) {
    case 'aggregation':
      return new AggregationEditor(id, request.target);
    case 'indexes':
      return new IndexManager(id, request.target);
    case 'schema':
      return new SchemaPanelState(id, request.target);
    case 'options':
      return new CollectionOptions(id, request.target);
    case 'changes':
      return new ChangeStreamViewer(id, request.target);
    case 'gridfs':
      return new GridFsBrowser(id, request.target);
    case 'users':
      return new UsersRoles(id, request.target);
  }
}

/**
 * Creates a tool panel's state and registers it; returns its id, or the open panel's id when
 * the same tool is already open on the object (`opened: false`).
 */
export function createToolPanel(request: ToolPanelRequest): {
  readonly id: string;
  readonly opened: boolean;
  readonly title: string;
} {
  const key = toolKey(request);
  const title = toolTitle(request);
  const open = panelWithKey(key);
  if (open) return { id: open.id, opened: false, title };
  const id = newId();
  registerPanel({ id, kind: 'mongo', profileId: request.target.profileId, title, key });
  const panel = createTool(id, request);
  panels.set(id, panel);
  void panel.init();
  return { id, opened: true, title };
}

/** Closes a panel's session (the panel closed). */
export function disposeMongoPanel(id: string): void {
  const panel = panels.get(id);
  panels.delete(id);
  void panel?.dispose();
}
