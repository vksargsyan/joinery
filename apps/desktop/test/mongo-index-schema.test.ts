import {
  analyzeSchema,
  fromEjson,
  formatShellInline,
  toEjson,
  type IndexInfo,
} from '@querybara/mongo-tools';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as MainClient from '../src/renderer/src/lib/main-client';
import {
  EMPTY_INDEX_FORM,
  IndexManager,
  buildIndex,
  defaultIndexName,
  dropIndexCommand,
  hideIndexCommand,
  indexBadges,
  presetForm,
  type IndexForm,
} from '../src/renderer/src/state/mongo/indexes';
import {
  SchemaPanelState,
  collModCommand,
  expandablePaths,
  jsonSchemaText,
  schemaRows,
  typeMix,
  validatorDocument,
  validatorShellText,
} from '../src/renderer/src/state/mongo/schema';
import {
  PROFILE_ID,
  answerConfirms,
  connectHost,
  disconnectAll,
  recorder,
} from './mongo-tool-fixtures';

/** The index manager and schema analysis (spec §9): forms to commands, results to view models. */

const main = vi.hoisted(() => ({ api: {} as Record<string, unknown> }));
vi.mock('../src/renderer/src/lib/main-client', async (importOriginal) => ({
  ...(await importOriginal<typeof MainClient>()),
  mainApi: () => main.api,
}));

const ns = { db: 'shop', collection: 'orders' };

function form(patch: Partial<IndexForm>): IndexForm {
  return { ...EMPTY_INDEX_FORM, ...patch };
}

function plan(patch: Partial<IndexForm>) {
  const built = buildIndex(ns, form(patch));
  if (!built.ok) throw new Error(JSON.stringify(built.issues));
  return built.plan;
}

function issues(patch: Partial<IndexForm>) {
  const built = buildIndex(ns, form(patch));
  if (built.ok) throw new Error('expected issues');
  return built.issues;
}

