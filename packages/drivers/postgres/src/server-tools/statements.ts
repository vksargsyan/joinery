import {
  JoineryError,
  MASKED_SECRET,
  type AccountOptions,
  type AccountRef,
  type DefaultPrivilegeType,
  type GrantObjectKind,
  type MaintenanceTargetRef,
  type PolicyCommand,
  type ServerAction,
} from '@joinery/core';
import { quoteIdent, quoteQualified, quoteString, tokenize } from '@joinery/sql-tools';

import { statement, type ToolStatement } from './runner';

/**
 * The statements the PostgreSQL server tools run, built from an action with every name
 * quoted and every value a literal. Pure: the preview shows exactly what `run` sends.
 */

const q = (name: string): string => quoteIdent(name, 'postgres');
const lit = (value: string): string => quoteString(value, 'postgres');

function invalid(message: string): JoineryError {
  return new JoineryError({ code: 'VALIDATION_FAILED', message });
}

/** Role, schema and object names: 1 to 63 bytes (PostgreSQL would silently truncate longer). */
export function checkName(name: string, what: string): string {
  const bytes = new TextEncoder().encode(name).length;
  if (bytes === 0) throw invalid(`The ${what} name is empty`);
  if (bytes > 63) throw invalid(`The ${what} name "${name}" is longer than 63 bytes`);
  if (name.includes('\0')) throw invalid(`The ${what} name contains a NUL character`);
  return name;
}

/** A role as a grantee: PUBLIC (any case) is the keyword, anything else a quoted name. */
export function granteeSql(name: string): string {
  return name.toLowerCase() === 'public' ? 'PUBLIC' : q(checkName(name, 'role'));
}

function roleName(account: AccountRef): string {
  if (account.host !== undefined) throw invalid('PostgreSQL roles have no host');
  return q(checkName(account.name, 'role'));
}

// ------------------------------------------------------------------------------- sessions

export function pidOf(id: string): number {
  if (!/^\d{1,10}$/.test(id)) throw invalid(`"${id}" is not a backend process id`);
  return Number(id);
}

export function sessionStatement(operation: 'cancel' | 'terminate', id: string): ToolStatement {
  const fn = operation === 'cancel' ? 'pg_cancel_backend' : 'pg_terminate_backend';
  return statement(`SELECT pg_catalog.${fn}(${pidOf(id)})`);
}

// ---------------------------------------------------------------------------- maintenance

export const MAINTENANCE_OPTIONS: Readonly<Record<string, readonly string[]>> = {
  vacuum: ['full', 'freeze', 'analyze', 'verbose', 'skip_locked'],
  analyze: ['verbose', 'skip_locked'],
  reindex: ['concurrently', 'verbose'],
  cluster: ['verbose'],
};

function checkOptions(operation: string, options: readonly string[]): Set<string> {
  const allowed = MAINTENANCE_OPTIONS[operation] ?? [];
  for (const option of options) {
    if (!allowed.includes(option)) {
      throw invalid(`${operation.toUpperCase()} has no option "${option}"`);
    }
  }
  return new Set(options);
}

function tableSql(target: MaintenanceTargetRef): string {
  return quoteQualified(
    [checkName(target.container, 'schema'), checkName(target.name, 'table')],
    'postgres',
  );
}

/**
 * VACUUM and ANALYZE take every target in one statement; REINDEX and CLUSTER one each.
 * `serverVersionNum` picks the option syntax (CLUSTER (VERBOSE) needs 14).
 */
