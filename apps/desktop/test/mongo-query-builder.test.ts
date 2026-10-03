import {
  Int32,
  ObjectId,
  analyzeSchema,
  formatFindText,
  parseFindText,
  toEjson,
  type SchemaAnalysis,
} from '@querybara/mongo-tools';
import { describe, expect, it, vi } from 'vitest';

import { CollectionView } from '../src/renderer/src/state/mongo/collection-view';
import { QueryBuilder } from '../src/renderer/src/state/mongo/query-builder';
import {
  EMPTY_BUILDER_QUERY,
  addProjection,
  buildQuery,
  builderFields,
  countIssue,
  listText,
  moveItem,
  newCondition,
  operatorsFor,
  parseList,
  parseValue,
  projectionIssue,
  readQuery,
  valueText,
  withOperator,
  type BuilderField,
  type BuilderQuery,
  type Condition,
  type ConditionOperator,
  type FilterItem,
  type ValueType,
} from '../src/renderer/src/state/mongo/query-builder-model';

/**
 * The visual query builder (spec §9, "Browsing and editing"): the field list from a schema
 * sample, conditions to a typed filter and back, projection and sort rules, the queries it
 * cannot show, and the builder kept in step with the collection view's find() text.
 */

let seq = 0;

function cond(
  path: string,
  operator: ConditionOperator,
  valueType: ValueType,
  text: string,
  flags = '',
): Condition {
  seq += 1;
  return { kind: 'condition', id: `c${seq}`, path, operator, valueType, text, flags };
}

function or(...conditions: Condition[]): FilterItem {
  seq += 1;
  return { kind: 'or', id: `g${seq}`, conditions };
}

function query(filter: FilterItem[], rest: Partial<BuilderQuery> = {}): BuilderQuery {
  return { ...EMPTY_BUILDER_QUERY, filter, ...rest };
}

/** The builder's find() text for the orders collection. */
function textOf(q: BuilderQuery): string {
  const built = buildQuery(q);
  if (!built.ok) throw new Error(built.message);
  return formatFindText('orders', built.model);
}

function filterEjson(q: BuilderQuery): string {
  const built = buildQuery(q);
  if (!built.ok) throw new Error(built.message);
  return toEjson(built.model.filter);
}

/** The builder state of find() text. */
function readText(text: string): BuilderQuery {
  const result = readQuery(parseFindText(text).query);
  if (!result.ok) throw new Error(result.reason);
  return result.query;
}

/** The builder state of find() text, without ids. */
function read(text: string): unknown {
  return strip(readText(text));
}

function reason(text: string): string | undefined {
  const result = readQuery(parseFindText(text).query);
  return result.ok ? undefined : result.reason;
}

function strip(q: BuilderQuery): unknown {
  const bare = (c: Condition) => ({
    path: c.path,
    operator: c.operator,
    valueType: c.valueType,
    text: c.text,
    flags: c.flags,
  });
  return {
    ...q,
    filter: q.filter.map((item) =>
      item.kind === 'or' ? { or: item.conditions.map(bare) } : bare(item),
    ),
  };
}

function value(text: string, type: ValueType): string {
  const parsed = parseValue(text, type);
  if (!parsed.ok) throw new Error(parsed.message);
  return toEjson(parsed.value);
}

function problem(text: string, type: ValueType): string | undefined {
  const parsed = parseValue(text, type);
  return parsed.ok ? undefined : parsed.message;
}

const ORDER_ID = '65f1a2b3c4d5e6f708192a3b';
const REF = '0f8fad5b-d9cb-469f-a165-70867728950e';

