import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { defineConfig } from '@playwright/test';

/**
 * The smoke test of a packaged build (electron-builder output), kept apart from the e2e suite,
 * which drives `out/` through Playwright's Electron launcher. QUERYBARA_PACKAGED_APP names the
 * packaged executable; without it the test is skipped.
 */
export default defineConfig({
  testDir: 'packaged',
  testMatch: '*.packaged.ts',
  timeout: 180_000,
  expect: { timeout: 30_000 },
  workers: 1,
  retries: 0,
  outputDir: process.env['QUERYBARA_E2E_OUTPUT'] ?? join(tmpdir(), 'querybara-packaged-results'),
  reporter: [['list']],
});
