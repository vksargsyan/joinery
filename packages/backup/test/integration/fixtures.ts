import type { Session } from '@joinery/core';
import { expect } from 'vitest';

import { expectSameData, expectSameStructure, rowsText } from './helpers';

/**
 * The tricky databases the round trips back up and restore, and the checks that prove a
 * restored copy equals its source: the structure compare and the key-range data compare of
 * @joinery/sync, plus queries for what they cannot see (sequence positions, materialised views,
 * AUTO_INCREMENT counters, spatial values, a table without a key).
 */

export interface SqlFixture {
  /** PostgreSQL schema backed up; absent for MySQL and MariaDB (the database). */
  readonly schema?: string;
  readonly setup: readonly string[];
  readonly data: readonly string[];
  /** Tables and their keys, for the data compare. */
  readonly tables: readonly (readonly [string, readonly string[]])[];
  /** Queries whose rows must be equal on both sides. */
  readonly checks: readonly string[];
}

export const PG_FIXTURE: SqlFixture = {
  schema: 'bk',
  setup: [
    `CREATE SCHEMA bk`,
    `CREATE EXTENSION citext SCHEMA bk`,
    `CREATE TYPE bk.mood AS ENUM ('sad', 'ok', 'happy')`,
    `CREATE TYPE bk.pair AS (a integer, b text)`,
    `CREATE DOMAIN bk.positive AS integer CHECK (VALUE > 0)`,
    `CREATE SEQUENCE bk.counter START 100 INCREMENT 5`,
    `CREATE FUNCTION bk.next_code() RETURNS text LANGUAGE sql AS $$ SELECT 'C-' || nextval('bk.counter') $$`,
    `CREATE TABLE bk.customers (id serial PRIMARY KEY, name bk.citext NOT NULL, email text UNIQUE, mood bk.mood DEFAULT 'ok', tags text[], created timestamptz DEFAULT now(), code text DEFAULT bk.next_code())`,
    `CREATE TABLE bk.orders (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, customer_id int NOT NULL REFERENCES bk.customers(id) ON DELETE CASCADE, total numeric(12,2) CHECK (total >= 0), qty bk.positive, pair bk.pair, gross numeric GENERATED ALWAYS AS (total * 1.2) STORED)`,
    `CREATE INDEX orders_total_idx ON bk.orders (total DESC) WHERE qty IS NOT NULL`,
    `CREATE TABLE bk.self_ref (id int PRIMARY KEY, parent int REFERENCES bk.self_ref(id))`,
    `CREATE TABLE bk.measurements (id int, at date NOT NULL, v float8, PRIMARY KEY (id, at)) PARTITION BY RANGE (at)`,
    `CREATE TABLE bk.m2024 PARTITION OF bk.measurements FOR VALUES FROM ('2024-01-01') TO ('2025-01-01')`,
    `CREATE TABLE bk.m2025 PARTITION OF bk.measurements FOR VALUES FROM ('2025-01-01') TO ('2026-01-01')`,
    `CREATE TABLE bk.kinds (id int PRIMARY KEY, b bytea, f8 float8, f4 real, n numeric, iv interval, ts timestamp(3), t time, d date, j json, jb jsonb, u uuid, ip inet, bits bit(4), vb varbit, r int4range, tv tsvector, pt point, ok boolean, x xml, c char(5), arr int[], mood bk.mood[])`,
    `CREATE VIEW bk.big_orders AS SELECT id, total FROM bk.orders WHERE total > 100`,
    `CREATE MATERIALIZED VIEW bk.order_totals AS SELECT customer_id, sum(total) AS s FROM bk.orders GROUP BY 1`,
    `CREATE FUNCTION bk.touch() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.total := coalesce(NEW.total, 0) + 1000; RETURN NEW; END $$`,
    `CREATE TRIGGER orders_touch BEFORE INSERT ON bk.orders FOR EACH ROW EXECUTE FUNCTION bk.touch()`,
    `COMMENT ON TABLE bk.customers IS 'People, with ''quotes'''`,
    `COMMENT ON COLUMN bk.orders.total IS 'Before tax'`,
  ],
  data: [
    `INSERT INTO bk.customers (name, email, mood, tags, created, code) VALUES
       ('Ada', 'ada@example.com', 'happy', '{a,"b c",NULL,"quo\\"te"}', '2024-01-02 03:04:05.123456+00', 'C-1'),
       (E'O''Brien\\n"multi"\\tline \\\\ back😀', NULL, NULL, '{}', NULL, ''),
       ('ÜNÏCÖDÉ Grüße 東京', 'x@y', 'sad', NULL, '1999-12-31 23:59:59+05:30', NULL)`,
    `INSERT INTO bk.customers (name, email) SELECT 'bulk ' || g, 'bulk' || g || '@example.com' FROM generate_series(1, 2500) g`,
    `DELETE FROM bk.customers WHERE id IN (2500, 2501)`,
    // The trigger would add 1000 to every total loaded while it exists.
    `ALTER TABLE bk.orders DISABLE TRIGGER orders_touch`,
    `INSERT INTO bk.orders (customer_id, total, qty, pair) VALUES
       (1, 12.34, 3, ROW(1, 'x')), (1, NULL, NULL, ROW(NULL, 'y "z"')), (2, 99999.99, 1, NULL)`,
    `INSERT INTO bk.orders (customer_id, total, qty) SELECT 3 + (g % 50), g * 1.25, 1 + g % 7 FROM generate_series(1, 1200) g`,
    `ALTER TABLE bk.orders ENABLE TRIGGER orders_touch`,
    `INSERT INTO bk.self_ref VALUES (1, NULL), (2, 1), (3, 2)`,
    `UPDATE bk.self_ref SET parent = 3 WHERE id = 1`,
    `INSERT INTO bk.measurements VALUES (1, '2024-03-01', 1.5), (2, '2025-06-30', -0.25), (3, '2024-12-31', NULL)`,
    `INSERT INTO bk.kinds VALUES
       (1, '\\x00ff10005c27', 'NaN', 0.1, '12345678901234567890.123456789', '1 year 2 mons 3 days 04:05:06.789', '2024-02-29 12:34:56.789', '23:59:59.999999', '0001-01-01',
        '{"b": 1,  "a": [1, 2]}', '{"z": {"k": [true, null]}, "a": "é"}', 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', '192.168.0.1/24', B'1010', B'10', '[1,10)', 'fat:2 rat:3', '(1.5,-2)', true,
        '<a b="1">x &amp; y</a>', 'ab', '{1,NULL,3}', '{sad,happy}'),
       (2, '', 'Infinity', -3.4e38, '-0.000000001', '-1 days', '1970-01-01 00:00:00', '00:00:00', '2400-12-31',
        'null', '[]', NULL, '::1', B'0000', B'', 'empty', '', '(0,0)', false, NULL, NULL, '{}', '{}'),
       (3, NULL, '-Infinity', 1e-37, '1e20', '00:00:00.000001', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL),
       (4, NULL, 1e-300, 3.14159274, '3.14159265358979323846264338327950288', NULL, NULL, NULL, NULL, '"just a string"', '12.50', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL)`,
    `SELECT setval('bk.counter', 4242, true)`,
    `REFRESH MATERIALIZED VIEW bk.order_totals`,
  ],
  tables: [
    ['customers', ['id']],
    ['orders', ['id']],
    ['self_ref', ['id']],
    ['measurements', ['id', 'at']],
    ['kinds', ['id']],
  ],
  checks: [
    'SELECT last_value, is_called FROM bk.counter',
    'SELECT last_value, is_called FROM bk.customers_id_seq',
    'SELECT last_value, is_called FROM bk.orders_id_seq',
    'SELECT customer_id, s FROM bk.order_totals ORDER BY 1',
    'SELECT id, gross FROM bk.orders ORDER BY id',
  ],
};

