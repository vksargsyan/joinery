import {
  JoineryError,
  cancelledError,
  type ExecOptions,
  type ResultChunk,
  type Session,
} from '@joinery/core';
import type { ConfigTarget, RedisSession, RedisTopologyView } from '@joinery/driver-redis';
import type { HandlersOf, redisHostContractShape } from '@joinery/ipc';
import {
  keySlot,
  lookupCommand,
  splitCommands,
  toBytes,
  utf8Text,
  type CommandCatalog,
  type CommandDoc,
  type RedisBytes,
} from '@joinery/redis-tools';

import {
  CONFIG_RESETSTAT,
  CONFIG_REWRITE,
  WRITE,
  classifyRedisCommand,
  configSetOperation,
  decideRedisSafety,
  destructive,
  type RedisOperation,
  type RedisWritePolicy,
} from '../shared/redis-safety';

/**
 * The connection host's `redis.*` handlers (spec §10, §15): each is one RedisSession service on
 * the session the page opened. The write rules are enforced here, whatever the page sends:
 * read-only profiles refuse writes with READ_ONLY, and an operation that needs confirmation
 * without `confirmed` fails with CONFIRMATION_REQUIRED (see shared/redis-safety).
 */

export interface RedisHostDeps {
  readonly policy: RedisWritePolicy;
  /** The open session with this id (NOT_FOUND when it was closed). */
  session(sessionId: string): Session;
  /**
   * Drops the session's connection and opens a new one under the same id, in `database` (how a
   * CLI command is cancelled: redis-cli drops the connection too).
   */
  resetSession(sessionId: string, database: number): Promise<void>;
}

/**
 * Narrows a session to a Redis session. By engine only: the driver's own `isRedisSession` is a
 * runtime import, and the host loads a driver only when its engine connects.
 */
export function isRedisSession(session: Session): session is RedisSession {
  return session.engine === 'redis';
}

function notRedis(): JoineryError {
  return new JoineryError({
    code: 'NOT_SUPPORTED',
    message: 'Redis services are only available on Redis connections',
  });
}

/** Throws READ_ONLY or CONFIRMATION_REQUIRED when the policy says the operation may not run. */
export function checkRedisOperation(
  operation: RedisOperation,
  policy: RedisWritePolicy,
  confirmed: boolean | undefined,
): void {
  const decision = decideRedisSafety(operation, policy);
  if (decision.action === 'refuse') {
    throw new JoineryError({ code: 'READ_ONLY', message: decision.reason });
  }
  if (decision.action === 'confirm' && confirmed !== true) {
    throw new JoineryError({
      code: 'CONFIRMATION_REQUIRED',
      message: decision.destructive
        ? `This operation ${decision.reason}, so it needs confirmation`
        : `${decision.reason}, so this one needs confirmation`,
      hint: 'Confirm it in Joinery first',
    });
  }
}

/**
 * The generic `execute` on a Redis session, under the write rules: a script of commands is
 * checked command by command before any runs. It cannot carry a confirmation, so writes that
 * need one are refused with a pointer to the Redis CLI, which asks.
 */
export async function* executeRedisGuarded(
  session: RedisSession,
  text: string,
  opts: ExecOptions,
  policy: RedisWritePolicy,
): AsyncGenerator<ResultChunk> {
  const catalog = await session.commandDocs().catch(() => undefined);
  for (const args of splitCommands(text)) {
    const decision = decideRedisSafety(classifyRedisCommand(args.map(utf8Text), catalog), policy);
    if (decision.action === 'refuse') {
      throw new JoineryError({ code: 'READ_ONLY', message: decision.reason });
    }
    if (decision.action === 'confirm') {
      throw new JoineryError({
        code: 'CONFIRMATION_REQUIRED',
        message: `${utf8Text(args[0]!).toUpperCase()} needs confirmation`,
        hint: 'Run it from the Redis CLI, which asks first',
      });
    }
  }
  yield* session.execute(text, opts);
}

