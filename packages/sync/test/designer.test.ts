import { schemaSnapshotSchema, tableDefSchema } from '@querybara/core';
import type { ColumnDef, SchemaSnapshot, SqlEngineId, TableDef } from '@querybara/core';
import { describe, expect, it } from 'vitest';

import {
  cloneTable,
  designDropTable,
  designTable,
  diagnoseTable,
  emptyTable,
  newColumn,
  tableOptionCatalog,
  validateTable,
} from '../src';
import type { DesignContext, DesignRenames, TableDesign } from '../src';

// ---------------------------------------------------------------------------------------------
// Fixtures

const col = (name: string, dataType: string, extra: Partial<ColumnDef> = {}): ColumnDef => ({
  name,
  ordinal: 1,
  dataType,
  nullable: true,
  default: null,
  autoIncrement: false,
  ...extra,
});

function table(raw: Record<string, unknown>): TableDef {
  const parsed = tableDefSchema.parse(raw);
  return { ...parsed, columns: parsed.columns.map((c, i) => ({ ...c, ordinal: i + 1 })) };
}

function snapshot(engine: SqlEngineId, schemas: unknown[], options = {}): SchemaSnapshot {
  return schemaSnapshotSchema.parse({
    engine,
    serverVersion: engine === 'postgres' ? '16.4' : engine === 'mysql' ? '8.4.2' : '11.4.5-MariaDB',
    database: engine === 'postgres' ? 'app' : 'shop',
    capturedAt: '2026-01-01T00:00:00Z',
    options,
    schemas,
  });
}

/** PostgreSQL: customers and orders (FK), a view over orders, a trigger function. */
function pgWorld(): { snapshot: SchemaSnapshot; orders: TableDef } {
  const orders = table({
    name: 'orders',
    columns: [
      col('id', 'bigint', {
        nullable: false,
        identity: { generation: 'always', start: '1', increment: '1' },
      }),
      col('customer_id', 'integer', { nullable: false }),
      col('code', 'character varying(20)', { nullable: false }),
      col('note', 'text'),
      col('qty', 'integer', { nullable: false, default: '1' }),
      col('price', 'numeric(10,2)'),
      col('placed_at', 'timestamp with time zone', { default: 'now()' }),
    ],
    primaryKey: { name: 'orders_pkey', columns: ['id'] },
    uniques: [{ name: 'orders_code_key', columns: ['code'] }],
    indexes: [
      {
        name: 'orders_note_idx',
        columns: [{ name: null, expression: 'lower(note)' }],
        definition: 'CREATE INDEX orders_note_idx ON public.orders USING btree (lower(note))',
      },
    ],
    foreignKeys: [
      {
        name: 'orders_customer_fk',
        columns: ['customer_id'],
        refTable: 'customers',
        refColumns: ['id'],
        match: 'SIMPLE',
        deferrable: 'not-deferrable',
      },
    ],
    checks: [{ name: 'orders_qty_check', expression: '(qty > 0)' }],
    triggers: [
      {
        name: 'orders_touch',
        timing: 'BEFORE',
        events: ['UPDATE'],
        definition:
          'CREATE TRIGGER orders_touch BEFORE UPDATE ON public.orders FOR EACH ROW EXECUTE FUNCTION public.touch()',
      },
    ],
    comment: 'Orders',
  });
  const customers = table({
    name: 'customers',
    columns: [col('id', 'integer', { nullable: false }), col('email', 'text')],
    primaryKey: { name: 'customers_pkey', columns: ['id'] },
  });
  const lines = table({
    name: 'order_lines',
    columns: [
      col('order_id', 'bigint', { nullable: false }),
      col('line', 'integer', { nullable: false }),
    ],
    primaryKey: { name: 'order_lines_pkey', columns: ['order_id', 'line'] },
    foreignKeys: [
      {
        name: 'order_lines_order_fk',
        columns: ['order_id'],
        refTable: 'orders',
        refColumns: ['id'],
        match: 'SIMPLE',
        deferrable: 'not-deferrable',
      },
    ],
  });
  return {
    orders,
    snapshot: snapshot(
      'postgres',
      [
        {
          name: 'public',
          tables: [customers, lines, orders],
          views: [
            {
              name: 'big_orders',
              definition:
                ' SELECT o.id,\n    o.qty,\n    o.note\n   FROM public.orders o\n  WHERE (o.qty > 10);',
              columns: ['id', 'qty', 'note'],
            },
          ],
          sequences: [],
          types: [
            {
              name: 'mood',
              kind: 'enum',
              values: ['happy', 'sad'],
              definition: "CREATE TYPE public.mood AS ENUM ('happy', 'sad')",
            },
          ],
        },
      ],
      { collation: 'C.UTF-8' },
    ),
  };
}

function pgContext(snap: SchemaSnapshot, renames?: DesignRenames): DesignContext {
  return {
    engine: 'postgres',
    schema: 'public',
    snapshot: snap,
    ...(renames !== undefined ? { renames } : {}),
  };
}

function myWorld(engine: 'mysql' | 'mariadb' = 'mysql'): {
  snapshot: SchemaSnapshot;
  orders: TableDef;
} {
  const options = {
    engine: 'InnoDB',
    charset: 'utf8mb4',
    collation: engine === 'mysql' ? 'utf8mb4_0900_ai_ci' : 'utf8mb4_uca1400_ai_ci',
  };
  const orders = table({
    name: 'orders',
    columns: [
      col('id', 'int unsigned', { nullable: false, autoIncrement: true }),
      col('customer_id', 'int', { nullable: false }),
      col('code', 'varchar(20)', { nullable: false }),
      col('note', 'text'),
      col('status', "enum('new','paid','shipped')", { nullable: false, default: "'new'" }),
      col('qty', 'int', { nullable: false, default: '1' }),
      col('price', 'decimal(10,2)'),
    ],
    primaryKey: { name: 'PRIMARY', columns: ['id'] },
    indexes: [
      { name: 'uq_code', columns: [{ name: 'code' }], unique: true },
      { name: 'fk_orders_customer', columns: [{ name: 'customer_id' }] },
    ],
    foreignKeys: [
      {
        name: 'fk_orders_customer',
        columns: ['customer_id'],
        refTable: 'customers',
        refColumns: ['id'],
      },
    ],
    checks: [{ name: 'orders_qty_check', expression: '(`qty` > 0)' }],
    triggers: [
      {
        name: 'orders_bi',
        timing: 'BEFORE',
        events: ['INSERT'],
        definition:
          'CREATE TRIGGER `orders_bi` BEFORE INSERT ON `orders` FOR EACH ROW SET NEW.code = UPPER(NEW.code)',
      },
    ],
    options: { ...options, autoIncrement: '4' },
    comment: 'Orders',
  });
  const customers = table({
    name: 'customers',
    columns: [col('id', 'int', { nullable: false }), col('email', 'varchar(100)')],
    primaryKey: { name: 'PRIMARY', columns: ['id'] },
    options,
  });
  return {
    orders,
    snapshot: snapshot(
      engine,
      [
        {
          name: 'shop',
          tables: [customers, orders],
          views: [
            {
              name: 'order_codes',
              definition: 'select `o`.`id` AS `id`,`o`.`code` AS `code` from `orders` `o`',
              columns: ['id', 'code'],
            },
          ],
        },
      ],
      { charset: 'utf8mb4', collation: options.collation },
    ),
  };
}

function myContext(snap: SchemaSnapshot, renames?: DesignRenames): DesignContext {
  return {
    engine: snap.engine as 'mysql' | 'mariadb',
    schema: 'shop',
    snapshot: snap,
    ...(renames !== undefined ? { renames } : {}),
  };
}

const edit = (t: TableDef, change: (t: TableDef) => Partial<TableDef>): TableDef => ({
  ...t,
  ...change(t),
});
const setColumn = (t: TableDef, name: string, change: Partial<ColumnDef>): TableDef =>
  edit(t, (x) => ({ columns: x.columns.map((c) => (c.name === name ? { ...c, ...change } : c)) }));
const errors = (design: { issues: readonly { severity: string; code: string }[] }): string[] =>
  design.issues.filter((i) => i.severity === 'error').map((i) => i.code);
const codes = (issues: readonly { code: string }[]): string[] => issues.map((i) => i.code);

// ---------------------------------------------------------------------------------------------
// PostgreSQL

