import { randomBytes } from 'node:crypto';

import type { CellValue, Session } from '@querybara/core';
import type { MongoSession } from '@querybara/driver-mongodb';
import {
  Binary,
  Decimal128,
  Double,
  EJSON,
  Int32,
  Long,
  ObjectId,
  UUID,
  toEjson,
  type BsonDocument,
} from '@querybara/mongo-tools';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { planDbTransfer, runDbTransfer, type DbTransferSpec } from '../../src';
import { MONGO_URL, connectMongo, opener, scratch, server, type Scratch } from './db-helpers';
import { query, type TestServer } from './helpers';

/**
 * SQL ↔ MongoDB transfers against the real servers (spec §12): rows become typed documents
 * with child rows embedded through a foreign key; documents flatten into tables with child
 * tables for arrays of sub-documents and JSON columns for the rest.
 */

const PG = server('postgres');
const MYSQL = server('mysql');
const SQL_TARGETS = [PG, MYSQL].filter((s): s is TestServer => s !== undefined);

async function documents(
  session: MongoSession,
  db: string,
  collection: string,
): Promise<BsonDocument[]> {
  const out: BsonDocument[] = [];
  for await (const page of session.find({ db, collection }, { sort: '{"_id": 1}' })) {
    for (const text of page.documents)
      out.push(EJSON.parse(text, { relaxed: false }) as BsonDocument);
  }
  return out;
}

