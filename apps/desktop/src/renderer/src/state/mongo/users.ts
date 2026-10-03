import {
  formatShellInline,
  fromEjson,
  parseShellDocument,
  quoteShellString,
  toEjson,
  type BsonDocument,
  type CreateUserSpec,
  type Privilege,
  type RoleInfo,
  type RoleRef,
  type RoleSpec,
  type UpdateUserSpec,
  type UserInfo,
} from '@querybara/mongo-tools';
import { useStore } from 'zustand';
import { createStore, type StoreApi } from 'zustand/vanilla';

import { errorMessage } from '../../lib/errors';
import type { HostClient } from '../../lib/main-client';
import { loadChildren } from '../explorer';
import { SessionLane } from '../session-lane';
import type { Notice } from './collection-view';
import { databaseReference } from './explorer';
import {
  DEFAULT_WRITE_RULES,
  READ_ONLY_TEXT,
  confirmMongoWrite,
  loadWriteRules,
  type WriteRules,
} from './write-rules';

/**
 * The users and roles editor (spec §9): a database's users with their roles, inherited roles and
 * privileges; its custom roles (and the built-in ones on request) with their privileges and
 * inherited roles. Users are created, edited (password, mechanisms, custom data, roles granted
 * and revoked) and dropped; custom roles are created, edited and dropped. Every change becomes
 * the exact mongosh commands, shown and confirmed before they run. A password is typed into a
 * secret field, goes to the server once, and is shown nowhere: the commands say
 * `passwordPrompt()` in its place.
 */

export const BUILTIN_ROLES = [
  'read',
  'readWrite',
  'dbAdmin',
  'dbOwner',
  'userAdmin',
  'enableSharding',
  'clusterAdmin',
  'clusterManager',
  'clusterMonitor',
  'hostManager',
  'backup',
  'restore',
  'readAnyDatabase',
  'readWriteAnyDatabase',
  'userAdminAnyDatabase',
  'dbAdminAnyDatabase',
  'root',
] as const;

/** Actions offered when typing a privilege (the server knows more). */
export const COMMON_ACTIONS = [
  'find',
  'insert',
  'update',
  'remove',
  'createCollection',
  'dropCollection',
  'createIndex',
  'dropIndex',
  'collMod',
  'listCollections',
  'listIndexes',
  'collStats',
  'dbStats',
  'changeStream',
  'killCursors',
  'bypassDocumentValidation',
  'renameCollectionSameDB',
  'convertToCapped',
  'createUser',
  'dropUser',
  'grantRole',
  'revokeRole',
  'viewRole',
  'viewUser',
  'serverStatus',
  'listDatabases',
  'killop',
  'inprog',
] as const;

export type Mechanism = 'SCRAM-SHA-1' | 'SCRAM-SHA-256';

export type Built<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly issues: Readonly<Record<string, string>> };

/** One command of a change, and the call that runs it. */
export interface UserOperation {
  readonly command: string;
  readonly run: (host: HostClient, sessionId: string) => Promise<void>;
}

function roleRefText(roles: readonly RoleRef[]): string {
  return formatShellInline(roles.map((r) => ({ role: r.role, db: r.db })));
}

function sameRef(a: RoleRef, b: RoleRef): boolean {
  return a.role === b.role && a.db === b.db;
}

/** Role references as typed: trimmed, blank rows left out, each role once. */
export function cleanRoles(
  roles: readonly RoleRef[],
  issues: Record<string, string>,
  key = 'roles',
): RoleRef[] {
  const out: RoleRef[] = [];
  for (const ref of roles) {
    const role = ref.role.trim();
    const db = ref.db.trim();
    if (role === '' && db === '') continue;
    if (role === '' || db === '') {
      issues[key] = 'Every role needs a name and a database';
      continue;
    }
    if (!out.some((r) => sameRef(r, { role, db }))) out.push({ role, db });
  }
  return out;
}

