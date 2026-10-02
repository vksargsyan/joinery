import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { defineConfig } from '@playwright/test';

/**
 * The screenshot harness for the website (see harness.ts). Separate from the end-to-end suite:
 * only `*.shots.ts` files run, one at a time, against the website's demo databases.
 */
export default defineConfig({
  testDir: '.',
  testMatch: '*.shots.ts',
  timeout: 300_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  outputDir: join(tmpdir(), 'joinery-shots-results'),
  reporter: [['list']],
});
