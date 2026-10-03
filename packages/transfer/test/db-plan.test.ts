import {
  schemaSnapshotSchema,
  type SchemaSnapshot,
  type SqlDialect,
  type TableDef,
} from '@querybara/core';
import { describe, expect, it } from 'vitest';

import { resolveDbTransferOptions, type DbTransferOptions, type TransferObjectSpec } from '../src';
import { planSqlTransfer } from '../src/db/sql-plan';

/** Planning SQL → SQL transfers from snapshots: DDL, deferred keys, modes and problems. */

function snapshot(
  engine: SqlDialect,
  schema: string,
  tables: unknown[],
  types: unknown[] = [],
): SchemaSnapshot {
  return schemaSnapshotSchema.parse({
    engine,
    database: 'db',
    schemas: [{ name: schema, tables, types }],
    capturedAt: new Date().toISOString(),
  });
}

const PEOPLE = {
  name: 'people',
  columns: [
    {
      name: 'id',
      ordinal: 1,
      dataType: 'integer',
      nullable: false,
      default: "nextval('people_id_seq'::regclass)",
    },
    { name: 'name', ordinal: 2, dataType: 'text', nullable: false, default: "'anon'::text" },
    { name: 'active', ordinal: 3, dataType: 'boolean', nullable: true, default: 'true' },
    {
      name: 'created',
      ordinal: 4,
      dataType: 'timestamp(3) with time zone',
      nullable: true,
      default: 'now()',
    },
    {
      name: 'score',
      ordinal: 5,
      dataType: 'numeric(6,2)',
      nullable: true,
      default: '(0)::numeric',
    },
    { name: 'slug', ordinal: 6, dataType: 'text', nullable: true, default: "lower('X'::text)" },
  ],
  primaryKey: { name: 'people_pkey', columns: ['id'] },
  uniques: [{ name: 'people_name_key', columns: ['name'] }],
  indexes: [
    {
      name: 'people_created_idx',
      columns: [{ name: 'created' }],
      definition: 'CREATE INDEX people_created_idx ON public.people USING btree (created)',
    },
    { name: 'people_slug_trgm', columns: [{ name: 'slug' }], method: 'gin' },
  ],
  checks: [{ name: 'people_score_check', expression: '(score >= (0)::numeric)' }],
};

const ORDERS = {
  name: 'orders',
  columns: [
    {
      name: 'id',
      ordinal: 1,
      dataType: 'bigint',
      nullable: false,
      identity: { generation: 'always' },
    },
    { name: 'person_id', ordinal: 2, dataType: 'integer', nullable: false },
    { name: 'region_id', ordinal: 3, dataType: 'integer', nullable: true },
  ],
  primaryKey: { name: 'orders_pkey', columns: ['id'] },
  foreignKeys: [
    {
      name: 'orders_person_id_fkey',
      columns: ['person_id'],
      refTable: 'people',
      refColumns: ['id'],
      onDelete: 'CASCADE',
    },
    {
      name: 'orders_region_id_fkey',
      columns: ['region_id'],
      refTable: 'regions',
      refColumns: ['id'],
    },
  ],
};

function options(patch: Partial<DbTransferOptions> = {}): DbTransferOptions {
  return resolveDbTransferOptions(patch);
}

function plan(
  from: SqlDialect,
  to: SqlDialect,
  objects: TransferObjectSpec[],
  target: SchemaSnapshot = snapshot(to, to === 'postgres' ? 'public' : 'db', []),
  patch: Partial<DbTransferOptions> = {},
) {
  return planSqlTransfer({
    from,
    to,
    targetVersion: to === 'mariadb' ? '11.4.3-MariaDB' : '8.4.2',
    sourceSchema: from === 'postgres' ? 'public' : undefined,
    targetSchema: to === 'postgres' ? 'public' : undefined,
    source: snapshot(
      from,
      from === 'postgres' ? 'public' : 'db',
      from === 'postgres' ? [PEOPLE, ORDERS] : [MY_ITEMS],
    ),
    target,
    objects,
    options: options(patch),
  });
}

const MY_ITEMS = {
  name: 'items',
  columns: [
    { name: 'id', ordinal: 1, dataType: 'int unsigned', nullable: false, autoIncrement: true },
    { name: 'flag', ordinal: 2, dataType: 'tinyint(1)', nullable: false, default: "'1'" },
    { name: 'doc', ordinal: 3, dataType: 'longtext', nullable: true },
    {
      name: 'at',
      ordinal: 4,
      dataType: 'datetime(3)',
      nullable: true,
      default: 'CURRENT_TIMESTAMP(3)',
      onUpdate: 'CURRENT_TIMESTAMP(3)',
    },
  ],
  primaryKey: { name: 'PRIMARY', columns: ['id'] },
  indexes: [
    { name: 'flag', columns: [{ name: 'flag' }] },
    { name: 'body', columns: [{ name: 'doc', length: 20 }], method: 'FULLTEXT' },
  ],
  checks: [{ name: 'doc', expression: 'json_valid(`doc`)' }],
};

