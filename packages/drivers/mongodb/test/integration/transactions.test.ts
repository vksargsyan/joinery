import { EJSON, type ChangeEvent } from '@joinery/mongo-tools';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { MongoSession } from '../../src';
import { MONGO_URL, cells, collect, connectMongo, execId, testDatabase } from './helpers';

describe.skipIf(!MONGO_URL)('MongoDB transactions and change streams (replica set)', () => {
  const db = testDatabase();
  const ns = { db, collection: 'accounts' };
  let session: MongoSession;
  let other: MongoSession;

  beforeAll(async () => {
    session = await connectMongo(MONGO_URL!);
    other = await connectMongo(MONGO_URL!);
    await session.insertMany(ns, `[{ _id: 1, balance: 100 }, { _id: 2, balance: 0 }]`);
  });

  afterAll(async () => {
    await session?.rollback().catch(() => undefined);
    await session?.dropDatabase(db).catch(() => undefined);
    await session?.close();
    await other?.close();
  });

  it('commits a transaction atomically', async () => {
    await session.begin();
    expect(session.inTransaction).toBe(true);
    await session.updateMany(ns, '{ "_id": 1 }', '{ "$inc": { "balance": -30 } }');
    await session.updateMany(ns, '{ "_id": 2 }', '{ "$inc": { "balance": 30 } }');
    // Invisible outside the transaction until commit.
    expect(await other.count(ns, '{ "balance": 30 }')).toBe(0);
    expect(await session.count(ns, '{ "balance": 30 }')).toBe(1);
    await session.commit();
    expect(session.inTransaction).toBe(false);
    expect(await other.count(ns, '{ "balance": 30 }')).toBe(1);
  });

  it('rolls back, including commands run through execute', async () => {
    await session.useDatabase(db);
    await session.begin();
    await collect(session, `{ insert: 'accounts', documents: [{ _id: 3, balance: 5 }] }`);
    const inside = cells(await collect(session, `{ find: 'accounts', filter: { _id: 3 } }`));
    expect(inside).toHaveLength(1);
    await session.rollback();
    expect(await other.count(ns, '{ "_id": 3 }')).toBe(0);
    await expect(session.commit()).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('aborts the transaction when an operation in it is cancelled', async () => {
    await session.begin();
    await session.insertOne(ns, '{ "_id": 4 }');
    const executionId = execId();
    const slow = collect(
      session,
      `{ find: 'accounts', filter: { $where: 'sleep(1000) || true' } }`,
      {
        executionId,
      },
    ).catch((error: unknown) => error);
    await new Promise((resolve) => setTimeout(resolve, 300));
    await session.cancel(executionId);
    expect(await slow).toMatchObject({ code: 'CANCELLED' });
    await expect(session.commit()).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(session.inTransaction).toBe(false);
    expect(await other.count(ns, '{ "_id": 4 }')).toBe(0);
  });

  it('reports write conflicts between transactions', async () => {
    await session.begin();
    await other.begin();
    await session.updateMany(ns, '{ "_id": 1 }', '{ "$inc": { "balance": 1 } }');
    await expect(
      other.updateMany(ns, '{ "_id": 1 }', '{ "$inc": { "balance": 1 } }'),
    ).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    await other.rollback();
    await session.commit();
  });

  it('tails inserts, updates and deletes with full documents, and resumes', async () => {
    const controller = new AbortController();
    const events: ChangeEvent[] = [];
    const tail = (async () => {
      for await (const event of session.watch(
        { kind: 'collection', ns },
        `[{ $match: { operationType: { $in: ['insert', 'update', 'delete'] } } }]`,
        {
          fullDocument: 'updateLookup',
          maxAwaitTimeMS: 200,
          signal: controller.signal,
        },
      )) {
        events.push(event);
        if (events.length === 3) break;
      }
    })();
    await new Promise((resolve) => setTimeout(resolve, 500));
    await other.insertOne(ns, '{ "_id": 10, "balance": 1 }');
    await other.updateMany(ns, '{ "_id": 10 }', '{ "$set": { "balance": 2 } }');
    // updateLookup reads the document when the event is read, so delete it only after that:
    // a delete that gets there first leaves the update's fullDocument null.
    await vi.waitFor(() => expect(events.length).toBeGreaterThanOrEqual(2), { timeout: 10_000 });
    await other.deleteOne(ns, '10');
    await tail;
    expect(events.map((e) => e.operationType)).toEqual(['insert', 'update', 'delete']);
    expect(events[0]!.ns).toEqual({ db, collection: 'accounts' });
    expect(events[0]!.documentKey).toBe('{"_id":{"$numberInt":"10"}}');
    const update = EJSON.parse(events[1]!.event, { relaxed: true }) as {
      fullDocument: { balance: number };
    };
    expect(update.fullDocument.balance).toBe(2);
    expect(events[2]!.clusterTime).toMatch(/^\d{4}-/);

    // Resume after the insert: the update and the delete come again.
    const resumed: string[] = [];
    for await (const event of session.watch({ kind: 'database', db }, undefined, {
      resumeAfter: events[0]!.resumeToken,
      maxAwaitTimeMS: 200,
    })) {
      resumed.push(event.operationType);
      if (resumed.length === 2) break;
    }
    expect(resumed).toEqual(['update', 'delete']);
  });

  it('stops a change stream on abort with CANCELLED', async () => {
    const controller = new AbortController();
    const run = (async () => {
      for await (const _ of session.watch({ kind: 'cluster' }, undefined, {
        signal: controller.signal,
        maxAwaitTimeMS: 100,
      })) {
        void _;
      }
    })();
    setTimeout(() => controller.abort(), 300);
    await expect(run).rejects.toMatchObject({ code: 'CANCELLED' });
  });
});
