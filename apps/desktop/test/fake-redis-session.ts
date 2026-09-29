import {
  JoineryError,
  capabilitiesFor,
  type DriverAdapter,
  type ExecOptions,
  type ResolvedProfile,
  type ResultChunk,
} from '@joinery/core';
import type {
  BulkDeleteOptions,
  BulkDeleteResult,
  KeyInfo,
  PubSubMessage,
  PubSubSubscription,
  RedisServerInfo,
  RedisSession,
  RedisTopologyView,
  ScanPageOptions,
  ScanPageResult,
} from '@joinery/driver-redis';
import {
  bulk,
  bytesKey,
  integer,
  NIL,
  status,
  toBytes,
  utf8Text,
  type RedisBytes,
  type RedisReply,
} from '@joinery/redis-tools';

import { CATALOG } from './redis-fixtures';

/**
 * An in-memory RedisSession for the connection host's `redis.*` handlers: strings and hashes in
 * a map, SCAN over the map, a few commands, a subscription fed by `publish`, and a blocking
 * BLPOP that only a closed connection ends. Every call is recorded. Services the tests do not
 * use throw, so a handler calling the wrong one fails loudly.
 */

type Value =
  | { readonly type: 'string'; value: Uint8Array }
  | { readonly type: 'hash'; fields: Map<string, [Uint8Array, Uint8Array]> };

export class FakeRedisSession {
  readonly engine = 'redis' as const;
  readonly serverVersion = '7.2.4';
  readonly keyDelimiter = ':';
  readonly server: RedisServerInfo;
  readonly calls: { readonly method: string; readonly args: readonly unknown[] }[] = [];
  readonly store: Map<string, { key: Uint8Array; value: Value }>;
  readonly subscribers: { push(message: PubSubMessage): void; closed: boolean }[] = [];
  inTransaction = false;
  closed = false;
  targetNode: string | undefined = undefined;
  database: number;
  #blocked: (() => void)[] = [];

  constructor(
    database: number,
    store: Map<string, { key: Uint8Array; value: Value }>,
    cluster = false,
  ) {
    this.database = database;
    this.store = store;
    this.server = {
      flavor: 'redis',
      version: '7.2.4',
      redisVersion: '7.2.4',
      topology: cluster ? 'cluster' : 'standalone',
      role: 'master',
      modules: [],
      databases: cluster ? 1 : 16,
      databasesExact: true,
      clusterMode: cluster,
    };
  }

