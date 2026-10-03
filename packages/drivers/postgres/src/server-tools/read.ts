import type {
  CellValue,
  DefaultPrivilege,
  DefaultPrivilegeType,
  GrantState,
  MonitorSection,
  MonitorSnapshot,
  MonitorTile,
  PolicyCommand,
  RlsTable,
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

/**
 * PostgreSQL server tools: rows of the catalog and statistics views turned into the
 * engine-neutral shapes of @querybara/core. Pure, so they are tested with fixture rows; the
 * version differences of PostgreSQL 13 to 18 are handled by reading `to_jsonb` rows, where a
 * column a version lacks is simply absent.
 */

/** A number from a numeric, bigint or text column; null for NULL or text that is no number. */
export function numberOrNull(value: CellValue | unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

export function numberOf(value: CellValue | unknown): number {
  return numberOrNull(value) ?? 0;
}

export function textOrNull(value: CellValue | unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'boolean') {
    return String(value);
  }
  return null;
}

export function boolOf(value: CellValue | unknown): boolean {
  return value === true || value === 't' || value === 'true' || value === 1;
}

/** A json/jsonb column (text on the wire), or `fallback` for NULL. */
export function jsonOf<T>(value: CellValue | unknown, fallback: T): T {
  if (typeof value !== 'string' || value === '') return fallback;
  return JSON.parse(value) as T;
}

/** A value of a to_jsonb row as a table cell. */
export function cellOf(value: unknown): ToolCell {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'bigint') return Number(value);
  return JSON.stringify(value);
}

function sum(rows: readonly Row[], ...keys: string[]): number {
  let total = 0;
  for (const row of rows) for (const key of keys) total += numberOf(row[key]);
  return total;
}

function seconds(value: number): string {
  if (value < 60) return `${value.toFixed(1)} s`;
  if (value < 3600) return `${Math.floor(value / 60)} min ${Math.round(value % 60)} s`;
  return `${Math.floor(value / 3600)} h ${Math.round((value % 3600) / 60)} min`;
}

// ---------------------------------------------------------------------------------- monitor

export interface PgMonitorRows {
  /** One row: connection counts, the longest transaction and query, uptime, locks, size. */
  readonly activity: Row;
  readonly databases: readonly Row[];
  readonly inRecovery: boolean;
  /** pg_stat_replication (primary) or the WAL receiver (standby). */
  readonly replication: readonly Row[];
  readonly slots: readonly Row[];
  readonly lockWaits: readonly Row[];
  readonly database: string;
  readonly notices: readonly ServerNotice[];
}