describe('the field list', () => {
  const analysis: SchemaAnalysis = analyzeSchema([
    {
      _id: new ObjectId(ORDER_ID),
      status: 'open',
      total: new Int32(5),
      note: null,
      customer: { name: 'Ada', address: { city: 'London' } },
      tags: ['red', 'big'],
      items: [{ sku: 'a', qty: new Int32(1) }],
    },
    {
      _id: new ObjectId(),
      status: 'shipped',
      total: new Int32(7),
      note: 'fragile',
      customer: { name: 'Bob', address: { city: 'Paris' } },
      tags: [],
      items: [],
    },
    { _id: new ObjectId(), status: 'open', total: new Int32(9) },
  ]);
  const fields = builderFields(analysis);

  it('lists nested paths and array fields with their dominant BSON type', () => {
    expect(fields.map((f) => [f.path, f.type, f.elementType, f.depth])).toEqual([
      ['_id', 'objectId', undefined, 0],
      ['status', 'string', undefined, 0],
      ['total', 'int', undefined, 0],
      // Nulls count only when nothing else was seen.
      ['note', 'string', undefined, 0],
      ['customer', 'object', undefined, 0],
      ['customer.name', 'string', undefined, 1],
      ['customer.address', 'object', undefined, 1],
      ['customer.address.city', 'string', undefined, 2],
      ['tags', 'array', 'string', 0],
      ['items', 'array', 'object', 0],
      ['items.sku', 'string', undefined, 1],
      ['items.qty', 'int', undefined, 1],
    ]);
    const byPath = new Map(fields.map((f) => [f.path, f]));
    expect(byPath.get('items.sku')?.display).toBe('items[].sku');
    expect(byPath.get('note')?.types).toEqual(['null', 'string']);
    expect(byPath.get('customer')?.share).toBeCloseTo(2 / 3);
    expect(byPath.get('status')?.suggestions).toEqual(['open', 'shipped']);
    expect(byPath.get('total')?.suggestions).toEqual(['5', '7', '9']);
    expect(byPath.get('tags')?.suggestions).toEqual(['red', 'big']);
    expect(byPath.get('customer')?.suggestions).toEqual([]);
  });

  it('offers the operators that fit the type', () => {
    const byPath = new Map(fields.map((f) => [f.path, f]));
    const status = operatorsFor(byPath.get('status'));
    expect(status).toContain('$regex');
    expect(status).toContain('$gt');
    expect(status).not.toContain('$size');
    const tags = operatorsFor(byPath.get('tags'));
    expect(tags).toEqual(expect.arrayContaining(['$all', '$size', '$regex', '$in']));
    const flag: BuilderField = { ...byPath.get('status')!, type: 'bool', suggestions: [] };
    expect(operatorsFor(flag)).toEqual(['$eq', '$ne', '$in', '$nin', '$exists', '$type', 'null']);
    // A path typed in (not sampled) gets every operator but the array ones.
    expect(operatorsFor(undefined)).not.toContain('$all');
  });

  it('starts a condition in the field’s own type', () => {
    const byPath = new Map(fields.map((f) => [f.path, f]));
    expect(newCondition('total', byPath.get('total'))).toMatchObject({
      operator: '$eq',
      valueType: 'int',
      text: '',
    });
    expect(newCondition('_id', byPath.get('_id'))).toMatchObject({ valueType: 'objectId' });
    expect(newCondition('tags', byPath.get('tags'))).toMatchObject({ valueType: 'string' });
    expect(newCondition('customer', byPath.get('customer'))).toMatchObject({
      operator: '$exists',
      text: 'true',
    });
    expect(newCondition('custom.path', undefined)).toMatchObject({ valueType: 'string' });
  });
});