export function maintenanceStatements(
  action: Extract<ServerAction, { kind: 'maintenance' }>,
  serverVersionNum: number,
): ToolStatement[] {
  const { operation, targets } = action;
  if (targets.length === 0) throw invalid('Pick at least one table');
  const options = checkOptions(operation, action.options);
  const list = (names: readonly string[]): string =>
    names.length > 0 ? ` (${names.map((n) => n.toUpperCase()).join(', ')})` : '';
  switch (operation) {
    case 'vacuum': {
      const names = ['full', 'freeze', 'verbose', 'analyze', 'skip_locked'].filter((o) =>
        options.has(o),
      );
      return [statement(`VACUUM${list(names)} ${targets.map(tableSql).join(', ')}`)];
    }
    case 'analyze': {
      const names = ['verbose', 'skip_locked'].filter((o) => options.has(o));
      return [statement(`ANALYZE${list(names)} ${targets.map(tableSql).join(', ')}`)];
    }
    case 'reindex': {
      const verbose = options.has('verbose');
      return targets.map((target) =>
        statement(
          `REINDEX${verbose ? ' (VERBOSE)' : ''} TABLE${options.has('concurrently') ? ' CONCURRENTLY' : ''} ${tableSql(target)}`,
        ),
      );
    }
    case 'cluster': {
      if (targets.length > 1 && action.index !== undefined) {
        throw invalid('CLUSTER ... USING takes one table');
      }
      const verbose = options.has('verbose')
        ? serverVersionNum >= 140000
          ? ' (VERBOSE)'
          : ' VERBOSE'
        : '';
      return targets.map((target) =>
        statement(
          `CLUSTER${verbose} ${tableSql(target)}${
            action.index !== undefined ? ` USING ${q(checkName(action.index, 'index'))}` : ''
          }`,
        ),
      );
    }
    default:
      throw new JoineryError({
        code: 'NOT_SUPPORTED',
        message: `${operation.toUpperCase()} is not a PostgreSQL maintenance command`,
      });
  }
}

// ------------------------------------------------------------------------------- settings

const SETTING_NAME = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_$]*)*$/;

/** Settings whose value is a list of separately quoted names (GUC_LIST_QUOTE). */
const QUOTED_LISTS = new Set([
  'search_path',
  'shared_preload_libraries',
  'session_preload_libraries',
  'local_preload_libraries',
  'temp_tablespaces',
  'unix_socket_directories',
]);

export function checkSettingName(name: string): string {
  if (!SETTING_NAME.test(name) || name.length > 200) {
    throw invalid(`"${name}" is not a setting name`);
  }
  return name.toLowerCase();
}

/** A value as SQL: one literal, or a literal per element of a list setting. */
export function settingValueSql(name: string, value: string): string {
  if (!QUOTED_LISTS.has(name.toLowerCase())) return lit(value);
  const items = value
    .split(',')
    .map((item) => item.trim())
    .map((item) => (/^".*"$/.test(item) ? item.slice(1, -1).replaceAll('""', '"') : item))
    .filter((item) => item !== '');
  return items.length === 0 ? "''" : items.map(lit).join(', ');
}

export function settingStatements(
  action: Extract<ServerAction, { kind: 'setting' }>,
  database: string,
): ToolStatement[] {
  const name = checkSettingName(action.name);
  const value = action.value === null ? null : settingValueSql(name, action.value);
  switch (action.scope) {
    case 'session':
      return [statement(value === null ? `RESET ${name}` : `SET ${name} TO ${value}`)];
    case 'database': {
      const db = q(checkName(database, 'database'));
      return [
        statement(
          value === null
            ? `ALTER DATABASE ${db} RESET ${name}`
            : `ALTER DATABASE ${db} SET ${name} TO ${value}`,
        ),
      ];
    }
    case 'system':
      return [
        statement(
          value === null ? `ALTER SYSTEM RESET ${name}` : `ALTER SYSTEM SET ${name} TO ${value}`,
        ),
        statement('SELECT pg_catalog.pg_reload_conf()'),
      ];
    default:
      throw new JoineryError({
        code: 'NOT_SUPPORTED',
        message: `PostgreSQL has no "${action.scope}" setting scope`,
        hint: 'Use this session, the database or ALTER SYSTEM',
      });
  }
}

// ---------------------------------------------------------------------------- top queries

export function topQueriesStatement(
  operation: 'reset' | 'enable',
  extensionSchema: string | null,
): ToolStatement {
  if (operation === 'enable') return statement('CREATE EXTENSION pg_stat_statements');
  if (extensionSchema === null) throw invalid('pg_stat_statements is not installed');
  return statement(`SELECT ${q(extensionSchema)}.pg_stat_statements_reset()`);
}

