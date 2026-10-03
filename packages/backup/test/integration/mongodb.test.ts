import { join } from 'node:path';

import { newId, type Session } from '@querybara/core';
import type { MongoSession } from '@querybara/driver-mongodb';
import { fileSink } from '@querybara/transfer';
import { EJSON, type Document } from 'bson';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  ArchiveReader,
  backupMongo,
  planMongoRestore,
  restoreMongoArchive,
  type DocumentFormat,
} from '../../src';
import { connectMongo, scratchName, tempDir } from './helpers';

/**
 * MongoDB round trips (spec §14): collections with every BSON type, a capped collection, a
 * validator with a collation, a time series collection with a TTL, a clustered collection, a
 * view, and indexes of each kind, backed up as BSON and as Extended JSON and restored into
 * another database: same documents (canonical Extended JSON, so every type is compared), same
 * options, same indexes.
 */

const URL = process.env['QUERYBARA_TEST_MONGODB_URL'];
const FAST = { log2N: 10, r: 8, p: 1 };

async function command(session: Session, doc: Document): Promise<Document[]> {
  const out: Document[] = [];
  for await (const chunk of session.execute(EJSON.stringify(doc, { relaxed: false }), {
    executionId: newId(),
  })) {
    if (chunk.type !== 'rows') continue;
    for (const cell of chunk.data[0] ?? []) {
      if (typeof cell === 'string') out.push(EJSON.parse(cell, { relaxed: false }) as Document);
    }
  }
  return out;
}

async function documents(session: MongoSession, collection: string): Promise<string[]> {
  const out: string[] = [];
  for await (const page of session.find(
    { db: session.currentDatabase, collection },
    { sort: '{"_id": 1}' },
  )) {
    out.push(...page.documents);
  }
  return out;
}

async function collections(session: Session): Promise<string[]> {
  const rows = await command(session, { listCollections: 1 });
  return rows
    .filter((row) => !String(row['name']).startsWith('system.'))
    .map((row) =>
      EJSON.stringify({ name: row['name'], type: row['type'], options: row['options'] }),
    )
    .sort();
}

async function indexes(session: Session, collection: string): Promise<string[]> {
  const rows = await command(session, { listIndexes: collection });
  return rows.map((row) => EJSON.stringify(row)).sort();
}

const SETUP: readonly Document[] = [
  { create: 'people' },
  { create: 'capped_log', capped: true, size: 65536, max: 50 },
  {
    create: 'validated',
    validator: { $jsonSchema: { bsonType: 'object', required: ['name'] } },
    validationLevel: 'moderate',
    validationAction: 'error',
    collation: { locale: 'fr', strength: 2 },
  },
  {
    create: 'metrics',
    timeseries: { timeField: 'at', metaField: 'sensor', granularity: 'minutes' },
    expireAfterSeconds: 86400 * 365 * 50,
  },
  { create: 'clustered', clusteredIndex: { key: { _id: 1 }, unique: true, name: 'by_id' } },
  { create: 'adults', viewOn: 'people', pipeline: [{ $match: { age: { $gte: 18 } } }] },
  {
    createIndexes: 'people',
    indexes: [
      {
        key: { email: 1 },
        name: 'email_unique',
        unique: true,
        partialFilterExpression: { email: { $exists: true } },
      },
      {
        key: { bio: 'text', name: 'text' },
        name: 'search',
        weights: { name: 10 },
        default_language: 'english',
      },
      { key: { seen: 1 }, name: 'ttl', expireAfterSeconds: 3600 * 24 * 365 * 50 },
      { key: { loc: '2dsphere' }, name: 'loc_2dsphere' },
      { key: { 'tags.$**': 1 }, name: 'tags_wild' },
      { key: { age: -1, name: 1 }, name: 'age_name', hidden: true },
    ],
  },
];

