import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { defineConfig } from '@playwright/test';

/**
 * End-to-end tests drive the built Electron app (spec §20) through Playwright's Electron
 * support. They need a display (run under xvfb-run on Linux CI) and a PostgreSQL server named by
 * QUERYBARA_TEST_POSTGRES_URL; without it every test is skipped.
 */
export default defineConfig({
  testDir: '.',
  testMatch: '*.spec.ts',
  timeout: 120_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  outputDir: process.env['QUERYBARA_E2E_OUTPUT'] ?? join(tmpdir(), 'querybara-e2e-results'),
  reporter: [['list']],
});
