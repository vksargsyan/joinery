import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  NO_CLAUSES,
  buildDsl,
  dslBody,
  dslFields,
  emptyDslModel,
  formatJson,
  mappingFields,
  newAggregation,
  newCondition,
  newGroup,
  newRaw,
  newSort,
  operatorsFor,
  readDsl,
  splitList,
  valueJson,
  withOperator,
  type DslAggregation,
  type DslCondition,
  type DslField,
  type DslGroup,
  type DslItem,
  type DslModel,
  type DslSortItem,
  type DslTexts,
  type Occur,
} from '../src';

/**
 * The Elasticsearch query builder's model: fields from a mapping, the Query DSL each condition,
 * group, sort key and aggregation writes, what it reads back (clauses it does not break down
 * kept as JSON), and, for random models, that building what was read gives the same text.
 */

const MAPPING = JSON.stringify({
  mappings: {
    properties: {
      title: { type: 'text', fields: { keyword: { type: 'keyword', ignore_above: 256 } } },
      status: { type: 'keyword' },
      total: { type: 'long' },
      price: { type: 'double' },
      paid: { type: 'boolean' },
      created: { type: 'date' },
      client: { type: 'ip' },
      location: { type: 'geo_point' },
      customer: { properties: { city: { type: 'keyword' } } },
      items: {
        type: 'nested',
        properties: { sku: { type: 'keyword' }, qty: { type: 'integer' } },
      },
    },
  },
});

const FIELDS = dslFields(mappingFields(MAPPING));
const field = (path: string): DslField | undefined => FIELDS.find((f) => f.path === path);

function condition(
  path: string,
  patch: Partial<Omit<DslCondition, 'kind' | 'id' | 'field'>> = {},
): DslCondition {
  return newCondition(path, field(path), patch);
}

function group(
  clauses: Partial<Record<Occur, DslItem[]>>,
  patch: Partial<DslGroup> = {},
): DslGroup {
  return { ...newGroup(), clauses: { ...NO_CLAUSES, ...clauses }, ...patch };
}

function model(patch: Partial<DslModel>): DslModel {
  return { ...emptyDslModel(), ...patch };
}

function texts(m: DslModel): DslTexts {
  const built = buildDsl(m, FIELDS);
  if (!built.ok) throw new Error(built.message);
  return built.texts;
}

/** The query one condition writes, alone in the root. */
function queryOf(c: DslCondition): string {
  return texts(model({ query: group({ must: [c] }) })).query;
}

function problem(m: DslModel): string | undefined {
  const built = buildDsl(m, FIELDS);
  return built.ok ? undefined : built.message;
}

function read(input: Partial<DslTexts>): DslModel {
  const result = readDsl({ query: '', sort: '', aggs: '', ...input }, FIELDS);
  if (!result.ok) throw new Error(result.problem);
  return result.model;
}

/** Reads the texts and builds them again. */
function again(input: Partial<DslTexts>): DslTexts {
  return texts(read(input));
}

describe('fields', () => {
  it('lists the mapping depth first after _id, with kinds, nesting and keyword sub-fields', () => {
    expect(FIELDS.map((f) => [f.path, f.kind, f.depth])).toEqual([
      ['_id', 'keyword', 0],
      ['title', 'text', 0],
      ['title.keyword', 'keyword', 1],
      ['status', 'keyword', 0],
      ['total', 'number', 0],
      ['price', 'number', 0],
      ['paid', 'boolean', 0],
      ['created', 'date', 0],
      ['client', 'ip', 0],
      ['location', 'geo', 0],
      ['customer', 'object', 0],
      ['customer.city', 'keyword', 1],
      ['items', 'nested', 0],
      ['items.sku', 'keyword', 1],
      ['items.qty', 'number', 1],
    ]);
    expect(field('title')).toMatchObject({ keyword: 'title.keyword', multiField: false });
    expect(field('title.keyword')).toMatchObject({ multiField: true, name: 'keyword' });
    expect(field('items.sku')!.nested).toEqual(['items']);
    expect(field('items')!.nested).toEqual([]);
  });

  it('offers operators by kind, a Lucene query for every field', () => {
    expect(operatorsFor('title', field('title'))[0]).toBe('match');
    expect(operatorsFor('status', field('status'))).toContain('terms');
    expect(operatorsFor('created', field('created'))[0]).toBe('range');
    expect(operatorsFor('paid', field('paid'))).toEqual(['term', 'exists']);
    expect(operatorsFor('location', field('location'))[0]).toBe('geo_distance');
    expect(operatorsFor('', undefined)).toEqual(['query_string']);
    expect(operatorsFor('unmapped', undefined)).toContain('range');
  });
});

