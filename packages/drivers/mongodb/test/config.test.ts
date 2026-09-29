import {
  connectionProfileSchema,
  type ConnectionProfileInput,
  type ResolvedProfile,
} from '@joinery/core';
import { describe, expect, it } from 'vitest';

import { buildMongoClientPlan, parseHostList, redactSecrets, splitMongoUri } from '../src';

function resolved(
  input: Partial<ConnectionProfileInput>,
  secrets: Record<string, string> = {},
  endpointOverride?: { host: string; port: number },
): ResolvedProfile {
  const profile = connectionProfileSchema.parse({
    id: 'p',
    name: 'Mongo',
    engine: 'mongodb',
    endpoint: { kind: 'host', host: 'db.example.com', port: 27017 },
    createdAt: '2026-09-29T10:00:00.000Z',
    updatedAt: '2026-09-29T10:00:00.000Z',
    ...input,
  });
  return { profile, secrets, ...(endpointOverride ? { endpointOverride } : {}) };
}

const files: Record<string, string> = {
  '/ca.pem': 'CA',
  '/client.pem': 'CERT+KEY',
  '/client.key': 'KEY',
};
const readFile = (path: string): Buffer => {
  const content = files[path];
  if (content === undefined) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
  return Buffer.from(content);
};

describe('MongoDB connection strings', () => {
  it('splits credentials, hosts, database and options', () => {
    expect(
      splitMongoUri('mongodb://us%40er:p%3Ass@a:1,b:2/sales?replicaSet=rs0&authSource=admin'),
    ).toEqual({
      srv: false,
      user: 'us@er',
      password: 'p:ss',
      hosts: 'a:1,b:2',
      database: 'sales',
      query: 'replicaSet=rs0&authSource=admin',
    });
    expect(splitMongoUri('mongodb+srv://cluster0.example.net')).toEqual({
      srv: true,
      hosts: 'cluster0.example.net',
      query: '',
    });
    expect(splitMongoUri('mongodb://user@[::1]:27017/?tls=true')).toMatchObject({
      user: 'user',
      hosts: '[::1]:27017',
    });
    expect(() => splitMongoUri('postgres://x')).toThrow('must start with mongodb://');
    expect(() => splitMongoUri('mongodb://u:p@/db')).toThrow('names no host');
  });

  it('parses host lists with default ports and IPv6', () => {
    expect(parseHostList('a,b:2,[::1]:3,[fe80::1]')).toEqual([
      { host: 'a', port: 27017 },
      { host: 'b', port: 2 },
      { host: '::1', port: 3 },
      { host: 'fe80::1', port: 27017 },
    ]);
    expect(() => parseHostList('a:99999')).toThrow('invalid port');
  });

  it('never echoes a URI in errors', () => {
    try {
      splitMongoUri('mongodb://u:hunter2@h/%zz');
    } catch (error) {
      expect(String(error)).not.toContain('hunter2');
    }
  });
});

