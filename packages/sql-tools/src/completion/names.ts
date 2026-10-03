import type { SqlDialect } from '@querybara/core';

import { quoteIdent } from '../dialect';
import type { Token } from '../lexer';

/**
 * Identifiers as the completion engine sees them: the name without quotes, and whether it was
 * quoted (PostgreSQL folds unquoted names to lower case; MySQL and MariaDB never fold).
 */
export interface Ident {
  readonly name: string;
  readonly quoted: boolean;
}

/** The identifier a word or quoted-identifier token spells, or undefined for other tokens. */
export function identOf(token: Pick<Token, 'kind' | 'text'>): Ident | undefined {
  if (token.kind === 'word') return { name: token.text, quoted: false };
  if (token.kind !== 'quoted-identifier') return undefined;
  return { name: unquote(token.text), quoted: true };
}

/** The name inside a (possibly unterminated) quoted identifier: `"a""b"` → `a"b`. */
export function unquote(text: string): string {
  let body = text;
  if (body.startsWith('U&') || body.startsWith('u&')) body = body.slice(2);
  const quote = body.charAt(0);
  body = body.slice(1);
  if (body.length > 0 && body.endsWith(quote) && !body.endsWith(quote + quote)) {
    body = body.slice(0, -1);
  } else if (body.length >= 2 && body.endsWith(quote + quote)) {
    // An even run of quotes at the end is escaped quotes plus nothing: `"a""` is unterminated.
    let run = 0;
    while (run < body.length && body.charAt(body.length - 1 - run) === quote) run++;
    if (run % 2 === 1) body = body.slice(0, -1);
  }
  return body.replaceAll(quote + quote, quote);
}

/**
 * PostgreSQL keywords that cannot be used as table or column names without quotes (the
 * "reserved" and "reserved (can be function or type)" categories of the manual's Appendix C).
 */
const POSTGRES_RESERVED = new Set(
  (
    'ALL ANALYSE ANALYZE AND ANY ARRAY AS ASC ASYMMETRIC AUTHORIZATION BINARY BOTH CASE CAST CHECK ' +
    'COLLATE COLLATION COLUMN CONCURRENTLY CONSTRAINT CREATE CROSS CURRENT_CATALOG CURRENT_DATE ' +
    'CURRENT_ROLE CURRENT_SCHEMA CURRENT_TIME CURRENT_TIMESTAMP CURRENT_USER DEFAULT DEFERRABLE DESC ' +
    'DISTINCT DO ELSE END EXCEPT FALSE FETCH FOR FOREIGN FREEZE FROM FULL GRANT GROUP HAVING ILIKE IN ' +
    'INITIALLY INNER INTERSECT INTO IS ISNULL JOIN LATERAL LEADING LEFT LIKE LIMIT LOCALTIME ' +
    'LOCALTIMESTAMP NATURAL NOT NOTNULL NULL OFFSET ON ONLY OR ORDER OUTER OVERLAPS PLACING PRIMARY ' +
    'REFERENCES RETURNING RIGHT SELECT SESSION_USER SIMILAR SOME SYMMETRIC SYSTEM_USER TABLE ' +
    'TABLESAMPLE THEN TO TRAILING TRUE UNION UNIQUE USER USING VARIADIC VERBOSE WHEN WHERE WINDOW WITH'
  ).split(' '),
);

