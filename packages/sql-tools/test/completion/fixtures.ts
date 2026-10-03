import { schemaSnapshotSchema, type SchemaSnapshot, type SqlDialect } from '@querybara/core';
import type { z } from 'zod';

/** Hand-written snapshots of a small shop, per dialect, for the completion tests. */

type SnapshotInput = z.input<typeof schemaSnapshotSchema>;
type SchemaInput = SnapshotInput['schemas'][number];
type TableInput = NonNullable<SchemaInput['tables']>[number];
type ForeignKeyInput = NonNullable<TableInput['foreignKeys']>[number];

function table(
  name: string,
  columns: [string, string][],
  options: { pk?: string[]; fks?: ForeignKeyInput[]; comment?: string } = {},
): TableInput {
  const out: TableInput = {
    name,
    columns: columns.map(([column, dataType], index) => ({
      name: column,
      ordinal: index + 1,
      dataType,
      nullable: column !== 'id',
    })),
    foreignKeys: options.fks ?? [],
  };
  if (options.pk) out.primaryKey = { name: `${name}_pkey`, columns: options.pk };
  if (options.comment) out.comment = options.comment;
  return out;
}

function fk(
  name: string,
  columns: string[],
  refTable: string,
  refColumns: string[],
  refSchema?: string,
): ForeignKeyInput {
  const out: ForeignKeyInput = { name, columns, refTable, refColumns };
  if (refSchema) out.refSchema = refSchema;
  return out;
}

function shopTables(dialect: SqlDialect): TableInput[] {
  const pg = dialect === 'postgres';
  const int = pg ? 'integer' : 'int';
  const text = pg ? 'text' : 'varchar(255)';
  const money = pg ? 'numeric(10,2)' : 'decimal(10,2)';
  const ts = pg ? 'timestamp with time zone' : 'datetime';
  return [
    table(
      'users',
      [
        ['id', int],
        ['email', text],
        ['name', text],
        ['created_at', ts],
        ['Display Name', text],
      ],
      { pk: ['id'], comment: 'People who can sign in' },
    ),
    table(
      'orders',
      [
        ['id', int],
        ['user_id', int],
        ['status', text],
        ['total', money],
        ['created_at', ts],
      ],
      { pk: ['id'], fks: [fk('orders_user_id_fkey', ['user_id'], 'users', ['id'])] },
    ),
    table(
      'products',
      [
        ['id', int],
        ['sku', text],
        ['name', text],
        ['price', money],
      ],
      { pk: ['id'] },
    ),
    table(
      'order_items',
      [
        ['order_id', int],
        ['product_id', int],
        ['quantity', int],
        ['price', money],
      ],
      {
        pk: ['order_id', 'product_id'],
        fks: [
          fk('order_items_order_id_fkey', ['order_id'], 'orders', ['id']),
          fk('order_items_product_id_fkey', ['product_id'], 'products', ['id']),
        ],
      },
    ),
    table(
      'shipments',
      [
        ['id', int],
        ['order_id', int],
        ['product_id', int],
        ['shipped_at', ts],
      ],
      {
        pk: ['id'],
        fks: [
          fk('shipments_item_fkey', ['order_id', 'product_id'], 'order_items', [
            'order_id',
            'product_id',
          ]),
        ],
      },
    ),
    table(
      'employees',
      [
        ['id', int],
        ['manager_id', int],
        ['name', text],
      ],
      { pk: ['id'], fks: [fk('employees_manager_fkey', ['manager_id'], 'employees', ['id'])] },
    ),
    table(
      'UserAccounts',
      [
        ['id', int],
        ['userId', int],
        ['Provider', text],
      ],
      { pk: ['id'], fks: [fk('accounts_user_fkey', ['userId'], 'users', ['id'])] },
    ),
    table(
      'order details',
      [
        ['id', int],
        ['note', text],
      ],
      { pk: ['id'] },
    ),
    table(
      'group',
      [
        ['id', int],
        ['name', text],
      ],
      { pk: ['id'] },
    ),
  ];
}

const CAPTURED_AT = '2026-09-29T00:00:00.000Z';

