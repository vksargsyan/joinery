import type { SchemaSnapshot, SqlDialect, SqlEngineId, TableDef } from '@joinery/core';
import {
  buildCatalog,
  complete,
  diagnose,
  signatureHelp,
  type Catalog,
  type CompletionResult,
  type SignatureHelp,
  type SqlDiagnostic,
  type SqlSnippet,
} from '@joinery/sql-tools';
import type { ValidationIssue } from '@joinery/sync';

/**
 * The editor's language service (spec §6), run in a Web Worker so parsing never blocks typing:
 * inline syntax errors (`diagnose`), autocomplete and signature help, and the table designer's
 * expression checks (`diagnose-table`, spec §8). It never talks to a database. The renderer
 * sends each connection's schema snapshots (a Catalog does not survive postMessage) and, with
 * every request, the session context of the tab asking; catalogs are built here on first use
 * and rebuilt when the snapshots change.
 *
 * Requests queue and run one per task, newest-wins per channel (an editor model): a request
 * still queued when a newer one of the same type arrives for the same channel, or when a
 * `cancel` for it arrives, is answered `cancelled` without running. Every request gets exactly
 * one response. This module has no worker globals, so it runs in tests as is.
 */

export type KeywordCaseSetting = 'upper' | 'lower' | 'preserve';

/** The session a request comes from: what unqualified names resolve against. */
export interface CatalogContext {
  readonly dialect: SqlDialect;
  readonly currentDatabase?: string;
  readonly searchPath?: readonly string[];
  readonly user?: string;
  readonly lowerCaseTableNames?: 0 | 1 | 2;
}

interface RequestBase {
  readonly id: number;
  /** Newer requests of the same type and channel replace queued ones (e.g. the model URI). */
  readonly channel?: string;
}

export interface CompleteRequest extends RequestBase {
  readonly type: 'complete';
  /** The connection's snapshots to complete from; keywords and functions only without one. */
  readonly profileId?: string;
  readonly context: CatalogContext;
  readonly text: string;
  readonly offset: number;
  readonly snippets?: readonly SqlSnippet[];
  readonly keywordCase?: KeywordCaseSetting;
  readonly maxItems?: number;
}

export interface SignatureRequest extends RequestBase {
  readonly type: 'signature';
  readonly profileId?: string;
  readonly context: CatalogContext;
  readonly text: string;
  readonly offset: number;
}

export interface DiagnoseRequest extends RequestBase {
  readonly type: 'diagnose';
  readonly text: string;
  readonly dialect: SqlDialect;
}

/** The designer's expressions (checks, defaults, generated columns...) parsed for errors. */
export interface DiagnoseTableRequest extends RequestBase {
  readonly type: 'diagnose-table';
  readonly table: TableDef;
  readonly engine: SqlEngineId;
  readonly schema: string;
}

export type LanguageTask =
  CompleteRequest | SignatureRequest | DiagnoseRequest | DiagnoseTableRequest;

export type LanguageRequest =
  | LanguageTask
  /**
   * Updates a connection's snapshots: upserts by database, removes, and (MySQL) names every
   * database on the server.
   */
  | {
      readonly type: 'snapshots';
      readonly profileId: string;
      readonly put?: readonly SchemaSnapshot[];
      readonly remove?: readonly string[];
      readonly databases?: readonly string[];
      /** Drop everything held for the profile first (a restarted worker being refilled). */
      readonly replace?: boolean;
    }
  | { readonly type: 'forget'; readonly profileId: string }
  | { readonly type: 'cancel'; readonly id: number };

export type LanguageResponse =
  | { readonly type: 'complete'; readonly id: number; readonly result: CompletionResult }
  | { readonly type: 'signature'; readonly id: number; readonly result: SignatureHelp | null }
  | {
      readonly type: 'diagnose';
      readonly id: number;
      readonly diagnostics: readonly SqlDiagnostic[];
    }
  | {
      readonly type: 'diagnose-table';
      readonly id: number;
      readonly issues: readonly ValidationIssue[];
    }
  | { readonly type: 'cancelled'; readonly id: number }
  | { readonly type: 'error'; readonly id: number; readonly message: string };

interface ProfileSnapshots {
  readonly snapshots: Map<string, SchemaSnapshot>;
  databases: readonly string[];
  /** Built catalogs by context, newest last. */
  readonly catalogs: Map<string, Catalog>;
}