describe('conditions', () => {
  it('write the Query DSL of each operator', () => {
    const cases: [DslCondition, string][] = [
      [condition('title', { value: 'quick fox' }), '{"match": {"title": "quick fox"}}'],
      [
        condition('title', { operator: 'match_and', value: 'quick fox' }),
        '{"match": {"title": {"query": "quick fox", "operator": "and"}}}',
      ],
      [
        condition('title', { operator: 'match_phrase', value: 'quick fox' }),
        '{"match_phrase": {"title": "quick fox"}}',
      ],
      [
        condition('title', { operator: 'match_phrase_prefix', value: 'quick f' }),
        '{"match_phrase_prefix": {"title": "quick f"}}',
      ],
      [
        condition('', { value: 'status:paid AND total:>100' }),
        '{"query_string": {"query": "status:paid AND total:>100"}}',
      ],
      [
        condition('title', { operator: 'query_string', value: 'fox*' }),
        '{"query_string": {"query": "fox*", "default_field": "title"}}',
      ],
      [condition('status', { value: 'paid' }), '{"term": {"status": "paid"}}'],
      [
        condition('total', { value: '12345678901234567890' }),
        '{"term": {"total": 12345678901234567890}}',
      ],
      [condition('price', { value: '1.10' }), '{"term": {"price": 1.10}}'],
      [condition('paid'), '{"term": {"paid": true}}'],
      [
        condition('status', { operator: 'terms', value: 'paid, "sent, late", 42' }),
        '{"terms": {"status": ["paid", "sent, late", "42"]}}',
      ],
      [
        condition('total', { operator: 'terms', value: '1, 2,,3' }),
        '{"terms": {"total": [1, 2, 3]}}',
      ],
      [
        condition('created', { lower: 'now-7d/d', upper: 'now/d' }),
        '{"range": {"created": {"gte": "now-7d/d", "lt": "now/d"}}}',
      ],
      [
        condition('total', { operator: 'range', lower: '10', lowerInclusive: false }),
        '{"range": {"total": {"gt": 10}}}',
      ],
      [condition('customer'), '{"exists": {"field": "customer"}}'],
      [condition('status', { operator: 'prefix', value: 'pa' }), '{"prefix": {"status": "pa"}}'],
      [
        condition('status', { operator: 'wildcard', value: 'p*d' }),
        '{"wildcard": {"status": "p*d"}}',
      ],
      [
        condition('status', { operator: 'regexp', value: 'pa.+' }),
        '{"regexp": {"status": "pa.+"}}',
      ],
      [condition('status', { operator: 'fuzzy', value: 'piad' }), '{"fuzzy": {"status": "piad"}}'],
      [
        condition('location', { value: '52.52, 13.405' }),
        '{"geo_distance": {"distance": "10km", "location": "52.52,13.405"}}',
      ],
    ];
    for (const [c, expected] of cases) expect(queryOf(c)).toBe(expected);
  });

  it('types values by the mapping, and takes double quotes as a string', () => {
    expect(valueJson('42', 'number')).toEqual({ json: '42' });
    expect(valueJson('"42"', 'number')).toEqual({ json: '"42"' });
    expect(valueJson('42', 'keyword')).toEqual({ json: '"42"' });
    expect(valueJson('42', undefined)).toEqual({ json: '42' });
    expect(valueJson('true', undefined)).toEqual({ json: 'true' });
    expect(valueJson('  paid ', 'keyword')).toEqual({ json: '"paid"' });
    expect(valueJson('"say \\"hi\\""', 'keyword')).toEqual({ json: '"say \\"hi\\""' });
    expect(valueJson('ten', 'number')).toEqual({ problem: 'ten is not a number' });
    expect(valueJson('yes', 'boolean')).toEqual({ problem: 'true or false' });
    expect(valueJson('"open', 'keyword')).toEqual({
      problem: 'close the quotes, or leave them out',
    });
    expect(splitList(' a, "b, c" ,, "d\\"e" ')).toEqual(['a', '"b, c"', '"d\\"e"']);
  });

  it('say what is missing, the first problem first', () => {
    const one = (c: DslItem): string | undefined => problem(model({ query: group({ must: [c] }) }));
    expect(one(condition('status'))).toBe('status: type a value');
    expect(one(condition('total', { value: 'ten' }))).toBe('total: ten is not a number');
    expect(one(condition('title'))).toBe('title: type the text to match');
    expect(one(condition(''))).toBe('The Lucene query: type a Lucene query');
    expect(one(condition('', { operator: 'term' }))).toBe('Choose a field');
    expect(one(condition('status', { operator: 'terms', value: ' , ' }))).toBe(
      'status: type one value or more',
    );
    expect(one(condition('created'))).toBe('created: type a lower bound, an upper bound or both');
    expect(one(condition('location', { value: 'Berlin' }))).toBe(
      'location: type the point as lat,lon',
    );
    expect(one(condition('location', { value: '91,0' }))).toBe(
      'location: a latitude is within ±90, a longitude within ±180',
    );
    expect(one(condition('location', { value: '1,2', distance: 'far' }))).toBe(
      'location: type a distance such as 10km or 500m',
    );
    expect(one({ ...newRaw('{"ids": '), id: 'r' })).toMatch(/^The clause is not valid JSON/);
    expect(one(newRaw('[1]'))).toBe('The clause is a JSON object');
    const built = buildDsl(
      model({ query: group({ must: [condition('status'), condition('total')] }) }),
      FIELDS,
    );
    expect(built.ok ? [] : Object.keys(built.issues)).toHaveLength(2);
  });

  it('keep what they can of the value when the operator changes', () => {
    const terms = condition('status', { operator: 'terms', value: 'a, b' });
    expect(withOperator(terms, 'term').value).toBe('a');
    expect(withOperator(terms, 'range').lower).toBe('a');
    const range = condition('total', { operator: 'range', upper: '9' });
    expect(withOperator(range, 'term').value).toBe('9');
    expect(withOperator(condition('status'), 'geo_distance').distance).toBe('10km');
  });
});

