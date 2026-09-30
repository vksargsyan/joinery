import { Readable, Writable } from 'node:stream';

import { EJSON } from '@joinery/mongo-tools';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { MongoSession } from '../../src';
import { MONGO_URL, connectMongo, testDatabase } from './helpers';

describe.skipIf(!MONGO_URL)('MongoDB administration (replica set)', () => {
  const db = testDatabase();
  let session: MongoSession;

  beforeAll(async () => {
    session = await connectMongo(MONGO_URL!);
  });

  afterAll(async () => {
    await session?.dropDatabase(db).catch(() => undefined);
    await session
      ?.dropUser(db, 'it_user')
      .catch(() => undefined)
      .then(() => session.dropRole(db, 'it_role'))
      .catch(() => undefined);
    await session?.close();
  });

  it('creates every index kind, lists them with usage, hides and drops them', async () => {
    const ns = { db, collection: 'places' };
    await session.insertMany(
      ns,
      `[{ name: 'a', at: ISODate(), loc: { type: 'Point', coordinates: [1, 2] }, body: 'hello world', attrs: { color: 'red' }, n: 1 },
        { name: 'b', at: ISODate(), loc: { type: 'Point', coordinates: [3, 4] }, body: 'bye', attrs: { size: 2 }, n: 2 }]`,
    );
    const names = [
      await session.createIndex(ns, {
        keys: '{ "name": 1 }',
        unique: true,
        collation: '{ "locale": "en", "strength": 2 }',
      }),
      await session.createIndex(ns, {
        keys: '{ "name": 1, "n": -1 }',
        name: 'compound',
        sparse: true,
      }),
      await session.createIndex(ns, { keys: '{ "at": 1 }', expireAfterSeconds: 3600 }),
      await session.createIndex(ns, {
        keys: '{ "n": 1 }',
        partialFilterExpression: '{ "n": { "$gt": 1 } }',
        hidden: true,
      }),
      await session.createIndex(ns, {
        keys: '{ "body": "text" }',
        weights: '{ "body": 5 }',
        defaultLanguage: 'english',
      }),
      await session.createIndex(ns, { keys: '{ "loc": "2dsphere" }' }),
      await session.createIndex(ns, { keys: '{ "name": "hashed" }' }),
      await session.createIndex(ns, { keys: '{ "$**": 1 }', wildcardProjection: '{ "attrs": 1 }' }),
    ];
    expect(names).toContain('compound');
    await session.count(ns, '{ "name": "a" }');
    const indexes = await session.listIndexes(ns);
    const byName = new Map(indexes.map((i) => [i.name, i]));
    expect(byName.get('name_1')).toMatchObject({
      kind: 'single',
      unique: true,
      collation: expect.stringContaining('"locale":"en"'),
    });
    expect(byName.get('compound')).toMatchObject({ kind: 'compound', sparse: true });
    expect(byName.get('at_1')).toMatchObject({ expireAfterSeconds: 3600 });
    expect(byName.get('n_1')).toMatchObject({
      hidden: true,
      partialFilterExpression: expect.stringContaining('$gt'),
    });
    expect(byName.get('body_text')?.kind).toBe('text');
    expect(byName.get('loc_2dsphere')?.kind).toBe('2dsphere');
    expect(byName.get('name_hashed')?.kind).toBe('hashed');
    expect(byName.get('$**_1')).toMatchObject({
      kind: 'wildcard',
      wildcardProjection: expect.stringContaining('attrs'),
    });
    expect(byName.get('_id_')!.size).toBeGreaterThan(0);
    expect(byName.get('_id_')!.usageOps).toBeGreaterThanOrEqual(0);
    expect(byName.get('_id_')!.usageSince).toMatch(/^\d{4}-/);

    await session.setIndexHidden(ns, 'n_1', false);
    expect((await session.listIndexes(ns)).find((i) => i.name === 'n_1')!.hidden).toBe(false);
    await session.dropIndex(ns, 'compound');
    expect((await session.listIndexes(ns)).map((i) => i.name)).not.toContain('compound');
    await expect(session.dropIndex(ns, '_id_')).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
  });

  it('creates collections with options, views, and changes, renames and drops them', async () => {
    await session.createCollection(
      { db, collection: 'capped' },
      { capped: { size: 65536, max: 100 } },
    );
    await session.createCollection(
      { db, collection: 'metrics' },
      {
        timeseries: { timeField: 't', metaField: 'm', granularity: 'minutes' },
        expireAfterSeconds: 86400,
      },
    );
    await session.createCollection({ db, collection: 'clustered' }, { clustered: {} });
    await session.createCollection(
      { db, collection: 'people' },
      {
        collation: '{ "locale": "fr" }',
        validator: '{ "name": { "$type": "string" } }',
        validationAction: 'warn',
      },
    );
    await session.createView(
      { db, collection: 'people_view' },
      'people',
      `[{ $project: { name: 1 } }]`,
    );

    const capped = await session.collectionInfo({ db, collection: 'capped' });
    expect(capped).toMatchObject({ type: 'collection', capped: true, clustered: false });
    const metrics = await session.collectionInfo({ db, collection: 'metrics' });
    expect(metrics).toMatchObject({
      type: 'timeseries',
      timeseries: { timeField: 't', metaField: 'm', granularity: 'minutes' },
      expireAfterSeconds: 86400,
    });
    expect((await session.collectionInfo({ db, collection: 'clustered' })).clustered).toBe(true);
    const people = await session.collectionInfo({ db, collection: 'people' });
    expect(people).toMatchObject({
      validationAction: 'warn',
      collation: expect.stringContaining('"fr"'),
    });
    expect(people.stats).toMatchObject({ count: 0, indexCount: 1 });
    const view = await session.collectionInfo({ db, collection: 'people_view' });
    expect(view).toMatchObject({ type: 'view', viewOn: 'people', readOnly: true });
    expect(view.stats).toBeUndefined();

    await session.collMod({ db, collection: 'metrics' }, { expireAfterSeconds: 'off' });
    expect(
      (await session.collectionInfo({ db, collection: 'metrics' })).expireAfterSeconds,
    ).toBeUndefined();
    await session.renameCollection({ db, collection: 'capped' }, 'capped2');
    await expect(session.collectionInfo({ db, collection: 'capped' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await session.dropCollection({ db, collection: 'capped2' });
    await expect(session.createCollection({ db, collection: 'people' })).rejects.toMatchObject({
      code: 'SQL_ERROR',
    });
  });

  it('browses databases, folders, collections and indexes without reading documents', async () => {
    await session.uploadFile({ db, bucket: 'photos' }, new Uint8Array([1, 2, 3]), {
      filename: 'x.bin',
    });
    const roots = await session.browse([]);
    const mine = roots.find((n) => n.name === db)!;
    expect(mine).toMatchObject({ kind: 'database', path: [db], hasChildren: true });
    expect((await session.browse([db])).map((n) => n.path[1])).toEqual([
      'collections',
      'views',
      'time-series',
      'gridfs',
      'users',
      'roles',
    ]);
    const collections = await session.browse([db, 'collections']);
    const names = collections.map((n) => n.name);
    expect(names).toContain('places');
    expect(names).not.toContain('photos.files');
    expect(names.some((n) => n.startsWith('system.'))).toBe(false);
    expect(collections.find((n) => n.name === 'places')!.detail).toMatchObject({ count: 2 });
    expect((await session.browse([db, 'views'])).map((n) => [n.kind, n.name])).toEqual([
      ['view', 'people_view'],
    ]);
    expect((await session.browse([db, 'time-series']))[0]).toMatchObject({
      kind: 'time-series',
      name: 'metrics',
    });
    expect(await session.browse([db, 'gridfs'])).toEqual([
      expect.objectContaining({ kind: 'gridfs-bucket', name: 'photos', detail: { files: 1 } }),
    ]);
    const [indexes] = await session.browse([db, 'collections', 'places']);
    expect(indexes).toMatchObject({ kind: 'folder', name: 'Indexes' });
    const indexNodes = await session.browse(indexes!.path);
    expect(indexNodes.map((n) => n.name)).toContain('loc_2dsphere');
    await expect(session.browse([db, 'nope'])).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('introspects collections, indexes, validators and views into a snapshot', async () => {
    const snapshot = await session.introspect({ database: db });
    expect(snapshot).toMatchObject({ engine: 'mongodb', database: db });
    const schema = snapshot.schemas[0]!;
    const places = schema.tables.find((t) => t.name === 'places')!;
    expect(places.primaryKey).toEqual({ name: '_id_', columns: ['_id'] });
    expect(places.indexes.map((i) => i.name)).not.toContain('_id_');
    const text = places.indexes.find((i) => i.name === 'body_text')!;
    expect(text.method).toBe('text');
    const partial = places.indexes.find((i) => i.name === 'n_1')!;
    expect(partial.where).toContain('$gt');
    expect(schema.tables.find((t) => t.name === 'people')!.options).toMatchObject({
      validationAction: 'warn',
      validator: expect.stringContaining('$type'),
    });
    expect(schema.tables.find((t) => t.name === 'metrics')!.options['type']).toBe('timeseries');
    expect(schema.views).toEqual([
      expect.objectContaining({ name: 'people_view', options: { viewOn: 'people' } }),
    ]);
  });

  it('manages users and roles', async () => {
    await session.createRole(db, {
      role: 'it_role',
      privileges: [{ resource: { db, collection: 'places' }, actions: ['find'] }],
      roles: [],
    });
    await session.createUser(db, {
      user: 'it_user',
      password: 'secret-pw-1',
      roles: [{ role: 'read', db }],
    });
    await session.grantRoles(db, 'it_user', [{ role: 'it_role', db }]);
    const [user] = await session.usersInfo(db, { user: 'it_user', showPrivileges: true });
    expect(user!.roles).toEqual(
      expect.arrayContaining([
        { role: 'read', db },
        { role: 'it_role', db },
      ]),
    );
    expect(user!.inheritedPrivileges!.length).toBeGreaterThan(0);
    expect(JSON.stringify(user)).not.toContain('secret-pw-1');
    await session.revokeRoles(db, 'it_user', [{ role: 'read', db }]);
    await session.updateUser(db, 'it_user', {
      password: 'secret-pw-2',
      customData: '{ "team": "qa" }',
    });
    const [updated] = await session.usersInfo(db, { user: 'it_user' });
    expect(updated).toMatchObject({
      roles: [{ role: 'it_role', db }],
      customData: '{"team":"qa"}',
    });
    await session.updateRole(db, 'it_role', { roles: [{ role: 'read', db }] });
    const [role] = await session.rolesInfo(db, { role: 'it_role', showPrivileges: true });
    expect(role).toMatchObject({ isBuiltin: false, roles: [{ role: 'read', db }] });
    expect(role!.privileges).toEqual([
      { resource: { db, collection: 'places' }, actions: ['find'] },
    ]);
    const builtins = await session.rolesInfo(db, { showBuiltinRoles: true });
    expect(builtins.some((r) => r.role === 'readWrite' && r.isBuiltin)).toBe(true);
    expect((await session.browse([db, 'users'])).map((n) => n.name)).toEqual(['it_user']);
    expect((await session.browse([db, 'roles']))[0]).toMatchObject({
      kind: 'role',
      name: 'it_role',
    });
    await session.dropUser(db, 'it_user');
    await session.dropRole(db, 'it_role');
    expect(await session.usersInfo(db)).toEqual([]);
  });

  it('uploads, lists, downloads, renames and deletes GridFS files', async () => {
    const bucket = { db, bucket: 'docs' };
    const big = new Uint8Array(600_000).map((_, i) => i % 251);
    const id = await session.uploadFile(
      bucket,
      Readable.from([big.subarray(0, 300_000), big.subarray(300_000)]),
      {
        filename: 'big.bin',
        contentType: 'application/octet-stream',
        metadata: '{ "owner": "it" }',
        chunkSizeBytes: 100_000,
      },
    );
    await session.uploadFile(bucket, new Uint8Array([9]), {
      filename: 'small.txt',
      id: '"custom-id"',
    });
    expect(await session.listBuckets(db)).toEqual(['docs', 'photos']);
    const pages = [];
    for await (const page of session.listFiles(bucket, { pageSize: 1 })) pages.push(page.files);
    expect(pages).toHaveLength(2);
    const files = pages.flat();
    const bigInfo = files.find((f) => f.filename === 'big.bin')!;
    expect(bigInfo).toMatchObject({
      id,
      length: 600_000,
      chunkSize: 100_000,
      contentType: 'application/octet-stream',
    });
    expect(bigInfo.metadata).toContain('"owner":"it"');
    const filtered = [];
    for await (const page of session.listFiles(bucket, { filter: '{ "filename": "small.txt" }' }))
      filtered.push(...page.files);
    expect(filtered.map((f) => f.id)).toEqual(['"custom-id"']);

    const chunks: Uint8Array[] = [];
    for await (const chunk of session.downloadFile(bucket, id)) chunks.push(chunk);
    const downloaded = Buffer.concat(chunks);
    expect(downloaded.equals(Buffer.from(big))).toBe(true);
    const partial: Uint8Array[] = [];
    for await (const chunk of session.downloadFile(bucket, id, { start: 10, end: 20 }))
      partial.push(chunk);
    expect([...Buffer.concat(partial)]).toEqual([...big.subarray(10, 20)]);
    let written = 0;
    const sink = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        written += chunk.length;
        callback();
      },
    });
    expect(await session.downloadFileTo(bucket, id, sink)).toBe(600_000);
    expect(written).toBe(600_000);

    await session.renameFile(bucket, id, 'renamed.bin');
    await session.deleteFile(bucket, '"custom-id"');
    const left = [];
    for await (const page of session.listFiles(bucket)) left.push(...page.files);
    expect(left.map((f) => f.filename)).toEqual(['renamed.bin']);
    await expect(session.deleteFile(bucket, '"custom-id"')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    const missing = (async () => {
      for await (const _ of session.downloadFile(bucket, '"nope"')) void _;
    })();
    await expect(missing).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('reads server status, current operations and top', async () => {
    const status = await session.serverStatus();
    expect(status.version).toBe(session.serverVersion);
    expect(status.connections!.current).toBeGreaterThan(0);
    expect(status.raw).toContain('"uptime"');
    const ops = await session.currentOp({ filter: '{ "active": true }', limit: 50 });
    expect(ops.length).toBeGreaterThan(0);
    expect(EJSON.parse(ops[0]!)).toHaveProperty('opid');
    const top = await session.top();
    expect(top.some((entry) => entry.ns.startsWith(db))).toBe(true);
    await expect(session.killOp(2 ** 30)).resolves.toBeUndefined();
  });

  it('drops a database', async () => {
    const other = testDatabase();
    try {
      await session.insertOne({ db: other, collection: 'x' }, '{}');
      await session.dropDatabase(other);
      expect((await session.browse([])).map((n) => n.name)).not.toContain(other);
    } finally {
      await session.dropDatabase(other).catch(() => undefined);
    }
    await expect(session.dropDatabase('bad name')).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
  });
});