describe('PostgreSQL → MySQL', () => {
  const result = plan('postgres', 'mysql', [{ name: 'people' }, { name: 'orders' }]);
  const people = result.tables[0]!;

  it('creates each table with its primary key and AUTO_INCREMENT, and defers the other indexes', () => {
    expect(result.problems).toEqual([]);
    expect(result.before).toHaveLength(2);
    const create = result.before[0]!;
    expect(create).toContain('CREATE TABLE `people`');
    expect(create).toContain('`id` int NOT NULL AUTO_INCREMENT');
    expect(create).toContain('PRIMARY KEY (`id`)');
    expect(create).not.toContain('people_name_key');
    expect(people.finish).toEqual([
      'ALTER TABLE `people` ADD UNIQUE KEY `people_name_key` (`name`), ADD KEY `people_created_idx` (`created`)',
    ]);
    expect(people.counters).toEqual(['id']);
  });

  it('translates the defaults that mean the same, and leaves the rest out', () => {
    const create = result.before[0]!;
    expect(create).toContain("`name` varchar(255) NOT NULL DEFAULT 'anon'");
    expect(create).toContain('`active` tinyint(1) DEFAULT 1');
    expect(create).toContain('`created` datetime(3) DEFAULT CURRENT_TIMESTAMP(3)');
    expect(create).toContain('`score` decimal(6,2) DEFAULT 0');
    expect(create).toMatch(/`slug` longtext,?\n/);
    expect(people.planned.warnings).toContain("The default of slug (lower('X'::text)) is left out");
  });

  it('leaves out what MySQL cannot take, and says so', () => {
    expect(people.planned.warnings).toContain(
      'Index people_slug_trgm uses gin, which MySQL does not have; left out',
    );
    expect(people.planned.warnings.some((w) => /Check constraints are left out/.test(w))).toBe(
      true,
    );
    // name is in a unique key: text becomes varchar(255).
    expect(people.planned.columns.find((c) => c.source === 'name')).toMatchObject({
      targetType: 'varchar(255)',
      note: expect.stringMatching(/key column/),
    });
  });

  it('adds foreign keys between transferred tables only', () => {
    expect(result.foreignKeys).toEqual([
      {
        table: 'orders',
        refTable: 'people',
        sql: 'ALTER TABLE `orders` ADD CONSTRAINT `orders_person_id_fkey` FOREIGN KEY (`person_id`) REFERENCES `people` (`id`) ON DELETE CASCADE',
      },
    ]);
    expect(result.warnings).toContain(
      'orders: Foreign key orders_region_id_fkey references regions, which is not transferred; left out',
    );
  });

  it('reads the source with the columns it loads', () => {
    expect(people.select).toBe(
      'SELECT "id", "name", "active", "created", "score", "slug" FROM "public"."people"',
    );
    expect(people.mapping.map((m) => m.target)).toEqual([
      'id',
      'name',
      'active',
      'created',
      'score',
      'slug',
    ]);
  });
});

describe('PostgreSQL → PostgreSQL', () => {
  it('keeps types verbatim, defers the primary key, and turns serial into identity', () => {
    const result = plan('postgres', 'postgres', [{ name: 'people', target: 'persons' }]);
    const persons = result.tables[0]!;
    expect(result.problems).toEqual([]);
    const create = result.before[0]!;
    expect(create).toContain('"id" integer GENERATED BY DEFAULT AS IDENTITY NOT NULL');
    expect(create).toContain(`"name" text DEFAULT 'anon'::text NOT NULL`);
    expect(create).toContain('CONSTRAINT "persons_score_check" CHECK');
    expect(create).not.toContain('PRIMARY KEY');
    expect(persons.finish).toEqual([
      'ALTER TABLE "public"."persons" ADD CONSTRAINT "persons_pkey" PRIMARY KEY ("id")',
      'ALTER TABLE "public"."persons" ADD CONSTRAINT "persons_name_key" UNIQUE ("name")',
      'CREATE INDEX "persons_created_idx" ON "public"."persons" ("created")',
      // Named after the table, so it follows the new name.
      'CREATE INDEX "persons_slug_trgm" ON "public"."persons" USING gin ("slug")',
    ]);
  });

  it('keeps an always-identity column as it is', () => {
    const result = plan('postgres', 'postgres', [{ name: 'people' }, { name: 'orders' }]);
    expect(result.before[1]).toContain('"id" bigint GENERATED ALWAYS AS IDENTITY NOT NULL');
  });

  it('creates the primary key with the table when constraints are not deferred', () => {
    const result = plan('postgres', 'postgres', [{ name: 'people' }], undefined, {
      deferConstraints: false,
    });
    expect(result.before[0]).toContain('CONSTRAINT "people_pkey" PRIMARY KEY ("id")');
    expect(result.tables[0]!.finish).toHaveLength(2);
  });
});