describe('typed values', () => {
  it('produces Extended JSON of the chosen BSON type', () => {
    expect(value('open', 'string')).toBe('"open"');
    expect(value('42', 'int')).toBe('{"$numberInt":"42"}');
    expect(value('42', 'long')).toBe('{"$numberLong":"42"}');
    expect(value('9007199254740993', 'long')).toBe('{"$numberLong":"9007199254740993"}');
    expect(value('42', 'double')).toBe('{"$numberDouble":"42.0"}');
    expect(value('-1.5e3', 'double')).toBe('{"$numberDouble":"-1500.0"}');
    expect(value('9.990', 'decimal')).toBe('{"$numberDecimal":"9.990"}');
    expect(value(ORDER_ID.toUpperCase(), 'objectId')).toBe(`{"$oid":"${ORDER_ID}"}`);
    expect(value('2026-01-31', 'date')).toBe('{"$date":{"$numberLong":"1769817600000"}}');
    expect(value('2026-01-31T10:00:00+02:00', 'date')).toBe(
      '{"$date":{"$numberLong":"1769846400000"}}',
    );
    expect(value('false', 'bool')).toBe('false');
    expect(value(REF, 'uuid')).toBe(
      '{"$binary":{"base64":"D4+tW9nLRp+hZXCGdyiVDg==","subType":"04"}}',
    );
    expect(value('{ a: NumberLong(1) }', 'shell')).toBe('{"a":{"$numberLong":"1"}}');
  });

  it('says what is wrong with a value', () => {
    expect(problem('', 'string')).toBe('Enter a value');
    expect(problem('1.5', 'int')).toBe('Enter a whole number');
    expect(problem('3000000000', 'int')).toBe('Out of the Int32 range: use Int64');
    expect(problem('12abc', 'double')).toBe('Enter a number');
    expect(problem('1.00000000000000000000000000000000000001', 'decimal')).toMatch(/34 digits/);
    expect(problem('abc', 'objectId')).toBe('An ObjectId is 24 hexadecimal digits');
    expect(problem('yesterday', 'date')).toMatch(/ISO date/);
    expect(problem('yes', 'bool')).toBe('Pick true or false');
    expect(problem('{ a: ', 'shell')).toBe('Expected a value but found the end of the text');
  });

  it('shows values back in the type that reads them to the same BSON value', () => {
    for (const [text, type] of [
      ['open', 'string'],
      ['42', 'int'],
      ['9007199254740993', 'long'],
      ['0.5', 'double'],
      ['9.990', 'decimal'],
      [ORDER_ID, 'objectId'],
      ['2026-01-31T10:00:00.000Z', 'date'],
      ['true', 'bool'],
      [REF, 'uuid'],
      ['[ 1, 2 ]', 'shell'],
    ] as const) {
      const parsed = parseValue(text, type);
      if (!parsed.ok) throw new Error(parsed.message);
      expect(valueText(parsed.value)).toEqual({ type, text });
    }
    // What a one-line editor would change goes as mongosh text.
    expect(valueText('')).toEqual({ type: 'shell', text: "''" });
    expect(valueText('two\nlines')).toEqual({ type: 'shell', text: "'two\\nlines'" });
  });

  it('reads lists one value per line, and shows mixed lists in mongosh syntax', () => {
    const parsed = parseList('1\n\n2\n', 'long');
    expect(parsed.ok && toEjson(parsed.value)).toBe('[{"$numberLong":"1"},{"$numberLong":"2"}]');
    expect(parseList('1\nx', 'int')).toEqual({
      ok: false,
      message: 'Line 2: Enter a whole number',
    });
    expect(parseList(' \n', 'string')).toMatchObject({ ok: false });
    expect(listText(['a', 'b'])).toEqual({ type: 'string', text: 'a\nb' });
    expect(listText(['a', new Int32(1)])).toEqual({ type: 'shell', text: "'a'\n1" });
  });

  it('keeps what it can of the value when the operator changes', () => {
    const total: BuilderField = {
      path: 'total',
      display: 'total',
      name: 'total',
      depth: 0,
      type: 'int',
      types: ['int'],
      share: 1,
      suggestions: [],
    };
    const eq = cond('total', '$eq', 'int', '5');
    expect(withOperator(eq, '$in', total)).toMatchObject({ operator: '$in', text: '5' });
    const list = cond('total', '$in', 'int', '\n5\n6');
    expect(withOperator(list, '$gt', total)).toMatchObject({ text: '5', valueType: 'int' });
    expect(withOperator(eq, '$exists', total)).toMatchObject({ text: 'true' });
    expect(withOperator(eq, '$type', total)).toMatchObject({ text: 'int' });
    const isNull = cond('total', 'null', 'string', '');
    expect(withOperator(isNull, '$lt', total)).toMatchObject({ valueType: 'int', text: '' });
  });
});

