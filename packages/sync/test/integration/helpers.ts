import { randomBytes } from 'node:crypto';

import type { CellValue, ResolvedProfile, Session, SqlDialect } from '@joinery/core';
import { newId, rowAt } from '@joinery/core';
import { createMysqlAdapter } from '@joinery/driver-mysql';
import { createPostgresAdapter } from '@joinery/driver-postgres';
import { resolvedProfileFromUrl } from '@joinery/driver-sql-base';
import { quoteIdent, quoteString, splitStatements } from '@joinery/sql-tools';

/**
 * Real-server plumbing for the round-trip suites: which servers are configured
 * (JOINERY_TEST_*_URL), scratch databases that are always dropped, and running scripts through
 * the drivers the way the app does.
 */

export type ServerEngine = 'postgres' | 'mysql' | 'mariadb';

export interface TestServer {
  readonly engine: ServerEngine;
  readonly url: string;
  /** A session on `database`, or on the URL's database (for CREATE/DROP DATABASE). */
  connect(database?: string): Promise<Session>;
}

const ENV: readonly (readonly [ServerEngine, string])[] = [
  ['postgres', 'JOINERY_TEST_POSTGRES_URL'],
  ['mysql', 'JOINERY_TEST_MYSQL_URL'],
  ['mariadb', 'JOINERY_TEST_MARIADB_URL'],
];

function profileFor(engine: ServerEngine, url: string, database?: string): ResolvedProfile {
  return resolvedProfileFromUrl(url, {
    engine,
    options: {
      ...(database !== undefined ? { defaultDatabase: database } : {}),
      queryTimeoutMs: 120_000,
    },
  });
}

/** The configured servers, in a fixed order. */
export function configuredServers(): TestServer[] {
  const servers: TestServer[] = [];
  for (const [engine, variable] of ENV) {
    const url = process.env[variable];
    if (url === undefined || url === '') continue;
    const adapter =
      engine === 'postgres' ? createPostgresAdapter() : createMysqlAdapter({ engine });
    servers.push({
      engine,
      url,
      connect: (database) => adapter.connect(profileFor(engine, url, database)),
    });
  }
  return servers;
}

export const dialectOf = (engine: ServerEngine): SqlDialect => engine;

/** Runs one statement to completion and returns the rows of its first result. */
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

/** Why a statement of a script failed, with enough context to reproduce it. */
export class ScriptError extends Error {
  constructor(
    readonly statement: string,
    readonly index: number,
    cause: unknown,
  ) {
    super(
      `statement ${index + 1} failed: ${cause instanceof Error ? cause.message : String(cause)}\n${statement}`,
      { cause },
    );
  }
}

/**
 * Runs statements in order and stops at the first error (spec §13: stop-on-error). A failed
 * PostgreSQL transaction is rolled back the way the app's runner does it, so the session stays
 * usable and nothing half-applied remains.
 */
export async function runStatements(
  session: Session,
  statements: readonly string[],
): Promise<void> {
  for (const [index, statement] of statements.entries()) {
    try {
      await query(session, statement);
    } catch (error) {
      if (session.inTransaction) await query(session, 'ROLLBACK').catch(() => undefined);
      throw new ScriptError(statement, index, error);
    }
  }
}

/** Splits a fixture file with the editor's splitter (DELIMITER, dollar quotes) and runs it. */
export async function runSqlFile(
  session: Session,
  text: string,
  dialect: SqlDialect,
): Promise<void> {
  await runStatements(
    session,
    splitStatements(text, dialect).map((s) => s.text),
  );
}

/** A unique, valid database name on every engine (≤ 63 characters, lower case). */
export function scratchName(label: string): string {
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .slice(0, 40);
  return `jrt_${slug}_${randomBytes(3).toString('hex')}`;
}

/** Scratch databases on one server, each with its own session; `dropAll` cleans up. */
export class ScratchDatabases {
  private readonly created: { name: string; session: Session | undefined }[] = [];

  constructor(private readonly server: TestServer) {}

  /** Creates a database and returns a session connected to it. */
  async create(label: string): Promise<Session> {
    const name = scratchName(label);
    const dialect = dialectOf(this.server.engine);
    const admin = await this.server.connect();
    try {
      await query(
        admin,
        this.server.engine === 'postgres'
          ? `CREATE DATABASE ${quoteIdent(name, dialect)}`
          : `CREATE DATABASE ${quoteIdent(name, dialect)} CHARACTER SET utf8mb4`,
      );
    } finally {
      await admin.close();
    }
    const entry: { name: string; session: Session | undefined } = { name, session: undefined };
    this.created.push(entry);
    entry.session = await this.server.connect(name);
    return entry.session;
  }

  /** Closes every session and drops every database created, ignoring individual failures. */
  async dropAll(): Promise<void> {
    const dialect = dialectOf(this.server.engine);
    for (const entry of this.created) await entry.session?.close().catch(() => undefined);
    if (this.created.length === 0) return;
    const admin = await this.server.connect();
    try {
      for (const { name } of this.created.splice(0)) {
        const sql =
          this.server.engine === 'postgres'
            ? `DROP DATABASE IF EXISTS ${quoteIdent(name, dialect)} WITH (FORCE)`
            : `DROP DATABASE IF EXISTS ${quoteIdent(name, dialect)}`;
        await query(admin, sql).catch(() => undefined);
      }
    } finally {
      await admin.close();
    }
  }
}

/** The server's default collation for a character set (MySQL family). */
export async function defaultCollation(
  session: Session,
  charset: string,
): Promise<string | undefined> {
  const rows = await query(
    session,
    `SELECT DEFAULT_COLLATE_NAME FROM information_schema.CHARACTER_SETS WHERE CHARACTER_SET_NAME = ${quoteString(charset, 'mysql')}`,
  );
  const value = rows[0]?.[0];
  return typeof value === 'string' ? value : undefined;
}

/** Collation names the server knows (MySQL family). */
export async function knownCollations(session: Session): Promise<Set<string>> {
  const rows = await query(session, 'SELECT COLLATION_NAME FROM information_schema.COLLATIONS');
  const names = new Set<string>();
  for (const row of rows) if (typeof row[0] === 'string') names.add(row[0].toLowerCase());
  // MariaDB 10.10+ lists UCA 14.0 collations without a character set ("uca1400_ai_ci") but
  // accepts them with any Unicode one ("utf8mb4_uca1400_ai_ci").
  for (const name of [...names]) {
    if (name.startsWith('uca1400_')) {
      for (const charset of ['utf8mb3', 'utf8mb4', 'ucs2', 'utf16', 'utf32'])
        names.add(`${charset}_${name}`);
    }
  }
  return names;
}

/** "10.11.14-MariaDB-0ubuntu0.24.04.1" → [10, 11, 14]. */
export function versionOf(banner: string): readonly [number, number, number] {
  const match = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(banner);
  return [Number(match?.[1] ?? 0), Number(match?.[2] ?? 0), Number(match?.[3] ?? 0)];
}

/** True when `version` ≥ `minimum`. */
export function atLeast(
  version: readonly [number, number, number],
  minimum: readonly [number, number, number],
): boolean {
  for (let i = 0; i < 3; i++) {
    if (version[i]! !== minimum[i]!) return version[i]! > minimum[i]!;
  }
  return true;
}
