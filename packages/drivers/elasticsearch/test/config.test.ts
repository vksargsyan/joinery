import {
  connectionProfileSchema,
  type ConnectionProfileInput,
  type ResolvedProfile,
} from '@joinery/core';
import { describe, expect, it } from 'vitest';

import { buildSearchClientPlan, parseNodeUrl, redactSecrets } from '../src';

function resolved(
  input: Partial<ConnectionProfileInput> = {},
  secrets: Record<string, string> = {},
  endpointOverride?: { host: string; port: number },
): ResolvedProfile {
  const profile = connectionProfileSchema.parse({
    id: 'p',
    name: 'Search',
    engine: 'elasticsearch',
    endpoint: { kind: 'urls', urls: ['https://es1.example.com:9200'] },
    createdAt: '2026-09-29T10:00:00.000Z',
    updatedAt: '2026-09-29T10:00:00.000Z',
    ...input,
  });
  return { profile, secrets, ...(endpointOverride ? { endpointOverride } : {}) };
}

const noFiles = (path: string): Buffer => Buffer.from(`file:${path}`);

describe('parseNodeUrl', () => {
  it('reads scheme, host, port and path prefix, with the scheme default ports', () => {
    expect(parseNodeUrl('https://es.example.com:9243/es/', 'verify-full')).toEqual({
      protocol: 'https:',
      host: 'es.example.com',
      port: 9243,
      pathPrefix: '/es',
    });
    expect(parseNodeUrl('http://[::1]', 'verify-full')).toMatchObject({ host: '::1', port: 80 });
    expect(parseNodeUrl('https://es', 'disable')).toMatchObject({ port: 443 });
    expect(parseNodeUrl('elastic@es:9200', 'verify-full')).toMatchObject({
      protocol: 'https:',
      user: 'elastic',
    });
    expect(parseNodeUrl('localhost:9200', 'disable')).toMatchObject({ protocol: 'http:' });
  });

  it('refuses other schemes and passwords, never echoing the URL', () => {
    expect(() => parseNodeUrl('ftp://es', 'disable')).toThrow(
      expect.objectContaining({ code: 'VALIDATION_FAILED' }),
    );
    let error: unknown;
    try {
      parseNodeUrl('https://elastic:hunter22@es:9200', 'verify-full');
    } catch (e) {
      error = e;
    }
    expect(error).toMatchObject({
      code: 'VALIDATION_FAILED',
      message: 'A node URL holds a password',
    });
    expect(JSON.stringify(error)).not.toContain('hunter22');
  });
});

