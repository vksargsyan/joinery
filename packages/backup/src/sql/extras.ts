import type { CellValue, Session, SqlDialect } from '@joinery/core';
import { quoteIdent, quoteQualified, quoteString } from '@joinery/sql-tools';

import { queryRows, text } from '../util';
import { literal } from './data';
import type { SqlObject } from './objects';
import { isMariaDb } from './session';

/**
 * What a backup reads besides the snapshot's DDL, all inside the same snapshot:
 *
 * - sequence positions (PostgreSQL sequences and identity columns, MariaDB sequences), restored
 *   after the rows so new rows continue where the source left off;
 * - PostgreSQL materialised views that were populated, refreshed after the rows;
 * - the sql_mode each MySQL/MariaDB routine, trigger and event was created under (it changes
 *   how their bodies behave), set around their CREATE statements;
 * - privileges on the backed-up objects, when asked for.
 *
 * Each lands on the object it belongs to, so a selective restore brings exactly its own.
 */

/** Statements added to objects, keyed by object id. */
export interface ObjectExtras {
  /** After the rows (sequence positions, refreshes). */
  readonly data: Map<string, string[]>;
  /** Privileges; a failure is a warning, since the roles may not exist where it is restored. */
  readonly grants: Map<string, string[]>;
  /** Objects that only hold privileges (a database or a schema without its own object). */
  readonly extraObjects: SqlObject[];
}

function push(map: Map<string, string[]>, id: string, ...statements: string[]): void {
  map.set(id, [...(map.get(id) ?? []), ...statements]);
}

/** PostgreSQL: SELECT last_value, is_called for a sequence named by schema and name. */
async function pgSequenceState(
  session: Session,
  schema: string,
  name: string,
): Promise<{ value: string; called: boolean } | undefined> {
  const rows = await queryRows(
    session,
    `SELECT last_value::text, is_called FROM ${quoteQualified([schema, name], 'postgres')}`,
  );
  const value = text(rows[0]?.[0]);
  if (value === undefined) return undefined;
  return { value, called: rows[0]?.[1] === true };
}

export async function collectExtras(
  session: Session,
  dialect: SqlDialect,
  objects: SqlObject[],
  options: {
    readonly data: boolean;
    readonly grants: boolean;
    readonly schemas: readonly string[];
  },
): Promise<ObjectExtras> {
  const extras: ObjectExtras = { data: new Map(), grants: new Map(), extraObjects: [] };
  if (dialect === 'postgres') {
    if (options.data) await pgDataExtras(session, objects, options.schemas, extras);
    if (options.grants) await pgGrants(session, objects, options.schemas, extras);
  } else {
    await mysqlSqlModes(session, objects);
    if (options.data && isMariaDb(session)) await mariadbSequences(session, objects, extras);
    if (options.grants) await mysqlGrants(session, objects, extras);
  }
  return extras;
}

