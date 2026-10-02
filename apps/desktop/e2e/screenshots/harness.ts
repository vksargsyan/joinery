import { existsSync, mkdirSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { expect, type Page } from '@playwright/test';

import { connectionTab, launchApp, openNewConnection, type LaunchedApp } from '../app';

/**
 * The screenshot harness for the Joinery website (docs/website-spec.md §6). Every scene is
 * captured from the real app at 1440×900 and 2× scale, once per theme: the app's theme setting is
 * "system" and the harness switches the emulated colour scheme, which the app follows live.
 *
 * The scenes run against the website's demo databases (joinery-website/scripts/demo-up.sh);
 * JOINERY_E2E_SHOTS names the output folder (`<folder>/dark/<id>.png`, `<folder>/light/<id>.png`).
 */

export const SHOTS = process.env['JOINERY_E2E_SHOTS'];

/** The demo CA (joinery-website/scripts/demo-up.sh); every demo server presents a cert from it. */
export const DEMO_CA = process.env['JOINERY_DEMO_CA'] ?? '/tmp/larchwood-demo/ca.pem';

export interface DemoProfile {
  /** The connection's name in the sidebar. */
  readonly name: string;
  readonly uri: string;
  /** Environment option value: dev, test, staging or production. */
  readonly environment: 'dev' | 'test' | 'staging' | 'production';
}

/**
 * The demo connections, one per server, named as a real team would. Host names resolve to
 * 127.0.0.1 through /etc/hosts (demo-up.sh) and match the demo certificate.
 */
export const DEMO = {
  postgres: {
    name: 'Larchwood',
    uri: 'postgres://postgres:demo@pg.larchwood.example:55432/larchwood',
    environment: 'staging',
  },
  /** The same database as a production profile, for the write-safety shots. */
  postgresProduction: {
    name: 'Production',
    uri: 'postgres://postgres:demo@pg.larchwood.example:55432/larchwood',
    environment: 'production',
  },
  postgresStaging: {
    name: 'Staging',
    uri: 'postgres://postgres:demo@pg.larchwood.example:55432/larchwood_staging',
    environment: 'test',
  },
  mysql: {
    name: 'EU store',
    uri: 'mysql://root:demo@mysql.larchwood.example:53306/shop_eu',
    environment: 'test',
  },
  mariadb: {
    name: 'EU MariaDB',
    uri: 'mariadb://root:demo@mariadb.larchwood.example:53307/shop_eu',
    environment: 'test',
  },
  mongodb: {
    name: 'Catalog',
    uri: 'mongodb://mongo.larchwood.example:57017/catalog?replicaSet=rs0&tls=true',
    environment: 'staging',
  },
  redis: {
    name: 'Sessions',
    uri: 'rediss://default:demo@redis.larchwood.example:56379/0',
    environment: 'staging',
  },
  redisCluster: {
    name: 'Carts',
    uri: 'rediss://default:demo@127.0.0.1:47100',
    environment: 'test',
  },
  elasticsearch: {
    name: 'Search',
    uri: 'https://elastic:demo-es@search.larchwood.example:59200',
    environment: 'staging',
  },
} as const satisfies Record<string, DemoProfile>;

export const WIDTH = 1440;
export const HEIGHT = 900;
export type Theme = 'dark' | 'light';

/** Launches the app on a fresh store whose theme setting is "system", sized for the shots. */
export async function launchForShots(): Promise<LaunchedApp> {
  const userData = mkdtempSync(join(tmpdir(), 'joinery-shots-'));
  // The first launch creates and migrates the store; the theme is then set before the real run.
  const first = await launchApp({ userData });
  await first.app.close();
  const db = new DatabaseSync(join(userData, 'joinery.db'));
  db.prepare(
    `INSERT INTO settings (key, value, version, updated_at) VALUES ('app', ?, 1, ?)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
  ).run(JSON.stringify({ theme: 'system' }), new Date().toISOString());
  db.close();

  const launched = await launchApp({ userData, args: ['--force-device-scale-factor=2'] });
  await launched.app.evaluate(
    ({ BrowserWindow }, size) => {
      const window = BrowserWindow.getAllWindows()[0];
      window?.unmaximize();
      window?.setContentSize(size.width, size.height);
      window?.center();
    },
    { width: WIDTH, height: HEIGHT },
  );
  await setTheme(launched.page, 'dark');
  await launched.page.waitForTimeout(500);
  return launched;
}

export async function setTheme(page: Page, theme: Theme): Promise<void> {
  await page.emulateMedia({ colorScheme: theme });
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
}

/**
 * Captures the window in both themes as `<id>.png`, then returns to dark. `settle` waits for
 * whatever the scene needs to finish drawing (grids, charts, layouts) after a theme switch.
 */
export async function capture(
  page: Page,
  id: string,
  settle: () => Promise<void> = () => page.waitForTimeout(600),
): Promise<void> {
  if (!SHOTS) return;
  await page.mouse.move(WIDTH - 2, HEIGHT - 2);
  for (const theme of ['dark', 'light'] as const) {
    await setTheme(page, theme);
    await settle();
    const dir = join(SHOTS, theme);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    await page.screenshot({ path: join(dir, `${id}.png`), animations: 'disabled', caret: 'hide' });
  }
  await setTheme(page, 'dark');
}

/**
 * Creates a demo connection through the New connection dialog: filled from its URI, TLS verified
 * against the demo CA, the password remembered for this session, the environment set. Returns
 * with the dialog closed and the profile in the side bar.
 */
export async function addConnection(page: Page, profile: DemoProfile): Promise<void> {
  await openNewConnection(page);
  const dialog = page.getByRole('dialog', { name: 'New connection' });
  await expect(dialog).toBeVisible();
  await fillConnection(page, profile);
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('treeitem', { name: profile.name })).toBeVisible();
}

/**
 * Fills the open New connection dialog for a demo profile, without saving: the URI on the first
 * step, then the General and TLS tabs of the form (ADR 0028).
 */
export async function fillConnection(page: Page, profile: DemoProfile): Promise<void> {
  const dialog = page.getByRole('dialog', { name: 'New connection' });
  await dialog.getByLabel('Paste a URI to fill the form').fill(profile.uri);
  await dialog.getByRole('button', { name: 'Fill from URI' }).click();
  await dialog.getByLabel('Name').fill(profile.name);
  await dialog.getByLabel('Environment').selectOption(profile.environment);
  const storage = dialog.getByLabel('Password storage');
  if (await storage.isVisible().catch(() => false)) await storage.selectOption('session');
  await connectionTab(dialog, 'TLS');
  await dialog.getByLabel('TLS mode').selectOption('verify-full');
  await dialog.locator('#cx-ca').fill(DEMO_CA);
  await connectionTab(dialog, 'General');
}

/** Connects a saved profile from the sidebar. */
export async function connectProfile(page: Page, name: string): Promise<void> {
  const profile = page.getByRole('treeitem', { name });
  // A double-click connects (ADR 0027), as in the end-to-end tests.
  await profile.locator('[data-tree-row]').first().dblclick();
  await expect(profile.getByText('Connected', { exact: true })).toBeAttached({ timeout: 30_000 });
}

/** Replaces the text of the last SQL editor. */
export async function typeInEditor(page: Page, text: string): Promise<void> {
  const editor = page.getByTestId('sql-editor').last();
  await editor.click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.press('Delete');
  await page.keyboard.insertText(text);
}
