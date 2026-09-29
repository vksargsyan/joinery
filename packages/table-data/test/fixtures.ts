import { tableDefSchema, type SqlDialect, type TableDef } from '@joinery/core';

import { describeColumns, type ColumnInfo } from '../src';

/** A PostgreSQL table with a composite primary key and many column kinds. */
export const pgItems: TableDef = tableDefSchema.parse({
  name: 'items',
  columns: [
    { name: 'region', ordinal: 1, dataType: 'text', nullable: false },
    { name: 'id', ordinal: 2, dataType: 'bigint', nullable: false },
    { name: 'name', ordinal: 3, dataType: 'character varying(50)', nullable: true },
    { name: 'qty', ordinal: 4, dataType: 'integer', nullable: false, default: '0' },
    { name: 'price', ordinal: 5, dataType: 'numeric(10,2)', nullable: true },
    { name: 'ratio', ordinal: 6, dataType: 'real', nullable: true },
    { name: 'active', ordinal: 7, dataType: 'boolean', nullable: true },
    { name: 'born', ordinal: 8, dataType: 'date', nullable: true },
    {
      name: 'updated',
      ordinal: 9,
      dataType: 'timestamp with time zone',
      nullable: true,
      default: 'now()',
    },
    { name: 'doc', ordinal: 10, dataType: 'jsonb', nullable: true },
    { name: 'raw', ordinal: 11, dataType: 'json', nullable: true },
    { name: 'data', ordinal: 12, dataType: 'bytea', nullable: true },
    { name: 'tags', ordinal: 13, dataType: 'text[]', nullable: true },
    {
      name: 'total',
      ordinal: 14,
      dataType: 'numeric',
      nullable: true,
      generated: { expression: 'price * qty', stored: true },
    },
  ],
  primaryKey: { name: 'items_pkey', columns: ['region', 'id'] },
});

/** The same shape on MySQL. */
export const mysqlItems: TableDef = tableDefSchema.parse({
  name: 'items',
  columns: [
    { name: 'region', ordinal: 1, dataType: 'varchar(20)', nullable: false },
    { name: 'id', ordinal: 2, dataType: 'bigint', nullable: false },
    { name: 'name', ordinal: 3, dataType: 'varchar(50)', nullable: true },
    { name: 'qty', ordinal: 4, dataType: 'int', nullable: false, default: '0' },
    { name: 'price', ordinal: 5, dataType: 'decimal(10,2)', nullable: true },
    { name: 'ratio', ordinal: 6, dataType: 'float', nullable: true },
    { name: 'active', ordinal: 7, dataType: 'tinyint(1)', nullable: true },
    { name: 'born', ordinal: 8, dataType: 'date', nullable: true },
    {
      name: 'updated',
      ordinal: 9,
      dataType: 'timestamp',
      nullable: true,
      default: 'CURRENT_TIMESTAMP',
    },
    { name: 'doc', ordinal: 10, dataType: 'json', nullable: true },
    { name: 'feeling', ordinal: 11, dataType: "enum('sad','ok','happy')", nullable: true },
    { name: 'data', ordinal: 12, dataType: 'varbinary(16)', nullable: true },
    { name: 'flags', ordinal: 13, dataType: "set('a','b','c')", nullable: true },
    {
      name: 'total',
      ordinal: 14,
      dataType: 'decimal(20,2)',
      nullable: true,
      generated: { expression: '`price` * `qty`', stored: false },
    },
  ],
  primaryKey: { name: 'PRIMARY', columns: ['region', 'id'] },
  options: { charset: 'utf8mb4', collation: 'utf8mb4_0900_ai_ci' },
});

export function itemsFor(dialect: SqlDialect): { table: TableDef; columns: ColumnInfo[] } {
  const table = dialect === 'postgres' ? pgItems : mysqlItems;
  return { table, columns: describeColumns(table, { dialect }) };
}

export const DIALECTS: readonly SqlDialect[] = ['postgres', 'mysql', 'mariadb'];
