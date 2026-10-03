import {
  QuerybaraError,
  newId,
  type AccessDetails,
  type AccessOverview,
  type ActionPreview,
  type ActionResult,
  type GrantMatrix,
  type MaintenanceOperationInfo,
  type MaintenanceTargets,
  type MonitorSection,
  type MonitorSnapshot,
  type MonitorTile,
  type ProfilerStatus,
  type ServerAction,
  type ServerNotice,
  type ServerSession,
  type ServerSetting,
  type ServerTools,
  type ServerToolsInfo,
  type Session,
  type SessionList,
  type SessionListOptions,
  type SettingList,
  type ToolCell,
  type ToolTable,
  type TopQueries,
  type TopQuery,
  type TopQueryOptions,
  type TopQueryOrder,
} from '@querybara/core';
import {
  Int32,
  Long,
  bsonTag,
  formatShellInline,
  fromEjson,
  isBsonDocument,
  parseShell,
  quoteShellString,
  toEjson,
  type BsonDocument,
  type BsonValue,
} from '@querybara/mongo-tools';

import { numberOf } from './admin';
import { checkCollectionName, checkDatabaseName } from './context';
import { isMongoSession } from './session';
import type { MongoSession } from './types';

/**
 * MongoDB server tools (spec §15): serverStatus, replica set status and the oplog window for
 * the monitor; operations in progress ($currentOp) with killOp; the database profiler as the
 * top queries (system.profile grouped by query shape); compact and validate; server parameters
 * with setParameter. Users and roles have their own editor in the MongoDB module.
 *
 * Every command goes through the session's public `execute` (command documents), switching
 * the session's current database for commands that run in one; the switches are serialised
 * and undone, so the tools' session can be shared with nothing leaking between calls.
 */

/** The comment on the tools' own $currentOp, so the list can mark (and skip killing) it. */
const OWN_COMMENT = 'querybara server tools';

function notSupported(message: string, hint?: string): QuerybaraError {
  return new QuerybaraError({ code: 'NOT_SUPPORTED', message, ...(hint ? { hint } : {}) });
}

function invalid(message: string): QuerybaraError {
  return new QuerybaraError({ code: 'VALIDATION_FAILED', message });
}

function doc(value: BsonValue | undefined): BsonDocument | undefined {
  return isBsonDocument(value) ? value : undefined;
}

function num(value: BsonValue | undefined): number | null {
  return value === undefined || value === null ? null : (numberOf(value) ?? null);
}

function str(value: BsonValue | undefined): string | null {
  return typeof value === 'string' ? value : null;
}

/** Seconds of a BSON Timestamp (its high 32 bits). */
function timestampSeconds(value: BsonValue | undefined): number | null {
  if (bsonTag(value) !== 'Timestamp') return null;
  return Number((value as { high: number }).high);
}

function isoOf(value: BsonValue | undefined): string | null {
  return value instanceof Date ? value.toISOString() : null;
}

