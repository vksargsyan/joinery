import { schemaSnapshotSchema, type SchemaSnapshot, type SqlEngineId } from '@querybara/core';
import { describe, expect, it } from 'vitest';

import { dataSyncOrder, pairDataTables } from '../src';

/**
 * Table pairing for a whole-database data compare (spec §13, data sync step 1): tables pair by
 * name, need a primary or unique NOT NULL key both sides share, and every table left out says
 * why. The apply order follows the target's foreign keys.
 */

function snapshot(engine: SqlEngineId, schemas: unknown[]): SchemaSnapshot {
  return schemaSnapshotSchema.parse({
    engine,
    database: 'shop',
    schemas,
    capturedAt: '2026-09-29T10:00:00.000Z',
  });
}

const column = (name: string, ordinal: number, nullable = false) => ({
  name,
  ordinal,
  dataType: 'integer',
  nullable,
});

describe('pairDataTables', () => {
  it('pairs PostgreSQL tables by schema and name and says why the others are left out', () => {
    const source = snapshot('postgres', [
      {
        name: 'public',
        tables: [
          {
            name: 'orders',
            columns: [column('id', 1), column('total', 2, true), column('note', 3, true)],
            primaryKey: { name: 'orders_pkey', columns: ['id'] },
          },
          { name: 'logs', columns: [column('at', 1, true)] },
          {
            name: 'codes',
            columns: [column('code', 1), column('label', 2, true)],
            uniques: [{ name: 'codes_code_key', columns: ['code'] }],
          },
          {
            name: 'events',
            kind: 'partitioned',
            columns: [column('id', 1)],
            primaryKey: { name: 'events_pkey', columns: ['id'] },
            partitioning: { method: 'RANGE', key: '(id)', partitions: [{ name: 'events_1' }] },
          },
          {
            name: 'events_1',
            columns: [column('id', 1)],
            primaryKey: { name: 'events_1_pkey', columns: ['id'] },
          },
          { name: 'draft', columns: [column('id', 1)], primaryKey: { name: 'p', columns: ['id'] } },
        ],
      },
    ]);
    const target = snapshot('postgres', [
      {
        name: 'public',
        tables: [
          {
            name: 'orders',
            columns: [column('id', 1), column('total', 2, true), column('extra', 3, true)],
            primaryKey: { name: 'orders_pkey', columns: ['id'] },
          },
          { name: 'logs', columns: [column('at', 1, true)] },
          {
            name: 'codes',
            columns: [column('code', 1), column('label', 2, true)],
            indexes: [{ name: 'codes_code_idx', unique: true, columns: [{ name: 'code' }] }],
          },
          {
            name: 'events',
            kind: 'partitioned',
            columns: [column('id', 1)],
            primaryKey: { name: 'events_pkey', columns: ['id'] },
            partitioning: { method: 'RANGE', key: '(id)', partitions: [{ name: 'events_1' }] },
          },
          {
            name: 'events_1',
            columns: [column('id', 1)],
            primaryKey: { name: 'events_1_pkey', columns: ['id'] },
          },
          { name: 'archive', columns: [column('id', 1)] },
        ],
      },
    ]);
    const { pairs, skipped } = pairDataTables(source, target);
    expect(pairs.map((p) => [p.name, p.keyColumns, p.keyKind])).toEqual([
      ['public.orders', ['id'], 'primary'],
      ['public.codes', ['code'], 'unique'],
      ['public.events', ['id'], 'primary'],
    ]);
    expect(pairs[0]).toMatchObject({
      source: { schema: 'public', name: 'orders' },
      target: { schema: 'public', name: 'orders' },
      commonColumns: ['id', 'total'],
      sourceOnlyColumns: ['note'],
      targetOnlyColumns: ['extra'],
    });
    expect(skipped).toEqual([
      {
        name: 'public.logs',
        reason: 'The source table has no primary or unique NOT NULL key',
      },
      {
        name: 'public.events_1',
        reason: 'A partition: its rows are compared with its parent table',
      },
      { name: 'public.draft', reason: 'Only in the source' },
      { name: 'public.archive', reason: 'Only in the target' },
    ]);
  });

  it('needs a key over the same columns on both sides', () => {
    const table = (keyColumn: string, nullable = false) => ({
      name: 'items',
      columns: [column('id', 1), column('sku', 2, nullable)],
      uniques: [{ name: `items_${keyColumn}_key`, columns: [keyColumn] }],
    });
    const mysql = (t: unknown) => snapshot('mysql', [{ name: 'shop', tables: [t] }]);
    expect(pairDataTables(mysql(table('id')), mysql(table('sku'))).skipped).toEqual([
      {
        name: 'items',
        reason: 'The tables have no primary or unique NOT NULL key over the same columns',
      },
    ]);
    expect(pairDataTables(mysql(table('id')), mysql(table('sku', true))).skipped).toEqual([
      { name: 'items', reason: 'The target table has no primary or unique NOT NULL key' },
    ]);
  });

  it('pairs MySQL tables across databases and case, and narrows to the tables asked for', () => {
    const source = snapshot('mysql', [
      {
        name: 'shop_dev',
        tables: [
          {
            name: 'Orders',
            columns: [column('id', 1)],
            primaryKey: { name: 'P', columns: ['id'] },
          },
          { name: 'items', columns: [column('id', 1)], primaryKey: { name: 'P', columns: ['id'] } },
        ],
      },
    ]);
    const target = snapshot('mariadb', [
      {
        name: 'shop',
        tables: [
          {
            name: 'orders',
            columns: [column('ID', 1)],
            primaryKey: { name: 'P', columns: ['ID'] },
          },
          { name: 'items', columns: [column('id', 1)], primaryKey: { name: 'P', columns: ['id'] } },
        ],
      },
    ]);
    const all = pairDataTables(source, target);
    expect(all.pairs.map((p) => [p.name, p.target.name, p.source.schema])).toEqual([
      ['Orders', 'orders', undefined],
      ['items', 'items', undefined],
    ]);
    const some = pairDataTables(source, target, { tables: ['items', 'missing'] });
    expect(some.pairs.map((p) => p.name)).toEqual(['items']);
    expect(some.skipped).toEqual([{ name: 'missing', reason: 'No such table on either side' }]);
  });

  it('pairs a MySQL database with one PostgreSQL schema across engines', () => {
    const mysql = snapshot('mysql', [
      {
        name: 'shop',
        tables: [
          { name: 'Items', columns: [column('id', 1)], primaryKey: { name: 'P', columns: ['id'] } },
        ],
      },
    ]);
    const pg = snapshot('postgres', [
      {
        name: 'sales',
        tables: [
          { name: 'items', columns: [column('id', 1)], primaryKey: { name: 'p', columns: ['id'] } },
        ],
      },
    ]);
    expect(pairDataTables(mysql, pg).pairs.map((p) => [p.name, p.source, p.target])).toEqual([
      ['Items', { name: 'Items' }, { schema: 'sales', name: 'items' }],
    ]);
  });
});

describe('dataSyncOrder', () => {
  it('puts referenced tables first and keeps cycles in their original order', () => {
    const table = (name: string, refs: string[]) => ({
      name,
      columns: [column('id', 1), column('ref', 2, true)],
      primaryKey: { name: `${name}_pkey`, columns: ['id'] },
      foreignKeys: refs.map((ref, i) => ({
        name: `${name}_fk${i}`,
        columns: ['ref'],
        refTable: ref,
        refColumns: ['id'],
      })),
    });
    const tables = [
      table('lines', ['orders', 'products']),
      table('orders', ['customers']),
      table('customers', []),
      table('products', ['products']),
      table('a', ['b']),
      table('b', ['a']),
    ];
    const snap = snapshot('postgres', [{ name: 'public', tables }]);
    const { pairs } = pairDataTables(snap, snap);
    const order = dataSyncOrder(pairs, snap).map((i) => pairs[i]!.target.name);
    expect(order).toEqual(['customers', 'products', 'orders', 'lines', 'a', 'b']);
  });
});
