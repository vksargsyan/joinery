import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  Int32,
  ShellParseError,
  collectionReference,
  formatFindText,
  fromFindQuery,
  parseFindText,
  parseShellDocument,
  toEjson,
  toFindQuery,
  type QueryModel,
} from '../src';

const doc = parseShellDocument;

describe('find() text', () => {
  const model: QueryModel = {
    filter: doc("{ status: 'A', qty: { $lt: 30 }, when: ISODate('2024-01-01T00:00:00Z') }"),
    projection: doc('{ item: 1, _id: 0 }'),
    sort: doc('{ qty: -1 }'),
    skip: 10,
    limit: 20,
    collation: doc("{ locale: 'fr', strength: 1 }"),
    hint: 'status_1',
    maxTimeMS: 5000,
  };

  it('prints the chain beside the builder', () => {
    expect(formatFindText('orders', model)).toBe(
      "db.orders.find({ status: 'A', qty: { $lt: 30 }, when: ISODate('2024-01-01T00:00:00.000Z') }, { item: 1, _id: 0 }).sort({ qty: -1 }).skip(10).limit(20).collation({ locale: 'fr', strength: 1 }).hint('status_1').maxTimeMS(5000)",
    );
    expect(formatFindText('my-coll', { filter: {} })).toBe("db.getCollection('my-coll').find({})");
    expect(formatFindText('stats', { filter: {}, limit: 0 })).toBe(
      "db.getCollection('stats').find({})",
    );
    expect(formatFindText('orders', model, { multiline: true })).toContain(
      '\n  .sort({ qty: -1 })',
    );
  });

  it('parses its own output back to the same model', () => {
    for (const multiline of [false, true]) {
      const parsed = parseFindText(formatFindText('orders', model, { multiline }));
      expect(parsed.collection).toBe('orders');
      expect(toFindQuery(parsed.query)).toEqual(toFindQuery(model));
    }
  });

  it('accepts the forms users type', () => {
    expect(parseFindText(`db.getCollection("a b").find({ x: 1 })`).collection).toBe('a b');
    expect(parseFindText(`db['c'].find()`).collection).toBe('c');
    const bare = parseFindText('find({ a: 1 }, { a: 1 }, { sort: { a: 1 }, limit: 5, skip: 1 })');
    expect(bare.collection).toBeUndefined();
    expect(toFindQuery(bare.query)).toMatchObject({ limit: 5, skip: 1 });
    expect(toEjson(bare.query.sort)).toBe(toEjson({ a: new Int32(1) }));
    const filterOnly = parseFindText('{ a: /x/i } // just a filter');
    expect(Object.keys(filterOnly.query.filter)).toEqual(['a']);
    expect(parseFindText('db.c.find().pretty();').query.filter).toEqual({});
    expect(parseFindText('db.c.find().hint({ a: 1 })').query.hint).toEqual({ a: new Int32(1) });
  });

  it('names the problem with line and column', () => {
    const fail = (text: string): ShellParseError => {
      try {
        parseFindText(text);
      } catch (error) {
        if (error instanceof ShellParseError) return error;
      }
      throw new Error('expected a parse error');
    };
    expect(fail('db.c.find({ a: 1 }).limit(-1)').message).toContain(
      'limit() expects a non-negative integer',
    );
    expect(fail('db.c.find().toArray()').message).toContain('Unsupported cursor method "toArray"');
    expect(fail('db.c.update({})').message).toContain('Expected find(...)');
    expect(fail('db.c.find(\n  { a: 1 ').line).toBe(2);
    expect(fail('db.my-coll.find()').hint).toContain('getCollection');
    expect(fail('db.c.find(1)').message).toContain('The filter must be a document');
  });

  it('round-trips through the cross-process form', () => {
    expect(toEjson(fromFindQuery(toFindQuery(model)).filter)).toBe(toEjson(model.filter));
    expect(fromFindQuery({}).filter).toEqual({});
    expect(() => fromFindQuery({ filter: '[1]' })).toThrow('must be a document');
    expect(fromFindQuery({ hint: '"idx"' }).hint).toBe('idx');
  });

  it('references collections safely', () => {
    expect(collectionReference('users')).toBe('db.users');
    expect(collectionReference('system.views')).toBe("db.getCollection('system.views')");
    expect(collectionReference("it's")).toBe("db.getCollection('it\\'s')");
  });

  it('round-trips generated models (fuzz)', () => {
    const name = fc.string({ minLength: 1, maxLength: 10 });
    fc.assert(
      fc.property(
        name,
        fc.dictionary(
          fc.string({ maxLength: 6 }).filter((k) => !k.startsWith('$')),
          fc.integer(),
        ),
        fc.option(fc.nat(1000), { nil: undefined }),
        fc.option(fc.nat(1000), { nil: undefined }),
        (collection, filter, skip, limit) => {
          const query: QueryModel = {
            filter: parseShellDocument(toEjson(filter)),
            ...(skip ? { skip } : {}),
            ...(limit ? { limit } : {}),
          };
          const parsed = parseFindText(formatFindText(collection, query));
          expect(parsed.collection).toBe(collection);
          expect(toFindQuery(parsed.query)).toEqual(toFindQuery(query));
        },
      ),
      { numRuns: 200 },
    );
  });
});
