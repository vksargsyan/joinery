import type { Session } from '@querybara/core';
import { expect, test, type Page } from '@playwright/test';

import { launchApp, openNewConnection, type LaunchedApp } from './app';
import { connect, query, scratchDatabase } from './db';

/**
 * The command palette and the key bindings, as VS Code has them: ⌘⇧P (Ctrl+Shift+P) lists the
 * commands, ⌘P goes to a table, ⌘K ⌘S opens the Keyboard Shortcuts editor, and a binding the
 * user records there replaces the default.
 */

const PG_URL = process.env['QUERYBARA_TEST_POSTGRES_URL'];
const NAME = 'E2E Palette';

test.skip(!PG_URL, 'Set QUERYBARA_TEST_POSTGRES_URL to run the end-to-end tests');

test.describe.configure({ mode: 'serial' });

let launched: LaunchedApp;
let page: Page;
let database: Awaited<ReturnType<typeof scratchDatabase>> | undefined;
let direct: Session | undefined;

test.beforeAll(async () => {
  database = await scratchDatabase(PG_URL!);
  direct = await connect(PG_URL!, database.name);
  await query(direct, `CREATE TABLE manager_teams (id integer PRIMARY KEY, team text)`);
  await query(direct, `INSERT INTO manager_teams VALUES (1, 'core'), (2, 'data')`);
  await query(direct, `CREATE TABLE invoices (id integer PRIMARY KEY)`);
  launched = await launchApp();
  page = launched.page;
});

test.afterAll(async () => {
  await launched?.close();
  await direct?.close();
  await database?.drop();
});

const palette = () => page.getByTestId('command-palette');

test('⌘⇧P lists the commands and runs one', async () => {
  await openNewConnection(page);
  const dialog = page.getByRole('dialog', { name: 'New connection' });
  await dialog.getByLabel('Paste a URI to fill the form').fill(database!.url);
  await dialog.getByRole('button', { name: 'Fill from URI' }).click();
  await expect(dialog.getByText('Filled from the URI')).toBeVisible();
  await dialog.getByLabel('Name').fill(NAME);
  await dialog.getByLabel('Password storage').selectOption('session');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog).toBeHidden();
  const profile = page.getByRole('treeitem', { name: NAME });
  await profile.locator('[data-tree-row]').first().dblclick();
  await expect(profile.getByText('Connected', { exact: true })).toBeAttached();

  await page.keyboard.press('ControlOrMeta+Shift+P');
  await expect(palette()).toBeVisible();
  await expect(palette().getByRole('combobox')).toHaveValue('>');
  await page.keyboard.type('new query');
  await expect(palette().getByRole('option').first()).toContainText('Query: New Query Tab');
  await page.keyboard.press('Enter');
  await expect(palette()).toBeHidden();
  await expect(page.getByTestId('query-panel')).toBeVisible();
});

test('⌘P goes to a table by a few of its letters', async () => {
  await page.keyboard.press('ControlOrMeta+P');
  await expect(palette()).toBeVisible();
  await page.keyboard.type('mtea');
  await expect(palette().getByRole('option').first()).toContainText('manager_teams');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('table-data-panel').filter({ visible: true })).toBeVisible();
  await expect(
    page.getByTestId('table-data-panel').filter({ visible: true }).getByTestId('table-row-count'),
  ).toHaveText('2 rows loaded');
});

test('⌘K ⌘S opens the shortcuts; a recorded binding replaces the default', async () => {
  await page.keyboard.press('ControlOrMeta+K');
  await expect(page.getByTestId('command-status')).toContainText('Waiting for second key');
  await page.keyboard.press('ControlOrMeta+S');
  const editor = page.getByTestId('keybindings-panel');
  await expect(editor).toBeVisible();
  await editor.getByLabel('Search key bindings').fill('new query');
  const row = editor.getByRole('row').filter({ hasText: 'New Query Tab' });
  await row.dblclick();
  await expect(page.getByRole('dialog', { name: 'Record a key binding' })).toBeVisible();
  await page.keyboard.press('ControlOrMeta+Alt+N');
  await expect(page.getByTestId('recorded-keys')).toContainText('N');
  await page.keyboard.press('Enter');
  await expect(row).toContainText('User');

  // The new keys open a query tab; the old ones no longer do.
  const tabs = page.getByTestId('query-panel');
  const before = await tabs.count();
  await page.keyboard.press('ControlOrMeta+Alt+N');
  await expect(tabs).toHaveCount(before + 1);
  await page.keyboard.press('ControlOrMeta+T');
  await expect(tabs).toHaveCount(before + 1);

  // Back to the default.
  await page.getByRole('tab', { name: /Keyboard Shortcuts/ }).click();
  await row.hover();
  await row.getByRole('button', { name: /Reset the key binding/ }).click();
  await expect(row).toContainText('Default');
});
