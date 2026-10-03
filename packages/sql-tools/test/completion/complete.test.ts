import type { SqlDialect } from '@querybara/core';
import { describe, expect, it } from 'vitest';

import { buildCatalog, complete, type CompletionItemKind } from '../../src';
import { largeSnapshot, mysqlSnapshots } from './fixtures';
import { DIALECTS, cursor, run } from './helpers';

/**
 * Table-driven completion cases over a realistic shop catalog (fixtures.ts), in every dialect
 * unless a case names its dialects. `|` marks the cursor.
 */

interface Case {
  readonly sql: string;
  readonly dialects?: readonly SqlDialect[];
  /** Labels that must be offered. */
  readonly has?: readonly string[];
  /** Labels that must not be offered. */
  readonly lacks?: readonly string[];
  /** Exactly these labels, in any order. */
  readonly only?: readonly string[];
  /** The best item's label. */
  readonly first?: string;
  /** label → insertText. */
  readonly inserts?: Readonly<Record<string, string>>;
  /** label → kind. */
  readonly kinds?: Readonly<Record<string, CompletionItemKind>>;
  /** No items at all. */
  readonly none?: true;
}

const PG: readonly SqlDialect[] = ['postgres'];
const MY: readonly SqlDialect[] = ['mysql', 'mariadb'];

const USER_COLUMNS = ['id', 'email', 'name', 'created_at', 'Display Name'];
const ORDER_COLUMNS = ['id', 'user_id', 'status', 'total', 'created_at'];

