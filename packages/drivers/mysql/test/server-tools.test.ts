import { JoineryError, MASKED_SECRET, type ServerAction } from '@joinery/core';
import { describe, expect, it } from 'vitest';

import {
  mariadbSetting,
  mysqlAccounts,
  mysqlMonitorSnapshot,
  mysqlSession,
  mysqlSetting,
  mysqlTopQuery,
  nameValueMap,
} from '../src/server-tools/read';
import { enrichMysqlError, globalPrivileges } from '../src/server-tools/service';
import {
  accountSql,
  accountStatements,
  grantStatement,
  killStatement,
  maintenanceStatement,
  membershipStatement,
  settingStatement,
  variableValueSql,
} from '../src/server-tools/statements';

describe('MySQL server tool statements', () => {
  it('kills a query or a connection by thread id', () => {
    expect(killStatement('cancel', '12').sql).toBe('KILL QUERY 12');
    expect(killStatement('terminate', '12').sql).toBe('KILL CONNECTION 12');
    expect(() => killStatement('cancel', '12 OR 1')).toThrow(JoineryError);
  });

  it('runs the table maintenance statements with their options', () => {
    const run = (operation: 'analyze' | 'optimize' | 'check' | 'repair', options: string[]) =>
      maintenanceStatement({
        kind: 'maintenance',
        operation,
        targets: [
          { container: 'shop', name: 'orders' },
          { container: 'sh`op', name: 'items' },
        ],
        options,
      }).sql;
    expect(run('analyze', ['local'])).toBe(
      'ANALYZE NO_WRITE_TO_BINLOG TABLE `shop`.`orders`, `sh``op`.`items`',
    );
    expect(run('optimize', [])).toBe('OPTIMIZE TABLE `shop`.`orders`, `sh``op`.`items`');
    expect(run('check', ['extended', 'quick'])).toBe(
      'CHECK TABLE `shop`.`orders`, `sh``op`.`items` QUICK EXTENDED',
    );
    expect(run('repair', ['use_frm', 'local'])).toBe(
      'REPAIR NO_WRITE_TO_BINLOG TABLE `shop`.`orders`, `sh``op`.`items` USE_FRM',
    );
    expect(() => run('check', ['local'])).toThrow(/has no option "local"/);
    expect(() =>
      maintenanceStatement({ kind: 'maintenance', operation: 'vacuum', targets: [], options: [] }),
    ).toThrow(/not a MySQL maintenance command/);
  });

  it('writes variable values as numbers, keywords or strings', () => {
    expect(variableValueSql('100')).toBe('100');
    expect(variableValueSql('-2.5e3')).toBe('-2.5e3');
    expect(variableValueSql('on')).toBe('ON');
    expect(variableValueSql("STRICT_TRANS_TABLES,it's")).toBe("'STRICT_TRANS_TABLES,it''s'");
    const set = (
      scope: 'global' | 'session' | 'persist',
      value: string | null,
      flavor: 'mysql' | 'mariadb' = 'mysql',
    ) => settingStatement({ kind: 'setting', name: 'Max_Connections', value, scope }, flavor).sql;
    expect(set('global', '200')).toBe('SET GLOBAL max_connections = 200');
    expect(set('session', null)).toBe('SET SESSION max_connections = DEFAULT');
    expect(set('persist', '200')).toBe('SET PERSIST max_connections = 200');
    expect(set('persist', null)).toBe('RESET PERSIST max_connections');
    expect(() => set('persist', '1', 'mariadb')).toThrow(/MariaDB has no SET PERSIST/);
    expect(() =>
      settingStatement(
        { kind: 'setting', name: 'x = 1; DROP', value: '1', scope: 'global' },
        'mysql',
      ),
    ).toThrow(/not a system variable name/);
  });

  it('names accounts with a host, and MariaDB roles without one', () => {
    expect(accountSql({ name: "o'brien", host: '10.0.%' }, 'mysql')).toBe("'o''brien'@'10.0.%'");
    expect(accountSql({ name: 'reader' }, 'mysql')).toBe("'reader'@'%'");
    expect(accountSql({ name: 'reader' }, 'mariadb')).toBe("'reader'");
    expect(accountSql({ name: 'app', host: 'localhost' }, 'mariadb')).toBe("'app'@'localhost'");
  });

  it('creates users with the password masked, and roles', () => {
    const [user] = accountStatements(
      {
        kind: 'createAccount',
        account: { name: 'app', host: '%' },
        role: false,
        options: { password: "p\\w'd", connectionLimit: 10, locked: true },
      },
      'mysql',
    );
    expect(user).toEqual({
      sql: "CREATE USER 'app'@'%' IDENTIFIED BY 'p\\\\w''d' WITH MAX_USER_CONNECTIONS 10 ACCOUNT LOCK",
      shown: `CREATE USER 'app'@'%' IDENTIFIED BY '${MASKED_SECRET}' WITH MAX_USER_CONNECTIONS 10 ACCOUNT LOCK`,
      secrets: ["'p\\\\w''d'", "p\\w'd"],
    });
    expect(
      accountStatements(
        { kind: 'createAccount', account: { name: 'r' }, role: true, options: {} },
        'mariadb',
      )[0]!.sql,
    ).toBe("CREATE ROLE 'r'");
    expect(
      accountStatements(
        { kind: 'createAccount', account: { name: 'r', host: '%' }, role: true, options: {} },
        'mysql',
      )[0]!.sql,
    ).toBe("CREATE ROLE 'r'@'%'");
    expect(() =>
      accountStatements(
        { kind: 'createAccount', account: { name: 'r', host: 'x' }, role: true, options: {} },
        'mariadb',
      ),
    ).toThrow(/MariaDB roles have no host/);
    expect(() =>
      accountStatements(
        {
          kind: 'createAccount',
          account: { name: 'u' },
          role: false,
          options: { superuser: true },
        },
        'mysql',
      ),
    ).toThrow(/not account options/);
  });

  it('alters, renames and drops accounts', () => {
    expect(
      accountStatements(
        {
          kind: 'alterAccount',
          account: { name: 'app', host: '%' },
          options: { locked: false, connectionLimit: -1 },
          rename: { name: 'app2', host: 'localhost' },
        },
        'mysql',
      ).map((s) => s.sql),
    ).toEqual([
      "ALTER USER 'app'@'%' WITH MAX_USER_CONNECTIONS 0 ACCOUNT UNLOCK",
      "RENAME USER 'app'@'%' TO 'app2'@'localhost'",
    ]);
    expect(
      accountStatements({ kind: 'dropAccount', account: { name: 'r' }, role: true }, 'mariadb')[0]!
        .sql,
    ).toBe("DROP ROLE 'r'");
    expect(
      accountStatements(
        { kind: 'dropAccount', account: { name: 'u', host: 'h' }, role: false },
        'mariadb',
      )[0]!.sql,
    ).toBe("DROP USER 'u'@'h'");
  });

  it('grants roles, and revokes the admin option on MariaDB only', () => {
    const grant: ServerAction = {
      kind: 'grantRole',
      role: { name: 'r', host: '%' },
      member: { name: 'app', host: '%' },
      admin: true,
    };
    expect(
      membershipStatement(grant as Extract<ServerAction, { kind: 'grantRole' }>, 'mysql').sql,
    ).toBe("GRANT 'r'@'%' TO 'app'@'%' WITH ADMIN OPTION");
    expect(
      membershipStatement(
        {
          kind: 'revokeRole',
          role: { name: 'r' },
          member: { name: 'app', host: '%' },
          admin: true,
        },
        'mariadb',
      ).sql,
    ).toBe("REVOKE ADMIN OPTION FOR 'r' FROM 'app'@'%'");
    expect(() =>
      membershipStatement(
        { kind: 'revokeRole', role: { name: 'r' }, member: { name: 'app' }, admin: true },
        'mysql',
      ),
    ).toThrow(/cannot revoke only the admin option/);
  });

  it('grants on the server, a database or a table', () => {
    const grantee = { name: 'app', host: '%' };
    expect(
      grantStatement(
        {
          kind: 'grant',
          grantee,
          object: { kind: 'global' },
          privileges: ['PROCESS', 'system_variables_admin'],
        },
        'mysql',
      ).sql,
    ).toBe("GRANT PROCESS, SYSTEM_VARIABLES_ADMIN ON *.* TO 'app'@'%'");
    expect(
      grantStatement(
        {
          kind: 'grant',
          grantee,
          object: { kind: 'database', name: 'shop' },
          privileges: ['CREATE VIEW'],
          grantOption: true,
        },
        'mysql',
      ).sql,
    ).toBe("GRANT CREATE VIEW ON `shop`.* TO 'app'@'%' WITH GRANT OPTION");
    expect(
      grantStatement(
        {
          kind: 'revoke',
          grantee,
          object: { kind: 'table', database: 'shop', name: 'orders' },
          privileges: ['DELETE'],
        },
        'mysql',
      ).sql,
    ).toBe("REVOKE DELETE ON `shop`.`orders` FROM 'app'@'%'");
    expect(
      grantStatement(
        {
          kind: 'revoke',
          grantee,
          object: { kind: 'table', database: 'shop', name: 'orders' },
          privileges: [],
          grantOption: true,
        },
        'mysql',
      ).sql,
    ).toBe("REVOKE GRANT OPTION ON `shop`.`orders` FROM 'app'@'%'");
    expect(
      grantStatement(
        {
          kind: 'grant',
          grantee: { name: 'r' },
          object: { kind: 'table', database: 's', name: 't' },
          privileges: ['DELETE HISTORY'],
        },
        'mariadb',
      ).sql,
    ).toBe("GRANT DELETE HISTORY ON `s`.`t` TO 'r'");
    expect(() =>
      grantStatement(
        {
          kind: 'grant',
          grantee,
          object: { kind: 'table', database: 's', name: 't' },
          privileges: ['PROCESS'],
        },
        'mysql',
      ),
    ).toThrow(/PROCESS cannot be granted on a table/);
    expect(() =>
      grantStatement(
        { kind: 'grant', grantee, object: { kind: 'global' }, privileges: ['ALL; DROP'] },
        'mysql',
      ),
    ).toThrow(JoineryError);
    expect(() =>
      grantStatement(
        { kind: 'grant', grantee, object: { kind: 'schema', name: 's' }, privileges: ['USAGE'] },
        'mysql',
      ),
    ).toThrow(/not a schema/);
  });
});

