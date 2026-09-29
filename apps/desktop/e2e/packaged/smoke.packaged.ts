import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { chromium, expect, test, type Browser, type Page } from '@playwright/test';

/**
 * A smoke test of the packaged app. Its fuses turn off the Node inspector that Playwright's
 * Electron launcher attaches to, so the app is started directly and driven through the
 * renderer's DevTools port. It checks that the window loads from app.asar and that a connection
 * host starts from inside the archive; with JOINERY_TEST_POSTGRES_URL it also runs a query.
 *
 *   JOINERY_PACKAGED_APP=dist/linux-unpacked/joinery playwright test -c e2e/packaged.config.ts
 */

const EXECUTABLE = process.env['JOINERY_PACKAGED_APP'];
const PG_URL = process.env['JOINERY_TEST_POSTGRES_URL'];

test.skip(!EXECUTABLE, 'Set JOINERY_PACKAGED_APP to the packaged executable');

let child: ChildProcess | undefined;
let browser: Browser | undefined;
let userData: string | undefined;

test.afterAll(async () => {
  await browser?.close();
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = new Promise((resolve) => child?.once('exit', resolve));
    child.kill();
    await exited;
  }
  if (userData) rmSync(userData, { recursive: true, force: true });
});

/** Starts the packaged app with a throwaway user data directory and returns its window. */
async function launch(executable: string): Promise<Page> {
  userData = mkdtempSync(join(tmpdir(), 'joinery-packaged-'));
  const args = ['--remote-debugging-port=0'];
  // Chromium refuses to start its sandbox as root (a CI or dev container); see e2e/app.ts.
  if (process.getuid?.() === 0 || process.env['JOINERY_E2E_NO_SANDBOX'] === '1') {
    args.push('--no-sandbox');
  }
  const app = spawn(executable, args, {
    env: { ...process.env, JOINERY_USER_DATA_DIR: userData },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child = app;
  const endpoint = await new Promise<string>((resolve, reject) => {
    let output = '';
    const timer = setTimeout(
      () => reject(new Error(`No DevTools endpoint within 60 s:\n${output}`)),
      60_000,
    );
    const onData = (chunk: Buffer): void => {
      output += chunk.toString();
      const match = /DevTools listening on (ws:\/\/\S+)/.exec(output);
      if (match?.[1]) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    };
    app.stdout.on('data', onData);
    app.stderr.on('data', onData);
    app.once('exit', (code, signal) => {
      clearTimeout(timer);
      reject(new Error(`The app exited (${code ?? signal}) before it was ready:\n${output}`));
    });
  });
  browser = await chromium.connectOverCDP(endpoint);
  const context = browser.contexts()[0];
  if (!context) throw new Error('The app has no browser context');
  const page = context.pages().find((open) => open.url().startsWith('app://'));
  return page ?? (await context.waitForEvent('page'));
}

test('starts, loads its window from the archive and runs a connection host', async () => {
  const page = await launch(EXECUTABLE!);

  await page.getByRole('button', { name: 'New connection' }).click();
  const dialog = page.getByRole('dialog', { name: 'New connection' });
  await expect(dialog).toBeVisible();
  // Without a test server, port 9 on the loopback address, where nothing listens.
  await dialog
    .getByLabel('Paste a URI to fill the form')
    .fill(PG_URL ?? 'postgres://smoke:smoke@127.0.0.1:9/smoke');
  await dialog.getByRole('button', { name: 'Fill from URI' }).click();
  await expect(dialog.getByText('Filled from the URI')).toBeVisible();
  await dialog.getByLabel('Name').fill('Smoke');
  await dialog.getByLabel('TLS').selectOption('disable');
  await dialog.getByLabel('Password storage').selectOption('session');
  await dialog.getByRole('button', { name: 'Test Connection' }).click();

  if (!PG_URL) {
    // A refused TCP step can only come from a connection host that started and ran the check.
    await expect(dialog.getByTestId('check-tcp')).toContainText('TCP connect');
    await expect(
      dialog.getByRole('region', { name: 'Connection test' }).getByRole('alert'),
    ).toBeVisible();
    return;
  }

  await expect(dialog.getByText('Connection succeeded')).toBeVisible();
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog).toBeHidden();
  const profile = page.getByRole('treeitem', { name: 'Smoke' });
  await profile.locator('[data-tree-row]').first().click();
  await expect(profile.getByText('Connected', { exact: true })).toBeAttached();
  await page.getByRole('button', { name: 'New query' }).click();
  const editor = page.getByTestId('sql-editor').last();
  await editor.click();
  await page.keyboard.type('select 6 * 7 as answer');
  await page.keyboard.press('ControlOrMeta+Enter');
  await expect(page.getByTestId('row-count')).toHaveText('1 row');
});
