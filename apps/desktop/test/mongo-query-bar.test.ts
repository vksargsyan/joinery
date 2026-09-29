import { toEjson } from '@joinery/mongo-tools';
import { describe, expect, it } from 'vitest';

import { commandSafety } from '../src/renderer/src/state/mongo/commands';
import {
  describeObject,
  dropCommand,
  listingPath,
  mongoObjectOf,
  opensCollection,
} from '../src/renderer/src/state/mongo/explorer';
import {
  EMPTY_FIELDS,
  checkField,
  checkFields,
  fieldsOf,
  findTextOf,
  modelOf,
  parseFindInput,
} from '../src/renderer/src/state/mongo/query-bar';

/** The collection view's query bar, the console's command rules and the explorer's drops (spec §9, §5). */

describe('query bar fields', () => {
  it('checks each field as typed, with the position of the problem', () => {
    expect(checkField('filter', "{ status: 'open', total: { $gt: 100 } }")).toBeUndefined();
    expect(checkField('filter', '')).toBeUndefined();
    const issue = checkField('filter', '{ total: { $gt: } }');
    expect(issue).toMatchObject({ line: 1, column: 17, offset: 16 });
    expect(issue?.message).not.toMatch(/line/);
    expect(checkField('sort', '[1, 2]')).toMatchObject({
      message: 'The sort must be a document { ... }',
    });
    expect(checkField('limit', ' 25 ')).toBeUndefined();
    expect(checkField('skip', '1x')).toMatchObject({
      message: 'Skip must be a whole number',
      column: 2,
    });
    expect(checkField('limit', '-5')).toMatchObject({ message: 'Limit must be a whole number' });
    expect(Object.keys(checkFields({ ...EMPTY_FIELDS, projection: '{ a: ', limit: 'x' }))).toEqual([
      'projection',
      'limit',
    ]);
  });

  it('builds the query model and the find() text from the fields', () => {
    const fields = {
      filter: "{ status: 'open', at: ISODate('2026-01-01T00:00:00Z') }",
      projection: '{ total: 1 }',
      sort: '{ total: -1 }',
      skip: '10',
      limit: '0',
    };
    const model = modelOf(fields);
    expect(toEjson(model.filter)).toBe(
      '{"status":"open","at":{"$date":{"$numberLong":"1767225600000"}}}',
    );
    expect(model).toMatchObject({ skip: 10 });
    expect(model.limit).toBeUndefined();
    expect(findTextOf('orders', fields)).toBe(
      "db.orders.find({ status: 'open', at: ISODate('2026-01-01T00:00:00.000Z') }, { total: 1 }).sort({ total: -1 }).skip(10)",
    );
    expect(findTextOf('order items', { ...EMPTY_FIELDS, limit: '5' })).toBe(
      "db.getCollection('order items').find({}).limit(5)",
    );
    expect(findTextOf('orders', { ...EMPTY_FIELDS, filter: '{ a: ' })).toBeUndefined();
    expect(() => modelOf({ ...EMPTY_FIELDS, skip: 'many' })).toThrow('Skip must be a whole number');
  });

  it('parses edited find() text back into the fields, keeping what they cannot show', () => {
    const parsed = parseFindInput(
      "db.orders.find({ total: { $gt: 100 } }).sort({ total: -1 }).limit(20).hint('total_1')",
      'orders',
    );
    expect(parsed).toEqual({
      ok: true,
      fields: {
        filter: '{ total: { $gt: 100 } }',
        projection: '',
        sort: '{ total: -1 }',
        skip: '',
        limit: '20',
      },
      extras: { hint: 'total_1' },
    });
    if (!parsed.ok) throw new Error('unreachable');
    expect(findTextOf('orders', parsed.fields, parsed.extras)).toBe(
      "db.orders.find({ total: { $gt: 100 } }).sort({ total: -1 }).limit(20).hint('total_1')",
    );
    expect(parseFindInput('{ status: "open" }', 'orders')).toMatchObject({
      ok: true,
      fields: { filter: "{ status: 'open' }" },
    });
    expect(parseFindInput('find({}, { a: 1 })', 'orders')).toMatchObject({
      ok: true,
      fields: { projection: '{ a: 1 }' },
    });
    expect(parseFindInput('db.customers.find({})', 'orders')).toMatchObject({
      ok: false,
      issue: {
        message: 'This view shows orders; open customers to query it',
        offset: 3,
        column: 4,
      },
    });
    const broken = parseFindInput('db.orders.find({ a: 1 }\n  .sort({ b: })', 'orders');
    expect(broken).toMatchObject({ ok: false, issue: { line: 2 } });
    expect(fieldsOf({ filter: {} }).fields).toEqual(EMPTY_FIELDS);
  });
});