export function postgresSnapshot(): SchemaSnapshot {
  const input: SnapshotInput = {
    engine: 'postgres',
    database: 'shop',
    capturedAt: CAPTURED_AT,
    schemas: [
      {
        name: 'public',
        tables: shopTables('postgres'),
        views: [
          {
            name: 'active_users',
            definition: 'SELECT id, email FROM users',
            columns: ['id', 'email'],
          },
          {
            name: 'daily_sales',
            materialized: true,
            definition: 'SELECT ...',
            columns: ['day', 'total'],
          },
        ],
        routines: [
          {
            name: 'calc_total',
            kind: 'function',
            signature: 'integer, numeric',
            returns: 'numeric',
            language: 'sql',
            definition:
              'CREATE OR REPLACE FUNCTION public.calc_total(p_order integer, p_discount numeric DEFAULT 0)\n RETURNS numeric\n LANGUAGE sql\nAS $function$ SELECT sum(price) FROM order_items WHERE order_id = p_order $function$',
          },
          {
            name: 'archive_orders',
            kind: 'procedure',
            signature: 'date',
            language: 'plpgsql',
            definition:
              'CREATE OR REPLACE PROCEDURE public.archive_orders(IN before date)\n LANGUAGE plpgsql\nAS $procedure$ BEGIN END $procedure$',
          },
        ],
        sequences: [{ name: 'orders_id_seq', start: '1', increment: '1', ownedBy: 'orders.id' }],
        types: [
          {
            name: 'order_status',
            kind: 'enum',
            values: ['new', 'paid'],
            definition: "CREATE TYPE public.order_status AS ENUM ('new', 'paid')",
          },
        ],
      },
      {
        name: 'sales',
        tables: [
          table(
            'invoices',
            [
              ['id', 'integer'],
              ['order_id', 'integer'],
              ['amount', 'numeric(10,2)'],
            ],
            {
              pk: ['id'],
              fks: [fk('invoices_order_fkey', ['order_id'], 'orders', ['id'], 'public')],
            },
          ),
          table(
            'users',
            [
              ['id', 'integer'],
              ['region', 'text'],
            ],
            { pk: ['id'] },
          ),
        ],
      },
      {
        name: 'Audit',
        tables: [
          table(
            'change log',
            [
              ['id', 'integer'],
              ['Changed At', 'timestamp with time zone'],
            ],
            { pk: ['id'] },
          ),
        ],
      },
    ],
  };
  return schemaSnapshotSchema.parse(input);
}

export function mysqlSnapshots(dialect: 'mysql' | 'mariadb'): SchemaSnapshot[] {
  const shop: SnapshotInput = {
    engine: dialect,
    database: 'shop',
    capturedAt: CAPTURED_AT,
    schemas: [
      {
        name: 'shop',
        tables: shopTables(dialect),
        views: [{ name: 'active_users', definition: 'select ...', columns: ['id', 'email'] }],
        routines: [
          {
            name: 'calc_total',
            kind: 'function',
            returns: 'decimal(10,2)',
            definition:
              'CREATE FUNCTION `calc_total`(p_order INT, p_discount DECIMAL(10,2)) RETURNS decimal(10,2)\nREADS SQL DATA\nRETURN 0',
          },
          {
            name: 'archive_orders',
            kind: 'procedure',
            definition: 'CREATE PROCEDURE `archive_orders`(IN before_date DATE)\nBEGIN\nEND',
          },
        ],
        sequences:
          dialect === 'mariadb' ? [{ name: 'invoice_seq', start: '1', increment: '1' }] : [],
      },
    ],
  };
  const analytics: SnapshotInput = {
    engine: dialect,
    database: 'analytics',
    capturedAt: CAPTURED_AT,
    schemas: [
      {
        name: 'analytics',
        tables: [
          table(
            'events',
            [
              ['id', 'bigint'],
              ['user_id', 'int'],
              ['kind', 'varchar(32)'],
            ],
            { pk: ['id'], fks: [fk('events_user_fkey', ['user_id'], 'users', ['id'], 'shop')] },
          ),
        ],
      },
    ],
  };
  return [schemaSnapshotSchema.parse(shop), schemaSnapshotSchema.parse(analytics)];
}

/** A generated catalog of `tables` tables of `columns` columns, with a foreign key each. */
export function largeSnapshot(
  dialect: SqlDialect,
  tables: number,
  columns: number,
): SchemaSnapshot {
  const tableInputs: TableInput[] = [];
  for (let t = 0; t < tables; t++) {
    const cols: [string, string][] = [['id', 'integer']];
    for (let c = 1; c < columns; c++) cols.push([`col_${c}`, 'text']);
    cols.push(['parent_id', 'integer']);
    tableInputs.push(
      table(`table_${t}`, cols, {
        pk: ['id'],
        fks: t > 0 ? [fk(`fk_${t}`, ['parent_id'], `table_${t - 1}`, ['id'])] : [],
      }),
    );
  }
  const schema = dialect === 'postgres' ? 'public' : 'big';
  return schemaSnapshotSchema.parse({
    engine: dialect,
    database: 'big',
    capturedAt: CAPTURED_AT,
    schemas: [{ name: schema, tables: tableInputs }],
  } satisfies SnapshotInput);
}
