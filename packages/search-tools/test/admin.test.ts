import { describe, expect, it } from 'vitest';

import {
  aliasActions,
  aliasSwapActions,
  classifyRequest,
  copyableSettings,
  indexNameProblem,
  mappingFields,
  nextIndexName,
  parseJsonTree,
  planMappingChange,
  reindexPlan,
  toLooseJson,
} from '../src';

describe('index names', () => {
  it('follows the server rules', () => {
    expect(indexNameProblem('orders-2026')).toBeUndefined();
    expect(indexNameProblem('')).toBeDefined();
    expect(indexNameProblem('Orders')).toContain('lower case');
    expect(indexNameProblem('_orders')).toContain('start');
    expect(indexNameProblem('a b')).toContain('spaces');
    expect(indexNameProblem('a,b')).toContain(',');
    expect(indexNameProblem('a:b')).toContain(':');
    expect(indexNameProblem('..')).toBeDefined();
    expect(indexNameProblem('é'.repeat(128))).toContain('255 bytes');
  });

  it('proposes the next version name', () => {
    expect(nextIndexName('orders')).toBe('orders-v2');
    expect(nextIndexName('orders-v2')).toBe('orders-v3');
    expect(nextIndexName('orders_v9', ['orders_v10'])).toBe('orders_v11');
  });
});

describe('copyableSettings', () => {
  it('keeps what a new index can take and drops what belongs to the old one', () => {
    const reply = JSON.stringify({
      orders: {
        settings: {
          index: {
            number_of_shards: '3',
            number_of_replicas: '1',
            uuid: 'abc',
            creation_date: '1788220800000',
            provided_name: 'orders',
            version: { created: '9000000' },
            blocks: { write: 'true' },
            refresh_interval: '5s',
            analysis: { analyzer: { folded: { type: 'custom', filter: ['lowercase'] } } },
          },
        },
      },
    });
    expect(toLooseJson(parseJsonTree(copyableSettings(reply)))).toEqual({
      'index.number_of_shards': '3',
      'index.number_of_replicas': '1',
      'index.refresh_interval': '5s',
      'index.analysis.analyzer.folded.type': 'custom',
      'index.analysis.analyzer.folded.filter': ['lowercase'],
    });
    expect(copyableSettings('{"index.uuid": "x", "index.codec": "best_compression"}')).toBe(
      '{"index.codec":"best_compression"}',
    );
  });
});

describe('alias actions', () => {
  it('swaps an alias atomically', () => {
    expect(aliasSwapActions('orders', ['orders-v1', 'orders-v2'], 'orders-v2')).toBe(
      '{"actions": [{"remove": {"index": "orders-v1", "alias": "orders"}}, {"add": {"index": "orders-v2", "alias": "orders"}}]}',
    );
    const body = aliasActions(
      [
        {
          index: 'a',
          alias: 'x',
          isWriteIndex: true,
          filter: '{ "term": {"k": 1} }',
          routing: '1',
        },
      ],
      [],
    );
    expect(body).toBe(
      '{"actions": [{"add": {"index": "a", "alias": "x", "is_write_index": true, "filter": {"term":{"k":1}}, "routing": "1"}}]}',
    );
  });
});

