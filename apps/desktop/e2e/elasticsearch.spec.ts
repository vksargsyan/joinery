import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type Locator, type Page } from '@playwright/test';
import type { SearchSession } from '@joinery/driver-elasticsearch';

import { launchApp, openNewConnection, type LaunchedApp } from './app';
import { connectSearch, e2eIndex, indexExists } from './search';

/**
 * The Elasticsearch module end to end against a real server (spec §4, §5, §11): connect from a
 * pasted URL, create an index from the console, index and search documents (a 64-bit number
 * comes back exactly), autocomplete, a destructive request that asks first, and the index in
 * the explorer with its health. Indices are named for the run and deleted afterwards. With
 * JOINERY_E2E_SHOTS set, screenshots are saved there.
 */

const ES_URL = process.env['JOINERY_TEST_ELASTICSEARCH_URL'];
const SHOTS = process.env['JOINERY_E2E_SHOTS'];
const NAME = 'E2E Elasticsearch';

test.skip(!ES_URL, 'Set JOINERY_TEST_ELASTICSEARCH_URL to run the Elasticsearch end-to-end tests');

test.describe.configure({ mode: 'serial' });

let launched: LaunchedApp | undefined;
let page: Page;
let direct: SearchSession | undefined;
const index = e2eIndex();

test.beforeAll(async () => {
  direct = await connectSearch(ES_URL!);
  if (SHOTS) mkdirSync(SHOTS, { recursive: true });
  launched = await launchApp();
  page = launched.page;
});

test.afterAll(async () => {
  await launched?.close();
  if (direct) {
    await direct.request({ method: 'DELETE', path: `/${index}` }).catch(() => undefined);
    await direct.close();
  }
});

async function shot(name: string): Promise<void> {
  if (SHOTS) await page.screenshot({ path: join(SHOTS, `${name}.png`) });
}

function profileItem(name: string): Locator {
  return page.getByRole('treeitem', { name, exact: true });
}

function treeRow(scope: Locator, text: string): Locator {
  return scope.locator('[data-tree-row]').filter({ has: page.getByText(text, { exact: true }) });
}

function consolePanel(): Locator {
  return page.getByTestId('search-console').filter({ visible: true });
}

/** Replaces the console text (typed as one input, so brackets are not auto-closed). */
async function replaceText(text: string): Promise<void> {
  await consolePanel().getByTestId('search-console-editor').click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.press('Delete');
  await page.keyboard.insertText(text);
}

/** Sends the request at the cursor and waits for its status. */
async function send(text: string, status: string): Promise<Locator> {
  await replaceText(text);
  await page.keyboard.press('ControlOrMeta+Enter');
  const badge = consolePanel().getByTestId('search-response-status');
  await expect(badge).toHaveText(status);
  return badge;
}

async function connectFromUrl(url: string, name: string) {
  await openNewConnection(page);
  const dialog = page.getByRole('dialog', { name: 'New connection' });
  await dialog.getByLabel('Paste a URI to fill the form').fill(url);
  await dialog.getByRole('button', { name: 'Fill from URI' }).click();
  await expect(dialog.getByText('Filled from the URI')).toBeVisible();
  // The pasted http:// URL makes the connection an Elasticsearch one.
  await expect(dialog.getByLabel('Database engine', { exact: true })).toHaveValue('elasticsearch');
  await expect(dialog.getByLabel('Node URL 1', { exact: true })).toHaveValue(
    `http://${new URL(url).host}`,
  );
  await expect(dialog.getByLabel('TLS', { exact: true })).toHaveValue('disable');
  await dialog.getByLabel('Name', { exact: true }).fill(name);
  return dialog;
}

