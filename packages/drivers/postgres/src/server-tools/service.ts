import {
  JoineryError,
  type AccessDetails,
  type AccessOverview,
  type AccountRef,
  type ActionPreview,
  type ActionResult,
  type GrantMatrix,
  type GrantObjectKind,
  type GrantRow,
  type MaintenanceOperationInfo,
  type MaintenanceTargets,
  type MonitorSnapshot,
  type ServerAction,
  type ServerNotice,
  type ServerTools,
  type ServerToolsInfo,
  type Session,
  type SessionList,
  type SessionListOptions,
  type SettingList,
  type TopQueries,
  type TopQueryOptions,
  type TopQueryOrder,
} from '@joinery/core';
import type { Row } from '@joinery/driver-sql-base';
import { quoteIdent } from '@joinery/sql-tools';

import {
  PG_SESSION_DETAIL_COLUMNS,
  boolOf,
  grantStates,
  jsonOf,
  numberOf,
  numberOrNull,
  pgAccounts,
  pgDefaultPrivileges,
  pgMonitorSnapshot,
  pgRlsTables,
  pgSession,
  pgSetting,
  pgTopQuery,
  statementColumns,
  textOrNull,
} from './read';
import { SqlRunner, withHint, type ToolStatement } from './runner';
import {
  accountStatements,
  defaultPrivilegeStatement,
  grantStatement,
  maintenanceStatements,
  membershipStatement,
  pidOf,
  policyStatement,
  privilegesFor,
  sessionStatement,
  settingStatements,
  topQueriesStatement,
} from './statements';

/**
 * PostgreSQL server tools (spec §15): pg_stat_activity, database statistics, locks, the cache
 * hit ratio and replication for the monitor; sessions with cancel and terminate;
 * pg_stat_statements; roles, membership, the grants matrix, default privileges and row-level
 * security policies; VACUUM, ANALYZE, REINDEX and CLUSTER; settings with SET, ALTER DATABASE and
 * ALTER SYSTEM. Everything runs through the session's `execute`, so it queues behind the
 * session's other work and shares its error mapping.
 */

interface PgFacts {
  readonly user: string;
  readonly database: string;
  readonly versionNum: number;
  readonly version: string;
  readonly superuser: boolean;
  readonly readAllStats: boolean;
  readonly signalBackend: boolean;
  readonly inRecovery: boolean;
  readonly databases: readonly string[];
  readonly pid: number;
}

const FACTS_SQL = `SELECT current_user AS usr, current_database() AS db,
  current_setting('server_version_num')::int AS version_num,
  current_setting('server_version') AS version,
  coalesce((SELECT r.rolsuper FROM pg_catalog.pg_roles r WHERE r.rolname = current_user), false) AS superuser,
  pg_catalog.pg_has_role(current_user, 'pg_read_all_stats', 'USAGE') AS read_all_stats,
  pg_catalog.pg_has_role(current_user, 'pg_signal_backend', 'USAGE') AS signal_backend,
  pg_catalog.pg_is_in_recovery() AS in_recovery,
  (SELECT json_agg(d.datname ORDER BY d.datname) FROM pg_catalog.pg_database d
    WHERE d.datallowconn AND NOT d.datistemplate
      AND pg_catalog.has_database_privilege(d.oid, 'CONNECT')) AS databases,
  pg_catalog.pg_backend_pid() AS pid`;

const ACTIVITY_SQL = `SELECT
  count(*) FILTER (WHERE backend_type = 'client backend') AS clients,
  count(*) FILTER (WHERE backend_type = 'client backend' AND state = 'active') AS active,
  count(*) FILTER (WHERE state LIKE 'idle in transaction%') AS idle_in_tx,
  count(*) FILTER (WHERE wait_event_type = 'Lock') AS lock_waits,
  coalesce(max(extract(epoch FROM clock_timestamp() - xact_start))
    FILTER (WHERE backend_type = 'client backend' AND pid <> pg_catalog.pg_backend_pid()), 0) AS longest_xact_s,
  coalesce(max(extract(epoch FROM clock_timestamp() - query_start))
    FILTER (WHERE state = 'active' AND backend_type = 'client backend'
      AND pid <> pg_catalog.pg_backend_pid()), 0) AS longest_query_s,
  current_setting('max_connections')::int AS max_connections,
  extract(epoch FROM clock_timestamp() - pg_catalog.pg_postmaster_start_time()) AS uptime_s,
  (SELECT count(*) FROM pg_catalog.pg_locks) AS locks,
  pg_catalog.pg_database_size(current_database()) AS db_size
FROM pg_catalog.pg_stat_activity`;

const DATABASES_SQL = `SELECT datname, numbackends, xact_commit, xact_rollback, blks_read, blks_hit,
  tup_returned, tup_fetched, tup_inserted, tup_updated, tup_deleted, conflicts, temp_files,
  temp_bytes, deadlocks
FROM pg_catalog.pg_stat_database WHERE datname IS NOT NULL ORDER BY datname`;

const REPLICAS_SQL = `SELECT application_name, client_addr::text AS client, state, sync_state,
  extract(epoch FROM replay_lag) * 1000 AS replay_lag_ms,
  pg_catalog.pg_wal_lsn_diff(pg_catalog.pg_current_wal_lsn(), replay_lsn) AS replay_lag_bytes
FROM pg_catalog.pg_stat_replication ORDER BY application_name, pid`;