const CASES: Readonly<Record<string, readonly Case[]>> = {
  'tables and views after FROM, JOIN, UPDATE, INTO and TABLE': [
    {
      sql: 'SELECT * FROM |',
      has: ['users', 'orders', 'order_items', 'active_users', 'UserAccounts'],
      kinds: { users: 'table', active_users: 'view' },
    },
    { sql: 'SELECT * FROM users u JOIN |', has: ['orders', 'products'] },
    { sql: 'SELECT * FROM users u LEFT OUTER JOIN |', has: ['orders'] },
    { sql: 'SELECT * FROM users u, |', has: ['orders'] },
    { sql: 'UPDATE |', has: ['orders', 'users'] },
    { sql: 'INSERT INTO |', has: ['orders', 'order_items'] },
    { sql: 'DELETE FROM |', has: ['orders'] },
    { sql: 'DELETE FROM |', dialects: PG, lacks: ['daily_sales'] },
    { sql: 'TRUNCATE TABLE |', has: ['orders'], lacks: ['active_users'] },
    { sql: 'ALTER TABLE |', has: ['orders'], lacks: ['active_users'] },
    { sql: 'DROP TABLE IF EXISTS |', has: ['orders'], lacks: ['active_users'] },
    { sql: 'DROP TABLE orders, |', has: ['users'] },
    { sql: 'DROP VIEW |', has: ['active_users'], lacks: ['orders'] },
    { sql: 'TABLE |', dialects: PG, has: ['orders'] },
    { sql: 'CREATE INDEX idx ON |', has: ['orders'] },
    { sql: 'CREATE TABLE t (id int, user_id int REFERENCES |', has: ['users'] },
    { sql: 'LOCK TABLE |', dialects: PG, has: ['orders'] },
    { sql: 'LOCK TABLES |', dialects: MY, has: ['orders'] },
    { sql: 'DESCRIBE |', dialects: MY, has: ['orders'] },
    { sql: 'SHOW COLUMNS FROM |', dialects: MY, has: ['orders'] },
    { sql: 'VACUUM ANALYZE |', dialects: PG, has: ['orders'] },
    { sql: 'COPY |', dialects: PG, has: ['orders'] },
    { sql: 'EXPLAIN SELECT * FROM |', has: ['orders'] },
    { sql: 'CREATE VIEW v AS SELECT * FROM |', has: ['orders'] },
    { sql: 'SELECT * FROM (SELECT * FROM |) s', has: ['orders'] },
    {
      sql: 'WITH recent AS (SELECT * FROM orders) SELECT * FROM |',
      first: 'recent',
      has: ['orders'],
      kinds: { recent: 'table' },
    },
    { sql: 'SELECT * FROM ord|', first: 'order details', has: ['order_items', 'orders'] },
  ],

  'schemas and databases': [
    {
      sql: 'SELECT * FROM |',
      dialects: PG,
      has: ['public', 'sales', 'Audit'],
      kinds: { sales: 'schema' },
    },
    {
      sql: 'SELECT * FROM |',
      dialects: MY,
      has: ['shop', 'analytics'],
      kinds: { analytics: 'database' },
    },
    { sql: 'SELECT * FROM sales.|', dialects: PG, only: ['invoices', 'users'] },
    {
      sql: 'SELECT * FROM "Audit".|',
      dialects: PG,
      only: ['change log'],
      inserts: { 'change log': '"change log"' },
    },
    { sql: 'SELECT * FROM analytics.|', dialects: MY, only: ['events'] },
    { sql: 'SELECT * FROM `analytics`.|', dialects: MY, only: ['events'] },
    { sql: 'USE |', dialects: MY, only: ['shop', 'analytics'] },
    { sql: 'SET search_path TO public, |', dialects: PG, has: ['sales', 'Audit'] },
    { sql: 'DROP SCHEMA |', dialects: PG, has: ['sales'] },
  ],

  'qualification outside the search path': [
    {
      sql: 'SELECT * FROM |',
      dialects: PG,
      has: ['sales.invoices', 'sales.users', 'Audit.change log'],
      kinds: { 'sales.invoices': 'table' },
    },
    { sql: 'SELECT * FROM |', dialects: MY, has: ['analytics.events'] },
    {
      sql: 'SELECT * FROM inv|',
      dialects: PG,
      has: ['sales.invoices'],
      inserts: { 'sales.invoices': 'sales.invoices' },
    },
    // public.users shadows sales.users on the search path.
    {
      sql: 'SELECT * FROM users|',
      dialects: PG,
      first: 'users',
      inserts: { users: 'users', 'sales.users': 'sales.users' },
    },
    {
      sql: 'SELECT * FROM chan|',
      dialects: PG,
      inserts: { 'Audit.change log': '"Audit"."change log"' },
    },
    {
      sql: 'SELECT * FROM ev|',
      dialects: MY,
      has: ['analytics.events'],
      inserts: { 'analytics.events': 'analytics.events' },
    },
  ],

  quoting: [
    {
      sql: 'SELECT * FROM |',
      dialects: PG,
      inserts: {
        UserAccounts: '"UserAccounts"',
        'order details': '"order details"',
        group: '"group"',
        users: 'users',
      },
    },
    {
      sql: 'SELECT * FROM |',
      dialects: MY,
      inserts: {
        UserAccounts: 'UserAccounts',
        'order details': '`order details`',
        group: '`group`',
      },
    },
    {
      sql: 'SELECT * FROM "Us|',
      dialects: PG,
      first: 'UserAccounts',
      inserts: { UserAccounts: '"UserAccounts"', users: '"users"' },
    },
    {
      sql: 'SELECT * FROM `Us|',
      dialects: MY,
      inserts: { UserAccounts: '`UserAccounts`', users: '`users`' },
    },
    { sql: 'SELECT u.| FROM users u', dialects: PG, inserts: { 'Display Name': '"Display Name"' } },
    { sql: 'SELECT u.| FROM users u', dialects: MY, inserts: { 'Display Name': '`Display Name`' } },
    {
      sql: 'SELECT a.| FROM "UserAccounts" a',
      dialects: PG,
      only: ['id', 'userId', 'Provider'],
      inserts: { userId: '"userId"', Provider: '"Provider"', id: 'id' },
    },
    {
      sql: 'SELECT a.| FROM UserAccounts a',
      dialects: MY,
      only: ['id', 'userId', 'Provider'],
      inserts: { userId: 'userId', Provider: 'Provider' },
    },
    { sql: 'SELECT g.| FROM "group" g', dialects: PG, only: ['id', 'name'] },
    { sql: 'SELECT g.| FROM `group` g', dialects: MY, only: ['id', 'name'] },
    { sql: 'SELECT d.| FROM "order details" d', dialects: PG, only: ['id', 'note'] },
    { sql: 'SELECT d.| FROM `order details` AS d', dialects: MY, only: ['id', 'note'] },
    {
      sql: 'SELECT | FROM "group"',
      dialects: PG,
      inserts: { group: '"group"' },
      kinds: { group: 'table' },
    },
  ],

  'columns after alias. and table.': [
    { sql: 'SELECT u.| FROM users u', only: USER_COLUMNS },
    { sql: 'SELECT u.| FROM users AS u', only: USER_COLUMNS },
    { sql: 'SELECT users.| FROM users', only: USER_COLUMNS },
    { sql: 'SELECT o.| FROM users u JOIN orders o ON o.user_id = u.id', only: ORDER_COLUMNS },
    { sql: 'SELECT u.em| FROM users u', first: 'email' },
    { sql: 'SELECT * FROM users u WHERE u.|', only: USER_COLUMNS },
    { sql: 'SELECT * FROM users u JOIN orders o ON o.|', only: ORDER_COLUMNS },
    { sql: 'SELECT * FROM users u ORDER BY u.|', only: USER_COLUMNS },
    { sql: 'SELECT u.| FROM users u', dialects: PG, kinds: { email: 'column' } },
    { sql: 'SELECT public.users.| FROM public.users', dialects: PG, only: USER_COLUMNS },
    { sql: 'SELECT shop.users.| FROM shop.users', dialects: MY, only: USER_COLUMNS },
    { sql: 'SELECT i.| FROM sales.invoices i', dialects: PG, only: ['id', 'order_id', 'amount'] },
    { sql: 'SELECT e.| FROM analytics.events e', dialects: MY, only: ['id', 'user_id', 'kind'] },
    // The unquoted name folds to lower case in PostgreSQL; completion falls back to any case.
    { sql: 'SELECT u.| FROM USERS u', only: USER_COLUMNS },
    // Correlated subquery: the outer alias is visible.
    {
      sql: 'SELECT * FROM users u WHERE EXISTS (SELECT 1 FROM orders o WHERE o.user_id = u.|)',
      only: USER_COLUMNS,
    },
    { sql: 'SELECT * FROM users u; SELECT u.|', none: true },
  ],

  'CTEs and subqueries': [
    {
      sql: 'WITH recent AS (SELECT id, user_id AS buyer, total * 2 AS doubled FROM orders) SELECT r.| FROM recent r',
      only: ['id', 'buyer', 'doubled'],
    },
    {
      sql: 'WITH r (x, y) AS (SELECT id, user_id FROM orders) SELECT r.| FROM r',
      only: ['x', 'y'],
    },
    {
      sql: 'WITH r AS (SELECT * FROM users) SELECT | FROM r',
      has: USER_COLUMNS,
    },
    {
      sql: 'WITH a AS (SELECT id FROM users), b AS (SELECT a.| FROM a) SELECT 1',
      only: ['id'],
    },
    {
      sql: 'WITH RECURSIVE tree (id, parent) AS (SELECT id, manager_id FROM employees UNION ALL SELECT e.id, e.manager_id FROM employees e JOIN tree t ON t.| ) SELECT * FROM tree',
      only: ['id', 'parent'],
    },
    {
      sql: 'SELECT s.| FROM (SELECT u.id, u.email AS mail FROM users u) s',
      only: ['id', 'mail'],
    },
    {
      sql: 'SELECT s.| FROM (SELECT u.id, count(*) FROM users u GROUP BY u.id) AS s',
      dialects: PG,
      only: ['id', 'count'],
    },
    { sql: 'SELECT s.| FROM (SELECT * FROM orders) s', only: ORDER_COLUMNS },
    { sql: 'SELECT s.| FROM (SELECT o.* FROM orders o) s', only: ORDER_COLUMNS },
    { sql: 'SELECT s.| FROM (SELECT id, status FROM orders) AS s (a, b)', only: ['a', 'b'] },
    {
      sql: 'SELECT * FROM (SELECT id FROM users) AS s JOIN orders o ON o.user_id = s.|',
      only: ['id'],
    },
    {
      sql: 'SELECT g.| FROM generate_series(1, 10) AS g(n)',
      dialects: PG,
      only: ['n'],
    },
  ],

  'columns in expression positions': [
    {
      sql: 'SELECT | FROM users u JOIN orders o ON o.user_id = u.id',
      has: ['u.id', 'o.id', 'email', 'status', 'u.created_at', 'o.created_at', 'u', 'o', 'COUNT'],
      lacks: ['id', 'created_at'],
      inserts: { 'u.id': 'u.id', email: 'email', COUNT: 'COUNT($0)' },
      kinds: { 'u.id': 'column', u: 'alias', COUNT: 'function' },
    },
    { sql: 'SELECT | FROM users', has: [...USER_COLUMNS, 'DISTINCT', 'CASE'], first: 'id' },
    { sql: 'SELECT id, | FROM users', has: USER_COLUMNS, lacks: ['DISTINCT'] },
    { sql: 'SELECT * FROM users WHERE |', has: [...USER_COLUMNS, 'NOT', 'EXISTS'], first: 'id' },
    { sql: 'SELECT * FROM users WHERE id = 1 AND |', has: USER_COLUMNS },
    { sql: 'SELECT * FROM users WHERE id = |', has: USER_COLUMNS },
    { sql: 'SELECT * FROM users WHERE id IN (|', has: [...USER_COLUMNS, 'SELECT'] },
    { sql: 'SELECT * FROM users WHERE (|', has: USER_COLUMNS },
    { sql: 'SELECT * FROM users GROUP BY |', has: USER_COLUMNS },
    { sql: 'SELECT * FROM users ORDER BY |', has: USER_COLUMNS },
    {
      sql: 'SELECT u.name AS n, count(*) AS total_orders FROM users u ORDER BY |',
      has: ['n', 'total_orders', ...USER_COLUMNS],
    },
    { sql: 'SELECT name FROM users GROUP BY name HAVING |', has: USER_COLUMNS },
    { sql: 'SELECT * FROM users u JOIN orders o ON |', has: ['u.id', 'o.id', 'status', 'email'] },
    { sql: 'SELECT coalesce(|) FROM orders', has: ORDER_COLUMNS },
    { sql: 'SELECT count(|) FROM orders', has: [...ORDER_COLUMNS, 'DISTINCT'] },
    { sql: 'SELECT lower(name), upper(|) FROM users', has: USER_COLUMNS },
    { sql: 'SELECT row_number() OVER (PARTITION BY |) FROM orders', has: ORDER_COLUMNS },
    { sql: 'SELECT row_number() OVER (|) FROM orders', has: ['PARTITION BY', 'ORDER BY'] },
    { sql: 'SELECT CASE WHEN | FROM orders', has: ORDER_COLUMNS },
    { sql: 'UPDATE orders SET total = |', has: ORDER_COLUMNS },
    { sql: 'UPDATE orders SET status = 1 WHERE |', has: ORDER_COLUMNS },
    { sql: 'DELETE FROM orders WHERE |', has: ORDER_COLUMNS },
    {
      sql: 'SELECT * FROM orders WHERE total > (SELECT avg(|) FROM order_items)',
      has: ['price', 'quantity'],
      lacks: ['status'],
    },
    { sql: 'INSERT INTO orders (id) SELECT | FROM users', has: USER_COLUMNS, lacks: ['status'] },
    { sql: 'SELECT * FROM users u WHERE u.id IN (SELECT | FROM orders)', has: ORDER_COLUMNS },
    // Only the cursor's statement counts.
    {
      sql: 'SELECT * FROM orders;\nSELECT | FROM users;\nSELECT * FROM products',
      has: USER_COLUMNS,
      lacks: ['status', 'sku'],
    },
  ],

  'join conditions from foreign keys': [
    {
      sql: 'SELECT * FROM users u JOIN orders o |',
      first: 'ON o.user_id = u.id',
      kinds: { 'ON o.user_id = u.id': 'join' },
      has: ['ON', 'USING', 'WHERE', 'LEFT JOIN'],
    },
    { sql: 'SELECT * FROM users u JOIN orders o ON |', first: 'o.user_id = u.id' },
    { sql: 'SELECT * FROM orders o JOIN users u ON |', first: 'u.id = o.user_id' },
    { sql: 'SELECT * FROM users JOIN orders ON |', first: 'orders.user_id = users.id' },
    { sql: 'SELECT * FROM users u INNER JOIN orders AS o ON |', first: 'o.user_id = u.id' },
    {
      sql: 'SELECT * FROM order_items i JOIN shipments s ON |',
      first: 's.order_id = i.order_id AND s.product_id = i.product_id',
    },
    {
      sql: 'SELECT * FROM employees e JOIN employees m ON |',
      has: ['m.manager_id = e.id', 'm.id = e.manager_id'],
    },
    {
      sql: 'SELECT * FROM orders o JOIN order_items i ON i.order_id = o.id JOIN products p ON |',
      first: 'p.id = i.product_id',
    },
    {
      sql: 'SELECT * FROM users u JOIN orders o ON o.user_id = u.id LEFT JOIN order_items i |',
      first: 'ON i.order_id = o.id',
    },
    {
      sql: 'SELECT * FROM orders o JOIN sales.invoices i ON |',
      dialects: PG,
      first: 'i.order_id = o.id',
    },
    {
      sql: 'SELECT * FROM analytics.events e JOIN users u ON |',
      dialects: MY,
      first: 'u.id = e.user_id',
    },
    {
      sql: 'SELECT * FROM users u JOIN "UserAccounts" a ON |',
      dialects: PG,
      first: 'a."userId" = u.id',
    },
    {
      sql: 'SELECT * FROM users u JOIN UserAccounts a ON |',
      dialects: MY,
      first: 'a.userId = u.id',
    },
    { sql: 'SELECT * FROM products p JOIN users u ON |', lacks: ['u.id = p.id'] },
  ],

  'column lists: INSERT, UPDATE SET, ALTER TABLE, indexes, upserts': [
    { sql: 'INSERT INTO orders (|', only: ORDER_COLUMNS },
    { sql: 'INSERT INTO orders (id, status, |', only: ['user_id', 'total', 'created_at'] },
    { sql: 'INSERT INTO orders (id, st|', first: 'status' },
    { sql: 'INSERT INTO users (|', dialects: PG, inserts: { 'Display Name': '"Display Name"' } },
    { sql: 'UPDATE orders SET |', only: ORDER_COLUMNS },
    { sql: 'UPDATE orders o SET status = 1, |', only: ORDER_COLUMNS },
    {
      sql: 'UPDATE orders o JOIN users u ON u.id = o.user_id SET |',
      dialects: MY,
      has: ['o.id', 'email'],
    },
    { sql: 'ALTER TABLE orders DROP COLUMN |', only: ORDER_COLUMNS },
    { sql: 'ALTER TABLE orders DROP COLUMN IF EXISTS |', dialects: PG, only: ORDER_COLUMNS },
    { sql: 'ALTER TABLE orders DROP |', has: [...ORDER_COLUMNS, 'COLUMN', 'CONSTRAINT'] },
    { sql: 'ALTER TABLE orders ALTER COLUMN |', only: ORDER_COLUMNS },
    { sql: 'ALTER TABLE orders RENAME COLUMN |', only: ORDER_COLUMNS },
    { sql: 'ALTER TABLE orders MODIFY COLUMN |', dialects: MY, only: ORDER_COLUMNS },
    { sql: 'ALTER TABLE orders CHANGE COLUMN |', dialects: MY, only: ORDER_COLUMNS },
    {
      sql: 'ALTER TABLE orders ADD COLUMN note varchar(10) AFTER |',
      dialects: MY,
      only: ORDER_COLUMNS,
    },
    { sql: 'ALTER TABLE orders ADD PRIMARY KEY (|', only: ORDER_COLUMNS },
    { sql: 'CREATE INDEX idx ON orders (|', has: ORDER_COLUMNS },
    {
      sql: 'CREATE UNIQUE INDEX idx ON orders (status, |',
      has: ['id', 'total'],
      lacks: ['status'],
    },
    { sql: 'CREATE TABLE t (id int, user_id int REFERENCES users (|', only: USER_COLUMNS },
    { sql: 'CREATE TABLE t (id int, name text, PRIMARY KEY (|', only: ['id', 'name'] },
    { sql: 'INSERT INTO orders (id) VALUES (1) ON CONFLICT (|', dialects: PG, only: ORDER_COLUMNS },
    {
      sql: 'INSERT INTO orders (id) VALUES (1) ON CONFLICT (id) DO UPDATE SET |',
      dialects: PG,
      only: ORDER_COLUMNS,
    },
    {
      sql: 'INSERT INTO orders (id) VALUES (1) ON CONFLICT (id) DO UPDATE SET status = excluded.|',
      dialects: PG,
      only: ORDER_COLUMNS,
    },
    {
      sql: 'INSERT INTO orders (id) VALUES (1) ON DUPLICATE KEY UPDATE |',
      dialects: MY,
      only: ORDER_COLUMNS,
    },
    { sql: 'INSERT INTO orders SET |', dialects: MY, only: ORDER_COLUMNS },
    {
      sql: 'SELECT * FROM users u JOIN orders o USING (|',
      has: ['id', 'created_at'],
      lacks: ['status'],
    },
  ],

  'functions, routines, types and sequences': [
    { sql: 'SELECT lp|', first: 'LPAD', inserts: { LPAD: 'LPAD($0)' } },
    { sql: 'SELECT now|', first: 'NOW', inserts: { NOW: 'NOW()' } },
    { sql: 'SELECT lp|(name, 5) FROM users', first: 'LPAD', inserts: { LPAD: 'LPAD' } },
    { sql: 'SELECT calc| (1)', inserts: { calc_total: 'calc_total' } },
    {
      sql: 'SELECT json_build_ob|',
      dialects: PG,
      has: ['JSON_BUILD_OBJECT', 'JSONB_BUILD_OBJECT'],
    },
    { sql: 'SELECT json_extr|', dialects: MY, first: 'JSON_EXTRACT' },
    { sql: 'SELECT group_con|', dialects: MY, first: 'GROUP_CONCAT' },
    { sql: 'SELECT string_a|', dialects: PG, first: 'STRING_AGG' },
    { sql: 'SELECT date_trunc|', dialects: PG, first: 'DATE_TRUNC' },
    { sql: 'SELECT date_for|', dialects: MY, first: 'DATE_FORMAT' },
    { sql: 'SELECT row_nu|', first: 'ROW_NUMBER' },
    {
      sql: 'SELECT calc|',
      first: 'calc_total',
      kinds: { calc_total: 'function' },
      inserts: { calc_total: 'calc_total($0)' },
    },
    { sql: 'SELECT public.|', dialects: PG, has: ['calc_total', 'users'] },
    { sql: 'CALL |', only: ['archive_orders'] },
    { sql: 'DROP FUNCTION |', only: ['calc_total'] },
    { sql: 'DROP PROCEDURE |', only: ['archive_orders'] },
    {
      sql: 'DROP SEQUENCE |',
      dialects: PG,
      only: ['orders_id_seq'],
      kinds: { orders_id_seq: 'sequence' },
    },
    { sql: 'DROP SEQUENCE |', dialects: ['mariadb'], only: ['invoice_seq'] },
    { sql: 'SELECT NEXT VALUE FOR |', dialects: ['mariadb'], only: ['invoice_seq'] },
    { sql: 'SELECT NEXT |', dialects: ['mariadb'], only: ['VALUE FOR'] },
    { sql: 'SELECT nextval(|)', dialects: ['mariadb'], only: ['invoice_seq'] },
    { sql: 'SELECT * FROM sales.|', dialects: PG, lacks: ['orders_id_seq'] },
    { sql: 'DROP TYPE |', dialects: PG, only: ['order_status'], kinds: { order_status: 'type' } },
    { sql: 'SELECT total::|', dialects: PG, has: ['numeric', 'order_status', 'jsonb'] },
    { sql: 'SELECT CAST(total AS |', has: ['DECIMAL'], dialects: MY },
    { sql: 'SELECT CAST(total AS |', has: ['numeric'], dialects: PG },
    { sql: 'CREATE TABLE t (id |', dialects: PG, has: ['integer', 'text', 'order_status'] },
    { sql: 'CREATE TABLE t (id |', dialects: MY, has: ['INT', 'VARCHAR', 'DATETIME'] },
    { sql: 'ALTER TABLE orders ALTER COLUMN total TYPE |', dialects: PG, has: ['numeric'] },
    { sql: 'ALTER TABLE orders ADD COLUMN note |', dialects: PG, has: ['text', 'varchar'] },
    { sql: 'ALTER TABLE orders ADD note |', dialects: MY, has: ['TEXT', 'VARCHAR'] },
    { sql: 'ALTER TABLE orders MODIFY COLUMN note |', dialects: MY, has: ['TEXT'] },
  ],

  'keywords by position': [
    { sql: '|', has: ['SELECT', 'INSERT INTO', 'UPDATE', 'DELETE FROM', 'WITH', 'CREATE TABLE'] },
    { sql: 'SEL|', first: 'SELECT' },
    { sql: 'sel|', first: 'SELECT', inserts: { SELECT: 'SELECT' } },
    {
      sql: 'SELECT * FROM users |',
      has: ['WHERE', 'JOIN', 'LEFT JOIN', 'GROUP BY', 'ORDER BY', 'AS'],
    },
    { sql: 'SELECT * FROM users u |', has: ['WHERE', 'JOIN'], lacks: ['AS'] },
    { sql: 'SELECT * FROM users u W|', first: 'WHERE' },
    { sql: 'SELECT * FROM users u LEFT |', only: ['JOIN', 'OUTER JOIN'] },
    { sql: 'SELECT * FROM users GROUP |', only: ['BY'] },
    { sql: 'SELECT * FROM users ORDER |', only: ['BY'] },
    {
      sql: 'SELECT * FROM users ORDER BY name |',
      has: ['ASC', 'DESC', 'LIMIT'],
      lacks: USER_COLUMNS,
    },
    {
      sql: 'SELECT * FROM users WHERE id = 1 |',
      has: ['AND', 'OR', 'GROUP BY', 'ORDER BY'],
      lacks: USER_COLUMNS,
    },
    { sql: 'SELECT * FROM users WHERE email IS |', has: ['NULL', 'NOT NULL'] },
    { sql: 'SELECT * FROM users WHERE email ILIKE |', dialects: PG, has: USER_COLUMNS },
    { sql: 'SELECT id |', has: ['FROM', 'AS'], lacks: USER_COLUMNS },
    { sql: 'SELECT count(*) |', has: ['FROM', 'OVER'] },
    { sql: 'SELECT CASE WHEN id = 1 THEN 2 |', has: ['ELSE', 'END', 'WHEN'] },
    { sql: 'SELECT * FROM users UNION |', has: ['SELECT'] },
    { sql: 'WITH x AS (SELECT 1) |', has: ['SELECT', 'UPDATE', 'DELETE FROM'] },
    { sql: 'WITH x AS (SELECT 1) |', dialects: PG, has: ['INSERT INTO'] },
    { sql: 'WITH x AS (|', has: ['SELECT'] },
    { sql: 'SELECT * FROM users LIMIT 10 |', has: ['OFFSET'] },
    { sql: 'INSERT |', has: ['INTO'] },
    { sql: 'INSERT INTO orders |', has: ['VALUES', 'SELECT'] },
    {
      sql: 'INSERT INTO orders (id) VALUES (1) |',
      dialects: PG,
      has: ['ON CONFLICT', 'RETURNING'],
    },
    { sql: 'INSERT INTO orders (id) VALUES (1) |', dialects: MY, has: ['ON DUPLICATE KEY UPDATE'] },
    { sql: 'UPDATE orders |', has: ['SET'] },
    { sql: 'CREATE |', has: ['TABLE', 'VIEW', 'INDEX'] },
    { sql: 'ALTER TABLE orders |', has: ['ADD COLUMN', 'DROP COLUMN', 'RENAME TO'] },
    { sql: 'ALTER TABLE orders |', dialects: MY, has: ['MODIFY COLUMN'] },
    { sql: 'CREATE TABLE t (id integer, |', has: ['PRIMARY KEY', 'CONSTRAINT', 'FOREIGN KEY'] },
    {
      sql: 'CREATE TABLE t (id integer |',
      has: ['NOT NULL', 'DEFAULT', 'PRIMARY KEY', 'REFERENCES'],
    },
    { sql: 'CREATE TABLE t (id integer |', dialects: MY, has: ['AUTO_INCREMENT'] },
    { sql: 'SHOW |', dialects: MY, has: ['TABLES', 'DATABASES'] },
    { sql: 'SELECT * FROM users u JOIN orders o USING |', none: true },
    { sql: 'SELECT id AS |', none: true },
    { sql: 'SELECT * FROM users AS |', none: true },
  ],

  'strings, comments and literals give nothing': [
    { sql: "SELECT '|'", none: true },
    { sql: "SELECT 'abc|", none: true },
    { sql: "SELECT * FROM users WHERE name = 'o|' AND id = 1", none: true },
    { sql: '-- SELECT |', none: true },
    { sql: 'SELECT 1 -- |\nFROM users', none: true },
    { sql: 'SELECT /* | */ 1', none: true },
    { sql: 'SELECT /* unterminated |', none: true },
    { sql: '# comment |', dialects: MY, none: true },
    { sql: 'SELECT "text |"', dialects: MY, none: true },
    { sql: 'SELECT $$ body | $$', dialects: PG, none: true },
    {
      sql: 'CREATE FUNCTION f() RETURNS int AS $body$ SELECT | $body$ LANGUAGE sql',
      dialects: PG,
      none: true,
    },
    { sql: 'SELECT 1|', none: true },
    { sql: "SELECT 'a'|", none: true },
    { sql: 'SELECT * FROM users WHERE id = $1|', dialects: PG, none: true },
    { sql: 'SELECT @var|', dialects: MY, none: true },
  ],

  'multi-statement scripts': [
    { sql: 'SELECT * FROM orders;\n|', has: ['SELECT', 'INSERT INTO'], lacks: ORDER_COLUMNS },
    { sql: 'SELECT * FROM orders; |', has: ['SELECT'] },
    { sql: 'SELECT * FROM orders |;\nSELECT 1', has: ['WHERE'] },
    { sql: 'SELECT * FROM orders;\nSELECT o.| FROM users o', only: USER_COLUMNS },
    { sql: 'SELECT o.| FROM users o;\nSELECT * FROM orders o', only: USER_COLUMNS },
    { sql: 'SELECT 1;\n-- note\n|', has: ['SELECT'] },
    { sql: 'SELECT * FROM users\n-- note\n|', has: ['WHERE'] },
    { sql: '\n\n|\nSELECT 1', has: ['SELECT'] },
  ],

  'DELIMITER scripts': [
    { sql: 'DELIMITER $$\n|', dialects: MY, has: ['SELECT'] },
    { sql: 'DELIMITER $$|', dialects: MY, none: true },
    {
      sql: 'DELIMITER $$\nCREATE PROCEDURE p()\nBEGIN\n  SELECT * FROM |\nEND$$\nDELIMITER ;',
      dialects: MY,
      has: ['orders'],
    },
    {
      sql: 'DELIMITER $$\nCREATE PROCEDURE p()\nBEGIN\n  DECLARE n INT;\n  SELECT u.| FROM users u;\nEND$$\nDELIMITER ;',
      dialects: MY,
      only: USER_COLUMNS,
    },
    {
      sql: 'DELIMITER //\nCREATE PROCEDURE p()\nBEGIN\n  IF 1 THEN\n    UPDATE orders SET |\n  END IF;\nEND//\nDELIMITER ;',
      dialects: MY,
      only: ORDER_COLUMNS,
    },
    {
      sql: 'DELIMITER $$\nCREATE PROCEDURE p()\nBEGIN\n  SELECT 1;\nEND$$\nDELIMITER ;\nSELECT * FROM users u WHERE u.|',
      dialects: MY,
      only: USER_COLUMNS,
    },
    {
      sql: 'DELIMITER $$\nSELECT * FROM orders$$\n|',
      dialects: MY,
      has: ['SELECT'],
      lacks: ORDER_COLUMNS,
    },
    {
      sql: 'DELIMITER ;;\nCREATE TRIGGER t BEFORE INSERT ON orders FOR EACH ROW BEGIN\n  INSERT INTO order_items (|\nEND;;',
      dialects: MY,
      has: ['order_id', 'quantity'],
    },
    {
      sql: 'CREATE FUNCTION f() RETURNS int LANGUAGE sql BEGIN ATOMIC SELECT 1; SELECT o.| FROM orders o; END',
      dialects: PG,
      only: ORDER_COLUMNS,
    },
  ],

  'incomplete statements': [
    { sql: 'SELECT a.| FROM orders a', only: ORDER_COLUMNS },
    { sql: 'SELECT a.|FROM orders a', only: ORDER_COLUMNS },
    { sql: 'SELECT id, status, | FROM orders', has: ORDER_COLUMNS },
    { sql: 'SELECT id, status, FROM orders WHERE |', has: ORDER_COLUMNS },
    { sql: 'SELECT count(| FROM orders', has: ORDER_COLUMNS },
    { sql: 'SELECT coalesce(total, | FROM orders o', has: ORDER_COLUMNS },
    { sql: 'SELECT * FROM orders WHERE id IN (| ORDER BY id', has: ORDER_COLUMNS },
    { sql: 'SELECT * FROM orders WHERE (status = 1 AND | GROUP BY id', has: ORDER_COLUMNS },
    { sql: 'SELECT * FROM (SELECT * FROM orders WHERE | ', has: ORDER_COLUMNS },
    { sql: 'SELECT o.| FROM orders o WHERE (', only: ORDER_COLUMNS },
    { sql: 'SELECT * FROM orders o JOIN users u ON u.| WHERE', only: USER_COLUMNS },
    { sql: 'SELECT |, id FROM orders', has: ORDER_COLUMNS },
    { sql: 'SELECT ))) FROM orders WHERE |', has: ORDER_COLUMNS },
  ],
};

