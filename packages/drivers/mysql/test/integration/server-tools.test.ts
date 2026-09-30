import { randomBytes } from 'node:crypto';

import { MASKED_SECRET, type ServerAction, type Session } from '@joinery/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createMysqlAdapter, createMysqlServerTools } from '../../src';
import { SUITES, TARGETS, collect, rows, target, withDatabase } from './helpers';

/**
 * MySQL 8.4 and MariaDB 11.4 server tools against the real servers (spec §15): monitor
 * snapshots, the process list with KILL QUERY and KILL CONNECTION of connections this test
 * opened, statement digests (MySQL) and the "performance_schema is off" path (MariaDB),
 * ANALYZE / OPTIMIZE / CHECK / REPAIR on tables this test created, users, roles and grants on
 * accounts it creates and drops, and a global variable changed and restored.
 */

for (const [engine, url] of SUITES) {
  describe.skipIf(TARGETS.length === 0)(`${engine} server tools`, () => {
    const t = target(engine, url);
    const suffix = randomBytes(4).toString('hex');
    const DB = `st_${suffix}`;
    const USER = `st_u_${suffix}`;
    const ROLE = `st_r_${suffix}`;
    const PASSWORD = `pw-${suffix}'"\\x`;
    // MariaDB's anonymous ''@'localhost' outranks 'user'@'%' for local connections, so there
    // the accounts are made for the host the server sees this client at ('localhost' locally,
    // the Docker gateway on CI); set in beforeAll.
    let HOST = '%';
    const roleRef = engine === 'mariadb' ? { name: ROLE } : { name: ROLE, host: '%' };
    let db: Awaited<ReturnType<typeof withDatabase>>;
    let session: Session;

    beforeAll(async () => {
      db = await withDatabase(t, DB);
      await collect(
        db.session,
        'CREATE TABLE orders (id INT PRIMARY KEY, total DECIMAL(10,2), note TEXT) ENGINE=InnoDB',
      );
      await collect(
        db.session,
        `INSERT INTO orders VALUES (1, 10.5, 'a'), (2, 20, 'b'), (3, 30, 'c')`,
      );
      await collect(db.session, 'CREATE TABLE archive_log (id INT, msg TEXT) ENGINE=MyISAM');
      await collect(db.session, `INSERT INTO archive_log VALUES (1, 'x')`);
      session = await t.connect({ options: { defaultDatabase: DB } });
      if (engine === 'mariadb') {
        const current = String((await rows(session, 'SELECT USER()'))[0]![0]);
        HOST = current.slice(current.lastIndexOf('@') + 1);
      }
    });

    afterAll(async () => {
      const admin = await t.connect();
      await collect(admin, `DROP USER IF EXISTS '${USER}'@'${HOST}'`).catch(() => undefined);
      await collect(admin, `DROP USER IF EXISTS '${USER}_2'@'${HOST}'`).catch(() => undefined);
      await collect(
        admin,
        engine === 'mariadb' ? `DROP ROLE IF EXISTS ${ROLE}` : `DROP ROLE IF EXISTS '${ROLE}'@'%'`,
      ).catch(() => undefined);
      await admin.close();
      await session?.close();
      await db?.drop();
    });

    it('describes the server', async () => {
      const info = await createMysqlServerTools(session).info();
      expect(info).toMatchObject({
        engine,
        product: engine === 'mariadb' ? 'MariaDB' : 'MySQL',
        database: DB,
        perDatabaseSessions: false,
      });
      expect(info.databases).toContain(DB);
      expect(info.sessionActions.map((a) => a.label)).toEqual(['Kill query', 'Kill connection']);
      expect(info.settingScopes.map((s) => s.scope)).toEqual(
        engine === 'mariadb' ? ['global', 'session'] : ['global', 'persist', 'session'],
      );
    });

    it('takes monitor snapshots', async () => {
      const tools = createMysqlServerTools(session);
      const first = await tools.monitor();
      await rows(db.session, 'SELECT * FROM orders');
      const second = await tools.monitor();
      const qps = (s: typeof first) => s.tiles.find((x) => x.id === 'qps');
      const a = qps(first);
      const b = qps(second);
      if (a?.kind !== 'rate' || b?.kind !== 'rate') throw new Error('qps is a rate');
      expect(b.counter!).toBeGreaterThan(a.counter!);
      expect(second.uptimeSeconds).toBeGreaterThan(0);
      const hit = second.tiles.find((x) => x.id === 'buffer-pool-hit');
      expect(hit).toMatchObject({ kind: 'ratio' });
      expect(second.tiles.find((x) => x.id === 'replica-lag')).toMatchObject({
        detail: 'not a replica',
      });
      expect(second.sections.map((s) => s.id)).toEqual(['statements', 'innodb', 'replication']);
    });

    it('kills the query, then the connection, of a thread it opened', async () => {
      const tools = createMysqlServerTools(session);
      const victim = await t.connect();
      const marker = `st-${suffix}`;
      const sleeping = rows(victim, `SELECT SLEEP(30) AS slept /* ${marker} */`).then(
        (result) => result,
        (error: unknown) => error,
      );
      let thread;
      for (let i = 0; i < 50 && !thread; i++) {
        const list = await tools.sessions({ includeIdle: false });
        thread = list.sessions.find((s) => s.query?.includes(marker) === true);
        if (!thread) await new Promise((r) => setTimeout(r, 100));
      }
      expect(thread).toMatchObject({ state: 'Query', idle: false, own: false });
      expect((await tools.sessions()).sessions.some((s) => s.own)).toBe(true);
      const own = (await tools.sessions()).sessions.find((s) => s.own)!;
      await expect(
        tools.run({ kind: 'session', operation: 'terminate', id: own.id }),
      ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });

      const kill: ServerAction = { kind: 'session', operation: 'cancel', id: thread!.id };
      expect((await tools.preview(kill)).statements).toEqual([`KILL QUERY ${thread!.id}`]);
      const started = Date.now();
      await tools.run(kill);
      const outcome = await sleeping;
      expect(Date.now() - started).toBeLessThan(15_000);
      // SLEEP returns 1 when interrupted on MySQL; MariaDB may report the interruption.
      if (Array.isArray(outcome)) expect(outcome).toEqual([[1]]);
      else expect(outcome).toBeDefined();
      expect(await rows(victim, 'SELECT 1')).toEqual([[1]]);

      const result = await tools.run({ kind: 'session', operation: 'terminate', id: thread!.id });
      expect(result.statements).toEqual([`KILL CONNECTION ${thread!.id}`]);
      await expect(rows(victim, 'SELECT 1')).rejects.toBeDefined();
      await victim.close().catch(() => undefined);
      await expect(
        tools.run({ kind: 'session', operation: 'terminate', id: thread!.id }),
      ).rejects.toMatchObject({ engineCode: 1094, hint: expect.stringContaining('ended') });
    });

    it('reads statement digests, or says performance_schema is off', async () => {
      const tools = createMysqlServerTools(session);
      const top = await tools.topQueries({ orderBy: 'calls', limit: 20 });
      const on = (await rows(session, 'SELECT @@performance_schema'))[0]![0];
      if (Number(on) === 1) {
        expect(top.unavailable).toBeNull();
        expect(top.queries.length).toBeGreaterThan(0);
        expect(top.queries[0]!.calls).toBeGreaterThanOrEqual(top.queries.at(-1)!.calls);
        expect(top.resettable).toBe(true);
      } else {
        expect(top.unavailable).toMatchObject({
          reason: 'disabled',
          hint: expect.stringContaining('performance_schema=ON'),
        });
      }
      expect((await tools.preview({ kind: 'topQueries', operation: 'reset' })).statements).toEqual([
        'TRUNCATE TABLE performance_schema.events_statements_summary_by_digest',
      ]);
    });

    it('runs ANALYZE, OPTIMIZE, CHECK and REPAIR TABLE on tables it created', async () => {
      const tools = createMysqlServerTools(session);
      const targets = await tools.maintenanceTargets(DB);
      expect(targets.containers).toContain(DB);
      expect(targets.targets.map((x) => x.name).sort()).toEqual(['archive_log', 'orders']);
      expect(targets.targets.find((x) => x.name === 'orders')?.detail['engine']).toBe('InnoDB');
      const orders = [{ container: DB, name: 'orders' }];

      const analyze: ServerAction = {
        kind: 'maintenance',
        operation: 'analyze',
        targets: orders,
        options: ['local'],
      };
      expect((await tools.preview(analyze)).statements).toEqual([
        `ANALYZE NO_WRITE_TO_BINLOG TABLE \`${DB}\`.\`orders\``,
      ]);
      const analyzed = await tools.run(analyze);
      expect(analyzed.table?.rows[0]).toMatchObject({ Op: 'analyze', Msg_text: 'OK' });

      const optimized = await tools.run({
        kind: 'maintenance',
        operation: 'optimize',
        targets: orders,
        options: [],
      });
      expect(optimized.table?.rows.some((r) => r['Op'] === 'optimize')).toBe(true);

      const checked = await tools.run({
        kind: 'maintenance',
        operation: 'check',
        targets: [...orders, { container: DB, name: 'archive_log' }],
        options: ['medium'],
      });
      expect(checked.statements).toEqual([
        `CHECK TABLE \`${DB}\`.\`orders\`, \`${DB}\`.\`archive_log\` MEDIUM`,
      ]);
      expect(checked.table?.rows.filter((r) => r['Msg_text'] === 'OK')).toHaveLength(2);

      const repaired = await tools.run({
        kind: 'maintenance',
        operation: 'repair',
        targets: [{ container: DB, name: 'archive_log' }],
        options: ['quick'],
      });
      expect(repaired.table?.rows[0]).toMatchObject({ Op: 'repair', Msg_text: 'OK' });
      // InnoDB refuses REPAIR: the server's note comes back as a row, not an error.
      const refused = await tools.run({
        kind: 'maintenance',
        operation: 'repair',
        targets: orders,
        options: [],
      });
      expect(JSON.stringify(refused.table?.rows)).toMatch(/doesn't support repair/);
    });

    it('creates users and roles, grants and revokes, and never shows the password', async () => {
      const tools = createMysqlServerTools(session);
      const user = { name: USER, host: HOST };
      const create: ServerAction = {
        kind: 'createAccount',
        account: user,
        role: false,
        options: { password: PASSWORD, connectionLimit: 4 },
      };
      const preview = await tools.preview(create);
      expect(preview.statements).toEqual([
        `CREATE USER '${USER}'@'${HOST}' IDENTIFIED BY '${MASKED_SECRET}' WITH MAX_USER_CONNECTIONS 4`,
      ]);
      expect(JSON.stringify(preview)).not.toContain(PASSWORD);
      expect(JSON.stringify(await tools.run(create))).not.toContain(PASSWORD);
      // The account signs in with the password (proves it was sent exactly).
      const resolved = t.profile({
        auth: { method: 'password', user: USER, password: { id: 'pw' } },
        options: { defaultDatabase: undefined },
      });
      const signedIn = await createMysqlAdapter({ engine }).connect({
        ...resolved,
        secrets: { pw: PASSWORD },
      });
      await signedIn.close();

      await tools.run({ kind: 'createAccount', account: roleRef, role: true, options: {} });
      expect(
        (await tools.preview({ kind: 'grantRole', role: roleRef, member: user, admin: true }))
          .statements,
      ).toEqual([
        `GRANT ${engine === 'mariadb' ? `'${ROLE}'` : `'${ROLE}'@'%'`} TO '${USER}'@'${HOST}' WITH ADMIN OPTION`,
      ]);
      await tools.run({ kind: 'grantRole', role: roleRef, member: user, admin: true });
      await tools.run({ kind: 'alterAccount', account: user, options: { locked: true } });

      const accounts = (await tools.accounts()).accounts;
      const found = accounts.find((a) => a.name === USER);
      expect(found).toMatchObject({
        host: HOST,
        kind: 'user',
        locked: true,
        canLogin: false,
        connectionLimit: 4,
        memberOf: [{ role: roleRef, admin: true }],
      });
      expect(accounts.find((a) => a.name === ROLE)).toMatchObject({ kind: 'role' });

      // The grants matrix: a database grant, then a table grant, then revokes.
      await tools.run({
        kind: 'grant',
        grantee: user,
        object: { kind: 'database', name: DB },
        privileges: ['SELECT'],
      });
      await tools.run({
        kind: 'grant',
        grantee: user,
        object: { kind: 'table', database: DB, name: 'orders' },
        privileges: ['UPDATE', 'DELETE'],
        grantOption: true,
      });
      let matrix = await tools.grants(user, DB);
      expect(matrix.scope).toBe(DB);
      const row = (label: string) => matrix.rows.find((r) => r.label === label);
      expect(row(`${DB}.*`)?.privileges['SELECT']).toBe('granted');
      expect(row(`${DB}.orders`)?.privileges).toMatchObject({
        SELECT: 'implied',
        UPDATE: 'grantable',
        DELETE: 'grantable',
        INSERT: 'none',
      });
      expect(row('*.*')?.privileges['SUPER']).toBe('none');

      await tools.run({
        kind: 'revoke',
        grantee: user,
        object: { kind: 'table', database: DB, name: 'orders' },
        privileges: ['DELETE'],
      });
      await tools.run({
        kind: 'revoke',
        grantee: user,
        object: { kind: 'database', name: DB },
        privileges: ['SELECT'],
      });
      matrix = await tools.grants(user, DB);
      expect(row(`${DB}.orders`)?.privileges).toMatchObject({
        SELECT: 'none',
        UPDATE: 'grantable',
        DELETE: 'none',
      });

      await tools.run({ kind: 'revokeRole', role: roleRef, member: user });
      await tools.run({
        kind: 'alterAccount',
        account: user,
        options: { locked: false },
        rename: { name: `${USER}_2`, host: HOST },
      });
      const renamed = (await tools.accounts()).accounts.find((a) => a.name === `${USER}_2`);
      expect(renamed).toMatchObject({ locked: false, memberOf: [] });
      await tools.run({
        kind: 'dropAccount',
        account: { name: `${USER}_2`, host: HOST },
        role: false,
      });
      await tools.run({ kind: 'dropAccount', account: roleRef, role: true });
      const names = (await tools.accounts()).accounts.map((a) => a.name);
      expect(names).not.toContain(`${USER}_2`);
      expect(names).not.toContain(ROLE);
    });

    it('reads variables, and changes and restores a global and a session variable', async () => {
      const tools = createMysqlServerTools(session);
      const list = await tools.settings();
      const maxErrors = list.settings.find((s) => s.name === 'max_connect_errors');
      expect(maxErrors).toBeDefined();
      expect(maxErrors!.scopes).toContain('global');
      if (engine === 'mariadb') {
        expect(maxErrors).toMatchObject({ type: 'integer', scopes: ['global'] });
        expect(list.settings.find((s) => s.name === 'version')?.scopes).toEqual([]);
      }
      const original = maxErrors!.value!;
      const next = String(Number(original) + 1);
      const change: ServerAction = {
        kind: 'setting',
        name: 'max_connect_errors',
        value: next,
        scope: 'global',
      };
      expect((await tools.preview(change)).statements).toEqual([
        `SET GLOBAL max_connect_errors = ${next}`,
      ]);
      try {
        await tools.run(change);
        expect(await rows(db.session, 'SELECT @@GLOBAL.max_connect_errors')).toEqual([
          [Number(next)],
        ]);
      } finally {
        await tools.run({ ...change, value: original });
      }
      expect(await rows(db.session, 'SELECT @@GLOBAL.max_connect_errors')).toEqual([
        [Number(original)],
      ]);

      await tools.run({
        kind: 'setting',
        name: 'sort_buffer_size',
        value: '524288',
        scope: 'session',
      });
      expect(await rows(session, 'SELECT @@SESSION.sort_buffer_size')).toEqual([[524288]]);
      await tools.run({ kind: 'setting', name: 'sort_buffer_size', value: null, scope: 'session' });
      const readOnly = await tools
        .run({ kind: 'setting', name: 'version', value: 'x', scope: 'global' })
        .catch((e: unknown) => e);
      expect(readOnly).toMatchObject({
        engineCode: 1238,
        hint: expect.stringContaining('option file'),
      });
    });
  });
}
