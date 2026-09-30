import { randomBytes } from 'node:crypto';

import type { ResolvedProfile, Session } from '@joinery/core';
import { mongodbAdapter, parseHostList, splitMongoUri } from '@joinery/driver-mongodb';
import { createRedisAdapter, redisProfileFromUrl } from '@joinery/driver-redis';
import { connectionProfileSchema } from '@joinery/core';
import { quoteIdent } from '@joinery/sql-tools';

import type { OpenedSession, SessionOpener } from '../../src';
import { configuredServers, query, type ServerEngine, type TestServer } from './helpers';

/**
 * Plumbing for the database-to-database suites: scratch databases on every configured SQL
 * server (always dropped), session openers for the transfer, and MongoDB and Redis sessions
 * from the JOINERY_TEST_* URLs.
 */

export const SQL_SERVERS = configuredServers();
export const MONGO_URL = process.env['JOINERY_TEST_MONGODB_URL'];
export const REDIS_URL = process.env['JOINERY_TEST_REDIS_URL'];
export const REDIS_CLUSTER = process.env['JOINERY_TEST_REDIS_CLUSTER'];

export function server(engine: ServerEngine): TestServer | undefined {
  return SQL_SERVERS.find((s) => s.engine === engine);
}

/** A session opener that also records what it opened, so tests can count sessions. */
export function opener(open: () => Promise<Session>): SessionOpener & { opened: number } {
  const fn = Object.assign(
    async (): Promise<OpenedSession> => {
      fn.opened++;
      const session = await open();
      return { session, close: () => session.close() };
    },
    { opened: 0 },
  );
  return fn;
}

/** A scratch database on a SQL server. */
export interface Scratch {
  readonly name: string;
  readonly server: TestServer;
  connect(): Promise<Session>;
  drop(): Promise<void>;
}

export async function scratch(target: TestServer, label: string): Promise<Scratch> {
  const name = `jdt_${label
    .replace(/[^a-z0-9]+/gi, '_')
    .toLowerCase()
    .slice(0, 20)}_${randomBytes(3).toString('hex')}`;
  const admin = await target.connect();
  try {
    await query(
      admin,
      target.engine === 'postgres'
        ? `CREATE DATABASE ${quoteIdent(name, 'postgres')}`
        : `CREATE DATABASE ${quoteIdent(name, 'mysql')} CHARACTER SET utf8mb4`,
    );
  } finally {
    await admin.close();
  }
  return {
    name,
    server: target,
    connect: () => target.connect(name),
    async drop() {
      const session = await target.connect();
      try {
        await query(
          session,
          target.engine === 'postgres'
            ? `DROP DATABASE IF EXISTS ${quoteIdent(name, 'postgres')} WITH (FORCE)`
            : `DROP DATABASE IF EXISTS ${quoteIdent(name, 'mysql')}`,
        );
      } finally {
        await session.close();
      }
    },
  };
}

/** A resolved MongoDB profile from a test URL (password auth, the URL's replica set). */
export function mongoProfile(url: string, database?: string): ResolvedProfile {
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
    options: {
      connectTimeoutMs: 5000,
      ...(authSource ? { authSource } : {}),
      ...(database !== undefined ? { defaultDatabase: database } : {}),
    },
  });
  return { profile, secrets: parts.password ? { password: parts.password } : {} };
}

export function connectMongo(database?: string): Promise<Session> {
  return mongodbAdapter.connect(mongoProfile(MONGO_URL!, database));
}

const redisAdapter = createRedisAdapter();

export function connectRedis(database = 0): Promise<Session> {
  return redisAdapter.connect(
    redisProfileFromUrl(REDIS_URL!, { options: { defaultDatabase: String(database) } }),
  );
}

export function connectCluster(): Promise<Session> {
  const seeds = REDIS_CLUSTER!.split(',').map((seed) => {
    const [host, port] = seed.split(':') as [string, string];
    return { host, port: Number(port) };
  });
  const password = decodeURIComponent(new URL(REDIS_URL!).password);
  const now = new Date().toISOString();
  const profile = connectionProfileSchema.parse({
    id: 'test-redis-cluster',
    name: 'Test Redis Cluster',
    engine: 'redis',
    endpoint: { kind: 'cluster', seeds },
    auth: { method: 'password', password: { id: 'password' } },
    tls: { mode: 'disable' },
    createdAt: now,
    updatedAt: now,
  });
  return redisAdapter.connect({ profile, secrets: { password } });
}