describe('groups', () => {
  it('write a bool query, one must clause alone as itself, and nothing when empty', () => {
    const paid = condition('status', { value: 'paid' });
    const big = condition('total', { operator: 'range', lower: '100' });
    expect(texts(emptyDslModel())).toEqual({ query: '', sort: '', aggs: '' });
    expect(queryOf(paid)).toBe('{"term": {"status": "paid"}}');
    expect(texts(model({ query: group({ filter: [paid] }) })).query).toBe(
      '{"bool": {"filter": [{"term": {"status": "paid"}}]}}',
    );
    expect(
      texts(
        model({
          query: group(
            {
              must_not: [paid],
              should: [big, group({ must: [paid, big] })],
              must: [condition('title', { value: 'fox' })],
            },
            { minimumShouldMatch: '1' },
          ),
        }),
      ).query,
    ).toBe(
      '{"bool": {"must": [{"match": {"title": "fox"}}], "should": [{"range": {"total": {"gte": 100}}}, {"bool": {"must": [{"term": {"status": "paid"}}, {"range": {"total": {"gte": 100}}}]}}], "must_not": [{"term": {"status": "paid"}}], "minimum_should_match": 1}}',
    );
    expect(
      problem(model({ query: group({ should: [paid] }, { minimumShouldMatch: 'most' }) })),
    ).toBe('minimum_should_match is a number or a percentage, such as 1 or 75%');
  });

  it('wrap a nested group in a nested query, and warn about nested fields outside one', () => {
    const sku = condition('items.sku', { value: 'A-1' });
    const qty = condition('items.qty', { operator: 'range', lower: '2' });
    const nested = { ...group({ must: [sku, qty] }), path: 'items' };
    expect(texts(model({ query: group({ filter: [nested] }) })).query).toBe(
      '{"bool": {"filter": [{"nested": {"path": "items", "query": {"bool": {"must": [{"term": {"items.sku": "A-1"}}, {"range": {"items.qty": {"gte": 2}}}]}}}}]}}',
    );
    expect(texts(model({ query: group({ must: [{ ...newGroup('items') }] }) })).query).toBe(
      '{"nested": {"path": "items", "query": {"match_all": {}}}}',
    );
    const loose = buildDsl(model({ query: group({ must: [sku] }) }), FIELDS);
    expect(loose.ok && loose.warnings[sku.id]).toBe(
      'items.sku is inside the nested field items: outside a nested group on it, this matches no document',
    );
    const inside = buildDsl(model({ query: group({ must: [nested] }) }), FIELDS);
    expect(inside.ok && inside.warnings).toEqual({});
    expect(problem(model({ query: group({ must: [newGroup('status')] }) }))).toBe(
      'status is not a nested field',
    );
  });
});

