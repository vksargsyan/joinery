import { JoineryError } from '@joinery/core';
import {
  reindexPlan,
  searchCapabilities,
  type SearchPage,
  type SearchTaskStatus,
} from '@joinery/search-tools';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type * as MainClient from '../src/renderer/src/lib/main-client';
import {
  EMPTY_CREATE_INDEX,
  createIndexBody,
  createIndexIssues,
} from '../src/renderer/src/state/search/create-index';
import {
  DocumentEditorFlow,
  checkSource,
  conflictCurrent,
  editDocumentState,
} from '../src/renderer/src/state/search/document-editor';
import { DocumentsView, queryClause, searchBody } from '../src/renderer/src/state/search/documents';
import { IndexView } from '../src/renderer/src/state/search/index-view';
import { runReindexPlan, taskProgress } from '../src/renderer/src/state/search/reindex-run';
import { visibleShards } from '../src/renderer/src/state/search/cluster';
import {
  PROFILE_ID,
  answerConfirms,
  connectHost,
  disconnectAll,
  recorder,
} from './mongo-tool-fixtures';

/**
 * The Elasticsearch panels' flows (spec §11) against a fake connection host: the
 * document grid's paging and its edit, conflict and bulk paths, the document editor, the query
 * bar, the create-index form, the reindex plan runner and the index panel's mapping editor.
 */

const main = vi.hoisted(() => ({ api: {} as Record<string, unknown> }));
vi.mock('../src/renderer/src/lib/main-client', async (importOriginal) => ({
  ...(await importOriginal<typeof MainClient>()),
  mainApi: () => main.api,
}));

afterEach(() => disconnectAll());

const CAPS = searchCapabilities({ version: '9.4.0' });

function page(from: number, count: number, extra: Partial<SearchPage> = {}): SearchPage {
  return {
    hits: Array.from({ length: count }, (_, i) => ({
      index: 'orders',
      id: String(from + i),
      score: null,
      source: `{"n": ${from + i}, "big": 12345678901234567890, "customer": {"name": "c${from + i}"}}`,
      seqNo: from + i,
      primaryTerm: 1,
    })),
    took: 1,
    timedOut: false,
    paging: 'pit',
    ...extra,
  };
}

/** A fake connection host with the search services the panels call. */
function fakeHost(overrides: Record<string, unknown> = {}) {
  const calls = recorder();
  const search = {
    clusterInfo: async () => ({
      version: '9.4.0',
      clusterName: 'c',
      plugins: [],
      capabilities: CAPS,
    }),
    indices: {
      getMapping: async () =>
        '{"orders": {"mappings": {"properties": {"n": {"type": "long"}, "empty": {"type": "keyword"}, "customer": {"properties": {"name": {"type": "keyword"}}}}}}}',
    },
    documents: {
      search: (input: object) => {
        calls.record('search', input);
        return (async function* () {
          yield page(0, 3, { total: { value: 10_000, relation: 'gte' } });
          yield page(3, 3);
          yield page(6, 2);
        })();
      },
      index: async (input: object) => {
        calls.record('index', input);
        return { index: 'orders', id: '1', result: 'updated', seqNo: 9, primaryTerm: 1 };
      },
      get: async (input: { id: string }) => {
        calls.record('get', input);
        return {
          index: 'orders',
          id: input.id,
          found: true,
          source: '{"n": 100}',
          seqNo: 9,
          primaryTerm: 1,
        };
      },
      bulk: async (input: object) => {
        calls.record('bulk', input);
        return {
          took: 1,
          errors: true,
          items: [
            { action: 'delete', index: 'orders', id: '0', status: 200, result: 'deleted' },
            {
              action: 'delete',
              index: 'orders',
              id: '1',
              status: 409,
              error: { type: 'version_conflict_engine_exception', reason: 'changed' },
            },
          ],
        };
      },
    },
    ...overrides,
  };
  return {
    calls,
    host: {
      openSession: async () => ({ sessionId: 's1' }),
      closeSession: async () => undefined,
      cancel: async () => undefined,
      search,
    },
  };
}

