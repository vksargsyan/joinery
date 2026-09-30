import { JoineryError } from '@joinery/core';
import { fromEjson, parseShellDocument, toEjson } from '@joinery/mongo-tools';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as MainClient from '../src/renderer/src/lib/main-client';
import { AggregationEditor } from '../src/renderer/src/state/mongo/aggregation';
import {
  exportLanguage,
  exportSubject,
  exportedCode,
  lastExportLanguage,
  rememberExportLanguage,
} from '../src/renderer/src/state/mongo/code-export';
import { CollectionView } from '../src/renderer/src/state/mongo/collection-view';
import { DocumentResults, tableOf } from '../src/renderer/src/state/mongo/results';
import {
  SqlQuery,
  exportTargetOf,
  looksLikeSql,
  pipelineTextOf,
  starterSql,
  translateSql,
} from '../src/renderer/src/state/mongo/sql-query';
import { PROFILE_ID, connectHost, disconnectAll, recorder, streamOf } from './mongo-tool-fixtures';

/**
 * SQL on MongoDB and code export in the app (spec §9, "Query tools"): translation as the SQL is
 * typed, runs through find() and aggregate() on the chosen database with the select list's
 * column order, cancel, history, where a translation opens, and the export requests of the
 * SQL tab, the collection view and the aggregation editor.
 */

const main = vi.hoisted(() => ({ api: {} as Record<string, unknown> }));
vi.mock('../src/renderer/src/lib/main-client', async (importOriginal) => ({
  ...(await importOriginal<typeof MainClient>()),
  mainApi: () => main.api,
}));

let history: ReturnType<typeof recorder>;

beforeEach(() => {
  history = recorder();
  main.api = {
    history: {
      add: async (input: object) => {
        history.record('add', input);
        return { id: 1 };
      },
    },
  };
});

afterEach(() => {
  disconnectAll();
  vi.useRealTimers();
});

const ORDERS = [
  toEjson({ _id: 1, total: 250, name: 'Ada' }),
  toEjson({ _id: 2, total: 120, name: 'Bo' }),
];

function fakeHost(overrides: Record<string, unknown> = {}) {
  const rec = recorder();
  const host = {
    openSession: async () => ({ sessionId: 's1' }),
    closeSession: async () => undefined,
    browse: async () => [
      { kind: 'database', name: 'shop', path: ['shop'], hasChildren: true },
      { kind: 'database', name: 'archive', path: ['archive'], hasChildren: true },
    ],
    cancel: async (input: object) => {
      rec.record('cancel', input);
    },
    mongo: {
      find: (input: object) => {
        rec.record('find', input);
        return streamOf([{ documents: ORDERS }]);
      },
      aggregate: (input: object) => {
        rec.record('aggregate', input);
        return streamOf([{ documents: [toEjson({ team: 'core', n: 2 })] }]);
      },
      collections: {
        info: async (input: { ns: { collection: string } }) => {
          rec.record('info', input);
          if (input.ns.collection === 'ghosts') {
            throw new JoineryError({ code: 'NOT_FOUND', message: 'ns does not exist' });
          }
          return {
            name: input.ns.collection,
            type: input.ns.collection === 'open_orders' ? 'view' : 'collection',
          };
        },
      },
      ...overrides,
    },
  };
  return { host, rec };
}

function sqlTab(text: string): SqlQuery {
  return new SqlQuery('sql', { profileId: PROFILE_ID, db: 'shop', text });
}

describe('translating as the SQL is typed', () => {
  it('translates a SELECT, marks a mistake where it is, and tells unsupported SQL apart', () => {
    expect(translateSql('   ')).toEqual({});
    const find = translateSql('SELECT name FROM orders WHERE total > 100');
    expect(find.translation).toMatchObject({
      kind: 'find',
      collection: 'orders',
      columns: ['name'],
    });
    const mistake = translateSql('SELECT name FROM orders WHERE');
    expect(mistake.issue).toMatchObject({ unsupported: false, offset: 29 });
    expect(mistake.issue!.message).toMatch(/line 1, column 30/);
    const union = translateSql('SELECT a FROM x UNION SELECT a FROM y');
    expect(union.issue?.unsupported).toBe(true);
  });

  it('follows the text after a pause, or at once when asked', () => {
    vi.useFakeTimers();
    const q = sqlTab('SELECT * FROM orders');
    expect(q.state.translation?.collection).toBe('orders');
    q.setText('SELECT * FROM customers');
    expect(q.state.translation?.collection).toBe('orders');
    vi.advanceTimersByTime(250);
    expect(q.state.translation?.collection).toBe('customers');
    q.setText('SELECT * FROM rates');
    expect(q.current()?.collection).toBe('rates');
  });

  it('knows SQL history entries from console commands, and quotes a starter query', () => {
    expect(looksLikeSql('SELECT 1')).toBe(true);
    expect(looksLikeSql('  -- totals\n/* by team */ select team from t')).toBe(true);
    expect(looksLikeSql('{ find: "orders" }')).toBe(false);
    expect(looksLikeSql('selection')).toBe(false);
    expect(starterSql('order')).toBe('SELECT *\nFROM `order`\nLIMIT 100');
    expect(translateSql(starterSql('line-items')).translation?.collection).toBe('line-items');
  });
});

