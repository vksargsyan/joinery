import { randomBytes } from 'node:crypto';

import { newId, rowAt, type CellValue, type Session } from '@querybara/core';
import { createMysqlAdapter } from '@querybara/driver-mysql';
import { resolvedProfileFromUrl } from '@querybara/driver-sql-base';
import { expect, test, type Locator, type Page } from '@playwright/test';

import { launchApp, openNewConnection, type LaunchedApp } from './app';
import { connect, query, scratchDatabase } from './db';

/**
 * Data transfer between databases through the wizard (spec §12): two PostgreSQL tables, one
 * referencing the other, moved into MySQL (or MariaDB) — source objects, target connection,
 * options, the planned column types, the review — and run as a job; the row counts, a
 * converted value and the foreign key are then checked on the target server directly.
 */

const PG_URL = process.env['QUERYBARA_TEST_POSTGRES_URL'];
const MY_URL = process.env['QUERYBARA_TEST_MYSQL_URL'] ?? process.env['QUERYBARA_TEST_MARIADB_URL'];
const MY_ENGINE = process.env['QUERYBARA_TEST_MYSQL_URL'] ? 'mysql' : 'mariadb';
const MY_LABEL = MY_ENGINE === 'mysql' ? 'MySQL' : 'MariaDB';
const PG_NAME = 'E2E PG source';
const MY_NAME = `E2E ${MY_LABEL} target`;
const ORDERS = 1000;

test.skip(!PG_URL || !MY_URL, 'Set QUERYBARA_TEST_POSTGRES_URL and a MySQL or MariaDB URL');

test.describe.configure({ mode: 'serial' });

let launched: LaunchedApp | undefined;
let page: Page;
let source: Awaited<ReturnType<typeof scratchDatabase>> | undefined;
const target = `querybara_e2e_${randomBytes(4).toString('hex')}`;
let targetUrl = '';

function mysql(database?: string): Promise<Session> {
  return createMysqlAdapter({ engine: MY_ENGINE }).connect(
    resolvedProfileFromUrl(MY_URL!, {
      engine: MY_ENGINE,
      ...(database !== undefined ? { options: { defaultDatabase: database } } : {}),
    }),
  );
}

async function rows(session: Session, sql: string): Promise<CellValue[][]> {
  const out: CellValue[][] = [];
  for await (const chunk of session.execute(sql, { executionId: newId() })) {
    if (chunk.type === 'rows' && chunk.resultIndex === 0) {
      for (let r = 0; r < chunk.rowCount; r++) out.push(rowAt(chunk, r));
    }
  }
  return out;
}

test.beforeAll(async () => {
  source = await scratchDatabase(PG_URL!);
  const pg = await connect(PG_URL!, source.name);
  try {
    await query(
      pg,
      'CREATE TABLE customers (id serial PRIMARY KEY, name text NOT NULL, joined date)',
    );
    await query(
      pg,
      `CREATE TABLE orders (
        id integer PRIMARY KEY,
        customer_id integer NOT NULL REFERENCES customers (id),
        total numeric(10,2) NOT NULL,
        placed timestamp with time zone,
        note text
      )`,
    );
    await query(
      pg,
      "INSERT INTO customers (name, joined) VALUES ('Ada', '2024-01-02'), ('Grüße 😀', NULL), ('Linus', '1991-08-25')",
    );
    await query(
      pg,
      `INSERT INTO orders SELECT g, 1 + g % 3, g * 0.25, timestamptz '2024-01-01 00:00:00+00' + g * interval '1 minute', CASE WHEN g % 10 = 0 THEN NULL ELSE 'order ' || g END FROM generate_series(1, ${ORDERS}) g`,
    );
  } finally {
    await pg.close();
  }
  const admin = await mysql();
  try {
    await rows(admin, `CREATE DATABASE \`${target}\` CHARACTER SET utf8mb4`);
  } finally {
    await admin.close();
  }
  const url = new URL(MY_URL!);
  url.pathname = `/${target}`;
  targetUrl = url.toString();
  launched = await launchApp();
  page = launched.page;
});

test.afterAll(async () => {
  await launched?.close();
  await source?.drop();
  const admin = await mysql().catch(() => undefined);
  if (admin) {
    await rows(admin, `DROP DATABASE IF EXISTS \`${target}\``).catch(() => undefined);
    await admin.close();
  }
});

function treeRow(text: string): Locator {
  return page.locator('[data-tree-row]').filter({ has: page.getByText(text, { exact: true }) });
}

async function menu(row: Locator, item: string): Promise<void> {
  await row.hover();
  await row.getByRole('button', { name: 'Actions' }).click();
  await page.getByRole('menuitem', { name: item }).click();
}