describe('the query bar', () => {
  it('takes a DSL clause or a Lucene query string, a sort and aggregations', () => {
    expect(queryClause('')).toBeUndefined();
    expect(queryClause('{"term": {"a": 1}}')).toBe('{"term": {"a": 1}}');
    expect(queryClause('status:paid AND "x y"')).toBe(
      '{"query_string": {"query": "status:paid AND \\"x y\\""}}',
    );
    expect(searchBody('a:1', '[{"n": "desc"}]')).toBe(
      '{"query": {"query_string": {"query": "a:1"}}, "sort": [{"n": "desc"}]}',
    );
    expect(searchBody('', '')).toBe('{}');
    expect(() => searchBody('{"a": ', '')).toThrow(/query is not valid JSON/);
    expect(() => searchBody('', '[')).toThrow(/sort is not valid JSON/);
    expect(searchBody('', '', '{"t": {"terms": {"field": "a"}}}')).toBe(
      '{"aggs": {"t": {"terms": {"field": "a"}}}}',
    );
    expect(() => searchBody('', '', '{"t": ')).toThrow(/aggregations are not valid JSON/);
    expect(() => searchBody('', '', '[]')).toThrow('The aggregations are a JSON object');
  });
});

describe('the document grid', () => {
  it('flattens hits, puts mapped fields first and loads pages as the grid scrolls', async () => {
    const { host, calls } = fakeHost();
    connectHost(host);
    const view = new DocumentsView('p1', {
      profileId: PROFILE_ID,
      target: 'orders',
      kind: 'index',
    });
    await view.init();
    expect(calls.of('search')[0]!.input).toMatchObject({
      target: 'orders',
      body: '{}',
      pageSize: 100,
    });
    expect(view.state.hits).toHaveLength(3);
    expect(view.state.total).toEqual({ value: 10_000, relation: 'gte' });
    expect(view.state.paging).toBe('pit');
    // Mapped fields first (even one no document has), then the others as they appear.
    expect(view.state.columns).toEqual(['n', 'empty', 'customer.name', 'big']);
    expect(view.cell(0, 'big')?.text).toBe('12345678901234567890');
    expect(view.cell(1, 'empty')).toBeUndefined();
    // Three hits per page against a page size of 100: the stream said when it ended.
    view.setPageSize(3);
    await view.search();
    expect(view.state.hasMore).toBe(true);
    view.onVisibleRows(2);
    await vi.waitFor(() => expect(view.state.hits).toHaveLength(6));
    await view.loadMore();
    expect(view.state.hits.map((h) => h.id)).toEqual(['0', '1', '2', '3', '4', '5', '6', '7']);
    expect(view.state.hasMore).toBe(false);
    await view.dispose();
  });

  it('saves an edit over the version it read, and shows the stored version on a conflict', async () => {
    let conflicts = 1;
    const { host, calls } = fakeHost();
    host.search.documents.index = async (input: object) => {
      calls.record('index', input);
      if (conflicts-- > 0) {
        throw new JoineryError({
          code: 'CONFLICT',
          message: 'The document 1 in orders changed since it was read',
          detail: '{"_seq_no": 7, "_primary_term": 1, "_version": 3, "_source": {"n": 42}}',
        });
      }
      return { index: 'orders', id: '1', result: 'updated', seqNo: 9, primaryTerm: 1 };
    };
    connectHost(host);
    const confirms = answerConfirms();
    const view = new DocumentsView('p2', {
      profileId: PROFILE_ID,
      target: 'orders',
      kind: 'index',
    });
    await view.init();
    view.openEditor('edit', 1);
    expect(view.state.editor?.text).toContain('"big": 12345678901234567890');
    view.setEditorText('{"n": 1, "note": "mine"}');
    expect(await view.saveEditor()).toBe(false);
    expect(calls.of('index')[0]!.input).toMatchObject({
      index: 'orders',
      id: '1',
      ifSeqNo: 1,
      ifPrimaryTerm: 1,
      refresh: 'wait_for',
    });
    expect(view.state.editor).toMatchObject({
      status: 'conflict',
      current: { version: { seqNo: 7, primaryTerm: 1 } },
    });
    expect(view.state.editor?.current?.text).toContain('"n": 42');
    // Overwriting asks, then writes over the stored version.
    expect(await view.overwriteEditor()).toBe(true);
    expect(confirms.asked.map((a) => a.title)).toContain('Overwrite the newer version?');
    expect(calls.of('index')[1]!.input).toMatchObject({ ifSeqNo: 7, ifPrimaryTerm: 1 });
    // The row shows the stored document afterwards.
    expect(view.state.editor).toBeUndefined();
    expect(view.cell(1, 'n')?.text).toBe('100');
    expect(view.state.notice).toEqual({ kind: 'success', text: 'Saved 1' });
    confirms.stop();
    await view.dispose();
  });

  it('deletes several rows with one bulk request and reports the items that failed', async () => {
    const { host, calls } = fakeHost();
    connectHost(host);
    const confirms = answerConfirms();
    const view = new DocumentsView('p3', {
      profileId: PROFILE_ID,
      target: 'orders',
      kind: 'index',
    });
    await view.init();
    await view.deleteRows([0, 1]);
    expect(confirms.asked[0]).toMatchObject({ title: 'Delete 2 documents?' });
    const input = calls.of('bulk')[0]!.input;
    expect(input['ndjson']).toBe(
      '{"delete":{"_index":"orders","_id":"0","if_seq_no":0,"if_primary_term":1}}\n{"delete":{"_index":"orders","_id":"1","if_seq_no":1,"if_primary_term":1}}\n',
    );
    expect(input['confirmed']).toBe(true);
    // The deleted row went; the conflicting one stayed and is reported.
    expect(view.state.hits.map((h) => h.id)).toEqual(['1', '2']);
    expect(view.state.bulk).toMatchObject({ failed: 1 });
    expect(view.state.notice?.kind).toBe('error');
    confirms.stop();
    await view.dispose();
  });

  it('refuses writes on a read-only profile before sending anything', async () => {
    const { host, calls } = fakeHost();
    connectHost(host, { readOnly: true });
    const view = new DocumentsView('p4', {
      profileId: PROFILE_ID,
      target: 'orders',
      kind: 'index',
    });
    await view.init();
    view.openEditor('create');
    expect(view.state.editor).toBeUndefined();
    await view.deleteRows([0]);
    await view.setFieldOnRows([0], 'a', '1');
    expect(calls.of('bulk')).toEqual([]);
    expect(view.state.notice).toEqual({ kind: 'error', text: 'This connection is read-only.' });
    await view.dispose();
  });
});