describe('sort and aggregations', () => {
  it('write sort keys, a text field sorting by its keyword', () => {
    const sort: DslSortItem[] = [
      newSort('created', field('created')),
      { ...newSort('title', field('title')), missing: '_first' },
      newSort('_score', undefined),
      newRaw('{"_geo_distance": {"location": "52,13", "order": "asc"}}'),
    ];
    expect(texts(model({ sort })).sort).toBe(
      '[{"created": "desc"}, {"title.keyword": {"order": "asc", "missing": "_first"}}, {"_score": "desc"}, {"_geo_distance": {"location": "52,13", "order": "asc"}}]',
    );
  });

  it('write aggregations with sub-aggregations and unique names', () => {
    const byStatus = newAggregation('terms', 'status', field('status'), []);
    const perDay: DslAggregation = {
      ...newAggregation('date_histogram', 'created', field('created'), []),
      aggs: [
        newAggregation('avg', 'total', field('total'), []),
        { ...newAggregation('terms', 'title', field('title'), []), size: '3' },
      ],
    };
    const hourly = {
      ...newAggregation('date_histogram', 'created', field('created'), ['created_over_time']),
      interval: '30m',
      fixed: true,
    };
    const buckets = {
      ...newAggregation('histogram', 'price', field('price'), []),
      interval: '2.5',
    };
    const raw = {
      ...newAggregation('dsl', 'status', field('status'), []),
      name: 'paid_only',
      text: '{"filter": {"term": {"status": "paid"}}}',
    };
    expect(hourly.name).toBe('created_over_time_2');
    expect(texts(model({ aggs: [byStatus, perDay, hourly, buckets, raw] })).aggs).toBe(
      '{"by_status": {"terms": {"field": "status"}}, "created_over_time": {"date_histogram": {"field": "created", "calendar_interval": "1d"}, "aggs": {"avg_total": {"avg": {"field": "total"}}, "by_title_keyword": {"terms": {"field": "title.keyword", "size": 3}}}}, "created_over_time_2": {"date_histogram": {"field": "created", "fixed_interval": "30m"}}, "price_histogram": {"histogram": {"field": "price", "interval": 2.5}}, "paid_only": {"filter": {"term": {"status": "paid"}}}}',
    );
    const aggs = (list: DslAggregation[]): string | undefined => problem(model({ aggs: list }));
    expect(aggs([{ ...byStatus, name: '' }])).toBe('Name the aggregation');
    expect(aggs([{ ...byStatus, name: 'a>b' }])).toBe('a>b: an aggregation name has no [, ] or >');
    expect(aggs([byStatus, { ...byStatus, id: 'x' }])).toBe('by_status is used twice');
    expect(aggs([{ ...byStatus, size: '0' }])).toBe(
      'by_status: the size is a whole number above 0',
    );
    expect(aggs([{ ...buckets, interval: '-1' }])).toBe(
      'price_histogram: the interval is a number above 0',
    );
    expect(
      aggs([{ ...newAggregation('avg', 'total', field('total'), []), aggs: [byStatus] }]),
    ).toBe('avg_total: only bucket aggregations have sub-aggregations');
    expect(dslBody({ query: '{"match_all": {}}', sort: '', aggs: '{"a": {}}' })).toBe(
      '{"query": {"match_all": {}}, "aggs": {"a": {}}}',
    );
    expect(formatJson(dslBody(texts(model({ aggs: [byStatus] }))))).toContain('\n');
  });
});

