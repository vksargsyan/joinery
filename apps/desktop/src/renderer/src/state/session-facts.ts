import type { CellValue, SqlDialect } from '@querybara/core';
import { significantTokens, type StatementAnalysis, type Token } from '@querybara/sql-tools';

/**
 * What autocomplete needs to know about a session (spec §6) and how statements change it. The
 * facts come from small queries on a connection's metadata session, once per connection; a query
 * tab then tracks its own `USE` and `SET search_path` from the statements it runs, so completing
 * never has to borrow the tab's session (which may be busy or holding a paused cursor). Pure,
 * apart from the query callback.
 */

/** Where unqualified names resolve in a session. */
export interface SessionFacts {
  /** The current database: PostgreSQL's connected one, MySQL's `USE` (absent when none). */
  readonly database?: string;
  /** PostgreSQL: the search path's existing schemas, in order (`current_schemas(false)`). */
  readonly searchPath?: readonly string[];
  /** The session user, for `$user` in a search path set by the tab. */
  readonly user?: string;
  /** MySQL/MariaDB `@@lower_case_table_names`. */
  readonly lowerCaseTableNames?: 0 | 1 | 2;
}

/** The facts of a connection's default session, plus what the whole server offers. */
export interface ConnectionFacts extends SessionFacts {
  /** MySQL/MariaDB: every database on the server, so `db.` can load one when it is used. */
  readonly databases?: readonly string[];
}

/** Runs one query and returns the rows of its first result. */
export type QueryRunner = (sql: string) => Promise<readonly (readonly CellValue[])[]>;

const POSTGRES_FACTS =
  'SELECT current_database(), to_json(current_schemas(false))::text, current_user';
const MYSQL_FACTS = 'SELECT DATABASE(), @@lower_case_table_names';
const MYSQL_DATABASES = 'SELECT SCHEMA_NAME FROM information_schema.SCHEMATA ORDER BY SCHEMA_NAME';

