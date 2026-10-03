import { newId, rowAt, type ResultChunk } from '@querybara/core';
import { parseJsonTree, stringAt } from '@querybara/search-tools';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { SearchSession } from '../../src';
import { SERVERS, allIds, cleanUp, connect, testPrefix } from './helpers';

/**
 * The session services against real servers (spec §11): index administration, mappings and
 * settings, aliases, data streams, documents with optimistic concurrency, bulk, paged search
 * (point in time and scroll), delete by query, the console's raw requests and `execute`.
 */

describe.skipIf(SERVERS.length === 0).each(SERVERS)('services', (server) => {
  const prefix = testPrefix();
  const orders = `${prefix}orders`;
  const logs = `${prefix}logs`;
  const template = `${prefix}template`;
  let session: SearchSession;

  beforeAll(async () => {
    session = await connect(server);
  });

  afterAll(async () => {
    if (!session) return;
    await cleanUp(session, {
      dataStreams: [logs],
      templates: [template],
      indices: [orders, `${orders}-copy`, `${prefix}closed`, `${prefix}paged`],
    });
    await session.close();
  });

  it('knows what the server is', () => {
    expect(session.serverVersion).toMatch(/^\d+\.\d+/);
    expect(session.searchCapabilities.pointInTime).toBe(true);
    expect(session.capabilities()).toMatchObject({ queryCancel: true, clusterMode: true });
  });

  it('reads cluster information, health and nodes', async () => {
    const info = await session.clusterInfo();
    expect(info).toMatchObject({ version: session.serverVersion });
    expect(info.clusterName).not.toBe('');
    expect(info.license).toMatchObject({ status: 'active' });
    expect(info.capabilities.esql).toBe(true);
    const health = await session.clusterHealth();
    expect(['green', 'yellow']).toContain(health.status);
    expect(health.nodes).toBeGreaterThan(0);
    const nodes = await session.nodes();
    expect(nodes[0]).toMatchObject({ master: true, version: session.serverVersion });
    const stats = await session.nodeStats({ metrics: ['jvm'] });
    expect(parseJsonTree(stats).type).toBe('object');
  });

  it('creates an index, lists it with health and reads and extends its mapping and settings', async () => {
    await session.createIndex(
      orders,
      JSON.stringify({
        settings: { number_of_replicas: 0 },
        mappings: { properties: { total: { type: 'long' }, customer: { type: 'keyword' } } },
      }),
    );
    const list = await session.listIndices({ pattern: `${prefix}*` });
    expect(list.map((i) => i.name)).toContain(orders);
    expect(list.find((i) => i.name === orders)).toMatchObject({
      health: 'green',
      status: 'open',
      primaries: 1,
      replicas: 0,
      docsCount: 0,
    });
    await session.putMapping(orders, '{"properties": {"note": {"type": "text"}}}');
    const mapping = parseJsonTree(await session.getMapping(orders));
    expect(stringAt(mapping, orders, 'mappings', 'properties', 'note', 'type')).toBe('text');
    await session.putSettings(orders, '{"index": {"refresh_interval": "2s"}}');
    const settings = parseJsonTree(await session.getSettings(orders));
    expect(stringAt(settings, orders, 'settings', 'index', 'refresh_interval')).toBe('2s');
    await expect(session.createIndex(orders)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(session.putMapping(orders, '{"properties": ')).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
  });

  it('keeps documents exact and applies optimistic concurrency', async () => {
    const source = '{"total": 1234567890123456789, "price": 1.10, "customer": "ada"}';
    const created = await session.indexDocument(orders, source, { id: 'o1', refresh: true });
    expect(created).toMatchObject({ index: orders, id: 'o1', result: 'created', seqNo: 0 });
    const read = await session.getDocument(orders, 'o1');
    expect(read).toMatchObject({ found: true, seqNo: 0, primaryTerm: 1 });
    expect(read.source).toBe(source);
    expect(await session.getDocument(orders, 'missing')).toEqual({
      index: orders,
      id: 'missing',
      found: false,
    });

    const updated = await session.updateDocument(orders, 'o1', '{"customer": "grace"}', {
      ifSeqNo: read.seqNo!,
      ifPrimaryTerm: read.primaryTerm!,
      refresh: true,
    });
    expect(updated).toMatchObject({ result: 'updated', seqNo: 1 });
    // The stale version conflicts, and the error carries the current document.
    const stale = session.indexDocument(orders, '{"customer": "old"}', {
      id: 'o1',
      ifSeqNo: read.seqNo!,
      ifPrimaryTerm: read.primaryTerm!,
    });
    await expect(stale).rejects.toMatchObject({ code: 'CONFLICT' });
    const conflict = await stale.then(
      () => undefined,
      (error: { detail?: string }) => error,
    );
    expect(conflict?.detail).toContain('"customer":"grace"');
    expect(conflict?.detail).toContain('1234567890123456789');
    await expect(
      session.indexDocument(orders, '{}', { id: 'o1', opType: 'create' }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });

    const deleted = await session.deleteDocument(orders, 'o1', { refresh: true });
    expect(deleted.result).toBe('deleted');
    expect((await session.deleteDocument(orders, 'o1')).result).toBe('not_found');
    await expect(session.getDocument(`${prefix}nope`, 'x')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('runs bulk requests and reports each item', async () => {
    const lines = Array.from({ length: 30 }, (_, i) => [
      JSON.stringify({ index: { _id: `b${i}` } }),
      JSON.stringify({ total: i, customer: i % 2 === 0 ? 'even' : 'odd' }),
    ]).flat();
    const result = await session.bulk(`${lines.join('\n')}\n`, { index: orders, refresh: true });
    expect(result.errors).toBe(false);
    expect(result.items).toHaveLength(30);
    expect(result.items[0]).toMatchObject({ action: 'index', status: 201, result: 'created' });
    const failing = await session.bulk('{"create":{"_id":"b0"}}\n{"total":1}\n', {
      index: orders,
    });
    expect(failing.errors).toBe(true);
    expect(failing.items[0]!.error?.type).toBe('version_conflict_engine_exception');
    expect(await session.count(orders)).toBe(30);
    expect(await session.count(orders, '{"term": {"customer": "even"}}')).toBe(15);
  });

  it('pages deep searches with a point in time, a scroll, or one page', async () => {
    const pit = [];
    for await (const page of session.search(
      orders,
      '{"query": {"match_all": {}}, "sort": [{"total": "asc"}]}',
      {
        pageSize: 7,
      },
    )) {
      pit.push(page);
    }
    expect(pit.map((p) => p.paging)).toEqual(['pit', 'pit', 'pit', 'pit', 'pit']);
    expect(pit.map((p) => p.hits.length)).toEqual([7, 7, 7, 7, 2]);
    expect(pit[0]!.total).toEqual({ value: 30, relation: 'eq' });
    const ids = pit.flatMap((p) => p.hits.map((h) => h.id));
    expect(new Set(ids).size).toBe(30);
    expect(ids.slice(0, 3)).toEqual(['b0', 'b1', 'b2']);
    expect(pit[0]!.hits[0]).toMatchObject({
      seqNo: expect.any(Number),
      primaryTerm: 1,
      source: '{"total":0,"customer":"even"}',
    });

    const scrolled = await allIds(
      session.search(orders, undefined, { pageSize: 8, paging: 'scroll' }),
    );
    expect(new Set(scrolled).size).toBe(30);
    const limited = await allIds(session.search(orders, '{"size": 12}', { pageSize: 5 }));
    expect(limited).toHaveLength(12);
    const single = [];
    for await (const page of session.search(
      orders,
      '{"from": 5, "size": 3, "sort": ["total"], "aggs": {"c": {"terms": {"field": "customer"}}}}',
    )) {
      single.push(page);
    }
    expect(single).toHaveLength(1);
    expect(single[0]!.paging).toBe('single');
    expect(single[0]!.hits.map((h) => h.id)).toEqual(['b5', 'b6', 'b7']);
    expect(single[0]!.aggregations).toContain('"even"');
    // Stopping early releases the point in time.
    for await (const page of session.search(orders, undefined, { pageSize: 2 })) {
      expect(page.hits).toHaveLength(2);
      break;
    }
  });

  it('deletes by query after a dry run', async () => {
    const query = '{"range": {"total": {"gte": 25}}}';
    expect(await session.deleteByQuery(orders, query, { dryRun: true })).toMatchObject({
      dryRun: true,
      total: 5,
      deleted: 0,
    });
    expect(await session.deleteByQuery(orders, query, { refresh: true })).toMatchObject({
      dryRun: false,
      total: 5,
      deleted: 5,
    });
    expect(await session.count(orders)).toBe(25);
  });

  it('manages aliases and index state', async () => {
    await session.updateAliases(
      JSON.stringify({
        actions: [{ add: { index: orders, alias: `${prefix}current`, is_write_index: true } }],
      }),
    );
    const aliases = await session.listAliases();
    expect(aliases.find((a) => a.alias === `${prefix}current`)).toMatchObject({
      index: orders,
      isWriteIndex: true,
      filtered: false,
    });
    const closed = `${prefix}closed`;
    await session.createIndex(closed, '{"settings": {"number_of_replicas": 0}}');
    await session.closeIndices([closed]);
    expect((await session.listIndices({ pattern: closed }))[0]).toMatchObject({ status: 'close' });
    await session.openIndices([closed]);
    await session.refresh([orders, closed]);
    await session.flush([orders]);
    await session.forceMerge([closed], { maxNumSegments: 1 });
    await session.deleteIndices([closed]);
    expect(await session.listIndices({ pattern: `${prefix}closed*` })).toEqual([]);
  });

  it('lists data streams', async () => {
    await session.request({
      method: 'PUT',
      path: `/_index_template/${template}`,
      body: JSON.stringify({
        index_patterns: [`${logs}*`],
        data_stream: {},
        template: { settings: { number_of_replicas: 0 } },
        priority: 500,
      }),
    });
    await session.indexDocument(logs, '{"@timestamp": "2026-09-29T12:00:00Z", "message": "hi"}', {
      opType: 'create',
      refresh: true,
    });
    const streams = await session.listDataStreams();
    const stream = streams.find((s) => s.name === logs);
    expect(stream).toMatchObject({ generation: 1, template, timestampField: '@timestamp' });
    expect(stream!.indices).toHaveLength(1);
    const tree = await session.browse(['data-streams']);
    expect(tree.find((n) => n.name === logs)).toMatchObject({ kind: 'data-stream' });
  });

  it('browses indices and aliases and introspects mappings', async () => {
    const root = await session.browse([]);
    expect(root.map((n) => n.path[0])).toEqual(['indices', 'data-streams', 'aliases']);
    const indexNodes = await session.browse(['indices']);
    expect(indexNodes.find((n) => n.name === orders)).toMatchObject({
      kind: 'index',
      path: ['indices', orders],
      detail: { health: 'green', status: 'open', docs: 25 },
    });
    const aliases = await session.browse(['aliases']);
    expect(aliases.find((n) => n.name === `${prefix}current`)).toMatchObject({
      kind: 'alias',
      detail: { indices: orders },
    });
    const snapshot = await session.introspect();
    const table = snapshot.schemas[0]!.tables.find((t) => t.name === orders);
    expect(table?.columns.map((c) => [c.name, c.dataType])).toEqual(
      expect.arrayContaining([
        ['total', 'long'],
        ['customer', 'keyword'],
        ['note', 'text'],
      ]),
    );
  });

  it('sends raw requests, error bodies included', async () => {
    const ok = await session.request({ method: 'GET', path: `/${orders}/_count` });
    expect(ok).toMatchObject({ status: 200, contentType: 'application/json', truncated: false });
    expect(ok.body).toContain('"count":25');
    const text = await session.request({
      method: 'GET',
      path: '/_cat/indices',
      query: `v&index=${orders}`,
    });
    expect(text.contentType).toBe('text/plain');
    expect(text.body).toContain('health');
    const missing = await session.request({ method: 'GET', path: `/${prefix}nope/_search` });
    expect(missing.status).toBe(404);
    expect(missing.body).toContain('index_not_found_exception');
    const head = await session.request({ method: 'HEAD', path: `/${orders}` });
    expect(head).toMatchObject({ status: 200, body: '' });
    const ndjson = await session.request({
      method: 'POST',
      path: '/_msearch',
      body: `{"index": "${orders}"}\n{"size": 1}\n`,
      bodyKind: 'ndjson',
    });
    expect(ndjson.status).toBe(200);
    expect(ndjson.body).toContain('"responses"');
  });

  it('executes console text, one result per request, and stops at an error with its position', async () => {
    const chunks: ResultChunk[] = [];
    for await (const chunk of session.execute(
      `GET /${orders}/_count\n\nPOST /${orders}/_search\n{\n  "size": 1, # one\n  "query": {"match_all": {}}\n}\n`,
      { executionId: newId() },
    )) {
      chunks.push(chunk);
    }
    const rows = chunks.filter((c) => c.type === 'rows');
    expect(rows).toHaveLength(2);
    expect(String(rowAt(rows[0] as Extract<ResultChunk, { type: 'rows' }>, 0)[0])).toContain(
      '"count":25',
    );
    expect(
      chunks.filter((c) => c.type === 'status').map((c) => (c as { command: string }).command),
    ).toEqual([`GET /${orders}/_count → 200`, `POST /${orders}/_search → 200`]);
    expect(chunks.at(-1)).toMatchObject({ type: 'end', rowCount: 2 });

    const text = `GET /_cluster/health\n\nPOST /${orders}/_search\n{\n  "query": { "match_al": {} }\n}\n`;
    let failure: { code?: string; position?: number; message?: string } | undefined;
    try {
      for await (const _chunk of session.execute(text, { executionId: newId() })) {
        // Drain.
      }
    } catch (error) {
      failure = error as typeof failure;
    }
    expect(failure).toMatchObject({ code: 'SQL_ERROR' });
    expect(failure!.message).toContain('match_al');
    // The server points just past the unknown name; the position lands there in the text.
    const name = text.indexOf('"match_al"');
    expect(failure!.position).toBeGreaterThan(name);
    expect(failure!.position).toBeLessThanOrEqual(name + '"match_al": {}'.length);
  });

  it('cancels a request in flight', async () => {
    const executionId = newId();
    // Waits for nodes that never come: a long request to cancel.
    const slow = session.request(
      { method: 'GET', path: '/_cluster/health', query: 'wait_for_nodes=99&timeout=20s' },
      { executionId },
    );
    const cancelled = expect(slow).rejects.toMatchObject({ code: 'CANCELLED' });
    await new Promise((resolve) => setTimeout(resolve, 300));
    const started = performance.now();
    await session.cancel(executionId);
    await cancelled;
    expect(performance.now() - started).toBeLessThan(5_000);
    const controller = new AbortController();
    const aborted = session.request(
      { method: 'GET', path: '/_cluster/health', query: 'wait_for_nodes=99&timeout=20s' },
      { signal: controller.signal },
    );
    const stopped = expect(aborted).rejects.toMatchObject({ code: 'CANCELLED' });
    setTimeout(() => controller.abort(), 200);
    await stopped;
    // A request timeout of the call applies too.
    await expect(
      session.request(
        { method: 'GET', path: '/_cluster/health', query: 'wait_for_nodes=99&timeout=20s' },
        { timeoutMs: 300 },
      ),
    ).rejects.toMatchObject({ code: 'TIMEOUT' });
  });
});
