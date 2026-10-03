import { expect, test, type Page } from '@playwright/test';

import { launchApp, openNewConnection, type LaunchedApp } from './app';

/**
 * The connections side bar, as Navicat's: a click selects a connection and a double-click
 * connects it, with a spinner in place of its actions button meanwhile and a chevron once
 * connected; the header's menu creates folders and closes every connection; the search and the
 * filter narrow the list.
 */

const PG_URL = process.env['QUERYBARA_TEST_POSTGRES_URL'];
const NAME = 'E2E Sidebar shop';
const CACHE = 'E2E Sidebar cache';

test.skip(!PG_URL, 'Set QUERYBARA_TEST_POSTGRES_URL to run the end-to-end tests');

test.describe.configure({ mode: 'serial' });

let launched: LaunchedApp;
let page: Page;

test.beforeAll(async () => {
  launched = await launchApp();
  page = launched.page;
});

test.afterAll(async () => {
  await launched?.close();
});

async function create(uri: string, name: string, storage?: string): Promise<void> {
  await openNewConnection(page);
  const dialog = page.getByRole('dialog', { name: 'New connection' });
  await dialog.getByLabel('Paste a URI to fill the form').fill(uri);
  await dialog.getByRole('button', { name: 'Fill from URI' }).click();
  await expect(dialog.getByText('Filled from the URI')).toBeVisible();
  await dialog.getByLabel('Name', { exact: true }).fill(name);
  if (storage) await dialog.getByLabel('Password storage').selectOption(storage);
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog).toBeHidden();
}

const profile = (name: string) => page.getByRole('treeitem', { name, exact: true });
const row = (name: string) => profile(name).locator('[data-tree-row]').first();

async function actions(item: string): Promise<void> {
  await page.getByRole('button', { name: 'Connection actions' }).click();
  await page.getByRole('menuitem', { name: item }).click();
}

test('a click selects a connection; a double-click connects it, with a spinner meanwhile', async () => {
  await create(PG_URL!, NAME, 'ask');
  await create('redis://127.0.0.1:1', CACHE);

  // A click only selects: no connection, no chevron.
  await row(NAME).click();
  await expect(row(NAME)).toBeFocused();
  await expect(profile(NAME).getByText('Not connected', { exact: true })).toBeAttached();
  await expect(profile(NAME)).not.toHaveAttribute('aria-expanded');
  await expect(row(NAME).locator('[data-tree-chevron] svg')).toHaveCount(0);

  // A double-click connects; the spinner shows until it is connected (here, while it asks for
  // the password), and cancelling leaves it as it was.
  await row(NAME).dblclick();
  const prompt = page.getByRole('dialog', { name: `Connect to ${NAME}` });
  await expect(prompt).toBeVisible();
  await expect(page.getByTestId('row-busy')).toHaveCount(1);
  await prompt.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByTestId('row-busy')).toHaveCount(0);
  await expect(profile(NAME).getByText('Not connected', { exact: true })).toBeAttached();

  // Enter connects too; once connected the chevron shows, and it folds the tree.
  await row(NAME).focus();
  await page.keyboard.press('Enter');
  await prompt.getByLabel('Password').fill(decodeURIComponent(new URL(PG_URL!).password));
  await prompt.getByLabel('Password').press('Enter');
  await expect(profile(NAME).getByText('Connected', { exact: true })).toBeAttached();
  await expect(page.getByTestId('row-busy')).toHaveCount(0);
  await expect(profile(NAME)).toHaveAttribute('aria-expanded', 'true');
  await row(NAME).locator('[data-tree-chevron]').click();
  await expect(profile(NAME)).toHaveAttribute('aria-expanded', 'false');
  // A double-click on a connected one unfolds it.
  await row(NAME).dblclick();
  await expect(profile(NAME)).toHaveAttribute('aria-expanded', 'true');
});

test('the actions menu makes a folder and closes every open connection', async () => {
  // A new folder is named in place: its name is selected, ready to type over.
  await actions('New folder');
  const naming = page.getByRole('tree').getByRole('textbox');
  await expect(naming).toBeFocused();
  await expect(naming).toHaveValue('Folder 1');
  await naming.fill('Staging');
  await naming.press('Enter');
  await expect(page.getByRole('tree').getByText('Staging', { exact: true })).toBeVisible();

  await actions('Close all connections');
  await expect(profile(NAME).getByText('Not connected', { exact: true })).toBeAttached();
  await expect(profile(NAME)).not.toHaveAttribute('aria-expanded');

  await page.getByRole('button', { name: 'Connection actions' }).click();
  await expect(page.getByRole('menuitem', { name: 'Close all connections' })).toHaveAttribute(
    'data-disabled',
  );
  await page.keyboard.press('Escape');
});

test('the menu moves a connection into a folder, a new one, and back to the top level', async () => {
  // A folder's tree item: the one whose own row carries the name.
  const folder = (name: string) =>
    page.getByRole('treeitem').filter({
      has: page.locator(':scope > [data-tree-row]').getByText(name, { exact: true }),
    });
  const moveTo = async (item: string): Promise<void> => {
    await row(CACHE).hover();
    await profile(CACHE).getByRole('button', { name: 'Actions' }).first().click();
    await page.getByRole('menuitem', { name: 'Move to folder' }).click();
    await page.getByRole('menuitem', { name: item }).click();
  };

  await moveTo('Staging');
  await expect(folder('Staging').getByRole('treeitem', { name: CACHE })).toBeVisible();

  // A new folder from the same menu: made, named in place, and the connection goes in.
  await moveTo('New folder');
  const naming = page.getByRole('tree').getByRole('textbox');
  await expect(naming).toHaveValue('Folder 2');
  await naming.fill('Caches');
  await naming.press('Enter');
  await expect(folder('Caches').getByRole('treeitem', { name: CACHE })).toBeVisible();
  await expect(folder('Staging').getByRole('treeitem', { name: CACHE })).toHaveCount(0);

  await moveTo('Top level');
  await expect(folder('Caches').getByRole('treeitem', { name: CACHE })).toHaveCount(0);
  await expect(profile(CACHE)).toBeVisible();
});

test('the search and the filter narrow the list', async () => {
  const search = page.getByRole('textbox', { name: 'Search connections' });
  await search.fill('cache');
  await expect(profile(CACHE)).toBeVisible();
  await expect(profile(NAME)).toHaveCount(0);
  await expect(profile(CACHE).locator('mark')).toHaveText('cache');
  await search.fill('nothing like it');
  await expect(page.getByTestId('sidebar-no-match')).toBeVisible();
  await page.getByRole('button', { name: 'Clear the search' }).click();
  await expect(profile(NAME)).toBeVisible();

  const filter = page.getByRole('button', { name: 'Filter connections' });
  await filter.click();
  await page.getByRole('menuitemcheckbox', { name: 'Redis' }).click();
  await page.keyboard.press('Escape');
  await expect(filter).toHaveAttribute('aria-pressed', 'true');
  await expect(profile(CACHE)).toBeVisible();
  await expect(profile(NAME)).toHaveCount(0);

  await filter.click();
  await page.getByRole('menuitemcheckbox', { name: 'Redis' }).click();
  await page.getByRole('menuitemcheckbox', { name: 'Connected only' }).click();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('sidebar-no-match')).toBeVisible();

  await page.getByRole('button', { name: 'Show all connections' }).click();
  await expect(filter).toHaveAttribute('aria-pressed', 'false');
  await expect(profile(NAME)).toBeVisible();
  await expect(profile(CACHE)).toBeVisible();
});
