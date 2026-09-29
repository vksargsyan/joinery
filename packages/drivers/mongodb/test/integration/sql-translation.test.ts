import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { EJSON, exportQueryCode, sqlToMql, toEjson, toFindQuery } from '@joinery/mongo-tools';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { MongoSession } from '../../src';
import { MONGO_URL, connectMongo, drain, testDatabase } from './helpers';

/**
 * SQL to MQL against a real server (spec §9, §20): each statement is translated, run through
 * the session's find() or aggregate(), and its documents compared with what SQL returns for
 * the same rows, including rows where fields are null or missing.
 */

describe.skipIf(!MONGO_URL)('SQL to MQL on MongoDB (replica set)', () => {
  const db = testDatabase();
  let session: MongoSession;

  beforeAll(async () => {
    session = await connectMongo(MONGO_URL!);
    await session.insertMany(
      { db, collection: 'customers' },
      `[
        { _id: 1, name: 'Ada', city: 'London', address: { city: 'London', zip: 'N1' }, age: 36, vip: true, tags: ['a', 'b'] },
        { _id: 2, name: 'Bob', city: 'Paris', address: { city: 'Paris' }, age: 25, vip: false },
        { _id: 3, name: 'Cyd', city: null, age: null, vip: true },
        { _id: 4, name: 'Dee' },
        { _id: 5, name: 'eve', city: 'London', age: 41, vip: false, since: ISODate('2020-05-01T00:00:00Z') },
        { _id: 6, name: 'Fay', vip: true },
      ]`,
    );
    await session.insertMany(
      { db, collection: 'orders' },
      `[
        { _id: 101, customerId: 1, status: 'A', qty: 5, price: 2.5, item: 'pen', at: ISODate('2024-01-10T00:00:00Z') },
        { _id: 102, customerId: 1, status: 'B', qty: 1, price: 10, item: 'book' },
        { _id: 103, customerId: 2, status: 'A', qty: 3, price: 4, item: 'pencil' },
        { _id: 104, customerId: 9, status: 'A', qty: 7, price: 1 },
        { _id: 105, customerId: null, status: null, qty: 2 },
        { _id: 106, status: 'C', qty: 10, price: 3, item: '100% cotton' },
      ]`,
    );
    await session.insertMany(
      { db, collection: 'rates' },
      `[
        { _id: 1, item: 'pen', status: 'A', rate: 0.1 },
        { _id: 2, item: 'pen', status: 'B', rate: 0.2 },
        { _id: 3, item: 'book', status: 'B', rate: 0.3 },
      ]`,
    );
  });

  afterAll(async () => {
    await session?.dropDatabase(db).catch(() => undefined);
    await session?.close();
  });

  /** Runs a statement and returns its documents as relaxed JS values. */
  async function query(sql: string): Promise<unknown[]> {
    const translation = sqlToMql(sql);
    const ns = { db, collection: translation.collection };
    const pages =
      translation.kind === 'find'
        ? session.find(ns, toFindQuery(translation.query))
        : session.aggregate(ns, toEjson(translation.pipeline));
    const documents = await drain(pages);
    return documents.map((text) => EJSON.parse(text, { relaxed: true }));
  }

  const ids = async (sql: string) => (await query(sql)).map((doc) => (doc as { _id: unknown })._id);

  it('filters with SQL semantics for null and missing fields', async () => {
    expect(await query("SELECT name FROM customers WHERE city = 'London' ORDER BY name")).toEqual([
      { name: 'Ada' },
      { name: 'eve' },
    ]);
    // <>, NOT and NOT IN leave out null and missing, as SQL does.
    expect(await ids("SELECT _id FROM customers WHERE city <> 'London' ORDER BY _id")).toEqual([2]);
    expect(await ids("SELECT _id FROM customers WHERE NOT (city = 'London')")).toEqual([2]);
    expect(await ids('SELECT _id FROM customers WHERE age NOT IN (25, 36) ORDER BY 1')).toEqual([
      5,
    ]);
    expect(
      await ids('SELECT _id FROM customers WHERE NOT age BETWEEN 30 AND 40 ORDER BY _id'),
    ).toEqual([2, 5]);
    expect(await ids('SELECT _id FROM customers WHERE city IS NULL ORDER BY _id')).toEqual([
      3, 4, 6,
    ]);
    expect(await ids('SELECT _id FROM customers WHERE age IS NOT NULL ORDER BY _id')).toEqual([
      1, 2, 5,
    ]);
    expect(await ids('SELECT _id FROM customers WHERE vip ORDER BY _id')).toEqual([1, 3, 6]);
    expect(await ids('SELECT _id FROM customers WHERE NOT vip ORDER BY _id')).toEqual([2, 5]);
    expect(await ids('SELECT _id FROM customers WHERE vip IS NOT TRUE ORDER BY _id')).toEqual([
      2, 4, 5,
    ]);
    // An array field matches when any element does.
    expect(await ids("SELECT _id FROM customers WHERE tags = 'b'")).toEqual([1]);
  });

  it('matches LIKE case-sensitively and ILIKE without case', async () => {
    expect(await ids("SELECT _id FROM customers WHERE name LIKE 'E%'")).toEqual([]);
    expect(await ids("SELECT _id FROM customers WHERE name ILIKE 'E%'")).toEqual([5]);
    expect(await ids("SELECT _id FROM customers WHERE name LIKE '_d_' ORDER BY _id")).toEqual([1]);
    expect(await ids("SELECT _id FROM orders WHERE item LIKE '100\\% %'")).toEqual([106]);
    expect(await ids("SELECT _id FROM orders WHERE item NOT LIKE 'pen%' ORDER BY _id")).toEqual([
      102, 106,
    ]);
  });

  it('compares fields, dates and paths, sorts and pages', async () => {
    expect(await ids('SELECT _id FROM orders WHERE qty > price ORDER BY _id')).toEqual([
      101, 104, 106,
    ]);
    expect(await ids("SELECT _id FROM orders WHERE at >= DATE '2024-01-01'")).toEqual([101]);
    expect(
      await ids("SELECT _id FROM customers WHERE since < TIMESTAMP '2021-01-01 00:00:00'"),
    ).toEqual([5]);
    expect(await ids('SELECT _id FROM orders ORDER BY _id LIMIT 2 OFFSET 1')).toEqual([102, 103]);
    expect(await ids('SELECT _id FROM orders ORDER BY _id LIMIT 1, 2')).toEqual([102, 103]);
    expect(
      await query(
        'SELECT name, address.city AS town FROM customers WHERE address.city IS NOT NULL ORDER BY town DESC',
      ),
    ).toEqual([
      { name: 'Bob', town: 'Paris' },
      { name: 'Ada', town: 'London' },
    ]);
    expect(await query('SELECT address.zip FROM customers WHERE _id = 1')).toEqual([
      { address: { zip: 'N1' } },
    ]);
  });

  it('aggregates without GROUP BY, also over no rows', async () => {
    expect(
      await query(
        'SELECT COUNT(*) AS n, COUNT(age) AS aged, AVG(age) AS mean, SUM(age) AS total, MIN(age) AS youngest, MAX(name) AS last FROM customers',
      ),
    ).toEqual([{ n: 6, aged: 3, mean: 34, total: 102, youngest: 25, last: 'eve' }]);
    expect(
      await query(
        "SELECT COUNT(*) AS n, AVG(age) AS mean, SUM(age) AS total FROM customers WHERE name = 'nobody'",
      ),
    ).toEqual([{ n: 0, mean: null, total: 0 }]);
    expect(await query('SELECT COUNT(DISTINCT status) AS statuses FROM orders')).toEqual([
      { statuses: 3 },
    ]);
  });

  it('groups null and missing together and filters groups with HAVING', async () => {
    expect(
      await query('SELECT city, COUNT(*) AS n FROM customers GROUP BY city ORDER BY city'),
    ).toEqual([
      { city: null, n: 3 },
      { city: 'London', n: 2 },
      { city: 'Paris', n: 1 },
    ]);
    expect(
      await query(
        'SELECT city, vip, COUNT(*) AS n FROM customers GROUP BY city, vip ORDER BY city, vip',
      ),
    ).toEqual([
      { city: null, vip: null, n: 1 },
      { city: null, vip: true, n: 2 },
      { city: 'London', vip: false, n: 1 },
      { city: 'London', vip: true, n: 1 },
      { city: 'Paris', vip: false, n: 1 },
    ]);
    expect(
      await query(
        'SELECT city, COUNT(*) AS n FROM customers GROUP BY city HAVING COUNT(*) > 1 ORDER BY n DESC',
      ),
    ).toEqual([
      { city: null, n: 3 },
      { city: 'London', n: 2 },
    ]);
    expect(await query('SELECT DISTINCT status FROM orders ORDER BY status')).toEqual([
      { status: null },
      { status: 'A' },
      { status: 'B' },
      { status: 'C' },
    ]);
  });

  it('joins with $lookup', async () => {
    expect(
      await query(
        'SELECT c.name, o.item FROM customers c JOIN orders o ON o.customerId = c._id ORDER BY o._id',
      ),
    ).toEqual([
      { name: 'Ada', o: { item: 'pen' } },
      { name: 'Ada', o: { item: 'book' } },
      { name: 'Bob', o: { item: 'pencil' } },
    ]);
    // Customers without orders: LEFT JOIN and IS NULL.
    expect(
      await query(
        'SELECT c.name FROM customers c LEFT JOIN orders o ON c._id = o.customerId WHERE o._id IS NULL ORDER BY c.name',
      ),
    ).toEqual([{ name: 'Cyd' }, { name: 'Dee' }, { name: 'Fay' }, { name: 'eve' }]);
    // A condition in ON filters the joined collection only; COUNT(x) counts matches.
    expect(
      await query(
        "SELECT c.name, COUNT(o._id) AS orders FROM customers c LEFT JOIN orders o ON c._id = o.customerId AND o.status = 'A' GROUP BY c.name ORDER BY c.name LIMIT 3",
      ),
    ).toEqual([
      { name: 'Ada', orders: 1 },
      { name: 'Bob', orders: 1 },
      { name: 'Cyd', orders: 0 },
    ]);
    expect(
      await query(
        'SELECT c.name, SUM(o.qty) AS qty FROM customers c JOIN orders o ON o.customerId = c._id GROUP BY c.name ORDER BY qty DESC',
      ),
    ).toEqual([
      { name: 'Ada', qty: 6 },
      { name: 'Bob', qty: 3 },
    ]);
    // ON with two equalities uses let / pipeline.
    expect(
      await query(
        'SELECT o._id AS id, r.rate FROM orders o JOIN rates r ON r.item = o.item AND r.status = o.status ORDER BY o._id',
      ),
    ).toEqual([
      { id: 101, r: { rate: 0.1 } },
      { id: 102, r: { rate: 0.3 } },
    ]);
  });

  it('exports a translated query as a Node.js program that runs', () => {
    const translation = sqlToMql('SELECT name FROM customers WHERE vip ORDER BY name');
    const dir = mkdtempSync(join(tmpdir(), 'joinery-sql-export-'));
    try {
      const file = join(dir, 'query.js');
      writeFileSync(file, exportQueryCode(translation, 'node', { database: db }));
      const result = spawnSync(process.execPath, [file], {
        encoding: 'utf8',
        timeout: 60_000,
        env: {
          ...process.env,
          MONGODB_URI: MONGO_URL!,
          // The script requires 'mongodb': resolve it from this package.
          NODE_PATH: fileURLToPath(new URL('../../node_modules', import.meta.url)),
        },
      });
      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);
      expect(result.stdout.trim().split('\n')).toEqual([
        "{ name: 'Ada' }",
        "{ name: 'Cyd' }",
        "{ name: 'Fay' }",
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