function text(value: CellValue | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function lowerCaseTableNames(value: CellValue | undefined): 0 | 1 | 2 | undefined {
  const n = typeof value === 'bigint' ? Number(value) : Number(text(value) ?? value);
  return n === 0 || n === 1 || n === 2 ? n : undefined;
}

/** Reads a connection's session facts with one or two small queries. */
export async function readConnectionFacts(
  dialect: SqlDialect,
  run: QueryRunner,
): Promise<ConnectionFacts> {
  if (dialect === 'postgres') {
    const row = (await run(POSTGRES_FACTS))[0] ?? [];
    const database = text(row[0]);
    const user = text(row[2]);
    let searchPath: string[] | undefined;
    try {
      const parsed: unknown = JSON.parse(text(row[1]) ?? 'null');
      if (Array.isArray(parsed)) searchPath = parsed.filter((s) => typeof s === 'string');
    } catch {
      searchPath = undefined;
    }
    return {
      ...(database === undefined ? {} : { database }),
      ...(searchPath === undefined ? {} : { searchPath }),
      ...(user === undefined ? {} : { user }),
    };
  }
  // One after the other: a session runs one statement at a time.
  const facts = await run(MYSQL_FACTS);
  const databases = await run(MYSQL_DATABASES);
  const row = facts[0] ?? [];
  const database = text(row[0]);
  const lctn = lowerCaseTableNames(row[1]);
  return {
    ...(database === undefined ? {} : { database }),
    ...(lctn === undefined ? {} : { lowerCaseTableNames: lctn }),
    databases: databases.map((r) => text(r[0])).filter((name) => name !== undefined),
  };
}

/** A change a statement makes to where names resolve. */
export type SessionChange =
  | { readonly kind: 'database'; readonly database: string }
  /** `default`: back to the connection's search path (RESET, SET ... TO DEFAULT). */
  | { readonly kind: 'search-path'; readonly searchPath: readonly string[] | 'default' };

function unquote(token: Token): string {
  const quote = token.text.charAt(0);
  const body = token.text.slice(1, token.text.endsWith(quote) ? -1 : undefined);
  return body.replaceAll(quote + quote, quote);
}

/** The name a token spells in a search path or USE: unquoted, folded like the server does. */
function nameOf(token: Token | undefined, dialect: SqlDialect): string | undefined {
  if (!token) return undefined;
  if (token.kind === 'quoted-identifier' || token.kind === 'string') return unquote(token);
  if (token.kind !== 'word') return undefined;
  return dialect === 'postgres' ? token.text.toLowerCase() : token.text;
}

/**
 * The session change a statement makes: MySQL/MariaDB `USE db`, PostgreSQL `SET search_path`,
 * `SET SCHEMA` and `RESET search_path`/`RESET ALL`. `SET LOCAL` lasts only until the transaction
 * ends, so it is not tracked.
 */
export function sessionChangeOf(statement: string, dialect: SqlDialect): SessionChange | undefined {
  const tokens = significantTokens(statement, dialect).filter((t) => t.kind !== 'delimiter');
  const word = (i: number): string | undefined =>
    tokens[i]?.kind === 'word' ? tokens[i].text.toUpperCase() : undefined;
  if (dialect !== 'postgres') {
    if (word(0) !== 'USE' || tokens.length !== 2) return undefined;
    const database = nameOf(tokens[1], dialect);
    return database === undefined ? undefined : { kind: 'database', database };
  }
  if (word(0) === 'RESET') {
    return word(1) === 'ALL' || word(1) === 'SEARCH_PATH'
      ? { kind: 'search-path', searchPath: 'default' }
      : undefined;
  }
  if (word(0) !== 'SET') return undefined;
  let i = 1;
  if (word(i) === 'LOCAL') return undefined;
  if (word(i) === 'SESSION') i++;
  if (word(i) === 'SCHEMA') {
    const schema = nameOf(tokens[i + 1], dialect);
    return schema === undefined ? undefined : { kind: 'search-path', searchPath: [schema] };
  }
  if (word(i) !== 'SEARCH_PATH') return undefined;
  i++;
  if (word(i) !== 'TO' && tokens[i]?.text !== '=') return undefined;
  i++;
  if (word(i) === 'DEFAULT') return { kind: 'search-path', searchPath: 'default' };
  const path: string[] = [];
  for (; i < tokens.length; i += 2) {
    const name = nameOf(tokens[i], dialect);
    if (name === undefined) return undefined;
    path.push(name);
    const next = tokens[i + 1];
    if (next && next.text !== ',') return undefined;
  }
  return path.length > 0 ? { kind: 'search-path', searchPath: path } : undefined;
}

/** `name.` or `` `name`.pre `` at the end of the text: a qualifier being completed. */
const QUALIFIER =
  /(?:`((?:[^`]|``)+)`|([\p{L}\p{N}_$]+))\s*\.\s*(?:`(?:[^`]|``)*|[\p{L}\p{N}_$]*)$/u;

/**
 * The MySQL/MariaDB qualifier right before the cursor (`crm.` → `crm`), so a database that is
 * not loaded yet can be loaded before its tables are completed.
 */
export function qualifierBefore(textBefore: string): string | undefined {
  const match = QUALIFIER.exec(textBefore.slice(-400));
  return match?.[1]?.replaceAll('``', '`') ?? match?.[2];
}

/** A tab's own changes on top of its connection's facts. */
export interface TabSessionState {
  readonly database?: string;
  readonly searchPath?: readonly string[] | 'default';
}

/** The facts a tab's session has now: its own changes over the connection's facts. */
export function tabFacts(
  connection: ConnectionFacts | undefined,
  tab?: TabSessionState,
): SessionFacts {
  const database = tab?.database ?? connection?.database;
  const searchPath =
    tab?.searchPath === undefined || tab.searchPath === 'default'
      ? connection?.searchPath
      : tab.searchPath;
  return {
    ...(database === undefined ? {} : { database }),
    ...(searchPath === undefined ? {} : { searchPath }),
    ...(connection?.user === undefined ? {} : { user: connection.user }),
    ...(connection?.lowerCaseTableNames === undefined
      ? {}
      : { lowerCaseTableNames: connection.lowerCaseTableNames }),
  };
}

/** A statement that ran, with the safety analysis the run plan made of it. */
export interface RanStatement {
  readonly text: string;
  readonly analysis: StatementAnalysis;
}

/** What a run did to the metadata the app holds. */
export interface RunEffects {
  /** Databases whose snapshots are stale: DDL ran in them. */
  readonly stale: readonly string[];
  /** Databases the run dropped. */
  readonly dropped: readonly string[];
  /** A database was created, dropped or altered, so the list of databases may have changed. */
  readonly databaseList: boolean;
  /** The tab's session after the run: its last USE and SET search_path. */
  readonly session: TabSessionState | undefined;
}

/** DDL that leaves the structure as it was: it empties or refills tables. */
const DATA_ONLY_DDL = new Set(['TRUNCATE', 'REFRESH']);

/**
 * `CREATE | ALTER | DROP DATABASE [IF [NOT] EXISTS] name`, and MySQL's SCHEMA synonym: what it
 * does to which database, or undefined for other statements.
 */
function databaseStatement(
  tokens: readonly Token[],
  dialect: SqlDialect,
): { readonly verb: string; readonly name: string | undefined } | undefined {
  const words = tokens.map((t) => (t.kind === 'word' ? t.text.toUpperCase() : ''));
  const verb = words[0] ?? '';
  let i = 1;
  if (verb === 'CREATE' && words[i] === 'OR' && words[i + 1] === 'REPLACE') i += 2;
  const object = words[i];
  if (!['CREATE', 'ALTER', 'DROP'].includes(verb)) return undefined;
  if (object !== 'DATABASE' && !(object === 'SCHEMA' && dialect !== 'postgres')) return undefined;
  i++;
  if (words[i] === 'IF') i += words[i + 1] === 'NOT' ? 3 : 2;
  return { verb, name: nameOf(tokens[i], dialect) };
}

/**
 * Decides what a run made stale (spec §5: metadata refreshes after DDL run from Querybara).
 * PostgreSQL: DDL changes the connected database. MySQL/MariaDB: DDL changes the database in use
 * at that point of the script (after any USE) and every loaded database it names as a qualifier.
 * CREATE/ALTER/DROP DATABASE (or MySQL SCHEMA) changes the list of databases.
 */
export function effectsOfRun(input: {
  readonly dialect: SqlDialect;
  readonly statements: readonly RanStatement[];
  /** The tab's current database when the run started. */
  readonly database: string | undefined;
  /** Databases whose snapshots the app holds. */
  readonly loaded: readonly string[];
}): RunEffects {
  const { dialect } = input;
  const stale = new Set<string>();
  const dropped = new Set<string>();
  let databaseList = false;
  let database = input.database;
  let session: { database?: string; searchPath?: readonly string[] | 'default' } | undefined;
  const loaded = new Map(input.loaded.map((name) => [name.toLowerCase(), name]));
  const loadedName = (name: string | undefined): string | undefined =>
    name === undefined ? undefined : loaded.get(name.toLowerCase());
  for (const statement of input.statements) {
    const change = sessionChangeOf(statement.text, dialect);
    if (change?.kind === 'database') {
      database = change.database;
      session = { ...session, database: change.database };
    } else if (change?.kind === 'search-path') {
      session = { ...session, searchPath: change.searchPath };
    }
    if (statement.analysis.kind !== 'ddl') continue;
    const tokens = significantTokens(statement.text, dialect).filter((t) => t.kind !== 'delimiter');
    if (DATA_ONLY_DDL.has(tokens[0]?.text.toUpperCase() ?? '')) continue;
    const onDatabase = databaseStatement(tokens, dialect);
    if (onDatabase) {
      databaseList = true;
      const name = loadedName(onDatabase.name) ?? onDatabase.name;
      if (name === undefined) continue;
      if (onDatabase.verb === 'DROP') dropped.add(name);
      else if (onDatabase.verb === 'ALTER' && loaded.has(name.toLowerCase())) stale.add(name);
      continue;
    }
    // PostgreSQL: other databases cannot be named; CREATE SCHEMA and the rest change this one.
    if (database !== undefined) stale.add(database);
    if (dialect === 'postgres') continue;
    tokens.forEach((token, i) => {
      if (tokens[i + 1]?.text !== '.') return;
      const known = loadedName(nameOf(token, dialect));
      if (known !== undefined) stale.add(known);
    });
  }
  for (const name of dropped) stale.delete(name);
  return { stale: [...stale], dropped: [...dropped], databaseList, session };
}
