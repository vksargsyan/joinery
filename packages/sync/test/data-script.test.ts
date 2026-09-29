import { describe, expect, it } from 'vitest';

import { DataSyncScriptBuilder, generateDataSyncScript, sqlLiteral, tokenizeSql } from '../src';
import type { DataSyncOptions, RowDiff } from '../src';

describe('sqlLiteral', () => {
  it('writes every cell value kind for PostgreSQL', () => {
    expect(sqlLiteral(null, 'postgres')).toBe('NULL');
    expect(sqlLiteral(true, 'postgres')).toBe('TRUE');
    expect(sqlLiteral(false, 'postgres')).toBe('FALSE');
    expect(sqlLiteral(42, 'postgres')).toBe('42');
    expect(sqlLiteral(-1.5e-7, 'postgres')).toBe('-1.5e-7');
    expect(sqlLiteral(12345678901234567890n, 'postgres')).toBe('12345678901234567890');
    expect(sqlLiteral(Number.NaN, 'postgres')).toBe("'NaN'::float8");
    expect(sqlLiteral(Number.NEGATIVE_INFINITY, 'postgres')).toBe("'-Infinity'::float8");
    expect(sqlLiteral(new Uint8Array([0, 1, 254]), 'postgres')).toBe("'\\x0001fe'::bytea");
    expect(sqlLiteral(new Uint8Array([]), 'postgres')).toBe("'\\x'::bytea");
    expect(sqlLiteral("it's", 'postgres')).toBe("'it''s'");
    expect(sqlLiteral(1, 'postgres', 'boolean')).toBe('TRUE');
    expect(sqlLiteral('0', 'postgres', 'boolean')).toBe('FALSE');
  });

  it('writes every cell value kind for MySQL and MariaDB', () => {
    expect(sqlLiteral(true, 'mysql')).toBe('1');
    expect(sqlLiteral(false, 'mariadb')).toBe('0');
    expect(sqlLiteral(new Uint8Array([0xde, 0xad]), 'mysql')).toBe("X'dead'");
    expect(sqlLiteral("a\\b\n'c", 'mysql')).toBe("'a\\\\b\\n''c'");
    expect(sqlLiteral(2n ** 64n, 'mariadb')).toBe('18446744073709551616');
    expect(() => sqlLiteral(Number.NaN, 'mysql')).toThrow(/cannot store/);
  });

  it('refuses large-value handles', () => {
    expect(() =>
      sqlLiteral({ $handle: 'x', preview: 'p', byteLength: 9, kind: 'text' }, 'postgres'),
    ).toThrow(/fetch it in full/);
  });

  it('keeps hostile strings inside one literal', () => {
    for (const dialect of ['postgres', 'mysql'] as const) {
      const literal = sqlLiteral("x'); DROP TABLE users; --\\'", dialect);
      const tokens = tokenizeSql(`SELECT ${literal}`, dialect).filter((t) => t.kind !== 'ws');
      expect(tokens.map((t) => t.kind)).toEqual(['word', 'string']);
    }
  });
});

const base: DataSyncOptions = {
  dialect: 'postgres',
  table: { schema: 'public', name: 'items' },
  keyColumns: ['id'],
  sourceColumns: ['id', 'name', 'qty'],
  targetColumns: ['id', 'name', 'qty'],
};

const diffs: RowDiff[] = [
  { action: 'insert', key: [4], sourceRow: [4, 'four', 4] },
  {
    action: 'update',
    key: [2],
    changedColumns: ['qty'],
    sourceRow: [2, 'two', 20],
    targetRow: [2, 'two', 2],
  },
  { action: 'delete', key: [3], targetRow: [3, 'three', 3] },
  { action: 'insert', key: [5], sourceRow: [5, null, 5] },
  { action: 'delete', key: [6], targetRow: [6, 'six', 6] },
];

