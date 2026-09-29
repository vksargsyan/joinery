import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { SchemaSnapshot, Session } from '@joinery/core';
import { quoteString } from '@joinery/sql-tools';
import { expect } from 'vitest';

import { compareSchemas, generateScript, setAllSelected } from '../../src';
import type { CompareOptions, GeneratedScript, SchemaDiff } from '../../src';
import {
  atLeast,
  defaultCollation,
  dialectOf,
  knownCollations,
  query,
  runSqlFile,
  runStatements,
  ScratchDatabases,
  versionOf,
} from './helpers';
import type { TestServer } from './helpers';

/**
 * The structure round trip (spec §13 step 8, §20) for one case on one server: build the source
 * and target databases from SQL, introspect both through the driver, select every operation
 * (destructive ones included), deploy the generated script through the driver, re-introspect
 * the target and require zero differences, in both directions.
 */

export interface RoundTripCase {
  readonly name: string;
  readonly family: 'postgres' | 'mysql';
  readonly sourceSql: string;
  readonly targetSql: string;
  readonly options: CompareOptions;
}

/**
 * Cases of a fixture directory: every sub-directory with source.sql and target.sql. The engine
 * family comes from source.json when there is one (golden cases), else from the `pg-` prefix.
 */
export function loadCases(root: string): RoundTripCase[] {
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => existsSync(join(root, name, 'source.sql')))
    .filter((name) => existsSync(join(root, name, 'target.sql')))
    .sort()
    .map((name) => {
      const read = (file: string): string => readFileSync(join(root, name, file), 'utf8');
      const engine = existsSync(join(root, name, 'source.json'))
        ? (JSON.parse(read('source.json')) as { engine: string }).engine
        : name.startsWith('pg-')
          ? 'postgres'
          : 'mysql';
      return {
        name,
        family: engine === 'postgres' ? 'postgres' : 'mysql',
        sourceSql: read('source.sql'),
        targetSql: read('target.sql'),
        // The same per-case options as golden.test.ts.
        options: existsSync(join(root, name, 'options.json'))
          ? (JSON.parse(read('options.json')) as CompareOptions)
          : {},
      } satisfies RoundTripCase;
    });
}

type Version = readonly [number, number, number];

/** Server features some fixtures need, with the reason a server without them skips the case. */
type Feature = 'sequences' | 'ignored-indexes' | 'uuid-type' | 'column-checks';

const FEATURES: Readonly<
  Record<Feature, { readonly why: string; has(engine: string, version: Version): boolean }>
> = {
  sequences: {
    why: 'CREATE SEQUENCE and DEFAULT nextval() are MariaDB-only (10.3+)',
    has: (engine, version) => engine === 'mariadb' && atLeast(version, [10, 3, 0]),
  },
  'ignored-indexes': {
    why: 'IGNORED indexes are MariaDB-only (10.6+)',
    has: (engine, version) => engine === 'mariadb' && atLeast(version, [10, 6, 0]),
  },
  'uuid-type': {
    why: 'the UUID column type is MariaDB-only (10.7+)',
    has: (engine, version) => engine === 'mariadb' && atLeast(version, [10, 7, 0]),
  },
  'column-checks': {
    why: 'column-level CHECK constraints named after their column (and the JSON alias json_valid check) are MariaDB behaviour; MySQL makes every check a table constraint',
    has: (engine) => engine === 'mariadb',
  },
};

/** MySQL-family fixtures written for features only one of the servers has. */
const NEEDS: Readonly<Record<string, readonly Feature[]>> = {
  'my-mariadb-basic': ['sequences', 'ignored-indexes'],
  'my-mariadb-column-checks': ['column-checks'],
  'my-mariadb-sequences': ['sequences'],
  'my-mariadb-to-mysql': ['sequences', 'uuid-type'],
};

/** What a case needs to know about the server it runs on. */
export interface ServerInfo {
  readonly server: TestServer;
  readonly version: Version;
  readonly banner: string;
  /** PostgreSQL: installable extensions. */
  readonly extensions: ReadonlySet<string>;
  /** MySQL family: collations the server knows, and each charset's default collation. */
  readonly collations: ReadonlySet<string>;
  readonly charsetDefaults: ReadonlyMap<string, string>;
}

export async function describeServer(server: TestServer): Promise<ServerInfo> {
  const session = await server.connect();
  try {
    const banner = session.serverVersion;
    const base = { server, banner, version: versionOf(banner) };
    if (server.engine === 'postgres') {
      const rows = await query(session, 'SELECT name FROM pg_catalog.pg_available_extensions');
      return {
        ...base,
        extensions: new Set(rows.map((r) => String(r[0]))),
        collations: new Set(),
        charsetDefaults: new Map(),
      };
    }
    const charsetDefaults = new Map<string, string>();
    for (const charset of ['utf8mb4', 'utf8mb3', 'latin1']) {
      const collation = await defaultCollation(session, charset);
      if (collation !== undefined) charsetDefaults.set(charset, collation);
    }
    return {
      ...base,
      extensions: new Set(),
      collations: await knownCollations(session),
      charsetDefaults,
    };
  } finally {
    await session.close();
  }
}

/** Why the server cannot run the case, or undefined when it can. */
export function skipReason(testCase: RoundTripCase, info: ServerInfo): string | undefined {
  if (info.server.engine === 'postgres') {
    const wanted = [...testCase.sourceSql.matchAll(/create extension if not exists (\w+)/gi)].map(
      (m) => m[1]!.toLowerCase(),
    );
    const missing = wanted.filter((name) => !info.extensions.has(name));
    return missing.length > 0
      ? `extension ${missing.join(', ')} is not available on this server (contrib not installed)`
      : undefined;
  }
  const lacking = (NEEDS[testCase.name] ?? []).filter(
    (feature) => !FEATURES[feature].has(info.server.engine, info.version),
  );
  return lacking.length > 0 ? lacking.map((f) => FEATURES[f].why).join('; ') : undefined;
}

