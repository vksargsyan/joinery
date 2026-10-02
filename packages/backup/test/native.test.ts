import { readFileSync, statSync } from 'node:fs';

import { connectionProfileSchema, type ResolvedProfile } from '@joinery/core';
import { describe, expect, it } from 'vitest';

import {
  chooseTool,
  nativeEndpoint,
  optionValue,
  parseToolVersion,
  pgPassLine,
  type NativeTool,
} from '../src';
import { withoutUnknownSettings } from '../src/native/pg-script';
import { mysqlOptionFile, pgEnvironment, privateFolder } from '../src/native/run';

/**
 * The native tools without running them: version parsing, which tool fits a server, and the
 * credential handling (files with owner-only permissions, never the command line).
 */

const NOW = '2026-09-29T00:00:00.000Z';

function resolved(overrides: object = {}, secrets: Record<string, string> = {}): ResolvedProfile {
  return {
    profile: connectionProfileSchema.parse({
      id: 'p',
      name: 'Prod',
      engine: 'postgres',
      endpoint: { kind: 'host', host: 'db.example.com', port: 5432 },
      auth: { method: 'password', user: 'app', password: { id: 'pw' } },
      // A remote server with verified TLS (a new profile's default is TLS off).
      tls: { mode: 'verify-full' },
      createdAt: NOW,
      updatedAt: NOW,
      ...overrides,
    }),
    secrets: { pw: 'se:cr\\et"pass\nword', ...secrets },
  };
}

function tool(name: NativeTool['name'], family: NativeTool['family'], version: string): NativeTool {
  const [major, minor] = version.split('.').map(Number);
  return { name, path: `/usr/bin/${name}`, family, version, major: major!, minor: minor! };
}

describe('parseToolVersion', () => {
  it('reads PostgreSQL, MySQL and MariaDB version banners', () => {
    expect(
      parseToolVersion('pg_dump', 'pg_dump (PostgreSQL) 16.13 (Ubuntu 16.13-0ubuntu0.24.04.1)'),
    ).toEqual({
      family: 'postgres',
      version: '16.13',
      major: 16,
      minor: 13,
    });
    expect(parseToolVersion('psql', 'psql (PostgreSQL) 17beta1')?.major).toBe(17);
    expect(
      parseToolVersion(
        'mysqldump',
        'mysqldump  Ver 10.19 Distrib 10.11.14-MariaDB, for debian-linux-gnu (x86_64)',
      ),
    ).toMatchObject({ family: 'mariadb', version: '10.11.14', major: 10, minor: 11 });
    expect(
      parseToolVersion(
        'mariadb-dump',
        'mariadb-dump from 11.4.3-MariaDB, client 10.19 for linux-systemd (x86_64)',
      ),
    ).toMatchObject({ family: 'mariadb', version: '11.4.3' });
    expect(
      parseToolVersion(
        'mysqldump',
        'mysqldump  Ver 8.4.11 for Linux on x86_64 (MySQL Community Server - GPL)',
      ),
    ).toMatchObject({ family: 'mysql', version: '8.4.11', major: 8 });
    expect(parseToolVersion('mysql', 'garbage')).toBeUndefined();
  });
});

describe('chooseTool', () => {
  const tools = [
    tool('pg_dump', 'postgres', '14.2'),
    tool('pg_dump', 'postgres', '17.1'),
    tool('psql', 'postgres', '15.0'),
    tool('mysqldump', 'mariadb', '10.11.14'),
    tool('mysql', 'mariadb', '10.11.14'),
  ];

  it('needs a pg_dump at least as new as the server', () => {
    expect(chooseTool(tools, 'dump', 'postgres', '16.4').tool?.version).toBe('17.1');
    const old = chooseTool([tools[0]!], 'dump', 'postgres', '16.4');
    expect(old.tool).toBeUndefined();
    expect(old.reason).toMatch(/older than the server/);
    expect(chooseTool(tools, 'restore-archive', 'postgres', '16.4').reason).toMatch(
      /pg_restore was not found/,
    );
  });

  it('prefers the server family for MySQL and warns across families', () => {
    expect(chooseTool(tools, 'dump', 'mariadb', '11.4.3-MariaDB').warnings).toEqual([]);
    const cross = chooseTool(tools, 'restore-script', 'mysql', '8.4.11');
    expect(cross.tool?.name).toBe('mysql');
    expect(cross.warnings[0]).toMatch(/MariaDB 10.11.14 with a MySQL server/);
  });
});

