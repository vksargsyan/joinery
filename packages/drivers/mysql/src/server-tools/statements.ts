import {
  JoineryError,
  MASKED_SECRET,
  type AccountOptions,
  type AccountRef,
  type GrantObjectKind,
  type MaintenanceTargetRef,
  type ServerAction,
} from '@joinery/core';
import { quoteIdent, quoteQualified, quoteString } from '@joinery/sql-tools';

import { statement, type ToolStatement } from './runner';

/**
 * The statements the MySQL and MariaDB server tools run, built from an action with every name
 * quoted and every value a literal. Pure: the preview shows exactly what `run` sends. Where
 * the two differ (roles without a host on MariaDB, SET PERSIST on MySQL) `flavor` decides.
 */

export type Flavor = 'mysql' | 'mariadb';

const lit = (value: string): string => quoteString(value, 'mysql');

function invalid(message: string): JoineryError {
  return new JoineryError({ code: 'VALIDATION_FAILED', message });
}

function unsupported(message: string): JoineryError {
  return new JoineryError({ code: 'NOT_SUPPORTED', message });
}

export function checkName(name: string, what: string, max = 64): string {
  if (name === '') throw invalid(`The ${what} name is empty`);
  if ([...name].length > max) throw invalid(`The ${what} name is longer than ${max} characters`);
  if (name.includes('\0')) throw invalid(`The ${what} name contains a NUL character`);
  return name;
}

/**
 * An account as SQL: 'user'@'host'. MariaDB roles have no host, so a MariaDB account without
 * one is a role ('role'); on MySQL a role is an account like any other, '%' when left out.
 */
export function accountSql(account: AccountRef, flavor: Flavor): string {
  const hostless = account.host === undefined || account.host === '';
  // An anonymous account (''@'localhost') is named by its host alone.
  const user =
    account.name === '' && !hostless
      ? "''"
      : lit(checkName(account.name, 'account', flavor === 'mysql' ? 32 : 128));
  if (flavor === 'mariadb' && hostless) return user;
  return `${user}@${lit(checkName(hostless ? '%' : account.host!, 'host', 255))}`;
}

// ------------------------------------------------------------------------------- sessions

export function threadIdOf(id: string): number {
  if (!/^\d{1,20}$/.test(id)) throw invalid(`"${id}" is not a thread id`);
  return Number(id);
}

export function killStatement(operation: 'cancel' | 'terminate', id: string): ToolStatement {
  return statement(`KILL ${operation === 'cancel' ? 'QUERY' : 'CONNECTION'} ${threadIdOf(id)}`);
}

// ---------------------------------------------------------------------------- maintenance

export const MAINTENANCE_OPTIONS: Readonly<Record<string, readonly string[]>> = {
  analyze: ['local'],
  optimize: ['local'],
  check: ['quick', 'fast', 'medium', 'extended', 'changed'],
  repair: ['local', 'quick', 'extended', 'use_frm'],
};

function tableSql(target: MaintenanceTargetRef): string {
  return quoteQualified(
    [checkName(target.container, 'database'), checkName(target.name, 'table')],
    'mysql',
  );
}

/** ANALYZE, OPTIMIZE, CHECK and REPAIR TABLE take every target in one statement. */
export function maintenanceStatement(
  action: Extract<ServerAction, { kind: 'maintenance' }>,
): ToolStatement {
  const { operation, targets } = action;
  const allowed = MAINTENANCE_OPTIONS[operation];
  if (!allowed) {
    throw unsupported(`${operation.toUpperCase()} is not a MySQL maintenance command`);
  }
  if (targets.length === 0) throw invalid('Pick at least one table');
  for (const option of action.options) {
    if (!allowed.includes(option)) {
      throw invalid(`${operation.toUpperCase()} TABLE has no option "${option}"`);
    }
  }
  const has = (option: string): boolean => action.options.includes(option);
  const tables = targets.map(tableSql).join(', ');
  const head = `${operation.toUpperCase()}${has('local') ? ' NO_WRITE_TO_BINLOG' : ''} TABLE`;
  const tail =
    operation === 'check' || operation === 'repair'
      ? allowed
          .filter((o) => o !== 'local' && has(o))
          .map((o) => ` ${o.toUpperCase()}`)
          .join('')
      : '';
  return statement(`${head} ${tables}${tail}`);
}

// ------------------------------------------------------------------------------- settings

const VARIABLE = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?$/;

export function checkVariable(name: string): string {
  if (!VARIABLE.test(name) || name.length > 200) {
    throw invalid(`"${name}" is not a system variable name`);
  }
  return name.toLowerCase();
}

/** A value as SQL: numbers and ON/OFF as they are, anything else a string literal. */
export function variableValueSql(value: string): string {
  const text = value.trim();
  if (/^-?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(text)) return text;
  if (/^(ON|OFF|TRUE|FALSE)$/i.test(text)) return text.toUpperCase();
  return lit(value);
}

