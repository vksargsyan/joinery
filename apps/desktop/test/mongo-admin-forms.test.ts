import {
  formatShellInline,
  fromEjson,
  toEjson,
  type CollectionInfo,
  type UserInfo,
} from '@querybara/mongo-tools';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  CollectionOptions,
  EMPTY_COLLECTION_FORM,
  buildCreateCollection,
  buildCreateView,
  buildExpiryChange,
  buildValidationChange,
  collectionNameIssue,
  dropCollectionCommand,
  renameCommand,
  supportsClustered,
  validationFormOf,
  type CreateCollectionForm,
} from '../src/renderer/src/state/mongo/collection-options';
import {
  closeMongoDialog,
  openCreateCollection,
  openCreateView,
  submitMongoDialog,
  updateCollectionForm,
  updateViewForm,
  useMongoDialogs,
  viewStages,
} from '../src/renderer/src/state/mongo/create-dialogs';
import type { PipelineStage } from '../src/renderer/src/state/mongo/stage-list';
import {
  UsersRoles,
  buildCreateUser,
  buildRole,
  buildUserChanges,
  editRoleForm,
  editUserForm,
  newRoleForm,
  newUserForm,
  privilegeDraft,
  resourceText,
} from '../src/renderer/src/state/mongo/users';
import {
  PROFILE_ID,
  answerConfirms,
  connectHost,
  disconnectAll,
  recorder,
} from './mongo-tool-fixtures';

/** Collection options, create dialogs and the users and roles editor (spec §9): forms to commands. */

const ns = { db: 'shop', collection: 'orders' };

function collection(patch: Partial<CreateCollectionForm>) {
  return buildCreateCollection('shop', { ...EMPTY_COLLECTION_FORM, name: 'events', ...patch });
}

describe('create collection form', () => {
  it('builds plain, capped, time series and clustered collections with their commands', () => {
    expect(collection({})).toEqual({
      ok: true,
      plan: {
        name: 'events',
        spec: {},
        command: "db.getSiblingDB('shop').createCollection('events')",
      },
    });
    const capped = collection({ kind: 'capped', cappedSize: '4096', cappedMax: '100' });
    expect(capped).toMatchObject({
      ok: true,
      plan: {
        spec: { capped: { size: 4096, max: 100 } },
        command:
          "db.getSiblingDB('shop').createCollection('events', { capped: true, size: 4096, max: 100 })",
      },
    });
    const series = collection({
      kind: 'timeseries',
      timeField: 'at',
      metaField: 'sensor',
      granularity: 'minutes',
      expireAfterSeconds: '86400',
    });
    expect(series).toMatchObject({
      ok: true,
      plan: {
        spec: {
          timeseries: { timeField: 'at', metaField: 'sensor', granularity: 'minutes' },
          expireAfterSeconds: 86400,
        },
        command:
          "db.getSiblingDB('shop').createCollection('events', { timeseries: { timeField: 'at', metaField: 'sensor', granularity: 'minutes' }, expireAfterSeconds: 86400 })",
      },
    });
    const clustered = collection({ kind: 'clustered', expireAfterSeconds: '60' });
    expect(clustered.ok && clustered.plan.command).toBe(
      "db.getSiblingDB('shop').createCollection('events', { expireAfterSeconds: 60, clusteredIndex: { key: { _id: 1 }, unique: true } })",
    );
    const validated = collection({
      collation: "{ locale: 'fr' }",
      validator: '{ total: { $gte: 0 } }',
      validationLevel: 'moderate',
      validationAction: 'warn',
    });
    expect(validated.ok && formatShellInline(fromEjson(validated.plan.spec.validator!))).toBe(
      '{ total: { $gte: 0 } }',
    );
    expect(validated.ok && validated.plan.command).toBe(
      "db.getSiblingDB('shop').createCollection('events', { collation: { locale: 'fr' }, validator: { total: { $gte: 0 } }, validationLevel: 'moderate', validationAction: 'warn' })",
    );
  });

  it('refuses names and options the server would', () => {
    expect(collectionNameIssue('')).toBe('Name the collection');
    expect(collectionNameIssue('a$b')).toMatch(/\$/);
    expect(collectionNameIssue('system.x')).toMatch(/reserved/);
    const issues = (patch: Partial<CreateCollectionForm>) => {
      const built = collection(patch);
      return built.ok ? {} : built.issues;
    };
    expect(issues({ kind: 'capped', cappedSize: '0' })['cappedSize']).toMatch(/at least 1/);
    expect(issues({ kind: 'capped', cappedMax: 'x' })['cappedMax']).toMatch(/whole number/);
    expect(issues({ kind: 'timeseries', timeField: '' })['timeField']).toBeDefined();
    expect(
      issues({ kind: 'timeseries', timeField: 'at', metaField: 'at' })['metaField'],
    ).toBeDefined();
    expect(issues({ expireAfterSeconds: '5' })['expireAfterSeconds']).toMatch(
      /time series and clustered/,
    );
    expect(issues({ kind: 'timeseries', validator: '{ a: 1 }' })['validator']).toMatch(
      /no validator/,
    );
    expect(issues({ collation: '{ strength: 1 }' })['collation']).toMatch(/locale/);
    expect(supportsClustered('5.3.0')).toBe(true);
    expect(supportsClustered('5.0.9')).toBe(false);
    expect(supportsClustered('8.0.4')).toBe(true);
  });
});

