import {
  atLeast,
  schemaSnapshotSchema,
  type SchemaSnapshot,
  type Session,
  type TableDef,
} from '@joinery/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { SUITES, TARGETS, collect, rows, withDatabase, target } from './helpers';

describe.skipIf(TARGETS.length === 0).each(SUITES)('%s metadata', (engine, url) => {
  const t = target(engine, url);
  const DB = `jt_fixture_${engine}`;
  const OTHER = `jt_other_${engine}`;
  const mariadb = engine === 'mariadb';
  let session: Session;
  let drop: () => Promise<void>;
  let snapshot: SchemaSnapshot;
  const table = (name: string): TableDef => {
    const found = snapshot.schemas[0]!.tables.find((tbl) => tbl.name === name);
    if (!found) throw new Error(`no table ${name}`);
    return found;
  };

  const FIXTURE = [
    `CREATE TABLE customers (
       id bigint unsigned NOT NULL AUTO_INCREMENT,
       email varchar(191) NOT NULL,
       name varchar(100) DEFAULT 'it''s anon' COMMENT 'display name',
       code char(4) CHARACTER SET latin1 COLLATE latin1_bin DEFAULT NULL,
       sorted varchar(20) COLLATE utf8mb4_bin NOT NULL DEFAULT '',
       score decimal(10,2) NOT NULL DEFAULT 0.00,
       flags bit(3) DEFAULT b'101',
       active tinyint(1) NOT NULL DEFAULT 1,
       created_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
       updated_at timestamp NULL DEFAULT NULL ON UPDATE CURRENT_TIMESTAMP,
       born date DEFAULT (curdate()),
       tag varchar(30) DEFAULT (concat('a', 'b')),
       kind enum('person', 'company') NOT NULL DEFAULT 'person',
       full_name varchar(210) GENERATED ALWAYS AS (concat(name, ' <', email, '>')) VIRTUAL,
       score2 decimal(11,2) GENERATED ALWAYS AS (score * 2) STORED,
       PRIMARY KEY (id),
       UNIQUE KEY customers_email_key (email),
       KEY customers_name_idx (name(10), created_at DESC) COMMENT 'prefix',
       CONSTRAINT score_nonneg CHECK (score >= 0)
     ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci ROW_FORMAT=DYNAMIC
       COMMENT='people who buy' AUTO_INCREMENT=100`,
    `CREATE TABLE orders (
       id int NOT NULL AUTO_INCREMENT PRIMARY KEY,
       customer_id bigint unsigned NOT NULL,
       placed_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
       note text,
       FULLTEXT KEY orders_note_ft (note),
       CONSTRAINT orders_customer_fk FOREIGN KEY (customer_id) REFERENCES customers (id)
         ON DELETE CASCADE ON UPDATE RESTRICT
     ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`,
    `CREATE TABLE ${OTHER}.refunds (
       id int PRIMARY KEY,
       customer_id bigint unsigned,
       CONSTRAINT refunds_customer_fk FOREIGN KEY (customer_id) REFERENCES ${DB}.customers (id)
     ) ENGINE=InnoDB`,
    `CREATE TABLE audit (
       id int NOT NULL,
       at date NOT NULL,
       PRIMARY KEY (id, at)
     ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
     PARTITION BY RANGE (YEAR(at)) (
       PARTITION p2023 VALUES LESS THAN (2024),
       PARTITION p10 VALUES LESS THAN (2030),
       PARTITION pmax VALUES LESS THAN MAXVALUE
     )`,
    `CREATE ALGORITHM=MERGE SQL SECURITY INVOKER VIEW big_orders AS
       SELECT o.id, o.customer_id FROM ${DB}.orders o WHERE o.id > 100 WITH LOCAL CHECK OPTION`,
    `CREATE FUNCTION add_tax(amount decimal(10,2)) RETURNS decimal(10,2) DETERMINISTIC
       COMMENT 'adds tax' RETURN amount * 1.2`,
    `CREATE PROCEDURE reset_scores() BEGIN UPDATE ${DB}.customers SET score = 0; END`,
    `CREATE TRIGGER orders_touch BEFORE UPDATE ON orders FOR EACH ROW SET NEW.placed_at = NOW()`,
    `CREATE EVENT nightly ON SCHEDULE EVERY 1 DAY STARTS '2030-01-01 00:00:00' DISABLE
       DO DELETE FROM ${DB}.orders WHERE id < 0`,
    ...(mariadb
      ? [
          `CREATE SEQUENCE invoice_no START WITH 1000 INCREMENT BY 10 MINVALUE 1000 MAXVALUE 99999 CACHE 5 CYCLE`,
          `CREATE TABLE docs (id int PRIMARY KEY, body json) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`,
          `CREATE INDEX customers_kind_idx ON customers (kind) IGNORED`,
        ]
      : [
          `CREATE INDEX customers_lower_email_idx ON customers ((lower(email)))`,
          `CREATE INDEX customers_kind_idx ON customers (kind) INVISIBLE`,
        ]),
  ];

  beforeAll(async () => {
    ({ session, drop } = await withDatabase(t, DB));
    await collect(session, `DROP DATABASE IF EXISTS ${OTHER}`);
    await collect(session, `CREATE DATABASE ${OTHER}`);
    for (const statement of FIXTURE) await collect(session, statement);
    snapshot = await session.introspect();
  });

  afterAll(async () => {
    await collect(session, `DROP DATABASE IF EXISTS ${OTHER}`);
    await drop();
  });

  describe('introspect', () => {
    it('produces one schema named after the database', () => {
      expect(() => schemaSnapshotSchema.parse(snapshot)).not.toThrow();
      expect(snapshot.engine).toBe(engine);
      expect(snapshot.database).toBe(DB);
      expect(snapshot.schemas.map((s) => s.name)).toEqual([DB]);
      expect(snapshot.options).toEqual({ charset: 'utf8mb4', collation: 'utf8mb4_general_ci' });
      expect(snapshot.schemas[0]!.tables.map((tbl) => tbl.name)).toEqual(
        mariadb ? ['audit', 'customers', 'docs', 'orders'] : ['audit', 'customers', 'orders'],
      );
    });

    it('is deterministic', async () => {
      const again = await session.introspect();
      expect({ ...again, capturedAt: '' }).toEqual({ ...snapshot, capturedAt: '' });
    });

    it('describes columns with COLUMN_TYPE and normalised defaults', () => {
      const col = (name: string) => table('customers').columns.find((c) => c.name === name)!;
      expect(table('customers').columns.map((c) => c.ordinal)).toEqual(
        table('customers').columns.map((_, i) => i + 1),
      );
      expect(col('id')).toMatchObject({
        dataType: mariadb ? 'bigint(20) unsigned' : 'bigint unsigned',
        nullable: false,
        default: null,
        autoIncrement: true,
      });
      expect(col('name')).toMatchObject({
        default: "'it''s anon'",
        comment: 'display name',
        nullable: true,
      });
      expect(col('code')).toMatchObject({
        charset: 'latin1',
        collation: 'latin1_bin',
        default: null,
      });
      expect(col('sorted')).toMatchObject({ default: "''", collation: 'utf8mb4_bin' });
      expect(col('sorted').charset).toBeUndefined();
      expect(col('email').collation).toBeUndefined();
      expect(col('score').default).toBe('0.00');
      expect(col('flags').default).toBe("b'101'");
      expect(col('active')).toMatchObject({ dataType: 'tinyint(1)', default: '1' });
      expect(col('created_at').default).toBe('CURRENT_TIMESTAMP(3)');
      expect(col('updated_at')).toMatchObject({ default: null, onUpdate: 'CURRENT_TIMESTAMP' });
      expect(col('born').default).toBe('(curdate())');
      expect(col('tag').default).toBe(
        mariadb ? "(concat('a','b'))" : "(concat(_utf8mb4'a',_utf8mb4'b'))",
      );
      expect(col('kind')).toMatchObject({
        dataType: "enum('person','company')",
        default: "'person'",
      });
      expect(col('full_name')).toMatchObject({ default: null, generated: { stored: false } });
      expect(col('score2').generated).toMatchObject({ stored: true });
      expect(col('score2').generated!.expression).toMatch(/score/);
    });

    it('lists unique keys as unique indexes and keeps prefix lengths and comments', () => {
      const customers = table('customers');
      expect(customers.primaryKey).toEqual({ name: 'PRIMARY', columns: ['id'] });
      expect(customers.uniques).toEqual([]);
      const index = (name: string) => customers.indexes.find((i) => i.name === name)!;
      expect(index('customers_email_key')).toMatchObject({
        unique: true,
        method: 'btree',
        columns: [{ name: 'email', order: 'asc' }],
      });
      expect(index('customers_name_idx')).toMatchObject({
        unique: false,
        comment: 'prefix',
        columns: [
          { name: 'name', order: 'asc', length: 10 },
          { name: 'created_at', order: 'desc' },
        ],
      });
      expect(index('customers_kind_idx').invisible).toBe(true);
      if (!mariadb) {
        expect(index('customers_lower_email_idx').columns[0]).toMatchObject({
          name: null,
          expression: expect.stringContaining('lower'),
        });
      }
      expect(table('orders').indexes.find((i) => i.name === 'orders_note_ft')).toMatchObject({
        method: 'fulltext',
      });
      // InnoDB adds an index for the foreign key when none exists.
      expect(table('orders').indexes.map((i) => i.name)).toContain('orders_customer_fk');
    });

    it('describes table options, checks and foreign keys', () => {
      const customers = table('customers');
      expect(customers.options).toEqual({
        engine: 'InnoDB',
        charset: 'utf8mb4',
        collation: 'utf8mb4_general_ci',
        autoIncrement: '100',
        rowFormat: 'DYNAMIC',
      });
      expect(customers.comment).toBe('people who buy');
      expect(customers.checks).toEqual([
        { name: 'score_nonneg', expression: mariadb ? '`score` >= 0' : '(`score` >= 0)' },
      ]);
      expect(table('orders').foreignKeys).toEqual([
        {
          name: 'orders_customer_fk',
          columns: ['customer_id'],
          refTable: 'customers',
          refColumns: ['id'],
          onUpdate: 'RESTRICT',
          onDelete: 'CASCADE',
        },
      ]);
      expect(table('orders').options['autoIncrement']).toBe('1');
    });

    it('describes partitions in definition order', () => {
      expect(table('audit').partitioning).toEqual({
        method: 'RANGE',
        key: mariadb ? 'year(`at`)' : 'year(`at`)',
        partitions: [
          { name: 'p2023', bound: 'VALUES LESS THAN (2024)' },
          { name: 'p10', bound: 'VALUES LESS THAN (2030)' },
          { name: 'pmax', bound: 'VALUES LESS THAN MAXVALUE' },
        ],
      });
    });

    it('describes triggers without DEFINER or the database name', () => {
      expect(table('orders').triggers).toEqual([
        {
          name: 'orders_touch',
          timing: 'BEFORE',
          events: ['UPDATE'],
          definition:
            'CREATE TRIGGER orders_touch BEFORE UPDATE ON orders FOR EACH ROW SET NEW.placed_at = NOW()',
        },
      ]);
    });

    it('describes views with options and an unqualified definition', () => {
      const [view] = snapshot.schemas[0]!.views;
      expect(view).toMatchObject({
        name: 'big_orders',
        checkOption: 'LOCAL',
        columns: ['id', 'customer_id'],
        options: { algorithm: 'MERGE', security: 'INVOKER', definer: expect.stringContaining('@') },
      });
      expect(view!.definition).not.toContain(DB);
      expect(view!.definition).toMatch(
        /^select `o`\.`id` AS `id`,`o`\.`customer_id` AS `customer_id` from `orders` `o`/,
      );
    });

    it('describes routines and events through SHOW CREATE without DEFINER', () => {
      const routines = snapshot.schemas[0]!.routines;
      expect(routines.map((r) => [r.name, r.kind])).toEqual([
        ['add_tax', 'function'],
        ['reset_scores', 'procedure'],
      ]);
      expect(routines[0]).toMatchObject({
        returns: mariadb ? 'decimal(10,2)' : 'decimal(10,2)',
        comment: 'adds tax',
        definer: expect.stringContaining('@'),
      });
      expect(routines[0]!.definition).toMatch(/^CREATE FUNCTION `add_tax`/);
      expect(routines[1]!.definition).toMatch(
        /^CREATE PROCEDURE `reset_scores`\(\)\s+BEGIN UPDATE customers SET/,
      );
      const [event] = snapshot.schemas[0]!.events;
      expect(event).toMatchObject({ name: 'nightly', enabled: false });
      expect(event!.definition).toMatch(/^CREATE EVENT `nightly`/);
      expect(event!.definition).not.toContain('DEFINER');
      expect(event!.definition).not.toContain(DB);
    });

    it.skipIf(!mariadb)('describes MariaDB sequences and JSON columns', () => {
      expect(snapshot.schemas[0]!.sequences).toEqual([
        {
          name: 'invoice_no',
          start: '1000',
          increment: '10',
          minValue: '1000',
          maxValue: '99999',
          cache: '5',
          cycle: true,
        },
      ]);
      const docs = table('docs');
      expect(docs.columns[1]).toMatchObject({ dataType: 'longtext', collation: 'utf8mb4_bin' });
      expect(docs.checks).toEqual([{ name: 'body', expression: 'json_valid(`body`)' }]);
    });

    it('compares cleanly with the same schema in a database of another name', async () => {
      const copyName = `${DB}_copy`;
      const copy = await withDatabase(t, copyName);
      try {
        for (const statement of FIXTURE.filter((s) => !s.includes(OTHER))) {
          await collect(copy.session, statement.replaceAll(`${DB}.`, `${copyName}.`));
        }
        const copied = await copy.session.introspect();
        const strip = (s: SchemaSnapshot) =>
          s.schemas[0]!.tables.map((tbl) => ({
            ...tbl,
            options: { ...tbl.options, autoIncrement: '' },
          }));
        expect(strip(copied)).toEqual(strip(snapshot));
        expect(copied.schemas[0]!.views.map((v) => v.definition)).toEqual(
          snapshot.schemas[0]!.views.map((v) => v.definition),
        );
        expect(copied.schemas[0]!.routines.map((r) => r.definition)).toEqual(
          snapshot.schemas[0]!.routines.map((r) => r.definition),
        );
      } finally {
        await copy.drop();
      }
    });

    it('reads binary defaults, spatial keys and sequence defaults exactly', async () => {
      const edgeName = `${DB}_edge`;
      const edge = await withDatabase(t, edgeName);
      try {
        if (mariadb) await collect(edge.session, 'CREATE SEQUENCE seq');
        await collect(
          edge.session,
          `CREATE TABLE edge (
             id bigint NOT NULL${mariadb ? ' DEFAULT nextval(seq)' : ''},
             bin varbinary(4) DEFAULT 0x00FF41,
             g point NOT NULL,
             PRIMARY KEY (id),
             SPATIAL KEY edge_g (g)
           ) ENGINE=InnoDB`,
        );
        const edgeTable = (await edge.session.introspect()).schemas[0]!.tables[0]!;
        const col = (name: string) => edgeTable.columns.find((c) => c.name === name)!;
        // MariaDB's information_schema turns the invalid UTF-8 byte into '?'.
        expect(col('bin').default?.toLowerCase()).toBe('0x00ff41');
        expect(edgeTable.indexes.find((i) => i.name === 'edge_g')?.columns).toEqual([
          { name: 'g', order: 'asc' },
        ]);
        // MariaDB qualifies the sequence with the database name; snapshots never do.
        if (mariadb) expect(col('id').default).toBe('(nextval(`seq`))');
      } finally {
        await edge.drop();
      }
    });

    it.skipIf(!mariadb)('reads the character set of MariaDB UCA 14.0 collations', async () => {
      const ucaName = `${DB}_uca`;
      const uca = await withDatabase(t, ucaName);
      try {
        if (!atLeast(uca.session.serverVersion, '10.10.0')) return;
        // information_schema.COLLATIONS lists them without a charset (uca1400_ai_ci).
        await collect(
          uca.session,
          'CREATE TABLE u (a varchar(5)) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci',
        );
        const u = (await uca.session.introspect()).schemas[0]!.tables[0]!;
        expect(u.options).toMatchObject({ charset: 'utf8mb4', collation: 'utf8mb4_uca1400_ai_ci' });
        expect(u.columns[0]!.charset).toBeUndefined();
      } finally {
        await uca.drop();
      }
    });

    it('honours the include scope', async () => {
      const onlyViews = await session.introspect({ include: ['view'] });
      expect(onlyViews.schemas[0]!.tables).toEqual([]);
      expect(onlyViews.schemas[0]!.views.length).toBe(1);
      expect(onlyViews.schemas[0]!.routines).toEqual([]);
    });
  });

  describe('browse', () => {
    it('lists databases and folders', async () => {
      const databases = await session.browse([]);
      expect(databases.find((d) => d.name === DB)).toMatchObject({
        kind: 'database',
        detail: { system: 0 },
      });
      expect(databases.find((d) => d.name === 'mysql')?.detail?.['system']).toBe(1);
      const folders = await session.browse([DB]);
      expect(folders.map((f) => f.path.at(-1))).toEqual(
        mariadb
          ? ['tables', 'views', 'functions', 'procedures', 'triggers', 'events', 'sequences']
          : ['tables', 'views', 'functions', 'procedures', 'triggers', 'events'],
      );
    });

    it('lists objects with details', async () => {
      const tables = await session.browse([DB, 'tables']);
      expect(tables.find((tbl) => tbl.name === 'customers')).toMatchObject({
        kind: 'table',
        path: [DB, 'tables', 'customers'],
        detail: expect.objectContaining({
          engine: 'InnoDB',
          comment: 'people who buy',
          collation: 'utf8mb4_general_ci',
        }),
      });
      expect((await session.browse([DB, 'views'])).map((v) => v.name)).toEqual(['big_orders']);
      expect((await session.browse([DB, 'functions'])).map((v) => v.name)).toEqual(['add_tax']);
      expect((await session.browse([DB, 'procedures'])).map((v) => v.name)).toEqual([
        'reset_scores',
      ]);
      expect(
        (await session.browse([DB, 'triggers'])).map((v) => [v.name, v.detail?.['table']]),
      ).toEqual([['orders_touch', 'orders']]);
      expect(
        (await session.browse([DB, 'events'])).map((v) => [v.name, v.detail?.['status']]),
      ).toEqual([['nightly', 'DISABLED']]);
      if (mariadb)
        expect((await session.browse([DB, 'sequences'])).map((v) => v.name)).toEqual([
          'invoice_no',
        ]);
    });

    it('lists columns, indexes and triggers of a table', async () => {
      const base = [DB, 'tables', 'orders'];
      expect((await session.browse(base)).map((f) => f.path.at(-1))).toEqual([
        'columns',
        'indexes',
        'triggers',
      ]);
      const columns = await session.browse([...base, 'columns']);
      expect(columns[0]).toMatchObject({
        kind: 'column',
        name: 'id',
        detail: expect.objectContaining({
          type: mariadb ? 'int(11)' : 'int',
          primaryKey: 1,
          nullable: 0,
        }),
      });
      const indexes = await session.browse([...base, 'indexes']);
      expect(indexes.find((i) => i.name === 'PRIMARY')?.detail).toMatchObject({
        primary: 1,
        unique: 1,
      });
      expect((await session.browse([...base, 'triggers'])).map((i) => i.name)).toEqual([
        'orders_touch',
      ]);
      expect(
        (await session.browse([DB, 'views', 'big_orders', 'columns'])).map((c) => c.name),
      ).toEqual(['id', 'customer_id']);
    });
  });

  describe('explain', () => {
    it('normalises an EXPLAIN FORMAT=JSON plan', async () => {
      const plan = await session.explain!(
        'SELECT * FROM orders o JOIN customers c ON c.id = o.customer_id WHERE o.id > ?',
        { params: [0] },
      );
      expect(plan.operation).toMatch(/Select #1|join|loop/i);
      const relations: string[] = [];
      const walk = (node: typeof plan): void => {
        if (node.relation) relations.push(node.relation);
        node.children.forEach(walk);
      };
      walk(plan);
      expect(relations.sort()).toEqual(['c', 'o']);
    });

    it('runs ANALYZE in a transaction that is rolled back', async () => {
      const plan = await session.explain!("UPDATE customers SET name = 'changed' WHERE id > 0", {
        analyze: true,
      });
      expect(plan.children.length + (plan.actualRows !== undefined ? 1 : 0)).toBeGreaterThan(0);
      expect(await rows(session, "SELECT COUNT(*) FROM customers WHERE name = 'changed'")).toEqual([
        [0],
      ]);
      expect(session.inTransaction).toBe(false);
    });
  });
});
