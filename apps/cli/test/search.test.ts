import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { createSearchAdapter } from '@querybara/driver-elasticsearch';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { Reporter } from '../src/reporter';
import {
  planSearchRequests,
  prettyBody,
  responseJson,
  statusLine,
  type PlannedSearchRequest,
} from '../src/search';
import { StoreHandle } from '../src/store';
import { describeEndpoint, resolveTarget, resolvedProfile } from '../src/target';
import { MemoryStream, ScriptedPrompter, run, tempDir } from './helpers';

/**
 * Elasticsearch in querybara-cli: console text into requests, response output,
 * http(s):// URL targets, and `query` / `test` end to end through the real adapter against a
 * small in-process HTTP server that answers like Elasticsearch.
 */

describe('console requests in querybara query', () => {
  it('reads requests with bodies, labels and write safety', () => {
    const planned = planSearchRequests(
      'GET _cluster/health\n\nPUT /orders?timeout=5s\n{"settings": {"number_of_replicas": 0}}\n\nDELETE /orders\n\nPOST /orders/_bulk\n{"index":{}}\n{"n":1}\n',
    );
    expect(planned.map((p) => [p.label, p.line, p.safety.writes, p.safety.destructive])).toEqual([
      ['GET /_cluster/health', 1, false, undefined],
      ['PUT /orders', 3, true, undefined],
      ['DELETE /orders', 6, true, 'deletes the index and all its documents'],
      ['POST /orders/_bulk', 8, true, undefined],
    ]);
    expect(planned[1]!.request).toEqual({
      method: 'PUT',
      path: '/orders',
      query: 'timeout=5s',
      body: '{"settings": {"number_of_replicas": 0}}',
      bodyKind: 'json',
    });
    expect(planned[3]!.request).toMatchObject({
      bodyKind: 'ndjson',
      body: '{"index":{}}\n{"n":1}\n',
    });
  });

  it('refuses text it cannot read, naming the line and column', () => {
    expect(() => planSearchRequests('GET /\n\nPOST /x/_search\n{"query": }\n')).toThrow(/^4:/);
  });

  it('prints bodies with numbers exactly as the server sent them', () => {
    const body = '{"n":1234567890123456789,"f":1.10,"s":"\\u00e9"}';
    expect(prettyBody({ body, contentType: 'application/json' })).toBe(
      '{\n  "n": 1234567890123456789,\n  "f": 1.10,\n  "s": "\\u00e9"\n}',
    );
    expect(prettyBody({ body: 'green open orders\n', contentType: 'text/plain' })).toBe(
      'green open orders',
    );
    const planned = { label: 'GET /x' } as PlannedSearchRequest;
    const response = { status: 200, contentType: 'application/json', body, durationMs: 1 };
    expect(responseJson(planned, { ...response, warnings: [], truncated: false })).toBe(
      `{"request":"GET /x","status":200,"body":${body}}`,
    );
    expect(
      responseJson(planned, { ...response, body: '', warnings: [], truncated: false }),
    ).toContain('"body":null');
    expect(statusLine(404)).toBe('404 Not Found');
  });
});

describe('http(s):// URL targets', () => {
  let cleanup: () => void;
  let store: StoreHandle;
  beforeEach(() => {
    const temp = tempDir();
    cleanup = temp.cleanup;
    store = new StoreHandle({ path: `${temp.dir}/querybara.db`, source: '--store' }, {});
    return () => {
      store.close();
      cleanup();
    };
  });
  const deps = (env: Record<string, string> = {}) => ({
    store,
    env,
    prompter: new ScriptedPrompter(false),
    reporter: new Reporter(new MemoryStream(), { verbose: true }),
  });

  it('reads an Elasticsearch URL', async () => {
    const target = await resolveTarget('https://elastic:s3cret@es.example.com:9243', {}, deps());
    expect(target.profile).toMatchObject({
      engine: 'elasticsearch',
      endpoint: { kind: 'urls', urls: ['https://es.example.com:9243'] },
      auth: { method: 'password', user: 'elastic' },
      tls: { mode: 'verify-full' },
    });
    expect(target.label).toBe('Elasticsearch es.example.com:9243');
    expect(target.passwordKnown).toBe(true);
    expect(JSON.stringify(target)).not.toContain('s3cret');
    expect(describeEndpoint(target.profile)).toBe('https://es.example.com:9243');

    const plain = await resolveTarget('http://127.0.0.1:9201', {}, deps());
    expect(plain.profile).toMatchObject({ engine: 'elasticsearch', tls: { mode: 'disable' } });
    expect(plain.label).toBe('Elasticsearch 127.0.0.1:9201');
  });

  it('logs in with QUERYBARA_API_KEY when the URL has no user', async () => {
    const target = await resolveTarget(
      'https://es.example.com',
      {},
      deps({ QUERYBARA_API_KEY: 'a2V5OnNlY3JldA==' }),
    );
    const resolved = resolvedProfile(target);
    expect(resolved.profile.auth).toMatchObject({ method: 'apiKey' });
    expect(Object.values(resolved.secrets)).toEqual(['a2V5OnNlY3JldA==']);
    expect(JSON.stringify(target)).not.toContain('a2V5OnNlY3JldA==');
  });
});