/** Catalogs kept per connection: one per distinct tab context is plenty. */
const MAX_CATALOGS = 8;

const EMPTY_SCHEMA_PARTS = {
  tables: [],
  views: [],
  routines: [],
  sequences: [],
  types: [],
  events: [],
};

/** A database known by name only (MySQL): it completes as a name until it is loaded. */
function nameOnlySnapshot(dialect: SqlDialect, database: string): SchemaSnapshot {
  return {
    engine: dialect,
    database,
    options: {},
    schemas: [{ name: database, ...EMPTY_SCHEMA_PARTS }],
    extensions: [],
    capturedAt: '',
  };
}

/** Common keywords, to see which case the user writes them in. */
const CASE_WORDS =
  'select from where join on and or not group order by having limit insert into values update ' +
  'set delete create alter drop table as with union case when then else end is null in like ' +
  'between distinct inner left right returning';
const CASE_SAMPLE = new RegExp(`\\b(${CASE_WORDS.split(' ').join('|')})\\b`, 'gi');

/**
 * The keyword case to insert. `preserve` follows the word being typed when it has letters, else
 * the last common keyword before the cursor, else upper case.
 */
export function resolveKeywordCase(
  setting: KeywordCaseSetting | undefined,
  text: string,
  offset: number,
): 'upper' | 'lower' {
  if (setting === 'lower') return 'lower';
  if (setting !== 'preserve') return 'upper';
  const before = text.slice(Math.max(0, offset - 4000), offset);
  const typed = /[A-Za-z_][A-Za-z0-9_$]*$/.exec(before)?.[0];
  if (typed !== undefined && /[A-Za-z]/.test(typed)) {
    return typed === typed.toLowerCase() ? 'lower' : 'upper';
  }
  let last: string | undefined;
  for (const match of before.matchAll(CASE_SAMPLE)) last = match[0];
  return last !== undefined && last === last.toLowerCase() ? 'lower' : 'upper';
}

export interface LanguageServiceOptions {
  /** Runs `task` in a later task, so messages already posted (cancels) are handled first. */
  readonly schedule?: (task: () => void) => void;
}

export class LanguageService {
  readonly #post: (response: LanguageResponse) => void;
  readonly #schedule: (task: () => void) => void;
  readonly #profiles = new Map<string, ProfileSnapshots>();
  readonly #empty = new Map<string, Catalog>();
  readonly #queue: LanguageTask[] = [];
  /** Parsing requests running now; true once cancelled. */
  readonly #running = new Map<number, boolean>();
  #scheduled = false;

  constructor(post: (response: LanguageResponse) => void, options: LanguageServiceOptions = {}) {
    this.#post = post;
    this.#schedule = options.schedule ?? ((task) => setTimeout(task, 0));
  }

  handle(message: LanguageRequest): void {
    switch (message.type) {
      case 'snapshots':
        this.#updateSnapshots(message);
        return;
      case 'forget':
        this.#profiles.delete(message.profileId);
        return;
      case 'cancel':
        this.#cancel(message.id);
        return;
      default:
        this.#enqueue(message);
    }
  }

