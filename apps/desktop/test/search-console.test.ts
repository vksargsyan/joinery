import type { BrowseNode } from '@joinery/core';
import type { SearchResponse } from '@joinery/search-tools';
import { describe, expect, it } from 'vitest';

import {
  decideSearchRequest,
  searchWritePolicy,
  type SearchWritePolicy,
} from '../src/shared/search-writes';
import {
  ConsoleHistory,
  autoIndent,
  plannedRequests,
  responseView,
  runRequests,
  statusText,
  summarize,
  type ConsoleResponseView,
} from '../src/renderer/src/state/search/console-flow';
import {
  deleteRequest,
  healthOf,
  searchObjectOf,
  searchText,
} from '../src/renderer/src/state/search/explorer';
import { profileInput } from './helpers';
import { connectionProfileSchema } from '@joinery/core';

/** The console's run flow, response views and the explorer's objects (spec §11). */

const TEXT = `GET /_cluster/health

PUT /orders
{"settings": {"number_of_replicas": 0}}

DELETE /orders

POST /orders/_search
{
  "query": { "match_al": {} }
}
`;

const DEV: SearchWritePolicy = {
  readOnly: false,
  confirmWrites: false,
  production: false,
  profileName: 'Logs',
};

function response(
  status: number,
  body: string,
  extra: Partial<SearchResponse> = {},
): SearchResponse {
  return {
    status,
    body,
    contentType: 'application/json',
    durationMs: 4,
    warnings: [],
    truncated: false,
    ...extra,
  };
}

describe('plannedRequests', () => {
  it('sends the request at the cursor, or every request a selection touches', () => {
    expect(plannedRequests(TEXT, 3).map((p) => p.label)).toEqual(['GET /_cluster/health']);
    // A blank line after a request still belongs to it.
    expect(plannedRequests(TEXT, TEXT.indexOf('PUT') - 1).map((p) => p.label)).toEqual([
      'GET /_cluster/health',
    ]);
    const all = plannedRequests(TEXT, 0, TEXT.length);
    expect(all.map((p) => p.label)).toEqual([
      'GET /_cluster/health',
      'PUT /orders',
      'DELETE /orders',
      'POST /orders/_search',
    ]);
    expect(all[1]!.wire).toEqual({
      method: 'PUT',
      path: '/orders',
      body: '{"settings": {"number_of_replicas": 0}}',
    });
    expect(all[1]!.text).toBe('PUT /orders\n{"settings": {"number_of_replicas": 0}}');
    const broken = plannedRequests('POST /x/_search\n{ "a": \n', 0);
    expect(broken[0]!.problem?.message).toBeDefined();
  });
});

describe('runRequests', () => {
  it('runs reads, asks before destructive requests, and stops when declined', async () => {
    const sent: string[] = [];
    const asked: string[] = [];
    const views: ConsoleResponseView[] = [];
    await runRequests(plannedRequests(TEXT, 0, TEXT.length), {
      policy: DEV,
      confirm: async (item, decision) => {
        asked.push(`${item.label}: ${decision.reason}`);
        return false;
      },
      send: async (item) => {
        sent.push(item.label);
        return response(200, '{"acknowledged": true}');
      },
      onResult: (view) => views.push(view),
    });
    expect(sent).toEqual(['GET /_cluster/health', 'PUT /orders']);
    expect(asked).toEqual(['DELETE /orders: This deletes the index and all its documents.']);
    expect(views.map((v) => [v.label, v.status, v.summary ?? v.error])).toEqual([
      ['GET /_cluster/health', 200, 'acknowledged'],
      ['PUT /orders', 200, 'acknowledged'],
      ['DELETE /orders', undefined, 'DELETE /orders was not sent'],
    ]);
  });

  it('sends a confirmed write with the confirmation, and refuses writes when read-only', async () => {
    const confirmed: boolean[] = [];
    await runRequests(plannedRequests(TEXT, TEXT.indexOf('DELETE')), {
      policy: DEV,
      confirm: async () => true,
      send: async (_item, ok) => {
        confirmed.push(ok);
        return response(200, '{"acknowledged": true}');
      },
      onResult: () => undefined,
    });
    expect(confirmed).toEqual([true]);
    const views: ConsoleResponseView[] = [];
    await runRequests(plannedRequests(TEXT, TEXT.indexOf('PUT')), {
      policy: { ...DEV, readOnly: true },
      confirm: async () => true,
      send: async () => {
        throw new Error('must not send');
      },
      onResult: (view) => views.push(view),
    });
    expect(views[0]!.error).toContain('read-only');
  });

  it('asks before every write on production, not before reads', () => {
    const production = { ...DEV, production: true, confirmWrites: true };
    expect(decideSearchRequest({ method: 'POST', path: '/x/_search' }, production).action).toBe(
      'run',
    );
    expect(decideSearchRequest({ method: 'PUT', path: '/x/_doc/1' }, production)).toMatchObject({
      action: 'confirm',
      destructive: false,
      reason: expect.stringContaining('production'),
    });
    const profile = connectionProfileSchema.parse(
      profileInput({
        engine: 'elasticsearch',
        endpoint: { kind: 'urls', urls: ['http://x:9200'] },
        presentation: { environment: 'production' },
      }),
    );
    expect(searchWritePolicy(profile)).toMatchObject({ confirmWrites: true, production: true });
  });
});

