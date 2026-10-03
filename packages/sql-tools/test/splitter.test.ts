import type { SqlDialect } from '@querybara/core';
import { describe, expect, it } from 'vitest';

import { StatementSplitter, splitStatements, statementAt, type SqlStatement } from '../src';

function texts(text: string, dialect: SqlDialect): string[] {
  return splitStatements(text, dialect).map((statement) => statement.text);
}

/** Splits `text` pushed in chunks of `size` characters. */
function splitInChunks(text: string, dialect: SqlDialect, size: number): SqlStatement[] {
  const splitter = new StatementSplitter(dialect);
  const out: SqlStatement[] = [];
  for (let i = 0; i < text.length; i += size) out.push(...splitter.push(text.slice(i, i + size)));
  out.push(...splitter.end());
  return out;
}

const MYSQLDUMP = `-- MySQL dump 10.13  Distrib 8.0.36, for Linux (x86_64)
--
-- Host: localhost    Database: shop
-- ------------------------------------------------------
-- Server version	8.0.36

/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;
/*!40101 SET NAMES utf8mb4 */;
/*!40103 SET @OLD_TIME_ZONE=@@TIME_ZONE */;
/*!40103 SET TIME_ZONE='+00:00' */;

--
-- Table structure for table \`orders\`
--

DROP TABLE IF EXISTS \`orders\`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
CREATE TABLE \`orders\` (
  \`id\` int NOT NULL AUTO_INCREMENT,
  \`note\` varchar(255) DEFAULT 'n/a; none' COMMENT 'free text; may contain ;',
  PRIMARY KEY (\`id\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
/*!40101 SET character_set_client = @saved_cs_client */;

LOCK TABLES \`orders\` WRITE;
/*!40000 ALTER TABLE \`orders\` DISABLE KEYS */;
INSERT INTO \`orders\` VALUES (1,'it\\'s; fine'),(2,'back\\\\slash'),(3,'semi;colon \\"quoted\\"'),(4,'日本語;テキスト 😀');
/*!40000 ALTER TABLE \`orders\` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Dumping routines for database 'shop'
--
/*!50003 DROP PROCEDURE IF EXISTS \`order_count\` */;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
DELIMITER ;;
CREATE DEFINER=\`root\`@\`localhost\` PROCEDURE \`order_count\`(OUT total INT)
BEGIN
  -- count; everything
  SELECT COUNT(*) INTO total FROM orders WHERE note <> ';';
END ;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!40103 SET TIME_ZONE=@OLD_TIME_ZONE */;

-- Dump completed on 2026-09-29 10:00:00
`;

describe('splitStatements', () => {
  it('splits on semicolons and trims, excluding the delimiter', () => {
    const text = '  SELECT 1 ;\n\nSELECT 2;SELECT 3  ';
    expect(splitStatements(text, 'postgres')).toEqual([
      { text: 'SELECT 1', start: 2, end: 10, line: 1, column: 3, delimiter: ';' },
      { text: 'SELECT 2', start: 14, end: 22, line: 3, column: 1, delimiter: ';' },
      { text: 'SELECT 3', start: 23, end: 31, line: 3, column: 10, delimiter: '' },
    ]);
  });

  it('skips empty and comment-only statements', () => {
    expect(texts(';;  ; -- nothing\n; /* nada */ ;SELECT 1;;', 'mysql')).toEqual(['SELECT 1']);
    expect(texts('', 'postgres')).toEqual([]);
    expect(texts('-- only a comment', 'postgres')).toEqual([]);
  });

  it('leaves leading and trailing comments out of the statement, keeps inner ones', () => {
    const text = '-- header\n/* doc */ SELECT 1 /* inner */ + 2 -- tail\n;';
    expect(texts(text, 'postgres')).toEqual(['SELECT 1 /* inner */ + 2']);
  });

  it('counts lines across \\n, \\r\\n and \\r', () => {
    const statements = splitStatements('SELECT 1;\r\nSELECT 2;\rSELECT 3;\n  SELECT 4;', 'mysql');
    expect(statements.map(({ line, column }) => [line, column])).toEqual([
      [1, 1],
      [2, 1],
      [3, 1],
      [4, 3],
    ]);
  });

  it('measures columns in UTF-16 code units', () => {
    const [, second] = splitStatements("SELECT '😀';SELECT 2", 'postgres');
    expect(second).toMatchObject({ start: 12, line: 1, column: 13 });
  });

  it('ignores delimiters inside strings, identifiers and comments', () => {
    expect(
      texts(
        `SELECT 'a;b', "c;d", \`e;f\` /* g; */ -- h;\n FROM t; # i;\nSELECT 'it\\'s;';`,
        'mysql',
      ),
    ).toEqual([`SELECT 'a;b', "c;d", \`e;f\` /* g; */ -- h;\n FROM t`, "SELECT 'it\\'s;'"]);
    expect(
      texts(`SELECT 'a;b''c;', E'd\\';', "e;""f" /* /* g; */ h; */ FROM t; SELECT 2`, 'postgres'),
    ).toEqual([`SELECT 'a;b''c;', E'd\\';', "e;""f" /* /* g; */ h; */ FROM t`, 'SELECT 2']);
  });

  it('keeps a statement whose unterminated string runs to the end', () => {
    expect(texts("SELECT 1; SELECT 'oops; SELECT 3;", 'mysql')).toEqual([
      'SELECT 1',
      "SELECT 'oops; SELECT 3;",
    ]);
  });

  it('keeps unicode intact', () => {
    expect(texts("INSERT INTO 表 VALUES ('données;😀'); SELECT 'ok'", 'mariadb')).toEqual([
      "INSERT INTO 表 VALUES ('données;😀')",
      "SELECT 'ok'",
    ]);
  });
});

