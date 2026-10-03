import type {
  CellValue,
  MonitorSection,
  MonitorSnapshot,
  MonitorTile,
  RoleMembership,
  ServerAccount,
  ServerNotice,
  ServerSession,
  ServerSetting,
  SettingScope,
  ToolCell,
  TopQuery,
} from '@querybara/core';
import type { Row } from '@querybara/driver-sql-base';

import type { Flavor } from './statements';

/**
 * MySQL and MariaDB server tools: SHOW output, information_schema and performance_schema rows
 * turned into the engine-neutral shapes of @querybara/core. Pure, so they are tested with fixture
 * rows. Column names differ in case and wording between the two (Id/ID, Seconds_Behind_Source
 * and Seconds_Behind_Master), so rows are read through `pick`.
 */

export function numberOrNull(value: CellValue | unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

export function textOrNull(value: CellValue | unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'boolean') {
    return String(value);
  }
  return null;
}

/** 'Y', 'YES', 'ON', 1 and true. */
export function yes(value: CellValue | unknown): boolean {
  if (value === true || value === 1) return true;
  return typeof value === 'string' && /^(y|yes|on|true|1)$/i.test(value);
}

/** The first of `keys` present in the row (any letter case). */
export function pick(row: Row, ...keys: string[]): CellValue | undefined {
  for (const key of keys) {
    if (key in row) return row[key];
  }
  const lower = new Map(Object.keys(row).map((k) => [k.toLowerCase(), k]));
  for (const key of keys) {
    const found = lower.get(key.toLowerCase());
    if (found !== undefined) return row[found];
  }
  return undefined;
}

/** SHOW STATUS / SHOW VARIABLES rows as a name → value map. */
export function nameValueMap(rows: readonly Row[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const row of rows) {
    const name = textOrNull(pick(row, 'Variable_name', 'VARIABLE_NAME'));
    if (name !== null)
      map.set(name.toLowerCase(), textOrNull(pick(row, 'Value', 'VARIABLE_VALUE')) ?? '');
  }
  return map;
}

// ---------------------------------------------------------------------------------- monitor

export interface MysqlMonitorInput {
  readonly status: ReadonlyMap<string, string>;
  readonly variables: ReadonlyMap<string, string>;
  /** SHOW REPLICA STATUS / SHOW ALL SLAVES STATUS rows; null when they could not be read. */
  readonly replicas: readonly Row[] | null;
  readonly notices: readonly ServerNotice[];
}

