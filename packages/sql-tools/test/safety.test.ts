import { connectionProfileSchema, type SqlDialect } from '@querybara/core';
import { describe, expect, it } from 'vitest';

import {
  analyzeStatement,
  checkStatementSafety,
  decideSafety,
  safetyPolicyFor,
  type StatementAnalysis,
  type StatementKind,
  type StatementRisk,
} from '../src';

type Case = [
  dialect: SqlDialect,
  text: string,
  kind: StatementKind,
  isWrite: boolean,
  risks: StatementRisk[],
];

const CASES: Case[] = [
  // Reads
  ['postgres', 'SELECT * FROM t', 'select', false, []],
  ['mysql', '(SELECT 1) UNION (SELECT 2)', 'select', false, []],
  ['postgres', 'VALUES (1), (2)', 'select', false, []],
  ['postgres', 'TABLE users', 'select', false, []],
  ['mysql', 'SHOW TABLES', 'other', false, []],
  ['mysql', 'CHECK TABLE t', 'other', false, []],
  ['postgres', 'WITH x AS (SELECT 1) SELECT * FROM x', 'select', false, []],
  ['mysql', 'SELECT a INTO @v FROM t LIMIT 1', 'select', false, []],
  [
    'postgres',
    'SELECT * FROM t WHERE id IN (SELECT id FROM u WHERE x FOR UPDATE)',
    'select',
    true,
    ['locks'],
  ],
  // Writes that read like selects
  ['postgres', 'SELECT a, b INTO new_table FROM t', 'select', true, []],
  ['mysql', "SELECT * INTO OUTFILE '/tmp/t.csv' FROM t", 'select', true, []],
  ['postgres', 'SELECT * FROM t WHERE id = 1 FOR UPDATE SKIP LOCKED', 'select', true, ['locks']],
  ['postgres', 'SELECT * FROM t FOR NO KEY UPDATE', 'select', true, ['locks']],
  ['mysql', 'SELECT * FROM t WHERE id = 1 LOCK IN SHARE MODE', 'select', true, ['locks']],
  ['postgres', 'SELECT substring(x FROM 1 FOR 2) FROM t', 'select', false, []],
  // DML
  ['mysql', 'INSERT INTO t VALUES (1) ON DUPLICATE KEY UPDATE a = 1', 'insert', true, []],
  ['mysql', 'REPLACE INTO t VALUES (1)', 'insert', true, []],
  ['mysql', "LOAD DATA LOCAL INFILE 'x.csv' INTO TABLE t", 'insert', true, []],
  ['postgres', 'COPY t FROM STDIN WITH (FORMAT csv)', 'insert', true, []],
  ['postgres', 'COPY (SELECT * FROM t) TO STDOUT', 'select', false, []],
  ['postgres', "COPY t TO '/tmp/t.csv'", 'select', true, []],
  ['postgres', 'UPDATE t SET a = 1 WHERE id = 2', 'update', true, []],
  ['postgres', 'UPDATE t SET a = 1', 'update', true, ['update-without-where']],
  [
    'postgres',
    'update t set a = (select b from u where u.id = t.id)',
    'update',
    true,
    ['update-without-where'],
  ],
  [
    'mysql',
    'UPDATE t1 JOIN t2 ON t1.id = t2.id SET t1.a = t2.a',
    'update',
    true,
    ['update-without-where'],
  ],
  ['mysql', 'UPDATE t SET a = 1 WHERE 1=1', 'update', true, ['update-without-where']],
  [
    'postgres',
    'UPDATE t SET a = 1 WHERE TRUE RETURNING *',
    'update',
    true,
    ['update-without-where'],
  ],
  ['mysql', 'UPDATE t SET a = 1 WHERE 1 = 1 AND id = 3', 'update', true, []],
  ['postgres', 'UPDATE t SET a = s.a FROM s WHERE s.id = t.id', 'update', true, []],
  ['postgres', 'DELETE FROM t', 'delete', true, ['delete-without-where']],
  ['postgres', 'DELETE FROM t WHERE CURRENT OF c', 'delete', true, []],
  ['postgres', 'DELETE FROM t USING s WHERE s.id = t.id', 'delete', true, []],
  ['postgres', 'DELETE FROM t USING s', 'delete', true, ['delete-without-where']],
  [
    'mysql',
    'DELETE t1, t2 FROM t1 INNER JOIN t2 ON t1.id = t2.id',
    'delete',
    true,
    ['delete-without-where'],
  ],
  ['mysql', 'DELETE t1 FROM t1 JOIN t2 ON t1.id = t2.id WHERE t2.x = 1', 'delete', true, []],
  ['mysql', 'DELETE FROM t ORDER BY id LIMIT 10', 'delete', true, ['delete-without-where']],
  ['postgres', 'MERGE INTO t USING s ON t.id = s.id WHEN MATCHED THEN DELETE', 'merge', true, []],
  // CTEs
  [
    'mysql',
    'WITH old AS (SELECT id FROM t WHERE x < 1) DELETE FROM t WHERE id IN (SELECT id FROM old)',
    'delete',
    true,
    [],
  ],
  ['mysql', 'WITH c AS (SELECT 1) UPDATE t SET a = 1', 'update', true, ['update-without-where']],
  [
    'postgres',
    'WITH moved AS (DELETE FROM a RETURNING *) INSERT INTO b SELECT * FROM moved',
    'insert',
    true,
    ['delete-without-where'],
  ],
  ['postgres', 'WITH d AS (DELETE FROM a WHERE x RETURNING *) SELECT * FROM d', 'select', true, []],
  ['postgres', 'WITH e AS () SELECT 1', 'select', false, []],
  [
    'postgres',
    'WITH RECURSIVE t(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM t) SELECT * FROM t',
    'select',
    false,
    [],
  ],
  [
    'postgres',
    'WITH u AS MATERIALIZED (UPDATE t SET a = 1 RETURNING *) SELECT 1',
    'select',
    true,
    ['update-without-where'],
  ],
  // EXPLAIN
  ['postgres', 'EXPLAIN SELECT * FROM t', 'explain', false, []],
  ['postgres', 'EXPLAIN DELETE FROM t', 'explain', false, []],
  ['postgres', 'EXPLAIN ANALYZE DELETE FROM t WHERE id = 1', 'explain', true, ['explain-analyze']],
  [
    'postgres',
    'EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) UPDATE t SET a = 1',
    'explain',
    true,
    ['update-without-where', 'explain-analyze'],
  ],
  ['postgres', 'EXPLAIN (ANALYZE false) DELETE FROM t', 'explain', false, []],
  ['postgres', 'EXPLAIN ANALYZE SELECT * FROM t', 'explain', false, []],
  ['mysql', 'EXPLAIN FORMAT=JSON DELETE FROM t', 'explain', false, []],
  ['mysql', 'EXPLAIN ANALYZE DELETE FROM t WHERE id = 1', 'explain', true, ['explain-analyze']],
  ['mysql', 'DESCRIBE users', 'explain', false, []],
  ['mariadb', 'ANALYZE DELETE FROM t WHERE id = 1', 'explain', true, ['explain-analyze']],
  ['mariadb', 'ANALYZE FORMAT=JSON SELECT * FROM t', 'explain', false, []],
  ['mariadb', 'ANALYZE TABLE t', 'other', true, []],
  ['postgres', 'ANALYZE t', 'other', true, []],
  // DDL and DCL
  ['postgres', 'CREATE TABLE t (id int)', 'ddl', true, []],
  ['postgres', 'CREATE OR REPLACE VIEW v AS SELECT 1', 'ddl', true, []],
  ['mariadb', 'CREATE OR REPLACE TABLE t (id int)', 'ddl', true, ['drop']],
  ['mysql', 'DROP TABLE IF EXISTS t', 'ddl', true, ['drop']],
  ['postgres', 'drop schema app cascade', 'ddl', true, ['drop']],
  ['mysql', 'TRUNCATE TABLE logs', 'ddl', true, ['truncate']],
  ['mysql', 'ALTER TABLE t ADD COLUMN c int', 'ddl', true, ['alter']],
  ['mysql', 'ALTER TABLE t DROP COLUMN c', 'ddl', true, ['alter', 'drop']],
  ['mysql', 'ALTER TABLE t DROP c', 'ddl', true, ['alter', 'drop']],
  ['postgres', 'ALTER TABLE t DROP "Col"', 'ddl', true, ['alter', 'drop']],
  ['mysql', 'ALTER TABLE t DROP PARTITION p2019', 'ddl', true, ['alter', 'drop']],
  ['mysql', 'ALTER TABLE t TRUNCATE PARTITION p2019', 'ddl', true, ['alter', 'truncate']],
  [
    'postgres',
    'ALTER TABLE t ALTER COLUMN c DROP DEFAULT, DROP CONSTRAINT fk',
    'ddl',
    true,
    ['alter'],
  ],
  ['mysql', 'RENAME TABLE a TO b', 'ddl', true, ['alter']],
  ['postgres', "COMMENT ON TABLE t IS 'x'", 'ddl', true, []],
  ['mysql', "CREATE USER 'app'@'%' IDENTIFIED BY 'x'", 'dcl', true, []],
  ['postgres', 'DROP ROLE app', 'dcl', true, ['drop']],
  ['postgres', 'ALTER ROLE app WITH LOGIN', 'dcl', true, ['alter']],
  ['mysql', 'GRANT SELECT ON db.* TO app', 'dcl', true, []],
  ['postgres', 'REVOKE ALL ON t FROM app', 'dcl', true, []],
  ['mysql', "SET PASSWORD FOR app = 'x'", 'dcl', true, []],
  // Routines
  ['mysql', 'CALL refresh_totals()', 'call', true, ['unknown-effects']],
  ['postgres', 'DO $$ BEGIN DELETE FROM t; END $$', 'call', true, ['unknown-effects']],
  ['postgres', 'EXECUTE stmt(1)', 'call', true, ['unknown-effects']],
  ['mysql', 'DO SLEEP(1)', 'other', false, []],
  ['mariadb', 'BEGIN NOT ATOMIC SELECT 1; END', 'call', true, ['unknown-effects']],
  // Transactions and sessions
  ['postgres', 'BEGIN', 'transaction', false, []],
  ['mysql', 'START TRANSACTION READ ONLY', 'transaction', false, []],
  ['postgres', 'COMMIT', 'transaction', false, []],
  ['postgres', 'ROLLBACK TO SAVEPOINT a', 'transaction', false, []],
  ['postgres', 'SET TRANSACTION ISOLATION LEVEL SERIALIZABLE', 'transaction', false, []],
  ['mysql', 'LOCK TABLES t WRITE', 'transaction', true, ['locks']],
  ['mysql', 'UNLOCK TABLES', 'transaction', false, []],
  ['mysql', 'SET NAMES utf8mb4', 'session', false, []],
  ['postgres', 'SET search_path TO app, public', 'session', false, []],
  ['mysql', 'SET @x = (SELECT 1)', 'session', false, []],
  ['mysql', 'SET GLOBAL max_connections = 500', 'session', true, ['server-config']],
  ['mysql', 'SET @@global.read_only = 1', 'session', true, ['server-config']],
  ['postgres', "ALTER SYSTEM SET work_mem = '64MB'", 'other', true, ['server-config']],
  ['postgres', 'RESET search_path', 'session', false, []],
  ['mysql', 'RESET MASTER', 'other', true, []],
  ['mysql', 'USE shop', 'session', false, []],
  ['mysql', 'START REPLICA', 'other', true, []],
  // Maintenance and the unknown
  ['postgres', 'VACUUM (ANALYZE) t', 'other', true, []],
  ['mysql', 'OPTIMIZE TABLE t', 'other', true, []],
  ['mysql', 'KILL 42', 'other', true, []],
  ['postgres', 'FROBNICATE everything', 'other', true, []],
  // MySQL executable comments run as SQL
  ['mysql', '/*!40101 SET NAMES utf8 */', 'session', false, []],
  ['mysql', '/*!40000 ALTER TABLE `t` DISABLE KEYS */', 'ddl', true, ['alter']],
  ['mysql', '/*!50003 DROP PROCEDURE IF EXISTS `p` */', 'ddl', true, ['drop']],
  // Comments and case do not matter
  [
    'postgres',
    '/* cleanup */ -- all rows\n delete\nfrom t',
    'delete',
    true,
    ['delete-without-where'],
  ],
];

