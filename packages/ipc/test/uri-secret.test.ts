import { describe, expect, it } from 'vitest';

import { uriCarriesSecret } from '../src';

describe('uriCarriesSecret', () => {
  it('finds a password in the user info, however many hosts the URI names', () => {
    for (const uri of [
      'postgresql://app:hunter2@db:5432/app',
      'jdbc:postgresql://app:hunter2@db/app',
      '  mysql://root:@db/app',
      'mongodb://app:hunter2@h1:27017,h2:27017/app?replicaSet=rs0',
      'mongodb://app:hunter2@[::1]:27017,[fe80::1%25eth0]:27018/?authSource=admin',
      'mongodb+srv://app:hunter2@cluster0.example.net/app',
      'mongodb://app:hun@ter2@h1,h2/app',
      'mongodb://ap@p:hunter2@h1/app',
      'redis://:hunter2@cache:6379/0',
      'rediss://default:hunter2@cache:6380',
      'redis+sentinel://:hunter2@s1:26379,s2:26379/mymaster',
      'https://elastic:hunter2@es2:9200',
    ]) {
      expect(uriCarriesSecret(uri), uri).toBe(true);
    }
  });

  it('finds secret-named query parameters, MongoDB and MariaDB ones included', () => {
    for (const uri of [
      'postgresql://db/app?sslmode=require&password=hunter2',
      'postgresql://db/app?sslpassword=x',
      'mariadb://app@db/app?password2=x',
      'redis://cache:6379/0?password=hunter2',
      'mongodb://h/?tlsCertificateKeyFilePassword=x',
      'mongodb://h/?ssl=true&sslPEMKeyPassword=x',
      'mongodb://h/?proxyHost=p&proxyUsername=me&proxyPassword=x',
      'mongodb://h/?authMechanism=MONGODB-AWS&authMechanismProperties=AWS_SESSION_TOKEN:x',
      'mongodb://h/?authMechanismProperties=AWS_SESSION_TOKEN%3Ax',
      'mongodb://h/?pass%77ord=x',
      'https://es:9200/?api_key=x',
      'https://es:9200/?access_token=x',
      'https://es:9200/?client_secret=x',
      'jdbc:sqlserver://db;user=sa;password=x',
    ]) {
      expect(uriCarriesSecret(uri), uri).toBe(true);
    }
  });

  it('leaves URIs without secrets alone', () => {
    for (const uri of [
      'postgresql://app@db:5432/app',
      'postgresql://db/app?passfile=/home/me/.pgpass&sslkey=/k.pem',
      'postgresql://app@db:5432/my@db',
      'mongodb://h1:27017,h2:27017/app?replicaSet=rs0',
      'mongodb://app@[::1]:27017/app?authSource=admin&readPreference=secondary',
      'mongodb+srv://app@cluster0.example.net/?tlsCertificateKeyFile=/c.pem&proxyUsername=me',
      'mongodb://h/?authMechanism=MONGODB-OIDC&authMechanismProperties=ENVIRONMENT:azure',
      'redis://app@cache:6379/2',
      'redis://cache:6379/0?x=a:b@c',
      'rediss://cache:6380',
      'redis+sentinel://s1:26379,s2:26379/mymaster',
      'unix:///var/run/redis.sock?db=2',
      'https://es1:9200',
      'not a uri',
    ]) {
      expect(uriCarriesSecret(uri), uri).toBe(false);
    }
  });
});
