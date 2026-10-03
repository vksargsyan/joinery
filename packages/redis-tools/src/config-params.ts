/**
 * What Querybara knows about the common Redis and Valkey configuration parameters (spec §10, §15):
 * a description, the value's type and unit, the allowed values, whether CONFIG SET can change it
 * while the server runs, and the default where it is the same on Redis 6.2 to 8.0 and Valkey.
 * The configuration editor uses it for grouping, validation and typed editors; parameters it
 * does not list (newer servers, modules) still show and edit as plain strings.
 */

/** How a value is written: CONFIG GET returns every value as text. */
export type ConfigValueType = 'number' | 'bytes' | 'boolean' | 'enum' | 'string' | 'list';

/** The unit of a number, for labels ("ms") and friendly values. */
export type ConfigUnit = 'ms' | 's' | 'µs' | 'min' | 'bytes' | '%' | 'Hz' | 'count';

export type ConfigGroupId =
  | 'memory'
  | 'persistence'
  | 'replication'
  | 'clients'
  | 'security'
  | 'latency'
  | 'cluster'
  | 'encoding'
  | 'general'
  | 'advanced';

/** The editor's groups, in display order. */
export const CONFIG_GROUPS: readonly { readonly id: ConfigGroupId; readonly title: string }[] = [
  { id: 'memory', title: 'Memory and eviction' },
  { id: 'persistence', title: 'Persistence' },
  { id: 'replication', title: 'Replication' },
  { id: 'clients', title: 'Clients and network' },
  { id: 'security', title: 'Security and TLS' },
  { id: 'latency', title: 'Latency and slow log' },
  { id: 'cluster', title: 'Cluster' },
  { id: 'encoding', title: 'Data structures' },
  { id: 'general', title: 'General' },
  { id: 'advanced', title: 'Advanced' },
];

export interface ConfigParameterMeta {
  readonly name: string;
  readonly group: ConfigGroupId;
  readonly type: ConfigValueType;
  readonly description: string;
  readonly unit?: ConfigUnit;
  /** `enum`: the values; `list`: the words an item may be, when they are fixed. */
  readonly values?: readonly string[];
  /** Bounds of a number (inclusive). */
  readonly min?: number;
  readonly max?: number;
  /** `bytes`: a percentage (of maxmemory) is accepted too. */
  readonly percent?: boolean;
  /** CONFIG SET can change it while the server runs (otherwise only at startup). */
  readonly mutable: boolean;
  /** The first version whose CONFIG SET accepts it (earlier ones set it at startup only). */
  readonly mutableSince?: string;
  /** Redis 7+ refuses to change it unless enable-protected-configs allows it. */
  readonly protected?: boolean;
  /** The default, given only where Redis 6.2 to 8.0 and Valkey agree on it. */
  readonly default?: string;
  /** A password: never read out, set only through a password field. */
  readonly secret?: boolean;
  /** Other names of the same parameter (older or newer); some versions list both. */
  readonly aliases?: readonly string[];
  /** Why a change can lock clients out or move data: it is confirmed as destructive. */
  readonly disruptive?: string;
  /** The first version that has it. */
  readonly since?: string;
}

type Def = Omit<ConfigParameterMeta, 'name' | 'group' | 'mutable'> & {
  readonly mutable?: boolean;
};

const YES_NO = ['yes', 'no'];
const EVICTION = [
  'noeviction',
  'allkeys-lru',
  'allkeys-lfu',
  'allkeys-random',
  'volatile-lru',
  'volatile-lfu',
  'volatile-random',
  'volatile-ttl',
];
const LOCKOUT = 'can lock clients out of the server';
const REPLICATION_AUTH = 'changes how this server authenticates to its primary';
const DATA_FILES = 'changes where the server writes its data files';

function group(id: ConfigGroupId, defs: Readonly<Record<string, Def>>): ConfigParameterMeta[] {
  return Object.entries(defs).map(([name, def]) => ({
    ...def,
    name,
    group: id,
    mutable: def.mutable ?? true,
    ...(def.type === 'boolean' ? { values: YES_NO } : {}),
  }));
}