  #record(method: string, ...args: unknown[]): void {
    this.calls.push({ method, args });
  }

  capabilities() {
    return capabilitiesFor('redis', this.serverVersion);
  }

  async *execute(text: string, _opts: ExecOptions): AsyncGenerator<ResultChunk> {
    this.#record('execute', text);
    yield { type: 'end', durationMs: 0, rowCount: 0 };
  }

  async cancel(): Promise<void> {}

  async introspect(): Promise<never> {
    throw new JoineryError({ code: 'NOT_SUPPORTED', message: 'no' });
  }

  async browse(): Promise<never[]> {
    return [];
  }

  async ping(): Promise<void> {}

  async close(): Promise<void> {
    this.closed = true;
    for (const release of this.#blocked.splice(0)) release();
  }

  nodes() {
    return this.server.clusterMode
      ? [
          { address: '10.0.0.1:7000', host: '10.0.0.1', port: 7000, role: 'primary' as const },
          { address: '10.0.0.2:7001', host: '10.0.0.2', port: 7001, role: 'primary' as const },
        ]
      : [{ address: '127.0.0.1:6379', host: '127.0.0.1', port: 6379, role: 'primary' as const }];
  }

  setTargetNode(node: string | undefined): void {
    this.targetNode = node;
  }

  async topology(): Promise<RedisTopologyView> {
    const node = (address: string, slots: [number, number][]) => {
      const [host, port] = address.split(':');
      return {
        id: address,
        address,
        host: host!,
        port: Number(port),
        role: 'primary' as const,
        flags: ['master'],
        myself: false,
        failing: false,
        state: 'connected',
        slots,
      };
    };
    return {
      topology: 'cluster',
      nodes: [node('10.0.0.1:7000', [[0, 8191]]), node('10.0.0.2:7001', [[8192, 16383]])],
      uncoveredSlots: [],
    };
  }

  async commandDocs() {
    return CATALOG;
  }

  async aclWhoAmI(): Promise<string> {
    return 'default';
  }

  async command(args: readonly RedisBytes[], options: { node?: string } = {}): Promise<RedisReply> {
    const words = args.map((a) => utf8Text(toBytes(a)));
    this.#record('command', words, options);
    const name = words[0]!.toUpperCase();
    if (this.closed) throw new JoineryError({ code: 'CONNECTION_FAILED', message: 'closed' });
    switch (name) {
      case 'SET':
        this.store.set(bytesKey(toBytes(args[1]!)), {
          key: toBytes(args[1]!),
          value: { type: 'string', value: toBytes(args[2]!) },
        });
        return status('OK');
      case 'GET': {
        const entry = this.store.get(bytesKey(toBytes(args[1]!)));
        return entry?.value.type === 'string' ? bulk(entry.value.value) : NIL;
      }
      case 'DBSIZE':
        return integer(this.store.size);
      case 'SELECT':
        this.database = Number(words[1]);
        return status('OK');
      case 'BLPOP':
        return new Promise((_resolve, reject) => {
          this.#blocked.push(() =>
            reject(
              new JoineryError({ code: 'CONNECTION_FAILED', message: 'Connection is closed' }),
            ),
          );
        });
      default:
        return { type: 'error', value: `ERR unknown command '${words[0]}'` };
    }
  }

  async scanPage(options: ScanPageOptions): Promise<ScanPageResult> {
    this.#record('scanPage', options);
    const all = [...this.store.values()].map((e) => e.key);
    const pattern = options.match === undefined ? undefined : utf8Text(toBytes(options.match));
    const matching = all.filter((k) => {
      if (pattern === undefined) return true;
      const text = utf8Text(k);
      return pattern.endsWith('*') ? text.startsWith(pattern.slice(0, -1)) : text === pattern;
    });
    const start = Number(options.cursor ?? '0');
    const keys = matching.slice(start, start + options.limit);
    const next = start + keys.length;
    const done = next >= matching.length;
    return { keys, cursor: done ? '0' : String(next), done, calls: 1, budgetExhausted: false };
  }

  async keyInfo(keys: readonly RedisBytes[]): Promise<KeyInfo[]> {
    return keys.map((input) => {
      const key = toBytes(input);
      const entry = this.store.get(bytesKey(key));
      if (!entry)
        return { key, type: 'none', kind: 'none', ttlMs: -2, encoding: null, length: null };
      return {
        key,
        type: entry.value.type,
        kind: entry.value.type,
        ttlMs: -1,
        encoding: 'listpack',
        length: entry.value.type === 'hash' ? entry.value.fields.size : entry.value.value.length,
      };
    });
  }

  async exists(keys: readonly RedisBytes[]): Promise<number> {
    return keys.filter((k) => this.store.has(bytesKey(toBytes(k)))).length;
  }

  async hashSet(
    key: RedisBytes,
    entries: readonly (readonly [RedisBytes, RedisBytes])[],
  ): Promise<number> {
    this.#record('hashSet', key, entries);
    const k = toBytes(key);
    let entry = this.store.get(bytesKey(k));
    if (!entry || entry.value.type !== 'hash') {
      entry = { key: k, value: { type: 'hash', fields: new Map() } };
      this.store.set(bytesKey(k), entry);
    }
    const fields = (entry.value as Extract<Value, { type: 'hash' }>).fields;
    let added = 0;
    for (const [f, v] of entries) {
      if (!fields.has(bytesKey(toBytes(f)))) added += 1;
      fields.set(bytesKey(toBytes(f)), [toBytes(f), toBytes(v)]);
    }
    return added;
  }

  async deleteKeys(keys: readonly RedisBytes[]): Promise<number> {
    this.#record('deleteKeys', keys);
    return keys.filter((k) => this.store.delete(bytesKey(toBytes(k)))).length;
  }

  async rename(
    key: RedisBytes,
    newKey: RedisBytes,
    options: { onlyIfNew?: boolean } = {},
  ): Promise<boolean> {
    this.#record('rename', key, newKey, options);
    const entry = this.store.get(bytesKey(toBytes(key)));
    if (!entry) return false;
    if (options.onlyIfNew && this.store.has(bytesKey(toBytes(newKey)))) return false;
    this.store.delete(bytesKey(toBytes(key)));
    this.store.set(bytesKey(toBytes(newKey)), { key: toBytes(newKey), value: entry.value });
    return true;
  }

  async expire(key: RedisBytes, ttlMs: number | null): Promise<boolean> {
    this.#record('expire', key, ttlMs);
    return this.store.has(bytesKey(toBytes(key)));
  }

  async bulkDelete(options: BulkDeleteOptions): Promise<BulkDeleteResult> {
    this.#record('bulkDelete', { ...options, onProgress: undefined, signal: undefined });
    const prefix = utf8Text(toBytes(options.match)).replace(/\*$/, '');
    const matching = [...this.store.values()].filter((e) => utf8Text(e.key).startsWith(prefix));
    let deleted = 0;
    for (const entry of matching) {
      if (!options.dryRun) {
        this.store.delete(bytesKey(entry.key));
        deleted += 1;
      }
      options.onProgress?.({ matched: matching.length, deleted, failed: 0, scanCalls: 1 });
    }
    return {
      matched: matching.length,
      deleted,
      failed: 0,
      scanCalls: 1,
      dryRun: options.dryRun === true,
      cancelled: false,
      sample: matching.slice(0, 3).map((e) => e.key),
    };
  }

  async publish(channel: RedisBytes, message: RedisBytes): Promise<number> {
    this.#record('publish', channel, message);
    const live = this.subscribers.filter((s) => !s.closed);
    for (const s of live) {
      s.push({
        kind: 'message',
        channel: toBytes(channel),
        message: toBytes(message),
        receivedAt: Date.now(),
        dropped: 0,
      });
    }
    return live.length;
  }

  async subscribe(options: { readonly signal?: AbortSignal } = {}): Promise<PubSubSubscription> {
    const queue: PubSubMessage[] = [];
    let wake: (() => void) | undefined;
    const subscriber = {
      closed: false,
      push(message: PubSubMessage) {
        queue.push(message);
        wake?.();
      },
    };
    this.subscribers.push(subscriber);
    options.signal?.addEventListener('abort', () => {
      subscriber.closed = true;
      wake?.();
    });
    return {
      async close() {
        subscriber.closed = true;
        wake?.();
      },
      async *[Symbol.asyncIterator]() {
        while (!subscriber.closed) {
          const next = queue.shift();
          if (next) {
            yield next;
            continue;
          }
          await new Promise<void>((resolve) => (wake = resolve));
        }
      },
    };
  }

  async clientKill(id: number): Promise<boolean> {
    this.#record('clientKill', id);
    return true;
  }

  async aclSetUser(name: string, rules: readonly string[]): Promise<void> {
    this.#record('aclSetUser', name, rules);
  }
}

