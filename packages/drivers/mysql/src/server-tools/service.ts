import {
  JoineryError,
  atLeast,
  type AccessDetails,
  type AccessOverview,
  type AccountRef,
  type ActionPreview,
  type ActionResult,
  type GrantMatrix,
  type GrantRow,
  type GrantState,
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
  type ToolTable,
  type TopQueries,
  type TopQueryOptions,
  type TopQueryOrder,
} from '@joinery/core';
import type { Row } from '@joinery/driver-sql-base';

import {
  MYSQL_SESSION_DETAIL_COLUMNS,
  cellOf,
  mariadbSetting,
  mysqlAccounts,
  mysqlMonitorSnapshot,
  mysqlSession,
  mysqlSetting,
  mysqlTopQuery,
  nameValueMap,
  numberOrNull,
  pick,
  textOrNull,
  yes,
} from './read';
import { SqlRunner, withHint, type ToolStatement } from './runner';
import {
  accountStatements,
  grantStatement,
  killStatement,
  maintenanceStatement,
  membershipStatement,
  privilegesFor,
  settingStatement,
  threadIdOf,
  topQueriesStatement,
  type Flavor,
} from './statements';

/**
 * MySQL and MariaDB server tools (spec §15): global status, queries per second, threads, the
 * InnoDB buffer pool and replica lag for the monitor; the process list with KILL QUERY and KILL
 * CONNECTION; performance_schema statement digests; users, roles and the grants matrix;
 * ANALYZE, OPTIMIZE, CHECK and REPAIR TABLE; system variables with SET GLOBAL (and SET PERSIST
 * on MySQL). The flavor comes from the server's version banner, not the profile, so a MariaDB
 * server behind a MySQL profile still gets MariaDB statements.
 */

interface MysqlFacts {
  readonly flavor: Flavor;
  readonly version: string;
  readonly user: string;
  readonly database: string | null;
  readonly connectionId: string;
  readonly performanceSchema: boolean;
  readonly databases: readonly string[];
  /** Global privileges of the current account, upper case; ALL PRIVILEGES expanded to '*'. */
  readonly privileges: ReadonlySet<string>;
}

const SYSTEM_DATABASES = new Set(['information_schema', 'performance_schema']);

const MAINTENANCE: readonly MaintenanceOperationInfo[] = [
  {
    id: 'analyze',
    label: 'ANALYZE TABLE',
    description: 'Updates the index statistics the optimizer uses.',
    multiple: true,
    options: [
      {
        id: 'local',
        label: 'NO_WRITE_TO_BINLOG',
        description: 'Keeps the statement out of the binary log (replicas do not run it).',
      },
    ],
  },
  {
    id: 'optimize',
    label: 'OPTIMIZE TABLE',
    description: 'Rebuilds the table to reclaim unused space and defragment it.',
    multiple: true,
    options: [
      {
        id: 'local',
        label: 'NO_WRITE_TO_BINLOG',
        description: 'Keeps the statement out of the binary log.',
      },
    ],
  },
  {
    id: 'check',
    label: 'CHECK TABLE',
    description: 'Checks the table and its indexes for errors.',
    multiple: true,
    options: [
      { id: 'quick', label: 'QUICK', description: 'Skips scanning rows for incorrect links.' },
      { id: 'fast', label: 'FAST', description: 'Only tables not closed properly.' },
      {
        id: 'medium',
        label: 'MEDIUM',
        description: 'Also checks deleted links and key checksums.',
      },
      { id: 'extended', label: 'EXTENDED', description: 'A full key lookup for every row (slow).' },
      { id: 'changed', label: 'CHANGED', description: 'Only tables changed since the last check.' },
    ],
  },
  {
    id: 'repair',
    label: 'REPAIR TABLE',
    description: 'Repairs a corrupted MyISAM, Aria, ARCHIVE or CSV table (not InnoDB).',
    multiple: true,
    options: [
      {
        id: 'local',
        label: 'NO_WRITE_TO_BINLOG',
        description: 'Keeps the statement out of the binary log.',
      },
      { id: 'quick', label: 'QUICK', description: 'Repairs only the index tree.' },
      { id: 'extended', label: 'EXTENDED', description: 'Rebuilds the index row by row.' },
      {
        id: 'use_frm',
        label: 'USE_FRM',
        description: 'Recreates the index file from the table definition.',
      },
    ],
  },
];

const PRIVILEGE_ERRORS = [1044, 1142, 1143, 1227, 1370, 3530];

function notSupported(message: string): JoineryError {
  return new JoineryError({ code: 'NOT_SUPPORTED', message });
}