describe('reading', () => {
  it('reads Lucene text as a query over every field, and match_all as nothing', () => {
    expect(again({ query: 'status:paid' }).query).toBe(
      '{"query_string": {"query": "status:paid"}}',
    );
    expect(again({ query: '{"match_all": {}}' }).query).toBe('');
    expect(read({ query: ' ' }).query.clauses).toEqual(NO_CLAUSES);
  });

  it('breaks bool queries down and keeps what it cannot show as JSON', () => {
    const kibana = `{
      "bool": {
        "filter": [
          {"range": {"created": {"gte": "now-15m", "format": "strict_date_optional_time"}}},
          {"match_phrase": {"status": {"query": "paid"}}},
          {"term": {"total": {"value": "42"}}}
        ],
        "must_not": {"exists": {"field": "refund"}},
        "should": [], "must": []
      }
    }`;
    const m = read({ query: kibana });
    expect(m.query.clauses.filter.map((item) => item.kind)).toEqual([
      'dsl',
      'condition',
      'condition',
    ]);
    expect(m.query.clauses.filter[0]).toMatchObject({
      text: '{"range": {"created": {"gte": "now-15m", "format": "strict_date_optional_time"}}}',
    });
    expect(m.query.clauses.filter[2]).toMatchObject({ operator: 'term', value: '"42"' });
    expect(texts(m).query).toBe(
      '{"bool": {"filter": [{"range": {"created": {"gte": "now-15m", "format": "strict_date_optional_time"}}}, {"match_phrase": {"status": "paid"}}, {"term": {"total": "42"}}], "must_not": [{"exists": {"field": "refund"}}]}}',
    );
    // A bool with more than clauses (a boost) is kept whole.
    expect(
      read({ query: '{"bool": {"must": [], "boost": 2}}' }).query.clauses.must[0],
    ).toMatchObject({ kind: 'dsl' });
    expect(
      read({ query: '{"match": {"title": {"query": "x", "operator": "or"}}}' }).query.clauses
        .must[0],
    ).toMatchObject({ operator: 'match' });
    expect(read({ query: '{"terms": {"status": []}}' }).query.clauses.must[0]!.kind).toBe('dsl');
    expect(read({ query: '{"term": {"paid": 1}}' }).query.clauses.must[0]!.kind).toBe('dsl');
  });

  it('reads values back as they were typed', () => {
    const value = (query: object): string =>
      (read({ query: JSON.stringify(query) }).query.clauses.must[0] as DslCondition).value;
    expect(value({ term: { status: 'paid' } })).toBe('paid');
    expect(value({ term: { status: ' padded ' } })).toBe('" padded "');
    expect(value({ term: { total: '7' } })).toBe('"7"');
    expect(value({ term: { unmapped: 'true' } })).toBe('"true"');
    expect(value({ term: { unmapped: true } })).toBe('true');
    expect(value({ terms: { status: ['a,b', 'c'] } })).toBe('"a,b", c');
    expect(value({ geo_distance: { distance: 500, location: { lat: 52.5, lon: 13.4 } } })).toBe(
      '52.5,13.4',
    );
    expect(value({ geo_distance: { distance: '1km', location: [13.4, 52.5] } })).toBe('52.5,13.4');
    const big = read({ query: '{"range": {"total": {"gt": 12345678901234567890}}}' });
    expect(big.query.clauses.must[0]).toMatchObject({
      lower: '12345678901234567890',
      lowerInclusive: false,
    });
  });

  it('reads nested queries as nested groups', () => {
    const query =
      '{"nested": {"path": "items", "query": {"bool": {"must": [{"term": {"items.sku": "A-1"}}, {"range": {"items.qty": {"gte": 2}}}]}}}}';
    const m = read({ query });
    expect(m.query.clauses.must[0]).toMatchObject({ kind: 'group', path: 'items' });
    expect(texts(m).query).toBe(query);
    expect(
      read({ query: '{"nested": {"path": "items", "query": {}, "score_mode": "max"}}' }).query
        .clauses.must[0]!.kind,
    ).toBe('dsl');
  });

  it('reads sort keys and aggregations, keeping the rest as JSON', () => {
    expect(
      again({
        sort: '["n", {"_score": {"order": "asc"}}, {"created": {"missing": "_last"}}, {"_script": {"type": "number"}}]',
      }).sort,
    ).toBe(
      '[{"n": "asc"}, {"_score": "asc"}, {"created": {"order": "asc", "missing": "_last"}}, {"_script": {"type": "number"}}]',
    );
    expect(again({ sort: '{"total": "desc"}' }).sort).toBe('[{"total": "desc"}]');
    const aggs = read({
      aggs: '{"by_status": {"terms": {"field": "status", "size": "5"}, "aggregations": {"top": {"terms": {"field": "status", "order": {"_key": "asc"}}}}}, "hours": {"date_histogram": {"field": "created", "interval": "1h"}}}',
    }).aggs;
    expect(aggs.map((a) => [a.name, a.type, a.size])).toEqual([
      ['by_status', 'terms', '5'],
      ['hours', 'dsl', ''],
    ]);
    expect(aggs[0]!.aggs.map((a) => a.type)).toEqual(['dsl']);
    expect(texts(model({ aggs })).aggs).toBe(
      '{"by_status": {"terms": {"field": "status", "size": 5}, "aggs": {"top": {"terms": {"field": "status", "order": {"_key": "asc"}}}}}, "hours": {"date_histogram": {"field": "created", "interval": "1h"}}}',
    );
  });

  it('refuses only text that is not valid JSON, naming the part', () => {
    const fail = (input: Partial<DslTexts>) =>
      readDsl({ query: '', sort: '', aggs: '', ...input }, FIELDS);
    expect(fail({ query: '{"term": ' })).toMatchObject({ ok: false, part: 'query' });
    expect(fail({ sort: '[' })).toMatchObject({ ok: false, part: 'sort' });
    expect(fail({ aggs: '[]' })).toMatchObject({
      ok: false,
      part: 'aggs',
      problem: 'The aggregations are a JSON object',
    });
  });
});

