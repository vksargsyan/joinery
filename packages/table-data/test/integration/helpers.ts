import { randomBytes } from 'node:crypto';

import { newId, rowAt, type CellValue, type Session, type SqlDialect } from '@joinery/core';
import { createMysqlAdapter } from '@joinery/driver-mysql';
import { createPostgresAdapter } from '@joinery/driver-postgres';
import { resolvedProfileFromUrl } from '@joinery/driver-sql-base';
import { quoteIdent } from '@joinery/sql-tools';

/**
 * Real-server plumbing: the configured servers (JOINERY_TEST_*_URL), a scratch database per
 * suite that is always dropped, and plain query helpers that bypass the package under test.
 */

export type ServerEngine = 'postgres' | 'mysql' | 'mariadb';

export interface TestServer {
  readonly engine: ServerEngine;
  /** A session on `database`, or on the URL's database. */
  connect(database?: string): Promise<Session>;
}

const ENV: readonly (readonly [ServerEngine, string])[] = [
  ['postgres', 'JOINERY_TEST_POSTGRES_URL'],
  ['mysql', 'JOINERY_TEST_MYSQL_URL'],
  ['mariadb', 'JOINERY_TEST_MARIADB_URL'],
];

export function configuredServers(): TestServer[] {
  const servers: TestServer[] = [];
  for (const [engine, variable] of ENV) {
    const url = process.env[variable];
    if (url === undefined || url === '') continue;
    const adapter =
      engine === 'postgres' ? createPostgresAdapter() : createMysqlAdapter({ engine });
    servers.push({
      engine,
      connect: (database) =>
        adapter.connect(
          resolvedProfileFromUrl(url, {
            engine,
            options: {
              ...(database !== undefined ? { defaultDatabase: database } : {}),
              queryTimeoutMs: 120_000,
            },
          }),
        ),
    });
  }
  return servers;
}

/** Runs one statement and returns the rows of its first result. */
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

/** A scratch database with its own session; `drop` closes every session and removes it. */
export class ScratchDatabase {
  readonly name = `jtd_${randomBytes(4).toString('hex')}`;
  private readonly sessions: Session[] = [];

  constructor(readonly server: TestServer) {}

  get dialect(): SqlDialect {
    return this.server.engine;
  }

  async create(): Promise<Session> {
    const admin = await this.server.connect();
    try {
      await query(
        admin,
        this.server.engine === 'postgres'
          ? `CREATE DATABASE ${quoteIdent(this.name, 'postgres')}`
          : `CREATE DATABASE ${quoteIdent(this.name, 'mysql')} CHARACTER SET utf8mb4`,
      );
    } finally {
      await admin.close();
    }
    return this.connect();
  }

  /** Another session on the scratch database. */
  async connect(): Promise<Session> {
    const session = await this.server.connect(this.name);
    this.sessions.push(session);
    return session;
  }

  async drop(): Promise<void> {
    for (const session of this.sessions.splice(0)) await session.close().catch(() => undefined);
    const admin = await this.server.connect();
    try {
      await query(
        admin,
        this.server.engine === 'postgres'
          ? `DROP DATABASE IF EXISTS ${quoteIdent(this.name, 'postgres')} WITH (FORCE)`
          : `DROP DATABASE IF EXISTS ${quoteIdent(this.name, 'mysql')}`,
      ).catch(() => undefined);
    } finally {
      await admin.close();
    }
  }
}
