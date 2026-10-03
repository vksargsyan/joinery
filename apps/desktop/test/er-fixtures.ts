import { schemaSnapshotSchema, type SchemaSnapshot } from '@querybara/core';

/** Snapshots for the ER diagram and ER model tests. */

export function column(name: string, ordinal: number, dataType: string, nullable = true) {
  return { name, ordinal, dataType, nullable };
}

/** A shop in `public` and invoices in `sales`, with every kind of relationship. */
export function shop(): SchemaSnapshot {
  return schemaSnapshotSchema.parse({
    engine: 'postgres',
    database: 'shop',
    capturedAt: '2026-09-30T00:00:00Z',
    schemas: [
      {
        name: 'public',
        tables: [
          {
            name: 'customers',
            comment: 'People who buy',
            columns: [
              column('id', 1, 'integer', false),
              column('name', 2, 'text', false),
              column('email', 3, 'text'),
            ],
            primaryKey: { name: 'customers_pkey', columns: ['id'] },
            uniques: [{ name: 'customers_email_key', columns: ['email'] }],
          },
          {
            name: 'orders',
            columns: [
              column('id', 1, 'integer', false),
              column('customer_id', 2, 'integer', false),
              column('total', 3, 'numeric(10,2)', false),
              column('note', 4, 'text'),
            ],
            primaryKey: { name: 'orders_pkey', columns: ['id'] },
            foreignKeys: [
              {
                name: 'orders_customer_id_fkey',
                columns: ['customer_id'],
                refTable: 'customers',
                refColumns: ['id'],
                onDelete: 'CASCADE',
              },
            ],
          },
          {
            name: 'customer_profiles',
            columns: [column('customer_id', 1, 'integer', false), column('bio', 2, 'text')],
            primaryKey: { name: 'customer_profiles_pkey', columns: ['customer_id'] },
            foreignKeys: [
              {
                name: 'customer_profiles_customer_id_fkey',
                columns: ['customer_id'],
                refTable: 'customers',
                refColumns: ['id'],
              },
            ],
          },
          {
            name: 'employees',
            columns: [column('id', 1, 'integer', false), column('manager_id', 2, 'integer')],
            primaryKey: { name: 'employees_pkey', columns: ['id'] },
            foreignKeys: [
              {
                name: 'employees_manager_id_fkey',
                columns: ['manager_id'],
                refTable: 'employees',
                refColumns: ['id'],
              },
            ],
          },
        ],
        views: [
          {
            name: 'order_totals',
            definition: 'SELECT …',
            columns: ['customer_id', 'total'],
          },
        ],
      },
      {
        name: 'sales',
        tables: [
          {
            name: 'invoices',
            columns: [column('id', 1, 'integer', false), column('order_id', 2, 'integer', false)],
            primaryKey: { name: 'invoices_pkey', columns: ['id'] },
            foreignKeys: [
              {
                name: 'invoices_order_id_fkey',
                columns: ['order_id'],
                refSchema: 'public',
                refTable: 'orders',
                refColumns: ['id'],
              },
            ],
          },
        ],
      },
    ],
  });
}

/** A small MySQL database: customers and their orders. */
export function shopMysql(): SchemaSnapshot {
  return schemaSnapshotSchema.parse({
    engine: 'mysql',
    serverVersion: '8.4.2',
    database: 'shop',
    capturedAt: '2026-09-30T00:00:00Z',
    schemas: [
      {
        name: 'shop',
        tables: [
          {
            name: 'customers',
            columns: [
              { ...column('id', 1, 'bigint', false), autoIncrement: true },
              column('name', 2, 'varchar(100)', false),
            ],
            primaryKey: { name: 'PRIMARY', columns: ['id'] },
            options: { engine: 'InnoDB' },
          },
          {
            name: 'orders',
            columns: [
              { ...column('id', 1, 'bigint', false), autoIncrement: true },
              column('customer_id', 2, 'bigint', false),
              column('total', 3, 'decimal(10,2)', false),
            ],
            primaryKey: { name: 'PRIMARY', columns: ['id'] },
            indexes: [
              {
                name: 'orders_customer_id_fkey',
                unique: false,
                columns: [{ name: 'customer_id' }],
              },
            ],
            foreignKeys: [
              {
                name: 'orders_customer_id_fkey',
                columns: ['customer_id'],
                refTable: 'customers',
                refColumns: ['id'],
              },
            ],
            options: { engine: 'InnoDB' },
          },
        ],
      },
    ],
  });
}
