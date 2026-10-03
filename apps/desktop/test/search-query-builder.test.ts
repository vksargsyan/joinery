import {
  NO_CLAUSES,
  newCondition,
  newGroup,
  newRaw,
  searchCapabilities,
  type DslGroup,
  type DslItem,
  type Occur,
  type SearchPage,
} from '@querybara/search-tools';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type * as MainClient from '../src/renderer/src/lib/main-client';
import { DocumentsView, searchBody } from '../src/renderer/src/state/search/documents';
import {
  findGroup,
  moveClause,
  nestedScope,
  removeClause,
  walkItems,
} from '../src/renderer/src/state/search/query-builder';
import { PROFILE_ID, connectHost, disconnectAll, recorder } from './mongo-tool-fixtures';

/**
 * The documents view's query builder against a fake connection host: fields from the mapping,
 * builder changes written to the query bar and run (aggregations and their results included),
 * the bar read back into the builder, incomplete changes held back, nested fields put in a
 * nested group, and the clause tree's moves.
 */

const main = vi.hoisted(() => ({ api: {} as Record<string, unknown> }));
vi.mock('../src/renderer/src/lib/main-client', async (importOriginal) => ({
  ...(await importOriginal<typeof MainClient>()),
  mainApi: () => main.api,
}));

afterEach(() => disconnectAll());

const MAPPING = JSON.stringify({
  orders: {
    mappings: {
      properties: {
        title: { type: 'text', fields: { keyword: { type: 'keyword' } } },
        status: { type: 'keyword' },
        total: { type: 'long' },
        created: { type: 'date' },
        items: { type: 'nested', properties: { sku: { type: 'keyword' } } },
      },
    },
  },
});

function fakeHost() {
  const calls = recorder();
  const page: SearchPage = {
    hits: [{ index: 'orders', id: '1', score: 1, source: '{"status": "paid"}' }],
    total: { value: 1, relation: 'eq' },
    took: 1,
    timedOut: false,
    paging: 'pit',
    aggregations: '{"by_status": {"buckets": [{"key": "paid", "doc_count": 1}]}}',
  };
  return {
    calls,
    host: {
      openSession: async () => ({ sessionId: 's1' }),
      closeSession: async () => undefined,
      cancel: async () => undefined,
      search: {
        clusterInfo: async () => ({
          version: '9.4.0',
          clusterName: 'c',
          plugins: [],
          capabilities: searchCapabilities({ version: '9.4.0' }),
        }),
        indices: { getMapping: async () => MAPPING },
        request: async (input: { request: { path: string; body: string } }) => {
          calls.record('request', input);
          const field = /"field": "([^"]+)"/.exec(input.request.body)?.[1];
          if (field === 'total') {
            return { status: 400, body: '{"error": {"type": "x", "reason": "no fielddata"}}' };
          }
          return {
            status: 200,
            body: JSON.stringify({
              aggregations: {
                values: {
                  buckets: [
                    { key: 'paid', doc_count: 7 },
                    { key: 'sent, late', doc_count: 2 },
                  ],
                },
              },
            }),
          };
        },
        documents: {
          search: (input: object) => {
            calls.record('search', input);
            return (async function* () {
              yield page;
            })();
          },
        },
      },
    },
  };
}

async function openView(id: string) {
  const { host, calls } = fakeHost();
  connectHost(host);
  const view = new DocumentsView(id, { profileId: PROFILE_ID, target: 'orders', kind: 'index' });
  await view.init();
  return { view, calls };
}