/** Global privileges named by SHOW GRANTS lines on *.*. */
export function globalPrivileges(lines: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (const line of lines) {
    const match = /^GRANT (.+?) ON \*\.\* TO /i.exec(line.trim());
    if (!match) continue;
    for (const privilege of match[1]!.split(',')) {
      const name = privilege.trim().toUpperCase();
      out.add(name === 'ALL PRIVILEGES' || name === 'ALL' ? '*' : name);
    }
  }
  return out;
}

export class MysqlServerTools implements ServerTools {
  readonly #runner: SqlRunner;
  #facts: Promise<MysqlFacts> | undefined;

  constructor(session: Session) {
    if (session.engine !== 'mysql' && session.engine !== 'mariadb') {
      throw notSupported('This is not a MySQL or MariaDB session');
    }
    this.#runner = new SqlRunner(session);
  }

  #loadFacts(): Promise<MysqlFacts> {
    this.#facts ??= (async () => {
      const row =
        (await this.#runner.row(
          'SELECT VERSION() AS version, CURRENT_USER() AS usr, DATABASE() AS db, CONNECTION_ID() AS id, @@performance_schema AS ps',
        )) ?? {};
      const version = textOrNull(row['version']) ?? '';
      const databases = (await this.#runner.rows('SHOW DATABASES'))
        .map((r) => textOrNull(Object.values(r)[0]) ?? '')
        .filter((name) => name !== '');
      const grants = await this.#runner.rows('SHOW GRANTS').catch(() => [] as Row[]);
      return {
        flavor: /mariadb/i.test(version) ? 'mariadb' : 'mysql',
        version,
        user: textOrNull(row['usr']) ?? '',
        database: textOrNull(row['db']),
        connectionId: textOrNull(row['id']) ?? '',
        performanceSchema: yes(row['ps']),
        databases,
        privileges: globalPrivileges(grants.map((g) => textOrNull(Object.values(g)[0]) ?? '')),
      } satisfies MysqlFacts;
    })();
    this.#facts.catch(() => (this.#facts = undefined));
    return this.#facts;
  }

  #has(facts: MysqlFacts, ...privileges: string[]): boolean {
    return facts.privileges.has('*') || privileges.some((p) => facts.privileges.has(p));
  }

  async info(): Promise<ServerToolsInfo> {
    const facts = await this.#loadFacts();
    const mariadb = facts.flavor === 'mariadb';
    const notices: ServerNotice[] = [];
    if (!this.#has(facts, 'PROCESS')) {
      notices.push({
        level: 'info',
        message: "Only this account's own threads are listed",
        hint: 'The PROCESS privilege shows every thread',
      });
    }
    if (!this.#has(facts, 'SUPER', 'CONNECTION_ADMIN', 'CONNECTION ADMIN')) {
      notices.push({
        level: 'info',
        message: 'This account can kill only its own threads',
        hint: mariadb
          ? 'CONNECTION ADMIN or SUPER allows killing other threads'
          : 'CONNECTION_ADMIN or SUPER allows killing other threads; managed services often offer a stored procedure instead',
      });
    }
    if (!this.#has(facts, 'SUPER', 'SYSTEM_VARIABLES_ADMIN', 'SYSTEM VARIABLES ADMIN')) {
      notices.push({
        level: 'info',
        message: 'This account cannot change global variables',
        hint: mariadb
          ? 'SET GLOBAL needs SUPER or SYSTEM VARIABLES ADMIN; on a managed service use its parameter settings'
          : 'SET GLOBAL needs SYSTEM_VARIABLES_ADMIN or SUPER; on a managed service use its parameter settings',
      });
    }
    return {
      engine: facts.flavor,
      product: mariadb ? 'MariaDB' : 'MySQL',
      version: facts.version,
      user: facts.user,
      database: facts.database,
      databases: facts.databases,
      perDatabaseSessions: false,
      sessionActions: [
        {
          operation: 'cancel',
          label: 'Kill query',
          description: 'KILL QUERY: stops the running statement; the connection stays.',
        },
        {
          operation: 'terminate',
          label: 'Kill connection',
          description: 'KILL CONNECTION: closes the connection; its open transaction rolls back.',
        },
      ],
      maintenance: MAINTENANCE,
      settingScopes: [
        {
          scope: 'global',
          label: 'Server (SET GLOBAL)',
          description: 'New sessions get the value; it is lost when the server restarts.',
        },
        ...(mariadb
          ? []
          : [
              {
                scope: 'persist' as const,
                label: 'Server, persisted (SET PERSIST)',
                description: 'Like SET GLOBAL, and kept in mysqld-auto.cnf across restarts.',
              },
            ]),
        {
          scope: 'session',
          label: 'This session (SET SESSION)',
          description: "Only the server tools' own connection; handy to try a value.",
        },
      ],
      topQueryOrders: ['total', 'mean', 'calls', 'rows', 'max'],
      access: ['hosts', 'roles', 'membership', 'grants', 'lock'],
      notices,
    };
  }

  async monitor(): Promise<MonitorSnapshot> {
    const facts = await this.#loadFacts();
    const at = Date.now();
    const status = nameValueMap(await this.#runner.rows('SHOW GLOBAL STATUS'));
    const variables = nameValueMap(
      await this.#runner.rows(
        "SHOW GLOBAL VARIABLES WHERE Variable_name IN ('max_connections', 'innodb_buffer_pool_size', 'long_query_time')",
      ),
    );
    const replicaSql =
      facts.flavor === 'mariadb'
        ? 'SHOW ALL SLAVES STATUS'
        : atLeast(facts.version, '8.0.22')
          ? 'SHOW REPLICA STATUS'
          : 'SHOW SLAVE STATUS';
    const replicas = await this.#runner.rows(replicaSql).catch(() => null);
    return mysqlMonitorSnapshot(at, { status, variables, replicas, notices: [] });
  }

  async sessions(options: SessionListOptions = {}): Promise<SessionList> {
    const facts = await this.#loadFacts();
    const limit = Math.max(1, Math.min(options.limit ?? 1000, 10_000));
    const rows =
      facts.flavor === 'mariadb'
        ? await this.#runner.rows(
            `SELECT ID, USER, HOST, DB, COMMAND, TIME, TIME_MS, STATE, INFO, PROGRESS, MEMORY_USED,
              EXAMINED_ROWS, QUERY_ID
            FROM information_schema.PROCESSLIST ORDER BY ID`,
          )
        : await this.#runner.rows('SHOW FULL PROCESSLIST');
    const blockers = new Map<string, string[]>();
    const waiting = rows.some((r) => /lock/i.test(textOrNull(pick(r, 'State', 'STATE')) ?? ''));
    if (waiting) {
      const sql =
        facts.flavor === 'mariadb'
          ? `SELECT r.trx_mysql_thread_id AS waiting_pid, b.trx_mysql_thread_id AS blocking_pid
            FROM information_schema.INNODB_LOCK_WAITS w
              JOIN information_schema.INNODB_TRX r ON r.trx_id = w.requesting_trx_id
              JOIN information_schema.INNODB_TRX b ON b.trx_id = w.blocking_trx_id`
          : 'SELECT waiting_pid, blocking_pid FROM sys.innodb_lock_waits';
      for (const row of await this.#runner.rows(sql).catch(() => [] as Row[])) {
        const waiter = textOrNull(row['waiting_pid']) ?? '';
        blockers.set(waiter, [
          ...(blockers.get(waiter) ?? []),
          textOrNull(row['blocking_pid']) ?? '',
        ]);
      }
    }
    const all = rows
      .map((row) => mysqlSession(row, facts.connectionId, blockers))
      .filter(
        (s) =>
          ((options.includeIdle ?? true) ? true : !s.idle) &&
          ((options.includeBackground ?? false) ? true : !s.background),
      );
    const notices: ServerNotice[] = [];
    if (!this.#has(facts, 'PROCESS')) {
      notices.push({
        level: 'info',
        message: "Only this account's own threads are listed",
        hint: 'The PROCESS privilege shows every thread',
      });
    }
    return {
      sessions: all.slice(0, limit),
      detailColumns: MYSQL_SESSION_DETAIL_COLUMNS,
      notices,
      truncated: all.length > limit,
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
    if (!facts.performanceSchema) {
      return {
        ...base,
        unavailable: {
          reason: 'disabled',
          message: 'performance_schema is off on this server, so there are no statement digests',
          hint: `Set performance_schema=ON in the server's option file and restart it (it cannot be turned on at runtime)${
            facts.flavor === 'mariadb' ? '; MariaDB ships with it off' : ''
          }`,
        },
      };
    }
    try {
      const consumer = await this.#runner.row(
        "SELECT ENABLED FROM performance_schema.setup_consumers WHERE NAME = 'statements_digest'",
      );
      if (consumer && !yes(consumer['ENABLED'])) {
        return {
          ...base,
          unavailable: {
            reason: 'disabled',
            message: 'The statements_digest consumer of performance_schema is off',
            hint: 'Turn it on here (it needs UPDATE on performance_schema.setup_consumers); it resets at restart unless set in the option file',
            fix: { kind: 'topQueries', operation: 'enable' },
          },
        };
      }
      const order: Record<TopQueryOrder, string> = {
        total: 'SUM_TIMER_WAIT',
        mean: 'AVG_TIMER_WAIT',
        calls: 'COUNT_STAR',
        rows: 'SUM_ROWS_SENT',
        max: 'MAX_TIMER_WAIT',
      };
      const limit = Math.max(1, Math.min(Math.floor(options.limit ?? 100), 1000));
      const sample = facts.flavor === 'mysql' && atLeast(facts.version, '8.0.3');
      const rows = await this.#runner.rows(
        `SELECT SCHEMA_NAME, DIGEST, DIGEST_TEXT, COUNT_STAR,
          SUM_TIMER_WAIT / 1000000000 AS total_ms, AVG_TIMER_WAIT / 1000000000 AS mean_ms,
          MAX_TIMER_WAIT / 1000000000 AS max_ms, SUM_ROWS_SENT, SUM_ROWS_EXAMINED,
          SUM_ROWS_AFFECTED, SUM_NO_INDEX_USED, SUM_CREATED_TMP_DISK_TABLES, LAST_SEEN
          ${sample ? ', QUERY_SAMPLE_TEXT' : ''}
        FROM performance_schema.events_statements_summary_by_digest
        WHERE DIGEST_TEXT IS NOT NULL
        ORDER BY ${order[options.orderBy ?? 'total']} DESC LIMIT ${limit}`,
      );
      return {
        ...base,
        unavailable: null,
        queries: rows.map(mysqlTopQuery),
        resettable: true,
        detailColumns: [
          { key: 'rowsExamined', label: 'Rows examined', unit: 'count' },
          { key: 'rowsAffected', label: 'Rows affected', unit: 'count' },
          { key: 'noIndex', label: 'Without index', unit: 'count' },
          { key: 'tmpDisk', label: 'Temp tables on disk', unit: 'count' },
          { key: 'lastSeen', label: 'Last seen', unit: 'time' },
          ...(sample ? [{ key: 'sample', label: 'Sample' } as const] : []),
        ],
      };
    } catch (error) {
      if (error instanceof JoineryError && PRIVILEGE_ERRORS.includes(Number(error.engineCode))) {
        return {
          ...base,
          unavailable: {
            reason: 'no-privilege',
            message: 'This account cannot read performance_schema',
            hint: 'Grant SELECT on performance_schema.* to read statement digests',
          },
        };
      }
      throw error;
    }
  }

  async accounts(): Promise<AccessOverview> {
    const facts = await this.#loadFacts();
    try {
      if (facts.flavor === 'mariadb') {
        const users = await this.#runner
          .rows(
            `SELECT u.User AS user, u.Host AS host, u.is_role, u.password_expired, u.plugin,
              u.max_user_connections, u.Super_priv, JSON_VALUE(g.Priv, '$.account_locked') AS locked
            FROM mysql.user u LEFT JOIN mysql.global_priv g ON g.User = u.User AND g.Host = u.Host
            ORDER BY u.User, u.Host`,
          )
          .catch(() =>
            this.#runner.rows(
              `SELECT User AS user, Host AS host, is_role, password_expired, plugin,
                max_user_connections, Super_priv FROM mysql.user ORDER BY User, Host`,
            ),
          );
        const grants = await this.#runner.rows(
          'SELECT Host, User, Role, Admin_option FROM mysql.roles_mapping',
        );
        return { accounts: mysqlAccounts(users, grants, 'mariadb'), notices: [] };
      }
      const users = await this.#runner.rows(
        `SELECT User AS user, Host AS host, account_locked, password_expired, plugin,
          authentication_string = '' AS no_password, max_user_connections, Super_priv
        FROM mysql.user ORDER BY User, Host`,
      );
      const edges = await this.#runner.rows(
        'SELECT FROM_USER, FROM_HOST, TO_USER, TO_HOST, WITH_ADMIN_OPTION FROM mysql.role_edges',
      );
      return { accounts: mysqlAccounts(users, edges, 'mysql'), notices: [] };
    } catch (error) {
      if (error instanceof JoineryError && PRIVILEGE_ERRORS.includes(Number(error.engineCode))) {
        return {
          accounts: [],
          notices: [
            {
              level: 'warning',
              message: 'This account cannot list accounts',
              hint: 'Listing users and roles needs SELECT on the mysql system database',
            },
          ],
        };
      }
      throw error;
    }
  }

  async grants(grantee: AccountRef, scope?: string): Promise<GrantMatrix> {
    const facts = await this.#loadFacts();
    const databases = facts.databases.filter((d) => !SYSTEM_DATABASES.has(d));
    const database =
      scope ??
      (facts.database && databases.includes(facts.database) ? facts.database : databases[0]);
    if (scope !== undefined && !databases.includes(scope)) {
      throw new JoineryError({ code: 'NOT_FOUND', message: `There is no database "${scope}"` });
    }
    const hostless = grantee.host === undefined || grantee.host === '';
    const quote = (text: string): string => `'${text.replaceAll("'", "''")}'`;
    const granteeText =
      facts.flavor === 'mariadb' && hostless
        ? quote(grantee.name)
        : `${quote(grantee.name)}@${quote(hostless ? '%' : grantee.host!)}`;
    const privileges = privilegesFor(facts.flavor);
    const globalRows = await this.#runner.rows(
      'SELECT PRIVILEGE_TYPE, IS_GRANTABLE FROM information_schema.USER_PRIVILEGES WHERE GRANTEE = ?',
      [granteeText],
    );
    const held = (rows: readonly Row[]): Map<string, boolean> =>
      new Map(
        rows
          .map((r) => [textOrNull(r['PRIVILEGE_TYPE']) ?? '', yes(r['IS_GRANTABLE'])] as const)
          .filter(([p]) => p !== 'USAGE'),
      );
    const global = held(globalRows);
    const globalColumns = [...(privileges.global ?? [])];
    for (const privilege of global.keys()) {
      if (!globalColumns.includes(privilege)) globalColumns.push(privilege);
    }
    const state = (
      privilege: string,
      own: ReadonlyMap<string, boolean>,
      wider: readonly ReadonlyMap<string, boolean>[],
    ): GrantState =>
      own.has(privilege)
        ? own.get(privilege)
          ? 'grantable'
          : 'granted'
        : wider.some((w) => w.has(privilege))
          ? 'implied'
          : 'none';
    const rows: GrantRow[] = [
      {
        object: { kind: 'global' },
        label: '*.*',
        type: 'server',
        privileges: Object.fromEntries(globalColumns.map((p) => [p, state(p, global, [])])),
      },
    ];
    if (database !== undefined) {
      const dbGrants = held(
        await this.#runner.rows(
          `SELECT PRIVILEGE_TYPE, IS_GRANTABLE FROM information_schema.SCHEMA_PRIVILEGES
          WHERE GRANTEE = ? AND TABLE_SCHEMA = ?`,
          [granteeText, database],
        ),
      );
      rows.push({
        object: { kind: 'database', name: database },
        label: `${database}.*`,
        type: 'database',
        privileges: Object.fromEntries(
          (privileges.database ?? []).map((p) => [p, state(p, dbGrants, [global])]),
        ),
      });
      const tableGrants = new Map<string, Map<string, boolean>>();
      for (const r of await this.#runner.rows(
        `SELECT TABLE_NAME, PRIVILEGE_TYPE, IS_GRANTABLE FROM information_schema.TABLE_PRIVILEGES
        WHERE GRANTEE = ? AND TABLE_SCHEMA = ?`,
        [granteeText, database],
      )) {
        const table = textOrNull(r['TABLE_NAME']) ?? '';
        const map = tableGrants.get(table) ?? new Map<string, boolean>();
        map.set(textOrNull(r['PRIVILEGE_TYPE']) ?? '', yes(r['IS_GRANTABLE']));
        tableGrants.set(table, map);
      }
      const tables = await this.#runner.rows(
        `SELECT TABLE_NAME, TABLE_TYPE FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?
        ORDER BY TABLE_NAME LIMIT 2000`,
        [database],
      );
      for (const t of tables) {
        const name = textOrNull(t['TABLE_NAME']) ?? '';
        const own = tableGrants.get(name) ?? new Map<string, boolean>();
        rows.push({
          object: { kind: 'table', database, name },
          label: `${database}.${name}`,
          type: textOrNull(t['TABLE_TYPE']) === 'VIEW' ? 'view' : 'table',
          privileges: Object.fromEntries(
            (privileges.table ?? []).map((p) => [p, state(p, own, [global, dbGrants])]),
          ),
        });
      }
    }
    const notices: ServerNotice[] = [];
    if (globalRows.length === 0) {
      notices.push({
        level: 'info',
        message: `No grants of ${granteeText} are visible`,
        hint: 'The account may not exist, or this account may see only its own grants (SELECT on mysql.* shows all)',
      });
    }
    return {
      grantee,
      scope: database ?? null,
      scopes: databases,
      privileges: {
        global: globalColumns,
        database: privileges.database!,
        table: privileges.table!,
      },
      rows,
      notices,
    };
  }

  accessDetails(): Promise<AccessDetails> {
    return Promise.reject(
      notSupported('MySQL and MariaDB have no default privileges or row-level security policies'),
    );
  }

  async maintenanceTargets(container?: string): Promise<MaintenanceTargets> {
    const facts = await this.#loadFacts();
    const databases = facts.databases.filter((d) => !SYSTEM_DATABASES.has(d));
    const database =
      container ??
      (facts.database && databases.includes(facts.database) ? facts.database : databases[0]);
    const rows =
      database === undefined
        ? []
        : await this.#runner.rows(
            `SELECT TABLE_NAME, ENGINE, TABLE_ROWS, DATA_LENGTH, INDEX_LENGTH, DATA_FREE,
              UPDATE_TIME, CHECK_TIME, TABLE_TYPE
            FROM information_schema.TABLES
            WHERE TABLE_SCHEMA = ? AND TABLE_TYPE <> 'VIEW'
            ORDER BY TABLE_NAME LIMIT 5000`,
            [database],
          );
    return {
      containers: databases,
      container: database ?? null,
      targets: rows.map((r) => ({
        container: database!,
        name: textOrNull(r['TABLE_NAME']) ?? '',
        type: 'table',
        indexes: [],
        detail: {
          engine: textOrNull(r['ENGINE']),
          rows: numberOrNull(r['TABLE_ROWS']),
          data: numberOrNull(r['DATA_LENGTH']),
          index: numberOrNull(r['INDEX_LENGTH']),
          free: numberOrNull(r['DATA_FREE']),
          updated: textOrNull(r['UPDATE_TIME']),
          checked: textOrNull(r['CHECK_TIME']),
        },
      })),
      detailColumns: [
        { key: 'engine', label: 'Engine' },
        { key: 'rows', label: 'Rows (est.)', unit: 'count' },
        { key: 'data', label: 'Data', unit: 'bytes' },
        { key: 'index', label: 'Indexes', unit: 'bytes' },
        { key: 'free', label: 'Free', unit: 'bytes' },
        { key: 'updated', label: 'Updated', unit: 'time' },
        { key: 'checked', label: 'Checked', unit: 'time' },
      ],
      notices: [],
    };
  }

  async settings(): Promise<SettingList> {
    const facts = await this.#loadFacts();
    const notices: ServerNotice[] = [];
    if (!this.#has(facts, 'SUPER', 'SYSTEM_VARIABLES_ADMIN', 'SYSTEM VARIABLES ADMIN')) {
      notices.push({
        level: 'info',
        message: 'This account cannot change global variables',
        hint: "SET GLOBAL needs SYSTEM_VARIABLES_ADMIN or SUPER; on a managed service use the provider's parameter settings",
      });
    }
    if (facts.flavor === 'mariadb') {
      const rows = await this.#runner.rows(
        `SELECT VARIABLE_NAME, SESSION_VALUE, GLOBAL_VALUE, GLOBAL_VALUE_ORIGIN, DEFAULT_VALUE,
          VARIABLE_SCOPE, VARIABLE_TYPE, VARIABLE_COMMENT, NUMERIC_MIN_VALUE, NUMERIC_MAX_VALUE,
          ENUM_VALUE_LIST, READ_ONLY
        FROM information_schema.SYSTEM_VARIABLES ORDER BY VARIABLE_NAME`,
      );
      return { settings: rows.map(mariadbSetting), notices };
    }
    const rows = await this.#runner.rows('SHOW GLOBAL VARIABLES');
    const info = new Map<string, Row>();
    if (facts.performanceSchema) {
      const infoRows = await this.#runner
        .rows(
          'SELECT VARIABLE_NAME, VARIABLE_SOURCE, MIN_VALUE, MAX_VALUE FROM performance_schema.variables_info',
        )
        .catch(() => [] as Row[]);
      for (const r of infoRows) info.set((textOrNull(r['VARIABLE_NAME']) ?? '').toLowerCase(), r);
    }
    const persist = atLeast(facts.version, '8.0.0');
    return {
      settings: rows.map((row) =>
        mysqlSetting(
          row,
          info.get((textOrNull(row['Variable_name']) ?? '').toLowerCase()),
          persist,
        ),
      ),
      notices,
    };
  }

  // ----------------------------------------------------------------------------- actions

  async #statements(action: ServerAction): Promise<ToolStatement[]> {
    const facts = await this.#loadFacts();
    const flavor = facts.flavor;
    switch (action.kind) {
      case 'session':
        if (String(threadIdOf(action.id)) === facts.connectionId) {
          throw new JoineryError({
            code: 'VALIDATION_FAILED',
            message: "This is the server tools' own connection",
          });
        }
        return [killStatement(action.operation, action.id)];
      case 'maintenance':
        return [maintenanceStatement(action)];
      case 'setting':
        return [settingStatement(action, flavor)];
      case 'topQueries':
        return [topQueriesStatement(action.operation)];
      case 'createAccount':
      case 'alterAccount':
      case 'dropAccount':
        return accountStatements(action, flavor);
      case 'grantRole':
      case 'revokeRole':
        return [membershipStatement(action, flavor)];
      case 'grant':
      case 'revoke':
        return [grantStatement(action, flavor)];
      case 'defaultPrivileges':
      case 'createPolicy':
      case 'dropPolicy':
      case 'rowSecurity':
        throw notSupported(
          'MySQL and MariaDB have no default privileges or row-level security policies',
        );
      case 'profiler':
        throw notSupported('Use the statement digests of performance_schema');
    }
  }

  async preview(action: ServerAction): Promise<ActionPreview> {
    const facts = await this.#loadFacts();
    const statements = await this.#statements(action);
    const notices: ServerNotice[] = [];
    if (action.kind === 'maintenance' && action.operation === 'optimize') {
      notices.push({
        level: 'warning',
        message: 'For InnoDB, OPTIMIZE TABLE rebuilds the whole table (ALTER TABLE ... FORCE)',
      });
    }
    if (action.kind === 'maintenance' && action.operation === 'repair') {
      notices.push({
        level: 'info',
        message:
          'InnoDB tables do not support REPAIR TABLE; it is for MyISAM, Aria, ARCHIVE and CSV',
      });
    }
    if (action.kind === 'setting' && action.scope === 'global') {
      notices.push({
        level: 'info',
        message:
          facts.flavor === 'mariadb'
            ? 'The value is lost when the server restarts; put it in the option file to keep it'
            : 'The value is lost when the server restarts; SET PERSIST keeps it',
      });
    }
    if (action.kind === 'grantRole' && facts.flavor === 'mysql') {
      notices.push({
        level: 'info',
        message:
          'A granted role takes effect in a session after SET ROLE, or once it is a default role (SET DEFAULT ROLE)',
      });
    }
    return {
      ...describeMysqlAction(action),
      statements: statements.map((s) => s.shown),
      notices,
    };
  }

  async run(action: ServerAction, options: { signal?: AbortSignal } = {}): Promise<ActionResult> {
    const started = performance.now();
    const facts = await this.#loadFacts();
    const statements = await this.#statements(action);
    const messages: ServerNotice[] = [];
    let table: ToolTable | null = null;
    for (const stmt of statements) {
      let output;
      try {
        output = await this.#runner.runStatement(stmt, options.signal);
      } catch (error) {
        throw enrichMysqlError(error, action, facts.flavor);
      }
      messages.push(...output.notices);
      if (output.columns.length > 0) {
        table = {
          columns: output.columns.map((name) => ({ key: name, label: name })),
          rows: output.rows.map((row) =>
            Object.fromEntries(output.columns.map((name) => [name, cellOf(row[name])])),
          ),
        };
        for (const row of output.rows) {
          const type = (textOrNull(pick(row, 'Msg_type')) ?? '').toLowerCase();
          if (type === 'error' || type === 'warning') {
            messages.push({
              level: type,
              message: `${textOrNull(pick(row, 'Table')) ?? ''}: ${textOrNull(pick(row, 'Msg_text')) ?? ''}`,
            });
          }
        }
      }
    }
    messages.unshift({ level: 'info', message: `${describeMysqlAction(action).done}.` });
    return {
      statements: statements.map((s) => s.shown),
      messages,
      table,
      durationMs: Math.round(performance.now() - started),
    };
  }
}

