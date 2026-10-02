import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type Locator, type Page } from '@playwright/test';

import type { LaunchedApp } from '../app';
import { addConnection, capture, connectProfile, DEMO, launchForShots } from './harness';

/**
 * The data-movement and server-tools scenes of the website (docs/website-spec.md §6.4):
 * structure sync and data compare between Larchwood and its drifted staging copy, a transfer
 * into MongoDB, import, export, jobs, backup and restore, schedules, and the PostgreSQL server
 * tools under synthetic load. Nothing is applied to the demo databases: wizards stop before
 * they write, except exports and a backup (which only read), demo roles with grants, and an
 * import into a scratch database that is dropped afterwards. Files go under /tmp/larchwood-files.
 */

test.describe.configure({ mode: 'serial' });

const FILES = '/tmp/larchwood-files';
const LOAD = join(FILES, 'load');
const PG_HOST = 'pg.larchwood.example';
const PG_PORT = '55432';
const SCRATCH_DB = 'larchwood_analytics';
const PASSPHRASE = 'larchwood backup 2026';
const BACKUP_FILE = join(FILES, 'larchwood-2026-10-02.jbak');
const PRICE_LIST = join(FILES, 'products-price-list-2026-autumn.csv');
const PAGE_VIEWS = join(FILES, 'page-views-2026-09.csv');
/** The application names of the synthetic load, stopped in afterAll. */
const LOAD_APPS = ['storefront-api', 'reporting-jobs', 'nightly-report', 'finance-export'];

let launched: LaunchedApp | undefined;
let page: Page;
const background: ChildProcess[] = [];

/** The environment of the PostgreSQL command-line tools, as `user` over TLS. */
function pgEnv(user: string, app?: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PGHOST: PG_HOST,
    PGPORT: PG_PORT,
    PGUSER: user,
    PGPASSWORD: 'demo',
    PGSSLMODE: 'require',
    ...(app ? { PGAPPNAME: app } : {}),
  };
}

/** Runs SQL on the demo PostgreSQL server as the superuser and returns stdout. */
function psql(database: string, sql: string): string {
  return execFileSync('psql', ['-d', database, '-v', 'ON_ERROR_STOP=1', '-Atq'], {
    input: sql,
    encoding: 'utf8',
    env: pgEnv('postgres'),
  });
}

/** Starts a PostgreSQL client in the background as `user`; stopped in afterAll. */
function client(command: string, args: readonly string[], user: string, app: string): void {
  const child = spawn(command, args, { stdio: 'ignore', env: pgEnv(user, app) });
  background.push(child);
}

const ROLES_SQL = `
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'storefront') THEN
    CREATE ROLE storefront LOGIN PASSWORD 'demo' CONNECTION LIMIT 40;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'analyst') THEN
    CREATE ROLE analyst LOGIN PASSWORD 'demo';
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'reporting') THEN
    CREATE ROLE reporting NOLOGIN;
  END IF;
END $$;
GRANT CONNECT ON DATABASE larchwood TO storefront, analyst;
GRANT USAGE ON SCHEMA shop TO storefront, reporting;
GRANT SELECT ON shop.products, shop.inventory, shop.customers, shop.orders, shop.order_items,
  shop.reviews, shop.shipments TO storefront;
GRANT INSERT, UPDATE ON shop.orders, shop.order_items, shop.customers TO storefront;
GRANT INSERT ON shop.reviews TO storefront;
GRANT UPDATE (on_hand, reserved) ON shop.inventory TO storefront;
GRANT SELECT ON ALL TABLES IN SCHEMA shop TO reporting;
GRANT reporting TO analyst;
`;

const STOREFRONT_LOAD = `\\set cid random(1, 1200)
\\set pid random(1001, 1085)
SELECT o.id, o.status, o.placed_at, o.total FROM shop.orders o WHERE o.customer_id = :cid ORDER BY o.placed_at DESC LIMIT 20;
SELECT p.sku, p.name, p.price, i.on_hand - i.reserved AS available FROM shop.products p JOIN shop.inventory i ON i.product_id = p.id WHERE p.id = :pid;
SELECT r.rating, r.body, r.created_at FROM shop.reviews r WHERE r.product_id = :pid ORDER BY r.created_at DESC LIMIT 10;
`;

