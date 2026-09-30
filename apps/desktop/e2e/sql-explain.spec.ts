import { randomBytes } from 'node:crypto';
import { join } from 'node:path';

import type { Session } from '@joinery/core';
import { createMysqlAdapter } from '@joinery/driver-mysql';
import { resolvedProfileFromUrl } from '@joinery/driver-sql-base';
import { expect, test, type Locator, type Page } from '@playwright/test';

import { launchApp, openNewConnection, type LaunchedApp } from './app';
import { connect, query, scratchDatabase } from './db';

/**
 * The visual explain of SQL (spec §6) against real servers: Explain and Explain Analyze of the
 * statement at the cursor on PostgreSQL, the plan tree with the slowest node highlighted, a
 * row misestimate flagged, the details pane and the raw JSON; ANALYZE of a DELETE only after
 * the warning, rolled back; and, when a MySQL server is configured, EXPLAIN FORMAT=JSON and
 * EXPLAIN ANALYZE there. Screenshots go to JOINERY_E2E_SHOTS when it is set.
 */

const PG_URL = process.env['JOINERY_TEST_POSTGRES_URL'];
const MYSQL_URL = process.env['JOINERY_TEST_MYSQL_URL'];
const SHOTS = process.env['JOINERY_E2E_SHOTS'];

test.skip(!PG_URL, 'Set JOINERY_TEST_POSTGRES_URL to run the end-to-end tests');

test.describe.configure({ mode: 'serial' });

let launched: LaunchedApp | undefined;
let page: Page;
let database: Awaited<ReturnType<typeof scratchDatabase>> | undefined;
let direct: Session | undefined;
let mysql: { readonly name: string; readonly url: string; readonly admin: Session } | undefined;

test.beforeAll(async () => {
  database = await scratchDatabase(PG_URL!);
  direct = await connect(PG_URL!, database.name);
  await query(direct, 'CREATE TABLE items (id integer PRIMARY KEY, qty integer NOT NULL)');
  await query(
    direct,
    'INSERT INTO items SELECT g, CASE WHEN g <= 1000 THEN 1 ELSE g END FROM generate_series(1, 2000) g',
  );
  await query(direct, 'ANALYZE items');
  if (MYSQL_URL) {
    const name = `joinery_e2e_${randomBytes(4).toString('hex')}`;
    const admin = await createMysqlAdapter().connect(resolvedProfileFromUrl(MYSQL_URL));
    await query(admin, `CREATE DATABASE ${name}`);
    await query(admin, `CREATE TABLE ${name}.orders (id int PRIMARY KEY, total int NOT NULL)`);
    await query(admin, `INSERT INTO ${name}.orders VALUES (1, 10), (2, 20), (3, 30)`);
    const url = new URL(MYSQL_URL);
    url.pathname = `/${name}`;
    mysql = { name, url: url.toString(), admin };
  }
  launched = await launchApp();
  page = launched.page;
});

test.afterAll(async () => {
  await launched?.close();
  await direct?.close();
  await database?.drop();
  if (mysql) {
    await query(mysql.admin, `DROP DATABASE IF EXISTS ${mysql.name}`).catch(() => undefined);
    await mysql.admin.close();
  }
});

async function shot(name: string): Promise<void> {
  if (SHOTS) await page.screenshot({ path: join(SHOTS, `${name}.png`) });
}

function visible(testId: string): Locator {
  return page.getByTestId(testId).filter({ visible: true });
}

async function addConnection(url: string, name: string): Promise<void> {
  await openNewConnection(page);
  const dialog = page.getByRole('dialog', { name: 'New connection' });
  await dialog.getByLabel('Paste a URI to fill the form').fill(url);
  await dialog.getByRole('button', { name: 'Fill from URI' }).click();
  await expect(dialog.getByText('Filled from the URI')).toBeVisible();
  await dialog.getByLabel('Name', { exact: true }).fill(name);
  await dialog.getByLabel('TLS').selectOption('disable');
  await dialog.getByLabel('Password storage').selectOption('session');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog).toBeHidden();
  const profile = page.getByRole('treeitem', { name });
  await profile.locator('[data-tree-row]').first().dblclick();
  await expect(profile.getByText('Connected', { exact: true })).toBeAttached();
}

async function typeInEditor(text: string): Promise<void> {
  const editor = visible('sql-editor');
  await editor.click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.press('Delete');
  await page.keyboard.type(text);
  await page.keyboard.press('Escape');
}

