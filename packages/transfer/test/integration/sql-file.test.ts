import type { Session } from '@querybara/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { bytesSource, runSqlFile } from '../../src';
import { ScratchDatabases, configuredServers, query } from './helpers';

/**
 * Run SQL file: DELIMITER blocks on MySQL and MariaDB, dollar-quoted bodies on PostgreSQL,
 * stop versus continue on errors, a single transaction and cancellation.
 */

const SERVERS = configuredServers();

const MYSQL_SCRIPT = `-- routines with their own delimiter
CREATE TABLE counters (id int PRIMARY KEY, hits int NOT NULL DEFAULT 0);
INSERT INTO counters (id) VALUES (1), (2);

DELIMITER $$
CREATE PROCEDURE bump(IN which int)
BEGIN
  UPDATE counters SET hits = hits + 1 WHERE id = which;
  SELECT hits FROM counters WHERE id = which;
END $$

CREATE FUNCTION doubled(n int) RETURNS int DETERMINISTIC
BEGIN
  DECLARE result int;
  SET result = n * 2; -- a semicolon inside the body
  RETURN result;
END$$

CREATE TRIGGER counters_guard BEFORE UPDATE ON counters FOR EACH ROW
BEGIN
  IF NEW.hits > 100 THEN SET NEW.hits = 100; END IF;
END $$
DELIMITER ;

CALL bump(1);
CALL bump(1);
SELECT doubled(21) AS answer;
/* a trailing comment */
`;

const PG_SCRIPT = `CREATE TABLE counters (id int PRIMARY KEY, hits int NOT NULL DEFAULT 0);
INSERT INTO counters (id) VALUES (1), (2);

CREATE FUNCTION bump(which int) RETURNS int LANGUAGE plpgsql AS $fn$
DECLARE
  result int;
BEGIN
  -- $$ and ; inside the body do not end it
  UPDATE counters SET hits = hits + 1 WHERE id = which RETURNING hits INTO result;
  RAISE NOTICE 'bumped %; done', which;
  RETURN result;
END;
$fn$;

CREATE FUNCTION doubled(n int) RETURNS int LANGUAGE sql IMMUTABLE
BEGIN ATOMIC
  SELECT n * 2;
END;

DO $$
BEGIN
  PERFORM bump(1);
  PERFORM bump(1);
END
$$;

SELECT doubled(21) AS answer;
`;

describe.skipIf(SERVERS.length === 0)('runSqlFile', () => {
  for (const server of SERVERS) {
    describe(server.engine, () => {
      let dbs: ScratchDatabases;
      let session: Session;

      beforeAll(async () => {
        dbs = new ScratchDatabases(server);
        session = await dbs.create('sql_file');
      });

      afterAll(async () => {
        await dbs?.dropAll();
      });

      it(
        server.engine === 'postgres'
          ? 'runs dollar-quoted functions and DO blocks'
          : 'runs DELIMITER blocks',
        async () => {
          const script = server.engine === 'postgres' ? PG_SCRIPT : MYSQL_SCRIPT;
          const summary = await runSqlFile({ session, source: bytesSource(script, 7) });
          expect(summary.errors).toEqual([]);
          expect(summary.status).toBe('completed');
          expect(summary.statements).toBe(server.engine === 'postgres' ? 6 : 8);
          expect(await query(session, 'SELECT hits FROM counters ORDER BY id')).toEqual([[2], [0]]);
          expect(await query(session, 'SELECT doubled(4)')).toEqual([[8]]);
          if (server.engine !== 'postgres') {
            await query(session, 'UPDATE counters SET hits = 500 WHERE id = 2');
            expect(await query(session, 'SELECT hits FROM counters WHERE id = 2')).toEqual([[100]]);
          }
        },
      );

      it('stops at the first error with its statement and line, or continues past it', async () => {
        const script = [
          'CREATE TABLE notes (id int PRIMARY KEY, body varchar(10));',
          "INSERT INTO notes VALUES (1, 'a');",
          "INSERT INTO notes VALUES (1, 'duplicate');",
          'INSERT INTO nowhere VALUES (1);',
          "INSERT INTO notes VALUES (2, 'b');",
        ].join('\n');
        const stopped = await runSqlFile({ session, source: bytesSource(script) });
        expect(stopped).toMatchObject({ status: 'failed', statements: 3, failed: 1 });
        expect(stopped.errors[0]).toMatchObject({ statement: 3, line: 3, column: 1 });
        expect(stopped.errors[0]!.text).toBe("INSERT INTO notes VALUES (1, 'duplicate')");
        await query(session, 'DROP TABLE notes');

        const continued = await runSqlFile({
          session,
          source: bytesSource(script),
          onError: 'continue',
        });
        expect(continued).toMatchObject({ status: 'completed', statements: 5, failed: 2 });
        expect(continued.errors.map((e) => e.line)).toEqual([3, 4]);
        expect(await query(session, 'SELECT id FROM notes ORDER BY id')).toEqual([[1], [2]]);
        await query(session, 'DROP TABLE notes');
      });

      it('runs in a single transaction: rolled back on stop, kept when continuing', async () => {
        await query(session, 'CREATE TABLE ledger (id int PRIMARY KEY)');
        const script =
          'INSERT INTO ledger VALUES (1);\nINSERT INTO ledger VALUES (1);\nINSERT INTO ledger VALUES (2);\n';
        const stopped = await runSqlFile({
          session,
          source: bytesSource(script),
          transaction: 'single',
        });
        expect(stopped.status).toBe('failed');
        expect(await query(session, 'SELECT id FROM ledger')).toEqual([]);
        const continued = await runSqlFile({
          session,
          source: bytesSource(script),
          transaction: 'single',
          onError: 'continue',
        });
        expect(continued).toMatchObject({ status: 'completed', failed: 1 });
        expect(await query(session, 'SELECT id FROM ledger ORDER BY id')).toEqual([[1], [2]]);
        expect(session.inTransaction).toBe(false);
      });

      it('cancels a running statement', async () => {
        const controller = new AbortController();
        const sleep = server.engine === 'postgres' ? 'SELECT pg_sleep(30);' : 'SELECT SLEEP(30);';
        const started = Date.now();
        setTimeout(() => controller.abort(), 300);
        const summary = await runSqlFile({
          session,
          source: bytesSource(`SELECT 1;\n${sleep}\nSELECT 2;`),
          signal: controller.signal,
        });
        expect(summary.status).toBe('cancelled');
        expect(summary.statements).toBe(2);
        expect(Date.now() - started).toBeLessThan(10_000);
        expect(await query(session, 'SELECT 3')).toEqual([[3]]);
      });
    });
  }
});
