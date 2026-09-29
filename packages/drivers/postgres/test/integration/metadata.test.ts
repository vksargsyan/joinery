import {
  schemaSnapshotSchema,
  type SchemaSnapshot,
  type Session,
  type TableDef,
} from '@joinery/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PG_URL, collect, connect, rows } from './helpers';

const S = 'jt_fixture';
const O = 'jt_other';

const FIXTURE = [
  `DROP SCHEMA IF EXISTS ${O} CASCADE`,
  `DROP SCHEMA IF EXISTS ${S} CASCADE`,
  `CREATE SCHEMA ${S}`,
  `CREATE SCHEMA ${O}`,
  `COMMENT ON SCHEMA ${S} IS 'fixture schema'`,
  `CREATE EXTENSION IF NOT EXISTS citext SCHEMA ${S}`,
  `CREATE TYPE ${S}.mood AS ENUM ('sad', 'ok', 'happy')`,
  `CREATE DOMAIN ${S}.positive AS integer DEFAULT 1 NOT NULL CONSTRAINT positive_check CHECK (VALUE > 0)`,
  `CREATE TYPE ${S}.pair AS (a integer, b text COLLATE "C")`,
  `CREATE TYPE ${S}.floatrange AS RANGE (SUBTYPE = float8, SUBTYPE_DIFF = float8mi)`,
  `CREATE TABLE ${S}.customers (
     id bigint GENERATED ALWAYS AS IDENTITY (START WITH 100 INCREMENT BY 5) PRIMARY KEY,
     dropped_later int,
     email ${S}.citext NOT NULL,
     name varchar(100) DEFAULT 'anon',
     created_at timestamptz NOT NULL DEFAULT now(),
     status ${S}.mood DEFAULT 'happy',
     score numeric(10,2) CONSTRAINT score_nonneg CHECK (score >= 0),
     code text COLLATE "C",
     visits ${S}.positive,
     CONSTRAINT customers_email_key UNIQUE (email)
   ) WITH (fillfactor = 80)`,
  `ALTER TABLE ${S}.customers DROP COLUMN dropped_later`,
  `COMMENT ON TABLE ${S}.customers IS 'people who buy'`,
  `COMMENT ON COLUMN ${S}.customers.email IS 'login'`,
  `CREATE TABLE ${S}.orders (
     id serial PRIMARY KEY,
     customer_id bigint NOT NULL,
     placed_at timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
     total numeric(12,2) NOT NULL DEFAULT 0,
     total_with_tax numeric GENERATED ALWAYS AS (total * 1.2) STORED,
     note text,
     tags text[] DEFAULT '{}',
     CONSTRAINT orders_customer_fk FOREIGN KEY (customer_id) REFERENCES ${S}.customers (id)
       ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
     CONSTRAINT orders_customer_placed_key UNIQUE (customer_id, placed_at)
   )`,
  `CREATE INDEX orders_note_lower_idx ON ${S}.orders (lower(note))`,
  `CREATE INDEX orders_open_idx ON ${S}.orders (placed_at DESC) INCLUDE (total) WHERE total > 0`,
  `CREATE INDEX orders_note_pattern_idx ON ${S}.orders (note text_pattern_ops NULLS FIRST)`,
  `CREATE TABLE ${O}.refunds (
     id int PRIMARY KEY,
     customer_id bigint REFERENCES ${S}.customers (id) ON UPDATE RESTRICT,
     order_id int REFERENCES ${S}.orders (id)
   )`,
  `CREATE TABLE ${S}.events (id bigint NOT NULL, created_at date NOT NULL, payload jsonb)
     PARTITION BY RANGE (created_at)`,
  `CREATE TABLE ${S}.events_2024 PARTITION OF ${S}.events FOR VALUES FROM ('2024-01-01') TO ('2025-01-01')`,
  `CREATE TABLE ${S}.events_default PARTITION OF ${S}.events DEFAULT`,
  `CREATE INDEX events_created_idx ON ${S}.events (created_at)`,
  `CREATE SEQUENCE ${S}.invoice_no AS integer START WITH 1000 INCREMENT BY 10 MAXVALUE 99999 CACHE 5 CYCLE`,
  `CREATE VIEW ${S}.big_orders AS SELECT id, total FROM ${S}.orders WHERE total > 100 WITH LOCAL CHECK OPTION`,
  `CREATE VIEW ${S}.secure_customers WITH (security_barrier = true) AS SELECT id, name FROM ${S}.customers`,
  `CREATE MATERIALIZED VIEW ${S}.order_totals AS
     SELECT customer_id, sum(total) AS total FROM ${S}.orders GROUP BY customer_id WITH NO DATA`,
  `CREATE UNIQUE INDEX order_totals_customer_idx ON ${S}.order_totals (customer_id)`,
  `CREATE FUNCTION ${S}.touch() RETURNS trigger LANGUAGE plpgsql AS $$
   BEGIN NEW.placed_at := now(); RETURN NEW; END $$`,
  `CREATE FUNCTION ${S}.add(a integer, b integer) RETURNS integer LANGUAGE sql IMMUTABLE AS 'SELECT a + b'`,
  `CREATE FUNCTION ${S}.add(a numeric, b numeric) RETURNS numeric LANGUAGE sql IMMUTABLE AS 'SELECT a + b'`,
  `COMMENT ON FUNCTION ${S}.add(integer, integer) IS 'integer addition'`,
  `CREATE PROCEDURE ${S}.reset_scores() LANGUAGE sql AS $$ UPDATE ${S}.customers SET score = 0 $$`,
  `CREATE AGGREGATE ${S}.total_sum(numeric) (SFUNC = numeric_add, STYPE = numeric, INITCOND = '0')`,
  `CREATE TRIGGER orders_touch BEFORE INSERT OR UPDATE ON ${S}.orders
     FOR EACH ROW EXECUTE FUNCTION ${S}.touch()`,
];