const PARAMETERS: readonly ConfigParameterMeta[] = [
  ...group('memory', {
    maxmemory: {
      type: 'bytes',
      unit: 'bytes',
      description:
        'Memory limit for the dataset; once reached, keys are evicted as maxmemory-policy says (0 = no limit)',
      default: '0',
    },
    'maxmemory-policy': {
      type: 'enum',
      values: EVICTION,
      description: 'What to evict when maxmemory is reached (noeviction refuses writes instead)',
      default: 'noeviction',
    },
    'maxmemory-samples': {
      type: 'number',
      unit: 'count',
      min: 1,
      max: 64,
      description:
        'Keys sampled per eviction by the LRU, LFU and TTL policies (more is precise but slower)',
      default: '5',
    },
    'maxmemory-eviction-tenacity': {
      type: 'number',
      unit: '%',
      min: 0,
      max: 100,
      description: 'How long an eviction cycle may run (100 evicts regardless of latency)',
      default: '10',
      since: '6.2.0',
    },
    'maxmemory-clients': {
      type: 'bytes',
      unit: 'bytes',
      percent: true,
      description:
        'Memory all client connections may use before the largest are closed (0 = no limit; a percentage is of maxmemory)',
      default: '0',
      since: '7.0.0',
    },
    'lfu-log-factor': {
      type: 'number',
      min: 0,
      description: 'Logarithmic factor of the LFU counter: higher needs more hits to saturate it',
      default: '10',
    },
    'lfu-decay-time': {
      type: 'number',
      unit: 'min',
      min: 0,
      description: 'Minutes after which an idle key’s LFU counter is halved (0 = never)',
      default: '1',
    },
    'active-expire-effort': {
      type: 'number',
      min: 1,
      max: 10,
      description: 'Effort spent expiring keys in the background (1 to 10; more uses more CPU)',
      default: '1',
    },
    'lazyfree-lazy-eviction': {
      type: 'boolean',
      description: 'Free evicted keys in a background thread',
    },
    'lazyfree-lazy-expire': {
      type: 'boolean',
      description: 'Free expired keys in a background thread',
    },
    'lazyfree-lazy-server-del': {
      type: 'boolean',
      description:
        'Free values the server itself deletes or replaces (RENAME, SET over a key…) in a background thread',
    },
    'lazyfree-lazy-user-del': {
      type: 'boolean',
      description: 'Make DEL free memory in the background, like UNLINK',
    },
    'lazyfree-lazy-user-flush': {
      type: 'boolean',
      description: 'Make FLUSHALL and FLUSHDB without a mode flush in the background',
      since: '6.2.0',
    },
    activedefrag: {
      type: 'boolean',
      description: 'Active defragmentation (needs a server built with jemalloc)',
      default: 'no',
    },
    'active-defrag-ignore-bytes': {
      type: 'bytes',
      unit: 'bytes',
      description: 'Fragmentation waste below which defragmentation does not start',
      default: '104857600',
    },
    'active-defrag-threshold-lower': {
      type: 'number',
      unit: '%',
      min: 0,
      max: 1000,
      description: 'Fragmentation percentage at which defragmentation starts',
      default: '10',
    },
    'active-defrag-threshold-upper': {
      type: 'number',
      unit: '%',
      min: 0,
      max: 1000,
      description: 'Fragmentation percentage at which defragmentation uses its maximum effort',
      default: '100',
    },
    'active-defrag-cycle-min': {
      type: 'number',
      unit: '%',
      min: 1,
      max: 99,
      description: 'Minimal CPU effort of defragmentation',
    },
    'active-defrag-cycle-max': {
      type: 'number',
      unit: '%',
      min: 1,
      max: 99,
      description: 'Maximal CPU effort of defragmentation',
    },
    'active-defrag-max-scan-fields': {
      type: 'number',
      unit: 'count',
      min: 1,
      description:
        'Largest set, hash, sorted set or list defragmented in one step of the main scan',
      default: '1000',
    },
    'jemalloc-bg-thread': {
      type: 'boolean',
      description: 'Return freed memory to the system from a jemalloc background thread',
      default: 'yes',
    },
    'oom-score-adj': {
      type: 'enum',
      values: ['no', 'yes', 'relative', 'absolute'],
      description: 'Let the server set the Linux OOM-killer score of its processes',
      default: 'no',
    },
    'oom-score-adj-values': {
      type: 'list',
      description: 'OOM score adjustments for the primary, replicas and background children',
      default: '0 200 800',
    },
  }),
  ...group('persistence', {
    save: {
      type: 'list',
      description:
        'RDB snapshot points: pairs of seconds and changes ("3600 1 300 100"); empty turns snapshots off',
      default: '3600 1 300 100 60 10000',
    },
    appendonly: {
      type: 'boolean',
      description:
        'Append-only file persistence (turning it on rewrites the AOF in the background)',
      default: 'no',
    },
    appendfsync: {
      type: 'enum',
      values: ['always', 'everysec', 'no'],
      description: 'When the AOF is flushed to disk: after every write, every second, or by the OS',
      default: 'everysec',
    },
    appendfilename: {
      type: 'string',
      mutable: false,
      description: 'Base name of the append-only file',
      default: 'appendonly.aof',
    },
    appenddirname: {
      type: 'string',
      mutable: false,
      description: 'Directory (inside dir) that holds the multi-part AOF',
      default: 'appendonlydir',
      since: '7.0.0',
    },
    'auto-aof-rewrite-percentage': {
      type: 'number',
      unit: '%',
      min: 0,
      description:
        'Rewrite the AOF once it grew by this percentage since the last rewrite (0 = never)',
      default: '100',
    },
    'auto-aof-rewrite-min-size': {
      type: 'bytes',
      unit: 'bytes',
      description: 'Smallest AOF that is rewritten automatically',
      default: '67108864',
    },
    'aof-load-truncated': {
      type: 'boolean',
      description: 'Load a truncated AOF at startup instead of refusing to start',
      default: 'yes',
    },
    'aof-use-rdb-preamble': {
      type: 'boolean',
      description: 'Start rewritten AOFs with an RDB snapshot (faster rewrites and loading)',
      default: 'yes',
    },
    'aof-timestamp-enabled': {
      type: 'boolean',
      description: 'Write timestamps into the AOF, for point-in-time recovery',
      default: 'no',
      since: '7.0.0',
    },
    'aof-rewrite-incremental-fsync': {
      type: 'boolean',
      description: 'fsync every 4 MB while rewriting the AOF',
      default: 'yes',
    },
    'no-appendfsync-on-rewrite': {
      type: 'boolean',
      description:
        'Skip fsync of the AOF while a save or rewrite runs (less latency, less durability)',
      default: 'no',
    },
    'rdb-save-incremental-fsync': {
      type: 'boolean',
      description: 'fsync every 4 MB while saving an RDB file',
      default: 'yes',
    },
    dbfilename: {
      type: 'string',
      protected: true,
      disruptive: DATA_FILES,
      description: 'Name of the RDB file',
      default: 'dump.rdb',
    },
    dir: {
      type: 'string',
      protected: true,
      disruptive: DATA_FILES,
      description: 'Working directory: where RDB and AOF files are written',
    },
    rdbcompression: {
      type: 'boolean',
      description: 'Compress strings in RDB files with LZF',
      default: 'yes',
    },
    rdbchecksum: {
      type: 'boolean',
      description: 'Append a CRC64 checksum to RDB files',
      default: 'yes',
    },
    'stop-writes-on-bgsave-error': {
      type: 'boolean',
      description: 'Refuse writes while the last background save has failed',
      default: 'yes',
    },
    'rdb-del-sync-files': {
      type: 'boolean',
      description: 'Delete the RDB files used for replication when persistence is off',
      default: 'no',
    },
  }),
  ...group('replication', {
    replicaof: {
      type: 'string',
      mutable: false,
      aliases: ['slaveof'],
      description: 'The primary this server replicates ("host port"); changed with REPLICAOF',
    },
    masterauth: {
      type: 'string',
      secret: true,
      aliases: ['primaryauth'],
      disruptive: REPLICATION_AUTH,
      description: 'Password this server uses to authenticate to its primary',
    },
    masteruser: {
      type: 'string',
      aliases: ['primaryuser'],
      disruptive: REPLICATION_AUTH,
      description: 'ACL user this server authenticates to its primary as',
    },
    'replica-read-only': {
      type: 'boolean',
      aliases: ['slave-read-only'],
      description: 'Refuse writes from clients while this server is a replica',
      default: 'yes',
    },
    'replica-serve-stale-data': {
      type: 'boolean',
      aliases: ['slave-serve-stale-data'],
      description: 'Answer queries with possibly stale data while the link to the primary is down',
      default: 'yes',
    },
    'replica-priority': {
      type: 'number',
      min: 0,
      aliases: ['slave-priority'],
      description:
        'Sentinel and Cluster promote the replica with the lowest priority first (0 = never)',
      default: '100',
    },
    'replica-lazy-flush': {
      type: 'boolean',
      aliases: ['slave-lazy-flush'],
      description: 'Free the old dataset in the background after a full resynchronisation',
    },
    'replica-ignore-maxmemory': {
      type: 'boolean',
      aliases: ['slave-ignore-maxmemory'],
      description: 'Replicas ignore maxmemory and leave eviction to the primary',
      default: 'yes',
    },
    'replica-announce-ip': {
      type: 'string',
      aliases: ['slave-announce-ip'],
      description: 'Address this replica reports to its primary (behind NAT)',
      default: '',
    },
    'replica-announce-port': {
      type: 'number',
      min: 0,
      max: 65535,
      aliases: ['slave-announce-port'],
      description: 'Port this replica reports to its primary (0 = the real one)',
      default: '0',
    },
    'replica-announced': {
      type: 'boolean',
      description: 'List this replica in Sentinel replies',
      default: 'yes',
      since: '6.2.0',
    },
    'repl-backlog-size': {
      type: 'bytes',
      unit: 'bytes',
      description: 'Backlog that lets a reconnecting replica resynchronise partially',
    },
    'repl-backlog-ttl': {
      type: 'number',
      unit: 's',
      min: 0,
      description: 'Seconds without replicas after which the backlog is freed (0 = never)',
      default: '3600',
    },
    'repl-timeout': {
      type: 'number',
      unit: 's',
      min: 1,
      description: 'Replication timeout',
      default: '60',
    },
    'repl-ping-replica-period': {
      type: 'number',
      unit: 's',
      min: 1,
      aliases: ['repl-ping-slave-period'],
      description: 'Seconds between the pings a primary sends its replicas',
      default: '10',
    },
    'repl-diskless-sync': {
      type: 'boolean',
      description: 'Send the RDB to replicas over the socket instead of through a file',
    },
    'repl-diskless-sync-delay': {
      type: 'number',
      unit: 's',
      min: 0,
      description: 'Seconds to wait for more replicas before a diskless transfer starts',
      default: '5',
    },
    'repl-diskless-sync-max-replicas': {
      type: 'number',
      unit: 'count',
      min: 0,
      description:
        'Start a diskless transfer as soon as this many replicas wait (0 = only the delay)',
      default: '0',
      since: '7.0.0',
    },
    'repl-diskless-load': {
      type: 'enum',
      values: ['disabled', 'on-empty-db', 'swapdb'],
      description:
        'How a replica loads the RDB it receives: through a file, or straight from the socket',
      default: 'disabled',
    },
    'repl-disable-tcp-nodelay': {
      type: 'boolean',
      description: 'Batch replication traffic (less bandwidth, more lag)',
      default: 'no',
    },
    'min-replicas-to-write': {
      type: 'number',
      unit: 'count',
      min: 0,
      aliases: ['min-slaves-to-write'],
      description:
        'Refuse writes unless this many replicas lag at most min-replicas-max-lag (0 = off)',
      default: '0',
    },
    'min-replicas-max-lag': {
      type: 'number',
      unit: 's',
      min: 0,
      aliases: ['min-slaves-max-lag'],
      description: 'Largest replica lag min-replicas-to-write counts',
      default: '10',
    },
  }),
  ...group('clients', {
    maxclients: {
      type: 'number',
      unit: 'count',
      min: 1,
      description: 'Most clients connected at once',
      default: '10000',
    },
    timeout: {
      type: 'number',
      unit: 's',
      min: 0,
      description: 'Close a client idle this many seconds (0 = never)',
      default: '0',
    },
    'tcp-keepalive': {
      type: 'number',
      unit: 's',
      min: 0,
      description: 'TCP keepalive interval for client connections (0 = off)',
      default: '300',
    },
    'client-output-buffer-limit': {
      type: 'list',
      description:
        'Output buffer limits per client class: class, hard limit, soft limit, soft seconds (normal, replica, pubsub)',
    },
    'client-query-buffer-limit': {
      type: 'bytes',
      unit: 'bytes',
      description: 'Largest query buffer of one client',
      default: '1073741824',
    },
    'proto-max-bulk-len': {
      type: 'bytes',
      unit: 'bytes',
      description: 'Largest bulk string a client may send',
      default: '536870912',
    },
    'tracking-table-max-keys': {
      type: 'number',
      unit: 'count',
      min: 0,
      description: 'Keys remembered for client-side caching (0 = no limit)',
      default: '1000000',
    },
    'notify-keyspace-events': {
      type: 'string',
      description:
        'Keyspace notifications published over Pub/Sub, as flag letters (K, E, g, $, l, s, h, z, x, e, t, m, d, n or A); empty = off',
      default: '',
    },
    bind: {
      type: 'list',
      mutableSince: '7.0.0',
      disruptive: LOCKOUT,
      description: 'Interfaces the server listens on',
    },
    port: {
      type: 'number',
      min: 0,
      max: 65535,
      mutableSince: '7.0.0',
      disruptive: LOCKOUT,
      description: 'TCP port the server listens on (0 = no TCP)',
    },
    'tcp-backlog': {
      type: 'number',
      unit: 'count',
      mutable: false,
      description: 'TCP listen backlog',
      default: '511',
    },
    unixsocket: { type: 'string', mutable: false, description: 'Unix socket path' },
    unixsocketperm: {
      type: 'string',
      mutable: false,
      description: 'Unix socket permissions (octal)',
    },
    'io-threads': {
      type: 'number',
      unit: 'count',
      mutable: false,
      description: 'Threads that read and write client sockets',
    },
    'io-threads-do-reads': {
      type: 'boolean',
      mutable: false,
      description: 'Let the I/O threads read and parse commands too',
    },
  }),
  ...group('security', {
    requirepass: {
      type: 'string',
      secret: true,
      disruptive: LOCKOUT,
      description: 'Password of the default user; clients must AUTH with it',
    },
    'protected-mode': {
      type: 'boolean',
      disruptive: LOCKOUT,
      description:
        'Refuse remote clients while the default user has no password and no bind is set',
      default: 'yes',
    },
    aclfile: {
      type: 'string',
      mutable: false,
      description: 'ACL file loaded at startup (ACL LOAD reloads it)',
    },
    'acllog-max-len': {
      type: 'number',
      unit: 'count',
      min: 0,
      description: 'Entries kept in ACL LOG',
      default: '128',
    },
    'acl-pubsub-default': {
      type: 'enum',
      values: ['allchannels', 'resetchannels'],
      description: 'Pub/Sub channel permissions of new ACL users',
      since: '6.2.0',
    },
    'enable-debug-command': {
      type: 'enum',
      values: ['no', 'yes', 'local'],
      mutable: false,
      description: 'Allow DEBUG (local = from local connections only)',
      since: '7.0.0',
    },
    'enable-module-command': {
      type: 'enum',
      values: ['no', 'yes', 'local'],
      mutable: false,
      description: 'Allow MODULE LOAD and UNLOAD (local = from local connections only)',
      since: '7.0.0',
    },
    'enable-protected-configs': {
      type: 'enum',
      values: ['no', 'yes', 'local'],
      mutable: false,
      description: 'Allow CONFIG SET of protected parameters such as dir and dbfilename',
      since: '7.0.0',
    },
    'tls-port': {
      type: 'number',
      min: 0,
      max: 65535,
      mutableSince: '7.0.0',
      disruptive: LOCKOUT,
      description: 'TLS port the server listens on (0 = no TLS)',
    },
    'tls-cert-file': { type: 'string', description: 'Server certificate (PEM)' },
    'tls-key-file': { type: 'string', description: 'Private key of the server certificate (PEM)' },
    'tls-key-file-pass': {
      type: 'string',
      secret: true,
      description: 'Passphrase of tls-key-file',
      since: '6.2.0',
    },
    'tls-client-cert-file': {
      type: 'string',
      description: 'Certificate the server presents as a client (replication, Cluster bus)',
    },
    'tls-client-key-file': { type: 'string', description: 'Private key of tls-client-cert-file' },
    'tls-client-key-file-pass': {
      type: 'string',
      secret: true,
      description: 'Passphrase of tls-client-key-file',
      since: '6.2.0',
    },
    'tls-ca-cert-file': { type: 'string', description: 'CA certificates that verify peers (PEM)' },
    'tls-ca-cert-dir': { type: 'string', description: 'Directory of CA certificates' },
    'tls-dh-params-file': { type: 'string', description: 'Diffie-Hellman parameters (PEM)' },
    'tls-auth-clients': {
      type: 'enum',
      values: ['yes', 'no', 'optional'],
      description: 'Require client certificates (optional = verify them when sent)',
      default: 'yes',
    },
    'tls-replication': {
      type: 'boolean',
      description: 'Use TLS for replication links',
      default: 'no',
    },
    'tls-cluster': { type: 'boolean', description: 'Use TLS on the Cluster bus', default: 'no' },
    'tls-protocols': {
      type: 'list',
      values: ['TLSv1', 'TLSv1.1', 'TLSv1.2', 'TLSv1.3'],
      description: 'TLS versions accepted (empty = the library’s defaults)',
    },
    'tls-ciphers': { type: 'string', description: 'Ciphers for TLS 1.2 and older (OpenSSL list)' },
    'tls-ciphersuites': { type: 'string', description: 'Cipher suites for TLS 1.3' },
    'tls-prefer-server-ciphers': {
      type: 'boolean',
      description: 'Prefer the server’s cipher order to the client’s',
      default: 'no',
    },
    'tls-session-caching': {
      type: 'boolean',
      description: 'Cache TLS sessions so clients reconnect faster',
      default: 'yes',
    },
    'tls-session-cache-size': {
      type: 'number',
      unit: 'count',
      min: 0,
      description: 'TLS sessions cached',
      default: '20480',
    },
    'tls-session-cache-timeout': {
      type: 'number',
      unit: 's',
      min: 0,
      description: 'Seconds a cached TLS session stays valid',
      default: '300',
    },
  }),
  ...group('latency', {
    'slowlog-log-slower-than': {
      type: 'number',
      unit: 'µs',
      min: -1,
      description: 'Log commands slower than this in the slow log (0 = every command, -1 = none)',
      default: '10000',
    },
    'slowlog-max-len': {
      type: 'number',
      unit: 'count',
      min: 0,
      description: 'Entries kept in the slow log',
      default: '128',
    },
    'latency-monitor-threshold': {
      type: 'number',
      unit: 'ms',
      min: 0,
      description: 'Record latency spikes of at least this long in the latency monitor (0 = off)',
      default: '0',
    },
    'latency-tracking': {
      type: 'boolean',
      description: 'Track per-command latency percentiles (INFO latencystats)',
      default: 'yes',
      since: '7.0.0',
    },
    'latency-tracking-info-percentiles': {
      type: 'list',
      description: 'Percentiles INFO latencystats reports',
      default: '50 99 99.9',
      since: '7.0.0',
    },
    'busy-reply-threshold': {
      type: 'number',
      unit: 'ms',
      min: 0,
      aliases: ['lua-time-limit'],
      description:
        'How long a script or function runs before other clients get BUSY replies (it can then be killed)',
      default: '5000',
    },
  }),
  ...group('cluster', {
    'cluster-enabled': {
      type: 'boolean',
      mutable: false,
      description: 'Run as a Cluster node',
      default: 'no',
    },
    'cluster-config-file': {
      type: 'string',
      mutable: false,
      description: 'File where the node keeps the cluster state',
      default: 'nodes.conf',
    },
    'cluster-port': {
      type: 'number',
      min: 0,
      max: 65535,
      mutable: false,
      description: 'Cluster bus port (0 = port + 10000)',
      default: '0',
      since: '7.0.0',
    },
    'cluster-node-timeout': {
      type: 'number',
      unit: 'ms',
      min: 1,
      description: 'How long a node may be unreachable before it is considered failing',
      default: '15000',
    },
    'cluster-replica-validity-factor': {
      type: 'number',
      min: 0,
      aliases: ['cluster-slave-validity-factor'],
      description:
        'A replica disconnected longer than node timeout × this factor does not fail over (0 = always may)',
      default: '10',
    },
    'cluster-migration-barrier': {
      type: 'number',
      unit: 'count',
      min: 0,
      description: 'Replicas a primary keeps before one may migrate to an orphaned primary',
      default: '1',
    },
    'cluster-allow-replica-migration': {
      type: 'boolean',
      description: 'Let replicas migrate to orphaned primaries',
      default: 'yes',
      since: '6.2.0',
    },
    'cluster-require-full-coverage': {
      type: 'boolean',
      description: 'Stop serving queries while some hash slots are not covered',
      default: 'yes',
    },
    'cluster-replica-no-failover': {
      type: 'boolean',
      aliases: ['cluster-slave-no-failover'],
      description: 'Never fail over automatically to this replica',
      default: 'no',
    },
    'cluster-allow-reads-when-down': {
      type: 'boolean',
      description: 'Serve reads while the cluster is down',
      default: 'no',
    },
    'cluster-allow-pubsubshard-when-down': {
      type: 'boolean',
      description: 'Serve sharded Pub/Sub while the cluster is down',
      default: 'yes',
      since: '7.0.0',
    },
    'cluster-announce-ip': {
      type: 'string',
      description: 'Address this node announces to the cluster (behind NAT)',
      default: '',
    },
    'cluster-announce-hostname': {
      type: 'string',
      description: 'Hostname this node announces to the cluster',
      default: '',
      since: '7.0.0',
    },
    'cluster-announce-port': {
      type: 'number',
      min: 0,
      max: 65535,
      description: 'Client port this node announces (0 = the real one)',
      default: '0',
    },
    'cluster-announce-tls-port': {
      type: 'number',
      min: 0,
      max: 65535,
      description: 'TLS port this node announces (0 = the real one)',
      default: '0',
    },
    'cluster-announce-bus-port': {
      type: 'number',
      min: 0,
      max: 65535,
      description: 'Cluster bus port this node announces (0 = the real one)',
      default: '0',
    },
    'cluster-preferred-endpoint-type': {
      type: 'enum',
      values: ['ip', 'hostname', 'unknown-endpoint'],
      description: 'What the node gives clients to reach other nodes in redirections',
      default: 'ip',
      since: '7.0.0',
    },
    'cluster-link-sendbuf-limit': {
      type: 'bytes',
      unit: 'bytes',
      description: 'Send buffer limit of each Cluster bus link (0 = no limit)',
      default: '0',
      since: '7.0.0',
    },
  }),
  ...group('encoding', {
    'hash-max-listpack-entries': {
      type: 'number',
      unit: 'count',
      min: 0,
      aliases: ['hash-max-ziplist-entries'],
      description: 'Hashes with at most this many fields use the compact encoding',
      default: '512',
    },
    'hash-max-listpack-value': {
      type: 'bytes',
      unit: 'bytes',
      aliases: ['hash-max-ziplist-value'],
      description: 'Hashes whose values are all at most this long use the compact encoding',
      default: '64',
    },
    'zset-max-listpack-entries': {
      type: 'number',
      unit: 'count',
      min: 0,
      aliases: ['zset-max-ziplist-entries'],
      description: 'Sorted sets with at most this many members use the compact encoding',
      default: '128',
    },
    'zset-max-listpack-value': {
      type: 'bytes',
      unit: 'bytes',
      aliases: ['zset-max-ziplist-value'],
      description: 'Sorted sets whose members are all at most this long use the compact encoding',
      default: '64',
    },
    'set-max-intset-entries': {
      type: 'number',
      unit: 'count',
      min: 0,
      description: 'Sets of integers with at most this many members use the intset encoding',
      default: '512',
    },
    'set-max-listpack-entries': {
      type: 'number',
      unit: 'count',
      min: 0,
      description: 'Sets with at most this many members use the compact encoding',
      default: '128',
      since: '7.2.0',
    },
    'set-max-listpack-value': {
      type: 'bytes',
      unit: 'bytes',
      description: 'Sets whose members are all at most this long use the compact encoding',
      default: '64',
      since: '7.2.0',
    },
    'list-max-listpack-size': {
      type: 'number',
      min: -5,
      aliases: ['list-max-ziplist-size'],
      description:
        'Size of each list node: a number of elements, or -1 to -5 for 4, 8, 16, 32 or 64 KB',
      default: '-2',
    },
    'list-compress-depth': {
      type: 'number',
      unit: 'count',
      min: 0,
      description: 'List nodes left uncompressed at each end (0 = no compression)',
      default: '0',
    },
    'hll-sparse-max-bytes': {
      type: 'bytes',
      unit: 'bytes',
      description: 'HyperLogLogs up to this size keep the sparse encoding',
      default: '3000',
    },
    'stream-node-max-bytes': {
      type: 'bytes',
      unit: 'bytes',
      description: 'Largest stream node (0 = no limit)',
      default: '4096',
    },
    'stream-node-max-entries': {
      type: 'number',
      unit: 'count',
      min: 0,
      description: 'Most entries in one stream node (0 = no limit)',
      default: '100',
    },
    activerehashing: {
      type: 'boolean',
      description: 'Rehash the main dictionaries incrementally in the background',
      default: 'yes',
    },
  }),
  ...group('general', {
    databases: {
      type: 'number',
      unit: 'count',
      mutable: false,
      description: 'Logical databases (SELECT 0 to databases − 1)',
      default: '16',
    },
    loglevel: {
      type: 'enum',
      values: ['debug', 'verbose', 'notice', 'warning', 'nothing'],
      description: 'How much the server logs',
      default: 'notice',
    },
    logfile: { type: 'string', mutable: false, description: 'Log file (empty = standard output)' },
    'syslog-enabled': {
      type: 'boolean',
      mutable: false,
      description: 'Log to syslog',
      default: 'no',
    },
    'syslog-ident': { type: 'string', mutable: false, description: 'Syslog identity' },
    'syslog-facility': { type: 'string', mutable: false, description: 'Syslog facility' },
    daemonize: { type: 'boolean', mutable: false, description: 'Run as a daemon' },
    supervised: {
      type: 'enum',
      values: ['no', 'upstart', 'systemd', 'auto'],
      mutable: false,
      description: 'Supervision tree the server reports to',
    },
    pidfile: {
      type: 'string',
      mutable: false,
      description: 'File the server writes its process id to',
    },
    hz: {
      type: 'number',
      unit: 'Hz',
      min: 1,
      max: 500,
      description: 'Frequency of background tasks (expiry, client timeouts…)',
      default: '10',
    },
    'dynamic-hz': {
      type: 'boolean',
      description: 'Raise hz with the number of connected clients',
      default: 'yes',
    },
    'set-proc-title': {
      type: 'boolean',
      mutable: false,
      description: 'Show the server’s state in its process title',
      default: 'yes',
    },
    'proc-title-template': {
      type: 'string',
      description: 'Template of the process title',
      since: '6.2.0',
    },
    'always-show-logo': {
      type: 'boolean',
      mutable: false,
      description: 'Show the ASCII logo in the log at startup',
    },
    'crash-log-enabled': {
      type: 'boolean',
      description: 'Log a stack trace when the server crashes',
      default: 'yes',
      since: '6.2.0',
    },
    'crash-memcheck-enabled': {
      type: 'boolean',
      description: 'Run a memory check when the server crashes',
      default: 'yes',
      since: '6.2.0',
    },
    'disable-thp': {
      type: 'boolean',
      mutable: false,
      description: 'Turn transparent huge pages off for the server process',
      default: 'yes',
    },
    'shutdown-timeout': {
      type: 'number',
      unit: 's',
      min: 0,
      description: 'Seconds a shutdown waits for replicas to catch up',
      default: '10',
      since: '7.0.0',
    },
    'shutdown-on-sigint': {
      type: 'list',
      values: ['default', 'save', 'nosave', 'now', 'force'],
      description: 'How SIGINT shuts the server down',
      default: 'default',
      since: '7.0.0',
    },
    'shutdown-on-sigterm': {
      type: 'list',
      values: ['default', 'save', 'nosave', 'now', 'force'],
      description: 'How SIGTERM shuts the server down',
      default: 'default',
      since: '7.0.0',
    },
  }),
  ...group('advanced', {
    'sanitize-dump-payload': {
      type: 'enum',
      values: ['no', 'yes', 'clients'],
      description: 'Deep-check RESTORE payloads and RDB files (clients = only from normal clients)',
      default: 'no',
      since: '6.2.0',
    },
    'propagation-error-behavior': {
      type: 'enum',
      values: ['ignore', 'panic', 'panic-on-replicas'],
      description: 'What a replica does when a replicated command fails',
      default: 'ignore',
      since: '7.0.0',
    },
    'replica-ignore-disk-write-errors': {
      type: 'boolean',
      description: 'Keep a replica running when it cannot write to disk',
      default: 'no',
      since: '7.0.0',
    },
    'ignore-warnings': {
      type: 'string',
      description: 'Startup warnings to silence',
      since: '6.2.0',
    },
    server_cpulist: {
      type: 'string',
      mutable: false,
      description: 'CPUs the main thread and I/O threads run on',
    },
    bio_cpulist: {
      type: 'string',
      mutable: false,
      description: 'CPUs the background I/O threads run on',
    },
    aof_rewrite_cpulist: {
      type: 'string',
      mutable: false,
      description: 'CPUs AOF rewrite children run on',
    },
    bgsave_cpulist: { type: 'string', mutable: false, description: 'CPUs BGSAVE children run on' },
  }),
];