  #updateSnapshots(message: Extract<LanguageRequest, { type: 'snapshots' }>): void {
    let profile = this.#profiles.get(message.profileId);
    if (!profile || message.replace) {
      profile = { snapshots: new Map(), databases: [], catalogs: new Map() };
      this.#profiles.set(message.profileId, profile);
    }
    for (const database of message.remove ?? []) profile.snapshots.delete(database);
    for (const snapshot of message.put ?? []) profile.snapshots.set(snapshot.database, snapshot);
    if (message.databases) profile.databases = message.databases;
    profile.catalogs.clear();
  }

  #enqueue(task: LanguageTask): void {
    if (task.channel !== undefined) {
      for (let i = this.#queue.length - 1; i >= 0; i--) {
        const queued = this.#queue[i]!;
        if (queued.channel === task.channel && queued.type === task.type) {
          this.#queue.splice(i, 1);
          this.#post({ type: 'cancelled', id: queued.id });
        }
      }
    }
    this.#queue.push(task);
    this.#wake();
  }

  #cancel(id: number): void {
    const index = this.#queue.findIndex((task) => task.id === id);
    if (index >= 0) {
      this.#queue.splice(index, 1);
      this.#post({ type: 'cancelled', id });
    } else if (this.#running.has(id)) {
      this.#running.set(id, true);
    }
  }

  #wake(): void {
    if (this.#scheduled || this.#queue.length === 0) return;
    this.#scheduled = true;
    this.#schedule(() => {
      this.#scheduled = false;
      const task = this.#queue.shift();
      if (task) this.#run(task);
      this.#wake();
    });
  }

  #run(task: LanguageTask): void {
    try {
      switch (task.type) {
        case 'complete': {
          const catalog = this.#catalog(task.profileId, task.context);
          const result = complete(task.text, task.offset, task.context.dialect, catalog, {
            ...(task.snippets ? { snippets: task.snippets } : {}),
            keywordCase: resolveKeywordCase(task.keywordCase, task.text, task.offset),
            ...(task.maxItems === undefined ? {} : { maxItems: task.maxItems }),
          });
          this.#post({ type: 'complete', id: task.id, result });
          return;
        }
        case 'signature': {
          const catalog = this.#catalog(task.profileId, task.context);
          const result = signatureHelp(task.text, task.offset, task.context.dialect, catalog);
          this.#post({ type: 'signature', id: task.id, result: result ?? null });
          return;
        }
        case 'diagnose':
          this.#runAsync(task.id, diagnose(task.text, task.dialect), [], (diagnostics) => ({
            type: 'diagnose',
            id: task.id,
            diagnostics,
          }));
          return;
        case 'diagnose-table':
          this.#runAsync(
            task.id,
            // The designer's validation code loads only in the worker that checks designs.
            import('@joinery/sync').then(({ diagnoseTable }) =>
              diagnoseTable(task.table, { engine: task.engine, schema: task.schema }),
            ),
            [],
            (issues) => ({ type: 'diagnose-table', id: task.id, issues }),
          );
          return;
      }
    } catch (error) {
      this.#post({
        type: 'error',
        id: task.id,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Parsing requests load their grammar on first use, so they run while later requests
   * proceed; a failure answers `fallback` (no errors found) rather than an error.
   */
  #runAsync<T>(
    id: number,
    work: Promise<T>,
    fallback: T,
    respond: (value: T) => LanguageResponse,
  ): void {
    this.#running.set(id, false);
    const reply = (value: T): void => {
      const cancelled = this.#running.get(id) === true;
      this.#running.delete(id);
      this.#post(cancelled ? { type: 'cancelled', id } : respond(value));
    };
    work.then(reply, () => reply(fallback));
  }

  #catalog(profileId: string | undefined, context: CatalogContext): Catalog {
    const profile = profileId === undefined ? undefined : this.#profiles.get(profileId);
    if (!profile) {
      let empty = this.#empty.get(context.dialect);
      if (!empty) {
        empty = buildCatalog([], { dialect: context.dialect });
        this.#empty.set(context.dialect, empty);
      }
      return empty;
    }
    const key = JSON.stringify([
      context.dialect,
      context.currentDatabase ?? null,
      context.searchPath ?? null,
      context.user ?? null,
      context.lowerCaseTableNames ?? null,
    ]);
    let catalog = profile.catalogs.get(key);
    if (catalog) {
      // Most recently used last, so the oldest is evicted first.
      profile.catalogs.delete(key);
    } else {
      const snapshots = [...profile.snapshots.values()];
      for (const database of profile.databases) {
        if (!profile.snapshots.has(database)) {
          snapshots.push(nameOnlySnapshot(context.dialect, database));
        }
      }
      catalog = buildCatalog(snapshots, {
        dialect: context.dialect,
        ...(context.currentDatabase === undefined
          ? {}
          : { currentDatabase: context.currentDatabase }),
        ...(context.searchPath === undefined ? {} : { searchPath: context.searchPath }),
        ...(context.user === undefined ? {} : { user: context.user }),
        ...(context.lowerCaseTableNames === undefined
          ? {}
          : { lowerCaseTableNames: context.lowerCaseTableNames }),
      });
      if (profile.catalogs.size >= MAX_CATALOGS) {
        const oldest = profile.catalogs.keys().next().value;
        if (oldest !== undefined) profile.catalogs.delete(oldest);
      }
    }
    profile.catalogs.set(key, catalog);
    return catalog;
  }
}