describe('mappings', () => {
  const current = JSON.stringify({
    orders: {
      mappings: {
        dynamic: 'strict',
        properties: {
          title: { type: 'text', fields: { keyword: { type: 'keyword', ignore_above: 256 } } },
          total: { type: 'long' },
          customer: { properties: { name: { type: 'keyword' } } },
        },
      },
    },
  });

  it('lists fields with multi-fields and objects', () => {
    expect(mappingFields(current).map((f) => [f.path, f.type, f.multiField])).toEqual([
      ['title', 'text', false],
      ['title.keyword', 'keyword', true],
      ['total', 'long', false],
      ['customer', 'object', false],
      ['customer.name', 'keyword', false],
    ]);
  });

  it('applies new fields and updatable parameters in place', () => {
    const proposed = JSON.stringify({
      dynamic: 'strict',
      properties: {
        title: {
          type: 'text',
          fields: { keyword: { type: 'keyword', ignore_above: 512 }, raw: { type: 'keyword' } },
        },
        total: { type: 'long' },
        customer: { properties: { name: { type: 'keyword' }, email: { type: 'keyword' } } },
        note: { type: 'text' },
      },
    });
    const plan = planMappingChange(current, proposed);
    expect(plan.inPlace).toBe(true);
    expect(plan.changes.map((c) => [c.path, c.kind])).toEqual([
      ['title.keyword', 'updated'],
      ['title.raw', 'added'],
      ['customer.email', 'added'],
      ['note', 'added'],
    ]);
    expect(plan.putBody).toContain('"note":{"type":"text"}');
  });

  it('explains that type changes and removed fields need a reindex', () => {
    const proposed = JSON.stringify({
      dynamic: 'strict',
      properties: {
        title: { type: 'keyword' },
        customer: { properties: { name: { type: 'keyword', index: false } } },
      },
    });
    const plan = planMappingChange(current, proposed);
    expect(plan.inPlace).toBe(false);
    expect(plan.putBody).toBeUndefined();
    expect(plan.changes).toEqual([
      {
        path: 'title',
        kind: 'changed',
        reason: "its type changes from text to keyword, and a field's type cannot change",
      },
      {
        path: 'customer.name',
        kind: 'changed',
        reason: 'index changes, and it cannot change on an existing field',
      },
      {
        path: 'total',
        kind: 'removed',
        reason: 'fields cannot be removed from a mapping; only a new index leaves it out',
      },
    ]);
  });
});

describe('reindexPlan', () => {
  it('creates, reindexes as a task, refreshes and swaps the aliases in one call', () => {
    const plan = reindexPlan({
      source: 'orders-v1',
      target: 'orders-v2',
      mappings: '{"properties": {"total": {"type": "double"}}}',
      settings: '{"index.number_of_shards": "1"}',
      cutover: { kind: 'aliases', aliases: ['orders'] },
    });
    expect(plan.steps.map((s) => s.kind)).toEqual(['create', 'reindex', 'refresh', 'aliases']);
    expect(plan.steps[0]!.request).toEqual({
      method: 'PUT',
      path: '/orders-v2',
      body: '{"settings": {"index.number_of_shards":"1"}, "mappings": {"properties":{"total":{"type":"double"}}}}',
    });
    expect(plan.steps[1]!.request).toMatchObject({
      method: 'POST',
      path: '/_reindex',
      query: 'wait_for_completion=false',
    });
    expect(plan.steps[3]!.request.body).toBe(
      '{"actions": [{"remove": {"index": "orders-v1", "alias": "orders"}}, {"add": {"index": "orders-v2", "alias": "orders"}}]}',
    );
    expect(plan.steps.every((s) => s.destructive === undefined)).toBe(true);
    expect(plan.consoleText).toContain('POST /_reindex?wait_for_completion=false\n{\n');
    expect(classifyRequest(plan.steps[3]!.request).destructive).toBeUndefined();
  });

  it('can replace the old index by name, which is destructive', () => {
    const plan = reindexPlan({
      source: 'orders',
      target: 'orders-v2',
      mappings: '{"properties": {}}',
      cutover: { kind: 'replace' },
      pipeline: 'clean',
    });
    const last = plan.steps.at(-1)!;
    expect(last.destructive).toContain('deletes orders');
    expect(last.request.body).toContain('{"remove_index": {"index": "orders"}}');
    expect(classifyRequest(last.request).destructive).toContain('remove_index');
    expect(plan.steps[1]!.request.body).toContain('"pipeline": "clean"');
    expect(() =>
      reindexPlan({ ...{ source: 'a', target: 'a', mappings: '{}' }, cutover: { kind: 'none' } }),
    ).toThrow();
    expect(() =>
      reindexPlan({ source: 'a', target: 'B', mappings: '{}', cutover: { kind: 'none' } }),
    ).toThrow();
  });
});
