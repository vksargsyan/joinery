import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ConnectionCheckResult, ConnectionProfileInput, ResolvedProfile } from '@joinery/core';
import { afterAll, describe, expect, it } from 'vitest';

import { checkConnection, isMongoSession, mongodbAdapter, type MongoSession } from '../../src';
import {
  MONGO_URL,
  STANDALONE_URL,
  TLS_CA,
  X509_CERT,
  connectMongo,
  mongoProfile,
  testDatabase,
} from './helpers';

async function steps(resolved: ResolvedProfile): Promise<ConnectionCheckResult[]> {
  const out: ConnectionCheckResult[] = [];
  for await (const result of checkConnection(resolved)) out.push(result);
  return out;
}

function failedStep(results: readonly ConnectionCheckResult[]): ConnectionCheckResult | undefined {
  return results.find((r) => r.status === 'failed');
}

function withPassword(resolved: ResolvedProfile, password: string): ResolvedProfile {
  return { ...resolved, secrets: { ...resolved.secrets, password } };
}

async function open(resolved: ResolvedProfile): Promise<MongoSession> {
  const session = await mongodbAdapter.connect(resolved);
  if (!isMongoSession(session)) throw new Error('expected a MongoSession');
  return session;
}

describe.skipIf(!MONGO_URL)('MongoDB connection (replica set)', () => {
  it('runs every Test Connection step', async () => {
    const results = await steps(mongoProfile(MONGO_URL!));
    expect(results.map((r) => [r.step, r.status])).toEqual([
      ['dns', 'skipped'],
      ['tcp', 'ok'],
      ['ssh', 'skipped'],
      ['tls', 'skipped'],
      ['auth', 'ok'],
      ['ping', 'ok'],
      ['version', 'ok'],
    ]);
    expect(results[6]!.message).toMatch(/^MongoDB 8\.\d+\.\d+, replica set rs0 \(1 member\)$/);
  });

  it('fails the auth step on a wrong password without echoing it', async () => {
    const resolved = withPassword(mongoProfile(MONGO_URL!), 'definitely-wrong-password');
    const error = await mongodbAdapter.connect(resolved).catch((e: unknown) => e);
    expect(error).toMatchObject({
      code: 'AUTH_FAILED',
      hint: expect.stringContaining('authSource'),
    });
    expect(JSON.stringify(error)).not.toContain('definitely-wrong-password');
    const failed = failedStep(await steps(resolved));
    expect(failed).toMatchObject({ step: 'auth', hint: expect.stringContaining('password') });
  });

  it('names a replica set name mismatch', async () => {
    const base = mongoProfile(MONGO_URL!);
    const endpoint = base.profile.endpoint;
    if (endpoint.kind !== 'hosts') throw new Error('expected a host list');
    const resolved = {
      ...base,
      profile: {
        ...base.profile,
        endpoint: { ...endpoint, replicaSet: 'wrong' },
        options: { ...base.profile.options, connectTimeoutMs: 1500 },
      },
    };
    await expect(mongodbAdapter.connect(resolved)).rejects.toMatchObject({
      code: 'CONNECTION_FAILED',
      hint: expect.stringContaining('replica set name'),
    });
    expect(failedStep(await steps(resolved))).toMatchObject({
      step: 'auth',
      message: expect.stringContaining('belongs to replica set "rs0", not "wrong"'),
      hint: 'Set the replica set name to "rs0"',
    });
  });

  it('fails DNS for an unknown host and TCP for a closed port', async () => {
    const unknown = mongoProfile(MONGO_URL!, {
      endpoint: { kind: 'host', host: 'no-such-host.invalid', port: 27017 },
    });
    expect(failedStep(await steps(unknown))).toMatchObject({
      step: 'dns',
      hint: expect.stringContaining('host name'),
    });
    const closed = mongoProfile(MONGO_URL!, {
      endpoint: { kind: 'host', host: '127.0.0.1', port: 1 },
    });
    expect(failedStep(await steps(closed))).toMatchObject({
      step: 'tcp',
      hint: expect.stringContaining('running'),
    });
    await expect(
      mongodbAdapter.connect({
        ...closed,
        profile: {
          ...closed.profile,
          options: { ...closed.profile.options, connectTimeoutMs: 1000 },
        },
      }),
    ).rejects.toMatchObject({
      code: 'CONNECTION_FAILED',
    });
  });

  it('connects with a URI endpoint, keeping its options and taking the password out', async () => {
    const url = new URL(MONGO_URL!.replace('mongodb://', 'http://'));
    const uri = `mongodb://${url.username}@${url.host}/admin?${url.searchParams.toString()}`;
    const resolved = mongoProfile(MONGO_URL!, {
      endpoint: { kind: 'uri', uri },
      auth: { method: 'password', password: { id: 'password' } },
    });
    const session = await open(resolved);
    try {
      expect(session.currentDatabase).toBe('admin');
      expect((await session.serverInfo()).setName).toBe('rs0');
    } finally {
      await session.close();
    }
  });

  it('refuses profiles that name a proxy or tunnel without an open route', async () => {
    const proxied = mongoProfile(MONGO_URL!, {
      proxy: { kind: 'socks5', host: '127.0.0.1', port: 1080 },
    });
    await expect(mongodbAdapter.connect(proxied)).rejects.toMatchObject({ code: 'NOT_SUPPORTED' });
    expect(failedStep(await steps(proxied))).toMatchObject({ step: 'ssh' });
  });

  it('switches databases and reads the default database from the profile', async () => {
    const db = testDatabase();
    const session = await connectMongo(MONGO_URL!, { options: { defaultDatabase: db } });
    try {
      expect(session.currentDatabase).toBe(db);
      await session.useDatabase('admin');
      expect(session.currentDatabase).toBe('admin');
      await expect(session.useDatabase('a.b')).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    } finally {
      await session.close();
    }
    await expect(session.ping()).rejects.toMatchObject({ code: 'CONNECTION_FAILED' });
  });
});

