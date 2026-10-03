import { randomBytes } from 'node:crypto';

import {
  connectionProfileSchema,
  type ConnectionProfileInput,
  type ExecOptions,
  type ResolvedProfile,
  type ResultChunk,
} from '@querybara/core';

import {
  isMongoSession,
  mongodbAdapter,
  parseHostList,
  splitMongoUri,
  type MongoSession,
} from '../../src';

/** The 8.0 replica set (CI's shape): everything, including transactions and change streams. */
export const MONGO_URL = process.env['QUERYBARA_TEST_MONGODB_URL'];
/** The 7.0 standalone with TLS preferred and an X.509 user (local only). */
export const STANDALONE_URL = process.env['QUERYBARA_TEST_MONGODB_STANDALONE_URL'];
export const TLS_CA = process.env['QUERYBARA_TEST_MONGODB_TLS_CA'];
export const X509_CERT = process.env['QUERYBARA_TEST_MONGODB_X509_CERT'];

/**
 * A resolved MongoDB profile from a test URL: a host endpoint (or a host list with the URL's
 * replica set), password auth with the password moved into the secrets, the URL's authSource,
 * TLS off unless overridden.
 */
export function mongoProfile(
  url: string,
  overrides: Partial<ConnectionProfileInput> = {},
): ResolvedProfile {
  const parts = splitMongoUri(url);
  const params = new URLSearchParams(parts.query);
  const hosts = parseHostList(parts.hosts);
  const replicaSet = params.get('replicaSet') ?? undefined;
  const authSource = params.get('authSource') ?? undefined;
  const now = new Date().toISOString();
  const profile = connectionProfileSchema.parse({
    id: 'test-mongodb',
    name: 'Test MongoDB',
    engine: 'mongodb',
    endpoint: replicaSet
      ? { kind: 'hosts', hosts, replicaSet }
      : { kind: 'host', host: hosts[0]!.host, port: hosts[0]!.port },
    auth: {
      method: 'password',
      ...(parts.user ? { user: parts.user } : {}),
      ...(parts.password ? { password: { id: 'password' } } : {}),
    },
    tls: { mode: 'disable' },
    createdAt: now,
    updatedAt: now,
    ...overrides,
    options: {
      connectTimeoutMs: 5000,
      ...(authSource ? { authSource } : {}),
      ...overrides.options,
    },
  });
  return { profile, secrets: parts.password ? { password: parts.password } : {} };
}

export async function connectMongo(
  url: string,
  overrides: Partial<ConnectionProfileInput> = {},
): Promise<MongoSession> {
  const session = await mongodbAdapter.connect(mongoProfile(url, overrides));
  if (!isMongoSession(session)) throw new Error('expected a MongoSession');
  return session;
}

/** A database name no other test uses. */
export function testDatabase(): string {
  return `querybara_it_${randomBytes(5).toString('hex')}`;
}

let counter = 0;
export function execId(): string {
  counter += 1;
  return `mongo-exec-${counter}`;
}

/** Runs a command through `execute` and collects the chunks. */
export async function collect(
  session: MongoSession,
  text: string,
  opts: Partial<ExecOptions> = {},
): Promise<ResultChunk[]> {
  const chunks: ResultChunk[] = [];
  for await (const chunk of session.execute(text, { executionId: execId(), ...opts }))
    chunks.push(chunk);
  return chunks;
}

/** The `document` cells of an execute result. */
export function cells(chunks: readonly ResultChunk[]): string[] {
  return chunks.flatMap((chunk) => (chunk.type === 'rows' ? (chunk.data[0] as string[]) : []));
}

/** Drains an async iterable of pages into one array. */
export async function drain<T>(
  pages: AsyncIterable<{ readonly documents: readonly T[] }>,
): Promise<T[]> {
  const out: T[] = [];
  for await (const page of pages) out.push(...page.documents);
  return out;
}
