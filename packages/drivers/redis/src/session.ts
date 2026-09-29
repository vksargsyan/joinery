import {
  JoineryError,
  cancelledError,
  capabilitiesFor,
  type BrowseNode,
  type Capabilities,
  type ExecOptions,
  type ResolvedProfile,
  type ResultChunk,
  type SchemaSnapshot,
} from '@joinery/core';
import { SessionGate } from '@joinery/driver-sql-base';
import {
  DEFAULT_KEY_DELIMITER,
  parseInfo,
  parseKeyspace,
  serverIdentity,
  toBytes,
  utf8Text,
  type AclLogEntry,
  type AclUser,
  type ClientInfo,
  type CommandCatalog,
  type ConfigChange,
  type InfoSections,
  type LatencyEvent,
  type LatencySample,
  type RedisBytes,
  type RedisReply,
  type SlowlogEntry,
} from '@joinery/redis-tools';
import { Cluster, type Redis } from 'ioredis';

import { browseRedis } from './browse';
import { addressOf, RedisConnection, type Arg } from './client';
import { buildRedisConnectionPlan } from './config';
import * as config from './config-service';
import type { RedisContext } from './context';
import { isReplyError, mapRedisError } from './errors';
import { executeText } from './execute';
import * as keys from './keys';
import { asArray, asNumber, asRecord, asText, isStatusReply, toRedisReply } from './replies';
import { monitor as startMonitor, subscribe as startSubscription } from './streams';
import * as tools from './tools';
import type {
  BigKeyOptions,
  BigKeyReport,
  BulkDeleteOptions,
  BulkDeleteResult,
  ClaimOptions,
  CommandOptions,
  ConfigValues,
  CopyOptions,
  CopyResult,
  CursorOptions,
  CursorPage,
  DumpedKey,
  GeoMember,
  GeoSearchOptions,
  HashEntry,
  KeyInfo,
  MonitorOptions,
  MonitorStream,
  NewKeyValue,
  NodeInfo,
  NodeReply,
  PendingEntry,
  PendingRangeOptions,
  PendingSummary,
  PubSubSubscription,
  RedisModule,
  RedisNode,
  RedisServerInfo,
  RedisSession,
  RedisTopologyView,
  RestoreOptions,
  ScanOptions,
  ScanPageOptions,
  ScanPageResult,
  ScanResult,
  SetStringOptions,
  StreamAddOptions,
  StreamConsumer,
  StreamEntry,
  StreamGroup,
  StreamInfo,
  StreamRangeOptions,
  StreamTrimOptions,
  StringReadOptions,
  StringValue,
  SubscribeOptions,
  ZRangeOptions,
  ZSetEntry,
} from './types';
import * as values from './values';

interface Running {
  readonly id: string;
  readonly node: Redis;
  readonly clientId: string | undefined;
  cancelled: boolean;
}

function isAuthReply(error: unknown): boolean {
  return isReplyError(error) && /^(NOAUTH|WRONGPASS)\b/.test(error.message);
}

/** What the server is: HELLO, INFO server, CONFIG GET databases, each allowed to be refused. */
async function probeServer(conn: RedisConnection, database: number): Promise<RedisServerInfo> {
  const node = conn.primaries()[0]!;
  const attempt = async (args: Arg[]): Promise<unknown> => {
    try {
      return await conn.raw(args, node);
    } catch (error) {
      if (isAuthReply(error))
        throw mapRedisError(error, conn.context('connect', String(args[0]).toUpperCase()));
      return undefined;
    }
  };
  const [helloRaw, infoRaw] = await Promise.all([attempt(['hello']), attempt(['info', 'server'])]);
  if (helloRaw === undefined && infoRaw === undefined) {
    // Both refused: make sure the connection is at least authenticated.
    try {
      await conn.raw(['ping'], node);
    } catch (error) {
      throw mapRedisError(error, conn.context('connect', 'PING'));
    }
  }
  if (database !== 0 && !conn.isCluster) {
    // ioredis ignores a failed SELECT during its handshake; check it, or commands would silently
    // run in database 0.
    try {
      await conn.raw(['select', String(database)]);
    } catch (error) {
      if (isReplyError(error) && /out of range/i.test(error.message)) {
        throw new JoineryError(
          {
            code: 'VALIDATION_FAILED',
            message: `Database ${database} does not exist on this server`,
            hint: 'Pick a database from 0 to the server’s "databases" setting minus one',
          },
          { cause: error },
        );
      }
      throw mapRedisError(error, conn.context('connect', 'SELECT'));
    }
  }
  const hello = asRecord(helloRaw);
  const identity =
    infoRaw !== undefined ? serverIdentity(parseInfo(asText(infoRaw) ?? '')) : undefined;
  const helloServer = asText(hello['server']);
  const helloVersion = asText(hello['version']) ?? undefined;
  const flavor = identity?.flavor === 'valkey' || helloServer === 'valkey' ? 'valkey' : 'redis';
  const version = identity?.version || helloVersion || 'unknown';
  const roleText = asText(hello['role']);
  let modules: RedisModule[] = asArray(hello['modules']).map((m) => {
    const r = asRecord(m);
    return { name: asText(r['name']) ?? '', version: asText(r['ver']) ?? '' };
  });
  if (helloRaw === undefined) {
    modules = asArray(await attempt(['module', 'list'])).map((m) => {
      const r = asRecord(m);
      return { name: asText(r['name']) ?? '', version: asText(r['ver']) ?? '' };
    });
  }
  const cluster = conn.isCluster;
  let databases = 1;
  let databasesExact = true;
  if (!cluster) {
    const config = asRecord(await attempt(['config', 'get', 'databases']));
    const configured = asNumber(config['databases']);
    if (configured !== null && configured > 0) {
      databases = configured;
    } else {
      databasesExact = false;
      const keyspace = parseKeyspace(parseInfo(asText(await attempt(['info', 'keyspace'])) ?? ''));
      databases = Math.max(database + 1, ...keyspace.map((k) => k.db + 1), 1);
    }
  }
  return {
    flavor,
    version,
    redisVersion: identity?.redisVersion || helloVersion || version,
    topology: conn.plan.topology,
    role:
      roleText === 'master'
        ? 'master'
        : roleText === 'replica' || roleText === 'slave'
          ? 'replica'
          : 'unknown',
    modules,
    databases,
    databasesExact,
    clusterMode: cluster,
  };
}