describe('complete()', () => {
  for (const [group, cases] of Object.entries(CASES)) {
    describe(group, () => {
      for (const test of cases) {
        for (const dialect of test.dialects ?? DIALECTS) {
          it(`${dialect}: ${test.sql.replaceAll('\n', '⏎')}`, () => {
            const result = run(dialect, test.sql);
            const { offset } = cursor(test.sql);
            expect(result.from).toBeLessThanOrEqual(offset);
            expect(result.to).toBeGreaterThanOrEqual(offset);
            if (test.none) expect(result.labels).toEqual([]);
            if (test.has) expect(result.labels).toEqual(expect.arrayContaining([...test.has]));
            for (const label of test.lacks ?? []) expect(result.labels).not.toContain(label);
            if (test.only) expect([...result.labels].sort()).toEqual([...test.only].sort());
            if (test.first) expect(result.labels[0]).toBe(test.first);
            for (const [label, insertText] of Object.entries(test.inserts ?? {})) {
              expect(result.item(label)?.insertText, label).toBe(insertText);
            }
            for (const [label, kind] of Object.entries(test.kinds ?? {})) {
              expect(result.item(label)?.kind, label).toBe(kind);
            }
          });
        }
      }
    });
  }
});

describe('replacement range', () => {
  it('covers the word at the cursor, including the part after it', () => {
    const result = run('postgres', 'SELECT * FROM us|ers WHERE id = 1');
    expect([result.from, result.to]).toEqual([14, 19]);
    expect(result.labels[0]).toBe('users');
  });

  it('starts at the opening quote of a quoted identifier', () => {
    const { text, offset } = cursor('SELECT * FROM "Us|');
    const result = run('postgres', 'SELECT * FROM "Us|');
    expect(result.from).toBe(text.indexOf('"'));
    expect(result.to).toBe(offset);
    expect(result.item('UserAccounts')?.filterText).toBe('"UserAccounts"');
  });

  it('is empty after a dot or a space', () => {
    expect(run('postgres', 'SELECT u.| FROM users u')).toMatchObject({ from: 9, to: 9 });
    expect(run('postgres', 'SELECT * FROM |')).toMatchObject({ from: 14, to: 14 });
  });
});