describe('generateDataSyncScript', () => {
  it('batches deletes, then updates, then inserts in one transaction', () => {
    const script = generateDataSyncScript(diffs, base);
    expect(script.statements).toEqual([
      'BEGIN',
      'DELETE FROM "public"."items" WHERE "id" IN (3, 6)',
      'UPDATE "public"."items" SET "qty" = 20 WHERE "id" = 2',
      `INSERT INTO "public"."items" ("id", "name", "qty") VALUES\n(4, 'four', 4),\n(5, NULL, 5)`,
      'COMMIT',
    ]);
    expect(script.counts).toEqual({ insert: 2, update: 1, delete: 2 });
    expect(script.text.endsWith('COMMIT;\n')).toBe(true);
  });

  it('respects selected actions, ignored columns and batch size', () => {
    const script = generateDataSyncScript(diffs, {
      ...base,
      dialect: 'mysql',
      table: { name: 'items' },
      actions: { delete: false },
      ignoreColumns: ['name'],
      batchSize: 1,
      transaction: false,
    });
    expect(script.statements).toEqual([
      'UPDATE `items` SET `qty` = 20 WHERE `id` = 2',
      'INSERT INTO `items` (`id`, `qty`) VALUES\n(4, 4)',
      'INSERT INTO `items` (`id`, `qty`) VALUES\n(5, 5)',
    ]);
    expect(script.counts.delete).toBe(0);
  });

  it('matches composite keys with row-value IN lists and AND conditions', () => {
    const script = generateDataSyncScript(
      [
        { action: 'delete', key: [1, 'a'], targetRow: [1, 'a', 'x'] },
        { action: 'delete', key: [2, "b'"], targetRow: [2, "b'", 'y'] },
        {
          action: 'update',
          key: [3, 'c'],
          changedColumns: ['v'],
          sourceRow: [3, 'c', 'new'],
          targetRow: [3, 'c', 'old'],
        },
      ],
      {
        dialect: 'mariadb',
        table: { name: 'pairs' },
        keyColumns: ['k1', 'k2'],
        sourceColumns: ['k1', 'k2', 'v'],
        targetColumns: ['k1', 'k2', 'v'],
        disableForeignKeyChecks: true,
      },
    );
    expect(script.statements).toEqual([
      'START TRANSACTION',
      'SET FOREIGN_KEY_CHECKS = 0',
      "DELETE FROM `pairs` WHERE (`k1`, `k2`) IN ((1, 'a'), (2, 'b'''))",
      "UPDATE `pairs` SET `v` = 'new' WHERE `k1` = 3 AND `k2` = 'c'",
      'SET FOREIGN_KEY_CHECKS = 1',
      'COMMIT',
    ]);
  });

  it('coerces literals to target column kinds and disables triggers on PostgreSQL', () => {
    const script = generateDataSyncScript([{ action: 'insert', key: [1], sourceRow: [1, 1] }], {
      dialect: 'postgres',
      table: { schema: 'app', name: 'flags' },
      keyColumns: ['id'],
      sourceColumns: ['id', 'enabled'],
      targetColumns: ['id', 'enabled'],
      targetKinds: { id: 'integer', enabled: 'boolean' },
      disableTriggers: true,
    });
    expect(script.statements).toEqual([
      'BEGIN',
      'ALTER TABLE "app"."flags" DISABLE TRIGGER USER',
      'INSERT INTO "app"."flags" ("id", "enabled") VALUES\n(1, TRUE)',
      'ALTER TABLE "app"."flags" ENABLE TRIGGER USER',
      'COMMIT',
    ]);
  });

  it('streams statements as batches fill', () => {
    const builder = new DataSyncScriptBuilder({ ...base, batchSize: 2 });
    expect(builder.add(diffs[2]!)).toEqual([]);
    expect(builder.add(diffs[4]!)).toEqual(['DELETE FROM "public"."items" WHERE "id" IN (3, 6)']);
    expect(builder.add(diffs[0]!)).toEqual([]);
    expect(builder.flush()).toEqual([
      `INSERT INTO "public"."items" ("id", "name", "qty") VALUES\n(4, 'four', 4)`,
    ]);
    expect(builder.flush()).toEqual([]);
  });

  it('produces nothing for no differences', () => {
    expect(generateDataSyncScript([], base).statements).toEqual([]);
  });
});