function customDataOf(text: string, issues: Record<string, string>): BsonDocument | undefined {
  if (text.trim() === '') return undefined;
  try {
    return parseShellDocument(text, 'custom data');
  } catch (error) {
    issues['customData'] = errorMessage(error);
    return undefined;
  }
}

// ---------------------------------------------------------------------------------------------
// Users

export interface UserForm {
  readonly mode: 'create' | 'edit';
  readonly user: string;
  /** Typed only; never filled from the server. Empty on edit keeps the current password. */
  readonly password: string;
  readonly mechanisms: readonly Mechanism[];
  readonly roles: readonly RoleRef[];
  readonly customData: string;
}

/** A new user's form: read on the database, SCRAM-SHA-256. */
export function newUserForm(db: string): UserForm {
  return {
    mode: 'create',
    user: '',
    password: '',
    mechanisms: ['SCRAM-SHA-256'],
    roles: [{ role: 'read', db }],
    customData: '',
  };
}

/** The form editing an existing user (no password: it is never read back). */
export function editUserForm(info: UserInfo): UserForm {
  return {
    mode: 'edit',
    user: info.user,
    password: '',
    mechanisms: (info.mechanisms ?? []).filter(
      (m): m is Mechanism => m === 'SCRAM-SHA-1' || m === 'SCRAM-SHA-256',
    ),
    roles: info.roles.map((r) => ({ role: r.role, db: r.db })),
    customData: info.customData !== undefined ? customDataText(info.customData) : '',
  };
}

function customDataText(ejson: string): string {
  try {
    return formatShellInline(fromEjson(ejson, 'custom data'));
  } catch {
    return ejson;
  }
}

/** `db.getSiblingDB('shop').createUser({ user: 'ada', pwd: passwordPrompt(), roles: […] })`. */
export function createUserCommand(db: string, spec: CreateUserSpec): string {
  const parts = [`user: ${quoteShellString(spec.user)}`];
  if (spec.password !== undefined) parts.push('pwd: passwordPrompt()');
  parts.push(`roles: ${roleRefText(spec.roles)}`);
  if (spec.customData !== undefined) parts.push(`customData: ${spec.customData}`);
  if (spec.mechanisms !== undefined)
    parts.push(`mechanisms: ${formatShellInline([...spec.mechanisms])}`);
  return `${databaseReference(db)}.createUser({ ${parts.join(', ')} })`;
}

/** Checks a new user's form: its spec (password included) and the command (without it). */
export function buildCreateUser(
  db: string,
  form: UserForm,
): Built<{ spec: CreateUserSpec; command: string }> {
  const issues: Record<string, string> = {};
  const user = form.user.trim();
  if (user === '') issues['user'] = 'Name the user';
  const external = db === '$external';
  if (!external && form.password === '') issues['password'] = 'Type a password';
  if (external && form.password !== '') {
    issues['password'] = 'Users in $external authenticate elsewhere; leave the password empty';
  }
  if (!external && form.mechanisms.length === 0) issues['mechanisms'] = 'Pick a mechanism';
  const roles = cleanRoles(form.roles, issues);
  const customData = customDataOf(form.customData, issues);
  if (Object.keys(issues).length > 0) return { ok: false, issues };
  const spec: CreateUserSpec = {
    user,
    ...(external ? {} : { password: form.password }),
    roles,
    ...(customData !== undefined ? { customData: toEjson(customData) } : {}),
    ...(external ? {} : { mechanisms: [...form.mechanisms] }),
  };
  const shown = {
    ...spec,
    ...(customData !== undefined ? { customData: formatShellInline(customData) } : {}),
  };
  return { ok: true, value: { spec, command: createUserCommand(db, shown) } };
}

/**
 * The commands that turn `original` into the form: updateUser for a new password, mechanisms or
 * custom data, then grantRolesToUser and revokeRolesFromUser for the role differences.
 */