export function pgMonitorSnapshot(at: number, rows: PgMonitorRows): MonitorSnapshot {
  const a = rows.activity;
  const dbs = rows.databases;
  const replicaLags = rows.replication
    .map((r) => numberOrNull(r['replay_lag_bytes']))
    .filter((v): v is number => v !== null);
  const standby = rows.inRecovery ? rows.replication[0] : undefined;
  const tiles: MonitorTile[] = [
    {
      id: 'connections',
      label: 'Connections',
      kind: 'gauge',
      unit: 'count',
      value: numberOrNull(a['clients']),
      detail: `${numberOf(a['active'])} active · ${numberOf(a['idle_in_tx'])} idle in transaction · ${numberOf(a['max_connections'])} max`,
    },
    {
      id: 'tps',
      label: 'Transactions/s',
      kind: 'rate',
      unit: 'count',
      counter: sum(dbs, 'xact_commit', 'xact_rollback'),
      detail: 'commits and rollbacks, all databases',
    },
    {
      id: 'cache-hit',
      label: 'Cache hit ratio',
      kind: 'ratio',
      hits: sum(dbs, 'blks_hit'),
      total: sum(dbs, 'blks_hit', 'blks_read'),
      detail: 'shared buffers, all databases',
    },
    {
      id: 'rows-read',
      label: 'Rows read/s',
      kind: 'rate',
      unit: 'count',
      counter: sum(dbs, 'tup_fetched'),
      detail: 'fetched by queries',
    },
    {
      id: 'rows-written',
      label: 'Rows written/s',
      kind: 'rate',
      unit: 'count',
      counter: sum(dbs, 'tup_inserted', 'tup_updated', 'tup_deleted'),
      detail: 'inserted, updated and deleted',
    },
    {
      id: 'lock-waits',
      label: 'Lock waits',
      kind: 'gauge',
      unit: 'count',
      value: numberOrNull(a['lock_waits']),
      detail: `${numberOf(a['locks'])} locks held or awaited`,
    },
    {
      id: 'longest-transaction',
      label: 'Longest transaction',
      kind: 'gauge',
      unit: 'seconds',
      value: numberOrNull(a['longest_xact_s']),
      detail: `longest running query ${seconds(numberOf(a['longest_query_s']))}`,
    },
    standby
      ? {
          id: 'replication-lag',
          label: 'Replay delay',
          kind: 'gauge',
          unit: 'seconds',
          value: numberOrNull(standby['replay_delay_s']),
          detail: `standby · WAL receiver ${textOrNull(standby['receiver_status']) ?? 'not running'}`,
        }
      : {
          id: 'replication-lag',
          label: 'Replication lag',
          kind: 'gauge',
          unit: 'bytes',
          value: replicaLags.length > 0 ? Math.max(...replicaLags) : null,
          detail: `${rows.replication.length} ${rows.replication.length === 1 ? 'replica' : 'replicas'} connected`,
        },
    {
      id: 'temp-bytes',
      label: 'Temp files written/s',
      kind: 'rate',
      unit: 'bytes',
      counter: sum(dbs, 'temp_bytes'),
      detail: 'sorts and hashes that spilled to disk',
    },
    {
      id: 'deadlocks',
      label: 'Deadlocks',
      kind: 'gauge',
      unit: 'count',
      value: sum(dbs, 'deadlocks'),
      detail: 'since the statistics were reset',
    },
    {
      id: 'database-size',
      label: 'Database size',
      kind: 'gauge',
      unit: 'bytes',
      value: numberOrNull(a['db_size']),
      detail: rows.database,
    },
  ];
  const sections: MonitorSection[] = [
    {
      id: 'databases',
      title: 'Databases',
      table: {
        columns: [
          { key: 'database', label: 'Database' },
          { key: 'backends', label: 'Backends', unit: 'count' },
          { key: 'commits', label: 'Commits', unit: 'count' },
          { key: 'rollbacks', label: 'Rollbacks', unit: 'count' },
          { key: 'hitRatio', label: 'Cache hits', unit: 'ratio' },
          { key: 'deadlocks', label: 'Deadlocks', unit: 'count' },
          { key: 'conflicts', label: 'Conflicts', unit: 'count' },
          { key: 'tempBytes', label: 'Temp written', unit: 'bytes' },
        ],
        rows: dbs.map((d) => {
          const hit = numberOf(d['blks_hit']);
          const read = numberOf(d['blks_read']);
          return {
            database: textOrNull(d['datname']),
            backends: numberOf(d['numbackends']),
            commits: numberOf(d['xact_commit']),
            rollbacks: numberOf(d['xact_rollback']),
            hitRatio: hit + read > 0 ? hit / (hit + read) : null,
            deadlocks: numberOf(d['deadlocks']),
            conflicts: numberOf(d['conflicts']),
            tempBytes: numberOf(d['temp_bytes']),
          };
        }),
      },
    },
    rows.inRecovery
      ? {
          id: 'replication',
          title: 'Replication (standby)',
          table: {
            columns: [
              { key: 'sender', label: 'Primary' },
              { key: 'status', label: 'Receiver' },
              { key: 'received', label: 'Received LSN' },
              { key: 'replayed', label: 'Replayed LSN' },
              { key: 'lagBytes', label: 'Replay lag', unit: 'bytes' },
              { key: 'delay', label: 'Replay delay', unit: 'seconds' },
            ],
            rows: rows.replication.map((r) => ({
              sender: textOrNull(r['sender']),
              status: textOrNull(r['receiver_status']),
              received: textOrNull(r['received']),
              replayed: textOrNull(r['replayed']),
              lagBytes: numberOrNull(r['replay_lag_bytes']),
              delay: numberOrNull(r['replay_delay_s']),
            })),
          },
        }
      : {
          id: 'replication',
          title: 'Replication',
          empty: 'No replicas are connected.',
          table: {
            columns: [
              { key: 'name', label: 'Replica' },
              { key: 'client', label: 'Address' },
              { key: 'state', label: 'State' },
              { key: 'sync', label: 'Sync' },
              { key: 'lagBytes', label: 'Replay lag', unit: 'bytes' },
              { key: 'lagMs', label: 'Replay delay', unit: 'ms' },
            ],
            rows: rows.replication.map((r) => ({
              name: textOrNull(r['application_name']),
              client: textOrNull(r['client']),
              state: textOrNull(r['state']),
              sync: textOrNull(r['sync_state']),
              lagBytes: numberOrNull(r['replay_lag_bytes']),
              lagMs: numberOrNull(r['replay_lag_ms']),
            })),
          },
        },
  ];
  if (!rows.inRecovery) {
    sections.push({
      id: 'slots',
      title: 'Replication slots',
      empty: 'No replication slots.',
      table: {
        columns: [
          { key: 'name', label: 'Slot' },
          { key: 'type', label: 'Type' },
          { key: 'active', label: 'Active', unit: 'bool' },
          { key: 'walStatus', label: 'WAL status' },
          { key: 'retained', label: 'WAL retained', unit: 'bytes' },
        ],
        rows: rows.slots.map((s) => ({
          name: textOrNull(s['slot_name']),
          type: textOrNull(s['slot_type']),
          active: boolOf(s['active']),
          walStatus: textOrNull(s['wal_status']),
          retained: numberOrNull(s['retained_bytes']),
        })),
      },
    });
  }
  sections.push({
    id: 'lock-waits',
    title: 'Lock waits',
    empty: 'No session is waiting for a lock.',
    table: {
      columns: [
        { key: 'pid', label: 'PID' },
        { key: 'user', label: 'User' },
        { key: 'database', label: 'Database' },
        { key: 'lock', label: 'Lock' },
        { key: 'relation', label: 'Relation' },
        { key: 'waiting', label: 'Waiting', unit: 'ms' },
        { key: 'blockedBy', label: 'Blocked by' },
        { key: 'query', label: 'Query' },
      ],
      rows: rows.lockWaits.map((w) => ({
        pid: numberOrNull(w['pid']),
        user: textOrNull(w['usename']),
        database: textOrNull(w['datname']),
        lock: `${textOrNull(w['mode']) ?? ''} (${textOrNull(w['locktype']) ?? ''})`,
        relation: textOrNull(w['relation']),
        waiting: numberOrNull(w['waiting_ms']),
        blockedBy: textOrNull(w['blocked_by']),
        query: textOrNull(w['query']),
      })),
    },
  });
  return {
    at,
    uptimeSeconds: numberOrNull(a['uptime_s']),
    tiles,
    sections,
    notices: rows.notices,
  };
}

