import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { connectionProfileSchema } from '@querybara/core';
import { createPassphraseSealer, openStore } from '@querybara/storage';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startSshServer, type TestSshServer } from '../ssh-server';

/**
 * The BUILT binary against the MongoDB replica set (spec §9): `test` for URIs and profiles,
 * directly and through an SSH tunnel; `query` running command documents with relaxed Extended
 * JSON output (canonical with --format json); the write rules; and the SQL-only commands
 * refusing a MongoDB target. Gated on QUERYBARA_TEST_MONGODB_URL; every run uses its own database
 * and drops it afterwards.
 */

const BIN = fileURLToPath(new URL('../../dist/querybara.mjs', import.meta.url));
const MONGO_URL = process.env['QUERYBARA_TEST_MONGODB_URL'];
const DB = `querybara_cli_${randomBytes(4).toString('hex')}`;
const SSH_USER = 'tunnel';
const SSH_PASSWORD = 'it-Mongo-Bastion-4c1';
const PASSPHRASE = 'it-mongo-store';

let workDir = '';
let storePath = '';
let ssh: TestSshServer | undefined;

interface Result {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function querybara(args: readonly string[], env: Record<string, string> = {}): Promise<Result> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, ...args], {
      env: {
        PATH: process.env['PATH'] ?? '',
        HOME: workDir,
        QUERYBARA_STORE: storePath,
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

/** The replica set URL with TLS off (the test server speaks plain TCP). */
function url(): string {
  const parsed = new URL(MONGO_URL!);
  parsed.searchParams.set('tls', 'false');
  return parsed.toString();
}

/** One host of the replica set, connected to directly (what a tunnel forwards). */
function singleHostUrl(): string {
  const parsed = new URL(MONGO_URL!);
  parsed.searchParams.delete('replicaSet');
  parsed.searchParams.set('directConnection', 'true');
  parsed.searchParams.set('tls', 'false');
  return parsed.toString();
}

const query = (command: string, ...extra: string[]) =>
  querybara(['query', url(), '--database', DB, ...extra, '-e', command]);

beforeAll(async () => {
  if (!MONGO_URL) return;
  if (!existsSync(BIN)) {
    throw new Error(`${BIN} is missing: run "pnpm --filter @querybara/cli build" first`);
  }
  workDir = mkdtempSync(join(tmpdir(), 'querybara-cli-mongo-'));
  storePath = join(workDir, 'querybara.db');
  ssh = await startSshServer({ user: SSH_USER, password: SSH_PASSWORD });
});

afterAll(async () => {
  if (MONGO_URL && workDir) await query('{ dropDatabase: 1 }', '--yes', '-q');
  await ssh?.close();
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

describe.skipIf(!MONGO_URL)('querybara-cli with MongoDB', () => {
  it('tests a MongoDB URI step by step', async () => {
    const result = await querybara(['test', url()]);
    expect(result.code, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toMatch(/✓ Auth/);
    expect(result.stdout).toMatch(/✓ Version\s+MongoDB \d+\.\d+/);
    expect(result.stdout).toContain('replica set rs0');
    expect(result.stdout).toContain('Connection OK.');
    const json = await querybara(['test', url(), '--json']);
    expect(JSON.parse(json.stdout)).toMatchObject({ engine: 'mongodb', ok: true });
  });

  it('tests through an SSH tunnel to a single host', async () => {
    const result = await querybara(
      ['test', singleHostUrl(), '--ssh', `${SSH_USER}@127.0.0.1:${ssh!.port}`, '--ssh-accept-new'],
      { QUERYBARA_SSH_PASSWORD: SSH_PASSWORD },
    );
    expect(result.code, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toMatch(/✓ TCP\s+Connected to the SSH server 127\.0\.0\.1:\d+/);
    expect(result.stdout).toMatch(
      new RegExp(`✓ SSH\\s+SSH ${SSH_USER}@127\\.0\\.0\\.1:${ssh!.port} → `),
    );
    expect(result.stdout).toMatch(/✓ Ping/);
    expect(result.stdout + result.stderr).not.toContain(SSH_PASSWORD);
    const queried = await querybara(
      [
        'query',
        singleHostUrl(),
        '--ssh',
        `${SSH_USER}@127.0.0.1:${ssh!.port}`,
        '-e',
        '{ ping: 1 }',
      ],
      { QUERYBARA_SSH_PASSWORD: SSH_PASSWORD },
    );
    expect(queried.code, queried.stderr).toBe(0);
    expect(queried.stdout).toContain('"ok": 1');
  });

  it('tests and queries the replica set through an SSH tunnel, every member through it', async () => {
    const hop = ['--ssh', `${SSH_USER}@127.0.0.1:${ssh!.port}`, '--ssh-accept-new'];
    const env = { QUERYBARA_SSH_PASSWORD: SSH_PASSWORD };
    const tested = await querybara(['test', url(), ...hop], env);
    expect(tested.code, tested.stdout + tested.stderr).toBe(0);
    expect(tested.stdout).toMatch(
      new RegExp(
        `✓ SSH\\s+SSH ${SSH_USER}@127\\.0\\.0\\.1:${ssh!.port} → .*every server through the tunnel`,
      ),
    );
    expect(tested.stdout).toContain('replica set rs0');
    const forwards = ssh!.stats.forwards;
    const queried = await querybara(['query', url(), ...hop, '-e', '{ hello: 1 }'], env);
    expect(queried.code, queried.stderr).toBe(0);
    expect(queried.stdout).toContain('"setName": "rs0"');
    expect(ssh!.stats.forwards).toBeGreaterThan(forwards);
    expect(tested.stdout + tested.stderr + queried.stderr).not.toContain(SSH_PASSWORD);
  });

  it('runs command documents and prints relaxed or canonical Extended JSON', async () => {
    const inserted = await query(
      '{ insert: "orders", documents: [{ _id: 1, total: 120, at: ISODate("2026-01-01T00:00:00Z") }, { _id: 2, total: 80.5 }, { _id: 3, total: NumberLong(300) }] }',
    );
    expect(inserted.code, inserted.stderr).toBe(0);
    expect(inserted.stderr).toContain('3 documents affected');

    const found = await query(
      '{ find: "orders", filter: { total: { $gt: 100 } }, sort: { _id: 1 } }',
    );
    expect(found.code, found.stderr).toBe(0);
    expect(found.stdout).toBe(
      '{\n  "_id": 1,\n  "total": 120,\n  "at": {\n    "$date": "2026-01-01T00:00:00Z"\n  }\n}\n{\n  "_id": 3,\n  "total": 300\n}\n',
    );
    expect(found.stderr).toMatch(/find: 2 documents/);

    const canonical = await query('{ find: "orders", sort: { _id: 1 } }', '--format', 'json');
    expect(JSON.parse(canonical.stdout)).toEqual([
      {
        _id: { $numberInt: '1' },
        total: { $numberInt: '120' },
        at: { $date: { $numberLong: '1767225600000' } },
      },
      { _id: { $numberInt: '2' }, total: { $numberDouble: '80.5' } },
      { _id: { $numberInt: '3' }, total: { $numberLong: '300' } },
    ]);
    const lines = await query('{ find: "orders" }', '--format', 'jsonl', '--row-limit', '2');
    expect(lines.stdout.trim().split('\n')).toHaveLength(2);
    expect(lines.stderr).toContain('row limit 2 reached');

    const file = join(workDir, 'commands.json');
    writeFileSync(file, '[{ count: "orders" }, { distinct: "orders", key: "_id" }]');
    const both = await querybara(['query', url(), '--database', DB, '-f', file]);
    expect(both.code, both.stderr).toBe(0);
    expect(both.stderr).toMatch(/\[1\] count/);
    expect(both.stderr).toMatch(/\[2\] distinct/);
  });

  it('applies the write rules', async () => {
    const readOnly = await query('{ insert: "orders", documents: [{ _id: 9 }] }', '--read-only');
    expect(readOnly.code).toBe(2);
    expect(readOnly.stderr).toContain('writes, but');
    expect(readOnly.stderr).toContain('--read-only');
    const unconfirmed = await query('{ delete: "orders", deletes: [{ q: {}, limit: 0 }] }');
    expect(unconfirmed.code).toBe(2);
    expect(unconfirmed.stderr).toContain('needs confirmation');
    const counted = await query('{ count: "orders" }');
    expect(counted.stdout).toContain('"n": 3');
    const syntax = await query('{ find: "orders", filter: { total: { $gt: } } }');
    expect(syntax.code).toBe(2);
    expect(syntax.stderr).toMatch(/line 1, column \d+/);
    const csv = await query('{ find: "orders" }', '--format', 'csv');
    expect(csv.code).toBe(2);
    expect(csv.stderr).toContain('Extended JSON');
  });

  it('uses saved MongoDB profiles, and SQL-only commands refuse them', async () => {
    const parsed = new URL(MONGO_URL!);
    const store = openStore(storePath, { sealer: createPassphraseSealer(PASSPHRASE) });
    try {
      const now = new Date().toISOString();
      store.profiles.save(
        connectionProfileSchema.parse({
          id: 'mongo-profile',
          name: 'orders-mongo',
          engine: 'mongodb',
          endpoint: { kind: 'host', host: parsed.hostname, port: Number(parsed.port) },
          auth: {
            method: 'password',
            user: decodeURIComponent(parsed.username),
            password: { id: 'mongo-password', policy: 'save' },
          },
          tls: { mode: 'disable' },
          options: { authSource: 'admin', directConnection: true, defaultDatabase: DB },
          presentation: { environment: 'production' },
          createdAt: now,
          updatedAt: now,
        }),
        { expectedVersion: 0 },
      );
      store.secrets.set(
        { id: 'mongo-password', policy: 'save' },
        decodeURIComponent(parsed.password),
      );
    } finally {
      store.close();
    }
    const env = { QUERYBARA_PASSPHRASE: PASSPHRASE };
    const tested = await querybara(['test', 'orders-mongo'], env);
    expect(tested.code, tested.stdout + tested.stderr).toBe(0);
    const counted = await querybara(['query', 'orders-mongo', '-e', '{ count: "orders" }'], env);
    expect(counted.stdout).toContain('"n": 3');
    // Production: every write asks, so without a terminal it needs --yes.
    const write = await querybara(
      ['query', 'orders-mongo', '-e', '{ insert: "orders", documents: [{ _id: 10 }] }'],
      env,
    );
    expect(write.code).toBe(2);
    expect(write.stderr).toContain('production connection');

    const sqlOnly: string[][] = [
      ['compare', 'orders-mongo', url()],
      ['data-compare', url(), 'orders-mongo', '--table', 'orders'],
      ['ddl', url()],
      ['import', url(), '--table', 'orders', '--file', join(workDir, 'commands.json')],
      ['export', url(), '--table', 'orders', '--format', 'csv', '--out', join(workDir, 'out.csv')],
      ['run-file', url(), join(workDir, 'commands.json')],
    ];
    for (const args of sqlOnly) {
      const refused = await querybara(args, env);
      expect(refused.code, `${args[0]}: ${refused.stderr}`).toBe(2);
      expect(refused.stderr, args[0]).toContain(
        'is a MongoDB connection; this command works with PostgreSQL, MySQL and MariaDB',
      );
    }
  });
});