const STANDBY_SQL = `SELECT pg_catalog.pg_last_wal_receive_lsn()::text AS received,
  pg_catalog.pg_last_wal_replay_lsn()::text AS replayed,
  extract(epoch FROM clock_timestamp() - pg_catalog.pg_last_xact_replay_timestamp()) AS replay_delay_s,
  pg_catalog.pg_wal_lsn_diff(pg_catalog.pg_last_wal_receive_lsn(), pg_catalog.pg_last_wal_replay_lsn()) AS replay_lag_bytes,
  (SELECT status FROM pg_catalog.pg_stat_wal_receiver) AS receiver_status,
  (SELECT sender_host || ':' || sender_port FROM pg_catalog.pg_stat_wal_receiver) AS sender`;

const SLOTS_SQL = `SELECT slot_name, slot_type, active, wal_status,
  pg_catalog.pg_wal_lsn_diff(pg_catalog.pg_current_wal_lsn(), restart_lsn) AS retained_bytes
FROM pg_catalog.pg_replication_slots ORDER BY slot_name`;

function lockWaitsSql(versionNum: number): string {
  // pg_locks.waitstart arrived in PostgreSQL 14.
  const since = versionNum >= 140000 ? 'coalesce(w.waitstart, a.state_change)' : 'a.state_change';
  return `SELECT w.pid, w.locktype, w.mode,
  CASE WHEN w.relation IS NOT NULL THEN w.relation::regclass::text END AS relation,
  a.usename, a.datname, extract(epoch FROM clock_timestamp() - ${since}) * 1000 AS waiting_ms,
  left(a.query, 300) AS query, array_to_string(pg_catalog.pg_blocking_pids(w.pid), ', ') AS blocked_by
FROM pg_catalog.pg_locks w JOIN pg_catalog.pg_stat_activity a ON a.pid = w.pid
WHERE NOT w.granted ORDER BY ${since} LIMIT 100`;
}

const SESSIONS_SQL = `SELECT to_jsonb(a) AS a,
  extract(epoch FROM clock_timestamp() - CASE
    WHEN a.state = 'active' THEN a.query_start
    WHEN a.state LIKE 'idle in transaction%' THEN a.xact_start END) * 1000 AS duration_ms,
  CASE WHEN a.wait_event_type = 'Lock'
    THEN array_to_string(pg_catalog.pg_blocking_pids(a.pid), ',') END AS blocked_by,
  a.pid = pg_catalog.pg_backend_pid() AS own
FROM pg_catalog.pg_stat_activity a
WHERE ($1::boolean OR a.state IS DISTINCT FROM 'idle')
  AND ($2::boolean OR a.backend_type = 'client backend')
ORDER BY a.backend_type <> 'client backend', a.query_start NULLS LAST, a.pid
LIMIT $3`;

const SCHEMAS_SQL = `SELECT nspname FROM pg_catalog.pg_namespace
WHERE nspname NOT LIKE 'pg\\_%' AND nspname <> 'information_schema' ORDER BY nspname`;

const MAINTENANCE: readonly MaintenanceOperationInfo[] = [
  {
    id: 'vacuum',
    label: 'VACUUM',
    description: 'Reclaims space from dead rows and updates the visibility map.',
    multiple: true,
    options: [
      {
        id: 'full',
        label: 'FULL',
        description: 'Rewrites the table to return space to the OS; locks it for the duration.',
      },
      { id: 'freeze', label: 'FREEZE', description: 'Freezes every row (aggressive).' },
      { id: 'analyze', label: 'ANALYZE', description: 'Also updates planner statistics.' },
      { id: 'verbose', label: 'VERBOSE', description: 'Reports what was done.' },
      {
        id: 'skip_locked',
        label: 'SKIP_LOCKED',
        description: 'Skips tables it cannot lock at once.',
      },
    ],
  },
  {
    id: 'analyze',
    label: 'ANALYZE',
    description: 'Updates the planner statistics.',
    multiple: true,
    options: [
      { id: 'verbose', label: 'VERBOSE', description: 'Reports what was done.' },
      {
        id: 'skip_locked',
        label: 'SKIP_LOCKED',
        description: 'Skips tables it cannot lock at once.',
      },
    ],
  },
  {
    id: 'reindex',
    label: 'REINDEX',
    description: "Rebuilds the table's indexes.",
    multiple: false,
    options: [
      {
        id: 'concurrently',
        label: 'CONCURRENTLY',
        description: 'Rebuilds without blocking writes (slower).',
      },
      { id: 'verbose', label: 'VERBOSE', description: 'Reports what was done.' },
    ],
  },
  {
    id: 'cluster',
    label: 'CLUSTER',
    description: 'Rewrites the table in the order of an index; locks it for the duration.',
    multiple: false,
    usesIndex: true,
    options: [{ id: 'verbose', label: 'VERBOSE', description: 'Reports what was done.' }],
  },
];

function notSupported(message: string): JoineryError {
  return new JoineryError({ code: 'NOT_SUPPORTED', message });
}

const PRIVILEGE_HINT = 'Ask a superuser for the privilege, or use a role that has it';

export class PostgresServerTools implements ServerTools {
  readonly #runner: SqlRunner;
  #facts: Promise<PgFacts> | undefined;

  constructor(session: Session) {
    if (session.engine !== 'postgres') throw notSupported('This is not a PostgreSQL session');
    this.#runner = new SqlRunner(session);
  }

