import { schemaSnapshotSchema, tableDefSchema, type SchemaSnapshot } from '@joinery/core';
import { describe, expect, it } from 'vitest';

import { InsertWriter, planSqlObjects, scriptPreamble, tableData } from '../src';

/**
 * The SQL side of backups without a server: which DDL runs before and after the data, how
 * replaced objects are dropped, the SELECT and INSERT for each table, and the INSERT batching.
 */

const NOW = '2026-09-29T00:00:00.000Z';

function pgSnapshot(): SchemaSnapshot {
  return schemaSnapshotSchema.parse({
    engine: 'postgres',
    serverVersion: '16.4',
    database: 'shop',
    capturedAt: NOW,
    extensions: [{ name: 'citext', schema: 'app', version: '1.6' }],
    schemas: [
      {
        name: 'app',
        types: [
          {
            name: 'mood',
            kind: 'enum',
            values: ['a', 'b'],
            definition: "CREATE TYPE app.mood AS ENUM ('a', 'b')",
          },
          {
            name: 'positive',
            kind: 'domain',
            definition: 'CREATE DOMAIN app.positive AS integer CHECK ((VALUE > 0))',
          },
        ],
        tables: [
          {
            name: 'customers',
            columns: [
              { name: 'id', ordinal: 1, dataType: 'integer', nullable: false },
              { name: 'mood', ordinal: 2, dataType: 'app.mood', nullable: true },
            ],
            primaryKey: { name: 'customers_pkey', columns: ['id'] },
          },
          {
            name: 'orders',
            columns: [
              {
                name: 'id',
                ordinal: 1,
                dataType: 'bigint',
                nullable: false,
                identity: { generation: 'always' },
              },
              { name: 'customer_id', ordinal: 2, dataType: 'integer', nullable: false },
              { name: 'total', ordinal: 3, dataType: 'numeric(12,2)', nullable: true },
              {
                name: 'gross',
                ordinal: 4,
                dataType: 'numeric',
                nullable: true,
                generated: { expression: 'total * 1.2', stored: true },
              },
            ],
            primaryKey: { name: 'orders_pkey', columns: ['id'] },
            foreignKeys: [
              {
                name: 'orders_customer_id_fkey',
                columns: ['customer_id'],
                refTable: 'customers',
                refColumns: ['id'],
              },
            ],
            triggers: [
              {
                name: 'orders_touch',
                timing: 'BEFORE',
                events: ['INSERT'],
                definition:
                  'CREATE TRIGGER orders_touch BEFORE INSERT ON app.orders FOR EACH ROW EXECUTE FUNCTION app.touch()',
              },
            ],
          },
        ],
        views: [{ name: 'big', definition: ' SELECT id FROM app.orders WHERE total > 100' }],
        routines: [
          {
            name: 'touch',
            kind: 'function',
            signature: '',
            returns: 'trigger',
            language: 'plpgsql',
            definition:
              'CREATE OR REPLACE FUNCTION app.touch()\n RETURNS trigger\n LANGUAGE plpgsql\nAS $function$ BEGIN RETURN NEW; END $function$',
          },
        ],
        sequences: [{ name: 'counter', start: '1', increment: '1', dataType: 'bigint' }],
      },
    ],
  });
}

describe('planSqlObjects', () => {
  it('splits DDL around the data and links attached objects to their table', () => {
    const plan = planSqlObjects(pgSnapshot());
    const byId = new Map(plan.objects.map((o) => [o.id, o]));
    const orders = byId.get('table:app.orders:create')!;
    expect(orders.pre[0]).toMatch(/^CREATE TABLE "app"\."orders"/);
    expect(orders.pre[0]).not.toMatch(/FOREIGN KEY/);
    expect(orders.post).toEqual([]);
    expect(orders.table?.name).toBe('orders');

    const fk = byId.get('foreign-key:app.orders.orders_customer_id_fkey:create')!;
    expect(fk.pre).toEqual([]);
    expect(fk.post[0]).toMatch(/ADD CONSTRAINT "orders_customer_id_fkey" FOREIGN KEY/);
    expect(fk.parent).toBe(orders.id);
    expect(fk.dependsOn).toEqual(['table:app.customers:create', 'table:app.orders:create']);

    const trigger = byId.get('trigger:app.orders.orders_touch:create')!;
    expect(trigger.pre).toEqual([]);
    expect(trigger.post).toHaveLength(1);
    expect(trigger.dependsOn).toContain('routine:app.touch():create');

    // Creation order: the schema and types before the tables that use them.
    const order = plan.objects.map((o) => o.id);
    expect(order.indexOf('schema:app:create')).toBeLessThan(order.indexOf('type:app.mood:create'));
    expect(order.indexOf('type:app.mood:create')).toBeLessThan(
      order.indexOf('table:app.customers:create'),
    );
  });

  it('drops replaced objects by kind, never with CASCADE', () => {
    const plan = planSqlObjects(pgSnapshot());
    const drops = Object.fromEntries(plan.objects.map((o) => [o.id, o.drop]));
    expect(drops['table:app.orders:create']).toBe('DROP TABLE IF EXISTS "app"."orders"');
    expect(drops['type:app.positive:create']).toBe('DROP DOMAIN IF EXISTS "app"."positive"');
    expect(drops['type:app.mood:create']).toBe('DROP TYPE IF EXISTS "app"."mood"');
    expect(drops['view:app.big:create']).toBe('DROP VIEW IF EXISTS "app"."big"');
    expect(drops['sequence:app.counter:create']).toBe('DROP SEQUENCE IF EXISTS "app"."counter"');
    expect(drops['trigger:app.orders.orders_touch:create']).toBe(
      'DROP TRIGGER IF EXISTS "orders_touch" ON "app"."orders"',
    );
    expect(drops['foreign-key:app.orders.orders_customer_id_fkey:create']).toBe(
      'ALTER TABLE IF EXISTS "app"."orders" DROP CONSTRAINT IF EXISTS "orders_customer_id_fkey"',
    );
    expect(drops['routine:app.touch():create']).toMatch(/^DROP FUNCTION "?app"?\."?touch"?\(\)/);
    expect(drops['schema:app:create']).toBeUndefined();
    for (const drop of Object.values(drops)) expect(drop ?? '').not.toMatch(/CASCADE/i);
  });
});

