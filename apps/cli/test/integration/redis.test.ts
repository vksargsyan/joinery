import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { connectionProfileSchema } from '@joinery/core';
import { createPassphraseSealer, openStore } from '@joinery/storage';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startSshServer, type TestSshServer } from '../ssh-server';

/**
 * The BUILT binary against the Redis test server (spec §10): `test` for URIs and profiles,
 * directly and through an SSH tunnel; `query` running redis-cli command lines with redis-cli
 * output (JSON with --format json); the write rules; commands that would take over the
 * connection refused; and the SQL-only commands refusing a Redis target. Gated on
 * JOINERY_TEST_REDIS_URL; keys live under a random prefix, deleted afterwards.
 */

const BIN = fileURLToPath(new URL('../../dist/joinery.mjs', import.meta.url));
const REDIS_URL = process.env['JOINERY_TEST_REDIS_URL'];
const PREFIX = `joinery:cli:${randomBytes(4).toString('hex')}:`;
const SSH_USER = 'tunnel';
const SSH_PASSWORD = 'it-Redis-Bastion-7e2';
const PASSPHRASE = 'it-redis-store';

let workDir = '';
let storePath = '';
let ssh: TestSshServer | undefined;

interface Result {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function joinery(args: readonly string[], env: Record<string, string> = {}): Promise<Result> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, ...args], {
      env: {
        PATH: process.env['PATH'] ?? '',
        HOME: workDir,
        JOINERY_STORE: storePath,
        NO_COLOR: '1',
        ...env,
      },
      cwd: workDir,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.stdin.end();
    child.on('error', reject);
    child.on('close', (code) =>
      resolve({
        code,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      }),
    );
  });
}

const query = (commands: string, ...extra: string[]) =>
  joinery(['query', REDIS_URL!, ...extra, '-e', commands]);

beforeAll(async () => {
  if (!REDIS_URL) return;
  if (!existsSync(BIN)) {
    throw new Error(`${BIN} is missing: run "pnpm --filter @joinery/cli build" first`);
  }
  workDir = mkdtempSync(join(tmpdir(), 'joinery-cli-redis-'));
  storePath = join(workDir, 'joinery.db');
  ssh = await startSshServer({ user: SSH_USER, password: SSH_PASSWORD });
});