describe('designTable on PostgreSQL', () => {
  it('creates a new table with its indexes, foreign keys, triggers and comments in one transaction', () => {
    const { snapshot: snap } = pgWorld();
    const t = table({
      name: 'invoices',
      columns: [
        col('id', 'bigserial'),
        col('customer_id', 'int4', { nullable: false }),
        col('total', 'decimal(12,2)', { nullable: false, default: '0' }),
        col('memo', 'varchar', { comment: 'Free text' }),
        col('mood', 'mood'),
      ],
      primaryKey: { name: 'invoices_pkey', columns: ['id'] },
      indexes: [
        {
          name: 'invoices_open_idx',
          columns: [{ name: 'total', order: 'desc' }],
          where: 'total > 0',
        },
      ],
      foreignKeys: [
        {
          name: 'invoices_customer_fk',
          columns: ['customer_id'],
          refTable: 'customers',
          refColumns: ['id'],
          onDelete: 'CASCADE',
        },
      ],
      triggers: [
        {
          name: 'invoices_touch',
          timing: 'BEFORE',
          events: ['UPDATE'],
          definition:
            'CREATE TRIGGER invoices_touch BEFORE UPDATE ON public.invoices FOR EACH ROW EXECUTE FUNCTION public.touch()',
        },
      ],
      options: { fillfactor: '70' },
      comment: 'Invoices',
    });
    const design = designTable(null, t, pgContext(snap));
    expect(errors(design)).toEqual([]);
    expect(design.valid).toBe(true);
    expect(design.transactional).toBe(true);
    expect(design.dataLoss).toEqual([]);
    expect(design.statements[0]).toBe('BEGIN');
    expect(design.statements.at(-1)).toBe('COMMIT');
    expect(design.statements).toContainEqual(
      'CREATE SEQUENCE "public"."invoices_id_seq" AS bigint INCREMENT BY 1 START WITH 1 NO CYCLE',
    );
    const create = design.statements.find((s) => s.startsWith('CREATE TABLE'))!;
    expect(create).toContain(
      `"id" bigint DEFAULT nextval('public.invoices_id_seq'::regclass) NOT NULL`,
    );
    expect(create).toContain('"customer_id" integer NOT NULL');
    expect(create).toContain('"total" numeric(12,2) DEFAULT 0 NOT NULL');
    expect(create).toContain('"mood" public.mood');
    expect(create).toContain('WITH (fillfactor=70)');
    expect(design.statements).toContainEqual(
      'CREATE INDEX "invoices_open_idx" ON "public"."invoices" ("total" DESC) WHERE (total > 0)',
    );
    expect(design.statements).toContainEqual(
      'ALTER SEQUENCE "public"."invoices_id_seq" OWNED BY "public"."invoices"."id"',
    );
    expect(design.statements).toContainEqual(
      'ALTER TABLE "public"."invoices" ADD CONSTRAINT "invoices_customer_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers" ("id") ON DELETE CASCADE',
    );
    expect(design.statements).toContainEqual(`COMMENT ON TABLE "public"."invoices" IS 'Invoices'`);
    expect(design.statements).toContainEqual(
      `COMMENT ON COLUMN "public"."invoices"."memo" IS 'Free text'`,
    );
    const trigger = design.statements.findIndex((s) => s.startsWith('CREATE TRIGGER'));
    expect(trigger).toBeGreaterThan(
      design.statements.findIndex((s) => s.startsWith('CREATE TABLE')),
    );
    expect(design.table.columns.map((c) => c.dataType)).toEqual([
      'bigint',
      'integer',
      'numeric(12,2)',
      'character varying',
      'public.mood',
    ]);
    expect(design.script).toMatch(/^BEGIN;\n/);
  });

  it('is unchanged when nothing was edited', () => {
    const { snapshot: snap, orders } = pgWorld();
    const design = designTable(orders, structuredClone(orders), pgContext(snap));
    expect(design.unchanged).toBe(true);
    expect(design.statements).toEqual([]);
    expect(design.script).toBe('');
    expect(design.issues).toEqual([]);
  });

  it('renames a column from the rename map, with dependent definitions following it', () => {
    const { snapshot: snap, orders } = pgWorld();
    const edited = edit(orders, (t) => ({
      columns: t.columns.map((c) => (c.name === 'qty' ? { ...c, name: 'quantity' } : c)),
    }));
    const design = designTable(orders, edited, pgContext(snap, { columns: { qty: 'quantity' } }));
    expect(errors(design)).toEqual([]);
    expect(design.statements).toEqual([
      'BEGIN',
      'ALTER TABLE "public"."orders" RENAME COLUMN "qty" TO "quantity"',
      'COMMIT',
    ]);
    expect(design.operations.map((op) => op.kind)).toEqual(['rename']);
    // The check, still written against qty, follows the rename like PostgreSQL does.
    expect(design.table.checks[0]!.expression).toBe('(quantity > 0)');
  });

  it('drops and adds a column when the rename map does not name it', () => {
    const { snapshot: snap, orders } = pgWorld();
    const edited = edit(orders, (t) => ({
      columns: t.columns.map((c) => (c.name === 'price' ? { ...c, name: 'amount' } : c)),
    }));
    const design = designTable(orders, edited, pgContext(snap));
    expect(design.statements).toContainEqual('ALTER TABLE "public"."orders" DROP COLUMN "price"');
    expect(design.statements).toContainEqual(
      'ALTER TABLE "public"."orders" ADD COLUMN "amount" numeric(10,2)',
    );
    expect(design.dataLoss).toContainEqual(
      expect.objectContaining({
        severity: 'data-loss',
        objectKind: 'column',
        objectName: 'price',
        checkQuery: 'SELECT COUNT(*) FROM "public"."orders" WHERE "price" IS NOT NULL',
      }),
    );
  });

  it('rebuilds the dependent view around a type change', () => {
    const { snapshot: snap, orders } = pgWorld();
    const design = designTable(
      orders,
      setColumn(orders, 'qty', { dataType: 'bigint' }),
      pgContext(snap),
    );
    expect(errors(design)).toEqual([]);
    const s = design.statements;
    const dropView = s.indexOf('DROP VIEW "public"."big_orders"');
    const alter = s.indexOf('ALTER TABLE "public"."orders" ALTER COLUMN "qty" TYPE bigint');
    const createView = s.findIndex((x) => x.startsWith('CREATE VIEW "public"."big_orders"'));
    expect(dropView).toBeGreaterThan(0);
    expect(alter).toBeGreaterThan(dropView);
    expect(createView).toBeGreaterThan(alter);
    expect(design.warnings.some((w) => w.code === 'rebuild')).toBe(true);
    expect(design.dataLoss).toEqual([]);
  });

  it('reports narrowing, NOT NULL, defaults and identity changes', () => {
    const { snapshot: snap, orders } = pgWorld();
    let edited = setColumn(orders, 'code', { dataType: 'varchar(8)' });
    edited = setColumn(edited, 'price', { nullable: false, default: '0' });
    edited = setColumn(edited, 'placed_at', { default: null });
    edited = setColumn(edited, 'id', {
      identity: { generation: 'by-default', start: '1', increment: '1' },
    });
    const design = designTable(orders, edited, pgContext(snap));
    expect(design.statements).toEqual(
      expect.arrayContaining([
        'ALTER TABLE "public"."orders" ALTER COLUMN "code" TYPE character varying(8) USING "code"::character varying(8)',
        'ALTER TABLE "public"."orders" ALTER COLUMN "price" SET NOT NULL',
        'ALTER TABLE "public"."orders" ALTER COLUMN "price" SET DEFAULT 0',
        'ALTER TABLE "public"."orders" ALTER COLUMN "placed_at" DROP DEFAULT',
        'ALTER TABLE "public"."orders" ALTER COLUMN "id" SET GENERATED BY DEFAULT',
      ]),
    );
    const byColumn = Object.fromEntries(design.dataLoss.map((w) => [w.objectName, w]));
    expect(byColumn.code).toMatchObject({
      severity: 'data-loss',
      path: 'columns[2]',
      checkQuery: 'SELECT COUNT(*) FROM "public"."orders" WHERE char_length("code") > 8',
    });
    expect(byColumn.price).toMatchObject({
      severity: 'may-fail',
      checkQuery: 'SELECT COUNT(*) FROM "public"."orders" WHERE "price" IS NULL',
      findQuery: 'SELECT * FROM "public"."orders" WHERE "price" IS NULL LIMIT 100',
    });
  });

  it('changes indexes, checks, foreign keys, triggers, options and comments', () => {
    const { snapshot: snap, orders } = pgWorld();
    const edited = edit(orders, (t) => ({
      indexes: [
        {
          name: 'orders_note_idx',
          columns: [{ name: null, expression: 'upper(note)', order: 'asc' }],
          unique: false,
          include: [],
          invisible: false,
        },
        {
          name: 'orders_customer_idx',
          columns: [{ name: 'customer_id', order: 'asc' }],
          unique: true,
          include: ['qty'],
          invisible: false,
          where: 'qty > 0',
        },
      ],
      checks: [{ name: 'orders_qty_check', expression: 'qty > 1' }],
      foreignKeys: t.foreignKeys.map((fk) => ({ ...fk, onDelete: 'RESTRICT' as const })),
      triggers: [],
      options: { fillfactor: '90' },
      comment: 'All orders',
      columns: t.columns.map((c) => (c.name === 'note' ? { ...c, comment: 'Customer note' } : c)),
    }));
    const design = designTable(orders, edited, pgContext(snap));
    expect(errors(design)).toEqual([]);
    expect(design.statements).toEqual(
      expect.arrayContaining([
        'DROP INDEX "public"."orders_note_idx"',
        'CREATE INDEX "orders_note_idx" ON "public"."orders" ((upper(note)))',
        'CREATE UNIQUE INDEX "orders_customer_idx" ON "public"."orders" ("customer_id") INCLUDE ("qty") WHERE (qty > 0)',
        'ALTER TABLE "public"."orders" DROP CONSTRAINT "orders_qty_check"',
        'ALTER TABLE "public"."orders" ADD CONSTRAINT "orders_qty_check" CHECK (qty > 1)',
        'ALTER TABLE "public"."orders" DROP CONSTRAINT "orders_customer_fk"',
        'ALTER TABLE "public"."orders" ADD CONSTRAINT "orders_customer_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers" ("id") ON DELETE RESTRICT',
        'DROP TRIGGER "orders_touch" ON "public"."orders"',
        'ALTER TABLE "public"."orders" SET (fillfactor=90)',
        `COMMENT ON TABLE "public"."orders" IS 'All orders'`,
        `COMMENT ON COLUMN "public"."orders"."note" IS 'Customer note'`,
      ]),
    );
    const kinds = design.dataLoss.map((w) => `${w.severity}:${w.objectKind}:${w.objectName}`);
    expect(kinds).toEqual(
      expect.arrayContaining([
        'may-fail:index:orders_customer_idx',
        'may-fail:check:orders_qty_check',
        'may-fail:foreign-key:orders_customer_fk',
        'info:trigger:orders_touch',
      ]),
    );
    const unique = design.dataLoss.find((w) => w.objectName === 'orders_customer_idx')!;
    expect(unique.checkQuery).toBe(
      'SELECT COALESCE(SUM(n), 0) FROM (SELECT COUNT(*) AS n FROM "public"."orders" WHERE "customer_id" IS NOT NULL AND (qty > 0) GROUP BY "customer_id" HAVING COUNT(*) > 1) d',
    );
    const fk = design.dataLoss.find((w) => w.objectKind === 'foreign-key')!;
    expect(fk.checkQuery).toBe(
      'SELECT COUNT(*) FROM "public"."orders" c WHERE c."customer_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "public"."customers" r WHERE r."id" = c."customer_id")',
    );
  });

  it('rebuilds referencing foreign keys around a primary key change', () => {
    const { snapshot: snap, orders } = pgWorld();
    const edited = edit(orders, () => ({
      primaryKey: { name: 'orders_pkey', columns: ['id', 'customer_id'] },
    }));
    const design = designTable(orders, edited, pgContext(snap));
    // order_lines references (id): the new key no longer matches it.
    expect(codes(design.issues)).toContain('referenced-key-dropped');
    const ok = designTable(
      orders,
      edit(orders, (t) => ({
        primaryKey: { name: 'orders_pk', columns: ['id'] },
        uniques: t.uniques,
      })),
      pgContext(snap, { constraints: { orders_pkey: 'orders_pk' } }),
    );
    expect(ok.statements).toContainEqual(
      'ALTER TABLE "public"."orders" RENAME CONSTRAINT "orders_pkey" TO "orders_pk"',
    );
  });

  it('renames the table; other tables’ foreign keys and the view follow it', () => {
    const { snapshot: snap, orders } = pgWorld();
    const design = designTable(orders, { ...orders, name: 'purchases' }, pgContext(snap));
    expect(errors(design)).toEqual([]);
    expect(design.statements).toEqual([
      'BEGIN',
      'ALTER TABLE "public"."orders" RENAME TO "purchases"',
      'COMMIT',
    ]);
    expect(design.table.triggers[0]!.definition).toContain('ON public.purchases');
    expect(design.table.indexes[0]!.definition).toBe(
      'CREATE INDEX "orders_note_idx" ON "public"."purchases" USING btree (lower(note))',
    );
  });

  it('flags a column reorder as unsupported instead of rebuilding the table', () => {
    const { snapshot: snap, orders } = pgWorld();
    const reordered = {
      ...orders,
      columns: [orders.columns[1]!, orders.columns[0]!, ...orders.columns.slice(2)],
    };
    const design = designTable(orders, reordered, pgContext(snap));
    expect(design.unchanged).toBe(true);
    expect(design.valid).toBe(true);
    expect(design.issues).toContainEqual(
      expect.objectContaining({ code: 'reorder-unsupported', severity: 'warning' }),
    );
    expect(design.warnings).toContainEqual(expect.objectContaining({ code: 'unsupported' }));
    const inserted = {
      ...orders,
      columns: [orders.columns[0]!, col('extra', 'text'), ...orders.columns.slice(1)],
    };
    expect(codes(designTable(orders, inserted, pgContext(snap)).issues)).toContain(
      'reorder-unsupported',
    );
  });

  it('refuses to drop a column a view or another table still uses', () => {
    const { snapshot: snap, orders } = pgWorld();
    const noQty = edit(orders, (t) => ({
      columns: t.columns.filter((c) => c.name !== 'qty'),
      checks: [],
    }));
    const design = designTable(orders, noQty, pgContext(snap));
    expect(design.valid).toBe(false);
    expect(errors(design)).toContain('dropped-column-in-view');
    const noId = edit(orders, (t) => ({
      columns: t.columns.filter((c) => c.name !== 'id'),
      primaryKey: undefined,
    }));
    expect(errors(designTable(orders, noId, pgContext(snap)))).toContain(
      'dropped-column-referenced',
    );
    const checkUses = edit(orders, (t) => ({
      columns: t.columns.filter((c) => c.name !== 'note'),
      indexes: [],
    }));
    expect(errors(designTable(orders, checkUses, pgContext(snap)))).toContain(
      'dropped-column-in-view',
    );
  });

  it('expands serial on an existing column into a sequence the column owns', () => {
    const { snapshot: snap, orders } = pgWorld();
    const design = designTable(
      orders,
      edit(orders, (t) => ({ columns: [...t.columns, col('ref', 'serial')] })),
      pgContext(snap),
    );
    expect(design.statements).toEqual(
      expect.arrayContaining([
        'CREATE SEQUENCE "public"."orders_ref_seq" AS integer INCREMENT BY 1 START WITH 1 NO CYCLE',
        `ALTER TABLE "public"."orders" ADD COLUMN "ref" integer DEFAULT nextval('public.orders_ref_seq'::regclass) NOT NULL`,
        'ALTER SEQUENCE "public"."orders_ref_seq" OWNED BY "public"."orders"."ref"',
      ]),
    );
  });

  it('marks partition key changes unsupported', () => {
    const live = table({
      name: 'events',
      kind: 'partitioned',
      columns: [col('id', 'integer', { nullable: false }), col('at', 'date', { nullable: false })],
      partitioning: {
        method: 'RANGE',
        key: 'at',
        partitions: [
          { name: 'events_2024', bound: "FOR VALUES FROM ('2024-01-01') TO ('2025-01-01')" },
        ],
      },
    });
    const snap = snapshot('postgres', [{ name: 'public', tables: [live] }]);
    const changed = { ...live, partitioning: { ...live.partitioning!, key: 'id' } };
    const design = designTable(live, changed, pgContext(snap));
    expect(design.valid).toBe(false);
    expect(errors(design)).toContain('unsupported-change');
    const more = {
      ...live,
      partitioning: {
        ...live.partitioning!,
        partitions: [
          ...live.partitioning!.partitions,
          { name: 'events_2025', bound: "FOR VALUES FROM ('2025-01-01') TO ('2026-01-01')" },
        ],
      },
    };
    expect(designTable(live, more, pgContext(snap)).statements).toContainEqual(
      `CREATE TABLE "public"."events_2025" PARTITION OF "public"."events" FOR VALUES FROM ('2025-01-01') TO ('2026-01-01')`,
    );
    const fewer = { ...live, partitioning: { ...live.partitioning!, partitions: [] } };
    expect(designTable(live, fewer, pgContext(snap)).dataLoss).toContainEqual(
      expect.objectContaining({
        severity: 'data-loss',
        objectKind: 'partition',
        checkQuery: 'SELECT COUNT(*) FROM "public"."events_2024"',
      }),
    );
  });

  it('works without a snapshot', () => {
    const { orders } = pgWorld();
    const design = designTable(orders, setColumn(orders, 'note', { dataType: 'varchar(40)' }), {
      engine: 'postgres',
      schema: 'public',
    });
    expect(design.valid).toBe(true);
    expect(design.statements).toContainEqual(
      'ALTER TABLE "public"."orders" ALTER COLUMN "note" TYPE character varying(40) USING "note"::character varying(40)',
    );
  });
});