async function addConnection(name: string, uri: string): Promise<void> {
  await openNewConnection(page);
  const dialog = page.getByRole('dialog', { name: 'New connection' });
  await dialog.getByLabel('Paste a URI to fill the form').fill(uri);
  await dialog.getByRole('button', { name: 'Fill from URI' }).click();
  await expect(dialog.getByText('Filled from the URI')).toBeVisible();
  await dialog.getByLabel('Name').fill(name);
  await dialog.getByLabel('Password storage').selectOption('session');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog).toBeHidden();
}

test('adds the source and target connections', async () => {
  await addConnection(PG_NAME, source!.url);
  await addConnection(MY_NAME, targetUrl);
  const profile = page.getByRole('treeitem', { name: PG_NAME });
  await profile.locator('[data-tree-row]').first().dblclick();
  await treeRow(source!.name).click();
  await treeRow('public').click();
  await treeRow('Tables').click();
  await expect(treeRow('orders')).toBeVisible();
});

test('transfers two tables from PostgreSQL into MySQL through the wizard', async () => {
  await menu(treeRow('Tables'), 'Transfer data to…');
  const wizard = page.getByRole('dialog', { name: 'Transfer data' });
  await expect(wizard.getByTestId('transfer-objects')).toContainText('orders');

  // Source objects.
  await wizard.getByLabel('Transfer customers').check();
  await wizard.getByLabel('Transfer orders').check();
  await expect(wizard.getByText('2 of 2 tables chosen')).toBeVisible();
  await wizard.getByRole('button', { name: 'Next' }).click();

  // Target connection and database.
  await wizard.getByLabel('Connection').selectOption({ label: `${MY_NAME} · ${MY_LABEL}` });
  await expect(wizard.getByLabel('Database')).toHaveValue(target);
  await wizard.getByRole('button', { name: 'Next' }).click();

  // Options: create the tables, the defaults otherwise.
  await expect(wizard.getByRole('radio', { name: 'Create each table' })).toBeChecked();
  await wizard.getByLabel('Rows per batch').fill('250');
  await wizard.getByRole('button', { name: 'Next' }).click();

  // The planned mapping: MySQL types for each column.
  const mapping = wizard.getByTestId('transfer-mapping');
  await expect(mapping.getByLabel('Target type of total')).toHaveValue('decimal(10,2)');
  await expect(mapping.getByLabel('Target type of placed')).toHaveValue('datetime(6)');
  await expect(mapping.getByLabel('Target type of note')).toHaveValue('longtext');
  await wizard.getByRole('button', { name: 'Next' }).click();

  // The review lists what is created and the DDL.
  const review = wizard.getByTestId('transfer-review');
  await expect(review.getByTestId('transfer-creates')).toContainText('Create table customers');
  await expect(review.getByTestId('transfer-creates')).toContainText('Create table orders');
  await expect(review.getByTestId('transfer-ddl')).toContainText('CREATE TABLE `orders`');
  await expect(review.getByTestId('transfer-ddl')).toContainText('FOREIGN KEY (`customer_id`)');
  await wizard.getByRole('button', { name: 'Transfer', exact: true }).click();
  await expect(wizard).toBeHidden();

  const item = page
    .getByTestId('job-item')
    .filter({ hasText: `Transfer 2 tables from ${PG_NAME} to ${MY_NAME}` });
  await expect(item).toHaveAttribute('data-state', 'completed');
  await expect(item.getByTestId('job-summary')).toContainText(
    `${(ORDERS + 3).toLocaleString('en-US')} rows transferred`,
  );

  const check = await mysql(target);
  try {
    expect(await rows(check, 'SELECT COUNT(*) FROM customers')).toEqual([[3]]);
    expect(await rows(check, 'SELECT COUNT(*), SUM(total), COUNT(note) FROM orders')).toEqual([
      [ORDERS, '125125.00', ORDERS - ORDERS / 10],
    ]);
    expect(await rows(check, 'SELECT name, joined FROM customers ORDER BY id')).toEqual([
      ['Ada', '2024-01-02'],
      ['Grüße 😀', null],
      ['Linus', '1991-08-25'],
    ]);
    expect(await rows(check, 'SELECT placed FROM orders WHERE id = 60')).toEqual([
      ['2024-01-01 01:00:00.000000'],
    ]);
    const fks = await rows(
      check,
      "SELECT REFERENCED_TABLE_NAME FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'orders' AND REFERENCED_TABLE_NAME IS NOT NULL",
    );
    expect(fks).toEqual([['customers']]);
  } finally {
    await check.close();
  }
});