export function buildUserChanges(
  db: string,
  original: UserInfo,
  form: UserForm,
): Built<UserOperation[]> {
  const issues: Record<string, string> = {};
  const roles = cleanRoles(form.roles, issues);
  const customData = customDataOf(form.customData, issues);
  const before = editUserForm(original);
  const mechanismsChanged =
    [...form.mechanisms].sort().join() !== [...before.mechanisms].sort().join();
  if (mechanismsChanged && form.mechanisms.length === 0) issues['mechanisms'] = 'Pick a mechanism';
  if (mechanismsChanged && form.password === '' && db !== '$external') {
    issues['password'] = 'Changing the mechanisms needs the password again';
  }
  if (Object.keys(issues).length > 0) return { ok: false, issues };
  const user = original.user;
  const ops: UserOperation[] = [];
  const update: { -readonly [K in keyof UpdateUserSpec]: UpdateUserSpec[K] } = {};
  const shown: string[] = [];
  if (form.password !== '') {
    update.password = form.password;
    shown.push('pwd: passwordPrompt()');
  }
  if (form.customData.trim() !== before.customData.trim()) {
    update.customData = toEjson(customData ?? {});
    shown.push(`customData: ${formatShellInline(customData ?? {})}`);
  }
  if (mechanismsChanged) {
    update.mechanisms = [...form.mechanisms];
    shown.push(`mechanisms: ${formatShellInline([...form.mechanisms])}`);
  }
  if (Object.keys(update).length > 0) {
    ops.push({
      command: `${databaseReference(db)}.updateUser(${quoteShellString(user)}, { ${shown.join(', ')} })`,
      run: (host, sessionId) =>
        host.mongo.users.update({ sessionId, db, user, spec: update, confirmed: true }),
    });
  }
  const granted = roles.filter((r) => !original.roles.some((o) => sameRef(o, r)));
  const revoked = original.roles.filter((o) => !roles.some((r) => sameRef(o, r)));
  if (granted.length > 0) {
    ops.push({
      command: `${databaseReference(db)}.grantRolesToUser(${quoteShellString(user)}, ${roleRefText(granted)})`,
      run: (host, sessionId) =>
        host.mongo.users.grantRoles({ sessionId, db, user, roles: granted, confirmed: true }),
    });
  }
  if (revoked.length > 0) {
    const refs = revoked.map((r) => ({ role: r.role, db: r.db }));
    ops.push({
      command: `${databaseReference(db)}.revokeRolesFromUser(${quoteShellString(user)}, ${roleRefText(refs)})`,
      run: (host, sessionId) =>
        host.mongo.users.revokeRoles({ sessionId, db, user, roles: refs, confirmed: true }),
    });
  }
  return { ok: true, value: ops };
}

export function dropUserCommand(db: string, user: string): string {
  return `${databaseReference(db)}.dropUser(${quoteShellString(user)})`;
}

// ---------------------------------------------------------------------------------------------
// Roles

export type ResourceKind = 'collection' | 'database' | 'cluster' | 'any';

export interface PrivilegeDraft {
  readonly resource: ResourceKind;
  readonly db: string;
  readonly collection: string;
  /** Comma-separated action names. */
  readonly actions: string;
}

export interface RoleForm {
  readonly mode: 'create' | 'edit';
  readonly role: string;
  readonly privileges: readonly PrivilegeDraft[];
  readonly roles: readonly RoleRef[];
}

export function newRoleForm(db: string): RoleForm {
  return {
    mode: 'create',
    role: '',
    privileges: [{ resource: 'database', db, collection: '', actions: 'find' }],
    roles: [],
  };
}

/** A privilege as the form edits it. */
export function privilegeDraft(privilege: Privilege): PrivilegeDraft {
  const actions = privilege.actions.join(', ');
  const resource = privilege.resource;
  if ('cluster' in resource) return { resource: 'cluster', db: '', collection: '', actions };
  if ('anyResource' in resource) return { resource: 'any', db: '', collection: '', actions };
  return {
    resource: resource.collection === '' ? 'database' : 'collection',
    db: resource.db,
    collection: resource.collection,
    actions,
  };
}