describe('MySQL scripts', () => {
  it('splits a mysqldump file', () => {
    const statements = texts(MYSQLDUMP, 'mysql');
    expect(statements).toHaveLength(18);
    expect(statements[0]).toBe('/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */');
    expect(statements).toContain('DROP TABLE IF EXISTS `orders`');
    expect(statements.find((s) => s.startsWith('CREATE TABLE'))).toMatch(
      /ENGINE=InnoDB DEFAULT CHARSET=utf8mb4$/,
    );
    expect(statements.find((s) => s.startsWith('INSERT'))).toMatch(/'日本語;テキスト 😀'\)$/);
    expect(statements).toContain('/*!50003 SET @saved_sql_mode       = @@sql_mode */');
    const procedure = statements.find((s) => s.startsWith('CREATE DEFINER'));
    expect(procedure).toMatch(/^CREATE DEFINER=`root`@`localhost` PROCEDURE[\s\S]*END$/);
    expect(procedure).toContain("WHERE note <> ';';");
    expect(statements.at(-1)).toBe('/*!40103 SET TIME_ZONE=@OLD_TIME_ZONE */');
    expect(statements.some((s) => /DELIMITER/i.test(s))).toBe(false);
  });

  it('reports which delimiter ended each statement', () => {
    const statements = splitStatements(MYSQLDUMP, 'mysql');
    const procedure = statements.find((s) => s.text.startsWith('CREATE DEFINER'))!;
    expect(procedure.delimiter).toBe(';;');
    expect(statements[0]!.delimiter).toBe(';');
  });

  it('handles DELIMITER $$ stored programs', () => {
    const script = `DELIMITER $$
CREATE PROCEDURE p(IN n INT)
BEGIN
  DECLARE i INT DEFAULT 0;
  WHILE i < n DO
    INSERT INTO t VALUES (i, 'a;b');
    SET i = i + 1;
  END WHILE;
END$$

CREATE TRIGGER trg BEFORE INSERT ON t FOR EACH ROW
BEGIN
  SET NEW.created = NOW();
END $$
delimiter ;
CALL p(3);
SELECT 1`;
    const statements = splitStatements(script, 'mysql');
    expect(statements.map((s) => s.text.split('\n')[0])).toEqual([
      'CREATE PROCEDURE p(IN n INT)',
      'CREATE TRIGGER trg BEFORE INSERT ON t FOR EACH ROW',
      'CALL p(3)',
      'SELECT 1',
    ]);
    expect(statements[0]!.text.endsWith('END WHILE;\nEND')).toBe(true);
    expect(statements[0]).toMatchObject({ line: 2, column: 1, delimiter: '$$' });
    expect(statements[2]).toMatchObject({ line: 16, delimiter: ';' });
  });

  it('handles DELIMITER // and delimiters glued to words', () => {
    expect(texts('DELIMITER //\nSELECT 1//SELECT 2 //\nDELIMITER ;\nSELECT 3;', 'mariadb')).toEqual(
      ['SELECT 1', 'SELECT 2', 'SELECT 3'],
    );
  });

  it('ends a pending statement at a DELIMITER command', () => {
    expect(texts('SELECT 1;\n-- next\nDELIMITER $$\nSELECT 2$$', 'mysql')).toEqual([
      'SELECT 1',
      'SELECT 2',
    ]);
  });

  it('keeps DELIMITER text that is not a command inside the statement', () => {
    expect(texts('SELECT a,\ndelimiter x\nFROM t;', 'mysql')).toEqual([
      'SELECT a,\ndelimiter x\nFROM t',
    ]);
  });

  it('splits a procedure without DELIMITER at its inner semicolons, like the mysql client', () => {
    expect(texts('CREATE PROCEDURE p() BEGIN SELECT 1; END;', 'mysql')).toEqual([
      'CREATE PROCEDURE p() BEGIN SELECT 1',
      'END',
    ]);
  });

  it('does not nest comments', () => {
    expect(texts('/* a /* b */ SELECT 1; */', 'mysql')).toEqual(['SELECT 1', '*/']);
  });
});