describe.skipIf(!URL)('MongoDB backup and restore', () => {
  const dir = tempDir('mongo');
  const databases: string[] = [];
  let source: MongoSession;
  const sessions: MongoSession[] = [];

  async function database(label: string): Promise<MongoSession> {
    const name = scratchName(label);
    databases.push(name);
    const session = await connectMongo(URL!, name);
    sessions.push(session);
    return session;
  }

  beforeAll(async () => {
    source = await database('source');
    for (const doc of SETUP) await command(source, doc);
    const people = [
      `{"_id": {"$oid": "65f0a1b2c3d4e5f601234567"}, "name": "Ada", "age": {"$numberInt": "36"}, "email": "ada@example.com",
        "big": {"$numberLong": "9007199254740993"}, "ratio": {"$numberDouble": "0.1"}, "price": {"$numberDecimal": "12345.678901234567890123456789"},
        "seen": {"$date": {"$numberLong": "1700000000123"}}, "raw": {"$binary": {"base64": "AAEC/w==", "subType": "00"}},
        "uid": {"$binary": {"base64": "ASNFZ4mrze8BI0VniavN7w==", "subType": "04"}}, "re": {"$regularExpression": {"pattern": "^a.*z$", "options": "im"}},
        "ts": {"$timestamp": {"t": 1700000000, "i": 7}}, "lo": {"$minKey": 1}, "hi": {"$maxKey": 1}, "nan": {"$numberDouble": "NaN"},
        "neg0": {"$numberDouble": "-0.0"}, "tags": [{"k": "a"}, {"k": "b", "n": [1, [2, {"deep": null}]]}], "empty": "", "uni": "Grüße 東京 😀",
        "loc": {"type": "Point", "coordinates": [{"$numberDouble": "13.4"}, {"$numberDouble": "52.5"}]}, "bio": "loves engines"}`,
      `{"_id": "string id", "name": "Grace", "age": {"$numberInt": "12"}}`,
      `{"_id": {"$numberInt": "3"}, "name": "Linus", "age": {"$numberLong": "54"}, "nested": {"a": {"b": {"c": [true, false, null]}}}}`,
      ...Array.from(
        { length: 2500 },
        (_, i) =>
          `{"_id": {"$numberInt": "${1000 + i}"}, "name": "bulk ${i}", "age": {"$numberInt": "${i % 90}"}}`,
      ),
    ];
    await source.insertMany(
      { db: source.currentDatabase, collection: 'people' },
      `[${people.join(',')}]`,
    );
    await source.insertMany(
      { db: source.currentDatabase, collection: 'capped_log' },
      `[${Array.from({ length: 60 }, (_, i) => `{"_id": {"$numberInt": "${i}"}, "line": "log ${i}"}`).join(',')}]`,
    );
    await source.insertMany(
      { db: source.currentDatabase, collection: 'validated' },
      '[{"_id": 1, "name": "École"}, {"_id": 2, "name": "ecole"}]',
    );
    await source.insertMany(
      { db: source.currentDatabase, collection: 'metrics' },
      `[${Array.from({ length: 300 }, (_, i) => `{"at": {"$date": {"$numberLong": "${1893456000000 + i * 60000}"}}, "sensor": {"id": ${i % 3}}, "v": {"$numberDouble": "${i / 7}"}}`).join(',')}]`,
    );
    await source.insertMany(
      { db: source.currentDatabase, collection: 'clustered' },
      '[{"_id": 10, "x": "a"}, {"_id": 5, "x": "b"}]',
    );
  });

  afterAll(async () => {
    for (const session of sessions) {
      await command(session, { dropDatabase: 1 }).catch(() => undefined);
      await session.close().catch(() => undefined);
    }
    dir.remove();
  });

  async function backup(format: DocumentFormat, file: string, encrypt = false): Promise<string> {
    const path = join(dir.path, file);
    const summary = await backupMongo({
      session: source,
      output: fileSink(path),
      format: 'qbak',
      documentFormat: format,
      ...(encrypt ? { encryption: { passphrase: 'mongo secret', cost: FAST } } : {}),
    });
    expect(summary.error).toBeUndefined();
    expect(summary.status).toBe('completed');
    expect(summary.objects).toBe(6);
    return path;
  }

  async function expectSame(target: MongoSession): Promise<void> {
    expect(await collections(target)).toEqual(await collections(source));
    for (const name of ['people', 'capped_log', 'validated', 'clustered', 'adults']) {
      expect(await documents(target, name)).toEqual(await documents(source, name));
    }
    for (const name of ['people', 'capped_log', 'validated', 'clustered', 'metrics']) {
      expect(await indexes(target, name)).toEqual(await indexes(source, name));
    }
    // Time series buckets keep neither the generated _id nor the field order (not even in the
    // source): compare the measurements with sorted fields and without _id.
    const strip = (docs: string[]) =>
      docs
        .map((d) => {
          const { _id: _ignored, ...doc } = EJSON.parse(d, { relaxed: false }) as Document;
          return EJSON.stringify(Object.fromEntries(Object.entries(doc).sort()), {
            relaxed: false,
          });
        })
        .sort();
    expect(strip(await documents(target, 'metrics'))).toEqual(
      strip(await documents(source, 'metrics')),
    );
  }

  for (const [format, encrypt] of [
    ['bson', true],
    ['ejson', false],
  ] as const) {
    it(`round-trips ${format} documents, options and indexes into another database`, async () => {
      const path = await backup(format, `mongo-${format}.qbak`, encrypt);
      const archive = await ArchiveReader.open(path, encrypt ? { passphrase: 'mongo secret' } : {});
      expect(archive.manifest.options['documentFormat']).toBe(format);
      const target = await database(`restored_${format}`);
      const summary = await restoreMongoArchive({ session: target, archive });
      expect(summary.errors).toEqual([]);
      expect(summary.status).toBe('completed');
      expect(summary.rows).toBe(2503 + 60 - 10 + 2 + 300 + 2);
      await expectSame(target);
      await archive.close();
    });
  }

  it('restores a view with the collection it reads, and asks before dropping', async () => {
    const path = await backup('bson', 'selective.qbak');
    const archive = await ArchiveReader.open(path);
    const target = await database('selected');
    const plan = await planMongoRestore({
      session: target,
      archive,
      select: ['collection:adults'],
    });
    expect(plan.objects.map((o) => o.id)).toEqual(['collection:adults', 'collection:people']);
    expect(plan.added).toEqual(['collection:people']);
    const first = await restoreMongoArchive({
      session: target,
      archive,
      select: ['collection:adults'],
    });
    expect(first.status).toBe('completed');
    expect(await documents(target, 'adults')).toEqual(await documents(source, 'adults'));

    await target.insertMany(
      { db: target.currentDatabase, collection: 'people' },
      '[{"_id": "extra"}]',
    );
    const again = await planMongoRestore({
      session: target,
      archive,
      select: ['collection:adults'],
    });
    expect(again.conflicts.map((c) => c.qualifiedName).sort()).toEqual(['adults', 'people']);
    const refused = await restoreMongoArchive({
      session: target,
      archive,
      select: ['collection:adults'],
    });
    expect(refused.error?.code).toBe('CONFIRMATION_REQUIRED');
    const replaced = await restoreMongoArchive({
      session: target,
      archive,
      select: ['collection:adults'],
      confirmedConflicts: again.conflicts.map((c) => c.id),
    });
    expect(replaced.errors).toEqual([]);
    expect(await documents(target, 'people')).toEqual(await documents(source, 'people'));
    await archive.close();
  });
});
