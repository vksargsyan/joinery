import { schemaSnapshotSchema, type SchemaSnapshot, type SqlDialect } from '@querybara/core';
import { emptyQueryModel, parseQuery, type QueryModel } from '@querybara/sql-tools';
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';

import { QueryBuilder } from '../src/renderer/src/state/query-builder/builder';
import {
  builderCatalog,
  entryOf,
  proposeJoins,
  searchEntries,
  type BuilderCatalog,
  type CatalogEntry,
} from '../src/renderer/src/state/query-builder/catalog';
import {
  addTable,
  allCriteria,
  connectColumns,
  groupBySelected,
  isColumnSelected,
  moveItem,
  reconcile,
  removeJoinCondition,
  removeTable,
  swapJoin,
  toggleColumn,
  unknownTables,
} from '../src/renderer/src/state/query-builder/edit';
import { layoutBoxes, placeNext } from '../src/renderer/src/state/query-builder/layout';
import {
  aliasOptions,
  columnOptions,
  defaultValue,
  withOperator,
} from '../src/renderer/src/state/query-builder/options';

/**
 * The visual query builder's renderer state (spec §8): the catalog from the metadata cache and
 * the joins its foreign keys propose, the model edits, the builder kept in step with its SQL
 * both ways (and read-only when the SQL is beyond it), the side panels' options and the
 * elkjs layout.
 */

type SnapshotInput = z.input<typeof schemaSnapshotSchema>;

function shop(dialect: SqlDialect): SchemaSnapshot {
  const pg = dialect === 'postgres';
  const int = pg ? 'integer' : 'int';
  const input: SnapshotInput = {
    engine: dialect,
    database: 'shop',
    capturedAt: '2026-09-30T00:00:00Z',
    schemas: [
      {
        name: pg ? 'public' : 'shop',
        tables: [
          {
            name: 'customers',
            columns: [
              { name: 'id', ordinal: 1, dataType: int, nullable: false },
              { name: 'name', ordinal: 2, dataType: 'text', nullable: true },
              {
                name: 'active',
                ordinal: 3,
                dataType: pg ? 'boolean' : 'tinyint(1)',
                nullable: true,
              },
            ],
            primaryKey: { name: 'customers_pkey', columns: ['id'] },
          },
          {
            name: 'orders',
            columns: [
              { name: 'id', ordinal: 1, dataType: int, nullable: false },
              { name: 'customer_id', ordinal: 2, dataType: int, nullable: false },
              { name: 'total', ordinal: 3, dataType: 'numeric(10,2)', nullable: false },
            ],
            primaryKey: { name: 'orders_pkey', columns: ['id'] },
            foreignKeys: [
              {
                name: 'orders_customer',
                columns: ['customer_id'],
                refTable: 'customers',
                refColumns: ['id'],
              },
            ],
          },
          {
            name: 'items',
            columns: [
              { name: 'order_id', ordinal: 1, dataType: int, nullable: false },
              { name: 'sku', ordinal: 2, dataType: 'text', nullable: false },
            ],
            foreignKeys: [
              {
                name: 'items_order',
                columns: ['order_id'],
                refTable: 'orders',
                refColumns: ['id'],
              },
            ],
          },
        ],
        views: [{ name: 'big_orders', definition: 'SELECT 1', columns: ['id', 'total'] }],
      },
      ...(pg
        ? [
            {
              name: 'audit',
              tables: [
                {
                  name: 'log',
                  columns: [{ name: 'at', ordinal: 1, dataType: 'timestamp', nullable: false }],
                },
              ],
            },
          ]
        : []),
    ],
  };
  return schemaSnapshotSchema.parse(input);
}

function ids(): () => string {
  let n = 0;
  return () => `n${++n}`;
}

function entry(catalog: BuilderCatalog, name: string): CatalogEntry {
  return catalog.entries.find((e) => e.name === name)!;
}

const pgCatalog = builderCatalog(shop('postgres'), 'postgres');

