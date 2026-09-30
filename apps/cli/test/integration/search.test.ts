import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * The BUILT binary against the Elasticsearch test server (spec §11): `test`
 * step by step (and a wrong password failing at the Auth step without echoing it), `query`
 * running console requests that create an index, bulk-index and search documents (a 64-bit
 * number printed exactly), JSON lines output, and the write rules (read-only refuses, a delete
 * needs --yes). Gated on JOINERY_TEST_ELASTICSEARCH_URL; each run uses its own index, deleted
 * afterwards.
 */

const BIN = fileURLToPath(new URL('../../dist/joinery.mjs', import.meta.url));

const ES_URL = process.env['JOINERY_TEST_ELASTICSEARCH_URL'];
/** The configured server, for describe.each: none without JOINERY_TEST_ELASTICSEARCH_URL. */
const SERVERS: readonly { readonly url: string }[] = ES_URL ? [{ url: ES_URL }] : [];

let workDir = '';

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
        JOINERY_STORE: join(workDir, 'joinery.db'),
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

/** Deletes an index directly (by name), whatever the CLI did. */
async function dropIndex(url: string, index: string): Promise<void> {
  const parsed = new URL(url);
  const headers: Record<string, string> = {};
  if (parsed.username) {
    const user = decodeURIComponent(parsed.username);
    const password = decodeURIComponent(parsed.password);
    headers['authorization'] = `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;
  }
  await fetch(`${parsed.protocol}//${parsed.host}/${index}`, { method: 'DELETE', headers }).catch(
    () => undefined,
  );
}

const indices: { url: string; index: string }[] = [];

beforeAll(() => {
  if (SERVERS.length === 0) return;
  if (!existsSync(BIN)) {
    throw new Error(`${BIN} is missing: run "pnpm --filter @joinery/cli build" first`);
  }
  workDir = mkdtempSync(join(tmpdir(), 'joinery-cli-search-'));
});

afterAll(async () => {
  await Promise.all(indices.map(({ url, index }) => dropIndex(url, index)));
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

describe.skipIf(SERVERS.length === 0).each(SERVERS)('joinery-cli with Elasticsearch', (server) => {
  const index = `joinery-cli-${randomBytes(4).toString('hex')}`;
  indices.push({ url: server.url, index });

  it('tests the URL step by step', async () => {
    const result = await joinery(['test', server.url]);
    expect(result.code, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toMatch(/✓ Auth/);
    expect(result.stdout).toMatch(new RegExp(`✓ Version\\s+Elasticsearch \\d+\\.\\d+`));
    expect(result.stdout).toContain('Connection OK.');
    const password = new URL(server.url).password;
    if (password) expect(result.stdout + result.stderr).not.toContain(password);
    const json = await joinery(['test', server.url, '--json']);
    expect(JSON.parse(json.stdout)).toMatchObject({ engine: 'elasticsearch', ok: true });
  });

  it('creates an index, indexes and searches documents', async () => {
    const created = await joinery([
      'query',
      server.url,
      '-e',
      [
        `PUT /${index}`,
        '{"settings": {"number_of_replicas": 0}, "mappings": {"properties": {"n": {"type": "long"}}}}',
        '',
        `POST /${index}/_bulk?refresh=true`,
        '{"index": {"_id": "1"}}',
        '{"title": "hello world", "n": 1234567890123456789}',
        '{"index": {"_id": "2"}}',
        '{"title": "goodbye", "n": 2}',
      ].join('\n'),
    ]);
    expect(created.code, created.stderr).toBe(0);
    expect(created.stderr).toContain(`[1] PUT /${index} · 200 OK`);
    expect(created.stdout).toContain('"acknowledged": true');

    const searched = await joinery([
      'query',
      server.url,
      '--format',
      'jsonl',
      '-e',
      `GET /${index}/_search\n{"query": {"match": {"title": "hello"}}}`,
    ]);
    expect(searched.code, searched.stderr).toBe(0);
    const line = JSON.parse(searched.stdout.trim()) as {
      request: string;
      status: number;
      body: { hits: { total: { value: number } } };
    };
    expect(line).toMatchObject({ request: `GET /${index}/_search`, status: 200 });
    expect(line.body.hits.total.value).toBe(1);
    // The raw line keeps the 64-bit number exactly.
    expect(searched.stdout).toContain('"n":1234567890123456789');
  });

  it('applies the write rules and reports server errors', async () => {
    const readOnly = await joinery([
      'query',
      server.url,
      '--read-only',
      '-e',
      `POST /${index}/_doc\n{"n": 3}`,
    ]);
    expect(readOnly.code).toBe(2);
    expect(readOnly.stderr).toContain('is read-only');

    const unconfirmed = await joinery(['query', server.url, '-e', `DELETE /${index}`]);
    expect(unconfirmed.code).toBe(2);
    expect(unconfirmed.stderr).toContain('needs confirmation');

    const missing = await joinery(['query', server.url, '-e', `GET /${index}-missing/_search`]);
    expect(missing.code).toBe(2);
    expect(missing.stderr).toContain('404 Not Found: index_not_found_exception');

    const deleted = await joinery([
      'query',
      server.url,
      '--yes',
      '-e',
      `DELETE /${index}\n\nHEAD /${index}`,
    ]);
    expect(deleted.stderr).toContain(`[2] HEAD /${index} · 404 Not Found`);
  });
});

describe.skipIf(!ES_URL || !new URL(ES_URL).username)(
  'joinery-cli with Elasticsearch security',
  () => {
    it('fails at the Auth step with a wrong password, without echoing it', async () => {
      const server = SERVERS[0]!;
      const url = new URL(server.url);
      url.password = 'not-the-Password-42';
      const result = await joinery(['test', url.toString()]);
      expect(result.code).toBe(1);
      expect(result.stdout).toMatch(/✗ Auth/);
      expect(result.stdout).toContain('Connection failed at the Auth step.');
      expect(result.stdout + result.stderr).not.toContain('not-the-Password-42');
      const query = await joinery(['query', url.toString(), '-e', 'GET /']);
      expect(query.code).toBe(2);
      expect(query.stderr + query.stdout).not.toContain('not-the-Password-42');
    });
  },
);
