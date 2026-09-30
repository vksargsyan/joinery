import { Long, ObjectId, Timestamp, parseShellDocument } from '@joinery/mongo-tools';
import { describe, expect, it } from 'vitest';

import {
  DOCUMENT_COLUMN,
  MONGO_FOLDERS,
  createMongoAdapter,
  gridFsBuckets,
  indexDef,
  mongoCapabilities,
  mongodbAdapter,
  parseCommand,
} from '../src';
import { indexKind, topologyOf } from '../src/admin';
import { checkCollectionName, checkDatabaseName } from '../src/context';
import { changeEvent } from '../src/watch';

describe('MongoDB driver helpers', () => {
  it('declares capabilities from the topology', () => {
    expect(mongoCapabilities('8.0.4', 'replicaSet')).toMatchObject({
      transactions: true,
      changeStreams: true,
      queryCancel: true,
      serverSideCursors: true,
      explainFormats: ['json', 'analyze'],
      clusterMode: false,
    });
    expect(mongoCapabilities('7.0.1', 'standalone')).toMatchObject({
      transactions: false,
      changeStreams: false,
    });
    expect(mongoCapabilities(undefined, 'sharded')).toMatchObject({
      transactions: true,
      clusterMode: true,
    });
    expect(mongodbAdapter.engine).toBe('mongodb');
    expect(createMongoAdapter().capabilities().transactions).toBe(true);
  });

  it('reads the topology from hello', () => {
    expect(topologyOf({ msg: 'isdbgrid' })).toBe('sharded');
    expect(topologyOf({ setName: 'rs0' })).toBe('replicaSet');
    expect(topologyOf({ serviceId: 'x' })).toBe('loadBalanced');
    expect(topologyOf({ isWritablePrimary: true })).toBe('standalone');
  });

  it('parses command documents in Extended JSON or shell syntax', () => {
    expect(parseCommand('{ "find": "c", "limit": 5 }').name).toBe('find');
    expect(parseCommand("{ aggregate: 'c', pipeline: [], cursor: {} }").name).toBe('aggregate');
    expect(() => parseCommand('[1]')).toThrow(
      expect.objectContaining({ code: 'VALIDATION_FAILED' }),
    );
    expect(() => parseCommand('{}')).toThrow('empty');
    expect(DOCUMENT_COLUMN).toEqual({ name: 'document', nativeType: 'document', kind: 'json' });
  });

  it('finds GridFS buckets from .files/.chunks pairs', () => {
    expect(
      gridFsBuckets([
        'fs.files',
        'fs.chunks',
        'photos.files',
        'orphan.files',
        'x.chunks',
        'a.b.files',
        'a.b.chunks',
      ]),
    ).toEqual(['a.b', 'fs']);
  });

  it('classifies index kinds and maps indexes for the snapshot', () => {
    expect(indexKind({ a: 1 })).toBe('single');
    expect(indexKind({ a: 1, b: -1 })).toBe('compound');
    expect(indexKind({ body: 'text', _fts: 'text' })).toBe('text');
    expect(indexKind({ loc: '2dsphere' })).toBe('2dsphere');
    expect(indexKind({ a: 'hashed' })).toBe('hashed');
    expect(indexKind({ 'attrs.$**': 1 })).toBe('wildcard');
    expect(indexKind({ _id: 1 }, { clustered: true })).toBe('clustered');
    const def = indexDef(
      parseShellDocument(`{ v: 2, key: { a: 1, b: -1, t: 'text' }, name: 'idx', unique: true, hidden: true,
        partialFilterExpression: { a: { $gt: 1 } }, expireAfterSeconds: 60 }`),
    );
    expect(def).toMatchObject({
      name: 'idx',
      unique: true,
      invisible: true,
      method: 'text',
      where: '{"a":{"$gt":{"$numberInt":"1"}}}',
      columns: [
        { name: 'a', order: 'asc' },
        { name: 'b', order: 'desc' },
        { name: 't', order: 'asc', expression: 'text' },
      ],
    });
    expect(def.definition).not.toContain('"v"');
    expect(def.definition).toContain('"expireAfterSeconds"');
  });

  it('maps change events to the cross-process shape', () => {
    const event = changeEvent({
      _id: { _data: '8266' },
      operationType: 'insert',
      clusterTime: new Timestamp({ t: 1_700_000_000, i: 1 }),
      ns: { db: 'shop', coll: 'orders' },
      documentKey: { _id: new ObjectId('507f1f77bcf86cd799439011') },
      fullDocument: { n: Long.fromNumber(1) },
    });
    expect(event).toMatchObject({
      operationType: 'insert',
      resumeToken: '{"_data":"8266"}',
      ns: { db: 'shop', collection: 'orders' },
      documentKey: '{"_id":{"$oid":"507f1f77bcf86cd799439011"}}',
      clusterTime: '2023-11-14T22:13:20.000Z',
    });
    expect(event.event).toContain('"$numberLong":"1"');
    expect(changeEvent({ operationType: 'dropDatabase', ns: { db: 'x' }, _id: {} }).ns).toEqual({
      db: 'x',
    });
  });

  it('checks database and collection names', () => {
    expect(checkDatabaseName('sales')).toBe('sales');
    for (const bad of ['', 'a b', 'a.b', 'a/b', 'a$b', 'x'.repeat(64)]) {
      expect(() => checkDatabaseName(bad)).toThrow(
        expect.objectContaining({ code: 'VALIDATION_FAILED' }),
      );
    }
    expect(checkCollectionName('system.views')).toBe('system.views');
    expect(() => checkCollectionName('$cmd')).toThrow(
      expect.objectContaining({ code: 'VALIDATION_FAILED' }),
    );
  });

  it('lists the explorer folders with stable ids', () => {
    expect(MONGO_FOLDERS.map(([id]) => id)).toEqual([
      'collections',
      'views',
      'time-series',
      'gridfs',
      'users',
      'roles',
    ]);
  });
});