describe('builder catalog', () => {
  it('lists the default schema first, views included', () => {
    expect(pgCatalog.defaultSchema).toBe('public');
    expect(pgCatalog.entries.map((e) => `${e.schema}.${e.name}:${e.kind}`)).toEqual([
      'public.big_orders:view',
      'public.customers:table',
      'public.items:table',
      'public.orders:table',
      'audit.log:table',
    ]);
    expect(entry(pgCatalog, 'customers').columns[0]).toEqual({
      name: 'id',
      dataType: 'integer',
      primaryKey: true,
    });
    const my = builderCatalog(shop('mysql'), 'mysql');
    expect(my.defaultSchema).toBe('shop');
    expect(my.entries.every((e) => e.schema === 'shop')).toBe(true);
  });

  it('finds model tables with and without schema, and searches by words', () => {
    expect(entryOf(pgCatalog, { id: 't', name: 'orders' })?.schema).toBe('public');
    expect(entryOf(pgCatalog, { id: 't', schema: 'audit', name: 'log' })?.name).toBe('log');
    expect(entryOf(pgCatalog, { id: 't', name: 'log' })).toBeUndefined();
    const my = builderCatalog(shop('mariadb'), 'mariadb');
    expect(entryOf(my, { id: 't', schema: 'SHOP', name: 'Orders' })?.name).toBe('orders');
    expect(searchEntries(pgCatalog, 'ord').map((e) => e.name)).toEqual(['big_orders', 'orders']);
    expect(searchEntries(pgCatalog, 'audit l').map((e) => e.name)).toEqual(['log']);
  });

  it('proposes joins from foreign keys in both directions', () => {
    const newId = ids();
    let model: QueryModel = emptyQueryModel();
    ({ model } = addTable(model, pgCatalog, entry(pgCatalog, 'orders'), newId));
    const first = model.tables[0]!.id;
    ({ model } = addTable(model, pgCatalog, entry(pgCatalog, 'customers'), newId));
    const customers = model.tables[1]!.id;
    expect(model.joins).toEqual([
      {
        id: expect.any(String),
        type: 'inner',
        left: first,
        right: customers,
        conditions: [{ left: 'customer_id', operator: '=', right: 'id' }],
      },
    ]);
    ({ model } = addTable(model, pgCatalog, entry(pgCatalog, 'items'), newId));
    expect(model.joins[1]).toMatchObject({
      left: first,
      right: model.tables[2]!.id,
      conditions: [{ left: 'id', operator: '=', right: 'order_id' }],
    });
    // A pair already joined gets no second join.
    expect(proposeJoins(model, pgCatalog, customers, newId)).toEqual([]);
  });
});