export function settingStatement(
  action: Extract<ServerAction, { kind: 'setting' }>,
  flavor: Flavor,
): ToolStatement {
  const name = checkVariable(action.name);
  const value = action.value === null ? 'DEFAULT' : variableValueSql(action.value);
  switch (action.scope) {
    case 'session':
      return statement(`SET SESSION ${name} = ${value}`);
    case 'global':
      return statement(`SET GLOBAL ${name} = ${value}`);
    case 'persist':
      if (flavor === 'mariadb') {
        throw unsupported('MariaDB has no SET PERSIST; change the option file instead');
      }
      return statement(
        action.value === null ? `RESET PERSIST ${name}` : `SET PERSIST ${name} = ${value}`,
      );
    default:
      throw unsupported(
        `${flavor === 'mariadb' ? 'MariaDB' : 'MySQL'} has no "${action.scope}" setting scope`,
      );
  }
}

// ---------------------------------------------------------------------------- top queries

export function topQueriesStatement(operation: 'reset' | 'enable'): ToolStatement {
  return statement(
    operation === 'reset'
      ? 'TRUNCATE TABLE performance_schema.events_statements_summary_by_digest'
      : "UPDATE performance_schema.setup_consumers SET ENABLED = 'YES' WHERE NAME = 'statements_digest'",
  );
}

// ------------------------------------------------------------------------------- accounts

function checkAccountOptions(options: AccountOptions): void {
  const unsupportedKeys = (
    [
      'login',
      'superuser',
      'createDb',
      'createRole',
      'replication',
      'bypassRls',
      'inherit',
      'validUntil',
    ] as const
  ).filter((key) => options[key] !== undefined);
  if (unsupportedKeys.length > 0) {
    throw invalid(
      `${unsupportedKeys.join(', ')}: not account options on MySQL or MariaDB; use grants`,
    );
  }
  if (
    options.connectionLimit !== undefined &&
    (!Number.isInteger(options.connectionLimit) || options.connectionLimit < -1)
  ) {
    throw invalid('The connection limit must be a whole number, or -1 for none');
  }
}

/** The clauses of CREATE USER / ALTER USER, with the password masked in `shown`. */
function userClauses(options: AccountOptions): { sql: string; shown: string; secrets: string[] } {
  const sql: string[] = [];
  const shown: string[] = [];
  const secrets: string[] = [];
  if (options.password !== undefined) {
    const literal = lit(options.password);
    sql.push(`IDENTIFIED BY ${literal}`);
    shown.push(`IDENTIFIED BY '${MASKED_SECRET}'`);
    secrets.push(literal, options.password);
  }
  if (options.connectionLimit !== undefined) {
    const clause = `WITH MAX_USER_CONNECTIONS ${Math.max(0, options.connectionLimit)}`;
    sql.push(clause);
    shown.push(clause);
  }
  if (options.locked !== undefined) {
    const clause = options.locked ? 'ACCOUNT LOCK' : 'ACCOUNT UNLOCK';
    sql.push(clause);
    shown.push(clause);
  }
  return { sql: sql.join(' '), shown: shown.join(' '), secrets };
}

export function accountStatements(
  action: Extract<ServerAction, { kind: 'createAccount' | 'alterAccount' | 'dropAccount' }>,
  flavor: Flavor,
): ToolStatement[] {
  const hostless = action.account.host === undefined || action.account.host === '';
  const role = action.kind === 'alterAccount' ? flavor === 'mariadb' && hostless : action.role;
  if (flavor === 'mariadb' && action.kind !== 'alterAccount' && role !== hostless) {
    throw invalid(role ? 'MariaDB roles have no host' : 'A MariaDB user needs a host');
  }
  const name = accountSql(action.account, flavor);
  if (action.kind === 'dropAccount') {
    return [statement(`${role ? 'DROP ROLE' : 'DROP USER'} ${name}`)];
  }
  checkAccountOptions(action.options);
  const clauses = userClauses(action.options);
  if (action.kind === 'createAccount') {
    if (role) {
      if (clauses.sql !== '') throw invalid('A role takes no password, limit or lock');
      return [statement(`CREATE ROLE ${name}`)];
    }
    const tail = (text: string): string => (text === '' ? '' : ` ${text}`);
    return [
      {
        sql: `CREATE USER ${name}${tail(clauses.sql)}`,
        shown: `CREATE USER ${name}${tail(clauses.shown)}`,
        secrets: clauses.secrets,
      },
    ];
  }
  const out: ToolStatement[] = [];
  if (clauses.sql !== '') {
    if (role && flavor === 'mariadb')
      throw invalid('MariaDB roles have no password, limit or lock');
    out.push({
      sql: `ALTER USER ${name} ${clauses.sql}`,
      shown: `ALTER USER ${name} ${clauses.shown}`,
      secrets: clauses.secrets,
    });
  }
  if (action.rename !== undefined) {
    if (role && flavor === 'mariadb') throw invalid('MariaDB roles cannot be renamed');
    out.push(statement(`RENAME USER ${name} TO ${accountSql(action.rename, flavor)}`));
  }
  if (out.length === 0) throw invalid('Nothing to change');
  return out;
}

