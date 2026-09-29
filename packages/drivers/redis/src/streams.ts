import { JoineryError } from '@joinery/core';
import { toBytes, unescapeRepr, utf8Bytes } from '@joinery/redis-tools';
import type { Cluster, Redis } from 'ioredis';

import { addressOf, type RedisConnection } from './client';
import { mapRedisError } from './errors';
import { ownBytes } from './replies';
import type {
  MonitorEvent,
  MonitorOptions,
  MonitorStream,
  PubSubMessage,
  PubSubSubscription,
  SubscribeOptions,
} from './types';

type WithoutDropped<T> = Omit<T, 'dropped'>;

/**
 * A bounded queue behind an async iterator. When the consumer falls behind by more than
 * `capacity` items, the oldest are dropped and the next item reports how many.
 */
export class DropQueue<T extends { readonly dropped: number }> implements AsyncIterableIterator<T> {
  private readonly items: WithoutDropped<T>[] = [];
  private waiting: ((result: IteratorResult<T>) => void) | undefined;
  private failure: ((error: unknown) => void) | undefined;
  private dropped = 0;
  private ended = false;
  private error: unknown;

  constructor(
    private readonly capacity: number,
    private readonly onReturn: () => Promise<void>,
  ) {}

  push(item: WithoutDropped<T>): void {
    if (this.ended) return;
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = undefined;
      this.failure = undefined;
      resolve({ value: this.withDropped(item), done: false });
      return;
    }
    this.items.push(item);
    if (this.items.length > this.capacity) {
      this.items.shift();
      this.dropped += 1;
    }
  }

  private withDropped(item: WithoutDropped<T>): T {
    const out = { ...item, dropped: this.dropped } as T;
    this.dropped = 0;
    return out;
  }

  end(error?: unknown): void {
    if (this.ended) return;
    this.ended = true;
    this.error = error;
    if (this.waiting) {
      const resolve = this.waiting;
      const reject = this.failure;
      this.waiting = undefined;
      this.failure = undefined;
      if (error !== undefined && reject) reject(error);
      else resolve({ value: undefined, done: true });
    }
  }

  next(): Promise<IteratorResult<T>> {
    const item = this.items.shift();
    if (item !== undefined) return Promise.resolve({ value: this.withDropped(item), done: false });
    if (this.ended) {
      return this.error !== undefined
        ? Promise.reject(this.error)
        : Promise.resolve({ value: undefined, done: true });
    }
    return new Promise((resolve, reject) => {
      this.waiting = resolve;
      this.failure = reject;
    });
  }

  async return(): Promise<IteratorResult<T>> {
    await this.onReturn();
    return { value: undefined, done: true };
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<T> {
    return this;
  }
}

function asBuffer(value: Buffer | string): Uint8Array {
  return typeof value === 'string' ? utf8Bytes(value) : ownBytes(value);
}

/**
 * Subscribes on a dedicated connection (a subscribed connection can run nothing else).
 * Resolves once the server confirmed every subscription; iterate the result for messages.
 */
export async function subscribe(
  conn: RedisConnection,
  options: SubscribeOptions,
): Promise<PubSubSubscription> {
  const channels = (options.channels ?? []).map((c) => Buffer.from(toBytes(c)));
  const patterns = (options.patterns ?? []).map((p) => Buffer.from(toBytes(p)));
  const shards = (options.shardChannels ?? []).map((c) => Buffer.from(toBytes(c)));
  if (channels.length + patterns.length + shards.length === 0) {
    throw new JoineryError({
      code: 'VALIDATION_FAILED',
      message: 'Subscribe to at least one channel or pattern',
    });
  }
  const client = await conn.duplicate();
  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    queue.end();
    client.disconnect();
  };
  const queue = new DropQueue<PubSubMessage>(options.bufferSize ?? 10_000, close);
  client.on('messageBuffer', (channel: Buffer, message: Buffer) => {
    queue.push({
      kind: 'message',
      channel: ownBytes(channel),
      message: ownBytes(message),
      receivedAt: Date.now(),
    });
  });
  client.on('pmessageBuffer', (pattern: Buffer | string, channel: Buffer, message: Buffer) => {
    queue.push({
      kind: 'pmessage',
      pattern: asBuffer(pattern),
      channel: ownBytes(channel),
      message: ownBytes(message),
      receivedAt: Date.now(),
    });
  });
  client.on('smessageBuffer', (channel: Buffer, message: Buffer) => {
    queue.push({
      kind: 'smessage',
      channel: ownBytes(channel),
      message: ownBytes(message),
      receivedAt: Date.now(),
    });
  });
  client.on('end', () => queue.end());
  try {
    if (channels.length > 0) await client.subscribe(...channels);
    if (patterns.length > 0) await client.callBuffer('psubscribe', ...patterns);
    if (shards.length > 0) await client.ssubscribe(...shards);
  } catch (error) {
    await close();
    throw mapRedisError(error, conn.context('command', 'SUBSCRIBE'));
  }
  options.signal?.addEventListener('abort', () => void close(), { once: true });
  return {
    [Symbol.asyncIterator]: () => queue,
    close,
  };
}

/**
 * MONITOR on dedicated connections (one per node in Cluster mode). MONITOR slows the server
 * down; the UI shows a performance warning before starting it.
 */
export async function monitor(
  conn: RedisConnection,
  options: MonitorOptions = {},
): Promise<MonitorStream> {
  const nodes: Redis[] = options.node !== undefined ? [conn.node(options.node)] : conn.primaries();
  const monitors: (Redis | Cluster)[] = [];
  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    queue.end();
    for (const m of monitors) m.disconnect();
  };
  const queue = new DropQueue<MonitorEvent>(options.bufferSize ?? 10_000, close);
  try {
    for (const node of nodes) {
      const address = addressOf(node);
      const m = await node.monitor();
      m.on('error', () => undefined);
      conn.adopt(m);
      monitors.push(m);
      m.on('monitor', (time: string, args: string[], source: string, database: string) => {
        queue.push({
          timestamp: Number(time),
          db: Number(database),
          source,
          args: args.map(unescapeRepr),
          node: address,
        });
      });
      m.on('end', () => void close());
    }
  } catch (error) {
    await close();
    throw mapRedisError(error, conn.context('command', 'MONITOR'));
  }
  options.signal?.addEventListener('abort', () => void close(), { once: true });
  return { [Symbol.asyncIterator]: () => queue, close };
}
