import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Session } from '@joinery/core';
import { expect, test, type Locator, type Page } from '@playwright/test';

import { launchApp, type LaunchedApp } from './app';
import { connect, query, scratchDatabase } from './db';

/**
 * Backup and restore through the wizards against a real PostgreSQL server (spec §14): a
 * database backed up to an encrypted Joinery archive, then two of its tables restored from it
 * into a new database the restore creates, and the rows checked there. Native file dialogs are
 * stubbed in the main process to answer with files in a temporary folder.
 */

const PG_URL = process.env['JOINERY_TEST_POSTGRES_URL'];
const NAME = 'E2E Backup';
const PASSPHRASE = 'e2e backup passphrase';
const RESTORED = `joinery_e2e_${randomBytes(4).toString('hex')}_restored`;

test.skip(!PG_URL, 'Set JOINERY_TEST_POSTGRES_URL to run the end-to-end tests');

test.describe.configure({ mode: 'serial' });

let launched: LaunchedApp | undefined;
let page: Page;
let database: Awaited<ReturnType<typeof scratchDatabase>> | undefined;
let direct: Session | undefined;
let work = '';

test.beforeAll(async () => {
  work = mkdtempSync(join(tmpdir(), 'joinery-e2e-backup-'));
  database = await scratchDatabase(PG_URL!);
  direct = await connect(PG_URL!, database.name);
  for (const sql of [
    'CREATE TABLE customers (id integer PRIMARY KEY, name text NOT NULL, since date)',
    'CREATE TABLE orders (id integer PRIMARY KEY, customer_id integer NOT NULL REFERENCES customers (id), total numeric(10,2))',
    'CREATE TABLE notes (id integer PRIMARY KEY, body text)',
    "INSERT INTO customers VALUES (1, 'Ada Lovelace', '2024-01-02'), (2, 'Grace Hopper', NULL), (3, 'Zoë', '2025-12-31')",
    'INSERT INTO orders VALUES (10, 1, 12.50), (11, 3, 7.00)',
    "INSERT INTO notes VALUES (1, 'not restored')",
  ]) {
    await query(direct, sql);
  }
  launched = await launchApp();
  page = launched.page;
});

test.afterAll(async () => {
  await launched?.close();
  await direct?.close();
  await database?.drop();
  if (PG_URL) {
    const admin = await connect(PG_URL);
    try {
      await query(admin, `DROP DATABASE IF EXISTS ${RESTORED} WITH (FORCE)`);
    } finally {
      await admin.close();
    }
  }
  if (work) rmSync(work, { recursive: true, force: true });
});

function treeRow(text: string): Locator {
  return page.locator('[data-tree-row]').filter({ has: page.getByText(text, { exact: true }) });
}

async function menu(row: Locator, item: string): Promise<void> {
  await row.hover();
  await row.getByRole('button', { name: 'Actions' }).click();
  await page.getByRole('menuitem', { name: item }).click();
}

/** The next native open or save dialog answers with `path`. */
async function stubDialog(kind: 'open' | 'save', path: string): Promise<void> {
  await launched!.app.evaluate(
    ({ dialog }, [which, file]) => {
      if (which === 'open') {
        dialog.showOpenDialog = (() =>
          Promise.resolve({ canceled: false, filePaths: [file] })) as typeof dialog.showOpenDialog;
      } else {
        dialog.showSaveDialog = (() =>
          Promise.resolve({ canceled: false, filePath: file })) as typeof dialog.showSaveDialog;
      }
    },
    [kind, path] as const,
  );
}

test('connects and shows the database', async () => {
  await page.getByRole('button', { name: 'New connection' }).click();
  const dialog = page.getByRole('dialog', { name: 'New connection' });
  await dialog.getByLabel('Paste a URI to fill the form').fill(database!.url);
  await dialog.getByRole('button', { name: 'Fill from URI' }).click();
  await expect(dialog.getByText('Filled from the URI')).toBeVisible();
  await dialog.getByLabel('Name').fill(NAME);
  await dialog.getByLabel('TLS').selectOption('disable');
  await dialog.getByLabel('Password storage').selectOption('session');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog).toBeHidden();

  const profile = page.getByRole('treeitem', { name: NAME });
  await profile.locator('[data-tree-row]').first().click();
  await expect(treeRow(database!.name)).toBeVisible();
});