// ---------------------------------------------------------------------------------------------
// Properties

const PATHS = [...FIELDS.map((f) => f.path), 'unmapped', 'extra.deep'];

const RAW_CLAUSES = [
  '{"function_score": {"query": {"match_all": {}}, "boost": 2}}',
  '{"ids": {"values": ["a", "b"]}}',
  '{"range": {"created": {"gte": "now-1d", "format": "strict_date"}}}',
  '{"term": {"status": {"value": "paid", "boost": 2}}}',
  '{"script": {"script": "doc[\'total\'].value > 1"}}',
];

const text = fc.string({ maxLength: 12 });
const number = fc.oneof(
  fc.integer({ min: -1_000_000, max: 1_000_000 }).map(String),
  fc.constantFrom('1.10', '12345678901234567890', '-0.5', '1e5'),
);
const valueFor = (path: string): fc.Arbitrary<string> => {
  switch (FIELDS.find((f) => f.path === path)?.kind) {
    case 'number':
      return fc.oneof(
        number,
        text.map((t) => JSON.stringify(t)),
      );
    case 'boolean':
      return fc.constantFrom('true', 'false');
    default:
      return fc.oneof(
        text,
        number,
        text.map((t) => JSON.stringify(t)),
      );
  }
};

const conditionArb: fc.Arbitrary<DslCondition> = fc.constantFrom('', ...PATHS).chain((path) =>
  fc
    .constantFrom(
      ...operatorsFor(
        path,
        FIELDS.find((f) => f.path === path),
      ),
    )
    .chain((operator) =>
      fc
        .record({
          value:
            operator === 'terms'
              ? fc.array(valueFor(path), { minLength: 1, maxLength: 3 }).map((v) => v.join(', '))
              : operator === 'geo_distance'
                ? fc
                    .tuple(fc.integer({ min: -90, max: 90 }), fc.integer({ min: -180, max: 180 }))
                    .map(([lat, lon]) => `${lat}.5,${lon}`)
                : operator === 'term'
                  ? valueFor(path)
                  : text,
          lower: fc.oneof(fc.constant(''), valueFor(path)),
          lowerInclusive: fc.boolean(),
          upper: fc.oneof(fc.constant(''), valueFor(path)),
          upperInclusive: fc.boolean(),
          distance: fc.constantFrom('10km', '500m', '2.5mi'),
        })
        .map((patch) =>
          newCondition(
            path,
            FIELDS.find((f) => f.path === path),
            { ...patch, operator },
          ),
        ),
    ),
);