describe('model edits', () => {
  const newId = ids();
  const orders = addTable(emptyQueryModel(), pgCatalog, entry(pgCatalog, 'orders'), newId);
  const both = addTable(orders.model, pgCatalog, entry(pgCatalog, 'customers'), newId);
  const o = orders.tableId;
  const c = both.tableId;

  it('aliases a table added twice', () => {
    const again = addTable(both.model, pgCatalog, entry(pgCatalog, 'orders'), newId);
    expect(again.model.tables.at(-1)).toMatchObject({
      schema: 'public',
      name: 'orders',
      alias: 'orders_2',
    });
    // Its foreign key joins it to customers too.
    expect(again.model.joins.filter((j) => j.right === again.tableId)).toHaveLength(1);
  });

  it('ticks columns and removes a table with everything that refers to it', () => {
    let model = toggleColumn(both.model, c, 'name', true, newId);
    model = toggleColumn(model, o, 'total', true, newId);
    model = toggleColumn(model, o, 'total', true, newId);
    expect(model.columns).toHaveLength(2);
    expect(isColumnSelected(model, c, 'name')).toBe(true);
    const parsed = parseQuery(
      "SELECT 1 FROM t WHERE t.a = 1 AND (t.b = 2 OR lower('x') = 'x') ORDER BY t.a",
      'postgres',
    );
    if (parsed.status !== 'ok') throw new Error(parsed.message);
    const t = parsed.model.tables[0]!.id;
    model = {
      ...model,
      where: {
        ...parsed.model.where,
        items: parsed.model.where.items.map((item) =>
          JSON.parse(JSON.stringify(item).replaceAll(`"table":"${t}"`, `"table":"${c}"`)),
        ),
      },
      orderBy: [{ id: 's', expr: { kind: 'column', table: c, column: 'name' }, direction: 'asc' }],
    };
    const removed = removeTable(model, c);
    expect(removed.tables.map((table) => table.id)).toEqual([o]);
    expect(removed.joins).toEqual([]);
    expect(removed.columns).toHaveLength(1);
    expect(removed.orderBy).toEqual([]);
    expect(allCriteria(removed.where).map((item) => item.kind)).toEqual(['group', 'condition']);
    expect(toggleColumn(model, c, 'name', false, newId).columns).toHaveLength(1);
  });

  it('draws joins between columns and swaps and trims them', () => {
    const drawn = connectColumns(
      both.model,
      { table: c, column: 'id' },
      { table: o, column: 'id' },
      newId,
    );
    expect(drawn.model.joins).toHaveLength(1);
    expect(drawn.model.joins[0]!.conditions).toEqual([
      { left: 'customer_id', operator: '=', right: 'id' },
      { left: 'id', operator: '=', right: 'id' },
    ]);
    const fresh = connectColumns(
      { ...both.model, joins: [] },
      { table: c, column: 'id' },
      { table: o, column: 'customer_id' },
      newId,
    );
    expect(fresh.model.joins[0]).toMatchObject({ type: 'inner', left: c, right: o });
    const left = {
      ...drawn.model,
      joins: drawn.model.joins.map((j) => ({ ...j, type: 'left' as const })),
    };
    const joinId = left.joins[0]!.id;
    const swapped = swapJoin(
      {
        ...left,
        joins: [{ ...left.joins[0]!, conditions: [{ left: 'total', operator: '<', right: 'id' }] }],
      },
      joinId,
    );
    expect(swapped.joins[0]).toMatchObject({
      type: 'right',
      left: c,
      right: o,
      conditions: [{ left: 'id', operator: '>', right: 'total' }],
    });
    const one = removeJoinCondition(drawn.model, joinId, 0);
    expect(one.joins[0]!.conditions).toHaveLength(1);
    expect(removeJoinCondition(one, joinId, 0).joins).toEqual([]);
  });

  it('groups by the selected columns and moves list items', () => {
    let model = toggleColumn(both.model, c, 'name', true, newId);
    model = {
      ...model,
      columns: [
        ...model.columns,
        { kind: 'expr', id: 'agg', expr: { kind: 'aggregate', fn: 'count' } },
      ],
    };
    model = groupBySelected(model, newId);
    expect(model.groupBy.map((item) => item.expr)).toEqual([
      { kind: 'column', table: c, column: 'name' },
    ]);
    expect(groupBySelected(model, newId).groupBy).toHaveLength(1);
    expect(moveItem([{ id: 'a' }, { id: 'b' }, { id: 'c' }], 'a', 5).map((i) => i.id)).toEqual([
      'b',
      'c',
      'a',
    ]);
    expect(moveItem([{ id: 'a' }, { id: 'b' }], 'b', -1).map((i) => i.id)).toEqual(['b', 'a']);
  });

  it('keeps the ids of tables a parsed model still has', () => {
    const parsed = parseQuery(
      'SELECT * FROM public.customers JOIN public.orders ON customers.id = orders.customer_id JOIN public.items ON orders.id = items.order_id',
      'postgres',
    );
    if (parsed.status !== 'ok') throw new Error(parsed.message);
    const model = reconcile(both.model, parsed.model, newId);
    expect(model.tables.map((t) => t.id)).toEqual([c, o, expect.stringMatching(/^n\d+$/)]);
    expect(model.joins[0]).toMatchObject({ id: both.model.joins[0]!.id, left: c, right: o });
    expect(unknownTables(model, pgCatalog)).toEqual([]);
    expect(
      unknownTables({ ...model, tables: [{ id: 'x', name: 'nope' }] }, pgCatalog),
    ).toHaveLength(1);
  });
});

