import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { MONGODB_OPTIONAL_PEERS } from '../electron.vite.config';

/**
 * The main build keeps the MongoDB driver's optional peers external. Bundled, Vite replaces a
 * missing one with a module that throws as the driver's chunk loads in a development build, so
 * `pnpm dev` could not open any MongoDB connection ("Could not resolve "kerberos" imported by
 * "mongodb""). The list must follow the driver: every optional module lib/deps.js requires,
 * except socks, which the app ships for SOCKS proxies and tunnels.
 */

describe('the main build', () => {
  it('keeps every optional module of the MongoDB driver external', () => {
    const driver = createRequire(
      resolve(import.meta.dirname, '../../../packages/drivers/mongodb/package.json'),
    );
    const deps = readFileSync(join(dirname(driver.resolve('mongodb')), 'deps.js'), 'utf8');
    const optional = [...deps.matchAll(/require\('([^'.][^']*)'\)/g)]
      .map((m) => m[1]!)
      .filter((name) => name !== 'socks');
    expect(optional.length).toBeGreaterThan(0);
    expect([...MONGODB_OPTIONAL_PEERS].sort()).toEqual([...new Set(optional)].sort());
  });
});