export function editRoleForm(info: RoleInfo): RoleForm {
  return {
    mode: 'edit',
    role: info.role,
    privileges: (info.privileges ?? []).map(privilegeDraft),
    roles: info.roles.map((r) => ({ role: r.role, db: r.db })),
  };
}

function cleanPrivileges(
  drafts: readonly PrivilegeDraft[],
  issues: Record<string, string>,
): Privilege[] {
  const out: Privilege[] = [];
  drafts.forEach((draft, i) => {
    const actions = draft.actions
      .split(/[\s,]+/)
      .map((a) => a.trim())
      .filter((a) => a !== '');
    if (actions.length === 0) {
      issues['privileges'] = `Privilege ${i + 1} has no actions`;
      return;
    }
    const unique = [...new Set(actions)];
    switch (draft.resource) {
      case 'cluster':
        out.push({ resource: { cluster: true }, actions: unique });
        return;
      case 'any':
        out.push({ resource: { anyResource: true }, actions: unique });
        return;
      case 'database':
        out.push({ resource: { db: draft.db.trim(), collection: '' }, actions: unique });
        return;
      case 'collection':
        if (draft.collection.trim() === '') {
          issues['privileges'] = `Privilege ${i + 1} names no collection`;
          return;
        }
        out.push({
          resource: { db: draft.db.trim(), collection: draft.collection.trim() },
          actions: unique,
        });
    }
  });
  return out;
}

function privilegesText(privileges: readonly Privilege[]): string {
  return formatShellInline(
    privileges.map((p) => ({ resource: { ...p.resource }, actions: [...p.actions] })),
  );
}

/** Checks a role form: the role's spec and its `createRole` / `updateRole` command. */
export function buildRole(db: string, form: RoleForm): Built<{ spec: RoleSpec; command: string }> {
  const issues: Record<string, string> = {};
  const role = form.role.trim();
  if (role === '') issues['role'] = 'Name the role';
  else if (form.mode === 'create' && (BUILTIN_ROLES as readonly string[]).includes(role)) {
    issues['role'] = `${role} is a built-in role`;
  }
  const privileges = cleanPrivileges(form.privileges, issues);
  const roles = cleanRoles(form.roles, issues);
  if (roles.some((r) => r.role === role && r.db === db))
    issues['roles'] = 'A role cannot inherit itself';
  if (Object.keys(issues).length > 0) return { ok: false, issues };
  const body = `privileges: ${privilegesText(privileges)}, roles: ${roleRefText(roles)}`;
  const command =
    form.mode === 'create'
      ? `${databaseReference(db)}.createRole({ role: ${quoteShellString(role)}, ${body} })`
      : `${databaseReference(db)}.updateRole(${quoteShellString(role)}, { ${body} })`;
  return { ok: true, value: { spec: { role, privileges, roles }, command } };
}

export function dropRoleCommand(db: string, role: string): string {
  return `${databaseReference(db)}.dropRole(${quoteShellString(role)})`;
}

/** A privilege's resource as the lists show it. */
export function resourceText(privilege: Privilege): string {
  const resource = privilege.resource;
  if ('cluster' in resource) return 'cluster';
  if ('anyResource' in resource) return 'any resource';
  if (resource.db === '' && resource.collection === '') return 'every database';
  if (resource.collection === '') return `${resource.db} (every collection)`;
  return `${resource.db === '' ? '*' : resource.db}.${resource.collection}`;
}

// ---------------------------------------------------------------------------------------------
// The panel's state

export interface UsersRolesTarget {
  readonly profileId: string;
  readonly db: string;
  readonly tab: 'users' | 'roles';
  /** A user or role to select once loaded. */
  readonly select?: string;
}