// ------------------------------------------------------------------------------- accounts

function roleOptions(options: AccountOptions, forCreate: { readonly role: boolean } | null) {
  const parts: string[] = [];
  const shown: string[] = [];
  const secrets: string[] = [];
  const add = (sql: string, display = sql): void => {
    parts.push(sql);
    shown.push(display);
  };
  const flag = (value: boolean | undefined, on: string, off: string): void => {
    if (value !== undefined) add(value ? on : off);
  };
  const login = options.login ?? (forCreate ? !forCreate.role : undefined);
  flag(login, 'LOGIN', 'NOLOGIN');
  flag(options.superuser, 'SUPERUSER', 'NOSUPERUSER');
  flag(options.createDb, 'CREATEDB', 'NOCREATEDB');
  flag(options.createRole, 'CREATEROLE', 'NOCREATEROLE');
  flag(options.replication, 'REPLICATION', 'NOREPLICATION');
  flag(options.bypassRls, 'BYPASSRLS', 'NOBYPASSRLS');
  flag(options.inherit, 'INHERIT', 'NOINHERIT');
  if (options.connectionLimit !== undefined) {
    if (!Number.isInteger(options.connectionLimit) || options.connectionLimit < -1) {
      throw invalid('The connection limit must be a whole number, or -1 for none');
    }
    add(`CONNECTION LIMIT ${options.connectionLimit}`);
  }
  if (options.password !== undefined) {
    const literal = lit(options.password);
    add(`PASSWORD ${literal}`, `PASSWORD '${MASKED_SECRET}'`);
    secrets.push(literal, options.password);
  }
  if (options.validUntil !== undefined) {
    add(`VALID UNTIL ${lit(options.validUntil ?? 'infinity')}`);
  }
  if (options.locked !== undefined) {
    throw invalid('PostgreSQL roles cannot be locked; turn LOGIN off instead');
  }
  return { sql: parts.join(' '), shown: shown.join(' '), secrets };
}

export function accountStatements(
  action: Extract<ServerAction, { kind: 'createAccount' | 'alterAccount' | 'dropAccount' }>,
): ToolStatement[] {
  const name = roleName(action.account);
  if (action.kind === 'dropAccount') return [statement(`DROP ROLE ${name}`)];
  const out: ToolStatement[] = [];
  const options = roleOptions(
    action.options,
    action.kind === 'createAccount' ? { role: action.role } : null,
  );
  const head = action.kind === 'createAccount' ? `CREATE ROLE ${name}` : `ALTER ROLE ${name}`;
  if (options.sql !== '' || action.kind === 'createAccount') {
    const tail = (text: string): string => (text === '' ? '' : ` WITH ${text}`);
    out.push({
      sql: `${head}${tail(options.sql)}`,
      shown: `${head}${tail(options.shown)}`,
      secrets: options.secrets,
    });
  }
  if (action.kind === 'alterAccount' && action.rename !== undefined) {
    out.push(statement(`ALTER ROLE ${name} RENAME TO ${roleName(action.rename)}`));
  }
  if (out.length === 0) throw invalid('Nothing to change');
  return out;
}

export function membershipStatement(
  action: Extract<ServerAction, { kind: 'grantRole' | 'revokeRole' }>,
): ToolStatement {
  const role = roleName(action.role);
  const member = roleName(action.member);
  if (action.kind === 'grantRole') {
    return statement(`GRANT ${role} TO ${member}${action.admin ? ' WITH ADMIN OPTION' : ''}`);
  }
  return statement(`REVOKE ${action.admin ? 'ADMIN OPTION FOR ' : ''}${role} FROM ${member}`);
}

// --------------------------------------------------------------------------------- grants

