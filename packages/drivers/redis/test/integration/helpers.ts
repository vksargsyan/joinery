import { randomBytes } from 'node:crypto';

import {
  connectionProfileSchema,
  type ConnectionProfileInput,
  type ResolvedProfile,
  type ResultChunk,
} from '@joinery/core';

import { createRedisAdapter, redisProfileFromUrl, type RedisSession } from '../../src';

export const REDIS_URL = process.env['JOINERY_TEST_REDIS_URL'];
/** "user:password" of an ACL user limited to ~app:* without @dangerous. */
export const REDIS_ACL_USER = process.env['JOINERY_TEST_REDIS_ACL_USER'];
/** "host:port/masterName". */
export const REDIS_SENTINEL = process.env['JOINERY_TEST_REDIS_SENTINEL'];
/** Comma-separated "host:port" seeds. */
export const REDIS_CLUSTER = process.env['JOINERY_TEST_REDIS_CLUSTER'];
export const REDIS_TLS_URL = process.env['JOINERY_TEST_REDIS_TLS_URL'];
export const REDIS_TLS_CA = process.env['JOINERY_TEST_REDIS_TLS_CA'];

export const adapter = createRedisAdapter();

/** "host:port" of the standalone test server. */
export function standaloneAddress(): string {
  const url = new URL(REDIS_URL!);
  return `${url.hostname}:${url.port || 6379}`;
}

/** The password of the test servers (the standalone URL's; Sentinel and Cluster share it). */
export function testPassword(): string | undefined {
  return REDIS_URL ? decodeURIComponent(new URL(REDIS_URL).password) || undefined : undefined;
}

export function standaloneProfile(
  overrides: Partial<ConnectionProfileInput> = {},
): ResolvedProfile {
  if (!REDIS_URL) throw new Error('JOINERY_TEST_REDIS_URL is not set');
  return redisProfileFromUrl(REDIS_URL, overrides);
}

function profileWith(
  input: Partial<ConnectionProfileInput>,
  password: string | undefined,
  user?: string,
): ResolvedProfile {
  const now = new Date().toISOString();
  const profile = connectionProfileSchema.parse({
    id: 'test-redis',
    name: 'Test Redis',
    engine: 'redis',
    endpoint: { kind: 'host', host: '127.0.0.1', port: 6379 },
    auth: password
      ? { method: 'password', ...(user ? { user } : {}), password: { id: 'password' } }
      : { method: 'none' },
    tls: { mode: 'disable' },
    createdAt: now,
    updatedAt: now,
    ...input,
  });
  return { profile, secrets: password ? { password } : {} };
}

export function aclProfile(): ResolvedProfile {
  const [user, password] = REDIS_ACL_USER!.split(':') as [string, string];
  const url = new URL(REDIS_URL!);
  return profileWith(
    { endpoint: { kind: 'host', host: url.hostname, port: Number(url.port) } },
    password,
    user,
  );
}

export function sentinelProfile(overrides: Partial<ConnectionProfileInput> = {}): ResolvedProfile {
  const [address, masterName] = REDIS_SENTINEL!.split('/') as [string, string];
  const [host, port] = address.split(':') as [string, string];
  return profileWith(
    {
      endpoint: { kind: 'sentinel', sentinels: [{ host, port: Number(port) }], masterName },
      ...overrides,
    },
    testPassword(),
  );
}

export function clusterProfile(overrides: Partial<ConnectionProfileInput> = {}): ResolvedProfile {
  const seeds = REDIS_CLUSTER!.split(',').map((s) => {
    const [host, port] = s.trim().split(':') as [string, string];
    return { host, port: Number(port) };
  });
  return profileWith({ endpoint: { kind: 'cluster', seeds }, ...overrides }, testPassword());
}

export async function connect(resolved: ResolvedProfile): Promise<RedisSession> {
  return adapter.connect(resolved);
}

/** A random key prefix for one test: `joinery:it:<random>:`. */
export function newPrefix(): string {
  return `joinery:it:${randomBytes(6).toString('hex')}:`;
}

/** Deletes every key under the prefix (every primary in Cluster mode); never FLUSHDB. */
export async function cleanup(session: RedisSession | undefined, prefix: string): Promise<void> {
  if (!session) return;
  const escaped = prefix.replace(/[*?[\]\\]/g, '\\$&');
  await session.bulkDelete({ match: `${escaped}*` });
}

let executions = 0;

/** Runs command text and returns the chunks. */
export async function run(
  session: RedisSession,
  text: string,
  executionId?: string,
): Promise<ResultChunk[]> {
  executions += 1;
  const chunks: ResultChunk[] = [];
  for await (const chunk of session.execute(text, {
    executionId: executionId ?? `x${executions}`,
  })) {
    chunks.push(chunk);
  }
  return chunks;
}

/** The formatted replies of each command in the text. */
export async function replies(session: RedisSession, text: string): Promise<string[]> {
  return (await run(session, text)).flatMap((c) =>
    c.type === 'rows' ? [String(c.data[0]![0])] : [],
  );
}

export const enc = (text: string): Uint8Array => new TextEncoder().encode(text);
export const dec = (bytes: Uint8Array | null | undefined): string | null =>
  bytes ? new TextDecoder().decode(bytes) : null;

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