/** Stock reservations that are always rolled back: rows are written, nothing changes. */
const CHECKOUT_LOAD = `\\set pid random(1001, 1085)
BEGIN;
UPDATE shop.inventory SET reserved = reserved + 1 WHERE product_id = :pid;
ROLLBACK;
`;

const REPORTING_LOAD = `SELECT p.category, date_trunc('week', o.placed_at) AS week, sum(oi.quantity * oi.unit_price) AS revenue FROM shop.order_items oi JOIN shop.orders o ON o.id = oi.order_id JOIN shop.products p ON p.id = oi.product_id WHERE o.status <> 'cancelled' GROUP BY 1, 2 ORDER BY 2 DESC, 3 DESC;
SELECT c.country, count(DISTINCT c.id) AS customers, sum(o.total) AS total FROM shop.customers c JOIN shop.orders o ON o.customer_id = c.id GROUP BY c.country ORDER BY total DESC;
`;

test.beforeAll(async () => {
  mkdirSync(LOAD, { recursive: true });
  psql('larchwood', ROLES_SQL);
  launched = await launchForShots();
  page = launched.page;
  await addConnection(page, DEMO.postgres);
  await addConnection(page, DEMO.postgresStaging);
  await addConnection(page, DEMO.mongodb);
  await connectProfile(page, DEMO.postgres.name);
});