describe('builder to filter', () => {
  it('combines conditions with AND, one operator document per path', () => {
    const q = query([
      cond('status', '$eq', 'string', 'open'),
      cond('total', '$gt', 'int', '100'),
      cond('customer.address.city', '$in', 'string', 'London\nParis'),
      cond('total', '$lte', 'int', '500'),
    ]);
    expect(textOf(q)).toBe(
      "db.orders.find({ status: 'open', total: { $gt: 100, $lte: 500 }, 'customer.address.city': { $in: [ 'London', 'Paris' ] } })",
    );
    expect(filterEjson(q)).toBe(
      '{"status":"open","total":{"$gt":{"$numberInt":"100"},"$lte":{"$numberInt":"500"}},"customer.address.city":{"$in":["London","Paris"]}}',
    );
  });

  it('keeps each value’s BSON type in the Extended JSON', () => {
    const q = query([
      cond('_id', '$eq', 'objectId', ORDER_ID),
      cond('big', '$gte', 'long', '5'),
      cond('ratio', '$lt', 'double', '1'),
      cond('price', '$eq', 'decimal', '9.99'),
      cond('at', '$gte', 'date', '2026-01-01'),
      cond('ref', '$eq', 'uuid', REF),
      cond('paid', '$eq', 'bool', 'true'),
    ]);
    expect(filterEjson(q)).toBe(
      `{"_id":{"$oid":"${ORDER_ID}"},"big":{"$gte":{"$numberLong":"5"}},"ratio":{"$lt":{"$numberDouble":"1.0"}},"price":{"$numberDecimal":"9.99"},"at":{"$gte":{"$date":{"$numberLong":"1767225600000"}}},"ref":{"$binary":{"base64":"D4+tW9nLRp+hZXCGdyiVDg==","subType":"04"}},"paid":true}`,
    );
    expect(textOf(q)).toBe(
      `db.orders.find({ _id: ObjectId('${ORDER_ID}'), big: { $gte: Long('5') }, ratio: { $lt: 1.0 }, price: Decimal128('9.99'), at: { $gte: ISODate('2026-01-01T00:00:00.000Z') }, ref: UUID('${REF}'), paid: true })`,
    );
  });

  it('writes the operators without a typed value', () => {
    const q = query([
      cond('note', 'null', 'string', ''),
      cond('gone', '$exists', 'bool', 'false'),
      cond('kind', '$type', 'string', 'decimal'),
      cond('tags', '$size', 'int', '2'),
      cond('name', '$regex', 'string', '^a.*z$', 'xi'),
      cond('tags', '$all', 'string', 'red\nbig'),
    ]);
    expect(textOf(q)).toBe(
      "db.orders.find({ note: null, gone: { $exists: false }, kind: { $type: 'decimal' }, tags: { $size: 2, $all: [ 'red', 'big' ] }, name: { $regex: /^a.*z$/ix } })",
    );
  });

  it('puts OR groups in $or, later ones and repeated operators in $and', () => {
    const q = query([
      cond('status', '$eq', 'string', 'open'),
      or(cond('total', '$gt', 'int', '100'), cond('note', 'null', 'string', '')),
      or(cond('tags', '$size', 'int', '0'), cond('tags', '$exists', 'bool', 'false')),
      cond('total', '$ne', 'int', '1'),
      cond('total', '$ne', 'int', '2'),
    ]);
    expect(textOf(q)).toBe(
      "db.orders.find({ status: 'open', $or: [ { total: { $gt: 100 } }, { note: null } ], total: { $ne: 1 }, $and: [ { $or: [ { tags: { $size: 0 } }, { tags: { $exists: false } } ] }, { total: { $ne: 2 } } ] })",
    );
    // An empty group adds nothing.
    expect(textOf(query([or(), cond('a', '$eq', 'int', '1')]))).toBe('db.orders.find({ a: 1 })');
  });

  it('reports every incomplete condition, and builds nothing until they are fixed', () => {
    const bad = cond('total', '$gt', 'int', 'lots');
    const q = query([cond('status', '$eq', 'string', 'open'), or(bad)], { limit: '-1' });
    const built = buildQuery(q);
    expect(built).toEqual({
      ok: false,
      issues: {
        conditions: { [bad.id]: 'Enter a whole number' },
        limit: 'Limit must be a whole number',
      },
      message: 'Filter on total: Enter a whole number',
    });
    expect(buildQuery(query([cond('$where', '$eq', 'string', 'x')]))).toMatchObject({
      ok: false,
      message: 'Filter on $where: This field name cannot be queried from the builder',
    });
  });
});

