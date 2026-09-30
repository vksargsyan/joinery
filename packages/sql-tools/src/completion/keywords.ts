import type { SqlDialect } from '@joinery/core';

/**
 * Keyword sets for completion, by position. An entry may be several words ("LEFT JOIN") and may
 * be limited to a dialect family with a suffix: `@pg` (PostgreSQL), `@my` (MySQL and MariaDB),
 * `@mysql` or `@mariadb`.
 */

export type KeywordList = readonly string[];

function list(text: string): KeywordList {
  return text
    .split('|')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/** The entries of `lists` that apply to `dialect`, without their suffixes, deduplicated. */
export function keywordsFor(dialect: SqlDialect, ...lists: KeywordList[]): string[] {
  const seen = new Set<string>();
  for (const entries of lists) {
    for (const entry of entries) {
      const at = entry.indexOf('@');
      if (at >= 0) {
        const scope = entry.slice(at + 1);
        const applies =
          scope === dialect ||
          (scope === 'pg' ? dialect === 'postgres' : scope === 'my' && dialect !== 'postgres');
        if (!applies) continue;
        seen.add(entry.slice(0, at));
      } else {
        seen.add(entry);
      }
    }
  }
  return [...seen];
}

export const STATEMENT_START = list(
  'SELECT | INSERT INTO | UPDATE | DELETE FROM | WITH | CREATE TABLE | CREATE VIEW | CREATE INDEX | ' +
    'CREATE | ALTER TABLE | ALTER | DROP TABLE | DROP | TRUNCATE TABLE | EXPLAIN | SET | BEGIN | ' +
    'COMMIT | ROLLBACK | GRANT | REVOKE | CALL | VALUES | SHOW | START TRANSACTION | SAVEPOINT | ' +
    'RELEASE SAVEPOINT | LOCK TABLE@pg | LOCK TABLES@my | UNLOCK TABLES@my | REPLACE INTO@my | ' +
    'DESCRIBE@my | USE@my | RENAME TABLE@my | OPTIMIZE TABLE@my | ANALYZE TABLE@my | LOAD DATA@my | ' +
    'DELIMITER@my | COPY@pg | VACUUM@pg | ANALYZE@pg | REFRESH MATERIALIZED VIEW@pg | COMMENT ON@pg | ' +
    'DO@pg | MERGE INTO@pg | TABLE@pg | REINDEX@pg | CLUSTER@pg | RESET@pg | PREPARE | EXECUTE | ' +
    'DEALLOCATE | LISTEN@pg | NOTIFY@pg',
);

/** Words that can start an expression operand. */
export const OPERAND = list(
  'CASE | NOT | EXISTS | NULL | TRUE | FALSE | CURRENT_DATE | CURRENT_TIME | CURRENT_TIMESTAMP | ' +
    'LOCALTIMESTAMP | CURRENT_USER | INTERVAL | ARRAY@pg | ROW',
);

/** Right after SELECT. */
export const SELECT_START = list('DISTINCT | ALL | DISTINCT ON@pg | SQL_CALC_FOUND_ROWS@my | *');

/** Operators spelled as words, after an operand. */
export const OPERATORS = list(
  'AND | OR | NOT | IS | IS NULL | IS NOT NULL | IN | NOT IN | LIKE | NOT LIKE | BETWEEN | ' +
    'ILIKE@pg | NOT ILIKE@pg | SIMILAR TO@pg | IS DISTINCT FROM | IS NOT DISTINCT FROM | ' +
    'REGEXP@my | RLIKE@my | XOR@my | DIV@my | MOD@my | COLLATE',
);

/** After a complete select-list item. */
export const AFTER_SELECT_ITEM = list('FROM | AS | INTO@my');

/** Clauses that may follow the FROM clause of a query. */
export const QUERY_TAIL = list(
  'WHERE | GROUP BY | HAVING | ORDER BY | LIMIT | OFFSET@pg | FETCH FIRST@pg | WINDOW | ' +
    'UNION | UNION ALL | INTERSECT | EXCEPT | FOR UPDATE | FOR SHARE',
);

export const JOINS = list(
  'JOIN | INNER JOIN | LEFT JOIN | RIGHT JOIN | CROSS JOIN | NATURAL JOIN | LEFT OUTER JOIN | ' +
    'RIGHT OUTER JOIN | FULL JOIN@pg | FULL OUTER JOIN@pg | STRAIGHT_JOIN@my',
);

/** After a table reference in FROM (or a joined table with its alias). */
export const AFTER_TABLE = list(
  'AS | TABLESAMPLE@pg | USE INDEX@my | FORCE INDEX@my | IGNORE INDEX@my',
);

export const AFTER_JOINED_TABLE = list('ON | USING');

/** Tail keywords after an expression, by clause. */
export const AFTER_WHERE = list(
  'GROUP BY | ORDER BY | LIMIT | UNION | UNION ALL | FOR UPDATE | RETURNING@pg',
);
export const AFTER_GROUP_BY = list(
  'HAVING | ORDER BY | LIMIT | WITH ROLLUP@my | UNION | UNION ALL',
);
export const AFTER_HAVING = list('ORDER BY | LIMIT | UNION | UNION ALL');
export const AFTER_ORDER_ITEM = list(
  'ASC | DESC | NULLS FIRST@pg | NULLS LAST@pg | LIMIT | OFFSET | FETCH FIRST@pg | FOR UPDATE',
);
export const AFTER_ON = list('WHERE | GROUP BY | ORDER BY | LIMIT');
export const AFTER_SET_ITEM = list('WHERE | FROM@pg | RETURNING@pg | ORDER BY@my | LIMIT@my');
export const AFTER_LIMIT = list('OFFSET | FOR UPDATE | FOR SHARE');
export const AFTER_VALUES = list(
  'ON CONFLICT@pg | RETURNING@pg | ON DUPLICATE KEY UPDATE@my | AS@mysql',
);
export const AFTER_INSERT_TARGET = list(
  'VALUES | SELECT | DEFAULT VALUES@pg | OVERRIDING@pg | AS@pg | SET@my | VALUE@my | PARTITION@my',
);
export const AFTER_UPDATE_TARGET = list('SET | AS | JOIN@my | INNER JOIN@my | LEFT JOIN@my');
export const AFTER_DELETE_TARGET = list(
  'WHERE | USING@pg | AS@pg | RETURNING@pg | ORDER BY@my | LIMIT@my',
);
export const AFTER_CONFLICT = list('DO NOTHING | DO UPDATE SET | ON CONSTRAINT | WHERE');
export const LOCK_TAIL = list('OF | NOWAIT | SKIP LOCKED');

/** Starts of a query where one is expected (a subquery, a CTE body). */
export const QUERY_START = list('SELECT | WITH | VALUES');
export const CTE_BODY_START = list(
  'SELECT | WITH | VALUES | INSERT INTO@pg | UPDATE@pg | DELETE FROM@pg',
);
export const TABLE_POSITION = list('LATERAL | ONLY@pg');

/** Column definitions in CREATE TABLE and ALTER TABLE ... ADD. */
export const TABLE_ELEMENT_START = list(
  'CONSTRAINT | PRIMARY KEY | FOREIGN KEY | UNIQUE | CHECK | INDEX@my | KEY@my | FULLTEXT@my | ' +
    'SPATIAL@my | EXCLUDE@pg | LIKE@pg',
);
export const COLUMN_CONSTRAINTS = list(
  'NOT NULL | NULL | DEFAULT | PRIMARY KEY | UNIQUE | REFERENCES | CHECK | COLLATE | ' +
    'GENERATED ALWAYS AS | CONSTRAINT@pg | GENERATED ALWAYS AS IDENTITY@pg | ' +
    'GENERATED BY DEFAULT AS IDENTITY@pg | AUTO_INCREMENT@my | COMMENT@my | UNSIGNED@my | ' +
    'ON UPDATE CURRENT_TIMESTAMP@my | CHARACTER SET@my | INVISIBLE@my | FIRST@my | AFTER@my',
);
export const CONSTRAINT_KINDS = list('PRIMARY KEY | FOREIGN KEY | UNIQUE | CHECK | EXCLUDE@pg');
export const AFTER_REFERENCES = list(
  'ON DELETE | ON UPDATE | MATCH FULL@pg | MATCH SIMPLE@pg | DEFERRABLE@pg | NOT DEFERRABLE@pg',
);
export const REFERENTIAL_ACTIONS = list('CASCADE | RESTRICT | SET NULL | SET DEFAULT | NO ACTION');

export const ALTER_TABLE_ACTIONS = list(
  'ADD | ADD COLUMN | DROP | DROP COLUMN | ALTER COLUMN | RENAME TO | RENAME COLUMN | ' +
    'ADD CONSTRAINT | DROP CONSTRAINT | ADD PRIMARY KEY | ADD FOREIGN KEY | ADD UNIQUE | ' +
    'OWNER TO@pg | SET SCHEMA@pg | ENABLE TRIGGER@pg | DISABLE TRIGGER@pg | ATTACH PARTITION@pg | ' +
    'DETACH PARTITION@pg | MODIFY COLUMN@my | CHANGE COLUMN@my | ADD INDEX@my | DROP INDEX@my | ' +
    'RENAME INDEX@my | DROP PRIMARY KEY@my | DROP FOREIGN KEY@my | ENGINE@my | COMMENT@my | ' +
    'CONVERT TO CHARACTER SET@my | AUTO_INCREMENT@my',
);
export const DROP_TARGETS = list(
  'COLUMN | CONSTRAINT | INDEX@my | KEY@my | PRIMARY KEY@my | FOREIGN KEY@my | CHECK@my | PARTITION@my',
);

/** Object kinds after CREATE / DROP / ALTER. */
export const OBJECT_KINDS = list(
  'TABLE | VIEW | INDEX | UNIQUE INDEX | SCHEMA | DATABASE | FUNCTION | PROCEDURE | TRIGGER | ' +
    'USER | ROLE | SEQUENCE@pg | SEQUENCE@mariadb | MATERIALIZED VIEW@pg | TYPE@pg | DOMAIN@pg | ' +
    'EXTENSION@pg | POLICY@pg | EVENT@my | TEMPORARY TABLE | OR REPLACE | IF EXISTS | IF NOT EXISTS',
);
export const PRIVILEGES = list(
  'SELECT | INSERT | UPDATE | DELETE | ALL PRIVILEGES | USAGE | EXECUTE | REFERENCES | TRIGGER | ' +
    'TRUNCATE@pg | CREATE | CONNECT@pg | TEMPORARY@pg | ALTER@my | DROP@my | INDEX@my',
);
export const GRANT_ON = list(
  'TABLE | SCHEMA@pg | DATABASE@pg | SEQUENCE@pg | FUNCTION | PROCEDURE | ALL TABLES IN SCHEMA@pg',
);
export const EXPLAIN_OPTIONS = list(
  'ANALYZE | VERBOSE@pg | FORMAT JSON@pg | FORMAT=JSON@my | FORMAT=TREE@mysql | SELECT | INSERT | ' +
    'UPDATE | DELETE | WITH',
);
export const SHOW_TARGETS = list(
  'TABLES@my | FULL TABLES@my | DATABASES@my | COLUMNS FROM@my | INDEX FROM@my | CREATE TABLE@my | ' +
    'CREATE VIEW@my | PROCESSLIST@my | FULL PROCESSLIST@my | VARIABLES@my | STATUS@my | ' +
    'GRANTS@my | WARNINGS@my | ERRORS@my | TRIGGERS@my | TABLE STATUS@my | ENGINE INNODB STATUS@my | ' +
    'search_path@pg | ALL@pg | server_version@pg | TIME ZONE@pg | TRANSACTION ISOLATION LEVEL@pg',
);

/** Built-in type names for column definitions, CAST and `::`. */
export const TYPES = list(
  'integer@pg | bigint@pg | smallint@pg | numeric@pg | decimal@pg | real@pg | double precision@pg | ' +
    'serial@pg | bigserial@pg | boolean@pg | text@pg | varchar@pg | character varying@pg | char@pg | ' +
    'date@pg | time@pg | timestamp@pg | timestamptz@pg | timestamp with time zone@pg | interval@pg | ' +
    'uuid@pg | json@pg | jsonb@pg | bytea@pg | inet@pg | cidr@pg | macaddr@pg | money@pg | xml@pg | ' +
    'tsvector@pg | int4range@pg | int8range@pg | tstzrange@pg | daterange@pg | point@pg | ' +
    'INT@my | INTEGER@my | BIGINT@my | SMALLINT@my | TINYINT@my | MEDIUMINT@my | DECIMAL@my | ' +
    'NUMERIC@my | FLOAT@my | DOUBLE@my | BIT@my | BOOLEAN@my | CHAR@my | VARCHAR@my | TEXT@my | ' +
    'TINYTEXT@my | MEDIUMTEXT@my | LONGTEXT@my | BINARY@my | VARBINARY@my | BLOB@my | ' +
    'MEDIUMBLOB@my | LONGBLOB@my | DATE@my | DATETIME@my | TIMESTAMP@my | TIME@my | YEAR@my | ' +
    'JSON@my | ENUM@my | SET@my | GEOMETRY@my | POINT@my | UUID@mariadb | INET4@mariadb | ' +
    'INET6@mariadb | SIGNED@my | UNSIGNED@my',
);

/**
 * Follow-up words for a keyword that cannot end a phrase: after GROUP comes BY. Keyed by the
 * upper-case previous word; consulted before the positional lists.
 */
export const FOLLOW: Readonly<Record<string, KeywordList>> = {
  GROUP: list('BY'),
  ORDER: list('BY'),
  PARTITION: list('BY'),
  LEFT: list('JOIN | OUTER JOIN'),
  RIGHT: list('JOIN | OUTER JOIN'),
  FULL: list('JOIN | OUTER JOIN'),
  OUTER: list('JOIN'),
  INNER: list('JOIN'),
  CROSS: list('JOIN'),
  NATURAL: list('JOIN | LEFT JOIN | RIGHT JOIN'),
  UNION: list('ALL | SELECT | DISTINCT'),
  INTERSECT: list('SELECT | ALL'),
  EXCEPT: list('SELECT | ALL'),
  INSERT: list('INTO | IGNORE INTO@my'),
  REPLACE: list('INTO'),
  NULLS: list('FIRST | LAST'),
  IS: list('NULL | NOT NULL | NOT | TRUE | FALSE | UNKNOWN | DISTINCT FROM | NOT DISTINCT FROM'),
  PRIMARY: list('KEY'),
  FOREIGN: list('KEY'),
  START: list('TRANSACTION'),
  BEGIN: list('TRANSACTION@pg | WORK@my'),
  RENAME: list('TO | COLUMN | TABLE@my | INDEX@my'),
  DISTINCT: list('ON@pg'),
  WITH: list('RECURSIVE'),
  FETCH: list('FIRST | NEXT'),
  SKIP: list('LOCKED'),
  MATERIALIZED: list('VIEW'),
  DUPLICATE: list('KEY UPDATE'),
  CONFLICT: list('DO NOTHING | DO UPDATE SET | ON CONSTRAINT'),
};

/**
 * Words that never name a relation, so they end a table reference instead of being its alias
 * (`FROM users WHERE`), and never count as operands.
 */
export const CLAUSE_WORDS = new Set(
  (
    'SELECT FROM WHERE GROUP ORDER HAVING LIMIT OFFSET FETCH WINDOW UNION INTERSECT EXCEPT MINUS ' +
    'JOIN INNER LEFT RIGHT FULL OUTER CROSS NATURAL STRAIGHT_JOIN ON USING SET VALUES VALUE ' +
    'RETURNING INTO FOR LOCK TABLESAMPLE PARTITION FORCE USE IGNORE AS WITH LATERAL WHEN THEN ' +
    'ELSE END AND OR NOT IS IN LIKE ILIKE BETWEEN SIMILAR REGEXP RLIKE XOR DIV MOD CASE DO ' +
    'NOTHING CONFLICT DUPLICATE KEY UPDATE DELETE INSERT REPLACE MERGE MATCHED OVERRIDING DEFAULT ' +
    'ASC DESC NULLS COLLATE ESCAPE PROCEDURE WINDOW QUALIFY CONNECT START ROWS RANGE GROUPS'
  ).split(' '),
);

/** Keywords that are operands themselves (after them, an operator is expected). */
export const VALUE_WORDS = new Set(
  (
    'NULL TRUE FALSE UNKNOWN END CURRENT_DATE CURRENT_TIME CURRENT_TIMESTAMP LOCALTIME ' +
    'LOCALTIMESTAMP CURRENT_USER SESSION_USER CURRENT_ROLE CURRENT_SCHEMA CURRENT_CATALOG USER ' +
    'DEFAULT ASC DESC FIRST LAST ROLLUP'
  ).split(' '),
);

/** Keywords after which an operand is expected. */
export const OPERAND_BEFORE = new Set(
  (
    'SELECT WHERE ON AND OR NOT WHEN THEN ELSE CASE BY HAVING SET RETURNING VALUES DISTINCT ALL ' +
    'ANY SOME EXISTS IN LIKE ILIKE BETWEEN IS SIMILAR TO ESCAPE XOR DIV MOD REGEXP RLIKE USING ' +
    'INTERVAL OVER FILTER WITHIN QUALIFY LIMIT OFFSET RETURN SEPARATOR IF ELSEIF WHILE UNTIL'
  ).split(' '),
);
