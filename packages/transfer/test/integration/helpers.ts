import { randomBytes } from 'node:crypto';

import type { CellValue, ResolvedProfile, Session, SqlDialect } from '@querybara/core';
import { newId, rowAt } from '@querybara/core';
import { createMysqlAdapter } from '@querybara/driver-mysql';
import { createPostgresAdapter } from '@querybara/driver-postgres';
import { resolvedProfileFromUrl } from '@querybara/driver-sql-base';
import { quoteIdent } from '@querybara/sql-tools';

/**
 * Real-server plumbing for the transfer suites: the servers configured through
 * QUERYBARA_TEST_*_URL, scratch databases that are always dropped, and small query helpers.
 */

export type ServerEngine = 'postgres' | 'mysql' | 'mariadb';

export interface TestServer {
  readonly engine: ServerEngine;
  readonly dialect: SqlDialect;
  /** A session on `database`, or on the URL's database. */
  connect(database?: string): Promise<Session>;
}

const ENV: readonly (readonly [ServerEngine, string])[] = [
  ['postgres', 'QUERYBARA_TEST_POSTGRES_URL'],
  ['mysql', 'QUERYBARA_TEST_MYSQL_URL'],
  ['mariadb', 'QUERYBARA_TEST_MARIADB_URL'],
];

function profileFor(engine: ServerEngine, url: string, database?: string): ResolvedProfile {
  return resolvedProfileFromUrl(url, {
    engine,
    options: {
      ...(database !== undefined ? { defaultDatabase: database } : {}),
      queryTimeoutMs: 300_000,
    },
  });
}