// ---------------------------------------------------------------------------------------------
// MySQL and MariaDB

describe('designTable on MySQL and MariaDB', () => {
  it('creates a new table with keys, the foreign-key index MySQL adds, and table options', () => {
    const { snapshot: snap } = myWorld();
    const t = table({
      name: 'invoices',
      columns: [
        col('id', 'integer unsigned', { nullable: false, autoIncrement: true }),
        col('customer_id', 'int', { nullable: false }),
        col('number', 'character varying(20)', { nullable: false }),
        col('body', 'text'),
        col('paid', 'bool', { nullable: false, default: '0' }),
        col('created_at', 'datetime(3)', {
          nullable: false,
          default: 'CURRENT_TIMESTAMP(3)',
          comment: 'Created',
        }),
      ],
      primaryKey: { name: 'PRIMARY', columns: ['id'] },
      uniques: [{ name: 'uq_number', columns: ['number'] }],
      indexes: [{ name: 'idx_body', columns: [{ name: 'body', length: 32 }] }],
      foreignKeys: [
        {
          name: 'fk_invoices_customer',
          columns: ['customer_id'],
          refTable: 'customers',
          refColumns: ['id'],
        },
      ],
      checks: [{ name: 'invoices_number_check', expression: "number <> ''" }],
      options: { engine: 'InnoDB', rowFormat: 'DYNAMIC' },
      comment: 'Invoices',
    });
    const design = designTable(null, t, myContext(snap));
    expect(errors(design)).toEqual([]);
    expect(design.transactional).toBe(false);
    expect(design.warnings).toContainEqual(expect.objectContaining({ code: 'non-transactional' }));
    expect(design.statements).toEqual([
      [
        'CREATE TABLE `invoices` (',
        '  `id` int unsigned NOT NULL AUTO_INCREMENT,',
        '  `customer_id` int NOT NULL,',
        '  `number` varchar(20) NOT NULL,',
        '  `body` text,',
        '  `paid` tinyint(1) NOT NULL DEFAULT 0,',
        "  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT 'Created',",
        '  PRIMARY KEY (`id`),',
        '  KEY `idx_body` (`body`(32)),',
        '  UNIQUE KEY `uq_number` (`number`),',
        '  KEY `fk_invoices_customer` (`customer_id`),',
        "  CONSTRAINT `invoices_number_check` CHECK (number <> '')",
        ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci ROW_FORMAT=DYNAMIC COMMENT='Invoices'",
      ].join('\n'),
      'ALTER TABLE `invoices` ADD CONSTRAINT `fk_invoices_customer` FOREIGN KEY (`customer_id`) REFERENCES `customers` (`id`)',
    ]);
    expect(design.table.uniques).toEqual([]);
    expect(design.table.indexes.map((i) => [i.name, i.unique])).toEqual([
      ['idx_body', false],
      ['uq_number', true],
      ['fk_invoices_customer', false],
    ]);
  });

  it('renames with CHANGE COLUMN, moves columns with AFTER/FIRST and re-creates triggers that use a renamed column', () => {
    const { snapshot: snap, orders } = myWorld();
    const cols = orders.columns.map((c) => (c.name === 'code' ? { ...c, name: 'order_code' } : c));
    const status = cols.find((c) => c.name === 'status')!;
    const edited = edit(orders, (t) => ({
      columns: [status, ...cols.filter((c) => c !== status)],
      indexes: t.indexes.map((i) =>
        i.name === 'uq_code'
          ? { ...i, columns: [{ name: 'order_code', order: 'asc' as const }] }
          : i,
      ),
    }));
    const design = designTable(
      orders,
      edited,
      myContext(snap, { columns: { code: 'order_code' } }),
    );
    expect(errors(design)).toEqual([]);
    expect(design.statements).toEqual(
      expect.arrayContaining([
        "ALTER TABLE `orders` MODIFY COLUMN `status` enum('new','paid','shipped') CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL DEFAULT 'new' FIRST",
        'ALTER TABLE `orders` CHANGE COLUMN `code` `order_code` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL',
        'DROP TRIGGER IF EXISTS `orders_bi`',
        'CREATE TRIGGER `orders_bi` BEFORE INSERT ON `orders` FOR EACH ROW SET NEW.order_code = UPPER(NEW.order_code)',
      ]),
    );
    expect(design.statements.some((s) => /DROP COLUMN/.test(s))).toBe(false);
    // MySQL views keep the old column name: the view is re-created with the new one.
    expect(design.statements).toContainEqual(
      'CREATE OR REPLACE VIEW `order_codes` AS select `o`.`id` AS `id`,`o`.`order_code` AS `code` from `orders` `o`',
    );
    const create = design.statements.findIndex((s) => s.startsWith('CREATE TRIGGER'));
    const change = design.statements.findIndex((s) => s.includes('CHANGE COLUMN'));
    expect(create).toBeGreaterThan(change);
  });

  it('reports enum label removal, narrowing and charset conversion with check queries', () => {
    const { snapshot: snap, orders } = myWorld();
    let edited = setColumn(orders, 'status', { dataType: "enum('new','paid')" });
    edited = setColumn(edited, 'qty', { dataType: 'smallint unsigned' });
    edited = setColumn(edited, 'note', {
      dataType: 'varchar(255)',
      charset: 'latin1',
      collation: 'latin1_swedish_ci',
    });
    edited = setColumn(edited, 'price', { dataType: 'decimal(8,1)' });
    const design = designTable(orders, edited, myContext(snap));
    const q = Object.fromEntries(
      design.dataLoss.map((w) => [`${w.objectName}:${w.message.slice(0, 12)}`, w.checkQuery]),
    );
    expect(Object.values(q)).toEqual(
      expect.arrayContaining([
        "SELECT COUNT(*) FROM `shop`.`orders` WHERE `status` IN ('shipped')",
        'SELECT COUNT(*) FROM `shop`.`orders` WHERE `qty` < 0 OR `qty` > 65535',
        'SELECT COUNT(*) FROM `shop`.`orders` WHERE CHAR_LENGTH(`note`) > 255',
        'SELECT COUNT(*) FROM `shop`.`orders` WHERE CAST(CONVERT(CONVERT(`note` USING latin1) USING utf8mb4) AS BINARY) <> CAST(`note` AS BINARY)',
        'SELECT COUNT(*) FROM `shop`.`orders` WHERE ABS(`price`) >= 10000000 OR `price` <> ROUND(`price`, 1)',
      ]),
    );
    expect(design.dataLoss.every((w) => w.severity === 'data-loss')).toBe(true);
  });

  it('changes AUTO_INCREMENT, indexes, keys, checks, options and comments', () => {
    const { snapshot: snap, orders } = myWorld();
    const edited = edit(orders, (t) => ({
      columns: t.columns.map((c) => (c.name === 'note' ? { ...c, comment: 'Free text' } : c)),
      indexes: [
        ...t.indexes.filter((i) => i.name !== 'uq_code'),
        {
          name: 'idx_note',
          columns: [{ name: 'note', order: 'asc', length: 10 }],
          unique: true,
          include: [],
          invisible: true,
        },
      ],
      checks: [],
      options: { ...t.options, engine: 'InnoDB', rowFormat: 'COMPRESSED', autoIncrement: '1000' },
      comment: 'Customer orders',
    }));
    const design = designTable(orders, edited, myContext(snap));
    expect(errors(design)).toEqual([]);
    expect(design.statements).toEqual(
      expect.arrayContaining([
        'ALTER TABLE `orders` DROP INDEX `uq_code`',
        'ALTER TABLE `orders` ADD UNIQUE KEY `idx_note` (`note`(10)) INVISIBLE',
        'ALTER TABLE `orders` DROP CHECK `orders_qty_check`',
        "ALTER TABLE `orders` ROW_FORMAT=COMPRESSED AUTO_INCREMENT=1000 COMMENT='Customer orders'",
      ]),
    );
    expect(design.dataLoss.map((w) => `${w.severity}:${w.objectName}`)).toEqual(
      expect.arrayContaining(['info:uq_code', 'may-fail:idx_note']),
    );
  });

  it('writes FOREIGN_KEY_CHECKS only when asked to disable them', () => {
    const { snapshot: snap, orders } = myWorld();
    const edited = edit(orders, (t) => ({
      foreignKeys: t.foreignKeys.map((fk) => ({ ...fk, onDelete: 'CASCADE' as const })),
    }));
    const plain = designTable(orders, edited, myContext(snap));
    expect(plain.statements.some((s) => s.includes('FOREIGN_KEY_CHECKS'))).toBe(false);
    expect(plain.dataLoss.find((w) => w.objectKind === 'foreign-key')!.severity).toBe('may-fail');
    const off = designTable(orders, edited, {
      ...myContext(snap),
      options: { disableForeignKeyChecks: true },
    });
    expect(off.statements[0]).toBe('SET FOREIGN_KEY_CHECKS = 0');
    expect(off.dataLoss.find((w) => w.objectKind === 'foreign-key')!.severity).toBe('info');
  });

  it('adds AUTO_INCREMENT after its key and reports what it renumbers', () => {
    const { snapshot: snap, orders } = myWorld();
    const live = setColumn(orders, 'id', { autoIncrement: false });
    const design = designTable(live, orders, myContext(snap));
    expect(design.statements).toContainEqual(
      'ALTER TABLE `orders` MODIFY COLUMN `id` int unsigned NOT NULL AUTO_INCREMENT',
    );
    expect(design.dataLoss).toContainEqual(
      expect.objectContaining({
        severity: 'info',
        checkQuery: 'SELECT COUNT(*) FROM `shop`.`orders` WHERE `id` = 0 OR `id` IS NULL',
      }),
    );
  });

  it('stores MariaDB JSON as LONGTEXT with its json_valid check, as MariaDB reports it', () => {
    const { snapshot: snap, orders } = myWorld('mariadb');
    const edited = edit(orders, (t) => ({ columns: [...t.columns, col('meta', 'json')] }));
    const design = designTable(orders, edited, myContext(snap));
    expect(errors(design)).toEqual([]);
    expect(design.statements).toContainEqual(
      'ALTER TABLE `orders` ADD COLUMN `meta` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin CHECK (json_valid(`meta`)) AFTER `price`',
    );
    const meta = design.table.columns.find((c) => c.name === 'meta')!;
    expect(meta).toMatchObject({ dataType: 'longtext', collation: 'utf8mb4_bin' });
    expect(design.table.checks.map((c) => c.name)).toContain('meta');
    expect(design.warnings.some((w) => w.message.startsWith('MariaDB DDL'))).toBe(true);
  });

  it('drops a table with the row count, refusing while other tables reference it', () => {
    const { snapshot: snap, orders } = myWorld();
    const design = designDropTable(orders, myContext(snap));
    expect(design.statements).toEqual(['DROP TABLE `orders`']);
    expect(design.dataLoss).toEqual([
      expect.objectContaining({
        severity: 'data-loss',
        checkQuery: 'SELECT COUNT(*) FROM `shop`.`orders`',
      }),
    ]);
    expect(design.issues).toContainEqual(
      expect.objectContaining({ code: 'dependent-view', severity: 'warning' }),
    );
    const customers = snap.schemas[0]!.tables.find((t) => t.name === 'customers')!;
    const refused = designDropTable(customers, myContext(snap));
    expect(refused.valid).toBe(false);
    expect(codes(refused.issues)).toContain('referenced-table');
  });
});

