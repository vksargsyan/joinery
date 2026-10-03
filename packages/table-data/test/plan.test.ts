import { tableDefSchema, type SqlDialect } from '@querybara/core';
import { describe, expect, it } from 'vitest';

import {
  ChangeSet,
  DEFAULT,
  allColumnsIdentity,
  describeColumns,
  planChanges,
  rowIdentity,
  rowKeyOf,
  type ExistingRow,
  type RowIdentity,
} from '../src';
import { itemsFor } from './fixtures';

function loaded(identity: RowIdentity, values: Record<string, unknown>): ExistingRow {
  const typed = values as ExistingRow['values'];
  return { key: rowKeyOf(identity, typed)!, values: typed };
}

function mixed(dialect: SqlDialect) {
  const { table, columns } = itemsFor(dialect);
  const identity = rowIdentity(table);
  const eu5 = loaded(identity, { region: 'eu', id: 5, name: 'a', qty: 1, price: '1.50' });
  const us9 = loaded(identity, { region: 'us', id: 9007199254740993n, name: null, qty: 2 });
  const changes = ChangeSet.empty()
    .edit(eu5, 'name', 'b')
    .edit(eu5.key, 'price', null)
    .edit(eu5.key, 'qty', DEFAULT)
    .delete(us9)
    .insert({ region: 'eu', id: 6, name: '' })
    .insert();
  return { changes, columns, identity };
}