afterAll(async () => {
  if (REDIS_URL && workDir) {
    const keys = ['str', 'h', 'list', 'ro', 'prod'].map((k) => `${PREFIX}${k}`).join(' ');
    await query(`DEL ${keys}`, '--yes', '-q');
  }
  await ssh?.close();
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

describe.skipIf(!REDIS_URL)('joinery-cli with Redis', () => {
  it('tests a Redis URI step by step', async () => {
    const result = await joinery(['test', REDIS_URL!]);
    expect(result.code, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toMatch(/✓ Auth/);
    expect(result.stdout).toMatch(/✓ Version\s+(Redis|Valkey) \d+\.\d+/);
    expect(result.stdout).toContain('Connection OK.');
    expect(result.stdout + result.stderr).not.toContain(new URL(REDIS_URL!).password);
    const json = await joinery(['test', REDIS_URL!, '--json']);
    expect(JSON.parse(json.stdout)).toMatchObject({ engine: 'redis', ok: true });
  });

  it('tests and queries through an SSH tunnel', async () => {
    const hop = ['--ssh', `${SSH_USER}@127.0.0.1:${ssh!.port}`, '--ssh-accept-new'];
    const env = { JOINERY_SSH_PASSWORD: SSH_PASSWORD };
    const tested = await joinery(['test', REDIS_URL!, ...hop], env);
    expect(tested.code, tested.stdout + tested.stderr).toBe(0);
    expect(tested.stdout).toMatch(
      new RegExp(`✓ SSH\\s+SSH ${SSH_USER}@127\\.0\\.0\\.1:${ssh!.port} → `),
    );
    expect(tested.stdout).toMatch(/✓ Ping/);
    expect(tested.stdout + tested.stderr).not.toContain(SSH_PASSWORD);
    const forwards = ssh!.stats.forwards;
    const pinged = await joinery(['query', REDIS_URL!, ...hop, '-e', 'PING'], env);
    expect(pinged.code, pinged.stderr).toBe(0);
    expect(pinged.stdout).toBe('PONG\n');
    expect(ssh!.stats.forwards).toBeGreaterThan(forwards);
  });

  it('runs command lines and prints redis-cli output', async () => {
    const result = await query(
      [
        `SET ${PREFIX}str "hello world"`,
        `GET ${PREFIX}str`,
        `HSET ${PREFIX}h name Ada lang en`,
        `HGETALL ${PREFIX}h`,
        `RPUSH ${PREFIX}list "\\xff" b`,
        `LRANGE ${PREFIX}list 0 -1`,
        `GET ${PREFIX}missing`,
      ].join('\n'),
    );
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toBe(
      [
        'OK',
        '"hello world"',
        '(integer) 2',
        '1) "name"\n2) "Ada"\n3) "lang"\n4) "en"',
        '(integer) 2',
        '1) "\\xff"\n2) "b"',
        '(nil)',
        '',
      ].join('\n'),
    );
    expect(result.stderr).toMatch(/\[1\] SET/);
    expect(result.stderr).toMatch(/\[7\] GET/);

    const json = await query(`HGETALL ${PREFIX}h\nLLEN ${PREFIX}list`, '--format', 'json');
    expect(json.code, json.stderr).toBe(0);
    expect(JSON.parse(json.stdout)).toEqual([['name', 'Ada', 'lang', 'en'], 2]);
    const lines = await query('PING', '--format', 'jsonl');
    expect(lines.stdout).toBe('"PONG"\n');

    const file = join(workDir, 'commands.redis');
    writeFileSync(file, `GET ${PREFIX}str\nSTRLEN ${PREFIX}str\n`);
    const fromFile = await joinery(['query', REDIS_URL!, '-f', file]);
    expect(fromFile.stdout).toBe('"hello world"\n(integer) 11\n');
  });

  it('reports server errors and refuses commands that would take over the connection', async () => {
    const wrong = await query(`INCR ${PREFIX}str`);
    expect(wrong.code).toBe(2);
    expect(wrong.stderr).toContain('not an integer');
    const subscribe = await query('SUBSCRIBE news');
    expect(subscribe.code).toBe(2);
    expect(subscribe.stderr).toContain('would turn this connection into a subscriber');
    expect(subscribe.stderr).toContain('Pub/Sub');
    const quotes = await query('GET "unterminated');
    expect(quotes.code).toBe(2);
    expect(quotes.stderr).toContain('Invalid argument');
    const csv = await query('PING', '--format', 'csv');
    expect(csv.code).toBe(2);
    expect(csv.stderr).toContain('not CSV');
  });

  it('applies the write rules', async () => {
    const readOnly = await query(`SET ${PREFIX}ro x`, '--read-only');
    expect(readOnly.code).toBe(2);
    expect(readOnly.stderr).toContain('writes, but');
    expect(readOnly.stderr).toContain('--read-only');
    const reads = await query(`EXISTS ${PREFIX}ro`, '--read-only');
    expect(reads.stdout).toBe('(integer) 0\n');
    const unconfirmed = await query(`DEL ${PREFIX}str`);
    expect(unconfirmed.code).toBe(2);
    expect(unconfirmed.stderr).toContain('needs confirmation: DEL deletes keys');
    const kept = await query(`EXISTS ${PREFIX}str`);
    expect(kept.stdout).toBe('(integer) 1\n');
    const confirmed = await query(`DEL ${PREFIX}str`, '--yes');
    expect(confirmed.stdout).toBe('(integer) 1\n');
  });

  it('uses saved Redis profiles, and SQL-only commands refuse them', async () => {
    const parsed = new URL(REDIS_URL!);
    const store = openStore(storePath, { sealer: createPassphraseSealer(PASSPHRASE) });
    try {
      const now = new Date().toISOString();
      store.profiles.save(
        connectionProfileSchema.parse({
          id: 'redis-profile',
          name: 'cache-redis',
          engine: 'redis',
          endpoint: { kind: 'host', host: parsed.hostname, port: Number(parsed.port) },
          auth: {
            method: 'password',
            ...(parsed.username ? { user: decodeURIComponent(parsed.username) } : {}),
            password: { id: 'redis-password', policy: 'save' },
          },
          tls: { mode: 'disable' },
          options: { defaultDatabase: '0' },
          presentation: { environment: 'production' },
          createdAt: now,
          updatedAt: now,
        }),
        { expectedVersion: 0 },
      );
      store.secrets.set(
        { id: 'redis-password', policy: 'save' },
        decodeURIComponent(parsed.password),
      );
    } finally {
      store.close();
    }
    const env = { JOINERY_PASSPHRASE: PASSPHRASE };
    const tested = await joinery(['test', 'cache-redis'], env);
    expect(tested.code, tested.stdout + tested.stderr).toBe(0);
    const read = await joinery(['query', 'cache-redis', '-e', 'PING'], env);
    expect(read.stdout).toBe('PONG\n');
    // Production: every write asks, so without a terminal it needs --yes.
    const write = await joinery(['query', 'cache-redis', '-e', `SET ${PREFIX}prod 1`], env);
    expect(write.code).toBe(2);
    expect(write.stderr).toContain('production connection');
    // --database picks another logical database for the run.
    const other = await joinery(
      ['query', 'cache-redis', '--database', '1', '--format', 'json', '-e', 'CLIENT INFO'],
      env,
    );
    expect(other.code, other.stderr).toBe(0);
    expect(other.stdout).toMatch(/ db=1 /);

    const sqlOnly: string[][] = [
      ['compare', 'cache-redis', REDIS_URL!],
      ['ddl', REDIS_URL!],
      ['run-file', REDIS_URL!, join(workDir, 'commands.redis')],
    ];
    for (const args of sqlOnly) {
      const refused = await joinery(args, env);
      expect(refused.code, `${args[0]}: ${refused.stderr}`).toBe(2);
      expect(refused.stderr, args[0]).toContain(
        'is a Redis connection; this command works with PostgreSQL, MySQL and MariaDB',
      );
    }
  });
});
