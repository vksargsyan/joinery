import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/** The package runs in the sandboxed renderer: no Node built-ins, no Buffer, no process. */
describe('search-tools purity', () => {
  const dir = fileURLToPath(new URL('../src', import.meta.url));
  const files = (readdirSync(dir, { recursive: true }) as string[])
    .filter((f) => f.endsWith('.ts'))
    .map((f) => join(dir, f));

  it.each(files.map((f) => relative(dir, f)))('%s uses only browser-safe APIs', (file) => {
    const source = readFileSync(join(dir, file), 'utf8');
    expect(source).not.toMatch(/from ['"]node:/);
    expect(source).not.toMatch(/\bBuffer\b/);
    expect(source).not.toMatch(/\bprocess\./);
    expect(source).not.toMatch(/@elastic/);
  });
});
