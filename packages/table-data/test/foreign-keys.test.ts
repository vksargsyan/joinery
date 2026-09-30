import { foreignKeyDefSchema, tableDefSchema } from '@joinery/core';
import { describe, expect, it } from 'vitest';

import {
  buildLookupQuery,
  buildReferencedRowQuery,
  describeColumns,
  foreignKeysOf,
  guessLabelColumn,
  referencedTable,
} from '../src';

const customers = tableDefSchema.parse({
  name: 'customers',
  columns: [
    { name: 'id', ordinal: 1, dataType: 'bigint', nullable: false },
    { name: 'notes', ordinal: 2, dataType: 'text', nullable: true },
    { name: 'email', ordinal: 3, dataType: 'character varying(100)', nullable: false },
    { name: 'full_name', ordinal: 4, dataType: 'character varying(100)', nullable: true },
  ],
  primaryKey: { name: 'customers_pkey', columns: ['id'] },
});
const fk = foreignKeyDefSchema.parse({
  name: 'orders_customer_fk',
  columns: ['customer_id'],
  refTable: 'customers',
  refColumns: ['id'],
});
const orders = tableDefSchema.parse({
  name: 'orders',
  columns: [
    { name: 'id', ordinal: 1, dataType: 'integer', nullable: false },
    { name: 'customer_id', ordinal: 2, dataType: 'bigint', nullable: true },
  ],
  foreignKeys: [fk],
});

describe('foreign keys', () => {
  const pgColumns = describeColumns(customers, { dialect: 'postgres' });

  it('finds the keys of a column and the table they reference', () => {
    expect(foreignKeysOf(orders, 'customer_id')).toEqual([fk]);
    expect(foreignKeysOf(orders, 'id')).toEqual([]);
    expect(referencedTable(fk, 'sales')).toEqual({ schema: 'sales', name: 'customers' });
    expect(referencedTable({ ...fk, refSchema: 'crm' }, 'sales')).toEqual({
      schema: 'crm',
      name: 'customers',
    });
  });

  it('opens the referenced row, or nothing for a NULL reference', () => {
    const query = buildReferencedRowQuery(fk, [42], {
      dialect: 'postgres',
      schema: 'sales',
      referencedColumns: pgColumns,
    });
    expect(query).toMatchObject({
      sql: 'SELECT "id", "notes", "email", "full_name" FROM "sales"."customers" WHERE "id" = $1 LIMIT 1',
      params: [42],
      table: { schema: 'sales', name: 'customers' },
      filter: {
        type: 'group',
        combinator: 'and',
        children: [{ type: 'condition', column: 'id', operator: '=', value: 42 }],
      },
    });
    expect(buildReferencedRowQuery(fk, [null], { dialect: 'postgres' })).toBeNull();
    const mysql = buildReferencedRowQuery(fk, [9007199254740993n], {
      dialect: 'mysql',
      referencedColumns: describeColumns(customers, { dialect: 'mysql' }),
    });
    expect(mysql!.sql).toBe(
      'SELECT `id`, `notes`, `email`, `full_name` FROM `customers` WHERE `id` = CAST(? AS UNSIGNED) LIMIT 1',
    );
    expect(buildReferencedRowQuery(fk, [1], { dialect: 'mysql' })!.sql).toBe(
      'SELECT * FROM `customers` WHERE `id` = ? LIMIT 1',
    );
  });

  it('guesses a label column', () => {
    expect(guessLabelColumn(pgColumns, ['id'])).toBe('full_name');
    expect(
      guessLabelColumn(
        pgColumns.filter((c) => c.name !== 'full_name'),
        ['id'],
      ),
    ).toBe('email');
    expect(
      guessLabelColumn(
        pgColumns.filter((c) => c.name === 'notes' || c.name === 'id'),
        ['id'],
      ),
    ).toBe('notes');
    expect(
      guessLabelColumn(
        pgColumns.filter((c) => c.name === 'id'),
        ['id'],
      ),
    ).toBeNull();
  });

  it('lists lookup options with the key and label, filtered by the search text', () => {
    expect(
      buildLookupQuery(fk, { dialect: 'postgres', referencedColumns: pgColumns }),
    ).toMatchObject({
      sql: 'SELECT "id", "full_name" FROM "customers" ORDER BY "full_name", "id" LIMIT 50',
      params: [],
      keyColumns: ['id'],
      labelColumn: 'full_name',
      columns: ['id', 'full_name'],
    });
    expect(
      buildLookupQuery(fk, {
        dialect: 'postgres',
        referencedColumns: pgColumns,
        search: ' ann_ ',
        limit: 10,
      }),
    ).toMatchObject({
      sql: `SELECT "id", "full_name" FROM "customers" WHERE "full_name" ILIKE $1 ESCAPE '!' OR "id"::text ILIKE $2 ESCAPE '!' ORDER BY "full_name", "id" LIMIT 10`,
      params: ['%ann!_%', 'ann!_%'],
    });
    const mysql = buildLookupQuery(fk, {
      dialect: 'mysql',
      referencedColumns: describeColumns(
        tableDefSchema.parse({
          ...customers,
          columns: customers.columns.map((c) => ({
            ...c,
            dataType: c.dataType.replace('character varying', 'varchar'),
          })),
          options: { charset: 'utf8mb4', collation: 'utf8mb4_general_ci' },
        }),
        { dialect: 'mysql' },
      ),
      search: 'x',
    });
    expect(mysql.sql).toBe(
      "SELECT `id`, `full_name` FROM `customers` WHERE `full_name` LIKE ? ESCAPE '!' OR CONVERT(`id` USING utf8mb4) COLLATE utf8mb4_general_ci LIKE ? ESCAPE '!' ORDER BY `full_name`, `id` LIMIT 50",
    );
    expect(buildLookupQuery(fk, { dialect: 'mysql', labelColumn: null }).sql).toBe(
      'SELECT `id` FROM `customers` ORDER BY `id` LIMIT 50',
    );
  });
});
