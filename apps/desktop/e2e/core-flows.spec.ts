import { expect, test, type Page } from '@playwright/test';

import { launchApp, openNewConnection, type LaunchedApp } from './app';

/**
 * The core flows against a real PostgreSQL server: create and test a connection, run a query
 * that streams past the row limit and fetch more, see a syntax error, cancel a long statement,
 * and the production frame.
 */

const PG_URL = process.env['JOINERY_TEST_POSTGRES_URL'];
const NAME = 'E2E Postgres';

test.skip(!PG_URL, 'Set JOINERY_TEST_POSTGRES_URL to run the end-to-end tests');

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

async function typeInEditor(text: string): Promise<void> {
  const editor = page.getByTestId('sql-editor').last();
  await editor.click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.press('Delete');
  await page.keyboard.type(text);
}

async function runStatement(): Promise<void> {
  await page.keyboard.press('ControlOrMeta+Enter');
}

test('creates a PostgreSQL connection from a URI and tests it', async () => {
  await openNewConnection(page);
  const dialog = page.getByRole('dialog', { name: 'New connection' });
  await expect(dialog).toBeVisible();

  await dialog.getByLabel('Paste a URI to fill the form').fill(PG_URL!);
  await dialog.getByRole('button', { name: 'Fill from URI' }).click();
  await expect(dialog.getByText('Filled from the URI')).toBeVisible();
  await expect(dialog.getByLabel('Password', { exact: true })).not.toHaveValue('');

  await dialog.getByLabel('Name').fill(NAME);
  // The test server has no TLS; turning it off must show the persistent warning.
  await dialog.getByLabel('TLS').selectOption('disable');
  await expect(dialog.getByText('TLS is disabled')).toBeVisible();
  await dialog.getByLabel('Password storage').selectOption('session');

  await dialog.getByRole('button', { name: 'Test Connection' }).click();
  await expect(dialog.getByText('Connection succeeded')).toBeVisible();
  await expect(dialog.getByTestId('check-auth')).toContainText('Authentication');

  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('treeitem', { name: NAME })).toBeVisible();
});

test('streams a result past the row limit and fetches more', async () => {
  const profile = page.getByRole('treeitem', { name: NAME });
  await profile.locator('[data-tree-row]').first().dblclick();
  await expect(profile.getByText('Connected', { exact: true })).toBeAttached();
  await page.getByRole('button', { name: 'New query' }).click();
  await expect(page.getByTestId('query-panel')).toBeVisible();

  await typeInEditor('select generate_series(1, 5000) as n');
  await runStatement();

  const rowCount = page.getByTestId('row-count');
  await expect(rowCount).toHaveText('1,000 rows');
  await expect(page.getByTestId('more-available')).toBeVisible();
  await expect(page.getByTestId('result-grid')).toBeVisible();

  await page.getByRole('button', { name: /Fetch more/ }).click();
  await expect(rowCount).toHaveText('2,000 rows');

  await page.getByRole('button', { name: 'Fetch all' }).click();
  await expect(rowCount).toHaveText('5,000 rows');
  await expect(page.getByTestId('more-available')).toBeHidden();
});

test('reports a syntax error in the Messages tab', async () => {
  await typeInEditor('selec 1');
  await runStatement();
  await expect(page.getByRole('tab', { name: /Messages/ })).toHaveAttribute('data-state', 'active');
  await expect(page.getByTestId('messages')).toContainText('syntax error at or near "selec"');
});

test('cancels a long-running statement', async () => {
  await typeInEditor('select pg_sleep(30)');
  await runStatement();
  const cancel = page.getByRole('button', { name: 'Cancel', exact: true });
  await expect(cancel).toBeEnabled();
  const started = Date.now();
  await cancel.click();
  await expect(page.getByTestId('messages')).toContainText('Query cancelled', { timeout: 15_000 });
  expect(Date.now() - started).toBeLessThan(15_000);
  // The session is usable again.
  await typeInEditor('select 42 as answer');
  await runStatement();
  await expect(page.getByTestId('row-count')).toHaveText('1 row');
});

test('shows a crashed connection host and reconnects', async () => {
  // Kill the connection host process from the main process, as a driver crash would.
  const killed = await launched.app.evaluate(({ app }) => {
    const host = app
      .getAppMetrics()
      .find(
        (metric) => metric.type === 'Utility' && metric.name?.startsWith('Joinery connection:'),
      );
    if (!host) return false;
    process.kill(host.pid, 'SIGKILL');
    return true;
  });
  expect(killed).toBe(true);
  const banner = page.getByTestId('connection-lost');
  await expect(banner).toBeVisible();
  // Main restarts the host on its own; the UI says so and offers to reconnect.
  await expect(banner).toContainText('restarted');
  await banner.getByRole('button', { name: 'Reconnect' }).click();
  await expect(banner).toBeHidden();
  await typeInEditor('select 7 as seven');
  await runStatement();
  await expect(page.getByTestId('row-count')).toHaveText('1 row');
});

test('frames the window red for a production connection', async () => {
  await expect(page.getByTestId('production-frame')).toHaveCount(0);
  const profile = page.getByRole('treeitem', { name: NAME });
  await profile.locator('[data-tree-row]').first().hover();
  await profile.getByRole('button', { name: 'Actions' }).first().click();
  await page.getByRole('menuitem', { name: 'Edit…' }).click();
  const dialog = page.getByRole('dialog', { name: `Edit ${NAME}` });
  await dialog.getByLabel('Environment').selectOption('production');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog).toBeHidden();

  await expect(page.getByTestId('production-frame')).toBeVisible();
  await expect(page.getByTestId('production-banner')).toContainText(NAME);

  // Every write on production asks first.
  await typeInEditor('create temporary table e2e_guard (id int)');
  await runStatement();
  const confirm = page.getByRole('alertdialog', { name: 'Run on a production connection?' });
  await expect(confirm).toBeVisible();
  await confirm.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByTestId('messages')).toContainText('Run cancelled');
});