describe('projection, sort, skip and limit', () => {
  it('follows MongoDB’s projection rule: include or exclude, only _id may differ', () => {
    expect(
      projectionIssue([
        { path: 'a', include: true },
        { path: '_id', include: false },
      ]),
    ).toBe(undefined);
    expect(
      projectionIssue([
        { path: 'a', include: false },
        { path: '_id', include: true },
      ]),
    ).toBe(undefined);
    expect(
      projectionIssue([
        { path: 'a', include: true },
        { path: 'b', include: false },
      ]),
    ).toMatch(/either includes or excludes/);
    expect(addProjection([], 'a')).toEqual([{ path: 'a', include: true }]);
    expect(addProjection([{ path: 'a', include: true }], '_id')).toEqual([
      { path: 'a', include: true },
      { path: '_id', include: false },
    ]);
    expect(addProjection([{ path: 'a', include: false }], 'b')).toEqual([
      { path: 'a', include: false },
      { path: 'b', include: false },
    ]);
    expect(addProjection([{ path: 'a', include: true }], 'a')).toHaveLength(1);
    const mixed = buildQuery(
      query([], {
        projection: [
          { path: 'a', include: true },
          { path: 'b', include: false },
        ],
      }),
    );
    expect(mixed).toMatchObject({ ok: false, message: expect.stringMatching(/^Projection: /) });
  });

  it('builds projection, sort, skip and limit', () => {
    const q = query([], {
      projection: [
        { path: 'status', include: true },
        { path: '_id', include: false },
      ],
      sort: [
        { path: 'total', direction: -1 },
        { path: '_id', direction: 1 },
      ],
      skip: '10',
      limit: ' 5 ',
    });
    expect(textOf(q)).toBe(
      'db.orders.find({}, { status: 1, _id: 0 }).sort({ total: -1, _id: 1 }).skip(10).limit(5)',
    );
    const built = buildQuery(q);
    expect(built.ok && toEjson(built.model.projection)).toBe(
      '{"status":{"$numberInt":"1"},"_id":{"$numberInt":"0"}}',
    );
    expect(textOf(query([], { skip: '0', limit: '' }))).toBe('db.orders.find({})');
    expect(countIssue('1e3', 'Skip')).toBe('Skip must be a whole number');
    expect(countIssue('99999999999999999999', 'Limit')).toBe('Limit is too large');
    expect(moveItem(['a', 'b', 'c'], 2, 0)).toEqual(['c', 'a', 'b']);
    expect(moveItem(['a', 'b'], 0, 5)).toEqual(['a', 'b']);
  });
});