describe('running SQL', () => {
  it('runs a find() on the chosen database, the table in select-list order, and records it', async () => {
    const { host, rec } = fakeHost();
    connectHost(host);
    const q = sqlTab('SELECT total, name FROM orders WHERE total > 100 ORDER BY total DESC');
    await q.init();
    expect(q.state.databases).toEqual(['shop', 'archive']);
    q.setDatabase('archive');
    await q.run();
    const find = rec.of('find')[0]!.input;
    expect(find).toMatchObject({ ns: { db: 'archive', collection: 'orders' }, pageSize: 100 });
    expect(find['executionId']).toEqual(expect.any(String));
    expect(fromEjson((find['query'] as { filter: string }).filter)).toEqual(
      parseShellDocument('{ total: { $gt: 100 } }'),
    );
    expect(q.results.state.documents).toEqual(ORDERS);
    expect(q.results.state.columnOrder).toEqual(['total', 'name']);
    expect(
      tableOf(q.results.values(), undefined, true, q.results.state.columnOrder).columns.map(
        (c) => c.key,
      ),
    ).toEqual(['total', 'name', '_id']);
    expect(q.state).toMatchObject({ running: false, ran: { kind: 'find', collection: 'orders' } });
    expect(history.of('add')[0]!.input).toMatchObject({
      profileId: PROFILE_ID,
      database: 'archive',
      text: 'SELECT total, name FROM orders WHERE total > 100 ORDER BY total DESC',
      status: 'success',
      rowCount: 2,
    });
  });

  it('runs GROUP BY through aggregate()', async () => {
    const { host, rec } = fakeHost();
    connectHost(host);
    const q = sqlTab('SELECT team, COUNT(*) AS n FROM people GROUP BY team');
    await q.run();
    const aggregate = rec.of('aggregate')[0]!.input;
    expect(aggregate['ns']).toEqual({ db: 'shop', collection: 'people' });
    const pipeline = fromEjson(aggregate['pipeline'] as string) as Record<string, unknown>[];
    expect(Object.keys(pipeline[0]!)).toEqual(['$group']);
    expect(q.results.state.documents).toHaveLength(1);
  });

  it('shows why SQL that does not translate cannot run, and runs nothing', async () => {
    const { host, rec } = fakeHost();
    connectHost(host);
    const q = sqlTab('SELECT FROM');
    await q.run();
    expect(q.state.notice).toMatchObject({ kind: 'error' });
    expect(q.state.notice!.text).toMatch(/^Fix the SQL first/);
    const blank = sqlTab('');
    await blank.run();
    expect(blank.state.notice).toMatchObject({ kind: 'info' });
    expect(rec.calls).toEqual([]);
    expect(history.calls).toEqual([]);
  });

  it('cancels the query on the server by its execution id', async () => {
    let fail!: (error: unknown) => void;
    const hanging = new Promise<never>((_resolve, reject) => {
      fail = reject;
    });
    // A cursor whose first page never comes until the query is cancelled.
    async function* pending(): AsyncGenerator<{ documents: string[] }> {
      yield await hanging;
    }
    const { host, rec } = fakeHost({
      find: (input: object) => {
        rec.record('find', input);
        return pending();
      },
    });
    host.cancel = async (input: object) => {
      rec.record('cancel', input);
      fail(new JoineryError({ code: 'CANCELLED', message: 'The operation was cancelled' }));
    };
    connectHost(host);
    const q = sqlTab('SELECT * FROM orders');
    const running = q.run();
    await vi.waitFor(() => expect(rec.of('find')).toHaveLength(1));
    expect(q.state.running).toBe(true);
    await q.cancel();
    await running;
    expect(rec.of('cancel')[0]!.input['executionId']).toBe(rec.of('find')[0]!.input['executionId']);
    expect(q.state).toMatchObject({ running: false, notice: { kind: 'info' } });
    expect(q.results.state.error).toBeUndefined();
    expect(history.of('add')[0]!.input['status']).toBe('cancelled');
  });
});