/** A shell literal of a value, cut to `max` characters. */
function shellText(value: BsonValue | undefined, max = 2000): string {
  if (value === undefined) return '';
  const text = formatShellInline(value);
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** db.getSiblingDB('x').runCommand({...}) / db.adminCommand({...}): how a command is shown. */
export function commandText(db: string, command: BsonDocument): string {
  return db === 'admin'
    ? `db.adminCommand(${formatShellInline(command)})`
    : `db.getSiblingDB(${quoteShellString(db)}).runCommand(${formatShellInline(command)})`;
}

// ------------------------------------------------------------------------------- parsers

/** One `$currentOp` document as a server session. */
export function mongoSession(op: BsonDocument): ServerSession {
  const opid = op['opid'];
  const id = typeof opid === 'string' ? opid : num(opid) !== null ? String(num(opid)) : '';
  const users = Array.isArray(op['effectiveUsers']) ? op['effectiveUsers'] : [];
  const first = doc(users[0] as BsonValue | undefined);
  const ns = str(op['ns']);
  const active = op['active'] === true;
  const desc = str(op['desc']);
  const command = doc(op['command']);
  const micros = num(op['microsecs_running']);
  return {
    id,
    user: first ? `${str(first['user']) ?? ''}@${str(first['db']) ?? ''}` : null,
    database: ns !== null && ns !== '' ? ns.split('.')[0]! : null,
    client: str(op['client']) ?? str(op['client_s']),
    application: str(op['appName']),
    state: active ? (str(op['op']) ?? 'active') : 'idle',
    durationMs: active && micros !== null ? micros / 1000 : null,
    wait: op['waitingForLock'] === true ? 'waiting for a lock' : null,
    query: command ? shellText(command) : null,
    blockedBy: [],
    own: command?.['comment'] === OWN_COMMENT,
    background: desc !== null && !desc.startsWith('conn'),
    idle: !active,
    detail: {
      type: str(op['type']),
      desc,
      ns,
      planSummary: str(op['planSummary']),
      yields: num(op['numYields']),
      killPending: op['killPending'] === true,
    },
  };
}

export const MONGO_SESSION_DETAIL_COLUMNS = [
  { key: 'type', label: 'Type' },
  { key: 'desc', label: 'Thread' },
  { key: 'ns', label: 'Namespace' },
  { key: 'planSummary', label: 'Plan' },
  { key: 'yields', label: 'Yields', unit: 'count' },
  { key: 'killPending', label: 'Kill pending', unit: 'bool' },
] as const;

export interface MongoMonitorInput {
  readonly status: BsonDocument;
  /** replSetGetStatus, or null on a standalone / mongos / without the privilege. */
  readonly replSet: BsonDocument | null;
  readonly oplog: {
    readonly first: number | null;
    readonly last: number | null;
    readonly size: number | null;
    readonly maxSize: number | null;
  } | null;
  readonly notices: readonly ServerNotice[];
}

function path(root: BsonDocument | undefined, ...keys: string[]): BsonValue | undefined {
  let value: BsonValue | undefined = root;
  for (const key of keys) {
    const d = doc(value);
    if (!d) return undefined;
    value = d[key];
  }
  return value;
}

/** serverStatus, replica set status and the oplog as a monitor snapshot. */
export function mongoMonitorSnapshot(at: number, input: MongoMonitorInput): MonitorSnapshot {
  const s = input.status;
  const n = (...keys: string[]): number | null => num(path(s, ...keys));
  const counters = doc(s['opcounters']) ?? {};
  const counterNames = ['insert', 'query', 'update', 'delete', 'getmore', 'command'];
  const opsTotal = counterNames.reduce((sum, key) => sum + (num(counters[key]) ?? 0), 0);
  const cache = doc(path(s, 'wiredTiger', 'cache'));
  const cacheN = (key: string): number | null => (cache ? num(cache[key]) : null);
  const requested = cacheN('pages requested from the cache');
  const readIn = cacheN('pages read into cache');
  const members = Array.isArray(input.replSet?.['members'])
    ? (input.replSet!['members'] as BsonValue[]).map(doc).filter((m): m is BsonDocument => !!m)
    : [];
  const primary = members.find((m) => m['stateStr'] === 'PRIMARY');
  const primaryOptime = primary ? (primary['optimeDate'] as Date | undefined) : undefined;
  const lagOf = (m: BsonDocument): number | null => {
    const optime = m['optimeDate'];
    return primaryOptime instanceof Date && optime instanceof Date
      ? Math.max(0, (primaryOptime.getTime() - optime.getTime()) / 1000)
      : null;
  };
  const lags = members
    .filter((m) => m !== primary)
    .map(lagOf)
    .filter((v): v is number => v !== null);
  const latency = (kind: string): { hits: number | null; total: number | null } => {
    const micros = n('opLatencies', kind, 'latency');
    return { hits: micros === null ? null : micros / 1000, total: n('opLatencies', kind, 'ops') };
  };
  const oplog = input.oplog;
  const window =
    oplog && oplog.first !== null && oplog.last !== null ? oplog.last - oplog.first : null;
  const mb = n('mem', 'resident');
  const tiles: MonitorTile[] = [
    {
      id: 'connections',
      label: 'Connections',
      kind: 'gauge',
      unit: 'count',
      value: n('connections', 'current'),
      detail: `${n('connections', 'available') ?? '?'} available · ${
        n('connections', 'totalCreated') ?? '?'
      } created since start`,
    },
    {
      id: 'ops',
      label: 'Operations/s',
      kind: 'rate',
      unit: 'count',
      counter: opsTotal,
      detail: 'inserts, queries, updates, deletes, getmores and commands',
    },
    {
      id: 'read-latency',
      label: 'Read latency',
      kind: 'ratio',
      unit: 'ms',
      ...latency('reads'),
      detail: 'average per read over the interval',
    },
    {
      id: 'write-latency',
      label: 'Write latency',
      kind: 'ratio',
      unit: 'ms',
      ...latency('writes'),
      detail: 'average per write over the interval',
    },
    {
      id: 'cache-hit',
      label: 'Cache hit ratio',
      kind: 'ratio',
      hits: requested !== null && readIn !== null ? requested - readIn : null,
      total: requested,
      detail: 'WiredTiger pages found in the cache',
    },
    {
      id: 'cache-used',
      label: 'Cache used',
      kind: 'gauge',
      unit: 'bytes',
      value: cacheN('bytes currently in the cache'),
      detail: `of ${cacheN('maximum bytes configured') ?? '?'} bytes · ${
        cacheN('tracked dirty bytes in the cache') ?? 0
      } dirty`,
    },
    {
      id: 'queued',
      label: 'Queued operations',
      kind: 'gauge',
      unit: 'count',
      value: n('globalLock', 'currentQueue', 'total'),
      detail: `${n('globalLock', 'currentQueue', 'readers') ?? 0} readers · ${
        n('globalLock', 'currentQueue', 'writers') ?? 0
      } writers · ${n('globalLock', 'activeClients', 'total') ?? 0} active clients`,
    },
    {
      id: 'network-in',
      label: 'Network in/s',
      kind: 'rate',
      unit: 'bytes',
      counter: n('network', 'bytesIn'),
      detail: 'bytes received',
    },
    {
      id: 'network-out',
      label: 'Network out/s',
      kind: 'rate',
      unit: 'bytes',
      counter: n('network', 'bytesOut'),
      detail: 'bytes sent',
    },
    {
      id: 'resident',
      label: 'Resident memory',
      kind: 'gauge',
      unit: 'bytes',
      value: mb === null ? null : mb * 1024 * 1024,
      detail: 'of the mongod or mongos process',
    },
    {
      id: 'replication-lag',
      label: 'Replication lag',
      kind: 'gauge',
      unit: 'seconds',
      value: lags.length > 0 ? Math.max(...lags) : null,
      detail: input.replSet
        ? `${members.length} members · set ${str(input.replSet['set']) ?? ''}`
        : 'not a replica set',
    },
    {
      id: 'oplog-window',
      label: 'Oplog window',
      kind: 'gauge',
      unit: 'seconds',
      value: window,
      detail:
        oplog && oplog.size !== null
          ? `${Math.round(oplog.size / 1024 / 1024)} MB used of ${
              oplog.maxSize !== null ? Math.round(oplog.maxSize / 1024 / 1024) : '?'
            } MB`
          : 'no oplog',
    },
  ];
  const sections: MonitorSection[] = [
    {
      id: 'operations',
      title: 'Operations since start',
      table: {
        columns: [
          { key: 'name', label: 'Operation' },
          { key: 'count', label: 'Count', unit: 'count' },
        ],
        rows: counterNames.map((name) => ({ name, count: num(counters[name]) })),
      },
    },
    {
      id: 'replica-set',
      title: 'Replica set',
      empty: 'This server is not a replica set member.',
      table: {
        columns: [
          { key: 'member', label: 'Member' },
          { key: 'state', label: 'State' },
          { key: 'health', label: 'Healthy', unit: 'bool' },
          { key: 'lag', label: 'Lag', unit: 'seconds' },
          { key: 'ping', label: 'Ping', unit: 'ms' },
          { key: 'syncSource', label: 'Sync source' },
          { key: 'optime', label: 'Last applied', unit: 'time' },
        ],
        rows: members.map((m) => ({
          member: `${str(m['name']) ?? ''}${m['self'] === true ? ' (this)' : ''}`,
          state: str(m['stateStr']),
          health: num(m['health']) === 1,
          lag: m === primary ? 0 : lagOf(m),
          ping: num(m['pingMs']),
          syncSource: str(m['syncSourceHost']) || null,
          optime: isoOf(m['optimeDate']),
        })),
      },
    },
    {
      id: 'oplog',
      title: 'Oplog',
      empty: 'No oplog (not a replica set member, or it cannot be read).',
      table: {
        columns: [
          { key: 'first', label: 'First entry', unit: 'time' },
          { key: 'last', label: 'Last entry', unit: 'time' },
          { key: 'window', label: 'Window', unit: 'seconds' },
          { key: 'size', label: 'Used', unit: 'bytes' },
          { key: 'maxSize', label: 'Size', unit: 'bytes' },
        ],
        rows:
          oplog && oplog.first !== null
            ? [
                {
                  first: new Date(oplog.first * 1000).toISOString(),
                  last: oplog.last !== null ? new Date(oplog.last * 1000).toISOString() : null,
                  window,
                  size: oplog.size,
                  maxSize: oplog.maxSize,
                },
              ]
            : [],
      },
    },
  ];
  return {
    at,
    uptimeSeconds: n('uptime'),
    tiles,
    sections,
    notices: input.notices,
  };
}

/** One group of system.profile entries (see PROFILE_PIPELINE). */
export function mongoTopQuery(group: BsonDocument): TopQuery {
  const id = doc(group['_id']) ?? {};
  const ns = str(id['ns']) ?? '';
  const op = str(id['op']) ?? '';
  const calls = num(group['calls']) ?? 0;
  const total = num(group['totalMs']) ?? 0;
  const sample = group['sample'];
  const shape = id['shape'];
  const last = group['lastSeen'];
  return {
    id: `${ns}|${op}|${typeof shape === 'string' ? shape : hashText(toEjson(shape ?? null))}`,
    text: `${op} ${ns}${sample !== undefined ? ` ${shellText(sample)}` : ''}`,
    database: ns.includes('.') ? ns.slice(0, ns.indexOf('.')) : ns || null,
    user: str(group['user']),
    calls,
    totalMs: total,
    meanMs: calls > 0 ? total / calls : 0,
    maxMs: num(group['maxMs']),
    rows: num(group['rows']),
    detail: {
      op,
      ns,
      docsExamined: num(group['docsExamined']),
      keysExamined: num(group['keysExamined']),
      planSummary: str(group['planSummary']),
      lastSeen: isoOf(last),
    },
  };
}

/** A short stable hash of text (FNV-1a, 32 bits, hex). */
function hashText(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

const PROFILE_ORDER: Readonly<Record<TopQueryOrder, string>> = {
  total: 'totalMs',
  mean: 'meanMs',
  calls: 'calls',
  rows: 'rows',
  max: 'maxMs',
};

/** system.profile grouped by namespace, operation and query shape (the hash of 4.2 to 8.x). */
export function profilePipeline(order: TopQueryOrder, limit: number): BsonDocument[] {
  return [
    {
      $group: {
        _id: {
          ns: '$ns',
          op: '$op',
          shape: {
            $ifNull: [
              '$queryShapeHash',
              { $ifNull: ['$planCacheShapeHash', { $ifNull: ['$queryHash', '$command'] }] },
            ],
          },
        },
        calls: { $sum: 1 },
        totalMs: { $sum: '$millis' },
        maxMs: { $max: '$millis' },
        rows: { $sum: '$nreturned' },
        docsExamined: { $sum: '$docsExamined' },
        keysExamined: { $sum: '$keysExamined' },
        lastSeen: { $max: '$ts' },
        sample: { $last: '$command' },
        planSummary: { $last: '$planSummary' },
        user: { $last: '$user' },
      },
    },
    { $addFields: { meanMs: { $divide: ['$totalMs', '$calls'] } } },
    { $sort: { [PROFILE_ORDER[order]]: -1 } },
    { $limit: new Int32(limit) },
  ];
}

/** One getParameter entry (with showDetails, `detail` has value and settableAtRuntime). */
export function mongoSetting(name: string, entry: BsonValue, detailed: boolean): ServerSetting {
  const details = detailed ? doc(entry) : undefined;
  const value = details && 'value' in details ? details['value'] : entry;
  const runtime = details ? details['settableAtRuntime'] === true : true;
  const startup = details ? details['settableAtStartup'] === true : false;
  const tag = bsonTag(value);
  const type: ServerSetting['type'] =
    typeof value === 'boolean'
      ? 'bool'
      : tag === 'Int32' || tag === 'Long' || (typeof value === 'number' && Number.isInteger(value))
        ? 'integer'
        : tag === 'Double' || typeof value === 'number'
          ? 'real'
          : typeof value === 'string'
            ? 'string'
            : isBsonDocument(value) || Array.isArray(value)
              ? 'document'
              : null;
  return {
    name,
    value:
      typeof value === 'string'
        ? value
        : type === 'integer' || type === 'real'
          ? String(numberOf(value))
          : shellText(value ?? null, 4000),
    unit: null,
    category: null,
    description: null,
    source: null,
    type,
    enumValues: [],
    min: null,
    max: null,
    defaultValue: null,
    scopes: runtime ? ['global'] : [],
    restartRequired: !runtime && startup,
    pendingRestart: false,
  };
}

// ------------------------------------------------------------------------------- service

const MAINTENANCE: readonly MaintenanceOperationInfo[] = [
  {
    id: 'compact',
    label: 'compact',
    description:
      'Rewrites and defragments the collection and its indexes to release unused disk space.',
    multiple: false,
    options: [
      {
        id: 'force',
        label: 'force',
        description: 'Allows compact on a replica set primary on servers that require it.',
      },
    ],
  },
  {
    id: 'validate',
    label: 'validate',
    description: 'Checks the collection and its indexes for correctness.',
    multiple: false,
    options: [
      {
        id: 'full',
        label: 'full',
        description: 'A thorough check (slower; takes an exclusive lock on older servers).',
      },
    ],
  },
];

const SYSTEM_DATABASES = new Set(['admin', 'local', 'config']);

interface Planned {
  readonly db: string;
  readonly command: BsonDocument;
}

export class MongoServerTools implements ServerTools {
  readonly #session: MongoSession;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(session: MongoSession) {
    this.#session = session;
  }

  /** Runs `work` alone on the session: nothing else switches its database meanwhile. */
  #exclusive<T>(work: () => Promise<T>): Promise<T> {
    const next = this.#queue.then(work);
    this.#queue = next.catch(() => undefined);
    return next;
  }

  /** Runs a command document in `db`; cursor commands return every document. */
  async #documents(
    db: string,
    command: BsonDocument,
    signal?: AbortSignal,
  ): Promise<BsonDocument[]> {
    return this.#exclusive(async () => {
      const previous = this.#session.currentDatabase;
      if (db !== previous) await this.#session.useDatabase(checkDatabaseName(db));
      try {
        const out: BsonDocument[] = [];
        for await (const chunk of this.#session.execute(toEjson(command), {
          executionId: newId(),
          ...(signal ? { signal } : {}),
        })) {
          if (chunk.type !== 'rows') continue;
          for (const cell of chunk.data[0] ?? []) {
            const value = typeof cell === 'string' ? fromEjson(cell, 'reply') : null;
            if (isBsonDocument(value)) out.push(value);
          }
        }
        return out;
      } finally {
        if (db !== previous) await this.#session.useDatabase(previous).catch(() => undefined);
      }
    });
  }

  async #command(db: string, command: BsonDocument, signal?: AbortSignal): Promise<BsonDocument> {
    return (await this.#documents(db, command, signal))[0] ?? {};
  }

  async #databases(): Promise<string[]> {
    const reply = await this.#command('admin', {
      listDatabases: 1,
      nameOnly: true,
      authorizedDatabases: true,
    });
    const list = Array.isArray(reply['databases']) ? reply['databases'] : [];
    return list
      .map((d) => str(doc(d as BsonValue)?.['name']))
      .filter((name): name is string => name !== null)
      .sort();
  }

  async info(): Promise<ServerToolsInfo> {
    const server = await this.#session.serverInfo();
    const status = await this.#command('admin', { connectionStatus: 1 }).catch(
      () => ({}) as BsonDocument,
    );
    const users = path(status, 'authInfo', 'authenticatedUsers');
    const first = Array.isArray(users) ? doc(users[0] as BsonValue) : undefined;
    const databases = await this.#databases().catch(() => []);
    const notices: ServerNotice[] = [];
    if (server.topology === 'sharded') {
      notices.push({
        level: 'info',
        message:
          "Connected to a mongos: the monitor and operations are the mongos's, and the profiler, compact and validate run on each shard's mongod",
      });
    }
    return {
      engine: 'mongodb',
      product: 'MongoDB',
      version: server.version,
      user: first ? `${str(first['user']) ?? ''}@${str(first['db']) ?? ''}` : '',
      database: this.#session.currentDatabase,
      databases,
      perDatabaseSessions: false,
      sessionActions: [
        {
          operation: 'cancel',
          label: 'Kill operation',
          description: 'killOp: the operation stops at its next interrupt point.',
        },
      ],
      maintenance: MAINTENANCE,
      settingScopes: [
        {
          scope: 'global',
          label: 'Running server (setParameter)',
          description: 'Changes the parameter until the server restarts.',
        },
      ],
      topQueryOrders: ['total', 'mean', 'calls', 'rows', 'max'],
      access: [],
      notices,
    };
  }

  async monitor(): Promise<MonitorSnapshot> {
    const at = Date.now();
    const status = await this.#command('admin', {
      serverStatus: 1,
      metrics: 0,
      locks: 0,
      tcmalloc: 0,
    });
    const notices: ServerNotice[] = [];
    let replSet: BsonDocument | null = null;
    try {
      replSet = await this.#command('admin', { replSetGetStatus: 1 });
    } catch (error) {
      const code = error instanceof QuerybaraError ? error.engineCode : undefined;
      if (code === 'Unauthorized') {
        notices.push({
          level: 'info',
          message: 'Replica set status needs the clusterMonitor role',
        });
      }
    }
    let oplog: MongoMonitorInput['oplog'] = null;
    if (replSet) {
      try {
        const edge = async (direction: 1 | -1): Promise<number | null> => {
          const [entry] = await this.#documents('local', {
            find: 'oplog.rs',
            filter: {},
            sort: { $natural: new Int32(direction) },
            limit: new Int32(1),
            projection: { ts: new Int32(1) },
          });
          return timestampSeconds(entry?.['ts']);
        };
        const first = await edge(1);
        const last = await edge(-1);
        const [stats] = await this.#documents('local', {
          aggregate: 'oplog.rs',
          pipeline: [{ $collStats: { storageStats: {} } }],
          cursor: {},
        });
        oplog = {
          first,
          last,
          size: num(path(stats, 'storageStats', 'size')),
          maxSize: num(path(stats, 'storageStats', 'maxSize')),
        };
      } catch (error) {
        notices.push({
          level: 'info',
          message: `The oplog could not be read: ${error instanceof Error ? error.message : String(error)}`,
          hint: 'Reading local.oplog.rs needs the clusterMonitor role',
        });
      }
    }
    return mongoMonitorSnapshot(at, { status, replSet, oplog, notices });
  }

  async sessions(options: SessionListOptions = {}): Promise<SessionList> {
    const limit = Math.max(1, Math.min(options.limit ?? 1000, 10_000));
    const run = (allUsers: boolean): Promise<BsonDocument[]> =>
      this.#documents('admin', {
        aggregate: new Int32(1),
        pipeline: [
          {
            $currentOp: {
              allUsers,
              idleConnections: options.includeIdle ?? true,
              idleSessions: false,
            },
          },
          { $limit: new Int32(limit + 1) },
        ],
        cursor: {},
        comment: OWN_COMMENT,
      });
    const notices: ServerNotice[] = [];
    let ops: BsonDocument[];
    try {
      ops = await run(true);
    } catch (error) {
      if (!(error instanceof QuerybaraError) || error.engineCode !== 'Unauthorized') throw error;
      ops = await run(false);
      notices.push({
        level: 'info',
        message: "Only this user's own operations are listed",
        hint: 'The inprog privilege (clusterMonitor role) shows every operation',
      });
    }
    const sessions = ops
      .map(mongoSession)
      .filter((s) => (options.includeBackground ?? false) || !s.background);
    return {
      sessions: sessions.slice(0, limit),
      detailColumns: MONGO_SESSION_DETAIL_COLUMNS,
      notices,
      truncated: ops.length > limit,
    };
  }

  async #profileDatabase(requested: string | undefined): Promise<string> {
    if (requested !== undefined) return checkDatabaseName(requested);
    const current = this.#session.currentDatabase;
    if (!SYSTEM_DATABASES.has(current)) return current;
    const databases = await this.#databases().catch(() => []);
    return databases.find((d) => !SYSTEM_DATABASES.has(d)) ?? current;
  }

  async topQueries(options: TopQueryOptions = {}): Promise<TopQueries> {
    const database = await this.#profileDatabase(options.database);
    const base = {
      queries: [],
      detailColumns: [],
      notices: [],
      resettable: false,
    } satisfies Omit<TopQueries, 'unavailable' | 'profiler'>;
    let status: BsonDocument;
    try {
      status = await this.#command(database, { profile: new Int32(-1) });
    } catch (error) {
      if (error instanceof QuerybaraError && error.engineCode === 'Unauthorized') {
        return {
          ...base,
          profiler: null,
          unavailable: {
            reason: 'no-privilege',
            message: `This user cannot read the profiler settings of "${database}"`,
            hint: 'The dbAdmin role on the database (the enableProfiler action) allows it',
          },
        };
      }
      throw error;
    }
    const level = num(status['was']);
    const profiler: ProfilerStatus = {
      database,
      level: level === 1 || level === 2 ? level : 0,
      slowMs: num(status['slowms']),
      sampleRate: num(status['sampleRate']),
    };
    let groups: BsonDocument[];
    try {
      groups = await this.#documents(database, {
        aggregate: 'system.profile',
        pipeline: profilePipeline(
          options.orderBy ?? 'total',
          Math.max(1, Math.min(options.limit ?? 100, 1000)),
        ),
        cursor: {},
      });
    } catch (error) {
      if (error instanceof QuerybaraError && error.engineCode === 'Unauthorized') {
        return {
          ...base,
          profiler,
          unavailable: {
            reason: 'no-privilege',
            message: `This user cannot read ${database}.system.profile`,
            hint: 'The dbAdmin role on the database allows reading the profiler output',
          },
        };
      }
      throw error;
    }
    const queries = groups.map(mongoTopQuery);
    return {
      ...base,
      profiler,
      queries,
      resettable: true,
      unavailable:
        profiler.level === 0 && queries.length === 0
          ? {
              reason: 'disabled',
              message: `The profiler is off for "${database}"`,
              hint: 'Turn it on for slow operations; it records to system.profile, a small capped collection',
              fix: {
                kind: 'profiler',
                database,
                level: 1,
                ...(profiler.slowMs !== null ? { slowMs: profiler.slowMs } : {}),
              },
            }
          : null,
      detailColumns: [
        { key: 'docsExamined', label: 'Documents examined', unit: 'count' },
        { key: 'keysExamined', label: 'Keys examined', unit: 'count' },
        { key: 'planSummary', label: 'Plan' },
        { key: 'lastSeen', label: 'Last seen', unit: 'time' },
      ],
    };
  }

  accounts(): Promise<AccessOverview> {
    return Promise.reject(usersElsewhere());
  }

  grants(): Promise<GrantMatrix> {
    return Promise.reject(usersElsewhere());
  }

  accessDetails(): Promise<AccessDetails> {
    return Promise.reject(usersElsewhere());
  }

  async maintenanceTargets(container?: string): Promise<MaintenanceTargets> {
    const databases = await this.#databases();
    const current = this.#session.currentDatabase;
    const database =
      container !== undefined
        ? checkDatabaseName(container)
        : databases.includes(current) && !SYSTEM_DATABASES.has(current)
          ? current
          : (databases.find((d) => !SYSTEM_DATABASES.has(d)) ?? current);
    const listed = await this.#documents(database, {
      listCollections: 1,
      filter: { type: 'collection' },
      cursor: {},
    });
    const names = listed
      .map((c) => str(c['name']))
      .filter((name): name is string => name !== null && !name.startsWith('system.'))
      .sort();
    const targets = [];
    for (const [index, name] of names.entries()) {
      let stats: BsonDocument | undefined;
      // Sizes for the first 200 collections; a larger database lists the rest by name only.
      if (index < 200) {
        const [row] = await this.#documents(database, {
          aggregate: name,
          pipeline: [{ $collStats: { storageStats: {} } }],
          cursor: {},
        }).catch(() => [] as BsonDocument[]);
        stats = doc(row?.['storageStats']);
      }
      targets.push({
        container: database,
        name,
        type: 'collection',
        indexes: [],
        detail: {
          documents: num(stats?.['count']),
          size: num(stats?.['size']),
          storage: num(stats?.['storageSize']),
          free: num(stats?.['freeStorageSize']),
          indexes: num(stats?.['totalIndexSize']),
        } satisfies Record<string, ToolCell>,
      });
    }
    return {
      containers: databases,
      container: database,
      targets,
      detailColumns: [
        { key: 'documents', label: 'Documents', unit: 'count' },
        { key: 'size', label: 'Data', unit: 'bytes' },
        { key: 'storage', label: 'On disk', unit: 'bytes' },
        { key: 'free', label: 'Reusable', unit: 'bytes' },
        { key: 'indexes', label: 'Indexes', unit: 'bytes' },
      ],
      notices: [],
    };
  }

  async settings(): Promise<SettingList> {
    let reply: BsonDocument;
    let detailed = true;
    try {
      reply = await this.#command('admin', {
        getParameter: { showDetails: true, allParameters: true },
      });
    } catch {
      detailed = false;
      reply = await this.#command('admin', { getParameter: '*' });
    }
    const settings = Object.entries(reply)
      .filter(([name]) => name !== 'ok' && !name.startsWith('$') && name !== 'operationTime')
      .map(([name, entry]) => mongoSetting(name, entry, detailed))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return {
      settings,
      notices: detailed
        ? []
        : [
            {
              level: 'info',
              message: 'This server does not say which parameters can change at runtime',
            },
          ],
    };
  }

  // ----------------------------------------------------------------------------- actions

  #plan(action: ServerAction): Planned[] {
    switch (action.kind) {
      case 'session': {
        if (action.operation !== 'cancel') {
          throw notSupported('MongoDB kills operations, not connections', 'Use Kill operation');
        }
        return [{ db: 'admin', command: { killOp: new Int32(1), op: opidOf(action.id) } }];
      }
      case 'maintenance': {
        if (action.operation !== 'compact' && action.operation !== 'validate') {
          throw notSupported(`MongoDB has no ${action.operation} command; use compact or validate`);
        }
        if (action.targets.length === 0) throw invalid('Pick at least one collection');
        const allowed = action.operation === 'compact' ? ['force'] : ['full'];
        for (const option of action.options) {
          if (!allowed.includes(option))
            throw invalid(`${action.operation} has no option "${option}"`);
        }
        return action.targets.map((target) => ({
          db: checkDatabaseName(target.container),
          command:
            action.operation === 'compact'
              ? {
                  compact: checkCollectionName(target.name),
                  ...(action.options.includes('force') ? { force: true } : {}),
                }
              : {
                  validate: checkCollectionName(target.name),
                  ...(action.options.includes('full') ? { full: true } : {}),
                },
        }));
      }
      case 'setting': {
        if (action.scope !== 'global') {
          throw notSupported('MongoDB parameters are set on the running server (setParameter)');
        }
        if (action.value === null) {
          throw notSupported(
            'MongoDB cannot reset a parameter',
            'Set the default value explicitly',
          );
        }
        if (!/^[A-Za-z_][A-Za-z0-9_.]*$/.test(action.name)) {
          throw invalid(`"${action.name}" is not a parameter name`);
        }
        let value: BsonValue;
        try {
          value = parseShell(action.value);
        } catch {
          // Plain text that is not a shell literal is a string value.
          value = action.value;
        }
        return [{ db: 'admin', command: { setParameter: new Int32(1), [action.name]: value } }];
      }
      case 'profiler': {
        const database = checkDatabaseName(action.database);
        if (
          action.slowMs !== undefined &&
          (!Number.isInteger(action.slowMs) || action.slowMs < 0)
        ) {
          throw invalid('slowms must be a whole number of milliseconds');
        }
        if (action.sampleRate !== undefined && !(action.sampleRate > 0 && action.sampleRate <= 1)) {
          throw invalid('The sample rate must be above 0 and at most 1');
        }
        return [
          {
            db: database,
            command: {
              profile: new Int32(action.level),
              ...(action.slowMs !== undefined ? { slowms: new Int32(action.slowMs) } : {}),
              ...(action.sampleRate !== undefined ? { sampleRate: action.sampleRate } : {}),
            },
          },
        ];
      }
      case 'topQueries':
        throw notSupported(
          action.operation === 'reset'
            ? 'Reset the profiler of a database from its top queries'
            : 'Turn the profiler on from its top queries',
        );
      default:
        throw usersElsewhere();
    }
  }

  /** Clearing system.profile: the profiler must be off while it is dropped, then restored. */
  async #resetPlan(database: string): Promise<Planned[]> {
    const status = await this.#command(database, { profile: new Int32(-1) });
    const level = num(status['was']) ?? 0;
    return [
      { db: database, command: { profile: new Int32(0) } },
      { db: database, command: { drop: 'system.profile' } },
      ...(level > 0
        ? [
            {
              db: database,
              command: {
                profile: new Int32(level),
                ...(num(status['slowms']) !== null
                  ? { slowms: new Int32(num(status['slowms'])!) }
                  : {}),
              },
            },
          ]
        : []),
    ];
  }

  async #planned(action: ServerAction): Promise<Planned[]> {
    if (action.kind === 'topQueries' && action.operation === 'reset') {
      return this.#resetPlan(await this.#profileDatabase(action.database));
    }
    return this.#plan(action);
  }

  async preview(action: ServerAction): Promise<ActionPreview> {
    const planned = await this.#planned(action);
    const notices: ServerNotice[] = [];
    if (action.kind === 'maintenance' && action.operation === 'compact') {
      notices.push({
        level: 'warning',
        message: 'compact can take a long time on a large collection and adds load while it runs',
      });
    }
    if (action.kind === 'profiler' && action.level === 2) {
      notices.push({
        level: 'warning',
        message: 'Level 2 records every operation: it slows the server down; use it briefly',
      });
    }
    return {
      ...describeMongoAction(action),
      statements: planned.map((p) => commandText(p.db, p.command)),
      notices,
    };
  }

  async run(action: ServerAction, options: { signal?: AbortSignal } = {}): Promise<ActionResult> {
    const started = performance.now();
    const planned = await this.#planned(action);
    const messages: ServerNotice[] = [];
    const rows: Record<string, ToolCell>[] = [];
    for (const step of planned) {
      let reply: BsonDocument;
      try {
        reply = await this.#command(step.db, step.command, options.signal);
      } catch (error) {
        // Dropping a system.profile that does not exist yet is fine.
        if (
          'drop' in step.command &&
          error instanceof QuerybaraError &&
          error.code === 'NOT_FOUND'
        ) {
          continue;
        }
        throw enrichMongoError(error, action);
      }
      if ('validate' in step.command) {
        const errors = Array.isArray(reply['errors']) ? reply['errors'].map(String) : [];
        const warnings = Array.isArray(reply['warnings']) ? reply['warnings'].map(String) : [];
        rows.push({
          collection: `${step.db}.${String(step.command['validate'])}`,
          valid: reply['valid'] === true,
          records: num(reply['nrecords']),
          indexes: num(reply['nIndexes']),
          errors: errors.join('; ') || null,
          warnings: warnings.join('; ') || null,
        });
        for (const e of errors) messages.push({ level: 'error', message: e });
        for (const w of warnings) messages.push({ level: 'warning', message: w });
      }
      if ('compact' in step.command) {
        const freed = num(reply['bytesFreed']);
        messages.push({
          level: 'info',
          message: `compact ${step.db}.${String(step.command['compact'])}${
            freed !== null ? `: ${freed} bytes freed` : ''
          }`,
        });
      }
    }
    const table: ToolTable | null =
      rows.length > 0
        ? {
            columns: [
              { key: 'collection', label: 'Collection' },
              { key: 'valid', label: 'Valid', unit: 'bool' },
              { key: 'records', label: 'Records', unit: 'count' },
              { key: 'indexes', label: 'Indexes', unit: 'count' },
              { key: 'errors', label: 'Errors' },
              { key: 'warnings', label: 'Warnings' },
            ],
            rows,
          }
        : null;
    messages.unshift({ level: 'info', message: `${describeMongoAction(action).done}.` });
    return {
      statements: planned.map((p) => commandText(p.db, p.command)),
      messages,
      table,
      durationMs: Math.round(performance.now() - started),
    };
  }
}