/** Shared by every session of a fake connection, like a server's keyspace. */
export function fakeRedisAdapter(options: { readonly cluster?: boolean } = {}): DriverAdapter & {
  readonly sessions: FakeRedisSession[];
  readonly store: Map<string, { key: Uint8Array; value: Value }>;
} {
  const sessions: FakeRedisSession[] = [];
  const store = new Map<string, { key: Uint8Array; value: Value }>();
  const unused = (name: string) => () => {
    throw new Error(`${name} is not faked`);
  };
  return {
    engine: 'redis',
    sessions,
    store,
    capabilities: (version) => capabilitiesFor('redis', version),
    async connect(resolved: ResolvedProfile) {
      const database = Number(resolved.profile.options.defaultDatabase ?? '0');
      const session = new FakeRedisSession(database, store, options.cluster);
      sessions.push(session);
      // Services a test does not fake fail loudly instead of returning undefined.
      return new Proxy(session, {
        get(target, property) {
          if (property in target) {
            const value: unknown = Reflect.get(target, property, target);
            return typeof value === 'function' ? (value as () => unknown).bind(target) : value;
          }
          // Not thenable: `await` probes `then`.
          if (typeof property !== 'string' || property === 'then') return undefined;
          return unused(property);
        },
      }) as unknown as RedisSession;
    },
  };
}
