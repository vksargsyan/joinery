import type { CellValue, ColumnDef, SchemaSnapshot, Session, TableDef } from '@joinery/core';
import { describe, expect, it } from 'vitest';

import { designDropTable, designTable } from '../../src';
import type { DesignRenames, TableDesign } from '../../src';
import { configuredServers, query, runStatements, ScratchDatabases } from './helpers';
import type { ServerEngine, TestServer } from './helpers';

/**
 * The table designer against real servers: a table is created and then changed through a
 * series of designer edits, each saved by running `designTable`'s statements with the driver.
 * After every save the table is read back, and designing the edited table against it again
 * must produce no operations — the live table equals the edited one under the sync engine's
 * normalisation. The check queries of risky edits are run on real rows and must count them.
 */

const servers = configuredServers();

const col = (name: string, dataType: string, extra: Partial<ColumnDef> = {}): ColumnDef => ({
  name,
  ordinal: 1,
  dataType,
  nullable: true,
  default: null,
  autoIncrement: false,
  ...extra,
});

function describeOperations(design: TableDesign): string {
  return design.operations
    .map((op) => [`- ${op.id}`, ...op.changes.map((c) => `    ${c}`)].join('\n'))
    .join('\n');
}

function number(value: CellValue | undefined): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string') return Number(value);
  if (value !== null && typeof value === 'object' && 'value' in value) return Number(value.value);
  return Number.NaN;
}

/** A session on a scratch database plus the designer context around it. */
class Workbench {
  snapshot!: SchemaSnapshot;

  constructor(
    readonly engine: ServerEngine,
    readonly session: Session,
  ) {}

  get schema(): string {
    return this.engine === 'postgres' ? 'public' : this.snapshot.schemas[0]!.name;
  }

  async refresh(): Promise<void> {
    this.snapshot = await this.session.introspect();
  }

  table(name: string): TableDef {
    const schema = this.snapshot.schemas.find((s) => s.name === this.schema)!;
    const table = schema.tables.find((t) => t.name === name);
    if (table === undefined) throw new Error(`table ${name} not found`);
    return table;
  }

  has(name: string): boolean {
    const schema = this.snapshot.schemas.find((s) => s.name === this.schema)!;
    return schema.tables.some((t) => t.name === name);
  }

  design(live: TableDef | null, edited: TableDef, renames?: DesignRenames): TableDesign {
    return designTable(live, edited, {
      engine: this.engine,
      schema: this.schema,
      snapshot: this.snapshot,
      ...(renames !== undefined ? { renames } : {}),
    });
  }

  async sql(statements: readonly string[]): Promise<void> {
    await runStatements(this.session, statements);
  }

  async count(sql: string): Promise<number> {
    const rows = await query(this.session, sql);
    return number(rows[0]?.[0]);
  }