describe('credentials', () => {
  it('escapes the password for libpq password files and MySQL option files', () => {
    expect(pgPassLine('a:b\\c')).toBe('*:*:*:*:a\\:b\\\\c\n');
    expect(optionValue('p"a\\ss\nx')).toBe('"p\\"a\\\\ss\\nx"');
  });

  it('writes PostgreSQL credentials to a private file, not the environment', async () => {
    const folder = await privateFolder();
    try {
      const endpoint = nativeEndpoint(resolved(), 'shop');
      const env = await pgEnvironment(endpoint, folder.path);
      expect(env['PGPASSWORD']).toBeUndefined();
      expect(Object.values(env).join('\n')).not.toContain('se:cr');
      expect(env['PGHOST']).toBe('db.example.com');
      expect(env['PGSSLMODE']).toBe('verify-full');
      const file = env['PGPASSFILE']!;
      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(statSync(folder.path).mode & 0o077).toBe(0);
      expect(readFileSync(file, 'utf8')).toBe(pgPassLine('se:cr\\et"pass\nword'));
    } finally {
      await folder.dispose();
    }
  });

  it('keeps TLS host checks on the real name through a tunnel', async () => {
    const tunnelled = { ...resolved(), endpointOverride: { host: '127.0.0.1', port: 40001 } };
    const endpoint = nativeEndpoint(tunnelled, 'shop');
    expect(endpoint).toMatchObject({
      host: 'db.example.com',
      hostAddress: '127.0.0.1',
      port: 40001,
    });
    const folder = await privateFolder();
    try {
      const env = await pgEnvironment(endpoint, folder.path);
      expect(env['PGHOST']).toBe('db.example.com');
      expect(env['PGHOSTADDR']).toBe('127.0.0.1');
      const arg = await mysqlOptionFile(tool('mysqldump', 'mysql', '8.4.1'), endpoint, folder.path);
      expect(arg).toMatch(/^--defaults-extra-file=/);
      const content = readFileSync(arg.slice('--defaults-extra-file='.length), 'utf8');
      expect(content).toContain('host="127.0.0.1"');
      expect(content).toContain('ssl-mode=VERIFY_CA');
      expect(content).toContain('password="se:cr\\\\et\\"pass\\nword"');
    } finally {
      await folder.dispose();
    }
  });

  it('writes the MariaDB client TLS options in its own dialect', async () => {
    const folder = await privateFolder();
    try {
      const plain = nativeEndpoint(resolved({ tls: { mode: 'disable' } }), 'shop');
      const arg = await mysqlOptionFile(tool('mariadb', 'mariadb', '11.4.3'), plain, folder.path);
      const content = readFileSync(arg.slice('--defaults-extra-file='.length), 'utf8');
      expect(content).toContain('skip-ssl');
      expect(content).not.toContain('ssl-mode');
    } finally {
      await folder.dispose();
    }
  });

  it('refuses client keys with a passphrase', () => {
    expect(() =>
      nativeEndpoint(
        resolved({ tls: { mode: 'verify-full', keyPath: '/k', keyPassphrase: { id: 'kp' } } }),
        'x',
      ),
    ).toThrow(/passphrase/);
  });
});

describe('withoutUnknownSettings', () => {
  async function filter(
    text: string,
    known: string[],
  ): Promise<{ out: string; skipped: string[] }> {
    const skipped: string[] = [];
    let out = '';
    const source = (async function* () {
      // Split awkwardly to cross line boundaries.
      for (let at = 0; at < text.length; at += 7) yield Buffer.from(text.slice(at, at + 7));
    })();
    for await (const chunk of withoutUnknownSettings(source, new Set(known), (s) =>
      skipped.push(s),
    )) {
      out += Buffer.from(chunk).toString('utf8');
    }
    return { out, skipped };
  }

  it('drops SET lines for settings the server lacks, outside COPY data', async () => {
    const script = [
      'SET statement_timeout = 0;',
      'SET transaction_timeout = 0;',
      "SET client_encoding = 'UTF8';",
      'COPY t (a) FROM stdin;',
      'SET transaction_timeout = 0;',
      '\\.',
      'SELECT 1;',
    ].join('\n');
    const { out, skipped } = await filter(script, ['statement_timeout', 'client_encoding']);
    expect(skipped).toEqual(['transaction_timeout']);
    expect(out).toBe(
      [
        'SET statement_timeout = 0;',
        "SET client_encoding = 'UTF8';",
        'COPY t (a) FROM stdin;',
        'SET transaction_timeout = 0;',
        '\\.',
        'SELECT 1;',
      ].join('\n'),
    );
  });
});
