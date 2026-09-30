import type { EngineId } from './engines';

/**
 * Server tools (spec §15): the monitoring view, session list, top queries, users, maintenance
 * and settings of MySQL, MariaDB, PostgreSQL and MongoDB, in one engine-neutral vocabulary.
 * Each driver implements `ServerTools` for its engine, the connection host enforces the write
 * rules around `run`, and the renderer draws every engine with the same components: what only
 * one engine has travels as labelled tiles, table columns and details, never as engine types.
 */

/** How a number or text should be shown. Durations: `ms` and `seconds`; `time` is ISO 8601. */
export type ValueUnit =
  'count' | 'bytes' | 'ms' | 'seconds' | 'ratio' | 'percent' | 'text' | 'time' | 'bool';

/** One table cell of server tools data. */
export type ToolCell = string | number | boolean | null;

export interface ToolColumn {
  readonly key: string;
  readonly label: string;
  /** Formatting hint; plain text when absent. */
  readonly unit?: ValueUnit;
}

/** A small table for display (replication members, locks, CHECK TABLE output...). */
export interface ToolTable {
  readonly columns: readonly ToolColumn[];
  readonly rows: readonly Readonly<Record<string, ToolCell>>[];
}

/** Something the user should know: a missing privilege or extension, a server limit. */
export interface ServerNotice {
  readonly level: 'info' | 'warning' | 'error';
  readonly message: string;
  /** What to do about it. */
  readonly hint?: string;
}

// ------------------------------------------------------------------------------------ info

/** A way to act on a session: cancel what it runs, or end it. */
export interface SessionActionInfo {
  readonly operation: 'cancel' | 'terminate';
  /** "Cancel query", "Terminate", "Kill query", "Kill connection", "Kill operation". */
  readonly label: string;
  readonly description: string;
}

export interface MaintenanceOptionInfo {
  readonly id: string;
  readonly label: string;
  readonly description: string;
}

/** Maintenance commands (spec §15): VACUUM, ANALYZE, OPTIMIZE, CHECK, compact, validate... */
export const MAINTENANCE_OPERATIONS = [
  'vacuum',
  'analyze',
  'reindex',
  'cluster',
  'optimize',
  'check',
  'repair',
  'compact',
  'validate',
] as const;
export type MaintenanceOperation = (typeof MAINTENANCE_OPERATIONS)[number];

/** Maintenance operations that only read and check: allowed on read-only profiles. */
export const CHECK_OPERATIONS: readonly MaintenanceOperation[] = ['check', 'validate'];

export interface MaintenanceOperationInfo {
  readonly id: MaintenanceOperation;
  /** The command's name: "VACUUM", "OPTIMIZE TABLE", "compact". */
  readonly label: string;
  readonly description: string;
  readonly options: readonly MaintenanceOptionInfo[];
  /** Several targets run in one statement or command batch. */
  readonly multiple: boolean;
  /** Takes an index to order by (CLUSTER ... USING). */
  readonly usesIndex?: boolean;
}

/**
 * Where a setting change applies: this session only (SET), the current database (ALTER
 * DATABASE ... SET), the running server (SET GLOBAL, setParameter), the running server and its
 * persisted configuration (SET PERSIST), or the configuration file (ALTER SYSTEM).
 */
export const SETTING_SCOPES = ['session', 'database', 'global', 'persist', 'system'] as const;
export type SettingScope = (typeof SETTING_SCOPES)[number];

export interface SettingScopeInfo {
  readonly scope: SettingScope;
  readonly label: string;
  readonly description: string;
}

export const TOP_QUERY_ORDERS = ['total', 'mean', 'calls', 'rows', 'max'] as const;
export type TopQueryOrder = (typeof TOP_QUERY_ORDERS)[number];

/** Parts of user management an engine has. */
export type AccessFeature =
  /** Accounts are user@host pairs (MySQL, MariaDB). */
  'hosts' | 'roles' | 'membership' | 'grants' | 'defaultPrivileges' | 'policies' | 'lock';

/** What the tools can do on the connected server, and as whom. */
export interface ServerToolsInfo {
  readonly engine: EngineId;
  /** "PostgreSQL", "MySQL", "MariaDB", "MongoDB". */
  readonly product: string;
  readonly version: string;
  /** The account the tools run as. */
  readonly user: string;
  /** The session's database, when it has one. */
  readonly database: string | null;
  /** Databases on the server the user can see. */
  readonly databases: readonly string[];
  /**
   * Objects are only reachable from a session in their database (PostgreSQL): maintenance and
   * grants in another database need a session opened there.
   */
  readonly perDatabaseSessions: boolean;
  readonly sessionActions: readonly SessionActionInfo[];
  readonly maintenance: readonly MaintenanceOperationInfo[];
  readonly settingScopes: readonly SettingScopeInfo[];
  readonly topQueryOrders: readonly TopQueryOrder[];
  /** Empty when users are managed elsewhere (MongoDB has its own users and roles editor). */
  readonly access: readonly AccessFeature[];
  /** Privileges of this account the other tabs depend on, and server limits. */
  readonly notices: readonly ServerNotice[];
}