describe('analyzeStatement', () => {
  it.each(CASES)('%s: %s', (dialect, text, kind, isWrite, risks) => {
    expect(analyzeStatement(text, dialect)).toEqual({ kind, isWrite, risks });
  });

  it('treats empty and comment-only text as harmless', () => {
    expect(analyzeStatement('  -- nothing', 'mysql')).toEqual({
      kind: 'other',
      isWrite: false,
      risks: [],
    });
  });
});

describe('decideSafety', () => {
  const dev = { readOnly: false, production: false };
  const production = { readOnly: false, production: true };
  const readOnly = { readOnly: true, production: false };
  const analysis = (text: string): StatementAnalysis => analyzeStatement(text, 'postgres');

  it('runs reads and ordinary writes on dev profiles', () => {
    expect(decideSafety(analysis('SELECT 1'), dev)).toEqual({ action: 'run' });
    expect(decideSafety(analysis('UPDATE t SET a = 1 WHERE id = 1'), dev)).toEqual({
      action: 'run',
    });
  });

  it('asks before destructive statements on every profile', () => {
    expect(decideSafety(analysis('DELETE FROM t'), dev)).toEqual({
      action: 'confirm',
      reasons: ['delete-without-where'],
    });
    expect(decideSafety(analysis('DROP TABLE t'), dev)).toEqual({
      action: 'confirm',
      reasons: ['drop'],
    });
    expect(decideSafety(analysis('TRUNCATE t'), dev)).toEqual({
      action: 'confirm',
      reasons: ['truncate'],
    });
    expect(decideSafety(analysis('EXPLAIN ANALYZE DELETE FROM t WHERE id = 1'), dev)).toEqual({
      action: 'confirm',
      reasons: ['explain-analyze'],
    });
  });

  it('asks before every write on production, with the destructive reasons first', () => {
    expect(decideSafety(analysis('SELECT 1'), production)).toEqual({ action: 'run' });
    expect(decideSafety(analysis('INSERT INTO t VALUES (1)'), production)).toEqual({
      action: 'confirm',
      reasons: ['write'],
    });
    expect(decideSafety(analysis('UPDATE t SET a = 1'), production)).toEqual({
      action: 'confirm',
      reasons: ['update-without-where', 'write'],
    });
    expect(decideSafety(analysis('CALL p()'), production)).toEqual({
      action: 'confirm',
      reasons: ['write'],
    });
  });

  it('honours the confirmWrites switch like production', () => {
    expect(
      decideSafety(analysis('INSERT INTO t VALUES (1)'), { ...dev, confirmWrites: true }),
    ).toEqual({
      action: 'confirm',
      reasons: ['write'],
    });
  });

  it('refuses writes on read-only profiles', () => {
    expect(decideSafety(analysis('SELECT 1'), readOnly)).toEqual({ action: 'run' });
    expect(decideSafety(analysis('INSERT INTO t VALUES (1)'), readOnly)).toEqual({
      action: 'refuse',
      reason: 'read-only',
    });
    expect(decideSafety(analysis('SELECT * FROM t FOR UPDATE'), readOnly).action).toBe('refuse');
    expect(decideSafety(analysis('EXPLAIN ANALYZE SELECT 1'), readOnly).action).toBe('run');
  });

  it('checks a statement in one call', () => {
    expect(checkStatementSafety('DELETE FROM t', 'mysql', dev)).toEqual({
      action: 'confirm',
      reasons: ['delete-without-where'],
    });
  });
});

describe('safetyPolicyFor', () => {
  const base = {
    id: 'p1',
    name: 'Shop',
    engine: 'postgres',
    endpoint: { kind: 'host', host: 'db', port: 5432 },
    createdAt: '2026-09-29T00:00:00Z',
    updatedAt: '2026-09-29T00:00:00Z',
  } as const;

  it('derives the policy from the profile presentation', () => {
    expect(safetyPolicyFor(connectionProfileSchema.parse(base))).toEqual({
      readOnly: false,
      production: false,
      confirmWrites: false,
    });
    const production = connectionProfileSchema.parse({
      ...base,
      presentation: { environment: 'production', readOnly: true },
    });
    expect(safetyPolicyFor(production)).toEqual({
      readOnly: true,
      production: true,
      confirmWrites: true,
    });
  });
});