describe('PostgreSQL scripts', () => {
  it('keeps dollar-quoted function bodies whole', () => {
    const script = `CREATE OR REPLACE FUNCTION public.touch() RETURNS trigger
LANGUAGE plpgsql AS $body$
BEGIN
  NEW.updated_at := now(); -- stamp; always
  RAISE NOTICE 'done; %', $$quoted$$;
  RETURN NEW;
END;
$body$;

CREATE FUNCTION add(a int, b int) RETURNS int AS $$ SELECT a + b; $$ LANGUAGE sql IMMUTABLE;

DO $$
BEGIN
  PERFORM 1;
END
$$;
SELECT $1::int, x FROM t WHERE y = $2;`;
    const statements = texts(script, 'postgres');
    expect(statements).toHaveLength(4);
    expect(statements[0]).toMatch(/^CREATE OR REPLACE FUNCTION[\s\S]*\$body\$$/);
    expect(statements[1]).toBe(
      'CREATE FUNCTION add(a int, b int) RETURNS int AS $$ SELECT a + b; $$ LANGUAGE sql IMMUTABLE',
    );
    expect(statements[2]).toBe('DO $$\nBEGIN\n  PERFORM 1;\nEND\n$$');
    expect(statements[3]).toBe('SELECT $1::int, x FROM t WHERE y = $2');
  });

  it('keeps SQL-standard BEGIN ATOMIC bodies whole, CASE ... END included', () => {
    const script = `CREATE FUNCTION grade(score int) RETURNS text LANGUAGE sql
BEGIN ATOMIC
  SELECT CASE WHEN score > 90 THEN 'A' ELSE 'B' END;
  INSERT INTO audit VALUES (score);
END;
CREATE OR REPLACE PROCEDURE log_it(msg text) LANGUAGE sql
begin atomic
  insert into log values (msg);
end;
SELECT grade(95);`;
    const statements = texts(script, 'postgres');
    expect(statements).toHaveLength(3);
    expect(statements[0]).toMatch(
      /^CREATE FUNCTION grade[\s\S]*INSERT INTO audit VALUES \(score\);\nEND$/,
    );
    expect(statements[1]).toMatch(/^CREATE OR REPLACE PROCEDURE[\s\S]*\nend$/);
    expect(statements[2]).toBe('SELECT grade(95)');
  });

  it('treats BEGIN outside routine definitions as a transaction statement', () => {
    expect(texts('BEGIN; UPDATE t SET a = 1; COMMIT; END;', 'postgres')).toEqual([
      'BEGIN',
      'UPDATE t SET a = 1',
      'COMMIT',
      'END',
    ]);
  });

  it('keeps the semicolons of CREATE RULE ... DO ( ... ) together', () => {
    const script =
      'CREATE RULE r AS ON INSERT TO t DO INSTEAD (INSERT INTO a VALUES (NEW.x); INSERT INTO b VALUES (NEW.x)); SELECT 1';
    expect(texts(script, 'postgres')).toEqual([
      'CREATE RULE r AS ON INSERT TO t DO INSTEAD (INSERT INTO a VALUES (NEW.x); INSERT INTO b VALUES (NEW.x))',
      'SELECT 1',
    ]);
  });

  it('does not let an unclosed parenthesis swallow the rest of a normal script', () => {
    expect(texts('SELECT count(; SELECT 2;', 'postgres')).toEqual(['SELECT count(', 'SELECT 2']);
  });

  it('nests block comments', () => {
    expect(texts('/* a /* b; */ c; */ SELECT 1; SELECT 2', 'postgres')).toEqual([
      'SELECT 1',
      'SELECT 2',
    ]);
  });
});

