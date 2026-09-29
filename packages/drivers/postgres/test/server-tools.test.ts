import { JoineryError, MASKED_SECRET, type GrantObjectRef, type ServerAction } from '@joinery/core';
import { describe, expect, it } from 'vitest';

import {
  grantStates,
  pgAccounts,
  pgDefaultPrivileges,
  pgMonitorSnapshot,
  pgRlsTables,
  pgSession,
  pgSetting,
  statementColumns,
} from '../src/server-tools/read';
import { maskError, withHint } from '../src/server-tools/runner';
import {
  accountStatements,
  checkExpression,
  defaultPrivilegeStatement,
  grantStatement,
  maintenanceStatements,
  membershipStatement,
  policyStatement,
  sessionStatement,
  settingStatements,
  settingValueSql,
} from '../src/server-tools/statements';

const PG16 = 160004;
const PG13 = 130015;
const PG17 = 170002;

function maintenance(
  operation: Extract<ServerAction, { kind: 'maintenance' }>['operation'],
  options: string[] = [],
  index?: string,
): Extract<ServerAction, { kind: 'maintenance' }> {
  return {
    kind: 'maintenance',
    operation,
    targets: [
      { container: 'public', name: 'orders' },
      { container: 'Sales "EU"', name: 'line items' },
    ],
    options,
    ...(index !== undefined ? { index } : {}),
  };
}