// ---------------------------------------------------------------------------------------------
// Data-loss analysis, table-driven

describe('data-loss warnings by type change', () => {
  const cases: [
    SqlEngineId,
    string,
    string,
    'data-loss' | 'may-fail' | 'info' | null,
    string | null,
  ][] = [
    ['postgres', 'integer', 'bigint', null, null],
    ['postgres', 'bigint', 'integer', 'data-loss', '"v" < -2147483648 OR "v" > 2147483647'],
    ['postgres', 'integer', 'smallint', 'data-loss', '"v" < -32768 OR "v" > 32767'],
    [
      'postgres',
      'character varying(100)',
      'character varying(50)',
      'data-loss',
      'char_length("v") > 50',
    ],
    ['postgres', 'character varying(50)', 'character varying(100)', null, null],
    ['postgres', 'character varying(50)', 'text', null, null],
    ['postgres', 'text', 'character varying(10)', 'data-loss', 'char_length("v") > 10'],
    ['postgres', 'numeric(12,4)', 'numeric(12,2)', 'data-loss', '"v" <> ROUND("v", 2)'],
    ['postgres', 'numeric(12,2)', 'numeric(8,2)', 'data-loss', 'ABS("v") >= 1000000'],
    ['postgres', 'numeric(8,2)', 'numeric(12,2)', null, null],
    [
      'postgres',
      'timestamp with time zone',
      'timestamp without time zone',
      'data-loss',
      '"v" IS NOT NULL',
    ],
    [
      'postgres',
      'timestamp without time zone',
      'timestamp with time zone',
      'info',
      '"v" IS NOT NULL',
    ],
    [
      'postgres',
      'timestamp(6) without time zone',
      'timestamp(0) without time zone',
      'data-loss',
      '"v" <> CAST("v" AS timestamp(0) without time zone)',
    ],
    ['postgres', 'text', 'integer', 'data-loss', '"v" IS NOT NULL'],
    ['postgres', 'double precision', 'real', 'data-loss', null],
    ['postgres', 'date', 'timestamp without time zone', null, null],
    ['mysql', 'int', 'bigint', null, null],
    ['mysql', 'bigint', 'int', 'data-loss', '`v` < -2147483648 OR `v` > 2147483647'],
    ['mysql', 'int unsigned', 'int', 'data-loss', '`v` < -2147483648 OR `v` > 2147483647'],
    ['mysql', 'int', 'int unsigned', 'data-loss', '`v` < 0 OR `v` > 4294967295'],
    ['mysql', 'varchar(100)', 'varchar(50)', 'data-loss', 'CHAR_LENGTH(`v`) > 50'],
    ['mysql', 'text', 'varchar(10)', 'data-loss', 'CHAR_LENGTH(`v`) > 10'],
    ['mysql', 'mediumtext', 'text', 'data-loss', 'LENGTH(`v`) > 65535'],
    ['mysql', 'varbinary(16)', 'varbinary(8)', 'data-loss', 'LENGTH(`v`) > 8'],
    ['mysql', 'decimal(10,2)', 'decimal(10,4)', 'data-loss', 'ABS(`v`) >= 1000000'],
    ['mysql', 'datetime(3)', 'datetime', 'data-loss', '`v` <> CAST(`v` AS DATETIME(0))'],
    ['mysql', "enum('a','b','c')", "enum('a','b')", 'data-loss', "`v` IN ('c')"],
    ['mysql', "enum('a','b')", "enum('a','b','c')", null, null],
    [
      'mysql',
      "set('a','b','c')",
      "set('a')",
      'data-loss',
      "FIND_IN_SET('b', `v`) > 0 OR FIND_IN_SET('c', `v`) > 0",
    ],
    ['mysql', 'int(11)', 'int', null, null],
    ['mariadb', 'tinyint(1)', 'int', null, null],
  ];
  it.each(cases)('%s: %s → %s', (engine, from, to, severity, where) => {
    const pg = engine === 'postgres';
    const live = table({
      name: 't',
      columns: [col('id', pg ? 'integer' : 'int', { nullable: false }), col('v', from)],
    });
    const design = designTable(live, setColumn(live, 'v', { dataType: to }), {
      engine,
      schema: pg ? 'public' : 'db',
    });
    const warning = design.dataLoss.find((w) => w.objectName === 'v');
    if (severity === null) {
      expect(warning).toBeUndefined();
      return;
    }
    expect(warning?.severity).toBe(severity);
    const table_ = pg ? '"public"."t"' : '`db`.`t`';
    expect(warning?.checkQuery).toBe(
      where === null ? undefined : `SELECT COUNT(*) FROM ${table_} WHERE ${where}`,
    );
  });

  it('counts duplicates for a new primary key and rows a new NOT NULL column needs', () => {
    const live = table({
      name: 't',
      columns: [col('a', 'integer', { nullable: false }), col('b', 'text')],
    });
    const design = designTable(
      live,
      {
        ...live,
        primaryKey: { name: 't_pkey', columns: ['a', 'b'] },
        columns: [
          live.columns[0]!,
          { ...live.columns[1]!, nullable: false },
          col('c', 'integer', { nullable: false }),
        ],
      },
      { engine: 'postgres', schema: 'public' },
    );
    const byKind = Object.fromEntries(
      design.dataLoss.map((w) => [`${w.objectKind}:${w.objectName}`, w]),
    );
    expect(byKind['primary-key:t_pkey']).toMatchObject({
      severity: 'may-fail',
      checkQuery:
        'SELECT COALESCE(SUM(n), 0) FROM (SELECT COUNT(*) AS n FROM "public"."t" WHERE "a" IS NOT NULL AND "b" IS NOT NULL GROUP BY "a", "b" HAVING COUNT(*) > 1) d',
      findQuery:
        'SELECT "a", "b", COUNT(*) AS duplicates FROM "public"."t" WHERE "a" IS NOT NULL AND "b" IS NOT NULL GROUP BY "a", "b" HAVING COUNT(*) > 1 ORDER BY COUNT(*) DESC LIMIT 100',
    });
    expect(byKind['column:b']).toMatchObject({
      severity: 'may-fail',
      checkQuery: 'SELECT COUNT(*) FROM "public"."t" WHERE "b" IS NULL',
    });
    expect(byKind['column:c']).toMatchObject({
      severity: 'may-fail',
      checkQuery: 'SELECT COUNT(*) FROM "public"."t"',
    });
  });

  it('writes check queries with the live names when columns are renamed in the same save', () => {
    const live = table({
      name: 't',
      columns: [col('id', 'int', { nullable: false }), col('qty', 'int')],
    });
    const edited = {
      ...live,
      columns: [live.columns[0]!, { ...live.columns[1]!, name: 'amount', nullable: false }],
      checks: [{ name: 't_amount', expression: 'amount > 0' }],
    };
    const design = designTable(live, edited, {
      engine: 'mariadb',
      schema: 'db',
      renames: { columns: { qty: 'amount' } },
    });
    expect(design.dataLoss.map((w) => w.checkQuery)).toEqual(
      expect.arrayContaining([
        'SELECT COUNT(*) FROM `db`.`t` WHERE `qty` IS NULL',
        'SELECT COUNT(*) FROM `db`.`t` WHERE NOT (qty > 0)',
      ]),
    );
  });
});