// --------------------------------------------------------------------------------- monitor

/**
 * One figure of the monitoring view. A `gauge` is shown as read; a `rate` is a cumulative
 * counter the page turns into a per-second rate between polls; a `ratio` is two cumulative
 * counters whose deltas give the ratio over the last interval (hits / total).
 */
export type MonitorTile =
  | {
      readonly id: string;
      readonly label: string;
      readonly kind: 'gauge';
      readonly unit: ValueUnit;
      readonly value: number | null;
      readonly detail?: string;
    }
  | {
      readonly id: string;
      readonly label: string;
      readonly kind: 'rate';
      /** What is counted: `count` gives "/s", `bytes` gives "B/s". */
      readonly unit: ValueUnit;
      readonly counter: number | null;
      readonly detail?: string;
    }
  | {
      readonly id: string;
      readonly label: string;
      readonly kind: 'ratio';
      readonly hits: number | null;
      readonly total: number | null;
      /** How the quotient is shown: a percentage when absent, `ms` for an average latency. */
      readonly unit?: ValueUnit;
      readonly detail?: string;
    };

export interface MonitorSection {
  readonly id: string;
  readonly title: string;
  readonly table: ToolTable;
  /** Shown when the table is empty: "No replicas". */
  readonly empty?: string;
  /** Why the section is incomplete (a missing privilege). */
  readonly notice?: ServerNotice;
}

/** One poll of the monitoring view. */
export interface MonitorSnapshot {
  /** When it was read, Unix ms (the connection host's clock). */
  readonly at: number;
  readonly uptimeSeconds: number | null;
  readonly tiles: readonly MonitorTile[];
  readonly sections: readonly MonitorSection[];
  readonly notices: readonly ServerNotice[];
}

// -------------------------------------------------------------------------------- sessions

/** A server session, connection or operation in progress. */
export interface ServerSession {
  /**
   * Backend PID, thread id or operation id: what cancel and terminate take. Empty when there is
   * nothing to act on (an idle MongoDB connection has no operation).
   */
  readonly id: string;
  readonly user: string | null;
  readonly database: string | null;
  /** Client address. */
  readonly client: string | null;
  readonly application: string | null;
  /** "active", "idle in transaction", "Query", "Sleep", "getmore"... */
  readonly state: string | null;
  /** How long the current query or operation has run; null when idle or unknown. */
  readonly durationMs: number | null;
  /** What it waits for: a wait event or lock. */
  readonly wait: string | null;
  readonly query: string | null;
  /** Sessions holding a lock this one waits for. */
  readonly blockedBy: readonly string[];
  /** The server tools' own connection. */
  readonly own: boolean;
  /** A server process rather than a client (background worker, replication, internal op). */
  readonly background: boolean;
  readonly idle: boolean;
  readonly detail: Readonly<Record<string, ToolCell>>;
}

export interface SessionListOptions {
  readonly includeIdle?: boolean;
  readonly includeBackground?: boolean;
  /** Most sessions returned; default 1,000. */
  readonly limit?: number;
}

export interface SessionList {
  readonly sessions: readonly ServerSession[];
  /** Labels of the `detail` keys, in display order. */
  readonly detailColumns: readonly ToolColumn[];
  readonly notices: readonly ServerNotice[];
  /** More sessions matched than the limit. */
  readonly truncated: boolean;
}

// ----------------------------------------------------------------------------- top queries

/** A normalised statement with its accumulated statistics (or a profiled operation shape). */
export interface TopQuery {
  /** queryid, digest or profiler shape: stable while the statistics are kept. */
  readonly id: string;
  readonly text: string;
  readonly database: string | null;
  readonly user: string | null;
  readonly calls: number;
  readonly totalMs: number;
  readonly meanMs: number;
  readonly maxMs: number | null;
  readonly rows: number | null;
  readonly detail: Readonly<Record<string, ToolCell>>;
}

export interface TopQueryOptions {
  readonly orderBy?: TopQueryOrder;
  /** Most statements returned; default 100. */
  readonly limit?: number;
  /** MongoDB: the database whose profiler to read. */
  readonly database?: string;
}

