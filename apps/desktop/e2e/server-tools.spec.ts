import type { Session } from '@querybara/core';
import { expect, test, type Locator, type Page } from '@playwright/test';

import { launchApp, openNewConnection, type LaunchedApp } from './app';
import { connect, query, scratchDatabase } from './db';

/**
 * Server tools against a real PostgreSQL server (spec §15): open them on a connection, watch
 * the monitor poll, find a session this test opened and terminate it after the statement is
 * shown, and run ANALYZE on a test table with its statement preview.
 */

const PG_URL = process.env['QUERYBARA_TEST_POSTGRES_URL'];
const NAME = 'E2E Server Tools';

test.skip(!PG_URL, 'Set QUERYBARA_TEST_POSTGRES_URL to run the end-to-end tests');

test.describe.configure({ mode: 'serial' });

let launched: LaunchedApp | undefined;
let page: Page;
let database: Awaited<ReturnType<typeof scratchDatabase>> | undefined;
let direct: Session | undefined;
let victim: Session | undefined;

test.beforeAll(async () => {
  database = await scratchDatabase(PG_URL!);
  direct = await connect(PG_URL!, database.name);
  await query(direct, 'CREATE TABLE st_orders (id integer PRIMARY KEY, total numeric)');
  await query(direct, 'INSERT INTO st_orders SELECT g, g * 2 FROM generate_series(1, 500) g');
  launched = await launchApp();
  page = launched.page;
});

test.afterAll(async () => {
  await launched?.close();
  await victim?.close().catch(() => undefined);
  await direct?.close();
  await database?.drop();
});

function panel(): Locator {
  return page.getByTestId('server-tools-panel').filter({ visible: true });
}

test('opens the server tools of a PostgreSQL connection', async () => {
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
  await profile.locator('[data-tree-row]').first().hover();
  await profile.getByRole('button', { name: 'Actions' }).first().click();
  await page.getByRole('menuitem', { name: 'Server tools' }).click();

  await expect(panel()).toBeVisible();
  await expect(panel().getByTestId('server-tools-identity')).toContainText('PostgreSQL');
  await expect(panel().getByRole('tab', { name: 'Monitor' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(panel().getByTestId('stat-Connections')).toHaveText(/^\d+$/);
  // A rate needs two polls (5 s apart by default); the history then keeps growing.
  await expect(panel().getByTestId('stat-Transactions/s')).toHaveText(/^[\d.,]+$/, {
    timeout: 20_000,
  });
  await expect(panel().getByTestId('monitor-status')).toContainText('samples');
  await expect(panel().getByTestId('monitor-section-databases')).toContainText(database!.name);
});

test('lists sessions and terminates one the test opened, after showing the statement', async () => {
  victim = await connect(PG_URL!, database!.name);
  await query(victim, `SET application_name = 'e2e-victim'`);
  const sleeping = query(victim, 'SELECT pg_sleep(60)').then(
    () => 'finished',
    (error: unknown) => error,
  );

  await panel().getByRole('tab', { name: 'Sessions' }).click();
  const tab = panel().getByTestId('server-sessions');
  await tab.getByLabel('Filter sessions').fill('e2e-victim');
  const row = tab.getByTestId('session-row').filter({ hasText: 'pg_sleep' });
  // The list is read once when the tab opens; refresh until the sleep shows up.
  await expect(async () => {
    await tab.getByRole('button', { name: 'Refresh' }).click();
    await expect(row).toHaveCount(1, { timeout: 1000 });
  }).toPass({ timeout: 20_000 });
  const pid = (await row.locator('td').first().innerText()).trim();
  expect(pid).toMatch(/^\d+$/);
  await row.click();
  await expect(tab.getByTestId('session-details')).toContainText('SELECT pg_sleep(60)');

  await tab.getByRole('button', { name: 'Terminate…' }).click();
  const confirm = page.getByRole('alertdialog', { name: `Terminate session ${pid}?` });
  await expect(confirm).toBeVisible();
  await expect(confirm.getByTestId('confirm-detail')).toHaveText(
    `SELECT pg_catalog.pg_terminate_backend(${pid});`,
  );
  await confirm.getByRole('button', { name: 'Terminate' }).click();
  await expect(confirm).toBeHidden();
  await expect(tab.getByTestId('action-messages')).toContainText(`Terminated process ${pid}`);
  expect(await sleeping).toMatchObject({ code: expect.any(String) });
  // The backend exits right after the signal; the list shows it gone.
  await expect(async () => {
    await tab.getByRole('button', { name: 'Refresh' }).click();
    await expect(row).toHaveCount(0, { timeout: 1000 });
  }).toPass({ timeout: 20_000 });
});

test('runs ANALYZE on a test table with the statement preview', async () => {
  await panel().getByRole('tab', { name: 'Maintenance' }).click();
  const tab = panel().getByTestId('server-maintenance');
  await tab.getByLabel('Schema', { exact: true }).selectOption('public');
  const target = tab.getByTestId('maintenance-target').filter({ hasText: 'st_orders' });
  await expect(target).toBeVisible();
  await target.getByLabel('Select st_orders').check();
  await tab.getByLabel('Command', { exact: true }).selectOption('analyze');
  await tab.getByLabel('VERBOSE', { exact: true }).check();
  await tab.getByRole('button', { name: 'Run ANALYZE…' }).click();

  const confirm = page.getByRole('alertdialog', { name: 'Run ANALYZE?' });
  await expect(confirm).toBeVisible();
  await expect(confirm.getByTestId('confirm-detail')).toHaveText(
    'ANALYZE (VERBOSE) "public"."st_orders";',
  );
  await confirm.getByRole('button', { name: 'Run' }).click();
  await expect(confirm).toBeHidden();
  const messages = tab.getByTestId('action-messages');
  await expect(messages).toContainText('analyzing "public.st_orders"');
  // Statistics reach other sessions within a second or so.
  await expect(async () => {
    const analyzed = await query(
      direct!,
      `SELECT last_analyze IS NOT NULL FROM pg_stat_user_tables WHERE relname = 'st_orders'`,
    );
    expect(analyzed).toEqual([[true]]);
  }).toPass({ timeout: 20_000 });
});