async function pgDataExtras(
  session: Session,
  objects: readonly SqlObject[],
  schemas: readonly string[],
  extras: ObjectExtras,
): Promise<void> {
  for (const object of objects) {
    if (object.kind === 'sequence' && object.schema !== undefined) {
      const state = await pgSequenceState(session, object.schema, object.name);
      if (state === undefined) continue;
      const name = quoteString(
        quoteQualified([object.schema, object.name], 'postgres'),
        'postgres',
      );
      push(
        extras.data,
        object.id,
        `SELECT pg_catalog.setval(${name}, ${state.value}, ${state.called ? 'true' : 'false'})`,
      );
    }
    if (object.kind === 'table' && object.table && object.schema !== undefined) {
      const tableName = quoteQualified([object.schema, object.table.name], 'postgres');
      for (const column of object.table.columns) {
        if (column.identity === undefined) continue;
        const rows = await queryRows(
          session,
          `SELECT n.nspname, c.relname FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE c.oid = pg_catalog.pg_get_serial_sequence($1, $2)::regclass`,
          [tableName, column.name],
        );
        const schema = text(rows[0]?.[0]);
        const sequence = text(rows[0]?.[1]);
        if (schema === undefined || sequence === undefined) continue;
        const state = await pgSequenceState(session, schema, sequence);
        if (state === undefined) continue;
        push(
          extras.data,
          object.id,
          `SELECT pg_catalog.setval(pg_catalog.pg_get_serial_sequence(${quoteString(tableName, 'postgres')}, ${quoteString(column.name, 'postgres')}), ${state.value}, ${state.called ? 'true' : 'false'})`,
        );
      }
    }
  }
  if (schemas.length === 0) return;
  const views = await queryRows(
    session,
    'SELECT schemaname, matviewname FROM pg_catalog.pg_matviews WHERE ispopulated AND schemaname = ANY($1)',
    [pgTextArray(schemas)],
  );
  for (const row of views) {
    const schema = text(row[0]);
    const name = text(row[1]);
    const object = objects.find(
      (o) => o.kind === 'materialized-view' && o.schema === schema && o.name === name,
    );
    if (!object || schema === undefined || name === undefined) continue;
    push(
      extras.data,
      object.id,
      `REFRESH MATERIALIZED VIEW ${quoteQualified([schema, name], 'postgres')}`,
    );
  }
}

/** A PostgreSQL array literal of text values, for `= ANY($1)`. */
function pgTextArray(values: readonly string[]): string {
  return `{${values.map((v) => `"${v.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`).join(',')}}`;
}

function pgRole(name: string): string {
  return name === 'PUBLIC' ? 'PUBLIC' : quoteIdent(name, 'postgres');
}