describe('the query builder in the documents view', () => {
  it('builds from the mapping, writes the query bar and runs it with its aggregations', async () => {
    const { view, calls } = await openView('b1');
    const builder = view.builder;
    expect(builder.state.fieldList.fields.map((f) => f.path)).toEqual([
      '_id',
      'title',
      'title.keyword',
      'status',
      'total',
      'created',
      'items',
      'items.sku',
    ]);
    builder.setMode('builder');
    const status = builder.addCondition('status', builder.rootTarget('filter'))!;
    // Incomplete: the bar keeps the last complete query, and searching asks for the fix.
    expect(builder.state.pending).toBe('status: type a value');
    expect(view.state.queryText).toBe('');
    await view.search();
    expect(view.state.issue).toBe('Finish the query first: status: type a value');
    expect(calls.of('search')).toHaveLength(1);

    builder.updateCondition(status, { value: 'paid' });
    builder.addCondition('title');
    const title = [...walkItems(builder.state.model.query)].find(
      ({ item }) => item.kind === 'condition' && item.field === 'title',
    )!.item.id;
    builder.updateCondition(title, { value: 'blue shoes', operator: 'match_and' });
    builder.addSort('title');
    builder.addSort('created');
    builder.addAggregation('terms', 'status');
    expect(view.state).toMatchObject({
      queryText:
        '{"bool": {"must": [{"match": {"title": {"query": "blue shoes", "operator": "and"}}}], "filter": [{"term": {"status": "paid"}}]}}',
      sortText: '[{"title.keyword": "asc"}, {"created": "desc"}]',
      aggsText: '{"by_status": {"terms": {"field": "status"}}}',
    });
    expect(builder.state.pending).toBeUndefined();

    await view.search();
    expect(calls.of('search')[1]!.input['body']).toBe(
      searchBody(view.state.queryText, view.state.sortText, view.state.aggsText),
    );
    expect(String(calls.of('search')[1]!.input['body'])).toContain(
      '"aggs": {"by_status": {"terms": {"field": "status"}}}',
    );
    expect(view.state.aggregations).toContain('"by_status"');
    expect(view.consoleText()).toMatch(/^GET \/orders\/_search\n\{\n {2}"query": \{/);
    await view.dispose();
  });

  it('reads the query bar back, and stops only at text that is not valid JSON', async () => {
    const { view } = await openView('b2');
    const builder = view.builder;
    view.setQueryText(
      '{"bool": {"must_not": {"term": {"total": 7}}, "filter": [{"ids": {"values": ["1"]}}]}}',
    );
    const root = builder.state.model.query;
    expect(root.clauses.must_not[0]).toMatchObject({
      kind: 'condition',
      field: 'total',
      value: '7',
    });
    expect(root.clauses.filter[0]).toMatchObject({
      kind: 'dsl',
      text: '{"ids": {"values": ["1"]}}',
    });
    // The text stays as typed until the builder changes something.
    expect(view.state.queryText).toContain('"must_not": {"term"');

    view.setAggsText('{"by": ');
    expect(builder.state.blocked).toMatch(/aggregations text is not valid JSON/);
    expect(builder.addCondition('status')).toBeUndefined();
    builder.clear();
    expect(builder.state.blocked).toBeUndefined();
    expect(view.state).toMatchObject({ queryText: '', sortText: '', aggsText: '' });
    await view.dispose();
  });

  it('puts a nested field in a nested group, and names aggregations after their field', async () => {
    const { view } = await openView('b3');
    const builder = view.builder;
    const sku = builder.addCondition('items.sku')!;
    builder.updateCondition(sku, { value: 'A-1' });
    // A second one goes into the same nested group.
    builder.updateCondition(builder.addCondition('items.sku')!, { value: 'B-2' });
    expect(view.state.queryText).toBe(
      '{"nested": {"path": "items", "query": {"bool": {"must": [{"term": {"items.sku": "A-1"}}, {"term": {"items.sku": "B-2"}}]}}}}',
    );
    const agg = builder.addAggregation('terms', 'status');
    builder.updateAggregation(agg, { field: 'title.keyword' });
    expect(builder.state.model.aggs[0]!.name).toBe('by_title_keyword');
    builder.updateAggregation(agg, { name: 'mine' });
    builder.updateAggregation(agg, { field: 'status' });
    expect(builder.state.model.aggs[0]!.name).toBe('mine');
    const sub = builder.addAggregation('avg', 'total', agg);
    builder.updateAggregation(sub, { type: 'max' });
    expect(view.state.aggsText).toBe(
      '{"mine": {"terms": {"field": "status"}, "aggs": {"max_total": {"max": {"field": "total"}}}}}',
    );
    await view.dispose();
  });
});

describe('top values', () => {
  it("reads a field's most common values once, a text field's from its keyword", async () => {
    const { view, calls } = await openView('b4');
    const builder = view.builder;
    await builder.loadTopValues('status');
    expect(builder.state.topValues['status']).toEqual({
      status: 'done',
      values: [
        { text: 'paid', count: 7 },
        { text: 'sent, late', count: 2 },
      ],
      error: undefined,
    });
    await builder.loadTopValues('status');
    await builder.loadTopValues('title');
    expect(calls.of('request').map((c) => c.input['request'])).toEqual([
      {
        method: 'POST',
        path: '/orders/_search',
        body: '{"size": 0, "aggs": {"values": {"terms": {"field": "status", "size": 20}}}}',
      },
      {
        method: 'POST',
        path: '/orders/_search',
        body: '{"size": 0, "aggs": {"values": {"terms": {"field": "title.keyword", "size": 20}}}}',
      },
    ]);
    await builder.loadTopValues('total');
    expect(builder.state.topValues['total']).toMatchObject({
      status: 'error',
      error: 'no fielddata',
    });
    await view.dispose();
  });
});

describe('the clause tree', () => {
  const item = (id: string): DslItem => ({ ...newRaw(`{"${id}": {}}`), id });
  function tree(): DslGroup {
    const inner: DslGroup = {
      ...newGroup('items'),
      id: 'inner',
      clauses: { ...NO_CLAUSES, must: [item('c')] },
    };
    return {
      ...newGroup(),
      id: 'root',
      clauses: { ...NO_CLAUSES, must: [item('a'), item('b')], filter: [inner] },
    };
  }
  const ids = (group: DslGroup, occur: Occur): string[] => group.clauses[occur].map((i) => i.id);

  it('moves clauses between sections and before others, never a group into itself', () => {
    let root = moveClause(tree(), 'b', { group: 'root', occur: 'must' }, 'a');
    expect(ids(root, 'must')).toEqual(['b', 'a']);
    root = moveClause(root, 'a', { group: 'inner', occur: 'should' });
    expect(ids(findGroup(root, 'inner')!, 'should')).toEqual(['a']);
    expect(moveClause(root, 'inner', { group: 'inner', occur: 'must' })).toBe(root);
    root = removeClause(root, 'c');
    expect(ids(findGroup(root, 'inner')!, 'must')).toEqual([]);
    expect(nestedScope(root, 'inner')).toEqual(['items']);
    expect(nestedScope(root, 'root')).toEqual([]);
    expect([...walkItems(root)].map((e) => e.item.id)).toEqual(['b', 'inner', 'a']);
    expect(newCondition('x', undefined).operator).toBe('term');
  });
});
