import {
  connectionProfileSchema,
  newId,
  type ConnectionProfile,
  type ConnectionProfileInput,
} from '@joinery/core';
import { parsedConnectionUriSchema, safeProfileSchema } from '@joinery/ipc';
import { parseConnectionUri } from '@joinery/storage';
import { describe, expect, it } from 'vitest';

import {
  connectionFormSchema,
  defaultFormValues,
  defaultSshHop,
  formFromUri,
  formToProfile,
  profileToForm,
  switchEndpointKind,
  switchEngine,
  type ConnectionFormValues,
  type ParseUri,
} from '../src/renderer/src/state/connection-form';
import { passwordFromUri, uriHosts } from '../src/renderer/src/state/connection-uri';
import { profileInput } from './helpers';

/** The connection dialog for MongoDB and Redis (spec §4, §9, §10). */

function mongo(overrides: Partial<ConnectionFormValues> = {}): ConnectionFormValues {
  return { ...defaultFormValues('mongodb'), name: 'Orders', ...overrides };
}

function redis(overrides: Partial<ConnectionFormValues> = {}): ConnectionFormValues {
  return { ...defaultFormValues('redis'), name: 'Cache', tlsMode: 'disable', ...overrides };
}

function issues(values: ConnectionFormValues): Record<string, string> {
  const result = connectionFormSchema.safeParse(values);
  return Object.fromEntries(
    (result.error?.issues ?? []).map((issue) => [issue.path.join('.'), issue.message]),
  );
}

const tunnel = { sshEnabled: true, sshHops: [{ ...defaultSshHop(), host: 'b', user: 'ops' }] };
const proxy = { proxyKind: 'socks5' as const, proxyHost: 'proxy', proxyPort: '1080' };

/** Main's `profiles.parseUri` (src/main/api.ts), output validated as it crosses IPC. */
const parse: ParseUri = ({ uri, engine }) => {
  const parsed = parseConnectionUri(uri, engine === undefined ? {} : { engine });
  const now = new Date().toISOString();
  const profile = connectionProfileSchema.parse({
    ...parsed.profile,
    id: newId(),
    createdAt: now,
    updatedAt: now,
  });
  return Promise.resolve(
    parsedConnectionUriSchema.parse({
      profile,
      passwordFound: parsed.password !== undefined,
      ignoredParams: [...parsed.ignoredParams],
    }),
  );
};

async function fill(uri: string, current = defaultFormValues(), canSave = true) {
  return formFromUri(uri, { engine: current.engine, parse, current: () => current, canSave });
}