/** Keys of a command from its legacy key positions (first, last, step). */
export function commandKeys(
  args: readonly Uint8Array[],
  doc: CommandDoc | undefined,
): Uint8Array[] {
  const spec = doc?.keys;
  if (!spec || spec.first <= 0) return [];
  const last = spec.last < 0 ? args.length + spec.last : spec.last;
  const step = Math.max(1, spec.step);
  const keys: Uint8Array[] = [];
  for (let i = spec.first; i <= last && i < args.length; i += step) keys.push(args[i]!);
  return keys;
}

/** The primary serving a key's slot in a topology view, by address. */
export function slotOwner(view: RedisTopologyView, key: RedisBytes): string | undefined {
  const slot = keySlot(key);
  return view.nodes.find(
    (node) =>
      node.role === 'primary' && node.slots.some(([start, end]) => slot >= start && slot <= end),
  )?.address;
}

const TOPOLOGY_TTL_MS = 10_000;

/** Tracks the node a Cluster command lands on (the CLI shows it), from a cached slot map. */
class NodeLocator {
  readonly #views = new WeakMap<RedisSession, { at: number; view: Promise<RedisTopologyView> }>();

  async nodeFor(
    session: RedisSession,
    args: readonly Uint8Array[],
    doc: CommandDoc | undefined,
    explicit: string | undefined,
  ): Promise<string | undefined> {
    if (!session.server.clusterMode) return undefined;
    if (explicit !== undefined) return explicit;
    const [first] = commandKeys(args, doc);
    const fallback = session.targetNode ?? session.nodes()[0]?.address;
    if (first === undefined) return fallback;
    let cached = this.#views.get(session);
    if (!cached || performance.now() - cached.at > TOPOLOGY_TTL_MS) {
      cached = { at: performance.now(), view: session.topology() };
      this.#views.set(session, cached);
    }
    const view = await cached.view.catch(() => undefined);
    return (view && slotOwner(view, first)) ?? fallback;
  }
}

/** Resolves when `signal` aborts (never, without one). */
/** An options object without its undefined members (zod's optional fields may carry them). */
function definedOnly<T extends object>(value: T): { [K in keyof T]: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as {
    [K in keyof T]: Exclude<T[K], undefined>;
  };
}

function aborted(signal: AbortSignal): Promise<'aborted'> {
  return new Promise((resolve) => {
    if (signal.aborted) resolve('aborted');
    else signal.addEventListener('abort', () => resolve('aborted'), { once: true });
  });
}