describe('buildSearchClientPlan', () => {
  it('sends basic credentials from the secrets and verifies each node by its own name', () => {
    const plan = buildSearchClientPlan(
      resolved(
        {
          endpoint: {
            kind: 'urls',
            urls: ['https://es1.example.com:9200', 'https://es2.example.com:9200'],
          },
          auth: { method: 'password', user: 'elastic', password: { id: 'pw' } },
        },
        { pw: 'changeme' },
      ),
      { readFile: noFiles },
    );
    expect(plan.authorization).toBe(`Basic ${Buffer.from('elastic:changeme').toString('base64')}`);
    expect(plan.nodes.map((n) => [n.label, n.hostHeader, n.tls?.servername])).toEqual([
      ['https://es1.example.com:9200', 'es1.example.com:9200', 'es1.example.com'],
      ['https://es2.example.com:9200', 'es2.example.com:9200', 'es2.example.com'],
    ]);
    expect(plan.nodes[0]!.tls?.rejectUnauthorized).toBe(true);
    expect(plan.secrets).toContain('changeme');
    expect(plan.where).toBe('https://es1.example.com:9200, https://es2.example.com:9200');
  });

  it('encodes an id:key API key and sends an encoded one as is; bearer tokens too', () => {
    const key = (value: string) =>
      buildSearchClientPlan(
        resolved({ auth: { method: 'apiKey', apiKey: { id: 'k' } } }, { k: value }),
      ).authorization;
    expect(key('VnVhQ2ZHY0JDZGJrUW0tZTVhT3g6dWkybHAyYXhUTm1zeWFrdzl0dk5udw==')).toBe(
      'ApiKey VnVhQ2ZHY0JDZGJrUW0tZTVhT3g6dWkybHAyYXhUTm1zeWFrdzl0dk5udw==',
    );
    expect(key('id1:secret')).toBe(`ApiKey ${Buffer.from('id1:secret').toString('base64')}`);
    const bearer = buildSearchClientPlan(
      resolved({ auth: { method: 'bearer', token: { id: 't' } } }, { t: 'tok-123' }),
    );
    expect(bearer).toMatchObject({ authorization: 'Bearer tok-123', authMethod: 'bearer' });
    expect(() =>
      buildSearchClientPlan(resolved({ auth: { method: 'bearer', token: { id: 't' } } })),
    ).toThrow(expect.objectContaining({ code: 'AUTH_FAILED' }));
  });

  it('turns TLS on for https URLs whatever the mode, and leaves http alone', () => {
    const https = buildSearchClientPlan(resolved({ tls: { mode: 'disable' } }));
    expect(https.nodes[0]!.tlsSettings?.mode).toBe('verify-full');
    const http = buildSearchClientPlan(
      resolved({ endpoint: { kind: 'urls', urls: ['http://127.0.0.1:9200'] } }),
    );
    expect(http.nodes[0]).toEqual({
      protocol: 'http:',
      host: '127.0.0.1',
      port: 9200,
      hostHeader: '127.0.0.1:9200',
      pathPrefix: '',
      label: 'http://127.0.0.1:9200',
    });
    const loose = buildSearchClientPlan(resolved({ tls: { mode: 'require', caPath: '/ca.pem' } }), {
      readFile: noFiles,
    });
    expect(loose.nodes[0]!.tls).toMatchObject({
      rejectUnauthorized: false,
      ca: Buffer.from('file:/ca.pem'),
    });
  });

  it('reads a Cloud ID (Elasticsearch only) and never sniffs it', () => {
    const cloudId = `prod:${Buffer.from('us-east-1.aws.found.io:443$abc$kb').toString('base64')}`;
    const plan = buildSearchClientPlan(
      resolved({ endpoint: { kind: 'cloudId', cloudId }, options: { sniff: true } }),
    );
    expect(plan).toMatchObject({
      cloud: true,
      sniff: false,
      where: 'Elastic Cloud https://abc.us-east-1.aws.found.io:443',
    });
    expect(plan.nodes[0]).toMatchObject({
      protocol: 'https:',
      hostHeader: 'abc.us-east-1.aws.found.io:443',
    });
    // The profile schema already refuses it; the driver does too for a profile built by hand.
    const elastic = resolved({ endpoint: { kind: 'cloudId', cloudId } });
    expect(() =>
      buildSearchClientPlan({ ...elastic, profile: { ...elastic.profile, engine: 'opensearch' } }),
    ).toThrow(expect.objectContaining({ code: 'VALIDATION_FAILED' }));
  });

  it('goes through a tunnel to one node, keeping its name for Host and TLS', () => {
    const tunnelled = resolved(
      {
        ssh: {
          hops: [{ host: 'bastion', port: 22, user: 'me', auth: { method: 'agent' } }],
          keepAliveIntervalMs: 0,
        },
        options: { sniff: true },
      },
      {},
      { host: '127.0.0.1', port: 40001 },
    );
    const plan = buildSearchClientPlan(tunnelled);
    expect(plan).toMatchObject({ tunnelled: true, sniff: false });
    expect(plan.nodes[0]).toMatchObject({
      host: '127.0.0.1',
      port: 40001,
      hostHeader: 'es1.example.com:9200',
    });
    expect(plan.nodes[0]!.tls?.servername).toBe('es1.example.com');
    expect(() =>
      buildSearchClientPlan({
        ...tunnelled,
        profile: {
          ...tunnelled.profile,
          endpoint: { kind: 'urls', urls: ['https://a:9200', 'https://b:9200'] },
        },
      }),
    ).toThrow(expect.objectContaining({ code: 'NOT_SUPPORTED' }));
    const { endpointOverride: _override, ...noTunnel } = tunnelled;
    expect(() => buildSearchClientPlan(noTunnel)).toThrow(
      expect.objectContaining({ code: 'NOT_SUPPORTED' }),
    );
  });

  it('refuses another engine and other endpoint kinds', () => {
    expect(() =>
      buildSearchClientPlan(
        resolved({ engine: 'redis', endpoint: { kind: 'host', host: 'r', port: 6379 } }),
      ),
    ).toThrow(expect.objectContaining({ code: 'VALIDATION_FAILED' }));
  });
});

describe('redactSecrets', () => {
  it('removes secrets, URL credentials and Authorization values', () => {
    expect(
      redactSecrets('https://elastic:pw@host failed with Basic ZWxhc3RpYzpwdw== and changeme', [
        'changeme',
      ]),
    ).toBe('https://<credentials>@host failed with Basic *** and ***');
    expect(redactSecrets('pw is short, a pw', ['pw'])).toBe('*** is short, a ***');
  });
});