describe('engine defaults and switching', () => {
  it('starts MongoDB and Redis on their ports, without sign-in, with verified TLS', () => {
    expect(defaultFormValues('mongodb')).toMatchObject({
      port: '27017',
      endpointKind: 'host',
      authMethod: 'none',
      mechanism: 'SCRAM-SHA-256',
      hostList: [{ host: 'localhost', port: '27017' }],
      tlsMode: 'verify-full',
    });
    expect(defaultFormValues('redis')).toMatchObject({
      port: '6379',
      authMethod: 'none',
      keyDelimiter: ':',
      hostList: [{ host: 'localhost', port: '6379' }],
      sentinels: [{ host: 'localhost', port: '26379' }],
    });
    expect(issues(mongo())).toEqual({});
    expect(issues(redis())).toEqual({});
  });

  it('resets engine-specific fields and keeps what every engine shares', () => {
    const postgres = {
      ...defaultFormValues('postgres'),
      name: 'Shared',
      host: 'db.internal',
      database: 'sales',
      user: 'app',
      tlsMode: 'verify-ca' as const,
    };
    const toMongo = switchEngine(postgres, 'mongodb');
    expect(toMongo).toMatchObject({
      engine: 'mongodb',
      name: 'Shared',
      host: 'db.internal',
      port: '27017',
      database: '',
      user: 'app',
      authMethod: 'password',
      mechanism: 'SCRAM-SHA-256',
      tlsMode: 'verify-ca',
    });
    const toRedis = switchEngine(
      { ...toMongo, endpointKind: 'hosts', authMethod: 'clientCertificate', authSource: 'x' },
      'redis',
    );
    expect(toRedis).toMatchObject({
      endpointKind: 'host',
      port: '6379',
      authMethod: 'none',
      authSource: '',
      mechanism: '',
      keyDelimiter: ':',
      hostList: [{ host: 'localhost', port: '6379' }],
    });
    // A port the user typed stays; a sentinel endpoint becomes host and port for SQL.
    const sentinel = redis({ endpointKind: 'sentinel', port: '6380', masterName: 'm' });
    expect(switchEngine(sentinel, 'postgres')).toMatchObject({
      endpointKind: 'host',
      port: '6380',
      authMethod: 'password',
      masterName: '',
    });
    // MySQL and MariaDB share URIs, sockets and databases.
    const mysql = {
      ...defaultFormValues('mysql'),
      endpointKind: 'uri' as const,
      uri: 'mysql://app@db/shop',
      database: 'shop',
    };
    expect(switchEngine(mysql, 'mariadb')).toMatchObject({
      endpointKind: 'uri',
      uri: 'mysql://app@db/shop',
      database: 'shop',
    });
    expect(switchEngine(mysql, 'redis')).toMatchObject({ endpointKind: 'uri', uri: '' });
    expect(switchEngine(mysql, 'mysql')).toBe(mysql);
  });

  it('turns TLS on for SRV and seeds a host list from the single host', () => {
    const plain = mongo({ host: 'db1.example.com', port: '27018', tlsMode: 'disable' });
    expect(switchEndpointKind(plain, 'srv')).toMatchObject({
      endpointKind: 'srv',
      tlsMode: 'verify-full',
    });
    expect(switchEndpointKind({ ...plain, tlsMode: 'require' }, 'srv').tlsMode).toBe('require');
    expect(switchEndpointKind(plain, 'hosts').hostList).toEqual([
      { host: 'db1.example.com', port: '27018' },
    ]);
    const edited = mongo({ hostList: [{ host: 'a', port: '1' }] });
    expect(switchEndpointKind(edited, 'hosts').hostList).toEqual([{ host: 'a', port: '1' }]);
    expect(switchEndpointKind(redis({ host: 'c1', port: '7000' }), 'cluster').hostList).toEqual([
      { host: 'c1', port: '7000' },
    ]);
    // Back to one host: an untouched host takes the list's first row.
    const list = mongo({ endpointKind: 'hosts', hostList: [{ host: 'db2', port: '27019' }] });
    expect(switchEndpointKind(list, 'host')).toMatchObject({ host: 'db2', port: '27019' });
    expect(switchEndpointKind({ ...list, host: 'mine' }, 'host')).toMatchObject({
      host: 'mine',
      port: '27017',
    });
  });
});