const rawArb = fc.constantFrom(...RAW_CLAUSES).map((t) => newRaw(t));

/** Items nested at most `depth` groups deep. */
function itemArb(depth: number): fc.Arbitrary<DslItem> {
  if (depth === 0) return fc.oneof(conditionArb, rawArb);
  const inner = itemArb(depth - 1);
  const groupArb: fc.Arbitrary<DslItem> = fc
    .record({
      path: fc.constantFrom('', '', 'items'),
      must: fc.array(inner, { maxLength: 2 }),
      filter: fc.array(inner, { maxLength: 2 }),
      should: fc.array(inner, { maxLength: 2 }),
      must_not: fc.array(inner, { maxLength: 1 }),
      minimumShouldMatch: fc.constantFrom('', '', '1', '75%', '-1'),
    })
    .map(({ path, minimumShouldMatch, ...clauses }) => ({
      ...newGroup(path),
      clauses,
      minimumShouldMatch,
    }));
  return fc.oneof({ weight: 3, arbitrary: conditionArb }, rawArb, groupArb);
}

const sortArb: fc.Arbitrary<DslSortItem> = fc.oneof(
  fc
    .record({
      field: fc.constantFrom(...PATHS, '_score'),
      order: fc.constantFrom('asc' as const, 'desc' as const),
      missing: fc.constantFrom('' as const, '_first' as const, '_last' as const),
    })
    .map((s) => ({ ...newSort(s.field, undefined), ...s })),
  fc.constant(newRaw('{"_script": {"type": "number", "script": "1"}}')),
);

function aggregationArb(depth: number): fc.Arbitrary<DslAggregation> {
  return fc
    .record({
      type: fc.constantFrom(
        'terms' as const,
        'date_histogram' as const,
        'histogram' as const,
        'avg' as const,
        'percentiles' as const,
        'dsl' as const,
      ),
      field: fc.constantFrom(...PATHS),
      name: fc.stringMatching(/^[a-z_]{1,6}$/),
      size: fc.constantFrom('', '5'),
      interval: fc.constantFrom('1d', '30m', '10', '0.5'),
      fixed: fc.boolean(),
      aggs: depth === 0 ? fc.constant([]) : fc.array(aggregationArb(depth - 1), { maxLength: 2 }),
    })
    .map(({ type, field, ...rest }) => ({
      ...newAggregation(type, field, undefined, []),
      ...rest,
      ...(type === 'dsl' ? { text: '{"filters": {"filters": {"a": {"match_all": {}}}}}' } : {}),
      aggs: type === 'dsl' || type === 'avg' || type === 'percentiles' ? [] : rest.aggs,
    }));
}