describe('index specs for every kind', () => {
  it('builds single and compound indexes with the server’s default name', () => {
    const single = plan({ keys: [{ field: 'total', type: '-1' }] });
    expect(single).toMatchObject({ kind: 'single', name: 'total_-1' });
    expect(single.command).toBe("db.getSiblingDB('shop').orders.createIndex({ total: -1 })");
    expect(fromEjson(single.spec.keys)).toEqual({ total: expect.anything() });
    const compound = plan({
      keys: [
        { field: 'status', type: '1' },
        { field: 'at', type: '-1' },
      ],
      name: 'by_status',
      unique: true,
      hidden: true,
    });
    expect(compound).toMatchObject({ kind: 'compound', name: 'by_status' });
    expect(compound.spec).toMatchObject({ unique: true, hidden: true, name: 'by_status' });
    expect(compound.command).toBe(
      "db.getSiblingDB('shop').orders.createIndex({ status: 1, at: -1 }, { unique: true, hidden: true, name: 'by_status' })",
    );
    expect(defaultIndexName([{ field: 'loc', type: '2dsphere' }])).toBe('loc_2dsphere');
  });

  it('builds TTL, partial, sparse and collation options', () => {
    const ttl = plan(presetForm('ttl', form({ keys: [{ field: 'at', type: '1' }] })));
    expect(ttl.spec.expireAfterSeconds).toBe(3600);
    expect(ttl.command).toBe(
      "db.getSiblingDB('shop').orders.createIndex({ at: 1 }, { expireAfterSeconds: 3600 })",
    );
    const partial = plan({
      keys: [{ field: 'total', type: '1' }],
      partialFilter: "{ status: 'open' }",
      collation: "{ locale: 'en', strength: 2 }",
    });
    expect(fromEjson(partial.spec.partialFilterExpression!)).toEqual({ status: 'open' });
    expect(partial.command).toContain("partialFilterExpression: { status: 'open' }");
    expect(partial.command).toContain("collation: { locale: 'en', strength: 2 }");
    expect(plan({ keys: [{ field: 'x', type: '1' }], sparse: true }).spec.sparse).toBe(true);
  });

  it('builds text, 2dsphere, 2d, hashed and wildcard indexes', () => {
    const text = plan({
      keys: [
        { field: 'title', type: 'text' },
        { field: 'body', type: 'text' },
      ],
      weights: '{ title: 10 }',
      defaultLanguage: 'english',
    });
    expect(text).toMatchObject({ kind: 'text', spec: { defaultLanguage: 'english' } });
    expect(text.command).toBe(
      "db.getSiblingDB('shop').orders.createIndex({ title: 'text', body: 'text' }, { weights: { title: 10 }, default_language: 'english' })",
    );
    expect(plan({ keys: [{ field: 'loc', type: '2dsphere' }] }).kind).toBe('2dsphere');
    expect(plan({ keys: [{ field: 'xy', type: '2d' }] }).kind).toBe('2d');
    expect(plan({ keys: [{ field: 'user', type: 'hashed' }] }).kind).toBe('hashed');
    const wildcard = plan({
      ...presetForm('wildcard'),
      wildcardProjection: '{ details: 1 }',
    });
    expect(wildcard.kind).toBe('wildcard');
    expect(wildcard.command).toBe(
      "db.getSiblingDB('shop').orders.createIndex({ '$**': 1 }, { wildcardProjection: { details: 1 } })",
    );
    expect(plan({ keys: [{ field: 'details.$**', type: '1' }] }).kind).toBe('wildcard');
  });

  it('reports combinations the server refuses on the field that causes them', () => {
    expect(issues({ keys: [{ field: '', type: '1' }] }).keys).toBe('Name every key field');
    expect(
      issues({
        keys: [
          { field: 'a', type: '1' },
          { field: 'a', type: '-1' },
        ],
      }).keys,
    ).toMatch(/only once/);
    expect(
      issues({
        keys: [
          { field: 'a', type: '1' },
          { field: 'b', type: '1' },
        ],
        ttl: '60',
      }).ttl,
    ).toMatch(/exactly one/);
    expect(issues({ keys: [{ field: '_id', type: '1' }], ttl: '60' }).ttl).toMatch(/_id/);
    expect(issues({ keys: [{ field: 'at', type: '1' }], ttl: 'soon' }).ttl).toMatch(/whole number/);
    expect(issues({ keys: [{ field: 'u', type: 'hashed' }], unique: true }).unique).toMatch(
      /hashed index cannot be unique/,
    );
    expect(
      issues({ keys: [{ field: 'a', type: '1' }], sparse: true, partialFilter: '{ a: 1 }' }).sparse,
    ).toMatch(/partial or sparse/);
    expect(
      issues({ keys: [{ field: 'a', type: '1' }], wildcardProjection: '{ b: 1 }' })
        .wildcardProjection,
    ).toMatch(/\$\*\*/);
    expect(issues({ keys: [{ field: 'a', type: '1' }], weights: '{ a: 2 }' }).weights).toMatch(
      /text indexes/,
    );
    expect(
      issues({ keys: [{ field: 'a', type: '1' }], collation: '{ strength: 2 }' }).collation,
    ).toMatch(/locale/);
    expect(
      issues({ keys: [{ field: 'a', type: '1' }], partialFilter: '{ a: }' }).partialFilter,
    ).toMatch(/line 1/);
  });

  it('labels listed indexes and writes the drop and hide commands', () => {
    const info: IndexInfo = {
      name: 'at_1',
      keys: toEjson({ at: 1 }),
      kind: 'single',
      unique: true,
      sparse: false,
      hidden: false,
      expireAfterSeconds: 60,
      partialFilterExpression: toEjson({ a: 1 }),
      spec: '{}',
    };
    expect(indexBadges(info)).toEqual(['single', 'TTL', 'partial', 'unique']);
    expect(dropIndexCommand(ns, 'at_1')).toBe("db.getSiblingDB('shop').orders.dropIndex('at_1')");
    expect(hideIndexCommand(ns, 'at_1', false)).toBe(
      "db.getSiblingDB('shop').orders.unhideIndex('at_1')",
    );
  });
});

let confirms: ReturnType<typeof answerConfirms>;
beforeEach(() => {
  confirms = answerConfirms();
});
afterEach(() => {
  confirms.stop();
  disconnectAll();
});

function indexHost() {
  const rec = recorder();
  let indexes: IndexInfo[] = [
    {
      name: '_id_',
      keys: toEjson({ _id: 1 }),
      kind: 'single',
      unique: true,
      sparse: false,
      hidden: false,
      spec: '{}',
    },
  ];
  const host = {
    openSession: async () => ({ sessionId: 's1' }),
    closeSession: async () => undefined,
    mongo: {
      indexes: {
        list: async () => [...indexes],
        create: async (input: { spec: { keys: string; name?: string } }) => {
          rec.record('create', input);
          const name = input.spec.name ?? 'at_1';
          indexes.push({ ...indexes[0]!, name, keys: input.spec.keys, unique: false });
          return { name };
        },
        drop: async (input: { name: string }) => {
          rec.record('drop', input);
          indexes = indexes.filter((i) => i.name !== input.name);
        },
        setHidden: async (input: object) => rec.record('setHidden', input),
      },
    },
  };
  return { host, rec };
}

