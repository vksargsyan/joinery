import type { SearchClusterInfo, SearchPage, SearchTable } from '@querybara/search-tools';
import { describe, expect, it } from 'vitest';

import {
  connectionHostContract,
  createClient,
  parseRequest,
  searchClusterInfoSchema,
  searchHostContractShape,
  searchPageSchema,
  searchTableSchema,
  serve,
  type HandlersOf,
} from '../src';
import { portPair, unusedHandlers } from './helpers';

/** The Elasticsearch namespace of the connection host contract (spec §11). */

describe('search schemas', () => {
  it('round-trips the wire types unchanged', () => {
    const info: SearchClusterInfo = {
      version: '9.4.0',
      clusterName: 'es',
      plugins: ['analysis-icu'],
      capabilities: {
        esql: true,
        sql: true,
        dataStreams: true,
        lifecycle: true,
        pointInTime: true,
        shardDocSort: true,
        searchAfter: true,
        asyncSearch: true,
        composableTemplates: true,
        cloneIndex: true,
        security: false,
      },
    };
    expect(searchClusterInfoSchema.parse(info)).toEqual(info);
    const page: SearchPage = {
      hits: [
        {
          index: 'a',
          id: '1',
          score: null,
          source: '{"n":12345678901234567890}',
          seqNo: 3,
          primaryTerm: 1,
        },
      ],
      total: { value: 1, relation: 'eq' },
      took: 2,
      timedOut: false,
      paging: 'pit',
    };
    expect(searchPageSchema.parse(page)).toEqual(page);
  });

  it('refuses malformed input before it reaches the host', () => {
    const invalid = [
      ['search.request', { sessionId: 's', request: { method: 'GET', path: 'no-slash' } }],
      ['search.request', { sessionId: 's', request: { method: 'TRACE', path: '/' } }],
      ['search.indices.delete', { sessionId: 's', names: [] }],
      ['search.documents.search', { sessionId: 's', target: 'a', pageSize: 20_000 }],
      ['search.documents.index', { sessionId: 's', index: 'a', source: '' }],
      ['search.documents.update', { sessionId: 's', index: 'a', id: 'x', doc: '{}', ifSeqNo: -1 }],
    ] as const;
    for (const [path, input] of invalid) {
      expect(() => parseRequest(connectionHostContract, path, input), path).toThrow(
        expect.objectContaining({ code: 'VALIDATION_FAILED' }),
      );
    }
  });

  it('names the services, with the paged search as a stream', () => {
    const methods = connectionHostContract.methods;
    const paths = [...methods.keys()].filter((p) => p.startsWith('search.'));
    expect(paths).toEqual(
      expect.arrayContaining([
        'search.clusterInfo',
        'search.clusterHealth',
        'search.nodes',
        'search.indices.list',
        'search.indices.create',
        'search.indices.forceMerge',
        'search.indices.getMapping',
        'search.aliases.update',
        'search.dataStreams.list',
        'search.documents.get',
        'search.documents.bulk',
        'search.documents.deleteByQuery',
        'search.request',
      ]),
    );
    expect(methods.get('search.documents.search')?.kind).toBe('stream');
    expect(methods.get('search.request')?.kind).toBe('unary');
  });

  it('names the query and administration services, with SQL pages as a stream', () => {
    const methods = connectionHostContract.methods;
    expect([...methods.keys()]).toEqual(
      expect.arrayContaining([
        'search.sql.query',
        'search.sql.translate',
        'search.esql.query',
        'search.indexAdmin.resize',
        'search.indexAdmin.reindex',
        'search.tasks.get',
        'search.tasks.cancel',
        'search.allocation.shards',
        'search.allocation.explain',
        'search.allocation.disk',
        'search.resources.list',
        'search.resources.put',
        'search.resources.delete',
        'search.pipelines.simulate',
        'search.snapshots.list',
        'search.snapshots.restore',
      ]),
    );
    expect(methods.get('search.sql.query')?.kind).toBe('stream');
  });

  it('checks task ids, resource kinds and SQL tables', () => {
    for (const [path, input] of [
      ['search.tasks.get', { sessionId: 's', taskId: 'not-a-task' }],
      ['search.tasks.cancel', { sessionId: 's', taskId: 'n1:1/_cancel' }],
      ['search.resources.list', { sessionId: 's', kind: 'widgets' }],
      ['search.indexAdmin.resize', { sessionId: 's', kind: 'merge', source: 'a', target: 'b' }],
      ['search.indexAdmin.reindex', { sessionId: 's', source: [], dest: 'b' }],
    ] as const) {
      expect(() => parseRequest(connectionHostContract, path, input), path).toThrow(
        expect.objectContaining({ code: 'VALIDATION_FAILED' }),
      );
    }
    expect(
      parseRequest(connectionHostContract, 'search.tasks.get', { sessionId: 's', taskId: 'n1:42' }),
    ).toMatchObject({ input: { sessionId: 's', taskId: 'n1:42' } });
    const table: SearchTable = {
      columns: [{ name: 'n', type: 'long' }],
      rows: [['12345678901234567890']],
      more: true,
    };
    expect(searchTableSchema.parse(table)).toEqual(table);
  });
});

describe('search contract', () => {
  it('carries JSON text across a port exactly', async () => {
    const ports = portPair();
    const body = '{"n": 12345678901234567890, "price": 1.10}';
    const search: HandlersOf<typeof searchHostContractShape> = {
      ...unusedHandlers(searchHostContractShape),
      request: ({ request }) => ({
        status: 200,
        contentType: 'application/json',
        body: request.body ?? '',
        durationMs: 3,
        warnings: ['[types removal] deprecated'],
        truncated: false,
      }),
      documents: {
        ...unusedHandlers(searchHostContractShape.documents),
        async *search() {
          yield {
            hits: [{ index: 'a', id: '1', score: 1, source: body }],
            took: 1,
            timedOut: false,
            paging: 'scroll',
          };
        },
      },
    };
    serve(ports.server, connectionHostContract, {
      ...unusedHandlers(connectionHostContract.shape),
      search,
    });
    const client = createClient(ports.client, connectionHostContract);
    const response = await client.search.request({
      sessionId: 's',
      request: { method: 'POST', path: '/a/_doc', body },
    });
    expect(response.body).toBe(body);
    expect(response.warnings).toEqual(['[types removal] deprecated']);
    const pages = [];
    for await (const page of client.search.documents.search({ sessionId: 's', target: 'a' }))
      pages.push(page);
    expect(pages[0]!.hits[0]!.source).toBe(body);
    await expect(client.search.indices.list({ sessionId: 's' })).rejects.toMatchObject({
      code: 'NOT_SUPPORTED',
    });
    client.dispose();
  });
});