function stage(operator: string, body: string, enabled = true): PipelineStage {
  return { id: operator, operator, body, enabled };
}

describe('create view form', () => {
  it('builds the view from the stage cards, leaving disabled stages out', () => {
    const built = buildCreateView('shop', {
      name: 'open_orders',
      source: 'orders',
      stages: [stage('$match', "{ status: 'open' }"), stage('$sort', '{ at: -1 }', false)],
      collation: '',
    });
    expect(built).toMatchObject({
      ok: true,
      plan: {
        command:
          "db.getSiblingDB('shop').createView('open_orders', 'orders', [ { $match: { status: 'open' } } ])",
        spec: { viewOn: 'orders' },
      },
    });
    const bad = buildCreateView('shop', {
      name: 'v',
      source: 'v',
      stages: [stage('$out', "'x'")],
      collation: '',
    });
    expect(bad.ok ? {} : bad.issues).toMatchObject({
      source: 'A view cannot read itself',
      stages: 'A view cannot write ($out, $merge)',
    });
  });
});

describe('collection options', () => {
  const info: CollectionInfo = {
    name: 'orders',
    type: 'collection',
    options: '{}',
    readOnly: false,
    capped: false,
    clustered: false,
    validator: toEjson({ total: { $gte: 0 } }),
    validationLevel: 'strict',
    validationAction: 'error',
  };

  it('turns validation edits into one collMod with only what changed', () => {
    const current = validationFormOf(info);
    expect(current).toEqual({
      validator: '{ total: { $gte: 0 } }',
      validationLevel: 'strict',
      validationAction: 'error',
    });
    expect(buildValidationChange(ns, current, current)).toBeUndefined();
    expect(
      buildValidationChange(ns, current, { ...current, validationAction: 'warn' }),
    ).toMatchObject({
      ok: true,
      plan: {
        spec: { validationAction: 'warn' },
        command:
          "db.getSiblingDB('shop').runCommand({ collMod: 'orders', validationAction: 'warn' })",
      },
    });
    const removed = buildValidationChange(ns, current, { ...current, validator: '' });
    expect(removed).toMatchObject({ ok: true, plan: { spec: { validator: '{}' } } });
    expect(buildValidationChange(ns, current, { ...current, validator: '{ a: }' })).toMatchObject({
      ok: false,
    });
    expect(buildExpiryChange(ns, '')).toMatchObject({
      ok: true,
      plan: { spec: { expireAfterSeconds: 'off' } },
    });
    expect(buildExpiryChange(ns, '3600')).toMatchObject({
      ok: true,
      plan: {
        command:
          "db.getSiblingDB('shop').runCommand({ collMod: 'orders', expireAfterSeconds: 3600 })",
      },
    });
    expect(buildExpiryChange(ns, '-1')).toMatchObject({ ok: false });
    expect(renameCommand(ns, 'archive', true)).toBe(
      "db.getSiblingDB('shop').orders.renameCollection('archive', true)",
    );
    expect(dropCollectionCommand(ns)).toBe("db.getSiblingDB('shop').orders.drop()");
  });

  it('applies changes after showing the command, renames and drops', async () => {
    const confirms = answerConfirms();
    const rec = recorder();
    let current = info;
    connectHost({
      openSession: async () => ({ sessionId: 's1' }),
      closeSession: async () => undefined,
      browse: async () => [],
      mongo: {
        collections: {
          info: async () => current,
          collMod: async (input: { changes: { validationLevel?: 'moderate' } }) => {
            rec.record('collMod', input);
            current = { ...current, ...input.changes };
          },
          rename: async (input: object) => rec.record('rename', input),
          drop: async (input: object) => rec.record('drop', input),
        },
      },
    });
    try {
      const panel = new CollectionOptions('opt', { profileId: PROFILE_ID, ...ns });
      await panel.init();
      panel.setValidation({ validationLevel: 'moderate' });
      expect(await panel.saveValidation()).toBe(true);
      expect(confirms.asked[0]).toMatchObject({
        detail:
          "db.getSiblingDB('shop').runCommand({ collMod: 'orders', validationLevel: 'moderate' })",
      });
      expect(rec.of('collMod')[0]!.input).toMatchObject({ confirmed: true });
      expect(panel.validationChange()).toBeUndefined();
      panel.setRename('archive');
      expect(await panel.rename()).toBe(true);
      expect(rec.of('rename')[0]!.input).toMatchObject({ to: 'archive', dropTarget: false });
      expect(panel.target.collection).toBe('archive');
      confirms.answer(false);
      expect(await panel.drop()).toBe(false);
      expect(confirms.asked.at(-1)?.detail).toBe("db.getSiblingDB('shop').archive.drop()");
      confirms.answer(true);
      expect(await panel.drop()).toBe(true);
      expect(panel.state.gone).toBe(true);
      await panel.dispose();
    } finally {
      confirms.stop();
      disconnectAll();
    }
  });
});

