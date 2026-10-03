import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { defineConfig } from '@playwright/test';

/**
 * The footage recorder for the website's videos (see director.ts). Separate from the end-to-end
 * suite and the screenshot harness: only `*.clips.ts` files run, one at a time, against the
 * website's demo databases.
 */
export default defineConfig({
  testDir: '.',
  testMatch: '*.clips.ts',
  timeout: 300_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  outputDir: join(tmpdir(), 'querybara-clips-results'),
  reporter: [['list']],
});
