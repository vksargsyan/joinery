import { Agent as HttpAgent, request as httpRequest, type IncomingMessage } from 'node:http';
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https';
import type { Socket } from 'node:net';
import type { TLSSocket } from 'node:tls';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';

import { QuerybaraError } from '@querybara/core';
import { errorProp } from '@querybara/driver-sql-base';

import type { SearchClientPlan, SearchNodeTarget } from './config';

/**
 * The HTTP client behind the Elasticsearch adapter (ADR 0010): Node's http and
 * https modules with one keep-alive agent per node, so TLS is exactly what buildTlsSettings
 * configures (pinned host names through a tunnel included) and every body stays text.
 *
 * Requests go round-robin over the live nodes. A node that cannot be reached is set aside with
 * a growing back-off and the request moves to the next one; a reset connection or a 502/503/504
 * moves on only for reads, where repeating is safe. Timeouts, TLS failures and HTTP errors are
 * the caller's to handle.
 */

export interface HttpRequest {
  readonly method: string;
  /** The path with a leading slash, as the caller wrote it; encoded here where needed. */
  readonly path: string;
  /** The query string without "?". */
  readonly query?: string;
  readonly body?: string;
  /** Defaults to application/json when there is a body. */
  readonly contentType?: string;
  readonly signal?: AbortSignal;
  /** Overrides the plan's request timeout for this request. */
  readonly timeoutMs?: number;
  /** Bytes of (decoded) body to keep; longer bodies are cut and flagged. Default 256 MiB. */
  readonly maxBytes?: number;
  /** Sent as X-Opaque-Id, so the server's task for this request can be found and cancelled. */
  readonly opaqueId?: string;
}

export interface HttpResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly body: string;
  readonly truncated: boolean;
  readonly durationMs: number;
  /** The node that answered. */
  readonly node: SearchNodeTarget;
}

/** Why a request failed before a response arrived. */
export class HttpTransportError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly node: SearchNodeTarget,
    /** The request never reached the server, so another node may take it. */
    readonly unsent: boolean,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'HttpTransportError';
  }
}

export const DEFAULT_MAX_BYTES = 256 * 1024 * 1024;

const UNSENT_CODES = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EHOSTDOWN',
  'ENETDOWN',
  'CONNECT_TIMEOUT',
]);
const RETRY_STATUSES = new Set([502, 503, 504]);

/** Percent-encodes what a path or query may not hold as typed (spaces, non-ASCII...). */
export function encodeUrlPart(text: string, query = false): string {
  const allowed = query ? /[A-Za-z0-9\-._~!$&'()*+,;=:@/?]/ : /[A-Za-z0-9\-._~!$&'()*+,;=:@/]/;
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (char === '%' && /^[0-9A-Fa-f]{2}$/.test(text.slice(i + 1, i + 3))) {
      out += char;
    } else if (allowed.test(char)) {
      out += char;
    } else {
      const code = text.codePointAt(i)!;
      const symbol = String.fromCodePoint(code);
      if (symbol.length === 2) i++;
      out += encodeURIComponent(symbol);
    }
  }
  return out;
}

interface NodeState {
  readonly target: SearchNodeTarget;
  readonly agent: HttpAgent;
  failures: number;
  deadUntil: number;
}

function abortError(): Error {
  const error = new Error('Cancelled');
  error.name = 'AbortError';
  return error;
}

export class SearchHttpClient {
  #nodes: NodeState[];
  #next = 0;
  #closed = false;

  constructor(
    readonly plan: SearchClientPlan,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.#nodes = plan.nodes.map((target) => this.#state(target));
  }

  /** The nodes requests go to (after sniffing, the discovered ones). */
  get nodes(): readonly SearchNodeTarget[] {
    return this.#nodes.map((n) => n.target);
  }