describe('index manager', () => {
  it('creates, hides and drops indexes, asking before the drop with its command', async () => {
    const { host, rec } = indexHost();
    connectHost(host);
    const m = new IndexManager('ix', { profileId: PROFILE_ID, ...ns });
    await m.init();
    expect(m.state.indexes.map((i) => i.name)).toEqual(['_id_']);
    m.openCreate('ttl');
    m.setKey(0, { field: 'at' });
    expect(m.state.create?.built).toMatchObject({ ok: true, plan: { name: 'at_1' } });
    expect(await m.create()).toBe(true);
    expect(confirms.asked).toHaveLength(0);
    expect(rec.of('create')[0]!.input).toMatchObject({
      confirmed: true,
      spec: { expireAfterSeconds: 3600 },
    });
    expect(m.state.indexes.map((i) => i.name)).toEqual(['_id_', 'at_1']);
    await m.setHidden('at_1', true);
    expect(rec.of('setHidden')[0]!.input).toMatchObject({ name: 'at_1', hidden: true });
    confirms.answer(false);
    expect(await m.drop('at_1')).toBe(false);
    expect(confirms.asked.at(-1)).toMatchObject({
      title: 'Drop the index at_1?',
      detail: "db.getSiblingDB('shop').orders.dropIndex('at_1')",
    });
    confirms.answer(true);
    expect(await m.drop('at_1')).toBe(true);
    expect(await m.drop('_id_')).toBe(false);
    expect(m.state.indexes.map((i) => i.name)).toEqual(['_id_']);
    await m.dispose();
  });

  it('asks before every change on a production connection and changes nothing when read-only', async () => {
    const production = indexHost();
    connectHost(production.host, { environment: 'production' });
    const m = new IndexManager('ix', { profileId: PROFILE_ID, ...ns });
    await m.init();
    m.openCreate();
    m.setKey(0, { field: 'total' });
    await m.create();
    expect(confirms.asked[0]).toMatchObject({
      title: 'Create the index total_1?',
      detail: "db.getSiblingDB('shop').orders.createIndex({ total: 1 })",
    });
    await m.dispose();
    disconnectAll();
    const readOnly = indexHost();
    connectHost(readOnly.host, { readOnly: true });
    const r = new IndexManager('ix2', { profileId: PROFILE_ID, ...ns });
    await r.init();
    r.openCreate();
    expect(r.state.create).toBeUndefined();
    expect(r.state.notice).toMatchObject({ kind: 'error' });
    await r.dispose();
  });
});

const SAMPLE = analyzeSchema([
  { _id: 1, name: 'Ada', total: 5, address: { city: 'London' }, tags: ['a', 'b'] },
  { _id: 2, name: 'Bob', total: 2.5, address: { city: 'Paris', zip: '75001' }, tags: [] },
  { _id: 3, name: 'Cy', total: null, tags: ['a'] },
  { _id: 4, name: 'Di', total: 7 },
] as never);

describe('schema analysis view model and exports', () => {
  it('shows fields as rows, children under expanded ones, with type shares', () => {
    const top = schemaRows(SAMPLE, {});
    expect(top.map((r) => [r.key, r.depth, r.expandable])).toEqual([
      ['_id', 0, false],
      ['name', 0, false],
      ['total', 0, false],
      ['address', 0, true],
      ['tags', 0, true],
    ]);
    const open = schemaRows(SAMPLE, { address: true, tags: true });
    expect(open.map((r) => r.key)).toEqual([
      '_id',
      'name',
      'total',
      'address',
      'address.city',
      'address.zip',
      'tags',
      'tags[]',
    ]);
    const address = open.find((r) => r.key === 'address')!;
    expect(address.field.share).toBe(0.5);
    const total = SAMPLE.fields.find((f) => f.name === 'total')!;
    expect(typeMix(total).map((t) => [t.type, t.share])).toEqual([
      ['int', 0.5],
      ['double', 0.25],
      ['null', 0.25],
    ]);
    expect(expandablePaths(SAMPLE)).toEqual(['address', 'tags']);
  });

  it('exports a 2020-12 JSON Schema and a $jsonSchema validator', () => {
    const schema = JSON.parse(jsonSchemaText(SAMPLE)) as Record<string, unknown>;
    expect(schema['$schema']).toBe('https://json-schema.org/draft/2020-12/schema');
    expect(schema['required']).toEqual(['_id', 'name', 'total']);
    const loose = JSON.parse(jsonSchemaText(SAMPLE, { requiredThreshold: 0.5 })) as {
      required: string[];
    };
    expect(loose.required).toEqual(['_id', 'name', 'total', 'address', 'tags']);
    const validator = validatorDocument(SAMPLE) as { $jsonSchema: Record<string, unknown> };
    expect(validator.$jsonSchema['bsonType']).toBe('object');
    expect(validator.$jsonSchema['required']).toEqual(['_id', 'name', 'total']);
    expect(validatorShellText(SAMPLE)).toContain("bsonType: 'object'");
    expect(
      collModCommand(ns, {
        validator: { a: 1 } as never,
        validationLevel: 'moderate',
        validationAction: 'warn',
      }),
    ).toBe(
      "db.getSiblingDB('shop').runCommand({ collMod: 'orders', validator: { a: 1 }, validationLevel: 'moderate', validationAction: 'warn' })",
    );
    expect(collModCommand(ns, { expireAfterSeconds: 'off' })).toBe(
      "db.getSiblingDB('shop').runCommand({ collMod: 'orders', expireAfterSeconds: 'off' })",
    );
  });
});