describe('filter to builder', () => {
  it('reads back what it writes', () => {
    // In the order the filter puts them: one path's conditions together, $and last.
    const q = query(
      [
        cond('status', '$eq', 'string', 'open'),
        cond('total', '$gt', 'int', '100'),
        cond('total', '$lte', 'int', '500'),
        cond('total', '$ne', 'int', '1'),
        or(
          cond('note', 'null', 'string', ''),
          cond('at', '$lt', 'date', '2026-02-01T00:00:00.000Z'),
        ),
        cond('name', '$regex', 'string', '^A', 'i'),
        cond('tags', '$all', 'string', 'red\nbig'),
        cond('kind', '$type', 'string', 'string'),
        cond('gone', '$exists', 'bool', 'false'),
        cond('price', '$eq', 'decimal', '9.99'),
        cond('ref', '$in', 'uuid', REF),
        cond('paid', '$eq', 'bool', 'true'),
        cond('_id', '$nin', 'objectId', ORDER_ID),
        cond('meta', '$eq', 'shell', '{ a: 1 }'),
        or(cond('big', '$eq', 'long', '9007199254740993'), cond('ratio', '$ne', 'double', '0.5')),
        cond('total', '$ne', 'int', '2'),
      ],
      {
        projection: [
          { path: 'status', include: true },
          { path: '_id', include: false },
        ],
        sort: [{ path: 'total', direction: -1 }],
        skip: '10',
        limit: '5',
      },
    );
    const text = textOf(q);
    expect(read(text)).toEqual(strip(q));
    expect(textOf(readText(text))).toBe(text);
  });

  it('reads the other ways of writing the same conditions', () => {
    expect(
      read("db.orders.find({ name: /^A/i, $and: [ { a: 1 }, { $and: [ { b: 'x' } ] } ] })"),
    ).toEqual(
      strip(
        query([
          cond('name', '$regex', 'string', '^A', 'i'),
          cond('a', '$eq', 'int', '1'),
          cond('b', '$eq', 'string', 'x'),
        ]),
      ),
    );
    expect(
      read(
        "db.orders.find({ name: { $regex: '^A', $options: 'i' }, a: { $exists: 1 }, b: { $type: 2 }, c: { $eq: null } })",
      ),
    ).toEqual(
      strip(
        query([
          cond('name', '$regex', 'string', '^A', 'i'),
          cond('a', '$exists', 'bool', 'true'),
          cond('b', '$type', 'string', 'string'),
          cond('c', 'null', 'string', ''),
        ]),
      ),
    );
    expect(read("db.orders.find({ tags: [ 'a', 'b' ], note: '' }, { a: true, b: 5 })")).toEqual(
      strip(
        query([cond('tags', '$eq', 'shell', "[ 'a', 'b' ]"), cond('note', '$eq', 'shell', "''")], {
          projection: [
            { path: 'a', include: true },
            { path: 'b', include: true },
          ],
        }),
      ),
    );
    expect(textOf(readText('db.orders.find({ name: /^A/i })'))).toBe(
      'db.orders.find({ name: { $regex: /^A/i } })',
    );
  });

  it('says why a query cannot be shown', () => {
    expect(reason('db.orders.find({ items: { $elemMatch: { qty: { $gt: 1 } } } })')).toBe(
      '$elemMatch is not in the builder',
    );
    expect(reason('db.orders.find({ total: { $not: { $gt: 5 } } })')).toBe(
      '$not is not in the builder',
    );
    expect(reason("db.orders.find({ $expr: { $gt: [ '$a', '$b' ] } })")).toBe(
      '$expr is not in the builder',
    );
    expect(reason('db.orders.find({ $nor: [ { a: 1 } ] })')).toBe('$nor is not in the builder');
    const oneLevel = 'The builder shows one level of OR, with one condition per $or branch';
    expect(reason('db.orders.find({ $or: [ { a: 1, b: 2 } ] })')).toBe(oneLevel);
    expect(reason('db.orders.find({ $or: [ { $or: [ { a: 1 } ] } ] })')).toBe(oneLevel);
    expect(reason('db.orders.find({ $or: [ { a: { $gt: 1, $lt: 5 } } ] })')).toBe(oneLevel);
    expect(reason('db.orders.find({ a: { $gt: 1, b: 2 } })')).toBe(
      'The condition on a mixes operators and fields',
    );
    expect(reason("db.orders.find({ a: { $type: [ 'string', 'int' ] } })")).toBe(
      '$type on a lists several types',
    );
    expect(reason('db.orders.find({ a: { $in: [] } })')).toBe('$in on a needs a non-empty list');
    expect(reason("db.orders.find({ a: { $regex: /x/, $options: 'i' } })")).toBe(
      '$regex on a has flags in two places',
    );
    expect(reason("db.orders.find({ a: { $options: 'i' } })")).toBe(
      '$options on a comes without $regex',
    );
    expect(reason('db.orders.find({}, { items: { $slice: 2 } })')).toBe(
      'The projection of items is an expression',
    );
    expect(reason("db.orders.find({}, { label: '$name' })")).toBe(
      'The projection of label is an expression',
    );
    expect(reason("db.orders.find({}).sort({ score: { $meta: 'textScore' } })")).toBe(
      "Sorting by { $meta: 'textScore' } on score",
    );
  });
});