// --------------------------------------------------------------------------------- sessions

export const PG_SESSION_DETAIL_COLUMNS = [
  { key: 'backendType', label: 'Backend type' },
  { key: 'backendStart', label: 'Connected', unit: 'time' },
  { key: 'xactStart', label: 'Transaction started', unit: 'time' },
  { key: 'queryStart', label: 'Query started', unit: 'time' },
  { key: 'stateChange', label: 'State changed', unit: 'time' },
  { key: 'queryId', label: 'Query id' },
  { key: 'leaderPid', label: 'Parallel leader' },
] as const;

/** One pg_stat_activity row (`a` is its to_jsonb text). */
export function pgSession(row: Row): ServerSession {
  const a = jsonOf<Record<string, unknown>>(row['a'], {});
  const text = (key: string): string | null => {
    const value = a[key];
    return typeof value === 'string' && value !== '' ? value : null;
  };
  const port = typeof a['client_port'] === 'number' ? a['client_port'] : null;
  const address = text('client_hostname') ?? text('client_addr');
  const client =
    address !== null
      ? port !== null && port > 0
        ? `${address}:${port}`
        : address
      : port === -1
        ? 'local socket'
        : null;
  const waitType = text('wait_event_type');
  const blocked = textOrNull(row['blocked_by']);
  const backendType = text('backend_type');
  const state = text('state');
  return {
    id: String(a['pid'] ?? ''),
    user: text('usename'),
    database: text('datname'),
    client,
    application: text('application_name'),
    state,
    durationMs: numberOrNull(row['duration_ms']),
    wait: waitType !== null ? `${waitType}: ${text('wait_event') ?? ''}` : null,
    query: text('query'),
    blockedBy: blocked ? blocked.split(',').filter((pid) => pid !== '') : [],
    own: boolOf(row['own']),
    background: backendType !== null && backendType !== 'client backend',
    idle: state === 'idle',
    detail: {
      backendType,
      backendStart: text('backend_start'),
      xactStart: text('xact_start'),
      queryStart: text('query_start'),
      stateChange: text('state_change'),
      queryId: cellOf(a['query_id']),
      leaderPid: cellOf(a['leader_pid']),
    },
  };
}

// ------------------------------------------------------------------------------ top queries

/**
 * pg_stat_statements columns by what they mean, for the extension version installed: 1.8
 * (PostgreSQL 13) renamed total_time to total_exec_time, 1.11 (17) blk_read_time to
 * shared_blk_read_time.
 */
