import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { gzipSync } from 'node:zlib';

import { afterEach, describe, expect, it } from 'vitest';

import {
  HttpTransportError,
  SearchHttpClient,
  encodeUrlPart,
  type SearchClientPlan,
  type SearchNodeTarget,
} from '../src';

/** The HTTP client on local servers: failover, retries, encodings, limits and cancellation. */

interface Seen {
  readonly method: string;
  readonly url: string;
  readonly headers: IncomingMessage['headers'];
  readonly body: string;
}

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (s) =>
        new Promise<void>((resolve) => {
          s.closeAllConnections();
          s.close(() => resolve());
        }),
    ),
  );
});

async function serve(
  handler: (req: IncomingMessage, res: ServerResponse, body: string) => void,
): Promise<{ port: number; seen: Seen[] }> {
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => (body += chunk));
    req.on('end', () => {
      seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body });
      handler(req, res, body);
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { port: (server.address() as { port: number }).port, seen };
}

async function refusedPort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

function node(port: number, extra: Partial<SearchNodeTarget> = {}): SearchNodeTarget {
  return {
    protocol: 'http:',
    host: '127.0.0.1',
    port,
    hostHeader: `127.0.0.1:${port}`,
    pathPrefix: '',
    label: `http://127.0.0.1:${port}`,
    ...extra,
  };
}

function plan(nodes: SearchNodeTarget[], extra: Partial<SearchClientPlan> = {}): SearchClientPlan {
  return {
    engine: 'elasticsearch',
    nodes,
    authMethod: 'basic',
    authorization: 'Basic dTpw',
    connectTimeoutMs: 2_000,
    keepAlive: true,
    sniff: false,
    applicationName: 'Joinery test',
    where: nodes.map((n) => n.label).join(', '),
    tunnelled: false,
    cloud: false,
    secrets: [],
    ...extra,
  };
}

const json = (res: ServerResponse, status: number, body: string): void => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(body);
};

describe('SearchHttpClient', () => {
  it('sends the headers, the Host of the node, its path prefix and an encoded path', async () => {
    const { port, seen } = await serve((_req, res) => json(res, 200, '{"ok":true}'));
    const client = new SearchHttpClient(
      plan([node(port, { hostHeader: 'es.internal:9200', pathPrefix: '/es' })]),
    );
    try {
      const response = await client.request({
        method: 'POST',
        path: '/my index/_search',
        query: 'q=a b&size=1',
        body: '{"size": 1}',
        opaqueId: 'op-1',
      });
      expect(response).toMatchObject({ status: 200, body: '{"ok":true}', truncated: false });
      expect(seen[0]).toMatchObject({
        method: 'POST',
        url: '/es/my%20index/_search?q=a%20b&size=1',
        body: '{"size": 1}',
      });
      expect(seen[0]!.headers).toMatchObject({
        host: 'es.internal:9200',
        authorization: 'Basic dTpw',
        'content-type': 'application/json',
        'x-opaque-id': 'op-1',
        'user-agent': 'Joinery (Joinery test)',
      });
    } finally {
      client.close();
    }
  });

  it('moves to the next node when one refuses, and sets it aside', async () => {
    const dead = await refusedPort();
    const { port, seen } = await serve((_req, res) => json(res, 200, '{}'));
    let now = 0;
    const client = new SearchHttpClient(plan([node(dead), node(port)]), () => now);
    try {
      for (let i = 0; i < 4; i++) {
        expect((await client.request({ method: 'POST', path: '/x/_doc', body: '{}' })).status).toBe(
          200,
        );
      }
      expect(seen).toHaveLength(4);
      now = 120_000;
      await client.request({ method: 'GET', path: '/' });
    } finally {
      client.close();
    }
  });

  it('retries a read on another node after a 503, but not a write', async () => {
    const busy = await serve((_req, res) => json(res, 503, '{"error":"busy"}'));
    const fine = await serve((_req, res) => json(res, 200, '{}'));
    const client = new SearchHttpClient(plan([node(busy.port), node(fine.port)]));
    try {
      const reads = await Promise.all(
        [0, 1].map(() => client.request({ method: 'GET', path: '/' })),
      );
      expect(reads.map((r) => r.status)).toEqual([200, 200]);
      const writes = await Promise.all(
        [0, 1].map(() => client.request({ method: 'PUT', path: '/i', body: '{}' })),
      );
      expect(writes.map((r) => r.status).sort()).toEqual([200, 503]);
    } finally {
      client.close();
    }
  });

  it('fails with an unsent transport error when no node answers', async () => {
    const client = new SearchHttpClient(plan([node(await refusedPort())]));
    try {
      await expect(client.request({ method: 'GET', path: '/' })).rejects.toMatchObject({
        name: 'HttpTransportError',
        code: 'ECONNREFUSED',
        unsent: true,
      });
    } finally {
      client.close();
    }
  });

  it('decodes gzip and cuts bodies past the limit', async () => {
    const big = JSON.stringify({ text: 'é'.repeat(5_000) });
    const { port } = await serve((req, res) => {
      if (req.url === '/gzip') {
        res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip' });
        res.end(gzipSync(big));
      } else json(res, 200, big);
    });
    const client = new SearchHttpClient(plan([node(port)]));
    try {
      expect((await client.request({ method: 'GET', path: '/gzip' })).body).toBe(big);
      const cut = await client.request({ method: 'GET', path: '/plain', maxBytes: 100 });
      expect(cut.truncated).toBe(true);
      expect(Buffer.byteLength(cut.body.replace(/�$/, ''))).toBeLessThanOrEqual(100);
    } finally {
      client.close();
    }
  });

  it('times out and cancels a request in flight', async () => {
    const { port } = await serve(() => undefined);
    const client = new SearchHttpClient(plan([node(port)], { requestTimeoutMs: 200 }));
    try {
      await expect(client.request({ method: 'GET', path: '/slow' })).rejects.toMatchObject({
        code: 'REQUEST_TIMEOUT',
      });
      const controller = new AbortController();
      const pending = client.request({
        method: 'GET',
        path: '/slow',
        signal: controller.signal,
        timeoutMs: 10_000,
      });
      const aborted = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
      controller.abort();
      await aborted;
      const already = new AbortController();
      already.abort();
      await expect(
        client.request({ method: 'GET', path: '/', signal: already.signal }),
      ).rejects.toMatchObject({
        name: 'AbortError',
      });
    } finally {
      client.close();
    }
  });

  it('refuses requests after close', async () => {
    const client = new SearchHttpClient(plan([node(1)]));
    client.close();
    await expect(client.request({ method: 'GET', path: '/' })).rejects.toMatchObject({
      code: 'CONNECTION_FAILED',
    });
    expect(new HttpTransportError('x', 'Y', node(1), false)).toBeInstanceOf(Error);
  });
});

describe('encodeUrlPart', () => {
  it('encodes what may not stand in a URL and keeps what is already encoded', () => {
    expect(encodeUrlPart('/logs-*/_doc/a b/é')).toBe('/logs-*/_doc/a%20b/%C3%A9');
    expect(encodeUrlPart('/a%2Fb/100%')).toBe('/a%2Fb/100%25');
    expect(encodeUrlPart('q=x:1 AND y&size=5', true)).toBe('q=x:1%20AND%20y&size=5');
  });
});