describe('the document editor', () => {
  it('checks the text and reads a conflict', () => {
    expect(checkSource('{"a": 1}')).toBeUndefined();
    expect(checkSource('[1]')?.message).toContain('JSON object');
    expect(checkSource('{"a": }')?.offset).toBe(6);
    expect(conflictCurrent('{"_seq_no": 3, "_primary_term": 2, "_source": {"a":1}}')).toEqual({
      text: '{\n  "a": 1\n}',
      version: { seqNo: 3, primaryTerm: 2 },
    });
    expect(conflictCurrent(undefined)).toBeUndefined();
  });

  it('reloads the stored version after a conflict, dropping the edit', async () => {
    const flow = new DocumentEditorFlow(
      editDocumentState({ index: 'a', id: '1', source: '{"n":1}', seqNo: 1, primaryTerm: 1 }),
      {
        index: async () => {
          throw new JoineryError({
            code: 'CONFLICT',
            message: 'changed',
            detail: '{"_seq_no": 5, "_primary_term": 1, "_source": {"n": 5}}',
          });
        },
      },
    );
    flow.setText('{"n": 2}');
    expect(await flow.save()).toEqual({ ok: false });
    flow.reload();
    expect(flow.state).toMatchObject({
      status: 'editing',
      text: '{\n  "n": 5\n}',
      version: { seqNo: 5, primaryTerm: 1 },
      current: undefined,
    });
  });

  it('refuses an id that exists when creating', async () => {
    const flow = new DocumentEditorFlow(
      { ...editDocumentState({ index: 'a', id: 'x' }), mode: 'create', version: undefined },
      {
        index: async (request) => {
          expect(request).toMatchObject({ create: true, id: 'x', version: undefined });
          throw new JoineryError({ code: 'CONFLICT', message: 'exists' });
        },
      },
    );
    await flow.save();
    expect(flow.state.error).toContain('already exists');
  });
});

