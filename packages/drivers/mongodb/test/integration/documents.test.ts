import {
  EJSON,
  parseShellDocument,
  toEjson,
  toFindQuery,
  toJsonSchema,
} from '@joinery/mongo-tools';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { MongoSession } from '../../src';
import { MONGO_URL, connectMongo, drain, testDatabase } from './helpers';

describe.skipIf(!MONGO_URL)('MongoDB document services (replica set)', () => {
  const db = testDatabase();
  const orders = { db, collection: 'orders' };
  let session: MongoSession;

  beforeAll(async () => {
    session = await connectMongo(MONGO_URL!);
    const rows = Array.from(
      { length: 300 },
      (_, i) =>
        `{ _id: ${i}, status: '${i % 3 === 0 ? 'A' : 'B'}', cust: 'c${i % 10}', amount: NumberDecimal('${i}.50'), qty: NumberLong(${i}), price: ${i + 0.25}, at: ISODate('2024-01-01T00:00:00Z'), tags: ['t${i % 4}'], sub: { k: ${i % 5} } }`,
    );
    await session.insertMany(orders, `[${rows.join(',')}]`);
  });

  afterAll(async () => {
    await session?.dropDatabase(db).catch(() => undefined);
    await session?.close();
  });

  it('finds with filter, projection, sort, skip, limit and collation, in pages', async () => {
    const query = toFindQuery({
      filter: parseShellDocument("{ status: 'A', qty: { $gte: NumberLong(30) } }"),
      projection: parseShellDocument('{ status: 1, qty: 1, amount: 1 }'),
      sort: parseShellDocument('{ qty: -1 }'),
      skip: 2,
      limit: 25,
      collation: parseShellDocument("{ locale: 'en' }"),
    });
    const pages: number[] = [];
    const docs: string[] = [];
    for await (const page of session.find(orders, query, { pageSize: 10 })) {
      pages.push(page.documents.length);
      docs.push(...page.documents);
    }
    expect(pages).toEqual([10, 10, 5]);
    const first = EJSON.parse(docs[0]!, { relaxed: false }) as Record<string, unknown>;
    expect(Object.keys(first)).toEqual(['_id', 'status', 'amount', 'qty']);
    // Types survive: Int64 stays $numberLong and Decimal128 stays $numberDecimal.
    expect(docs[0]).toContain('"qty":{"$numberLong":"291"}');
    expect(docs[0]).toContain('"amount":{"$numberDecimal":"291.50"}');
  });

  it('counts exactly and by estimate', async () => {
    expect(await session.count(orders, `{ "status": "A" }`)).toBe(100);
    expect(await session.count(orders)).toBe(300);
    expect(await session.estimatedCount(orders)).toBe(300);
  });

  it('aggregates in pages and previews a stage on a sample', async () => {
    const pipeline = `[{ $match: { status: 'B' } }, { $group: { _id: '$cust', n: { $sum: 1 } } }, { $sort: { _id: 1 } }, { $out: 'totals' }]`;
    const all = await drain(
      session.aggregate(orders, pipeline.replace(", { $out: 'totals' }", ''), { pageSize: 3 }),
    );
    expect(all).toHaveLength(10);
    const preview = await session.previewStage(orders, pipeline, 3, { sampleSize: 30, limit: 5 });
    expect(preview.documents).toHaveLength(5);
    expect(preview.skippedStages).toEqual([3]);
    expect(preview.pipeline).toContain('"$limit":{"$numberInt":"30"}');
    // $out was left out: the preview wrote nothing.
    await expect(session.collectionInfo({ db, collection: 'totals' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    const disabled = await session.previewStage(orders, pipeline, 1, {
      disabled: [0],
      sampleSize: 300,
    });
    expect(disabled.documents).toHaveLength(10);
  });

  it('inserts, replaces with conflict detection, and deletes', async () => {
    const items = { db, collection: 'items' };
    const { insertedId } = await session.insertOne(items, `{ name: 'first', n: NumberInt(1) }`);
    expect(insertedId).toMatch(/^\{"\$oid":"[0-9a-f]{24}"\}$/);
    const [stored] = await drain(session.find(items, { filter: `{ "_id": ${insertedId} }` }));
    const edited = { ...(EJSON.parse(stored!, { relaxed: false }) as object), name: 'edited' };
    const replaced = await session.replaceOne(items, stored!, toEjson(edited));
    expect(replaced).toMatchObject({ matchedCount: 1, modifiedCount: 1 });

    // A second edit based on the stale version conflicts and reports the current document.
    const stale = { ...(EJSON.parse(stored!, { relaxed: false }) as object), name: 'stale' };
    const conflict = await session
      .replaceOne(items, stored!, toEjson(stale))
      .catch((e: unknown) => e);
    expect(conflict).toMatchObject({ code: 'CONFLICT' });
    expect((conflict as { detail: string }).detail).toContain('"name":"edited"');

    await expect(
      session.replaceOne(items, stored!, toEjson({ ...edited, _id: 5 })),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });

    const dry = await session.deleteOne(items, insertedId, { dryRun: true });
    expect(dry).toMatchObject({ dryRun: true, matchedCount: 1, deletedCount: 0 });
    expect(await session.deleteOne(items, insertedId)).toMatchObject({ deletedCount: 1 });
    await expect(session.replaceOne(items, toEjson(edited), toEjson(edited))).rejects.toMatchObject(
      {
        code: 'NOT_FOUND',
      },
    );
  });

  it('updates and deletes many, with a dry run of the matched count first', async () => {
    const bulk = { db, collection: 'bulk' };
    await session.insertMany(
      bulk,
      `[${Array.from({ length: 50 }, (_, i) => `{ i: ${i} }`).join(',')}]`,
    );
    const dry = await session.updateMany(
      bulk,
      '{ "i": { "$lt": 20 } }',
      '{ "$set": { "flag": true } }',
      { dryRun: true },
    );
    expect(dry).toEqual({ dryRun: true, matchedCount: 20, modifiedCount: 0, deletedCount: 0 });
    expect(await session.count(bulk, '{ "flag": true }')).toBe(0);
    const done = await session.updateMany(
      bulk,
      '{ "i": { "$lt": 20 } }',
      '{ "$set": { "flag": true } }',
    );
    expect(done).toMatchObject({ dryRun: false, matchedCount: 20, modifiedCount: 20 });
    const pipelineUpdate = await session.updateMany(
      bulk,
      '{}',
      `[{ $set: { double: { $multiply: ['$i', 2] } } }]`,
    );
    expect(pipelineUpdate.modifiedCount).toBe(50);
    await expect(session.updateMany(bulk, '{}', '{ "flag": false }')).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    const upsert = await session.updateMany(bulk, '{ "i": 999 }', '{ "$set": { "u": 1 } }', {
      upsert: true,
    });
    expect(upsert.upsertedId).toMatch(/\$oid/);
    expect(await session.deleteMany(bulk, '{ "flag": true }', { dryRun: true })).toMatchObject({
      matchedCount: 20,
    });
    expect(await session.deleteMany(bulk, '{ "flag": true }')).toMatchObject({ deletedCount: 20 });
    expect(await session.count(bulk)).toBe(31);
  });

  it('surfaces JSON Schema validation failures with the rule and field', async () => {
    const people = { db, collection: 'people' };
    await session.createCollection(people, {
      validator: `{ "$jsonSchema": { "bsonType": "object", "required": ["name"], "properties": { "age": { "bsonType": "int", "minimum": 0 } } } }`,
      validationLevel: 'strict',
      validationAction: 'error',
    });
    const error = await session.insertOne(people, `{ age: 'old' }`).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'VALIDATION_FAILED', engineCode: 121 });
    const detail = (error as { detail: string }).detail;
    expect(detail).toContain('missing required field: name');
    expect(detail).toContain('age: bsonType int expected, got string');
    const many = await session
      .insertMany(
        people,
        `[{ name: 'ok', age: NumberInt(3) }, { name: 'bad', age: NumberInt(-1) }]`,
      )
      .catch((e: unknown) => e);
    expect(many).toMatchObject({ code: 'VALIDATION_FAILED' });
    expect((many as Error).message).toContain('document 2');
    expect((many as { detail: string }).detail).toContain('age: minimum 0');
  });

  it('reports duplicate keys with the key', async () => {
    const uniq = { db, collection: 'uniq' };
    await session.createIndex(uniq, { keys: '{ "k": 1 }', unique: true });
    await session.insertOne(uniq, '{ "k": 1 }');
    await expect(session.insertOne(uniq, '{ "k": 1 }')).rejects.toMatchObject({
      code: 'SQL_ERROR',
      detail: expect.stringContaining('Duplicate key'),
    });
  });

  it('explains find and aggregate with queryPlanner and executionStats', async () => {
    await session.createIndex(orders, { keys: '{ "status": 1, "qty": -1 }', name: 'status_qty' });
    const find = await session.explainQuery(
      orders,
      { kind: 'find', query: { filter: '{ "status": "A" }', sort: '{ "qty": -1 }', limit: 5 } },
      'executionStats',
    );
    expect(find.summary).toMatchObject({
      collectionScan: false,
      indexes: ['status_qty'],
      nReturned: 5,
    });
    const scan = await session.explainQuery(orders, {
      kind: 'find',
      query: { filter: '{ "price": 3.25 }' },
    });
    expect(scan.summary.collectionScan).toBe(true);
    expect(scan.plan.operation).toBe('COLLSCAN');
    expect(scan.raw).toContain('"queryPlanner"');
    const agg = await session.explainQuery(
      orders,
      {
        kind: 'aggregate',
        pipeline: `[{ $match: { status: 'A' } }, { $group: { _id: '$cust', n: { $sum: 1 } } }]`,
      },
      'executionStats',
    );
    expect(agg.summary.indexes).toContain('status_qty');
    expect(agg.plan.children.length + (agg.plan.operation ? 1 : 0)).toBeGreaterThan(0);
  });

  it('analyses the schema on a sample and applies it as a validator', async () => {
    const analysis = await session.analyzeSchema(orders, {
      sampleSize: 100,
      filter: '{ "status": "B" }',
    });
    expect(analysis.documentCount).toBe(100);
    const qty = analysis.fields.find((f) => f.name === 'qty')!;
    expect(qty.types).toEqual([{ type: 'long', count: 100 }]);
    const amount = analysis.fields.find((f) => f.name === 'amount')!;
    expect(amount.types[0]!.type).toBe('decimal');
    const validator = toEjson({ $jsonSchema: toJsonSchema(analysis) });
    await session.collMod(orders, {
      validator,
      validationLevel: 'moderate',
      validationAction: 'warn',
    });
    const info = await session.collectionInfo(orders);
    expect(info.validationLevel).toBe('moderate');
    expect(info.validator).toContain('"bsonType":"long"');
  });
});
