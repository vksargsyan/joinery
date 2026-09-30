import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  connectionProfileSchema,
  newId,
  rowAt,
  type CellValue,
  type ResolvedProfile,
  type SchemaSnapshot,
  type Session,
} from '@joinery/core';
import {
  isMongoSession,
  mongodbAdapter,
  parseHostList,
  splitMongoUri,
  type MongoSession,
} from '@joinery/driver-mongodb';
import { createMysqlAdapter } from '@joinery/driver-mysql';
import {
  isRedisSession,
  redisAdapter,
  redisProfileFromUrl,
  type RedisSession,
} from '@joinery/driver-redis';
import { createPostgresAdapter } from '@joinery/driver-postgres';
import { resolvedProfileFromUrl } from '@joinery/driver-sql-base';
import { quoteIdent } from '@joinery/sql-tools';
import { compareSchemas, compareTableData, type TablePair } from '@joinery/sync';
import { expect } from 'vitest';

/**
 * Real-server plumbing for the backup round trips: configured servers (JOINERY_TEST_*_URL),
 * scratch databases that are always dropped, and the structure and data compares that prove a
 * restored database matches its source.
 */

export type SqlServerEngine = 'postgres' | 'mysql' | 'mariadb';

export interface SqlServer {
  readonly engine: SqlServerEngine;
  readonly url: string;
  profile(database?: string): ResolvedProfile;
  connect(database?: string): Promise<Session>;
}

const ENV: readonly (readonly [SqlServerEngine, string])[] = [
  ['postgres', 'JOINERY_TEST_POSTGRES_URL'],
  ['mysql', 'JOINERY_TEST_MYSQL_URL'],
  ['mariadb', 'JOINERY_TEST_MARIADB_URL'],
];

export function sqlServer(engine: SqlServerEngine): SqlServer | undefined {
  const variable = ENV.find(([e]) => e === engine)![1];
  const url = process.env[variable];
  if (url === undefined || url === '') return undefined;
  const adapter = engine === 'postgres' ? createPostgresAdapter() : createMysqlAdapter({ engine });
  const profile = (database?: string): ResolvedProfile =>
    resolvedProfileFromUrl(url, {
      engine,
      options: {
        ...(database !== undefined ? { defaultDatabase: database } : {}),
        queryTimeoutMs: 120_000,
      },
    });
  return { engine, url, profile, connect: (database) => adapter.connect(profile(database)) };
}

export async function query(
  session: Session,
  sql: string,
  params: readonly CellValue[] = [],
): Promise<CellValue[][]> {
  const rows: CellValue[][] = [];
  for await (const chunk of session.execute(sql, {
    executionId: newId(),
    ...(params.length > 0 ? { params } : {}),
  })) {
    if (chunk.type === 'rows' && chunk.resultIndex === 0) {
      for (let r = 0; r < chunk.rowCount; r++) rows.push(rowAt(chunk, r));
    }
  }
  return rows;
}

export async function run(session: Session, statements: readonly string[]): Promise<void> {
  for (const sql of statements) {
    try {
      await query(session, sql);
    } catch (error) {
      throw new Error(`${(error as Error).message}\n${sql}`, { cause: error });
    }
  }
}

export function scratchName(label: string): string {
  return `jbk_${label
    .replace(/[^a-z0-9]+/gi, '_')
    .toLowerCase()
    .slice(0, 30)}_${randomBytes(3).toString('hex')}`;
}

/** Scratch databases on one server; `dropAll` removes every one, sessions first. */
export class ScratchDatabases {
  readonly names: string[] = [];
  readonly #sessions: Session[] = [];

  constructor(readonly server: SqlServer) {}

  /** A new empty database's name (created now). */
  async create(label: string): Promise<string> {
    const name = scratchName(label);
    const admin = await this.server.connect();
    try {
      await query(
        admin,
        this.server.engine === 'postgres'
          ? `CREATE DATABASE ${quoteIdent(name, 'postgres')}`
          : `CREATE DATABASE ${quoteIdent(name, 'mysql')} CHARACTER SET utf8mb4`,
      );
    } finally {
      await admin.close();
    }
    this.names.push(name);
    return name;
  }