export interface StatementColumns {
  readonly total: string;
  readonly mean: string;
  readonly max: string;
  readonly planTotal: string | null;
  readonly readTime: string | null;
  readonly walBytes: string | null;
}

export function statementColumns(columns: readonly string[]): StatementColumns {
  const has = (name: string): boolean => columns.includes(name);
  const pick = (...names: string[]): string | null => names.find(has) ?? null;
  return {
    total: pick('total_exec_time', 'total_time') ?? 'total_exec_time',
    mean: pick('mean_exec_time', 'mean_time') ?? 'mean_exec_time',
    max: pick('max_exec_time', 'max_time') ?? 'max_exec_time',
    planTotal: pick('total_plan_time'),
    readTime: pick('shared_blk_read_time', 'blk_read_time'),
    walBytes: pick('wal_bytes'),
  };
}

export function pgTopQuery(row: Row): TopQuery {
  const hit = numberOf(row['shared_blks_hit']);
  const read = numberOf(row['shared_blks_read']);
  return {
    id: textOrNull(row['id']) ?? '',
    text: textOrNull(row['query']) ?? '',
    database: textOrNull(row['datname']),
    user: textOrNull(row['rolname']),
    calls: numberOf(row['calls']),
    totalMs: numberOf(row['total_ms']),
    meanMs: numberOf(row['mean_ms']),
    maxMs: numberOrNull(row['max_ms']),
    rows: numberOrNull(row['rows']),
    detail: {
      hitRatio: hit + read > 0 ? hit / (hit + read) : null,
      sharedRead: read,
      tempWritten: numberOrNull(row['temp_blks_written']),
      planMs: numberOrNull(row['plan_ms']),
      readMs: numberOrNull(row['read_ms']),
      walBytes: numberOrNull(row['wal_bytes']),
    },
  };
}

// ------------------------------------------------------------------------------------ roles

/** Accounts from to_jsonb(pg_roles) rows and pg_auth_members rows. */
export function pgAccounts(roles: readonly Row[], members: readonly Row[]): ServerAccount[] {
  const memberships = new Map<string, Map<string, RoleMembership>>();
  for (const row of members) {
    const m = jsonOf<Record<string, unknown>>(row['m'], {});
    const member = textOrNull(row['member']) ?? '';
    const role = textOrNull(row['role']) ?? '';
    const list = memberships.get(member) ?? new Map<string, RoleMembership>();
    // PostgreSQL 16 keeps one grant per grantor: merge them.
    const known = list.get(role);
    const next: RoleMembership = {
      role: { name: role },
      admin: (known?.admin ?? false) || m['admin_option'] === true,
      ...(typeof m['inherit_option'] === 'boolean'
        ? { inherit: (known?.inherit ?? false) || m['inherit_option'] }
        : {}),
      ...(typeof m['set_option'] === 'boolean'
        ? { set: (known?.set ?? false) || m['set_option'] }
        : {}),
    };
    list.set(role, next);
    memberships.set(member, list);
  }
  return roles.map((row) => {
    const r = jsonOf<Record<string, unknown>>(row['r'], {});
    const name = String(r['rolname'] ?? '');
    const canLogin = r['rolcanlogin'] === true;
    const attributes: string[] = [];
    if (r['rolcreatedb'] === true) attributes.push('CREATEDB');
    if (r['rolcreaterole'] === true) attributes.push('CREATEROLE');
    if (r['rolreplication'] === true) attributes.push('REPLICATION');
    if (r['rolbypassrls'] === true) attributes.push('BYPASSRLS');
    if (r['rolinherit'] === false) attributes.push('NOINHERIT');
    const limit = typeof r['rolconnlimit'] === 'number' ? r['rolconnlimit'] : null;
    return {
      name,
      kind: canLogin ? 'user' : 'role',
      canLogin,
      superuser: r['rolsuper'] === true,
      attributes,
      memberOf: [...(memberships.get(name)?.values() ?? [])],
      connectionLimit: limit !== null && limit >= 0 ? limit : null,
      validUntil: typeof r['rolvaliduntil'] === 'string' ? r['rolvaliduntil'] : null,
      builtin: name.startsWith('pg_'),
    } satisfies ServerAccount;
  });
}

// ----------------------------------------------------------------------------------- grants

/**
 * A matrix row's cells: an explicit grant to the grantee (with or without grant option), else
 * a privilege held some other way (ownership, membership, PUBLIC, superuser) is `implied`.
 */