describe('ranking', () => {
  it('puts exact-case prefix matches, then any-case prefixes, then subsequences', () => {
    const labels = run('postgres', 'SELECT * FROM Us|').labels;
    expect(labels[0]).toBe('UserAccounts');
    expect(labels.indexOf('users')).toBeLessThan(labels.indexOf('active_users'));
    expect(labels.indexOf('users')).toBeGreaterThan(0);
    // `products` matches only as a subsequence (u...s).
    expect(labels.indexOf('active_users')).toBeGreaterThan(labels.indexOf('users'));
  });

  it('puts tables before schemas after FROM', () => {
    for (const dialect of DIALECTS) {
      const result = run(dialect, 'SELECT * FROM |');
      const firstSchema = result.items.findIndex(
        (item) => item.kind === 'schema' || item.kind === 'database',
      );
      const lastTable = result.items.map((item) => item.label).lastIndexOf('users');
      expect(firstSchema).toBeGreaterThan(lastTable);
      expect(result.items[0]!.kind === 'table' || result.items[0]!.kind === 'view').toBe(true);
    }
  });

  it('puts in-scope columns before functions and keywords in expressions', () => {
    for (const dialect of DIALECTS) {
      const items = run(dialect, 'SELECT * FROM users WHERE |').items;
      const lastColumn = items.map((item) => item.kind).lastIndexOf('column');
      const firstOther = items.findIndex(
        (item) => item.kind === 'keyword' || item.kind === 'function',
      );
      expect(lastColumn).toBeLessThan(firstOther);
    }
  });

  it('keeps columns in table order and sortText consistent with the order', () => {
    const items = run('postgres', 'SELECT u.| FROM users u').items;
    expect(items.map((item) => item.label)).toEqual(USER_COLUMNS);
    const sorted = [...items].sort((a, b) => (a.sortText < b.sortText ? -1 : 1));
    expect(sorted).toEqual(items);
  });

  it('puts join conditions first after JOIN ... ON', () => {
    const items = run('mysql', 'SELECT * FROM users u JOIN orders o ON |').items;
    expect(items[0]).toMatchObject({
      kind: 'join',
      label: 'o.user_id = u.id',
      detail: 'foreign key orders_user_id_fkey',
    });
  });
});

