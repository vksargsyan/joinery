import { expect, test } from '@playwright/test';

import { EXECUTABLE, launchPackaged, type PackagedApp } from './launch';

/**
 * A smoke test of the packaged app: the window loads from app.asar and a connection host starts
 * from inside the archive; with QUERYBARA_TEST_POSTGRES_URL it also runs a query.
 *
 *   QUERYBARA_PACKAGED_APP=dist/linux-unpacked/querybara playwright test -c e2e/packaged.config.ts
 */

const PG_URL = process.env['QUERYBARA_TEST_POSTGRES_URL'];

test.skip(!EXECUTABLE, 'Set QUERYBARA_PACKAGED_APP to the packaged executable');

let app: PackagedApp | undefined;

test.afterAll(async () => {
  await app?.close();
});

test('starts, loads its window from the archive and runs a connection host', async () => {
  app = await launchPackaged(EXECUTABLE!);
  const { page } = app;

  await page.getByRole('button', { name: 'Connection actions' }).click();
  await page.getByRole('menuitem', { name: 'New connection' }).click();
  const dialog = page.getByRole('dialog', { name: 'New connection' });
  await expect(dialog).toBeVisible();
  // Without a test server, port 9 on the loopback address, where nothing listens.
  await dialog
    .getByLabel('Paste a URI to fill the form')
    .fill(PG_URL ?? 'postgres://smoke:smoke@127.0.0.1:9/smoke');
  await dialog.getByRole('button', { name: 'Fill from URI' }).click();
  await expect(dialog.getByText('Filled from the URI')).toBeVisible();
  await dialog.getByLabel('Name').fill('Smoke');
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
  await profile.locator('[data-tree-row]').first().dblclick();
  await expect(profile.getByText('Connected', { exact: true })).toBeAttached();
  await page.getByRole('button', { name: 'New query' }).click();
  const editor = page.getByTestId('sql-editor').last();
  await editor.click();
  await page.keyboard.type('select 6 * 7 as answer');
  await page.keyboard.press('ControlOrMeta+Enter');
  await expect(page.getByTestId('row-count')).toHaveText('1 row');
});