function sizeText(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

export function mysqlMonitorSnapshot(at: number, input: MysqlMonitorInput): MonitorSnapshot {
  const s = (name: string): number | null => numberOrNull(input.status.get(name.toLowerCase()));
  const v = (name: string): number | null => numberOrNull(input.variables.get(name.toLowerCase()));
  const requests = s('Innodb_buffer_pool_read_requests');
  const diskReads = s('Innodb_buffer_pool_reads');
  const pagesTotal = s('Innodb_buffer_pool_pages_total');
  const pagesFree = s('Innodb_buffer_pool_pages_free');
  const replicas = input.replicas ?? [];
  const lags = replicas
    .map((r) => numberOrNull(pick(r, 'Seconds_Behind_Source', 'Seconds_Behind_Master')))
    .filter((n): n is number => n !== null);
  const replicaState = (r: Row): string =>
    `IO ${textOrNull(pick(r, 'Replica_IO_Running', 'Slave_IO_Running')) ?? '?'} · SQL ${
      textOrNull(pick(r, 'Replica_SQL_Running', 'Slave_SQL_Running')) ?? '?'
    }`;
  const tiles: MonitorTile[] = [
    {
      id: 'qps',
      label: 'Queries/s',
      kind: 'rate',
      unit: 'count',
      counter: s('Questions'),
      detail: 'statements sent by clients',
    },
    {
      id: 'threads-connected',
      label: 'Threads connected',
      kind: 'gauge',
      unit: 'count',
      value: s('Threads_connected'),
      detail: `${s('Threads_running') ?? 0} running · ${v('max_connections') ?? '?'} max · ${
        s('Max_used_connections') ?? '?'
      } peak`,
    },
    {
      id: 'threads-running',
      label: 'Threads running',
      kind: 'gauge',
      unit: 'count',
      value: s('Threads_running'),
      detail: `${s('Threads_created') ?? 0} threads created since start`,
    },
    {
      id: 'buffer-pool-hit',
      label: 'Buffer pool hit ratio',
      kind: 'ratio',
      hits: requests !== null && diskReads !== null ? requests - diskReads : null,
      total: requests,
      detail: 'InnoDB reads served from memory',
    },
    {
      id: 'buffer-pool-used',
      label: 'Buffer pool used',
      kind: 'gauge',
      unit: 'ratio',
      value:
        pagesTotal !== null && pagesFree !== null && pagesTotal > 0
          ? (pagesTotal - pagesFree) / pagesTotal
          : null,
      detail: `${v('innodb_buffer_pool_size') !== null ? `${sizeText(v('innodb_buffer_pool_size')!)} · ` : ''}${
        s('Innodb_buffer_pool_pages_dirty') ?? 0
      } dirty pages`,
    },
    input.replicas === null
      ? {
          id: 'replica-lag',
          label: 'Replica lag',
          kind: 'gauge',
          unit: 'seconds',
          value: null,
          detail: 'replication status not readable',
        }
      : replicas.length === 0
        ? {
            id: 'replica-lag',
            label: 'Replica lag',
            kind: 'gauge',
            unit: 'seconds',
            value: null,
            detail: 'not a replica',
          }
        : {
            id: 'replica-lag',
            label: 'Replica lag',
            kind: 'gauge',
            unit: 'seconds',
            value: lags.length > 0 ? Math.max(...lags) : null,
            detail: replicas.map(replicaState).join(' / '),
          },
    {
      id: 'slow-queries',
      label: 'Slow queries/s',
      kind: 'rate',
      unit: 'count',
      counter: s('Slow_queries'),
      detail: `slower than long_query_time (${v('long_query_time') ?? '?'} s)`,
    },
    {
      id: 'bytes-received',
      label: 'Received/s',
      kind: 'rate',
      unit: 'bytes',
      counter: s('Bytes_received'),
      detail: 'from clients',
    },
    {
      id: 'bytes-sent',
      label: 'Sent/s',
      kind: 'rate',
      unit: 'bytes',
      counter: s('Bytes_sent'),
      detail: 'to clients',
    },
    {
      id: 'row-lock-waits',
      label: 'Row lock waits/s',
      kind: 'rate',
      unit: 'count',
      counter: s('Innodb_row_lock_waits'),
      detail: `${s('Innodb_row_lock_current_waits') ?? 0} waiting now`,
    },
    {
      id: 'tmp-disk-tables',
      label: 'Temp tables on disk/s',
      kind: 'rate',
      unit: 'count',
      counter: s('Created_tmp_disk_tables'),
      detail: `${s('Created_tmp_tables') ?? 0} temporary tables in all`,
    },
    {
      id: 'aborted-connects',
      label: 'Failed connections/s',
      kind: 'rate',
      unit: 'count',
      counter: s('Aborted_connects'),
      detail: `${s('Aborted_clients') ?? 0} clients aborted`,
    },
  ];
  const counters = (names: readonly [string, string][]): MonitorSection['table'] => ({
    columns: [
      { key: 'name', label: 'Counter' },
      { key: 'value', label: 'Since start', unit: 'count' },
    ],
    rows: names.map(([name, label]) => ({ name: label, value: s(name) })),
  });
  const sections: MonitorSection[] = [
    {
      id: 'statements',
      title: 'Statements',
      table: counters([
        ['Com_select', 'SELECT'],
        ['Com_insert', 'INSERT'],
        ['Com_update', 'UPDATE'],
        ['Com_delete', 'DELETE'],
        ['Com_replace', 'REPLACE'],
        ['Com_commit', 'COMMIT'],
        ['Com_rollback', 'ROLLBACK'],
        ['Select_full_join', 'Joins without an index'],
        ['Sort_merge_passes', 'Sort merge passes'],
      ]),
    },
    {
      id: 'innodb',
      title: 'InnoDB',
      table: counters([
        ['Innodb_rows_read', 'Rows read'],
        ['Innodb_rows_inserted', 'Rows inserted'],
        ['Innodb_rows_updated', 'Rows updated'],
        ['Innodb_rows_deleted', 'Rows deleted'],
        ['Innodb_buffer_pool_pages_total', 'Buffer pool pages'],
        ['Innodb_buffer_pool_pages_free', 'Free pages'],
        ['Innodb_buffer_pool_pages_dirty', 'Dirty pages'],
        ['Innodb_data_reads', 'Data reads'],
        ['Innodb_data_writes', 'Data writes'],
      ]),
    },
    {
      id: 'replication',
      title: 'Replication',
      empty: 'This server is not a replica.',
      ...(input.replicas === null
        ? {
            notice: {
              level: 'info',
              message:
                'Replication status needs the REPLICATION CLIENT privilege (MySQL) or REPLICA MONITOR (MariaDB)',
            },
          }
        : {}),
      table: {
        columns: [
          { key: 'channel', label: 'Channel' },
          { key: 'source', label: 'Source' },
          { key: 'io', label: 'IO thread' },
          { key: 'sql', label: 'SQL thread' },
          { key: 'lag', label: 'Lag', unit: 'seconds' },
          { key: 'error', label: 'Last error' },
        ],
        rows: replicas.map((r) => ({
          channel: textOrNull(pick(r, 'Channel_Name', 'Connection_name')) || 'default',
          source: `${textOrNull(pick(r, 'Source_Host', 'Master_Host')) ?? '?'}:${
            textOrNull(pick(r, 'Source_Port', 'Master_Port')) ?? '?'
          }`,
          io: textOrNull(pick(r, 'Replica_IO_Running', 'Slave_IO_Running')),
          sql: textOrNull(pick(r, 'Replica_SQL_Running', 'Slave_SQL_Running')),
          lag: numberOrNull(pick(r, 'Seconds_Behind_Source', 'Seconds_Behind_Master')),
          error:
            textOrNull(pick(r, 'Last_IO_Error')) || textOrNull(pick(r, 'Last_SQL_Error')) || null,
        })),
      },
    },
  ];
  return { at, uptimeSeconds: s('Uptime'), tiles, sections, notices: input.notices };
}

// --------------------------------------------------------------------------------- sessions

export const MYSQL_SESSION_DETAIL_COLUMNS = [
  { key: 'threadState', label: 'Thread state' },
  { key: 'time', label: 'Time in command', unit: 'seconds' },
  { key: 'progress', label: 'Progress', unit: 'percent' },
  { key: 'memory', label: 'Memory', unit: 'bytes' },
  { key: 'rowsExamined', label: 'Rows examined', unit: 'count' },
  { key: 'queryId', label: 'Query id' },
] as const;

const BACKGROUND_COMMANDS = new Set([
  'daemon',
  'binlog dump',
  'binlog dump gtid',
  'slave_io',
  'slave_sql',
  'slave_worker',
  'connect',
]);

/** One SHOW FULL PROCESSLIST or information_schema.PROCESSLIST row. */
export function mysqlSession(
  row: Row,
  ownId: string,
  blockers: ReadonlyMap<string, readonly string[]>,
): ServerSession {
  const id = textOrNull(pick(row, 'Id', 'ID')) ?? '';
  const command = textOrNull(pick(row, 'Command', 'COMMAND'));
  const threadState = textOrNull(pick(row, 'State', 'STATE'));
  const user = textOrNull(pick(row, 'User', 'USER'));
  const seconds = numberOrNull(pick(row, 'Time', 'TIME'));
  const ms = numberOrNull(pick(row, 'TIME_MS'));
  const idle = command === 'Sleep';
  const background =
    user === 'system user' ||
    user === 'event_scheduler' ||
    BACKGROUND_COMMANDS.has((command ?? '').toLowerCase());
  const waiting = threadState !== null && /wait|lock/i.test(threadState);
  return {
    id,
    user,
    database: textOrNull(pick(row, 'db', 'DB')),
    client: textOrNull(pick(row, 'Host', 'HOST')) || null,
    application: null,
    state: command,
    durationMs: idle || background ? null : (ms ?? (seconds !== null ? seconds * 1000 : null)),
    wait: waiting ? threadState : null,
    query: textOrNull(pick(row, 'Info', 'INFO')),
    blockedBy: blockers.get(id) ?? [],
    own: id === ownId,
    background,
    idle,
    detail: {
      threadState,
      time: seconds,
      progress: numberOrNull(pick(row, 'PROGRESS')),
      memory: numberOrNull(pick(row, 'MEMORY_USED')),
      rowsExamined: numberOrNull(pick(row, 'EXAMINED_ROWS')),
      queryId: textOrNull(pick(row, 'QUERY_ID')),
    },
  };
}

// ------------------------------------------------------------------------------ top queries

/** One events_statements_summary_by_digest row (timers already in ms). */
export function mysqlTopQuery(row: Row): TopQuery {
  const schema = textOrNull(pick(row, 'SCHEMA_NAME'));
  const digest = textOrNull(pick(row, 'DIGEST')) ?? '';
  return {
    id: `${schema ?? ''}:${digest}`,
    text: textOrNull(pick(row, 'DIGEST_TEXT')) ?? '',
    database: schema,
    user: null,
    calls: numberOrNull(pick(row, 'COUNT_STAR')) ?? 0,
    totalMs: numberOrNull(pick(row, 'total_ms')) ?? 0,
    meanMs: numberOrNull(pick(row, 'mean_ms')) ?? 0,
    maxMs: numberOrNull(pick(row, 'max_ms')),
    rows: numberOrNull(pick(row, 'SUM_ROWS_SENT')),
    detail: {
      rowsExamined: numberOrNull(pick(row, 'SUM_ROWS_EXAMINED')),
      rowsAffected: numberOrNull(pick(row, 'SUM_ROWS_AFFECTED')),
      noIndex: numberOrNull(pick(row, 'SUM_NO_INDEX_USED')),
      tmpDisk: numberOrNull(pick(row, 'SUM_CREATED_TMP_DISK_TABLES')),
      lastSeen: textOrNull(pick(row, 'LAST_SEEN')),
      sample: textOrNull(pick(row, 'QUERY_SAMPLE_TEXT')),
    },
  };
}

// ------------------------------------------------------------------------------- accounts

const BUILTIN = new Set([
  'mysql.sys',
  'mysql.session',
  'mysql.infoschema',
  'mariadb.sys',
  'PUBLIC',
]);

/**
 * Accounts from mysql.user, and role grants from mysql.role_edges (MySQL: FROM_* is the role,
 * TO_* the member) or mysql.roles_mapping (MariaDB: Role granted to User@Host). On MySQL a role
 * is an account granted to someone, or a locked account without a password (what CREATE ROLE
 * makes); on MariaDB it is flagged.
 */
export function mysqlAccounts(
  users: readonly Row[],
  grants: readonly Row[],
  flavor: Flavor,
): ServerAccount[] {
  const key = (user: string, host: string): string => `${user}\u0000${host}`;
  const memberOf = new Map<string, RoleMembership[]>();
  const grantedRoles = new Set<string>();
  for (const g of grants) {
    const role =
      flavor === 'mysql'
        ? {
            name: textOrNull(pick(g, 'FROM_USER')) ?? '',
            host: textOrNull(pick(g, 'FROM_HOST')) ?? '%',
          }
        : { name: textOrNull(pick(g, 'Role')) ?? '' };
    const member =
      flavor === 'mysql'
        ? key(textOrNull(pick(g, 'TO_USER')) ?? '', textOrNull(pick(g, 'TO_HOST')) ?? '')
        : key(textOrNull(pick(g, 'User')) ?? '', textOrNull(pick(g, 'Host')) ?? '');
    grantedRoles.add(key(role.name, role.host ?? ''));
    const list = memberOf.get(member) ?? [];
    list.push({ role, admin: yes(pick(g, 'WITH_ADMIN_OPTION', 'Admin_option')) });
    memberOf.set(member, list);
  }
  return users.map((u) => {
    const name = textOrNull(pick(u, 'user', 'User')) ?? '';
    const host = textOrNull(pick(u, 'host', 'Host')) ?? '';
    const locked = yes(pick(u, 'account_locked', 'locked'));
    const role =
      flavor === 'mariadb'
        ? yes(pick(u, 'is_role'))
        : grantedRoles.has(key(name, host)) || (locked && yes(pick(u, 'no_password')));
    const attributes: string[] = [];
    if (yes(pick(u, 'password_expired'))) attributes.push('password expired');
    const plugin = textOrNull(pick(u, 'plugin'));
    if (plugin && !role) attributes.push(plugin);
    const limit = numberOrNull(pick(u, 'max_user_connections'));
    return {
      name,
      ...(flavor === 'mariadb' && role ? {} : { host }),
      kind: role ? 'role' : 'user',
      canLogin: !role && !locked,
      superuser: yes(pick(u, 'Super_priv')),
      locked,
      attributes,
      memberOf: memberOf.get(key(name, host)) ?? [],
      connectionLimit: limit !== null && limit > 0 ? limit : null,
      builtin: BUILTIN.has(name),
    } satisfies ServerAccount;
  });
}

// --------------------------------------------------------------------------------- settings

const MARIADB_TYPES: Readonly<Record<string, ServerSetting['type']>> = {
  BOOLEAN: 'bool',
  ENUM: 'enum',
  SET: 'string',
  FLAGSET: 'string',
  VARCHAR: 'string',
  DOUBLE: 'real',
};

/** One information_schema.SYSTEM_VARIABLES row (MariaDB). */
export function mariadbSetting(row: Row): ServerSetting {
  const scope = (textOrNull(pick(row, 'VARIABLE_SCOPE')) ?? '').toUpperCase();
  const readOnly = yes(pick(row, 'READ_ONLY'));
  const scopes: SettingScope[] = readOnly
    ? []
    : scope === 'SESSION ONLY'
      ? ['session']
      : scope === 'SESSION'
        ? ['global', 'session']
        : ['global'];
  const type = (textOrNull(pick(row, 'VARIABLE_TYPE')) ?? '').toUpperCase();
  const enums = textOrNull(pick(row, 'ENUM_VALUE_LIST'));
  return {
    name: (textOrNull(pick(row, 'VARIABLE_NAME')) ?? '').toLowerCase(),
    value:
      scope === 'SESSION ONLY'
        ? textOrNull(pick(row, 'SESSION_VALUE'))
        : textOrNull(pick(row, 'GLOBAL_VALUE')),
    unit: null,
    category: null,
    description: textOrNull(pick(row, 'VARIABLE_COMMENT')),
    source: textOrNull(pick(row, 'GLOBAL_VALUE_ORIGIN'))?.toLowerCase() ?? null,
    type: MARIADB_TYPES[type] ?? (/INT/.test(type) ? 'integer' : null),
    enumValues: type === 'ENUM' && enums ? enums.split(',') : [],
    min: textOrNull(pick(row, 'NUMERIC_MIN_VALUE')),
    max: textOrNull(pick(row, 'NUMERIC_MAX_VALUE')),
    defaultValue: textOrNull(pick(row, 'DEFAULT_VALUE')),
    scopes,
    restartRequired: readOnly,
    pendingRestart: false,
  };
}

/**
 * One SHOW GLOBAL VARIABLES row (MySQL), with performance_schema.variables_info when readable.
 * MySQL does not say which variables are dynamic, so every scope is offered and the server
 * refuses read-only variables with its own message.
 */
export function mysqlSetting(row: Row, info: Row | undefined, persist: boolean): ServerSetting {
  const value = textOrNull(pick(row, 'Value'));
  const min = textOrNull(info && pick(info, 'MIN_VALUE'));
  const max = textOrNull(info && pick(info, 'MAX_VALUE'));
  const numeric = min !== null && max !== null && !(min === '0' && max === '0');
  return {
    name: (textOrNull(pick(row, 'Variable_name')) ?? '').toLowerCase(),
    value,
    unit: null,
    category: null,
    description: null,
    source: textOrNull(info && pick(info, 'VARIABLE_SOURCE'))?.toLowerCase() ?? null,
    type: value === 'ON' || value === 'OFF' ? 'bool' : numeric ? 'integer' : null,
    enumValues: [],
    min: numeric ? min : null,
    max: numeric ? max : null,
    defaultValue: null,
    scopes: persist ? ['global', 'persist', 'session'] : ['global', 'session'],
    restartRequired: false,
    pendingRestart: false,
  };
}

/** A value of a result row as a table cell. */
export function cellOf(value: CellValue | undefined): ToolCell {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'bigint') return Number(value);
  if (value instanceof Uint8Array) return new TextDecoder().decode(value);
  return value.preview;
}