async function pgGrants(
  session: Session,
  objects: SqlObject[],
  schemas: readonly string[],
  extras: ObjectExtras,
): Promise<void> {
  if (schemas.length === 0) return;
  const list = pgTextArray(schemas);
  const grantee = `CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee) END`;
  const find = (kinds: readonly string[], schema: string | undefined, name: string | undefined) =>
    objects.find((o) => kinds.includes(o.kind) && o.schema === schema && o.name === name);
  const withOption = (grantable: unknown): string =>
    grantable === true ? ' WITH GRANT OPTION' : '';

  const relations = await queryRows(
    session,
    `SELECT n.nspname, c.relname, c.relkind::text, ${grantee}, a.privilege_type, a.is_grantable
       FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace,
            LATERAL pg_catalog.aclexplode(c.relacl) a
      WHERE n.nspname = ANY($1) AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
        AND a.grantee <> c.relowner
      ORDER BY 1, 2, 4, 5`,
    [list],
  );
  for (const [schema, name, relkind, role, privilege, grantable] of relations) {
    const object = find(
      ['table', 'view', 'materialized-view', 'sequence'],
      text(schema),
      text(name),
    );
    if (!object || text(role) === undefined) continue;
    const target = `${relkind === 'S' ? 'SEQUENCE' : 'TABLE'} ${quoteQualified([text(schema), text(name)], 'postgres')}`;
    push(
      extras.grants,
      object.id,
      `GRANT ${text(privilege)} ON ${target} TO ${pgRole(text(role)!)}${withOption(grantable)}`,
    );
  }

  const columns = await queryRows(
    session,
    `SELECT n.nspname, c.relname, att.attname, ${grantee}, a.privilege_type, a.is_grantable
       FROM pg_catalog.pg_attribute att
       JOIN pg_catalog.pg_class c ON c.oid = att.attrelid
       JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace,
            LATERAL pg_catalog.aclexplode(att.attacl) a
      WHERE n.nspname = ANY($1) AND att.attnum > 0 AND NOT att.attisdropped
        AND a.grantee <> c.relowner
      ORDER BY 1, 2, 3, 4, 5`,
    [list],
  );
  for (const [schema, table, column, role, privilege, grantable] of columns) {
    const object = find(['table', 'view', 'materialized-view'], text(schema), text(table));
    if (!object || text(role) === undefined) continue;
    push(
      extras.grants,
      object.id,
      `GRANT ${text(privilege)} (${quoteIdent(text(column)!, 'postgres')}) ON TABLE ${quoteQualified([text(schema), text(table)], 'postgres')} TO ${pgRole(text(role)!)}${withOption(grantable)}`,
    );
  }

  const routines = await queryRows(
    session,
    `SELECT n.nspname, p.proname, pg_catalog.pg_get_function_identity_arguments(p.oid), ${grantee}, a.privilege_type, a.is_grantable
       FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace,
            LATERAL pg_catalog.aclexplode(p.proacl) a
      WHERE n.nspname = ANY($1) AND a.grantee <> p.proowner
      ORDER BY 1, 2, 3, 4`,
    [list],
  );
  for (const [schema, name, args, role, privilege, grantable] of routines) {
    const signature = text(args) ?? '';
    const object = objects.find(
      (o) =>
        o.kind === 'routine' &&
        o.schema === text(schema) &&
        o.name === text(name) &&
        o.qualifiedName.endsWith(`(${signature})`),
    );
    if (!object || text(role) === undefined) continue;
    push(
      extras.grants,
      object.id,
      `GRANT ${text(privilege)} ON ROUTINE ${quoteQualified([text(schema), text(name)], 'postgres')}(${signature}) TO ${pgRole(text(role)!)}${withOption(grantable)}`,
    );
  }

  const namespaces = await queryRows(
    session,
    `SELECT n.nspname, ${grantee}, a.privilege_type, a.is_grantable
       FROM pg_catalog.pg_namespace n, LATERAL pg_catalog.aclexplode(n.nspacl) a
      WHERE n.nspname = ANY($1) AND a.grantee <> n.nspowner
      ORDER BY 1, 2, 3`,
    [list],
  );
  for (const [schema, role, privilege, grantable] of namespaces) {
    const name = text(schema);
    if (name === undefined || text(role) === undefined) continue;
    const statement = `GRANT ${text(privilege)} ON SCHEMA ${quoteIdent(name, 'postgres')} TO ${pgRole(text(role)!)}${withOption(grantable)}`;
    let object = objects.find((o) => o.kind === 'schema' && o.name === name);
    if (!object) {
      object = extras.extraObjects.find((o) => o.name === name);
      if (!object) {
        object = grantsObject(`grants:schema:${name}`, name, `Privileges on schema ${name}`);
        extras.extraObjects.push(object);
      }
    }
    push(extras.grants, object.id, statement);
  }
}

function grantsObject(id: string, name: string, label: string): SqlObject {
  return { id, kind: 'grants', name, qualifiedName: label, dependsOn: [], pre: [], post: [] };
}