/**
 * A Redis or Valkey session (standalone, Sentinel-managed or Cluster) on ioredis. Services share
 * the session's connection (ioredis pipelines them); Pub/Sub, MONITOR and cancel use their own
 * connections. Commands typed by the user (`execute`, `command`) run one at a time and can be
 * cancelled with CLIENT KILL from a control connection.
 */
export class RedisSessionImpl implements RedisSession, RedisContext {
  readonly engine = 'redis' as const;
  private readonly gate = new SessionGate();
  private currentDb: number;
  private multi = false;
  private target: string | undefined;
  private catalog: Promise<CommandCatalog> | undefined;
  private running: Running | null = null;
  private readonly active = new Set<string>();
  private readonly cancelled = new Set<string>();

  private constructor(
    readonly conn: RedisConnection,
    readonly server: RedisServerInfo,
    readonly keyDelimiter: string,
    database: number,
  ) {
    this.currentDb = database;
    // A dropped connection loses its transaction (and ioredis restores the database).
    conn.client.on('close', () => {
      this.multi = false;
    });
  }

  /** Connects, authenticates and learns what the server is. */
  static async open(resolved: ResolvedProfile): Promise<RedisSessionImpl> {
    const plan = buildRedisConnectionPlan(resolved);
    const conn = await RedisConnection.open(plan);
    try {
      const server = await probeServer(conn, plan.database);
      const delimiter = resolved.profile.options.keyDelimiter ?? DEFAULT_KEY_DELIMITER;
      return new RedisSessionImpl(conn, server, delimiter, plan.database);
    } catch (error) {
      await conn.close();
      throw error;
    }
  }

  get serverVersion(): string {
    return this.server.flavor === 'valkey'
      ? `${this.server.version} (Valkey)`
      : this.server.version;
  }

  get database(): number {
    return this.currentDb;
  }

  get inTransaction(): boolean {
    return this.multi;
  }

  get targetNode(): string | undefined {
    return this.target;
  }

  capabilities(): Capabilities {
    return {
      ...capabilitiesFor('redis', this.server.redisVersion),
      clusterMode: this.server.clusterMode,
      queryCancel: true,
    };
  }

  nodes(includeReplicas = false): RedisNode[] {
    if (!this.conn.isCluster) {
      // The server actually connected to (a Sentinel-managed master is not in the profile).
      const client = this.conn.primaries()[0]!;
      const target = this.conn.plan.target;
      const host =
        client.stream?.remoteAddress ?? (target.kind === 'tcp' ? target.host : target.path);
      const port = client.stream?.remotePort ?? (target.kind === 'tcp' ? target.port : 0);
      const address =
        target.kind === 'socket'
          ? target.path
          : `${host.includes(':') ? `[${host}]` : host}:${port}`;
      return [
        { address, host, port, role: this.server.role === 'replica' ? 'replica' : 'primary' },
      ];
    }
    const describe = (node: Redis, role: RedisNode['role']): RedisNode => ({
      address: addressOf(node),
      host: node.options.host ?? 'localhost',
      port: node.options.port ?? 6379,
      role,
    });
    const primaries = this.conn.primaries().map((n) => describe(n, 'primary'));
    return includeReplicas
      ? [...primaries, ...this.conn.replicas().map((n) => describe(n, 'replica'))]
      : primaries;
  }

  setTargetNode(node: string | undefined): void {
    if (node !== undefined && this.conn.isCluster) this.conn.node(node);
    this.target = node;
  }