// ---------------------------------------------------------------------------------------------
// Validation, table-driven

describe('validateTable', () => {
  type Case = [
    string,
    SqlEngineId,
    string | undefined,
    (t: TableDef) => TableDef,
    string,
    string,
    ('error' | 'warning')?,
  ];
  const base = (engine: SqlEngineId): TableDef =>
    table({
      name: 't',
      columns: [
        col('id', engine === 'postgres' ? 'integer' : 'int', { nullable: false }),
        col('name', engine === 'postgres' ? 'text' : 'varchar(50)'),
        col('body', 'text'),
      ],
      primaryKey: { name: engine === 'postgres' ? 't_pkey' : 'PRIMARY', columns: ['id'] },
    });
  const cases: Case[] = [
    [
      'unknown type',
      'postgres',
      '16',
      (t) => setColumn(t, 'name', { dataType: 'strng' }),
      'columns[1].dataType',
      'unknown-type',
    ],
    [
      'malformed type',
      'mysql',
      '8.4',
      (t) => setColumn(t, 'name', { dataType: 'varchar(10' }),
      'columns[1].dataType',
      'malformed-type',
    ],
    [
      'type too new',
      'mysql',
      '5.7.5',
      (t) => setColumn(t, 'name', { dataType: 'json' }),
      'columns[1].dataType',
      'type-version',
    ],
    [
      'varchar length',
      'mysql',
      '8.4',
      (t) => setColumn(t, 'name', { dataType: 'varchar(70000)' }),
      'columns[1].dataType',
      'parameter-range',
    ],
    [
      'varchar row limit',
      'mysql',
      '8.4',
      (t) => setColumn(t, 'name', { dataType: 'varchar(20000)' }),
      'columns[1].dataType',
      'parameter-range',
    ],
    [
      'varchar needs a length',
      'mysql',
      '8.4',
      (t) => setColumn(t, 'name', { dataType: 'varchar' }),
      'columns[1].dataType',
      'parameter-required',
    ],
    [
      'decimal precision',
      'mysql',
      '8.4',
      (t) => setColumn(t, 'name', { dataType: 'decimal(70,2)' }),
      'columns[1].dataType',
      'parameter-range',
    ],
    [
      'scale above precision',
      'mysql',
      '8.4',
      (t) => setColumn(t, 'name', { dataType: 'decimal(4,6)' }),
      'columns[1].dataType',
      'parameter-range',
    ],
    [
      'numeric precision',
      'postgres',
      '16',
      (t) => setColumn(t, 'name', { dataType: 'numeric(1001,2)' }),
      'columns[1].dataType',
      'parameter-range',
    ],
    [
      'fsp',
      'mysql',
      '8.4',
      (t) => setColumn(t, 'name', { dataType: 'datetime(7)' }),
      'columns[1].dataType',
      'parameter-range',
    ],
    [
      'length on integer',
      'postgres',
      '16',
      (t) => setColumn(t, 'name', { dataType: 'integer(5)' }),
      'columns[1].dataType',
      'unexpected-parameter',
    ],
    [
      'unsigned text',
      'mysql',
      '8.4',
      (t) => setColumn(t, 'name', { dataType: 'varchar(5) unsigned' }),
      'columns[1].dataType',
      'unsigned-type',
    ],
    [
      'duplicate enum label',
      'mysql',
      '8.4',
      (t) => setColumn(t, 'name', { dataType: "enum('a','A')" }),
      'columns[1].dataType',
      'duplicate-label',
    ],
    [
      'display width deprecated',
      'mysql',
      '8.4',
      (t) => setColumn(t, 'id', { dataType: 'int(11)' }),
      'columns[0].dataType',
      'deprecated',
      'warning',
    ],
    [
      'AUTO_INCREMENT on text',
      'mysql',
      '8.4',
      (t) => setColumn(t, 'name', { autoIncrement: true }),
      'columns[1].autoIncrement',
      'auto-increment-type',
    ],
    [
      'two AUTO_INCREMENT',
      'mysql',
      '8.4',
      (t) =>
        setColumn(setColumn(t, 'id', { autoIncrement: true }), 'body', {
          dataType: 'int',
          autoIncrement: true,
        }),
      'columns[2].autoIncrement',
      'auto-increment-count',
    ],
    [
      'AUTO_INCREMENT without key',
      'mysql',
      '8.4',
      (t) => ({ ...setColumn(t, 'id', { autoIncrement: true }), primaryKey: undefined }),
      'columns[0].autoIncrement',
      'auto-increment-key',
    ],
    [
      'AUTO_INCREMENT on PostgreSQL',
      'postgres',
      '16',
      (t) => setColumn(t, 'id', { autoIncrement: true }),
      'columns[0].autoIncrement',
      'auto-increment-unsupported',
    ],
    [
      'identity with default',
      'postgres',
      '16',
      (t) => setColumn(t, 'id', { identity: { generation: 'always' }, default: '1' }),
      'columns[0].default',
      'identity-default',
    ],
    [
      'identity on text',
      'postgres',
      '16',
      (t) => setColumn(t, 'name', { identity: { generation: 'always' }, nullable: false }),
      'columns[1].identity',
      'identity-type',
    ],
    [
      'nullable identity',
      'postgres',
      '16',
      (t) => setColumn(t, 'body', { dataType: 'bigint', identity: { generation: 'by-default' } }),
      'columns[2].nullable',
      'identity-nullable',
      'warning',
    ],
    [
      'generated with default',
      'mysql',
      '8.4',
      (t) =>
        setColumn(t, 'body', { generated: { expression: 'id * 2', stored: true }, default: "'x'" }),
      'columns[2].default',
      'generated-default',
    ],
    [
      'virtual generated before PG 18',
      'postgres',
      '16',
      (t) => setColumn(t, 'body', { generated: { expression: 'id * 2', stored: false } }),
      'columns[2].generated.stored',
      'virtual-generated-version',
    ],
    [
      'MariaDB NOT NULL generated',
      'mariadb',
      '11.4',
      (t) =>
        setColumn(t, 'body', {
          dataType: 'int',
          nullable: false,
          generated: { expression: 'id * 2', stored: true },
        }),
      'columns[2].nullable',
      'generated-not-null',
    ],
    [
      'TEXT literal default on MySQL',
      'mysql',
      '8.4',
      (t) => setColumn(t, 'body', { default: "'x'" }),
      'columns[2].default',
      'literal-default-not-allowed',
    ],
    [
      'TEXT expression default before 8.0.13',
      'mysql',
      '8.0.12',
      (t) => setColumn(t, 'body', { default: "('x')" }),
      'columns[2].default',
      'expression-default-version',
    ],
    [
      'CURRENT_TIMESTAMP on int',
      'mysql',
      '8.4',
      (t) => setColumn(t, 'body', { dataType: 'int', default: 'CURRENT_TIMESTAMP' }),
      'columns[2].default',
      'default-type',
    ],
    [
      'text default on number',
      'postgres',
      '16',
      (t) => setColumn(t, 'id', { default: "'abc'" }),
      'columns[0].default',
      'default-type',
    ],
    [
      'unbalanced default',
      'postgres',
      '16',
      (t) => setColumn(t, 'name', { default: "lower('x'" }),
      'columns[1].default',
      'default-syntax',
    ],
    [
      'empty default',
      'mysql',
      '8.4',
      (t) => setColumn(t, 'name', { default: ' ' }),
      'columns[1].default',
      'empty-default',
    ],
    [
      'ON UPDATE on PostgreSQL',
      'postgres',
      '16',
      (t) => setColumn(t, 'name', { onUpdate: 'now()' }),
      'columns[1].onUpdate',
      'on-update-unsupported',
    ],
    [
      'ON UPDATE on varchar',
      'mysql',
      '8.4',
      (t) => setColumn(t, 'name', { onUpdate: 'CURRENT_TIMESTAMP' }),
      'columns[1].onUpdate',
      'on-update-type',
    ],
    [
      'nullable primary key',
      'mysql',
      '8.4',
      (t) => setColumn(t, 'id', { nullable: true }),
      'columns[0].nullable',
      'nullable-primary-key',
      'warning',
    ],
    [
      'index on TEXT without prefix',
      'mysql',
      '8.4',
      (t) => ({
        ...t,
        indexes: [
          {
            name: 'i',
            columns: [{ name: 'body', order: 'asc' }],
            unique: false,
            include: [],
            invisible: false,
          },
        ],
      }),
      'indexes[0].columns[0]',
      'prefix-required',
    ],
    [
      'prefix on int',
      'mysql',
      '8.4',
      (t) => ({
        ...t,
        indexes: [
          {
            name: 'i',
            columns: [{ name: 'id', order: 'asc', length: 4 }],
            unique: false,
            include: [],
            invisible: false,
          },
        ],
      }),
      'indexes[0].columns[0]',
      'prefix-type',
    ],
    [
      'prefix longer than column',
      'mysql',
      '8.4',
      (t) => ({
        ...t,
        indexes: [
          {
            name: 'i',
            columns: [{ name: 'name', order: 'asc', length: 80 }],
            unique: false,
            include: [],
            invisible: false,
          },
        ],
      }),
      'indexes[0].columns[0]',
      'prefix-range',
    ],
    [
      'prefix on PostgreSQL',
      'postgres',
      '16',
      (t) => ({
        ...t,
        indexes: [
          {
            name: 'i',
            columns: [{ name: 'name', order: 'asc', length: 4 }],
            unique: false,
            include: [],
            invisible: false,
          },
        ],
      }),
      'indexes[0].columns[0]',
      'prefix-unsupported',
    ],
    [
      'partial index on MySQL',
      'mysql',
      '8.4',
      (t) => ({
        ...t,
        indexes: [
          {
            name: 'i',
            columns: [{ name: 'id', order: 'asc' }],
            unique: false,
            include: [],
            invisible: false,
            where: 'id > 0',
          },
        ],
      }),
      'indexes[0].where',
      'partial-index-unsupported',
    ],
    [
      'functional index on MariaDB',
      'mariadb',
      '11.4',
      (t) => ({
        ...t,
        indexes: [
          {
            name: 'i',
            columns: [{ name: null, expression: 'lower(name)', order: 'asc' }],
            unique: false,
            include: [],
            invisible: false,
          },
        ],
      }),
      'indexes[0].columns[0]',
      'expression-index-unsupported',
    ],
    [
      'index on unknown column',
      'postgres',
      '16',
      (t) => ({
        ...t,
        indexes: [
          {
            name: 'i',
            columns: [{ name: 'nope', order: 'asc' }],
            unique: false,
            include: [],
            invisible: false,
          },
        ],
      }),
      'indexes[0].columns[0]',
      'unknown-column',
    ],
    [
      'redundant index',
      'postgres',
      '16',
      (t) => ({
        ...t,
        indexes: [
          {
            name: 'i',
            columns: [{ name: 'id', order: 'asc' }],
            unique: false,
            include: [],
            invisible: false,
          },
        ],
      }),
      'indexes[0]',
      'redundant-index',
      'warning',
    ],
    [
      'duplicate column',
      'mysql',
      '8.4',
      (t) => ({ ...t, columns: [...t.columns, col('Name', 'int')] }),
      'columns[3].name',
      'duplicate-name',
    ],
    [
      'duplicate index name',
      'postgres',
      '16',
      (t) => ({ ...t, uniques: [{ name: 't_pkey', columns: ['name'] }] }),
      'uniques[0].name',
      'duplicate-name',
    ],
    [
      'empty column name',
      'postgres',
      '16',
      (t) => setColumn(t, 'name', { name: '' }),
      'columns[1].name',
      'name-required',
    ],
    [
      'reserved name',
      'postgres',
      '16',
      (t) => setColumn(t, 'name', { name: 'select' }),
      'columns[1].name',
      'reserved-name',
      'warning',
    ],
    [
      'mixed-case name',
      'postgres',
      '16',
      (t) => setColumn(t, 'name', { name: 'FullName' }),
      'columns[1].name',
      'mixed-case-name',
      'warning',
    ],
    [
      'name too long',
      'mysql',
      '8.4',
      (t) => setColumn(t, 'name', { name: 'x'.repeat(65) }),
      'columns[1].name',
      'name-too-long',
    ],
    [
      'charset on int',
      'mysql',
      '8.4',
      (t) => setColumn(t, 'id', { charset: 'latin1' }),
      'columns[0].charset',
      'charset-type',
    ],
    [
      'collation of another charset',
      'mysql',
      '8.4',
      (t) => setColumn(t, 'name', { charset: 'latin1', collation: 'utf8mb4_bin' }),
      'columns[1].collation',
      'collation-mismatch',
    ],
    [
      'table collation mismatch',
      'mysql',
      '8.4',
      (t) => ({ ...t, options: { charset: 'latin1', collation: 'utf8mb4_bin' } }),
      'options.collation',
      'collation-mismatch',
    ],
    [
      'collation on integer (PG)',
      'postgres',
      '16',
      (t) => setColumn(t, 'id', { collation: 'C' }),
      'columns[0].collation',
      'collation-type',
    ],
    [
      'FK column count',
      'postgres',
      '16',
      (t) => ({
        ...t,
        foreignKeys: [
          {
            name: 'f',
            columns: ['id'],
            refTable: 't',
            refColumns: ['id', 'name'],
            onUpdate: 'NO ACTION',
            onDelete: 'NO ACTION',
          },
        ],
      }),
      'foreignKeys[0].refColumns',
      'fk-column-count',
    ],
    [
      'FK type mismatch',
      'mysql',
      '8.4',
      (t) => ({
        ...setColumn(t, 'body', { dataType: 'bigint' }),
        foreignKeys: [
          {
            name: 'f',
            columns: ['body'],
            refTable: 't',
            refColumns: ['id'],
            onUpdate: 'NO ACTION',
            onDelete: 'NO ACTION',
          },
        ],
      }),
      'foreignKeys[0].columns[0]',
      'fk-type-mismatch',
    ],
    [
      'FK to a non-unique column',
      'postgres',
      '16',
      (t) => ({
        ...t,
        foreignKeys: [
          {
            name: 'f',
            columns: ['body'],
            refTable: 't',
            refColumns: ['name'],
            onUpdate: 'NO ACTION',
            onDelete: 'NO ACTION',
          },
        ],
      }),
      'foreignKeys[0].refColumns',
      'fk-no-unique-key',
    ],
    [
      'FK SET NULL on NOT NULL',
      'postgres',
      '16',
      (t) => ({
        ...t,
        foreignKeys: [
          {
            name: 'f',
            columns: ['id'],
            refTable: 't',
            refColumns: ['id'],
            onUpdate: 'NO ACTION',
            onDelete: 'SET NULL',
          },
        ],
      }),
      'foreignKeys[0].onDelete',
      'fk-set-null',
    ],
    [
      'FK SET DEFAULT on InnoDB',
      'mysql',
      '8.4',
      (t) => ({
        ...t,
        foreignKeys: [
          {
            name: 'f',
            columns: ['id'],
            refTable: 't',
            refColumns: ['id'],
            onUpdate: 'NO ACTION',
            onDelete: 'SET DEFAULT',
          },
        ],
      }),
      'foreignKeys[0].onDelete',
      'fk-action-unsupported',
    ],
    [
      'check that does not parse',
      'postgres',
      '16',
      (t) => ({ ...t, checks: [{ name: 'c', expression: '(id > 0' }] }),
      'checks[0].expression',
      'expression-syntax',
    ],
    [
      'check on AUTO_INCREMENT',
      'mysql',
      '8.4',
      (t) => ({
        ...setColumn(t, 'id', { autoIncrement: true }),
        checks: [{ name: 'c', expression: 'id > 0' }],
      }),
      'checks[0].expression',
      'check-auto-increment',
    ],
    [
      'trigger on another table',
      'postgres',
      '16',
      (t) => ({
        ...t,
        triggers: [
          {
            name: 'tr',
            timing: 'BEFORE',
            events: ['INSERT'],
            definition:
              'CREATE TRIGGER tr BEFORE INSERT ON public.other FOR EACH ROW EXECUTE FUNCTION f()',
          },
        ],
      }),
      'triggers[0].definition',
      'trigger-table',
    ],
    [
      'trigger name mismatch',
      'mysql',
      '8.4',
      (t) => ({
        ...t,
        triggers: [
          {
            name: 'tr',
            timing: 'BEFORE',
            events: ['INSERT'],
            definition: 'CREATE TRIGGER other BEFORE INSERT ON t FOR EACH ROW SET NEW.id = 1',
          },
        ],
      }),
      'triggers[0].name',
      'trigger-name-mismatch',
    ],
    [
      'partition key not in a unique key',
      'mysql',
      '8.4',
      (t) => ({
        ...t,
        partitioning: { method: 'HASH', key: 'name', partitions: [{ name: 'p0' }] },
      }),
      'primaryKey',
      'partition-unique-key',
    ],
    [
      'RANGE partition without bound',
      'mysql',
      '8.4',
      (t) => ({ ...t, partitioning: { method: 'RANGE', key: 'id', partitions: [{ name: 'p0' }] } }),
      'partitioning.partitions[0].bound',
      'partition-bound',
    ],
    [
      'unknown row format',
      'mysql',
      '8.4',
      (t) => ({ ...t, options: { rowFormat: 'WIDE' } }),
      'options.rowFormat',
      'option-value',
    ],
    [
      'fillfactor range',
      'postgres',
      '16',
      (t) => ({ ...t, options: { fillfactor: '5' } }),
      'options.fillfactor',
      'option-value',
    ],
    [
      'MEMORY with TEXT',
      'mysql',
      '8.4',
      (t) => ({ ...t, options: { engine: 'MEMORY' } }),
      'columns[2].dataType',
      'engine-type',
    ],
    [
      'table comment too long',
      'mysql',
      '8.4',
      (t) => ({ ...t, comment: 'x'.repeat(2049) }),
      'comment',
      'comment-too-long',
    ],
  ];
  it.each(cases)('%s (%s)', (_label, engine, version, mutate, path, code, severity = 'error') => {
    const issues = validateTable(mutate(base(engine)), {
      engine,
      schema: engine === 'postgres' ? 'public' : 'db',
      ...(version !== undefined ? { serverVersion: version } : {}),
    });
    expect(issues).toContainEqual(expect.objectContaining({ path, code, severity }));
  });

  it('accepts a clean table on every engine', () => {
    for (const engine of ['postgres', 'mysql', 'mariadb'] as const) {
      expect(
        validateTable(base(engine), { engine, schema: 'db' }).filter((i) => i.severity === 'error'),
      ).toEqual([]);
    }
  });

  it('checks foreign keys against the referenced table in the snapshot', () => {
    const { snapshot: snap, orders } = myWorld();
    const bad = edit(orders, (t) => ({
      foreignKeys: [
        ...t.foreignKeys,
        {
          name: 'fk_missing',
          columns: ['qty'],
          refTable: 'nowhere',
          refColumns: ['id'],
          onUpdate: 'NO ACTION',
          onDelete: 'NO ACTION',
        },
        {
          name: 'fk_orders_customer',
          columns: ['qty'],
          refTable: 'customers',
          refColumns: ['email'],
          onUpdate: 'NO ACTION',
          onDelete: 'NO ACTION',
        },
      ],
    }));
    const issues = validateTable(bad, myContext(snap));
    expect(issues).toContainEqual(
      expect.objectContaining({ path: 'foreignKeys[1].refTable', code: 'fk-unknown-table' }),
    );
    expect(issues).toContainEqual(
      expect.objectContaining({ path: 'foreignKeys[2].columns[0]', code: 'fk-type-mismatch' }),
    );
    expect(issues).toContainEqual(
      expect.objectContaining({ path: 'foreignKeys[2].refColumns', code: 'fk-no-unique-key' }),
    );
    expect(issues).toContainEqual(
      expect.objectContaining({ path: 'foreignKeys[2].name', code: 'duplicate-name' }),
    );
  });

  it('checks names against the rest of the schema', () => {
    const { snapshot: snap } = pgWorld();
    const clash = table({
      name: 'customers',
      columns: [col('id', 'integer')],
      indexes: [{ name: 'orders_pkey', columns: [{ name: 'id' }] }],
    });
    const issues = validateTable(clash, pgContext(snap), null);
    expect(issues).toContainEqual(expect.objectContaining({ path: 'name', code: 'name-taken' }));
    expect(issues).toContainEqual(
      expect.objectContaining({ path: 'indexes[0].name', code: 'name-taken' }),
    );
  });

  it('keeps the index a MySQL foreign key needs', () => {
    const { snapshot: snap, orders } = myWorld();
    const live = edit(orders, (t) => ({
      indexes: t.indexes.map((i) =>
        i.name === 'fk_orders_customer' ? { ...i, name: 'k_customer' } : i,
      ),
    }));
    const dropped = edit(live, (t) => ({
      indexes: t.indexes.filter((i) => i.name !== 'k_customer'),
    }));
    expect(validateTable(dropped, myContext(snap), live)).toContainEqual(
      expect.objectContaining({ path: 'foreignKeys[0]', code: 'index-backs-foreign-key' }),
    );
    const withoutFk = { ...dropped, foreignKeys: [] };
    expect(codes(validateTable(withoutFk, myContext(snap), live))).not.toContain(
      'index-backs-foreign-key',
    );
    // The index MySQL added itself (named after the key) comes back on its own.
    const implied = edit(orders, (t) => ({
      indexes: t.indexes.filter((i) => i.name !== 'fk_orders_customer'),
    }));
    const design = designTable(orders, implied, myContext(snap));
    expect(design.unchanged).toBe(true);
  });

  it('flags bad renames and MySQL renames it refuses', () => {
    const { snapshot: snap, orders } = myWorld();
    const renamed = edit(orders, (t) => ({
      columns: t.columns.map((c) => (c.name === 'qty' ? { ...c, name: 'quantity' } : c)),
      checks: [{ name: 'orders_qty_check', expression: '`quantity` > 0' }],
    }));
    const design = designTable(
      orders,
      renamed,
      myContext(snap, { columns: { qty: 'quantity', nope: 'x', price: 'code' } }),
    );
    expect(design.issues).toContainEqual(
      expect.objectContaining({ code: 'rename-blocked', path: 'columns[5].name' }),
    );
    expect(codes(design.issues)).toEqual(
      expect.arrayContaining(['rename-unknown-column', 'rename-clash']),
    );
    const maria = myWorld('mariadb');
    const ok = designTable(
      maria.orders,
      renamed,
      myContext(maria.snapshot, { columns: { qty: 'quantity' } }),
    );
    expect(codes(ok.issues)).not.toContain('rename-blocked');
  });

  it('diagnoses expression syntax with the SQL parser', async () => {
    const t = {
      ...base('postgres'),
      checks: [
        { name: 'c', expression: 'id >> > 0' },
        { name: 'd', expression: 'id > 0' },
      ],
    };
    const issues = await diagnoseTable(t, { engine: 'postgres', schema: 'public' });
    expect(issues).toEqual([
      expect.objectContaining({ path: 'checks[0].expression', code: 'syntax', severity: 'error' }),
    ]);
    expect(await diagnoseTable(base('mysql'), { engine: 'mysql', schema: 'db' })).toEqual([]);
  }, 60_000);
});

