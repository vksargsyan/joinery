import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * The sandboxed renderer imports this package, so its sources may import only the `bson`
 * package (browser-safe), @joinery/core and each other: no Node built-ins, no `mongodb`.
 */

const SRC = fileURLToPath(new URL('../src', import.meta.url));

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sources(path) : path.endsWith('.ts') ? [path] : [];
  });
}

describe('renderer safety', () => {
  it('imports nothing but bson, @joinery/core and its own modules', () => {
    const imports = sources(SRC).flatMap((file) =>
      [...readFileSync(file, 'utf8').matchAll(/from '([^']+)'/g)].map((m) => m[1]!),
    );
    const external = [...new Set(imports.filter((spec) => !spec.startsWith('.')))].sort();
    expect(external).toEqual(['@joinery/core', 'bson']);
  });

  it('never evaluates text', () => {
    for (const file of sources(SRC)) {
      const text = readFileSync(file, 'utf8');
      expect(text).not.toMatch(/\beval\s*\(|new Function\s*\(/);
    }
  });
});