describe('MongoDB form validation', () => {
  it('checks each endpoint form', () => {
    expect(issues(mongo({ endpointKind: 'socket', socketPath: '/tmp/m.sock' }))).toEqual({
      endpointKind: 'MongoDB cannot connect this way',
    });
    expect(issues(mongo({ endpointKind: 'hosts', hostList: [] }))).toEqual({
      hostList: 'Add at least one host',
    });
    expect(
      issues(
        mongo({
          endpointKind: 'hosts',
          hostList: [
            { host: '', port: '27017' },
            { host: 'b', port: 'x' },
          ],
        }),
      ),
    ).toEqual({ 'hostList.0.host': 'Enter a host', 'hostList.1.port': 'Port must be 1 to 65535' });
    expect(issues(mongo({ endpointKind: 'srv', host: '' }))).toEqual({
      host: 'Enter the SRV host name',
    });
    expect(issues(mongo({ endpointKind: 'srv', host: 'c.example.net:27017' }))).toHaveProperty(
      'host',
    );
    expect(issues(mongo({ endpointKind: 'srv', host: 'cluster0.example.net' }))).toEqual({});
    expect(issues(mongo({ endpointKind: 'uri', uri: 'postgresql://db/app' }))).toEqual({
      uri: 'A MongoDB URI starts with mongodb:// or mongodb+srv://',
    });
    const withPassword = issues(
      mongo({ endpointKind: 'uri', uri: 'mongodb://app:hunter2@a:1,b:2/db' }),
    );
    expect(withPassword['uri']).toMatch(/password field/);
    expect(JSON.stringify(withPassword)).not.toContain('hunter2');
    expect(
      issues(mongo({ endpointKind: 'uri', uri: 'mongodb+srv://app@cluster0.example.net/app' })),
    ).toEqual({});
  });

  it('checks each sign-in method', () => {
    expect(issues(mongo({ authMethod: 'password', user: '' }))).toEqual({
      user: 'Enter the user name',
    });
    expect(issues(mongo({ authMethod: 'password', user: 'app', passwordMode: 'ask' }))).toEqual({});
    expect(issues(mongo({ authMethod: 'clientCertificate', tlsMode: 'disable' }))).toEqual({
      tlsMode: 'X.509 authentication needs TLS',
      certPath: 'Choose the client certificate',
      keyPath: 'Choose the client key (the same file when the PEM holds both)',
    });
    expect(
      issues(mongo({ authMethod: 'clientCertificate', certPath: '/c.pem', keyPath: '/c.pem' })),
    ).toEqual({});
  });

  it('checks database names, the authentication database and the delimiter', () => {
    const message = issues(mongo({ database: 'my.db' }))['database'];
    expect(message).toMatch(/fewer than 64 characters/);
    expect(issues(mongo({ database: 'x'.repeat(64) }))).toHaveProperty('database');
    expect(issues(mongo({ database: 'sales_2026' }))).toEqual({});
    const scram = { authMethod: 'password' as const, user: 'app' };
    expect(issues(mongo({ ...scram, authSource: 'ad min' }))).toHaveProperty('authSource');
    expect(issues(mongo({ ...scram, authSource: '$external' }))).toEqual({});
    // Not edited (hence not checked) for LDAP, whose users are always in $external.
    expect(issues(mongo({ ...scram, mechanism: 'PLAIN', authSource: 'ad min' }))).toEqual({});
    // A URI names its own database.
    expect(
      issues(mongo({ endpointKind: 'uri', uri: 'mongodb://h/app', database: 'my.db' })),
    ).toEqual({});
  });

  it('lets only a single host through an SSH tunnel or a proxy, and says why', () => {
    for (const extra of [tunnel, proxy]) {
      expect(issues(mongo({ ...extra }))).toEqual({});
      expect(issues(mongo({ ...extra, endpointKind: 'hosts' }))['endpointKind']).toMatch(
        /connects directly to one host/,
      );
      expect(
        issues(mongo({ ...extra, endpointKind: 'srv', host: 'c.example.net' })),
      ).toHaveProperty('endpointKind');
      for (const uri of ['mongodb://a:1,b:2/app', 'mongodb+srv://c.example.net/app']) {
        expect(issues(mongo({ ...extra, endpointKind: 'uri', uri }))['uri']).toMatch(/single-host/);
      }
      expect(
        issues(mongo({ ...extra, endpointKind: 'uri', uri: 'mongodb://app@[::1]:27018/app' })),
      ).toEqual({});
    }
  });
});

describe('Redis form validation', () => {
  it('checks Sentinel, Cluster, database number and delimiter', () => {
    expect(issues(redis({ endpointKind: 'sentinel', sentinels: [] }))).toEqual({
      sentinels: 'Add at least one Sentinel',
      masterName: 'Enter the name of the master the Sentinels watch',
    });
    expect(
      issues(
        redis({
          endpointKind: 'sentinel',
          sentinels: [{ host: 's1', port: '99999' }],
          masterName: 'mymaster',
        }),
      ),
    ).toEqual({ 'sentinels.0.port': 'Port must be 1 to 65535' });
    expect(
      issues(redis({ endpointKind: 'cluster', hostList: [{ host: '', port: '7000' }] })),
    ).toEqual({ 'hostList.0.host': 'Enter a host' });
    for (const database of ['0', '15', '16', '100']) {
      expect(issues(redis({ database })), database).toEqual({});
    }
    for (const database of ['-1', 'one', '1.5', '99999999999']) {
      expect(issues(redis({ database })), database).toEqual({
        database: 'Enter a database number (0 to 15 on a default server)',
      });
    }
    // A cluster has only database 0, so the field is not shown or checked.
    expect(issues(redis({ endpointKind: 'cluster', database: 'one' }))).toEqual({});
    expect(issues(redis({ keyDelimiter: '' }))).toEqual({});
    expect(issues(redis({ keyDelimiter: '-'.repeat(17) }))).toHaveProperty('keyDelimiter');
    expect(issues(redis({ endpointKind: 'socket', socketPath: '/run/redis.sock' }))).toEqual({});
  });

  it('checks URIs: scheme, password and TLS as rediss:// says', () => {
    const uri = (text: string, tlsMode: ConnectionFormValues['tlsMode']) =>
      issues(redis({ endpointKind: 'uri', uri: text, tlsMode }));
    expect(uri('redis://cache:6379/0', 'disable')).toEqual({});
    expect(uri('rediss://cache:6380/0', 'verify-full')).toEqual({});
    expect(uri('rediss://cache:6380/0', 'disable')).toEqual({
      tlsMode: 'A rediss:// URI connects with TLS: choose a TLS mode, or use redis://',
    });
    expect(uri('redis://cache', 'verify-full')['tlsMode']).toMatch(/without TLS/);
    expect(uri('mongodb://cache', 'disable')).toEqual({
      uri: 'A Redis URI starts with redis:// or rediss:// (TLS)',
    });
    expect(uri('redis://:hunter2@cache:6379', 'disable')['uri']).toMatch(/password field/);
    expect(uri('redis://default:hunter2@cache:6379', 'disable')['uri']).toMatch(/password field/);
  });

  it('keeps Sentinel, Cluster and sockets out of tunnels and proxies', () => {
    for (const extra of [tunnel, proxy]) {
      expect(issues(redis({ ...extra }))).toEqual({});
      for (const endpointKind of ['sentinel', 'cluster'] as const) {
        expect(issues(redis({ ...extra, endpointKind, masterName: 'm' }))['endpointKind']).toMatch(
          /Sentinel and Cluster cannot go through an SSH tunnel or a proxy yet/,
        );
      }
      expect(
        issues(redis({ ...extra, endpointKind: 'socket', socketPath: '/run/r.sock' })),
      ).toHaveProperty('socketPath');
      expect(
        issues(redis({ ...extra, endpointKind: 'uri', uri: 'redis://a:7000,b:7001' }))['uri'],
      ).toMatch(/single-host/);
      expect(issues(redis({ ...extra, endpointKind: 'uri', uri: 'redis://cache:6379/2' }))).toEqual(
        {},
      );
    }
  });
});