describe('tableData', () => {
  it('reads PostgreSQL rows without generated columns, keeping identity values', () => {
    const orders = pgSnapshot().schemas[0]!.tables.find((t) => t.name === 'orders')!;
    const data = tableData('postgres', orders, 'app');
    expect(data.columns).toEqual(['id', 'customer_id', 'total']);
    expect(data.query).toBe('SELECT "id", "customer_id", "total" FROM ONLY "app"."orders"');
    expect(data.head).toBe(
      'INSERT INTO "app"."orders" ("id", "customer_id", "total") OVERRIDING SYSTEM VALUE VALUES\n',
    );
    const parent = tableDefSchema.parse({
      name: 'events',
      kind: 'partitioned',
      columns: [{ name: 'at', ordinal: 1, dataType: 'date', nullable: false }],
    });
    expect(tableData('postgres', parent, 'app').query).toBe('SELECT "at" FROM "app"."events"');
  });

  it('reads MySQL FLOAT columns as DOUBLE so no digit is lost', () => {
    const table = tableDefSchema.parse({
      name: 'kinds',
      columns: [
        { name: 'id', ordinal: 1, dataType: 'int', nullable: false },
        { name: 'f', ordinal: 2, dataType: 'float unsigned', nullable: true },
        { name: 'd', ordinal: 3, dataType: 'double', nullable: true },
      ],
    });
    const data = tableData('mysql', table);
    expect(data.query).toBe('SELECT `id`, (`f` + 0e0) AS `f`, `d` FROM `kinds`');
    expect(data.head).toBe('INSERT INTO `kinds` (`id`, `f`, `d`) VALUES\n');
  });
});

describe('InsertWriter', () => {
  const page = (rows: unknown[][]) => ({
    type: 'rows' as const,
    resultIndex: 0,
    rowCount: rows.length,
    data: rows[0]!.map((_, c) => rows.map((row) => row[c])) as never,
  });

  it('writes exact literals per dialect', () => {
    const writer = new InsertWriter('postgres', 'INSERT INTO t (a, b, c, d) VALUES\n');
    writer.columns(['string', 'binary', 'bigint', 'boolean']);
    const text =
      writer.page(page([["it's", Uint8Array.from([0, 255]), 9007199254740993n, true]])) +
      writer.end();
    expect(text).toBe(
      "INSERT INTO t (a, b, c, d) VALUES\n('it''s', '\\x00ff'::bytea, 9007199254740993, TRUE);\n",
    );
    const mysql = new InsertWriter('mysql', 'INSERT INTO t (a, b) VALUES\n');
    mysql.columns(['string', 'boolean']);
    expect(
      mysql.page(
        page([
          ['a\\b\n', false],
          [null, true],
        ]),
      ) + mysql.end(),
    ).toBe("INSERT INTO t (a, b) VALUES\n('a\\\\b\\n', 0),\n(NULL, 1);\n");
  });

  it('starts a new statement after the row limit or the length limit', () => {
    const writer = new InsertWriter('postgres', 'INSERT INTO t (a) VALUES\n', {
      rowsPerStatement: 2,
    });
    const text = writer.page(page([[1], [2], [3], [4], [5]])) + writer.end();
    expect(text.match(/INSERT INTO/g)).toHaveLength(3);
    const long = new InsertWriter('postgres', 'INSERT INTO t (a) VALUES\n', {
      maxStatementLength: 1024,
    });
    const big = long.page(page(Array.from({ length: 10 }, () => ['x'.repeat(300)]))) + long.end();
    expect((big.match(/INSERT INTO/g) ?? []).length).toBeGreaterThanOrEqual(4);
    for (const statement of big.split(';\n').filter(Boolean)) {
      expect(statement.length).toBeLessThanOrEqual(1024 + 310);
    }
  });
});

describe('scriptPreamble', () => {
  it('pins the settings a restore depends on', () => {
    expect(scriptPreamble('postgres')).toContain(
      "SELECT pg_catalog.set_config('search_path', '', false)",
    );
    expect(scriptPreamble('postgres')).toContain('SET check_function_bodies = false');
    expect(scriptPreamble('mysql')).toContain("SET time_zone = '+00:00'");
    expect(scriptPreamble('mariadb')).toContain("SET sql_mode = 'NO_AUTO_VALUE_ON_ZERO'");
  });
});