  // -------------------------------------------------------------------------------------------
  // RedisContext

  private assertUsable(): void {
    if (!this.conn.isOpen) {
      throw new JoineryError({ code: 'CONNECTION_FAILED', message: 'The session is closed' });
    }
    if (this.multi) {
      throw new JoineryError({
        code: 'CONFLICT',
        message: 'A MULTI transaction is open on this session',
        hint: 'Run EXEC or DISCARD in the CLI first',
      });
    }
  }

  call(args: readonly Arg[], node?: Redis): Promise<unknown> {
    this.assertUsable();
    return this.conn.call(args, node);
  }

  async inDatabase(db: number, commands: readonly (readonly Arg[])[]): Promise<unknown[]> {
    this.assertUsable();
    if (db === this.currentDb || this.conn.isCluster) {
      return Promise.all(commands.map((c) => this.conn.call(c)));
    }
    const results = await this.conn.atomic([
      ['select', String(db)],
      ...commands,
      ['select', String(this.currentDb)],
    ]);
    const failed = results.find((r) => r.error);
    if (failed) throw mapRedisError(failed.error, this.conn.context('command'));
    return results.slice(1, -1).map((r) => r.value);
  }

  async transaction(commands: readonly (readonly Arg[])[]): Promise<unknown[]> {
    this.assertUsable();
    const client = this.conn.client;
    const multi = client instanceof Cluster ? client.multi() : client.multi();
    for (const [name, ...rest] of commands) {
      multi.callBuffer(
        String(name),
        ...rest.map((a) =>
          a instanceof Uint8Array ? Buffer.from(a.buffer, a.byteOffset, a.byteLength) : a,
        ),
      );
    }
    let results: [Error | null, unknown][] | null;
    try {
      results = await multi.exec();
    } catch (error) {
      throw mapRedisError(error, this.conn.context('command', 'EXEC'));
    }
    const failed = (results ?? []).find(([error]) => error);
    if (failed) throw mapRedisError(failed[0], this.conn.context('command'));
    return (results ?? []).map(([, value]) => value);
  }

  nodeFor(address: string | undefined): Redis {
    if (!this.conn.isCluster) return this.conn.primaries()[0]!;
    const chosen = address ?? this.target;
    return chosen !== undefined ? this.conn.node(chosen) : this.conn.primaries()[0]!;
  }

  scanNodes(address: string | undefined): Redis[] {
    if (!this.conn.isCluster) return this.conn.primaries();
    return address !== undefined ? [this.conn.node(address)] : this.conn.primaries();
  }

  // -------------------------------------------------------------------------------------------
  // User commands

  private userNode(args: readonly Uint8Array[], explicit: string | undefined): Redis {
    if (!this.conn.isCluster) return this.conn.primaries()[0]!;
    if (explicit !== undefined) return this.conn.node(explicit);
    return this.conn.slotOwner(args) ?? this.nodeFor(undefined);
  }

  private track(name: string, words: readonly string[], reply: RedisReply): void {
    if (name === 'exec' || name === 'discard') this.multi = false;
    if (reply.type === 'error') return;
    if (name === 'multi') this.multi = true;
    if (name === 'select' && !this.conn.isCluster) this.currentDb = Number(words[1]);
  }

  /** One user command: serialized, cancellable, with MULTI / SELECT tracking. */
  private runUser(
    args: readonly Uint8Array[],
    options: { readonly node?: string; readonly executionId?: string },
  ): Promise<{ reply: RedisReply; node?: string }> {
    return this.gate.run(async () => {
      if (!this.conn.isOpen) {
        throw new JoineryError({ code: 'CONNECTION_FAILED', message: 'The session is closed' });
      }
      const id = options.executionId;
      if (id !== undefined && this.cancelled.has(id)) throw cancelledError();
      const words = args.map(utf8Text);
      const name = (words[0] ?? '').toLowerCase();
      const node = this.userNode(args, options.node);
      const address = this.conn.isCluster ? addressOf(node) : undefined;
      // ioredis tracks the database for reconnects only when SELECT's index is text.
      const send: Arg[] = name === 'select' ? ['select', words[1] ?? ''] : [...args];
      let running: Running | undefined;
      if (id !== undefined) {
        const clientId = await this.conn.clientId(node).catch(() => undefined);
        running = { id, node, clientId, cancelled: false };
        this.running = running;
      }
      try {
        const answer = await this.conn.rawOn(send, this.conn.isCluster ? node : undefined);
        const raw = answer.value;
        const status = raw instanceof Uint8Array && isStatusReply(words, raw, this.multi);
        const reply = toRedisReply(raw, status);
        this.track(name, words, reply);
        const answered = answer.node ? addressOf(answer.node) : address;
        return {
          reply,
          ...(this.conn.isCluster && answered !== undefined ? { node: answered } : {}),
        };
      } catch (error) {
        if (running?.cancelled) throw cancelledError();
        if (isReplyError(error)) {
          const reply: RedisReply = { type: 'error', value: error.message };
          this.track(name, words, reply);
          return { reply, ...(address !== undefined ? { node: address } : {}) };
        }
        throw mapRedisError(error, this.conn.context('command', name.toUpperCase()));
      } finally {
        if (running) this.running = null;
      }
    });
  }