/** Specific hints for the privileges an action needs and the server's refusals. */
export function enrichMysqlError(error: unknown, action: ServerAction, flavor: Flavor): unknown {
  const managed = 'managed services often refuse it; use the provider’s tools instead';
  switch (action.kind) {
    case 'session': {
      const unknown = withHint(error, [1094], 'The thread has ended; refresh the list');
      if (unknown !== error) return unknown;
      return withHint(
        error,
        [1095, 1227],
        flavor === 'mariadb'
          ? "Killing another account's thread needs CONNECTION ADMIN or SUPER"
          : `Killing another account's thread needs CONNECTION_ADMIN or SUPER; ${managed}`,
      );
    }
    case 'setting': {
      const readOnly = withHint(
        error,
        [1238],
        flavor === 'mariadb'
          ? 'A read-only variable changes only in the option file, with a restart'
          : 'A read-only variable changes only in the option file or with SET PERSIST_ONLY, with a restart',
      );
      if (readOnly !== error) return readOnly;
      const scope = withHint(
        error,
        [1228, 1229],
        'This variable exists only in the other scope: pick global or session',
      );
      if (scope !== error) return scope;
      return withHint(
        error,
        [1227],
        flavor === 'mariadb'
          ? `SET GLOBAL needs SUPER or SYSTEM VARIABLES ADMIN; ${managed}`
          : `SET GLOBAL needs SYSTEM_VARIABLES_ADMIN or SUPER; ${managed}`,
      );
    }
    case 'topQueries':
      return withHint(
        error,
        PRIVILEGE_ERRORS,
        action.operation === 'reset'
          ? 'Resetting the digests needs DROP on performance_schema.events_statements_summary_by_digest'
          : 'Turning the consumer on needs UPDATE on performance_schema.setup_consumers',
      );
    default:
      return withHint(
        error,
        PRIVILEGE_ERRORS,
        'This needs CREATE USER (or the privileges being granted, WITH GRANT OPTION)',
      );
  }
}