test('explains the statement at the cursor with Ctrl/Cmd+E', async () => {
  await addConnection(database!.url, 'E2E Explain');
  await page.getByRole('button', { name: 'New query' }).click();
  await typeInEditor('select * from items where qty > 1500');
  await page.keyboard.press('ControlOrMeta+e');

  const plan = visible('sql-plan');
  await expect(plan).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Plan', exact: true })).toHaveAttribute(
    'data-state',
    'active',
  );
  await expect(plan.getByTestId('plan-kind')).toHaveText('Estimated plan');
  const scan = plan.locator('[data-testid="plan-node"][data-operation="Seq Scan"]');
  await expect(scan).toContainText('on items');
  // The only node is the most expensive one.
  await expect(scan).toHaveAttribute('data-hottest', 'true');
  await expect(plan.getByTestId('plan-hottest')).toContainText('Most expensive step');
  await expect(plan.getByTestId('plan-details')).toContainText('Filter');
  await expect(plan.getByTestId('plan-details')).toContainText('(qty > 1500)');

  await plan.getByRole('radio', { name: 'Raw JSON' }).click();
  await expect(plan.getByTestId('plan-raw')).toContainText('"Node Type": "Seq Scan"');
});

test('analyzes a query: actual rows, the slowest node, a misestimate', async () => {
  // qty + 0 hides the column's statistics: the planner guesses 0.5% of the rows, 1,000 match.
  await typeInEditor('select count(*) from items a join items b using (id) where a.qty + 0 = 1');
  await page.getByRole('button', { name: 'Explain Analyze' }).click();
  const plan = visible('sql-plan');
  await expect(plan.getByTestId('plan-kind')).toHaveText('Analyzed');
  await expect(plan.getByTestId('plan-rolled-back')).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Plan (analyzed)' })).toBeVisible();
  await expect(plan.getByTestId('plan-execution')).toHaveText(/ms|s$/);
  await expect(plan.getByTestId('plan-hottest')).toContainText('Slowest step');
  await expect(plan.locator('[data-testid="plan-node"][data-hottest="true"]')).toHaveCount(1);
  await expect(plan.getByTestId('plan-misestimate').first()).toBeVisible();
  // Buffers are on by default on PostgreSQL.
  await plan.locator('[data-testid="plan-node"]').first().click();
  await expect(plan.getByTestId('plan-details')).toContainText('Shared hit blocks');
  await shot('sql-explain-analyze');
});

test('warns before analyzing a DELETE and rolls it back', async () => {
  await typeInEditor('delete from items where id <= 10');
  await page.keyboard.press('ControlOrMeta+Shift+e');
  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toContainText('rolls it back');
  await expect(dialog).toContainText('delete from items where id <= 10');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toBeHidden();

  await page.getByRole('button', { name: 'Explain Analyze' }).click();
  await dialog.getByRole('button', { name: 'Analyze and roll back' }).click();
  const plan = visible('sql-plan');
  await expect(plan.locator('[data-testid="plan-node"][data-operation="Delete"]')).toBeVisible();
  await expect(plan.getByTestId('plan-rolled-back')).toBeVisible();
  expect(await query(direct!, 'SELECT count(*) FROM items')).toEqual([[2000]]);
});

test('explains on MySQL: JSON estimate and EXPLAIN ANALYZE tree', async () => {
  test.skip(!mysql, 'Set JOINERY_TEST_MYSQL_URL to explain on MySQL');
  await addConnection(mysql!.url, 'E2E Explain MySQL');
  const profile = page.getByRole('treeitem', { name: 'E2E Explain MySQL' });
  await profile.locator('[data-tree-row]').first().hover();
  await profile.getByRole('button', { name: 'Actions' }).first().click();
  await page.getByRole('menuitem', { name: 'New query tab' }).click();
  await typeInEditor(`select * from ${mysql!.name}.orders where total > 15`);
  await page.getByRole('button', { name: 'Explain', exact: true }).click();
  const plan = visible('sql-plan');
  await expect(plan.getByTestId('plan-kind')).toHaveText('Estimated plan');
  await expect(plan.locator('[data-testid="plan-node"]').first()).toBeVisible();
  await expect(plan.getByText(/on orders/).first()).toBeVisible();

  await page.getByRole('button', { name: 'Explain Analyze' }).click();
  await expect(plan.getByTestId('plan-kind')).toHaveText('Analyzed');
  await plan.getByRole('radio', { name: 'Raw text' }).click();
  await expect(plan.getByTestId('plan-raw')).toContainText('-> ');
});
