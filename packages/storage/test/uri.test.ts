import { inspect } from 'node:util';

import { secretRefsOf } from '@joinery/core';
import { describe, expect, it } from 'vitest';

import {
  parseConnectionUri,
  type ConnectionProfileDraft,
  type ParseConnectionUriOptions,
} from '../src';
import { memoryStore, thrown } from './helpers';

const REF = { id: expect.any(String), policy: 'save' };

interface Case {
  readonly uri: string;
  readonly options?: ParseConnectionUriOptions;
  readonly name?: string;
  readonly engine?: ConnectionProfileDraft['engine'];
  readonly endpoint: ConnectionProfileDraft['endpoint'];
  readonly auth?: object;
  readonly tls?: object;
  readonly profileOptions?: object;
  readonly password?: string;
  readonly ignored?: readonly string[];
}

const CASES: readonly Case[] = [
  // PostgreSQL: the libpq documentation's examples and common hosted providers.
  {
    uri: 'postgres://user:secret@localhost:5432/app',
    name: 'localhost/app',
    engine: 'postgres',
    endpoint: { kind: 'host', host: 'localhost', port: 5432 },
    auth: { method: 'password', user: 'user', password: REF },
    profileOptions: { defaultDatabase: 'app' },
    password: 'secret',
  },
  {
    uri: 'postgresql://localhost',
    name: 'localhost',
    endpoint: { kind: 'host', host: 'localhost', port: 5432 },
  },
  {
    uri: 'postgresql://localhost:5433',
    name: 'localhost:5433',
    endpoint: { kind: 'host', host: 'localhost', port: 5433 },
  },
  {
    uri: 'postgresql://user@localhost',
    endpoint: { kind: 'host', host: 'localhost', port: 5432 },
    auth: { method: 'password', user: 'user' },
  },
  {
    uri: 'postgresql://other@localhost/otherdb?connect_timeout=10&application_name=myapp',
    endpoint: { kind: 'host', host: 'localhost', port: 5432 },
    auth: { method: 'password', user: 'other' },
    profileOptions: {
      connectTimeoutMs: 10_000,
      applicationName: 'myapp',
      defaultDatabase: 'otherdb',
    },
  },
  {
    uri: 'postgresql://host1:123,host2:456/somedb?target_session_attrs=any&application_name=myapp',
    name: 'host1:123/somedb',
    endpoint: {
      kind: 'uri',
      uri: 'postgresql://host1:123,host2:456/somedb?target_session_attrs=any&application_name=myapp',
    },
    profileOptions: { applicationName: 'myapp', defaultDatabase: 'somedb' },
  },
  {
    uri: 'postgresql:///mydb?host=localhost&port=5433',
    endpoint: { kind: 'host', host: 'localhost', port: 5433 },
    profileOptions: { defaultDatabase: 'mydb' },
  },
  {
    uri: 'postgresql://[2001:db8::1234]/database',
    name: '2001:db8::1234/database',
    endpoint: { kind: 'host', host: '2001:db8::1234', port: 5432 },
    profileOptions: { defaultDatabase: 'database' },
  },
  {
    uri: 'postgresql://[::1]:6543/db',
    endpoint: { kind: 'host', host: '::1', port: 6543 },
    profileOptions: { defaultDatabase: 'db' },
  },
  {
    uri: 'postgresql:///dbname?host=/var/lib/postgresql',
    name: 'localhost/dbname',
    endpoint: { kind: 'socket', path: '/var/lib/postgresql' },
    profileOptions: { defaultDatabase: 'dbname' },
  },
  {
    uri: 'postgresql://%2Fvar%2Flib%2Fpostgresql/dbname',
    endpoint: { kind: 'socket', path: '/var/lib/postgresql' },
    profileOptions: { defaultDatabase: 'dbname' },
  },
  {
    // A non-default port selects the socket file inside the directory, as libpq does.
    uri: 'postgresql://%2Fvar%2Frun%2Fpostgresql:5433/db',
    name: 'localhost:5433/db',
    endpoint: { kind: 'socket', path: '/var/run/postgresql/.s.PGSQL.5433' },
    profileOptions: { defaultDatabase: 'db' },
  },
  {
    uri: 'postgresql://postgres.abcdefghijklmnop:[YOUR-PASSWORD]@aws-0-us-east-1.pooler.supabase.com:6543/postgres',
    endpoint: { kind: 'host', host: 'aws-0-us-east-1.pooler.supabase.com', port: 6543 },
    auth: { method: 'password', user: 'postgres.abcdefghijklmnop', password: REF },
    profileOptions: { defaultDatabase: 'postgres' },
    password: '[YOUR-PASSWORD]',
  },
  {
    uri: 'postgresql://alex:AbC123dEf@ep-cool-darkness-123456.us-east-2.aws.neon.tech/dbname?sslmode=require&channel_binding=require',
    endpoint: {
      kind: 'uri',
      uri: 'postgresql://alex@ep-cool-darkness-123456.us-east-2.aws.neon.tech/dbname?sslmode=require&channel_binding=require',
    },
    auth: { method: 'password', user: 'alex', password: REF },
    tls: { mode: 'require' },
    profileOptions: { defaultDatabase: 'dbname' },
    password: 'AbC123dEf',
  },
  {
    uri: 'postgresql://admin:pw@mydb.123456789012.us-east-1.rds.amazonaws.com:5432/postgres?sslmode=verify-full&sslrootcert=/opt/certs/global-bundle.pem',
    endpoint: { kind: 'host', host: 'mydb.123456789012.us-east-1.rds.amazonaws.com', port: 5432 },
    auth: { method: 'password', user: 'admin', password: REF },
    tls: { mode: 'verify-full', caPath: '/opt/certs/global-bundle.pem' },
    profileOptions: { defaultDatabase: 'postgres' },
    password: 'pw',
  },
  {
    uri: 'postgres://u1abc:p2def@ec2-1-2-3-4.compute-1.amazonaws.com:5432/d8abc',
    endpoint: { kind: 'host', host: 'ec2-1-2-3-4.compute-1.amazonaws.com', port: 5432 },
    auth: { method: 'password', user: 'u1abc', password: REF },
    profileOptions: { defaultDatabase: 'd8abc' },
    password: 'p2def',
  },
  {
    uri: 'postgres://app%40corp:p%40ss%3Aw%2Fd%23%3F@db.internal:5432/my%20db',
    endpoint: { kind: 'host', host: 'db.internal', port: 5432 },
    auth: { method: 'password', user: 'app@corp', password: REF },
    profileOptions: { defaultDatabase: 'my db' },
    password: 'p@ss:w/d#?',
  },
  {
    // An unencoded @ in the password: the last @ ends the user info.
    uri: 'postgres://user:p@ss:word@db.internal/app',
    endpoint: { kind: 'host', host: 'db.internal', port: 5432 },
    auth: { method: 'password', user: 'user', password: REF },
    profileOptions: { defaultDatabase: 'app' },
    password: 'p@ss:word',
  },
  {
    uri: 'jdbc:postgresql://localhost:5432/test?user=fred&password=secret&ssl=true',
    endpoint: { kind: 'host', host: 'localhost', port: 5432 },
    auth: { method: 'password', user: 'fred', password: REF },
    tls: { mode: 'verify-full' },
    profileOptions: { defaultDatabase: 'test' },
    password: 'secret',
  },
  {
    uri: 'postgres://u@h/db?sslmode=prefer',
    endpoint: { kind: 'host', host: 'h', port: 5432 },
    auth: { method: 'password', user: 'u' },
    tls: { mode: 'require' },
    profileOptions: { defaultDatabase: 'db' },
  },
  {
    uri: 'postgres://h/db?sslmode=disable&keepalives=0&client_encoding=UTF8',
    endpoint: { kind: 'host', host: 'h', port: 5432 },
    tls: { mode: 'disable' },
    profileOptions: { keepAlive: false, charset: 'UTF8', defaultDatabase: 'db' },
  },
  {
    // The key passphrase is a secret: dropped and reported, never stored.
    uri: 'postgres://u@h/db?sslkey=/keys/client.key&sslcert=/keys/client.crt&sslpassword=keypw',
    endpoint: { kind: 'host', host: 'h', port: 5432 },
    auth: { method: 'password', user: 'u' },
    tls: { keyPath: '/keys/client.key', certPath: '/keys/client.crt' },
    profileOptions: { defaultDatabase: 'db' },
    ignored: ['sslpassword'],
  },

  // MySQL and MariaDB.
  {
    uri: 'mysql://root:pw@127.0.0.1:3306/shop?charset=utf8mb4',
    name: '127.0.0.1/shop',
    engine: 'mysql',
    endpoint: { kind: 'host', host: '127.0.0.1', port: 3306 },
    auth: { method: 'password', user: 'root', password: REF },
    profileOptions: { charset: 'utf8mb4', defaultDatabase: 'shop' },
    password: 'pw',
  },
  {
    uri: 'mysql://root:pw@127.0.0.1/shop',
    options: { engine: 'mariadb' },
    engine: 'mariadb',
    endpoint: { kind: 'host', host: '127.0.0.1', port: 3306 },
    auth: { method: 'password', user: 'root', password: REF },
    profileOptions: { defaultDatabase: 'shop' },
    password: 'pw',
  },
  {
    uri: 'mysql://user:pscale_pw_abc@aws.connect.psdb.cloud/mydb?ssl={"rejectUnauthorized":true}',
    endpoint: { kind: 'host', host: 'aws.connect.psdb.cloud', port: 3306 },
    auth: { method: 'password', user: 'user', password: REF },
    tls: { mode: 'verify-full' },
    profileOptions: { defaultDatabase: 'mydb' },
    password: 'pscale_pw_abc',
  },
  {
    uri: 'mysql://u:p@h/db?ssl=%7B%22rejectUnauthorized%22%3Afalse%7D',
    endpoint: { kind: 'host', host: 'h', port: 3306 },
    auth: { method: 'password', user: 'u', password: REF },
    tls: { mode: 'require' },
    profileOptions: { defaultDatabase: 'db' },
    password: 'p',
  },
  {
    uri: 'mysql://user:pw@host/db?sslaccept=strict',
    endpoint: { kind: 'host', host: 'host', port: 3306 },
    auth: { method: 'password', user: 'user', password: REF },
    tls: { mode: 'verify-full' },
    profileOptions: { defaultDatabase: 'db' },
    password: 'pw',
  },
  {
    uri: 'mysql://user@localhost/db?socket=/var/run/mysqld/mysqld.sock',
    name: 'localhost/db',
    endpoint: { kind: 'socket', path: '/var/run/mysqld/mysqld.sock' },
    auth: { method: 'password', user: 'user' },
    profileOptions: { defaultDatabase: 'db' },
  },
  {
    uri: 'mysql://user@%2Ftmp%2Fmysql.sock/db',
    endpoint: { kind: 'socket', path: '/tmp/mysql.sock' },
    auth: { method: 'password', user: 'user' },
    profileOptions: { defaultDatabase: 'db' },
  },
  {
    uri: 'mysql://user@(/tmp/mysql.sock)/db',
    endpoint: { kind: 'socket', path: '/tmp/mysql.sock' },
    auth: { method: 'password', user: 'user' },
    profileOptions: { defaultDatabase: 'db' },
  },
  {
    uri: 'mariadb://maria:pw@db.example.com:3307/app?ssl-mode=REQUIRED',
    name: 'db.example.com:3307/app',
    engine: 'mariadb',
    endpoint: { kind: 'host', host: 'db.example.com', port: 3307 },
    auth: { method: 'password', user: 'maria', password: REF },
    tls: { mode: 'require' },
    profileOptions: { defaultDatabase: 'app' },
    password: 'pw',
  },
  {
    uri: 'mysql://u:p@h/db?ssl-mode=VERIFY_IDENTITY&ssl-ca=/etc/ssl/ca.pem',
    endpoint: { kind: 'host', host: 'h', port: 3306 },
    auth: { method: 'password', user: 'u', password: REF },
    tls: { mode: 'verify-full', caPath: '/etc/ssl/ca.pem' },
    profileOptions: { defaultDatabase: 'db' },
    password: 'p',
  },
  {
    uri: 'jdbc:mysql://h:3306/db?useSSL=false&serverTimezone=UTC',
    endpoint: { kind: 'host', host: 'h', port: 3306 },
    tls: { mode: 'disable' },
    profileOptions: { timeZone: 'UTC', defaultDatabase: 'db' },
  },
  {
    uri: 'mysql://u:p@h/db?connectTimeout=5000&timezone=Z',
    endpoint: { kind: 'host', host: 'h', port: 3306 },
    auth: { method: 'password', user: 'u', password: REF },
    profileOptions: { connectTimeoutMs: 5000, timeZone: 'Z', defaultDatabase: 'db' },
    password: 'p',
  },
  {
    uri: 'mysql://u:p@h1:3306,h2:3306/db',
    endpoint: { kind: 'uri', uri: 'mysql://u@h1:3306,h2:3306/db' },
    auth: { method: 'password', user: 'u', password: REF },
    profileOptions: { defaultDatabase: 'db' },
    password: 'p',
  },
  {
    uri: 'mysql://u:p@h/db?allowPublicKeyRetrieval=true',
    endpoint: { kind: 'uri', uri: 'mysql://u@h/db?allowPublicKeyRetrieval=true' },
    auth: { method: 'password', user: 'u', password: REF },
    profileOptions: { defaultDatabase: 'db' },
    password: 'p',
  },

  // MongoDB.
  {
    uri: 'mongodb://localhost:27017',
    name: 'localhost',
    engine: 'mongodb',
    endpoint: { kind: 'host', host: 'localhost', port: 27017 },
  },
  {
    uri: 'mongodb://user:pass@mongo1:27017,mongo2:27017,mongo3:27018/app?replicaSet=rs0',
    name: 'mongo1/app',
    endpoint: {
      kind: 'hosts',
      hosts: [
        { host: 'mongo1', port: 27017 },
        { host: 'mongo2', port: 27017 },
        { host: 'mongo3', port: 27018 },
      ],
      replicaSet: 'rs0',
    },
    auth: { method: 'password', user: 'user', password: REF },
    // A login without authSource authenticates against the database the URI names.
    profileOptions: { authSource: 'app', defaultDatabase: 'app' },
    password: 'pass',
  },
  {
    // authSource=admin is the default when the URI names no database: nothing is lost.
    uri: 'mongodb://user:pass@mongo1,mongo2/?replicaSet=rs0&authSource=admin',
    endpoint: {
      kind: 'hosts',
      hosts: [
        { host: 'mongo1', port: 27017 },
        { host: 'mongo2', port: 27017 },
      ],
      replicaSet: 'rs0',
    },
    auth: { method: 'password', user: 'user', password: REF },
    password: 'pass',
  },
  {
    // Users in admin, data in app: the profile's own default is admin.
    uri: 'mongodb://user:pass@mongo1:27017/app?authSource=admin',
    endpoint: { kind: 'host', host: 'mongo1', port: 27017 },
    auth: { method: 'password', user: 'user', password: REF },
    profileOptions: { authSource: 'admin', defaultDatabase: 'app' },
    password: 'pass',
  },
  {
    uri: 'mongodb://user:pass@mongo1/?authSource=accounts&readPreference=secondaryPreferred',
    endpoint: { kind: 'host', host: 'mongo1', port: 27017 },
    auth: { method: 'password', user: 'user', password: REF },
    profileOptions: { authSource: 'accounts', readPreference: 'secondaryPreferred' },
    password: 'pass',
  },
  {
    // An SRV record's TXT entry names the auth database; an explicit one still wins.
    uri: 'mongodb+srv://user:pass@cluster0.abcde.mongodb.net/shop?authSource=users',
    endpoint: { kind: 'srv', host: 'cluster0.abcde.mongodb.net' },
    auth: { method: 'password', user: 'user', password: REF },
    profileOptions: { authSource: 'users', defaultDatabase: 'shop' },
    password: 'pass',
  },
  {
    // A read preference the profile cannot hold stays in the URI.
    uri: 'mongodb://h/?readPreference=fastest',
    endpoint: { kind: 'uri', uri: 'mongodb://h/?readPreference=fastest' },
  },
  {
    // directConnection applies to one host; with a replica set it stays in the URI.
    uri: 'mongodb://a:1/?replicaSet=rs0&directConnection=false',
    endpoint: {
      kind: 'uri',
      uri: 'mongodb://a:1/?replicaSet=rs0&directConnection=false',
    },
  },
  {
    // A session token is taken out of authMechanismProperties; the rest is kept.
    uri: 'mongodb://h/?authMechanismProperties=SESSION_TOKEN%3Ax%2CSERVICE_NAME%3Amongo',
    endpoint: { kind: 'uri', uri: 'mongodb://h/?authMechanismProperties=SERVICE_NAME%3Amongo' },
    ignored: ['authMechanismProperties token'],
  },
  {
    uri: 'mongodb://h/?authMechanismProperties=SESSION_TOKEN:x',
    endpoint: { kind: 'host', host: 'h', port: 27017 },
    ignored: ['authMechanismProperties token'],
  },
  {
    uri: 'mongodb://h/?proxyHost=p&proxyPort=1080&proxyUsername=me&proxyPassword=hunter2',
    endpoint: { kind: 'uri', uri: 'mongodb://h/?proxyHost=p&proxyPort=1080&proxyUsername=me' },
    ignored: ['proxyPassword'],
  },
  {
    uri: 'mongodb+srv://user:pass@cluster0.abcde.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0',
    name: 'cluster0.abcde.mongodb.net',
    endpoint: { kind: 'srv', host: 'cluster0.abcde.mongodb.net' },
    auth: { method: 'password', user: 'user', password: REF },
    profileOptions: { applicationName: 'Cluster0' },
    password: 'pass',
  },
  {
    uri: 'mongodb://[::1]:27017/?directConnection=true',
    endpoint: { kind: 'host', host: '::1', port: 27017 },
    profileOptions: { directConnection: true },
  },
  {
    uri: 'mongodb://u:p@h/?tls=true&tlsCAFile=/ca.pem&tlsAllowInvalidHostnames=true',
    endpoint: { kind: 'host', host: 'h', port: 27017 },
    auth: { method: 'password', user: 'u', password: REF },
    tls: { mode: 'verify-ca', caPath: '/ca.pem' },
    password: 'p',
  },
  {
    uri: 'mongodb://h/?ssl=false&connectTimeoutMS=2000&maxIdleTimeMS=60000',
    endpoint: { kind: 'host', host: 'h', port: 27017 },
    tls: { mode: 'disable' },
    profileOptions: { connectTimeoutMs: 2000, idleTimeoutMs: 60_000 },
  },
  {
    uri: 'mongodb://CN%3Dclient@h/?authMechanism=MONGODB-X509&tls=true&tlsCertificateKeyFile=/client.pem',
    endpoint: { kind: 'host', host: 'h', port: 27017 },
    auth: { method: 'clientCertificate', user: 'CN=client' },
    tls: { mode: 'verify-full', certPath: '/client.pem', keyPath: '/client.pem' },
  },
  {
    uri: 'mongodb://u:p@h/db?authMechanism=SCRAM-SHA-256',
    endpoint: { kind: 'host', host: 'h', port: 27017 },
    auth: { method: 'password', user: 'u', password: REF, mechanism: 'SCRAM-SHA-256' },
    profileOptions: { authSource: 'db', defaultDatabase: 'db' },
    password: 'p',
  },
  {
    uri: 'mongodb://%2Ftmp%2Fmongodb-27017.sock',
    endpoint: { kind: 'uri', uri: 'mongodb://%2Ftmp%2Fmongodb-27017.sock' },
  },

  // Redis.
  {
    uri: 'redis://localhost:6379',
    name: 'localhost',
    engine: 'redis',
    endpoint: { kind: 'host', host: 'localhost', port: 6379 },
    tls: { mode: 'disable' },
  },
  {
    uri: 'redis://:secret@redis.example.com:6380/2',
    name: 'redis.example.com:6380/2',
    endpoint: { kind: 'host', host: 'redis.example.com', port: 6380 },
    auth: { method: 'password', password: REF },
    tls: { mode: 'disable' },
    profileOptions: { defaultDatabase: '2' },
    password: 'secret',
  },
  {
    uri: 'rediss://default:secret@redis-12345.c1.us-east-1-2.ec2.cloud.redislabs.com:12345',
    endpoint: {
      kind: 'host',
      host: 'redis-12345.c1.us-east-1-2.ec2.cloud.redislabs.com',
      port: 12345,
    },
    auth: { method: 'password', user: 'default', password: REF },
    tls: { mode: 'verify-full' },
    password: 'secret',
  },
  {
    uri: 'rediss://default:AXXXabc123@usw1-sharp-cat-12345.upstash.io:6379',
    endpoint: { kind: 'host', host: 'usw1-sharp-cat-12345.upstash.io', port: 6379 },
    auth: { method: 'password', user: 'default', password: REF },
    tls: { mode: 'verify-full' },
    password: 'AXXXabc123',
  },
  {
    uri: 'redis://alice@localhost/0',
    endpoint: { kind: 'host', host: 'localhost', port: 6379 },
    auth: { method: 'password', user: 'alice' },
    tls: { mode: 'disable' },
    profileOptions: { defaultDatabase: '0' },
  },
  {
    uri: 'redis+sentinel://:pw@s1:26379,s2:26380/mymaster/1',
    name: 'mymaster',
    endpoint: {
      kind: 'sentinel',
      sentinels: [
        { host: 's1', port: 26379 },
        { host: 's2', port: 26380 },
      ],
      masterName: 'mymaster',
    },
    auth: { method: 'password', password: REF },
    tls: { mode: 'disable' },
    profileOptions: { defaultDatabase: '1' },
    password: 'pw',
  },
  {
    uri: 'unix:///var/run/redis/redis.sock?db=3',
    endpoint: { kind: 'socket', path: '/var/run/redis/redis.sock' },
    tls: { mode: 'disable' },
    profileOptions: { defaultDatabase: '3' },
  },
  {
    uri: 'redis://h1:7000,h2:7001',
    endpoint: { kind: 'uri', uri: 'redis://h1:7000,h2:7001' },
    tls: { mode: 'disable' },
  },
  {
    uri: 'rediss://h:6380/0?ssl_cert_reqs=none',
    endpoint: { kind: 'host', host: 'h', port: 6380 },
    tls: { mode: 'require' },
    profileOptions: { defaultDatabase: '0' },
  },

  // Elasticsearch: http(s):// URLs need no engine option.
  {
    uri: 'https://elastic:changeme@localhost:9200',
    options: { engine: 'elasticsearch' },
    name: 'localhost',
    engine: 'elasticsearch',
    endpoint: { kind: 'urls', urls: ['https://localhost:9200'] },
    auth: { method: 'password', user: 'elastic', password: REF },
    tls: { mode: 'verify-full' },
    password: 'changeme',
  },
  {
    uri: 'http://admin:s3cret!@localhost:9200',
    options: { name: 'Local Elasticsearch' },
    name: 'Local Elasticsearch',
    engine: 'elasticsearch',
    endpoint: { kind: 'urls', urls: ['http://localhost:9200'] },
    auth: { method: 'password', user: 'admin', password: REF },
    tls: { mode: 'disable' },
    password: 's3cret!',
  },
  {
    uri: 'https://my-deployment.es.us-central1.gcp.cloud.es.io',
    options: { engine: 'elasticsearch' },
    endpoint: { kind: 'urls', urls: ['https://my-deployment.es.us-central1.gcp.cloud.es.io'] },
    tls: { mode: 'verify-full' },
  },
  {
    uri: 'https://search.example.com/es/?pretty=true',
    options: { engine: 'elasticsearch' },
    endpoint: { kind: 'urls', urls: ['https://search.example.com/es/'] },
    tls: { mode: 'verify-full' },
    ignored: ['pretty'],
  },
  {
    uri: 'http://[::1]:9200,[::2]:9200',
    endpoint: { kind: 'urls', urls: ['http://[::1]:9200', 'http://[::2]:9200'] },
    tls: { mode: 'disable' },
  },
];