/** profile → form → profile, as the dialog does when a profile is edited and saved unchanged. */
function roundTrip(input: Partial<ConnectionProfileInput>): {
  readonly original: ConnectionProfile;
  readonly again: ConnectionProfile;
  readonly values: ConnectionFormValues;
} {
  const original = connectionProfileSchema.parse(profileInput(input));
  const values = profileToForm(original);
  expect(issues(values), JSON.stringify(input.endpoint)).toEqual({});
  const parsed = connectionFormSchema.parse(values);
  const again = connectionProfileSchema.parse(
    formToProfile(parsed, original, () => original.updatedAt).profile,
  );
  return { original, again, values };
}

const ref = (policy: 'save' | 'session' | 'ask' = 'save') => ({ id: newId(), policy });

describe('MongoDB profile ↔ form', () => {
  const cases: Record<string, Partial<ConnectionProfileInput>> = {
    'host, SCRAM-SHA-1 and every option': {
      endpoint: { kind: 'host', host: 'db.example.com', port: 27018 },
      auth: { method: 'password', user: 'app', password: ref(), mechanism: 'SCRAM-SHA-1' },
      tls: { mode: 'verify-ca', caPath: '/etc/ssl/ca.pem', servername: 'db' },
      options: {
        defaultDatabase: 'sales',
        authSource: 'admin',
        readPreference: 'secondaryPreferred',
        directConnection: true,
        connectTimeoutMs: 5000,
      },
    },
    'host list with a replica set, no sign-in': {
      endpoint: {
        kind: 'hosts',
        hosts: [
          { host: 'a.example.com', port: 27017 },
          { host: '::1', port: 27018 },
        ],
        replicaSet: 'rs0',
      },
      auth: { method: 'none' },
      options: { readPreference: 'nearest' },
    },
    'SRV record and LDAP': {
      endpoint: { kind: 'srv', host: 'cluster0.example.net' },
      auth: { method: 'password', user: 'ldap', password: ref('ask'), mechanism: 'PLAIN' },
      tls: { mode: 'verify-full' },
      options: { authSource: '$external', defaultDatabase: 'app' },
    },
    'URI with its own options': {
      endpoint: { kind: 'uri', uri: 'mongodb://app@h1,h2/app?replicaSet=rs0&compressors=zstd' },
      auth: { method: 'password', user: 'app', password: ref('session') },
      options: { defaultDatabase: 'app', authSource: 'admin', readPreference: 'secondary' },
    },
    'X.509 client certificate': {
      endpoint: { kind: 'host', host: 'db', port: 27017 },
      auth: { method: 'clientCertificate', user: 'CN=app,OU=clients' },
      tls: {
        mode: 'verify-full',
        certPath: '/certs/app.pem',
        keyPath: '/certs/app.pem',
        keyPassphrase: ref(),
      },
      options: { authSource: '$external' },
    },
    'an explicit directConnection=false and a negotiated mechanism': {
      endpoint: { kind: 'host', host: 'db', port: 27017 },
      auth: { method: 'password', user: 'app' },
      options: { directConnection: false },
    },
    'a tunnelled host': {
      endpoint: { kind: 'host', host: '10.0.0.5', port: 27017 },
      auth: { method: 'password', user: 'app', password: ref(), mechanism: 'SCRAM-SHA-256' },
      ssh: { hops: [{ host: 'bastion', user: 'ops', auth: { method: 'agent' } }] },
      presentation: { tags: ['orders'], environment: 'staging' },
    },
  };
  for (const [name, input] of Object.entries(cases)) {
    it(`round-trips ${name}`, () => {
      const { original, again } = roundTrip({ engine: 'mongodb', name: 'Mongo', ...input });
      expect(again).toEqual(original);
    });
  }

  it('shows each field where the dialog edits it', () => {
    const { values } = roundTrip({
      engine: 'mongodb',
      ...cases['host list with a replica set, no sign-in'],
    });
    expect(values).toMatchObject({
      engine: 'mongodb',
      endpointKind: 'hosts',
      hostList: [
        { host: 'a.example.com', port: '27017' },
        { host: '::1', port: '27018' },
      ],
      replicaSet: 'rs0',
      authMethod: 'none',
      readPreference: 'nearest',
    });
    const srv = roundTrip({ engine: 'mongodb', ...cases['SRV record and LDAP'] }).values;
    expect(srv).toMatchObject({
      endpointKind: 'srv',
      host: 'cluster0.example.net',
      mechanism: 'PLAIN',
      passwordMode: 'ask',
      password: '',
    });
  });

  it('builds a safe profile with the password as a reference only', () => {
    const { profile, secrets, passwordRef } = formToProfile(
      mongo({
        endpointKind: 'hosts',
        hostList: [
          { host: 'a', port: '27017' },
          { host: 'b', port: '27018' },
        ],
        replicaSet: 'rs0',
        authMethod: 'password',
        user: 'app',
        password: 'hunter2',
        passwordMode: 'session',
        authSource: 'admin',
        readPreference: 'secondary',
        directConnection: true,
        database: 'sales',
      }),
    );
    const parsed = safeProfileSchema.parse(profile);
    expect(JSON.stringify(parsed)).not.toContain('hunter2');
    expect(parsed.endpoint).toEqual({
      kind: 'hosts',
      hosts: [
        { host: 'a', port: 27017 },
        { host: 'b', port: 27018 },
      ],
      replicaSet: 'rs0',
    });
    expect(parsed.auth).toEqual({
      method: 'password',
      user: 'app',
      password: passwordRef,
      mechanism: 'SCRAM-SHA-256',
    });
    // directConnection only applies to a single host.
    expect(parsed.options).toMatchObject({
      defaultDatabase: 'sales',
      authSource: 'admin',
      readPreference: 'secondary',
    });
    expect(parsed.options.directConnection).toBeUndefined();
    expect(secrets).toEqual([{ ref: passwordRef, value: 'hunter2', previousPolicy: undefined }]);
  });

  it('puts LDAP users in $external and keeps other databases away from X.509', () => {
    const ldap = formToProfile(
      mongo({ authMethod: 'password', user: 'u', mechanism: 'PLAIN', authSource: 'admin' }),
    );
    expect(safeProfileSchema.parse(ldap.profile).options.authSource).toBe('$external');
    const x509 = formToProfile(
      mongo({
        authMethod: 'clientCertificate',
        certPath: '/c.pem',
        keyPath: '/c.pem',
        authSource: 'admin',
        password: 'ignored',
      }),
    );
    const parsed = safeProfileSchema.parse(x509.profile);
    expect(parsed.auth).toEqual({ method: 'clientCertificate' });
    expect(parsed.options.authSource).toBeUndefined();
    expect(x509.secrets).toEqual([]);
    expect(x509.passwordRef).toBeUndefined();
  });

  it('drops a sign-in password and MongoDB options when they no longer apply', () => {
    const existing = connectionProfileSchema.parse(
      profileInput({
        engine: 'mongodb',
        endpoint: { kind: 'host', host: 'db', port: 27017 },
        auth: { method: 'password', user: 'app', password: ref() },
        options: { authSource: 'admin', readPreference: 'secondary', connectTimeoutMs: 3000 },
      }),
    );
    const open = formToProfile({ ...profileToForm(existing), authMethod: 'none' }, existing);
    expect(connectionProfileSchema.parse(open.profile).auth).toEqual({ method: 'none' });
    expect(open.secrets).toEqual([]);
    const asPostgres = formToProfile(switchEngine(profileToForm(existing), 'postgres'), existing);
    const options = connectionProfileSchema.parse(asPostgres.profile).options;
    expect(options.authSource).toBeUndefined();
    expect(options.readPreference).toBeUndefined();
    expect(options.connectTimeoutMs).toBe(3000);
  });
});