/** Why the statistics cannot be read, and the fix when there is one. */
export interface TopQueriesUnavailable {
  readonly reason: 'not-installed' | 'not-loaded' | 'disabled' | 'no-privilege' | 'not-supported';
  readonly message: string;
  readonly hint?: string;
  /** An action that fixes it from here (CREATE EXTENSION). */
  readonly fix?: ServerAction;
}

/** The MongoDB database profiler of one database. */
export interface ProfilerStatus {
  readonly database: string;
  /** 0 off, 1 slow operations, 2 everything. */
  readonly level: 0 | 1 | 2;
  readonly slowMs: number | null;
  readonly sampleRate: number | null;
}

export interface TopQueries {
  /** Set when the statistics source is not usable; `queries` is then empty. */
  readonly unavailable: TopQueriesUnavailable | null;
  readonly queries: readonly TopQuery[];
  readonly detailColumns: readonly ToolColumn[];
  readonly notices: readonly ServerNotice[];
  /** The statistics can be reset from here. */
  readonly resettable: boolean;
  readonly profiler: ProfilerStatus | null;
}

// ----------------------------------------------------------------------------------- users

/** An account: a PostgreSQL role, a MySQL user@host, a MariaDB role (no host). */
export interface AccountRef {
  readonly name: string;
  readonly host?: string;
}

export interface RoleMembership {
  readonly role: AccountRef;
  /** WITH ADMIN OPTION: the member may grant the role on. */
  readonly admin: boolean;
  /** PostgreSQL 16+: the member inherits the role's privileges / may SET ROLE to it. */
  readonly inherit?: boolean;
  readonly set?: boolean;
}

export interface ServerAccount {
  readonly name: string;
  readonly host?: string;
  readonly kind: 'user' | 'role';
  readonly canLogin: boolean;
  readonly superuser: boolean;
  readonly locked?: boolean;
  /** Other attributes as labels: CREATEDB, REPLICATION, "password expired", the auth plugin... */
  readonly attributes: readonly string[];
  /** Roles granted to this account. */
  readonly memberOf: readonly RoleMembership[];
  readonly connectionLimit?: number | null;
  readonly validUntil?: string | null;
  /** Created by the server (pg_* roles, mysql.sys): not dropped from here. */
  readonly builtin: boolean;
}

export interface AccessOverview {
  readonly accounts: readonly ServerAccount[];
  readonly notices: readonly ServerNotice[];
}

export const GRANT_OBJECT_KINDS = [
  'global',
  'database',
  'schema',
  'table',
  'sequence',
  'function',
] as const;
export type GrantObjectKind = (typeof GRANT_OBJECT_KINDS)[number];

/** What a privilege is granted on: the server, a database, a schema, a table or view... */
export interface GrantObjectRef {
  readonly kind: GrantObjectKind;
  readonly database?: string;
  readonly schema?: string;
  readonly name?: string;
  /** A function's argument types, "(integer, text)". */
  readonly signature?: string;
}

/** `implied`: held without a grant of its own (owner, superuser, a wider grant). */
export type GrantState = 'none' | 'granted' | 'grantable' | 'implied';

export interface GrantRow {
  readonly object: GrantObjectRef;
  /** "public.orders", "shop.*", "*.*". */
  readonly label: string;
  /** "table", "view", "materialized view"... */
  readonly type: string;
  readonly privileges: Readonly<Record<string, GrantState>>;
}

/** The grants matrix (spec §15): objects × privileges for one grantee. */
export interface GrantMatrix {
  readonly grantee: AccountRef;
  /** The schema (PostgreSQL) or database (MySQL) the object rows come from. */
  readonly scope: string | null;
  /** Schemas or databases the scope can switch to. */
  readonly scopes: readonly string[];
  /** Privilege columns per object kind, in display order. */
  readonly privileges: Readonly<Partial<Record<GrantObjectKind, readonly string[]>>>;
  readonly rows: readonly GrantRow[];
  readonly notices: readonly ServerNotice[];
}

export const DEFAULT_PRIVILEGE_TYPES = [
  'tables',
  'sequences',
  'functions',
  'types',
  'schemas',
] as const;
export type DefaultPrivilegeType = (typeof DEFAULT_PRIVILEGE_TYPES)[number];