describe('side panel options', () => {
  it('offers the columns of the tables and those the model uses', () => {
    const newId = ids();
    const { model: one, tableId } = addTable(
      emptyQueryModel(),
      pgCatalog,
      entry(pgCatalog, 'customers'),
      newId,
    );
    expect(columnOptions(one, pgCatalog).map((option) => option.label)).toEqual([
      'id',
      'name',
      'active',
    ]);
    const two = addTable(one, pgCatalog, entry(pgCatalog, 'orders'), newId).model;
    const withGhost: QueryModel = {
      ...two,
      columns: [
        {
          kind: 'expr',
          id: 'g',
          expr: { kind: 'column', table: tableId, column: 'gone' },
          alias: 'g',
        },
      ],
    };
    const labels = columnOptions(withGhost, pgCatalog).map((option) => option.label);
    expect(labels).toEqual([
      'customers.id',
      'customers.name',
      'customers.active',
      'orders.id',
      'orders.customer_id',
      'orders.total',
      'customers.gone',
    ]);
    expect(aliasOptions(withGhost).map((option) => option.label)).toEqual(['g (output)']);
  });

  it('picks value kinds from column types and pads values to the operator', () => {
    expect(defaultValue('integer')).toEqual({ kind: 'number', value: '' });
    expect(defaultValue('numeric(10,2)')).toEqual({ kind: 'number', value: '' });
    expect(defaultValue('boolean')).toEqual({ kind: 'boolean', value: true });
    expect(defaultValue('tinyint(1)')).toEqual({ kind: 'boolean', value: true });
    expect(defaultValue('text')).toEqual({ kind: 'string', value: '' });
    const condition = {
      kind: 'condition' as const,
      id: 'c',
      left: { kind: 'column' as const, column: 'a' },
      operator: '=' as const,
      values: [{ kind: 'number' as const, value: '1' }],
    };
    const blank = { kind: 'number' as const, value: '' };
    expect(withOperator(condition, 'between', blank).values).toEqual([
      { kind: 'number', value: '1' },
      blank,
    ]);
    expect(withOperator(condition, 'is null', blank).values).toEqual([]);
    expect(withOperator(condition, 'in', blank).values).toHaveLength(1);
    expect(withOperator({ ...condition, values: [] }, 'like', blank).values).toEqual([blank]);
  });
});