describe('MySQL → PostgreSQL', () => {
  it('maps AUTO_INCREMENT to identity, a JSON check to jsonb, and prefixes index names', () => {
    const result = plan('mariadb', 'postgres', [{ name: 'items' }]);
    const items = result.tables[0]!;
    expect(result.problems).toEqual([]);
    const create = result.before[0]!;
    expect(create).toContain('"id" bigint GENERATED BY DEFAULT AS IDENTITY NOT NULL');
    expect(create).toContain('"flag" boolean DEFAULT true NOT NULL');
    expect(create).toContain('"doc" jsonb');
    expect(create).toContain('"at" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP');
    expect(items.finish).toContain('CREATE INDEX "items_flag" ON "public"."items" ("flag")');
    expect(items.planned.warnings).toContain(
      'Index body is a FULLTEXT index, which PostgreSQL does not have; left out',
    );
    expect(items.planned.warnings).toContain('at: ON UPDATE CURRENT_TIMESTAMP(3) is left out');
  });
});

describe('modes and problems', () => {
  const existing = (dialect: SqlDialect, tables: TableDef[] | unknown[]) =>
    snapshot(dialect, dialect === 'postgres' ? 'public' : 'db', tables);

  it('refuses create when the table exists, drops it for drop-create, empties it for truncate', () => {
    const target = existing('postgres', [PEOPLE]);
    expect(plan('postgres', 'postgres', [{ name: 'people' }], target).problems).toEqual([
      'people: people already exists on the target; choose drop and create, truncate or append',
    ]);
    const dropped = plan('postgres', 'postgres', [{ name: 'people', mode: 'drop-create' }], target);
    expect(dropped.problems).toEqual([]);
    expect(dropped.before[0]).toBe('DROP TABLE "public"."people"');
    expect(dropped.tables[0]!.planned).toMatchObject({ action: 'drop-create', exists: true });
    const truncated = plan('postgres', 'postgres', [{ name: 'people', mode: 'truncate' }], target);
    expect(truncated.before).toEqual(['TRUNCATE TABLE "public"."people"']);
    expect(truncated.tables[0]!.planned.columns.every((c) => !c.editable)).toBe(true);
  });

  it('refuses to drop or empty a table other target tables reference', () => {
    const target = existing('postgres', [PEOPLE, ORDERS]);
    const result = plan('postgres', 'postgres', [{ name: 'people', mode: 'truncate' }], target);
    expect(result.problems).toContainEqual(
      expect.stringMatching(/people cannot be emptied: orders references it/),
    );
  });

  it('appends into an existing table by column name, skipping what it lacks', () => {
    const target = existing('mysql', [
      {
        name: 'people',
        columns: [
          { name: 'ID', ordinal: 1, dataType: 'int', nullable: false, autoIncrement: true },
          { name: 'name', ordinal: 2, dataType: 'varchar(20)', nullable: false },
          { name: 'extra', ordinal: 3, dataType: 'int', nullable: false },
        ],
        primaryKey: { name: 'PRIMARY', columns: ['ID'] },
      },
    ]);
    const result = plan('postgres', 'mysql', [{ name: 'people', mode: 'append' }], target);
    const people = result.tables[0]!;
    expect(result.before).toEqual([]);
    expect(people.mapping).toEqual([
      { source: 'id', target: 'ID' },
      { source: 'name', target: 'name' },
    ]);
    expect(people.planned.columns.find((c) => c.source === 'active')).toMatchObject({
      skipped: true,
      note: 'people has no column active',
    });
    expect(people.planned.warnings[0]).toMatch(/extra is NOT NULL without a default/);
    expect(people.counters).toEqual(['ID']);
  });

  it('reports a missing source table and an unsafe type', () => {
    const result = plan('postgres', 'mysql', [
      { name: 'nope' },
      { name: 'people', columns: [{ source: 'name', dataType: 'int; DROP TABLE x' }] },
    ]);
    expect(result.problems).toEqual([
      'Table nope was not found on the source',
      'people: "int; DROP TABLE x" is not a column type Querybara can use (name)',
    ]);
  });

  it('creates a missing PostgreSQL schema', () => {
    const result = planSqlTransfer({
      from: 'mysql',
      to: 'postgres',
      targetVersion: '16.4',
      sourceSchema: undefined,
      targetSchema: 'staging',
      source: snapshot('mysql', 'db', [MY_ITEMS]),
      target: snapshot('postgres', 'public', []),
      objects: [{ name: 'items' }],
      options: options(),
    });
    expect(result.before[0]).toBe('CREATE SCHEMA IF NOT EXISTS "staging"');
    expect(result.before[1]).toContain('CREATE TABLE "staging"."items"');
  });
});