test('connects to Elasticsearch from a pasted URL, step by step', async () => {
  const dialog = await connectFromUrl(ES_URL!, NAME);
  await expect(dialog.getByLabel('User', { exact: true })).toHaveValue('elastic');
  await dialog.getByLabel('Password storage').selectOption('session');
  await dialog.getByRole('button', { name: 'Test Connection' }).click();
  await expect(dialog.getByText('Connection succeeded')).toBeVisible();
  await expect(dialog.getByTestId('check-auth')).toContainText('Signed in as elastic');
  await expect(dialog.getByTestId('check-version')).toContainText('Elasticsearch');
  await shot('search-connection');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog).toBeHidden();

  const profile = profileItem(NAME);
  await profile.locator('[data-tree-row]').first().dblclick();
  await expect(profile.getByText('Connected', { exact: true })).toBeAttached();
  await expect(treeRow(profile, 'Indices')).toBeVisible();
  await expect(treeRow(profile, 'Aliases')).toBeVisible();
  await expect(treeRow(profile, 'Console')).toBeVisible();
  // Expanded now, so the write below reloads it.
  await treeRow(profile, 'Indices').click();
});

test('creates an index from the console, indexes and searches documents', async () => {
  await treeRow(profileItem(NAME), 'Console').dblclick();
  await expect(consolePanel()).toBeVisible();
  await expect(page.locator('.dv-tab', { hasText: `${NAME} console` })).toHaveCount(1);

  await send(
    `PUT /${index}\n{\n  "settings": { "number_of_replicas": 0 },\n  "mappings": { "properties": { "title": { "type": "text" }, "n": { "type": "long" } } }\n}`,
    '200 OK',
  );
  await expect(consolePanel().getByTestId('search-response-summary')).toHaveText('acknowledged');

  await send(
    [
      `POST /${index}/_bulk?refresh=true`,
      '{ "index": { "_id": "1" } }',
      '{ "title": "hello world", "n": 1234567890123456789 }',
      '{ "index": { "_id": "2" } }',
      '{ "title": "goodbye", "n": 2 }',
    ].join('\n'),
    '200 OK',
  );
  await expect(consolePanel().getByTestId('search-response-summary')).toHaveText(
    '2 items, no errors',
  );

  await send(`GET /${index}/_search\n{\n  "query": { "match": { "title": "hello" } }\n}`, '200 OK');
  await expect(consolePanel().getByTestId('search-response-summary')).toHaveText('1 hit');
  // The 64-bit number comes back exactly as it was sent.
  await expect(consolePanel().getByTestId('search-response-editor')).toContainText(
    '1234567890123456789',
  );
  await shot('search-console');
  const count = await direct!.count(index);
  expect(count).toBe(2);

  // An error shows the server's reason.
  await send(`GET /${index}/_search\n{ "query": { "match_al": {} } }`, '400 Bad Request');
  await expect(consolePanel().getByTestId('search-response-error')).toContainText('match_al');
});

test('completes endpoints and index names in the console', async () => {
  await replaceText('GET _cat/in');
  await page.keyboard.press('ControlOrMeta+Space');
  const suggestions = page.locator('.monaco-editor .suggest-widget').filter({ visible: true });
  await expect(suggestions).toContainText('indices');
  await page.keyboard.press('Escape');
  await replaceText('GET /joinery-e2e');
  await page.keyboard.press('ControlOrMeta+Space');
  await expect(suggestions).toContainText(index);
  await page.keyboard.press('Escape');
});

test('asks before a destructive request, and sends nothing when declined', async () => {
  await replaceText(`DELETE /${index}`);
  await consolePanel().getByRole('button', { name: 'Send', exact: true }).click();
  const confirm = page.getByRole('alertdialog').last();
  await expect(confirm).toContainText('deletes the index');
  await confirm.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(consolePanel().getByTestId('search-response-status')).toHaveText('Not sent');
  expect(await indexExists(direct!, index)).toBe(true);
});

test('shows the new index in the explorer with its health', async () => {
  const profile = profileItem(NAME);
  const row = treeRow(profile, index);
  await expect(row).toBeVisible();
  await expect(row.getByTestId('health-badge')).toHaveText('green');
  await expect(row).toContainText('2 docs');
  await shot('search-explorer');
  // Double-click opens its documents; the menu opens a console that searches it.
  await row.dblclick();
  await expect(page.getByTestId('search-documents').filter({ visible: true })).toBeVisible();
  await row.hover();
  await row.getByRole('button', { name: 'Actions' }).click();
  await page.getByRole('menuitem', { name: 'Search in console' }).click();
  await expect(consolePanel().getByTestId('search-console-editor')).toContainText(
    `GET /${index}/_search`,
  );
});
