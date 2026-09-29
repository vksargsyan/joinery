import { schemaSnapshotSchema, type SchemaSnapshot, type SqlDialect } from '@joinery/core';
import { describe, expect, it } from 'vitest';

import { buildCatalog } from '../../src';
import { mysqlSnapshots, postgresSnapshot } from './fixtures';

const bare = (name: string) => ({ name, quoted: false });
const quoted = (name: string) => ({ name, quoted: true });

function snapshot(
  engine: SqlDialect,
  database: string,
  schema: string,
  tables: string[],
): SchemaSnapshot {
  return schemaSnapshotSchema.parse({
    engine,
    database,
    capturedAt: '2026-09-29T00:00:00.000Z',
    schemas: [
      {
        name: schema,
        tables: tables.map((name) => ({
          name,
          columns: [{ name: 'Email', ordinal: 1, dataType: 'text', nullable: true }],
        })),
      },
    ],
  });
}

describe('buildCatalog()', () => {
  it('takes the dialect from the snapshots unless told', () => {
    expect(buildCatalog([postgresSnapshot()]).dialect).toBe('postgres');
    expect(buildCatalog(mysqlSnapshots('mariadb')).dialect).toBe('mariadb');
    expect(buildCatalog([]).dialect).toBe('postgres');
    expect(buildCatalog([], { dialect: 'mysql' }).dialect).toBe('mysql');
  });

  it('indexes relations of every kind with their columns', () => {
    const catalog = buildCatalog([postgresSnapshot()]);
    expect(catalog.size.relations).toBe(14);
    expect(catalog.findRelation([bare('active_users')])?.kind).toBe('view');
    expect(catalog.findRelation([bare('daily_sales')])?.kind).toBe('materialized-view');
    const users = catalog.findRelation([bare('users')])!;
    expect(users.columns.map((column) => column.name)).toEqual([
      'id',
      'email',
      'name',
      'created_at',
      'Display Name',
    ]);
    expect(users.primaryKey).toEqual(['id']);
    expect(catalog.findColumn(users, quoted('Display Name'))?.dataType).toBe('text');
  });

  describe('PostgreSQL', () => {
    it('resolves unqualified names through the search path', () => {
      const catalog = buildCatalog([postgresSnapshot()]);
      expect(catalog.searchPath.map((schema) => schema.name)).toEqual(['public']);
      expect(catalog.findRelation([bare('users')])?.schema.name).toBe('public');
      expect(catalog.findRelation([bare('sales'), bare('users')])?.schema.name).toBe('sales');
      // Not on the path, but still found as a fallback.
      expect(catalog.findRelation([bare('invoices')])?.schema.name).toBe('sales');
      expect(catalog.isVisible(catalog.findRelation([bare('sales'), bare('users')])!)).toBe(false);
      expect(catalog.isVisible(catalog.findRelation([bare('users')])!)).toBe(true);

      const salesFirst = buildCatalog([postgresSnapshot()], { searchPath: ['sales', 'public'] });
      expect(salesFirst.findRelation([bare('users')])?.schema.name).toBe('sales');
      expect(salesFirst.findRelation([bare('orders')])?.schema.name).toBe('public');

      const user = buildCatalog([postgresSnapshot()], { user: 'sales' });
      expect(user.searchPath.map((schema) => schema.name)).toEqual(['sales', 'public']);
    });

    it('folds unquoted names to lower case and keeps quoted names exact', () => {
      const catalog = buildCatalog([snapshot('postgres', 'db', 'public', ['Users', 'users'])]);
      expect(catalog.findRelation([bare('Users')])?.name).toBe('users');
      expect(catalog.findRelation([quoted('Users')])?.name).toBe('Users');
      expect(catalog.findRelation([quoted('users')])?.name).toBe('users');
      // Nothing matches exactly: a case-insensitive fallback keeps completion useful.
      expect(catalog.findRelation([quoted('USERS')])).toBeDefined();
      const users = catalog.findRelation([quoted('Users')])!;
      expect(catalog.findColumn(users, bare('email'))?.name).toBe('Email');
    });

    it('resolves schema-qualified and database-qualified names', () => {
      const catalog = buildCatalog([postgresSnapshot()]);
      expect(catalog.findSchema([quoted('Audit')])?.name).toBe('Audit');
      expect(catalog.findRelation([quoted('Audit'), quoted('change log')])?.name).toBe(
        'change log',
      );
      expect(catalog.findRelation([bare('shop'), bare('public'), bare('orders')])?.name).toBe(
        'orders',
      );
      expect(catalog.schemas().map((schema) => schema.name)).toEqual(['public', 'sales', 'Audit']);
    });
  });

  describe('MySQL and MariaDB', () => {
    it('treats databases as schemas and resolves unqualified names in the current one', () => {
      const catalog = buildCatalog(mysqlSnapshots('mysql'));
      expect(catalog.currentDatabase?.name).toBe('shop');
      expect(catalog.schemas().map((schema) => schema.name)).toEqual(['shop', 'analytics']);
      expect(catalog.findRelation([bare('analytics'), bare('events')])?.name).toBe('events');
      const other = buildCatalog(mysqlSnapshots('mysql'), { currentDatabase: 'analytics' });
      expect(other.searchPath.map((schema) => schema.name)).toEqual(['analytics']);
      expect(other.isVisible(other.findRelation([bare('events')])!)).toBe(true);
      expect(other.isVisible(other.findRelation([bare('users')])!)).toBe(false);
    });

    it('compares table names per lower_case_table_names and columns case-insensitively', () => {
      const tables = [snapshot('mysql', 'db', 'db', ['Users', 'users'])];
      const sensitive = buildCatalog(tables);
      expect(sensitive.findRelation([bare('Users')])?.name).toBe('Users');
      expect(sensitive.findRelation([bare('users')])?.name).toBe('users');
      expect(sensitive.findRelation([quoted('users')])?.name).toBe('users');
      const insensitive = buildCatalog(tables, { lowerCaseTableNames: 1 });
      expect(insensitive.findRelation([bare('users')])?.name).toBe('Users');
      expect(insensitive.findRelation([bare('USERS')])?.name).toBe('Users');
      expect(insensitive.findSchema([bare('DB')])?.name).toBe('db');
      const users = sensitive.findRelation([bare('users')])!;
      expect(sensitive.findColumn(users, quoted('EMAIL'))?.name).toBe('Email');
    });
  });

  it('follows foreign keys in both directions, across schemas and databases', () => {
    const pg = buildCatalog([postgresSnapshot()]);
    const orders = pg.findRelation([bare('orders')])!;
    const users = pg.findRelation([bare('users')])!;
    expect(pg.foreignKeysFrom(orders).map((fk) => [fk.name, fk.to.name])).toEqual([
      ['orders_user_id_fkey', 'users'],
    ]);
    expect(
      pg
        .foreignKeysTo(users)
        .map((fk) => fk.from.name)
        .sort(),
    ).toEqual(['UserAccounts', 'orders']);
    expect(
      pg
        .foreignKeysTo(orders)
        .map((fk) => `${fk.from.schema.name}.${fk.from.name}`)
        .sort(),
    ).toEqual(['public.order_items', 'sales.invoices']);
    const shipments = pg.findRelation([bare('shipments')])!;
    expect(pg.foreignKeysFrom(shipments)[0]).toMatchObject({
      columns: ['order_id', 'product_id'],
      refColumns: ['order_id', 'product_id'],
    });

    const my = buildCatalog(mysqlSnapshots('mysql'));
    const myUsers = my.findRelation([bare('users')])!;
    expect(
      my
        .foreignKeysTo(myUsers)
        .map((fk) => `${fk.from.schema.name}.${fk.from.name}`)
        .sort(),
    ).toEqual(['analytics.events', 'shop.UserAccounts', 'shop.orders']);
  });

  it('indexes routines by name with every overload', () => {
    const base = postgresSnapshot();
    const extra = {
      ...base.schemas[0]!.routines[0]!,
      signature: 'bigint',
      definition:
        'CREATE FUNCTION public.calc_total(p_order bigint) RETURNS numeric AS $$ SELECT 1 $$',
    };
    const withOverload: SchemaSnapshot = {
      ...base,
      schemas: [
        { ...base.schemas[0]!, routines: [...base.schemas[0]!.routines, extra] },
        ...base.schemas.slice(1),
      ],
    };
    const catalog = buildCatalog([withOverload]);
    expect(catalog.findRoutines([bare('calc_total')])).toHaveLength(2);
    expect(catalog.findRoutines([bare('public'), bare('CALC_TOTAL')])).toHaveLength(2);
    expect(catalog.findRoutines([bare('sales'), bare('calc_total')])).toHaveLength(0);
    expect(catalog.size.routines).toBe(3);
  });
});