  execute(text: string, opts: ExecOptions): AsyncIterable<ResultChunk> {
    return this.executeCommands(text, opts);
  }

  private async *executeCommands(text: string, opts: ExecOptions): AsyncGenerator<ResultChunk> {
    const id = opts.executionId;
    this.active.add(id);
    const onAbort = (): void => void this.cancel(id);
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      yield* executeText(
        text,
        opts,
        (args) => this.runUser(args, { executionId: id }),
        this.conn.context('command'),
        this.conn.isCluster,
      );
    } finally {
      opts.signal?.removeEventListener('abort', onAbort);
      this.active.delete(id);
      this.cancelled.delete(id);
    }
  }

  async cancel(executionId: string): Promise<void> {
    if (!this.active.has(executionId)) return;
    this.cancelled.add(executionId);
    const running = this.running;
    if (!running || running.id !== executionId || running.clientId === undefined) return;
    running.cancelled = true;
    await this.conn.killClient(running.node, running.clientId).catch(() => undefined);
  }

  async command(args: readonly RedisBytes[], options: CommandOptions = {}): Promise<RedisReply> {
    const { reply } = await this.runUser(
      args.map(toBytes),
      options.node !== undefined ? { node: options.node } : {},
    );
    return reply;
  }

  async commandAll(
    args: readonly RedisBytes[],
    options: { readonly replicas?: boolean } = {},
  ): Promise<NodeReply[]> {
    const bytes = args.map(toBytes);
    const words = bytes.map(utf8Text);
    const nodes = [...this.conn.primaries(), ...(options.replicas ? this.conn.replicas() : [])];
    return this.gate.run(() =>
      Promise.all(
        nodes.map(async (node): Promise<NodeReply> => {
          const address = addressOf(node);
          try {
            const raw = await this.conn.raw(bytes, this.conn.isCluster ? node : undefined);
            const status = raw instanceof Uint8Array && isStatusReply(words, raw, false);
            return { node: address, reply: toRedisReply(raw, status) };
          } catch (error) {
            if (isReplyError(error))
              return { node: address, reply: { type: 'error', value: error.message } };
            throw mapRedisError(
              error,
              this.conn.context('command', (words[0] ?? '').toUpperCase()),
            );
          }
        }),
      ),
    );
  }

  // -------------------------------------------------------------------------------------------
  // Session contract

  /** Redis has no schema: an empty snapshot, so generic callers (sync, cache) work unchanged. */
  async introspect(): Promise<SchemaSnapshot> {
    return {
      engine: 'redis',
      serverVersion: this.serverVersion,
      database: `db${this.currentDb}`,
      options: {},
      schemas: [],
      extensions: [],
      capturedAt: new Date().toISOString(),
    };
  }

  browse(path: readonly string[]): Promise<BrowseNode[]> {
    return this.gate.run(() => browseRedis(this, path));
  }

  /** SELECT: "db3" or "3". Cluster mode has only database 0. */
  useDatabase(name: string): Promise<void> {
    const match = /^(?:db)?(\d+)$/i.exec(name.trim());
    if (!match) {
      return Promise.reject(
        new JoineryError({
          code: 'VALIDATION_FAILED',
          message: `"${name}" is not a logical database`,
        }),
      );
    }
    const db = Number(match[1]);
    return this.gate.run(async () => {
      if (this.conn.isCluster) {
        if (db === 0) return;
        throw new JoineryError({ code: 'NOT_SUPPORTED', message: 'A cluster has only database 0' });
      }
      await this.call(['select', String(db)]);
      this.currentDb = db;
    });
  }

  async ping(): Promise<void> {
    await this.call(['ping'], this.nodeFor(undefined));
  }

  async close(): Promise<void> {
    await this.conn.close();
  }

  // -------------------------------------------------------------------------------------------
  // Keys

  scan(options?: ScanOptions): Promise<ScanResult> {
    return keys.scan(this, options);
  }

  scanPage(options: ScanPageOptions): Promise<ScanPageResult> {
    return keys.scanPage(this, options);
  }

  keyInfo(list: readonly RedisBytes[]): Promise<KeyInfo[]> {
    return keys.keyInfo(this, list);
  }

  memoryUsage(
    list: readonly RedisBytes[],
    options: { readonly samples?: number } = {},
  ): Promise<(number | null)[]> {
    return keys.memoryUsage(this, list, options.samples);
  }

  exists(list: readonly RedisBytes[]): Promise<number> {
    return keys.exists(this, list);
  }

  dbSize(options: { readonly node?: string } = {}): Promise<number> {
    return keys.dbSize(this, options.node);
  }

  // Reads

  getString(key: RedisBytes, options?: StringReadOptions): Promise<StringValue | null> {
    return values.getString(this, key, options);
  }

  hashScan(key: RedisBytes, options?: CursorOptions): Promise<CursorPage<HashEntry>> {
    return values.hashScan(this, key, options);
  }

  hashGet(key: RedisBytes, fields: readonly RedisBytes[]): Promise<(Uint8Array | null)[]> {
    return values.hashGet(this, key, fields);
  }

  listRange(key: RedisBytes, start: number, stop: number): Promise<Uint8Array[]> {
    return values.listRange(this, key, start, stop);
  }

  setScan(key: RedisBytes, options?: CursorOptions): Promise<CursorPage<Uint8Array>> {
    return values.setScan(this, key, options);
  }

  zsetRange(key: RedisBytes, options: ZRangeOptions): Promise<ZSetEntry[]> {
    return values.zsetRange(this, key, options);
  }

  zsetScan(key: RedisBytes, options?: CursorOptions): Promise<CursorPage<ZSetEntry>> {
    return values.zsetScan(this, key, options);
  }

  zsetScore(key: RedisBytes, member: RedisBytes): Promise<ZSetEntry | null> {
    return values.zsetScore(this, key, member);
  }

  streamRange(key: RedisBytes, options?: StreamRangeOptions): Promise<StreamEntry[]> {
    return values.streamRange(this, key, options);
  }

  streamInfo(key: RedisBytes): Promise<StreamInfo> {
    return values.streamInfo(this, key);
  }

  streamGroups(key: RedisBytes): Promise<StreamGroup[]> {
    return values.streamGroups(this, key);
  }

  streamConsumers(key: RedisBytes, group: RedisBytes): Promise<StreamConsumer[]> {
    return values.streamConsumers(this, key, group);
  }

  streamPending(key: RedisBytes, group: RedisBytes): Promise<PendingSummary> {
    return values.streamPending(this, key, group);
  }

  streamPendingRange(
    key: RedisBytes,
    group: RedisBytes,
    options?: PendingRangeOptions,
  ): Promise<PendingEntry[]> {
    return values.streamPendingRange(this, key, group, options);
  }

  jsonGet(key: RedisBytes, path?: string): Promise<string | null> {
    return values.jsonGet(this, key, path);
  }

  jsonType(key: RedisBytes, path?: string): Promise<string[]> {
    return values.jsonType(this, key, path);
  }

  async hllCount(list: readonly RedisBytes[]): Promise<number> {
    return asNumber(await this.call(['pfcount', ...list.map(toBytes)])) ?? 0;
  }

  async bitmapRange(key: RedisBytes, startByte: number, endByte: number): Promise<Uint8Array> {
    const raw = await this.call(['getrange', toBytes(key), startByte, endByte]);
    return raw instanceof Uint8Array ? new Uint8Array(raw) : new Uint8Array(0);
  }

  async bitCount(
    key: RedisBytes,
    range?: { readonly start: number; readonly end: number; readonly unit?: 'BYTE' | 'BIT' },
  ): Promise<number> {
    const args: Arg[] = ['bitcount', toBytes(key)];
    if (range) {
      args.push(range.start, range.end);
      if (range.unit) args.push(range.unit);
    }
    return asNumber(await this.call(args)) ?? 0;
  }

  async bitPos(
    key: RedisBytes,
    bit: 0 | 1,
    range?: { readonly start: number; readonly end?: number; readonly unit?: 'BYTE' | 'BIT' },
  ): Promise<number> {
    const args: Arg[] = ['bitpos', toBytes(key), bit];
    if (range) {
      args.push(range.start);
      if (range.end !== undefined) {
        args.push(range.end);
        if (range.unit) args.push(range.unit);
      }
    }
    return asNumber(await this.call(args)) ?? -1;
  }

  geoMembers(key: RedisBytes, start: number, stop: number): Promise<GeoMember[]> {
    return values.geoMembers(this, key, start, stop);
  }

  geoSearch(key: RedisBytes, options: GeoSearchOptions): Promise<GeoMember[]> {
    return values.geoSearch(this, key, options);
  }

  // Writes

  createKey(
    key: RedisBytes,
    value: NewKeyValue,
    options: { readonly ttlMs?: number } = {},
  ): Promise<void> {
    return values.createKey(this, key, value, options.ttlMs);
  }

  setString(key: RedisBytes, value: RedisBytes, options?: SetStringOptions): Promise<boolean> {
    return values.setString(this, key, value, options);
  }

  async setRange(key: RedisBytes, offset: number, value: RedisBytes): Promise<number> {
    return asNumber(await this.call(['setrange', toBytes(key), offset, toBytes(value)])) ?? 0;
  }

  async hashSet(
    key: RedisBytes,
    entries: readonly (readonly [RedisBytes, RedisBytes])[],
  ): Promise<number> {
    if (entries.length === 0) return 0;
    const args: Arg[] = [
      'hset',
      toBytes(key),
      ...entries.flatMap(([f, v]) => [toBytes(f), toBytes(v)]),
    ];
    return asNumber(await this.call(args)) ?? 0;
  }

  async hashDelete(key: RedisBytes, fields: readonly RedisBytes[]): Promise<number> {
    if (fields.length === 0) return 0;
    return asNumber(await this.call(['hdel', toBytes(key), ...fields.map(toBytes)])) ?? 0;
  }

  async listSet(key: RedisBytes, index: number, value: RedisBytes): Promise<void> {
    await this.call(['lset', toBytes(key), index, toBytes(value)]);
  }

  async listPush(
    key: RedisBytes,
    items: readonly RedisBytes[],
    side: 'left' | 'right' = 'right',
  ): Promise<number> {
    if (items.length === 0) return asNumber(await this.call(['llen', toBytes(key)])) ?? 0;
    return (
      asNumber(
        await this.call([side === 'left' ? 'lpush' : 'rpush', toBytes(key), ...items.map(toBytes)]),
      ) ?? 0
    );
  }

  async listInsert(
    key: RedisBytes,
    where: 'before' | 'after',
    pivot: RedisBytes,
    value: RedisBytes,
  ): Promise<number> {
    return (
      asNumber(
        await this.call([
          'linsert',
          toBytes(key),
          where.toUpperCase(),
          toBytes(pivot),
          toBytes(value),
        ]),
      ) ?? 0
    );
  }

  async listRemove(key: RedisBytes, value: RedisBytes, count = 0): Promise<number> {
    return asNumber(await this.call(['lrem', toBytes(key), count, toBytes(value)])) ?? 0;
  }

  listRemoveAt(key: RedisBytes, index: number, expected: RedisBytes): Promise<boolean> {
    return values.listRemoveAt(this, key, index, expected);
  }

  async setAdd(key: RedisBytes, members: readonly RedisBytes[]): Promise<number> {
    if (members.length === 0) return 0;
    return asNumber(await this.call(['sadd', toBytes(key), ...members.map(toBytes)])) ?? 0;
  }

  async setRemove(key: RedisBytes, members: readonly RedisBytes[]): Promise<number> {
    if (members.length === 0) return 0;
    return asNumber(await this.call(['srem', toBytes(key), ...members.map(toBytes)])) ?? 0;
  }

  zsetAdd(
    key: RedisBytes,
    entries: readonly (readonly [RedisBytes, number | string])[],
    options?: { readonly condition?: 'nx' | 'xx'; readonly compare?: 'gt' | 'lt' },
  ): Promise<number> {
    return values.zsetAdd(this, key, entries, options);
  }

  zsetIncrement(key: RedisBytes, member: RedisBytes, by: number | string): Promise<ZSetEntry> {
    return values.zsetIncrement(this, key, member, by);
  }

  async zsetRemove(key: RedisBytes, members: readonly RedisBytes[]): Promise<number> {
    if (members.length === 0) return 0;
    return asNumber(await this.call(['zrem', toBytes(key), ...members.map(toBytes)])) ?? 0;
  }

  streamAdd(
    key: RedisBytes,
    fields: readonly (readonly [RedisBytes, RedisBytes])[],
    options?: StreamAddOptions,
  ): Promise<string | null> {
    return values.streamAdd(this, key, fields, options);
  }

  async streamDelete(key: RedisBytes, ids: readonly string[]): Promise<number> {
    if (ids.length === 0) return 0;
    return asNumber(await this.call(['xdel', toBytes(key), ...ids])) ?? 0;
  }

  streamTrim(key: RedisBytes, options: StreamTrimOptions): Promise<number> {
    return values.streamTrim(this, key, options);
  }

  async streamGroupCreate(
    key: RedisBytes,
    group: RedisBytes,
    id = '$',
    options: { readonly mkStream?: boolean; readonly entriesRead?: number } = {},
  ): Promise<void> {
    const args: Arg[] = ['xgroup', 'create', toBytes(key), toBytes(group), id];
    if (options.mkStream) args.push('MKSTREAM');
    if (options.entriesRead !== undefined) args.push('ENTRIESREAD', options.entriesRead);
    await this.call(args);
  }

  async streamGroupDestroy(key: RedisBytes, group: RedisBytes): Promise<boolean> {
    return asNumber(await this.call(['xgroup', 'destroy', toBytes(key), toBytes(group)])) === 1;
  }

  async streamGroupSetId(key: RedisBytes, group: RedisBytes, id: string): Promise<void> {
    await this.call(['xgroup', 'setid', toBytes(key), toBytes(group), id]);
  }

  async streamAck(key: RedisBytes, group: RedisBytes, ids: readonly string[]): Promise<number> {
    if (ids.length === 0) return 0;
    return asNumber(await this.call(['xack', toBytes(key), toBytes(group), ...ids])) ?? 0;
  }

  streamClaim(
    key: RedisBytes,
    group: RedisBytes,
    consumer: RedisBytes,
    minIdleMs: number,
    ids: readonly string[],
    options?: ClaimOptions,
  ): Promise<StreamEntry[] | string[]> {
    return values.streamClaim(this, key, group, consumer, minIdleMs, ids, options);
  }

  streamAutoClaim(
    key: RedisBytes,
    group: RedisBytes,
    consumer: RedisBytes,
    minIdleMs: number,
    start?: string,
    options?: { readonly count?: number; readonly justId?: boolean },
  ): Promise<{ next: string; claimed: StreamEntry[] | string[]; deleted: string[] }> {
    return values.streamAutoClaim(this, key, group, consumer, minIdleMs, start, options);
  }

  jsonSet(
    key: RedisBytes,
    path: string,
    json: string,
    options: { readonly condition?: 'nx' | 'xx' } = {},
  ): Promise<boolean> {
    return values.jsonSet(this, key, path, json, options.condition);
  }

  deleteKeys(list: readonly RedisBytes[]): Promise<number> {
    return keys.deleteKeys(this, list);
  }

  expire(key: RedisBytes, ttlMs: number | null): Promise<boolean> {
    return keys.expire(this, key, ttlMs);
  }

  rename(
    key: RedisBytes,
    newKey: RedisBytes,
    options: { readonly onlyIfNew?: boolean } = {},
  ): Promise<boolean> {
    return keys.rename(this, key, newKey, options.onlyIfNew === true);
  }

  copy(source: RedisBytes, destination: RedisBytes, options?: CopyOptions): Promise<CopyResult> {
    if (options?.db !== undefined && options.db !== this.currentDb) {
      // Copies into another database may SELECT around a RESTORE: keep other user commands out.
      return this.gate.run(() => keys.copy(this, source, destination, options));
    }
    return keys.copy(this, source, destination, options);
  }

  bulkDelete(options: BulkDeleteOptions): Promise<BulkDeleteResult> {
    return keys.bulkDelete(this, options);
  }

  dumpKeys(list: readonly RedisBytes[]): Promise<DumpedKey[]> {
    return keys.dumpKeys(this, list);
  }

  restoreKeys(list: readonly DumpedKey[], options?: RestoreOptions): Promise<number> {
    if (options?.db !== undefined && options.db !== this.currentDb) {
      return this.gate.run(() => keys.restoreKeys(this, list, options));
    }
    return keys.restoreKeys(this, list, options);
  }

  // -------------------------------------------------------------------------------------------
  // Tools

  info(options: { readonly section?: string; readonly node?: string } = {}): Promise<InfoSections> {
    return tools.info(this, options.section, options.node);
  }

  infoAll(options: { readonly section?: string } = {}): Promise<NodeInfo[]> {
    return tools.infoAll(this, options.section);
  }

  configGet(pattern: string, options: { readonly node?: string } = {}): Promise<ConfigValues> {
    return tools.configGet(this, pattern, options.node);
  }

  configSet(
    parameter: string,
    value: string,
    options: { readonly node?: string } = {},
  ): Promise<void> {
    return tools.configSet(this, parameter, value, options.node);
  }

  configNodes(): Promise<config.ConfigNode[]> {
    return config.configNodes(this);
  }

  configRead(target?: config.ConfigTarget): Promise<config.ConfigSnapshot> {
    return config.configRead(this, target);
  }

  configApply(
    changes: readonly ConfigChange[],
    target?: config.ConfigTarget,
  ): Promise<config.ConfigApplyResult> {
    return config.configApply(this, changes, target);
  }

  configRewrite(target?: config.ConfigTarget): Promise<config.ConfigNodeOutcome[]> {
    return config.configRewrite(this, target);
  }

  configResetStat(target?: config.ConfigTarget): Promise<config.ConfigNodeOutcome[]> {
    return config.configResetStat(this, target);
  }

  slowlogGet(count?: number, options: { readonly node?: string } = {}): Promise<SlowlogEntry[]> {
    return tools.slowlogGet(this, count, options.node);
  }

  async slowlogLength(options: { readonly node?: string } = {}): Promise<number> {
    return asNumber(await this.call(['slowlog', 'len'], this.nodeFor(options.node))) ?? 0;
  }

  async slowlogReset(options: { readonly node?: string } = {}): Promise<void> {
    await this.call(['slowlog', 'reset'], this.nodeFor(options.node));
  }

  clientList(
    options: { readonly node?: string; readonly type?: string } = {},
  ): Promise<ClientInfo[]> {
    return tools.clientList(this, options.node, options.type);
  }

  async clientKill(id: number, options: { readonly node?: string } = {}): Promise<boolean> {
    return (
      (asNumber(await this.call(['client', 'kill', 'ID', id], this.nodeFor(options.node))) ?? 0) > 0
    );
  }

  latencyLatest(options: { readonly node?: string } = {}): Promise<LatencyEvent[]> {
    return tools.latencyLatest(this, options.node);
  }

  latencyHistory(
    event: string,
    options: { readonly node?: string } = {},
  ): Promise<LatencySample[]> {
    return tools.latencyHistory(this, event, options.node);
  }

  async latencyDoctor(options: { readonly node?: string } = {}): Promise<string> {
    return asText(await this.call(['latency', 'doctor'], this.nodeFor(options.node))) ?? '';
  }

  async latencyReset(
    events: readonly string[] = [],
    options: { readonly node?: string } = {},
  ): Promise<number> {
    return (
      asNumber(await this.call(['latency', 'reset', ...events], this.nodeFor(options.node))) ?? 0
    );
  }

  async latencyMonitorThreshold(options: { readonly node?: string } = {}): Promise<number | null> {
    const config = await this.configGet('latency-monitor-threshold', options);
    const value = config.values['latency-monitor-threshold'];
    return config.denied || value === undefined ? null : Number(value);
  }

  setLatencyMonitorThreshold(ms: number, options: { readonly node?: string } = {}): Promise<void> {
    return this.configSet(
      'latency-monitor-threshold',
      String(Math.max(0, Math.round(ms))),
      options,
    );
  }

  async memoryDoctor(options: { readonly node?: string } = {}): Promise<string> {
    return asText(await this.call(['memory', 'doctor'], this.nodeFor(options.node))) ?? '';
  }

  monitor(options?: MonitorOptions): Promise<MonitorStream> {
    return startMonitor(this.conn, options);
  }

  bigKeys(options?: BigKeyOptions): Promise<BigKeyReport> {
    return tools.bigKeys(this, options);
  }

  async aclList(): Promise<string[]> {
    return asArray(await this.call(['acl', 'list'], this.nodeFor(undefined))).map(
      (r) => asText(r) ?? '',
    );
  }

  async aclUsers(): Promise<string[]> {
    return asArray(await this.call(['acl', 'users'], this.nodeFor(undefined))).map(
      (r) => asText(r) ?? '',
    );
  }

  aclGetUser(name: string): Promise<AclUser | null> {
    return tools.aclGetUser(this, name);
  }

  async aclSetUser(name: string, rules: readonly string[]): Promise<void> {
    await tools.aclOnEveryNode(this, ['acl', 'setuser', name, ...rules]);
  }

  async aclDelUser(names: readonly string[]): Promise<number> {
    if (names.length === 0) return 0;
    const counts = await tools.aclOnEveryNode(this, ['acl', 'deluser', ...names]);
    return asNumber(counts[0]) ?? 0;
  }

  async aclWhoAmI(): Promise<string> {
    return asText(await this.call(['acl', 'whoami'], this.nodeFor(undefined))) ?? '';
  }

  async aclCategories(category?: string): Promise<string[]> {
    const args: Arg[] = category ? ['acl', 'cat', category] : ['acl', 'cat'];
    return asArray(await this.call(args, this.nodeFor(undefined))).map((r) => asText(r) ?? '');
  }

  aclLog(count?: number): Promise<AclLogEntry[]> {
    return tools.aclLog(this, count);
  }

  async aclLogReset(): Promise<void> {
    await tools.aclOnEveryNode(this, ['acl', 'log', 'reset']);
  }

  subscribe(options: SubscribeOptions): Promise<PubSubSubscription> {
    return startSubscription(this.conn, options);
  }

  async publish(
    channel: RedisBytes,
    message: RedisBytes,
    options: { readonly sharded?: boolean } = {},
  ): Promise<number> {
    const args: Arg[] = [
      options.sharded ? 'spublish' : 'publish',
      toBytes(channel),
      toBytes(message),
    ];
    // Sharded channels live in a slot; plain PUBLISH is broadcast by any node.
    return (
      asNumber(await this.call(args, options.sharded ? undefined : this.nodeFor(undefined))) ?? 0
    );
  }

  async pubsubChannels(pattern?: RedisBytes): Promise<Uint8Array[]> {
    const args: Arg[] =
      pattern !== undefined ? ['pubsub', 'channels', toBytes(pattern)] : ['pubsub', 'channels'];
    return asArray(await this.call(args, this.nodeFor(undefined))).map((c) =>
      c instanceof Uint8Array ? new Uint8Array(c) : new Uint8Array(0),
    );
  }

  pubsubNumSub(
    channels: readonly RedisBytes[],
  ): Promise<{ channel: Uint8Array; subscribers: number }[]> {
    return tools.pubsubNumSub(this, channels);
  }

  async pubsubNumPat(): Promise<number> {
    return asNumber(await this.call(['pubsub', 'numpat'], this.nodeFor(undefined))) ?? 0;
  }

  topology(): Promise<RedisTopologyView> {
    return tools.topology(this);
  }

  commandDocs(): Promise<CommandCatalog> {
    this.catalog ??= tools.commandDocs(this).catch((error: unknown) => {
      this.catalog = undefined;
      throw error;
    });
    return this.catalog;
  }
}
