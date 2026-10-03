import {
  GRANT_OBJECT_KINDS,
  type AccountOptions,
  type AccountRef,
  type EngineId,
  type GrantMatrix,
  type GrantObjectKind,
  type GrantRow,
  type GrantState,
  type ServerAccount,
  type ServerAction,
  type ServerSession,
  type ServerSetting,
} from '@querybara/core';

/**
 * View models of the server tools tabs: session filters, the grants matrix grouped by object
 * kind and its cell toggles, account forms turned into actions, and setting filters. Pure, so
 * they are unit-tested without a server.
 */

// --------------------------------------------------------------------------------- sessions

export interface SessionFilter {
  readonly text: string;
}

/** Sessions matching the filter text (user, database, client, application, state, query). */
export function filterSessions(
  sessions: readonly ServerSession[],
  filter: SessionFilter,
): ServerSession[] {
  const needle = filter.text.trim().toLowerCase();
  const matches = (s: ServerSession): boolean =>
    needle === '' ||
    [s.id, s.user, s.database, s.client, s.application, s.state, s.query, s.wait].some(
      (value) => value !== null && value.toLowerCase().includes(needle),
    );
  return sessions
    .filter(matches)
    .sort((a, b) => (b.durationMs ?? -1) - (a.durationMs ?? -1) || compareIds(a.id, b.id));
}