const BY_NAME: ReadonlyMap<string, ConfigParameterMeta> = new Map(
  PARAMETERS.flatMap((meta) => [
    [meta.name, meta] as const,
    ...(meta.aliases ?? []).map((alias) => [alias, meta] as const),
  ]),
);

/** Every parameter Querybara knows, by canonical name. */
export function configParameters(): readonly ConfigParameterMeta[] {
  return PARAMETERS;
}

/** What Querybara knows about a parameter (by its name or an alias); undefined for others. */
export function configParameter(name: string): ConfigParameterMeta | undefined {
  return BY_NAME.get(name.toLowerCase());
}

/** The canonical name of a parameter known under an alias ("slave-read-only" → "replica-read-only"). */
export function canonicalConfigName(name: string): string {
  return configParameter(name)?.name ?? name.toLowerCase();
}

const SECRET_NAME = /(pass|password|auth|secret|token)$/i;

/**
 * True for parameters whose value is a secret (requirepass, masterauth, TLS key passphrases, and
 * any module parameter named like a password): never read out, only replaced.
 */
export function isSecretConfig(name: string): boolean {
  return configParameter(name)?.secret === true || SECRET_NAME.test(name);
}

const GROUP_RULES: readonly (readonly [RegExp, ConfigGroupId])[] = [
  [/\./, 'advanced'],
  [/^cluster-/, 'cluster'],
  [/^(tls-|acl)|(pass|auth)$/, 'security'],
  [/^(repl|replica|slave|min-replicas|min-slaves|master|primary)/, 'replication'],
  [/^(maxmemory|lazyfree|active-?defrag|lfu-|jemalloc)/, 'memory'],
  [/^(aof|append|rdb|save$|dbfilename$|dir$)/, 'persistence'],
  [/^(slowlog|latency|busy)/, 'latency'],
  [/(listpack|ziplist|intset|^hll-|^stream-node|^list-)/, 'encoding'],
  [/^(client|maxclients|tcp-|timeout$|bind|port$|proto-|tracking)/, 'clients'],
  [/^(log|syslog|hz$|databases$|shutdown)/, 'general'],
];

/** The group of a parameter: from the metadata, else guessed from its name, else "advanced". */
export function configGroupOf(name: string): ConfigGroupId {
  const meta = configParameter(name);
  if (meta) return meta.group;
  const lower = name.toLowerCase();
  return GROUP_RULES.find(([pattern]) => pattern.test(lower))?.[1] ?? 'advanced';
}

function versionParts(version: string): number[] {
  return version.split('.').map((part) => Number.parseInt(part, 10) || 0);
}

/** a >= b for dotted versions ("7.0.15" >= "7.0.0"). */
export function versionAtLeast(version: string, minimum: string): boolean {
  const a = versionParts(version);
  const b = versionParts(minimum);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return true;
}

/**
 * Whether CONFIG SET can change a parameter on a server of this version (its Redis-compatible
 * version: Valkey reports 7.2.4). Unknown parameters are assumed changeable: the server says
 * when they are not.
 */
export function isConfigMutable(name: string, redisVersion: string): boolean {
  const meta = configParameter(name);
  if (!meta) return true;
  if (!meta.mutable) return false;
  return meta.mutableSince === undefined || versionAtLeast(redisVersion, meta.mutableSince);
}