describe('create index form', () => {
  it('checks the fields and builds the body', () => {
    expect(createIndexIssues({ ...EMPTY_CREATE_INDEX, name: 'Orders' }).name).toContain(
      'lower case',
    );
    expect(
      createIndexIssues({ ...EMPTY_CREATE_INDEX, name: 'o', shards: '0' }).shards,
    ).toBeDefined();
    expect(
      createIndexIssues({ ...EMPTY_CREATE_INDEX, name: 'o', mappings: '{"a": ' }).mappings,
    ).toBeDefined();
    const form = {
      name: 'orders',
      shards: '2',
      replicas: '0',
      mappings: '{"properties": {"n": {"type": "long"}}}',
      settings: '{"index.refresh_interval": "5s"}',
      aliases: 'orders-read, orders-all',
    };
    expect(createIndexIssues(form)).toEqual({});
    expect(createIndexBody(form)).toBe(
      '{"settings": {"index.number_of_shards": 2, "index.number_of_replicas": 0, "index.refresh_interval":"5s"}, "mappings": {"properties":{"n":{"type":"long"}}}, "aliases": {"orders-read": {}, "orders-all": {}}}',
    );
  });
});

describe('the reindex plan runner', () => {
  const plan = reindexPlan({
    source: 'a',
    target: 'b',
    mappings: '{"properties": {}}',
    cutover: { kind: 'aliases', aliases: ['current'] },
  });

  function task(patch: Partial<SearchTaskStatus>): SearchTaskStatus {
    return {
      id: 'n:1',
      action: 'indices:data/write/reindex',
      completed: false,
      cancellable: true,
      cancelled: false,
      failures: 0,
      ...patch,
    };
  }

  it('creates, follows the task to the end, refreshes and moves the aliases', async () => {
    const ran: string[] = [];
    const polls = [
      task({
        progress: {
          total: 10,
          created: 4,
          updated: 0,
          deleted: 0,
          noops: 0,
          versionConflicts: 0,
          batches: 1,
        },
      }),
      task({
        completed: true,
        progress: {
          total: 10,
          created: 10,
          updated: 0,
          deleted: 0,
          noops: 0,
          versionConflicts: 0,
          batches: 1,
        },
      }),
    ];
    const states: number[] = [];
    const final = await runReindexPlan(
      plan,
      {
        run: async (step) => void ran.push(step.kind),
        start: async (step) => {
          ran.push(step.kind);
          return 'n:1';
        },
        task: async () => polls.shift()!,
        sleep: async () => undefined,
        cancelled: () => false,
      },
      (state) => {
        const share = taskProgress(state.task);
        if (share !== undefined) states.push(share);
      },
      0,
    );
    expect(final.status).toBe('done');
    expect(ran).toEqual(['create', 'reindex', 'refresh', 'aliases']);
    expect(states).toContain(0.4);
    expect(states.at(-1)).toBe(1);
  });

  it('stops before the aliases move when the copy fails or is cancelled', async () => {
    for (const [outcome, status] of [
      [task({ completed: true, failures: 2, error: 'mapper_parsing_exception' }), 'failed'],
      [task({ completed: true, cancelled: true }), 'cancelled'],
    ] as const) {
      const ran: string[] = [];
      const final = await runReindexPlan(
        plan,
        {
          run: async (step) => void ran.push(step.kind),
          start: async () => 'n:1',
          task: async () => outcome,
          sleep: async () => undefined,
          cancelled: () => false,
        },
        () => undefined,
        0,
      );
      expect(final.status).toBe(status);
      expect(ran).toEqual(['create']);
    }
  });
});