  /**
   * Saves an edit: designs it, requires a valid design, runs its statements, reads the table
   * back and requires that designing the saved table again changes nothing.
   */
  async save(
    live: TableDef | null,
    edited: TableDef,
    renames?: DesignRenames,
  ): Promise<{ design: TableDesign; live: TableDef }> {
    const design = this.design(live, edited, renames);
    expect(
      design.issues.filter((i) => i.severity === 'error'),
      design.script,
    ).toEqual([]);
    expect(design.valid).toBe(true);
    try {
      await this.sql(design.statements);
    } catch (error) {
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}\n--- script ---\n${design.script}`,
        { cause: error },
      );
    }
    await this.refresh();
    const saved = this.table(edited.name);
    const again = this.design(saved, design.table);
    expect(
      again.operations,
      `re-design after save is not empty:\n${describeOperations(again)}\n${again.script}\n--- saved with ---\n${design.script}`,
    ).toEqual([]);
    // After a rename the edited definitions may still name the old table or columns; the
    // saved table is `design.table`, which follows the renames.
    if (renames === undefined && (live === null || live.name === edited.name)) {
      const raw = this.design(saved, edited);
      expect(raw.operations, `raw edit:\n${describeOperations(raw)}\n${raw.script}`).toEqual([]);
    }
    return { design, live: saved };
  }

  /** The check query of the warning about `objectName` whose message matches `pattern`. */
  checkQuery(design: TableDesign, objectName: string, pattern: RegExp): string {
    const warning = design.dataLoss.find(
      (w) => w.objectName === objectName && pattern.test(w.message) && w.checkQuery !== undefined,
    );
    if (warning === undefined) {
      throw new Error(
        `no warning for ${objectName} matching ${pattern}:\n${JSON.stringify(design.dataLoss, null, 2)}`,
      );
    }
    return warning.checkQuery!;
  }
}

async function withWorkbench(
  server: TestServer,
  label: string,
  body: (bench: Workbench) => Promise<void>,
): Promise<void> {
  const scratch = new ScratchDatabases(server);
  try {
    const session = await scratch.create(label);
    const bench = new Workbench(server.engine, session);
    await body(bench);
  } finally {
    await scratch.dropAll();
  }
}

const rename = (table: TableDef, from: string, to: string): TableDef => ({
  ...table,
  columns: table.columns.map((c) => (c.name === from ? { ...c, name: to } : c)),
  indexes: table.indexes.map((i) => ({
    ...i,
    columns: i.columns.map((c) => (c.name === from ? { ...c, name: to } : c)),
  })),
  uniques: table.uniques.map((u) => ({
    ...u,
    columns: u.columns.map((c) => (c === from ? to : c)),
  })),
});

const setColumn = (table: TableDef, name: string, change: Partial<ColumnDef>): TableDef => ({
  ...table,
  columns: table.columns.map((c) => (c.name === name ? { ...c, ...change } : c)),
});

// ---------------------------------------------------------------------------------------------
// PostgreSQL

function pgOrders(): TableDef {
  return {
    name: 'orders',
    kind: 'table',
    columns: [
      col('id', 'bigint', { nullable: false, identity: { generation: 'always' } }),
      col('customer_id', 'integer', { nullable: false }),
      col('code', 'varchar(20)', { nullable: false }),
      col('note', 'text'),
      col('qty', 'integer', { nullable: false, default: '1' }),
      col('price', 'numeric(10,2)'),
      col('created_at', 'timestamptz', {
        nullable: false,
        default: 'now()',
        comment: 'When the order was placed',
      }),
      col('ref', 'serial'),
    ],
    primaryKey: { name: 'orders_pkey', columns: ['id'] },
    uniques: [{ name: 'orders_code_key', columns: ['code'] }],
    indexes: [
      {
        name: 'orders_note_lower_idx',
        columns: [{ name: null, expression: 'lower(note)', order: 'asc' }],
        unique: false,
        include: [],
        invisible: false,
      },
      {
        name: 'orders_big_qty_idx',
        columns: [{ name: 'qty', order: 'desc' }],
        unique: false,
        include: ['price'],
        invisible: false,
        where: 'qty > 1',
      },
    ],
    foreignKeys: [
      {
        name: 'orders_customer_fk',
        columns: ['customer_id'],
        refTable: 'customers',
        refColumns: ['id'],
        onUpdate: 'NO ACTION',
        onDelete: 'CASCADE',
      },
    ],
    checks: [{ name: 'orders_qty_positive', expression: 'qty > 0' }],
    triggers: [
      {
        name: 'orders_touch',
        timing: 'BEFORE',
        events: ['UPDATE'],
        definition:
          'CREATE TRIGGER orders_touch BEFORE UPDATE ON public.orders FOR EACH ROW EXECUTE FUNCTION public.touch()',
      },
    ],
    options: { fillfactor: '80' },
    comment: 'Customer orders',
  };
}

async function pgSeries(bench: Workbench): Promise<void> {
  await bench.sql([
    'CREATE TABLE customers (id integer PRIMARY KEY, email text)',
    'CREATE FUNCTION touch() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$',
  ]);
  await bench.refresh();

  // A new table: CREATE TABLE with identity, serial, keys, indexes, FK, check, trigger, comments.
  let edited = pgOrders();
  let { live } = await bench.save(null, edited);
  expect(live.columns.map((c) => c.name)).toEqual(edited.columns.map((c) => c.name));
  await bench.sql([
    'CREATE VIEW order_codes AS SELECT o.id, o.code, o.qty FROM public.orders o',
    "INSERT INTO customers VALUES (1, 'a@x'), (2, 'b@x')",
    "INSERT INTO orders (customer_id, code, note, qty, price) VALUES (1, 'A1', 'first', 1, 10.00), (1, 'A2', 'dup', 2, NULL), (2, 'LONGCODE-123', 'dup', 3, 5.50)",
  ]);
  await bench.refresh();

  // Rename a column, widen a type under a view, add a column, make a column NOT NULL.
  edited = rename(edited, 'note', 'remark');
  edited = setColumn(edited, 'qty', { dataType: 'bigint' });
  edited = setColumn(edited, 'price', { nullable: false });
  edited = {
    ...edited,
    columns: [
      ...edited.columns,
      col('status', 'character varying(10)', {
        nullable: false,
        default: "'new'::character varying",
      }),
    ],
    indexes: edited.indexes.map((i) =>
      i.name === 'orders_note_lower_idx'
        ? { ...i, columns: [{ name: null, expression: 'lower(remark)', order: 'asc' as const }] }
        : i,
    ),
  };
  const renames = { columns: { note: 'remark' } };
  let design = bench.design(live, edited, renames);
  expect(design.statements.some((s) => /RENAME COLUMN "note" TO "remark"/.test(s))).toBe(true);
  expect(design.transactional).toBe(true);
  expect(await bench.count(bench.checkQuery(design, 'price', /NOT NULL/))).toBe(1);
  await bench.sql(['UPDATE orders SET price = 0 WHERE price IS NULL']);
  ({ live, design } = await bench.save(live, edited, renames));
  edited = design.table;
  expect(live.columns.find((c) => c.name === 'remark')).toBeDefined();

  // Narrow a type after counting the rows that do not fit.
  edited = setColumn(edited, 'code', { dataType: 'varchar(8)' });
  design = bench.design(live, edited);
  expect(design.dataLoss.find((w) => w.objectName === 'code')?.severity).toBe('data-loss');
  expect(await bench.count(bench.checkQuery(design, 'code', /8 characters/))).toBe(1);
  await bench.sql(["UPDATE orders SET code = 'L1' WHERE code = 'LONGCODE-123'"]);
  ({ live } = await bench.save(live, edited));

  // Drop a column, replace a check, change an FK action, options, comments; rename the table.
  edited = {
    ...edited,
    name: 'purchase_orders',
    columns: edited.columns
      .filter((c) => c.name !== 'status')
      .map((c) => (c.name === 'created_at' ? { ...c, comment: 'Placed at' } : c)),
    checks: [{ name: 'orders_qty_small', expression: 'qty < 100' }],
    foreignKeys: edited.foreignKeys.map((fk) => ({ ...fk, onDelete: 'RESTRICT' as const })),
    options: { fillfactor: '90' },
    comment: 'Orders placed by customers',
    indexes: [
      ...edited.indexes,
      {
        name: 'orders_customer_idx',
        columns: [{ name: 'customer_id', order: 'asc' }],
        unique: false,
        include: [],
        invisible: false,
      },
    ],
  };
  design = bench.design(live, edited);
  expect(design.dataLoss.some((w) => w.objectName === 'status' && w.severity === 'data-loss')).toBe(
    true,
  );
  expect(design.statements).toContainEqual(
    'ALTER TABLE "public"."orders" RENAME TO "purchase_orders"',
  );
  ({ live, design } = await bench.save(live, edited));
  // The designer reopens the saved table: its trigger now reads ON public.purchase_orders.
  edited = design.table;
  expect(edited.triggers[0]!.definition).toContain('public.purchase_orders');

  // PostgreSQL cannot reorder columns: reported, nothing to run.
  const reordered = {
    ...edited,
    columns: [edited.columns[1]!, edited.columns[0]!, ...edited.columns.slice(2)],
  };
  design = bench.design(live, reordered);
  expect(design.unchanged).toBe(true);
  expect(design.issues.map((i) => i.code)).toContain('reorder-unsupported');
  expect(design.warnings.some((w) => w.code === 'unsupported')).toBe(true);

  // Dropping a column the view uses is refused before saving.
  design = bench.design(live, {
    ...edited,
    columns: edited.columns.filter((c) => c.name !== 'qty'),
  });
  expect(design.valid).toBe(false);
  expect(design.issues.map((i) => i.code)).toContain('dropped-column-in-view');

  // Drop the table (after its view).
  await bench.sql(['DROP VIEW order_codes']);
  await bench.refresh();
  const drop = designDropTable(bench.table('purchase_orders'), {
    engine: 'postgres',
    schema: 'public',
    snapshot: bench.snapshot,
  });
  expect(drop.valid).toBe(true);
  expect(await bench.count(drop.dataLoss[0]!.checkQuery!)).toBe(3);
  await bench.sql(drop.statements);
  await bench.refresh();
  expect(bench.has('purchase_orders')).toBe(false);
}

async function pgCounts(bench: Workbench): Promise<void> {
  await bench.sql([
    'CREATE TABLE parents (id integer PRIMARY KEY)',
    "CREATE TYPE mood AS ENUM ('happy', 'sad', 'angry')",
    'CREATE TABLE t (id integer PRIMARY KEY, a integer, b text, c numeric(8,3), d timestamptz, e public.mood, p integer)',
    'INSERT INTO parents VALUES (1), (2)',
    "INSERT INTO t VALUES (1, 5, 'x', 12345.125, now(), 'happy', 1), (2, 5, 'x', 1.5, now(), 'sad', 3), (3, NULL, 'yy', NULL, NULL, 'angry', NULL), (4, 7, 'x', 99999.999, now(), 'angry', 9)",
    "CREATE TYPE mood2 AS ENUM ('happy', 'sad')",
  ]);
  await bench.refresh();
  const live = bench.table('t');
  const edited: TableDef = {
    ...live,
    columns: live.columns.map((c) => {
      if (c.name === 'a') return { ...c, nullable: false, dataType: 'smallint' };
      if (c.name === 'b') return { ...c, dataType: 'character varying(1)' };
      if (c.name === 'c') return { ...c, dataType: 'numeric(6,2)' };
      if (c.name === 'd') return { ...c, dataType: 'timestamp without time zone' };
      if (c.name === 'e') return { ...c, dataType: 'public.mood2' };
      return c;
    }),
    uniques: [{ name: 't_a_b_key', columns: ['a', 'b'] }],
    checks: [{ name: 't_a_small', expression: 'a < 6' }],
    foreignKeys: [
      {
        name: 't_p_fk',
        columns: ['p'],
        refTable: 'parents',
        refColumns: ['id'],
        onUpdate: 'NO ACTION',
        onDelete: 'NO ACTION',
      },
    ],
  };
  const design = bench.design(live, edited);
  expect(await bench.count(bench.checkQuery(design, 'a', /NOT NULL/))).toBe(1);
  expect(await bench.count(bench.checkQuery(design, 'b', /1 characters/))).toBe(1);
  // numeric(6,2) holds < 10000 and 2 decimals: 12345.125 and 99999.999 do not fit, 1.5 does.
  expect(await bench.count(bench.checkQuery(design, 'c', /numeric\(6,2\)/))).toBe(2);
  expect(await bench.count(bench.checkQuery(design, 'd', /time zone/))).toBe(3);
  expect(await bench.count(bench.checkQuery(design, 'e', /'angry'/))).toBe(2);
  expect(await bench.count(bench.checkQuery(design, 't_a_b_key', /share a value/))).toBe(2);
  expect(await bench.count(bench.checkQuery(design, 't_a_small', /violate/))).toBe(1);
  expect(await bench.count(bench.checkQuery(design, 't_p_fk', /no matching/))).toBe(2);
  const narrowInt = bench.design(live, setColumn(live, 'c', { dataType: 'smallint' }));
  expect(narrowInt.dataLoss.some((w) => w.objectName === 'c')).toBe(true);
}

// ---------------------------------------------------------------------------------------------
// MySQL and MariaDB

function myOrders(engine: ServerEngine): TableDef {
  return {
    name: 'orders',
    kind: 'table',
    columns: [
      col('id', 'int unsigned', { nullable: false, autoIncrement: true }),
      col('customer_id', 'int', { nullable: false }),
      col('code', 'varchar(20)', { nullable: false }),
      col('note', 'text'),
      col('status', "enum('new','paid','shipped')", { nullable: false, default: "'new'" }),
      col('qty', 'int', { nullable: false, default: '1' }),
      col('price', 'decimal(10,2)'),
      col('created_at', 'datetime(3)', {
        nullable: false,
        default: 'CURRENT_TIMESTAMP(3)',
        comment: 'When the order was placed',
      }),
      ...(engine === 'mariadb' ? [col('meta', 'json')] : []),
    ],
    primaryKey: { name: 'PRIMARY', columns: ['id'] },
    uniques: [{ name: 'uq_code', columns: ['code'] }],
    indexes: [
      {
        name: 'idx_note',
        columns: [{ name: 'note', order: 'asc', length: 20 }],
        unique: false,
        include: [],
        invisible: false,
      },
      ...(engine === 'mysql'
        ? [
            {
              name: 'idx_lower_code',
              columns: [{ name: null, expression: 'lower(`code`)', order: 'asc' as const }],
              unique: false,
              include: [],
              invisible: false,
            },
          ]
        : []),
    ],
    foreignKeys: [
      {
        name: 'fk_orders_customer',
        columns: ['customer_id'],
        refTable: 'customers',
        refColumns: ['id'],
        onUpdate: 'NO ACTION',
        onDelete: 'CASCADE',
      },
    ],
    checks: [{ name: 'orders_qty_positive', expression: 'qty > 0' }],
    triggers: [
      {
        name: 'orders_bi',
        timing: 'BEFORE',
        events: ['INSERT'],
        definition:
          'CREATE TRIGGER orders_bi BEFORE INSERT ON orders FOR EACH ROW SET NEW.code = UPPER(NEW.code)',
      },
    ],
    options: { engine: 'InnoDB', rowFormat: 'DYNAMIC' },
    comment: 'Customer orders',
  };
}

async function mySeries(bench: Workbench): Promise<void> {
  await bench.sql([
    'CREATE TABLE customers (id int NOT NULL PRIMARY KEY, email varchar(100)) ENGINE=InnoDB',
  ]);
  await bench.refresh();
  const engine = bench.engine;

  let edited = myOrders(engine);
  let { live, design } = await bench.save(null, edited);
  // MySQL adds an index for the foreign key; the designer includes it so the next save is quiet.
  expect(live.indexes.map((i) => i.name)).toContain('fk_orders_customer');
  expect(design.warnings.some((w) => w.code === 'non-transactional')).toBe(true);
  await bench.sql([
    'CREATE VIEW order_codes AS SELECT o.id, o.code FROM orders o',
    "INSERT INTO customers VALUES (1, 'a@x'), (2, 'b@x')",
    "INSERT INTO orders (customer_id, code, note, status, qty, price) VALUES (1, 'a1', 'first', 'new', 1, 10.00), (1, 'a2', 'dup', 'paid', 2, NULL), (2, 'longcode-123', 'dup', 'shipped', 3, 5.50)",
  ]);
  await bench.refresh();

  if (engine === 'mysql') {
    // MySQL refuses to rename a column a functional index uses: flagged before saving.
    const attempt = rename(edited, 'code', 'order_code');
    const blocked = bench.design(live, attempt, { columns: { code: 'order_code' } });
    expect(blocked.issues.map((i) => i.code)).toContain('rename-blocked');
    edited = { ...edited, indexes: edited.indexes.filter((i) => i.name !== 'idx_lower_code') };
    ({ live } = await bench.save(live, edited));
  }

  // Renames (CHANGE COLUMN; the trigger and view follow), reorder, widen, NOT NULL, add a column.
  edited = rename(rename(edited, 'note', 'remark'), 'code', 'order_code');
  edited = {
    ...edited,
    triggers: edited.triggers.map((t) => ({
      ...t,
      definition:
        'CREATE TRIGGER orders_bi BEFORE INSERT ON orders FOR EACH ROW SET NEW.order_code = UPPER(NEW.order_code)',
    })),
  };
  const status = edited.columns.find((c) => c.name === 'status')!;
  edited = {
    ...edited,
    columns: [
      edited.columns[0]!,
      status,
      ...edited.columns.slice(1).filter((c) => c !== status),
      col('shipped_at', 'datetime'),
    ],
  };
  edited = setColumn(edited, 'qty', { dataType: 'bigint' });
  edited = setColumn(edited, 'price', { nullable: false });
  const renames = { columns: { note: 'remark', code: 'order_code' } };
  design = bench.design(live, edited, renames);
  expect(design.statements.some((s) => /CHANGE COLUMN `note` `remark`/.test(s))).toBe(true);
  expect(design.statements.some((s) => /AFTER `id`/.test(s))).toBe(true);
  expect(
    design.operations.some((op) => op.id.endsWith(':rebuild') && op.objectKind === 'trigger'),
  ).toBe(true);
  expect(await bench.count(bench.checkQuery(design, 'price', /NOT NULL/))).toBe(1);
  await bench.sql(['UPDATE orders SET price = 0 WHERE price IS NULL']);
  ({ live, design } = await bench.save(live, edited, renames));
  edited = design.table;
  expect(live.columns.map((c) => c.name).slice(0, 2)).toEqual(['id', 'status']);
  await bench.sql([
    "INSERT INTO orders (customer_id, order_code, qty, price) VALUES (1, 'x9', 1, 1)",
  ]);
  expect(await bench.count("SELECT COUNT(*) FROM orders WHERE order_code = 'X9'")).toBe(1);
  expect(await bench.count('SELECT COUNT(*) FROM order_codes')).toBe(4);

  // Narrow a type and remove an enum label after counting the affected rows.
  edited = setColumn(edited, 'order_code', { dataType: 'varchar(8)' });
  edited = setColumn(edited, 'status', { dataType: "enum('new','paid')" });
  design = bench.design(live, edited);
  expect(await bench.count(bench.checkQuery(design, 'order_code', /8 characters/))).toBe(1);
  expect(await bench.count(bench.checkQuery(design, 'status', /'shipped'/))).toBe(1);
  await bench.sql([
    "UPDATE orders SET order_code = 'L1' WHERE order_code = 'LONGCODE-123'",
    "UPDATE orders SET status = 'paid' WHERE status = 'shipped'",
  ]);
  ({ live } = await bench.save(live, edited));

  // Drop a column, replace a check, change an FK action, options, comments; rename the table.
  edited = {
    ...edited,
    name: 'purchase_orders',
    columns: edited.columns
      .filter((c) => c.name !== 'shipped_at')
      .map((c) => (c.name === 'created_at' ? { ...c, comment: 'Placed at' } : c)),
    checks: [{ name: 'orders_qty_small', expression: 'qty < 100' }],
    foreignKeys: edited.foreignKeys.map((fk) => ({ ...fk, onDelete: 'RESTRICT' as const })),
    options: { ...edited.options, rowFormat: 'COMPACT', autoIncrement: '1000' },
    comment: 'Orders placed by customers',
  };
  design = bench.design(live, edited);
  expect(design.statements).toContainEqual('RENAME TABLE `orders` TO `purchase_orders`');
  ({ live, design } = await bench.save(live, edited));
  edited = design.table;

  // Move a column first.
  const remark = edited.columns.find((c) => c.name === 'remark')!;
  edited = { ...edited, columns: [remark, ...edited.columns.filter((c) => c !== remark)] };
  design = bench.design(live, edited);
  expect(design.statements.some((s) => /FIRST$/.test(s))).toBe(true);
  await bench.save(live, edited);

  // Drop the table.
  await bench.sql(['DROP VIEW order_codes']);
  await bench.refresh();
  const drop = designDropTable(bench.table('purchase_orders'), {
    engine,
    schema: bench.schema,
    snapshot: bench.snapshot,
  });
  expect(drop.valid).toBe(true);
  expect(await bench.count(drop.dataLoss[0]!.checkQuery!)).toBe(4);
  await bench.sql(drop.statements);
  await bench.refresh();
  expect(bench.has('purchase_orders')).toBe(false);
}

async function myCounts(bench: Workbench): Promise<void> {
  await bench.sql([
    'CREATE TABLE parents (id int NOT NULL PRIMARY KEY)',
    "CREATE TABLE t (id int NOT NULL PRIMARY KEY, a int, b varchar(10), c decimal(8,3), d datetime(3), e set('x','y','z'), p int, s varchar(20) CHARACTER SET utf8mb4) DEFAULT CHARSET=utf8mb4",
    'INSERT INTO parents VALUES (1), (2)',
    "INSERT INTO t VALUES (1, 5, 'x', 12345.125, '2024-01-01 10:00:00.123', 'x,y', 1, 'plain'), (2, 5, 'x', 1.5, '2024-01-01 10:00:00', 'z', 3, 'żółw'), (3, NULL, 'yy', NULL, NULL, '', NULL, NULL), (4, 7, 'x', 99999.999, '2024-01-01 10:00:00.5', 'y', 9, 'x')",
  ]);
  await bench.refresh();
  const live = bench.table('t');
  const edited: TableDef = {
    ...live,
    columns: live.columns.map((c) => {
      if (c.name === 'a') return { ...c, nullable: false, dataType: 'tinyint' };
      if (c.name === 'b') return { ...c, dataType: 'varchar(1)' };
      if (c.name === 'c') return { ...c, dataType: 'decimal(6,2)' };
      if (c.name === 'd') return { ...c, dataType: 'datetime' };
      if (c.name === 'e') return { ...c, dataType: "set('x','z')" };
      if (c.name === 's') return { ...c, charset: 'latin1', collation: 'latin1_swedish_ci' };
      return c;
    }),
    indexes: [
      ...live.indexes,
      {
        name: 'uq_a_b',
        columns: [
          { name: 'a', order: 'asc' },
          { name: 'b', order: 'asc' },
        ],
        unique: true,
        include: [],
        invisible: false,
      },
    ],
    checks: [{ name: 't_a_small', expression: 'a < 6' }],
    foreignKeys: [
      {
        name: 't_p_fk',
        columns: ['p'],
        refTable: 'parents',
        refColumns: ['id'],
        onUpdate: 'NO ACTION',
        onDelete: 'NO ACTION',
      },
    ],
  };
  const design = bench.design(live, edited);
  expect(await bench.count(bench.checkQuery(design, 'a', /NOT NULL/))).toBe(1);
  expect(await bench.count(bench.checkQuery(design, 'b', /1 characters/))).toBe(1);
  expect(await bench.count(bench.checkQuery(design, 'c', /decimal\(6,2\)/))).toBe(2);
  expect(await bench.count(bench.checkQuery(design, 'd', /fractional/))).toBe(2);
  expect(await bench.count(bench.checkQuery(design, 'e', /'y'/))).toBe(2);
  expect(await bench.count(bench.checkQuery(design, 's', /latin1/))).toBe(1);
  expect(await bench.count(bench.checkQuery(design, 'uq_a_b', /share a value/))).toBe(2);
  expect(await bench.count(bench.checkQuery(design, 't_a_small', /violate/))).toBe(1);
  expect(await bench.count(bench.checkQuery(design, 't_p_fk', /no matching/))).toBe(2);
}

// ---------------------------------------------------------------------------------------------
// Partitions and generated columns

async function pgPartitions(bench: Workbench): Promise<void> {
  await bench.refresh();
  let edited: TableDef = {
    name: 'events',
    kind: 'table',
    columns: [
      col('id', 'integer', { nullable: false }),
      col('at', 'date', { nullable: false }),
      col('qty', 'integer', { nullable: false, default: '1' }),
      col('total', 'integer', { generated: { expression: 'qty * 2', stored: true } }),
    ],
    primaryKey: { name: 'events_pkey', columns: ['id', 'at'] },
    uniques: [],
    indexes: [],
    foreignKeys: [],
    checks: [],
    triggers: [],
    partitioning: {
      method: 'RANGE',
      key: 'at',
      partitions: [
        { name: 'events_2024', bound: "FOR VALUES FROM ('2024-01-01') TO ('2025-01-01')" },
      ],
    },
    options: {},
  };
  let { live } = await bench.save(null, edited);
  expect(live.kind).toBe('partitioned');
  await bench.sql([
    "INSERT INTO events (id, at, qty) VALUES (1, '2024-03-01', 2), (2, '2024-04-01', 3)",
  ]);
  edited = {
    ...edited,
    columns: edited.columns.map((c) =>
      c.name === 'total' ? { ...c, generated: { expression: 'qty * 3', stored: true } } : c,
    ),
    partitioning: {
      ...edited.partitioning!,
      partitions: [
        ...edited.partitioning!.partitions,
        { name: 'events_2025', bound: "FOR VALUES FROM ('2025-01-01') TO ('2026-01-01')" },
      ],
    },
  };
  ({ live } = await bench.save(live, edited));
  expect(await bench.count('SELECT SUM(total) FROM events')).toBe(15);
  edited = {
    ...edited,
    partitioning: { ...edited.partitioning!, partitions: edited.partitioning!.partitions.slice(1) },
  };
  const design = bench.design(live, edited);
  expect(await bench.count(bench.checkQuery(design, 'events_2024', /deleting its rows/))).toBe(2);
  await bench.save(live, edited);
  // A partitioned table's primary key must include the partition key.
  const bad = bench.design(live, {
    ...edited,
    primaryKey: { name: 'events_pkey', columns: ['id'] },
  });
  expect(bad.issues.map((i) => i.code)).toContain('partition-unique-key');
}

async function myPartitions(bench: Workbench): Promise<void> {
  await bench.refresh();
  let edited: TableDef = {
    name: 'events',
    kind: 'table',
    columns: [
      col('id', 'int', { nullable: false }),
      col('at', 'date', { nullable: false }),
      col('qty', 'int', { nullable: false, default: '1' }),
      col('total', 'int', { generated: { expression: '`qty` * 2', stored: true } }),
      col('half', 'int', { generated: { expression: '`qty` DIV 2', stored: false } }),
    ],
    primaryKey: { name: 'PRIMARY', columns: ['id', 'at'] },
    uniques: [],
    indexes: [],
    foreignKeys: [],
    checks: [],
    triggers: [],
    partitioning: {
      method: 'RANGE',
      key: 'year(`at`)',
      partitions: [
        { name: 'p2024', bound: '2025' },
        { name: 'pmax', bound: 'MAXVALUE' },
      ],
    },
    options: { engine: 'InnoDB' },
  };
  let { live } = await bench.save(null, edited);
  await bench.sql([
    "INSERT INTO events (id, at, qty) VALUES (1, '2024-03-01', 2), (2, '2026-04-01', 3)",
  ]);
  edited = {
    ...edited,
    columns: edited.columns.map((c) =>
      c.name === 'total' ? { ...c, generated: { expression: '`qty` * 3', stored: true } } : c,
    ),
    partitioning: {
      ...edited.partitioning!,
      partitions: [
        { name: 'p2024', bound: '2025' },
        { name: 'p2025', bound: '2026' },
        { name: 'pmax', bound: 'MAXVALUE' },
      ],
    },
  };
  const design = bench.design(live, edited);
  expect(
    design.dataLoss.some((w) => w.objectKind === 'partition' && w.severity === 'may-fail'),
  ).toBe(true);
  ({ live } = await bench.save(live, edited));
  expect(await bench.count('SELECT SUM(total) FROM events')).toBe(15);
  const bad = bench.design(live, { ...edited, primaryKey: { name: 'PRIMARY', columns: ['id'] } });
  expect(bad.issues.map((i) => i.code)).toContain('partition-unique-key');
}

// ---------------------------------------------------------------------------------------------

describe('table designer on real servers', () => {
  if (servers.length === 0) it.skip('no JOINERY_TEST_*_URL is set', () => undefined);

  for (const server of servers) {
    describe(server.engine, () => {
      it('creates a table and saves a series of edits that re-read as designed', async () => {
        await withWorkbench(server, 'designer_series', (bench) =>
          server.engine === 'postgres' ? pgSeries(bench) : mySeries(bench),
        );
      });

      it('counts the rows a risky change affects', async () => {
        await withWorkbench(server, 'designer_counts', (bench) =>
          server.engine === 'postgres' ? pgCounts(bench) : myCounts(bench),
        );
      });

      it('designs partitioned tables and generated columns', async () => {
        await withWorkbench(server, 'designer_partitions', (bench) =>
          server.engine === 'postgres' ? pgPartitions(bench) : myPartitions(bench),
        );
      });
    });
  }
});