describe('statementAt', () => {
  const text = '-- intro\nSELECT 1;  -- one\n\nSELECT 2;\n';
  const statements = splitStatements(text, 'postgres');
  const [one, two] = statements;

  it('finds the statement containing the offset, ends included', () => {
    expect(statementAt(statements, text.indexOf('SELECT 1'))).toBe(one);
    expect(statementAt(statements, text.indexOf('1;'))).toBe(one);
    expect(statementAt(statements, one!.end)).toBe(one);
    expect(statementAt(statements, text.indexOf('SELECT 2') + 3)).toBe(two);
  });

  it('gives the gap after a statement to that statement', () => {
    expect(statementAt(statements, text.indexOf('-- one'))).toBe(one);
    expect(statementAt(statements, text.indexOf('\n\n') + 1)).toBe(one);
    expect(statementAt(statements, text.length)).toBe(two);
  });

  it('gives text before the first statement to the first one', () => {
    expect(statementAt(statements, 0)).toBe(one);
  });

  it('returns undefined without statements', () => {
    expect(statementAt([], 5)).toBeUndefined();
  });
});

describe('StatementSplitter', () => {
  it('returns statements as soon as they complete', () => {
    const splitter = new StatementSplitter('postgres');
    expect(splitter.push('SELECT 1; SEL')).toMatchObject([{ text: 'SELECT 1' }]);
    expect(splitter.push('ECT 2')).toEqual([]);
    expect(splitter.end()).toMatchObject([{ text: 'SELECT 2', start: 10 }]);
    expect(splitter.end()).toEqual([]);
    expect(() => splitter.push('x')).toThrow();
  });

  it('matches the one-shot splitter for any chunk size', () => {
    const scripts: [string, SqlDialect][] = [
      [MYSQLDUMP, 'mysql'],
      [
        'DELIMITER $$\nCREATE PROCEDURE p() BEGIN SELECT 1; END$$\nDELIMITER ;\nSELECT 2;',
        'mariadb',
      ],
      ["SELECT $a$ x; $a$; SELECT E'\\';'; /* /* ; */ */ SELECT U&'x;'; SELECT 1\r\n;", 'postgres'],
      [
        'CREATE FUNCTION f() RETURNS int LANGUAGE sql BEGIN ATOMIC SELECT 1; END; SELECT 2',
        'postgres',
      ],
    ];
    for (const [script, dialect] of scripts) {
      const expected = splitStatements(script, dialect);
      for (const size of [1, 2, 3, 5, 7, 64, 1000]) {
        expect(splitInChunks(script, dialect, size)).toEqual(expected);
      }
    }
  });

  it('streams a large script without holding finished statements', () => {
    const splitter = new StatementSplitter('mysql');
    let count = 0;
    const row = 'INSERT INTO t VALUES (1, \'x; y\', "z"); -- c\n';
    for (let i = 0; i < 20_000; i++) count += splitter.push(row).length;
    count += splitter.end().length;
    expect(count).toBe(20_000);
  });

  it('streams a huge string literal in many chunks', () => {
    const body = 'x;'.repeat(200_000);
    const script = `SELECT '${body}'; SELECT 2;`;
    const statements = splitInChunks(script, 'mysql', 4096);
    expect(statements.map((s) => s.text.length)).toEqual([body.length + 9, 8]);
  });
});