describe('buildMongoClientPlan', () => {
  it('maps a host endpoint, options and password auth', () => {
    const plan = buildMongoClientPlan(
      resolved(
        {
          auth: {
            method: 'password',
            user: 'ada',
            password: { id: 'pw' },
            mechanism: 'SCRAM-SHA-256',
          },
          tls: { mode: 'disable' },
          options: {
            connectTimeoutMs: 4000,
            idleTimeoutMs: 60000,
            applicationName: 'Joinery test',
            authSource: 'users',
            directConnection: true,
            readPreference: 'secondaryPreferred',
            defaultDatabase: 'sales',
          },
        },
        { pw: 's3cret!' },
      ),
    );
    expect(plan.url).toBe('mongodb://db.example.com:27017/');
    expect(plan.url).not.toContain('s3cret');
    expect(plan.options).toMatchObject({
      appName: 'Joinery test',
      connectTimeoutMS: 4000,
      serverSelectionTimeoutMS: 4000,
      maxIdleTimeMS: 60000,
      directConnection: true,
      readPreference: 'secondaryPreferred',
      tls: false,
      auth: { username: 'ada', password: 's3cret!' },
      authMechanism: 'SCRAM-SHA-256',
      authSource: 'users',
    });
    expect(plan).toMatchObject({
      defaultDatabase: 'sales',
      where: 'db.example.com:27017',
      tunnelled: false,
    });
    expect(plan.secrets).toContain('s3cret!');
  });

  it('maps host lists with a replica set, SRV names and LDAP', () => {
    const list = buildMongoClientPlan(
      resolved({
        endpoint: {
          kind: 'hosts',
          hosts: [
            { host: 'a', port: 1 },
            { host: '::1', port: 2 },
          ],
          replicaSet: 'rs0',
        },
        auth: { method: 'none' },
      }),
    );
    expect(list.url).toBe('mongodb://a:1,[::1]:2/');
    expect(list.options.replicaSet).toBe('rs0');
    expect(list.replicaSet).toBe('rs0');
    expect(list.defaultDatabase).toBe('test');

    const srv = buildMongoClientPlan(
      resolved(
        {
          endpoint: { kind: 'srv', host: 'cluster0.example.net' },
          auth: { method: 'password', user: 'cn=ada', password: { id: 'pw' }, mechanism: 'ldap' },
        },
        { pw: 'x' },
      ),
    );
    expect(srv.url).toBe('mongodb+srv://cluster0.example.net/');
    expect(srv.srv).toBe(true);
    expect(srv.options).toMatchObject({ authMechanism: 'PLAIN', authSource: '$external' });
    // Each member is verified against its own name: no pinned server name.
    expect(srv.options.servername).toBeUndefined();
    expect(srv.options.checkServerIdentity).toBeUndefined();
  });

  it('takes credentials out of a URI endpoint and keeps its options', () => {
    const plan = buildMongoClientPlan(
      resolved({
        endpoint: {
          kind: 'uri',
          uri: 'mongodb://ada:from-uri@h1,h2:27018/shop?replicaSet=rs1&w=majority',
        },
        auth: { method: 'password' },
        tls: { mode: 'disable' },
      }),
    );
    expect(plan.url).toBe('mongodb://h1:27017,h2:27018/shop?replicaSet=rs1&w=majority');
    expect(plan.options.auth).toEqual({ username: 'ada', password: 'from-uri' });
    expect(plan.secrets).toContain('from-uri');
    expect(plan.defaultDatabase).toBe('shop');
    expect(plan.replicaSet).toBe('rs1');
    // The profile's password wins over a URI's.
    const secret = buildMongoClientPlan(
      resolved(
        {
          endpoint: { kind: 'uri', uri: 'mongodb://ada:from-uri@h1/' },
          auth: { method: 'password', password: { id: 'pw' } },
        },
        { pw: 'from-secret' },
      ),
    );
    expect(secret.options.auth).toEqual({ username: 'ada', password: 'from-secret' });
  });

  it('asks for a password that was not unsealed and refuses unknown mechanisms', () => {
    expect(() =>
      buildMongoClientPlan(
        resolved({ auth: { method: 'password', user: 'a', password: { id: 'pw' } } }),
      ),
    ).toThrow(expect.objectContaining({ code: 'AUTH_FAILED' }));
    expect(() =>
      buildMongoClientPlan(
        resolved({ auth: { method: 'password', user: 'a', mechanism: 'GSSAPI' } }),
      ),
    ).toThrow(expect.objectContaining({ code: 'NOT_SUPPORTED' }));
    expect(() =>
      buildMongoClientPlan(resolved({ auth: { method: 'apiKey', apiKey: { id: 'k' } } })),
    ).toThrow(expect.objectContaining({ code: 'NOT_SUPPORTED' }));
  });

  it('maps X.509', () => {
    const x509 = buildMongoClientPlan(
      resolved({
        auth: { method: 'clientCertificate' },
        tls: {
          mode: 'verify-full',
          caPath: '/ca.pem',
          certPath: '/client.pem',
          keyPath: '/client.pem',
        },
      }),
      { readFile },
    );
    expect(x509.options).toMatchObject({
      authMechanism: 'MONGODB-X509',
      authSource: '$external',
      tls: true,
    });
    expect(String(x509.options.cert)).toBe('CERT+KEY');
    expect(x509.options.auth).toBeUndefined();
    expect(() =>
      buildMongoClientPlan(
        resolved({ auth: { method: 'clientCertificate' }, tls: { mode: 'disable' } }),
      ),
    ).toThrow(expect.objectContaining({ code: 'VALIDATION_FAILED' }));
  });

  it('maps the four TLS modes', () => {
    const tls = (mode: 'disable' | 'require' | 'verify-ca' | 'verify-full', extra: object = {}) =>
      buildMongoClientPlan(
        resolved({ auth: { method: 'none' }, tls: { mode, caPath: '/ca.pem', ...extra } }),
        { readFile },
      ).options;
    expect(tls('disable')).toMatchObject({ tls: false });
    expect(tls('disable').ca).toBeUndefined();
    expect(tls('require')).toMatchObject({ tls: true, tlsAllowInvalidCertificates: true });
    expect(tls('verify-ca')).toMatchObject({ tls: true, tlsAllowInvalidHostnames: true });
    const full = tls('verify-full');
    expect(full).toMatchObject({ tls: true });
    expect(String(full.ca)).toBe('CA');
    expect(full.tlsAllowInvalidCertificates).toBeUndefined();
    expect(full.tlsAllowInvalidHostnames).toBeUndefined();
    // An explicit server name pins SNI and the identity check.
    const pinned = tls('verify-full', { servername: 'db.internal' });
    expect(pinned.servername).toBe('db.internal');
    expect(typeof pinned.checkServerIdentity).toBe('function');
    const passphrase = buildMongoClientPlan(
      resolved(
        {
          auth: { method: 'none' },
          tls: {
            mode: 'verify-full',
            certPath: '/client.pem',
            keyPath: '/client.key',
            keyPassphrase: { id: 'kp' },
          },
        },
        { kp: 'key-pass' },
      ),
      { readFile },
    );
    expect(passphrase.options).toMatchObject({ passphrase: 'key-pass' });
    expect(passphrase.secrets).toContain('key-pass');
    expect(() =>
      buildMongoClientPlan(
        resolved({
          auth: { method: 'none' },
          tls: { mode: 'verify-full', caPath: '/missing.pem' },
        }),
        { readFile },
      ),
    ).toThrow(expect.objectContaining({ code: 'TLS_FAILED' }));
  });

  it('connects to a tunnel override directly, verifying the real host name', () => {
    const plan = buildMongoClientPlan(
      resolved(
        {
          endpoint: { kind: 'uri', uri: 'mongodb://db.internal:27018/app?w=majority' },
          auth: { method: 'none' },
          tls: { mode: 'verify-full' },
          ssh: {
            hops: [{ host: 'bastion', port: 22, user: 'me', auth: { method: 'agent' } }],
            keepAliveIntervalMs: 0,
          },
        },
        {},
        { host: '127.0.0.1', port: 40000 },
      ),
    );
    expect(plan.url).toBe('mongodb://127.0.0.1:40000/app?w=majority');
    expect(plan.options).toMatchObject({ directConnection: true, servername: 'db.internal' });
    expect(plan.options.proxyHost).toBeUndefined();
    expect(plan.tunnelled).toBe(true);
    expect(plan.routed).toBe(false);
    expect(plan.where).toBe('127.0.0.1:40000 (tunnel to db.internal:27018)');
    const identity = plan.options.checkServerIdentity!;
    expect(
      identity('127.0.0.1', {
        subject: { CN: 'db.internal' },
        subjectaltname: 'DNS:db.internal',
      } as never),
    ).toBeUndefined();
  });

  it('sends a replica set behind a tunnel through its SOCKS5 endpoint, by the members’ names', () => {
    const socks5 = { host: '127.0.0.1', port: 41000, user: 'joinery-ab', password: 'route-pw' };
    const nodeRoute = {
      socks5,
      forward: async () => ({ host: '127.0.0.1', port: 1 }),
      forwardNow: () => undefined,
      reserve: async () => undefined,
      forwardCount: 0,
      channelCount: 0,
    };
    const ssh = {
      hops: [{ host: 'bastion', port: 22, user: 'me', auth: { method: 'agent' as const } }],
      keepAliveIntervalMs: 0,
    };
    const override = { host: '127.0.0.1', port: 40000 };
    const routed = (input: Partial<ConnectionProfileInput>) =>
      buildMongoClientPlan({
        ...resolved({ ssh, auth: { method: 'none' }, ...input }, {}, override),
        nodeRoute,
      } as ResolvedProfile);

    const list = routed({
      endpoint: {
        kind: 'hosts',
        hosts: [
          { host: 'db1.internal', port: 27017 },
          { host: 'db2.internal', port: 27018 },
        ],
        replicaSet: 'rs0',
      },
      tls: { mode: 'verify-full' },
    });
    expect(list.url).toBe('mongodb://db1.internal:27017,db2.internal:27018/');
    expect(list.options).toMatchObject({
      replicaSet: 'rs0',
      proxyHost: '127.0.0.1',
      proxyPort: 41000,
      proxyUsername: 'joinery-ab',
      proxyPassword: 'route-pw',
      tls: true,
    });
    // Discovery stays on, and each member's certificate is checked against its own name.
    expect(list.options.directConnection).toBeUndefined();
    expect(list.options.servername).toBeUndefined();
    expect(list.options.checkServerIdentity).toBeUndefined();
    expect(list).toMatchObject({ tunnelled: true, routed: true });
    expect(list.where).toBe('db1.internal:27017, db2.internal:27018 through the tunnel');
    expect(list.secrets).toContain('route-pw');

    const srv = routed({ endpoint: { kind: 'srv', host: 'cluster0.example.net' } });
    expect(srv.url).toBe('mongodb+srv://cluster0.example.net/');
    expect(srv.options.proxyPort).toBe(41000);
    const uri = routed({
      endpoint: { kind: 'uri', uri: 'mongodb://a.internal:1/app?replicaSet=rs0' },
      options: { directConnection: false },
    });
    expect(uri.url).toBe('mongodb://a.internal:1/app?replicaSet=rs0');
    expect(uri.options).toMatchObject({ directConnection: false, proxyHost: '127.0.0.1' });
  });

  it('refuses tunnels it cannot use and proxies without a route', () => {
    const ssh = {
      hops: [{ host: 'bastion', port: 22, user: 'me', auth: { method: 'agent' as const } }],
      keepAliveIntervalMs: 0,
    };
    const override = { host: '127.0.0.1', port: 40000 };
    for (const endpoint of [
      {
        kind: 'hosts' as const,
        hosts: [
          { host: 'a', port: 1 },
          { host: 'b', port: 2 },
        ],
      },
      { kind: 'srv' as const, host: 'cluster0.example.net' },
      { kind: 'uri' as const, uri: 'mongodb+srv://cluster0.example.net/' },
    ]) {
      expect(() =>
        buildMongoClientPlan(resolved({ endpoint, ssh, auth: { method: 'none' } }, {}, override)),
      ).toThrow(expect.objectContaining({ code: 'NOT_SUPPORTED' }));
    }
    expect(() =>
      buildMongoClientPlan(
        resolved({ proxy: { kind: 'socks5', host: 'p', port: 1080 }, auth: { method: 'none' } }),
      ),
    ).toThrow(expect.objectContaining({ code: 'NOT_SUPPORTED' }));
    expect(() => buildMongoClientPlan(resolved({ ssh, auth: { method: 'none' } }))).toThrow(
      expect.objectContaining({ code: 'NOT_SUPPORTED' }),
    );
  });
});

describe('redactSecrets', () => {
  it('removes URI credentials, secret options and secret values', () => {
    expect(redactSecrets('failed for mongodb://ada:pw@h/ and mongodb+srv://x@y', [])).toBe(
      'failed for mongodb://<credentials>@h/ and mongodb+srv://<credentials>@y',
    );
    expect(redactSecrets('tlsCertificateKeyFilePassword=abc&x=1', [])).toBe(
      'tlsCertificateKeyFilePassword=***&x=1',
    );
    expect(redactSecrets('?authMechanismProperties=SESSION_TOKEN:abc,X:y&x=1', [])).toBe(
      '?authMechanismProperties=***&x=1',
    );
    expect(redactSecrets('password hunter2 rejected', ['hunter2'])).toBe('password *** rejected');
    // Short secrets only where they stand alone.
    expect(redactSecrets('abc and xabcx', ['abc'])).toBe('*** and xabcx');
  });
});