export function grantStates(
  privileges: readonly string[],
  explicit: readonly { readonly p: string; readonly g: boolean }[],
  effective: Readonly<Record<string, boolean>>,
  owner: boolean,
): Record<string, GrantState> {
  const out: Record<string, GrantState> = {};
  for (const privilege of privileges) {
    const grant = explicit.find((e) => e.p === privilege);
    out[privilege] =
      grant && !owner
        ? grant.g
          ? 'grantable'
          : 'granted'
        : effective[privilege] === true || grant !== undefined
          ? 'implied'
          : 'none';
  }
  return out;
}

const DEFAULT_ACL_TYPES: Readonly<Record<string, DefaultPrivilegeType>> = {
  r: 'tables',
  S: 'sequences',
  f: 'functions',
  T: 'types',
  n: 'schemas',
};

/** pg_default_acl exploded into one row per owner, schema, type, grantee and privilege. */
export function pgDefaultPrivileges(rows: readonly Row[]): DefaultPrivilege[] {
  const byKey = new Map<
    string,
    {
      -readonly [K in keyof DefaultPrivilege]: K extends 'privileges' | 'grantable'
        ? string[]
        : DefaultPrivilege[K];
    }
  >();
  for (const row of rows) {
    const owner = textOrNull(row['owner']) ?? '';
    const grantee = textOrNull(row['grantee']) ?? 'PUBLIC';
    // An owner's own default grants are the built-in ones; they are not shown.
    if (grantee === owner) continue;
    const objectType = DEFAULT_ACL_TYPES[textOrNull(row['type']) ?? ''];
    if (!objectType) continue;
    const schema = textOrNull(row['schema']);
    const key = [owner, schema ?? '', objectType, grantee].join('\0');
    const entry = byKey.get(key) ?? {
      owner,
      schema,
      objectType,
      grantee,
      privileges: [],
      grantable: [],
    };
    const privilege = textOrNull(row['privilege']) ?? '';
    entry.privileges.push(privilege);
    if (boolOf(row['grantable'])) entry.grantable.push(privilege);
    byKey.set(key, entry);
  }
  return [...byKey.values()];
}

const POLICY_COMMANDS: Readonly<Record<string, PolicyCommand>> = {
  '*': 'ALL',
  r: 'SELECT',
  a: 'INSERT',
  w: 'UPDATE',
  d: 'DELETE',
};

export function pgRlsTables(schema: string, rows: readonly Row[]): RlsTable[] {
  return rows.map((row) => ({
    schema,
    table: textOrNull(row['name']) ?? '',
    enabled: boolOf(row['enabled']),
    forced: boolOf(row['forced']),
    policies: jsonOf<
      {
        name: string;
        permissive: boolean;
        cmd: string;
        roles: string[] | null;
        using: string | null;
        check: string | null;
      }[]
    >(row['policies'], []).map((p) => ({
      name: p.name,
      permissive: p.permissive,
      command: POLICY_COMMANDS[p.cmd] ?? 'ALL',
      roles: p.roles ?? ['public'],
      using: p.using,
      withCheck: p.check,
    })),
  }));
}

// --------------------------------------------------------------------------------- settings

export interface SettingAccess {
  readonly superuser: boolean;
  /** Settings this role may change with ALTER SYSTEM; undefined: decided by `superuser`. */
  readonly alterSystem: (name: string, row: Row) => boolean;
}

/** One pg_settings row. */
export function pgSetting(row: Row, access: SettingAccess): ServerSetting {
  const name = textOrNull(row['name']) ?? '';
  const context = textOrNull(row['context']) ?? 'internal';
  const scopes: SettingScope[] = [];
  if (context === 'user' || (context === 'superuser' && access.superuser)) {
    scopes.push('session', 'database');
  }
  if (context !== 'internal' && access.alterSystem(name, row)) scopes.push('system');
  const vartype = textOrNull(row['vartype']);
  return {
    name,
    value: textOrNull(row['setting']),
    unit: textOrNull(row['unit']),
    category: textOrNull(row['category']),
    description: textOrNull(row['short_desc']),
    source: textOrNull(row['source']),
    type:
      vartype === 'bool' ||
      vartype === 'integer' ||
      vartype === 'real' ||
      vartype === 'string' ||
      vartype === 'enum'
        ? vartype
        : null,
    enumValues: jsonOf<string[] | null>(row['enumvals'], null) ?? [],
    min: textOrNull(row['min_val']),
    max: textOrNull(row['max_val']),
    defaultValue: textOrNull(row['boot_val']),
    scopes,
    restartRequired: context === 'postmaster',
    pendingRestart: boolOf(row['pending_restart']),
  };
}