/** The confirmation's title and summary, and the result line, of an action. */
export function describeMysqlAction(action: ServerAction): {
  title: string;
  summary: string;
  done: string;
} {
  const account = (a: AccountRef): string =>
    a.host !== undefined && a.host !== '' ? `${a.name}@${a.host}` : a.name;
  switch (action.kind) {
    case 'session':
      return action.operation === 'cancel'
        ? {
            title: `Kill the query of thread ${action.id}?`,
            summary: 'The running statement stops; the connection stays open.',
            done: `Killed the query of thread ${action.id}`,
          }
        : {
            title: `Kill connection ${action.id}?`,
            summary: 'The connection is closed and its open transaction rolls back.',
            done: `Killed connection ${action.id}`,
          };
    case 'maintenance':
      return {
        title: `Run ${action.operation.toUpperCase()} TABLE?`,
        summary: `On ${action.targets.map((t) => `${t.container}.${t.name}`).join(', ')}.`,
        done: `${action.operation.toUpperCase()} TABLE finished`,
      };
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
            title: 'Reset the statement digests?',
            summary: 'Every statement statistic collected by performance_schema is discarded.',
            done: 'The statement digests were reset',
          }
        : {
            title: 'Turn on statement digests?',
            summary: 'Enables the statements_digest consumer of performance_schema.',
            done: 'Statement digests are on',
          };
    case 'createAccount':
      return {
        title: `Create ${action.role ? 'role' : 'user'} ${account(action.account)}?`,
        summary: action.role
          ? 'A new role, with no privileges yet.'
          : 'A new account, with no privileges yet.',
        done: `Created ${account(action.account)}`,
      };
    case 'alterAccount':
      return {
        title: `Change ${account(action.account)}?`,
        summary: 'The account is altered as below.',
        done: `Changed ${account(action.account)}`,
      };
    case 'dropAccount':
      return {
        title: `Drop ${account(action.account)}?`,
        summary:
          'The account and all its privileges are removed; its open connections stay until they end.',
        done: `Dropped ${account(action.account)}`,
      };
    case 'grant':
    case 'revoke':
      return {
        title: `${action.kind === 'grant' ? 'Grant' : 'Revoke'} ${
          action.privileges.join(', ') || 'GRANT OPTION'
        }?`,
        summary: `${action.kind === 'grant' ? 'To' : 'From'} ${account(action.grantee)}.`,
        done: action.kind === 'grant' ? 'Granted' : 'Revoked',
      };
    case 'grantRole':
    case 'revokeRole':
      return {
        title:
          action.kind === 'grantRole'
            ? `Grant ${account(action.role)} to ${account(action.member)}?`
            : `Revoke ${account(action.role)} from ${account(action.member)}?`,
        summary: 'Changes role membership.',
        done: action.kind === 'grantRole' ? 'Granted the role' : 'Revoked the role',
      };
    default:
      return { title: action.kind, summary: '', done: action.kind };
  }
}

/** The server tools of a MySQL or MariaDB session. */
export function createMysqlServerTools(session: Session): ServerTools {
  return new MysqlServerTools(session);
}