function usersElsewhere(): QuerybaraError {
  return notSupported(
    'MongoDB users and roles have their own editor',
    'Open Users and roles from a database in the explorer',
  );
}

/** An operation id: a number, or "shard:number" on a mongos. */
export function opidOf(id: string): BsonValue {
  if (/^-?\d{1,18}$/.test(id)) {
    const n = Number(id);
    return Number.isSafeInteger(n) && Math.abs(n) <= 2147483647
      ? new Int32(n)
      : Long.fromString(id);
  }
  if (/^[A-Za-z0-9_.-]{1,200}:\d{1,18}$/.test(id)) return id;
  throw invalid(`"${id}" is not an operation id`);
}

/** Hints for the roles MongoDB actions need. */
export function enrichMongoError(error: unknown, action: ServerAction): unknown {
  if (!(error instanceof QuerybaraError) || error.engineCode !== 'Unauthorized') return error;
  const hint =
    action.kind === 'session'
      ? "Killing another user's operation needs the killop action (clusterMonitor or hostManager role)"
      : action.kind === 'maintenance'
        ? action.operation === 'compact'
          ? 'compact needs the compact action (dbAdmin or hostManager role)'
          : 'validate needs the validate action (dbAdmin role)'
        : action.kind === 'setting'
          ? 'setParameter needs the hostManager or clusterManager role; managed services often refuse it'
          : action.kind === 'profiler' || action.kind === 'topQueries'
            ? 'The profiler needs the enableProfiler action (dbAdmin role on the database)'
            : error.hint;
  return new QuerybaraError({ ...error.toJSON(), ...(hint !== undefined ? { hint } : {}) });
}