  /** A session on one of the databases, closed by `dropAll`. */
  async connect(name: string): Promise<Session> {
    const session = await this.server.connect(name);
    this.#sessions.push(session);
    return session;
  }

  async dropAll(): Promise<void> {
    for (const session of this.#sessions.splice(0)) await session.close().catch(() => undefined);
    if (this.names.length === 0) return;
    const admin = await this.server.connect();
    try {
      for (const name of this.names.splice(0)) {
        await query(
          admin,
          this.server.engine === 'postgres'
            ? `DROP DATABASE IF EXISTS ${quoteIdent(name, 'postgres')} WITH (FORCE)`
            : `DROP DATABASE IF EXISTS ${quoteIdent(name, 'mysql')}`,
        ).catch(() => undefined);
      }
    } finally {
      await admin.close();
    }
  }
}

/** A MongoDB session on the test replica set, in `database`. */
export async function connectMongo(url: string, database: string): Promise<MongoSession> {
  const parts = splitMongoUri(url);
  const params = new URLSearchParams(parts.query);
  const hosts = parseHostList(parts.hosts);
  const replicaSet = params.get('replicaSet') ?? undefined;
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
      authSource: params.get('authSource') ?? 'admin',
      defaultDatabase: database,
    },
  });
  const session = await mongodbAdapter.connect({
    profile,
    secrets: parts.password ? { password: parts.password } : {},
  });
  if (!isMongoSession(session)) throw new Error('expected a MongoSession');
  return session;
}

/** A Redis session from a URL, or on the cluster seeds `host:port,host:port`. */
export async function connectRedis(url: string, cluster?: string): Promise<RedisSession> {
  const base = redisProfileFromUrl(url);
  const resolved = cluster
    ? {
        ...base,
        profile: {
          ...base.profile,
          endpoint: {
            kind: 'cluster' as const,
            seeds: cluster.split(',').map((seed) => {
              const [host, port] = seed.split(':');
              return { host: host!, port: Number(port) };
            }),
          },
        },
      }
    : base;
  const session = await redisAdapter.connect(resolved);
  if (!isRedisSession(session)) throw new Error('expected a RedisSession');
  return session;
}

export function tempDir(label: string): { path: string; remove(): void } {
  const path = mkdtempSync(join(tmpdir(), `joinery-backup-${label}-`));
  return { path, remove: () => rmSync(path, { recursive: true, force: true }) };
}

/** Structure compare with the sync engine: zero differences, in both directions. */
export async function expectSameStructure(
  source: Session,
  target: Session,
  schemas?: readonly string[],
): Promise<void> {
  const scope = schemas !== undefined ? { schemas } : {};
  const a: SchemaSnapshot = await source.introspect(scope);
  const b: SchemaSnapshot = await target.introspect(scope);
  for (const [from, to] of [
    [a, b],
    [b, a],
  ] as const) {
    const { diff } = compareSchemas(from, to);
    const changes = diff.operations.map((op) => `${op.id}: ${op.changes.join('; ')}`);
    expect(changes).toEqual([]);
    expect(diff.identical).toBe(true);
  }
}

/** Data compare with the sync engine: every row equal, none missing or extra. */
export async function expectSameData(
  source: Session,
  target: Session,
  pair: TablePair,
): Promise<number> {
  const events = compareTableData(source, target, pair);
  let summary;
  for (;;) {
    const next = await events.next();
    if (next.done) {
      summary = next.value;
      break;
    }
  }
  expect({
    table: pair.source.name,
    inserts: summary.inserts,
    updates: summary.updates,
    deletes: summary.deletes,
  }).toEqual({ table: pair.source.name, inserts: 0, updates: 0, deletes: 0 });
  expect(summary.targetRows).toBe(summary.sourceRows);
  return summary.sourceRows;
}

/** Rows as text, ordered, for tables compared without a key. */
export async function rowsText(session: Session, sql: string): Promise<string[]> {
  const rows = await query(session, sql);
  return rows.map((row) =>
    JSON.stringify(row, (_key, value: unknown) =>
      typeof value === 'bigint'
        ? `${value}n`
        : value instanceof Uint8Array
          ? Buffer.from(value).toString('hex')
          : value,
    ),
  );
}