describe('the index panel', () => {
  it('applies new fields in place, and plans a reindex for changed ones', async () => {
    const calls = recorder();
    const host = {
      openSession: async () => ({ sessionId: 's1' }),
      closeSession: async () => undefined,
      search: {
        clusterInfo: async () => ({
          version: '9.4.0',
          clusterName: 'c',
          plugins: [],
          capabilities: CAPS,
        }),
        indices: {
          list: async () => [
            {
              name: 'orders-v1',
              health: 'green',
              status: 'open',
              primaries: 1,
              replicas: 0,
              docsCount: 5,
              docsDeleted: 0,
              storeSizeBytes: 100,
              primaryStoreSizeBytes: 100,
            },
            {
              name: 'orders-v2',
              health: 'green',
              status: 'open',
              primaries: 1,
              replicas: 0,
              docsCount: 0,
              docsDeleted: 0,
              storeSizeBytes: 1,
              primaryStoreSizeBytes: 1,
            },
          ],
          getSettings: async () =>
            '{"orders-v1": {"settings": {"index": {"number_of_shards": "1", "uuid": "u", "creation_date": "1"}}}}',
          getMapping: async () =>
            '{"orders-v1": {"mappings": {"properties": {"total": {"type": "long"}}}}}',
          putMapping: async (input: object) => calls.record('putMapping', input),
        },
        aliases: {
          list: async () => [
            {
              alias: 'orders',
              index: 'orders-v1',
              filtered: false,
              isWriteIndex: null,
              hidden: false,
            },
          ],
        },
      },
    };
    connectHost(host);
    const confirms = answerConfirms();
    const view = new IndexView('i1', { profileId: PROFILE_ID, index: 'orders-v1' });
    await view.init();
    expect(view.state.fields.map((f) => f.path)).toEqual(['total']);
    expect(view.state.aliases.map((a) => a.alias)).toEqual(['orders']);

    view.setProposed('{"properties": {"total": {"type": "long"}, "note": {"type": "text"}}}');
    await view.applyMapping();
    expect(calls.of('putMapping')[0]!.input).toMatchObject({
      index: 'orders-v1',
      body: '{"properties":{"total":{"type":"long"},"note":{"type":"text"}}}',
    });

    view.setProposed('{"properties": {"total": {"type": "double"}}}');
    await view.applyMapping();
    expect(calls.of('putMapping')).toHaveLength(1);
    expect(view.state.notice?.text).toContain('needs a reindex');
    // The plan proposes a free name (orders-v2 is taken) and moves the alias.
    view.openReindex();
    const reindex = view.state.reindex!;
    expect(reindex.target).toBe('orders-v3');
    expect(reindex.cutover).toBe('aliases');
    expect(reindex.plan?.steps.map((s) => s.kind)).toEqual([
      'create',
      'reindex',
      'refresh',
      'aliases',
    ]);
    expect(reindex.plan?.steps[0]!.request.body).toBe(
      '{"settings": {"index.number_of_shards":"1"}, "mappings": {"properties":{"total":{"type":"double"}}}}',
    );
    view.setReindexTarget('orders-v2');
    expect(view.state.reindex?.error).toContain('exists already');
    confirms.stop();
    await view.dispose();
  });
});

describe('the cluster panel', () => {
  it('lists unassigned shards first and filters by index', () => {
    const shards = [
      { index: 'b', shard: 0, primary: true, state: 'STARTED', node: 'n', docs: 1, storeBytes: 1 },
      {
        index: 'a',
        shard: 0,
        primary: false,
        state: 'UNASSIGNED',
        node: null,
        docs: null,
        storeBytes: null,
      },
      {
        index: 'a',
        shard: 0,
        primary: true,
        state: 'INITIALIZING',
        node: 'n',
        docs: null,
        storeBytes: null,
      },
    ];
    expect(visibleShards(shards, '', false).map((s) => s.state)).toEqual([
      'UNASSIGNED',
      'INITIALIZING',
      'STARTED',
    ]);
    expect(visibleShards(shards, 'B', false).map((s) => s.index)).toEqual(['b']);
    expect(visibleShards(shards, '', true)).toHaveLength(2);
  });
});