describe.skipIf(!STANDALONE_URL)('MongoDB connection (7.0 standalone, TLS, X.509)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'joinery-mongo-it-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const tls = (
    mode: 'require' | 'verify-ca' | 'verify-full',
    extra: object = {},
  ): Partial<ConnectionProfileInput> => ({
    tls: { mode, ...(TLS_CA ? { caPath: TLS_CA } : {}), ...extra },
  });

  it('refines capabilities for a standalone and refuses transactions and change streams', async () => {
    const session = await connectMongo(STANDALONE_URL!);
    try {
      expect(session.serverVersion).toMatch(/^7\./);
      expect(session.capabilities()).toMatchObject({
        transactions: false,
        changeStreams: false,
        queryCancel: true,
      });
      expect((await session.serverInfo()).topology).toBe('standalone');
      await expect(session.begin()).rejects.toMatchObject({ code: 'NOT_SUPPORTED' });
      const stream = session.watch({ kind: 'cluster' });
      await expect(stream[Symbol.asyncIterator]().next()).rejects.toMatchObject({
        code: 'NOT_SUPPORTED',
        hint: expect.stringContaining('replica set'),
      });
    } finally {
      await session.close();
    }
  });

  it.skipIf(!TLS_CA)('verifies the certificate and host name (verify-full)', async () => {
    for (const host of ['localhost', '127.0.0.1']) {
      const resolved = mongoProfile(STANDALONE_URL!, {
        endpoint: { kind: 'host', host, port: 27019 },
        ...tls('verify-full'),
      });
      const results = await steps(resolved);
      expect(results.map((r) => r.status)).toEqual(
        ['skipped', 'ok', 'skipped', 'ok', 'ok', 'ok', 'ok'].map((s, i) =>
          i === 0 && host === 'localhost' ? 'ok' : s,
        ),
      );
      expect(results[3]!.message).toContain('host name verified');
      const session = await open(resolved);
      await session.ping();
      await session.close();
    }
  });

  it.skipIf(!TLS_CA)(
    'fails TLS with a hint for a wrong server name or an untrusted CA',
    async () => {
      const wrongName = mongoProfile(
        STANDALONE_URL!,
        tls('verify-full', { servername: 'db.example.com' }),
      );
      expect(failedStep(await steps(wrongName))).toMatchObject({
        step: 'tls',
        hint: expect.stringContaining('verify-ca'),
      });
      // verify-ca ignores the name.
      const ca = mongoProfile(STANDALONE_URL!, tls('verify-ca', { servername: 'db.example.com' }));
      expect(failedStep(await steps(ca))).toBeUndefined();

      const bogusCa = join(dir, 'bogus-ca.pem');
      writeFileSync(bogusCa, BOGUS_CA);
      const untrusted = mongoProfile(STANDALONE_URL!, {
        tls: { mode: 'verify-full', caPath: bogusCa },
      });
      const failed = failedStep(await steps(untrusted));
      expect(failed).toMatchObject({
        step: 'tls',
        hint: expect.stringContaining('CA certificate'),
      });
      await expect(mongodbAdapter.connect(untrusted)).rejects.toMatchObject({ code: 'TLS_FAILED' });

      const missing = mongoProfile(STANDALONE_URL!, {
        tls: { mode: 'verify-full', caPath: join(dir, 'nope.pem') },
      });
      expect(failedStep(await steps(missing))).toMatchObject({
        step: 'dns',
        message: expect.stringContaining('Cannot read the CA certificate'),
      });

      // require encrypts without verifying anything.
      const require = mongoProfile(STANDALONE_URL!, { tls: { mode: 'require' } });
      expect(failedStep(await steps(require))).toBeUndefined();

      // TLS passes, then the login fails: the auth step names it.
      const wrongPassword = withPassword(
        mongoProfile(STANDALONE_URL!, tls('verify-full')),
        'not-the-password',
      );
      const results = await steps(wrongPassword);
      expect(results.find((r) => r.step === 'tls')!.status).toBe('ok');
      expect(failedStep(results)).toMatchObject({
        step: 'auth',
        hint: expect.stringContaining('user name and password'),
      });
      expect(JSON.stringify(results)).not.toContain('not-the-password');
    },
  );

  it.skipIf(!TLS_CA || !X509_CERT)('authenticates with an X.509 client certificate', async () => {
    const resolved = mongoProfile(STANDALONE_URL!, {
      auth: { method: 'clientCertificate' },
      tls: { mode: 'verify-full', caPath: TLS_CA!, certPath: X509_CERT!, keyPath: X509_CERT! },
    });
    const results = await steps(resolved);
    expect(failedStep(results)).toBeUndefined();
    const session = await open(resolved);
    try {
      const status = await session.execute('{ connectionStatus: 1 }', { executionId: 'x509' });
      let reply = '';
      for await (const chunk of status)
        if (chunk.type === 'rows') reply = chunk.data[0]![0] as string;
      expect(reply).toContain('OU=clients,O=Joinery,CN=joinery-x509');
    } finally {
      await session.close();
    }
    const noCert = mongoProfile(STANDALONE_URL!, {
      auth: { method: 'clientCertificate' },
      tls: { mode: 'verify-full', caPath: TLS_CA! },
    });
    await expect(mongodbAdapter.connect(noCert)).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
  });

  it('explains on 7.0 too', async () => {
    const db = testDatabase();
    const session = await connectMongo(STANDALONE_URL!);
    try {
      const ns = { db, collection: 'c' };
      await session.insertMany(
        ns,
        `[${Array.from({ length: 50 }, (_, i) => `{ a: ${i}, g: ${i % 3} }`).join(',')}]`,
      );
      await session.createIndex(ns, { keys: '{ "a": 1 }' });
      const find = await session.explainQuery(
        ns,
        { kind: 'find', query: { filter: '{ "a": { "$gt": 10 } }' } },
        'executionStats',
      );
      expect(find.summary).toMatchObject({
        collectionScan: false,
        indexes: ['a_1'],
        nReturned: 39,
      });
      const agg = await session.explainQuery(
        ns,
        {
          kind: 'aggregate',
          pipeline: `[{ $match: { a: { $gt: 10 } } }, { $group: { _id: '$g', n: { $sum: 1 } } }]`,
        },
        'executionStats',
      );
      expect(agg.summary.indexes).toEqual(['a_1']);
    } finally {
      await session.dropDatabase(db).catch(() => undefined);
      await session.close();
    }
  });
});

