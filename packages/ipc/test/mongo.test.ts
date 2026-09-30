import { JoineryError } from '@joinery/core';
import {
  toEjson,
  type CollectionInfo,
  type IndexInfo,
  type SchemaAnalysis,
} from '@joinery/mongo-tools';
import { describe, expect, it } from 'vitest';

import {
  EXPORT_TEXT_LIMIT,
  connectionHostContract,
  createClient,
  mainContract,
  mongoCollectionInfoSchema,
  mongoFindQuerySchema,
  mongoHostContractShape,
  mongoIndexInfoSchema,
  mongoSchemaAnalysisSchema,
  parseRequest,
  serve,
  type HandlersOf,
} from '../src';
import { portPair, unusedHandlers } from './helpers';

/** The MongoDB namespaces of the connection host and main contracts (spec §9). */

describe('mongo schemas', () => {
  it('round-trips the wire types unchanged', () => {
    const index: IndexInfo = {
      name: 'total_1',
      keys: toEjson({ total: 1 }),
      kind: 'single',
      unique: false,
      sparse: false,
      hidden: true,
      spec: '{}',
      usageOps: 3,
    };
    expect(mongoIndexInfoSchema.parse(index)).toEqual(index);
    const info: CollectionInfo = {
      name: 'readings',
      type: 'timeseries',
      options: '{}',
      readOnly: false,
      capped: false,
      clustered: true,
      timeseries: { timeField: 'at', metaField: 'sensor', granularity: 'minutes' },
      stats: { count: 2 },
    };
    expect(mongoCollectionInfoSchema.parse(info)).toEqual(info);
    const leaf = {
      name: '[]',
      path: 'tags[]',
      queryPath: 'tags',
      count: 3,
      documents: 2,
      share: 1,
      presence: 1,
      types: [{ type: 'string' as const, count: 3 }],
      topValues: [{ value: '"a"', display: "'a'", count: 2 }],
      topValuesExact: true,
      fields: [],
      documentValues: 0,
    };
    const analysis: SchemaAnalysis = {
      documentCount: 2,
      truncated: false,
      fields: [
        {
          ...leaf,
          name: 'tags',
          path: 'tags',
          types: [{ type: 'array', count: 2 }],
          items: leaf,
          arrayLengths: { min: 1, max: 2, average: 1.5 },
        },
      ],
    };
    expect(mongoSchemaAnalysisSchema.parse(analysis)).toEqual(analysis);
  });

  it('refuses malformed input before it reaches the host', () => {
    expect(() =>
      parseRequest(connectionHostContract, 'mongo.find', {
        sessionId: 's',
        ns: { db: '', collection: 'orders' },
        query: {},
      }),
    ).toThrow(expect.objectContaining({ code: 'VALIDATION_FAILED' }));
    expect(() => mongoFindQuerySchema.parse({ skip: -1 })).toThrow();
    expect(() =>
      parseRequest(connectionHostContract, 'mongo.find', {
        sessionId: 's',
        ns: { db: 'shop', collection: 'orders' },
        query: {},
        pageSize: 5000,
      }),
    ).toThrow(expect.objectContaining({ code: 'VALIDATION_FAILED' }));
    expect(() =>
      parseRequest(connectionHostContract, 'mongo.gridfs.read', {
        sessionId: 's',
        bucket: { db: 'files', bucket: 'fs' },
        id: '"x"',
        maxBytes: 64 * 1024 * 1024,
      }),
    ).toThrow(expect.objectContaining({ code: 'VALIDATION_FAILED' }));
  });

  it('names every MongoSession service', () => {
    const paths = [...connectionHostContract.methods.keys()].filter((p) => p.startsWith('mongo.'));
    expect(paths).toEqual(
      expect.arrayContaining([
        'mongo.find',
        'mongo.count',
        'mongo.estimatedCount',
        'mongo.aggregate',
        'mongo.previewStage',
        'mongo.insertOne',
        'mongo.insertMany',
        'mongo.replaceOne',
        'mongo.updateMany',
        'mongo.deleteOne',
        'mongo.deleteMany',
        'mongo.explain',
        'mongo.analyzeSchema',
        'mongo.watch',
        'mongo.indexes.list',
        'mongo.indexes.create',
        'mongo.indexes.drop',
        'mongo.indexes.setHidden',
        'mongo.collections.info',
        'mongo.collections.create',
        'mongo.collections.createView',
        'mongo.collections.collMod',
        'mongo.collections.rename',
        'mongo.collections.drop',
        'mongo.collections.dropDatabase',
        'mongo.gridfs.buckets',
        'mongo.gridfs.list',
        'mongo.gridfs.read',
        'mongo.gridfs.delete',
        'mongo.gridfs.rename',
        'mongo.users.list',
        'mongo.users.create',
        'mongo.users.update',
        'mongo.users.drop',
        'mongo.users.grantRoles',
        'mongo.users.revokeRoles',
        'mongo.roles.list',
        'mongo.roles.create',
        'mongo.roles.update',
        'mongo.roles.drop',
        'mongo.admin.currentOp',
        'mongo.admin.killOp',
        'mongo.admin.serverStatus',
        'mongo.admin.top',
        'mongo.serverInfo',
        'mongo.useDatabase',
      ]),
    );
    expect(connectionHostContract.methods.get('mongo.find')?.kind).toBe('stream');
    expect(connectionHostContract.methods.get('mongo.watch')?.kind).toBe('stream');
    expect(connectionHostContract.methods.get('mongo.gridfs.list')?.kind).toBe('stream');
    // Whole GridFS files move by path in main, never through the page.
    expect(mainContract.methods.get('mongo.gridfs.upload')?.progress).toBeDefined();
    expect(mainContract.methods.get('mongo.gridfs.download')?.kind).toBe('unary');
    // Saved pipelines and exported text go through main too.
    expect(
      [...mainContract.methods.keys()].filter(
        (p) => p.startsWith('mongo.pipelines.') || p === 'mongo.writeText',
      ),
    ).toEqual([
      'mongo.pipelines.list',
      'mongo.pipelines.save',
      'mongo.pipelines.delete',
      'mongo.writeText',
    ]);
  });

  it('checks saved pipelines and exported text before main sees them', () => {
    const scope = { profileId: 'p1', db: 'shop', collection: 'orders' };
    expect(
      parseRequest(mainContract, 'mongo.pipelines.save', {
        ...scope,
        name: '  Totals ',
        text: '[]',
      }),
    ).toMatchObject({ input: { name: 'Totals' } });
    expect(() =>
      parseRequest(mainContract, 'mongo.pipelines.save', { ...scope, name: '   ', text: '[]' }),
    ).toThrow(expect.objectContaining({ code: 'VALIDATION_FAILED' }));
    expect(() =>
      parseRequest(mainContract, 'mongo.pipelines.list', { ...scope, collection: '' }),
    ).toThrow(expect.objectContaining({ code: 'VALIDATION_FAILED' }));
    expect(() =>
      parseRequest(mainContract, 'mongo.writeText', {
        path: '/tmp/x.json',
        text: 'x'.repeat(EXPORT_TEXT_LIMIT + 1),
      }),
    ).toThrow(expect.objectContaining({ code: 'VALIDATION_FAILED' }));
  });

  it('streams documents and carries bytes and write summaries across a port', async () => {
    const ports = portPair();
    const seen: unknown[] = [];
    const mongo: HandlersOf<typeof mongoHostContractShape> = {
      ...unusedHandlers(mongoHostContractShape),
      async *find({ query, pageSize = 2 }) {
        seen.push(query);
        for (let page = 0; page < 3; page++) {
          yield {
            documents: Array.from({ length: pageSize }, (_, i) =>
              toEjson({ n: page * pageSize + i }),
            ),
          };
        }
      },
      deleteMany: ({ dryRun, confirmed }) => {
        if (!dryRun && !confirmed) {
          throw new JoineryError({ code: 'CONFIRMATION_REQUIRED', message: 'confirm' });
        }
        return { dryRun: dryRun ?? false, matchedCount: 4, modifiedCount: 0, deletedCount: 0 };
      },
      gridfs: {
        ...unusedHandlers(mongoHostContractShape.gridfs),
        read: () => ({ bytes: new Uint8Array([1, 2, 3]), truncated: true }),
      },
    };
    serve(ports.server, connectionHostContract, {
      ...unusedHandlers(connectionHostContract.shape),
      mongo,
    });
    const host = createClient(ports.client, connectionHostContract);
    const ns = { db: 'shop', collection: 'orders' };
    const pages: string[][] = [];
    for await (const page of host.mongo.find({
      sessionId: 's',
      ns,
      query: { filter: toEjson({ total: { $gt: 100 } }) },
    })) {
      pages.push([...page.documents]);
    }
    expect(pages.flat()).toHaveLength(6);
    expect(seen).toEqual([{ filter: '{"total":{"$gt":{"$numberInt":"100"}}}' }]);
    await expect(
      host.mongo.deleteMany({ sessionId: 's', ns, filter: '{}', dryRun: true }),
    ).resolves.toMatchObject({ dryRun: true, matchedCount: 4 });
    await expect(host.mongo.deleteMany({ sessionId: 's', ns, filter: '{}' })).rejects.toMatchObject(
      { code: 'CONFIRMATION_REQUIRED' },
    );
    const read = await host.mongo.gridfs.read({
      sessionId: 's',
      bucket: { db: 'shop', bucket: 'fs' },
      id: '{"$oid":"650000000000000000000000"}',
    });
    expect([...read.bytes]).toEqual([1, 2, 3]);
    await expect(host.mongo.users.list({ sessionId: 's', db: 'admin' })).rejects.toMatchObject({
      code: 'NOT_SUPPORTED',
    });
    host.dispose();
  });
});