/** Privileges per object kind, in the order the matrix shows them. */
export function privilegesFor(serverVersionNum: number): Record<GrantObjectKind, string[]> {
  return {
    global: [],
    database: ['CONNECT', 'CREATE', 'TEMPORARY'],
    schema: ['USAGE', 'CREATE'],
    table: [
      'SELECT',
      'INSERT',
      'UPDATE',
      'DELETE',
      'TRUNCATE',
      'REFERENCES',
      'TRIGGER',
      ...(serverVersionNum >= 170000 ? ['MAINTAIN'] : []),
    ],
    sequence: ['USAGE', 'SELECT', 'UPDATE'],
    function: ['EXECUTE'],
  };
}

/**
 * GRANT or REVOKE on one object. A function is named by `resolvedFunction`: the server's own
 * `oid::regprocedure` text for the object, never the page's signature.
 */
export function grantStatement(
  action: Extract<ServerAction, { kind: 'grant' | 'revoke' }>,
  serverVersionNum: number,
  resolvedFunction?: string,
): ToolStatement {
  const { object } = action;
  const allowed = privilegesFor(serverVersionNum)[object.kind];
  if (allowed.length === 0) throw invalid('PostgreSQL has no server-wide privileges to grant');
  if (action.privileges.length === 0) throw invalid('Pick at least one privilege');
  const privileges = action.privileges.map((p) => p.toUpperCase());
  for (const privilege of privileges) {
    if (!allowed.includes(privilege)) {
      throw invalid(`${privilege} cannot be granted on a ${object.kind}`);
    }
  }
  let target: string;
  switch (object.kind) {
    case 'database':
      target = `DATABASE ${q(checkName(object.name ?? object.database ?? '', 'database'))}`;
      break;
    case 'schema':
      target = `SCHEMA ${q(checkName(object.name ?? object.schema ?? '', 'schema'))}`;
      break;
    case 'table':
    case 'sequence':
      target = `${object.kind === 'table' ? 'TABLE' : 'SEQUENCE'} ${quoteQualified(
        [checkName(object.schema ?? '', 'schema'), checkName(object.name ?? '', object.kind)],
        'postgres',
      )}`;
      break;
    case 'function':
      if (resolvedFunction === undefined) throw invalid('The function was not found');
      target = `ROUTINE ${resolvedFunction}`;
      break;
    default:
      throw invalid(`Cannot grant on a ${object.kind}`);
  }
  const grantee = granteeSql(action.grantee.name);
  const list = privileges.join(', ');
  if (action.kind === 'grant') {
    return statement(
      `GRANT ${list} ON ${target} TO ${grantee}${action.grantOption ? ' WITH GRANT OPTION' : ''}`,
    );
  }
  return statement(
    `REVOKE ${action.grantOption ? 'GRANT OPTION FOR ' : ''}${list} ON ${target} FROM ${grantee}`,
  );
}

const DEFAULT_PRIVILEGES: Readonly<Record<DefaultPrivilegeType, readonly string[]>> = {
  tables: ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN'],
  sequences: ['USAGE', 'SELECT', 'UPDATE'],
  functions: ['EXECUTE'],
  types: ['USAGE'],
  schemas: ['USAGE', 'CREATE'],
};

export function defaultPrivilegeStatement(
  action: Extract<ServerAction, { kind: 'defaultPrivileges' }>,
  serverVersionNum: number,
): ToolStatement {
  const allowed = DEFAULT_PRIVILEGES[action.objectType].filter(
    (p) => p !== 'MAINTAIN' || serverVersionNum >= 170000,
  );
  if (action.privileges.length === 0) throw invalid('Pick at least one privilege');
  const privileges = action.privileges.map((p) => p.toUpperCase());
  for (const privilege of privileges) {
    if (!allowed.includes(privilege)) {
      throw invalid(`${privilege} is not a default privilege for ${action.objectType}`);
    }
  }
  if (action.objectType === 'schemas' && action.schema !== undefined) {
    throw invalid('Default privileges on schemas cannot be limited to a schema');
  }
  const scope = [
    action.owner !== undefined ? ` FOR ROLE ${q(checkName(action.owner, 'role'))}` : '',
    action.schema !== undefined ? ` IN SCHEMA ${q(checkName(action.schema, 'schema'))}` : '',
  ].join('');
  const on = action.objectType.toUpperCase();
  const grantee = granteeSql(action.grantee);
  const list = privileges.join(', ');
  return statement(
    action.operation === 'grant'
      ? `ALTER DEFAULT PRIVILEGES${scope} GRANT ${list} ON ${on} TO ${grantee}${
          action.grantOption ? ' WITH GRANT OPTION' : ''
        }`
      : `ALTER DEFAULT PRIVILEGES${scope} REVOKE ${
          action.grantOption ? 'GRANT OPTION FOR ' : ''
        }${list} ON ${on} FROM ${grantee}`,
  );
}