describe('QueryBuilder', () => {
  function builder(
    dialect: SqlDialect = 'postgres',
    catalog = builderCatalog(shop(dialect), dialect),
  ) {
    return new QueryBuilder({ profileId: 'p', dialect }, () => Promise.resolve(catalog), ids());
  }

  it('writes SQL for every builder edit', async () => {
    const b = builder();
    await b.init();
    expect(b.state.sql).toBe('SELECT *');
    const orders = b.addTable(entry(b.catalog!, 'orders'))!;
    const customers = b.addTable(entry(b.catalog!, 'customers'))!;
    b.toggleColumn(customers, 'name', true);
    b.toggleColumn(orders, 'total', true);
    b.addCriterion('where', 'where', {
      kind: 'condition',
      left: { kind: 'column', table: orders, column: 'total' },
      operator: '>',
      values: [{ kind: 'number', value: '10' }],
    });
    b.addOrderItem({ expr: { kind: 'column', table: orders, column: 'total' }, direction: 'desc' });
    b.setPaging('limit', 5);
    expect(b.state.sql).toBe(
      [
        'SELECT',
        '  "customers"."name",',
        '  "orders"."total"',
        'FROM "public"."orders"',
        '  INNER JOIN "public"."customers" ON "orders"."customer_id" = "customers"."id"',
        'WHERE "orders"."total" > 10',
        'ORDER BY "orders"."total" DESC',
        'LIMIT 5',
      ].join('\n'),
    );
    expect(b.state.sqlSource).toBe('builder');
    expect(b.state.issues).toEqual([]);
    expect(b.state.positions[orders]).toEqual({ x: 40, y: 40 });
    expect(b.state.positions[customers]).toEqual({ x: 360, y: 40 });
  });

  it('makes its own unique ids by default', async () => {
    const catalog = builderCatalog(shop('postgres'), 'postgres');
    const b = new QueryBuilder({ profileId: 'p', dialect: 'postgres' }, () =>
      Promise.resolve(catalog),
    );
    await b.init();
    const first = b.addTable(entry(catalog, 'orders'));
    const second = b.addTable(entry(catalog, 'orders'));
    expect(first).toMatch(/^[0-9a-f-]{36}$/);
    expect(second).not.toBe(first);
  });

  it('blocks running a query with an unfinished condition', async () => {
    const b = builder();
    await b.init();
    const orders = b.addTable(entry(b.catalog!, 'orders'))!;
    b.addCriterion('where', 'where', {
      kind: 'condition',
      left: { kind: 'column', table: orders, column: 'total' },
      operator: 'between',
      values: [{ kind: 'number', value: '1' }],
    });
    expect(b.blockingIssue?.message).toBe('BETWEEN needs two values; the condition is left out.');
    b.setSql('SELECT 1');
    expect(b.blockingIssue).toBeUndefined();
  });

  it('follows the SQL when it is edited, keeping the tables it still has', async () => {
    const b = builder();
    await b.init();
    const orders = b.addTable(entry(b.catalog!, 'orders'))!;
    b.movePositions({ [orders]: { x: 500, y: 300 } });
    const layout = b.state.layoutRequest;
    const sql =
      'select total, name from public.orders o join customers c on c.id = o.customer_id where active';
    b.setSql(sql);
    expect(b.state.sql).toBe(sql);
    expect(b.state.sqlSource).toBe('editor');
    expect(b.state.sync).toEqual({ status: 'synced' });
    const model = b.state.model;
    // The alias makes it another table reference: a new id, laid out again.
    expect(model.tables.map((t) => t.alias)).toEqual(['o', 'c']);
    expect(b.state.layoutRequest).toBe(layout + 1);
    // Unqualified columns attach to their tables through the catalog.
    expect(model.columns.map((item) => (item.kind === 'expr' ? item.expr : item))).toEqual([
      { kind: 'column', table: model.tables[0]!.id, column: 'total' },
      { kind: 'column', table: model.tables[1]!.id, column: 'name' },
    ]);
    expect(allCriteria(model.where)).toEqual([
      { kind: 'custom', id: expect.any(String), sql: 'active' },
    ]);

    const unaliased = builder();
    await unaliased.init();
    const kept = unaliased.addTable(entry(unaliased.catalog!, 'orders'))!;
    unaliased.movePositions({ [kept]: { x: 500, y: 300 } });
    unaliased.setSql('SELECT id FROM public.orders WHERE total > 5');
    expect(unaliased.state.model.tables[0]!.id).toBe(kept);
    expect(unaliased.state.positions[kept]).toEqual({ x: 500, y: 300 });
    // A builder edit writes its own SQL again.
    unaliased.toggleColumn(kept, 'total', true);
    expect(unaliased.state.sqlSource).toBe('builder');
    expect(unaliased.state.sql).toBe(
      'SELECT\n  "id",\n  "total"\nFROM "public"."orders"\nWHERE "total" > 5',
    );
  });

  it('turns read-only on SQL it cannot show, and back', async () => {
    const b = builder();
    await b.init();
    const orders = b.addTable(entry(b.catalog!, 'orders'))!;
    const before = b.state.model;
    b.setSql('WITH t AS (SELECT 1) SELECT * FROM t');
    expect(b.state.sync).toMatchObject({
      status: 'unsupported',
      construct: 'a WITH clause (common table expression)',
      start: 0,
      end: 4,
    });
    expect(b.readOnly).toBe(true);
    expect(b.state.model).toBe(before);
    b.toggleColumn(orders, 'id', true);
    expect(b.state.model).toBe(before);
    expect(b.addTable(entry(b.catalog!, 'customers'))).toBeUndefined();
    b.setSql('SELECT * FROM orders WHERE');
    expect(b.state.sync).toMatchObject({ status: 'invalid' });
    b.revertSql();
    expect(b.readOnly).toBe(false);
    expect(b.state.sql).toBe('SELECT *\nFROM "public"."orders"');
    expect(b.state.sqlSource).toBe('builder');
  });

  it('opens SQL once the catalog is loaded and asks for a layout', async () => {
    const b = builder('mysql');
    await b.init('SELECT o.id FROM orders o, customers c WHERE c.id = o.customer_id');
    expect(b.state.catalog.status).toBe('ready');
    expect(b.state.model.tables.map((t) => t.name)).toEqual(['orders', 'customers']);
    expect(b.state.layoutRequest).toBe(1);
    expect(b.state.sync.status).toBe('synced');
  });

  it('reports a catalog that cannot load, and keeps a loaded one on a failed refresh', async () => {
    let fail = true;
    const catalog = builderCatalog(shop('postgres'), 'postgres');
    const b = new QueryBuilder(
      { profileId: 'p', dialect: 'postgres' },
      () => (fail ? Promise.reject(new Error('Not connected')) : Promise.resolve(catalog)),
      ids(),
    );
    await b.init();
    expect(b.state.catalog).toEqual({ status: 'error', error: 'Not connected' });
    fail = false;
    await b.reloadCatalog();
    expect(b.state.catalog.status).toBe('ready');
    fail = true;
    await b.reloadCatalog();
    expect(b.state.catalog.status).toBe('ready');
  });

  it('selects joins drawn on the canvas and shows them in the Joins panel', async () => {
    const b = builder();
    await b.init();
    const orders = b.addTable(entry(b.catalog!, 'orders'))!;
    const items = b.addTable(entry(b.catalog!, 'items'))!;
    b.removeJoin(b.state.model.joins[0]!.id);
    b.connectColumns({ table: orders, column: 'id' }, { table: items, column: 'order_id' });
    expect(b.state.selectedJoin).toBe(b.state.model.joins[0]!.id);
    b.selectJoin(b.state.model.joins[0]!.id);
    expect(b.state.panel).toBe('joins');
    b.setJoinType(b.state.model.joins[0]!.id, 'full');
    expect(b.state.issues).toEqual([]);
    const my = builder('mysql');
    await my.init();
    const a = my.addTable(entry(my.catalog!, 'orders'))!;
    my.addTable(entry(my.catalog!, 'items'));
    my.setJoinType(my.state.model.joins[0]!.id, 'full');
    expect(my.blockingIssue?.message).toBe('MySQL has no FULL JOIN.');
    expect(a).toBeDefined();
  });
});

describe('layout', () => {
  it('lays joined tables out left to right with elkjs', async () => {
    const placed = await layoutBoxes(
      [
        { id: 'a', width: 200, height: 100 },
        { id: 'b', width: 200, height: 150 },
        { id: 'c', width: 200, height: 80 },
      ],
      [
        { id: 'ab', source: 'a', target: 'b' },
        { id: 'bc', source: 'b', target: 'c' },
        { id: 'gone', source: 'a', target: 'x' },
      ],
    );
    expect(Object.keys(placed).sort()).toEqual(['a', 'b', 'c']);
    expect(placed['a']!.x).toBeLessThan(placed['b']!.x);
    expect(placed['b']!.x).toBeLessThan(placed['c']!.x);
    expect(await layoutBoxes([], [])).toEqual({});
  });

  it('places a new table right of the others', () => {
    expect(placeNext([])).toEqual({ x: 40, y: 40 });
    expect(
      placeNext([
        { x: 10, y: 50 },
        { x: 300, y: 20, width: 100 },
      ]),
    ).toEqual({ x: 480, y: 20 });
  });
});