  #state(target: SearchNodeTarget): NodeState {
    const options = { keepAlive: this.plan.keepAlive, maxSockets: 32, keepAliveMsecs: 1_000 };
    const agent =
      target.protocol === 'https:'
        ? new HttpsAgent({ ...options, ...target.tls })
        : new HttpAgent(options);
    return { target, agent, failures: 0, deadUntil: 0 };
  }

  /** Replaces the node list (sniffing), keeping the agents of nodes that stay. */
  replaceNodes(targets: readonly SearchNodeTarget[]): void {
    if (targets.length === 0) return;
    const kept = new Map(this.#nodes.map((n) => [n.target.label, n]));
    const next = targets.map((t) => kept.get(t.label) ?? this.#state(t));
    for (const node of this.#nodes) if (!next.includes(node)) node.agent.destroy();
    this.#nodes = next;
    this.#next = 0;
  }

  /** The node order for one request: live nodes round-robin, then the soonest to recover. */
  #order(): NodeState[] {
    const now = this.now();
    const start = this.#next++ % this.#nodes.length;
    const rotated = [...this.#nodes.slice(start), ...this.#nodes.slice(0, start)];
    const live = rotated.filter((n) => n.deadUntil <= now);
    const dead = rotated.filter((n) => n.deadUntil > now).sort((a, b) => a.deadUntil - b.deadUntil);
    return [...live, ...dead];
  }

  /** Sends a request with failover (see the class comment). */
  async request(req: HttpRequest): Promise<HttpResponse> {
    if (this.#closed) {
      throw new QuerybaraError({ code: 'CONNECTION_FAILED', message: 'The session is closed' });
    }
    const idempotent = req.method === 'GET' || req.method === 'HEAD';
    const order = this.#order();
    let last: unknown;
    for (let i = 0; i < order.length; i++) {
      const node = order[i]!;
      const more = i < order.length - 1;
      try {
        const response = await this.#send(node.target, req);
        if (more && idempotent && RETRY_STATUSES.has(response.status)) {
          last = response;
          continue;
        }
        node.failures = 0;
        node.deadUntil = 0;
        return response;
      } catch (error) {
        last = error;
        if (!(error instanceof HttpTransportError)) throw error;
        const retry = error.unsent || (idempotent && error.code === 'ECONNRESET');
        if (error.unsent) {
          node.failures += 1;
          node.deadUntil = this.now() + Math.min(60_000, 1_000 * 2 ** (node.failures - 1));
        }
        if (!retry || !more || req.signal?.aborted) throw error;
      }
    }
    if (last && typeof last === 'object' && 'status' in last) return last as HttpResponse;
    throw last;
  }

  #send(node: SearchNodeTarget, req: HttpRequest): Promise<HttpResponse> {
    return new Promise((resolve, reject) => {
      if (req.signal?.aborted) {
        reject(abortError());
        return;
      }
      const started = performance.now();
      const path = `${node.pathPrefix}${encodeUrlPart(req.path)}`;
      const query = req.query ? `?${encodeUrlPart(req.query, true)}` : '';
      const headers: Record<string, string> = {
        Host: node.hostHeader,
        Accept: 'application/json, text/plain',
        'Accept-Encoding': 'gzip, deflate, br',
        'User-Agent': `Querybara (${this.plan.applicationName})`,
      };
      if (this.plan.authorization !== undefined) headers['Authorization'] = this.plan.authorization;
      if (req.opaqueId !== undefined) headers['X-Opaque-Id'] = req.opaqueId;
      let payload: Buffer | undefined;
      if (req.body !== undefined) {
        payload = Buffer.from(req.body, 'utf8');
        headers['Content-Type'] = req.contentType ?? 'application/json';
        headers['Content-Length'] = String(payload.length);
      }
      const send = node.protocol === 'https:' ? httpsRequest : httpRequest;
      const agent = this.#nodes.find((n) => n.target === node)?.agent;
      let settled = false;
      let responded = false;
      const timers: ReturnType<typeof setTimeout>[] = [];
      const finish = (): void => {
        settled = true;
        for (const timer of timers) clearTimeout(timer);
        req.signal?.removeEventListener('abort', onAbort);
      };
      const fail = (error: Error): void => {
        if (settled) return;
        finish();
        reject(error);
      };
      const request = send({
        host: node.host,
        port: node.port,
        method: req.method,
        path: `${path}${query}`,
        headers,
        agent,
      });
      const onAbort = (): void => {
        request.destroy(abortError());
      };
      req.signal?.addEventListener('abort', onAbort, { once: true });
      const timeoutMs = req.timeoutMs ?? this.plan.requestTimeoutMs;
      if (timeoutMs !== undefined) {
        timers.push(
          setTimeout(() => {
            request.destroy(
              new HttpTransportError(
                `No answer from ${node.label} within ${timeoutMs} ms`,
                'REQUEST_TIMEOUT',
                node,
                false,
              ),
            );
          }, timeoutMs),
        );
      }
      request.once('socket', (socket: Socket) => {
        // Only a new connection has to connect; a kept-alive one is already open.
        if (!socket.connecting) return;
        const event = node.protocol === 'https:' ? 'secureConnect' : 'connect';
        const timer = setTimeout(() => {
          request.destroy(
            new HttpTransportError(
              `Timed out connecting to ${node.label}`,
              'CONNECT_TIMEOUT',
              node,
              true,
            ),
          );
        }, this.plan.connectTimeoutMs);
        timers.push(timer);
        (socket as TLSSocket).once(event, () => clearTimeout(timer));
      });
      request.on('error', (error: Error) => {
        if (error instanceof HttpTransportError || error.name === 'AbortError') {
          fail(error);
          return;
        }
        const code = errorProp(error, 'code') ?? 'ERROR';
        fail(
          new HttpTransportError(error.message, code, node, !responded && UNSENT_CODES.has(code), {
            cause: error,
          }),
        );
      });
      request.on('response', (response: IncomingMessage) => {
        responded = true;
        this.#read(response, req, node, started).then(
          (result) => {
            if (settled) return;
            finish();
            resolve(result);
          },
          (error: Error) => fail(error),
        );
      });
      request.end(payload);
    });
  }

  async #read(
    response: IncomingMessage,
    req: HttpRequest,
    node: SearchNodeTarget,
    started: number,
  ): Promise<HttpResponse> {
    const limit = req.maxBytes ?? DEFAULT_MAX_BYTES;
    const encoding = String(response.headers['content-encoding'] ?? '').toLowerCase();
    const decoder =
      encoding === 'gzip'
        ? createGunzip()
        : encoding === 'deflate'
          ? createInflate()
          : encoding === 'br'
            ? createBrotliDecompress()
            : undefined;
    const source: AsyncIterable<Buffer> = decoder ? response.pipe(decoder) : response;
    const chunks: Buffer[] = [];
    let length = 0;
    let truncated = false;
    try {
      for await (const chunk of source) {
        const room = limit - length;
        if (chunk.length > room) {
          if (room > 0) chunks.push(chunk.subarray(0, room));
          length = limit;
          truncated = true;
          break;
        }
        chunks.push(chunk);
        length += chunk.length;
      }
    } catch (error) {
      const code = errorProp(error, 'code') ?? 'ECONNRESET';
      throw new HttpTransportError(
        `The answer from ${node.label} broke off: ${error instanceof Error ? error.message : String(error)}`,
        code,
        node,
        false,
        { cause: error },
      );
    } finally {
      if (truncated) {
        response.destroy();
        decoder?.destroy();
      }
    }
    // A cut body can end inside a multi-byte character; the decoder then adds U+FFFD.
    const body = Buffer.concat(chunks, length).toString('utf8');
    return {
      status: response.statusCode ?? 0,
      headers: response.headers,
      body,
      truncated,
      durationMs: Math.round(performance.now() - started),
      node,
    };
  }

  /** Closes every connection. Requests in flight fail. */
  close(): void {
    this.#closed = true;
    for (const node of this.#nodes) node.agent.destroy();
  }
}

/** Warning header values without the "299 Elasticsearch-9.4.0 " prefix and quotes. */
export function warningsOf(headers: HttpResponse['headers']): string[] {
  const raw = headers['warning'];
  const values = raw === undefined ? [] : Array.isArray(raw) ? raw : [raw];
  return values.map((value) => {
    const match = /^\d{3} \S+ "((?:[^"\\]|\\.)*)"/.exec(value);
    return match ? match[1]!.replace(/\\(.)/g, '$1') : value;
  });
}

/** The media type of a response, e.g. "application/json". */
export function contentTypeOf(headers: HttpResponse['headers']): string {
  const value = headers['content-type'];
  const text = Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
  return text.split(';')[0]!.trim().toLowerCase();
}
