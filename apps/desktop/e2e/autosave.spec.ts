import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDatabase } from '@joinery/storage';
import { expect, test, type Page } from '@playwright/test';

import { launchApp, type LaunchedApp } from './app';

/**
 * Editor autosave and crash restore (spec §18) with a real store: a query tab's text is saved
 * within a few seconds of typing, comes back marked "restored" after the app is killed, comes
 * back after a clean quit too, and is gone for good once its tab is closed on purpose. The app
 * is relaunched on the same user data directory each time.
 */

const PG_URL = process.env['JOINERY_TEST_POSTGRES_URL'];
const NAME = 'E2E Autosave';

test.skip(!PG_URL, 'Set JOINERY_TEST_POSTGRES_URL to run the end-to-end tests');

test.describe.configure({ mode: 'serial' });

const userData = mkdtempSync(join(tmpdir(), 'joinery-e2e-autosave-'));
let launched: LaunchedApp | undefined;
let page: Page;

async function start(): Promise<void> {
  launched = await launchApp({ userData });
  page = launched.page;
}

/** What the store holds, read beside the running app (WAL allows it). */
function savedTexts(): string[] {
  const db = openDatabase(join(userData, 'joinery.db'));
  try {
    return db
      .all('SELECT text FROM editor_autosave ORDER BY position')
      .map((row) => String(row['text']));
  } finally {
    db.close();
  }
}

/** Kills the app's main process, as a crash or a power cut would. */
async function kill(): Promise<void> {
  const app = launched!.app;
  const exited = new Promise<void>((resolve) => app.process().once('exit', () => resolve()));
  app.process().kill('SIGKILL');
  await exited;
  launched = undefined;
}

async function typeInEditor(text: string): Promise<void> {
  const editor = page.getByTestId('sql-editor').filter({ visible: true });
  await editor.click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type(text);
  await page.keyboard.press('Escape');
}

test.beforeAll(async () => {
  await start();
});

test.afterAll(async () => {
  await launched?.close();
  rmSync(userData, { recursive: true, force: true });
});

test('saves a query tab a few seconds after typing', async () => {
  await page.getByRole('button', { name: 'New connection' }).click();
  const dialog = page.getByRole('dialog', { name: 'New connection' });
  await dialog.getByLabel('Paste a URI to fill the form').fill(PG_URL!);
  await dialog.getByRole('button', { name: 'Fill from URI' }).click();
  await expect(dialog.getByText('Filled from the URI')).toBeVisible();
  await dialog.getByLabel('Name').fill(NAME);
  await dialog.getByLabel('TLS').selectOption('disable');
  await dialog.getByLabel('Password storage').selectOption('session');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog).toBeHidden();
  const profile = page.getByRole('treeitem', { name: NAME });
  await profile.locator('[data-tree-row]').first().click();
  await expect(profile.getByText('Connected', { exact: true })).toBeAttached();
  await page.getByRole('button', { name: 'New query' }).click();
  await typeInEditor("select 'crash_survivor' as marker");
  await expect.poll(savedTexts, { timeout: 10_000 }).toEqual(["select 'crash_survivor' as marker"]);
});

test('restores the tab after the app is killed, marked as restored', async () => {
  await kill();
  await start();
  const panel = page.getByTestId('query-panel').filter({ visible: true });
  await expect(panel).toBeVisible();
  await expect(panel.getByTestId('sql-editor')).toContainText('crash_survivor');
  await expect(page.getByTestId('restored-marker')).toBeVisible();
  await expect(panel.getByTestId('restored-banner')).toContainText('closed unexpectedly');
  // Nothing ran: a restored tab does not connect or run by itself.
  await expect(panel.getByTestId('row-count')).toHaveCount(0);
  // The restored tab now owns the buffer; edits keep saving.
  await typeInEditor(' -- edited');
  await expect
    .poll(savedTexts, { timeout: 10_000 })
    .toEqual(["select 'crash_survivor' as marker -- edited"]);
  await panel.getByTestId('restored-banner').getByRole('button', { name: 'Dismiss' }).click();
  await expect(page.getByTestId('restored-marker')).toHaveCount(0);
});

test('restores open tabs after a clean quit too', async () => {
  await launched!.close();
  await start();
  const panel = page.getByTestId('query-panel').filter({ visible: true });
  await expect(panel.getByTestId('sql-editor')).toContainText('edited');
  await expect(panel.getByTestId('restored-banner')).toContainText('from the last session');
});

test('discards the buffer of a tab closed on purpose', async () => {
  await page
    .getByRole('button', { name: `Close ${NAME} query` })
    .filter({ visible: true })
    .first()
    .click();
  await expect(page.getByTestId('query-panel')).toHaveCount(0);
  await expect.poll(savedTexts, { timeout: 10_000 }).toEqual([]);
  await launched!.close();
  await start();
  await expect(page.getByText('No query tabs open')).toBeVisible();
  await expect(page.getByTestId('query-panel')).toHaveCount(0);
});