export function configuredServers(): TestServer[] {
  const servers: TestServer[] = [];
  for (const [engine, variable] of ENV) {
    const url = process.env[variable];
    if (url === undefined || url === '') continue;
    const adapter =
      engine === 'postgres' ? createPostgresAdapter() : createMysqlAdapter({ engine });
    servers.push({
      engine,
      dialect: engine,
      connect: (database) => adapter.connect(profileFor(engine, url, database)),
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

export async function runAll(session: Session, statements: readonly string[]): Promise<void> {
  for (const statement of statements) await query(session, statement);
}

/** A unique, valid database name (≤ 63 characters, lower case). */
export function scratchName(label: string): string {
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .slice(0, 30);
  return `jtr_${slug}_${randomBytes(3).toString('hex')}`;
}

/** Scratch databases on one server; `dropAll` closes their sessions and drops them. */
export class ScratchDatabases {
  private readonly created: { name: string; sessions: Session[] }[] = [];

  constructor(private readonly server: TestServer) {}

  /** Creates a database and returns a session connected to it. */
  async create(label: string): Promise<Session> {
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
    const entry = { name, sessions: [] as Session[] };
    this.created.push(entry);
    const session = await this.server.connect(name);
    entry.sessions.push(session);
    return session;
  }

  /** Another session on a database created here (for concurrent checks). */
  async connectTo(session: Session): Promise<Session> {
    const entry = this.created.find((e) => e.sessions.includes(session));
    if (entry === undefined) throw new Error('unknown session');
    const other = await this.server.connect(entry.name);
    entry.sessions.push(other);
    return other;
  }

  async dropAll(): Promise<void> {
    for (const entry of this.created) {
      for (const session of entry.sessions) await session.close().catch(() => undefined);
    }
    if (this.created.length === 0) return;
    const admin = await this.server.connect();
    try {
      for (const { name } of this.created.splice(0)) {
        const sql =
          this.server.engine === 'postgres'
            ? `DROP DATABASE IF EXISTS ${quoteIdent(name, 'postgres')} WITH (FORCE)`
            : `DROP DATABASE IF EXISTS ${quoteIdent(name, 'mysql')}`;
        await query(admin, sql).catch(() => undefined);
      }
    } finally {
      await admin.close();
    }
  }
}

/** Every row of a table in key order. */
export function tableRows(
  session: Session,
  table: string,
  dialect: SqlDialect,
): Promise<CellValue[][]> {
  return query(session, `SELECT * FROM ${quoteIdent(table, dialect)} ORDER BY 1`);
}

/** A table with every common column type, and rows exercising their edge cases. */
export function typesTable(
  engine: ServerEngine,
  name: string,
): { create: string; insert: string[] } {
  const q = (n: string): string => quoteIdent(n, engine);
  if (engine === 'postgres') {
    return {
      create: `CREATE TABLE ${q(name)} (
        id integer PRIMARY KEY,
        small smallint,
        big bigint,
        price numeric(20,6),
        ratio double precision,
        real_v real,
        ok boolean,
        day date,
        moment timestamp(6) without time zone,
        moment_tz timestamp(6) with time zone,
        clock time,
        label varchar(100),
        body text,
        doc jsonb,
        bin bytea,
        ref uuid,
        tags integer[],
        span interval
      )`,
      insert: [
        `INSERT INTO ${q(name)} VALUES
          (1, 12, 9007199254740993, 12.5, 0.1, 1.5, true, '2024-02-29', '2024-01-02 03:04:05.123456', '2024-01-02 03:04:05.5+00', '10:11:12', 'plain', 'x', '{"a": [1, 2], "b": {"c": null}}', '\\xdeadbeef00ff', '0b5e4b9c-6f1e-4c8e-9d7a-2a1c3e4f5a6b', '{1,2,3}', '1 day 02:00:00'),
          (2, -32768, -9223372036854775808, -0.000001, 1e-300, -2.5, false, '1999-12-31', '1999-12-31 23:59:59', '1999-12-31 23:59:59+00', '00:00:00', 'O''Brien, "quoted"', E'multi\\nline\\ttab\\\\back', '[]', '\\x', 'ffffffff-ffff-ffff-ffff-ffffffffffff', '{}', '-00:00:01'),
          (3, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL),
          (4, 0, 0, 99999999999999.999999, 'NaN', 'Infinity', true, '0001-01-01', '2038-01-19 03:14:07.999999', '2038-01-19 03:14:07.999999+00', '23:59:59.999999', '', 'Grüße, 東京, emoji 😀', '{"k": "v; with, delimiters\\nand \\"quotes\\""}', '\\x00', '00000000-0000-0000-0000-000000000000', '{-1,NULL}', '0 seconds'),
          (5, 1, 1, 1, -1.5e10, 0, false, '2024-01-01', '2024-01-01 00:00:00', '2024-01-01 00:00:00+00', '12:00:00', 'NULL', '\\N', '{"n": 1.5}', '\\x5c4e', 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', '{7}', '1 year')`,
      ],
    };
  }
  const json = engine === 'mysql' ? 'json' : 'longtext';
  return {
    create: `CREATE TABLE ${q(name)} (
      id int PRIMARY KEY,
      small smallint,
      big bigint,
      ubig bigint unsigned,
      price decimal(20,6),
      ratio double,
      ok tinyint(1),
      day date,
      moment datetime(6),
      stamp timestamp(3) NULL,
      clock time,
      label varchar(100),
      body text,
      doc ${json},
      bin varbinary(64),
      blobv blob,
      ref char(36),
      choice enum('red','green','blue'),
      yr year
    )`,
    insert: [
      `INSERT INTO ${q(name)} VALUES
        (1, 12, 9007199254740993, 18446744073709551615, 12.5, 0.1, 1, '2024-02-29', '2024-01-02 03:04:05.123456', '2024-01-02 03:04:05.500', '10:11:12', 'plain', 'x', '{"a": [1, 2], "b": {"c": null}}', X'deadbeef00ff', X'00', '0b5e4b9c-6f1e-4c8e-9d7a-2a1c3e4f5a6b', 'red', 2024),
        (2, -32768, -9223372036854775808, 0, -0.000001, 1e-300, 0, '1999-12-31', '1999-12-31 23:59:59', '1999-12-31 23:59:59', '-838:59:59', 'O''Brien, "quoted"', 'multi\\nline\\ttab\\\\back', '[]', X'', X'', 'ffffffff-ffff-ffff-ffff-ffffffffffff', 'green', 1901),
        (3, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL),
        (4, 0, 0, 1, 99999999999999.999999, -1.5e10, 5, '1000-01-01', '9999-12-31 23:59:59.999999', '2038-01-18 03:14:07.999', '838:59:59', '', 'Grüße, 東京, emoji 😀', '{"k": "v; with, delimiters\\\\nand \\\\"quotes\\\\""}', X'5c4e', X'0d0a', '00000000-0000-0000-0000-000000000000', 'blue', 2155),
        (5, 1, 1, 1, 1, 0, 0, '2024-01-01', '2024-01-01 00:00:00', '2024-01-01 00:00:00', '12:00:00', 'NULL', '\\\\N', '{"n": 1.5}', X'00', X'ff', 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', 'red', 2000)`,
    ],
  };
}