const modelArb: fc.Arbitrary<DslModel> = fc
  .record({
    must: fc.array(itemArb(2), { maxLength: 3 }),
    filter: fc.array(itemArb(2), { maxLength: 2 }),
    should: fc.array(itemArb(1), { maxLength: 2 }),
    must_not: fc.array(itemArb(1), { maxLength: 2 }),
    sort: fc.array(sortArb, { maxLength: 3 }),
    aggs: fc.array(aggregationArb(2), { maxLength: 3 }),
  })
  .map(({ sort, aggs, ...clauses }) => ({ query: { ...newGroup(), clauses }, sort, aggs }));

describe('round trips', () => {
  it('builds what it read from its own text to the same text', () => {
    fc.assert(
      fc.property(modelArb, (m) => {
        const first = buildDsl(m, FIELDS);
        fc.pre(first.ok);
        if (!first.ok) return;
        const back = readDsl(first.texts, FIELDS);
        expect(back.ok).toBe(true);
        if (!back.ok) return;
        const second = buildDsl(back.model, FIELDS);
        expect(second.ok && second.texts).toEqual(first.texts);
      }),
      { numRuns: 400 },
    );
  });

  it('settles any query text in one read and build', () => {
    const valueArb = (depth: number): fc.Arbitrary<unknown> =>
      depth === 0
        ? fc.oneof(fc.string({ maxLength: 6 }), fc.integer(), fc.boolean(), fc.constant(null))
        : fc.oneof(
            valueArb(0),
            fc.array(valueArb(depth - 1), { maxLength: 2 }),
            fc.dictionary(
              fc.constantFrom('query', 'value', 'gte', 'lt', 'field', 'path', 'operator', 'lat'),
              valueArb(depth - 1),
              { maxKeys: 2 },
            ),
          );
    const leafArb = fc.oneof(
      fc
        .tuple(
          fc.constantFrom(
            'term',
            'terms',
            'match',
            'match_phrase',
            'range',
            'prefix',
            'exists',
            'query_string',
            'geo_distance',
          ),
          fc.constantFrom(...PATHS),
          valueArb(2),
        )
        .map(([type, path, value]) => ({ [type]: { [path]: value } })),
      fc.constant({ match_all: {} }),
    );
    const queryArb = (depth: number): fc.Arbitrary<unknown> =>
      depth === 0
        ? leafArb
        : fc.oneof(
            { weight: 2, arbitrary: leafArb },
            fc.record({
              bool: fc.record(
                {
                  must: fc.array(queryArb(depth - 1), { maxLength: 2 }),
                  filter: queryArb(depth - 1),
                  should: fc.array(queryArb(depth - 1), { maxLength: 2 }),
                  must_not: fc.array(queryArb(depth - 1), { maxLength: 1 }),
                  minimum_should_match: fc.constantFrom(1, '2', '50%'),
                },
                { requiredKeys: [] },
              ),
            }),
            fc.record({
              nested: fc.record({
                path: fc.constantFrom('items', 'status'),
                query: queryArb(depth - 1),
              }),
            }),
          );
    const json = queryArb(3);
    fc.assert(
      fc.property(json, (query) => {
        const once = readDsl({ query: JSON.stringify(query), sort: '', aggs: '' }, FIELDS);
        fc.pre(once.ok);
        if (!once.ok) return;
        const built = buildDsl(once.model, FIELDS);
        fc.pre(built.ok);
        if (!built.ok) return;
        expect(again(built.texts)).toEqual(built.texts);
      }),
      { numRuns: 400 },
    );
  });
});