test.afterAll(async () => {
  for (const child of background) child.kill();
  // Closing with a schedule on asks first: answer Quit.
  await launched?.app
    .evaluate(({ dialog }) => {
      dialog.showMessageBox = (() =>
        Promise.resolve({ response: 0, checkboxChecked: false })) as typeof dialog.showMessageBox;
    })
    .catch(() => undefined);
  await launched?.close();
  psql(
    'postgres',
    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
       WHERE application_name IN (${LOAD_APPS.map((app) => `'${app}'`).join(', ')})
          OR datname = '${SCRATCH_DB}'`,
  );
  psql('postgres', `DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`);
});

// ---------------------------------------------------------------------------------------------
// Helpers

function profileItem(name: string): Locator {
  return page.getByRole('treeitem', { name, exact: true });
}

function treeRow(text: string, within: Locator = profileItem(DEMO.postgres.name)): Locator {
  return within
    .locator('[data-tree-row]')
    .filter({ has: page.getByText(text, { exact: true }) })
    .first();
}

/** Opens a tree row's menu at the pointer (ADR 0030) and picks an item. */
async function menu(row: Locator, item: string): Promise<void> {
  await row.click({ button: 'right' });
  await page.getByRole('menuitem', { name: item, exact: true }).click();
}

async function expand(row: Locator, child: string, within?: Locator): Promise<void> {
  // The chevron only expands; a click on the row also opens the object (an Objects tab).
  if (!(await treeRow(child, within).isVisible())) await row.locator('[data-tree-chevron]').click();
  await expect(treeRow(child, within)).toBeVisible();
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

/** Captures the scene with nothing focused (no hover menus or focus rings in the explorer). */
async function shot(id: string, settle?: () => Promise<void>): Promise<void> {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await capture(page, id, settle);
}

function job(title: string): Locator {
  return page.getByTestId('job-item').filter({ hasText: title });
}

async function closeJobs(): Promise<void> {
  const close = page.getByRole('button', { name: 'Close jobs' });
  if (await close.isVisible()) await close.click();
}

function panel(testId: string): Locator {
  return page.getByTestId(testId).filter({ visible: true });
}

/** Closes every dock tab, so each scene starts from a clean tab strip. */
async function closeTabs(): Promise<void> {
  const close = page.locator('.dv-tab [aria-label^="Close "]');
  while ((await close.count()) > 0) {
    await close.first().click();
    await page.waitForTimeout(150);
  }
}

/** Opens the shop tables of larchwood in the explorer. */
async function openShopTables(): Promise<void> {
  await expand(treeRow('larchwood'), 'shop');
  await expand(treeRow('shop'), 'Tables');
  await expand(treeRow('Tables'), 'orders');
}

/** Opens the rows of a shop table in a tab, as the backdrop of a wizard. */
async function openRows(table: string): Promise<void> {
  await closeTabs();
  await openShopTables();
  await treeRow(table).dblclick();
  const view = panel('table-data-panel');
  await expect(view.getByTestId('table-row-count')).toContainText('rows');
}

async function chooseSide(
  view: Locator,
  role: 'Source' | 'Target',
  profile: string,
  database: string,
): Promise<void> {
  await view.getByLabel(`${role} connection`).selectOption({ label: `${profile} · PostgreSQL` });
  await view.getByLabel(`${role} database`).fill(database);
  await view.getByLabel(`${role} schemas`).fill('shop');
}

async function openCompare(item: 'Compare structure…' | 'Compare data…'): Promise<void> {
  await page
    .getByRole('toolbar', { name: 'Window' })
    .getByRole('button', { name: 'Compare' })
    .click();
  await page.getByRole('menuitem', { name: item }).click();
}

// ---------------------------------------------------------------------------------------------
// Structure sync and data compare

test('structure-sync', async () => {
  await openCompare('Compare structure…');
  const view = panel('structure-compare');
  await chooseSide(view, 'Source', DEMO.postgres.name, 'larchwood');
  await chooseSide(view, 'Target', DEMO.postgresStaging.name, 'larchwood_staging');
  await view.getByRole('button', { name: 'Compare', exact: true }).click();
  await expect(view.getByTestId('sync-summary')).toBeVisible({ timeout: 60_000 });
  const ops = view.getByTestId('sync-operation');
  await expect(ops.first()).toBeVisible();
  // Focus an alter of products: both definitions side by side.
  await view.getByRole('button', { name: 'shop.products.price' }).click();
  await expect(view.getByTestId('source-ddl')).toBeVisible();
  await shot('structure-sync');
});

test('data-compare', async () => {
  await closeTabs();
  await openCompare('Compare data…');
  const view = panel('data-compare');
  await chooseSide(view, 'Source', DEMO.postgres.name, 'larchwood');
  await chooseSide(view, 'Target', DEMO.postgresStaging.name, 'larchwood_staging');
  await view.getByRole('button', { name: 'Compare data', exact: true }).click();
  const products = view.getByTestId('data-table-row').filter({ hasText: 'shop.products' });
  await expect(products).toBeVisible({ timeout: 120_000 });
  await products.getByRole('button', { name: 'shop.products' }).click();
  await view.getByRole('tab', { name: /^Updates/ }).click();
  await expect(view.getByTestId('data-row-grid').locator('td[data-changed]').first()).toBeVisible();
  await shot('data-compare');
});

// ---------------------------------------------------------------------------------------------
// Transfer, import, export

test('transfer-mapping', async () => {
  await openRows('orders');
  await menu(treeRow('Tables'), 'Transfer data to…');
  const wizard = page.getByRole('dialog', { name: 'Transfer data' });
  await expect(wizard.getByTestId('transfer-objects')).toContainText('orders');
  await wizard.getByLabel('Transfer orders', { exact: true }).check();
  await wizard.getByLabel('Transfer customers', { exact: true }).check();
  await wizard.getByRole('button', { name: 'Next' }).click();
  await wizard.getByLabel('Connection').selectOption({ label: `${DEMO.mongodb.name} · MongoDB` });
  // A scratch database: the wizard is cancelled before it runs.
  await wizard.getByLabel('Database').fill('larchwood_orders');
  await wizard.getByRole('button', { name: 'Next' }).click();
  const embeds = wizard.getByTestId('transfer-embeds');
  await embeds
    .getByLabel(/^order_items/)
    .first()
    .check();
  await wizard.getByLabel('Field for order_items in orders').fill('items');
  await shot('transfer-embed');
  await wizard.getByRole('button', { name: 'Next' }).click();
  await expect(wizard.getByTestId('transfer-mapping')).toBeVisible({ timeout: 60_000 });
  await shot('transfer-mapping');
  await wizard.getByRole('button', { name: 'Cancel' }).click();
  await expect(wizard).toBeHidden();
});

test('import-preview', async () => {
  await openRows('products');
  await stubDialog('open', PRICE_LIST);
  await menu(treeRow('products'), 'Import data…');
  const wizard = page.getByRole('dialog', { name: 'Import data into shop.products' });
  await wizard.getByRole('button', { name: 'Choose file…' }).click();
  await expect(wizard.getByTestId('import-preview')).toContainText('LW-TAB-OAK-1001');
  await shot('import-preview');
  await wizard.getByRole('button', { name: 'Next' }).click();
  await expect(wizard.getByLabel('Table column for sku')).toHaveValue('sku');
  await shot('import-mapping');
  await wizard.getByRole('button', { name: 'Cancel' }).click();
  await expect(wizard).toBeHidden();
});

test('export', async () => {
  await openRows('orders');
  await menu(treeRow('orders'), 'Export…');
  const wizard = page.getByRole('dialog', { name: 'Export tables of shop' });
  await wizard.getByRole('checkbox', { name: 'order_items' }).check();
  await wizard.getByRole('checkbox', { name: 'customers' }).check();
  await wizard.getByRole('button', { name: 'Next' }).click();
  await wizard.getByLabel('Format').selectOption('parquet');
  await expect(wizard).toContainText('Columnar and typed');
  await wizard.getByLabel('Parquet codec').selectOption('zstd');
  await shot('export');
  await wizard.getByRole('button', { name: 'Cancel' }).click();
  await expect(wizard).toBeHidden();
});

// ---------------------------------------------------------------------------------------------
// Backup and restore, schedules

test('backup', async () => {
  rmSync(BACKUP_FILE, { force: true });
  await openRows('customers');
  await menu(treeRow('larchwood'), 'Back up…');
  const wizard = page.getByRole('dialog', { name: 'Back up' });
  await expect(wizard.getByRole('checkbox', { name: /^Everything/ })).toBeChecked();
  await wizard.getByRole('button', { name: 'Next' }).click();
  await expect(wizard.getByLabel('Format')).toHaveValue('jbak');
  await wizard.getByRole('checkbox', { name: /Encrypt with a passphrase/ }).check();
  await wizard.getByLabel('Passphrase', { exact: true }).fill(PASSPHRASE);
  await wizard.getByLabel('Passphrase again').fill(PASSPHRASE);
  await stubDialog('save', BACKUP_FILE);
  await wizard.getByRole('button', { name: 'Choose file…' }).click();
  await expect(wizard.getByTestId('backup-path')).toHaveText(BACKUP_FILE);
  await shot('backup');
  await wizard.getByRole('button', { name: 'Back up', exact: true }).click();
  await expect(wizard.getByTestId('backup-state')).toHaveText('Completed', { timeout: 120_000 });
  await wizard.getByRole('button', { name: 'Close' }).click();
  await closeJobs();
});

test('restore', async () => {
  await stubDialog('open', BACKUP_FILE);
  await menu(treeRow('larchwood_staging'), 'Restore…');
  const wizard = page.getByRole('dialog', { name: 'Restore' });
  await wizard.getByRole('button', { name: 'Choose backup file…' }).click();
  await wizard.getByLabel('Backup passphrase').fill(PASSPHRASE);
  await wizard.getByRole('button', { name: 'Unlock' }).click();
  await expect(wizard.getByTestId('backup-inspection')).toContainText('encrypted');
  await wizard.getByRole('button', { name: 'Next' }).click();
  await wizard.getByRole('checkbox', { name: /^Everything/ }).uncheck();
  for (const table of ['products', 'orders', 'order_items']) {
    await wizard.getByRole('checkbox', { name: new RegExp(`^shop\\.${table}\\b`) }).check();
  }
  await shot('restore-objects');
  await wizard.getByRole('button', { name: 'Next' }).click();
  await wizard.getByRole('radio', { name: 'An existing database' }).check();
  await wizard.getByRole('button', { name: 'Review' }).click();
  await expect(wizard.getByTestId('restore-conflicts')).toBeVisible({ timeout: 60_000 });
  await shot('restore');
  await wizard.getByRole('button', { name: 'Cancel' }).click();
  await expect(wizard).toBeHidden();
});

test('schedules', async () => {
  const reports = join(FILES, 'reports');
  const backups = join(FILES, 'backups');
  mkdirSync(reports, { recursive: true });
  mkdirSync(backups, { recursive: true });

  // A nightly encrypted backup, set up from the Back up wizard. Saving it needs the OS secret
  // store for the passphrase, which a headless display has not got: the editor is captured and
  // cancelled.
  await menu(treeRow('larchwood'), 'Back up…');
  let wizard = page.getByRole('dialog', { name: 'Back up' });
  await wizard.getByRole('button', { name: 'Next' }).click();
  await wizard.getByRole('checkbox', { name: /Encrypt with a passphrase/ }).check();
  await wizard.getByLabel('Passphrase', { exact: true }).fill(PASSPHRASE);
  await wizard.getByLabel('Passphrase again').fill(PASSPHRASE);
  await wizard.getByRole('button', { name: 'Schedule…' }).click();
  const editor = page.getByTestId('schedule-editor');
  await expect(editor).toBeVisible();
  await editor.getByLabel('Schedule name').fill('Nightly backup of larchwood');
  await stubDialog('open', backups);
  await editor.getByRole('button', { name: 'Choose folder…' }).click();
  await expect(editor.getByTestId('schedule-folder')).toHaveText(backups);
  await shot('schedule-editor');
  await page
    .getByRole('dialog', { name: 'Schedule' })
    .getByRole('button', { name: 'Cancel' })
    .click();
  await expect(editor).toBeHidden();
  if (await wizard.isVisible()) {
    await wizard.getByRole('button', { name: 'Cancel' }).click();
  }

  // A weekly backup without a passphrase.
  await menu(treeRow('larchwood'), 'Back up…');
  wizard = page.getByRole('dialog', { name: 'Back up' });
  await wizard.getByRole('button', { name: 'Next' }).click();
  await wizard.getByRole('button', { name: 'Schedule…' }).click();
  await expect(editor).toBeVisible();
  await editor.getByLabel('Schedule name').fill('Weekly backup of larchwood');
  // Every day is the default: leave Sunday alone.
  for (const day of ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']) {
    await editor.getByRole('button', { name: day, exact: true }).click();
  }
  await expect(editor.getByTestId('rule-summary')).toContainText('Sun');
  await stubDialog('open', backups);
  await editor.getByRole('button', { name: 'Choose folder…' }).click();
  await page.getByTestId('schedule-save').click();
  await expect(editor).toBeHidden();

  // A monthly Parquet export of the orders for the analysts.
  await openRows('orders');
  await menu(treeRow('orders'), 'Export…');
  const exporter = page.getByRole('dialog', { name: 'Export tables of shop' });
  await exporter.getByRole('checkbox', { name: 'order_items' }).check();
  await exporter.getByRole('button', { name: 'Next' }).click();
  await exporter.getByLabel('Format').selectOption('parquet');
  await exporter.getByRole('button', { name: 'Next' }).click();
  await exporter.getByRole('button', { name: 'Schedule…' }).click();
  await expect(editor).toBeVisible();
  await editor.getByLabel('Schedule name').fill('Orders for the warehouse');
  await editor.getByRole('radio', { name: 'Monthly' }).click();
  await stubDialog('open', join(FILES, 'exports'));
  await editor.getByRole('button', { name: 'Choose folder…' }).click();
  await page.getByTestId('schedule-save').click();
  await expect(editor).toBeHidden();

  // A saved structure comparison, run every weekday morning.
  await closeTabs();
  await openCompare('Compare structure…');
  const view = panel('structure-compare');
  await chooseSide(view, 'Source', DEMO.postgres.name, 'larchwood');
  await chooseSide(view, 'Target', DEMO.postgresStaging.name, 'larchwood_staging');
  await view.getByRole('button', { name: 'Compare', exact: true }).click();
  await expect(view.getByTestId('sync-summary')).toBeVisible({ timeout: 60_000 });
  await view.getByRole('button', { name: 'Save comparison…' }).click();
  await view.getByLabel('Comparison name').fill('Staging drift check');
  await view.getByRole('button', { name: 'Save', exact: true }).click();
  await page
    .getByRole('toolbar', { name: 'Window' })
    .getByRole('button', { name: 'Compare' })
    .click();
  await page.getByRole('menuitem', { name: 'Saved comparisons…' }).click();
  const saved = page.getByRole('dialog', { name: 'Saved comparisons' });
  await saved
    .getByTestId('saved-comparison')
    .filter({ hasText: 'Staging drift check' })
    .getByRole('button', { name: 'Schedule…' })
    .click();
  await expect(editor).toBeVisible();
  await editor.getByRole('button', { name: 'weekdays' }).click();
  await stubDialog('open', reports);
  await editor.getByRole('button', { name: 'Choose folder…' }).click();
  await page.getByTestId('schedule-save').click();
  await expect(editor).toBeHidden();
  // Only the connection stays open in the explorer.
  await treeRow('larchwood').locator('[data-tree-chevron]').click();
  await expect(treeRow('shop')).toBeHidden();
  await closeTabs();

  await page
    .getByRole('toolbar', { name: 'Window' })
    .getByRole('button', { name: 'Schedules' })
    .click();
  const schedules = panel('schedules-panel');
  await expect(schedules).toBeVisible();
  await schedules
    .locator('[data-testid="schedule-row"][data-schedule="Staging drift check"]')
    .click();
  const details = schedules.getByTestId('schedule-details');
  for (let run = 1; run <= 2; run++) {
    await details.getByTestId('schedule-run-now').click();
    await expect(details.getByTestId('schedule-run')).toHaveCount(run, { timeout: 60_000 });
    await expect(details.getByTestId('schedule-run').first()).toHaveAttribute(
      'data-status',
      'success',
      { timeout: 120_000 },
    );
  }
  await shot('schedules');
});

// ---------------------------------------------------------------------------------------------
// Server tools

async function openServerTools(profile: string): Promise<Locator> {
  await menu(profileItem(profile).locator('[data-tree-row]').first(), 'Server tools');
  const tools = panel('server-tools-panel');
  await expect(tools).toBeVisible();
  return tools;
}

function startLoad(): void {
  psql('larchwood', 'SELECT pg_stat_statements_reset()');
  const script = (name: string, text: string): string => {
    const path = join(LOAD, name);
    writeFileSync(path, text);
    return path;
  };
  const storefront = script('storefront.sql', STOREFRONT_LOAD);
  const checkout = script('checkout.sql', CHECKOUT_LOAD);
  const reporting = script('reporting.sql', REPORTING_LOAD);
  const bench = (path: string, clients: number, rate: number): string[] => [
    '-n',
    '-c',
    String(clients),
    '-R',
    String(rate),
    '-T',
    '300',
    '-f',
    path,
    'larchwood',
  ];
  client('pgbench', bench(storefront, 6, 60), 'storefront', 'storefront-api');
  client('pgbench', bench(checkout, 2, 25), 'storefront', 'storefront-api');
  client('pgbench', bench(reporting, 2, 2), 'analyst', 'reporting-jobs');
}

async function startSessions(): Promise<void> {
  const run = (user: string, app: string, sql: string): void =>
    client('psql', ['-d', 'larchwood', '-c', sql], user, app);
  run(
    'analyst',
    'nightly-report',
    `SELECT c.country, p.category, sum(oi.quantity * oi.unit_price) AS revenue, pg_sleep(300) FROM shop.order_items oi JOIN shop.orders o ON o.id = oi.order_id JOIN shop.customers c ON c.id = o.customer_id JOIN shop.products p ON p.id = oi.product_id GROUP BY 1, 2`,
  );
  run(
    'analyst',
    'finance-export',
    `SELECT o.id, o.placed_at, o.total, pg_sleep(300) FROM shop.orders o WHERE o.placed_at >= date '2026-09-01' LIMIT 1`,
  );
  // A row lock held by a long transaction (rolled back: nothing changes).
  run(
    'storefront',
    'storefront-api',
    `BEGIN; SELECT * FROM shop.inventory WHERE product_id = 1086 FOR UPDATE; SELECT pg_sleep(300); ROLLBACK;`,
  );
  await page.waitForTimeout(1000);
}

/** A session waiting for the row lock above (rolled back once it gets it). */
function startWaiter(): void {
  client(
    'psql',
    [
      '-d',
      'larchwood',
      '-c',
      'BEGIN; UPDATE shop.inventory SET reserved = reserved + 1 WHERE product_id = 1086; ROLLBACK;',
    ],
    'storefront',
    'storefront-api',
  );
}

test('server-monitor', async () => {
  await closeTabs();
  startLoad();
  await startSessions();
  const tools = await openServerTools(DEMO.postgres.name);
  await expect(tools.getByTestId('stat-Connections')).toHaveText(/^\d+$/);
  await page.waitForTimeout(65_000);
  await shot('server-monitor');
});

test('sessions', async () => {
  const tools = panel('server-tools-panel');
  startWaiter();
  await page.waitForTimeout(1500);
  await tools.getByRole('tab', { name: 'Sessions' }).click();
  const tab = tools.getByTestId('server-sessions');
  const row = tab.getByTestId('session-row').filter({ hasText: 'nightly-report' });
  await expect(async () => {
    await tab.getByRole('button', { name: 'Refresh' }).click();
    await expect(row.first()).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 20_000 });
  await row.first().click();
  await expect(tab.getByTestId('session-details')).toContainText('pg_sleep');
  await shot('sessions');
});

test('top-queries', async () => {
  const tools = panel('server-tools-panel');
  await tools.getByRole('tab', { name: 'Top queries' }).click();
  const tab = tools.getByTestId('server-top-queries');
  const rows = tab.getByTestId('top-query-row');
  await expect(rows.first()).toBeVisible();
  await rows.first().click();
  await shot('top-queries');
});

test('grants', async () => {
  const tools = panel('server-tools-panel');
  await tools.getByRole('tab', { name: 'Users' }).click();
  const tab = tools.getByTestId('server-users');
  await tab.getByTestId('account-list').getByText('storefront', { exact: true }).click();
  const grants = tab.getByTestId('grants-matrix');
  await expect(grants).toBeVisible();
  await grants.getByLabel('Schema', { exact: true }).selectOption('shop');
  await expect(grants).toContainText('orders');
  await shot('grants');
});

test('top-queries-fix', async () => {
  // larchwood_staging has no pg_stat_statements extension: the tab says why and offers the fix,
  // which is not run.
  await closeTabs();
  // By its exact name: "Staging" is also part of a database's name (larchwood_staging).
  const staging = profileItem(DEMO.postgresStaging.name);
  await staging.locator('[data-tree-row]').first().dblclick();
  await expect(staging.getByText('Connected', { exact: true }).first()).toBeAttached({
    timeout: 30_000,
  });
  const tools = await openServerTools(DEMO.postgresStaging.name);
  await tools.getByRole('tab', { name: 'Top queries' }).click();
  const tab = tools.getByTestId('server-top-queries');
  await expect(tab.getByTestId('top-queries-unavailable')).toContainText('larchwood_staging');
  // Only the Larchwood connection stays expanded in the explorer.
  await staging.locator('[data-tree-row]').first().locator('[data-tree-chevron]').click();
  await expect(treeRow('postgres', staging)).toBeHidden();
  await shot('top-queries-fix');
  await closeTabs();
});

// ---------------------------------------------------------------------------------------------
// Jobs (last: it adds a connection to a scratch database)

test('jobs', async () => {
  expect(existsSync(PAGE_VIEWS)).toBe(true);
  psql('postgres', `DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`);
  psql('postgres', `CREATE DATABASE ${SCRATCH_DB}`);
  psql(
    SCRATCH_DB,
    `CREATE SCHEMA web;
     CREATE TABLE web.page_views (id bigint PRIMARY KEY, viewed_at timestamptz NOT NULL,
       session_id text NOT NULL, path text NOT NULL, product_id integer, referrer text,
       country char(2), device text)`,
  );
  await openRows('orders');
  // A fresh job list: a small export that finishes, then the large import that runs.
  await page.getByRole('button', { name: 'Jobs' }).click();
  const clear = page.getByRole('button', { name: 'Clear finished' });
  if (await clear.isEnabled()) await clear.click();
  await closeJobs();
  const xlsx = join(FILES, 'orders-2026-09.xlsx');
  rmSync(xlsx, { force: true });
  await stubDialog('save', xlsx);
  await menu(treeRow('orders'), 'Export…');
  const exporter = page.getByRole('dialog', { name: 'Export tables of shop' });
  await exporter.getByRole('button', { name: 'Next' }).click();
  await exporter.getByLabel('Format').selectOption('xlsx');
  await exporter.getByRole('button', { name: 'Next' }).click();
  await exporter.getByRole('button', { name: 'Choose file…' }).click();
  await exporter.getByRole('button', { name: 'Export', exact: true }).click();
  await expect(exporter).toBeHidden();
  await expect(job('Export orders to XLSX')).toHaveAttribute('data-state', 'completed');
  await closeJobs();
  const parquet = join(FILES, 'exports', 'customers.parquet');
  rmSync(parquet, { force: true });
  await stubDialog('save', parquet);
  await menu(treeRow('customers'), 'Export…');
  await exporter.getByRole('button', { name: 'Next' }).click();
  await exporter.getByLabel('Format').selectOption('parquet');
  await exporter.getByRole('button', { name: 'Next' }).click();
  await exporter.getByRole('button', { name: 'Choose file…' }).click();
  await exporter.getByRole('button', { name: 'Export', exact: true }).click();
  await expect(exporter).toBeHidden();
  await expect(job('Export customers to Parquet')).toHaveAttribute('data-state', 'completed');
  await closeJobs();

  const analytics = {
    name: 'Analytics',
    uri: `postgres://postgres:demo@${PG_HOST}:${PG_PORT}/${SCRATCH_DB}`,
    environment: 'dev',
  } as const;
  await addConnection(page, analytics);
  await connectProfile(page, analytics.name);
  const item = profileItem(analytics.name);
  await expand(treeRow(SCRATCH_DB, item), 'web', item);
  await expand(treeRow('web', item), 'Tables', item);
  await expand(treeRow('Tables', item), 'page_views', item);
  await stubDialog('open', PAGE_VIEWS);
  await menu(treeRow('page_views', item), 'Import data…');
  const wizard = page.getByRole('dialog', { name: 'Import data into web.page_views' });
  await wizard.getByRole('button', { name: 'Choose file…' }).click();
  await expect(wizard.getByTestId('import-preview')).toBeVisible();
  for (let i = 0; i < 3; i++) await wizard.getByRole('button', { name: 'Next' }).click();
  await wizard.getByRole('button', { name: 'Import', exact: true }).click();
  await expect(wizard).toBeHidden();
  // Only the source connection stays expanded in the explorer, the orders in front.
  await item.locator('[data-tree-row]').first().locator('[data-tree-chevron]').click();
  await expect(treeRow(SCRATCH_DB, item)).toBeHidden();
  const objects = page.locator('.dv-tab [aria-label="Close Objects"]');
  if ((await objects.count()) > 0) await objects.first().click();
  await page.locator('.dv-tab').filter({ hasText: 'orders' }).click();

  const jobs = page.getByTestId('jobs-panel');
  if (!(await jobs.isVisible())) await page.getByRole('button', { name: 'Jobs' }).click();
  const running = job('page-views-2026-09.csv');
  await expect(running).toHaveAttribute('data-state', 'running');
  await expect(running.getByRole('progressbar')).toHaveAttribute('aria-valuenow', /^[3-9]\d$/, {
    timeout: 120_000,
  });
  await shot('jobs', () => page.waitForTimeout(300));
  await running.getByRole('button', { name: 'Cancel' }).click();
  await expect(running).not.toHaveAttribute('data-state', 'running', { timeout: 60_000 });
});