describe('MySQL server tool readers', () => {
  const status = nameValueMap(
    [
      ['Questions', '1000'],
      ['Threads_connected', '5'],
      ['Threads_running', '2'],
      ['Max_used_connections', '9'],
      ['Innodb_buffer_pool_read_requests', '10000'],
      ['Innodb_buffer_pool_reads', '100'],
      ['Innodb_buffer_pool_pages_total', '8192'],
      ['Innodb_buffer_pool_pages_free', '2048'],
      ['Innodb_buffer_pool_pages_dirty', '12'],
      ['Uptime', '3600'],
      ['Com_select', '700'],
    ].map(([name, value]) => ({ Variable_name: name!, Value: value! })),
  );
  const variables = nameValueMap([
    { Variable_name: 'max_connections', Value: '151' },
    { Variable_name: 'innodb_buffer_pool_size', Value: String(128 * 1024 * 1024) },
  ]);

  it('builds the monitor from global status', () => {
    const snapshot = mysqlMonitorSnapshot(0, { status, variables, replicas: [], notices: [] });
    const tile = (id: string) => snapshot.tiles.find((t) => t.id === id);
    expect(snapshot.uptimeSeconds).toBe(3600);
    expect(tile('qps')).toMatchObject({ kind: 'rate', counter: 1000 });
    expect(tile('threads-connected')).toMatchObject({
      value: 5,
      detail: '2 running · 151 max · 9 peak',
    });
    expect(tile('buffer-pool-hit')).toMatchObject({ hits: 9900, total: 10000 });
    expect(tile('buffer-pool-used')).toMatchObject({
      value: 0.75,
      detail: '128.0 MB · 12 dirty pages',
    });
    expect(tile('replica-lag')).toMatchObject({ value: null, detail: 'not a replica' });
    expect(snapshot.sections[0]!.table.rows[0]).toEqual({ name: 'SELECT', value: 700 });
  });

  it('reads replica status of MySQL and MariaDB', () => {
    const mysql = mysqlMonitorSnapshot(0, {
      status,
      variables,
      replicas: [
        {
          Channel_Name: '',
          Source_Host: 'db1',
          Source_Port: 3306,
          Replica_IO_Running: 'Yes',
          Replica_SQL_Running: 'Yes',
          Seconds_Behind_Source: 3,
          Last_IO_Error: '',
          Last_SQL_Error: '',
        },
      ],
      notices: [],
    });
    expect(mysql.tiles.find((t) => t.id === 'replica-lag')).toMatchObject({
      value: 3,
      detail: 'IO Yes · SQL Yes',
    });
    expect(mysql.sections.find((s) => s.id === 'replication')!.table.rows[0]).toEqual({
      channel: 'default',
      source: 'db1:3306',
      io: 'Yes',
      sql: 'Yes',
      lag: 3,
      error: null,
    });
    const mariadb = mysqlMonitorSnapshot(0, {
      status,
      variables,
      replicas: [
        {
          Connection_name: 'eu',
          Master_Host: 'db2',
          Master_Port: 3307,
          Slave_IO_Running: 'No',
          Slave_SQL_Running: 'Yes',
          Seconds_Behind_Master: null,
          Last_IO_Error: 'boom',
        },
      ],
      notices: [],
    });
    expect(mariadb.sections.find((s) => s.id === 'replication')!.table.rows[0]).toMatchObject({
      channel: 'eu',
      io: 'No',
      lag: null,
      error: 'boom',
    });
    const hidden = mysqlMonitorSnapshot(0, { status, variables, replicas: null, notices: [] });
    expect(hidden.sections.find((s) => s.id === 'replication')!.notice).toBeDefined();
  });

  it('reads process list rows of both servers', () => {
    const blockers = new Map([['8', ['3']]]);
    expect(
      mysqlSession(
        {
          Id: 8,
          User: 'app',
          Host: '10.0.0.1:5000',
          db: 'shop',
          Command: 'Query',
          Time: 4,
          State: 'Waiting for table metadata lock',
          Info: 'ALTER TABLE t',
        },
        '99',
        blockers,
      ),
    ).toMatchObject({
      id: '8',
      state: 'Query',
      durationMs: 4000,
      wait: 'Waiting for table metadata lock',
      blockedBy: ['3'],
      own: false,
      idle: false,
      background: false,
    });
    expect(
      mysqlSession(
        {
          ID: 99,
          USER: 'root',
          HOST: 'localhost',
          DB: null,
          COMMAND: 'Sleep',
          TIME: 30,
          TIME_MS: 30123.4,
          STATE: '',
          INFO: null,
          PROGRESS: 0,
          MEMORY_USED: 1024,
          EXAMINED_ROWS: 0,
          QUERY_ID: 5,
        },
        '99',
        new Map(),
      ),
    ).toMatchObject({
      own: true,
      idle: true,
      durationMs: null,
      detail: { memory: 1024, queryId: '5' },
    });
    expect(
      mysqlSession(
        { Id: 5, User: 'event_scheduler', Host: 'localhost', Command: 'Daemon', Time: 1000 },
        '1',
        new Map(),
      ),
    ).toMatchObject({ background: true, durationMs: null });
  });

  it('reads statement digests', () => {
    expect(
      mysqlTopQuery({
        SCHEMA_NAME: 'shop',
        DIGEST: 'abc',
        DIGEST_TEXT: 'SELECT ? FROM t',
        COUNT_STAR: 10n,
        total_ms: '12.5000',
        mean_ms: '1.2500',
        max_ms: '3.0000',
        SUM_ROWS_SENT: 10,
        SUM_ROWS_EXAMINED: 100,
        QUERY_SAMPLE_TEXT: 'SELECT 1 FROM t',
      }),
    ).toMatchObject({
      id: 'shop:abc',
      calls: 10,
      totalMs: 12.5,
      meanMs: 1.25,
      maxMs: 3,
      rows: 10,
      detail: { rowsExamined: 100, sample: 'SELECT 1 FROM t' },
    });
  });

  it('tells MySQL roles and users apart, with their role grants', () => {
    const accounts = mysqlAccounts(
      [
        {
          user: 'app',
          host: '%',
          account_locked: 'N',
          password_expired: 'N',
          plugin: 'caching_sha2_password',
          no_password: 0,
          max_user_connections: 5,
          Super_priv: 'N',
        },
        {
          user: 'reader',
          host: '%',
          account_locked: 'Y',
          password_expired: 'Y',
          plugin: 'caching_sha2_password',
          no_password: 1,
          max_user_connections: 0,
          Super_priv: 'N',
        },
        { user: 'mysql.sys', host: 'localhost', account_locked: 'Y', no_password: 0 },
      ],
      [
        {
          FROM_USER: 'reader',
          FROM_HOST: '%',
          TO_USER: 'app',
          TO_HOST: '%',
          WITH_ADMIN_OPTION: 'Y',
        },
      ],
      'mysql',
    );
    expect(accounts[0]).toMatchObject({
      kind: 'user',
      canLogin: true,
      connectionLimit: 5,
      attributes: ['caching_sha2_password'],
      memberOf: [{ role: { name: 'reader', host: '%' }, admin: true }],
    });
    expect(accounts[1]).toMatchObject({ kind: 'role', host: '%', canLogin: false });
    expect(accounts[2]).toMatchObject({ kind: 'user', builtin: true, locked: true });
  });

  it('reads MariaDB roles without a host', () => {
    const accounts = mysqlAccounts(
      [
        { user: 'app', host: 'localhost', is_role: 'N', locked: 'true', Super_priv: 'Y' },
        { user: 'reader', host: '', is_role: 'Y' },
      ],
      [{ Host: 'localhost', User: 'app', Role: 'reader', Admin_option: 'N' }],
      'mariadb',
    );
    expect(accounts[0]).toMatchObject({
      host: 'localhost',
      locked: true,
      superuser: true,
      memberOf: [{ role: { name: 'reader' }, admin: false }],
    });
    expect(accounts[1]).toEqual(expect.objectContaining({ name: 'reader', kind: 'role' }));
    expect(accounts[1]!.host).toBeUndefined();
  });

  it('reads MariaDB variables with their scope and type', () => {
    const row = (scope: string, readOnly = 'NO') => ({
      VARIABLE_NAME: 'MAX_CONNECT_ERRORS',
      SESSION_VALUE: null,
      GLOBAL_VALUE: '100',
      GLOBAL_VALUE_ORIGIN: 'COMPILE-TIME',
      DEFAULT_VALUE: '100',
      VARIABLE_SCOPE: scope,
      VARIABLE_TYPE: 'BIGINT UNSIGNED',
      VARIABLE_COMMENT: 'Errors',
      NUMERIC_MIN_VALUE: '1',
      NUMERIC_MAX_VALUE: '4294967295',
      ENUM_VALUE_LIST: null,
      READ_ONLY: readOnly,
    });
    expect(mariadbSetting(row('GLOBAL'))).toMatchObject({
      name: 'max_connect_errors',
      value: '100',
      type: 'integer',
      source: 'compile-time',
      scopes: ['global'],
    });
    expect(mariadbSetting(row('SESSION')).scopes).toEqual(['global', 'session']);
    expect(mariadbSetting(row('GLOBAL', 'YES'))).toMatchObject({
      scopes: [],
      restartRequired: true,
    });
    expect(
      mariadbSetting({ ...row('SESSION'), VARIABLE_TYPE: 'ENUM', ENUM_VALUE_LIST: 'a,b' }),
    ).toMatchObject({ type: 'enum', enumValues: ['a', 'b'] });
  });

  it('reads MySQL variables with what variables_info adds', () => {
    expect(
      mysqlSetting(
        { Variable_name: 'max_connections', Value: '151' },
        { VARIABLE_SOURCE: 'COMPILED', MIN_VALUE: '1', MAX_VALUE: '100000' },
        true,
      ),
    ).toMatchObject({
      type: 'integer',
      min: '1',
      source: 'compiled',
      scopes: ['global', 'persist', 'session'],
    });
    expect(
      mysqlSetting({ Variable_name: 'autocommit', Value: 'ON' }, undefined, false),
    ).toMatchObject({
      type: 'bool',
      scopes: ['global', 'session'],
    });
  });

  it('reads global privileges from SHOW GRANTS', () => {
    expect([
      ...globalPrivileges([
        'GRANT PROCESS, SELECT ON *.* TO `u`@`%`',
        'GRANT ALL ON `shop`.* TO `u`@`%`',
      ]),
    ]).toEqual(['PROCESS', 'SELECT']);
    expect(
      globalPrivileges(['GRANT ALL PRIVILEGES ON *.* TO `root`@`localhost` WITH GRANT OPTION']).has(
        '*',
      ),
    ).toBe(true);
  });

  it('explains refusals', () => {
    const denied = new JoineryError({
      code: 'SQL_ERROR',
      message: 'Access denied',
      engineCode: 1227,
      sqlState: '42000',
    });
    expect(
      (
        enrichMysqlError(
          denied,
          { kind: 'setting', name: 'x', value: '1', scope: 'global' },
          'mysql',
        ) as JoineryError
      ).hint,
    ).toMatch(/SYSTEM_VARIABLES_ADMIN/);
    const notOwner = new JoineryError({
      code: 'SQL_ERROR',
      message: 'You are not owner of thread 5',
      engineCode: 1095,
    });
    expect(
      (
        enrichMysqlError(
          notOwner,
          { kind: 'session', operation: 'terminate', id: '5' },
          'mariadb',
        ) as JoineryError
      ).hint,
    ).toMatch(/CONNECTION ADMIN/);
  });
});