describe('the builder in a collection view', () => {
  function view(): CollectionView {
    return new CollectionView('panel', {
      profileId: 'mongo-profile',
      db: 'shop',
      collection: 'orders',
      kind: 'collection',
    });
  }

  it('writes each valid change to the find() text, and asks for the fix before running', async () => {
    const v = view();
    const b = v.builder;
    const status = b.addCondition('status')!;
    expect(b.pendingIssue()).toBe('Filter on status: Enter a value');
    expect(v.state.findText).toBe('db.orders.find({})');
    await v.run();
    expect(v.state.notice).toEqual({
      kind: 'error',
      text: 'Fix the query first. Filter on status: Enter a value',
    });
    expect(v.state.active).toBeUndefined();

    b.updateCondition(status, { text: 'open' });
    expect(b.pendingIssue()).toBeUndefined();
    expect(v.state.findText).toBe("db.orders.find({ status: 'open' })");
    expect(v.state.fields.filter).toBe("{ status: 'open' }");

    const total = b.addCondition('total')!;
    b.updateCondition(total, { operator: '$gt', valueType: 'int', text: '100' });
    b.addSort('total');
    b.setSortDirection('total', -1);
    b.addProjection('total');
    b.setLimit('5');
    expect(v.state.findText).toBe(
      "db.orders.find({ status: 'open', total: { $gt: 100 } }, { total: 1 }).sort({ total: -1 }).limit(5)",
    );
    // The builder keeps its own state (row ids and all) through its own writes.
    expect(b.state.query.filter.map((item) => item.id)).toEqual([status, total]);

    const group = b.addOrGroup('note')!;
    const gone = b.addCondition('gone', group.group)!;
    b.updateCondition(group.condition!, { operator: 'null' });
    b.updateCondition(gone, { operator: '$exists', text: 'false' });
    expect(v.state.fields.filter).toBe(
      "{ status: 'open', total: { $gt: 100 }, $or: [ { note: null }, { gone: { $exists: false } } ] }",
    );
    b.removeGroup(group.group);
    b.removeCondition(status);
    b.removeSort('total');
    b.removeProjection('total');
    b.setLimit('');
    expect(v.state.findText).toBe('db.orders.find({ total: { $gt: 100 } })');
  });

  it('follows the text, blocks on what it cannot show, and keeps what it does not edit', () => {
    const v = view();
    const b = v.builder;
    v.setFindText(
      "db.orders.find({ status: 'shipped', $or: [ { total: { $lt: 10 } }, { note: null } ] }).skip(2)",
    );
    expect(strip(b.state.query)).toEqual(
      strip(
        query(
          [
            cond('status', '$eq', 'string', 'shipped'),
            or(cond('total', '$lt', 'int', '10'), cond('note', 'null', 'string', '')),
          ],
          { skip: '2' },
        ),
      ),
    );

    v.setFindText('db.orders.find({ items: { $elemMatch: { qty: 2 } } })');
    expect(b.state.blocked).toEqual({
      kind: 'unsupported',
      message: '$elemMatch is not in the builder',
    });
    expect(b.addCondition('status')).toBeUndefined();
    b.setLimit('3');
    expect(v.state.findText).toBe('db.orders.find({ items: { $elemMatch: { qty: 2 } } })');
    expect(b.pendingIssue()).toBeUndefined();
    // Read, but not something the builder could write back.
    v.setFindText("db.orders.find({ name: { $regex: 'x', $options: 'g' } })");
    expect(b.state.blocked).toEqual({
      kind: 'unsupported',
      message: 'Filter on name: Flags can be i, m, s, u and x',
    });

    v.setFindText('db.orders.find({ a: ');
    expect(b.state.blocked?.kind).toBe('invalid');
    v.setFindText('db.orders.find({ a: 1 })');
    expect(b.state.blocked).toBeUndefined();
    expect(strip(b.state.query)).toEqual(strip(query([cond('a', '$eq', 'int', '1')])));

    // The fields drive it too, and an invalid field blocks it.
    v.setField('limit', '7');
    expect(b.state.query.limit).toBe('7');
    v.setField('sort', '{ a: ');
    expect(b.state.blocked).toEqual({
      kind: 'invalid',
      message: 'The Sort field has an error: fix it to keep building.',
    });
    v.setField('sort', '');
    expect(b.state.blocked).toBeUndefined();

    // Hint, collation and maxTimeMS come from the text and stay.
    v.setFindText("db.orders.find({ a: 1 }).hint('a_1')");
    b.setLimit('3');
    expect(v.state.findText).toBe("db.orders.find({ a: 1 }).limit(3).hint('a_1')");
    b.dispose();
  });

  it('empties with Reset', async () => {
    const v = view();
    v.setFindText('db.orders.find({ a: 1 }).limit(4)');
    expect(v.builder.state.query.filter).toHaveLength(1);
    v.store.setState({ fields: { filter: '', projection: '', sort: '', skip: '', limit: '' } });
    expect(v.builder.state.query).toEqual(EMPTY_BUILDER_QUERY);
    await v.dispose();
  });

  it('samples the fields the first time the builder shows', async () => {
    const v = view();
    const analysis = analyzeSchema([{ _id: 1, status: 'open', total: new Int32(3) }]);
    const sample = vi.fn(() => Promise.resolve(analysis));
    const b = new QueryBuilder({
      collection: 'orders',
      query: () => v.state,
      subscribe: (listener) => v.store.subscribe(listener),
      setFindText: (text) => v.setFindText(text),
      sample,
    });
    b.setMode('builder');
    expect(b.state.sample.status).toBe('loading');
    await vi.waitFor(() => expect(b.state.sample.status).toBe('done'));
    expect(b.state.sample.documentCount).toBe(1);
    expect(b.state.sample.fields.map((f) => f.path)).toEqual(['_id', 'status', 'total']);
    expect(sample).toHaveBeenCalledWith(1000, expect.any(AbortSignal));
    b.setMode('fields');
    b.setMode('builder');
    expect(sample).toHaveBeenCalledTimes(1);
    // A condition on a sampled field starts in its type.
    const id = b.addCondition('total')!;
    expect(b.state.query.filter[0]).toMatchObject({ id, valueType: 'int' });

    sample.mockImplementationOnce(() => Promise.reject(new Error('not authorised')));
    await b.loadFields();
    expect(b.state.sample).toMatchObject({ status: 'error', error: 'not authorised' });
    b.dispose();
  });
});