// ---------------------------------------------------------------------------------------------
// End to end through the real adapter

const ROOT = JSON.stringify({
  name: 'node-1',
  cluster_name: 'fake-cluster',
  version: { number: '9.4.0', build_flavor: 'default' },
  tagline: 'You Know, for Search',
});

let server: Server;
let url = '';
const received: string[] = [];

function reply(res: ServerResponse, status: number, body: string, type = 'application/json') {
  res.writeHead(status, { 'content-type': type, 'x-elastic-product': 'Elasticsearch' });
  res.end(body);
}

function route(req: IncomingMessage, res: ServerResponse, body: string): void {
  const key = `${req.method} ${req.url}`;
  if (req.url !== '/' && !req.url!.startsWith('/_cat/plugins')) {
    received.push(body ? `${key} ${body}` : key);
  }
  if (key === 'GET /') return reply(res, 200, ROOT);
  if (key.startsWith('GET /_cat/plugins')) return reply(res, 200, '[]');
  if (key === 'GET /_cluster/health') {
    return reply(res, 200, '{"cluster_name":"fake-cluster","status":"green","number_of_nodes":1}');
  }
  if (key === 'GET /orders/_doc/1') {
    return reply(res, 200, '{"_id":"1","found":true,"_source":{"n":1234567890123456789}}');
  }
  if (key === 'PUT /orders' || key === 'DELETE /orders') {
    return reply(res, 200, '{"acknowledged":true}');
  }
  if (key === 'GET /_cat/indices') return reply(res, 200, 'green open orders\n', 'text/plain');
  reply(
    res,
    404,
    '{"error":{"root_cause":[],"type":"index_not_found_exception","reason":"no such index [missing]"},"status":404}',
  );
}

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => route(req, res, Buffer.concat(chunks).toString('utf8')));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  received.length = 0;
});

const cli = (argv: string[], prompter = new ScriptedPrompter(false)) =>
  run(argv, { adapter: createSearchAdapter(), prompter });

describe('querybara query and test on Elasticsearch', () => {
  it('prints each response body, with the status on stderr', async () => {
    const result = await cli(['query', url, '-e', 'GET _cluster/health\n\nGET /orders/_doc/1']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('"status": "green"');
    expect(result.stdout).toContain('"n": 1234567890123456789');
    expect(result.stderr).toContain('[1] GET /_cluster/health · 200 OK');
    expect(result.stderr).toContain('[2] GET /orders/_doc/1 · 200 OK');
  });

  it('prints JSON objects with --format json, and text bodies as strings', async () => {
    const result = await cli([
      'query',
      url,
      '--format',
      'json',
      '-e',
      'GET /orders/_doc/1\nGET _cat/indices',
    ]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(
      '"body":{"_id":"1","found":true,"_source":{"n":1234567890123456789}}',
    );
    const parsed = JSON.parse(result.stdout) as { request: string; body: unknown }[];
    expect(parsed.map((r) => r.request)).toEqual(['GET /orders/_doc/1', 'GET /_cat/indices']);
    expect(parsed[1]!.body).toBe('green open orders\n');
    expect((await cli(['query', url, '--format', 'csv', '-e', 'GET /'])).code).toBe(2);
  });

  it('fails a request with an error status and stops there', async () => {
    const result = await cli(['query', url, '-e', 'GET /missing/_search\n\nGET _cluster/health']);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('404 Not Found: index_not_found_exception: no such index');
    expect(received).toEqual(['GET /missing/_search']);
  });

  it('applies the write rules: read-only refuses, destructive requests ask or need --yes', async () => {
    const readOnly = await cli(['query', url, '--read-only', '-e', 'PUT /orders\n{}']);
    expect(readOnly.code).toBe(2);
    expect(readOnly.stderr).toContain('is read-only');

    const unconfirmed = await cli(['query', url, '-e', 'DELETE /orders']);
    expect(unconfirmed.code).toBe(2);
    expect(unconfirmed.stderr).toContain('needs confirmation: DELETE /orders deletes the index');

    const declined = new ScriptedPrompter(true, { confirm: ['no'] });
    expect((await cli(['query', url, '-e', 'DELETE /orders'], declined)).code).toBe(2);
    expect(declined.asked).toEqual(['Send it?']);
    expect(received).toEqual([]);

    const confirmed = await cli(['query', url, '--yes', '-e', 'PUT /orders\n{}\nDELETE /orders']);
    expect(confirmed.code).toBe(0);
    expect(received).toEqual(['PUT /orders {}', 'DELETE /orders']);
  });

  it('refuses unreadable console text before connecting', async () => {
    const result = await cli(['query', url, '-e', 'POST /x/_search\n{"query": }']);
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/2:\d+: /);
    expect(received).toEqual([]);
  });

  it('tests the connection step by step', async () => {
    const result = await cli(['test', url]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Elasticsearch at http://127.0.0.1');
    expect(result.stdout).toMatch(/✓ Version +Elasticsearch 9\.4\.0/);
    expect(result.stdout).toContain('Connection OK.');
  });
});