describe.skipIf(!MONGO_URL || SQL_TARGETS.length === 0)('SQL ↔ MongoDB', () => {
  const db = `jdt_${randomBytes(4).toString('hex')}`;
  let mongo: MongoSession;
  const made: Scratch[] = [];

  beforeAll(async () => {
    mongo = (await connectMongo(db)) as MongoSession;
  });

  afterAll(async () => {
    await mongo?.dropDatabase(db).catch(() => undefined);
    await mongo?.close();
    for (const scratchDb of made) await scratchDb.drop().catch(() => undefined);
  });

  it.skipIf(!PG)(
    'turns PostgreSQL rows into typed documents with the orders embedded',
    async () => {
      const source = await scratch(PG!, 'to_mongo');
      made.push(source);
      const session = await source.connect();
      try {
        for (const statement of [
          `CREATE TABLE customers (
          id serial PRIMARY KEY,
          name text NOT NULL,
          balance numeric(12,2),
          visits bigint,
          joined timestamp(3) with time zone,
          avatar bytea,
          prefs jsonb,
          active boolean,
          tags text[],
          ref uuid
        )`,
          `CREATE UNIQUE INDEX customers_name_idx ON customers (name)`,
          `CREATE TABLE orders (
          id integer PRIMARY KEY,
          customer_id integer NOT NULL REFERENCES customers (id),
          total numeric(10,2),
          placed date
        )`,
          `INSERT INTO customers VALUES
          (1, 'Ada', 12.50, 9007199254740993, '2024-01-02 03:04:05.123+00', '\\x00ff', '{"theme": "dark", "n": [1, 2]}', true, '{a,b}', '0b5e4b9c-6f1e-4c8e-9d7a-2a1c3e4f5a6b'),
          (2, 'Grüße 😀', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL)`,
          `INSERT INTO orders VALUES (11, 1, 5.25, '2024-03-01'), (10, 1, 7.00, '2024-02-01')`,
        ]) {
          await query(session, statement);
        }
      } finally {
        await session.close();
      }
      const spec: DbTransferSpec = {
        source: {},
        target: { database: db },
        objects: [
          {
            name: 'customers',
            embed: [{ table: 'orders', foreignKey: 'orders_customer_id_fkey', field: 'orders' }],
            columns: [{ source: 'visits', dataType: 'long' }],
          },
        ],
      };
      const src = await source.connect();
      try {
        const plan = await planDbTransfer({ spec, source: src, target: mongo });
        expect(plan.problems).toEqual([]);
        expect(plan.tables[0]!.embeds).toEqual([
          { table: 'orders', field: 'orders', foreignKey: 'orders_customer_id_fkey' },
        ]);
        expect(
          Object.fromEntries(plan.tables[0]!.columns.map((c) => [c.source, c.targetType])),
        ).toMatchObject({
          id: 'int',
          balance: 'decimal',
          joined: 'date',
          avatar: 'binData',
          prefs: 'json',
          active: 'bool',
          tags: 'json',
          ref: 'uuid',
        });
      } finally {
        await src.close();
      }
      const summary = await runDbTransfer({
        spec,
        source: opener(() => source.connect()),
        target: opener(() => connectMongo(db)),
      });
      expect(summary.errors).toEqual([]);
      expect(summary.status).toBe('completed');
      const docs = await documents(mongo, db, 'customers');
      expect(docs).toHaveLength(2);
      expect(toEjson(docs[0])).toBe(
        toEjson({
          _id: new Int32(1),
          name: 'Ada',
          balance: Decimal128.fromString('12.50'),
          visits: Long.fromString('9007199254740993'),
          joined: new Date('2024-01-02T03:04:05.123Z'),
          avatar: new Binary(Uint8Array.from([0, 255])),
          // jsonb keeps keys shortest first.
          prefs: { n: [1, 2], theme: 'dark' },
          active: true,
          tags: ['a', 'b'],
          ref: new UUID('0b5e4b9c-6f1e-4c8e-9d7a-2a1c3e4f5a6b'),
          orders: [
            {
              id: new Int32(10),
              total: Decimal128.fromString('7.00'),
              placed: new Date('2024-02-01T00:00:00Z'),
            },
            {
              id: new Int32(11),
              total: Decimal128.fromString('5.25'),
              placed: new Date('2024-03-01T00:00:00Z'),
            },
          ],
        }),
      );
      expect(docs[1]!['name']).toBe('Grüße 😀');
      expect(docs[1]!['balance']).toBeNull();
      expect(docs[1]!['orders']).toEqual([]);
      const indexes = await mongo.listIndexes({ db, collection: 'customers' });
      expect(indexes.map((i) => [i.name, i.unique])).toContainEqual(['customers_name_idx', true]);

      // Appending the same rows again fails on _id; with skip each row is logged and the rest kept.
      const again = await runDbTransfer({
        spec: { ...spec, options: { mode: 'append', onError: 'skip' } },
        source: opener(() => source.connect()),
        target: opener(() => connectMongo(db)),
      });
      expect(again.status).toBe('completed');
      expect(again.rowsSkipped).toBe(2);
      expect(again.errors.map((e) => e.row)).toEqual([1, 2]);
      expect(again.errors[0]?.message).toMatch(/duplicate/i);
    },
  );

  it.skipIf(!MYSQL)(
    'writes MySQL rows with a new ObjectId when the key has several columns',
    async () => {
      const source = await scratch(MYSQL!, 'my_to_mongo');
      made.push(source);
      const session = await source.connect();
      try {
        await query(
          session,
          'CREATE TABLE pairs (a int, b int, flag tinyint(1), at datetime(3), PRIMARY KEY (a, b))',
        );
        await query(
          session,
          "INSERT INTO pairs VALUES (1, 2, 1, '2024-05-06 07:08:09.010'), (1, 3, 0, NULL)",
        );
      } finally {
        await session.close();
      }
      const summary = await runDbTransfer({
        spec: { source: {}, target: { database: db }, objects: [{ name: 'pairs' }] },
        source: opener(() => source.connect()),
        target: opener(() => connectMongo(db)),
      });
      expect(summary.status).toBe('completed');
      const docs = (await documents(mongo, db, 'pairs')).sort(
        (x, y) => Number(x['b']) - Number(y['b']),
      );
      expect(docs[0]!['_id']).toBeInstanceOf(ObjectId);
      expect(docs[0]!['flag']).toBe(true);
      expect(docs[0]!['at']).toEqual(new Date('2024-05-06T07:08:09.010Z'));
      expect(docs[1]!['flag']).toBe(false);
      const indexes = await mongo.listIndexes({ db, collection: 'pairs' });
      expect(indexes.find((i) => i.name === 'pairs_pk')?.unique).toBe(true);
    },
  );

  describe('MongoDB → SQL', () => {
    const collection = 'people';
    const ids = [new ObjectId(), new ObjectId(), new ObjectId()];

    beforeAll(async () => {
      await mongo.insertMany(
        { db, collection },
        toEjson([
          {
            _id: ids[0],
            name: 'Ada',
            age: new Int32(36),
            score: new Double(9.5),
            big: Long.fromString('9007199254740993'),
            price: Decimal128.fromString('12.50'),
            born: new Date('1815-12-10T00:00:00Z'),
            address: { city: 'London', 'zip code': 'N1' },
            tags: ['a', 'b'],
            items: [
              { sku: 'x1', qty: new Int32(2) },
              { sku: 'x2', qty: new Int32(1), note: 'gift' },
            ],
            active: true,
            uid: new UUID('0b5e4b9c-6f1e-4c8e-9d7a-2a1c3e4f5a6b'),
            bin: new Binary(Uint8Array.from([1, 2, 3])),
            mixed: 'text',
          },
          { _id: ids[1], name: 'Grace', address: { city: 'New York' }, items: [], mixed: { a: 1 } },
          { _id: ids[2], name: null, items: [{ sku: 'y', qty: new Int32(5) }] },
        ]),
      );
    });

    for (const target of SQL_TARGETS) {
      it(`flattens documents into ${target.engine} with a child table for items`, async () => {
        const into = await scratch(target, `mongo_to_${target.engine}`);
        made.push(into);
        const spec: DbTransferSpec = {
          source: { database: db },
          target: {},
          objects: [{ name: collection, columns: [{ source: 'tags', shape: 'json' }] }],
        };
        const sql = await into.connect();
        try {
          const plan = await planDbTransfer({ spec, source: mongo, target: sql });
          expect(plan.problems).toEqual([]);
          expect(plan.tables.map((t) => [t.target, t.kind])).toEqual([
            ['people', 'table'],
            ['people_items', 'child-table'],
          ]);
          const summary = await runDbTransfer({
            spec,
            source: opener(() => connectMongo(db)),
            target: opener(() => into.connect()),
          });
          expect(summary.errors).toEqual([]);
          expect(summary.status).toBe('completed');
          expect(summary.tables.map((t) => [t.target, t.rowsWritten])).toEqual(
            expect.arrayContaining([
              ['people', 3],
              ['people_items', 3],
            ]),
          );
          const pg = target.engine === 'postgres';
          const people = await query(
            sql,
            `SELECT _id, name, age, score, big, ${pg ? 'price::text' : 'price'}, ${pg ? "to_char(born AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')" : 'born'}, address_city, address_zip_code, tags, active, uid, bin, mixed FROM people ORDER BY _id`,
          );
          const [ada, grace, anon] = people as [CellValue[], CellValue[], CellValue[]];
          expect(ada.slice(0, 5)).toEqual([
            ids[0]!.toHexString(),
            'Ada',
            36,
            9.5,
            9007199254740993n,
          ]);
          expect(String(ada[5])).toMatch(/^12\.50*$/);
          expect(String(ada[6])).toMatch(/^1815-12-10 00:00:00/);
          expect(ada.slice(7, 9)).toEqual(['London', 'N1']);
          expect(JSON.parse(String(ada[9]))).toEqual(['a', 'b']);
          expect(ada[10]).toBe(pg ? true : 1);
          expect(ada[11]).toBe('0b5e4b9c-6f1e-4c8e-9d7a-2a1c3e4f5a6b');
          expect(ada[12]).toEqual(Uint8Array.from([1, 2, 3]));
          // A field that is a string here and a document there is kept as JSON.
          expect(JSON.parse(String(ada[13]))).toBe('text');
          expect(JSON.parse(String(grace[13]))).toEqual({ a: 1 });
          expect(grace[7]).toBe('New York');
          expect(anon[1]).toBeNull();
          const items = await query(
            sql,
            'SELECT people_id, position, sku, qty, note FROM people_items ORDER BY people_id, position',
          );
          expect(items).toEqual([
            [ids[0]!.toHexString(), 0, 'x1', 2, null],
            [ids[0]!.toHexString(), 1, 'x2', 1, 'gift'],
            [ids[2]!.toHexString(), 0, 'y', 5, null],
          ]);
          // The child table's foreign key to the parent exists.
          await expect(
            query(
              sql,
              "INSERT INTO people_items (people_id, position, sku) VALUES ('nope', 0, 'z')",
            ),
          ).rejects.toThrow(/foreign key/i);
        } finally {
          await sql.close();
        }
      });
    }

    it.skipIf(!PG)(
      'keeps an array as a JSON column and a sub-document whole when asked',
      async () => {
        const into = await scratch(PG!, 'mongo_json');
        made.push(into);
        const summary = await runDbTransfer({
          spec: {
            source: { database: db },
            target: {},
            objects: [
              {
                name: collection,
                target: 'flat',
                columns: [
                  { source: 'items', shape: 'json' },
                  { source: 'address', shape: 'json' },
                  { source: 'big', skip: true },
                ],
              },
            ],
          },
          source: opener(() => connectMongo(db)),
          target: opener(() => into.connect()),
        });
        expect(summary.status).toBe('completed');
        const sql: Session = await into.connect();
        try {
          const rows = await query(sql, 'SELECT items::text, address::text FROM flat ORDER BY _id');
          expect(JSON.parse(String(rows[0]![0]))).toEqual([
            { sku: 'x1', qty: 2 },
            { sku: 'x2', qty: 1, note: 'gift' },
          ]);
          expect(JSON.parse(String(rows[0]![1]))).toEqual({ city: 'London', 'zip code': 'N1' });
          const columns = await query(
            sql,
            "SELECT column_name FROM information_schema.columns WHERE table_name = 'flat' ORDER BY ordinal_position",
          );
          expect(columns.flat()).not.toContain('big');
        } finally {
          await sql.close();
        }
      },
    );
  });
});
