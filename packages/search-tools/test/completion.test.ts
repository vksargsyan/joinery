import { describe, expect, it } from 'vitest';

import { API_SPEC, completeConsole, endpointFor, matchEndpoints } from '../src';

/** Completes at the "|" in `text`. */
function complete(text: string, options: Parameters<typeof completeConsole>[2] = {}) {
  const offset = text.indexOf('|');
  const buffer = text.slice(0, offset) + text.slice(offset + 1);
  const result = completeConsole(buffer, offset, options);
  return {
    result,
    labels: result?.items.map((i) => i.label) ?? [],
    replaced: result ? buffer.slice(result.from, result.to) : undefined,
  };
}

describe('the generated API data', () => {
  it('records its source and licence', () => {
    expect(API_SPEC.source).toMatchObject({
      repository: 'https://github.com/elastic/elasticsearch-specification',
      license: 'Apache-2.0',
    });
    expect(API_SPEC.endpoints.length).toBeGreaterThan(400);
  });

  it('matches paths to endpoints, most specific first', () => {
    expect(endpointFor('GET', '/_cat/indices')?.name).toBe('cat.indices');
    expect(endpointFor('POST', '/orders/_search')?.name).toBe('search');
    expect(endpointFor('PUT', '/orders')?.name).toBe('indices.create');
    expect(endpointFor('POST', '/orders/_bulk')).toMatchObject({ name: 'bulk', body: 'ndjson' });
    expect(matchEndpoints('GET', '/orders/_doc/1')[0]?.params).toEqual({
      index: 'orders',
      id: '1',
    });
  });
});

describe('completeConsole', () => {
  it('offers methods at the start of a line', () => {
    const { labels, replaced } = complete('G|');
    expect(labels).toEqual(['GET', 'POST', 'PUT', 'DELETE', 'HEAD', 'PATCH']);
    expect(replaced).toBe('G');
    expect(complete('GET /_search\n\n|').labels).toContain('POST');
  });

  it('offers endpoint paths for the method, with placeholders as snippet stops', () => {
    const { result, labels, replaced } = complete('GET _cat/i|');
    expect(labels).toContain('indices');
    expect(labels).toContain('indices/{index}');
    expect(replaced).toBe('i');
    const withIndex = result!.items.find((i) => i.label === 'indices/{index}')!;
    expect(withIndex).toMatchObject({ snippet: true, insertText: 'indices/${1:index}' });
    expect(complete('POST /|').labels).toContain('_bulk');
    expect(complete('DELETE /|').labels).not.toContain('_bulk');
  });

  it('offers index names where an index goes', () => {
    const { result } = complete('GET /|', { indices: ['orders', 'logs-2026'] });
    expect(result!.items.filter((i) => i.kind === 'index').map((i) => i.label)).toEqual([
      'orders',
      'logs-2026',
    ]);
  });

  it('leaves out Elasticsearch-only APIs on OpenSearch and adds its own', () => {
    expect(complete('POST /_q|').labels).toContain('_query');
    const os = complete('POST /_|', { distribution: 'opensearch' }).labels;
    expect(os).not.toContain('_query');
    expect(os).toContain('_plugins/_sql');
  });

  it('offers query parameters of the endpoint after "?"', () => {
    const { labels, replaced } = complete('GET /orders/_search?size=5&tr|');
    expect(labels).toContain('track_total_hits');
    expect(labels).not.toContain('size');
    expect(replaced).toBe('tr');
    expect(complete('GET /orders/_search?size=|').result).toBeUndefined();
  });

  it('offers body keys along the JSON path, without the ones already there', () => {
    expect(complete('POST /orders/_search\n{\n  |\n}').labels).toEqual(
      expect.arrayContaining(['query', 'aggregations', 'aggs', 'size', 'sort', '_source']),
    );
    const bool = complete(
      'GET /orders/_search\n{\n  "query": {\n    "bool": {\n      "must": [\n        { "ma|',
    ).result!;
    expect(bool.items.map((i) => i.label)).toEqual(expect.arrayContaining(['match', 'match_all']));
    const present = complete('GET /x/_search\n{ "size": 1, "query": {}, |').labels;
    expect(present).not.toContain('size');
    expect(present).not.toContain('query');
    expect(present).toContain('from');
  });

  it('inserts a value template that fits the property type', () => {
    const items = complete('POST /x/_search\n{\n  "|').result!.items;
    expect(items.find((i) => i.label === 'query')!.insertText).toBe('"query": {\n\t$0\n}');
    expect(items.find((i) => i.label === 'size')!.insertText).toBe('"size": $0');
    expect(items.find((i) => i.label === 'explain')!.insertText).toBe(
      '"explain": ${1|true,false|}',
    );
  });

  it('replaces the typed part of a key, and a closing quote the editor added', () => {
    const { result, replaced } = complete('POST /x/_search\n{ "qu|" }');
    expect(replaced).toBe('"qu"');
    expect(result!.items.map((i) => i.label)).toContain('query');
  });

  it('offers enum values in value position', () => {
    const { labels } = complete(
      'PUT /x\n{ "mappings": { "properties": { "a": { "type": "keyword", "index_options": |',
    );
    expect(labels).toEqual(expect.arrayContaining(['"docs"', '"freqs"', '"positions"']));
  });

  it('completes each NDJSON line of a bulk body', () => {
    expect(complete('POST /_bulk\n{ "index": { "_index": "a" } }\n{ |').labels).toContain('index');
    expect(complete('POST /_bulk\n{ "index": { "_i|').labels).toContain('_index');
  });

  it('has nothing to offer inside a string value or a comment', () => {
    expect(complete('POST /x/_search\n{ "query": { "match": { "a": "hel|').result).toBeUndefined();
    expect(complete('POST /x/_search\n{ # a comm|').result).toBeUndefined();
  });
});
