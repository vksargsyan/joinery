import { expect, test, type Locator, type Page } from '@playwright/test';

import { launchApp, openNewConnection, type LaunchedApp } from './app';
import { scratchDatabase } from './db';

/**
 * Autocomplete and signature help in the SQL editor against a real PostgreSQL server (spec §6):
 * tables created through SQL appear in the explorer and are suggested once the DDL has refreshed
 * the metadata, then their columns, a join condition from the foreign key and a function's
 * parameters; a table saved in the designer is suggested too.
 */

const PG_URL = process.env['JOINERY_TEST_POSTGRES_URL'];
const NAME = 'E2E Autocomplete';

test.skip(!PG_URL, 'Set JOINERY_TEST_POSTGRES_URL to run the end-to-end tests');

test.describe.configure({ mode: 'serial' });

let launched: LaunchedApp | undefined;
let page: Page;
let database: Awaited<ReturnType<typeof scratchDatabase>> | undefined;

test.beforeAll(async () => {
  database = await scratchDatabase(PG_URL!);
  launched = await launchApp();
  page = launched.page;
});

test.afterAll(async () => {
  await launched?.close();
  await database?.drop();
});

function editor(): Locator {
  return page.getByTestId('sql-editor').filter({ visible: true });
}

function treeRow(text: string): Locator {
  return page.locator('[data-tree-row]').filter({ has: page.getByText(text, { exact: true }) });
}

/** The editor's text as rendered (spaces normalised). */
function editorText(): Locator {
  return editor().locator('.view-lines');
}

function suggestions(): Locator {
  return page.locator('.suggest-widget.visible');
}

async function clearEditor(): Promise<void> {
  await editor().click();
  await page.keyboard.press('Escape');
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.press('Delete');
}

/** Types `text` into an empty editor until the suggestions show `expected` (metadata may lag). */
async function typeUntilSuggested(text: string, expected: readonly string[]): Promise<void> {
  await expect(async () => {
    await clearEditor();
    await page.keyboard.type(text);
    for (const label of expected) {
      await expect(suggestions()).toContainText(label, { timeout: 3_000 });
    }
  }).toPass({ timeout: 30_000 });
}

test('creates tables with a foreign key through SQL', async () => {
  await openNewConnection(page);
  const dialog = page.getByRole('dialog', { name: 'New connection' });
  await dialog.getByLabel('Paste a URI to fill the form').fill(database!.url);
  await dialog.getByRole('button', { name: 'Fill from URI' }).click();
  // Main parses the URI asynchronously; typing before it answers races the fill.
  await expect(dialog.getByText('Filled from the URI')).toBeVisible();
  await dialog.getByLabel('Name').fill(NAME);
  await dialog.getByLabel('Password storage').selectOption('session');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog).toBeHidden();

  const profile = page.getByRole('treeitem', { name: NAME });
  await profile.locator('[data-tree-row]').first().dblclick();
  await expect(profile.getByText('Connected', { exact: true })).toBeAttached();
  await treeRow(database!.name).click();
  await treeRow('public').click();
  await treeRow('Tables').click();
  await page.getByRole('button', { name: 'New query' }).click();
  await expect(page.getByTestId('query-panel')).toBeVisible();

  await clearEditor();
  await page.keyboard.type(
    'CREATE TABLE authors (id int PRIMARY KEY, name text); ' +
      'CREATE TABLE books (id int PRIMARY KEY, author_id int REFERENCES authors (id), title text)',
  );
  await page.keyboard.press('Escape');
  await page.keyboard.press('ControlOrMeta+Shift+Enter');
  await expect(page.getByTestId('messages')).toContainText('Statement 2');
  await expect(page.getByTestId('messages')).not.toContainText('error', { ignoreCase: true });
  // The DDL refreshed the explorer's open folder too.
  await expect(treeRow('authors')).toBeVisible();
  await expect(treeRow('books')).toBeVisible();
});

test('suggests the new tables after FROM and accepts one', async () => {
  // The DDL refreshed the metadata in the background.
  await typeUntilSuggested('SELECT * FROM ', ['authors', 'books']);
  await page.keyboard.type('bo');
  await expect(suggestions().locator('.monaco-list-row').first()).toContainText('books');
  await page.keyboard.press('Enter');
  await expect(suggestions()).toBeHidden();
  await expect(editorText()).toHaveText('SELECT * FROM books');
});

test('suggests the columns after WHERE', async () => {
  await page.keyboard.type(' WHERE ');
  const list = suggestions();
  await expect(list).toContainText('author_id');
  await expect(list).toContainText('title');
  await page.keyboard.press('Escape');
});

test('suggests the join condition from the foreign key', async () => {
  await typeUntilSuggested('SELECT * FROM books b JOIN authors a ', ['a.id = b.author_id']);
  await expect(suggestions().locator('.monaco-list-row').first()).toContainText(
    'ON a.id = b.author_id',
  );
  await page.keyboard.press('Enter');
  await expect(editorText()).toHaveText(
    'SELECT * FROM books b JOIN authors a ON a.id = b.author_id',
  );
});

test('shows signature help inside a function call', async () => {
  await clearEditor();
  await page.keyboard.type('SELECT lpad(');
  const hints = page.locator('.parameter-hints-widget.visible');
  await expect(hints).toContainText('lpad(');
  await page.keyboard.type('title, ');
  await expect(hints).toBeVisible();
  // The second parameter is the active one now.
  await expect(hints.locator('.parameter.active')).toContainText('length');
});

test('suggests a table saved in the table designer', async () => {
  const tables = treeRow('Tables');
  await tables.hover();
  await tables.getByRole('button', { name: 'Actions' }).click();
  await page.getByRole('menuitem', { name: 'New table…', exact: true }).click();
  const designer = page.getByTestId('table-designer').filter({ visible: true });
  await designer.getByLabel('Table name').fill('reviews');
  await designer.getByRole('button', { name: 'Save' }).click();
  const review = page.getByRole('dialog', { name: 'Review and save' });
  await review.getByRole('button', { name: 'Run script' }).click();
  await expect(designer.getByTestId('designer-notice')).toContainText('Saved reviews');

  await page.locator('.dv-tab', { hasText: `${NAME} query` }).click();
  await typeUntilSuggested('SELECT * FROM rev', ['reviews']);
  await page.keyboard.press('Escape');
});