test('backs up the database to an encrypted archive', async () => {
  const file = join(work, 'shop.jbak');
  await menu(treeRow(database!.name), 'Back up…');
  const wizard = page.getByRole('dialog', { name: 'Back up' });
  await expect(wizard.getByTestId('backup-object')).toHaveText(['customers', 'notes', 'orders']);
  await expect(wizard.getByRole('checkbox', { name: /^Everything/ })).toBeChecked();
  await wizard.getByRole('button', { name: 'Next' }).click();

  await expect(wizard.getByLabel('Format')).toHaveValue('jbak');
  await wizard.getByRole('checkbox', { name: /Encrypt with a passphrase/ }).check();
  await wizard.getByLabel('Passphrase', { exact: true }).fill(PASSPHRASE);
  await wizard.getByLabel('Passphrase again').fill(`${PASSPHRASE}?`);
  await expect(wizard.getByText('The passphrases do not match.')).toBeVisible();
  await wizard.getByLabel('Passphrase again').fill(PASSPHRASE);
  await stubDialog('save', file);
  await wizard.getByRole('button', { name: 'Choose file…' }).click();
  await expect(wizard.getByTestId('backup-path')).toHaveText(file);
  await wizard.getByRole('button', { name: 'Back up', exact: true }).click();

  await expect(wizard.getByTestId('backup-state')).toHaveText('Completed');
  await expect(wizard.getByTestId('backup-summary')).toContainText('6 rows');
  await expect(wizard.getByTestId('backup-history')).toContainText('shop.jbak');
  await wizard.getByRole('button', { name: 'Close' }).click();

  expect(existsSync(file)).toBe(true);
  const bytes = readFileSync(file);
  expect(bytes.subarray(0, 4).toString('latin1')).toBe('JBAK');
  // Encrypted: neither the rows nor the object names are readable in the file.
  expect(bytes.includes(Buffer.from('Ada Lovelace'))).toBe(false);
  expect(bytes.includes(Buffer.from('customers'))).toBe(false);
  expect(bytes.includes(Buffer.from(PASSPHRASE))).toBe(false);
});

test('restores two tables from it into a new database', async () => {
  await stubDialog('open', join(work, 'shop.jbak'));
  await menu(treeRow(database!.name), 'Restore…');
  const wizard = page.getByRole('dialog', { name: 'Restore' });
  await wizard.getByRole('button', { name: 'Choose backup file…' }).click();

  // Encrypted: nothing is listed until the passphrase unlocks the manifest.
  await expect(wizard.getByRole('button', { name: 'Next' })).toBeDisabled();
  await wizard.getByLabel('Backup passphrase').fill('not the passphrase');
  await wizard.getByRole('button', { name: 'Unlock' }).click();
  await expect(wizard.getByRole('alert').filter({ hasText: /passphrase is wrong/ })).toBeVisible();
  await wizard.getByLabel('Backup passphrase').fill(PASSPHRASE);
  await wizard.getByRole('button', { name: 'Unlock' }).click();
  await expect(wizard.getByTestId('backup-inspection')).toContainText('encrypted');
  await expect(wizard.getByTestId('backup-inspection')).toContainText(database!.name);
  await wizard.getByRole('button', { name: 'Next' }).click();

  await wizard.getByRole('checkbox', { name: /^Everything/ }).uncheck();
  await expect(wizard.getByRole('button', { name: 'Next' })).toBeDisabled();
  await wizard.getByRole('checkbox', { name: /public\.customers/ }).check();
  await wizard.getByRole('checkbox', { name: /public\.orders/ }).check();
  await wizard.getByRole('button', { name: 'Next' }).click();

  await wizard.getByRole('radio', { name: 'A new database' }).check();
  await wizard.getByLabel('New database name').fill(RESTORED);
  await wizard.getByRole('button', { name: 'Review' }).click();

  const review = wizard.getByTestId('restore-review');
  await expect(review).toContainText('Nothing that exists is dropped or overwritten.');
  await wizard.getByRole('button', { name: 'Restore', exact: true }).click();
  await expect(wizard.getByTestId('backup-state')).toHaveText('Completed');
  await expect(wizard.getByTestId('backup-summary')).toContainText('5 rows');
  await wizard.getByRole('button', { name: 'Close' }).click();

  const restored = await connect(PG_URL!, RESTORED);
  try {
    expect(
      await query(restored, 'SELECT id, name, since::text FROM customers ORDER BY id'),
    ).toEqual([
      [1, 'Ada Lovelace', '2024-01-02'],
      [2, 'Grace Hopper', null],
      [3, 'Zoë', '2025-12-31'],
    ]);
    expect(
      await query(restored, 'SELECT id, customer_id, total::text FROM orders ORDER BY id'),
    ).toEqual([
      [10, 1, '12.50'],
      [11, 3, '7.00'],
    ]);
    // The foreign key came along with both of its tables; the unselected table did not.
    expect(
      await query(
        restored,
        "SELECT count(*)::int FROM information_schema.table_constraints WHERE constraint_type = 'FOREIGN KEY' AND table_name = 'orders'",
      ),
    ).toEqual([[1]]);
    expect(await query(restored, "SELECT to_regclass('public.notes')::text")).toEqual([[null]]);
  } finally {
    await restored.close();
  }
  // The explorer lists the new database.
  await expect(treeRow(RESTORED)).toBeVisible();
});