describe('PostgreSQL server tool statements', () => {
  it('signals backends by number only', () => {
    expect(sessionStatement('cancel', '4211').sql).toBe(
      'SELECT pg_catalog.pg_cancel_backend(4211)',
    );
    expect(sessionStatement('terminate', '17').sql).toBe(
      'SELECT pg_catalog.pg_terminate_backend(17)',
    );
    expect(() => sessionStatement('cancel', '1; DROP TABLE x')).toThrow(JoineryError);
  });

  it('builds VACUUM and ANALYZE for several tables, quoting every name', () => {
    expect(maintenanceStatements(maintenance('vacuum', ['analyze', 'full']), PG16)).toEqual([
      {
        sql: 'VACUUM (FULL, ANALYZE) "public"."orders", "Sales ""EU"""."line items"',
        shown: 'VACUUM (FULL, ANALYZE) "public"."orders", "Sales ""EU"""."line items"',
        secrets: [],
      },
    ]);
    expect(maintenanceStatements(maintenance('analyze'), PG16)[0]!.sql).toBe(
      'ANALYZE "public"."orders", "Sales ""EU"""."line items"',
    );
    expect(() => maintenanceStatements(maintenance('vacuum', ['cascade']), PG16)).toThrow(
      'VACUUM has no option "cascade"',
    );
    expect(() => maintenanceStatements(maintenance('optimize'), PG16)).toThrow(/not a PostgreSQL/);
  });

  it('runs REINDEX and CLUSTER one table at a time, in the syntax of the version', () => {
    expect(
      maintenanceStatements(maintenance('reindex', ['concurrently', 'verbose']), PG16).map(
        (s) => s.sql,
      ),
    ).toEqual([
      'REINDEX (VERBOSE) TABLE CONCURRENTLY "public"."orders"',
      'REINDEX (VERBOSE) TABLE CONCURRENTLY "Sales ""EU"""."line items"',
    ]);
    const one = {
      ...maintenance('cluster', ['verbose'], 'orders_pkey'),
      targets: [{ container: 'public', name: 'orders' }],
    };
    expect(maintenanceStatements(one, PG16)[0]!.sql).toBe(
      'CLUSTER (VERBOSE) "public"."orders" USING "orders_pkey"',
    );
    expect(maintenanceStatements(one, PG13)[0]!.sql).toBe(
      'CLUSTER VERBOSE "public"."orders" USING "orders_pkey"',
    );
    expect(() => maintenanceStatements(maintenance('cluster', [], 'i'), PG16)).toThrow(/one table/);
  });

  it('changes settings in a session, a database or the configuration', () => {
    const set = (scope: 'session' | 'database' | 'system', value: string | null) =>
      settingStatements({ kind: 'setting', name: 'work_mem', value, scope }, 'shop').map(
        (s) => s.sql,
      );
    expect(set('session', '64MB')).toEqual(["SET work_mem TO '64MB'"]);
    expect(set('session', null)).toEqual(['RESET work_mem']);
    expect(set('database', "it's")).toEqual([`ALTER DATABASE "shop" SET work_mem TO 'it''s'`]);
    expect(set('system', '1GB')).toEqual([
      "ALTER SYSTEM SET work_mem TO '1GB'",
      'SELECT pg_catalog.pg_reload_conf()',
    ]);
    expect(set('system', null)[0]).toBe('ALTER SYSTEM RESET work_mem');
    expect(() =>
      settingStatements(
        { kind: 'setting', name: 'work_mem; DROP', value: '1', scope: 'session' },
        'x',
      ),
    ).toThrow(/not a setting name/);
    expect(() =>
      settingStatements({ kind: 'setting', name: 'work_mem', value: '1', scope: 'global' }, 'x'),
    ).toThrow(/no "global" setting scope/);
  });

  it('quotes each element of a list setting', () => {
    expect(settingValueSql('search_path', '"$user", public, "My Schema"')).toBe(
      "'$user', 'public', 'My Schema'",
    );
    expect(settingValueSql('shared_preload_libraries', 'pg_stat_statements,auto_explain')).toBe(
      "'pg_stat_statements', 'auto_explain'",
    );
    expect(settingValueSql('DateStyle', 'ISO, MDY')).toBe("'ISO, MDY'");
  });

  it('creates and alters roles with the password masked in what is shown', () => {
    const [create] = accountStatements({
      kind: 'createAccount',
      account: { name: 'app' },
      role: false,
      options: {
        password: "s3'cret",
        createDb: true,
        connectionLimit: 5,
        validUntil: '2030-01-01',
      },
    });
    expect(create).toEqual({
      sql: `CREATE ROLE "app" WITH LOGIN CREATEDB CONNECTION LIMIT 5 PASSWORD 's3''cret' VALID UNTIL '2030-01-01'`,
      shown: `CREATE ROLE "app" WITH LOGIN CREATEDB CONNECTION LIMIT 5 PASSWORD '${MASKED_SECRET}' VALID UNTIL '2030-01-01'`,
      secrets: ["'s3''cret'", "s3'cret"],
    });
    expect(
      accountStatements({
        kind: 'createAccount',
        account: { name: 'readers' },
        role: true,
        options: {},
      })[0]!.sql,
    ).toBe('CREATE ROLE "readers" WITH NOLOGIN');
    expect(
      accountStatements({
        kind: 'alterAccount',
        account: { name: 'app' },
        options: { superuser: false, validUntil: null },
        rename: { name: 'app2' },
      }).map((s) => s.sql),
    ).toEqual([
      `ALTER ROLE "app" WITH NOSUPERUSER VALID UNTIL 'infinity'`,
      'ALTER ROLE "app" RENAME TO "app2"',
    ]);
    expect(
      accountStatements({ kind: 'dropAccount', account: { name: 'app' }, role: false })[0]!.sql,
    ).toBe('DROP ROLE "app"');
    expect(() =>
      accountStatements({ kind: 'alterAccount', account: { name: 'app' }, options: {} }),
    ).toThrow('Nothing to change');
    expect(() =>
      accountStatements({ kind: 'dropAccount', account: { name: 'x'.repeat(64) }, role: false }),
    ).toThrow(/longer than 63 bytes/);
    expect(() =>
      accountStatements({
        kind: 'createAccount',
        account: { name: 'a' },
        role: false,
        options: { locked: true },
      }),
    ).toThrow(/cannot be locked/);
  });

  it('grants and revokes membership', () => {
    expect(
      membershipStatement({
        kind: 'grantRole',
        role: { name: 'readers' },
        member: { name: 'app' },
        admin: true,
      }).sql,
    ).toBe('GRANT "readers" TO "app" WITH ADMIN OPTION');
    expect(
      membershipStatement({
        kind: 'revokeRole',
        role: { name: 'readers' },
        member: { name: 'app' },
        admin: true,
      }).sql,
    ).toBe('REVOKE ADMIN OPTION FOR "readers" FROM "app"');
  });

  it('grants the privileges each object kind has', () => {
    const grant = (object: GrantObjectRef, privileges: string[], version = PG16) =>
      grantStatement(
        { kind: 'grant', grantee: { name: 'app' }, object, privileges, grantOption: true },
        version,
      ).sql;
    expect(grant({ kind: 'table', schema: 'public', name: 'orders' }, ['select', 'UPDATE'])).toBe(
      'GRANT SELECT, UPDATE ON TABLE "public"."orders" TO "app" WITH GRANT OPTION',
    );
    expect(grant({ kind: 'schema', name: 'sales' }, ['USAGE'])).toBe(
      'GRANT USAGE ON SCHEMA "sales" TO "app" WITH GRANT OPTION',
    );
    expect(grant({ kind: 'database', name: 'shop' }, ['CONNECT', 'TEMPORARY'])).toBe(
      'GRANT CONNECT, TEMPORARY ON DATABASE "shop" TO "app" WITH GRANT OPTION',
    );
    expect(() => grant({ kind: 'table', schema: 'public', name: 'orders' }, ['USAGE'])).toThrow(
      /USAGE cannot be granted on a table/,
    );
    expect(() =>
      grant({ kind: 'table', schema: 'public', name: 'orders' }, ['MAINTAIN']),
    ).toThrow();
    expect(
      grant({ kind: 'table', schema: 'public', name: 'orders' }, ['MAINTAIN'], PG17),
    ).toContain('GRANT MAINTAIN');
    expect(
      grantStatement(
        {
          kind: 'revoke',
          grantee: { name: 'public' },
          object: { kind: 'function', schema: 's', name: 'f', signature: 'x integer' },
          privileges: ['EXECUTE'],
          grantOption: true,
        },
        PG16,
        's.f(x integer)',
      ).sql,
    ).toBe('REVOKE GRANT OPTION FOR EXECUTE ON ROUTINE s.f(x integer) FROM PUBLIC');
    // A function is only ever named by what the server resolved.
    expect(() =>
      grantStatement(
        {
          kind: 'grant',
          grantee: { name: 'app' },
          object: { kind: 'function', schema: 's', name: 'f', signature: ') ; DROP TABLE t; --' },
          privileges: ['EXECUTE'],
        },
        PG16,
      ),
    ).toThrow('The function was not found');
  });

  it('alters default privileges', () => {
    expect(
      defaultPrivilegeStatement(
        {
          kind: 'defaultPrivileges',
          operation: 'grant',
          owner: 'etl',
          schema: 'sales',
          objectType: 'sequences',
          grantee: 'app',
          privileges: ['usage', 'SELECT'],
        },
        PG16,
      ).sql,
    ).toBe(
      'ALTER DEFAULT PRIVILEGES FOR ROLE "etl" IN SCHEMA "sales" GRANT USAGE, SELECT ON SEQUENCES TO "app"',
    );
    expect(
      defaultPrivilegeStatement(
        {
          kind: 'defaultPrivileges',
          operation: 'revoke',
          objectType: 'functions',
          grantee: 'PUBLIC',
          privileges: ['EXECUTE'],
          grantOption: true,
        },
        PG16,
      ).sql,
    ).toBe('ALTER DEFAULT PRIVILEGES REVOKE GRANT OPTION FOR EXECUTE ON FUNCTIONS FROM PUBLIC');
    expect(() =>
      defaultPrivilegeStatement(
        {
          kind: 'defaultPrivileges',
          operation: 'grant',
          schema: 's',
          objectType: 'schemas',
          grantee: 'a',
          privileges: ['USAGE'],
        },
        PG16,
      ),
    ).toThrow(/cannot be limited/);
  });

  it('creates policies from one expression that cannot escape its parentheses', () => {
    const base = {
      kind: 'createPolicy',
      schema: 'public',
      table: 'orders',
      name: 'own rows',
      permissive: false,
      command: 'UPDATE',
      roles: ['app', 'public'],
      using: "owner = current_user AND note <> ')'",
      withCheck: '(total > 0)',
    } as const;
    expect(policyStatement(base).sql).toBe(
      `CREATE POLICY "own rows" ON "public"."orders" AS RESTRICTIVE FOR UPDATE TO "app", PUBLIC USING (owner = current_user AND note <> ')') WITH CHECK ((total > 0))`,
    );
    for (const bad of [
      'true) OR (true',
      'x; DROP TABLE t',
      "note = 'x",
      'true -- c',
      '(a',
      'a = $1',
    ]) {
      expect(() => checkExpression(bad, 'USING')).toThrow(JoineryError);
    }
    expect(() => policyStatement({ ...base, command: 'INSERT' })).toThrow(/only a WITH CHECK/);
    expect(() => policyStatement({ ...base, command: 'SELECT', using: undefined })).toThrow();
    expect(
      policyStatement({ kind: 'dropPolicy', schema: 'public', table: 'orders', name: 'p' }).sql,
    ).toBe('DROP POLICY "p" ON "public"."orders"');
    expect(
      policyStatement({
        kind: 'rowSecurity',
        schema: 'public',
        table: 'orders',
        enabled: true,
        forced: true,
      }).sql,
    ).toBe('ALTER TABLE "public"."orders" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY');
  });
});

