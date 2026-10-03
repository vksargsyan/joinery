import { isSqlEngine, newId, type SqlDialect } from '@querybara/core';
import { splitStatements, statementAt } from '@querybara/sql-tools';
import { create } from 'zustand';

import { currentDock } from '../../components/dock';
import { cachedProfile } from '../data';
import { loadSnapshot, metadataCache, useMetadata } from '../metadata';
import { patchPanel, registerPanel, unregisterPanel } from '../panels';
import { createTab, getTab, runtimeOf, useWorkspace } from '../workspace';
import { QueryBuilder, type BuilderTarget } from './builder';
import { builderCatalog, type BuilderCatalog } from './catalog';

/**
 * Query builder panels (spec §8): each is a dock panel with its QueryBuilder, plus a query tab
 * of the same id that the panel never shows as an editor. Run goes through that tab, so the
 * builder's SQL takes the query tabs' path (safety checks, parameters, streaming into the
 * result grid, history, cancel) on a session of the builder's database. Opened from the
 * explorer (a connection, database or schema) or from a SQL tab's statement at the cursor.
 */

interface BuilderPanelsState {
  readonly builders: Readonly<Record<string, QueryBuilder>>;
}

export const useQueryBuilders = create<BuilderPanelsState>()(() => ({ builders: {} }));

const cleanups = new Map<string, () => void>();

/** The catalog of a builder's database, from the metadata cache. */
async function loadCatalog(target: BuilderTarget): Promise<BuilderCatalog> {
  const snapshot = await loadSnapshot(target.profileId, {
    dialect: target.dialect,
    ...(target.database === undefined ? {} : { database: target.database }),
  });
  const facts = metadataCache.facts(target.profileId);
  const connected = target.database === undefined || target.database === facts?.database;
  const schema =
    target.schema ??
    (target.dialect === 'postgres' && connected ? facts?.searchPath?.[0] : undefined);
  return builderCatalog(snapshot, target.dialect, schema);
}

export interface OpenBuilderOptions {
  readonly profileId: string;
  readonly database?: string | undefined;
  readonly schema?: string | undefined;
  /** SQL to open in the builder. */
  readonly sql?: string | undefined;
}

/** Opens a query builder panel for a SQL connection; undefined for other engines. */
export function openQueryBuilder(options: OpenBuilderOptions): string | undefined {
  const profile = cachedProfile(options.profileId);
  if (!profile || !isSqlEngine(profile.engine)) return undefined;
  const dialect: SqlDialect = profile.engine;
  const target: BuilderTarget = {
    profileId: profile.id,
    dialect,
    ...(options.database === undefined ? {} : { database: options.database }),
    ...(options.schema === undefined ? {} : { schema: options.schema }),
  };
  const id = newId();
  const place = options.schema ?? options.database;
  const title =
    place === undefined ? `Query builder (${profile.name})` : `Query builder (${place})`;
  registerPanel({ id, kind: 'query-builder', profileId: profile.id, title });
  createTab({
    id,
    profileId: profile.id,
    title,
    ...(options.database === undefined ? {} : { database: options.database }),
  });
  const builder = new QueryBuilder(target, () => loadCatalog(target));
  // The runner reads the text to run from the tab's editor handle: here, the builder's SQL.
  runtimeOf(id).editor = {
    getText: () => builder.state.sql,
    cursorOffset: () => 0,
    selection: () => undefined,
    setText: (text) => builder.setSql(text),
    focus: () => undefined,
    format: () => undefined,
  };
  useQueryBuilders.setState((state) => ({ builders: { ...state.builders, [id]: builder } }));
  const offMetadata = useMetadata.subscribe((state, previous) => {
    if (state.versions[profile.id] !== previous.versions[profile.id]) void builder.reloadCatalog();
  });
  const offTab = useWorkspace.subscribe((state) => {
    patchPanel(id, { busy: state.tabs[id]?.running === true });
  });
  cleanups.set(id, () => {
    offMetadata();
    offTab();
  });
  void builder.init(options.sql);
  currentDock()?.addPanel({
    id,
    component: 'queryBuilder',
    tabComponent: 'panelTab',
    title,
    params: { panelId: id },
    renderer: 'always',
  });
  return id;
}

/**
 * "Open in query builder" from a SQL tab: the selection, or the statement at the cursor, on the
 * tab's connection and database.
 */
export function openQueryBuilderFromTab(tabId: string): string | undefined {
  const tab = getTab(tabId);
  const editor = runtimeOf(tabId).editor;
  const profile = tab && cachedProfile(tab.profileId);
  if (!tab || !editor || !profile || !isSqlEngine(profile.engine)) return undefined;
  const text = editor.getText();
  const selection = editor.selection();
  const sql = selection
    ? text.slice(selection.start, selection.end)
    : statementAt(splitStatements(text, profile.engine), editor.cursorOffset())?.text;
  return openQueryBuilder({
    profileId: tab.profileId,
    ...(tab.database === undefined ? {} : { database: tab.database }),
    ...(sql === undefined ? {} : { sql }),
  });
}

export function queryBuilder(panelId: string): QueryBuilder | undefined {
  return useQueryBuilders.getState().builders[panelId];
}

/** Frees a closed panel's builder; the dock closes its query tab (and session) itself. */
export function disposeQueryBuilder(panelId: string): void {
  cleanups.get(panelId)?.();
  cleanups.delete(panelId);
  useQueryBuilders.setState((state) => {
    const { [panelId]: _gone, ...builders } = state.builders;
    return { builders };
  });
  unregisterPanel(panelId);
}