/** MySQL GRANTEE text `'user'@'host'` as a safely quoted account. */
function mysqlAccount(grantee: string): string | undefined {
  const match = /^'((?:[^']|'')*)'@'((?:[^']|'')*)'$/.exec(grantee);
  if (!match) return undefined;
  const unquote = (s: string): string => s.replaceAll("''", "'");
  return `${quoteString(unquote(match[1]!), 'mysql')}@${quoteString(unquote(match[2]!), 'mysql')}`;
}

async function mysqlGrants(
  session: Session,
  objects: SqlObject[],
  extras: ObjectExtras,
): Promise<void> {
  const byTable = (name: string | undefined) =>
    objects.find((o) => (o.kind === 'table' || o.kind === 'view') && o.name === name);
  const option = (grantable: CellValue | undefined): string =>
    text(grantable) === 'YES' ? ' WITH GRANT OPTION' : '';
  const tables = await queryRows(
    session,
    `SELECT GRANTEE, TABLE_NAME, PRIVILEGE_TYPE, IS_GRANTABLE FROM information_schema.TABLE_PRIVILEGES WHERE TABLE_SCHEMA = DATABASE() ORDER BY 2, 1, 3`,
  );
  for (const [grantee, table, privilege, grantable] of tables) {
    const account = mysqlAccount(text(grantee) ?? '');
    const object = byTable(text(table));
    if (!account || !object) continue;
    push(
      extras.grants,
      object.id,
      `GRANT ${text(privilege)} ON ${quoteIdent(object.name, 'mysql')} TO ${account}${option(grantable)}`,
    );
  }
  const columns = await queryRows(
    session,
    `SELECT GRANTEE, TABLE_NAME, COLUMN_NAME, PRIVILEGE_TYPE, IS_GRANTABLE FROM information_schema.COLUMN_PRIVILEGES WHERE TABLE_SCHEMA = DATABASE() ORDER BY 2, 1, 3, 4`,
  );
  for (const [grantee, table, column, privilege, grantable] of columns) {
    const account = mysqlAccount(text(grantee) ?? '');
    const object = byTable(text(table));
    if (!account || !object || text(column) === undefined) continue;
    push(
      extras.grants,
      object.id,
      `GRANT ${text(privilege)} (${quoteIdent(text(column)!, 'mysql')}) ON ${quoteIdent(object.name, 'mysql')} TO ${account}${option(grantable)}`,
    );
  }
  const schema = await queryRows(
    session,
    `SELECT GRANTEE, PRIVILEGE_TYPE, IS_GRANTABLE FROM information_schema.SCHEMA_PRIVILEGES WHERE TABLE_SCHEMA = DATABASE() ORDER BY 1, 2`,
  );
  const statements: string[] = [];
  for (const [grantee, privilege, grantable] of schema) {
    const account = mysqlAccount(text(grantee) ?? '');
    if (!account) continue;
    // `ON *` is the current database, so the grants follow a restore into another name.
    statements.push(`GRANT ${text(privilege)} ON * TO ${account}${option(grantable)}`);
  }
  if (statements.length > 0) {
    const object = grantsObject('grants:database', 'database', 'Privileges on the database');
    extras.extraObjects.push(object);
    extras.grants.set(object.id, statements);
  }
}

/** Wraps routine, trigger and event DDL in the sql_mode each was created under. */
async function mysqlSqlModes(session: Session, objects: SqlObject[]): Promise<void> {
  const modes = new Map<string, string>();
  const read = async (sql: string, kind: string): Promise<void> => {
    for (const [name, mode] of await queryRows(session, sql)) {
      const n = text(name);
      const m = text(mode);
      if (n !== undefined && m !== undefined) modes.set(`${kind}:${n}`, m);
    }
  };
  await read(
    'SELECT ROUTINE_NAME, SQL_MODE FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = DATABASE()',
    'routine',
  );
  await read(
    'SELECT TRIGGER_NAME, SQL_MODE FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = DATABASE()',
    'trigger',
  );
  await read(
    'SELECT EVENT_NAME, SQL_MODE FROM information_schema.EVENTS WHERE EVENT_SCHEMA = DATABASE()',
    'event',
  );
  for (const object of objects) {
    const mode = modes.get(`${object.kind}:${object.name}`);
    if (mode === undefined) continue;
    const list = object.pre.length > 0 ? object.pre : object.post;
    const wrapped = [
      `SET SESSION sql_mode = ${quoteString(mode, 'mysql')}`,
      ...list,
      "SET SESSION sql_mode = 'NO_AUTO_VALUE_ON_ZERO'",
    ];
    list.splice(0, list.length, ...wrapped);
  }
}

async function mariadbSequences(
  session: Session,
  objects: readonly SqlObject[],
  extras: ObjectExtras,
): Promise<void> {
  for (const object of objects) {
    if (object.kind !== 'sequence') continue;
    const name = quoteIdent(object.name, 'mysql');
    const rows = await queryRows(session, `SELECT next_not_cached_value FROM ${name}`);
    const next = rows[0]?.[0];
    if (next === undefined || next === null) continue;
    push(extras.data, object.id, `SELECT SETVAL(${name}, ${literal(next, 'mysql')}, 0)`);
  }
}