describe('PostgreSQL server tool readers', () => {
  it('builds the monitor tiles from activity and database statistics', () => {
    const snapshot = pgMonitorSnapshot(1000, {
      activity: {
        clients: 12,
        active: 3,
        idle_in_tx: 1,
        lock_waits: 2,
        longest_xact_s: '4.5',
        longest_query_s: '75',
        max_connections: 100,
        uptime_s: '3600.5',
        locks: 40,
        db_size: 8_000_000n,
      },
      databases: [
        {
          datname: 'a',
          xact_commit: 100n,
          xact_rollback: 5,
          blks_hit: 900,
          blks_read: 100,
          tup_fetched: 10,
          tup_inserted: 1,
          tup_updated: 2,
          tup_deleted: 3,
          temp_bytes: 0,
          deadlocks: 1,
          numbackends: 4,
          conflicts: 0,
        },
        {
          datname: 'b',
          xact_commit: 50,
          xact_rollback: 0,
          blks_hit: 0,
          blks_read: 0,
          tup_fetched: 0,
          tup_inserted: 0,
          tup_updated: 0,
          tup_deleted: 0,
          temp_bytes: 2048,
          deadlocks: 0,
          numbackends: 0,
          conflicts: 0,
        },
      ],
      inRecovery: false,
      replication: [{ application_name: 'r1', replay_lag_bytes: '1024', replay_lag_ms: 12 }],
      slots: [
        {
          slot_name: 's',
          slot_type: 'physical',
          active: 't',
          wal_status: 'reserved',
          retained_bytes: 10,
        },
      ],
      lockWaits: [{ pid: 7, mode: 'AccessExclusiveLock', locktype: 'relation', blocked_by: '8' }],
      database: 'a',
      notices: [],
    });
    const tile = (id: string) => snapshot.tiles.find((t) => t.id === id);
    expect(snapshot.uptimeSeconds).toBe(3600.5);
    expect(tile('connections')).toMatchObject({
      value: 12,
      detail: '3 active · 1 idle in transaction · 100 max',
    });
    expect(tile('tps')).toMatchObject({ kind: 'rate', counter: 155 });
    expect(tile('cache-hit')).toMatchObject({ kind: 'ratio', hits: 900, total: 1000 });
    expect(tile('rows-written')).toMatchObject({ counter: 6 });
    expect(tile('replication-lag')).toMatchObject({ unit: 'bytes', value: 1024 });
    expect(tile('longest-transaction')).toMatchObject({
      value: 4.5,
      detail: 'longest running query 1 min 15 s',
    });
    expect(tile('database-size')).toMatchObject({ value: 8_000_000 });
    const dbs = snapshot.sections.find((s) => s.id === 'databases')!.table.rows;
    expect(dbs[0]).toMatchObject({ database: 'a', hitRatio: 0.9, commits: 100 });
    expect(dbs[1]).toMatchObject({ hitRatio: null });
    expect(snapshot.sections.find((s) => s.id === 'slots')!.table.rows[0]).toMatchObject({
      active: true,
    });
    expect(snapshot.sections.find((s) => s.id === 'lock-waits')!.table.rows[0]).toMatchObject({
      lock: 'AccessExclusiveLock (relation)',
      blockedBy: '8',
    });
  });

  it('shows a standby its replay delay instead of replicas', () => {
    const snapshot = pgMonitorSnapshot(0, {
      activity: {},
      databases: [],
      inRecovery: true,
      replication: [{ replay_delay_s: 2.5, receiver_status: 'streaming', sender: 'primary:5432' }],
      slots: [],
      lockWaits: [],
      database: 'a',
      notices: [],
    });
    expect(snapshot.tiles.find((t) => t.id === 'replication-lag')).toMatchObject({
      label: 'Replay delay',
      value: 2.5,
      detail: 'standby · WAL receiver streaming',
    });
    expect(snapshot.sections.map((s) => s.id)).toEqual(['databases', 'replication', 'lock-waits']);
  });

  it('reads pg_stat_activity rows of any version', () => {
    const pg13 = pgSession({
      a: JSON.stringify({
        pid: 42,
        usename: 'app',
        datname: 'shop',
        application_name: '',
        client_addr: '10.0.0.5',
        client_port: 5555,
        backend_type: 'client backend',
        state: 'active',
        wait_event_type: 'Lock',
        wait_event: 'transactionid',
        query: 'update t set x = 1',
        leader_pid: null,
      }),
      duration_ms: '1500.5',
      blocked_by: '7,9',
      own: false,
    });
    expect(pg13).toMatchObject({
      id: '42',
      client: '10.0.0.5:5555',
      application: null,
      wait: 'Lock: transactionid',
      blockedBy: ['7', '9'],
      durationMs: 1500.5,
      background: false,
      idle: false,
    });
    expect(pg13.detail['queryId']).toBeNull();
    const local = pgSession({
      a: JSON.stringify({
        pid: 1,
        client_port: -1,
        backend_type: 'autovacuum launcher',
        query_id: 123,
      }),
      own: 't',
    });
    expect(local).toMatchObject({ client: 'local socket', background: true, own: true });
    expect(local.detail['queryId']).toBe(123);
  });

  it('picks pg_stat_statements columns of the installed extension version', () => {
    expect(statementColumns(['total_time', 'mean_time', 'max_time', 'blk_read_time'])).toEqual({
      total: 'total_time',
      mean: 'mean_time',
      max: 'max_time',
      planTotal: null,
      readTime: 'blk_read_time',
      walBytes: null,
    });
    expect(
      statementColumns([
        'total_exec_time',
        'mean_exec_time',
        'max_exec_time',
        'total_plan_time',
        'shared_blk_read_time',
        'wal_bytes',
      ]),
    ).toMatchObject({
      total: 'total_exec_time',
      planTotal: 'total_plan_time',
      readTime: 'shared_blk_read_time',
      walBytes: 'wal_bytes',
    });
  });

  it('merges role memberships granted by several grantors', () => {
    const accounts = pgAccounts(
      [
        {
          r: JSON.stringify({
            rolname: 'app',
            rolcanlogin: true,
            rolsuper: false,
            rolcreatedb: true,
            rolinherit: false,
            rolconnlimit: -1,
            rolvaliduntil: null,
          }),
        },
        { r: JSON.stringify({ rolname: 'readers', rolcanlogin: false, rolconnlimit: 5 }) },
        { r: JSON.stringify({ rolname: 'pg_monitor', rolcanlogin: false }) },
      ],
      [
        {
          role: 'readers',
          member: 'app',
          m: JSON.stringify({ admin_option: false, inherit_option: true, set_option: false }),
        },
        {
          role: 'readers',
          member: 'app',
          m: JSON.stringify({ admin_option: true, inherit_option: false, set_option: true }),
        },
      ],
    );
    expect(accounts[0]).toMatchObject({
      kind: 'user',
      attributes: ['CREATEDB', 'NOINHERIT'],
      connectionLimit: null,
      memberOf: [{ role: { name: 'readers' }, admin: true, inherit: true, set: true }],
    });
    expect(accounts[1]).toMatchObject({ kind: 'role', connectionLimit: 5, builtin: false });
    expect(accounts[2]!.builtin).toBe(true);
  });

  it('marks explicit, grantable and implied privileges', () => {
    expect(
      grantStates(
        ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
        [
          { p: 'SELECT', g: false },
          { p: 'INSERT', g: true },
        ],
        { SELECT: true, INSERT: true, UPDATE: true, DELETE: false },
        false,
      ),
    ).toEqual({ SELECT: 'granted', INSERT: 'grantable', UPDATE: 'implied', DELETE: 'none' });
    // The owner's privileges come with ownership.
    expect(grantStates(['SELECT'], [{ p: 'SELECT', g: true }], { SELECT: true }, true)).toEqual({
      SELECT: 'implied',
    });
  });

  it('groups default privileges and skips the owner’s own', () => {
    expect(
      pgDefaultPrivileges([
        {
          owner: 'etl',
          schema: null,
          type: 'r',
          grantee: 'etl',
          privilege: 'SELECT',
          grantable: false,
        },
        {
          owner: 'etl',
          schema: 'sales',
          type: 'r',
          grantee: 'app',
          privilege: 'SELECT',
          grantable: true,
        },
        {
          owner: 'etl',
          schema: 'sales',
          type: 'r',
          grantee: 'app',
          privilege: 'INSERT',
          grantable: false,
        },
        {
          owner: 'etl',
          schema: null,
          type: 'f',
          grantee: 'PUBLIC',
          privilege: 'EXECUTE',
          grantable: false,
        },
      ]),
    ).toEqual([
      {
        owner: 'etl',
        schema: 'sales',
        objectType: 'tables',
        grantee: 'app',
        privileges: ['SELECT', 'INSERT'],
        grantable: ['SELECT'],
      },
      {
        owner: 'etl',
        schema: null,
        objectType: 'functions',
        grantee: 'PUBLIC',
        privileges: ['EXECUTE'],
        grantable: [],
      },
    ]);
  });

  it('reads policies', () => {
    expect(
      pgRlsTables('public', [
        {
          name: 'orders',
          enabled: true,
          forced: 'f',
          policies: JSON.stringify([
            { name: 'p', permissive: false, cmd: 'w', roles: null, using: '(a = 1)', check: null },
          ]),
        },
        { name: 'items', enabled: false, forced: false, policies: null },
      ]),
    ).toEqual([
      {
        schema: 'public',
        table: 'orders',
        enabled: true,
        forced: false,
        policies: [
          {
            name: 'p',
            permissive: false,
            command: 'UPDATE',
            roles: ['public'],
            using: '(a = 1)',
            withCheck: null,
          },
        ],
      },
      { schema: 'public', table: 'items', enabled: false, forced: false, policies: [] },
    ]);
  });

  it('offers the scopes a setting can change in, for this role', () => {
    const row = (context: string) => ({
      name: 'x',
      setting: '1',
      context,
      vartype: 'integer',
      enumvals: null,
      pending_restart: false,
    });
    const superuser = { superuser: true, alterSystem: () => true };
    const plain = { superuser: false, alterSystem: () => false };
    expect(pgSetting(row('user'), superuser).scopes).toEqual(['session', 'database', 'system']);
    expect(pgSetting(row('superuser'), plain).scopes).toEqual([]);
    expect(pgSetting(row('postmaster'), superuser)).toMatchObject({
      scopes: ['system'],
      restartRequired: true,
    });
    expect(pgSetting(row('internal'), superuser).scopes).toEqual([]);
    expect(
      pgSetting({ ...row('user'), vartype: 'enum', enumvals: '["on","off"]' }, plain),
    ).toMatchObject({ type: 'enum', enumValues: ['on', 'off'], scopes: ['session', 'database'] });
  });
});

describe('server tool errors', () => {
  it('masks a password an error message repeats', () => {
    const error = new JoineryError({
      code: 'SQL_ERROR',
      message: "near 'hunter2'",
      detail: 'hunter2 again',
    });
    const masked = maskError(error, {
      sql: "x 'hunter2'",
      shown: `x '${MASKED_SECRET}'`,
      secrets: ["'hunter2'", 'hunter2'],
    });
    expect(JSON.stringify(masked)).not.toContain('hunter2');
    expect((masked as JoineryError).message).toBe(`near ${MASKED_SECRET}`);
  });

  it('adds a hint to errors of the given codes', () => {
    const denied = new JoineryError({ code: 'SQL_ERROR', message: 'denied', sqlState: '42501' });
    expect((withHint(denied, ['42501'], 'Ask for it') as JoineryError).hint).toBe('Ask for it');
    const other = new JoineryError({
      code: 'SQL_ERROR',
      message: 'x',
      sqlState: '42P01',
      engineCode: 1095,
    });
    expect(withHint(other, [1095], 'By engine code')).toMatchObject({ hint: 'By engine code' });
    expect(withHint(other, ['42501'], 'No')).toBe(other);
  });
});