export function redisHandlers(deps: RedisHostDeps): HandlersOf<typeof redisHostContractShape> {
  const { policy } = deps;
  const locator = new NodeLocator();
  const redis = (sessionId: string): RedisSession => {
    const session = deps.session(sessionId);
    if (!isRedisSession(session)) throw notRedis();
    return session;
  };
  const guard = (operation: RedisOperation, confirmed?: boolean): void =>
    checkRedisOperation(operation, policy, confirmed);
  const catalogOf = (session: RedisSession): Promise<CommandCatalog | undefined> =>
    session.commandDocs().catch(() => undefined);
  const nodeOption = (node: string | undefined): { node?: string } =>
    node === undefined ? {} : { node };
  const configTarget = (node: string | undefined, replicas: boolean | undefined): ConfigTarget => ({
    ...nodeOption(node),
    ...(replicas !== undefined ? { replicas } : {}),
  });

  return {
    session: async ({ sessionId }) => {
      const session = redis(sessionId);
      const user = await session.aclWhoAmI().catch(() => undefined);
      return {
        server: session.server,
        database: session.database,
        keyDelimiter: session.keyDelimiter,
        nodes: session.nodes(true),
        ...(session.targetNode !== undefined ? { targetNode: session.targetNode } : {}),
        ...(user !== undefined ? { user } : {}),
      };
    },
    setTargetNode: ({ sessionId, node }) => redis(sessionId).setTargetNode(node),
    commandDocs: ({ sessionId }) => redis(sessionId).commandDocs(),
    command: async ({ sessionId, args, node, confirmed }, { signal }) => {
      const session = redis(sessionId);
      const bytes = args.map(toBytes);
      const words = bytes.map(utf8Text);
      // Loaded with the adapter already: a Redis session exists only once the driver has.
      const { assertAllowed } = await import('@joinery/driver-redis');
      assertAllowed(words);
      const catalog = await catalogOf(session);
      guard(classifyRedisCommand(words, catalog), confirmed);
      const doc = catalog ? lookupCommand(catalog, words)?.doc : undefined;
      const answering = await locator.nodeFor(session, bytes, doc, node);
      const started = performance.now();
      const running = session.command(bytes, nodeOption(node));
      const outcome = await Promise.race([running, aborted(signal)]);
      if (outcome === 'aborted') {
        running.catch(() => undefined);
        await deps.resetSession(sessionId, session.database);
        throw cancelledError();
      }
      return {
        reply: outcome,
        ...(answering !== undefined ? { node: answering } : {}),
        durationMs: Math.max(0, performance.now() - started),
        database: session.database,
        inTransaction: session.inTransaction,
      };
    },

    scan: async function* ({ sessionId, match, type, pageSize, count, node, cursor }, { signal }) {
      const session = redis(sessionId);
      let next = cursor ?? '0';
      for (;;) {
        const page = await session.scanPage({
          cursor: next,
          limit: pageSize,
          signal,
          ...(match !== undefined ? { match } : {}),
          ...(type !== undefined ? { type } : {}),
          ...(count !== undefined ? { count } : {}),
          ...nodeOption(node),
        });
        const keys = page.keys.length > 0 ? await session.keyInfo(page.keys) : [];
        yield { ...page, keys };
        if (page.done) return;
        next = page.cursor;
      }
    },
    keyInfo: ({ sessionId, keys }) => redis(sessionId).keyInfo(keys),
    memoryUsage: ({ sessionId, keys, samples }) =>
      redis(sessionId).memoryUsage(keys, samples === undefined ? {} : { samples }),
    exists: async ({ sessionId, keys }) => ({ count: await redis(sessionId).exists(keys) }),
    dbSize: async ({ sessionId, node }) => ({
      count: await redis(sessionId).dbSize(nodeOption(node)),
    }),
    bulkDelete: (
      { sessionId, match, type, dryRun, batchSize, confirmed },
      { signal, progress },
    ) => {
      const session = redis(sessionId);
      if (dryRun !== true) guard(destructive('deletes every key matching the pattern'), confirmed);
      return session.bulkDelete({
        match,
        signal,
        onProgress: progress,
        ...(type !== undefined ? { type } : {}),
        ...(dryRun !== undefined ? { dryRun } : {}),
        ...(batchSize !== undefined ? { batchSize } : {}),
      });
    },

    key: {
      create: async ({ sessionId, key, value, ttlMs, confirmed }) => {
        guard(WRITE, confirmed);
        await redis(sessionId).createKey(key, value, ttlMs === undefined ? {} : { ttlMs });
      },
      delete: async ({ sessionId, keys, confirmed }) => {
        guard(destructive(keys.length === 1 ? 'deletes the key' : 'deletes keys'), confirmed);
        return { count: await redis(sessionId).deleteKeys(keys) };
      },
      expire: async ({ sessionId, key, ttlMs, confirmed }) => {
        guard(WRITE, confirmed);
        return { changed: await redis(sessionId).expire(key, ttlMs) };
      },
      rename: async ({ sessionId, key, newKey, onlyIfNew, confirmed }) => {
        const session = redis(sessionId);
        const replaces = onlyIfNew !== true && (await session.exists([newKey])) > 0;
        guard(replaces ? destructive('replaces an existing key') : WRITE, confirmed);
        const renamed = await session.rename(key, newKey, onlyIfNew ? { onlyIfNew } : {});
        return { renamed };
      },
      copy: async ({ sessionId, key, destination, db, replace, confirmed }) => {
        const session = redis(sessionId);
        const sameDb = db === undefined || db === session.database;
        const replaces = replace === true && (!sameDb || (await session.exists([destination])) > 0);
        guard(replaces ? destructive('replaces an existing key') : WRITE, confirmed);
        return session.copy(key, destination, {
          ...(db !== undefined ? { db } : {}),
          ...(replace !== undefined ? { replace } : {}),
        });
      },
    },

    string: {
      get: ({ sessionId, key, offset, maxBytes }) =>
        redis(sessionId).getString(key, {
          ...(offset !== undefined ? { offset } : {}),
          ...(maxBytes !== undefined ? { maxBytes } : {}),
        }),
      set: async ({ sessionId, key, value, options, confirmed }) => {
        guard(WRITE, confirmed);
        return { written: await redis(sessionId).setString(key, value, options ?? {}) };
      },
    },
    hash: {
      get: ({ sessionId, key, fields }) => redis(sessionId).hashGet(key, fields),
      scan: ({ sessionId, key, options }) => redis(sessionId).hashScan(key, options ?? {}),
      set: async ({ sessionId, key, entries, confirmed }) => {
        guard(WRITE, confirmed);
        return { added: await redis(sessionId).hashSet(key, entries) };
      },
      delete: async ({ sessionId, key, fields, confirmed }) => {
        guard(WRITE, confirmed);
        return { removed: await redis(sessionId).hashDelete(key, fields) };
      },
    },
    list: {
      range: ({ sessionId, key, start, stop }) => redis(sessionId).listRange(key, start, stop),
      set: async ({ sessionId, key, index, value, confirmed }) => {
        guard(WRITE, confirmed);
        await redis(sessionId).listSet(key, index, value);
      },
      push: async ({ sessionId, key, values, side, confirmed }) => {
        guard(WRITE, confirmed);
        return { length: await redis(sessionId).listPush(key, values, side) };
      },
      removeAt: async ({ sessionId, key, index, expected, confirmed }) => {
        guard(WRITE, confirmed);
        return { removed: await redis(sessionId).listRemoveAt(key, index, expected) };
      },
    },
    set: {
      scan: ({ sessionId, key, options }) => redis(sessionId).setScan(key, options ?? {}),
      add: async ({ sessionId, key, members, confirmed }) => {
        guard(WRITE, confirmed);
        return { added: await redis(sessionId).setAdd(key, members) };
      },
      remove: async ({ sessionId, key, members, confirmed }) => {
        guard(WRITE, confirmed);
        return { removed: await redis(sessionId).setRemove(key, members) };
      },
    },
    zset: {
      range: ({ sessionId, key, options }) => redis(sessionId).zsetRange(key, options),
      add: async ({ sessionId, key, entries, condition, confirmed }) => {
        guard(WRITE, confirmed);
        const added = await redis(sessionId).zsetAdd(
          key,
          entries,
          condition === undefined ? {} : { condition },
        );
        return { added };
      },
      remove: async ({ sessionId, key, members, confirmed }) => {
        guard(WRITE, confirmed);
        return { removed: await redis(sessionId).zsetRemove(key, members) };
      },
    },
    stream: {
      range: ({ sessionId, key, options }) => redis(sessionId).streamRange(key, options ?? {}),
      info: ({ sessionId, key }) => redis(sessionId).streamInfo(key),
      groups: ({ sessionId, key }) => redis(sessionId).streamGroups(key),
      consumers: ({ sessionId, key, group }) => redis(sessionId).streamConsumers(key, group),
      pending: ({ sessionId, key, group }) => redis(sessionId).streamPending(key, group),
      pendingRange: ({ sessionId, key, group, options }) =>
        redis(sessionId).streamPendingRange(key, group, options ?? {}),
      add: async ({ sessionId, key, fields, options, confirmed }) => {
        guard(WRITE, confirmed);
        return { id: await redis(sessionId).streamAdd(key, fields, options ?? {}) };
      },
      delete: async ({ sessionId, key, ids, confirmed }) => {
        guard(WRITE, confirmed);
        return { removed: await redis(sessionId).streamDelete(key, ids) };
      },
      groupCreate: async ({ sessionId, key, group, id, mkStream, confirmed }) => {
        guard(WRITE, confirmed);
        await redis(sessionId).streamGroupCreate(
          key,
          group,
          id,
          mkStream === undefined ? {} : { mkStream },
        );
      },
      groupDestroy: async ({ sessionId, key, group, confirmed }) => {
        guard(destructive('removes the consumer group and its pending entries'), confirmed);
        return { destroyed: await redis(sessionId).streamGroupDestroy(key, group) };
      },
      ack: async ({ sessionId, key, group, ids, confirmed }) => {
        guard(WRITE, confirmed);
        return { acknowledged: await redis(sessionId).streamAck(key, group, ids) };
      },
      claim: async ({ sessionId, key, group, consumer, minIdleMs, ids, options, confirmed }) => {
        guard(WRITE, confirmed);
        return redis(sessionId).streamClaim(key, group, consumer, minIdleMs, ids, options ?? {});
      },
    },
    json: {
      get: async ({ sessionId, key, path }) => ({
        json: await redis(sessionId).jsonGet(key, path),
      }),
      set: async ({ sessionId, key, path, json, confirmed }) => {
        guard(WRITE, confirmed);
        return { written: await redis(sessionId).jsonSet(key, path, json) };
      },
    },
    hll: {
      count: async ({ sessionId, keys }) => ({ count: await redis(sessionId).hllCount(keys) }),
    },
    bitmap: {
      range: ({ sessionId, key, startByte, endByte }) =>
        redis(sessionId).bitmapRange(key, startByte, endByte),
      count: async ({ sessionId, key }) => ({ count: await redis(sessionId).bitCount(key) }),
    },
    geo: {
      members: ({ sessionId, key, start, stop }) => redis(sessionId).geoMembers(key, start, stop),
    },

    info: ({ sessionId, section, node }) =>
      redis(sessionId).info({
        ...(section !== undefined ? { section } : {}),
        ...nodeOption(node),
      }),
    infoAll: ({ sessionId, section }) =>
      redis(sessionId).infoAll(section === undefined ? {} : { section }),
    slowlog: {
      get: ({ sessionId, count, node }) => redis(sessionId).slowlogGet(count, nodeOption(node)),
      reset: async ({ sessionId, node, confirmed }) => {
        guard(destructive('clears the slow log'), confirmed);
        await redis(sessionId).slowlogReset(nodeOption(node));
      },
    },
    clients: {
      list: ({ sessionId, node, type }) =>
        redis(sessionId).clientList({ ...nodeOption(node), ...(type ? { type } : {}) }),
      kill: async ({ sessionId, id, node, confirmed }) => {
        guard(destructive('disconnects the client'), confirmed);
        return { killed: await redis(sessionId).clientKill(id, nodeOption(node)) };
      },
    },
    latency: {
      latest: ({ sessionId, node }) => redis(sessionId).latencyLatest(nodeOption(node)),
      history: ({ sessionId, event, node }) =>
        redis(sessionId).latencyHistory(event, nodeOption(node)),
      doctor: async ({ sessionId, node }) => ({
        text: await redis(sessionId).latencyDoctor(nodeOption(node)),
      }),
      threshold: async ({ sessionId, node }) => ({
        ms: await redis(sessionId).latencyMonitorThreshold(nodeOption(node)),
      }),
      setThreshold: async ({ sessionId, ms, node, confirmed }) => {
        guard(WRITE, confirmed);
        await redis(sessionId).setLatencyMonitorThreshold(ms, nodeOption(node));
      },
      reset: async ({ sessionId, events, node, confirmed }) => {
        guard(destructive('clears the latency history'), confirmed);
        return { reset: await redis(sessionId).latencyReset(events, nodeOption(node)) };
      },
    },
    memoryDoctor: async ({ sessionId, node }) => ({
      text: await redis(sessionId).memoryDoctor(nodeOption(node)),
    }),
    config: {
      nodes: ({ sessionId }) => redis(sessionId).configNodes(),
      get: ({ sessionId, node, replicas }) =>
        redis(sessionId).configRead(configTarget(node, replicas)),
      set: async ({ sessionId, changes, node, replicas, confirmed }) => {
        guard(configSetOperation(changes.map((c) => c.name)), confirmed);
        return redis(sessionId).configApply(changes, configTarget(node, replicas));
      },
      rewrite: async ({ sessionId, node, replicas, confirmed }) => {
        guard(CONFIG_REWRITE, confirmed);
        return redis(sessionId).configRewrite(configTarget(node, replicas));
      },
      resetStat: async ({ sessionId, node, replicas, confirmed }) => {
        guard(CONFIG_RESETSTAT, confirmed);
        return redis(sessionId).configResetStat(configTarget(node, replicas));
      },
    },
    monitor: async function* ({ sessionId, node }, { signal }) {
      const stream = await redis(sessionId).monitor({ signal, ...nodeOption(node) });
      try {
        for await (const event of stream) yield event;
      } finally {
        await stream.close();
      }
    },
    search: {
      list: ({ sessionId, node }) => redis(sessionId).searchIndexes(nodeOption(node)),
      info: ({ sessionId, index, node }) => redis(sessionId).searchInfo(index, nodeOption(node)),
      query: ({ sessionId, index, query, ...options }) =>
        redis(sessionId).searchQuery(index, query, definedOnly(options)),
      explain: ({ sessionId, index, query, dialect, node }) =>
        redis(sessionId).searchExplain(index, query, {
          ...(dialect !== undefined ? { dialect } : {}),
          ...nodeOption(node),
        }),
      create: async ({ sessionId, definition, node, confirmed }) => {
        guard(WRITE, confirmed);
        await redis(sessionId).searchCreate(definition, nodeOption(node));
      },
      drop: async ({ sessionId, index, deleteDocuments, node, confirmed }) => {
        guard(
          destructive(
            deleteDocuments
              ? 'drops the search index and deletes every document it indexed'
              : 'drops the search index',
          ),
          confirmed,
        );
        await redis(sessionId).searchDrop(index, deleteDocuments, nodeOption(node));
      },
      suggest: ({ sessionId, keyType, prefix, sample, node }) =>
        redis(sessionId).searchSuggest(keyType, prefix, {
          ...(sample !== undefined ? { sample } : {}),
          ...nodeOption(node),
        }),
    },
    bigKeys: ({ sessionId, ...options }, { signal, progress }) =>
      redis(sessionId).bigKeys({
        signal,
        onProgress: progress,
        ...(options.sampleSize !== undefined ? { sampleSize: options.sampleSize } : {}),
        ...(options.timeBudgetMs !== undefined ? { timeBudgetMs: options.timeBudgetMs } : {}),
        ...(options.match !== undefined ? { match: options.match } : {}),
        ...(options.memorySamples !== undefined ? { memorySamples: options.memorySamples } : {}),
        ...(options.top !== undefined ? { top: options.top } : {}),
        ...nodeOption(options.node),
      }),
    acl: {
      users: ({ sessionId }) => redis(sessionId).aclUsers(),
      list: ({ sessionId }) => redis(sessionId).aclList(),
      getUser: ({ sessionId, name }) => redis(sessionId).aclGetUser(name),
      setUser: async ({ sessionId, name, rules, confirmed }) => {
        guard(destructive('changes access control'), confirmed);
        await redis(sessionId).aclSetUser(name, rules);
      },
      delUser: async ({ sessionId, names, confirmed }) => {
        guard(destructive('deletes ACL users'), confirmed);
        return { deleted: await redis(sessionId).aclDelUser(names) };
      },
      whoAmI: async ({ sessionId }) => ({ user: await redis(sessionId).aclWhoAmI() }),
    },
    subscribe: async function* (
      { sessionId, channels, patterns, shardChannels, bufferSize },
      { signal },
    ) {
      const subscription = await redis(sessionId).subscribe({
        signal,
        ...(channels !== undefined ? { channels } : {}),
        ...(patterns !== undefined ? { patterns } : {}),
        ...(shardChannels !== undefined ? { shardChannels } : {}),
        ...(bufferSize !== undefined ? { bufferSize } : {}),
      });
      try {
        for await (const message of subscription) yield message;
      } finally {
        await subscription.close();
      }
    },
    publish: async ({ sessionId, channel, message, sharded, confirmed }) => {
      guard(WRITE, confirmed);
      const receivers = await redis(sessionId).publish(
        channel,
        message,
        sharded === undefined ? {} : { sharded },
      );
      return { receivers };
    },
    channels: ({ sessionId, pattern }) => redis(sessionId).pubsubChannels(pattern),
    topology: ({ sessionId }) => redis(sessionId).topology(),
  };
}