describe('create dialogs', () => {
  let confirms: ReturnType<typeof answerConfirms>;
  beforeEach(() => {
    confirms = answerConfirms();
  });
  afterEach(() => {
    closeMongoDialog();
    confirms.stop();
    disconnectAll();
  });

  function dialogHost() {
    const rec = recorder();
    connectHost({
      openSession: async () => ({ sessionId: 's1' }),
      closeSession: async () => undefined,
      browse: async (input: { path: string[] }) =>
        input.path[1] === 'collections'
          ? [{ kind: 'collection', name: 'orders', path: [], hasChildren: false }]
          : [],
      mongo: {
        serverInfo: async () => ({
          version: '5.0.1',
          topology: 'replicaSet',
          members: [],
          modules: [],
        }),
        collections: {
          create: async (input: object) => rec.record('create', input),
          createView: async (input: object) => rec.record('createView', input),
        },
      },
    });
    return rec;
  }

  it('creates a capped collection after confirming its command', async () => {
    const rec = dialogHost();
    openCreateCollection(PROFILE_ID, 'shop', 'capped');
    await expect
      .poll(() => {
        const d = useMongoDialogs.getState().dialog;
        return d?.kind === 'create-collection' ? d.clusteredSupported : 'none';
      })
      .toBe(false);
    updateCollectionForm({ name: 'log', cappedSize: '8192' });
    expect(await submitMongoDialog()).toBe(true);
    expect(confirms.asked[0]).toMatchObject({
      title: 'Create the collection shop.log?',
      detail: "db.getSiblingDB('shop').createCollection('log', { capped: true, size: 8192 })",
    });
    expect(rec.of('create')[0]!.input).toMatchObject({
      ns: { db: 'shop', collection: 'log' },
      spec: { capped: { size: 8192 } },
      confirmed: true,
    });
    expect(useMongoDialogs.getState().dialog).toBeUndefined();
  });

  it('creates a view from its source and stages', async () => {
    const rec = dialogHost();
    openCreateView(PROFILE_ID, 'shop', 'orders');
    await expect
      .poll(() => {
        const d = useMongoDialogs.getState().dialog;
        return d?.kind === 'create-view' ? d.sources : [];
      })
      .toEqual(['orders']);
    updateViewForm({ name: 'recent' });
    const first = useMongoDialogs.getState().dialog;
    if (first?.kind !== 'create-view') throw new Error('no dialog');
    viewStages.setOperator(first.form.stages[0]!.id, '$sort');
    viewStages.setBody(first.form.stages[0]!.id, '{ at: -1 }');
    viewStages.add(0);
    const added = useMongoDialogs.getState().dialog;
    if (added?.kind !== 'create-view') throw new Error('no dialog');
    // A new card holds its operator's skeleton, which needs filling in.
    expect(await submitMongoDialog()).toBe(false);
    viewStages.setBody(added.form.stages[1]!.id, "{ status: 'open' }");
    expect(await submitMongoDialog()).toBe(true);
    expect(confirms.asked[0]!.detail).toBe(
      "db.getSiblingDB('shop').createView('recent', 'orders', [ { $sort: { at: -1 } }, { $match: { status: 'open' } } ])",
    );
    expect(rec.of('createView')[0]!.input).toMatchObject({
      ns: { db: 'shop', collection: 'recent' },
      viewOn: 'orders',
      confirmed: true,
    });
  });
});