export interface UsersRolesState {
  readonly tab: 'users' | 'roles';
  readonly users: readonly UserInfo[];
  readonly roles: readonly RoleInfo[];
  readonly showBuiltinRoles: boolean;
  readonly loading: boolean;
  readonly error: string | undefined;
  readonly selectedUser: string | undefined;
  /** The selected user with inherited roles and privileges (read for that user alone). */
  readonly userDetail: UserInfo | undefined;
  readonly selectedRole: string | undefined;
  readonly userForm: UserForm | undefined;
  readonly roleForm: RoleForm | undefined;
  readonly saving: boolean;
  readonly formError: string | undefined;
  readonly notice: Notice | undefined;
  readonly rules: WriteRules;
}

export class UsersRoles {
  readonly id: string;
  readonly target: UsersRolesTarget;
  readonly store: StoreApi<UsersRolesState>;
  readonly #lane: SessionLane;

  constructor(id: string, target: UsersRolesTarget) {
    this.id = id;
    this.target = target;
    this.store = createStore<UsersRolesState>()(() => ({
      tab: target.tab,
      users: [],
      roles: [],
      showBuiltinRoles: false,
      loading: false,
      error: undefined,
      selectedUser: target.tab === 'users' ? target.select : undefined,
      userDetail: undefined,
      selectedRole: target.tab === 'roles' ? target.select : undefined,
      userForm: undefined,
      roleForm: undefined,
      saving: false,
      formError: undefined,
      notice: undefined,
      rules: DEFAULT_WRITE_RULES,
    }));
    this.#lane = new SessionLane(target.profileId, target.db);
  }

  get state(): UsersRolesState {
    return this.store.getState();
  }

  get db(): string {
    return this.target.db;
  }