describe('console command rules', () => {
  it('knows which commands write and which destroy', () => {
    expect(commandSafety('{ find: "orders", filter: { total: { $gt: 100 } } }')).toEqual({
      name: 'find',
      writes: false,
      destructive: false,
    });
    expect(commandSafety('{ insert: "orders", documents: [{}] }')).toMatchObject({
      writes: true,
      destructive: false,
    });
    expect(commandSafety('{ drop: "orders" }')).toMatchObject({ destructive: true });
    expect(commandSafety('{ delete: "o", deletes: [{ q: {}, limit: 0 }] }')).toMatchObject({
      destructive: true,
    });
    expect(commandSafety('{ delete: "o", deletes: [{ q: { _id: 1 }, limit: 1 }] }')).toMatchObject({
      writes: true,
      destructive: false,
    });
    expect(
      commandSafety('{ update: "o", updates: [{ q: {}, u: {}, multi: true }] }'),
    ).toMatchObject({
      destructive: true,
    });
    expect(
      commandSafety('{ aggregate: "o", pipeline: [{ $out: "x" }], cursor: {} }'),
    ).toMatchObject({
      writes: true,
      destructive: false,
    });
    expect(commandSafety('{ aggregate: "o", pipeline: [{ $match: {} }], cursor: {} }').writes).toBe(
      false,
    );
    expect(commandSafety('not a command').writes).toBe(false);
  });
});

describe('MongoDB explorer', () => {
  const node = (
    kind: 'database' | 'collection' | 'view' | 'index' | 'user' | 'folder',
    path: string[],
  ) => ({
    kind,
    name: path.at(-1)!,
    path,
    hasChildren: false,
  });

  it('turns tree nodes into objects and shows the command a drop runs', () => {
    const collection = mongoObjectOf(node('collection', ['shop', 'collections', 'orders']))!;
    expect(collection).toEqual({ kind: 'collection', db: 'shop', name: 'orders' });
    expect(dropCommand(collection)).toBe("db.getSiblingDB('shop').orders.drop()");
    expect(listingPath(collection)).toEqual(['shop', 'collections']);
    const odd = mongoObjectOf(node('view', ['shop', 'views', 'big orders']))!;
    expect(dropCommand(odd)).toBe("db.getSiblingDB('shop').getCollection('big orders').drop()");
    const index = mongoObjectOf(
      node('index', ['shop', 'collections', 'orders', 'indexes', 'total_1']),
    )!;
    expect(dropCommand(index)).toBe("db.getSiblingDB('shop').orders.dropIndex('total_1')");
    expect(describeObject(index)).toBe('index total_1 of shop.orders');
    expect(
      dropCommand(
        mongoObjectOf(node('index', ['shop', 'collections', 'orders', 'indexes', '_id_']))!,
      ),
    ).toBeUndefined();
    expect(dropCommand(mongoObjectOf(node('database', ['shop']))!)).toBe(
      "db.getSiblingDB('shop').dropDatabase()",
    );
    expect(dropCommand(mongoObjectOf(node('user', ['shop', 'users', "o'neil"]))!)).toBe(
      "db.getSiblingDB('shop').dropUser('o\\'neil')",
    );
    expect(mongoObjectOf(node('folder', ['shop', 'collections']))).toBeUndefined();
    expect(opensCollection(node('view', ['shop', 'views', 'v']))).toBe(true);
    expect(opensCollection(node('index', ['shop', 'collections', 'o', 'indexes', 'i']))).toBe(
      false,
    );
  });
});
