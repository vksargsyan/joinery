import { inspect } from 'node:util';

import { describe, expect, it } from 'vitest';

import { matchPgpass, parsePgpass } from '../src';

const FILE = [
  '# hostname:port:database:username:password',
  'db.example.com:5432:app:app_user:s3cret',
  'db.example.com:5432:*:admin:adm\\:in\\\\pw',
  '',
  '*:*:reporting:*:report-pw',
  'weird\\:host:6543:my\\*db:user:pw:with:colons',
  'localhost:5432:*:postgres:local-pw',
  'too:few:fields',
  '\\*:5432:literalstar:u:star-pw',
  'db.example.com:5432:app:app_user:shadowed',
  'trailing:5432:db:u:ends-with-backslash\\',
].join('\r\n');

describe('parsePgpass', () => {
  const entries = parsePgpass(FILE);

  it('parses fields, escapes and wildcards, skipping comments and short lines', () => {
    expect(
      entries.map(({ host, port, database, user, line }) => ({ host, port, database, user, line })),
    ).toEqual([
      { host: 'db.example.com', port: '5432', database: 'app', user: 'app_user', line: 2 },
      { host: 'db.example.com', port: '5432', database: null, user: 'admin', line: 3 },
      { host: null, port: null, database: 'reporting', user: null, line: 5 },
      { host: 'weird:host', port: '6543', database: 'my*db', user: 'user', line: 6 },
      { host: 'localhost', port: '5432', database: null, user: 'postgres', line: 7 },
      { host: '*', port: '5432', database: 'literalstar', user: 'u', line: 9 },
      { host: 'db.example.com', port: '5432', database: 'app', user: 'app_user', line: 10 },
      { host: 'trailing', port: '5432', database: 'db', user: 'u', line: 11 },
    ]);
    expect(entries.map((entry) => entry.password)).toEqual([
      's3cret',
      'adm:in\\pw',
      'report-pw',
      'pw',
      'local-pw',
      'star-pw',
      'shadowed',
      'ends-with-backslash\\',
    ]);
  });

  it('keeps passwords out of JSON and inspect output', () => {
    const [first] = entries;
    expect(JSON.stringify(entries)).not.toContain('s3cret');
    expect(inspect(first)).not.toContain('s3cret');
    expect(first?.password).toBe('s3cret');
  });
});

describe('matchPgpass', () => {
  const entries = parsePgpass(FILE);
  const password = (target: Parameters<typeof matchPgpass>[1]) =>
    matchPgpass(entries, target)?.password;

  it('returns the first matching line, as libpq does', () => {
    expect(
      password({ host: 'db.example.com', port: 5432, database: 'app', user: 'app_user' }),
    ).toBe('s3cret');
    expect(password({ host: 'db.example.com', database: 'other', user: 'admin' })).toBe(
      'adm:in\\pw',
    );
    expect(password({ host: 'anything', port: '7777', database: 'reporting', user: 'x' })).toBe(
      'report-pw',
    );
    expect(password({ host: 'weird:host', port: 6543, database: 'my*db', user: 'user' })).toBe(
      'pw',
    );
  });

  it('treats an escaped star as a literal', () => {
    expect(password({ host: '*', database: 'literalstar', user: 'u' })).toBe('star-pw');
    expect(password({ host: 'elsewhere', database: 'literalstar', user: 'u' })).toBeUndefined();
  });

  it('defaults to localhost:5432 and matches default socket directories as localhost', () => {
    expect(password({ database: 'app', user: 'postgres' })).toBe('local-pw');
    expect(password({ host: '/var/run/postgresql', database: 'app', user: 'postgres' })).toBe(
      'local-pw',
    );
    expect(password({ host: '/srv/pg', database: 'app', user: 'postgres' })).toBeUndefined();
    expect(password({ port: 5433, database: 'app', user: 'postgres' })).toBeUndefined();
  });

  it('returns undefined when nothing matches', () => {
    expect(matchPgpass([], { database: 'x', user: 'y' })).toBeUndefined();
    expect(password({ host: 'db.example.com', database: 'app', user: 'nobody' })).toBeUndefined();
  });
});