/** ALTER DEFAULT PRIVILEGES: what objects `owner` creates later grant to `grantee`. */
export interface DefaultPrivilege {
  readonly owner: string;
  /** null: in every schema. */
  readonly schema: string | null;
  readonly objectType: DefaultPrivilegeType;
  /** "PUBLIC" for everyone. */
  readonly grantee: string;
  readonly privileges: readonly string[];
  /** The subset granted WITH GRANT OPTION. */
  readonly grantable: readonly string[];
}

export const POLICY_COMMANDS = ['ALL', 'SELECT', 'INSERT', 'UPDATE', 'DELETE'] as const;
export type PolicyCommand = (typeof POLICY_COMMANDS)[number];

export interface RlsPolicy {
  readonly name: string;
  readonly permissive: boolean;
  readonly command: PolicyCommand;
  /** "public" for everyone. */
  readonly roles: readonly string[];
  readonly using: string | null;
  readonly withCheck: string | null;
}

/** A table's row-level security switch and policies. */
export interface RlsTable {
  readonly schema: string;
  readonly table: string;
  readonly enabled: boolean;
  /** Applies to the table owner too (FORCE ROW LEVEL SECURITY). */
  readonly forced: boolean;
  readonly policies: readonly RlsPolicy[];
}

/** Default privileges and row-level security of one schema (PostgreSQL). */
export interface AccessDetails {
  readonly schema: string;
  readonly schemas: readonly string[];
  readonly defaultPrivileges: readonly DefaultPrivilege[];
  readonly tables: readonly RlsTable[];
  readonly notices: readonly ServerNotice[];
}

/** Account attributes for create and alter; only the fields given change. */
export interface AccountOptions {
  /** A secret: sent to the server, masked in every preview and message. */
  readonly password?: string;
  readonly login?: boolean;
  readonly superuser?: boolean;
  readonly createDb?: boolean;
  readonly createRole?: boolean;
  readonly replication?: boolean;
  readonly bypassRls?: boolean;
  readonly inherit?: boolean;
  /** -1 for no limit. */
  readonly connectionLimit?: number;
  /** A timestamp, or "infinity"; null removes the limit. */
  readonly validUntil?: string | null;
  /** ACCOUNT LOCK / UNLOCK (MySQL, MariaDB). */
  readonly locked?: boolean;
}

// ----------------------------------------------------------------------------- maintenance

/** A maintenance target: a table in a schema or database, or a collection in a database. */
export interface MaintenanceTargetRef {
  /** The schema (PostgreSQL) or database (MySQL, MongoDB). */
  readonly container: string;
  readonly name: string;
}

export interface MaintenanceTarget extends MaintenanceTargetRef {
  /** "table", "materialized view", "collection"... */
  readonly type: string;
  /** Indexes, for CLUSTER ... USING. */
  readonly indexes: readonly string[];
  readonly detail: Readonly<Record<string, ToolCell>>;
}

export interface MaintenanceTargets {
  /** Schemas or databases to pick from. */
  readonly containers: readonly string[];
  readonly container: string | null;
  readonly targets: readonly MaintenanceTarget[];
  /** Labels of the `detail` keys, in display order. */
  readonly detailColumns: readonly ToolColumn[];
  readonly notices: readonly ServerNotice[];
}

// -------------------------------------------------------------------------------- settings

export interface ServerSetting {
  readonly name: string;
  /** The current value as the server prints it; null when unset or hidden. */
  readonly value: string | null;
  readonly unit: string | null;
  readonly category: string | null;
  readonly description: string | null;
  /** Where the value comes from: default, configuration file, SET GLOBAL... */
  readonly source: string | null;
  readonly type: 'bool' | 'integer' | 'real' | 'string' | 'enum' | 'document' | null;
  readonly enumValues: readonly string[];
  readonly min: string | null;
  readonly max: string | null;
  readonly defaultValue: string | null;
  /** Where it can be changed from here; empty when it cannot. */
  readonly scopes: readonly SettingScope[];
  /** A change takes effect only after a server restart. */
  readonly restartRequired: boolean;
  /** Changed in the configuration, waiting for a restart. */
  readonly pendingRestart: boolean;
}

export interface SettingList {
  readonly settings: readonly ServerSetting[];
  readonly notices: readonly ServerNotice[];
}

// --------------------------------------------------------------------------------- actions

/**
 * A change the tools can make. Every action is previewed (`ServerTools.preview` gives the
 * exact statements) before it runs, and the connection host checks the profile's write rules.
 */