// ---------------------------------------------------------------------------------------------
// Helpers

describe('table helpers', () => {
  it('emptyTable and newColumn start a design', () => {
    const pg = emptyTable('postgres', 'things');
    expect(pg).toMatchObject({ name: 'things', columns: [], options: {} });
    const my = emptyTable('mysql', 'things', { charset: 'utf8mb4', collation: 'utf8mb4_bin' });
    expect(my.options).toEqual({ engine: 'InnoDB', charset: 'utf8mb4', collation: 'utf8mb4_bin' });
    const first = newColumn('mysql', my);
    expect(first).toMatchObject({
      name: 'column1',
      ordinal: 1,
      dataType: 'varchar(255)',
      nullable: true,
    });
    const second = newColumn('postgres', { ...pg, columns: [{ ...first, name: 'column2' }] });
    expect(second.name).toBe('column3');
    expect(second.dataType).toBe('character varying(255)');
    expect(newColumn('postgres', pg, 'email').name).toBe('email');
  });

  it('cloneTable renames what must be unique beyond the table', () => {
    const { orders: pgOrders, snapshot: pgSnap } = pgWorld();
    const pgCopy = cloneTable(
      setColumn(pgOrders, 'customer_id', {
        default: "nextval('public.orders_customer_id_seq'::regclass)",
      }),
      'postgres',
    );
    expect(pgCopy.name).toBe('orders_copy');
    expect(pgCopy.primaryKey!.name).toBe('orders_copy_pkey');
    expect(pgCopy.uniques[0]!.name).toBe('orders_copy_code_key');
    expect(pgCopy.indexes[0]).toMatchObject({ name: 'orders_copy_note_idx' });
    expect(pgCopy.indexes[0]!.definition).toBeUndefined();
    expect(pgCopy.triggers[0]!.definition).toContain('ON public.orders_copy');
    expect(pgCopy.columns[1]).toMatchObject({ dataType: 'serial', default: null });
    const created = designTable(null, pgCopy, pgContext(pgSnap));
    expect(errors(created)).toEqual([]);
    expect(created.statements).toContainEqual(
      expect.stringMatching(/^CREATE SEQUENCE "public"."orders_copy_customer_id_seq"/),
    );

    const { orders: myOrders, snapshot: mySnap } = myWorld();
    const myCopy = cloneTable(myOrders, 'mysql', 'orders_2024');
    expect(myCopy.foreignKeys[0]!.name).toBe('fk_orders_2024_customer');
    expect(myCopy.checks[0]!.name).toBe('orders_2024_qty_check');
    expect(myCopy.triggers[0]!.name).toBe('orders_2024_bi');
    expect(myCopy.triggers[0]!.definition).toBe(
      'CREATE TRIGGER `orders_2024_bi` BEFORE INSERT ON `orders_2024` FOR EACH ROW SET NEW.code = UPPER(NEW.code)',
    );
    expect(myCopy.options.autoIncrement).toBeUndefined();
    expect(myCopy.indexes.map((i) => i.name)).toEqual(['uq_code', 'fk_orders_customer']);
    expect(errors(designTable(null, myCopy, myContext(mySnap)))).toEqual([]);
  });

  it('lists table options per engine', () => {
    expect(tableOptionCatalog('postgres').map((o) => o.key)).toEqual(
      expect.arrayContaining(['tablespace', 'fillfactor', 'autovacuum_enabled']),
    );
    const my = tableOptionCatalog('mysql', '8.4.2');
    expect(my.map((o) => o.key)).toEqual([
      'engine',
      'charset',
      'collation',
      'rowFormat',
      'autoIncrement',
    ]);
    expect(my.find((o) => o.key === 'collation')!.values).toContain('utf8mb4_0900_ai_ci');
    expect(
      tableOptionCatalog('mariadb', '11.4.5').find((o) => o.key === 'engine')!.values,
    ).toContain('Aria');
  });
});

export type { TableDesign };