  #loadFacts(): Promise<PgFacts> {
    this.#facts ??= this.#runner.row(FACTS_SQL).then((row) => {
      const r = row ?? {};
      return {
        user: textOrNull(r['usr']) ?? '',
        database: textOrNull(r['db']) ?? '',
        versionNum: numberOf(r['version_num']),
        version: textOrNull(r['version']) ?? '',
        superuser: boolOf(r['superuser']),
        readAllStats: boolOf(r['read_all_stats']),
        signalBackend: boolOf(r['signal_backend']),
        inRecovery: boolOf(r['in_recovery']),
        databases: jsonOf<string[] | null>(r['databases'], null) ?? [],
        pid: numberOf(r['pid']),
      };
    });
    this.#facts.catch(() => (this.#facts = undefined));
    return this.#facts;
  }

  async info(): Promise<ServerToolsInfo> {
    const facts = await this.#loadFacts();
    const notices: ServerNotice[] = [];
    if (!facts.readAllStats) {
      notices.push({
        level: 'info',
        message: "Other roles' queries and states are hidden from this role",
        hint: 'Membership in pg_read_all_stats (or pg_monitor) shows them',
      });
    }
    if (!facts.superuser && !facts.signalBackend) {
      notices.push({
        level: 'info',
        message: 'This role can cancel and terminate only its own sessions',
        hint: 'Membership in pg_signal_backend allows signalling other non-superuser sessions',
      });
    }
    if (facts.inRecovery) {
      notices.push({
        level: 'info',
        message: 'This server is a standby: it is read-only and replays WAL from a primary',
      });
    }
    return {
      engine: 'postgres',
      product: 'PostgreSQL',
      version: facts.version,
      user: facts.user,
      database: facts.database,
      databases: facts.databases,
      perDatabaseSessions: true,
      sessionActions: [
        {
          operation: 'cancel',
          label: 'Cancel query',
          description: 'Cancels the running query (pg_cancel_backend); the session stays.',
        },
        {
          operation: 'terminate',
          label: 'Terminate',
          description: 'Ends the session (pg_terminate_backend); its open transaction rolls back.',
        },
      ],
      maintenance: MAINTENANCE,
      settingScopes: [
        {
          scope: 'session',
          label: 'This session (SET)',
          description: "Only the server tools' own session; handy to try a value.",
        },
        {
          scope: 'database',
          label: `Database ${facts.database} (ALTER DATABASE)`,
          description: 'New sessions in this database start with the value.',
        },
        {
          scope: 'system',
          label: 'Server configuration (ALTER SYSTEM)',
          description:
            'Written to postgresql.auto.conf and reloaded; some settings need a restart.',
        },
      ],
      topQueryOrders: ['total', 'mean', 'calls', 'rows', 'max'],
      access: ['roles', 'membership', 'grants', 'defaultPrivileges', 'policies'],
      notices,
    };
  }

  async monitor(): Promise<MonitorSnapshot> {
    const facts = await this.#loadFacts();
    const at = Date.now();
    const activity = (await this.#runner.row(ACTIVITY_SQL)) ?? {};
    const databases = await this.#runner.rows(DATABASES_SQL);
    const notices: ServerNotice[] = [];
    const optional = async (sql: string, what: string): Promise<Row[]> => {
      try {
        return await this.#runner.rows(sql);
      } catch (error) {
        notices.push({
          level: 'warning',
          message: `${what} could not be read: ${error instanceof Error ? error.message : String(error)}`,
        });
        return [];
      }
    };
    const replication = await optional(
      facts.inRecovery ? STANDBY_SQL : REPLICAS_SQL,
      'Replication',
    );
    const slots = facts.inRecovery ? [] : await optional(SLOTS_SQL, 'Replication slots');
    const lockWaits = await optional(lockWaitsSql(facts.versionNum), 'Lock waits');
    if (!facts.readAllStats) {
      notices.push({
        level: 'info',
        message: "Counts include only this role's sessions in full",
        hint: 'Membership in pg_read_all_stats shows every session',
      });
    }
    return pgMonitorSnapshot(at, {
      activity,
      databases,
      inRecovery: facts.inRecovery,
      replication,
      slots,
      lockWaits,
      database: facts.database,
      notices,
    });
  }

  async sessions(options: SessionListOptions = {}): Promise<SessionList> {
    const facts = await this.#loadFacts();
    const limit = Math.max(1, Math.min(options.limit ?? 1000, 10_000));
    const rows = await this.#runner.rows(SESSIONS_SQL, [
      options.includeIdle ?? true,
      options.includeBackground ?? false,
      limit + 1,
    ]);
    const sessions = rows.slice(0, limit).map(pgSession);
    const notices: ServerNotice[] = [];
    if (!facts.readAllStats && sessions.some((s) => s.query === '<insufficient privilege>')) {
      notices.push({
        level: 'info',
        message: "Queries of other roles' sessions are hidden",
        hint: 'Membership in pg_read_all_stats shows them',
      });
    }
    return {
      sessions,
      detailColumns: PG_SESSION_DETAIL_COLUMNS,
      notices,
      truncated: rows.length > limit,
    };
  }

  async #statementsExtension(): Promise<{
    schema: string;
    columns: string[];
    canReset: boolean;
  } | null> {
    const row = await this.#runner.row(
      `SELECT n.nspname AS schema,
        (SELECT json_agg(a.attname) FROM pg_catalog.pg_attribute a
          WHERE a.attrelid = (SELECT c.oid FROM pg_catalog.pg_class c
            WHERE c.relname = 'pg_stat_statements' AND c.relnamespace = n.oid)
          AND a.attnum > 0 AND NOT a.attisdropped) AS columns,
        coalesce((SELECT bool_or(pg_catalog.has_function_privilege(p.oid, 'EXECUTE'))
          FROM pg_catalog.pg_proc p
          WHERE p.proname = 'pg_stat_statements_reset' AND p.pronamespace = n.oid), false) AS can_reset
      FROM pg_catalog.pg_extension e JOIN pg_catalog.pg_namespace n ON n.oid = e.extnamespace
      WHERE e.extname = 'pg_stat_statements'`,
    );
    if (!row) return null;
    return {
      schema: textOrNull(row['schema']) ?? 'public',
      columns: jsonOf<string[] | null>(row['columns'], null) ?? [],
      canReset: boolOf(row['can_reset']),
    };
  }

  async topQueries(options: TopQueryOptions = {}): Promise<TopQueries> {
    const facts = await this.#loadFacts();
    const base = {
      queries: [],
      detailColumns: [],
      notices: [],
      resettable: false,
      profiler: null,
    } satisfies Omit<TopQueries, 'unavailable'>;
    const extension = await this.#statementsExtension();
    if (!extension) {
      const available = await this.#runner.row(
        `SELECT default_version,
          (SELECT setting FROM pg_catalog.pg_settings WHERE name = 'shared_preload_libraries') AS preload
        FROM pg_catalog.pg_available_extensions WHERE name = 'pg_stat_statements'`,
      );
      if (!available) {
        return {
          ...base,
          unavailable: {
            reason: 'not-installed',
            message: 'pg_stat_statements is not available on this server',
            hint: 'Install the PostgreSQL contrib package, add pg_stat_statements to shared_preload_libraries and restart the server',
          },
        };
      }
      const preload = textOrNull(available['preload']);
      const preloaded = preload !== null && /(^|,)\s*"?pg_stat_statements"?\s*(,|$)/.test(preload);
      return {
        ...base,
        unavailable: {
          reason: 'not-installed',
          message: `The pg_stat_statements extension is not installed in database "${facts.database}"`,
          hint: preloaded
            ? 'Create the extension here (it needs a superuser or the database owner with CREATE)'
            : `Create the extension, and add pg_stat_statements to shared_preload_libraries${
                preload === null ? ' (this role cannot see its current value)' : ''
              }: that setting takes effect after a server restart`,
          fix: { kind: 'topQueries', operation: 'enable' },
        },
      };
    }
    const cols = statementColumns(extension.columns);
    const order: Record<TopQueryOrder, string> = {
      total: 'total_ms',
      mean: 'mean_ms',
      calls: 'calls',
      rows: 'rows',
      max: 'max_ms',
    };
    const s = (column: string): string => `s.${quoteIdent(column, 'postgres')}`;
    const limit = Math.max(1, Math.min(options.limit ?? 100, 1000));
    const sql = `SELECT s.queryid::text AS id, s.query, d.datname, r.rolname, s.calls,
      ${s(cols.total)} AS total_ms, ${s(cols.mean)} AS mean_ms, ${s(cols.max)} AS max_ms, s.rows,
      s.shared_blks_hit, s.shared_blks_read, s.temp_blks_written
      ${cols.planTotal ? `, ${s(cols.planTotal)} AS plan_ms` : ''}
      ${cols.readTime ? `, ${s(cols.readTime)} AS read_ms` : ''}
      ${cols.walBytes ? `, ${s(cols.walBytes)} AS wal_bytes` : ''}
    FROM ${quoteIdent(extension.schema, 'postgres')}.pg_stat_statements s
      LEFT JOIN pg_catalog.pg_database d ON d.oid = s.dbid
      LEFT JOIN pg_catalog.pg_roles r ON r.oid = s.userid
    ORDER BY ${order[options.orderBy ?? 'total']} DESC NULLS LAST LIMIT $1`;
    let rows: Row[];
    try {
      rows = await this.#runner.rows(sql, [limit]);
    } catch (error) {
      if (error instanceof JoineryError && error.sqlState === '55000') {
        return {
          ...base,
          unavailable: {
            reason: 'not-loaded',
            message: 'pg_stat_statements is installed but not loaded by the server',
            hint: "Add pg_stat_statements to shared_preload_libraries (ALTER SYSTEM SET shared_preload_libraries = '…, pg_stat_statements') and restart the server",
          },
        };
      }
      throw error;
    }
    const queries = rows.map(pgTopQuery);
    const notices: ServerNotice[] = [];
    if (!facts.readAllStats && queries.some((q) => q.text === '<insufficient privilege>')) {
      notices.push({
        level: 'info',
        message: 'Statements of other roles are hidden',
        hint: 'Membership in pg_read_all_stats shows them',
      });
    }
    return {
      ...base,
      unavailable: null,
      queries,
      notices,
      resettable: extension.canReset,
      detailColumns: [
        { key: 'hitRatio', label: 'Cache hits', unit: 'ratio' },
        { key: 'sharedRead', label: 'Blocks read', unit: 'count' },
        { key: 'tempWritten', label: 'Temp blocks', unit: 'count' },
        ...(cols.planTotal ? [{ key: 'planMs', label: 'Planning', unit: 'ms' } as const] : []),
        ...(cols.readTime ? [{ key: 'readMs', label: 'Read time', unit: 'ms' } as const] : []),
        ...(cols.walBytes ? [{ key: 'walBytes', label: 'WAL', unit: 'bytes' } as const] : []),
      ],
    };
  }

  async accounts(): Promise<AccessOverview> {
    const roles = await this.#runner.rows(
      'SELECT to_jsonb(r) AS r FROM pg_catalog.pg_roles r ORDER BY r.rolname',
    );
    const members = await this.#runner.rows(
      `SELECT to_jsonb(m) AS m, g.rolname AS role, u.rolname AS member
      FROM pg_catalog.pg_auth_members m
        JOIN pg_catalog.pg_roles g ON g.oid = m.roleid
        JOIN pg_catalog.pg_roles u ON u.oid = m.member
      ORDER BY 2, 3`,
    );
    return { accounts: pgAccounts(roles, members), notices: [] };
  }

  async #schemas(): Promise<string[]> {
    return (await this.#runner.rows(SCHEMAS_SQL)).map((r) => textOrNull(r['nspname']) ?? '');
  }

  async #pickSchema(schema: string | undefined): Promise<{ schema: string; schemas: string[] }> {
    const schemas = await this.#schemas();
    if (schema !== undefined) {
      if (!schemas.includes(schema)) {
        throw new JoineryError({ code: 'NOT_FOUND', message: `There is no schema "${schema}"` });
      }
      return { schema, schemas };
    }
    return { schema: schemas.includes('public') ? 'public' : (schemas[0] ?? 'public'), schemas };
  }

  async grants(grantee: AccountRef, scope?: string): Promise<GrantMatrix> {
    const facts = await this.#loadFacts();
    const role = await this.#runner.row(
      'SELECT oid::bigint AS oid, rolsuper FROM pg_catalog.pg_roles WHERE rolname = $1',
      [grantee.name],
    );
    if (!role) {
      throw new JoineryError({ code: 'NOT_FOUND', message: `There is no role "${grantee.name}"` });
    }
    const oid = numberOf(role['oid']);
    const { schema, schemas } = await this.#pickSchema(scope);
    const privileges = privilegesFor(facts.versionNum);
    // acldefault gives the built-in privileges of an object whose ACL was never changed.
    const explicit = (acl: string, owner: string, type: string): string =>
      `coalesce((SELECT json_agg(json_build_object('p', x.privilege_type, 'g', x.is_grantable))
        FROM pg_catalog.aclexplode(coalesce(${acl}, pg_catalog.acldefault((${type})::"char", ${owner}))) x
        WHERE x.grantee = $1::oid), '[]')`;
    const effective = (fn: string, target: string, list: readonly string[]): string =>
      `json_build_object(${list
        .map((p) => `'${p}', pg_catalog.${fn}($1::oid, ${target}, '${p}')`)
        .join(', ')})`;
    const rows: GrantRow[] = [];
    const push = (
      kind: GrantObjectKind,
      row: Row,
      object: GrantRow['object'],
      label: string,
      type: string,
    ): void => {
      rows.push({
        object,
        label,
        type,
        privileges: grantStates(
          privileges[kind],
          jsonOf<{ p: string; g: boolean }[]>(row['explicit'], []),
          jsonOf<Record<string, boolean>>(row['effective'], {}),
          boolOf(row['owner']),
        ),
      });
    };
    const db = await this.#runner.row(
      `SELECT ${explicit('d.datacl', 'd.datdba', "'d'")} AS explicit, d.datdba = $1::oid AS owner,
        ${effective('has_database_privilege', 'd.oid', privileges.database)} AS effective
      FROM pg_catalog.pg_database d WHERE d.datname = current_database()`,
      [oid],
    );
    if (db) {
      push('database', db, { kind: 'database', name: facts.database }, facts.database, 'database');
    }
    const ns = await this.#runner.row(
      `SELECT ${explicit('n.nspacl', 'n.nspowner', "'n'")} AS explicit, n.nspowner = $1::oid AS owner,
        ${effective('has_schema_privilege', 'n.oid', privileges.schema)} AS effective
      FROM pg_catalog.pg_namespace n WHERE n.nspname = $2`,
      [oid, schema],
    );
    if (ns) push('schema', ns, { kind: 'schema', name: schema }, schema, 'schema');
    const relations = await this.#runner.rows(
      `SELECT c.relname AS name, c.relkind::text AS relkind,
        ${explicit('c.relacl', 'c.relowner', "CASE WHEN c.relkind = 'S' THEN 's' ELSE 'r' END")} AS explicit,
        c.relowner = $1::oid AS owner,
        CASE WHEN c.relkind = 'S'
          THEN ${effective('has_sequence_privilege', 'c.oid', privileges.sequence)}
          ELSE ${effective('has_table_privilege', 'c.oid', privileges.table)} END AS effective
      FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $2 AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
      ORDER BY c.relkind = 'S', c.relname LIMIT 2000`,
      [oid, schema],
    );
    const TYPES: Record<string, string> = {
      r: 'table',
      p: 'partitioned table',
      v: 'view',
      m: 'materialized view',
      f: 'foreign table',
      S: 'sequence',
    };
    for (const row of relations) {
      const name = textOrNull(row['name']) ?? '';
      const sequence = row['relkind'] === 'S';
      push(
        sequence ? 'sequence' : 'table',
        row,
        { kind: sequence ? 'sequence' : 'table', schema, name },
        `${schema}.${name}`,
        TYPES[textOrNull(row['relkind']) ?? ''] ?? 'table',
      );
    }
    const functions = await this.#runner.rows(
      `SELECT p.proname AS name, pg_catalog.pg_get_function_identity_arguments(p.oid) AS args,
        p.prokind::text AS prokind,
        ${explicit('p.proacl', 'p.proowner', "'f'")} AS explicit, p.proowner = $1::oid AS owner,
        ${effective('has_function_privilege', 'p.oid', privileges.function)} AS effective
      FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = $2 AND p.prokind IN ('f', 'p')
      ORDER BY p.proname, 2 LIMIT 1000`,
      [oid, schema],
    );
    for (const row of functions) {
      const name = textOrNull(row['name']) ?? '';
      const args = textOrNull(row['args']) ?? '';
      push(
        'function',
        row,
        { kind: 'function', schema, name, signature: args },
        `${schema}.${name}(${args})`,
        row['prokind'] === 'p' ? 'procedure' : 'function',
      );
    }
    const notices: ServerNotice[] = [];
    if (boolOf(role['rolsuper'])) {
      notices.push({
        level: 'info',
        message: `${grantee.name} is a superuser: every privilege is implied`,
      });
    }
    return {
      grantee: { name: grantee.name },
      scope: schema,
      scopes: schemas,
      privileges: {
        database: privileges.database,
        schema: privileges.schema,
        table: privileges.table,
        sequence: privileges.sequence,
        function: privileges.function,
      },
      rows,
      notices,
    };
  }

  async accessDetails(schemaName?: string): Promise<AccessDetails> {
    const { schema, schemas } = await this.#pickSchema(schemaName);
    const defaults = await this.#runner.rows(
      `SELECT pg_catalog.pg_get_userbyid(d.defaclrole) AS owner, n.nspname AS schema,
        d.defaclobjtype::text AS type,
        CASE WHEN x.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(x.grantee) END AS grantee,
        x.privilege_type AS privilege, x.is_grantable AS grantable
      FROM pg_catalog.pg_default_acl d
        LEFT JOIN pg_catalog.pg_namespace n ON n.oid = d.defaclnamespace
        CROSS JOIN LATERAL pg_catalog.aclexplode(d.defaclacl) x
      ORDER BY 1, 2 NULLS FIRST, 3, 4, 5`,
    );
    const tables = await this.#runner.rows(
      `SELECT c.relname AS name, c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced,
        (SELECT json_agg(json_build_object('name', p.polname, 'permissive', p.polpermissive,
            'cmd', p.polcmd::text,
            'roles', (SELECT json_agg(CASE WHEN r = 0 THEN 'public' ELSE pg_catalog.pg_get_userbyid(r) END)
                      FROM unnest(p.polroles) r),
            'using', pg_catalog.pg_get_expr(p.polqual, p.polrelid),
            'check', pg_catalog.pg_get_expr(p.polwithcheck, p.polrelid)) ORDER BY p.polname)
          FROM pg_catalog.pg_policy p WHERE p.polrelid = c.oid) AS policies
      FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relkind IN ('r', 'p')
      ORDER BY c.relname LIMIT 2000`,
      [schema],
    );
    return {
      schema,
      schemas,
      defaultPrivileges: pgDefaultPrivileges(defaults),
      tables: pgRlsTables(schema, tables),
      notices: [],
    };
  }

  async maintenanceTargets(container?: string): Promise<MaintenanceTargets> {
    const { schema, schemas } = await this.#pickSchema(container);
    const rows = await this.#runner.rows(
      `SELECT c.relname AS name, c.relkind::text AS relkind,
        pg_catalog.pg_total_relation_size(c.oid) AS total_bytes,
        s.n_live_tup, s.n_dead_tup,
        coalesce(greatest(s.last_vacuum, s.last_autovacuum)::text, '') AS last_vacuum,
        coalesce(greatest(s.last_analyze, s.last_autoanalyze)::text, '') AS last_analyze,
        (SELECT json_agg(i.relname ORDER BY x.indisclustered DESC, i.relname)
          FROM pg_catalog.pg_index x JOIN pg_catalog.pg_class i ON i.oid = x.indexrelid
          WHERE x.indrelid = c.oid) AS indexes,
        (SELECT i.relname FROM pg_catalog.pg_index x JOIN pg_catalog.pg_class i ON i.oid = x.indexrelid
          WHERE x.indrelid = c.oid AND x.indisclustered) AS clustered_on
      FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
        LEFT JOIN pg_catalog.pg_stat_all_tables s ON s.relid = c.oid
      WHERE n.nspname = $1 AND c.relkind IN ('r', 'p', 'm')
      ORDER BY c.relname LIMIT 5000`,
      [schema],
    );
    return {
      containers: schemas,
      container: schema,
      targets: rows.map((row) => ({
        container: schema,
        name: textOrNull(row['name']) ?? '',
        type:
          row['relkind'] === 'm'
            ? 'materialized view'
            : row['relkind'] === 'p'
              ? 'partitioned table'
              : 'table',
        indexes: jsonOf<string[] | null>(row['indexes'], null) ?? [],
        detail: {
          size: numberOrNull(row['total_bytes']),
          liveRows: numberOrNull(row['n_live_tup']),
          deadRows: numberOrNull(row['n_dead_tup']),
          lastVacuum: textOrNull(row['last_vacuum']) || null,
          lastAnalyze: textOrNull(row['last_analyze']) || null,
          clusteredOn: textOrNull(row['clustered_on']),
        },
      })),
      detailColumns: [
        { key: 'size', label: 'Size', unit: 'bytes' },
        { key: 'liveRows', label: 'Live rows', unit: 'count' },
        { key: 'deadRows', label: 'Dead rows', unit: 'count' },
        { key: 'lastVacuum', label: 'Last vacuum', unit: 'time' },
        { key: 'lastAnalyze', label: 'Last analyze', unit: 'time' },
        { key: 'clusteredOn', label: 'Clustered on' },
      ],
      notices: [],
    };
  }

  async settings(): Promise<SettingList> {
    const facts = await this.#loadFacts();
    // PostgreSQL 15 lets a superuser grant ALTER SYSTEM on single parameters.
    const perParameter = !facts.superuser && facts.versionNum >= 150000;
    const rows = await this.#runner.rows(
      `SELECT name, setting, unit, category, short_desc, context, vartype, source, min_val, max_val,
        array_to_json(enumvals) AS enumvals, boot_val, pending_restart
        ${perParameter ? ", pg_catalog.has_parameter_privilege(name, 'ALTER SYSTEM') AS alter_system" : ''}
      FROM pg_catalog.pg_settings ORDER BY name`,
    );
    const allowAlterSystem = rows.find((r) => r['name'] === 'allow_alter_system');
    const alterSystemOff = allowAlterSystem !== undefined && allowAlterSystem['setting'] === 'off';
    const settings = rows.map((row) =>
      pgSetting(row, {
        superuser: facts.superuser,
        alterSystem: (_name, r) =>
          !alterSystemOff && (facts.superuser || (perParameter && boolOf(r['alter_system']))),
      }),
    );
    const notices: ServerNotice[] = [];
    if (alterSystemOff) {
      notices.push({
        level: 'info',
        message: 'ALTER SYSTEM is turned off on this server (allow_alter_system = off)',
        hint: "Change settings in the server's configuration files or your provider's parameter settings",
      });
    } else if (!facts.superuser) {
      notices.push({
        level: 'info',
        message: 'Only superusers can change the server configuration with ALTER SYSTEM',
        hint: "On a managed service, use the provider's parameter settings; ALTER DATABASE ... SET works for most session settings",
      });
    }
    return { settings, notices };
  }

  // ----------------------------------------------------------------------------- actions

  async #statements(action: ServerAction): Promise<ToolStatement[]> {
    const facts = await this.#loadFacts();
    switch (action.kind) {
      case 'session':
        if (pidOf(action.id) === facts.pid) {
          throw new JoineryError({
            code: 'VALIDATION_FAILED',
            message: "This is the server tools' own session",
          });
        }
        return [sessionStatement(action.operation, action.id)];
      case 'maintenance':
        return maintenanceStatements(action, facts.versionNum);
      case 'setting':
        return settingStatements(action, facts.database);
      case 'topQueries': {
        const extension =
          action.operation === 'reset' ? await this.#statementsExtension() : undefined;
        return [topQueriesStatement(action.operation, extension?.schema ?? null)];
      }
      case 'createAccount':
      case 'alterAccount':
      case 'dropAccount':
        return accountStatements(action);
      case 'grantRole':
      case 'revokeRole':
        return [membershipStatement(action)];
      case 'grant':
      case 'revoke': {
        if (action.object.kind !== 'function') {
          return [grantStatement(action, facts.versionNum)];
        }
        const found = await this.#runner.row(
          `SELECT format('%I.%I(%s)', n.nspname, p.proname,
              pg_catalog.pg_get_function_identity_arguments(p.oid)) AS fn
          FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = $1 AND p.proname = $2
            AND pg_catalog.pg_get_function_identity_arguments(p.oid) = $3`,
          [action.object.schema ?? '', action.object.name ?? '', action.object.signature ?? ''],
        );
        if (!found) {
          throw new JoineryError({ code: 'NOT_FOUND', message: 'The function was not found' });
        }
        return [grantStatement(action, facts.versionNum, textOrNull(found['fn']) ?? undefined)];
      }
      case 'defaultPrivileges':
        return [defaultPrivilegeStatement(action, facts.versionNum)];
      case 'createPolicy':
      case 'dropPolicy':
      case 'rowSecurity':
        return [policyStatement(action)];
      case 'profiler':
        throw notSupported('PostgreSQL has no database profiler; use pg_stat_statements');
    }
  }

  async preview(action: ServerAction): Promise<ActionPreview> {
    const statements = await this.#statements(action);
    const notices: ServerNotice[] = [];
    if (action.kind === 'maintenance') {
      if (action.operation === 'vacuum' && action.options.includes('full')) {
        notices.push({
          level: 'warning',
          message: 'VACUUM FULL rewrites each table and locks it against reads and writes',
        });
      }
      if (action.operation === 'cluster') {
        notices.push({
          level: 'warning',
          message: 'CLUSTER rewrites each table and locks it against reads and writes',
        });
      }
      if (action.operation === 'reindex' && !action.options.includes('concurrently')) {
        notices.push({
          level: 'warning',
          message: 'REINDEX without CONCURRENTLY blocks writes to the table while it runs',
        });
      }
    }
    if (action.kind === 'setting' && action.scope === 'system') {
      const row = await this.#runner.row(
        'SELECT context FROM pg_catalog.pg_settings WHERE name = $1',
        [action.name.toLowerCase()],
      );
      if (row?.['context'] === 'postmaster') {
        notices.push({
          level: 'warning',
          message: `${action.name} takes effect only after a server restart`,
        });
      }
    }
    if (action.kind === 'alterAccount' && action.rename && action.options.password === undefined) {
      notices.push({
        level: 'info',
        message: 'Renaming a role clears an MD5 password; set the password again if it uses one',
      });
    }
    return {
      ...describePgAction(action),
      statements: statements.map((s) => s.shown),
      notices,
    };
  }

  async run(action: ServerAction, options: { signal?: AbortSignal } = {}): Promise<ActionResult> {
    const started = performance.now();
    const statements = await this.#statements(action);
    const messages: ServerNotice[] = [];
    for (const [index, stmt] of statements.entries()) {
      let output;
      try {
        output = await this.#runner.runStatement(stmt, options.signal);
      } catch (error) {
        // The configuration was saved; only the reload that applies it failed.
        if (action.kind === 'setting' && action.scope === 'system' && index > 0) {
          messages.push({
            level: 'warning',
            message: `Saved to postgresql.auto.conf, but reloading the configuration failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
            hint: 'Reload it with SELECT pg_reload_conf() as a superuser, or restart the server',
          });
          break;
        }
        throw enrichPgError(error, action);
      }
      messages.push(...output.notices);
      if (action.kind === 'session' && output.rows[0]?.[output.columns[0] ?? ''] === false) {
        messages.push({
          level: 'warning',
          message: `Process ${action.id} was not signalled: it has ended, or it is not a server process`,
        });
      }
    }
    if (messages.length === 0) {
      messages.push({ level: 'info', message: `${describePgAction(action).done}.` });
    }
    return {
      statements: statements.map((s) => s.shown),
      messages,
      table: null,
      durationMs: Math.round(performance.now() - started),
    };
  }
}

/** Specific hints for the privileges and prerequisites an action needs. */
export function enrichPgError(error: unknown, action: ServerAction): unknown {
  switch (action.kind) {
    case 'session':
      return withHint(
        error,
        ['42501'],
        "Signalling another role's session needs membership in that role or in pg_signal_backend; superuser sessions need a superuser",
      );
    case 'setting':
      return withHint(
        error,
        ['42501'],
        action.scope === 'system'
          ? "ALTER SYSTEM needs a superuser (or, from PostgreSQL 15, the ALTER SYSTEM privilege on the parameter); on a managed service use the provider's parameter settings"
          : action.scope === 'database'
            ? 'ALTER DATABASE ... SET needs the database owner; superuser-only settings need a superuser'
            : 'This setting can only be changed by a superuser',
      );
    case 'topQueries':
      return withHint(
        error,
        ['42501'],
        action.operation === 'reset'
          ? 'Resetting pg_stat_statements needs a superuser or EXECUTE on pg_stat_statements_reset()'
          : 'Creating pg_stat_statements needs a superuser',
      );
    default:
      return withHint(error, ['42501'], PRIVILEGE_HINT);
  }
}

/** The confirmation's title and summary, and the result line, of an action. */
export function describePgAction(action: ServerAction): {
  title: string;
  summary: string;
  done: string;
} {
  switch (action.kind) {
    case 'session':
      return action.operation === 'cancel'
        ? {
            title: `Cancel the query of session ${action.id}?`,
            summary: 'The running statement is cancelled; the session stays connected.',
            done: `Sent a cancel request to process ${action.id}`,
          }
        : {
            title: `Terminate session ${action.id}?`,
            summary: 'The session is disconnected and its open transaction rolls back.',
            done: `Terminated process ${action.id}`,
          };
    case 'maintenance': {
      const names = action.targets.map((t) => `${t.container}.${t.name}`).join(', ');
      return {
        title: `Run ${action.operation.toUpperCase()}?`,
        summary: `On ${names}.`,
        done: `${action.operation.toUpperCase()} finished on ${action.targets.length} ${
          action.targets.length === 1 ? 'table' : 'tables'
        }`,
      };
    }
    case 'setting':
      return {
        title: action.value === null ? `Reset ${action.name}?` : `Change ${action.name}?`,
        summary:
          action.value === null
            ? `${action.name} goes back to its default (${action.scope}).`
            : `${action.name} becomes ${action.value} (${action.scope}).`,
        done: action.value === null ? `Reset ${action.name}` : `Set ${action.name}`,
      };
    case 'topQueries':
      return action.operation === 'reset'
        ? {
            title: 'Reset the statement statistics?',
            summary: 'Every statement statistic collected by pg_stat_statements is discarded.',
            done: 'The statement statistics were reset',
          }
        : {
            title: 'Create the pg_stat_statements extension?',
            summary: 'Installs the extension in this database.',
            done: 'pg_stat_statements was created',
          };
    case 'createAccount':
      return {
        title: `Create ${action.role ? 'role' : 'user'} ${action.account.name}?`,
        summary: 'A new role is created with the attributes below.',
        done: `Created ${action.account.name}`,
      };
    case 'alterAccount':
      return {
        title: `Change ${action.account.name}?`,
        summary: 'The role is altered as below.',
        done: `Changed ${action.account.name}`,
      };
    case 'dropAccount':
      return {
        title: `Drop ${action.account.name}?`,
        summary:
          'The role is removed. It fails while the role owns objects or holds privileges (REASSIGN OWNED and DROP OWNED clear them).',
        done: `Dropped ${action.account.name}`,
      };
    case 'grant':
    case 'revoke':
      return {
        title: `${action.kind === 'grant' ? 'Grant' : 'Revoke'} ${action.privileges.join(', ')}?`,
        summary: `${action.kind === 'grant' ? 'To' : 'From'} ${action.grantee.name}.`,
        done: `${action.kind === 'grant' ? 'Granted' : 'Revoked'} ${action.privileges.join(', ')}`,
      };
    case 'grantRole':
    case 'revokeRole':
      return {
        title:
          action.kind === 'grantRole'
            ? `Grant ${action.role.name} to ${action.member.name}?`
            : `Revoke ${action.role.name} from ${action.member.name}?`,
        summary: 'Changes role membership.',
        done: action.kind === 'grantRole' ? 'Granted the role' : 'Revoked the role',
      };
    case 'defaultPrivileges':
      return {
        title: 'Change default privileges?',
        summary: `Applies to ${action.objectType} created later${
          action.owner ? ` by ${action.owner}` : ''
        }${action.schema ? ` in ${action.schema}` : ''}; existing objects keep their grants.`,
        done: 'Changed the default privileges',
      };
    case 'createPolicy':
      return {
        title: `Create policy ${action.name}?`,
        summary: `On ${action.schema}.${action.table}. It filters rows only while row-level security is enabled on the table.`,
        done: `Created policy ${action.name}`,
      };
    case 'dropPolicy':
      return {
        title: `Drop policy ${action.name}?`,
        summary: `From ${action.schema}.${action.table}.`,
        done: `Dropped policy ${action.name}`,
      };
    case 'rowSecurity':
      return {
        title: `${action.enabled ? 'Enable' : 'Disable'} row-level security on ${action.table}?`,
        summary: action.enabled
          ? 'Rows become visible only through policies (a table without policies shows no rows to other roles).'
          : 'Policies stop applying: every role with table privileges sees every row.',
        done: `Row-level security ${action.enabled ? 'enabled' : 'disabled'}`,
      };
    case 'profiler':
      return { title: 'Profiler', summary: '', done: '' };
  }
}

/** The server tools of a PostgreSQL session. */
export function createPostgresServerTools(session: Session): ServerTools {
  return new PostgresServerTools(session);
}