describe.skipIf(!PG_URL)('PostgreSQL metadata', () => {
  let session: Session;
  let snapshot: SchemaSnapshot;
  const table = (name: string): TableDef => {
    const found = snapshot.schemas.find((s) => s.name === S)!.tables.find((t) => t.name === name);
    if (!found) throw new Error(`no table ${name}`);
    return found;
  };

  beforeAll(async () => {
    session = await connect();
    for (const statement of FIXTURE) await collect(session, statement);
    snapshot = await session.introspect({ schemas: [S, O] });
  });

  afterAll(async () => {
    await collect(session, `DROP SCHEMA IF EXISTS ${O} CASCADE`);
    await collect(session, `DROP SCHEMA IF EXISTS ${S} CASCADE`);
    await session.close();
  });

  describe('introspect', () => {
    it('produces a valid snapshot of the requested schemas', () => {
      expect(() => schemaSnapshotSchema.parse(snapshot)).not.toThrow();
      expect(snapshot.engine).toBe('postgres');
      expect(snapshot.schemas.map((s) => s.name)).toEqual([S, O]);
      expect(snapshot.schemas[0]!.comment).toBe('fixture schema');
      expect(snapshot.options['encoding']).toBe('UTF8');
    });

    it('is deterministic', async () => {
      const again = await session.introspect({ schemas: [S, O] });
      expect({ ...again, capturedAt: '' }).toEqual({ ...snapshot, capturedAt: '' });
    });

    it('skips extension-owned objects and lists the extension', () => {
      const fixture = snapshot.schemas[0]!;
      expect(fixture.types.map((t) => t.name)).toEqual(['floatrange', 'mood', 'pair', 'positive']);
      expect(fixture.routines.some((r) => r.name.startsWith('citext'))).toBe(false);
      expect(snapshot.extensions).toContainEqual(
        expect.objectContaining({ name: 'citext', schema: S }),
      );
      expect(snapshot.extensions.map((e) => e.name)).toContain('plpgsql');
    });

    it('describes columns with format_type, dense ordinals and normalised defaults', () => {
      const customers = table('customers');
      expect(customers.columns.map((c) => [c.ordinal, c.name])).toEqual([
        [1, 'id'],
        [2, 'email'],
        [3, 'name'],
        [4, 'created_at'],
        [5, 'status'],
        [6, 'score'],
        [7, 'code'],
        [8, 'visits'],
      ]);
      const col = (name: string) => customers.columns.find((c) => c.name === name)!;
      expect(col('id')).toMatchObject({
        dataType: 'bigint',
        nullable: false,
        default: null,
        identity: { generation: 'always', start: '100', increment: '5' },
      });
      expect(col('email')).toMatchObject({
        dataType: `${S}.citext`,
        nullable: false,
        comment: 'login',
      });
      expect(col('name')).toMatchObject({
        dataType: 'character varying(100)',
        default: "'anon'::character varying",
      });
      expect(col('created_at')).toMatchObject({
        dataType: 'timestamp with time zone',
        default: 'now()',
      });
      expect(col('status')).toMatchObject({ dataType: `${S}.mood`, default: `'happy'::${S}.mood` });
      expect(col('score').dataType).toBe('numeric(10,2)');
      expect(col('code').collation).toBe('C');
      expect(col('name').collation).toBeUndefined();
      expect(col('visits').dataType).toBe(`${S}.positive`);

      const orders = table('orders');
      const ocol = (name: string) => orders.columns.find((c) => c.name === name)!;
      expect(ocol('id')).toMatchObject({
        dataType: 'integer',
        default: `nextval('${S}.orders_id_seq'::regclass)`,
      });
      expect(ocol('placed_at')).toMatchObject({
        dataType: 'timestamp(3) without time zone',
        default: 'CURRENT_TIMESTAMP',
      });
      expect(ocol('total_with_tax')).toMatchObject({
        default: null,
        generated: { expression: '(total * 1.2)', stored: true },
      });
      expect(ocol('tags')).toMatchObject({ dataType: 'text[]', default: "'{}'::text[]" });
    });

    it('separates primary keys, unique constraints, indexes and checks', () => {
      const customers = table('customers');
      expect(customers.primaryKey).toEqual({ name: 'customers_pkey', columns: ['id'] });
      expect(customers.uniques).toEqual([{ name: 'customers_email_key', columns: ['email'] }]);
      expect(customers.indexes).toEqual([]);
      expect(customers.checks).toEqual([
        { name: 'score_nonneg', expression: '((score >= (0)::numeric))' },
      ]);
      expect(customers.options).toEqual({ fillfactor: '80' });
      expect(customers.comment).toBe('people who buy');

      const orders = table('orders');
      expect(orders.uniques).toEqual([
        { name: 'orders_customer_placed_key', columns: ['customer_id', 'placed_at'] },
      ]);
      expect(orders.indexes.map((i) => i.name)).toEqual([
        'orders_note_lower_idx',
        'orders_note_pattern_idx',
        'orders_open_idx',
      ]);
      const [lower, pattern, open] = orders.indexes;
      expect(lower).toMatchObject({
        columns: [{ name: null, expression: 'lower(note)', order: 'asc' }],
        unique: false,
        method: 'btree',
        definition: `CREATE INDEX orders_note_lower_idx ON ${S}.orders USING btree (lower(note))`,
      });
      expect(pattern!.columns).toEqual([
        { name: 'note', order: 'asc', nulls: 'first', opclass: 'text_pattern_ops' },
      ]);
      expect(open).toMatchObject({
        columns: [{ name: 'placed_at', order: 'desc' }],
        include: ['total'],
        where: '(total > (0)::numeric)',
      });
      expect(open!.columns[0]!.nulls).toBeUndefined();
    });

    it('describes foreign keys with actions, deferrability and cross-schema references', () => {
      expect(table('orders').foreignKeys).toEqual([
        {
          name: 'orders_customer_fk',
          columns: ['customer_id'],
          refTable: 'customers',
          refColumns: ['id'],
          onUpdate: 'NO ACTION',
          onDelete: 'CASCADE',
          match: 'SIMPLE',
          deferrable: 'initially-deferred',
        },
      ]);
      const refunds = snapshot.schemas[1]!.tables.find((t) => t.name === 'refunds')!;
      expect(
        refunds.foreignKeys.map((fk) => [fk.name, fk.refSchema, fk.refTable, fk.onUpdate]),
      ).toEqual([
        ['refunds_customer_id_fkey', S, 'customers', 'RESTRICT'],
        ['refunds_order_id_fkey', S, 'orders', 'NO ACTION'],
      ]);
    });

    it('lists triggers without internal FK triggers', () => {
      expect(table('orders').triggers).toEqual([
        {
          name: 'orders_touch',
          timing: 'BEFORE',
          events: ['INSERT', 'UPDATE'],
          definition: `CREATE TRIGGER orders_touch BEFORE INSERT OR UPDATE ON ${S}.orders FOR EACH ROW EXECUTE FUNCTION ${S}.touch()`,
        },
      ]);
      expect(table('customers').triggers).toEqual([]);
    });

    it('describes partitioned tables through their parent', () => {
      const events = table('events');
      expect(events.kind).toBe('partitioned');
      expect(events.partitioning).toEqual({
        method: 'RANGE',
        key: '(created_at)',
        partitions: [
          { name: 'events_2024', bound: "FOR VALUES FROM ('2024-01-01') TO ('2025-01-01')" },
          { name: 'events_default', bound: 'DEFAULT' },
        ],
      });
      expect(events.indexes.map((i) => i.name)).toEqual(['events_created_idx']);
      const names = snapshot.schemas[0]!.tables.map((t) => t.name);
      expect(names).not.toContain('events_2024');
      expect(names).toEqual([...names].sort());
    });

    it('lists serial-owned sequences but not identity sequences', () => {
      const sequences = snapshot.schemas[0]!.sequences;
      expect(sequences.map((s) => s.name)).toEqual(['invoice_no', 'orders_id_seq']);
      expect(sequences[0]).toMatchObject({
        dataType: 'integer',
        start: '1000',
        increment: '10',
        maxValue: '99999',
        cache: '5',
        cycle: true,
      });
      expect(sequences[0]!.ownedBy).toBeUndefined();
      expect(sequences[1]).toMatchObject({ ownedBy: 'orders.id', start: '1', increment: '1' });
    });

    it('describes views and materialized views', () => {
      const views = snapshot.schemas[0]!.views;
      expect(views.map((v) => [v.name, v.materialized])).toEqual([
        ['big_orders', false],
        ['order_totals', true],
        ['secure_customers', false],
      ]);
      const big = views[0]!;
      expect(big.checkOption).toBe('LOCAL');
      expect(big.columns).toEqual(['id', 'total']);
      // pg_get_viewdef qualifies the columns (orders.id) before PostgreSQL 16.
      expect(big.definition).toMatch(
        /^SELECT (orders\.)?id,\s+(orders\.)?total\s+FROM jt_fixture\.orders\s+WHERE \((orders\.)?total > \(100\)::numeric\)$/,
      );
      expect(views[2]!.options).toEqual({ security_barrier: 'true' });
      expect(views[1]!.indexes.map((i) => [i.name, i.unique])).toEqual([
        ['order_totals_customer_idx', true],
      ]);
    });

    it('describes routines with identity signatures and full definitions', () => {
      const routines = snapshot.schemas[0]!.routines;
      expect(routines.map((r) => [r.name, r.kind, r.signature])).toEqual([
        ['add', 'function', 'integer, integer'],
        ['add', 'function', 'numeric, numeric'],
        ['reset_scores', 'procedure', ''],
        ['total_sum', 'aggregate', 'numeric'],
        ['touch', 'function', ''],
      ]);
      expect(routines[0]).toMatchObject({
        returns: 'integer',
        language: 'sql',
        comment: 'integer addition',
      });
      expect(routines[0]!.definition).toMatch(
        /^CREATE OR REPLACE FUNCTION jt_fixture\.add\(a integer, b integer\)/,
      );
      expect(routines[2]!.returns).toBeUndefined();
      expect(routines[3]!.definition).toBe(
        `CREATE AGGREGATE "${S}"."total_sum"(numeric) (SFUNC = numeric_add, STYPE = numeric, INITCOND = '0')`,
      );
    });

    it('describes enum, domain, composite and range types', () => {
      const types = Object.fromEntries(snapshot.schemas[0]!.types.map((t) => [t.name, t]));
      expect(types['mood']).toMatchObject({
        kind: 'enum',
        values: ['sad', 'ok', 'happy'],
        definition: `CREATE TYPE "${S}"."mood" AS ENUM ('sad', 'ok', 'happy')`,
      });
      expect(types['positive']!.definition).toBe(
        `CREATE DOMAIN "${S}"."positive" AS integer DEFAULT 1 NOT NULL CONSTRAINT "positive_check" CHECK ((VALUE > 0))`,
      );
      expect(types['pair']!.definition).toBe(
        `CREATE TYPE "${S}"."pair" AS ("a" integer, "b" text COLLATE "C")`,
      );
      expect(types['floatrange']!.definition).toBe(
        `CREATE TYPE "${S}"."floatrange" AS RANGE (SUBTYPE = double precision, SUBTYPE_DIFF = float8mi)`,
      );
    });

    it('honours the include scope', async () => {
      const onlyTypes = await session.introspect({ schemas: [S], include: ['type'] });
      expect(onlyTypes.schemas[0]!.tables).toEqual([]);
      expect(onlyTypes.schemas[0]!.types.length).toBe(4);
      expect(onlyTypes.extensions).toEqual([]);
    });

    it('rejects another database', async () => {
      await expect(session.introspect({ database: 'some_other_db' })).rejects.toMatchObject({
        code: 'NOT_SUPPORTED',
      });
    });

    it('works inside an open transaction without disturbing it', async () => {
      await session.begin!();
      await collect(session, 'CREATE TEMP TABLE in_tx (a int)');
      const inside = await session.introspect({ schemas: [S], include: ['sequence'] });
      expect(inside.schemas[0]!.sequences.length).toBe(2);
      expect(session.inTransaction).toBe(true);
      expect(await rows(session, 'SELECT count(*) FROM in_tx')).toEqual([[0]]);
      await session.rollback!();
    });
  });

  describe('browse', () => {
    const db = () => snapshot.database;

    it('lists databases, schemas and folders', async () => {
      const databases = await session.browse([]);
      expect(databases.find((d) => d.name === db())).toMatchObject({
        kind: 'database',
        hasChildren: true,
      });
      const schemas = await session.browse([db()]);
      expect(schemas.find((s) => s.name === S)).toMatchObject({ kind: 'schema', path: [db(), S] });
      const folders = await session.browse([db(), S]);
      expect(folders.map((f) => f.path.at(-1))).toEqual([
        'tables',
        'partitions',
        'views',
        'materialized-views',
        'foreign-tables',
        'functions',
        'procedures',
        'sequences',
        'types',
        'extensions',
      ]);
    });

    it('lists objects with details', async () => {
      await collect(session, `ANALYZE ${S}.customers`);
      const tables = await session.browse([db(), S, 'tables']);
      expect(tables.map((t) => t.name)).toEqual(['customers', 'events', 'orders']);
      expect(tables[0]).toMatchObject({
        kind: 'table',
        path: [db(), S, 'tables', 'customers'],
        detail: expect.objectContaining({
          comment: 'people who buy',
          dataSize: expect.any(Number),
        }),
      });
      const partitions = await session.browse([db(), S, 'partitions']);
      expect(partitions.map((p) => [p.name, p.detail?.['parent']])).toEqual([
        ['events_2024', 'events'],
        ['events_default', 'events'],
      ]);
      const functions = await session.browse([db(), S, 'functions']);
      expect(functions.map((f) => f.name)).toContain('add(integer, integer)');
      const procedures = await session.browse([db(), S, 'procedures']);
      expect(procedures.map((f) => f.name)).toEqual(['reset_scores()']);
      const types = await session.browse([db(), S, 'types']);
      expect(types.map((t) => t.name)).toContain('mood');
      expect((await session.browse([db(), S, 'extensions'])).map((e) => e.name)).toEqual([
        'citext',
      ]);
      expect((await session.browse([db(), S, 'materialized-views'])).map((e) => e.name)).toEqual([
        'order_totals',
      ]);
    });

    it('lists columns, indexes and triggers of a table', async () => {
      const base = [db(), S, 'tables', 'orders'];
      expect((await session.browse(base)).map((f) => f.path.at(-1))).toEqual([
        'columns',
        'indexes',
        'triggers',
      ]);
      const columns = await session.browse([...base, 'columns']);
      expect(columns[0]).toMatchObject({
        kind: 'column',
        name: 'id',
        hasChildren: false,
        detail: expect.objectContaining({ type: 'integer', nullable: 0, primaryKey: 1 }),
      });
      const indexes = await session.browse([...base, 'indexes']);
      expect(indexes.map((i) => i.name)).toContain('orders_pkey');
      const triggers = await session.browse([...base, 'triggers']);
      expect(triggers.map((t) => t.name)).toEqual(['orders_touch']);
    });

    it('refuses to expand another database', async () => {
      await expect(session.browse(['template1'])).rejects.toMatchObject({ code: 'NOT_SUPPORTED' });
    });
  });

  describe('explain', () => {
    it('normalises an EXPLAIN plan', async () => {
      const plan = await session.explain!(
        `SELECT * FROM ${S}.orders o JOIN ${S}.customers c ON c.id = o.customer_id`,
      );
      expect(plan.operation).toMatch(/Join|Nested Loop/);
      expect(plan.totalCost).toBeGreaterThan(0);
      expect(plan.children.length).toBeGreaterThan(0);
      expect(plan.actualRows).toBeUndefined();
    });

    it('runs EXPLAIN ANALYZE in a transaction that is rolled back', async () => {
      const plan = await session.explain!(
        `INSERT INTO ${S}.customers (email, name) VALUES ($1, 'x')`,
        { analyze: true, buffers: true, params: ['explain@example.com'] },
      );
      expect(plan.operation).toBe('Insert');
      expect(plan.actualTimeMs).toBeGreaterThanOrEqual(0);
      expect(plan.loops).toBe(1);
      expect(plan.detail['Execution Time']).toEqual(expect.any(Number));
      expect(
        await rows(
          session,
          `SELECT count(*) FROM ${S}.customers WHERE email = 'explain@example.com'`,
        ),
      ).toEqual([[0]]);
      expect(session.inTransaction).toBe(false);
    });

    it('reports errors with positions relative to the statement', async () => {
      await expect(session.explain!('SELECT * FROM nowhere')).rejects.toMatchObject({
        code: 'SQL_ERROR',
        position: 14,
      });
    });
  });
});