function compareIds(a: string, b: string): number {
  const na = Number(a);
  const nb = Number(b);
  if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** A key for a session row: its id, or where it comes from when it has none. */
export function sessionKey(session: ServerSession): string {
  return session.id !== ''
    ? session.id
    : `~${session.client ?? ''}~${String(session.detail['desc'] ?? '')}`;
}

/** Whether a session can be cancelled or terminated from here. */
export function canSignal(session: ServerSession): boolean {
  return session.id !== '' && !session.own;
}

// ----------------------------------------------------------------------------------- grants

export const GRANT_KIND_TITLES: Readonly<Record<GrantObjectKind, string>> = {
  global: 'Server',
  database: 'Database',
  schema: 'Schema',
  table: 'Tables and views',
  sequence: 'Sequences',
  function: 'Functions and procedures',
};

export interface GrantGroup {
  readonly kind: GrantObjectKind;
  readonly title: string;
  readonly privileges: readonly string[];
  readonly rows: readonly GrantRow[];
}

/** The matrix split by object kind (each has its own privilege columns), rows filtered by name. */
export function grantGroups(matrix: GrantMatrix, filter = ''): GrantGroup[] {
  const needle = filter.trim().toLowerCase();
  return GRANT_OBJECT_KINDS.map((kind) => ({
    kind,
    title: GRANT_KIND_TITLES[kind],
    privileges: matrix.privileges[kind] ?? [],
    rows: matrix.rows.filter(
      (row) =>
        row.object.kind === kind &&
        (needle === '' || kind === 'global' || row.label.toLowerCase().includes(needle)),
    ),
  })).filter((group) => group.rows.length > 0 && group.privileges.length > 0);
}

/**
 * What clicking a matrix cell does: grant a privilege not held by a grant of its own (none or
 * implied), revoke one that is.
 */
export function toggleGrant(
  grantee: AccountRef,
  row: GrantRow,
  privilege: string,
  withGrantOption: boolean,
): ServerAction {
  const state: GrantState = row.privileges[privilege] ?? 'none';
  const held = state === 'granted' || state === 'grantable';
  return held
    ? { kind: 'revoke', grantee, object: row.object, privileges: [privilege] }
    : {
        kind: 'grant',
        grantee,
        object: row.object,
        privileges: [privilege],
        ...(withGrantOption ? { grantOption: true } : {}),
      };
}

export const GRANT_STATE_LABELS: Readonly<Record<GrantState, string>> = {
  none: 'not granted',
  granted: 'granted',
  grantable: 'granted with grant option',
  implied: 'held another way',
};

// --------------------------------------------------------------------------------- accounts

export function accountName(account: { readonly name: string; readonly host?: string }): string {
  const name = account.name === '' ? '(anonymous)' : account.name;
  return account.host !== undefined && account.host !== '' ? `${name}@${account.host}` : name;
}

export function accountRef(account: ServerAccount): AccountRef {
  return account.host !== undefined
    ? { name: account.name, host: account.host }
    : { name: account.name };
}

export interface AccountForm {
  readonly name: string;
  readonly host: string;
  readonly role: boolean;
  readonly password: string;
  readonly login: boolean;
  readonly superuser: boolean;
  readonly createDb: boolean;
  readonly createRole: boolean;
  readonly replication: boolean;
  readonly bypassRls: boolean;
  readonly inherit: boolean;
  /** Empty for none. */
  readonly connectionLimit: string;
  /** Empty for none. */
  readonly validUntil: string;
  readonly locked: boolean;
}

/** The form for a new account, or filled from an existing one. */
export function accountForm(engine: EngineId, existing?: ServerAccount, role = false): AccountForm {
  const has = (attribute: string): boolean => existing?.attributes.includes(attribute) ?? false;
  return {
    name: existing?.name ?? '',
    host:
      existing?.host ??
      (engine === 'mysql' || engine === 'mariadb' ? (role && engine === 'mariadb' ? '' : '%') : ''),
    role: existing ? existing.kind === 'role' : role,
    password: '',
    login: existing?.canLogin ?? !role,
    superuser: existing?.superuser ?? false,
    createDb: has('CREATEDB'),
    createRole: has('CREATEROLE'),
    replication: has('REPLICATION'),
    bypassRls: has('BYPASSRLS'),
    inherit: !has('NOINHERIT'),
    connectionLimit:
      existing?.connectionLimit !== null && existing?.connectionLimit !== undefined
        ? String(existing.connectionLimit)
        : '',
    validUntil: existing?.validUntil ?? '',
    locked: existing?.locked ?? false,
  };
}

function limitOf(text: string): number | undefined {
  const trimmed = text.trim();
  if (trimmed === '') return undefined;
  const n = Number(trimmed);
  return Number.isInteger(n) ? n : undefined;
}

/**
 * The action a submitted account form stands for: CREATE for a new account; for an existing
 * one, ALTER with only what changed (and RENAME when the name or host did).
 */
export function accountAction(
  engine: EngineId,
  form: AccountForm,
  existing?: ServerAccount,
): ServerAction {
  const postgres = engine === 'postgres';
  const hostless = postgres || (engine === 'mariadb' && form.role);
  const ref: AccountRef = hostless
    ? { name: form.name.trim() }
    : { name: form.name.trim(), host: form.host.trim() || '%' };
  const options: { -readonly [K in keyof AccountOptions]: AccountOptions[K] } = {};
  if (form.password !== '') options.password = form.password;
  const limit = limitOf(form.connectionLimit);
  if (!existing) {
    if (postgres) {
      if (form.login !== !form.role) options.login = form.login;
      if (form.superuser) options.superuser = true;
      if (form.createDb) options.createDb = true;
      if (form.createRole) options.createRole = true;
      if (form.replication) options.replication = true;
      if (form.bypassRls) options.bypassRls = true;
      if (!form.inherit) options.inherit = false;
      if (form.validUntil.trim() !== '') options.validUntil = form.validUntil.trim();
    } else if (form.locked && !form.role) {
      options.locked = true;
    }
    // MySQL and MariaDB roles take no limits; PostgreSQL roles do.
    if (limit !== undefined && (postgres || !form.role)) options.connectionLimit = limit;
    return { kind: 'createAccount', account: ref, role: form.role, options };
  }
  const before = accountForm(engine, existing);
  if (postgres) {
    const flags = [
      'login',
      'superuser',
      'createDb',
      'createRole',
      'replication',
      'bypassRls',
      'inherit',
    ] as const;
    for (const flag of flags) if (form[flag] !== before[flag]) options[flag] = form[flag];
    if (form.validUntil.trim() !== before.validUntil) {
      options.validUntil = form.validUntil.trim() === '' ? null : form.validUntil.trim();
    }
  } else if (form.locked !== before.locked) {
    options.locked = form.locked;
  }
  if (form.connectionLimit.trim() !== before.connectionLimit) {
    options.connectionLimit = limit ?? (postgres ? -1 : 0);
  }
  const renamed =
    ref.name !== existing.name || (ref.host !== undefined && ref.host !== existing.host);
  return {
    kind: 'alterAccount',
    account: accountRef(existing),
    options,
    ...(renamed ? { rename: ref } : {}),
  };
}

// --------------------------------------------------------------------------------- settings

export interface SettingFilter {
  readonly text: string;
  /** Only settings changed from their built-in default. */
  readonly changedOnly: boolean;
}

const DEFAULT_SOURCES = new Set(['default', 'compiled', 'compile-time']);

export function filterSettings(
  settings: readonly ServerSetting[],
  filter: SettingFilter,
): ServerSetting[] {
  const needle = filter.text.trim().toLowerCase();
  return settings.filter(
    (s) =>
      (needle === '' ||
        s.name.toLowerCase().includes(needle) ||
        (s.description ?? '').toLowerCase().includes(needle) ||
        (s.category ?? '').toLowerCase().includes(needle)) &&
      (!filter.changedOnly || (s.source !== null && !DEFAULT_SOURCES.has(s.source))),
  );
}
