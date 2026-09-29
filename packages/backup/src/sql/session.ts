import { JoineryError, type Session, type SqlDialect, type TableDef } from '@joinery/core';
import { quoteIdent, quoteQualified } from '@joinery/sql-tools';

import { drain, queryRows, text } from '../util';

/**
 * Session settings and consistent snapshots for SQL backups and restores (spec §14).
 *
 * A backup reads everything in one snapshot: PostgreSQL runs a REPEATABLE READ, READ ONLY
 * transaction (SERIALIZABLE, READ ONLY, DEFERRABLE when asked and the server is a primary, which
 * waits for a snapshot no serialisable transaction can invalidate), takes ACCESS SHARE locks on
 * the tables so nobody drops or rewrites them mid-backup, and reads the catalog in the same
 * snapshot. MySQL and MariaDB use START TRANSACTION WITH CONSISTENT SNAPSHOT, which is only
 * consistent for InnoDB (and other transactional) tables; the others get a warning.
 *
 * Values are read in a form that restores exactly: ISO dates, full float precision, UTC for
 * MySQL TIMESTAMP columns. The profile's query timeout does not apply to backups and restores.
 */

export function dialectOf(session: Session): SqlDialect {
  const engine = session.engine;
  if (engine === 'postgres' || engine === 'mysql' || engine === 'mariadb') return engine;
  throw new JoineryError({
    code: 'NOT_SUPPORTED',
    message: `${engine} is not a SQL engine`,
  });
}

export function isMariaDb(session: Session): boolean {
  return session.engine === 'mariadb' || /mariadb/i.test(session.serverVersion);
}

/** Settings for reading (backup) or writing (restore) with this app's value formats. */
export async function prepareSession(
  session: Session,
  purpose: 'backup' | 'restore',
  signal?: AbortSignal,
): Promise<void> {
  const dialect = dialectOf(session);
  const statements: string[] = [];
  if (dialect === 'postgres') {
    statements.push(
      'SET statement_timeout = 0',
      'SET idle_in_transaction_session_timeout = 0',
      "SET client_encoding = 'UTF8'",
      'SET standard_conforming_strings = on',
      'SET extra_float_digits = 3',
      "SET DateStyle = 'ISO, YMD'",
      "SET IntervalStyle = 'postgres'",
    );
    if (purpose === 'restore') {
      statements.push(
        'SET check_function_bodies = false',
        'SET client_min_messages = warning',
        "SELECT pg_catalog.set_config('search_path', '', false)",
      );
    }
  } else {
    statements.push(
      isMariaDb(session)
        ? 'SET SESSION max_statement_time = 0'
        : 'SET SESSION max_execution_time = 0',
      "SET time_zone = '+00:00'",
    );
    if (purpose === 'restore') {
      statements.push(
        'SET foreign_key_checks = 0',
        'SET unique_checks = 0',
        "SET sql_mode = 'NO_AUTO_VALUE_ON_ZERO'",
        'SET sql_notes = 0',
      );
    }
  }
  for (const sql of statements) await drain(session, sql, signal);
}

export type SnapshotMode =
  'repeatable-read' | 'serializable-deferrable' | 'consistent-snapshot' | 'none';

export interface SnapshotOptions {
  /** Read everything in one snapshot (default true). */
  readonly consistent?: boolean;
  /** PostgreSQL: SERIALIZABLE, READ ONLY, DEFERRABLE when the server is not a standby. */
  readonly deferrable?: boolean;
}

/** An open snapshot: `end` finishes the read-only transaction. */
export interface SnapshotHandle {
  readonly mode: SnapshotMode;
  end(): Promise<void>;
}

export async function beginSnapshot(
  session: Session,
  options: SnapshotOptions,
  signal?: AbortSignal,
): Promise<SnapshotHandle> {
  if (options.consistent === false) return { mode: 'none', end: async () => undefined };
  const dialect = dialectOf(session);
  if (session.inTransaction) {
    throw new JoineryError({
      code: 'VALIDATION_FAILED',
      message: 'The session already has an open transaction',
    });
  }
  let mode: SnapshotMode;
  if (dialect === 'postgres') {
    let deferrable = options.deferrable === true;
    if (deferrable) {
      const rows = await queryRows(session, 'SELECT pg_catalog.pg_is_in_recovery()');
      if (rows[0]?.[0] === true) deferrable = false;
    }
    mode = deferrable ? 'serializable-deferrable' : 'repeatable-read';
    await drain(
      session,
      deferrable
        ? 'START TRANSACTION ISOLATION LEVEL SERIALIZABLE, READ ONLY, DEFERRABLE'
        : 'START TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY',
      signal,
    );
  } else {
    mode = 'consistent-snapshot';
    await drain(session, 'SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ', signal);
    await drain(session, 'START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY', signal);
  }
  return {
    mode,
    end: async () => {
      if (session.inTransaction) await drain(session, 'COMMIT').catch(() => undefined);
    },
  };
}