  #set(patch: Partial<UsersRolesState>): void {
    this.store.setState(patch);
  }

  async init(): Promise<void> {
    this.#set({ rules: await loadWriteRules(this.target.profileId) });
    await this.load();
  }

  /** Reads the users and roles with their privileges. */
  async load(): Promise<void> {
    this.#set({ loading: true, error: undefined });
    try {
      // The server shows a user's privileges only when asked for that one user.
      const { users, roles } = await this.#lane.run(async (host, sessionId) => ({
        users: await host.mongo.users.list({ sessionId, db: this.db }),
        roles: await host.mongo.roles.list({
          sessionId,
          db: this.db,
          showPrivileges: true,
          showBuiltinRoles: this.state.showBuiltinRoles,
        }),
      }));
      const sort = <T extends { user?: string; role?: string }>(items: T[]): T[] =>
        items.sort((a, b) => (a.user ?? a.role ?? '').localeCompare(b.user ?? b.role ?? ''));
      this.#set({ users: sort([...users]), roles: sort([...roles]), loading: false });
    } catch (error) {
      this.#set({ loading: false, error: errorMessage(error) });
    }
    await this.#loadUserDetail();
  }

  /** The selected user with its inherited roles and privileges. */
  async #loadUserDetail(): Promise<void> {
    const user = this.state.selectedUser;
    if (user === undefined || !this.state.users.some((u) => u.user === user)) {
      this.#set({ userDetail: undefined });
      return;
    }
    try {
      const [detail] = await this.#lane.run((host, sessionId) =>
        host.mongo.users.list({ sessionId, db: this.db, user, showPrivileges: true }),
      );
      if (this.state.selectedUser === user) this.#set({ userDetail: detail });
    } catch (error) {
      this.#set({ notice: { kind: 'error', text: errorMessage(error) } });
    }
  }

  setTab(tab: 'users' | 'roles'): void {
    this.#set({ tab });
  }

  async setShowBuiltinRoles(show: boolean): Promise<void> {
    this.#set({ showBuiltinRoles: show });
    await this.load();
  }

  selectUser(user: string | undefined): void {
    if (user === this.state.selectedUser && this.state.userDetail?.user === user) return;
    this.#set({ selectedUser: user, userDetail: undefined });
    void this.#loadUserDetail();
  }

  selectRole(role: string | undefined): void {
    this.#set({ selectedRole: role });
  }

  dismissNotice(): void {
    this.#set({ notice: undefined });
  }

  #refuse(): boolean {
    if (!this.state.rules.readOnlyProfile) return false;
    this.#set({ notice: { kind: 'error', text: READ_ONLY_TEXT } });
    return true;
  }

  /** Roles the pickers offer: built-in ones, then this database's custom roles. */
  roleChoices(): string[] {
    const custom = this.state.roles.filter((r) => !r.isBuiltin).map((r) => r.role);
    return [...new Set([...BUILTIN_ROLES, ...custom])];
  }

  // -------------------------------------------------------------------------------------------
  // User forms

  openUserForm(user?: string): void {
    if (this.#refuse()) return;
    const info = user === undefined ? undefined : this.state.users.find((u) => u.user === user);
    this.#set({
      userForm: info ? editUserForm(info) : newUserForm(this.db),
      formError: undefined,
    });
  }

  updateUserForm(patch: Partial<UserForm>): void {
    const form = this.state.userForm;
    if (form) this.#set({ userForm: { ...form, ...patch }, formError: undefined });
  }

  closeForms(): void {
    // The typed password goes with the form.
    this.#set({ userForm: undefined, roleForm: undefined, formError: undefined, saving: false });
  }

  /** The commands the open user form would run (no password in them). */
  userPlan(): Built<UserOperation[]> | undefined {
    const form = this.state.userForm;
    if (!form) return undefined;
    if (form.mode === 'create') {
      const built = buildCreateUser(this.db, form);
      if (!built.ok) return built;
      const { spec, command } = built.value;
      return {
        ok: true,
        value: [
          {
            command,
            run: (host, sessionId) =>
              host.mongo.users.create({ sessionId, db: this.db, spec, confirmed: true }),
          },
        ],
      };
    }
    const original = this.state.users.find((u) => u.user === form.user);
    if (!original) return { ok: false, issues: { user: 'The user is gone' } };
    return buildUserChanges(this.db, original, form);
  }

  async #runOperations(
    title: string,
    ops: readonly UserOperation[],
    done: string,
    folder: 'users' | 'roles',
  ): Promise<boolean> {
    if (ops.length === 0) {
      this.#set({ formError: 'Nothing changed' });
      return false;
    }
    const ok = await confirmMongoWrite(this.state.rules, {
      title,
      command: ops.map((op) => op.command).join('\n'),
      always: true,
      confirmLabel: 'Run',
    });
    if (!ok) return false;
    this.#set({ saving: true, formError: undefined });
    try {
      for (const op of ops) await this.#lane.run(op.run);
      this.closeForms();
      this.#set({ notice: { kind: 'success', text: done } });
      await this.load();
      await loadChildren(this.target.profileId, [this.db, folder]).catch(() => undefined);
      return true;
    } catch (error) {
      this.#set({ saving: false, formError: errorMessage(error) });
      await this.load();
      return false;
    }
  }

  async saveUser(): Promise<boolean> {
    const form = this.state.userForm;
    const plan = this.userPlan();
    if (!form || !plan || !plan.ok || this.#refuse()) return false;
    const name = form.user.trim();
    const saved = await this.#runOperations(
      form.mode === 'create'
        ? `Create the user ${name}@${this.db}?`
        : `Change the user ${name}@${this.db}?`,
      plan.value,
      form.mode === 'create' ? `User ${name} created` : `User ${name} changed`,
      'users',
    );
    if (saved) this.selectUser(name);
    return saved;
  }

  async dropUser(user: string): Promise<boolean> {
    if (this.#refuse()) return false;
    const ok = await confirmMongoWrite(this.state.rules, {
      title: `Drop the user ${user}@${this.db}?`,
      command: dropUserCommand(this.db, user),
      destructive: true,
      confirmLabel: 'Drop',
    });
    if (!ok) return false;
    try {
      await this.#lane.run((host, sessionId) =>
        host.mongo.users.drop({ sessionId, db: this.db, user, confirmed: true }),
      );
      this.#set({
        notice: { kind: 'success', text: `User ${user} dropped` },
        ...(this.state.selectedUser === user ? { selectedUser: undefined } : {}),
      });
      await this.load();
      await loadChildren(this.target.profileId, [this.db, 'users']).catch(() => undefined);
      return true;
    } catch (error) {
      this.#set({ notice: { kind: 'error', text: errorMessage(error) } });
      return false;
    }
  }

  // -------------------------------------------------------------------------------------------
  // Role forms

  openRoleForm(role?: string): void {
    if (this.#refuse()) return;
    const info = role === undefined ? undefined : this.state.roles.find((r) => r.role === role);
    if (info?.isBuiltin) return;
    this.#set({ roleForm: info ? editRoleForm(info) : newRoleForm(this.db), formError: undefined });
  }

  updateRoleForm(patch: Partial<RoleForm>): void {
    const form = this.state.roleForm;
    if (form) this.#set({ roleForm: { ...form, ...patch }, formError: undefined });
  }

  rolePlan(): Built<{ spec: RoleSpec; command: string }> | undefined {
    const form = this.state.roleForm;
    return form ? buildRole(this.db, form) : undefined;
  }

  async saveRole(): Promise<boolean> {
    const form = this.state.roleForm;
    const plan = this.rolePlan();
    if (!form || !plan || !plan.ok || this.#refuse()) return false;
    const { spec, command } = plan.value;
    const op: UserOperation =
      form.mode === 'create'
        ? {
            command,
            run: (host, sessionId) =>
              host.mongo.roles.create({ sessionId, db: this.db, spec, confirmed: true }),
          }
        : {
            command,
            run: (host, sessionId) =>
              host.mongo.roles.update({
                sessionId,
                db: this.db,
                role: spec.role,
                spec: { privileges: [...spec.privileges], roles: [...spec.roles] },
                confirmed: true,
              }),
          };
    const saved = await this.#runOperations(
      form.mode === 'create'
        ? `Create the role ${spec.role}@${this.db}?`
        : `Change the role ${spec.role}@${this.db}?`,
      [op],
      form.mode === 'create' ? `Role ${spec.role} created` : `Role ${spec.role} changed`,
      'roles',
    );
    if (saved) this.#set({ selectedRole: spec.role });
    return saved;
  }

  async dropRole(role: string): Promise<boolean> {
    if (this.#refuse()) return false;
    const ok = await confirmMongoWrite(this.state.rules, {
      title: `Drop the role ${role}@${this.db}?`,
      command: dropRoleCommand(this.db, role),
      destructive: true,
      confirmLabel: 'Drop',
    });
    if (!ok) return false;
    try {
      await this.#lane.run((host, sessionId) =>
        host.mongo.roles.drop({ sessionId, db: this.db, role, confirmed: true }),
      );
      this.#set({
        notice: { kind: 'success', text: `Role ${role} dropped` },
        ...(this.state.selectedRole === role ? { selectedRole: undefined } : {}),
      });
      await this.load();
      await loadChildren(this.target.profileId, [this.db, 'roles']).catch(() => undefined);
      return true;
    } catch (error) {
      this.#set({ notice: { kind: 'error', text: errorMessage(error) } });
      return false;
    }
  }

  async dispose(): Promise<void> {
    this.closeForms();
    await this.#lane.close();
  }
}

export function useUsersRoles<T>(panel: UsersRoles, selector: (state: UsersRolesState) => T): T {
  return useStore(panel.store, selector);
}
