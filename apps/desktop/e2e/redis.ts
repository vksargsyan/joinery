import { randomBytes } from 'node:crypto';

import { createRedisAdapter, redisProfileFromUrl, type RedisSession } from '@joinery/driver-redis';
import { replyText, type RedisReply } from '@joinery/redis-tools';

/**
 * Direct Redis access for the end-to-end tests: a session that bypasses the app, to seed keys
 * under a prefix unique to the run, check what the app wrote, and delete the prefix afterwards
 * (never FLUSHDB).
 */

export function connectRedis(url: string): Promise<RedisSession> {
  return createRedisAdapter().connect(redisProfileFromUrl(url));
}

/** `joinery:e2e:<random>:`, unique per run. */
export function e2ePrefix(): string {
  return `joinery:e2e:${randomBytes(4).toString('hex')}:`;
}

/** Runs one command (text arguments) and returns its reply. */
export function redisCommand(session: RedisSession, ...args: string[]): Promise<RedisReply> {
  return session.command(args);
}

/** A command's reply as text (bulk, status or integer); null for nil. */
export async function redisText(session: RedisSession, ...args: string[]): Promise<string | null> {
  const reply = await session.command(args);
  return reply.type === 'nil' ? null : (replyText(reply) ?? null);
}

/** Deletes every key under the prefix. */
export async function deletePrefix(session: RedisSession, prefix: string): Promise<void> {
  await session.bulkDelete({ match: `${prefix.replace(/[*?[\]\\]/g, '\\$&')}*` });
}