describe('users and roles forms', () => {
  it('creates a user without ever showing the password', () => {
    const form = { ...newUserForm('shop'), user: 'ada', password: 's3cret!' };
    const built = buildCreateUser('shop', form);
    expect(built).toMatchObject({
      ok: true,
      value: {
        spec: {
          user: 'ada',
          password: 's3cret!',
          roles: [{ role: 'read', db: 'shop' }],
          mechanisms: ['SCRAM-SHA-256'],
        },
        command:
          "db.getSiblingDB('shop').createUser({ user: 'ada', pwd: passwordPrompt(), roles: [ { role: 'read', db: 'shop' } ], mechanisms: [ 'SCRAM-SHA-256' ] })",
      },
    });
    expect(built.ok && built.value.command).not.toContain('s3cret');
    expect(buildCreateUser('shop', { ...form, password: '' })).toMatchObject({
      ok: false,
      issues: { password: 'Type a password' },
    });
    expect(buildCreateUser('shop', { ...form, roles: [{ role: 'read', db: '' }] })).toMatchObject({
      ok: false,
      issues: { roles: expect.any(String) },
    });
    expect(buildCreateUser('$external', { ...form, password: '', mechanisms: [] })).toMatchObject({
      ok: true,
      value: { spec: { user: 'ada', roles: [{ role: 'read', db: 'shop' }] } },
    });
  });

  it('turns user edits into updateUser, grant and revoke commands', () => {
    const original: UserInfo = {
      user: 'ada',
      db: 'shop',
      roles: [
        { role: 'read', db: 'shop' },
        { role: 'dbAdmin', db: 'shop' },
      ],
      mechanisms: ['SCRAM-SHA-256'],
    };
    const form = editUserForm(original);
    expect(form.password).toBe('');
    expect(buildUserChanges('shop', original, form)).toEqual({ ok: true, value: [] });
    const changed = buildUserChanges('shop', original, {
      ...form,
      password: 'new-one',
      customData: '{ team: "ops" }',
      roles: [
        { role: 'read', db: 'shop' },
        { role: 'readWrite', db: 'shop' },
      ],
    });
    expect(changed.ok && changed.value.map((op) => op.command)).toEqual([
      "db.getSiblingDB('shop').updateUser('ada', { pwd: passwordPrompt(), customData: { team: 'ops' } })",
      "db.getSiblingDB('shop').grantRolesToUser('ada', [ { role: 'readWrite', db: 'shop' } ])",
      "db.getSiblingDB('shop').revokeRolesFromUser('ada', [ { role: 'dbAdmin', db: 'shop' } ])",
    ]);
    expect(
      buildUserChanges('shop', original, { ...form, mechanisms: ['SCRAM-SHA-1'] }),
    ).toMatchObject({ ok: false, issues: { password: expect.any(String) } });
  });

  it('builds custom roles with privileges and inherited roles', () => {
    const form = {
      ...newRoleForm('shop'),
      role: 'reporting',
      privileges: [
        {
          resource: 'collection' as const,
          db: 'shop',
          collection: 'orders',
          actions: 'find, find, collStats',
        },
        { resource: 'cluster' as const, db: '', collection: '', actions: 'serverStatus' },
      ],
      roles: [{ role: 'read', db: 'shop' }],
    };
    const built = buildRole('shop', form);
    expect(built).toMatchObject({
      ok: true,
      value: {
        spec: {
          role: 'reporting',
          privileges: [
            { resource: { db: 'shop', collection: 'orders' }, actions: ['find', 'collStats'] },
            { resource: { cluster: true }, actions: ['serverStatus'] },
          ],
          roles: [{ role: 'read', db: 'shop' }],
        },
        command:
          "db.getSiblingDB('shop').createRole({ role: 'reporting', privileges: [ { resource: { db: 'shop', collection: 'orders' }, actions: [ 'find', 'collStats' ] }, { resource: { cluster: true }, actions: [ 'serverStatus' ] } ], roles: [ { role: 'read', db: 'shop' } ] })",
      },
    });
    const edit = editRoleForm({
      role: 'reporting',
      db: 'shop',
      isBuiltin: false,
      roles: [],
      privileges: [{ resource: { db: 'shop', collection: '' }, actions: ['find'] }],
    });
    expect(edit.privileges).toEqual([
      { resource: 'database', db: 'shop', collection: '', actions: 'find' },
    ]);
    expect(buildRole('shop', edit)).toMatchObject({
      ok: true,
      value: {
        command:
          "db.getSiblingDB('shop').updateRole('reporting', { privileges: [ { resource: { db: 'shop', collection: '' }, actions: [ 'find' ] } ], roles: [] })",
      },
    });
    expect(buildRole('shop', { ...form, role: 'read' })).toMatchObject({
      ok: false,
      issues: { role: 'read is a built-in role' },
    });
    expect(
      buildRole('shop', { ...form, privileges: [{ ...form.privileges[0]!, actions: ' ' }] }),
    ).toMatchObject({ ok: false, issues: { privileges: 'Privilege 1 has no actions' } });
    expect(
      privilegeDraft({ resource: { anyResource: true }, actions: ['anyAction'] }),
    ).toMatchObject({
      resource: 'any',
    });
    expect(resourceText({ resource: { db: 'shop', collection: 'orders' }, actions: [] })).toBe(
      'shop.orders',
    );
    expect(resourceText({ resource: { db: '', collection: '' }, actions: [] })).toBe(
      'every database',
    );
  });

  it('runs a user’s changes in order after one confirmation, then drops it', async () => {
    const confirms = answerConfirms();
    const rec = recorder();
    let users: UserInfo[] = [
      {
        user: 'ada',
        db: 'shop',
        roles: [{ role: 'read', db: 'shop' }],
        mechanisms: ['SCRAM-SHA-256'],
      },
    ];
    connectHost({
      openSession: async () => ({ sessionId: 's1' }),
      closeSession: async () => undefined,
      browse: async () => [],
      mongo: {
        users: {
          list: async (input: { user?: string; showPrivileges?: boolean }) => {
            if (input.showPrivileges && input.user === undefined) {
              throw new Error(
                'Privilege or restriction details require exact-match usersInfo queries',
              );
            }
            return input.user === undefined
              ? users
              : users
                  .filter((u) => u.user === input.user)
                  .map((u) => ({
                    ...u,
                    inheritedPrivileges: [
                      { resource: { db: 'shop', collection: '' }, actions: ['find'] },
                    ],
                  }));
          },
          create: async (input: object) => rec.record('create', input),
          update: async (input: object) => rec.record('update', input),
          grantRoles: async (input: object) => rec.record('grantRoles', input),
          revokeRoles: async (input: object) => rec.record('revokeRoles', input),
          drop: async (input: { user: string }) => {
            rec.record('drop', input);
            users = users.filter((u) => u.user !== input.user);
          },
        },
        roles: { list: async () => [] },
      },
    });
    try {
      const panel = new UsersRoles('users', {
        profileId: PROFILE_ID,
        db: 'shop',
        tab: 'users',
        select: 'ada',
      });
      await panel.init();
      expect(panel.state.error).toBeUndefined();
      // Privileges are read for the selected user alone.
      expect(panel.state.userDetail?.inheritedPrivileges).toHaveLength(1);
      panel.openUserForm('ada');
      panel.updateUserForm({ roles: [{ role: 'readWrite', db: 'shop' }], password: 'pw' });
      expect(await panel.saveUser()).toBe(true);
      expect(confirms.asked[0]!.detail).toBe(
        [
          "db.getSiblingDB('shop').updateUser('ada', { pwd: passwordPrompt() })",
          "db.getSiblingDB('shop').grantRolesToUser('ada', [ { role: 'readWrite', db: 'shop' } ])",
          "db.getSiblingDB('shop').revokeRolesFromUser('ada', [ { role: 'read', db: 'shop' } ])",
        ].join('\n'),
      );
      expect(rec.calls.map((c) => c.method)).toEqual(['update', 'grantRoles', 'revokeRoles']);
      expect(rec.of('update')[0]!.input).toMatchObject({
        spec: { password: 'pw' },
        confirmed: true,
      });
      // The form (and the typed password) is gone.
      expect(panel.state.userForm).toBeUndefined();
      expect(await panel.dropUser('ada')).toBe(true);
      expect(confirms.asked.at(-1)?.detail).toBe("db.getSiblingDB('shop').dropUser('ada')");
      expect(panel.state.users).toEqual([]);
      await panel.dispose();
    } finally {
      confirms.stop();
      disconnectAll();
    }
  });
});