export function mysqlFixture(mariadb: boolean): SqlFixture {
  return {
    setup: [
      `CREATE TABLE customers (id int AUTO_INCREMENT PRIMARY KEY, name varchar(80) NOT NULL, email varchar(120) UNIQUE, favourite bigint unsigned NULL, created timestamp(3) NULL DEFAULT CURRENT_TIMESTAMP(3), tag enum('a','b','c') DEFAULT 'a', flags set('x','y','z')) ENGINE=InnoDB`,
      `CREATE TABLE orders (id bigint unsigned NOT NULL AUTO_INCREMENT PRIMARY KEY, customer_id int NOT NULL, total decimal(12,2), gross decimal(14,2) AS (total * 1.2) STORED, note text, KEY idx_total (total DESC), CONSTRAINT fk_customer FOREIGN KEY (customer_id) REFERENCES customers (id) ON DELETE CASCADE) ENGINE=InnoDB`,
      `ALTER TABLE customers ADD CONSTRAINT fk_favourite FOREIGN KEY (favourite) REFERENCES orders (id)`,
      `CREATE TABLE kinds (id int PRIMARY KEY, f float, d double, dec_ decimal(30,10), b bit(12), big bigint unsigned, tiny tinyint(1), y year, dt datetime(6), t time(3), j json, bin varbinary(20), blb blob, txt mediumtext, ch char(4), e enum('one','two')) ENGINE=InnoDB`,
      `CREATE TABLE shapes (id int PRIMARY KEY, g geometry NOT NULL, p point) ENGINE=InnoDB`,
      `CREATE TABLE logs (id int, msg varchar(200)) ENGINE=MyISAM`,
      `CREATE VIEW big_orders AS SELECT id, total FROM orders WHERE total > 100`,
      `CREATE FUNCTION twice(x int) RETURNS int DETERMINISTIC RETURN x * 2`,
      `CREATE PROCEDURE add_log(IN m varchar(200)) BEGIN INSERT INTO logs VALUES (NULL, m); SELECT COUNT(*) FROM logs; END`,
      `CREATE EVENT purge_logs ON SCHEDULE EVERY 1 DAY STARTS '2030-01-01 00:00:00' DISABLE DO DELETE FROM logs`,
      ...(mariadb ? ['CREATE SEQUENCE seq1 START WITH 100 INCREMENT BY 5'] : []),
    ],
    data: [
      `SET SESSION sql_mode = CONCAT(@@sql_mode, ',NO_AUTO_VALUE_ON_ZERO')`,
      `INSERT INTO customers (id, name, email, created, tag, flags) VALUES
         (0, 'zero id', NULL, NULL, NULL, ''),
         (1, 'Ada', 'ada@example.com', '2024-01-02 03:04:05.678', 'b', 'x,z'),
         (2, 'O''Brien\\\\ "q"\\n😀 Grüße', 'o@x', '1999-12-31 23:59:59.000', 'c', 'y')`,
      `INSERT INTO customers (name, email) SELECT CONCAT('bulk ', seq), CONCAT('b', seq, '@x') FROM (SELECT a.n + b.n * 10 + c.n * 100 AS seq FROM (SELECT 0 n UNION SELECT 1 UNION SELECT 2 UNION SELECT 3 UNION SELECT 4 UNION SELECT 5 UNION SELECT 6 UNION SELECT 7 UNION SELECT 8 UNION SELECT 9) a, (SELECT 0 n UNION SELECT 1 UNION SELECT 2 UNION SELECT 3 UNION SELECT 4 UNION SELECT 5 UNION SELECT 6 UNION SELECT 7 UNION SELECT 8 UNION SELECT 9) b, (SELECT 0 n UNION SELECT 1 UNION SELECT 2 UNION SELECT 3 UNION SELECT 4 UNION SELECT 5 UNION SELECT 6 UNION SELECT 7 UNION SELECT 8 UNION SELECT 9) c) s`,
      `DELETE FROM customers WHERE id IN (500, 501)`,
      `INSERT INTO orders (customer_id, total, note) SELECT id, id * 1.5, IF(id % 3 = 0, NULL, CONCAT('n', id)) FROM customers WHERE id > 0`,
      // Created after the rows: it would change every note loaded while it exists.
      `CREATE TRIGGER orders_touch BEFORE INSERT ON orders FOR EACH ROW SET NEW.note = CONCAT(COALESCE(NEW.note, ''), ' (touched)')`,
      `UPDATE customers SET favourite = 3 WHERE id = 1`,
      `INSERT INTO kinds VALUES
         (1, 1.2345678, 0.1, 12345678901234567890.1234567890, b'101010101010', 18446744073709551615, 1, 2024, '2024-02-29 12:34:56.123456', '-838:59:59.000', '{"b": 1, "a": [1, 2.5, "x"]}', X'00FF00270A', X'000102', 'long\\ntext', 'ab', 'two'),
         (2, -3.4e38, 1e-300, -0.0000000001, b'0', 0, 0, 1901, '1000-01-01 00:00:00', '00:00:00', 'null', X'', X'', '', '', NULL),
         (3, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL)`,
      `INSERT INTO shapes VALUES (1, ST_GeomFromText('POLYGON((0 0,10 0,10 10,0 10,0 0))'), ST_GeomFromText('POINT(1.5 -2.25)')), (2, ST_GeomFromText('LINESTRING(0 0,1 1,2 3)'), NULL)`,
      `INSERT INTO logs VALUES (1, 'kept'), (NULL, 'no id')`,
      `ALTER TABLE orders AUTO_INCREMENT = 5000`,
      ...(mariadb ? ['SELECT NEXTVAL(seq1)', 'SELECT NEXTVAL(seq1)'] : []),
    ],
    tables: [
      ['customers', ['id']],
      ['orders', ['id']],
      ['kinds', ['id']],
      ['shapes', ['id']],
    ],
    checks: [
      'SELECT id, msg FROM logs ORDER BY id, msg',
      'SELECT id, ST_AsText(g), ST_AsText(p) FROM shapes ORDER BY id',
      // FLOAT as a DOUBLE: the text protocol's six-digit rounding would hide a lost digit.
      'SELECT id, f + 0e0, HEX(b), HEX(bin), HEX(blb) FROM kinds ORDER BY id',
      `SELECT TABLE_NAME, AUTO_INCREMENT FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND AUTO_INCREMENT IS NOT NULL ORDER BY 1`,
      `SELECT ROUTINE_NAME, SQL_MODE FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = DATABASE() ORDER BY 1`,
      `SELECT EVENT_NAME, STATUS FROM information_schema.EVENTS WHERE EVENT_SCHEMA = DATABASE()`,
      ...(mariadb ? ['SELECT next_not_cached_value FROM seq1'] : []),
    ],
  };
}

/** Zero structure differences, identical rows, equal answers to every check. */
export async function expectSameDatabase(
  source: Session,
  target: Session,
  fixture: SqlFixture,
): Promise<void> {
  await expectSameStructure(source, target, fixture.schema ? [fixture.schema] : undefined);
  for (const [table, keys] of fixture.tables) {
    const ref = { ...(fixture.schema ? { schema: fixture.schema } : {}), name: table };
    await expectSameData(source, target, { source: ref, target: ref, keyColumns: keys });
  }
  for (const sql of fixture.checks) {
    expect(await rowsText(target, sql)).toEqual(await rowsText(source, sql));
  }
}
