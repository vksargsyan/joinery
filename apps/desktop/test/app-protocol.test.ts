import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import {
  APP_ENTRY_URL,
  createAppProtocolHandler,
  mimeTypeOf,
  resolveAppFile,
} from '../src/main/app-protocol';
import { isPortMessage, isPortPayload, toPortMessage } from '../src/shared/bridge';

const root = mkdtempSync(join(tmpdir(), 'querybara-protocol-'));
mkdirSync(join(root, 'assets'));
writeFileSync(join(root, 'index.html'), '<!doctype html><title>Querybara</title>');
writeFileSync(join(root, 'assets', 'index.js'), 'console.log(1)');
writeFileSync(join(root, 'secret.env'), 'TOKEN=1');

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('app:// protocol', () => {
  it('maps app URLs to files under the renderer root', () => {
    expect(resolveAppFile(root, APP_ENTRY_URL)).toBe(join(root, 'index.html'));
    expect(resolveAppFile(root, 'app://querybara/')).toBe(join(root, 'index.html'));
    expect(resolveAppFile(root, 'app://querybara/assets/index.js?v=2#x')).toBe(
      join(root, 'assets', 'index.js'),
    );
  });

  it('refuses other hosts, schemes, traversal and unknown file types', () => {
    for (const url of [
      'app://other/index.html',
      'https://querybara/index.html',
      'file:///etc/passwd',
      'app://querybara/../../etc/passwd',
      'app://querybara/%2e%2e/%2e%2e/etc/passwd',
      'app://querybara/assets/..%2f..%2fsecret.env',
      'app://querybara/assets%5c..%5c..%5cindex.html',
      'app://querybara/secret.env',
      'app://querybara/%00index.html',
      'app://querybara/%E0%A4%A',
    ]) {
      expect(resolveAppFile(root, url), url).toBeUndefined();
    }
  });

  it('serves files with the CSP header and 404s everything else', async () => {
    const handle = createAppProtocolHandler(root, "default-src 'none'");
    const ok = await handle(new Request(APP_ENTRY_URL));
    expect(ok.status).toBe(200);
    expect(ok.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(ok.headers.get('content-security-policy')).toBe("default-src 'none'");
    expect(ok.headers.get('x-content-type-options')).toBe('nosniff');
    expect(await ok.text()).toContain('<title>Querybara</title>');

    expect((await handle(new Request('app://querybara/missing.js'))).status).toBe(404);
    expect((await handle(new Request('app://querybara/secret.env'))).status).toBe(404);
    expect((await handle(new Request(APP_ENTRY_URL, { method: 'POST' }))).status).toBe(405);
    expect(mimeTypeOf('x.woff2')).toBe('font/woff2');
  });
});

describe('port messages between preload and page', () => {
  it('accepts only the exact shapes', () => {
    expect(isPortPayload({ kind: 'main' })).toBe(true);
    expect(isPortPayload({ kind: 'connection', connectionId: 'c1' })).toBe(true);
    for (const payload of [
      null,
      'main',
      { kind: 'main', extra: 1 },
      { kind: 'connection' },
      { kind: 'connection', connectionId: '' },
      { kind: 'connection', connectionId: 'x'.repeat(129) },
      { kind: 'connection', connectionId: 'c1', password: 'hunter2' },
      { kind: 'other' },
    ]) {
      expect(isPortPayload(payload), JSON.stringify(payload)).toBe(false);
    }
    expect(isPortMessage(toPortMessage({ kind: 'connection', connectionId: 'c1' }))).toBe(true);
    expect(isPortMessage({ kind: 'main' })).toBe(false);
    expect(isPortMessage({ querybara: 'port', kind: 'main', connectionId: 'c1' })).toBe(false);
  });
});
