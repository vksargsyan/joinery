import type { SqlDialect } from '@querybara/core';
import { beforeAll, describe, expect, it } from 'vitest';

import { diagnose } from '../src';

/** The flagged text of each diagnostic. */
async function flagged(text: string, dialect: SqlDialect): Promise<string[]> {
  return (await diagnose(text, dialect)).map((d) => text.slice(d.start, d.end));
}

beforeAll(async () => {
  // Loading and warming each grammar takes a few seconds under Vitest's transform.
  await Promise.all([diagnose('', 'mysql'), diagnose('', 'postgres')]);
}, 60_000);

const VALID: [SqlDialect, string][] = [
  [
    'mysql',
    'SELECT u.id, COUNT(o.id) FROM users u LEFT JOIN orders o ON o.user_id = u.id GROUP BY u.id',
  ],
  ['mysql', 'INSERT INTO t (a, b) VALUES (1, 2) ON DUPLICATE KEY UPDATE b = VALUES(b)'],
  [
    'mysql',
    'WITH RECURSIVE t(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM t WHERE n < 5) SELECT * FROM t',
  ],
  ['mysql', "SELECT data->>'$.name' FROM people WHERE id = ? AND name = :name LIMIT ?, ?"],
  ['mysql', "SELECT * FROM t WHERE MATCH (a, b) AGAINST ('x' IN BOOLEAN MODE)"],
  ['mysql', 'SELECT * FROM t WHERE id = 1 FOR UPDATE NOWAIT'],
  ['mysql', 'SELECT CAST(x AS DOUBLE), CAST(y AS FLOAT) FROM t'],
  ['mysql', '/*!40101 SET NAMES utf8mb4 */;\nLOCK TABLES `t` WRITE;\nUNLOCK TABLES;'],
  [
    'mysql',
    'DELIMITER $$\nCREATE PROCEDURE p(IN n INT)\nBEGIN\n  DECLARE i INT DEFAULT 0;\n  SELECT n + i;\nEND$$\nDELIMITER ;\nCALL p(1);',
  ],
  [
    'mariadb',
    'CREATE SEQUENCE s START WITH 1; SELECT NEXT VALUE FOR s; DELETE FROM t WHERE id = 1 RETURNING id',
  ],
  ['mariadb', 'CREATE OR REPLACE TABLE t (a INT); ALTER TABLE t ADD COLUMN IF NOT EXISTS b INT'],
  [
    'mariadb',
    'SELECT * FROM t FOR SYSTEM_TIME AS OF TIMESTAMP NOW(); VALUES (1, 2); ANALYZE SELECT 1',
  ],
  ['mariadb', 'SELECT CAST(a AS INTEGER) FROM t'],
  ['postgres', 'SELECT * FROM users WHERE id = $1 AND name = :name'],
  ['postgres', "SELECT data->>'name', data @> '{\"x\":1}'::jsonb, data ? 'k' FROM people"],
  ['postgres', 'SELECT * FROM t WHERE id = ANY($1::int[]) AND x IS NOT TRUE AND y IS UNKNOWN'],
  ['postgres', "SELECT * FROM t WHERE a LIKE ANY (ARRAY['a%']) AND b <> ALL (SELECT b FROM u)"],
  ['postgres', "SELECT U&'d\\0061t', E'it\\'s', e'\\n', 'it''s', $tag$ x $tag$"],
  [
    'postgres',
    'INSERT INTO t (a) VALUES (1) ON CONFLICT (a) DO UPDATE SET a = EXCLUDED.a RETURNING *',
  ],
  [
    'postgres',
    'WITH moved AS (DELETE FROM a WHERE x RETURNING *) INSERT INTO b SELECT * FROM moved',
  ],
  [
    'postgres',
    'CREATE FUNCTION f() RETURNS trigger LANGUAGE plpgsql AS $body$ BEGIN NEW.x := now(); RETURN NEW; END; $body$',
  ],
  ['postgres', 'CREATE FUNCTION g(a int) RETURNS int LANGUAGE sql BEGIN ATOMIC SELECT a + 1; END'],
  ['postgres', '-- just a comment\n/* and another */'],
];

describe('diagnose', () => {
  it.each(VALID)('%s: no errors for %s', async (dialect, text) => {
    expect(await diagnose(text, dialect)).toEqual([]);
  });

  it('flags the offending token with a readable message', async () => {
    const [diagnostic] = await diagnose('SELECT * FORM t', 'mysql');
    expect(diagnostic).toMatchObject({ start: 9, end: 13, severity: 'error' });
    expect(diagnostic!.message).toMatch(/'FORM' is not valid at this position/);
    expect(await flagged('SELEC 1', 'postgres')).toEqual(['SELEC']);
    expect(await flagged('INSERT INTO t (a, b VALUES (1, 2)', 'postgres')).toEqual(['VALUES']);
  });

  it('marks the last token of an incomplete statement', async () => {
    const [diagnostic] = await diagnose('SELECT * FROM t WHERE', 'postgres');
    expect(diagnostic!.message).toMatch(/incomplete/i);
    expect(await flagged('SELECT * FROM t WHERE', 'mysql')).toEqual(['WHERE']);
  });

  it('reports one error per statement, at script offsets', async () => {
    const script = 'SELECT 1;\nSELECT * FORM t;\nSELECT 2;\nUPDATE t SET WHERE id = 1;';
    expect(await flagged(script, 'postgres')).toEqual(['FORM', 'WHERE']);
  });

  it('finds errors inside DELIMITER-delimited routines', async () => {
    const script =
      'DELIMITER $$\nCREATE PROCEDURE p()\nBEGIN\n  SELECT 1 FROM;\nEND$$\nDELIMITER ;';
    const diagnostics = await diagnose(script, 'mysql');
    expect(diagnostics).toHaveLength(1);
    expect(script.slice(diagnostics[0]!.start, diagnostics[0]!.end)).toBe(';');
  });

  it('maps positions past astral characters and CRLF line breaks', async () => {
    expect(await flagged("SELECT '😀😀', 1 FORM t", 'postgres')).toEqual(['t']);
    expect(await flagged("SELECT 'é'\r\nFROM t\r\nORDER tt", 'mysql')).toEqual(['tt']);
  });

  it('still checks MariaDB statements that use MySQL syntax', async () => {
    expect(await flagged('SELECT * FORM t', 'mariadb')).toEqual(['FORM']);
  });

  it('never rejects on garbage', async () => {
    for (const text of ["'", '/*', '$$', ')))', '\u0000\uD800', 'SELECT ((((((((((']) {
      for (const dialect of ['mysql', 'postgres'] as const) {
        await expect(diagnose(text, dialect)).resolves.toBeInstanceOf(Array);
      }
    }
  });
});