export function describeMongoAction(action: ServerAction): {
  title: string;
  summary: string;
  done: string;
} {
  switch (action.kind) {
    case 'session':
      return {
        title: `Kill operation ${action.id}?`,
        summary: 'The operation stops at its next interrupt point; the connection stays open.',
        done: `Asked the server to kill operation ${action.id}`,
      };
    case 'maintenance':
      return {
        title: `Run ${action.operation}?`,
        summary: `On ${action.targets.map((t) => `${t.container}.${t.name}`).join(', ')}.`,
        done: `${action.operation} finished`,
      };
    case 'setting':
      return {
        title: `Change ${action.name}?`,
        summary: `${action.name} becomes ${action.value ?? ''} until the server restarts.`,
        done: `Set ${action.name}`,
      };
    case 'profiler':
      return {
        title: `${action.level === 0 ? 'Turn off' : 'Set'} the profiler of ${action.database}?`,
        summary:
          action.level === 0
            ? 'Operations stop being recorded; system.profile keeps what it has.'
            : action.level === 1
              ? `Operations slower than ${action.slowMs ?? 'slowms'} ms are recorded in system.profile.`
              : 'Every operation is recorded in system.profile.',
        done: 'The profiler was changed',
      };
    case 'topQueries':
      return {
        title: 'Clear the profiler output?',
        summary: 'system.profile is dropped (the profiler is paused around it).',
        done: 'The profiler output was cleared',
      };
    default:
      return { title: action.kind, summary: '', done: action.kind };
  }
}

/** The server tools of a MongoDB session. */
export function createMongoServerTools(session: Session): ServerTools {
  if (!isMongoSession(session)) {
    throw notSupported('This is not a MongoDB session');
  }
  return new MongoServerTools(session);
}