describe('parseConnectionUri', () => {
  for (const testCase of CASES) {
    it(`parses ${testCase.uri}`, () => {
      const result = parseConnectionUri(testCase.uri, testCase.options);
      const { profile } = result;
      expect(profile.endpoint).toEqual(testCase.endpoint);
      expect(profile.auth).toEqual(testCase.auth);
      expect(profile.tls).toEqual(testCase.tls);
      expect(profile.options).toEqual(testCase.profileOptions);
      if (testCase.name) expect(profile.name).toBe(testCase.name);
      if (testCase.engine) expect(profile.engine).toBe(testCase.engine);
      expect(result.password).toBe(testCase.password);
      expect(result.ignoredParams).toEqual(testCase.ignored ?? []);

      // The password never travels inside the profile or the result's serialised forms.
      if (testCase.password) {
        for (const text of [JSON.stringify(result), inspect(result, { depth: 10 })]) {
          expect(text).not.toContain(`:${testCase.password}@`);
          expect(text).not.toContain(`"${testCase.password}"`);
        }
        expect({ ...result }).not.toHaveProperty('password');
      }
    });
  }

  it('produces drafts the profile repository accepts, with the password stored under its ref', () => {
    const store = memoryStore();
    const { profile, password } = parseConnectionUri(
      'postgresql://app:s3cret@db.example.com:5433/app?sslmode=verify-full',
    );
    const saved = store.profiles.save(profile);
    const [ref] = secretRefsOf(saved);
    if (!ref || password === undefined) throw new Error('expected a password ref');
    store.secrets.set(ref, password);
    expect(store.secrets.resolve(saved)).toMatchObject({ missing: [] });
    expect(store.secrets.resolve(saved).secrets[ref.id]).toBe('s3cret');
    expect(store.db.get('SELECT data FROM profiles')?.['data']).not.toContain('s3cret');
  });

  const ERRORS: [string, ParseConnectionUriOptions | undefined, RegExp][] = [
    ['', undefined, /must start with a scheme/],
    ['localhost:5432', undefined, /must start with a scheme/],
    ['ftp://files.example.com', undefined, /scheme "ftp" is not supported/],
    ['http://localhost:9200', { engine: 'postgres' }, /cannot describe a PostgreSQL server/],
    ['postgres://h/db', { engine: 'mysql' }, /cannot describe a MySQL server/],
    ['postgres://u:hunter2@h:99999/db', undefined, /port/],
    ['postgres://user:hunt/er2@host/db', undefined, /port/],
    ['postgres://u:%zzhunter2@h/db', undefined, /percent-encoding/],
    ['postgres://u:hunter2@[::1/db', undefined, /closing bracket/],
    ['postgres://u:hunter2@h/db?sslmode=bogus', undefined, /SSL mode/],
    ['mongodb+srv://u:hunter2@h1,h2/', undefined, /exactly one host/],
    ['mongodb+srv://u:hunter2@cluster.example.com:27017/', undefined, /no port/],
    ['mongodb:///db', undefined, /at least one host/],
    ['redis://u:hunter2@h/abc', undefined, /must be a number/],
    ['redis+sentinel://s1:26379', undefined, /master name/],
    ['https://', { engine: 'elasticsearch' }, /needs a host/],
  ];
  for (const [uri, options, message] of ERRORS) {
    it(`rejects ${JSON.stringify(uri)} without echoing it`, () => {
      const error = thrown(() => parseConnectionUri(uri, options));
      expect(error).toMatchObject({
        code: 'VALIDATION_FAILED',
        message: expect.stringMatching(message),
      });
      const text = `${String(error)} ${JSON.stringify(error)} ${inspect(error)}`;
      expect(text).not.toContain('hunter2');
      expect(text).not.toContain('er2');
    });
  }
});
