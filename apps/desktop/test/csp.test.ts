import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { buildContentSecurityPolicy } from '../src/shared/csp';

function directives(policy: string): Map<string, string[]> {
  return new Map(
    policy.split(';').map((part) => {
      const [name, ...sources] = part.trim().split(/\s+/);
      return [name!, sources];
    }),
  );
}

/** Sources that name a network origin; none may be remote. */
function origins(policy: string): string[] {
  return [...directives(policy).values()]
    .flat()
    .filter((source) => !source.startsWith("'") && !/^(data|blob):$/.test(source));
}

describe('Content Security Policy (spec §18)', () => {
  const production = buildContentSecurityPolicy();

  it('starts from nothing and allows only the app itself', () => {
    const map = directives(production);
    expect(map.get('default-src')).toEqual(["'none'"]);
    expect(map.get('script-src')).toEqual(["'self'"]);
    expect(map.get('connect-src')).toEqual(["'self'"]);
    expect(map.get('object-src')).toEqual(["'none'"]);
    expect(map.get('base-uri')).toEqual(["'none'"]);
    expect(map.get('form-action')).toEqual(["'none'"]);
    expect(map.get('worker-src')).toEqual(["'self'", 'blob:']);
    expect(origins(production)).toEqual([]);
  });

  it('never allows eval, and inline code only for styles', () => {
    for (const policy of [
      production,
      buildContentSecurityPolicy({ header: true }),
      buildContentSecurityPolicy({
        devServerOrigin: 'http://localhost:5173',
        scriptHashes: ['sha256-abc='],
      }),
    ]) {
      expect(policy).not.toContain('unsafe-eval');
      expect(policy).not.toContain('wasm-unsafe-eval');
      for (const [name, sources] of directives(policy)) {
        if (name !== 'style-src') expect(sources, name).not.toContain("'unsafe-inline'");
      }
      expect(policy).not.toContain('*');
      expect(policy).not.toMatch(/https?:/);
    }
  });

  it('adds frame-ancestors only to the header form', () => {
    expect(directives(production).has('frame-ancestors')).toBe(false);
    expect(directives(buildContentSecurityPolicy({ header: true })).get('frame-ancestors')).toEqual(
      ["'none'"],
    );
  });

  it('in development allows the local dev server socket and hashed inline scripts only', () => {
    const dev = buildContentSecurityPolicy({
      devServerOrigin: 'http://localhost:5173',
      scriptHashes: ['sha256-preamble='],
    });
    const map = directives(dev);
    expect(map.get('connect-src')).toEqual(["'self'", 'ws://localhost:5173']);
    expect(map.get('script-src')).toEqual(["'self'", "'sha256-preamble='"]);
    expect(() =>
      buildContentSecurityPolicy({ devServerOrigin: 'http://evil.example:5173' }),
    ).toThrow(RangeError);
  });

  it('is written into index.html by the build', () => {
    const html = readFileSync(join(import.meta.dirname, '../src/renderer/index.html'), 'utf8');
    expect(html).toContain(
      '<meta http-equiv="Content-Security-Policy" content="%QUERYBARA_CSP%" />',
    );
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/);
    expect(html).not.toMatch(/https?:\/\//);
  });
});
