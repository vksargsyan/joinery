import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  _electron as electron,
  type ElectronApplication,
  type Locator,
  type Page,
} from '@playwright/test';

export interface LaunchedApp {
  readonly app: ElectronApplication;
  readonly page: Page;
  close(): Promise<void>;
}

/**
 * Launches the built app (`out/`) with a throwaway user data directory, so every run starts with
 * an empty local store. With `userData`, it uses (and keeps) that directory instead, so a test
 * can relaunch the app on the same store, after a crash for instance. `args` are extra Chromium
 * switches (the screenshot harness passes `--force-device-scale-factor`).
 */
export async function launchApp(
  options: { readonly userData?: string; readonly args?: readonly string[] } = {},
): Promise<LaunchedApp> {
  const userData = options.userData ?? mkdtempSync(join(tmpdir(), 'querybara-e2e-'));
  // QUERYBARA_E2E_APP_DIR runs another build of the app (one built with --outDir next to a
  // package.json), e.g. while `pnpm dev` holds out/.
  const args = [
    process.env['QUERYBARA_E2E_APP_DIR'] ?? resolve(import.meta.dirname, '..'),
    ...(options.args ?? []),
  ];
  // Chromium refuses to start its sandbox as root (e.g. in a CI or dev container). Only then,
  // and only from this launcher, is --no-sandbox passed; the app itself always runs sandboxed.
  if (process.getuid?.() === 0 || process.env['QUERYBARA_E2E_NO_SANDBOX'] === '1') {
    args.push('--no-sandbox');
  }
  const { ELECTRON_RENDERER_URL: _devServer, ...env } = process.env;
  const app = await electron.launch({
    args,
    env: { ...env, QUERYBARA_USER_DATA_DIR: userData },
  });
  const page = await app.firstWindow();
  return {
    app,
    page,
    async close() {
      await app.close();
      if (options.userData === undefined) rmSync(userData, { recursive: true, force: true });
    },
  };
}

/** Opens the new connection dialog from the side bar's actions menu. */
export async function openNewConnection(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Connection actions' }).click();
  await page.getByRole('menuitem', { name: 'New connection' }).click();
}

/** On the new connection dialog's first step, picks the engine and goes on to the form. */
export async function chooseEngine(dialog: Locator, engine: string): Promise<void> {
  await dialog.getByRole('radio', { name: engine, exact: true }).dblclick();
}

/** Opens a tab of the connection dialog's form (General, Advanced, TLS, SSH, Proxy). */
export async function connectionTab(dialog: Locator, tab: string): Promise<void> {
  await dialog.getByRole('tab', { name: new RegExp(`^${tab}`) }).click();
}
