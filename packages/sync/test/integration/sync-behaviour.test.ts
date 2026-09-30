import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import type { CheckDef, IndexDef, SchemaSnapshot, Session } from '@joinery/core';
import { describe, expect, it } from 'vitest';

import { compareSchemas, generateScript, setAllSelected } from '../../src';
import type { CompareOptions } from '../../src';
import {
  configuredServers,
  dialectOf,
  query,
  runSqlFile,
  runStatements,
  ScratchDatabases,
} from './helpers';
import { describeOperations } from './structure';

/**
 * Structure sync results the round trip's re-compare cannot see by itself: deployed objects
 * still work (MySQL triggers after column and table renames), and a hand-written source (a
 * model file, the table designer) converges with what the server reads back for it.
 */

const servers = configuredServers();
const mysqlFamily = servers.filter((s) => s.engine !== 'postgres');
const postgres = servers.filter((s) => s.engine === 'postgres');

function fixture(name: string, file: string): string {
  return readFileSync(fileURLToPath(new URL(`../golden/${name}/${file}`, import.meta.url)), 'utf8');
}

/** Compares, deploys every operation, and requires a clean re-compare. */
async function syncAll(
  source: Session,
  target: Session,
  options: CompareOptions = {},
): Promise<void> {
  const sourceSnapshot = await source.introspect();
  const { diff } = compareSchemas(sourceSnapshot, await target.introspect(), options);
  const script = generateScript(setAllSelected(diff, true));
  await runStatements(target, script.statements);
  const after = compareSchemas(sourceSnapshot, await target.introspect(), options).diff;
  expect(after.operations, describeOperations(after)).toEqual([]);
}

describe('MySQL triggers follow column and table renames', () => {
  if (mysqlFamily.length === 0)
    it.skip('no MySQL-family JOINERY_TEST_*_URL is set', () => undefined);

  for (const server of mysqlFamily) {
    it(`re-creates triggers whose bodies use renamed names, and they fire (${server.engine})`, async () => {
      const name = 'my-renames-triggers';
      const scratch = new ScratchDatabases(server);
      try {
        const source = await scratch.create('trg_src');
        const target = await scratch.create('trg_tgt');
        await runSqlFile(source, fixture(name, 'source.sql'), dialectOf(server.engine));
        await runSqlFile(target, fixture(name, 'target.sql'), dialectOf(server.engine));
        const options = JSON.parse(fixture(name, 'options.json')) as CompareOptions;
        await syncAll(source, target, options);

        await runStatements(target, [
          'INSERT INTO items (id, quantity, price) VALUES (1, 3, 2.50)',
          'UPDATE items SET quantity = -4 WHERE id = 1',
        ]);
        expect(await query(target, 'SELECT quantity, total FROM items')).toEqual([[0, '0.00']]);
        const history = await query(
          target,
          'SELECT item_id, quantity, logged_at FROM item_history',
        );
        expect(history).toEqual([[1, 3, '2000-01-01 00:00:00']]);
      } finally {
        await scratch.dropAll();
      }
    });
  }
});

describe('hand-written PostgreSQL checks and indexes converge', () => {
  if (postgres.length === 0) it.skip('JOINERY_TEST_POSTGRES_URL is not set', () => undefined);

  const checks: CheckDef[] = [
    { name: 'products_price_positive', expression: 'price > 0' },
    { name: 'products_price_floor', expression: 'price >= -1' },
    { name: 'products_ratio_min', expression: 'ratio >= 0.5' },
    { name: 'products_ratio_neg', expression: 'ratio > -2.5' },
    { name: 'products_available', expression: "available_from > '2020-01-01'" },
    { name: 'products_big', expression: 'big < 3000000000' },
    { name: 'products_mood', expression: "mood <> 'bad'" },
  ];
  const index = (name: string, part: IndexDef['columns'][number], where?: string): IndexDef => ({
    name,
    columns: [part],
    unique: false,
    method: 'btree',
    include: [],
    invisible: false,
    ...(where !== undefined ? { where } : {}),
  });
  const indexes: IndexDef[] = [
    index('products_price_idx', { name: 'price', order: 'asc' }, 'price > 0'),
    index('products_double_idx', { name: null, expression: 'price * 2', order: 'asc' }),
    index(
      'products_recent_idx',
      { name: 'available_from', order: 'asc' },
      "available_from > '2024-01-01'",
    ),
  ];

  /** The live schema with the hand-written checks and indexes added to products. */
  function handWritten(live: SchemaSnapshot): SchemaSnapshot {
    return {
      ...live,
      schemas: live.schemas.map((schema) => ({
        ...schema,
        tables: schema.tables.map((t) =>
          t.name === 'products' ? { ...t, checks: [...t.checks, ...checks], indexes } : t,
        ),
      })),
    };
  }

  for (const server of postgres) {
    it('deploys them and reads them back with no differences', async () => {
      const scratch = new ScratchDatabases(server);
      try {
        const target = await scratch.create('casts');
        await runStatements(target, [
          "CREATE TYPE mood AS ENUM ('ok', 'bad')",
          'CREATE TABLE products (id integer PRIMARY KEY, price numeric(10,2) NOT NULL, ratio double precision, available_from date, big bigint, mood mood)',
        ]);
        const source = handWritten(await target.introspect());
        const { diff } = compareSchemas(source, await target.introspect());
        expect(diff.operations.length).toBe(checks.length + indexes.length);
        await runStatements(target, generateScript(setAllSelected(diff, true)).statements);

        const deployed = await target.introspect();
        const products = deployed.schemas[0]!.tables.find((t) => t.name === 'products')!;
        // Not vacuous: the server spells them with casts.
        expect(products.checks.map((c) => c.expression)).toContain('((price > (0)::numeric))');
        const after = compareSchemas(source, deployed).diff;
        expect(after.operations, describeOperations(after)).toEqual([]);
        const back = compareSchemas(deployed, source).diff;
        expect(back.operations, describeOperations(back)).toEqual([]);
      } finally {
        await scratch.dropAll();
      }
    });
  }
});