describe('where a translation goes', () => {
  it('opens a find() in the collection view with its fields, as a view when it is one', async () => {
    const { host } = fakeHost();
    connectHost(host);
    const q = sqlTab("SELECT name FROM open_orders WHERE status = 'open' ORDER BY name LIMIT 5");
    const destination = await q.collectionDestination();
    expect(destination?.target).toEqual({
      profileId: PROFILE_ID,
      db: 'shop',
      collection: 'open_orders',
      kind: 'view',
    });
    expect(destination?.fields).toMatchObject({
      filter: "{ status: 'open' }",
      sort: '{ name: 1 }',
      limit: '5',
    });
    const missing = sqlTab('SELECT * FROM ghosts');
    expect(await missing.collectionDestination()).toBeUndefined();
    expect(missing.state.notice?.text).toBe('shop.ghosts does not exist.');
    const grouped = sqlTab('SELECT team, COUNT(*) FROM people GROUP BY team');
    expect(await grouped.collectionDestination()).toBeUndefined();
    expect(grouped.state.notice?.text).toMatch(/aggregation editor/);
  });

  it('gives the aggregation editor and code export the translation as it is', () => {
    const grouped = translateSql(
      'SELECT team, COUNT(*) AS n FROM people GROUP BY team',
    ).translation!;
    // The aggregation editor reads the text back as the same stages.
    const opened = new AggregationEditor('agg', {
      profileId: PROFILE_ID,
      db: 'shop',
      collection: 'people',
      text: pipelineTextOf(grouped)!,
    });
    expect(opened.exportRequest()?.target).toEqual(exportTargetOf(grouped));
    expect(exportTargetOf(grouped)).toEqual({
      kind: 'aggregate',
      collection: 'people',
      pipeline: grouped.kind === 'aggregate' ? grouped.pipeline : [],
    });
    const find = translateSql('SELECT * FROM orders').translation!;
    expect(pipelineTextOf(find)).toBeUndefined();
    expect(exportTargetOf(find)).toMatchObject({ kind: 'find', collection: 'orders' });
  });
});

describe('code export requests', () => {
  it("exports the collection view's query, and says when a field does not parse", () => {
    const view = new CollectionView(
      'coll',
      { profileId: PROFILE_ID, db: 'shop', collection: 'orders', kind: 'collection' },
      { filter: '{ total: { $gt: 100 } }', sort: '{ total: -1 }', limit: '20' },
    );
    const request = view.exportRequest();
    expect(request?.database).toBe('shop');
    expect(request?.target).toMatchObject({
      kind: 'find',
      collection: 'orders',
      query: { limit: 20 },
    });
    view.setField('filter', '{ total: ');
    expect(view.exportRequest()).toBeUndefined();
    expect(view.state.notice).toEqual({ kind: 'error', text: 'Fix the query first.' });
  });

  it("exports the aggregation editor's enabled stages", () => {
    const editor = new AggregationEditor('agg', {
      profileId: PROFILE_ID,
      db: 'shop',
      collection: 'orders',
      text: "[{ $match: { status: 'open' } }, /* { $limit: 1 }, */ { $count: 'n' }]",
    });
    const request = editor.exportRequest();
    expect(request?.target).toMatchObject({ kind: 'aggregate', collection: 'orders' });
    expect(
      request?.target.kind === 'aggregate' && request.target.pipeline.map((s) => Object.keys(s)[0]),
    ).toEqual(['$match', '$count']);
    expect(exportSubject(request!)).toBe('shop.orders · aggregate() with 2 stages');
  });

  it('writes the program in the language picked, and remembers it', () => {
    const request = {
      target: exportTargetOf(
        translateSql('SELECT name FROM orders WHERE total > 100').translation!,
      ),
      database: 'shop',
    };
    const python = exportedCode(request, 'python');
    expect('code' in python && python.code).toMatch(/MONGODB_URI/);
    expect('code' in python && python.code).toMatch(/\["orders"\]/);
    expect(exportedCode({ ...request, database: '' }, 'node')).toEqual({
      error: 'Choose a database to export for',
    });
    expect(lastExportLanguage()).toBe('node');
    rememberExportLanguage('go');
    expect(lastExportLanguage()).toBe('go');
    expect(exportLanguage('go')).toMatchObject({ fileName: 'main.go', editorLanguage: 'go' });
  });
});

describe('result column order', () => {
  it('starts each result with its own column order', () => {
    const results = new DocumentResults();
    results.begin(undefined, ['b', 'a']);
    expect(results.state.columnOrder).toEqual(['b', 'a']);
    results.begin();
    expect(results.state.columnOrder).toEqual([]);
  });
});