describe('response views', () => {
  it('re-indents JSON exactly, keeps text as it came, and summarizes', () => {
    const [search] = plannedRequests(TEXT, TEXT.indexOf('POST'));
    const view = responseView(
      search!,
      response(
        200,
        '{"took":1,"hits":{"total":{"value":10000,"relation":"gte"},"hits":[{"_source":{"n":12345678901234567890}}]}}',
      ),
    );
    expect(view.body).toContain('"n": 12345678901234567890');
    expect(view.summary).toBe('10,000+ hits');
    const text = responseView(
      search!,
      response(200, 'green open orders', { contentType: 'text/plain' }),
    );
    expect(text.body).toBe('green open orders');
    expect(summarize('{"count": 3, "_shards": {}}')).toBe('count 3');
    expect(summarize('{"items": [{"index": {"status": 201}}, {"delete": {"error": {}}}]}')).toBe(
      '2 items, 1 failed',
    );
    expect(summarize('{"_index": "a", "result": "created"}')).toBe('created');
    expect(summarize('{"total": 4, "deleted": 4}')).toBe('4 deleted');
    expect(summarize('not json')).toBeUndefined();
    expect(statusText(404)).toBe('404 Not Found');
  });

  it('points at the server error position in the console text', () => {
    const [search] = plannedRequests(TEXT, TEXT.indexOf('POST'));
    const view = responseView(
      search!,
      response(
        400,
        JSON.stringify({
          error: {
            type: 'parsing_exception',
            reason: 'unknown query [match_al]',
            line: 2,
            col: 25,
          },
          status: 400,
        }),
      ),
    );
    expect(view.error).toBe('unknown query [match_al]');
    // Where Elasticsearch points: just past the unknown name.
    expect(TEXT.slice(view.errorOffset!)).toMatch(/^ \{\}/);
  });
});

describe('console helpers', () => {
  it('keeps a history without repeats, newest first', () => {
    const history = new ConsoleHistory([], 3);
    for (const text of ['GET /', 'GET /', 'PUT /a', '  ', 'GET /b', 'GET /c']) history.push(text);
    expect(history.entries).toEqual(['GET /c', 'GET /b', 'PUT /a']);
    history.push('PUT /a');
    expect(history.entries).toEqual(['PUT /a', 'GET /c', 'GET /b']);
  });

  it('re-indents the bodies of the requests at the cursor', () => {
    const text = 'GET /\n\nPOST /a/_search\n{"query":{"match_all":{}},"size":1.10}\n';
    expect(autoIndent(text, text.indexOf('POST'))).toBe(
      'GET /\n\nPOST /a/_search\n{\n  "query": {\n    "match_all": {}\n  },\n  "size": 1.10\n}\n',
    );
  });
});

describe('the search explorer', () => {
  const node = (kind: BrowseNode['kind'], path: string[], detail = {}): BrowseNode => ({
    kind,
    name: path[1] ?? path[0]!,
    path,
    hasChildren: false,
    detail,
  });

  it('reads objects, health and the requests they send', () => {
    const index = searchObjectOf(
      node('index', ['indices', 'orders'], { health: 'yellow', status: 'open' }),
    );
    expect(index).toEqual({ kind: 'index', name: 'orders', status: 'open' });
    expect(healthOf(node('index', ['indices', 'o'], { health: 'yellow', status: 'open' }))).toBe(
      'yellow',
    );
    expect(healthOf(node('index', ['indices', 'o'], { health: 'red', status: 'close' }))).toBe(
      'closed',
    );
    expect(deleteRequest(index!)).toEqual({ method: 'DELETE', path: '/orders' });
    expect(deleteRequest({ kind: 'data-stream', name: 'logs' })).toEqual({
      method: 'DELETE',
      path: '/_data_stream/logs',
    });
    expect(deleteRequest({ kind: 'alias', name: 'current' })).toBeUndefined();
    expect(searchText(index!)).toBe(
      'GET /orders/_search\n{\n  "query": {\n    "match_all": {}\n  }\n}\n',
    );
    expect(searchObjectOf(node('folder', ['indices']))).toBeUndefined();
  });
});
