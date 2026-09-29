import { randomBytes } from 'node:crypto';

import { MASKED_SECRET, type ServerAction, type Session } from '@joinery/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createPostgresServerTools } from '../../src';
import { PG_URL, collect, connect, rows } from './helpers';

/**
 * PostgreSQL server tools against the real server (spec §15): monitor snapshots, sessions with
 * cancel and terminate (of sessions this test opened), pg_stat_statements' "not installed" and
 * "not loaded" paths, maintenance on a table this test created, roles, grants, default
 * privileges and policies on roles this test creates and drops, and settings changed and
 * restored.
 */

const suffix = randomBytes(4).toString('hex');
const SCHEMA = `st_${suffix}`;
const ROLE = `st_role_${suffix}`;
const USER = `st_user_${suffix}`;
const PASSWORD = `pw-${suffix}-Secret'1`;

describe.skipIf(!PG_URL)('PostgreSQL server tools', () => {
  let session: Session;
  let admin: Session;

  beforeAll(async () => {
    session = await connect();
    admin = await connect();
    await collect(admin, `CREATE SCHEMA ${SCHEMA}`);
    await collect(
      admin,
      `CREATE TABLE ${SCHEMA}.orders (id integer PRIMARY KEY, total numeric, note text)`,
    );
    await collect(
      admin,
      `INSERT INTO ${SCHEMA}.orders SELECT g, g * 1.5, 'n' || g FROM generate_series(1, 500) g`,
    );
    await collect(
      admin,
      `CREATE FUNCTION ${SCHEMA}.total_of(o integer) RETURNS numeric
      LANGUAGE sql AS 'SELECT total FROM ${SCHEMA}.orders WHERE id = o'`,
    );
  });

  afterAll(async () => {
    await collect(admin, `DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`).catch(() => undefined);
    for (const role of [USER, `${USER}_renamed`, ROLE]) {
      await collect(admin, `DROP OWNED BY ${role}`).catch(() => undefined);
      await collect(admin, `DROP ROLE IF EXISTS ${role}`).catch(() => undefined);
    }
    await session?.close();
    await admin?.close();
  });

  it('describes the server and the account', async () => {
    const info = await createPostgresServerTools(session).info();
    expect(info).toMatchObject({ engine: 'postgres', product: 'PostgreSQL' });
    expect(info.databases).toContain(info.database);
    expect(info.sessionActions.map((a) => a.operation)).toEqual(['cancel', 'terminate']);
    expect(info.maintenance.map((m) => m.id)).toEqual(['vacuum', 'analyze', 'reindex', 'cluster']);
  });

  it('takes monitor snapshots whose counters grow', async () => {
    const tools = createPostgresServerTools(session);
    const first = await tools.monitor();
    await rows(admin, `SELECT count(*) FROM ${SCHEMA}.orders`);
    const second = await tools.monitor();
    expect(first.uptimeSeconds).toBeGreaterThan(0);
    const tile = (snapshot: typeof first, id: string) => snapshot.tiles.find((t) => t.id === id);
    expect(tile(first, 'connections')).toMatchObject({ kind: 'gauge' });
    const tps1 = tile(first, 'tps');
    const tps2 = tile(second, 'tps');
    if (tps1?.kind !== 'rate' || tps2?.kind !== 'rate') throw new Error('tps is a rate');
    expect(tps2.counter!).toBeGreaterThanOrEqual(tps1.counter!);
    const ratio = tile(second, 'cache-hit');
    if (ratio?.kind !== 'ratio') throw new Error('cache-hit is a ratio');
    expect(ratio.total!).toBeGreaterThan(0);
    expect(second.sections.map((s) => s.id)).toEqual([
      'databases',
      'replication',
      'slots',
      'lock-waits',
    ]);
    expect(second.sections[0]!.table.rows.length).toBeGreaterThan(0);
  });

  it('lists sessions, cancels a query and terminates a session it opened', async () => {
    const tools = createPostgresServerTools(session);
    const victim = await connect();
    const app = `joinery-st-${suffix}`;
    await collect(victim, `SET application_name = '${app}'`);
    const sleeping = collect(victim, 'SELECT pg_sleep(30)').then(
      () => 'finished',
      (error: unknown) => error,
    );
    let target;
    for (let i = 0; i < 50 && !target; i++) {
      const list = await tools.sessions({ includeIdle: false });
      target = list.sessions.find((s) => s.application === app && s.state === 'active');
      if (!target) await new Promise((r) => setTimeout(r, 100));
    }
    expect(target).toBeDefined();
    expect(target!.query).toContain('pg_sleep');
    expect(target!.durationMs).toBeGreaterThanOrEqual(0);

    const own = (await tools.sessions()).sessions.find((s) => s.own);
    expect(own).toBeDefined();
    await expect(
      tools.run({ kind: 'session', operation: 'terminate', id: own!.id }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });

    const cancel: ServerAction = { kind: 'session', operation: 'cancel', id: target!.id };
    expect((await tools.preview(cancel)).statements).toEqual([
      `SELECT pg_catalog.pg_cancel_backend(${target!.id})`,
    ]);
    await tools.run(cancel);
    expect(await sleeping).toMatchObject({ code: 'CANCELLED' });
    // The session survived the cancel; now end it.
    expect(await rows(victim, 'SELECT 1')).toEqual([[1]]);
    const result = await tools.run({ kind: 'session', operation: 'terminate', id: target!.id });
    expect(result.statements).toEqual([`SELECT pg_catalog.pg_terminate_backend(${target!.id})`]);
    await expect(rows(victim, 'SELECT 1')).rejects.toBeDefined();
    await victim.close();
  });

  it('explains that pg_stat_statements is missing, and that it is not preloaded', async () => {
    const tools = createPostgresServerTools(session);
    const top = await tools.topQueries();
    const preload = String((await rows(admin, 'SHOW shared_preload_libraries'))[0]?.[0] ?? '');
    const installed = (
      await rows(admin, `SELECT 1 FROM pg_extension WHERE extname = 'pg_stat_statements'`)
    ).length;
    if (installed === 0) {
      expect(top.unavailable).toMatchObject({
        reason: 'not-installed',
        fix: { kind: 'topQueries', operation: 'enable' },
      });
    }
    // In a database of its own, create the extension and read it back.
    const db = `st_db_${suffix}`;
    await collect(admin, `CREATE DATABASE ${db}`);
    try {
      const scratch = await connect({ options: { defaultDatabase: db } });
      try {
        const own = createPostgresServerTools(scratch);
        expect((await own.preview({ kind: 'topQueries', operation: 'enable' })).statements).toEqual(
          ['CREATE EXTENSION pg_stat_statements'],
        );
        await own.run({ kind: 'topQueries', operation: 'enable' });
        const after = await own.topQueries({ orderBy: 'calls', limit: 5 });
        if (preload.includes('pg_stat_statements')) {
          expect(after.unavailable).toBeNull();
          expect(after.queries.length).toBeGreaterThan(0);
        } else {
          expect(after.unavailable).toMatchObject({
            reason: 'not-loaded',
            hint: expect.stringContaining('shared_preload_libraries'),
          });
        }
      } finally {
        await scratch.close();
      }
    } finally {
      await collect(admin, `DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
    }
  });

  it('runs VACUUM, ANALYZE, REINDEX and CLUSTER on a table it created', async () => {
    const tools = createPostgresServerTools(session);
    const targets = await tools.maintenanceTargets(SCHEMA);
    expect(targets.containers).toContain(SCHEMA);
    const orders = targets.targets.find((t) => t.name === 'orders');
    expect(orders).toMatchObject({ type: 'table', indexes: ['orders_pkey'] });
    const target = [{ container: SCHEMA, name: 'orders' }];

    const vacuum: ServerAction = {
      kind: 'maintenance',
      operation: 'vacuum',
      targets: target,
      options: ['analyze', 'verbose'],
    };
    expect((await tools.preview(vacuum)).statements).toEqual([
      `VACUUM (VERBOSE, ANALYZE) "${SCHEMA}"."orders"`,
    ]);
    const vacuumed = await tools.run(vacuum);
    expect(vacuumed.messages.some((m) => /vacuuming/i.test(m.message))).toBe(true);

    await tools.run({ kind: 'maintenance', operation: 'analyze', targets: target, options: [] });
    const reindex = await tools.run({
      kind: 'maintenance',
      operation: 'reindex',
      targets: target,
      options: ['concurrently'],
    });
    expect(reindex.statements).toEqual([`REINDEX TABLE CONCURRENTLY "${SCHEMA}"."orders"`]);
    await tools.run({
      kind: 'maintenance',
      operation: 'cluster',
      targets: target,
      options: [],
      index: 'orders_pkey',
    });
    const after = await tools.maintenanceTargets(SCHEMA);
    expect(after.targets.find((t) => t.name === 'orders')?.detail['clusteredOn']).toBe(
      'orders_pkey',
    );
    expect(after.targets.find((t) => t.name === 'orders')?.detail['lastAnalyze']).not.toBeNull();
  });

  it('creates, alters and drops roles and never shows the password', async () => {
    const tools = createPostgresServerTools(session);
    const create: ServerAction = {
      kind: 'createAccount',
      account: { name: USER },
      role: false,
      options: { password: PASSWORD, connectionLimit: 3 },
    };
    const preview = await tools.preview(create);
    expect(preview.statements).toEqual([
      `CREATE ROLE "${USER}" WITH LOGIN CONNECTION LIMIT 3 PASSWORD '${MASKED_SECRET}'`,
    ]);
    expect(JSON.stringify(preview)).not.toContain(PASSWORD);
    const created = await tools.run(create);
    expect(JSON.stringify(created)).not.toContain(PASSWORD);
    // The password really was set.
    expect(
      await rows(admin, `SELECT rolpassword IS NOT NULL FROM pg_authid WHERE rolname = '${USER}'`),
    ).toEqual([[true]]);

    await tools.run({ kind: 'createAccount', account: { name: ROLE }, role: true, options: {} });
    await tools.run({
      kind: 'grantRole',
      role: { name: ROLE },
      member: { name: USER },
      admin: true,
    });
    await tools.run({
      kind: 'alterAccount',
      account: { name: USER },
      options: { createDb: true, validUntil: '2099-01-01 00:00:00+00' },
    });
    const accounts = await tools.accounts();
    const user = accounts.accounts.find((a) => a.name === USER);
    expect(user).toMatchObject({
      kind: 'user',
      canLogin: true,
      connectionLimit: 3,
      attributes: expect.arrayContaining(['CREATEDB']),
      memberOf: [expect.objectContaining({ role: { name: ROLE }, admin: true })],
    });
    expect(user!.validUntil).toMatch(/^2099-01-01/);
    expect(accounts.accounts.find((a) => a.name === ROLE)).toMatchObject({ kind: 'role' });
    expect(accounts.accounts.find((a) => a.name === 'pg_monitor')?.builtin).toBe(true);

    // A duplicate fails with the server's error, still without the password.
    const duplicate = await tools.run(create).catch((e: unknown) => e);
    expect(duplicate).toMatchObject({ code: 'SQL_ERROR' });
    expect(JSON.stringify(duplicate)).not.toContain(PASSWORD);

    await tools.run({ kind: 'revokeRole', role: { name: ROLE }, member: { name: USER } });
    expect((await tools.accounts()).accounts.find((a) => a.name === USER)?.memberOf).toEqual([]);
  });

  it('shows and changes the grants matrix of a role', async () => {
    const tools = createPostgresServerTools(session);
    const before = await tools.grants({ name: ROLE }, SCHEMA);
    expect(before.scopes).toContain(SCHEMA);
    expect(before.privileges.table).toContain('SELECT');
    const orders = (m: typeof before) => m.rows.find((r) => r.label === `${SCHEMA}.orders`);
    expect(orders(before)?.privileges['SELECT']).toBe('none');
    expect(before.rows.find((r) => r.object.kind === 'schema')?.privileges['USAGE']).toBe('none');

    await tools.run({
      kind: 'grant',
      grantee: { name: ROLE },
      object: { kind: 'table', schema: SCHEMA, name: 'orders' },
      privileges: ['SELECT', 'UPDATE'],
      grantOption: true,
    });
    await tools.run({
      kind: 'grant',
      grantee: { name: ROLE },
      object: { kind: 'schema', name: SCHEMA },
      privileges: ['USAGE'],
    });
    const fn = before.rows.find((r) => r.object.kind === 'function');
    expect(fn?.object).toMatchObject({ name: 'total_of', signature: 'o integer' });
    const revokeFn: ServerAction = {
      kind: 'revoke',
      grantee: { name: 'PUBLIC' },
      object: fn!.object,
      privileges: ['EXECUTE'],
    };
    expect((await tools.preview(revokeFn)).statements).toEqual([
      `REVOKE EXECUTE ON ROUTINE ${SCHEMA}.total_of(o integer) FROM PUBLIC`,
    ]);
    const after = await tools.grants({ name: ROLE }, SCHEMA);
    expect(orders(after)?.privileges).toMatchObject({
      SELECT: 'grantable',
      UPDATE: 'grantable',
      DELETE: 'none',
    });
    expect(after.rows.find((r) => r.object.kind === 'schema')?.privileges['USAGE']).toBe('granted');
    // A function's EXECUTE comes from PUBLIC: implied.
    expect(after.rows.find((r) => r.object.kind === 'function')?.privileges['EXECUTE']).toBe(
      'implied',
    );

    await tools.run({
      kind: 'revoke',
      grantee: { name: ROLE },
      object: { kind: 'table', schema: SCHEMA, name: 'orders' },
      privileges: ['UPDATE'],
    });
    expect(orders(await tools.grants({ name: ROLE }, SCHEMA))?.privileges['UPDATE']).toBe('none');
  });

  it('manages default privileges and row-level security policies', async () => {
    const tools = createPostgresServerTools(session);
    const grant: ServerAction = {
      kind: 'defaultPrivileges',
      operation: 'grant',
      schema: SCHEMA,
      objectType: 'tables',
      grantee: ROLE,
      privileges: ['SELECT'],
    };
    expect((await tools.preview(grant)).statements).toEqual([
      `ALTER DEFAULT PRIVILEGES IN SCHEMA "${SCHEMA}" GRANT SELECT ON TABLES TO "${ROLE}"`,
    ]);
    await tools.run(grant);
    let details = await tools.accessDetails(SCHEMA);
    expect(details.defaultPrivileges).toContainEqual(
      expect.objectContaining({
        schema: SCHEMA,
        objectType: 'tables',
        grantee: ROLE,
        privileges: ['SELECT'],
      }),
    );
    await tools.run({ ...grant, operation: 'revoke' });

    await tools.run({ kind: 'rowSecurity', schema: SCHEMA, table: 'orders', enabled: true });
    const policy: ServerAction = {
      kind: 'createPolicy',
      schema: SCHEMA,
      table: 'orders',
      name: 'small orders',
      permissive: true,
      command: 'SELECT',
      roles: [ROLE],
      using: 'total < 100',
    };
    expect((await tools.preview(policy)).statements).toEqual([
      `CREATE POLICY "small orders" ON "${SCHEMA}"."orders" AS PERMISSIVE FOR SELECT TO "${ROLE}" USING (total < 100)`,
    ]);
    await tools.run(policy);
    await expect(
      tools.preview({ ...policy, using: 'true); DROP TABLE x; --' }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    details = await tools.accessDetails(SCHEMA);
    expect(details.tables.find((t) => t.table === 'orders')).toMatchObject({
      enabled: true,
      forced: false,
      policies: [
        {
          name: 'small orders',
          permissive: true,
          command: 'SELECT',
          roles: [ROLE],
          using: '(total < (100)::numeric)',
          withCheck: null,
        },
      ],
    });
    await tools.run({ kind: 'dropPolicy', schema: SCHEMA, table: 'orders', name: 'small orders' });
    await tools.run({ kind: 'rowSecurity', schema: SCHEMA, table: 'orders', enabled: false });
    details = await tools.accessDetails(SCHEMA);
    expect(details.tables.find((t) => t.table === 'orders')).toMatchObject({
      enabled: false,
      policies: [],
    });

    await tools.run({ kind: 'dropAccount', account: { name: USER }, role: false });
    await collect(admin, `DROP OWNED BY ${ROLE}`);
    await tools.run({ kind: 'dropAccount', account: { name: ROLE }, role: true });
    const names = (await tools.accounts()).accounts.map((a) => a.name);
    expect(names).not.toContain(USER);
    expect(names).not.toContain(ROLE);
  });

  it('reads settings, and changes and restores a session and a system setting', async () => {
    const tools = createPostgresServerTools(session);
    const list = await tools.settings();
    const workMem = list.settings.find((s) => s.name === 'work_mem');
    expect(workMem).toMatchObject({
      type: 'integer',
      unit: 'kB',
      scopes: ['session', 'database', 'system'],
      restartRequired: false,
    });
    expect(list.settings.find((s) => s.name === 'shared_buffers')).toMatchObject({
      scopes: ['system'],
      restartRequired: true,
    });
    expect(list.settings.find((s) => s.name === 'server_version')?.scopes).toEqual([]);
    expect(list.settings.find((s) => s.name === 'DateStyle')?.type).toBe('string');

    await tools.run({ kind: 'setting', name: 'work_mem', value: '12MB', scope: 'session' });
    expect(await rows(session, 'SHOW work_mem')).toEqual([['12MB']]);
    await tools.run({ kind: 'setting', name: 'work_mem', value: null, scope: 'session' });
    expect(await rows(session, 'SHOW work_mem')).toEqual(await rows(admin, 'SHOW work_mem'));

    const name = 'log_min_duration_statement';
    const setting = async (): Promise<string> =>
      String((await rows(admin, `SELECT setting FROM pg_settings WHERE name = '${name}'`))[0]![0]);
    const original = await setting();
    const system: ServerAction = { kind: 'setting', name, value: '98765', scope: 'system' };
    expect((await tools.preview(system)).statements).toEqual([
      `ALTER SYSTEM SET ${name} TO '98765'`,
      'SELECT pg_catalog.pg_reload_conf()',
    ]);
    try {
      await tools.run(system);
      let now = '';
      for (let i = 0; i < 50 && now !== '98765'; i++) {
        now = await setting();
        if (now !== '98765') await new Promise((r) => setTimeout(r, 100));
      }
      expect(now).toBe('98765');
    } finally {
      await tools.run({ kind: 'setting', name, value: null, scope: 'system' });
    }
    let restored = '';
    for (let i = 0; i < 50 && restored !== original; i++) {
      restored = await setting();
      if (restored !== original) await new Promise((r) => setTimeout(r, 100));
    }
    expect(restored).toBe(original);
  });
});
