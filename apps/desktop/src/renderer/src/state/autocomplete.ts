import { isSqlEngine, type SqlDialect } from '@joinery/core';
import type { AppSettings, Snippet } from '@joinery/ipc';
import type { SqlSnippet } from '@joinery/sql-tools';

import { mainApi } from '../lib/main-client';
import type { CatalogContext, KeywordCaseSetting } from '../workers/language-service';
import { cachedProfile, keys, queryClient } from './data';
import { metadataCache } from './metadata';
import type { PlannedStatement } from './run-plan';
import { qualifierBefore, tabFacts, type TabSessionState } from './session-facts';
import { getTab, runtimeOf } from './workspace';

/**
 * What autocomplete needs beyond the metadata (spec §6): each query tab's session context (its
 * connection's facts, plus the USE and SET search_path it ran), the hooks the query runner calls
 * so DDL refreshes the metadata, the snippet library and the keyword case setting.
 */

/** A query tab's own USE / SET search_path, valid while its session lives. */
const tabSessions = new Map<string, TabSessionState & { readonly sessionId: string }>();

function tabSession(tabId: string): TabSessionState | undefined {
  const entry = tabSessions.get(tabId);
  if (!entry) return undefined;
  if (runtimeOf(tabId).sessionId !== entry.sessionId || !getTab(tabId)) {
    tabSessions.delete(tabId);
    return undefined;
  }
  return entry;
}

/**
 * Called by the runner after a run: DDL refreshes the metadata it changed (or waits for COMMIT
 * inside a PostgreSQL transaction), and USE / SET search_path move the tab's completion context.
 */
export function noteStatementsRun(tabId: string, statements: readonly PlannedStatement[]): void {
  const tab = getTab(tabId);
  if (!tab || statements.length === 0) return;
  const facts = tabFacts(metadataCache.facts(tab.profileId), tabSession(tabId));
  const effects = metadataCache.afterRun(tab.profileId, {
    tabId,
    statements,
    database: facts.database,
    inTransaction: tab.inTransaction,
  });
  const sessionId = runtimeOf(tabId).sessionId;
  if (effects?.session && sessionId !== undefined) {
    tabSessions.set(tabId, { ...tabSession(tabId), ...effects.session, sessionId });
  }
}

/** Called by the runner when a tab commits or rolls back. */
export function noteTransactionEnd(tabId: string, committed: boolean): void {
  const tab = getTab(tabId);
  if (tab) metadataCache.afterTransaction(tab.profileId, tabId, committed);
}

/** What a tab's completion requests carry: its connection and session context. */
export interface CompletionTarget {
  readonly profileId: string;
  readonly dialect: SqlDialect;
  readonly context: CatalogContext;
}

export function completionTarget(tabId: string): CompletionTarget | undefined {
  const tab = getTab(tabId);
  const engine = tab ? cachedProfile(tab.profileId)?.engine : undefined;
  if (!tab || engine === undefined || !isSqlEngine(engine)) return undefined;
  const facts = tabFacts(metadataCache.facts(tab.profileId), tabSession(tabId));
  return {
    profileId: tab.profileId,
    dialect: engine,
    context: {
      dialect: engine,
      ...(facts.database === undefined ? {} : { currentDatabase: facts.database }),
      ...(facts.searchPath === undefined ? {} : { searchPath: facts.searchPath }),
      ...(facts.user === undefined ? {} : { user: facts.user }),
      ...(facts.lowerCaseTableNames === undefined
        ? {}
        : { lowerCaseTableNames: facts.lowerCaseTableNames }),
    },
  };
}

/**
 * MySQL/MariaDB: when the word before the cursor qualifies a name with a database that exists
 * but is not loaded yet, loads it first (at most `timeoutMs`), so `crm.` lists crm's tables.
 */
export async function loadQualifierDatabase(
  target: CompletionTarget,
  textBefore: string,
  timeoutMs = 5_000,
): Promise<void> {
  if (target.dialect === 'postgres') return;
  const name = qualifierBefore(textBefore);
  const known = metadataCache.facts(target.profileId)?.databases;
  if (name === undefined || !known) return;
  // lower_case_table_names 1 and 2 compare database names case-insensitively.
  const loose = (target.context.lowerCaseTableNames ?? 0) !== 0;
  const database = known.find((db) =>
    loose ? db.toLowerCase() === name.toLowerCase() : db === name,
  );
  if (database === undefined || metadataCache.loaded(target.profileId).includes(database)) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    metadataCache.use(target.profileId, database),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
    }),
  ]);
  clearTimeout(timer);
}

let snippetsLoaded: {
  readonly engine: SqlDialect;
  readonly at: number;
  list: Promise<SqlSnippet[]>;
}[] = [];

/** The snippet library for an engine, as completion items take it; refetched every minute. */
export function snippetsFor(engine: SqlDialect): Promise<readonly SqlSnippet[]> {
  const now = Date.now();
  snippetsLoaded = snippetsLoaded.filter((entry) => now - entry.at < 60_000);
  const cached = snippetsLoaded.find((entry) => entry.engine === engine);
  if (cached) return cached.list;
  const list = mainApi()
    .snippets.list({ engine })
    .then((snippets) => snippets.map(toSqlSnippet))
    .catch(() => []);
  snippetsLoaded.push({ engine, at: now, list });
  return list;
}

function toSqlSnippet(snippet: Snippet): SqlSnippet {
  return {
    prefix: snippet.prefix ?? snippet.name,
    body: snippet.body,
    description: snippet.description ?? snippet.name,
  };
}

/** The keyword case setting (upper unless the settings say otherwise). */
export function keywordCaseSetting(): KeywordCaseSetting {
  return queryClient.getQueryData<AppSettings>(keys.settings)?.editor.keywordCase ?? 'upper';
}
