import { describe, expect, it } from 'vitest';

import {
  HttpTransportError,
  mapResponseError,
  mapTransportError,
  type SearchNodeTarget,
} from '../src';

const context = {
  where: 'https://es:9200',
  secrets: ['s3cret-pass'],
  authMethod: 'basic' as const,
  user: 'elastic',
};

function body(type: string, reason: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    error: { root_cause: [{ type, reason }], type, reason, ...extra },
    status: 400,
  });
}

describe('mapResponseError', () => {
  it('maps authentication, privileges and blocks', () => {
    expect(
      mapResponseError(
        401,
        body('security_exception', 'unable to authenticate user [elastic]'),
        context,
      ),
    ).toMatchObject({
      code: 'AUTH_FAILED',
      message: 'Authentication failed at https://es:9200 for elastic',
      hint: 'Check the user name and password',
    });
    expect(
      mapResponseError(401, body('security_exception', 'x'), { ...context, authMethod: 'apiKey' })
        .hint,
    ).toContain('API key');
    expect(
      mapResponseError(
        403,
        body(
          'security_exception',
          'action [indices:data/read/search] is unauthorized for user [app]',
        ),
        context,
      ),
    ).toMatchObject({
      code: 'SQL_ERROR',
      engineCode: 'security_exception',
      hint: expect.stringContaining('privilege'),
    });
    const flood = mapResponseError(
      429,
      body(
        'cluster_block_exception',
        'index [logs] blocked by: [TOO_MANY_REQUESTS/12/disk usage exceeded flood-stage watermark, index has read-only-allow-delete block];',
      ),
      context,
    );
    expect(flood).toMatchObject({
      code: 'READ_ONLY',
      hint: expect.stringContaining('flood-stage'),
    });
    expect(
      mapResponseError(
        403,
        body('cluster_block_exception', 'index [a] blocked by: [FORBIDDEN/8/index write (api)];'),
        context,
      ),
    ).toMatchObject({ code: 'READ_ONLY', hint: expect.stringContaining('index.blocks.write') });
  });

  it('maps missing indices, conflicts, overload and timeouts', () => {
    expect(
      mapResponseError(404, body('index_not_found_exception', 'no such index [x]'), context),
    ).toMatchObject({
      code: 'NOT_FOUND',
      message: 'no such index [x]',
    });
    expect(
      mapResponseError(
        409,
        body('version_conflict_engine_exception', '[1]: version conflict'),
        context,
      ).code,
    ).toBe('CONFLICT');
    expect(
      mapResponseError(429, body('circuit_breaking_exception', '[parent] Data too large'), context),
    ).toMatchObject({ code: 'SQL_ERROR', hint: expect.stringContaining('circuit breaker') });
    expect(
      mapResponseError(429, body('es_rejected_execution_exception', 'rejected'), context).hint,
    ).toContain('overloaded');
    expect(mapResponseError(504, '', context)).toMatchObject({
      code: 'TIMEOUT',
      message: 'HTTP 504',
    });
    expect(
      mapResponseError(503, body('master_not_discovered_exception', 'none'), context).code,
    ).toBe('CONNECTION_FAILED');
    expect(
      mapResponseError(
        400,
        body('resource_already_exists_exception', 'index [a/x] already exists'),
        context,
      ).code,
    ).toBe('VALIDATION_FAILED');
  });

  it('turns a syntax error position into an offset of the body sent', () => {
    const sent = '{\n  "query": {\n    "match_al": {}\n  }\n}';
    const error = mapResponseError(
      400,
      body('parsing_exception', 'unknown query [match_al]', { line: 3, col: 17 }),
      { ...context, requestBody: sent },
    );
    expect(error).toMatchObject({ code: 'SQL_ERROR', engineCode: 'parsing_exception' });
    expect(sent.slice(error.position!)).toMatch(/^\{\}/);
  });

  it('explains missing endpoints and never leaks secrets', () => {
    expect(
      mapResponseError(
        400,
        '{"error":"no handler found for uri [/_plugins/_sql] and method [POST]"}',
        context,
      ),
    ).toMatchObject({ code: 'NOT_SUPPORTED', hint: expect.stringContaining('plugins') });
    const leaky = mapResponseError(
      400,
      body('illegal_argument_exception', 'bad value s3cret-pass'),
      context,
    );
    expect(JSON.stringify(leaky.toJSON())).not.toContain('s3cret-pass');
  });
});

describe('mapTransportError', () => {
  const node: SearchNodeTarget = {
    protocol: 'https:',
    host: 'es',
    port: 9200,
    hostHeader: 'es:9200',
    pathPrefix: '',
    label: 'https://es:9200',
  };

  it('maps network failures, timeouts and cancellation', () => {
    const refused = new HttpTransportError('connect ECONNREFUSED', 'ECONNREFUSED', node, true, {
      cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
    });
    expect(mapTransportError(refused, context)).toMatchObject({
      code: 'CONNECTION_FAILED',
      message: 'Connection to https://es:9200 was refused',
    });
    expect(
      mapTransportError(
        new HttpTransportError('No answer', 'REQUEST_TIMEOUT', node, false),
        context,
      ).code,
    ).toBe('TIMEOUT');
    expect(
      mapTransportError(new HttpTransportError('slow', 'CONNECT_TIMEOUT', node, true), context)
        .hint,
    ).toContain('connect timeout');
    const abort = Object.assign(new Error('Cancelled'), { name: 'AbortError' });
    expect(mapTransportError(abort, context).code).toBe('CANCELLED');
    expect(
      mapTransportError(new Error('anything'), { ...context, cancelRequested: true }).code,
    ).toBe('CANCELLED');
    const tls = new HttpTransportError('self-signed', 'DEPTH_ZERO_SELF_SIGNED_CERT', node, false, {
      cause: Object.assign(new Error('self-signed certificate'), {
        code: 'DEPTH_ZERO_SELF_SIGNED_CERT',
      }),
    });
    expect(mapTransportError(tls, context)).toMatchObject({
      code: 'TLS_FAILED',
      hint: expect.stringContaining('CA'),
    });
    const plain = new HttpTransportError(
      'Parse Error: Expected HTTP/',
      'HPE_INVALID_CONSTANT',
      node,
      false,
    );
    expect(mapTransportError(plain, context).hint).toContain('http://');
  });
});