export type ServerAction =
  | {
      readonly kind: 'session';
      readonly operation: 'cancel' | 'terminate';
      readonly id: string;
    }
  | {
      readonly kind: 'maintenance';
      readonly operation: MaintenanceOperation;
      readonly targets: readonly MaintenanceTargetRef[];
      /** Option ids from MaintenanceOperationInfo. */
      readonly options: readonly string[];
      /** CLUSTER ... USING this index. */
      readonly index?: string;
    }
  | {
      readonly kind: 'setting';
      readonly name: string;
      /** null resets the setting to its default. */
      readonly value: string | null;
      readonly scope: SettingScope;
    }
  | {
      readonly kind: 'topQueries';
      readonly operation: 'reset' | 'enable';
      /** MongoDB: the database whose profiler output to clear. */
      readonly database?: string;
    }
  | {
      readonly kind: 'profiler';
      readonly database: string;
      readonly level: 0 | 1 | 2;
      readonly slowMs?: number;
      readonly sampleRate?: number;
    }
  | {
      readonly kind: 'createAccount';
      readonly account: AccountRef;
      readonly role: boolean;
      readonly options: AccountOptions;
    }
  | {
      readonly kind: 'alterAccount';
      readonly account: AccountRef;
      readonly options: AccountOptions;
      readonly rename?: AccountRef;
    }
  | { readonly kind: 'dropAccount'; readonly account: AccountRef; readonly role: boolean }
  | {
      readonly kind: 'grant' | 'revoke';
      readonly grantee: AccountRef;
      readonly object: GrantObjectRef;
      readonly privileges: readonly string[];
      /** grant: WITH GRANT OPTION; revoke: only the grant option (GRANT OPTION FOR). */
      readonly grantOption?: boolean;
    }
  | {
      readonly kind: 'grantRole' | 'revokeRole';
      readonly role: AccountRef;
      readonly member: AccountRef;
      readonly admin?: boolean;
    }
  | {
      readonly kind: 'defaultPrivileges';
      readonly operation: 'grant' | 'revoke';
      /** FOR ROLE; the current user when absent. */
      readonly owner?: string;
      /** IN SCHEMA; every schema when absent. */
      readonly schema?: string;
      readonly objectType: DefaultPrivilegeType;
      readonly grantee: string;
      readonly privileges: readonly string[];
      readonly grantOption?: boolean;
    }
  | {
      readonly kind: 'createPolicy';
      readonly schema: string;
      readonly table: string;
      readonly name: string;
      readonly permissive: boolean;
      readonly command: PolicyCommand;
      readonly roles: readonly string[];
      /** SQL boolean expressions, written by the user. */
      readonly using?: string;
      readonly withCheck?: string;
    }
  | {
      readonly kind: 'dropPolicy';
      readonly schema: string;
      readonly table: string;
      readonly name: string;
    }
  | {
      readonly kind: 'rowSecurity';
      readonly schema: string;
      readonly table: string;
      readonly enabled: boolean;
      readonly forced?: boolean;
    };

export type ServerActionKind = ServerAction['kind'];

/** What an action will run, for the confirmation. */
export interface ActionPreview {
  /** "Terminate session 4211?" */
  readonly title: string;
  readonly summary: string;
  /** The exact statements or commands, in order; passwords masked. */
  readonly statements: readonly string[];
  readonly notices: readonly ServerNotice[];
}

export interface ActionResult {
  /** What ran, passwords masked. */
  readonly statements: readonly string[];
  /** Server output: VACUUM VERBOSE lines, warnings, what changed. */
  readonly messages: readonly ServerNotice[];
  /** Tabular output (CHECK TABLE, validate). */
  readonly table: ToolTable | null;
  readonly durationMs: number;
}

/** The text that replaces a password in previews, statements and errors. */
export const MASKED_SECRET = '********';

/**
 * The server tools of one session (spec §15). Reads never change the server; `run` executes an
 * action exactly as `preview` described it. Engines without a part throw NOT_SUPPORTED.
 */
export interface ServerTools {
  info(): Promise<ServerToolsInfo>;
  monitor(): Promise<MonitorSnapshot>;
  sessions(options?: SessionListOptions): Promise<SessionList>;
  topQueries(options?: TopQueryOptions): Promise<TopQueries>;
  accounts(): Promise<AccessOverview>;
  /** The grants matrix of `grantee` over one schema or database (`scope`, or the first). */
  grants(grantee: AccountRef, scope?: string): Promise<GrantMatrix>;
  accessDetails(schema?: string): Promise<AccessDetails>;
  maintenanceTargets(container?: string): Promise<MaintenanceTargets>;
  settings(): Promise<SettingList>;
  preview(action: ServerAction): Promise<ActionPreview>;
  run(action: ServerAction, options?: { readonly signal?: AbortSignal }): Promise<ActionResult>;
}