describe('planChanges', () => {
  it('plans deletes, updates and inserts for PostgreSQL with RETURNING', () => {
    const { changes, columns, identity } = mixed('postgres');
    const plan = planChanges(changes, {
      dialect: 'postgres',
      table: { schema: 'app', name: 'items' },
      columns,
      identity,
    });
    const returning =
      ' RETURNING "region", "id", "name", "qty", "price", "ratio", "active", "born", "updated", "doc", "raw", "data", "tags", "total"';
    expect(plan.statements.map((s) => [s.kind, s.sql, s.params, s.returnsRow])).toEqual([
      [
        'delete',
        'DELETE FROM "app"."items" WHERE "region" = $1 AND "id" = $2',
        ['us', 9007199254740993n],
        false,
      ],
      [
        'update',
        'UPDATE "app"."items" SET "name" = $1, "qty" = DEFAULT, "price" = $2 WHERE "region" = $3 AND "id" = $4 AND "name" = $5 AND "qty" = $6 AND "price" = $7' +
          returning,
        ['b', null, 'eu', 5, 'a', 1, '1.50'],
        true,
      ],
      [
        'insert',
        `INSERT INTO "app"."items" ("region", "id", "name") VALUES ($1, $2, $3)${returning}`,
        ['eu', 6, ''],
        true,
      ],
      ['insert', `INSERT INTO "app"."items" DEFAULT VALUES${returning}`, [], true],
    ]);
    expect(plan.statements.map((s) => s.label)).toEqual([
      "region = 'us', id = 9007199254740993",
      "region = 'eu', id = 5",
      'new row 1',
      'new row 2',
    ]);
    expect(plan.previewSql.split('\n')).toEqual([
      `DELETE FROM "app"."items" WHERE "region" = 'us' AND "id" = 9007199254740993;`,
      `UPDATE "app"."items" SET "name" = 'b', "qty" = DEFAULT, "price" = NULL WHERE "region" = 'eu' AND "id" = 5 AND "name" = 'a' AND "qty" = 1 AND "price" = '1.50'${returning};`,
      `INSERT INTO "app"."items" ("region", "id", "name") VALUES ('eu', 6, '')${returning};`,
      `INSERT INTO "app"."items" DEFAULT VALUES${returning};`,
    ]);
    expect(plan.statements[1]!.knownValues).toEqual({
      region: 'eu',
      id: 5,
      name: 'b',
      price: null,
    });
  });

  it('plans MySQL with exact comparisons and read-back SELECTs instead of RETURNING', () => {
    const { changes, columns, identity } = mixed('mysql');
    const plan = planChanges(changes, {
      dialect: 'mysql',
      table: { name: 'items' },
      columns,
      identity,
    });
    const select =
      'SELECT `region`, `id`, `name`, `qty`, `price`, `ratio`, `active`, `born`, `updated`, `doc`, `feeling`, `data`, `flags`, `total` FROM `items` WHERE ';
    expect(plan.statements.map((s) => [s.sql, s.params, s.readBack])).toEqual([
      [
        'DELETE FROM `items` WHERE `region` = ? AND `id` = CAST(? AS UNSIGNED)',
        ['us', 9007199254740993n],
        undefined,
      ],
      [
        'UPDATE `items` SET `name` = ?, `qty` = DEFAULT, `price` = ? WHERE `region` = ? AND `id` = ? AND `name` COLLATE utf8mb4_bin = ? AND `qty` = ? AND `price` = CAST(? AS DECIMAL(10,2))',
        ['b', null, 'eu', 5, 'a', 1, '1.50'],
        { sql: `${select}\`region\` = ? AND \`id\` = ?`, params: ['eu', 5] },
      ],
      [
        'INSERT INTO `items` (`region`, `id`, `name`) VALUES (?, ?, ?)',
        ['eu', 6, ''],
        { sql: `${select}\`region\` = ? AND \`id\` = ?`, params: ['eu', 6] },
      ],
      ['INSERT INTO `items` () VALUES ()', [], undefined],
    ]);
    expect(plan.statements[0]!.preview).toBe(
      "DELETE FROM `items` WHERE `region` = 'us' AND `id` = CAST(9007199254740993 AS UNSIGNED)",
    );
  });

  it('uses INSERT ... RETURNING on MariaDB, and a read-back SELECT when it is unavailable', () => {
    const { changes, columns, identity } = mixed('mariadb');
    const plan = planChanges(changes, {
      dialect: 'mariadb',
      table: { name: 'items' },
      columns,
      identity,
    });
    expect(plan.statements[2]!.sql).toMatch(/^INSERT INTO `items` .* RETURNING `region`, `id`/);
    expect(plan.statements[1]!.returnsRow).toBe(false);
    expect(plan.statements[1]!.readBack).toBeDefined();
    const old = planChanges(changes, {
      dialect: 'mariadb',
      table: { name: 'items' },
      columns,
      identity,
      returning: false,
    });
    expect(old.statements[2]!.sql).not.toMatch(/RETURNING/);
    expect(old.statements[2]!.readBack).toBeDefined();
  });

  it('matches on the key alone with conflictCheck: key', () => {
    const { changes, columns, identity } = mixed('postgres');
    const plan = planChanges(changes, {
      dialect: 'postgres',
      table: { name: 'items' },
      columns,
      identity,
      conflictCheck: 'key',
      returning: false,
    });
    expect(plan.statements[1]!.sql).toBe(
      'UPDATE "items" SET "name" = $1, "qty" = DEFAULT, "price" = $2 WHERE "region" = $3 AND "id" = $4',
    );
    expect(plan.statements[1]!.readBack).toEqual({
      sql: 'SELECT "region", "id", "name", "qty", "price", "ratio", "active", "born", "updated", "doc", "raw", "data", "tags", "total" FROM "items" WHERE "region" = $1 AND "id" = $2',
      params: ['eu', 5],
    });
  });

  it('reads AUTO_INCREMENT keys back with LAST_INSERT_ID()', () => {
    const table = tableDefSchema.parse({
      name: 'users',
      columns: [
        { name: 'id', ordinal: 1, dataType: 'int', nullable: false, autoIncrement: true },
        { name: 'email', ordinal: 2, dataType: 'varchar(100)', nullable: false },
      ],
      primaryKey: { name: 'PRIMARY', columns: ['id'] },
    });
    const columns = describeColumns(table, { dialect: 'mysql' });
    const plan = planChanges(
      ChangeSet.empty().insert({ email: 'a@x' }).insert({ id: 7, email: 'b@x' }),
      {
        dialect: 'mysql',
        table: { name: 'users' },
        columns,
        identity: rowIdentity(table),
      },
    );
    expect(plan.statements.map((s) => s.readBack)).toEqual([
      { sql: 'SELECT `id`, `email` FROM `users` WHERE `id` = LAST_INSERT_ID()', params: [] },
      { sql: 'SELECT `id`, `email` FROM `users` WHERE `id` = ?', params: [7] },
    ]);
  });

  describe('all-columns identity', () => {
    const table = tableDefSchema.parse({
      name: 'loose',
      columns: [
        { name: 'a', ordinal: 1, dataType: 'integer', nullable: true },
        { name: 'b', ordinal: 2, dataType: 'text', nullable: true },
        { name: 'j', ordinal: 3, dataType: 'json', nullable: true },
      ],
      options: { charset: 'utf8mb4' },
    });
    const values = { a: 1, b: null, j: '{"x": 1}' };

    it('touches only the first matching row on PostgreSQL through (tableoid, ctid)', () => {
      const identity = allColumnsIdentity(table, { dialect: 'postgres' });
      const row = loaded(identity, values);
      const plan = planChanges(
        ChangeSet.empty()
          .edit(row, 'a', 2)
          .delete(loaded(identity, { ...values, a: 3 })),
        {
          dialect: 'postgres',
          table: { name: 'loose' },
          columns: describeColumns(table, { dialect: 'postgres' }),
          identity,
        },
      );
      expect(plan.statements.map((s) => [s.sql, s.params])).toEqual([
        [
          'DELETE FROM "loose" WHERE (tableoid, ctid) = (SELECT tableoid, ctid FROM "loose" WHERE "a" = $1 AND "b" IS NULL AND "j"::text = $2 LIMIT 1)',
          [3, '{"x": 1}'],
        ],
        [
          'UPDATE "loose" SET "a" = $1 WHERE (tableoid, ctid) = (SELECT tableoid, ctid FROM "loose" WHERE "a" = $2 AND "b" IS NULL AND "j"::text = $3 LIMIT 1) RETURNING "a", "b", "j"',
          [2, 1, '{"x": 1}'],
        ],
      ]);
    });

    it('uses LIMIT 1 and binary string comparison on MySQL', () => {
      const identity = allColumnsIdentity(table, { dialect: 'mysql' });
      const my = tableDefSchema.parse({
        ...table,
        columns: [
          { name: 'a', ordinal: 1, dataType: 'int', nullable: true },
          { name: 'b', ordinal: 2, dataType: 'varchar(10)', nullable: true },
          { name: 'j', ordinal: 3, dataType: 'json', nullable: true },
        ],
      });
      const plan = planChanges(
        ChangeSet.empty().edit(loaded(identity, { ...values, b: 'X' }), 'b', 'y'),
        {
          dialect: 'mysql',
          table: { name: 'loose' },
          columns: describeColumns(my, { dialect: 'mysql' }),
          identity,
        },
      );
      expect(plan.statements[0]!.sql).toBe(
        'UPDATE `loose` SET `b` = ? WHERE `a` = ? AND `b` COLLATE utf8mb4_bin = ? AND `j` = CAST(? AS JSON) LIMIT 1',
      );
      expect(plan.statements[0]!.readBack).toEqual({
        sql: 'SELECT `a`, `b`, `j` FROM `loose` WHERE `a` = ? AND `b` COLLATE utf8mb4_bin = ? AND `j` = CAST(? AS JSON) LIMIT 1',
        params: [1, 'y', '{"x": 1}'],
      });
    });
  });

  it('matches PostgreSQL citext exactly when finding a row by all its values', () => {
    const table = tableDefSchema.parse({
      name: 'tags',
      columns: [{ name: 'label', ordinal: 1, dataType: 'public.citext', nullable: false }],
    });
    const identity = allColumnsIdentity(table, { dialect: 'postgres' });
    const plan = planChanges(ChangeSet.empty().delete(loaded(identity, { label: 'Go' })), {
      dialect: 'postgres',
      table: { name: 'tags' },
      columns: describeColumns(table, { dialect: 'postgres' }),
      identity,
    });
    expect(plan.statements[0]!.sql).toContain('WHERE "label"::text = $1 LIMIT 1');
  });

  it('refuses edits without an identity but allows inserts', () => {
    const { columns } = itemsFor('postgres');
    const none: RowIdentity = { kind: 'none', columns: [] };
    const row = { key: 'k', values: { name: 'a' } };
    expect(() =>
      planChanges(ChangeSet.empty().edit(row, 'name', 'b'), {
        dialect: 'postgres',
        table: { name: 'items' },
        columns,
        identity: none,
      }),
    ).toThrow(/no primary or unique key/);
    const plan = planChanges(ChangeSet.empty().insert({ name: 'x' }), {
      dialect: 'postgres',
      table: { name: 'items' },
      columns,
      identity: none,
    });
    expect(plan.statements).toHaveLength(1);
  });

  it('refuses writes to generated columns except DEFAULT, unknown columns and unloaded keys', () => {
    const { table, columns } = itemsFor('postgres');
    const identity = rowIdentity(table);
    const row = loaded(identity, { region: 'eu', id: 1, total: '5' });
    const plan = (changes: ChangeSet) =>
      planChanges(changes, { dialect: 'postgres', table: { name: 'items' }, columns, identity });
    expect(() => plan(ChangeSet.empty().edit(row, 'total', '6'))).toThrow(
      /total cannot be edited: The column is generated/,
    );
    expect(plan(ChangeSet.empty().edit(row, 'total', DEFAULT)).statements[0]!.sql).toContain(
      'SET "total" = DEFAULT',
    );
    expect(() => plan(ChangeSet.empty().insert({ total: '1' }))).toThrow(/total cannot be set/);
    expect(() => plan(ChangeSet.empty().edit(row, 'nope', 1))).toThrow(/Unknown column nope/);
    const partial = { key: 'p', values: { region: 'eu' } };
    expect(() => plan(ChangeSet.empty().edit(partial, 'name', 'x'))).toThrow(
      /key column id was not loaded/,
    );
  });

  it('plans nothing for an empty change set', () => {
    const { table, columns } = itemsFor('mysql');
    const plan = planChanges(ChangeSet.empty(), {
      dialect: 'mysql',
      table: { name: 'items' },
      columns,
      identity: rowIdentity(table),
    });
    expect(plan.statements).toEqual([]);
    expect(plan.previewSql).toBe('');
  });
});