/** PostgreSQL: ACCESS SHARE locks on the tables to read, as pg_dump takes them. */
export async function lockTables(
  session: Session,
  tables: readonly { readonly schema?: string; readonly table: TableDef }[],
  signal?: AbortSignal,
): Promise<void> {
  if (dialectOf(session) !== 'postgres' || !session.inTransaction) return;
  for (let at = 0; at < tables.length; at += 200) {
    const names = tables
      .slice(at, at + 200)
      .map(({ schema, table }) => quoteQualified([schema, table.name], 'postgres'));
    if (names.length > 0) {
      await drain(session, `LOCK TABLE ${names.join(', ')} IN ACCESS SHARE MODE`, signal);
    }
  }
}

/** Storage engines that take part in MySQL transactions. */
const TRANSACTIONAL_ENGINES = new Set(['innodb', 'ndbcluster', 'ndb', 'tokudb', 'rocksdb']);

/** MySQL and MariaDB tables whose rows the consistent snapshot does not cover. */
export function nonTransactionalTables(tables: readonly TableDef[]): string[] {
  return tables
    .filter((t) => {
      const engine = t.options['engine']?.toLowerCase();
      return engine !== undefined && !TRANSACTIONAL_ENGINES.has(engine);
    })
    .map((t) => `${t.name} (${t.options['engine']})`);
}

/** The database the session works in (MySQL DATABASE(), PostgreSQL current_database()). */
export async function currentDatabase(session: Session): Promise<string> {
  const dialect = dialectOf(session);
  const rows = await queryRows(
    session,
    dialect === 'postgres' ? 'SELECT current_database()' : 'SELECT DATABASE()',
  );
  const name = text(rows[0]?.[0]);
  if (name === undefined) {
    throw new JoineryError({
      code: 'VALIDATION_FAILED',
      message: 'No database is selected',
      hint: 'Choose the database to back up or restore into',
    });
  }
  return name;
}

/**
 * Creates the database a restore goes into ("restore into a new database"): refuses one that
 * exists. MySQL and MariaDB get the source's character set and collation when the backup names
 * them (and the server knows them), utf8mb4 otherwise.
 */
export async function createDatabase(
  session: Session,
  name: string,
  options: Readonly<Record<string, string>> = {},
): Promise<void> {
  const dialect = dialectOf(session);
  const pg = dialect === 'postgres';
  const exists = await queryRows(
    session,
    pg
      ? 'SELECT 1 FROM pg_catalog.pg_database WHERE datname = $1'
      : 'SELECT 1 FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?',
    [name],
  );
  if (exists.length > 0) {
    throw new JoineryError({
      code: 'VALIDATION_FAILED',
      message: `The database "${name}" exists already`,
      hint: 'Restore into it without creating it, or choose a new name',
    });
  }
  const ident = quoteIdent(name, dialect);
  if (pg) {
    await drain(session, `CREATE DATABASE ${ident}`);
    return;
  }
  const word = /^[A-Za-z0-9_]+$/;
  const charset = options['charset'] !== undefined && word.test(options['charset']) ? options['charset'] : 'utf8mb4';
  const known = async (sql: string, value: string): Promise<boolean> =>
    (await queryRows(session, sql, [value])).length > 0;
  const collation = options['collation'];
  const useCollation =
    collation !== undefined &&
    word.test(collation) &&
    collation.startsWith(`${charset}_`) &&
    (await known('SELECT 1 FROM information_schema.COLLATIONS WHERE COLLATION_NAME = ?', collation));
  await drain(
    session,
    `CREATE DATABASE ${ident} CHARACTER SET ${charset}${useCollation ? ` COLLATE ${collation}` : ''}`,
  );
}