describe('Redis profile ↔ form', () => {
  const cases: Record<string, Partial<ConnectionProfileInput>> = {
    'host with an ACL user, database and delimiter': {
      endpoint: { kind: 'host', host: 'cache.example.com', port: 6380 },
      auth: { method: 'password', user: 'app', password: ref() },
      tls: { mode: 'verify-full', caPath: '/ca.pem' },
      options: { defaultDatabase: '3', keyDelimiter: '::' },
    },
    'Unix socket without sign-in': {
      endpoint: { kind: 'socket', path: '/var/run/redis/redis.sock' },
      auth: { method: 'none' },
      options: { defaultDatabase: '0' },
    },
    Sentinel: {
      endpoint: {
        kind: 'sentinel',
        sentinels: [
          { host: 's1', port: 26379 },
          { host: 's2', port: 26380 },
        ],
        masterName: 'mymaster',
      },
      auth: { method: 'password', password: ref('ask') },
      options: { defaultDatabase: '1', keyDelimiter: ':' },
    },
    Cluster: {
      endpoint: {
        kind: 'cluster',
        seeds: [
          { host: 'c1', port: 7000 },
          { host: 'c2', port: 7001 },
        ],
      },
      auth: { method: 'password', password: ref() },
    },
    'rediss:// URI': {
      endpoint: { kind: 'uri', uri: 'rediss://app@cache:6380/2' },
      auth: { method: 'password', user: 'app', password: ref('session') },
      tls: { mode: 'verify-full' },
      options: { defaultDatabase: '2', keyDelimiter: '/' },
    },
    'a tunnelled host through a proxy': {
      endpoint: { kind: 'host', host: '10.0.0.7', port: 6379 },
      auth: { method: 'none' },
      proxy: { kind: 'socks5', host: 'proxy', port: 1080, password: ref() },
      options: { initSql: [], applicationName: 'Joinery' },
    },
  };
  for (const [name, input] of Object.entries(cases)) {
    it(`round-trips ${name}`, () => {
      const { original, again } = roundTrip({ engine: 'redis', name: 'Redis', ...input });
      expect(again).toEqual(original);
    });
  }

  it('shows each field where the dialog edits it', () => {
    const sentinel = roundTrip({ engine: 'redis', ...cases['Sentinel'] }).values;
    expect(sentinel).toMatchObject({
      endpointKind: 'sentinel',
      sentinels: [
        { host: 's1', port: '26379' },
        { host: 's2', port: '26380' },
      ],
      masterName: 'mymaster',
      authMethod: 'password',
      user: '',
      passwordMode: 'ask',
      database: '1',
      keyDelimiter: ':',
    });
    const cluster = roundTrip({ engine: 'redis', ...cases['Cluster'] }).values;
    expect(cluster).toMatchObject({
      endpointKind: 'cluster',
      hostList: [
        { host: 'c1', port: '7000' },
        { host: 'c2', port: '7001' },
      ],
      keyDelimiter: '',
    });
  });

  it('saves the delimiter, and no database for a cluster', () => {
    const plain = safeProfileSchema.parse(
      formToProfile(redis({ database: '4', authMethod: 'password', password: 'pw' })).profile,
    );
    expect(plain.options).toMatchObject({ defaultDatabase: '4', keyDelimiter: ':' });
    expect(plain.auth).toMatchObject({ method: 'password' });
    expect(JSON.stringify(plain)).not.toContain('"pw"');
    const cluster = safeProfileSchema.parse(
      formToProfile(redis({ endpointKind: 'cluster', database: '4', keyDelimiter: '|' })).profile,
    );
    expect(cluster.endpoint).toEqual({
      kind: 'cluster',
      seeds: [{ host: 'localhost', port: 6379 }],
    });
    expect(cluster.options.defaultDatabase).toBeUndefined();
    expect(cluster.options.keyDelimiter).toBe('|');
    expect(cluster.auth).toEqual({ method: 'none' });
  });
});