/** MySQL 8.4 reserved words, plus the few MariaDB 11 reserves on top of them. */
const MYSQL_RESERVED = new Set(
  (
    'ACCESSIBLE ADD ALL ALTER ANALYZE AND AS ASC ASENSITIVE BEFORE BETWEEN BIGINT BINARY BLOB BOTH BY ' +
    'CALL CASCADE CASE CHANGE CHAR CHARACTER CHECK COLLATE COLUMN CONDITION CONSTRAINT CONTINUE ' +
    'CONVERT CREATE CROSS CUBE CUME_DIST CURRENT_DATE CURRENT_ROLE CURRENT_TIME CURRENT_TIMESTAMP ' +
    'CURRENT_USER CURSOR DATABASE DATABASES DAY_HOUR DAY_MICROSECOND DAY_MINUTE DAY_SECOND DEC DECIMAL ' +
    'DECLARE DEFAULT DELAYED DELETE DELETE_DOMAIN_ID DENSE_RANK DESC DESCRIBE DETERMINISTIC DISTINCT ' +
    'DISTINCTROW DIV DO_DOMAIN_IDS DOUBLE DROP DUAL EACH ELSE ELSEIF EMPTY ENCLOSED ESCAPED EXCEPT ' +
    'EXISTS EXIT EXPLAIN FALSE FETCH FIRST_VALUE FLOAT FLOAT4 FLOAT8 FOR FORCE FOREIGN FROM FULLTEXT ' +
    'FUNCTION GENERAL GENERATED GET GRANT GROUP GROUPING GROUPS HAVING HIGH_PRIORITY HOUR_MICROSECOND ' +
    'HOUR_MINUTE HOUR_SECOND IF IGNORE IGNORE_DOMAIN_IDS IGNORE_SERVER_IDS IN INDEX INFILE INNER INOUT ' +
    'INSENSITIVE INSERT INT INT1 INT2 INT3 INT4 INT8 INTEGER INTERSECT INTERVAL INTO IO_AFTER_GTIDS ' +
    'IO_BEFORE_GTIDS IS ITERATE JOIN JSON_TABLE KEY KEYS KILL LAG LAST_VALUE LATERAL LEAD LEADING LEAVE ' +
    'LEFT LIKE LIMIT LINEAR LINES LOAD LOCALTIME LOCALTIMESTAMP LOCK LONG LONGBLOB LONGTEXT LOOP ' +
    'LOW_PRIORITY MASTER_BIND MASTER_HEARTBEAT_PERIOD MASTER_SSL_VERIFY_SERVER_CERT MATCH MAXVALUE ' +
    'MEDIUMBLOB MEDIUMINT MEDIUMTEXT MIDDLEINT MINUTE_MICROSECOND MINUTE_SECOND MOD MODIFIES NATURAL ' +
    'NOT NO_WRITE_TO_BINLOG NTH_VALUE NTILE NULL NUMERIC OF OFFSET ON OPTIMIZE OPTIMIZER_COSTS OPTION ' +
    'OPTIONALLY OR ORDER OUT OUTER OUTFILE OVER PAGE_CHECKSUM PARSE_VCOL_EXPR PARTITION PERCENT_RANK ' +
    'POSITION PRECISION PRIMARY PROCEDURE PURGE RANGE RANK READ READS READ_WRITE REAL RECURSIVE ' +
    'REF_SYSTEM_ID REFERENCES REGEXP RELEASE RENAME REPEAT REPLACE REQUIRE RESIGNAL RESTRICT RETURN ' +
    'RETURNING REVOKE RIGHT RLIKE ROW ROW_NUMBER ROWS SCHEMA SCHEMAS SECOND_MICROSECOND SELECT ' +
    'SENSITIVE SEPARATOR SET SHOW SIGNAL SLOW SMALLINT SPATIAL SPECIFIC SQL SQL_BIG_RESULT ' +
    'SQL_CALC_FOUND_ROWS SQLEXCEPTION SQL_SMALL_RESULT SQLSTATE SQLWARNING SSL STARTING STATS_AUTO_RECALC ' +
    'STATS_PERSISTENT STATS_SAMPLE_PAGES STORED STRAIGHT_JOIN SYSTEM TABLE TERMINATED THEN TINYBLOB ' +
    'TINYINT TINYTEXT TO TRAILING TRIGGER TRUE UNDO UNION UNIQUE UNLOCK UNSIGNED UPDATE USAGE USE ' +
    'USING UTC_DATE UTC_TIME UTC_TIMESTAMP VALUES VARBINARY VARCHAR VARCHARACTER VARYING VIRTUAL WHEN ' +
    'WHERE WHILE WINDOW WITH WRITE XOR YEAR_MONTH ZEROFILL'
  ).split(' '),
);

const POSTGRES_PLAIN = /^[a-z_][a-z0-9_$]*$/;
const MYSQL_PLAIN = /^[A-Za-z0-9_$\u0080-\uffff]+$/;

/** True when `name` must be quoted to mean itself in `dialect`. */
export function needsQuoting(name: string, dialect: SqlDialect): boolean {
  if (dialect === 'postgres') {
    return !POSTGRES_PLAIN.test(name) || POSTGRES_RESERVED.has(name.toUpperCase());
  }
  // MySQL allows a leading digit, but 1e5 or 123 would read as numbers: quote those.
  if (!MYSQL_PLAIN.test(name) || /^[0-9]/.test(name)) return true;
  return MYSQL_RESERVED.has(name.toUpperCase());
}

/** `name` as SQL: bare when it can be, quoted with quoteIdent otherwise. */
export function formatName(name: string, dialect: SqlDialect): string {
  return needsQuoting(name, dialect) ? quoteIdent(name, dialect) : name;
}