/**
 * MySQL 8's default collation (utf8mb4_0900_ai_ci) and MariaDB 11's (utf8mb4_uca1400_ai_ci) do
 * not exist on every server of the family, and no fixture is about the collation itself. A
 * collation the server lacks is replaced with its character set's default on that server,
 * everywhere in the fixture, so both sides stay consistent.
 */
export function adaptCollations(sql: string, info: ServerInfo): string {
  return sql.replace(/\b(utf8mb4|utf8mb3|utf8|latin1)_[a-z0-9_]+\b/gi, (name, charset: string) => {
    if (info.collations.has(name.toLowerCase())) return name;
    return info.charsetDefaults.get(charset.toLowerCase()) ?? name;
  });
}

/** A readable list of a diff's operations, for failure messages. */
export function describeOperations(diff: SchemaDiff): string {
  return diff.operations
    .map((op) => {
      const lines = [`- ${op.id}`, ...op.changes.map((c) => `    ${c}`)];
      if (op.sourceDdl !== undefined) lines.push(`    source: ${op.sourceDdl.replace(/\n/g, ' ')}`);
      if (op.targetDdl !== undefined) lines.push(`    target: ${op.targetDdl.replace(/\n/g, ' ')}`);
      return lines.join('\n');
    })
    .join('\n');
}

function expectIdentical(
  a: SchemaSnapshot,
  b: SchemaSnapshot,
  options: CompareOptions,
  context: string,
): void {
  const { diff } = compareSchemas(a, b, options);
  expect(diff.operations, `${context}:\n${describeOperations(diff)}`).toEqual([]);
}

/** Roles a PostgreSQL fixture creates: cluster-wide, so they are dropped again afterwards. */
async function dropRoles(server: TestServer, sql: string): Promise<void> {
  const roles = [...sql.matchAll(/create role (\w+)/gi)].map((m) => m[1]!);
  if (roles.length === 0) return;
  const admin = await server.connect();
  try {
    for (const role of roles) {
      // Another database of the cluster may still use the role; then it stays.
      await query(
        admin,
        `DO $$ BEGIN IF EXISTS (SELECT FROM pg_roles WHERE rolname = ${quoteString(role, 'postgres')}) THEN DROP ROLE ${role}; END IF; END $$`,
      ).catch(() => undefined);
    }
  } finally {
    await admin.close();
  }
}

/** Runs a generated script on the target, reporting the script with any failure. */
async function deploy(session: Session, script: GeneratedScript): Promise<void> {
  try {
    await runStatements(session, script.statements);
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}\n--- script ---\n${script.text}`,
      { cause: error },
    );
  }
}

/** Compares, selects every operation, deploys, and requires a clean re-compare both ways. */
async function syncFully(
  source: SchemaSnapshot,
  session: Session,
  options: CompareOptions,
  context: string,
): Promise<void> {
  const { diff } = compareSchemas(source, await session.introspect(), options);
  const script = generateScript(setAllSelected(diff, true));
  expect(script.missingDependencies).toEqual([]);
  await deploy(session, script);
  const deployed = await session.introspect();
  const after = compareSchemas(source, deployed, options).diff;
  expect(
    after.operations,
    `${context}: re-compare after deploy is not empty:\n${describeOperations(after)}\n--- script ---\n${script.text}`,
  ).toEqual([]);
  expectIdentical(deployed, source, options, `${context}: diff(deployed target, source)`);
  expectIdentical(deployed, deployed, options, `${context}: diff(deployed, deployed)`);
}

/**
 * The round trip for one case on one server:
 *
 * 1. both fixture databases compare equal to themselves;
 * 2. every operation selected (destructive ones included): deploy, then source and target
 *    compare equal both ways;
 * 3. on a second copy of the target, the default selection (destructive operations unticked)
 *    deploys without error, and a full sync from that intermediate state still converges.
 */
export async function roundTrip(testCase: RoundTripCase, info: ServerInfo): Promise<void> {
  const { server } = info;
  const dialect = dialectOf(server.engine);
  const scratch = new ScratchDatabases(server);
  const prepare = (sql: string): string =>
    server.engine === 'postgres' ? sql : adaptCollations(sql, info);
  try {
    const sourceSession = await scratch.create(`${testCase.name}_src`);
    const targetSession = await scratch.create(`${testCase.name}_tgt`);
    const partialSession = await scratch.create(`${testCase.name}_part`);
    await runSqlFile(sourceSession, prepare(testCase.sourceSql), dialect);
    for (const session of [targetSession, partialSession])
      await runSqlFile(session, prepare(testCase.targetSql), dialect);

    const source = await sourceSession.introspect();
    const target = await targetSession.introspect();
    expectIdentical(source, source, testCase.options, 'diff(source, source)');
    expectIdentical(target, target, testCase.options, 'diff(target, target)');
    const { diff } = compareSchemas(source, target, testCase.options);
    // Not vacuous: the databases differ, under the case's options or (when those ignore the
    // difference, as ignoreNames does) under the defaults.
    const differences =
      diff.operations.length || compareSchemas(source, target).diff.operations.length;
    expect(differences, 'source and target differ').toBeGreaterThan(0);

    await syncFully(source, targetSession, testCase.options, 'full selection');

    await deploy(partialSession, generateScript(diff));
    await syncFully(source, partialSession, testCase.options, 'after the default selection');
  } finally {
    await scratch.dropAll();
    if (server.engine === 'postgres') await dropRoles(server, testCase.targetSql);
  }
}