describe('Fill from URI', () => {
  it('fills a multi-host MongoDB URI into a host list with its options', async () => {
    const uri =
      'mongodb://app:s3cr%40t@db1.example.com:27017,db2.example.com:27018/sales?replicaSet=rs0&authSource=admin&tls=true';
    const { values, ignoredParams } = await fill(uri);
    expect(values).toMatchObject({
      engine: 'mongodb',
      endpointKind: 'hosts',
      hostList: [
        { host: 'db1.example.com', port: '27017' },
        { host: 'db2.example.com', port: '27018' },
      ],
      replicaSet: 'rs0',
      authSource: 'admin',
      database: 'sales',
      tlsMode: 'verify-full',
      authMethod: 'password',
      user: 'app',
      mechanism: '',
      password: 's3cr@t',
      passwordMode: 'save',
    });
    expect(ignoredParams).toEqual([]);
    expect(issues(values)).toEqual({});
    const { profile } = formToProfile(connectionFormSchema.parse(values));
    const parsed = safeProfileSchema.parse(profile);
    expect(JSON.stringify(parsed)).not.toContain('s3cr');
    expect(parsed.options.authSource).toBe('admin');
  });

  it('fills SRV, IPv6 hosts, missing ports and read preferences', async () => {
    const srv = await fill(
      'mongodb+srv://app:pw@cluster0.example.net/app?retryWrites=true&w=majority&readPreference=secondaryPreferred',
    );
    expect(srv.values).toMatchObject({
      endpointKind: 'srv',
      host: 'cluster0.example.net',
      database: 'app',
      tlsMode: 'verify-full',
      readPreference: 'secondaryPreferred',
      password: 'pw',
    });
    expect((await fill('mongodb+srv://cluster0.example.net/?tls=false')).values.tlsMode).toBe(
      'disable',
    );
    const ipv6 = await fill('mongodb://[::1]:27018/?directConnection=true');
    expect(ipv6.values).toMatchObject({
      endpointKind: 'host',
      host: '::1',
      port: '27018',
      directConnection: true,
      authMethod: 'none',
    });
    const noPorts = await fill('mongodb://a,[fe80::1]/?replicaSet=rs0');
    expect(noPorts.values.hostList).toEqual([
      { host: 'a', port: '27017' },
      { host: 'fe80::1', port: '27017' },
    ]);
    // An option the profile cannot hold keeps the whole URI, options included.
    const kept = await fill('mongodb://app:pw@h/?readPreference=secondary&compressors=zstd');
    expect(kept.values).toMatchObject({
      endpointKind: 'uri',
      uri: 'mongodb://app@h/?readPreference=secondary&compressors=zstd',
      readPreference: '',
      password: 'pw',
    });
    expect(issues(kept.values)).toEqual({});
    // directConnection is for one host: with several it stays in the URI.
    const direct = await fill('mongodb://a,b/?directConnection=true');
    expect(direct.values.endpointKind).toBe('uri');
  });

  it('fills LDAP and X.509 sign-in', async () => {
    const ldap = await fill('mongodb://ldap%2Fuser:pw@h/?authMechanism=PLAIN&authSource=$external');
    expect(ldap.values).toMatchObject({
      endpointKind: 'host',
      authMethod: 'password',
      user: 'ldap/user',
      mechanism: 'PLAIN',
      password: 'pw',
    });
    expect(
      safeProfileSchema.parse(formToProfile(connectionFormSchema.parse(ldap.values)).profile)
        .options.authSource,
    ).toBe('$external');
    const x509 = await fill(
      'mongodb://h/?authMechanism=MONGODB-X509&tls=true&tlsCertificateKeyFile=/certs/me.pem',
    );
    expect(x509.values).toMatchObject({
      authMethod: 'clientCertificate',
      certPath: '/certs/me.pem',
      keyPath: '/certs/me.pem',
      tlsMode: 'verify-full',
      password: '',
    });
    expect(issues(x509.values)).toEqual({});
  });

  it('fills Redis URIs: rediss, database in the path, IPv6, Sentinel, sockets', async () => {
    const tls = await fill('rediss://app:p%3Aw@cache.example.com:6380/3');
    expect(tls.values).toMatchObject({
      engine: 'redis',
      endpointKind: 'host',
      host: 'cache.example.com',
      port: '6380',
      database: '3',
      tlsMode: 'verify-full',
      authMethod: 'password',
      user: 'app',
      password: 'p:w',
    });
    expect(issues(tls.values)).toEqual({});
    const ipv6 = await fill('redis://:secret@[::1]/2');
    expect(ipv6.values).toMatchObject({
      host: '::1',
      port: '6379',
      database: '2',
      tlsMode: 'disable',
      user: '',
      password: 'secret',
    });
    const query = await fill('redis://cache?db=5');
    expect(query.values).toMatchObject({ database: '5', authMethod: 'none' });
    const sentinel = await fill('redis+sentinel://:pw@s1:26379,s2/mymaster/1');
    expect(sentinel.values).toMatchObject({
      endpointKind: 'sentinel',
      sentinels: [
        { host: 's1', port: '26379' },
        { host: 's2', port: '26379' },
      ],
      masterName: 'mymaster',
      database: '1',
      password: 'pw',
    });
    const socket = await fill('unix:///var/run/redis.sock?db=2');
    expect(socket.values).toMatchObject({
      endpointKind: 'socket',
      socketPath: '/var/run/redis.sock',
      database: '2',
    });
    // Several hosts keep the URI, without its password.
    const multi = await fill('redis://:pw@a:7000,b:7001/0');
    expect(multi.values).toMatchObject({ endpointKind: 'uri', uri: 'redis://a:7000,b:7001/0' });
    expect(multi.values.password).toBe('pw');
    expect(issues(multi.values)).toEqual({});
  });

  it('keeps the name and presentation, and asks where to keep a found password', async () => {
    const current = { ...defaultFormValues(), name: 'Mine', environment: 'production' as const };
    const { values } = await fill('redis://:pw@cache/0', current, false);
    expect(values).toMatchObject({
      name: 'Mine',
      environment: 'production',
      passwordMode: 'session',
    });
    const none = await fill('mongodb://db/app', { ...current, passwordMode: 'ask' });
    expect(none.values).toMatchObject({ password: '', passwordMode: 'ask', name: 'Mine' });
  });

  it('reads the fields it keeps only once every parse is back', async () => {
    // The user types a name while main parses.
    let typed = '';
    const typing: ParseUri = async (input) => {
      const result = await parse(input);
      typed += 'x';
      return result;
    };
    const { values } = await formFromUri('mongodb://a,b/db?replicaSet=rs0&authSource=admin', {
      engine: 'postgres',
      parse: typing,
      current: () => ({ ...defaultFormValues(), name: typed }),
      canSave: true,
    });
    expect(typed).toBe('x');
    expect(values).toMatchObject({ name: 'x', endpointKind: 'hosts', authSource: 'admin' });
  });

  it('reports what the profile could not hold, never a value', async () => {
    const { ignoredParams, values } = await fill('mongodb://h/app?tlsCertificateKeyFilePassword=k');
    expect(ignoredParams).toEqual(['tlsCertificateKeyFilePassword']);
    expect(JSON.stringify(values)).not.toContain('=k');
  });
});

describe('URI text helpers', () => {
  it('takes the password as the parser does', () => {
    expect(passwordFromUri('mongodb://app:p%40ss@a:1,b:2/db?replicaSet=rs0')).toBe('p@ss');
    expect(passwordFromUri('mongodb://app:p@ss@[::1]:27017/db')).toBe('p@ss');
    expect(passwordFromUri('redis://:pw@cache:6379/0')).toBe('pw');
    expect(passwordFromUri('jdbc:postgresql://app:pw@db/app')).toBe('pw');
    expect(passwordFromUri('postgresql://db/app?password=a&password=b%2Bc+d')).toBe('b+c+d');
    expect(passwordFromUri('postgresql://app:@db/app?password=q')).toBe('q');
    expect(passwordFromUri('redis://app@cache/0?x=a:b@c')).toBeUndefined();
  });

  it('counts the hosts of a URI', () => {
    expect(uriHosts('mongodb://u:p@a:1,[::1]:2,b/db?x=@,y')).toEqual(['a:1', '[::1]:2', 'b']);
    expect(uriHosts('redis://cache')).toEqual(['cache']);
    expect(uriHosts('redis://')).toEqual([]);
    expect(uriHosts('not a uri')).toEqual([]);
  });
});