/** A self-signed CA that did not sign the test server's certificate. */
const BOGUS_CA = `-----BEGIN CERTIFICATE-----
MIIBsTCCAVegAwIBAgIUP2mXz0e9Gm+Uc9kfrsNcWv4bVi0wCgYIKoZIzj0EAwIw
LjEsMCoGA1UEAwwjSm9pbmVyeSB0ZXN0IENBIHRoYXQgc2lnbmVkIG5vdGhpbmcw
HhcNMjYwOTI5MTA1MjQ4WhcNNDYwOTI0MTA1MjQ4WjAuMSwwKgYDVQQDDCNKb2lu
ZXJ5IHRlc3QgQ0EgdGhhdCBzaWduZWQgbm90aGluZzBZMBMGByqGSM49AgEGCCqG
SM49AwEHA0IABC3iBAtKXGAj35gVlZvq9P5VWU5i2Ju3AF9ezXVng+rV/K2E9nre
poUYPPg41GYryHgM/3wE3Rd2/+ychSAV82ejUzBRMB0GA1UdDgQWBBSS2IWXf3TN
mG9fp/kaNuG6zo8RyzAfBgNVHSMEGDAWgBSS2IWXf3TNmG9fp/kaNuG6zo8RyzAP
BgNVHRMBAf8EBTADAQH/MAoGCCqGSM49BAMCA0gAMEUCIBoV5x0ySEfzRW/8XtMC
KWFw142SUkmPf2D4beafRgqVAiEAgl/kP+nA8SwyY8EoS41tZEEbr1BdIHbSKVbW
VrzPJRs=
-----END CERTIFICATE-----
`;