describe('options', () => {
  it('offers user snippets as snippet items where statements and expressions start', () => {
    const snippets = [
      { prefix: 'selstar', body: 'SELECT * FROM ${1:table}', description: 'Select everything' },
      { prefix: 'cnt', body: 'count(*)' },
    ];
    const start = run('postgres', 'sel|', { snippets });
    expect(start.item('selstar')).toMatchObject({
      kind: 'snippet',
      insertText: 'SELECT * FROM ${1:table}',
      isSnippet: true,
      detail: 'Select everything',
    });
    expect(run('postgres', 'SELECT c| FROM users', { snippets }).item('cnt')?.kind).toBe('snippet');
    expect(run('postgres', 'SELECT u.| FROM users u', { snippets }).item('cnt')).toBeUndefined();
    expect(run('postgres', "SELECT 'sel|'", { snippets }).items).toEqual([]);
  });

  it('inserts keywords and built-in functions in lower case on request', () => {
    const result = run('mysql', 'SELECT * FROM users |', { keywordCase: 'lower' });
    expect(result.labels).toContain('where');
    expect(run('mysql', 'SELECT lp|', { keywordCase: 'lower' }).item('lpad')?.insertText).toBe(
      'lpad($0)',
    );
  });

  it('caps the list at maxItems, best first, and says it is incomplete', () => {
    const all = run('postgres', 'SELECT * FROM |');
    const capped = run('postgres', 'SELECT * FROM |', { maxItems: 3 });
    expect(capped.items).toEqual(all.items.slice(0, 3));
    expect(capped.incomplete).toBe(true);
    expect(all.incomplete).toBe(false);
  });

  it('holds back relations of many other databases until a prefix is typed', () => {
    const catalog = buildCatalog([...mysqlSnapshots('mysql'), largeSnapshot('mysql', 600, 3)]);
    const empty = complete('SELECT * FROM ', 14, 'mysql', catalog);
    expect(empty.incomplete).toBe(true);
    expect(empty.items.map((item) => item.label)).toContain('users');
    expect(empty.items.some((item) => item.label.startsWith('big.'))).toBe(false);
    const typed = complete('SELECT * FROM table_59', 22, 'mysql', catalog);
    expect(typed.items[0]?.label).toBe('big.table_59');
    expect(typed.items[0]?.insertText).toBe('big.table_59');
    expect(typed.incomplete).toBe(true);
    // Everything fits: the list is complete and the editor may filter it locally.
    expect(run('mysql', 'SELECT * FROM |').incomplete).toBe(false);
  });

  it('returns items with a detail for columns, tables and functions', () => {
    const result = run('postgres', 'SELECT | FROM users');
    expect(result.item('email')?.detail).toBe('text');
    expect(result.item('LPAD')?.detail).toBe('lpad(string, length integer, [fill]) → text');
    expect(run('postgres', 'SELECT * FROM |').item('users')).toMatchObject({
      detail: 'table · public',
      documentation: 'People who can sign in',
    });
  });
});
