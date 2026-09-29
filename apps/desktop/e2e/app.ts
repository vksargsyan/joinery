import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';

export interface LaunchedApp {
  readonly app: ElectronApplication;
  readonly page: Page;
  close(): Promise<void>;
}

/**
 * Launches the built app (`out/`) with a throwaway user data directory, so every run starts with
 * an empty local store.
 */
export async function launchApp(): Promise<LaunchedApp> {
  const userData = mkdtempSync(join(tmpdir(), 'joinery-e2e-'));
  const args = [resolve(import.meta.dirname, '..')];
  // Chromium refuses to start its sandbox as root (e.g. in a CI or dev container). Only then,
  // and only from this launcher, is --no-sandbox passed; the app itself always runs sandboxed.
  if (process.getuid?.() === 0 || process.env['JOINERY_E2E_NO_SANDBOX'] === '1') {
    args.push('--no-sandbox');
  }
  const { ELECTRON_RENDERER_URL: _devServer, ...env } = process.env;
  const app = await electron.launch({
    args,
    env: { ...env, JOINERY_USER_DATA_DIR: userData },
  });
  const page = await app.firstWindow();
  return {
    app,
    page,
    async close() {
      await app.close();
      rmSync(userData, { recursive: true, force: true });
    },
  };
}