// ------------------------------------------------------------------------------- policies

/**
 * A policy's USING or WITH CHECK text is SQL the user typed, placed inside parentheses. It must
 * be one expression that cannot escape them: no statement delimiter, no comment or unclosed
 * quote that would swallow the rest, parentheses balanced.
 */
export function checkExpression(text: string, what: string): string {
  const trimmed = text.trim();
  if (trimmed === '') throw invalid(`The ${what} expression is empty`);
  let depth = 0;
  for (const token of tokenize(trimmed, 'postgres')) {
    if (token.unterminated) throw invalid(`The ${what} expression has an unclosed quote`);
    if (token.kind === 'delimiter' || (token.kind === 'punctuation' && token.text === ';')) {
      throw invalid(`The ${what} expression must be one expression, without ";"`);
    }
    if (token.kind === 'line-comment' || token.kind === 'block-comment') {
      throw invalid(`Remove the comment from the ${what} expression`);
    }
    if (token.kind === 'parameter') throw invalid(`The ${what} expression cannot use parameters`);
    if (token.text === '(') depth++;
    if (token.text === ')' && --depth < 0) {
      throw invalid(`The ${what} expression closes a parenthesis it did not open`);
    }
  }
  if (depth !== 0) throw invalid(`The ${what} expression has an unclosed parenthesis`);
  return trimmed;
}

export function policyStatement(
  action: Extract<ServerAction, { kind: 'createPolicy' | 'dropPolicy' | 'rowSecurity' }>,
): ToolStatement {
  const table = quoteQualified(
    [checkName(action.schema, 'schema'), checkName(action.table, 'table')],
    'postgres',
  );
  if (action.kind === 'rowSecurity') {
    const parts = [
      `ALTER TABLE ${table} ${action.enabled ? 'ENABLE' : 'DISABLE'} ROW LEVEL SECURITY`,
    ];
    if (action.forced !== undefined) {
      parts.push(`${action.forced ? 'FORCE' : 'NO FORCE'} ROW LEVEL SECURITY`);
    }
    return statement(parts.join(', '));
  }
  const name = q(checkName(action.name, 'policy'));
  if (action.kind === 'dropPolicy') return statement(`DROP POLICY ${name} ON ${table}`);
  const command: PolicyCommand = action.command;
  if (command === 'INSERT' && action.using !== undefined) {
    throw invalid('An INSERT policy takes only a WITH CHECK expression');
  }
  if ((command === 'SELECT' || command === 'DELETE') && action.withCheck !== undefined) {
    throw invalid(`A ${command} policy takes only a USING expression`);
  }
  if (action.using === undefined && action.withCheck === undefined) {
    throw invalid('Give a USING or a WITH CHECK expression');
  }
  const roles = action.roles.length === 0 ? ['public'] : action.roles;
  const parts = [
    `CREATE POLICY ${name} ON ${table}`,
    `AS ${action.permissive ? 'PERMISSIVE' : 'RESTRICTIVE'}`,
    `FOR ${command}`,
    `TO ${roles.map(granteeSql).join(', ')}`,
  ];
  if (action.using !== undefined) parts.push(`USING (${checkExpression(action.using, 'USING')})`);
  if (action.withCheck !== undefined) {
    parts.push(`WITH CHECK (${checkExpression(action.withCheck, 'WITH CHECK')})`);
  }
  return statement(parts.join(' '));
}