export function membershipStatement(
  action: Extract<ServerAction, { kind: 'grantRole' | 'revokeRole' }>,
  flavor: Flavor,
): ToolStatement {
  const role = accountSql(action.role, flavor);
  const member = accountSql(action.member, flavor);
  if (action.kind === 'grantRole') {
    return statement(`GRANT ${role} TO ${member}${action.admin ? ' WITH ADMIN OPTION' : ''}`);
  }
  if (action.admin) {
    if (flavor === 'mysql') {
      throw invalid(
        'MySQL cannot revoke only the admin option; revoke the role and grant it again',
      );
    }
    return statement(`REVOKE ADMIN OPTION FOR ${role} FROM ${member}`);
  }
  return statement(`REVOKE ${role} FROM ${member}`);
}

// --------------------------------------------------------------------------------- grants

const TABLE_PRIVILEGES = [
  'SELECT',
  'INSERT',
  'UPDATE',
  'DELETE',
  'CREATE',
  'DROP',
  'REFERENCES',
  'INDEX',
  'ALTER',
  'CREATE VIEW',
  'SHOW VIEW',
  'TRIGGER',
];

const DATABASE_PRIVILEGES = [
  ...TABLE_PRIVILEGES,
  'CREATE TEMPORARY TABLES',
  'LOCK TABLES',
  'EXECUTE',
  'CREATE ROUTINE',
  'ALTER ROUTINE',
  'EVENT',
];

const GLOBAL_PRIVILEGES = [
  ...DATABASE_PRIVILEGES,
  'RELOAD',
  'SHUTDOWN',
  'PROCESS',
  'FILE',
  'SHOW DATABASES',
  'SUPER',
  'REPLICATION SLAVE',
  'REPLICATION CLIENT',
  'CREATE USER',
  'CREATE TABLESPACE',
];

/** Privilege columns per object kind, in matrix order. */
export function privilegesFor(flavor: Flavor): Partial<Record<GrantObjectKind, string[]>> {
  const history = flavor === 'mariadb' ? ['DELETE HISTORY'] : [];
  return {
    global: [
      ...GLOBAL_PRIVILEGES,
      ...history,
      ...(flavor === 'mysql' ? ['CREATE ROLE', 'DROP ROLE'] : []),
    ],
    database: [...DATABASE_PRIVILEGES, ...history],
    table: [...TABLE_PRIVILEGES, ...history],
  };
}

/** A privilege name the server knows: words of letters and underscores (dynamic ones too). */
const PRIVILEGE = /^[A-Z][A-Z_]*( [A-Z][A-Z_]*)*$/;

export function grantStatement(
  action: Extract<ServerAction, { kind: 'grant' | 'revoke' }>,
  flavor: Flavor,
): ToolStatement {
  const { object } = action;
  const known = privilegesFor(flavor)[object.kind];
  if (!known)
    throw invalid(
      `MySQL grants privileges on the server, a database or a table, not a ${object.kind}`,
    );
  if (action.privileges.length === 0 && !(action.kind === 'revoke' && action.grantOption)) {
    throw invalid('Pick at least one privilege');
  }
  const privileges = action.privileges.map((p) => p.toUpperCase().trim());
  for (const privilege of privileges) {
    // Global grants also take the server's dynamic privileges (SYSTEM_VARIABLES_ADMIN...).
    if (!known.includes(privilege) && !(object.kind === 'global' && PRIVILEGE.test(privilege))) {
      throw invalid(
        `${privilege} cannot be granted on a ${object.kind === 'global' ? 'server' : object.kind}`,
      );
    }
  }
  const on =
    object.kind === 'global'
      ? '*.*'
      : object.kind === 'database'
        ? `${quoteIdent(checkName(object.name ?? object.database ?? '', 'database'), 'mysql')}.*`
        : tableSql({ container: object.database ?? object.schema ?? '', name: object.name ?? '' });
  const grantee = accountSql(action.grantee, flavor);
  if (action.kind === 'grant') {
    return statement(
      `GRANT ${privileges.join(', ')} ON ${on} TO ${grantee}${action.grantOption ? ' WITH GRANT OPTION' : ''}`,
    );
  }
  // The grant option belongs to the level (database, table), not to single privileges.
  if (action.grantOption) return statement(`REVOKE GRANT OPTION ON ${on} FROM ${grantee}`);
  return statement(`REVOKE ${privileges.join(', ')} ON ${on} FROM ${grantee}`);
}