function schemaHost(options: { hang?: boolean } = {}) {
  const rec = recorder();
  const host = {
    openSession: async () => ({ sessionId: 's1' }),
    closeSession: async () => undefined,
    mongo: {
      analyzeSchema: (input: object, call?: { signal?: AbortSignal }) => {
        rec.record('analyzeSchema', input);
        if (!options.hang) return Promise.resolve(SAMPLE);
        return new Promise((_resolve, reject) => {
          const cancel = () => reject(Object.assign(new Error('cancelled'), { code: 'CANCELLED' }));
          if (call?.signal?.aborted) cancel();
          call?.signal?.addEventListener('abort', cancel);
        });
      },
      collections: { collMod: async (input: object) => rec.record('collMod', input) },
    },
  };
  return { host, rec };
}

describe('schema panel', () => {
  it('samples with the size and filter given, and applies the result as a validator', async () => {
    const { host, rec } = schemaHost();
    connectHost(host);
    const p = new SchemaPanelState('schema', { profileId: PROFILE_ID, ...ns, kind: 'collection' });
    await p.init();
    expect(p.state.result?.documentCount).toBe(4);
    p.setSampleSize(50);
    p.setFilter('{ total: { $gt: } }');
    expect(p.state.filterIssue).toBeDefined();
    await p.run();
    expect(rec.of('analyzeSchema')).toHaveLength(1);
    p.setFilter("{ status: 'open' }");
    await p.run();
    expect(rec.of('analyzeSchema')[1]!.input).toMatchObject({
      options: { sampleSize: 50, filter: toEjson({ status: 'open' }) },
    });
    p.setValidation({ level: 'moderate' });
    expect(await p.applyValidator()).toBe(true);
    expect(confirms.asked[0]!.title).toBe('Apply the schema as the validator of orders?');
    expect(confirms.asked[0]!.detail).toContain("collMod: 'orders', validator: { $jsonSchema:");
    const collMod = rec.of('collMod')[0]!.input as {
      changes: { validator: string };
      confirmed: boolean;
    };
    expect(collMod).toMatchObject({
      confirmed: true,
      changes: { validationLevel: 'moderate', validationAction: 'error' },
    });
    expect(formatShellInline(fromEjson(collMod.changes.validator))).toContain(
      "required: [ '_id', 'name', 'total' ]",
    );
    await p.dispose();
  });

  it('cancels a running analysis', async () => {
    const { host, rec } = schemaHost({ hang: true });
    connectHost(host);
    const p = new SchemaPanelState('schema', { profileId: PROFILE_ID, ...ns, kind: 'collection' });
    const running = p.run();
    await vi.waitFor(() => expect(rec.of('analyzeSchema')).toHaveLength(1));
    expect(p.state.running).toBe(true);
    p.cancel();
    await running;
    expect(p.state.running).toBe(false);
    expect(p.state.notice).toMatchObject({ text: 'Analysis cancelled' });
    await p.dispose();
  });

  it('saves exports through the save dialog and main', async () => {
    const written: { path: string; text: string }[] = [];
    main.api = {
      dialogs: { saveFile: async () => ({ path: '/tmp/orders.schema.json' }) },
      mongo: {
        writeText: async (input: { path: string; text: string }) => void written.push(input),
      },
    };
    const { host } = schemaHost();
    connectHost(host);
    const p = new SchemaPanelState('schema', { profileId: PROFILE_ID, ...ns, kind: 'collection' });
    await p.init();
    await p.saveExport('json-schema');
    expect(written[0]!.path).toBe('/tmp/orders.schema.json');
    expect(JSON.parse(written[0]!.text)).toMatchObject({ type: 'object' });
    expect(p.state.notice).toMatchObject({ kind: 'success' });
    await p.dispose();
  });
});
