import { describe, expect, it } from 'vitest';

import {
  bodyErrorOffset,
  formatConsoleRequest,
  issuesOf,
  parseConsole,
  requestAt,
  requestsIn,
  splitUrl,
} from '../src';

const BUFFER = `# Kibana console buffer
GET _cat/indices?v&s=index

PUT /orders
{
  "settings": { "number_of_replicas": 0 },
  "mappings": {
    "properties": {
      "total": { "type": "scaled_float", "scaling_factor": 100 } // cents
    }
  }
}

POST orders/_bulk?refresh=true
{ "index": { "_id": "1" } }
{ "total": 12.50, "id": 12345678901234567890 }
{ "delete": { "_id": "2" } }

get /orders/_search
{
  "query": {
    "script": {
      "script": """
        doc['total'].value > 10
      """
    }
  }
}
`;

describe('parseConsole', () => {
  const parse = parseConsole(BUFFER);
  const [cat, create, bulk, search] = parse.requests;

  it('finds every request with its method, path and query', () => {
    expect(parse.issues).toEqual([]);
    expect(parse.requests.map((r) => [r.method, r.path, r.query, r.bodyKind])).toEqual([
      ['GET', '/_cat/indices', 'v&s=index', 'none'],
      ['PUT', '/orders', '', 'json'],
      ['POST', '/orders/_bulk', 'refresh=true', 'ndjson'],
      ['GET', '/orders/_search', '', 'json'],
    ]);
    expect(cat!.line).toBe(1);
    expect(search!.line).toBe(18);
  });

  it('drops comments and keeps the body text otherwise as typed', () => {
    expect(create!.body).not.toContain('cents');
    expect(JSON.parse(create!.body!)).toEqual({
      settings: { number_of_replicas: 0 },
      mappings: { properties: { total: { type: 'scaled_float', scaling_factor: 100 } } },
    });
  });

  it('sends NDJSON one value per line, numbers exactly as typed', () => {
    expect(bulk!.body).toBe(
      [
        '{ "index": { "_id": "1" } }',
        '{ "total": 12.50, "id": 12345678901234567890 }',
        '{ "delete": { "_id": "2" } }',
        '',
      ].join('\n'),
    );
  });

  it('turns triple-quoted strings into JSON strings', () => {
    const body = JSON.parse(search!.body!) as { query: { script: { script: string } } };
    expect(body.query.script.script).toBe("\n        doc['total'].value > 10\n      ");
  });

  it('keeps each request range in the buffer', () => {
    for (const request of parse.requests) {
      expect(BUFFER.slice(request.start, request.urlEnd)).toMatch(/^(GET|PUT|POST|get) /);
      expect(requestAt(parse.requests, request.start)).toBe(request);
      expect(requestAt(parse.requests, request.end)).toBe(request);
    }
    expect(BUFFER.slice(create!.start, create!.end).trimEnd().endsWith('}')).toBe(true);
    expect(requestAt(parse.requests, 0)).toBeUndefined();
    // A blank line after a request belongs to it.
    expect(requestAt(parse.requests, cat!.end + 1)).toBe(cat);
    expect(requestsIn(parse.requests, create!.start, bulk!.start + 2)).toEqual([create, bulk]);
  });

  it('maps a server error position back into the buffer', () => {
    // Line 5, column 60 of the body: the value of scaling_factor.
    const offset = bodyErrorOffset(create!, 5, 60);
    expect(offset).toBeDefined();
    expect(BUFFER.slice(offset!, offset! + 3)).toBe('100');
  });

  it('formats a request back to console text', () => {
    expect(formatConsoleRequest(cat!)).toBe('GET /_cat/indices?v&s=index');
    expect(formatConsoleRequest(bulk!).split('\n')).toHaveLength(4);
  });
});

describe('parseConsole issues', () => {
  it('reports an unclosed body and recovers at the next request', () => {
    const text = 'POST /a/_search\n{ "query": { "match_all": {} }\n\nGET /b/_count\n';
    const parse = parseConsole(text);
    expect(parse.requests.map((r) => [r.method, r.path, r.invalid])).toEqual([
      ['POST', '/a/_search', true],
      ['GET', '/b/_count', false],
    ]);
    const issues = issuesOf(parse, parse.requests[0]!);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.message).toContain('Missing "}"');
    expect(issues[0]!.start).toBe(text.indexOf('{'));
  });

  it('reports invalid JSON inside a body at its position', () => {
    const text = 'POST /a/_search\n{\n  "size": 10,\n  "from": ,\n}\n';
    const parse = parseConsole(text);
    expect(parse.requests[0]!.invalid).toBe(true);
    expect(parse.issues[0]!.start).toBe(text.indexOf(': ,') + 2);
  });

  it('reports text that is neither a request nor a body', () => {
    const parse = parseConsole('hello world\nGET /\n');
    expect(parse.requests).toHaveLength(1);
    expect(parse.issues[0]!.message).toContain('Expected a request');
  });

  it('reports a missing path and an unterminated triple-quoted string', () => {
    const pathless = parseConsole('GET  \n');
    expect(pathless.requests[0]!.invalid).toBe(true);
    expect(pathless.issues[0]!.message).toContain('needs a path');
    const triple = parseConsole('POST /x/_search\n{ "a": """oops }\n');
    expect(triple.requests[0]!.invalid).toBe(true);
    expect(triple.issues[0]!.message).toContain('triple-quoted');
  });

  it('ignores a trailing comment on the request line', () => {
    const parse = parseConsole('GET /_search?q=a   # everything\n');
    expect(parse.requests[0]).toMatchObject({ path: '/_search', query: 'q=a' });
  });

  it('treats several values as NDJSON even on other endpoints', () => {
    const parse = parseConsole('POST /_msearch\n{}\n{"query":{"match_all":{}}}\n');
    expect(parse.requests[0]!.body).toBe('{}\n{"query":{"match_all":{}}}\n');
    const multi = parseConsole('POST /_bulk\n{"index":{"_index":"a"}}\n{\n  "x": 1\n}\n');
    expect(multi.requests[0]!.body).toBe('{"index":{"_index":"a"}}\n{"x":1}\n');
  });
});

describe('splitUrl', () => {
  it('adds the leading slash and splits the query', () => {
    expect(splitUrl('orders/_search?size=1')).toEqual({ path: '/orders/_search', query: 'size=1' });
    expect(splitUrl('/')).toEqual({ path: '/', query: '' });
  });
});
